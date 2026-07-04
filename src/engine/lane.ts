import path from 'node:path';
import type { Session } from '../contract/schema.js';
import { normalizeRepoPath } from './git.js';
import { classifyChangedFile, type FileClass } from './integrator.js';

// The lane decision for a single write: the git-relative path it maps to, how it
// classifies against the session's lane, and whether it is permitted. `allowed`
// is the only bit the real-time hook keys on; `relPath` and `class` explain WHY.
export type LaneVerdict = {
  readonly relPath: string;
  readonly class: FileClass;
  readonly allowed: boolean;
};

export type LaneVerdictParams = {
  readonly targetPath: string;
  readonly sharedRoot: string;
  readonly session: Session;
  readonly sharedZones: readonly string[];
};

// A relPath that leaves the worktree can never sit inside a lane: '../' escapes
// upward, and an absolute result (a different Windows drive) never shares a root.
const escapesWorktree = (relPath: string): boolean =>
  relPath === '' || relPath === '..' || relPath.startsWith('../') || path.isAbsolute(relPath);

// Decide whether an ABSOLUTE tool-call path is inside the current session's lane.
//
// The area/shared-zone globs (e.g. `src/s1/**`) are written against the REPO tree,
// exactly as git reports changed files — which is what `classifyChangedFile` and
// `rw check` consume. An agent works inside its own worktree (`<sharedRoot>/
// .worktrees/sN`), whose tree mirrors the repo, so the git-relative path is the
// target with the WORKTREE prefix stripped — NOT the sharedRoot prefix (that would
// leave a `.worktrees/sN/…` prefix and flag every legitimate write as an invasion,
// disagreeing with `rw check`). `sharedRoot` is still the anchor the worktree is
// resolved against. Both sides are normalized so drive-letter casing and back/
// forward slashes never make a same-tree path look foreign.
export const laneVerdict = (params: LaneVerdictParams): LaneVerdict => {
  const { targetPath, sharedRoot, session, sharedZones } = params;
  const laneRoot = path.resolve(normalizeRepoPath(sharedRoot), session.worktree);
  const relPath = normalizeRepoPath(path.relative(laneRoot, normalizeRepoPath(targetPath)));
  if (escapesWorktree(relPath)) {
    return { relPath, class: 'invasion', allowed: false };
  }
  const fileClass = classifyChangedFile(relPath, session.areas, sharedZones);
  return { relPath, class: fileClass, allowed: fileClass !== 'invasion' };
};
