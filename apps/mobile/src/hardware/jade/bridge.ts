/**
 * The meeting point between the Jade provider (plain logic, no UI) and the screen, like the NFC bridge.
 *
 * While the phone finds, pairs and unlocks a Jade, the provider puts a *status* on screen ("Looking for your Jade",
 * "Enter your PIN on the Jade") that the owner can only cancel, and once, before the first unlock over Bluetooth, a
 * *notice* the owner answers: that unlocking a Jade this way asks the Jade's PIN server (and, when a Jade names a PIN
 * server that is not Blockstream's, whether it is the owner's own). Whatever mounts
 * `JadeBleBridgeHost` (ui/jade-ble-bridge-host.tsx) shows them. Signing itself (the wallet, a payment, a text) is shown
 * by the app's usual "Confirm on your device" sheet.
 */
import type { JadeBleLink } from './link';

export interface JadeScreen {
  title: string;
  instructions: string;
  steps?: string[];
  notes?: string[];
  /** A problem to show (the PIN server could not be reached). */
  hint?: string;
}

export interface JadeStatusScreen extends JadeScreen {
  type: 'status';
}

export interface JadeConfirmScreen extends JadeScreen {
  type: 'confirm';
  continueLabel: string;
  cancelLabel: string;
}

export type JadeBridgeScreen = JadeStatusScreen | JadeConfirmScreen;

/** Remembers that the owner read the PIN-server notice, so it is shown once (the app keeps it in its key-value store). */
export interface JadeNoticeStore {
  seen(): Promise<boolean>;
  markSeen(): Promise<void>;
}

/**
 * The PIN servers the owner named as their own (`host` or `host:port`), so the phone reaches them, and asks about one only
 * the first time a Jade names it. Blockstream's is never stored: it is always allowed.
 */
export interface JadePinServerStore {
  list(): Promise<string[]>;
  add(server: string): Promise<void>;
}

/** In memory: forgotten when the app restarts. For tests, and where the app passes no store. */
export function memoryPinServerStore(initial: string[] = []): JadePinServerStore {
  const servers = [...initial];
  return {
    list: async () => [...servers],
    add: async (server) => {
      if (!servers.includes(server)) servers.push(server);
    },
  };
}

/** In memory: seen until the app restarts. For tests, and where the app passes no store. */
export function memoryNoticeStore(): JadeNoticeStore {
  let seen = false;
  return {
    seen: async () => seen,
    markSeen: async () => {
      seen = true;
    },
  };
}

export class JadeBleBridge {
  private screen?: JadeBridgeScreen;
  private onCancel?: () => void;
  private answer?: (ok: boolean) => void;
  private listeners = new Set<() => void>();

  constructor(readonly link: JadeBleLink) {}

  getSnapshot = (): JadeBridgeScreen | undefined => this.screen;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  private changed(): void {
    for (const l of [...this.listeners]) l();
  }

  /** Shows a status (replacing whatever was on screen). `onCancel` runs if the owner cancels. */
  status(screen: Omit<JadeStatusScreen, 'type'>, onCancel?: () => void): void {
    this.answer?.(false);
    this.answer = undefined;
    this.screen = { type: 'status', ...screen };
    this.onCancel = onCancel;
    this.changed();
  }

  /** Shows a question; resolves true when the owner goes on, false when they cancel. */
  confirm(screen: Omit<JadeConfirmScreen, 'type'>): Promise<boolean> {
    this.answer?.(false);
    return new Promise<boolean>((resolve) => {
      this.screen = { type: 'confirm', ...screen };
      this.onCancel = undefined;
      this.answer = (ok) => {
        this.answer = undefined;
        resolve(ok);
      };
      this.changed();
    });
  }

  /** Takes the screen down. */
  hide(): void {
    this.answer?.(false);
    this.answer = undefined;
    this.onCancel = undefined;
    if (!this.screen) return;
    this.screen = undefined;
    this.changed();
  }

  // ---- called by the host UI ------------------------------------------------------------------------------

  /** The owner tapped the continue button of a question. */
  proceed(): void {
    this.answer?.(true);
  }

  /** The owner closed the sheet or tapped Cancel. */
  cancel(): void {
    const answer = this.answer;
    const onCancel = this.onCancel;
    this.hide();
    answer?.(false);
    onCancel?.();
  }
}
