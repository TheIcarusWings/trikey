import { bytesToHex } from '@noble/hashes/utils.js';
import { mnemonicToSeedSync } from '@scure/bip39';
import { describe, expect, it } from 'vitest';
import { NIP06_PATH, identityFromMnemonic, identityFromSeed } from '../src/index.js';

// Published NIP-06 test vectors.
const vectors = [
  {
    mnemonic: 'leader monkey parrot ring guide accident before fence cannon height naive bean',
    privateKey: '7f7ff03d123792d6ac594bfa67bf6d0c0ab55b6b1fdb6249303fe861f1ccba9a',
    publicKey: '17162c921dc4d2518f9a101db33695df1afb56ab82f5ff3e5da6eec3ca5cd917',
    npub: 'npub1zutzeysacnf9rru6zqwmxd54mud0k44tst6l70ja5mhv8jjumytsd2x7nu',
  },
  {
    mnemonic:
      'what bleak badge arrange retreat wolf trade produce cricket blur garlic valid proud rude strong choose busy staff weather area salt hollow arm fade',
    privateKey: 'c15d739894c81a2fcfd3a2df85a0d2c0dbc47a280d092799f144d73d7ae78add',
    publicKey: 'd41b22899549e1f3d335a31002cfd382174006e166d3e658e3a5eecdb6463573',
    npub: 'npub16sdj9zv4f8sl85e45vgq9n7nsgt5qphpvmf7vk8r5hhvmdjxx4es8rq74h',
  },
];

describe('phone identity (NIP-06)', () => {
  it('uses the NIP-06 path', () => {
    expect(NIP06_PATH).toBe("m/44'/1237'/0'/0/0");
  });

  for (const v of vectors) {
    it(`matches the published vector for "${v.mnemonic.split(' ').slice(0, 3).join(' ')}..."`, () => {
      const id = identityFromMnemonic(v.mnemonic);
      expect(bytesToHex(id.secretKey)).toBe(v.privateKey);
      expect(id.pubkey).toBe(v.publicKey);
      expect(id.npub).toBe(v.npub);
    });

    it('derives the same key from the raw seed', () => {
      const id = identityFromSeed(mnemonicToSeedSync(v.mnemonic));
      expect(id.pubkey).toBe(v.publicKey);
    });
  }

  it('changes with the BIP 39 passphrase and the account index', () => {
    const m = vectors[0]!.mnemonic;
    const base = identityFromMnemonic(m).pubkey;
    expect(identityFromMnemonic(m, 'extra').pubkey).not.toBe(base);
    expect(identityFromMnemonic(m, '', 1).pubkey).not.toBe(base);
  });

  it('rejects an invalid mnemonic', () => {
    expect(() => identityFromMnemonic('not a valid mnemonic at all')).toThrow();
  });
});
