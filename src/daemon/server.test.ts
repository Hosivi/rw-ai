import os from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SessionState } from '../state/aggregate.js';
import { daemonAddress } from './address.js';
import { startDaemon, type Daemon } from './server.js';
import { connectFrameClient } from './transport.js';

let seq = 0;
const freshAddress = (): string =>
  daemonAddress(`/daemon-test/${process.pid}/${seq++}`, process.platform, os.tmpdir());

const sessionState = (over: Partial<SessionState> = {}): SessionState => ({
  sessionId: 's1',
  branch: 'feat/s1',
  areas: ['**/*'],
  claim: { role: 's1', status: 'free', expired: false },
  marker: null,
  git: { dirty: false, ahead: 0, behind: 0 },
  light: 'green',
  ...over,
});

// A controllable idle timer: capture the single pending callback, fire on demand.
const makeTimers = () => {
  let cb: (() => void) | null = null;
  return {
    timers: {
      set: (fn: () => void) => {
        cb = fn;
        return 1 as unknown;
      },
      clear: () => {
        cb = null;
      },
    },
    fire: () => cb?.(),
    armed: () => cb !== null,
  };
};

// A manually-triggerable watcher standing in for fs.watch + git-poll.
const makeWatch = () => {
  let onChange: (() => void) | null = null;
  return {
    watch: (handler: () => void) => {
      onChange = handler;
      return () => {
        onChange = null;
      };
    },
    trigger: () => onChange?.(),
    subscribed: () => onChange !== null,
  };
};

const messages = (conn: { onMessage: (h: (v: unknown) => void) => void }): unknown[] => {
  const out: unknown[] = [];
  conn.onMessage((m) => out.push(m));
  return out;
};

let daemons: Daemon[] = [];
afterEach(async () => {
  await Promise.all(daemons.map((d) => d.close()));
  daemons = [];
});

const start = async (over: Partial<Parameters<typeof startDaemon>[0]> = {}) => {
  const timers = makeTimers();
  const watch = makeWatch();
  const daemon = await startDaemon({
    address: freshAddress(),
    collect: async () => [sessionState()],
    watch: watch.watch,
    idleTimeoutMs: 30_000,
    timers: timers.timers,
    ...over,
  });
  daemons.push(daemon);
  return { daemon, timers, watch };
};

describe('startDaemon', () => {
  it('answers subscribe with the current snapshot (rev 1, wire-safe states)', async () => {
    const { daemon } = await start();
    const client = await connectFrameClient(daemon.address);
    const msgs = messages(client);
    client.send({ type: 'subscribe' });

    await vi.waitFor(() => expect(msgs).toHaveLength(1));
    expect(msgs[0]).toEqual({
      type: 'snapshot',
      rev: 1,
      states: [
        {
          sessionId: 's1',
          branch: 'feat/s1',
          areas: ['**/*'],
          light: 'green',
          claim: { status: 'free', expired: false },
          phase: null,
          tests: null,
          git: { dirty: false, ahead: 0, behind: 0 },
        },
      ],
    });
    client.close();
  });

  it('pushes an update to subscribers when the state changes', async () => {
    let current: SessionState[] = [sessionState({ light: 'green' })];
    const { daemon, watch } = await start({ collect: async () => current });

    const client = await connectFrameClient(daemon.address);
    const msgs = messages(client);
    client.send({ type: 'subscribe' });
    await vi.waitFor(() => expect(msgs).toHaveLength(1));

    current = [sessionState({ light: 'red', marker: { version: 1, sessionId: 's1', phase: 'blocked', updatedAt: '2026-07-09T12:00:00.000Z' } })];
    watch.trigger();

    await vi.waitFor(() => expect(msgs).toHaveLength(2));
    expect((msgs[1] as { type: string; rev: number }).type).toBe('update');
    expect((msgs[1] as { rev: number }).rev).toBe(2);
    expect((msgs[1] as { states: { light: string }[] }).states[0]?.light).toBe('red');
    client.close();
  });

  it('does NOT push (or bump rev) when a recompute yields identical state', async () => {
    const { daemon, watch } = await start();
    const client = await connectFrameClient(daemon.address);
    const msgs = messages(client);
    client.send({ type: 'subscribe' });
    await vi.waitFor(() => expect(msgs).toHaveLength(1));

    watch.trigger();
    watch.trigger();
    await new Promise((r) => setTimeout(r, 50));

    expect(msgs).toHaveLength(1);
    expect(daemon.rev()).toBe(1);
    client.close();
  });

  it('get returns a snapshot but receives no later updates', async () => {
    let current: SessionState[] = [sessionState({ light: 'green' })];
    const { daemon, watch } = await start({ collect: async () => current });
    const client = await connectFrameClient(daemon.address);
    const msgs = messages(client);
    client.send({ type: 'get' });
    await vi.waitFor(() => expect(msgs).toHaveLength(1));
    expect((msgs[0] as { type: string }).type).toBe('snapshot');

    current = [sessionState({ light: 'red' })];
    watch.trigger();
    await new Promise((r) => setTimeout(r, 50));
    expect(msgs).toHaveLength(1); // get is not a subscription
    client.close();
  });

  it('serves multiple subscribers from one daemon', async () => {
    let current: SessionState[] = [sessionState({ light: 'green' })];
    const { daemon, watch } = await start({ collect: async () => current });
    const a = await connectFrameClient(daemon.address);
    const b = await connectFrameClient(daemon.address);
    const ma = messages(a);
    const mb = messages(b);
    a.send({ type: 'subscribe' });
    b.send({ type: 'subscribe' });
    await vi.waitFor(() => expect(ma).toHaveLength(1));
    await vi.waitFor(() => expect(mb).toHaveLength(1));

    current = [sessionState({ light: 'yellow' })];
    watch.trigger();
    await vi.waitFor(() => expect(ma).toHaveLength(2));
    await vi.waitFor(() => expect(mb).toHaveLength(2));
    a.close();
    b.close();
  });

  it('never leaks the claim token to the wire', async () => {
    const withToken = sessionState({
      claim: {
        role: 's1',
        status: 'claimed',
        expired: false,
        claim: { status: 'claimed', token: 'secret-xyz', claimedAt: '2026-07-09T12:00:00.000Z', expiresAt: '2026-07-09T20:00:00.000Z' },
      },
    });
    const { daemon } = await start({ collect: async () => [withToken] });
    const client = await connectFrameClient(daemon.address);
    const msgs = messages(client);
    client.send({ type: 'subscribe' });
    await vi.waitFor(() => expect(msgs).toHaveLength(1));
    expect(JSON.stringify(msgs[0])).not.toContain('secret-xyz');
    client.close();
  });

  it('self-shuts-down after the idle timeout with no clients', async () => {
    const onShutdown = vi.fn();
    const { daemon, timers } = await start({ onShutdown });
    // No client ever connects → idle timer armed at startup.
    expect(timers.armed()).toBe(true);
    timers.fire();
    await vi.waitFor(() => expect(onShutdown).toHaveBeenCalledTimes(1));
    // A subsequent connect fails: the daemon is gone.
    await expect(connectFrameClient(daemon.address)).rejects.toBeTruthy();
  });

  it('cancels the idle timer while a client is connected and re-arms on disconnect', async () => {
    const { daemon, timers } = await start();
    const client = await connectFrameClient(daemon.address);
    await vi.waitFor(() => expect(daemon.clientCount()).toBe(1));
    expect(timers.armed()).toBe(false); // connected → not idle
    client.close();
    await vi.waitFor(() => expect(daemon.clientCount()).toBe(0));
    expect(timers.armed()).toBe(true); // idle again
  });
});
