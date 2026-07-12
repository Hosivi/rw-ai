import fs from 'node:fs/promises';
import path from 'node:path';
import { createSession, MAX_SESSION_INDEX } from '../contract/defaults.js';
import { resolveBoardDir } from '../contract/env.js';
import { parseAgentsConfig, type AgentsConfig, type Session } from '../contract/schema.js';
import { assertNever } from '../core/assert.js';
import { err, ok, type Result } from '../core/result.js';
import { ensureBoard, writeBoard, writeFileIdempotent } from './board.js';
import { writeBranchGraph } from './branch-graph.js';
import { ensureIntegrationBranch, ensureSessionBranches } from './branches.js';
import { writeAgentsConfig } from './config-io.js';
import { ensureSessionDatabases, type SessionDbResult } from './database.js';
import { SESSION_ENV_FILENAME, writeSessionEnvFiles } from './env-files.js';
import { runCommand, runCommandRaw, type CommandRunner } from './exec.js';
import { createGit, MIN_GIT_VERSION, supportsMergeTree, type GitError } from './git.js';
import { forceFreeRole, readClaims, writeClaims } from './identity.js';
import { activeSessions } from './sessions.js';
import { generateWiringPlan, renderWiringDoc } from './test-wiring.js';
import {
  ensureExcludeEntries,
  ensureGitignoreEntry,
  ensureWorktrees,
  installWorktreeDeps,
} from './worktrees.js';

// The runbook never throws: each provisioning step aggregates into a status so a
// single pass surfaces every problem instead of aborting on the first one.
export type StepStatus = 'ok' | 'degraded' | 'skipped' | 'failed';

export type RunbookStep = {
  readonly name: string;
  readonly status: StepStatus;
  readonly detail: string;
};

export type RunbookResult = {
  readonly ok: boolean;
  readonly steps: readonly RunbookStep[];
};

export type ConfigureDeps = {
  // Injected so board.md / test-wiring.md timestamps stay deterministic in tests.
  readonly now: Date;
  // Command runners are injectable so git/psql/pnpm can be stubbed; they default
  // to the real spawners.
  readonly run?: CommandRunner;
  readonly runRaw?: CommandRunner;
};

// Canonical order and the single source of truth for "which steps exist"; a hard
// abort marks every name NOT yet reported as skipped, in this order.
const STEP_NAMES = [
  'preflight-git',
  'integration-branch',
  'session-branches',
  'worktrees',
  'worktree-deps',
  'databases',
  'env-files',
  'board',
  'board-md',
  'branch-graph',
  'test-wiring',
  'claims',
] as const;

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const describeGitError = (error: GitError): string => {
  switch (error.kind) {
    case 'spawn-failed':
    case 'parse-failed':
      return error.message;
    case 'non-zero-exit':
      return `exit ${error.output.exitCode}: ${error.output.stderr.trim()}`;
    default:
      return assertNever(error);
  }
};

// Counts equal actions/values in stable insertion order: '2 created' or
// '1 created, 1 exists'. Used for every per-session action summary.
const summarizeActions = (actions: readonly string[]): string => {
  if (actions.length === 0) {
    return 'none';
  }
  const counts = new Map<string, number>();
  for (const action of actions) {
    counts.set(action, (counts.get(action) ?? 0) + 1);
  }
  return [...counts.entries()].map(([action, count]) => `${count} ${action}`).join(', ');
};

// Joins only the non-zero (count, label) pairs, so a fully-idempotent run reads
// 'N exist' rather than '0 created, N exist'.
const summarizeCounts = (parts: ReadonlyArray<readonly [count: number, label: string]>): string => {
  const nonZero = parts.filter(([count]) => count > 0).map(([count, label]) => `${count} ${label}`);
  return nonZero.length === 0 ? 'none' : nonZero.join(', ');
};

type StepOutcome = { readonly status: StepStatus; readonly detail: string };

// The single Result-to-step mapping: onOk formats the success detail (or returns
// a full outcome for steps like databases whose success can still be 'degraded'),
// onErr formats the failure detail under the given failStatus.
const resultStep = <T, E>(
  name: string,
  result: Result<T, E>,
  onOk: (value: T) => string | StepOutcome,
  onErr: (error: E) => string,
  failStatus: StepStatus,
): RunbookStep => {
  if (result.ok) {
    const outcome = onOk(result.value);
    return typeof outcome === 'string'
      ? { name, status: 'ok', detail: outcome }
      : { name, status: outcome.status, detail: outcome.detail };
  }
  return { name, status: failStatus, detail: onErr(result.error) };
};

// A db run degrades whenever any session fell back to a manual create command;
// 'skipped' (strategy none) and 'exists'/'created' are healthy outcomes.
const summarizeDatabases = (results: readonly SessionDbResult[]): StepOutcome => {
  const detail = `db: ${summarizeActions(results.map((entry) => entry.action))}`;
  return { status: results.some((entry) => entry.action === 'manual') ? 'degraded' : 'ok', detail };
};

// worktrees + gitignore are one HARD step: both must succeed before anything
// downstream can assume the checkouts exist.
const runWorktreesStep = async (
  git: ReturnType<typeof createGit>,
  config: AgentsConfig,
  projectRoot: string,
): Promise<RunbookStep> => {
  const worktrees = await ensureWorktrees(git, config, projectRoot);
  if (!worktrees.ok) {
    return { name: 'worktrees', status: 'failed', detail: worktrees.error.message };
  }
  const ignore = await ensureGitignoreEntry(projectRoot, config.git.worktreesDir);
  if (!ignore.ok) {
    return { name: 'worktrees', status: 'failed', detail: ignore.error.message };
  }
  // The env-files and worktree-deps steps generate artifacts (.env.local,
  // node_modules/) INSIDE each session worktree; recording them in the shared
  // info/exclude keeps every session tree clean without committing an ignore to
  // any session branch. The common git dir is shared across all linked worktrees.
  const commonDir = await git.commonDir();
  if (!commonDir.ok) {
    return { name: 'worktrees', status: 'failed', detail: describeGitError(commonDir.error) };
  }
  const exclude = await ensureExcludeEntries(commonDir.value, [SESSION_ENV_FILENAME, 'node_modules/']);
  if (!exclude.ok) {
    return { name: 'worktrees', status: 'failed', detail: exclude.error.message };
  }
  return {
    name: 'worktrees',
    status: 'ok',
    detail: `worktrees: ${summarizeActions(worktrees.value.map((entry) => entry.action))}; gitignore ${ignore.value.action}; exclude ${exclude.value.action}`,
  };
};

// SOFT: install deps in EVERY active worktree, collecting outcomes — a failure
// in one session must never short-circuit the loop (mirrors ensureSessionDatabases
// and honours the "one pass surfaces every problem" contract). If any session
// failed, the step degrades and names them all; otherwise it is ok.
const runWorktreeDepsStep = async (
  config: AgentsConfig,
  projectRoot: string,
  run: CommandRunner,
): Promise<RunbookStep> => {
  const actions: string[] = [];
  const failures: Array<{ readonly id: string; readonly message: string }> = [];
  for (const session of activeSessions(config)) {
    const worktreePath = path.join(projectRoot, session.worktree);
    const installed = await installWorktreeDeps(worktreePath, config.project.stacks, run);
    if (!installed.ok) {
      failures.push({ id: session.id, message: installed.error.message });
      continue;
    }
    actions.push(...installed.value.map((entry) => entry.action));
  }
  if (failures.length > 0) {
    const ids = failures.map((failure) => failure.id).join(', ');
    const reasons = failures.map((failure) => `${failure.id}: ${failure.message}`).join('; ');
    return { name: 'worktree-deps', status: 'degraded', detail: `deps degraded for ${ids}: ${reasons}` };
  }
  return { name: 'worktree-deps', status: 'ok', detail: `deps: ${summarizeActions(actions)}` };
};

// test-wiring.ts exposes a renderer but no writer, so the runbook owns the write:
// render the plan and drop it in the board's reports dir idempotently.
const runTestWiringStep = async (
  config: AgentsConfig,
  boardDir: string,
  now: Date,
): Promise<RunbookStep> => {
  const plan = generateWiringPlan(config);
  if (!plan.ok) {
    return { name: 'test-wiring', status: 'failed', detail: plan.error.message };
  }
  const reportsDir = path.join(boardDir, 'reports');
  try {
    // ensureBoard already seeds this dir; mkdir keeps the step self-contained if
    // that step was skipped or failed upstream.
    await fs.mkdir(reportsDir, { recursive: true });
  } catch (error) {
    return {
      name: 'test-wiring',
      status: 'failed',
      detail: `could not create ${reportsDir}: ${errorMessage(error)}`,
    };
  }
  const written = await writeFileIdempotent(
    path.join(reportsDir, 'test-wiring.md'),
    renderWiringDoc(plan.value, now),
  );
  return written.ok
    ? { name: 'test-wiring', status: 'ok', detail: `test-wiring.md ${written.value.action}` }
    : { name: 'test-wiring', status: 'failed', detail: written.error.message };
};

// readClaims preserves live claims and reconciles new active roles to 'free', so
// writing that result back can only add roles — never clobber an in-progress claim.
const runClaimsStep = async (config: AgentsConfig, boardDir: string): Promise<RunbookStep> => {
  const claims = await readClaims(boardDir, config);
  if (!claims.ok) {
    return { name: 'claims', status: 'failed', detail: claims.error.message };
  }
  const written = await writeClaims(boardDir, claims.value);
  return written.ok
    ? {
        name: 'claims',
        status: 'ok',
        detail: `claims.json: ${Object.keys(claims.value.claims).length} roles`,
      }
    : { name: 'claims', status: 'failed', detail: written.error.message };
};

export const configure = async (
  config: AgentsConfig,
  projectRoot: string,
  deps: ConfigureDeps,
): Promise<RunbookResult> => {
  const run = deps.run ?? runCommand;
  const runRaw = deps.runRaw ?? runCommandRaw;
  const git = createGit(projectRoot, run, runRaw);
  const boardDir = resolveBoardDir(projectRoot, config);
  const steps: RunbookStep[] = [];

  // A HARD failure stops the pass: every step not yet reported is marked skipped
  // (in canonical order) and the runbook returns ok:false.
  const abort = (): RunbookResult => {
    const reported = new Set(steps.map((entry) => entry.name));
    for (const name of STEP_NAMES) {
      if (!reported.has(name)) {
        steps.push({ name, status: 'skipped', detail: 'skipped after a required step failed' });
      }
    }
    return { ok: false, steps };
  };

  // 1. preflight-git (HARD): git must exist AND support merge-tree (>= 2.38).
  const preflight = resultStep(
    'preflight-git',
    await git.version(),
    (version) =>
      supportsMergeTree(version)
        ? `git ${version.major}.${version.minor}.${version.patch} supports merge-tree`
        : {
            status: 'failed',
            detail: `git ${version.raw} is below the required ${MIN_GIT_VERSION.major}.${MIN_GIT_VERSION.minor} for merge-tree`,
          },
    describeGitError,
    'failed',
  );
  steps.push(preflight);
  if (preflight.status === 'failed') {
    return abort();
  }

  // 2. integration-branch (HARD).
  const integration = resultStep(
    'integration-branch',
    await ensureIntegrationBranch(git, config),
    (result) => `integration branch '${result.branch}' ${result.action}`,
    (error) => error.message,
    'failed',
  );
  steps.push(integration);
  if (integration.status === 'failed') {
    return abort();
  }

  // 3. session-branches (HARD).
  const branches = resultStep(
    'session-branches',
    await ensureSessionBranches(git, config),
    (result) => `session branches: ${summarizeActions(result.map((entry) => entry.action))}`,
    (error) => error.message,
    'failed',
  );
  steps.push(branches);
  if (branches.status === 'failed') {
    return abort();
  }

  // 4. worktrees (HARD): after this, branches + worktrees are guaranteed present.
  const worktrees = await runWorktreesStep(git, config, projectRoot);
  steps.push(worktrees);
  if (worktrees.status === 'failed') {
    return abort();
  }

  // 5. worktree-deps (SOFT).
  steps.push(await runWorktreeDepsStep(config, projectRoot, run));

  // 6. databases (SOFT): the call already models manual/skipped fallbacks.
  steps.push(
    resultStep(
      'databases',
      await ensureSessionDatabases(config, projectRoot, run),
      summarizeDatabases,
      (error) => error.message,
      'degraded',
    ),
  );

  // 7. env-files (CONTINUE-ON-FAIL): a failure fails the runbook but keeps going
  // so one pass reveals every remaining problem.
  steps.push(
    resultStep(
      'env-files',
      await writeSessionEnvFiles(config, projectRoot),
      (result) => `env-files: ${summarizeActions(result.map((entry) => entry.action))}`,
      (error) => error.message,
      'failed',
    ),
  );

  // 8. board (CONTINUE-ON-FAIL).
  steps.push(
    resultStep(
      'board',
      await ensureBoard(config, projectRoot),
      (result) =>
        `board: ${summarizeCounts([
          [result.created.length, 'created'],
          [result.existing.length, 'exist'],
        ])}`,
      (error) => error.message,
      'failed',
    ),
  );

  // 9. board-md (CONTINUE-ON-FAIL): empty snapshot — live data is wired at the
  // command layer later, not here.
  steps.push(
    resultStep(
      'board-md',
      await writeBoard(config, {}, deps.now, projectRoot),
      (result) => `board.md ${result.action}`,
      (error) => error.message,
      'failed',
    ),
  );

  // 10. branch-graph (CONTINUE-ON-FAIL).
  steps.push(
    resultStep(
      'branch-graph',
      await writeBranchGraph(git, config, projectRoot),
      (result) => `branches.mmd ${result.action}`,
      (error) => error.message,
      'failed',
    ),
  );

  // 11. test-wiring (CONTINUE-ON-FAIL).
  steps.push(await runTestWiringStep(config, boardDir, deps.now));

  // 12. claims (CONTINUE-ON-FAIL).
  steps.push(await runClaimsStep(config, boardDir));

  // ok when nothing FAILED; a soft 'degraded' step is a warning, not a failure.
  return { ok: steps.every((entry) => entry.status !== 'failed'), steps };
};

// ---------------------------------------------------------------------------
// Session administration (no provisioning — the caller re-runs configure)
// ---------------------------------------------------------------------------

// 'invalid-config' (a colliding override / failed validation — never worth
// retrying) is kept distinct from 'io' (a disk write failure — retryable).
export type ConfigureAdminError = {
  readonly kind: 'session-not-found' | 'already-archived' | 'max-sessions' | 'invalid-config' | 'io';
  readonly message: string;
  readonly cause?: unknown;
};

// NOTE: addSession/archiveSession are last-writer-wins on agents.config.json —
// there is no advisory lock around the read-modify-write. That cold-path
// concurrency is intentionally deferred to the command layer.

export type AddSessionParams = {
  readonly areas?: string[];
  readonly platforms?: Session['platforms'];
  readonly branch?: string;
};

// The numeric suffix of a session id ('s3' -> 3); undefined for anything that is
// not a well-formed id.
const sessionIndex = (id: string): number | undefined => {
  const match = /^s([1-9][0-9]*)$/.exec(id);
  return match?.[1] === undefined ? undefined : Number(match[1]);
};

// Appends the next session (max existing index + 1). Ports come with the node
// stack and a db name when a db strategy is active — mirroring createDefaultConfig.
export const addSession = async (
  config: AgentsConfig,
  projectRoot: string,
  params: AddSessionParams,
): Promise<Result<{ config: AgentsConfig; session: Session }, ConfigureAdminError>> => {
  const indexes = config.sessions
    .map((session) => sessionIndex(session.id))
    .filter((index): index is number => index !== undefined);
  const nextIndex = (indexes.length === 0 ? 0 : Math.max(...indexes)) + 1;
  if (nextIndex > MAX_SESSION_INDEX) {
    return err({
      kind: 'max-sessions',
      message: `cannot add session s${nextIndex}: exceeds the maximum session index ${MAX_SESSION_INDEX}`,
    });
  }
  const session = createSession({
    index: nextIndex,
    projectName: config.project.name,
    withPorts: config.project.stacks.includes('node'),
    withDb: config.db.strategy !== 'none',
    worktreesDir: config.git.worktreesDir,
    areas: params.areas,
    platforms: params.platforms,
    branch: params.branch,
  });
  if (!session.ok) {
    return err({ kind: 'invalid-config', message: session.error.message });
  }
  const nextConfig: AgentsConfig = { ...config, sessions: [...config.sessions, session.value] };
  // Re-validate BEFORE writing so a colliding override (branch or port) is
  // rejected without ever touching the config file. Area overlap is NOT a
  // collision here — it is deliberate (defaults are all ['**/*']; the integrator
  // detects overlaps at runtime rather than forbidding them).
  const validated = parseAgentsConfig(nextConfig);
  if (!validated.ok) {
    return err({
      kind: 'invalid-config',
      message: `config is invalid after adding session s${nextIndex}: ${validated.error.message}`,
      cause: validated.error,
    });
  }
  const written = await writeAgentsConfig(projectRoot, validated.value);
  if (!written.ok) {
    return err({ kind: 'io', message: written.error.message, cause: written.error.cause });
  }
  return ok({ config: validated.value, session: session.value });
};

// Archives a session: it keeps its branch and worktree (history is never
// deleted) but is excluded from future provisioning via activeSessions. It also
// frees any live claim on that role — once archived, the role drops out of the
// live role set and its claim could never otherwise be released. `now` drives
// the claims lock's stale-check.
export const archiveSession = async (
  config: AgentsConfig,
  projectRoot: string,
  sessionId: string,
  now: Date,
): Promise<Result<AgentsConfig, ConfigureAdminError>> => {
  const target = config.sessions.find((session) => session.id === sessionId);
  if (target === undefined) {
    return err({ kind: 'session-not-found', message: `session '${sessionId}' not found` });
  }
  if (target.status === 'archived') {
    return err({ kind: 'already-archived', message: `session '${sessionId}' is already archived` });
  }
  const nextConfig: AgentsConfig = {
    ...config,
    sessions: config.sessions.map((session) =>
      session.id === sessionId ? { ...session, status: 'archived' as const } : session,
    ),
  };
  const written = await writeAgentsConfig(projectRoot, nextConfig);
  if (!written.ok) {
    return err({ kind: 'io', message: written.error.message, cause: written.error.cause });
  }
  // Config is already persisted; a free-failure is surfaced (not swallowed) so
  // the caller knows the role's claim may still be dangling.
  const freed = await forceFreeRole(nextConfig, resolveBoardDir(projectRoot, config), sessionId, now);
  if (!freed.ok) {
    return err({
      kind: 'io',
      message: `session '${sessionId}' archived but could not free its claim: ${freed.error.message}`,
      cause: freed.error,
    });
  }
  return ok(nextConfig);
};
