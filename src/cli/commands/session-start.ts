import { activeSessions } from '../../engine/sessions.js';
import { resolveMcpContext } from '../../mcp/context.js';
import { writeSessionMarker } from '../../state/marker.js';
import type { CliDeps, CommandResult } from '../command.js';

// `rw session-start`: the Claude Code SessionStart hook. When a session opens,
// Claude Code runs this to let rw make itself DISCOVERABLE — and, crucially, to
// OFFER bootstrap in an unconfigured repo rather than ever mutating git behind the
// agent's back (Option A: offer, never auto-run).
//
// WHY stderr + exit 2 (not stdout + exit 0): a SessionStart hook's stdout
// `additionalContext` is invisible to the HUMAN — Claude Code merges it into the
// model's context but never renders it in the terminal, so the person opening the
// session would never see that rw is available. The ONLY channel that shows the
// human hook text is stderr + exit 2 (exactly what `rw lane-guard` uses). So rw
// emits its offer on stderr + exit 2, and the user SEES that rw is here and how to
// configure it. Tradeoff: exit 2 makes Claude ignore stdout, so the agent no longer
// receives `additionalContext` — but it still discovers rw through the MCP `rw_*`
// tools and the installed skills, so nothing is lost on the agent side.

// The single output shape: no stdout, the message on stderr, exit 2 — the human-
// visible SessionStart channel (mirrors `rw lane-guard`'s block shape).
const sessionStartOutput = (message: string): CommandResult => ({
  lines: [],
  stderr: [message],
  exitCode: 2,
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
  // startup. Any thrown error collapses to the generic offer note (stderr, exit 2). The
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
      // Wire the read-model marker: an agent opening inside a session worktree is
      // the workspace signal `rw status` reports. Best-effort — a marker failure
      // must NEVER change the hook output or break startup, so it is isolated in
      // its own try/catch and its Result is deliberately ignored.
      try {
        await writeSessionMarker(context.value.boardDir, {
          version: 1,
          sessionId: currentSession.id,
          phase: 'working',
          updatedAt: deps.now.toISOString(),
        });
      } catch {
        // fail-open: swallow any unexpected throw from the marker write.
      }

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
    // Truly unexpected: still the generic offer on stderr + exit 2, never propagate.
    return sessionStartOutput(OFFER_CONTEXT);
  }
};
