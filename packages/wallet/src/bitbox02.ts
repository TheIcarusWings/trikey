/**
 * A BitBox02 or BitBox02 Nova: the hardware kind `bitbox02`. The phone speaks the BitBox02's own protocol (64-byte U2F HID
 * reports, a Noise_XX encrypted channel paired with a code shown on both screens, protocol buffers) over USB-C on Android
 * (both models) or Bluetooth LE (the Nova, on Android and iOS). It reads the BIP 48 account key, registers the 2-of-3
 * wallet, co-signs payments with anti-klepto and signs Trikey's texts at `m/48'/c'/0'/2'/0/0` (firmware 9.27.1 and later,
 * "External service key"), so a BitBox02 does everything a Ledger does for Trikey. The phone side is
 * `apps/mobile/src/hardware/bitbox02`; docs/design/hardware-auth-path.md §10 has the protocol with firmware references.
 * **Not tested on a device yet** (docs/alpha-test-plan.md, step 18i).
 *
 * Notes and hardware unlock need the same signature every time. A BitBox02 gives it when the phone sends no anti-klepto
 * commitment (the firmware then uses a host nonce of 32 zero bytes: deterministic, but not plain RFC 6979), so its
 * signature differs from a Ledger's, Trezor's, Coldcard's or Jade's for the same seed and text: notes and an unlock slot
 * made with a BitBox02 open only with a BitBox02 (with that seed), and the reverse.
 */

/** The firmware that signs a text with a key under `m/48'` (bitbox02-firmware CHANGELOG, v9.27.1, 2026-08-31). */
export const BITBOX02_MIN_FIRMWARE = [9, 27, 1] as const;

/** A BitBox02 refuses a message longer than this (`signmsg.rs` `MAX_MESSAGE_SIZE`); Trikey's texts are at most 240. */
export const BITBOX02_MAX_MESSAGE = 1024;

/** Why `text` cannot be signed by a BitBox02, or undefined when it can: one line of printable ASCII, as every Trikey text. */
export function bitbox02MessageProblem(text: string): string | undefined {
  if (!/^[\x20-\x7e]+$/.test(text)) return 'The text is not plain printable ASCII on one line.';
  if (text.length > BITBOX02_MAX_MESSAGE) return `The text is longer than the BitBox02 signs (${BITBOX02_MAX_MESSAGE} characters).`;
  return undefined;
}

/** The sentence for notes and hardware unlock on a BitBox02: its signatures are its own. */
export const BITBOX02_SIGNATURE_NOTE =
  'A BitBox02 signs this text its own way, unlike other brands: if you later restore your recovery phrase on a hardware wallet of another brand, turn notes on again and set up the hardware unlock again with it.';
