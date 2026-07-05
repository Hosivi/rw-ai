import type { AgentKind, AgentsConfig, Claim, Session } from '../contract/schema.js';
import { assertNever } from '../core/assert.js';
import { bootstrapRepo } from '../engine/bootstrap.js';
import type { RunbookResult } from '../engine/configure.js';
import type { CommandRunner } from '../engine/exec.js';
import { createGit, type GitError } from '../engine/git.js';
import {
  claimRole,
  generateClaimToken,
  listRoles,
  releaseRole,
  whoami,
  type RoleStatus,
} from '../engine/identity.js';
import {
  analyzeIntegration,
  classifyChangedFile,
  integrationSummaryLine,
  writeIntegrationReport,
  type FileClass,
  type IntegrationAnalysis,
} from '../engine/integrator.js';
import { finishSession, type FinishResult } from '../engine/lifecycle.js';
import type { McpContext } from './context.js';

// The impure inputs each handler needs, injected so the handlers stay pure of
// process/clock/crypto: `now` drives every claim/expiry decision, `run`/`runRaw`
// let git be stubbed, and `token` is the caller's identity (server memory or env).
export type ToolDeps = {
  readonly now: Date;
  readonly run?: CommandRunner;
  readonly runRaw?: CommandRunner;
  readonly token?: string;
};

// A discriminated envelope so the server can surface engine failures as tool
// errors without inspecting each handler's shape: `ok: true` carries the payload
// fields inline, `ok: false` carries a flattened {kind, message}.
export type ToolFailure = {
  readonly ok: false;
  readonly error: { readonly kind: string; readonly message: string };
};
export type ToolOk<T> = { readonly ok: true } & T;
export type ToolResult<T> = ToolOk<T> | ToolFailure;

// The current-session facts a caller cares about, without leaking ports/db.
export type SessionSummary = {
  readonly id: string;
  readonly branch: string;
  readonly worktree: string;
  readonly areas: readonly string[];
};

const fail = (kind: string, message: string): ToolFailure => ({ ok: false, error: { kind, message } });

// Engine errors already expose {kind, message}; flatten them uniformly.
const failFrom = (error: { readonly kind: string; readonly message: string }): ToolFailure =>
  fail(error.kind, error.message);

// A GitError has no uniform `message` field (non-zero-exit carries an output
// instead), so render one before flattening it into the tool envelope.
const describeGitError = (error: GitError): string => {
  switch (error.kind) {
    case 'spawn-failed':
    case 'parse-failed':
      return error.message;
    case 'non-zero-exit':
      return `git salió con código ${error.output.exitCode}: ${error.output.stderr.trim()}`;
    default:
      return assertNever(error);
  }
};

const summarizeSession = (session: Session): SessionSummary => ({
  id: session.id,
  branch: session.branch,
  worktree: session.worktree,
  areas: session.areas,
});

// A blocking pre-merge state: any file a session wrote outside its lane, or any
// simulated merge conflict. Shared-zone touches and plain overlaps are
// informational. Mirrors cli/commands/check.ts's gate, inlined to avoid a
// dependency from the MCP layer onto the CLI layer.
const isBlocking = (analysis: IntegrationAnalysis): boolean =>
  analysis.invasions.length > 0 ||
  analysis.simulatedMerges.some((merge) => merge.status === 'conflict');

// --- Handlers ---------------------------------------------------------------

export type StatusResult = {
  readonly sharedRoot: string;
  readonly currentSession: SessionSummary | null;
  readonly roles: readonly RoleStatus[];
};

export const handleStatus = async (
  ctx: McpContext,
  deps: ToolDeps,
): Promise<ToolResult<StatusResult>> => {
  const roles = await listRoles({ config: ctx.config, boardDir: ctx.boardDir, now: deps.now });
  if (!roles.ok) {
    return failFrom(roles.error);
  }
  return {
    ok: true,
    sharedRoot: ctx.sharedRoot,
    currentSession: ctx.currentSession === undefined ? null : summarizeSession(ctx.currentSession),
    roles: roles.value,
  };
};

export const handleRoles = async (
  ctx: McpContext,
  deps: ToolDeps,
): Promise<ToolResult<{ readonly roles: readonly RoleStatus[] }>> => {
  const roles = await listRoles({ config: ctx.config, boardDir: ctx.boardDir, now: deps.now });
  return roles.ok ? { ok: true, roles: roles.value } : failFrom(roles.error);
};

export type WhoamiResult =
  | { readonly role: null; readonly reason: 'no-token' | 'no-active-role' }
  | { readonly role: string; readonly claim: Claim };

export const handleWhoami = async (
  ctx: McpContext,
  deps: ToolDeps,
): Promise<ToolResult<WhoamiResult>> => {
  // No token means no identity to resolve — a normal state, not an error.
  if (deps.token === undefined || deps.token === '') {
    return { ok: true, role: null, reason: 'no-token' };
  }
  const who = await whoami({
    config: ctx.config,
    boardDir: ctx.boardDir,
    token: deps.token,
    now: deps.now,
  });
  if (!who.ok) {
    return failFrom(who.error);
  }
  if (who.value === null) {
    return { ok: true, role: null, reason: 'no-active-role' };
  }
  return { ok: true, role: who.value.role, claim: who.value.claim };
};

export type ClaimArgs = {
  readonly role?: string;
  readonly agent?: AgentKind;
  readonly ttlHours?: number;
};

export type ClaimResultShape = {
  readonly role: string;
  readonly token: string;
  readonly claim: Claim;
};

const HOUR_MS = 3_600_000;
const DEFAULT_TTL_HOURS = 8;

export const handleClaim = async (
  ctx: McpContext,
  args: ClaimArgs,
  deps: ToolDeps,
): Promise<ToolResult<ClaimResultShape>> => {
  // Default to the current session's role so an agent inside a worktree can claim
  // with no arguments; refuse only when neither an arg nor a session is present.
  const role = args.role ?? ctx.currentSession?.id;
  if (role === undefined) {
    return fail(
      'no-role',
      'No indicaste un rol y el cwd no está dentro de una sesión. Pasa "role" (por ejemplo s1 o integrator).',
    );
  }
  const token = generateClaimToken();
  const ttlMs = (args.ttlHours ?? DEFAULT_TTL_HOURS) * HOUR_MS;
  const claimed = await claimRole({
    config: ctx.config,
    boardDir: ctx.boardDir,
    role,
    token,
    ...(args.agent !== undefined ? { agent: args.agent } : {}),
    now: deps.now,
    ttlMs,
  });
  if (!claimed.ok) {
    return failFrom(claimed.error);
  }
  return { ok: true, role, token, claim: claimed.value.claim };
};

export type ReleaseArgs = { readonly role?: string };

export type ReleaseResultShape = {
  readonly role: string;
  readonly released: boolean;
  readonly reason?: 'already-free';
};

export const handleRelease = async (
  ctx: McpContext,
  args: ReleaseArgs,
  deps: ToolDeps,
): Promise<ToolResult<ReleaseResultShape>> => {
  const role = args.role ?? ctx.currentSession?.id;
  if (role === undefined) {
    return fail(
      'no-role',
      'No indicaste un rol y el cwd no está dentro de una sesión. Pasa "role" para liberar.',
    );
  }
  // Releasing checks the caller's token against the current holder; without one
  // there is nothing to prove ownership with.
  if (deps.token === undefined || deps.token === '') {
    return fail('no-token', 'No hay token en memoria ni en RW_TOKEN, no hay cómo liberar el rol.');
  }
  const released = await releaseRole({
    config: ctx.config,
    boardDir: ctx.boardDir,
    role,
    token: deps.token,
    now: deps.now,
  });
  if (!released.ok) {
    return failFrom(released.error);
  }
  return {
    ok: true,
    role: released.value.role,
    released: released.value.released,
    ...(released.value.reason !== undefined ? { reason: released.value.reason } : {}),
  };
};

export type CheckResult = {
  readonly blocking: boolean;
  readonly summary: string;
  readonly analysis: IntegrationAnalysis;
  readonly reportPath?: string;
  readonly warning?: string;
};

export const handleCheck = async (
  ctx: McpContext,
  deps: ToolDeps,
): Promise<ToolResult<CheckResult>> => {
  const analysis = await analyzeIntegration(ctx.config, ctx.sharedRoot, deps.run, deps.runRaw);
  if (!analysis.ok) {
    return failFrom(analysis.error);
  }
  // A failed report write must not hide the analysis the caller asked for:
  // surface it as a warning and still return the (authoritative) blocking flag.
  const written = await writeIntegrationReport(ctx.config, ctx.sharedRoot, analysis.value, deps.now);
  return {
    ok: true,
    blocking: isBlocking(analysis.value),
    summary: integrationSummaryLine(analysis.value),
    analysis: analysis.value,
    ...(written.ok ? { reportPath: written.value.path } : { warning: written.error.message }),
  };
};

export type FinishArgs = { readonly newBranch?: string };

export const handleFinish = async (
  ctx: McpContext,
  args: FinishArgs,
  deps: ToolDeps,
): Promise<ToolResult<FinishResult>> => {
  // Finish rotates the CURRENT session; there is nothing to finish from the main
  // root, so require a resolved session.
  if (ctx.currentSession === undefined) {
    return fail(
      'no-session',
      'El cwd no está dentro de una sesión, no hay sesión que integrar. Ejecuta esto desde un worktree de sesión.',
    );
  }
  const finished = await finishSession({
    config: ctx.config,
    projectRoot: ctx.sharedRoot,
    sessionId: ctx.currentSession.id,
    ...(args.newBranch !== undefined ? { newBranch: args.newBranch } : {}),
    ...(deps.run !== undefined ? { run: deps.run } : {}),
    ...(deps.runRaw !== undefined ? { runRaw: deps.runRaw } : {}),
  });
  return finished.ok ? { ok: true, ...finished.value } : failFrom(finished.error);
};

export type LaneCheckArgs = { readonly path: string };

export type LaneCheckResult = {
  readonly path: string;
  readonly class: FileClass;
  readonly allowed: boolean;
  readonly session: string;
};

export const handleLaneCheck = (
  ctx: McpContext,
  args: LaneCheckArgs,
): ToolResult<LaneCheckResult> => {
  if (ctx.currentSession === undefined) {
    return fail(
      'no-session',
      'El cwd no está dentro de una sesión, no hay carril contra el cual verificar la ruta.',
    );
  }
  const fileClass = classifyChangedFile(
    args.path,
    ctx.currentSession.areas,
    ctx.config.sharedZones,
  );
  return {
    ok: true,
    path: args.path,
    class: fileClass,
    // Anything inside the lane or a shared zone is allowed; only a true invasion
    // is blocked.
    allowed: fileClass !== 'invasion',
    session: ctx.currentSession.id,
  };
};

export type BootstrapArgs = {
  readonly sessions?: number;
  readonly remote?: string;
  readonly baseBranch?: string;
};

export type BootstrapResultShape = {
  readonly gitInitialized: boolean;
  readonly remoteAdded?: string;
  readonly alreadyConfigured: boolean;
  readonly committed: boolean;
  readonly config?: AgentsConfig;
  readonly runbook?: RunbookResult;
};

// Unlike every other tool, bootstrap runs BEFORE the repo is configured, so it
// takes the raw server cwd instead of a resolved McpContext (the config and
// worktrees may not exist yet). The engine owns the already-configured and
// inside-worktree guards.
export const handleBootstrap = async (
  cwd: string,
  args: BootstrapArgs,
  deps: ToolDeps,
): Promise<ToolResult<BootstrapResultShape>> => {
  const result = await bootstrapRepo({
    cwd,
    now: deps.now,
    ...(args.sessions !== undefined ? { sessions: args.sessions } : {}),
    ...(args.baseBranch !== undefined ? { baseBranch: args.baseBranch } : {}),
    ...(args.remote !== undefined ? { remote: { url: args.remote } } : {}),
    ...(deps.run !== undefined ? { run: deps.run } : {}),
    ...(deps.runRaw !== undefined ? { runRaw: deps.runRaw } : {}),
  });
  return result.ok ? { ok: true, ...result.value } : failFrom(result.error);
};

export type AddRemoteArgs = { readonly url: string; readonly name?: string };

export type AddRemoteResult = { readonly name: string; readonly url: string };

// Attaches a remote to the SHARED root's git binding (not the worktree cwd), so an
// agent inside a session can point the whole repo at its origin. addRemote is a
// soft no-op when the remote already exists.
export const handleAddRemote = async (
  ctx: McpContext,
  args: AddRemoteArgs,
  deps: ToolDeps,
): Promise<ToolResult<AddRemoteResult>> => {
  const name = args.name ?? 'origin';
  const git = createGit(ctx.sharedRoot, deps.run, deps.runRaw);
  const added = await git.addRemote(name, args.url);
  return added.ok ? { ok: true, name, url: args.url } : fail(added.error.kind, describeGitError(added.error));
};
