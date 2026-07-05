import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { err } from '../../core/result.js';
import { writeAgentsConfig } from '../../engine/config-io.js';
import type { CommandRunner } from '../../engine/exec.js';
import {
  buildConfig,
  createTempRepo,
  removeDirRobust,
  type TempRepo,
} from '../../engine/git.test-support.js';
import type { CliDeps } from '../command.js';
import { runAdapters } from './adapters.js';

const NOW = new Date('2026-07-02T12:00:00.000Z');

describe('runAdapters (CLI)', () => {
  let repo: TempRepo;

  const deps = (): CliDeps => ({ cwd: repo.root, homeDir: repo.root, env: {}, now: NOW });

  beforeAll(async () => {
    repo = await createTempRepo();
    // A written config is all the command needs — no board provisioning required.
    await writeAgentsConfig(repo.root, buildConfig());
  }, 60000);

  afterAll(async () => {
    await repo.cleanup();
  });

  it('writes the adapters and reports the Spanish summary counts, then is idempotent', async () => {
    const first = await runAdapters({}, deps());
    expect(first.exitCode).toBe(0);
    const text = first.lines.join('\n');
    expect(text).toContain('archivos escritos');
    expect(text).toContain('creados');
    // The summary now also names the config files it wired and the OpenCode gap.
    expect(text).toContain('.mcp.json');
    expect(text).toContain('opencode.json');
    expect(text.toLowerCase()).toContain('pendiente de verificación');
    expect(existsSync(path.join(repo.root, '.claude', 'skills', 'rw-workflow', 'SKILL.md'))).toBe(true);
    expect(existsSync(path.join(repo.root, '.opencode', 'command', 'rw-finish.md'))).toBe(true);
    expect(existsSync(path.join(repo.root, '.mcp.json'))).toBe(true);
    expect(existsSync(path.join(repo.root, '.claude', 'settings.json'))).toBe(true);
    expect(existsSync(path.join(repo.root, 'opencode.json'))).toBe(true);

    // The settings file wires BOTH hooks: the PreToolUse lane guard and the
    // SessionStart surface/offer command.
    const settings = JSON.parse(
      await fs.readFile(path.join(repo.root, '.claude', 'settings.json'), 'utf8'),
    ) as { hooks: { PreToolUse: { hooks: { command: string }[] }[]; SessionStart: { hooks: { command: string }[] }[] } };
    const startCommands = settings.hooks.SessionStart.flatMap((group) => group.hooks).map(
      (hook) => hook.command,
    );
    expect(startCommands).toContain('rw session-start');

    // A second run rewrites nothing: every file reports "sin cambios".
    const second = await runAdapters({}, deps());
    expect(second.exitCode).toBe(0);
    expect(second.lines.join('\n')).toContain('sin cambios');
  }, 60000);

  it('with --worktrees also writes the config into each active session worktree', async () => {
    const result = await runAdapters({ worktrees: true }, deps());
    expect(result.exitCode).toBe(0);
    expect(result.lines.join('\n')).toContain('worktree');
    for (const session of buildConfig().sessions) {
      expect(existsSync(path.join(repo.root, session.worktree, '.mcp.json'))).toBe(true);
    }
  }, 60000);
});

describe('runAdapters --user (user scope)', () => {
  let home: string;

  // --user installs at the user scope only, so it needs no repo — just a homeDir.
  const userDeps = (): CliDeps => ({ cwd: '/anywhere', homeDir: home, env: {}, now: NOW });

  beforeAll(async () => {
    home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'rw-ai-cli-userhome-')));
  });

  afterAll(() => removeDirRobust(home));

  it('writes the user-scoped MCP server + hooks under homeDir, names the files, and is idempotent', async () => {
    const first = await runAdapters({ user: true }, userDeps());
    expect(first.exitCode).toBe(0);
    const text = first.lines.join('\n');
    // The summary names the user scope and the OpenCode gap.
    expect(text).toContain('a nivel usuario');
    expect(text.toLowerCase()).toContain('pendiente de verificación');

    // MCP server landed in ~/.claude.json (user scope), not settings.json.
    const claudeJson = JSON.parse(await fs.readFile(path.join(home, '.claude.json'), 'utf8')) as {
      mcpServers: Record<string, unknown>;
    };
    expect(claudeJson.mcpServers['rw-ai']).toEqual({ command: 'rw', args: ['mcp'] });

    // Both hooks landed in ~/.claude/settings.json.
    const settings = JSON.parse(
      await fs.readFile(path.join(home, '.claude', 'settings.json'), 'utf8'),
    ) as { hooks: { SessionStart: { hooks: { command: string }[] }[] } };
    const startCommands = settings.hooks.SessionStart.flatMap((group) => group.hooks).map(
      (hook) => hook.command,
    );
    expect(startCommands).toContain('rw session-start');

    // OpenCode global config exists.
    expect(existsSync(path.join(home, '.config', 'opencode', 'opencode.json'))).toBe(true);

    // No project files were written (cwd is not even a repo).
    expect(existsSync(path.join(home, '.mcp.json'))).toBe(false);

    // Idempotent re-run.
    const second = await runAdapters({ user: true }, userDeps());
    expect(second.exitCode).toBe(0);
    expect(second.lines.join('\n')).toContain('sin cambios');
  }, 60000);
});

describe('runAdapters (context failure)', () => {
  // git rev-parse fails as it would outside any repo, so loadContext returns
  // not-a-repo without touching the real filesystem.
  const gitNotARepo: CommandRunner = async () =>
    err({ kind: 'non-zero-exit', output: { stdout: '', stderr: 'fatal', exitCode: 128 } });

  it('surfaces a not-a-repo context error as exit 1', async () => {
    const result = await runAdapters(
      {},
      {
        cwd: '/anywhere',
        homeDir: '/anywhere',
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
