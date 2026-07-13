import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { unwrap } from '../core/result.test-support.js';
import {
  installAdapters,
  installUserAdapters,
  removeAdapters,
  removeUserAdapters,
} from './adapters.js';
import { buildConfig, removeDirRobust } from './git.test-support.js';

// The removal is the EXACT inverse of the install: it targets only what
// installAdapters writes, so every fixture here is produced BY the installer
// (round-trip) instead of hand-crafted paths that could drift from it.
describe('removeAdapters (project scope)', () => {
  let dir: string;

  beforeEach(async () => {
    // realpath: os.tmpdir() can be an 8.3 short path on Windows; the returned
    // absolute paths must compare against the real root.
    dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'rw-ai-remove-')));
  });

  afterEach(() => removeDirRobust(dir));

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const readJson = async (...rel: string[]): Promise<any> =>
    JSON.parse(await fs.readFile(path.join(dir, ...rel), 'utf8'));

  it('round-trips a fresh install: every installed file is removed or cleaned', async () => {
    const config = buildConfig();
    const installed = unwrap(await installAdapters(dir, config, 'linux'));
    const result = unwrap(await removeAdapters(dir, config));

    // Nothing the installer wrote reports 'absent' on the first removal.
    expect(result.removed.length).toBeGreaterThan(0);
    expect(result.removed.every((entry) => entry.action !== 'absent')).toBe(true);
    // The removal report covers the same file set the installer reported.
    expect(new Set(result.removed.map((entry) => entry.path))).toEqual(
      new Set(installed.written.map((entry) => entry.path)),
    );

    // Skills and command wrappers are gone from BOTH agent trees, including the
    // per-skill directory (empty after removing its SKILL.md).
    expect(existsSync(path.join(dir, '.claude', 'skills', 'rw-workflow'))).toBe(false);
    expect(existsSync(path.join(dir, '.opencode', 'skills', 'rw-workflow'))).toBe(false);
    expect(existsSync(path.join(dir, '.claude', 'commands', 'rw-finish.md'))).toBe(false);
    expect(existsSync(path.join(dir, '.opencode', 'command', 'rw-finish.md'))).toBe(false);

    // JSON configs keep their empty containers: only the rw-ai key is deleted.
    const mcp = await readJson('.mcp.json');
    expect(mcp.mcpServers).toEqual({});
    const opencode = await readJson('opencode.json');
    expect(opencode.mcp).toEqual({});
    // Both hook event arrays were emptied by the removal, so their keys drop.
    const settings = await readJson('.claude', 'settings.json');
    expect(settings.hooks).toEqual({});
  });

  it('preserves preexisting servers, keys and foreign hook groups (merge-out)', async () => {
    // A .mcp.json that already declares a different server and a custom key.
    await fs.writeFile(
      path.join(dir, '.mcp.json'),
      `${JSON.stringify({ mcpServers: { other: { command: 'other-bin', args: [] } }, custom: 42 }, null, 2)}\n`,
      'utf8',
    );
    // A settings.json with an unrelated key and a DIFFERENT PreToolUse hook.
    await fs.mkdir(path.join(dir, '.claude'), { recursive: true });
    await fs.writeFile(
      path.join(dir, '.claude', 'settings.json'),
      `${JSON.stringify(
        {
          theme: 'dark',
          hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'other-guard' }] }] },
        },
        null,
        2,
      )}\n`,
      'utf8',
    );

    const config = buildConfig();
    unwrap(await installAdapters(dir, config, 'linux'));
    unwrap(await removeAdapters(dir, config));

    const mcp = await readJson('.mcp.json');
    expect(mcp.mcpServers.other).toEqual({ command: 'other-bin', args: [] }); // preserved
    expect(mcp.custom).toBe(42); // preserved
    expect(mcp.mcpServers['rw-ai']).toBeUndefined(); // removed

    const settings = await readJson('.claude', 'settings.json');
    expect(settings.theme).toBe('dark'); // preserved
    // The foreign PreToolUse group survives; only rw's group is filtered out.
    const commands = settings.hooks.PreToolUse.flatMap(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (group: any) => group.hooks,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ).map((hook: any) => hook.command);
    expect(commands).toEqual(['other-guard']);
    // SessionStart existed only because adapters created it, so its emptied key drops.
    expect(settings.hooks.SessionStart).toBeUndefined();
  });

  it('leaves unrelated skills and commands untouched (never a glob wipe)', async () => {
    const config = buildConfig();
    unwrap(await installAdapters(dir, config, 'linux'));
    // A user skill and a user command living next to rw's.
    await fs.mkdir(path.join(dir, '.claude', 'skills', 'my-skill'), { recursive: true });
    await fs.writeFile(path.join(dir, '.claude', 'skills', 'my-skill', 'SKILL.md'), 'mine', 'utf8');
    await fs.writeFile(path.join(dir, '.claude', 'commands', 'my-cmd.md'), 'mine', 'utf8');

    unwrap(await removeAdapters(dir, config));

    expect(existsSync(path.join(dir, '.claude', 'skills', 'my-skill', 'SKILL.md'))).toBe(true);
    expect(existsSync(path.join(dir, '.claude', 'commands', 'my-cmd.md'))).toBe(true);
    expect(existsSync(path.join(dir, '.claude', 'skills', 'rw-workflow'))).toBe(false);
  });

  it('is idempotent: a second removal reports everything absent', async () => {
    const config = buildConfig();
    unwrap(await installAdapters(dir, config, 'linux'));
    unwrap(await removeAdapters(dir, config));
    const second = unwrap(await removeAdapters(dir, config));
    expect(second.removed.every((entry) => entry.action === 'absent')).toBe(true);
  });

  it('never creates files: removing from an empty dir reports all absent and writes nothing', async () => {
    const config = buildConfig();
    const result = unwrap(await removeAdapters(dir, config));
    expect(result.removed.every((entry) => entry.action === 'absent')).toBe(true);
    expect(await fs.readdir(dir)).toEqual([]);
  });

  it('errors without clobbering when an existing .mcp.json is not valid JSON', async () => {
    const junk = '{ this is not json';
    await fs.writeFile(path.join(dir, '.mcp.json'), junk, 'utf8');
    const result = await removeAdapters(dir, buildConfig());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('invalid-json');
      expect(result.error.message).toContain('.mcp.json');
    }
    // The malformed file is left exactly as it was.
    expect(await fs.readFile(path.join(dir, '.mcp.json'), 'utf8')).toBe(junk);
  });

  it('--worktrees also cleans the two Claude Code config files inside each active worktree', async () => {
    const config = buildConfig(); // s1 -> .worktrees/s1, s2 -> .worktrees/s2
    unwrap(await installAdapters(dir, config, 'linux', { worktrees: true }));
    unwrap(await removeAdapters(dir, config, { worktrees: true }));

    for (const session of config.sessions) {
      const mcp = await readJson(session.worktree, '.mcp.json');
      expect(mcp.mcpServers['rw-ai']).toBeUndefined();
      const settings = await readJson(session.worktree, '.claude', 'settings.json');
      expect(settings.hooks).toEqual({});
    }
  });
});

describe('removeUserAdapters (user scope)', () => {
  let home: string;

  beforeEach(async () => {
    // A fake home dir stands in for os.homedir(): the removal must operate HERE,
    // never against the developer's real ~/.claude.json.
    home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'rw-ai-remove-home-')));
  });

  afterEach(() => removeDirRobust(home));

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const readHomeJson = async (...rel: string[]): Promise<any> =>
    JSON.parse(await fs.readFile(path.join(home, ...rel), 'utf8'));

  it('round-trips installUserAdapters: rw-ai and both hooks are gone, other content survives', async () => {
    // ~/.claude.json holds the user's real projects + other MCP servers.
    await fs.writeFile(
      path.join(home, '.claude.json'),
      `${JSON.stringify(
        {
          projects: { '/some/repo': { allowedTools: [] } },
          mcpServers: { other: { command: 'other-bin', args: [] } },
          numStartups: 7,
        },
        null,
        2,
      )}\n`,
      'utf8',
    );

    unwrap(await installUserAdapters(home, 'linux'));
    const result = unwrap(await removeUserAdapters(home));
    expect(result.removed.length).toBe(3);

    const claudeJson = await readHomeJson('.claude.json');
    expect(claudeJson.projects['/some/repo']).toEqual({ allowedTools: [] }); // preserved
    expect(claudeJson.numStartups).toBe(7); // preserved
    expect(claudeJson.mcpServers.other).toEqual({ command: 'other-bin', args: [] }); // preserved
    expect(claudeJson.mcpServers['rw-ai']).toBeUndefined(); // removed

    const settings = await readHomeJson('.claude', 'settings.json');
    expect(settings.hooks).toEqual({}); // both rw hook groups emptied their events

    const opencode = await readHomeJson('.config', 'opencode', 'opencode.json');
    expect(opencode.mcp).toEqual({});
  });

  it('is idempotent: a second removal reports everything absent', async () => {
    unwrap(await installUserAdapters(home, 'linux'));
    unwrap(await removeUserAdapters(home));
    const second = unwrap(await removeUserAdapters(home));
    expect(second.removed.every((entry) => entry.action === 'absent')).toBe(true);
  });

  it('never creates files: an empty home reports all absent and stays empty', async () => {
    const result = unwrap(await removeUserAdapters(home));
    expect(result.removed.every((entry) => entry.action === 'absent')).toBe(true);
    expect(await fs.readdir(home)).toEqual([]);
  });

  it('errors without clobbering when ~/.claude.json is not valid JSON', async () => {
    const junk = 'not json at all';
    await fs.writeFile(path.join(home, '.claude.json'), junk, 'utf8');
    const result = await removeUserAdapters(home);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain('.claude.json');
    }
    expect(await fs.readFile(path.join(home, '.claude.json'), 'utf8')).toBe(junk);
  });
});
