/**
 * Air-gapped (QR) hardware wallets by model, and what each can do for Trikey.
 *
 * Every QR device co-signs payments (PSBTs over animated QR codes). What differs is message signing: pairing with a
 * guardian, approvals that loosen the rules, recovery access, notes that survive recovery and hardware unlock all need
 * the device to BIP 137-sign a one-line text with the authorization key at `m/48'/<coin>'/<account>'/2'/0/0`
 * (`authKeyPath`). Over QR that is a text QR `signmessage <path> ascii:<text>`, answered by a QR of the base64 signature
 * (the format Sparrow and Specter use). Which firmware parses it, signs at a BIP 48 path, and shows the text was read
 * from each vendor's firmware source (docs/design/hardware-auth-path.md, "QR devices"); **none of it has been tested on
 * a device yet** (docs/alpha-test-plan.md).
 *
 * Passport (2nd generation) and Krux refuse that path over a text QR but sign it from a file on a microSD card: the phone
 * writes the request file, the owner carries it to the device on the card and brings the signed file back
 * (`messageMethod: 'microsd'`, `apps/mobile/src/hardware/qr/sd-message.ts`). That is fine for pairing, approvals,
 * recovery access and notes, but not for hardware unlock (a card round trip after every guardian restart).
 *
 * The model is the owner's choice when the device is added (the app may suggest one from the device's key export,
 * `detectQrModel` in the app). Wallets made before models existed read as `other` until the owner sets it in Settings.
 */
import type { HardwareKind } from './platform.js';

export const QR_MODELS = ['coldcard-q', 'coldcard-mk4', 'jade', 'keystone-3', 'passport-prime', 'passport', 'seedsigner', 'krux', 'specter-diy', 'other'] as const;
export type QrModel = (typeof QR_MODELS)[number];

export const isQrModel = (m: unknown): m is QrModel => typeof m === 'string' && (QR_MODELS as readonly string[]).includes(m);

/** Kinds that talk over QR codes (`apps/mobile/src/hardware/qr`). */
export const QR_KINDS: readonly HardwareKind[] = ['qr', 'coldcard', 'jade'];

/**
 * How a model signs Trikey's texts: `qr-text` (a `signmessage` text QR, answered by a QR), `microsd` (a request file on
 * a microSD card, answered by a signed file), or `none`. Read it with `qrMessageMethod`.
 */
export type QrMessageMethod = 'qr-text' | 'microsd' | 'none';

export interface QrModelInfo {
  model: QrModel;
  /** "Coldcard Q" */
  name: string;
  /** One line for the picker. */
  detail: string;
  /** It works over QR codes at all: it has a camera and scans a PSBT. False only for the Coldcard Mk4. */
  qr: boolean;
  /** It signs a text with the authorization key (by QR code or from a microSD card), so it can set up and approve a guardian wallet. */
  signsMessages: boolean;
  /** How it signs a text, when not over a text QR (`qrMessageMethod` gives the answer for every model). */
  messageMethod?: QrMessageMethod;
  /** Why the guardian is not unlocked with it although it signs texts, in words for the owner (microSD models). */
  unlockWhyNot?: string;
  /** microSD models: it can also show the signature as a QR code after signing the file (Krux). */
  answersByQr?: true;
  /** Why it cannot (when `qr` or `signsMessages` is false), in words for the owner. */
  whyNot?: string;
  /** The longest text its firmware signs, in characters, where the firmware has a limit (Coldcard: 240). */
  maxMessageLength?: number;
  /** About how many characters of the text its screen shows before it cuts the rest (Jade: about 188). */
  displayLength?: number;
  /** Coldcard's text rules: 2 or more characters, no space at either end, never three spaces in a row. */
  coldcardTextRules?: true;
  /** It refuses (Passport) or strips (Krux) a space at either end of the text. */
  noEdgeSpaces?: true;
  /** The most spaces in a row it signs (Passport: 3). */
  maxSpaceRun?: number;
  /** Which address it shows next to the text for Trikey's key: legacy `1…` (P2PKH), or none. */
  showsAddress?: 'p2pkh' | 'none';
  /** It signs a message only from the account the path names, so the owner opens that account first (Passport Prime). */
  signsFromAccount?: true;
  /** What the owner does on the device to sign Trikey's text (`{account}` and `{path}` are filled in). */
  messageSteps?: readonly string[];
}

const SCAN_BACK = 'It then shows the signature as a QR code: tap "Scan the signature" here and point this camera at it.';

/** The capability table. Sources: each firmware's message-signing code, at the commits docs/design/hardware-auth-path.md lists. */
export const QR_MODEL_INFO: Readonly<Record<QrModel, QrModelInfo>> = {
  'coldcard-q': {
    model: 'coldcard-q',
    name: 'Coldcard Q',
    detail: 'Signs payments and Trikey’s texts by QR',
    qr: true,
    signsMessages: true,
    // shared/msgsign.py: MSG_SIGNING_MAX_LENGTH = 240, printable ASCII.
    maxMessageLength: 240,
    coldcardTextRules: true,
    showsAddress: 'p2pkh',
    messageSteps: [
      'On the Coldcard Q, press the QR key and scan this code. It reads it as a request to sign a message.',
      'Check the text, the path {path} and the address it shows (below), then press OK to sign.',
      'Choose to show the signature as a QR code. ' + SCAN_BACK,
    ],
  },
  'coldcard-mk4': {
    model: 'coldcard-mk4',
    name: 'Coldcard Mk4',
    detail: 'No camera: needs NFC or USB, not in Trikey yet',
    qr: false,
    signsMessages: false,
    whyNot: 'The Coldcard Mk4 has no camera, so it can’t scan Trikey’s QR codes. It needs NFC or USB, which Trikey doesn’t support yet.',
  },
  jade: {
    model: 'jade',
    name: 'Jade / Jade Plus',
    detail: 'In QR mode; signs payments and Trikey’s texts',
    qr: true,
    signsMessages: true,
    // main/ui.h: the text is cut after about 188 characters on screen (it signs all of it).
    displayLength: 188,
    showsAddress: 'none',
    messageSteps: [
      'Unlock Jade in QR mode, choose Scan QR and scan this code.',
      'Jade shows the text, the path {path} and a hash. A long text is cut after about 188 characters and ends with "...": the part it shows must match the start of the text below. Confirm to sign.',
      SCAN_BACK,
    ],
  },
  'keystone-3': {
    model: 'keystone-3',
    name: 'Keystone 3',
    detail: 'Signs payments and Trikey’s texts by QR',
    qr: true,
    signsMessages: true,
    // rust/apps/bitcoin/src/addresses: no address is derived for a BIP 48 path.
    showsAddress: 'none',
    messageSteps: [
      'On the Keystone 3, tap the scan icon and scan this code.',
      'Check the text and the path {path}. Keystone shows no address for this key; that is expected. Approve and enter your password.',
      SCAN_BACK,
    ],
  },
  'passport-prime': {
    model: 'passport-prime',
    name: 'Passport Prime',
    detail: 'Signs payments and Trikey’s texts by QR',
    qr: true,
    signsMessages: true,
    showsAddress: 'p2pkh',
    // gui-app-bitcoin/src/message_signing.rs: the path's account must be the account it signs from.
    signsFromAccount: true,
    messageSteps: [
      'On Passport Prime, open account {account} (the first account is 0), then scan this code.',
      'Check the text, the path {path} and the address it shows (below), then sign.',
      SCAN_BACK,
    ],
  },
  passport: {
    model: 'passport',
    name: 'Passport (2nd generation)',
    detail: 'Signs payments by QR, and Trikey’s texts from a microSD card',
    qr: true,
    signsMessages: true,
    // Its QR flow maps a 48'/…/2' path to P2WSH and stops (sign_electrum_message_flow.py); the microSD flow signs a 2-line
    // file (text, path) with the legacy address type (flows/health_check_microsd_flow.py, health_check_common_flow.py).
    messageMethod: 'microsd',
    unlockWhyNot: 'Passport signs Trikey’s texts only from a microSD card, and carrying a card back and forth after every guardian restart is too clunky, so unlocking with it is not offered. The passphrase unlocks your guardian.',
    // utils.py validate_sign_text: printable ASCII, no space at either end, at most 3 in a row; the whole file is at
    // most MSG_SIGNING_MAX_LENGTH = 4096 bytes, the path included (the file check in the app counts it exactly).
    maxMessageLength: 4000,
    noEdgeSpaces: true,
    maxSpaceRun: 3,
    showsAddress: 'p2pkh',
    messageSteps: [
      'Put the card in your Passport. Open any account, then Account Tools > Sign a Message > Sign with microSD, and pick {file}.',
      'Read the text to the end: it must be exactly the text above. Passport then asks to sign with an address: it must be the one below. Sign.',
      'Passport writes the signed file next to it, named {base}-signed- and a number. Put the card back in this phone’s reader (or copy that file over), then tap “Open the signed file” and pick it.',
    ],
  },
  seedsigner: {
    model: 'seedsigner',
    name: 'SeedSigner',
    detail: 'Signs payments; can’t set up a guardian wallet',
    qr: true,
    signsMessages: false,
    // helpers/embit_utils.py: "Not implemented" for 48h paths. Decided: co-signs payments only, no blind BIP 322 proof (DESIGN.md).
    whyNot: 'SeedSigner doesn’t sign messages with a multisig key (a path that starts m/48\'), and that is the key Trikey’s guardian needs. It co-signs payments only.',
  },
  krux: {
    model: 'krux',
    name: 'Krux',
    detail: 'Signs payments by QR, and Trikey’s texts from a microSD card',
    qr: true,
    signsMessages: true,
    // Its QR flow refuses purpose 48 ("Unsupported script type"); the microSD flow signs a 3-line file (text, path, single-sig
    // address type) at any path (pages/home_pages/sign_message_ui.py, _sign_at_address_from_sd).
    messageMethod: 'microsd',
    unlockWhyNot: 'Krux signs Trikey’s texts only from a microSD card, and carrying a card back and forth after every guardian restart is too clunky, so unlocking with it is not offered. The passphrase unlocks your guardian.',
    // It strips each line, so a space at either end would change the text it signs.
    noEdgeSpaces: true,
    // display.py to_lines: about 10 lines; on the M5StickV (16 characters a line) about the first 120 characters show, then
    // "…"; on the larger screens about 210.
    displayLength: 120,
    showsAddress: 'p2pkh',
    answersByQr: true,
    messageSteps: [
      'Put the card in your Krux. Choose Sign > Message > Load from SD card, and pick {file}.',
      'Krux shows the text and an address: the text must match the one above (a small screen cuts it with "…"), the address the one below. If it shows "SHA256:" and a long number instead, stop: it did not read the file. Sign.',
      'Choose Sign to SD card and keep the name it suggests ({base}-signed.txt), bring the card back and tap “Open the signed file”. Or choose Sign to QR code and tap “Scan the signature instead”.',
    ],
  },
  'specter-diy': {
    model: 'specter-diy',
    name: 'Specter DIY',
    detail: 'Signs payments and Trikey’s texts by QR',
    qr: true,
    signsMessages: true,
    showsAddress: 'p2pkh',
    messageSteps: [
      'On Specter DIY, tap Scan QR code and scan this code.',
      'Check the text, the path {path} and the address it shows (below), then confirm.',
      SCAN_BACK,
    ],
  },
  other: {
    model: 'other',
    name: 'Other QR device',
    detail: 'Signs payments; Trikey doesn’t know if it signs texts',
    qr: true,
    signsMessages: false,
    whyNot: 'Trikey doesn’t know whether this device signs a text by QR code. If it is one of the devices Trikey lists, pick it in Settings.',
  },
};

/** The table entry of `model` (`other` for anything unknown). */
export function qrModelInfo(model: QrModel | undefined): QrModelInfo {
  return QR_MODEL_INFO[model && isQrModel(model) ? model : 'other'];
}

/** How `model` signs Trikey's texts (`none` for a model that does not). */
export function qrMessageMethod(model: QrModel | undefined): QrMessageMethod {
  const info = qrModelInfo(model);
  if (!info.qr || !info.signsMessages) return 'none';
  return info.messageMethod ?? 'qr-text';
}

/** Whether `model` can unlock the guardian: it signs texts, and not from a microSD card (a card round trip per restart). */
export function qrModelUnlocks(model: QrModel | undefined): boolean {
  const method = qrMessageMethod(model);
  return method !== 'none' && method !== 'microsd';
}

/** The model of a record made before models existed: a `jade` kind is a Jade, a `coldcard` kind over QR a Coldcard Q (the Mk4 has no camera). */
export function defaultQrModelOf(kind: HardwareKind): QrModel | undefined {
  if (kind === 'jade') return 'jade';
  if (kind === 'coldcard') return 'coldcard-q';
  if (kind === 'qr') return 'other';
  return undefined;
}

/**
 * The shortest message-signing limit of any QR model that signs messages: no text Trikey signs may be longer (a test
 * checks every text builder against it). Coldcard's 240 is also `MAX_APPROVAL_MESSAGE_LENGTH`.
 */
export const MIN_QR_MESSAGE_LIMIT = Math.min(...Object.values(QR_MODEL_INFO).flatMap((i) => (i.signsMessages && i.maxMessageLength ? [i.maxMessageLength] : [])));

/** Why `text` cannot be signed on `model`, or undefined when it can (length, printable ASCII, each firmware's spacing rules). */
export function messageProblemFor(model: QrModel, text: string): string | undefined {
  const info = qrModelInfo(model);
  if (!/^[\x20-\x7e]+$/.test(text)) return 'The text is not plain printable ASCII on one line.';
  if (info.maxMessageLength !== undefined && text.length > info.maxMessageLength)
    return `The text is ${text.length} characters; the ${info.name} signs at most ${info.maxMessageLength}.`;
  if (info.coldcardTextRules) {
    if (text.length < 2) return 'The text is too short for the Coldcard.';
    if (text !== text.trim()) return 'The Coldcard refuses a text that starts or ends with a space.';
    if (text.includes('   ')) return 'The Coldcard refuses a text with three spaces in a row.';
  }
  if (info.noEdgeSpaces && text !== text.trim()) return `The ${info.name} does not sign a text that starts or ends with a space.`;
  if (info.maxSpaceRun !== undefined && text.includes(' '.repeat(info.maxSpaceRun + 1)))
    return `The ${info.name} refuses a text with more than ${info.maxSpaceRun} spaces in a row.`;
  return undefined;
}
