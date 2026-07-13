import fs from 'node:fs/promises';
import path from 'node:path';
import { resolveBoardDir } from '../contract/env.js';
import type { AgentsConfig } from '../contract/schema.js';
import { assertNever } from '../core/assert.js';
import { err, ok, type Result } from '../core/result.js';
import { agentsConfigPath } from './config-io.js';
import { SESSION_ENV_FILENAME } from './env-files.js';
import { runCommand, runCommandRaw, type CommandRunner } from './exec.js';
import { createGit, type GitError } from './git.js';
import { removeExcludeEntries, removeGitignoreEntry } from './worktrees.js';

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

export type PurgeError = {
  readonly message: string;
  readonly cause?: unknown;
};

// What a purge step did to one target. 'removed' deletes a whole rw-owned thing
// (worktree, branch, board, config); 'cleaned' filters rw's lines out of a shared
// file (.gitignore, info/exclude); 'kept' is a SAFETY refusal (dirty worktree,
// unmerged branch) carrying the reason — never a failure; 'absent' means there
// was nothing of rw's to undo (idempotence).
export type PurgeAction = 'removed' | 'cleaned' | 'kept' | 'absent';

export type PurgeItemKind =
  | 'worktree'
  | 'worktrees-dir'
  | 'branch'
  | 'board'
  | 'gitignore'
  | 'exclude'
  | 'config';

export type PurgeItem = {
  readonly kind: PurgeItemKind;
  // An absolute path for filesystem targets, or the bare branch name.
  readonly target: string;
  readonly action: PurgeAction;
  // Present only for 'kept': why the target survived (shown to the user).
  readonly reason?: string;
};

export type PurgeResult = {
  readonly items: readonly PurgeItem[];
};

export type PurgeOptions = {
  // Override the safety guards: remove dirty worktrees (git worktree remove
  // --force) and delete unmerged branches (git branch -D).
  readonly force?: boolean;
  readonly run?: CommandRunner;
  readonly runRaw?: CommandRunner;
};

const pathExists = async (target: string): Promise<boolean> => {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
};

// De-provisions what `rw configure` created, with safety guards protecting user
// work: a dirty worktree or an unmerged branch is KEPT (reported, never fatal)
// and everything safe still proceeds — `--force` overrides both guards. The base
// branch, user source files and anything rw did not create are never touched.
// agents.config.json goes LAST, and only when nothing was kept: it is the source
// of truth a follow-up `--force` purge still needs to find the leftovers.
export const purgeProvisioning = async (
  projectRoot: string,
  config: AgentsConfig,
  options: PurgeOptions = {},
): Promise<Result<PurgeResult, PurgeError>> => {
  const run = options.run ?? runCommand;
  const runRaw = options.runRaw ?? runCommandRaw;
  const force = options.force === true;
  const repoGit = createGit(projectRoot, run, runRaw);
  const items: PurgeItem[] = [];

  // 1. Worktrees — EVERY session (archived included: archiving keeps the
  // checkout on disk, so the purge must sweep it too).
  for (const session of config.sessions) {
    const worktreePath = path.join(projectRoot, session.worktree);
    if (!(await pathExists(worktreePath))) {
      items.push({ kind: 'worktree', target: worktreePath, action: 'absent' });
      continue;
    }
    if (!force) {
      // The dirty guard runs INSIDE the worktree: uncommitted or untracked work
      // there is user work, so the worktree survives and the run continues.
      const status = await createGit(worktreePath, run, runRaw).statusPorcelain();
      if (!status.ok) {
        items.push({
          kind: 'worktree',
          target: worktreePath,
          action: 'kept',
          reason: `no pude verificar que esté limpio (${describeGitError(status.error)})`,
        });
        continue;
      }
      if (status.value !== '') {
        items.push({
          kind: 'worktree',
          target: worktreePath,
          action: 'kept',
          reason: 'tiene cambios sin confirmar o archivos sin rastrear',
        });
        continue;
      }
    }
    const removed = await repoGit.removeWorktree(worktreePath, force);
    if (!removed.ok) {
      return err({
        message: `no pude quitar el worktree ${worktreePath}: ${describeGitError(removed.error)}`,
        cause: removed.error,
      });
    }
    items.push({ kind: 'worktree', target: worktreePath, action: 'removed' });
  }

  // 2. The worktrees container dir: rmdir only succeeds when empty, so a kept
  // worktree (or any user file) inside keeps the dir alive by construction.
  const worktreesDirPath = path.join(projectRoot, config.git.worktreesDir);
  try {
    await fs.rmdir(worktreesDirPath);
    items.push({ kind: 'worktrees-dir', target: worktreesDirPath, action: 'removed' });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      items.push({ kind: 'worktrees-dir', target: worktreesDirPath, action: 'absent' });
    } else {
      items.push({
        kind: 'worktrees-dir',
        target: worktreesDirPath,
        action: 'kept',
        reason: 'no está vacío',
      });
    }
  }

  // 3. Branches: each session branch plus the integration branch, deduped. The
  // base branch is NEVER a candidate, even if a misconfigured session names it.
  const branchNames = [
    ...new Set([...config.sessions.map((session) => session.branch), config.git.integrationBranch]),
  ].filter((name) => name !== config.git.baseBranch);
  for (const name of branchNames) {
    const exists = await repoGit.branchExists(name);
    if (!exists.ok) {
      return err({
        message: `no pude verificar la rama ${name}: ${describeGitError(exists.error)}`,
        cause: exists.error,
      });
    }
    if (!exists.value) {
      items.push({ kind: 'branch', target: name, action: 'absent' });
      continue;
    }
    if (force) {
      const deleted = await repoGit.deleteBranch(name);
      if (!deleted.ok) {
        return err({
          message: `no pude borrar la rama ${name}: ${describeGitError(deleted.error)}`,
          cause: deleted.error,
        });
      }
      items.push({ kind: 'branch', target: name, action: 'removed' });
      continue;
    }
    // `git branch -d` semantics: an unmerged branch (or one checked out in a
    // kept worktree) is refused — user work, reported and kept.
    const deleted = await repoGit.deleteBranchSafe(name);
    if (!deleted.ok) {
      return err({
        message: `no pude borrar la rama ${name}: ${describeGitError(deleted.error)}`,
        cause: deleted.error,
      });
    }
    if (deleted.value.status === 'refused') {
      items.push({ kind: 'branch', target: name, action: 'kept', reason: deleted.value.reason });
    } else {
      items.push({ kind: 'branch', target: name, action: 'removed' });
    }
  }

  // 4. The board dir (claims.json lives inside), recursively. Board state is
  // rw-generated and gitignored, so nothing user-authored can live there.
  const boardDir = resolveBoardDir(projectRoot, config);
  if (await pathExists(boardDir)) {
    try {
      await fs.rm(boardDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch (error) {
      return err({ message: `no pude borrar el tablero ${boardDir}: ${errorMessage(error)}`, cause: error });
    }
    items.push({ kind: 'board', target: boardDir, action: 'removed' });
  } else {
    items.push({ kind: 'board', target: boardDir, action: 'absent' });
  }

  // 5. The two ignore surfaces rw owns: the /worktrees/ line in .gitignore and
  // the session-artifact patterns in the shared info/exclude.
  const ignore = await removeGitignoreEntry(projectRoot, config.git.worktreesDir);
  if (!ignore.ok) {
    return err({ message: ignore.error.message, cause: ignore.error.cause });
  }
  items.push({
    kind: 'gitignore',
    target: path.join(projectRoot, '.gitignore'),
    action: ignore.value.action,
  });
  const commonDir = await repoGit.commonDir();
  if (!commonDir.ok) {
    return err({
      message: `no pude resolver el git dir común: ${describeGitError(commonDir.error)}`,
      cause: commonDir.error,
    });
  }
  const exclude = await removeExcludeEntries(commonDir.value, [SESSION_ENV_FILENAME, 'node_modules/']);
  if (!exclude.ok) {
    return err({ message: exclude.error.message, cause: exclude.error.cause });
  }
  items.push({
    kind: 'exclude',
    target: path.join(commonDir.value, 'info', 'exclude'),
    action: exclude.value.action,
  });

  // 6. agents.config.json LAST — and only when NOTHING was kept: a partial purge
  // still needs it as the source of truth for the follow-up `--force` run.
  const configPath = agentsConfigPath(projectRoot);
  if (items.some((item) => item.action === 'kept')) {
    if (await pathExists(configPath)) {
      items.push({
        kind: 'config',
        target: configPath,
        action: 'kept',
        reason: 'otros elementos se conservaron y una purga posterior lo necesita',
      });
    } else {
      items.push({ kind: 'config', target: configPath, action: 'absent' });
    }
    return ok({ items });
  }
  try {
    await fs.unlink(configPath);
    items.push({ kind: 'config', target: configPath, action: 'removed' });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      items.push({ kind: 'config', target: configPath, action: 'absent' });
    } else {
      return err({ message: `no pude borrar ${configPath}: ${errorMessage(error)}`, cause: error });
    }
  }
  return ok({ items });
};
