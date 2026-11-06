/**
 * Message signing over text QR codes (docs/design/hardware-auth-path.md, "QR devices").
 *
 * The phone shows `signmessage <path> ascii:<text>` as one QR. Coldcard Q (`decoders.py`), Jade in QR mode
 * (`qrmode.c`), Keystone 3 (`qrcode/mod.rs`), Passport Prime (`message_signing.rs`) and Specter DIY
 * (`signmessage.py`) parse that line, show the text and the path, sign with the key at the path and show the base64
 * BIP 137 signature as a QR. Every one of those parsers takes the path with `h` for hardened steps
 * (`m/48h/1h/0h/2h/0/0`), so that is the one notation used. Coldcard answers the same request over NFC (and from
 * microSD) with an armored RFC 2440-style block instead, which carries the text and the address too: both are accepted.
 *
 * Nothing here was tested on a device: docs/alpha-test-plan.md lists the steps.
 */
import { base64 } from '@scure/base';
import { p2pkh, p2sh, p2wpkh } from '@scure/btc-signer';
import { getNetwork, type NetworkName } from '@trikey/core';
import { verifyBip137Message } from '@trikey/wallet';
import { HardwareError } from '../errors';
import { formatPath, parsePath } from '../common/path';
import type { QrPayload } from './types';

const bad = (message: string) => new HardwareError('invalid-response', message);

/** The text QR a device scans to sign `text` with the key at `path`: `signmessage m/48h/1h/0h/2h/0/0 ascii:<text>`. */
export function signMessageRequest(path: string, text: string): string {
  if (!/^[\x20-\x7e]+$/.test(text)) throw new HardwareError('invalid-request', 'Only plain printable ASCII on one line can be signed over a QR code.');
  return `signmessage ${formatPath(parsePath(path), 'h')} ascii:${text}`;
}

/** What a device's answer QR held. */
export interface MessageAnswer {
  /** The 65-byte BIP 137 signature, base64. */
  signature: string;
  /** The address the device says it signed with (armored answers). */
  address?: string;
  /** The text the device says it signed (armored answers). */
  message?: string;
}

const BEGIN_MESSAGE = '-----BEGIN BITCOIN SIGNED MESSAGE-----';
const BEGIN_SIGNATURE = '-----BEGIN BITCOIN SIGNATURE-----';
const END_SIGNATURE = '-----END BITCOIN SIGNATURE-----';

/** `s` as a 65-byte compact signature with a compressed-key header (31 to 42), or undefined. */
function compactSignature(s: string): string | undefined {
  const t = s.replace(/\s+/g, '');
  if (!/^[A-Za-z0-9+/]{86,88}={0,2}$/.test(t)) return undefined;
  let raw: Uint8Array;
  try {
    raw = base64.decode(t);
  } catch {
    return undefined;
  }
  if (raw.length !== 65) return undefined;
  return t;
}

function headerProblem(sig: string): string | undefined {
  const h = base64.decode(sig)[0]!;
  if (h >= 27 && h <= 30) return 'The device signed with an uncompressed key, which Trikey’s guardian does not accept.';
  if (h < 27 || h > 42) return 'That is not a Bitcoin message signature (unknown header).';
  return undefined;
}

function parseArmored(text: string, via: 'qr' | 'file'): MessageAnswer {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const begin = lines.findIndex((l) => l.trim() === BEGIN_MESSAGE);
  const sigAt = lines.findIndex((l, i) => i > begin && l.trim() === BEGIN_SIGNATURE);
  if (begin < 0 || sigAt < 0) throw bad(via === 'file' ? 'The signed message in that file is incomplete.' : 'The signed message is incomplete: scan the whole code.');
  const endAt = lines.findIndex((l, i) => i > sigAt && l.trim() === END_SIGNATURE);
  const message = lines.slice(begin + 1, sigAt).join('\n');
  let signature: string | undefined;
  let address: string | undefined;
  for (const raw of lines.slice(sigAt + 1, endAt < 0 ? undefined : endAt)) {
    const line = raw.trim();
    if (!line || /^version:/i.test(line)) continue;
    const named = /^address:\s*(\S+)$/i.exec(line);
    if (named) {
      address = named[1];
      continue;
    }
    const sig = compactSignature(line);
    if (sig && !signature) signature = sig;
    else if (!address && /^[A-Za-z0-9]{25,90}$/.test(line)) address = line;
  }
  if (!signature) throw bad('The signed message holds no signature.');
  return { signature, ...(address ? { address } : {}), message };
}

/**
 * Reads a device's answer: a bare base64 signature (Coldcard Q, Jade, Keystone, Passport Prime and Specter by QR), or
 * Coldcard's armored block. Throws a `HardwareError('invalid-response')` with a message fit to show as a scan hint.
 */
export function parseMessageAnswer(payload: QrPayload): MessageAnswer {
  let text: string;
  if (payload.type === 'text') text = payload.text;
  else if (payload.type === 'bbqr' && payload.fileType === 'U') text = new TextDecoder().decode(payload.data);
  else if (payload.type === 'ur') throw bad(`That QR is a ${payload.urType}. Show the signature as a plain QR code (the base64 text).`);
  else throw bad('That QR is not a message signature.');
  return parseAnswerText(text, 'qr');
}

/**
 * The answer in `text`: an armored block (`-----BEGIN BITCOIN SIGNED MESSAGE-----`, the text, the address, the
 * signature: Coldcard over NFC, and the signed files Passport gen 2 and Krux write to microSD) or a bare base64
 * signature. `via` words the errors for a scanned QR or a picked file.
 */
export function parseAnswerText(text: string, via: 'qr' | 'file'): MessageAnswer {
  const t = text.trim();
  const what = via === 'file' ? 'That file is not a signed message.' : 'That QR is not a message signature.';
  const answer = t.includes(BEGIN_MESSAGE) ? parseArmored(t, via) : (() => {
    const sig = compactSignature(t);
    if (!sig) throw bad(via === 'qr' && /^signmessage /.test(t) ? 'That is Trikey’s request. Scan the signature your device shows after you approve.' : what);
    return { signature: sig };
  })();
  const header = headerProblem(answer.signature);
  if (header) throw bad(header);
  return answer;
}

/** The addresses a device may print next to a message signed with `pubkey`: legacy (most), nested and native segwit. */
export function messageAddresses(pubkey: Uint8Array, network: NetworkName): { p2pkh: string; others: string[] } {
  const net = getNetwork(network).btc;
  return {
    p2pkh: p2pkh(pubkey, net).address!,
    others: [p2wpkh(pubkey, net).address!, p2sh(p2wpkh(pubkey, net), net).address!],
  };
}

/**
 * Checks a device's answer against the text Trikey asked it to sign and the key that must have signed it. The message
 * says what to fix on the device: a different text, another key (account or path), or a signature that does not match.
 * `via: 'file'` words it for a signed file from a microSD card (sd-message.ts) instead of a scanned QR.
 */
export function checkMessageAnswer(
  answer: MessageAnswer,
  expected: { text: string; pubkey: Uint8Array; network: NetworkName; path: string; label: string; account?: number; via?: 'qr' | 'file' },
): string {
  const shown = formatPath(parsePath(expected.path));
  const file = expected.via === 'file';
  if (answer.message !== undefined && answer.message !== expected.text)
    throw bad(
      file
        ? `That signed file holds a different text from the one Trikey asked for: it is from another request, or it was changed. Nothing was sent. Pick the file your ${expected.label} wrote for this request, or save Trikey’s file again and sign that.`
        : `Your ${expected.label} signed a different text from the one Trikey showed. Nothing was sent. Scan Trikey’s code again, check the text on the device, and sign that.`,
    );
  if (answer.address !== undefined) {
    const { p2pkh: legacy, others } = messageAddresses(expected.pubkey, expected.network);
    if (answer.address !== legacy && !others.includes(answer.address))
      throw bad(
        `Your ${expected.label} signed with another key (address ${answer.address}, not ${legacy}). Check that it is the wallet’s hardware wallet (same seed and passphrase) and that it signed with ${shown}${expected.account !== undefined ? ` from account ${expected.account}` : ''}.`,
      );
  }
  if (!verifyBip137Message(expected.text, expected.pubkey, answer.signature))
    throw bad(
      `That signature is not from this wallet’s key ${shown}. On your ${expected.label}, check that it is the wallet’s hardware wallet (same seed and passphrase), that it signed with exactly that path${expected.account !== undefined ? ` from account ${expected.account}` : ''}, and that the text was not changed. Then sign again and ${file ? 'pick the new signed file' : 'scan the new signature'}.`,
    );
  return answer.signature;
}
