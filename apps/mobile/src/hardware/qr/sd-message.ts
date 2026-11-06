/**
 * Message signing from a microSD card (docs/design/hardware-auth-path.md §7, "microSD").
 *
 * Passport (2nd generation) and Krux refuse Trikey's key (`m/48'/c'/a'/2'/0/0`) over a text QR, because their QR flows
 * take the address type from the path's purpose and 48 is multisig. Their microSD flows take the address type from the
 * file instead, so they sign at that path. The phone writes the request file, the owner copies it to the card, signs on
 * the device, and brings back the signed file the device wrote next to it. Read from the firmware sources:
 *
 * - **Passport gen 2** (passport2 83d1d576, `flows/health_check_microsd_flow.py`, `health_check_common_flow.py`,
 *   `utils.py` `validate_sign_text`): Account Tools > Sign a Message > Sign with microSD lists every file whose name
 *   has no `-signed`. A file of 2 lines (`splitlines`, so `\n` or `\r\n`), the text then the path, signs with the
 *   default legacy (P2PKH) address type; a third line would name another type. The whole file is at most 4096 bytes
 *   (`MSG_SIGNING_MAX_LENGTH`), the text printable ASCII with no space at either end and at most 3 in a row, the path
 *   starts with `m` (`h` steps are fine: `cleanup_deriv_path`). It shows the text in full (scrolled to the end) and the
 *   address, signs (trezor-crypto, RFC 6979), and writes `<name>-signed-001.<ext>` (the next free number) next to it:
 *   an armored block with the text, the address and the base64 signature. A name needs an extension (`pick_filename`).
 *   It shows no QR of the answer.
 * - **Krux** (krux 28d14c2, `pages/home_pages/sign_message_ui.py` `_sign_at_address_from_sd`): Sign > Message > Load
 *   from SD card. The last non-empty line is the address type (`p2pkh`, `p2wpkh`, `p2sh-p2wpkh` or `p2tr`), the line
 *   before it the path (`m/` then numbers with `'`, `h` or `H`), the lines before that the text; every line is stripped.
 *   It shows the text (about 10 lines, then "…") and the address, signs (embit `ecdsa_sign_recoverable`, header 31-34
 *   whatever the type) and offers "Sign to QR code" (a QR of the base64 signature) or "Sign to SD card"
 *   (`<name>-signed.txt`, the armored block, the name editable on the device). A file it cannot read as that is signed
 *   as a hash with the account key instead ("SHA256:" on screen, a `.sig` file): never accepted here.
 *
 * Trikey asks Krux for `p2pkh`: its header byte (31-34) is P2PKH's in BIP 137, so the armored file checks in any BIP 137
 * tool, and the address is the legacy one the other devices show for this key. Nothing here was tested on a device:
 * docs/alpha-test-plan.md lists the steps.
 */
import type { QrModel } from '@trikey/wallet';
import { HardwareError } from '../errors';
import { formatPath, parsePath } from '../common/path';
import { parseAnswerText, type MessageAnswer } from './message';

const bad = (message: string) => new HardwareError('invalid-response', message);

/** The microSD request file formats, by model. */
export type SdFormat = 'passport' | 'krux';

/** The request file format of `model`, or undefined if it signs no text from a microSD card. */
export function sdFormatOf(model: QrModel | undefined): SdFormat | undefined {
  return model === 'passport' ? 'passport' : model === 'krux' ? 'krux' : undefined;
}

/** Passport's `MSG_SIGNING_MAX_LENGTH`: the largest message file it reads, in bytes. */
export const PASSPORT_MAX_FILE_BYTES = 4096;
/** The largest signed file the phone reads (an armored block of a 240-character text is about 450 bytes). */
export const MAX_SIGNED_FILE_BYTES = 64 * 1024;

/** A file for the device: its name and contents. */
export interface SdRequestFile {
  name: string;
  text: string;
}

/** What the text is for, in the file name. */
const STEMS: Record<string, string> = { pairing: 'pair', approval: 'approve', 'recovery-access': 'access', notes: 'notes', unlock: 'unlock' };

/**
 * The request file `format` reads to sign `text` with the key at `path`. The name is plain (letters, digits, `-`,
 * `.txt`; never `-signed`, which both devices hide from their file lists), says what it is for and, when the same text
 * is signed twice, which round (`trikey-notes-1of2.txt`), so the owner picks the right signed file back.
 */
export function sdRequestFile(format: SdFormat, path: string, text: string, opts: { purpose?: string; round?: { n: number; of: number } } = {}): SdRequestFile {
  if (!/^[\x20-\x7e]+$/.test(text)) throw new HardwareError('invalid-request', 'Only plain printable ASCII on one line can be signed from a microSD card.');
  if (text !== text.trim()) throw new HardwareError('invalid-request', 'A text that starts or ends with a space cannot be signed from a microSD card.');
  // Passport reads a file that starts like this as a one-line Sparrow request, whose address type comes from the path.
  if (/^signmessage /.test(text)) throw new HardwareError('invalid-request', 'This text cannot be signed from a microSD card.');
  const shownPath = formatPath(parsePath(path), 'h');
  const body = format === 'passport' ? `${text}\n${shownPath}\n` : `${text}\n${shownPath}\np2pkh\n`;
  if (format === 'passport' && new TextEncoder().encode(body).length > PASSPORT_MAX_FILE_BYTES)
    throw new HardwareError('invalid-request', `The text is too long for Passport’s message file (${PASSPORT_MAX_FILE_BYTES} bytes at most).`);
  const stem = (opts.purpose && STEMS[opts.purpose]) || 'sign';
  const round = opts.round && opts.round.of > 1 ? `-${opts.round.n}of${opts.round.of}` : '';
  return { name: `trikey-${stem}${round}.txt`, text: body };
}

/** The name without its extension: `trikey-pair` for `trikey-pair.txt`. */
export function baseName(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(0, dot) : name;
}

/** A file the owner picked: its name (as the phone's file chooser gives it) and bytes. */
export interface PickedDeviceFile {
  name: string;
  bytes: Uint8Array;
}

/**
 * Reads the signed file the owner picked, for the request `request`. Refuses, in words fit for a hint, a file that is not
 * a signed message: Trikey's own request file, a Krux `.sig` or `.pub` file (it signed something other than the text),
 * anything binary or too large, and, when the same text is signed twice, the signed file of the other round. The
 * signature is not checked here: `checkMessageAnswer` does that.
 */
export function parseSignedFile(file: PickedDeviceFile, request: SdRequestFile, label: string, round?: { n: number; of: number }): MessageAnswer {
  const lower = file.name.toLowerCase();
  if (file.bytes.length === 0) throw bad('That file is empty.');
  if (file.bytes.length > MAX_SIGNED_FILE_BYTES) throw bad('That file is too large to be a signed message.');
  if (/\.sig$/.test(lower))
    throw bad(
      `That is a .sig file: your ${label} signed the file’s hash with another key, because it did not read the file as Trikey’s text. Save Trikey’s file again, sign it with Sign > Message > Load from SD card, and choose Sign to SD card.`,
    );
  if (/\.pub$/.test(lower)) throw bad('That is a public key file, not the signed message. Pick the file whose name ends in -signed.txt.');
  if (round && round.of > 1) {
    const mine = baseName(request.name).toLowerCase();
    const other = Array.from({ length: round.of }, (_, i) => i + 1)
      .filter((n) => n !== round.n)
      .map((n) => mine.replace(new RegExp(`-${round.n}of${round.of}$`), `-${n}of${round.of}`));
    if (other.some((o) => lower.startsWith(o)))
      throw bad(`That is the signed file of the other round. This is round ${round.n} of ${round.of}: sign ${request.name} on your ${label} and pick the file it writes for it.`);
  }
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(file.bytes);
  } catch {
    throw bad('That file is not a signed message (it is not text).');
  }
  const norm = (t: string) => t.replace(/\r\n?/g, '\n').trim();
  if (norm(text) === norm(request.text))
    throw bad(`That is the file Trikey made (the request), not the signed one. Pick the file your ${label} wrote next to it: its name has -signed.`);
  return parseAnswerText(text, 'file');
}
