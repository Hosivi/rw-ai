import { describe, expect, it } from 'vitest';
import type { PublicSessionState } from '../../state/public.js';
import { formatStatusJson, formatStatusTable } from './status.js';

const state = (over: Partial<PublicSessionState> = {}): PublicSessionState => ({
  sessionId: 's1',
  branch: 'feat/s1',
  areas: ['**/*'],
  light: 'green',
  claim: { status: 'free', expired: false },
  phase: null,
  tests: null,
  git: { dirty: false, ahead: 0, behind: 0 },
  ...over,
});

describe('formatStatusJson', () => {
  it('serializes the public states as-is', () => {
    const entry = state({ light: 'red', phase: 'blocked', tests: 'failed' });
    expect(JSON.parse(formatStatusJson([entry]))).toEqual([entry]);
  });
});

describe('formatStatusTable', () => {
  it('renders a header and one aligned row per session', () => {
    const lines = formatStatusTable([
      state({ light: 'yellow', git: { dirty: true, ahead: 2, behind: 1 }, phase: 'working' }),
    ]);
    expect(lines[0]).toContain('SESIÓN');
    expect(lines[1]).toContain('s1');
    expect(lines[1]).toContain('amarillo');
    expect(lines[1]).toContain('+2');
    expect(lines[1]).toContain('-1');
    expect(lines[1]).toContain('working');
  });

  it('shows a dash for a session with no marker phase', () => {
    expect(formatStatusTable([state({ phase: null })])[1]).toContain('—');
  });

  it('reports the empty case', () => {
    expect(formatStatusTable([])).toEqual(['No hay sesiones activas.']);
  });
});
