import { assertNever } from '../../core/assert.js';
import { bootstrapRepo, type BootstrapError } from '../../engine/bootstrap.js';
import type { CliDeps, CommandResult } from '../command.js';
import { formatRunbook } from '../output.js';

// `rw bootstrap`: the one-shot onboarding command. It inits git if needed, writes
// agents.config.json, makes the first commit, and provisions everything via
// configure — so a brand-new repo goes from empty to ready in a single call.

export type BootstrapArgs = {
  readonly sessions?: number;
  readonly remote?: string;
  readonly baseBranch?: string;
};

// Each kind gets a distinct, actionable Spanish line. inside-worktree and
// commit-identity already carry user-facing prose from the engine, so they are
// surfaced as-is; the rest get a short prefix naming the failure class.
const bootstrapErrorMessage = (error: BootstrapError): string => {
  switch (error.kind) {
    case 'inside-worktree':
      return error.message;
    case 'commit-identity':
      return error.message;
    case 'git':
      return `Error de git: ${error.message}`;
    case 'scaffold':
      return `No se pudo generar agents.config.json: ${error.message}`;
    case 'io':
      return `Error de entrada/salida: ${error.message}`;
    default:
      return assertNever(error.kind);
  }
};

export const runBootstrap = async (
  args: BootstrapArgs,
  deps: CliDeps,
): Promise<CommandResult> => {
  const result = await bootstrapRepo({
    cwd: deps.cwd,
    now: deps.now,
    ...(args.sessions !== undefined ? { sessions: args.sessions } : {}),
    ...(args.baseBranch !== undefined ? { baseBranch: args.baseBranch } : {}),
    ...(args.remote !== undefined ? { remote: { url: args.remote } } : {}),
    ...(deps.run !== undefined ? { run: deps.run } : {}),
    ...(deps.runRaw !== undefined ? { runRaw: deps.runRaw } : {}),
  });

  if (!result.ok) {
    return { lines: [bootstrapErrorMessage(result.error)], exitCode: 1 };
  }

  const value = result.value;
  if (value.alreadyConfigured) {
    return {
      lines: [
        'Este repo ya está configurado con rw (la rama de integración ya existe). No cambié nada.',
      ],
      exitCode: 0,
    };
  }

  const lines: string[] = [];
  if (value.gitInitialized) {
    lines.push('git inicializado');
  }
  if (value.committed) {
    lines.push('commit inicial creado (chore: rw bootstrap)');
  }
  if (value.remoteAdded !== undefined) {
    lines.push(`remote '${value.remoteAdded}' agregado`);
  }
  if (value.runbook !== undefined) {
    lines.push(...formatRunbook(value.runbook).split('\n'));
  }

  // A failed runbook is reported (not a hard error) but still exits 1 so scripts
  // notice the provisioning did not fully succeed.
  const runbookFailed = value.runbook !== undefined && !value.runbook.ok;
  return { lines, exitCode: runbookFailed ? 1 : 0 };
};
