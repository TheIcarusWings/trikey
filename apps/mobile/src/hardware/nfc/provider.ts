/**
 * A Coldcard (Mk4 or Q) over NFC: kind `coldcard-nfc`. The "connection" is a read of the Coldcard's multisig key export
 * (Settings › Multisig Wallets › Export XPUB, shared over NFC), which gives its master fingerprint and BIP 48 account
 * key; after that every call asks the owner to hold the phone to the Coldcard through the `NfcBridge`.
 *
 * Available where the phone has NFC and this build may use it (`NfcTransport.isSupported`). An iPhone build without the
 * NFC entitlement, or a phone without NFC, says why (`unavailableReason`), and NFC switched off is said on the sheet,
 * with a way to the settings on Android.
 */
import { isNfcModel, nfcModelInfo, type HardwareKind, type HardwareProvider, type HardwareSigner, type KnownHardware, type QrModel } from '@trikey/wallet';
import type { NetworkName } from '@trikey/core';
import { HardwareError, throwIfAborted } from '../errors';
import { HARDENED, parsePath } from '../common/path';
import type { NfcBridge } from './bridge';
import { keyExportFromNdef } from './coldcard';
import { exportSteps, NfcSigner } from './signer';

export interface NfcProviderOptions {
  network?: NetworkName;
  /** The bridge the NFC screen is mounted on (`ui/nfc-bridge-host`). */
  bridge: NfcBridge;
}

const KINDS: readonly HardwareKind[] = ['coldcard-nfc'];

export class NfcProvider implements HardwareProvider {
  readonly kinds: readonly HardwareKind[] = KINDS;

  constructor(private readonly options: NfcProviderOptions) {}

  async isAvailable(): Promise<boolean> {
    try {
      return await this.options.bridge.transport.isSupported();
    } catch {
      return false;
    }
  }

  /** Why the list shows NFC as unavailable, in words for the owner; undefined when it is available. */
  async unavailableReason(): Promise<string | undefined> {
    if (await this.isAvailable()) return undefined;
    return this.options.bridge.transport.unavailableReason ?? 'This phone has no NFC.';
  }

  /**
   * Reads the Coldcard's key export, unless the wallet says which Coldcard it expects (`known`, a device it set up): then
   * there is nothing to read, and the next step (a payment, a text) is the first tap. Every answer is checked against
   * those keys anyway: a payment must carry this fingerprint's signatures, a text must verify against the account key.
   */
  async connect(opts: { kind?: HardwareKind; signal?: AbortSignal; qrModel?: QrModel; known?: KnownHardware } = {}): Promise<HardwareSigner> {
    const kind = opts.kind ?? 'coldcard-nfc';
    if (!KINDS.includes(kind)) throw new HardwareError('invalid-request', `The NFC provider cannot connect a ${kind}.`, { kind: 'coldcard-nfc' });
    throwIfAborted(opts.signal, kind);
    const transport = this.options.bridge.transport;
    if (!(await transport.isSupported())) throw new HardwareError('unavailable', transport.unavailableReason ?? 'This phone has no NFC.', { kind });
    const model = isNfcModel(opts.qrModel) ? opts.qrModel : undefined;
    const info = nfcModelInfo(model);
    const network = this.options.network ?? 'bitcoin';
    const known = knownDevice(opts.known);
    if (known)
      return new NfcSigner(
        { kind, model: info.name, fingerprint: known.fingerprint, ...(model ? { qrModel: model } : {}) },
        { network, bridge: this.options.bridge, knownKeys: known.keys, ...(model ? { model } : {}) },
      );
    // The wallet's first account key, m/48'/<coin>'/0'/2': its export is what the wallet asks for first.
    const account = [48 + HARDENED, (network === 'bitcoin' ? 0 : 1) + HARDENED, HARDENED, 2 + HARDENED];

    const exp = await this.options.bridge.read(
      {
        purpose: 'device-key',
        title: `Connect your ${info.name}`,
        instructions: `Trikey reads your ${info.name}’s multisig public key over NFC. It holds no secret.`,
        steps: exportSteps(account, info.shareKey),
        notes: [
          model === 'coldcard-mk4'
            ? 'Hold the back of the phone flat on the Coldcard Mk4’s keypad, over the 8 key, and keep it still until the phone says it is done.'
            : model === 'coldcard-q'
              ? 'Hold the back of the phone flat on the Coldcard Q’s screen and keep it still until the phone says it is done.'
              : 'Hold the back of the phone flat on the Coldcard (a Mk4: over the 8 key; a Q: on the screen) and keep it still until the phone says it is done.',
          'NFC must be on in the Coldcard’s Settings › Hardware On/Off › NFC Sharing.',
        ],
        actionLabel: 'Read from the Coldcard',
        alert: 'Hold your phone to the Coldcard.',
        accept: (records) => keyExportFromNdef(records),
      },
      opts.signal,
    );
    return new NfcSigner(
      { kind, model: info.name, fingerprint: exp.fingerprint, ...(model ? { qrModel: model } : {}) },
      { network, bridge: this.options.bridge, knownKeys: exp.keys, ...(model ? { model } : {}) },
    );
  }
}

/** The wallet's record of the device, checked: an 8-hex fingerprint and, when given, its account key. */
function knownDevice(known: KnownHardware | undefined): { fingerprint: string; keys: { path: number[]; xpub: string }[] } | undefined {
  if (!known || !/^[0-9a-f]{8}$/.test(known.fingerprint)) return undefined;
  try {
    return { fingerprint: known.fingerprint, keys: known.account ? [{ path: parsePath(known.account.path), xpub: known.account.xpub }] : [] };
  } catch {
    return { fingerprint: known.fingerprint, keys: [] };
  }
}
