import type { Light, SessionState } from './aggregate.js';

// The wire/JSON-safe projection of a SessionState. CRITICAL: never expose the raw
// claim — RoleStatus.claim carries the secret claim token. Callers that send
// state off-process (rw status --json, the observer daemon) MUST project through
// here so the token can never leak. The marker holds no secrets and is passed
// through as phase/tests.
export type PublicSessionState = {
  readonly sessionId: string;
  readonly branch: string;
  readonly areas: readonly string[];
  readonly light: Light;
  readonly claim: { readonly status: 'free' | 'claimed'; readonly expired: boolean };
  readonly phase: string | null;
  readonly tests: string | null;
  readonly git: SessionState['git'];
};

export const toPublicState = (state: SessionState): PublicSessionState => ({
  sessionId: state.sessionId,
  branch: state.branch,
  areas: state.areas,
  light: state.light,
  claim: { status: state.claim.status, expired: state.claim.expired },
  phase: state.marker?.phase ?? null,
  tests: state.marker?.tests ?? null,
  git: state.git,
});
