import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { normalizeRepoPath } from '../engine/git.js';

// One daemon per repo. The address is derived purely from the repo root, so any
// client that resolves the same repo lands on the same daemon. normalizeRepoPath
// first (lowercased drive, forward slashes) so E:\repo and e:/repo/ collide by
// design instead of spawning two daemons for one repo.
const repoHash = (repoRoot: string): string =>
  createHash('sha256').update(normalizeRepoPath(repoRoot)).digest('hex').slice(0, 16);

// Windows named pipes live in a global namespace (\\.\pipe\...), so tmpDir is
// unused there; on Unix the socket is a real file under the runtime dir (short
// hash keeps it well under the ~104-char sun_path limit).
export const daemonAddress = (
  repoRoot: string,
  platform: NodeJS.Platform,
  tmpDir: string = os.tmpdir(),
): string => {
  const hash = repoHash(repoRoot);
  // path.posix.join, not path.join: a unix socket path must use '/' even when this
  // code runs on a Windows host (e.g. a cross-platform unit test).
  return platform === 'win32'
    ? `\\\\.\\pipe\\rw-ai-${hash}`
    : path.posix.join(tmpDir, `rw-ai-${hash}.sock`);
};
