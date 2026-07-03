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

// `git merge-tree --write-tree` classifies a merge WITHOUT touching a working
// tree: clean, or conflict with the offending paths (from --name-only).
export type MergeTreeResult =
  | { readonly status: 'clean' }
  | { readonly status: 'conflict'; readonly files: readonly string[] };

// The name-only conflict block on the installed git (2.53) is: line 0 is the
// resulting tree OID, then the conflicted file names, then a BLANK line, then
// git's informational messages ("Auto-merging …", "CONFLICT (…): …"). Confirmed
// identical for content, add/add, and file/directory conflicts (the latter
// renames the file side, e.g. `foo` -> `foo~a`). The spec's suggested "collect
// every remaining non-empty line" would wrongly capture those messages as file
// names, so we stop at the first blank line. Two extra guards make this robust:
// leading blank lines right after the OID are tolerated (in case a future git
// inserts one), and an `Auto-merging `/`CONFLICT (` prefix also terminates the
// name block in case a future git omits the blank separator.
export const parseMergeTreeConflicts = (stdout: string): string[] => {
  const lines = stdout.split(/\r?\n/);
  const files: string[] = [];
  let index = 1; // skip the resulting-tree OID on line 0
  while (index < lines.length && lines[index] === '') {
    index += 1;
  }
  for (; index < lines.length; index += 1) {
    const line = lines[index];
    if (
      line === undefined ||
      line === '' || // blank line separates conflicted names from informational text
      line.startsWith('Auto-merging ') ||
      line.startsWith('CONFLICT (')
    ) {
      break;
    }
    files.push(line);
  }
  return files;
};

export type Git = {
  readonly version: () => Promise<Result<GitVersion, GitError>>;
  readonly toplevel: () => Promise<Result<string, GitError>>;
  readonly branchExists: (name: string) => Promise<Result<boolean, GitError>>;
  // Read-only integrator primitives: inspect what a branch changed and simulate
  // a merge, both without mutating any working tree.
  readonly changedFiles: (base: string, branch: string) => Promise<Result<string[], GitError>>;
  readonly mergeTree: (
    branchA: string,
    branchB: string,
  ) => Promise<Result<MergeTreeResult, GitError>>;
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

  const changedFiles: Git['changedFiles'] = async (base, branch) => {
    // THREE dots: changes on `branch` since it diverged from `base` (relative to
    // their merge-base), which is exactly a session's contribution. Strict `run`:
    // a bad ref here is a genuine error, not data.
    // -c core.quotePath=false: with git's default (quotePath=true) a non-ASCII
    // path comes back C-escaped AND double-quoted (e.g. `"caf\303\251.ts"`),
    // which would never match a raw glob string and would misclassify an in-area
    // file as an invasion. Force raw UTF-8 output instead.
    const result = await inRepo([
      '-c',
      'core.quotePath=false',
      'diff',
      '--name-only',
      `${base}...${branch}`,
    ]);
    if (!result.ok) {
      return result;
    }
    // git prints one forward-slash path per line; drop the trailing-newline
    // empty and any blank lines. Paths are NOT trimmed so names with spaces stay
    // intact.
    const files = result.value.stdout.split(/\r?\n/).filter((line) => line.length > 0);
    return ok(files);
  };

  const mergeTree: Git['mergeTree'] = async (branchA, branchB) => {
    // runRaw, not run: a conflict exits 1 but is a valid outcome. Classify by
    // EXIT CODE only — git's text is gettext-translated, so matching "CONFLICT"
    // would misclassify under another locale. --write-tree computes the merge in
    // the object store (no working tree), --name-only trims the conflict block to
    // bare file names. Exit 0 = clean, 1 = conflicts, anything else = real error.
    const result = await runRaw(
      'git',
      ['merge-tree', '--write-tree', '--name-only', branchA, branchB],
      { cwd: repoRoot },
    );
    if (!result.ok) {
      return result;
    }
    const output = result.value;
    if (output.exitCode === 0) {
      return ok({ status: 'clean' });
    }
    if (output.exitCode === 1) {
      return ok({ status: 'conflict', files: parseMergeTreeConflicts(output.stdout) });
    }
    return err({ kind: 'non-zero-exit', output });
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
    changedFiles,
    mergeTree,
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
