import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // The end-to-end tests sign many PSBTs with software keys (PBKDF2 per seed) and talk HTTP.
    testTimeout: 60_000,
    hookTimeout: 30_000,
  },
});
