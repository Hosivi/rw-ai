import { describe, expect, it } from 'vitest';
import type { AgentsConfig, Session, TestsConfig } from '../contract/schema.js';
import { unwrap, unwrapErr } from '../core/result.test-support.js';
import { buildConfig } from './git.test-support.js';
import {
  generateWiringPlan,
  generateWiringSnippet,
  renderWiringDoc,
  resolveArtifactDir,
} from './test-wiring.js';

const NOW = new Date('2026-07-02T12:00:00.000Z');
const TESTS_VIDEO_ON: TestsConfig = { captureScreenshots: true, captureVideo: true };
const TESTS_VIDEO_OFF: TestsConfig = { captureScreenshots: true, captureVideo: false };
const TESTS_NO_CAPTURE: TestsConfig = { captureScreenshots: false, captureVideo: false };

type SessionPatch = { status?: Session['status']; platforms: Session['platforms'] };

// Per-session platform config: createDefaultConfig applies the same platforms to
// every session, so tests that need distinct sessions patch them here.
const withSessionPlatforms = (
  config: AgentsConfig,
  patches: Record<string, SessionPatch>,
): AgentsConfig => ({
  ...config,
  sessions: config.sessions.map((session) => {
    const patch = patches[session.id];
    return patch === undefined ? session : { ...session, ...patch };
  }),
});

describe('resolveArtifactDir', () => {
  it('returns an env-driven expression referencing the board, session and platform', () => {
    const dir = resolveArtifactDir('web');
    expect(dir.expression).toContain('RW_BOARD_DIR');
    expect(dir.expression).toContain('RW_SESSION');
    expect(dir.expression).toContain("'web'");
    expect(dir.envKeys).toEqual(['RW_BOARD_DIR', 'RW_SESSION']);
  });
});

describe('generateWiringSnippet', () => {
  it('honors captureVideo and captureScreenshots in the playwright config', () => {
    const on = unwrap(generateWiringSnippet('web', 'playwright', TESTS_VIDEO_ON));
    expect(on.language).toBe('ts');
    expect(on.filename).toBe('playwright.config.ts');
    expect(on.snippet).toContain("video: 'on'");
    expect(on.snippet).toContain("screenshot: 'on'");

    const off = unwrap(generateWiringSnippet('web', 'playwright', TESTS_VIDEO_OFF));
    expect(off.snippet).toContain("video: 'off'");
    expect(off.snippet).toContain("screenshot: 'on'");

    const noCapture = unwrap(generateWiringSnippet('web', 'playwright', TESTS_NO_CAPTURE));
    expect(noCapture.snippet).toContain("screenshot: 'off'");
    expect(noCapture.snippet).toContain("video: 'off'");
  });

  it('routes the outputDir through the env expression (never a hardcoded session)', () => {
    const snippet = unwrap(generateWiringSnippet('web', 'playwright', TESTS_VIDEO_OFF));
    expect(snippet.snippet).toContain('RW_BOARD_DIR');
    // The session comes from a runtime env read, not a value baked per worktree.
    expect(snippet.snippet).toContain('process.env.RW_SESSION');
    expect(snippet.snippet).toContain("'web'");
  });

  it('produces a C# snippet for dotnet + playwright-dotnet', () => {
    const snippet = unwrap(generateWiringSnippet('dotnet', 'playwright-dotnet', TESTS_VIDEO_ON));
    expect(snippet.language).toBe('csharp');
    expect(snippet.platform).toBe('dotnet');
    expect(snippet.snippet).toContain('RW_BOARD_DIR');
    expect(snippet.snippet).toContain('RecordVideoDir');
  });

  it('rejects a mismatched (platform, framework) pair', () => {
    const error = unwrapErr(generateWiringSnippet('web', 'maestro', TESTS_VIDEO_OFF));
    expect(error.message).toContain('maestro');
    expect(error.message).toContain('web');
  });
});

describe('generateWiringPlan', () => {
  it('includes only opted-in platforms of active sessions', () => {
    const config = withSessionPlatforms(buildConfig(), {
      s1: {
        platforms: {
          web: { enabled: true, e2e: { enabled: true, framework: 'playwright' } },
          // e2e opt-out: enabled platform but no E2E wiring.
          mobile: { enabled: true, e2e: { enabled: false } },
          // disabled platform, even with e2e enabled, is skipped.
          native: { enabled: false, e2e: { enabled: true, framework: 'paparazzi' } },
        },
      },
      // archived session is skipped entirely.
      s2: {
        status: 'archived',
        platforms: { web: { enabled: true, e2e: { enabled: true, framework: 'playwright' } } },
      },
    });
    const plan = unwrap(generateWiringPlan(config));
    expect(plan).toHaveLength(1);
    expect(plan[0]?.sessionId).toBe('s1');
    expect(plan[0]?.platform).toBe('web');
    expect(plan[0]?.framework).toBe('playwright');
  });

  it('plans a dotnet snippet for a pure-dotnet config with e2e on', () => {
    const config = withSessionPlatforms(buildConfig({ stacks: ['dotnet'] }), {
      s1: {
        platforms: {
          dotnet: { enabled: true, e2e: { enabled: true, framework: 'playwright-dotnet' } },
        },
      },
    });
    const plan = unwrap(generateWiringPlan(config));
    const dotnet = plan.find((entry) => entry.platform === 'dotnet');
    expect(dotnet).toBeDefined();
    expect(dotnet?.framework).toBe('playwright-dotnet');
    expect(dotnet?.language).toBe('csharp');
  });

  it('returns an empty plan when no session has E2E enabled', () => {
    expect(unwrap(generateWiringPlan(buildConfig()))).toEqual([]);
  });
});

describe('renderWiringDoc', () => {
  it('mentions each planned session and platform, and explains the env rule', () => {
    const config = withSessionPlatforms(buildConfig(), {
      s1: { platforms: { web: { enabled: true, e2e: { enabled: true, framework: 'playwright' } } } },
      s2: { platforms: { web: { enabled: true, e2e: { enabled: true, framework: 'playwright' } } } },
    });
    const plan = unwrap(generateWiringPlan(config));
    const doc = renderWiringDoc(plan, NOW);
    expect(doc).toContain('s1 · web');
    expect(doc).toContain('s2 · web');
    expect(doc).toContain('playwright.config.ts');
    expect(doc).toContain(NOW.toISOString());
    // The why-env explanation must be present so the reader understands the rule.
    expect(doc).toContain('RW_SESSION');
    expect(doc).toContain('conflictos de merge');
  });

  it('renders a clear note when the plan is empty', () => {
    expect(renderWiringDoc([], NOW)).toContain('No hay plataformas con E2E habilitado');
  });
});
