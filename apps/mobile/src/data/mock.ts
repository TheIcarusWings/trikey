import { buildRefillSchedule, limitChangeNeedsHardware, quoteSend as quoteSendRule } from './rules';
import type { WalletService } from './service';
import type {
  ActivityItem,
  AmountUnit,
  CloudProvider,
  Contact,
  Guardian,
  GuardianStatus,
  HardwareKind,
  HardwareWallet,
  LostKey,
  PhoneBackup,
  RecoveryDelayDays,
  RecoveryInProgress,
  RecoveryKeyKind,
  RecoveryKeyState,
  Refill,
  Sats,
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
  ledger: { kind: 'ledger', brand: 'Ledger', model: 'Ledger Nano X' },
  trezor: { kind: 'trezor', brand: 'Trezor', model: 'Trezor Safe 7' },
  bitbox02: { kind: 'bitbox02', brand: 'BitBox02', model: 'BitBox02' },
  qr: { kind: 'qr', brand: 'Coldcard', model: 'Coldcard Q' },
};

const MARIA: Contact = { id: 'c-maria', name: 'Maria', npub: 'npub1x7qd0m4zc2gk8w5v9n3ylr6ts0ahe7j4fp8u2xw3mq5ca6vhzk2q8' };
const TOM: Contact = { id: 'c-tom', name: 'Tom', npub: 'npub1m3dz8k4w0c6ylv5n2xr9ts7ahe3j4fp8u2xw3mq5ca6vhz9f9fwa' };

const ADDRESS_MARIA_SHOP = 'bc1q7tuen4r8m2kd5vq3jw6hf9ztc0p7lsx0ah';

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
    pay({
      id: 'tx-2',
      kind: 'received',
      amountSats: 500_000,
      status: 'confirmed',
      at: '2026-10-27T18:30:00',
      txid: txid('b91e03d77a5c'),
    }),
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
    keyKind: 'paper',
    spendingSats: 180_000,
    vaultSats: 4_030_000,
    refillAmountSats: 200_000,
    refills,
    refillsTotal: 8,
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
    onboarded: true,
    mode: 'guardian',
    unit: 'sats',
    theme: 'system',

    hardware: HARDWARE.ledger,
    backup: {
      provider: platform === 'ios' ? 'icloud' : 'google-drive',
      lastBackedUpAt: '2026-10-27T20:00:00',
    },
    guardian: {
      host: 'umbrel',
      status: 'online',
      lastSeenAt: NOW.toISOString(),
      relaysConnected: 3,
      chainData: 'your-node',
      npub: 'npub1g4rd8k3w0c6ylv5n2xr9ts7ahe3j4fp8u2xw3mq5ca6vhz9fd3n8',
      explorerUrl: 'http://umbrel.local:3006',
    },
    recoveryDelayDays: 7,
    dailyLimit: { limitSats: 200_000, usedSats: 20_000, cosignedCount: 1 },
    contacts: [MARIA, TOM],

    balanceSats: 4_210_000,
    receiveAddress: 'bc1qxh7u3m0k9e2r5t8wq4lzj6yd3c0vnp7s2fga8w5ke9h3rj4mt6qy0xl2dn',
    activity: guardianActivity(),

    recovery: null,
    recoveryKey: recoveryKeyState(),
  };
}

function wait(ms: number): Promise<void> {
  return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();
}

export function createMockWalletService(options: MockOptions = {}): WalletService {
  const deviceDelay = options.deviceDelayMs ?? 1200;
  const networkDelay = options.networkDelayMs ?? 500;
  const platform = options.platform ?? 'ios';

  let state = createDemoState(platform);
  let counter = 100;
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

  function nextId(prefix: string): string {
    counter += 1;
    return `${prefix}-${counter}`;
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

    // -- onboarding ---------------------------------------------------
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
    async setUpRules(limitSats: Sats, delayDays: RecoveryDelayDays) {
      await wait(deviceDelay);
      update((s) => ({
        recoveryDelayDays: delayDays,
        dailyLimit: { ...s.dailyLimit, limitSats, usedSats: 0, cosignedCount: 0 },
      }));
    },
    async createBackup(provider: CloudProvider): Promise<PhoneBackup> {
      await wait(networkDelay);
      const backup: PhoneBackup = { provider, lastBackedUpAt: NOW.toISOString() };
      update({ backup });
      return backup;
    },
    finishOnboarding(mode: WalletMode = 'guardian') {
      update({ onboarded: true, mode });
    },

    // -- sending ------------------------------------------------------
    quoteSend: (request) => quoteSendRule(state, request),
    async sendPayment(quote: SendQuote) {
      // Face ID / fingerprint for phone signatures, the device for hardware ones.
      await wait(quote.plan.signer === 'hardware' ? deviceDelay : networkDelay);
      const { request, plan, feeSats, totalSats } = quote;
      const signedBy =
        plan.signer === 'hardware' ? 'phone+hardware' : plan.signer === 'phone' ? 'phone' : 'phone+guardian';
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
      };
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
            cosignedCount: s.dailyLimit.cosignedCount + 1,
          },
        }));
      }
      update((s) => ({ balanceSats: s.balanceSats - totalSats }));
      return tx;
    },

    // -- guardian -----------------------------------------------------
    async unlockGuardian() {
      await wait(deviceDelay);
      update((s) => ({ guardian: { ...s.guardian, status: 'online', lastSeenAt: NOW.toISOString() } }));
    },
    lockGuardian() {
      update((s) => ({ guardian: { ...s.guardian, status: 'locked' } }));
    },
    async replaceGuardian(_pairingCode: string) {
      await wait(deviceDelay);
      update((s) => ({ guardian: { ...s.guardian, status: 'online', lastSeenAt: NOW.toISOString() } }));
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
      update({ recovery: null });
    },

    // -- Recovery Key mode -------------------------------------------
    setRecoveryKeyKind(keyKind: RecoveryKeyKind) {
      update((s) => ({ recoveryKey: { ...s.recoveryKey, keyKind } }));
    },
    async approveRefills(amountSats: Sats) {
      await wait(deviceDelay);
      update((s) => ({
        recoveryKey: {
          ...s.recoveryKey,
          refillAmountSats: amountSats,
          refills: buildRefillSchedule(amountSats, NOW),
          refillsTotal: 8,
        },
      }));
    },

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
      restartOnboarding() {
        update({ onboarded: false, recovery: null });
      },
    },
  };
  return service;
}

