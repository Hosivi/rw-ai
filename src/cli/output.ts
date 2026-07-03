import { assertNever } from '../core/assert.js';
import type { ClaudeSession } from '../engine/claude-sessions.js';
import type { RunbookResult, StepStatus } from '../engine/configure.js';
import type { RoleStatus } from '../engine/identity.js';
import { integrationSummaryLine, type IntegrationAnalysis } from '../engine/integrator.js';
import type { CliContextError } from './context.js';

// Neutral Peruvian Spanish, tuteo — mirrors renderBoard / the integrator report.
// Everything here is a PURE (…) => string: the only side effect (printLines)
// lives at the bottom so every formatter stays trivially testable.

// One glyph per runbook status; the exhaustive switch makes a new StepStatus a
// compile error instead of a silent blank.
const stepGlyph = (status: StepStatus): string => {
  switch (status) {
    case 'ok':
      return '✓';
    case 'degraded':
      return '⚠';
    case 'skipped':
      return '·';
    case 'failed':
      return '✗';
    default:
      return assertNever(status);
  }
};

// A readable step report: one '<glyph> <name> — <detail>' line per step, closed
// by a Spanish summary that counts what went wrong (a degraded step is a warning,
// so 'completa' still holds only when nothing failed — mirroring RunbookResult.ok).
export const formatRunbook = (result: RunbookResult): string => {
  const lines = result.steps.map((step) => `${stepGlyph(step.status)} ${step.name} — ${step.detail}`);
  if (result.ok) {
    lines.push('Configuración completa');
  } else {
    const failed = result.steps.filter((step) => step.status === 'failed').length;
    const degraded = result.steps.filter((step) => step.status === 'degraded').length;
    lines.push(`Configuración con problemas: ${failed} fallidos, ${degraded} degradados`);
  }
  return lines.join('\n');
};

// The Spanish status label for a single role. Shared with the interactive picker
// so the wording of libre/ocupado/vencido lives in exactly one place. An expired
// claim reads as free (it is claimable again) but says so, unlike a never-claimed
// role.
export const roleStatusLabel = (role: RoleStatus): string => {
  if (role.status === 'claimed' && role.claim !== undefined) {
    const agent = role.claim.status === 'claimed' && role.claim.agent !== undefined
      ? `, agente ${role.claim.agent}`
      : '';
    const expiresAt = role.claim.status === 'claimed' ? role.claim.expiresAt : '';
    return `ocupado (expira ${expiresAt}${agent})`;
  }
  return role.expired ? 'libre (claim vencido)' : 'libre';
};

// A left-aligned list of roles: the id column is padded to the widest id so the
// Spanish labels line up. Pure and deterministic — no locale-sensitive sorting.
export const formatRoles = (roles: readonly RoleStatus[]): string => {
  const width = roles.reduce((max, role) => Math.max(max, role.role.length), 0);
  return roles.map((role) => `${role.role.padEnd(width)}  ${roleStatusLabel(role)}`).join('\n');
};

const conflictedMerges = (analysis: IntegrationAnalysis): IntegrationAnalysis['simulatedMerges'] =>
  analysis.simulatedMerges.filter((merge) => merge.status === 'conflict');

// A short Spanish integration summary: the one-line headline (reused from the
// engine so both stay in sync), the per-dimension counts, and — only when there
// are any — the conflicted simulated pairs with their offending files.
export const formatIntegration = (analysis: IntegrationAnalysis): string => {
  const conflicts = conflictedMerges(analysis);
  const lines = [
    integrationSummaryLine(analysis),
    `Sesiones analizadas: ${analysis.sessions.length}`,
    `Invasiones de carril: ${analysis.invasions.length}`,
    `Zonas compartidas tocadas: ${analysis.sharedZoneTouches.length}`,
    `Solapamientos: ${analysis.overlaps.length}`,
    `Conflictos simulados: ${conflicts.length}`,
  ];
  if (conflicts.length > 0) {
    lines.push('Pares en conflicto:');
    for (const merge of conflicts) {
      lines.push(`- ${merge.a} ↔ ${merge.b}: ${merge.conflicts.join(', ')}`);
    }
  }
  return lines.join('\n');
};

// The machine-level Claude Code job listing as a Spanish markdown table (neutral
// Peruvian, tuteo). Absent fields render as '—'. Pure and deterministic, and it
// only ever shows the identifying columns — never prompt or token content.
export const formatClaudeSessions = (sessions: readonly ClaudeSession[]): string => {
  if (sessions.length === 0) {
    return '_No hay sesiones de Claude Code en esta máquina._';
  }
  const cell = (value: string | undefined): string => value ?? '—';
  const header = '| Job | Proyecto | Estado | Último | Nombre |';
  const separator = '| --- | --- | --- | --- | --- |';
  const rows = sessions.map(
    (session) =>
      `| ${session.id} | ${cell(session.cwd)} | ${cell(session.state)} | ${cell(session.updatedAt)} | ${cell(session.name)} |`,
  );
  return [header, separator, ...rows].join('\n');
};

// One file's estimated (or exact) token count. path is absolute so the summary is
// unambiguous when files come from several directories.
export type FileTokens = {
  readonly path: string;
  readonly tokens: number;
};

// The full result of `rw tokens`: per-file counts, the total, the model the cost is
// priced against, the input cost in USD (undefined = the model has no price), and
// whether the count was an offline estimate or an exact online count.
export type TokensSummary = {
  readonly files: readonly FileTokens[];
  readonly totalTokens: number;
  readonly model: string;
  readonly costUsd: number | undefined;
  readonly mode: 'offline' | 'online';
};

// USD with 6 decimals via toFixed: token costs are often fractions of a cent, and
// toFixed is locale-independent so the output stays deterministic across machines
// (unlike Intl.NumberFormat, which is env-sensitive).
const formatUsd = (usd: number): string => `US$ ${usd.toFixed(6)}`;

// The Spanish (tuteo) terminal summary for `rw tokens`. Pure and deterministic:
// per-file counts, the total, the model, the input cost (or an explicit "sin
// precio" pointing at pricing.json), and a note making the OFFLINE case read as an
// estimate — never as an authoritative count.
export const formatTokens = (summary: TokensSummary): string => {
  const lines = [`Archivos analizados: ${summary.files.length}`];
  for (const file of summary.files) {
    lines.push(`- ${file.path}: ${file.tokens} tokens`);
  }
  lines.push(`Total: ${summary.totalTokens} tokens`, `Modelo: ${summary.model}`);
  lines.push(
    summary.costUsd === undefined
      ? 'Costo estimado de entrada: sin precio (edita pricing.json)'
      : `Costo estimado de entrada: ${formatUsd(summary.costUsd)}`,
  );
  lines.push(
    summary.mode === 'offline'
      ? 'Nota: es una ESTIMACIÓN sin conexión (~4 caracteres por token). Usa --online para un conteo exacto.'
      : 'Nota: conteo exacto obtenido de la API de conteo de tokens de Anthropic.',
  );
  return lines.join('\n');
};

// Turns a context failure into an actionable Spanish message: each kind names the
// next step the user should take, not just what went wrong.
export const formatContextError = (error: CliContextError): string => {
  switch (error.kind) {
    case 'not-a-repo':
      return 'No estás dentro de un repositorio git. Ejecuta rw dentro de un repositorio con git inicializado.';
    case 'config-not-found':
      return "No se encontró agents.config.json. Ejecuta 'rw configure' para generarlo.";
    case 'config-invalid': {
      const issues = error.issues ?? [];
      if (issues.length === 0) {
        return `El archivo agents.config.json es inválido: ${error.message}`;
      }
      return ['El archivo agents.config.json es inválido:', ...issues.map((issue) => `- ${issue}`)].join('\n');
    }
    case 'io':
      return `Error de entrada/salida: ${error.message}`;
    default:
      return assertNever(error.kind);
  }
};

// The ONLY side effect in this module: kept as a thin seam over console.log so
// every formatter above stays a pure string function. The writer is injectable
// so tests can capture output without touching the console.
export const printLines = (
  lines: readonly string[],
  write: (s: string) => void = (s) => console.log(s),
): void => {
  for (const line of lines) {
    write(line);
  }
};
