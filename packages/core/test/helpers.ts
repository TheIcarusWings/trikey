import * as btc from '@scure/btc-signer';
import { hex } from '@scure/base';
import { HDKey } from '@scure/bip32';
import { randomBytes } from '@noble/hashes/utils.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { NETWORKS, bip48Path } from '../src/network.js';
import { SoftwareSigner } from '../src/signers.js';
import { MultisigWallet, cosignerKeyExpression } from '../src/wallet.js';
import { Utxo } from '../src/psbt.js';

export const network = NETWORKS.regtest;

export const MNEMONICS = {
  app: 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about',
  hardware: 'legal winner thank year wave sausage worth useful legal winner thank yellow',
  cosigner: 'letter advice cage absurd amount doctor acoustic avoid letter advice cage above',
  hardware2: 'zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo wrong',
  app2: 'vessel ladder alter error federal sibling chat ability sun glass valve picture',
};

export const appSigner = () => new SoftwareSigner('app', MNEMONICS.app);
export const hwSigner = (m = MNEMONICS.hardware) => new SoftwareSigner('hardware', m, 'fake hardware wallet');

/** Builds a wallet the way the app does: cosigner contributes only a raw pubkey. */
export async function makeWallet(cosignerAccountPub?: Uint8Array) {
  const app = await appSigner().getKey(network);
  const hardware = await hwSigner().getKey(network);
  const cosignerMaster = HDKey.fromMasterSeed(new Uint8Array(32).fill(7));
  const pub = cosignerAccountPub ?? cosignerMaster.derive(bip48Path(network)).publicKey!;
  const cosigner = cosignerKeyExpression(pub, randomBytes(32), network);
  return { wallet: new MultisigWallet(network, { app, hardware, cosigner }), cosignerMaster };
}

/** A fake funding transaction paying `value` to the wallet address at (chain, index). */
export function fund(wallet: MultisigWallet, chain: number, index: number, value: bigint): Utxo {
  const d = wallet.derive(chain, index);
  const raw = btc.RawTx.encode({
    version: 2,
    segwitFlag: false,
    inputs: [{ txid: randomBytes(32), index: 0, finalScriptSig: new Uint8Array([0x51]), sequence: 0xffffffff }],
    outputs: [{ script: d.script, amount: value }],
    lockTime: 0,
  });
  const txid = hex.encode(sha256(sha256(raw)).reverse());
  return { txid, vout: 0, value, chain, index, prevTxHex: hex.encode(raw) };
}
