/**
 * Silent payments (BIP 352) in the phone wallet, without I/O: the pieces `TrikeyWallet` wires to its state, the
 * secure store, the guardian and the chain. DESIGN.md, "Silent payments", has the why.
 *
 * - **Sending** needs one eligible input, and the vault's `wsh(sortedmulti)` inputs are not eligible. So every
 *   payment to an `sp1…` address also spends the phone's **helper coin**: a small single-key P2WPKH coin of key 2's
 *   seed at `m/84'/coin'/1'`. It is the only eligible input, so the phone alone derives the output; its change goes
 *   back to a fresh helper address. The vault inputs ride along and are signed as always.
 * - **Receiving** goes to a phone-held single-key silent payment wallet (keys at BIP 352's paths of key 2's seed).
 *   Found coins are swept into the vault one coin per transaction, so the sweeps do not link the payments.
 */
import * as btc from '@scure/btc-signer';
import { HDKey } from '@scure/bip32';
import { hex } from '@scure/base';
import { secp256k1, schnorr } from '@noble/curves/secp256k1.js';
import { sha256 } from '@noble/hashes/sha2.js';
import {
  PsbtError,
  ROLES,
  TX_OPTS,
  compareBytes,
  delegatedScripts,
  findTweak,
  parsePsbt,
  sighashAll,
  type AccountPubkeys,
  type MultisigWallet,
  type Network,
  type NetworkName,
  type Role,
  type Tweaks,
} from '@trikey/core';
import {
  CHANGE_LABEL,
  SilentPaymentError,
  createOutputs,
  decodeSilentPaymentAddress,
  labelTable,
  matchesTweak,
  parseTransaction,
  receiverAddress,
  scanTransaction,
  spendingPrivateKey,
  taprootScript,
  type PrevoutLike,
} from '@trikey/silent-payments';
import { WalletError } from './errors.js';

// ---------------------------------------------------------------------------
// Paths and sizes

/** The helper coin's BIP 84 account below key 2's seed (account 0 stays free for other single-key uses). */
export const HELPER_ACCOUNT = 1;
export const helperAccountPath = (network: Network) => `m/84'/${network.coinType}'/${HELPER_ACCOUNT}'`;
/** BIP 352 account of the receiving keys. */
export const SILENT_PAYMENT_ACCOUNT = 0;

/** Signals RBF (BIP 125), as core does for vault spends. */
export const SEQUENCE_RBF = 0xfffffffd;
/** Smallest output the wallet creates. */
export const DUST_SATS = 546;
/** vbytes: P2WPKH input (41 + 108/4) and output (8 + 1 + 22). */
export const VB_P2WPKH_INPUT = 68;
export const VB_P2WPKH_OUTPUT = 31;
/** A sweep: 1 taproot key-path input (41 + 66/4), 1 P2WSH output (43), overhead 10.5. Rounded up. */
export const VB_SWEEP = 111;
/** A received coin waits (is not swept) while what would reach the vault after the fee is below this. */
export const DEFAULT_SWEEP_MIN_SATS = 1000;
/** Sweeps per `sweepSilentPayments` call: each uses a fresh vault address, and the guardian scans 20 ahead. */
export const MAX_SWEEPS_PER_CALL = 10;

/** The helper's keys: its account key (private, kept without biometrics) and a child per address. */
export function helperChild(account: HDKey, chain: 0 | 1, index: number): HDKey {
  return account.deriveChild(chain).deriveChild(index);
}

export const p2wpkhScript = (pubkey: Uint8Array) => btc.p2wpkh(pubkey).script;

// ---------------------------------------------------------------------------
// The receiver

/** What a scanning service needs: the scan private key (it can see payments, not spend them), B_spend, the labels. */
export interface SilentPaymentScanKeys {
  network: NetworkName;
  scanPrivateKey: Uint8Array;
  /** B_spend, compressed. */
  spendPublicKey: Uint8Array;
  /** Labels in use; always includes the change label 0. */
  labels: number[];
}

/** A payment a scanner found. */
export interface SilentPaymentMatch {
  txid: string;
  vout: number;
  valueSats: number;
  /** The output key (x-only hex). */
  outputKey: string;
  /** The private key tweak (t_k plus the label's, hex): the coin's key is b_spend + tweak. */
  tweak: string;
  label?: number;
  /** Block height (0 if unconfirmed). */
  height: number;
}

/**
 * Finds payments from `fromHeight` up. The guardian can implement this over nostr (it holds the scan key and
 * reads blocks from its node); `LocalSilentPaymentScanner` does it from blocks given to it.
 */
export interface SilentPaymentScanner {
  scan(fromHeight: number): Promise<{ tipHeight: number; matches: SilentPaymentMatch[] }>;
}

/**
 * The phone's silent payment keys. The scan key may be shared with a scanning service; the spend key is never held
 * here: `spendKey` loads it (from key 2 in the `SecureKeyStore`, behind biometrics) only to sweep.
 */
export class SilentPaymentReceiver {
  readonly network: NetworkName;
  readonly spendPublicKey: Uint8Array;
  readonly #scanPrivateKey: Uint8Array;
  readonly #labels: number[];
  readonly #spendKey: (reason: string) => Promise<Uint8Array>;

  constructor(opts: { network: NetworkName; scanPrivateKey: Uint8Array; spendPublicKey: Uint8Array; labels?: number[]; spendKey: (reason: string) => Promise<Uint8Array> }) {
    this.network = opts.network;
    this.#scanPrivateKey = opts.scanPrivateKey.slice();
    this.spendPublicKey = opts.spendPublicKey.slice();
    this.#labels = [...new Set(opts.labels ?? [])].filter((m) => m !== CHANGE_LABEL).sort((a, b) => a - b);
    this.#spendKey = opts.spendKey;
  }

  /** The address to hand out: unlabeled, or with label `m >= 1` (label 0 is the change label and is refused). */
  address(opts: { label?: number } = {}): string {
    try {
      return receiverAddress({ scanPrivateKey: this.#scanPrivateKey, spendPublicKey: this.spendPublicKey }, this.network, opts);
    } catch (e) {
      throw asWalletError(e);
    }
  }

  get labels(): readonly number[] {
    return this.#labels;
  }

  /** For a scanning service (the guardian): it can find payments but not spend them. */
  scanKeys(): SilentPaymentScanKeys {
    return { network: this.network, scanPrivateKey: this.#scanPrivateKey.slice(), spendPublicKey: this.spendPublicKey.slice(), labels: [CHANGE_LABEL, ...this.#labels] };
  }

  /** Does a scanner's match check out: the tweak gives the output key, and its label is one of ours? */
  verify(m: Pick<SilentPaymentMatch, 'outputKey' | 'tweak' | 'label'>): boolean {
    if (m.label !== undefined && m.label !== CHANGE_LABEL && !this.#labels.includes(m.label)) return false;
    if (!/^[0-9a-f]{64}$/.test(m.outputKey) || !/^[0-9a-f]{64}$/.test(m.tweak)) return false;
    return matchesTweak(this.spendPublicKey, hex.decode(m.tweak), hex.decode(m.outputKey));
  }

  /** The coin's private key b_spend + tweak (32 bytes). Loads the spend key behind biometrics; wipe it after use. */
  async spendingKey(m: Pick<SilentPaymentMatch, 'outputKey' | 'tweak' | 'label'>, reason = 'Move a silent payment into your vault'): Promise<Uint8Array> {
    if (!this.verify(m)) throw new WalletError('internal', 'This silent payment does not belong to this wallet.');
    const b = await this.#spendKey(reason);
    try {
      return spendingPrivateKey(b, hex.decode(m.tweak));
    } finally {
      b.fill(0);
    }
  }
}

// ---------------------------------------------------------------------------
// A local scanner (tests, or a phone that talks to the user's own full node)

/** One block with each input's previous output, like bitcoind's `getblock <hash> 3`. */
export interface ScanBlock {
  height: number;
  hash?: string;
  txs: { hex: string; prevouts: PrevoutLike[] }[];
}

export interface BlockSource {
  tipHeight(): Promise<number>;
  block(height: number): Promise<ScanBlock>;
}

/** A block from bitcoind's `getblock <hash> 3` JSON (coinbase skipped: it spends nothing). */
export function scanBlockFromBitcoind(block: {
  height: number;
  hash?: string;
  tx: { hex: string; vin: { coinbase?: string; prevout?: { scriptPubKey: { hex: string }; value?: number } }[] }[];
}): ScanBlock {
  const txs: ScanBlock['txs'] = [];
  for (const tx of block.tx) {
    if (tx.vin.some((v) => v.coinbase !== undefined)) continue;
    if (tx.vin.some((v) => !v.prevout)) throw new Error(`block ${block.height}: a transaction has no prevout (use getblock verbosity 3)`);
    txs.push({ hex: tx.hex, prevouts: tx.vin.map((v) => ({ script: v.prevout!.scriptPubKey.hex, ...(v.prevout!.value !== undefined ? { amount: Math.round(v.prevout!.value * 1e8) } : {}) })) });
  }
  return { height: block.height, ...(block.hash ? { hash: block.hash } : {}), txs };
}

/** Scans blocks it is given: computes each transaction's tweak and checks its taproot outputs. */
export class LocalSilentPaymentScanner implements SilentPaymentScanner {
  readonly #keys: SilentPaymentScanKeys;

  constructor(
    keys: SilentPaymentScanKeys,
    private readonly blocks: BlockSource,
    private readonly opts: { maxBlocks?: number } = {},
  ) {
    this.#keys = { ...keys, scanPrivateKey: keys.scanPrivateKey.slice(), labels: [...keys.labels] };
  }

  async scan(fromHeight: number): Promise<{ tipHeight: number; matches: SilentPaymentMatch[] }> {
    const tip = await this.blocks.tipHeight();
    const last = this.opts.maxBlocks ? Math.min(tip, fromHeight + this.opts.maxBlocks - 1) : tip;
    const labels = labelTable(this.#keys.scanPrivateKey, this.#keys.labels);
    const matches: SilentPaymentMatch[] = [];
    for (let h = Math.max(0, fromHeight); h <= last; h++) {
      const block = await this.blocks.block(h);
      for (const t of block.txs) {
        const tx = parseTransaction(t.hex, t.prevouts);
        const found = scanTransaction({ tx, scanPrivateKey: this.#keys.scanPrivateKey, spendPublicKey: this.#keys.spendPublicKey, labels });
        for (const m of found.matches) {
          const label = m.label === undefined ? {} : { label: m.label };
          matches.push({ txid: tx.txid, vout: m.vout, valueSats: Number(tx.outputs[m.vout]!.amount), outputKey: hex.encode(m.outputKey), tweak: hex.encode(m.tweak), height: block.height, ...label });
        }
      }
    }
    return { tipHeight: last, matches };
  }
}

// ---------------------------------------------------------------------------
// PSBTs with a helper input

export interface ForeignInput {
  index: number;
  outpoint: string;
  amount: bigint;
  script: Uint8Array;
  finalized: boolean;
}

export interface VaultInput {
  index: number;
  outpoint: string;
  amount: bigint;
  witnessScript: Uint8Array;
  pubkeys: Record<Role, Uint8Array>;
  tweaks: Tweaks;
  signedBy: Role[];
}

export interface MixedAnalysis {
  txid: string;
  vaultInputs: VaultInput[];
  foreignInputs: ForeignInput[];
  outputs: { index: number; amount: bigint; script: Uint8Array; isVault: boolean }[];
  vaultIn: bigint;
  foreignIn: bigint;
  /** Σ outputs paying the vault (with delegation tweaks proving it). */
  vaultOut: bigint;
  fee: bigint;
  /** What leaves the vault: vault inputs minus vault outputs. The helper's own value does not count either way. */
  vaultOutflow: bigint;
}

function readTweaks(proprietary: [Uint8Array, Uint8Array][] | undefined, acct: AccountPubkeys): Tweaks | undefined {
  const t = {} as Tweaks;
  for (const r of ROLES) {
    const v = findTweak(proprietary, acct[r]);
    if (v === undefined) return undefined;
    t[r] = v;
  }
  return t;
}

function checkNonWitnessUtxo(inp: ReturnType<btc.Transaction['getInput']>, i: number): void {
  if (!inp.nonWitnessUtxo) return;
  const prev = inp.nonWitnessUtxo;
  const raw = btc.RawTx.encode({ ...prev, segwitFlag: false, witnesses: undefined });
  if (hex.encode(sha256(sha256(raw)).reverse()) !== hex.encode(inp.txid!)) throw new PsbtError('non_witness_utxo_mismatch', `input ${i}: nonWitnessUtxo does not match txid`, i);
  const out = prev.outputs[inp.index!];
  if (!out || out.amount !== inp.witnessUtxo!.amount || compareBytes(out.script, inp.witnessUtxo!.script) !== 0) throw new PsbtError('non_witness_utxo_mismatch', `input ${i}: witnessUtxo does not match nonWitnessUtxo`, i);
}

/**
 * Like core's `analyzePsbt` for a PSBT whose inputs are the vault's plus inputs `allowForeign` accepts (the helper
 * coin): vault inputs are rebuilt from the delegation tweaks and their signatures checked; foreign inputs are only
 * listed. Outputs pay the vault only with tweaks that prove it, so a helper change output is never "vault change".
 */
export function analyzeMixedPsbt(
  psbt: Uint8Array,
  wallet: MultisigWallet,
  opts: { allowForeign: (input: ForeignInput) => boolean; requireNonWitnessUtxo?: boolean },
): MixedAnalysis {
  const tx = parsePsbt(psbt);
  const acct = wallet.accountPubkeys();
  const seen = new Set<string>();
  const vaultInputs: VaultInput[] = [];
  const foreignInputs: ForeignInput[] = [];
  let vaultIn = 0n;
  let foreignIn = 0n;
  for (let i = 0; i < tx.inputsLength; i++) {
    const inp = tx.getInput(i);
    if (!inp.txid || inp.index === undefined) throw new PsbtError('missing_outpoint', `input ${i}: missing outpoint`, i);
    const outpoint = `${hex.encode(inp.txid)}:${inp.index}`;
    if (seen.has(outpoint)) throw new PsbtError('duplicate_outpoint', `input ${i}: duplicate outpoint`, i);
    seen.add(outpoint);
    if (!inp.witnessUtxo) throw new PsbtError('missing_witness_utxo', `input ${i}: missing witnessUtxo`, i);
    if (inp.sighashType !== undefined && inp.sighashType !== btc.SigHash.ALL) throw new PsbtError('bad_sighash_type', `input ${i}: only SIGHASH_ALL is allowed`, i);
    if (!inp.nonWitnessUtxo && opts.requireNonWitnessUtxo) throw new PsbtError('missing_non_witness_utxo', `input ${i}: missing nonWitnessUtxo`, i);
    checkNonWitnessUtxo(inp, i);
    const tweaks = readTweaks(inp.proprietary, acct);
    const d = tweaks && delegatedScripts(acct, tweaks, wallet.network);
    if (!tweaks || !d || compareBytes(d.script, inp.witnessUtxo.script) !== 0) {
      const f: ForeignInput = { index: i, outpoint, amount: inp.witnessUtxo.amount, script: inp.witnessUtxo.script, finalized: !!(inp.finalScriptWitness?.length || inp.finalScriptSig?.length) };
      if (!opts.allowForeign(f)) throw new PsbtError('foreign_input', `input ${i}: does not belong to the wallet`, i);
      foreignInputs.push(f);
      foreignIn += f.amount;
      continue;
    }
    const msg = sighashAll(tx, i, d.witnessScript, inp.witnessUtxo.amount);
    const signedBy: Role[] = [];
    for (const [pub, sig] of inp.partialSig ?? []) {
      const role = ROLES.find((r) => compareBytes(d.pubkeys[r], pub) === 0);
      if (!role) throw new PsbtError('unknown_signer', `input ${i}: signature from an unknown key`, i);
      if (sig[sig.length - 1] !== btc.SigHash.ALL) throw new PsbtError('invalid_signature', `input ${i}: signature is not SIGHASH_ALL`, i);
      let ok = false;
      try {
        ok = secp256k1.verify(sig.slice(0, -1), msg, pub, { prehash: false, format: 'der', lowS: true });
      } catch {
        ok = false;
      }
      if (!ok) throw new PsbtError('invalid_signature', `input ${i}: invalid ${role} signature`, i);
      signedBy.push(role);
    }
    vaultIn += inp.witnessUtxo.amount;
    vaultInputs.push({ index: i, outpoint, amount: inp.witnessUtxo.amount, witnessScript: d.witnessScript, pubkeys: d.pubkeys, tweaks, signedBy });
  }
  const outputs: MixedAnalysis['outputs'] = [];
  let vaultOut = 0n;
  let totalOut = 0n;
  for (let i = 0; i < tx.outputsLength; i++) {
    const o = tx.getOutput(i);
    if (!o.script || o.amount === undefined) throw new PsbtError('incomplete_output', `output ${i}: incomplete`);
    const tweaks = readTweaks(o.proprietary, acct);
    const isVault = !!tweaks && compareBytes(delegatedScripts(acct, tweaks, wallet.network).script, o.script) === 0;
    if (isVault) vaultOut += o.amount;
    totalOut += o.amount;
    outputs.push({ index: i, amount: o.amount, script: o.script, isVault });
  }
  const fee = vaultIn + foreignIn - totalOut;
  if (fee < 0n) throw new PsbtError('outputs_exceed_inputs', 'outputs exceed inputs');
  return { txid: tx.id, vaultInputs, foreignInputs, outputs, vaultIn, foreignIn, vaultOut, fee, vaultOutflow: vaultIn - vaultOut };
}

/** The PSBT's inputs in BIP 352's sender view (vault inputs ride along; `helperKey` signs for the helper). */
export function senderInputsOf(psbt: Uint8Array, helper: { outpoint: string; privateKey: Uint8Array }) {
  const tx = parsePsbt(psbt);
  const inputs = [];
  for (let i = 0; i < tx.inputsLength; i++) {
    const inp = tx.getInput(i);
    const outpoint = `${hex.encode(inp.txid!)}:${inp.index}`;
    inputs.push({
      txid: hex.encode(inp.txid!),
      vout: inp.index!,
      prevoutScript: inp.witnessUtxo!.script,
      ...(outpoint === helper.outpoint ? { privateKey: helper.privateKey } : {}),
    });
  }
  return inputs;
}

/**
 * The silent payment output for `address`, from the inputs (vault inputs only contribute their outpoints) and the
 * helper's private key. Any `SilentPaymentError` becomes a `WalletError`.
 */
export function silentPaymentOutput(opts: {
  address: string;
  network: NetworkName;
  inputs: { txid: string; vout: number; prevoutScript: Uint8Array; privateKey?: Uint8Array }[];
}): { outputKey: Uint8Array; script: Uint8Array } {
  try {
    const r = createOutputs({ inputs: opts.inputs, recipients: [opts.address], network: opts.network });
    return { outputKey: r.outputs[0]!.outputKey, script: r.outputs[0]!.script };
  } catch (e) {
    throw asWalletError(e);
  }
}

export function asWalletError(e: unknown): unknown {
  if (!(e instanceof SilentPaymentError)) return e;
  switch (e.code) {
    case 'invalid_address':
    case 'wrong_network':
      return new WalletError('invalid_address', e.code === 'wrong_network' ? `${capitalize(e.message)}.` : 'Not a valid silent payment address.', { cause: e });
    case 'no_eligible_inputs':
      return new WalletError('silent_payment_needs_helper', 'A silent payment needs a single-key input, and this payment has none.', { cause: e });
    case 'change_label':
    case 'invalid_label':
      return new WalletError('invalid_label', e.message, { cause: e });
    default:
      return new WalletError('internal', `Silent payment: ${e.message}`, { cause: e });
  }
}

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** A decoded recipient address, checked against the wallet's network (`invalid_address` otherwise). */
export function decodeRecipient(address: string, network: NetworkName) {
  try {
    return decodeSilentPaymentAddress(address, { network });
  } catch (e) {
    throw asWalletError(e);
  }
}

/** The taproot address the hardware wallet shows for an output key (it cannot show `sp1…`). */
export function taprootAddress(outputKey: Uint8Array, network: Network): string {
  return btc.Address(network.btc).encode({ type: 'tr', pubkey: outputKey });
}

/** A taproot address of the same size as any silent payment output (for coin selection before the key is known). */
export function placeholderTaprootAddress(network: Network): string {
  return taprootAddress(secp256k1.Point.BASE.toBytes(true).slice(1), network);
}

// ---------------------------------------------------------------------------
// Sweeping a received coin

/**
 * One received coin into one vault address: a taproot key-path spend of the output key itself (silent payment
 * outputs carry no BIP 341 tweak), signed with `privateKey` (b_spend + tweak) under SIGHASH_DEFAULT.
 */
export function buildSweepTransaction(opts: {
  coin: { txid: string; vout: number; valueSats: number; outputKey: string };
  privateKey: Uint8Array;
  destination: { script: Uint8Array };
  feeSats: number;
}): { txHex: string; txid: string; amountSats: number } {
  const amountSats = opts.coin.valueSats - opts.feeSats;
  if (amountSats < DUST_SATS) throw new WalletError('amount_too_small', 'This coin is too small to move after the fee.');
  const key = hex.decode(opts.coin.outputKey);
  if (hex.encode(schnorr.getPublicKey(opts.privateKey)) !== opts.coin.outputKey) throw new WalletError('internal', 'The silent payment key does not match the coin.');
  const script = taprootScript(key);
  const tx = new btc.Transaction(TX_OPTS);
  tx.addInput({ txid: opts.coin.txid, index: opts.coin.vout, sequence: SEQUENCE_RBF, witnessUtxo: { script, amount: BigInt(opts.coin.valueSats) } });
  tx.addOutput({ script: opts.destination.script, amount: BigInt(amountSats) });
  const sighash = tx.preimageWitnessV1(0, [script], btc.SigHash.DEFAULT, [BigInt(opts.coin.valueSats)]);
  const sig = schnorr.sign(sighash, opts.privateKey);
  if (!schnorr.verify(sig, sighash, key)) throw new WalletError('internal', 'The sweep signature does not verify.');
  tx.updateInput(0, { tapKeySig: sig });
  tx.finalize();
  return { txHex: hex.encode(tx.extract()), txid: tx.id, amountSats };
}

/** A fresh helper HD account from key 2's seed (the master), with its origin for PSBTs. */
export function helperAccount(master: HDKey, network: Network): { account: HDKey; origin: { fingerprint: string; path: string } } {
  const path = helperAccountPath(network);
  return { account: master.derive(path), origin: { fingerprint: master.fingerprint.toString(16).padStart(8, '0'), path } };
}

/** BIP 32 path numbers of `m/84'/c'/1'/chain/index`. */
export function helperPathNumbers(network: Network, chain: 0 | 1, index: number): number[] {
  return [...btc.bip32Path(helperAccountPath(network)), chain, index];
}
