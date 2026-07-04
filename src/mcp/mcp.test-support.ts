import fs from 'node:fs/promises';
import path from 'node:path';
import { resolveBoardDir } from '../contract/env.js';
import type { AgentsConfig } from '../contract/schema.js';
import { unwrap } from '../core/result.test-support.js';
import { writeAgentsConfig } from '../engine/config-io.js';
import { createGit } from '../engine/git.js';
import { createTempRepo, type TempRepo } from '../engine/git.test-support.js';

export type McpRepo = {
  readonly repo: TempRepo;
  readonly config: AgentsConfig;
  // Absolute path to a session's real worktree, mirroring how an agent would be
  // launched from inside it.
  readonly worktreePath: (sessionId: string) => string;
};

// Provision a temp repo whose agents.config.json, integration branch, board dir,
// and per-session worktrees are all REAL, so resolveMcpContext and the tool
// handlers can be exercised end-to-end against actual git state. The board dir is
// created up front because claimRole never mkdirs it (identity.ts provisions it
// earlier in the real flow).
export const setupMcpRepo = async (config: AgentsConfig): Promise<McpRepo> => {
  const repo = await createTempRepo();
  unwrap(await writeAgentsConfig(repo.root, config));
  await fs.mkdir(resolveBoardDir(repo.root, config), { recursive: true });

  const git = createGit(repo.root);
  const integration = config.git.integrationBranch;
  unwrap(await git.createBranch(integration, 'main'));
  for (const session of config.sessions) {
    unwrap(await git.createBranch(session.branch, integration));
    unwrap(await git.addWorktree(path.join(repo.root, session.worktree), session.branch));
  }

  const worktreePath = (sessionId: string): string => {
    const session = config.sessions.find((candidate) => candidate.id === sessionId);
    if (session === undefined) {
      throw new Error(`no session '${sessionId}' in the test config`);
    }
    return path.join(repo.root, session.worktree);
  };

  return { repo, config, worktreePath };
};
