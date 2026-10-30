import { parseScannedCode } from '@trikey/wallet/scan';
import { NODE_RPC_TEXT, WalletServiceError } from './errors';
import { SIMULATED_OPTION, hardwareOptionTable, type UiOs } from './hardware-options';
import { buildRefillSchedule, limitChangeNeedsHardware, quoteSend as quoteSendRule } from './rules';
import { emptyRecoveryKeyState } from './rk-empty';
import { DEMO_FINGERPRINT, createMockRecoveryKey } from './rk-mock';
import { looksLikeSilentPaymentAddress } from './sp-empty';
import { DEMO_HELPER_FEE, DEMO_TAPROOT_OUTPUT, createMockSilentPayments, demoSilentActivity, demoSilentPayments, type MockSilentControl } from './sp-mock';
import type { WalletService } from './service';
import type {
  ActivityItem,
  AmountUnit,
  BackupOptions,
  CloudProvider,
  Contact,
  Guardian,
  GuardianStatus,
  FoundBackup,
  QuoteOutcome,
  SendRequest,
  HardwareKind,
  HardwareWallet,
  LostKey,
  PhoneBackup,
  RecoveryDelayDays,
  RecoveryInProgress,
  RecoveryKeyKind,
  RecoveryKeyState,
  Refill,
  ReplaceGuardianPlan,
  ReplaceStep,
  Sats,
  ScannedCode,
  SecurityEvent,
  SendQuote,
  ThemePreference,
  Transaction,
  WalletMode,
  WalletState,
} from './types';

/**
 * Demo data and a fake wallet behind the `WalletService` interface.
 *
 * Everything the designs in design/screens show is reproduced here: the balance,
 * the daily limit used so far, the activity list, the two alert contacts and the
 * Recovery Key mode vault with its refill schedule. Times are written without a
 * zone, so they read the same on every machine. The clock is frozen at
 * 29 Oct 2026, 15:20 for the same reason.
 */

export interface MockOptions {
  /** Picks the cloud the demo backup lives in, as the designs do (iCloud vs Google Drive). */
  platform?: 'ios' | 'android';
  /** How long fake "approve on your hardware wallet" steps take. */
  deviceDelayMs?: number;
  /** How long fake network steps take. */
  networkDelayMs?: number;
}

const NOW = new Date('2026-10-29T15:20:00');
const RECOVERY_STARTED = '2026-10-29T14:05:00';
const DAY = 24 * 60 * 60 * 1000;

const HARDWARE: Record<HardwareKind, HardwareWallet> = {
  simulated: { kind: 'simulated', brand: 'simulated device', model: 'Simulated device' },
  ledger: { kind: 'ledger', brand: 'Ledger', model: 'Ledger Nano X' },
  trezor: { kind: 'trezor', brand: 'Trezor', model: 'Trezor Safe 7' },
  bitbox02: { kind: 'bitbox02', brand: 'BitBox02', model: 'BitBox02' },
  qr: { kind: 'qr', brand: 'Coldcard', model: 'Coldcard Q' },
};

const MARIA: Contact = { id: 'c-maria', name: 'Maria', npub: 'npub1x7qd0m4zc2gk8w5v9n3ylr6ts0ahe7j4fp8u2xw3mq5ca6vhzk2q8' };
const TOM: Contact = { id: 'c-tom', name: 'Tom', npub: 'npub1m3dz8k4w0c6ylv5n2xr9ts7ahe3j4fp8u2xw3mq5ca6vhz9f9fwa' };

const ADDRESS_MARIA_SHOP = 'tb1q7tuen4r8m2kd5vq3jw6hf9ztc0p7lsx0ah';

function txid(seed: string): string {
  // Not a real hash, just 64 hex characters that look the part.
  const base = '4f2a9c0e7b1d5a3c8e1f6b2d9047a8c3e5f1b6d2a9c8e7f40135e83c51a0d927';
  return seed + base.slice(seed.length);
}

function pay(tx: Transaction): ActivityItem {
  return { type: 'payment', at: tx.at, tx };
}

function security(event: SecurityEvent): ActivityItem {
  return { type: 'security', at: event.at, event };
}

function guardianActivity(): ActivityItem[] {
  return [
    pay({
      id: 'tx-1',
      kind: 'sent',
      amountSats: 12_500,
      feeSats: 380,
      status: 'confirmed',
      at: '2026-10-29T09:42:00',
      address: ADDRESS_MARIA_SHOP,
      txid: txid('4f2a9c0e7b1d'),
      signedBy: 'phone+guardian',
    }),
    security({ id: 'ev-1', kind: 'guardian-restarted', host: 'umbrel', at: '2026-10-29T03:12:00' }),
    ...demoSilentActivity().filter((i) => i.at > '2026-10-28'),
    pay({
      id: 'tx-2',
      kind: 'received',
      amountSats: 500_000,
      status: 'confirmed',
      at: '2026-10-27T18:30:00',
      txid: txid('b91e03d77a5c'),
    }),
    ...demoSilentActivity().filter((i) => i.at <= '2026-10-28' && i.at > '2026-10-22'),
    security({
      id: 'ev-2',
      kind: 'limit-changed',
      limitSats: 200_000,
      direction: 'raised',
      approvedOn: 'hardware',
      at: '2026-10-21T10:15:00',
    }),
    pay({
      id: 'tx-3',
      kind: 'received',
      amountSats: 3_722_500,
      status: 'confirmed',
      at: '2026-10-20T08:05:00',
      txid: txid('07c4d2a81e9f'),
    }),
  ];
}

function recoveryKeyState(): RecoveryKeyState {
  const dates = ['2026-10-08', '2026-10-15', '2026-10-22', '2026-11-01', '2026-11-08', '2026-11-15', '2026-11-22', '2026-11-29'];
  const refills: Refill[] = dates.map((date, i) => ({
    index: i + 1,
    amountSats: 200_000,
    unlocksAt: `${date}T08:00:00`,
    status: i < 3 ? 'received' : 'upcoming',
  }));
  return {
    ...emptyRecoveryKeyState({ keyKind: 'paper' }),
    stage: 'ready',
    savedKey: 'kit',
    fingerprint: DEMO_FINGERPRINT,
    spendingSats: 180_000,
    vaultSats: 4_030_000,
    refillsLeft: 5,
    refillsTotal: 8,
    refillsStatus: 'live',
    needsApproval: false,
    next: { index: 4, amountSats: 200_000, status: 'waiting', etaAt: '2026-11-01T08:00:00', inBlocks: 432 },
    syncedAt: NOW.toISOString(),
    refills,
    activity: [
      pay({
        id: 'rk-tx-1',
        kind: 'sent',
        amountSats: 20_000,
        feeSats: 220,
        status: 'confirmed',
        at: '2026-10-29T11:05:00',
        address: ADDRESS_MARIA_SHOP,
        txid: txid('c3a7119e5d20'),
        signedBy: 'phone',
      }),
      pay({
        id: 'rk-tx-2',
        kind: 'refill',
        amountSats: 200_000,
        status: 'confirmed',
        at: '2026-10-22T08:00:00',
        txid: txid('5d80f6ab42c1'),
        refillIndex: 3,
        signedBy: 'phone+hardware',
      }),
    ],
  };
}

export function createDemoState(platform: 'ios' | 'android' = 'ios'): WalletState {
  return {
    backing: 'demo',
    network: null,
    capabilities: { lockGuardian: true, replaceGuardian: true, recoveryKey: true },
    progress: null,
    devicePrompt: null,
    syncing: false,
    synced: true,
    phoneSpending: 'enabled',
    recoveryOutcome: null,
    recovering: false,
    onboarded: true,
    mode: 'guardian',
    unit: 'sats',
    theme: 'system',

    hardware: HARDWARE.ledger,
    addressVerified: true,
    backup: {
      provider: platform === 'ios' ? 'icloud' : 'google-drive',
      lastBackedUpAt: '2026-10-27T20:00:00',
      unlockedBy: ['passkey'],
    },
    guardian: {
      host: 'umbrel',
      status: 'online',
      lastSeenAt: NOW.toISOString(),
      relays: ['wss://relay.damus.io', 'wss://nos.lol', 'wss://relay.primal.net'],
      relaysConnected: 3,
      chainData: 'your-node',
      npub: 'npub1g4rd8k3w0c6ylv5n2xr9ts7ahe3j4fp8u2xw3mq5ca6vhz9fd3n8',
      explorerUrl: 'http://umbrel.local:3006',
      key3Note: "Your guardian's key was made with randomness from both this phone and your guardian.",
    },
    recoveryDelayDays: 7,
    dailyLimit: { limitSats: 200_000, usedSats: 20_000, cosignedCount: 1 },
    contacts: [MARIA, TOM],

    balanceSats: 4_210_000,
    receiveAddress: 'tb1qxh7u3m0k9e2r5t8wq4lzj6yd3c0vnp7s2fga8w5ke9h3rj4mt6qy0xl2dn',
    activity: guardianActivity(),

    recovery: null,
    recoveryKey: recoveryKeyState(),

    hardwareConfirmRequired: false,
    replace: { plan: null, step: null, pending: null },
    oldWallets: [],
    walletRetired: null,
    finishedRecovery: null,
    silentPayments: demoSilentPayments(),
  };
}

const NEW_GUARDIAN_NPUB = 'npub1n3wg8k4w0c6ylv5n2xr9ts7ahe3j4fp8u2xw3mq5ca6vhz9fd3qx2';

function wait(ms: number): Promise<void> {
  return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();
}

export function createMockWalletService(options: MockOptions = {}): WalletService {
  const deviceDelay = options.deviceDelayMs ?? 1200;
  const networkDelay = options.networkDelayMs ?? 500;
  const platform = options.platform ?? 'ios';

  let state = createDemoState(platform);
  let counter = 100;
  const silentControl: MockSilentControl = { nodeRpc: true };
  const listeners = new Set<() => void>();

  function update(change: Partial<WalletState> | ((s: WalletState) => Partial<WalletState>)) {
    const patch = typeof change === 'function' ? change(state) : change;
    state = { ...state, ...patch };
    listeners.forEach((listener) => listener());
  }

  /** Prepends an item and keeps the lists sorted newest first. */
  function addActivity(item: ActivityItem) {
    const key = state.mode === 'recoveryKey' ? 'recoveryKey' : 'guardian';
    if (key === 'recoveryKey') {
      update((s) => ({ recoveryKey: { ...s.recoveryKey, activity: [item, ...s.recoveryKey.activity] } }));
    } else {
      update((s) => ({ activity: [item, ...s.activity] }));
    }
  }

  function addSecurityEvent(event: SecurityEvent) {
    // Security events belong to the guardian wallet's log only.
    update((s) => ({ activity: [security(event), ...s.activity] }));
  }

  let pendingContacts: Contact[] = [];
  function nextId(prefix: string): string {
    counter += 1;
    return `${prefix}-${counter}`;
  }

  /** A payment's quote. To a silent payment address the helper coin pays its share of the fee, and the vault cannot make one. */
  function quoteSendMock(request: SendRequest): QuoteOutcome {
    const base = quoteSendRule(state, request);
    if (!looksLikeSilentPaymentAddress(request.address) || !base.ok) return base;
    const q = base.quote;
    if (state.mode === 'recoveryKey') {
      if (q.plan.signer === 'hardware')
        return { ok: false, problem: 'other', message: "A silent payment can't come from the vault. Pay it from your spending balance." };
      return { ok: true, quote: { ...q, silentPayment: {} } };
    }
    if (!state.silentPayments.helper.funded)
      return { ok: false, problem: 'needs_helper', message: 'Paying a silent payment address needs the helper coin: a small coin of this phone that you fund first.' };
    return {
      ok: true,
      quote: { ...q, feeSats: q.feeSats + DEMO_HELPER_FEE, silentPayment: { outputAddress: DEMO_TAPROOT_OUTPUT, helperFeeSats: DEMO_HELPER_FEE } },
    };
  }

  const service: WalletService = {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    now: () => NOW,
    async sync() {
      await wait(networkDelay);
    },

    // -- onboarding ---------------------------------------------------
    setNetwork() {},
    async getHardwareOptions() {
      return hardwareOptionTable(platform as UiOs).map((o) => ({ ...o, available: true }));
    },
    async connectHardware(kind: HardwareKind) {
      await wait(deviceDelay);
      const hardware = HARDWARE[kind];
      update({ hardware });
      return hardware;
    },
    async pairGuardian(_pairingCode: string): Promise<Guardian> {
      await wait(networkDelay);
      const guardian: Guardian = { ...state.guardian, status: 'online', lastSeenAt: NOW.toISOString() };
      update({ guardian });
      return guardian;
    },
    setOnboardingContacts(contacts: { name: string; npub: string }[]) {
      for (const c of contacts) if (!/^npub1[02-9ac-hj-np-z]{58}$/.test(c.npub.trim())) throw new WalletServiceError('invalid_input', "That doesn't look like a nostr public key (npub…).");
      pendingContacts = contacts.map((c, i) => ({ id: nextId('c') + `-${i}`, name: c.name.trim(), npub: c.npub.trim() }));
    },
    async setUpRules(limitSats: Sats, delayDays: RecoveryDelayDays) {
      await wait(deviceDelay);
      if (pendingContacts.length) {
        const added = pendingContacts;
        pendingContacts = [];
        update((s) => ({ contacts: [...s.contacts.filter((c) => !added.some((a) => a.npub === c.npub)), ...added] }));
      }
      update((s) => ({
        recoveryDelayDays: delayDays,
        dailyLimit: { ...s.dailyLimit, limitSats, usedSats: 0, cosignedCount: 0 },
      }));
    },
    async getBackupOptions(): Promise<BackupOptions> {
      const label = (provider: CloudProvider, text: string) => ({ provider, label: text, available: true });
      const providers =
        platform === 'ios'
          ? [label('icloud', 'iCloud Drive'), label('google-drive', 'Google Drive'), label('dropbox', 'Dropbox'), label('proton-drive', 'Proton Drive or another app')]
          : [label('google-drive', 'Google Drive'), label('dropbox', 'Dropbox'), label('proton-drive', 'Proton Drive'), label('other', 'Another app')];
      return { providers, passkey: true };
    },
    async createBackup(provider: CloudProvider): Promise<PhoneBackup> {
      await wait(networkDelay);
      const backup: PhoneBackup = { provider, lastBackedUpAt: NOW.toISOString(), unlockedBy: ['passkey'] };
      update({ backup });
      return backup;
    },
    recoveryCode: () => null,
    dismissRecoveryCode() {},
    async exportBackupFile() {
      await wait(networkDelay);
    },
    finishOnboarding(mode: WalletMode = 'guardian') {
      update({ onboarded: true, mode });
    },

    // -- sending ------------------------------------------------------
    quoteSend: (request) => quoteSendMock(request),
    async receiveAddress(opts) {
      if (opts?.verifyOnDevice) await wait(deviceDelay);
      return { address: state.receiveAddress, verifiedOnDevice: !!opts?.verifyOnDevice };
    },
    async sendPayment(quote: SendQuote) {
      // Face ID / fingerprint for phone signatures, the device for hardware ones.
      await wait(quote.plan.signer === 'hardware' ? deviceDelay : networkDelay);
      const { request, plan, feeSats, totalSats } = quote;
      const signedBy =
        plan.signer === 'hardware' ? 'phone+hardware' : plan.signer === 'phone' ? 'phone' : 'phone+guardian';
      const silent = looksLikeSilentPaymentAddress(request.address);
      const tx: Transaction = {
        id: nextId('tx'),
        kind: 'sent',
        amountSats: request.amountSats,
        feeSats,
        status: 'pending',
        at: NOW.toISOString(),
        address: request.address,
        txid: txid((counter * 7919).toString(16).padStart(12, '0')),
        signedBy,
        ...(silent ? { silentOutputAddress: DEMO_TAPROOT_OUTPUT } : {}),
      };
      if (silent && state.mode === 'guardian') update((s) => ({ silentPayments: { ...s.silentPayments, helper: { ...s.silentPayments.helper, sats: Math.max(0, s.silentPayments.helper.sats - DEMO_HELPER_FEE) } } }));
      addActivity({ type: 'payment', at: tx.at, tx });
      if (state.mode === 'recoveryKey') {
        update((s) =>
          plan.signer === 'hardware'
            ? { recoveryKey: { ...s.recoveryKey, vaultSats: s.recoveryKey.vaultSats - totalSats } }
            : { recoveryKey: { ...s.recoveryKey, spendingSats: s.recoveryKey.spendingSats - totalSats } },
        );
      } else if (plan.signer === 'phone+guardian') {
        update((s) => ({
          dailyLimit: {
            ...s.dailyLimit,
            usedSats: s.dailyLimit.usedSats + totalSats,
            cosignedCount: (s.dailyLimit.cosignedCount ?? 0) + 1,
          },
        }));
      }
      update((s) => ({ balanceSats: s.balanceSats - totalSats }));
      return tx;
    },

    // -- guardian -----------------------------------------------------
    async unlockGuardian(passphrase?: string) {
      await wait(deviceDelay);
      // The demo accepts any passphrase except the word "wrong", so the error state can be seen.
      if (passphrase === 'wrong') throw new WalletServiceError('unlock_failed', "That passphrase didn't work. Try again.");
      update((s) => ({ guardian: { ...s.guardian, status: 'online', lastSeenAt: NOW.toISOString() } }));
    },
    async lockGuardian() {
      await wait(networkDelay);
      update((s) => ({ guardian: { ...s.guardian, status: 'locked' } }));
      addSecurityEvent({ id: nextId('ev'), kind: 'guardian-locked', host: state.guardian.host, byPhone: true, at: NOW.toISOString() });
    },
    async previewReplaceGuardian(code: string): Promise<ReplaceGuardianPlan> {
      await wait(networkDelay);
      const scanned = service.readCode(code);
      if (scanned.kind !== 'pairing') throw new WalletServiceError('pairing_invalid', scanned.kind === 'unknown' ? scanned.reason : "That isn't a guardian's pairing code.");
      const reachable = state.guardian.status !== 'offline';
      const plan: ReplaceGuardianPlan = {
        newGuardian: { label: 'Start9', host: 'start9', npub: NEW_GUARDIAN_NPUB },
        oldGuardianReachable: reachable,
        movingSats: state.balanceSats,
        coins: 3,
        feeSats: 1_200,
        steps: [
          { step: 'pair', text: "Pair the new guardian (Start9) with a new wallet of this phone, your hardware wallet and the new guardian's key." },
          { step: 'sign', text: 'Approve on your hardware wallet: register the new wallet, check its first address, and sign the move of all your money (3 coins).' },
          {
            step: 'broadcast',
            text: reachable ? 'Send the move to the Bitcoin network through your old guardian.' : 'Send the move to the Bitcoin network. Your old guardian is offline, so this may have to wait until something can send it.',
          },
          {
            step: 'retire',
            text: reachable
              ? 'Retire the old wallet on the old guardian, so it co-signs nothing for it any more (one more approval on the hardware wallet).'
              : "Skip retiring the old wallet on the old guardian, since it can't be reached. Its key alone can't move anything.",
          },
          { step: 'switch', text: 'Switch this phone to the new wallet and guardian. The old wallet stays watched for coins sent to it later.' },
        ],
      };
      update((s) => ({ replace: { ...s.replace, plan } }));
      return plan;
    },
    async replaceGuardian(opts = {}) {
      const plan = state.replace.plan;
      if (!plan) throw new WalletServiceError('wrong_state', "Scan the new guardian's pairing code first.");
      if (!plan.oldGuardianReachable && !opts.oldGuardianGone)
        throw new WalletServiceError('guardian_unreachable', "Your old guardian isn't answering. If it is gone for good, confirm that, and the move goes ahead without it.");
      const texts: Record<ReplaceStep, string> = {
        pair: 'Pairing the new guardian: approve on your hardware wallet',
        sign: 'Signing the move: approve on your hardware wallet',
        broadcast: 'Sending the move to the network',
        retire: 'Retiring the old wallet on the old guardian: approve on your hardware wallet',
        switch: 'Switching to the new wallet',
      };
      for (const step of ['pair', 'sign', 'broadcast', 'retire', 'switch'] as ReplaceStep[]) {
        if (step === 'retire' && !plan.oldGuardianReachable) continue;
        update((s) => ({ progress: texts[step], replace: { ...s.replace, step } }));
        await wait(step === 'broadcast' || step === 'switch' ? networkDelay : deviceDelay);
      }
      const movedSats = state.balanceSats - plan.feeSats;
      update((s) => ({
        progress: null,
        replace: { plan: null, step: null, pending: null },
        guardian: { ...s.guardian, host: 'start9', label: 'Start9', npub: NEW_GUARDIAN_NPUB, status: 'online', lastSeenAt: NOW.toISOString() },
        balanceSats: movedSats,
        dailyLimit: { ...s.dailyLimit, usedSats: 0, cosignedCount: 0 },
        oldWallets: [...s.oldWallets, { id: 'demo-old-wallet', host: s.guardian.host, retiredOnGuardian: plan.oldGuardianReachable }],
      }));
      addSecurityEvent({ id: nextId('ev'), kind: 'guardian-replaced', host: 'start9', movedSats, at: NOW.toISOString() });
      return { status: 'done' as const, movedSats, oldWalletRetired: plan.oldGuardianReachable };
    },
    async cancelReplaceGuardian() {
      update((s) => ({ replace: { ...s.replace, plan: null } }));
    },
    async sweepOldWallets() {
      await wait(networkDelay);
      return { movedSats: 0 };
    },
    async retireOldWallet() {
      await wait(deviceDelay);
      update((s) => ({ oldWallets: s.oldWallets.map((w) => ({ ...w, retiredOnGuardian: true })) }));
    },
    async confirmHardware() {
      await wait(deviceDelay);
      update({ hardwareConfirmRequired: false, addressVerified: true });
      addSecurityEvent({ id: nextId('ev'), kind: 'hardware-confirmed', at: NOW.toISOString() });
    },
    readCode(text: string): ScannedCode {
      // The demo camera "scans" a placeholder pairing code.
      if (text === 'demo-pairing-code') return { kind: 'pairing', uri: text, guardianNpub: NEW_GUARDIAN_NPUB, relays: ['wss://relay.damus.io'], label: 'Start9', expiresAt: NOW.getTime() / 1000 + 300 };
      return parseScannedCode(text, { now: Math.floor(NOW.getTime() / 1000) });
    },

    // -- rules --------------------------------------------------------
    async setDailyLimit(limitSats: Sats) {
      const needsHardware = limitChangeNeedsHardware(state.dailyLimit.limitSats, limitSats);
      await wait(needsHardware ? deviceDelay : networkDelay);
      const direction = needsHardware ? 'raised' : 'lowered';
      update((s) => ({ dailyLimit: { ...s.dailyLimit, limitSats } }));
      addSecurityEvent({
        id: nextId('ev'),
        kind: 'limit-changed',
        limitSats,
        direction,
        approvedOn: needsHardware ? 'hardware' : 'phone',
        at: NOW.toISOString(),
      });
    },
    async setRecoveryDelay(days: RecoveryDelayDays) {
      await wait(days < state.recoveryDelayDays ? deviceDelay : networkDelay);
      update({ recoveryDelayDays: days });
      addSecurityEvent({ id: nextId('ev'), kind: 'delay-changed', days, at: NOW.toISOString() });
    },
    async addContact(name: string, npub: string) {
      await wait(deviceDelay);
      const contact: Contact = { id: nextId('c'), name: name.trim(), npub: npub.trim() };
      update((s) => ({ contacts: [...s.contacts, contact] }));
      addSecurityEvent({ id: nextId('ev'), kind: 'contact-added', name: contact.name, at: NOW.toISOString() });
      return contact;
    },
    async removeContact(id: string) {
      await wait(deviceDelay);
      const removed = state.contacts.find((c) => c.id === id);
      update((s) => ({ contacts: s.contacts.filter((c) => c.id !== id) }));
      if (removed) {
        addSecurityEvent({ id: nextId('ev'), kind: 'contact-removed', name: removed.name, at: NOW.toISOString() });
      }
    },

    // -- recovery -----------------------------------------------------
    async findBackup(): Promise<FoundBackup | null> {
      await wait(networkDelay);
      return { provider: platform === 'ios' ? 'icloud' : 'google-drive', createdAt: '2026-10-27T20:00:00', unlockedBy: ['passkey', 'recovery-code'] };
    },
    async importBackupFile(): Promise<FoundBackup | null> {
      await wait(networkDelay);
      return { provider: 'file', createdAt: '2026-10-27T20:00:00', unlockedBy: ['recovery-code'] };
    },
    async restoreFromBackup() {
      await wait(networkDelay);
      update({ onboarded: true, mode: 'guardian' });
    },
    async recoverWithKit() {
      await wait(deviceDelay);
      const movedSats = 4_208_800;
      update({ onboarded: true, balanceSats: movedSats });
      return { movedSats };
    },
    async startRecovery(lostKey: LostKey) {
      await wait(networkDelay);
      const recovery: RecoveryInProgress = {
        id: nextId('rec'),
        startedAt: RECOVERY_STARTED,
        completesAt: new Date(new Date(RECOVERY_STARTED).getTime() + state.recoveryDelayDays * DAY).toISOString(),
        origin: 'this-phone',
        lostKey,
        alertRecipients: ['Your old phone', ...state.contacts.map((c) => c.name)],
        acknowledged: true,
        movingSats: state.balanceSats,
      };
      update({ recovery });
      return recovery;
    },
    acknowledgeRecovery() {
      update((s) => (s.recovery ? { recovery: { ...s.recovery, acknowledged: true } } : {}));
    },
    async cancelRecovery() {
      await wait(networkDelay);
      update({ recovery: null, phoneSpending: 'enabled' });
    },
    async resumePhoneSpending() {
      await wait(deviceDelay);
      update({ phoneSpending: 'enabled' });
    },
    async renewRecoveryAccess() {
      await wait(deviceDelay);
    },
    cancelDevicePrompt() {},

    // -- Recovery Key mode -------------------------------------------
    setRecoveryKeyKind(keyKind: RecoveryKeyKind) {
      update((s) => ({ recoveryKey: { ...s.recoveryKey, keyKind } }));
    },
    rk: createMockRecoveryKey({ get: () => state, update, wait, deviceDelay, networkDelay, now: NOW }),
    silentPayments: createMockSilentPayments({ get: () => state, update, wait, deviceDelay, networkDelay, now: NOW }, silentControl, nextId),

    // -- preferences --------------------------------------------------
    setUnit: (unit: AmountUnit) => update({ unit }),
    setTheme: (theme: ThemePreference) => update({ theme }),
    setMode: (mode: WalletMode) => update({ mode }),

    // -- development --------------------------------------------------
    dev: {
      setGuardianStatus(status: GuardianStatus) {
        update((s) => ({ guardian: { ...s.guardian, status } }));
        if (status === 'locked') {
          addSecurityEvent({ id: nextId('ev'), kind: 'guardian-locked', host: state.guardian.host, at: NOW.toISOString() });
        }
      },
      finishRecovery() {
        // The guardian co-signs the move and takes the new wallet over: the phone switches to it, and the hardware wallet confirms it once.
        const r = state.recovery;
        if (!r) return;
        update((s) => ({
          recovery: null,
          recoveryOutcome: 'finished',
          finishedRecovery: { lostKey: r.lostKey, movedSats: r.movingSats - 1_200 },
          recovering: false,
          onboarded: true,
          hardwareConfirmRequired: true,
          addressVerified: false,
          phoneSpending: 'enabled',
          balanceSats: r.movingSats - 1_200,
          dailyLimit: { ...s.dailyLimit, usedSats: 0, cosignedCount: 0 },
        }));
        addSecurityEvent({ id: nextId('ev'), kind: 'recovery-finished', movedSats: r.movingSats - 1_200, at: NOW.toISOString() });
      },
      simulateRecoveryFromElsewhere() {
        update((s) => ({
          recovery: {
            id: nextId('rec'),
            startedAt: RECOVERY_STARTED,
            completesAt: new Date(new Date(RECOVERY_STARTED).getTime() + s.recoveryDelayDays * DAY).toISOString(),
            origin: 'someone-else',
            lostKey: 'phone',
            alertRecipients: ['This phone', ...s.contacts.map((c) => c.name)],
            acknowledged: false,
            movingSats: s.balanceSats,
          },
        }));
      },
      simulateRecoveryKeyAlerts() {
        update((s) => ({
          recoveryKey: {
            ...s.recoveryKey,
            notices: [
              { id: 'unexpected_broadcast:demo', kind: 'unexpected_broadcast', at: NOW.toISOString(), index: 4, txid: txid('9f3a61c0d7e2') },
              { id: 'foreign_vault_spend:demo', kind: 'foreign_vault_spend', at: NOW.toISOString(), txid: txid('2be84d5a90c1') },
            ],
            speedUp: { index: 4, txid: txid('9f3a61c0d7e2'), feeSats: 1_850, targetRate: 22, currentRate: 4.2 },
          },
        }));
      },
      restartOnboarding() {
        update({ onboarded: false, recovery: null });
      },
      /** The demo's guardian has (or has not) its node's RPC: without it receiving silent payments is paused (1700). */
      setNodeRpc(available: boolean) {
        silentControl.nodeRpc = available;
        update((s) => ({
          silentPayments: s.silentPayments.receiving
            ? {
                ...s.silentPayments,
                scan: available
                  ? { state: 'ok', source: 'guardian', scannedHeight: 4_812_203, tipHeight: 4_812_203, checkedAt: NOW.toISOString(), ...(s.silentPayments.scan.lastMatchAt ? { lastMatchAt: s.silentPayments.scan.lastMatchAt } : {}) }
                  : { state: 'needs_node_rpc', source: 'guardian', scannedHeight: s.silentPayments.scan.scannedHeight, checkedAt: NOW.toISOString(), message: NODE_RPC_TEXT },
              }
            : s.silentPayments,
        }));
      },
      /** The demo's helper coin: funded, or not yet (to look at the "Fund the helper" screens). */
      setHelperFunded(funded: boolean) {
        update((s) => ({ silentPayments: { ...s.silentPayments, helper: { ...s.silentPayments.helper, sats: funded ? 24_320 : 0, funded } } }));
      },
    },
  };
  return service;
}

