import { describe, expect, it } from 'vitest';
import type { RunbookResult } from '../engine/configure.js';
import type { RoleStatus } from '../engine/identity.js';
import type { IntegrationAnalysis } from '../engine/integrator.js';
import type { CliContextError } from './context.js';
import {
  formatContextError,
  formatIntegration,
  formatRoles,
  formatRunbook,
  printLines,
} from './output.js';

const EXPIRES = '2026-07-02T18:00:00.000Z';
const CLAIMED_AT = '2026-07-02T12:00:00.000Z';

describe('formatRunbook', () => {
  const runbook: RunbookResult = {
    ok: false,
    steps: [
      { name: 'preflight-git', status: 'ok', detail: 'git 2.53.0 supports merge-tree' },
      { name: 'databases', status: 'degraded', detail: 'db: 1 manual' },
      { name: 'board', status: 'failed', detail: 'could not write board.md' },
      { name: 'claims', status: 'skipped', detail: 'skipped after a required step failed' },
    ],
  };

  it('maps each status to its glyph and renders one line per step', () => {
    const text = formatRunbook(runbook);
    const lines = text.split('\n');
    expect(lines[0]).toBe('✓ preflight-git — git 2.53.0 supports merge-tree');
    expect(lines[1]).toBe('⚠ databases — db: 1 manual');
    expect(lines[2]).toBe('✗ board — could not write board.md');
    expect(lines[3]).toBe('· claims — skipped after a required step failed');
  });

  it('summarizes failures and degradations when the runbook is not ok', () => {
    expect(formatRunbook(runbook)).toContain('Configuración con problemas: 1 fallidos, 1 degradados');
  });

  it('closes with the complete summary when the runbook is ok', () => {
    const ok: RunbookResult = {
      ok: true,
      steps: [{ name: 'preflight-git', status: 'ok', detail: 'ready' }],
    };
    expect(formatRunbook(ok).split('\n').at(-1)).toBe('Configuración completa');
  });

  it('is deterministic', () => {
    expect(formatRunbook(runbook)).toBe(formatRunbook(runbook));
  });
});

describe('formatRoles', () => {
  it('labels free, occupied, and expired claims in Spanish', () => {
    const roles: RoleStatus[] = [
      { role: 's1', status: 'free', expired: false },
      {
        role: 's2',
        status: 'claimed',
        expired: false,
        claim: { status: 'claimed', token: 'abcdefgh', claimedAt: CLAIMED_AT, expiresAt: EXPIRES, agent: 'claude-code' },
      },
      {
        role: 'integrator',
        status: 'free',
        expired: true,
        claim: { status: 'claimed', token: 'abcdefgh', claimedAt: CLAIMED_AT, expiresAt: EXPIRES },
      },
    ];
    const text = formatRoles(roles);
    expect(text).toContain('s1');
    expect(text).toMatch(/s1\s+libre/);
    expect(text).toContain(`ocupado (expira ${EXPIRES}, agente claude-code)`);
    expect(text).toContain('libre (claim vencido)');
  });

  it('omits the agent annotation when the claim carries no agent', () => {
    const roles: RoleStatus[] = [
      {
        role: 's1',
        status: 'claimed',
        expired: false,
        claim: { status: 'claimed', token: 'abcdefgh', claimedAt: CLAIMED_AT, expiresAt: EXPIRES },
      },
    ];
    expect(formatRoles(roles)).toContain(`ocupado (expira ${EXPIRES})`);
    expect(formatRoles(roles)).not.toContain('agente');
  });

  it('is deterministic', () => {
    const roles: RoleStatus[] = [{ role: 's1', status: 'free', expired: false }];
    expect(formatRoles(roles)).toBe(formatRoles(roles));
  });
});

describe('formatIntegration', () => {
  const base: IntegrationAnalysis = {
    base: 'develop',
    sessions: [
      { sessionId: 's1', branch: 'feat/s1', files: ['a.ts'] },
      { sessionId: 's2', branch: 'feat/s2', files: ['b.ts'] },
    ],
    invasions: [],
    sharedZoneTouches: [],
    overlaps: [],
    simulatedMerges: [{ a: 's1', b: 's2', status: 'clean', conflicts: [] }],
  };

  it('summarizes counts and reuses the integration headline', () => {
    const text = formatIntegration(base);
    expect(text).toContain('Sesiones analizadas: 2');
    expect(text).toContain('Invasiones de carril: 0');
    expect(text).toContain('Zonas compartidas tocadas: 0');
    expect(text).toContain('Solapamientos: 0');
    expect(text).toContain('Conflictos simulados: 0');
    // The headline mirrors integrationSummaryLine.
    expect(text).toContain('2 sesiones');
  });

  it('lists conflicted simulated pairs', () => {
    const analysis: IntegrationAnalysis = {
      ...base,
      simulatedMerges: [{ a: 's1', b: 's2', status: 'conflict', conflicts: ['shared/x.ts', 'shared/y.ts'] }],
    };
    const text = formatIntegration(analysis);
    expect(text).toContain('Conflictos simulados: 1');
    expect(text).toContain('s1 ↔ s2: shared/x.ts, shared/y.ts');
  });

  it('is deterministic', () => {
    expect(formatIntegration(base)).toBe(formatIntegration(base));
  });
});

describe('formatContextError', () => {
  it('suggests rw configure for a missing config', () => {
    const error: CliContextError = { kind: 'config-not-found', message: 'agents.config.json not found' };
    expect(formatContextError(error)).toContain('rw configure');
  });

  it('explains the git-repo requirement', () => {
    const error: CliContextError = { kind: 'not-a-repo', message: 'no repo' };
    expect(formatContextError(error).toLowerCase()).toContain('git');
  });

  it('lists the schema issues for an invalid config', () => {
    const error: CliContextError = {
      kind: 'config-invalid',
      message: 'Invalid agents.config.json',
      issues: ['project.name: Required', 'sessions: Required'],
    };
    const text = formatContextError(error);
    expect(text).toContain('project.name: Required');
    expect(text).toContain('sessions: Required');
  });

  it('surfaces the underlying message for an io failure', () => {
    const error: CliContextError = { kind: 'io', message: 'disk on fire' };
    expect(formatContextError(error)).toContain('disk on fire');
  });
});

describe('printLines', () => {
  it('writes each line through the injected writer', () => {
    const written: string[] = [];
    printLines(['uno', 'dos'], (line) => written.push(line));
    expect(written).toEqual(['uno', 'dos']);
  });
});
