import fs from 'node:fs/promises';
import path from 'node:path';
import { resolveBoardDir } from '../contract/env.js';
import type { AgentsConfig } from '../contract/schema.js';
import { err, ok, type Result } from '../core/result.js';
import type { Git, GitError } from './git.js';
import { activeSessions } from './sessions.js';
import { writeFileIdempotent, type WriteAction } from './board.js';

export type BranchGraphError = {
  readonly message: string;
  readonly cause?: GitError | unknown;
};

export type BranchNode = {
  readonly branch: string;
  readonly exists: boolean;
};

export type SessionBranchNode = BranchNode & {
  readonly id: string;
};

export type GraphState = {
  readonly base: BranchNode;
  readonly integration: BranchNode;
  readonly sessions: SessionBranchNode[];
};

// Reflects REAL git state: every configured branch is probed with branchExists so
// the graph only draws branches that are actually present.
export const collectGraphState = async (
  git: Git,
  config: AgentsConfig,
): Promise<Result<GraphState, BranchGraphError>> => {
  const check = async (branch: string): Promise<Result<boolean, BranchGraphError>> => {
    const result = await git.branchExists(branch);
    return result.ok
      ? ok(result.value)
      : err({ message: `could not check branch '${branch}'`, cause: result.error });
  };

  const base = await check(config.git.baseBranch);
  if (!base.ok) {
    return base;
  }
  const integration = await check(config.git.integrationBranch);
  if (!integration.ok) {
    return integration;
  }
  const sessions: SessionBranchNode[] = [];
  for (const session of activeSessions(config)) {
    const exists = await check(session.branch);
    if (!exists.ok) {
      return exists;
    }
    sessions.push({ id: session.id, branch: session.branch, exists: exists.value });
  }
  return ok({
    base: { branch: config.git.baseBranch, exists: base.value },
    integration: { branch: config.git.integrationBranch, exists: integration.value },
    sessions,
  });
};

// Mermaid dislikes '/' and other special chars in bare branch ids, so every id is
// quoted (and any embedded quote escaped).
const quote = (name: string): string => `"${name.replace(/"/g, '\\"')}"`;

// INTENTIONAL SCHEMATIC, not commit-level history. Mermaid's gitGraph cannot
// reconstruct a real DAG without walking commits; this renders the CONFIGURED
// topology (base -> integration -> one branch per existing session) so the board
// shows how the branches relate, refreshed from live existence checks. The base
// branch is Mermaid's implicit main lane; when integration is absent, session
// branches hang directly off that lane (checked out via its default name 'main').
export const renderMermaid = (state: GraphState): string => {
  const indent = '    ';
  const lines: string[] = ['gitGraph', `${indent}commit`];
  let parentRef = 'main';
  if (state.integration.exists) {
    lines.push(`${indent}branch ${quote(state.integration.branch)}`);
    lines.push(`${indent}checkout ${quote(state.integration.branch)}`);
    lines.push(`${indent}commit`);
    parentRef = quote(state.integration.branch);
  }
  for (const session of state.sessions) {
    if (!session.exists) {
      continue;
    }
    lines.push(`${indent}branch ${quote(session.branch)}`);
    lines.push(`${indent}checkout ${quote(session.branch)}`);
    lines.push(`${indent}commit`);
    lines.push(`${indent}checkout ${parentRef}`);
  }
  return `${lines.join('\n')}\n`;
};

export type BranchGraphWriteResult = {
  readonly action: WriteAction;
  readonly path: string;
};

export const writeBranchGraph = async (
  git: Git,
  config: AgentsConfig,
  projectRoot: string,
): Promise<Result<BranchGraphWriteResult, BranchGraphError>> => {
  const state = await collectGraphState(git, config);
  if (!state.ok) {
    return state;
  }
  const boardDir = resolveBoardDir(projectRoot, config);
  const filePath = path.join(boardDir, 'branches.mmd');
  try {
    await fs.mkdir(boardDir, { recursive: true });
  } catch (error) {
    return err({ message: `could not create board dir ${boardDir}`, cause: error });
  }
  const written = await writeFileIdempotent(filePath, renderMermaid(state.value));
  return written.ok
    ? ok({ action: written.value.action, path: filePath })
    : err({ message: written.error.message, cause: written.error.cause });
};
