import { installAdapters } from '../../engine/adapters.js';
import { contextErrorResult, type CliDeps, type CommandResult } from '../command.js';
import { loadContext } from '../context.js';

// `rw adapters`: load the shared context, write the cross-agent adapters into the
// repo, and render a Spanish summary. The only exit-1 paths are a missing/invalid
// config (context) or an I/O failure while writing.
export const runAdapters = async (deps: CliDeps): Promise<CommandResult> => {
  const context = await loadContext(deps.cwd, deps.run, deps.runRaw);
  if (!context.ok) {
    return contextErrorResult(context.error);
  }
  const result = await installAdapters(context.value.projectRoot, context.value.config);
  if (!result.ok) {
    return { lines: [`Error al escribir los adaptadores: ${result.error.message}`], exitCode: 1 };
  }
  const { written } = result.value;
  const count = (action: string): number => written.filter((write) => write.action === action).length;
  const summary = `${written.length} archivos escritos: ${count('created')} creados, ${count('updated')} actualizados, ${count('unchanged')} sin cambios`;
  return { lines: [summary], exitCode: 0 };
};
