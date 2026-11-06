/**
 * The first-run setup code, on every platform (TRIKEY_PLATFORM set; DESIGN.md, "First run").
 *
 * Before setup there is no passphrase: whoever reaches the port first could press "Set up" and become the owner of
 * key 3 (and of the unlock passphrase), before the real owner opens the page. On plain Docker nothing stands in front
 * of the page; on Umbrel and Start9 the platform's login does, but only on its own path: other apps' containers on the
 * same box reach the guardian's port directly (security review 2026-11, finding 3). So until setup completes, the
 * guardian asks for a one-time code that only the box's owner can read: it prints it in its own log, as Jupyter prints
 * its token (reading a container's log takes the access only the owner has), and on Start9 the package hands it in
 * (TRIKEY_SETUP_CODE) and shows it in an action. Requests from the platform's own login proxy need no code
 * (trusted-proxy.ts): on Umbrel the owner never sees it.
 *
 * The code is 16 characters of Crockford base32 (80 bits from the OS generator), shown in four groups. Made here, it is
 * new at every start and kept in memory only, so a restart prints a new one. Input is compared without regard to case,
 * spaces and dashes, with Crockford's look-alikes folded (O is 0, I and L are 1). It guards setup only: once the
 * guardian is set up, the unlock passphrase is the login (sessions.ts).
 */
import { timingSafeEqual } from 'node:crypto';
import { secureRandomBytes } from '@trikey/core/random';

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export const SETUP_CODE_LENGTH = 16;
/** A setup code in canonical form (`normalizeSetupCode`). */
export const SETUP_CODE_RE = /^[0-9A-HJKMNP-TV-Z]{16}$/;

/** The canonical form of what someone typed: upper case, separators dropped, look-alikes folded. */
export function normalizeSetupCode(input: string): string {
  return input
    .toUpperCase()
    .replace(/[\s\-_.]/g, '')
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1');
}

export class SetupCode {
  /** The code as printed: `XXXX-XXXX-XXXX-XXXX`. */
  readonly code: string;
  private readonly canonical: Buffer;

  /**
   * `preset`: a code handed in by the platform (TRIKEY_SETUP_CODE, already checked by config.ts) instead of a new one.
   * `random`: a test seam.
   */
  constructor(random: (n: number) => Uint8Array = secureRandomBytes, preset?: string) {
    if (preset !== undefined) {
      const c = normalizeSetupCode(preset);
      if (!SETUP_CODE_RE.test(c)) throw new Error('setup code: 16 characters of Crockford base32');
      this.canonical = Buffer.from(c, 'ascii');
      this.code = c.match(/.{4}/g)!.join('-');
      return;
    }
    const bytes = random((SETUP_CODE_LENGTH * 5) / 8);
    let bits = 0;
    let value = 0;
    let out = '';
    for (const b of bytes) {
      value = (value << 8) | b;
      bits += 8;
      while (bits >= 5) {
        out += ALPHABET[(value >>> (bits - 5)) & 31];
        bits -= 5;
      }
      value &= (1 << bits) - 1;
    }
    bytes.fill(0);
    this.canonical = Buffer.from(out, 'ascii');
    this.code = out.match(/.{4}/g)!.join('-');
  }

  /** Whether `input` is this code. Constant time for inputs of the right length. */
  matches(input: unknown): boolean {
    if (typeof input !== 'string' || input.length > 64) return false;
    const given = Buffer.from(normalizeSetupCode(input), 'utf8');
    return given.length === this.canonical.length && timingSafeEqual(given, this.canonical);
  }
}
