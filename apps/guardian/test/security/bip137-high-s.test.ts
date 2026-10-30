/**
 * Security review 2026-10, finding 10d (LOW/INFO): BIP137 signatures were accepted with a high S, so
 * every approval had a second valid encoding (s -> n - s, recovery bit flipped). Signers only make
 * low-S signatures; the guardian now refuses high-S ones.
 */
import { describe, expect, it } from 'vitest';
import { base64, hex } from '@scure/base';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { messageHash, recoverMessageSigner, signMessage, verifyMessageWithPubkey } from '../../src/policy/index.js';

const N = secp256k1.Point.CURVE().n;

/** The malleated twin of a BIP137 signature: S -> N - S and the other recovery id. */
function highS(sig: string): string {
  const raw = base64.decode(sig);
  const s = BigInt(`0x${hex.encode(raw.slice(33, 65))}`);
  const out = Uint8Array.from(raw);
  out.set(hex.decode((N - s).toString(16).padStart(64, '0')), 33);
  const base = raw[0] - ((raw[0] - 27) & 3);
  out[0] = base + (((raw[0] - 27) & 3) ^ 1);
  return base64.encode(out);
}

describe('security: high-S BIP137 signatures (finding 10d)', () => {
  it('refuses the malleated twin of a valid signature', () => {
    const priv = new Uint8Array(32).fill(3);
    const pub = secp256k1.getPublicKey(priv, true);
    const msg = 'Trikey retire-wallet v1 wallet=0123456789abcdef seq=1 expires=2026-10-01T12:00:00Z';
    const sig = signMessage(msg, priv);
    expect(verifyMessageWithPubkey(msg, pub, sig)).toBe(true);
    const twin = highS(sig);
    expect(twin).not.toBe(sig);
    // The twin is a mathematically valid ECDSA signature for the same key...
    const raw = base64.decode(twin);
    const recovered = secp256k1.Signature.fromBytes(raw.slice(1), 'compact').addRecoveryBit((raw[0] - 27) & 3).recoverPublicKey(
      messageHash(msg),
    );
    expect(hex.encode(recovered.toBytes(true))).toBe(hex.encode(pub));
    // ...and refused.
    expect(verifyMessageWithPubkey(msg, pub, twin)).toBe(false);
    expect(() => recoverMessageSigner(msg, twin)).toThrow(/high-S/);
  });
});

