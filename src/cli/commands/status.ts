import { resolveBoardDir } from '../../contract/env.js';
import type { Light } from '../../state/aggregate.js';
import { toPublicState, type PublicSessionState } from '../../state/public.js';
import { collectSessionStates } from '../../state/read.js';
import { readSnapshotViaDaemon } from '../../daemon/client.js';
import { daemonAddress } from '../../daemon/address.js';
import type { CliDeps, CommandResult } from '../command.js';
import { contextErrorResult } from '../command.js';
import { loadContext } from '../context.js';

// Presentation-only Spanish labels; the on-disk/model values stay English.
const LIGHT_LABEL: Record<Light, string> = {
  red: 'rojo',
  yellow: 'amarillo',
  green: 'verde',
};

const claimLabel = (state: PublicSessionState): string => {
  if (state.claim.status === 'free') {
    return 'libre';
  }
  return state.claim.expired ? 'vencido' : 'ocupado';
};

const gitLabel = (state: PublicSessionState): string => {
  const parts: string[] = [];
  if (state.git.ahead > 0) parts.push(`+${state.git.ahead}`);
  if (state.git.behind > 0) parts.push(`-${state.git.behind}`);
  if (state.git.dirty) parts.push('sucio');
  return parts.length > 0 ? parts.join(' ') : 'limpio';
};

// Formatters operate on the wire-safe projection so the daemon path and the
// one-shot path render identically (and neither can print the claim token).
export const formatStatusJson = (states: readonly PublicSessionState[]): string =>
  JSON.stringify(states, null, 2);

export const formatStatusTable = (states: readonly PublicSessionState[]): string[] => {
  if (states.length === 0) {
    return ['No hay sesiones activas.'];
  }
  const header = ['SESIÓN', 'ESTADO', 'CLAIM', 'GIT', 'FASE', 'RAMA'];
  const rows = states.map((s) => [
    s.sessionId,
    LIGHT_LABEL[s.light],
    claimLabel(s),
    gitLabel(s),
    s.phase ?? '—',
    s.branch,
  ]);
  const widths = header.map((_, col) =>
    Math.max(header[col]!.length, ...rows.map((row) => row[col]!.length)),
  );
  const render = (cells: string[]): string =>
    cells.map((cell, col) => cell.padEnd(widths[col]!)).join('  ').trimEnd();
  return [render(header), ...rows.map(render)];
};

// Read-only status. Prefers the observer daemon (one connect + `get`); if none is
// listening, falls back to a local one-shot compute — so `rw status` works with or
// without a daemon (WU-2.5). Either path yields the same wire-safe shape.
export const runStatus = async (
  args: { readonly json: boolean },
  deps: CliDeps,
): Promise<CommandResult> => {
  const context = await loadContext(deps.cwd, deps.run, deps.runRaw);
  if (!context.ok) {
    return contextErrorResult(context.error);
  }
  const { projectRoot, config } = context.value;

  let states = await readSnapshotViaDaemon(daemonAddress(projectRoot, deps.platform));
  if (states === null) {
    const boardDir = resolveBoardDir(projectRoot, config);
    const collected = await collectSessionStates({
      config,
      projectRoot,
      boardDir,
      now: deps.now,
      run: deps.run,
      runRaw: deps.runRaw,
    });
    if (!collected.ok) {
      return { lines: [`No se pudo leer el estado: ${collected.error.message}`], exitCode: 1 };
    }
    states = collected.value.map(toPublicState);
  }

  return args.json
    ? { lines: [formatStatusJson(states)], exitCode: 0 }
    : { lines: formatStatusTable(states), exitCode: 0 };
};
