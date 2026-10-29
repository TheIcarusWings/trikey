/** What a scanned `QrPayload` means when we are waiting for a signed transaction back from the device. */
import { base64, hex } from '@scure/base';
import * as btc from '@scure/btc-signer';
import { HardwareError } from '../errors';
import { psbtFromUr } from './ur';
import type { QrPayload } from './types';

export type SignedFromQr = { kind: 'psbt'; bytes: Uint8Array } | { kind: 'tx'; bytes: Uint8Array };

const PSBT_MAGIC_HEX = '70736274ff';
const bad = (message: string) => new HardwareError('invalid-response', message);

function fromHexOrBase64(text: string): SignedFromQr | undefined {
  const t = text.trim();
  if (/^cHNidP8/.test(t)) {
    try {
      return { kind: 'psbt', bytes: base64.decode(t) };
    } catch {
      return undefined;
    }
  }
  if (/^(?:[0-9a-fA-F]{2})+$/.test(t)) {
    const bytes = hex.decode(t.toLowerCase());
    if (t.toLowerCase().startsWith(PSBT_MAGIC_HEX)) return { kind: 'psbt', bytes };
    try {
      btc.RawTx.decode(bytes);
      return { kind: 'tx', bytes };
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/**
 * A signed PSBT, or a finished transaction, from whatever the device showed:
 * UR `crypto-psbt`, BBQr `P` (PSBT) or `T` (transaction), or one bare QR with base64 or hex (the Coldcard Q shows a
 * bare hex QR when the result fits in one).
 */
export function signedFromPayload(payload: QrPayload): SignedFromQr {
  switch (payload.type) {
    case 'ur':
      return { kind: 'psbt', bytes: psbtFromUr({ type: payload.urType, cbor: payload.cbor }) };
    case 'bbqr':
      if (payload.fileType === 'P') return { kind: 'psbt', bytes: payload.data };
      if (payload.fileType === 'T') return { kind: 'tx', bytes: payload.data };
      throw bad(`That QR is not a signed transaction (BBQr type ${payload.fileType}).`);
    case 'text': {
      const found = fromHexOrBase64(payload.text);
      if (!found) throw bad('That QR is not a signed transaction.');
      return found;
    }
  }
}
