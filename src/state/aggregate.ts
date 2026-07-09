import type { AgentsConfig } from '../contract/schema.js';
import { activeSessions } from '../engine/sessions.js';
import type { RoleStatus } from '../engine/identity.js';
import type { SessionMarker } from './marker.js';

// The three-state light a cockpit renders per session.
export type Light = 'red' | 'yellow' | 'green';

// Working-tree divergence for one session, produced by git.statusPorcelain
// (dirty) and git.aheadBehind (ahead/behind) — NOT changedFiles, which is a
// ref-to-ref diff, not the live tree state.
export type GitSignal = {
  readonly dirty: boolean;
  readonly ahead: number;
  readonly behind: number;
};

export type SessionState = {
  readonly sessionId: string;
  readonly branch: string;
  readonly areas: readonly string[];
  readonly claim: RoleStatus;
  readonly marker: SessionMarker | null;
  readonly git: GitSignal;
  readonly light: Light;
};

const CLEAN_GIT: GitSignal = { dirty: false, ahead: 0, behind: 0 };

const claimHeld = (claim: RoleStatus): boolean =>
  claim.status === 'claimed' && !claim.expired;

// Deterministic precedence, evaluated top-down:
//   1. red    — the session is blocked or its tests failed (worst signal wins).
//   2. yellow — the marker says work/review is in progress, OR a *held* claim
//               has uncommitted/ahead work (an owner is mid-flight).
//   3. green  — everything else: idle/free and nothing in progress.
// Note: git dirt/ahead only lifts to yellow when the claim is actually held;
// unowned or expired-claim dirt stays green (no live owner to attribute it to).
export const deriveLight = (
  claim: RoleStatus,
  marker: SessionMarker | null,
  git: GitSignal,
): Light => {
  if (marker?.phase === 'blocked' || marker?.tests === 'failed') {
    return 'red';
  }
  if (marker?.phase === 'working' || marker?.phase === 'review') {
    return 'yellow';
  }
  if (claimHeld(claim) && (git.dirty || git.ahead > 0)) {
    return 'yellow';
  }
  return 'green';
};

// Pure fold over already-read signals: config gives the active session set and
// each session's identity; the three maps supply per-session claim/marker/git,
// each defaulting to a safe value when absent so a session is never dropped.
export const computeSessionState = (
  config: AgentsConfig,
  claims: readonly RoleStatus[],
  markers: ReadonlyMap<string, SessionMarker | null>,
  gitSignals: ReadonlyMap<string, GitSignal>,
): SessionState[] =>
  activeSessions(config).map((session) => {
    const claim: RoleStatus =
      claims.find((c) => c.role === session.id) ?? {
        role: session.id,
        status: 'free',
        expired: false,
      };
    const marker = markers.get(session.id) ?? null;
    const git = gitSignals.get(session.id) ?? CLEAN_GIT;
    return {
      sessionId: session.id,
      branch: session.branch,
      areas: session.areas,
      claim,
      marker,
      git,
      light: deriveLight(claim, marker, git),
    };
  });
