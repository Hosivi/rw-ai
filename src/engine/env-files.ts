import fs from 'node:fs/promises';
import path from 'node:path';
import { sessionEnvEntries } from '../contract/env.js';
import type { AgentsConfig } from '../contract/schema.js';
import { err, ok, type Result } from '../core/result.js';
import { activeSessions } from './sessions.js';

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

// The per-session env filename. Single source of truth so the writer here and
// the info/exclude ignore pattern (configure.ts) can never drift apart, in the
// same spirit as PORT_BAND_NAMES.
export const SESSION_ENV_FILENAME = '.env.local';

// Everything between these markers is owned by rw-ai and rewritten on every
// run; everything outside them is user territory and preserved byte-for-byte.
export const MANAGED_BLOCK_START = '# >>> rw-ai managed >>>';
export const MANAGED_BLOCK_END = '# <<< rw-ai managed <<<';

export type EnvFileAction = 'created' | 'updated' | 'unchanged';

export type EnvFileError = {
  readonly message: string;
  readonly cause?: unknown;
};

// LF-joined, no trailing newline: upsertEnvFile owns the byte that follows
// the closing marker (existing files may continue after the block).
export const renderManagedBlock = (
  entries: ReadonlyArray<readonly [string, string]>,
): string =>
  [MANAGED_BLOCK_START, ...entries.map(([key, value]) => `${key}=${value}`), MANAGED_BLOCK_END].join(
    '\n',
  );

const containsOnlyNewlines = (text: string): boolean => /^[\r\n]*$/.test(text);

// Pure block merge; fs concerns stay in upsertEnvFile. The err variant is a
// human-readable reason (marker corruption), not an fs failure.
const mergeManagedBlock = (content: string, block: string): Result<string, string> => {
  const startIdx = content.indexOf(MANAGED_BLOCK_START);
  const endIdx = content.indexOf(MANAGED_BLOCK_END);
  if (startIdx === -1 && endIdx === -1) {
    // No block yet: append after the user's content with one separating blank
    // line. The trailing newline run is collapsed to its last terminator (a
    // CRLF terminator stays CRLF) so repeated runs never accumulate blank lines.
    const body = content.replace(/(\r?\n)(?:\r?\n)*$/, '$1');
    const separator = body === '' ? '' : body.endsWith('\n') ? '\n' : '\n\n';
    return ok(`${body}${separator}${block}\n`);
  }
  if (startIdx === -1 || endIdx === -1 || endIdx < startIdx) {
    return err(
      `managed block markers are corrupted (found ${startIdx === -1 ? 'end' : 'start'} marker without a matching counterpart); fix or remove the '${MANAGED_BLOCK_START}' block by hand`,
    );
  }
  const before = content.slice(0, startIdx);
  const after = content.slice(endIdx + MANAGED_BLOCK_END.length);
  // Block at EOF: normalize to exactly one trailing newline. User content
  // after the block: preserve byte-for-byte, only guaranteeing a final newline.
  const tail = containsOnlyNewlines(after) ? '\n' : after.endsWith('\n') ? after : `${after}\n`;
  return ok(`${before}${block}${tail}`);
};

export const upsertEnvFile = async (
  filePath: string,
  entries: ReadonlyArray<readonly [string, string]>,
): Promise<Result<{ action: EnvFileAction }, EnvFileError>> => {
  const block = renderManagedBlock(entries);
  let existing: string | null = null;
  try {
    existing = await fs.readFile(filePath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      return err({ message: `could not read ${filePath}: ${errorMessage(error)}`, cause: error });
    }
  }
  let next: string;
  if (existing === null) {
    next = `${block}\n`;
  } else {
    const merged = mergeManagedBlock(existing, block);
    if (!merged.ok) {
      return err({ message: `${merged.error} in ${filePath}` });
    }
    if (merged.value === existing) {
      // Skipping the no-op write is required, not an optimization: dev-server
      // file watchers restart on any touch of .env.local even when the bytes
      // are identical.
      return ok({ action: 'unchanged' });
    }
    next = merged.value;
  }
  try {
    // No mkdir: the parent worktree is provisioned earlier in the flow, so a
    // missing directory is a real error worth surfacing, not one to paper over.
    await fs.writeFile(filePath, next, 'utf8');
  } catch (error) {
    return err({ message: `could not write ${filePath}: ${errorMessage(error)}`, cause: error });
  }
  return ok({ action: existing === null ? 'created' : 'updated' });
};

export type SessionEnvFileResult = {
  readonly sessionId: string;
  readonly filePath: string;
  readonly action: EnvFileAction;
};

export type EnvFileOperationError = {
  readonly message: string;
  readonly sessionId?: string;
  readonly cause?: unknown;
};

export const writeSessionEnvFiles = async (
  config: AgentsConfig,
  projectRoot: string,
): Promise<Result<SessionEnvFileResult[], EnvFileOperationError>> => {
  const results: SessionEnvFileResult[] = [];
  for (const session of activeSessions(config)) {
    const filePath = path.join(projectRoot, session.worktree, SESSION_ENV_FILENAME);
    const upserted = await upsertEnvFile(filePath, sessionEnvEntries(config, session, projectRoot));
    if (!upserted.ok) {
      return err({
        message: `could not write .env.local for session ${session.id}: ${upserted.error.message}`,
        sessionId: session.id,
        cause: upserted.error.cause,
      });
    }
    results.push({ sessionId: session.id, filePath, action: upserted.value.action });
  }
  return ok(results);
};
