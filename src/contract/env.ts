import path from 'node:path';
import { PORT_BAND_NAMES, type AgentsConfig, type PortBandName, type Session } from './schema.js';

export const ENV_KEYS = {
  session: 'RW_SESSION',
  boardDir: 'RW_BOARD_DIR',
  apiPort: 'PORT',
  webPort: 'WEB_PORT',
  metroPort: 'EXPO_METRO_PORT',
  apiUrlNext: 'NEXT_PUBLIC_API_URL',
  apiUrlExpo: 'EXPO_PUBLIC_API_URL',
  databaseUrl: 'DATABASE_URL',
} as const;

const PORT_ENV_KEYS = {
  api: ENV_KEYS.apiPort,
  web: ENV_KEYS.webPort,
  metro: ENV_KEYS.metroPort,
} as const satisfies Record<PortBandName, string>;

// Worktrees are separate checkouts: a relative board path resolved inside a
// worktree points at the worktree's own copy, NOT the shared board. Consumers
// must always use this absolute path anchored at the main repo root.
export const resolveBoardDir = (projectRoot: string, config: AgentsConfig): string =>
  path.resolve(projectRoot, config.board.dir);

// Secrets never land in generated files: with a user set we emit a literal
// ${RW_DB_PASSWORD} placeholder for the runner to substitute from the
// environment; without a user the URL carries no credentials at all.
const sessionDatabaseUrl = (config: AgentsConfig, dbName: string): string => {
  const { host, port, user } = config.db;
  return user === undefined
    ? `postgresql://${host}:${port}/${dbName}`
    : `postgresql://${user}:\${RW_DB_PASSWORD}@${host}:${port}/${dbName}`;
};

// Ordered entries for a session's .env.local. Note: PORT in .env.local does
// NOT reach `next dev` or Metro by itself — the future `rw dev` runner injects
// these into the spawned process env.
export const sessionEnvEntries = (
  config: AgentsConfig,
  session: Session,
  projectRoot: string,
): Array<readonly [string, string]> => {
  const entries: Array<readonly [string, string]> = [
    [ENV_KEYS.session, session.id],
    [ENV_KEYS.boardDir, resolveBoardDir(projectRoot, config)],
  ];
  const ports = session.ports;
  for (const band of PORT_BAND_NAMES) {
    const port = ports?.[band];
    if (port !== undefined) {
      entries.push([PORT_ENV_KEYS[band], String(port)]);
    }
  }
  if (ports?.api !== undefined) {
    // Each session's clients must talk to THAT session's api, never a shared one.
    const apiUrl = `http://localhost:${ports.api}`;
    entries.push([ENV_KEYS.apiUrlNext, apiUrl], [ENV_KEYS.apiUrlExpo, apiUrl]);
  }
  if (session.db !== undefined && config.db.strategy !== 'none') {
    entries.push([ENV_KEYS.databaseUrl, sessionDatabaseUrl(config, session.db.name)]);
  }
  return entries;
};
