import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildConfig, removeDirRobust } from '../engine/git.test-support.js';
import { activeSessions } from '../engine/sessions.js';
import { readSnapshotViaDaemon } from './client.js';
import { startRepoDaemon } from './runtime.js';
import type { Daemon } from './server.js';

const NOW = new Date('2026-07-09T12:00:00.000Z');
let board: string;
let daemon: Daemon | null = null;

beforeEach(async () => {
  board = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'rw-ai-runtime-')));
});
afterEach(async () => {
  if (daemon) await daemon.close();
  daemon = null;
  await removeDirRobust(board);
});

describe('startRepoDaemon', () => {
  it('serves a live snapshot from the real read model', async () => {
    const config = buildConfig();
    daemon = await startRepoDaemon({
      projectRoot: board, // no real worktrees → git degrades to clean, which is fine
      config,
      boardDir: board,
      platform: process.platform,
      idleTimeoutMs: 30_000,
      pollMs: 60_000,
      now: () => NOW,
    });

    const snapshot = await readSnapshotViaDaemon(daemon.address);
    expect(snapshot).not.toBeNull();
    expect(snapshot).toHaveLength(activeSessions(config).length);
    // Free claims, no markers, clean git → all green, and no token on the wire.
    expect(snapshot?.every((s) => s.light === 'green')).toBe(true);
    expect(JSON.stringify(snapshot)).not.toContain('token');
  });
});
