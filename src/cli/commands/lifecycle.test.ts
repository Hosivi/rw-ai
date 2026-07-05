import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ENV_KEYS } from '../../contract/env.js';
import { unwrap } from '../../core/result.test-support.js';
import { readAgentsConfig, writeAgentsConfig } from '../../engine/config-io.js';
import { createGit } from '../../engine/git.js';
import { buildConfig, createTempRepo, runGitOrThrow, type TempRepo } from '../../engine/git.test-support.js';
import type { CliDeps } from '../command.js';
import { runFinish } from './lifecycle.js';

const NOW = new Date('2026-07-02T12:00:00.000Z');

describe('runFinish (CLI boundary)', () => {
  let repo: TempRepo;

  const deps = (env: Record<string, string | undefined> = {}): CliDeps => ({
    cwd: repo.root,
    homeDir: repo.root,
    platform: 'linux',
    env,
    now: NOW,
  });

  // develop + s1's session branch checked out in a worktree with one commit,
  // matching buildConfig()'s s1 (feat/s1-inicial @ .worktrees/s1). The config is
  // written to disk because the handler resolves it through loadContext.
  const setupSession = async (): Promise<string> => {
    await writeAgentsConfig(repo.root, buildConfig());
    const repoGit = createGit(repo.root);
    unwrap(await repoGit.createBranch('develop', 'main'));
    unwrap(await repoGit.createBranch('feat/s1-inicial', 'develop'));
    const wtPath = path.join(repo.root, '.worktrees', 's1');
    unwrap(await repoGit.addWorktree(wtPath, 'feat/s1-inicial'));
    await fs.writeFile(path.join(wtPath, 'feature.txt'), 'session work\n');
    await runGitOrThrow(wtPath, ['add', 'feature.txt']);
    await runGitOrThrow(wtPath, ['commit', '-m', 'feat: session work']);
    return wtPath;
  };

  beforeEach(async () => {
    repo = await createTempRepo();
  });

  afterEach(async () => {
    await repo.cleanup();
  });

  it('exits 2 when neither a positional session nor RW_SESSION is provided', async () => {
    await writeAgentsConfig(repo.root, buildConfig());
    const result = await runFinish({}, deps());
    expect(result.exitCode).toBe(2);
    expect(result.lines.join('\n')).toContain('RW_SESSION');
  });

  it('takes the session from RW_SESSION when no positional is given', async () => {
    await writeAgentsConfig(repo.root, buildConfig());
    // s9 is unknown, but the point is that the id was READ from the env: the
    // handler got past the exit-2 guard into finishSession.
    const result = await runFinish({}, deps({ [ENV_KEYS.session]: 's9' }));
    expect(result.exitCode).toBe(1);
    expect(result.lines.join('\n')).toContain("'s9'");
  });

  it('exits 1 with the unknown-session message for a session not in config', async () => {
    await writeAgentsConfig(repo.root, buildConfig());
    const result = await runFinish({ session: 's9' }, deps());
    expect(result.exitCode).toBe(1);
    expect(result.lines.join('\n')).toContain('No existe una sesión activa');
  });

  it('exits 1 with the dirty-worktree message when the session tree is not clean', async () => {
    const wtPath = await setupSession();
    await fs.writeFile(path.join(wtPath, 'uncommitted.txt'), 'wip\n');
    const result = await runFinish({ session: 's1' }, deps());
    expect(result.exitCode).toBe(1);
    expect(result.lines.join('\n')).toContain('sin commitear');
  });

  it('integrates and rotates on the success path (exit 0)', async () => {
    await setupSession();
    const result = await runFinish({ session: 's1' }, deps());
    expect(result.exitCode).toBe(0);
    expect(result.lines.join('\n')).toContain(
      'Sesión s1: feat/s1-inicial → feat/s1-2 (integrado en develop)',
    );
    // The rotation was persisted, proving the engine actually ran.
    const persisted = unwrap(await readAgentsConfig(repo.root));
    expect(persisted.sessions.find((session) => session.id === 's1')?.branch).toBe('feat/s1-2');
  }, 30000);
});
