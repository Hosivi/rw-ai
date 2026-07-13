import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgentsConfig } from '../contract/schema.js';
import { unwrap } from '../core/result.test-support.js';
import { writeAgentsConfig } from './config-io.js';
import { createGit } from './git.js';
import {
  buildConfig,
  createTempRepo,
  runGitOrThrow,
  type TempRepo,
} from './git.test-support.js';
import { purgeProvisioning, type PurgeItem } from './purge.js';
import { ensureExcludeEntries, ensureGitignoreEntry } from './worktrees.js';

// Provisions the temp repo the way `rw configure` would: config file, integration
// + session branches, one worktree per session, a board dir with a claims file,
// and the two ignore surfaces rw owns (.gitignore line + info/exclude patterns).
// Built from the SAME ensure* functions purge inverts, so the fixture cannot
// drift from what the provisioner actually writes.
const provision = async (root: string, config: AgentsConfig): Promise<string> => {
  await writeAgentsConfig(root, config);
  await runGitOrThrow(root, ['branch', config.git.integrationBranch, config.git.baseBranch]);
  for (const session of config.sessions) {
    await runGitOrThrow(root, ['branch', session.branch, config.git.integrationBranch]);
    await runGitOrThrow(root, ['worktree', 'add', session.worktree, session.branch]);
  }
  const boardDir = path.join(root, config.board.dir);
  await fs.mkdir(path.join(boardDir, 'data'), { recursive: true });
  await fs.writeFile(path.join(boardDir, 'claims.json'), '{}\n', 'utf8');
  unwrap(await ensureGitignoreEntry(root, config.git.worktreesDir));
  const commonDir = unwrap(await createGit(root).commonDir());
  unwrap(await ensureExcludeEntries(commonDir, ['.env.local', 'node_modules/']));
  return commonDir;
};

const keptItems = (items: readonly PurgeItem[]): PurgeItem[] =>
  items.filter((item) => item.action === 'kept');

describe('purgeProvisioning', () => {
  let repo: TempRepo;
  let config: AgentsConfig;

  beforeEach(async () => {
    repo = await createTempRepo();
    config = buildConfig();
  }, 60000);

  afterEach(async () => {
    await repo.cleanup();
  });

  it('removes worktrees, branches, board, config and rw ignore lines on a clean repo', async () => {
    // A user-owned .gitignore line that must survive the purge untouched.
    await fs.writeFile(path.join(repo.root, '.gitignore'), 'dist/\n', 'utf8');
    const commonDir = await provision(repo.root, config);
    // A user-owned exclude pattern next to rw's.
    unwrap(await ensureExcludeEntries(commonDir, ['user-secret.txt']));

    const result = unwrap(await purgeProvisioning(repo.root, config));
    expect(keptItems(result.items)).toEqual([]);

    // Worktrees (and their container dir) are gone.
    for (const session of config.sessions) {
      expect(existsSync(path.join(repo.root, session.worktree))).toBe(false);
    }
    expect(existsSync(path.join(repo.root, config.git.worktreesDir))).toBe(false);

    // Session + integration branches are gone; the base branch is untouched.
    const git = createGit(repo.root);
    for (const session of config.sessions) {
      expect(unwrap(await git.branchExists(session.branch))).toBe(false);
    }
    expect(unwrap(await git.branchExists(config.git.integrationBranch))).toBe(false);
    expect(unwrap(await git.branchExists(config.git.baseBranch))).toBe(true);

    // Board (claims.json lives inside) and the config file are gone; user
    // source files stay.
    expect(existsSync(path.join(repo.root, config.board.dir))).toBe(false);
    expect(existsSync(path.join(repo.root, 'agents.config.json'))).toBe(false);
    expect(existsSync(path.join(repo.root, 'README.md'))).toBe(true);

    // Only rw's canonical .gitignore line is removed; the user line survives
    // and the (possibly tracked) file itself is never deleted.
    const gitignore = await fs.readFile(path.join(repo.root, '.gitignore'), 'utf8');
    expect(gitignore).toContain('dist/');
    expect(gitignore).not.toContain(`/${config.git.worktreesDir}/`);

    // Only rw's exclude patterns are removed; the user pattern survives.
    const exclude = await fs.readFile(path.join(commonDir, 'info', 'exclude'), 'utf8');
    expect(exclude).toContain('user-secret.txt');
    expect(exclude.split(/\r?\n/)).not.toContain('.env.local');
    expect(exclude.split(/\r?\n/)).not.toContain('node_modules/');
  }, 60000);

  it('keeps a dirty worktree (with reason) and still purges everything safe', async () => {
    await provision(repo.root, config);
    const dirtyWorktree = path.join(repo.root, config.sessions[0]!.worktree);
    await fs.writeFile(path.join(dirtyWorktree, 'work-in-progress.txt'), 'wip\n', 'utf8');

    const result = unwrap(await purgeProvisioning(repo.root, config));

    // The dirty worktree is kept with a reason; its branch (still checked out
    // there) is kept too.
    const keptWorktree = result.items.find(
      (item) => item.kind === 'worktree' && item.action === 'kept',
    );
    expect(keptWorktree?.target).toBe(dirtyWorktree);
    expect(keptWorktree?.reason).toBeDefined();
    expect(existsSync(path.join(dirtyWorktree, 'work-in-progress.txt'))).toBe(true);
    const git = createGit(repo.root);
    expect(unwrap(await git.branchExists(config.sessions[0]!.branch))).toBe(true);

    // Everything safe still proceeded: the OTHER worktree and branch are gone,
    // and so is the board.
    expect(existsSync(path.join(repo.root, config.sessions[1]!.worktree))).toBe(false);
    expect(unwrap(await git.branchExists(config.sessions[1]!.branch))).toBe(false);
    expect(existsSync(path.join(repo.root, config.board.dir))).toBe(false);

    // agents.config.json is KEPT while anything else was kept: it is the source
    // of truth a follow-up `--force` purge still needs to find the leftovers.
    const configItem = result.items.find((item) => item.kind === 'config');
    expect(configItem?.action).toBe('kept');
    expect(existsSync(path.join(repo.root, 'agents.config.json'))).toBe(true);
  }, 60000);

  it('--force removes a dirty worktree, its branch and then the config', async () => {
    await provision(repo.root, config);
    const dirtyWorktree = path.join(repo.root, config.sessions[0]!.worktree);
    await fs.writeFile(path.join(dirtyWorktree, 'work-in-progress.txt'), 'wip\n', 'utf8');

    const result = unwrap(await purgeProvisioning(repo.root, config, { force: true }));
    expect(keptItems(result.items)).toEqual([]);
    expect(existsSync(dirtyWorktree)).toBe(false);
    const git = createGit(repo.root);
    expect(unwrap(await git.branchExists(config.sessions[0]!.branch))).toBe(false);
    expect(existsSync(path.join(repo.root, 'agents.config.json'))).toBe(false);
  }, 60000);

  it('keeps an unmerged branch (git branch -d semantics) and force-deletes it with --force', async () => {
    await provision(repo.root, config);
    // A committed change in s2's worktree: the tree is CLEAN (worktree can go)
    // but the branch now carries work not merged into the base branch.
    const worktree = path.join(repo.root, config.sessions[1]!.worktree);
    await fs.writeFile(path.join(worktree, 'feature.txt'), 'unmerged work\n', 'utf8');
    await runGitOrThrow(worktree, ['add', 'feature.txt']);
    await runGitOrThrow(worktree, ['commit', '-m', 'feat: unmerged work']);

    const first = unwrap(await purgeProvisioning(repo.root, config));
    // The clean worktree went away, but the unmerged branch survived with a reason.
    expect(existsSync(worktree)).toBe(false);
    const keptBranch = first.items.find(
      (item) => item.kind === 'branch' && item.action === 'kept',
    );
    expect(keptBranch?.target).toBe(config.sessions[1]!.branch);
    expect(keptBranch?.reason).toBeDefined();
    const git = createGit(repo.root);
    expect(unwrap(await git.branchExists(config.sessions[1]!.branch))).toBe(true);

    // --force deletes it (-D) and completes the purge.
    const second = unwrap(await purgeProvisioning(repo.root, config, { force: true }));
    expect(keptItems(second.items)).toEqual([]);
    expect(unwrap(await git.branchExists(config.sessions[1]!.branch))).toBe(false);
    expect(existsSync(path.join(repo.root, 'agents.config.json'))).toBe(false);
  }, 60000);

  it('is idempotent: a second purge reports everything absent', async () => {
    await provision(repo.root, config);
    unwrap(await purgeProvisioning(repo.root, config));
    const second = unwrap(await purgeProvisioning(repo.root, config));
    expect(second.items.every((item) => item.action === 'absent')).toBe(true);
  }, 60000);
});
