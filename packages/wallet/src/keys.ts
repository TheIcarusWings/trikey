/**
 * Key 2 (the phone key) and the paths the wallet uses.
 *
 * Key 2 is a BIP 39 24-word mnemonic. The secure store holds its 32 bytes of
 * entropy behind biometrics; it is loaded only to sign or to write a backup
 * and dropped right after. Two things are derived from it once, at creation,
 * and kept outside the biometric item so the app can run without prompting:
 * the BIP 48 account key (public) and the nostr identity (NIP-06), which the
 * phone needs to talk to the guardian and to read alerts in the background.
 */
import { HDKey } from '@scure/bip32';
import { entropyToMnemonic, mnemonicToEntropy, mnemonicToSeedSync, validateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import { bip48Path, keyExpressionFromMaster, type KeyExpression, type Network } from '@trikey/core';
import { secureRandomBytes } from '@trikey/core/random';
import { assertRandomSourceHealthy } from '@trikey/core/random-health';
import { identityFromSeed, type KeyOrigin, type NostrIdentity } from '@trikey/protocol';

/**
 * A fresh 24-word BIP 39 mnemonic: 32 bytes from `secureRandomBytes` (the OS generator, checked on every
 * call; packages/core/src/random.ts), then `entropyToMnemonic`. First the source must pass the start-up
 * health test and the crypto its known answers (packages/core/src/random-health.ts). Throws `RandomSourceError`
 * if the source fails a check; it never falls back to anything else.
 */
export function newMnemonic(): string {
  assertRandomSourceHealthy('new phone key');
  const entropy = secureRandomBytes(32);
  try {
    return entropyToMnemonic(entropy, wordlist);
  } finally {
    entropy.fill(0);
  }
}

export function isValidMnemonic(mnemonic: string): boolean {
  return validateMnemonic(mnemonic, wordlist);
}

export const mnemonicFromEntropy = (entropy: Uint8Array) => entropyToMnemonic(entropy, wordlist);
export const entropyFromMnemonic = (mnemonic: string) => mnemonicToEntropy(mnemonic, wordlist);

/**
 * The hardware wallet's authorization key: the single-sig key it signs
 * pairing proofs and approvals with (BIP 137), at `<BIP 48 account>/0/0`,
 * i.e. the device's own key in the wallet's first receive address.
 *
 * Under the multisig account by non-hardened steps, so the guardian checks at
 * pairing that the key derives from the hardware xpub in the descriptor (the
 * engine does this for any path below the account), and the same on every
 * phone, so a new phone without a backup knows where to ask (recovery access).
 * Ledger signs a message with it without a warning; Trezor firmware before 2.13.0 and the Model One show a path
 * warning first, then sign (never "Forbidden key path"): docs/design/hardware-auth-path.md.
 */
export function authKeyPath(network: Network, account = 0): string {
  return `${bip48Path(network, account)}/0/0`;
}

/** The compressed pubkey at `path` below `accountXpub` (whose own path is `accountPath`). */
export function childPubkey(accountXpub: string, accountPath: string, path: string, network: Network): Uint8Array {
  const norm = (p: string) => p.replace(/h/g, "'");
  const a = norm(accountPath);
  const p = norm(path);
  if (!p.startsWith(`${a}/`)) throw new Error(`${path} is not below ${accountPath}`);
  const rest = p.slice(a.length + 1);
  if (!/^\d+(\/\d+)*$/.test(rest)) throw new Error(`${path} has hardened steps below ${accountPath}`);
  return HDKey.fromExtendedKey(accountXpub, network.bip32).derive(`m/${rest}`).publicKey!;
}

/** `KeyExpression` (core, `48h/1h/0h/2h`) to the protocol's `KeyOrigin` (`m/48'/1'/0'/2'`). */
export function keyOriginOf(k: KeyExpression): KeyOrigin {
  return { fingerprint: k.fingerprint, path: `m/${k.originPath.replace(/h/g, "'")}`, xpub: k.xpub };
}

export function keyExpressionOf(k: KeyOrigin): KeyExpression {
  return { fingerprint: k.fingerprint, originPath: k.path.replace(/^m\/?/, '').replace(/'/g, 'h'), xpub: k.xpub };
}

/** What is derived from key 2 at creation and kept without biometrics. */
export interface Key2Public {
  /** The BIP 48 account key with origin. */
  account: KeyExpression;
  nostr: NostrIdentity;
}

export function deriveKey2(mnemonic: string, network: Network): Key2Public {
  if (!isValidMnemonic(mnemonic)) throw new Error('invalid key 2 mnemonic');
  const seed = mnemonicToSeedSync(mnemonic);
  try {
    const master = HDKey.fromMasterSeed(seed, network.bip32);
    return { account: keyExpressionFromMaster(master, bip48Path(network)), nostr: identityFromSeed(seed) };
  } finally {
    seed.fill(0);
  }
}
