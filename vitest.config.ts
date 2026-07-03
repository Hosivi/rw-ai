import { defineConfig } from 'vitest/config';

// Scope to source specs only: without this vitest also collects compiled
// dist/**/*.test.js and double-counts the whole suite against stale output.
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    // A stray `.only` left in a spec silently hides the rest of the suite; fail
    // CI so it can never merge, while keeping local runs frictionless.
    forbidOnly: !!process.env.CI,
    // Many specs are REAL git integration tests: each spawns a dozen-plus git
    // subprocesses (worktree add, merge, branch ops) that are expensive on
    // Windows. With every test file running in parallel, CPU/disk saturation can
    // push a single deterministic test past the 5s default, so a few (lifecycle,
    // git, integrator) would flake purely on wall-clock. Raise the ceiling — this
    // is adequate time for legitimately slow, deterministic subprocess tests, not
    // a retry or a mask for nondeterminism. Hooks (createTempRepo) are git-heavy
    // too, so lift their budget as well.
    testTimeout: 30000,
    hookTimeout: 30000,
  },
});
