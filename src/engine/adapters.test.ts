import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgentsConfig } from '../contract/schema.js';
import { unwrap } from '../core/result.test-support.js';
import { installAdapters, renderSkill, SKILLS } from './adapters.js';
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
