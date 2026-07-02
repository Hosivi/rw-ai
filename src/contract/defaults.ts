import { err, isErr, ok, type Result } from '../core/result.js';
import {
  contractError,
  parseAgentsConfig,
  type AgentsConfig,
  type Claim,
  type ClaimsFile,
  type ContractError,
  type DbConfigInput,
  type PortBandName,
  type Session,
  type Stack,
  type TestsConfig,
} from './schema.js';

export const PORT_BANDS = {
  api: 3000,
  web: 3100,
  metro: 8081,
} as const satisfies Record<PortBandName, number>;

// Bands are 100 apart: above index 99 the api band (3000 + offset) would run
// into the web band starting at 3100, so ports would no longer be unique.
export const MAX_SESSION_INDEX = 99;

export type SessionPortSet = { api: number; web: number; metro: number };

const validateSessionIndex = (index: number): Result<number, ContractError> => {
  if (!Number.isInteger(index) || index < 1) {
    return err(contractError(`session index must be an integer >= 1, got ${index}`));
  }
  if (index > MAX_SESSION_INDEX) {
    return err(
      contractError(
        `session index ${index} exceeds ${MAX_SESSION_INDEX}: the api port band would collide with the web band at ${PORT_BANDS.web}`,
      ),
    );
  }
  return ok(index);
};

export const sessionPorts = (index: number): Result<SessionPortSet, ContractError> => {
  const checked = validateSessionIndex(index);
  if (isErr(checked)) {
    return checked;
  }
  const offset = index - 1;
  return ok({
    api: PORT_BANDS.api + offset,
    web: PORT_BANDS.web + offset,
    metro: PORT_BANDS.metro + offset,
  });
};

// Must be a valid Postgres identifier: lowercase, [a-z0-9_], not starting
// with a digit, at most 63 bytes.
export const sessionDbName = (projectName: string, index: number): string => {
  const sanitized = projectName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  const base = sanitized === '' ? 'project' : sanitized;
  const prefixed = /^[0-9]/.test(base) ? `_${base}` : base;
  const suffix = `_s${index}`;
  return prefixed.slice(0, 63 - suffix.length) + suffix;
};

// The '-inicial' suffix (Spanish included) is a deliberate product convention
// from the brief, not a language slip.
export const defaultSessionBranch = (index: number): string => `feat/s${index}-inicial`;

export type CreateSessionParams = {
  index: number;
  projectName: string;
  branch?: string;
  areas?: string[];
  platforms?: Session['platforms'];
  withDb: boolean;
  withPorts: boolean;
  worktreesDir?: string;
};

export const createSession = (params: CreateSessionParams): Result<Session, ContractError> => {
  const { index, projectName, withDb, withPorts } = params;
  const worktreesDir = params.worktreesDir ?? '.worktrees';
  let session: Session = {
    id: `s${index}`,
    branch: params.branch ?? defaultSessionBranch(index),
    worktree: `${worktreesDir}/s${index}`,
    status: 'active',
    areas: params.areas ?? ['**/*'],
    platforms: params.platforms ?? {},
  };
  if (withPorts) {
    const ports = sessionPorts(index);
    if (isErr(ports)) {
      return ports;
    }
    session = { ...session, ports: ports.value };
  }
  if (withDb) {
    session = { ...session, db: { name: sessionDbName(projectName, index) } };
  }
  return ok(session);
};

export type CreateDefaultConfigParams = {
  projectName: string;
  stacks: Stack[];
  sessionCount: number;
  baseBranch?: string;
  integrationBranch?: string;
  worktreesDir?: string;
  boardDir?: string;
  sharedZones?: string[];
  db?: DbConfigInput;
  tests?: Partial<TestsConfig>;
  platforms?: Session['platforms'];
};

export const createDefaultConfig = (
  params: CreateDefaultConfigParams,
): Result<AgentsConfig, ContractError> => {
  if (!Number.isInteger(params.sessionCount) || params.sessionCount < 1) {
    return err(
      contractError(`sessionCount must be an integer >= 1, got ${params.sessionCount}`),
    );
  }
  // Ports only exist for the node stack; db names only when a db strategy is
  // active. Other stacks stay free of irrelevant config.
  const withPorts = params.stacks.includes('node');
  const withDb = (params.db?.strategy ?? 'none') !== 'none';
  const sessions: Session[] = [];
  for (let index = 1; index <= params.sessionCount; index += 1) {
    const session = createSession({
      index,
      projectName: params.projectName,
      platforms: params.platforms,
      withDb,
      withPorts,
      worktreesDir: params.worktreesDir,
    });
    if (isErr(session)) {
      return session;
    }
    sessions.push(session.value);
  }
  return parseAgentsConfig({
    version: 1,
    project: { name: params.projectName, stacks: params.stacks },
    git: {
      baseBranch: params.baseBranch ?? 'main',
      integrationBranch: params.integrationBranch ?? 'develop',
      worktreesDir: params.worktreesDir ?? '.worktrees',
    },
    board: { dir: params.boardDir ?? '.review-board' },
    // zod's .default() treats an explicit undefined like an absent key.
    db: params.db,
    sharedZones: params.sharedZones ?? [],
    tests: params.tests,
    sessions,
  });
};

export const createEmptyClaims = (config: AgentsConfig): ClaimsFile => {
  const claims: ClaimsFile['claims'] = {};
  for (const session of config.sessions) {
    claims[session.id] = { status: 'free' };
  }
  claims['integrator'] = { status: 'free' };
  return { version: 1, claims };
};

// Strictly-after semantics: a claim is expired the instant now reaches
// expiresAt (now >= expiresAt), so two agents never both hold it at the boundary.
export const isClaimExpired = (claim: Claim, now: Date): boolean => {
  if (claim.status === 'free') {
    return false;
  }
  return now.getTime() >= Date.parse(claim.expiresAt);
};
