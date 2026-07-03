import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createEmptyClaims, isClaimExpired } from '../contract/defaults.js';
import {
  MIN_CLAIM_TOKEN_LENGTH,
  parseClaimsFile,
  type AgentKind,
  type AgentsConfig,
  type Claim,
  type ClaimsFile,
} from '../contract/schema.js';
import { err, ok, type Result } from '../core/result.js';
import { writeFileAtomic } from './fs-atomic.js';
import { activeSessions } from './sessions.js';

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

// Kinds separate cooperative-locking outcomes ('invalid-role', 'invalid-token',
// 'occupied', 'token-mismatch', 'locked' — the caller can act on them) from I/O
// problems with the claims file ('invalid-json', 'invalid-claims', 'io').
export type IdentityError = {
  readonly kind:
    | 'invalid-role'
    | 'invalid-token'
    | 'occupied'
    | 'token-mismatch'
    | 'locked'
    | 'invalid-json'
    | 'invalid-claims'
    | 'io';
  readonly message: string;
  readonly role?: string;
  readonly cause?: unknown;
};

export const claimsFilePath = (boardDir: string): string => path.join(boardDir, 'claims.json');

// The crypto call is isolated here so it is the ONLY impure part: 16 bytes give
// 32 hex chars, far above MIN_CLAIM_TOKEN_LENGTH, so two agents cannot collide.
const defaultRandomToken = (): string => randomBytes(16).toString('hex');

export const generateClaimToken = (random: () => string = defaultRandomToken): string => random();

// The claimable role set: active session ids plus the integrator. Both whoami
// and listRoles use it so they agree on which roles exist (an archived or stray
// role in the file is never reported as a live identity).
const roleSet = (config: AgentsConfig): string[] => [
  ...activeSessions(config).map((session) => session.id),
  'integrator',
];

// A role is claimable when it is 'integrator' or an ACTIVE session id; archived
// sessions and stray names are refused so claims never accrete dead roles.
const validateRole = (config: AgentsConfig, role: string): Result<void, IdentityError> => {
  if (roleSet(config).includes(role)) {
    return ok(undefined);
  }
  return err({
    kind: 'invalid-role',
    role,
    message: `unknown role '${role}': must be 'integrator' or an active session id`,
  });
};

// Add a free entry for any active role missing from the file so sessions added
// after the file was first written become claimable; existing entries (even for
// roles no longer in config) are preserved, never dropped.
const reconcileClaims = (claims: ClaimsFile, config: AgentsConfig): ClaimsFile => {
  const reconciled: ClaimsFile['claims'] = { ...claims.claims };
  for (const role of roleSet(config)) {
    reconciled[role] ??= { status: 'free' };
  }
  return { version: 1, claims: reconciled };
};

export const readClaims = async (
  boardDir: string,
  config: AgentsConfig,
): Promise<Result<ClaimsFile, IdentityError>> => {
  const filePath = claimsFilePath(boardDir);
  let raw: string;
  try {
    raw = await fs.readFile(filePath, 'utf8');
  } catch (error) {
    // A missing file is the first-run state, not a failure: start from an empty
    // free-for-all set derived from config.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return ok(createEmptyClaims(config));
    }
    return err({ kind: 'io', message: `could not read ${filePath}: ${errorMessage(error)}`, cause: error });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return err({
      kind: 'invalid-json',
      message: `claims.json is not valid JSON: ${errorMessage(error)}`,
      cause: error,
    });
  }
  const claims = parseClaimsFile(parsed);
  if (!claims.ok) {
    return err({ kind: 'invalid-claims', message: claims.error.message, cause: claims.error });
  }
  return ok(reconcileClaims(claims.value, config));
};

export const writeClaims = async (
  boardDir: string,
  claims: ClaimsFile,
): Promise<Result<void, IdentityError>> => {
  // No mkdir on purpose: the board dir is provisioned earlier in the flow, so a
  // missing directory is a real error worth surfacing, not one to paper over.
  const serialized = `${JSON.stringify(claims, null, 2)}\n`;
  const written = await writeFileAtomic(claimsFilePath(boardDir), serialized);
  return written.ok ? ok(undefined) : err({ kind: 'io', message: written.error.message, cause: written.error.cause });
};

// Cooperative advisory lock so concurrent claim/release operations on DIFFERENT
// roles cannot clobber each other's read-modify-write (agent A claims s1, agent
// B reads the same snapshot and claims s2, B's write drops s1). The lock file
// sits beside claims.json; a lock older than STALE_LOCK_MS (measured against the
// injected `now`, never wall-clock) is assumed abandoned and broken.
const STALE_LOCK_MS = 15_000;
const LOCK_BACKOFF_MS = 75;
const LOCK_ACQUIRE_TIMEOUT_MS = 2_000;
const LOCK_MAX_ATTEMPTS = Math.ceil(LOCK_ACQUIRE_TIMEOUT_MS / LOCK_BACKOFF_MS);

type LockHandle = Awaited<ReturnType<typeof fs.open>>;

// setTimeout-based backoff is fine here: this is an IO helper, not a logic
// module, and it introduces no wall-clock dependency into any Result.
const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const lockIsStale = async (lockPath: string, now: Date): Promise<boolean> => {
  try {
    const stat = await fs.stat(lockPath);
    return now.getTime() - stat.mtimeMs > STALE_LOCK_MS;
  } catch {
    // Vanished between the EEXIST and the stat: not stale, let the retry decide.
    return false;
  }
};

const withClaimsLock = async <T>(
  boardDir: string,
  now: Date,
  fn: () => Promise<Result<T, IdentityError>>,
): Promise<Result<T, IdentityError>> => {
  const lockPath = `${claimsFilePath(boardDir)}.lock`;
  let handle: LockHandle | undefined;
  for (let attempt = 0; attempt < LOCK_MAX_ATTEMPTS && handle === undefined; attempt += 1) {
    try {
      // 'wx' fails if the lock file already exists, so creation IS acquisition.
      handle = await fs.open(lockPath, 'wx');
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'EEXIST') {
        return err({
          kind: 'io',
          message: `could not acquire claims lock ${lockPath}: ${errorMessage(error)}`,
          cause: error,
        });
      }
      // Held by someone else: break it if it is stale, otherwise back off. The
      // bounded attempt count keeps this under ~LOCK_ACQUIRE_TIMEOUT_MS.
      if (await lockIsStale(lockPath, now)) {
        await fs.rm(lockPath, { force: true }).catch(() => undefined);
        continue;
      }
      await delay(LOCK_BACKOFF_MS);
    }
  }
  if (handle === undefined) {
    return err({
      kind: 'locked',
      message: `claims lock ${lockPath} is held by another operation; try again shortly`,
    });
  }
  try {
    return await fn();
  } finally {
    // Best-effort release: close the handle and remove the lock file.
    await handle.close().catch(() => undefined);
    await fs.rm(lockPath, { force: true }).catch(() => undefined);
  }
};

export type ClaimResult = {
  readonly role: string;
  readonly claim: Claim;
  readonly previous: Claim;
};

export type ClaimRoleParams = {
  readonly config: AgentsConfig;
  readonly boardDir: string;
  readonly role: string;
  readonly token: string;
  readonly agent?: AgentKind;
  readonly now: Date;
  readonly ttlMs: number;
};

export const claimRole = async (params: ClaimRoleParams): Promise<Result<ClaimResult, IdentityError>> => {
  const { config, boardDir, role, token, agent, now, ttlMs } = params;
  const valid = validateRole(config, role);
  if (!valid.ok) {
    return valid;
  }
  // Reject a too-short token BEFORE persisting: writing it would fail the schema
  // on the next readClaims and brick every role in the file, not just this one.
  if (token.length < MIN_CLAIM_TOKEN_LENGTH) {
    return err({
      kind: 'invalid-token',
      role,
      message: `claim token must be at least ${MIN_CLAIM_TOKEN_LENGTH} characters`,
    });
  }
  return withClaimsLock<ClaimResult>(boardDir, now, async () => {
    const claimsResult = await readClaims(boardDir, config);
    if (!claimsResult.ok) {
      return claimsResult;
    }
    const current: Claim = claimsResult.value.claims[role] ?? { status: 'free' };
    // Held by someone else and still live: refuse. Same token is a renew, and an
    // expired claim is free for the taking — both fall through.
    if (current.status === 'claimed' && !isClaimExpired(current, now) && current.token !== token) {
      return err({
        kind: 'occupied',
        role,
        message: `role '${role}' is already claimed by another token until ${current.expiresAt}`,
      });
    }
    const claim: Claim = {
      status: 'claimed',
      token,
      claimedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + ttlMs).toISOString(),
      ...(agent !== undefined ? { agent } : {}),
    };
    const written = await writeClaims(boardDir, {
      version: 1,
      claims: { ...claimsResult.value.claims, [role]: claim },
    });
    if (!written.ok) {
      return written;
    }
    return ok({ role, claim, previous: current });
  });
};

export type ReleaseResult = {
  readonly role: string;
  readonly released: boolean;
  readonly reason?: 'already-free';
};

export type ReleaseRoleParams = {
  readonly config: AgentsConfig;
  readonly boardDir: string;
  readonly role: string;
  readonly token: string;
  readonly force?: boolean;
  // Needed to drive the advisory lock's staleness check.
  readonly now: Date;
};

export const releaseRole = async (
  params: ReleaseRoleParams,
): Promise<Result<ReleaseResult, IdentityError>> => {
  const { config, boardDir, role, token, force, now } = params;
  const valid = validateRole(config, role);
  if (!valid.ok) {
    return valid;
  }
  return withClaimsLock<ReleaseResult>(boardDir, now, async () => {
    const claimsResult = await readClaims(boardDir, config);
    if (!claimsResult.ok) {
      return claimsResult;
    }
    const current: Claim = claimsResult.value.claims[role] ?? { status: 'free' };
    if (current.status === 'free') {
      return ok({ role, released: false, reason: 'already-free' });
    }
    if (current.token !== token && force !== true) {
      return err({
        kind: 'token-mismatch',
        role,
        message: `cannot release role '${role}': token does not match the current holder (use force to override)`,
      });
    }
    const written = await writeClaims(boardDir, {
      version: 1,
      claims: { ...claimsResult.value.claims, [role]: { status: 'free' } },
    });
    if (!written.ok) {
      return written;
    }
    return ok({ role, released: true });
  });
};

// Admin force-free: releases a role's claim WITHOUT a token, under the same
// advisory lock as claim/release. Its reason for existing is archiveSession:
// once a session is archived it drops out of activeSessions, so validateRole,
// whoami and releaseRole can no longer see or free its claim — it would be
// stranded forever. `config` is part of the documented admin signature but the
// role is freed by raw key ON PURPOSE, since validateRole would reject the
// now-archived role we are trying to release. A missing claims.json is a no-op.
export const forceFreeRole = async (
  config: AgentsConfig,
  boardDir: string,
  role: string,
  now: Date,
): Promise<Result<{ readonly released: boolean }, IdentityError>> => {
  void config;
  const filePath = claimsFilePath(boardDir);
  // Nothing to free before the file exists; skip even acquiring the lock (its
  // directory may not exist yet on a not-yet-configured repo).
  try {
    await fs.access(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return ok({ released: false });
    }
    return err({ kind: 'io', message: `could not access ${filePath}: ${errorMessage(error)}`, cause: error });
  }
  return withClaimsLock<{ readonly released: boolean }>(boardDir, now, async () => {
    let raw: string;
    try {
      raw = await fs.readFile(filePath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return ok({ released: false });
      }
      return err({ kind: 'io', message: `could not read ${filePath}: ${errorMessage(error)}`, cause: error });
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      return err({
        kind: 'invalid-json',
        message: `claims.json is not valid JSON: ${errorMessage(error)}`,
        cause: error,
      });
    }
    const claims = parseClaimsFile(parsed);
    if (!claims.ok) {
      return err({ kind: 'invalid-claims', message: claims.error.message, cause: claims.error });
    }
    const current = claims.value.claims[role];
    // Absent or already free: no rewrite, so file watchers do not churn.
    if (current === undefined || current.status === 'free') {
      return ok({ released: false });
    }
    const written = await writeClaims(boardDir, {
      version: 1,
      claims: { ...claims.value.claims, [role]: { status: 'free' } },
    });
    if (!written.ok) {
      return written;
    }
    return ok({ released: true });
  });
};

export type WhoAmI = {
  readonly role: string;
  readonly claim: Claim;
};

export type WhoAmIParams = {
  readonly config: AgentsConfig;
  readonly boardDir: string;
  readonly token: string;
  readonly now: Date;
};

export const whoami = async (params: WhoAmIParams): Promise<Result<WhoAmI | null, IdentityError>> => {
  const { config, boardDir, token, now } = params;
  const claimsResult = await readClaims(boardDir, config);
  if (!claimsResult.ok) {
    return claimsResult;
  }
  const claims = claimsResult.value.claims;
  // Only the live role set — a claim on an archived/stray role is not an identity.
  for (const role of roleSet(config)) {
    const claim = claims[role];
    if (
      claim !== undefined &&
      claim.status === 'claimed' &&
      claim.token === token &&
      !isClaimExpired(claim, now)
    ) {
      return ok({ role, claim });
    }
  }
  return ok(null);
};

export type RoleStatus = {
  readonly role: string;
  readonly status: 'free' | 'claimed';
  readonly expired: boolean;
  readonly claim?: Claim;
};

export type ListRolesParams = {
  readonly config: AgentsConfig;
  readonly boardDir: string;
  readonly now: Date;
};

export const listRoles = async (
  params: ListRolesParams,
): Promise<Result<RoleStatus[], IdentityError>> => {
  const { config, boardDir, now } = params;
  const claimsResult = await readClaims(boardDir, config);
  if (!claimsResult.ok) {
    return claimsResult;
  }
  const claims = claimsResult.value.claims;
  const statuses = roleSet(config).map((role): RoleStatus => {
    const claim: Claim = claims[role] ?? { status: 'free' };
    if (claim.status === 'free') {
      return { role, status: 'free', expired: false };
    }
    // A claimed-but-expired claim is effectively free, but the stale claim data
    // is still surfaced so the caller can show who held it and until when.
    const expired = isClaimExpired(claim, now);
    return { role, status: expired ? 'free' : 'claimed', expired, claim };
  });
  return ok(statuses);
};
