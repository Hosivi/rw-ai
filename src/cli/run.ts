import { parseArgs } from 'node:util';
import {
  agentKindSchema,
  dbStrategySchema,
  stackSchema,
  type AgentKind,
  type DbStrategy,
  type Stack,
} from '../contract/schema.js';
import type { CliDeps, CommandResult } from './command.js';
import { runAdapters } from './commands/adapters.js';
import { runBootstrap } from './commands/bootstrap.js';
import { runCheck } from './commands/check.js';
import { runSessions } from './commands/claude-sessions.js';
import { runConfigure } from './commands/configure.js';
import { runClaim, runInit, runRoles, runRelease, runWhoami } from './commands/identity.js';
import { runLane } from './commands/lane.js';
import { runLaneGuard } from './commands/lane-guard.js';
import { runFinish } from './commands/lifecycle.js';
import { runScaffold } from './commands/scaffold.js';
import { runSessionStart } from './commands/session-start.js';
import { runStatus } from './commands/status.js';
import { runAddSession, runArchive } from './commands/sessions.js';
import { runTokens } from './commands/tokens.js';
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
  sessions: { type: 'string' },
  stacks: { type: 'string' },
  db: { type: 'string' },
  'base-branch': { type: 'string' },
  remote: { type: 'string' },
  cwd: { type: 'string' },
  model: { type: 'string' },
  online: { type: 'boolean' },
  json: { type: 'boolean' },
  claim: { type: 'boolean' },
  worktrees: { type: 'boolean' },
  user: { type: 'boolean' },
  force: { type: 'boolean' },
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
  '  bootstrap [--sessions <n>] [--remote <url>] [--base-branch <rama>]',
  '                                 Inicializa el repo (git init si hace falta) y lo configura de una sola vez',
  '  scaffold [--sessions <n>] [--stacks <a,b>] [--db <docker|local|supabase|none>] [--base-branch <rama>] [--force]',
  '                                 Detecta el stack y genera agents.config.json',
  '  configure                      Provisiona ramas, worktrees, bases de datos y el tablero',
  '  adapters [--worktrees] [--user]   Escribe la config del agente (MCP + hooks) y skills de rw; --user instala a nivel usuario para toda sesión de la máquina',
  '  status [--json]                Muestra el estado de cada sesión (claim, git, fase, semáforo)',
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
  '  lane <ruta>                    Verifica si una ruta cae dentro de las áreas de tu sesión (0 permitido, 3 invasión)',
  '  lane-guard                     Hook PreToolUse (lee el payload por stdin y bloquea escrituras fuera de carril); no es para uso manual',
  '  session-start                  Hook SessionStart (lee el payload por stdin y ofrece/orienta rw al abrir la sesión); no es para uso manual',
  '  sessions [--cwd <ruta>] [--claim]   Lista los jobs de Claude Code de la máquina',
  '  tokens [rutas...] [--model <id>] [--online]   Estima tokens y costo del contenido',
  '  mcp                            Inicia el servidor MCP (para que Claude Code / OpenCode usen rw como herramientas nativas)',
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

// --sessions carries a positive integer count; anything else is a usage error
// rather than a silent fallback to the default.
const parseSessions = (raw: string | undefined): number | undefined | 'invalid' => {
  if (raw === undefined) {
    return undefined;
  }
  const count = Number(raw);
  return Number.isInteger(count) && count >= 1 ? count : 'invalid';
};

// --stacks is a comma-separated list validated against stackSchema; blanks are
// dropped, and an empty or unknown entry is a usage error.
const parseStacks = (raw: string | undefined): Stack[] | undefined | 'invalid' => {
  if (raw === undefined) {
    return undefined;
  }
  const parts = raw
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  if (parts.length === 0) {
    return 'invalid';
  }
  const stacks: Stack[] = [];
  for (const part of parts) {
    const parsed = stackSchema.safeParse(part);
    if (!parsed.success) {
      return 'invalid';
    }
    stacks.push(parsed.data);
  }
  return stacks;
};

// --db must be one of the known strategies; an unknown value is a usage error.
const parseDbStrategy = (raw: string | undefined): DbStrategy | undefined | 'invalid' => {
  if (raw === undefined) {
    return undefined;
  }
  const parsed = dbStrategySchema.safeParse(raw);
  return parsed.success ? parsed.data : 'invalid';
};

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
    case 'bootstrap': {
      const sessions = parseSessions(values.sessions);
      if (sessions === 'invalid') {
        return usageError(`Sesiones inválidas '${values.sessions}'. Pasa un entero mayor que 0.`);
      }
      const baseBranch = values['base-branch'];
      if (baseBranch !== undefined && baseBranch.trim() === '') {
        return usageError('Rama base inválida. Pasa un nombre de rama no vacío.');
      }
      const remote = values.remote;
      if (remote !== undefined && remote.trim() === '') {
        return usageError('Remote inválido. Pasa una URL no vacía.');
      }
      return runBootstrap(
        {
          ...(sessions !== undefined ? { sessions } : {}),
          ...(baseBranch !== undefined ? { baseBranch } : {}),
          ...(remote !== undefined ? { remote } : {}),
        },
        deps,
      );
    }
    case 'scaffold': {
      const sessions = parseSessions(values.sessions);
      if (sessions === 'invalid') {
        return usageError(`Sesiones inválidas '${values.sessions}'. Pasa un entero mayor que 0.`);
      }
      const stacks = parseStacks(values.stacks);
      if (stacks === 'invalid') {
        return usageError(
          `Stacks inválidos '${values.stacks}'. Usa: node, android, dotnet (separados por coma).`,
        );
      }
      const db = parseDbStrategy(values.db);
      if (db === 'invalid') {
        return usageError(
          `Estrategia de base de datos inválida '${values.db}'. Usa: docker, local, supabase o none.`,
        );
      }
      const baseBranch = values['base-branch'];
      if (baseBranch !== undefined && baseBranch.trim() === '') {
        return usageError('Rama base inválida. Pasa un nombre de rama no vacío.');
      }
      return runScaffold(
        {
          ...(sessions !== undefined ? { sessions } : {}),
          ...(stacks !== undefined ? { stacks } : {}),
          ...(db !== undefined ? { db } : {}),
          ...(baseBranch !== undefined ? { baseBranch } : {}),
          ...(values.force === true ? { force: true } : {}),
        },
        deps,
      );
    }
    case 'configure':
      return runConfigure(deps);
    case 'adapters':
      return runAdapters(
        { worktrees: values.worktrees === true, user: values.user === true },
        deps,
      );
    case 'status':
      return runStatus({ json: values.json === true }, deps);
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
    case 'lane':
      return runLane({ path: positionals[1] }, deps);
    case 'lane-guard':
      // The PreToolUse hook: the bin threads the real stdin through deps.stdin.
      return runLaneGuard({ ...deps, stdin: deps.stdin ?? '' });
    case 'session-start':
      // The SessionStart hook: like lane-guard, it consumes the stdin payload the
      // bin slurps. Fail-open, so a missing stdin is just an empty payload.
      return runSessionStart({ ...deps, stdin: deps.stdin ?? '' });
    case 'sessions':
      return runSessions({ cwd: values.cwd, claim: values.claim === true }, deps);
    case 'tokens':
      // Positionals after the command are the paths to weigh; flags carry the rest.
      return runTokens(
        {
          paths: positionals.slice(1),
          ...(values.model !== undefined ? { model: values.model } : {}),
          ...(values.online === true ? { online: true } : {}),
        },
        deps,
      );
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
  // stderr is separate from stdout: only `rw lane-guard` fills it, and its block
  // reason must reach the hook's stderr channel, never stdout.
  if (result.stderr !== undefined && result.stderr.length > 0) {
    printLines(result.stderr, deps.writeErr ?? ((s) => console.error(s)));
  }
  return result.exitCode;
};
