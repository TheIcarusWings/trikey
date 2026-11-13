import { defineConfig } from 'vitest/config';

// Pure TypeScript logic only: no React Native rendering, no device I/O.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // The Recovery Key tests sign and verify real refill chains against a simulated chain, and the guardian tests run
    // a whole guardian: run few files at once, or the ones that wait on timers starve each other on a small machine.
    maxWorkers: 3,
    testTimeout: 60_000,
    // The person's tap on "Continue in Trezor Suite", for the tests that drive a simulated Trezor.
    setupFiles: ['./src/test-support/auto-handoff.ts'],
  },
});
