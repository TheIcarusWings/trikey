/**
 * The guardian passphrase's rules, as the first-run page and "Change passphrase" check them before sending (the
 * guardian checks them again: apps/guardian/src/keystore.ts `checkPassphrase`), and the words shown after a change
 * (DESIGN.md, "Changing the passphrase").
 */

/** At least this many characters (after NFKC normalization, as the guardian counts them). */
export const MIN_PASSPHRASE = 12;
/** At most this many: the guardian's own limit. */
export const MAX_PASSPHRASE = 1024;

/** The hint under a new passphrase field. */
export const PASSPHRASE_HINT = `At least ${MIN_PASSPHRASE} characters. A few random words work well.`;

/** Characters as the guardian counts them: Unicode code points after NFKC (what the key derivation sees). */
export function passphraseLength(passphrase: string): number {
  return [...passphrase.normalize('NFKC')].length;
}

/** True when two passphrases are the same to the guardian (NFKC-equal). */
export function samePassphrase(a: string, b: string): boolean {
  return a.normalize('NFKC') === b.normalize('NFKC');
}

export interface NewPassphraseErrors {
  current?: string;
  passphrase?: string;
  confirm?: string;
}

/**
 * What is wrong with a new passphrase typed twice (and, for a change, the current one): the setup's rule (at least
 * `MIN_PASSPHRASE` characters), the two copies equal, and for a change a current passphrase given and a new one that
 * differs from it. Empty when nothing is.
 */
export function newPassphraseErrors(input: { passphrase: string; confirm: string; current?: string }): NewPassphraseErrors {
  const out: NewPassphraseErrors = {};
  if (input.current !== undefined && input.current.length === 0) out.current = 'Enter the current passphrase.';
  const n = passphraseLength(input.passphrase);
  if (n < MIN_PASSPHRASE) out.passphrase = `Use at least ${MIN_PASSPHRASE} characters. A few random words work well.`;
  else if (n > MAX_PASSPHRASE) out.passphrase = `Use at most ${MAX_PASSPHRASE} characters.`;
  else if (input.current && samePassphrase(input.current, input.passphrase)) out.passphrase = 'Choose a passphrase other than the current one.';
  if (input.confirm !== input.passphrase) out.confirm = "The two passphrases don't match.";
  return out;
}

/** The note on the "Change passphrase" page before the change: what it does, how long it takes. */
export const CHANGE_PASSPHRASE_INTRO =
  'The guardian keeps key 3 encrypted with this passphrase. Changing it encrypts the same key 3 again under the new one; your wallet, its rules and the hardware wallet unlock stay as they are. Other browsers signed in to this page are signed out. It takes a few seconds, longer on a small box.';

/**
 * What the page says once the passphrase changed: plainly, what no longer works and what is not affected. Each line
 * stands alone (a list on the page).
 */
export const PASSPHRASE_CHANGED_NOTES: readonly string[] = [
  'The old passphrase no longer unlocks this guardian or signs in to this page. Update it in your password manager and anywhere you wrote it down.',
  'Every copy of the old passphrase is now worthless, including one typed into a Trikey app older than 0.1.17, which sent it to the guardian unsealed. The app never keeps the passphrase: type the new one the next time it asks.',
  'Your recovery does not use this passphrase: the recovery code and backup file bring back your phone key, the recovery sheet lets a new phone reach this guardian with your hardware wallet, and Replace guardian needs only your phone and hardware wallet. Nothing to print again.',
  "A copy of this guardian's data made before now (a backup of the box, a copied Docker volume or data folder, a NAS snapshot) still opens with the old passphrase, and holds the same key 3. Delete such copies, or keep them as safe as the old passphrase. StartOS backups leave the guardian out.",
  'If you changed it because someone may know the old passphrase and may have such a copy, changing it is not enough: move your wallet to a new guardian with Replace guardian in the app.',
];

/** The error under the form, in the page's words. */
export function changePassphraseError(err: { code: string; message: string; retryAfterSeconds?: number } | undefined): string {
  if (!err) return 'Could not change the passphrase.';
  switch (err.code) {
    case 'bad_passphrase':
      return "That isn't the current passphrase.";
    case 'rate_limited':
      return err.retryAfterSeconds ? `Too many tries. Wait ${err.retryAfterSeconds} seconds and try again.` : 'Too many tries. Wait a moment and try again.';
    case 'same_passphrase':
      return 'Choose a passphrase other than the current one.';
    case 'locked':
      return 'The guardian is locked. Unlock it first, then change the passphrase.';
    default:
      // invalid (the guardian's rule, in its words), network, internal.
      return err.message;
  }
}
