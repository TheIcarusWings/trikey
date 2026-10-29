import { defineConfig } from 'vitest/config';

// Pure TypeScript logic only: no React Native rendering, no device I/O.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
