import { describe, expect, it } from 'vitest';
import * as btc from '@scure/btc-signer';
import { base64, hex } from '@scure/base';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { NETWORKS } from '@trikey/core';
import {
  addressFor,
  messageHash,
  parseBip137Signature,
  recoverMessageSigner,
  signMessage,
  verifyMessage,
  verifyMessageWithPubkey,
} from '../src/policy/bip137.js';

const mainnet = NETWORKS.bitcoin;
const regtest = NETWORKS.regtest;

/**
 * Published vectors from bitcoinjs-message (MIT), README and test/fixtures.json:
 * https://github.com/bitcoinjs/bitcoinjs-message
 * The keys are public test keys (WIF from the README, and d = 1).
 */
const README = {
  wif: 'L4rK1yDtCWekvXuE6oXD9jCYfFNV2cWRpVuPLBcCU2z8TrisoyY1',
  message: 'This is an example of a signed message.',
  address: '1F3sAm6ZtwLAUnj7d38pGFxtP3RVEvtsbV',
  p2pkh: 'H9L5yLFjti0QTHhPyFrZCT1V/MMnBtXKmoiKDZ78NDBjERki6ZTQZdSMCtkgoNmp17By9ItJr8o7ChX0XxY91nk=',
  p2shP2wpkh: 'I9L5yLFjti0QTHhPyFrZCT1V/MMnBtXKmoiKDZ78NDBjERki6ZTQZdSMCtkgoNmp17By9ItJr8o7ChX0XxY91nk=',
  p2wpkh: 'J9L5yLFjti0QTHhPyFrZCT1V/MMnBtXKmoiKDZ78NDBjERki6ZTQZdSMCtkgoNmp17By9ItJr8o7ChX0XxY91nk=',
};

/** `sign` fixture with d = 1; the P2PKH addresses of key 1 are the well-known 1EHNa6... and 1BgGZ9... */
const FIXTURE_D1 = {
  message: 'vires is numeris',
  uncompressed: { address: '1EHNa6Q4Jz2uvNExL497mE43ikXhwF6kZm', signature: 'HF8nHqFr3K2UKYahhX3soVeoW8W1ECNbr0wfck7lzyXjCS5Q16Ek45zyBuy1Fiy9sTPKVgsqqOuPvbycuVSSVl8=' },
  compressed: { address: '1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH', signature: 'IF8nHqFr3K2UKYahhX3soVeoW8W1ECNbr0wfck7lzyXjCS5Q16Ek45zyBuy1Fiy9sTPKVgsqqOuPvbycuVSSVl8=' },
  p2shP2wpkh: { address: '3JvL6Ymt8MVWiCNHC7oWU6nLeHNJKLZGLN', signature: 'JF8nHqFr3K2UKYahhX3soVeoW8W1ECNbr0wfck7lzyXjCS5Q16Ek45zyBuy1Fiy9sTPKVgsqqOuPvbycuVSSVl8=' },
  p2wpkh: { address: 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4', signature: 'KF8nHqFr3K2UKYahhX3soVeoW8W1ECNbr0wfck7lzyXjCS5Q16Ek45zyBuy1Fiy9sTPKVgsqqOuPvbycuVSSVl8=' },
};

/** Fixture signatures by a different key (also from fixtures.json `verify`). */
const FIXTURE_OTHER = {
  uncompressed: { address: '16UwLL9Risc3QfPqBUvKofHmBQ7wMtjvM', signature: 'G8JawPtQOrybrSP1WHQnQPr67B9S3qrxBrl1mlzoTJOSHEpmnF7D3+t+LX0Xei9J20B5AIdPbeL3AaTBZ4N3bY0=' },
  compressed: { address: '1PMycacnJaSqwwJqjawXBErnLsZ7RkXUAs', signature: 'H8JawPtQOrybrSP1WHQnQPr67B9S3qrxBrl1mlzoTJOSHEpmnF7D3+t+LX0Xei9J20B5AIdPbeL3AaTBZ4N3bY0=' },
};

describe('BIP137 message hash', () => {
  it('matches the published magic hashes', () => {
    expect(hex.encode(messageHash(''))).toBe('80e795d4a4caadd7047af389d9f7f220562feb6196032e2131e10563352c4bcc');
    expect(hex.encode(messageHash('Vires is Numeris'))).toBe('f8a5affbef4a3241b19067aa694562f64f513310817297089a8929a930f4f933');
    expect(hex.encode(messageHash('Virès is Numéris'))).toBe('af3d51b82a6694d76af5b49401d6f824d66cfce6f96213e606e7da95fe675f25');
  });
});

describe('BIP137 published vectors', () => {
  it('verifies the bitcoinjs-message README signatures for all three address types', () => {
    const priv = btc.WIF().decode(README.wif);
    const pub = secp256k1.getPublicKey(priv, true);
    expect(btc.p2pkh(pub).address).toBe(README.address);
    expect(verifyMessage(README.message, README.address, README.p2pkh, mainnet)).toBe(true);
    expect(verifyMessage(README.message, addressFor(pub, 'p2sh-p2wpkh', mainnet), README.p2shP2wpkh, mainnet)).toBe(true);
    expect(verifyMessage(README.message, addressFor(pub, 'p2wpkh', mainnet), README.p2wpkh, mainnet)).toBe(true);
    for (const sig of [README.p2pkh, README.p2shP2wpkh, README.p2wpkh]) {
      expect(verifyMessageWithPubkey(README.message, pub, sig)).toBe(true);
    }
    // Deterministic RFC6979 signing reproduces the published bytes exactly.
    expect(signMessage(README.message, priv, 'p2pkh')).toBe(README.p2pkh);
    expect(signMessage(README.message, priv, 'p2sh-p2wpkh')).toBe(README.p2shP2wpkh);
    expect(signMessage(README.message, priv, 'p2wpkh')).toBe(README.p2wpkh);
  });

  it('handles every header variant of the d = 1 fixture', () => {
    const { message } = FIXTURE_D1;
    for (const v of [FIXTURE_D1.uncompressed, FIXTURE_D1.compressed, FIXTURE_D1.p2shP2wpkh, FIXTURE_D1.p2wpkh]) {
      expect(verifyMessage(message, v.address, v.signature, mainnet)).toBe(true);
    }
    expect(parseBip137Signature(FIXTURE_D1.uncompressed.signature)).toMatchObject({ header: 28, recovery: 1, addressType: 'p2pkh-uncompressed' });
    expect(parseBip137Signature(FIXTURE_D1.compressed.signature)).toMatchObject({ header: 32, recovery: 1, addressType: 'p2pkh' });
    expect(parseBip137Signature(FIXTURE_D1.p2shP2wpkh.signature)).toMatchObject({ header: 36, addressType: 'p2sh-p2wpkh' });
    expect(parseBip137Signature(FIXTURE_D1.p2wpkh.signature)).toMatchObject({ header: 40, addressType: 'p2wpkh' });
    const g = secp256k1.Point.BASE;
    expect(hex.encode(recoverMessageSigner(message, FIXTURE_D1.p2wpkh.signature).publicKey)).toBe(g.toHex(true));
    expect(hex.encode(recoverMessageSigner(message, FIXTURE_D1.uncompressed.signature).publicKey)).toBe(g.toHex(false));
  });

  it('rejects the fixtures that must fail', () => {
    expect(verifyMessage('foobar', FIXTURE_OTHER.uncompressed.address, FIXTURE_OTHER.uncompressed.signature, mainnet)).toBe(false);
    expect(verifyMessage('vires is numeris', '1111111111111111111114oLvT2', FIXTURE_OTHER.compressed.signature, mainnet)).toBe(false);
    // no cross verification between compressed and uncompressed forms
    expect(verifyMessage('vires is numeris', FIXTURE_OTHER.uncompressed.address, FIXTURE_OTHER.compressed.signature, mainnet)).toBe(false);
    expect(verifyMessage('vires is numeris', FIXTURE_OTHER.compressed.address, FIXTURE_OTHER.uncompressed.signature, mainnet)).toBe(false);
    // and they do verify where they should
    expect(verifyMessage('vires is numeris', FIXTURE_OTHER.uncompressed.address, FIXTURE_OTHER.uncompressed.signature, mainnet)).toBe(true);
    expect(verifyMessage('vires is numeris', FIXTURE_OTHER.compressed.address, FIXTURE_OTHER.compressed.signature, mainnet)).toBe(true);
  });

  it('rejects malformed signatures (fixtures.json invalid.signature)', () => {
    const badHeader = '2b987ceade6a304fc5823ab38f99fc3c5f772a2d3e89ea05931e2726105fc53b9e601fc3231f35962c714fcbce5c95b427496edc7ae8b3d12e93791d7629795b62';
    const tooLong = '1c987ceade6a304fc5823ab38f99fc3c5f772a2d3e89ea05931e2726105fc53b9e601fc3231f35962c714fcbce5c95b427496edc7ae8b3d12e93791d7629795b62000000';
    const tooShort = '1c987ceade6a304fc5823ab38f99fc3c5f772a2d3e89ea05931e2726105fc53b9e601fc3231f35962c714fcbce5c95b427496edc7ae8b3d12e9379';
    expect(() => parseBip137Signature(hex.decode(badHeader))).toThrow(/header/);
    expect(() => parseBip137Signature(hex.decode(tooLong))).toThrow(/length/);
    expect(() => parseBip137Signature(hex.decode(tooShort))).toThrow(/length/);
    for (const h of [badHeader, tooLong, tooShort]) {
      expect(verifyMessage('x', README.address, base64.encode(hex.decode(h)), mainnet)).toBe(false);
    }
    expect(verifyMessage('x', README.address, 'not base64!!', mainnet)).toBe(false);
  });
});

describe('BIP137 round trips with throwaway keys', () => {
  it('signs and verifies on regtest for every address type, and binds the message and key', () => {
    for (let i = 0; i < 8; i++) {
      const priv = secp256k1.utils.randomSecretKey();
      const pub = secp256k1.getPublicKey(priv, true);
      const other = secp256k1.getPublicKey(secp256k1.utils.randomSecretKey(), true);
      const msg = `Trikey test ${i} ünïcödé`;
      for (const t of ['p2pkh', 'p2sh-p2wpkh', 'p2wpkh'] as const) {
        const sig = signMessage(msg, priv, t);
        expect(parseBip137Signature(sig).addressType).toBe(t);
        expect(verifyMessage(msg, addressFor(pub, t, regtest), sig, regtest)).toBe(true);
        expect(verifyMessageWithPubkey(msg, pub, sig)).toBe(true);
        expect(verifyMessageWithPubkey(msg + ' ', pub, sig)).toBe(false);
        expect(verifyMessageWithPubkey(msg, other, sig)).toBe(false);
        const flipped = base64.decode(sig);
        flipped[40] ^= 1;
        expect(verifyMessageWithPubkey(msg, pub, flipped)).toBe(false);
      }
      // Electrum style: compressed-P2PKH header accepted for segwit addresses.
      expect(verifyMessage(msg, addressFor(pub, 'p2wpkh', regtest), signMessage(msg, priv, 'p2pkh'), regtest)).toBe(true);
      // Uncompressed header is never accepted for a stored compressed key.
      expect(verifyMessageWithPubkey(msg, pub, signMessage(msg, priv, 'p2pkh-uncompressed'))).toBe(false);
    }
  });

  it('encodes long messages with a multi-byte varint length', () => {
    const priv = secp256k1.utils.randomSecretKey();
    const pub = secp256k1.getPublicKey(priv, true);
    const msg = 'a'.repeat(300);
    expect(verifyMessageWithPubkey(msg, pub, signMessage(msg, priv))).toBe(true);
  });
});
