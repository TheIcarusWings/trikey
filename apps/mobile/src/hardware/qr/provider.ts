/**
 * Air-gapped devices over QR codes. The "connection" is a scan of the device's public key export, which tells us its
 * master fingerprint; after that every call shows or scans QR codes through the `QrBridge`.
 *
 * Kinds: `qr` (any UR device: Keystone, Passport, Jade, SeedSigner...), `coldcard` (BBQr, and the Coldcard multisig
 * setup file for registration) and `jade` (UR; Jade also imports the wallet descriptor).
 *
 * The model (`qrModel`, @trikey/wallet qr-devices.ts) says whether the device signs Trikey's texts and how to word its
 * steps. The owner picks it; when they pick "Other", a model the export names is used instead (`detectQrModel`).
 */
import { qrModelInfo, type HardwareKind, type HardwareProvider, type HardwareSigner, type QrModel } from '@trikey/wallet';
import { HardwareError, throwIfAborted } from '../errors';
import type { HardwareProviderOptions } from '../options';
import { defaultQrBridge } from './bridge';
import { detectQrModel, parseDeviceExport } from './export';
import { acceptFrames } from './scan';
import { QrSigner, type QrRegistrationFormat } from './signer';
import type { QrFormat } from './types';

const KINDS: readonly HardwareKind[] = ['qr', 'coldcard', 'jade'];

const LABELS: Partial<Record<HardwareKind, string>> = { coldcard: 'Coldcard', jade: 'Jade', qr: 'signing device' };
const MODELS: Partial<Record<HardwareKind, string>> = { coldcard: 'Coldcard', jade: 'Jade' };

export interface QrProviderOptions extends Pick<HardwareProviderOptions, 'network' | 'qr'> {
  /** Whether the camera can be used. The app passes `true` on phones; on web it depends on the browser. */
  cameraAvailable?: () => Promise<boolean>;
}

export class QrProvider implements HardwareProvider {
  readonly kinds: readonly HardwareKind[] = KINDS;

  constructor(private readonly options: QrProviderOptions = {}) {}

  async isAvailable(): Promise<boolean> {
    try {
      return (await this.options.cameraAvailable?.()) ?? true;
    } catch {
      return false;
    }
  }

  async connect(opts: { kind?: HardwareKind; signal?: AbortSignal; qrModel?: QrModel } = {}): Promise<HardwareSigner> {
    const kind = opts.kind ?? 'qr';
    if (!KINDS.includes(kind)) throw new HardwareError('invalid-request', `The QR provider cannot connect a ${kind}.`, { kind: 'qr' });
    throwIfAborted(opts.signal, kind);
    const picked = opts.qrModel ? qrModelInfo(opts.qrModel) : undefined;
    if (picked && !picked.qr) throw new HardwareError('not-supported', picked.whyNot ?? `The ${picked.name} can't be used with QR codes.`, { kind });
    const bridge = this.options.qr?.bridge ?? defaultQrBridge;
    const label = picked && picked.model !== 'other' ? picked.name : (LABELS[kind] ?? 'signing device');
    const format: QrFormat = this.options.qr?.format ?? (kind === 'coldcard' ? 'bbqr' : 'ur');
    const registration: QrRegistrationFormat = kind === 'coldcard' ? 'coldcard' : 'descriptor';

    const exp = await bridge.scan(
      {
        purpose: 'device-key',
        title: `Connect your ${label}`,
        instructions: `On your ${label}, show your public key as a QR code (the multisig or account export, with the master fingerprint), then point this camera at it.`,
        accept: acceptFrames((payload) => ({ ...parseDeviceExport(payload), hint: detectQrModel(payload) })),
      },
      opts.signal,
    );
    // The owner's pick wins; "Other" (or no pick) takes the model the export names, if it names one.
    const model: QrModel | undefined = opts.qrModel && opts.qrModel !== 'other' ? opts.qrModel : (exp.hint ?? opts.qrModel);
    const info = model ? qrModelInfo(model) : undefined;
    const name = info && info.model !== 'other' ? info.name : MODELS[kind];
    return new QrSigner(
      { kind, ...(name ? { model: name } : {}), fingerprint: exp.fingerprint, ...(model ? { qrModel: model } : {}) },
      { network: this.options.network ?? 'bitcoin', bridge, format, registration, label: info && info.model !== 'other' ? info.name : label, knownKeys: exp.keys, ...(model ? { model } : {}) },
    );
  }
}
