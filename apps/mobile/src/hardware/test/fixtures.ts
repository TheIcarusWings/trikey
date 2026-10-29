/**
 * Test fixtures: a 2-of-3 wallet built with @trikey/core's helpers (throwaway keys from the public BIP39 test
 * mnemonics), a spend PSBT, and a fake "device" that signs with the throwaway hardware key.
 */
import { hex } from '@scure/base';
import { base64 } from '@scure/base';
import { HDKey } from '@scure/bip32';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { MultisigWallet, bip48Path, buildSpend, cosignerKeyExpression, parsePsbt, sighashAll } from '@trikey/core';
import type { HardwareWalletPolicy } from '@trikey/wallet';
import { appSigner, fund, hwSigner, network } from '../../../../../packages/core/test/helpers';
import { formatPath } from '../common/path';
import { inputsForFingerprint, type PartialSignature } from '../common/psbt';

export { network };

export interface Fixture {
  wallet: MultisigWallet;
  /** Wallet policy as the wallet logic passes it to the adapters. */
  policy: HardwareWalletPolicy;
  /** Master fingerprint of the throwaway "hardware wallet", 8 hex chars. */
  hardwareFingerprint: string;
  /** The hardware account xpub (tpub). */
  hardwareXpub: string;
  /** An unsigned spend: one input (chain 0, index 3), a payment, and a change output (chain 1, index 4). */
  psbt: Uint8Array;
  psbtBase64: string;
  /** Same as `psbt` with the app key's signature already in. */
  psbtAppSigned: Uint8Array;
}

export async function makeFixture(): Promise<Fixture> {
  // Same keys as core's `makeWallet`, but with a fixed guardian chain code so the descriptor is the same on every run.
  const cosignerMaster = HDKey.fromMasterSeed(new Uint8Array(32).fill(7));
  const cosigner = cosignerKeyExpression(cosignerMaster.derive(bip48Path(network)).publicKey!, new Uint8Array(32).fill(9), network);
  const wallet = new MultisigWallet(network, {
    app: await appSigner().getKey(network),
    hardware: await hwSigner().getKey(network),
    cosigner,
  });
  const utxo = fund(wallet, 0, 3, 100_000n);
  const plan = buildSpend({
    wallet,
    utxos: [utxo],
    recipients: [{ address: wallet.derive(0, 9).address, amount: 30_000n }],
    feeRate: 2,
    changeIndex: 4,
  });
  const hardwareKey = wallet.keys.hardware;
  return {
    wallet,
    policy: { name: 'Trikey test', descriptor: wallet.descriptor() },
    hardwareFingerprint: hardwareKey.fingerprint,
    hardwareXpub: hardwareKey.xpub,
    psbt: plan.psbt,
    psbtBase64: base64.encode(plan.psbt),
    psbtAppSigned: await appSigner().signPsbt(plan.psbt, network),
  };
}

/**
 * What the throwaway hardware wallet signs: one SIGHASH_ALL signature per input it has a key for, whether or not the
 * PSBT already carries one (a real device signs again and, with RFC 6979 nonces, produces the same bytes).
 */
export async function deviceSignatures(psbt: Uint8Array): Promise<PartialSignature[]> {
  const master = hwSigner().master(network);
  const tx = parsePsbt(psbt);
  const out: PartialSignature[] = [];
  for (const d of inputsForFingerprint(tx, hex.encode(u32(master.fingerprint)))) {
    const input = tx.getInput(d.index);
    const priv = master.derive(formatPath(d.path)).privateKey!;
    const msg = sighashAll(tx, d.index, input.witnessScript!, input.witnessUtxo!.amount);
    const der = secp256k1.sign(msg, priv, { prehash: false, format: 'der', lowS: true });
    out.push({ inputIndex: d.index, pubkey: d.pubkey, signature: new Uint8Array([...der, 1]) });
  }
  return out;
}

function u32(n: number): Uint8Array {
  return new Uint8Array([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]);
}

export function inputCount(psbt: Uint8Array): number {
  return parsePsbt(psbt).inputsLength;
}
