import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { unwrap, unwrapErr } from '../core/result.test-support.js';
import { removeDirRobust } from '../engine/git.test-support.js';
import {
  parseSessionMarker,
  readSessionMarker,
  sessionMarkerPath,
  writeSessionMarker,
  type SessionMarker,
} from './marker.js';

let dir: string;

beforeEach(async () => {
  dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'rw-ai-marker-')));
});

afterEach(() => removeDirRobust(dir));

const validMarker: SessionMarker = {
  version: 1,
  sessionId: 's1',
  phase: 'working',
  tests: 'passed',
  detail: 'running unit tests',
  updatedAt: '2026-07-09T12:00:00.000Z',
};

describe('parseSessionMarker', () => {
  it('accepts a well-formed marker', () => {
    const marker = unwrap(parseSessionMarker(validMarker));
    expect(marker.phase).toBe('working');
    expect(marker.tests).toBe('passed');
  });

  it('accepts a minimal marker (no optional fields)', () => {
    const marker = unwrap(
      parseSessionMarker({
        version: 1,
        sessionId: 's1',
        phase: 'idle',
        updatedAt: '2026-07-09T12:00:00.000Z',
      }),
    );
    expect(marker.tests).toBeUndefined();
    expect(marker.detail).toBeUndefined();
  });

  it('rejects an unknown phase', () => {
    const error = unwrapErr(parseSessionMarker({ ...validMarker, phase: 'exploding' }));
    expect(error.issues.some((i) => i.includes('phase'))).toBe(true);
  });

  it('rejects a wrong version literal', () => {
    const error = unwrapErr(parseSessionMarker({ ...validMarker, version: 2 }));
    expect(error.issues.some((i) => i.includes('version'))).toBe(true);
  });

  it('rejects a non-iso updatedAt', () => {
    const error = unwrapErr(parseSessionMarker({ ...validMarker, updatedAt: 'yesterday' }));
    expect(error.issues.some((i) => i.includes('updatedAt'))).toBe(true);
  });
});

describe('sessionMarkerPath', () => {
  it('nests under sessions/<id>/status.json', () => {
    expect(sessionMarkerPath('/board', 's2')).toBe(
      path.join('/board', 'sessions', 's2', 'status.json'),
    );
  });
});

describe('writeSessionMarker / readSessionMarker', () => {
  it('creates the session dir and round-trips the marker', async () => {
    unwrap(await writeSessionMarker(dir, validMarker));
    const read = unwrap(await readSessionMarker(dir, 's1'));
    expect(read).toEqual(validMarker);
  });

  it('overwrites an existing marker atomically', async () => {
    unwrap(await writeSessionMarker(dir, validMarker));
    unwrap(await writeSessionMarker(dir, { ...validMarker, phase: 'blocked', tests: 'failed' }));
    const read = unwrap(await readSessionMarker(dir, 's1'));
    expect(read?.phase).toBe('blocked');
    expect(read?.tests).toBe('failed');
  });

  it('returns ok(null) when the marker is missing', async () => {
    const read = unwrap(await readSessionMarker(dir, 'ghost'));
    expect(read).toBeNull();
  });

  it('returns an error when the marker file is corrupt', async () => {
    const target = sessionMarkerPath(dir, 'broken');
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, '{ not json', 'utf8');
    const error = unwrapErr(await readSessionMarker(dir, 'broken'));
    expect(error.kind).toBe('invalid-marker');
  });

  it('rejects writing an invalid marker without touching disk', async () => {
    const bad = { ...validMarker, phase: 'nope' } as unknown as SessionMarker;
    const error = unwrapErr(await writeSessionMarker(dir, bad));
    expect(error.kind).toBe('invalid-marker');
    await expect(fs.readdir(path.join(dir, 'sessions'))).rejects.toThrow();
  });
});
