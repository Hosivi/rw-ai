import { describe, expect, it } from 'vitest';
import type { RoleStatus } from '../engine/identity.js';
import { unwrapErr } from '../core/result.test-support.js';
import { confirmE2E, isInteractive, selectRole } from './prompts.js';

const ROLES: RoleStatus[] = [
  { role: 's1', status: 'free', expired: false },
  { role: 's2', status: 'free', expired: false },
];

describe('isInteractive', () => {
  it('returns a boolean derived from the tty state of both streams', () => {
    expect(typeof isInteractive()).toBe('boolean');
  });
});

describe('selectRole', () => {
  it('degrades to a non-interactive error when there is no tty', async () => {
    // Explicit interactive:false is the injectable seam standing in for a
    // non-TTY invocation — no real @clack keypresses are scripted.
    expect(unwrapErr(await selectRole(ROLES, false)).kind).toBe('non-interactive');
  });
});

describe('confirmE2E', () => {
  it('degrades to a non-interactive error when there is no tty', async () => {
    expect(unwrapErr(await confirmE2E('web', false)).kind).toBe('non-interactive');
  });
});
