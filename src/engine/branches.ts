import type { AgentsConfig } from '../contract/schema.js';
import { err, ok, type Result } from '../core/result.js';
import type { Git } from './git.js';
import { activeSessions, type SessionOperationError } from './sessions.js';

export type EnsureAction = 'created' | 'exists';

export type IntegrationBranchResult = {
  readonly branch: string;
  readonly action: EnsureAction;
};

export const ensureIntegrationBranch = async (
  git: Git,
  config: AgentsConfig,
): Promise<Result<IntegrationBranchResult, SessionOperationError>> => {
  const { baseBranch, integrationBranch } = config.git;
  const baseExists = await git.branchExists(baseBranch);
  if (!baseExists.ok) {
    return err({ message: `could not check base branch '${baseBranch}'`, cause: baseExists.error });
  }
  if (!baseExists.value) {
    return err({
      message: `base branch '${baseBranch}' does not exist in this repository: git.baseBranch in agents.config.json does not match the repo`,
    });
  }
  const integrationExists = await git.branchExists(integrationBranch);
  if (!integrationExists.ok) {
    return err({
      message: `could not check integration branch '${integrationBranch}'`,
      cause: integrationExists.error,
    });
  }
  if (integrationExists.value) {
    return ok({ branch: integrationBranch, action: 'exists' });
  }
  const created = await git.createBranch(integrationBranch, baseBranch);
  if (!created.ok) {
    return err({
      message: `could not create integration branch '${integrationBranch}' from '${baseBranch}'`,
      cause: created.error,
    });
  }
  return ok({ branch: integrationBranch, action: 'created' });
};

export type SessionBranchResult = {
  readonly sessionId: string;
  readonly branch: string;
  readonly action: EnsureAction;
};

// Idempotent: existing branches are NEVER touched (they may hold session
// work); fails fast naming the offending session.
export const ensureSessionBranches = async (
  git: Git,
  config: AgentsConfig,
): Promise<Result<SessionBranchResult[], SessionOperationError>> => {
  const results: SessionBranchResult[] = [];
  for (const session of activeSessions(config)) {
    const exists = await git.branchExists(session.branch);
    if (!exists.ok) {
      return err({
        message: `could not check branch '${session.branch}' for session ${session.id}`,
        sessionId: session.id,
        cause: exists.error,
      });
    }
    if (exists.value) {
      results.push({ sessionId: session.id, branch: session.branch, action: 'exists' });
      continue;
    }
    const created = await git.createBranch(session.branch, config.git.integrationBranch);
    if (!created.ok) {
      return err({
        message: `could not create branch '${session.branch}' for session ${session.id} from '${config.git.integrationBranch}'`,
        sessionId: session.id,
        cause: created.error,
      });
    }
    results.push({ sessionId: session.id, branch: session.branch, action: 'created' });
  }
  return ok(results);
};
