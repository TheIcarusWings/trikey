/**
 * `HardwareSigner` for a BitBox02 or BitBox02 Nova (kind `bitbox02`), on the encrypted session (session.ts). The owner
 * approves each step on the BitBox02. What the phone sends and checks, from the firmware
 * (`src/rust/bitbox02-rust/src/hww/api/bitcoin*.rs` at b27f5f68) and the official client (`bitbox-api-ts/src/internal/btc`):
 *
 * - keys: `BTCPubRequest` for the xpub at `m/48'/c'/0'/2'` (a "usual" multisig path: no warning on the device); the key
 *   must be for the wallet's network and at the path's depth;
 * - the wallet: `BTCScriptConfig.Multisig` (2 of 3, P2WSH, the three account xpubs, which one is the BitBox02's) at the
 *   account keypath; registered once (`BTCRegisterScriptConfigRequest`, after `BTCIsScriptConfigRegisteredRequest`);
 *   the BitBox02 sorts the keys itself (BIP 67, `multisig.rs` `pkscript`), so it is the same wallet as Trikey's
 *   `sortedmulti`;
 * - addresses: `BTCPubRequest` with the multisig and `display`; the answer must equal the address the phone derives;
 * - payments: the BitBox02 asks for each input twice, each input's previous transaction, and each output (`signtx.rs`);
 *   change is sent as the wallet's own (keypath and wallet), so the BitBox02 derives it and leaves it off the screen.
 *   Every signature uses anti-klepto (the phone's random nonce, the device's commitment checked against the signature),
 *   then is verified against the transaction before it is merged, and every input must carry one;
 * - texts: `BTCSignMessageRequest` with a P2WPKH script config at `m/48'/c'/0'/2'/0/0` (firmware 9.27.1 and later;
 *   "External service key", the key's `bc1q…` address, then the text). Anti-klepto too, except for notes and hardware
 *   unlock, which need the same signature every time (antiklepto.ts says why that is deterministic). The 65-byte
 *   `r || s || recid` becomes a BIP 137 signature (header 31 + recid) and must verify against the key derived from the
 *   account xpub before it is returned.
 */
import { base64 } from '@scure/base';
import { HDKey } from '@scure/bip32';
import * as btc from '@scure/btc-signer';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { bitbox02MessageProblem, type HardwareDeviceInfo, type HardwareSigner, type HardwareWalletPolicy, type SignMessageContext } from '@trikey/wallet';
import { getNetwork, type NetworkName } from '@trikey/core';
import { HardwareError } from '../errors';
import { HARDENED, formatPath, parsePath } from '../common/path';
import { assertDeviceSignedAll, decodePsbtBase64, encodePsbtBase64, inputsForFingerprint, mergePartialSignatures, parsePsbtBytes, type PartialSignature, type Tx } from '../common/psbt';
import { assertChainIndex, assertNetworkFamily, findKeyIndex, parseWalletPolicy, walletScriptsAt, type ParsedWallet } from '../common/wallet';
import { decodeXpub, normalizeXpub, xpubFamily } from '../common/xpub';
import { checkMessageAnswer } from '../qr/message';
import { hostCommitment, newHostNonce, verifyAntiKlepto } from './antiklepto';
import { BtcCoin, NextType, OutputType, Requests, SimpleType, XPubType, configWithKeypath, multisigConfig, simpleConfig, type ProtoWriter, type Response, type SignNext, type XPubFields } from './proto';
import type { BitBoxSession } from './session';

const KIND = 'bitbox02' as const;

/** The BitBox02's coin for the network: testnet and signet share TBTC (`tb` addresses), regtest is RBTC (`bcrt`). */
export function bitboxCoin(network: NetworkName): number {
  return network === 'bitcoin' ? BtcCoin.BTC : network === 'regtest' ? BtcCoin.RBTC : BtcCoin.TBTC;
}

/** The name the wallet is registered under: 1 to 30 characters, no space at either end (`util/src/name.rs`). */
export function bitboxWalletName(name: string): string {
  const cleaned = name.replace(/[^\x20-\x7e]/g, ' ').trim().slice(0, 30).trim();
  return cleaned.length > 0 ? cleaned : 'Trikey';
}

/** An xpub as the BitBox02's `XPub` message (common.proto). */
export function xpubFields(xpub: string): XPubFields {
  const d = decodeXpub(xpub);
  const fp = new Uint8Array(4);
  new DataView(fp.buffer).setUint32(0, d.parentFingerprint >>> 0, false);
  return { depth: d.depth, parentFingerprint: fp, childNum: d.childNumber >>> 0, chainCode: d.chainCode, publicKey: d.key };
}

/** The 2-of-3 as the BitBox02 sees it: the script config, the BitBox02's account keypath, and its key's index. */
export function walletConfig(wallet: ParsedWallet, fingerprint: string): { config: ProtoWriter; keypath: number[]; ourIndex: number } {
  const ourIndex = findKeyIndex(wallet, fingerprint);
  if (ourIndex < 0) throw new HardwareError('invalid-request', "This BitBox02's key is not part of the wallet. Is it the same BitBox02 (same recovery phrase and passphrase) that was set up as key 1?", { kind: KIND });
  const keypath = wallet.keys[ourIndex]!.origin;
  return { config: multisigConfig({ threshold: 2, xpubs: wallet.keys.map((k) => xpubFields(k.xpub)), ourIndex }), keypath, ourIndex };
}

const same = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i]);
const reversed = (b: Uint8Array) => b.slice().reverse();

function outputPayload(script: Uint8Array): { type: number; payload: Uint8Array } {
  let d: { type: string; hash?: Uint8Array; pubkey?: Uint8Array };
  try {
    d = btc.OutScript.decode(script) as typeof d;
  } catch {
    throw new HardwareError('not-supported', 'This payment has an output the BitBox02 cannot show.', { kind: KIND });
  }
  const need = (x: Uint8Array | undefined) => {
    if (!x) throw new HardwareError('not-supported', 'This payment has an output the BitBox02 cannot show.', { kind: KIND });
    return x;
  };
  switch (d.type) {
    case 'pkh':
      return { type: OutputType.P2PKH, payload: need(d.hash) };
    case 'sh':
      return { type: OutputType.P2SH, payload: need(d.hash) };
    case 'wpkh':
      return { type: OutputType.P2WPKH, payload: need(d.hash) };
    case 'wsh':
      return { type: OutputType.P2WSH, payload: need(d.hash) };
    case 'tr':
      return { type: OutputType.P2TR, payload: need(d.pubkey) };
    default:
      throw new HardwareError('not-supported', `This payment has an output the BitBox02 cannot show (${d.type}).`, { kind: KIND });
  }
}

/** What a payment is to the BitBox02: the transaction in its terms, plus each input's key (for the signatures). */
interface BitBoxTransaction {
  version: number;
  locktime: number;
  inputs: { prevOutHash: Uint8Array; prevOutIndex: number; prevOutValue: number; sequence: number; keypath: number[]; pubkey: Uint8Array; prevTx: PrevTx }[];
  outputs: ({ ours: true; value: number; keypath: number[]; configIndex: 0 } | { ours: false; value: number; type: number; payload: Uint8Array })[];
}

interface PrevTx {
  version: number;
  locktime: number;
  inputs: { prevOutHash: Uint8Array; prevOutIndex: number; signatureScript: Uint8Array; sequence: number }[];
  outputs: { value: number; pubkeyScript: Uint8Array }[];
}

const sats = (v: bigint) => {
  const n = Number(v);
  if (!Number.isSafeInteger(n) || n < 0) throw new HardwareError('invalid-request', 'An amount in the payment is out of range.', { kind: KIND });
  return n;
};

/**
 * The PSBT as the BitBox02's signing flow needs it. Every input must be the wallet's own (the BitBox02 signs every input
 * of a transaction, `signtx.rs`: "all inputs must be ours") and carry its previous transaction; an output is the wallet's
 * own when its derivation names this BitBox02 and its script is the wallet's at that place.
 */
export function bitboxTransaction(tx: Tx, wallet: ParsedWallet, fingerprint: string, network: NetworkName): BitBoxTransaction {
  const ours = new Map(inputsForFingerprint(tx, fingerprint).map((d) => [d.index, d]));
  const account = wallet.keys[findKeyIndex(wallet, fingerprint)]!.origin;
  const placeOf = (path: number[]): [0 | 1, number] | undefined => {
    if (path.length !== account.length + 2 || !account.every((x, i) => path[i] === x)) return undefined;
    const [chain, index] = path.slice(account.length) as [number, number];
    return chain === 0 || chain === 1 ? [chain, index] : undefined;
  };
  const inputs: BitBoxTransaction['inputs'] = [];
  for (let i = 0; i < tx.inputsLength; i++) {
    const input = tx.getInput(i);
    const d = ours.get(i);
    const place = d && placeOf(d.path);
    if (!d || !place)
      throw new HardwareError('not-supported', `Input ${i} of this payment is not a coin of this wallet: a BitBox02 signs only payments whose every coin is the wallet's.`, { kind: KIND });
    const expected = walletScriptsAt(wallet, place[0], place[1], network);
    if (!input.witnessUtxo || !same(input.witnessUtxo.script, expected.script))
      throw new HardwareError('invalid-request', `Input ${i} of this payment is not where its derivation says.`, { kind: KIND });
    const raw = input.nonWitnessUtxo;
    if (!raw || !input.txid || input.index === undefined)
      throw new HardwareError('invalid-request', `Input ${i} of this payment has no previous transaction, which the BitBox02 needs to check its amount.`, { kind: KIND });
    inputs.push({
      prevOutHash: reversed(input.txid),
      prevOutIndex: input.index,
      prevOutValue: sats(input.witnessUtxo.amount),
      sequence: input.sequence ?? 0xffffffff,
      keypath: d.path,
      pubkey: d.pubkey,
      prevTx: {
        version: raw.version,
        locktime: raw.lockTime,
        inputs: raw.inputs.map((x) => ({ prevOutHash: reversed(x.txid), prevOutIndex: x.index, signatureScript: x.finalScriptSig ?? new Uint8Array(0), sequence: x.sequence })),
        outputs: raw.outputs.map((o) => ({ value: sats(o.amount), pubkeyScript: o.script })),
      },
    });
  }
  const fp = parseInt(fingerprint, 16);
  const outputs: BitBoxTransaction['outputs'] = [];
  for (let i = 0; i < tx.outputsLength; i++) {
    const out = tx.getOutput(i);
    if (!out.script || out.amount === undefined) throw new HardwareError('invalid-request', `Output ${i} of this payment is incomplete.`, { kind: KIND });
    const derivation = out.bip32Derivation?.find(([, x]) => x.fingerprint === fp)?.[1];
    const place = derivation && placeOf(derivation.path);
    if (place && same(walletScriptsAt(wallet, place[0], place[1], network).script, out.script)) {
      outputs.push({ ours: true, value: sats(out.amount), keypath: derivation.path, configIndex: 0 });
    } else outputs.push({ ours: false, value: sats(out.amount), ...outputPayload(out.script) });
  }
  return { version: tx.version, locktime: tx.lockTime, inputs, outputs };
}

const expect = <T extends Response['type']>(r: Response, type: T, what: string): Extract<Response, { type: T }> => {
  if (r.type !== type) throw new HardwareError('invalid-response', `The BitBox02 answered ${what} with something else (${r.type}).`, { kind: KIND });
  return r as Extract<Response, { type: T }>;
};

export class BitBoxSigner implements HardwareSigner {
  private readonly xpubs = new Map<string, string>();

  constructor(
    readonly info: HardwareDeviceInfo,
    private readonly session: BitBoxSession,
    private readonly opts: { network: NetworkName; signal?: AbortSignal },
  ) {}

  private get coin() {
    return bitboxCoin(this.opts.network);
  }

  private checkWallet(wallet: HardwareWalletPolicy): ParsedWallet {
    const parsed = parseWalletPolicy(wallet, KIND);
    assertNetworkFamily(parsed, this.opts.network, KIND);
    return parsed;
  }

  private query(request: Uint8Array): Promise<Response> {
    return this.session.query(request, this.opts.signal);
  }

  async getXpub(path: string): Promise<string> {
    const numbers = parsePath(path);
    if (numbers.length === 0) throw new HardwareError('invalid-request', 'Asking for the master key is not supported.', { kind: KIND });
    const known = this.xpubs.get(formatPath(numbers));
    if (known) return known;
    const r = expect(await this.query(Requests.xpub(this.coin, numbers, this.opts.network === 'bitcoin' ? XPubType.XPUB : XPubType.TPUB, false)), 'pub', 'the key request');
    const xpub = normalizeXpub(r.pub);
    if (xpubFamily(xpub) !== (this.opts.network === 'bitcoin' ? 'main' : 'test')) throw new HardwareError('invalid-response', 'The BitBox02 gave a key for another network.', { kind: KIND });
    const d = decodeXpub(xpub);
    if (d.depth !== numbers.length || d.childNumber >>> 0 !== numbers.at(-1)) throw new HardwareError('invalid-response', 'The BitBox02 gave a key at another path.', { kind: KIND });
    this.xpubs.set(formatPath(numbers), xpub);
    return xpub;
  }

  /** Registers the wallet unless the BitBox02 already has it; the owner checks the name, "2 of 3" and the keys on it. */
  async registerWallet(wallet: HardwareWalletPolicy): Promise<{ hmac?: string }> {
    const parsed = this.checkWallet(wallet);
    const { config, keypath } = walletConfig(parsed, this.info.fingerprint);
    const known = expect(await this.query(Requests.isRegistered(this.coin, config, keypath)), 'isRegistered', 'the wallet check');
    if (known.registered) return {};
    expect(await this.query(Requests.register(this.coin, config, keypath, bitboxWalletName(wallet.name))), 'btcSuccess', 'the wallet registration');
    return {};
  }

  async displayAddress(wallet: HardwareWalletPolicy, chain: 0 | 1, index: number): Promise<string> {
    assertChainIndex(chain, index);
    if (index >= 10_000) throw new HardwareError('not-supported', 'A BitBox02 shows addresses up to number 9999 only.', { kind: KIND });
    const parsed = this.checkWallet(wallet);
    const { config, keypath } = walletConfig(parsed, this.info.fingerprint);
    const expected = walletScriptsAt(parsed, chain, index, this.opts.network).address;
    const r = expect(await this.query(Requests.address(this.coin, [...keypath, chain, index], config, true)), 'pub', 'the address request');
    if (r.pub !== expected)
      throw new HardwareError('invalid-response', `The BitBox02 shows a different address than this wallet derives (${r.pub} instead of ${expected}). Do not use it.`, { kind: KIND });
    return expected;
  }

  async signPsbt(psbtBase64: string, wallet: HardwareWalletPolicy): Promise<string> {
    const original = decodePsbtBase64(psbtBase64);
    const parsed = this.checkWallet(wallet);
    const { config, keypath: account } = walletConfig(parsed, this.info.fingerprint);
    const t = bitboxTransaction(parsePsbtBytes(original), parsed, this.info.fingerprint, this.opts.network);
    if (t.outputs.some((o) => o.ours && o.keypath.at(-1)! >= 10_000))
      throw new HardwareError('not-supported', 'The change of this payment goes to an address number the BitBox02 does not accept (9999 at most).', { kind: KIND });
    const configs = [configWithKeypath(config, account)];
    const fail = (what: string) => new HardwareError('invalid-response', `The BitBox02 ${what}.`, { kind: KIND });

    let next = this.signNext(await this.query(Requests.signInit({ coin: this.coin, configs, version: t.version, numInputs: t.inputs.length, numOutputs: t.outputs.length, locktime: t.locktime })));
    const signatures: (Uint8Array | undefined)[] = t.inputs.map(() => undefined);
    let pass2 = false;
    for (let steps = 0; ; steps++) {
      if (steps > 100_000) throw fail('kept asking without end');
      switch (next.type) {
        case NextType.INPUT: {
          // Pass 1: every input once, so the BitBox02 sums the amounts; pass 2: again, each one signed.
          const index = next.index;
          const input = t.inputs[index];
          if (!input) throw fail(`asked for input ${index}, which does not exist`);
          const nonce = pass2 ? newHostNonce() : undefined;
          next = this.signNext(await this.query(Requests.signInput({ ...input, configIndex: 0, ...(nonce ? { hostNonceCommitment: hostCommitment(nonce) } : {}) })));
          if (nonce) {
            if (next.type !== NextType.HOST_NONCE || !next.signerCommitment) throw fail('did not commit to its signature nonce (anti-klepto)');
            const commitment = next.signerCommitment;
            next = this.signNext(await this.query(Requests.antikleptoSignature(nonce)));
            if (!next.hasSignature) throw fail(`did not sign input ${index}`);
            verifyAntiKlepto(nonce, commitment, next.signature);
            signatures[index] = next.signature;
          }
          if (index === t.inputs.length - 1) pass2 = true;
          break;
        }
        case NextType.PREVTX_INIT: {
          const prev = t.inputs[next.index]?.prevTx;
          if (!prev) throw fail(`asked for the previous transaction of input ${next.index}, which does not exist`);
          next = this.signNext(await this.query(Requests.prevtxInit({ version: prev.version, numInputs: prev.inputs.length, numOutputs: prev.outputs.length, locktime: prev.locktime })));
          break;
        }
        case NextType.PREVTX_INPUT: {
          const x = t.inputs[next.index]?.prevTx.inputs[next.prevIndex];
          if (!x) throw fail('asked for a previous transaction input that does not exist');
          next = this.signNext(await this.query(Requests.prevtxInput(x)));
          break;
        }
        case NextType.PREVTX_OUTPUT: {
          const x = t.inputs[next.index]?.prevTx.outputs[next.prevIndex];
          if (!x) throw fail('asked for a previous transaction output that does not exist');
          next = this.signNext(await this.query(Requests.prevtxOutput(x)));
          break;
        }
        case NextType.OUTPUT: {
          const o = t.outputs[next.index];
          if (!o) throw fail(`asked for output ${next.index}, which does not exist`);
          next = this.signNext(await this.query(Requests.signOutput(o)));
          break;
        }
        case NextType.DONE: {
          if (signatures.some((s) => !s)) throw fail('finished without signing every input');
          const partials: PartialSignature[] = signatures.map((sig, i) => ({
            inputIndex: i,
            pubkey: t.inputs[i]!.pubkey,
            signature: new Uint8Array([...secp256k1.Signature.fromBytes(sig!, 'compact').toBytes('der'), btc.SigHash.ALL]),
          }));
          const { psbt } = mergePartialSignatures(original, partials);
          assertDeviceSignedAll(psbt, this.info.fingerprint);
          return encodePsbtBase64(psbt);
        }
        default:
          throw fail(`asked for something Trikey does not send (step ${next.type})`);
      }
    }
  }

  private signNext(r: Response): SignNext {
    return expect(r, 'signNext', 'a signing step').next;
  }

  /** The compressed public key at `path`, derived from the account key (the hardened part) the BitBox02 gives. */
  private async pubkeyAt(path: number[]): Promise<Uint8Array> {
    let hardened = 0;
    while (hardened < path.length && path[hardened]! >= HARDENED) hardened++;
    if (hardened === 0 || hardened === path.length) throw new HardwareError('invalid-request', `Trikey can only check a message key below an account key, not ${formatPath(path)}.`, { kind: KIND });
    const xpub = await this.getXpub(formatPath(path.slice(0, hardened)));
    return HDKey.fromExtendedKey(xpub, getNetwork(this.opts.network).bip32).derive(`m/${path.slice(hardened).join('/')}`).publicKey!;
  }

  async signMessage(path: string, message: string, context?: SignMessageContext): Promise<string> {
    const problem = bitbox02MessageProblem(message);
    if (problem) throw new HardwareError('invalid-request', problem, { kind: KIND });
    const numbers = parsePath(path);
    if (numbers[0] !== 48 + HARDENED) throw new HardwareError('not-supported', `A BitBox02 signs Trikey's texts only with keys under m/48', not ${formatPath(numbers)}.`, { kind: KIND });
    const pubkey = await this.pubkeyAt(numbers);
    const config = configWithKeypath(simpleConfig(SimpleType.P2WPKH), numbers);
    const msg = new TextEncoder().encode(message);
    // Notes and hardware unlock need the same signature every time: no anti-klepto (antiklepto.ts). Everything else uses it.
    const deterministic = context?.purpose === 'notes' || context?.purpose === 'unlock';
    let signature: Uint8Array;
    if (deterministic) {
      signature = expect(await this.query(Requests.signMessage(this.coin, config, msg)), 'signMessage', 'the text').signature;
    } else {
      const nonce = newHostNonce();
      const commitment = expect(await this.query(Requests.signMessage(this.coin, config, msg, hostCommitment(nonce))), 'signerCommitment', 'the text').commitment;
      signature = expect(await this.query(Requests.antikleptoSignature(nonce)), 'signMessage', 'the text').signature;
      if (signature.length === 65) verifyAntiKlepto(nonce, commitment, signature.slice(0, 64));
    }
    if (signature.length !== 65 || signature[64]! > 3) throw new HardwareError('invalid-response', 'The BitBox02 gave a signature of the wrong shape.', { kind: KIND });
    const bip137 = new Uint8Array(65);
    bip137[0] = 31 + signature[64]!;
    bip137.set(signature.subarray(0, 64), 1);
    try {
      return checkMessageAnswer({ signature: base64.encode(bip137) }, { text: message, pubkey, network: this.opts.network, path, label: 'BitBox02' });
    } catch (e) {
      throw new HardwareError('invalid-response', e instanceof Error ? e.message : String(e), { kind: KIND, detail: e });
    }
  }

  async close(): Promise<void> {
    await this.session.close().catch(() => undefined);
  }
}
