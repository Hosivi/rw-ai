import { createDefaultConfig } from '../contract/defaults.js';
import type { AgentsConfig, DbConfigInput, Stack } from '../contract/schema.js';
import { err, isErr, ok, type Result } from '../core/result.js';
import type { DbDetection } from './database.js';

// A repo with no recognizable stack still needs a usable config; node is the
// safe default — it is the most common stack and the only one that gets ports.
const FALLBACK_STACKS: readonly Stack[] = ['node'];

export type ScaffoldError = {
  readonly kind: 'invalid';
  readonly message: string;
  readonly issues?: readonly string[];
};

export type ScaffoldParams = {
  readonly projectName: string;
  readonly stacks: Stack[];
  readonly sessionCount: number;
  readonly db?: DbDetection;
};

// Maps a DbDetection to the builder's DbConfigInput, dropping undefined optional
// fields so zod's defaults apply where detection had nothing to say. host/port
// are always present on a DbDetection; service/user are strategy-specific.
const toDbConfigInput = (db: DbDetection): DbConfigInput => ({
  strategy: db.strategy,
  ...(db.service !== undefined ? { service: db.service } : {}),
  host: db.host,
  port: db.port,
  ...(db.user !== undefined ? { user: db.user } : {}),
});

// Pure config builder: turns detected inputs into an AgentsConfig via
// createDefaultConfig. No filesystem — detection and writing are separate
// concerns, so this stays unit-testable with crafted inputs. An empty stack list
// defaults to node; a createDefaultConfig failure surfaces as scaffold-invalid.
export const scaffoldConfig = (params: ScaffoldParams): Result<AgentsConfig, ScaffoldError> => {
  const stacks: Stack[] = params.stacks.length > 0 ? params.stacks : [...FALLBACK_STACKS];
  const config = createDefaultConfig({
    projectName: params.projectName,
    stacks,
    sessionCount: params.sessionCount,
    ...(params.db !== undefined ? { db: toDbConfigInput(params.db) } : {}),
  });
  if (isErr(config)) {
    return err({
      kind: 'invalid',
      message: config.error.message,
      ...(config.error.issues.length > 0 ? { issues: config.error.issues } : {}),
    });
  }
  return ok(config.value);
};
