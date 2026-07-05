import { installAdapters, installUserAdapters } from '../../engine/adapters.js';
import type { AdapterWrite } from '../../engine/adapters.js';
import { contextErrorResult, type CliDeps, type CommandResult } from '../command.js';
import { loadContext } from '../context.js';

// Flags `rw adapters` accepts. --worktrees replicates the Claude Code config files
// into each active session worktree; --user installs rw's MCP server + hooks at the
// USER scope (deps.homeDir) so every session on the machine sees rw. They are
// mutually meaningful but --user takes precedence (a global install needs no repo).
export type AdaptersArgs = {
  readonly worktrees?: boolean;
  readonly user?: boolean;
};

// The always-appended OpenCode gap note (shared by both scopes): its pre-write hook
// is plugin-only, so rw only wires OpenCode's MCP server, never a lane guard.
const OPENCODE_GAP_NOTE =
  'Nota: el hook de carril para OpenCode queda PENDIENTE DE VERIFICACIÓN (su guard pre-escritura exige un plugin TypeScript, no una entrada JSON); solo se escribió su servidor MCP.';

// The created/updated/unchanged tally shared by both scopes.
const writeSummary = (written: readonly AdapterWrite[]): string => {
  const count = (action: string): number => written.filter((write) => write.action === action).length;
  return `${written.length} archivos escritos: ${count('created')} creados, ${count('updated')} actualizados, ${count('unchanged')} sin cambios`;
};

// `rw adapters --user`: install rw's MCP server + hooks at the USER scope so EVERY
// Claude Code / OpenCode session sees rw with no per-project setup. Config-independent
// and repo-free, so it does NOT load the project context. The summary names exactly
// which user-scoped files were written (an honest contract about what changed) and
// carries the documented OpenCode hook gap.
const runUserAdapters = async (deps: CliDeps): Promise<CommandResult> => {
  const result = await installUserAdapters(deps.homeDir);
  if (!result.ok) {
    return {
      lines: [`Error al escribir los adaptadores a nivel usuario: ${result.error.message}`],
      exitCode: 1,
    };
  }
  const { written } = result.value;
  const filesLine = `Archivos a nivel usuario: ${written.map((write) => write.path).join(', ')}.`;
  const scopeLine =
    'Config a nivel usuario (aplica a TODAS tus sesiones): Claude Code usa el servidor MCP rw-ai en .claude.json (clave mcpServers) y los hooks PreToolUse `rw lane-guard` + SessionStart `rw session-start` en .claude/settings.json; OpenCode usa el servidor MCP rw-ai en .config/opencode/opencode.json. No se escribió nada en el proyecto.';
  return { lines: [writeSummary(written), filesLine, scopeLine, OPENCODE_GAP_NOTE], exitCode: 0 };
};

// `rw adapters`: load the shared context, write the cross-agent adapters (skills,
// command wrappers, the MCP server config and the PreToolUse/SessionStart hooks)
// into the repo, and render a Spanish summary. The only exit-1 paths are a
// missing/invalid config (context) or an I/O / non-JSON-config failure while writing.
export const runAdapters = async (args: AdaptersArgs, deps: CliDeps): Promise<CommandResult> => {
  // --user is a machine-wide install: it needs no repo, so it bypasses loadContext.
  if (args.user === true) {
    return runUserAdapters(deps);
  }
  const context = await loadContext(deps.cwd, deps.run, deps.runRaw);
  if (!context.ok) {
    return contextErrorResult(context.error);
  }
  const result = await installAdapters(context.value.projectRoot, context.value.config, {
    ...(args.worktrees === true ? { worktrees: true } : {}),
  });
  if (!result.ok) {
    return { lines: [`Error al escribir los adaptadores: ${result.error.message}`], exitCode: 1 };
  }
  const { written } = result.value;
  const configLine =
    'Config del agente: .mcp.json (servidor MCP rw-ai) y .claude/settings.json (hooks PreToolUse `rw lane-guard` + SessionStart `rw session-start`) para Claude Code; opencode.json (servidor MCP rw-ai) para OpenCode.';
  const worktreeLine =
    args.worktrees === true
      ? 'Con --worktrees: .mcp.json y .claude/settings.json también se escribieron en cada worktree de sesión activa.'
      : 'Sin --worktrees: la config se escribió solo en la raíz compartida (pasa --worktrees para replicarla en cada worktree). Para instalar rw en TODA sesión de la máquina, corre `rw adapters --user`.';
  return { lines: [writeSummary(written), configLine, worktreeLine, OPENCODE_GAP_NOTE], exitCode: 0 };
};
