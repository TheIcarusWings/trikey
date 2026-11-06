import type { IsoDate } from './types';

/**
 * "Keep your notes safe with the guardian" (`WalletService.notes`; DESIGN.md, "Notes that survive recovery"): an
 * encrypted copy of the wallet's labels (coin labels and freezes, payment notes, address labels) on the guardian, so they
 * survive losing the phone and its backup. Only the wallet's hardware wallet can make the key; the guardian stores
 * ciphertext. Off by default. The guardian mode's wallet and the demo have it; Recovery Key mode does not.
 */
export interface NotesState {
  /** It can be turned on for the wallet shown. */
  available: boolean;
  /** Why not: `guardian` (an older guardian: the option is hidden), or a reason said in `unavailableText`. */
  unavailable?: 'not_paired' | 'hosted' | 'guardian' | 'hardware';
  /** Why not, in words (an older guardian, a hosted wallet, a QR hardware wallet). */
  unavailableText?: string;
  on: boolean;
  /** It was on before a recovery: the recovered wallet needs it turned on again (its own key). */
  onForEarlierWallet?: boolean;
  /** When the guardian last stored a copy. */
  uploadedAt?: IsoDate;
  /** Labels changed since: sent after a short pause, or when the app comes back. */
  pending: boolean;
  /** Why the last copy did not reach the guardian, in words, until one does. */
  error?: string;
}

/** A copy on the guardian that this phone could bring back. */
export interface NotesCopyView {
  /** The wallet it was made for (this one, or the one a recovery replaced). */
  walletId: string;
  thisWallet: boolean;
  /** When the guardian stored it. */
  at: IsoDate;
  /** "about 4 kB": the padded size, all the guardian learns of how many notes there are. */
  size: string;
  /** Brought back already (that version or a newer one). */
  broughtBack: boolean;
}

export interface NotesBroughtBackView {
  /** "12 coin labels, 3 payment notes and 1 address label came back." */
  text: string;
  /** Labels that came back (this phone's own were kept where both had one). */
  count: number;
}

export interface NotesActions {
  /** No I/O. Null without a wallet. */
  state(): NotesState | null;
  /** Turns it on: the hardware wallet confirms the same text twice (one key it can make again on any phone), then the notes are sent. */
  enable(): Promise<NotesState>;
  /** Turns it off: the guardian deletes every copy of this wallet's notes. The notes on this phone and in its backup stay. */
  disable(): Promise<NotesState>;
  /** Copies on the guardian this phone does not keep up to date itself, newest first (asks the guardian). */
  copies(): Promise<NotesCopyView[]>;
  /**
   * "Bring back your notes": one hardware wallet signature, then the copy is merged into this phone's labels. Where this
   * phone (or its backup) already has a label, that one is kept.
   */
  bringBack(walletId?: string): Promise<NotesBroughtBackView>;
}

/** The sentence for what came back. */
export function broughtBackText(r: { coins: number; payments: number; addresses: number; other: number }): string {
  const part = (n: number, one: string, many: string) => (n ? `${n} ${n === 1 ? one : many}` : '');
  const parts = [part(r.coins, 'coin label', 'coin labels'), part(r.payments, 'payment note', 'payment notes'), part(r.addresses, 'address label', 'address labels'), part(r.other, 'other label', 'other labels')].filter(Boolean);
  if (!parts.length) return 'Your notes were already on this phone: nothing was missing.';
  const list = parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
  return `${list} came back. Where this phone already had a label, it was kept.`;
}

/** "about 4 kB". */
export function notesSize(bytes: number): string {
  return bytes < 1024 * 1024 ? `about ${Math.max(1, Math.round(bytes / 1024))} kB` : `about ${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Why it cannot be offered, in words. */
export const NOTES_UNAVAILABLE: Record<'not_paired' | 'hosted' | 'guardian' | 'hardware', string> = {
  not_paired: 'Finish setting up this wallet with your guardian first.',
  hosted: "Notes are not kept on someone else's guardian yet.",
  guardian: 'Update your guardian to keep your notes there.',
  hardware:
    'This needs a hardware wallet that signs a short text: a Ledger or a Trezor, or by QR code a Coldcard Q, Jade, Keystone 3, Passport Prime or Specter DIY. A QR device set up before Trikey asked for its model counts as "Other": pick it in Settings, Hardware wallet model.',
};
