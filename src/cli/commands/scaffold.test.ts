import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { err } from '../../core/result.js';
import { readAgentsConfig } from '../../engine/config-io.js';
import type { CommandRunner } from '../../engine/exec.js';
import { createGit } from '../../engine/git.js';
import { createTempRepo, runGitOrThrow, type TempRepo } from '../../engine/git.test-support.js';
import type { CliDeps } from '../command.js';
import { runScaffold } from './scaffold.js';

const NOW = new Date('2026-07-02T12:00:00.000Z');

// Non-interactive so scaffolding uses detected values / defaults silently — the
// interactive prompt is never driven with real keypresses.
const deps = (repo: TempRepo): CliDeps => ({ cwd: repo.root, homeDir: repo.root, platform: 'linux', env: {}, now: NOW, interactive: false });

describe('runScaffold', () => {
  let repo: TempRepo;

  beforeEach(async () => {
    repo = await createTempRepo();
    // createTempRepo only writes a README; add a package.json so node is detected.
    await fs.writeFile(path.join(repo.root, 'package.json'), '{"name":"demo-app"}\n', 'utf8');
  });

  afterEach(async () => {
    await repo.cleanup();
  });

  it('writes a valid agents.config.json and points at the next step', async () => {
    const result = await runScaffold({}, deps(repo));
    expect(result.exitCode).toBe(0);
    const joined = result.lines.join('\n');
    expect(joined).toContain('node');
    expect(joined).toContain('rw configure');

    const config = await readAgentsConfig(repo.root);
    expect(config.ok).toBe(true);
    if (config.ok) {
      expect(config.value.project.stacks).toEqual(['node']);
      expect(config.value.project.name).toBe('demo-app');
      expect(config.value.sessions).toHaveLength(2);
    }
  });

  it('refuses to overwrite an existing config without --force', async () => {
    const first = await runScaffold({}, deps(repo));
    expect(first.exitCode).toBe(0);

    const second = await runScaffold({}, deps(repo));
    expect(second.exitCode).toBe(1);
    expect(second.lines.join('\n').toLowerCase()).toContain('force');
  });

  it('overwrites an existing config when --force is passed', async () => {
    await runScaffold({}, deps(repo));
    const forced = await runScaffold({ force: true }, deps(repo));
    expect(forced.exitCode).toBe(0);
  });

  it('honors an explicit --sessions count', async () => {
    const result = await runScaffold({ sessions: 3 }, deps(repo));
    expect(result.exitCode).toBe(0);
    const config = await readAgentsConfig(repo.root);
    expect(config.ok && config.value.sessions).toHaveLength(3);
  });

  it("detects 'main' as the base branch on a standard repo", async () => {
    const result = await runScaffold({}, deps(repo));
    expect(result.exitCode).toBe(0);
    expect(result.lines.join('\n')).toContain('main');
    const config = await readAgentsConfig(repo.root);
    expect(config.ok && config.value.git.baseBranch).toBe('main');
  });

  it("detects 'master' when the repo has no main branch", async () => {
    await runGitOrThrow(repo.root, ['branch', '-m', 'main', 'master']);
    const result = await runScaffold({}, deps(repo));
    expect(result.exitCode).toBe(0);
    const config = await readAgentsConfig(repo.root);
    expect(config.ok).toBe(true);
    if (config.ok) {
      expect(config.value.git.baseBranch).toBe('master');
      // Coherence: the recorded base branch actually exists, so rw configure's
      // ensureIntegrationBranch step would not fail on a missing base branch.
      const exists = await createGit(repo.root).branchExists(config.value.git.baseBranch);
      expect(exists.ok && exists.value).toBe(true);
    }
  });

  it('honors an explicit --base-branch override', async () => {
    const result = await runScaffold({ baseBranch: 'custom' }, deps(repo));
    expect(result.exitCode).toBe(0);
    const config = await readAgentsConfig(repo.root);
    expect(config.ok && config.value.git.baseBranch).toBe('custom');
  });

  it('exits 1 with a Spanish message when not inside a git repo', async () => {
    const gitNotARepo: CommandRunner = async () =>
      err({ kind: 'non-zero-exit', output: { stdout: '', stderr: 'fatal', exitCode: 128 } });
    const brokenDeps: CliDeps = {
      cwd: '/anywhere',
      homeDir: '/anywhere',
      platform: 'linux',
      env: {},
      now: NOW,
      interactive: false,
      run: gitNotARepo,
      runRaw: gitNotARepo,
    };
    const result = await runScaffold({}, brokenDeps);
    expect(result.exitCode).toBe(1);
    expect(result.lines.join('\n').toLowerCase()).toContain('git');
  });
});
