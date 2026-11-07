/**
 * The wallet's persisted state: one JSON document in the app's
 * `KeyValueStore`. Key 2's entropy lives in the `SecureKeyStore`, but the
 * state holds the pre-signed refill chain: fully signed transactions that
 * anyone holding a copy could broadcast (one per period, as the links allow),
 * and the descriptor and keys of the whole wallet. The key-value store is an
 * app database that phone backups (Android Auto Backup, a device-to-device
 * transfer, an iCloud backup of the app's files) may copy.
 *
 * So the document is encrypted (XChaCha20-Poly1305) under a key derived
 * (HKDF-SHA256) from a 32-byte key kept in the secure store (without
 * biometrics, so the app can open the wallet in the background; this device
 * only, never in a backup). The encryption also authenticates: a changed,
 * truncated or foreign document is refused with `state_tampered`. On top of
 * that the wallet re-verifies the refill chain's signatures and links on
 * every open (`verifyRefillChain`): even someone who could rewrite both
 * stores cannot forge a refill.
 *
 * Format 1 (before 2026-11) was the same JSON in the clear, with an
 * HMAC-SHA256 under that key. It is still read, and saved again as format 2
 * at once.
 */
import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { hmac } from '@noble/hashes/hmac.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { utf8ToBytes } from '@noble/hashes/utils.js';
import { base64, hex, utf8 } from '@scure/base';
import { equalBytes } from '@scure/btc-signer/utils.js';
import type { KeyExpression, NetworkName } from '@trikey/core';
import type { HardwareKind, KeyValueStore, SecureKeyStore } from '@trikey/wallet';
import type { RefillFeePolicy } from './fees.js';
import type { RefillChainRecord } from './refills.js';
import { RecoveryKeyError } from './errors.js';
import { secureRandomBytes } from '@trikey/core/random';

export interface RkConfig {
  /** Sats per refill (default 200,000). */
  refillAmountSats: number;
  /** Refills per batch (default 8). */
  refillCount: number;
  /** Blocks between refills (default 1008, about a week). */
  periodBlocks: number;
  /** The scheduler only broadcasts a refill while the spending balance is below this (default: one refill). */
  topUpBelowSats: number;
  /** Warn when this few refills are left (default 2). */
  lowRefillsAt: number;
  refillFeePolicy: RefillFeePolicy;
  /** Most a recovery sweep may pay in fees (default 100,000 sats; never more than 5% of the vault). */
  sweepFeeCapSats: number;
  /** Confirmation target (blocks) for payments, CPFP and sweeps (default 3). */
  feeTarget: number;
}

export interface HardwareRecord {
  kind: HardwareKind;
  model?: string;
  fingerprint: string;
  key: KeyExpression;
  policyName: string;
  /** The descriptor the device registered, and its HMAC (Ledger). */
  registered?: { descriptor: string; hmac?: string };
  addressVerified: boolean;
}

export type RkAlert =
  | { kind: 'unexpected_broadcast'; at: number; position: number; txid: string }
  | { kind: 'foreign_vault_spend'; at: number; txid: string }
  | { kind: 'refills_invalidated'; at: number; position: number; spentBy?: string; byThisPhone: boolean };

export interface RkState {
  v: 1;
  network: NetworkName;
  createdAt: number;
  /** new: key 2 only; hardware: key 1 connected; ready: the vault exists and the kit is saved. */
  stage: 'new' | 'hardware' | 'ready';
  secrets: { key2: string };
  key2: { vault: KeyExpression; spending: KeyExpression };
  hardware?: HardwareRecord;
  recoveryKey?: {
    kind: 'kit' | 'hardware';
    key: KeyExpression;
    savedAt: number;
    device?: { kind: HardwareKind; model?: string; fingerprint: string };
    /**
     * A second hardware wallet (`kind: 'hardware'`): whether it showed one of the vault's addresses, as key 1 must. Its
     * key reached the phone as an export the phone cannot authenticate, so until then the vault may hold someone else's
     * key. Absent (a vault made before this check): not yet.
     */
    addressVerified?: boolean;
  };
  vault?: { descriptor: string; fingerprint: string; creationHeight: number };
  /** Next unused index per chain (reserved indices count as used). */
  indices: { vaultReceive: number; vaultChange: number; spendingReceive: number; spendingInternal: number };
  config: RkConfig;
  chain?: RefillChainRecord;
  /** Highest block in which any refill of this wallet confirmed (a new batch's first refill waits a period after it). */
  lastRefillHeight?: number;
  /** Transactions this phone made or broadcast (refills, vault payments, sweeps, payments, CPFP children). */
  ownTxids: string[];
  /** Vault spends this phone made (payments, sweeps): an invalidation by one of these is expected. */
  ownVaultSpends: string[];
  /** Refill txids already reported as broadcast by someone else. */
  reported: string[];
  alerts: RkAlert[];
  previousVaults: { descriptor: string; sweptBy: string; at: number; reason: 'kit+hardware' | 'kit+phone' | 'phone+hardware' }[];
  /** Set on a wallet created to receive a recovery sweep, until the sweep is broadcast. */
  recoveringFrom?: { descriptor: string; sweepTxid?: string };
}

export const DEFAULT_STORAGE_KEY = 'trikey.recovery-key.v1';

/** Format 1: the state in the clear, with its MAC. Read only (migrated on load). */
interface DocV1 {
  v: 1;
  macKeyId: string;
  mac: string;
  state: string;
}

/** Format 2: the state encrypted, `box` = XChaCha20-Poly1305 ciphertext and tag (base64), `nonce` 24 bytes (hex). */
interface DocV2 {
  v: 2;
  macKeyId: string;
  nonce: string;
  box: string;
}

const tamper = (why: string, cause?: unknown) => new RecoveryKeyError('state_tampered', `The saved wallet failed its integrity check (${why}). Do not use it; restore from your keys.`, { cause });

function macOf(key: Uint8Array, body: string): Uint8Array {
  return hmac(sha256, key, utf8ToBytes(body));
}

/** The encryption key, apart from the MAC key it comes from (format 1 used that one as is). */
function encKeyOf(key: Uint8Array): Uint8Array {
  return hkdf(sha256, key, undefined, utf8ToBytes('trikey/rk-state-encryption/v1'), 32);
}

/** Binds a document to its place in the store and its key: one cannot be swapped in for another. */
function aadOf(storageKey: string, macKeyId: string): Uint8Array {
  return utf8ToBytes(`trikey/rk-state/v2|${storageKey}|${macKeyId}`);
}

function checkShape(s: RkState): void {
  const ok =
    s &&
    s.v === 1 &&
    typeof s.network === 'string' &&
    ['new', 'hardware', 'ready'].includes(s.stage) &&
    typeof s.secrets?.key2 === 'string' &&
    typeof s.key2?.vault?.xpub === 'string' &&
    typeof s.key2?.spending?.xpub === 'string' &&
    typeof s.indices?.vaultChange === 'number' &&
    typeof s.config?.refillAmountSats === 'number' &&
    Array.isArray(s.ownTxids) &&
    Array.isArray(s.alerts) &&
    (s.stage !== 'ready' || (!!s.vault && !!s.hardware && !!s.recoveryKey));
  if (!ok) throw tamper('unexpected content');
}

/** Saves and loads the state with its MAC. */
export class StateStore {
  constructor(
    private readonly kv: KeyValueStore,
    private readonly secure: SecureKeyStore,
    readonly key = DEFAULT_STORAGE_KEY,
  ) {}

  private macKeyId?: string;
  private macKey?: Uint8Array;

  async exists(): Promise<boolean> {
    return (await this.kv.get(this.key)) !== null;
  }

  /** Creates the MAC key for a new wallet. */
  async init(): Promise<void> {
    this.macKeyId = `${this.key}.mac.${hex.encode(secureRandomBytes(8))}`;
    this.macKey = secureRandomBytes(32);
    await this.secure.save(this.macKeyId, this.macKey, { requireBiometrics: false });
  }

  async load(): Promise<RkState | undefined> {
    const raw = await this.kv.get(this.key);
    if (raw === null) return undefined;
    let doc: DocV1 | DocV2;
    try {
      doc = JSON.parse(raw) as DocV1 | DocV2;
    } catch (e) {
      throw tamper('not JSON', e);
    }
    if ((doc?.v !== 1 && doc?.v !== 2) || typeof doc.macKeyId !== 'string') throw tamper('unknown format');
    if (doc.v === 1 && (typeof doc.mac !== 'string' || typeof doc.state !== 'string')) throw tamper('unknown format');
    if (doc.v === 2 && (typeof doc.nonce !== 'string' || typeof doc.box !== 'string')) throw tamper('unknown format');
    if (!doc.macKeyId.startsWith(`${this.key}.mac.`)) throw tamper('foreign key id');
    const key = await this.secure.load(doc.macKeyId, 'Open your wallet');
    if (!key || key.length !== 32) throw tamper('its key is missing from this phone');
    let body: string;
    if (doc.v === 1) {
      if (!equalBytes(macOf(key, doc.state), hex.decode(doc.mac))) throw tamper('MAC mismatch');
      body = doc.state;
    } else {
      try {
        const nonce = hex.decode(doc.nonce);
        if (nonce.length !== 24) throw new Error('nonce length');
        body = utf8.encode(xchacha20poly1305(encKeyOf(key), nonce, aadOf(this.key, doc.macKeyId)).decrypt(base64.decode(doc.box)));
      } catch (e) {
        throw tamper('it does not decrypt', e);
      }
    }
    let s: RkState;
    try {
      s = JSON.parse(body) as RkState;
    } catch (e) {
      throw tamper('not JSON', e);
    }
    checkShape(s);
    this.macKeyId = doc.macKeyId;
    this.macKey = key;
    // A format 1 document holds the signed refills in the clear: write it again encrypted now. If that fails, the next
    // save does it.
    if (doc.v === 1) await this.save(s).catch(() => undefined);
    return s;
  }

  async save(s: RkState): Promise<void> {
    if (!this.macKey || !this.macKeyId) throw new RecoveryKeyError('internal', 'state store not initialised');
    const nonce = secureRandomBytes(24);
    const box = xchacha20poly1305(encKeyOf(this.macKey), nonce, aadOf(this.key, this.macKeyId)).encrypt(utf8ToBytes(JSON.stringify(s)));
    const doc: DocV2 = { v: 2, macKeyId: this.macKeyId, nonce: hex.encode(nonce), box: base64.encode(box) };
    await this.kv.set(this.key, JSON.stringify(doc));
  }

  async clear(): Promise<void> {
    await this.kv.remove(this.key);
    if (this.macKeyId) await this.secure.remove(this.macKeyId);
  }
}
