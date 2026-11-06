/**
 * Coldcards over NFC: the hardware kind `coldcard-nfc`.
 *
 * The Coldcard Mk4 has no camera, so it cannot use Trikey's QR codes; it and the Coldcard Q have NFC. The phone talks
 * to Coldcard's NFC Tools (firmware `shared/nfc.py`): the Coldcard plays an NFC Forum Type 5 tag (ISO 15693) holding NDEF
 * records, which the phone reads, or which it offers empty for the phone to write. Over it the device shares its BIP 48
 * key export, imports the 2-of-3 wallet, signs payments (PSBTs) and signs Trikey's texts (BIP 137 at `authKeyPath`),
 * so a Coldcard over NFC can do everything a Ledger or Trezor does for Trikey. The phone side is
 * `apps/mobile/src/hardware/nfc`; docs/design/hardware-auth-path.md, "Coldcard over NFC", has the protocol and the
 * firmware references. **Not tested on a device yet** (docs/alpha-test-plan.md).
 *
 * Which Coldcard it is only changes the words on the NFC screens (the Mk4 shares over NFC with its 3 key, the Q with
 * its NFC key). It is kept in the hardware record's `qrModel`, `coldcard-mk4` or `coldcard-q`.
 */
import type { HardwareKind } from './platform.js';
import { messageProblemFor, type QrModel } from './qr-devices.js';

/** Kinds that talk over NFC. */
export const NFC_KINDS: readonly HardwareKind[] = ['coldcard-nfc'];

export const NFC_MODELS = ['coldcard-mk4', 'coldcard-q'] as const satisfies readonly QrModel[];
export type NfcModel = (typeof NFC_MODELS)[number];

export const isNfcModel = (m: unknown): m is NfcModel => typeof m === 'string' && (NFC_MODELS as readonly string[]).includes(m);

export interface NfcModelInfo {
  model: NfcModel | undefined;
  /** "Coldcard Mk4"; "Coldcard" when the model is not known. */
  name: string;
  /** One line for the picker. */
  detail: string;
  /** What to press on the device to share what it shows over NFC. */
  shareKey: string;
}

export const NFC_MODEL_INFO: Readonly<Record<NfcModel, NfcModelInfo>> = {
  'coldcard-mk4': { model: 'coldcard-mk4', name: 'Coldcard Mk4', detail: 'Over NFC: payments and Trikey’s texts', shareKey: 'press 3' },
  'coldcard-q': { model: 'coldcard-q', name: 'Coldcard Q', detail: 'Over NFC, instead of QR codes', shareKey: 'press the NFC key' },
};

const ANY_COLDCARD: NfcModelInfo = { model: undefined, name: 'Coldcard', detail: 'Mk4 or Q, over NFC', shareKey: 'press 3 on a Mk4, the NFC key on a Q' };

/** The table entry of `model`; a generic "Coldcard" for anything else. */
export function nfcModelInfo(model: QrModel | undefined): NfcModelInfo {
  return isNfcModel(model) ? NFC_MODEL_INFO[model] : ANY_COLDCARD;
}

/**
 * Why `text` cannot be signed by a Coldcard, or undefined when it can: the same rules as over QR (`shared/msgsign.py`
 * `validate_text_for_signing`: 2 to 240 printable ASCII characters, no space at either end, never three in a row).
 */
export function nfcMessageProblem(text: string): string | undefined {
  return messageProblemFor('coldcard-q', text);
}
