/**
 * The keys of Recovery Key mode.
 *
 * - Key 1, the hardware wallet: its BIP 48 account key (`m/48'/c'/a'/2'`).
 * - Key 2, the phone: one BIP 39 seed with two accounts. The BIP 48 account
 *   is the phone's vault key; the BIP 84 account (`m/84'/c'/0'`) is the
 *   single-sig spending balance, so the phone pays with Face ID alone and the
 *   spending balance can also be restored in any BIP 84 wallet.
 * - Key 3, the Recovery Key: a fresh 12-word BIP 39 seed made in memory and
 *   printed on the Recovery Kit (its BIP 48 account goes into the vault), or a
 *   second hardware wallet, of which only the xpub is needed.
 *
 * Randomness comes from `crypto.getRandomValues` (through `@noble/hashes`).
 */
import { HDKey } from '@scure/bip32';
import { entropyToMnemonic, mnemonicToEntropy, mnemonicToSeedSync, validateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import { randomBytes } from '@noble/hashes/utils.js';
import { bip48Path, keyExpressionFromMaster, type KeyExpression, type Network } from '@trikey/core';

export { wordlist as BIP39_WORDLIST };

/** BIP 84 account path of the spending balance. */
export function spendingAccountPath(network: Network, account = 0): string {
  return `m/84'/${network.coinType}'/${account}'`;
}

export const isValidMnemonic = (m: string) => validateMnemonic(m, wordlist);
export const mnemonicFromEntropy = (e: Uint8Array) => entropyToMnemonic(e, wordlist);
export const entropyFromMnemonic = (m: string) => mnemonicToEntropy(m, wordlist);

/** A fresh 24-word key 2. */
export function newPhoneMnemonic(): string {
  const e = randomBytes(32);
  try {
    return mnemonicFromEntropy(e);
  } finally {
    e.fill(0);
  }
}

/** 16 bytes of fresh entropy: a 12-word Recovery Key. The caller wipes it. */
export function newRecoveryKeyEntropy(): Uint8Array {
  return randomBytes(16);
}

function masterOf(mnemonic: string, network: Network): HDKey {
  const seed = mnemonicToSeedSync(mnemonic);
  try {
    return HDKey.fromMasterSeed(seed, network.bip32);
  } finally {
    seed.fill(0);
  }
}

/** What is derived from key 2 and kept without biometrics: both account keys (public). */
export interface Key2Public {
  vault: KeyExpression;
  spending: KeyExpression;
}

export function deriveKey2(mnemonic: string, network: Network, opts: { vaultAccount?: number; spendingAccount?: number } = {}): Key2Public {
  if (!isValidMnemonic(mnemonic)) throw new Error('invalid key 2 mnemonic');
  const master = masterOf(mnemonic, network);
  try {
    return {
      vault: keyExpressionFromMaster(master, bip48Path(network, opts.vaultAccount ?? 0)),
      spending: keyExpressionFromMaster(master, spendingAccountPath(network, opts.spendingAccount ?? 0)),
    };
  } finally {
    master.wipePrivateData();
  }
}

/** The vault key of a seed at BIP 48 account `account` (key 2 or a Recovery Key). */
export function vaultKeyFromMnemonic(mnemonic: string, network: Network, account = 0): KeyExpression {
  const master = masterOf(mnemonic, network);
  try {
    return keyExpressionFromMaster(master, bip48Path(network, account));
  } finally {
    master.wipePrivateData();
  }
}

export function recoveryKeyFromEntropy(entropy: Uint8Array, network: Network, account = 0): KeyExpression {
  return vaultKeyFromMnemonic(mnemonicFromEntropy(entropy), network, account);
}

/** The BIP 48 account number of a standard vault key (`48h/<coin>h/<account>h/2h`), or throws. */
export function vaultAccountOf(k: KeyExpression, network: Network): number {
  const m = /^48h\/(\d+)h\/(\d+)h\/2h$/.exec(k.originPath);
  if (!m || Number(m[1]) !== network.coinType) throw new Error(`not a BIP 48 P2WSH key on ${network.name}: ${k.originPath}`);
  const account = Number(m[2]);
  if (account > 255) throw new Error(`BIP 48 account ${account} is above 255`);
  const hd = HDKey.fromExtendedKey(k.xpub, network.bip32);
  if (hd.depth !== 4 || hd.index !== 0x80000002) throw new Error('the xpub is not at a BIP 48 account path');
  return account;
}

/** The BIP 48 account key at `account` read from a hardware wallet's `getXpub`, checked. */
export function keyFromDevice(fingerprint: string, xpub: string, network: Network, account = 0): KeyExpression {
  if (!/^[0-9a-f]{8}$/.test(fingerprint)) throw new Error('the device reported an invalid fingerprint');
  const hd = HDKey.fromExtendedKey(xpub, network.bip32);
  if (hd.depth !== 4) throw new Error(`the key has depth ${hd.depth}, not 4`);
  if (hd.index !== 0x80000002) throw new Error('the key is not a BIP 48 P2WSH account key');
  return { fingerprint, originPath: bip48Path(network, account).replace(/^m\//, '').replace(/'/g, 'h'), xpub };
}
