import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { unwrap } from '../core/result.test-support.js';
import { createDefaultConfig } from './defaults.js';
import { ENV_KEYS, resolveBoardDir, sessionEnvEntries } from './env.js';

const PROJECT_ROOT = path.resolve('/repo/main');

describe('resolveBoardDir', () => {
  it('anchors the board dir at the project root as an absolute path', () => {
    const config = unwrap(
      createDefaultConfig({ projectName: 'Demo', stacks: ['node'], sessionCount: 1 }),
    );
    const boardDir = resolveBoardDir(PROJECT_ROOT, config);
    expect(path.isAbsolute(boardDir)).toBe(true);
    expect(boardDir).toBe(path.join(PROJECT_ROOT, '.review-board'));
  });
});

describe('sessionEnvEntries', () => {
  it('emits ordered entries with ports, api urls and a credential-free db url', () => {
    const config = unwrap(
      createDefaultConfig({
        projectName: 'Demo',
        stacks: ['node'],
        sessionCount: 2,
        db: { strategy: 'docker', service: 'db', user: 'app' },
      }),
    );
    const session = config.sessions[1]!;
    const entries = sessionEnvEntries(config, session, PROJECT_ROOT);
    expect(entries.map(([key]) => key)).toEqual([
      ENV_KEYS.session,
      ENV_KEYS.boardDir,
      ENV_KEYS.apiPort,
      ENV_KEYS.webPort,
      ENV_KEYS.metroPort,
      ENV_KEYS.apiUrlNext,
      ENV_KEYS.apiUrlExpo,
      ENV_KEYS.databaseUrl,
    ]);
    const env = Object.fromEntries(entries);
    expect(env[ENV_KEYS.session]).toBe('s2');
    expect(env[ENV_KEYS.boardDir]).toBe(path.join(PROJECT_ROOT, '.review-board'));
    expect(env[ENV_KEYS.apiPort]).toBe('3001');
    expect(env[ENV_KEYS.webPort]).toBe('3101');
    expect(env[ENV_KEYS.metroPort]).toBe('8082');
    expect(env[ENV_KEYS.apiUrlNext]).toBe('http://localhost:3001');
    expect(env[ENV_KEYS.apiUrlExpo]).toBe('http://localhost:3001');
    // Placeholder only — the real password is substituted from the runtime env.
    expect(env[ENV_KEYS.databaseUrl]).toBe(
      'postgresql://app:${RW_DB_PASSWORD}@localhost:5432/demo_s2',
    );
  });

  it('composes the db url without credentials when no user is set', () => {
    const config = unwrap(
      createDefaultConfig({
        projectName: 'Demo',
        stacks: ['node'],
        sessionCount: 1,
        db: { strategy: 'local' },
      }),
    );
    const entries = sessionEnvEntries(config, config.sessions[0]!, PROJECT_ROOT);
    const env = Object.fromEntries(entries);
    expect(env[ENV_KEYS.databaseUrl]).toBe('postgresql://localhost:5432/demo_s1');
  });

  it('emits only session and board entries for a session without ports or db', () => {
    const config = unwrap(
      createDefaultConfig({ projectName: 'Ledger', stacks: ['dotnet'], sessionCount: 1 }),
    );
    const entries = sessionEnvEntries(config, config.sessions[0]!, PROJECT_ROOT);
    expect(entries.map(([key]) => key)).toEqual([ENV_KEYS.session, ENV_KEYS.boardDir]);
  });
});
