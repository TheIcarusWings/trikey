/**
 * Shared fixtures for the security review's regression tests (test/security/*). Regtest and throwaway
 * keys only.
 */
import { hex } from '@scure/base';
import * as btc from '@scure/btc-signer';
import { MultisigWallet, TX_OPTS, type Utxo } from '@trikey/core';
import type { HandlerContext } from '@trikey/protocol';
import { buildHandlers } from '../../src/nostr/handlers.js';
import { pairingMessage, signMessage, type Rules } from '../../src/policy/index.js';
import type { FundedOutput, GuardianRig } from '../support/index.js';
import { APP_NOSTR, AUTH_PATH, CONTACT_A, appSigner, hwAuthPrivateKey, hwAuthPubkey, hwSigner, network } from '../helpers.js';

/** Pairs a wallet (the test phone and hardware keys, the rig's key 3) straight through the engine. */
export async function pairInRig(rig: GuardianRig, rules: Partial<Rules> = {}): Promise<{ wallet: MultisigWallet; walletId: string }> {
  const g = rig.guardian;
  const pub = g.keystore!.public;
  const wallet = new MultisigWallet(network, {
    app: await appSigner().getKey(network),
    hardware: await hwSigner().getKey(network),
    cosigner: { fingerprint: pub.fingerprint, originPath: pub.path.replace(/^m\//, '').replace(/'/g, 'h'), xpub: pub.xpub },
  });
  const walletId = wallet.fingerprint();
  const reg = await g.engine.register({
    network: 'regtest',
    descriptor: wallet.descriptor(),
    cosignerAccountPubkey: pub.accountPubkey,
    rules: { dailyLimitSats: 100_000n, recoveryDelayDays: 7, alertContacts: [CONTACT_A], sweepFeeCapSats: 20_000n, ...rules },
    hardwareAuth: { kind: 'bip137', pubkey: hwAuthPubkey(), path: AUTH_PATH },
    hardwareAuthProof: signMessage(pairingMessage(walletId, pub.accountPubkey), hwAuthPrivateKey()),
    appNostrPubkey: APP_NOSTR,
  });
  if (!reg.ok) throw new Error(`registration failed: ${JSON.stringify(reg.refusal)}`);
  g.rpc?.addPeer(APP_NOSTR);
  return { wallet, walletId };
}

/** A rig-funded output as core's `Utxo` at (chain, index). */
export const asUtxo = (f: FundedOutput, chain: number, index: number): Utxo => ({ txid: f.txid, vout: f.vout, value: f.value, chain, index, prevTxHex: f.rawTx });

/** A hand-built PSBT spending `inputs` (wallet coins) to `outputs`; `selfAt` marks an output as the wallet's own. */
export function walletPsbt(
  wallet: MultisigWallet,
  inputs: Utxo[],
  outputs: { script: Uint8Array; amount: bigint; selfAt?: { chain: number; index: number } }[],
): Uint8Array {
  const tx = new btc.Transaction(TX_OPTS);
  for (const u of inputs) {
    const d = wallet.derive(u.chain, u.index);
    tx.addInput({
      txid: u.txid,
      index: u.vout,
      sequence: 0xfffffffd,
      witnessUtxo: { script: d.script, amount: u.value },
      nonWitnessUtxo: hex.decode(u.prevTxHex!),
      sighashType: btc.SigHash.ALL,
      ...wallet.psbtFields(d),
    });
  }
  for (const o of outputs) tx.addOutput({ script: o.script, amount: o.amount, ...(o.selfAt ? wallet.psbtFields(wallet.derive(o.selfAt.chain, o.selfAt.index)) : {}) });
  return tx.toPSBT();
}

/** Calls a protocol handler of the rig's guardian directly, as the RPC server would after authorizing `sender`. */
export async function callHandler(rig: GuardianRig, method: string, params: unknown, sender = APP_NOSTR): Promise<any> {
  const handlers = buildHandlers(rig.guardian) as Record<string, (p: unknown, ctx: HandlerContext) => unknown>;
  const ctx: HandlerContext = { sender, id: hex.encode(crypto.getRandomValues(new Uint8Array(16))), wrapId: 'test', createdAt: rig.nowSec() };
  return handlers[method]!(params, ctx);
}
