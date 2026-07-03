import type { Dirent } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { err, ok, type Result } from '../core/result.js';
import { normalizeRepoPath } from './git.js';

// A single Claude Code background job, reduced to the fields we surface. Every
// field but the id is optional because state.json is Claude Code INTERNAL and may
// rename, drop, or reshape fields across versions — the reader tolerates all of
// that. We deliberately never carry prompt/token content into this shape.
export type ClaudeSession = {
  readonly id: string;
  readonly cwd?: string;
  readonly state?: string;
  readonly name?: string;
  readonly updatedAt?: string;
  readonly createdAt?: string;
  readonly intent?: string;
  readonly inFlight?: boolean;
};

// Only raised when the jobs directory cannot even be enumerated (permissions, a
// file where the dir should be). A missing dir is NOT an error — see below.
export type ClaudeSessionsError = {
  readonly kind: 'io';
  readonly message: string;
  readonly cause?: unknown;
};

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

// Claude Code keeps each job at ~/.claude/jobs/<jobId>/state.json (plus non-job
// files like pins.json at the root, which we skip).
export const claudeJobsDir = (homeDir: string): string => path.join(homeDir, '.claude', 'jobs');

// Defensive coercions: a field that is not the expected primitive is treated as
// absent rather than trusted, so a reshaped state.json can never inject a wrong
// type into the listing.
const asString = (value: unknown): string | undefined =>
  typeof value === 'string' ? value : undefined;

const asBoolean = (value: unknown): boolean | undefined =>
  typeof value === 'boolean' ? value : undefined;

const buildSession = (id: string, record: Record<string, unknown>): ClaudeSession => {
  const cwd = asString(record.cwd);
  const state = asString(record.state);
  const name = asString(record.name);
  const updatedAt = asString(record.updatedAt);
  const createdAt = asString(record.createdAt);
  const intent = asString(record.intent);
  const inFlight = asBoolean(record.inFlight);
  // Conditional spreads keep absent fields off the object entirely instead of
  // stamping explicit `undefined`s — matching the rest of the codebase.
  return {
    id,
    ...(cwd !== undefined ? { cwd } : {}),
    ...(state !== undefined ? { state } : {}),
    ...(name !== undefined ? { name } : {}),
    ...(updatedAt !== undefined ? { updatedAt } : {}),
    ...(createdAt !== undefined ? { createdAt } : {}),
    ...(intent !== undefined ? { intent } : {}),
    ...(inFlight !== undefined ? { inFlight } : {}),
  };
};

// Read one job's state.json. Any failure — no state.json (so the dir is not a
// job), an unreadable file, malformed JSON, or a non-object payload — yields
// undefined so a single bad job is skipped and the whole listing survives.
const readJob = async (jobsDir: string, id: string): Promise<ClaudeSession | undefined> => {
  const statePath = path.join(jobsDir, id, 'state.json');
  let raw: string;
  try {
    raw = await fs.readFile(statePath, 'utf8');
  } catch {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return undefined;
  }
  return buildSession(id, parsed as Record<string, unknown>);
};

// Most recently active first. A job with no updatedAt has unknown recency, so it
// sorts after every timestamped job; ties (including two undated jobs) break by
// id so the order is stable and deterministic. ISO-8601 strings compare
// correctly lexicographically, so no Date parsing is needed.
const sortSessions = (sessions: readonly ClaudeSession[]): ClaudeSession[] =>
  [...sessions].sort((a, b) => {
    if (a.updatedAt !== b.updatedAt) {
      if (a.updatedAt === undefined) {
        return 1;
      }
      if (b.updatedAt === undefined) {
        return -1;
      }
      return a.updatedAt < b.updatedAt ? 1 : -1;
    }
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });

export const listClaudeSessions = async (
  homeDir: string,
): Promise<Result<ClaudeSession[], ClaudeSessionsError>> => {
  const jobsDir = claudeJobsDir(homeDir);
  let entries: Dirent[];
  try {
    entries = await fs.readdir(jobsDir, { withFileTypes: true });
  } catch (error) {
    // ENOENT = the machine has never run a background job. That is an empty
    // listing, not a failure. Any other error is a genuine enumeration problem.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return ok([]);
    }
    return err({ kind: 'io', message: `could not read ${jobsDir}: ${errorMessage(error)}`, cause: error });
  }
  const sessions: ClaudeSession[] = [];
  for (const entry of entries) {
    // Only DIRECTORIES are candidate jobs; a file like pins.json at the root is
    // not. readJob then confirms the dir actually holds a readable state.json.
    if (!entry.isDirectory()) {
      continue;
    }
    const session = await readJob(jobsDir, entry.name);
    if (session !== undefined) {
      sessions.push(session);
    }
  }
  return ok(sortSessions(sessions));
};

// Keep sessions whose cwd equals the target OR is nested under it. rw runs inside
// worktrees NESTED under the project root, so a Claude job whose cwd is a worktree
// (e.g. E:/repos/app/.worktrees/s1) must still show up under the project root
// (E:/repos/app) — hence prefix matching, not exact equality. The '/' boundary is
// what stops 'E:/repos/app' from also matching a sibling 'E:/repos/app-other'.
export const filterByCwd = (
  sessions: readonly ClaudeSession[],
  targetPath: string,
): ClaudeSession[] => {
  const target = normalizeRepoPath(targetPath);
  return sessions.filter((session) => {
    if (session.cwd === undefined) {
      return false;
    }
    const cwd = normalizeRepoPath(session.cwd);
    return cwd === target || cwd.startsWith(`${target}/`);
  });
};
