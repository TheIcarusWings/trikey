/**
 * Test fixtures. Every key here is a throwaway: well-known BIP39 test
 * mnemonics or fixed test bytes, on regtest only.
 */
import * as btc from '@scure/btc-signer';
import { hex } from '@scure/base';
import { HDKey } from '@scure/bip32';
import { secp256k1, schnorr } from '@noble/curves/secp256k1.js';
import { randomBytes } from '@noble/hashes/utils.js';
import { sha256 } from '@noble/hashes/sha2.js';
import {
  MultisigWallet,
  NETWORKS,
  Recipient,
  SoftwareSigner,
  TX_OPTS,
  Utxo,
  buildSpend,
  cosignerKeyExpression,
} from '@trikey/core';
import {
  DAY,
  HardwareAction,
  HardwareApproval,
  ManualClock,
  MemoryStore,
  PolicyEngine,
  Rules,
  SoftwareCosignerSigner,
  StateStore,
  approvalMessage,
  pairingMessage,
  signMessage,
} from '../src/policy/index.js';

export const network = NETWORKS.regtest;

export const MNEMONICS = {
  app: 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about',
  hardware: 'legal winner thank year wave sausage worth useful legal winner thank yellow',
  app2: 'vessel ladder alter error federal sibling chat ability sun glass valve picture',
  hardware2: 'zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo wrong',
  stranger: 'letter advice cage absurd amount doctor acoustic avoid letter advice cage above',
};

export const appSigner = (m = MNEMONICS.app) => new SoftwareSigner('app', m);
export const hwSigner = (m = MNEMONICS.hardware) => new SoftwareSigner('hardware', m, 'fake hardware wallet');

/** Fixed throwaway cosigner (key 3) private keys. */
export const COSIGNER_PRIV = new Uint8Array(32).fill(7);
export const OTHER_COSIGNER_PRIV = new Uint8Array(32).fill(9);

/** Default single-sig path the fake hardware wallet signs approvals with. */
export const AUTH_PATH = "m/84'/1'/1000'/0/0";

export const T0 = Date.UTC(2026, 9, 1, 12, 0, 0);

export function nostrKey(seed: number): string {
  return hex.encode(schnorr.getPublicKey(new Uint8Array(32).fill(seed)));
}

export const APP_NOSTR = nostrKey(11);
export const CONTACT_A = nostrKey(12);
export const CONTACT_B = nostrKey(13);
export const STRANGER_NOSTR = nostrKey(14);

export const DEFAULT_RULES: Rules = {
  dailyLimitSats: 100_000n,
  recoveryDelayDays: 7,
  alertContacts: [CONTACT_A],
  sweepFeeCapSats: 20_000n,
};

export async function makeWallet(opts: { app?: string; hardware?: string; cosignerPriv?: Uint8Array } = {}) {
  const app = await appSigner(opts.app).getKey(network);
  const hardware = await hwSigner(opts.hardware).getKey(network);
  const pub = secp256k1.getPublicKey(opts.cosignerPriv ?? COSIGNER_PRIV, true);
  const cosigner = cosignerKeyExpression(pub, randomBytes(32), network);
  return new MultisigWallet(network, { app, hardware, cosigner });
}

/** A fake funding transaction paying `value` to the wallet address at (chain, index). */
export function fund(wallet: MultisigWallet, chain: number, index: number, value: bigint): Utxo {
  const d = wallet.derive(chain, index);
  return fundScript(d.script, value, chain, index);
}

export function fundScript(script: Uint8Array, value: bigint, chain = 0, index = 0): Utxo {
  const raw = btc.RawTx.encode({
    version: 2,
    segwitFlag: false,
    inputs: [{ txid: randomBytes(32), index: 0, finalScriptSig: new Uint8Array([0x51]), sequence: 0xffffffff }],
    outputs: [{ script, amount: value }],
    lockTime: 0,
  });
  const txid = hex.encode(sha256(sha256(raw)).reverse());
  return { txid, vout: 0, value, chain, index, prevTxHex: hex.encode(raw) };
}

export const externalAddress = (seed = 2) => btc.p2wpkh(secp256k1.getPublicKey(new Uint8Array(32).fill(seed), true), network.btc).address!;

export function hwAuthPrivateKey(path = AUTH_PATH, mnemonic = MNEMONICS.hardware): Uint8Array {
  return hwSigner(mnemonic).master(network).derive(path).privateKey!;
}

export function hwAuthPubkey(path = AUTH_PATH, mnemonic = MNEMONICS.hardware): string {
  return hex.encode(hwSigner(mnemonic).master(network).derive(path).publicKey!);
}

export interface Ctx {
  engine: PolicyEngine;
  clock: ManualClock;
  store: StateStore;
  wallet: MultisigWallet;
  walletId: string;
  signer: SoftwareCosignerSigner;
}

export async function setup(opts: { rules?: Partial<Rules>; store?: StateStore; clock?: ManualClock; locked?: boolean } = {}): Promise<Ctx> {
  const clock = opts.clock ?? new ManualClock(T0);
  const store = opts.store ?? new MemoryStore();
  const signer = new SoftwareCosignerSigner(COSIGNER_PRIV);
  const engine = await PolicyEngine.open({ store, clock, signer: opts.locked ? undefined : signer });
  const wallet = await makeWallet();
  const walletId = wallet.fingerprint();
  const res = await engine.register({
    network: 'regtest',
    descriptor: wallet.descriptor(),
    cosignerAccountPubkey: hex.encode(signer.accountPubkey),
    rules: { ...DEFAULT_RULES, ...opts.rules },
    hardwareAuth: { kind: 'bip137', pubkey: hwAuthPubkey(), path: AUTH_PATH },
    hardwareAuthProof: signMessage(pairingMessage(walletId, hex.encode(signer.accountPubkey)), hwAuthPrivateKey()),
    appNostrPubkey: APP_NOSTR,
  });
  if (!res.ok) throw new Error(`registration failed: ${JSON.stringify(res.refusal)}`);
  return { engine, clock, store, wallet, walletId, signer };
}

/** A hardware approval signed with the fake device's authorization key. */
export function approve(
  ctx: Pick<Ctx, 'clock' | 'walletId'>,
  action: HardwareAction,
  sequence: number,
  opts: { expiresInSec?: number; privateKey?: Uint8Array; walletId?: string } = {},
): HardwareApproval {
  const expiresAt = Math.floor(ctx.clock.now() / 1000) + (opts.expiresInSec ?? 600);
  const message = approvalMessage(action, { walletId: opts.walletId ?? ctx.walletId, sequence, expiresAt });
  return { kind: 'bip137', sequence, expiresAt, signature: signMessage(message, opts.privateKey ?? hwAuthPrivateKey()) };
}

/** An unsigned spend PSBT built with core's buildSpend. */
export function spendPsbt(
  wallet: MultisigWallet,
  utxos: Utxo[],
  recipients: Recipient[],
  opts: { feeRate?: number; changeIndex?: number } = {},
) {
  return buildSpend({ wallet, utxos, recipients, feeRate: opts.feeRate ?? 2, changeIndex: opts.changeIndex ?? 0 });
}

/** Builds, then signs with the phone key. */
export async function phoneSpend(
  wallet: MultisigWallet,
  utxos: Utxo[],
  amount: bigint,
  opts: { feeRate?: number; changeIndex?: number; to?: string } = {},
) {
  const plan = spendPsbt(wallet, utxos, [{ address: opts.to ?? externalAddress(), amount }], opts);
  return { plan, psbt: await appSigner().signPsbt(plan.psbt, network) };
}

/**
 * Hand-built PSBT (for malformed cases): each input given as wallet + utxo,
 * optionally without nonWitnessUtxo or with overrides.
 */
export function rawPsbt(
  inputs: { wallet: MultisigWallet; utxo: Utxo; omitPrevTx?: boolean; script?: Uint8Array }[],
  outputs: { script: Uint8Array; amount: bigint; selfAt?: { wallet: MultisigWallet; chain: number; index: number } }[],
): Uint8Array {
  const tx = new btc.Transaction(TX_OPTS);
  for (const i of inputs) {
    const d = i.wallet.derive(i.utxo.chain, i.utxo.index);
    const prev = i.utxo.prevTxHex;
    tx.addInput({
      txid: i.utxo.txid,
      index: i.utxo.vout,
      sequence: 0xfffffffd,
      witnessUtxo: { script: i.script ?? d.script, amount: i.utxo.value },
      ...(!i.omitPrevTx && prev ? { nonWitnessUtxo: hex.decode(prev) } : {}),
      sighashType: btc.SigHash.ALL,
      ...i.wallet.psbtFields(d),
    });
  }
  for (const o of outputs) {
    const fields = o.selfAt ? o.selfAt.wallet.psbtFields(o.selfAt.wallet.derive(o.selfAt.chain, o.selfAt.index)) : {};
    tx.addOutput({ script: o.script, amount: o.amount, ...fields });
  }
  return tx.toPSBT();
}

export const scriptOf = (address: string) => btc.OutScript.encode(btc.Address(network.btc).decode(address));

export { DAY, HDKey };

/** Replaces the `nth` (0-based) occurrence of `from` with `to` in the PSBT bytes (for malformed PSBTs scure won't build). */
export function patchBytes(psbt: Uint8Array, from: Uint8Array, to: Uint8Array, nth = 0): Uint8Array {
  const h = hex.encode(psbt);
  const f = hex.encode(from);
  let at = -1;
  for (let k = 0; k <= nth; k++) {
    at = h.indexOf(f, at + 1);
    if (at < 0) throw new Error('pattern not found');
  }
  return hex.decode(h.slice(0, at) + hex.encode(to) + h.slice(at + f.length));
}

export function le64(v: bigint): Uint8Array {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, v, true);
  return b;
}
