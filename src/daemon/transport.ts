import fs from 'node:fs';
import net from 'node:net';
import { createFrameDecoder, encodeFrame } from './frames.js';

// One bidirectional framed connection over a net.Socket. Both the server's
// per-client sockets and the client's own socket are wrapped the same way.
export type Conn = {
  readonly send: (value: unknown) => void;
  readonly onMessage: (handler: (value: unknown) => void) => void;
  readonly onClose: (handler: () => void) => void;
  readonly close: () => void;
};

const isNamedPipe = (address: string): boolean => address.startsWith('\\\\.\\pipe\\');

const wrapSocket = (socket: net.Socket): Conn => {
  const decoder = createFrameDecoder();
  const messageHandlers: Array<(value: unknown) => void> = [];
  const closeHandlers: Array<() => void> = [];

  socket.on('data', (chunk: Buffer) => {
    let frames: unknown[];
    try {
      frames = decoder.push(chunk);
    } catch {
      // A corrupt/over-cap stream is unrecoverable for this connection: drop it
      // rather than let a bad frame poison the decoder or crash the process.
      socket.destroy();
      return;
    }
    for (const frame of frames) {
      for (const handler of messageHandlers) {
        try {
          handler(frame);
        } catch {
          // A throwing handler must not tear down the read loop or crash the
          // process; the handler owns its own error semantics.
        }
      }
    }
  });
  // A socket 'error' with no listener crashes the process; swallow it and let the
  // 'close' that follows drive cleanup.
  socket.on('error', () => undefined);
  socket.on('close', () => {
    for (const handler of closeHandlers) handler();
  });

  return {
    send: (value) => {
      if (!socket.destroyed && socket.writable) socket.write(encodeFrame(value));
    },
    onMessage: (handler) => {
      messageHandlers.push(handler);
    },
    onClose: (handler) => {
      closeHandlers.push(handler);
    },
    close: () => socket.destroy(),
  };
};

export type FrameServer = {
  readonly address: string;
  readonly broadcast: (value: unknown) => void;
  readonly clientCount: () => number;
  readonly close: () => Promise<void>;
};

// Bound the number of concurrent local clients; a local peer opening endless
// connections is a memory/FD-exhaustion vector otherwise (the clients are the
// user's own editor/status, so this is generous).
const DEFAULT_MAX_CONNECTIONS = 64;

// Is something already accepting connections at this address? Used to tell a
// stale unix socket file (crashed daemon → safe to unlink) from a live one
// (another daemon → must NOT clobber). Never unlinks; just probes.
const probeAlive = (address: string): Promise<boolean> =>
  new Promise((resolve) => {
    const socket = net.connect(address);
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => resolve(false));
  });

export type ListenOptions = { readonly maxConnections?: number };

// Listen for framed connections. Single-instance-safe: instead of unconditionally
// unlinking the socket file (which would clobber a LIVE daemon), it only unlinks a
// stale one after an EADDRINUSE + a failed liveness probe. A live owner surfaces
// EADDRINUSE to the caller. Named pipes are freed by the OS on exit, so they take
// the plain error path.
export const listenFrameServer = async (
  address: string,
  onConnection: (conn: Conn) => void,
  options: ListenOptions = {},
): Promise<FrameServer> => {
  const conns = new Set<Conn>();
  const createAndListen = (): Promise<net.Server> =>
    new Promise((resolve, reject) => {
      const server = net.createServer((socket) => {
        const conn = wrapSocket(socket);
        conns.add(conn);
        conn.onClose(() => conns.delete(conn));
        onConnection(conn);
      });
      server.maxConnections = options.maxConnections ?? DEFAULT_MAX_CONNECTIONS;
      server.once('error', reject);
      server.listen(address, () => {
        server.removeListener('error', reject);
        server.on('error', () => undefined); // keep serving on later socket errors
        resolve(server);
      });
    });

  let server: net.Server;
  try {
    server = await createAndListen();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EADDRINUSE' && !isNamedPipe(address) && !(await probeAlive(address))) {
      // Stale socket file from a crashed daemon: safe to reclaim.
      try {
        fs.unlinkSync(address);
      } catch {
        // lost the race; the retry will surface any real problem
      }
      server = await createAndListen();
    } else {
      throw error; // a live daemon owns it (or a non-recoverable error)
    }
  }

  // Restrict the unix socket to the owner so another local user cannot read repo
  // state off it. Windows named pipes don't expose this via net (documented gap).
  if (!isNamedPipe(address)) {
    try {
      fs.chmodSync(address, 0o600);
    } catch {
      // best-effort; some filesystems reject chmod
    }
  }

  return {
    address,
    broadcast: (value) => {
      for (const conn of conns) conn.send(value);
    },
    clientCount: () => conns.size,
    close: () =>
      new Promise((res) => {
        for (const conn of conns) conn.close();
        server.close(() => res());
      }),
  };
};

// Connect to a daemon. Rejects if nothing is listening (ENOENT/ECONNREFUSED) so
// callers can fall back to a one-shot compute (WU-2.5).
export const connectFrameClient = (address: string): Promise<Conn> =>
  new Promise((resolve, reject) => {
    const socket = net.connect(address);
    const onError = (error: unknown): void => {
      socket.removeListener('connect', onConnect);
      reject(error);
    };
    const onConnect = (): void => {
      socket.removeListener('error', onError);
      resolve(wrapSocket(socket));
    };
    socket.once('error', onError);
    socket.once('connect', onConnect);
  });
