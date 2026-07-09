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
//
// `rw daemon --address`: print the daemon's pipe/socket address for this repo and
// exit, WITHOUT starting it. The Neovim plugin uses this so it never has to
// re-derive the sha256 address in Lua (one source of truth).
export const runDaemon = async (
  args: { readonly printAddress: boolean },
  deps: CliDeps,
): Promise<CommandResult> => {
  const context = await loadContext(deps.cwd, deps.run, deps.runRaw);
  if (!context.ok) {
    return contextErrorResult(context.error);
  }
  const { projectRoot, config } = context.value;
  const address = daemonAddress(projectRoot, deps.platform);

  if (args.printAddress) {
    return { lines: [address], exitCode: 0 };
  }

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
