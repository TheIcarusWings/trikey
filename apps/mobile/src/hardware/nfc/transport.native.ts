/**
 * The phone's NFC reader on iOS and Android, through react-native-nfc-manager (Android's `android.nfc` and iOS's Core
 * NFC; no Google code: the FOSS Android build keeps it, see android-variant.js).
 *
 * - Android: the NFC permission and `android.hardware.nfc` (not required, so phones without NFC still install the app)
 *   come from the library's manifest. Reader mode for NFC-V (the Coldcard is an ISO 15693 tag), so Android does not
 *   offer the tag to other apps while Trikey waits for it.
 * - iOS: Core NFC needs the "NFC Tag Reading" entitlement and NFCReaderUsageDescription, which a build gets only with
 *   TRIKEY_IOS_NFC=1 (app.config.ts, plugins/with-ios-nfc.js; a free Apple developer account cannot sign it). Without it the
 *   library is not linked at all (react-native.config.js) and this file never loads it: NFC reads as unavailable, with
 *   the reason, and the app offers QR codes instead.
 *
 * The library is loaded on first use: its module throws at import when the native side is not linked.
 */
import Constants from 'expo-constants';
import { Platform } from 'react-native';
import type { NdefRecord as LibNdefRecord, NfcManager as LibNfcManager } from 'react-native-nfc-manager';
import { HardwareError } from '../errors';
import type { NdefRecord } from './ndef';
import { noNfc, type NfcTransport } from './transport';

type Lib = typeof import('react-native-nfc-manager');

/** This iOS build was made with the NFC entitlement (TRIKEY_IOS_NFC=1, app.config.ts writes `extra.iosNfc`). */
export function iosNfcBuilt(extra: Record<string, unknown> | undefined = Constants.expoConfig?.extra): boolean {
  return extra?.iosNfc === true;
}

const IOS_UNAVAILABLE =
  'This iPhone build of Trikey has no NFC: Apple allows NFC only in apps signed with a paid developer account (the "NFC Tag Reading" capability). Use a Coldcard Q by QR code, or a build made with TRIKEY_IOS_NFC=1.';

/** `id` and `type` come as a byte array, or on Android as a string. */
function bytesOf(v: number[] | string | undefined): Uint8Array {
  if (v === undefined) return new Uint8Array();
  if (typeof v === 'string') return Uint8Array.from(v, (c) => c.charCodeAt(0) & 0xff);
  return Uint8Array.from(v);
}

function fromLib(r: LibNdefRecord): NdefRecord {
  const id = r.id === undefined || (Array.isArray(r.id) && r.id.length === 0) || r.id === '' ? undefined : bytesOf(r.id);
  return { tnf: r.tnf, type: bytesOf(r.type), payload: Uint8Array.from(r.payload ?? []), ...(id ? { id } : {}) };
}

class NativeNfcTransport implements NfcTransport {
  readonly systemSheet = Platform.OS === 'ios';
  private lib?: Lib;
  private started?: Promise<void>;

  private load(): Lib {
    this.lib ??= require('react-native-nfc-manager') as Lib;
    return this.lib;
  }

  private get manager(): LibNfcManager {
    return this.load().default;
  }

  private start(): Promise<void> {
    this.started ??= this.manager.start().catch((e: unknown) => {
      this.started = undefined;
      throw e;
    });
    return this.started;
  }

  async isSupported(): Promise<boolean> {
    try {
      return await this.manager.isSupported();
    } catch {
      return false;
    }
  }

  async isEnabled(): Promise<boolean> {
    try {
      await this.start();
      return await this.manager.isEnabled();
    } catch {
      return false;
    }
  }

  /** The library's error as a `HardwareError` the screens can word. */
  private mapError(e: unknown, signal?: AbortSignal): HardwareError {
    if (e instanceof HardwareError) return e;
    const { NfcError } = this.load();
    if (signal?.aborted || e instanceof NfcError.UserCancel) return new HardwareError('cancelled', 'Cancelled.', { kind: 'coldcard-nfc', detail: e });
    if (e instanceof NfcError.Timeout || e instanceof NfcError.SessionInvalidated)
      return new HardwareError('timeout', 'The phone stopped waiting for the Coldcard. Try again, and hold the phone against it within a minute.', { kind: 'coldcard-nfc', detail: e });
    if (e instanceof NfcError.RadioDisabled) return new HardwareError('unavailable', 'NFC is turned off on this phone. Turn it on, then try again.', { kind: 'coldcard-nfc', detail: e });
    if (e instanceof NfcError.TagNotWritable)
      return new HardwareError('device-error', 'The Coldcard is not waiting for data. On the Coldcard open the NFC menu named in the steps first, then hold the phone to it.', { kind: 'coldcard-nfc', detail: e });
    if (e instanceof NfcError.TagSizeTooSmall) return new HardwareError('invalid-request', 'That is too large for the Coldcard over NFC.', { kind: 'coldcard-nfc', detail: e });
    if (e instanceof NfcError.TagConnectionLost || e instanceof NfcError.TagResponseError || e instanceof NfcError.TagUpdateFailure)
      return new HardwareError('disconnected', 'The phone lost the Coldcard. Hold the phone still against it until it is done, then try again.', { kind: 'coldcard-nfc', detail: e });
    return new HardwareError('device-error', `NFC failed: ${e instanceof Error && e.message ? e.message : String(e)}`, { kind: 'coldcard-nfc', detail: e });
  }

  /** Waits for a tag (the request), runs `op` on it, and always ends the request. */
  private async session<T>(alert: string, signal: AbortSignal | undefined, op: (m: LibNfcManager) => Promise<T>): Promise<T> {
    if (signal?.aborted) throw new HardwareError('cancelled', 'Cancelled.', { kind: 'coldcard-nfc' });
    await this.start();
    const m = this.manager;
    const { NfcTech, NfcAdapter } = this.load();
    const onAbort = () => void m.cancelTechnologyRequest().catch(() => {});
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      await m.requestTechnology(NfcTech.Ndef, {
        alertMessage: alert,
        invalidateAfterFirstRead: false,
        // Android: reader mode, NFC-V only (the Coldcard's ST25DV), so no other app is offered the tag meanwhile.
        isReaderModeEnabled: true,
        readerModeFlags: NfcAdapter.FLAG_READER_NFC_V,
      });
      const out = await op(m);
      if (this.systemSheet) await m.setAlertMessageIOS('Done').catch(() => {});
      return out;
    } catch (e) {
      throw this.mapError(e, signal);
    } finally {
      signal?.removeEventListener('abort', onAbort);
      await m.cancelTechnologyRequest().catch(() => {});
    }
  }

  write(message: Uint8Array, opts: { alert: string; signal?: AbortSignal }): Promise<void> {
    return this.session(opts.alert, opts.signal, (m) => m.ndefHandler.writeNdefMessage(Array.from(message)));
  }

  read(opts: { alert: string; signal?: AbortSignal }): Promise<NdefRecord[]> {
    return this.session(opts.alert, opts.signal, async (m) => {
      const tag = await m.ndefHandler.getNdefMessage();
      const records = tag?.ndefMessage ?? [];
      if (records.length === 0)
        throw new HardwareError('invalid-response', 'The Coldcard is not sharing anything yet. Choose to share over NFC on the Coldcard first, then hold the phone to it.', { kind: 'coldcard-nfc' });
      return records.map(fromLib);
    });
  }

  async cancel(): Promise<void> {
    if (!this.lib) return;
    await this.manager.cancelTechnologyRequest().catch(() => {});
  }

  async openSettings(): Promise<boolean> {
    if (Platform.OS !== 'android') return false;
    try {
      return await this.manager.goToNfcSetting();
    } catch {
      return false;
    }
  }
}

let shared: NfcTransport | undefined;

/** The phone's NFC: the real one on Android and on an iOS build with the NFC entitlement, none elsewhere. */
export function defaultNfcTransport(): NfcTransport {
  if (Platform.OS === 'ios' && !iosNfcBuilt()) return { ...noNfc, unavailableReason: IOS_UNAVAILABLE };
  if (Platform.OS !== 'ios' && Platform.OS !== 'android') return noNfc;
  shared ??= new NativeNfcTransport();
  return shared;
}

export { noNfc };
