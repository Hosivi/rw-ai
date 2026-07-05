import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { unwrap } from '../../core/result.test-support.js';
import { readAgentsConfig, writeAgentsConfig } from '../../engine/config-io.js';
import { configure } from '../../engine/configure.js';
import { runCommand, runCommandRaw, type CommandRunner } from '../../engine/exec.js';
import {
  buildConfig,
  createTempRepo,
  removeDirRobust,
  type TempRepo,
} from '../../engine/git.test-support.js';
import type { CliDeps } from '../command.js';
import { runBootstrap } from './bootstrap.js';

const NOW = new Date('2026-07-02T12:00:00.000Z');

// Thread a git identity (+ disable signing, + cap repo discovery) into every git
// call so the initial commit bootstrap makes inside the fresh dir succeeds without
// depending on the developer's global git config.
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

describe('runBootstrap on a fresh directory', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'rw-ai-cli-bootstrap-')));
  });

  afterEach(async () => {
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

  it('inits, configures, and reports a Spanish summary with exit 0', async () => {
    const env = freshDirEnv(dir);
    const deps: CliDeps = {
      cwd: dir,
      homeDir: dir,
      platform: 'linux',
      env: {},
      now: NOW,
      interactive: false,
      run: withEnv(runCommand, env),
      runRaw: withEnv(runCommandRaw, env),
    };

    const result = await runBootstrap({}, deps);
    expect(result.exitCode).toBe(0);
    const joined = result.lines.join('\n');
    expect(joined).toContain('git inicializado');
    // The configure runbook is rendered inline.
    expect(joined).toContain('Configuración completa');

    const config = await readAgentsConfig(dir);
    expect(config.ok).toBe(true);
  }, 30000);
});

describe('runBootstrap on an already-configured repo', () => {
  let repo: TempRepo;

  beforeEach(async () => {
    repo = await createTempRepo();
    const config = buildConfig({ integrationBranch: 'develop' });
    unwrap(await writeAgentsConfig(repo.root, config));
    const runbook = await configure(config, repo.root, { now: NOW });
    expect(runbook.ok).toBe(true);
  });

  afterEach(async () => {
    await repo.cleanup();
  });

  it('reports "already configured" and exits 0 without mutating', async () => {
    const deps: CliDeps = {
      cwd: repo.root,
      homeDir: repo.root,
      platform: 'linux',
      env: {},
      now: NOW,
      interactive: false,
    };
    const result = await runBootstrap({}, deps);
    expect(result.exitCode).toBe(0);
    expect(result.lines.join('\n').toLowerCase()).toContain('ya');
  }, 30000);
});
