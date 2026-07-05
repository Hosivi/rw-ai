import type { AgentsConfig } from '../contract/schema.js';
import { assertNever } from '../core/assert.js';
import { err, ok, type Result } from '../core/result.js';
import { resolveMcpContext } from '../mcp/context.js';
import { writeAgentsConfig } from './config-io.js';
import { configure, type RunbookResult } from './configure.js';
import { detectBaseBranch, detectProject } from './detect.js';
import { runCommand, runCommandRaw, type CommandError, type CommandRunner } from './exec.js';
import { createGit, type GitError } from './git.js';
import { scaffoldConfig } from './scaffold.js';

// One-shot onboarding: from an empty directory OR a fresh git repo, get to a
// fully provisioned rw workspace in a single pass. It reuses the existing engine
// pieces (scaffold/detect/configure/resolveMcpContext) and only owns the two
// steps that were missing between them: `git init` and the very first commit.
export type BootstrapParams = {
  readonly cwd: string;
  readonly sessions?: number;
  readonly baseBranch?: string;
  readonly remote?: { readonly name?: string; readonly url: string };
  // Injected so board/test-wiring timestamps stay deterministic in tests.
  readonly now: Date;
  // Command runners are injectable so git can be stubbed and, in tests, so a git
  // identity / ceiling can be threaded into every invocation.
  readonly run?: CommandRunner;
  readonly runRaw?: CommandRunner;
};

export type BootstrapResult = {
  readonly gitInitialized: boolean;
  readonly remoteAdded?: string;
  readonly alreadyConfigured: boolean;
  readonly committed: boolean;
  readonly config?: AgentsConfig;
  readonly runbook?: RunbookResult;
};

export type BootstrapError = {
  readonly kind: 'inside-worktree' | 'git' | 'scaffold' | 'commit-identity' | 'io';
  readonly message: string;
  readonly cause?: unknown;
};

const DEFAULT_SESSION_COUNT = 2;
const DEFAULT_BASE_BRANCH = 'main';

const gitErrorMessage = (error: GitError): string => {
  switch (error.kind) {
    case 'spawn-failed':
    case 'parse-failed':
      return error.message;
    case 'non-zero-exit':
      return `git salió con código ${error.output.exitCode}: ${error.output.stderr.trim()}`;
    default:
      return assertNever(error);
  }
};

const commandErrorMessage = (error: CommandError): string =>
  error.kind === 'spawn-failed'
    ? error.message
    : `git salió con código ${error.output.exitCode}: ${error.output.stderr.trim()}`;

// git reports an unset identity through several distinct phrasings depending on
// version and locale; match the stable English fragments AND the config keys,
// which git prints verbatim regardless of locale. This is best-effort: on a match
// we surface a targeted 'commit-identity' error, otherwise the raw stderr.
const isIdentityError = (stderr: string): boolean =>
  /please tell me who you are/i.test(stderr) ||
  /empty ident name/i.test(stderr) ||
  /user\.name/i.test(stderr) ||
  /user\.email/i.test(stderr);

export const bootstrapRepo = async (
  params: BootstrapParams,
): Promise<Result<BootstrapResult, BootstrapError>> => {
  const { cwd, now } = params;
  const runner = params.run ?? runCommand;
  const rawRunner = params.runRaw ?? runCommandRaw;
  const git = createGit(cwd, params.run, params.runRaw);

  // 1. Guards FIRST — before any mutation. If this is already a repo, refuse to
  //    run from inside a session worktree, and short-circuit an already-configured
  //    repo without touching a single ref.
  const alreadyRepo = await git.isGitRepo();
  if (alreadyRepo) {
    const ctx = await resolveMcpContext(cwd, params.run, params.runRaw);
    if (ctx.ok) {
      if (ctx.value.currentSession !== undefined) {
        return err({
          kind: 'inside-worktree',
          message:
            'Ya estás dentro de un worktree de sesión de rw. Corre `rw bootstrap` desde la raíz del repo principal, no desde una sesión.',
        });
      }
      // Config resolves AND the integration branch already exists → the repo is
      // configured; do nothing.
      const integrationExists = await git.branchExists(ctx.value.config.git.integrationBranch);
      if (integrationExists.ok && integrationExists.value) {
        return ok({
          gitInitialized: false,
          committed: false,
          alreadyConfigured: true,
          config: ctx.value.config,
        });
      }
    }
  }

  // 2. git init if needed. The init branch is the requested base branch (or main),
  //    so the base branch is deterministic even before the first commit.
  let gitInitialized = false;
  if (!alreadyRepo) {
    const init = await git.initRepo(params.baseBranch ?? DEFAULT_BASE_BRANCH);
    if (!init.ok) {
      return err({
        kind: 'git',
        message: `no se pudo inicializar el repositorio git: ${gitErrorMessage(init.error)}`,
        cause: init.error,
      });
    }
    gitInitialized = true;
  }

  // 3. Remote (optional). addRemote is a soft no-op when the remote already exists.
  let remoteAdded: string | undefined;
  if (params.remote !== undefined) {
    const remoteName = params.remote.name ?? 'origin';
    const added = await git.addRemote(remoteName, params.remote.url);
    if (!added.ok) {
      return err({
        kind: 'git',
        message: `no se pudo agregar el remote '${remoteName}': ${gitErrorMessage(added.error)}`,
        cause: added.error,
      });
    }
    remoteAdded = remoteName;
  }

  // 4. Scaffold agents.config.json from what the repo looks like right now.
  const detection = await detectProject(cwd);
  const baseBranch = params.baseBranch ?? (await detectBaseBranch(git));
  const scaffolded = scaffoldConfig({
    projectName: detection.projectName,
    stacks: detection.stacks,
    sessionCount: params.sessions ?? DEFAULT_SESSION_COUNT,
    baseBranch,
    db: detection.db,
  });
  if (!scaffolded.ok) {
    return err({ kind: 'scaffold', message: scaffolded.error.message, cause: scaffolded.error });
  }
  const config = scaffolded.value;
  const written = await writeAgentsConfig(cwd, config);
  if (!written.ok) {
    return err({ kind: 'io', message: written.error.message, cause: written.error.cause });
  }

  // 5. Ensure the base branch has a commit BEFORE configure. Right after `git
  //    init` the base branch is UNBORN, so configure's integration-branch step
  //    (which branches off the base) would fail. We only commit when the base
  //    branch is missing as a ref — an existing repo with history is untouched.
  let committed = false;
  const baseExists = await git.branchExists(baseBranch);
  if (!baseExists.ok) {
    return err({
      kind: 'git',
      message: `no se pudo verificar la rama base '${baseBranch}': ${gitErrorMessage(baseExists.error)}`,
      cause: baseExists.error,
    });
  }
  if (!baseExists.value) {
    const staged = await runner('git', ['add', '-A'], { cwd });
    if (!staged.ok) {
      return err({
        kind: 'git',
        message: `no se pudo preparar el commit inicial (git add): ${commandErrorMessage(staged.error)}`,
        cause: staged.error,
      });
    }
    // rawRunner so a non-zero exit (e.g. missing identity) is inspectable data,
    // not an opaque failure.
    const commit = await rawRunner('git', ['commit', '-m', 'chore: rw bootstrap'], { cwd });
    if (!commit.ok) {
      return err({
        kind: 'git',
        message: `no se pudo crear el commit inicial: ${commandErrorMessage(commit.error)}`,
        cause: commit.error,
      });
    }
    if (commit.value.exitCode !== 0) {
      const stderr = commit.value.stderr;
      if (isIdentityError(stderr)) {
        return err({
          kind: 'commit-identity',
          message:
            'Configura tu identidad de git (git config user.name / user.email) antes de inicializar el repo.',
        });
      }
      return err({ kind: 'git', message: `no se pudo crear el commit inicial: ${stderr.trim()}` });
    }
    committed = true;
  }

  // 6. Configure. A runbook with ok:false is NOT a hard error here — it is
  //    reported to the caller, which decides the exit code.
  const runbook = await configure(config, cwd, {
    now,
    ...(params.run !== undefined ? { run: params.run } : {}),
    ...(params.runRaw !== undefined ? { runRaw: params.runRaw } : {}),
  });

  return ok({
    gitInitialized,
    alreadyConfigured: false,
    committed,
    config,
    runbook,
    ...(remoteAdded !== undefined ? { remoteAdded } : {}),
  });
};
