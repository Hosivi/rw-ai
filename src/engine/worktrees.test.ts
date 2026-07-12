import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgentsConfig } from '../contract/schema.js';
import { err, ok } from '../core/result.js';
import { unwrap, unwrapErr } from '../core/result.test-support.js';
import { ensureIntegrationBranch, ensureSessionBranches } from './branches.js';
import type { CommandRunner } from './exec.js';
import { createGit, type Git } from './git.js';
import { buildConfig, createTempRepo, removeDirRobust, type TempRepo } from './git.test-support.js';
import {
  ensureExcludeEntries,
  ensureGitignoreEntry,
  ensureWorktrees,
  installWorktreeDeps,
} from './worktrees.js';

describe('ensureWorktrees (integration)', () => {
  let repo: TempRepo;
  let git: Git;
  let config: AgentsConfig;

  beforeEach(async () => {
    repo = await createTempRepo();
    git = createGit(repo.root);
    config = buildConfig();
    unwrap(await ensureIntegrationBranch(git, config));
    unwrap(await ensureSessionBranches(git, config));
  });

  afterEach(async () => {
    await repo.cleanup();
  });

  it('creates a worktree per active session on its branch, then reports exists', async () => {
    const first = unwrap(await ensureWorktrees(git, config, repo.root));
    expect(first).toEqual([
      { sessionId: 's1', path: path.join(repo.root, '.worktrees/s1'), action: 'created' },
      { sessionId: 's2', path: path.join(repo.root, '.worktrees/s2'), action: 'created' },
    ]);
    for (const entry of first) {
      expect(existsSync(entry.path)).toBe(true);
    }
    const s1 = first[0];
    expect(s1).toBeDefined();
    if (s1 !== undefined) {
      expect(unwrap(await createGit(s1.path).currentBranch())).toBe('feat/s1-inicial');
    }
    const second = unwrap(await ensureWorktrees(git, config, repo.root));
    expect(second.map((entry) => entry.action)).toEqual(['exists', 'exists']);
  });

  it('skips archived sessions', async () => {
    const archived: AgentsConfig = {
      ...config,
      sessions: config.sessions.map((session) =>
        session.id === 's2' ? { ...session, status: 'archived' as const } : session,
      ),
    };
    const results = unwrap(await ensureWorktrees(git, archived, repo.root));
    expect(results.map((entry) => entry.sessionId)).toEqual(['s1']);
    expect(existsSync(path.join(repo.root, '.worktrees/s2'))).toBe(false);
  });
});

describe('ensureGitignoreEntry', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rw-ai-ignore-'));
  });

  afterEach(async () => {
    await removeDirRobust(dir);
  });

  const gitignorePath = (): string => path.join(dir, '.gitignore');

  it('creates .gitignore when missing', async () => {
    expect(unwrap(await ensureGitignoreEntry(dir, '.worktrees'))).toEqual({
      action: 'created-file',
    });
    expect(await fs.readFile(gitignorePath(), 'utf8')).toBe('/.worktrees/\n');
  });

  it('appends preserving existing content, with LF endings and one trailing newline', async () => {
    await fs.writeFile(gitignorePath(), 'node_modules/\r\ndist\r\n\r\n');
    expect(unwrap(await ensureGitignoreEntry(dir, '.worktrees'))).toEqual({ action: 'added' });
    expect(await fs.readFile(gitignorePath(), 'utf8')).toBe('node_modules/\ndist\n/.worktrees/\n');
  });

  it('is a no-op when the exact line already exists', async () => {
    await fs.writeFile(gitignorePath(), 'dist\n/.worktrees/\n');
    expect(unwrap(await ensureGitignoreEntry(dir, '.worktrees'))).toEqual({ action: 'exists' });
    expect(await fs.readFile(gitignorePath(), 'utf8')).toBe('dist\n/.worktrees/\n');
  });

  it('accepts a pre-existing variant without the leading slash', async () => {
    await fs.writeFile(gitignorePath(), '.worktrees/\n');
    expect(unwrap(await ensureGitignoreEntry(dir, '.worktrees'))).toEqual({ action: 'exists' });
    expect(await fs.readFile(gitignorePath(), 'utf8')).toBe('.worktrees/\n');
  });
});

describe('ensureExcludeEntries', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rw-ai-exclude-'));
  });

  afterEach(async () => {
    await removeDirRobust(dir);
  });

  const excludePath = (): string => path.join(dir, 'info', 'exclude');

  it('creates info/exclude with exactly the given patterns when missing', async () => {
    expect(unwrap(await ensureExcludeEntries(dir, ['.env.local', 'node_modules/']))).toEqual({
      added: ['.env.local', 'node_modules/'],
      action: 'created',
    });
    expect(await fs.readFile(excludePath(), 'utf8')).toBe('.env.local\nnode_modules/\n');
  });

  it('appends only missing patterns, preserving prior lines with LF and one trailing newline', async () => {
    await fs.mkdir(path.join(dir, 'info'), { recursive: true });
    await fs.writeFile(excludePath(), '# git ls-files exclude\r\n.env.local\r\n\r\n');
    expect(unwrap(await ensureExcludeEntries(dir, ['.env.local', 'node_modules/']))).toEqual({
      added: ['node_modules/'],
      action: 'updated',
    });
    expect(await fs.readFile(excludePath(), 'utf8')).toBe(
      '# git ls-files exclude\n.env.local\nnode_modules/\n',
    );
  });

  it('is a no-op reporting exists when every pattern is already present', async () => {
    await fs.mkdir(path.join(dir, 'info'), { recursive: true });
    await fs.writeFile(excludePath(), 'node_modules/\n.env.local\n');
    expect(unwrap(await ensureExcludeEntries(dir, ['.env.local', 'node_modules/']))).toEqual({
      added: [],
      action: 'exists',
    });
    expect(await fs.readFile(excludePath(), 'utf8')).toBe('node_modules/\n.env.local\n');
  });

  it('normalizes CRLF when matching existing patterns', async () => {
    await fs.mkdir(path.join(dir, 'info'), { recursive: true });
    await fs.writeFile(excludePath(), '.env.local\r\nnode_modules/\r\n');
    expect(unwrap(await ensureExcludeEntries(dir, ['.env.local', 'node_modules/']))).toEqual({
      added: [],
      action: 'exists',
    });
  });
});

describe('installWorktreeDeps', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rw-ai-deps-'));
  });

  afterEach(async () => {
    await removeDirRobust(dir);
  });

  type RecordedCall = { command: string; args: readonly string[]; cwd: string };

  // Real installs are far too slow (and network-bound) for the suite: the fake
  // runner records exactly what WOULD be spawned instead.
  const createFakeRunner = (): { calls: RecordedCall[]; run: CommandRunner } => {
    const calls: RecordedCall[] = [];
    const run: CommandRunner = (command, args, opts) => {
      calls.push({ command, args, cwd: opts.cwd });
      return Promise.resolve(ok({ stdout: '', stderr: '', exitCode: 0 }));
    };
    return { calls, run };
  };

  it('skips node without package.json and never invokes pnpm', async () => {
    const { calls, run } = createFakeRunner();
    expect(unwrap(await installWorktreeDeps(dir, ['node'], run))).toEqual([
      { stack: 'node', action: 'skipped', reason: 'no package.json' },
    ]);
    expect(calls).toEqual([]);
  });

  it('runs pnpm install in the worktree when package.json exists', async () => {
    await fs.writeFile(path.join(dir, 'package.json'), '{}\n');
    const { calls, run } = createFakeRunner();
    expect(unwrap(await installWorktreeDeps(dir, ['node'], run))).toEqual([
      { stack: 'node', action: 'installed' },
    ]);
    expect(calls).toEqual([{ command: 'pnpm', args: ['install'], cwd: dir }]);
  });

  it('always skips android', async () => {
    const { calls, run } = createFakeRunner();
    expect(unwrap(await installWorktreeDeps(dir, ['android'], run))).toEqual([
      { stack: 'android', action: 'skipped', reason: 'gradle syncs on build' },
    ]);
    expect(calls).toEqual([]);
  });

  it('runs dotnet restore only when a project or solution exists at top level', async () => {
    const { calls, run } = createFakeRunner();
    expect(unwrap(await installWorktreeDeps(dir, ['dotnet'], run))).toEqual([
      { stack: 'dotnet', action: 'skipped', reason: 'no *.sln or *.csproj at top level' },
    ]);
    expect(calls).toEqual([]);
    await fs.writeFile(path.join(dir, 'App.csproj'), '<Project />\n');
    expect(unwrap(await installWorktreeDeps(dir, ['dotnet'], run))).toEqual([
      { stack: 'dotnet', action: 'installed' },
    ]);
    expect(calls).toEqual([{ command: 'dotnet', args: ['restore'], cwd: dir }]);
  });

  it('reports all stacks of a mixed worktree in order', async () => {
    await fs.writeFile(path.join(dir, 'package.json'), '{}\n');
    const { calls, run } = createFakeRunner();
    expect(unwrap(await installWorktreeDeps(dir, ['node', 'android', 'dotnet'], run))).toEqual([
      { stack: 'node', action: 'installed' },
      { stack: 'android', action: 'skipped', reason: 'gradle syncs on build' },
      { stack: 'dotnet', action: 'skipped', reason: 'no *.sln or *.csproj at top level' },
    ]);
    expect(calls).toEqual([{ command: 'pnpm', args: ['install'], cwd: dir }]);
  });

  it('propagates a failed install naming the stack', async () => {
    await fs.writeFile(path.join(dir, 'package.json'), '{}\n');
    const failingRun: CommandRunner = () =>
      Promise.resolve(err({ kind: 'spawn-failed', message: 'pnpm not found' }));
    const error = unwrapErr(await installWorktreeDeps(dir, ['node'], failingRun));
    expect(error.stack).toBe('node');
    expect(error.message).toContain('pnpm install failed');
  });
});
