import { describe, expect, it } from 'vitest';
import { createDefaultConfig } from '../contract/defaults.js';
import { unwrap } from '../core/result.test-support.js';
import type { RoleStatus } from '../engine/identity.js';
import { computeSessionState, deriveLight, type GitSignal } from './aggregate.js';
import type { SessionMarker } from './marker.js';

const config = unwrap(
  createDefaultConfig({ projectName: 'demo', stacks: ['node'], sessionCount: 2 }),
);

const cleanGit: GitSignal = { dirty: false, ahead: 0, behind: 0 };
const heldClaim: RoleStatus = { role: 's1', status: 'claimed', expired: false };
const freeClaim: RoleStatus = { role: 's1', status: 'free', expired: false };
const expiredClaim: RoleStatus = { role: 's1', status: 'claimed', expired: true };

const marker = (over: Partial<SessionMarker>): SessionMarker => ({
  version: 1,
  sessionId: 's1',
  phase: 'idle',
  updatedAt: '2026-07-09T12:00:00.000Z',
  ...over,
});

describe('deriveLight (truth table: claim × marker × git)', () => {
  it('green when free/idle and clean', () => {
    expect(deriveLight(freeClaim, null, cleanGit)).toBe('green');
    expect(deriveLight(freeClaim, marker({ phase: 'idle' }), cleanGit)).toBe('green');
  });

  it('red when marker phase is blocked', () => {
    expect(deriveLight(heldClaim, marker({ phase: 'blocked' }), cleanGit)).toBe('red');
  });

  it('red when tests failed (even if phase is working)', () => {
    expect(deriveLight(heldClaim, marker({ phase: 'working', tests: 'failed' }), cleanGit)).toBe(
      'red',
    );
  });

  it('yellow when marker phase is working or review', () => {
    expect(deriveLight(freeClaim, marker({ phase: 'working' }), cleanGit)).toBe('yellow');
    expect(deriveLight(freeClaim, marker({ phase: 'review' }), cleanGit)).toBe('yellow');
  });

  it('yellow when a held claim has a dirty tree or is ahead', () => {
    expect(deriveLight(heldClaim, null, { dirty: true, ahead: 0, behind: 0 })).toBe('yellow');
    expect(deriveLight(heldClaim, null, { dirty: false, ahead: 3, behind: 0 })).toBe('yellow');
  });

  it('does NOT go yellow for git dirty without a held claim (unowned work stays green)', () => {
    expect(deriveLight(freeClaim, null, { dirty: true, ahead: 2, behind: 0 })).toBe('green');
    expect(deriveLight(expiredClaim, null, { dirty: true, ahead: 2, behind: 0 })).toBe('green');
  });
});

describe('computeSessionState', () => {
  it('produces one state per active session, mapped by id', () => {
    const claims: RoleStatus[] = [
      { role: 's1', status: 'claimed', expired: false },
      { role: 's2', status: 'free', expired: false },
    ];
    const markers = new Map<string, SessionMarker | null>([
      ['s1', marker({ phase: 'blocked' })],
    ]);
    const gitSignals = new Map<string, GitSignal>([
      ['s1', { dirty: true, ahead: 1, behind: 0 }],
      ['s2', cleanGit],
    ]);

    const states = computeSessionState(config, claims, markers, gitSignals);

    expect(states.map((s) => s.sessionId)).toEqual(['s1', 's2']);
    expect(states[0]?.light).toBe('red');
    expect(states[0]?.branch).toBe(config.sessions[0]?.branch);
    expect(states[0]?.git.dirty).toBe(true);
    expect(states[1]?.light).toBe('green');
    expect(states[1]?.marker).toBeNull();
  });

  it('defaults missing claim/marker/git to safe values (free, null, clean → green)', () => {
    const states = computeSessionState(config, [], new Map(), new Map());
    expect(states).toHaveLength(2);
    expect(states.every((s) => s.light === 'green')).toBe(true);
    expect(states[0]?.claim.status).toBe('free');
    expect(states[0]?.git).toEqual(cleanGit);
  });

  it('excludes archived sessions', () => {
    const archived = unwrap(
      createDefaultConfig({ projectName: 'demo', stacks: ['node'], sessionCount: 1 }),
    );
    const mutated = {
      ...archived,
      sessions: archived.sessions.map((s) => ({ ...s, status: 'archived' as const })),
    };
    expect(computeSessionState(mutated, [], new Map(), new Map())).toHaveLength(0);
  });
});
