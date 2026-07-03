import fs from 'node:fs/promises';
import path from 'node:path';
import { resolveBoardDir } from '../contract/env.js';
import type { AgentsConfig } from '../contract/schema.js';
import { err, ok, type Result } from '../core/result.js';
import { writeFileIdempotent, type WriteAction } from './board.js';
import { createGit } from './git.js';
import { matchesAnyGlob } from './globs.js';
import { activeSessions } from './sessions.js';
import type { CommandRunner } from './exec.js';

// What a single session contributed relative to the integration branch: its
// changed files, forward-slash paths straight from git.
export type SessionChanges = {
  readonly sessionId: string;
  readonly branch: string;
  readonly files: readonly string[];
};

export type LaneInvasion = { readonly sessionId: string; readonly files: readonly string[] };
export type SharedZoneTouch = { readonly sessionId: string; readonly files: readonly string[] };
export type PairOverlap = { readonly a: string; readonly b: string; readonly files: readonly string[] };
export type SimulatedMerge = {
  readonly a: string;
  readonly b: string;
  readonly status: 'clean' | 'conflict';
  readonly conflicts: readonly string[];
};

export type IntegrationAnalysis = {
  readonly base: string;
  readonly sessions: readonly SessionChanges[];
  readonly invasions: readonly LaneInvasion[]; // only sessions WITH invasions
  readonly sharedZoneTouches: readonly SharedZoneTouch[]; // only sessions WITH touches
  readonly overlaps: readonly PairOverlap[];
  readonly simulatedMerges: readonly SimulatedMerge[];
};

export type IntegratorError = {
  readonly kind: 'integration-branch-missing' | 'session-branch-missing' | 'git' | 'io';
  readonly message: string;
  readonly sessionId?: string;
  readonly cause?: unknown;
};

// A file's relation to a session's assigned lane. Own-area wins: a file inside
// the session's own area is fine even if it also matches a shared zone.
export type FileClass = 'in-area' | 'shared-zone' | 'invasion';

export const classifyChangedFile = (
  file: string,
  areas: readonly string[],
  sharedZones: readonly string[],
): FileClass => {
  if (matchesAnyGlob(file, areas)) {
    return 'in-area';
  }
  if (matchesAnyGlob(file, sharedZones)) {
    return 'shared-zone';
  }
  return 'invasion';
};

// Files a session wrote OUTSIDE its lane and outside every shared zone.
export const detectLaneInvasions = (
  sessionId: string,
  changedFiles: readonly string[],
  areas: readonly string[],
  sharedZones: readonly string[],
): LaneInvasion => ({
  sessionId,
  files: changedFiles.filter((file) => classifyChangedFile(file, areas, sharedZones) === 'invasion'),
});

// Files a session wrote into a shared zone, independent of its area — shared
// zones are collaboration hot spots worth flagging even when they are legitimate.
export const detectSharedZoneTouches = (
  sessionId: string,
  changedFiles: readonly string[],
  sharedZones: readonly string[],
): SharedZoneTouch => ({
  sessionId,
  files: changedFiles.filter((file) => matchesAnyGlob(file, sharedZones)),
});

type SessionFileSet = { readonly sessionId: string; readonly files: readonly string[] };

// Codepoint (locale-free) ordering by session id. localeCompare's collation
// varies by OS/Node/ICU build, which would undermine the report's byte-for-byte
// determinism, so we compare code points directly.
const compareBySessionId = (
  left: { readonly sessionId: string },
  right: { readonly sessionId: string },
): number => (left.sessionId < right.sessionId ? -1 : left.sessionId > right.sessionId ? 1 : 0);

// Every unordered session pair whose changed-file sets intersect, ordered stably
// by session id so the report is deterministic. The intersection is sorted for
// the same reason.
export const detectPairOverlaps = (sessionChanges: readonly SessionFileSet[]): PairOverlap[] => {
  const sorted = [...sessionChanges].sort(compareBySessionId);
  const overlaps: PairOverlap[] = [];
  for (let i = 0; i < sorted.length; i += 1) {
    for (let j = i + 1; j < sorted.length; j += 1) {
      const a = sorted[i];
      const b = sorted[j];
      if (a === undefined || b === undefined) {
        continue;
      }
      const bFiles = new Set(b.files);
      const shared = [...new Set(a.files.filter((file) => bFiles.has(file)))].sort();
      if (shared.length > 0) {
        overlaps.push({ a: a.sessionId, b: b.sessionId, files: shared });
      }
    }
  }
  return overlaps;
};

// Inspects REAL git state before an integration: what each active session
// changed since the integration branch, who left their lane, who touched shared
// zones, which pairs collide, and — only for the colliding pairs — whether the
// merge conflicts (simulated, never touching a working tree).
export const analyzeIntegration = async (
  config: AgentsConfig,
  projectRoot: string,
  run?: CommandRunner,
  runRaw?: CommandRunner,
): Promise<Result<IntegrationAnalysis, IntegratorError>> => {
  const git = createGit(projectRoot, run, runRaw);
  const base = config.git.integrationBranch;

  const baseExists = await git.branchExists(base);
  if (!baseExists.ok) {
    return err({ kind: 'git', message: `could not check integration branch '${base}'`, cause: baseExists.error });
  }
  if (!baseExists.value) {
    return err({ kind: 'integration-branch-missing', message: `integration branch '${base}' does not exist` });
  }

  const sessions: SessionChanges[] = [];
  const invasions: LaneInvasion[] = [];
  const sharedZoneTouches: SharedZoneTouch[] = [];
  for (const session of activeSessions(config)) {
    const exists = await git.branchExists(session.branch);
    if (!exists.ok) {
      return err({
        kind: 'git',
        message: `could not check session branch '${session.branch}'`,
        sessionId: session.id,
        cause: exists.error,
      });
    }
    if (!exists.value) {
      return err({
        kind: 'session-branch-missing',
        message: `session branch '${session.branch}' does not exist`,
        sessionId: session.id,
      });
    }
    const changed = await git.changedFiles(base, session.branch);
    if (!changed.ok) {
      return err({
        kind: 'git',
        message: `could not diff session branch '${session.branch}' against '${base}'`,
        sessionId: session.id,
        cause: changed.error,
      });
    }
    sessions.push({ sessionId: session.id, branch: session.branch, files: changed.value });

    const invasion = detectLaneInvasions(session.id, changed.value, session.areas, config.sharedZones);
    if (invasion.files.length > 0) {
      invasions.push(invasion);
    }
    const touch = detectSharedZoneTouches(session.id, changed.value, config.sharedZones);
    if (touch.files.length > 0) {
      sharedZoneTouches.push(touch);
    }
  }

  const overlaps = detectPairOverlaps(sessions);

  // Simulate a merge for EVERY unordered pair of active sessions, ordered stably
  // by session id. This is deliberately NOT gated on `overlaps`: a merge conflict
  // does NOT require the SAME literal path on both sides. Verified blind spot —
  // session A adds a FILE `foo` while B adds `foo/bar.ts`: their changed-file
  // sets are DISJOINT (no overlap) yet git reports a file/directory conflict.
  // The only pair safe to skip is one where BOTH sessions changed nothing. N is
  // small by design, so N^2 merge-tree calls are fine. `overlaps` (same literal
  // path) remains a separate, complementary signal in the report.
  const ordered = [...sessions].sort(compareBySessionId);
  const simulatedMerges: SimulatedMerge[] = [];
  for (let i = 0; i < ordered.length; i += 1) {
    for (let j = i + 1; j < ordered.length; j += 1) {
      const a = ordered[i];
      const b = ordered[j];
      if (a === undefined || b === undefined) {
        continue;
      }
      if (a.files.length === 0 && b.files.length === 0) {
        continue; // nothing to merge on either side
      }
      const merge = await git.mergeTree(a.branch, b.branch);
      if (!merge.ok) {
        return err({
          kind: 'git',
          message: `could not simulate merge of '${a.branch}' and '${b.branch}'`,
          cause: merge.error,
        });
      }
      simulatedMerges.push({
        a: a.sessionId,
        b: b.sessionId,
        status: merge.value.status,
        conflicts: merge.value.status === 'conflict' ? merge.value.files : [],
      });
    }
  }

  return ok({ base, sessions, invasions, sharedZoneTouches, overlaps, simulatedMerges });
};

// --- Rendering (pure, deterministic: identical inputs yield identical bytes) ---

// Neutral Peruvian Spanish, tuteo — mirrors renderBoard. Picks singular/plural
// by count so counts read naturally.
const plural = (count: number, singular: string, pluralForm: string): string =>
  `${count} ${count === 1 ? singular : pluralForm}`;

const bullet = (file: string): string => `- \`${file}\``;

const conflictCount = (analysis: IntegrationAnalysis): number =>
  analysis.simulatedMerges.filter((merge) => merge.status === 'conflict').length;

// A one-line summary suitable for the board's lastIntegratorCheck slot. Not
// wired into the board here — Phase 7 owns that orchestration.
export const integrationSummaryLine = (analysis: IntegrationAnalysis): string =>
  [
    plural(analysis.sessions.length, 'sesión', 'sesiones'),
    plural(analysis.invasions.length, 'invasión', 'invasiones'),
    plural(conflictCount(analysis), 'conflicto simulado', 'conflictos simulados'),
  ].join(', ');

export const renderIntegrationReport = (
  analysis: IntegrationAnalysis,
  projectName: string,
  now: Date,
): string => {
  const lines: string[] = [
    `# Integrador — ${projectName}`,
    '',
    `Generado: ${now.toISOString()}`,
    '',
    '## Resumen',
    '',
    `- Rama de integración: \`${analysis.base}\``,
    `- Sesiones analizadas: ${analysis.sessions.length}`,
    `- Invasiones de carril: ${analysis.invasions.length}`,
    `- Toques a zonas compartidas: ${analysis.sharedZoneTouches.length}`,
    `- Solapamientos: ${analysis.overlaps.length}`,
    `- Conflictos simulados: ${conflictCount(analysis)}`,
    '',
    '## Cambios por sesión',
    '',
    '| Sesión | Rama | Archivos |',
    '| --- | --- | --- |',
    ...analysis.sessions.map(
      (session) => `| ${session.sessionId} | \`${session.branch}\` | ${session.files.length} |`,
    ),
    '',
    '## Invasiones de carril',
    '',
    'Archivos que una sesión modificó fuera de sus áreas asignadas.',
    '',
  ];

  if (analysis.invasions.length === 0) {
    lines.push('_Ninguna._', '');
  } else {
    for (const invasion of analysis.invasions) {
      lines.push(`### ${invasion.sessionId}`, ...invasion.files.map(bullet), '');
    }
  }

  lines.push('## Zonas compartidas tocadas', '');
  if (analysis.sharedZoneTouches.length === 0) {
    lines.push('_Ninguna._', '');
  } else {
    for (const touch of analysis.sharedZoneTouches) {
      lines.push(`### ${touch.sessionId}`, ...touch.files.map(bullet), '');
    }
  }

  lines.push('## Solapamientos entre sesiones', '');
  lines.push('Archivos que dos sesiones modificaron a la vez.', '');
  if (analysis.overlaps.length === 0) {
    lines.push('_Ninguno._', '');
  } else {
    for (const overlap of analysis.overlaps) {
      lines.push(`### ${overlap.a} ↔ ${overlap.b}`, ...overlap.files.map(bullet), '');
    }
  }

  lines.push('## Merges simulados', '');
  if (analysis.simulatedMerges.length === 0) {
    lines.push('_Ninguno._', '');
  } else {
    for (const merge of analysis.simulatedMerges) {
      const label = merge.status === 'conflict' ? 'conflicto' : 'limpio';
      lines.push(`### ${merge.a} ↔ ${merge.b} — ${label}`);
      if (merge.status === 'conflict') {
        lines.push(...merge.conflicts.map(bullet));
      }
      lines.push('');
    }
  }

  return `${lines.join('\n')}\n`;
};

export type IntegrationReportWriteResult = {
  readonly action: WriteAction;
  readonly path: string;
};

// Renders and writes the report under the shared board (reports/integration.md),
// reusing writeFileIdempotent so a no-op run never rewrites the file. mkdir keeps
// it standalone-safe even if ensureBoard has not run.
export const writeIntegrationReport = async (
  config: AgentsConfig,
  projectRoot: string,
  analysis: IntegrationAnalysis,
  now: Date,
): Promise<Result<IntegrationReportWriteResult, IntegratorError>> => {
  const reportsDir = path.join(resolveBoardDir(projectRoot, config), 'reports');
  const filePath = path.join(reportsDir, 'integration.md');
  try {
    await fs.mkdir(reportsDir, { recursive: true });
  } catch (error) {
    return err({ kind: 'io', message: `could not create reports dir ${reportsDir}`, cause: error });
  }
  const written = await writeFileIdempotent(filePath, renderIntegrationReport(analysis, config.project.name, now));
  return written.ok
    ? ok({ action: written.value.action, path: filePath })
    : err({ kind: 'io', message: written.error.message, cause: written.error.cause });
};
