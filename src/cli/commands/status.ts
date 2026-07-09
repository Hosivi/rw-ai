import { resolveBoardDir } from '../../contract/env.js';
import type { Light, SessionState } from '../../state/aggregate.js';
import { collectSessionStates } from '../../state/read.js';
import type { CliDeps, CommandResult } from '../command.js';
import { contextErrorResult } from '../command.js';
import { loadContext } from '../context.js';

// Presentation-only Spanish labels; the on-disk/model values stay English.
const LIGHT_LABEL: Record<Light, string> = {
  red: 'rojo',
  yellow: 'amarillo',
  green: 'verde',
};

const claimLabel = (state: SessionState): string => {
  if (state.claim.status === 'free') {
    return 'libre';
  }
  return state.claim.expired ? 'vencido' : 'ocupado';
};

const gitLabel = (state: SessionState): string => {
  const parts: string[] = [];
  if (state.git.ahead > 0) parts.push(`+${state.git.ahead}`);
  if (state.git.behind > 0) parts.push(`-${state.git.behind}`);
  if (state.git.dirty) parts.push('sucio');
  return parts.length > 0 ? parts.join(' ') : 'limpio';
};

// The public JSON shape: NEVER the raw SessionState, whose claim carries the
// secret claim token. Redact to status/expired only; the marker holds no secrets.
type PublicSessionState = {
  readonly sessionId: string;
  readonly branch: string;
  readonly light: Light;
  readonly claim: { readonly status: 'free' | 'claimed'; readonly expired: boolean };
  readonly phase: string | null;
  readonly tests: string | null;
  readonly git: SessionState['git'];
};

const toPublic = (state: SessionState): PublicSessionState => ({
  sessionId: state.sessionId,
  branch: state.branch,
  light: state.light,
  claim: { status: state.claim.status, expired: state.claim.expired },
  phase: state.marker?.phase ?? null,
  tests: state.marker?.tests ?? null,
  git: state.git,
});

export const formatStatusJson = (states: readonly SessionState[]): string =>
  JSON.stringify(states.map(toPublic), null, 2);

export const formatStatusTable = (states: readonly SessionState[]): string[] => {
  if (states.length === 0) {
    return ['No hay sesiones activas.'];
  }
  const header = ['SESIÓN', 'ESTADO', 'CLAIM', 'GIT', 'FASE', 'RAMA'];
  const rows = states.map((s) => [
    s.sessionId,
    LIGHT_LABEL[s.light],
    claimLabel(s),
    gitLabel(s),
    s.marker?.phase ?? '—',
    s.branch,
  ]);
  const widths = header.map((_, col) =>
    Math.max(header[col]!.length, ...rows.map((row) => row[col]!.length)),
  );
  const render = (cells: string[]): string =>
    cells.map((cell, col) => cell.padEnd(widths[col]!)).join('  ').trimEnd();
  return [render(header), ...rows.map(render)];
};

// One-shot, read-only: resolve context, collect state from disk, print. No writes.
export const runStatus = async (
  args: { readonly json: boolean },
  deps: CliDeps,
): Promise<CommandResult> => {
  const context = await loadContext(deps.cwd, deps.run, deps.runRaw);
  if (!context.ok) {
    return contextErrorResult(context.error);
  }
  const boardDir = resolveBoardDir(context.value.projectRoot, context.value.config);
  const states = await collectSessionStates({
    config: context.value.config,
    projectRoot: context.value.projectRoot,
    boardDir,
    now: deps.now,
    run: deps.run,
    runRaw: deps.runRaw,
  });
  if (!states.ok) {
    return { lines: [`No se pudo leer el estado: ${states.error.message}`], exitCode: 1 };
  }
  return args.json
    ? { lines: [formatStatusJson(states.value)], exitCode: 0 }
    : { lines: formatStatusTable(states.value), exitCode: 0 };
};
