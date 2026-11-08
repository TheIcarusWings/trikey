/**
 * Names people choose that the guardian repeats in its alerts: an own wallet's name (`wallet.add`'s `name` and
 * `firstName`) and a hosted wallet's label (`hosted.pair`'s `walletLabel`). A phone thief can choose them too, and the
 * alert contacts read them in the guardian's signed DMs, so they may hold letters (any script, with their accents),
 * digits, spaces, `-` and apostrophes only: never a link, a domain, an email address or a line break that could make a
 * genuine alert look like phishing, or put words in the guardian's mouth (security sweep 2, finding 15).
 */

/** One character a name may hold: a letter (with its marks), a digit, a space, `-`, `'` or `’`. */
const NAME_CHAR = /^[\p{L}\p{M}\p{N} '’-]$/u;
const OTHER = /[^\p{L}\p{M}\p{N} '’-]+/gu;

/** What `isSafeName` allows, for messages. */
export const SAFE_NAME_HINT = "letters, digits, spaces, - and ' only";

/** True when `name` holds only the characters above, with no space at either end, and is not empty. */
export function isSafeName(name: string): boolean {
  if (!name || name.trim() !== name || /\s{2}/.test(name)) return false;
  for (const ch of name) if (!NAME_CHAR.test(ch)) return false;
  return true;
}

/**
 * `raw` as an alert may show it: every run of other characters (dots, slashes, colons, line breaks, emoji, controls)
 * becomes one space, spaces are collapsed and trimmed, and it is cut to `max` characters. Empty when nothing is left:
 * the caller names the wallet otherwise ("Wallet 2", "your wallet").
 */
export function safeName(raw: unknown, max: number): string {
  const s = typeof raw === 'string' ? raw.normalize('NFC') : '';
  const cleaned = s.replace(OTHER, ' ').replace(/\s+/g, ' ').trim();
  return [...cleaned].slice(0, Math.max(0, max)).join('').trim();
}
