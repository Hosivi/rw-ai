import type { CommandRunner } from '../engine/exec.js';
import type { CliContextError } from './context.js';
import { formatContextError } from './output.js';

// Every command handler returns this instead of touching the process: the lines
// to print and the exit code the bin will hand to `process.exitCode`. Keeping it
// data (not a side effect) is what makes handlers unit-testable without a TTY.
export type CommandResult = {
  readonly lines: readonly string[];
  readonly exitCode: number;
};

// The injected world a handler runs in. Every impurity a command could reach for
// — the cwd, the environment it reads identity from, the clock, the command
// runners, whether a TTY is attached, and the sink it prints through — arrives
// here so nothing reads `process.*`/`console.*` directly except the bin.
export type CliDeps = {
  readonly cwd: string;
  // The machine home dir (os.homedir() in the bin). Only `rw sessions` reads it —
  // to locate Claude Code's job store under ~/.claude/jobs — but it lives here so
  // no handler ever touches os/process directly. Existing handlers ignore it.
  readonly homeDir: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly now: Date;
  readonly run?: CommandRunner;
  readonly runRaw?: CommandRunner;
  readonly interactive?: boolean;
  readonly write?: (s: string) => void;
};

// The single mapping every command uses when loadContext fails: the Spanish
// context message on one line, exit 1. Centralized so no handler re-invents it.
export const contextErrorResult = (error: CliContextError): CommandResult => ({
  lines: [formatContextError(error)],
  exitCode: 1,
});
