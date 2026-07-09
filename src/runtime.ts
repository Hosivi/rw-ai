import { execFile } from 'node:child_process';
import { lstat, mkdir, open, realpath, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { err, isErr, ok, type Result } from './core/result.js';
import { ENV_KEYS, sessionEnvEntries } from './contract/env.js';
import { contractError, type AgentsConfig, type ContractError, type Session } from './contract/schema.js';

export const RUNTIME_MANIFEST_VERSION = 1;
export const RUNTIME_MANIFESTS_DIR = 'runtime-manifests';
export const REVIEW_BOARD_SESSIONS_DIR = 'sessions';

export type WorktreeAdoptionSource = 'current-worktree' | 'provided-worktree';

export type RuntimeEnvEntry = {
  key: string;
  value: string;
  source: 'generated';
};

export type RuntimeInstanceManifest = {
  version: typeof RUNTIME_MANIFEST_VERSION;
  generatedAt: string;
  projectRoot: string;
  configPath: string;
  session: {
    id: string;
    branch: string;
    status: Session['status'];
    configuredWorktree: string;
    areas: string[];
    ports?: Session['ports'];
    db?: Session['db'];
  };
  worktree: {
    mode: 'external';
    path: string;
    resolvedPath: string;
    branch?: string;
    provenance: {
      kind: 'adopted';
      source: WorktreeAdoptionSource;
      sourcePath: string;
    };
  };
  reviewBoardDir: string;
  paths: {
    manifest: string;
    runtimeManifestsDir: string;
    sessionDir: string;
    claimsFile: string;
    envFile: string;
  };
  ports: Session['ports'];
  db: {
    strategy: AgentsConfig['db']['strategy'];
    service?: string;
    host: string;
    port: number;
    sessionName?: string;
    databaseUrlEnvKey?: typeof ENV_KEYS.databaseUrl;
  };
  env: {
    entries: RuntimeEnvEntry[];
  };
  tests: AgentsConfig['tests'];
};

export type BranchDetector = (worktreePath: string) => Promise<string | undefined>;

export type WriteRuntimeManifestParams = {
  projectRoot: string;
  configPath: string;
  boardDir: string;
  claimsPath: string;
  config: AgentsConfig;
  sessionId?: string;
  worktreePath: string;
  source: WorktreeAdoptionSource;
  detectBranch?: BranchDetector;
  now?: () => Date;
};

export type RuntimeManifestWriteResult = {
  manifestPath: string;
  manifest: RuntimeInstanceManifest;
};

const toErrorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const isPathInside = (parent: string, child: string): boolean => {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
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
    return err(contractError(`Failed to atomically write file: ${filePath}`, [toErrorMessage(error)]));
  }
};

const writeJsonFile = async (filePath: string, value: unknown): Promise<Result<void, ContractError>> =>
  atomicWriteFile(filePath, `${JSON.stringify(value, null, 2)}\n`);

const ensureBoardContainedDirectory = async (
  boardDir: string,
  dirPath: string,
): Promise<Result<string, ContractError>> => {
  try {
    const resolvedBoardDir = await realpath(boardDir);
    const resolvedDir = path.resolve(dirPath);
    if (!isPathInside(resolvedBoardDir, resolvedDir)) {
      return err(
        contractError('Unsafe runtime manifest path', [
          `Runtime manifest directory escapes the review-board directory: ${resolvedDir}`,
          'No runtime manifest was written.',
        ]),
      );
    }
    await mkdir(resolvedDir, { recursive: true });
    const realDir = await realpath(resolvedDir);
    if (!isPathInside(resolvedBoardDir, realDir)) {
      return err(
        contractError('Unsafe runtime manifest path', [
          `Runtime manifest directory resolves outside the review-board directory: ${realDir}`,
          'No runtime manifest was written.',
        ]),
      );
    }
    return ok(realDir);
  } catch (error) {
    return err(contractError(`Failed to ensure runtime manifest directory: ${dirPath}`, [toErrorMessage(error)]));
  }
};

const resolveExistingDirectory = async (
  dirPath: string,
  label: string,
): Promise<Result<string, ContractError>> => {
  const resolved = path.resolve(dirPath);
  try {
    const stats = await lstat(resolved);
    if (!stats.isDirectory() && !stats.isSymbolicLink()) {
      return err(contractError(`Invalid ${label}`, [`Expected a directory: ${resolved}`]));
    }
    const realDir = await realpath(resolved);
    const realStats = await lstat(realDir);
    if (!realStats.isDirectory()) {
      return err(contractError(`Invalid ${label}`, [`Expected a directory: ${realDir}`]));
    }
    return ok(realDir);
  } catch (error) {
    return err(contractError(`Invalid ${label}`, [toErrorMessage(error)]));
  }
};

const execFileText = async (file: string, args: string[]): Promise<string> =>
  new Promise((resolve, reject) => {
    execFile(file, args, { windowsHide: true }, (error, stdout) => {
      if (error !== null) {
        reject(error);
        return;
      }
      resolve(stdout);
    });
  });

export const detectGitBranch: BranchDetector = async (worktreePath) => {
  try {
    const branch = (await execFileText('git', ['-C', worktreePath, 'rev-parse', '--abbrev-ref', 'HEAD'])).trim();
    return branch === '' || branch === 'HEAD' ? undefined : branch;
  } catch {
    return undefined;
  }
};

const selectSession = (
  config: AgentsConfig,
  sessionId: string | undefined,
): Result<Session, ContractError> => {
  const selected =
    sessionId === undefined
      ? config.sessions.find((session) => session.status === 'active')
      : config.sessions.find((session) => session.id === sessionId);
  if (selected === undefined) {
    return err(
      contractError('No RWAI active session available for runtime adoption', [
        sessionId === undefined
          ? 'agents.config.json does not define any active sessions. Append a session or pass --session for an active session.'
          : `Session not found: ${sessionId}`,
      ]),
    );
  }
  if (selected.status !== 'active') {
    return err(
      contractError('No RWAI active session available for runtime adoption', [
        `Session is archived: ${selected.id}`,
        'Runtime adoption requires an active session.',
      ]),
    );
  }
  return ok(selected);
};

export const preflightRuntimeManifestTarget = async (
  params: Pick<WriteRuntimeManifestParams, 'config' | 'sessionId' | 'worktreePath'>,
): Promise<Result<void, ContractError>> => {
  const selectedSession = selectSession(params.config, params.sessionId);
  if (isErr(selectedSession)) {
    return selectedSession;
  }
  const worktree = await resolveExistingDirectory(params.worktreePath, 'worktree path');
  if (isErr(worktree)) {
    return worktree;
  }
  return ok(undefined);
};

const buildDbInfo = (
  config: AgentsConfig,
  session: Session,
): RuntimeInstanceManifest['db'] => ({
  strategy: config.db.strategy,
  ...(config.db.service === undefined ? {} : { service: config.db.service }),
  host: config.db.host,
  port: config.db.port,
  ...(session.db === undefined ? {} : { sessionName: session.db.name, databaseUrlEnvKey: ENV_KEYS.databaseUrl }),
});

export const buildRuntimeManifest = async (
  params: WriteRuntimeManifestParams,
): Promise<Result<RuntimeInstanceManifest, ContractError>> => {
  const projectRoot = path.resolve(params.projectRoot);
  const boardDir = path.resolve(params.boardDir);
  const selectedSession = selectSession(params.config, params.sessionId);
  if (isErr(selectedSession)) {
    return selectedSession;
  }
  const session = selectedSession.value;

  const worktree = await resolveExistingDirectory(params.worktreePath, 'worktree path');
  if (isErr(worktree)) {
    return worktree;
  }

  const runtimeManifestsDir = path.join(boardDir, RUNTIME_MANIFESTS_DIR);
  const sessionDir = path.join(boardDir, REVIEW_BOARD_SESSIONS_DIR, session.id);
  const ensuredRuntimeDir = await ensureBoardContainedDirectory(boardDir, runtimeManifestsDir);
  if (isErr(ensuredRuntimeDir)) {
    return ensuredRuntimeDir;
  }
  const ensuredSessionDir = await ensureBoardContainedDirectory(boardDir, sessionDir);
  if (isErr(ensuredSessionDir)) {
    return ensuredSessionDir;
  }

  const branch = await (params.detectBranch ?? detectGitBranch)(worktree.value);
  const envEntries = sessionEnvEntries(params.config, session, projectRoot).map(([key, value]) => ({
    key,
    value,
    source: 'generated' as const,
  }));

  return ok({
    version: RUNTIME_MANIFEST_VERSION,
    generatedAt: (params.now ?? (() => new Date()))().toISOString(),
    projectRoot,
    configPath: path.resolve(params.configPath),
    session: {
      id: session.id,
      branch: session.branch,
      status: session.status,
      configuredWorktree: session.worktree,
      areas: session.areas,
      ...(session.ports === undefined ? {} : { ports: session.ports }),
      ...(session.db === undefined ? {} : { db: session.db }),
    },
    worktree: {
      mode: 'external',
      path: params.worktreePath,
      resolvedPath: worktree.value,
      ...(branch === undefined ? {} : { branch }),
      provenance: {
        kind: 'adopted',
        source: params.source,
        sourcePath: params.worktreePath,
      },
    },
    reviewBoardDir: boardDir,
    paths: {
      manifest: path.join(ensuredRuntimeDir.value, `${session.id}.json`),
      runtimeManifestsDir: ensuredRuntimeDir.value,
      sessionDir: ensuredSessionDir.value,
      claimsFile: path.resolve(params.claimsPath),
      envFile: path.join(worktree.value, '.env.local'),
    },
    ports: session.ports,
    db: buildDbInfo(params.config, session),
    env: { entries: envEntries },
    tests: params.config.tests,
  });
};

export const writeRuntimeManifest = async (
  params: WriteRuntimeManifestParams,
): Promise<Result<RuntimeManifestWriteResult, ContractError>> => {
  const manifest = await buildRuntimeManifest(params);
  if (isErr(manifest)) {
    return manifest;
  }
  const written = await writeJsonFile(manifest.value.paths.manifest, manifest.value);
  if (isErr(written)) {
    return written;
  }
  return ok({ manifestPath: manifest.value.paths.manifest, manifest: manifest.value });
};
