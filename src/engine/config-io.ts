import fs from 'node:fs/promises';
import path from 'node:path';
import { parseAgentsConfig, type AgentsConfig } from '../contract/schema.js';
import { err, ok, type Result } from '../core/result.js';
import { writeFileAtomic } from './fs-atomic.js';

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

// Kinds are distinct so the CLI can react differently: 'not-found' invites
// running the configurator, 'invalid-json'/'invalid-config' point at a file the
// user must fix by hand (issues carries the schema violations), 'io' is a
// filesystem failure that is neither of those.
export type ConfigIoError = {
  readonly kind: 'not-found' | 'invalid-json' | 'invalid-config' | 'io';
  readonly message: string;
  readonly issues?: string[];
  readonly cause?: unknown;
};

export const agentsConfigPath = (projectRoot: string): string =>
  path.join(projectRoot, 'agents.config.json');

export const readAgentsConfig = async (
  projectRoot: string,
): Promise<Result<AgentsConfig, ConfigIoError>> => {
  const filePath = agentsConfigPath(projectRoot);
  let raw: string;
  try {
    raw = await fs.readFile(filePath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return err({ kind: 'not-found', message: `agents.config.json not found at ${filePath}`, cause: error });
    }
    return err({ kind: 'io', message: `could not read ${filePath}: ${errorMessage(error)}`, cause: error });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return err({
      kind: 'invalid-json',
      message: `agents.config.json is not valid JSON: ${errorMessage(error)}`,
      cause: error,
    });
  }
  const config = parseAgentsConfig(parsed);
  if (!config.ok) {
    return err({ kind: 'invalid-config', message: config.error.message, issues: config.error.issues });
  }
  return ok(config.value);
};

export const writeAgentsConfig = async (
  projectRoot: string,
  config: AgentsConfig,
): Promise<Result<void, ConfigIoError>> => {
  const serialized = `${JSON.stringify(config, null, 2)}\n`;
  const written = await writeFileAtomic(agentsConfigPath(projectRoot), serialized);
  return written.ok ? ok(undefined) : err({ kind: 'io', message: written.error.message, cause: written.error.cause });
};
