import path from 'node:path';
import type { AgentsConfig, Session } from '../contract/schema.js';
import { err, ok, type Err, type Result } from '../core/result.js';
import { ensureIntegrationBranch } from './branches.js';
import { writeAgentsConfig } from './config-io.js';
import type { CommandRunner } from './exec.js';
import { createGit, type Git, type GitError } from './git.js';

// Concurrency constraint: finishSession switches the session worktree onto the
// integration branch to merge, so it needs EXCLUSIVE use of that checkout. Two
// finishes running at once collide at the switch step (only one worktree may
// hold a branch), where the second fails with 'integration-busy'. Callers must
// serialize finishes — e.g. by holding the integrator claim (see identity.ts).
//
// Ordering guarantee: the only irreversible step (`git branch -D` on the old
// branch) runs LAST, after the worktree is safely off the shared branch and the
// config is persisted. Every earlier failure is recoverable — the old branch
// still exists and nothing is lost.

// Rotate the trailing segment of a session branch: '-inicial' becomes '-2', a
// trailing '-<n>' increments, and anything else gains a '-2'. Kept pure so the
// naming rule is unit-testable without touching git.
export const nextRotatedBranch = (oldBranch: string): string => {
  const inicial = '-inicial';
  if (oldBranch.endsWith(inicial)) {
    return `${oldBranch.slice(0, -inicial.length)}-2`;
  }
  const match = /-(\d+)$/.exec(oldBranch);
  if (match !== null) {
    return `${oldBranch.slice(0, match.index)}-${Number(match[1]) + 1}`;
  }
  return `${oldBranch}-2`;
};

export type FinishResult = {
  readonly sessionId: string;
  readonly worktree: string;
  readonly oldBranch: string;
  readonly newBranch: string;
  readonly integrationBranch: string;
  // False when the merge/rotation succeeded but deleting the old branch did not;
  // `warning` then explains the manual cleanup left to the caller.
  readonly oldBranchDeleted: boolean;
  readonly warning?: string;
};

export type LifecycleError = {
  readonly kind:
    | 'unknown-session'
    | 'invalid-rotation'
    | 'branch-exists'
    | 'worktree-not-on-branch'
    | 'dirty-worktree'
    | 'integration-busy'
    | 'merge-conflict'
    | 'recovery-failed'
    | 'config-write-failed'
    | 'git';
  readonly message: string;
  readonly sessionId?: string;
  readonly cause?: unknown;
};

export type FinishSessionParams = {
  readonly config: AgentsConfig;
  readonly projectRoot: string;
  readonly sessionId: string;
  readonly newBranch?: string;
  readonly run?: CommandRunner;
  readonly runRaw?: CommandRunner;
};

const gitErr = (sessionId: string, message: string, cause: GitError): Err<LifecycleError> =>
  err({ kind: 'git', sessionId, message, cause });

const recoveryFailed = (
  sessionId: string,
  worktreePath: string,
  oldBranch: string,
  integration: string,
): Err<LifecycleError> =>
  err({
    kind: 'recovery-failed',
    sessionId,
    message: `could not restore worktree ${worktreePath} to '${oldBranch}'; it may still be on '${integration}' and needs manual intervention (git -C ${worktreePath} switch ${oldBranch})`,
  });

// Switch the worktree to `branch` and VERIFY it landed there, so callers never
// assert a restore that did not actually happen.
const switchAndVerify = async (wtGit: Git, branch: string): Promise<boolean> => {
  const switched = await wtGit.switchBranch(branch);
  if (!switched.ok) {
    return false;
  }
  const current = await wtGit.currentBranch();
  return current.ok && current.value === branch;
};

// Cancel any in-progress merge, then restore the worktree to `branch`.
const restoreWorktreeToBranch = (wtGit: Git, branch: string): Promise<boolean> =>
  wtGit.mergeAbort().then(() => switchAndVerify(wtGit, branch));

type PreflightContext = {
  readonly session: Session;
  readonly worktreePath: string;
  readonly oldBranch: string;
  readonly integration: string;
  readonly newBranchName: string;
  readonly repoGit: Git;
  readonly wtGit: Git;
};

// Read-only guards (steps 1–7): resolve the session, validate the rotation name,
// and confirm the worktree is on the session branch and clean. Extracted so the
// guards are testable in isolation and the orchestration below stays short.
const preflight = async (
  params: FinishSessionParams,
): Promise<Result<PreflightContext, LifecycleError>> => {
  const { config, projectRoot, sessionId, run, runRaw } = params;

  const session = config.sessions.find(
    (candidate) => candidate.id === sessionId && candidate.status === 'active',
  );
  if (session === undefined) {
    return err({
      kind: 'unknown-session',
      sessionId,
      message: `no active session '${sessionId}' in agents.config.json`,
    });
  }

  const oldBranch = session.branch;
  const integration = config.git.integrationBranch;
  const worktreePath = path.join(projectRoot, session.worktree);
  const newBranchName = params.newBranch ?? nextRotatedBranch(oldBranch);
  const repoGit = createGit(projectRoot, run, runRaw);
  const wtGit = createGit(worktreePath, run, runRaw);

  if (newBranchName === oldBranch || newBranchName === integration) {
    return err({
      kind: 'invalid-rotation',
      sessionId,
      message: `rotated branch '${newBranchName}' must differ from the current branch and the integration branch '${integration}'`,
    });
  }

  const targetExists = await repoGit.branchExists(newBranchName);
  if (!targetExists.ok) {
    return gitErr(sessionId, `could not check whether branch '${newBranchName}' exists`, targetExists.error);
  }
  if (targetExists.value) {
    return err({
      kind: 'branch-exists',
      sessionId,
      message: `rotated branch '${newBranchName}' already exists; finish never reuses or renames an existing branch`,
    });
  }

  const current = await wtGit.currentBranch();
  if (!current.ok) {
    return gitErr(sessionId, `could not read the current branch of worktree ${worktreePath}`, current.error);
  }
  if (current.value !== oldBranch) {
    return err({
      kind: 'worktree-not-on-branch',
      sessionId,
      message: `worktree ${worktreePath} is on '${current.value}', expected the session branch '${oldBranch}'`,
    });
  }

  const status = await wtGit.statusPorcelain();
  if (!status.ok) {
    return gitErr(sessionId, `could not read the status of worktree ${worktreePath}`, status.error);
  }
  if (status.value !== '') {
    return err({
      kind: 'dirty-worktree',
      sessionId,
      message: `worktree ${worktreePath} has uncommitted changes; commit or stash them before finishing`,
    });
  }

  return ok({ session, worktreePath, oldBranch, integration, newBranchName, repoGit, wtGit });
};

export const finishSession = async (
  params: FinishSessionParams,
): Promise<Result<FinishResult, LifecycleError>> => {
  const { config, projectRoot, sessionId } = params;

  const pre = await preflight(params);
  if (!pre.ok) {
    return pre;
  }
  const { session, worktreePath, oldBranch, integration, newBranchName, repoGit, wtGit } = pre.value;

  // Guarantee the integration branch exists before switching onto it.
  const integrationReady = await ensureIntegrationBranch(repoGit, config);
  if (!integrationReady.ok) {
    return err({
      kind: 'git',
      sessionId,
      message: integrationReady.error.message,
      cause: integrationReady.error.cause,
    });
  }

  // Move the worktree onto integration. Failure here is almost always the branch
  // being checked out by a concurrent finish.
  const switched = await wtGit.switchBranch(integration);
  if (!switched.ok) {
    return err({
      kind: 'integration-busy',
      sessionId,
      message: `could not switch worktree ${worktreePath} to '${integration}': finish must run one at a time; release other worktrees on the integration branch`,
      cause: switched.error,
    });
  }

  // Merge the session branch into integration. On a conflict, or a merge that
  // could not even run, restore the worktree to its original branch and report
  // truthfully whether that restore actually succeeded.
  const merged = await wtGit.mergeNoFf(oldBranch, `Merge ${oldBranch} into ${integration}`);
  if (!merged.ok) {
    const restored = await restoreWorktreeToBranch(wtGit, oldBranch);
    return restored
      ? gitErr(
          sessionId,
          `merge of '${oldBranch}' into '${integration}' failed; the worktree was restored to '${oldBranch}' and no branches were rotated`,
          merged.error,
        )
      : recoveryFailed(sessionId, worktreePath, oldBranch, integration);
  }
  if (merged.value.status === 'conflict') {
    const restored = await restoreWorktreeToBranch(wtGit, oldBranch);
    return restored
      ? err({
          kind: 'merge-conflict',
          sessionId,
          message: `merging '${oldBranch}' into '${integration}' hit conflicts; the worktree was restored to '${oldBranch}' and no branches were rotated`,
        })
      : recoveryFailed(sessionId, worktreePath, oldBranch, integration);
  }

  // Move the worktree OFF integration onto the fresh rotated branch BEFORE any
  // irreversible step. If it fails, the old branch still exists, so restoring
  // the worktree to it is safe and nothing is lost.
  const rotated = await wtGit.switchNewBranch(newBranchName, integration);
  if (!rotated.ok) {
    const restored = await switchAndVerify(wtGit, oldBranch);
    return restored
      ? gitErr(
          sessionId,
          `merged '${oldBranch}' into '${integration}' but could not create the rotated branch '${newBranchName}'; the worktree was restored to '${oldBranch}' and no branches were deleted`,
          rotated.error,
        )
      : recoveryFailed(sessionId, worktreePath, oldBranch, integration);
  }

  // Persist the new branch name. Non-destructive if it fails: the worktree is
  // already correctly on newBranch and the old branch still exists.
  const updatedConfig: AgentsConfig = {
    ...config,
    sessions: config.sessions.map((candidate) =>
      candidate.id === sessionId ? { ...candidate, branch: newBranchName } : candidate,
    ),
  };
  const configWritten = await writeAgentsConfig(projectRoot, updatedConfig);
  if (!configWritten.ok) {
    return err({
      kind: 'config-write-failed',
      sessionId,
      message: `branches rotated but agents.config.json not updated; set sessions[${sessionId}].branch to ${newBranchName} manually`,
      cause: configWritten.error,
    });
  }

  // Delete the old branch LAST — the only irreversible step, run once the
  // worktree is safely off it and config points at newBranch. A failure here is
  // NOT fatal: the rotation already logically succeeded, so surface a warning
  // instead of an error.
  const deleted = await repoGit.deleteBranch(oldBranch);
  if (!deleted.ok) {
    return ok({
      sessionId,
      worktree: session.worktree,
      oldBranch,
      newBranch: newBranchName,
      integrationBranch: integration,
      oldBranchDeleted: false,
      warning: `could not delete old branch '${oldBranch}'; delete it manually (git branch -D ${oldBranch})`,
    });
  }

  return ok({
    sessionId,
    worktree: session.worktree,
    oldBranch,
    newBranch: newBranchName,
    integrationBranch: integration,
    oldBranchDeleted: true,
  });
};
