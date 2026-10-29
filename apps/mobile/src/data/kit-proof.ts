/**
 * Checking a Recovery Kit proof on the screen before it is handed to the wallet.
 *
 * Recovery into a new vault shows the new kit in the middle of a move that has no way back: the wallet checks the proof
 * once, and a typo would end the whole recovery ("Nothing moved"). So the screen checks the proof against the kit it
 * just showed, lets the person fix a typo, and only then hands it over. The wallet checks again.
 */
import { WalletServiceError } from './errors';
import type { KitProof, RecoveryKit } from './types';

/** A typed word matches its position when it is the word, or its first four letters are (the BIP 39 list is unique by them). */
export function wordMatches(typed: string, word: string): boolean {
  const t = typed.trim().toLowerCase();
  if (!t) return false;
  if (t === word) return true;
  return t.length >= 4 && word.slice(0, 4) === t.slice(0, 4);
}

/** Throws a `kit_invalid` error in words when `proof` does not show `kit` is saved. */
export function checkKitProof(kit: RecoveryKit, proof: KitProof): void {
  if ('scanned' in proof) {
    if (proof.scanned.trim() !== kit.qrText) throw new WalletServiceError('kit_invalid', "That QR code isn't the kit you just made.");
    return;
  }
  if ('words' in proof) {
    if (kit.kind !== 'seed') throw new WalletServiceError('kit_invalid', 'This kit has no words to check.');
    for (const position of kit.challenge) {
      if (!wordMatches(proof.words[position] ?? '', kit.recoveryWords[position - 1]!)) throw new WalletServiceError('kit_invalid', `Word ${position} doesn't match the sheet. Check it and try again.`);
    }
    return;
  }
  if (kit.kind === 'seed') throw new WalletServiceError('kit_invalid', 'Type the words asked for, or scan the sheet.');
}
