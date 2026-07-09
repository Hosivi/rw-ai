import os from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import type { SessionState } from '../state/aggregate.js';
import { daemonAddress } from './address.js';
import { readSnapshotViaDaemon } from './client.js';
import { startDaemon, type Daemon } from './server.js';

let seq = 0;
const freshAddress = (): string =>
  daemonAddress(`/client-test/${process.pid}/${seq++}`, process.platform, os.tmpdir());

const state = (light: SessionState['light']): SessionState => ({
  sessionId: 's1',
  branch: 'feat/s1',
  areas: ['**/*'],
  claim: { role: 's1', status: 'free', expired: false },
  marker: null,
  git: { dirty: false, ahead: 0, behind: 0 },
  light,
});

let daemons: Daemon[] = [];
afterEach(async () => {
  await Promise.all(daemons.map((d) => d.close()));
  daemons = [];
});

describe('readSnapshotViaDaemon', () => {
  it('returns the wire-safe snapshot from a live daemon', async () => {
    const daemon = await startDaemon({
      address: freshAddress(),
      collect: async () => [state('yellow')],
      watch: () => () => undefined,
      idleTimeoutMs: 30_000,
    });
    daemons.push(daemon);

    const snapshot = await readSnapshotViaDaemon(daemon.address);
    expect(snapshot).not.toBeNull();
    expect(snapshot?.[0]?.light).toBe('yellow');
    expect(snapshot?.[0]?.sessionId).toBe('s1');
  });

  it('returns null when no daemon is listening', async () => {
    expect(await readSnapshotViaDaemon(freshAddress(), 300)).toBeNull();
  });
});
