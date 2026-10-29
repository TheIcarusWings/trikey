/**
 * Extended public key parsing for what devices hand us: standard xpub/tpub, and the SLIP-132 flavours
 * (ypub, zpub, Zpub, vpub...) that Coldcard, Keystone and Jade sometimes export. Everything is normalised to
 * xpub (mainnet) or tpub (testnet, signet, regtest) before it reaches a descriptor.
 */
import { createBase58check } from '@scure/base';
import { sha256 } from '@noble/hashes/sha2.js';
import { HardwareError } from '../errors';

const base58check = createBase58check(sha256);

export const XPUB_VERSION = 0x0488b21e;
export const TPUB_VERSION = 0x043587cf;

/** Public-key version bytes: SLIP-132 variants map to the standard one. */
const PUBLIC_VERSIONS: Record<number, { network: 'main' | 'test'; name: string }> = {
  0x0488b21e: { network: 'main', name: 'xpub' },
  0x049d7cb2: { network: 'main', name: 'ypub' },
  0x04b24746: { network: 'main', name: 'zpub' },
  0x0295b43f: { network: 'main', name: 'Ypub' },
  0x02aa7ed3: { network: 'main', name: 'Zpub' },
  0x043587cf: { network: 'test', name: 'tpub' },
  0x044a5262: { network: 'test', name: 'upub' },
  0x045f1cf6: { network: 'test', name: 'vpub' },
  0x024289ef: { network: 'test', name: 'Upub' },
  0x02575483: { network: 'test', name: 'Vpub' },
};

export interface DecodedXpub {
  version: number;
  depth: number;
  parentFingerprint: number;
  childNumber: number;
  chainCode: Uint8Array;
  /** 33-byte compressed public key. */
  key: Uint8Array;
}

export function decodeXpub(xpub: string): DecodedXpub {
  let raw: Uint8Array;
  try {
    raw = base58check.decode(xpub.trim());
  } catch {
    throw new HardwareError('invalid-response', 'The extended public key is not valid base58check.');
  }
  if (raw.length !== 78) throw new HardwareError('invalid-response', 'The extended public key has the wrong length.');
  const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  const version = view.getUint32(0, false);
  if (!PUBLIC_VERSIONS[version]) throw new HardwareError('invalid-response', 'This is not an extended public key (private key, or unknown version).');
  return {
    version,
    depth: raw[4]!,
    parentFingerprint: view.getUint32(5, false),
    childNumber: view.getUint32(9, false),
    chainCode: raw.slice(13, 45),
    key: raw.slice(45, 78),
  };
}

export function encodeXpub(x: DecodedXpub): string {
  const raw = new Uint8Array(78);
  const view = new DataView(raw.buffer);
  view.setUint32(0, x.version, false);
  raw[4] = x.depth;
  view.setUint32(5, x.parentFingerprint, false);
  view.setUint32(9, x.childNumber, false);
  raw.set(x.chainCode, 13);
  raw.set(x.key, 45);
  return base58check.encode(raw);
}

/** Which family a key belongs to: mainnet (xpub) or a test network (tpub). */
export function xpubFamily(xpub: string): 'main' | 'test' {
  return PUBLIC_VERSIONS[decodeXpub(xpub).version]!.network;
}

/** Converts ypub/zpub/vpub/... to xpub or tpub. Standard keys are returned unchanged. */
export function normalizeXpub(xpub: string): string {
  const d = decodeXpub(xpub);
  const family = PUBLIC_VERSIONS[d.version]!.network;
  const standard = family === 'main' ? XPUB_VERSION : TPUB_VERSION;
  return d.version === standard ? xpub.trim() : encodeXpub({ ...d, version: standard });
}

/** The BIP32 version bytes pair (public + private) @scure/bip32 wants for this key's family. */
export function bip32VersionsFor(xpub: string): { public: number; private: number } {
  return xpubFamily(xpub) === 'main' ? { public: 0x0488b21e, private: 0x0488ade4 } : { public: 0x043587cf, private: 0x04358394 };
}
