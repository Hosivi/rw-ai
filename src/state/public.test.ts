import { describe, expect, it } from 'vitest';
import type { SessionState } from './aggregate.js';
import { toPublicState } from './public.js';

const claimedWithToken: SessionState = {
  sessionId: 's1',
  branch: 'feat/s1',
  areas: ['src/a/**'],
  claim: {
    role: 's1',
    status: 'claimed',
    expired: false,
    claim: {
      status: 'claimed',
      token: 'super-secret-token',
      claimedAt: '2026-07-09T12:00:00.000Z',
      expiresAt: '2026-07-09T20:00:00.000Z',
    },
  },
  marker: { version: 1, sessionId: 's1', phase: 'review', tests: 'passed', updatedAt: '2026-07-09T12:00:00.000Z' },
  git: { dirty: true, ahead: 2, behind: 1 },
  light: 'yellow',
};

describe('toPublicState', () => {
  it('projects the wire-safe shape without the claim token', () => {
    const pub = toPublicState(claimedWithToken);
    expect(pub).toEqual({
      sessionId: 's1',
      branch: 'feat/s1',
      areas: ['src/a/**'],
      light: 'yellow',
      claim: { status: 'claimed', expired: false },
      phase: 'review',
      tests: 'passed',
      git: { dirty: true, ahead: 2, behind: 1 },
    });
    expect(JSON.stringify(pub)).not.toContain('super-secret-token');
  });

  it('nulls phase/tests when there is no marker', () => {
    const pub = toPublicState({ ...claimedWithToken, marker: null });
    expect(pub.phase).toBeNull();
    expect(pub.tests).toBeNull();
  });
});
