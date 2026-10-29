// Small byte codecs used by the platform layer. No dependencies, so they run the same
// in Hermes, in Node (tests) and on web.

const HEX = '0123456789abcdef';
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const B64_LOOKUP: Record<string, number> = {};
for (let i = 0; i < B64.length; i++) B64_LOOKUP[B64.charAt(i)] = i;

export function bytesToHex(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) out += HEX.charAt(b >> 4) + HEX.charAt(b & 15);
  return out;
}

/** Strict: even length, hex digits only (either case). Throws `TypeError` otherwise. */
export function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(hex)) throw new TypeError('invalid hex string');
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function bytesToBase64(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i] ?? 0;
    const b = bytes[i + 1] ?? 0;
    const c = bytes[i + 2] ?? 0;
    out += B64.charAt(a >> 2) + B64.charAt(((a & 3) << 4) | (b >> 4));
    out += i + 1 < bytes.length ? B64.charAt(((b & 15) << 2) | (c >> 6)) : '=';
    out += i + 2 < bytes.length ? B64.charAt(c & 63) : '=';
  }
  return out;
}

/** WebAuthn-style base64url without padding. */
export function bytesToBase64Url(bytes: Uint8Array): string {
  return bytesToBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Accepts standard base64 and base64url, with or without padding. Passkey APIs differ here:
 * iOS returns standard base64, Android returns base64url. Throws `TypeError` on bad input.
 */
export function base64ToBytes(input: string): Uint8Array {
  const s = input.replace(/-/g, '+').replace(/_/g, '/').replace(/=+$/, '');
  if (s.length % 4 === 1 || !/^[A-Za-z0-9+/]*$/.test(s)) throw new TypeError('invalid base64 string');
  const out = new Uint8Array(Math.floor((s.length * 3) / 4));
  let o = 0;
  for (let i = 0; i < s.length; i += 4) {
    const n0 = B64_LOOKUP[s.charAt(i)] ?? 0;
    const n1 = B64_LOOKUP[s.charAt(i + 1)] ?? 0;
    const n2 = i + 2 < s.length ? (B64_LOOKUP[s.charAt(i + 2)] ?? 0) : 0;
    const n3 = i + 3 < s.length ? (B64_LOOKUP[s.charAt(i + 3)] ?? 0) : 0;
    if (o < out.length) out[o++] = (n0 << 2) | (n1 >> 4);
    if (o < out.length) out[o++] = ((n1 & 15) << 4) | (n2 >> 2);
    if (o < out.length) out[o++] = ((n2 & 3) << 6) | n3;
  }
  return out;
}

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
}

/** Best effort: overwrite a secret in memory once it is no longer needed. */
export function wipe(bytes: Uint8Array): void {
  bytes.fill(0);
}
