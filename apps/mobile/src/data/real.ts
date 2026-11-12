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
import { decode as nip19Decode, npubEncode } from 'nostr-tools/nip19';
import { OtherWalletSyncs } from './other-wallets-sync';
import {
  BACKUP_FILE_PREFIX,
  BACKUP_FILE_SUFFIX,
  KEY3_MIXED_NOTE,
  TrikeyWallet,
  WalletError,
  WalletSet,
  leaveBlockerText,
  walletKeys,
  parseBackup,
  isNfcModel,
  nfcModelInfo,
  qrModelInfo,
  type Argon2Params,
  type QrModel,
  type CloudBackupStore,
  type GuardianRefusal,
  type HardwareKind as WalletHardwareKind,
  type HardwareProvider,
  type KeyValueStore,
  type PasskeyPrf,
  type RecoveryRecord,
  type SavingsQuote as WalletSavingsQuote,
  type SavingsSnapshot,
  type SavingsSpeedUpQuote as WalletSpeedUpQuote,
  type SecureKeyStore,
  type ReplacePlan,
  type ReplaceStep,
  type SendQuote as WalletQuote,
  type WalletDeps,
  type WalletEvent,
  type WalletSnapshot,
} from '@trikey/wallet';
import { parseScannedCode } from '@trikey/wallet/scan';
import { GUARDIAN_FEATURES, SimplePoolRelayPool, contactId, isSafeName, encodeRecoveryUri, type Policy, type RelayPool } from '@trikey/protocol';
import { hostedChainFactory, publicServer } from './hosted';
import { parseServerUrl } from './rk-server';
import { addEvent, buildActivity, emptyLog, hostFromLabel, loadLog, saveLog, takeLegacySends, type AppLog } from './app-log';
import { groupAlertChannels } from './alert-channels';
import { deviceAmountUnit, formatSats, inDeviceUnit } from './format';
import { deviceContactId, isLimitOffSats } from './rules';
import { DevicePromptStore, compositeProvider, ledgerHint, withDevicePrompts } from './device';
import { WalletServiceError, notAvailableYet } from './errors';
import { SIMULATED_OPTION, hardwareBrandOf, hardwareOptionTable, type UiOs } from './hardware-options';
import { mapError, refusalToError } from './real-errors';
import { emptyRecoveryKeyState } from './rk-empty';
import type { ReceiveAddress, WalletService } from './service';
import type { SilentPaymentActions } from './sp-actions';
import { emptySilentPayments } from './sp-empty';
import type { SavingsActions } from './savings-actions';
import { emptySavings } from './savings-empty';
import { createSpeedUpActions } from './real-speed-up';
import { createCoinActions } from './real-coins';
import { createNotesActions } from './real-notes';
import type { NotesActions } from './notes-actions';
import { createHardwareUnlockActions } from './real-hardware-unlock';
import type { HardwareUnlockActions } from './hardware-unlock-actions';
import type { CoinActions } from './coin-actions';
import type { SpeedUpActions } from './speed-up-actions';
import { renderSavingsMap, savingsMapData } from './savings-map';
import { recoverySheetWallet, renderRecoverySheet } from './recovery-sheet';
import {
  GUARDIAN_NETWORKS,
  type AppToast,
  type WalletDetails,
  type InviteView,
  type AmountUnit,
  type BackupOptions,
  type CloudProvider,
  type Contact,
  type FeeSpeed,
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
  type RecoverySweepUpdate,
  type ReplaceGuardianPlan,
  type RecoverySheet,
  type RecoverySheetLayout,
  type ReplaceGuardianResult,
  type RestoreUnlock,
  type Sats,
  type ScannedCode,
  type SendQuote,
  type SendRequest,
  type SavingsActivityItem,
  type SavingsDevice,
  type SavingsQuote,
  type SavingsSpeedUpQuote,
  type SavingsState,
  type SilentPaymentsState,
  type ThemePreference,
  type Transaction,
  type WalletMode,
  type WalletState,
  type HostedWalletView,
  type LeaveHostCheck,
  type AddWalletInput,
  type ReplaceGuardianState,
  type WalletMoveResult,
  type WalletListItem,
  type WalletsView,
} from './types';
import { PREFS_KEY, defaultPrefs, parsePrefs, type AppPrefs } from './prefs';

/** What the real wallet needs from the phone. `createPlatform()` fits; tests pass the in-memory stand-ins. */

/** An npub (or 64-character hex key) as lowercase hex; throws for anything else. */
function npubToHex(npubOrHex: string): string {
  const v = npubOrHex.trim();
  if (/^[0-9a-fA-F]{64}$/.test(v)) return v.toLowerCase();
  const d = nip19Decode(v);
  if (d.type !== 'npub') throw new Error('not an npub');
  return d.data;
}

/** A nostr key shortened for the screens (`npub1abcdefg…wxyz`). */
function shortNpub(pubkey: string): string {
  const n = npubEncode(pubkey);
  return `${n.slice(0, 9)}…${n.slice(-4)}`;
}

/** An alert contact as the screens name it: the name this phone keeps for it, else its shortened npub. */
function contactName(c: { npub: string; name?: string }): string {
  return c.name ?? `${c.npub.slice(0, 9)}…${c.npub.slice(-4)}`;
}
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
  /** How long a sync waits for the guardian's chain data (`wallet.sync`; ms, default the wallet's: 3 x `rpcTimeoutMs`, 90 s). */
  syncTimeoutMs?: number;
  rpcRetryIntervalMs?: number;
  /** Sync this often while the service lives (ms; default 60 s, 0 = only when asked). */
  syncIntervalMs?: number;
  /**
   * Several wallets: how often a wallet that is not shown syncs in the background (ms; default `OTHER_WALLET_SYNC_MS`,
   * 10 minutes; 0 = never), the least gap after any sync before one starts (default `OTHER_WALLET_GAP_MS`), and how
   * often the service looks whether one is due (default 15 s).
   */
  otherWalletSyncMs?: number;
  otherWalletGapMs?: number;
  otherWalletCheckMs?: number;
  /** `sync()` joins a sync that began less than this long ago (ms, the app's clock; default `SYNC_JOIN_MS`; 0 = never). */
  syncJoinMs?: number;
  /** How often screens re-read the clock (ms, default 30 s). */
  clockTickMs?: number;
  /** Hands a backup file to the OS share sheet. */
  shareBackupFile?: (name: string, bytes: Uint8Array) => Promise<void>;
  /** Lets the person choose a backup file. Null: they cancelled. */
  pickBackupFile?: () => Promise<{ name: string; bytes: Uint8Array } | null>;
  /** Coin control: hands a BIP 329 labels file (text) to the OS share sheet. */
  shareLabelsFile?: (name: string, text: string) => Promise<void>;
  /** Coin control: lets the person choose a BIP 329 labels file. Null: they cancelled. */
  pickLabelsFile?: () => Promise<{ name: string; bytes: Uint8Array } | null>;
  /** Gives the UI thread a turn before heavy work (default: a short timer). */
  yieldToUi?: () => Promise<void>;
  /** Facts for Settings > Developer. */
  info?: () => string[];
  /** More Settings > Developer tools (the simulator's device swap). */
  devTools?: Pick<NonNullable<WalletService['dev']>, 'useNewSimulatedDevice'>;
  /**
   * The simulator's second device (what "a second hardware wallet" connects to), as Recovery Key mode's: Savings asks for
   * its Recovery Key with this kind when the person picks the simulated device.
   */
  secondDeviceKind?: WalletHardwareKind;
  /**
   * Chain data for a wallet hosted on someone else's guardian (docs/design/family-hosting.md): the guest's own Esplora,
   * else a public one, and a second public server for the check before a recovery sweep. Default: `hostedChainFactory()`
   * (Recovery Key mode's Esplora client over `fetch`). Tests pass the rig's chain.
   */
  hostedChain?: WalletDeps['hostedChain'];
}

export interface RealWalletService extends WalletService {
  /** The wallet, once there is one. */
  readonly wallet: TrikeyWallet | undefined;
  readonly prompts: DevicePromptStore;
  /** The app left the front (AppState `inactive` or `background`). See `resume`. */
  pause(state?: 'inactive' | 'background'): void;
  resume(): Promise<void>;
  /** Resolves once no sync is running or due, its background part (`updating`) included. */
  idle(): Promise<void>;
  /** Several wallets: resolves once no wallet that is not shown is syncing in the background (tests). */
  othersIdle(): Promise<void>;
  close(): Promise<void>;
}

const DEFAULT_SWEEP_FEE_CAP_SATS = 20_000;
/**
 * Away from the front this long (even only `inactive`), the relay connections are opened anew on `resume`, as after any
 * time in the background: a socket may be gone without either end saying so. (ms)
 */
const FORCE_RECONNECT_AFTER_MS = 20_000;
/** After a forced reconnect, `resume` waits at most this long for the first relay to be back before it syncs. (ms) */
const RELAYS_BACK_WAIT_MS = 3_000;
/** An `inactive` pause shorter than this (a Face ID prompt, Control Center) does not excuse a call that failed across it. (ms) */
const SHORT_PAUSE_MS = 2_000;
/** A helper coin below this cannot pay its share of the fee of a payment at ordinary rates: shown as not funded. */
const HELPER_USABLE_SATS = 1_000;
/**
 * A pull to refresh (or the timer) joins a sync that began less than this long ago instead of asking the guardian again:
 * its answer is as fresh as a new one would be. (ms)
 */
export const SYNC_JOIN_MS = 10_000;
/** How long the "Incoming …" note stays. */
export const TOAST_MS = 6_000;
/** An incoming payment's note shows only for an alert this recent (relays replay alerts for days). */
const TOAST_FRESH_MS = 10 * 60_000;

/** The note for an incoming payment: "Incoming 2,000 sats · unconfirmed". */
export function toastText(a: { amountSats: number; confirmations: number; wallet: 'main' | 'savings' }): string {
  return `Incoming ${formatSats(a.amountSats)} sats${a.wallet === 'savings' ? ' to Savings' : ''} · ${a.confirmations > 0 ? 'confirmed' : 'unconfirmed'}`;
}
const networkPrefKey = (mode: string) => `trikey.app.network.${mode}`;
const walletKey = (mode: string, network: NetworkName) => `trikey.wallet.${mode}.${network}`;

/**
 * A signed payment that was not broadcast: refused by the network (nothing was sent), or no answer from the guardian,
 * which may have sent it anyway. `listed`: the wallet lists such a payment in Activity until a sync shows it or not.
 */
function broadcastError(refusal: GuardianRefusal, how: 'listed' | 'unlisted'): WalletServiceError {
  if (refusal.kind === 'unreachable')
    return new WalletServiceError(
      'broadcast_failed',
      how === 'listed'
        ? "Your guardian didn't confirm that the payment went out, but it may have. It shows in Activity as pending until your guardian's next check says whether it did. Don't pay again before then."
        : "Your guardian didn't confirm that the payment went out, but it may have. Check Activity after the next sync before you try again.",
      { cause: refusal },
    );
  return refusalToError(refusal.kind === 'broadcast_rejected' ? refusal : { kind: 'broadcast_rejected', reason: refusal.message, message: refusal.message });
}

const PLACEHOLDER_HARDWARE: HardwareWallet = { kind: 'ledger', brand: 'hardware wallet', model: 'Hardware wallet' };

/** A hardware wallet's brand and model for display, from the wallet's record of it. */
function deviceNames(kind: WalletHardwareKind, model: string | undefined): { brand: string; model: string } {
  const m = model ?? '';
  switch (kind) {
    case 'ledger':
      return { brand: 'Ledger', model: m ? `Ledger ${m}` : 'Ledger' };
    case 'trezor':
      return { brand: 'Trezor', model: m ? `Trezor ${m}` : 'Trezor' };
    case 'bitbox02':
      return { brand: 'BitBox02', model: m || 'BitBox02' };
    case 'coldcard':
    case 'coldcard-nfc':
      return { brand: 'Coldcard', model: m || 'Coldcard' };
    case 'jade':
    case 'jade-ble':
      return { brand: 'Jade', model: m || 'Jade' };
    default:
      return { brand: 'signing device', model: m || 'Signing device' };
  }
}

const toWalletKind = (kind: HardwareKind): WalletHardwareKind | undefined => (kind === 'simulated' ? undefined : kind);

/** Kinds whose model the owner picks: a QR device, and a Coldcard over NFC (Mk4 or Q). */
const hasModel = (kind: string | undefined): boolean => kind === 'qr' || kind === 'coldcard-nfc';

/** A provider's own reason for being unavailable (the NFC provider has one: no NFC, or an iPhone build without it). */
async function unavailableDetailOf(provider: HardwareProvider): Promise<string | undefined> {
  const p = provider as HardwareProvider & { unavailableReason?: () => Promise<string | undefined> };
  return typeof p.unavailableReason === 'function' ? await p.unavailableReason().catch(() => undefined) : undefined;
}

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
    case 'nothing_to_send':
      return { problem: 'insufficient_funds', message };
    case 'send_max_too_small':
      return { problem: 'amount_too_small', message };
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

const newCoins = (n: number) => `${n} new coin${n === 1 ? '' : 's'}`;

/**
 * Coins that arrived in the old wallet while a recovery waits, as the waiting screen's line: being added, added, or
 * refused (and why). The wallet adds them by itself (`recovery.update`); a recovery cannot finish with a coin left out.
 */
function sweepUpdateView(u: RecoveryRecord['sweepUpdate']): RecoverySweepUpdate | undefined {
  if (!u) return undefined;
  const n = u.pendingCoins;
  if (n > 0 && u.refused) {
    const why =
      u.refused.code === 'key_unavailable'
        ? "Your phone key couldn't be unlocked to approve it. Refresh to try again."
        : u.refused.code.startsWith('hardware_')
          ? "Your hardware wallet didn't approve it. Connect it and refresh to try again."
          : u.refused.message;
    return { status: 'refused', coins: n, text: `${newCoins(n)} arrived but could not be added to your recovery. ${why} Your recovery can't finish until ${n === 1 ? 'it is' : 'they are'} added.` };
  }
  if (n > 0) return { status: 'waiting', coins: n, text: `${newCoins(n)} arrived. Adding ${n === 1 ? 'it' : 'them'} to your recovery…` };
  if (u.lastAdded) return { status: 'added', coins: u.lastAdded.coins, text: `${newCoins(u.lastAdded.coins)} ${u.lastAdded.coins === 1 ? 'was' : 'were'} added to your recovery` };
  return undefined;
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
  /**
   * The phone's wallets on its guardian (docs/design/multi-wallet.md): the first wallet (at `storageKey`) and the ones
   * added. `w` is the one shown. Undefined until the first wallet is paired.
   */
  private set?: WalletSet;
  private unsubWallet?: () => void;
  private network: NetworkName;
  private state!: WalletState;
  private readonly listeners = new Set<() => void>();
  private hw?: HardwareProvider;
  private rawProviders: HardwareProvider[] = [];
  private log: AppLog = emptyLog();
  private prefs: AppPrefs = defaultPrefs();
  private progress: string | null = null;
  /**
   * A sync comes in two parts (see `sync`). The first, `core`: the guardian's status and the wallet's chain data, what
   * the balance and Activity show; a pull to refresh waits for it. The core under way and when it began; and the next
   * one, due as soon as it ends.
   */
  private core?: { done: Promise<void>; startedAt: number };
  private nextCore?: Promise<void>;
  /** The rest of a sync, in the background ("Updating…"): the one running, and the newest one waiting for it. */
  private restRun?: Promise<void>;
  private restNext?: { rest: () => Promise<unknown>; startedAt: number };
  /** False once a guardian call failed for want of an answer ("offline"). Any later answer sets it again. */
  private reachable = true;
  /** When `reachable` went false (the app's clock): a guardian status read after this clears it (see `refresh`). */
  private unreachableAt = 0;
  /**
   * Back at the front after the guardian was "offline": shown as reconnecting, not offline, until a call that began
   * after the return has an outcome.
   */
  private reconnecting = false;
  /** Since when the app is away from the front (`pause`), or undefined while it is at the front. */
  private pausedAt?: number;
  /** The last time away from the front (`pause` to `resume`). */
  private lastPause?: { start: number; end: number; background: boolean };
  /** The app went to the background (not only `inactive`) since it was last at the front. */
  private backgrounded = false;
  /** A payment is signed and being broadcast (`sendPayment`, between `payment_signed` and its end). */
  private paymentSending = false;
  /** The in-app note showing now (`WalletState.toast`), and the timer that hides it. */
  private toast: AppToast | null = null;
  private toastTimer?: ReturnType<typeof setTimeout>;
  private toastCount = 0;
  /**
   * The guardian answered the last sync's `guardian.status` but not its chain data in time (`guardian_slow`): it is
   * online, the balance is the last one. Cleared by a full sync, or by the guardian not answering at all.
   */
  private slow = false;
  private preview?: { guardianNpub: string; label?: string; relays: string[]; expiresAt: number };
  private recoveryCodeValue: string | null = null;
  private readonly quotes = new Map<string, WalletQuote>();
  private quoteCounter = 0;
  private chain: Promise<unknown> = Promise.resolve();
  private abort?: AbortController;
  /** The periodic sync's next turn (`armTimer`); set once the first sync is done. */
  private timer?: ReturnType<typeof setTimeout>;
  private timerOn = false;
  /** Several wallets: the background syncs of the wallets not shown (other-wallets-sync.ts), and their turn's timer. */
  private readonly others: OtherWalletSyncs;
  private othersTimer?: ReturnType<typeof setTimeout>;
  /** Wallets an operation is using (move the money, remove, replace guardian): no background sync touches them meanwhile. */
  private readonly held = new Set<number>();
  /** When the last sync of the wallet shown ended, background part included (ms). */
  private lastSyncEndedAt?: number;
  private closed = false;
  private starting?: Promise<void>;
  private addressCache?: { key: string; address: string };
  private keyKind: RecoveryKeyKind = 'paper';
  private readonly clock: { now(): number };
  private replacePlan: ReplaceGuardianPlan | null = null;
  private replaceStep: ReplaceStep | null = null;
  /** Several wallets: the wallet moving to the new guardian now. */
  private replaceMoving: ReplaceGuardianState['moving'] = null;
  /** The person accepted the mainnet warning (see `acceptMainnetRisk`). Cleared when the network changes. */
  private mainnetRiskAccepted = false;
  /** The hardware providers for the network `setNetwork` picked last are ready (Ledger's app, Trezor's coin follow it). */
  private networkReady: Promise<void> = Promise.resolve();
  /** "Create Savings" in progress, as the screens show it. */
  private savingsCreating: SavingsState['creating'] = null;
  private readonly savingsQuotes = new Map<string, WalletSavingsQuote>();
  /** Coin control: bumped on every label or freeze change (`WalletState.labelsVersion`). */
  private labelsVersion = 0;
  private readonly speedUpQuotes = new Map<string, WalletSpeedUpQuote>();

  constructor(private readonly deps: RealServiceDeps) {
    this.clock = deps.clock ?? { now: () => Date.now() };
    this.clockTickMs = deps.clockTickMs ?? 30_000;
    this.network = deps.network ?? 'testnet';
    this.others = new OtherWalletSyncs({
      now: () => this.clock.now(),
      run: (account) => this.syncOther(account),
      accounts: () => this.otherAccounts(),
      mainIdle: () => this.mainIdle(),
      mainEndedAt: () => this.lastSyncEndedAt,
      ...(deps.otherWalletSyncMs !== undefined ? { everyMs: deps.otherWalletSyncMs } : {}),
      ...(deps.otherWalletGapMs !== undefined ? { gapMs: deps.otherWalletGapMs } : {}),
    });
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

  /** The app's own log of the wallet shown: the first wallet's where it always was, an added wallet's next to its state. */
  private get logKey() {
    const own = this.w?.ownWallet;
    return `${own ? walletKeys(this.storageKey).ownWallet(own.account) : this.storageKey}.app`;
  }

  async init(): Promise<void> {
    const kv = this.deps.platform.kv;
    this.prefs = parsePrefs(await kv.get(PREFS_KEY).catch(() => null));

    // The network: the wallet that exists on this phone (in this mode) wins, then the choice made last time.
    const candidates: NetworkName[] = this.mode === 'simulator' ? ['regtest'] : GUARDIAN_NETWORKS;
    let found: NetworkName | undefined;
    for (const n of candidates) {
      if ((await kv.get(walletKey(this.mode, n)).catch(() => null)) !== null) {
        found = n;
        break;
      }
    }
    if (this.mode === 'simulator') this.network = 'regtest';
    else {
      // Without a wallet, never mainnet by itself: the person picks it again, and accepts its warning again.
      const startable = (n: NetworkName | null | undefined): n is NetworkName => !!n && n !== 'bitcoin' && GUARDIAN_NETWORKS.includes(n);
      const saved = (await kv.get(networkPrefKey(this.mode)).catch(() => null)) as NetworkName | null;
      this.network = found ?? (startable(saved) ? saved : startable(this.deps.network) ? this.deps.network : 'testnet');
    }

    await this.buildHardware();
    this.log = await loadLog(kv, this.logKey);
    this.state = this.project();

    if (found) {
      // Every wallet of the phone; the one shown last is shown again.
      const set = await WalletSet.open(this.walletDeps());
      if (set) {
        this.set = set;
        this.attach(set.shown);
        if (set.shown !== set.first) this.log = await loadLog(kv, this.logKey);
      }
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
      // QR and NFC devices: their own sheets say what to do on the device.
      silentKinds: this.deps.silentKinds ?? ['qr', 'coldcard', 'jade', 'coldcard-nfc'],
      // A rule approval names the contacts as the device shows them: this phone's names next to them.
      contactName: (id) => {
        // At pairing the names are still the onboarding list's; afterwards the wallet keeps them.
        const named = this.onboardingContacts.find((c) => deviceContactId(c.npub) === id);
        if (named) return named.name;
        const names = this.w?.state.contactNames ?? {};
        for (const [hexKey, name] of Object.entries(names)) {
          try {
            if (contactId(hexKey) === id) return name;
          } catch {
            // not a key
          }
        }
        return undefined;
      },
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
      ...(this.deps.syncTimeoutMs !== undefined ? { syncTimeoutMs: this.deps.syncTimeoutMs } : {}),
      rpcRetryIntervalMs: this.deps.rpcRetryIntervalMs,
      hostedChain: this.deps.hostedChain ?? hostedChainFactory(),
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
    const startedAt = this.clock.now();
    try {
      await w.start();
      this.answered();
    } catch (e) {
      this.noteGuardianResult(e, startedAt);
    }
    await this.ensureSet().catch(() => undefined);
    this.timerOn = true;
    await this.sync();
    if (this.isIdle()) this.armTimer();
    this.armOthersTimer();
  }

  pause(state: 'inactive' | 'background' = 'background'): void {
    this.pausedAt ??= this.clock.now();
    if (state === 'background') this.backgrounded = true;
  }

  /**
   * The app came back to the front. After the app was in the background (however briefly: iOS cancels every socket of
   * a suspended app, Android destroys them), or away more than `FORCE_RECONNECT_AFTER_MS`, every relay connection is
   * opened anew, and the sync waits for the first relay to be back (its EOSE, at most `RELAYS_BACK_WAIT_MS`), so it is
   * not sent into sockets that are gone. Unanswered requests are sent again once the relays are back. After a short
   * `inactive` (a Face ID prompt, Control Center) only the connections that dropped are opened again.
   *
   * A guardian that was "offline" shows as reconnecting meanwhile; what the screen said before the phone slept, or a
   * call under way (or made) while it was away, is no news about the guardian now. Only a call begun after the return
   * says "offline" again.
   */
  async resume(): Promise<void> {
    if (this.closed) return;
    const now = this.clock.now();
    const away = this.pausedAt !== undefined ? now - this.pausedAt : 0;
    const background = this.backgrounded;
    if (this.pausedAt !== undefined) this.lastPause = { start: this.pausedAt, end: now, background };
    this.pausedAt = undefined;
    this.backgrounded = false;
    if (!this.reachable && this.w && this.w.stage !== 'new') {
      this.reconnecting = true;
      this.refresh();
    }
    const force = background || away >= FORCE_RECONNECT_AFTER_MS;
    await this.w?.reconnect({ force, waitMs: force ? RELAYS_BACK_WAIT_MS : 0 }).catch(() => undefined);
    if (this.closed) return;
    // Encrypted notes: labels changed before the app left (and not sent yet) go out now, every wallet's.
    for (const w of this.set?.list ?? (this.w ? [this.w] : [])) void w.flushNotes();
    return this.requestSync(true);
  }

  /**
   * A guardian call begun at `startedAt` that failed now spanned a time away from the front: the app was suspended
   * (iOS) or its timers and sockets were (Android), or it was sent before the connections were back, so its failure says
   * nothing about the guardian. A time away still going on counts whatever its length (on an iPhone the late timeout
   * comes before the app hears it is back); one that ended if it was in the background or long enough to matter.
   */
  private spannedPause(startedAt: number): boolean {
    if (this.pausedAt !== undefined) return true;
    const p = this.lastPause;
    return !!p && startedAt < p.end && (p.background || p.end - p.start >= SHORT_PAUSE_MS);
  }

  async close(): Promise<void> {
    this.closed = true;
    clearTimeout(this.toastTimer);
    clearTimeout(this.timer);
    this.timer = undefined;
    clearTimeout(this.othersTimer);
    this.othersTimer = undefined;
    await this.starting?.catch(() => {}); // a connection opened after close() would never be closed
    await this.others.idle().catch(() => {});
    this.unsubWallet?.();
    this.prompts.clearAll();
    // Every wallet of the phone (a restore connects them all); the one shown among them.
    await this.w?.close().catch(() => {});
    await this.set?.close().catch(() => {});
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
    // Any answer from the guardian since it was marked offline (a status read by the wallet on its own, after a relay
    // came back; a refusal it learned from) means it is reachable again.
    const checkedAt = this.w?.state.guardianStatus?.checkedAt;
    if (!this.reachable && checkedAt !== undefined && checkedAt > this.unreachableAt) this.answered(false);
    this.state = this.project();
    for (const l of this.listeners) l();
  }

  /** Shows `text` over every screen for `TOAST_MS` (`WalletState.toast`). */
  private showToast(text: string): void {
    clearTimeout(this.toastTimer);
    this.toast = { id: `toast-${++this.toastCount}`, kind: 'incoming', text };
    this.toastTimer = setTimeout(() => this.dismissToast(), TOAST_MS);
    (this.toastTimer as { unref?: () => void }).unref?.();
    this.refresh();
  }

  dismissToast(): void {
    clearTimeout(this.toastTimer);
    this.toastTimer = undefined;
    if (!this.toast) return;
    this.toast = null;
    this.refresh();
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
        return { kind: 'bitbox02', brand: 'BitBox02', model: model || 'BitBox02' };
      case 'jade-ble':
        return { kind: 'jade-ble', brand: 'Jade', model: model || 'Jade' };
      case 'coldcard-nfc': {
        const name = nfcModelInfo(rec.qrModel).name;
        return { kind: 'coldcard-nfc', brand: name, model: name, ...(isNfcModel(rec.qrModel) ? { qrModel: rec.qrModel } : {}) };
      }
      default: {
        // A QR device: its model as the owner picked it (Settings can change it), else what it was connected as.
        const qrModel = rec.qrModel ?? 'other';
        const info = qrModelInfo(qrModel);
        if (info.model !== 'other') return { kind: 'qr', brand: info.name, model: info.name, qrModel };
        if (rec.kind === 'coldcard') return { kind: 'qr', brand: 'Coldcard', model: model || 'Coldcard', qrModel };
        if (rec.kind === 'jade') return { kind: 'qr', brand: 'Jade', model: model || 'Jade', qrModel };
        return { kind: 'qr', brand: 'signing device', model: model || 'Signing device', qrModel };
      }
    }
  }

  private guardianView(snap: WalletSnapshot | undefined): Guardian {
    const s = this.w?.state;
    const g = s?.guardian;
    const gs = s?.guardianStatus;
    const label = g?.label ?? this.preview?.label;
    const relays = g?.relays ?? this.preview?.relays ?? [];
    const npub = g ? npubEncode(g.pubkey) : (this.preview?.guardianNpub ?? '');
    // Reconnecting after a return to the front: the last status the guardian gave, not "offline" (see `resume`).
    const status = !this.reachable && !this.reconnecting ? 'offline' : gs?.state === 'locked' ? 'locked' : 'online';
    // An alert contact locked it (LOCK over nostr): named as this phone knows them.
    const lockedBy = status === 'locked' ? this.w?.guardianLock?.contact : undefined;
    return {
      host: hostFromLabel(label),
      ...(label ? { label } : {}),
      status,
      lastSeenAt: this.iso(gs?.checkedAt ?? snap?.syncedAt ?? this.clock.now()),
      relays,
      chainData: gs?.chainSource?.kind === 'public' ? 'public' : 'your-node',
      ...(gs?.chainSource
        ? { chainSource: { kind: gs.chainSource.kind, backend: gs.chainSource.backend, host: gs.chainSource.host, ...(gs.chainSource.mempool ? { mempool: gs.chainSource.mempool } : {}) } }
        : {}),
      npub,
      ...(g?.key3Mixed ? { key3Note: KEY3_MIXED_NOTE } : {}),
      ...(gs?.features?.includes(GUARDIAN_FEATURES.passphraseChange) ? { passphraseInWebPage: true } : {}),
      ...(lockedBy ? { lockedByContact: { name: contactName(lockedBy), npub: lockedBy.npub } } : {}),
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
    const sweepUpdate = initiator ? sweepUpdateView(rec.sweepUpdate) : undefined;
    const access = this.w?.recoveryAccess;
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
        ...(access ? { accessExpiresAt: this.iso(access.expiresAt * 1000), accessExpired: access.expired } : {}),
        ...(sweepUpdate ? { sweepUpdate } : {}),
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
    const contacts: Contact[] = (this.w?.alertContacts() ?? []).map((c) => ({ id: c.pubkey, name: contactName(c), npub: c.npub }));
    const limit = rules?.dailyLimitSats ?? snap?.dailyLimit?.limitSats ?? 0;
    const used = snap?.dailyLimit?.spentEstimateSats ?? 0;
    const hardware = this.hardwareView();
    return {
      backing: this.mode,
      network: this.network,
      mainnetRiskAccepted: this.mainnetRiskAccepted,
      capabilities: { lockGuardian: true, replaceGuardian: true, recoveryKey: true },
      progress: this.progress,
      devicePrompt: this.prompts.getSnapshot(),
      syncing: !!this.core || !!this.nextCore,
      updating: !!this.restRun,
      feesUpdating: !!this.w?.feesPending,
      feesVersion: this.w?.feesVersion ?? 0,
      labelsVersion: this.labelsVersion,
      synced: !!s?.chain,
      guardianSlow: this.slow && this.reachable,
      guardianReconnecting: this.reconnecting,
      paymentSending: this.paymentSending,
      toast: this.toast,
      phoneSpending: gs?.phoneSpending ?? 'enabled',
      recoveryOutcome: outcome,
      recovering: s?.stage === 'recovering',
      onboarded: s?.stage === 'paired',
      mode: 'guardian',
      unit: this.prefs.unit,
      theme: this.prefs.theme,
      severalWallets: this.prefs.severalWallets,
      hardware,
      addressVerified: !!s?.hardware?.addressVerified,
      backup: backup
        ? {
            provider: backup.provider === 'icloud' || backup.provider === 'google-drive' ? backup.provider : 'file',
            lastBackedUpAt: this.iso(backup.createdAt),
            unlockedBy: backup.slots.map((x) => (x === 'passkey-prf' ? 'passkey' : 'recovery-code')),
            // Coin control: a label or freeze changed after this backup (one store for every wallet: the first holds it).
            ...((this.set?.first ?? this.w)?.labelsNewerThanBackup ? { labelsNewer: true as const } : {}),
          }
        : null,
      guardian: this.guardianView(snap),
      recoveryDelayDays: rules?.recoveryDelayDays ?? 7,
      dailyLimit: {
        limitSats: limit,
        usedSats: used,
        ...(s ? { cosignedCount: s.spends.filter((x) => x.at > now - 86_400_000).length } : {}),
        // No daily limit (the hardware wallet turned it off): shown in words, never as the number it is stored as.
        ...(isLimitOffSats(limit) ? { off: true } : {}),
        ...(isLimitOffSats(limit) && this.w?.limitBeforeOff !== undefined ? { limitBeforeOffSats: this.w.limitBeforeOff } : {}),
        ...(this.w?.limitOffSupported ? { canTurnOff: true } : {}),
      },
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
        pending: this.replacePending(),
        moving: this.replaceMoving,
      },
      oldWallets: (s?.retiredWallets ?? []).map((o) => ({ id: o.walletId, host: hostFromLabel(o.guardian.label), retiredOnGuardian: o.retiredOnGuardian })),
      walletRetired: s?.retiredByGuardian && s.retiredByGuardian.walletId === s.wallet?.walletId ? { reason: s.retiredByGuardian.reason } : null,
      finishedRecovery:
        outcome === 'finished' && s?.recovery?.recovery
          ? { lostKey: s.recovery.recovery.survivingRole === 'app' ? 'hardware' : 'phone', movedSats: s.recovery.recovery.amountSats }
          : null,
      silentPayments: this.silentView(),
      savings: this.savingsView(),
      ...(s?.guardian?.hosted
        ? {
            hosted: {
              ...(s.guardian.hosted.hostLabel ? { hostLabel: s.guardian.hosted.hostLabel } : {}),
              walletLabel: s.guardian.hosted.walletLabel,
              chainServer: s.guardian.hosted.chainServer ?? null,
              publicServer: publicServer(this.network),
              ...(s.guardian.hosted.endsAt !== undefined ? { endsAt: this.iso(s.guardian.hosted.endsAt) } : {}),
              ...(this.w?.hostedPause ? { paused: this.pausedView(this.w.hostedPause) } : {}),
            },
          }
        : {}),
      ...(this.invite ? { invite: { ...this.invite.view } } : {}),
      // Offered only where the guardian says it can (`contact_lock`); off for everyone until they turn it on.
      ...(this.w && s?.stage === 'paired' ? { contactLock: { on: this.w.contactLockOn, supported: this.w.contactLockSupported } } : {}),
      // Email, ntfy and webhook alerts set up in the guardian's web page: shown, never changed, here.
      ...(this.w && s?.stage === 'paired' && this.w.notificationsSupported ? { alertChannels: groupAlertChannels(this.w.notificationChannels) } : {}),
      ...(this.walletsView() ? { wallets: this.walletsView()! } : {}),
    };
  }

  // ===========================================================================
  // Several wallets (docs/design/multi-wallet.md)

  /** The first wallet, once paired, as a set of one (or the set it is in). */
  private async ensureSet(): Promise<void> {
    if (this.set || !this.w || this.w.ownWallet || this.w.state.stage !== 'paired' || this.w.isHosted) return;
    this.set = await WalletSet.of(this.walletDeps(), this.w);
  }

  private itemOf(w: TrikeyWallet): WalletListItem {
    const s = w.state;
    const snap = w.snapshot();
    const limit = s.rules?.policy.dailyLimitSats ?? snap?.dailyLimit?.limitSats ?? 0;
    const names = s.hardware ? deviceNames(s.hardware.kind, s.hardware.model) : { model: 'Hardware wallet' };
    return {
      account: w.account,
      name: this.set ? this.set.nameOf(w) : 'Main',
      device: names.model,
      current: w === this.w,
      balanceSats: snap?.balance.totalSats ?? 0,
      ...(w.state.savings ? { savingsSats: w.savingsSnapshot()?.balance.totalSats ?? 0 } : {}),
      ...this.frozenOf(w),
      dailyLimitSats: isLimitOffSats(limit) ? 0 : limit,
      ...(isLimitOffSats(limit) ? { limitOff: true as const } : {}),
    };
  }

  /** Coin control: a wallet's frozen coins, which "Move everything" leaves unless they are included. Nothing before a sync. */
  private frozenOf(w: TrikeyWallet): { frozen?: { coins: number; sats: Sats } } {
    if (w.stage !== 'paired' || !w.state.chain) return {};
    try {
      const frozen = w.coins().coins.filter((c) => c.frozen);
      return frozen.length ? { frozen: { coins: frozen.length, sats: frozen.reduce((t, c) => t + c.valueSats, 0) } } : {};
    } catch {
      return {};
    }
  }

  /**
   * The printed recovery sheet: every wallet of the phone (the first only, without a set), with what a new phone needs to
   * find its guardian. Public data only (`recovery-sheet.ts`).
   */
  recoverySheet(layout?: RecoverySheetLayout): RecoverySheet | null {
    const list = this.set ? this.set.list : this.w ? [this.w] : [];
    const wallets = list.flatMap((w) => {
      const g = w.state.guardian;
      const id = w.state.wallet?.walletId;
      if (w.stage !== 'paired' || !g || !id) return [];
      const names = w.state.hardware ? deviceNames(w.state.hardware.kind, w.state.hardware.model) : { model: 'hardware wallet' };
      return [recoverySheetWallet({ name: this.set ? this.set.nameOf(w) : 'Main', device: names.model, walletId: id, network: this.network, guardianPubkey: g.pubkey, relays: g.relays, hosted: w.isHosted })];
    });
    if (!wallets.length) return null;
    return renderRecoverySheet(wallets, { layout: layout ?? 'each', date: new Date(this.clock.now()) });
  }

  private walletsView(): WalletsView | undefined {
    const set = this.set;
    if (!set || !this.w || this.w.isHosted) return undefined;
    const list = set.list.map((w) => this.itemOf(w));
    const current = list.find((x) => x.current) ?? list[0]!;
    const total = set.several ? set.totalDailyLimit() : undefined;
    const supported = set.first.ownWalletsSupported;
    return {
      list,
      current,
      canAdd: set.canAdd,
      guardianUpdateNeeded: !supported && set.first.state.guardianStatus !== undefined,
      ...(total ? { total: { sats: total.sats, off: total.off } } : {}),
    };
  }

  switchWallet(account: number): Promise<void> {
    return this.exclusive(() =>
      this.guarded(async () => {
        const next = this.set?.byAccount(account);
        if (!this.set || !next) throw new WalletServiceError('invalid_input', 'There is no such wallet on this phone.');
        await this.showWallet(next);
      }),
    );
  }

  /** Shows `next`: it pays, receives and syncs; the wallet shown before is disconnected and syncs in the background. */
  private async showWallet(next: TrikeyWallet): Promise<void> {
    const set = this.set!;
    if (next === this.w) return;
    // The wallet shown pays, receives and syncs; the others sync in the background (their alerts still reach the phone).
    const before = this.w;
    clearTimeout(this.timer);
    this.timer = undefined;
    this.quotes.clear();
    // A background sync of the wallet about to be shown ends first (it would close its connection after).
    await this.others.settle(next.account);
    await before?.close().catch(() => undefined);
    // The wallet left synced while it was shown: its background turn comes 10 minutes after.
    if (before && this.lastSyncEndedAt !== undefined) this.others.noteSynced(before.account, this.lastSyncEndedAt);
    await set.show(next);
    this.attach(next);
    this.log = await loadLog(this.deps.platform.kv, this.logKey);
    this.refresh();
    this.starting = this.startInBackground();
  }

  addWallet(input: AddWalletInput): Promise<WalletListItem> {
    return this.exclusive(() =>
      this.guarded(async () => {
        await this.ensureSet();
        const set = this.set;
        const first = set?.first;
        if (!set || !first) throw new WalletServiceError('wrong_state', 'Pair your first wallet before you add another.');
        if (!first.ownWalletsSupported) throw new WalletServiceError('guardian_update_needed', 'Update your guardian to add a wallet.');
        const name = input.name.trim();
        if (!name || name.length > 16 || !isSafeName(name)) throw new WalletServiceError('invalid_input', "Give the wallet a name of 1 to 16 letters, digits, spaces, - and ' only.");
        const kind = toWalletKind(input.hardware);
        // The other rules are the first wallet's: its waiting period, alert contacts and fee cap.
        const base = first.state.rules?.policy;
        const rules: Policy = {
          dailyLimitSats: input.dailyLimitSats,
          recoveryDelayDays: base?.recoveryDelayDays ?? 7,
          alertContacts: [...(base?.alertContacts ?? [])],
          sweepFeeCapSats: base?.sweepFeeCapSats ?? DEFAULT_SWEEP_FEE_CAP_SATS,
        };
        this.setProgress(`Adding "${name}": approve on your new hardware wallet`);
        try {
          const added = await set.addWallet({ name, rules, ...(kind ? { hardwareKind: kind } : {}), ...(hasModel(kind) && input.hardwareModel ? { hardwareModel: input.hardwareModel } : {}) });
          this.armOthersTimer();
          addEvent(this.log, { kind: 'wallet-added', name, at: this.clock.now() });
          await this.saveLogNow();
          this.refresh();
          return this.itemOf(added);
        } finally {
          this.setProgress(null);
        }
      }),
    );
  }

  moveWalletFunds(fromAccount: number, toAccount: number, opts: { includeFrozen?: boolean } = {}): Promise<{ movedSats: Sats }> {
    return this.exclusive(() =>
      this.guarded(async () => {
        const set = this.set;
        const from = set?.byAccount(fromAccount);
        const to = set?.byAccount(toAccount);
        if (!set || !from || !to || from === to) throw new WalletServiceError('invalid_input', 'Choose another wallet of this phone to move the money to.');
        const names = from.state.hardware ? deviceNames(from.state.hardware.kind, from.state.hardware.model) : { model: 'hardware wallet' };
        this.setProgress(`Moving the money of "${set.nameOf(from)}" to "${set.nameOf(to)}"`);
        // A wallet that is not shown is connected for the move, and left as it was after.
        const shown = from === this.w;
        return this.holding([fromAccount, toAccount], async () => {
          try {
            if (!shown) await from.start();
            if (to !== this.w) await to.start();
            const res = await set.moveFunds(from, to, opts.includeFrozen ? { includeFrozen: true } : {});
            if (!res.ok) throw new WalletServiceError('wrong_state', `The move was not signed. Approve it on the ${names.model}.`);
            await this.saveLogNow();
            return { movedSats: res.amountSats };
          } finally {
            if (!shown) await from.close().catch(() => undefined);
            if (to !== this.w) await to.close().catch(() => undefined);
            this.setProgress(null);
            this.refresh();
          }
        });
      }),
    );
  }

  removeWallet(account: number): Promise<void> {
    return this.exclusive(() =>
      this.guarded(async () => {
        const set = this.set;
        const w = set?.byAccount(account);
        if (!set || !w) throw new WalletServiceError('invalid_input', 'There is no such wallet on this phone.');
        if (w === set.first) throw new WalletServiceError('wrong_state', 'Remove your other wallets first: the first wallet goes last.');
        const name = set.nameOf(w);
        this.setProgress(`Removing "${name}": approve on its hardware wallet`);
        return this.holding([account], async () => {
          try {
            // The wallet shown goes: show the first wallet instead.
            if (w === this.w) await this.showWallet(set.first);
            await w.start();
            await w.sync();
            await set.removeWallet(w);
            this.others.forget(account);
            addEvent(this.log, { kind: 'wallet-removed', name, at: this.clock.now() });
            await this.saveLogNow();
          } catch (e) {
            await w.close().catch(() => undefined);
            throw e;
          } finally {
            this.setProgress(null);
            this.refresh();
          }
        });
      }),
    );
  }

  renameWallet(account: number, name: string): Promise<void> {
    return this.guarded(async () => {
      const w = this.set?.byAccount(account);
      if (!this.set || !w) throw new WalletServiceError('invalid_input', 'There is no such wallet on this phone.');
      await this.set.rename(w, name);
      this.refresh();
    });
  }

  /** The Savings part of the state: whether it can be had, and, once it exists, its balance, devices and activity. */
  private savingsView(): SavingsState {
    const w = this.w;
    const s = w?.state;
    if (!w || s?.stage !== 'paired' || w.recoveredElsewhere) return emptySavings('not-available');
    const snap = w.savingsSnapshot();
    if (!snap) {
      // Not known yet (no answer from the guardian so far): offered; creating it says so if the guardian cannot.
      const known = s.guardianStatus?.features !== undefined || !!s.guardianStatus;
      const status = !known || w.savingsSupported ? 'available' : 'guardian-update';
      return { ...emptySavings(status), creating: this.savingsCreating };
    }
    const dev = (d: SavingsSnapshot['hardware']): SavingsDevice => ({ ...deviceNames(d.kind, d.model), fingerprint: d.fingerprint });
    return {
      status: 'active',
      balanceSats: snap.balance.totalSats,
      unconfirmedSats: snap.balance.unconfirmedSats,
      walletId: snap.walletId,
      descriptor: snap.descriptor,
      createdAt: this.iso(snap.createdAt),
      hardware: this.mode === 'simulator' ? { brand: 'simulated device', model: 'Simulated device', fingerprint: snap.hardware.fingerprint } : dev(snap.hardware),
      recoveryKey: this.mode === 'simulator' ? { brand: 'simulated device', model: 'Second simulated device', fingerprint: snap.recoveryKey.fingerprint } : dev(snap.recoveryKey),
      watchedByGuardian: snap.watchedByGuardian,
      activity: snap.history.map((h): SavingsActivityItem => {
        const kind: SavingsActivityItem['kind'] =
          h.purpose === 'to_spending' ? 'to-spending' : h.purpose === 'key_replacement' ? 'key-replacement' : h.purpose === 'consolidate' ? 'consolidated' : h.netSats > 0 ? 'received' : 'sent';
        const at = h.time ? h.time * 1000 : (h.sentAt ?? this.clock.now());
        return {
          id: h.txid,
          txid: h.txid,
          kind,
          // A consolidation keeps the coins in Savings: only its fee left.
          amountSats: kind === 'received' ? h.netSats : kind === 'consolidated' ? (h.feeSats ?? -h.netSats) : (h.amountSats ?? Math.max(0, -h.netSats - (h.feeSats ?? 0))),
          ...(h.feeSats !== undefined && kind !== 'received' ? { feeSats: h.feeSats } : {}),
          at: this.iso(at),
          status: h.confirmations > 0 ? 'confirmed' : 'pending',
          ...(h.recipient ? { address: h.recipient } : {}),
          ...(h.signedBy ? { signedBy: h.signedBy } : {}),
          ...(h.canSpeedUp && kind !== 'received' ? { canSpeedUp: true as const } : {}),
          ...(h.replaces ? { spedUp: true as const } : {}),
        };
      }),
      creating: null,
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
    const startedAt = this.clock.now();
    try {
      return await job();
    } catch (e) {
      this.noteGuardianResult(e, startedAt);
      throw mapError(e);
    }
  }

  /**
   * A guardian call begun at `startedAt` failed with `e`. No answer makes the guardian "offline", unless the call spanned
   * a time away from the front (`spannedPause`): `resume` syncs again, and that sync decides.
   */
  private noteGuardianResult(e: unknown, startedAt: number): void {
    const refusal = e instanceof WalletError ? e.refusal : undefined;
    if (refusal?.kind !== 'unreachable') return;
    if (this.spannedPause(startedAt)) return;
    this.reachable = false;
    this.unreachableAt = this.clock.now();
    this.reconnecting = false;
    this.slow = false;
    this.refresh();
  }

  /** The guardian answered. */
  private answered(refresh = true): void {
    this.reachable = true;
    this.reconnecting = false;
    if (refresh) this.refresh();
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
      case 'labels_changed':
        // Coin control: the coin list, quotes and the backup's "not in your backup yet" read the labels again.
        this.labelsVersion++;
        this.refresh();
        break;
      case 'notes_changed':
        // Encrypted notes on the guardian: Settings > Wallet details shows whether the copy is up to date.
        this.refresh();
        break;
      case 'hardware_prompt':
        // A payment's amounts in the unit the device shows (BTC on most), so the sheet and the device read alike. A
        // recovery's sweep may be signed by the replacement device, whose unit this phone does not know yet: as written.
        if (e.purpose === 'payment') this.prompts.pendingDetail = inDeviceUnit(e.text, deviceAmountUnit(this.hardwareView().kind));
        else if (e.purpose === 'recovery-sweep') this.prompts.pendingDetail = e.text;
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
          void this.requestSync(true);
        } else this.refresh();
        break;
      case 'silent_payments_found':
        this.refresh();
        break;
      case 'other_wallet_alert': {
        // Another wallet of this phone (several wallets): named, so it is not mistaken for the one shown, and synced soon
        // in the background (one under way for it is joined).
        const other = this.set?.byWalletId(e.walletId);
        if (other && other !== this.w) {
          this.others.request(other.account);
          this.kickOthers();
        }
        const a = e.alert;
        const fresh = Math.abs(this.clock.now() - e.atMs) < TOAST_FRESH_MS;
        if (other && fresh && a.message && (a.type.startsWith('recovery_') || a.type === 'limit_off' || a.type === 'wallet_adopted'))
          this.showToast(`${this.set!.nameOf(other)}: ${a.message.replace(/^[^:]{1,16}: /, '')}`);
        this.refresh();
        break;
      }
      case 'speed_up_refused':
        // The check before a "Speed up" is signed failed (the screen shows why in words). One log line with the reason
        // code only: no txid, amount or address.
        console.warn(`speedup.check_failed wallet=${e.wallet} reason=${e.reason}`);
        break;
      case 'address_index_capped':
        // The guardian reported a next address index far past any this phone knows is used: the phone stays within a
        // gap of its own (index-marks.ts). Indexes only, no address.
        console.warn(`sync.index_capped wallet=${e.wallet} chain=${e.chain} reported=${e.reported} used=${e.used}`);
        break;
      case 'payment_signed':
        // Signed (the hardware wallet is done): the screen says "Sending…" now, not "Waiting for your Ledger".
        this.paymentSending = true;
        this.refresh();
        break;
      case 'alert': {
        const a = e.alert;
        if (a.type === 'guardian_locked') {
          const by = a.reason === 'contact' && a.contact ? this.w?.alertContacts().find((c) => c.pubkey === a.contact) : undefined;
          const byContact = a.reason === 'contact' ? (by ? contactName(by) : a.contact ? shortNpub(a.contact) : 'An alert contact') : undefined;
          addEvent(this.log, {
            kind: 'guardian-locked',
            host: hostFromLabel(this.w?.state.guardian?.label),
            ...(a.reason === 'remote' ? { byPhone: true } : {}),
            ...(byContact ? { byContact } : {}),
            at: e.atMs,
          });
          void this.saveLogNow();
        } else if (a.type === 'wallet_retired') {
          addEvent(this.log, { kind: 'wallet-retired', reason: a.reason, at: e.atMs });
          void this.saveLogNow();
        } else if (a.type === 'savings_unwatched' && a.replacedBy !== this.w?.state.savings?.walletId) {
          // Not this phone's own key replacement (that leaves Savings on `replacedBy`): the tripwire was turned off or
          // pointed elsewhere. The wallet registers Savings again at the next sync.
          addEvent(this.log, { kind: 'savings-unwatched', replaced: !!a.replacedBy, at: e.atMs });
          void this.saveLogNow();
        } else if (a.type === 'chain_source_changed') {
          // Changed in the guardian's web page (this phone cannot): the new source shows in Settings > Guardian. For a
          // hosted wallet it is the host's choice (this phone still reads the wallet from its own chain server).
          const hosted = this.w?.isHosted ? ({ hosted: true } as const) : {};
          addEvent(this.log, { kind: 'guardian-server-changed', public: a.kind === 'public', host: a.host, ...hosted, at: e.atMs });
          void this.saveLogNow();
          this.refresh();
        } else if (a.type === 'passphrase_changed') {
          // Changed in the guardian's web page (this phone cannot): a security line, as for the alert channels.
          addEvent(this.log, { kind: 'guardian-passphrase-changed', at: e.atMs });
          void this.saveLogNow();
          this.refresh();
        } else if (a.type === 'notifications_changed') {
          // Changed in the guardian's web page (this phone cannot): worth a line, as a stolen-phone thief cannot do it.
          addEvent(this.log, { kind: 'alert-channels-changed', at: e.atMs });
          void this.saveLogNow();
          this.refresh();
        } else if (a.type === 'wallet_tx') {
          // A payment in or out, from any device, just seen by the guardian: the wallet shows it already (pending, then
          // confirmed); the activity dates it from now; an incoming one gets a note; a sync brings the coins.
          if (a.confirmations === 0 && this.log.seen[a.txid] === undefined) {
            this.log.seen[a.txid] = this.clock.now();
            void saveLog(this.deps.platform.kv, this.logKey, this.log);
          }
          // The note is for news: a recent alert about a payment this phone did not know yet (not its confirmation).
          const fresh = Math.abs(this.clock.now() - e.atMs) < TOAST_FRESH_MS;
          const st = this.w?.state;
          const known = !!st && (st.liveTxs.some((t) => t.txid === a.txid) || (a.wallet === 'main' ? st.chain : st.savings?.chain)?.history.some((h) => h.txid === a.txid));
          if (a.direction === 'in' && fresh && !known && st?.stage === 'paired') this.showToast(toastText(a));
          this.refresh();
          if (a.wallet === 'main') void this.requestSync(true);
        } else if (a.type === 'limit_on' && a.reason === 'recovery') {
          // The guardian turned the limit back on for the recovered wallet (this phone logs its own changes itself).
          addEvent(this.log, { kind: 'limit-on', limitSats: a.limitSats, at: e.atMs });
          void this.saveLogNow();
        } else this.refresh();
        break;
      }
    }
  }

  private async ensureWallet(): Promise<TrikeyWallet> {
    if (this.w) return this.w;
    this.requireMainnetConsent();
    // A wallet made right after a network change uses that network's hardware providers, not the last ones.
    await this.networkReady;
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

  /**
   * Asks the guardian for the wallet's coins and history (a pull to refresh, the timer, a screen that opens). Resolves
   * when the balance and Activity are up to date: the guardian's status and the wallet's chain data are in (the sync's
   * core). The rest of the sync (silent payments, Savings, previous transactions kept for signing, the recovery
   * followed) goes on in the background: `updating` in the state, not the spinner.
   *
   * One core at a time. A sync that began less than `SYNC_JOIN_MS` ago and is still running is joined: its answer is as
   * fresh as a new one. An older core still under way (a slow guardian) is not asked again in parallel: a new core
   * follows it at once, without waiting for its background part. (A pull used to wait for the rest of the running
   * sync, its background part, and then a whole second sync: a minute or two with a slow Electrs.)
   */
  sync(): Promise<void> {
    return this.requestSync(false);
  }

  /**
   * `fresh`: the answer must be asked for after now (the wallet a recovery made, a payment just sent or announced, the
   * return to the front), so a core under way, which may have been asked before, is never joined: one follows it. None
   * is lost. (Dropping the request left the phone showing the guardian offline and no balance right after a recovery
   * finished, until the next timer: the sync begun while recovering failed after the switch, and the switch's own sync
   * had been dropped.)
   */
  private requestSync(fresh: boolean): Promise<void> {
    const w = this.w;
    if (!w || w.stage === 'new' || this.closed) return Promise.resolve();
    if (this.nextCore) return this.nextCore;
    const recent = this.lastSyncAt !== undefined && this.clock.now() - this.lastSyncAt < (this.deps.syncJoinMs ?? SYNC_JOIN_MS);
    const core = this.core;
    if (core) {
      if (!fresh && recent) return core.done;
      this.nextCore = core.done.catch(() => undefined).then(() => {
        this.nextCore = undefined;
        return this.startCore();
      });
      this.refresh();
      return this.nextCore;
    }
    // Only its background part is left: the balance it brought is as fresh as a new one.
    if (!fresh && recent && this.restRun) return Promise.resolve();
    return this.startCore();
  }

  /** When the last sync began (`startCore`). */
  private lastSyncAt?: number;

  private startCore(): Promise<void> {
    const w = this.w;
    if (!w || w.stage === 'new' || this.closed) return Promise.resolve();
    const startedAt = this.clock.now();
    this.lastSyncAt = startedAt;
    const done: Promise<void> = this.runCore(w, startedAt).finally(() => {
      if (this.core?.done === done) this.core = undefined;
      this.lastSyncEndedAt = this.clock.now();
      if (this.isIdle()) this.armTimer();
      this.refresh();
    });
    this.core = { done, startedAt };
    this.refresh();
    return done;
  }

  private async runCore(w: TrikeyWallet, startedAt: number): Promise<void> {
    let rest: (() => Promise<unknown>) | undefined;
    try {
      // A recovering phone follows its recovery; the guardian's status says when it took the new wallet over.
      if (w.stage === 'recovering') await w.refreshStatus().then(() => w.recoveryStatus());
      if (w.stage === 'paired') {
        const core = await w.syncCore();
        rest = core.rest;
        const now = this.clock.now();
        let changed = false;
        for (const h of core.snapshot.history) if (h.confirmations === 0 && this.log.seen[h.txid] === undefined) ((this.log.seen[h.txid] = now), (changed = true));
        if (changed) await saveLog(this.deps.platform.kv, this.logKey, this.log);
      }
      this.answered(false);
      this.slow = false;
    } catch (e) {
      if (e instanceof WalletError && e.code === 'guardian_slow') {
        // It answered its status: online, only slow to read the chain (a slow Electrum server). Not "offline".
        this.answered(false);
        this.slow = true;
      }
      // Another sync is due right after this one, and only its outcome says whether the guardian answers now.
      else if (!this.nextCore) this.noteGuardianResult(e, startedAt);
    }
    // A sync begun after the return to the front has had its say (or another one is due): no longer "reconnecting"
    // once the guardian is known to answer or not.
    if (this.reconnecting && !this.nextCore && !this.spannedPause(startedAt)) this.reconnecting = false;
    if (rest && !this.closed) this.startRest(rest, startedAt);
    this.refresh();
  }

  /**
   * The background part of a sync (`updating`). One at a time: a newer one waits for the one running, and replaces any
   * older one waiting (it reads the same things, later). A failure shows as a failed sync did (a guardian that stopped
   * answering is "offline"), unless a newer core is under way or due: its outcome says.
   */
  private startRest(rest: () => Promise<unknown>, startedAt: number): void {
    this.restNext = { rest, startedAt };
    if (this.restRun || this.closed) return;
    this.restRun = (async () => {
      try {
        for (let next = this.restNext; next && !this.closed; next = this.restNext) {
          this.restNext = undefined;
          try {
            await next.rest();
          } catch (e) {
            if (!this.core && !this.nextCore) this.noteGuardianResult(e, next.startedAt);
          }
          this.refresh();
        }
      } finally {
        // In the same turn as the last look at `restNext`: one asked for from now on starts a new run.
        this.restRun = undefined;
        this.restNext = undefined;
        this.lastSyncEndedAt = this.clock.now();
        if (this.isIdle()) this.armTimer();
        this.refresh();
      }
    })();
  }

  /** No sync is running or due, background part included, and no wallet that is not shown is syncing. */
  private isIdle(): boolean {
    return this.mainIdle() && this.others.running === undefined;
  }

  /** No sync of the wallet shown is running or due, background part included. */
  private mainIdle(): boolean {
    return !this.core && !this.nextCore && !this.restRun;
  }

  // ===========================================================================
  // Several wallets: the ones not shown sync in the background (other-wallets-sync.ts)

  /** The phone's wallets that are not shown and may sync: paired, not moving to a new guardian, still guarded. */
  private otherAccounts(): number[] {
    const set = this.set;
    if (!set?.several || this.closed) return [];
    return set.list.filter((w) => w !== this.w && !this.held.has(w.account) && w.stage === 'paired' && !w.state.replacing && !w.recoveredElsewhere).map((w) => w.account);
  }

  /** Runs `fn` with the wallets at `accounts` kept from background syncs (one under way ends first). */
  private async holding<T>(accounts: number[], fn: () => Promise<T>): Promise<T> {
    for (const a of accounts) this.held.add(a);
    try {
      for (const a of accounts) await this.others.settle(a);
      return await fn();
    } finally {
      for (const a of accounts) this.held.delete(a);
    }
  }

  /** One background sync of a wallet not shown: connect it, read its chain data (and its Savings'), disconnect. */
  private async syncOther(account: number): Promise<void> {
    const w = this.set?.byAccount(account);
    if (!w || w === this.w || this.closed) return;
    try {
      await w.start();
      await w.sync();
      if (w.state.savings) await w.syncSavings().catch(() => undefined);
    } finally {
      // Shown meanwhile (the switch connected it), or an operation took it: it stays connected.
      if (w !== this.w && !this.held.has(account)) await w.close().catch(() => undefined);
      this.refresh();
    }
  }

  /**
   * Looks whether a wallet not shown is due, every `otherWalletCheckMs`; starts it (one at a time, never back to back).
   * Runs while the phone holds several wallets (armed at start, after "Add a wallet" and after a restore).
   */
  private armOthersTimer(): void {
    clearTimeout(this.othersTimer);
    this.othersTimer = undefined;
    if (this.closed || this.deps.otherWalletSyncMs === 0 || !this.set?.several) return;
    this.othersTimer = setTimeout(() => {
      this.othersTimer = undefined;
      this.kickOthers();
      this.armOthersTimer();
    }, this.deps.otherWalletCheckMs ?? 15_000);
  }

  private kickOthers(): void {
    if (this.closed || this.deps.otherWalletSyncMs === 0) return;
    const run = this.others.tick();
    if (!run) return;
    this.refresh();
    void run.then(() => {
      if (this.isIdle()) this.armTimer();
      this.refresh();
    });
  }

  /** Resolves once no wallet that is not shown is syncing (tests). */
  othersIdle(): Promise<void> {
    return this.others.idle();
  }

  /**
   * The periodic sync (`syncIntervalMs`) comes `syncIntervalMs` after the end of the last sync, whatever started it, and
   * never queues one: a sync under way when it comes due makes it wait for that sync's end (it is re-armed then). With
   * a guardian slower than the interval (a wallet.sync of 33-39 s on an Umbrel, and the rest of the sync after it), a
   * fixed 60 s timer always found a sync running, queued another, and the phone synced back to back, never idle:
   * constant load on the guardian and its Electrs, a drained battery, and every pull waiting behind it.
   */
  private armTimer(): void {
    const every = this.deps.syncIntervalMs ?? 60_000;
    clearTimeout(this.timer);
    this.timer = undefined;
    if (!this.timerOn || every <= 0 || this.closed) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      if (!this.isIdle()) return;
      void this.sync();
      // Nothing to sync yet (a phone key made, not paired): look again next time.
      if (this.isIdle()) this.armTimer();
    }, every);
  }

  /** Resolves once no sync is running or due, background part included (tests; a screen that needs all of it). */
  async idle(): Promise<void> {
    for (let p = this.nextCore ?? this.core?.done ?? this.restRun; p; p = this.nextCore ?? this.core?.done ?? this.restRun) await p.catch(() => undefined);
  }

  // ===========================================================================
  // Onboarding

  setNetwork(network: NetworkName): void {
    if (this.w) throw new WalletServiceError('wrong_state', "This wallet's network can't change.");
    if (this.mode === 'simulator' && network !== 'regtest') throw new WalletServiceError('invalid_input', 'The simulator works on regtest only.');
    if (!GUARDIAN_NETWORKS.includes(network)) throw new WalletServiceError('invalid_input', `Trikey doesn't know the network "${network}".`);
    if (network !== this.network) this.mainnetRiskAccepted = false;
    this.network = network;
    void this.deps.platform.kv.set(networkPrefKey(this.mode), network).catch(() => {});
    this.networkReady = this.buildHardware()
      .then(() => this.loadLogFor())
      .then(() => this.refresh())
      .catch(() => {});
    this.refresh();
  }

  acceptMainnetRisk(accepted: boolean): void {
    this.mainnetRiskAccepted = accepted;
    this.refresh();
  }

  /** No wallet is made on mainnet (created, recovered or restored) before the person accepted the warning. */
  private requireMainnetConsent(network: NetworkName = this.network): void {
    if (network === 'bitcoin' && !this.mainnetRiskAccepted)
      throw new WalletServiceError('wrong_state', 'Read the mainnet warning and accept it first: Trikey is pre-alpha and not audited.');
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
      const available = await provider.isAvailable().catch(() => false);
      const why = !available ? await unavailableDetailOf(provider) : undefined;
      out.push({ ...opt, available, ...(why ? { unavailableDetail: why } : {}) });
    }
    return out;
  }

  connectHardware(kind: HardwareKind, qrModel?: QrModel): Promise<HardwareWallet> {
    return this.exclusive(() =>
      this.guarded(async () => {
        const w = await this.ensureWallet();
        this.abort?.abort();
        const ac = (this.abort = new AbortController());
        this.setProgress(`Connecting to your ${hardwareBrandOf(kind, qrModel)}`);
        try {
          await w.connectHardware({ kind: toWalletKind(kind), signal: ac.signal, ...(hasModel(kind) && qrModel ? { qrModel } : {}) });
          return this.hardwareView();
        } finally {
          this.setProgress(null);
        }
      }),
    );
  }

  setHardwareModel(model: QrModel): Promise<void> {
    return this.exclusive(() =>
      this.guarded(async () => {
        const w = this.requireWallet();
        await w.setHardwareModel(model);
        this.refresh();
      }),
    );
  }

  /** A scanned host's invite, kept until `setUpRules` accepts it (docs/design/family-hosting.md). */
  private invite?: { uri: string; view: InviteView };

  readInvite(code: string): InviteView {
    const c = this.readCode(code);
    if (c.kind !== 'invite') throw new WalletServiceError('pairing_invalid', c.kind === 'unknown' ? c.reason : "That isn't an invite to someone's guardian.");
    // On mainnet, the same pre-alpha warning and consent as guardian mode (checked again when the wallet is made).
    this.requireMainnetConsent(c.network);
    const view: InviteView = {
      ...(c.label ? { hostLabel: c.label } : {}),
      npub: c.guardianNpub,
      network: c.network,
      expiresAt: this.iso(c.expiresAt * 1000),
      mainnet: c.network === 'bitcoin',
      acknowledged: false,
    };
    this.invite = { uri: c.uri, view };
    this.preview = undefined;
    this.refresh();
    return view;
  }

  acknowledgeInvite(understood: boolean): void {
    if (!this.invite) throw new WalletServiceError('wrong_state', 'Scan the invite first.');
    this.invite = { ...this.invite, view: { ...this.invite.view, acknowledged: understood } };
    this.refresh();
  }

  private pausedView(p: NonNullable<TrikeyWallet['hostedPause']>): NonNullable<HostedWalletView['paused']> {
    return { by: p.by, at: this.iso(p.at * 1000), ...(p.contact ? { contactName: contactName(p.contact) } : {}) };
  }

  checkLeaveHost(): Promise<LeaveHostCheck> {
    return this.guarded(async () => {
      const c = await this.requireWallet().hostedLeaveCheck();
      this.refresh();
      return { safe: c.safe, blockers: c.blockers.map((b) => leaveBlockerText([b])) };
    });
  }

  leaveHost(): Promise<void> {
    return this.exclusive(() =>
      this.guarded(async () => {
        this.setProgress('Releasing your wallet on your host’s guardian');
        try {
          await this.requireWallet().leaveHost();
        } finally {
          this.setProgress(null);
        }
        this.refresh();
      }),
    );
  }

  setHostedChainServer(url: string | null): Promise<void> {
    return this.guarded(async () => {
      const w = this.requireWallet();
      await w.setHostedChainServer(url === null || url.trim() === '' ? undefined : parseServerUrl(url));
      this.refresh();
      void this.sync();
    });
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

  /** `setUpRules` with a host's invite: the disclosure was acknowledged; on mainnet the warning was accepted too. */
  private async acceptInvite(w: TrikeyWallet, limitSats: Sats, delayDays: RecoveryDelayDays): Promise<void> {
    const invite = this.invite!;
    if (!invite.view.acknowledged) throw new WalletServiceError('wrong_state', `Tick "I understand ${invite.view.hostLabel ?? 'the host'} could help a thief skip the wait" first.`);
    this.requireMainnetConsent(invite.view.network);
    const contacts = this.onboardingContacts;
    const rules: Policy = { dailyLimitSats: limitSats, recoveryDelayDays: delayDays, alertContacts: contacts.map((c) => c.pubkey), sweepFeeCapSats: DEFAULT_SWEEP_FEE_CAP_SATS };
    this.setProgress('Accepting the invite: approve on your hardware wallet');
    try {
      await w.acceptInvite({
        inviteUri: invite.uri,
        rules,
        walletLabel: this.deps.deviceName ? `${this.deps.deviceName}`.slice(0, 64) : 'Trikey wallet',
        understood: true,
        mainnetConsent: this.mainnetRiskAccepted,
        ...(this.deps.deviceName ? { deviceName: this.deps.deviceName } : {}),
      });
      this.invite = undefined;
      for (const c of contacts) if (c.name) await w.nameAlertContact(c.pubkey, c.name);
      this.onboardingContacts = [];
    } finally {
      this.setProgress(null);
    }
  }

  private onboardingContacts: { name: string; npub: string; pubkey: string }[] = [];

  setOnboardingContacts(contacts: { name: string; npub: string }[]): void {
    const seen = new Set<string>();
    const out: { name: string; npub: string; pubkey: string }[] = [];
    for (const c of contacts) {
      let pubkey: string;
      try {
        pubkey = npubToHex(c.npub);
      } catch {
        throw new WalletServiceError('invalid_input', "That doesn't look like a nostr public key (npub…).");
      }
      if (seen.has(pubkey)) continue;
      seen.add(pubkey);
      out.push({ name: c.name.trim(), npub: c.npub.trim(), pubkey });
    }
    this.onboardingContacts = out;
  }

  setUpRules(limitSats: Sats, delayDays: RecoveryDelayDays): Promise<void> {
    return this.exclusive(() =>
      this.guarded(async () => {
        const w = this.requireWallet();
        if (this.invite) return this.acceptInvite(w, limitSats, delayDays);
        const preview = this.preview;
        if (!preview) throw new WalletServiceError('wrong_state', 'Scan the guardian first.');
        if (Math.floor(this.clock.now() / 1000) >= preview.expiresAt)
          throw new WalletServiceError('pairing_expired', 'The pairing code ran out (they last 5 minutes). Open a fresh one on your guardian and scan it again.');
        const contacts = this.onboardingContacts;
        const rules: Policy = {
          dailyLimitSats: limitSats,
          recoveryDelayDays: delayDays,
          alertContacts: contacts.map((c) => c.pubkey),
          sweepFeeCapSats: DEFAULT_SWEEP_FEE_CAP_SATS,
        };
        this.setProgress('Pairing: approve on your hardware wallet');
        try {
          await w.pair({ rules, deviceName: this.deps.deviceName });
          await this.ensureSet().catch(() => undefined);
          this.preview = undefined;
          for (const c of contacts) if (c.name) await w.nameAlertContact(c.pubkey, c.name);
          this.onboardingContacts = [];
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
          // One backup for every wallet of the phone (version 4 once there is more than one).
          const r = this.set ? await this.set.createBackup({ passkey, recoveryCode: true, cloud: store }) : await w.createBackup({ passkey, recoveryCode: true, cloud: store });
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
    return this.quoted(request, false);
  }

  /** The whole vault to `address`: the wallet's `quoteSendMax` (every coin, one output, no change). */
  getWalletDetails(): WalletDetails | null {
    const w = this.wallet;
    const rec = w?.state.wallet;
    if (!w || !rec) return null;
    const keys = w.multisig().keys;
    return {
      descriptor: rec.descriptor,
      network: this.network,
      fingerprints: { phone: keys.app.fingerprint, hardware: keys.hardware.fingerprint, guardian: keys.cosigner.fingerprint },
      walletId: rec.walletId,
      ...(w.state.savings
        ? {
            savings: {
              descriptor: w.state.savings.descriptor,
              walletId: w.state.savings.walletId,
              fingerprints: { phone: w.state.savings.phone.fingerprint, hardware: w.state.savings.hardware.fingerprint, recoveryKey: w.state.savings.recoveryKey.fingerprint },
            },
          }
        : {}),
    };
  }

  quoteSendMax(request: { address: string; speed: FeeSpeed; coins?: string[] }): QuoteOutcome {
    return this.quoted({ address: request.address, speed: request.speed, amountSats: 0, ...(request.coins?.length ? { coins: request.coins } : {}) }, true);
  }

  private quoted(request: SendRequest, max: boolean): QuoteOutcome {
    const w = this.w;
    if (!w || w.stage !== 'paired') return { ok: false, problem: 'not_ready', message: 'The wallet is not set up yet.' };
    const st = w.state;
    const key = JSON.stringify([
      max,
      request.address,
      request.amountSats,
      request.speed,
      request.signer ?? 'auto',
      request.coins?.join(',') ?? '',
      this.labelsVersion, // a coin frozen or unfrozen
      st.chain?.syncedAt,
      w.feesVersion, // fee estimates that landed after the sync
      // the coins themselves: a send max is made of all of them, and a clock that does not move would hide a sync
      st.chain?.utxos.map((u) => `${u.txid}:${u.vout}`).join(','),
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
    const outcome = this.makeQuote(w, request, max);
    this.lastQuote = { key, outcome };
    return outcome;
  }

  private makeQuote(w: TrikeyWallet, request: SendRequest, max: boolean): QuoteOutcome {
    try {
      const asked = {
        address: request.address,
        speed: request.speed,
        ...(request.signer === 'hardware' ? { signer: 'hardware' as const } : {}),
        ...(request.coins?.length ? { coins: request.coins } : {}),
      };
      const q = max ? w.quoteSendMax(asked) : w.quoteSend({ ...asked, amountSats: request.amountSats });
      const ref = `q${++this.quoteCounter}`;
      this.quotes.set(ref, q);
      if (this.quotes.size > 20) this.quotes.delete(this.quotes.keys().next().value!);
      const quote: SendQuote = {
        // A send max asks for no amount: the wallet's is what the quote is for.
        request: { ...request, amountSats: q.request.amountSats },
        feeSats: q.feeSats,
        totalSats: q.totalSats,
        plan: q.plan.signer === 'phone+guardian' ? { signer: 'phone+guardian' } : { signer: 'hardware', reason: q.plan.reason },
        remainingAfterSats: q.remainingAfterSats,
        feeRateSatPerVb: q.feeRate,
        ref,
        ...(q.sendMax ? { max: true as const } : {}),
        ...(q.silentPayment ? { silentPayment: { outputAddress: q.silentPayment.outputAddress, helperFeeSats: q.silentPayment.helper.feeSats } } : {}),
        ...(q.mixesLabels ? { mixesLabels: q.mixesLabels.labels } : {}),
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
        // A send max is only that for the coins it was made from: with no wallet quote behind it, quoting again is the way.
        if (quote.max && !real) throw new WalletServiceError('quote_stale', 'Your coins changed since the payment was prepared. Go back and review it again.');
        // What the person saw (the keys it names) is what happens, even if the wallet would plan it differently now.
        const plan: WalletQuote['plan'] = quote.plan.signer === 'phone+guardian' ? { signer: 'phone+guardian' } : { signer: 'phone+hardware', reason: quote.plan.reason as never };
        const input: WalletQuote | { address: string; amountSats: number; speed: SendRequest['speed']; signer?: 'hardware' } = real
          ? { ...real, plan }
          : {
              address: quote.request.address,
              amountSats: quote.request.amountSats,
              speed: quote.request.speed,
              ...(plan.signer === 'phone+hardware' ? { signer: 'hardware' as const } : {}),
              ...(quote.request.coins?.length ? { coins: quote.request.coins } : {}),
            };
        // The person decides when the hardware wallet steps in: no silent fallback after a refusal. The payment is in
        // Activity as soon as it is broadcast (the wallet's send log); the sync that follows runs on its own, so a
        // guardian slow to read its node does not keep the person waiting on "Sending".
        let res: Awaited<ReturnType<TrikeyWallet['send']>>;
        try {
          res = await w.send(input, { fallbackToHardware: false, syncAfter: false });
        } finally {
          this.paymentSending = false;
        }
        if (!res.ok) {
          if (res.signedTx) throw broadcastError(res.refusal, 'listed');
          throw refusalToError(res.refusal);
        }
        // The wallet's send log keeps where it went and who signed (Activity reads it from the wallet's history).
        const at = this.clock.now();
        const signedBy = res.signedBy;
        this.refresh();
        void this.requestSync(true);
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

  /** "Speed up" of a payment waiting to confirm (./real-speed-up.ts): signed like `sendPayment`, "Sending…" the same way. */
  readonly speedUp: SpeedUpActions = createSpeedUpActions({
    wallet: () => this.w,
    requireWallet: () => this.requireWallet(),
    run: (job) => this.exclusive(() => this.guarded(job)),
    sendingDone: () => {
      this.paymentSending = false;
    },
    sent: () => {
      // As after a payment: a new sync, never one joined that began before the replacement went out.
      this.refresh();
      void this.requestSync(true);
    },
    broadcastError: (refusal) => broadcastError(refusal, 'listed'),
    iso: (ms) => this.iso(ms),
    now: () => this.clock.now(),
  });

  /** Notes that survive recovery (./real-notes.ts): an encrypted copy of the labels on the guardian. */
  readonly notes: NotesActions = createNotesActions({
    wallet: () => this.w,
    requireWallet: () => this.requireWallet(),
    run: (job) => this.exclusive(() => this.guarded(job)),
    changed: () => {
      this.labelsVersion++;
      this.refresh();
    },
    iso: (ms) => this.iso(ms),
  });

  /** Unlocking the guardian with the hardware wallet (./real-hardware-unlock.ts). Nothing that unlocks is kept on the phone. */
  readonly hardwareUnlock: HardwareUnlockActions = createHardwareUnlockActions({
    wallet: () => this.w,
    requireWallet: () => this.requireWallet(),
    run: (job) => this.exclusive(() => this.guarded(job)),
    unlocked: () => this.answered(),
    changed: () => this.refresh(),
    iso: (ms) => this.iso(ms),
  });

  /** Coin control (./real-coins.ts): the coin list, labels and freezes, "Consolidate", BIP 329 export and import. */
  readonly coins: CoinActions = createCoinActions({
    wallet: () => this.w,
    requireWallet: () => this.requireWallet(),
    walletName: () => (this.w && this.set?.several ? this.set.nameOf(this.w) : undefined),
    run: (job) => this.exclusive(() => this.guarded(job)),
    sendingDone: () => {
      this.paymentSending = false;
    },
    sent: (wallet) => {
      // As after a payment: shown at once, and a new sync on its own (Savings' own sync ran in `sendFromSavings`).
      this.refresh();
      if (wallet === 'spending') void this.requestSync(true);
    },
    changed: () => {
      this.labelsVersion++;
      this.refresh();
    },
    broadcastError: (refusal) => broadcastError(refusal, 'listed'),
    iso: (ms) => this.iso(ms),
    now: () => this.clock.now(),
    // The platform's file sharing and picker, read when used (the deps are set after this field).
    shareTextFile: (name, text) => {
      if (!this.deps.shareLabelsFile) throw notAvailableYet('Sharing a labels file');
      return this.deps.shareLabelsFile(name, text);
    },
    pickFile: () => {
      if (!this.deps.pickLabelsFile) throw notAvailableYet('Opening a labels file');
      return this.deps.pickLabelsFile();
    },
  });

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
      this.answered();
    });
  }

  lockGuardian(): Promise<void> {
    return this.exclusive(() =>
      this.guarded(async () => {
        this.setProgress(this.w?.isHosted ? 'Pausing your wallet' : 'Locking your guardian');
        try {
          await this.requireWallet().lockGuardian();
        } finally {
          this.setProgress(null);
        }
      }),
    );
  }

  /** A move that started and has not finished: the wallet shown's, or (several wallets) any wallet's still to move. */
  private replacePending(): ReplaceGuardianState['pending'] {
    const set = this.set;
    const left = set?.several ? set.moveUnfinished : [];
    const r = set?.several ? (set.first.state.replacing ?? left.find((x) => x.state.replacing)?.state.replacing) : this.w?.state.replacing;
    if (!r && !left.length) return null;
    const target = set?.several ? (set.first.state.replacing?.guardian ?? set.first.state.guardian) : r?.guardian;
    return {
      ...(target?.label ? { guardianLabel: target.label } : {}),
      signed: r?.phase === 'signed',
      oldGuardianOffline: r?.oldGuardianOffline ?? false,
      ...(set?.several ? { wallets: [...(set.first.state.replacing ? [set.first] : []), ...left].map((x) => set.nameOf(x)) } : {}),
    };
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
          const set = this.set;
          if (set?.several) {
            // Several wallets: one code, every wallet moves (the first pairs, the others are added at their accounts).
            const plan = await set.previewReplaceGuardian(code.uri);
            this.replacePlan = {
              ...this.planView(plan.first),
              movingSats: plan.wallets.reduce((a, x) => a + x.balanceSats, 0),
              coins: plan.wallets.reduce((a, x) => a + x.coins, 0),
              wallets: plan.wallets.map((x) => ({ name: x.name, device: deviceNames(x.hardwareKind, set.byAccount(x.account)?.state.hardware?.model).model, movingSats: x.balanceSats, coins: x.coins })),
            };
          } else this.replacePlan = this.planView(await w.previewReplaceGuardian(code.uri));
        } finally {
          this.setProgress(null);
        }
        return this.replacePlan;
      }),
    );
  }

  /** "Replace guardian" with several wallets: every wallet, each with its own device, "2 of 3 moved" when one waits. */
  private async replaceAll(set: WalletSet, opts: { oldGuardianGone?: boolean }): Promise<ReplaceGuardianResult> {
    const host = hostFromLabel(set.first.state.replacing?.guardian.label ?? this.replacePlan?.newGuardian.label);
    const run = () =>
      set.replaceGuardian({
        ...(opts.oldGuardianGone ? { oldGuardianReachable: false as const } : {}),
        onWallet: (x, index, total) => {
          const hw = x.state.hardware;
          const device = hw ? deviceNames(hw.kind, hw.model).model : 'hardware wallet';
          this.replaceMoving = { name: set.nameOf(x), device, index, total };
          this.replaceStep = null;
          this.setProgress(`"${set.nameOf(x)}" (${index + 1} of ${total}): connect its ${device}`);
        },
        onEvent: (x, e) => {
          if (x !== this.w && e.type === 'progress' && e.operation === 'replace-guardian') {
            this.replaceStep = e.step;
            this.setProgress(`"${set.nameOf(x)}": ${REPLACE_PROGRESS[e.step]}`);
          }
        },
      });
    try {
      // Every wallet is the move's while it runs: no background sync touches one.
      const out = await this.holding(
        set.list.map((x) => x.account),
        run,
      );
      const wallets: WalletMoveResult[] = out.wallets.map((m) => ({
        name: m.name,
        status: m.status === 'awaiting_broadcast' ? 'waiting' : m.status,
        ...(m.error ? { error: m.error.message } : {}),
      }));
      const movedSats = out.wallets.reduce((a, m) => a + (m.outcome?.movedSats ?? 0), 0);
      if (out.status === 'partial') return { status: 'partial', moved: out.moved, total: out.total, wallets };
      this.replacePlan = null;
      this.answered(false);
      addEvent(this.log, { kind: 'guardian-replaced', host, movedSats, at: this.clock.now() });
      await this.saveLogNow();
      return { status: 'done', movedSats, oldWalletRetired: out.firstRetiredOnOldGuardian, wallets };
    } finally {
      this.replaceMoving = null;
      this.replaceStep = null;
      this.setProgress(null);
      this.refresh();
    }
  }

  replaceGuardian(opts: { oldGuardianGone?: boolean } = {}): Promise<ReplaceGuardianResult> {
    return this.exclusive(() =>
      this.guarded(async () => {
        const w = this.requireWallet();
        const set = this.set;
        if (set?.several) {
          if (!this.replacePlan && !set.first.state.replacing && !set.moveUnfinished.length) throw new WalletServiceError('wrong_state', "Scan the new guardian's pairing code first.");
          return this.replaceAll(set, opts);
        }
        if (!this.replacePlan && !w.state.replacing) throw new WalletServiceError('wrong_state', "Scan the new guardian's pairing code first.");
        const host = hostFromLabel(w.state.replacing?.guardian.label ?? this.replacePlan?.newGuardian.label);
        try {
          const out = await w.replaceGuardian(opts.oldGuardianGone ? { oldGuardianReachable: false } : {});
          if (out.status === 'awaiting_broadcast') return { status: 'waiting' as const, movedSats: out.movedSats };
          this.replacePlan = null;
          this.answered(false);
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
      // Several wallets: the first wallet holds the new guardian's pairing (it pairs first).
      await (this.set?.several ? this.set.first : this.w)?.abandonReplaceGuardian();
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
  // Savings (optional; docs/design/savings-and-limit-off.md)

  /** The wallet's kind for a device the person picked; the simulator's second device for "simulated". */
  private secondKind(kind: HardwareKind): WalletHardwareKind | undefined {
    return kind === 'simulated' ? (this.deps.secondDeviceKind ?? 'coldcard') : toWalletKind(kind);
  }

  readonly savings: SavingsActions = {
    start: () =>
      this.exclusive(() =>
        this.guarded(async () => {
          const w = this.requireWallet();
          await w.startSavings();
          this.savingsCreating = { phone: true, hardware: false };
          this.refresh();
        }),
      ),
    connectHardware: () =>
      this.exclusive(() =>
        this.guarded(async () => {
          const w = this.requireWallet();
          this.setProgress(`Connecting to your ${this.hardwareView().brand}`);
          try {
            await w.savingsConnectHardware();
          } finally {
            this.setProgress(null);
          }
          this.savingsCreating = { ...(this.savingsCreating ?? { phone: true }), hardware: true };
          this.refresh();
        }),
      ),
    connectRecoveryKey: (kind) =>
      this.exclusive(() =>
        this.guarded(async () => {
          const w = this.requireWallet();
          this.setProgress('Connecting to your Recovery Key');
          let draft;
          try {
            draft = await w.savingsConnectRecoveryKey({ kind: this.secondKind(kind) });
          } finally {
            this.setProgress(null);
          }
          const rk = draft.recoveryKey!;
          const device: SavingsDevice =
            this.mode === 'simulator' ? { brand: 'simulated device', model: 'Second simulated device', fingerprint: rk.fingerprint } : { ...deviceNames(rk.kind, rk.model), fingerprint: rk.fingerprint };
          this.savingsCreating = { phone: true, hardware: true, recoveryKey: device };
          this.refresh();
          return device;
        }),
      ),
    finish: () =>
      this.exclusive(() =>
        this.guarded(async () => {
          const w = this.requireWallet();
          this.setProgress(`Registering Savings on your ${this.hardwareView().brand}`);
          try {
            const r = await w.finishSavings();
            this.savingsCreating = null;
            addEvent(this.log, { kind: 'savings-created', at: this.clock.now() });
            await this.saveLogNow();
            void w.syncSavings().then(() => this.refresh(), () => undefined);
            return { descriptor: r.descriptor, firstAddress: r.firstAddress, watchedByGuardian: r.watchedByGuardian };
          } finally {
            this.setProgress(null);
          }
        }),
      ),
    cancelCreate: () => {
      this.w?.abandonSavings();
      this.savingsCreating = null;
      this.refresh();
    },
    receiveAddress: (opts = {}) => {
      const run = () =>
        this.guarded(async () => {
          const r = await this.requireWallet().savingsReceiveAddress(opts);
          return { address: r.address, verifiedOnDevice: r.verifiedOnDevice };
        });
      return opts.verifyOnDevice ? this.exclusive(run) : run();
    },
    quote: ({ address, amountSats, max, coins }) => {
      const w = this.w;
      if (!w?.state.savings) return { ok: false, problem: 'not_ready', message: 'Set up Savings first.' };
      try {
        const picked = coins?.length ? { coins } : {};
        const q = max ? w.quoteSavingsSendMax({ address: address.trim(), ...picked }) : w.quoteSavingsSpend({ address: address.trim(), amountSats, ...picked });
        const ref = `s${++this.quoteCounter}`;
        this.savingsQuotes.set(ref, q);
        if (this.savingsQuotes.size > 20) this.savingsQuotes.delete(this.savingsQuotes.keys().next().value!);
        const quote: SavingsQuote = {
          ref,
          address: q.request.address,
          amountSats: q.request.amountSats,
          feeSats: q.feeSats,
          totalSats: q.totalSats,
          toSpending: q.toSpending,
          ...(q.sendMax ? { max: true as const } : {}),
          ...(q.mixesLabels ? { mixesLabels: q.mixesLabels.labels } : {}),
        };
        return { ok: true, quote };
      } catch (e) {
        if (e instanceof WalletError) return { ok: false, ...describeProblem(e) };
        throw e;
      }
    },
    send: (quote, signers) =>
      this.exclusive(() =>
        this.guarded(async () => {
          const w = this.requireWallet();
          const q = quote.ref ? this.savingsQuotes.get(quote.ref) : undefined;
          if (!q) throw new WalletServiceError('quote_stale', 'This payment needs a fresh quote. Go back and check it again.');
          const res = await w.sendFromSavings(q, { signers });
          if (!res.ok) {
            if (res.signedTx) throw broadcastError(res.refusal, 'unlisted');
            throw refusalToError(res.refusal);
          }
          this.refresh();
          return { txid: res.txid, amountSats: res.amountSats, feeSats: res.feeSats };
        }),
      ),
    quoteSpeedUp: async (txid) => {
      const w = this.w;
      if (!w?.state.savings) return { ok: false, message: 'Set up Savings first.' };
      try {
        const q = await w.quoteSavingsSpeedUp(txid);
        const ref = `u${++this.quoteCounter}`;
        this.speedUpQuotes.set(ref, q);
        if (this.speedUpQuotes.size > 20) this.speedUpQuotes.delete(this.speedUpQuotes.keys().next().value!);
        const quote: SavingsSpeedUpQuote = {
          ref,
          txid: q.replaces,
          address: q.recipient,
          amountSats: q.amountSats,
          oldFeeSats: q.oldFeeSats,
          feeSats: q.feeSats,
          oldFeeRate: q.oldFeeRate,
          feeRate: q.feeRate,
          extraFeeSats: q.extraFeeSats,
          toSpending: q.toSpending,
          ...(q.signedBy ? { signedBy: q.signedBy } : {}),
        };
        return { ok: true, quote };
      } catch (e) {
        // Reading the transaction goes through the guardian: its refusals and timeouts read as everywhere else.
        return { ok: false, message: mapError(e).message };
      }
    },
    speedUp: (quote, signers) =>
      this.exclusive(() =>
        this.guarded(async () => {
          const w = this.requireWallet();
          const q = quote.ref ? this.speedUpQuotes.get(quote.ref) : undefined;
          if (!q) throw new WalletServiceError('quote_stale', 'This needs a fresh quote. Go back and check it again.');
          const res = await w.speedUpSavingsSpend(q, { signers });
          if (!res.ok) {
            if (res.signedTx) throw broadcastError(res.refusal, 'unlisted');
            throw refusalToError(res.refusal);
          }
          this.refresh();
          return { txid: res.txid, feeSats: res.feeSats, extraFeeSats: res.extraFeeSats };
        }),
      ),
    replaceKey: (lost, opts = {}) =>
      this.exclusive(() =>
        this.guarded(async () => {
          const w = this.requireWallet();
          this.setProgress('Moving Savings to a new Savings wallet');
          try {
            const r = await w.replaceSavingsKey({
              lost,
              ...(opts.recoveryKeyKind ? { recoveryKeyKind: this.secondKind(opts.recoveryKeyKind) } : {}),
              ...(opts.descriptor ? { descriptor: opts.descriptor.trim() } : {}),
            });
            addEvent(this.log, { kind: 'savings-key-replaced', lostKey: lost, at: this.clock.now() });
            await this.saveLogNow();
            return { movedSats: r.movedSats, feeSats: r.feeSats };
          } finally {
            this.setProgress(null);
          }
        }),
      ),
    findOnGuardian: () =>
      this.guarded(async () => {
        const found = await this.requireWallet().findSavingsOnGuardian();
        return found ? { descriptor: found.descriptor } : null;
      }),
    walletMap: () => {
      const sv = this.w?.state.savings;
      if (!sv) return null;
      // The device names as the Savings screens show them; the keys, paths and first address from the descriptor itself.
      const view = this.savingsView();
      const data = savingsMapData({
        descriptor: sv.descriptor,
        network: this.network,
        walletId: sv.walletId,
        createdAt: this.iso(sv.createdAt),
        models: { hardware: view.hardware?.model, recoveryKey: view.recoveryKey?.model },
        // Several wallets: the map says whose Savings it is.
        ...(this.set?.several && this.w ? { walletName: this.set.nameOf(this.w) } : {}),
      });
      return { ...data, ...renderSavingsMap(data, { date: new Date(this.clock.now()) }) };
    },
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
    if (isLimitOffSats(limitSats)) return this.turnLimitOff();
    const before = this.w?.state.rules?.policy.dailyLimitSats ?? 0;
    return this.rulesChange(
      () => this.requireWallet().setDailyLimit(limitSats),
      (r, at) =>
        isLimitOffSats(before)
          ? addEvent(this.log, { kind: 'limit-on', limitSats, at })
          : addEvent(this.log, { kind: 'limit-changed', limitSats, direction: limitSats > before ? 'raised' : 'lowered', approvedOn: r.approvedBy === 'hardware' ? 'hardware' : 'phone', at }),
    );
  }

  turnLimitOff(): Promise<void> {
    return this.rulesChange(
      () => this.requireWallet().turnLimitOff(),
      (_r, at) => addEvent(this.log, { kind: 'limit-off', at }),
    );
  }

  setRecoveryDelay(days: RecoveryDelayDays): Promise<void> {
    return this.rulesChange(
      () => this.requireWallet().setRecoveryDelay(days),
      (r, at) => addEvent(this.log, { kind: 'delay-changed', days, approvedOn: r.approvedBy === 'hardware' ? 'hardware' : 'phone', at }),
    );
  }

  setContactLock(on: boolean): Promise<void> {
    // The wallet refuses it (before anything is signed or sent) where the guardian does not support it.
    return this.rulesChange(
      () => this.requireWallet().setContactLock(on),
      (_r, at) => addEvent(this.log, { kind: on ? 'contact-lock-on' : 'contact-lock-off', at }),
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
    if (!GUARDIAN_NETWORKS.includes(network)) throw new WalletServiceError('network_mismatch', `That backup is for a network Trikey doesn't know ("${network}").`, { network });
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
        await this.networkReady;
        const hit = await this.locate(provider);
        if (!hit) throw new WalletServiceError('backup_not_found', `No Trikey backup for ${this.network} was found.`);
        // The backup says which network it is for. Another one than the phone's only when the person said so.
        const target = opts.switchNetwork ? hit.found.network : this.network;
        if (hit.found.network === target) this.requireMainnetConsent(target);
        if (opts.switchNetwork && hit.found.network !== this.network) await this.switchNetworkTo(hit.found.network);
        this.setProgress('Unlocking your backup');
        try {
          await this.yieldToUi();
          // Every wallet in the backup comes back (and any the guardian lists that the backup is older than).
          const set = await WalletSet.restoreFromBackup(this.walletDeps(), unlock, { name: hit.found.name, cloud: hit.store });
          this.set = set;
          this.log = emptyLog();
          this.attach(set.first);
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

  startRecovery(lostKey: LostKey, opts: { guardian?: GuardianAddress; hardwareKind?: HardwareKind; hardwareModel?: QrModel } = {}): Promise<RecoveryInProgress> {
    const model = hasModel(opts.hardwareKind) && opts.hardwareModel ? opts.hardwareModel : undefined;
    return this.exclusive(() =>
      this.guarded(async () => {
        if (lostKey === 'hardware') {
          const w = this.requireWallet();
          this.setProgress('Starting the recovery: approve with your new hardware wallet');
          try {
            await w.startRecovery({ lostKey: 'hardware', ...(opts.hardwareKind ? { newHardwareKind: toWalletKind(opts.hardwareKind) } : {}), ...(model ? { newHardwareModel: model } : {}) });
          } finally {
            this.setProgress(null);
          }
          return this.toInProgress();
        }
        if (!opts.guardian) throw new WalletServiceError('invalid_input', "Add your guardian's npub and relays first.");
        const w = await this.ensureWallet();
        this.setProgress('Starting the recovery: approve on your hardware wallet');
        try {
          const g = opts.guardian;
          // A wallet hosted on someone else's guardian: the descriptor comes back from its encrypted wallet map.
          if (g.hosted && g.walletId)
            await w.recoverHostedWithHardware({
              code: encodeRecoveryUri({ guardianPubkey: npubToHex(g.npub), relays: g.relays, network: this.network, walletId: g.walletId, hosted: true }),
              mainnetConsent: this.mainnetRiskAccepted,
              ...(opts.hardwareKind ? { hardwareKind: toWalletKind(opts.hardwareKind) } : {}),
              ...(model ? { hardwareModel: model } : {}),
            });
          else await w.recoverWithHardware({ guardian: g, ...(opts.hardwareKind ? { hardwareKind: toWalletKind(opts.hardwareKind) } : {}), ...(model ? { hardwareModel: model } : {}) });
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
    return this.exclusive(() =>
      this.guarded(async () => {
        await this.requireWallet().renewRecoveryAccess();
        // Following the recovery picks up now, not at the next tick.
        void this.requestSync(true);
      }),
    );
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

  setSeveralWallets(on: boolean): void {
    this.prefs.severalWallets = on;
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
    // Every wallet of the phone goes (Settings > Developer): the added ones first, the first one (with the keys) last. The
    // phone lets go of the wallet even when a key would not delete (the wallet clears its state first and reports it after):
    // otherwise it would keep showing a wallet that is gone.
    try {
      if (this.set) {
        for (const o of this.set.list.slice(1)) await o.forget().catch(() => undefined);
        await this.deps.platform.kv.remove(walletKeys(this.storageKey).index).catch(() => undefined);
        await this.set.first.forget();
      } else if (w) await w.forget();
    } finally {
      this.set = undefined;
      this.unsubWallet?.();
      this.w = undefined;
      this.preview = undefined;
      this.log = emptyLog();
      await saveLog(this.deps.platform.kv, this.logKey, this.log).catch(() => undefined);
      this.refresh();
    }
  }
}

/** Opens the real wallet service: reads the phone's storage and opens the wallet there, if there is one. */
export async function createRealWalletService(deps: RealServiceDeps): Promise<RealWalletService> {
  const svc = new Service(deps);
  await svc.init();
  return svc;
}
