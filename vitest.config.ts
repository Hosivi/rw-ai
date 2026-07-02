import { defineConfig } from 'vitest/config';

// Scope to source specs only: without this vitest also collects compiled
// dist/**/*.test.js and double-counts the whole suite against stale output.
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
  },
});
