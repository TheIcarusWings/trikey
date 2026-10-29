import { ApiError, type GuardianApi } from './client';
import { RESET_CONFIRMATION } from './types';
import type {
  ActivityEntry,
  FamilyInvite,
  GuardianStatus,
  HostedWallet,
  PairedPhone,
  PairingSession,
  RecoveryInProgress,
  RelayOption,
  Rules,
} from './types';

/**
 * In-memory guardian with demo data matching design/screens/Guardian-*.
 *
 * Pick the starting point with `?mock=<scenario>` in the URL:
 *   (none)     unlocked, one phone paired, a week of activity
 *   firstrun   brand-new box: setup wizard first
 *   locked     the box just restarted
 *   recovery   a Delay & Notify recovery is running
 *   unpaired   set up, but no phone paired yet
 *   syncing    unlocked while the node is still catching up, one relay down
 *   signedout  set up and locked, this browser not signed in yet (the sign-in screen)
 *
 * State lives in memory only, so a page reload starts the scenario over. In the
 * mock, any unlock passphrase works except the literal `wrong`, which is
 * rejected so the error state can be tried. Passphrases are never kept.
 */
export type MockScenario = 'default' | 'firstrun' | 'locked' | 'recovery' | 'unpaired' | 'syncing' | 'signedout';

const LATENCY_MS = 120;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

const DEMO_NPUB = 'npub1m4r1ac0d3guardian7x2p9k5v8q6w3t0y4h8s2n5e7u9a1z3c6f0kxq4d2l';
const RELAYS: RelayOption[] = [
  { url: 'wss://relay.damus.io', defaultSelected: true },
  { url: 'wss://nos.lol', defaultSelected: true },
  { url: 'ws://nostr-relay_server_1:4848', label: 'Nostr Relay app on this Umbrel', defaultSelected: true },
];

const wait = (ms = LATENCY_MS) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const clone = <T>(value: T): T => structuredClone(value);

/** A local time of day `daysAgo` days back, as an ISO string. */
function localAt(daysAgo: number, hhmm: string): string {
  const [h, m] = hhmm.split(':').map(Number);
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  d.setHours(h ?? 0, m ?? 0, 0, 0);
  return d.toISOString();
}

function randomCode(length: number): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('');
}

function demoActivity(): ActivityEntry[] {
  return [
    {
      id: 'a7', at: localAt(0, '14:20'), kind: 'payment', event: 'Payment to bc1q9d4x…7kmr',
      summary: 'Phone payment', signedBy: 'Phone', sats: 50_420, result: 'co-signed',
    },
    {
      id: 'a6', at: localAt(0, '09:42'), kind: 'payment', event: 'Payment to bc1q7tue…x0ah',
      summary: 'Phone payment', signedBy: 'Phone', sats: 20_000, result: 'co-signed',
    },
    {
      id: 'a5', at: localAt(0, '09:01'), kind: 'system', event: 'Guardian unlocked',
      summary: 'Unlocked with Ledger', signedBy: 'Ledger', sats: null, result: 'ok',
    },
    {
      id: 'a4', at: localAt(0, '03:12'), kind: 'system', event: 'Box restarted, guardian locked',
      signedBy: null, sats: null, result: 'locked',
    },
    {
      id: 'a3', at: localAt(1, '18:30'), kind: 'payment', event: 'Payment over the daily limit',
      summary: 'Phone payment over the limit', signedBy: 'Phone', sats: 450_000, result: 'refused',
    },
    {
      id: 'a2', at: localAt(8, '10:05'), kind: 'rules', event: 'Daily limit 100,000 → 200,000',
      signedBy: 'Ledger', sats: null, result: 'rule-changed',
    },
    {
      id: 'a1', at: localAt(9, '16:44'), kind: 'system', event: 'Phone paired, wallet created',
      signedBy: 'Ledger', sats: null, result: 'ok',
    },
  ];
}

function demoRecovery(): RecoveryInProgress {
  const endsAt = Date.now() + 5 * DAY + 14 * HOUR;
  const startedAt = endsAt - 7 * DAY;
  const sent = [startedAt, startedAt + DAY].filter((t) => t <= Date.now()).map((t) => new Date(t).toISOString());
  return {
    id: '1-3f2a9c41d07e',
    state: 'pending',
    startedAt: new Date(startedAt).toISOString(),
    endsAt: new Date(endsAt).toISOString(),
    lostKey: 'phone',
    survivingKey: { device: 'Ledger', signatureValid: true },
    destination: 'bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh',
    destinationWalletId: '9c1d40e2b7a35f68',
    sweepSats: 4_208_800,
    feeSats: 1_200,
    feeCapSats: 42_088,
    alertsSent: ['Paired phone', 'Maria', 'Tom'].map((recipient) => ({ recipient, sentAt: sent })),
  };
}

export function readScenario(search: string): MockScenario {
  const value = new URLSearchParams(search).get('mock');
  const known: MockScenario[] = ['firstrun', 'locked', 'recovery', 'unpaired', 'syncing', 'signedout'];
  return known.find((s) => s === value) ?? 'default';
}

export function createMockApi(scenario: MockScenario = 'default'): GuardianApi {
  const setupDone = scenario !== 'firstrun';
  let locked = scenario === 'locked' || scenario === 'signedout';
  let lockedAt: string | undefined = locked ? localAt(0, '03:12') : undefined;
  let lockReason: 'restart' | 'manual' | 'remote' | undefined = locked ? 'restart' : undefined;
  let phones: PairedPhone[] =
    scenario === 'unpaired' || scenario === 'firstrun'
      ? []
      : [{ id: 'ph_1', name: 'Pixel 8', pairedAt: localAt(9, '16:44') }];
  let activity: ActivityEntry[] = setupDone ? demoActivity() : [];
  let recovery: RecoveryInProgress | null = scenario === 'recovery' ? demoRecovery() : null;
  let walletIds = scenario === 'unpaired' || scenario === 'firstrun' ? [] : ['3a7f09c2d41e8b65'];
  let pairing: PairingSession | null = null;
  let relayUrls = RELAYS.map((r) => r.url);
  const syncing = scenario === 'syncing';
  let setupFinished = false;
  // `?mock=signedout`: the browser has no session yet (the sign-in screen first).
  let signedIn = scenario !== 'signedout';

  const rules: Rules = {
    walletName: 'Main',
    dailyLimitSats: 200_000,
    recoveryDelayDays: 7,
    contacts: [
      { id: 'c_phone', name: 'Paired phone', kind: 'paired-phone' },
      { id: 'c_maria', name: 'Maria', kind: 'contact' },
      { id: 'c_tom', name: 'Tom', kind: 'contact' },
    ],
    sweepFeeCapSats: 20_000,
    hardwarePayments: 'any-amount',
  };

  let hostedWallets: HostedWallet[] = [
    {
      id: 'hw_ana', name: 'Ana', state: 'active', since: localAt(47, '12:00'),
      recoveryDelayDays: 7, paymentsThisWeek: 2,
    },
    { id: 'hw_dad', name: 'Dad', state: 'invited', inviteId: 'inv_dad' },
  ];
  let invites: FamilyInvite[] = [
    {
      id: 'inv_dad', name: 'Dad', status: 'pending',
      link: `trikey:invite?g=${DEMO_NPUB}&c=7Q2K`,
      createdAt: new Date(Date.now() - HOUR).toISOString(),
      expiresAt: new Date(Date.now() + 23 * HOUR).toISOString(),
    },
  ];

  const pushActivity = (entry: Omit<ActivityEntry, 'id' | 'at'>) => {
    activity = [{ ...entry, id: `a${Date.now()}${activity.length}`, at: new Date().toISOString() }, ...activity];
  };

  const status = (): GuardianStatus => {
    const relays = RELAYS.map((r, i) => ({
      url: r.url,
      label: r.label,
      connected: relayUrls.includes(r.url) && !(syncing && i === 1),
    }));
    return {
      setupComplete: setupDone || setupFinished,
      state: locked ? 'locked' : 'unlocked',
      lockedAt: locked ? lockedAt : undefined,
      lockReason: locked ? lockReason : undefined,
      relays: relays.filter((r) => relayUrls.includes(r.url)),
      chain: syncing
        ? { state: 'syncing', progress: 0.87, source: 'Bitcoin Node + Electrs' }
        : { state: 'synced', source: 'Bitcoin Node + Electrs' },
      wallets: setupDone || setupFinished ? walletIds.map((id) => ({ id, name: 'Main', phonesPaired: phones.length })) : [],
      dailySpend: { usedSats: 70_420, limitSats: rules.dailyLimitSats },
      recoveryInProgress: recovery !== null,
    };
  };

  const api: GuardianApi = {
    async getStatus() {
      await wait();
      if (!signedIn && (setupDone || setupFinished)) return { authenticated: false, setupComplete: true, state: locked ? 'locked' : 'unlocked', network: 'bitcoin' };
      return status();
    },

    async signIn(input) {
      await wait(300);
      if (input.passphrase === 'wrong') throw new ApiError('bad_passphrase', 'That passphrase is not right.', 401);
      signedIn = true;
      if (input.unlock && locked) {
        locked = false;
        lockedAt = undefined;
        lockReason = undefined;
      }
      return status();
    },

    async signOut() {
      await wait();
      signedIn = false;
      return { authenticated: false, setupComplete: setupDone || setupFinished, state: locked ? 'locked' : 'unlocked', network: 'bitcoin' };
    },

    async getSetupPreflight() {
      await wait();
      return { node: 'found', electrs: 'found', synced: true, relayOptions: clone(RELAYS) };
    },

    async completeSetup(input) {
      await wait(400);
      if (input.relays.length === 0) throw new ApiError('invalid', 'Choose at least one relay.', 400);
      relayUrls = input.relays;
      setupFinished = true;
      locked = false;
      pushActivity({ kind: 'system', event: 'Guardian created', signedBy: null, sats: null, result: 'ok' });
      return status();
    },

    async unlock(input) {
      await wait(300);
      if (input.passphrase === 'wrong') {
        throw new ApiError('bad_passphrase', 'That passphrase is not right.', 401);
      }
      locked = false;
      lockedAt = undefined;
      lockReason = undefined;
      pushActivity({
        kind: 'system', event: 'Guardian unlocked', summary: 'Unlocked with passphrase',
        signedBy: 'Passphrase', sats: null, result: 'ok',
      });
      return status();
    },

    async lock() {
      await wait();
      locked = true;
      lockedAt = new Date().toISOString();
      lockReason = 'manual';
      pushActivity({ kind: 'system', event: 'Guardian locked from the web UI', signedBy: null, sats: null, result: 'locked' });
      return status();
    },

    async listActivity(query) {
      await wait();
      return clone(activity.slice(0, query?.limit ?? 100));
    },

    async getRules() {
      await wait();
      return clone(rules);
    },

    async getRecovery() {
      await wait();
      return clone(recovery);
    },

    async getRecoveryCode() {
      await wait();
      const walletId = walletIds[0];
      if (!walletId) throw new ApiError('not_found', 'Pair a wallet first: the recovery code is for the wallet this guardian protects.', 404);
      const params = new URLSearchParams();
      params.set('v', '1');
      params.set('npub', DEMO_NPUB);
      for (const url of relayUrls) params.append('relay', url);
      params.set('net', 'bitcoin');
      return { uri: `trikey://recover?${params.toString()}`, npub: DEMO_NPUB, relays: [...relayUrls], network: 'bitcoin', walletId };
    },

    async resetGuardian(input) {
      await wait(400);
      if (input.confirm !== RESET_CONFIRMATION) throw new ApiError('invalid', `Type ${RESET_CONFIRMATION} to confirm.`, 400);
      if (input.passphrase === 'wrong') throw new ApiError('bad_passphrase', 'That passphrase is not right.', 401);
      if (recovery) throw new ApiError('recovery_pending', `Recovery ${recovery.id} is running. It must be cancelled or completed before the guardian can be reset.`, 409);
      walletIds = [];
      phones = [];
      recovery = null;
      locked = false;
      lockedAt = undefined;
      lockReason = undefined;
      activity = [];
      pushActivity({ kind: 'system', event: 'Guardian reset on this box: a new key 3 was created and the old one destroyed', signedBy: null, sats: null, result: 'ok' });
      return status();
    },

    async startPairing() {
      await wait();
      const params = new URLSearchParams();
      params.set('g', DEMO_NPUB);
      for (const url of relayUrls) params.append('r', url);
      params.set('c', randomCode(8));
      pairing = {
        id: `pair_${randomCode(6)}`,
        uri: `trikey:pair?${params.toString()}`,
        expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
        status: 'waiting',
      };
      return clone(pairing);
    },

    async getPairingSession(id) {
      await wait(60);
      if (!pairing || pairing.id !== id) throw new ApiError('not_found', 'No such pairing session.', 404);
      if (pairing.status === 'waiting' && Date.parse(pairing.expiresAt) <= Date.now()) {
        pairing = { ...pairing, status: 'expired' };
      }
      return clone(pairing);
    },

    async listPairedPhones() {
      await wait();
      return clone(phones);
    },

    async getHosting() {
      await wait();
      const pending = invites.filter((i) => i.status === 'pending' && Date.parse(i.expiresAt) > Date.now());
      return { wallets: clone(hostedWallets), pendingInvite: clone(pending.at(-1) ?? null) };
    },

    async createFamilyInvite({ name }) {
      await wait(300);
      const trimmed = name.trim();
      if (!trimmed) throw new ApiError('invalid', 'Add a name so you can tell invites apart.', 400);
      const invite: FamilyInvite = {
        id: `inv_${randomCode(6)}`,
        name: trimmed,
        status: 'pending',
        link: `trikey:invite?g=${DEMO_NPUB}&c=${randomCode(4)}`,
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 24 * HOUR).toISOString(),
      };
      invites = [...invites, invite];
      hostedWallets = [...hostedWallets, { id: `hw_${invite.id}`, name: trimmed, state: 'invited', inviteId: invite.id }];
      return clone(invite);
    },

    async cancelFamilyInvite(id) {
      await wait();
      invites = invites.map((i) => (i.id === id ? { ...i, status: 'cancelled' } : i));
      hostedWallets = hostedWallets.filter((w) => w.inviteId !== id);
    },
  };

  if (import.meta.env.DEV && typeof window !== 'undefined') {
    // Dev helper: pretend a phone scanned the current pairing code.
    (window as unknown as Record<string, unknown>).trikeyMock = {
      completePairing() {
        if (!pairing || pairing.status !== 'waiting') return false;
        pairing = { ...pairing, status: 'paired' };
        phones = [...phones, { id: `ph_${phones.length + 1}`, name: 'Pixel 8', pairedAt: new Date().toISOString() }];
        pushActivity({ kind: 'system', event: 'Phone paired', signedBy: 'Phone', sats: null, result: 'ok' });
        return true;
      },
    };
  }

  return api;
}
