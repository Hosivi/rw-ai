import { installAdapters } from '../../engine/adapters.js';
import { contextErrorResult, type CliDeps, type CommandResult } from '../command.js';
import { loadContext } from '../context.js';

// Flags `rw adapters` accepts. --worktrees replicates the Claude Code config files
// into each active session worktree, not just the shared root.
export type AdaptersArgs = {
  readonly worktrees?: boolean;
};

// `rw adapters`: load the shared context, write the cross-agent adapters (skills,
// command wrappers, the MCP server config and the PreToolUse lane-guard hook) into
// the repo, and render a Spanish summary. The only exit-1 paths are a missing/invalid
// config (context) or an I/O / non-JSON-config failure while writing.
export const runAdapters = async (args: AdaptersArgs, deps: CliDeps): Promise<CommandResult> => {
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
  const count = (action: string): number => written.filter((write) => write.action === action).length;
  const summary = `${written.length} archivos escritos: ${count('created')} creados, ${count('updated')} actualizados, ${count('unchanged')} sin cambios`;
  const configLine =
    'Config del agente: .mcp.json (servidor MCP rw-ai) y .claude/settings.json (hook PreToolUse `rw lane-guard`) para Claude Code; opencode.json (servidor MCP rw-ai) para OpenCode.';
  const worktreeLine =
    args.worktrees === true
      ? 'Con --worktrees: .mcp.json y .claude/settings.json también se escribieron en cada worktree de sesión activa.'
      : 'Sin --worktrees: la config se escribió solo en la raíz compartida (pasa --worktrees para replicarla en cada worktree).';
  const opencodeNote =
    'Nota: el hook de carril para OpenCode queda PENDIENTE DE VERIFICACIÓN (su guard pre-escritura exige un plugin TypeScript, no una entrada JSON); por ahora solo se escribió su servidor MCP.';
  return { lines: [summary, configLine, worktreeLine, opencodeNote], exitCode: 0 };
};
