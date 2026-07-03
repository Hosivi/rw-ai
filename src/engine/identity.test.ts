import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveBoardDir } from '../contract/env.js';
import type { AgentsConfig } from '../contract/schema.js';
import { unwrap, unwrapErr } from '../core/result.test-support.js';
import { buildConfig, removeDirRobust } from './git.test-support.js';
import {
  claimRole,
  claimsFilePath,
  generateClaimToken,
  listRoles,
  readClaims,
  releaseRole,
  whoami,
  writeClaims,
} from './identity.js';

const NOW = new Date('2026-07-02T12:00:00.000Z');
const TTL_MS = 60 * 60 * 1000; // 1 hour
const TOKEN = 'token-aaaaaaaa';
const OTHER = 'token-bbbbbbbb';

let root: string;
let boardDir: string;
let config: AgentsConfig;

beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'rw-ai-id-')));
  config = buildConfig();
  boardDir = resolveBoardDir(root, config);
  // writeClaims never mkdirs — the board dir is provisioned earlier in the real
  // flow, so the spec creates it up front just like the runtime does.
  await fs.mkdir(boardDir, { recursive: true });
});

afterEach(() => removeDirRobust(root));

describe('generateClaimToken', () => {
  it('produces a 32-char hex string by default (well over the minimum)', () => {
    expect(generateClaimToken()).toMatch(/^[0-9a-f]{32}$/);
  });

  it('defers to an injected generator', () => {
    expect(generateClaimToken(() => 'deterministic-token')).toBe('deterministic-token');
  });
});

describe('readClaims', () => {
  it('returns empty free claims when the file is missing', async () => {
    const claims = unwrap(await readClaims(boardDir, config));
    expect(claims.claims).toEqual({
      s1: { status: 'free' },
      s2: { status: 'free' },
      integrator: { status: 'free' },
    });
  });

  it('reconciles a newly added session into a pre-existing claims file', async () => {
    unwrap(
      await writeClaims(boardDir, {
        version: 1,
        claims: { s1: { status: 'free' }, integrator: { status: 'free' } },
      }),
    );
    const claims = unwrap(await readClaims(boardDir, config));
    expect(claims.claims.s2).toEqual({ status: 'free' });
  });

  it('reports invalid-json for a corrupt file', async () => {
    await fs.writeFile(claimsFilePath(boardDir), '{ nope', 'utf8');
    expect(unwrapErr(await readClaims(boardDir, config)).kind).toBe('invalid-json');
  });

  it('reports invalid-claims for a schema violation', async () => {
    await fs.writeFile(claimsFilePath(boardDir), JSON.stringify({ version: 2, claims: {} }), 'utf8');
    expect(unwrapErr(await readClaims(boardDir, config)).kind).toBe('invalid-claims');
  });
});

describe('claimRole', () => {
  it('claims a free role and persists it', async () => {
    const result = unwrap(
      await claimRole({
        config,
        boardDir,
        role: 's1',
        token: TOKEN,
        agent: 'claude-code',
        now: NOW,
        ttlMs: TTL_MS,
      }),
    );
    expect(result.previous).toEqual({ status: 'free' });
    expect(result.claim).toMatchObject({
      status: 'claimed',
      token: TOKEN,
      agent: 'claude-code',
      claimedAt: NOW.toISOString(),
      expiresAt: new Date(NOW.getTime() + TTL_MS).toISOString(),
    });
    const persisted = unwrap(await readClaims(boardDir, config));
    expect(persisted.claims.s1).toMatchObject({ status: 'claimed', token: TOKEN });
  });

  it('allows re-claiming with the same token (renew)', async () => {
    unwrap(await claimRole({ config, boardDir, role: 's1', token: TOKEN, now: NOW, ttlMs: TTL_MS }));
    const later = new Date(NOW.getTime() + 1000);
    const result = unwrap(
      await claimRole({ config, boardDir, role: 's1', token: TOKEN, now: later, ttlMs: TTL_MS }),
    );
    expect(result.claim.status).toBe('claimed');
    if (result.claim.status === 'claimed') {
      expect(result.claim.expiresAt).toBe(new Date(later.getTime() + TTL_MS).toISOString());
    }
  });

  it('rejects a role held by a different, unexpired token', async () => {
    unwrap(await claimRole({ config, boardDir, role: 's1', token: TOKEN, now: NOW, ttlMs: TTL_MS }));
    const error = unwrapErr(
      await claimRole({ config, boardDir, role: 's1', token: OTHER, now: NOW, ttlMs: TTL_MS }),
    );
    expect(error.kind).toBe('occupied');
    expect(error.role).toBe('s1');
  });

  it('claims a role whose existing claim has expired', async () => {
    unwrap(await claimRole({ config, boardDir, role: 's1', token: TOKEN, now: NOW, ttlMs: TTL_MS }));
    // now === expiresAt is already expired (strictly-after semantics).
    const afterExpiry = new Date(NOW.getTime() + TTL_MS);
    const result = unwrap(
      await claimRole({ config, boardDir, role: 's1', token: OTHER, now: afterExpiry, ttlMs: TTL_MS }),
    );
    expect(result.claim.status).toBe('claimed');
    if (result.claim.status === 'claimed') {
      expect(result.claim.token).toBe(OTHER);
    }
  });

  it('rejects an unknown role', async () => {
    const error = unwrapErr(
      await claimRole({ config, boardDir, role: 's99', token: TOKEN, now: NOW, ttlMs: TTL_MS }),
    );
    expect(error.kind).toBe('invalid-role');
  });

  it('rejects a token shorter than the minimum without writing claims.json', async () => {
    const error = unwrapErr(
      await claimRole({ config, boardDir, role: 's1', token: 'abc', now: NOW, ttlMs: TTL_MS }),
    );
    expect(error.kind).toBe('invalid-token');
    // A bad token must never be persisted — it would fail the schema on the next
    // read and brick every role in the file.
    await expect(fs.access(claimsFilePath(boardDir))).rejects.toThrow();
  });
});

describe('claims lock', () => {
  it('serializes concurrent claims on different roles so neither is dropped', async () => {
    const [a, b] = await Promise.all([
      claimRole({ config, boardDir, role: 's1', token: TOKEN, now: NOW, ttlMs: TTL_MS }),
      claimRole({ config, boardDir, role: 's2', token: OTHER, now: NOW, ttlMs: TTL_MS }),
    ]);
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    const persisted = unwrap(await readClaims(boardDir, config));
    expect(persisted.claims.s1).toMatchObject({ status: 'claimed', token: TOKEN });
    expect(persisted.claims.s2).toMatchObject({ status: 'claimed', token: OTHER });
  });

  it('breaks a stale lock and still completes the claim', async () => {
    const lockPath = `${claimsFilePath(boardDir)}.lock`;
    await fs.writeFile(lockPath, '');
    // Backdate the lock far beyond the staleness window relative to NOW.
    const past = new Date(NOW.getTime() - 60 * 60 * 1000);
    await fs.utimes(lockPath, past, past);
    const result = unwrap(
      await claimRole({ config, boardDir, role: 's1', token: TOKEN, now: NOW, ttlMs: TTL_MS }),
    );
    expect(result.claim.status).toBe('claimed');
  });
});

describe('releaseRole', () => {
  it('releases a claim with the matching token', async () => {
    unwrap(await claimRole({ config, boardDir, role: 's1', token: TOKEN, now: NOW, ttlMs: TTL_MS }));
    expect(unwrap(await releaseRole({ config, boardDir, role: 's1', token: TOKEN, now: NOW }))).toEqual({
      role: 's1',
      released: true,
    });
    const persisted = unwrap(await readClaims(boardDir, config));
    expect(persisted.claims.s1).toEqual({ status: 'free' });
  });

  it('rejects release with a non-matching token', async () => {
    unwrap(await claimRole({ config, boardDir, role: 's1', token: TOKEN, now: NOW, ttlMs: TTL_MS }));
    expect(
      unwrapErr(await releaseRole({ config, boardDir, role: 's1', token: OTHER, now: NOW })).kind,
    ).toBe('token-mismatch');
  });

  it('force-releases regardless of the token', async () => {
    unwrap(await claimRole({ config, boardDir, role: 's1', token: TOKEN, now: NOW, ttlMs: TTL_MS }));
    expect(
      unwrap(await releaseRole({ config, boardDir, role: 's1', token: OTHER, force: true, now: NOW }))
        .released,
    ).toBe(true);
  });

  it('is a no-op when the role is already free', async () => {
    expect(unwrap(await releaseRole({ config, boardDir, role: 's1', token: TOKEN, now: NOW }))).toEqual({
      role: 's1',
      released: false,
      reason: 'already-free',
    });
  });
});

describe('whoami', () => {
  it('finds the role for a matching, unexpired token', async () => {
    unwrap(
      await claimRole({ config, boardDir, role: 'integrator', token: TOKEN, now: NOW, ttlMs: TTL_MS }),
    );
    const who = unwrap(await whoami({ config, boardDir, token: TOKEN, now: NOW }));
    expect(who?.role).toBe('integrator');
  });

  it('returns null when no claim matches the token', async () => {
    expect(unwrap(await whoami({ config, boardDir, token: TOKEN, now: NOW }))).toBeNull();
  });

  it('ignores an expired matching claim', async () => {
    unwrap(await claimRole({ config, boardDir, role: 's1', token: TOKEN, now: NOW, ttlMs: TTL_MS }));
    const who = unwrap(
      await whoami({ config, boardDir, token: TOKEN, now: new Date(NOW.getTime() + TTL_MS) }),
    );
    expect(who).toBeNull();
  });

  it('ignores a matching claim on a role outside the live role set', async () => {
    // Persist a claim on 's2', then present a config where 's2' is archived.
    unwrap(await claimRole({ config, boardDir, role: 's2', token: TOKEN, now: NOW, ttlMs: TTL_MS }));
    const withoutS2: AgentsConfig = {
      ...config,
      sessions: config.sessions.map((session) =>
        session.id === 's2' ? { ...session, status: 'archived' as const } : session,
      ),
    };
    expect(unwrap(await whoami({ config: withoutS2, boardDir, token: TOKEN, now: NOW }))).toBeNull();
  });
});

describe('listRoles', () => {
  it('lists every role with its effective status', async () => {
    unwrap(await claimRole({ config, boardDir, role: 's1', token: TOKEN, now: NOW, ttlMs: TTL_MS }));
    const roles = unwrap(await listRoles({ config, boardDir, now: NOW }));
    expect(roles.map((entry) => entry.role).sort()).toEqual(['integrator', 's1', 's2']);
    expect(roles.find((entry) => entry.role === 's1')).toMatchObject({
      status: 'claimed',
      expired: false,
    });
    const s2 = roles.find((entry) => entry.role === 's2');
    expect(s2).toMatchObject({ status: 'free', expired: false });
    expect(s2?.claim).toBeUndefined();
  });

  it('reports an expired claim as effectively free but surfaces the stale claim', async () => {
    unwrap(await claimRole({ config, boardDir, role: 's1', token: TOKEN, now: NOW, ttlMs: TTL_MS }));
    const roles = unwrap(
      await listRoles({ config, boardDir, now: new Date(NOW.getTime() + TTL_MS) }),
    );
    const s1 = roles.find((entry) => entry.role === 's1');
    expect(s1?.status).toBe('free');
    expect(s1?.expired).toBe(true);
    expect(s1?.claim?.status).toBe('claimed');
  });
});
