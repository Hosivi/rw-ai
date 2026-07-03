import { ENV_KEYS } from '../../contract/env.js';
import { assertNever } from '../../core/assert.js';
import { finishSession, type LifecycleError } from '../../engine/lifecycle.js';
import { contextErrorResult, type CliDeps, type CommandResult } from '../command.js';
import { loadContext } from '../context.js';

// Spanish reason per LifecycleError kind. finishSession orders the only
// irreversible step last, so most of these are recoverable states the user can
// act on (dirty tree, busy integration branch, conflicting merge).
const describeLifecycleError = (error: LifecycleError): string => {
  switch (error.kind) {
    case 'unknown-session':
      return `No existe una sesión activa '${error.sessionId ?? ''}' en agents.config.json.`;
    case 'invalid-rotation':
      return `Nombre de rama rotada inválido: ${error.message}`;
    case 'branch-exists':
      return `La rama rotada ya existe: ${error.message}`;
    case 'worktree-not-on-branch':
      return `El worktree no está en la rama de la sesión: ${error.message}`;
    case 'dirty-worktree':
      return 'El worktree tiene cambios sin commitear. Haz commit o stash antes de finalizar.';
    case 'integration-busy':
      return 'La rama de integración está ocupada por otro finish. Corre los finish de a uno.';
    case 'merge-conflict':
      return `El merge hacia la rama de integración tuvo conflictos: ${error.message}`;
    case 'recovery-failed':
      return `Fallo grave durante el finish: ${error.message}`;
    case 'config-write-failed':
      return `Se rotaron las ramas pero no se pudo actualizar agents.config.json: ${error.message}`;
    case 'git':
      return `Error de git al finalizar la sesión: ${error.message}`;
    default:
      return assertNever(error.kind);
  }
};

export type FinishArgs = {
  readonly session?: string;
  readonly newBranch?: string;
};

// `rw finish [sesión]`: take the session from the positional or from RW_SESSION,
// integrate it, and rotate its branch. A missing session id is a usage error (2).
export const runFinish = async (args: FinishArgs, deps: CliDeps): Promise<CommandResult> => {
  const sessionId = args.session ?? deps.env[ENV_KEYS.session];
  if (sessionId === undefined || sessionId === '') {
    return {
      lines: ['Falta la sesión. Pasa el id (rw finish s1) o exporta RW_SESSION.'],
      exitCode: 2,
    };
  }
  const context = await loadContext(deps.cwd, deps.run, deps.runRaw);
  if (!context.ok) {
    return contextErrorResult(context.error);
  }
  const finished = await finishSession({
    config: context.value.config,
    projectRoot: context.value.projectRoot,
    sessionId,
    ...(args.newBranch !== undefined ? { newBranch: args.newBranch } : {}),
    run: deps.run,
    runRaw: deps.runRaw,
  });
  if (!finished.ok) {
    return { lines: [describeLifecycleError(finished.error)], exitCode: 1 };
  }
  const result = finished.value;
  const lines = [
    `Sesión ${result.sessionId}: ${result.oldBranch} → ${result.newBranch} (integrado en ${result.integrationBranch})`,
  ];
  if (!result.oldBranchDeleted && result.warning !== undefined) {
    lines.push(result.warning);
  }
  return { lines, exitCode: 0 };
};
