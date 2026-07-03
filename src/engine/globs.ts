// A tiny, dependency-free glob matcher over forward-slash paths (git always
// emits forward slashes, even on Windows). It supports exactly the subset the
// area/shared-zone patterns need:
//
//   **  matches zero or more WHOLE path segments, only when it stands alone as a
//       segment. So `src/**` matches `src/a` and `src/a/b/c`, and `**/*.ts`
//       matches `a.ts` and `src/x/a.ts`.
//   *   matches any run of characters WITHIN a single segment; it never crosses
//       a `/`.
//   ?   matches exactly one non-`/` character.
//   any other character is a literal and is regex-escaped.
//
// Dotfiles are NOT special: a leading `.` is an ordinary character, so `.env`
// matches `**/*` and `*`.
//
// Before matching, every glob is run through `normalizeGlob`, which repairs the
// common authoring footguns so they mean what the author intended rather than
// silently matching nothing: a leading `./` is stripped, repeated slashes are
// collapsed, a leading `/` is dropped, and a TRAILING `/` becomes `/**` (the
// directory and everything under it).
//
// NOT supported (out of scope for area patterns): brace expansion `{a,b}`,
// extglobs `@(a|b)`, character classes `[abc]`, and a `**` that is only PART of
// a segment (e.g. `a**b`) — there each `*` degrades to the single-segment rule.

// Escape a single literal character so it matches itself in a RegExp. `*` and
// `?` are handled by the caller before this runs, so they never reach here as
// literals.
const escapeRegexChar = (ch: string): string =>
  /[.*+?^${}()|[\]\\]/.test(ch) ? `\\${ch}` : ch;

// Translate one path segment (guaranteed slash-free) into a regex fragment that
// matches exactly that segment. `*` stays within the segment ([^/]*), `?` is a
// single non-slash character, everything else is literal.
const translateSegment = (segment: string): string => {
  let out = '';
  for (const ch of segment) {
    if (ch === '*') {
      out += '[^/]*';
    } else if (ch === '?') {
      out += '[^/]';
    } else {
      out += escapeRegexChar(ch);
    }
  }
  return out;
};

// Build an anchored RegExp from a glob. The `**` segments own their adjacent
// slashes so that a globstar matching ZERO segments leaves no stray separator:
//   - `**` alone            -> `.*`            (matches any path)
//   - leading  `**/...`     -> `(?:.*/)?`      (zero-or-more leading segments)
//   - middle   `.../**/...` -> `(?:/.*)?` + a `/` before the next segment
//   - trailing `.../**`     -> `(?:/.*)?`      (zero-or-more trailing segments)
// `pendingSlash` tracks whether a literal `/` is owed before the next NORMAL
// segment; a globstar that starts with `/` absorbs that owed slash itself.
export const globToRegExp = (glob: string): RegExp => {
  const segments = glob.split('/');
  let body = '';
  let pendingSlash = false;
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index] ?? '';
    const isFirst = index === 0;
    const isLast = index === segments.length - 1;
    if (segment === '**') {
      if (isFirst && isLast) {
        body += '.*';
        pendingSlash = false;
      } else if (isFirst) {
        // Leading globstar provides the trailing slash for the next segment,
        // so the next segment attaches directly (no pending slash).
        body += '(?:.*/)?';
        pendingSlash = false;
      } else {
        // Middle or trailing globstar starts with `/`, absorbing the owed slash
        // from the preceding segment. A middle globstar still owes a slash to
        // the segment that follows it.
        body += '(?:/.*)?';
        pendingSlash = !isLast;
      }
    } else {
      if (pendingSlash) {
        body += '/';
      }
      body += translateSegment(segment);
      pendingSlash = true;
    }
  }
  return new RegExp(`^${body}$`);
};

// Repairs common authoring footguns so a slightly-off pattern still matches what
// the author meant instead of silently matching nothing. Order matters: collapse
// slashes BEFORE stripping the leading one (so `//a` -> `/a` -> `a`), and convert
// the trailing slash LAST. Already-valid patterns (`**/*`, `src/**`, `a.ts`) pass
// through untouched.
export const normalizeGlob = (glob: string): string =>
  glob
    .replace(/^\.\//, '') // drop a leading "./"
    .replace(/\/{2,}/g, '/') // collapse repeated slashes
    .replace(/^\//, '') // drop a leading "/"
    .replace(/\/$/, '/**'); // a trailing "/" means the dir and everything under it

// Pure: no caching so callers stay free of hidden state. Compiling the RegExp
// per call is cheap for the handful of area/shared-zone patterns we evaluate.
// All matching funnels through normalizeGlob so every entry point is footgun-safe.
export const matchesGlob = (filePath: string, glob: string): boolean =>
  globToRegExp(normalizeGlob(glob)).test(filePath);

export const matchesAnyGlob = (filePath: string, globs: readonly string[]): boolean =>
  globs.some((glob) => matchesGlob(filePath, glob));
