/**
 * The multisig wallet as the hardware adapters see it: the three keys of the descriptor in descriptor order,
 * with helpers to derive the keys, script and address at (chain, index). All adapters use this so they agree
 * on what "this wallet" is, and so each can check what a device returns against what we computed ourselves.
 */
import { HDKey } from '@scure/bip32';
import { NETWORKS, multisigScripts, parseSortedMultiDescriptor, type KeyExpression, type NetworkName } from '@trikey/core';
import type { HardwareKind, HardwareWalletPolicy } from '@trikey/wallet';
import { HardwareError } from '../errors';
import { parseOriginPath } from './path';
import { bip32VersionsFor, normalizeXpub, xpubFamily } from './xpub';

export interface WalletKey {
  /** Master fingerprint, 8 lowercase hex characters. */
  fingerprint: string;
  /** Origin path as numbers; empty for a depth-0 key (the guardian's virtual key). */
  origin: number[];
  /** Standard xpub / tpub. */
  xpub: string;
  /** The descriptor's own spelling, e.g. `48h/1h/0h/2h`. */
  originPath: string;
  hd: HDKey;
}

export interface ParsedWallet {
  name: string;
  /** Exactly three keys, in descriptor order (app, hardware, guardian for Trikey). */
  keys: WalletKey[];
  family: 'main' | 'test';
}

/** The device shows the name; the contract limits it to 16 printable ASCII characters. */
export function assertWalletName(name: string, kind?: HardwareKind): void {
  if (!/^[\x20-\x7e]{1,16}$/.test(name))
    throw new HardwareError('invalid-request', 'The wallet name must be 1 to 16 printable ASCII characters.', { kind });
}

export function parseWalletPolicy(policy: HardwareWalletPolicy, kind?: HardwareKind): ParsedWallet {
  assertWalletName(policy.name, kind);
  let expressions: KeyExpression[];
  try {
    expressions = parseSortedMultiDescriptor(policy.descriptor);
  } catch (e) {
    throw new HardwareError('invalid-request', `Unsupported wallet descriptor: ${e instanceof Error ? e.message : String(e)}`, { kind, detail: e });
  }
  const keys = expressions.map((k): WalletKey => {
    const xpub = normalizeXpub(k.xpub);
    return {
      fingerprint: k.fingerprint,
      originPath: k.originPath,
      origin: parseOriginPath(k.originPath),
      xpub,
      hd: HDKey.fromExtendedKey(xpub, bip32VersionsFor(xpub)),
    };
  });
  const families = new Set(keys.map((k) => xpubFamily(k.xpub)));
  if (families.size !== 1) throw new HardwareError('invalid-request', 'The wallet mixes mainnet and test-network keys.', { kind });
  return { name: policy.name, keys, family: [...families][0]! };
}

/** Throws if the wallet's keys belong to a different network family than the one the app is on. */
export function assertNetworkFamily(wallet: ParsedWallet, network: NetworkName, kind?: HardwareKind): void {
  const want = network === 'bitcoin' ? 'main' : 'test';
  if (wallet.family !== want)
    throw new HardwareError('invalid-request', `This wallet's keys are for ${wallet.family === 'main' ? 'mainnet' : 'a test network'}, but the app is on ${network}.`, { kind });
}

/** The three child public keys at (chain, index), in descriptor order. */
export function deriveWalletPubkeys(wallet: ParsedWallet, chain: number, index: number): Uint8Array[] {
  return wallet.keys.map((k) => {
    const child = k.hd.deriveChild(chain).deriveChild(index);
    return child.publicKey!;
  });
}

export function walletScriptsAt(wallet: ParsedWallet, chain: number, index: number, network: NetworkName) {
  const pubkeys = deriveWalletPubkeys(wallet, chain, index);
  return { pubkeys, ...multisigScripts(pubkeys, NETWORKS[network]) };
}

export function assertChainIndex(chain: number, index: number): void {
  if (chain !== 0 && chain !== 1) throw new HardwareError('invalid-request', 'The address chain must be 0 (receive) or 1 (change).');
  if (!Number.isInteger(index) || index < 0 || index >= 0x80000000) throw new HardwareError('invalid-request', 'The address index is out of range.');
}

/** Which key of the wallet carries this master fingerprint, or -1. */
export function findKeyIndex(wallet: ParsedWallet, fingerprint: string): number {
  return wallet.keys.findIndex((k) => k.fingerprint === fingerprint.toLowerCase());
}
