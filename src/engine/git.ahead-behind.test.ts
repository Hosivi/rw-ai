import { describe, expect, it } from 'vitest';
import { ok, err } from '../core/result.js';
import { unwrap, unwrapErr } from '../core/result.test-support.js';
import { createGit } from './git.js';
import type { CommandOutput, CommandRunner } from './exec.js';

// A fake runner that records its last invocation and returns a canned output,
// so aheadBehind can be exercised without a real repo (per WU-1.3: mock exec).
const fakeRaw = (
  output: CommandOutput,
): { runner: CommandRunner; calls: Array<{ command: string; args: readonly string[]; cwd: string }> } => {
  const calls: Array<{ command: string; args: readonly string[]; cwd: string }> = [];
  const runner: CommandRunner = async (command, args, opts) => {
    calls.push({ command, args, cwd: opts.cwd });
    return ok(output);
  };
  return { runner, calls };
};

const unusedRun: CommandRunner = async () => ok({ stdout: '', stderr: '', exitCode: 0 });

describe('git.aheadBehind', () => {
  it('parses left-right counts (left=behind, right=ahead)', async () => {
    const { runner, calls } = fakeRaw({ stdout: '2\t3\n', stderr: '', exitCode: 0 });
    const git = createGit('/worktree', unusedRun, runner);

    const result = unwrap(await git.aheadBehind('main'));

    expect(result).toEqual({ behind: 2, ahead: 3 });
    expect(calls[0]?.args).toEqual(['rev-list', '--left-right', '--count', 'main...HEAD']);
    expect(calls[0]?.cwd).toBe('/worktree');
  });

  it('returns safe {0,0} when git exits non-zero (unknown base / unrelated history)', async () => {
    const { runner } = fakeRaw({ stdout: '', stderr: 'fatal: bad revision', exitCode: 128 });
    const git = createGit('/worktree', unusedRun, runner);

    expect(unwrap(await git.aheadBehind('nope'))).toEqual({ ahead: 0, behind: 0 });
  });

  it('returns safe {0,0} when output is unparseable', async () => {
    const { runner } = fakeRaw({ stdout: 'garbage', stderr: '', exitCode: 0 });
    const git = createGit('/worktree', unusedRun, runner);

    expect(unwrap(await git.aheadBehind('main'))).toEqual({ ahead: 0, behind: 0 });
  });

  it('propagates a spawn-level failure as an error', async () => {
    const failing: CommandRunner = async () => err({ kind: 'spawn-failed', message: 'no git' });
    const git = createGit('/worktree', unusedRun, failing);

    const error = unwrapErr(await git.aheadBehind('main'));
    expect(error.kind).toBe('spawn-failed');
  });
});
