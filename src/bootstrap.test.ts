import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { access, mkdtemp, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { unwrap } from './core/result.test-support.js';
import { BOOTSTRAP_LOCK_FILE, ensureRwState, reconcileClaims } from './bootstrap.js';
import { createDefaultConfig } from './contract/defaults.js';
import type { ClaimsFile } from './contract/schema.js';

const tempProject = async (): Promise<string> =>
  mkdtemp(path.join(os.tmpdir(), 'rw-ai-bootstrap-'));

const readJson = async (filePath: string): Promise<unknown> =>
  JSON.parse(await readFile(filePath, 'utf8')) as unknown;

const expectBoardGitignoreProtectsClaims = async (boardDir: string): Promise<void> => {
  const content = await readFile(path.join(boardDir, '.gitignore'), 'utf8');
  expect(content.split(/\r?\n/)).toEqual(
    expect.arrayContaining([
      'claims.json',
      '.claims.json.*.tmp',
      'runtime-manifests/',
      'pending-runtime-adoptions/',
    ]),
  );
};

const appendRuntimeAdoptionMarkerPath = (projectRoot: string): string =>
  path.join(projectRoot, '.review-board', 'pending-runtime-adoptions', 'append-runtime-adoption.json');

const exists = async (filePath: string): Promise<boolean> => {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
};

const supportsDirectorySymlink = (): boolean => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'rw-ai-symlink-support-'));
  try {
    const target = path.join(root, 'target');
    const link = path.join(root, 'link');
    rmSync(target, { recursive: true, force: true });
    rmSync(link, { recursive: true, force: true });
    mkdirSync(target);
    symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
    return true;
  } catch {
    return false;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
};

describe('ensureRwState', () => {
  it('creates deterministic config, board, claims, and session env entries in a temp project', async () => {
    const projectRoot = await tempProject();

    const result = unwrap(
      await ensureRwState({ projectRoot, projectName: 'Demo', stacks: ['node'] }),
    );

    expect(result.actions).toEqual(['created-config', 'created-board-dir', 'created-claims']);
    expect(result.configPath).toBe(path.join(projectRoot, 'agents.config.json'));
    expect(result.boardDir).toBe(path.join(projectRoot, '.review-board'));
    expect(result.claimsPath).toBe(path.join(projectRoot, '.review-board', 'claims.json'));
    expect((await stat(result.boardDir)).isDirectory()).toBe(true);
    await expectBoardGitignoreProtectsClaims(result.boardDir);
    expect(await readJson(result.configPath)).toEqual(result.config);
    expect(await readJson(result.claimsPath)).toEqual(result.claims);
    expect(Object.keys(result.claims.claims).sort()).toEqual(['integrator', 's1']);
    expect(result.sessionEnvs).toHaveLength(1);
    expect(result.runtimeManifests).toEqual([]);
    expect(Object.fromEntries(result.sessionEnvs[0]!.entries)).toMatchObject({
      RW_SESSION: 's1',
      RW_BOARD_DIR: result.boardDir,
      PORT: '3000',
    });
  });

  it('can emit a runtime manifest for an adopted current worktree', async () => {
    const projectRoot = await tempProject();

    const result = unwrap(
      await ensureRwState({
        projectRoot,
        projectName: 'Demo',
        stacks: ['node'],
        runtimeManifest: {
          worktreePath: projectRoot,
          source: 'current-worktree',
          detectBranch: async () => 'feat/adopted',
          now: () => new Date('2026-07-07T12:00:00.000Z'),
        },
      }),
    );

    const manifestPath = path.join(projectRoot, '.review-board', 'runtime-manifests', 's1.json');
    expect(result.actions).toEqual([
      'created-config',
      'created-board-dir',
      'created-claims',
      'wrote-runtime-manifest',
    ]);
    expect(result.runtimeManifests[0]?.manifestPath).toBe(manifestPath);
    expect(await readJson(manifestPath)).toEqual(result.runtimeManifests[0]?.manifest);
    expect(result.runtimeManifests[0]?.manifest).toMatchObject({
      version: 1,
      generatedAt: '2026-07-07T12:00:00.000Z',
      session: { id: 's1', branch: 'feat/s1-inicial' },
      worktree: {
        mode: 'external',
        resolvedPath: projectRoot,
        branch: 'feat/adopted',
        provenance: { kind: 'adopted', source: 'current-worktree', sourcePath: projectRoot },
      },
      paths: {
        manifest: manifestPath,
        sessionDir: path.join(projectRoot, '.review-board', 'sessions', 's1'),
        envFile: path.join(projectRoot, '.env.local'),
      },
    });
  });

  it('retries a failed append-session runtime manifest write without appending another session', async () => {
    const projectRoot = await tempProject();
    const first = unwrap(
      await ensureRwState({ projectRoot, projectName: 'Demo', stacks: ['node'] }),
    );
    const blockedManifestPath = path.join(
      projectRoot,
      '.review-board',
      'runtime-manifests',
      's2.json',
    );
    mkdirSync(path.dirname(blockedManifestPath), { recursive: true });
    mkdirSync(blockedManifestPath);

    const failed = await ensureRwState({
      projectRoot,
      appendSession: true,
      runtimeManifest: {
        worktreePath: projectRoot,
        source: 'current-worktree',
        detectBranch: async () => 'feat/retry-safe',
        now: () => new Date('2026-07-07T12:30:00.000Z'),
      },
    });

    expect(failed.ok).toBe(false);
    expect(await exists(appendRuntimeAdoptionMarkerPath(projectRoot))).toBe(true);
    expect(await readJson(appendRuntimeAdoptionMarkerPath(projectRoot))).toMatchObject({
      operation: 'append-runtime-adoption',
      sessionId: 's2',
      worktreePath: projectRoot,
      source: 'current-worktree',
    });
    const configAfterFailure = (await readJson(first.configPath)) as { sessions: Array<{ id: string }> };
    const claimsAfterFailure = (await readJson(first.claimsPath)) as ClaimsFile;
    expect(configAfterFailure.sessions.map((session) => session.id)).toEqual(['s1', 's2']);
    expect(claimsAfterFailure.claims.s2).toEqual({ status: 'free' });

    rmSync(blockedManifestPath, { recursive: true, force: true });

    const retried = unwrap(
      await ensureRwState({
        projectRoot,
        appendSession: true,
        runtimeManifest: {
          worktreePath: projectRoot,
          source: 'current-worktree',
          detectBranch: async () => 'feat/retry-safe',
          now: () => new Date('2026-07-07T12:31:00.000Z'),
        },
      }),
    );

    expect(retried.actions).toEqual([
      'loaded-config',
      'loaded-board-dir',
      'loaded-claims',
      'wrote-runtime-manifest',
    ]);
    expect(retried.appendedSession).toBeUndefined();
    expect(retried.config.sessions.map((session) => session.id)).toEqual(['s1', 's2']);
    expect(retried.runtimeManifests[0]?.manifestPath).toBe(blockedManifestPath);
    expect(retried.runtimeManifests[0]?.manifest.session.id).toBe('s2');
    expect((await readJson(blockedManifestPath)) as unknown).toEqual(
      retried.runtimeManifests[0]?.manifest,
    );
    expect(await exists(appendRuntimeAdoptionMarkerPath(projectRoot))).toBe(false);
  });

  it('retries a failed append-session runtime manifest write when the manifest directory could not be created', async () => {
    const projectRoot = await tempProject();
    const first = unwrap(
      await ensureRwState({ projectRoot, projectName: 'Demo', stacks: ['node'] }),
    );
    const blockedManifestDir = path.join(projectRoot, '.review-board', 'runtime-manifests');
    await writeFile(blockedManifestDir, 'not a directory\n', 'utf8');

    const failed = await ensureRwState({
      projectRoot,
      appendSession: true,
      runtimeManifest: {
        worktreePath: projectRoot,
        source: 'current-worktree',
        detectBranch: async () => 'feat/retry-before-dir',
        now: () => new Date('2026-07-07T12:40:00.000Z'),
      },
    });

    expect(failed.ok).toBe(false);
    expect(await exists(appendRuntimeAdoptionMarkerPath(projectRoot))).toBe(true);
    const configAfterFailure = (await readJson(first.configPath)) as { sessions: Array<{ id: string }> };
    const claimsAfterFailure = (await readJson(first.claimsPath)) as ClaimsFile;
    expect(configAfterFailure.sessions.map((session) => session.id)).toEqual(['s1', 's2']);
    expect(claimsAfterFailure.claims.s2).toEqual({ status: 'free' });

    rmSync(blockedManifestDir, { force: true });

    const retried = unwrap(
      await ensureRwState({
        projectRoot,
        appendSession: true,
        runtimeManifest: {
          worktreePath: projectRoot,
          source: 'current-worktree',
          detectBranch: async () => 'feat/retry-before-dir',
          now: () => new Date('2026-07-07T12:41:00.000Z'),
        },
      }),
    );

    expect(retried.appendedSession).toBeUndefined();
    expect(retried.config.sessions.map((session) => session.id)).toEqual(['s1', 's2']);
    expect(retried.runtimeManifests[0]?.manifestPath).toBe(
      path.join(blockedManifestDir, 's2.json'),
    );
    expect(retried.runtimeManifests[0]?.manifest.session.id).toBe('s2');
    expect(await exists(appendRuntimeAdoptionMarkerPath(projectRoot))).toBe(false);
  });

  it('does not treat a prior active session without a manifest as an append-runtime retry without a marker', async () => {
    const projectRoot = await tempProject();
    unwrap(
      await ensureRwState({
        projectRoot,
        projectName: 'Demo',
        stacks: ['node'],
        runtimeManifest: {
          worktreePath: projectRoot,
          source: 'current-worktree',
          detectBranch: async () => undefined,
        },
      }),
    );
    unwrap(await ensureRwState({ projectRoot, appendSession: true }));

    const result = unwrap(
      await ensureRwState({
        projectRoot,
        appendSession: true,
        runtimeManifest: {
          worktreePath: projectRoot,
          source: 'current-worktree',
          detectBranch: async () => 'feat/new-adoption',
        },
      }),
    );

    expect(result.appendedSession?.id).toBe('s3');
    expect(result.config.sessions.map((session) => session.id)).toEqual(['s1', 's2', 's3']);
    expect(result.runtimeManifests[0]?.manifest.session.id).toBe('s3');
    expect(await exists(path.join(projectRoot, '.review-board', 'runtime-manifests', 's2.json'))).toBe(false);
    expect(await exists(path.join(projectRoot, '.review-board', 'runtime-manifests', 's3.json'))).toBe(true);
  });

  it('appends a new runtime session instead of adopting the latest active session when claims need repair without a marker', async () => {
    const projectRoot = await tempProject();
    const first = unwrap(
      await ensureRwState({ projectRoot, projectName: 'Demo', stacks: ['node'] }),
    );
    const configWithPreviouslyAppendedSession = unwrap(
      createDefaultConfig({ projectName: 'Demo', stacks: ['node'], sessionCount: 2 }),
    );
    await writeFile(
      first.configPath,
      `${JSON.stringify(configWithPreviouslyAppendedSession, null, 2)}\n`,
      'utf8',
    );

    const result = unwrap(
      await ensureRwState({
        projectRoot,
        appendSession: true,
        runtimeManifest: {
          worktreePath: projectRoot,
          source: 'current-worktree',
          detectBranch: async () => 'feat/new-after-claims-repair',
        },
      }),
    );

    expect(result.appendedSession?.id).toBe('s3');
    expect(result.config.sessions.map((session) => session.id)).toEqual(['s1', 's2', 's3']);
    expect(result.claims.claims.s2).toEqual({ status: 'free' });
    expect(result.claims.claims.s3).toEqual({ status: 'free' });
    expect(result.runtimeManifests[0]?.manifest.session.id).toBe('s3');
    expect(await exists(path.join(projectRoot, '.review-board', 'runtime-manifests', 's2.json'))).toBe(false);
    expect(await exists(path.join(projectRoot, '.review-board', 'runtime-manifests', 's3.json'))).toBe(true);
    expect(await exists(appendRuntimeAdoptionMarkerPath(projectRoot))).toBe(false);
  });

  it('rejects a stale append-runtime marker with different intent before appending or writing a manifest', async () => {
    const projectRoot = await tempProject();
    const first = unwrap(
      await ensureRwState({ projectRoot, projectName: 'Demo', stacks: ['node'] }),
    );
    const originalConfig = await readFile(first.configPath, 'utf8');
    const originalClaims = await readFile(first.claimsPath, 'utf8');
    const markerPath = appendRuntimeAdoptionMarkerPath(projectRoot);
    mkdirSync(path.dirname(markerPath), { recursive: true });
    await writeFile(
      markerPath,
      `${JSON.stringify(
        {
          version: 1,
          operation: 'append-runtime-adoption',
          sessionId: 's2',
          worktreePath: projectRoot,
          resolvedWorktreePath: await realpath(projectRoot),
          source: 'current-worktree',
          branch: 'feat/old-intent',
          createdAt: '2026-07-07T12:45:00.000Z',
          nonce: 'stale-intent',
        },
        null,
        2,
      )}\n`,
      'utf8',
    );

    const result = await ensureRwState({
      projectRoot,
      appendSession: true,
      branch: 'feat/new-intent',
      runtimeManifest: {
        worktreePath: projectRoot,
        source: 'current-worktree',
        detectBranch: async () => 'feat/new-intent',
      },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toBe('Pending runtime adoption marker does not match this request');
      expect(result.error.issues.join('\n')).toContain('different intent');
      expect(result.error.issues.join('\n')).toContain('Retry the same command');
      expect(result.error.issues.join('\n')).toContain('No config or claims files were overwritten');
      expect(result.error.issues.join('\n')).toContain(markerPath);
    }
    expect(await readFile(first.configPath, 'utf8')).toBe(originalConfig);
    expect(await readFile(first.claimsPath, 'utf8')).toBe(originalClaims);
    expect(await exists(path.join(projectRoot, '.review-board', 'runtime-manifests', 's2.json'))).toBe(false);
    expect(await exists(markerPath)).toBe(true);
  });

  it('completes a pending append-runtime marker when the session was not persisted yet', async () => {
    const projectRoot = await tempProject();
    unwrap(await ensureRwState({ projectRoot, projectName: 'Demo', stacks: ['node'] }));
    const markerPath = appendRuntimeAdoptionMarkerPath(projectRoot);
    mkdirSync(path.dirname(markerPath), { recursive: true });
    await writeFile(
      markerPath,
      `${JSON.stringify(
        {
          version: 1,
          operation: 'append-runtime-adoption',
          sessionId: 's2',
          worktreePath: projectRoot,
          resolvedWorktreePath: await realpath(projectRoot),
          source: 'current-worktree',
          createdAt: '2026-07-07T12:50:00.000Z',
          nonce: 'pending-before-config',
        },
        null,
        2,
      )}\n`,
      'utf8',
    );

    const result = unwrap(
      await ensureRwState({
        projectRoot,
        appendSession: true,
        runtimeManifest: {
          worktreePath: projectRoot,
          source: 'current-worktree',
          detectBranch: async () => 'feat/pending-before-config',
        },
      }),
    );

    expect(result.appendedSession?.id).toBe('s2');
    expect(result.config.sessions.map((session) => session.id)).toEqual(['s1', 's2']);
    expect(result.claims.claims.s2).toEqual({ status: 'free' });
    expect(result.runtimeManifests[0]?.manifest.session.id).toBe('s2');
    expect(await exists(markerPath)).toBe(false);
  });

  it('rejects an unknown explicit runtime session before appending config or claims', async () => {
    const projectRoot = await tempProject();
    const first = unwrap(
      await ensureRwState({ projectRoot, projectName: 'Demo', stacks: ['node'] }),
    );
    const originalConfig = await readFile(first.configPath, 'utf8');
    const originalClaims = await readFile(first.claimsPath, 'utf8');

    const result = await ensureRwState({
      projectRoot,
      appendSession: true,
      runtimeManifest: {
        sessionId: 's999',
        worktreePath: projectRoot,
        source: 'current-worktree',
        detectBranch: async () => undefined,
      },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toBe('No RWAI active session available for runtime adoption');
      expect(result.error.issues.join('\n')).toContain('Session not found: s999');
      expect(result.error.issues.join('\n')).toContain('No config or claims files were overwritten');
    }
    expect(await readFile(first.configPath, 'utf8')).toBe(originalConfig);
    expect(await readFile(first.claimsPath, 'utf8')).toBe(originalClaims);
    expect(await exists(path.join(projectRoot, '.review-board', 'runtime-manifests', 's999.json'))).toBe(false);
  });

  it('rejects a bad runtime worktree path before appending config or claims', async () => {
    const projectRoot = await tempProject();
    const first = unwrap(
      await ensureRwState({ projectRoot, projectName: 'Demo', stacks: ['node'] }),
    );
    const originalConfig = await readFile(first.configPath, 'utf8');
    const originalClaims = await readFile(first.claimsPath, 'utf8');
    const missingWorktree = path.join(projectRoot, 'missing-worktree');

    const result = await ensureRwState({
      projectRoot,
      appendSession: true,
      runtimeManifest: {
        worktreePath: missingWorktree,
        source: 'provided-worktree',
        detectBranch: async () => undefined,
      },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toBe('Invalid worktree path');
      expect(result.error.issues.join('\n')).toContain('No config or claims files were overwritten');
    }
    expect(await readFile(first.configPath, 'utf8')).toBe(originalConfig);
    expect(await readFile(first.claimsPath, 'utf8')).toBe(originalClaims);
    expect(await exists(missingWorktree)).toBe(false);
  });

  it('fails runtime adoption clearly when only archived sessions exist', async () => {
    const projectRoot = await tempProject();
    const first = unwrap(
      await ensureRwState({ projectRoot, projectName: 'Demo', stacks: ['node'] }),
    );
    const archivedConfig = { ...first.config, sessions: [{ ...first.config.sessions[0]!, status: 'archived' }] };
    await writeFile(first.configPath, `${JSON.stringify(archivedConfig, null, 2)}\n`, 'utf8');
    const originalConfig = await readFile(first.configPath, 'utf8');
    const originalClaims = await readFile(first.claimsPath, 'utf8');

    const result = await ensureRwState({
      projectRoot,
      runtimeManifest: {
        worktreePath: projectRoot,
        source: 'current-worktree',
        detectBranch: async () => undefined,
      },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toBe('No RWAI active session available for runtime adoption');
      expect(result.error.issues.join('\n')).toContain('agents.config.json does not define any active sessions');
    }
    expect(await readFile(first.configPath, 'utf8')).toBe(originalConfig);
    expect(await readFile(first.claimsPath, 'utf8')).toBe(originalClaims);
  });

  it('creates a board-local gitignore for a custom board directory', async () => {
    const projectRoot = await tempProject();

    const result = unwrap(
      await ensureRwState({
        projectRoot,
        projectName: 'Demo',
        stacks: ['node'],
        boardDir: 'custom-board',
      }),
    );

    expect(result.boardDir).toBe(path.join(projectRoot, 'custom-board'));
    expect(result.claimsPath).toBe(path.join(projectRoot, 'custom-board', 'claims.json'));
    await expectBoardGitignoreProtectsClaims(result.boardDir);
  });

  it('loads existing state without appending a session by default', async () => {
    const projectRoot = await tempProject();
    unwrap(await ensureRwState({ projectRoot, projectName: 'Demo', stacks: ['node'] }));

    const result = unwrap(await ensureRwState({ projectRoot }));

    expect(result.actions).toEqual(['loaded-config', 'loaded-board-dir', 'loaded-claims']);
    expect(result.config.sessions.map((session) => session.id)).toEqual(['s1']);
    expect(result.appendedSession).toBeUndefined();
  });

  it('appends the next session and adds a free claim without replacing existing claims', async () => {
    const projectRoot = await tempProject();
    const first = unwrap(
      await ensureRwState({ projectRoot, projectName: 'Demo', stacks: ['node'] }),
    );
    const claimed: ClaimsFile = {
      version: 1,
      claims: {
        s1: {
          status: 'claimed',
          token: 'abcdef1234',
          claimedAt: '2026-07-02T10:00:00.000Z',
          expiresAt: '2026-07-02T11:00:00.000Z',
          agent: 'custom-agent',
        },
        integrator: { status: 'free' },
      },
    };
    await writeFile(first.claimsPath, `${JSON.stringify(claimed, null, 2)}\n`, 'utf8');

    const result = unwrap(await ensureRwState({ projectRoot, appendSession: true }));

    expect(result.actions).toEqual([
      'loaded-config',
      'appended-session',
      'loaded-board-dir',
      'updated-claims',
    ]);
    expect(result.appendedSession?.id).toBe('s2');
    expect(result.config.sessions.map((session) => session.id)).toEqual(['s1', 's2']);
    expect(result.claims.claims.s1).toEqual(claimed.claims.s1);
    expect(result.claims.claims.s2).toEqual({ status: 'free' });
    expect(Object.fromEntries(result.sessionEnvs[1]!.entries)).toMatchObject({
      RW_SESSION: 's2',
      PORT: '3001',
    });
    expect(await readJson(result.claimsPath)).toEqual(result.claims);
  });

  it('returns a parse error without overwriting an invalid config', async () => {
    const projectRoot = await tempProject();
    const configPath = path.join(projectRoot, 'agents.config.json');
    await writeFile(configPath, '{"version":2}\n', 'utf8');

    const result = await ensureRwState({ projectRoot });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toBe('Invalid agents.config.json');
    }
    expect(await readFile(configPath, 'utf8')).toBe('{"version":2}\n');
  });

  it('rejects parent traversal in board.dir before writing project state', async () => {
    const projectRoot = await tempProject();

    const result = await ensureRwState({ projectRoot, boardDir: '../outside' });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.issues.join('\n')).toContain('board.dir');
      expect(result.error.issues.join('\n')).toContain('No files were overwritten');
    }
    expect(await exists(path.join(projectRoot, 'agents.config.json'))).toBe(false);
  });

  it('rejects absolute board.dir before writing project state', async () => {
    const projectRoot = await tempProject();

    const result = await ensureRwState({ projectRoot, boardDir: path.join(projectRoot, 'board') });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.issues.join('\n')).toContain('board.dir');
      expect(result.error.issues.join('\n')).toContain('relative path');
    }
    expect(await exists(path.join(projectRoot, 'agents.config.json'))).toBe(false);
  });

  it.skipIf(!supportsDirectorySymlink())(
    'rejects an existing board directory symlink that resolves outside the project',
    async () => {
      const projectRoot = await tempProject();
      const outside = await tempProject();
      symlinkSync(
        outside,
        path.join(projectRoot, '.review-board'),
        process.platform === 'win32' ? 'junction' : 'dir',
      );

      const result = await ensureRwState({ projectRoot, projectName: 'Demo', stacks: ['node'] });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toBe('Unsafe board.dir in agents.config.json');
        expect(result.error.issues.join('\n')).toContain('resolves outside the project root');
      }
      expect(await exists(path.join(outside, 'claims.json'))).toBe(false);
    },
  );

  it.skipIf(!supportsDirectorySymlink())(
    'rejects a pending runtime adoption directory symlink that resolves outside the board directory',
    async () => {
      const projectRoot = await tempProject();
      const first = unwrap(
        await ensureRwState({ projectRoot, projectName: 'Demo', stacks: ['node'] }),
      );
      const originalConfig = await readFile(first.configPath, 'utf8');
      const originalClaims = await readFile(first.claimsPath, 'utf8');
      const outsideBoardButInsideProject = path.join(projectRoot, 'outside-pending-adoptions');
      mkdirSync(outsideBoardButInsideProject);
      symlinkSync(
        outsideBoardButInsideProject,
        path.join(projectRoot, '.review-board', 'pending-runtime-adoptions'),
        process.platform === 'win32' ? 'junction' : 'dir',
      );

      const result = await ensureRwState({
        projectRoot,
        appendSession: true,
        runtimeManifest: {
          worktreePath: projectRoot,
          source: 'current-worktree',
          detectBranch: async () => 'feat/unsafe-marker-dir',
        },
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toBe('Unsafe pending runtime adoption directory');
        expect(result.error.issues.join('\n')).toContain('resolves outside the review-board directory');
        expect(result.error.issues.join('\n')).toContain('No config or claims files were overwritten');
      }
      expect(await readFile(first.configPath, 'utf8')).toBe(originalConfig);
      expect(await readFile(first.claimsPath, 'utf8')).toBe(originalClaims);
      expect(await exists(path.join(outsideBoardButInsideProject, 'append-runtime-adoption.json'))).toBe(false);
      expect(await exists(path.join(projectRoot, '.review-board', 'runtime-manifests', 's2.json'))).toBe(false);
    },
  );

  it('does not append a session when existing claims are malformed', async () => {
    const projectRoot = await tempProject();
    const first = unwrap(
      await ensureRwState({ projectRoot, projectName: 'Demo', stacks: ['node'] }),
    );
    const originalConfig = await readFile(first.configPath, 'utf8');
    await writeFile(first.claimsPath, '{not-json}\n', 'utf8');

    const result = await ensureRwState({ projectRoot, appendSession: true });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toBe(`Malformed JSON file: ${first.claimsPath}`);
      expect(result.error.issues.join('\n')).toContain('No files were overwritten');
    }
    expect(await readFile(first.configPath, 'utf8')).toBe(originalConfig);
  });

  it('fixes forward missing claims without appending another session on append retry', async () => {
    const projectRoot = await tempProject();
    const first = unwrap(
      await ensureRwState({ projectRoot, projectName: 'Demo', stacks: ['node'] }),
    );
    const configWithPreviouslyAppendedSession = unwrap(
      createDefaultConfig({ projectName: 'Demo', stacks: ['node'], sessionCount: 2 }),
    );
    await writeFile(
      first.configPath,
      `${JSON.stringify(configWithPreviouslyAppendedSession, null, 2)}\n`,
      'utf8',
    );

    const result = unwrap(await ensureRwState({ projectRoot, appendSession: true }));

    expect(result.actions).toEqual(['loaded-config', 'loaded-board-dir', 'updated-claims']);
    expect(result.config.sessions.map((session) => session.id)).toEqual(['s1', 's2']);
    expect(result.appendedSession).toBeUndefined();
    expect(result.claims.claims.s2).toEqual({ status: 'free' });
    const writtenConfig = (await readJson(first.configPath)) as { sessions: Array<{ id: string }> };
    expect(writtenConfig.sessions.map((session) => session.id)).toEqual(['s1', 's2']);
  });

  it('returns a retryable error when the bootstrap lock already exists', async () => {
    const projectRoot = await tempProject();
    const lockPath = path.join(projectRoot, BOOTSTRAP_LOCK_FILE);
    await writeFile(
      lockPath,
      `${JSON.stringify({ pid: 12345, createdAt: '2026-07-07T12:00:00.000Z' }, null, 2)}\n`,
      'utf8',
    );

    const result = await ensureRwState({ projectRoot, projectName: 'Demo' });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toBe('RWAI bootstrap is already running');
      expect(result.error.issues.join('\n')).toContain('retry');
      expect(result.error.issues.join('\n')).toContain(lockPath);
      expect(result.error.issues.join('\n')).toContain('pid=12345');
      expect(result.error.issues.join('\n')).toContain('createdAt=2026-07-07T12:00:00.000Z');
      expect(result.error.issues.join('\n')).toContain('remove only this file');
      expect(result.error.issues.join('\n')).toContain('No files were overwritten');
    }
    expect(await exists(path.join(projectRoot, 'agents.config.json'))).toBe(false);
  });
});

describe('reconcileClaims', () => {
  it('preserves existing claims and fills missing session and integrator roles', () => {
    const config = unwrap(
      createDefaultConfig({ projectName: 'Demo', stacks: ['dotnet'], sessionCount: 2 }),
    );
    const claims = reconcileClaims(config, { version: 1, claims: { s1: { status: 'free' } } });

    expect(claims.claims).toEqual({
      s1: { status: 'free' },
      s2: { status: 'free' },
      integrator: { status: 'free' },
    });
  });
});
