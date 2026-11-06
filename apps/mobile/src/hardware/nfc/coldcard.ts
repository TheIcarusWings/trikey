/**
 * What the phone and a Coldcard (Mk4, Q) exchange over NFC, record by record. Read from Coldcard's firmware at
 * 09766a1 (github.com/Coldcard/firmware, 2026-11-04): `shared/nfc.py`, `shared/ndef.py`, `docs/nfc-coldcard.md`.
 *
 * The Coldcard plays an NFC Forum Type 5 tag (ISO 15693, an ST25DV64KC: 8 KiB). It is either *sharing* (it wrote NDEF
 * records and the phone reads them) or *receiving* (it offers an empty, writable tag, `CC_WR_FILE`, waits for the phone
 * to write, then reads it once the radio has been quiet for 3 seconds: `start_nfc_rx`). Exchanges:
 *
 * | What | Direction | Records | Coldcard menu |
 * |---|---|---|---|
 * | Key export | read | `application/json`: the multisig export `{"p2wsh_deriv", "p2wsh", "xfp", ...}` (`share_json`); a text record when the owner shares another export | Settings › Multisig Wallets › Export XPUB, then NFC |
 * | Wallet registration | write | text: the Coldcard multisig setup file (`Name:`, `Policy:`, `Derivation:`, `XFP: xpub`) | Settings › Multisig Wallets › Import, then NFC (`import_multisig_nfc`) |
 * | Payment to sign | write | `urn:nfc:ext:bitcoin.org:sha256` (32 bytes), then `urn:nfc:ext:bitcoin.org:psbt` (binary PSBT) | NFC Tools › Sign PSBT (`start_psbt_rx`) |
 * | Signed payment | read | text label, `bitcoin.org:sha256`, `bitcoin.org:psbt` (`share_psbt`); or when it finalized: text, `bitcoin.org:txid`, `bitcoin.org:sha256`, `bitcoin.org:txn` (`share_signed_txn`) | shown right after signing |
 * | Text to sign | write | text: `signmessage m/48h/... ascii:<text>` (`start_msg_sign`, `parse_msg_sign_request`) | NFC Tools › Sign Message |
 * | Signature | read | text: the armored block, `-----BEGIN BITCOIN SIGNED MESSAGE-----` (`msg_sign_done`) | shown right after signing |
 *
 * Limits: the Coldcard shares nothing of 8000 bytes or more (`MAX_NFC_SIZE`), so a signed PSBT must stay under that;
 * the tag holds 8 KiB, so what the phone writes must too. The sha256 record lets the Coldcard refuse a PSBT that was
 * damaged on the way ("PSBT checksum mismatch", `auth.py`), and lets the phone check what it reads back.
 */
import { sha256 } from '@noble/hashes/sha2.js';
import { HardwareError } from '../errors';
import { parseDeviceExport, type DeviceKeyExport } from '../qr/export';
import { parseMessageAnswer, signMessageRequest, type MessageAnswer } from '../qr/message';
import type { SignedFromQr } from '../qr/payload';
import { encodeNdefMessage, externalRecord, readTextRecord, recordTypeName, textRecord, type NdefRecord } from './ndef';

/** `shared/nfc.py`: `MAX_NFC_SIZE = const(8000)`; the Coldcard shares nothing this big or bigger. */
export const COLDCARD_NFC_MAX_SIZE = 8000;
/** About what a Coldcard's signature adds to a PSBT for one input: the pubkey, a DER signature and their key-value framing. */
export const PSBT_SIGNATURE_BYTES = 110;

export const PSBT_TYPE = 'bitcoin.org:psbt';
export const TXN_TYPE = 'bitcoin.org:txn';
export const SHA256_TYPE = 'bitcoin.org:sha256';
export const TXID_TYPE = 'bitcoin.org:txid';

const bad = (message: string) => new HardwareError('invalid-response', message);
const PSBT_MAGIC = [0x70, 0x73, 0x62, 0x74, 0xff];
const isPsbt = (b: Uint8Array) => PSBT_MAGIC.every((x, i) => b[i] === x);
const sameBytes = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i]);

function tooBig(what: string, bytes: number): HardwareError {
  return new HardwareError(
    'invalid-request',
    `${what} is ${bytes} bytes, too large for the Coldcard's NFC (under ${COLDCARD_NFC_MAX_SIZE} bytes). Spend fewer coins at once (choose them in Coin control) and try again.`,
  );
}

/**
 * The NDEF message the phone writes for "NFC Tools › Sign PSBT": the PSBT's SHA-256, then the binary PSBT, as the
 * Coldcard itself shares one. `signingInputs`: how many inputs the Coldcard will sign, to check the signed PSBT it
 * shares back will still fit its limit.
 */
export function psbtRequest(psbt: Uint8Array, signingInputs: number): Uint8Array {
  if (!isPsbt(psbt)) throw new HardwareError('invalid-request', 'That is not a PSBT.');
  const signed = psbt.length + signingInputs * PSBT_SIGNATURE_BYTES;
  if (signed >= COLDCARD_NFC_MAX_SIZE) throw tooBig('The signed payment would be about', signed);
  return encodeNdefMessage([externalRecord(SHA256_TYPE, sha256(psbt)), externalRecord(PSBT_TYPE, psbt)]);
}

/** The NDEF message for "Settings › Multisig Wallets › Import" over NFC: the Coldcard multisig setup file as text. */
export function walletRequest(setupFile: string): Uint8Array {
  // `import_multisig_nfc` takes the first record of 70 bytes or more that holds "pub" or "multi(".
  if (setupFile.length < 70 || !setupFile.includes('pub')) throw new HardwareError('invalid-request', 'That is not a multisig setup file.');
  const message = encodeNdefMessage([textRecord(setupFile)]);
  if (message.length >= COLDCARD_NFC_MAX_SIZE) throw tooBig('The wallet file', message.length);
  return message;
}

/**
 * The NDEF message for "NFC Tools › Sign Message": one text record `signmessage <path with h> ascii:<text>`, the
 * Sparrow format `parse_msg_sign_request` reads first (the same line Trikey shows as a QR code). For a `48'` path the
 * Coldcard signs as a legacy (P2PKH) key and shares the armored block back.
 */
export function messageRequest(path: string, text: string): Uint8Array {
  return encodeNdefMessage([textRecord(signMessageRequest(path, text))]);
}

/** The text of every text record, in order. */
function texts(records: readonly NdefRecord[]): string[] {
  return records.flatMap((r) => {
    const t = readTextRecord(r);
    return t === undefined ? [] : [t];
  });
}

const kindsOf = (records: readonly NdefRecord[]) => records.map(recordTypeName).filter(Boolean).join(', ') || 'nothing Trikey reads';

/**
 * The device's key export from what it shares: the `application/json` multisig export, or the same JSON or a descriptor
 * in a text record (a Coldcard shares any QR it shows as text over NFC).
 */
export function keyExportFromNdef(records: readonly NdefRecord[]): DeviceKeyExport {
  let firstError: unknown;
  for (const r of records) {
    const name = recordTypeName(r);
    let text: string | undefined;
    if (name === 'application/json') text = new TextDecoder().decode(r.payload);
    else text = readTextRecord(r);
    if (text === undefined) continue;
    try {
      return parseDeviceExport({ type: 'text', text });
    } catch (e) {
      firstError ??= e;
    }
  }
  if (firstError instanceof HardwareError && texts(records).some((t) => /signed message|psbt/i.test(t)))
    throw bad('That is not a key export. On the Coldcard, open Settings › Multisig Wallets › Export XPUB and share it over NFC.');
  if (firstError instanceof HardwareError) throw firstError;
  throw bad(`The Coldcard shared ${kindsOf(records)}, not a key export. On the Coldcard, open Settings › Multisig Wallets › Export XPUB and share it over NFC.`);
}

/**
 * The signed PSBT, or the finished transaction, from what the Coldcard shares after signing. When a SHA-256 record
 * precedes it, it must match: anything else was damaged on the way.
 */
export function signedFromNdef(records: readonly NdefRecord[]): SignedFromQr {
  let digest: Uint8Array | undefined;
  for (const r of records) {
    const name = recordTypeName(r);
    if (name === `urn:nfc:ext:${SHA256_TYPE}`) {
      if (r.payload.length !== 32) throw bad('The checksum the Coldcard shared is not 32 bytes.');
      digest = r.payload;
      continue;
    }
    const kind = name === `urn:nfc:ext:${PSBT_TYPE}` ? 'psbt' : name === `urn:nfc:ext:${TXN_TYPE}` ? 'tx' : undefined;
    if (!kind) continue;
    if (digest && !sameBytes(digest, sha256(r.payload))) throw bad('The signed transaction did not arrive whole (its checksum does not match). Hold the phone still against the Coldcard and read it again.');
    if (kind === 'psbt' && !isPsbt(r.payload)) throw bad('The Coldcard shared a PSBT record that is not a PSBT.');
    return { kind, bytes: r.payload };
  }
  if (texts(records).some((t) => t.includes('BEGIN BITCOIN SIGNED MESSAGE'))) throw bad('That is a signed message, not the signed payment.');
  throw bad(`The Coldcard shared ${kindsOf(records)}, not a signed payment. Sign the payment on the Coldcard first; it then shares it over NFC.`);
}

/** The Coldcard's answer to a text it signed: the armored block in a text record (`msg_sign_done`). */
export function messageAnswerFromNdef(records: readonly NdefRecord[]): MessageAnswer {
  const all = texts(records);
  const armored = all.find((t) => t.includes('BEGIN BITCOIN SIGNED MESSAGE'));
  if (armored !== undefined) return parseMessageAnswer({ type: 'text', text: armored });
  if (all.some((t) => t.startsWith('signmessage '))) throw bad('That is still Trikey’s request on the Coldcard. Approve it on the Coldcard first, then read the signature it shares.');
  for (const t of all) {
    try {
      return parseMessageAnswer({ type: 'text', text: t });
    } catch {
      /* not this one */
    }
  }
  throw bad(`The Coldcard shared ${kindsOf(records)}, not a message signature.`);
}
