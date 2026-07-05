import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgentsConfig } from '../contract/schema.js';
import { unwrap } from '../core/result.test-support.js';
import { installAdapters, installUserAdapters, renderSkill, SKILLS } from './adapters.js';
import { buildConfig, removeDirRobust } from './git.test-support.js';

const SKILL_SLUGS = ['rw-workflow', 'rw-identity', 'rw-integration', 'rw-test-artifacts'] as const;
const COMMAND_SLUGS = ['configure', 'init', 'check', 'finish'] as const;

describe('renderSkill', () => {
  it('emits valid frontmatter (--- then name and description) for every skill', () => {
    const config = buildConfig();
    for (const skill of SKILLS) {
      const rendered = renderSkill(skill, config);
      expect(rendered.startsWith('---')).toBe(true);
      expect(rendered).toContain(`name: ${skill.name}`);
      expect(rendered).toContain('description:');
    }
  });

  it('exposes exactly the four expected skill slugs', () => {
    expect(SKILLS.map((skill) => skill.name)).toEqual([...SKILL_SLUGS]);
  });

  it('renders the active session ids into the rw-workflow body (config-derived)', () => {
    const config = buildConfig();
    const workflow = SKILLS.find((skill) => skill.name === 'rw-workflow');
    expect(workflow).toBeDefined();
    const rendered = renderSkill(workflow!, config);
    // buildConfig() yields two active sessions s1/s2 with the '-inicial' branches.
    expect(rendered).toContain('s1');
    expect(rendered).toContain('s2');
    expect(rendered).toContain('feat/s1-inicial');
  });

  it('tells the agent rw is available as MCP tools and that a PreToolUse hook enforces lanes', () => {
    const config = buildConfig();
    const workflow = renderSkill(
      SKILLS.find((skill) => skill.name === 'rw-workflow')!,
      config,
    );
    // The agent should prefer the native MCP tools over shelling out.
    expect(workflow).toContain('rw_check');
    expect(workflow).toContain('rw_lane_check');
    // And know the lane guard blocks writes outside its areas.
    expect(workflow).toContain('rw lane-guard');
    expect(workflow).toContain('areas');
  });
});

describe('installAdapters', () => {
  let dir: string;

  beforeEach(async () => {
    // realpath: os.tmpdir() can be an 8.3 short path on Windows; the returned
    // absolute write paths must compare against the real root.
    dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'rw-ai-adapters-')));
  });

  afterEach(() => removeDirRobust(dir));

  it('writes every skill and command wrapper into BOTH agent trees, all created', async () => {
    const config = buildConfig();
    const result = unwrap(await installAdapters(dir, config));
    expect(result.written.length).toBeGreaterThan(0);

    // Each skill lands under both the Claude Code and the OpenCode skills dir.
    for (const name of SKILL_SLUGS) {
      expect(existsSync(path.join(dir, '.claude', 'skills', name, 'SKILL.md'))).toBe(true);
      expect(existsSync(path.join(dir, '.opencode', 'skills', name, 'SKILL.md'))).toBe(true);
    }
    // Each command wrapper lands under .claude/commands and .opencode/command.
    for (const cmd of COMMAND_SLUGS) {
      expect(existsSync(path.join(dir, '.claude', 'commands', `rw-${cmd}.md`))).toBe(true);
      expect(existsSync(path.join(dir, '.opencode', 'command', `rw-${cmd}.md`))).toBe(true);
    }

    // First run: nothing existed, so every write is a creation.
    expect(result.written.every((write) => write.action === 'created')).toBe(true);
  });

  it('reports every file unchanged on a second identical run (idempotent)', async () => {
    const config = buildConfig();
    unwrap(await installAdapters(dir, config));
    const second = unwrap(await installAdapters(dir, config));
    expect(second.written.every((write) => write.action === 'unchanged')).toBe(true);
  });

  it('reports the workflow skill updated when the config changes, others unchanged', async () => {
    const config = buildConfig();
    unwrap(await installAdapters(dir, config));

    // Archiving s2 shrinks the active-session table, so only the config-derived
    // workflow skill changes; the static skills stay byte-identical.
    const archived: AgentsConfig = {
      ...config,
      sessions: config.sessions.map((session) =>
        session.id === 's2' ? { ...session, status: 'archived' } : session,
      ),
    };
    const second = unwrap(await installAdapters(dir, archived));

    const workflowWrite = second.written.find((write) =>
      write.path.includes(path.join('.claude', 'skills', 'rw-workflow')),
    );
    expect(workflowWrite?.action).toBe('updated');

    const identityWrite = second.written.find((write) =>
      write.path.includes(path.join('.claude', 'skills', 'rw-identity')),
    );
    expect(identityWrite?.action).toBe('unchanged');
  });

  it('never writes a .gitignore (adapter files are committed, not ignored)', async () => {
    const config = buildConfig();
    const result = unwrap(await installAdapters(dir, config));
    expect(existsSync(path.join(dir, '.gitignore'))).toBe(false);
    expect(result.written.some((write) => write.path.endsWith('.gitignore'))).toBe(false);
  });
});

describe('installAdapters — agent config wiring (MCP + hook)', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'rw-ai-adapters-cfg-')));
  });

  afterEach(() => removeDirRobust(dir));

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const readJson = async (rel: string): Promise<any> =>
    JSON.parse(await fs.readFile(path.join(dir, rel), 'utf8'));

  it('writes .mcp.json (rw-ai server) and .claude/settings.json (lane-guard hook), idempotently', async () => {
    const config = buildConfig();
    unwrap(await installAdapters(dir, config));

    const mcp = await readJson('.mcp.json');
    expect(mcp.mcpServers['rw-ai']).toEqual({ command: 'rw', args: ['mcp'] });

    const settings = await readJson(path.join('.claude', 'settings.json'));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const guard = settings.hooks.PreToolUse.flatMap((group: any) => group.hooks).find(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (hook: any) => hook.command === 'rw lane-guard',
    );
    expect(guard).toEqual({ type: 'command', command: 'rw lane-guard' });

    // Second identical run rewrites neither config file.
    const second = unwrap(await installAdapters(dir, config));
    const mcpWrite = second.written.find((write) => write.path.endsWith('.mcp.json'));
    expect(mcpWrite?.action).toBe('unchanged');
    const settingsWrite = second.written.find((write) =>
      write.path.endsWith(path.join('.claude', 'settings.json')),
    );
    expect(settingsWrite?.action).toBe('unchanged');
  });

  it('registers a SessionStart hook running rw session-start, idempotent + non-destructive over PreToolUse', async () => {
    const config = buildConfig();
    unwrap(await installAdapters(dir, config));

    const settings = await readJson(path.join('.claude', 'settings.json'));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sessionStart = settings.hooks.SessionStart.flatMap((group: any) => group.hooks).find(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (hook: any) => hook.command === 'rw session-start',
    );
    expect(sessionStart).toEqual({ type: 'command', command: 'rw session-start' });
    // The PreToolUse lane guard still coexists in the same settings file.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const laneGuard = settings.hooks.PreToolUse.flatMap((group: any) => group.hooks).find(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (hook: any) => hook.command === 'rw lane-guard',
    );
    expect(laneGuard).toBeDefined();

    // Re-running appends no second SessionStart group.
    unwrap(await installAdapters(dir, config));
    const settings2 = await readJson(path.join('.claude', 'settings.json'));
    const sessionStartCount = settings2.hooks.SessionStart.flatMap(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (group: any) => group.hooks,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ).filter((hook: any) => hook.command === 'rw session-start').length;
    expect(sessionStartCount).toBe(1);
  });

  it('writes opencode.json with the rw-ai MCP server (type local, command array)', async () => {
    unwrap(await installAdapters(dir, buildConfig()));
    const opencode = await readJson('opencode.json');
    expect(opencode.mcp['rw-ai']).toEqual({ type: 'local', command: ['rw', 'mcp'], enabled: true });
  });

  it('merges non-destructively: preexisting servers/keys/hooks survive without duplication', async () => {
    // A .mcp.json that already declares a different server and a custom top-level key.
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

    unwrap(await installAdapters(dir, buildConfig()));

    const mcp = await readJson('.mcp.json');
    expect(mcp.mcpServers.other).toEqual({ command: 'other-bin', args: [] }); // preserved
    expect(mcp.custom).toBe(42); // preserved
    expect(mcp.mcpServers['rw-ai']).toEqual({ command: 'rw', args: ['mcp'] }); // added

    const settings = await readJson(path.join('.claude', 'settings.json'));
    expect(settings.theme).toBe('dark'); // preserved
    const commands = settings.hooks.PreToolUse.flatMap(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (group: any) => group.hooks,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ).map((hook: any) => hook.command);
    expect(commands).toContain('other-guard'); // preserved
    expect(commands).toContain('rw lane-guard'); // added

    // Re-running must NOT append a second lane-guard group.
    unwrap(await installAdapters(dir, buildConfig()));
    const settings2 = await readJson(path.join('.claude', 'settings.json'));
    const laneGuardCount = settings2.hooks.PreToolUse.flatMap(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (group: any) => group.hooks,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ).filter((hook: any) => hook.command === 'rw lane-guard').length;
    expect(laneGuardCount).toBe(1);
  });

  it('errors without clobbering when an existing .mcp.json is not valid JSON', async () => {
    const junk = '{ this is not json';
    await fs.writeFile(path.join(dir, '.mcp.json'), junk, 'utf8');
    const result = await installAdapters(dir, buildConfig());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain('.mcp.json');
    }
    // The malformed file is left exactly as it was.
    expect(await fs.readFile(path.join(dir, '.mcp.json'), 'utf8')).toBe(junk);
  });

  it('--worktrees replicates the two Claude Code config files into each active worktree', async () => {
    const config = buildConfig(); // s1 -> .worktrees/s1, s2 -> .worktrees/s2
    unwrap(await installAdapters(dir, config, { worktrees: true }));
    for (const session of config.sessions) {
      expect(existsSync(path.join(dir, session.worktree, '.mcp.json'))).toBe(true);
      expect(existsSync(path.join(dir, session.worktree, '.claude', 'settings.json'))).toBe(true);
    }
  });
});

describe('installUserAdapters (user scope)', () => {
  let home: string;

  beforeEach(async () => {
    // A fake home dir stands in for os.homedir(): the user-scoped writes must land
    // HERE, never in the developer's real ~/.claude.json.
    home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'rw-ai-userhome-')));
  });

  afterEach(() => removeDirRobust(home));

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const readHomeJson = async (...rel: string[]): Promise<any> =>
    JSON.parse(await fs.readFile(path.join(home, ...rel), 'utf8'));

  it('writes the MCP server to ~/.claude.json, hooks to ~/.claude/settings.json, and OpenCode global config', async () => {
    const result = unwrap(await installUserAdapters(home));
    expect(result.written.length).toBe(3);
    expect(result.written.every((write) => write.action === 'created')).toBe(true);

    // Claude Code user-scoped MCP server → ~/.claude.json (NOT settings.json).
    const claudeJson = await readHomeJson('.claude.json');
    expect(claudeJson.mcpServers['rw-ai']).toEqual({ command: 'rw', args: ['mcp'] });

    // Claude Code user-scoped hooks → ~/.claude/settings.json (both hooks).
    const settings = await readHomeJson('.claude', 'settings.json');
    const commands = settings.hooks.PreToolUse.flatMap(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (group: any) => group.hooks,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ).map((hook: any) => hook.command);
    expect(commands).toContain('rw lane-guard');
    const startCommands = settings.hooks.SessionStart.flatMap(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (group: any) => group.hooks,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ).map((hook: any) => hook.command);
    expect(startCommands).toContain('rw session-start');

    // OpenCode global config → ~/.config/opencode/opencode.json.
    const opencode = await readHomeJson('.config', 'opencode', 'opencode.json');
    expect(opencode.mcp['rw-ai']).toEqual({ type: 'local', command: ['rw', 'mcp'], enabled: true });
  });

  it('is idempotent: a second run rewrites nothing', async () => {
    unwrap(await installUserAdapters(home));
    const second = unwrap(await installUserAdapters(home));
    expect(second.written.every((write) => write.action === 'unchanged')).toBe(true);
  });

  it('merges non-destructively over a pre-existing ~/.claude.json (projects/servers/keys preserved)', async () => {
    // ~/.claude.json holds the user's real projects + history + other MCP servers.
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
    // A settings.json with an unrelated key + a different PreToolUse hook.
    await fs.mkdir(path.join(home, '.claude'), { recursive: true });
    await fs.writeFile(
      path.join(home, '.claude', 'settings.json'),
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

    unwrap(await installUserAdapters(home));

    const claudeJson = await readHomeJson('.claude.json');
    expect(claudeJson.projects['/some/repo']).toEqual({ allowedTools: [] }); // preserved
    expect(claudeJson.numStartups).toBe(7); // preserved
    expect(claudeJson.mcpServers.other).toEqual({ command: 'other-bin', args: [] }); // preserved
    expect(claudeJson.mcpServers['rw-ai']).toEqual({ command: 'rw', args: ['mcp'] }); // added

    const settings = await readHomeJson('.claude', 'settings.json');
    expect(settings.theme).toBe('dark'); // preserved
    const commands = settings.hooks.PreToolUse.flatMap(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (group: any) => group.hooks,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ).map((hook: any) => hook.command);
    expect(commands).toContain('other-guard'); // preserved
    expect(commands).toContain('rw lane-guard'); // added
  });
});
