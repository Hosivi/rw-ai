import { describe, expect, it } from 'vitest';
import { unwrap, unwrapErr } from '../core/result.test-support.js';
import { runCommand, runCommandRaw, trimmedStdout } from './exec.js';

// git is the one binary these integration tests may assume: the whole engine
// requires it anyway.
const cwd = process.cwd();

describe('runCommand', () => {
  it('returns ok with captured output on exit 0', async () => {
    const output = unwrap(await runCommand('git', ['--version'], { cwd }));
    expect(output.exitCode).toBe(0);
    expect(output.stdout).toContain('git version');
  });

  it('returns non-zero-exit carrying the full output on failure', async () => {
    const error = unwrapErr(await runCommand('git', ['not-a-real-subcommand'], { cwd }));
    expect(error.kind).toBe('non-zero-exit');
    if (error.kind === 'non-zero-exit') {
      expect(error.output.exitCode).not.toBe(0);
      expect(error.output.stderr).not.toBe('');
    }
  });

  it('returns spawn-failed for a nonexistent binary', async () => {
    const error = unwrapErr(await runCommand('rw-ai-no-such-binary-000', [], { cwd }));
    expect(error.kind).toBe('spawn-failed');
  });

  it('passes env overrides to the child process', async () => {
    const output = unwrap(
      await runCommand('git', ['var', 'GIT_AUTHOR_IDENT'], {
        cwd,
        env: {
          GIT_AUTHOR_NAME: 'Env Probe',
          GIT_AUTHOR_EMAIL: 'probe@rw-ai.invalid',
          GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z',
        },
      }),
    );
    expect(output.stdout).toContain('Env Probe <probe@rw-ai.invalid>');
  });
});

describe('runCommandRaw', () => {
  it('returns ok even when the process exits non-zero', async () => {
    const output = unwrap(await runCommandRaw('git', ['not-a-real-subcommand'], { cwd }));
    expect(output.exitCode).not.toBe(0);
  });

  it('still reports spawn failures as errors', async () => {
    const error = unwrapErr(await runCommandRaw('rw-ai-no-such-binary-000', [], { cwd }));
    expect(error.kind).toBe('spawn-failed');
  });
});

describe('trimmedStdout', () => {
  it('strips the trailing newline git appends', () => {
    expect(trimmedStdout({ stdout: 'main\n', stderr: '', exitCode: 0 })).toBe('main');
  });
});
