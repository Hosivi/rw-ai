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
  readonly kind: 'io';
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

// Writes the cross-agent adapters into a target repo, idempotently. Unlike the
// board, these files are meant to be COMMITTED (never gitignored): re-running
// rewrites only what changed, and config-derived content updates with the config.
export const installAdapters = async (
  projectRoot: string,
  config: AgentsConfig,
): Promise<Result<AdaptersInstallResult, AdaptersError>> => {
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
  return ok({ written });
};
