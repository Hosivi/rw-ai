import { activeSessions } from '../../engine/sessions.js';
import { resolveMcpContext } from '../../mcp/context.js';
import type { CliDeps, CommandResult } from '../command.js';

// `rw session-start`: the Claude Code SessionStart hook. When a session opens,
// Claude Code runs this and merges the JSON's `additionalContext` into the session
// (contract confirmed against the docs: an object with
// `hookSpecificOutput.hookEventName === 'SessionStart'` and an `additionalContext`
// string, printed to stdout, exit 0). rw uses it to make itself DISCOVERABLE — and,
// crucially, to OFFER bootstrap in an unconfigured repo rather than ever mutating
// git behind the agent's back (Option A: offer, never auto-run).

// The single output shape: one JSON line, always exit 0. Emitting exactly the
// SessionStart hookSpecificOutput object is what makes Claude Code treat the text
// as extra session context.
const sessionStartOutput = (additionalContext: string): CommandResult => ({
  lines: [
    JSON.stringify({
      hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext },
    }),
  ],
  exitCode: 0,
});

// The offer shown when this is not a rw repo (no git, or git without
// agents.config.json). It INVITES the agent to bootstrap and states plainly that
// nothing happens on its own — a SessionStart hook that silently ran `git init` +
// created worktrees would be a hostile surprise, so rw only surfaces the tool.
const OFFER_CONTEXT =
  'rw-ai disponible. Este directorio no está configurado para trabajo multi-sesión. ' +
  'Si lo necesitas, llama la tool rw_bootstrap (o corre `rw bootstrap`) para inicializar ' +
  'git + sesiones aisladas. NO se hace nada automáticamente.';

export const runSessionStart = async (
  deps: CliDeps & { readonly stdin: string },
): Promise<CommandResult> => {
  // FAIL-OPEN is the prime directive: a SessionStart hook must NEVER break session
  // startup. Any thrown error collapses to the generic offer note at exit 0. The
  // hook payload (deps.stdin) is intentionally not read for logic — deps.cwd is the
  // authoritative session location and the surfaced context does not depend on the
  // payload's `source`, so an empty or malformed payload cannot change the outcome.
  try {
    const context = await resolveMcpContext(deps.cwd, deps.run, deps.runRaw);
    if (!context.ok) {
      // not-a-repo / config-not-found (and, fail-open, config-invalid / io): rw is
      // available but this place is not set up — OFFER bootstrap, never run it.
      return sessionStartOutput(OFFER_CONTEXT);
    }

    const { config, currentSession } = context.value;
    if (currentSession !== undefined) {
      // Inside a session worktree: point the agent at its role and the lane guard.
      const areas = currentSession.areas.join(', ');
      return sessionStartOutput(
        `Estás en la sesión ${currentSession.id} (rama ${currentSession.branch}). ` +
          `Áreas: ${areas}. Reclama el rol con la tool rw_claim. ` +
          'El hook rw lane-guard bloquea escrituras fuera de tus áreas.',
      );
    }

    // Configured but at the shared root: the agent must open inside a worktree to
    // act as a session. Surface the read-only tools it can use from here.
    const count = activeSessions(config).length;
    return sessionStartOutput(
      `Repo rw configurado con ${count} sesiones activas. Para trabajar como una sesión, ` +
        'abre el agente dentro de .worktrees/<id>. Tools: rw_status, rw_check, rw_roles.',
    );
  } catch {
    // Truly unexpected: still exit 0 with the generic offer, never propagate.
    return sessionStartOutput(OFFER_CONTEXT);
  }
};
