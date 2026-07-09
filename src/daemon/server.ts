import type { SessionState } from '../state/aggregate.js';
import { toPublicState, type PublicSessionState } from '../state/public.js';
import { parseClientRequest, type ServerMessage } from './protocol.js';
import { listenFrameServer, type Conn, type FrameServer } from './transport.js';

// Injectable timer seam so the idle-timeout is deterministic under test without
// fake global timers (which would also stall the real sockets).
export type TimerHandle = unknown;
export type Timers = {
  readonly set: (cb: () => void, ms: number) => TimerHandle;
  readonly clear: (handle: TimerHandle) => void;
};

const defaultTimers: Timers = {
  set: (cb, ms) => setTimeout(cb, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

const DEFAULT_HANDSHAKE_MS = 10_000;

export type DaemonDeps = {
  readonly address: string;
  // The Phase-1 read model. The daemon owns projection to the wire-safe shape, so
  // this returns full SessionState (with claim token) and the daemon redacts.
  readonly collect: () => Promise<SessionState[]>;
  // Subscribe to change signals (fs.watch on claims/markers + debounced git-poll
  // in production); returns an unsubscribe. Each fire triggers one recompute.
  readonly watch: (onChange: () => void) => () => void;
  readonly idleTimeoutMs: number;
  // Grace period for a new connection to send its first request before it is
  // dropped as a zombie (a muted socket must not pin the daemon alive).
  readonly handshakeMs?: number;
  readonly timers?: Timers;
  readonly onShutdown?: () => void;
};

export type Daemon = {
  readonly address: string;
  readonly rev: () => number;
  readonly clientCount: () => number;
  readonly close: () => Promise<void>;
};

export const startDaemon = async (deps: DaemonDeps): Promise<Daemon> => {
  const timers = deps.timers ?? defaultTimers;
  const handshakeMs = deps.handshakeMs ?? DEFAULT_HANDSHAKE_MS;
  const subscribers = new Set<Conn>();
  let rev = 0;
  let lastSerialized: string | null = null;
  let lastStates: readonly PublicSessionState[] = [];
  let activeConns = 0;
  let idleHandle: TimerHandle | null = null;
  let closePromise: Promise<void> | null = null;
  // Serialize recomputes so overlapping change signals can't interleave rev bumps.
  let computing = false;
  let pending = false;

  const recompute = async (): Promise<void> => {
    if (computing) {
      pending = true;
      return;
    }
    computing = true;
    try {
      const states = await deps.collect();
      const projected = states.map(toPublicState);
      const serialized = JSON.stringify(projected);
      if (serialized !== lastSerialized) {
        lastSerialized = serialized;
        lastStates = projected;
        rev += 1;
        const update: ServerMessage = { type: 'update', rev, states: projected };
        for (const conn of subscribers) conn.send(update);
      }
    } finally {
      computing = false;
      if (pending) {
        pending = false;
        await recompute();
      }
    }
  };

  // Register the watcher BEFORE the initial snapshot so a change landing during
  // startup is not missed; the computing/pending guard coalesces any overlap.
  const unwatch = deps.watch(() => {
    void recompute();
  });
  await recompute(); // initial snapshot (rev 0 → 1)

  const clearIdleTimer = (): void => {
    if (idleHandle !== null) {
      timers.clear(idleHandle);
      idleHandle = null;
    }
  };
  const armIdleTimer = (): void => {
    clearIdleTimer();
    idleHandle = timers.set(() => {
      void close();
    }, deps.idleTimeoutMs);
  };

  let server: FrameServer;
  try {
    server = await listenFrameServer(deps.address, (conn) => {
      activeConns += 1;
      clearIdleTimer();
      // Zombie guard: a peer that connects but never sends a request cannot pin the
      // daemon alive. Real (unref'd) timer, not the injectable idle one, so it never
      // collides with idle-timer fakes in tests.
      let handshake: ReturnType<typeof setTimeout> | null = setTimeout(() => {
        conn.close();
      }, handshakeMs);
      handshake.unref();
      const clearHandshake = (): void => {
        if (handshake !== null) {
          clearTimeout(handshake);
          handshake = null;
        }
      };
      conn.onMessage((raw) => {
        clearHandshake();
        const request = parseClientRequest(raw);
        if (!request.ok) {
          conn.close();
          return;
        }
        const snapshot: ServerMessage = { type: 'snapshot', rev, states: lastStates };
        conn.send(snapshot);
        if (request.value.type === 'subscribe') {
          subscribers.add(conn);
        }
        // `get` is one-shot; the client closes its side after reading. We do NOT
        // close server-side here to avoid truncating the just-written snapshot.
      });
      conn.onClose(() => {
        clearHandshake();
        subscribers.delete(conn);
        activeConns -= 1;
        if (activeConns === 0) {
          armIdleTimer();
        }
      });
    });
  } catch (error) {
    // A listen failure (EADDRINUSE from a racing daemon, perms) must release the
    // watcher/poll, or the unref'd-but-live handles would keep the process from
    // exiting cleanly.
    unwatch();
    throw error;
  }

  const close = (): Promise<void> => {
    // Shared in-flight promise: a second caller (e.g. the idle timer racing an
    // explicit close) awaits the SAME teardown, not a prematurely-resolved one.
    if (closePromise !== null) {
      return closePromise;
    }
    closePromise = (async () => {
      clearIdleTimer();
      unwatch();
      await server.close();
      deps.onShutdown?.();
    })();
    return closePromise;
  };

  // No clients yet → start the idle countdown immediately (lazy, no always-on cost).
  armIdleTimer();

  return {
    address: deps.address,
    rev: () => rev,
    clientCount: () => activeConns,
    close,
  };
};
