/**
 * Key 2 and the paper Recovery Key come from `secureRandomBytes`: the same source bytes give the same
 * words (the source is injected here), and a source that fails a check makes no key. Throwaway keys,
 * regtest.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { validateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import { deterministicRandom, installRandomSource } from '@trikey/core/testing/random';
import { MemoryKeyValueStore, MemorySecureKeyStore, SoftwareHardwareProvider, SoftwareHardwareSigner } from '@trikey/wallet/testing';
import { EsploraClient } from '../src/esplora.js';
import { SimChain } from '../src/testing/index.js';
import { startFakeEsplora, type FakeEsplora } from '../src/testing/esplora-server.js';
import { RecoveryKeyWallet, type RecoveryKeyDeps } from '../src/wallet.js';
import { mnemonicFromEntropy, newPhoneMnemonic, newRecoveryKeyEntropy } from '../src/keys.js';
import { RecoveryKeyError } from '../src/errors.js';
import { MNEMONICS } from './helpers.js';

const servers: FakeEsplora[] = [];
afterEach(async () => {
  while (servers.length) await servers.pop()!.close();
});

async function deps(): Promise<{ deps: RecoveryKeyDeps; secure: MemorySecureKeyStore }> {
  const srv = await startFakeEsplora(new SimChain({ height: 200 }));
  servers.push(srv);
  const ledger = new SoftwareHardwareSigner({ mnemonic: MNEMONICS.hardware, network: 'regtest', kind: 'ledger', model: 'Nano X' });
  const secure = new MemorySecureKeyStore();
  return {
    secure,
    deps: { network: 'regtest', esplora: new EsploraClient({ baseUrl: srv.url }), hardware: new SoftwareHardwareProvider(ledger), clock: { now: () => 1_800_000_000_000 }, secureStore: secure, store: new MemoryKeyValueStore() },
  };
}

/** Key 2's words and the Recovery Kit's words of a wallet made with the current source. */
async function make(): Promise<{ key2: string; kit: string[] }> {
  const d = await deps();
  const w = await RecoveryKeyWallet.create(d.deps);
  const key2 = mnemonicFromEntropy(d.secure.items.get(w.state.secrets.key2)!.secret);
  await w.connectHardware();
  const kit = await w.createRecoveryKit();
  await w.close();
  return { key2, kit: kit.recoveryWords };
}

describe('Recovery Key mode key generation', () => {
  it('makes valid 24-word and 12-word keys', () => {
    expect(validateMnemonic(newPhoneMnemonic(), wordlist)).toBe(true);
    const e = newRecoveryKeyEntropy();
    expect(e).toHaveLength(16);
    expect(mnemonicFromEntropy(e).split(' ')).toHaveLength(12);
  });

  it('the same source bytes give the same key 2 and Recovery Kit; other bytes other ones', async () => {
    const runs: { key2: string; kit: string[] }[] = [];
    for (const seed of ['a', 'a', 'b']) {
      const src = deterministicRandom(seed);
      try {
        runs.push(await make());
      } finally {
        src.restore();
      }
    }
    expect(runs[0]).toEqual(runs[1]);
    expect(runs[2]!.key2).not.toBe(runs[0]!.key2);
    expect(runs[2]!.kit).not.toEqual(runs[0]!.kit);
    expect(validateMnemonic(runs[0]!.key2, wordlist)).toBe(true);
    expect(validateMnemonic(runs[0]!.kit.join(' '), wordlist)).toBe(true);
  });

  it('a stuck source makes no wallet and no kit', async () => {
    const d = await deps();
    const w = await RecoveryKeyWallet.create(d.deps);
    await w.connectHardware();
    const src = installRandomSource((b) => b.fill(0), 'zeros');
    try {
      const kitError = await w.createRecoveryKit().catch((e: unknown) => e);
      expect(kitError).toBeInstanceOf(RecoveryKeyError);
      expect((kitError as RecoveryKeyError).code).toBe('random_source_failed');
      const d2 = await deps();
      const createError = await RecoveryKeyWallet.create(d2.deps).catch((e: unknown) => e);
      expect((createError as RecoveryKeyError).code).toBe('random_source_failed');
      expect(d2.secure.items.size).toBe(0);
    } finally {
      src.restore();
      await w.close();
    }
  });

  it('a source that cycles (passes every per-call check) makes no wallet and no kit either', async () => {
    const blocks = [7, 9].map((m) => Uint8Array.from({ length: 32 }, (_, i) => (i * 61 + m * 17) & 255));
    let n = 0;
    const src = installRandomSource((buf) => {
      for (let o = 0; o < buf.length; o += 32) buf.set(blocks[n++ % 2]!.subarray(0, Math.min(32, buf.length - o)), o);
    }, 'cycling');
    try {
      expect(() => newPhoneMnemonic()).toThrow(/health test/);
      expect(() => newRecoveryKeyEntropy()).toThrow(/health test/);
      const d = await deps();
      const e = await RecoveryKeyWallet.create(d.deps).catch((x: unknown) => x);
      expect(e).toBeInstanceOf(RecoveryKeyError);
      expect((e as RecoveryKeyError).code).toBe('random_source_failed');
      expect(d.secure.items.size).toBe(0);
    } finally {
      src.restore();
    }
  });
});
