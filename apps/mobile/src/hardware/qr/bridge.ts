/**
 * The meeting point between the QR signer (plain logic, no UI) and the screens.
 *
 * The signer asks the bridge to *show* some QR frames ("sign this transaction") or to *scan* some ("now show me the
 * signed transaction"). Whatever mounts `QrBridgeHost` (ui/qr-bridge-host.tsx) renders those requests and answers
 * through `finishShow`, `submitFrame` and `cancel`. Only one request is active at a time; others wait their turn.
 *
 * A *file* request is the microSD round trip (sd-message.ts): the phone hands the owner a file for the device
 * (`saveFile` / `shareFile`), and reads the file the device wrote (`pickFile`, or `submitFile` directly), or, when the
 * device can also show its answer as a QR, a scanned frame (`submitFrame`). The host does the file I/O through a
 * `DeviceFileIo` (the app's: platform/device-files), so a test can pass its own.
 *
 * A *notice* is a step the owner must confirm before the signer goes on (`acknowledge`): after a microSD round trip,
 * the files to delete from the card. It has no cancel (`cancel` leaves it on screen): the signature before it is
 * already taken, and the owner has to say they did it.
 */
import { HardwareError } from '../errors';
import type { QrProgress } from './types';

export interface QrShowRequest {
  type: 'show';
  /** What is being shown: the host may pick an icon or wording from it. `message`: a text for the device to sign. */
  purpose: 'psbt' | 'wallet' | 'address' | 'message';
  title: string;
  instructions: string;
  /** The QR frames to cycle through, in order. One frame means a still QR. */
  frames: string[];
  /** Text to show under the QR in monospace, for the user to read and compare (an address, the text to sign). */
  detail?: string;
  /** Numbered steps on the device, shown under the QR (message signing: they differ per model). */
  steps?: string[];
  /** Short notes shown after the steps (what the text means, what to check on the device). */
  notes?: string[];
  /** Label of the button that moves on ("Scan the signed transaction"). */
  continueLabel: string;
}

/** The result of feeding one scanned frame to a scan request. */
export type QrScanStep<T> =
  | { done: true; value: T }
  | { done: false; progress?: QrProgress; /** A hint for the user ("That is not the signed transaction."), shown without stopping the scan. */ hint?: string };

export interface QrScanRequest<T = unknown> {
  type: 'scan';
  purpose: 'signed-psbt' | 'device-key' | 'signed-message';
  title: string;
  instructions: string;
  /**
   * Feed one decoded QR string. Return `{ done: true }` when the payload is complete, `{ done: false }` while more frames
   * are needed or the frame was not what we want. Throwing rejects the scan with that error.
   */
  accept(frame: string): QrScanStep<T>;
}

/** A file the owner picked: its name and bytes. */
export interface DeviceFile {
  name: string;
  bytes: Uint8Array;
}

/** How the host hands a file to the owner and reads one back (platform/device-files in the app; a fake in tests). */
export interface DeviceFileIo {
  /** Writes the file into a folder the owner picks (the microSD card in a reader, or Files). False if they backed out. */
  saveToFolder(name: string, text: string): Promise<boolean>;
  /** Opens the share sheet on the file (to a computer, Files, mail to yourself). */
  share(name: string, text: string): Promise<void>;
  /** The file the owner picks (the device's signed file); null if they backed out. */
  pick(): Promise<DeviceFile | null>;
}

export interface QrFileRequest<T = unknown> {
  type: 'file';
  /** `message-file`: a text to sign from a microSD card. */
  purpose: 'message-file';
  title: string;
  instructions: string;
  /** The file for the device (the signing request), to save to the card or share. */
  file: { name: string; text: string };
  /** Text to show in monospace, for the owner to compare with the device (the text to sign). */
  detail?: string;
  /** Numbered steps on the device. */
  steps?: string[];
  /** Short notes after the steps. */
  notes?: string[];
  /** Reads the file the owner picked. `{ done: false, hint }` keeps the request open (another file, or sign again); throwing rejects it. */
  acceptFile(file: DeviceFile): QrScanStep<T>;
  /** When the device can also show its answer as a QR code (Krux): reads one scanned frame. */
  acceptFrame?(frame: string): QrScanStep<T>;
}

export interface QrNoticeRequest {
  type: 'notice';
  /** `delete-files`: after a microSD round trip, the files to delete from the card (sd-message.ts, `sdCleanupNotice`). */
  purpose: 'delete-files';
  title: string;
  instructions: string;
  /** Shown one per line in monospace, exactly as written (the file names). */
  items: string[];
  /** Short notes after the items. */
  notes?: string[];
  /** The only button: the owner did it ("I deleted them"). */
  continueLabel: string;
}

export type QrRequest = QrShowRequest | QrScanRequest | QrFileRequest | QrNoticeRequest;

interface Active {
  request: QrRequest;
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
  /** The last progress/hint the scan reported, for the host to render; `saved`: the file request's file was handed over. */
  state: { progress?: QrProgress; hint?: string; saved?: boolean };
}

export class QrBridge {
  private active?: Active;
  private queue: Array<() => void> = [];
  private listeners = new Set<() => void>();
  private version = 0;

  /** The request on screen, with the latest scan state. A new object whenever anything changes. */
  getSnapshot(): { request: QrRequest; progress?: QrProgress; hint?: string; saved?: boolean } | undefined {
    if (!this.cachedSnapshot || this.cachedVersion !== this.version) {
      this.cachedVersion = this.version;
      this.cachedSnapshot = this.active ? { request: this.active.request, ...this.active.state } : undefined;
    }
    return this.cachedSnapshot;
  }
  private cachedSnapshot?: { request: QrRequest; progress?: QrProgress; hint?: string; saved?: boolean };
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

  /** Hands a file over and waits for the device's answer: a picked file (or a scanned frame) that `accept…` takes. */
  file<T>(request: Omit<QrFileRequest<T>, 'type'>, signal?: AbortSignal): Promise<T> {
    return this.enqueue<T>({ type: 'file', ...request } as QrFileRequest, signal);
  }

  /** Shows a step the owner must confirm; resolves when they do (`acknowledge`). Only `signal` ends it otherwise. */
  notice(request: Omit<QrNoticeRequest, 'type'>, signal?: AbortSignal): Promise<void> {
    return this.enqueue<void>({ type: 'notice', ...request }, signal);
  }

  // ---- called by the host UI ------------------------------------------------------------------------------

  /** The user tapped the continue button of a `show` request. */
  finishShow(): void {
    const a = this.active;
    if (a?.request.type !== 'show') return;
    this.settle(() => a.resolve(undefined));
  }

  /** The owner confirmed a `notice` request ("I deleted them"). */
  acknowledge(): void {
    const a = this.active;
    if (a?.request.type !== 'notice') return;
    this.settle(() => a.resolve(undefined));
  }

  /** The user closed the sheet. A notice stays: it has no cancel (the system back gesture lands here too). */
  cancel(): void {
    const a = this.active;
    if (!a || a.request.type === 'notice') return;
    this.settle(() => a.reject(new HardwareError('cancelled', 'Cancelled.')));
  }

  /** One QR was read by the camera (a scan request, or a file request whose device can answer by QR). Returns the state after it. */
  submitFrame(frame: string): { progress?: QrProgress; hint?: string } {
    const a = this.active;
    if (a?.request.type === 'scan') {
      const request = a.request;
      return this.step(a, () => request.accept(frame));
    }
    if (a?.request.type === 'file' && a.request.acceptFrame) {
      const accept = a.request.acceptFrame.bind(a.request);
      return this.step(a, () => accept(frame));
    }
    return {};
  }

  /** The owner picked a file for the file request. Returns the state after it (a hint when it was not the right file). */
  submitFile(file: DeviceFile): { hint?: string } {
    const a = this.active;
    if (a?.request.type !== 'file') return {};
    const request = a.request;
    return this.step(a, () => request.acceptFile(file));
  }

  /** The host's "Save the file" button: writes the file request's file where the owner picks. False if they backed out. */
  async saveFile(io: DeviceFileIo): Promise<boolean> {
    const a = this.active;
    if (a?.request.type !== 'file') return false;
    const saved = await io.saveToFolder(a.request.file.name, a.request.file.text);
    if (saved && this.active === a) this.mark(a, { saved: true });
    return saved;
  }

  /** The host's "Share the file" button. */
  async shareFile(io: DeviceFileIo): Promise<void> {
    const a = this.active;
    if (a?.request.type !== 'file') return;
    await io.share(a.request.file.name, a.request.file.text);
    if (this.active === a) this.mark(a, { saved: true });
  }

  /** The host's "Open the signed file" button: the owner picks a file, which goes to `submitFile`. */
  async pickFile(io: DeviceFileIo): Promise<{ hint?: string }> {
    const a = this.active;
    if (a?.request.type !== 'file') return {};
    const file = await io.pick();
    if (!file || this.active !== a) return {};
    return this.submitFile(file);
  }

  private mark(a: Active, patch: Active['state']): void {
    a.state = { ...a.state, ...patch };
    this.changed();
  }

  private step(a: Active, run: () => QrScanStep<unknown>): { progress?: QrProgress; hint?: string } {
    let step: QrScanStep<unknown>;
    try {
      step = run();
    } catch (e) {
      this.settle(() => a.reject(e));
      return {};
    }
    if (step.done) {
      this.settle(() => a.resolve(step.value));
      return {};
    }
    const next = { ...a.state, progress: step.progress ?? a.state.progress, hint: step.hint };
    const prev = a.state;
    // The camera reports the same QR many times a second: only wake the UI when something it shows has changed.
    const unchanged = prev.hint === next.hint && prev.progress?.received === next.progress?.received && prev.progress?.total === next.progress?.total;
    a.state = next;
    if (!unchanged) this.changed();
    return a.state;
  }
}

/** The bridge used when none is passed in: the QR providers use it, and `QrBridgeHost` mounts on it by default. */
export const defaultQrBridge = new QrBridge();
