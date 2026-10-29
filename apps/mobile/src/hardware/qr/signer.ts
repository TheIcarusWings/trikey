/**
 * `HardwareSigner` for air-gapped devices (Coldcard Q, Jade, Keystone, Passport, SeedSigner...). Nothing is
 * connected: every call shows QR codes for the device to scan, and/or scans the QR codes the device shows back. The
 * screens are somebody else's job; this class only talks to a `QrBridge`.
 */
import type { HardwareDeviceInfo, HardwareKind, HardwareSigner, HardwareWalletPolicy } from '@trikey/wallet';
import type { NetworkName } from '@trikey/core';
import { HardwareError, HardwareNotSupportedError } from '../errors';
import { assertChainIndex, assertNetworkFamily, findKeyIndex, parseWalletPolicy, walletScriptsAt } from '../common/wallet';
import { coinTypeOf, formatPath, parsePath } from '../common/path';
import { xpubFamily } from '../common/xpub';
import {
  assertDeviceSignedAll,
  decodePsbtBase64,
  encodePsbtBase64,
  inputsForFingerprint,
  mergePartialSignatures,
  parsePsbtBytes,
  signaturesFromRawTransaction,
  signaturesFromSignedPsbt,
} from '../common/psbt';
import type { QrBridge } from './bridge';
import { encodeBbqr } from './bbqr';
import { findExportedKey, parseDeviceExport, type ExportedKey } from './export';
import { signedFromPayload } from './payload';
import { coldcardMultisigConfig } from './registration';
import { acceptFrames } from './scan';
import type { QrFormat } from './types';
import { encodePsbtUr } from './ur';

export type QrRegistrationFormat = 'coldcard' | 'descriptor';

export interface QrSignerOptions {
  network: NetworkName;
  bridge: QrBridge;
  format: QrFormat;
  /** How `registerWallet` shows the wallet. */
  registration: QrRegistrationFormat;
  /** Name for the instructions: "Coldcard", "Jade", or "signing device". */
  label: string;
  /** Account keys already read from the device's export while connecting. */
  knownKeys?: ExportedKey[];
  /** Used for plain frame length (UR) and QR density (BBQr). */
  maxUrFragmentLength?: number;
  maxBbqrVersion?: number;
}

/** Devices whose companion flow has no message signing over QR. They are named in the error so the UI can say so. */
export const QR_DEVICES_WITHOUT_MESSAGE_SIGNING = ['Coldcard Q', 'Jade', 'Keystone', 'Passport', 'SeedSigner'] as const;

const same = (a: readonly number[], b: readonly number[]) => a.length === b.length && a.every((n, i) => n === b[i]);

export class QrSigner implements HardwareSigner {
  private readonly keys: ExportedKey[];

  constructor(
    readonly info: HardwareDeviceInfo,
    private readonly opts: QrSignerOptions,
  ) {
    this.keys = [...(opts.knownKeys ?? [])];
  }

  private get kind(): HardwareKind {
    return this.info.kind;
  }

  private checkWallet(wallet: HardwareWalletPolicy) {
    const parsed = parseWalletPolicy(wallet, this.kind);
    assertNetworkFamily(parsed, this.opts.network, this.kind);
    if (findKeyIndex(parsed, this.info.fingerprint) < 0)
      throw new HardwareError('invalid-request', `This ${this.opts.label}'s key is not part of the wallet. Is it the same device (and passphrase) that was set up as key 1?`, { kind: this.kind });
    return parsed;
  }

  async getXpub(path: string): Promise<string> {
    const numbers = parsePath(path);
    if (numbers.length === 0) throw new HardwareError('invalid-request', 'Asking for the master key is not supported.', { kind: this.kind });
    const known = this.keys.find((k) => same(k.path, numbers));
    if (known) return known.xpub;
    const shown = formatPath(numbers);
    const exp = await this.opts.bridge.scan({
      purpose: 'device-key',
      title: `Scan the key ${shown}`,
      instructions: `On your ${this.opts.label}, show the public key for ${shown} as a QR code (the multisig or account export), then point this camera at it.`,
      accept: acceptFrames(parseDeviceExport),
    });
    if (exp.fingerprint !== this.info.fingerprint)
      throw new HardwareError('invalid-response', `That key is from a different device (master fingerprint ${exp.fingerprint}, not ${this.info.fingerprint}).`, { kind: this.kind });
    for (const k of exp.keys) if (!this.keys.some((x) => same(x.path, k.path))) this.keys.push(k);
    const key = findExportedKey(exp, numbers);
    const coinType = coinTypeOf(numbers);
    if (coinType !== undefined && xpubFamily(key.xpub) !== (coinType === 0 ? 'main' : 'test'))
      throw new HardwareError('invalid-response', 'The device exported a key for the wrong network.', { kind: this.kind });
    return key.xpub;
  }

  async registerWallet(wallet: HardwareWalletPolicy): Promise<{ hmac?: string }> {
    const parsed = this.checkWallet(wallet);
    const coldcard = this.opts.registration === 'coldcard';
    const frames = coldcard ? encodeBbqr(new TextEncoder().encode(coldcardMultisigConfig(parsed)), 'U', { maxVersion: this.opts.maxBbqrVersion }) : [wallet.descriptor];
    await this.opts.bridge.show({
      purpose: 'wallet',
      title: `Add the wallet to your ${this.opts.label}`,
      instructions: coldcard
        ? 'On the Coldcard open Settings > Multisig Wallets > Import from QR, scan this code, check the name, the keys and "2 of 3" on its screen, then approve.'
        : `On your ${this.opts.label} choose to add a multisig wallet from a QR code, scan this code, check the keys and "2 of 3" on its screen, then approve.`,
      frames,
      continueLabel: 'I have added it',
    });
    return {};
  }

  async displayAddress(wallet: HardwareWalletPolicy, chain: 0 | 1, index: number): Promise<string> {
    assertChainIndex(chain, index);
    const parsed = this.checkWallet(wallet);
    // An air-gapped device cannot be asked for the address: we derive it from the descriptor and the user compares it with the device.
    const { address } = walletScriptsAt(parsed, chain, index, this.opts.network);
    await this.opts.bridge.show({
      purpose: 'address',
      title: 'Compare the address on your device',
      instructions: `On your ${this.opts.label}, open the wallet's ${chain === 0 ? 'receive' : 'change'} address ${index} and check that it is exactly this address.`,
      frames: [address],
      detail: address,
      continueLabel: 'The addresses match',
    });
    return address;
  }

  async signPsbt(psbtBase64: string, wallet: HardwareWalletPolicy): Promise<string> {
    const original = decodePsbtBase64(psbtBase64);
    this.checkWallet(wallet);
    if (inputsForFingerprint(parsePsbtBytes(original), this.info.fingerprint).length === 0)
      throw new HardwareError('invalid-request', `None of the inputs belong to this ${this.opts.label}.`, { kind: this.kind });

    const frames = this.opts.format === 'bbqr' ? encodeBbqr(original, 'P', { maxVersion: this.opts.maxBbqrVersion }) : encodePsbtUr(original, { maxFragmentLength: this.opts.maxUrFragmentLength });
    await this.opts.bridge.show({
      purpose: 'psbt',
      title: `Sign on your ${this.opts.label}`,
      instructions: `Scan this code with your ${this.opts.label}. Check the amount and the address on its screen, sign, then scan the signed transaction it shows.`,
      frames,
      continueLabel: 'Scan the signed transaction',
    });

    const signatures = await this.opts.bridge.scan({
      purpose: 'signed-psbt',
      title: 'Scan the signed transaction',
      instructions: `Show the signed transaction on your ${this.opts.label} as a QR code and point this camera at it.`,
      // Conversion happens inside `accept`: a QR for another transaction becomes a hint and scanning goes on.
      accept: acceptFrames((payload) => {
        const signed = signedFromPayload(payload);
        return signed.kind === 'psbt' ? signaturesFromSignedPsbt(original, signed.bytes) : signaturesFromRawTransaction(original, signed.bytes);
      }),
    });
    if (signatures.length === 0) throw new HardwareError('invalid-response', `The ${this.opts.label} did not add any signature.`, { kind: this.kind });
    const { psbt } = mergePartialSignatures(original, signatures);
    assertDeviceSignedAll(psbt, this.info.fingerprint);
    return encodePsbtBase64(psbt);
  }

  async signMessage(): Promise<string> {
    throw new HardwareNotSupportedError(
      'signMessage',
      'Signing a message over QR is not supported. Approvals that loosen the guardian rules need a device that can sign a message over USB or Bluetooth (Ledger, Trezor) or from a file.',
      { kind: this.kind, devices: QR_DEVICES_WITHOUT_MESSAGE_SIGNING },
    );
  }

  async close(): Promise<void> {
    // Nothing is connected. If a QR sheet is still up, the host closes it.
  }
}

