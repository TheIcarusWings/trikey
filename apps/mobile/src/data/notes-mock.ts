/**
 * Encrypted notes for the demo (`WalletService.notes`): the same `NotesActions` as the real wallet, held in memory, so the
 * screens can be looked at without a guardian. Turning it on waits for the "device" twice (the determinism check); after
 * a demo recovery the guardian holds a copy of the old wallet's notes to bring back.
 */
import { broughtBackText, type NotesActions, type NotesCopyView, type NotesState } from './notes-actions';
import { WalletServiceError } from './errors';
import type { MockHooks } from './rk-mock';

const OLD_WALLET = '7a1c4e9b2d6f3a80';

export function createMockNotes(h: MockHooks): NotesActions & { readonly snapshot: NotesState } {
  let state: NotesState = { available: true, on: false, pending: false };
  let broughtBack = false;
  const set = (next: NotesState) => {
    state = next;
    // Every screen reads the wallet again (the demo's state changes nothing else).
    h.update({});
    return state;
  };
  const stamp = () => new Date(h.now.getTime() + 60_000).toISOString();
  return {
    get snapshot() {
      return state;
    },
    state: () => state,
    enable: async () => {
      if (state.on) return state;
      await h.wait(h.deviceDelay);
      await h.wait(h.deviceDelay);
      await h.wait(h.networkDelay);
      return set({ available: true, on: true, pending: false, uploadedAt: stamp() });
    },
    disable: async () => {
      await h.wait(h.networkDelay);
      return set({ available: true, on: false, pending: false });
    },
    copies: async (): Promise<NotesCopyView[]> => {
      await h.wait(h.networkDelay);
      if (!h.get().finishedRecovery) return [];
      return [{ walletId: OLD_WALLET, thisWallet: false, at: new Date(h.now.getTime() - 3 * 86_400_000).toISOString(), size: 'about 8 kB', broughtBack }];
    },
    bringBack: async (walletId) => {
      if (!h.get().finishedRecovery || (walletId && walletId !== OLD_WALLET)) throw new WalletServiceError('wrong_state', 'Your guardian keeps no notes for this wallet.');
      await h.wait(h.deviceDelay);
      await h.wait(h.networkDelay);
      const r = { coins: 7, payments: 12, addresses: 2, other: 0 };
      broughtBack = true;
      h.update({});
      return { text: broughtBackText(r), count: 21 };
    },
  };
}
