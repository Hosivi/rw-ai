import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Session } from '../contract/schema.js';
import { laneVerdict } from './lane.js';

// A synthetic shared root that resolves to a real absolute path on every OS
// (drive-qualified on Windows, '/'-rooted on POSIX) so path.relative behaves the
// same way it will in production.
const SHARED_ROOT = path.resolve('rw-lane-fixture', 'repo');
const SHARED_ZONES = ['shared/**'] as const;

// s1 is narrowed to its own lane so a write anywhere else is an invasion.
const s1: Session = {
  id: 's1',
  branch: 'feat/s1',
  worktree: '.worktrees/s1',
  status: 'active',
  areas: ['src/s1/**'],
  platforms: {},
};

// The agent works INSIDE its worktree, so a real tool-call path is absolute and
// nested under the worktree — the same tree layout as the repo root.
const worktreeRoot = path.resolve(SHARED_ROOT, s1.worktree);
const inWorktree = (rel: string): string => path.resolve(worktreeRoot, rel);

const verdictFor = (targetPath: string) =>
  laneVerdict({ targetPath, sharedRoot: SHARED_ROOT, session: s1, sharedZones: SHARED_ZONES });

describe('laneVerdict', () => {
  it('allows an in-area write, relativized to the session worktree', () => {
    expect(verdictFor(inWorktree('src/s1/widget.ts'))).toEqual({
      relPath: 'src/s1/widget.ts',
      class: 'in-area',
      allowed: true,
    });
  });

  it('allows a shared-zone write', () => {
    expect(verdictFor(inWorktree('shared/util.ts'))).toEqual({
      relPath: 'shared/util.ts',
      class: 'shared-zone',
      allowed: true,
    });
  });

  it('blocks an out-of-area write as an invasion', () => {
    expect(verdictFor(inWorktree('src/s2/leak.ts'))).toEqual({
      relPath: 'src/s2/leak.ts',
      class: 'invasion',
      allowed: false,
    });
  });

  it('blocks a path that escapes the worktree entirely (outside the repo)', () => {
    const outside = path.resolve(SHARED_ROOT, '..', 'elsewhere', 'x.ts');
    const verdict = verdictFor(outside);
    expect(verdict.class).toBe('invasion');
    expect(verdict.allowed).toBe(false);
    // The escaping relPath is surfaced so callers can explain the block.
    expect(verdict.relPath.startsWith('../')).toBe(true);
  });

  it('blocks a write to the main repo root, outside the session worktree', () => {
    // A sibling worktree's file, or a main-root file, is above this worktree.
    const mainRootFile = path.resolve(SHARED_ROOT, 'src', 's1', 'x.ts');
    const verdict = verdictFor(mainRootFile);
    expect(verdict.class).toBe('invasion');
    expect(verdict.allowed).toBe(false);
  });
});
