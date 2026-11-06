import type { IsoDate } from './types';

/**
 * "Unlock with your hardware wallet" (`WalletService.hardwareUnlock`; DESIGN.md, "Unlocking the guardian with the hardware
 * wallet"): after a restart the guardian is locked; with this on, the wallet's hardware wallet unlocks it through the
 * phone, one confirmation, next to the passphrase (which always stays). Off by default. The phone keeps nothing that
 * could unlock it alone: every unlock asks the hardware wallet. The guardian mode's wallet and the demo have it.
 */
export interface HardwareUnlockState {
  /** It can be turned on for the wallet shown. */
  available: boolean;
  /** Why not: `guardian` (an older guardian: the option is hidden), or a reason said in `unavailableText`. */
  unavailable?: 'not_paired' | 'hosted' | 'guardian' | 'hardware';
  /** Why not, in words (a hosted wallet, a QR hardware wallet). */
  unavailableText?: string;
  /** On: the hardware wallet can unlock the guardian. */
  on: boolean;
  /** When it was turned on (the guardian's clock). */
  since?: IsoDate;
}

export interface HardwareUnlockActions {
  /** No I/O. Null without a wallet. */
  state(): HardwareUnlockState | null;
  /** Turns it on (the guardian unlocked): the hardware wallet confirms the same text twice. */
  enable(): Promise<HardwareUnlockState>;
  /** Turns it off: the guardian deletes the way in. The passphrase stays. */
  disable(): Promise<HardwareUnlockState>;
  /** Unlocks the locked guardian: one confirmation on the hardware wallet. */
  unlock(): Promise<void>;
}

/** Why it cannot be offered, in words. */
export const HARDWARE_UNLOCK_UNAVAILABLE: Record<'not_paired' | 'hosted' | 'guardian' | 'hardware', string> = {
  not_paired: 'Finish setting up this wallet with your guardian first.',
  hosted: "Only your host unlocks their guardian. Your hardware wallet resumes this wallet if it is paused.",
  guardian: 'Update your guardian to unlock it with your hardware wallet.',
  // Some QR devices (Passport gen 2, SeedSigner, Krux, "Other") sign no text by QR code: there is nothing to unlock with.
  hardware:
    'This needs a hardware wallet that signs a short text: a Ledger, a Trezor, a Coldcard Mk4 or Q over NFC, or by QR code a Coldcard Q, Jade, Keystone 3, Passport Prime or Specter DIY. A QR device set up before Trikey asked for its model counts as "Other": pick it in Settings, Hardware wallet model. Until then, use the passphrase.',
};

/** What turning it on does and does not do, in the words every screen uses. */
export const HARDWARE_UNLOCK_NOTE =
  'Your phone keeps nothing that unlocks the guardian by itself: each unlock needs your hardware wallet. The passphrase keeps working on the box and here.';
