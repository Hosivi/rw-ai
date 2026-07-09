import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ensureRwState } from './bootstrap.js';
import { unwrap } from './core/result.test-support.js';
import { createDefaultConfig } from './contract/defaults.js';
import { buildRuntimeManifest, writeRuntimeManifest } from './runtime.js';

const tempDir = async (prefix: string): Promise<string> => mkdtemp(path.join(os.tmpdir(), prefix));

describe('runtime manifest adoption', () => {
  it('builds the MVP manifest shape with generated runtime env entries', async () => {
    const projectRoot = await tempDir('rw-ai-runtime-project-');
    const worktreePath = await tempDir('rw-ai-runtime-worktree-');
    const config = unwrap(
      createDefaultConfig({
        projectName: 'Demo',
        stacks: ['node'],
        sessionCount: 1,
        db: { strategy: 'docker', service: 'postgres', user: 'app' },
      }),
    );
    const boardDir = path.join(projectRoot, '.review-board');
    const state = unwrap(await ensureRwState({ projectRoot, projectName: 'Demo', stacks: ['node'] }));

    const manifest = unwrap(
      await buildRuntimeManifest({
        projectRoot,
        configPath: path.join(projectRoot, 'agents.config.json'),
        boardDir,
        claimsPath: state.claimsPath,
        config,
        sessionId: 's1',
        worktreePath,
        source: 'provided-worktree',
        detectBranch: async () => undefined,
        now: () => new Date('2026-07-07T12:00:00.000Z'),
      }),
    );

    expect(manifest).toMatchObject({
      version: 1,
      generatedAt: '2026-07-07T12:00:00.000Z',
      projectRoot,
      session: {
        id: 's1',
        branch: 'feat/s1-inicial',
        configuredWorktree: '.worktrees/s1',
        ports: { api: 3000, web: 3100, metro: 8081 },
        db: { name: 'demo_s1' },
      },
      worktree: {
        mode: 'external',
        path: worktreePath,
        resolvedPath: worktreePath,
        provenance: { kind: 'adopted', source: 'provided-worktree', sourcePath: worktreePath },
      },
      reviewBoardDir: boardDir,
      ports: { api: 3000, web: 3100, metro: 8081 },
      db: {
        strategy: 'docker',
        service: 'postgres',
        host: 'localhost',
        port: 5432,
        sessionName: 'demo_s1',
        databaseUrlEnvKey: 'DATABASE_URL',
      },
    });
    expect(manifest.env.entries).toEqual(
      expect.arrayContaining([
        { key: 'RW_SESSION', value: 's1', source: 'generated' },
        { key: 'RW_BOARD_DIR', value: boardDir, source: 'generated' },
        { key: 'DATABASE_URL', value: 'postgresql://app:${RW_DB_PASSWORD}@localhost:5432/demo_s1', source: 'generated' },
      ]),
    );
  });

  it('writes the manifest under the review-board runtime manifest directory', async () => {
    const projectRoot = await tempDir('rw-ai-runtime-project-');
    const worktreePath = await tempDir('rw-ai-runtime-worktree-');
    const state = unwrap(await ensureRwState({ projectRoot, projectName: 'Demo', stacks: ['node'] }));

    const written = unwrap(
      await writeRuntimeManifest({
        projectRoot,
        configPath: state.configPath,
        boardDir: state.boardDir,
        claimsPath: state.claimsPath,
        config: state.config,
        sessionId: 's1',
        worktreePath,
        source: 'provided-worktree',
        detectBranch: async () => 'feat/from-fake-git',
      }),
    );

    expect(written.manifestPath).toBe(path.join(state.boardDir, 'runtime-manifests', 's1.json'));
    const persisted = JSON.parse(await readFile(written.manifestPath, 'utf8')) as unknown;
    expect(persisted).toEqual(written.manifest);
    expect(written.manifest.worktree.branch).toBe('feat/from-fake-git');
  });

  it('adopts a custom external worktree path without creating it', async () => {
    const projectRoot = await tempDir('rw-ai-runtime-project-');
    const externalWorktree = await tempDir('rw-ai-external-worktree-');
    const state = unwrap(await ensureRwState({ projectRoot, projectName: 'Demo', stacks: ['node'] }));

    const written = unwrap(
      await writeRuntimeManifest({
        projectRoot,
        configPath: state.configPath,
        boardDir: state.boardDir,
        claimsPath: state.claimsPath,
        config: state.config,
        sessionId: 's1',
        worktreePath: externalWorktree,
        source: 'provided-worktree',
        detectBranch: async () => undefined,
      }),
    );

    expect(written.manifest.worktree.resolvedPath).toBe(externalWorktree);
    expect(written.manifest.session.configuredWorktree).toBe('.worktrees/s1');
  });

  it('rejects a missing external worktree path without creating it', async () => {
    const projectRoot = await tempDir('rw-ai-runtime-project-');
    const missingWorktree = path.join(await tempDir('rw-ai-runtime-parent-'), 'missing-worktree');
    const state = unwrap(await ensureRwState({ projectRoot, projectName: 'Demo', stacks: ['node'] }));

    const result = await writeRuntimeManifest({
      projectRoot,
      configPath: state.configPath,
      boardDir: state.boardDir,
      claimsPath: state.claimsPath,
      config: state.config,
      sessionId: 's1',
      worktreePath: missingWorktree,
      source: 'provided-worktree',
      detectBranch: async () => undefined,
    });

    expect(result.ok).toBe(false);
    expect(existsSync(missingWorktree)).toBe(false);
  });

  it('omits branch when detection has no branch available', async () => {
    const projectRoot = await tempDir('rw-ai-runtime-project-');
    const worktreePath = await tempDir('rw-ai-runtime-worktree-');
    const state = unwrap(await ensureRwState({ projectRoot, projectName: 'Demo', stacks: ['node'] }));

    const manifest = unwrap(
      await buildRuntimeManifest({
        projectRoot,
        configPath: state.configPath,
        boardDir: state.boardDir,
        claimsPath: state.claimsPath,
        config: state.config,
        sessionId: 's1',
        worktreePath,
        source: 'provided-worktree',
        detectBranch: async () => undefined,
      }),
    );

    expect(manifest.worktree.branch).toBeUndefined();
  });

  it('rejects default runtime selection when the configured sessions are archived', async () => {
    const projectRoot = await tempDir('rw-ai-runtime-project-');
    const worktreePath = await tempDir('rw-ai-runtime-worktree-');
    const state = unwrap(await ensureRwState({ projectRoot, projectName: 'Demo', stacks: ['node'] }));
    const config = { ...state.config, sessions: [{ ...state.config.sessions[0]!, status: 'archived' as const }] };

    const result = await buildRuntimeManifest({
      projectRoot,
      configPath: state.configPath,
      boardDir: state.boardDir,
      claimsPath: state.claimsPath,
      config,
      worktreePath,
      source: 'provided-worktree',
      detectBranch: async () => undefined,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toBe('No RWAI active session available for runtime adoption');
      expect(result.error.issues.join('\n')).toContain('does not define any active sessions');
    }
  });

  it('rejects an explicit archived runtime session', async () => {
    const projectRoot = await tempDir('rw-ai-runtime-project-');
    const worktreePath = await tempDir('rw-ai-runtime-worktree-');
    const state = unwrap(await ensureRwState({ projectRoot, projectName: 'Demo', stacks: ['node'] }));
    const config = { ...state.config, sessions: [{ ...state.config.sessions[0]!, status: 'archived' as const }] };

    const result = await buildRuntimeManifest({
      projectRoot,
      configPath: state.configPath,
      boardDir: state.boardDir,
      claimsPath: state.claimsPath,
      config,
      sessionId: 's1',
      worktreePath,
      source: 'provided-worktree',
      detectBranch: async () => undefined,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toBe('No RWAI active session available for runtime adoption');
      expect(result.error.issues.join('\n')).toContain('Session is archived: s1');
    }
  });

  it('does not copy claim tokens into the runtime manifest', async () => {
    const projectRoot = await tempDir('rw-ai-runtime-project-');
    const worktreePath = await tempDir('rw-ai-runtime-worktree-');
    const state = unwrap(await ensureRwState({ projectRoot, projectName: 'Demo', stacks: ['node'] }));
    await writeFile(
      state.claimsPath,
      `${JSON.stringify(
        {
          version: 1,
          claims: {
            s1: {
              status: 'claimed',
              token: 'secret-claim-token',
              claimedAt: '2026-07-07T12:00:00.000Z',
              expiresAt: '2026-07-07T13:00:00.000Z',
            },
            integrator: { status: 'free' },
          },
        },
        null,
        2,
      )}\n`,
      'utf8',
    );

    const written = unwrap(
      await writeRuntimeManifest({
        projectRoot,
        configPath: state.configPath,
        boardDir: state.boardDir,
        claimsPath: state.claimsPath,
        config: state.config,
        sessionId: 's1',
        worktreePath,
        source: 'current-worktree',
        detectBranch: async () => undefined,
      }),
    );

    const rawManifest = await readFile(written.manifestPath, 'utf8');
    expect(rawManifest).not.toContain('secret-claim-token');
    expect(rawManifest).not.toContain('RW_TOKEN');
  });
});
