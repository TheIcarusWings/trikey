import { secp256k1 } from '@noble/curves/secp256k1.js';
import { tweakPrivateKey } from '@trikey/core';

/**
 * Key 3. The guardian only ever sees its raw account key and per-input
 * delegation tweaks (BIP 89 style), so signing is "account key + tweak".
 * The service layer holds this only while the guardian is unlocked.
 */
export interface CosignerSigner {
  /** Compressed account pubkey; must match the cosigner key in the registered descriptor. */
  readonly accountPubkey: Uint8Array;
  /** Signs a 32-byte sighash with (account key + tweak). Returns a low-S DER signature without sighash byte. */
  sign(sighash: Uint8Array, tweak: bigint): Promise<Uint8Array> | Uint8Array;
}

/** In-memory cosigner key. Tests use throwaway keys; the service decrypts the real one on unlock. */
export class SoftwareCosignerSigner implements CosignerSigner {
  readonly accountPubkey: Uint8Array;
  readonly #privateKey: Uint8Array;

  constructor(privateKey: Uint8Array) {
    if (!secp256k1.utils.isValidSecretKey(privateKey)) throw new Error('invalid cosigner private key');
    this.#privateKey = privateKey.slice();
    this.accountPubkey = secp256k1.getPublicKey(this.#privateKey, true);
  }

  sign(sighash: Uint8Array, tweak: bigint): Uint8Array {
    if (sighash.length !== 32) throw new Error('sighash must be 32 bytes');
    const key = tweakPrivateKey(this.#privateKey, tweak);
    try {
      return secp256k1.sign(sighash, key, { prehash: false, lowS: true, format: 'der' });
    } finally {
      key.fill(0);
    }
  }
}
