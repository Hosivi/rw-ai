import path from 'node:path';
import type { AgentsConfig } from '../contract/schema.js';
import { err, ok, type Result } from '../core/result.js';
import type { CommandRunner } from '../engine/exec.js';
import { createGit } from '../engine/git.js';
import { listRoles, type IdentityError, type RoleStatus } from '../engine/identity.js';
import { activeSessions } from '../engine/sessions.js';
import { computeSessionState, type GitSignal, type SessionState } from './aggregate.js';
import { readSessionMarker, type SessionMarker } from './marker.js';

export type ReadDeps = {
  readonly config: AgentsConfig;
  readonly projectRoot: string;
  readonly boardDir: string;
  readonly now: Date;
  readonly run?: CommandRunner;
  readonly runRaw?: CommandRunner;
};

export type ReadError = { readonly kind: 'claims'; readonly message: string; readonly cause: IdentityError };

const CLEAN: GitSignal = { dirty: false, ahead: 0, behind: 0 };

// Per-session git snapshot from the session's own worktree. Each git read that
// fails (worktree not provisioned yet, unknown base) degrades to a clean/zero
// value so one unprovisioned session never breaks the whole status view.
const gitSignalFor = async (
  worktreePath: string,
  baseBranch: string,
  run?: CommandRunner,
  runRaw?: CommandRunner,
): Promise<GitSignal> => {
  const git = createGit(worktreePath, run, runRaw);
  const porcelain = await git.statusPorcelain();
  const dirty = porcelain.ok ? porcelain.value.trim().length > 0 : false;
  const ab = await git.aheadBehind(baseBranch);
  return ab.ok ? { dirty, ahead: ab.value.ahead, behind: ab.value.behind } : { ...CLEAN, dirty };
};

// One-shot read of the whole workspace state: claims (lock-free), each session's
// marker, and each session's git divergence — folded into SessionState[] via the
// pure aggregate. Reusable by both `rw status` and the Phase-2 daemon.
export const collectSessionStates = async (
  deps: ReadDeps,
): Promise<Result<SessionState[], ReadError>> => {
  const roles = await listRoles({ config: deps.config, boardDir: deps.boardDir, now: deps.now });
  if (!roles.ok) {
    return err({ kind: 'claims', message: roles.error.message, cause: roles.error });
  }

  const markers = new Map<string, SessionMarker | null>();
  const gitSignals = new Map<string, GitSignal>();
  for (const session of activeSessions(deps.config)) {
    const marker = await readSessionMarker(deps.boardDir, session.id);
    // Best-effort: BOTH a corrupt marker (invalid-marker) and a real read failure
    // (io) degrade to null so one bad session never fails the whole status read.
    // Trade-off: a persistent IO fault on the board dir looks like "no marker yet";
    // surfacing that distinctly is a Phase-2 (daemon/observability) concern.
    markers.set(session.id, marker.ok ? marker.value : null);
    const worktreePath = path.join(deps.projectRoot, session.worktree);
    gitSignals.set(
      session.id,
      await gitSignalFor(worktreePath, deps.config.git.baseBranch, deps.run, deps.runRaw),
    );
  }

  return ok(computeSessionState(deps.config, roles.value as RoleStatus[], markers, gitSignals));
};
