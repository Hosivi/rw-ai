import { describe, expect, it } from 'vitest';
import { unwrap, unwrapErr } from '../core/result.test-support.js';
import { parseAgentsConfig, parseClaimsFile } from './schema.js';

const nodeConfig = () => ({
  version: 1,
  project: { name: 'Demo Shop', stacks: ['node'] },
  db: { strategy: 'docker', service: 'db' },
  sessions: [
    {
      id: 's1',
      branch: 'feat/s1-inicial',
      worktree: '.worktrees/s1',
      status: 'active',
      areas: ['apps/web/**'],
      ports: { api: 3000, web: 3100, metro: 8081 },
      db: { name: 'demo_shop_s1' },
      platforms: {
        web: { enabled: true, e2e: { enabled: true, framework: 'playwright' } },
        mobile: { enabled: true, e2e: { enabled: false } },
      },
    },
    {
      id: 's2',
      branch: 'feat/s2-inicial',
      worktree: '.worktrees/s2',
      status: 'active',
      areas: ['apps/api/**'],
      ports: { api: 3001, web: 3101, metro: 8082 },
      db: { name: 'demo_shop_s2' },
      platforms: {},
    },
  ],
});

describe('agentsConfigSchema', () => {
  it('round-trips a full node config and applies defaults', () => {
    const config = unwrap(parseAgentsConfig(nodeConfig()));
    expect(config.git).toEqual({
      baseBranch: 'main',
      integrationBranch: 'develop',
      worktreesDir: '.worktrees',
    });
    expect(config.board.dir).toBe('.review-board');
    expect(config.tests).toEqual({ captureScreenshots: true, captureVideo: false });
    expect(config.sharedZones).toEqual([]);
    expect(config.db).toEqual({
      strategy: 'docker',
      service: 'db',
      host: 'localhost',
      port: 5432,
    });
    expect(config.sessions).toHaveLength(2);
    expect(config.sessions[0]?.platforms.web?.e2e.framework).toBe('playwright');
  });

  it('accepts a pure dotnet config with no ports, no db and stacks [dotnet]', () => {
    const config = unwrap(
      parseAgentsConfig({
        version: 1,
        project: { name: 'Ledger', stacks: ['dotnet'] },
        sessions: [
          {
            id: 's1',
            branch: 'feat/s1-inicial',
            worktree: '.worktrees/s1',
            status: 'active',
            areas: ['src/**'],
            platforms: {
              dotnet: { enabled: true, e2e: { enabled: true, framework: 'playwright-dotnet' } },
            },
          },
        ],
      }),
    );
    expect(config.db.strategy).toBe('none');
    expect(config.sessions[0]?.ports).toBeUndefined();
    expect(config.sessions[0]?.db).toBeUndefined();
  });

  it('rejects duplicate session ids', () => {
    const raw = nodeConfig();
    raw.sessions[1]!.id = 's1';
    const error = unwrapErr(parseAgentsConfig(raw));
    expect(error.issues.join('\n')).toContain('duplicate session id: s1');
  });

  it('rejects duplicate branches', () => {
    const raw = nodeConfig();
    raw.sessions[1]!.branch = 'feat/s1-inicial';
    const error = unwrapErr(parseAgentsConfig(raw));
    expect(error.issues.join('\n')).toContain('duplicate branch');
  });

  it('rejects duplicate ports across sessions', () => {
    const raw = nodeConfig();
    raw.sessions[1]!.ports.metro = 8081;
    const error = unwrapErr(parseAgentsConfig(raw));
    expect(error.issues.join('\n')).toContain('duplicate port: 8081');
  });

  it('rejects a session db.name that is not a safe postgres identifier', () => {
    const raw = nodeConfig();
    raw.sessions[0]!.db.name = 'Demo App';
    const error = unwrapErr(parseAgentsConfig(raw));
    expect(error.issues.join('\n')).toContain('safe lowercase postgres identifier');
  });

  it('accepts a valid lowercase session db.name', () => {
    const raw = nodeConfig();
    raw.sessions[0]!.db.name = 'demo_s1';
    expect(parseAgentsConfig(raw).ok).toBe(true);
  });

  it('rejects e2e enabled without framework', () => {
    const raw = nodeConfig();
    raw.sessions[0]!.platforms.mobile!.e2e = { enabled: true };
    const error = unwrapErr(parseAgentsConfig(raw));
    expect(error.issues.join('\n')).toContain('framework is required when e2e is enabled');
  });

  it('rejects a framework that is invalid for the platform', () => {
    const raw = nodeConfig();
    raw.sessions[0]!.platforms.web!.e2e.framework = 'maestro';
    expect(parseAgentsConfig(raw).ok).toBe(false);
  });

  it('rejects docker strategy without a service name', () => {
    const raw = nodeConfig();
    raw.db = { strategy: 'docker' } as never;
    const error = unwrapErr(parseAgentsConfig(raw));
    expect(error.issues.join('\n')).toContain('service');
  });

  it.each(['s0', 'x1', 's01', 'S1', ''])('rejects bad session id %j', (badId) => {
    const raw = nodeConfig();
    raw.sessions[0]!.id = badId;
    expect(parseAgentsConfig(raw).ok).toBe(false);
  });
});

describe('claimsFileSchema', () => {
  it('parses free and claimed shapes', () => {
    const claims = unwrap(
      parseClaimsFile({
        version: 1,
        claims: {
          s1: { status: 'free' },
          s2: {
            status: 'claimed',
            token: 'abcdef1234',
            claimedAt: '2026-07-02T10:00:00Z',
            expiresAt: '2026-07-02T11:00:00Z',
            agent: 'claude-code',
          },
          integrator: { status: 'free' },
        },
      }),
    );
    expect(claims.claims['s2']?.status).toBe('claimed');
    expect(claims.claims['integrator']?.status).toBe('free');
  });

  it('rejects a claimed entry without a token', () => {
    const result = parseClaimsFile({
      version: 1,
      claims: {
        s1: {
          status: 'claimed',
          claimedAt: '2026-07-02T10:00:00Z',
          expiresAt: '2026-07-02T11:00:00Z',
        },
      },
    });
    expect(result.ok).toBe(false);
  });

  it('rejects a claimed entry without dates', () => {
    const result = parseClaimsFile({
      version: 1,
      claims: { s1: { status: 'claimed', token: 'abcdef1234' } },
    });
    expect(result.ok).toBe(false);
  });

  it('rejects a token shorter than 8 chars', () => {
    const result = parseClaimsFile({
      version: 1,
      claims: {
        s1: {
          status: 'claimed',
          token: 'short',
          claimedAt: '2026-07-02T10:00:00Z',
          expiresAt: '2026-07-02T11:00:00Z',
        },
      },
    });
    expect(result.ok).toBe(false);
  });

  it('rejects a role id that is neither a session id nor integrator', () => {
    const result = parseClaimsFile({
      version: 1,
      claims: { reviewer: { status: 'free' } },
    });
    expect(result.ok).toBe(false);
  });
});
