import { defineConfig } from 'vitest/config';

// Unit tests of the API client and helpers only (no DOM, no React): kept apart from vite.config.ts so
// the UI's build plugins are not loaded for them.
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
  },
});
