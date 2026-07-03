import { parseArgs } from 'node:util';
import { agentKindSchema, type AgentKind } from '../contract/schema.js';
import type { CliDeps, CommandResult } from './command.js';
import { runCheck } from './commands/check.js';
import { runConfigure } from './commands/configure.js';
import { runClaim, runInit, runRoles, runRelease, runWhoami } from './commands/identity.js';
import { runFinish } from './commands/lifecycle.js';
import { runAddSession, runArchive } from './commands/sessions.js';
import { printLines } from './output.js';
import { readVersion } from './version.js';

// Default claim window: 8 hours, overridable with --ttl <horas>.
const DEFAULT_TTL_MS = 28_800_000;

// Every option any subcommand accepts, declared once. parseArgs is strict, so an
// unknown option throws and becomes a usage error — no per-command option maps.
const OPTIONS = {
  role: { type: 'string' },
  agent: { type: 'string' },
  ttl: { type: 'string' },
  areas: { type: 'string' },
  branch: { type: 'string' },
  'new-branch': { type: 'string' },
  version: { type: 'boolean', short: 'v' },
  help: { type: 'boolean', short: 'h' },
} as const;

// Spanish usage, neutral Peruvian (tuteo). Listed here so --help and every usage
// error render the same reference.
const USAGE: readonly string[] = [
  'rw — configurador multi-sesión para agentes',
  '',
  'Uso: rw <comando> [opciones]',
  '',
  'Comandos:',
  '  configure                      Provisiona ramas, worktrees, bases de datos y el tablero',
  '  roles                          Lista los roles y su estado (libre/ocupado)',
  '  init [--role <id>] [--agent <tipo>] [--ttl <horas>]',
  '                                 Elige y reclama un rol (interactivo si no pasas --role)',
  '  claim <rol> [--agent <tipo>] [--ttl <horas>]',
  '                                 Reclama un rol específico sin interacción',
  '  whoami                         Muestra el rol asociado a tu RW_TOKEN',
  '  release [--role <id>]          Libera el rol que tienes reclamado',
  '  finish [sesión] [--new-branch <nombre>]',
  '                                 Integra la sesión y rota su rama',
  '  add-session [--areas <glob,...>] [--branch <nombre>]',
  '                                 Agrega una nueva sesión a la configuración',
  '  archive <id>                   Archiva una sesión',
  '  check                          Analiza la integración y detecta conflictos/invasiones',
  '',
  'Opciones globales:',
  '  -v, --version                  Muestra la versión',
  '  -h, --help                     Muestra esta ayuda',
];

// A usage failure: an explanatory first line, a blank, then the full usage.
const usageError = (message: string): CommandResult => ({
  lines: [message, '', ...USAGE],
  exitCode: 2,
});

// --ttl carries hours; convert to ms. A non-positive or non-numeric value is a
// usage error rather than a silent fallback to the default.
const parseTtlMs = (raw: string | undefined): number | 'invalid' => {
  if (raw === undefined) {
    return DEFAULT_TTL_MS;
  }
  const hours = Number(raw);
  if (!Number.isFinite(hours) || hours <= 0) {
    return 'invalid';
  }
  return Math.round(hours * 3_600_000);
};

// --agent must be one of the known kinds; an unknown value is a usage error.
const parseAgent = (raw: string | undefined): AgentKind | undefined | 'invalid' => {
  if (raw === undefined) {
    return undefined;
  }
  const parsed = agentKindSchema.safeParse(raw);
  return parsed.success ? parsed.data : 'invalid';
};

// --areas is a comma-separated glob list; blanks are dropped so a trailing comma
// never yields an empty area. Exported so the blank-dropping edge is unit-tested
// without provisioning a repo.
export const parseAreas = (raw: string | undefined): readonly string[] | undefined =>
  raw === undefined
    ? undefined
    : raw
        .split(',')
        .map((area) => area.trim())
        .filter((area) => area.length > 0);

// Parse argv, dispatch to the matching handler, and return its result. All
// process interaction is the caller's (runCli); this stays pure data in/out.
const route = async (argv: readonly string[], deps: CliDeps): Promise<CommandResult> => {
  let parsed: ReturnType<typeof parseArgs<{ options: typeof OPTIONS; allowPositionals: true }>>;
  try {
    parsed = parseArgs({ args: [...argv], options: OPTIONS, allowPositionals: true, strict: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return usageError(`Argumentos inválidos: ${message}`);
  }
  const { values, positionals } = parsed;

  // Global flags win over any subcommand.
  if (values.version === true) {
    return { lines: [`rw ${readVersion()}`], exitCode: 0 };
  }
  const command = positionals[0];
  if (values.help === true || command === undefined) {
    return { lines: USAGE, exitCode: 0 };
  }

  // Validate shared flags once so handlers receive clean, typed args.
  const agent = parseAgent(values.agent);
  if (agent === 'invalid') {
    return usageError(`Agente inválido '${values.agent}'. Usa: claude-code, opencode o human.`);
  }
  const ttlMs = parseTtlMs(values.ttl);
  if (ttlMs === 'invalid') {
    return usageError(`TTL inválido '${values.ttl}'. Pasa un número de horas mayor que 0.`);
  }

  switch (command) {
    case 'configure':
      return runConfigure(deps);
    case 'roles':
      return runRoles(deps);
    case 'init':
      return runInit({ role: values.role, agent, ttlMs }, deps);
    case 'claim':
      return runClaim({ role: positionals[1], agent, ttlMs }, deps);
    case 'whoami':
      return runWhoami(deps);
    case 'release':
      return runRelease({ role: values.role }, deps);
    case 'finish':
      return runFinish({ session: positionals[1], newBranch: values['new-branch'] }, deps);
    case 'add-session':
      return runAddSession({ areas: parseAreas(values.areas), branch: values.branch }, deps);
    case 'archive':
      return runArchive({ id: positionals[1] }, deps);
    case 'check':
      return runCheck(deps);
    default:
      return usageError(`Comando desconocido: ${command}`);
  }
};

// The single testable entry point: parse + dispatch + print, returning the exit
// code the bin hands to process.exitCode. The writer defaults to console.log so
// callers that do not inject one still work.
export const runCli = async (argv: readonly string[], deps: CliDeps): Promise<number> => {
  const result = await route(argv, deps);
  printLines(result.lines, deps.write);
  return result.exitCode;
};
