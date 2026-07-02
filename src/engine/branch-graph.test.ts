import { existsSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { unwrap } from '../core/result.test-support.js';
import { ensureIntegrationBranch } from './branches.js';
import { collectGraphState, renderMermaid, writeBranchGraph } from './branch-graph.js';
import { createGit, type Git } from './git.js';
import { buildConfig, createTempRepo, type TempRepo } from './git.test-support.js';

describe('branch graph (integration)', () => {
  let repo: TempRepo;
  let git: Git;

  beforeEach(async () => {
    repo = await createTempRepo();
    git = createGit(repo.root);
  });

  afterEach(async () => {
    await repo.cleanup();
  });

  describe('collectGraphState', () => {
    it('marks base, integration and only the session branches that exist', async () => {
      const config = buildConfig();
      // develop off main, and only s1's branch off develop; s2 stays absent.
      unwrap(await ensureIntegrationBranch(git, config));
      unwrap(await git.createBranch('feat/s1-inicial', 'develop'));

      const state = unwrap(await collectGraphState(git, config));
      expect(state.base).toEqual({ branch: 'main', exists: true });
      expect(state.integration).toEqual({ branch: 'develop', exists: true });
      const s1 = state.sessions.find((session) => session.id === 's1');
      const s2 = state.sessions.find((session) => session.id === 's2');
      expect(s1).toEqual({ id: 's1', branch: 'feat/s1-inicial', exists: true });
      expect(s2).toEqual({ id: 's2', branch: 'feat/s2-inicial', exists: false });
    });
  });

  describe('renderMermaid', () => {
    it('emits a gitGraph with quoted branch ids for existing branches only', async () => {
      const config = buildConfig();
      unwrap(await ensureIntegrationBranch(git, config));
      unwrap(await git.createBranch('feat/s1-inicial', 'develop'));
      const state = unwrap(await collectGraphState(git, config));

      const mermaid = renderMermaid(state);
      expect(mermaid.startsWith('gitGraph')).toBe(true);
      expect(mermaid).toContain('"develop"');
      expect(mermaid).toContain('branch "feat/s1-inicial"');
      // s2's branch does not exist, so it must not be drawn.
      expect(mermaid).not.toContain('feat/s2-inicial');
    });
  });

  describe('writeBranchGraph', () => {
    it('writes branches.mmd, then reports unchanged on a second run', async () => {
      const config = buildConfig();
      unwrap(await ensureIntegrationBranch(git, config));
      unwrap(await git.createBranch('feat/s1-inicial', 'develop'));

      const created = unwrap(await writeBranchGraph(git, config, repo.root));
      expect(created.action).toBe('created');
      expect(created.path).toBe(path.join(repo.root, '.review-board', 'branches.mmd'));
      expect(existsSync(created.path)).toBe(true);

      const rerun = unwrap(await writeBranchGraph(git, config, repo.root));
      expect(rerun.action).toBe('unchanged');
    });
  });
});
