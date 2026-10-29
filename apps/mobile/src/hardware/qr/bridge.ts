/**
 * The meeting point between the QR signer (plain logic, no UI) and the screens.
 *
 * The signer asks the bridge to *show* some QR frames ("sign this transaction") or to *scan* some ("now show me the
 * signed transaction"). Whatever mounts `QrBridgeHost` (ui/qr-bridge-host.tsx) renders those requests and answers
 * through `finishShow`, `submitFrame` and `cancel`. Only one request is active at a time; others wait their turn.
 */
import { HardwareError } from '../errors';
import type { QrProgress } from './types';

export interface QrShowRequest {
  type: 'show';
  /** What is being shown: the host may pick an icon or wording from it. */
  purpose: 'psbt' | 'wallet' | 'address';
  title: string;
  instructions: string;
  /** The QR frames to cycle through, in order. One frame means a still QR. */
  frames: string[];
  /** Label of the button that moves on ("Scan the signed transaction"). */
  continueLabel: string;
}

/** The result of feeding one scanned frame to a scan request. */
export type QrScanStep<T> =
  | { done: true; value: T }
  | { done: false; progress?: QrProgress; /** A hint for the user ("That is not the signed transaction."), shown without stopping the scan. */ hint?: string };

export interface QrScanRequest<T = unknown> {
  type: 'scan';
  purpose: 'signed-psbt' | 'device-key';
  title: string;
  instructions: string;
  /**
   * Feed one decoded QR string. Return `{ done: true }` when the payload is complete, `{ done: false }` while more frames
   * are needed or the frame was not what we want. Throwing rejects the scan with that error.
   */
  accept(frame: string): QrScanStep<T>;
}

export type QrRequest = QrShowRequest | QrScanRequest;

interface Active {
  request: QrRequest;
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
  /** The last progress/hint the scan reported, for the host to render. */
  state: { progress?: QrProgress; hint?: string };
}

export class QrBridge {
  private active?: Active;
  private queue: Array<() => void> = [];
  private listeners = new Set<() => void>();
  private version = 0;

  /** The request on screen, with the latest scan state. A new object whenever anything changes. */
  getSnapshot(): { request: QrRequest; progress?: QrProgress; hint?: string } | undefined {
    if (!this.cachedSnapshot || this.cachedVersion !== this.version) {
      this.cachedVersion = this.version;
      this.cachedSnapshot = this.active ? { request: this.active.request, ...this.active.state } : undefined;
    }
    return this.cachedSnapshot;
  }
  private cachedSnapshot?: { request: QrRequest; progress?: QrProgress; hint?: string };
  private cachedVersion = -1;

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

  private enqueue<T>(request: QrRequest, signal?: AbortSignal): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      if (signal?.aborted) return reject(new HardwareError('cancelled', 'Cancelled.'));
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
          if (this.active === entry) this.settle(() => entry.reject(new HardwareError('cancelled', 'Cancelled.')));
          else {
            this.queue = this.queue.filter((q) => q !== start);
            entry.reject(new HardwareError('cancelled', 'Cancelled.'));
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

  /** Shows frames until the user continues (resolves) or cancels (rejects with `cancelled`). */
  show(request: Omit<QrShowRequest, 'type'>, signal?: AbortSignal): Promise<void> {
    return this.enqueue<void>({ type: 'show', ...request }, signal);
  }

  /** Scans until `accept` reports done (resolves with its value), the user cancels or `accept` throws (rejects). */
  scan<T>(request: Omit<QrScanRequest<T>, 'type'>, signal?: AbortSignal): Promise<T> {
    return this.enqueue<T>({ type: 'scan', ...request } as QrScanRequest, signal);
  }

  // ---- called by the host UI ------------------------------------------------------------------------------

  /** The user tapped the continue button of a `show` request. */
  finishShow(): void {
    const a = this.active;
    if (a?.request.type !== 'show') return;
    this.settle(() => a.resolve(undefined));
  }

  /** The user closed the sheet. */
  cancel(): void {
    const a = this.active;
    if (!a) return;
    this.settle(() => a.reject(new HardwareError('cancelled', 'Cancelled.')));
  }

  /** One QR was read by the camera. Returns the scan state after it. */
  submitFrame(frame: string): { progress?: QrProgress; hint?: string } {
    const a = this.active;
    if (a?.request.type !== 'scan') return {};
    let step: QrScanStep<unknown>;
    try {
      step = a.request.accept(frame);
    } catch (e) {
      this.settle(() => a.reject(e));
      return {};
    }
    if (step.done) {
      this.settle(() => a.resolve(step.value));
      return {};
    }
    a.state = { progress: step.progress ?? a.state.progress, hint: step.hint };
    this.changed();
    return a.state;
  }
}
