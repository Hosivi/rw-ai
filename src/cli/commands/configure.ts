import { configure } from '../../engine/configure.js';
import { contextErrorResult, type CliDeps, type CommandResult } from '../command.js';
import { loadContext } from '../context.js';
import { formatRunbook } from '../output.js';

// `rw configure`: load the shared context, run the provisioning runbook against
// the real repo, and render it. The runbook never throws, so the only exit-1
// path here is a missing/invalid config (context) or a step that FAILED.
export const runConfigure = async (deps: CliDeps): Promise<CommandResult> => {
  const context = await loadContext(deps.cwd, deps.run, deps.runRaw);
  if (!context.ok) {
    return contextErrorResult(context.error);
  }
  const result = await configure(context.value.config, context.value.projectRoot, {
    now: deps.now,
    run: deps.run,
    runRaw: deps.runRaw,
  });
  return { lines: formatRunbook(result).split('\n'), exitCode: result.ok ? 0 : 1 };
};
