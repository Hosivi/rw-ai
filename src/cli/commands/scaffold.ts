import type { DbStrategy, Stack } from '../../contract/schema.js';
import { agentsConfigPath, readAgentsConfig, writeAgentsConfig } from '../../engine/config-io.js';
import type { DbDetection } from '../../engine/database.js';
import { detectBaseBranch, detectProject } from '../../engine/detect.js';
import { createGit } from '../../engine/git.js';
import { scaffoldConfig } from '../../engine/scaffold.js';
import type { CliDeps, CommandResult } from '../command.js';
import { isInteractive, promptSessionCount } from '../prompts.js';

// Onboarding entry point. `rw scaffold` detects a fresh repo's stack and writes a
// sensible default agents.config.json, after which `rw configure` can provision
// it. Every other command needs that file, so this closes the bootstrap gap.

export type ScaffoldArgs = {
  readonly sessions?: number;
  readonly stacks?: Stack[];
  readonly db?: DbStrategy;
  readonly baseBranch?: string;
  readonly force?: boolean;
};

// Default session count when neither a flag nor an interactive answer sets it.
const DEFAULT_SESSION_COUNT = 2;

// Applies an explicit --db strategy over what was detected. Host/port/sources are
// preserved, but service/user are dropped: they belonged to the detected
// strategy and would be meaningless (or invalid) under a different one.
const overrideDbStrategy = (detected: DbDetection, strategy: DbStrategy): DbDetection => ({
  strategy,
  host: detected.host,
  port: detected.port,
  sources: detected.sources,
});

export const runScaffold = async (args: ScaffoldArgs, deps: CliDeps): Promise<CommandResult> => {
  // 1. Resolve the repo root directly (loadContext would require an existing
  //    config — exactly what we are here to create).
  const git = createGit(deps.cwd, deps.run, deps.runRaw);
  const toplevel = await git.toplevel();
  if (!toplevel.ok) {
    return {
      lines: [
        `No estás dentro de un repositorio git (${deps.cwd}). Ejecuta rw dentro de un repositorio con git inicializado.`,
      ],
      exitCode: 1,
    };
  }
  const projectRoot = toplevel.value;

  // 2. Refuse to clobber an existing config unless forced. An existing-but-invalid
  //    config still counts as existing (only 'not-found' means truly absent).
  const existing = await readAgentsConfig(projectRoot);
  const configExists = existing.ok || existing.error.kind !== 'not-found';
  if (configExists && args.force !== true) {
    return {
      lines: [
        `Ya existe ${agentsConfigPath(projectRoot)}. Usa --force para sobrescribirlo.`,
      ],
      exitCode: 1,
    };
  }

  // 3. Detect the project, then resolve final inputs: flags win over detection,
  //    detection over defaults.
  const detection = await detectProject(projectRoot);
  const interactive = deps.interactive ?? isInteractive();

  const detectedStacks = args.stacks ?? detection.stacks;
  const usedNodeFallback = detectedStacks.length === 0;
  const stacks: Stack[] = usedNodeFallback ? ['node'] : detectedStacks;

  const sessionCount =
    args.sessions ?? (await promptSessionCount(DEFAULT_SESSION_COUNT, interactive));

  const db =
    args.db === undefined ? detection.db : overrideDbStrategy(detection.db, args.db);

  // An explicit --base-branch wins; otherwise detect the repo's real base branch
  // (main, else master, else the current branch) so it points at a branch that
  // exists and `rw configure`'s integration-branch step does not fail.
  const baseBranch = args.baseBranch ?? (await detectBaseBranch(git));

  // 4. Build and write the config.
  const scaffolded = scaffoldConfig({
    projectName: detection.projectName,
    stacks,
    sessionCount,
    baseBranch,
    db,
  });
  if (!scaffolded.ok) {
    return {
      lines: [
        `No se pudo generar agents.config.json: ${scaffolded.error.message}`,
        ...(scaffolded.error.issues ?? []).map((issue) => `- ${issue}`),
      ],
      exitCode: 1,
    };
  }
  const written = await writeAgentsConfig(projectRoot, scaffolded.value);
  if (!written.ok) {
    return {
      lines: [`No se pudo escribir agents.config.json: ${written.error.message}`],
      exitCode: 1,
    };
  }

  // 5. Summarize what was detected and point at the next step.
  const stacksLine = usedNodeFallback
    ? `Stacks: ${stacks.join(', ')} (por defecto, no se detectó ningún stack)`
    : `Stacks detectados: ${stacks.join(', ')}`;
  return {
    lines: [
      `Proyecto: ${detection.projectName}`,
      stacksLine,
      `Rama base: ${baseBranch}`,
      `Estrategia de base de datos: ${db.strategy}`,
      `Sesiones configuradas: ${sessionCount}`,
      `Escribí ${agentsConfigPath(projectRoot)}`,
      'Ahora corre `rw configure` para provisionar el repo.',
    ],
    exitCode: 0,
  };
};
