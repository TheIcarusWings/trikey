/**
 * The phone refuses to make keys when its random source or its crypto fails the start-up test, and says so in
 * a `WalletServiceError` the screens already show (packages/core/src/random-health.ts, platform/rng-startup.ts).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { RandomSourceError, pinRandomSource, randomSourceInfo, secureRandomBytes, type GetRandomValues } from '@trikey/core/random';
import { installRandomSource } from '@trikey/core/testing/random';
import { WalletError, newMnemonic } from '@trikey/wallet';
import { MemoryKeyValueStore, MemoryPasskeyPrf, MemorySecureKeyStore } from '@trikey/wallet/testing';
import { RNG_REFUSED_TEXT, WalletServiceError } from './errors';
import { mapError } from './real-errors';
import { mapRkError } from './rk-errors';
import { createRealWalletService } from './real';
import { runStartupRandomCheck } from '../platform/rng-startup';

const real = globalThis.crypto.getRandomValues as unknown as GetRandomValues;

/** Two blocks, repeated: every draw differs from the last, so only the start-up health test notices. */
function cycling(): (buf: Uint8Array) => void {
  const blocks = [1, 2].map((m) => Uint8Array.from({ length: 32 }, (_, i) => (i * 59 + m * 31) & 255));
  let n = 0;
  return (buf) => {
    for (let o = 0; o < buf.length; o += 32) buf.set(blocks[n++ % 2]!.subarray(0, Math.min(32, buf.length - o)), o);
  };
}

afterEach(() => {
  delete (globalThis.crypto as unknown as Record<string, unknown>).getRandomValues;
  pinRandomSource(real, { name: 'node:crypto webcrypto', target: globalThis.crypto, repin: true });
});

describe('start-up check', () => {
  it('passes on the real source and says nothing', () => {
    const lines: string[] = [];
    expect(runStartupRandomCheck((l) => lines.push(l))).toEqual({ ok: true });
    expect(lines).toEqual([]);
  });

  it('on a bad source: fails, logs one line without bytes, and latches so nothing draws', () => {
    installRandomSource(cycling(), 'cycling');
    const lines: string[] = [];
    const r = runStartupRandomCheck((l) => lines.push(l));
    expect(r).toMatchObject({ ok: false, code: 'health' });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^rng\.selftest_failed code=health reason=".*repeated_block/);
    expect(lines[0]).not.toMatch(/[0-9a-f]{16}/);
    expect(randomSourceInfo().failed).toBe('health');
    expect(() => secureRandomBytes(32)).toThrow(RandomSourceError);
  });
});

describe('error mapping', () => {
  it('a RandomSourceError, and the wallet and Recovery Key codes, become the same refusal', () => {
    for (const e of [new RandomSourceError('health', 'x'), new WalletError('random_source_failed', 'x')]) {
      const m = mapError(e);
      expect(m).toBeInstanceOf(WalletServiceError);
      expect(m).toMatchObject({ kind: 'refused', message: RNG_REFUSED_TEXT });
    }
    expect(mapRkError(new RandomSourceError('known_answer', 'x'))).toMatchObject({ kind: 'refused', message: RNG_REFUSED_TEXT });
  });
});

describe('the phone refuses to make a wallet with a bad source', () => {
  it('guardian mode: connecting the hardware wallet (which creates key 2) fails with the refusal, and stores nothing', async () => {
    const secure = new MemorySecureKeyStore();
    const kv = new MemoryKeyValueStore();
    const svc = await createRealWalletService({
      mode: 'real',
      network: 'testnet',
      platform: { os: 'ios', isSecure: true, secureKeys: secure, kv, cloudBackups: [], passkeys: new MemoryPasskeyPrf() },
      hardware: () => [],
      syncIntervalMs: 0,
      yieldToUi: async () => {},
    });
    try {
      installRandomSource(cycling(), 'cycling');
      const e = await svc.connectHardware('ledger').catch((x: unknown) => x);
      expect(e).toBeInstanceOf(WalletServiceError);
      expect(e).toMatchObject({ kind: 'refused', message: RNG_REFUSED_TEXT });
      expect(secure.items.size).toBe(0);
      expect([...kv.data.keys()].filter((k) => k.startsWith('trikey.wallet.real'))).toEqual([]);
      expect(svc.getState().onboarded).toBe(false);
    } finally {
      await svc.close();
    }
  });

  it('a new key from the library function is refused too', () => {
    installRandomSource(cycling(), 'cycling');
    expect(() => newMnemonic()).toThrow(RandomSourceError);
  });
});
