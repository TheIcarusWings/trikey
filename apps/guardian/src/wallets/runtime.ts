/**
 * One own wallet after the first (docs/design/multi-wallet.md, section 3): its own `PolicyEngine` (key 3 at its account,
 * rules, daily limit window, recoveries, rotation, retirement), recovery runner, alerter, Savings monitor, known coins and
 * co-signed sweeps, under `wallets/<slotId>/`:
 *
 *   guardian-state.json  the engine's state, the same version-2 format as the first wallet's
 *   service.json         its co-signed sweeps and its paired phone (the box's relays, log and requests stay in the
 *                        box's own `service.json`)
 *
 * What the box shares (the nostr identity, relays, chain source and its tip, clocks, the lock, the owner's channels and
 * the Activity log) stays on the `Guardian`.
 */
import { join } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { GUARDIAN_FEATURES, type Alert } from '@trikey/protocol';
import { Alerter } from '../alerts.js';
import { Mutex } from '../files.js';
import type { Guardian } from '../guardian.js';
import type { GuardianSeed, KeystoreSigner } from '../keystore.js';
import { errorText } from '../log.js';
import { KnownCoins } from '../nostr/handlers.js';
import { ObservedStore } from '../observed-store.js';
import { JsonFileStore, PolicyEngine, type RecoveryRecord, type StateStore } from '../policy/index.js';
import { RecoveryRunner } from '../recovery-runner.js';
import type { WalletRuntime } from '../runtime.js';
import { activeRecovery, labelled, noteWalletScan, type ScanResult } from '../runtime.js';
import { SavingsMonitor } from '../savings.js';
import { ServiceState, type ServiceEvent } from '../service-state.js';
import type { OwnWalletRecord } from './registry.js';

export const WALLETS_DIR = 'wallets';
export const OWN_FILES = { engine: 'guardian-state.json', service: 'service.json' } as const;

export interface OwnWalletHost {
  /** The wallet's name in alerts and logs while the box has more than one wallet; undefined otherwise. */
  label(w: OwnWallet): string | undefined;
  /** The record changed (retired). */
  markRetired(slotId: string, at: number): Promise<void>;
}

export class OwnWallet implements WalletRuntime {
  readonly slotId: string;
  readonly account: number;
  engine!: PolicyEngine;
  store!: ObservedStore;
  readonly sweepStore: ServiceState;
  readonly recoveryMutex = new Mutex();
  readonly recovery: RecoveryRunner;
  readonly alerts: Alerter;
  readonly savingsWatch: SavingsMonitor;
  readonly knownCoins = new KnownCoins();
  private signer?: KeystoreSigner;

  constructor(
    private readonly g: Guardian,
    readonly record: OwnWalletRecord,
    private readonly host: OwnWalletHost,
  ) {
    this.slotId = record.slotId;
    this.account = record.account;
    this.sweepStore = new ServiceState(join(this.dir, OWN_FILES.service));
    this.recovery = new RecoveryRunner(g, this);
    this.alerts = new Alerter(g, this);
    this.savingsWatch = new SavingsMonitor(g, this);
  }

  get dir(): string {
    return join(this.g.config.dataDir, WALLETS_DIR, this.slotId);
  }

  get name(): string {
    return this.record.name;
  }

  /** Loads (or, for a new slot, creates) the wallet's engine. `store` replaces its file (tests). */
  async open(store?: StateStore): Promise<void> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    this.store = new ObservedStore(store ?? new JsonFileStore(join(this.dir, OWN_FILES.engine)));
    this.engine = await PolicyEngine.open({
      store: this.store,
      clock: this.g.clock,
      chain: this.g.engineChain,
      // `CANCEL <id>` and `recovery.cancel` find the wallet by its recovery id.
      recoveryIdPrefix: `${this.slotId}w`,
      requireContactsInText: () => this.g.features.includes(GUARDIAN_FEATURES.approvalContacts),
    });
    await this.sweepStore.load();
  }

  get records(): readonly RecoveryRecord[] {
    return this.store.state?.recoveries ?? [];
  }

  activeRecord(): RecoveryRecord | undefined {
    return activeRecovery(this.records, this.engine.registration()?.walletId);
  }

  /** Whether the wallet co-signs (registered, not retired). */
  get active(): boolean {
    return !!this.engine.registration();
  }

  scanFloor(walletId: string): Partial<Record<0 | 1, number>> {
    const hw = this.engine.highWater(walletId);
    return { 0: hw.receive, 1: hw.change };
  }

  async noteScan(walletId: string, scan: ScanResult): Promise<void> {
    try {
      await noteWalletScan(this, this.g, walletId, scan);
    } catch (e) {
      this.g.log.error('wallet.high_water_failed', { slot: this.slotId, error: errorText(e) });
    }
  }

  recoveryPeers(): string[] {
    return this.engine.recoveryPeers();
  }

  hasRecoveryAccess(pubkey: string): boolean {
    return this.engine.hasRecoveryAccess(pubkey);
  }

  isAlertContact(pubkey: string): boolean {
    if (this.engine.status().rules?.alertContacts.includes(pubkey)) return true;
    return !!this.activeRecord()?.recipients.includes(pubkey);
  }

  /** The paired phone of this wallet (normally the box's one phone identity). */
  phone(): string | undefined {
    return this.engine.registration()?.appNostrPubkey;
  }

  /** An alert about this wallet, with its `walletId` (the phone files it under this wallet). */
  withWalletId(alert: Alert): Alert {
    const walletId = this.alertWalletId();
    if (!walletId || ('walletId' in alert && alert.walletId)) return alert;
    return { ...alert, walletId } as Alert;
  }

  notifyPhone(alert: Alert): Promise<boolean> {
    const phone = this.phone();
    if (!phone) return Promise.resolve(false);
    return this.g.notifyPeer(phone, this.withWalletId(alert));
  }

  get unlockedSigner(): KeystoreSigner | undefined {
    return this.signer && !this.signer.wiped ? this.signer : undefined;
  }

  label(): string | undefined {
    return this.host.label(this);
  }

  alertWalletId(): string | undefined {
    return this.engine.registration()?.walletId ?? this.engine.retiredWallets().at(-1)?.registration.walletId;
  }

  logEvent(event: ServiceEvent): Promise<void> {
    return this.g.logEvent(event, this.name);
  }

  /** Key 3 of this wallet: the first pairing's key 3 seed (`key3Mix` as registered) at the wallet's account. */
  installSigner(seed: GuardianSeed): void {
    const reg = this.engine.registration();
    this.dropSigner();
    if (!reg) return;
    const { signer } = seed.key3(reg.network, reg.key3Mix, this.account);
    try {
      this.engine.setSigner(signer);
    } catch (e) {
      // Not this wallet's key 3 (a data directory moved between boxes): it stays locked, the others unlock.
      signer.wipe();
      this.g.log.error('wallets.key3_mismatch', { slot: this.slotId, error: errorText(e) });
      return;
    }
    this.signer = signer;
  }

  /** After `engine.register` with this wallet's key 3: keep it while unlocked, else wipe it. */
  adoptSigner(signer: KeystoreSigner): void {
    if (this.engine.locked) {
      signer.wipe();
      return;
    }
    const old = this.signer;
    this.signer = signer;
    if (old && old !== signer) old.wipe();
  }

  dropSigner(): void {
    this.engine?.setSigner(undefined);
    this.signer?.wipe();
    this.signer = undefined;
  }

  /** Background work: time-based engine transitions, completing a ready recovery, its broadcasts, alerts. */
  async tick(): Promise<void> {
    await this.engine.tick();
    await this.recovery.run();
    // Before the alerts, so a Savings spend found now is announced in the same pass (as for the first wallet).
    await this.savingsWatch.run();
    await this.alerts.run();
  }

  /** As `Guardian.rotateAfterSweep`, for this wallet: the engine retires the swept wallet and adopts the destination. */
  async rotateAfterSweep(recoveryId: string): Promise<void> {
    const g = this.g;
    const previousPhone = this.phone();
    const res = await this.engine.rotateAfterSweep(recoveryId);
    if (!res.ok) {
      g.log.error('wallet.rotation_refused', { slot: this.slotId, recoveryId, reason: res.refusal.reason });
      return;
    }
    const now = g.clock.now();
    const adopted = res.adopted;
    await this.sweepStore.update((d) => {
      const kept = adopted ? d.phones.find((p) => p.pubkey === adopted.appNostrPubkey) : undefined;
      d.phones = adopted ? [kept ?? { pubkey: adopted.appNostrPubkey, name: 'Phone (recovered wallet)', pairedAt: now }] : [];
    });
    if (adopted) {
      g.rpc?.addPeer(adopted.appNostrPubkey);
      g.log.info('wallet.adopted', { slot: this.slotId, recoveryId, from: res.retiredWalletId, to: adopted.walletId });
      g.notifyOwner('wallet_adopted', labelled(this, `The guardian now protects the wallet recovery ${recoveryId} moved the funds to (${adopted.walletId}).`), adopted.walletId);
      await g.notifyPeer(adopted.appNostrPubkey, {
        type: 'wallet_adopted',
        walletId: adopted.walletId,
        previousWalletId: res.retiredWalletId,
        recoveryId,
        hardwareConfirmRequired: !adopted.hardwareAuthConfirmed,
        ...g.stampNow(),
        message: labelled(this, `The guardian now protects your recovered wallet ${adopted.walletId}. Confirm your hardware wallet in the app before changing rules.`),
      });
    } else {
      g.log.warn('wallet.retired_after_recovery', { slot: this.slotId, recoveryId, walletId: res.retiredWalletId, detail: res.detail });
      await this.host.markRetired(this.slotId, now);
    }
    await g.pruneLabels(this);
    if (previousPhone && previousPhone !== adopted?.appNostrPubkey) {
      await g.notifyPeer(previousPhone, {
        type: 'wallet_retired',
        walletId: res.retiredWalletId,
        reason: 'recovered',
        ...(adopted ? { successorWalletId: adopted.walletId } : {}),
        ...g.stampNow(),
      });
      g.dropPeerIfUnused(previousPhone);
    }
  }

  /** After `wallet.retire` of this wallet: its phone is told; its account stays taken; the box's pairing is untouched. */
  async afterRetire(walletId: string, phone: string): Promise<void> {
    const g = this.g;
    const now = g.clock.now();
    this.dropSigner();
    await this.host.markRetired(this.slotId, now);
    await g.pruneLabels(this);
    await this.sweepStore.update((d) => {
      d.phones = [];
    });
    g.log.info('wallet.retired', { slot: this.slotId, walletId });
    await g.notifyPeer(phone, { type: 'wallet_retired', walletId, reason: 'retired', ...g.stampNow() });
    g.notifyOwner('wallet_retired', labelled(this, `Wallet ${walletId} was retired on your guardian with your phone and your hardware wallet: it co-signs nothing for it any more.`), walletId);
    g.dropPeerIfUnused(phone);
  }
}
