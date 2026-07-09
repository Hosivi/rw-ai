import fs from 'node:fs/promises';
import path from 'node:path';
import { resolveBoardDir } from '../contract/env.js';
import type { AgentsConfig, PlatformId, Session } from '../contract/schema.js';
import { err, ok, type Result } from '../core/result.js';
import { activeSessions } from './sessions.js';

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

// Fixed order so generated tables and directory sets are deterministic.
const PLATFORM_IDS = ['web', 'mobile', 'native', 'dotnet'] as const satisfies readonly PlatformId[];

export type BoardError = {
  readonly message: string;
  readonly cause?: unknown;
};

export type BoardEnsureResult = {
  // Absolute paths, split by whether this run had to create them. Every listed
  // path was checked for existence first so the report reflects reality, not the
  // (always-idempotent) mkdir call.
  readonly created: string[];
  readonly existing: string[];
};

const pathExists = async (target: string): Promise<boolean> => {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
};

// The per-session task file is a human checklist: seeded once, then owned by the
// session. ensureBoard never rewrites it, so edits survive every rerun.
const renderTaskTemplate = (session: Session): string => {
  const areas = session.areas.map((area) => `- [ ] \`${area}\``).join('\n');
  return `${[
    `# Sesión ${session.id} — \`${session.branch}\``,
    '',
    'Checklist de las áreas asignadas a esta sesión.',
    '',
    '## Áreas',
    areas,
    '',
    '## Notas',
    '',
  ].join('\n')}`;
};

// board.md is a generated dashboard (writeBoard owns its live content). ensureBoard
// only seeds this placeholder so the tree is complete before the first render.
const boardPlaceholder = (config: AgentsConfig): string =>
  `${[
    `# Review Board — ${config.project.name}`,
    '',
    '> Este tablero se regenera automáticamente en cada corrida del configurador.',
    '> Si ves este texto, todavía no se generó el tablero en vivo.',
    '',
  ].join('\n')}`;

// Leaf directories only: fs.mkdir recursive creates the parents, and checking a
// leaf's existence is enough to classify the run as created vs existing.
const boardDirectories = (config: AgentsConfig, boardDir: string): string[] => {
  const dirs: string[] = [];
  for (const session of activeSessions(config)) {
    dirs.push(path.join(boardDir, 'screenshots', session.id));
    // The read model's per-session status marker lives here (status.json), written
    // by lifecycle hooks and consumed by `rw status`.
    dirs.push(path.join(boardDir, 'sessions', session.id));
    for (const platformId of PLATFORM_IDS) {
      dirs.push(path.join(boardDir, 'test-artifacts', session.id, platformId));
    }
  }
  dirs.push(path.join(boardDir, 'data'));
  dirs.push(path.join(boardDir, 'reports'));
  dirs.push(path.join(boardDir, 'tasks'));
  return dirs;
};

// NO inner .gitignore is written on purpose: the whole board dir is gitignored at
// the repo root so shared board state never diverges per session branch. An inner
// ignore file would be redundant and could hide the artifacts from tooling that
// reads the board directly.
export const ensureBoard = async (
  config: AgentsConfig,
  projectRoot: string,
): Promise<Result<BoardEnsureResult, BoardError>> => {
  const boardDir = resolveBoardDir(projectRoot, config);
  const created: string[] = [];
  const existing: string[] = [];

  for (const dir of boardDirectories(config, boardDir)) {
    const already = await pathExists(dir);
    try {
      await fs.mkdir(dir, { recursive: true });
    } catch (error) {
      return err({ message: `could not create board dir ${dir}: ${errorMessage(error)}`, cause: error });
    }
    (already ? existing : created).push(dir);
  }

  // Files are create-if-absent: an existing file is user (or generated) territory
  // and must not be clobbered by scaffolding.
  const files: Array<{ filePath: string; content: string }> = [
    { filePath: path.join(boardDir, 'board.md'), content: boardPlaceholder(config) },
    ...activeSessions(config).map((session) => ({
      filePath: path.join(boardDir, 'tasks', `${session.id}.md`),
      content: renderTaskTemplate(session),
    })),
  ];
  for (const { filePath, content } of files) {
    if (await pathExists(filePath)) {
      existing.push(filePath);
      continue;
    }
    try {
      await fs.writeFile(filePath, content, 'utf8');
    } catch (error) {
      return err({ message: `could not write ${filePath}: ${errorMessage(error)}`, cause: error });
    }
    created.push(filePath);
  }

  return ok({ created, existing });
};

// Live dynamic bits the board surfaces beyond static config. Both are placeholders
// in this phase; later phases fill them from real integrator and test runs.
export type BoardSnapshot = {
  readonly lastIntegratorCheck?: string;
  readonly lastTestResults?: string;
};

const STATUS_LABELS = { active: 'activa', archived: 'archivada' } as const;

const enabledPlatforms = (session: Session): PlatformId[] =>
  PLATFORM_IDS.filter((id) => session.platforms[id]?.enabled === true);

const sessionRow = (session: Session): string => {
  const platforms = enabledPlatforms(session);
  const cells = [
    session.id,
    `\`${session.branch}\``,
    `\`${session.worktree}\``,
    platforms.length > 0 ? platforms.join(', ') : '—',
    session.db === undefined ? '—' : `\`${session.db.name}\``,
    STATUS_LABELS[session.status],
  ];
  return `| ${cells.join(' | ')} |`;
};

// Pure and deterministic: identical (config, snapshot, now) always yields identical
// markdown, which is what makes writeBoard's unchanged-skip reliable.
export const renderBoard = (
  config: AgentsConfig,
  snapshot: BoardSnapshot,
  now: Date,
): string => {
  const lines: string[] = [
    `# Review Board — ${config.project.name}`,
    '',
    `Generado: ${now.toISOString()}`,
    '',
    '## Sesiones',
    '',
    '| Sesión | Rama | Worktree | Plataformas | Base de datos | Estado |',
    '| --- | --- | --- | --- | --- | --- |',
    ...config.sessions.map(sessionRow),
    '',
    '## Último chequeo del integrador',
    '',
    snapshot.lastIntegratorCheck ?? '_Sin datos todavía._',
    '',
    '## Últimos resultados de tests',
    '',
    snapshot.lastTestResults ?? '_Sin datos todavía._',
    '',
  ];
  return lines.join('\n');
};

export type WriteAction = 'created' | 'updated' | 'unchanged';

// Generic idempotent write: unchanged bytes are never rewritten, so file watchers
// (dev servers, board viewers) do not restart on a no-op run. Shared by the board
// and branch-graph writers. Assumes the parent directory already exists.
export const writeFileIdempotent = async (
  filePath: string,
  content: string,
): Promise<Result<{ action: WriteAction }, BoardError>> => {
  let existing: string | null = null;
  try {
    existing = await fs.readFile(filePath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      return err({ message: `could not read ${filePath}: ${errorMessage(error)}`, cause: error });
    }
  }
  if (existing === content) {
    return ok({ action: 'unchanged' });
  }
  try {
    await fs.writeFile(filePath, content, 'utf8');
  } catch (error) {
    return err({ message: `could not write ${filePath}: ${errorMessage(error)}`, cause: error });
  }
  return ok({ action: existing === null ? 'created' : 'updated' });
};

export type BoardWriteResult = {
  readonly action: WriteAction;
  readonly path: string;
};

export const writeBoard = async (
  config: AgentsConfig,
  snapshot: BoardSnapshot,
  now: Date,
  projectRoot: string,
): Promise<Result<BoardWriteResult, BoardError>> => {
  const boardDir = resolveBoardDir(projectRoot, config);
  const filePath = path.join(boardDir, 'board.md');
  // Standalone-safe: the caller may run writeBoard without ensureBoard first.
  try {
    await fs.mkdir(boardDir, { recursive: true });
  } catch (error) {
    return err({ message: `could not create board dir ${boardDir}: ${errorMessage(error)}`, cause: error });
  }
  const written = await writeFileIdempotent(filePath, renderBoard(config, snapshot, now));
  return written.ok ? ok({ action: written.value.action, path: filePath }) : written;
};
