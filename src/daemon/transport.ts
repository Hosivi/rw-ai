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
      for (const handler of messageHandlers) handler(frame);
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

// Listen for framed connections. On Unix a stale socket file from a crashed
// daemon would block listen with EADDRINUSE, so it is unlinked first; the
// single-instance guard that avoids clobbering a LIVE daemon is layered on top
// in WU-2.2 (connect-probe before listen). Named pipes need no such unlink.
export const listenFrameServer = (
  address: string,
  onConnection: (conn: Conn) => void,
): Promise<FrameServer> => {
  if (!isNamedPipe(address)) {
    try {
      fs.unlinkSync(address);
    } catch {
      // ENOENT (no stale file) is the normal case; ignore.
    }
  }
  return new Promise((resolve, reject) => {
    const conns = new Set<Conn>();
    const server = net.createServer((socket) => {
      const conn = wrapSocket(socket);
      conns.add(conn);
      conn.onClose(() => conns.delete(conn));
      onConnection(conn);
    });
    server.once('error', reject);
    server.listen(address, () => {
      server.removeListener('error', reject);
      // Keep serving even if an individual client socket errors later.
      server.on('error', () => undefined);
      resolve({
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
      });
    });
  });
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
