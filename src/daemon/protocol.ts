import { z } from 'zod';
import { err, ok, type Result } from '../core/result.js';
import type { PublicSessionState } from '../state/public.js';

// Client → daemon. Read/notify only — there is deliberately NO mutation verb here
// (claims stay single-owned by engine/identity via the MCP surface). Validated at
// the socket boundary; anything else is dropped.
export const clientRequestSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('subscribe') }),
  z.object({ type: z.literal('get') }),
]);
export type ClientRequest = z.infer<typeof clientRequestSchema>;

export const parseClientRequest = (input: unknown): Result<ClientRequest, string> => {
  const parsed = clientRequestSchema.safeParse(input);
  return parsed.success ? ok(parsed.data) : err(parsed.error.issues[0]?.message ?? 'invalid request');
};

// Daemon → client. `snapshot` answers a subscribe/get with the current state;
// `update` is pushed to subscribers when the state actually changes. `rev` is a
// monotonic revision so a client can order/ignore stale messages. States are
// always the wire-safe projection (no claim token).
export type ServerMessage =
  | { readonly type: 'snapshot'; readonly rev: number; readonly states: readonly PublicSessionState[] }
  | { readonly type: 'update'; readonly rev: number; readonly states: readonly PublicSessionState[] };
