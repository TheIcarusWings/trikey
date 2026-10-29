/**
 * Side-effect module, imported first by `main.ts`: pins the random source every key and secret of the
 * guardian comes from (`secureRandomBytes`, packages/core/src/random.ts) to Node's own
 * `webcrypto.getRandomValues`, which reads the kernel CSPRNG (`getrandom(2)` on Linux). From then on a
 * `globalThis.crypto.getRandomValues` replaced by anything else (a library's polyfill, a test double left
 * behind) makes key generation fail instead of quietly using it.
 */
import { webcrypto } from 'node:crypto';
import { pinRandomSource, type GetRandomValues } from '@trikey/core/random';

export function pinNodeRandomSource(): void {
  if (globalThis.crypto !== (webcrypto as unknown as Crypto))
    throw new Error('globalThis.crypto is not node:crypto webcrypto; refusing to start');
  pinRandomSource(webcrypto.getRandomValues as GetRandomValues, { name: 'node:crypto webcrypto.getRandomValues (getrandom)', target: webcrypto });
}

pinNodeRandomSource();
