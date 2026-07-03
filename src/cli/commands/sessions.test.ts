import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createSession, MAX_SESSION_INDEX } from '../../contract/defaults.js';
import type { AgentsConfig } from '../../contract/schema.js';
import { unwrap } from '../../core/result.test-support.js';
import { writeAgentsConfig } from '../../engine/config-io.js';
import { buildConfig, createTempRepo, type TempRepo } from '../../engine/git.test-support.js';
import type { CliDeps } from '../command.js';
import { runAddSession, runArchive } from './sessions.js';

const NOW = new Date('2026-07-02T12:00:00.000Z');

describe('runArchive / runAddSession failure exit codes', () => {
  let repo: TempRepo;

  const deps = (): CliDeps => ({ cwd: repo.root, homeDir: repo.root, env: {}, now: NOW });

  beforeEach(async () => {
    repo = await createTempRepo();
  });

  afterEach(async () => {
    await repo.cleanup();
  });

  it('exits 1 with already-archived when the same session is archived twice', async () => {
    await writeAgentsConfig(repo.root, buildConfig()); // s1, s2 active
    const first = await runArchive({ id: 's1' }, deps());
    expect(first.exitCode).toBe(0);
    // The second call re-reads the now-archived config from disk.
    const second = await runArchive({ id: 's1' }, deps());
    expect(second.exitCode).toBe(1);
    expect(second.lines.join('\n')).toContain('ya está archivada');
  });

  it('exits 1 with session-not-found for an unknown id', async () => {
    await writeAgentsConfig(repo.root, buildConfig());
    const result = await runArchive({ id: 'nope' }, deps());
    expect(result.exitCode).toBe(1);
    expect(result.lines.join('\n')).toContain('No existe la sesión');
  });

  it('exits 1 with max-sessions when the config is already at the ceiling', async () => {
    const base = buildConfig({ sessionCount: 1 });
    const top = unwrap(
      createSession({ index: MAX_SESSION_INDEX, projectName: 'demo', withPorts: true, withDb: false }),
    );
    const config: AgentsConfig = { ...base, sessions: [top] };
    await writeAgentsConfig(repo.root, config);

    const result = await runAddSession({}, deps());
    expect(result.exitCode).toBe(1);
    expect(result.lines.join('\n')).toContain('máximo de sesiones');
  });

  it('exits 1 with invalid-config when the branch override collides', async () => {
    await writeAgentsConfig(repo.root, buildConfig()); // s1 -> feat/s1-inicial
    const result = await runAddSession({ branch: 'feat/s1-inicial' }, deps());
    expect(result.exitCode).toBe(1);
    expect(result.lines.join('\n')).toContain('inválida');
  });
});
