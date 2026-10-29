/**
 * The paired phone's single-key coins, which are not the vault's (DESIGN.md, "Silent payments"):
 *
 * - the **helper coin**, P2WPKH at BIP 84 account `m/84'/coin'/1'` of key 2's seed, which every payment
 *   to a silent payment address spends next to the vault coins (the only input BIP 352 counts);
 * - **received silent payments**, single-key P2TR outputs found by the scanner (or registered by the
 *   phone as explicit outpoints), swept into the vault one coin per transaction.
 *
 * The guardian holds only public data for them: the helper account's xpub and the coins' outpoints
 * and scripts. It never holds or derives a key that can spend them.
 */
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { hmac } from '@noble/hashes/hmac.js';
import { sha256, sha512 } from '@noble/hashes/sha2.js';
import { hex } from '@scure/base';
import { HDKey } from '@scure/bip32';
import * as btc from '@scure/btc-signer';
import { getNetwork, type Network, type NetworkName } from '@trikey/core';

/** The helper's BIP 84 account (account 0 stays free for other single-key uses). */
export const HELPER_ACCOUNT = 1;
export const helperAccountPath = (network: Network) => `m/84'/${network.coinType}'/${HELPER_ACCOUNT}'`;
/** Highest helper address index the guardian recognizes per chain (receive 0, change 1). */
export const MAX_HELPER_INDEX = 1000;
/** Most explicit single-key coins the phone may register. */
export const MAX_SINGLE_KEY_COINS = 500;

const HARDENED = 0x80000000;

/** Anything whose chain/index addresses the chain service can scan with a gap limit. */
export interface AddressSource {
  /** Stable id (cache key). */
  fingerprint(): string;
  derive(chain: number, index: number): { script: Uint8Array };
}

export const isP2TR = (s: Uint8Array) => s.length === 34 && s[0] === 0x51 && s[1] === 0x20;
export const isP2WPKH = (s: Uint8Array) => s.length === 22 && s[0] === 0x00 && s[1] === 0x14;

/**
 * Parses the helper account's xpub: the network's version bytes, depth 3 and child number 1' (so it is
 * `m/84'/coin'/1'` of some seed; the coin type is not in the key, the path says it). Throws with a reason.
 */
export function parseHelperXpub(xpub: string, network: Network): HDKey {
  let key: HDKey;
  try {
    key = HDKey.fromExtendedKey(xpub, network.bip32);
  } catch (e) {
    throw new Error(`not an extended public key for ${network.name}: ${(e as Error).message}`);
  }
  if (key.privateKey) throw new Error('send the extended PUBLIC key');
  if (key.depth !== 3 || key.index !== HARDENED + HELPER_ACCOUNT) throw new Error(`the helper key must be the account key at ${helperAccountPath(network)}`);
  return key;
}

/** `m/84'/1'/1'` and `m/84h/1h/1h` are the same path. */
export const samePath = (a: string, b: string) => a.replace(/h/g, "'") === b.replace(/h/g, "'");

/** The helper account as an address source: P2WPKH of `xpub/chain/index`. */
export class HelperAccount implements AddressSource {
  readonly network: Network;
  private readonly key: HDKey;
  private readonly id: string;
  private readonly chains = new Map<number, { point: typeof secp256k1.Point.BASE; pub: Uint8Array; chainCode: Uint8Array }>();
  private readonly cache = new Map<string, Uint8Array>();

  constructor(
    readonly xpub: string,
    network: NetworkName | Network,
  ) {
    this.network = typeof network === 'string' ? getNetwork(network) : network;
    this.key = parseHelperXpub(xpub, this.network);
    this.id = `helper-${hex.encode(sha256(new TextEncoder().encode(xpub))).slice(0, 16)}`;
  }

  fingerprint(): string {
    return this.id;
  }

  derive(chain: number, index: number): { script: Uint8Array } {
    const k = `${chain}/${index}`;
    let script = this.cache.get(k);
    if (!script) {
      script = btc.p2wpkh(this.childPublicKey(chain, index)).script;
      if (this.cache.size > 10_000) this.cache.clear();
      this.cache.set(k, script);
    }
    return { script };
  }

  /**
   * BIP 32 public derivation of `chain/index` (both non-hardened). The chain key comes from scure; the
   * last step is done here with noble's precomputed base-point tables, which is about ten times faster
   * than `HDKey.deriveChild` (a test checks they agree).
   */
  childPublicKey(chain: number, index: number): Uint8Array {
    if (!Number.isInteger(index) || index < 0 || index >= HARDENED) throw new Error('a non-hardened index');
    let c = this.chains.get(chain);
    if (!c) {
      const k = this.key.deriveChild(chain);
      c = { point: secp256k1.Point.fromBytes(k.publicKey!), pub: k.publicKey!, chainCode: k.chainCode! };
      this.chains.set(chain, c);
    }
    const data = new Uint8Array(37);
    data.set(c.pub, 0);
    new DataView(data.buffer).setUint32(33, index, false);
    const I = hmac(sha512, c.chainCode, data);
    const t = BigInt(`0x${hex.encode(I.slice(0, 32))}`);
    // BIP 32: an invalid child (probability below 2^-127) is skipped; fall back to scure, which throws.
    if (t === 0n || t >= secp256k1.Point.Fn.ORDER) return this.key.deriveChild(chain).deriveChild(index).publicKey!;
    const child = c.point.add(secp256k1.Point.BASE.multiply(t));
    if (child.is0()) return this.key.deriveChild(chain).deriveChild(index).publicKey!;
    return child.toBytes(true);
  }

  /**
   * Where `script` sits on the helper account (receive or change, index up to `MAX_HELPER_INDEX`), if it
   * is one of its addresses. Derives lazily, a hundred at a time, and remembers what it derived.
   */
  locate(script: Uint8Array): { chain: 0 | 1; index: number } | undefined {
    if (!isP2WPKH(script)) return undefined;
    const want = hex.encode(script);
    const hit = this.located.get(want);
    if (hit) return hit;
    while (this.scanned < MAX_HELPER_INDEX) {
      const end = Math.min(MAX_HELPER_INDEX, this.scanned + 100);
      for (let index = this.scanned; index < end; index++)
        for (const chain of [0, 1] as const) this.located.set(hex.encode(this.derive(chain, index).script), { chain, index });
      this.scanned = end;
      const found = this.located.get(want);
      if (found) return found;
    }
    return undefined;
  }

  private readonly located = new Map<string, { chain: 0 | 1; index: number }>();
  private scanned = 0;
}

/** Helper accounts parsed once per xpub (derivations are the slow part). */
const accounts = new Map<string, HelperAccount>();
export function helperAccount(xpub: string, network: NetworkName): HelperAccount {
  const k = `${network}:${xpub}`;
  let a = accounts.get(k);
  if (!a) {
    if (accounts.size >= 8) accounts.clear();
    a = new HelperAccount(xpub, network);
    accounts.set(k, a);
  }
  return a;
}
