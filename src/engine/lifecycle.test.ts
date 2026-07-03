import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgentsConfig } from '../contract/schema.js';
import { err } from '../core/result.js';
import { unwrap, unwrapErr } from '../core/result.test-support.js';
import { readAgentsConfig } from './config-io.js';
import { runCommand, type CommandRunner } from './exec.js';
import { createGit } from './git.js';
import { buildConfig, createTempRepo, runGitOrThrow, type TempRepo } from './git.test-support.js';
import { finishSession, nextRotatedBranch } from './lifecycle.js';

describe('nextRotatedBranch', () => {
  it('replaces the -inicial suffix with -2', () => {
    expect(nextRotatedBranch('feat/s1-inicial')).toBe('feat/s1-2');
  });

  it('increments a trailing number', () => {
    expect(nextRotatedBranch('feat/s1-2')).toBe('feat/s1-3');
    expect(nextRotatedBranch('feat/s1-10')).toBe('feat/s1-11');
  });

  it('appends -2 when there is no rotation suffix', () => {
    expect(nextRotatedBranch('feat/s1')).toBe('feat/s1-2');
  });
});

// Passthrough runner that forces a single git subcommand to fail, so error
// branches that no filesystem state can reach are still exercised.
const forceNonZero = (): ReturnType<CommandRunner> =>
  Promise.resolve(
    err({ kind: 'non-zero-exit', output: { stdout: '', stderr: 'forced failure', exitCode: 1 } }),
  );

const failSwitchTo =
  (branch: string): CommandRunner =>
  (command, args, opts) =>
    command === 'git' && args[0] === 'switch' && args[args.length - 1] === branch
      ? forceNonZero()
      : runCommand(command, args, opts);

const failDeleteBranch: CommandRunner = (command, args, opts) =>
  command === 'git' && args[0] === 'branch' && args[1] === '-D'
    ? forceNonZero()
    : runCommand(command, args, opts);

describe('finishSession (integration)', () => {
  let repo: TempRepo;

  beforeEach(async () => {
    repo = await createTempRepo();
  });

  afterEach(async () => {
    await repo.cleanup();
  });

  // develop + s1's session branch checked out in a worktree with one commit,
  // matching buildConfig()'s s1 (feat/s1-inicial @ .worktrees/s1).
  const setupSession = async (): Promise<{ config: AgentsConfig; wtPath: string }> => {
    const config = buildConfig();
    const repoGit = createGit(repo.root);
    unwrap(await repoGit.createBranch('develop', 'main'));
    unwrap(await repoGit.createBranch('feat/s1-inicial', 'develop'));
    const wtPath = path.join(repo.root, '.worktrees', 's1');
    unwrap(await repoGit.addWorktree(wtPath, 'feat/s1-inicial'));
    await fs.writeFile(path.join(wtPath, 'feature.txt'), 'session work\n');
    await runGitOrThrow(wtPath, ['add', 'feature.txt']);
    await runGitOrThrow(wtPath, ['commit', '-m', 'feat: session work']);
    return { config, wtPath };
  };

  // A divergent add/add on develop so merging the session branch conflicts. The
  // develop-side commit is made through a throwaway worktree that is removed, so
  // develop is free for finishSession to check out afterwards.
  const setupConflict = async (): Promise<{ config: AgentsConfig; wtPath: string }> => {
    const config = buildConfig();
    const repoGit = createGit(repo.root);
    unwrap(await repoGit.createBranch('develop', 'main'));
    unwrap(await repoGit.createBranch('feat/s1-inicial', 'develop'));
    const wtPath = path.join(repo.root, '.worktrees', 's1');
    unwrap(await repoGit.addWorktree(wtPath, 'feat/s1-inicial'));
    await fs.writeFile(path.join(wtPath, 'conflict.txt'), 'from session\n');
    await runGitOrThrow(wtPath, ['add', 'conflict.txt']);
    await runGitOrThrow(wtPath, ['commit', '-m', 'feat: session side']);
    const devWt = path.join(repo.root, 'devwt');
    unwrap(await repoGit.addWorktree(devWt, 'develop'));
    await fs.writeFile(path.join(devWt, 'conflict.txt'), 'from develop\n');
    await runGitOrThrow(devWt, ['add', 'conflict.txt']);
    await runGitOrThrow(devWt, ['commit', '-m', 'chore: develop side']);
    await runGitOrThrow(repo.root, ['worktree', 'remove', '--force', devWt]);
    return { config, wtPath };
  };

  it('merges into develop, rotates the worktree, deletes the old branch, and updates the config', async () => {
    const { config, wtPath } = await setupSession();
    const result = unwrap(await finishSession({ config, projectRoot: repo.root, sessionId: 's1' }));
    expect(result).toEqual({
      sessionId: 's1',
      worktree: '.worktrees/s1',
      oldBranch: 'feat/s1-inicial',
      newBranch: 'feat/s1-2',
      integrationBranch: 'develop',
      oldBranchDeleted: true,
    });

    const repoGit = createGit(repo.root);
    expect(unwrap(await repoGit.branchExists('feat/s1-inicial'))).toBe(false);
    expect(unwrap(await createGit(wtPath).currentBranch())).toBe('feat/s1-2');

    const log = unwrap(await runCommand('git', ['log', '--pretty=%s', 'develop'], { cwd: repo.root }));
    expect(log.stdout).toContain('Merge feat/s1-inicial into develop');

    const persisted = unwrap(await readAgentsConfig(repo.root));
    expect(persisted.sessions.find((session) => session.id === 's1')?.branch).toBe('feat/s1-2');
  });

  it('restores the worktree to the old branch on a merge conflict', async () => {
    const { config, wtPath } = await setupConflict();
    const repoGit = createGit(repo.root);
    const error = unwrapErr(await finishSession({ config, projectRoot: repo.root, sessionId: 's1' }));
    expect(error.kind).toBe('merge-conflict');
    expect(unwrap(await createGit(wtPath).currentBranch())).toBe('feat/s1-inicial');
    expect(unwrap(await repoGit.branchExists('feat/s1-inicial'))).toBe(true);
    expect(unwrap(await createGit(wtPath).statusPorcelain())).toBe('');
  });

  it('reports recovery-failed when the worktree cannot be restored after a conflict', async () => {
    const { config } = await setupConflict();
    const repoGit = createGit(repo.root);
    // Force the restore switch back to the old branch to fail.
    const error = unwrapErr(
      await finishSession({
        config,
        projectRoot: repo.root,
        sessionId: 's1',
        run: failSwitchTo('feat/s1-inicial'),
      }),
    );
    expect(error.kind).toBe('recovery-failed');
    // Nothing irreversible happened: the old branch is intact.
    expect(unwrap(await repoGit.branchExists('feat/s1-inicial'))).toBe(true);
    expect(unwrap(await repoGit.branchExists('feat/s1-2'))).toBe(false);
  });

  it('rejects an unknown session', async () => {
    const config = buildConfig();
    const error = unwrapErr(await finishSession({ config, projectRoot: repo.root, sessionId: 's9' }));
    expect(error.kind).toBe('unknown-session');
  });

  it('refuses to rotate a dirty worktree', async () => {
    const { config, wtPath } = await setupSession();
    await fs.writeFile(path.join(wtPath, 'uncommitted.txt'), 'wip\n');
    const error = unwrapErr(await finishSession({ config, projectRoot: repo.root, sessionId: 's1' }));
    expect(error.kind).toBe('dirty-worktree');
  });

  it('refuses when the rotated target branch already exists', async () => {
    const { config } = await setupSession();
    unwrap(await createGit(repo.root).createBranch('feat/s1-2', 'develop'));
    const error = unwrapErr(await finishSession({ config, projectRoot: repo.root, sessionId: 's1' }));
    expect(error.kind).toBe('branch-exists');
  });

  it('refuses when the worktree is not on the session branch', async () => {
    const { config, wtPath } = await setupSession();
    // Move the worktree off feat/s1-inicial onto an unrelated branch.
    unwrap(await createGit(wtPath).switchNewBranch('feat/detour', 'feat/s1-inicial'));
    const error = unwrapErr(await finishSession({ config, projectRoot: repo.root, sessionId: 's1' }));
    expect(error.kind).toBe('worktree-not-on-branch');
  });

  it('rejects an explicit rotation onto the integration branch', async () => {
    const { config } = await setupSession();
    const error = unwrapErr(
      await finishSession({ config, projectRoot: repo.root, sessionId: 's1', newBranch: 'develop' }),
    );
    expect(error.kind).toBe('invalid-rotation');
  });

  it('reports integration-busy and leaves the session untouched when develop is checked out elsewhere', async () => {
    const { config, wtPath } = await setupSession();
    const repoGit = createGit(repo.root);
    // A second worktree holding develop makes the switch onto it fail.
    unwrap(await repoGit.addWorktree(path.join(repo.root, 'busy'), 'develop'));
    const error = unwrapErr(await finishSession({ config, projectRoot: repo.root, sessionId: 's1' }));
    expect(error.kind).toBe('integration-busy');
    expect(unwrap(await createGit(wtPath).currentBranch())).toBe('feat/s1-inicial');
    expect(unwrap(await repoGit.branchExists('feat/s1-inicial'))).toBe(true);
    expect(unwrap(await repoGit.branchExists('feat/s1-2'))).toBe(false);
  });

  it('reports config-write-failed after the git rotation, leaving the old branch intact', async () => {
    const { config, wtPath } = await setupSession();
    // A directory where the config file goes makes the atomic write fail.
    await fs.mkdir(path.join(repo.root, 'agents.config.json'));
    const error = unwrapErr(await finishSession({ config, projectRoot: repo.root, sessionId: 's1' }));
    expect(error.kind).toBe('config-write-failed');
    // Git already advanced: worktree on the new branch, old branch NOT deleted.
    expect(unwrap(await createGit(wtPath).currentBranch())).toBe('feat/s1-2');
    expect(unwrap(await createGit(repo.root).branchExists('feat/s1-inicial'))).toBe(true);
  });

  it('succeeds with a warning when the old branch cannot be deleted', async () => {
    const { config, wtPath } = await setupSession();
    const result = unwrap(
      await finishSession({ config, projectRoot: repo.root, sessionId: 's1', run: failDeleteBranch }),
    );
    expect(result.oldBranchDeleted).toBe(false);
    expect(result.warning).toContain('feat/s1-inicial');
    // The rotation still landed: worktree on newBranch, config updated, old kept.
    expect(unwrap(await createGit(wtPath).currentBranch())).toBe('feat/s1-2');
    expect(unwrap(await createGit(repo.root).branchExists('feat/s1-inicial'))).toBe(true);
    const persisted = unwrap(await readAgentsConfig(repo.root));
    expect(persisted.sessions.find((session) => session.id === 's1')?.branch).toBe('feat/s1-2');
  });
});
