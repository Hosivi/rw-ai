import fs from 'node:fs';
import path from 'node:path';
import { claimsFilePath } from '../engine/identity.js';
import type { Timers } from './server.js';

const defaultTimers: Timers = {
  set: (cb, ms) => setTimeout(cb, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export type Debouncer = {
  (): void;
  readonly cancel: () => void;
};

// Coalesce a burst of change events into a single trailing call, so a save that
// touches several files (or a rapid sequence) triggers exactly one recompute.
export const createDebouncer = (
  fn: () => void,
  ms: number,
  timers: Timers = defaultTimers,
): Debouncer => {
  let handle: unknown = null;
  const debounced = (): void => {
    if (handle !== null) timers.clear(handle);
    handle = timers.set(() => {
      handle = null;
      fn();
    }, ms);
  };
  debounced.cancel = (): void => {
    if (handle !== null) {
      timers.clear(handle);
      handle = null;
    }
  };
  return debounced;
};

export type WatchDeps = {
  readonly boardDir: string;
  // fs events cover claims.json + sessions/<id>/status.json; the poll is the
  // safety net for git state (dirty/ahead), which changes with no board-file event.
  readonly pollMs: number;
  readonly debounceMs: number;
};

// Production change source for the daemon: fs.watch on the board's claims file and
// sessions dir, plus a periodic git-poll, all funneled through one debouncer.
// Returns an unsubscribe that tears everything down. Best-effort: a missing dir
// (board not provisioned yet) never throws — the poll still drives recomputes.
export const watchRepoSignals = (deps: WatchDeps, onChange: () => void): (() => void) => {
  const debounced = createDebouncer(onChange, deps.debounceMs);
  const watchers: fs.FSWatcher[] = [];

  const tryWatch = (target: string, options?: { recursive?: boolean }): void => {
    try {
      watchers.push(fs.watch(target, options ?? {}, () => debounced()));
    } catch {
      // Target not present yet; the poll covers us until it exists.
    }
  };

  tryWatch(claimsFilePath(deps.boardDir));
  tryWatch(path.join(deps.boardDir, 'sessions'), { recursive: true });

  const poll = setInterval(() => debounced(), deps.pollMs);

  return () => {
    debounced.cancel();
    clearInterval(poll);
    for (const watcher of watchers) {
      try {
        watcher.close();
      } catch {
        // already closed
      }
    }
  };
};
