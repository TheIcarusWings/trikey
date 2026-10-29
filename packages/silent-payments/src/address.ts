/**
 * Silent payment addresses (BIP 352, "Address encoding"): bech32m with the HRP `sp` (mainnet) or `tsp` (test
 * networks), the version as the first 5-bit word (`q` = 0), then ser_P(B_scan) || ser_P(B_m).
 */
import { bech32m } from '@scure/base';
import { concatBytes, pointFromCompressed, serP, type Point } from './curve.js';
import { SilentPaymentError } from './errors.js';

/** The longest address this code reads (BIP 352 suggests 1023 characters for future versions). */
export const MAX_ADDRESS_LENGTH = 1023;

/** `sp` for mainnet, `tsp` for testnet, signet and regtest (BIP 352 defines no separate regtest HRP). */
export type SilentPaymentHrp = 'sp' | 'tsp';

/** Bitcoin network names as the rest of Trikey spells them; `mainnet` is accepted for `bitcoin`. */
export type NetworkLike = 'bitcoin' | 'mainnet' | 'testnet' | 'signet' | 'regtest';

export function hrpFor(network: NetworkLike): SilentPaymentHrp {
  switch (network) {
    case 'bitcoin':
    case 'mainnet':
      return 'sp';
    case 'testnet':
    case 'signet':
    case 'regtest':
      return 'tsp';
    default:
      throw new SilentPaymentError('invalid_argument', `unknown network: ${String(network)}`);
  }
}

export interface SilentPaymentAddress {
  /** The address as given, lower case. */
  address: string;
  hrp: SilentPaymentHrp;
  version: number;
  /** B_scan, compressed (33 bytes). */
  scanKey: Uint8Array;
  /** B_m: the spend key, with the label tweak already added for a labeled address (33 bytes). */
  spendKey: Uint8Array;
}

/** 8-bit groups from 5-bit words, dropping the incomplete tail (versions 1-30 may carry more data). */
function wordsToBytesLenient(words: number[]): Uint8Array {
  const out: number[] = [];
  let acc = 0;
  let bits = 0;
  for (const w of words) {
    acc = ((acc << 5) | w) & 0xfff;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out.push((acc >> bits) & 0xff);
    }
  }
  return Uint8Array.from(out);
}

/** Encodes (B_scan, B_m) as a version 0 address. Keys may be points or 33-byte compressed keys. */
export function encodeSilentPaymentAddress(scanKey: Point | Uint8Array, spendKey: Point | Uint8Array, network: NetworkLike): string {
  const key = (k: Point | Uint8Array, what: string) => {
    const bytes = k instanceof Uint8Array ? k : serP(k);
    if (!pointFromCompressed(bytes)) throw new SilentPaymentError('invalid_argument', `${what} is not a compressed public key`);
    return bytes;
  };
  const data = concatBytes(key(scanKey, 'scan key'), key(spendKey, 'spend key'));
  return bech32m.encode(hrpFor(network), [0, ...bech32m.toWords(data)], MAX_ADDRESS_LENGTH);
}

/**
 * Decodes an address. With `network`, an address for another network is refused (`wrong_network`).
 *
 * Versions follow BIP 352: v0 must carry exactly 66 bytes; v1 to v30 are read as their first 66 bytes (the rest is
 * for future versions); v31 is refused. Both keys must be valid compressed points.
 */
export function decodeSilentPaymentAddress(address: string, opts: { network?: NetworkLike } = {}): SilentPaymentAddress {
  const text = address.trim();
  let decoded: { prefix: string; words: number[] };
  try {
    decoded = bech32m.decode(text as `${string}1${string}`, MAX_ADDRESS_LENGTH);
  } catch (e) {
    throw new SilentPaymentError('invalid_address', `not a silent payment address: ${(e as Error).message}`);
  }
  const hrp = decoded.prefix;
  if (hrp !== 'sp' && hrp !== 'tsp') throw new SilentPaymentError('invalid_address', `not a silent payment address (prefix ${hrp})`);
  if (opts.network !== undefined && hrpFor(opts.network) !== hrp)
    throw new SilentPaymentError('wrong_network', `a ${hrp === 'sp' ? 'mainnet' : 'test network'} silent payment address, but the wallet is on ${opts.network}`);
  const [version, ...words] = decoded.words;
  if (version === undefined) throw new SilentPaymentError('invalid_address', 'the address has no version');
  if (version === 31) throw new SilentPaymentError('invalid_address', 'silent payment version 31 is reserved for an incompatible change');
  let data: Uint8Array;
  if (version === 0) {
    try {
      data = bech32m.fromWords(words);
    } catch (e) {
      throw new SilentPaymentError('invalid_address', `invalid data: ${(e as Error).message}`);
    }
    if (data.length !== 66) throw new SilentPaymentError('invalid_address', `a version 0 address carries 66 bytes, not ${data.length}`);
  } else {
    data = wordsToBytesLenient(words);
    if (data.length < 66) throw new SilentPaymentError('invalid_address', `the address carries ${data.length} bytes, fewer than 66`);
    data = data.slice(0, 66);
  }
  const scanKey = data.slice(0, 33);
  const spendKey = data.slice(33, 66);
  if (!pointFromCompressed(scanKey) || !pointFromCompressed(spendKey)) throw new SilentPaymentError('invalid_address', 'the address holds an invalid public key');
  return { address: text.toLowerCase(), hrp, version, scanKey, spendKey };
}

/** True if `text` looks like a silent payment address (prefix and separator only; `decode` checks the rest). */
export function looksLikeSilentPaymentAddress(text: string): boolean {
  return /^(sp|tsp)1/i.test(text.trim());
}
