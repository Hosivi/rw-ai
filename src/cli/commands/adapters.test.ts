import { existsSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { err } from '../../core/result.js';
import { writeAgentsConfig } from '../../engine/config-io.js';
import type { CommandRunner } from '../../engine/exec.js';
import { buildConfig, createTempRepo, type TempRepo } from '../../engine/git.test-support.js';
import type { CliDeps } from '../command.js';
import { runAdapters } from './adapters.js';

const NOW = new Date('2026-07-02T12:00:00.000Z');

describe('runAdapters (CLI)', () => {
  let repo: TempRepo;

  const deps = (): CliDeps => ({ cwd: repo.root, env: {}, now: NOW });

  beforeAll(async () => {
    repo = await createTempRepo();
    // A written config is all the command needs — no board provisioning required.
    await writeAgentsConfig(repo.root, buildConfig());
  }, 60000);

  afterAll(async () => {
    await repo.cleanup();
  });

  it('writes the adapters and reports the Spanish summary counts, then is idempotent', async () => {
    const first = await runAdapters(deps());
    expect(first.exitCode).toBe(0);
    const text = first.lines.join('\n');
    expect(text).toContain('archivos escritos');
    expect(text).toContain('creados');
    expect(existsSync(path.join(repo.root, '.claude', 'skills', 'rw-workflow', 'SKILL.md'))).toBe(true);
    expect(existsSync(path.join(repo.root, '.opencode', 'command', 'rw-finish.md'))).toBe(true);

    // A second run rewrites nothing: every file reports "sin cambios".
    const second = await runAdapters(deps());
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
    const result = await runAdapters({
      cwd: '/anywhere',
      env: {},
      now: NOW,
      run: gitNotARepo,
      runRaw: gitNotARepo,
    });
    expect(result.exitCode).toBe(1);
    expect(result.lines.join('\n').toLowerCase()).toContain('git');
  });
});
