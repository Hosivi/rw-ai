import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { err } from '../core/result.js';
import type { CommandRunner } from '../engine/exec.js';
import type { CliDeps } from './command.js';
import { runCli } from './run.js';

const NOW = new Date('2026-07-02T12:00:00.000Z');

// The version the bin should report, read from the same package.json runCli does.
const packageVersion = (): string => {
  const raw = readFileSync(fileURLToPath(new URL('../../package.json', import.meta.url)), 'utf8');
  return (JSON.parse(raw) as { version: string }).version;
};

// A capturing writer so routing is asserted on data, never on real stdout.
const capture = (
  overrides: Partial<CliDeps> = {},
): { lines: string[]; deps: CliDeps } => {
  const lines: string[] = [];
  const deps: CliDeps = {
    cwd: process.cwd(),
    env: {},
    now: NOW,
    write: (line) => lines.push(line),
    ...overrides,
  };
  return { lines, deps };
};

// git rev-parse fails exactly as it does outside a repo, so any routed handler
// deterministically hits the context error instead of the real filesystem.
const gitNotARepo: CommandRunner = async () =>
  err({ kind: 'non-zero-exit', output: { stdout: '', stderr: 'fatal: not a git repository', exitCode: 128 } });

describe('runCli', () => {
  it('prints the package version for --version and exits 0', async () => {
    const { lines, deps } = capture();
    const code = await runCli(['--version'], deps);
    expect(code).toBe(0);
    expect(lines.join('\n')).toContain(packageVersion());
  });

  it('prints the package version for the -v alias', async () => {
    const { lines, deps } = capture();
    const code = await runCli(['-v'], deps);
    expect(code).toBe(0);
    expect(lines.join('\n')).toContain(packageVersion());
  });

  it('lists the commands for --help and exits 0', async () => {
    const { lines, deps } = capture();
    const code = await runCli(['--help'], deps);
    expect(code).toBe(0);
    const text = lines.join('\n');
    expect(text).toContain('configure');
    expect(text).toContain('roles');
    expect(text).toContain('check');
  });

  it('prints usage and exits 0 when no command is given', async () => {
    const { lines, deps } = capture();
    const code = await runCli([], deps);
    expect(code).toBe(0);
    expect(lines.join('\n')).toContain('Uso: rw');
  });

  it('exits 2 with usage for an unknown command', async () => {
    const { lines, deps } = capture();
    const code = await runCli(['frobnicate'], deps);
    expect(code).toBe(2);
    const text = lines.join('\n');
    expect(text).toContain('Comando desconocido');
    expect(text).toContain('configure');
  });

  it('exits 2 with usage for an unknown option', async () => {
    const { lines, deps } = capture();
    const code = await runCli(['roles', '--nope'], deps);
    expect(code).toBe(2);
    expect(lines.join('\n')).toContain('Uso: rw');
  });

  it('exits 2 for an invalid --agent value', async () => {
    const { lines, deps } = capture();
    const code = await runCli(['claim', 's1', '--agent', 'robot'], deps);
    expect(code).toBe(2);
    expect(lines.join('\n')).toContain('Agente inválido');
  });

  it('routes a real command to its handler', async () => {
    const { lines, deps } = capture({ cwd: '/anywhere', run: gitNotARepo, runRaw: gitNotARepo });
    const code = await runCli(['roles'], deps);
    // The handler ran and hit the context error — not the unknown-command path.
    expect(code).toBe(1);
    const text = lines.join('\n');
    expect(text).not.toContain('Comando desconocido');
    expect(text.toLowerCase()).toContain('git');
  });
});
