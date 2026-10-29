/**
 * Our BIP174 v0 multisig PSBT <-> Trezor Connect's `signTransaction` format. Pure functions, no I/O.
 *
 * Trezor does not take PSBTs. For `wsh(sortedmulti(2,...))` it needs, per input, the full previous transaction
 * (`refTxs`), the amount, the Trezor's own key path (`address_n`) and a `multisig` structure that lists all three
 * account xpubs with the `[chain, index]` suffix, `m = 2` and an empty signature slot per cosigner. A change output is
 * sent the same way (`address_n` plus `multisig`) so the device recognises it as ours and does not ask the user to
 * confirm it as a payment.
 *
 * Before anything is sent, every input and output is checked against the wallet descriptor: the keys the PSBT says
 * it spends must derive to the script it claims. The Trezor firmware checks too; we refuse earlier and in plain words.
 */
import * as btc from '@scure/btc-signer';
import { hex } from '@scure/base';
import { sha256 } from '@noble/hashes/sha2.js';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { NETWORKS, compareBytes, type NetworkName } from '@trikey/core';
import { HardwareError } from '../errors';
import { formatPath } from '../common/path';
import { mergePartialSignatures, parsePsbtBytes, type PartialSignature, type Tx } from '../common/psbt';
import { assertNetworkFamily, deriveWalletPubkeys, findKeyIndex, walletScriptsAt, type ParsedWallet } from '../common/wallet';
import type { TrezorCoin, TrezorInput, TrezorMultisig, TrezorOutput, TrezorRefTx, TrezorSignTransactionParams } from './types';

export function coinForNetwork(network: NetworkName): TrezorCoin {
  switch (network) {
    case 'bitcoin':
      return 'btc';
    case 'regtest':
      return 'regtest';
    default:
      // Signet shares Bitcoin Testnet's coin definition on Trezor (same version bytes, same bech32 prefix).
      return 'test';
  }
}

const err = (message: string) => new HardwareError('invalid-request', message, { kind: 'trezor' });

/** The `multisig` structure for the address at (chain, index): three xpubs plus suffix, in BIP67 order. */
export function multisigAt(wallet: ParsedWallet, chain: number, index: number): TrezorMultisig {
  const pubkeys = deriveWalletPubkeys(wallet, chain, index);
  const entries = wallet.keys.map((k, i) => ({ node: k.xpub, address_n: [chain, index], pub: pubkeys[i]! }));
  // The script is sortedmulti, so we list the keys in the order they appear in the script and also say so with
  // `pubkeys_order`; the device sorts again, which changes nothing.
  entries.sort((a, b) => compareBytes(a.pub, b.pub));
  return { pubkeys: entries.map(({ node, address_n }) => ({ node, address_n })), signatures: wallet.keys.map(() => ''), m: 2, pubkeys_order: 1 };
}

/** The Trezor's own key path for the address at (chain, index): account origin, then chain and index. */
export function devicePathAt(wallet: ParsedWallet, deviceKey: number, chain: number, index: number): number[] {
  const origin = wallet.keys[deviceKey]!.origin;
  if (origin.length === 0) throw err("This device's key has no derivation origin in the wallet descriptor.");
  return [...origin, chain, index];
}

function samePath(a: readonly number[], b: readonly number[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

const txidOf = (prev: NonNullable<ReturnType<Tx['getInput']>['nonWitnessUtxo']>): string => {
  const raw = btc.RawTx.encode({ ...prev, segwitFlag: false, witnesses: undefined });
  return hex.encode(sha256(sha256(raw)).reverse());
};

function refTxFor(prev: NonNullable<ReturnType<Tx['getInput']>['nonWitnessUtxo']>): TrezorRefTx {
  return {
    hash: txidOf(prev),
    version: prev.version,
    lock_time: prev.lockTime,
    inputs: prev.inputs.map((i) => ({ prev_hash: hex.encode(i.txid), prev_index: i.index, script_sig: hex.encode(i.finalScriptSig ?? new Uint8Array()), sequence: i.sequence ?? 0xffffffff })),
    bin_outputs: prev.outputs.map((o) => ({ amount: o.amount.toString(), script_pubkey: hex.encode(o.script) })),
  };
}

export interface TrezorSigningPlan {
  params: TrezorSignTransactionParams;
  /** The Trezor's public key for each input, to attach the returned signatures to. */
  signerPubkeys: Uint8Array[];
}

export function psbtToTrezorRequest(psbt: Uint8Array, wallet: ParsedWallet, deviceFingerprint: string, network: NetworkName): TrezorSigningPlan {
  assertNetworkFamily(wallet, network, 'trezor');
  const deviceKey = findKeyIndex(wallet, deviceFingerprint);
  if (deviceKey < 0) throw err("This Trezor's key is not part of the wallet.");
  const fp = parseInt(deviceFingerprint, 16);
  const tx = parsePsbtBytes(psbt);
  if (tx.inputsLength === 0 || tx.outputsLength === 0) throw err('The transaction has no inputs or no outputs.');
  const net = NETWORKS[network];

  const inputs: TrezorInput[] = [];
  const refTxs: TrezorRefTx[] = [];
  const signerPubkeys: Uint8Array[] = [];

  for (let i = 0; i < tx.inputsLength; i++) {
    const inp = tx.getInput(i);
    const at = `Input ${i}`;
    if (!inp.txid || inp.index === undefined) throw err(`${at} has no outpoint.`);
    if (!inp.witnessUtxo || !inp.witnessScript) throw err(`${at} is missing its witness data.`);
    if (inp.sighashType !== undefined && inp.sighashType !== btc.SigHash.ALL) throw err(`${at} asks for a sighash type other than SIGHASH_ALL.`);
    if (!inp.nonWitnessUtxo) throw err(`${at} has no previous transaction. The Trezor needs the full previous transaction of every input.`);
    const entry = inp.bip32Derivation?.find(([, d]) => d.fingerprint === fp);
    if (!entry) throw err(`${at} has no key path for this Trezor.`);
    const path = entry[1].path;
    if (path.length < 3) throw err(`${at} has an unexpected key path.`);
    const chain = path[path.length - 2]!;
    const index = path[path.length - 1]!;
    if (chain !== 0 && chain !== 1) throw err(`${at} uses an address chain other than 0 or 1.`);
    const expectedPath = devicePathAt(wallet, deviceKey, chain, index);
    if (!samePath(path, expectedPath)) throw err(`${at} has the key path ${formatPath(path)}, but this wallet uses ${formatPath(expectedPath)}.`);

    // The keys of the wallet must derive to the script the input claims to spend.
    const scripts = walletScriptsAt(wallet, chain, index, network);
    if (compareBytes(scripts.witnessScript, inp.witnessScript) !== 0 || compareBytes(scripts.script, inp.witnessUtxo.script) !== 0)
      throw err(`${at} does not belong to this wallet.`);
    if (compareBytes(scripts.pubkeys[deviceKey]!, entry[0]) !== 0) throw err(`${at} lists a different key for this Trezor than the wallet derives.`);

    const prevTxid = hex.encode(inp.txid);
    const ref = refTxFor(inp.nonWitnessUtxo);
    if (ref.hash !== prevTxid) throw err(`${at}: the previous transaction does not match the outpoint.`);
    const prevOut = inp.nonWitnessUtxo.outputs[inp.index];
    if (!prevOut || prevOut.amount !== inp.witnessUtxo.amount || compareBytes(prevOut.script, inp.witnessUtxo.script) !== 0)
      throw err(`${at}: the previous transaction does not match the amount and script of the input.`);
    if (!refTxs.some((r) => r.hash === ref.hash)) refTxs.push(ref);

    inputs.push({
      prev_hash: prevTxid,
      prev_index: inp.index,
      amount: inp.witnessUtxo.amount.toString(),
      sequence: inp.sequence ?? 0xffffffff,
      script_type: 'SPENDWITNESS',
      address_n: path,
      multisig: multisigAt(wallet, chain, index),
    });
    signerPubkeys.push(entry[0]);
  }

  const outputs: TrezorOutput[] = [];
  for (let i = 0; i < tx.outputsLength; i++) {
    const out = tx.getOutput(i);
    const at = `Output ${i}`;
    if (!out.script || out.amount === undefined) throw err(`${at} is incomplete.`);
    // Change: it carries our key path, sits on the change chain and derives to the script it pays to.
    const entry = out.bip32Derivation?.find(([, d]) => d.fingerprint === fp);
    if (entry && entry[1].path.length >= 3) {
      const path = entry[1].path;
      const chain = path[path.length - 2]!;
      const index = path[path.length - 1]!;
      if (chain === 1 && samePath(path, devicePathAt(wallet, deviceKey, chain, index))) {
        const scripts = walletScriptsAt(wallet, chain, index, network);
        if (compareBytes(scripts.script, out.script) === 0 && compareBytes(scripts.pubkeys[deviceKey]!, entry[0]) === 0) {
          outputs.push({ address_n: path, amount: out.amount.toString(), script_type: 'PAYTOWITNESS', multisig: multisigAt(wallet, chain, index) });
          continue;
        }
      }
      // A claim of ownership that does not hold up is not an error: the output is shown to the user as a payment.
    }
    let address: string;
    try {
      address = btc.Address(net.btc).encode(btc.OutScript.decode(out.script));
    } catch {
      throw err(`${at} pays to a script the Trezor cannot show as an address.`);
    }
    outputs.push({ address, amount: out.amount.toString(), script_type: 'PAYTOADDRESS' });
  }

  return {
    params: { coin: coinForNetwork(network), inputs, outputs, refTxs, version: tx.version, locktime: tx.lockTime, serialize: false, push: false },
    signerPubkeys,
  };
}

/** A DER signature from whatever the Trezor returned: DER hex, DER with a sighash byte, or 64-byte compact. */
export function trezorSignatureToDer(signatureHex: string): Uint8Array {
  let raw: Uint8Array;
  try {
    raw = hex.decode(signatureHex.replace(/^0x/i, '').toLowerCase());
  } catch {
    throw new HardwareError('invalid-response', 'The Trezor returned a malformed signature.', { kind: 'trezor' });
  }
  // DER is 0x30 <len> ...; one extra trailing byte is a sighash byte.
  if (raw[0] === 0x30 && raw.length === (raw[1] ?? 0) + 2) return raw;
  if (raw[0] === 0x30 && raw.length === (raw[1] ?? 0) + 3) return raw.slice(0, -1);
  if (raw.length === 64) return secp256k1.Signature.fromBytes(raw, 'compact').toBytes('der');
  throw new HardwareError('invalid-response', 'The Trezor returned a signature in an unknown format.', { kind: 'trezor' });
}

/** Puts the signatures `signTransaction` returned into the original PSBT, after checking each one. */
export function mergeTrezorSignatures(psbt: Uint8Array, plan: TrezorSigningPlan, signatures: readonly string[]): Uint8Array {
  if (signatures.length !== plan.signerPubkeys.length)
    throw new HardwareError('invalid-response', `The Trezor returned ${signatures.length} signatures for ${plan.signerPubkeys.length} inputs.`, { kind: 'trezor' });
  const partial: PartialSignature[] = signatures.map((s, inputIndex) => {
    if (!s) throw new HardwareError('invalid-response', `The Trezor did not sign input ${inputIndex}.`, { kind: 'trezor' });
    return { inputIndex, pubkey: plan.signerPubkeys[inputIndex]!, signature: new Uint8Array([...trezorSignatureToDer(s), btc.SigHash.ALL]) };
  });
  return mergePartialSignatures(psbt, partial).psbt;
}
