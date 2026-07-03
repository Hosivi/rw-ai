import { assertNever } from '../../core/assert.js';
import {
  addSession,
  archiveSession,
  type AddSessionParams,
  type ConfigureAdminError,
} from '../../engine/configure.js';
import { contextErrorResult, type CliDeps, type CommandResult } from '../command.js';
import { loadContext } from '../context.js';

// Spanish reason per admin error. addSession/archiveSession never provision —
// they only edit agents.config.json — so the fix is always re-running configure
// or correcting the config, never a retry of the same call.
const describeAdminError = (error: ConfigureAdminError): string => {
  switch (error.kind) {
    case 'session-not-found':
      return `No existe la sesión: ${error.message}`;
    case 'already-archived':
      return `La sesión ya está archivada: ${error.message}`;
    case 'max-sessions':
      return `Llegaste al máximo de sesiones: ${error.message}`;
    case 'invalid-config':
      return `La configuración quedaría inválida: ${error.message}`;
    case 'io':
      return `Error de entrada/salida al guardar la configuración: ${error.message}`;
    default:
      return assertNever(error.kind);
  }
};

export type AddSessionArgs = {
  readonly areas?: readonly string[];
  readonly branch?: string;
};

// `rw add-session`: append the next session to the config and remind the user to
// re-run configure so its branch, worktree and env actually get provisioned.
export const runAddSession = async (
  args: AddSessionArgs,
  deps: CliDeps,
): Promise<CommandResult> => {
  const context = await loadContext(deps.cwd, deps.run, deps.runRaw);
  if (!context.ok) {
    return contextErrorResult(context.error);
  }
  const params: AddSessionParams = {
    ...(args.areas !== undefined ? { areas: [...args.areas] } : {}),
    ...(args.branch !== undefined ? { branch: args.branch } : {}),
  };
  const added = await addSession(context.value.config, context.value.projectRoot, params);
  if (!added.ok) {
    return { lines: [describeAdminError(added.error)], exitCode: 1 };
  }
  return {
    lines: [
      `Agregaste la sesión ${added.value.session.id}.`,
      "Ejecuta 'rw configure' para aprovisionar su rama, worktree y entorno.",
    ],
    exitCode: 0,
  };
};

export type ArchiveArgs = { readonly id?: string };

// `rw archive <id>`: archive a session (keeps its branch/history, drops it from
// future provisioning and frees any live claim). A missing id is a usage error.
export const runArchive = async (args: ArchiveArgs, deps: CliDeps): Promise<CommandResult> => {
  if (args.id === undefined) {
    return { lines: ['Falta el id de la sesión. Uso: rw archive <id>'], exitCode: 2 };
  }
  const context = await loadContext(deps.cwd, deps.run, deps.runRaw);
  if (!context.ok) {
    return contextErrorResult(context.error);
  }
  const archived = await archiveSession(
    context.value.config,
    context.value.projectRoot,
    args.id,
    deps.now,
  );
  if (!archived.ok) {
    return { lines: [describeAdminError(archived.error)], exitCode: 1 };
  }
  return { lines: [`Archivaste la sesión ${args.id}.`], exitCode: 0 };
};
