import fs from 'node:fs/promises';
import { err, ok, type Result } from '../core/result.js';

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export type AtomicWriteError = { readonly message: string; readonly cause: unknown };

// fs.rename can transiently fail on Windows while an AV scanner, indexer, or
// file watcher still holds a just-created file; a few short retries clear it
// (same spirit as removeDirRobust in git.test-support.ts).
const RENAME_RETRIES = 5;
const RENAME_RETRY_DELAY_MS = 100;
const TRANSIENT_RENAME_CODES = new Set(['EPERM', 'EBUSY', 'EACCES']);

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// Atomic replace: write a sibling temp file then rename it over the target, so a
// crash mid-write never leaves a half-written file. Same-dir temp keeps the
// rename a cheap same-filesystem move; hrtime.bigint (monotonic, not wall-clock)
// only makes the temp name unique and never reaches a Result.
export const writeFileAtomic = async (
  filePath: string,
  content: string,
): Promise<Result<void, AtomicWriteError>> => {
  const tmpPath = `${filePath}.${process.pid}.${process.hrtime.bigint()}.tmp`;
  try {
    await fs.writeFile(tmpPath, content, 'utf8');
  } catch (error) {
    return err({ message: `could not write temp file ${tmpPath}: ${errorMessage(error)}`, cause: error });
  }
  for (let attempt = 0; ; attempt += 1) {
    try {
      await fs.rename(tmpPath, filePath);
      return ok(undefined);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== undefined && TRANSIENT_RENAME_CODES.has(code) && attempt < RENAME_RETRIES) {
        await delay(RENAME_RETRY_DELAY_MS);
        continue;
      }
      // Best-effort cleanup so a failed rename does not leave temp files behind.
      await fs.rm(tmpPath, { force: true }).catch(() => undefined);
      return err({ message: `could not replace ${filePath}: ${errorMessage(error)}`, cause: error });
    }
  }
};
