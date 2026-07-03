import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createSession, MAX_SESSION_INDEX } from '../contract/defaults.js';
import { resolveBoardDir } from '../contract/env.js';
import type { AgentsConfig } from '../contract/schema.js';
import { err, ok } from '../core/result.js';
import { unwrap, unwrapErr } from '../core/result.test-support.js';
import { addSession, archiveSession, configure } from './configure.js';
import type { RunbookResult, RunbookStep } from './configure.js';
import { readAgentsConfig, writeAgentsConfig } from './config-io.js';
import type { CommandRunner } from './exec.js';
import { runCommand } from './exec.js';
import {
  buildConfig,
  createTempRepo,
  removeDirRobust,
  runGitOrThrow,
  type TempRepo,
} from './git.test-support.js';
import { claimRole, readClaims, writeClaims } from './identity.js';
import { activeSessions } from './sessions.js';

// A fixed instant keeps every generated file (board.md, test-wiring.md) byte-
// identical across two runs, so idempotency shows up as 'unchanged' not 'updated'.
const NOW = new Date('2026-07-02T12:00:00.000Z');

const step = (result: RunbookResult, name: string): RunbookStep => {
  const found = result.steps.find((entry) => entry.name === name);
  if (found === undefined) {
    throw new Error(`missing step '${name}'`);
  }
  return found;
};

describe('configure orchestrator (integration)', () => {
  let repo: TempRepo;

  beforeEach(async () => {
    repo = await createTempRepo();
  });

  afterEach(async () => {
    await repo.cleanup();
  });

  const listBranches = async (): Promise<string[]> => {
    const result = unwrap(
      await runCommand('git', ['branch', '--format=%(refname:short)'], { cwd: repo.root }),
    );
    return result.stdout
      .split(/\r?\n/)
      .filter((line) => line.length > 0)
      .sort();
  };

  it('provisions the repo on the first run and reports unchanged on the second', async () => {
    const config = buildConfig(); // node stack, db strategy none, 2 sessions
    unwrap(await writeAgentsConfig(repo.root, config));

    const first = await configure(config, repo.root, { now: NOW });
    expect(first.ok).toBe(true);
    expect(first.steps.every((entry) => entry.status !== 'failed')).toBe(true);
    expect(step(first, 'preflight-git').status).toBe('ok');
    expect(step(first, 'integration-branch').detail).toContain('created');
    expect(step(first, 'session-branches').detail).toContain('created');
    expect(step(first, 'worktrees').detail).toContain('created');
    expect(step(first, 'board').detail).toContain('created');

    const boardDir = resolveBoardDir(repo.root, config);
    expect(existsSync(path.join(boardDir, 'board.md'))).toBe(true);
    expect(existsSync(path.join(boardDir, 'claims.json'))).toBe(true);
    expect(existsSync(path.join(boardDir, 'branches.mmd'))).toBe(true);
    expect(existsSync(path.join(boardDir, 'reports', 'test-wiring.md'))).toBe(true);
    for (const session of config.sessions) {
      expect(existsSync(path.join(repo.root, session.worktree, '.env.local'))).toBe(true);
    }

    const branchesBefore = await listBranches();
    expect(branchesBefore).toEqual(['develop', 'feat/s1-inicial', 'feat/s2-inicial', 'main']);

    const second = await configure(config, repo.root, { now: NOW });
    expect(second.ok).toBe(true);
    expect(step(second, 'integration-branch').detail).toContain('exists');
    expect(step(second, 'session-branches').detail).toContain('exist');
    expect(step(second, 'worktrees').detail).toContain('exist');
    expect(step(second, 'board').detail).toContain('exist');
    expect(step(second, 'board-md').detail).toContain('unchanged');
    expect(step(second, 'branch-graph').detail).toContain('unchanged');
    expect(step(second, 'env-files').detail).toContain('unchanged');
    expect(step(second, 'test-wiring').detail).toContain('unchanged');

    // Nothing destructive: the branch set is identical and every artifact survives.
    expect(await listBranches()).toEqual(branchesBefore);
    expect(existsSync(path.join(boardDir, 'board.md'))).toBe(true);
    expect(existsSync(path.join(boardDir, 'claims.json'))).toBe(true);
    for (const session of config.sessions) {
      expect(existsSync(path.join(repo.root, session.worktree, '.env.local'))).toBe(true);
    }
  }, 60000);

  it('hard-aborts and skips the remaining steps when a required step fails', async () => {
    // Base branch 'trunk' does not exist in the repo, so integration-branch fails.
    const config = buildConfig({ baseBranch: 'trunk' });

    const result = await configure(config, repo.root, { now: NOW });
    expect(result.ok).toBe(false);
    expect(step(result, 'preflight-git').status).toBe('ok');
    expect(step(result, 'integration-branch').status).toBe('failed');
    const skipped = [
      'session-branches',
      'worktrees',
      'worktree-deps',
      'databases',
      'env-files',
      'board',
      'board-md',
      'branch-graph',
      'test-wiring',
      'claims',
    ];
    for (const name of skipped) {
      expect(step(result, name).status).toBe('skipped');
    }
  }, 60000);

  it('soft-degrades the databases step on a runner failure but keeps going', async () => {
    const config = buildConfig({ db: { strategy: 'local' } });
    // Let real git through, but fail psql so per-session db creation degrades to
    // manual — a soft failure that must not fail the whole runbook.
    const run: CommandRunner = (command, args, opts) =>
      command === 'git'
        ? runCommand(command, args, opts)
        : Promise.resolve(err({ kind: 'spawn-failed', message: `${command} unavailable in test` }));

    const result = await configure(config, repo.root, { now: NOW, run });
    expect(result.ok).toBe(true);
    expect(step(result, 'databases').status).toBe('degraded');
    // Steps after the degraded one still ran.
    expect(step(result, 'env-files').status).toBe('ok');
    expect(step(result, 'board').status).toBe('ok');
    expect(step(result, 'claims').status).toBe('ok');
  }, 60000);

  it('preserves an existing claim across a rerun', async () => {
    const config = buildConfig();
    expect((await configure(config, repo.root, { now: NOW })).ok).toBe(true);

    const boardDir = resolveBoardDir(repo.root, config);
    const claims = unwrap(await readClaims(boardDir, config));
    unwrap(
      await writeClaims(boardDir, {
        version: 1,
        claims: {
          ...claims.claims,
          s1: {
            status: 'claimed',
            token: 'test-token-1234',
            claimedAt: NOW.toISOString(),
            expiresAt: new Date(NOW.getTime() + 3_600_000).toISOString(),
          },
        },
      }),
    );

    const rerun = await configure(config, repo.root, { now: NOW });
    expect(rerun.ok).toBe(true);
    const after = unwrap(await readClaims(boardDir, config));
    expect(after.claims.s1?.status).toBe('claimed');
  }, 60000);

  it('soft-degrades worktree-deps for a failing session without skipping later ones', async () => {
    // Commit a package.json so installWorktreeDeps actually spawns pnpm in each
    // worktree (otherwise it short-circuits on "no package.json").
    await fs.writeFile(path.join(repo.root, 'package.json'), '{"name":"demo"}\n');
    await runGitOrThrow(repo.root, ['add', 'package.json']);
    await runGitOrThrow(repo.root, ['commit', '-m', 'chore: add package.json']);
    const config = buildConfig({ sessionCount: 3 });

    const s2Worktree = path.join(repo.root, '.worktrees', 's2');
    const s3Worktree = path.join(repo.root, '.worktrees', 's3');
    const attempted: string[] = [];
    const run: CommandRunner = (command, args, opts) => {
      if (command === 'git') {
        return runCommand(command, args, opts);
      }
      if (command === 'pnpm') {
        attempted.push(opts.cwd);
        // Fail ONLY for s2; s1 and s3 succeed.
        return opts.cwd === s2Worktree
          ? Promise.resolve(err({ kind: 'spawn-failed', message: 'pnpm failed in s2' }))
          : Promise.resolve(ok({ stdout: '', stderr: '', exitCode: 0 }));
      }
      return Promise.resolve(ok({ stdout: '', stderr: '', exitCode: 0 }));
    };

    const result = await configure(config, repo.root, { now: NOW, run });
    // Soft failure: the runbook still succeeds overall.
    expect(result.ok).toBe(true);
    const deps = step(result, 'worktree-deps');
    expect(deps.status).toBe('degraded');
    expect(deps.detail).toContain('s2');
    // The failing session did NOT short-circuit the loop: s3 was still attempted.
    expect(attempted).toContain(s3Worktree);
  }, 60000);

  it("frees an archived session's claim so it is not stranded", async () => {
    const config = buildConfig();
    expect((await configure(config, repo.root, { now: NOW })).ok).toBe(true);
    const boardDir = resolveBoardDir(repo.root, config);
    unwrap(
      await claimRole({
        config,
        boardDir,
        role: 's1',
        token: 'test-token-1234',
        now: NOW,
        ttlMs: 3_600_000,
      }),
    );
    expect(unwrap(await readClaims(boardDir, config)).claims.s1?.status).toBe('claimed');

    const archived = unwrap(await archiveSession(config, repo.root, 's1', NOW));
    expect(activeSessions(archived).map((session) => session.id)).toEqual(['s2']);
    const after = unwrap(await readClaims(boardDir, archived));
    expect(after.claims.s1?.status).not.toBe('claimed');
  }, 60000);

  it('continues past a failed continue-on-fail step and marks the runbook not ok', async () => {
    const config = buildConfig();
    expect((await configure(config, repo.root, { now: NOW })).ok).toBe(true);
    const boardDir = resolveBoardDir(repo.root, config);
    // Replace test-wiring.md with a directory so its idempotent write fails (EISDIR).
    const wiringPath = path.join(boardDir, 'reports', 'test-wiring.md');
    await fs.rm(wiringPath, { force: true });
    await fs.mkdir(wiringPath, { recursive: true });

    const result = await configure(config, repo.root, { now: NOW });
    expect(result.ok).toBe(false);
    expect(step(result, 'test-wiring').status).toBe('failed');
    // A CONTINUE-ON-FAIL failure never skips later steps.
    expect(step(result, 'claims').status).toBe('ok');
    expect(result.steps.some((entry) => entry.status === 'skipped')).toBe(false);
  }, 60000);

  it('hard-aborts on an unsupported git version and skips every later step', async () => {
    const config = buildConfig();
    // git 2.20 predates merge-tree (needs >= 2.38), so preflight must fail.
    const run: CommandRunner = (command, args, opts) =>
      command === 'git' && args[0] === '--version'
        ? Promise.resolve(ok({ stdout: 'git version 2.20.0\n', stderr: '', exitCode: 0 }))
        : runCommand(command, args, opts);

    const result = await configure(config, repo.root, { now: NOW, run });
    expect(result.ok).toBe(false);
    expect(step(result, 'preflight-git').status).toBe('failed');
    const afterPreflight = [
      'integration-branch',
      'session-branches',
      'worktrees',
      'worktree-deps',
      'databases',
      'env-files',
      'board',
      'board-md',
      'branch-graph',
      'test-wiring',
      'claims',
    ];
    for (const name of afterPreflight) {
      expect(step(result, name).status).toBe('skipped');
    }
  }, 60000);

  it('hard-aborts when session-branches fails and skips the rest', async () => {
    const config = buildConfig();
    // Fail creation of any session (feat/*) branch, but let integration succeed.
    const run: CommandRunner = (command, args, opts) =>
      command === 'git' && args[0] === 'branch' && args[1]?.startsWith('feat/')
        ? Promise.resolve(err({ kind: 'spawn-failed', message: 'cannot create session branch' }))
        : runCommand(command, args, opts);

    const result = await configure(config, repo.root, { now: NOW, run });
    expect(result.ok).toBe(false);
    expect(step(result, 'integration-branch').status).toBe('ok');
    expect(step(result, 'session-branches').status).toBe('failed');
    for (const name of ['worktrees', 'worktree-deps', 'databases', 'env-files', 'claims']) {
      expect(step(result, name).status).toBe('skipped');
    }
  }, 60000);

  it('hard-aborts when worktree creation fails and skips the rest', async () => {
    const config = buildConfig();
    const run: CommandRunner = (command, args, opts) =>
      command === 'git' && args[0] === 'worktree' && args[1] === 'add'
        ? Promise.resolve(err({ kind: 'spawn-failed', message: 'cannot add worktree' }))
        : runCommand(command, args, opts);

    const result = await configure(config, repo.root, { now: NOW, run });
    expect(result.ok).toBe(false);
    expect(step(result, 'session-branches').status).toBe('ok');
    expect(step(result, 'worktrees').status).toBe('failed');
    for (const name of ['worktree-deps', 'databases', 'env-files', 'board', 'claims']) {
      expect(step(result, name).status).toBe('skipped');
    }
  }, 60000);
});

describe('addSession', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rw-ai-add-'));
  });

  afterEach(() => removeDirRobust(dir));

  it('appends the next session with node ports and persists a re-parseable config', async () => {
    const config = buildConfig(); // s1, s2, node stack, db none
    const result = unwrap(await addSession(config, dir, {}));

    expect(result.session.id).toBe('s3');
    expect(result.session.ports).toEqual({ api: 3002, web: 3102, metro: 8083 });
    expect(result.session.db).toBeUndefined();
    expect(result.config.sessions).toHaveLength(3);

    const reread = unwrap(await readAgentsConfig(dir));
    expect(reread.sessions.map((session) => session.id)).toEqual(['s1', 's2', 's3']);
  });

  it('derives a db name for the new session when a db strategy is active', async () => {
    const config = buildConfig({ db: { strategy: 'local' } });
    const result = unwrap(await addSession(config, dir, {}));
    expect(result.session.db).toEqual({ name: 'demo_s3' });
  });

  it('computes the next index from the max id, not the session count', async () => {
    const base = buildConfig({ sessionCount: 1 });
    const s1 = unwrap(
      createSession({ index: 1, projectName: 'demo', withPorts: true, withDb: false }),
    );
    const s3 = unwrap(
      createSession({ index: 3, projectName: 'demo', withPorts: true, withDb: false }),
    );
    const config: AgentsConfig = { ...base, sessions: [s1, s3] };

    const result = unwrap(await addSession(config, dir, {}));
    expect(result.session.id).toBe('s4');
  });

  it('rejects a branch override that collides with an existing branch, before writing', async () => {
    const config = buildConfig(); // s1 -> feat/s1-inicial
    const error = unwrapErr(await addSession(config, dir, { branch: 'feat/s1-inicial' }));
    expect(error.kind).toBe('invalid-config');
    // Nothing was persisted.
    expect(existsSync(path.join(dir, 'agents.config.json'))).toBe(false);
  });

  it('succeeds when the new session lands exactly on MAX_SESSION_INDEX', async () => {
    const base = buildConfig({ sessionCount: 1 });
    const top = unwrap(
      createSession({
        index: MAX_SESSION_INDEX - 1,
        projectName: 'demo',
        withPorts: true,
        withDb: false,
      }),
    );
    const config: AgentsConfig = { ...base, sessions: [top] };

    const result = unwrap(await addSession(config, dir, {}));
    expect(result.session.id).toBe(`s${MAX_SESSION_INDEX}`);
  });

  it('rejects with max-sessions at the ceiling', async () => {
    const base = buildConfig({ sessionCount: 1 });
    const top = unwrap(
      createSession({
        index: MAX_SESSION_INDEX,
        projectName: 'demo',
        withPorts: true,
        withDb: false,
      }),
    );
    const config: AgentsConfig = { ...base, sessions: [top] };

    const error = unwrapErr(await addSession(config, dir, {}));
    expect(error.kind).toBe('max-sessions');
  });
});

describe('archiveSession', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rw-ai-archive-'));
  });

  afterEach(() => removeDirRobust(dir));

  it('flips status to archived, persists, and excludes it from active sessions', async () => {
    const config = buildConfig(); // s1, s2 active
    const result = unwrap(await archiveSession(config, dir, 's1', NOW));

    expect(result.sessions.find((session) => session.id === 's1')?.status).toBe('archived');
    expect(activeSessions(result).map((session) => session.id)).toEqual(['s2']);

    const reread = unwrap(await readAgentsConfig(dir));
    expect(reread.sessions.find((session) => session.id === 's1')?.status).toBe('archived');
  });

  it('errors when the session does not exist', async () => {
    const config = buildConfig();
    const error = unwrapErr(await archiveSession(config, dir, 's9', NOW));
    expect(error.kind).toBe('session-not-found');
  });

  it('errors when the session is already archived', async () => {
    const config = buildConfig();
    const archived = unwrap(await archiveSession(config, dir, 's1', NOW));
    const error = unwrapErr(await archiveSession(archived, dir, 's1', NOW));
    expect(error.kind).toBe('already-archived');
  });
});
