import path from 'node:path';
import { resolveBoardDir } from '../contract/env.js';
import type { AgentsConfig, Session } from '../contract/schema.js';
import { assertNever } from '../core/assert.js';
import { err, ok, type Result } from '../core/result.js';
import { readAgentsConfig, type ConfigIoError } from '../engine/config-io.js';
import type { CommandRunner } from '../engine/exec.js';
import { createGit, normalizeRepoPath } from '../engine/git.js';

// The context every MCP tool opens first. An agent launches this server from
// INSIDE its session worktree, so `cwd` is the worktree — but agents.config.json
// and the review board live at the MAIN repo root. `sharedRoot` is that main
// root, `currentSession` is the session whose worktree contains `cwd` (undefined
// when the server was launched from the main root, not a session worktree).
export type McpContext = {
  readonly sharedRoot: string;
  readonly config: AgentsConfig;
  readonly boardDir: string;
  readonly currentSession?: Session;
};

// Kinds mirror CliContextError so tools can explain the same actionable next
// step: 'not-a-repo' means run inside a repo, 'config-not-found' invites
// scaffolding, 'config-invalid' points at a file to fix (issues carries the
// violations), 'io' is a filesystem failure that is none of those.
export type McpContextError = {
  readonly kind: 'not-a-repo' | 'config-not-found' | 'config-invalid' | 'io';
  readonly message: string;
  readonly issues?: readonly string[];
  readonly cause?: unknown;
};

// ConfigIoError collapses onto McpContextError exactly like cli/context.ts: JSON
// and schema failures are a single 'config-invalid' the user fixes by hand, and
// only 'invalid-config' carries schema issues worth surfacing.
const fromConfigIoError = (error: ConfigIoError): McpContextError => {
  switch (error.kind) {
    case 'not-found':
      return { kind: 'config-not-found', message: error.message, cause: error.cause };
    case 'invalid-json':
      return { kind: 'config-invalid', message: error.message, cause: error.cause };
    case 'invalid-config':
      return {
        kind: 'config-invalid',
        message: error.message,
        ...(error.issues !== undefined ? { issues: error.issues } : {}),
        cause: error.cause,
      };
    case 'io':
      return { kind: 'io', message: error.message, cause: error.cause };
    default:
      return assertNever(error.kind);
  }
};

// Equals-or-nested-under-'/' boundary, mirroring filterByCwd: the trailing '/'
// stops '.../s1' from also matching a sibling '.../s10'. Both sides are already
// normalizeRepoPath'd by the caller.
const isWithin = (candidate: string, base: string): boolean =>
  candidate === base || candidate.startsWith(`${base}/`);

// The current session is the one whose worktree CONTAINS cwd. Session worktrees
// are stored relative to the shared root, so each is resolved against it before
// comparing. undefined when cwd is not inside any session worktree.
const findCurrentSession = (
  sharedRoot: string,
  cwd: string,
  sessions: readonly Session[],
): Session | undefined => {
  const normalizedCwd = normalizeRepoPath(cwd);
  return sessions.find((session) =>
    isWithin(normalizedCwd, normalizeRepoPath(path.join(sharedRoot, session.worktree))),
  );
};

// Resolve the shared context from an agent's worktree cwd. `git worktree list
// --porcelain` ALWAYS lists the main worktree first, so its path is the shared
// repo root — NOT the worktree we were launched inside, where a relative board
// path or a stale config copy would otherwise be read. Runners are injectable so
// the whole flow is stubbable in tests.
export const resolveMcpContext = async (
  cwd: string,
  run?: CommandRunner,
  runRaw?: CommandRunner,
): Promise<Result<McpContext, McpContextError>> => {
  const worktrees = await createGit(cwd, run, runRaw).listWorktrees();
  if (!worktrees.ok) {
    return err({
      kind: 'not-a-repo',
      message: `No estás dentro de un repositorio git (${cwd}).`,
      cause: worktrees.error,
    });
  }
  const mainWorktree = worktrees.value[0];
  if (mainWorktree === undefined) {
    return err({
      kind: 'not-a-repo',
      message: `No se pudo resolver la raíz compartida del repositorio desde ${cwd}.`,
    });
  }
  const sharedRoot = mainWorktree.path;

  const config = await readAgentsConfig(sharedRoot);
  if (!config.ok) {
    return err(fromConfigIoError(config.error));
  }

  const currentSession = findCurrentSession(sharedRoot, cwd, config.value.sessions);
  return ok({
    sharedRoot,
    config: config.value,
    boardDir: resolveBoardDir(sharedRoot, config.value),
    ...(currentSession !== undefined ? { currentSession } : {}),
  });
};
