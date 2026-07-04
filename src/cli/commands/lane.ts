import path from 'node:path';
import { laneVerdict, type LaneVerdict } from '../../engine/lane.js';
import { resolveMcpContext } from '../../mcp/context.js';
import type { CliDeps, CommandResult } from '../command.js';

// The Spanish label each classification prints. INVASIÓN is shouted so a human
// scanning output catches the one that matters.
const CLASS_LABEL: Record<LaneVerdict['class'], string> = {
  'in-area': 'en-area',
  'shared-zone': 'zona-compartida',
  invasion: 'INVASIÓN',
};

// `rw lane <ruta>`: the plain, human/script-facing lane check. Prints one Spanish
// line and sets a distinct exit code — 0 when the write is allowed, 3 when it is
// an invasion — so a script (or the hook) can branch on the code, not the text.
export const runLane = async (
  args: { readonly path?: string },
  deps: CliDeps,
): Promise<CommandResult> => {
  if (args.path === undefined || args.path.trim() === '') {
    return {
      lines: ['Indica una ruta para verificar el carril. Uso: rw lane <ruta>'],
      exitCode: 2,
    };
  }

  const context = await resolveMcpContext(deps.cwd, deps.run, deps.runRaw);
  if (!context.ok) {
    // The McpContextError message is already actionable Spanish; surface it as-is.
    return { lines: [context.error.message], exitCode: 1 };
  }
  const { sharedRoot, config, currentSession } = context.value;
  if (currentSession === undefined) {
    return {
      lines: [
        'Las verificaciones de carril solo aplican dentro del worktree de una sesión. Ejecútalo desde el worktree de tu sesión.',
      ],
      exitCode: 1,
    };
  }

  // A relative path is resolved against the invocation cwd (the worktree); an
  // absolute path is taken as-is.
  const absPath = path.isAbsolute(args.path) ? args.path : path.resolve(deps.cwd, args.path);
  const verdict = laneVerdict({
    targetPath: absPath,
    sharedRoot,
    session: currentSession,
    sharedZones: config.sharedZones,
  });
  const line = `${CLASS_LABEL[verdict.class]}: '${verdict.relPath}' (sesión ${currentSession.id})`;
  return { lines: [line], exitCode: verdict.allowed ? 0 : 3 };
};
