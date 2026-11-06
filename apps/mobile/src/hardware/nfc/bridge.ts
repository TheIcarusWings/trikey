/**
 * The meeting point between the NFC signer (plain logic, no UI) and the screen, like the QR bridge (`../qr/bridge.ts`).
 *
 * The signer asks the bridge to *write* an NDEF message to the Coldcard ("sign this payment"), to *read* what the
 * Coldcard shares ("the signed payment"), or to *show* something the owner checks on the device (an address). Whatever
 * mounts `NfcBridgeHost` (ui/nfc-bridge-host.tsx) shows the request with its steps; when the owner taps the button the
 * host calls `tap()`, and the bridge holds the phone to the tag through its `NfcTransport`. A failed tap (NFC off, the
 * phone moved away, the wrong thing shared) leaves the request on screen with a hint, so the owner can fix it on the
 * device and tap again. Only one request is active at a time; others wait their turn.
 */
import { HardwareError } from '../errors';
import type { NdefRecord } from './ndef';
import type { NfcTransport } from './transport';

interface NfcRequestBase {
  title: string;
  instructions: string;
  /** Numbered steps on the device. */
  steps?: string[];
  /** Short notes after the steps (what the text means, what to check on the device). */
  notes?: string[];
  /** Text to show in monospace for the owner to compare (the text to sign, an address). */
  detail?: string;
}

export interface NfcWriteRequest extends NfcRequestBase {
  type: 'write';
  /** `wallet`: the multisig setup file; `psbt`: a payment to sign; `message`: a text to sign. */
  purpose: 'wallet' | 'psbt' | 'message';
  /** The encoded NDEF message. */
  message: Uint8Array;
  /** The button that starts the tap ("Send to the Coldcard"). */
  actionLabel: string;
  /** What iOS's own NFC sheet says while it waits. */
  alert: string;
}

export interface NfcReadRequest<T = unknown> extends NfcRequestBase {
  type: 'read';
  purpose: 'device-key' | 'signed-psbt' | 'signed-message';
  actionLabel: string;
  alert: string;
  /** Turns what was read into the answer. Throwing keeps the request on screen with the error as a hint. */
  accept(records: NdefRecord[]): T;
}

export interface NfcShowRequest extends NfcRequestBase {
  type: 'show';
  /** `address`: compare an address on the device; `wallet`: approve the wallet the Coldcard just read. */
  purpose: 'address' | 'wallet';
  continueLabel: string;
}

export type NfcRequest = NfcWriteRequest | NfcReadRequest | NfcShowRequest;

/** What the screen shows besides the request: a tap in progress, the hint after a failed tap, NFC switched off. */
export interface NfcTapState {
  busy?: boolean;
  hint?: string;
  /** NFC is switched off: the screen offers the phone's NFC settings. */
  nfcOff?: boolean;
}

interface Active {
  request: NfcRequest;
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
  state: NfcTapState;
  /** Stops the tap in progress (Cancel, or the caller's signal). */
  tapAbort?: AbortController;
}

export class NfcBridge {
  private active?: Active;
  private queue: Array<() => void> = [];
  private listeners = new Set<() => void>();
  private version = 0;
  private cachedSnapshot?: { request: NfcRequest } & NfcTapState;
  private cachedVersion = -1;

  constructor(readonly transport: NfcTransport) {}

  /** The request on screen, with the latest tap state. A new object whenever anything changes. */
  getSnapshot = (): ({ request: NfcRequest } & NfcTapState) | undefined => {
    if (!this.cachedSnapshot || this.cachedVersion !== this.version) {
      this.cachedVersion = this.version;
      this.cachedSnapshot = this.active ? { request: this.active.request, ...this.active.state } : undefined;
    }
    return this.cachedSnapshot;
  };

  /** For `useSyncExternalStore`. */
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  private changed(): void {
    this.version++;
    for (const l of [...this.listeners]) l();
  }

  private setState(a: Active, state: NfcTapState): void {
    if (this.active !== a) return;
    a.state = state;
    this.changed();
  }

  private enqueue<T>(request: NfcRequest, signal?: AbortSignal): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      if (signal?.aborted) return reject(new HardwareError('cancelled', 'Cancelled.', { kind: 'coldcard-nfc' }));
      let onAbort: (() => void) | undefined;
      const cleanup = () => {
        if (onAbort) signal?.removeEventListener('abort', onAbort);
      };
      const entry: Active = {
        request,
        state: {},
        resolve: (v) => {
          cleanup();
          resolve(v as T);
        },
        reject: (e) => {
          cleanup();
          reject(e);
        },
      };
      const start = () => {
        this.active = entry;
        this.changed();
      };
      if (signal) {
        onAbort = () => {
          if (this.active === entry) {
            entry.tapAbort?.abort();
            this.settle(() => entry.reject(new HardwareError('cancelled', 'Cancelled.', { kind: 'coldcard-nfc' })));
          } else {
            this.queue = this.queue.filter((q) => q !== start);
            entry.reject(new HardwareError('cancelled', 'Cancelled.', { kind: 'coldcard-nfc' }));
          }
        };
        signal.addEventListener('abort', onAbort, { once: true });
      }
      if (this.active) this.queue.push(start);
      else start();
    });
  }

  private settle(fn: () => void): void {
    this.active = undefined;
    fn();
    const next = this.queue.shift();
    if (next) next();
    else this.changed();
  }

  /** Shows the request until the owner taps and the message is written (resolves), or cancels (rejects `cancelled`). */
  write(request: Omit<NfcWriteRequest, 'type'>, signal?: AbortSignal): Promise<void> {
    return this.enqueue<void>({ type: 'write', ...request }, signal);
  }

  /** Shows the request until a tap reads something `accept` takes (resolves with its value), or the owner cancels. */
  read<T>(request: Omit<NfcReadRequest<T>, 'type'>, signal?: AbortSignal): Promise<T> {
    return this.enqueue<T>({ type: 'read', ...request } as NfcReadRequest, signal);
  }

  /** Shows the request until the owner continues (resolves) or cancels. */
  show(request: Omit<NfcShowRequest, 'type'>, signal?: AbortSignal): Promise<void> {
    return this.enqueue<void>({ type: 'show', ...request }, signal);
  }

  // ---- called by the host UI ------------------------------------------------------------------------------

  /**
   * The owner tapped the button of a `write` or `read` request: wait for the tag and do it. Resolves when the attempt
   * is over, whether it settled the request or left a hint.
   */
  async tap(): Promise<void> {
    const a = this.active;
    if (!a || a.request.type === 'show' || a.state.busy) return;
    const request = a.request;
    if (!(await this.transport.isEnabled())) {
      const supported = await this.transport.isSupported();
      this.setState(a, {
        nfcOff: supported,
        hint: supported ? 'NFC is turned off on this phone. Turn it on, then tap again.' : (this.transport.unavailableReason ?? 'This phone has no NFC.'),
      });
      return;
    }
    const abort = new AbortController();
    a.tapAbort = abort;
    this.setState(a, { busy: true });
    try {
      if (request.type === 'write') {
        await this.transport.write(request.message, { alert: request.alert, signal: abort.signal });
        if (this.active === a) this.settle(() => a.resolve(undefined));
      } else {
        const records = await this.transport.read({ alert: request.alert, signal: abort.signal });
        if (this.active !== a) return;
        let value: unknown;
        try {
          value = request.accept(records);
        } catch (e) {
          this.setState(a, { hint: e instanceof Error ? e.message : String(e) });
          return;
        }
        this.settle(() => a.resolve(value));
      }
    } catch (e) {
      // The owner closed iOS's sheet: back to the button, no hint. Anything else: say what went wrong and stay.
      const cancelled = e instanceof HardwareError && e.code === 'cancelled';
      const off = e instanceof HardwareError && e.code === 'unavailable';
      this.setState(a, cancelled ? {} : { hint: e instanceof Error ? e.message : String(e), ...(off ? { nfcOff: true } : {}) });
    } finally {
      if (a.tapAbort === abort) a.tapAbort = undefined;
    }
  }

  /** The owner tapped the continue button of a `show` request. */
  finishShow(): void {
    const a = this.active;
    if (a?.request.type !== 'show') return;
    this.settle(() => a.resolve(undefined));
  }

  /** The owner closed the sheet. */
  cancel(): void {
    const a = this.active;
    if (!a) return;
    a.tapAbort?.abort();
    void this.transport.cancel();
    this.settle(() => a.reject(new HardwareError('cancelled', 'Cancelled.', { kind: 'coldcard-nfc' })));
  }

  /** Opens the phone's NFC settings (Android). */
  openSettings(): Promise<boolean> {
    return this.transport.openSettings();
  }
}
