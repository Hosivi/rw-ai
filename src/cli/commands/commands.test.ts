import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ENV_KEYS } from '../../contract/env.js';
import { err } from '../../core/result.js';
import { writeAgentsConfig } from '../../engine/config-io.js';
import type { CommandRunner } from '../../engine/exec.js';
import { buildConfig, createTempRepo, type TempRepo } from '../../engine/git.test-support.js';
import type { CliDeps } from '../command.js';
import { runCheck } from './check.js';
import { runConfigure } from './configure.js';
import { runClaim, runInit, runRelease, runRoles, runWhoami } from './identity.js';
import { runAddSession, runArchive } from './sessions.js';

// Fixed instant so any generated artifact stays deterministic across runs.
const NOW = new Date('2026-07-02T12:00:00.000Z');
const TTL_MS = 28_800_000;

// Non-interactive by default: the interactive picker is never driven with real
// keypresses — the split is exercised through deps.interactive alone.
const deps = (repo: TempRepo, env: Record<string, string | undefined> = {}): CliDeps => ({
  cwd: repo.root,
  homeDir: repo.root,
  env,
  now: NOW,
  interactive: false,
});

describe('command handlers (integration)', () => {
  let repo: TempRepo;

  beforeAll(async () => {
    repo = await createTempRepo();
    // node stack, db strategy none, 2 sessions (s1, s2).
    await writeAgentsConfig(repo.root, buildConfig());
    // Provision the board and branches so identity/check have real state to read.
    const configured = await runConfigure(deps(repo));
    expect(configured.exitCode).toBe(0);
    expect(configured.lines.join('\n')).toContain('Configuración completa');
  }, 60000);

  afterAll(async () => {
    await repo.cleanup();
  });

  it('wires each command to its engine end to end', async () => {
    // roles → lists s1, s2 and integrator.
    const roles = await runRoles(deps(repo));
    expect(roles.exitCode).toBe(0);
    expect(roles.lines.join('\n')).toMatch(/s1[\s\S]*s2[\s\S]*integrator/);

    // init --role s1 → claims and prints the two export lines.
    const init = await runInit({ role: 's1', ttlMs: TTL_MS }, deps(repo));
    expect(init.exitCode).toBe(0);
    expect(init.lines.join('\n')).toContain(`export ${ENV_KEYS.session}=s1`);
    const tokenLine = init.lines.find((line) => line.startsWith(`export ${ENV_KEYS.token}=`));
    expect(tokenLine).toBeDefined();
    const token = tokenLine!.slice(`export ${ENV_KEYS.token}=`.length);
    expect(token.length).toBeGreaterThan(0);

    // whoami reads RW_TOKEN back from the env → resolves s1.
    const who = await runWhoami(deps(repo, { [ENV_KEYS.token]: token }));
    expect(who.exitCode).toBe(0);
    expect(who.lines.join('\n')).toContain('s1');

    // release frees s1 for that token.
    const released = await runRelease({}, deps(repo, { [ENV_KEYS.token]: token }));
    expect(released.exitCode).toBe(0);
    expect(released.lines.join('\n')).toContain('s1');

    // claim s2 non-interactively (role is a required positional).
    const claim = await runClaim({ role: 's2', ttlMs: TTL_MS }, deps(repo));
    expect(claim.exitCode).toBe(0);
    expect(claim.lines.join('\n')).toContain(`export ${ENV_KEYS.session}=s2`);

    // check → analyzes the real branches; no divergence yet, so it is not a gate.
    const check = await runCheck(deps(repo));
    expect(check.exitCode).toBe(0);
    expect(check.lines.join('\n')).toContain('Sesiones analizadas: 2');

    // add-session → appends s3.
    const added = await runAddSession({}, deps(repo));
    expect(added.exitCode).toBe(0);
    expect(added.lines.join('\n')).toContain('s3');

    // archive s1 → flips it to archived.
    const archived = await runArchive({ id: 's1' }, deps(repo));
    expect(archived.exitCode).toBe(0);
    expect(archived.lines.join('\n')).toContain('s1');
  }, 60000);

  it('rejects init with no --role in a non-interactive shell (exit 2)', async () => {
    const result = await runInit({ ttlMs: TTL_MS }, deps(repo));
    expect(result.exitCode).toBe(2);
    expect(result.lines.join('\n')).toContain('--role');
  }, 30000);

  it('claim with a missing role is a usage error (exit 2)', async () => {
    const result = await runClaim({ ttlMs: TTL_MS }, deps(repo));
    expect(result.exitCode).toBe(2);
    expect(result.lines.join('\n')).toContain('rw claim');
  });

  it('whoami without RW_TOKEN in the env exits 1', async () => {
    const result = await runWhoami(deps(repo));
    expect(result.exitCode).toBe(1);
    expect(result.lines.join('\n')).toContain('RW_TOKEN');
  });

  it('archive with a missing id is a usage error (exit 2)', async () => {
    const result = await runArchive({}, deps(repo));
    expect(result.exitCode).toBe(2);
    expect(result.lines.join('\n')).toContain('rw archive');
  });
});

describe('command handlers (context failures)', () => {
  // git rev-parse fails as it would outside any repo, so loadContext returns
  // not-a-repo without touching the real filesystem.
  const gitNotARepo: CommandRunner = async () =>
    err({ kind: 'non-zero-exit', output: { stdout: '', stderr: 'fatal', exitCode: 128 } });

  const brokenDeps: CliDeps = {
    cwd: '/anywhere',
    homeDir: '/anywhere',
    env: {},
    now: NOW,
    run: gitNotARepo,
    runRaw: gitNotARepo,
  };

  it('maps a not-a-repo context error to exit 1 with a Spanish message', async () => {
    const result = await runRoles(brokenDeps);
    expect(result.exitCode).toBe(1);
    expect(result.lines.join('\n').toLowerCase()).toContain('git');
  });
});
