/**
 * The spending balance: a single-sig `wpkh` wallet on key 2's BIP 84 account.
 * The phone signs alone (Face ID). Refills pay into its internal chain (1);
 * the receive chain (0) is for anyone who wants to pay the phone directly.
 *
 * It also builds the CPFP child that speeds up a stuck refill: the refill's
 * output 0 belongs to this wallet, so the phone can spend it before the
 * refill confirms and pay for both.
 *
 * Silent payments (BIP 352): every input here is a P2WPKH coin of key 2's BIP 84 account, so unlike the vault's
 * multisig inputs they are eligible, and the phone alone derives the output from the keys of the inputs it spends.
 * No helper coin is needed. The output depends on the inputs, so it is made once they are fixed (see
 * `silentPaymentOutput`), and the transaction is never rebuilt with other inputs afterwards:
 *
 * - Nothing here replaces a payment (no RBF bump): a stuck payment can only be sped up by a CPFP child that spends its
 *   change, which is a new transaction and leaves the payment's inputs, and so its silent payment output, alone.
 *   `buildCpfpChild` is for the refills, which pay no silent payment.
 * - A payment that must change its inputs (more fee, a coin spent elsewhere) is built again from scratch: the output
 *   is derived again from the new inputs, so the recipient finds the new transaction, not the old one.
 */
import * as btc from '@scure/btc-signer';
import { HDKey } from '@scure/bip32';
import { hex } from '@scure/base';
import { mnemonicToSeedSync } from '@scure/bip39';
import { SEQUENCE_RBF, TX_OPTS, type KeyExpression, type Network } from '@trikey/core';
import { SilentPaymentError, createOutputs, decodeSilentPaymentAddress, looksLikeSilentPaymentAddress } from '@trikey/silent-payments';
import { DUST_SATS, P2WPKH_SCRIPT_LEN, cpfpChildFee, estimateVsize, feeForRate, rateOf } from './fees.js';
import { RecoveryKeyError } from './errors.js';

export const SPENDING_RECEIVE = 0;
export const SPENDING_INTERNAL = 1;
/** Smallest payment (the P2PKH dust limit, the strictest output type). */
export const MIN_PAYMENT_SATS = 546n;

export interface SpendingAddress {
  chain: number;
  index: number;
  address: string;
  script: Uint8Array;
  pubkey: Uint8Array;
}

function originPathNumbers(originPath: string): number[] {
  return btc.bip32Path(`m/${originPath.replace(/h/g, "'")}`);
}

export class SpendingAccount {
  private readonly hd: HDKey;
  private readonly cache = new Map<string, SpendingAddress>();

  constructor(
    readonly network: Network,
    readonly key: KeyExpression,
  ) {
    if (!new RegExp(`^84h/${network.coinType}h/\\d+h$`).test(key.originPath)) throw new Error(`not a BIP 84 account key on ${network.name}: ${key.originPath}`);
    this.hd = HDKey.fromExtendedKey(key.xpub, network.bip32);
  }

  derive(chain: number, index: number): SpendingAddress {
    const id = `${chain}/${index}`;
    const hit = this.cache.get(id);
    if (hit) return hit;
    const pubkey = this.hd.deriveChild(chain).deriveChild(index).publicKey!;
    const p = btc.p2wpkh(pubkey, this.network.btc);
    const a = { chain, index, address: p.address!, script: p.script, pubkey };
    this.cache.set(id, a);
    return a;
  }

  bip32Derivation(a: SpendingAddress): [Uint8Array, { fingerprint: number; path: number[] }][] {
    return [[a.pubkey, { fingerprint: parseInt(this.key.fingerprint, 16), path: [...originPathNumbers(this.key.originPath), a.chain, a.index] }]];
  }

  descriptor(): string {
    return `wpkh([${this.key.fingerprint}/${this.key.originPath}]${this.key.xpub}/<0;1>/*)`;
  }
}

export interface SpendingCoin {
  txid: string;
  vout: number;
  value: bigint;
  chain: number;
  index: number;
  /** Height of the funding transaction; 0 while unconfirmed. */
  height: number;
  /** The funding transaction, checked against `txid` by the caller. Pins the amount. */
  prevTxHex?: string;
}

function addCoin(tx: btc.Transaction, account: SpendingAccount, c: SpendingCoin) {
  const a = account.derive(c.chain, c.index);
  tx.addInput({
    txid: c.txid,
    index: c.vout,
    sequence: SEQUENCE_RBF,
    witnessUtxo: { script: a.script, amount: c.value },
    ...(c.prevTxHex ? { nonWitnessUtxo: hex.decode(c.prevTxHex) } : {}),
    bip32Derivation: account.bip32Derivation(a),
  });
}

function scriptOf(address: string, network: Network): Uint8Array {
  try {
    return btc.OutScript.encode(btc.Address(network.btc).decode(address));
  } catch {
    throw new RecoveryKeyError('invalid_address', `Not a valid ${network.name} address.`);
  }
}

export interface SpendingPlan {
  psbt: Uint8Array;
  fee: bigint;
  vsize: number;
  inputs: SpendingCoin[];
  change?: { index: number; value: bigint };
}

/**
 * A payment from the spending balance: largest-first over confirmed coins,
 * then over all coins (unconfirmed refills included: they are fully signed and
 * only phone + hardware could replace them).
 */
export function buildSpendingPayment(opts: {
  account: SpendingAccount;
  coins: SpendingCoin[];
  address: string;
  amount: bigint;
  feeRate: number;
  changeIndex: number;
  /** Pay this script instead of `address` (a silent payment: the output script made from the inputs, or a placeholder of its size). */
  recipientScript?: Uint8Array;
  /** Spend exactly these coins and no others (they must be enough): the inputs a silent payment's output was made from. */
  useInputs?: SpendingCoin[];
}): SpendingPlan {
  const { account, address, amount, feeRate } = opts;
  if (amount < MIN_PAYMENT_SATS) throw new RecoveryKeyError('amount_too_small', `The smallest payment is ${MIN_PAYMENT_SATS} sats.`);
  const recipient = opts.recipientScript ?? scriptOf(address, account.network);
  const change = account.derive(SPENDING_INTERNAL, opts.changeIndex);
  const byValue = (a: SpendingCoin, b: SpendingCoin) => (b.value > a.value ? 1 : b.value < a.value ? -1 : 0);
  const confirmed = opts.coins.filter((c) => c.height > 0).sort(byValue);
  const all = [...opts.coins].sort(byValue);
  const sets = opts.useInputs ? [[...opts.useInputs]] : confirmed.length < all.length ? [confirmed, all] : [all];
  for (const set of sets) {
    const chosen: SpendingCoin[] = [];
    let total = 0n;
    for (const c of set) {
      chosen.push(c);
      total += c.value;
      const vWith = estimateVsize({ wpkhInputs: chosen.length, outputScriptLengths: [recipient.length, P2WPKH_SCRIPT_LEN] });
      const vNo = estimateVsize({ wpkhInputs: chosen.length, outputScriptLengths: [recipient.length] });
      const feeWith = feeForRate(feeRate, vWith);
      const feeNo = feeForRate(feeRate, vNo);
      if (total < amount + feeNo) continue;
      const changeValue = total - amount - feeWith;
      const withChange = changeValue >= DUST_SATS;
      const tx = new btc.Transaction(TX_OPTS);
      for (const x of chosen) addCoin(tx, account, x);
      tx.addOutput({ script: recipient, amount });
      if (withChange) tx.addOutput({ script: change.script, amount: changeValue, bip32Derivation: account.bip32Derivation(change) });
      return {
        psbt: tx.toPSBT(),
        fee: withChange ? feeWith : total - amount,
        vsize: withChange ? vWith : vNo,
        inputs: chosen,
        change: withChange ? { index: opts.changeIndex, value: changeValue } : undefined,
      };
    }
  }
  if (opts.useInputs) throw new RecoveryKeyError('internal', 'The coins a silent payment was made from no longer cover it.');
  const have = all.reduce((s, c) => s + c.value, 0n);
  throw new RecoveryKeyError('insufficient_funds', `Not enough in the spending balance: ${have} sats.`, { detail: { haveSats: Number(have) } });
}

/** A taproot output script of the size of any silent payment output, for choosing coins before the real one can be made. */
export function placeholderSilentPaymentScript(): Uint8Array {
  const script = new Uint8Array(34);
  script[0] = 0x51;
  script[1] = 0x20;
  script.fill(0x02, 2); // not a valid key, and never signed or broadcast
  return script;
}

/** True for an `sp1…`/`tsp1…` address (checked properly by `silentPaymentOutput`). */
export const isSilentPaymentAddress = (address: string) => looksLikeSilentPaymentAddress(address);

/** The wallet's address problem for a silent payment address, in the wallet's own error. */
export function checkSilentPaymentAddress(address: string, network: Network): void {
  try {
    decodeSilentPaymentAddress(address, { network: network.name });
  } catch (e) {
    if (e instanceof SilentPaymentError) throw new RecoveryKeyError('invalid_address', e.code === 'wrong_network' ? `${e.message[0]!.toUpperCase()}${e.message.slice(1)}.` : 'Not a valid silent payment address.', { cause: e });
    throw e;
  }
}

/**
 * The silent payment output for `address`, made from the spending coins `inputs` (BIP 352: the sum of their private
 * keys, the input hash over the smallest outpoint, one ECDH with the recipient's scan key). Needs the mnemonic: the
 * keys are key 2's BIP 84 keys, so this runs inside the biometric prompt, with the signing.
 *
 * The inputs must be the transaction's inputs, all of them: another input, or one fewer, gives another output.
 */
export function silentPaymentOutput(opts: {
  account: SpendingAccount;
  mnemonic: string;
  inputs: SpendingCoin[];
  address: string;
}): { outputKey: Uint8Array; script: Uint8Array } {
  const { account } = opts;
  const seed = mnemonicToSeedSync(opts.mnemonic);
  const master = HDKey.fromMasterSeed(seed, account.network.bip32);
  seed.fill(0);
  const keys: Uint8Array[] = [];
  try {
    const inputs = opts.inputs.map((c) => {
      const a = account.derive(c.chain, c.index);
      const k = master.derive(`m/${account.key.originPath.replace(/h/g, "'")}/${c.chain}/${c.index}`);
      if (!k.publicKey || !k.privateKey || hex.encode(k.publicKey) !== hex.encode(a.pubkey)) throw new RecoveryKeyError('internal', 'Key 2 does not hold the spending balance.');
      keys.push(k.privateKey);
      return { txid: c.txid, vout: c.vout, prevoutScript: a.script, privateKey: k.privateKey };
    });
    const r = createOutputs({ inputs, recipients: [opts.address], network: account.network.name });
    return { outputKey: r.outputs[0]!.outputKey, script: r.outputs[0]!.script };
  } catch (e) {
    if (e instanceof SilentPaymentError) {
      if (e.code === 'invalid_address' || e.code === 'wrong_network') throw new RecoveryKeyError('invalid_address', e.code === 'wrong_network' ? `${e.message[0]!.toUpperCase()}${e.message.slice(1)}.` : 'Not a valid silent payment address.', { cause: e });
      throw new RecoveryKeyError('internal', `Silent payment: ${e.message}`, { cause: e });
    }
    throw e;
  } finally {
    master.wipePrivateData();
    for (const k of keys) k.fill(0);
  }
}

/**
 * After signing: the output is what the recipient will compute from the transaction as it will be broadcast. Their view
 * is the public keys in the inputs' witnesses, so the sender's side is checked against exactly those (BIP 352 reads the
 * key from a signed input; `createOutputs` does too and refuses a private key that does not match it).
 */
export function checkSilentPaymentOutput(opts: {
  account: SpendingAccount;
  mnemonic: string;
  txHex: string;
  inputs: SpendingCoin[];
  address: string;
  outputKey: Uint8Array;
}): void {
  const raw = btc.RawTx.decode(hex.decode(opts.txHex));
  const seed = mnemonicToSeedSync(opts.mnemonic);
  const master = HDKey.fromMasterSeed(seed, opts.account.network.bip32);
  seed.fill(0);
  const keys: Uint8Array[] = [];
  try {
    const inputs = raw.inputs.map((inp, i) => {
      const c = opts.inputs.find((x) => x.txid === hex.encode(inp.txid) && x.vout === inp.index);
      if (!c) throw new RecoveryKeyError('internal', 'The signed payment spends a coin the silent payment output was not made from.');
      const k = master.derive(`m/${opts.account.key.originPath.replace(/h/g, "'")}/${c.chain}/${c.index}`);
      keys.push(k.privateKey!);
      return {
        txid: c.txid,
        vout: c.vout,
        prevoutScript: opts.account.derive(c.chain, c.index).script,
        privateKey: k.privateKey!,
        scriptSig: inp.finalScriptSig ?? new Uint8Array(),
        witness: raw.witnesses?.[i] ?? [],
      };
    });
    if (inputs.length !== opts.inputs.length) throw new RecoveryKeyError('internal', 'The signed payment does not spend the coins the silent payment output was made from.');
    const again = createOutputs({ inputs, recipients: [opts.address], network: opts.account.network.name });
    if (hex.encode(again.outputs[0]!.outputKey) !== hex.encode(opts.outputKey)) throw new RecoveryKeyError('internal', 'The signed payment does not give the silent payment output it was made for.');
  } finally {
    master.wipePrivateData();
    for (const k of keys) k.fill(0);
  }
}

export interface CpfpPlan {
  psbt: Uint8Array;
  childFee: bigint;
  childVsize: number;
  /** Rate of parent + child together. */
  packageRate: number;
  /** What lands in the spending balance after both confirm. */
  outputValue: bigint;
}

/**
 * The child that pays for a stuck refill: spends the refill's output to the
 * spending balance back to a fresh internal address, with a fee that brings
 * parent and child together to `targetRate`. Refuses if the fee would exceed
 * `maxFee` (default: half the refill).
 */
export function buildCpfpChild(opts: {
  account: SpendingAccount;
  /** The refill's output to the spending balance. */
  parentOutput: SpendingCoin;
  parentVsize: number;
  parentFee: bigint;
  targetRate: number;
  changeIndex: number;
  minRelaySatPerVb?: number;
  maxFee?: bigint;
}): CpfpPlan {
  const { account, parentOutput } = opts;
  if (parentOutput.height > 0) throw new RecoveryKeyError('nothing_to_bump', 'That refill has already confirmed.');
  const parentRate = rateOf(opts.parentFee, opts.parentVsize);
  if (opts.targetRate <= parentRate) throw new RecoveryKeyError('nothing_to_bump', `The refill already pays ${parentRate.toFixed(1)} sat/vB.`);
  const childVsize = estimateVsize({ wpkhInputs: 1, outputScriptLengths: [P2WPKH_SCRIPT_LEN] });
  const childFee = cpfpChildFee({ parentVsize: opts.parentVsize, parentFee: opts.parentFee, childVsize, targetRate: opts.targetRate, minRelaySatPerVb: opts.minRelaySatPerVb });
  const maxFee = opts.maxFee ?? parentOutput.value / 2n;
  if (childFee > maxFee) throw new RecoveryKeyError('fee_too_high', `Speeding this refill up would cost ${childFee} sats, more than the ${maxFee} allowed.`, { detail: { childFeeSats: Number(childFee) } });
  const outputValue = parentOutput.value - childFee;
  if (outputValue < DUST_SATS) throw new RecoveryKeyError('fee_too_high', 'The refill is too small to pay for its own speed-up.');
  const out = account.derive(SPENDING_INTERNAL, opts.changeIndex);
  const tx = new btc.Transaction(TX_OPTS);
  addCoin(tx, account, parentOutput);
  tx.addOutput({ script: out.script, amount: outputValue, bip32Derivation: account.bip32Derivation(out) });
  return {
    psbt: tx.toPSBT(),
    childFee,
    childVsize,
    packageRate: Number(opts.parentFee + childFee) / (opts.parentVsize + childVsize),
    outputValue,
  };
}

/** Signs every input that belongs to key 2's BIP 84 account. */
export function signSpendingPsbt(psbt: Uint8Array, mnemonic: string, network: Network): Uint8Array {
  const seed = mnemonicToSeedSync(mnemonic);
  const master = HDKey.fromMasterSeed(seed, network.bip32);
  seed.fill(0);
  try {
    const tx = btc.Transaction.fromPSBT(psbt, TX_OPTS);
    const n = tx.sign(master as unknown as Parameters<btc.Transaction['sign']>[0], [btc.SigHash.ALL]);
    if (n !== tx.inputsLength) throw new RecoveryKeyError('internal', `signed ${n} of ${tx.inputsLength} spending inputs`);
    return tx.toPSBT();
  } finally {
    master.wipePrivateData();
  }
}

export function finalizeSpending(psbt: Uint8Array): { txid: string; txHex: string; vsize: number; fee: bigint } {
  const tx = btc.Transaction.fromPSBT(psbt, TX_OPTS);
  const fee = tx.fee;
  tx.finalize();
  return { txid: tx.id, txHex: hex.encode(tx.extract()), vsize: tx.vsize, fee };
}
