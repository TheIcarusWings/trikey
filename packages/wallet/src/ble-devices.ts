/**
 * A Blockstream Jade or Jade Plus over Bluetooth: the hardware kind `jade-ble`.
 *
 * Jade already works with Trikey in QR mode (kind `jade` or `qr` with the model `jade`, qr-devices.ts). Over Bluetooth
 * the phone talks to Jade's own RPC (CBOR messages, firmware `main/process/*.c`, client `jadepy/jade.py`): it unlocks
 * the Jade (the owner types the PIN on the Jade, the phone relays the PIN check to the PIN server the Jade names), reads
 * its keys, registers the 2-of-3 wallet (`register_multisig`), signs payments (`sign_psbt`) and signs Trikey's texts
 * (`sign_message`, BIP 137, RFC 6979), so a Jade over Bluetooth does everything a Ledger does for Trikey. The phone side
 * is `apps/mobile/src/hardware/jade`; docs/design/hardware-auth-path.md, "Jade over Bluetooth", has the protocol and the
 * firmware references. **Not tested on a device yet** (docs/alpha-test-plan.md, step 18h).
 */
import type { HardwareKind } from './platform.js';

/** Kinds that talk over Bluetooth with their own protocol (Ledger has its own SDK and kind). */
export const BLE_KINDS: readonly HardwareKind[] = ['jade-ble'];

/**
 * How many characters of a text Jade shows before it cuts the rest with "..." (firmware `main/ui.h`
 * `MAX_DISPLAY_MESSAGE_LEN` = 192, `main/process/sign_message.c` `confirm_sign_message`: 188 characters, then "...").
 * It signs the whole text, and shows its hash.
 */
export const JADE_DISPLAY_LENGTH = 188;

/** Why `text` cannot be signed by a Jade over Bluetooth, or undefined when it can: one line of printable ASCII, as every Trikey text. */
export function jadeMessageProblem(text: string): string | undefined {
  if (!/^[\x20-\x7e]+$/.test(text)) return 'The text is not plain printable ASCII on one line.';
  return undefined;
}
