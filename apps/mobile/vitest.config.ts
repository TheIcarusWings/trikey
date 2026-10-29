import { defineConfig } from 'vitest/config';

// Unit tests cover the pure parts of the app (the platform layer's codecs, error mapping and
// providers). Anything that needs a native module takes it as an argument and is tested with a
// fake. React components are not tested here.
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
});
