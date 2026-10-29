import { defineConfig } from 'vitest/config';

// Unit tests cover the pure parts of the app (the platform layer's codecs, error mapping and
// providers). Anything that needs a native module takes it as an argument and is tested with a
// fake. React components are not tested here.
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
    // The Recovery Key tests sign and verify real refill chains against a simulated chain, and the guardian tests run
    // a whole guardian: run few files at once, or the ones that wait on timers starve each other on a small machine.
    maxWorkers: 3,
    testTimeout: 60_000,
  },
});
