import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { err, ok, type Result } from '../core/result.js';
import { unwrap, unwrapErr } from '../core/result.test-support.js';
import { detectDbSetup, ensureSessionDatabases } from './database.js';
import type { CommandError, CommandOutput, CommandRunner } from './exec.js';
import { buildConfig, removeDirRobust } from './git.test-support.js';

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rw-ai-db-'));
});

afterEach(() => removeDirRobust(dir));

const write = (name: string, content: string): Promise<void> =>
  fs.writeFile(path.join(dir, name), content, 'utf8');

describe('detectDbSetup', () => {
  it('detects a compose postgres service with map-form environment and a custom host port', async () => {
    await write(
      'docker-compose.yml',
      [
        'services:',
        '  db:',
        '    image: postgres:16',
        '    ports:',
        '      - "5433:5432"',
        '    environment:',
        '      POSTGRES_USER: app',
        '      POSTGRES_PASSWORD: hunter2',
        '',
      ].join('\n'),
    );
    expect(unwrap(await detectDbSetup(dir))).toEqual({
      strategy: 'docker',
      service: 'db',
      host: 'localhost',
      port: 5433,
      user: 'app',
      sources: ['docker-compose.yml'],
    });
  });

  it('detects list-form environment and an ip-prefixed port mapping, skipping non-postgres services', async () => {
    await write(
      'compose.yaml',
      [
        'services:',
        '  cache:',
        '    image: redis:7',
        '  postgres:',
        '    image: postgres:16-alpine',
        '    ports:',
        '      - "127.0.0.1:6543:5432/tcp"',
        '    environment:',
        '      - POSTGRES_PASSWORD=x',
        '      - POSTGRES_USER=svc',
        '',
      ].join('\n'),
    );
    const detection = unwrap(await detectDbSetup(dir));
    expect(detection.strategy).toBe('docker');
    expect(detection.service).toBe('postgres');
    expect(detection.port).toBe(6543);
    expect(detection.user).toBe('svc');
    expect(detection.sources).toEqual(['compose.yaml']);
  });

  it('falls back to defaults when the postgres service declares no ports or environment', async () => {
    await write('docker-compose.yml', 'services:\n  db:\n    image: postgres\n');
    const detection = unwrap(await detectDbSetup(dir));
    expect(detection.port).toBe(5432);
    expect(detection.user).toBe('postgres');
  });

  it('falls through a compose file without postgres to DATABASE_URL and never keeps the password', async () => {
    await write('docker-compose.yml', 'services:\n  app:\n    image: node:22\n');
    await write('.env', '# local dev\nDATABASE_URL=postgresql://dev:secret@localhost:5433/mydb\n');
    const detection = unwrap(await detectDbSetup(dir));
    expect(detection).toEqual({
      strategy: 'local',
      host: 'localhost',
      port: 5433,
      user: 'dev',
      sources: ['.env'],
    });
    expect(JSON.stringify(detection)).not.toContain('secret');
  });

  it('classifies a supabase host as the supabase strategy', async () => {
    await write(
      '.env.local',
      'DATABASE_URL="postgresql://postgres:pw@db.abcdefgh.supabase.co:5432/postgres"\n',
    );
    const detection = unwrap(await detectDbSetup(dir));
    expect(detection.strategy).toBe('supabase');
    expect(detection.host).toBe('db.abcdefgh.supabase.co');
    expect(detection.sources).toEqual(['.env.local']);
  });

  it('skips an unparseable compose file and keeps detecting', async () => {
    await write('docker-compose.yml', 'services: [');
    await write('.env', 'DATABASE_URL=postgresql://dev@localhost/mydb\n');
    const detection = unwrap(await detectDbSetup(dir));
    expect(detection.strategy).toBe('local');
    // No port in the URL: postgres default applies.
    expect(detection.port).toBe(5432);
    expect(detection.sources).toEqual(['.env']);
  });

  it('reports none when nothing points at a database', async () => {
    expect(unwrap(await detectDbSetup(dir))).toEqual({
      strategy: 'none',
      host: 'localhost',
      port: 5432,
      sources: [],
    });
  });
});

// --- ensureSessionDatabases (fake runners only — never real docker/psql) ----

type RecordedCall = { command: string; args: string[]; cwd: string };

const scriptedRunner = (
  script: Array<Result<CommandOutput, CommandError>>,
): { calls: RecordedCall[]; run: CommandRunner } => {
  const calls: RecordedCall[] = [];
  const run: CommandRunner = (command, args, opts) => {
    calls.push({ command, args: [...args], cwd: opts.cwd });
    const next = script.shift();
    if (next === undefined) {
      throw new Error(`unexpected command: ${command} ${args.join(' ')}`);
    }
    return Promise.resolve(next);
  };
  return { calls, run };
};

const okRun = (stdout: string): Result<CommandOutput, CommandError> =>
  ok({ stdout, stderr: '', exitCode: 0 });

const spawnFailed = (): Result<CommandOutput, CommandError> =>
  err({ kind: 'spawn-failed', message: "failed to spawn 'docker': EINVAL" });

const projectRoot = 'C:\\fake\\project-root';

const EXISTS_SQL_S1 = "SELECT 1 FROM pg_database WHERE datname='demo_s1'";
const CREATE_SQL_S1 = 'CREATE DATABASE "demo_s1"';

describe('ensureSessionDatabases', () => {
  it('reports exists without creating when the docker exists-check returns 1', async () => {
    const config = buildConfig({ db: { strategy: 'docker', service: 'db' } });
    const { calls, run } = scriptedRunner([okRun('1\n'), okRun('1\n')]);
    const results = unwrap(await ensureSessionDatabases(config, projectRoot, run));
    expect(results).toEqual([
      { sessionId: 's1', dbName: 'demo_s1', action: 'exists' },
      { sessionId: 's2', dbName: 'demo_s2', action: 'exists' },
    ]);
    expect(calls[0]).toEqual({
      command: 'docker',
      args: ['compose', 'exec', '-T', 'db', 'psql', '-U', 'postgres', '-tAc', EXISTS_SQL_S1],
      cwd: projectRoot,
    });
  });

  it('creates a missing database through docker compose', async () => {
    const config = buildConfig({ db: { strategy: 'docker', service: 'db' } });
    const { calls, run } = scriptedRunner([okRun(''), okRun('CREATE DATABASE\n'), okRun('1\n')]);
    const results = unwrap(await ensureSessionDatabases(config, projectRoot, run));
    expect(results).toEqual([
      { sessionId: 's1', dbName: 'demo_s1', action: 'created' },
      { sessionId: 's2', dbName: 'demo_s2', action: 'exists' },
    ]);
    expect(calls[1]).toEqual({
      command: 'docker',
      args: ['compose', 'exec', '-T', 'db', 'psql', '-U', 'postgres', '-c', CREATE_SQL_S1],
      cwd: projectRoot,
    });
  });

  it('degrades to manual with the exact fallback command when docker is down', async () => {
    const config = buildConfig({ db: { strategy: 'docker', service: 'db' } });
    const { calls, run } = scriptedRunner([spawnFailed(), spawnFailed()]);
    const results = unwrap(await ensureSessionDatabases(config, projectRoot, run));
    expect(results[0]).toEqual({
      sessionId: 's1',
      dbName: 'demo_s1',
      action: 'manual',
      fallbackCommand:
        'docker compose exec -T db psql -U postgres -c "CREATE DATABASE \\"demo_s1\\""',
      reason: "could not check database 'demo_s1': failed to spawn 'docker': EINVAL",
    });
    expect(results[1]?.action).toBe('manual');
    // Only the exists-checks ran; a create attempt would be pointless.
    expect(calls).toHaveLength(2);
  });

  it('degrades to manual when the create command itself fails', async () => {
    const config = buildConfig({ sessionCount: 1, db: { strategy: 'docker', service: 'db' } });
    const { run } = scriptedRunner([
      okRun(''),
      err({
        kind: 'non-zero-exit',
        output: { stdout: '', stderr: 'permission denied to create database', exitCode: 1 },
      }),
    ]);
    const results = unwrap(await ensureSessionDatabases(config, projectRoot, run));
    expect(results[0]?.action).toBe('manual');
    expect(results[0]?.fallbackCommand).toBe(
      'docker compose exec -T db psql -U postgres -c "CREATE DATABASE \\"demo_s1\\""',
    );
    expect(results[0]?.reason).toContain('permission denied');
  });

  it('runs psql directly for the local strategy', async () => {
    const config = buildConfig({ db: { strategy: 'local', user: 'dev', port: 5433 } });
    const { calls, run } = scriptedRunner([
      okRun(''),
      okRun('CREATE DATABASE\n'),
      okRun(''),
      okRun('CREATE DATABASE\n'),
    ]);
    const results = unwrap(await ensureSessionDatabases(config, projectRoot, run));
    expect(results.map((entry) => entry.action)).toEqual(['created', 'created']);
    expect(calls[0]).toEqual({
      command: 'psql',
      args: ['-h', 'localhost', '-p', '5433', '-U', 'dev', '-tAc', EXISTS_SQL_S1],
      cwd: projectRoot,
    });
    expect(calls[1]).toEqual({
      command: 'psql',
      args: ['-h', 'localhost', '-p', '5433', '-U', 'dev', '-c', CREATE_SQL_S1],
      cwd: projectRoot,
    });
  });

  it('rejects an invalid db name before any command runs', async () => {
    const config = buildConfig({ db: { strategy: 'local' } });
    const tampered = {
      ...config,
      sessions: config.sessions.map((session) =>
        session.id === 's1'
          ? { ...session, db: { name: 'demo"; DROP DATABASE postgres;--' } }
          : session,
      ),
    };
    const { calls, run } = scriptedRunner([]);
    const error = unwrapErr(await ensureSessionDatabases(tampered, projectRoot, run));
    expect(error.sessionId).toBe('s1');
    expect(error.message).toContain('invalid database name');
    expect(calls).toHaveLength(0);
  });

  it('skips every session when the strategy is none', async () => {
    const config = buildConfig();
    const { calls, run } = scriptedRunner([]);
    const results = unwrap(await ensureSessionDatabases(config, projectRoot, run));
    expect(results.map((entry) => entry.action)).toEqual(['skipped', 'skipped']);
    expect(results[0]?.reason).toBe('db strategy none');
    expect(calls).toHaveLength(0);
  });

  it('skips a session without a db block', async () => {
    const config = buildConfig({ db: { strategy: 'docker', service: 'db' } });
    const noDbOnS2 = {
      ...config,
      sessions: config.sessions.map((session) =>
        session.id === 's2' ? { ...session, db: undefined } : session,
      ),
    };
    const { run } = scriptedRunner([okRun('1\n')]);
    const results = unwrap(await ensureSessionDatabases(noDbOnS2, projectRoot, run));
    expect(results).toEqual([
      { sessionId: 's1', dbName: 'demo_s1', action: 'exists' },
      { sessionId: 's2', action: 'skipped', reason: 'session has no db name' },
    ]);
  });

  it('reports manual pointing at supabase branches for the supabase strategy', async () => {
    const config = buildConfig({ db: { strategy: 'supabase' } });
    const { calls, run } = scriptedRunner([]);
    const results = unwrap(await ensureSessionDatabases(config, projectRoot, run));
    expect(results.map((entry) => entry.action)).toEqual(['manual', 'manual']);
    expect(results[0]?.reason).toContain('Supabase branch');
    expect(calls).toHaveLength(0);
  });
});
