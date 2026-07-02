import { spawn } from 'node:child_process';
import { err, ok, type Result } from '../core/result.js';

export type CommandOutput = {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
};

export type CommandError =
  | { readonly kind: 'spawn-failed'; readonly message: string }
  | { readonly kind: 'non-zero-exit'; readonly output: CommandOutput };

export type RunCommandOptions = {
  readonly cwd: string;
  // Overrides are merged over process.env so PATH and HOME survive.
  readonly env?: Readonly<Record<string, string>>;
};

export type CommandRunner = (
  command: string,
  args: readonly string[],
  opts: RunCommandOptions,
) => Promise<Result<CommandOutput, CommandError>>;

// ok for ANY completed process: `git merge-tree` exits 1 to mean "conflicts",
// so for some callers a non-zero exit is data, not a failure.
export const runCommandRaw: CommandRunner = (command, args, opts) =>
  new Promise((resolve) => {
    let settled = false;
    const settle = (result: Result<CommandOutput, CommandError>): void => {
      if (!settled) {
        settled = true;
        resolve(result);
      }
    };
    let child: ReturnType<typeof spawn>;
    try {
      // shell: false always — args passed as an array reach the process
      // verbatim, the only quoting-safe way to handle Windows paths with spaces.
      // spawn can also throw synchronously (e.g. EINVAL for .cmd shims on
      // Windows since the CVE-2024-27980 patch), hence the try/catch.
      child = spawn(command, args, {
        cwd: opts.cwd,
        env: opts.env === undefined ? process.env : { ...process.env, ...opts.env },
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      settle(
        err({
          kind: 'spawn-failed',
          message: `failed to spawn '${command}': ${error instanceof Error ? error.message : String(error)}`,
        }),
      );
      return;
    }
    let stdout = '';
    let stderr = '';
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr?.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.on('error', (error) =>
      settle(err({ kind: 'spawn-failed', message: `failed to spawn '${command}': ${error.message}` })),
    );
    // 'close' (not 'exit') so stdio is fully flushed. A null code means the
    // process was killed by a signal — mapped to -1 to keep exitCode numeric.
    child.on('close', (code) => settle(ok({ stdout, stderr, exitCode: code ?? -1 })));
  });

// Strict variant: ok only for exit 0 — the default for commands where any
// non-zero exit is a real failure.
export const runCommand: CommandRunner = async (command, args, opts) => {
  const result = await runCommandRaw(command, args, opts);
  if (!result.ok) {
    return result;
  }
  return result.value.exitCode === 0
    ? result
    : err({ kind: 'non-zero-exit', output: result.value });
};

// Trimming lives here, NOT inside runCommand: some callers need byte-exact
// output (porcelain formats), so stripping is always an explicit choice.
export const trimmedStdout = (output: CommandOutput): string => output.stdout.trim();
