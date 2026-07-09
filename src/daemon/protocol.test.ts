import { describe, expect, it } from 'vitest';
import { unwrap, unwrapErr } from '../core/result.test-support.js';
import { parseClientRequest } from './protocol.js';

describe('parseClientRequest', () => {
  it('accepts subscribe and get', () => {
    expect(unwrap(parseClientRequest({ type: 'subscribe' })).type).toBe('subscribe');
    expect(unwrap(parseClientRequest({ type: 'get' })).type).toBe('get');
  });

  it('rejects an unknown request type', () => {
    unwrapErr(parseClientRequest({ type: 'mutate' }));
  });

  it('rejects a non-object payload', () => {
    unwrapErr(parseClientRequest('subscribe'));
    unwrapErr(parseClientRequest(null));
  });
});
