import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgentsConfig } from '../../contract/schema.js';
import { buildConfig } from '../../engine/git.test-support.js';
import { setupMcpRepo, type McpRepo } from '../../mcp/mcp.test-support.js';
import type { CliDeps } from '../command.js';
import { runLaneGuard } from './lane-guard.js';

const NOW = new Date('2026-07-04T12:00:00.000Z');

const lanedConfig = (): AgentsConfig => {
  const base = buildConfig({ integrationBranch: 'develop' });
  return {
    ...base,
    sharedZones: ['shared/**'],
    sessions: base.sessions.map((session) => ({ ...session, areas: [`src/${session.id}/**`] })),
  };
};

// A minimal but faithful PreToolUse payload: the guard only reads tool_input.file_path.
const writePayload = (filePath: string): string =>
  JSON.stringify({
    hook_event_name: 'PreToolUse',
    tool_name: 'Write',
    tool_input: { file_path: filePath, content: 'x' },
  });

describe('runLaneGuard', () => {
  let mcp: McpRepo;

  const guard = (cwd: string, stdin: string) =>
    runLaneGuard({ cwd, homeDir: cwd, platform: 'linux', env: {}, now: NOW, stdin });

  beforeEach(async () => {
    mcp = await setupMcpRepo(lanedConfig());
  });

  afterEach(async () => {
    await mcp.repo.cleanup();
  });

  it('blocks an out-of-area Write with exit 2 and a stderr reason naming the session and area', async () => {
    const wt = mcp.worktreePath('s1');
    const target = path.join(wt, 'src', 's2', 'leak.ts');
    const result = await guard(wt, writePayload(target));
    expect(result.exitCode).toBe(2);
    const stderr = (result.stderr ?? []).join('\n');
    expect(stderr).toContain('Bloqueado por rw');
    expect(stderr).toContain('s1');
    expect(stderr).toContain('src/s1/**');
    expect(stderr).toContain('src/s2/leak.ts');
    // Exit 2 + stderr is the block signal — stdout carries no competing JSON,
    // because Claude Code ignores stdout JSON when a hook exits 2.
    expect(result.lines).toEqual([]);
  });

  it('allows an in-area Write with exit 0 and no output', async () => {
    const wt = mcp.worktreePath('s1');
    const target = path.join(wt, 'src', 's1', 'ok.ts');
    const result = await guard(wt, writePayload(target));
    expect(result.exitCode).toBe(0);
    expect(result.lines).toEqual([]);
    expect(result.stderr ?? []).toEqual([]);
  });

  it('allows a shared-zone Write with exit 0', async () => {
    const wt = mcp.worktreePath('s1');
    const target = path.join(wt, 'shared', 'util.ts');
    const result = await guard(wt, writePayload(target));
    expect(result.exitCode).toBe(0);
  });

  it('fails open (exit 0) on malformed stdin', async () => {
    const result = await guard(mcp.worktreePath('s1'), 'not json {');
    expect(result.exitCode).toBe(0);
  });

  it('fails open (exit 0) on empty stdin', async () => {
    const result = await guard(mcp.worktreePath('s1'), '');
    expect(result.exitCode).toBe(0);
  });

  it('allows a non-file tool payload with no file_path (exit 0)', async () => {
    const stdin = JSON.stringify({
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'ls' },
    });
    const result = await guard(mcp.worktreePath('s1'), stdin);
    expect(result.exitCode).toBe(0);
  });

  it('allows (exit 0) when run outside any session worktree (main root)', async () => {
    const target = path.join(mcp.repo.root, 'src', 's2', 'leak.ts');
    const result = await guard(mcp.repo.root, writePayload(target));
    expect(result.exitCode).toBe(0);
  });
});
