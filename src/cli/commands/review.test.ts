import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveBoardDir } from '../../contract/env.js';
import { unwrap } from '../../core/result.test-support.js';
import { buildConfig } from '../../engine/git.test-support.js';
import { setupMcpRepo, type McpRepo } from '../../mcp/mcp.test-support.js';
import { readDecisions } from '../../state/decisions.js';
import type { CliDeps } from '../command.js';
import { runBlast, runDecide, runReviewInfo } from './review.js';

const NOW = new Date('2026-07-09T12:00:00.000Z');

describe('review commands', () => {
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

  describe('runDecide', () => {
    it('records a decision and releases the integrator', async () => {
      const result = await runDecide(
        { session: 's1', verdict: 'approved', comment: 'lgtm' },
        deps(),
      );
      expect(result.exitCode).toBe(0);
      expect(result.lines[0]).toContain('aprobada');

      const boardDir = resolveBoardDir(mcp.repo.root, mcp.config);
      const decisions = unwrap(await readDecisions(boardDir, 's1'));
      expect(decisions).toHaveLength(1);
      expect(decisions[0]?.verdict).toBe('approved');
      expect(decisions[0]?.comment).toBe('lgtm');
    });

    it('requires a verdict', async () => {
      const result = await runDecide({ session: 's1', verdict: undefined, comment: undefined }, deps());
      expect(result.exitCode).toBe(2);
    });

    it('rejects an unknown session', async () => {
      const result = await runDecide({ session: 's9', verdict: 'approved', comment: undefined }, deps());
      expect(result.exitCode).toBe(1);
      expect(result.lines[0]).toContain('desconocida');
    });
  });

  describe('runReviewInfo', () => {
    it('requires a session', async () => {
      const result = await runReviewInfo({ session: undefined, json: false }, deps());
      expect(result.exitCode).toBe(2);
    });

    it('rejects an unknown session', async () => {
      const result = await runReviewInfo({ session: 's9', json: false }, deps());
      expect(result.exitCode).toBe(1);
    });
  });

  describe('runBlast', () => {
    it('requires a session', async () => {
      expect((await runBlast({ session: undefined }, deps())).exitCode).toBe(2);
    });
    it('rejects an unknown session', async () => {
      expect((await runBlast({ session: 's9' }, deps())).exitCode).toBe(1);
    });
  });
});
