import { ENV_KEYS, resolveBoardDir } from '../../contract/env.js';
import type { AgentKind, AgentsConfig } from '../../contract/schema.js';
import { assertNever } from '../../core/assert.js';
import {
  claimRole,
  generateClaimToken,
  listRoles,
  releaseRole,
  whoami,
  type IdentityError,
  type RoleStatus,
} from '../../engine/identity.js';
import { contextErrorResult, type CliDeps, type CommandResult } from '../command.js';
import { loadContext } from '../context.js';
import { formatRoles, roleStatusLabel } from '../output.js';
import { selectRole } from '../prompts.js';

// Command-specific Spanish for the identity outcomes (neutral Peruvian, tuteo).
// The engine keeps its messages in English; every user-facing line is composed
// here so wording lives in one place.
const describeIdentityError = (error: IdentityError): string => {
  switch (error.kind) {
    case 'occupied':
      return `El rol ${error.role} ya está reclamado por otro token. Espera a que se libere o usa otro rol.`;
    case 'invalid-role':
      return `Rol inválido '${error.role ?? ''}': debe ser 'integrator' o el id de una sesión activa.`;
    case 'invalid-token':
      return `El token del rol ${error.role} es inválido: ${error.message}`;
    case 'token-mismatch':
      return `No puedes liberar el rol ${error.role}: el token no coincide con quien lo tiene.`;
    case 'locked':
      return 'Otra operación tiene tomado el candado de claims. Intenta de nuevo en un momento.';
    case 'invalid-json':
    case 'invalid-claims':
      return `El archivo claims.json está dañado: ${error.message}`;
    case 'io':
      return `Error de entrada/salida con claims.json: ${error.message}`;
    default:
      return assertNever(error.kind);
  }
};

// The two shell exports an agent evaluates after a successful claim, preceded by
// a one-line note. RW_SESSION + RW_TOKEN are the whole stateless identity later
// commands read back from the environment.
const claimExportLines = (role: string, token: string): readonly string[] => [
  `Reclamaste el rol ${role}. Exporta estas variables en tu shell:`,
  `export ${ENV_KEYS.session}=${role}`,
  `export ${ENV_KEYS.token}=${token}`,
];

type ClaimReportParams = {
  readonly config: AgentsConfig;
  readonly boardDir: string;
  readonly role: string;
  readonly agent?: AgentKind;
  readonly ttlMs: number;
  readonly now: Date;
};

// Shared by init and claim: mint a token, claim the role, and either print the
// export lines (success) or the Spanish reason (occupied, invalid, etc.).
const claimAndReport = async (params: ClaimReportParams): Promise<CommandResult> => {
  const token = generateClaimToken();
  const claimed = await claimRole({
    config: params.config,
    boardDir: params.boardDir,
    role: params.role,
    token,
    agent: params.agent,
    now: params.now,
    ttlMs: params.ttlMs,
  });
  if (!claimed.ok) {
    return { lines: [describeIdentityError(claimed.error)], exitCode: 1 };
  }
  return { lines: claimExportLines(params.role, token), exitCode: 0 };
};

// `rw roles`: list every role and its libre/ocupado/vencido status.
export const runRoles = async (deps: CliDeps): Promise<CommandResult> => {
  const context = await loadContext(deps.cwd, deps.run, deps.runRaw);
  if (!context.ok) {
    return contextErrorResult(context.error);
  }
  const boardDir = resolveBoardDir(context.value.projectRoot, context.value.config);
  const roles = await listRoles({ config: context.value.config, boardDir, now: deps.now });
  if (!roles.ok) {
    return { lines: [describeIdentityError(roles.error)], exitCode: 1 };
  }
  return { lines: formatRoles(roles.value).split('\n'), exitCode: 0 };
};

export type InitArgs = {
  readonly role?: string;
  readonly agent?: AgentKind;
  readonly ttlMs: number;
};

// `rw init`: resolve the role (explicit --role, else an interactive picker),
// then claim it. Non-interactive with no --role cannot pick, so it fails with a
// usage exit (2) telling the user to name the role explicitly.
export const runInit = async (args: InitArgs, deps: CliDeps): Promise<CommandResult> => {
  const context = await loadContext(deps.cwd, deps.run, deps.runRaw);
  if (!context.ok) {
    return contextErrorResult(context.error);
  }
  const { config, projectRoot } = context.value;
  const boardDir = resolveBoardDir(projectRoot, config);

  let role = args.role;
  if (role === undefined) {
    const listed = await listRoles({ config, boardDir, now: deps.now });
    if (!listed.ok) {
      return { lines: [describeIdentityError(listed.error)], exitCode: 1 };
    }
    const picked = await selectRole(listed.value, deps.interactive);
    if (!picked.ok) {
      if (picked.error.kind === 'non-interactive') {
        return {
          lines: [
            'No hay terminal interactiva para elegir un rol. Pasa --role <id> (por ejemplo: rw init --role s1).',
          ],
          exitCode: 2,
        };
      }
      return { lines: [picked.error.message], exitCode: 1 };
    }
    role = picked.value;
  }

  return claimAndReport({ config, boardDir, role, agent: args.agent, ttlMs: args.ttlMs, now: deps.now });
};

export type ClaimArgs = {
  readonly role?: string;
  readonly agent?: AgentKind;
  readonly ttlMs: number;
};

// `rw claim <rol>`: the non-interactive sibling of init — the role is a required
// positional, so a missing one is a usage error (2) rather than a prompt.
export const runClaim = async (args: ClaimArgs, deps: CliDeps): Promise<CommandResult> => {
  if (args.role === undefined) {
    return {
      lines: ['Falta el rol. Uso: rw claim <rol> [--agent <tipo>] [--ttl <horas>]'],
      exitCode: 2,
    };
  }
  const context = await loadContext(deps.cwd, deps.run, deps.runRaw);
  if (!context.ok) {
    return contextErrorResult(context.error);
  }
  const { config, projectRoot } = context.value;
  return claimAndReport({
    config,
    boardDir: resolveBoardDir(projectRoot, config),
    role: args.role,
    agent: args.agent,
    ttlMs: args.ttlMs,
    now: deps.now,
  });
};

// `rw whoami`: read RW_TOKEN back from the environment and report which role (if
// any) it currently holds.
export const runWhoami = async (deps: CliDeps): Promise<CommandResult> => {
  const token = deps.env[ENV_KEYS.token];
  if (token === undefined || token === '') {
    return {
      lines: ['No hay RW_TOKEN en el entorno. Reclama un rol con rw init o rw claim.'],
      exitCode: 1,
    };
  }
  const context = await loadContext(deps.cwd, deps.run, deps.runRaw);
  if (!context.ok) {
    return contextErrorResult(context.error);
  }
  const { config, projectRoot } = context.value;
  const who = await whoami({ config, boardDir: resolveBoardDir(projectRoot, config), token, now: deps.now });
  if (!who.ok) {
    return { lines: [describeIdentityError(who.error)], exitCode: 1 };
  }
  if (who.value === null) {
    return { lines: ['Tu token no tiene ningún rol activo.'], exitCode: 0 };
  }
  // Reuse the shared label by presenting the claim as a claimed RoleStatus.
  const status: RoleStatus = {
    role: who.value.role,
    status: 'claimed',
    expired: false,
    claim: who.value.claim,
  };
  return { lines: [`${who.value.role}: ${roleStatusLabel(status)}`], exitCode: 0 };
};

export type ReleaseArgs = { readonly role?: string };

// `rw release`: free the role this token holds — either the one named by --role
// or the one whoami resolves from RW_TOKEN.
export const runRelease = async (args: ReleaseArgs, deps: CliDeps): Promise<CommandResult> => {
  const token = deps.env[ENV_KEYS.token];
  if (token === undefined || token === '') {
    return {
      lines: ['No hay RW_TOKEN en el entorno. No hay ningún rol que liberar.'],
      exitCode: 1,
    };
  }
  const context = await loadContext(deps.cwd, deps.run, deps.runRaw);
  if (!context.ok) {
    return contextErrorResult(context.error);
  }
  const { config, projectRoot } = context.value;
  const boardDir = resolveBoardDir(projectRoot, config);

  let role = args.role;
  if (role === undefined) {
    const who = await whoami({ config, boardDir, token, now: deps.now });
    if (!who.ok) {
      return { lines: [describeIdentityError(who.error)], exitCode: 1 };
    }
    if (who.value === null) {
      return { lines: ['Tu token no tiene ningún rol activo, no hay nada que liberar.'], exitCode: 0 };
    }
    role = who.value.role;
  }

  const released = await releaseRole({ config, boardDir, role, token, now: deps.now });
  if (!released.ok) {
    return { lines: [describeIdentityError(released.error)], exitCode: 1 };
  }
  return released.value.released
    ? { lines: [`Liberaste el rol ${role}.`], exitCode: 0 }
    : { lines: [`El rol ${role} ya estaba libre.`], exitCode: 0 };
};
