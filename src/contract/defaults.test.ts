import { describe, expect, it } from 'vitest';
import { unwrap } from '../core/result.test-support.js';
import {
  appendNextSession,
  createDefaultConfig,
  createEmptyClaims,
  createSession,
  defaultSessionBranch,
  isClaimExpired,
  nextSessionIndex,
  PORT_BANDS,
  sessionDbName,
  sessionPorts,
} from './defaults.js';
import type { Claim } from './schema.js';

describe('sessionPorts', () => {
  it('starts each band at its base for s1', () => {
    expect(unwrap(sessionPorts(1))).toEqual({ api: 3000, web: 3100, metro: 8081 });
  });

  it('offsets by index - 1 for s3', () => {
    expect(unwrap(sessionPorts(3))).toEqual({ api: 3002, web: 3102, metro: 8083 });
  });

  it('rejects index 100 to keep the api band clear of the web band', () => {
    const result = sessionPorts(100);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain(String(PORT_BANDS.web));
    }
  });

  it.each([0, -1, 1.5])('rejects invalid index %j', (index) => {
    expect(sessionPorts(index).ok).toBe(false);
  });
});

describe('sessionDbName', () => {
  it('sanitizes to a snake_case postgres identifier', () => {
    expect(sessionDbName('My App!', 2)).toBe('my_app_s2');
  });

  it('collapses repeated separators', () => {
    expect(sessionDbName('a - -b', 1)).toBe('a_b_s1');
  });

  it('never starts with a digit', () => {
    expect(sessionDbName('1shop', 1)).toBe('_1shop_s1');
  });

  it('falls back when nothing survives sanitization', () => {
    expect(sessionDbName('!!!', 1)).toBe('project_s1');
  });

  it('keeps the name within the 63-char postgres limit', () => {
    expect(sessionDbName('x'.repeat(100), 12).length).toBeLessThanOrEqual(63);
  });
});

describe('defaultSessionBranch', () => {
  it('builds the initial feature branch name', () => {
    expect(defaultSessionBranch(3)).toBe('feat/s3-inicial');
  });
});

describe('createSession', () => {
  it('includes ports and db only when the flags ask for them', () => {
    const full = unwrap(
      createSession({ index: 2, projectName: 'Demo', withDb: true, withPorts: true }),
    );
    expect(full).toMatchObject({
      id: 's2',
      branch: 'feat/s2-inicial',
      worktree: '.worktrees/s2',
      status: 'active',
      ports: { api: 3001, web: 3101, metro: 8082 },
      db: { name: 'demo_s2' },
    });

    const bare = unwrap(
      createSession({ index: 2, projectName: 'Demo', withDb: false, withPorts: false }),
    );
    expect(bare.ports).toBeUndefined();
    expect(bare.db).toBeUndefined();
  });

  it('propagates the port band error above index 99', () => {
    expect(
      createSession({ index: 100, projectName: 'Demo', withDb: false, withPorts: true }).ok,
    ).toBe(false);
  });
});

describe('createDefaultConfig', () => {
  it('produces a schema-valid config for N=3 node sessions with docker db', () => {
    const config = unwrap(
      createDefaultConfig({
        projectName: 'My App!',
        stacks: ['node'],
        sessionCount: 3,
        db: { strategy: 'docker', service: 'db' },
      }),
    );
    expect(config.sessions).toHaveLength(3);
    expect(config.sessions[2]).toMatchObject({
      id: 's3',
      ports: { api: 3002, web: 3102, metro: 8083 },
      db: { name: 'my_app_s3' },
    });
    expect(config.git.baseBranch).toBe('main');
    expect(config.db.strategy).toBe('docker');
  });

  it('omits ports and db for a non-node stack without db strategy', () => {
    const config = unwrap(
      createDefaultConfig({ projectName: 'Ledger', stacks: ['dotnet'], sessionCount: 2 }),
    );
    expect(config.sessions.every((s) => s.ports === undefined && s.db === undefined)).toBe(true);
    expect(config.db.strategy).toBe('none');
  });

  it('rejects a non-positive session count', () => {
    expect(
      createDefaultConfig({ projectName: 'Demo', stacks: ['node'], sessionCount: 0 }).ok,
    ).toBe(false);
  });
});

describe('nextSessionIndex', () => {
  it('starts at 1 when no sessions exist', () => {
    expect(unwrap(nextSessionIndex([]))).toBe(1);
  });

  it('uses the next number after the highest existing session id', () => {
    expect(unwrap(nextSessionIndex([{ id: 's1' }, { id: 's3' }]))).toBe(4);
  });

  it('rejects an invalid existing session id', () => {
    expect(nextSessionIndex([{ id: 'worker-1' }]).ok).toBe(false);
  });
});

describe('appendNextSession', () => {
  it('appends the next schema-valid node session without filesystem side effects', () => {
    const config = unwrap(
      createDefaultConfig({
        projectName: 'Demo',
        stacks: ['node'],
        sessionCount: 2,
        db: { strategy: 'docker', service: 'db' },
        worktreesDir: '.rw/worktrees',
      }),
    );
    const nextConfig = unwrap(appendNextSession({ config, areas: ['packages/api/**'] }));
    expect(nextConfig.sessions).toHaveLength(3);
    expect(nextConfig.sessions[2]).toMatchObject({
      id: 's3',
      branch: 'feat/s3-inicial',
      worktree: '.rw/worktrees/s3',
      areas: ['packages/api/**'],
      ports: { api: 3002, web: 3102, metro: 8083 },
      db: { name: 'demo_s3' },
    });
  });

  it('preserves a caller-provided branch for the new session', () => {
    const config = unwrap(
      createDefaultConfig({ projectName: 'Ledger', stacks: ['dotnet'], sessionCount: 1 }),
    );
    const nextConfig = unwrap(appendNextSession({ config, branch: 'feat/custom-session' }));
    expect(nextConfig.sessions[1]).toMatchObject({
      id: 's2',
      branch: 'feat/custom-session',
    });
  });

  it('propagates invalid existing session ids when choosing the next id', () => {
    const config = unwrap(
      createDefaultConfig({ projectName: 'Ledger', stacks: ['dotnet'], sessionCount: 1 }),
    );
    const result = appendNextSession({
      config: { ...config, sessions: [{ ...config.sessions[0]!, id: 'worker-1' }] },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain('session id must match s<N>');
    }
  });

  it('fails deterministically when a node config would append s100 past the port-band cap', () => {
    const config = unwrap(
      createDefaultConfig({ projectName: 'Demo', stacks: ['node'], sessionCount: 99 }),
    );
    const result = appendNextSession({ config });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain('session index 100 exceeds 99');
      expect(result.error.message).toContain(String(PORT_BANDS.web));
    }
  });
});

describe('createEmptyClaims', () => {
  it('creates a free claim for every session plus the integrator', () => {
    const config = unwrap(
      createDefaultConfig({ projectName: 'Demo', stacks: ['node'], sessionCount: 3 }),
    );
    const claims = createEmptyClaims(config);
    expect(claims.version).toBe(1);
    expect(Object.keys(claims.claims).sort()).toEqual(['integrator', 's1', 's2', 's3']);
    expect(Object.values(claims.claims).every((claim) => claim.status === 'free')).toBe(true);
  });
});

describe('isClaimExpired', () => {
  const claimAt = (expiresAt: string): Claim => ({
    status: 'claimed',
    token: 'abcdef1234',
    claimedAt: '2026-07-02T10:00:00.000Z',
    expiresAt,
  });

  it('is expired exactly at the boundary (now >= expiresAt)', () => {
    const now = new Date('2026-07-02T11:00:00.000Z');
    expect(isClaimExpired(claimAt('2026-07-02T11:00:00.000Z'), now)).toBe(true);
  });

  it('is not expired one millisecond before the boundary', () => {
    const now = new Date('2026-07-02T10:59:59.999Z');
    expect(isClaimExpired(claimAt('2026-07-02T11:00:00.000Z'), now)).toBe(false);
  });

  it('is expired after the boundary', () => {
    const now = new Date('2026-07-02T12:00:00.000Z');
    expect(isClaimExpired(claimAt('2026-07-02T11:00:00.000Z'), now)).toBe(true);
  });

  it('a free claim is never expired', () => {
    expect(isClaimExpired({ status: 'free' }, new Date())).toBe(false);
  });
});
