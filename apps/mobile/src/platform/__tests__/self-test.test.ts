import { beforeAll, describe, expect, it } from 'vitest';
import { pinRandomSource, type GetRandomValues } from '@trikey/core/random';
import { runCryptoSelfTest, summarize } from '../self-test';

// The app pins its source in polyfills.ts; here Node's own stands in for expo-crypto.
beforeAll(() => {
  pinRandomSource(globalThis.crypto.getRandomValues as unknown as GetRandomValues, { name: 'node:crypto webcrypto', target: globalThis.crypto });
});

// Runs the same self-test the Developer section runs on a phone, here on Node. It checks that
// the @trikey/core and @trikey/protocol imports resolve from the app and that the pinned test
// vectors in the self-test are right. On a device it proves the polyfills and Hermes.
describe('crypto self-test', () => {
  it('passes', async () => {
    const report = await runCryptoSelfTest();
    expect(report.steps.filter((s) => !s.ok)).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.steps.map((s) => s.name)).toEqual([
      'Runtime globals',
      'Random bytes',
      'Text encoding',
      'Key derivation (BIP39, BIP32, NIP-06)',
      'Multisig wallet (BIP48, descriptor, address)',
      'NIP-44 encrypt and decrypt',
      'Gift wrap (NIP-59) through the protocol',
    ]);
    expect(summarize(report)).toMatch(/^Passed: 7 checks, \d+ ms$/);
  }, 30_000);

  it('summarize names the first failing step', () => {
    expect(
      summarize({
        ok: false,
        totalMs: 5,
        steps: [
          { name: 'A', ok: true, ms: 1 },
          { name: 'B', ok: false, ms: 1, error: 'x' },
        ],
      }),
    ).toBe('Failed: B');
  });
});
