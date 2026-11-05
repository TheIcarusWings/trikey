/**
 * Encrypted notes on the guardian for the guardian mode's real wallet (`WalletService.notes`): `TrikeyWallet.enableNotes`,
 * `disableNotes`, `notesOnGuardian` and `bringBackNotes`, in the app's words. Kept apart from ./real.ts, which hands it
 * what it needs (`NotesHost`). Uploads run inside the wallet (after each label change, and `flushNotes` on resume).
 */
import type { TrikeyWallet } from '@trikey/wallet';
import { NOTES_UNAVAILABLE, broughtBackText, notesSize, type NotesActions, type NotesCopyView, type NotesState } from './notes-actions';
import { mapError } from './real-errors';
import type { IsoDate } from './types';

export interface NotesHost {
  wallet(): TrikeyWallet | undefined;
  requireWallet(): TrikeyWallet;
  /** Runs a hardware wallet job: one at a time with the other device jobs. */
  run<T>(job: () => Promise<T>): Promise<T>;
  /** Labels came back: the coin list and Activity read them again. */
  changed(): void;
  iso(ms: number): IsoDate;
}

/** Why the last copy did not reach the guardian, in words. */
function uploadErrorText(code: string, message: string): string {
  if (code === 'unreachable' || code === 'unavailable') return "Your guardian didn't answer. Your notes go out when it does.";
  if (code === 'rate_limited') return 'Your notes changed often: the guardian takes the latest in a little while.';
  if (code === 'labels_too_large') return message;
  return `Your notes didn't reach the guardian: ${message}`;
}

export function notesState(w: TrikeyWallet, iso: (ms: number) => IsoDate): NotesState {
  const v = w.notesView();
  return {
    available: v.available,
    ...(v.unavailable ? { unavailable: v.unavailable, unavailableText: NOTES_UNAVAILABLE[v.unavailable] } : {}),
    on: v.on,
    ...(v.onForEarlierWallet ? { onForEarlierWallet: true } : {}),
    ...(v.uploadedAt !== undefined ? { uploadedAt: iso(v.uploadedAt) } : {}),
    pending: v.pending,
    ...(v.error ? { error: uploadErrorText(v.error.code, v.error.message) } : {}),
  };
}

export function createNotesActions(host: NotesHost): NotesActions {
  const guard = async <T>(job: () => Promise<T>): Promise<T> => {
    try {
      return await job();
    } catch (e) {
      throw mapError(e);
    }
  };
  return {
    state: () => {
      const w = host.wallet();
      return w ? notesState(w, host.iso) : null;
    },
    enable: () =>
      guard(async () => {
        const w = host.requireWallet();
        await host.run(() => w.enableNotes());
        return notesState(w, host.iso);
      }),
    disable: () =>
      guard(async () => {
        const w = host.requireWallet();
        await w.disableNotes();
        return notesState(w, host.iso);
      }),
    copies: () =>
      guard(async () => {
        const w = host.requireWallet();
        const list = await w.notesOnGuardian();
        return list
          .filter((c) => !c.keptByThisPhone)
          .sort((a, b) => b.at - a.at)
          .map((c): NotesCopyView => ({ walletId: c.of, thisWallet: c.thisWallet, at: host.iso(c.at), size: notesSize(c.bytes), broughtBack: c.broughtBack }));
      }),
    bringBack: (walletId) =>
      guard(async () => {
        const w = host.requireWallet();
        const r = await host.run(() => w.bringBackNotes(walletId ? { of: walletId } : {}));
        host.changed();
        return { text: broughtBackText(r), count: r.coins + r.payments + r.addresses + r.other };
      }),
  };
}
