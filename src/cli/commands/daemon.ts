import { resolveBoardDir } from '../../contract/env.js';
import { daemonAddress } from '../../daemon/address.js';
import { readSnapshotViaDaemon } from '../../daemon/client.js';
import { startRepoDaemon } from '../../daemon/runtime.js';
import type { CliDeps, CommandResult } from '../command.js';
import { contextErrorResult } from '../command.js';
import { loadContext } from '../context.js';

// `rw daemon`: run the per-repo observer daemon in the foreground. It stays alive
// (the returned promise resolves only on idle self-shutdown), so a launcher runs
// it detached. Single-instance: if one already serves this repo, exit 0 without
// starting a second.
export const runDaemon = async (deps: CliDeps): Promise<CommandResult> => {
  const context = await loadContext(deps.cwd, deps.run, deps.runRaw);
  if (!context.ok) {
    return contextErrorResult(context.error);
  }
  const { projectRoot, config } = context.value;
  const address = daemonAddress(projectRoot, deps.platform);

  const existing = await readSnapshotViaDaemon(address, 500);
  if (existing !== null) {
    return { lines: [`El daemon ya está corriendo para ${projectRoot}.`], exitCode: 0 };
  }

  const boardDir = resolveBoardDir(projectRoot, config);
  return new Promise<CommandResult>((resolve) => {
    startRepoDaemon({
      projectRoot,
      config,
      boardDir,
      platform: deps.platform,
      run: deps.run,
      runRaw: deps.runRaw,
      onShutdown: () => resolve({ lines: ['Daemon detenido por inactividad.'], exitCode: 0 }),
    }).catch((error: unknown) =>
      resolve({ lines: [`No se pudo iniciar el daemon: ${String(error)}`], exitCode: 1 }),
    );
  });
};
