import { base64 } from '@scure/base';
import { HardwareError } from '../errors';

export interface LedgerMessageSignature {
  /** 27 + 4 (compressed key) + recovery id, as the Bitcoin app reports it. */
  v: number;
  /** 32 bytes, hex, with or without a 0x prefix (the DMK adds one). */
  r: string;
  s: string;
}

function hexBytes(value: string, length: number, what: string): Uint8Array {
  const clean = value.replace(/^0x/i, '');
  if (clean.length !== length * 2 || !/^[0-9a-f]+$/i.test(clean)) throw new HardwareError('invalid-response', `The Ledger returned a malformed ${what}.`, { kind: 'ledger' });
  const out = new Uint8Array(length);
  for (let i = 0; i < length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** BIP137 base64: header byte, r, s (65 bytes). The Bitcoin app's header is already in 27..34. */
export function ledgerSignatureToBase64(sig: LedgerMessageSignature): string {
  if (!Number.isInteger(sig.v) || sig.v < 27 || sig.v > 42) throw new HardwareError('invalid-response', 'The Ledger returned an invalid signature header.', { kind: 'ledger' });
  const out = new Uint8Array(65);
  out[0] = sig.v;
  out.set(hexBytes(sig.r, 32, 'signature (r)'), 1);
  out.set(hexBytes(sig.s, 32, 'signature (s)'), 33);
  return base64.encode(out);
}
