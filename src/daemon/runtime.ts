import type { AgentsConfig } from '../contract/schema.js';
import type { CommandRunner } from '../engine/exec.js';
import { collectSessionStates } from '../state/read.js';
import { daemonAddress } from './address.js';
import { startDaemon, type Daemon } from './server.js';
import { watchRepoSignals } from './watcher.js';

export type RepoDaemonDeps = {
  readonly projectRoot: string;
  readonly config: AgentsConfig;
  readonly boardDir: string;
  readonly platform: NodeJS.Platform;
  readonly idleTimeoutMs?: number;
  readonly pollMs?: number;
  readonly debounceMs?: number;
  readonly run?: CommandRunner;
  readonly runRaw?: CommandRunner;
  // Long-lived process → the clock must be read fresh each collect (claim expiry),
  // never captured once. Injectable for tests.
  readonly now?: () => Date;
  readonly onShutdown?: () => void;
};

const DEFAULT_IDLE_MS = 300_000; // 5 min: no client, no cost
const DEFAULT_POLL_MS = 2_000;
const DEFAULT_DEBOUNCE_MS = 150;

// Wire the generic daemon to this repo's real read model and file/git watchers.
export const startRepoDaemon = (deps: RepoDaemonDeps): Promise<Daemon> => {
  const clock = deps.now ?? (() => new Date());
  return startDaemon({
    address: daemonAddress(deps.projectRoot, deps.platform),
    collect: async () => {
      const result = await collectSessionStates({
        config: deps.config,
        projectRoot: deps.projectRoot,
        boardDir: deps.boardDir,
        now: clock(),
        run: deps.run,
        runRaw: deps.runRaw,
      });
      // A read failure (e.g. corrupt claims.json) yields an empty snapshot rather
      // than crashing the daemon; the user fixes the file and the next poll recovers.
      return result.ok ? result.value : [];
    },
    watch: (onChange) =>
      watchRepoSignals(
        {
          boardDir: deps.boardDir,
          pollMs: deps.pollMs ?? DEFAULT_POLL_MS,
          debounceMs: deps.debounceMs ?? DEFAULT_DEBOUNCE_MS,
        },
        onChange,
      ),
    idleTimeoutMs: deps.idleTimeoutMs ?? DEFAULT_IDLE_MS,
    ...(deps.onShutdown !== undefined ? { onShutdown: deps.onShutdown } : {}),
  });
};
