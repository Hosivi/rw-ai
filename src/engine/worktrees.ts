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

// The removal vocabulary shared by both ignore-surface cleanups: 'cleaned' means
// rw's lines were filtered out of the file, 'absent' means neither the file nor
// the lines were there — either way the file itself is never deleted (a
// .gitignore may be tracked; deleting it would touch user work).
export type IgnoreCleanupResult = {
  readonly action: 'cleaned' | 'absent';
};

// Shared line-filter for both cleanups: drop every line whose trimmed form is in
// `owned`, preserving all other lines byte-identically. Returns null when no
// owned line is present, so callers can report 'absent' without a rewrite.
const filterOwnedLines = (content: string, owned: ReadonlySet<string>): string | null => {
  const lines = content.split(/\r?\n/);
  const kept = lines.filter((line) => !owned.has(line.trim()));
  if (kept.length === lines.length) {
    return null;
  }
  // Rewrite with LF endings and a single trailing newline, mirroring the ensure
  // writers. A file left with no lines becomes empty ('') but stays on disk.
  while (kept.at(-1) === '') {
    kept.pop();
  }
  return kept.length === 0 ? '' : `${kept.join('\n')}\n`;
};

// Applies filterOwnedLines to a file on disk: ENOENT and no-owned-line are both
// the successful 'absent' no-op (cleanup never creates or deletes files).
const cleanOwnedLines = async (
  filePath: string,
  owned: ReadonlySet<string>,
): Promise<Result<IgnoreCleanupResult, GitignoreEnsureError>> => {
  let content: string;
  try {
    content = await fs.readFile(filePath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return ok({ action: 'absent' });
    }
    return err({ message: `could not read ${filePath}: ${errorMessage(error)}`, cause: error });
  }
  const next = filterOwnedLines(content, owned);
  if (next === null) {
    return ok({ action: 'absent' });
  }
  try {
    await fs.writeFile(filePath, next, 'utf8');
  } catch (error) {
    return err({ message: `could not write ${filePath}: ${errorMessage(error)}`, cause: error });
  }
  return ok({ action: 'cleaned' });
};

// The inverse of ensureGitignoreEntry: remove ONLY the canonical `/dir/` line rw
// writes. The laxer `dir/` variant that ensure ACCEPTS but never writes is user
// content and survives, as does everything else in the file.
export const removeGitignoreEntry = (
  projectRoot: string,
  worktreesDir: string,
): Promise<Result<IgnoreCleanupResult, GitignoreEnsureError>> =>
  cleanOwnedLines(path.join(projectRoot, '.gitignore'), new Set([`/${worktreesDir}/`]));

// The inverse of ensureExcludeEntries: remove exactly the given patterns from the
// shared info/exclude, preserving git's stock comments and any user patterns.
export const removeExcludeEntries = (
  gitCommonDir: string,
  patterns: readonly string[],
): Promise<Result<IgnoreCleanupResult, GitignoreEnsureError>> =>
  cleanOwnedLines(path.join(gitCommonDir, 'info', 'exclude'), new Set(patterns));

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
