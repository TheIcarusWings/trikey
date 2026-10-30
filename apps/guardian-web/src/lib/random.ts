/**
 * The web UI's one source of randomness: the browser's `crypto.getRandomValues` (the OS generator of
 * the machine the browser runs on). It is available on plain-HTTP pages too, which is how Umbrel and
 * Start9 serve the UI on the LAN.
 *
 * Used for the 32 bytes the setup and reset requests send to the guardian (`entropy`), which it mixes
 * into its new seed (apps/guardian/src/keystore.ts, `trikey/guardian-seed/v1`): a second machine's
 * generator, over a path no nostr relay sees. The guardian keys that mix with its own OS draw, so these
 * bytes can only add to its strength; the checks below catch a browser whose generator is plainly
 * broken rather than prove it good.
 */

export class BrowserRandomError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BrowserRandomError';
  }
}

/** `n` bytes (1 to 65,536) from `crypto.getRandomValues`. Throws `BrowserRandomError` if there is none, or on one byte value repeated. */
export function browserRandomBytes(n: number): Uint8Array {
  if (!Number.isInteger(n) || n < 1 || n > 65536) throw new BrowserRandomError('length must be an integer from 1 to 65536');
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (!c || typeof c.getRandomValues !== 'function') throw new BrowserRandomError('This browser has no secure random generator (crypto.getRandomValues).');
  const out = c.getRandomValues(new Uint8Array(n));
  // A short draw can repeat a byte by chance (1 in 2^120 at 16 bytes); a stuck or unfilled buffer always does.
  if (n >= 16 && out.every((b) => b === out[0])) throw new BrowserRandomError("This browser's random generator returned a constant value.");
  return out;
}

/** `n` random bytes as lowercase hex. */
export function browserRandomHex(n: number): string {
  const bytes = browserRandomBytes(n);
  let s = '';
  for (const b of bytes) s += b.toString(16).padStart(2, '0');
  bytes.fill(0);
  return s;
}
