import { access, lstat, mkdir, open, readFile, realpath, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { isErr, ok, err, type Result } from './core/result.js';
import {
  appendNextSession,
  createDefaultConfig,
  createEmptyClaims,
} from './contract/defaults.js';
import { sessionEnvEntries } from './contract/env.js';
import {
  contractError,
  parseAgentsConfig,
  parseClaimsFile,
  type AgentsConfig,
  type ClaimsFile,
  type ContractError,
  type Session,
  type Stack,
} from './contract/schema.js';
import {
  RUNTIME_MANIFESTS_DIR,
  preflightRuntimeManifestTarget,
  writeRuntimeManifest,
  type BranchDetector,
  type RuntimeManifestWriteResult,
  type WorktreeAdoptionSource,
} from './runtime.js';

export const AGENTS_CONFIG_FILE = 'agents.config.json';
export const CLAIMS_FILE = 'claims.json';
export const BOOTSTRAP_LOCK_FILE = '.rw-ai.bootstrap.lock';
const BOARD_GITIGNORE_FILE = '.gitignore';
const PENDING_RUNTIME_ADOPTIONS_DIR = 'pending-runtime-adoptions';
const APPEND_RUNTIME_ADOPTION_MARKER_FILE = 'append-runtime-adoption.json';
const BOARD_GITIGNORE_PATTERNS = [
  CLAIMS_FILE,
  `.${CLAIMS_FILE}.*.tmp`,
  `${RUNTIME_MANIFESTS_DIR}/`,
  `${PENDING_RUNTIME_ADOPTIONS_DIR}/`,
] as const;

export type BootstrapAction =
  | 'created-config'
  | 'loaded-config'
  | 'appended-session'
  | 'created-board-dir'
  | 'loaded-board-dir'
  | 'created-claims'
  | 'loaded-claims'
  | 'updated-claims'
  | 'wrote-runtime-manifest';

export type SessionEnv = {
  session: Session;
  entries: Array<readonly [string, string]>;
};

export type EnsureRwStateParams = {
  projectRoot: string;
  projectName?: string;
  stacks?: Stack[];
  sessionCount?: number;
  appendSession?: boolean;
  branch?: string;
  areas?: string[];
  platforms?: Session['platforms'];
  boardDir?: string;
  baseBranch?: string;
  integrationBranch?: string;
  worktreesDir?: string;
  runtimeManifest?: {
    sessionId?: string;
    worktreePath: string;
    source: WorktreeAdoptionSource;
    detectBranch?: BranchDetector;
    now?: () => Date;
  };
};

export type EnsureRwStateResult = {
  projectRoot: string;
  configPath: string;
  boardDir: string;
  claimsPath: string;
  config: AgentsConfig;
  claims: ClaimsFile;
  actions: BootstrapAction[];
  appendedSession?: Session;
  sessionEnvs: SessionEnv[];
  runtimeManifests: RuntimeManifestWriteResult[];
};

const fileExists = async (filePath: string): Promise<boolean> => {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
};

const toErrorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const hasErrorCode = (error: unknown, code: string): boolean =>
  typeof error === 'object' &&
  error !== null &&
  'code' in error &&
  (error as { code?: unknown }).code === code;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const withNoOverwriteGuidance = (error: ContractError, guidance: string): ContractError =>
  contractError(error.message, [...error.issues, `No files were overwritten. ${guidance}`]);

const withNoConfigClaimsOverwriteGuidance = (error: ContractError): ContractError =>
  contractError(error.message, [
    ...error.issues,
    'No config or claims files were overwritten. Fix runtime adoption options and rerun.',
  ]);

const readJsonFile = async (filePath: string): Promise<Result<unknown, ContractError>> => {
  let content: string;
  try {
    content = await readFile(filePath, 'utf8');
  } catch (error) {
    return err(
      contractError(`Failed to read JSON file: ${filePath}`, [
        toErrorMessage(error),
        'No files were overwritten. Fix the file path or permissions and rerun.',
      ]),
    );
  }

  try {
    return ok(JSON.parse(content) as unknown);
  } catch (error) {
    return err(
      contractError(`Malformed JSON file: ${filePath}`, [
        toErrorMessage(error),
        'No files were overwritten. Fix the JSON syntax and rerun.',
      ]),
    );
  }
};

const atomicWriteFile = async (
  filePath: string,
  content: string,
): Promise<Result<void, ContractError>> => {
  const dir = path.dirname(filePath);
  const base = path.basename(filePath);
  const tempPath = path.join(
    dir,
    `.${base}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`,
  );
  let tempCreated = false;

  try {
    const handle = await open(tempPath, 'wx');
    tempCreated = true;
    try {
      await handle.writeFile(content, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(tempPath, filePath);
    return ok(undefined);
  } catch (error) {
    if (tempCreated) {
      await rm(tempPath, { force: true }).catch(() => undefined);
    }
    return err(
      contractError(`Failed to atomically write file: ${filePath}`, [toErrorMessage(error)]),
    );
  }
};

const writeJsonFile = async (
  filePath: string,
  value: unknown,
): Promise<Result<void, ContractError>> => {
  return atomicWriteFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
};

const ensureBoardGitignore = async (boardDir: string): Promise<Result<void, ContractError>> => {
  const gitignorePath = path.join(boardDir, BOARD_GITIGNORE_FILE);
  const defaultContent = [
    '# rw-ai local coordination state',
    ...BOARD_GITIGNORE_PATTERNS,
    '',
  ].join('\n');

  if (!(await fileExists(gitignorePath))) {
    return atomicWriteFile(gitignorePath, defaultContent);
  }

  let current: string;
  try {
    current = await readFile(gitignorePath, 'utf8');
  } catch (error) {
    return err(
      contractError(`Failed to read board .gitignore: ${gitignorePath}`, [toErrorMessage(error)]),
    );
  }

  const existingLines = new Set(current.split(/\r?\n/));
  const missingPatterns = BOARD_GITIGNORE_PATTERNS.filter((pattern) => !existingLines.has(pattern));
  if (missingPatterns.length === 0) {
    return ok(undefined);
  }

  const separator = current.length === 0 || current.endsWith('\n') ? '' : '\n';
  return atomicWriteFile(gitignorePath, `${current}${separator}${missingPatterns.join('\n')}\n`);
};

const describePathContainment = (label: string, dirPath: string, realDir: string): ContractError =>
  contractError(`Unsafe ${label} in agents.config.json`, [
    `${label} resolves outside the project root: ${dirPath} -> ${realDir}`,
    'No files were overwritten. Replace the symlink/junction/reparse point or fix agents.config.json, then rerun.',
  ]);

const nearestExistingParent = async (projectRoot: string, dirPath: string): Promise<string> => {
  let current = dirPath;
  while (isPathInside(projectRoot, current)) {
    try {
      await lstat(current);
      return current;
    } catch (error) {
      if (!hasErrorCode(error, 'ENOENT')) {
        throw error;
      }
    }
    const parent = path.dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }
  return projectRoot;
};

const ensureContainedDirectory = async (
  projectRoot: string,
  dirPath: string,
  label: string,
): Promise<Result<'created' | 'loaded', ContractError>> => {
  const existed = await fileExists(dirPath);
  try {
    const realProjectRoot = await realpath(projectRoot);
    if (existed) {
      const realDir = await realpath(dirPath);
      if (!isPathInside(realProjectRoot, realDir)) {
        return err(describePathContainment(label, dirPath, realDir));
      }
    } else {
      const parent = await nearestExistingParent(projectRoot, dirPath);
      const realParent = await realpath(parent);
      if (!isPathInside(realProjectRoot, realParent)) {
        return err(describePathContainment(label, parent, realParent));
      }
    }
    await mkdir(dirPath, { recursive: true });
    const realDir = await realpath(dirPath);
    if (!isPathInside(realProjectRoot, realDir)) {
      return err(describePathContainment(label, dirPath, realDir));
    }
    return ok(existed ? 'loaded' : 'created');
  } catch (error) {
    return err(contractError(`Failed to ensure directory: ${dirPath}`, [toErrorMessage(error)]));
  }
};

const describeBoardPathContainment = (
  label: string,
  dirPath: string,
  realDir: string,
): ContractError =>
  contractError(`Unsafe ${label}`, [
    `${label} resolves outside the review-board directory: ${dirPath} -> ${realDir}`,
    'No config or claims files were overwritten. Replace the symlink/junction/reparse point and rerun.',
  ]);

const ensureBoardContainedDirectory = async (
  boardDir: string,
  dirPath: string,
  label: string,
): Promise<Result<void, ContractError>> => {
  try {
    const realBoardDir = await realpath(boardDir);
    const resolvedDir = path.resolve(dirPath);
    if (!isPathInside(realBoardDir, resolvedDir)) {
      return err(describeBoardPathContainment(label, dirPath, resolvedDir));
    }
    await mkdir(resolvedDir, { recursive: true });
    const realDir = await realpath(resolvedDir);
    if (!isPathInside(realBoardDir, realDir)) {
      return err(describeBoardPathContainment(label, dirPath, realDir));
    }
    return ok(undefined);
  } catch (error) {
    return err(contractError(`Failed to ensure directory: ${dirPath}`, [toErrorMessage(error)]));
  }
};

const hasParentPathSegment = (value: string): boolean => value.split(/[\\/]+/).includes('..');

const isAbsolutePathLike = (value: string): boolean =>
  path.isAbsolute(value) || value.startsWith('/') || value.startsWith('\\') || /^[A-Za-z]:/.test(value);

const isPathInside = (parent: string, child: string): boolean => {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
};

const resolveContainedBoardDir = (
  projectRoot: string,
  boardDir: string,
): Result<string, ContractError> => {
  if (isAbsolutePathLike(boardDir)) {
    return err(
      contractError('Unsafe board.dir in agents.config.json', [
        `board.dir must be relative to the project root, got: ${boardDir}`,
        'No files were overwritten. Fix agents.config.json and rerun.',
      ]),
    );
  }
  if (hasParentPathSegment(boardDir)) {
    return err(
      contractError('Unsafe board.dir in agents.config.json', [
        `board.dir must not contain parent directory traversal, got: ${boardDir}`,
        'No files were overwritten. Fix agents.config.json and rerun.',
      ]),
    );
  }

  const resolved = path.resolve(projectRoot, boardDir);
  if (!isPathInside(projectRoot, resolved)) {
    return err(
      contractError('Unsafe board.dir in agents.config.json', [
        `Resolved board directory escapes the project root: ${resolved}`,
        'No files were overwritten. Fix agents.config.json and rerun.',
      ]),
    );
  }
  return ok(resolved);
};

type BootstrapLock = { lockPath: string; nonce: string };

type AppendRuntimeAdoptionMarker = {
  version: 1;
  operation: 'append-runtime-adoption';
  sessionId: string;
  worktreePath: string;
  resolvedWorktreePath: string;
  source: WorktreeAdoptionSource;
  branch?: string;
  areas?: string[];
  platforms?: Session['platforms'];
  createdAt: string;
  nonce: string;
};

const parseLockMetadata = (raw: string): { pid?: unknown; createdAt?: unknown; nonce?: unknown } => {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
};

const lockPresentIssues = async (lockPath: string): Promise<string[]> => {
  const issues = [`Lock file exists: ${lockPath}`];
  try {
    const metadata = parseLockMetadata(await readFile(lockPath, 'utf8'));
    const details = [
      typeof metadata.pid === 'number' ? `pid=${metadata.pid}` : undefined,
      typeof metadata.createdAt === 'string' ? `createdAt=${metadata.createdAt}` : undefined,
    ].filter((detail): detail is string => detail !== undefined);
    if (details.length > 0) {
      issues.push(`Lock owner: ${details.join(', ')}`);
    }
  } catch (error) {
    issues.push(`Could not read lock metadata: ${toErrorMessage(error)}`);
  }
  issues.push(
    'No files were overwritten. Wait for the active operation to finish, then retry.',
    `If no rw-ai bootstrap process is running and the lock is stale, remove only this file and rerun: ${lockPath}`,
  );
  return issues;
};

const acquireBootstrapLock = async (
  lockPath: string,
): Promise<Result<BootstrapLock, ContractError>> => {
  let created = false;
  const nonce = crypto.randomUUID();
  try {
    const handle = await open(lockPath, 'wx');
    created = true;
    try {
      await handle.writeFile(
        `${JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString(), nonce }, null, 2)}\n`,
        'utf8',
      );
    } finally {
      await handle.close();
    }
    return ok({ lockPath, nonce });
  } catch (error) {
    if (created) {
      await rm(lockPath, { force: true }).catch(() => undefined);
    }
    if (hasErrorCode(error, 'EEXIST')) {
      return err(contractError('RWAI bootstrap is already running', await lockPresentIssues(lockPath)));
    }
    return err(
      contractError(`Failed to create bootstrap lock: ${lockPath}`, [toErrorMessage(error)]),
    );
  }
};

const releaseBootstrapLock = async (lock: BootstrapLock): Promise<Result<void, ContractError>> => {
  try {
    let metadata: { nonce?: unknown };
    try {
      metadata = parseLockMetadata(await readFile(lock.lockPath, 'utf8'));
    } catch (error) {
      if (hasErrorCode(error, 'ENOENT')) {
        return ok(undefined);
      }
      throw error;
    }
    if (metadata.nonce !== lock.nonce) {
      return err(
        contractError(`Refusing to remove bootstrap lock owned by another operation: ${lock.lockPath}`, [
          'The lock file nonce does not match this operation.',
          'State may have been prepared, but future runs will fail until the stale lock is inspected.',
        ]),
      );
    }
    await rm(lock.lockPath, { force: true });
    return ok(undefined);
  } catch (error) {
    return err(
      contractError(`Failed to remove bootstrap lock: ${lock.lockPath}`, [
        toErrorMessage(error),
        'State may have been prepared, but future runs will fail until the lock file is removed.',
      ]),
    );
  }
};

const defaultProjectName = (projectRoot: string): string => {
  const name = path.basename(path.resolve(projectRoot));
  return name === '' ? 'project' : name;
};

const loadOrCreateConfig = async (
  params: EnsureRwStateParams,
  configPath: string,
): Promise<
  Result<{ config: AgentsConfig; actions: BootstrapAction[]; shouldWrite: boolean }, ContractError>
> => {
  if (await fileExists(configPath)) {
    const raw = await readJsonFile(configPath);
    if (isErr(raw)) {
      return raw;
    }
    const config = parseAgentsConfig(raw.value);
    if (isErr(config)) {
      return err(withNoOverwriteGuidance(config.error, 'Fix agents.config.json and rerun.'));
    }
    return ok({ config: config.value, actions: ['loaded-config'], shouldWrite: false });
  }

  const config = createDefaultConfig({
    projectName: params.projectName ?? defaultProjectName(params.projectRoot),
    stacks: params.stacks ?? ['node'],
    sessionCount: params.sessionCount ?? 1,
    baseBranch: params.baseBranch,
    integrationBranch: params.integrationBranch,
    worktreesDir: params.worktreesDir,
    boardDir: params.boardDir,
    platforms: params.platforms,
  });
  if (isErr(config)) {
    return err(withNoOverwriteGuidance(config.error, 'Fix bootstrap options and rerun.'));
  }
  return ok({ config: config.value, actions: ['created-config'], shouldWrite: true });
};

const appendSessionIfRequested = async (
  params: EnsureRwStateParams,
  config: AgentsConfig,
): Promise<Result<{ config: AgentsConfig; appendedSession?: Session }, ContractError>> => {
  if (params.appendSession !== true) {
    return ok({ config });
  }

  const nextConfig = appendNextSession({
    config,
    branch: params.branch,
    areas: params.areas,
    platforms: params.platforms,
  });
  if (isErr(nextConfig)) {
    return nextConfig;
  }

  const appendedSession = nextConfig.value.sessions.at(-1);
  if (appendedSession === undefined) {
    return err(contractError('Failed to append session: no session was produced'));
  }

  return ok({ config: nextConfig.value, appendedSession });
};

const appendRuntimeAdoptionMarkerPath = (boardDir: string): string =>
  path.join(boardDir, PENDING_RUNTIME_ADOPTIONS_DIR, APPEND_RUNTIME_ADOPTION_MARKER_FILE);

const parseAppendRuntimeAdoptionMarker = (
  value: unknown,
  markerPath: string,
): Result<AppendRuntimeAdoptionMarker, ContractError> => {
  if (!isRecord(value)) {
    return err(contractError('Invalid pending runtime adoption marker', [`Expected an object: ${markerPath}`]));
  }
  if (
    value.version !== 1 ||
    value.operation !== 'append-runtime-adoption' ||
    typeof value.sessionId !== 'string' ||
    typeof value.worktreePath !== 'string' ||
    typeof value.resolvedWorktreePath !== 'string' ||
    (value.source !== 'current-worktree' && value.source !== 'provided-worktree') ||
    (value.branch !== undefined && typeof value.branch !== 'string') ||
    (value.areas !== undefined && !Array.isArray(value.areas)) ||
    (value.platforms !== undefined && !isRecord(value.platforms)) ||
    typeof value.createdAt !== 'string' ||
    typeof value.nonce !== 'string'
  ) {
    return err(
      contractError('Invalid pending runtime adoption marker', [
        `Marker file is malformed: ${markerPath}`,
        `Remove only this file after inspection, then rerun: ${markerPath}`,
      ]),
    );
  }
  return ok(value as AppendRuntimeAdoptionMarker);
};

const readAppendRuntimeAdoptionMarker = async (
  boardDir: string,
): Promise<Result<AppendRuntimeAdoptionMarker | undefined, ContractError>> => {
  const markerPath = appendRuntimeAdoptionMarkerPath(boardDir);
  if (!(await fileExists(markerPath))) {
    return ok(undefined);
  }

  const raw = await readJsonFile(markerPath);
  if (isErr(raw)) {
    return raw;
  }
  return parseAppendRuntimeAdoptionMarker(raw.value, markerPath);
};

const sameJsonValue = (left: unknown, right: unknown): boolean =>
  JSON.stringify(left) === JSON.stringify(right);

const appendRuntimeAdoptionRequestMatchesMarker = async (
  marker: AppendRuntimeAdoptionMarker,
  params: EnsureRwStateParams,
): Promise<boolean> => {
  const runtimeManifest = params.runtimeManifest;
  if (
    params.appendSession !== true ||
    runtimeManifest === undefined ||
    runtimeManifest.sessionId !== undefined ||
    marker.source !== runtimeManifest.source ||
    path.resolve(marker.worktreePath) !== path.resolve(runtimeManifest.worktreePath) ||
    marker.branch !== params.branch ||
    !sameJsonValue(marker.areas, params.areas) ||
    !sameJsonValue(marker.platforms, params.platforms)
  ) {
    return false;
  }

  try {
    return (await realpath(runtimeManifest.worktreePath)) === marker.resolvedWorktreePath;
  } catch {
    return false;
  }
};

const staleMarkerError = (markerPath: string): ContractError =>
  contractError('Pending runtime adoption marker does not match this request', [
    `Marker file: ${markerPath}`,
    'The marker records an unfinished append+runtime adoption with different intent.',
    `Retry the same command, or remove only this file after inspection: ${markerPath}`,
    'No config or claims files were overwritten.',
  ]);

const writeAppendRuntimeAdoptionMarker = async (
  boardDir: string,
  params: EnsureRwStateParams,
  session: Session,
): Promise<Result<void, ContractError>> => {
  const runtimeManifest = params.runtimeManifest;
  if (
    params.appendSession !== true ||
    runtimeManifest === undefined ||
    runtimeManifest.sessionId !== undefined
  ) {
    return ok(undefined);
  }

  let resolvedWorktreePath: string;
  try {
    resolvedWorktreePath = await realpath(runtimeManifest.worktreePath);
  } catch (error) {
    return err(contractError('Invalid worktree path', [toErrorMessage(error)]));
  }

  const markerDir = path.join(boardDir, PENDING_RUNTIME_ADOPTIONS_DIR);
  const markerDirResult = await ensureBoardContainedDirectory(
    boardDir,
    markerDir,
    'pending runtime adoption directory',
  );
  if (isErr(markerDirResult)) {
    return markerDirResult;
  }

  const marker: AppendRuntimeAdoptionMarker = {
    version: 1,
    operation: 'append-runtime-adoption',
    sessionId: session.id,
    worktreePath: runtimeManifest.worktreePath,
    resolvedWorktreePath,
    source: runtimeManifest.source,
    ...(params.branch === undefined ? {} : { branch: params.branch }),
    ...(params.areas === undefined ? {} : { areas: params.areas }),
    ...(params.platforms === undefined ? {} : { platforms: params.platforms }),
    createdAt: new Date().toISOString(),
    nonce: crypto.randomUUID(),
  };
  return writeJsonFile(appendRuntimeAdoptionMarkerPath(boardDir), marker);
};

const clearAppendRuntimeAdoptionMarker = async (boardDir: string): Promise<Result<void, ContractError>> => {
  const markerPath = appendRuntimeAdoptionMarkerPath(boardDir);
  try {
    await rm(markerPath, { force: true });
    return ok(undefined);
  } catch (error) {
    return err(
      contractError(`Failed to clear pending runtime adoption marker: ${markerPath}`, [
        toErrorMessage(error),
        'Runtime manifest was written, but the retry marker remains and must be inspected.',
      ]),
    );
  }
};

const latestActiveSession = (config: AgentsConfig): Session | undefined => {
  for (let index = config.sessions.length - 1; index >= 0; index -= 1) {
    const session = config.sessions[index];
    if (session?.status === 'active') {
      return session;
    }
  }
  return undefined;
};

export const reconcileClaims = (config: AgentsConfig, claims: ClaimsFile): ClaimsFile => {
  const nextClaims: ClaimsFile['claims'] = { ...claims.claims };
  for (const session of config.sessions) {
    nextClaims[session.id] ??= { status: 'free' };
  }
  nextClaims.integrator ??= { status: 'free' };
  return { version: 1, claims: nextClaims };
};

const loadOrCreateClaims = async (
  claimsPath: string,
  config: AgentsConfig,
): Promise<
  Result<
    {
      claims: ClaimsFile;
      actions: BootstrapAction[];
      shouldWrite: boolean;
      missingSessionClaimIds: string[];
    },
    ContractError
  >
> => {
  if (!(await fileExists(claimsPath))) {
    const claims = createEmptyClaims(config);
    return ok({ claims, actions: ['created-claims'], shouldWrite: true, missingSessionClaimIds: [] });
  }

  const raw = await readJsonFile(claimsPath);
  if (isErr(raw)) {
    return raw;
  }
  const parsed = parseClaimsFile(raw.value);
  if (isErr(parsed)) {
    return err(withNoOverwriteGuidance(parsed.error, 'Fix claims.json and rerun.'));
  }

  const missingSessionClaimIds = config.sessions
    .filter((session) => parsed.value.claims[session.id] === undefined)
    .map((session) => session.id);
  const reconciled = reconcileClaims(config, parsed.value);
  if (JSON.stringify(reconciled.claims) === JSON.stringify(parsed.value.claims)) {
    return ok({
      claims: parsed.value,
      actions: ['loaded-claims'],
      shouldWrite: false,
      missingSessionClaimIds,
    });
  }

  return ok({
    claims: reconciled,
    actions: ['updated-claims'],
    shouldWrite: true,
    missingSessionClaimIds,
  });
};

export const ensureRwState = async (
  params: EnsureRwStateParams,
): Promise<Result<EnsureRwStateResult, ContractError>> => {
  const projectRoot = path.resolve(params.projectRoot);
  const configPath = path.join(projectRoot, AGENTS_CONFIG_FILE);
  const lock = await acquireBootstrapLock(path.join(projectRoot, BOOTSTRAP_LOCK_FILE));
  if (isErr(lock)) {
    return lock;
  }

  let result: Result<EnsureRwStateResult, ContractError>;
  try {
    result = await ensureRwStateLocked({ ...params, projectRoot }, configPath);
  } catch (error) {
    result = err(contractError('Unexpected bootstrap failure', [toErrorMessage(error)]));
  }
  const released = await releaseBootstrapLock(lock.value);
  if (isErr(released)) {
    if (!isErr(result)) {
      return released;
    }
    return err(contractError(result.error.message, [...result.error.issues, ...released.error.issues]));
  }
  return result;
};

const ensureRwStateLocked = async (
  params: EnsureRwStateParams,
  configPath: string,
): Promise<Result<EnsureRwStateResult, ContractError>> => {
  const projectRoot = params.projectRoot;

  const loadedConfig = await loadOrCreateConfig(params, configPath);
  if (isErr(loadedConfig)) {
    return loadedConfig;
  }

  let config = loadedConfig.value.config;
  const boardDirResult = resolveContainedBoardDir(projectRoot, config.board.dir);
  if (isErr(boardDirResult)) {
    return boardDirResult;
  }
  const boardDir = boardDirResult.value;
  const board = await ensureContainedDirectory(projectRoot, boardDir, 'board.dir');
  if (isErr(board)) {
    return board;
  }

  const boardGitignore = await ensureBoardGitignore(boardDir);
  if (isErr(boardGitignore)) {
    return boardGitignore;
  }

  const pendingMarker = await readAppendRuntimeAdoptionMarker(boardDir);
  if (isErr(pendingMarker)) {
    return pendingMarker;
  }

  const markerPath = appendRuntimeAdoptionMarkerPath(boardDir);
  const matchingPendingMarker =
    pendingMarker.value === undefined
      ? undefined
      : (await appendRuntimeAdoptionRequestMatchesMarker(pendingMarker.value, params))
        ? pendingMarker.value
        : undefined;
  if (
    pendingMarker.value !== undefined &&
    matchingPendingMarker === undefined &&
    params.appendSession === true &&
    params.runtimeManifest !== undefined &&
    params.runtimeManifest.sessionId === undefined
  ) {
    return err(staleMarkerError(markerPath));
  }

  const claimsPath = path.join(boardDir, CLAIMS_FILE);
  let claims = await loadOrCreateClaims(claimsPath, config);
  if (isErr(claims)) {
    return claims;
  }

  const shouldFixForwardClaimsBeforeAppend =
    params.appendSession === true &&
    loadedConfig.value.actions.includes('loaded-config') &&
    claims.value.shouldWrite &&
    (claims.value.actions.includes('created-claims') ||
      claims.value.missingSessionClaimIds.length > 0);

  const isAppendRuntimeAdoption =
    params.appendSession === true &&
    params.runtimeManifest !== undefined &&
    params.runtimeManifest.sessionId === undefined;

  const pendingMarkerSession =
    matchingPendingMarker === undefined
      ? undefined
      : config.sessions.find((session) => session.id === matchingPendingMarker.sessionId);

  const fixForwardAppendSession = shouldFixForwardClaimsBeforeAppend && !isAppendRuntimeAdoption
    ? latestActiveSession(config)
    : undefined;
  const retryRuntimeManifestSession = isAppendRuntimeAdoption ? pendingMarkerSession : undefined;
  const shouldSkipAppendForClaimsRepair =
    shouldFixForwardClaimsBeforeAppend && !isAppendRuntimeAdoption;

  const sessionResult: Result<{ config: AgentsConfig; appendedSession?: Session }, ContractError> =
    shouldSkipAppendForClaimsRepair || retryRuntimeManifestSession !== undefined
      ? ok({ config })
      : await appendSessionIfRequested(params, config);
  if (isErr(sessionResult)) {
    return sessionResult;
  }

  config = sessionResult.value.config;

  if (
    matchingPendingMarker !== undefined &&
    retryRuntimeManifestSession === undefined &&
    sessionResult.value.appendedSession?.id !== matchingPendingMarker.sessionId
  ) {
    return err(
      contractError('Cannot complete pending runtime adoption marker', [
        `Marker file: ${markerPath}`,
        `Marker expects session ${matchingPendingMarker.sessionId}, but the next append produced ${
          sessionResult.value.appendedSession?.id ?? 'no session'
        }.`,
        `Remove only this marker after inspection, then rerun: ${markerPath}`,
        'No config or claims files were overwritten.',
      ]),
    );
  }

  if (params.runtimeManifest !== undefined) {
    const runtimeSessionId =
      params.runtimeManifest.sessionId ??
      fixForwardAppendSession?.id ??
      retryRuntimeManifestSession?.id ??
      sessionResult.value.appendedSession?.id;
    const preflight = await preflightRuntimeManifestTarget({
      config,
      sessionId: runtimeSessionId,
      worktreePath: params.runtimeManifest.worktreePath,
    });
    if (isErr(preflight)) {
      return err(withNoConfigClaimsOverwriteGuidance(preflight.error));
    }
  }

  if (sessionResult.value.appendedSession !== undefined) {
    const reconciledClaims = reconcileClaims(config, claims.value.claims);
    claims = ok({
      claims: reconciledClaims,
      actions:
        claims.value.actions.includes('created-claims') ||
        JSON.stringify(reconciledClaims.claims) === JSON.stringify(claims.value.claims)
          ? claims.value.actions
          : ['updated-claims'],
      shouldWrite: true,
      missingSessionClaimIds: [],
    });
  }

  const shouldWriteConfig =
    loadedConfig.value.shouldWrite || sessionResult.value.appendedSession !== undefined;

  if (matchingPendingMarker === undefined && sessionResult.value.appendedSession !== undefined) {
    const marked = await writeAppendRuntimeAdoptionMarker(
      boardDir,
      params,
      sessionResult.value.appendedSession,
    );
    if (isErr(marked)) {
      return marked;
    }
  }

  if (claims.value.shouldWrite) {
    const written = await writeJsonFile(claimsPath, claims.value.claims);
    if (isErr(written)) {
      return written;
    }
  }

  if (shouldWriteConfig) {
    const written = await writeJsonFile(configPath, config);
    if (isErr(written)) {
      return written;
    }
  }

  const sessionEnvs = config.sessions.map((session) => ({
    session,
    entries: sessionEnvEntries(config, session, projectRoot),
  }));

  const runtimeManifests: RuntimeManifestWriteResult[] = [];
  if (params.runtimeManifest !== undefined) {
    const runtimeSessionId =
      params.runtimeManifest.sessionId ??
      fixForwardAppendSession?.id ??
      retryRuntimeManifestSession?.id ??
      sessionResult.value.appendedSession?.id;
    const manifest = await writeRuntimeManifest({
      projectRoot,
      configPath,
      boardDir,
      claimsPath,
      config,
      sessionId: runtimeSessionId,
      worktreePath: params.runtimeManifest.worktreePath,
      source: params.runtimeManifest.source,
      detectBranch: params.runtimeManifest.detectBranch,
      now: params.runtimeManifest.now,
    });
    if (isErr(manifest)) {
      return manifest;
    }
    runtimeManifests.push(manifest.value);
    if (matchingPendingMarker !== undefined || sessionResult.value.appendedSession !== undefined) {
      const cleared = await clearAppendRuntimeAdoptionMarker(boardDir);
      if (isErr(cleared)) {
        return cleared;
      }
    }
  }

  const actions: BootstrapAction[] = [
    ...loadedConfig.value.actions,
    ...(sessionResult.value.appendedSession === undefined ? [] : (['appended-session'] as const)),
    board.value === 'created' ? 'created-board-dir' : 'loaded-board-dir',
    ...claims.value.actions,
    ...(runtimeManifests.length === 0 ? [] : (['wrote-runtime-manifest'] as const)),
  ];

  return ok({
    projectRoot,
    configPath,
    boardDir,
    claimsPath,
    config,
    claims: claims.value.claims,
    actions,
    appendedSession: sessionResult.value.appendedSession,
    sessionEnvs,
    runtimeManifests,
  });
};
