import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { unwrap, unwrapErr } from '../core/result.test-support.js';
import { removeDirRobust } from '../engine/git.test-support.js';
import { parseDecision, readDecisions, writeDecision, type Decision } from './decisions.js';

let board: string;
beforeEach(async () => {
  board = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'rw-ai-dec-')));
});
afterEach(() => removeDirRobust(board));

const decision = (over: Partial<Decision> = {}): Decision => ({
  version: 1,
  sessionId: 's1',
  verdict: 'approved',
  decidedAt: '2026-07-09T12:00:00.000Z',
  ...over,
});

describe('parseDecision', () => {
  it('accepts approved/rejected with an optional comment', () => {
    expect(unwrap(parseDecision(decision({ verdict: 'rejected', comment: 'needs tests' }))).comment).toBe(
      'needs tests',
    );
  });
  it('rejects an unknown verdict', () => {
    unwrapErr(parseDecision(decision({ verdict: 'maybe' as unknown as Decision['verdict'] })));
  });
  it('rejects a path-traversal sessionId', () => {
    unwrapErr(parseDecision(decision({ sessionId: '../../evil' })));
  });
});

describe('writeDecision / readDecisions', () => {
  it('round-trips a decision under decisions/', async () => {
    unwrap(await writeDecision(board, decision({ comment: 'lgtm' })));
    const all = unwrap(await readDecisions(board, 's1'));
    expect(all).toHaveLength(1);
    expect(all[0]?.verdict).toBe('approved');
    expect(all[0]?.comment).toBe('lgtm');
  });

  it('keeps multiple decisions for a session, newest first', async () => {
    unwrap(await writeDecision(board, decision({ decidedAt: '2026-07-09T10:00:00.000Z', verdict: 'rejected' })));
    unwrap(await writeDecision(board, decision({ decidedAt: '2026-07-09T12:00:00.000Z', verdict: 'approved' })));
    const all = unwrap(await readDecisions(board, 's1'));
    expect(all).toHaveLength(2);
    expect(all[0]?.decidedAt).toBe('2026-07-09T12:00:00.000Z'); // newest first
  });

  it('returns an empty list when a session has no decisions', async () => {
    expect(unwrap(await readDecisions(board, 'ghost'))).toEqual([]);
  });
});
