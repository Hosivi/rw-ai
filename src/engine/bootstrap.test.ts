import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveBoardDir } from '../contract/env.js';
import { unwrap, unwrapErr } from '../core/result.test-support.js';
import { setupMcpRepo, type McpRepo } from '../mcp/mcp.test-support.js';
import { bootstrapRepo } from './bootstrap.js';
import { readAgentsConfig, writeAgentsConfig } from './config-io.js';
import { configure } from './configure.js';
import { runCommand, runCommandRaw, type CommandRunner } from './exec.js';
import {
  buildConfig,
  createTempRepo,
  removeDirRobust,
  type TempRepo,
} from './git.test-support.js';

const NOW = new Date('2026-07-02T12:00:00.000Z');

const pathExists = async (target: string): Promise<boolean> => {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
};

// A runner wrapper that threads a fixed env into every git invocation. Bootstrap
// creates the repo AND makes the initial commit itself, so we cannot `git config`
// the dir beforehand: instead we inject identity + disable signing via
// GIT_CONFIG_COUNT (higher precedence than global config), and cap git's upward
// repo discovery with GIT_CEILING_DIRECTORIES so an ancestor repo (a dotfiles
// repo at $HOME containing the OS temp dir on some machines) can't make a bare
// dir look like a repo.
const withEnv =
  (base: CommandRunner, extra: Record<string, string>): CommandRunner =>
  (command, args, opts) =>
    base(command, args, { ...opts, env: { ...opts.env, ...extra } });

const freshDirEnv = (dir: string): Record<string, string> => ({
  GIT_CEILING_DIRECTORIES: path.dirname(dir),
  GIT_CONFIG_COUNT: '3',
  GIT_CONFIG_KEY_0: 'user.name',
  GIT_CONFIG_VALUE_0: 'rw-ai tests',
  GIT_CONFIG_KEY_1: 'user.email',
  GIT_CONFIG_VALUE_1: 'tests@rw-ai.invalid',
  GIT_CONFIG_KEY_2: 'commit.gpgsign',
  GIT_CONFIG_VALUE_2: 'false',
});

describe('bootstrapRepo on a fresh non-git directory', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'rw-ai-bootstrap-')));
  });

  afterEach(async () => {
    // Detach linked worktrees first so Windows can remove the busy trees.
    const listed = await runCommand('git', ['worktree', 'list', '--porcelain'], { cwd: dir });
    if (listed.ok) {
      const worktreePaths = listed.value.stdout
        .split(/\r?\n/)
        .filter((line) => line.startsWith('worktree '))
        .map((line) => line.slice('worktree '.length));
      for (const worktreePath of worktreePaths.slice(1)) {
        await runCommand('git', ['worktree', 'remove', '--force', worktreePath], { cwd: dir });
      }
    }
    await removeDirRobust(dir);
  });

  it('inits, makes the initial commit, and configures the repo end to end', async () => {
    const env = freshDirEnv(dir);
    const result = unwrap(
      await bootstrapRepo({
        cwd: dir,
        now: NOW,
        run: withEnv(runCommand, env),
        runRaw: withEnv(runCommandRaw, env),
      }),
    );

    expect(result.gitInitialized).toBe(true);
    expect(result.committed).toBe(true);
    expect(result.alreadyConfigured).toBe(false);
    expect(result.runbook?.ok).toBe(true);

    // agents.config.json was written and parses.
    const parsed = await readAgentsConfig(dir);
    expect(parsed.ok).toBe(true);

    // configure provisioned the worktrees and the review board.
    const config = result.config;
    expect(config).toBeDefined();
    if (config === undefined) {
      throw new Error('expected a config on a successful bootstrap');
    }
    expect(await pathExists(path.join(dir, config.git.worktreesDir))).toBe(true);
    expect(await pathExists(resolveBoardDir(dir, config))).toBe(true);
  }, 30000);
});

describe('bootstrapRepo guards', () => {
  let repo: TempRepo;

  afterEach(async () => {
    await repo.cleanup();
  });

  it('is a no-op that reports alreadyConfigured when the integration branch exists', async () => {
    repo = await createTempRepo();
    const config = buildConfig({ integrationBranch: 'develop' });
    unwrap(await writeAgentsConfig(repo.root, config));
    const runbook = await configure(config, repo.root, { now: NOW });
    expect(runbook.ok).toBe(true);

    const branchesBefore = unwrap(
      await runCommand('git', ['branch', '--list'], { cwd: repo.root }),
    ).stdout;

    const result = unwrap(await bootstrapRepo({ cwd: repo.root, now: NOW }));
    expect(result.alreadyConfigured).toBe(true);
    expect(result.gitInitialized).toBe(false);
    expect(result.committed).toBe(false);
    expect(result.runbook).toBeUndefined();

    // No mutation: the branch set is identical before and after.
    const branchesAfter = unwrap(
      await runCommand('git', ['branch', '--list'], { cwd: repo.root }),
    ).stdout;
    expect(branchesAfter).toBe(branchesBefore);
  }, 30000);
});

describe('bootstrapRepo from inside a session worktree', () => {
  let mcp: McpRepo;

  afterEach(async () => {
    await mcp.repo.cleanup();
  });

  it('refuses with an inside-worktree error and mutates nothing', async () => {
    mcp = await setupMcpRepo(buildConfig({ integrationBranch: 'develop' }));
    const worktreeS1 = mcp.worktreePath('s1');

    const error = unwrapErr(await bootstrapRepo({ cwd: worktreeS1, now: NOW }));
    expect(error.kind).toBe('inside-worktree');
    expect(error.message.toLowerCase()).toContain('worktree');
  }, 30000);
});
