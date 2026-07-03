import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { unwrap, unwrapErr } from '../core/result.test-support.js';
import { removeDirRobust } from './git.test-support.js';
import {
  countTokensOnline,
  defaultPricingPath,
  estimateTokens,
  inputCostUsd,
  loadPricing,
  parsePricing,
  type Pricing,
} from './tokens.js';

describe('estimateTokens (offline heuristic)', () => {
  it('is 0 for empty text', () => {
    expect(estimateTokens('')).toBe(0);
  });

  it('is deterministic: identical input yields identical output', () => {
    const text = 'the quick brown fox jumps over the lazy dog';
    expect(estimateTokens(text)).toBe(estimateTokens(text));
  });

  it('is proportional: longer text estimates more tokens', () => {
    const short = 'abcd';
    const long = 'abcd'.repeat(50);
    expect(estimateTokens(long)).toBeGreaterThan(estimateTokens(short));
  });

  it('uses roughly 4 characters per token', () => {
    // 4 chars -> 1 token, 9 chars -> ceil(9/4) = 3 tokens.
    expect(estimateTokens('abcd')).toBe(1);
    expect(estimateTokens('a'.repeat(9))).toBe(3);
  });
});

describe('parsePricing', () => {
  it('accepts a valid map and ignores the _comment key', () => {
    const pricing = unwrap(
      parsePricing({
        _comment: 'valores indicativos: verifica con el pricing vigente de Anthropic',
        'claude-sonnet-5': { inputPerMTok: 3, outputPerMTok: 15 },
      }),
    );
    expect(pricing['claude-sonnet-5']).toEqual({ inputPerMTok: 3, outputPerMTok: 15 });
    // The comment must never leak into the parsed pricing map.
    expect(Object.keys(pricing)).not.toContain('_comment');
  });

  it('rejects a negative price', () => {
    const error = unwrapErr(parsePricing({ 'm': { inputPerMTok: -1, outputPerMTok: 5 } }));
    expect(error.kind).toBe('invalid-pricing');
  });

  it('rejects a non-number price', () => {
    const error = unwrapErr(parsePricing({ 'm': { inputPerMTok: 'gratis', outputPerMTok: 5 } }));
    expect(error.kind).toBe('invalid-pricing');
  });

  it('rejects a non-object input', () => {
    expect(unwrapErr(parsePricing(42)).kind).toBe('invalid-pricing');
  });
});

describe('inputCostUsd', () => {
  const pricing: Pricing = {
    'claude-sonnet-5': { inputPerMTok: 3, outputPerMTok: 15 },
  };

  it('computes tokens / 1e6 * inputPerMTok', () => {
    expect(inputCostUsd(1_000_000, 'claude-sonnet-5', pricing)).toBe(3);
    expect(inputCostUsd(500_000, 'claude-sonnet-5', pricing)).toBe(1.5);
  });

  it('returns undefined when the model has no price', () => {
    expect(inputCostUsd(1_000_000, 'claude-unknown', pricing)).toBeUndefined();
  });
});

describe('defaultPricingPath (bundled default, resolved via import.meta.url)', () => {
  it('resolves to a pricing.json that ships with the package', () => {
    const resolved = defaultPricingPath();
    expect(resolved.endsWith('pricing.json')).toBe(true);
    // The bundled file must exist so a fresh install has a template to copy.
    expect(existsSync(resolved)).toBe(true);
  });
});

describe('loadPricing', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rw-ai-pricing-'));
  });

  afterEach(() => removeDirRobust(dir));

  it('reads and parses a pricing.json from disk', async () => {
    const pricingPath = path.join(dir, 'pricing.json');
    await fs.writeFile(
      pricingPath,
      JSON.stringify({ _comment: 'indicativo', 'claude-sonnet-5': { inputPerMTok: 3, outputPerMTok: 15 } }),
    );
    const pricing = unwrap(await loadPricing(pricingPath));
    expect(pricing['claude-sonnet-5']?.inputPerMTok).toBe(3);
  });

  it('reports a missing file as an io error that names the path', async () => {
    const pricingPath = path.join(dir, 'pricing.json');
    const error = unwrapErr(await loadPricing(pricingPath));
    expect(error.kind).toBe('io');
    expect(error.message).toContain(pricingPath);
  });
});

describe('countTokensOnline (injected fetch, never real network)', () => {
  // A fake fetch is mandatory: the suite must never reach the Anthropic API.
  const cannedFetch = (body: unknown, status = 200): typeof fetch =>
    (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

  it('reads input_tokens from a 2xx response', async () => {
    const tokens = unwrap(
      await countTokensOnline({
        text: 'hola mundo',
        model: 'claude-sonnet-5',
        apiKey: 'secret-key',
        fetchImpl: cannedFetch({ input_tokens: 42 }),
      }),
    );
    expect(tokens).toBe(42);
  });

  it('maps a 401 to an api error', async () => {
    const error = unwrapErr(
      await countTokensOnline({
        text: 'hola',
        model: 'claude-sonnet-5',
        apiKey: 'bad-key',
        fetchImpl: cannedFetch({ error: 'unauthorized' }, 401),
      }),
    );
    expect(error.kind).toBe('api');
    expect(error.message).toContain('401');
  });

  it('never leaks the api key in the error message', async () => {
    const error = unwrapErr(
      await countTokensOnline({
        text: 'hola',
        model: 'claude-sonnet-5',
        apiKey: 'super-secret-token',
        fetchImpl: cannedFetch({ error: 'unauthorized' }, 401),
      }),
    );
    expect(error.message).not.toContain('super-secret-token');
  });
});
