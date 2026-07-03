import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgentsConfig } from '../contract/schema.js';
import { unwrap, unwrapErr } from '../core/result.test-support.js';
import { agentsConfigPath, readAgentsConfig, writeAgentsConfig } from './config-io.js';
import { buildConfig, removeDirRobust } from './git.test-support.js';

let dir: string;

beforeEach(async () => {
  // realpath because os.tmpdir() can hand back an 8.3 short path on Windows.
  dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'rw-ai-config-')));
});

afterEach(() => removeDirRobust(dir));

describe('agentsConfigPath', () => {
  it('joins agents.config.json onto the project root', () => {
    expect(agentsConfigPath('/proj')).toBe(path.join('/proj', 'agents.config.json'));
  });
});

describe('writeAgentsConfig / readAgentsConfig', () => {
  it('round-trips a config through write then read', async () => {
    const config = buildConfig();
    unwrap(await writeAgentsConfig(dir, config));
    expect(unwrap(await readAgentsConfig(dir))).toEqual(config);
  });

  it('serializes with two-space indent and a trailing newline', async () => {
    const config = buildConfig();
    unwrap(await writeAgentsConfig(dir, config));
    const raw = await fs.readFile(agentsConfigPath(dir), 'utf8');
    expect(raw).toBe(`${JSON.stringify(config, null, 2)}\n`);
  });

  it('overwrites an existing file atomically on rewrite', async () => {
    const config = buildConfig();
    unwrap(await writeAgentsConfig(dir, config));
    const rotated: AgentsConfig = {
      ...config,
      sessions: config.sessions.map((session) =>
        session.id === 's1' ? { ...session, branch: 'feat/s1-2' } : session,
      ),
    };
    unwrap(await writeAgentsConfig(dir, rotated));
    const read = unwrap(await readAgentsConfig(dir));
    expect(read.sessions.find((session) => session.id === 's1')?.branch).toBe('feat/s1-2');
  });

  it('reports not-found when the file is missing', async () => {
    expect(unwrapErr(await readAgentsConfig(dir)).kind).toBe('not-found');
  });

  it('reports invalid-json for a malformed file', async () => {
    await fs.writeFile(agentsConfigPath(dir), '{ not valid json', 'utf8');
    expect(unwrapErr(await readAgentsConfig(dir)).kind).toBe('invalid-json');
  });

  it('reports invalid-config with issues for a schema violation', async () => {
    await fs.writeFile(agentsConfigPath(dir), JSON.stringify({ version: 1 }), 'utf8');
    const error = unwrapErr(await readAgentsConfig(dir));
    expect(error.kind).toBe('invalid-config');
    expect(error.issues?.length ?? 0).toBeGreaterThan(0);
  });
});
