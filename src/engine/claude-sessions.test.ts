import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { unwrap } from '../core/result.test-support.js';
import {
  claudeJobsDir,
  filterByCwd,
  listClaudeSessions,
  type ClaudeSession,
} from './claude-sessions.js';
import { removeDirRobust } from './git.test-support.js';

describe('listClaudeSessions', () => {
  let home: string;

  beforeEach(async () => {
    // realpath because os.tmpdir() can be an 8.3 short path on Windows; the
    // reader joins its own paths, so the fixture root must be the real one.
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rw-ai-claude-'));
    home = await fs.realpath(dir);
  });

  afterEach(() => removeDirRobust(home));

  // Writes <home>/.claude/jobs/<id>/state.json. A string payload is written
  // verbatim (to seed a malformed file); anything else is JSON-serialized.
  const writeJob = async (id: string, state: unknown): Promise<void> => {
    const dir = path.join(claudeJobsDir(home), id);
    await fs.mkdir(dir, { recursive: true });
    const payload = typeof state === 'string' ? state : JSON.stringify(state);
    await fs.writeFile(path.join(dir, 'state.json'), payload, 'utf8');
  };

  it('returns ok([]) when the jobs dir does not exist', async () => {
    // A machine that never ran a background job has no jobs dir — not an error.
    expect(unwrap(await listClaudeSessions(home))).toEqual([]);
  });

  it('lists well-formed jobs sorted by updatedAt descending', async () => {
    await writeJob('job-older', {
      cwd: 'E:\\repos\\app',
      state: 'done',
      updatedAt: '2026-07-01T12:00:00.000Z',
      createdAt: '2026-06-30T12:00:00.000Z',
      name: 'Older',
    });
    await writeJob('job-newer', {
      cwd: 'E:\\repos\\app',
      state: 'running',
      updatedAt: '2026-07-02T12:00:00.000Z',
      createdAt: '2026-07-01T12:00:00.000Z',
      name: 'Newer',
      intent: 'do x',
      inFlight: true,
    });
    const result = unwrap(await listClaudeSessions(home));
    expect(result.map((s) => s.id)).toEqual(['job-newer', 'job-older']);
    expect(result[0]).toMatchObject({
      id: 'job-newer',
      cwd: 'E:\\repos\\app',
      state: 'running',
      name: 'Newer',
      intent: 'do x',
      inFlight: true,
    });
  });

  it('still lists a job missing state/updatedAt with those fields undefined', async () => {
    await writeJob('job-partial', { cwd: 'E:\\repos\\app' });
    const result = unwrap(await listClaudeSessions(home));
    expect(result).toHaveLength(1);
    expect(result[0]?.id).toBe('job-partial');
    expect(result[0]?.cwd).toBe('E:\\repos\\app');
    expect(result[0]?.state).toBeUndefined();
    expect(result[0]?.updatedAt).toBeUndefined();
  });

  it('sorts jobs without updatedAt last, tie-broken by id', async () => {
    await writeJob('b-dated', { updatedAt: '2026-07-01T00:00:00.000Z' });
    await writeJob('z-nometa', {});
    await writeJob('a-nometa', {});
    const result = unwrap(await listClaudeSessions(home));
    expect(result.map((s) => s.id)).toEqual(['b-dated', 'a-nometa', 'z-nometa']);
  });

  it('skips a malformed-JSON job but still returns the others', async () => {
    await writeJob('job-good', { cwd: 'E:\\repos\\app', updatedAt: '2026-07-02T12:00:00.000Z' });
    await writeJob('job-bad', '{ this is not json');
    const result = unwrap(await listClaudeSessions(home));
    expect(result.map((s) => s.id)).toEqual(['job-good']);
  });

  it('ignores a non-directory file at the jobs root like pins.json', async () => {
    await writeJob('job-good', { updatedAt: '2026-07-02T12:00:00.000Z' });
    await fs.writeFile(path.join(claudeJobsDir(home), 'pins.json'), '{"pinned":[]}', 'utf8');
    const result = unwrap(await listClaudeSessions(home));
    expect(result.map((s) => s.id)).toEqual(['job-good']);
  });

  it('ignores a job directory with no state.json', async () => {
    await writeJob('job-good', { updatedAt: '2026-07-02T12:00:00.000Z' });
    await fs.mkdir(path.join(claudeJobsDir(home), 'job-empty'), { recursive: true });
    const result = unwrap(await listClaudeSessions(home));
    expect(result.map((s) => s.id)).toEqual(['job-good']);
  });

  it('coerces non-string/non-boolean fields to undefined defensively', async () => {
    await writeJob('job-weird', {
      cwd: 12345,
      state: { nested: true },
      updatedAt: '2026-07-02T12:00:00.000Z',
      inFlight: 'yes',
    });
    const result = unwrap(await listClaudeSessions(home));
    expect(result[0]?.cwd).toBeUndefined();
    expect(result[0]?.state).toBeUndefined();
    expect(result[0]?.inFlight).toBeUndefined();
    // The valid field still comes through.
    expect(result[0]?.updatedAt).toBe('2026-07-02T12:00:00.000Z');
  });
});

describe('filterByCwd', () => {
  const sessions: readonly ClaudeSession[] = [
    { id: 'exact', cwd: 'E:\\repos\\app' },
    { id: 'nested', cwd: 'E:\\repos\\app\\.worktrees\\s1' },
    { id: 'sibling', cwd: 'E:\\repos\\app-other' },
    { id: 'elsewhere', cwd: 'E:\\repos\\zzz' },
    { id: 'no-cwd' },
  ];

  it('keeps exact and nested paths but not a sibling sharing the prefix', () => {
    const kept = filterByCwd(sessions, 'E:\\repos\\app').map((s) => s.id);
    expect(kept).toContain('exact');
    expect(kept).toContain('nested');
    // 'app-other' shares the 'E:/repos/app' text but not the '/' boundary.
    expect(kept).not.toContain('sibling');
    expect(kept).not.toContain('elsewhere');
  });

  it('drops sessions without a cwd', () => {
    const kept = filterByCwd(sessions, 'E:\\repos\\app').map((s) => s.id);
    expect(kept).not.toContain('no-cwd');
  });

  it('matches across drive-letter casing and slash direction', () => {
    const kept = filterByCwd(
      [{ id: 'x', cwd: 'E:/repos/app/.worktrees/s1' }],
      'e:\\repos\\app',
    ).map((s) => s.id);
    expect(kept).toEqual(['x']);
  });
});
