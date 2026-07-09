import { describe, expect, it } from 'vitest';
import type { SessionState } from '../../state/aggregate.js';
import { formatStatusJson, formatStatusTable } from './status.js';

const state = (over: Partial<SessionState> = {}): SessionState => ({
  sessionId: 's1',
  branch: 'feat/s1',
  areas: ['**/*'],
  claim: { role: 's1', status: 'free', expired: false },
  marker: null,
  git: { dirty: false, ahead: 0, behind: 0 },
  light: 'green',
  ...over,
});

describe('formatStatusJson', () => {
  it('emits one public entry per session with the expected shape', () => {
    const json = JSON.parse(
      formatStatusJson([
        state({ light: 'red', marker: { version: 1, sessionId: 's1', phase: 'blocked', tests: 'failed', updatedAt: '2026-07-09T12:00:00.000Z' } }),
      ]),
    );
    expect(json).toEqual([
      {
        sessionId: 's1',
        branch: 'feat/s1',
        light: 'red',
        claim: { status: 'free', expired: false },
        phase: 'blocked',
        tests: 'failed',
        git: { dirty: false, ahead: 0, behind: 0 },
      },
    ]);
  });

  it('NEVER leaks the claim token into JSON output', () => {
    const claimed = state({
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
    });
    const out = formatStatusJson([claimed]);
    expect(out).not.toContain('super-secret-token');
    expect(JSON.parse(out)[0].claim).toEqual({ status: 'claimed', expired: false });
  });
});

describe('formatStatusTable', () => {
  it('renders a header and one aligned row per session', () => {
    const lines = formatStatusTable([
      state({ light: 'yellow', git: { dirty: true, ahead: 2, behind: 1 }, marker: { version: 1, sessionId: 's1', phase: 'working', updatedAt: '2026-07-09T12:00:00.000Z' } }),
    ]);
    expect(lines[0]).toContain('SESIÓN');
    expect(lines[1]).toContain('s1');
    expect(lines[1]).toContain('amarillo');
    expect(lines[1]).toContain('+2');
    expect(lines[1]).toContain('-1');
    expect(lines[1]).toContain('working');
  });

  it('reports the empty case', () => {
    expect(formatStatusTable([])).toEqual(['No hay sesiones activas.']);
  });
});
