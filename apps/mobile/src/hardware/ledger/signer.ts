/**
 * `HardwareSigner` for a Ledger running the Bitcoin app (v2.1+), written against a small `LedgerBackend` so the logic
 * (policy conversion, PSBT merge-back, address cross-check, error mapping) is plain TypeScript. The real backend,
 * which drives the Device Management Kit over Bluetooth, is in `dmk-backend.native.ts`; tests use a fake one.
 */
import type { HardwareDeviceInfo, HardwareSigner, HardwareWalletPolicy } from '@trikey/wallet';
import type { NetworkName } from '@trikey/core';
import { HardwareError } from '../errors';
import { assertChainIndex, assertNetworkFamily, findKeyIndex, parseWalletPolicy, walletScriptsAt } from '../common/wallet';
import { coinTypeOf, formatPath, parsePath } from '../common/path';
import { normalizeXpub, xpubFamily } from '../common/xpub';
import {
  assertDeviceSignedAll,
  decodePsbtBase64,
  encodePsbtBase64,
  mergePartialSignatures,
  type PartialSignature,
} from '../common/psbt';
import { hmacToHex, toLedgerPolicy, toRegisteredLedgerWallet, type LedgerRegisteredWallet, type LedgerWalletPolicy } from './policy';
import { ledgerSignatureToBase64, type LedgerMessageSignature } from './signature';
import { mapLedgerError } from './errors';

/** The two Bitcoin apps: mainnet, and the separate "Bitcoin Test" app for testnet, signet and regtest. */
export type LedgerApp = 'Bitcoin' | 'Bitcoin Test';

export interface LedgerBackend {
  /** Makes sure `app` is the open app, asking the user to confirm on the device when it has to be opened. */
  ensureApp(app: LedgerApp): Promise<void>;
  getMasterFingerprint(): Promise<string>;
  getExtendedPublicKey(path: string): Promise<string>;
  /** Shows the policy on the device; resolves with the HMAC once the user approves. */
  registerWallet(policy: LedgerWalletPolicy): Promise<Uint8Array>;
  getWalletAddress(wallet: LedgerRegisteredWallet, change: boolean, index: number, display: boolean): Promise<string>;
  /** `psbt` is BIP174 v0 bytes; the backend (the SDK) converts to the PSBTv2 the app uses. */
  signPsbt(wallet: LedgerRegisteredWallet, psbt: Uint8Array): Promise<PartialSignature[]>;
  signMessage(path: string, message: string): Promise<LedgerMessageSignature>;
  close(): Promise<void>;
}

export function appForCoinType(coinType: number | undefined): LedgerApp {
  return coinType === 0 ? 'Bitcoin' : 'Bitcoin Test';
}

export class LedgerSigner implements HardwareSigner {
  constructor(
    readonly info: HardwareDeviceInfo,
    private readonly backend: LedgerBackend,
    private readonly opts: { network: NetworkName },
  ) {}

  /** Runs one backend call, with the Bitcoin app open and device errors mapped. */
  private async run<T>(app: LedgerApp, fn: () => Promise<T>): Promise<T> {
    try {
      await this.backend.ensureApp(app);
      return await fn();
    } catch (e) {
      throw mapLedgerError(e);
    }
  }

  private appFor(): LedgerApp {
    return this.opts.network === 'bitcoin' ? 'Bitcoin' : 'Bitcoin Test';
  }

  /** The wallet, checked: this device's key is in it, and its keys match the network we are on. */
  private checkWallet(wallet: HardwareWalletPolicy) {
    const parsed = parseWalletPolicy(wallet, 'ledger');
    assertNetworkFamily(parsed, this.opts.network, 'ledger');
    if (findKeyIndex(parsed, this.info.fingerprint) < 0)
      throw new HardwareError('invalid-request', 'This Ledger\'s key is not part of the wallet. Is it the same Ledger (and passphrase) that was set up as key 1?', { kind: 'ledger' });
    return parsed;
  }

  async getXpub(path: string): Promise<string> {
    const numbers = parsePath(path);
    if (numbers.length === 0) throw new HardwareError('invalid-request', 'Asking for the master key is not supported.', { kind: 'ledger' });
    const coinType = coinTypeOf(numbers);
    const xpub = await this.run(appForCoinType(coinType), () => this.backend.getExtendedPublicKey(formatPath(numbers)));
    const normalized = normalizeXpub(xpub);
    const expected = coinType === 0 ? 'main' : 'test';
    if (xpubFamily(normalized) !== expected)
      throw new HardwareError('invalid-response', 'The Ledger returned a key for the wrong network. Open the right Bitcoin app (Bitcoin or Bitcoin Test).', { kind: 'ledger' });
    return normalized;
  }

  async registerWallet(wallet: HardwareWalletPolicy): Promise<{ hmac?: string }> {
    this.checkWallet(wallet);
    const policy = toLedgerPolicy(wallet);
    const hmac = await this.run(this.appFor(), () => this.backend.registerWallet(policy));
    if (hmac.length !== 32) throw new HardwareError('invalid-response', 'The Ledger returned a malformed wallet registration.', { kind: 'ledger' });
    return { hmac: hmacToHex(hmac) };
  }

  async displayAddress(wallet: HardwareWalletPolicy, chain: 0 | 1, index: number): Promise<string> {
    assertChainIndex(chain, index);
    const parsed = this.checkWallet(wallet);
    const registered = toRegisteredLedgerWallet(wallet);
    const address = await this.run(this.appFor(), () => this.backend.getWalletAddress(registered, chain === 1, index, true));
    // Defence in depth: the user compares the address on the device screen, and we also compare it with the one we derive ourselves.
    const expected = walletScriptsAt(parsed, chain, index, this.opts.network).address;
    if (address !== expected)
      throw new HardwareError('invalid-response', `The Ledger shows a different address than this wallet derives (${address} instead of ${expected}). Do not use it.`, { kind: 'ledger' });
    return address;
  }

  async signPsbt(psbtBase64: string, wallet: HardwareWalletPolicy): Promise<string> {
    const original = decodePsbtBase64(psbtBase64);
    this.checkWallet(wallet);
    const registered = toRegisteredLedgerWallet(wallet);
    const signatures = await this.run(this.appFor(), () => this.backend.signPsbt(registered, original));
    if (signatures.length === 0) throw new HardwareError('invalid-response', 'The Ledger did not sign anything.', { kind: 'ledger' });
    const { psbt } = mergePartialSignatures(original, signatures);
    assertDeviceSignedAll(psbt, this.info.fingerprint);
    return encodePsbtBase64(psbt);
  }

  async signMessage(path: string, message: string): Promise<string> {
    const numbers = parsePath(path);
    if (numbers.length === 0) throw new HardwareError('invalid-request', 'A message must be signed with a key below the master key.', { kind: 'ledger' });
    if (!/^[\x20-\x7e]+$/.test(message)) throw new HardwareError('invalid-request', 'Only printable ASCII messages can be signed on the device.', { kind: 'ledger' });
    const sig = await this.run(appForCoinType(coinTypeOf(numbers)), () => this.backend.signMessage(formatPath(numbers), message));
    return ledgerSignatureToBase64(sig);
  }

  async close(): Promise<void> {
    try {
      await this.backend.close();
    } catch {
      // Closing is best effort: the link may already be gone.
    }
  }
}
