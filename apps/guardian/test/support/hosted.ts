/**
 * Fixtures for guests' hosted wallets (docs/design/family-hosting.md): a wallet the guardian knows only by its account
 * pubkeys, key 3 as a depth-0 xpub over the slot's account pubkey and a phone-chosen chaincode, the hardware
 * authorization key proven by its tweak at 0/0. Throwaway keys on regtest only.
 */
import * as btc from '@scure/btc-signer';
import { HDKey } from '@scure/bip32';
import { hex } from '@scure/base';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { randomBytes } from '@noble/hashes/utils.js';
import {
  MultisigWallet,
  ROLES,
  TX_OPTS,
  buildSweep,
  ccdtKey,
  cosignerKeyExpression,
  delegatedScripts,
  keySetId,
  tweakFromPath,
  tweakToBytes,
  type Utxo,
} from '@trikey/core';
import { pairingMessage, signMessage } from '../../src/policy/index.js';
import { AUTH_PATH, MNEMONICS, appSigner, hwAuthPrivateKey, hwAuthPubkey, hwSigner, network } from '../helpers.js';

export interface HostedFixture {
  wallet: MultisigWallet;
  walletId: string;
  accountPubkeys: { app: string; hardware: string; cosigner: string };
  hardwareAuth: { pubkey: string; path: string; tweak: string };
  proof: string;
  app: string;
  hardware: string;
}

/** The hardware wallet's authorization key and its tweak at 0/0, for `wallet`. */
export function authOf(wallet: MultisigWallet, hardwareMnemonic: string) {
  const hw = HDKey.fromExtendedKey(wallet.keys.hardware.xpub, network.bip32);
  const t = tweakFromPath(hw.publicKey!, hw.chainCode!, [0, 0]);
  return { pubkey: hwAuthPubkey(AUTH_PATH, hardwareMnemonic), path: AUTH_PATH, tweak: hex.encode(tweakToBytes(t.tweak)) };
}

export async function hostedWallet(opts: { cosignerPub: string; app?: string; hardware?: string; chainCode?: Uint8Array }): Promise<HostedFixture> {
  const app = opts.app ?? MNEMONICS.app;
  const hardware = opts.hardware ?? MNEMONICS.hardware;
  const wallet = new MultisigWallet(network, {
    app: await appSigner(app).getKey(network),
    hardware: await hwSigner(hardware).getKey(network),
    cosigner: cosignerKeyExpression(hex.decode(opts.cosignerPub), opts.chainCode ?? randomBytes(32), network),
  });
  const acct = wallet.accountPubkeys();
  const walletId = keySetId(acct);
  const accountPubkeys = { app: hex.encode(acct.app), hardware: hex.encode(acct.hardware), cosigner: hex.encode(acct.cosigner) };
  return {
    wallet,
    walletId,
    accountPubkeys,
    hardwareAuth: authOf(wallet, hardware),
    proof: signMessage(pairingMessage(walletId, accountPubkeys.cosigner), hwAuthPrivateKey(AUTH_PATH, hardware)),
    app,
    hardware,
  };
}

/** An opaque wallet map of `n` bytes, base64url (the guardian cannot read a real one either). */
export function fakeMap(n = 120, fill?: number): string {
  const b = fill === undefined ? randomBytes(n) : new Uint8Array(n).fill(fill);
  return btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * A phone-signed payment of `amount` to an outside address, with change to an OFF-PATH output: tweak-proven to the
 * three account keys, but at no derivation path (what a phone thief could make, section 4).
 */
export async function offPathPayment(fx: HostedFixture, utxo: Utxo, amount: bigint, change: bigint, to: Uint8Array, appMnemonic = fx.app): Promise<{ psbt: Uint8Array; changeScript: Uint8Array }> {
  const tx = new btc.Transaction(TX_OPTS);
  const d = fx.wallet.derive(utxo.chain, utxo.index);
  tx.addInput({
    txid: utxo.txid,
    index: utxo.vout,
    sequence: 0xfffffffd,
    witnessUtxo: { script: d.script, amount: utxo.value },
    nonWitnessUtxo: hex.decode(utxo.prevTxHex!),
    sighashType: btc.SigHash.ALL,
    ...fx.wallet.psbtFields(d),
  });
  tx.addOutput({ script: to, amount });
  const acct = fx.wallet.accountPubkeys();
  const tweaks = { app: BigInt(`0x${hex.encode(randomBytes(31))}`), hardware: BigInt(`0x${hex.encode(randomBytes(31))}`), cosigner: BigInt(`0x${hex.encode(randomBytes(31))}`) };
  const off = delegatedScripts(acct, tweaks, network);
  tx.addOutput({ script: off.script, amount: change, proprietary: ROLES.map((r) => [ccdtKey(acct[r]), tweakToBytes(tweaks[r])] as [Uint8Array, Uint8Array]) });
  const psbt = await appSigner(appMnemonic).signPsbt(tx.toPSBT(), network);
  return { psbt, changeScript: off.script };
}

/** The destination after the hardware wallet was lost: the same phone key and key 3 account, a new hardware wallet and chaincode. */
export async function destinationAfterHardwareLoss(fx: HostedFixture, newHardware = MNEMONICS.hardware2): Promise<HostedFixture> {
  return hostedWallet({ cosignerPub: fx.accountPubkeys.cosigner, app: fx.app, hardware: newHardware });
}

/** A sweep of `utxos` to `dest`, signed by the phone (the hardware wallet is the lost key). */
export async function phoneSweep(fx: HostedFixture, dest: HostedFixture, utxos: Utxo[], feeRate = 2): Promise<Uint8Array> {
  const plan = buildSweep({ from: fx.wallet, utxos, destination: dest.wallet, destinationIndex: 0, feeRate });
  return appSigner(fx.app).signPsbt(plan.psbt, network);
}

export const externalScript = (seed = 2) => btc.p2wpkh(secp256k1.getPublicKey(new Uint8Array(32).fill(seed), true), network.btc).script;
