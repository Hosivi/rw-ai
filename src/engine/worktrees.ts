import fs from 'node:fs/promises';
import path from 'node:path';
import type { AgentsConfig, Stack } from '../contract/schema.js';
import { assertNever } from '../core/assert.js';
import { err, ok, type Result } from '../core/result.js';
import type { EnsureAction } from './branches.js';
import { runCommand, type CommandRunner } from './exec.js';
import { normalizeRepoPath, type Git } from './git.js';
import { activeSessions, type SessionOperationError } from './sessions.js';

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export type WorktreeEnsureResult = {
  readonly sessionId: string;
  readonly path: string;
  readonly action: EnsureAction;
};

export const ensureWorktrees = async (
  git: Git,
  config: AgentsConfig,
  projectRoot: string,
): Promise<Result<WorktreeEnsureResult[], SessionOperationError>> => {
  const listed = await git.listWorktrees();
  if (!listed.ok) {
    return err({ message: 'could not list existing worktrees', cause: listed.error });
  }
  const existing = new Set(listed.value.map((worktree) => worktree.path));
  const results: WorktreeEnsureResult[] = [];
  for (const session of activeSessions(config)) {
    const worktreePath = path.join(projectRoot, session.worktree);
    if (existing.has(normalizeRepoPath(worktreePath))) {
      results.push({ sessionId: session.id, path: worktreePath, action: 'exists' });
      continue;
    }
    const added = await git.addWorktree(worktreePath, session.branch);
    if (!added.ok) {
      return err({
        message: `could not add worktree for session ${session.id} at ${worktreePath}`,
        sessionId: session.id,
        cause: added.error,
      });
    }
    results.push({ sessionId: session.id, path: worktreePath, action: 'created' });
  }
  return ok(results);
};

export type GitignoreEnsureResult = {
  // Own vocabulary, not EnsureAction: 'created-file' (no .gitignore existed at
  // all) is a genuinely distinct third state from adding a line to one.
  readonly action: 'added' | 'exists' | 'created-file';
};

export type GitignoreEnsureError = {
  readonly message: string;
  readonly cause?: unknown;
};

// Without this gitignore line the main checkout sees every worktree file as
// untracked AND turbo/watchers (which respect gitignore) would traverse N
// full checkouts.
export const ensureGitignoreEntry = async (
  projectRoot: string,
  worktreesDir: string,
): Promise<Result<GitignoreEnsureResult, GitignoreEnsureError>> => {
  const gitignorePath = path.join(projectRoot, '.gitignore');
  const canonicalLine = `/${worktreesDir}/`;
  // A pre-existing entry without the leading slash anchors less strictly but
  // still ignores the directory, so it satisfies the requirement untouched.
  const satisfyingLines = new Set([canonicalLine, `${worktreesDir}/`]);
  let content: string | null = null;
  try {
    content = await fs.readFile(gitignorePath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      return err({ message: `could not read ${gitignorePath}: ${errorMessage(error)}`, cause: error });
    }
  }
  try {
    if (content === null) {
      await fs.writeFile(gitignorePath, `${canonicalLine}\n`, 'utf8');
      return ok({ action: 'created-file' });
    }
    const lines = content.split(/\r?\n/);
    if (lines.some((line) => satisfyingLines.has(line.trim()))) {
      return ok({ action: 'exists' });
    }
    // Rewrite with LF endings and a single trailing newline; every non-empty
    // existing line is preserved as-is.
    while (lines.at(-1) === '') {
      lines.pop();
    }
    await fs.writeFile(gitignorePath, `${[...lines, canonicalLine].join('\n')}\n`, 'utf8');
    return ok({ action: 'added' });
  } catch (error) {
    return err({ message: `could not write ${gitignorePath}: ${errorMessage(error)}`, cause: error });
  }
};

export type ExcludeEnsureResult = {
  readonly added: string[];
  // 'created' (no info/exclude existed), 'updated' (appended some patterns),
  // 'exists' (all patterns already present — no write).
  readonly action: 'created' | 'updated' | 'exists';
};

// rw's generated session artifacts (.env.local, node_modules/) live INSIDE each
// linked worktree, so a .gitignore in the main checkout cannot hide them and
// committing an ignore into a session branch would pollute it. The shared
// info/exclude of the common git dir is honoured by EVERY worktree, is never
// committed, and touches no branch — one write covers them all. Mirrors
// ensureGitignoreEntry's read/normalize/dedupe/append shape.
export const ensureExcludeEntries = async (
  gitCommonDir: string,
  patterns: readonly string[],
): Promise<Result<ExcludeEnsureResult, GitignoreEnsureError>> => {
  const excludePath = path.join(gitCommonDir, 'info', 'exclude');
  let content: string | null = null;
  try {
    content = await fs.readFile(excludePath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      return err({ message: `could not read ${excludePath}: ${errorMessage(error)}`, cause: error });
    }
  }
  try {
    // info/ almost always exists, but a degraded/freshly-cloned repo may lack
    // it; create it defensively so the write is self-contained.
    await fs.mkdir(path.dirname(excludePath), { recursive: true });
    if (content === null) {
      await fs.writeFile(excludePath, `${patterns.join('\n')}\n`, 'utf8');
      return ok({ added: [...patterns], action: 'created' });
    }
    const lines = content.split(/\r?\n/);
    // Canonical compare against trimmed existing lines (git's own exclude may
    // carry CRLF or padding); only genuinely-absent patterns are appended.
    const present = new Set(lines.map((line) => line.trim()));
    const added = patterns.filter((pattern) => !present.has(pattern));
    if (added.length === 0) {
      return ok({ added: [], action: 'exists' });
    }
    // Rewrite with LF endings and a single trailing newline; every non-empty
    // existing line is preserved as-is.
    while (lines.at(-1) === '') {
      lines.pop();
    }
    await fs.writeFile(excludePath, `${[...lines, ...added].join('\n')}\n`, 'utf8');
    return ok({ added, action: 'updated' });
  } catch (error) {
    return err({ message: `could not write ${excludePath}: ${errorMessage(error)}`, cause: error });
  }
};

export type DepsInstallResult = {
  readonly stack: Stack;
  readonly action: 'installed' | 'skipped';
  readonly reason?: string;
};

export type DepsInstallError = {
  readonly message: string;
  readonly stack: Stack;
  readonly cause?: unknown;
};

const pathExists = async (target: string): Promise<boolean> => {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
};

// Each worktree is a full checkout with its own node_modules — without an
// install nothing runs there; pnpm's content-addressable store makes the
// extra copies cheap. Exported on its own (not folded into ensureWorktrees)
// so the configurator can offer to skip it.
export const installWorktreeDeps = async (
  worktreePath: string,
  stacks: readonly Stack[],
  run: CommandRunner = runCommand,
): Promise<Result<DepsInstallResult[], DepsInstallError>> => {
  const results: DepsInstallResult[] = [];
  for (const stack of stacks) {
    if (stack === 'android') {
      results.push({ stack, action: 'skipped', reason: 'gradle syncs on build' });
      continue;
    }
    if (stack === 'node') {
      if (!(await pathExists(path.join(worktreePath, 'package.json')))) {
        results.push({ stack, action: 'skipped', reason: 'no package.json' });
        continue;
      }
      const ran = await run('pnpm', ['install'], { cwd: worktreePath });
      if (!ran.ok) {
        return err({ message: `pnpm install failed in ${worktreePath}`, stack, cause: ran.error });
      }
      results.push({ stack, action: 'installed' });
      continue;
    }
    if (stack === 'dotnet') {
      // Only the top level is scanned — a recursive walk would descend into
      // node_modules on mixed-stack worktrees.
      let entries: string[];
      try {
        entries = await fs.readdir(worktreePath);
      } catch (error) {
        return err({
          message: `could not scan ${worktreePath}: ${errorMessage(error)}`,
          stack,
          cause: error,
        });
      }
      if (!entries.some((name) => name.endsWith('.sln') || name.endsWith('.csproj'))) {
        results.push({ stack, action: 'skipped', reason: 'no *.sln or *.csproj at top level' });
        continue;
      }
      const ran = await run('dotnet', ['restore'], { cwd: worktreePath });
      if (!ran.ok) {
        return err({
          message: `dotnet restore failed in ${worktreePath}`,
          stack,
          cause: ran.error,
        });
      }
      results.push({ stack, action: 'installed' });
      continue;
    }
    assertNever(stack);
  }
  return ok(results);
};
