/**
 * The phone's side of a hosted wallet (docs/design/family-hosting.md): pure helpers, no I/O.
 *
 * - The WALLET MAP: the descriptor, encrypted under a key from the hardware wallet's account chaincode, which the
 *   hosting guardian never sees, so it can store the map without reading it:
 *       K = HKDF-SHA256(ikm = hardware account chaincode, salt = "trikey/hosted-map/v1", info = guardian pubkey || wallet id)
 *       map = 0x01 || nonce (24) || XChaCha20-Poly1305(K, nonce, padded JSON { version, network, descriptor, birthHeight })
 *   A new phone holding only the hardware wallet gets the chaincode back with an ordinary xpub export.
 * - The LEDGER coins' classification: a coin key 3 co-signed is "on path" when its tweaks are this wallet's at some
 *   (chain, index), else only key 2 + key 3 can move it (a phone thief's off-path change, section 4).
 * - Signing by tweak with key 2 (for off-path coins, which have no derivation path a signer can follow).
 * - PSBTs to the hosting guardian without BIP 32 derivations (it needs only the CCDT tweaks).
 */
import * as btc from '@scure/btc-signer';
import { HDKey } from '@scure/bip32';
import { hex } from '@scure/base';
import { hkdf } from '@noble/hashes/hkdf.js';
import { hmac } from '@noble/hashes/hmac.js';
import { sha256, sha512 } from '@noble/hashes/sha2.js';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import {
  MultisigWallet,
  ROLES,
  TX_OPTS,
  ckdPub,
  compareBytes,
  delegatedScripts,
  findTweak,
  keySetId,
  parsePsbt,
  sighashAll,
  tweakPrivateKey,
  tweakToBytes,
  ccdtKey,
  type AccountPubkeys,
  type Network,
  type NetworkName,
  type Role,
} from '@trikey/core';
import { secureRandomBytes } from '@trikey/core/random';

export const WALLET_MAP_SALT = 'trikey/hosted-map/v1';
const MAP_VERSION = 1;
/** The plaintext is padded to a multiple of this, so the map's length says little about the descriptor. */
const MAP_PAD = 256;

export interface WalletMapContent {
  version: 1;
  network: NetworkName;
  descriptor: string;
  /** A block height before the wallet's first coin (where a rescan may start); 0 when unknown. */
  birthHeight: number;
}

const b64url = (b: Uint8Array) => btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fromB64url = (s: string) => {
  const t = s.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(t + '='.repeat((4 - (t.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
};

/** The map key from the hardware wallet's account chaincode. */
export function walletMapKey(hardwareChainCode: Uint8Array, guardianPubkey: string, walletId: string): Uint8Array {
  if (hardwareChainCode.length !== 32) throw new Error('the chaincode must be 32 bytes');
  if (!/^[0-9a-f]{64}$/.test(guardianPubkey) || !/^[0-9a-f]{16}$/.test(walletId)) throw new Error('guardian pubkey or wallet id malformed');
  const info = new Uint8Array([...hex.decode(guardianPubkey), ...new TextEncoder().encode(walletId)]);
  return hkdf(sha256, hardwareChainCode, new TextEncoder().encode(WALLET_MAP_SALT), info, 32);
}

/** The hardware wallet's account chaincode, from its account xpub. */
export function chainCodeOf(xpub: string, network: Network): Uint8Array {
  return HDKey.fromExtendedKey(xpub, network.bip32).chainCode!;
}

export function encryptWalletMap(content: WalletMapContent, key: Uint8Array): string {
  const json = new TextEncoder().encode(JSON.stringify(content));
  const padded = new Uint8Array(Math.ceil((json.length + 1) / MAP_PAD) * MAP_PAD);
  padded.set(json);
  // JSON never contains a zero byte: the padding is the zeros after it.
  const nonce = secureRandomBytes(24);
  const ct = xchacha20poly1305(key, nonce).encrypt(padded);
  return b64url(new Uint8Array([MAP_VERSION, ...nonce, ...ct]));
}

export function decryptWalletMap(map: string, key: Uint8Array): WalletMapContent {
  const bytes = fromB64url(map);
  if (bytes[0] !== MAP_VERSION || bytes.length < 1 + 24 + 16) throw new Error('not a wallet map this app knows');
  const plain = xchacha20poly1305(key, bytes.slice(1, 25)).decrypt(bytes.slice(25));
  const end = plain.indexOf(0);
  const c = JSON.parse(new TextDecoder().decode(end < 0 ? plain : plain.slice(0, end))) as WalletMapContent;
  if (c?.version !== 1 || typeof c.descriptor !== 'string' || typeof c.network !== 'string') throw new Error('the wallet map is malformed');
  return { version: 1, network: c.network, descriptor: c.descriptor, birthHeight: Number.isSafeInteger(c.birthHeight) ? c.birthHeight : 0 };
}

/**
 * Checks a decrypted map against what the guardian and the hardware wallet say: its account pubkeys must be the slot's,
 * its hardware xpub the device's. Returns the wallet.
 */
export function verifyWalletMap(content: WalletMapContent, expect: { network: Network; accountPubkeys: { app: string; hardware: string; cosigner: string }; hardwareXpub: string }): MultisigWallet {
  if (content.network !== expect.network.name) throw new Error(`the wallet map is for ${content.network}`);
  const w = MultisigWallet.fromDescriptor(content.descriptor, expect.network);
  const a = w.accountPubkeys();
  for (const r of ROLES) if (hex.encode(a[r]) !== expect.accountPubkeys[r]) throw new Error(`the wallet map's ${r} key is not the guardian's record of it`);
  if (w.keys.hardware.xpub !== expect.hardwareXpub) throw new Error("the wallet map's hardware key is not this hardware wallet's");
  return w;
}

/** The hosted wallet id of a descriptor wallet: its key-set id. */
export function hostedWalletId(w: MultisigWallet): string {
  return keySetId(w.accountPubkeys());
}

export interface LedgerCoinView {
  txid: string;
  vout: number;
  valueSats: number;
  script: string;
  tweaks: { app: string; hardware: string; cosigner: string };
}

export type ClassifiedCoin = LedgerCoinView & ({ onPath: true; chain: 0 | 1; index: number } | { onPath: false });

/**
 * Finds each coin's (chain, index) by its tweaks: per chain one curve step, then one HMAC-SHA512 per index for the
 * phone's own tweak (the child's IL plus the chain step's), confirmed on the other two roles. Coins with no such path
 * up to `maxIndex` are "reachable only with your phone key and the guardian".
 */
export function classifyLedgerCoins(wallet: MultisigWallet, coins: LedgerCoinView[], maxIndex = 10_000): ClassifiedCoin[] {
  const N = secp256k1.Point.CURVE().n;
  const acct = wallet.accountPubkeys();
  const hd = (r: Role) => HDKey.fromExtendedKey(wallet.keys[r].xpub, wallet.network.bip32);
  const want = new Map<string, LedgerCoinView[]>();
  for (const c of coins) want.set(c.tweaks.app, [...(want.get(c.tweaks.app) ?? []), c]);
  const found = new Map<string, { chain: 0 | 1; index: number }>();
  const app = hd('app');
  for (const chain of [0, 1] as const) {
    if (found.size === coins.length) break;
    const step = ckdPub(app.publicKey!, app.chainCode!, chain);
    const ser = new Uint8Array(37);
    ser.set(step.publicKey);
    for (let index = 0; index <= maxIndex && found.size < coins.length; index++) {
      new DataView(ser.buffer).setUint32(33, index, false);
      const I = hmac(sha512, step.chainCode, ser);
      const t = (BigInt(`0x${hex.encode(I.slice(0, 32))}`) + step.il) % N;
      const hit = want.get(hex.encode(tweakToBytes(t)));
      if (!hit) continue;
      const d = wallet.derive(chain, index);
      for (const c of hit) if (compareBytes(d.script, hex.decode(c.script)) === 0) found.set(`${c.txid}:${c.vout}`, { chain, index });
    }
  }
  void acct;
  return coins.map((c) => {
    const p = found.get(`${c.txid}:${c.vout}`);
    return p ? { ...c, onPath: true as const, chain: p.chain, index: p.index } : { ...c, onPath: false as const };
  });
}

/** Removes every BIP 32 derivation from a PSBT's inputs and outputs (the hosting guardian needs only the tweaks). */
export function stripDerivations(psbt: Uint8Array): Uint8Array {
  const tx = parsePsbt(psbt);
  for (let i = 0; i < tx.inputsLength; i++) if (tx.getInput(i).bip32Derivation?.length) tx.updateInput(i, { bip32Derivation: undefined }, true);
  for (let i = 0; i < tx.outputsLength; i++) if (tx.getOutput(i).bip32Derivation?.length) tx.updateOutput(i, { bip32Derivation: undefined }, true);
  return tx.toPSBT();
}

/** Copies the `role`'s partial signatures from `signed` into `into` (same transaction), input by input. */
export function mergeSignatures(into: Uint8Array, signed: Uint8Array): Uint8Array {
  const a = parsePsbt(into);
  const b = parsePsbt(signed);
  if (a.id !== b.id) throw new Error('not the same transaction');
  for (let i = 0; i < a.inputsLength; i++) {
    const sigs = b.getInput(i).partialSig ?? [];
    if (sigs.length) a.updateInput(i, { partialSig: sigs }, true);
  }
  return a.toPSBT();
}

/** An input spending a ledger coin by its tweaks (no derivation path), with its previous transaction. */
export function ledgerInput(acct: AccountPubkeys, coin: LedgerCoinView, prevTxHex: string, network: Network, sequence = 0xfffffffd) {
  const tweaks = { app: BigInt(`0x${coin.tweaks.app}`), hardware: BigInt(`0x${coin.tweaks.hardware}`), cosigner: BigInt(`0x${coin.tweaks.cosigner}`) };
  const d = delegatedScripts(acct, tweaks, network);
  if (compareBytes(d.script, hex.decode(coin.script)) !== 0) throw new Error(`the ledger coin ${coin.txid}:${coin.vout} is not this wallet's`);
  return {
    txid: coin.txid,
    index: coin.vout,
    sequence,
    witnessUtxo: { script: d.script, amount: BigInt(coin.valueSats) },
    nonWitnessUtxo: hex.decode(prevTxHex),
    sighashType: btc.SigHash.ALL,
    witnessScript: d.witnessScript,
    proprietary: ROLES.map((r) => [ccdtKey(acct[r]), tweakToBytes(tweaks[r])] as [Uint8Array, Uint8Array]),
  };
}

/** Signs every input of `psbt` that carries tweaks for `accountPubkey` with `accountPrivateKey + tweak` (SIGHASH_ALL). */
export function signByTweaks(psbt: Uint8Array, accountPrivateKey: Uint8Array, network: Network): Uint8Array {
  const tx = btc.Transaction.fromPSBT(psbt, TX_OPTS);
  const pub = secp256k1.getPublicKey(accountPrivateKey, true);
  for (let i = 0; i < tx.inputsLength; i++) {
    const inp = tx.getInput(i);
    const t = findTweak(inp.proprietary, pub);
    if (t === undefined || !inp.witnessUtxo || !inp.witnessScript) continue;
    const key = tweakPrivateKey(accountPrivateKey, t);
    try {
      const msg = sighashAll(tx, i, inp.witnessScript, inp.witnessUtxo.amount);
      const der = secp256k1.sign(msg, key, { prehash: false, lowS: true, format: 'der' });
      tx.updateInput(i, { partialSig: [[secp256k1.getPublicKey(key, true), new Uint8Array([...der, btc.SigHash.ALL])]] }, true);
    } finally {
      key.fill(0);
    }
  }
  void network;
  return tx.toPSBT();
}
