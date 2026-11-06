/**
 * `Noise_XX_25519_ChaChaPoly_SHA256` (noiseprotocol.org, revision 34), as the BitBox02 runs it: the phone is the
 * initiator, the BitBox02 the responder, and the prologue is the protocol name itself (firmware
 * `src/rust/bitbox-noise/src/noise_xx.rs` `State::init`: `HandshakeState::new(noise_xx(), false,
 * b"Noise_XX_25519_ChaChaPoly_SHA256", ...)`). Handshake payloads are empty. After the handshake each side keeps one
 * cipher per direction; the handshake hash is what the pairing code is made of (pairing.ts).
 *
 * Both roles are here so the test's fake BitBox02 can play the responder. The ephemeral key comes from
 * `secureRandomBytes` (a fixed one only in tests, to replay the firmware's transcript).
 */
import { x25519 } from '@noble/curves/ed25519.js';
import { chacha20poly1305 } from '@noble/ciphers/chacha.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { secureRandomBytes } from '@trikey/core/random';
import { HardwareError } from '../errors';

const PROTOCOL_NAME = new TextEncoder().encode('Noise_XX_25519_ChaChaPoly_SHA256');
const DHLEN = 32;
const TAGLEN = 16;
const EMPTY = new Uint8Array(0);
const PATTERN: readonly (readonly ('e' | 's' | 'ee' | 'es' | 'se')[])[] = [['e'], ['e', 'ee', 's', 'es'], ['s', 'se']];

function noiseError(message: string): HardwareError {
  return new HardwareError('invalid-response', `The BitBox02's encrypted channel failed: ${message}.`, { kind: 'bitbox02' });
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** The 96-bit ChaChaPoly nonce: 4 zero bytes, then the 64-bit counter little-endian. */
function nonce(n: number): Uint8Array {
  const out = new Uint8Array(12);
  let v = n;
  for (let i = 4; i < 12; i++) {
    out[i] = v % 256;
    v = Math.floor(v / 256);
  }
  return out;
}

/** A static (long-term) or ephemeral X25519 private key. */
export function newNoiseKey(): Uint8Array {
  return secureRandomBytes(32);
}

export function noisePublicKey(privateKey: Uint8Array): Uint8Array {
  return x25519.getPublicKey(privateKey);
}

/** One direction of the channel: a key and a message counter. */
export class CipherState {
  private n = 0;
  constructor(private readonly k?: Uint8Array) {}

  hasKey(): boolean {
    return this.k !== undefined;
  }

  encrypt(ad: Uint8Array, plaintext: Uint8Array): Uint8Array {
    if (!this.k) return plaintext;
    const out = chacha20poly1305(this.k, nonce(this.n), ad).encrypt(plaintext);
    this.n++;
    return out;
  }

  decrypt(ad: Uint8Array, ciphertext: Uint8Array): Uint8Array {
    if (!this.k) return ciphertext;
    let out: Uint8Array;
    try {
      out = chacha20poly1305(this.k, nonce(this.n), ad).decrypt(ciphertext);
    } catch {
      throw noiseError('a message did not authenticate');
    }
    this.n++;
    return out;
  }
}

export interface NoiseResult {
  /** The handshake hash: the pairing code is made from it. */
  hash: Uint8Array;
  /** The other side's static public key (the BitBox02's, for the phone). */
  remoteStatic: Uint8Array;
  send: CipherState;
  recv: CipherState;
}

export class NoiseXX {
  private h: Uint8Array;
  private ck: Uint8Array;
  private cipher = new CipherState();
  private step = 0;
  private e?: { priv: Uint8Array; pub: Uint8Array };
  private re?: Uint8Array;
  private rs?: Uint8Array;
  private readonly s: { priv: Uint8Array; pub: Uint8Array };

  constructor(
    private readonly initiator: boolean,
    staticKey: Uint8Array,
    private readonly ephemeralKey?: Uint8Array,
  ) {
    this.s = { priv: staticKey, pub: noisePublicKey(staticKey) };
    // InitializeSymmetric: the name is exactly 32 bytes, so h = name; ck = h. Then MixHash(prologue = the name).
    this.h = PROTOCOL_NAME.slice();
    this.ck = this.h.slice();
    this.mixHash(PROTOCOL_NAME);
  }

  private mixHash(data: Uint8Array): void {
    this.h = sha256(concat(this.h, data));
  }

  private mixKey(ikm: Uint8Array): void {
    const out = hkdf(sha256, ikm, this.ck, EMPTY, 64);
    this.ck = out.slice(0, 32);
    this.cipher = new CipherState(out.slice(32, 64));
  }

  private encryptAndHash(p: Uint8Array): Uint8Array {
    const c = this.cipher.encrypt(this.h, p);
    this.mixHash(c);
    return c;
  }

  private decryptAndHash(c: Uint8Array): Uint8Array {
    const p = this.cipher.decrypt(this.h, c);
    this.mixHash(c);
    return p;
  }

  private dh(token: 'ee' | 'es' | 'se'): Uint8Array {
    const e = this.e;
    const re = this.re;
    const rs = this.rs;
    if (!e || !re) throw noiseError('the handshake is out of order');
    let shared: Uint8Array;
    try {
      if (token === 'ee') shared = x25519.getSharedSecret(e.priv, re);
      else if ((token === 'es') === this.initiator) {
        if (!rs) throw new Error('no remote static key');
        shared = x25519.getSharedSecret(e.priv, rs);
      } else shared = x25519.getSharedSecret(this.s.priv, re);
    } catch {
      throw noiseError('a key exchange failed');
    }
    return shared;
  }

  private myTurn(): boolean {
    return (this.step % 2 === 0) === this.initiator;
  }

  writeMessage(): Uint8Array {
    const tokens = PATTERN[this.step];
    if (!tokens || !this.myTurn()) throw noiseError('the handshake is out of order');
    let out: Uint8Array = EMPTY;
    for (const t of tokens) {
      if (t === 'e') {
        const priv = this.ephemeralKey ?? newNoiseKey();
        this.e = { priv, pub: noisePublicKey(priv) };
        out = concat(out, this.e.pub);
        this.mixHash(this.e.pub);
      } else if (t === 's') out = concat(out, this.encryptAndHash(this.s.pub));
      else this.mixKey(this.dh(t));
    }
    out = concat(out, this.encryptAndHash(EMPTY));
    this.step++;
    return out;
  }

  readMessage(message: Uint8Array): void {
    const tokens = PATTERN[this.step];
    if (!tokens || this.myTurn()) throw noiseError('the handshake is out of order');
    let at = 0;
    const take = (n: number) => {
      if (message.length - at < n) throw noiseError('a handshake message is too short');
      const part = message.slice(at, at + n);
      at += n;
      return part;
    };
    for (const t of tokens) {
      if (t === 'e') {
        this.re = take(DHLEN);
        this.mixHash(this.re);
      } else if (t === 's') this.rs = this.decryptAndHash(take(this.cipher.hasKey() ? DHLEN + TAGLEN : DHLEN));
      else this.mixKey(this.dh(t));
    }
    const payload = this.decryptAndHash(message.slice(at));
    if (payload.length !== 0) throw noiseError('a handshake message carried an unexpected payload');
    this.step++;
  }

  finish(): NoiseResult {
    if (this.step !== PATTERN.length || !this.rs) throw noiseError('the handshake is not complete');
    const out = hkdf(sha256, EMPTY, this.ck, EMPTY, 64);
    const c1 = new CipherState(out.slice(0, 32));
    const c2 = new CipherState(out.slice(32, 64));
    return { hash: this.h, remoteStatic: this.rs, send: this.initiator ? c1 : c2, recv: this.initiator ? c2 : c1 };
  }
}
