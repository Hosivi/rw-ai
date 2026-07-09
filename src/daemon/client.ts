import type { PublicSessionState } from '../state/public.js';
import { connectFrameClient } from './transport.js';

// One-shot read through the daemon: connect, `get`, take the snapshot, done.
// Returns null on ANY failure (no daemon, timeout, malformed reply) so the caller
// can fall back to a local one-shot compute — the daemon is an optimization, never
// a hard dependency (WU-2.5 DoD: `rw status` works with or without it).
export const readSnapshotViaDaemon = async (
  address: string,
  timeoutMs = 1000,
): Promise<PublicSessionState[] | null> => {
  let conn: Awaited<ReturnType<typeof connectFrameClient>>;
  try {
    conn = await connectFrameClient(address);
  } catch {
    return null; // no daemon listening
  }
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: PublicSessionState[] | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      conn.close();
      resolve(value);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    conn.onMessage((message) => {
      const states = (message as { states?: unknown }).states;
      finish(Array.isArray(states) ? (states as PublicSessionState[]) : null);
    });
    conn.onClose(() => finish(null));
    conn.send({ type: 'get' });
  });
};
