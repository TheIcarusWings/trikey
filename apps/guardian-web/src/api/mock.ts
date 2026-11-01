import { browserRandomBytes } from '../lib/random';
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
  RelaySettings,
  RetiringRelay,
  Rules,
} from './types';
import { relayListError } from '../lib/relays';

/**
 * In-memory guardian with demo data matching design/screens/Guardian-*.
 *
 * Pick the starting point with `?mock=<scenario>` in the URL:
 *   (none)     unlocked, one phone paired, a week of activity
 *   firstrun   brand-new box: setup wizard first
 *   locked     the box just restarted
 *   recovery   a Delay & Notify recovery is running
 *   recoveryready  the recovery's waiting period is over and the guardian has not completed it yet
 *   unpaired   set up, but no phone paired yet
 *   syncing    unlocked while the node is still catching up, one relay down
 *   signedout  set up and locked, this browser not signed in yet (the sign-in screen)
 *   oldrelays  two old relays from a change months ago, still watched; the phone switched
 *   limitoff   the owner turned the daily limit off with the hardware wallet yesterday
 *   contactlocked  the owner lets the alert contacts lock the guardian, and one of them just did (LOCK over nostr)
 *   savings    the phone has a Savings wallet this guardian watches; some of it moved yesterday
 *
 * State lives in memory only, so a page reload starts the scenario over. In the
 * mock, any unlock passphrase works except the literal `wrong`, which is
 * rejected so the error state can be tried. Passphrases are never kept.
 */
export type MockScenario =
  | 'default'
  | 'firstrun'
  | 'locked'
  | 'recovery'
  | 'recoveryready'
  | 'unpaired'
  | 'syncing'
  | 'signedout'
  | 'oldrelays'
  | 'limitoff'
  | 'contactlocked'
  | 'savings';

/** A throwaway demo contact key (`1b` × 32), as the guardian names a contact: its npub. */
const DEMO_CONTACT_NPUB = 'npub1rvd3kxcmrvd3kxcmrvd3kxcmrvd3kxcmrvd3kxcmrvd3kxcmrvdsca5nvq';

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
  const bytes = browserRandomBytes(length);
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

function demoRecovery(ready = false): RecoveryInProgress {
  const endsAt = ready ? Date.now() - 2 * HOUR : Date.now() + 5 * DAY + 14 * HOUR;
  const startedAt = endsAt - 7 * DAY;
  const sent = [startedAt, startedAt + DAY].filter((t) => t <= Date.now()).map((t) => new Date(t).toISOString());
  return {
    id: '1-3f2a9c41d07e',
    state: ready ? 'ready' : 'pending',
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
    ...(ready ? { waitingFor: 'The Bitcoin Node is still catching up: the guardian completes the move once the chain is past the end of the waiting period.' } : {}),
  };
}

export function readScenario(search: string): MockScenario {
  const value = new URLSearchParams(search).get('mock');
  const known: MockScenario[] = ['firstrun', 'locked', 'recovery', 'recoveryready', 'unpaired', 'syncing', 'signedout', 'oldrelays', 'limitoff', 'contactlocked', 'savings'];
  return known.find((s) => s === value) ?? 'default';
}

export function createMockApi(scenario: MockScenario = 'default'): GuardianApi {
  const setupDone = scenario !== 'firstrun';
  const contactLocked = scenario === 'contactlocked';
  let locked = scenario === 'locked' || scenario === 'signedout' || contactLocked;
  let lockedAt: string | undefined = locked ? localAt(0, '03:12') : undefined;
  let lockReason: 'restart' | 'manual' | 'remote' | 'contact' | undefined = locked ? (contactLocked ? 'contact' : 'restart') : undefined;
  let lockedBy: string | undefined = contactLocked ? DEMO_CONTACT_NPUB : undefined;
  let phones: PairedPhone[] =
    scenario === 'unpaired' || scenario === 'firstrun'
      ? []
      : [{ id: 'ph_1', name: 'Pixel 8', pairedAt: localAt(9, '16:44') }];
  let activity: ActivityEntry[] = setupDone ? demoActivity() : [];
  // `?mock=limitoff`: turned off yesterday, with the alert the guardian sent about it (apps/guardian/src/http/activity.ts).
  const limitOff = scenario === 'limitoff';
  if (limitOff)
    activity = [
      ...activity.filter((a) => a.at > localAt(0, '00:00')),
      {
        id: 'a_off_alert', at: localAt(1, '20:16'), kind: 'rules', event: '"Daily limit turned off" alert sent to 3 recipients',
        summary: 'Limit-off alert sent', signedBy: null, sats: null, result: 'ok',
      },
      {
        id: 'a_off', at: localAt(1, '20:15'), kind: 'rules',
        event: 'Daily limit turned off (hardware approval #12): the phone and this guardian together can now send everything',
        summary: 'Daily limit turned off', signedBy: 'Hardware wallet', sats: null, result: 'rule-changed',
      },
      ...activity.filter((a) => a.at <= localAt(0, '00:00')),
    ];
  // `?mock=contactlocked`: an alert contact sent LOCK this morning (apps/guardian/src/http/activity.ts words).
  if (contactLocked)
    activity = [
      {
        id: 'a_lock_alert', at: localAt(0, '03:13'), kind: 'system', event: '"Locked by an alert contact" alert sent to 2 recipients',
        summary: 'Lock alert sent', signedBy: null, sats: null, result: 'ok',
      },
      {
        id: 'a_lock', at: localAt(0, '03:12'), kind: 'system',
        event: `Locked by alert contact ${DEMO_CONTACT_NPUB} via nostr (a LOCK message): nothing is co-signed until you unlock it. The phone and the other alert contacts are told.`,
        summary: 'Locked by contact npub1rvd3kxc…ca5nvq via nostr', signedBy: 'Alert contact', sats: null, result: 'locked',
      },
      ...activity,
    ];
  // `?mock=savings`: the phone's Savings wallet, watched; 0.02 BTC of it moved to the Spending wallet yesterday
  // (apps/guardian/src/http/activity.ts words).
  const savingsScenario = scenario === 'savings';
  const SAVINGS_ID = '5a71e3c09b2d4f86';
  const SAVINGS_TX = '9b2d4f86e1c05a71'.padEnd(64, 'c');
  if (savingsScenario)
    activity = [
      {
        id: 'a_sv_alert', at: localAt(1, '18:41'), kind: 'system', event: '"Savings moved" alert sent to 3 recipients',
        summary: 'Savings alert sent', signedBy: null, sats: null, result: 'ok',
      },
      {
        id: 'a_sv_moved', at: localAt(1, '18:40'), kind: 'system',
        event: `Savings moved: 2,000,640 sats left the Savings wallet ${SAVINGS_ID} in ${SAVINGS_TX.slice(0, 8)}…${SAVINGS_TX.slice(-6)}. This guardian did not sign it (it cannot): it took the phone with the hardware wallet, or the Recovery Key. The phone and the alert contacts are told.`,
        summary: 'Savings moved', signedBy: null, sats: 2_000_640, result: 'ok',
      },
      ...activity,
      {
        id: 'a_sv_reg', at: localAt(20, '10:02'), kind: 'system',
        event: `Now watching the phone's Savings wallet ${SAVINGS_ID}. This guardian holds no Savings key and cannot sign for it: it only serves its coins and tells you when they move`,
        summary: 'Watching Savings', signedBy: 'Phone', sats: null, result: 'ok',
      },
    ];
  let recovery: RecoveryInProgress | null =
    scenario === 'recovery' ? demoRecovery() : scenario === 'recoveryready' ? demoRecovery(true) : null;
  let walletIds = scenario === 'unpaired' || scenario === 'firstrun' ? [] : ['3a7f09c2d41e8b65'];
  let pairing: PairingSession | null = null;
  let relayUrls = RELAYS.map((r) => r.url);
  let retiring: RetiringRelay[] = [];
  let relaysChange: RelaySettings['lastChange'];
  if (scenario === 'oldrelays') {
    const at = new Date(Date.now() - 120 * DAY).toISOString();
    retiring = [
      { url: 'wss://relay.old-example.net', connected: true, since: at },
      { url: 'wss://nostr.gone-example.org', connected: false, since: new Date(Date.now() - 300 * DAY).toISOString() },
    ];
    relaysChange = { at, phoneConfirmedAt: new Date(Date.now() - 120 * DAY + HOUR).toISOString() };
  }
  const syncing = scenario === 'syncing';
  let setupFinished = false;
  // `?mock=signedout`: the browser has no session yet (the sign-in screen first).
  let signedIn = scenario !== 'signedout';

  const rules: Rules = {
    walletName: 'Main',
    // No daily limit: the protocol maximum, never shown as a number.
    ...(limitOff ? { dailyLimitSats: 2_100_000_000_000_000, dailyLimitOff: true as const } : { dailyLimitSats: 200_000 }),
    recoveryDelayDays: 7,
    contacts: [
      { id: 'c_phone', name: 'Paired phone', kind: 'paired-phone' },
      { id: 'c_maria', name: 'Maria', kind: 'contact' },
      { id: 'c_tom', name: 'Tom', kind: 'contact' },
    ],
    sweepFeeCapSats: 50_000,
    contactLock: contactLocked,
    hardwarePayments: 'any-amount',
  };

  let hostedWallets: HostedWallet[] = [
    {
      id: 'hw_ana', name: 'Ana', state: 'active', since: localAt(47, '12:00'),
      recoveryDelayDays: 7, paymentsThisWeek: 2,
    },
    { id: 'hw_dad', name: 'Dad', state: 'invited', inviteId: 'inv_dad' },
  ];
  // The guardian keeps only a hash of an invite's secret: its link exists only in the answer that created it.
  let invites: FamilyInvite[] = [
    {
      id: 'inv_dad', name: 'Dad', status: 'pending',
      createdAt: new Date(Date.now() - HOUR).toISOString(),
      expiresAt: new Date(Date.now() + 23 * HOUR).toISOString(),
    },
  ];

  const pushActivity = (entry: Omit<ActivityEntry, 'id' | 'at'>) => {
    activity = [{ ...entry, id: `a${Date.now()}${activity.length}`, at: new Date().toISOString() }, ...activity];
  };

  const relayStatus = (url: string) => {
    const i = RELAYS.findIndex((r) => r.url === url);
    // A relay the mock does not know (one typed in the editor) shows as connected; `syncing` has the second one down.
    return { url, ...(RELAYS[i]?.label ? { label: RELAYS[i]!.label } : {}), connected: !(syncing && i === 1) };
  };

  const relaySettings = (): RelaySettings => {
    return {
      relays: relayUrls.map(relayStatus),
      retiring: clone(retiring),
      options: clone(RELAYS),
      ...(relaysChange ? { lastChange: clone(relaysChange) } : {}),
      max: 8,
      maxRetiring: 16,
    };
  };

  const status = (): GuardianStatus => {
    const relays = relayUrls.map(relayStatus);
    return {
      setupComplete: setupDone || setupFinished,
      state: locked ? 'locked' : 'unlocked',
      lockedAt: locked ? lockedAt : undefined,
      lockReason: locked ? lockReason : undefined,
      ...(locked && lockReason === 'contact' && lockedBy ? { lockedBy } : {}),
      relays,
      chain: syncing
        ? { state: 'syncing', progress: 0.87, source: 'Bitcoin Node + Electrs' }
        : { state: 'synced', source: 'Bitcoin Node + Electrs' },
      wallets: setupDone || setupFinished ? walletIds.map((id) => ({ id, name: 'Main', phonesPaired: phones.length })) : [],
      dailySpend: { usedSats: 70_420, limitSats: rules.dailyLimitSats, ...(rules.dailyLimitOff ? { limitOff: true as const } : {}) },
      ...(savingsScenario
        ? {
            savings: {
              id: SAVINGS_ID,
              watchedSince: localAt(20, '10:02'),
              balanceSats: 46_000_000,
              unconfirmedSats: 0,
              scannedAt: new Date(Date.now() - 60_000).toISOString(),
              lastMoved: { at: localAt(1, '18:40'), sats: 2_000_640, txid: SAVINGS_TX },
            },
          }
        : {}),
      recoveryInProgress: recovery !== null,
      network: 'signet',
      npub: DEMO_NPUB,
      version: '0.1.0',
    };
  };

  const api: GuardianApi = {
    async getStatus() {
      await wait();
      if (!signedIn && (setupDone || setupFinished)) return { authenticated: false, setupComplete: true, state: locked ? 'locked' : 'unlocked', network: 'signet', version: '0.1.0' };
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
      lockedBy = undefined;
      }
      return status();
    },

    async signOut() {
      await wait();
      signedIn = false;
      return { authenticated: false, setupComplete: setupDone || setupFinished, state: locked ? 'locked' : 'unlocked', network: 'signet', version: '0.1.0' };
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
      lockedBy = undefined;
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
      lockedBy = undefined;
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
      params.set('net', 'signet');
      return { uri: `trikey://recover?${params.toString()}`, npub: DEMO_NPUB, relays: [...relayUrls], network: 'signet', walletId };
    },

    async getRelays() {
      await wait();
      if (locked) throw new ApiError('locked', 'The guardian is locked. Unlock it first.', 409);
      return relaySettings();
    },

    async setRelays(input) {
      await wait(300);
      if (locked) throw new ApiError('locked', 'The guardian is locked. Unlock it first.', 409);
      const problem = relayListError(input.relays);
      if (problem) throw new ApiError('invalid', problem, 400);
      const next = [...input.relays];
      const removed = relayUrls.filter((u) => !next.includes(u));
      if (removed.length || next.some((u) => !relayUrls.includes(u))) {
        const since = new Date().toISOString();
        const kept = retiring.filter((r) => !next.includes(r.url) && !removed.includes(r.url));
        if (kept.length + removed.length > 16)
          throw new ApiError('retiring_full', `This change would leave ${kept.length + removed.length} old relays watched, and 16 is the most. Stop watching some old relays first.`, 409);
        retiring = [...removed.map((url) => ({ ...relayStatus(url), since })), ...kept];
        relaysChange = { at: new Date().toISOString() };
        pushActivity({ kind: 'system', event: 'Relays changed on this box. The paired phone was told.', summary: 'Relays changed', signedBy: null, sats: null, result: 'ok' });
        // The phone confirms a moment later, as a real one would.
        if (phones.length)
          setTimeout(() => {
            if (relaysChange) relaysChange = { ...relaysChange, phoneConfirmedAt: new Date().toISOString() };
          }, 4000);
      }
      relayUrls = next;
      return relaySettings();
    },

    async stopWatchingRelays(url) {
      await wait(300);
      if (locked) throw new ApiError('locked', 'The guardian is locked. Unlock it first.', 409);
      const dropped = url === undefined ? retiring : retiring.filter((r) => r.url === url);
      if (url !== undefined && !dropped.length) throw new ApiError('not_found', 'That is not one of the old relays.', 404);
      if (dropped.length) {
        retiring = retiring.filter((r) => !dropped.includes(r));
        pushActivity({
          kind: 'system',
          event: `Stopped watching ${dropped.length === 1 ? '1 old relay' : `${dropped.length} old relays`} at your request.`,
          summary: 'Old relays dropped',
          signedBy: null,
          sats: null,
          result: 'ok',
        });
      }
      return relaySettings();
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
      lockedBy = undefined;
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
      const latest = pending.at(-1);
      return {
        available: true,
        wallets: clone(hostedWallets),
        pendingInvite: latest ? clone({ ...latest, link: undefined }) : null,
        limits: { maxWallets: 8, maxPendingInvites: 4 },
      };
    },

    async createFamilyInvite({ name }) {
      await wait(300);
      const trimmed = name.trim();
      if (!trimmed) throw new ApiError('invalid', 'Add a name so you can tell invites apart.', 400);
      if (invites.filter((i) => i.status === 'pending').length >= 4) throw new ApiError('too_many_invites', 'At most 4 invites can wait at once. Cancel one first.', 409);
      const invite: FamilyInvite = {
        id: `inv_${randomCode(6)}`,
        name: trimmed,
        status: 'pending',
        link: `trikey://invite?v=1&npub=${DEMO_NPUB}&relay=wss%3A%2F%2Frelay.example.com&secret=${randomCode(43)}&exp=${Math.floor(Date.now() / 1000) + 86_400}&net=signet&label=Trikey+Guardian`,
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

    async stopHosting(id, input = {}) {
      await wait();
      const w = hostedWallets.find((x) => x.id === id);
      if (!w) throw new ApiError('not_found', 'No such hosted wallet.', 404);
      if (w.state === 'recovering') throw new ApiError('recovery_pending', 'A recovery of this wallet is running. Hosting cannot stop until it completes or is cancelled.', 409);
      if (w.state !== 'active' && w.state !== 'leaving') throw new ApiError('not_hosting', 'This wallet is not hosted any more.', 409);
      let next: HostedWallet;
      if (input.now) {
        if (input.confirm !== 'STOP HOSTING NOW') throw new ApiError('invalid', 'Type STOP HOSTING NOW to confirm.', 400);
        next = { id: w.id, name: w.name, state: 'ended', ...(w.since ? { since: w.since } : {}), endedAt: new Date().toISOString() };
      } else {
        next = w.state === 'leaving' ? w : { ...w, state: 'leaving', endsAt: new Date(Date.now() + 30 * 24 * HOUR).toISOString() };
      }
      hostedWallets = hostedWallets.map((x) => (x.id === id ? next : x));
      return clone(next);
    },

    async removeHostedWallet(id) {
      await wait();
      const w = hostedWallets.find((x) => x.id === id);
      if (!w || (w.state !== 'ended' && w.state !== 'left')) throw new ApiError('still_hosted', 'Only an ended or left wallet can be removed from the list.', 409);
      hostedWallets = hostedWallets.filter((x) => x.id !== id);
      return this.getHosting();
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
