import type { BlastRadius } from './blast-radius.js';

// WU-4.3: a first-class ASCII rendering of the blast radius. The image.nvim path
// (Kitty/WezTerm/sixel) is a plugin-side enhancement layered on the same data;
// ASCII is always available and is what degraded terminals (and tests) get.

export type DiagramInput = {
  readonly sessionId: string;
  readonly changedFiles: readonly string[];
  readonly blast?: BlastRadius;
  readonly unavailableReason?: string;
};

export const renderAsciiDiagram = (input: DiagramInput): string[] => {
  const lines: string[] = [`Blast radius — ${input.sessionId}`, ''];

  if (input.changedFiles.length === 0) {
    lines.push('(no changed files vs the integration branch)');
    return lines;
  }

  lines.push(`Changed files (${input.changedFiles.length}):`);
  for (const file of input.changedFiles) {
    lines.push(`  ${file}`);
  }
  lines.push('');

  if (input.blast === undefined) {
    lines.push(
      `[CodeGraph] unavailable: ${input.unavailableReason ?? 'no data'} — showing changed files only.`,
    );
    return lines;
  }

  const { changedSymbols, affected } = input.blast;
  lines.push(`Changed symbols (${changedSymbols.length}): ${changedSymbols.join(', ') || '—'}`);
  lines.push('');
  lines.push(`Affected callers (${affected.length}):`);
  if (affected.length === 0) {
    lines.push('  (none — nothing else depends on the changed symbols)');
  } else {
    for (const symbol of affected) {
      lines.push(`  ← ${symbol}`);
    }
  }
  return lines;
};
