/**
 * The `WalletService` on the real wallet (`@trikey/wallet`).
 *
 * One `RealWalletService` per app run and mode. It owns at most one `TrikeyWallet` (created when onboarding connects
 * the hardware wallet, or opened from the phone's storage), projects the wallet's state (its history with its send
 * log), the guardian's status and the app's own event log into the UI's `WalletState`, and turns the wallet's errors
 * and the guardian's refusals into `WalletServiceError`s the screens can show.
 *
 * The backup store is chosen per call (the person picks where the backup goes, or where to look for one): the wallet
 * takes the `CloudBackupStore` for each backup and restore.
 *
 * No React and no React Native in here: everything platform-specific (secure storage, hardware providers, the cloud,
 * the share sheet) comes in through `RealServiceDeps`, so the same code runs in the app and in Node's tests.
 *
 * Modes keep their data apart: the wallet's state lives under `trikey.wallet.<mode>.<network>` in the key-value store
 * and its secrets under random ids in the secure store.
 */
import { npubEncode } from 'nostr-tools/nip19';
import {
  BACKUP_FILE_PREFIX,
  BACKUP_FILE_SUFFIX,
  KEY3_MIXED_NOTE,
  TrikeyWallet,
  WalletError,
  parseBackup,
  type Argon2Params,
  type CloudBackupStore,
  type HardwareKind as WalletHardwareKind,
  type HardwareProvider,
  type KeyValueStore,
  type PasskeyPrf,
  type SecureKeyStore,
  type ReplacePlan,
  type ReplaceStep,
  type SendQuote as WalletQuote,
  type WalletDeps,
  type WalletEvent,
  type WalletSnapshot,
} from '@trikey/wallet';
import { parseScannedCode } from '@trikey/wallet/scan';
import { SimplePoolRelayPool, type Policy, type RelayPool } from '@trikey/protocol';
import { addEvent, buildActivity, emptyLog, hostFromLabel, loadLog, saveLog, takeLegacySends, type AppLog } from './app-log';
import { DevicePromptStore, compositeProvider, ledgerHint, withDevicePrompts } from './device';
import { WalletServiceError, notAvailableYet } from './errors';
import { SIMULATED_OPTION, hardwareBrandOf, hardwareOptionTable, type UiOs } from './hardware-options';
import { mapError, refusalToError } from './real-errors';
import { emptyRecoveryKeyState } from './rk-empty';
import type { ReceiveAddress, WalletService } from './service';
import type { SilentPaymentActions } from './sp-actions';
import { emptySilentPayments } from './sp-empty';
import {
  SELECTABLE_NETWORKS,
  type AmountUnit,
  type BackupOptions,
  type CloudProvider,
  type Contact,
  type FoundBackup,
  type Guardian,
  type GuardianAddress,
  type HardwareKind,
  type HardwareOption,
  type HardwareWallet,
  type IsoDate,
  type LostKey,
  type NetworkName,
  type PhoneBackup,
  type QuoteOutcome,
  type QuoteProblem,
  type RecoveryDelayDays,
  type RecoveryInProgress,
  type RecoveryKeyKind,
  type ReplaceGuardianPlan,
  type ReplaceGuardianResult,
  type RestoreUnlock,
  type Sats,
  type ScannedCode,
  type SendQuote,
  type SendRequest,
  type SilentPaymentsState,
  type ThemePreference,
  type Transaction,
  type WalletMode,
  type WalletState,
} from './types';

/** What the real wallet needs from the phone. `createPlatform()` fits; tests pass the in-memory stand-ins. */
export interface PlatformLike {
  os: UiOs;
  isSecure: boolean;
  secureKeys: SecureKeyStore;
  kv: KeyValueStore;
  /** Every backup provider this build has, best first. */
  cloudBackups: CloudBackupStore[];
  passkeys: PasskeyPrf;
}

export interface RealServiceDeps {
  mode: 'simulator' | 'real';
  platform: PlatformLike;
  /** The hardware providers for a network. `onLedgerInteraction` is the Ledger adapter's "confirm on your device" hook. */
  hardware: (network: NetworkName, hooks: { onLedgerInteraction: (interaction: string) => void }) => HardwareProvider[] | Promise<HardwareProvider[]>;
  /** Kinds whose own screens guide the person (QR devices). The "Confirm on your device" sheet stays out of their way. */
  silentKinds?: readonly WalletHardwareKind[];
  relayPool?: () => RelayPool;
  clock?: { now(): number };
  /** The network to start on (the simulator is regtest). */
  network?: NetworkName;
  deviceName?: string;
  recoveryCodeKdf?: Argon2Params;
  rpcTimeoutMs?: number;
  rpcRetryIntervalMs?: number;
  /** Sync this often while the service lives (ms; default 60 s, 0 = only when asked). */
  syncIntervalMs?: number;
  /** How often screens re-read the clock (ms, default 30 s). */
  clockTickMs?: number;
  /** Hands a backup file to the OS share sheet. */
  shareBackupFile?: (name: string, bytes: Uint8Array) => Promise<void>;
  /** Lets the person choose a backup file. Null: they cancelled. */
  pickBackupFile?: () => Promise<{ name: string; bytes: Uint8Array } | null>;
  /** Gives the UI thread a turn before heavy work (default: a short timer). */
  yieldToUi?: () => Promise<void>;
  /** Facts for Settings > Developer. */
  info?: () => string[];
  /** More Settings > Developer tools (the simulator's device swap). */
  devTools?: Pick<NonNullable<WalletService['dev']>, 'useNewSimulatedDevice'>;
}

export interface RealWalletService extends WalletService {
  /** The wallet, once there is one. */
  readonly wallet: TrikeyWallet | undefined;
  readonly prompts: DevicePromptStore;
  close(): Promise<void>;
}

const DEFAULT_SWEEP_FEE_CAP_SATS = 20_000;
/** A helper coin below this cannot pay its share of the fee of a payment at ordinary rates: shown as not funded. */
const HELPER_USABLE_SATS = 1_000;
const PREFS_KEY = 'trikey.app.prefs.v1';
const networkPrefKey = (mode: string) => `trikey.app.network.${mode}`;
const walletKey = (mode: string, network: NetworkName) => `trikey.wallet.${mode}.${network}`;

const PLACEHOLDER_HARDWARE: HardwareWallet = { kind: 'ledger', brand: 'hardware wallet', model: 'Hardware wallet' };

const toWalletKind = (kind: HardwareKind): WalletHardwareKind | undefined => (kind === 'simulated' ? undefined : kind);

function describeProblem(e: WalletError): { problem: QuoteProblem; message: string } {
  const message = mapError(e).message;
  switch (e.code) {
    case 'invalid_address':
      return { problem: 'invalid_address', message };
    case 'silent_payment_needs_helper':
      return { problem: 'needs_helper', message };
    case 'amount_too_small':
      return { problem: 'amount_too_small', message };
    case 'insufficient_funds':
      return { problem: 'insufficient_funds', message };
    case 'no_chain_data':
      return { problem: 'not_synced', message };
    case 'no_fee_estimate':
      return { problem: 'no_fee_estimate', message };
    case 'wrong_state':
      return { problem: 'not_ready', message };
    default:
      return { problem: 'other', message };
  }
}

/** What each step of "Replace guardian" looks like on the progress line. */
const REPLACE_PROGRESS: Record<ReplaceStep, string> = {
  pair: 'Pairing the new guardian: approve on your hardware wallet',
  sign: 'Signing the move: approve on your hardware wallet',
  broadcast: 'Sending the move to the network',
  retire: 'Retiring the old wallet on the old guardian: approve on your hardware wallet',
  switch: 'Switching to the new wallet',
};

const providerLabel: Record<string, { label: string; detail?: string }> = {
  icloud: { label: 'iCloud Drive' },
  'google-drive': { label: 'Google Drive' },
  file: {
    label: 'A backup file',
    detail: 'Kept on this phone. Save a copy somewhere safe, like Files or an email to yourself.',
  },
};

class Service implements RealWalletService {
  readonly prompts = new DevicePromptStore();
  readonly clockTickMs: number;
  readonly dev: NonNullable<WalletService['dev']>;

  private w?: TrikeyWallet;
  private unsubWallet?: () => void;
  private network: NetworkName;
  private state!: WalletState;
  private readonly listeners = new Set<() => void>();
  private hw?: HardwareProvider;
  private rawProviders: HardwareProvider[] = [];
  private log: AppLog = emptyLog();
  private prefs: { unit: AmountUnit; theme: ThemePreference } = { unit: 'sats', theme: 'system' };
  private progress: string | null = null;
  private syncing = false;
  private reachable = true;
  private preview?: { guardianNpub: string; label?: string; relays: string[]; expiresAt: number };
  private recoveryCodeValue: string | null = null;
  private readonly quotes = new Map<string, WalletQuote>();
  private quoteCounter = 0;
  private chain: Promise<unknown> = Promise.resolve();
  private abort?: AbortController;
  private timer?: ReturnType<typeof setInterval>;
  private closed = false;
  private starting?: Promise<void>;
  private addressCache?: { key: string; address: string };
  private keyKind: RecoveryKeyKind = 'paper';
  private readonly clock: { now(): number };
  private replacePlan: ReplaceGuardianPlan | null = null;
  private replaceStep: ReplaceStep | null = null;

  constructor(private readonly deps: RealServiceDeps) {
    this.clock = deps.clock ?? { now: () => Date.now() };
    this.clockTickMs = deps.clockTickMs ?? 30_000;
    this.network = deps.network ?? 'testnet';
    this.prompts.subscribe(() => this.refresh());
    const self = this;
    this.dev = {
      async forgetWallet() {
        await self.forgetWallet();
      },
      info: () => [...(deps.info?.() ?? []), ...(self.w ? [`Wallet id ${self.w.state.wallet?.walletId ?? 'not paired yet'}`] : [])],
      ...deps.devTools,
    };
  }

  // ===========================================================================
  // Startup

  private get mode() {
    return this.deps.mode;
  }

  private get storageKey() {
    return walletKey(this.mode, this.network);
  }

  private get logKey() {
    return `${this.storageKey}.app`;
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
    const candidates: NetworkName[] = this.mode === 'simulator' ? ['regtest'] : SELECTABLE_NETWORKS;
    let found: NetworkName | undefined;
    for (const n of candidates) {
      if ((await kv.get(walletKey(this.mode, n)).catch(() => null)) !== null) {
        found = n;
        break;
      }
    }
    if (this.mode === 'simulator') this.network = 'regtest';
    else {
      const saved = (await kv.get(networkPrefKey(this.mode)).catch(() => null)) as NetworkName | null;
      this.network = found ?? (saved && SELECTABLE_NETWORKS.includes(saved) ? saved : this.deps.network ?? 'testnet');
    }

    await this.buildHardware();
    this.log = await loadLog(kv, this.logKey);
    this.state = this.project();

    if (found) {
      const w = await TrikeyWallet.open(this.walletDeps());
      if (w) this.attach(w);
    }
    if (this.w) this.starting = this.startInBackground();
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

  private walletDeps(): WalletDeps {
    return {
      network: this.network,
      secureStore: this.deps.platform.secureKeys,
      store: this.deps.platform.kv,
      relayPool: this.deps.relayPool ?? (() => new SimplePoolRelayPool()),
      hardware: this.hw,
      passkey: this.deps.platform.passkeys,
      clock: this.deps.clock,
      storageKey: this.storageKey,
      recoveryCodeKdf: this.deps.recoveryCodeKdf,
      rpcTimeoutMs: this.deps.rpcTimeoutMs,
      rpcRetryIntervalMs: this.deps.rpcRetryIntervalMs,
    };
  }

  private attach(w: TrikeyWallet): void {
    this.unsubWallet?.();
    this.w = w;
    this.unsubWallet = w.on((e) => this.onEvent(e));
    this.addressCache = undefined;
    // An older app kept who-paid-whom in its own log: the wallet's send log has it now.
    const legacy = takeLegacySends(this.log);
    if (legacy.length) void w.importSendLog(legacy).then(() => saveLog(this.deps.platform.kv, this.logKey, this.log)).catch(() => undefined);
    this.refresh();
  }

  private async startInBackground(): Promise<void> {
    const w = this.w;
    if (!w || this.closed) return;
    try {
      await w.start();
      this.reachable = true;
    } catch (e) {
      this.noteGuardianResult(e);
    }
    await this.sync();
    const every = this.deps.syncIntervalMs ?? 60_000;
    if (every > 0 && !this.closed) this.timer ??= setInterval(() => void this.sync(), every);
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.starting?.catch(() => {}); // a connection opened after close() would never be closed
    this.unsubWallet?.();
    this.prompts.clearAll();
    await this.w?.close().catch(() => {});
  }

  get wallet(): TrikeyWallet | undefined {
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

  private iso(ms: number): IsoDate {
    return new Date(ms).toISOString();
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

  private guardianView(snap: WalletSnapshot | undefined): Guardian {
    const s = this.w?.state;
    const g = s?.guardian;
    const gs = s?.guardianStatus;
    const label = g?.label ?? this.preview?.label;
    const relays = g?.relays ?? this.preview?.relays ?? [];
    const npub = g ? npubEncode(g.pubkey) : (this.preview?.guardianNpub ?? '');
    const status = !this.reachable ? 'offline' : gs?.state === 'locked' ? 'locked' : 'online';
    return {
      host: hostFromLabel(label),
      ...(label ? { label } : {}),
      status,
      lastSeenAt: this.iso(gs?.checkedAt ?? snap?.syncedAt ?? this.clock.now()),
      relays,
      chainData: 'your-node',
      npub,
      ...(g?.key3Mixed ? { key3Note: KEY3_MIXED_NOTE } : {}),
    };
  }

  private receiveAddressNow(): string {
    const s = this.w?.state;
    if (!s?.wallet || s.stage !== 'paired' || !s.hardware?.addressVerified) return '';
    const index = s.chain?.nextReceiveIndex ?? 0;
    const key = `${s.wallet.descriptor}#${index}`;
    if (this.addressCache?.key === key) return this.addressCache.address;
    try {
      const address = this.w!.multisig().derive(0, index).address;
      this.addressCache = { key, address };
      return address;
    } catch {
      return '';
    }
  }

  private recoveryView(): { recovery: RecoveryInProgress | null; outcome: WalletState['recoveryOutcome'] } {
    const rec = this.w?.state.recovery;
    const r = rec?.recovery;
    if (!rec || !r) return { recovery: null, outcome: null };
    if (r.state === 'cancelled') return { recovery: null, outcome: 'cancelled' };
    // Completed: the guardian co-signed the move. Finished: it took the new wallet over and this phone switched to it.
    if (r.state === 'completed') return { recovery: null, outcome: rec.destination && this.w?.state.wallet?.walletId === rec.destination.walletId ? 'finished' : 'completed' };
    const initiator = rec.role === 'initiator';
    const names = (this.w?.alertContacts() ?? []).map((c) => c.name ?? c.npub.slice(0, 12));
    return {
      outcome: null,
      recovery: {
        id: r.recoveryId,
        startedAt: this.iso(r.startedAt * 1000),
        completesAt: this.iso(r.readyAt * 1000),
        origin: initiator ? 'this-phone' : 'someone-else',
        lostKey: r.survivingRole === 'app' ? 'hardware' : 'phone',
        alertRecipients: ['This phone', ...names],
        acknowledged: initiator || this.log.acknowledged.includes(r.recoveryId),
        movingSats: r.amountSats,
        state: r.state,
      },
    };
  }

  private project(): WalletState {
    const s = this.w?.state;
    const snap = this.w?.snapshot();
    const rules = s?.rules?.policy;
    const gs = s?.guardianStatus;
    const now = this.clock.now();
    const { recovery, outcome } = this.recoveryView();
    const backup = s?.backup;
    const contacts: Contact[] = (this.w?.alertContacts() ?? []).map((c) => ({ id: c.pubkey, name: c.name ?? `${c.npub.slice(0, 9)}…${c.npub.slice(-4)}`, npub: c.npub }));
    const limit = rules?.dailyLimitSats ?? snap?.dailyLimit?.limitSats ?? 0;
    const used = snap?.dailyLimit?.spentEstimateSats ?? 0;
    const hardware = this.hardwareView();
    return {
      backing: this.mode,
      network: this.network,
      capabilities: { lockGuardian: true, replaceGuardian: true, recoveryKey: true },
      progress: this.progress,
      devicePrompt: this.prompts.getSnapshot(),
      syncing: this.syncing,
      synced: !!s?.chain,
      phoneSpending: gs?.phoneSpending ?? 'enabled',
      recoveryOutcome: outcome,
      recovering: s?.stage === 'recovering',
      onboarded: s?.stage === 'paired',
      mode: 'guardian',
      unit: this.prefs.unit,
      theme: this.prefs.theme,
      hardware,
      addressVerified: !!s?.hardware?.addressVerified,
      backup: backup
        ? {
            provider: backup.provider === 'icloud' || backup.provider === 'google-drive' ? backup.provider : 'file',
            lastBackedUpAt: this.iso(backup.createdAt),
            unlockedBy: backup.slots.map((x) => (x === 'passkey-prf' ? 'passkey' : 'recovery-code')),
          }
        : null,
      guardian: this.guardianView(snap),
      recoveryDelayDays: rules?.recoveryDelayDays ?? 7,
      dailyLimit: { limitSats: limit, usedSats: used, ...(s ? { cosignedCount: s.spends.filter((x) => x.at > now - 86_400_000).length } : {}) },
      contacts,
      balanceSats: snap?.balance.totalSats ?? 0,
      receiveAddress: this.receiveAddressNow(),
      activity: buildActivity(snap?.history ?? [], this.log, now, this.w?.singleKeyView().silentPayments?.received ?? []),
      recovery,
      recoveryKey: emptyRecoveryKeyState({ keyKind: this.keyKind, network: this.network }),
      hardwareConfirmRequired: this.w?.hardwareConfirmRequired ?? false,
      replace: {
        plan: this.replacePlan,
        step: this.replaceStep,
        pending: s?.replacing
          ? { ...(s.replacing.guardian.label ? { guardianLabel: s.replacing.guardian.label } : {}), signed: s.replacing.phase === 'signed', oldGuardianOffline: s.replacing.oldGuardianOffline }
          : null,
      },
      oldWallets: (s?.retiredWallets ?? []).map((o) => ({ id: o.walletId, host: hostFromLabel(o.guardian.label), retiredOnGuardian: o.retiredOnGuardian })),
      walletRetired: s?.retiredByGuardian && s.retiredByGuardian.walletId === s.wallet?.walletId ? { reason: s.retiredByGuardian.reason } : null,
      finishedRecovery:
        outcome === 'finished' && s?.recovery?.recovery
          ? { lostKey: s.recovery.recovery.survivingRole === 'app' ? 'hardware' : 'phone', movedSats: s.recovery.recovery.amountSats }
          : null,
      silentPayments: this.silentView(),
    };
  }

  /** The silent payment part of the state: what the screens show about the helper coin, the scan and what was received. */
  private silentView(): SilentPaymentsState {
    const w = this.w;
    const view = w?.state.helper && w.state.silentPayments ? w.singleKeyView() : undefined;
    const sp = view?.silentPayments;
    const h = view?.helper;
    if (!w || !sp || !h) return emptySilentPayments('full');
    const preview = w.previewSilentSweep();
    const helperSats = h.confirmedSats + h.unconfirmedSats;
    return {
      support: 'full',
      setUp: true,
      receiving: sp.receiving,
      scan: {
        state: sp.scan.state,
        source: sp.scan.source,
        scannedHeight: sp.scan.scannedHeight,
        ...(sp.scan.tipHeight !== undefined ? { tipHeight: sp.scan.tipHeight } : {}),
        ...(sp.scan.checkedAt ? { checkedAt: this.iso(sp.scan.checkedAt) } : {}),
        ...(sp.scan.lastMatchAt ? { lastMatchAt: this.iso(sp.scan.lastMatchAt) } : {}),
        ...(sp.scan.message ? { message: sp.scan.message } : {}),
        ...(sp.scan.guardian ? { guardian: sp.scan.guardian } : {}),
      },
      labels: sp.labels,
      helper: { sats: helperSats, unconfirmedSats: h.unconfirmedSats, funded: helperSats >= HELPER_USABLE_SATS, viaGuardian: sp.helperViaGuardian },
      balance: { sats: sp.balance.totalSats, unconfirmedSats: sp.balance.unconfirmedSats },
      coins: sp.coins
        .filter((c) => c.status === 'unspent')
        .map((c) => ({ id: `${c.txid}:${c.vout}`, txid: c.txid, valueSats: c.valueSats, ...(c.label !== undefined ? { label: c.label } : {}), confirmed: c.height > 0, foundAt: this.iso(c.foundAt) })),
      move: {
        feeRateSatPerVb: preview.feeRate,
        ready: preview.ready,
        totalFeeSats: preview.totalFeeSats,
        totalNetSats: preview.totalNetSats,
        coins: preview.coins.map((c) => ({ id: `${c.txid}:${c.vout}`, valueSats: c.valueSats, feeSats: c.feeSats, netSats: c.netSats, waiting: c.waiting })),
      },
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

  /** Runs `job`; whatever it throws becomes a `WalletServiceError`, and a guardian that does not answer is noted. */
  private async guarded<T>(job: () => Promise<T>): Promise<T> {
    try {
      return await job();
    } catch (e) {
      this.noteGuardianResult(e);
      throw mapError(e);
    }
  }

  private noteGuardianResult(e: unknown): void {
    const refusal = e instanceof WalletError ? e.refusal : undefined;
    if (refusal?.kind === 'unreachable') {
      this.reachable = false;
      this.refresh();
    }
  }

  private requireWallet(): TrikeyWallet {
    if (!this.w) throw new WalletServiceError('wrong_state', 'Set up the wallet first.');
    return this.w;
  }

  private async yieldToUi(): Promise<void> {
    await (this.deps.yieldToUi ? this.deps.yieldToUi() : new Promise<void>((r) => setTimeout(r, 30)));
  }

  private async saveLogNow(): Promise<void> {
    this.refresh();
    await saveLog(this.deps.platform.kv, this.logKey, this.log);
  }

  private onEvent(e: WalletEvent): void {
    switch (e.type) {
      case 'state':
      case 'pending_settled':
        this.refresh();
        break;
      case 'hardware_prompt':
        if (e.purpose === 'payment' || e.purpose === 'recovery-sweep') this.prompts.pendingDetail = e.text;
        break;
      case 'progress':
        if (e.operation === 'replace-guardian') {
          this.replaceStep = e.step;
          this.setProgress(REPLACE_PROGRESS[e.step]);
        }
        break;
      case 'wallet_switched':
        this.addressCache = undefined;
        if (e.reason === 'recovery') {
          const moved = this.w?.state.recovery?.recovery?.amountSats ?? 0;
          addEvent(this.log, { kind: 'recovery-finished', movedSats: moved, at: this.clock.now() });
          void this.saveLogNow();
          // The new wallet's coins, from the guardian that now guards it.
          void this.sync();
        } else this.refresh();
        break;
      case 'silent_payments_found':
        this.refresh();
        break;
      case 'alert': {
        const a = e.alert;
        if (a.type === 'guardian_locked') {
          addEvent(this.log, { kind: 'guardian-locked', host: hostFromLabel(this.w?.state.guardian?.label), ...(a.reason === 'remote' ? { byPhone: true } : {}), at: e.atMs });
          void this.saveLogNow();
        } else if (a.type === 'wallet_retired') {
          addEvent(this.log, { kind: 'wallet-retired', reason: a.reason, at: e.atMs });
          void this.saveLogNow();
        } else this.refresh();
        break;
      }
    }
  }

  private async ensureWallet(): Promise<TrikeyWallet> {
    if (this.w) return this.w;
    this.setProgress('Creating your phone key');
    try {
      await this.yieldToUi();
      const w = await TrikeyWallet.create(this.walletDeps(), { deviceName: this.deps.deviceName ?? 'Trikey phone' });
      this.log = emptyLog();
      this.attach(w);
      return w;
    } finally {
      this.setProgress(null);
    }
  }

  // ===========================================================================
  // Sync

  async sync(): Promise<void> {
    const w = this.w;
    if (!w || w.stage === 'new' || this.closed) return;
    if (this.syncing) return;
    this.syncing = true;
    this.refresh();
    try {
      // A recovering phone follows its recovery; the guardian's status says when it took the new wallet over.
      if (w.stage === 'recovering') await w.refreshStatus().then(() => w.recoveryStatus());
      if (w.stage === 'paired') {
        const snap = await w.sync();
        const now = this.clock.now();
        let changed = false;
        for (const h of snap.history) if (h.confirmations === 0 && this.log.seen[h.txid] === undefined) ((this.log.seen[h.txid] = now), (changed = true));
        if (changed) await saveLog(this.deps.platform.kv, this.logKey, this.log);
      }
      this.reachable = true;
    } catch (e) {
      this.noteGuardianResult(e);
    } finally {
      this.syncing = false;
      this.refresh();
    }
  }

  // ===========================================================================
  // Onboarding

  setNetwork(network: NetworkName): void {
    if (this.w) throw new WalletServiceError('wrong_state', "This wallet's network can't change.");
    if (this.mode === 'simulator' && network !== 'regtest') throw new WalletServiceError('invalid_input', 'The simulator works on regtest only.');
    if (!SELECTABLE_NETWORKS.includes(network)) throw new WalletServiceError('invalid_input', "Mainnet isn't available yet.");
    this.network = network;
    void this.deps.platform.kv.set(networkPrefKey(this.mode), network).catch(() => {});
    void this.buildHardware().then(() => this.loadLogFor()).then(() => this.refresh());
    this.refresh();
  }

  private async loadLogFor(): Promise<void> {
    this.log = await loadLog(this.deps.platform.kv, this.logKey);
  }

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
        this.abort?.abort();
        const ac = (this.abort = new AbortController());
        this.setProgress(`Connecting to your ${hardwareBrandOf(kind)}`);
        try {
          await w.connectHardware({ kind: toWalletKind(kind), signal: ac.signal });
          return this.hardwareView();
        } finally {
          this.setProgress(null);
        }
      }),
    );
  }

  async pairGuardian(pairingCode: string): Promise<Guardian> {
    return this.guarded(async () => {
      const w = this.requireWallet();
      this.setProgress('Reaching your guardian');
      try {
        const p = await w.scanGuardian(pairingCode);
        this.preview = { guardianNpub: p.guardianNpub, label: p.label, relays: p.relays, expiresAt: p.expiresAt };
      } finally {
        this.setProgress(null);
      }
      return this.getState().guardian;
    });
  }

  setUpRules(limitSats: Sats, delayDays: RecoveryDelayDays): Promise<void> {
    return this.exclusive(() =>
      this.guarded(async () => {
        const w = this.requireWallet();
        const preview = this.preview;
        if (!preview) throw new WalletServiceError('wrong_state', 'Scan the guardian first.');
        if (Math.floor(this.clock.now() / 1000) >= preview.expiresAt)
          throw new WalletServiceError('pairing_expired', 'The pairing code ran out (they last 5 minutes). Open a fresh one on your guardian and scan it again.');
        const rules: Policy = { dailyLimitSats: limitSats, recoveryDelayDays: delayDays, alertContacts: [], sweepFeeCapSats: DEFAULT_SWEEP_FEE_CAP_SATS };
        this.setProgress('Pairing: approve on your hardware wallet');
        try {
          await w.pair({ rules, deviceName: this.deps.deviceName });
          this.preview = undefined;
        } finally {
          this.setProgress(null);
        }
      }),
    );
  }

  finishOnboarding(_mode?: WalletMode): void {
    this.refresh();
  }

  // ===========================================================================
  // Backup

  async getBackupOptions(): Promise<BackupOptions> {
    const providers = [];
    for (const store of this.deps.platform.cloudBackups) {
      const info = providerLabel[store.provider] ?? { label: store.provider };
      providers.push({ provider: store.provider as CloudProvider, label: info.label, detail: info.detail, available: await store.isAvailable().catch(() => false) });
    }
    const passkey = await this.deps.platform.passkeys.isSupported().catch(() => false);
    return { providers, passkey };
  }

  private storeOf(provider: CloudBackupStore['provider']): CloudBackupStore | undefined {
    return this.deps.platform.cloudBackups.find((s) => s.provider === provider);
  }

  private storeFor(provider: CloudProvider): CloudBackupStore {
    const store = this.storeOf(provider === 'icloud' || provider === 'google-drive' ? provider : 'file');
    if (!store) throw new WalletServiceError('backup_unavailable', "That place isn't available on this phone.");
    return store;
  }

  createBackup(provider: CloudProvider): Promise<PhoneBackup> {
    return this.exclusive(() =>
      this.guarded(async () => {
        const w = this.requireWallet();
        const store = this.storeFor(provider);
        if (!(await store.isAvailable().catch(() => false))) throw new WalletServiceError('backup_unavailable', "That place isn't available on this phone right now.");
        const passkey = await this.deps.platform.passkeys.isSupported().catch(() => false);
        this.setProgress('Encrypting your backup');
        try {
          await this.yieldToUi(); // paint the progress before the key stretching starts
          const r = await w.createBackup({ passkey, recoveryCode: true, cloud: store });
          this.recoveryCodeValue = r.recoveryCode ?? null;
        } finally {
          this.setProgress(null);
        }
        return this.getState().backup!;
      }),
    );
  }

  recoveryCode(): string | null {
    return this.recoveryCodeValue;
  }

  dismissRecoveryCode(): void {
    this.recoveryCodeValue = null;
  }

  async exportBackupFile(): Promise<void> {
    return this.guarded(async () => {
      const b = this.requireWallet().state.backup;
      if (!b) throw new WalletServiceError('wrong_state', 'Make a backup first.');
      if (!this.deps.shareBackupFile) throw notAvailableYet('Saving the backup file');
      const store = this.storeOf(b.provider as CloudBackupStore['provider']) ?? this.storeOf('file');
      const bytes = await store?.read(b.name);
      if (!bytes) throw new WalletServiceError('backup_not_found', "The backup file isn't on this phone any more. Make a new backup.");
      await this.deps.shareBackupFile(b.name, bytes);
    });
  }

  // ===========================================================================
  // Sending and receiving

  /** The last quote and what it was made from: asking again for the same thing about the same coins costs nothing. */
  private lastQuote?: { key: string; outcome: QuoteOutcome };

  quoteSend(request: SendRequest): QuoteOutcome {
    const w = this.w;
    if (!w || w.stage !== 'paired') return { ok: false, problem: 'not_ready', message: 'The wallet is not set up yet.' };
    const st = w.state;
    const key = JSON.stringify([
      request.address,
      request.amountSats,
      request.speed,
      request.signer ?? 'auto',
      st.chain?.syncedAt,
      st.guardianStatus?.checkedAt,
      st.guardianStatus?.state,
      st.guardianStatus?.phoneSpending,
      st.guardianStatus?.activeRecoveryId,
      st.rules?.policyHash,
      st.spends.length,
      // a silent payment is planned from the helper coin and whether the guardian co-signs it
      st.helper?.utxos.map((u) => `${u.txid}:${u.vout}`).join(','),
      st.silentPayments?.registration?.helper,
      Math.floor(this.clock.now() / 60_000), // the daily limit window moves
    ]);
    if (this.lastQuote?.key === key) return this.lastQuote.outcome;
    const outcome = this.makeQuote(w, request);
    this.lastQuote = { key, outcome };
    return outcome;
  }

  private makeQuote(w: TrikeyWallet, request: SendRequest): QuoteOutcome {
    try {
      const q = w.quoteSend({
        address: request.address,
        amountSats: request.amountSats,
        speed: request.speed,
        ...(request.signer === 'hardware' ? { signer: 'hardware' as const } : {}),
      });
      const ref = `q${++this.quoteCounter}`;
      this.quotes.set(ref, q);
      if (this.quotes.size > 20) this.quotes.delete(this.quotes.keys().next().value!);
      const quote: SendQuote = {
        request: { ...request },
        feeSats: q.feeSats,
        totalSats: q.totalSats,
        plan: q.plan.signer === 'phone+guardian' ? { signer: 'phone+guardian' } : { signer: 'hardware', reason: q.plan.reason },
        remainingAfterSats: q.remainingAfterSats,
        feeRateSatPerVb: q.feeRate,
        ref,
        ...(q.silentPayment ? { silentPayment: { outputAddress: q.silentPayment.outputAddress, helperFeeSats: q.silentPayment.helper.feeSats } } : {}),
      };
      return { ok: true, quote };
    } catch (e) {
      if (e instanceof WalletError) return { ok: false, ...describeProblem(e) };
      return { ok: false, problem: 'other', message: mapError(e).message };
    }
  }

  sendPayment(quote: SendQuote): Promise<Transaction> {
    return this.exclusive(() =>
      this.guarded(async () => {
        const w = this.requireWallet();
        const real = quote.ref ? this.quotes.get(quote.ref) : undefined;
        if (quote.plan.signer === 'phone') throw notAvailableYet('Paying from a spending balance', 'It belongs to Recovery Key mode.');
        // What the person saw (the keys it names) is what happens, even if the wallet would plan it differently now.
        const plan: WalletQuote['plan'] = quote.plan.signer === 'phone+guardian' ? { signer: 'phone+guardian' } : { signer: 'phone+hardware', reason: quote.plan.reason as never };
        const input: WalletQuote | { address: string; amountSats: number; speed: SendRequest['speed']; signer?: 'hardware' } = real
          ? { ...real, plan }
          : {
              address: quote.request.address,
              amountSats: quote.request.amountSats,
              speed: quote.request.speed,
              ...(plan.signer === 'phone+hardware' ? { signer: 'hardware' as const } : {}),
            };
        // The person decides when the hardware wallet steps in: no silent fallback after a refusal.
        const res = await w.send(input, { fallbackToHardware: false });
        if (!res.ok) {
          if (res.signedTx) throw refusalToError(res.refusal.kind === 'broadcast_rejected' ? res.refusal : { kind: 'broadcast_rejected', reason: res.refusal.message, message: res.refusal.message });
          throw refusalToError(res.refusal);
        }
        // The wallet's send log keeps where it went and who signed (Activity reads it from the wallet's history).
        const at = this.clock.now();
        const signedBy = res.signedBy;
        this.refresh();
        return {
          id: res.txid,
          kind: 'sent' as const,
          amountSats: res.amountSats,
          feeSats: res.feeSats,
          status: 'pending' as const,
          at: this.iso(at),
          address: quote.request.address,
          txid: res.txid,
          signedBy,
        };
      }),
    );
  }

  async receiveAddress(opts: { verifyOnDevice?: boolean } = {}): Promise<ReceiveAddress> {
    const run = () =>
      this.guarded(async () => {
        const r = await this.requireWallet().receiveAddress(opts);
        return { address: r.address, verifiedOnDevice: r.verifiedOnDevice };
      });
    return opts.verifyOnDevice ? this.exclusive(run) : run();
  }

  // ===========================================================================
  // Guardian

  async unlockGuardian(passphrase?: string): Promise<void> {
    return this.guarded(async () => {
      const w = this.requireWallet();
      if (!passphrase) throw new WalletServiceError('invalid_input', "Enter your guardian's passphrase.");
      const r = await w.unlockGuardian(passphrase);
      if (!r.ok) throw refusalToError(r.refusal);
      this.reachable = true;
      this.refresh();
    });
  }

  lockGuardian(): Promise<void> {
    return this.exclusive(() =>
      this.guarded(async () => {
        this.setProgress('Locking your guardian');
        try {
          await this.requireWallet().lockGuardian();
        } finally {
          this.setProgress(null);
        }
      }),
    );
  }

  private planView(p: ReplacePlan): ReplaceGuardianPlan {
    return {
      newGuardian: { ...(p.newGuardian.label ? { label: p.newGuardian.label } : {}), host: hostFromLabel(p.newGuardian.label), npub: p.newGuardian.guardianNpub },
      oldGuardianReachable: p.oldGuardianReachable,
      movingSats: p.balanceSats,
      coins: p.coins,
      feeSats: p.estimatedFeeSats,
      steps: p.steps,
    };
  }

  previewReplaceGuardian(pairingCode: string): Promise<ReplaceGuardianPlan> {
    return this.exclusive(() =>
      this.guarded(async () => {
        const w = this.requireWallet();
        const code = this.readCode(pairingCode);
        if (code.kind !== 'pairing') throw new WalletServiceError('pairing_invalid', code.kind === 'unknown' ? code.reason : "That isn't a guardian's pairing code.");
        this.setProgress('Reaching your new guardian');
        try {
          this.replacePlan = this.planView(await w.previewReplaceGuardian(code.uri));
        } finally {
          this.setProgress(null);
        }
        return this.replacePlan;
      }),
    );
  }

  replaceGuardian(opts: { oldGuardianGone?: boolean } = {}): Promise<ReplaceGuardianResult> {
    return this.exclusive(() =>
      this.guarded(async () => {
        const w = this.requireWallet();
        if (!this.replacePlan && !w.state.replacing) throw new WalletServiceError('wrong_state', "Scan the new guardian's pairing code first.");
        const host = hostFromLabel(w.state.replacing?.guardian.label ?? this.replacePlan?.newGuardian.label);
        try {
          const out = await w.replaceGuardian(opts.oldGuardianGone ? { oldGuardianReachable: false } : {});
          if (out.status === 'awaiting_broadcast') return { status: 'waiting' as const, movedSats: out.movedSats };
          this.replacePlan = null;
          this.reachable = true;
          addEvent(this.log, { kind: 'guardian-replaced', host, movedSats: out.movedSats, at: this.clock.now() });
          await this.saveLogNow();
          return { status: 'done' as const, movedSats: out.movedSats, oldWalletRetired: out.oldWalletRetired };
        } finally {
          this.replaceStep = null;
          this.setProgress(null);
        }
      }),
    );
  }

  cancelReplaceGuardian(): Promise<void> {
    return this.guarded(async () => {
      await this.w?.abandonReplaceGuardian();
      this.replacePlan = null;
      this.refresh();
    });
  }

  sweepOldWallets(): Promise<{ movedSats: Sats }> {
    return this.exclusive(() =>
      this.guarded(async () => {
        this.setProgress('Looking for coins in your old wallet');
        try {
          const res = await this.requireWallet().sweepStrayCoins();
          const movedSats = res.reduce((a, r) => a + r.sweptSats, 0);
          if (movedSats > 0) {
            addEvent(this.log, { kind: 'stray-coins-moved', movedSats, at: this.clock.now() });
            await this.saveLogNow();
          }
          return { movedSats };
        } finally {
          this.setProgress(null);
        }
      }),
    );
  }

  retireOldWallet(): Promise<void> {
    return this.exclusive(() =>
      this.guarded(async () => {
        this.setProgress('Retiring the old wallet: approve on your hardware wallet');
        try {
          await this.requireWallet().retireOldWallet();
        } finally {
          this.setProgress(null);
        }
      }),
    );
  }

  confirmHardware(): Promise<void> {
    return this.exclusive(() =>
      this.guarded(async () => {
        this.setProgress(`Confirming the wallet on your ${this.hardwareView().brand}`);
        try {
          await this.requireWallet().confirmHardware();
          this.addressCache = undefined;
          addEvent(this.log, { kind: 'hardware-confirmed', at: this.clock.now() });
          await this.saveLogNow();
        } finally {
          this.setProgress(null);
        }
      }),
    );
  }

  readCode(text: string): ScannedCode {
    return parseScannedCode(text, { network: this.network, now: Math.floor(this.clock.now() / 1000) });
  }

  // ===========================================================================
  // Silent payments (BIP 352)

  readonly silentPayments: SilentPaymentActions = {
    enable: () =>
      this.exclusive(() =>
        this.guarded(async () => {
          const w = this.requireWallet();
          this.setProgress('Turning on silent payments');
          try {
            await w.enableSilentPayments();
          } finally {
            this.setProgress(null);
          }
          this.refresh();
        }),
      ),
    disable: () =>
      this.guarded(async () => {
        await this.requireWallet().disableSilentPayments();
        this.refresh();
      }),
    address: (opts = {}) => this.guarded(() => this.requireWallet().silentPaymentAddress(opts)),
    addLabel: () =>
      this.guarded(async () => {
        const r = await this.requireWallet().addSilentPaymentLabel();
        this.refresh();
        return r;
      }),
    helperAddress: () =>
      this.guarded(async () => {
        const w = this.requireWallet();
        const { address } = await w.helperReceiveAddress();
        this.refresh();
        return address;
      }),
    check: () =>
      this.guarded(async () => {
        const w = this.requireWallet();
        const { found } = await w.scanSilentPayments();
        this.refresh();
        return { found: found.length };
      }),
    move: () =>
      this.exclusive(() =>
        this.guarded(async () => {
          const w = this.requireWallet();
          this.setProgress('Moving silent payments into your vault');
          try {
            const out = await w.sweepSilentPayments();
            const swept = out.flatMap((o) => (o.status === 'swept' ? [o] : []));
            const failed = out.filter((o) => o.status === 'failed');
            this.refresh();
            const message = failed.length ? (failed[0] as { message: string }).message : undefined;
            return {
              moved: swept.length,
              movedSats: swept.reduce((a, o) => a + o.amountSats, 0),
              feeSats: swept.reduce((a, o) => a + o.feeSats, 0),
              waiting: out.filter((o) => o.status === 'waiting').length,
              failed: failed.length,
              ...(message ? { message } : {}),
            };
          } finally {
            this.setProgress(null);
          }
        }),
      ),
  };

  // ===========================================================================
  // Rules

  private async rulesChange<T extends { approvedBy: 'phone' | 'hardware' | 'unchanged' }>(job: () => Promise<T>, onChanged: (r: T, now: number) => void): Promise<void> {
    await this.exclusive(() =>
      this.guarded(async () => {
        this.requireWallet();
        const r = await job();
        // The wallet's idea of the daily limit comes from the guardian's last status: refresh it.
        await this.requireWallet().refreshStatus().catch(() => undefined);
        if (r.approvedBy !== 'unchanged') {
          onChanged(r, this.clock.now());
          await this.saveLogNow();
        }
      }),
    );
  }

  setDailyLimit(limitSats: Sats): Promise<void> {
    const before = this.w?.state.rules?.policy.dailyLimitSats ?? 0;
    return this.rulesChange(
      () => this.requireWallet().setDailyLimit(limitSats),
      (r, at) =>
        addEvent(this.log, { kind: 'limit-changed', limitSats, direction: limitSats > before ? 'raised' : 'lowered', approvedOn: r.approvedBy === 'hardware' ? 'hardware' : 'phone', at }),
    );
  }

  setRecoveryDelay(days: RecoveryDelayDays): Promise<void> {
    return this.rulesChange(
      () => this.requireWallet().setRecoveryDelay(days),
      (r, at) => addEvent(this.log, { kind: 'delay-changed', days, approvedOn: r.approvedBy === 'hardware' ? 'hardware' : 'phone', at }),
    );
  }

  async addContact(name: string, npub: string): Promise<Contact> {
    const trimmed = name.trim();
    await this.rulesChange(
      () => this.requireWallet().addAlertContact(npub.trim(), trimmed || undefined),
      (_r, at) => addEvent(this.log, { kind: 'contact-added', name: trimmed || 'A contact', at }),
    );
    const added = this.getState().contacts.find((c) => c.npub === npub.trim()) ?? this.getState().contacts.at(-1);
    return added ?? { id: npub.trim(), name: trimmed, npub: npub.trim() };
  }

  async removeContact(id: string): Promise<void> {
    const name = this.getState().contacts.find((c) => c.id === id)?.name ?? 'A contact';
    await this.rulesChange(
      () => this.requireWallet().removeAlertContact(id),
      (_r, at) => addEvent(this.log, { kind: 'contact-removed', name, at }),
    );
  }

  // ===========================================================================
  // Recovery

  private async locate(
    provider?: CloudProvider,
  ): Promise<{ store: CloudBackupStore; found: NonNullable<Awaited<ReturnType<typeof TrikeyWallet.findBackup>>> } | undefined> {
    const stores = provider ? [this.storeFor(provider)] : this.deps.platform.cloudBackups;
    type Hit = { store: CloudBackupStore; found: NonNullable<Awaited<ReturnType<typeof TrikeyWallet.findBackup>>> };
    let best: Hit | undefined;
    // The newest backup for this phone's network wins; one for another network only if there is none.
    const sameNet = (h: Hit) => (h.found.network === this.network ? 1 : 0);
    const better = (a: Hit, b: Hit | undefined) => !b || sameNet(a) > sameNet(b) || (sameNet(a) === sameNet(b) && a.found.createdAt > b.found.createdAt);
    for (const store of stores) {
      if (!(await store.isAvailable().catch(() => false))) continue;
      const found = await TrikeyWallet.findBackup(this.walletDeps(), { cloud: store, anyNetwork: true }).catch(() => undefined);
      if (found && better({ store, found }, best)) best = { store, found };
    }
    return best;
  }

  private foundView(store: CloudBackupStore, f: { createdAt: number; slots: ('passkey-prf' | 'recovery-code')[]; network?: NetworkName }): FoundBackup {
    return {
      provider: store.provider === 'icloud' || store.provider === 'google-drive' ? store.provider : 'file',
      createdAt: this.iso(f.createdAt * 1000),
      unlockedBy: f.slots.map((s) => (s === 'passkey-prf' ? 'passkey' : 'recovery-code')),
      ...(f.network ? { network: f.network } : {}),
    };
  }

  async findBackup(provider?: CloudProvider): Promise<FoundBackup | null> {
    return this.guarded(async () => {
      const hit = await this.locate(provider);
      return hit ? this.foundView(hit.store, hit.found) : null;
    });
  }

  async importBackupFile(): Promise<FoundBackup | null> {
    return this.guarded(async () => {
      if (!this.deps.pickBackupFile) throw notAvailableYet('Opening a backup file');
      const picked = await this.deps.pickBackupFile();
      if (!picked) return null;
      const { header } = parseBackup(picked.bytes);
      const file = this.storeOf('file');
      if (!file) throw notAvailableYet('Opening a backup file');
      const name = `${BACKUP_FILE_PREFIX}${header.id}${BACKUP_FILE_SUFFIX}`;
      await file.write(name, picked.bytes);
      return this.foundView(file, { createdAt: header.createdAt, slots: header.slots.map((s) => s.type), network: header.network });
    });
  }

  /** Points the phone at another network before anything exists on it (a backup for that network). */
  private async switchNetworkTo(network: NetworkName): Promise<void> {
    if (this.mode === 'simulator' && network !== 'regtest') throw new WalletServiceError('network_mismatch', 'The simulator works on regtest only.', { network });
    if (!SELECTABLE_NETWORKS.includes(network)) throw new WalletServiceError('network_mismatch', "That backup is for mainnet, which isn't available yet.", { network });
    this.network = network;
    await this.deps.platform.kv.set(networkPrefKey(this.mode), network).catch(() => {});
    await this.buildHardware();
    await this.loadLogFor();
  }

  restoreFromBackup(unlock?: RestoreUnlock, provider?: CloudProvider, opts: { switchNetwork?: boolean } = {}): Promise<void> {
    return this.exclusive(() =>
      this.guarded(async () => {
        if (!unlock) throw new WalletServiceError('invalid_input', 'Choose how to unlock the backup.');
        if (this.w) throw new WalletServiceError('wallet_exists', 'This phone already has a Trikey wallet.');
        const hit = await this.locate(provider);
        if (!hit) throw new WalletServiceError('backup_not_found', `No Trikey backup for ${this.network} was found.`);
        // The backup says which network it is for. Another one than the phone's only when the person said so.
        if (opts.switchNetwork && hit.found.network !== this.network) await this.switchNetworkTo(hit.found.network);
        this.setProgress('Unlocking your backup');
        try {
          await this.yieldToUi();
          const w = await TrikeyWallet.restoreFromBackup(this.walletDeps(), unlock, { name: hit.found.name, cloud: hit.store });
          this.log = emptyLog();
          this.attach(w);
        } finally {
          this.setProgress(null);
        }
        this.starting = this.startInBackground();
      }),
    );
  }

  async recoverWithKit(): Promise<{ movedSats: Sats }> {
    throw notAvailableYet('Recovering with a Recovery Kit', 'It belongs to Recovery Key mode, which comes later.');
  }

  private toInProgress(): RecoveryInProgress {
    const r = this.getState().recovery;
    if (!r) throw new WalletServiceError('internal', 'The recovery started but its details are not available yet.');
    return r;
  }

  startRecovery(lostKey: LostKey, opts: { guardian?: GuardianAddress; hardwareKind?: HardwareKind } = {}): Promise<RecoveryInProgress> {
    return this.exclusive(() =>
      this.guarded(async () => {
        if (lostKey === 'hardware') {
          const w = this.requireWallet();
          this.setProgress('Starting the recovery: approve with your new hardware wallet');
          try {
            await w.startRecovery({ lostKey: 'hardware', ...(opts.hardwareKind ? { newHardwareKind: toWalletKind(opts.hardwareKind) } : {}) });
          } finally {
            this.setProgress(null);
          }
          return this.toInProgress();
        }
        if (!opts.guardian) throw new WalletServiceError('invalid_input', "Add your guardian's npub and relays first.");
        const w = await this.ensureWallet();
        this.setProgress('Starting the recovery: approve on your hardware wallet');
        try {
          await w.recoverWithHardware({ guardian: opts.guardian, ...(opts.hardwareKind ? { hardwareKind: toWalletKind(opts.hardwareKind) } : {}) });
        } finally {
          this.setProgress(null);
        }
        this.starting = this.startInBackground();
        return this.toInProgress();
      }),
    );
  }

  acknowledgeRecovery(): void {
    const id = this.getState().recovery?.id;
    if (!id || this.log.acknowledged.includes(id)) return;
    this.log.acknowledged = [...this.log.acknowledged, id].slice(-50);
    void this.saveLogNow();
  }

  cancelRecovery(): Promise<void> {
    return this.exclusive(() =>
      this.guarded(async () => {
        const w = this.requireWallet();
        try {
          await w.cancelRecovery({});
        } catch (e) {
          const kind = e instanceof WalletError ? e.refusal?.kind : undefined;
          // A phone the guardian does not know as its own (a recovering phone) needs the hardware wallet to cancel.
          if (kind !== 'approval_required' && kind !== 'unauthorized') throw e;
          await w.cancelRecovery({ withHardware: true });
        }
      }),
    );
  }

  resumePhoneSpending(): Promise<void> {
    return this.exclusive(() => this.guarded(() => this.requireWallet().resumePhoneSpending()));
  }

  renewRecoveryAccess(): Promise<void> {
    return this.exclusive(() => this.guarded(async () => void (await this.requireWallet().renewRecoveryAccess())));
  }

  // ===========================================================================
  // Recovery Key mode lives in ./rk-service.ts

  setRecoveryKeyKind(kind: RecoveryKeyKind): void {
    this.keyKind = kind;
    this.refresh();
  }

  // ===========================================================================
  // Preferences

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
    this.abort?.abort();
    this.prompts.cancel();
  }

  private async forgetWallet(): Promise<void> {
    const w = this.w;
    if (w) await w.forget();
    this.unsubWallet?.();
    this.w = undefined;
    this.preview = undefined;
    this.log = emptyLog();
    await saveLog(this.deps.platform.kv, this.logKey, this.log);
    this.refresh();
  }
}

/** Opens the real wallet service: reads the phone's storage and opens the wallet there, if there is one. */
export async function createRealWalletService(deps: RealServiceDeps): Promise<RealWalletService> {
  const svc = new Service(deps);
  await svc.init();
  return svc;
}
