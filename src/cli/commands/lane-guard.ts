import path from 'node:path';
import { laneVerdict } from '../../engine/lane.js';
import { resolveMcpContext } from '../../mcp/context.js';
import type { CliDeps, CommandResult } from '../command.js';

// Fail-open: a coordination guard must NEVER hard-block on its own uncertainty.
// Every non-invasion path — and every case where we cannot even decide (no file
// path, unparseable payload, not inside a rw session) — returns this: exit 0, no
// output, so agents in non-rw repos are untouched.
const ALLOW: CommandResult = { lines: [], exitCode: 0 };

// Pull the target file path out of a PreToolUse payload. Write/Edit/MultiEdit all
// carry it at tool_input.file_path; anything else (a non-file tool, or a shape we
// don't recognize) yields undefined so the guard allows. Parsing is defensive:
// malformed JSON is treated as "nothing to govern", never as a failure.
const extractFilePath = (stdin: string): string | undefined => {
  let payload: unknown;
  try {
    payload = JSON.parse(stdin);
  } catch {
    return undefined;
  }
  if (typeof payload !== 'object' || payload === null) {
    return undefined;
  }
  const toolInput = (payload as { readonly tool_input?: unknown }).tool_input;
  if (typeof toolInput !== 'object' || toolInput === null) {
    return undefined;
  }
  const filePath = (toolInput as { readonly file_path?: unknown }).file_path;
  return typeof filePath === 'string' && filePath.length > 0 ? filePath : undefined;
};

// `rw lane-guard`: the PreToolUse hook. It reads a Claude Code hook payload from
// stdin (INJECTED via deps so it stays pure) and decides whether to block a file
// write that leaves the session's lane. Blocking uses exit 2 + a stderr reason,
// which is Claude Code's convention (exit 2 blocks the tool and feeds stderr back
// to the agent); stdout stays empty because Claude Code ignores stdout JSON when a
// hook exits 2, so emitting both would be redundant and is explicitly discouraged.
export const runLaneGuard = async (
  deps: CliDeps & { readonly stdin: string },
): Promise<CommandResult> => {
  const filePath = extractFilePath(deps.stdin);
  if (filePath === undefined) {
    return ALLOW; // not a file write, or unparseable — nothing to govern
  }

  const context = await resolveMcpContext(deps.cwd, deps.run, deps.runRaw);
  if (!context.ok || context.value.currentSession === undefined) {
    // Outside a rw session, or config missing/invalid: never break the agent.
    return ALLOW;
  }
  const { sharedRoot, config, currentSession } = context.value;

  const absPath = path.isAbsolute(filePath) ? filePath : path.resolve(deps.cwd, filePath);
  const verdict = laneVerdict({
    targetPath: absPath,
    sharedRoot,
    session: currentSession,
    sharedZones: config.sharedZones,
  });
  if (verdict.allowed) {
    return ALLOW;
  }

  const areas = currentSession.areas.join(', ');
  const reason = `Bloqueado por rw: '${verdict.relPath}' está fuera de las áreas de la sesión ${currentSession.id} (${areas}). Coordina o ajusta agents.config.json.`;
  return { lines: [], stderr: [reason], exitCode: 2 };
};
