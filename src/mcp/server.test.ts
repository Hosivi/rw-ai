import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildConfig } from '../engine/git.test-support.js';
import { createRwMcpServer } from './server.js';
import { setupMcpRepo, type McpRepo } from './mcp.test-support.js';

const NOW = new Date('2026-07-03T12:00:00.000Z');

// A connected client/server pair over an in-memory transport, plus a helper that
// calls a tool and parses its JSON text payload. The server's cwd is pinned to a
// session worktree and its env starts empty so the in-memory token — not RW_TOKEN
// — is what identity resolves against.
const connect = async (mcp: McpRepo) => {
  const server = createRwMcpServer({
    cwd: () => mcp.worktreePath('s1'),
    now: () => NOW,
    env: {},
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  await client.connect(clientTransport);

  const call = async (
    name: string,
    args: Record<string, unknown> = {},
  ): Promise<{ isError: boolean; payload: Record<string, unknown> }> => {
    const result = await client.callTool({ name, arguments: args });
    const first = (result.content as Array<{ type: string; text?: string }>)[0];
    return {
      isError: result.isError === true,
      payload: JSON.parse(first?.text ?? 'null') as Record<string, unknown>,
    };
  };

  return { client, server, call };
};

describe('createRwMcpServer', () => {
  it('constructs an McpServer with the default (process) deps', () => {
    expect(createRwMcpServer()).toBeInstanceOf(McpServer);
  });
});

describe('rw MCP server (round trip)', () => {
  let mcp: McpRepo;

  beforeEach(async () => {
    mcp = await setupMcpRepo(buildConfig({ integrationBranch: 'develop' }));
  });

  afterEach(async () => {
    await mcp.repo.cleanup();
  });

  it('exposes the ten rw tools', async () => {
    const { client } = await connect(mcp);
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual([
      'rw_add_remote',
      'rw_bootstrap',
      'rw_check',
      'rw_claim',
      'rw_finish',
      'rw_lane_check',
      'rw_release',
      'rw_roles',
      'rw_status',
      'rw_whoami',
    ]);
  });

  it('rw_add_remote attaches a remote to the shared root', async () => {
    const { call } = await connect(mcp);
    const { isError, payload } = await call('rw_add_remote', {
      url: 'https://example.test/repo.git',
    });
    expect(isError).toBe(false);
    expect(payload).toMatchObject({ ok: true, name: 'origin', url: 'https://example.test/repo.git' });
  });

  it('rw_bootstrap refuses from inside a session worktree', async () => {
    // The server cwd is pinned to the s1 worktree, so bootstrap must detect it is
    // inside a session and refuse rather than re-init anything.
    const { call } = await connect(mcp);
    const { isError, payload } = await call('rw_bootstrap');
    expect(isError).toBe(true);
    expect(payload.ok).toBe(false);
    expect((payload.error as { kind: string }).kind).toBe('inside-worktree');
  });

  it('rw_status resolves the shared root and the current session', async () => {
    const { call } = await connect(mcp);
    const { isError, payload } = await call('rw_status');
    expect(isError).toBe(false);
    expect(payload.ok).toBe(true);
    expect((payload.currentSession as { id: string }).id).toBe('s1');
  });

  it('keeps the claimed token in memory so rw_whoami resolves it (no RW_TOKEN)', async () => {
    const { call } = await connect(mcp);
    const claim = await call('rw_claim');
    expect(claim.payload.role).toBe('s1');

    // whoami passes no token; only the server's in-memory token from rw_claim can
    // make this resolve to s1.
    const who = await call('rw_whoami');
    expect(who.payload.role).toBe('s1');
  });

  it('surfaces a handler failure as isError with a flattened error', async () => {
    const { call } = await connect(mcp);
    // lane-check has no session context problem here (cwd is s1), but claiming an
    // unknown role is a clean engine failure surfaced as a tool error.
    const { isError, payload } = await call('rw_claim', { role: 'nope' });
    expect(isError).toBe(true);
    expect(payload.ok).toBe(false);
    expect((payload.error as { kind: string }).kind).toBe('invalid-role');
  });
});
