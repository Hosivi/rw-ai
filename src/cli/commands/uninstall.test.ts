import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { err } from '../../core/result.js';
import { installUserAdapters } from '../../engine/adapters.js';
import { writeAgentsConfig } from '../../engine/config-io.js';
import type { CommandRunner } from '../../engine/exec.js';
import {
  buildConfig,
  createTempRepo,
  removeDirRobust,
  runGitOrThrow,
  type TempRepo,
} from '../../engine/git.test-support.js';
import type { CliDeps } from '../command.js';
import { runAdapters } from './adapters.js';
import { runUninstall } from './uninstall.js';

const NOW = new Date('2026-07-02T12:00:00.000Z');

describe('runUninstall (CLI)', () => {
  let repo: TempRepo;

  const deps = (): CliDeps => ({ cwd: repo.root, homeDir: repo.root, platform: 'linux', env: {}, now: NOW });

  beforeAll(async () => {
    repo = await createTempRepo();
    // A written config is all the command needs — no board provisioning required.
    await writeAgentsConfig(repo.root, buildConfig());
  }, 60000);

  afterAll(async () => {
    await repo.cleanup();
  });

  it('removes what adapters installed, lists the files, and always prints the closing notes', async () => {
    const installed = await runAdapters({}, deps());
    expect(installed.exitCode).toBe(0);

    const result = await runUninstall({}, deps());
    expect(result.exitCode).toBe(0);
    const text = result.lines.join('\n');
    // The skills are gone but the user's config and worktrees stayed out of scope.
    expect(existsSync(path.join(repo.root, '.claude', 'skills', 'rw-workflow'))).toBe(false);
    expect(existsSync(path.join(repo.root, 'agents.config.json'))).toBe(true);
    // The report names the touched files and the closing notes ALWAYS appear.
    expect(text).toContain('.mcp.json');
    expect(text).toContain('npm rm -g rw-ai');
    expect(text).toContain('agents.config.json');

    // A second run is an all-absent no-op that still exits 0 with the notes.
    const second = await runUninstall({}, deps());
    expect(second.exitCode).toBe(0);
    const secondText = second.lines.join('\n');
    expect(secondText).toContain('ausente');
    expect(secondText).toContain('npm rm -g rw-ai');
  }, 60000);
});

describe('runUninstall --purge (de-provision)', () => {
  let repo: TempRepo;

  const deps = (): CliDeps => ({ cwd: repo.root, homeDir: repo.root, platform: 'linux', env: {}, now: NOW });

  // Provision branches + worktrees the way `rw configure` would, so purge has
  // real git state to undo.
  const provision = async (): Promise<void> => {
    const config = buildConfig();
    await writeAgentsConfig(repo.root, config);
    await runGitOrThrow(repo.root, ['branch', config.git.integrationBranch, config.git.baseBranch]);
    for (const session of config.sessions) {
      await runGitOrThrow(repo.root, ['branch', session.branch, config.git.integrationBranch]);
      await runGitOrThrow(repo.root, ['worktree', 'add', session.worktree, session.branch]);
    }
  };

  beforeAll(async () => {
    repo = await createTempRepo();
    await provision();
  }, 60000);

  afterAll(async () => {
    await repo.cleanup();
  });

  it('exits 1 while something is kept, then --force completes and a rerun is all-absent exit 0', async () => {
    await runAdapters({}, deps());
    // A dirty worktree forces the keep path.
    const dirtyWorktree = path.join(repo.root, buildConfig().sessions[0]!.worktree);
    await fs.writeFile(path.join(dirtyWorktree, 'wip.txt'), 'wip\n', 'utf8');

    const partial = await runUninstall({ purge: true }, deps());
    // Partial purge: something was kept, so scripts can detect it via exit 1.
    expect(partial.exitCode).toBe(1);
    const partialText = partial.lines.join('\n');
    expect(partialText).toContain('conservado');
    expect(partialText).toContain('--force');
    expect(partialText).toContain('npm rm -g rw-ai');
    expect(existsSync(dirtyWorktree)).toBe(true);
    // The clean worktree was still purged, and the adapters were unwired.
    expect(existsSync(path.join(repo.root, buildConfig().sessions[1]!.worktree))).toBe(false);
    expect(existsSync(path.join(repo.root, '.claude', 'skills', 'rw-workflow'))).toBe(false);

    const forced = await runUninstall({ purge: true, force: true }, deps());
    expect(forced.exitCode).toBe(0);
    expect(existsSync(dirtyWorktree)).toBe(false);
    expect(existsSync(path.join(repo.root, 'agents.config.json'))).toBe(false);

    // A purge rerun on the fully de-provisioned repo (config gone) is a
    // successful no-op: for an uninstaller, "nothing installed" is the goal
    // state, not an error.
    const again = await runUninstall({ purge: true }, deps());
    expect(again.exitCode).toBe(0);
    expect(again.lines.join('\n')).toContain('npm rm -g rw-ai');

    // WITHOUT --purge the missing config stays the same context error every
    // other command reports: plain uninstall promised to mirror `rw adapters`.
    const plain = await runUninstall({}, deps());
    expect(plain.exitCode).toBe(1);
  }, 120000);
});

describe('runUninstall --user (user scope)', () => {
  let home: string;

  // --user cleans the user scope only, so it needs no repo — just a homeDir.
  const userDeps = (): CliDeps => ({ cwd: '/anywhere', homeDir: home, platform: 'linux', env: {}, now: NOW });

  beforeAll(async () => {
    home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'rw-ai-cli-uninstall-home-')));
  });

  afterAll(() => removeDirRobust(home));

  it('cleans the user-scoped files under homeDir and prints the closing notes', async () => {
    const install = await installUserAdapters(home, 'linux');
    expect(install.ok).toBe(true);

    const result = await runUninstall({ user: true }, userDeps());
    expect(result.exitCode).toBe(0);
    const text = result.lines.join('\n');
    expect(text).toContain('npm rm -g rw-ai');

    // rw-ai is gone from the user-scoped MCP config; the file itself survives.
    const claudeJson = JSON.parse(await fs.readFile(path.join(home, '.claude.json'), 'utf8')) as {
      mcpServers: Record<string, unknown>;
    };
    expect(claudeJson.mcpServers['rw-ai']).toBeUndefined();
  }, 60000);
});

describe('runUninstall (context failure)', () => {
  // git rev-parse fails as it would outside any repo, so loadContext returns
  // not-a-repo without touching the real filesystem.
  const gitNotARepo: CommandRunner = async () =>
    err({ kind: 'non-zero-exit', output: { stdout: '', stderr: 'fatal', exitCode: 128 } });

  it('surfaces a not-a-repo context error as exit 1 (same behavior as adapters)', async () => {
    const result = await runUninstall(
      {},
      {
        cwd: '/anywhere',
        homeDir: '/anywhere',
        platform: 'linux',
        env: {},
        now: NOW,
        run: gitNotARepo,
        runRaw: gitNotARepo,
      },
    );
    expect(result.exitCode).toBe(1);
    expect(result.lines.join('\n').toLowerCase()).toContain('git');
  });
});
