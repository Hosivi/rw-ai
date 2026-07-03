import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { err } from '../core/result.js';
import type { CommandRunner } from '../engine/exec.js';
import type { CliDeps } from './command.js';
import { parseAreas, runCli } from './run.js';

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
    homeDir: process.cwd(),
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
    expect(text).toContain('adapters');
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

  // The `--ttl=<v>` form forces the value even for `-5`, which parseArgs would
  // otherwise read as a flag — so all three reach the TTL validation branch.
  it.each(['0', '-5', 'abc'])('exits 2 for an invalid --ttl value %s', async (ttl) => {
    const { lines, deps } = capture();
    const code = await runCli(['claim', 's1', `--ttl=${ttl}`], deps);
    expect(code).toBe(2);
    expect(lines.join('\n')).toContain('TTL inválido');
  });

  it('exits 2 when a string option is missing its argument', async () => {
    // parseArgs throws for `--role` with no value; runCli maps it to a usage error.
    const { lines, deps } = capture();
    const code = await runCli(['init', '--role'], deps);
    expect(code).toBe(2);
    expect(lines.join('\n')).toContain('Uso: rw');
  });

  it('lists the scaffold command in --help', async () => {
    const { lines, deps } = capture();
    const code = await runCli(['--help'], deps);
    expect(code).toBe(0);
    expect(lines.join('\n')).toContain('scaffold');
  });

  it.each(['0', '-1', 'abc'])('exits 2 for an invalid --sessions value %s', async (sessions) => {
    const { lines, deps } = capture();
    const code = await runCli(['scaffold', `--sessions=${sessions}`], deps);
    expect(code).toBe(2);
    expect(lines.join('\n')).toContain('Sesiones inválidas');
  });

  it('exits 2 for an unknown --stacks entry', async () => {
    const { lines, deps } = capture();
    const code = await runCli(['scaffold', '--stacks', 'node,rust'], deps);
    expect(code).toBe(2);
    expect(lines.join('\n')).toContain('Stacks inválidos');
  });

  it('exits 2 for an invalid --db strategy', async () => {
    const { lines, deps } = capture();
    const code = await runCli(['scaffold', '--db', 'mongo'], deps);
    expect(code).toBe(2);
    expect(lines.join('\n')).toContain('Estrategia de base de datos inválida');
  });

  it('routes scaffold to its handler (context error outside a repo)', async () => {
    const { lines, deps } = capture({ cwd: '/anywhere', run: gitNotARepo, runRaw: gitNotARepo });
    const code = await runCli(['scaffold'], deps);
    expect(code).toBe(1);
    expect(lines.join('\n')).not.toContain('Comando desconocido');
    expect(lines.join('\n').toLowerCase()).toContain('git');
  });

  it('lists the sessions command in --help', async () => {
    const { lines, deps } = capture();
    const code = await runCli(['--help'], deps);
    expect(code).toBe(0);
    expect(lines.join('\n')).toContain('sessions');
  });

  it('routes sessions to its handler and exits 0 with no jobs', async () => {
    // A homeDir with no .claude/jobs yields an empty (not failed) listing.
    const { lines, deps } = capture({ homeDir: path.join(os.tmpdir(), 'rw-ai-no-such-home-xyz') });
    const code = await runCli(['sessions'], deps);
    expect(code).toBe(0);
    expect(lines.join('\n')).toContain('No hay sesiones de Claude Code');
  });

  it('lists the tokens command in --help', async () => {
    const { lines, deps } = capture();
    const code = await runCli(['--help'], deps);
    expect(code).toBe(0);
    expect(lines.join('\n')).toContain('tokens');
  });

  it('routes tokens to its handler (missing pricing.json outside a repo)', async () => {
    // Outside a repo the handler falls back to cwd/pricing.json, which is absent →
    // exit 1 naming pricing.json, proving the command was routed (not unknown).
    const { lines, deps } = capture({ cwd: '/anywhere', run: gitNotARepo, runRaw: gitNotARepo });
    const code = await runCli(['tokens', 'somefile.txt'], deps);
    expect(code).toBe(1);
    const text = lines.join('\n');
    expect(text).not.toContain('Comando desconocido');
    expect(text).toContain('pricing.json');
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

describe('parseAreas', () => {
  it('splits a comma list and drops blank entries from stray commas', () => {
    expect(parseAreas('a/**,,b/**')).toEqual(['a/**', 'b/**']);
  });

  it('trims surrounding whitespace around each glob', () => {
    expect(parseAreas(' a/** , b/** ')).toEqual(['a/**', 'b/**']);
  });

  it('returns undefined when no --areas was given', () => {
    expect(parseAreas(undefined)).toBeUndefined();
  });
});
