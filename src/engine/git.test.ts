import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { unwrap, unwrapErr } from '../core/result.test-support.js';
import { runCommand } from './exec.js';
import {
  createGit,
  MIN_GIT_VERSION,
  normalizeRepoPath,
  parseGitVersion,
  parseWorktreeList,
  supportsMergeTree,
} from './git.js';
import { createTempRepo, runGitOrThrow, type TempRepo } from './git.test-support.js';

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

describe('createGit branch and merge operations (integration)', () => {
  let repo: TempRepo;

  beforeEach(async () => {
    repo = await createTempRepo();
  });

  afterEach(async () => {
    await repo.cleanup();
  });

  it('switchNewBranch creates and checks out a branch in a worktree', async () => {
    const repoGit = createGit(repo.root);
    unwrap(await repoGit.createBranch('develop', 'main'));
    const wtPath = path.join(repo.root, 'wt');
    unwrap(await repoGit.addWorktree(wtPath, 'develop'));
    const wtGit = createGit(wtPath);
    unwrap(await wtGit.switchNewBranch('feat/x', 'develop'));
    expect(unwrap(await wtGit.currentBranch())).toBe('feat/x');
  });

  it('switchBranch moves an existing worktree HEAD to another branch', async () => {
    const repoGit = createGit(repo.root);
    unwrap(await repoGit.createBranch('develop', 'main'));
    unwrap(await repoGit.createBranch('feat/y', 'develop'));
    const wtPath = path.join(repo.root, 'wt');
    unwrap(await repoGit.addWorktree(wtPath, 'feat/y'));
    const wtGit = createGit(wtPath);
    unwrap(await wtGit.switchBranch('develop'));
    expect(unwrap(await wtGit.currentBranch())).toBe('develop');
  });

  it('statusPorcelain is empty on a clean tree and non-empty when dirty', async () => {
    const git = createGit(repo.root);
    expect(unwrap(await git.statusPorcelain())).toBe('');
    await fs.writeFile(path.join(repo.root, 'dirty.txt'), 'x\n');
    expect(unwrap(await git.statusPorcelain())).not.toBe('');
  });

  it('mergeNoFf merges cleanly and reports merged with the given message', async () => {
    const repoGit = createGit(repo.root);
    unwrap(await repoGit.createBranch('develop', 'main'));
    unwrap(await repoGit.createBranch('feat/z', 'develop'));
    const wtPath = path.join(repo.root, 'wt');
    unwrap(await repoGit.addWorktree(wtPath, 'feat/z'));
    await fs.writeFile(path.join(wtPath, 'z.txt'), 'z\n');
    await runGitOrThrow(wtPath, ['add', 'z.txt']);
    await runGitOrThrow(wtPath, ['commit', '-m', 'feat: z']);
    const wtGit = createGit(wtPath);
    unwrap(await wtGit.switchBranch('develop'));
    expect(unwrap(await wtGit.mergeNoFf('feat/z', 'Merge feat/z into develop')).status).toBe('merged');
    const log = unwrap(await runCommand('git', ['log', '--pretty=%s', 'develop'], { cwd: repo.root }));
    expect(log.stdout).toContain('Merge feat/z into develop');
  });

  it('mergeNoFf reports conflict and mergeAbort restores a clean tree', async () => {
    const repoGit = createGit(repo.root);
    unwrap(await repoGit.createBranch('develop', 'main'));
    unwrap(await repoGit.createBranch('feat/c', 'develop'));
    const wtPath = path.join(repo.root, 'wt');
    unwrap(await repoGit.addWorktree(wtPath, 'feat/c'));
    await fs.writeFile(path.join(wtPath, 'conflict.txt'), 'from feat\n');
    await runGitOrThrow(wtPath, ['add', 'conflict.txt']);
    await runGitOrThrow(wtPath, ['commit', '-m', 'feat: c side']);
    // A divergent add/add on develop, via a throwaway worktree.
    const devWt = path.join(repo.root, 'devwt');
    unwrap(await repoGit.addWorktree(devWt, 'develop'));
    await fs.writeFile(path.join(devWt, 'conflict.txt'), 'from develop\n');
    await runGitOrThrow(devWt, ['add', 'conflict.txt']);
    await runGitOrThrow(devWt, ['commit', '-m', 'chore: develop side']);
    await runGitOrThrow(repo.root, ['worktree', 'remove', '--force', devWt]);

    const wtGit = createGit(wtPath);
    unwrap(await wtGit.switchBranch('develop'));
    expect(unwrap(await wtGit.mergeNoFf('feat/c')).status).toBe('conflict');
    unwrap(await wtGit.mergeAbort());
    expect(unwrap(await wtGit.statusPorcelain())).toBe('');
  });

  it('deleteBranch force-removes a branch ref', async () => {
    const git = createGit(repo.root);
    unwrap(await git.createBranch('scratch', 'main'));
    expect(unwrap(await git.branchExists('scratch'))).toBe(true);
    unwrap(await git.deleteBranch('scratch'));
    expect(unwrap(await git.branchExists('scratch'))).toBe(false);
  });

  it('mergeNoFf returns an error (not conflict) on a genuine merge failure', async () => {
    // Unrelated histories exit 128, not 1 — the exit-code contract must map that
    // to an error, never a conflict. (A conflict and a bad-ref both exit 1, so
    // exit code alone cannot tell them apart; this asserts the non-1 branch.)
    //
    // An orphan branch with a distinct file gives a root commit whose tree — and
    // therefore SHA — cannot match main's, so the two histories share no common
    // ancestor DETERMINISTICALLY. (Building the unrelated side in a second temp
    // repo is flaky: createTempRepo makes an identical root commit, so if both
    // repos are created within git's 1-second timestamp granularity the roots
    // collide into the same SHA and the merge fast-forwards instead of failing.)
    const git = createGit(repo.root);
    await runGitOrThrow(repo.root, ['checkout', '--orphan', 'unrelated']);
    await fs.writeFile(path.join(repo.root, 'unrelated.txt'), 'unrelated root\n');
    await runGitOrThrow(repo.root, ['add', 'unrelated.txt']);
    await runGitOrThrow(repo.root, ['commit', '-m', 'root: unrelated history']);
    await runGitOrThrow(repo.root, ['checkout', 'main']);
    const merged = await git.mergeNoFf('unrelated');
    expect(merged.ok).toBe(false);
    if (!merged.ok) {
      expect(merged.error.kind).toBe('non-zero-exit');
    }
  });
});
