import type { AgentsConfig } from '../contract/schema.js';
import { assertNever } from '../core/assert.js';
import { err, ok, type Result } from '../core/result.js';
import { readAgentsConfig, type ConfigIoError } from '../engine/config-io.js';
import type { CommandRunner } from '../engine/exec.js';
import { createGit, type Git } from '../engine/git.js';

// The shared handle every command opens first: the resolved repo root, its
// parsed config, and a git bound to that root so commands never re-resolve either.
export type CliContext = {
  readonly projectRoot: string;
  readonly config: AgentsConfig;
  readonly git: Git;
};

// Kinds map one-to-one onto an actionable next step the CLI can print:
// 'not-a-repo' means run inside a repo, 'config-not-found' invites 'rw configure',
// 'config-invalid' points at a file to fix (issues carries the violations), 'io'
// is a filesystem failure that is none of those.
export type CliContextError = {
  readonly kind: 'not-a-repo' | 'config-not-found' | 'config-invalid' | 'io';
  readonly message: string;
  readonly issues?: readonly string[];
  readonly cause?: unknown;
};

// ConfigIoError kinds collapse onto CliContextError: both JSON and schema
// failures are a single 'config-invalid' the user fixes by hand, and only
// 'invalid-config' carries schema issues worth surfacing.
const fromConfigIoError = (error: ConfigIoError): CliContextError => {
  switch (error.kind) {
    case 'not-found':
      return { kind: 'config-not-found', message: error.message, cause: error.cause };
    case 'invalid-json':
      return { kind: 'config-invalid', message: error.message, cause: error.cause };
    case 'invalid-config':
      return {
        kind: 'config-invalid',
        message: error.message,
        ...(error.issues !== undefined ? { issues: error.issues } : {}),
        cause: error.cause,
      };
    case 'io':
      return { kind: 'io', message: error.message, cause: error.cause };
    default:
      return assertNever(error.kind);
  }
};

// Resolves the shared command context from an arbitrary cwd: git first (a
// non-repo cwd is the earliest, most common failure), then the config anchored at
// the resolved root. Runners are injectable so the whole flow is stubbable.
export const loadContext = async (
  cwd: string,
  run?: CommandRunner,
  runRaw?: CommandRunner,
): Promise<Result<CliContext, CliContextError>> => {
  const toplevel = await createGit(cwd, run, runRaw).toplevel();
  if (!toplevel.ok) {
    return err({
      kind: 'not-a-repo',
      message: `No estás dentro de un repositorio git (${cwd}).`,
      cause: toplevel.error,
    });
  }
  const projectRoot = toplevel.value;

  const config = await readAgentsConfig(projectRoot);
  if (!config.ok) {
    return err(fromConfigIoError(config.error));
  }

  // git is rebound to the resolved root: cwd may have been a subdirectory, and
  // every later command must operate from the repo root, not where it was invoked.
  return ok({ projectRoot, config: config.value, git: createGit(projectRoot, run, runRaw) });
};
