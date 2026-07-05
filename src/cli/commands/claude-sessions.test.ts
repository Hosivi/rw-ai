import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveBoardDir } from '../../contract/env.js';
import { writeAgentsConfig } from '../../engine/config-io.js';
import { claimRole } from '../../engine/identity.js';
import { buildConfig, createTempRepo, removeDirRobust, type TempRepo } from '../../engine/git.test-support.js';
import type { CliDeps } from '../command.js';
import { runSessions } from './claude-sessions.js';

const NOW = new Date('2026-07-02T12:00:00.000Z');
const TTL_MS = 28_800_000;

describe('runSessions', () => {
  let home: string;

  beforeEach(async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rw-ai-sessions-'));
    home = await fs.realpath(dir);
  });

  afterEach(() => removeDirRobust(home));

  const writeJob = async (id: string, state: unknown): Promise<void> => {
    const dir = path.join(home, '.claude', 'jobs', id);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'state.json'), JSON.stringify(state), 'utf8');
  };

  // A fake home + fixed clock is the whole injected world: the handler must never
  // reach for the real os.homedir()/process.*.
  const deps = (overrides: Partial<CliDeps> = {}): CliDeps => ({
    cwd: home,
    env: {},
    now: NOW,
    homeDir: home,
    platform: 'linux',
    ...overrides,
  });

  it('lists every machine job and exits 0', async () => {
    await writeJob('job-a', { cwd: 'E:\\repos\\app', state: 'running', updatedAt: '2026-07-02T10:00:00.000Z' });
    await writeJob('job-b', { cwd: 'E:\\repos\\other', state: 'done', updatedAt: '2026-07-01T10:00:00.000Z' });
    const result = await runSessions({}, deps());
    expect(result.exitCode).toBe(0);
    const text = result.lines.join('\n');
    expect(text).toContain('job-a');
    expect(text).toContain('job-b');
  });

  it('reports a Spanish placeholder when there are no jobs', async () => {
    const result = await runSessions({}, deps());
    expect(result.exitCode).toBe(0);
    expect(result.lines.join('\n')).toContain('No hay sesiones de Claude Code');
  });

  it('filters to a project path with --cwd', async () => {
    await writeJob('job-app', { cwd: 'E:\\repos\\app', state: 'running', updatedAt: '2026-07-02T10:00:00.000Z' });
    await writeJob('job-app-nested', {
      cwd: 'E:\\repos\\app\\.worktrees\\s1',
      state: 'done',
      updatedAt: '2026-07-01T10:00:00.000Z',
    });
    await writeJob('job-other', { cwd: 'E:\\repos\\other', state: 'done', updatedAt: '2026-07-01T09:00:00.000Z' });
    // --cwd is an absolute path here so path.resolve keeps it and the toplevel
    // probe (not a repo) falls back to the raw target.
    const result = await runSessions({ cwd: 'E:\\repos\\app' }, deps());
    expect(result.exitCode).toBe(0);
    const text = result.lines.join('\n');
    expect(text).toContain('job-app');
    expect(text).toContain('job-app-nested');
    expect(text).not.toContain('job-other');
  });

  it('exits 1 when the jobs path cannot be enumerated', async () => {
    // Make .claude/jobs a FILE so readdir fails with ENOTDIR (a real io error),
    // distinct from a missing dir (ENOENT → empty listing).
    await fs.mkdir(path.join(home, '.claude'), { recursive: true });
    await fs.writeFile(path.join(home, '.claude', 'jobs'), 'x', 'utf8');
    const result = await runSessions({}, deps());
    expect(result.exitCode).toBe(1);
    expect(result.lines.join('\n')).toContain('No pude leer los jobs');
  });

  describe('--claim correlation', () => {
    let repo: TempRepo;

    beforeEach(async () => {
      repo = await createTempRepo();
      await writeAgentsConfig(repo.root, buildConfig());
    });

    afterEach(() => repo.cleanup());

    it('appends the claimed roles section inside a rw project', async () => {
      // Claim s1 so the correlation section has a real occupied role to show.
      const boardDir = resolveBoardDir(repo.root, buildConfig());
      await fs.mkdir(boardDir, { recursive: true });
      const claimed = await claimRole({
        config: buildConfig(),
        boardDir,
        role: 's1',
        token: 'abcdefgh12345678',
        now: NOW,
        ttlMs: TTL_MS,
      });
      expect(claimed.ok).toBe(true);

      const result = await runSessions({ claim: true }, deps({ cwd: repo.root }));
      expect(result.exitCode).toBe(0);
      const text = result.lines.join('\n');
      expect(text).toContain('## Roles reclamados en este proyecto');
      expect(text).toContain('s1');
      expect(text).toContain('ocupado');
    });

    it('does not fail on a non-rw directory and notes the omission', async () => {
      const nonRepo = await fs.mkdtemp(path.join(os.tmpdir(), 'rw-ai-nonrepo-'));
      try {
        const result = await runSessions({ claim: true }, deps({ cwd: nonRepo }));
        expect(result.exitCode).toBe(0);
        expect(result.lines.join('\n')).toContain('no es un proyecto rw');
      } finally {
        await removeDirRobust(nonRepo);
      }
    });
  });
});
