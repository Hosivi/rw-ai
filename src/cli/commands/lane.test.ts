import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgentsConfig } from '../../contract/schema.js';
import { err } from '../../core/result.js';
import type { CommandRunner } from '../../engine/exec.js';
import { buildConfig } from '../../engine/git.test-support.js';
import { setupMcpRepo, type McpRepo } from '../../mcp/mcp.test-support.js';
import type { CliDeps } from '../command.js';
import { runLane } from './lane.js';

const NOW = new Date('2026-07-04T12:00:00.000Z');

// Distinct lanes plus a shared zone so a real invasion exists (buildConfig's
// default '**/*' area would match everything).
const lanedConfig = (): AgentsConfig => {
  const base = buildConfig({ integrationBranch: 'develop' });
  return {
    ...base,
    sharedZones: ['shared/**'],
    sessions: base.sessions.map((session) => ({ ...session, areas: [`src/${session.id}/**`] })),
  };
};

describe('runLane', () => {
  let mcp: McpRepo;

  const depsAt = (cwd: string): CliDeps => ({ cwd, homeDir: cwd, platform: 'linux', env: {}, now: NOW });

  beforeEach(async () => {
    mcp = await setupMcpRepo(lanedConfig());
  });

  afterEach(async () => {
    await mcp.repo.cleanup();
  });

  it('reports an in-area path as en-area and exits 0', async () => {
    const result = await runLane({ path: 'src/s1/widget.ts' }, depsAt(mcp.worktreePath('s1')));
    expect(result.exitCode).toBe(0);
    expect(result.lines.join('\n')).toContain('en-area');
  });

  it('reports a shared-zone path as zona-compartida and exits 0', async () => {
    const result = await runLane({ path: 'shared/util.ts' }, depsAt(mcp.worktreePath('s1')));
    expect(result.exitCode).toBe(0);
    expect(result.lines.join('\n')).toContain('zona-compartida');
  });

  it('reports an out-of-area path as INVASIÓN and exits 3', async () => {
    const result = await runLane({ path: 'src/s2/leak.ts' }, depsAt(mcp.worktreePath('s1')));
    expect(result.exitCode).toBe(3);
    expect(result.lines.join('\n')).toContain('INVASIÓN');
  });

  it('exits 2 with usage when no path is given', async () => {
    const result = await runLane({}, depsAt(mcp.worktreePath('s1')));
    expect(result.exitCode).toBe(2);
  });

  it('exits 1 when run outside a session worktree (main root)', async () => {
    const result = await runLane({ path: 'src/s1/widget.ts' }, depsAt(mcp.repo.root));
    expect(result.exitCode).toBe(1);
    expect(result.lines.join('\n').toLowerCase()).toContain('sesión');
  });

  it('exits 1 on a context error (not a git repo)', async () => {
    const notARepo: CommandRunner = async () =>
      err({ kind: 'non-zero-exit', output: { stdout: '', stderr: 'fatal', exitCode: 128 } });
    const result = await runLane(
      { path: 'src/s1/widget.ts' },
      { cwd: '/anywhere', homeDir: '/anywhere', platform: 'linux', env: {}, now: NOW, run: notARepo, runRaw: notARepo },
    );
    expect(result.exitCode).toBe(1);
  });
});
