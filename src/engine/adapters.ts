import fs from 'node:fs/promises';
import path from 'node:path';
import type { AgentsConfig } from '../contract/schema.js';
import { err, ok, type Result } from '../core/result.js';
import { writeFileIdempotent, type WriteAction } from './board.js';
import { activeSessions } from './sessions.js';

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

// A skill is a pure content generator: its body may depend on the config (e.g.
// the workflow skill lists THIS repo's active sessions), so render takes it even
// when a given skill ignores it. name slugs stay English; bodies are Spanish.
export type Skill = {
  readonly name: string;
  readonly description: string;
  readonly render: (config: AgentsConfig) => string;
};

// A thin command wrapper: it points the agent at the real `rw` command and the
// deep skill, so it stays short. Shared verbatim by both agent formats.
type CommandWrapper = {
  readonly command: string;
  readonly description: string;
  readonly body: string;
};

// A markdown table of the sessions an agent can actually pick up. Derived from
// activeSessions so an archived session drops out and the rendered skill changes
// (which is what makes installAdapters report it 'updated' after a config edit).
const activeSessionTable = (config: AgentsConfig): string => {
  const sessions = activeSessions(config);
  if (sessions.length === 0) {
    return '_Todavía no hay sesiones activas. Corre `rw configure` para provisionarlas._';
  }
  const rows = sessions.map((session) => {
    const areas = session.areas.map((area) => `\`${area}\``).join(', ');
    return `| ${session.id} | \`${session.branch}\` | \`${session.worktree}\` | ${areas} |`;
  });
  return ['| Sesión | Rama | Worktree | Áreas |', '| --- | --- | --- | --- |', ...rows].join('\n');
};

const workflowBody = (config: AgentsConfig): string =>
  [
    '# Flujo de trabajo de rw',
    '',
    'rw coordina a varios agentes trabajando en paralelo sobre el mismo repo sin pisarse.',
    '',
    '## Qué es una sesión',
    '',
    'Una sesión es una unidad de trabajo aislada, formada por tres cosas:',
    '',
    '- **Rama**: una rama de git propia (ej. `feat/s1-inicial`), descartable y rotable.',
    '- **Worktree**: un checkout separado bajo `.worktrees/` donde vive esa rama; no',
    '  compartes el árbol de archivos con las demás sesiones.',
    '- **Áreas**: los globs de archivos que la sesión puede tocar (su carril). Tocar',
    '  archivos fuera de tus áreas es una "invasión de carril".',
    '',
    '## El tablero compartido',
    '',
    'Todo el estado visible vive en `.review-board/` en la raíz del repo: el tablero',
    '`board.md`, las tareas por sesión, los reportes del integrador y los artefactos de',
    'test. Ese directorio está gitignoreado a propósito para que el estado compartido no',
    'diverja por rama.',
    '',
    '## Cómo tomar trabajo',
    '',
    '1. Corre `rw roles` para ver qué roles (sesiones + integrador) están libres u ocupados.',
    '2. Reclama uno con `rw init` (interactivo) o `rw claim <rol>` (mira la skill `rw-identity`).',
    '3. Trabaja SOLO dentro de tu worktree y de tus áreas.',
    '4. Antes de integrar, corre `rw check` (mira la skill `rw-integration`).',
    '',
    'Si el repo todavía no está provisionado, corre `rw configure` primero.',
    '',
    '## rw como herramientas MCP (prefiérelas)',
    '',
    'Si el repo corrió `rw adapters`, rw queda enlazado como servidor MCP y tienes',
    'estas herramientas NATIVAS. PREFIÉRELAS antes que correr `rw` en la shell: llamar',
    'la herramienta te da datos estructurados en vez de texto que tendrías que parsear.',
    '',
    '- `rw_status` — estado general: tu sesión actual más el estado de todos los roles.',
    '- `rw_roles` — lista de roles y si están libres u ocupados.',
    '- `rw_whoami` — qué rol tienes según tu token.',
    '- `rw_claim` / `rw_release` — reclama o libera un rol.',
    '- `rw_check` — analiza la integración (conflictos e invasiones de carril).',
    '- `rw_finish` — integra tu sesión y rota su rama.',
    '- `rw_lane_check` — verifica si una ruta cae dentro de tu carril antes de escribirla.',
    '',
    'Usa la shell (`rw ...`) solo como respaldo si el servidor MCP no está disponible.',
    '',
    '## El hook de carril (PreToolUse)',
    '',
    '`rw adapters` también enlaza un hook `PreToolUse` que corre `rw lane-guard` antes de',
    'cada Write/Edit/MultiEdit. Si intentas escribir un archivo FUERA de las `areas` de tu',
    'sesión, el hook BLOQUEA la escritura (exit 2) y te explica por qué por stderr.',
    '',
    'Si un bloqueo te estorba, NO lo pelees: estrecha o ajusta las `areas` de tu sesión en',
    '`agents.config.json`, o coordina si el archivo pertenece a otra sesión. El hook resuelve',
    'la sesión desde el cwd, así que funciona igual cuando corres dentro de un worktree.',
    '',
    '## Sesiones activas en este repo',
    '',
    activeSessionTable(config),
  ].join('\n');

const identityBody = (): string =>
  [
    '# Identidad y roles en rw',
    '',
    'Tu identidad en rw es un par de variables de entorno, no un login.',
    '',
    '## Reclamar un rol',
    '',
    '- `rw init` — elige un rol de forma interactiva y lo reclama.',
    '- `rw claim <rol>` — reclama un rol específico sin interacción (ej. `rw claim s1`).',
    '',
    'Al reclamar, rw imprime dos líneas `export` que debes correr en tu shell:',
    '',
    '```bash',
    'export RW_SESSION=s1',
    'export RW_TOKEN=<token-generado>',
    '```',
    '',
    '`RW_SESSION` dice en qué sesión trabajas; `RW_TOKEN` prueba que el rol es tuyo. Juntas',
    'son toda tu identidad: no hay estado de login en ningún otro lado.',
    '',
    '## Consultar y liberar',
    '',
    '- `rw whoami` — lee tu `RW_TOKEN` del entorno y te dice qué rol tienes.',
    '- `rw release` — libera el rol que tienes reclamado para que otro agente lo tome.',
    '',
    'Con `rw adapters` corrido, prefiere las herramientas MCP equivalentes: `rw_roles`',
    'para listar roles, `rw_claim` para reclamar, `rw_whoami` para consultar tu rol y',
    '`rw_release` para soltarlo. Devuelven datos estructurados en vez de texto de shell.',
    '',
    '## El locking es cooperativo',
    '',
    'Los claims son un candado cooperativo, NO una barrera de seguridad: evitan que dos',
    'agentes tomen el mismo rol por accidente, pero no impiden que alguien decidido lo',
    'ignore. Respeta los claims ajenos. Un claim vence tras su TTL y vuelve a estar libre.',
  ].join('\n');

const integrationBody = (): string =>
  [
    '# Integración de sesiones en rw',
    '',
    'Integrar una sesión tiene dos pasos: verificar y luego integrar.',
    '',
    '## Paso 1 — `rw check`',
    '',
    'Antes de integrar, SIEMPRE corre `rw check`. Analiza la integración y detecta:',
    '',
    '- **Invasiones de carril**: archivos que tocaste fuera de tus áreas.',
    '- **Zonas compartidas**: archivos en zonas marcadas como compartidas.',
    '- **Solapamientos**: archivos que otra sesión también tocó.',
    '- **Conflictos simulados**: conflictos reales de merge, detectados con `git merge-tree`',
    '  sin tocar tu árbol.',
    '',
    '`rw check` es una compuerta (gate): sale con **exit 0** si está limpio y con **exit 1**',
    'si hay al menos un conflicto o una invasión. Úsalo para bloquear la integración: no',
    'sigas si devuelve 1; resuelve primero lo que reporta.',
    '',
    '## Paso 2 — `rw finish`',
    '',
    'Cuando `rw check` esté limpio, corre `rw finish [sesión]` para integrar la sesión. Al',
    'terminar, rw **rota la rama**: nunca se renombra una rama. Los worktrees son fijos y',
    'las ramas son descartables — `rw finish` integra el trabajo y deja el worktree listo',
    'sobre una rama nueva para el siguiente ciclo.',
    '',
    '## Como herramientas MCP',
    '',
    'Con `rw adapters` corrido, prefiere las herramientas MCP: `rw_check` para analizar la',
    'integración (te dice `blocking: true/false` sin parsear texto) y `rw_finish` para',
    'integrar y rotar la rama. Usa la shell solo si el servidor MCP no está disponible.',
  ].join('\n');

const testArtifactsBody = (): string =>
  [
    '# Artefactos de test en rw',
    '',
    'Los artefactos de test (screenshots, videos, reportes) van SIEMPRE dentro de',
    '`.review-board/`, nunca sueltos en el worktree.',
    '',
    '## Por qué y cómo',
    '',
    'Cada corrida de test debe escribir sus artefactos en un directorio derivado de dos',
    'variables de entorno:',
    '',
    '- `RW_BOARD_DIR` — la ruta absoluta al tablero compartido.',
    '- `RW_SESSION` — la sesión actual.',
    '',
    'Así los artefactos quedan agrupados por sesión dentro del tablero y no provocan',
    'conflictos de merge entre worktrees. Nunca hardcodees la sesión en la config de test:',
    'léela del entorno en tiempo de ejecución.',
    '',
    '## E2E es opt-in por plataforma',
    '',
    'El E2E no se activa solo: se habilita por plataforma en `agents.config.json`. rw genera',
    'los snippets de wiring listos para pegar según tu config.',
    '',
    '## Dónde está el wiring',
    '',
    'Revisa el documento que rw genera en `.review-board/reports/test-wiring.md`: lista, por',
    'sesión y plataforma, el snippet exacto que debes pegar en tu config de test (ej.',
    '`playwright.config.ts`) para enrutar los artefactos al tablero.',
  ].join('\n');

// The four skills, in a fixed order so the generated file set is deterministic.
// name slugs are English; descriptions and bodies are neutral Peruvian Spanish
// (tuteo) because they are read by an agent deciding what to do.
export const SKILLS: readonly Skill[] = [
  {
    name: 'rw-workflow',
    description:
      'Explica el flujo multi-sesión de rw: sesiones (rama + worktree + áreas), el tablero compartido `.review-board/` y cómo tomar trabajo. Úsala al empezar en un repo con rw.',
    render: workflowBody,
  },
  {
    name: 'rw-identity',
    description:
      'Cómo reclamar y liberar un rol en rw con `rw init`/`rw claim` y el modelo de identidad por `RW_SESSION`/`RW_TOKEN`. Úsala para tomar o soltar una sesión.',
    render: () => identityBody(),
  },
  {
    name: 'rw-integration',
    description:
      'Cómo integrar una sesión en rw: `rw check` para detectar conflictos e invasiones y `rw finish` para integrar y rotar la rama. Úsala antes de integrar.',
    render: () => integrationBody(),
  },
  {
    name: 'rw-test-artifacts',
    description:
      'Dónde van los artefactos de test en rw (dentro de `.review-board/` vía `RW_SESSION`/`RW_BOARD_DIR`) y el E2E opt-in por plataforma. Úsala al escribir o correr tests.',
    render: () => testArtifactsBody(),
  },
];

// JSON.stringify double-quotes the description, which is also a valid YAML
// double-quoted scalar — so a description carrying ':' or backticks never breaks
// the frontmatter, without pulling in a YAML serializer.
export const renderSkill = (skill: Skill, config: AgentsConfig): string =>
  [
    '---',
    `name: ${skill.name}`,
    `description: ${JSON.stringify(skill.description)}`,
    '---',
    '',
    skill.render(config),
    '',
  ].join('\n');

// The four highest-value commands to surface as one-shot wrappers. They point at
// the real skills for depth, so each body stays a thin "run this, read that".
const COMMAND_WRAPPERS: readonly CommandWrapper[] = [
  {
    command: 'configure',
    description: 'Provisiona ramas, worktrees, bases de datos y el tablero compartido de rw.',
    body: [
      'Corre `rw configure` en la shell para provisionar el repo multi-sesión.',
      '',
      'Qué hace: crea las ramas y worktrees de cada sesión, prepara las bases de datos por',
      'sesión y genera el tablero compartido en `.review-board/`.',
      '',
      'Cómo interpretar el resultado: cada línea es un paso con su glifo (`✓` ok, `⚠`',
      'degradado, `·` omitido, `✗` fallido). Termina en `Configuración completa` (éxito,',
      'exit 0) o `Configuración con problemas` (algún paso falló, exit 1).',
      '',
      'Para el detalle del flujo, mira la skill `rw-workflow`.',
    ].join('\n'),
  },
  {
    command: 'init',
    description: 'Elige y reclama un rol de rw de forma interactiva.',
    body: [
      'Corre `rw init` en la shell para elegir y reclamar un rol (sesión o integrador).',
      '',
      'Qué hace: te muestra los roles libres, reclamas uno e imprime dos líneas `export`',
      '(`RW_SESSION` y `RW_TOKEN`) que debes correr en tu shell para fijar tu identidad.',
      '',
      'Cómo interpretar el resultado: exit 0 y las dos líneas `export` significan que el',
      'rol es tuyo. Exporta ambas variables antes de seguir con cualquier otro comando.',
      '',
      'Para el modelo de identidad completo, mira la skill `rw-identity`.',
    ].join('\n'),
  },
  {
    command: 'check',
    description: 'Analiza la integración y detecta conflictos e invasiones de carril.',
    body: [
      'Corre `rw check` en la shell ANTES de integrar tu sesión.',
      '',
      'Qué hace: detecta invasiones de carril, zonas compartidas tocadas, solapamientos y',
      'conflictos simulados de merge (con `git merge-tree`), y escribe el reporte en',
      '`.review-board/reports/integration.md`.',
      '',
      'Cómo interpretar el resultado: es una compuerta. Exit 0 = limpio, puedes integrar.',
      'Exit 1 = hay al menos un conflicto o invasión; no integres hasta resolverlo.',
      '',
      'Para el flujo de integración completo, mira la skill `rw-integration`.',
    ].join('\n'),
  },
  {
    command: 'finish',
    description: 'Integra la sesión y rota su rama.',
    body: [
      'Corre `rw finish [sesión]` en la shell para integrar tu sesión una vez que',
      '`rw check` esté limpio.',
      '',
      'Qué hace: integra el trabajo de la sesión y ROTA su rama (nunca renombra una rama);',
      'el worktree es fijo y queda listo sobre una rama nueva para el siguiente ciclo.',
      '',
      'Cómo interpretar el resultado: exit 0 = la sesión se integró y la rama rotó. Si',
      '`rw check` reporta problemas, resuélvelos antes de correr `rw finish`.',
      '',
      'Para el flujo de integración completo, mira la skill `rw-integration`.',
    ].join('\n'),
  },
];

// Both agents read a markdown command file with a `description:` frontmatter and
// a prompt body; the content is identical, only the target path differs.
const renderCommandWrapper = (wrapper: CommandWrapper): string =>
  ['---', `description: ${JSON.stringify(wrapper.description)}`, '---', '', wrapper.body, ''].join('\n');

export type AdaptersError = {
  // 'io' is a filesystem failure; 'invalid-json' means an existing config file the
  // merge must not clobber is unparseable — the user fixes it by hand.
  readonly kind: 'io' | 'invalid-json';
  readonly message: string;
  readonly cause?: unknown;
};

export type AdapterWrite = {
  // Absolute path (projectRoot-joined) so callers can report or re-open it.
  readonly path: string;
  readonly action: WriteAction;
};

export type AdaptersInstallResult = {
  readonly written: readonly AdapterWrite[];
};

type PlannedWrite = { readonly relPath: string; readonly content: string };

// Every file installAdapters writes, as (relative path, content) pairs. Each
// skill and command wrapper goes to BOTH agent trees with identical bytes so the
// two tools discover the same content under their own conventions.
const planWrites = (config: AgentsConfig): PlannedWrite[] => {
  const writes: PlannedWrite[] = [];
  for (const skill of SKILLS) {
    const content = renderSkill(skill, config);
    writes.push({ relPath: path.join('.claude', 'skills', skill.name, 'SKILL.md'), content });
    writes.push({ relPath: path.join('.opencode', 'skills', skill.name, 'SKILL.md'), content });
  }
  for (const wrapper of COMMAND_WRAPPERS) {
    const content = renderCommandWrapper(wrapper);
    writes.push({ relPath: path.join('.claude', 'commands', `rw-${wrapper.command}.md`), content });
    writes.push({ relPath: path.join('.opencode', 'command', `rw-${wrapper.command}.md`), content });
  }
  return writes;
};

// --- JSON config merging ----------------------------------------------------
// The MCP server config and the PreToolUse hook live in JSON files that may
// already carry unrelated user content, so they are MERGED (read → mutate the one
// key rw owns → write) instead of overwritten. Every merge preserves unknown keys.

type JsonObject = Record<string, unknown>;

const isPlainObject = (value: unknown): value is JsonObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

// Files rw owns are pretty-printed with 2-space indent and a trailing newline, so
// a file rw wrote re-serializes byte-identically (idempotent) and a hand-edited
// file stabilizes to this shape after the first merge.
const serializeJson = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

// Reads an existing JSON config as an object, or an empty object when absent. A
// file that exists but is not a JSON object is a HARD error: we must never clobber
// content we cannot safely parse and merge into.
const readJsonConfig = async (filePath: string): Promise<Result<JsonObject, AdaptersError>> => {
  let raw: string;
  try {
    raw = await fs.readFile(filePath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return ok({}); // absent → rw creates a fresh file from the empty base
    }
    return err({ kind: 'io', message: `could not read ${filePath}: ${errorMessage(error)}`, cause: error });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return err({
      kind: 'invalid-json',
      message: `${filePath} existe pero no es JSON válido; arréglalo a mano y vuelve a correr rw adapters (no lo sobrescribí).`,
    });
  }
  if (!isPlainObject(parsed)) {
    return err({
      kind: 'invalid-json',
      message: `${filePath} existe pero no es un objeto JSON; arréglalo a mano y vuelve a correr rw adapters (no lo sobrescribí).`,
    });
  }
  return ok(parsed);
};

// Read-merge-write a JSON config idempotently: `merge` gets the parsed (or empty)
// object and returns the object to persist; the file is only rewritten when the
// serialized bytes change, so a no-op re-run reports 'unchanged'.
const mergeJsonConfig = async (
  filePath: string,
  merge: (base: JsonObject) => JsonObject,
): Promise<Result<AdapterWrite, AdaptersError>> => {
  const base = await readJsonConfig(filePath);
  if (!base.ok) {
    return base;
  }
  try {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
  } catch (error) {
    return err({
      kind: 'io',
      message: `could not create dir for ${filePath}: ${errorMessage(error)}`,
      cause: error,
    });
  }
  const written = await writeFileIdempotent(filePath, serializeJson(merge(base.value)));
  if (!written.ok) {
    return err({ kind: 'io', message: written.error.message, cause: written.error.cause });
  }
  return ok({ path: filePath, action: written.value.action });
};

// The spawnable form of `rw mcp`, per platform. On Windows the global `rw` is a
// `.cmd` shim and MCP stdio servers are spawned WITHOUT a shell (which cannot
// launch a `.cmd`), so rw must be invoked through `cmd /c`; off Windows `rw` is a
// normal executable, invoked directly. Same class of problem cross-spawn solves
// for rw's own subprocesses (see exec.ts) — here applied to the command rw writes
// into the MCP configs. Kept pure: the platform is passed in, never read from
// process, so both branches are reachable in tests on any host.
type RwMcpCommand = { readonly command: string; readonly args: readonly string[] };
const rwMcpCommand = (platform: NodeJS.Platform): RwMcpCommand =>
  platform === 'win32'
    ? { command: 'cmd', args: ['/c', 'rw', 'mcp'] }
    : { command: 'rw', args: ['mcp'] };

// Claude Code discovers the MCP server from .mcp.json; `rw mcp` runs it over stdio.
// Curried by platform so the merge stays a pure (base) => object for mergeJsonConfig.
const mergeMcpJson =
  (platform: NodeJS.Platform) =>
  (base: JsonObject): JsonObject => {
    const servers = isPlainObject(base.mcpServers) ? base.mcpServers : {};
    // ADD/OVERWRITE only the rw-ai key; spreading preserves every other server and
    // top-level key, and keeps existing key positions stable (so re-runs are no-ops).
    return { ...base, mcpServers: { ...servers, 'rw-ai': rwMcpCommand(platform) } };
  };

// The two stdin-driven commands rw installs as Claude Code hooks. Each command
// string is ALSO its dedupe key, so re-running never appends a duplicate group.
const LANE_GUARD_COMMAND = 'rw lane-guard';
const SESSION_START_COMMAND = 'rw session-start';

// True when a matcher-group already runs `command` (checked by the exact command
// string, per the dedupe contract). Event-agnostic: shared by every hook merge.
const groupRunsCommand = (group: unknown, command: string): boolean => {
  if (!isPlainObject(group) || !Array.isArray(group.hooks)) {
    return false;
  }
  return group.hooks.some(
    (hook) => isPlainObject(hook) && hook.type === 'command' && hook.command === command,
  );
};

// Append rw's group to an existing hook-event array only when no group already runs
// the command, so re-runs are no-ops. Every existing group and key is preserved.
const ensureHookGroup = (
  existing: unknown,
  command: string,
  group: JsonObject,
): readonly JsonObject[] => {
  const groups = Array.isArray(existing) ? (existing as JsonObject[]) : [];
  return groups.some((candidate) => groupRunsCommand(candidate, command))
    ? groups
    : [...groups, group];
};

// Claude Code runs PreToolUse hooks before Write/Edit/MultiEdit (rw blocks
// out-of-lane writes) and SessionStart hooks when a session opens (rw surfaces its
// availability and offers bootstrap). Both are merged non-destructively and deduped
// by the exact command string, so re-running rw adapters never duplicates a group.
const mergeSettingsJson = (base: JsonObject): JsonObject => {
  const hooks = isPlainObject(base.hooks) ? base.hooks : {};
  const nextPreToolUse = ensureHookGroup(hooks.PreToolUse, LANE_GUARD_COMMAND, {
    matcher: 'Write|Edit|MultiEdit',
    hooks: [{ type: 'command', command: LANE_GUARD_COMMAND }],
  });
  // SessionStart takes an OPTIONAL source matcher (startup|resume|clear|compact);
  // omitting it fires on EVERY session-open source, which is what we want — rw
  // should surface on startup, resume and clear alike.
  const nextSessionStart = ensureHookGroup(hooks.SessionStart, SESSION_START_COMMAND, {
    hooks: [{ type: 'command', command: SESSION_START_COMMAND }],
  });
  return {
    ...base,
    hooks: { ...hooks, PreToolUse: nextPreToolUse, SessionStart: nextSessionStart },
  };
};

// OpenCode's local-MCP shape is confirmed from its docs: an `mcp.<name>` entry with
// type 'local' and a command STRING ARRAY. Only the rw-ai key is added/overwritten;
// $schema is added when absent so editors get completion, never overriding a set one.
// NOTE: OpenCode's pre-write hook (`tool.execute.before`) is plugin-only (a TS file),
// not a JSON entry, so the lane guard is NOT wired for OpenCode here — see README.
// Curried by platform like mergeMcpJson: OpenCode wants the command as a STRING
// ARRAY, so the platform-aware command is flattened to [command, ...args] — on
// Windows `['cmd','/c','rw','mcp']`, elsewhere `['rw','mcp']`.
const mergeOpencodeJson =
  (platform: NodeJS.Platform) =>
  (base: JsonObject): JsonObject => {
    const mcp = isPlainObject(base.mcp) ? base.mcp : {};
    const withSchema =
      base.$schema === undefined ? { $schema: 'https://opencode.ai/config.json', ...base } : base;
    const { command, args } = rwMcpCommand(platform);
    return {
      ...withSchema,
      mcp: { ...mcp, 'rw-ai': { type: 'local', command: [command, ...args], enabled: true } },
    };
  };

// The two Claude Code config files: the MCP server (.mcp.json) and the PreToolUse
// lane-guard hook (.claude/settings.json). Split out because --worktrees replicates
// exactly these two into each active worktree.
const installClaudeConfigs = async (
  root: string,
  platform: NodeJS.Platform,
): Promise<Result<AdapterWrite[], AdaptersError>> => {
  const writes: AdapterWrite[] = [];
  const mcp = await mergeJsonConfig(path.join(root, '.mcp.json'), mergeMcpJson(platform));
  if (!mcp.ok) {
    return mcp;
  }
  writes.push(mcp.value);
  const settings = await mergeJsonConfig(path.join(root, '.claude', 'settings.json'), mergeSettingsJson);
  if (!settings.ok) {
    return settings;
  }
  writes.push(settings.value);
  return ok(writes);
};

// The full "inside the agent" config wiring at a shared root: the two Claude Code
// files PLUS OpenCode's opencode.json MCP entry.
const installAgentConfigs = async (
  root: string,
  platform: NodeJS.Platform,
): Promise<Result<AdapterWrite[], AdaptersError>> => {
  const claude = await installClaudeConfigs(root, platform);
  if (!claude.ok) {
    return claude;
  }
  const opencode = await mergeJsonConfig(path.join(root, 'opencode.json'), mergeOpencodeJson(platform));
  if (!opencode.ok) {
    return opencode;
  }
  return ok([...claude.value, opencode.value]);
};

// The user-scope install: rw's MCP server + hooks written under `homeDir` so EVERY
// Claude Code / OpenCode session on the machine sees rw, with no per-project setup.
// It is config-independent (the wiring is static: `rw mcp` / `rw lane-guard` /
// `rw session-start`), so it needs no repo. Every file is MERGED non-destructively —
// ~/.claude.json in particular holds the user's projects and history, which must
// survive untouched.
//
// Locations confirmed against the Claude Code / OpenCode docs, and deliberately
// DIFFERENT from the project scope:
//   - Claude Code MCP servers → ~/.claude.json under `mcpServers` (where
//     `claude mcp add --scope user` stores them), NOT settings.json.
//   - Claude Code hooks       → ~/.claude/settings.json (apply to every project).
//   - OpenCode MCP servers    → ~/.config/opencode/opencode.json under `mcp`.
export const installUserAdapters = async (
  homeDir: string,
  platform: NodeJS.Platform,
): Promise<Result<AdaptersInstallResult, AdaptersError>> => {
  const written: AdapterWrite[] = [];
  const claudeMcp = await mergeJsonConfig(path.join(homeDir, '.claude.json'), mergeMcpJson(platform));
  if (!claudeMcp.ok) {
    return claudeMcp;
  }
  written.push(claudeMcp.value);
  const claudeSettings = await mergeJsonConfig(
    path.join(homeDir, '.claude', 'settings.json'),
    mergeSettingsJson,
  );
  if (!claudeSettings.ok) {
    return claudeSettings;
  }
  written.push(claudeSettings.value);
  const opencode = await mergeJsonConfig(
    path.join(homeDir, '.config', 'opencode', 'opencode.json'),
    mergeOpencodeJson(platform),
  );
  if (!opencode.ok) {
    return opencode;
  }
  written.push(opencode.value);
  return ok({ written });
};

export type InstallAdaptersOptions = {
  // When true, the two Claude Code config files (.mcp.json + .claude/settings.json)
  // are ALSO written into each active session worktree, so an agent started inside
  // a worktree is wired there too. Default: only the shared project root.
  readonly worktrees?: boolean;
  // When true, install rw's MCP server + hooks at the USER scope under `homeDir`
  // instead of the project, so EVERY Claude Code / OpenCode session on the machine
  // sees rw with no per-project setup. projectRoot/config are ignored — the wiring
  // is config-independent — so `homeDir` MUST be provided. Delegates to
  // installUserAdapters; see it for the exact user-scoped file locations.
  readonly user?: boolean;
  readonly homeDir?: string;
};

// Writes the cross-agent adapters into a target repo, idempotently. Unlike the
// board, these files are meant to be COMMITTED (never gitignored): re-running
// rewrites only what changed, and config-derived content updates with the config.
// Beyond the skills/command wrappers, it wires the WHOLE "inside the agent" model:
// the MCP server config and the PreToolUse lane-guard hook, merged non-destructively.
export const installAdapters = async (
  projectRoot: string,
  config: AgentsConfig,
  platform: NodeJS.Platform,
  options: InstallAdaptersOptions = {},
): Promise<Result<AdaptersInstallResult, AdaptersError>> => {
  // User scope short-circuits: only the machine-wide config files under homeDir are
  // written; projectRoot/config are unused (the wiring is config-independent), so a
  // global install needs no repo. Guard homeDir because it is optional on the type.
  if (options.user === true) {
    return options.homeDir === undefined
      ? err({ kind: 'io', message: 'la instalación a nivel usuario requiere homeDir' })
      : installUserAdapters(options.homeDir, platform);
  }

  const written: AdapterWrite[] = [];
  for (const { relPath, content } of planWrites(config)) {
    const filePath = path.join(projectRoot, relPath);
    try {
      await fs.mkdir(path.dirname(filePath), { recursive: true });
    } catch (error) {
      return err({
        kind: 'io',
        message: `could not create dir for ${filePath}: ${errorMessage(error)}`,
        cause: error,
      });
    }
    const result = await writeFileIdempotent(filePath, content);
    if (!result.ok) {
      return err({ kind: 'io', message: result.error.message, cause: result.error.cause });
    }
    written.push({ path: filePath, action: result.value.action });
  }

  // The MCP + hook wiring at the shared root (Claude Code .mcp.json/settings.json +
  // OpenCode opencode.json). A non-JSON existing config aborts here without clobber.
  const rootConfigs = await installAgentConfigs(projectRoot, platform);
  if (!rootConfigs.ok) {
    return rootConfigs;
  }
  written.push(...rootConfigs.value);

  // --worktrees: replicate the two Claude Code config files into each active
  // worktree, so a per-worktree agent (resolving its session from the cwd) is wired.
  if (options.worktrees === true) {
    for (const session of activeSessions(config)) {
      const worktreeConfigs = await installClaudeConfigs(
        path.join(projectRoot, session.worktree),
        platform,
      );
      if (!worktreeConfigs.ok) {
        return worktreeConfigs;
      }
      written.push(...worktreeConfigs.value);
    }
  }

  return ok({ written });
};
