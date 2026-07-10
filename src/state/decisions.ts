import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { sessionIdSchema } from '../contract/schema.js';
import { err, ok, type Result } from '../core/result.js';
import { writeFileAtomic } from '../engine/fs-atomic.js';

// A review decision recorded by the integrator (WU-3.5). Append-only records under
// <boardDir>/decisions/; the integrator claim is released separately by the caller.
export const decisionVerdictSchema = z.enum(['approved', 'rejected']);
export type DecisionVerdict = z.infer<typeof decisionVerdictSchema>;

export const decisionSchema = z.object({
  version: z.literal(1),
  // Strict id (^s[1-9][0-9]*$): sessionId is part of the on-disk filename, so a
  // lax value would be a path-traversal sink (same guard as the status marker).
  sessionId: sessionIdSchema,
  verdict: decisionVerdictSchema,
  comment: z.string().optional(),
  decidedAt: z.iso.datetime(),
  reviewer: z.string().optional(),
});
export type Decision = z.infer<typeof decisionSchema>;

export type DecisionError =
  | { readonly kind: 'invalid-decision'; readonly message: string; readonly issues: string[] }
  | { readonly kind: 'io'; readonly message: string; readonly cause: unknown };

const errorMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export const parseDecision = (input: unknown): Result<Decision, DecisionError> => {
  const parsed = decisionSchema.safeParse(input);
  return parsed.success
    ? ok(parsed.data)
    : err({
        kind: 'invalid-decision',
        message: 'Invalid decision',
        issues: parsed.error.issues.map((i) => `${i.path.map(String).join('.') || '(root)'}: ${i.message}`),
      });
};

const decisionsDir = (boardDir: string): string => path.join(boardDir, 'decisions');

// Filesystem-safe unique filename: session id + the decision timestamp with the
// characters that are illegal on Windows (`:`) replaced.
const decisionFileName = (decision: Decision): string =>
  `${decision.sessionId}-${decision.decidedAt.replace(/[:.]/g, '-')}.json`;

export const writeDecision = async (
  boardDir: string,
  decision: Decision,
): Promise<Result<void, DecisionError>> => {
  const parsed = parseDecision(decision);
  if (!parsed.ok) {
    return parsed;
  }
  const dir = decisionsDir(boardDir);
  try {
    await fs.mkdir(dir, { recursive: true });
  } catch (e) {
    return err({ kind: 'io', message: `could not create decisions dir: ${errorMessage(e)}`, cause: e });
  }
  const target = path.join(dir, decisionFileName(parsed.value));
  const written = await writeFileAtomic(target, `${JSON.stringify(parsed.value, null, 2)}\n`);
  return written.ok
    ? ok(undefined)
    : err({ kind: 'io', message: written.error.message, cause: written.error.cause });
};

// All decisions for a session, newest first. A missing dir is an empty list.
export const readDecisions = async (
  boardDir: string,
  sessionId: string,
): Promise<Result<Decision[], DecisionError>> => {
  const dir = decisionsDir(boardDir);
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
      return ok([]);
    }
    return err({ kind: 'io', message: `could not read decisions: ${errorMessage(e)}`, cause: e });
  }
  const decisions: Decision[] = [];
  for (const entry of entries) {
    if (!entry.startsWith(`${sessionId}-`) || !entry.endsWith('.json')) {
      continue;
    }
    let raw: string;
    try {
      raw = await fs.readFile(path.join(dir, entry), 'utf8');
    } catch {
      continue; // a transiently unreadable record shouldn't fail the whole list
    }
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      continue;
    }
    const parsed = parseDecision(json);
    if (parsed.ok) {
      decisions.push(parsed.value);
    }
  }
  decisions.sort((a, b) => (a.decidedAt < b.decidedAt ? 1 : -1)); // newest first
  return ok(decisions);
};
