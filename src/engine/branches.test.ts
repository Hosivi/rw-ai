import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgentsConfig } from '../contract/schema.js';
import { unwrap, unwrapErr } from '../core/result.test-support.js';
import { ensureIntegrationBranch, ensureSessionBranches } from './branches.js';
import { createGit, type Git } from './git.js';
import { buildConfig, createTempRepo, type TempRepo } from './git.test-support.js';

describe('branch orchestration (integration)', () => {
  let repo: TempRepo;
  let git: Git;

  beforeEach(async () => {
    repo = await createTempRepo();
    git = createGit(repo.root);
  });

  afterEach(async () => {
    await repo.cleanup();
  });

  describe('ensureIntegrationBranch', () => {
    it('creates develop from main, then reports exists on rerun', async () => {
      const config = buildConfig();
      expect(unwrap(await ensureIntegrationBranch(git, config))).toEqual({
        branch: 'develop',
        action: 'created',
      });
      expect(unwrap(await git.branchExists('develop'))).toBe(true);
      expect(unwrap(await ensureIntegrationBranch(git, config))).toEqual({
        branch: 'develop',
        action: 'exists',
      });
    });

    it('fails with a clear message when the base branch is missing', async () => {
      const config = buildConfig({ baseBranch: 'trunk' });
      const error = unwrapErr(await ensureIntegrationBranch(git, config));
      expect(error.message).toContain("'trunk'");
      expect(error.message).toContain('does not exist');
      expect(unwrap(await git.branchExists('develop'))).toBe(false);
    });
  });

  describe('ensureSessionBranches', () => {
    it('creates each active session branch from develop, then reports exists', async () => {
      const config = buildConfig();
      unwrap(await ensureIntegrationBranch(git, config));
      expect(unwrap(await ensureSessionBranches(git, config))).toEqual([
        { sessionId: 's1', branch: 'feat/s1-inicial', action: 'created' },
        { sessionId: 's2', branch: 'feat/s2-inicial', action: 'created' },
      ]);
      expect(unwrap(await git.branchExists('feat/s1-inicial'))).toBe(true);
      expect(unwrap(await git.branchExists('feat/s2-inicial'))).toBe(true);
      const rerun = unwrap(await ensureSessionBranches(git, config));
      expect(rerun.map((entry) => entry.action)).toEqual(['exists', 'exists']);
    });

    it('skips archived sessions', async () => {
      const config = buildConfig();
      const archived: AgentsConfig = {
        ...config,
        sessions: config.sessions.map((session) =>
          session.id === 's2' ? { ...session, status: 'archived' as const } : session,
        ),
      };
      unwrap(await ensureIntegrationBranch(git, archived));
      const results = unwrap(await ensureSessionBranches(git, archived));
      expect(results.map((entry) => entry.sessionId)).toEqual(['s1']);
      expect(unwrap(await git.branchExists('feat/s2-inicial'))).toBe(false);
    });

    it('fails fast naming the session when creation fails', async () => {
      // develop was never created, so the very first session creation fails.
      const config = buildConfig();
      const error = unwrapErr(await ensureSessionBranches(git, config));
      expect(error.sessionId).toBe('s1');
      expect(error.message).toContain('s1');
      expect(error.cause).toBeDefined();
    });
  });
});
