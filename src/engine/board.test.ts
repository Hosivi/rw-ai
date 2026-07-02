import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { unwrap } from '../core/result.test-support.js';
import { ensureBoard, renderBoard, writeBoard, type BoardSnapshot } from './board.js';
import { buildConfig, removeDirRobust } from './git.test-support.js';

const NOW = new Date('2026-07-02T12:00:00.000Z');
const EMPTY_SNAPSHOT: BoardSnapshot = {};

describe('ensureBoard', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rw-ai-board-'));
  });

  afterEach(() => removeDirRobust(dir));

  const boardDir = (): string => path.join(dir, '.review-board');

  it('creates the full tree, then reports everything existing (never clobbering)', async () => {
    const config = buildConfig();
    const first = unwrap(await ensureBoard(config, dir));
    expect(first.created.length).toBeGreaterThan(0);
    expect(first.existing).toEqual([]);

    // Spot-check the required tree: per-session screenshot + test-artifact dirs,
    // the shared dirs, and the seeded files.
    expect(existsSync(path.join(boardDir(), 'screenshots', 's1'))).toBe(true);
    expect(existsSync(path.join(boardDir(), 'screenshots', 's2'))).toBe(true);
    for (const platform of ['web', 'mobile', 'native', 'dotnet']) {
      expect(existsSync(path.join(boardDir(), 'test-artifacts', 's1', platform))).toBe(true);
    }
    for (const shared of ['data', 'reports', 'tasks']) {
      expect(existsSync(path.join(boardDir(), shared))).toBe(true);
    }
    expect(existsSync(path.join(boardDir(), 'board.md'))).toBe(true);
    expect(existsSync(path.join(boardDir(), 'tasks', 's1.md'))).toBe(true);
    expect(existsSync(path.join(boardDir(), 'tasks', 's2.md'))).toBe(true);

    // No inner .gitignore is written: the whole board is gitignored at the root.
    expect(existsSync(path.join(boardDir(), '.gitignore'))).toBe(false);

    // A user edit to a task file must survive the next scaffolding run.
    const taskPath = path.join(boardDir(), 'tasks', 's1.md');
    const sentinel = `${await fs.readFile(taskPath, 'utf8')}\n- [x] mi tarea propia\n`;
    await fs.writeFile(taskPath, sentinel, 'utf8');

    const second = unwrap(await ensureBoard(config, dir));
    expect(second.created).toEqual([]);
    expect(second.existing.length).toBe(first.created.length);
    expect(await fs.readFile(taskPath, 'utf8')).toBe(sentinel);
  });

  it('seeds tasks/s{i}.md with the session id, branch and area checklist', async () => {
    const config = buildConfig();
    unwrap(await ensureBoard(config, dir));
    const task = await fs.readFile(path.join(boardDir(), 'tasks', 's1.md'), 'utf8');
    expect(task).toContain('# Sesión s1');
    expect(task).toContain('feat/s1-inicial');
    expect(task).toContain('## Áreas');
    expect(task).toContain('- [ ]');
  });
});

describe('renderBoard', () => {
  it('is deterministic and lists every session branch and the generated timestamp', () => {
    const config = buildConfig();
    const first = renderBoard(config, EMPTY_SNAPSHOT, NOW);
    const second = renderBoard(config, EMPTY_SNAPSHOT, NOW);
    expect(first).toBe(second);
    expect(first).toContain('feat/s1-inicial');
    expect(first).toContain('feat/s2-inicial');
    expect(first).toContain(NOW.toISOString());
    // Neutral-Spanish, human-facing placeholder sections.
    expect(first).toContain('Último chequeo del integrador');
    expect(first).toContain('Últimos resultados de tests');
    // No db and no platforms configured -> placeholder dashes in those cells.
    expect(first).toContain('—');
  });

  it('lists enabled platforms in the session row', () => {
    const config = buildConfig({
      platforms: { web: { enabled: true, e2e: { enabled: false } } },
    });
    expect(renderBoard(config, EMPTY_SNAPSHOT, NOW)).toContain('web');
  });

  it('renders provided snapshot sections instead of the placeholders', () => {
    const config = buildConfig();
    const snapshot: BoardSnapshot = {
      lastIntegratorCheck: 'sin conflictos',
      lastTestResults: '12 verdes',
    };
    const rendered = renderBoard(config, snapshot, NOW);
    expect(rendered).toContain('sin conflictos');
    expect(rendered).toContain('12 verdes');
  });
});

describe('writeBoard', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rw-ai-board-write-'));
  });

  afterEach(() => removeDirRobust(dir));

  it('creates board.md, then reports unchanged (and does not rewrite) on rerun', async () => {
    const config = buildConfig();
    const boardPath = path.join(dir, '.review-board', 'board.md');

    const created = unwrap(await writeBoard(config, EMPTY_SNAPSHOT, NOW, dir));
    expect(created.action).toBe('created');
    expect(created.path).toBe(boardPath);
    expect(existsSync(boardPath)).toBe(true);

    const before = await fs.stat(boardPath);
    const rerun = unwrap(await writeBoard(config, EMPTY_SNAPSHOT, NOW, dir));
    expect(rerun.action).toBe('unchanged');
    const after = await fs.stat(boardPath);
    expect(after.mtimeMs).toBe(before.mtimeMs);
  });

  it('reports updated when the rendered content changes', async () => {
    const config = buildConfig();
    unwrap(await writeBoard(config, EMPTY_SNAPSHOT, NOW, dir));
    const later = new Date('2026-07-03T09:00:00.000Z');
    const updated = unwrap(await writeBoard(config, EMPTY_SNAPSHOT, later, dir));
    expect(updated.action).toBe('updated');
  });
});
