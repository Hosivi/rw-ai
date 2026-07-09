#!/usr/bin/env node
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ensureRwState } from './bootstrap.js';
import { isErr } from './core/result.js';
import { sessionIdSchema, stackSchema, type Stack } from './contract/schema.js';

export type CliIo = {
  cwd: () => string;
  stdout: { write: (message: string) => void };
  stderr: { write: (message: string) => void };
};

const HELP = `rw-ai

Usage:
  rw prepare [--project-root <path>] [--project-name <name>] [--stack <stack>] [--append-session] [--adopt-current-worktree] [--worktree-path <path>] [--session <id>]

Commands:
  prepare   Ensure agents.config.json, the review-board directory, and claims.json exist.

Options:
  --append-session       Append the next dynamic session before reconciling claims.
  --adopt-current-worktree
                         Emit a runtime manifest for the current worktree.
  --worktree-path <path> Adopt this external worktree path and emit a runtime manifest.
  --session <id>         Session id to bind when adopting a worktree. Defaults to the appended or first active session.
  --project-root <path>  Target project root. Defaults to the current directory.
  --project-name <name>  Project name used only when creating agents.config.json.
  --stack <stack>        Stack used only when creating agents.config.json. Repeatable.
  --help                 Show this help.
`;

type PrepareArgs = {
  projectRoot?: string;
  projectName?: string;
  stacks: Stack[];
  appendSession: boolean;
  adoptCurrentWorktree: boolean;
  worktreePath?: string;
  sessionId?: string;
};

type ParsedArgs =
  | { command: 'help' }
  | { command: 'prepare'; args: PrepareArgs }
  | { command: 'error'; message: string };

const readOptionValue = (argv: string[], index: number, option: string): string | undefined => {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith('--')) {
    return undefined;
  }
  return value;
};

export const parseCliArgs = (argv: string[]): ParsedArgs => {
  const [, , command, ...rest] = argv;
  if (command === undefined || command === '--help' || command === '-h') {
    return { command: 'help' };
  }
  if (command !== 'prepare') {
    return { command: 'error', message: `Unknown command: ${command}` };
  }

  const args: PrepareArgs = { stacks: [], appendSession: false, adoptCurrentWorktree: false };
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index]!;
    if (token === '--help' || token === '-h') {
      return { command: 'help' };
    }
    if (token === '--append-session') {
      args.appendSession = true;
      continue;
    }
    if (token === '--adopt-current-worktree') {
      args.adoptCurrentWorktree = true;
      continue;
    }
    if (
      token === '--project-root' ||
      token === '--project-name' ||
      token === '--stack' ||
      token === '--worktree-path' ||
      token === '--session'
    ) {
      const value = readOptionValue(rest, index, token);
      if (value === undefined) {
        return { command: 'error', message: `Missing value for ${token}` };
      }
      index += 1;
      if (token === '--project-root') {
        args.projectRoot = value;
      } else if (token === '--project-name') {
        args.projectName = value;
      } else if (token === '--stack') {
        const parsedStack = stackSchema.safeParse(value);
        if (!parsedStack.success) {
          return { command: 'error', message: `Invalid stack: ${value}` };
        }
        args.stacks.push(parsedStack.data);
      } else if (token === '--worktree-path') {
        args.worktreePath = value;
      } else {
        const parsedSession = sessionIdSchema.safeParse(value);
        if (!parsedSession.success) {
          return { command: 'error', message: `Invalid session id: ${value}` };
        }
        args.sessionId = parsedSession.data;
      }
      continue;
    }
    return { command: 'error', message: `Unknown option: ${token}` };
  }

  if (args.adoptCurrentWorktree && args.worktreePath !== undefined) {
    return {
      command: 'error',
      message: '--adopt-current-worktree cannot be combined with --worktree-path',
    };
  }
  if (args.sessionId !== undefined && !args.adoptCurrentWorktree && args.worktreePath === undefined) {
    return {
      command: 'error',
      message: '--session requires --adopt-current-worktree or --worktree-path',
    };
  }

  return { command: 'prepare', args };
};

export const runCli = async (argv: string[], io: CliIo): Promise<number> => {
  const parsed = parseCliArgs(argv);
  if (parsed.command === 'help') {
    io.stdout.write(HELP);
    return 0;
  }
  if (parsed.command === 'error') {
    io.stderr.write(`${parsed.message}\n\n${HELP}`);
    return 1;
  }

  const shouldAdoptWorktree = parsed.args.adoptCurrentWorktree || parsed.args.worktreePath !== undefined;
  const runtimeManifest = shouldAdoptWorktree
    ? {
        sessionId: parsed.args.sessionId,
        worktreePath: path.resolve(io.cwd(), parsed.args.worktreePath ?? io.cwd()),
        source:
          parsed.args.worktreePath === undefined
            ? ('current-worktree' as const)
            : ('provided-worktree' as const),
      }
    : undefined;

  const result = await ensureRwState({
    projectRoot: parsed.args.projectRoot ?? io.cwd(),
    projectName: parsed.args.projectName,
    stacks: parsed.args.stacks.length > 0 ? parsed.args.stacks : undefined,
    appendSession: parsed.args.appendSession,
    runtimeManifest,
  });
  if (isErr(result)) {
    io.stderr.write(`${result.error.message}\n`);
    for (const issue of result.error.issues) {
      io.stderr.write(`- ${issue}\n`);
    }
    return 1;
  }

  const appended = result.value.appendedSession?.id;
  io.stdout.write(`RWAI state prepared at ${result.value.projectRoot}\n`);
  io.stdout.write(`Config: ${result.value.configPath}\n`);
  io.stdout.write(`Board: ${result.value.boardDir}\n`);
  io.stdout.write(`Claims: ${result.value.claimsPath}\n`);
  io.stdout.write(`Actions: ${result.value.actions.join(', ')}\n`);
  if (appended !== undefined) {
    io.stdout.write(`Appended session: ${appended}\n`);
  }
  for (const manifest of result.value.runtimeManifests) {
    io.stdout.write(`Runtime manifest: ${manifest.manifestPath}\n`);
  }
  return 0;
};

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const exitCode = await runCli(process.argv, {
    cwd: process.cwd,
    stdout: process.stdout,
    stderr: process.stderr,
  });
  process.exitCode = exitCode;
}
