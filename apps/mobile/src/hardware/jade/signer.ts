/**
 * `HardwareSigner` for a Blockstream Jade or Jade Plus over Bluetooth (kind `jade-ble`), on Jade's RPC (`rpc.ts`). Every
 * call is one or two RPC messages; the owner approves on the Jade. What the phone checks, as for the other devices:
 *
 * - keys: the master fingerprint is computed from the root key the Jade gives (`get_xpub` with an empty path is allowed,
 *   `main/process/get_xpubs.c`), and keys must be for the wallet's network;
 * - payments: every signature the Jade adds is verified against the transaction before it is merged, and every input
 *   this Jade owns must carry its signature (`assertDeviceSignedAll`);
 * - texts: the signature must verify against the key at the path, derived from the account key the Jade gave, before
 *   anything uses it (`checkMessageAnswer`); the wallet checks it once more.
 *
 * Firmware references are to github.com/Blockstream/Jade at a59d14c (1.0.41); docs/design/hardware-auth-path.md, "Jade
 * over Bluetooth", has the whole protocol.
 */
import { base64 } from '@scure/base';
import { HDKey } from '@scure/bip32';
import { ripemd160 } from '@noble/hashes/legacy.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { jadeMessageProblem, type HardwareDeviceInfo, type HardwareSigner, type HardwareWalletPolicy, type SignMessageContext } from '@trikey/wallet';
import { getNetwork, type NetworkName } from '@trikey/core';
import { HardwareError } from '../errors';
import { HARDENED, formatPath, parsePath } from '../common/path';
import { assertDeviceSignedAll, decodePsbtBase64, encodePsbtBase64, inputsForFingerprint, mergePartialSignatures, parsePsbtBytes, signaturesFromSignedPsbt } from '../common/psbt';
import { assertChainIndex, assertNetworkFamily, findKeyIndex, parseWalletPolicy, walletScriptsAt, type ParsedWallet } from '../common/wallet';
import { decodeXpub, normalizeXpub, xpubFamily } from '../common/xpub';
import { checkMessageAnswer } from '../qr/message';
import type { JadeRpc } from './rpc';

const KIND = 'jade-ble' as const;

/** Jade's network names (firmware `main/utils/network.c`): signet and testnet are both "testnet" (the same `tb` addresses). */
export function jadeNetwork(network: NetworkName): 'mainnet' | 'testnet' | 'localtest' {
  return network === 'bitcoin' ? 'mainnet' : network === 'regtest' ? 'localtest' : 'testnet';
}

/**
 * The name the wallet is registered under on the Jade. Jade keeps it as a storage key: 1 to 15 characters from ASCII 33
 * to 126, no space (`storage_key_name_valid` in `main/storage.c`, `MAX_MULTISIG_NAME_SIZE` 16 with the NUL). Spaces
 * become "-", so "Trikey savings" is "Trikey-savings".
 */
export function jadeWalletName(name: string): string {
  const cleaned = name.replace(/[^\x21-\x7e]/g, '-').slice(0, 15);
  return cleaned.length > 0 ? cleaned : 'Trikey';
}

/** The master fingerprint of a root xpub: the first 4 bytes of HASH160 of its public key. */
export function fingerprintOfRoot(xpub: string): string {
  const d = decodeXpub(xpub);
  if (d.depth !== 0) throw new HardwareError('invalid-response', 'The Jade did not give its root key.', { kind: KIND });
  return Array.from(ripemd160(sha256(d.key)).slice(0, 4), (b) => b.toString(16).padStart(2, '0')).join('');
}

const hexToBytes = (hex: string) => Uint8Array.from(hex.match(/../g)!.map((h) => parseInt(h, 16)));

/** The `register_multisig` parameters for the 2-of-3 wallet (docs/index.rst "register_multisig"). */
export function registerMultisigParams(wallet: ParsedWallet, name: string, network: NetworkName) {
  return {
    network: jadeNetwork(network),
    multisig_name: name,
    descriptor: {
      // wsh(sortedmulti(2, ...)): `get_script_variant` in main/wallet.c; `sorted` applies BIP 67 (register_multisig.c).
      variant: 'wsh(multi(k))',
      sorted: true,
      threshold: 2,
      // Each signer: its origin fingerprint and path, its key, and no fixed path after it (the PSBT's derivations say
      // which branch and index; `get_signers_allocate` requires the field, `validate_signers` refuses hardened steps in it).
      signers: wallet.keys.map((k) => ({ fingerprint: hexToBytes(k.fingerprint), derivation: k.origin, xpub: k.xpub, path: [] as number[] })),
    },
  };
}

export class JadeSigner implements HardwareSigner {
  private readonly xpubs = new Map<string, string>();

  constructor(
    readonly info: HardwareDeviceInfo,
    private readonly rpc: JadeRpc,
    private readonly opts: { network: NetworkName; signal?: AbortSignal },
  ) {}

  private get net() {
    return jadeNetwork(this.opts.network);
  }

  private checkWallet(wallet: HardwareWalletPolicy): ParsedWallet {
    const parsed = parseWalletPolicy(wallet, KIND);
    assertNetworkFamily(parsed, this.opts.network, KIND);
    if (findKeyIndex(parsed, this.info.fingerprint) < 0)
      throw new HardwareError('invalid-request', "This Jade's key is not part of the wallet. Is it the same Jade (same recovery phrase and passphrase) that was set up as key 1?", { kind: KIND });
    return parsed;
  }

  async getXpub(path: string): Promise<string> {
    const numbers = parsePath(path);
    if (numbers.length === 0) throw new HardwareError('invalid-request', 'Asking for the master key is not supported.', { kind: KIND });
    const known = this.xpubs.get(formatPath(numbers));
    if (known) return known;
    const xpub = await this.rpc.call('get_xpub', { network: this.net, path: numbers }, { signal: this.opts.signal });
    if (typeof xpub !== 'string') throw new HardwareError('invalid-response', 'The Jade gave a key Trikey cannot read.', { kind: KIND });
    const normalized = normalizeXpub(xpub);
    if (xpubFamily(normalized) !== (this.opts.network === 'bitcoin' ? 'main' : 'test'))
      throw new HardwareError('invalid-response', 'The Jade gave a key for another network.', { kind: KIND });
    if (decodeXpub(normalized).depth !== numbers.length) throw new HardwareError('invalid-response', 'The Jade gave a key at another path.', { kind: KIND });
    this.xpubs.set(formatPath(numbers), normalized);
    return normalized;
  }

  /**
   * `register_multisig` (firmware `main/process/register_multisig.c`): the Jade checks its own key is in the wallet
   * (`validate_signers`), shows the wallet, and keeps it once the owner approves. Jade signs without it, but only with
   * it does it recognise the wallet's change as change instead of showing it as a payment (`sign_psbt.c`
   * `get_suitable_multisig_record`). Registering the same wallet again returns at once.
   */
  async registerWallet(wallet: HardwareWalletPolicy): Promise<{ hmac?: string }> {
    const parsed = this.checkWallet(wallet);
    const result = await this.rpc.call('register_multisig', registerMultisigParams(parsed, jadeWalletName(wallet.name), this.opts.network), {
      timeoutMs: null,
      signal: this.opts.signal,
    });
    if (result !== true) throw new HardwareError('invalid-response', 'The Jade did not confirm it kept the wallet.', { kind: KIND });
    return {};
  }

  /**
   * `get_receive_address { network, paths, multisig_name }` (firmware `main/process/get_receive_address.c`): the Jade
   * derives the address from the registered wallet and shows it; the phone compares it with its own.
   */
  async displayAddress(wallet: HardwareWalletPolicy, chain: 0 | 1, index: number): Promise<string> {
    assertChainIndex(chain, index);
    const parsed = this.checkWallet(wallet);
    const expected = walletScriptsAt(parsed, chain, index, this.opts.network).address;
    const address = await this.rpc.call(
      'get_receive_address',
      { network: this.net, paths: parsed.keys.map(() => [chain, index]), multisig_name: jadeWalletName(wallet.name) },
      { timeoutMs: null, signal: this.opts.signal },
    );
    if (address !== expected)
      throw new HardwareError('invalid-response', `The Jade shows a different address than this wallet derives (${String(address)} instead of ${expected}). Do not use it.`, { kind: KIND });
    return expected;
  }

  /**
   * `sign_psbt { network, psbt }` (firmware `main/process/sign_psbt.c`): the Jade shows the payment, and once the owner
   * approves sends the PSBT back with its signatures, in parts of up to 3 KiB (`get_extended_data`). Its signatures are
   * RFC 6979 with low-R grinding (`EC_FLAG_GRIND_R`, `wally_psbt_sign_input_bip32`); there is no anti-exfil on this path.
   */
  async signPsbt(psbtBase64: string, wallet: HardwareWalletPolicy): Promise<string> {
    const original = decodePsbtBase64(psbtBase64);
    this.checkWallet(wallet);
    if (inputsForFingerprint(parsePsbtBytes(original), this.info.fingerprint).length === 0)
      throw new HardwareError('invalid-request', 'None of the inputs belong to this Jade.', { kind: KIND });
    const returned = await this.rpc.callJoined('sign_psbt', { network: this.net, psbt: original }, { timeoutMs: null, signal: this.opts.signal });
    const signatures = signaturesFromSignedPsbt(original, returned);
    if (signatures.length === 0) throw new HardwareError('invalid-response', 'The Jade did not sign anything.', { kind: KIND });
    const { psbt } = mergePartialSignatures(original, signatures);
    assertDeviceSignedAll(psbt, this.info.fingerprint);
    return encodePsbtBase64(psbt);
  }

  /** The compressed public key at `path`, derived from the account key (the hardened part) the Jade gives. */
  private async pubkeyAt(path: number[]): Promise<Uint8Array> {
    let hardened = 0;
    while (hardened < path.length && path[hardened]! >= HARDENED) hardened++;
    if (hardened === 0 || hardened === path.length) throw new HardwareError('invalid-request', `Trikey can only check a message key below an account key, not ${formatPath(path)}.`, { kind: KIND });
    const xpub = await this.getXpub(formatPath(path.slice(0, hardened)));
    return HDKey.fromExtendedKey(xpub, getNetwork(this.opts.network).bip32).derive(`m/${path.slice(hardened).join('/')}`).publicKey!;
  }

  /**
   * BIP 137 with `sign_message { path, message }` (firmware `main/process/sign_message.c`), the legacy flow: no
   * `ae_host_commitment`, so the Jade signs with `wally_ec_sig_from_bytes(..., EC_FLAG_ECDSA | EC_FLAG_RECOVERABLE)`
   * (`main/wallet.c` `wallet_sign_message_hash`), libsecp256k1's RFC 6979 nonce with no extra entropy: the same text
   * gives the same signature every time, which notes and hardware unlock need. The answer is the base64 65-byte
   * signature with a P2PKH compressed header (27 + 4 + recid). It is checked against the key before it is returned.
   */
  async signMessage(path: string, message: string, _context?: SignMessageContext): Promise<string> {
    const problem = jadeMessageProblem(message);
    if (problem) throw new HardwareError('invalid-request', problem, { kind: KIND });
    const numbers = parsePath(path);
    const pubkey = await this.pubkeyAt(numbers);
    const signature = await this.rpc.call('sign_message', { path: numbers, message }, { timeoutMs: null, signal: this.opts.signal });
    if (typeof signature !== 'string') throw new HardwareError('invalid-response', 'The Jade gave a signature Trikey cannot read.', { kind: KIND });
    let raw: Uint8Array;
    try {
      raw = base64.decode(signature.trim());
    } catch {
      throw new HardwareError('invalid-response', 'The Jade gave a signature that is not base64.', { kind: KIND });
    }
    if (raw.length !== 65) throw new HardwareError('invalid-response', 'The Jade gave a signature of the wrong length.', { kind: KIND });
    if (raw[0]! < 31 || raw[0]! > 34) throw new HardwareError('invalid-response', 'The Jade gave a signature with an unexpected header.', { kind: KIND });
    try {
      return checkMessageAnswer({ signature }, { text: message, pubkey, network: this.opts.network, path, label: 'Jade' });
    } catch (e) {
      throw new HardwareError('invalid-response', e instanceof Error ? e.message : String(e), { kind: KIND, detail: e });
    }
  }

  async close(): Promise<void> {
    await this.rpc.close().catch(() => undefined);
  }
}
