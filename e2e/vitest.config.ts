import { defineConfig } from 'vitest/config';

// One bitcoind and one Electrs serve every test file, and the tests mine blocks and move the node's clock, so the
// files must run one after the other.
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    fileParallelism: false,
    testTimeout: 120_000,
    hookTimeout: 180_000,
    globalSetup: ['./test/global-setup.ts'],
  },
});
