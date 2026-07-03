import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { err, ok, type Result } from '../core/result.js';

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

// Kinds map onto how the CLI reacts: 'invalid-pricing' points at a file the user
// must fix by hand (issues carries the violations), 'io' is a filesystem failure
// (usually a missing pricing.json), 'api' is a failure of the optional online
// count_tokens call. cause preserves the original error for logs, never the key.
export type TokensError = {
  readonly kind: 'invalid-pricing' | 'io' | 'api';
  readonly message: string;
  readonly issues?: string[];
  readonly cause?: unknown;
};

export type ModelPrice = {
  readonly inputPerMTok: number;
  readonly outputPerMTok: number;
};

export type Pricing = Record<string, ModelPrice>;

// OFFLINE token ESTIMATE, not an exact count. Anthropic's tokenizer is not public,
// so we approximate at ~4 characters per token — the widely used rule of thumb for
// English/code. It is deliberately pure and deterministic (no I/O, no clock) so the
// same text always yields the same number and callers can cache/compare freely.
// For an exact count use countTokensOnline against the API.
export const estimateTokens = (text: string): number => Math.ceil(text.length / 4);

// The pricing.json that ships inside the package. Resolved from import.meta.url the
// same way version.ts resolves package.json, so it points at the repo root under
// src/ (vitest) AND the package root under dist/ (published bin) — two levels up in
// both layouts. It is the reference template a fresh install can copy or edit.
const PRICING_JSON_URL = new URL('../../pricing.json', import.meta.url);
export const defaultPricingPath = (): string => fileURLToPath(PRICING_JSON_URL);

// A price is two non-negative numbers. Negative or non-number values are rejected
// so a typo in pricing.json fails loudly instead of computing a nonsense cost.
const modelPriceSchema = z.object({
  inputPerMTok: z.number().min(0),
  outputPerMTok: z.number().min(0),
});

// The map of model id -> price. z.record gives Record<string, ModelPrice>, which
// with noUncheckedIndexedAccess is already the "model may be missing" shape callers
// need. _comment is stripped before validation (see parsePricing).
const pricingSchema = z.record(z.string(), modelPriceSchema);

const zodIssues = (error: z.ZodError): string[] =>
  error.issues.map((issue) => {
    const at = issue.path.length > 0 ? issue.path.map(String).join('.') : '(root)';
    return `${at}: ${issue.message}`;
  });

// Validates an already-parsed value into a Pricing map. The top-level _comment key
// (documentation for the human editor) is dropped BEFORE validation so it never has
// to satisfy the price schema and never leaks into the returned map.
export const parsePricing = (input: unknown): Result<Pricing, TokensError> => {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    return err({
      kind: 'invalid-pricing',
      message: 'pricing.json debe ser un objeto de modelo -> { inputPerMTok, outputPerMTok }.',
    });
  }
  const { _comment: _ignored, ...models } = input as Record<string, unknown>;
  const parsed = pricingSchema.safeParse(models);
  if (!parsed.success) {
    return err({
      kind: 'invalid-pricing',
      message: 'pricing.json tiene precios inválidos (revisa que sean números >= 0).',
      issues: zodIssues(parsed.error),
    });
  }
  return ok(parsed.data);
};

// Reads pricing.json from disk and parses it. A missing file is a real 'io' error
// that names WHERE pricing.json is expected, so the CLI can tell the user exactly
// which path to create or edit.
export const loadPricing = async (pricingPath: string): Promise<Result<Pricing, TokensError>> => {
  let raw: string;
  try {
    raw = await readFile(pricingPath, 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    const message =
      code === 'ENOENT'
        ? `No se encontró pricing.json en ${pricingPath}. Crea o edita ese archivo con los precios por modelo.`
        : `No se pudo leer pricing.json en ${pricingPath}: ${errorMessage(error)}`;
    return err({ kind: 'io', message, cause: error });
  }
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(raw);
  } catch (error) {
    return err({
      kind: 'invalid-pricing',
      message: `pricing.json no es JSON válido: ${errorMessage(error)}`,
      cause: error,
    });
  }
  return parsePricing(parsedJson);
};

// Estimated INPUT cost in USD for a token count under a model's price. Returns
// undefined (not 0, not a throw) when the model is absent from pricing.json so the
// CLI can report "sin precio" instead of crashing or inventing a number.
export const inputCostUsd = (
  tokens: number,
  model: string,
  pricing: Pricing,
): number | undefined => {
  const price = pricing[model];
  if (price === undefined) {
    return undefined;
  }
  return (tokens / 1_000_000) * price.inputPerMTok;
};

const countResponseSchema = z.object({ input_tokens: z.number() });

// OPTIONAL exact online count via Anthropic's count_tokens endpoint. fetchImpl is
// injectable (default globalThis.fetch) so tests never touch the network. The
// apiKey is used only as a request header and NEVER logged, stored, or placed in an
// error message — non-2xx and network failures collapse to an 'api' TokensError
// that carries the status, not the key.
export const countTokensOnline = async (params: {
  readonly text: string;
  readonly model: string;
  readonly apiKey: string;
  readonly fetchImpl?: typeof fetch;
}): Promise<Result<number, TokensError>> => {
  const fetchImpl = params.fetchImpl ?? globalThis.fetch;
  let response: Response;
  try {
    response = await fetchImpl('https://api.anthropic.com/v1/messages/count_tokens', {
      method: 'POST',
      headers: {
        'x-api-key': params.apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: params.model,
        messages: [{ role: 'user', content: params.text }],
      }),
    });
  } catch (error) {
    // The apiKey must never surface here: only the transport failure reason does.
    return err({
      kind: 'api',
      message: `No se pudo contactar la API de conteo de tokens: ${errorMessage(error)}`,
      cause: error,
    });
  }
  if (!response.ok) {
    return err({
      kind: 'api',
      message: `La API de conteo de tokens respondió con estado ${response.status}.`,
      cause: response.status,
    });
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch (error) {
    return err({
      kind: 'api',
      message: 'La respuesta de la API de conteo de tokens no es JSON válido.',
      cause: error,
    });
  }
  const parsed = countResponseSchema.safeParse(body);
  if (!parsed.success) {
    return err({
      kind: 'api',
      message: 'La respuesta de la API de conteo de tokens no incluye input_tokens.',
      issues: zodIssues(parsed.error),
    });
  }
  return ok(parsed.data.input_tokens);
};
