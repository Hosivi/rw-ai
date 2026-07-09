import os from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { daemonAddress } from './address.js';
import { connectFrameClient, listenFrameServer, type FrameServer } from './transport.js';

// Unique per-repo address per test so nothing collides on the pipe/socket namespace.
let seq = 0;
const freshAddress = (): string =>
  daemonAddress(`/transport-test/${process.pid}/${seq++}`, process.platform, os.tmpdir());

const nextMessage = (conn: { onMessage: (h: (v: unknown) => void) => void }): Promise<unknown> =>
  new Promise((resolve) => conn.onMessage(resolve));

let servers: FrameServer[] = [];
afterEach(async () => {
  await Promise.all(servers.map((s) => s.close()));
  servers = [];
});

describe('frame transport (net pipe/socket)', () => {
  it('round-trips a message client → server → client (echo)', async () => {
    const address = freshAddress();
    const server = await listenFrameServer(address, (conn) => {
      conn.onMessage((value) => conn.send({ echo: value }));
    });
    servers.push(server);

    const client = await connectFrameClient(address);
    const reply = nextMessage(client);
    client.send({ ping: 1 });
    expect(await reply).toEqual({ echo: { ping: 1 } });
    client.close();
  });

  it('broadcasts one message to every connected client', async () => {
    const address = freshAddress();
    const server = await listenFrameServer(address, () => undefined);
    servers.push(server);

    const a = await connectFrameClient(address);
    const b = await connectFrameClient(address);
    const gotA = nextMessage(a);
    const gotB = nextMessage(b);

    // Wait until the server has registered both connections, then broadcast.
    await vi.waitFor(() => expect(server.clientCount()).toBe(2));
    server.broadcast({ tick: 7 });

    expect(await gotA).toEqual({ tick: 7 });
    expect(await gotB).toEqual({ tick: 7 });
    a.close();
    b.close();
  });

  it('reports a closed client so the server drops it', async () => {
    const address = freshAddress();
    const server = await listenFrameServer(address, () => undefined);
    servers.push(server);

    const client = await connectFrameClient(address);
    await vi.waitFor(() => expect(server.clientCount()).toBe(1));
    client.close();
    await vi.waitFor(() => expect(server.clientCount()).toBe(0));
  });

  it('rejects connecting when no server is listening', async () => {
    await expect(connectFrameClient(freshAddress())).rejects.toBeTruthy();
  });
});
