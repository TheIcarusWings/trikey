/**
 * `HardwareSigner` for a Trezor, written against `TrezorConnectLike` (the real one is `@trezor/connect-mobile`, which
 * hands every call to Trezor Suite Lite through a deep link and waits for it to come back).
 */
import { base64 } from '@scure/base';
import type { HardwareDeviceInfo, HardwareSigner, HardwareWalletPolicy } from '@trikey/wallet';
import type { NetworkName } from '@trikey/core';
import { HardwareError } from '../errors';
import { assertChainIndex, assertNetworkFamily, findKeyIndex, parseWalletPolicy, walletScriptsAt, type ParsedWallet } from '../common/wallet';
import { coinTypeOf, formatPath, parsePath } from '../common/path';
import { normalizeXpub, xpubFamily } from '../common/xpub';
import { assertDeviceSignedAll, decodePsbtBase64, encodePsbtBase64 } from '../common/psbt';
import { coinForNetwork, devicePathAt, mergeTrezorSignatures, multisigAt, psbtToTrezorRequest } from './convert';
import { TREZOR_CANCEL_REASONS, mapTrezorError, trezorFailure } from './errors';
import type { TrezorCoin, TrezorConnectLike, TrezorResponse } from './types';

export class TrezorSigner implements HardwareSigner {
  /** Suite Lite handles one request at a time; calls are queued so two screens cannot interleave deep links. */
  private queue: Promise<unknown> = Promise.resolve();
  private readonly xpubs = new Map<string, string>();

  constructor(
    readonly info: HardwareDeviceInfo,
    private readonly connect: TrezorConnectLike,
    private readonly opts: { network: NetworkName; /** Account keys already fetched while connecting. */ knownXpubs?: Record<string, string> },
  ) {
    for (const [path, xpub] of Object.entries(opts.knownXpubs ?? {})) this.xpubs.set(path, xpub);
  }

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async call<T>(fn: () => Promise<TrezorResponse<T>>): Promise<T> {
    return this.enqueue(async () => {
      let res: TrezorResponse<T>;
      try {
        res = await fn();
      } catch (e) {
        throw mapTrezorError(e);
      }
      if (res.success !== true) throw mapTrezorError(trezorFailure(res));
      return res.payload;
    });
  }

  /** The Trezor coin for a SLIP-44 coin type in a path. Test coin types follow the app's network (testnet, signet or regtest). */
  private coinFor(coinType: number | undefined): TrezorCoin {
    if (coinType === 0) return 'btc';
    if (coinType === 1) return this.opts.network === 'bitcoin' ? 'test' : coinForNetwork(this.opts.network);
    throw new HardwareError('invalid-request', 'Only Bitcoin (coin type 0) and test networks (coin type 1) are supported.', { kind: 'trezor' });
  }

  private checkWallet(wallet: HardwareWalletPolicy): { parsed: ParsedWallet; deviceKey: number } {
    const parsed = parseWalletPolicy(wallet, 'trezor');
    assertNetworkFamily(parsed, this.opts.network, 'trezor');
    const deviceKey = findKeyIndex(parsed, this.info.fingerprint);
    if (deviceKey < 0) throw new HardwareError('invalid-request', "This Trezor's key is not part of the wallet. Is it the same Trezor (and passphrase) that was set up as key 1?", { kind: 'trezor' });
    return { parsed, deviceKey };
  }

  async getXpub(path: string): Promise<string> {
    const numbers = parsePath(path);
    if (numbers.length === 0) throw new HardwareError('invalid-request', 'Asking for the master key is not supported.', { kind: 'trezor' });
    const coinType = coinTypeOf(numbers);
    const coin = this.coinFor(coinType);
    const key = formatPath(numbers);
    const cached = this.xpubs.get(key);
    if (cached) return cached;
    const res = await this.call(() => this.connect.getPublicKey({ path: key, coin, showOnTrezor: false }));
    if (res.path.length !== numbers.length || res.path.some((n, i) => n !== numbers[i]))
      throw new HardwareError('invalid-response', 'The Trezor returned the key for a different path.', { kind: 'trezor' });
    const xpub = normalizeXpub(res.xpub);
    if (xpubFamily(xpub) !== (coinType === 0 ? 'main' : 'test')) throw new HardwareError('invalid-response', 'The Trezor returned a key for the wrong network.', { kind: 'trezor' });
    this.xpubs.set(key, xpub);
    return xpub;
  }

  /** Trezor needs no registration: the wallet is described in every request. */
  async registerWallet(wallet: HardwareWalletPolicy): Promise<{ hmac?: string }> {
    this.checkWallet(wallet);
    return {};
  }

  async displayAddress(wallet: HardwareWalletPolicy, chain: 0 | 1, index: number): Promise<string> {
    assertChainIndex(chain, index);
    const { parsed, deviceKey } = this.checkWallet(wallet);
    const coin = coinForNetwork(this.opts.network);
    const res = await this.call(() =>
      this.connect.getAddress({
        path: devicePathAt(parsed, deviceKey, chain, index),
        coin,
        scriptType: 'SPENDWITNESS',
        multisig: multisigAt(parsed, chain, index),
        showOnTrezor: true,
      }),
    );
    const expected = walletScriptsAt(parsed, chain, index, this.opts.network).address;
    if (res.address !== expected)
      throw new HardwareError('invalid-response', `The Trezor shows a different address than this wallet derives (${res.address} instead of ${expected}). Do not use it.`, { kind: 'trezor' });
    return res.address;
  }

  async signPsbt(psbtBase64: string, wallet: HardwareWalletPolicy): Promise<string> {
    const original = decodePsbtBase64(psbtBase64);
    const { parsed } = this.checkWallet(wallet);
    const plan = psbtToTrezorRequest(original, parsed, this.info.fingerprint, this.opts.network);
    const res = await this.call(() => this.connect.signTransaction(plan.params));
    const merged = mergeTrezorSignatures(original, plan, res.signatures);
    assertDeviceSignedAll(merged, this.info.fingerprint);
    return encodePsbtBase64(merged);
  }

  async signMessage(path: string, message: string): Promise<string> {
    const numbers = parsePath(path);
    if (numbers.length === 0) throw new HardwareError('invalid-request', 'A message must be signed with a key below the master key.', { kind: 'trezor' });
    if (!/^[\x20-\x7e]+$/.test(message)) throw new HardwareError('invalid-request', 'Only printable ASCII messages can be signed on the device.', { kind: 'trezor' });
    const coin = this.coinFor(coinTypeOf(numbers));
    // SPENDWITNESS, said explicitly: what Connect would infer for our auth key's BIP48 path anyway, and the one script
    // type firmware 2.13.0+ signs at that path without an unusual-path warning (docs/design/hardware-auth-path.md).
    const res = await this.call(() => this.connect.signMessage({ path: formatPath(numbers), coin, message, scriptType: 'SPENDWITNESS' }));
    let bytes: Uint8Array;
    try {
      bytes = base64.decode(res.signature);
    } catch {
      throw new HardwareError('invalid-response', 'The Trezor returned a malformed signature.', { kind: 'trezor' });
    }
    if (bytes.length !== 65 || bytes[0]! < 27 || bytes[0]! > 42) throw new HardwareError('invalid-response', 'The Trezor returned a signature that is not in BIP137 format.', { kind: 'trezor' });
    return base64.encode(bytes);
  }

  async close(): Promise<void> {
    try {
      this.connect.cancel?.(TREZOR_CANCEL_REASONS.closed);
    } catch {
      // Best effort.
    }
  }
}
