import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { err, ok } from '../../core/result.js';
import { writeAgentsConfig } from '../../engine/config-io.js';
import { runCommand, type CommandRunner } from '../../engine/exec.js';
import { buildConfig, createTempRepo, type TempRepo } from '../../engine/git.test-support.js';
import type { CliDeps } from '../command.js';
import { runConfigure } from './configure.js';

const NOW = new Date('2026-07-02T12:00:00.000Z');

describe('runConfigure exit codes', () => {
  let repo: TempRepo;

  beforeEach(async () => {
    repo = await createTempRepo();
  });

  afterEach(async () => {
    await repo.cleanup();
  });

  it('exits 1 and reports problems when a HARD runbook step fails', async () => {
    await writeAgentsConfig(repo.root, buildConfig());
    // Report an ancient git for `git --version` (predates merge-tree, needs
    // >= 2.38) so preflight-git fails and the runbook aborts. Every other git
    // call — including loadContext's rev-parse — goes through the real runner.
    const oldGit: CommandRunner = (command, args, opts) =>
      command === 'git' && args[0] === '--version'
        ? Promise.resolve(ok({ stdout: 'git version 2.20.0\n', stderr: '', exitCode: 0 }))
        : runCommand(command, args, opts);

    const result = await runConfigure({ cwd: repo.root, homeDir: repo.root, platform: 'linux', env: {}, now: NOW, run: oldGit });
    expect(result.exitCode).toBe(1);
    expect(result.lines.join('\n')).toContain('Configuración con problemas');
  }, 30000);

  it('surfaces a not-a-repo context error as exit 1 instead of exit 0', async () => {
    const gitNotARepo: CommandRunner = async () =>
      err({ kind: 'non-zero-exit', output: { stdout: '', stderr: 'fatal', exitCode: 128 } });
    const deps: CliDeps = { cwd: '/anywhere', homeDir: '/anywhere', platform: 'linux', env: {}, now: NOW, run: gitNotARepo, runRaw: gitNotARepo };

    const result = await runConfigure(deps);
    expect(result.exitCode).toBe(1);
    expect(result.lines.join('\n').toLowerCase()).toContain('git');
  });
});
