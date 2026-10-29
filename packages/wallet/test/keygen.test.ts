/**
 * Key 2 comes from `secureRandomBytes` (the checked OS source): the same source bytes give the same words
 * (the source is injected here), and a source that fails a check makes no wallet at all.
 */
import { validateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import { deterministicRandom, installRandomSource } from '@trikey/core/testing/random';
import { describe, expect, it } from 'vitest';
import { ManualClock } from '@trikey/guardian/policy';
import { TrikeyWallet, WalletError, mnemonicFromEntropy, newMnemonic } from '../src/index.js';
import { MemoryCloudBackupStore, MemoryPasskeyPrf } from '../src/testing/index.js';
import { phone } from './helpers.js';

const newPhone = () => phone({ clock: new ManualClock(Date.UTC(2026, 9, 1)), hardware: undefined, cloud: new MemoryCloudBackupStore(), passkey: new MemoryPasskeyPrf() });

async function key2Words(p: ReturnType<typeof newPhone>, w: TrikeyWallet): Promise<string> {
  return mnemonicFromEntropy(p.secure.items.get(w.state.secrets.key2)!.secret);
}

describe('key 2 generation', () => {
  it('is a valid 24-word mnemonic', () => {
    const m = newMnemonic();
    expect(m.split(' ')).toHaveLength(24);
    expect(validateMnemonic(m, wordlist)).toBe(true);
  });

  it('the same source bytes give the same words; other bytes give other words', async () => {
    const words: string[] = [];
    for (const seed of ['one', 'one', 'two']) {
      const src = deterministicRandom(seed);
      try {
        const p = newPhone();
        const w = await TrikeyWallet.create(p.deps);
        const m = await key2Words(p, w);
        expect(validateMnemonic(m, wordlist)).toBe(true);
        words.push(m);
        await w.close();
      } finally {
        src.restore();
      }
    }
    expect(words[0]).toBe(words[1]);
    expect(words[2]).not.toBe(words[0]);
  });

  it('a stuck source makes no wallet and stores nothing', async () => {
    const src = installRandomSource((b) => b.fill(0), 'zeros');
    try {
      const p = newPhone();
      const e = await TrikeyWallet.create(p.deps).catch((x: unknown) => x);
      expect(e).toBeInstanceOf(WalletError);
      expect((e as WalletError).code).toBe('random_source_failed');
      expect(p.secure.items.size).toBe(0);
      expect(await TrikeyWallet.open(p.deps)).toBeUndefined();
    } finally {
      src.restore();
    }
  });
});
