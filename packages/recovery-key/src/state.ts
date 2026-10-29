/**
 * The wallet's persisted state: one JSON document in the app's
 * `KeyValueStore`. Nothing in it is secret (key 2's entropy lives in the
 * `SecureKeyStore`), but all of it is integrity-sensitive: the descriptor
 * decides where coins go, and the refill chain is money waiting to move.
 *
 * So the document carries an HMAC-SHA256 under a 32-byte key kept in the
 * secure store (without biometrics, so the app can open the wallet in the
 * background). A changed, truncated or foreign document is refused with
 * `state_tampered`. On top of that the wallet re-verifies the refill chain's
 * signatures and links on every open (`verifyRefillChain`): even someone who
 * could rewrite both stores cannot forge a refill.
 */
import { hmac } from '@noble/hashes/hmac.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { randomBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import { hex } from '@scure/base';
import { equalBytes } from '@scure/btc-signer/utils.js';
import type { KeyExpression, NetworkName } from '@trikey/core';
import type { HardwareKind, KeyValueStore, SecureKeyStore } from '@trikey/wallet';
import type { RefillFeePolicy } from './fees.js';
import type { RefillChainRecord } from './refills.js';
import { RecoveryKeyError } from './errors.js';

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
  recoveryKey?: { kind: 'kit' | 'hardware'; key: KeyExpression; savedAt: number; device?: { kind: HardwareKind; model?: string; fingerprint: string } };
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

interface Doc {
  v: 1;
  macKeyId: string;
  mac: string;
  state: string;
}

const tamper = (why: string, cause?: unknown) => new RecoveryKeyError('state_tampered', `The saved wallet failed its integrity check (${why}). Do not use it; restore from your keys.`, { cause });

function macOf(key: Uint8Array, body: string): Uint8Array {
  return hmac(sha256, key, utf8ToBytes(body));
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
    this.macKeyId = `${this.key}.mac.${hex.encode(randomBytes(8))}`;
    this.macKey = randomBytes(32);
    await this.secure.save(this.macKeyId, this.macKey, { requireBiometrics: false });
  }

  async load(): Promise<RkState | undefined> {
    const raw = await this.kv.get(this.key);
    if (raw === null) return undefined;
    let doc: Doc;
    try {
      doc = JSON.parse(raw) as Doc;
    } catch (e) {
      throw tamper('not JSON', e);
    }
    if (doc?.v !== 1 || typeof doc.macKeyId !== 'string' || typeof doc.mac !== 'string' || typeof doc.state !== 'string') throw tamper('unknown format');
    if (!doc.macKeyId.startsWith(`${this.key}.mac.`)) throw tamper('foreign key id');
    const key = await this.secure.load(doc.macKeyId, 'Open your wallet');
    if (!key || key.length !== 32) throw tamper('its key is missing from this phone');
    if (!equalBytes(macOf(key, doc.state), hex.decode(doc.mac))) throw tamper('MAC mismatch');
    let s: RkState;
    try {
      s = JSON.parse(doc.state) as RkState;
    } catch (e) {
      throw tamper('not JSON', e);
    }
    checkShape(s);
    this.macKeyId = doc.macKeyId;
    this.macKey = key;
    return s;
  }

  async save(s: RkState): Promise<void> {
    if (!this.macKey || !this.macKeyId) throw new RecoveryKeyError('internal', 'state store not initialised');
    const body = JSON.stringify(s);
    const doc: Doc = { v: 1, macKeyId: this.macKeyId, mac: hex.encode(macOf(this.macKey, body)), state: body };
    await this.kv.set(this.key, JSON.stringify(doc));
  }

  async clear(): Promise<void> {
    await this.kv.remove(this.key);
    if (this.macKeyId) await this.secure.remove(this.macKeyId);
  }
}
