/**
 * The first-run setup code, for a guardian on plain Docker (TRIKEY_PLATFORM=docker, the default).
 *
 * On Umbrel and Start9 the platform's login stands in front of the web UI, so only the box's owner sees the first-run
 * screen. On plain Docker nothing does: whoever reaches the port first could press "Set up" and become the owner of
 * key 3 (and of the unlock passphrase), before the real owner opens the page. So until setup completes, the guardian
 * asks for a one-time code that it prints in its own log, as Jupyter prints its token: reading the container's log
 * takes the Docker access only the box's owner has.
 *
 * The code is 16 characters of Crockford base32 (80 bits from the OS generator), shown in four groups. It is made
 * at every start and kept in memory only, so a restart prints a new one. Input is compared without regard to case,
 * spaces and dashes, with Crockford's look-alikes folded (O is 0, I and L are 1). It guards setup only: once the
 * guardian is set up, the unlock passphrase is the login (sessions.ts).
 */
import { timingSafeEqual } from 'node:crypto';
import { secureRandomBytes } from '@trikey/core/random';

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export const SETUP_CODE_LENGTH = 16;

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

  constructor(random: (n: number) => Uint8Array = secureRandomBytes) {
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
