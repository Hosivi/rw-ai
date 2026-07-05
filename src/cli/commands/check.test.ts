import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resolveBoardDir } from '../../contract/env.js';
import type { AgentsConfig } from '../../contract/schema.js';
import { err } from '../../core/result.js';
import { writeAgentsConfig } from '../../engine/config-io.js';
import type { CommandRunner } from '../../engine/exec.js';
import type { IntegrationAnalysis } from '../../engine/integrator.js';
import { buildConfig, createTempRepo, runGitOrThrow, type TempRepo } from '../../engine/git.test-support.js';
import type { CliDeps } from '../command.js';
import { isBlocking, runCheck } from './check.js';
import { runConfigure } from './configure.js';

const NOW = new Date('2026-07-02T12:00:00.000Z');

// A clean baseline: two sessions that changed nothing, no invasions, no
// conflicts — the only non-blocking shape.
const cleanAnalysis: IntegrationAnalysis = {
  base: 'develop',
  sessions: [
    { sessionId: 's1', branch: 'feat/s1', files: [] },
    { sessionId: 's2', branch: 'feat/s2', files: [] },
  ],
  invasions: [],
  sharedZoneTouches: [],
  overlaps: [],
  simulatedMerges: [],
};

describe('isBlocking (pre-merge gate contract)', () => {
  it('is false for a clean analysis', () => {
    expect(isBlocking(cleanAnalysis)).toBe(false);
  });

  it('is true when a session invaded another lane, even with zero conflicts', () => {
    const analysis: IntegrationAnalysis = {
      ...cleanAnalysis,
      invasions: [{ sessionId: 's1', files: ['other/x.ts'] }],
    };
    expect(isBlocking(analysis)).toBe(true);
  });

  it('is true when a simulated merge conflicts, even with zero invasions', () => {
    const analysis: IntegrationAnalysis = {
      ...cleanAnalysis,
      simulatedMerges: [{ a: 's1', b: 's2', status: 'conflict', conflicts: ['shared/x.ts'] }],
    };
    expect(isBlocking(analysis)).toBe(true);
  });

  it('is true when both an invasion and a conflict are present', () => {
    const analysis: IntegrationAnalysis = {
      ...cleanAnalysis,
      invasions: [{ sessionId: 's1', files: ['other/x.ts'] }],
      simulatedMerges: [{ a: 's1', b: 's2', status: 'conflict', conflicts: ['shared/x.ts'] }],
    };
    expect(isBlocking(analysis)).toBe(true);
  });
});

describe('runCheck (integration gate)', () => {
  let repo: TempRepo;
  let config: AgentsConfig;

  const deps = (): CliDeps => ({ cwd: repo.root, homeDir: repo.root, platform: 'linux', env: {}, now: NOW });

  beforeAll(async () => {
    repo = await createTempRepo();
    // Restrict s1 to its own lane so a file it writes elsewhere is an invasion.
    const base = buildConfig();
    config = {
      ...base,
      sessions: base.sessions.map((session) =>
        session.id === 's1' ? { ...session, areas: ['s1-area/**'] } : session,
      ),
    };
    await writeAgentsConfig(repo.root, config);
    const configured = await runConfigure(deps());
    expect(configured.exitCode).toBe(0);
  }, 60000);

  afterAll(async () => {
    await repo.cleanup();
  });

  it('gates a clean tree at exit 0 and a lane invasion at exit 1, writing the report both times', async () => {
    const reportPath = path.join(resolveBoardDir(repo.root, config), 'reports', 'integration.md');

    // Clean: no session diverged from develop yet.
    const clean = await runCheck(deps());
    expect(clean.exitCode).toBe(0);
    expect(clean.lines.join('\n')).toContain('Sesiones analizadas: 2');
    expect(existsSync(reportPath)).toBe(true);

    // Commit a file OUTSIDE s1's lane on its session branch → lane invasion.
    const s1Worktree = path.join(repo.root, '.worktrees', 's1');
    await fs.writeFile(path.join(s1Worktree, 'invader.ts'), 'out of lane\n');
    await runGitOrThrow(s1Worktree, ['add', 'invader.ts']);
    await runGitOrThrow(s1Worktree, ['commit', '-m', 'feat: invade another lane']);

    const invaded = await runCheck(deps());
    expect(invaded.exitCode).toBe(1);
    const text = invaded.lines.join('\n');
    expect(text).toContain('Invasiones de carril: 1');
    expect(text).toContain('resuélvelos antes de integrar');
    // The report must still be written even when the gate fails.
    expect(existsSync(reportPath)).toBe(true);
  }, 60000);
});

describe('runCheck (context failure)', () => {
  const gitNotARepo: CommandRunner = async () =>
    err({ kind: 'non-zero-exit', output: { stdout: '', stderr: 'fatal', exitCode: 128 } });

  it('surfaces a not-a-repo context error as exit 1 instead of swallowing it', async () => {
    const result = await runCheck({
      cwd: '/anywhere',
      homeDir: '/anywhere',
      platform: 'linux',
      env: {},
      now: NOW,
      run: gitNotARepo,
      runRaw: gitNotARepo,
    });
    expect(result.exitCode).toBe(1);
    expect(result.lines.join('\n').toLowerCase()).toContain('git');
  });
});
