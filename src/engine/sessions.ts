import type { AgentsConfig, Session } from '../contract/schema.js';
import type { GitError } from './git.js';

// Archived sessions keep their branch and history but must never be
// provisioned again — every per-session orchestration loop iterates these.
export const activeSessions = (config: AgentsConfig): Session[] =>
  config.sessions.filter((session) => session.status === 'active');

// One error shape for all per-session git orchestration: a human-readable
// message (English data — the CLI layer renders Spanish), the offending
// session when one is known, and the git-level cause.
export type SessionOperationError = {
  readonly message: string;
  readonly sessionId?: string;
  readonly cause?: GitError;
};
