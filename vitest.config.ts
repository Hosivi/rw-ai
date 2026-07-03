import { defineConfig } from 'vitest/config';

// Scope to source specs only: without this vitest also collects compiled
// dist/**/*.test.js and double-counts the whole suite against stale output.
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    // A stray `.only` left in a spec silently hides the rest of the suite; fail
    // CI so it can never merge, while keeping local runs frictionless.
    forbidOnly: !!process.env.CI,
  },
});
