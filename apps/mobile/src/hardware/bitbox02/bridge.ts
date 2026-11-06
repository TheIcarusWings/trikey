/**
 * The meeting point between the BitBox02 provider (plain logic, no UI) and the screen, like the Jade's bridge. While the
 * phone finds, unlocks and pairs a BitBox02, the provider puts a status on screen ("Looking for your BitBox02", "Enter
 * your password on the BitBox02") that the owner can cancel, and the first time, the pairing code: the same code shows
 * on the BitBox02, where the owner confirms it. Whatever mounts `BitBox02BridgeHost` (ui/bitbox02-bridge-host.tsx) shows
 * them. Signing itself (the wallet, a payment, a text) is shown by the app's usual "Confirm on your device" sheet.
 */
import type { BitBoxLink } from './link';

export interface BitBoxBridgeScreen {
  title: string;
  instructions: string;
  steps?: string[];
  notes?: string[];
  /** The pairing code, "ABCDE FGHIJ\nKLMNO PQRST": shown large, to compare with the BitBox02's screen. */
  code?: string;
  /** A problem to show. */
  hint?: string;
}

export class BitBoxBridge {
  private screen?: BitBoxBridgeScreen;
  private onCancel?: () => void;
  private listeners = new Set<() => void>();

  constructor(readonly links: BitBoxLink[]) {}

  getSnapshot = (): BitBoxBridgeScreen | undefined => this.screen;

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
  status(screen: BitBoxBridgeScreen, onCancel?: () => void): void {
    this.screen = screen;
    this.onCancel = onCancel;
    this.changed();
  }

  hide(): void {
    this.onCancel = undefined;
    if (!this.screen) return;
    this.screen = undefined;
    this.changed();
  }

  /** The owner closed the sheet or tapped Cancel. */
  cancel(): void {
    const onCancel = this.onCancel;
    this.hide();
    onCancel?.();
  }
}
