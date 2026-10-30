// Test-only preload (`node --import <this file> --import tsx src/main.ts`): replaces the OS generator on
// node:crypto's webcrypto with one that cycles through two blocks. It passes the per-call checks of
// `secureRandomBytes` (each draw differs from the one before) and only the start-up health test sees it.
import { webcrypto } from 'node:crypto';

const a = Uint8Array.from({ length: 32 }, (_, i) => (i * 37 + 11) & 255);
const b = Uint8Array.from({ length: 32 }, (_, i) => (i * 91 + 5) & 255);
let n = 0;
webcrypto.getRandomValues = function getRandomValues(array) {
  const bytes = new Uint8Array(array.buffer, array.byteOffset, array.byteLength);
  for (let o = 0; o < bytes.length; o += 32) bytes.set((n++ % 2 ? b : a).subarray(0, Math.min(32, bytes.length - o)), o);
  return array;
};
