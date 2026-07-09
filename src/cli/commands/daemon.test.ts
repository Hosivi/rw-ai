import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { daemonAddress } from '../../daemon/address.js';
import { buildConfig } from '../../engine/git.test-support.js';
import { setupMcpRepo, type McpRepo } from '../../mcp/mcp.test-support.js';
import type { CliDeps } from '../command.js';
import { runDaemon } from './daemon.js';

const NOW = new Date('2026-07-09T12:00:00.000Z');

describe('runDaemon --address', () => {
  let mcp: McpRepo;
  beforeEach(async () => {
    mcp = await setupMcpRepo(buildConfig());
  });
  afterEach(async () => {
    await mcp.repo.cleanup();
  });

  const deps = (): CliDeps => ({
    cwd: mcp.repo.root,
    homeDir: mcp.repo.root,
    platform: process.platform,
    env: {},
    now: NOW,
  });

  it('prints the repo daemon address and exits 0 without starting it', async () => {
    const result = await runDaemon({ printAddress: true }, deps());
    expect(result.exitCode).toBe(0);
    expect(result.lines[0]).toBe(daemonAddress(mcp.repo.root, process.platform));
  });

  it('fails with exit 1 outside a configured repo', async () => {
    const result = await runDaemon(
      { printAddress: true },
      { ...deps(), cwd: '/definitely/not/a/repo' },
    );
    expect(result.exitCode).toBe(1);
  });
});
