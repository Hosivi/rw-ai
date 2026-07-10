import path from 'node:path';
import fs from 'node:fs/promises';
import { z } from 'zod';
import { runCommandRaw, type CommandRunner } from '../engine/exec.js';
import type { CodeGraph } from './blast-radius.js';

// WU-4.1: query CodeGraph through its OWN interface (the `codegraph` CLI), never a
// direct read of `.codegraph/codegraph.db` (a versioned internal schema that could
// break). Any failure — no index, CLI missing, unparseable output — degrades to
// `available:false` so the caller falls back to an ASCII/no-callers diagram.

export type CodeGraphResult =
  | { readonly available: true; readonly graph: CodeGraph }
  | { readonly available: false; readonly reason: string };

export type CodeGraphDeps = {
  readonly access?: (target: string) => Promise<boolean>;
  readonly runRaw?: CommandRunner;
};

const defaultAccess = async (target: string): Promise<boolean> => {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
};

// Tolerant shape for the CLI's JSON. If the real `codegraph` output differs, the
// parse fails and we degrade gracefully rather than guessing wrong.
const graphSchema = z.object({
  symbols: z.array(z.object({ name: z.string(), file: z.string() })),
  edges: z.array(z.object({ caller: z.string(), callee: z.string() })),
});

export const queryCodeGraph = async (
  repoRoot: string,
  changedFiles: readonly string[],
  deps: CodeGraphDeps = {},
): Promise<CodeGraphResult> => {
  const access = deps.access ?? defaultAccess;
  const runRaw = deps.runRaw ?? runCommandRaw;

  if (!(await access(path.join(repoRoot, '.codegraph')))) {
    return { available: false, reason: 'no CodeGraph index (.codegraph/ missing)' };
  }

  // Ask CodeGraph about exactly the changed files; --json keeps parsing robust.
  const result = await runRaw('codegraph', ['explore', '--json', ...changedFiles], { cwd: repoRoot });
  if (!result.ok || result.value.exitCode !== 0) {
    return { available: false, reason: 'CodeGraph CLI unavailable or failed' };
  }
  let json: unknown;
  try {
    json = JSON.parse(result.value.stdout);
  } catch {
    return { available: false, reason: 'CodeGraph output was not JSON' };
  }
  const parsed = graphSchema.safeParse(json);
  if (!parsed.success) {
    return { available: false, reason: 'CodeGraph output shape not recognized' };
  }
  return { available: true, graph: parsed.data };
};
