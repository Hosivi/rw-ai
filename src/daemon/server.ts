import type { SessionState } from '../state/aggregate.js';
import { toPublicState, type PublicSessionState } from '../state/public.js';
import { parseClientRequest, type ServerMessage } from './protocol.js';
import { listenFrameServer, type Conn } from './transport.js';

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

export type DaemonDeps = {
  readonly address: string;
  // The Phase-1 read model. The daemon owns projection to the wire-safe shape, so
  // this returns full SessionState (with claim token) and the daemon redacts.
  readonly collect: () => Promise<SessionState[]>;
  // Subscribe to change signals (fs.watch on claims/markers + debounced git-poll
  // in production); returns an unsubscribe. Each fire triggers one recompute.
  readonly watch: (onChange: () => void) => () => void;
  readonly idleTimeoutMs: number;
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
  const subscribers = new Set<Conn>();
  let rev = 0;
  let lastSerialized: string | null = null;
  let lastStates: readonly PublicSessionState[] = [];
  let activeConns = 0;
  let idleHandle: TimerHandle | null = null;
  let closing = false;
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

  // Initial snapshot before accepting clients (rev 0 → 1).
  await recompute();
  const unwatch = deps.watch(() => {
    void recompute();
  });

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

  const server = await listenFrameServer(deps.address, (conn) => {
    activeConns += 1;
    clearIdleTimer();
    conn.onMessage((raw) => {
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
    });
    conn.onClose(() => {
      subscribers.delete(conn);
      activeConns -= 1;
      if (activeConns === 0) {
        armIdleTimer();
      }
    });
  });

  const close = async (): Promise<void> => {
    if (closing) {
      return;
    }
    closing = true;
    clearIdleTimer();
    unwatch();
    await server.close();
    deps.onShutdown?.();
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
