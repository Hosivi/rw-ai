import path from 'node:path';
import { resolveBoardDir } from '../../contract/env.js';
import { filterByCwd, listClaudeSessions } from '../../engine/claude-sessions.js';
import { createGit } from '../../engine/git.js';
import { listRoles } from '../../engine/identity.js';
import type { CliDeps, CommandResult } from '../command.js';
import { loadContext } from '../context.js';
import { formatClaudeSessions, formatRoles } from '../output.js';

export type SessionsArgs = {
  readonly cwd?: string;
  readonly claim?: boolean;
};

// Resolve the --cwd target to the path Claude jobs are keyed under. '.'/empty
// means "here" (deps.cwd); a relative value is resolved against it. We then prefer
// the git toplevel so a subdirectory or worktree collapses to the project root the
// jobs live under, falling back to the raw path when it is not inside a repo.
const resolveTarget = async (raw: string, deps: CliDeps): Promise<string> => {
  const target = raw === '' || raw === '.' ? deps.cwd : path.resolve(deps.cwd, raw);
  const toplevel = await createGit(target, deps.run, deps.runRaw).toplevel();
  return toplevel.ok ? toplevel.value : target;
};

// The claimed-roles section correlated by cwd: the roles rw has claimed in THIS
// project, shown alongside the Claude jobs above. The correlation is loose on
// purpose — there is no hard link between a Claude job and an rw claim, both just
// happen to live under the same project path — so the note says so explicitly.
const claimSection = async (deps: CliDeps): Promise<readonly string[]> => {
  const context = await loadContext(deps.cwd, deps.run, deps.runRaw);
  if (!context.ok) {
    // Not a rw repo / no config: claims simply do not apply here. This must NOT
    // fail the command — the machine job listing above is still valid.
    return ['', '_Este directorio no es un proyecto rw (sin agents.config.json); omito los claims._'];
  }
  const { config, projectRoot } = context.value;
  const roles = await listRoles({ config, boardDir: resolveBoardDir(projectRoot, config), now: deps.now });
  if (!roles.ok) {
    // A claims read failure is likewise not fatal to the sessions listing.
    return ['', `_No pude leer los roles reclamados: ${roles.error.message}._`];
  }
  return [
    '',
    '## Roles reclamados en este proyecto',
    '',
    '_Correlación por cwd: estos son los roles que rw tiene reclamados en este proyecto, junto a los jobs de Claude Code de arriba. No hay un vínculo directo entre un job y un claim._',
    '',
    formatRoles(roles.value),
  ];
};

// `rw sessions`: list Claude Code's machine-level background jobs (NOT rw's git
// sessions). --cwd filters to a project's jobs; --claim also shows the rw roles
// claimed in the current project as a loose, cwd-based correlation.
export const runSessions = async (args: SessionsArgs, deps: CliDeps): Promise<CommandResult> => {
  const listed = await listClaudeSessions(deps.homeDir);
  if (!listed.ok) {
    return { lines: [`No pude leer los jobs de Claude Code: ${listed.error.message}`], exitCode: 1 };
  }

  let sessions = listed.value;
  if (args.cwd !== undefined) {
    const target = await resolveTarget(args.cwd, deps);
    sessions = filterByCwd(sessions, target);
  }

  const lines = [...formatClaudeSessions(sessions).split('\n')];
  if (args.claim === true) {
    lines.push(...(await claimSection(deps)));
  }
  return { lines, exitCode: 0 };
};
