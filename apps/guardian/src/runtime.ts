/**
 * One wallet the guardian guards for its owner, with everything that belongs to it alone (docs/design/multi-wallet.md,
 * section 3): its policy engine (key 3 at its account, rules, limit window, recoveries), its recovery runner, alerts,
 * Savings watch, known coins and co-signed sweeps.
 *
 * The first wallet is the `Guardian` itself, with its files where they always were (`guardian-state.json`,
 * `service.json`). Every wallet the owner adds is an `OwnWallet` (wallets/runtime.ts) under `wallets/<slotId>/`. What the
 * box shares (the nostr identity, relays, chain source, clocks, the lock, the owner's channels) stays on the `Guardian`.
 *
 * The recovery runner, the alerter, the Savings monitor and the protocol handlers take a `WalletRuntime` for the wallet
 * they act on and the `Guardian` for the rest, so a request routed to one wallet reaches that wallet's engine and key 3
 * only.
 */
import type { Alert } from '@trikey/protocol';
import type { Alerter } from './alerts.js';
import type { Mutex } from './files.js';
import type { KeystoreSigner } from './keystore.js';
import type { KnownCoins } from './nostr/handlers.js';
import type { ObservedStore } from './observed-store.js';
import type { PolicyEngine, RecoveryRecord } from './policy/index.js';
import type { RecoveryRunner } from './recovery-runner.js';
import type { SavingsMonitor } from './savings.js';
import type { ServiceEvent, ServiceState } from './service-state.js';

export interface WalletRuntime {
  /** Undefined for the first wallet; an own wallet's slot id (16 hex) otherwise. */
  readonly slotId: string | undefined;
  /** The wallet's BIP 48 account on the phone seed and the key 3 seed: 0 for the first wallet, 2n for the n-th added. */
  readonly account: number;
  readonly engine: PolicyEngine;
  readonly store: ObservedStore;
  /** Recovery records as last saved (read-only). */
  readonly records: readonly RecoveryRecord[];
  /** The running (pending or ready) recovery of the active wallet, if any. */
  activeRecord(): RecoveryRecord | undefined;
  /** Serializes start / cancel / complete of this wallet's recoveries. */
  readonly recoveryMutex: Mutex;
  readonly recovery: RecoveryRunner;
  readonly alerts: Alerter;
  readonly savingsWatch: SavingsMonitor;
  readonly knownCoins: KnownCoins;
  /** Where this wallet's co-signed sweeps (and its paired phone record) live: `service.json` for the first wallet. */
  readonly sweepStore: ServiceState;
  scanFloor(walletId: string): Partial<Record<0 | 1, number>>;
  noteScan(walletId: string, scan: { nextReceiveIndex: number; nextChangeIndex: number }): Promise<void>;
  recoveryPeers(): string[];
  hasRecoveryAccess(pubkey: string): boolean;
  isAlertContact(pubkey: string): boolean;
  /** Sends a protocol alert to this wallet's paired phone (with `walletId` for wallets after the first). */
  notifyPhone(alert: Alert): Promise<boolean>;
  rotateAfterSweep(recoveryId: string): Promise<void>;
  afterRetire(walletId: string, phone: string): Promise<void>;
  /** Key 3 of this wallet while unlocked (for re-creating a sweep the engine already completed). */
  readonly unlockedSigner: KeystoreSigner | undefined;
  /** The wallet's name in alerts, the owner's channels and the log once the box has more than one wallet; else undefined. */
  label(): string | undefined;
  /** The `walletId` member alerts about this wallet carry: undefined for the first wallet (alerts as before). */
  alertWalletId(): string | undefined;
  /** The box's Activity log, naming this wallet when the box has more than one. */
  logEvent(event: ServiceEvent): Promise<void>;
}

/** The running (pending or ready) recovery of wallet `walletId` (the active one) in an engine's state, if any. */
export function activeRecovery(recoveries: readonly RecoveryRecord[] | undefined, walletId: string | undefined): RecoveryRecord | undefined {
  if (!recoveries || !walletId) return undefined;
  for (let i = recoveries.length - 1; i >= 0; i--) {
    const r = recoveries[i];
    if (r.walletId === walletId) return r.status === 'pending' || r.status === 'ready' ? r : undefined;
  }
  return undefined;
}

/** `text` with the wallet's name in front once the box has several wallets ("Business: ..."); unchanged otherwise. */
export function labelled(w: Pick<WalletRuntime, 'label'>, text: string): string {
  const name = w.label();
  return name ? `${name}: ${text}` : text;
}
