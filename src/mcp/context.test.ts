import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { err } from '../core/result.js';
import { unwrap, unwrapErr } from '../core/result.test-support.js';
import { runCommand, type CommandRunner } from '../engine/exec.js';
import { normalizeRepoPath } from '../engine/git.js';
import { buildConfig, createTempRepo, type TempRepo } from '../engine/git.test-support.js';
import { resolveMcpContext } from './context.js';
import { setupMcpRepo } from './mcp.test-support.js';

// Force `git worktree list` to fail so the not-a-repo branch is exercised
// deterministically: on a dev machine the OS temp dir is often nested under some
// git repo, so git resolves UPWARD and a bare temp path is not reliably outside
// a repository (loadContext has the same limitation).
const failWorktreeList: CommandRunner = (command, args, opts) =>
  command === 'git' && args[0] === 'worktree' && args[1] === 'list'
    ? Promise.resolve(
        err({ kind: 'non-zero-exit', output: { stdout: '', stderr: 'not a git repo', exitCode: 128 } }),
      )
    : runCommand(command, args, opts);

describe('resolveMcpContext', () => {
  let mcp: Awaited<ReturnType<typeof setupMcpRepo>>;

  beforeEach(async () => {
    mcp = await setupMcpRepo(buildConfig({ integrationBranch: 'develop' }));
  });

  afterEach(async () => {
    await mcp.repo.cleanup();
  });

  it('resolves the SHARED root (not the worktree) from inside a session worktree', async () => {
    const ctx = unwrap(await resolveMcpContext(mcp.worktreePath('s1')));
    // The shared root is the main worktree, never the .worktrees/s1 checkout the
    // server was launched inside.
    expect(ctx.sharedRoot).toBe(normalizeRepoPath(mcp.repo.root));
    expect(ctx.sharedRoot).not.toContain('.worktrees/s1');
  });

  it('reads the config and board dir anchored at the shared root', async () => {
    const ctx = unwrap(await resolveMcpContext(mcp.worktreePath('s2')));
    expect(ctx.config.project.name).toBe('demo');
    expect(normalizeRepoPath(ctx.boardDir)).toBe(
      normalizeRepoPath(path.join(mcp.repo.root, '.review-board')),
    );
  });

  it('sets currentSession to the session whose worktree contains cwd', async () => {
    const ctx = unwrap(await resolveMcpContext(mcp.worktreePath('s1')));
    expect(ctx.currentSession?.id).toBe('s1');

    const other = unwrap(await resolveMcpContext(mcp.worktreePath('s2')));
    expect(other.currentSession?.id).toBe('s2');
  });

  it('resolves currentSession from a subdirectory nested under the worktree', async () => {
    const nested = path.join(mcp.worktreePath('s1'), 'src', 'deep');
    await fs.mkdir(nested, { recursive: true });
    const ctx = unwrap(await resolveMcpContext(nested));
    expect(ctx.currentSession?.id).toBe('s1');
  });

  it('leaves currentSession undefined when run from the main root', async () => {
    const ctx = unwrap(await resolveMcpContext(mcp.repo.root));
    expect(ctx.sharedRoot).toBe(normalizeRepoPath(mcp.repo.root));
    expect(ctx.currentSession).toBeUndefined();
  });
});

describe('resolveMcpContext errors', () => {
  let repo: TempRepo;

  beforeEach(async () => {
    repo = await createTempRepo();
  });

  afterEach(async () => {
    await repo.cleanup();
  });

  it('reports config-not-found when there is no agents.config.json', async () => {
    const error = unwrapErr(await resolveMcpContext(repo.root));
    expect(error.kind).toBe('config-not-found');
  });

  it('reports not-a-repo when the worktree listing fails', async () => {
    const error = unwrapErr(await resolveMcpContext(repo.root, failWorktreeList, failWorktreeList));
    expect(error.kind).toBe('not-a-repo');
  });
});
