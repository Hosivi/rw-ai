import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseCliArgs, runCli, type CliIo } from './cli.js';

const tempProject = async (): Promise<string> => mkdtemp(path.join(os.tmpdir(), 'rw-ai-cli-'));

const captureIo = (cwd: string): CliIo & { stdoutText: () => string; stderrText: () => string } => {
  let stdout = '';
  let stderr = '';
  return {
    cwd: () => cwd,
    stdout: { write: (message) => void (stdout += message) },
    stderr: { write: (message) => void (stderr += message) },
    stdoutText: () => stdout,
    stderrText: () => stderr,
  };
};

describe('parseCliArgs', () => {
  it('parses prepare options without a command framework', () => {
    expect(
      parseCliArgs([
        'node',
        'rw',
        'prepare',
        '--project-root',
        '/tmp/app',
        '--project-name',
        'Demo',
        '--stack',
        'node',
        '--append-session',
        '--adopt-current-worktree',
        '--session',
        's1',
      ]),
    ).toEqual({
      command: 'prepare',
      args: {
        projectRoot: '/tmp/app',
        projectName: 'Demo',
        stacks: ['node'],
        appendSession: true,
        adoptCurrentWorktree: true,
        sessionId: 's1',
      },
    });
  });

  it('parses an external worktree path as an adoption request', () => {
    expect(parseCliArgs(['node', 'rw', 'prepare', '--worktree-path', '../external-wt'])).toEqual({
      command: 'prepare',
      args: {
        stacks: [],
        appendSession: false,
        adoptCurrentWorktree: false,
        worktreePath: '../external-wt',
      },
    });
  });

  it('rejects invalid stacks', () => {
    expect(parseCliArgs(['node', 'rw', 'prepare', '--stack', 'rails'])).toEqual({
      command: 'error',
      message: 'Invalid stack: rails',
    });
  });

  it('rejects invalid session ids', () => {
    expect(parseCliArgs(['node', 'rw', 'prepare', '--session', 'worker-1'])).toEqual({
      command: 'error',
      message: 'Invalid session id: worker-1',
    });
  });

  it('rejects adopting the current worktree and a provided worktree path together', () => {
    expect(
      parseCliArgs([
        'node',
        'rw',
        'prepare',
        '--adopt-current-worktree',
        '--worktree-path',
        '../external-wt',
      ]),
    ).toEqual({
      command: 'error',
      message: '--adopt-current-worktree cannot be combined with --worktree-path',
    });
  });

  it('rejects a session id without runtime manifest emission', () => {
    expect(parseCliArgs(['node', 'rw', 'prepare', '--session', 's1'])).toEqual({
      command: 'error',
      message: '--session requires --adopt-current-worktree or --worktree-path',
    });
  });

  it('rejects unknown options', () => {
    expect(parseCliArgs(['node', 'rw', 'prepare', '--unknown'])).toEqual({
      command: 'error',
      message: 'Unknown option: --unknown',
    });
  });

  it('rejects missing option values', () => {
    expect(parseCliArgs(['node', 'rw', 'prepare', '--project-root'])).toEqual({
      command: 'error',
      message: 'Missing value for --project-root',
    });
  });
});

describe('runCli', () => {
  it('prepares RWAI state in the current directory', async () => {
    const projectRoot = await tempProject();
    const io = captureIo(projectRoot);

    const exitCode = await runCli(['node', 'rw', 'prepare', '--project-name', 'Demo'], io);

    expect(exitCode).toBe(0);
    expect(io.stderrText()).toBe('');
    expect(io.stdoutText()).toContain('RWAI state prepared');
    expect(await readFile(path.join(projectRoot, 'agents.config.json'), 'utf8')).toContain(
      '"name": "Demo"',
    );
    expect(await readFile(path.join(projectRoot, '.review-board', 'claims.json'), 'utf8')).toContain(
      '"s1"',
    );
  });

  it('can append the next session through prepare', async () => {
    const projectRoot = await tempProject();
    let io = captureIo(projectRoot);
    expect(await runCli(['node', 'rw', 'prepare', '--project-name', 'Demo'], io)).toBe(0);

    io = captureIo(projectRoot);
    const exitCode = await runCli(['node', 'rw', 'prepare', '--append-session'], io);

    expect(exitCode).toBe(0);
    expect(io.stdoutText()).toContain('Appended session: s2');
    expect(await readFile(path.join(projectRoot, 'agents.config.json'), 'utf8')).toContain('"s2"');
    expect(await readFile(path.join(projectRoot, '.review-board', 'claims.json'), 'utf8')).toContain(
      '"s2"',
    );
  });

  it('can adopt the current worktree and emit a runtime manifest through prepare', async () => {
    const projectRoot = await tempProject();
    const io = captureIo(projectRoot);

    const exitCode = await runCli(
      ['node', 'rw', 'prepare', '--project-name', 'Demo', '--adopt-current-worktree'],
      io,
    );

    const manifestPath = path.join(projectRoot, '.review-board', 'runtime-manifests', 's1.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
      worktree: { mode: string; resolvedPath: string };
      env: { entries: Array<{ key: string; value: string }> };
    };
    expect(exitCode).toBe(0);
    expect(io.stderrText()).toBe('');
    expect(io.stdoutText()).toContain(`Runtime manifest: ${manifestPath}`);
    expect(manifest.worktree.mode).toBe('external');
    expect(manifest.worktree.resolvedPath).toBe(projectRoot);
    expect(manifest.env.entries).toEqual(
      expect.arrayContaining([expect.objectContaining({ key: 'RW_SESSION', value: 's1' })]),
    );
  });

  it('can append and adopt an explicit session that is missing before append', async () => {
    const projectRoot = await tempProject();
    let io = captureIo(projectRoot);
    expect(await runCli(['node', 'rw', 'prepare', '--project-name', 'Demo'], io)).toBe(0);

    io = captureIo(projectRoot);
    const exitCode = await runCli(
      ['node', 'rw', 'prepare', '--append-session', '--adopt-current-worktree', '--session', 's2'],
      io,
    );

    const manifestPath = path.join(projectRoot, '.review-board', 'runtime-manifests', 's2.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as { session: { id: string } };
    expect(exitCode).toBe(0);
    expect(io.stderrText()).toBe('');
    expect(io.stdoutText()).toContain('Appended session: s2');
    expect(io.stdoutText()).toContain(`Runtime manifest: ${manifestPath}`);
    expect(manifest.session.id).toBe('s2');
  });

  it('returns a failure exit code and stderr when bootstrap fails', async () => {
    const projectRoot = await tempProject();
    await writeFile(path.join(projectRoot, 'agents.config.json'), '{"version":2}\n', 'utf8');
    const io = captureIo(projectRoot);

    const exitCode = await runCli(['node', 'rw', 'prepare'], io);

    expect(exitCode).toBe(1);
    expect(io.stdoutText()).toBe('');
    expect(io.stderrText()).toContain('Invalid agents.config.json');
    expect(io.stderrText()).toContain('No files were overwritten');
  });
});
