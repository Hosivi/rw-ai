import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgentsConfig } from '../contract/schema.js';
import { ok } from '../core/result.js';
import { unwrap, unwrapErr } from '../core/result.test-support.js';
import { runCommandRaw, type CommandRunner } from './exec.js';
import { createGit } from './git.js';
import { buildConfig, createTempRepo, runGitOrThrow, type TempRepo } from './git.test-support.js';
import {
  analyzeIntegration,
  classifyChangedFile,
  detectLaneInvasions,
  detectPairOverlaps,
  detectSharedZoneTouches,
  integrationSummaryLine,
  renderIntegrationReport,
  writeIntegrationReport,
  type IntegrationAnalysis,
} from './integrator.js';

const NOW = new Date('2026-07-03T12:00:00.000Z');

describe('classifyChangedFile', () => {
  it('classifies an in-area file as in-area (own area wins over a shared zone)', () => {
    expect(classifyChangedFile('src/s1/a.ts', ['src/s1/**'], ['src/**'])).toBe('in-area');
  });

  it('classifies a shared-zone file when it is outside the areas', () => {
    expect(classifyChangedFile('shared/x.ts', ['src/s1/**'], ['shared/**'])).toBe('shared-zone');
  });

  it('classifies anything else as an invasion', () => {
    expect(classifyChangedFile('src/s2/leak.ts', ['src/s1/**'], ['shared/**'])).toBe('invasion');
  });
});

describe('detectLaneInvasions', () => {
  it('collects only the files that fall outside area and shared zones', () => {
    const invasion = detectLaneInvasions(
      's1',
      ['src/s1/ok.ts', 'shared/z.ts', 'src/s2/leak.ts'],
      ['src/s1/**'],
      ['shared/**'],
    );
    expect(invasion).toEqual({ sessionId: 's1', files: ['src/s2/leak.ts'] });
  });
});

describe('detectSharedZoneTouches', () => {
  it('collects every file matching a shared-zone glob, regardless of area', () => {
    const touch = detectSharedZoneTouches(
      's1',
      ['src/s1/ok.ts', 'shared/a.ts', 'shared/b.ts'],
      ['shared/**'],
    );
    expect(touch).toEqual({ sessionId: 's1', files: ['shared/a.ts', 'shared/b.ts'] });
  });
});

describe('detectPairOverlaps', () => {
  it('returns the intersection for every unordered pair, deterministically by id', () => {
    const overlaps = detectPairOverlaps([
      { sessionId: 's2', files: ['b.ts', 'shared.ts'] },
      { sessionId: 's1', files: ['a.ts', 'shared.ts'] },
      { sessionId: 's3', files: ['c.ts'] },
    ]);
    expect(overlaps).toEqual([{ a: 's1', b: 's2', files: ['shared.ts'] }]);
  });

  it('omits pairs with no shared file', () => {
    expect(
      detectPairOverlaps([
        { sessionId: 's1', files: ['a.ts'] },
        { sessionId: 's2', files: ['b.ts'] },
      ]),
    ).toEqual([]);
  });
});

const SAMPLE_ANALYSIS: IntegrationAnalysis = {
  base: 'develop',
  sessions: [
    { sessionId: 's1', branch: 'feat/s1-inicial', files: ['conflict.ts', 'src/s1/a.ts'] },
    { sessionId: 's2', branch: 'feat/s2-inicial', files: ['conflict.ts'] },
    { sessionId: 's3', branch: 'feat/s3-inicial', files: ['src/s3/c.ts'] },
  ],
  invasions: [{ sessionId: 's1', files: ['conflict.ts'] }],
  sharedZoneTouches: [{ sessionId: 's2', files: ['shared/x.ts'] }],
  overlaps: [{ a: 's1', b: 's2', files: ['conflict.ts'] }],
  simulatedMerges: [
    { a: 's1', b: 's2', status: 'conflict', conflicts: ['conflict.ts'] },
  ],
};

describe('renderIntegrationReport', () => {
  it('is deterministic for identical inputs (byte-for-byte)', () => {
    const first = renderIntegrationReport(SAMPLE_ANALYSIS, 'demo', NOW);
    const second = renderIntegrationReport(SAMPLE_ANALYSIS, 'demo', NOW);
    expect(first).toBe(second);
  });

  it('renders the Spanish sections, counts, and the timestamp', () => {
    const report = renderIntegrationReport(SAMPLE_ANALYSIS, 'demo', NOW);
    expect(report).toContain('# Integrador — demo');
    expect(report).toContain(NOW.toISOString());
    expect(report).toContain('## Resumen');
    expect(report).toContain('## Cambios por sesión');
    expect(report).toContain('## Invasiones de carril');
    expect(report).toContain('## Zonas compartidas tocadas');
    expect(report).toContain('## Solapamientos entre sesiones');
    expect(report).toContain('## Merges simulados');
    // The conflicted file surfaces in the simulated-merge section.
    expect(report).toContain('conflict.ts');
    expect(report).toContain('conflicto');
  });

  it('renders empty sections with a Spanish placeholder', () => {
    const empty: IntegrationAnalysis = {
      base: 'develop',
      sessions: [{ sessionId: 's1', branch: 'feat/s1-inicial', files: ['src/s1/a.ts'] }],
      invasions: [],
      sharedZoneTouches: [],
      overlaps: [],
      simulatedMerges: [],
    };
    const report = renderIntegrationReport(empty, 'demo', NOW);
    expect(report).toContain('_Ninguna._');
  });

  it('renders a clean simulated merge without conflicts', () => {
    const clean: IntegrationAnalysis = {
      ...SAMPLE_ANALYSIS,
      simulatedMerges: [{ a: 's1', b: 's2', status: 'clean', conflicts: [] }],
    };
    expect(renderIntegrationReport(clean, 'demo', NOW)).toContain('limpio');
  });
});

describe('integrationSummaryLine', () => {
  it('summarizes sessions, invasions, and simulated conflicts in one line', () => {
    const line = integrationSummaryLine(SAMPLE_ANALYSIS);
    expect(line).toContain('3 sesiones');
    expect(line).toContain('1 invasión');
    expect(line).toContain('1 conflicto');
    expect(line).not.toContain('\n');
  });

  it('uses singular/plural correctly for zero and one', () => {
    const line = integrationSummaryLine({
      base: 'develop',
      sessions: [{ sessionId: 's1', branch: 'feat/s1-inicial', files: [] }],
      invasions: [],
      sharedZoneTouches: [],
      overlaps: [],
      simulatedMerges: [],
    });
    expect(line).toContain('1 sesión');
    expect(line).toContain('0 invasiones');
    expect(line).toContain('0 conflictos');
  });
});

// A config with per-session areas and a shared zone. buildConfig cannot set
// distinct per-session areas, so we override them on the parsed config.
const buildIntegratorConfig = (sessionCount = 3): AgentsConfig => {
  const base = buildConfig({ sessionCount, integrationBranch: 'develop' });
  return {
    ...base,
    sharedZones: ['shared/**'],
    sessions: base.sessions.map((session) => ({
      ...session,
      areas: [`src/${session.id}/**`],
    })),
  };
};

// Create a session branch off develop, populate a worktree, and commit — the
// shared setup for every git integration test below. Each call is ~4 real git
// spawns, so the tests carry a generous timeout (deterministic, just slow under
// full-suite CPU contention on Windows).
const seedSessionBranch = async (
  root: string,
  branch: string,
  files: ReadonlyArray<{ rel: string; content: string }>,
  message: string,
): Promise<void> => {
  const git = createGit(root);
  unwrap(await git.createBranch(branch, 'develop'));
  const wt = path.join(root, branch.replace(/[/]/g, '_'));
  unwrap(await git.addWorktree(wt, branch));
  for (const file of files) {
    const target = path.join(wt, file.rel);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, file.content);
  }
  await runGitOrThrow(wt, ['add', '-A']);
  await runGitOrThrow(wt, ['commit', '-m', message]);
};

describe('analyzeIntegration (integration)', () => {
  let repo: TempRepo;

  beforeEach(async () => {
    repo = await createTempRepo();
  });

  afterEach(async () => {
    await repo.cleanup();
  });

  it('detects invasions, shared-zone touches, overlaps, and simulated merges', async () => {
    const config = buildIntegratorConfig();
    const repoGit = createGit(repo.root);
    unwrap(await repoGit.createBranch('develop', 'main'));

    // conflict.ts is an add/add across s1 and s2 (never on develop): both add it
    // with divergent content, so it is a lane invasion, an overlap, AND a
    // simulated merge conflict — s3 never touches it, so s3 stays overlap-free.
    await seedSessionBranch(
      repo.root,
      'feat/s1-inicial',
      [
        { rel: 'conflict.ts', content: 'export const shared = 1;\n' }, // invasion + overlap
        { rel: 'shared/common.ts', content: 'export const c = 1;\n' }, // shared-zone touch
        { rel: 'src/s1/a.ts', content: 'export const a = 1;\n' }, // in-area
      ],
      'feat: s1 work',
    );
    await seedSessionBranch(
      repo.root,
      'feat/s2-inicial',
      [
        { rel: 'conflict.ts', content: 'export const shared = 2;\n' }, // invasion + conflict
        { rel: 'src/s2/b.ts', content: 'export const b = 1;\n' }, // in-area
      ],
      'feat: s2 work',
    );
    await seedSessionBranch(
      repo.root,
      'feat/s3-inicial',
      [{ rel: 'src/s3/c.ts', content: 'export const c = 1;\n' }], // in-area only
      'feat: s3 work',
    );

    const analysis = unwrap(await analyzeIntegration(config, repo.root));

    expect(analysis.base).toBe('develop');
    expect(analysis.sessions.map((s) => s.sessionId)).toEqual(['s1', 's2', 's3']);

    // Invasions: s1 and s2 both wrote conflict.ts outside their lane.
    const invadedBy = analysis.invasions.map((i) => i.sessionId).sort();
    expect(invadedBy).toEqual(['s1', 's2']);
    expect(analysis.invasions.find((i) => i.sessionId === 's1')?.files).toEqual(['conflict.ts']);

    // Shared-zone touch: only s1 touched shared/**.
    expect(analysis.sharedZoneTouches.map((t) => t.sessionId)).toEqual(['s1']);
    expect(analysis.sharedZoneTouches[0]?.files).toEqual(['shared/common.ts']);

    // Overlap (same literal path): s1 and s2 both changed conflict.ts.
    expect(analysis.overlaps).toHaveLength(1);
    expect(analysis.overlaps[0]).toMatchObject({ a: 's1', b: 's2' });
    expect(analysis.overlaps[0]?.files).toContain('conflict.ts');

    // Simulated merges: EVERY pair is simulated (decoupled from overlaps). Only
    // s1↔s2 conflicts; the disjoint pairs merge cleanly.
    expect(analysis.simulatedMerges).toHaveLength(3);
    const merge = (a: string, b: string) =>
      analysis.simulatedMerges.find((m) => m.a === a && m.b === b);
    expect(merge('s1', 's2')?.status).toBe('conflict');
    expect(merge('s1', 's2')?.conflicts).toContain('conflict.ts');
    expect(merge('s1', 's3')?.status).toBe('clean');
    expect(merge('s2', 's3')?.status).toBe('clean');
  });

  it('simulates a conflict for a file/directory collision on DISJOINT paths', async () => {
    // The verified blind spot: s1 adds a FILE `foo`; s2 adds `foo/bar.ts`. Their
    // changed-file sets never intersect, so an overlap-gated simulation would miss
    // the conflict entirely.
    const config = buildIntegratorConfig(2);
    const repoGit = createGit(repo.root);
    unwrap(await repoGit.createBranch('develop', 'main'));
    await seedSessionBranch(repo.root, 'feat/s1-inicial', [{ rel: 'foo', content: 'a file\n' }], 'feat: s1 file');
    await seedSessionBranch(
      repo.root,
      'feat/s2-inicial',
      [{ rel: 'foo/bar.ts', content: 'export const b = 1;\n' }],
      'feat: s2 dir',
    );

    const analysis = unwrap(await analyzeIntegration(config, repo.root));
    expect(analysis.overlaps).toEqual([]); // disjoint literal paths
    expect(analysis.simulatedMerges).toHaveLength(1);
    expect(analysis.simulatedMerges[0]?.status).toBe('conflict');
    expect(analysis.simulatedMerges[0]?.conflicts.length).toBeGreaterThan(0);
  });

  it('produces a simulated merge for every colliding pair (not just the first)', async () => {
    // All three sessions edit the SAME file divergently: all three pairs collide.
    const config = buildIntegratorConfig(3);
    const repoGit = createGit(repo.root);
    unwrap(await repoGit.createBranch('develop', 'main'));
    await seedSessionBranch(repo.root, 'feat/s1-inicial', [{ rel: 'shared.ts', content: 'v1\n' }], 'feat: s1');
    await seedSessionBranch(repo.root, 'feat/s2-inicial', [{ rel: 'shared.ts', content: 'v2\n' }], 'feat: s2');
    await seedSessionBranch(repo.root, 'feat/s3-inicial', [{ rel: 'shared.ts', content: 'v3\n' }], 'feat: s3');

    const analysis = unwrap(await analyzeIntegration(config, repo.root));
    expect(analysis.overlaps).toHaveLength(3);
    expect(analysis.simulatedMerges).toHaveLength(3);
    expect(analysis.simulatedMerges.every((m) => m.status === 'conflict')).toBe(true);
  });

  it('surfaces kind:git when a simulated merge errors', async () => {
    const config = buildIntegratorConfig(2);
    const repoGit = createGit(repo.root);
    unwrap(await repoGit.createBranch('develop', 'main'));
    await seedSessionBranch(repo.root, 'feat/s1-inicial', [{ rel: 'src/s1/a.ts', content: 'a\n' }], 'feat: s1');
    await seedSessionBranch(repo.root, 'feat/s2-inicial', [{ rel: 'src/s2/b.ts', content: 'b\n' }], 'feat: s2');
    // Fake runRaw: real git for everything except merge-tree, which "fails" with a
    // genuine exit 128 (not a conflict's exit 1).
    const failingMergeTree: CommandRunner = (command, args, opts) =>
      args.includes('merge-tree')
        ? Promise.resolve(ok({ stdout: '', stderr: 'boom', exitCode: 128 }))
        : runCommandRaw(command, args, opts);

    const error = unwrapErr(await analyzeIntegration(config, repo.root, undefined, failingMergeTree));
    expect(error.kind).toBe('git');
  });

  it('excludes archived sessions from the analysis', async () => {
    const base = buildConfig({ sessionCount: 3, integrationBranch: 'develop' });
    const config: AgentsConfig = {
      ...base,
      sessions: base.sessions.map((s) => (s.id === 's3' ? { ...s, status: 'archived' as const } : s)),
    };
    const repoGit = createGit(repo.root);
    unwrap(await repoGit.createBranch('develop', 'main'));
    await seedSessionBranch(repo.root, 'feat/s1-inicial', [{ rel: 'a.ts', content: 'a\n' }], 'feat: s1');
    await seedSessionBranch(repo.root, 'feat/s2-inicial', [{ rel: 'b.ts', content: 'b\n' }], 'feat: s2');
    // feat/s3-inicial is intentionally NEVER created: if the archived s3 were
    // analyzed, this would fail with session-branch-missing.
    const analysis = unwrap(await analyzeIntegration(config, repo.root));
    expect(analysis.sessions.map((s) => s.sessionId)).toEqual(['s1', 's2']);
  });

  it('errors when the integration branch is missing', async () => {
    const config = buildIntegratorConfig();
    // No develop branch created.
    const error = unwrapErr(await analyzeIntegration(config, repo.root));
    expect(error.kind).toBe('integration-branch-missing');
  });

  it('errors when a session branch is missing', async () => {
    const config = buildIntegratorConfig();
    const repoGit = createGit(repo.root);
    unwrap(await repoGit.createBranch('develop', 'main'));
    // No session branches created.
    const error = unwrapErr(await analyzeIntegration(config, repo.root));
    expect(error.kind).toBe('session-branch-missing');
    expect(error.sessionId).toBe('s1');
  });
});

describe('writeIntegrationReport', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join((await import('node:os')).tmpdir(), 'rw-ai-integ-'));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it('writes reports/integration.md, then reports unchanged on rerun', async () => {
    const config = buildConfig();
    const reportPath = path.join(dir, '.review-board', 'reports', 'integration.md');

    const first = unwrap(await writeIntegrationReport(config, dir, SAMPLE_ANALYSIS, NOW));
    expect(first.action).toBe('created');
    expect(first.path).toBe(reportPath);
    expect(await fs.readFile(reportPath, 'utf8')).toContain('# Integrador');

    const rerun = unwrap(await writeIntegrationReport(config, dir, SAMPLE_ANALYSIS, NOW));
    expect(rerun.action).toBe('unchanged');
  });
});
