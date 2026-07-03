import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// package.json lives at the repo root, two levels above this module in BOTH
// layouts: src/cli/version.ts (vitest) and dist/cli/version.js (published bin).
// Resolving it from import.meta.url keeps `rw --version` correct from either,
// without importing JSON (which tsc rejects for a file outside rootDir).
const PACKAGE_JSON_URL = new URL('../../package.json', import.meta.url);

let cached: string | undefined;

// Read once and memoize: the version never changes within a process, and a
// failure (missing/corrupt package.json) degrades to a marker rather than
// crashing the CLI over a cosmetic flag.
export const readVersion = (): string => {
  if (cached !== undefined) {
    return cached;
  }
  try {
    const raw = readFileSync(fileURLToPath(PACKAGE_JSON_URL), 'utf8');
    const parsed = JSON.parse(raw) as { version?: unknown };
    cached = typeof parsed.version === 'string' ? parsed.version : 'desconocida';
  } catch {
    cached = 'desconocida';
  }
  return cached;
};
