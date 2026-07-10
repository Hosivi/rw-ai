import path from 'node:path';
import { resolveBoardDir } from '../../contract/env.js';
import { forceFreeRole } from '../../engine/identity.js';
import { normalizeRepoPath } from '../../engine/git.js';
import { readDecisions, writeDecision, type DecisionVerdict } from '../../state/decisions.js';
import type { CliDeps, CommandResult } from '../command.js';
import { contextErrorResult } from '../command.js';
import { loadContext } from '../context.js';

// `rw review-info <session> [--json]`: everything the Neovim review pane needs —
// the session's branch/worktree, the integration branch, and the files it changed
// vs integration. Read-only.
export const runReviewInfo = async (
  args: { readonly session: string | undefined; readonly json: boolean },
  deps: CliDeps,
): Promise<CommandResult> => {
  if (args.session === undefined || args.session.trim() === '') {
    return { lines: ['Falta la sesión. Uso: rw review-info <sesión> [--json]'], exitCode: 2 };
  }
  const context = await loadContext(deps.cwd, deps.run, deps.runRaw);
  if (!context.ok) {
    return contextErrorResult(context.error);
  }
  const { projectRoot, config, git } = context.value;
  const session = config.sessions.find((s) => s.id === args.session);
  if (session === undefined) {
    return { lines: [`Sesión desconocida: ${args.session}`], exitCode: 1 };
  }
  const integrationBranch = config.git.integrationBranch;
  const changed = await git.changedFiles(integrationBranch, session.branch);
  if (!changed.ok) {
    return { lines: [`No se pudo calcular el diff: ${changed.error.kind}`], exitCode: 1 };
  }
  const boardDir = resolveBoardDir(projectRoot, config);
  const decisions = await readDecisions(boardDir, session.id);
  // Everything the review pane needs in one shot: diff targets, the worktree to
  // open files from, and the evidence (board dir, integrator report path, prior
  // decisions). The plugin checks whether the report file exists itself.
  const info = {
    sessionId: session.id,
    branch: session.branch,
    integrationBranch,
    worktree: normalizeRepoPath(path.join(projectRoot, session.worktree)),
    boardDir: normalizeRepoPath(boardDir),
    reportPath: normalizeRepoPath(path.join(boardDir, 'reports', 'integration.md')),
    changedFiles: changed.value,
    decisions: decisions.ok ? decisions.value : [],
  };
  if (args.json) {
    return { lines: [JSON.stringify(info, null, 2)], exitCode: 0 };
  }
  return {
    lines: [
      `Sesión ${info.sessionId} (${info.branch}) vs ${integrationBranch}`,
      `Worktree: ${info.worktree}`,
      `Archivos cambiados (${info.changedFiles.length}):`,
      ...info.changedFiles.map((f) => `  ${f}`),
    ],
    exitCode: 0,
  };
};

// `rw decide <session> --approve|--reject [--comment "..."]`: record a review
// decision and release the integrator claim so the next review can proceed.
// The decision record is the authoritative log (who/when/verdict); the claim is
// force-released because the act of deciding concludes the review.
export const runDecide = async (
  args: {
    readonly session: string | undefined;
    readonly verdict: DecisionVerdict | undefined;
    readonly comment: string | undefined;
  },
  deps: CliDeps,
): Promise<CommandResult> => {
  if (args.session === undefined || args.session.trim() === '') {
    return { lines: ['Falta la sesión. Uso: rw decide <sesión> --approve|--reject'], exitCode: 2 };
  }
  if (args.verdict === undefined) {
    return { lines: ['Falta el veredicto. Pasa --approve o --reject.'], exitCode: 2 };
  }
  const context = await loadContext(deps.cwd, deps.run, deps.runRaw);
  if (!context.ok) {
    return contextErrorResult(context.error);
  }
  const { projectRoot, config } = context.value;
  if (!config.sessions.some((s) => s.id === args.session)) {
    return { lines: [`Sesión desconocida: ${args.session}`], exitCode: 1 };
  }
  const boardDir = resolveBoardDir(projectRoot, config);

  const written = await writeDecision(boardDir, {
    version: 1,
    sessionId: args.session,
    verdict: args.verdict,
    ...(args.comment !== undefined && args.comment !== '' ? { comment: args.comment } : {}),
    decidedAt: deps.now.toISOString(),
  });
  if (!written.ok) {
    return { lines: [`No se pudo registrar la decisión: ${written.error.message}`], exitCode: 1 };
  }

  const released = await forceFreeRole(config, boardDir, 'integrator', deps.now);
  if (!released.ok) {
    return {
      lines: [
        `Decisión registrada (${args.verdict}) pero no se pudo liberar el integrator: ${released.error.kind}`,
      ],
      exitCode: 1,
    };
  }
  const verdictEs = args.verdict === 'approved' ? 'aprobada' : 'rechazada';
  return { lines: [`Sesión ${args.session} ${verdictEs}. Integrator liberado.`], exitCode: 0 };
};
