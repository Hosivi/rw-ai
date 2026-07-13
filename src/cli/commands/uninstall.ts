import { removeAdapters, removeUserAdapters } from '../../engine/adapters.js';
import type { AdapterRemoval, AdapterRemoveAction } from '../../engine/adapters.js';
import { purgeProvisioning } from '../../engine/purge.js';
import type { PurgeAction, PurgeItem } from '../../engine/purge.js';
import { contextErrorResult, type CliDeps, type CommandResult } from '../command.js';
import { loadContext } from '../context.js';

// Flags `rw uninstall` accepts. --worktrees mirrors `rw adapters` (clean the
// Claude Code config files inside each active session worktree); --user cleans
// the USER scope (deps.homeDir) instead of the project; --purge ALSO
// de-provisions the repo (worktrees, branches, board, agents.config.json), with
// --force overriding its safety guards. --user+--worktrees and --user+--purge
// are rejected upstream in run.ts (the user scope has neither).
export type UninstallArgs = {
  readonly worktrees?: boolean;
  readonly user?: boolean;
  readonly purge?: boolean;
  readonly force?: boolean;
};

// Spanish labels for the removal vocabulary, one per action. The purge adds
// 'kept' on top of the adapters' three.
const ACTION_LABELS: Record<AdapterRemoveAction | PurgeAction, string> = {
  removed: 'eliminado',
  cleaned: 'limpiado',
  kept: 'conservado',
  absent: 'ya ausente',
};

// One line per file with its exact outcome: the report is the honest contract
// about what the uninstall touched (and what it found already gone).
const removalLines = (removed: readonly AdapterRemoval[]): string[] =>
  removed.map((entry) => `  ${ACTION_LABELS[entry.action]}: ${entry.path}`);

const removalSummary = (removed: readonly AdapterRemoval[]): string => {
  const count = (action: AdapterRemoveAction): number =>
    removed.filter((entry) => entry.action === action).length;
  return `${removed.length} archivos procesados: ${count('removed')} eliminados, ${count('cleaned')} limpiados, ${count('absent')} ya ausentes`;
};

// One line per purge target; a kept target carries its safety reason inline so
// the user sees WHY it survived without digging.
const purgeLines = (items: readonly PurgeItem[]): string[] =>
  items.map((item) =>
    item.action === 'kept' && item.reason !== undefined
      ? `  ${ACTION_LABELS[item.action]}: ${item.target} — ${item.reason}`
      : `  ${ACTION_LABELS[item.action]}: ${item.target}`,
  );

const purgeSummary = (items: readonly PurgeItem[]): string => {
  const count = (action: PurgeAction): number =>
    items.filter((item) => item.action === action).length;
  return `Purga: ${count('removed')} eliminados, ${count('cleaned')} limpiados, ${count('kept')} conservados, ${count('absent')} ya ausentes`;
};

// The binary note is ALWAYS printed: rw never runs `npm rm -g` itself — a
// process should not uninstall itself while running.
const BINARY_NOTE = 'Para quitar el binario: npm rm -g rw-ai';

// Without --purge nothing provisioned is touched; with it, that promise shrinks
// to what the safety guards protect, so each mode states its own contract.
const UNTOUCHED_NOTE =
  'No se tocaron agents.config.json, worktrees ni ramas: tu trabajo sigue intacto.';

// `rw uninstall --user`: the exact inverse of `rw adapters --user`. Repo-free
// like the install, so it does NOT load the project context.
const runUserUninstall = async (deps: CliDeps): Promise<CommandResult> => {
  const result = await removeUserAdapters(deps.homeDir);
  if (!result.ok) {
    return {
      lines: [`Error al quitar los adaptadores a nivel usuario: ${result.error.message}`],
      exitCode: 1,
    };
  }
  const { removed } = result.value;
  return {
    lines: [removalSummary(removed), ...removalLines(removed), UNTOUCHED_NOTE, BINARY_NOTE],
    exitCode: 0,
  };
};

// `rw uninstall`: unwire rw's agent integration (MCP entries, hooks, skills and
// command wrappers) from the repo without deleting any user work. With --purge
// it ALSO de-provisions the repo; anything a safety guard kept turns the exit
// code to 1 so scripts can detect a partial purge. The remaining exit-1 paths
// mirror `rw adapters`: a missing/invalid config (context) or an I/O /
// non-JSON-config failure while cleaning.
export const runUninstall = async (args: UninstallArgs, deps: CliDeps): Promise<CommandResult> => {
  // --user is a machine-wide cleanup: it needs no repo, so it bypasses loadContext.
  if (args.user === true) {
    return runUserUninstall(deps);
  }
  const context = await loadContext(deps.cwd, deps.run, deps.runRaw);
  if (!context.ok) {
    // For --purge only, a missing agents.config.json is the GOAL state (the
    // purge itself deletes it last), so a rerun is a successful no-op instead of
    // the context error every other command reports. Any other context failure
    // (not a repo, invalid config) still errors normally.
    if (args.purge === true && context.error.kind === 'config-not-found') {
      return {
        lines: ['No hay agents.config.json en este repo: no queda nada que purgar.', BINARY_NOTE],
        exitCode: 0,
      };
    }
    return contextErrorResult(context.error);
  }
  const result = await removeAdapters(context.value.projectRoot, context.value.config, {
    ...(args.worktrees === true ? { worktrees: true } : {}),
  });
  if (!result.ok) {
    return { lines: [`Error al quitar los adaptadores: ${result.error.message}`], exitCode: 1 };
  }
  const { removed } = result.value;
  const adapterReport = [removalSummary(removed), ...removalLines(removed)];

  if (args.purge !== true) {
    return { lines: [...adapterReport, UNTOUCHED_NOTE, BINARY_NOTE], exitCode: 0 };
  }

  // --purge: de-provision on top of the adapters unwire. Safety refusals (dirty
  // worktree, unmerged branch) never abort the run; they flip the exit code.
  const purged = await purgeProvisioning(context.value.projectRoot, context.value.config, {
    ...(args.force === true ? { force: true } : {}),
    ...(deps.run !== undefined ? { run: deps.run } : {}),
    ...(deps.runRaw !== undefined ? { runRaw: deps.runRaw } : {}),
  });
  if (!purged.ok) {
    return { lines: [...adapterReport, `Error en la purga: ${purged.error.message}`], exitCode: 1 };
  }
  const { items } = purged.value;
  const keptCount = items.filter((item) => item.action === 'kept').length;
  const keptNote =
    keptCount > 0
      ? [
          `Se conservaron ${keptCount} elementos por seguridad (trabajo sin integrar); vuelve a correr con --force para quitarlos también.`,
        ]
      : [];
  return {
    lines: [...adapterReport, purgeSummary(items), ...purgeLines(items), ...keptNote, BINARY_NOTE],
    exitCode: keptCount > 0 ? 1 : 0,
  };
};
