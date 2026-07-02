import type { Result } from './result.js';

// Test-only helpers: throwing on the wrong variant is intentional — a failed
// unwrap must fail the test that called it.
export const unwrap = <T, E>(result: Result<T, E>): T => {
  if (!result.ok) {
    throw new Error(`expected ok, got err: ${JSON.stringify(result.error)}`);
  }
  return result.value;
};

export const unwrapErr = <T, E>(result: Result<T, E>): E => {
  if (result.ok) {
    throw new Error(`expected err, got ok: ${JSON.stringify(result.value)}`);
  }
  return result.error;
};
