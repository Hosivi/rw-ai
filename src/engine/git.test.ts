import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { unwrap, unwrapErr } from '../core/result.test-support.js';
import {
  createGit,
  MIN_GIT_VERSION,
  normalizeRepoPath,
  parseGitVersion,
  parseWorktreeList,
  supportsMergeTree,
} from './git.js';
import { createTempRepo, type TempRepo } from './git.test-support.js';

describe('parseGitVersion', () => {
  it('parses a plain version', () => {
    expect(unwrap(parseGitVersion('git version 2.51.0'))).toEqual({
      major: 2,
      minor: 51,
      patch: 0,
      raw: 'git version 2.51.0',
    });
  });

  it('parses the Git for Windows distributor suffix', () => {
    expect(unwrap(parseGitVersion('git version 2.51.0.windows.1'))).toMatchObject({
      major: 2,
      minor: 51,
      patch: 0,
      raw: 'git version 2.51.0.windows.1',
    });
  });

  it('parses the Apple distributor suffix', () => {
    expect(unwrap(parseGitVersion('git version 2.39.3 (Apple Git-146)'))).toMatchObject({
      major: 2,
      minor: 39,
      patch: 3,
    });
  });

  it('rejects unrecognized output', () => {
    expect(unwrapErr(parseGitVersion('definitely not git')).kind).toBe('parse-failed');
  });
});

describe('supportsMergeTree', () => {
  it.each([
    [{ major: 2, minor: 38 }, true],
    [{ major: 2, minor: 51 }, true],
    [{ major: 3, minor: 0 }, true],
    [{ major: 2, minor: 37 }, false],
    [{ major: 1, minor: 99 }, false],
  ])('%o -> %s', (version, expected) => {
    expect(supportsMergeTree(version)).toBe(expected);
  });

  it('accepts MIN_GIT_VERSION itself at the boundary', () => {
    expect(supportsMergeTree(MIN_GIT_VERSION)).toBe(true);
  });
});

describe('normalizeRepoPath', () => {
  it('converts backslashes and lowercases the drive letter', () => {
    expect(normalizeRepoPath('E:\\repos\\rw-ai')).toBe('e:/repos/rw-ai');
  });

  it('leaves posix paths untouched', () => {
    expect(normalizeRepoPath('/home/dev/rw-ai')).toBe('/home/dev/rw-ai');
  });
});

describe('parseWorktreeList', () => {
  it('parses attached and detached entries', () => {
    const stdout = [
      'worktree C:/repo',
      'HEAD 1111111111111111111111111111111111111111',
      'branch refs/heads/main',
      '',
      'worktree C:/repo/.worktrees/s1',
      'HEAD 2222222222222222222222222222222222222222',
      'detached',
      '',
    ].join('\n');
    expect(parseWorktreeList(stdout)).toEqual([
      {
        path: 'c:/repo',
        head: '1111111111111111111111111111111111111111',
        branch: 'main',
      },
      {
        path: 'c:/repo/.worktrees/s1',
        head: '2222222222222222222222222222222222222222',
      },
    ]);
  });

  it('returns an empty list for empty output', () => {
    expect(parseWorktreeList('')).toEqual([]);
  });
});

describe('createGit (integration)', () => {
  let repo: TempRepo;

  beforeEach(async () => {
    repo = await createTempRepo();
  });

  afterEach(async () => {
    await repo.cleanup();
  });

  it('reports a parseable git version', async () => {
    const git = createGit(repo.root);
    const version = unwrap(await git.version());
    expect(version.major).toBeGreaterThanOrEqual(2);
    expect(version.raw).toContain('git version');
  });

  it('resolves toplevel to the normalized repo root', async () => {
    const git = createGit(repo.root);
    expect(unwrap(await git.toplevel())).toBe(normalizeRepoPath(repo.root));
  });

  it('creates branches without switching the working copy', async () => {
    const git = createGit(repo.root);
    expect(unwrap(await git.branchExists('feature-x'))).toBe(false);
    unwrap(await git.createBranch('feature-x', 'main'));
    expect(unwrap(await git.branchExists('feature-x'))).toBe(true);
    expect(unwrap(await git.currentBranch())).toBe('main');
  });

  it('lists added worktrees with normalized paths', async () => {
    const git = createGit(repo.root);
    unwrap(await git.createBranch('feature-x', 'main'));
    const worktreePath = path.join(repo.root, 'wt-a');
    unwrap(await git.addWorktree(worktreePath, 'feature-x'));
    const worktrees = unwrap(await git.listWorktrees());
    expect(worktrees).toHaveLength(2);
    expect(worktrees[0]).toMatchObject({ path: normalizeRepoPath(repo.root), branch: 'main' });
    expect(worktrees[1]).toMatchObject({
      path: normalizeRepoPath(worktreePath),
      branch: 'feature-x',
    });
    expect(worktrees[1]?.head).toMatch(/^[0-9a-f]{40}$/);
  });
});
