/**
 * The `WalletService` for Recovery Key mode (no home server), on `RecoveryKeyWallet` from `@trikey/recovery-key`.
 *
 * It is a sibling of the guardian mode's service in ./real.ts, not an extension of it: the shared flows (home, send,
 * receive, activity, settings) go through the same `WalletService` and `WalletState`, so those screens stay as they
 * are, while what only this mode has (the kit, the refills, the vault, recovery with the kit, the chain server) lives
 * in `rk` (`RecoveryKeyActions`). The guardian service stays free of all of it. ./routed.ts picks which one a phone runs.
 *
 * It owns at most one `RecoveryKeyWallet`, projects its `HomeState` into the UI's `WalletState`, turns its events into
 * banners and the "Confirm on your device" sheet, and runs the refill scheduler (`runScheduler`) whenever it syncs.
 *
 * No React and no React Native in here: storage, hardware providers and the chain server come in through
 * `RkServiceDeps`, so the same code runs in the app and in Node's tests (against the simulated chain).
 *
 * Data is kept apart per app mode and network: the wallet's state lives under `trikey.rk.<mode>.<network>` in the
 * key-value store, with its secrets under random ids in the secure store, and the app's own notes next to it under
 * `.app`. The app never passes `allowMainnet`.
 */
import { RECEIVE, type NetworkName as CoreNetworkName } from '@trikey/core';
import {
  EsploraClient,
  MIN_PAYMENT_SATS,
  RecoveryKeyError,
  RecoveryKeyWallet,
  SPENDING_RECEIVE,
  decodeKit,
  estimateFor,
  estimateVsize,
  wipeKit,
  type FeeRates,
  type FetchLike,
  type HomeState,
  type PrintableKit,
  type RecoveryKeyDeps,
  type RkEvent,
} from '@trikey/recovery-key';
import type { HardwareKind as WalletHardwareKind, HardwareProvider, KeyValueStore, SecureKeyStore } from '@trikey/wallet';
import { parseScannedCode } from '@trikey/wallet/scan';
import { DevicePromptStore, compositeProvider, ledgerHint, withDevicePrompts } from './device';
import { WalletServiceError, notAvailableYet } from './errors';
import { SIMULATED_OPTION, hardwareBrandOf, hardwareOptionTable, type UiOs } from './hardware-options';
import { RK_MAINNET_REFUSED, mapRkError, kitNetworkError } from './rk-errors';
import { emptySilentPayments } from './sp-empty';
import { GENESIS_HASHES, defaultServerUrl, parseServerUrl } from './rk-server';
import type { RecoveryKeyActions } from './rk-actions';
import type { ReceiveAddress, WalletService } from './service';
import {
  RK_NETWORKS,
  type ActivityItem,
  type AmountUnit,
  type FeeSpeed,
  type HardwareKind,
  type HardwareOption,
  type HardwareWallet,
  type IsoDate,
  type KitDestination,
  type KitInfo,
  type KitProof,
  type KitRecoveryResult,
  type NetworkName,
  type QuoteOutcome,
  type RecoveryKeyKind,
  type RecoveryKeyNotice,
  type RecoveryKeyOption,
  type RecoveryKeyState,
  type RecoveryKit,
  type RefillApproval,
  type RefillPreview,
  type Sats,
  type ScannedCode,
  type SendQuote,
  type SendRequest,
  type ServerCheck,
  type SpeedUpOffer,
  type ThemePreference,
  type Transaction,
  type WalletMode,
  type WalletState,
} from './types';

export interface RkPlatform {
  os: UiOs;
  isSecure: boolean;
  secureKeys: SecureKeyStore;
  kv: KeyValueStore;
}

export interface RkServiceDeps {
  mode: 'simulator' | 'real';
  platform: RkPlatform;
  /** The hardware providers for a network (the same as the guardian mode's). */
  hardware: (network: NetworkName, hooks: { onLedgerInteraction: (interaction: string) => void }) => HardwareProvider[] | Promise<HardwareProvider[]>;
  /** Kinds whose own screens guide the person (QR devices). The "Confirm on your device" sheet stays out of their way. */
  silentKinds?: readonly WalletHardwareKind[];
  clock?: { now(): number };
  /** The network to start on (the simulator is regtest). */
  network?: NetworkName;
  /** `fetch` for the chain server (tests pass the simulated chain's). */
  fetch?: FetchLike;
  /** The server used when the person has not chosen one (the simulator's local chain). */
  defaultServer?: (network: NetworkName) => string;
  /** The simulator's second hardware wallet is the one the provider hands out for this kind. */
  secondDeviceKind?: WalletHardwareKind;
  /** The simulated chain's controls (mine blocks, fund an address), for Settings > Developer. */
  sim?: { mine(blocks: number, serverUrl: string): Promise<number>; fund(address: string, sats: Sats, serverUrl: string): Promise<void> };
  /** Sync this often while the service lives (ms; default 60 s, 0 = only when asked). */
  syncIntervalMs?: number;
  /** How often screens re-read the clock (ms, default 30 s). */
  clockTickMs?: number;
  /** Gives the UI thread a turn before heavy work (default: a short timer). */
  yieldToUi?: () => Promise<void>;
  /** Facts for Settings > Developer. */
  info?: () => string[];
  devTools?: Pick<NonNullable<WalletService['dev']>, 'useNewSimulatedDevice'>;
  /** Called when a finished wallet appears or goes (the background task registers or drops itself). */
  onWalletChange?: (hasWallet: boolean) => void;
}

export interface RkWalletService extends WalletService {
  readonly wallet: RecoveryKeyWallet | undefined;
  readonly prompts: DevicePromptStore;
  readonly rk: RecoveryKeyActions;
  close(): Promise<void>;
}

export const PREFS_KEY = 'trikey.app.prefs.v1';
export const networkPrefKey = (mode: string) => `trikey.app.network.${mode}`;
/** Where the wallet's state lives: `trikey.rk.<mode>.<network>` (and `.app` for the app's own notes). */
export const rkWalletKey = (mode: string, network: NetworkName) => `trikey.rk.${mode}.${network}`;

const PLACEHOLDER_HARDWARE: HardwareWallet = { kind: 'ledger', brand: 'hardware wallet', model: 'Hardware wallet' };
const BLOCK_MS = 600_000;
const DEFAULT_REFILL_SATS = 200_000;
const DEFAULT_REFILL_COUNT = 8;
const SPEED_TARGETS: Record<FeeSpeed, number> = { slow: 6, normal: 3, fast: 1 };

/** What the app keeps about a Recovery Key wallet besides the wallet's own state. Nothing secret. */
interface AppDoc {
  v: 1;
  keyKind: RecoveryKeyKind;
  dismissed: string[];
  defaults: { amountSats: Sats; count: number };
  /** The person's own chain server. */
  server?: string;
  /** Payments the phone made, by txid: where they went (the wallet's history knows only amounts). */
  sent: Record<string, { address: string; amountSats: Sats; feeSats: Sats; at: number; fromVault: boolean; confirmed?: boolean }>;
  /** First time an unconfirmed transaction was seen (ms). */
  seen: Record<string, number>;
}

const emptyDoc = (): AppDoc => ({ v: 1, keyKind: 'paper', dismissed: [], defaults: { amountSats: DEFAULT_REFILL_SATS, count: DEFAULT_REFILL_COUNT }, sent: {}, seen: {} });

const toWalletKind = (kind: HardwareKind): WalletHardwareKind | undefined => (kind === 'simulated' ? undefined : kind);
const iso = (ms: number): IsoDate => new Date(ms).toISOString();

/** The UI's kit from the package's printable one. */
export function toKitView(p: PrintableKit, challenge: number[], device?: string): RecoveryKit {
  return {
    kind: p.kind,
    html: p.html,
    qrText: p.qrText,
    recoveryWords: p.recoveryWords,
    mapWords: p.mapWords,
    fingerprint: p.fingerprint,
    network: p.network as NetworkName,
    date: p.date,
    challenge,
    ...(device ? { device } : {}),
  };
}

class Service implements RkWalletService {
  readonly prompts = new DevicePromptStore();
  readonly clockTickMs: number;
  readonly dev: NonNullable<WalletService['dev']>;
  readonly rk: RecoveryKeyActions;

  private w?: RecoveryKeyWallet;
  private unsubWallet?: () => void;
  private network: NetworkName;
  private state!: WalletState;
  private readonly listeners = new Set<() => void>();
  private hw?: HardwareProvider;
  private rawProviders: HardwareProvider[] = [];
  private prefs: { unit: AmountUnit; theme: ThemePreference } = { unit: 'sats', theme: 'system' };
  private doc: AppDoc = emptyDoc();
  private home?: HomeState;
  private rates: FeeRates = {};
  private cpfp: SpeedUpOffer | null = null;
  private progress: string | null = null;
  private syncing = false;
  private syncRun?: Promise<void>;
  private chain: Promise<unknown> = Promise.resolve();
  private timer?: ReturnType<typeof setInterval>;
  private closed = false;
  private starting?: Promise<void>;
  private readonly clock: { now(): number };

  constructor(private readonly deps: RkServiceDeps) {
    this.clock = deps.clock ?? { now: () => Date.now() };
    this.clockTickMs = deps.clockTickMs ?? 30_000;
    this.network = deps.network ?? 'testnet';
    this.prompts.subscribe(() => this.refresh());
    const self = this;
    this.dev = {
      async forgetWallet() {
        await self.forgetWallet();
      },
      info: () => [...(deps.info?.() ?? []), ...(self.w?.state.vault ? [`Vault ${self.w.fingerprint()}`] : ['No vault yet']), `Chain server ${self.serverUrl()}`],
      ...deps.devTools,
      ...(deps.sim
        ? {
            simChain: {
              mine: async (blocks: number) => {
                const height = await deps.sim!.mine(blocks, self.serverUrl());
                await self.sync();
                return { height };
              },
              fund: async (target: 'vault' | 'spending', sats: Sats) => {
                const w = self.requireReady();
                const address = target === 'vault' ? w.vault().derive(RECEIVE, w.state.indices.vaultReceive).address : self.spendingPeek();
                await deps.sim!.fund(address, sats, self.serverUrl());
                const height = await deps.sim!.mine(1, self.serverUrl());
                await self.sync();
                return { address, height };
              },
            },
          }
        : {}),
    };
    this.rk = this.buildActions();
  }

  // ===========================================================================
  // Startup

  private get mode() {
    return this.deps.mode;
  }

  private get walletKey() {
    return rkWalletKey(this.mode, this.network);
  }

  private get docKey() {
    return `${this.walletKey}.app`;
  }

  async init(): Promise<void> {
    const kv = this.deps.platform.kv;
    try {
      const raw = await kv.get(PREFS_KEY);
      if (raw) {
        const p = JSON.parse(raw) as Partial<typeof this.prefs>;
        if (p.unit === 'sats' || p.unit === 'btc') this.prefs.unit = p.unit;
        if (p.theme === 'system' || p.theme === 'light' || p.theme === 'dark') this.prefs.theme = p.theme;
      }
    } catch {
      /* defaults */
    }

    // The network: the wallet that exists on this phone (in this mode) wins, then the choice made last time.
    const candidates: NetworkName[] = this.mode === 'simulator' ? ['regtest'] : RK_NETWORKS;
    let found: NetworkName | undefined;
    for (const n of candidates) {
      if ((await kv.get(rkWalletKey(this.mode, n)).catch(() => null)) !== null) {
        found = n;
        break;
      }
    }
    if (this.mode === 'simulator') this.network = 'regtest';
    else {
      const saved = (await kv.get(networkPrefKey(this.mode)).catch(() => null)) as NetworkName | null;
      this.network = found ?? (saved && RK_NETWORKS.includes(saved) ? saved : (this.deps.network ?? 'testnet'));
      // Whatever was asked for (the guardian mode may have saved mainnet), Recovery Key mode stays on the test networks
      // while the project is pre-alpha (and the app never sets allowMainnet).
      if (!RK_NETWORKS.includes(this.network)) this.network = 'testnet';
    }

    await this.buildHardware();
    await this.loadDoc();
    this.state = this.project();

    if (found) {
      const w = await RecoveryKeyWallet.open(this.walletDeps());
      if (w) this.attach(w);
    }
    if (this.w?.state.stage === 'ready') this.starting = this.startInBackground();
  }

  /** Whether a wallet of this kind exists for this mode on any network (before it is opened). */
  static async exists(kv: KeyValueStore, mode: 'simulator' | 'real'): Promise<boolean> {
    for (const n of mode === 'simulator' ? (['regtest'] as NetworkName[]) : RK_NETWORKS) {
      if ((await kv.get(rkWalletKey(mode, n)).catch(() => null)) !== null) return true;
    }
    return false;
  }

  private async buildHardware(): Promise<void> {
    this.rawProviders = await this.deps.hardware(this.network, {
      onLedgerInteraction: (i) => {
        const hint = ledgerHint(i);
        if (hint) this.prompts.setHint(hint);
      },
    });
    this.hw = withDevicePrompts(compositeProvider(this.rawProviders), this.prompts, {
      network: this.network,
      silentKinds: this.deps.silentKinds ?? ['qr', 'coldcard', 'jade'],
    });
  }

  private async loadDoc(): Promise<void> {
    try {
      const raw = await this.deps.platform.kv.get(this.docKey);
      const j = raw ? (JSON.parse(raw) as Partial<AppDoc>) : undefined;
      this.doc = j?.v === 1 ? { ...emptyDoc(), ...j, defaults: { ...emptyDoc().defaults, ...j.defaults } } : emptyDoc();
    } catch {
      this.doc = emptyDoc();
    }
  }

  private async saveDoc(): Promise<void> {
    try {
      await this.deps.platform.kv.set(this.docKey, JSON.stringify(this.doc));
    } catch {
      /* the notes are a convenience; the wallet does not depend on them */
    }
  }

  private serverUrl(): string {
    return this.doc.server ?? (this.deps.defaultServer ?? defaultServerUrl)(this.network);
  }

  /**
   * `fetch`, called as a plain function. The client keeps it as a property and calls it as a method, which a browser's
   * `fetch` refuses ("Illegal invocation"); phones and Node do not mind.
   */
  private fetchFn(): FetchLike {
    return this.deps.fetch ?? ((url, init) => (globalThis.fetch as unknown as FetchLike)(url, init));
  }

  private esplora(): EsploraClient {
    return new EsploraClient({ baseUrl: this.serverUrl(), fetch: this.fetchFn() });
  }

  private walletDeps(): RecoveryKeyDeps {
    return {
      network: this.network as CoreNetworkName,
      secureStore: this.deps.platform.secureKeys,
      store: this.deps.platform.kv,
      hardware: this.hw,
      esplora: this.esplora(),
      clock: this.deps.clock,
      storageKey: this.walletKey,
      // The app never sets `allowMainnet`: Recovery Key mode is for test networks while the project is pre-alpha.
      config: { refillAmountSats: this.doc.defaults.amountSats, refillCount: this.doc.defaults.count, topUpBelowSats: this.doc.defaults.amountSats },
    };
  }

  private attach(w: RecoveryKeyWallet): void {
    this.unsubWallet?.();
    this.w = w;
    this.unsubWallet = w.on((e) => this.onEvent(e));
    this.home = w.home();
    this.deps.onWalletChange?.(w.state.stage === 'ready');
    this.refresh();
  }

  private async startInBackground(): Promise<void> {
    if (!this.w || this.closed) return;
    await this.sync();
    const every = this.deps.syncIntervalMs ?? 60_000;
    if (every > 0 && !this.closed) this.timer ??= setInterval(() => void this.sync(), every);
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.starting?.catch(() => {});
    this.unsubWallet?.();
    this.prompts.clearAll();
    await this.w?.close().catch(() => {});
  }

  get wallet(): RecoveryKeyWallet | undefined {
    return this.w;
  }

  // ===========================================================================
  // State

  getState = (): WalletState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  now = (): Date => new Date(this.clock.now());

  private refresh(): void {
    if (this.closed) return;
    this.state = this.project();
    for (const l of this.listeners) l();
  }

  private setProgress(text: string | null): void {
    this.progress = text;
    this.refresh();
  }

  private hardwareView(): HardwareWallet {
    const rec = this.w?.state.hardware;
    if (!rec) return PLACEHOLDER_HARDWARE;
    if (this.mode === 'simulator') return { kind: 'simulated', brand: 'simulated device', model: 'Simulated device' };
    const model = rec.model ?? '';
    switch (rec.kind) {
      case 'ledger':
        return { kind: 'ledger', brand: 'Ledger', model: model ? `Ledger ${model}` : 'Ledger' };
      case 'trezor':
        return { kind: 'trezor', brand: 'Trezor', model: model ? `Trezor ${model}` : 'Trezor' };
      case 'bitbox02':
        return { kind: 'bitbox02', brand: 'BitBox02', model: 'BitBox02' };
      case 'coldcard':
        return { kind: 'qr', brand: 'Coldcard', model: model || 'Coldcard' };
      case 'jade':
        return { kind: 'qr', brand: 'Jade', model: model || 'Jade' };
      default:
        return { kind: 'qr', brand: 'signing device', model: model || 'Signing device' };
    }
  }

  private spendingPeek(): string {
    const w = this.w;
    if (!w) return '';
    return w.spendingAccount().derive(SPENDING_RECEIVE, w.state.indices.spendingReceive).address;
  }

  private vaultPeek(): string {
    const w = this.w;
    if (!w || w.state.stage !== 'ready') return '';
    return w.vault().derive(RECEIVE, w.state.indices.vaultReceive).address;
  }

  private notices(): RecoveryKeyNotice[] {
    const out: RecoveryKeyNotice[] = [];
    for (const a of this.w?.state.alerts ?? []) {
      if (a.kind === 'unexpected_broadcast') {
        const id = `unexpected_broadcast:${a.txid}`;
        if (!this.doc.dismissed.includes(id)) out.push({ id, kind: 'unexpected_broadcast', at: iso(a.at), index: a.position, txid: a.txid });
      } else if (a.kind === 'foreign_vault_spend') {
        const id = `foreign_vault_spend:${a.txid}`;
        if (!this.doc.dismissed.includes(id)) out.push({ id, kind: 'foreign_vault_spend', at: iso(a.at), txid: a.txid });
      }
    }
    return out.sort((a, b) => b.at.localeCompare(a.at));
  }

  private activity(): ActivityItem[] {
    const h = this.home;
    const items: ActivityItem[] = [];
    const known = new Set<string>();
    if (h) {
      for (const a of h.activity) {
        known.add(a.txid);
        const confirmed = a.height > 0;
        const at = confirmed ? h.syncedAt - Math.max(0, h.tipHeight - a.height) * BLOCK_MS : (this.doc.seen[a.txid] ?? h.syncedAt);
        const mine = this.doc.sent[a.txid];
        const sent = a.kind === 'sent' || a.kind === 'speed_up';
        const tx: Transaction = {
          id: a.txid,
          kind: a.kind === 'refill' ? 'refill' : a.kind === 'speed_up' ? 'speed_up' : sent ? 'sent' : 'received',
          amountSats: sent && mine ? mine.amountSats : Math.abs(a.netSats),
          ...(sent && mine ? { feeSats: mine.feeSats } : {}),
          status: confirmed ? 'confirmed' : 'pending',
          at: iso(at),
          ...(sent && mine ? { address: mine.address } : {}),
          txid: a.txid,
          ...(a.kind === 'refill' ? { refillIndex: a.position, signedBy: 'phone+hardware' as const } : sent ? { signedBy: 'phone' as const } : {}),
        };
        items.push({ type: 'payment', at: tx.at, tx });
      }
    }
    // Payments from the vault are not in the spending balance's history: the phone remembers the ones it made.
    for (const [txid, p] of Object.entries(this.doc.sent)) {
      if (!p.fromVault || known.has(txid)) continue;
      const tx: Transaction = {
        id: txid,
        kind: 'sent',
        amountSats: p.amountSats,
        feeSats: p.feeSats,
        status: p.confirmed ? 'confirmed' : 'pending',
        at: iso(p.at),
        address: p.address,
        txid,
        signedBy: 'phone+hardware',
        fromVault: true,
      };
      items.push({ type: 'payment', at: tx.at, tx });
    }
    return items.sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());
  }

  private recoveryKeyView(): RecoveryKeyState {
    const s = this.w?.state;
    const h = this.home;
    const ready = s?.stage === 'ready';
    const refills = h?.refills;
    const status = !refills || refills.status === 'empty' ? 'none' : refills.status;
    const n = h?.nextRefill;
    return {
      keyKind: this.doc.keyKind,
      stage: s?.stage ?? 'new',
      savedKey: s?.recoveryKey ? s.recoveryKey.kind : null,
      fingerprint: ready ? this.w!.fingerprint() : null,
      spendingSats: h?.spending.totalSats ?? 0,
      vaultSats: h?.vault.totalSats ?? 0,
      refillAmountSats: this.doc.defaults.amountSats,
      refillCount: this.doc.defaults.count,
      refillsLeft: refills?.left ?? 0,
      refillsTotal: refills?.total ?? 0,
      refillsStatus: status,
      needsApproval: ready && (refills ? refills.needsApproval : false),
      invalidatedBy: refills?.invalidated ? { index: refills.invalidated.position, byThisPhone: this.invalidatedByThisPhone(refills.invalidated.spentBy) } : null,
      next: n
        ? {
            index: n.position,
            amountSats: n.amountSats,
            status: n.status,
            ...(n.etaMs !== undefined && (n.status === 'waiting' || n.status === 'pending') ? { etaAt: iso(n.etaMs) } : {}),
            ...(n.inBlocks !== undefined ? { inBlocks: n.inBlocks } : {}),
          }
        : null,
      notices: this.notices(),
      speedUp: this.cpfp,
      server: { url: this.serverUrl(), isDefault: this.doc.server === undefined },
      syncedAt: h ? iso(h.syncedAt) : null,
      refills: [],
      activity: this.activity(),
    };
  }

  private invalidatedByThisPhone(spentBy: string | undefined): boolean {
    return spentBy !== undefined && (this.w?.state.ownVaultSpends.includes(spentBy) ?? false);
  }

  private project(): WalletState {
    const s = this.w?.state;
    const h = this.home;
    const rk = this.recoveryKeyView();
    return {
      backing: this.mode,
      network: this.network,
      mainnetRiskAccepted: false,
      capabilities: { lockGuardian: false, replaceGuardian: false, recoveryKey: true },
      progress: this.progress,
      devicePrompt: this.prompts.getSnapshot(),
      syncing: this.syncing,
      synced: !!h,
      phoneSpending: 'enabled',
      recoveryOutcome: null,
      recovering: false,
      onboarded: s?.stage === 'ready',
      mode: 'recoveryKey',
      unit: this.prefs.unit,
      theme: this.prefs.theme,
      hardware: this.hardwareView(),
      addressVerified: !!s?.hardware?.addressVerified,
      backup: null,
      guardian: { host: 'other', status: 'offline', lastSeenAt: iso(this.clock.now()), relays: [], chainData: 'your-node', npub: '' },
      recoveryDelayDays: 7,
      dailyLimit: { limitSats: 0, usedSats: 0 },
      contacts: [],
      balanceSats: rk.spendingSats + rk.vaultSats,
      receiveAddress: s?.stage === 'ready' ? this.spendingPeek() : '',
      activity: [],
      recovery: null,
      recoveryKey: rk,
      hardwareConfirmRequired: false,
      replace: { plan: null, step: null, pending: null },
      oldWallets: [],
      walletRetired: null,
      finishedRecovery: null,
      silentPayments: emptySilentPayments('send_only'),
    };
  }

  // ===========================================================================
  // Plumbing

  /** One hardware-or-wallet-changing job at a time: a second tap queues instead of fighting over the device. */
  private exclusive<T>(job: () => Promise<T>): Promise<T> {
    const run = this.chain.then(job, job);
    this.chain = run.catch(() => undefined);
    return run;
  }

  /** Runs `job`; whatever it throws becomes a `WalletServiceError`. */
  private async guarded<T>(job: () => Promise<T>): Promise<T> {
    try {
      return await job();
    } catch (e) {
      throw mapRkError(e);
    } finally {
      this.prompts.clearQueue();
    }
  }

  private requireWallet(): RecoveryKeyWallet {
    if (!this.w) throw new WalletServiceError('wrong_state', 'Set up the wallet first.');
    return this.w;
  }

  private requireReady(): RecoveryKeyWallet {
    const w = this.requireWallet();
    if (w.state.stage !== 'ready') throw new WalletServiceError('wrong_state', 'Finish setting up the wallet first.');
    return w;
  }

  private async yieldToUi(): Promise<void> {
    await (this.deps.yieldToUi ? this.deps.yieldToUi() : new Promise<void>((r) => setTimeout(r, 30)));
  }

  private onEvent(e: RkEvent): void {
    switch (e.type) {
      case 'state':
        // Balances change only when the chain is read; the wallet's own state (stage, alerts, indices) changes here.
        this.refresh();
        break;
      case 'hardware_prompt':
        if (e.purpose === 'refills') this.prompts.queueDetail(e.text, e.step, e.steps);
        else if (e.purpose === 'vault-payment' || e.purpose === 'recovery-sweep') this.prompts.pendingDetail = e.text;
        break;
      case 'cpfp_suggested':
        this.cpfp = { index: e.position, txid: e.txid, feeSats: e.childFeeSats, targetRate: e.targetRate, currentRate: e.parentRate };
        break;
      default:
        break;
    }
  }

  private async ensureWallet(): Promise<RecoveryKeyWallet> {
    if (this.w) return this.w;
    this.setProgress('Creating your phone key');
    try {
      await this.yieldToUi();
      const w = await RecoveryKeyWallet.create(this.walletDeps());
      this.doc = { ...emptyDoc(), keyKind: this.doc.keyKind, defaults: this.doc.defaults, ...(this.doc.server ? { server: this.doc.server } : {}) };
      await this.saveDoc();
      this.attach(w);
      return w;
    } finally {
      this.setProgress(null);
    }
  }

  // ===========================================================================
  // Sync and the scheduler

  /**
   * Reads the chain and runs the refill scheduler (`runScheduler`: it syncs, decides, and sends the next refill when it
   * is unlocked and the spending balance is low). Called when the app opens, when it comes back to the front, on pull to
   * refresh and every minute while it is open; the background task runs the same scheduler.
   */
  sync(): Promise<void> {
    // A second ask while one runs waits for that one: pull to refresh keeps spinning until the chain was read.
    if (this.syncRun) return this.syncRun;
    const w = this.w;
    if (!w || w.state.stage !== 'ready' || this.closed) return Promise.resolve();
    this.syncRun = this.runSync(w).finally(() => {
      this.syncRun = undefined;
    });
    return this.syncRun;
  }

  private async runSync(w: RecoveryKeyWallet): Promise<void> {
    this.syncing = true;
    this.cpfp = null;
    this.refresh();
    try {
      const r = await w.runScheduler();
      this.home = r.home;
      this.rates = await this.esplora().feeEstimates().catch(() => this.rates);
      await this.settleNotes(r.home);
    } catch {
      // A server that does not answer leaves the last known balances on screen; the next sync tries again.
      this.home = w.home() ?? this.home;
    } finally {
      this.syncing = false;
      this.refresh();
    }
  }

  /** Remembers when unconfirmed transactions first showed, and which vault payments have confirmed since. */
  private async settleNotes(h: HomeState): Promise<void> {
    let changed = false;
    for (const a of h.activity) {
      if (a.height === 0 && this.doc.seen[a.txid] === undefined) ((this.doc.seen[a.txid] = h.syncedAt), (changed = true));
    }
    const esplora = this.esplora();
    for (const [txid, p] of Object.entries(this.doc.sent)) {
      if (!p.fromVault || p.confirmed) continue;
      const st = await esplora.txStatus(txid).catch(() => undefined);
      if (st?.confirmed) ((p.confirmed = true), (changed = true));
    }
    if (changed) await this.saveDoc();
  }

  /** After something the person did: read the chain again so balances and activity are right. */
  private async resync(): Promise<void> {
    const w = this.w;
    if (!w) return;
    try {
      this.home = await w.sync();
    } catch {
      this.home = w.home() ?? this.home;
    }
    this.refresh();
  }

  // ===========================================================================
  // Onboarding

  setNetwork(network: NetworkName): void {
    if (this.w) throw new WalletServiceError('wrong_state', "This wallet's network can't change.");
    if (this.mode === 'simulator' && network !== 'regtest') throw new WalletServiceError('invalid_input', 'The simulator works on regtest only.');
    if (!RK_NETWORKS.includes(network)) throw new WalletServiceError('invalid_input', RK_MAINNET_REFUSED);
    this.network = network;
    void this.deps.platform.kv.set(networkPrefKey(this.mode), network).catch(() => {});
    void this.buildHardware().then(() => this.loadDoc()).then(() => this.refresh());
    this.refresh();
  }

  /** Nothing to accept: Recovery Key mode never runs on mainnet. */
  acceptMainnetRisk(): void {}

  async getHardwareOptions(): Promise<HardwareOption[]> {
    if (this.mode === 'simulator') return [{ ...SIMULATED_OPTION, available: true }];
    const out: HardwareOption[] = [];
    for (const opt of hardwareOptionTable(this.deps.platform.os)) {
      const provider = this.rawProviders.find((p) => p.kinds.includes(opt.kind as WalletHardwareKind));
      if (!provider) continue;
      out.push({ ...opt, available: await provider.isAvailable().catch(() => false) });
    }
    return out;
  }

  connectHardware(kind: HardwareKind): Promise<HardwareWallet> {
    return this.exclusive(() =>
      this.guarded(async () => {
        const w = await this.ensureWallet();
        if (w.state.stage === 'ready') throw new WalletServiceError('wrong_state', 'This wallet is already set up.');
        this.setProgress(`Connecting to your ${hardwareBrandOf(kind)}`);
        try {
          await w.connectHardware({ kind: toWalletKind(kind) });
          return this.hardwareView();
        } finally {
          this.setProgress(null);
        }
      }),
    );
  }

  pairGuardian(): Promise<never> {
    return Promise.reject(notAvailableYet('Pairing a guardian', 'This wallet has no home server.'));
  }

  setOnboardingContacts(): void {
    throw notAvailableYet('Alert contacts', 'Recovery Key mode has no guardian to send alerts.');
  }

  async setUpRules(): Promise<void> {
    throw notAvailableYet('A daily limit', 'Recovery Key mode limits the phone with its refills instead.');
  }

  async getBackupOptions(): Promise<never> {
    throw notAvailableYet('A phone backup', 'In Recovery Key mode your Recovery Kit and your hardware wallet replace the phone if it is lost.');
  }

  createBackup(): Promise<never> {
    return Promise.reject(notAvailableYet('A phone backup', 'In Recovery Key mode your Recovery Kit and your hardware wallet replace the phone if it is lost.'));
  }

  recoveryCode(): string | null {
    return null;
  }

  dismissRecoveryCode(): void {}

  exportBackupFile(): Promise<void> {
    return Promise.reject(notAvailableYet('A phone backup'));
  }

  finishOnboarding(_mode?: WalletMode): void {
    this.refresh();
  }

  // ===========================================================================
  // Sending and receiving

  /** The sat/vB for a speed, from the last fee estimates (or the network's floor). */
  private rateFor(speed: FeeSpeed): number {
    return estimateFor(this.rates, SPEED_TARGETS[speed]) ?? (this.network === 'bitcoin' ? 3 : 1);
  }

  quoteSend(request: SendRequest): QuoteOutcome {
    const w = this.w;
    const h = this.home;
    if (!w || w.state.stage !== 'ready') return { ok: false, problem: 'not_ready', message: 'The wallet is not set up yet.' };
    const code = parseScannedCode(request.address, { network: this.network, now: Math.floor(this.clock.now() / 1000) });
    if (code.kind !== 'address') return { ok: false, problem: 'invalid_address', message: "That doesn't look like an address on this network." };
    if (!h) return { ok: false, problem: 'not_synced', message: 'Your wallet has not synced yet. Pull down to refresh.' };
    if (request.amountSats <= 0) return { ok: false, problem: 'amount_too_small', message: 'Enter an amount.' };
    if (BigInt(request.amountSats) < MIN_PAYMENT_SATS) return { ok: false, problem: 'amount_too_small', message: "That's too small to send. The smallest payment is 546 sats." };
    const rate = this.rateFor(request.speed);
    // A silent payment's output is a taproot output (34-byte script), and it can only come from the spending balance:
    // BIP 352 needs single-key inputs, and the vault's multisig coins have none.
    const silent = code.silentPayment === true;
    const spendFee = Math.ceil(rate * estimateVsize({ wpkhInputs: 1, outputScriptLengths: [silent ? 34 : 22, 22] }));
    const vaultFee = Math.ceil(rate * estimateVsize({ multisigInputs: 1, outputScriptLengths: [22, 34] }));
    const spending = h.spending.totalSats;
    const viaVault = request.signer === 'hardware' || request.amountSats + spendFee > spending;
    if (silent && viaVault)
      return {
        ok: false,
        problem: 'other',
        message: request.signer === 'hardware' ? "A silent payment can't come from the vault. Pay it from your spending balance." : "A silent payment can only come from your spending balance, and it doesn't hold enough for this. Add to it first.",
      };
    const fee = viaVault ? vaultFee : spendFee;
    const total = request.amountSats + fee;
    if (viaVault && total > h.vault.confirmedSats) return { ok: false, problem: 'insufficient_funds', message: "There isn't enough bitcoin for that and the network fee." };
    const warning = viaVault ? this.vaultPaymentWarning(h, total) : undefined;
    return {
      ok: true,
      quote: {
        request: { ...request },
        feeSats: fee,
        totalSats: total,
        plan: viaVault ? { signer: 'hardware', reason: request.signer === 'hardware' ? 'requested' : 'over-spending-balance' } : { signer: 'phone' },
        remainingAfterSats: viaVault ? spending : Math.max(0, spending - total),
        feeRateSatPerVb: rate,
        estimate: true,
        ...(silent ? { silentPayment: {} } : {}),
        ...(warning ? { warning } : {}),
      },
    };
  }

  /**
   * "Send max" from the spending balance needs a send-max transaction in the Recovery Key wallet (every coin, one output,
   * and the refills' own bookkeeping around a payment from the vault), which is not there yet.
   */
  getWalletDetails(): null {
    // Recovery Key mode's vault descriptor is on the printed kit; showing it here comes later.
    return null;
  }

  quoteSendMax(_request: { address: string; speed: FeeSpeed }): QuoteOutcome {
    return { ok: false, problem: 'other', message: "Send max isn't available yet in Recovery Key mode." };
  }

  /**
   * A payment from the vault spends coins the refills do not need first. If it needs more than those (the vault
   * minus the coin the next refill spends), the refills still to come stop working. This guesses it from the totals;
   * the payment's own result says what really happened.
   */
  private vaultPaymentWarning(h: HomeState, totalSats: number): string | undefined {
    const w = this.w;
    if (!w || h.refills.status !== 'live') return undefined;
    const next = h.nextRefill;
    const refill = next ? w.state.chain?.refills[next.position - 1] : undefined;
    const reserved = next && refill && (next.status === 'ready' || next.status === 'waiting') ? refill.inputs.reduce((sum, i) => sum + i.valueSats, 0) : 0;
    const free = Math.max(0, h.vault.confirmedSats - reserved);
    if (totalSats <= free) return undefined;
    const left = h.refills.left;
    const still = `The ${left} refill${left === 1 ? '' : 's'} still to come would stop working, and you would approve a new batch with your hardware wallet afterwards.`;
    return free === 0
      ? `Your refills use every coin in the vault, so any payment from it uses the coin they are waiting on. ${still}`
      : `This is more than the ${free.toLocaleString('en-US')} sats in your vault that your refills do not need, so it uses their coin. ${still}`;
  }

  async refineQuote(quote: SendQuote): Promise<QuoteOutcome> {
    const w = this.w;
    if (!w || quote.plan.signer !== 'phone') return { ok: true, quote };
    try {
      const q = await w.quoteSend({ address: quote.request.address, amountSats: quote.request.amountSats, feeRate: quote.feeRateSatPerVb });
      return {
        ok: true,
        quote: {
          ...quote,
          feeSats: q.feeSats,
          totalSats: q.totalSats,
          remainingAfterSats: Math.max(0, (this.home?.spending.totalSats ?? 0) - q.totalSats),
          estimate: false,
        },
      };
    } catch (e) {
      const err = mapRkError(e);
      return { ok: false, problem: err.kind === 'insufficient_funds' ? 'insufficient_funds' : 'other', message: err.message };
    }
  }

  sendPayment(quote: SendQuote): Promise<Transaction> {
    return this.exclusive(() =>
      this.guarded(async () => {
        const w = this.requireReady();
        const { address, amountSats } = quote.request;
        const feeRate = quote.feeRateSatPerVb;
        const at = this.clock.now();
        // What the person saw (the keys it names) is what happens.
        const fromVault = quote.plan.signer === 'hardware';
        const res = fromVault ? await w.payFromVault({ address, amountSats, ...(feeRate ? { feeRate } : {}) }) : await w.send({ address, amountSats, ...(feeRate ? { feeRate } : {}) });
        this.doc.sent[res.txid] = { address, amountSats, feeSats: res.feeSats, at, fromVault };
        await this.saveDoc();
        await this.resync();
        return {
          id: res.txid,
          kind: 'sent' as const,
          amountSats,
          feeSats: res.feeSats,
          status: 'pending' as const,
          at: iso(at),
          address,
          txid: res.txid,
          signedBy: fromVault ? ('phone+hardware' as const) : ('phone' as const),
          ...(fromVault ? { fromVault: true } : {}),
        };
      }),
    );
  }

  async receiveAddress(opts: { verifyOnDevice?: boolean } = {}): Promise<ReceiveAddress> {
    if (opts.verifyOnDevice) throw new WalletServiceError('invalid_input', "The spending balance's addresses belong to this phone alone: no hardware wallet holds them. Check the vault's address instead.");
    this.requireReady();
    return { address: this.spendingPeek(), verifiedOnDevice: false };
  }

  // ===========================================================================
  // Guardian mode only

  unlockGuardian(): Promise<void> {
    return Promise.reject(notAvailableYet('A guardian', 'This wallet has no home server.'));
  }
  lockGuardian(): Promise<void> {
    return Promise.reject(notAvailableYet('A guardian', 'This wallet has no home server.'));
  }
  previewReplaceGuardian(): Promise<never> {
    return Promise.reject(notAvailableYet('A guardian', 'This wallet has no home server.'));
  }
  replaceGuardian(): Promise<never> {
    return Promise.reject(notAvailableYet('A guardian', 'This wallet has no home server.'));
  }
  async cancelReplaceGuardian(): Promise<void> {}
  sweepOldWallets(): Promise<never> {
    return Promise.reject(notAvailableYet('A guardian', 'This wallet has no home server.'));
  }
  retireOldWallet(): Promise<void> {
    return Promise.reject(notAvailableYet('A guardian', 'This wallet has no home server.'));
  }
  async confirmHardware(): Promise<void> {}
  setDailyLimit(): Promise<void> {
    return Promise.reject(notAvailableYet('A daily limit', 'Recovery Key mode limits the phone with its refills instead.'));
  }
  turnLimitOff(): Promise<void> {
    return Promise.reject(notAvailableYet('A daily limit', 'Recovery Key mode limits the phone with its refills instead.'));
  }
  setRecoveryDelay(): Promise<void> {
    return Promise.reject(notAvailableYet('A recovery wait', 'Recovery with your Recovery Kit is immediate.'));
  }
  addContact(): Promise<never> {
    return Promise.reject(notAvailableYet('Alert contacts', 'They belong to a guardian.'));
  }
  removeContact(): Promise<void> {
    return Promise.reject(notAvailableYet('Alert contacts', 'They belong to a guardian.'));
  }
  async findBackup(): Promise<null> {
    return null;
  }
  async importBackupFile(): Promise<null> {
    return null;
  }
  restoreFromBackup(): Promise<void> {
    return Promise.reject(notAvailableYet('Restoring a phone backup', 'Use your Recovery Kit and your hardware wallet instead.'));
  }
  recoverWithKit(): Promise<{ movedSats: Sats }> {
    return Promise.reject(notAvailableYet('This recovery', 'Use "I have a Recovery Kit" on the first screen.'));
  }
  startRecovery(): Promise<never> {
    return Promise.reject(notAvailableYet('A recovery wait', 'Recovery with your Recovery Kit is immediate.'));
  }
  acknowledgeRecovery(): void {}
  cancelRecovery(): Promise<void> {
    return Promise.reject(notAvailableYet('A recovery wait'));
  }
  resumePhoneSpending(): Promise<void> {
    return Promise.reject(notAvailableYet('Pausing the phone'));
  }
  renewRecoveryAccess(): Promise<void> {
    return Promise.reject(notAvailableYet('Recovery access'));
  }

  readCode(text: string): ScannedCode {
    return parseScannedCode(text, { network: this.network, now: Math.floor(this.clock.now() / 1000) });
  }

  // ===========================================================================
  // Preferences

  setRecoveryKeyKind(kind: RecoveryKeyKind): void {
    this.doc.keyKind = kind;
    void this.saveDoc();
    this.refresh();
  }

  private async savePrefs(): Promise<void> {
    try {
      await this.deps.platform.kv.set(PREFS_KEY, JSON.stringify(this.prefs));
    } catch {
      /* a preference is not worth a failure */
    }
  }

  setUnit(unit: AmountUnit): void {
    this.prefs.unit = unit;
    void this.savePrefs();
    this.refresh();
  }

  setTheme(theme: ThemePreference): void {
    this.prefs.theme = theme;
    void this.savePrefs();
    this.refresh();
  }

  setMode(_mode: WalletMode): void {
    // The phone runs one kind of wallet; ./routed.ts decides which service that is.
  }

  cancelDevicePrompt(): void {
    this.prompts.cancel();
  }

  private async forgetWallet(): Promise<void> {
    const w = this.w;
    if (w) await w.forget();
    this.unsubWallet?.();
    this.w = undefined;
    this.home = undefined;
    this.cpfp = null;
    this.doc = emptyDoc();
    await this.deps.platform.kv.remove(this.docKey).catch(() => {});
    this.deps.onWalletChange?.(false);
    this.refresh();
  }

  // ===========================================================================
  // Recovery Key actions

  private buildActions(): RecoveryKeyActions {
    const self = this;
    return {
      keyOptions(): RecoveryKeyOption[] {
        return [
          { kind: 'paper', available: true },
          { kind: 'nfc', available: false, unavailableReason: 'Coming later.' },
          { kind: 'hardware', available: true },
        ];
      },

      makeKit(opts: { secondDevice?: HardwareKind } = {}) {
        return self.exclusive(() =>
          self.guarded(async () => {
            const w = self.requireWallet();
            const kind = self.doc.keyKind;
            if (kind === 'nfc') throw notAvailableYet('The NFC card');
            if (w.state.stage !== 'hardware') throw new WalletServiceError('wrong_state', 'Connect your hardware wallet first.');
            self.setProgress(kind === 'paper' ? 'Making your Recovery Key' : 'Reading your second hardware wallet');
            try {
              await self.yieldToUi();
              const sheet =
                kind === 'paper'
                  ? toKitView(await w.createRecoveryKit(), w.kitChallenge())
                  : toKitView(
                      await w.useHardwareRecoveryKey({ kind: self.deps.secondDeviceKind ?? (opts.secondDevice ? toWalletKind(opts.secondDevice) : undefined) }),
                      [],
                      'second hardware wallet',
                    );
              return sheet;
            } finally {
              self.setProgress(null);
            }
          }),
        );
      },

      confirmKit(proof: KitProof) {
        return self.exclusive(() =>
          self.guarded(async () => {
            const w = self.requireWallet();
            // A QR-only device (the ones whose own screens guide the person: QR, Coldcard, Jade) cannot show an address on
            // request: the check is skipped here, and the vault's first deposit address can be compared later (Add to vault).
            const qrOnly = self.deps.silentKinds ?? ['qr', 'coldcard', 'jade'];
            const verifyAddress = !qrOnly.includes(w.state.hardware?.kind as WalletHardwareKind);
            self.setProgress('Setting up your vault: approve on your hardware wallet');
            try {
              const v = await w.confirmKitSaved(proof, { verifyAddress });
              self.deps.onWalletChange?.(true);
              await self.resync();
              return { fingerprint: v.fingerprint };
            } finally {
              self.setProgress(null);
            }
          }),
        );
      },

      previewRefills(opts = {}) {
        return self.guarded(async () => {
          const w = self.requireReady();
          const p = await self.inBatch(opts, (o) => w.previewRefills(o));
          const now = self.clock.now();
          const view: RefillPreview = {
            mode: p.mode,
            amountSats: p.amountSats,
            count: p.count,
            maxCount: p.maxCount,
            periodDays: Math.round((p.periodBlocks * 10) / 1440),
            feePerRefillSats: p.feePerRefillSats,
            totalSats: p.totalSats,
            vaultSats: p.vaultBalanceSats,
            schedule: p.schedule.map((s) => ({ index: s.position, amountSats: s.amountSats, at: iso(s.earliestAt), today: s.earliestAt - now <= 3_600_000 })),
            confirmations: p.count,
          };
          return view;
        });
      },

      approveRefills(opts = {}) {
        return self.exclusive(() =>
          self.guarded(async () => {
            const w = self.requireReady();
            const r = await self.inBatch(opts, (o) => w.approveRefills(o));
            await self.resync();
            // The first refill is available today: let the scheduler send it now, not at the next minute.
            void self.sync();
            const done: RefillApproval = { from: r.from, to: r.to };
            return done;
          }),
        );
      },

      speedUp() {
        return self.exclusive(() =>
          self.guarded(async () => {
            const w = self.requireReady();
            await w.speedUpRefill({ position: self.cpfp?.index });
            self.cpfp = null;
            await self.resync();
          }),
        );
      },

      dismissNotice(id: string) {
        if (self.doc.dismissed.includes(id)) return;
        self.doc.dismissed = [...self.doc.dismissed, id].slice(-100);
        void self.saveDoc();
        self.refresh();
      },

      vaultAddress() {
        return self.vaultPeek();
      },

      verifyVaultAddress() {
        return self.exclusive(() =>
          self.guarded(async () => {
            const w = self.requireReady();
            const r = await w.vaultReceiveAddress({ verifyOnDevice: true });
            self.refresh();
            return { address: r.address, verifiedOnDevice: r.verifiedOnDevice };
          }),
        );
      },

      readKit(input: string) {
        return self.guarded(async () => {
          let kitNetwork: string;
          try {
            const k = decodeKit(input);
            kitNetwork = k.network;
            wipeKit(k);
          } catch (e) {
            throw mapRkError(e);
          }
          if (kitNetwork !== self.network) throw kitNetworkError(kitNetwork);
          const info = await RecoveryKeyWallet.readKit({ network: self.network as CoreNetworkName, esplora: self.esplora() }, input);
          const w = self.w;
          const view: KitInfo = {
            fingerprint: info.fingerprint,
            network: info.network as NetworkName,
            kind: info.kind,
            vaultSats: info.vaultSats,
            unconfirmedSats: info.unconfirmedSats,
            hardwareFingerprint: info.hardwareFingerprint,
            matchesThisPhone: !!w && w.state.stage === 'ready' && w.fingerprint() === info.fingerprint,
          };
          return view;
        });
      },

      recoverWithKit(opts: { kit: string; with: 'hardware' | 'phone'; destination: KitDestination; confirmNewKit?: (kit: RecoveryKit) => Promise<KitProof | false> }) {
        return self.exclusive(() =>
          self.guarded(async () => {
            const confirmNewKit = opts.confirmNewKit && (async (p: PrintableKit, challenge: number[]) => opts.confirmNewKit!(toKitView(p, challenge)));
            let res: { txid: string; amountSats: number; feeSats: number; wallet?: RecoveryKeyWallet };
            if (opts.with === 'phone') {
              const w = self.requireReady();
              res = await w.recoverWithKit({ kit: opts.kit, destination: opts.destination, confirmNewKit });
              await self.resync();
            } else {
              if (self.w?.state.stage === 'ready') throw new WalletServiceError('wrong_state', 'This phone already has a Recovery Key wallet. Use "the kit and this phone", or remove the wallet first.');
              // An unfinished set-up has nothing in it: make room for the recovery.
              if (self.w) await self.forgetWallet();
              self.setProgress('Moving your money: approve on your hardware wallet');
              try {
                res = await RecoveryKeyWallet.recoverWithKit(self.walletDeps(), { kit: opts.kit, destination: opts.destination, confirmNewKit, onEvent: (e) => self.onEvent(e) });
              } finally {
                self.setProgress(null);
              }
              if (res.wallet) {
                self.attach(res.wallet);
                await self.saveDoc();
                await self.resync();
                self.starting = self.startInBackground();
              }
            }
            const out: KitRecoveryResult = { txid: res.txid, movedSats: res.amountSats, feeSats: res.feeSats, newVault: 'newVault' in opts.destination };
            return out;
          }),
        );
      },

      replaceKit(opts: { confirmNewKit: (kit: RecoveryKit) => Promise<KitProof | false> }) {
        return self.exclusive(() =>
          self.guarded(async () => {
            const w = self.requireReady();
            const res = await w.replaceRecoveryKey({ confirmNewKit: async (p, challenge) => opts.confirmNewKit(toKitView(p, challenge)) });
            await self.resync();
            const out: KitRecoveryResult = { txid: res.txid, movedSats: res.amountSats, feeSats: res.feeSats, newVault: true };
            return out;
          }),
        );
      },

      setRefillDefaults(defaults: { amountSats: Sats; count: number }) {
        self.doc.defaults = { amountSats: Math.max(10_000, Math.round(defaults.amountSats)), count: Math.min(52, Math.max(1, Math.round(defaults.count))) };
        void self.saveDoc();
        self.refresh();
      },

      testServer(url: string) {
        return self.checkServer(url);
      },

      setServer(url: string | null) {
        return self.exclusive(() =>
          self.guarded(async () => {
            if (self.w?.state.stage === 'hardware') throw new WalletServiceError('wrong_state', 'Finish setting up your Recovery Key first.');
            const parsed = url === null ? undefined : parseServerUrl(url);
            self.doc.server = parsed === defaultServerUrl(self.network) ? undefined : parsed;
            await self.saveDoc();
            // The wallet reads the chain through one client for its whole life: open it again with the new server.
            if (self.w) {
              const old = self.w;
              self.unsubWallet?.();
              await old.close().catch(() => {});
              const w = await RecoveryKeyWallet.open(self.walletDeps());
              self.w = undefined;
              if (w) self.attach(w);
              self.rates = {};
              self.home = undefined;
              void self.sync();
            }
            self.refresh();
          }),
        );
      },
    };
  }

  /**
   * Runs a refill preview or approval with the amount and count asked (or the defaults). More refills for a running
   * chain keep the amount that is signed into it: when the wallet says so, the same call goes again without one.
   */
  private async inBatch<T>(opts: { amountSats?: Sats; count?: number }, fn: (o: { amountSats?: number; count: number }) => Promise<T>): Promise<T> {
    const count = opts.count ?? this.doc.defaults.count;
    try {
      return await fn({ amountSats: opts.amountSats ?? this.doc.defaults.amountSats, count });
    } catch (e) {
      if (e instanceof RecoveryKeyError && e.code === 'wrong_state' && /continue the current chain/.test(e.message)) return fn({ count });
      throw e;
    }
  }

  /** Asks the server for the tip and the network's first block, so "my own server" is tried before it is used. */
  private async checkServer(url: string): Promise<ServerCheck> {
    let base: string;
    try {
      base = parseServerUrl(url);
    } catch (e) {
      return { ok: false, message: e instanceof Error ? e.message : String(e) };
    }
    const fetchFn = this.fetchFn();
    const client = new EsploraClient({ baseUrl: base, fetch: fetchFn, timeoutMs: 10_000 });
    let height: number;
    try {
      height = await client.tipHeight();
    } catch (e) {
      const why = e instanceof RecoveryKeyError ? e.message : 'It did not answer.';
      return { ok: false, message: `Couldn't read the chain from that server. ${why}` };
    }
    const expected = GENESIS_HASHES[this.network];
    if (expected) {
      try {
        const res = await fetchFn(`${base}/block-height/0`, { method: 'GET' });
        const body = res.ok ? (await res.text()).trim() : '';
        if (/^[0-9a-f]{64}$/.test(body) && body !== expected)
          return { ok: false, height, message: `That server is on a different network. This wallet is on ${this.network === 'testnet' ? 'testnet4' : this.network}.` };
      } catch {
        /* a server that will not tell its first block is judged by the tip alone */
      }
    }
    let note = '';
    try {
      const rates = await client.feeEstimates();
      if (!Object.keys(rates).length) note = ' It has no fee estimates, so payments will use the minimum fee.';
    } catch {
      note = ' It has no fee estimates, so payments will use the minimum fee.';
    }
    return { ok: true, height, message: `Connected. The chain is at block ${height.toLocaleString('en-US')}.${note}` };
  }
}

/** Opens the Recovery Key service: reads the phone's storage and opens the wallet there, if there is one. */
export async function createRkWalletService(deps: RkServiceDeps): Promise<RkWalletService> {
  const svc = new Service(deps);
  await svc.init();
  return svc;
}

export const rkExists = Service.exists;

