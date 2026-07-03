import { err, ok, type Result } from '../core/result.js';
import {
  runCommand,
  runCommandRaw,
  trimmedStdout,
  type CommandError,
  type CommandRunner,
} from './exec.js';

export type GitVersion = {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  readonly raw: string;
};

export type GitError = CommandError | { readonly kind: 'parse-failed'; readonly message: string };

// `merge-tree --write-tree` (the conflict-detection primitive the integrator
// phase relies on) landed in git 2.38.
export const MIN_GIT_VERSION = { major: 2, minor: 38 } as const;

export const supportsMergeTree = (version: { major: number; minor: number }): boolean =>
  version.major > MIN_GIT_VERSION.major ||
  (version.major === MIN_GIT_VERSION.major && version.minor >= MIN_GIT_VERSION.minor);

// Git for Windows reports e.g. "git version 2.51.0.windows.1": only the first
// three numeric parts are the version, the rest is a distributor suffix.
const VERSION_PATTERN = /git version (\d+)\.(\d+)\.(\d+)/;

export const parseGitVersion = (raw: string): Result<GitVersion, GitError> => {
  const match = VERSION_PATTERN.exec(raw);
  if (match === null) {
    return err({ kind: 'parse-failed', message: `unrecognized git version output: ${raw.trim()}` });
  }
  const [, major = '', minor = '', patch = ''] = match;
  return ok({ major: Number(major), minor: Number(minor), patch: Number(patch), raw: raw.trim() });
};

// git prints forward-slash paths even on Windows, and drive-letter casing can
// vary between producers, so path comparisons must tolerate both.
export const normalizeRepoPath = (value: string): string => {
  const forward = value.replace(/\\/g, '/');
  return /^[A-Za-z]:/.test(forward) ? forward.charAt(0).toLowerCase() + forward.slice(1) : forward;
};

export type WorktreeInfo = {
  readonly path: string;
  readonly head: string;
  readonly branch?: string;
};

// Porcelain blocks are blank-line separated; detached entries simply have no
// `branch refs/heads/x` line. Paths come back normalized for comparison.
export const parseWorktreeList = (stdout: string): WorktreeInfo[] => {
  const entries: WorktreeInfo[] = [];
  let current: { path?: string; head?: string; branch?: string } = {};
  const flush = (): void => {
    if (current.path !== undefined) {
      entries.push({
        path: normalizeRepoPath(current.path),
        head: current.head ?? '',
        ...(current.branch !== undefined ? { branch: current.branch } : {}),
      });
    }
    current = {};
  };
  for (const line of stdout.split(/\r?\n/)) {
    if (line === '') {
      flush();
    } else if (line.startsWith('worktree ')) {
      current.path = line.slice('worktree '.length);
    } else if (line.startsWith('HEAD ')) {
      current.head = line.slice('HEAD '.length);
    } else if (line.startsWith('branch ')) {
      current.branch = line.slice('branch '.length).replace(/^refs\/heads\//, '');
    }
    // 'detached', 'bare', 'locked', 'prunable' lines carry no data we track.
  }
  flush();
  return entries;
};

export type Git = {
  readonly version: () => Promise<Result<GitVersion, GitError>>;
  readonly toplevel: () => Promise<Result<string, GitError>>;
  readonly branchExists: (name: string) => Promise<Result<boolean, GitError>>;
  readonly createBranch: (name: string, from: string) => Promise<Result<void, GitError>>;
  readonly currentBranch: () => Promise<Result<string, GitError>>;
  readonly listWorktrees: () => Promise<Result<WorktreeInfo[], GitError>>;
  readonly addWorktree: (worktreePath: string, branch: string) => Promise<Result<void, GitError>>;
  // The following move THIS working tree's HEAD, so lifecycle only calls them on
  // a session worktree (via createGit(worktreePath, ...)), never the main copy.
  readonly switchBranch: (name: string) => Promise<Result<void, GitError>>;
  readonly switchNewBranch: (name: string, from: string) => Promise<Result<void, GitError>>;
  readonly mergeNoFf: (
    branch: string,
    message?: string,
  ) => Promise<Result<{ status: 'merged' | 'conflict' }, GitError>>;
  readonly mergeAbort: () => Promise<Result<void, GitError>>;
  readonly deleteBranch: (name: string) => Promise<Result<void, GitError>>;
  readonly statusPorcelain: () => Promise<Result<string, GitError>>;
};

export const createGit = (
  repoRoot: string,
  run: CommandRunner = runCommand,
  runRaw: CommandRunner = runCommandRaw,
): Git => {
  const inRepo = (args: string[]): ReturnType<CommandRunner> => run('git', args, { cwd: repoRoot });

  const version: Git['version'] = async () => {
    const result = await inRepo(['--version']);
    return result.ok ? parseGitVersion(trimmedStdout(result.value)) : result;
  };

  const toplevel: Git['toplevel'] = async () => {
    const result = await inRepo(['rev-parse', '--show-toplevel']);
    return result.ok ? ok(normalizeRepoPath(trimmedStdout(result.value))) : result;
  };

  const branchExists: Git['branchExists'] = async (name) => {
    // --quiet turns "unknown ref" from a fatal error into a plain exit 1, so a
    // missing branch is data, not a failure — hence the raw runner.
    const result = await runRaw('git', ['rev-parse', '--verify', '--quiet', `refs/heads/${name}`], {
      cwd: repoRoot,
    });
    if (!result.ok) {
      return result;
    }
    if (result.value.exitCode === 0) {
      return ok(true);
    }
    if (result.value.exitCode === 1) {
      return ok(false);
    }
    return err({ kind: 'non-zero-exit', output: result.value });
  };

  const createBranch: Git['createBranch'] = async (name, from) => {
    // `git branch`, never `checkout -b`: the main working copy must not switch.
    const result = await inRepo(['branch', name, from]);
    return result.ok ? ok(undefined) : result;
  };

  const currentBranch: Git['currentBranch'] = async () => {
    const result = await inRepo(['rev-parse', '--abbrev-ref', 'HEAD']);
    return result.ok ? ok(trimmedStdout(result.value)) : result;
  };

  const listWorktrees: Git['listWorktrees'] = async () => {
    const result = await inRepo(['worktree', 'list', '--porcelain']);
    return result.ok ? ok(parseWorktreeList(result.value.stdout)) : result;
  };

  const addWorktree: Git['addWorktree'] = async (worktreePath, branch) => {
    const result = await inRepo(['worktree', 'add', worktreePath, branch]);
    return result.ok ? ok(undefined) : result;
  };

  const switchBranch: Git['switchBranch'] = async (name) => {
    // `git switch` refuses a branch already checked out in another worktree; the
    // CommandError is surfaced as-is so the caller can explain the contention.
    const result = await inRepo(['switch', name]);
    return result.ok ? ok(undefined) : result;
  };

  const switchNewBranch: Git['switchNewBranch'] = async (name, from) => {
    const result = await inRepo(['switch', '-c', name, from]);
    return result.ok ? ok(undefined) : result;
  };

  const mergeNoFf: Git['mergeNoFf'] = async (branch, message) => {
    const args =
      message === undefined
        ? ['merge', '--no-ff', branch]
        : ['merge', '--no-ff', '-m', message, branch];
    // runRaw, not run: a merge conflict exits non-zero but is a valid outcome,
    // not a spawn/usage failure — only inspecting the exit code tells them apart.
    const result = await runRaw('git', args, { cwd: repoRoot });
    if (!result.ok) {
      return result;
    }
    const output = result.value;
    // Detect by exit code, never by message text: git output is gettext-
    // translated by locale, so matching the English word "CONFLICT" would
    // misclassify a real conflict under another locale. `git merge` exits 0 on
    // success (incl. "Already up to date"), exactly 1 when it stops on
    // conflicts, and other non-zero codes (e.g. 128) on genuine errors such as
    // unrelated histories or a bad ref.
    if (output.exitCode === 0) {
      return ok({ status: 'merged' });
    }
    if (output.exitCode === 1) {
      return ok({ status: 'conflict' });
    }
    return err({ kind: 'non-zero-exit', output });
  };

  const mergeAbort: Git['mergeAbort'] = async () => {
    const result = await inRepo(['merge', '--abort']);
    return result.ok ? ok(undefined) : result;
  };

  const deleteBranch: Git['deleteBranch'] = async (name) => {
    // -D force-deletes at the ref level (safe from repoRoot as long as the
    // branch is not checked out in any worktree); merged-state is not required.
    const result = await inRepo(['branch', '-D', name]);
    return result.ok ? ok(undefined) : result;
  };

  const statusPorcelain: Git['statusPorcelain'] = async () => {
    const result = await inRepo(['status', '--porcelain']);
    return result.ok ? ok(trimmedStdout(result.value)) : result;
  };

  return {
    version,
    toplevel,
    branchExists,
    createBranch,
    currentBranch,
    listWorktrees,
    addWorktree,
    switchBranch,
    switchNewBranch,
    mergeNoFf,
    mergeAbort,
    deleteBranch,
    statusPorcelain,
  };
};
