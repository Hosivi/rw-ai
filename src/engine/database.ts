import fs from 'node:fs/promises';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { AgentsConfig, DbStrategy } from '../contract/schema.js';
import { assertNever } from '../core/assert.js';
import { err, ok, type Result } from '../core/result.js';
import { runCommand, trimmedStdout, type CommandError, type CommandRunner } from './exec.js';
import { activeSessions } from './sessions.js';

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

export type DbDetection = {
  readonly strategy: DbStrategy;
  readonly service?: string;
  readonly host: string;
  readonly port: number;
  readonly user?: string;
  // Paths (relative to projectRoot) of the files that informed the decision.
  readonly sources: string[];
};

export type DbDetectionError = {
  readonly message: string;
  readonly cause?: unknown;
};

const COMPOSE_FILE_NAMES = [
  'docker-compose.yml',
  'docker-compose.yaml',
  'compose.yml',
  'compose.yaml',
] as const;

const ENV_FILE_NAMES = ['.env', '.env.local'] as const;

const POSTGRES_DEFAULT_PORT = 5432;

// Detection is best-effort: any unreadable file is treated as absent.
const readFileIfExists = async (filePath: string): Promise<string | null> => {
  try {
    return await fs.readFile(filePath, 'utf8');
  } catch {
    return null;
  }
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

// Compose short syntax: "5433:5432", "127.0.0.1:5433:5432", optional "/tcp".
// Long syntax: { target: 5432, published: 5433 }. Returns the host port
// published for container port 5432, or undefined when this mapping is not it.
const hostPortForPostgres = (mapping: unknown): number | undefined => {
  if (typeof mapping === 'string') {
    const segments = mapping.split(':');
    const containerSide = segments[segments.length - 1];
    const hostSide = segments[segments.length - 2];
    if (containerSide === undefined || hostSide === undefined) {
      return undefined;
    }
    if (containerSide.replace(/\/(tcp|udp)$/, '') !== String(POSTGRES_DEFAULT_PORT)) {
      return undefined;
    }
    const hostPort = Number.parseInt(hostSide, 10);
    return Number.isInteger(hostPort) ? hostPort : undefined;
  }
  if (isRecord(mapping) && mapping['target'] === POSTGRES_DEFAULT_PORT) {
    const published = mapping['published'];
    // compose allows published as number or string.
    const hostPort = typeof published === 'string' ? Number.parseInt(published, 10) : published;
    return typeof hostPort === 'number' && Number.isInteger(hostPort) ? hostPort : undefined;
  }
  return undefined;
};

// environment comes in two compose forms: a map ({ POSTGRES_USER: app }) or a
// KEY=VALUE list (- POSTGRES_USER=app).
const postgresUserFromEnvironment = (environment: unknown): string | undefined => {
  if (isRecord(environment)) {
    const user = environment['POSTGRES_USER'];
    return typeof user === 'string' && user !== '' ? user : undefined;
  }
  if (Array.isArray(environment)) {
    for (const entry of environment) {
      if (typeof entry === 'string' && entry.startsWith('POSTGRES_USER=')) {
        const user = entry.slice('POSTGRES_USER='.length);
        return user === '' ? undefined : user;
      }
    }
  }
  return undefined;
};

type ComposePostgres = { readonly service: string; readonly port: number; readonly user: string };

const findPostgresService = (composeDoc: unknown): ComposePostgres | undefined => {
  if (!isRecord(composeDoc) || !isRecord(composeDoc['services'])) {
    return undefined;
  }
  for (const [name, service] of Object.entries(composeDoc['services'])) {
    if (!isRecord(service) || typeof service['image'] !== 'string') {
      continue;
    }
    if (!service['image'].includes('postgres')) {
      continue;
    }
    const portMappings = Array.isArray(service['ports']) ? service['ports'] : [];
    const hostPort = portMappings
      .map(hostPortForPostgres)
      .find((candidate) => candidate !== undefined);
    return {
      service: name,
      port: hostPort ?? POSTGRES_DEFAULT_PORT,
      user: postgresUserFromEnvironment(service['environment']) ?? 'postgres',
    };
  }
  return undefined;
};

const databaseUrlFrom = (envContent: string): URL | undefined => {
  const match = envContent.match(/^\s*DATABASE_URL\s*=\s*(.+?)\s*$/m);
  const raw = match?.[1];
  if (raw === undefined) {
    return undefined;
  }
  try {
    return new URL(raw.replace(/^["']|["']$/g, ''));
  } catch {
    return undefined;
  }
};

export const detectDbSetup = async (
  projectRoot: string,
): Promise<Result<DbDetection, DbDetectionError>> => {
  for (const name of COMPOSE_FILE_NAMES) {
    const content = await readFileIfExists(path.join(projectRoot, name));
    if (content === null) {
      continue;
    }
    let composeDoc: unknown;
    try {
      composeDoc = parseYaml(content);
    } catch {
      // Best-effort: a compose file that does not parse is skipped, not fatal.
      continue;
    }
    const postgres = findPostgresService(composeDoc);
    if (postgres === undefined) {
      // Parses but runs no postgres → the compose file did not decide anything;
      // fall through to DATABASE_URL detection.
      continue;
    }
    return ok({
      strategy: 'docker',
      service: postgres.service,
      // Compose publishes the port on the docker host, i.e. localhost.
      host: 'localhost',
      port: postgres.port,
      user: postgres.user,
      sources: [name],
    });
  }
  for (const name of ENV_FILE_NAMES) {
    const content = await readFileIfExists(path.join(projectRoot, name));
    if (content === null) {
      continue;
    }
    const url = databaseUrlFrom(content);
    if (url === undefined) {
      continue;
    }
    // The URL may carry a password; only host/port/user are ever kept.
    return ok({
      strategy: url.hostname.includes('supabase.') ? 'supabase' : 'local',
      host: url.hostname,
      port: url.port === '' ? POSTGRES_DEFAULT_PORT : Number.parseInt(url.port, 10),
      user: url.username === '' ? undefined : decodeURIComponent(url.username),
      sources: [name],
    });
  }
  return ok({ strategy: 'none', host: 'localhost', port: POSTGRES_DEFAULT_PORT, sources: [] });
};

// ---------------------------------------------------------------------------
// Per-session database creation
// ---------------------------------------------------------------------------

export type SessionDbAction = 'created' | 'exists' | 'skipped' | 'manual';

export type SessionDbResult = {
  readonly sessionId: string;
  // Absent only for sessions without a db block (nothing to create).
  readonly dbName?: string;
  readonly action: SessionDbAction;
  // Copy-pastable create command, present when action is 'manual' because a
  // command failed (docker down, psql missing, ...).
  readonly fallbackCommand?: string;
  readonly reason?: string;
};

export type DatabaseEnsureError = {
  readonly message: string;
  readonly sessionId?: string;
};

// Valid unquoted-safe Postgres identifier: lowercase start, [a-z0-9_], max 63
// bytes. Anything else is rejected outright — see the security guard below.
const DB_NAME_PATTERN = /^[a-z_][a-z0-9_]{0,62}$/;

const existsSql = (dbName: string): string =>
  `SELECT 1 FROM pg_database WHERE datname='${dbName}'`;

const createSql = (dbName: string): string => `CREATE DATABASE "${dbName}"`;

// Renders a command for humans to copy-paste when automation could not run.
// rw-ai itself never passes these through a shell — args go as an array.
const formatCommand = (command: string, args: readonly string[]): string =>
  [
    command,
    ...args.map((arg) => (/[\s"']/.test(arg) ? `"${arg.replaceAll('"', '\\"')}"` : arg)),
  ].join(' ');

const describeCommandError = (error: CommandError): string => {
  switch (error.kind) {
    case 'spawn-failed':
      return error.message;
    case 'non-zero-exit':
      return `exit ${error.output.exitCode}: ${error.output.stderr.trim()}`;
    default:
      return assertNever(error);
  }
};

type PsqlInvocation = { readonly command: string; readonly baseArgs: readonly string[] };

// Idempotent per-session database creation: exists-check first, create only
// when missing. Command failures degrade to 'manual' with the exact fallback
// command — the configurator must finish and report pending items, not abort.
export const ensureSessionDatabases = async (
  config: AgentsConfig,
  projectRoot: string,
  run: CommandRunner = runCommand,
): Promise<Result<SessionDbResult[], DatabaseEnsureError>> => {
  const sessions = activeSessions(config);
  // SECURITY GUARD — runs before ANY name is interpolated into SQL below.
  // Db names come from user-editable agents.config.json; a hostile name would
  // otherwise ride straight into psql. Rejecting is the only safe move:
  // quote-escaping around an arbitrary name still leaves injection paths.
  for (const session of sessions) {
    const dbName = session.db?.name;
    if (dbName !== undefined && !DB_NAME_PATTERN.test(dbName)) {
      return err({
        message: `invalid database name '${dbName}' for session ${session.id}: must match ${String(DB_NAME_PATTERN)}`,
        sessionId: session.id,
      });
    }
  }
  const strategy = config.db.strategy;
  if (strategy === 'none') {
    return ok(
      sessions.map((session) => ({
        sessionId: session.id,
        dbName: session.db?.name,
        action: 'skipped' as const,
        reason: 'db strategy none',
      })),
    );
  }
  if (strategy === 'supabase') {
    return ok(
      sessions.map((session) =>
        session.db === undefined
          ? { sessionId: session.id, action: 'skipped' as const, reason: 'session has no db name' }
          : {
              sessionId: session.id,
              dbName: session.db.name,
              action: 'manual' as const,
              reason:
                'Supabase is a managed service: create a Supabase branch per session instead of a local database',
            },
      ),
    );
  }
  // psql needs a role for -U; 'postgres' is the stock superuser default.
  const user = config.db.user ?? 'postgres';
  let psql: PsqlInvocation;
  if (strategy === 'docker') {
    // Schema-parsed configs always carry service for the docker strategy
    // (superRefine); this guards hand-built configs the type allows.
    const service = config.db.service;
    if (service === undefined) {
      return err({ message: "db.service is required when db strategy is 'docker'" });
    }
    psql = { command: 'docker', baseArgs: ['compose', 'exec', '-T', service, 'psql', '-U', user] };
  } else if (strategy === 'local') {
    psql = { command: 'psql', baseArgs: ['-h', config.db.host, '-p', String(config.db.port), '-U', user] };
  } else {
    return assertNever(strategy);
  }
  const results: SessionDbResult[] = [];
  for (const session of sessions) {
    const dbName = session.db?.name;
    if (dbName === undefined) {
      results.push({ sessionId: session.id, action: 'skipped', reason: 'session has no db name' });
      continue;
    }
    const createArgs = [...psql.baseArgs, '-c', createSql(dbName)];
    const fallbackCommand = formatCommand(psql.command, createArgs);
    const existed = await run(psql.command, [...psql.baseArgs, '-tAc', existsSql(dbName)], {
      cwd: projectRoot,
    });
    if (!existed.ok) {
      results.push({
        sessionId: session.id,
        dbName,
        action: 'manual',
        fallbackCommand,
        reason: `could not check database '${dbName}': ${describeCommandError(existed.error)}`,
      });
      continue;
    }
    if (trimmedStdout(existed.value) === '1') {
      results.push({ sessionId: session.id, dbName, action: 'exists' });
      continue;
    }
    const created = await run(psql.command, createArgs, { cwd: projectRoot });
    if (!created.ok) {
      results.push({
        sessionId: session.id,
        dbName,
        action: 'manual',
        fallbackCommand,
        reason: `could not create database '${dbName}': ${describeCommandError(created.error)}`,
      });
      continue;
    }
    results.push({ sessionId: session.id, dbName, action: 'created' });
  }
  return ok(results);
};
