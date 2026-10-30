import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // Each file boots its own in-memory PGlite (a few seconds of WASM start-up).
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
