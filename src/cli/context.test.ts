import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { writeAgentsConfig } from '../engine/config-io.js';
import type { CommandRunner } from '../engine/exec.js';
import { normalizeRepoPath } from '../engine/git.js';
import { buildConfig, createTempRepo } from '../engine/git.test-support.js';
import { err } from '../core/result.js';
import { unwrap, unwrapErr } from '../core/result.test-support.js';
import { loadContext } from './context.js';

// A runner that fails `git rev-parse --show-toplevel` exactly as git does
// outside a repository. Injected instead of relying on a temp dir being outside
// a repo — os.tmpdir() is itself inside a repo on some dev machines.
const gitNotARepo: CommandRunner = async () =>
  err({ kind: 'non-zero-exit', output: { stdout: '', stderr: 'fatal: not a git repository', exitCode: 128 } });

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()?.();
  }
});

describe('loadContext', () => {
  it('loads projectRoot, config, and a git bound to the repo root', async () => {
    const repo = await createTempRepo();
    cleanups.push(repo.cleanup);
    const config = buildConfig();
    unwrap(await writeAgentsConfig(repo.root, config));

    const context = unwrap(await loadContext(repo.root));

    expect(context.projectRoot).toBe(normalizeRepoPath(repo.root));
    expect(context.config).toEqual(config);
    // git is bound to the repo root: its toplevel resolves back to projectRoot.
    expect(unwrap(await context.git.toplevel())).toBe(normalizeRepoPath(repo.root));
  });

  it('resolves the repo root even when called from a subdirectory', async () => {
    const repo = await createTempRepo();
    cleanups.push(repo.cleanup);
    unwrap(await writeAgentsConfig(repo.root, buildConfig()));
    const nested = path.join(repo.root, 'packages', 'app');
    await fs.mkdir(nested, { recursive: true });

    const context = unwrap(await loadContext(nested));

    expect(context.projectRoot).toBe(normalizeRepoPath(repo.root));
  });

  it('reports config-not-found inside a repo with no agents.config.json', async () => {
    const repo = await createTempRepo();
    cleanups.push(repo.cleanup);

    expect(unwrapErr(await loadContext(repo.root)).kind).toBe('config-not-found');
  });

  it('reports config-invalid with issues for a schema violation', async () => {
    const repo = await createTempRepo();
    cleanups.push(repo.cleanup);
    await fs.writeFile(
      path.join(repo.root, 'agents.config.json'),
      JSON.stringify({ version: 1 }),
      'utf8',
    );

    const error = unwrapErr(await loadContext(repo.root));
    expect(error.kind).toBe('config-invalid');
    expect(error.issues?.length ?? 0).toBeGreaterThan(0);
  });

  it('reports not-a-repo when cwd is not inside a git repository', async () => {
    expect(unwrapErr(await loadContext('/anywhere', gitNotARepo)).kind).toBe('not-a-repo');
  });
});
