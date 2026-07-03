import { describe, expect, it } from 'vitest';
import { globToRegExp, matchesAnyGlob, matchesGlob, normalizeGlob } from './globs.js';

describe('globToRegExp', () => {
  it('anchors the produced pattern', () => {
    const re = globToRegExp('src');
    expect(re.source.startsWith('^')).toBe(true);
    expect(re.source.endsWith('$')).toBe(true);
    expect(re.test('src')).toBe(true);
    expect(re.test('src/a')).toBe(false);
  });
});

describe('matchesGlob — ** (globstar)', () => {
  it('spans multiple segments', () => {
    expect(matchesGlob('src/a/b/c', 'src/**')).toBe(true);
    expect(matchesGlob('src/a', 'src/**')).toBe(true);
  });

  it('matches zero segments in the middle', () => {
    expect(matchesGlob('a/b', 'a/**/b')).toBe(true);
    expect(matchesGlob('a/x/b', 'a/**/b')).toBe(true);
    expect(matchesGlob('a/x/y/b', 'a/**/b')).toBe(true);
  });

  it('does not bleed into sibling segments', () => {
    // `src/**` must not swallow `src2/...`: the boundary is a real slash.
    expect(matchesGlob('src2/a', 'src/**')).toBe(false);
  });

  it('`**` alone matches everything, including nested paths', () => {
    expect(matchesGlob('a.ts', '**')).toBe(true);
    expect(matchesGlob('src/x/a.ts', '**')).toBe(true);
  });
});

describe('matchesGlob — leading **/', () => {
  it('`**/*` matches a root-level file and a nested file', () => {
    expect(matchesGlob('a.ts', '**/*')).toBe(true);
    expect(matchesGlob('src/x/a.ts', '**/*')).toBe(true);
  });

  it('`**/*.ts` matches a root-level and a nested .ts file', () => {
    expect(matchesGlob('a.ts', '**/*.ts')).toBe(true);
    expect(matchesGlob('src/x/a.ts', '**/*.ts')).toBe(true);
    expect(matchesGlob('a.tsx', '**/*.ts')).toBe(false);
  });
});

describe('matchesGlob — * (single segment)', () => {
  it('matches a run of characters within one segment', () => {
    expect(matchesGlob('foo.ts', '*.ts')).toBe(true);
    expect(matchesGlob('foo.tsx', '*.ts')).toBe(false);
  });

  it('never crosses a slash', () => {
    expect(matchesGlob('src/foo.ts', '*.ts')).toBe(false);
    expect(matchesGlob('src/foo.ts', 'src/*.ts')).toBe(true);
    expect(matchesGlob('src/a/foo.ts', 'src/*.ts')).toBe(false);
  });
});

describe('matchesGlob — ? (single char)', () => {
  it('matches exactly one non-slash character', () => {
    expect(matchesGlob('abc', 'a?c')).toBe(true);
    expect(matchesGlob('ac', 'a?c')).toBe(false);
    expect(matchesGlob('a/c', 'a?c')).toBe(false);
  });
});

describe('matchesGlob — literal special characters', () => {
  it('treats `.` as a literal, not "any char"', () => {
    expect(matchesGlob('a.b', 'a.b')).toBe(true);
    expect(matchesGlob('axb', 'a.b')).toBe(false);
  });

  it('escapes `+` and parentheses', () => {
    expect(matchesGlob('a+b', 'a+b')).toBe(true);
    expect(matchesGlob('ab', 'a+b')).toBe(false);
    expect(matchesGlob('(x)', '(x)')).toBe(true);
    expect(matchesGlob('x', '(x)')).toBe(false);
  });
});

describe('normalizeGlob', () => {
  it('leaves already-valid patterns unchanged', () => {
    expect(normalizeGlob('**/*')).toBe('**/*');
    expect(normalizeGlob('src/**')).toBe('src/**');
    expect(normalizeGlob('a.ts')).toBe('a.ts');
  });

  it('turns a trailing slash into /** (dir and everything under it)', () => {
    expect(normalizeGlob('src/s1/')).toBe('src/s1/**');
  });

  it('strips a leading ./ and a leading /', () => {
    expect(normalizeGlob('./src')).toBe('src');
    expect(normalizeGlob('/a/b')).toBe('a/b');
  });

  it('collapses repeated slashes', () => {
    expect(normalizeGlob('a//b')).toBe('a/b');
  });
});

describe('matchesGlob — normalization footguns', () => {
  it('a trailing-slash area still matches files under it', () => {
    expect(matchesGlob('src/s1/a.ts', 'src/s1/')).toBe(true);
  });

  it('a leading slash is ignored', () => {
    expect(matchesGlob('a/b', '/a/b')).toBe(true);
  });

  it('double slashes collapse', () => {
    expect(matchesGlob('a/b', 'a//b')).toBe(true);
  });

  it('leaves **/* matching a root-level file', () => {
    expect(matchesGlob('a.ts', '**/*')).toBe(true);
  });
});

describe('matchesGlob — documented edge behaviors', () => {
  it('`**` mid-segment degrades to the single-segment `*` rule', () => {
    expect(matchesGlob('axxb', 'a**b')).toBe(true);
    expect(matchesGlob('a/b', 'a**b')).toBe(false);
  });

  it('consecutive globstars still match spanning and zero segments', () => {
    expect(matchesGlob('a/b/c/d', 'a/**/**/d')).toBe(true);
    expect(matchesGlob('a/d', 'a/**/**/d')).toBe(true);
  });

  it('does not blow up on a long non-matching input', () => {
    const long = `a/${'x'.repeat(5000)}`;
    expect(matchesGlob(long, 'a/**/**/d')).toBe(false);
  });
});

describe('matchesGlob — dotfiles', () => {
  it('matches a leading dot (no special-casing)', () => {
    expect(matchesGlob('.env', '**/*')).toBe(true);
    expect(matchesGlob('.env', '*')).toBe(true);
    expect(matchesGlob('config/.env', '**/*')).toBe(true);
    expect(matchesGlob('.env', '.env')).toBe(true);
  });
});

describe('matchesAnyGlob', () => {
  it('is true when any glob in the list matches', () => {
    expect(matchesAnyGlob('src/a.ts', ['docs/**', 'src/**'])).toBe(true);
  });

  it('is false when none match, and for an empty list', () => {
    expect(matchesAnyGlob('src/a.ts', ['docs/**', 'test/**'])).toBe(false);
    expect(matchesAnyGlob('src/a.ts', [])).toBe(false);
  });
});
