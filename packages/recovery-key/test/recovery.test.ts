/** Sweeps with every pair of keys, and the sweep fee rules. */
import { describe, expect, it } from 'vitest';
import * as btc from '@scure/btc-signer';
import { base64 } from '@scure/base';
import { SoftwareSigner, type MultisigWallet } from '@trikey/core';
import { buildVaultSweep, signVaultTx, type SweepCoins, type VaultSigner } from '../src/recovery.js';
import { decodeRawTx, verifyInput, vsizeOf } from '../src/script-verify.js';
import { mnemonicFromEntropy } from '../src/keys.js';
import { estimateVsize, feeForRate } from '../src/fees.js';
import { MNEMONICS, RK_ENTROPY, device, externalAddress, fixtureKeys, network, rejects } from './helpers.js';
import { fundVault } from './chain-helpers.js';
import { consensusVerifier, consensusVerify } from './support/consensus.js';

const dest = btc.OutScript.encode(btc.Address(network.btc).decode(externalAddress(21)));

function coinsOf(vault: MultisigWallet, values: bigint[], replaces: SweepCoins['replaces'] = []): SweepCoins {
  const coins = values.map((v, i) => fundVault(vault, v, i % 2, i));
  return { coins, totalSats: values.reduce((s, v) => s + v, 0n), replaces, unconfirmedSats: 0n, scan: undefined as never };
}

async function signers(vault: MultisigWallet) {
  const hw = device();
  const policy = { name: 'Trikey', descriptor: vault.descriptor() };
  const phone: VaultSigner = { role: 'app', label: 'phone', sign: (p) => new SoftwareSigner('app', MNEMONICS.phone).signPsbt(p, network) };
  const hardware: VaultSigner = { role: 'hardware', label: 'hardware wallet', sign: async (p) => base64.decode(await hw.signPsbt(base64.encode(p), policy)) };
  const kit: VaultSigner = { role: 'cosigner', label: 'Recovery Kit', sign: (p) => new SoftwareSigner('cosigner', mnemonicFromEntropy(RK_ENTROPY())).signPsbt(p, network) };
  return { phone, hardware, kit };
}

describe('recovery sweeps', () => {
  it('moves everything with any two keys: kit + hardware, kit + phone, phone + hardware', async () => {
    const { vault } = await fixtureKeys();
    const s = await signers(vault);
    for (const pair of [
      [s.kit, s.hardware],
      [s.kit, s.phone],
      [s.phone, s.hardware],
    ]) {
      const coins = coinsOf(vault, [1_000_000n, 2_500_000n, 30_000n]);
      const plan = buildVaultSweep({ vault, coins, destinationScript: dest, feeRate: 4, feeCapSats: 100_000n });
      expect(plan.amountSats + plan.feeSats).toBe(3_530_000n);
      const { txHex } = await signVaultTx(plan.psbt, vault, pair);
      const raw = decodeRawTx(txHex);
      expect(raw.outputs).toHaveLength(1);
      expect(vsizeOf(raw)).toBeLessThanOrEqual(plan.vsize);
      coins.coins.forEach((c, i) => verifyInput(raw, i, vault.derive(c.chain, c.index).script, c.value));
      if (consensusVerifier) {
        const r = consensusVerify(txHex, coins.coins.map((c) => ({ script: vault.derive(c.chain, c.index).script, amount: c.value })));
        expect(r.ok, r.output).toBe(true);
      }
    }
  });

  it('cannot move anything with one key, or with a key from another wallet', async () => {
    const { vault } = await fixtureKeys();
    const s = await signers(vault);
    const plan = buildVaultSweep({ vault, coins: coinsOf(vault, [1_000_000n]), destinationScript: dest, feeRate: 2, feeCapSats: 100_000n });
    await expect(signVaultTx(plan.psbt, vault, [s.kit])).rejects.toThrow();
    const stranger: VaultSigner = { role: 'hardware', label: 'another device', sign: async (p) => base64.decode(await device(MNEMONICS.hardware2).signPsbt(base64.encode(p), { name: 'x', descriptor: vault.descriptor() })) };
    expect((await rejects(signVaultTx(plan.psbt, vault, [s.kit, stranger]))).code).toBe('hardware_invalid_response');
    const liar: VaultSigner = { role: 'app', label: 'phone', sign: async () => buildVaultSweep({ vault, coins: coinsOf(vault, [999_999n]), destinationScript: dest, feeRate: 2, feeCapSats: 100_000n }).psbt };
    expect((await rejects(signVaultTx(plan.psbt, vault, [liar, s.kit]))).code).toBe('hardware_invalid_response');
  });

  it('pays the estimate, never more than the cap or 5% of the vault, and enough to replace a refill in the mempool', async () => {
    const { vault } = await fixtureKeys();
    const v1 = estimateVsize({ multisigInputs: 1, outputScriptLengths: [dest.length] });
    const one = (extra: Partial<Parameters<typeof buildVaultSweep>[0]> = {}, replaces: SweepCoins['replaces'] = [], value = 1_000_000n) =>
      buildVaultSweep({ vault, coins: coinsOf(vault, [value], replaces), destinationScript: dest, feeRate: 5, feeCapSats: 100_000n, ...extra });
    expect(one().feeSats).toBe(feeForRate(5, v1));
    expect(one({ feeRate: 2000 }).feeSats).toBe(50_000n); // 5% of 1,000,000
    expect(one({ feeRate: 2000, feeCapSats: 20_000n }).feeSats).toBe(20_000n);
    // A refill paying 285 sats at 1.5 sat/vB is in the mempool: rule 3 (more in total) and rule 4 (a higher rate).
    const r = one({ feeRate: 1 }, [{ txid: 'aa'.repeat(32), feeSats: 285n, rate: 1.5 }]);
    expect(r.feeSats).toBeGreaterThanOrEqual(285n + BigInt(v1));
    expect(r.feeRate).toBeGreaterThan(1.5);
    expect((await rejects(() => one({ feeCapSats: 100n }, [{ txid: 'aa'.repeat(32), feeSats: 285n, rate: 1.5 }]))).code).toBe('fee_cap_too_low');
    expect((await rejects(() => buildVaultSweep({ vault, coins: coinsOf(vault, []), destinationScript: dest, feeRate: 1, feeCapSats: 1000n }))).code).toBe('nothing_to_sweep');
    expect((await rejects(() => one({ feeRate: 1 }, [], 600n))).code).toMatch(/nothing_to_sweep|fee_cap_too_low/);
  });
});
