import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { ENV_KEYS } from '../contract/env.js';
import { agentKindSchema } from '../contract/schema.js';
import { readVersion } from '../cli/version.js';
import type { CommandRunner } from '../engine/exec.js';
import { resolveMcpContext, type McpContext } from './context.js';
import {
  handleCheck,
  handleClaim,
  handleFinish,
  handleLaneCheck,
  handleRoles,
  handleRelease,
  handleStatus,
  handleWhoami,
  type ToolDeps,
  type ToolResult,
} from './tools.js';

// The process boundary is injectable so the wiring stays testable without a real
// terminal: tests can pass a fixed cwd/clock/env and stub runners; production
// defaults read the real process.
export type RwMcpServerDeps = {
  readonly cwd?: () => string;
  readonly now?: () => Date;
  readonly env?: NodeJS.ProcessEnv;
  readonly run?: CommandRunner;
  readonly runRaw?: CommandRunner;
};

// Pretty JSON so a human reading the agent transcript can follow tool output; the
// isError flag mirrors the handler's ok flag so clients branch on failures.
const jsonResult = (payload: unknown, isError: boolean): CallToolResult => ({
  content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
  isError,
});

// Wire the pure handlers into an McpServer. The server owns process access (cwd,
// env, clock) and the per-agent identity token; the handlers stay pure and are
// unit-tested independently.
export const createRwMcpServer = (deps: RwMcpServerDeps = {}): McpServer => {
  const cwd = deps.cwd ?? ((): string => process.cwd());
  const now = deps.now ?? ((): Date => new Date());
  const env = deps.env ?? process.env;

  // Per-agent identity: rw_claim stores the minted token here so later tools in
  // the SAME MCP session (whoami/release/finish) act as its holder, falling back
  // to RW_TOKEN from the environment when nothing was claimed in-session.
  let sessionToken: string | undefined;
  const resolveToken = (): string | undefined => sessionToken ?? env[ENV_KEYS.token];

  const toolDeps = (): ToolDeps => ({
    now: now(),
    run: deps.run,
    runRaw: deps.runRaw,
    token: resolveToken(),
  });

  // Resolve the shared context (from the agent's worktree cwd) once per call, run
  // the handler, and serialize its structured result. A context failure is itself
  // surfaced as a tool error rather than crashing the server.
  const runTool = async <T>(
    handler: (ctx: McpContext, toolDep: ToolDeps) => ToolResult<T> | Promise<ToolResult<T>>,
  ): Promise<CallToolResult> => {
    const ctx = await resolveMcpContext(cwd(), deps.run, deps.runRaw);
    if (!ctx.ok) {
      return jsonResult({ ok: false, error: { kind: ctx.error.kind, message: ctx.error.message } }, true);
    }
    const result = await handler(ctx.value, toolDeps());
    return jsonResult(result, !result.ok);
  };

  const server = new McpServer({ name: 'rw-ai', version: readVersion() });

  server.registerTool(
    'rw_status',
    {
      title: 'Estado de rw',
      description:
        'Muestra la raíz compartida del repo, la sesión actual (si el cwd está dentro de un worktree) y el estado de todos los roles.',
      inputSchema: {},
    },
    () => runTool((ctx, toolDep) => handleStatus(ctx, toolDep)),
  );

  server.registerTool(
    'rw_roles',
    {
      title: 'Roles de rw',
      description: 'Lista cada rol reclamable (sesiones activas e integrador) con su estado libre/ocupado.',
      inputSchema: {},
    },
    () => runTool((ctx, toolDep) => handleRoles(ctx, toolDep)),
  );

  server.registerTool(
    'rw_whoami',
    {
      title: 'Identidad de rw',
      description:
        'Devuelve el rol que tiene tu token actual (el reclamado en esta sesión MCP o RW_TOKEN del entorno).',
      inputSchema: {},
    },
    () => runTool((ctx, toolDep) => handleWhoami(ctx, toolDep)),
  );

  server.registerTool(
    'rw_claim',
    {
      title: 'Reclamar un rol',
      description:
        'Reclama un rol (por defecto el de la sesión actual). Genera un token, lo guarda en memoria para esta sesión MCP y lo devuelve. Acepta "role", "agent" y "ttlHours".',
      inputSchema: {
        role: z.string().optional(),
        agent: agentKindSchema.optional(),
        ttlHours: z.number().positive().optional(),
      },
    },
    (args) =>
      runTool(async (ctx, toolDep) => {
        const result = await handleClaim(ctx, args, toolDep);
        if (result.ok) {
          // Make the rest of this MCP session act as the holder of the new claim.
          sessionToken = result.token;
        }
        return result;
      }),
  );

  server.registerTool(
    'rw_release',
    {
      title: 'Liberar un rol',
      description:
        'Libera el rol que tienes reclamado (por defecto el de la sesión actual), usando el token en memoria o RW_TOKEN.',
      inputSchema: { role: z.string().optional() },
    },
    (args) => runTool((ctx, toolDep) => handleRelease(ctx, args, toolDep)),
  );

  server.registerTool(
    'rw_check',
    {
      title: 'Analizar la integración',
      description:
        'Analiza el estado real de git: detecta invasiones de carril y conflictos simulados, escribe el reporte y devuelve un flag "blocking" para la compuerta previa a integrar.',
      inputSchema: {},
    },
    () => runTool((ctx, toolDep) => handleCheck(ctx, toolDep)),
  );

  server.registerTool(
    'rw_finish',
    {
      title: 'Integrar la sesión',
      description:
        'Integra la sesión actual en la rama de integración y rota su rama. Requiere ejecutarse desde el worktree de una sesión. Acepta "newBranch" para nombrar la rama rotada.',
      inputSchema: { newBranch: z.string().optional() },
    },
    (args) => runTool((ctx, toolDep) => handleFinish(ctx, args, toolDep)),
  );

  server.registerTool(
    'rw_lane_check',
    {
      title: 'Verificar carril',
      description:
        'Clasifica una ruta contra las áreas de la sesión actual y las zonas compartidas: devuelve "in-area", "shared-zone" o "invasion" y si está permitida.',
      inputSchema: { path: z.string() },
    },
    (args) => runTool((ctx) => handleLaneCheck(ctx, args)),
  );

  return server;
};

// Long-lived stdio entry point: connects the server to the process's stdio and
// never returns while the transport is open. This is the impure boundary the bin
// invokes for `rw mcp`.
export const startRwMcpServer = async (): Promise<void> => {
  await createRwMcpServer().connect(new StdioServerTransport());
};
