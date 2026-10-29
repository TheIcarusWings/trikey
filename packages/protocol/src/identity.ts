import { HDKey } from '@scure/bip32';
import { mnemonicToSeedSync, validateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import { npubEncode } from 'nostr-tools/nip19';
import { getPublicKey } from 'nostr-tools/pure';

/** NIP-06 derivation path for the first nostr account. */
export const NIP06_PATH = "m/44'/1237'/0'/0/0";

export interface NostrIdentity {
  secretKey: Uint8Array;
  /** Hex x-only public key. */
  pubkey: string;
  npub: string;
}

/** Derive the nostr identity at the NIP-06 path from a BIP 39 seed (64 bytes). */
export function identityFromSeed(seed: Uint8Array, accountIndex = 0): NostrIdentity {
  if (!Number.isInteger(accountIndex) || accountIndex < 0) throw new RangeError('invalid accountIndex');
  const path = `m/44'/1237'/${accountIndex}'/0/0`;
  const secretKey = HDKey.fromMasterSeed(seed).derive(path).privateKey;
  if (!secretKey) throw new Error('derivation produced no private key');
  const pubkey = getPublicKey(secretKey);
  return { secretKey, pubkey, npub: npubEncode(pubkey) };
}

/** Derive the nostr identity from a BIP 39 mnemonic (English wordlist) and optional passphrase. */
export function identityFromMnemonic(mnemonic: string, passphrase = '', accountIndex = 0): NostrIdentity {
  if (!validateMnemonic(mnemonic, wordlist)) throw new Error('invalid BIP 39 mnemonic');
  return identityFromSeed(mnemonicToSeedSync(mnemonic, passphrase), accountIndex);
}
