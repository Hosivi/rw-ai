import { describe, expect, it } from 'vitest';
import { andThen, err, isErr, isOk, map, mapErr, ok, unwrapOr, type Result } from './result.js';

describe('constructors', () => {
  it('ok wraps a value', () => {
    expect(ok(42)).toEqual({ ok: true, value: 42 });
  });

  it('err wraps an error', () => {
    expect(err('boom')).toEqual({ ok: false, error: 'boom' });
  });
});

describe('guards', () => {
  it('isOk narrows ok results', () => {
    const result: Result<number, string> = ok(1);
    expect(isOk(result)).toBe(true);
    expect(isErr(result)).toBe(false);
  });

  it('isErr narrows err results', () => {
    const result: Result<number, string> = err('nope');
    expect(isOk(result)).toBe(false);
    expect(isErr(result)).toBe(true);
  });
});

describe('map', () => {
  it('transforms the value of an ok', () => {
    expect(map(ok(2), (n) => n * 10)).toEqual(ok(20));
  });

  it('passes err through untouched', () => {
    const failure: Result<number, string> = err('boom');
    expect(map(failure, (n: number) => n * 10)).toEqual(err('boom'));
  });
});

describe('mapErr', () => {
  it('transforms the error of an err', () => {
    const failure: Result<number, string> = err('boom');
    expect(mapErr(failure, (e) => e.toUpperCase())).toEqual(err('BOOM'));
  });

  it('passes ok through untouched', () => {
    const success: Result<number, string> = ok(1);
    expect(mapErr(success, (e: string) => e.toUpperCase())).toEqual(ok(1));
  });
});

describe('andThen', () => {
  const parsePositive = (n: number): Result<number, string> =>
    n > 0 ? ok(n) : err('not positive');

  it('chains ok results', () => {
    const result = andThen(
      andThen(ok(4), parsePositive),
      (n) => ok(n * 2),
    );
    expect(result).toEqual(ok(8));
  });

  it('short-circuits on the first err', () => {
    let called = false;
    const result = andThen(andThen(ok(-1), parsePositive), (n) => {
      called = true;
      return ok(n * 2);
    });
    expect(result).toEqual(err('not positive'));
    expect(called).toBe(false);
  });
});

describe('unwrapOr', () => {
  it('returns the value of an ok', () => {
    expect(unwrapOr(ok(5), 0)).toBe(5);
  });

  it('returns the fallback for an err', () => {
    const failure: Result<number, string> = err('boom');
    expect(unwrapOr(failure, 0)).toBe(0);
  });
});
