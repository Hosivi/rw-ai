import { ENV_KEYS } from '../contract/env.js';
import type { AgentsConfig, PlatformId, TestsConfig } from '../contract/schema.js';
import { err, ok, type Result } from '../core/result.js';
import { activeSessions } from './sessions.js';

// Fixed order so a plan is deterministic across runs.
const PLATFORM_IDS = ['web', 'mobile', 'native', 'dotnet'] as const satisfies readonly PlatformId[];

// The (platform, framework) pairs mirror the schema's per-platform framework
// enums; anything outside this map is a mismatch we refuse to wire.
const VALID_FRAMEWORKS: Record<PlatformId, readonly string[]> = {
  web: ['playwright'],
  mobile: ['maestro', 'detox'],
  native: ['compose', 'paparazzi', 'roborazzi'],
  dotnet: ['playwright-dotnet'],
};

// One field per snippet syntax so the wiring doc can fence each block correctly.
// This is wider than a single language because the six framework pairs span
// TypeScript, JavaScript, C#, Kotlin/Gradle and a shell invocation.
export type WiringLanguage = 'ts' | 'js' | 'csharp' | 'kotlin' | 'shell';

export type WiringError = {
  readonly message: string;
};

export type ArtifactDirExpression = {
  readonly platform: PlatformId;
  // A JS/TS expression a config evaluates at RUNTIME. It is env-driven on purpose:
  // hardcoding the session id would make this versioned, shared config file differ
  // per branch and guarantee merge conflicts across sessions.
  readonly expression: string;
  readonly envKeys: readonly string[];
};

// The canonical env-driven artifact path expression. Returned as a literal string
// (for docs) plus the env keys it reads, so a snippet or doc can reuse either.
export const resolveArtifactDir = (platformId: PlatformId): ArtifactDirExpression => {
  const board = `process.env.${ENV_KEYS.boardDir} ?? '.review-board'`;
  const session = `process.env.${ENV_KEYS.session} ?? 's1'`;
  return {
    platform: platformId,
    expression: `path.join(${board}, 'test-artifacts', ${session}, '${platformId}')`,
    envKeys: [ENV_KEYS.boardDir, ENV_KEYS.session],
  };
};

export type WiringSnippet = {
  readonly platform: PlatformId;
  readonly framework: string;
  readonly filename: string;
  readonly language: WiringLanguage;
  readonly snippet: string;
  readonly notes: string[];
};

const onOff = (flag: boolean): 'on' | 'off' => (flag ? 'on' : 'off');

// Shared reminder pasted into every snippet's notes: it is the whole reason the
// wiring reads from env instead of being patched per worktree.
const ENV_RULE_NOTE =
  'Este archivo está versionado y se comparte entre todas las ramas de sesión: NUNCA hardcodees el id de sesión. Los valores por sesión (RW_SESSION, RW_BOARD_DIR) llegan desde .env.local en tiempo de ejecución.';

const webPlaywright = (tests: TestsConfig): WiringSnippet => {
  const { expression } = resolveArtifactDir('web');
  const snippet = [
    "import path from 'node:path';",
    "import { defineConfig } from '@playwright/test';",
    '',
    `const artifactDir = ${expression};`,
    '',
    'export default defineConfig({',
    '  outputDir: artifactDir,',
    '  use: {',
    `    screenshot: '${onOff(tests.captureScreenshots)}',`,
    `    video: '${onOff(tests.captureVideo)}',`,
    "    trace: 'retain-on-failure',",
    '  },',
    '});',
  ].join('\n');
  return {
    platform: 'web',
    framework: 'playwright',
    filename: 'playwright.config.ts',
    language: 'ts',
    snippet,
    notes: [
      ENV_RULE_NOTE,
      `screenshot y video se derivan de tests.captureScreenshots (${onOff(tests.captureScreenshots)}) y tests.captureVideo (${onOff(tests.captureVideo)}).`,
    ],
  };
};

const dotnetPlaywright = (tests: TestsConfig): WiringSnippet => {
  const recordVideo = tests.captureVideo ? 'artifactDir' : 'null';
  const snippet = [
    '// Playwright for .NET is configured in code; read the artifact dir from the env.',
    `var boardDir = Environment.GetEnvironmentVariable("${ENV_KEYS.boardDir}") ?? ".review-board";`,
    `var session = Environment.GetEnvironmentVariable("${ENV_KEYS.session}") ?? "s1";`,
    'var artifactDir = Path.Combine(boardDir, "test-artifacts", session, "dotnet");',
    '',
    'var contextOptions = new BrowserNewContextOptions',
    '{',
    `    RecordVideoDir = ${recordVideo},`,
    '};',
  ].join('\n');
  return {
    platform: 'dotnet',
    framework: 'playwright-dotnet',
    filename: 'PlaywrightFixture.cs',
    language: 'csharp',
    snippet,
    notes: [
      ENV_RULE_NOTE,
      tests.captureVideo
        ? 'captureVideo activo: RecordVideoDir apunta al board; los videos se guardan por contexto.'
        : 'captureVideo desactivado: RecordVideoDir queda en null y no se graba video.',
      tests.captureScreenshots
        ? 'captureScreenshots activo: guardá los screenshots de fallo en artifactDir desde tu fixture.'
        : 'captureScreenshots desactivado: no capturés screenshots.',
    ],
  };
};

const mobileMaestro = (tests: TestsConfig): WiringSnippet => {
  const snippet = [
    '# Route Maestro debug artifacts (screenshots, logs) to the shared board via env.',
    'maestro test flows/ \\',
    `  --debug-output "\${${ENV_KEYS.boardDir}:-.review-board}/test-artifacts/\${${ENV_KEYS.session}:-s1}/mobile"`,
  ].join('\n');
  return {
    platform: 'mobile',
    framework: 'maestro',
    filename: 'e2e/run-maestro.sh',
    language: 'shell',
    snippet,
    notes: [
      ENV_RULE_NOTE,
      'Maestro escribe los screenshots de depuración en la carpeta de --debug-output.',
      tests.captureVideo
        ? 'captureVideo activo: agregá startRecording/stopRecording en tus flows para grabar en esa carpeta.'
        : 'captureVideo desactivado: no agregues startRecording en los flows.',
    ],
  };
};

const mobileDetox = (tests: TestsConfig): WiringSnippet => {
  const screenshot = tests.captureScreenshots ? 'failing' : 'none';
  const video = tests.captureVideo ? 'failing' : 'none';
  const snippet = [
    "const path = require('node:path');",
    '',
    '// .detoxrc.js (not .json): the rootDir must be computed from the env at runtime.',
    'module.exports = {',
    '  artifacts: {',
    `    rootDir: path.join(process.env.${ENV_KEYS.boardDir} || '.review-board', 'test-artifacts', process.env.${ENV_KEYS.session} || 's1', 'mobile'),`,
    '    plugins: {',
    `      screenshot: '${screenshot}',`,
    `      video: '${video}',`,
    '    },',
    '  },',
    '};',
  ].join('\n');
  return {
    platform: 'mobile',
    framework: 'detox',
    filename: '.detoxrc.js',
    language: 'js',
    snippet,
    notes: [
      ENV_RULE_NOTE,
      `plugins.screenshot=${screenshot} y plugins.video=${video} se derivan de las flags de captura.`,
    ],
  };
};

// Paparazzi and Roborazzi are JVM screenshot libraries; both take a Gradle output
// dir. Video is not applicable to snapshot testing.
const nativeGradle = (framework: 'paparazzi' | 'roborazzi'): WiringSnippet => {
  const header = [
    '// build.gradle.kts: route snapshot artifacts to the shared board via env so',
    '// this versioned build file stays identical on every session branch.',
    `val boardDir = System.getenv("${ENV_KEYS.boardDir}") ?: ".review-board"`,
    `val session = System.getenv("${ENV_KEYS.session}") ?: "s1"`,
    'val rwArtifacts = "$boardDir/test-artifacts/$session/native"',
    '',
  ];
  const body =
    framework === 'roborazzi'
      ? ['roborazzi {', '    outputDir.set(file(rwArtifacts))', '}']
      : [
          'tasks.withType<Test> {',
          '    systemProperty("app.cash.paparazzi.snapshot.dir", rwArtifacts)',
          '}',
        ];
  return {
    platform: 'native',
    framework,
    filename: 'build.gradle.kts',
    language: 'kotlin',
    snippet: [...header, ...body].join('\n'),
    notes: [
      ENV_RULE_NOTE,
      'El screenshot testing no produce video; captureVideo no aplica a esta plataforma.',
    ],
  };
};

const nativeCompose = (): WiringSnippet => {
  const snippet = [
    'import java.io.File',
    '',
    '// Compose UI tests have no built-in artifact dir; write captureToImage() bitmaps here.',
    `val rwArtifacts = File(`,
    `    System.getenv("${ENV_KEYS.boardDir}") ?: ".review-board",`,
    `    "test-artifacts/\${System.getenv("${ENV_KEYS.session}") ?: "s1"}/native",`,
    ')',
  ].join('\n');
  return {
    platform: 'native',
    framework: 'compose',
    filename: 'ComposeScreenshotSupport.kt',
    language: 'kotlin',
    snippet,
    notes: [
      ENV_RULE_NOTE,
      'Compose UI test no tiene carpeta de artefactos propia: escribí los bitmaps de captureToImage() en rwArtifacts.',
    ],
  };
};

// A copy-pastable, env-driven config fragment for one (platform, framework) pair.
// Mismatched pairs (not in VALID_FRAMEWORKS) are refused with an err.
export const generateWiringSnippet = (
  platformId: PlatformId,
  framework: string,
  tests: TestsConfig,
): Result<WiringSnippet, WiringError> => {
  if (!VALID_FRAMEWORKS[platformId].includes(framework)) {
    return err({
      message: `framework '${framework}' is not valid for platform '${platformId}' (expected one of: ${VALID_FRAMEWORKS[platformId].join(', ')})`,
    });
  }
  if (platformId === 'web') {
    return ok(webPlaywright(tests));
  }
  if (platformId === 'dotnet') {
    return ok(dotnetPlaywright(tests));
  }
  if (platformId === 'mobile') {
    return ok(framework === 'maestro' ? mobileMaestro(tests) : mobileDetox(tests));
  }
  // native
  if (framework === 'compose') {
    return ok(nativeCompose());
  }
  return ok(nativeGradle(framework === 'roborazzi' ? 'roborazzi' : 'paparazzi'));
};

export type WiringPlanEntry = WiringSnippet & {
  readonly sessionId: string;
};

// Only active sessions × enabled platforms whose e2e is opted in. A platform that
// is enabled but has e2e disabled is skipped: E2E wiring is opt-in per platform.
export const generateWiringPlan = (
  config: AgentsConfig,
): Result<WiringPlanEntry[], WiringError> => {
  const plan: WiringPlanEntry[] = [];
  for (const session of activeSessions(config)) {
    for (const platformId of PLATFORM_IDS) {
      const platform = session.platforms[platformId];
      if (platform === undefined || !platform.enabled || !platform.e2e.enabled) {
        continue;
      }
      const framework = platform.e2e.framework;
      // The schema guarantees a framework when e2e is enabled; this guard is a
      // defensive backstop, not an expected branch.
      if (framework === undefined) {
        continue;
      }
      const snippet = generateWiringSnippet(platformId, framework, config.tests);
      if (!snippet.ok) {
        return err(snippet.error);
      }
      plan.push({ sessionId: session.id, ...snippet.value });
    }
  }
  return ok(plan);
};

// Pure Spanish (tuteo) doc telling the user WHERE to paste each snippet and WHY it
// must read from env. Deterministic given (plan, now).
export const renderWiringDoc = (plan: readonly WiringPlanEntry[], now: Date): string => {
  const header = [
    '# Cableado de artefactos de test',
    '',
    `Generado: ${now.toISOString()}`,
    '',
    '> Los archivos de configuración de test están **versionados y compartidos** entre todas las ramas de sesión. Por eso NUNCA hardcodeamos el id de sesión (`s1`, `s2`, ...): si lo hiciéramos, cada rama llevaría una versión distinta del mismo archivo y tendrías conflictos de merge garantizados. En su lugar, cada snippet lee `RW_SESSION` y `RW_BOARD_DIR` en tiempo de ejecución desde `.env.local` (que no se versiona).',
    '',
  ];
  if (plan.length === 0) {
    return [...header, 'No hay plataformas con E2E habilitado en las sesiones activas.', ''].join('\n');
  }
  const sections = plan.flatMap((entry) => [
    `## ${entry.sessionId} · ${entry.platform} · ${entry.framework}`,
    '',
    `Pegá esto en \`${entry.filename}\`:`,
    '',
    `\`\`\`${entry.language}`,
    entry.snippet,
    '```',
    '',
    ...entry.notes.map((note) => `- ${note}`),
    '',
  ]);
  return [...header, ...sections].join('\n');
};
