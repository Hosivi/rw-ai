import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDefaultConfig } from '../contract/defaults.js';
import { err, ok } from '../core/result.js';
import { unwrap } from '../core/result.test-support.js';
import type { CommandRunner } from '../engine/exec.js';
import { removeDirRobust } from '../engine/git.test-support.js';
import { collectSessionStates } from './read.js';
import { writeSessionMarker } from './marker.js';

const config = unwrap(
  createDefaultConfig({ projectName: 'demo', stacks: ['node'], sessionCount: 2 }),
);
const NOW = new Date('2026-07-09T12:00:00.000Z');

let board: string;
beforeEach(async () => {
  board = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'rw-ai-read-')));
});
afterEach(() => removeDirRobust(board));

// Fake git: strict `run` answers `status --porcelain` (dirty iff the worktree
// path is s1); raw runner answers `rev-list` ahead/behind counts.
const run: CommandRunner = async (_cmd, args, opts) => {
  if (args[0] === 'status') {
    const dirty = opts.cwd.includes(`${path.sep}s1`);
    return ok({ stdout: dirty ? ' M src/a.ts\n' : '', stderr: '', exitCode: 0 });
  }
  return ok({ stdout: '', stderr: '', exitCode: 0 });
};
const runRaw: CommandRunner = async (_cmd, args, opts) => {
  if (args[0] === 'rev-list') {
    const ahead = opts.cwd.includes(`${path.sep}s1`) ? '3' : '0';
    return ok({ stdout: `0\t${ahead}\n`, stderr: '', exitCode: 0 });
  }
  return ok({ stdout: '', stderr: '', exitCode: 0 });
};

describe('collectSessionStates', () => {
  it('joins claims, markers and git signals into per-session state', async () => {
    unwrap(await writeSessionMarker(board, {
      version: 1,
      sessionId: 's2',
      phase: 'blocked',
      updatedAt: NOW.toISOString(),
    }));

    const states = unwrap(
      await collectSessionStates({
        config,
        projectRoot: '/repo',
        boardDir: board,
        now: NOW,
        run,
        runRaw,
      }),
    );

    expect(states.map((s) => s.sessionId)).toEqual(['s1', 's2']);
    // s1: no marker, no claim, but dirty + ahead — held-claim gate is false, so green.
    expect(states[0]?.git).toEqual({ dirty: true, ahead: 3, behind: 0 });
    expect(states[0]?.light).toBe('green');
    // s2: blocked marker → red regardless of clean git.
    expect(states[1]?.marker?.phase).toBe('blocked');
    expect(states[1]?.light).toBe('red');
  });

  it('degrades a corrupt marker to null instead of failing the whole read', async () => {
    await fs.mkdir(path.join(board, 'sessions', 's1'), { recursive: true });
    await fs.writeFile(path.join(board, 'sessions', 's1', 'status.json'), '{ broken', 'utf8');

    const states = unwrap(
      await collectSessionStates({
        config,
        projectRoot: '/repo',
        boardDir: board,
        now: NOW,
        run,
        runRaw,
      }),
    );

    expect(states[0]?.marker).toBeNull();
  });

  it('degrades an unprovisioned worktree (git spawn failure) to clean git, not a global failure', async () => {
    const gitFails = async () => err({ kind: 'spawn-failed' as const, message: 'ENOENT: no such worktree' });

    const states = unwrap(
      await collectSessionStates({
        config,
        projectRoot: '/repo',
        boardDir: board,
        now: NOW,
        run: gitFails,
        runRaw: gitFails,
      }),
    );

    expect(states).toHaveLength(2);
    expect(states[0]?.git).toEqual({ dirty: false, ahead: 0, behind: 0 });
    expect(states.every((s) => s.light === 'green')).toBe(true);
  });

  it('returns an empty array when there are no active sessions', async () => {
    const empty = {
      ...config,
      sessions: config.sessions.map((s) => ({ ...s, status: 'archived' as const })),
    };
    const states = unwrap(
      await collectSessionStates({
        config: empty,
        projectRoot: '/repo',
        boardDir: board,
        now: NOW,
        run,
        runRaw,
      }),
    );
    expect(states).toEqual([]);
  });
});
