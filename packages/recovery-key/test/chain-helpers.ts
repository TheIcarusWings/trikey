/** Fixtures for refill-chain tests: fake vault deposits and the two-device signing the wallet does. */
import * as btc from '@scure/btc-signer';
import { base64, hex } from '@scure/base';
import { sha256 } from '@noble/hashes/sha2.js';
import { SoftwareSigner, type MultisigWallet } from '@trikey/core';
import { finalizeRefill, type StoredRefill, type UnsignedRefill, type VaultCoin } from '../src/refills.js';
import { MNEMONICS, device, network } from './helpers.js';

let fundingNonce = 0;
/** A fake funding transaction paying `value` to the vault address at (chain, index). */
export function fundVault(vault: MultisigWallet, value: bigint, chain = 0, index = 0): VaultCoin {
  const d = vault.derive(chain, index);
  const raw = btc.RawTx.encode({
    version: 2,
    segwitFlag: false,
    inputs: [{ txid: sha256(Uint8Array.of(fundingNonce++, 7)), index: 0, finalScriptSig: new Uint8Array([0x51]), sequence: 0xffffffff }],
    outputs: [{ script: d.script, amount: value }],
    lockTime: 0,
  });
  const txid = hex.encode(sha256(sha256(raw)).reverse());
  return { txid, vout: 0, value, chain, index, prevTxHex: hex.encode(raw) };
}

/** Signs refills the way the wallet does: the hardware wallet first, then the phone. */
export async function signRefills(refills: UnsignedRefill[], vault: MultisigWallet, hw = device(), phoneMnemonic = MNEMONICS.phone): Promise<StoredRefill[]> {
  const app = new SoftwareSigner('app', phoneMnemonic);
  const policy = { name: 'Trikey', descriptor: vault.descriptor() };
  const out: StoredRefill[] = [];
  for (const r of refills) {
    const byHw = base64.decode(await hw.signPsbt(base64.encode(r.psbt), policy));
    const both = await app.signPsbt(byHw, network);
    out.push(finalizeRefill(r, both));
  }
  return out;
}
