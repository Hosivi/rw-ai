import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { err, ok, type Result } from '../core/result.js';
import { writeFileAtomic } from '../engine/fs-atomic.js';

// The session status marker is the agent-agnostic signal the read model consumes:
// any agent (or a lifecycle hook) writes it, `rw status` reads it. It lives at
// <boardDir>/sessions/<id>/status.json and is deliberately decoupled from
// agents.config.json — sessionId is a free string here; the aggregate step is
// what cross-checks it against real configured sessions.
export const markerPhaseSchema = z.enum(['idle', 'working', 'blocked', 'review']);
export type MarkerPhase = z.infer<typeof markerPhaseSchema>;

export const markerTestsSchema = z.enum(['passed', 'failed', 'unknown']);
export type MarkerTests = z.infer<typeof markerTestsSchema>;

export const sessionMarkerSchema = z.object({
  version: z.literal(1),
  sessionId: z.string().min(1),
  phase: markerPhaseSchema,
  tests: markerTestsSchema.optional(),
  detail: z.string().optional(),
  updatedAt: z.iso.datetime(),
});
export type SessionMarker = z.infer<typeof sessionMarkerSchema>;

export type InvalidMarkerError = {
  readonly kind: 'invalid-marker';
  readonly message: string;
  readonly issues: string[];
};
export type MarkerIoError = { readonly kind: 'io'; readonly message: string; readonly cause: unknown };
export type MarkerError = InvalidMarkerError | MarkerIoError;

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const invalidMarker = (message: string, error: z.ZodError): InvalidMarkerError => ({
  kind: 'invalid-marker',
  message,
  issues: error.issues.map((issue) => {
    const at = issue.path.length > 0 ? issue.path.map(String).join('.') : '(root)';
    return `${at}: ${issue.message}`;
  }),
});

export const parseSessionMarker = (input: unknown): Result<SessionMarker, InvalidMarkerError> => {
  const parsed = sessionMarkerSchema.safeParse(input);
  return parsed.success ? ok(parsed.data) : err(invalidMarker('Invalid session marker', parsed.error));
};

export const sessionMarkerPath = (boardDir: string, sessionId: string): string =>
  path.join(boardDir, 'sessions', sessionId, 'status.json');

// Validate before writing so a bad marker never reaches disk (and never creates
// the session dir); serialize with a trailing newline like the other board files.
export const writeSessionMarker = async (
  boardDir: string,
  marker: SessionMarker,
): Promise<Result<void, MarkerError>> => {
  const parsed = parseSessionMarker(marker);
  if (!parsed.ok) {
    return parsed;
  }
  const target = sessionMarkerPath(boardDir, parsed.value.sessionId);
  try {
    await fs.mkdir(path.dirname(target), { recursive: true });
  } catch (error) {
    return err({ kind: 'io', message: `could not create marker dir: ${errorMessage(error)}`, cause: error });
  }
  const written = await writeFileAtomic(target, `${JSON.stringify(parsed.value, null, 2)}\n`);
  return written.ok
    ? ok(undefined)
    : err({ kind: 'io', message: written.error.message, cause: written.error.cause });
};

// Missing marker is a normal state (session not started yet) → ok(null).
export const readSessionMarker = async (
  boardDir: string,
  sessionId: string,
): Promise<Result<SessionMarker | null, MarkerError>> => {
  const target = sessionMarkerPath(boardDir, sessionId);
  let raw: string;
  try {
    raw = await fs.readFile(target, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return ok(null);
    }
    return err({ kind: 'io', message: `could not read marker: ${errorMessage(error)}`, cause: error });
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (error) {
    return err({ kind: 'invalid-marker', message: `marker is not valid JSON: ${errorMessage(error)}`, issues: [] });
  }
  return parseSessionMarker(json);
};
