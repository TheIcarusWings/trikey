/**
 * What the Security tab says (docs/design/motion.md, section 8): the issues and their fixes, the banner, the tiles'
 * values and status dots, what a screen reader hears, and when the entrance plays.
 */
import { describe, expect, it } from 'vitest';
import { formatShortDate } from '../data/format';
import { createDemoState } from '../data/mock';
import type { WalletState } from '../data/types';
import {
  bannerChange,
  bannerSpeech,
  guardianChecking,
  needsYou,
  securityBanner,
  securitySignature,
  securityTiles,
  shouldPlayEntrance,
  syncAgo,
  tileLabel,
  type SecurityTile,
} from './security-view';

const NOW = new Date('2026-11-12T10:00:00Z');

function demo(change: (s: WalletState) => Partial<WalletState> = () => ({})): WalletState {
  const s = createDemoState('ios');
  return { ...s, ...change(s) };
}

function view(state: WalletState, opts: { os?: 'ios' | 'android'; checking?: boolean; notes?: { id: 'no-screen-lock' | 'old-security-patch' | 'emulator'; title: string; body: string }[] } = {}) {
  const banner = securityBanner(needsYou(state));
  const tiles = securityTiles(state, { now: NOW, os: opts.os ?? 'ios', checking: opts.checking ?? false, phoneNotes: opts.notes ?? [], needing: banner.needing });
  const all = [...tiles.keys, ...tiles.protection];
  const byId = (id: string): SecurityTile => all.find((t) => t.id === id)!;
  return { banner, tiles, all, byId };
}

const online = (s: WalletState, lastSeenAt = '2026-11-12T09:58:00Z'): Partial<WalletState> => ({ guardian: { ...s.guardian, status: 'online', lastSeenAt } });

describe('Security tab: the banner', () => {
  it("says all set, with no fix, when nothing needs the person", () => {
    const { banner } = view(demo(online));
    expect(banner).toEqual({ ok: true, title: "You're all set", detail: 'All three keys are working.', fix: null, needing: [] });
    expect(bannerSpeech(banner)).toBe("You're all set. All three keys are working.");
  });

  it('keeps the issues, their words and their order as they were, and adds where each is fixed', () => {
    const s = demo((d) => ({
      recovery: { origin: 'someone-else', acknowledged: false } as WalletState['recovery'],
      phoneSpending: 'paused_contested',
      hardwareConfirmRequired: true,
      guardian: { ...d.guardian, status: 'locked' },
      backup: null,
      contacts: [],
    }));
    expect(needsYou(s)).toEqual([
      { text: 'A recovery is running. Check it, or cancel it if it was not you.', key: null, fix: { pathname: '/recover/alert' } },
      { text: 'Phone payments are paused until your Ledger resumes them.', key: 'hardware', fix: { pathname: '/home' } },
      { text: 'Your Ledger needs to see the new wallet once.', key: 'hardware', fix: { pathname: '/home' } },
      { text: 'Your guardian is locked, so phone-only payments are paused.', key: 'guardian', fix: { pathname: '/settings/guardian' } },
      { text: 'This phone is not backed up.', key: 'phone', fix: { pathname: '/backup', params: { again: '1' } } },
      { text: 'Nobody would be alerted about a recovery. Add an alert contact.', key: null, fix: { pathname: '/settings/contacts' } },
    ]);
    const banner = securityBanner(needsYou(s));
    expect(banner.title).toBe('6 things need you');
    expect(banner.detail).toBe('A recovery is running. Check it, or cancel it if it was not you.');
    expect(banner.needing).toEqual(['hardware', 'phone', 'guardian']);
  });

  it('opens the waiting screen for a recovery that was answered or started here, as Home does', () => {
    const s = demo(() => ({ recovery: { origin: 'someone-else', acknowledged: true } as WalletState['recovery'] }));
    expect(needsYou(s)[0]!.fix).toEqual({ pathname: '/recover/waiting' });
  });

  it('says one thing in the singular, with its chevron to the fix and its key amber', () => {
    const s = demo((d) => ({ guardian: { ...d.guardian, status: 'offline' } }));
    const { banner } = view(s);
    expect(banner).toEqual({
      ok: false,
      title: '1 thing needs you',
      detail: "Your guardian can't be reached, so phone-only payments are paused.",
      fix: { pathname: '/settings/guardian' },
      needing: ['guardian'],
    });
  });

  it('draws no key amber for an issue that is about no key (alert contacts)', () => {
    expect(view(demo(() => ({ contacts: [] }))).banner.needing).toEqual([]);
  });

  it('in Recovery Key mode, only has the refills and the shared issues', () => {
    const s = demo((d) => ({ mode: 'recoveryKey', backup: null, contacts: [], recoveryKey: { ...d.recoveryKey, refillsLeft: 1 } }));
    expect(needsYou(s)).toEqual([{ text: 'Your refills are running out. Approve more with your hardware wallet.', key: null, fix: { pathname: '/rk/refills' } }]);
  });
});

describe('Security tab: the tiles', () => {
  it('in guardian mode, are the four keys tiles and the four protection tiles, each going where its row went', () => {
    const { tiles } = view(demo(online));
    expect(tiles.keys.map((t) => [t.title, t.action])).toEqual([
      ['Hardware wallet', null],
      ['This phone', { pathname: '/backup', params: { again: '1' } }],
      ['Guardian', { pathname: '/settings/guardian' }],
      ['Lost a key?', { pathname: '/recover/choose' }],
    ]);
    expect(tiles.protection.map((t) => [t.title, t.action])).toEqual([
      ['Daily limit', { pathname: '/settings/limit' }],
      ['Security waiting period', { pathname: '/settings/delay' }],
      ['Alert contacts', { pathname: '/settings/contacts' }],
      ['Phone safety', 'phone-safety'],
    ]);
  });

  it('say what each is, all green when all is set', () => {
    const s = demo(online);
    const { all } = view(s);
    expect(all.map((t) => [t.value, t.tone, t.state])).toEqual([
      ['Ledger Nano X', 'good', 'Working'],
      [`Backed up · ${formatShortDate(s.backup!.lastBackedUpAt)}`, 'good', 'Working'],
      ['Umbrel · in sync · 2 min ago', 'good', 'Working'],
      ['Start a recovery', 'none', ''],
      ['200,000 sats', 'good', 'On'],
      ['7 days', 'good', 'On'],
      ['2 people', 'good', 'On'],
      ['No issues found', 'good', 'No issues'],
    ]);
    expect(all.every((t) => !t.alert)).toBe(true);
  });

  it('show the backup date', () => {
    const s = demo((d) => ({ backup: { ...d.backup!, lastBackedUpAt: '2026-11-03T12:00:00' } }));
    expect(view(s).byId('phone').value).toBe('Backed up · Nov 3');
  });

  it('say "Not backed up" in amber, and "Back up again" when the backup is behind', () => {
    const none = view(demo(() => ({ backup: null }))).byId('phone');
    expect(none).toMatchObject({ value: 'Not backed up', tone: 'warn', alert: true, state: 'Needs you' });
    const behind = view(demo((d) => ({ backup: { ...d.backup!, labelsNewer: true } }))).byId('phone');
    expect(behind).toMatchObject({ value: 'Back up again', tone: 'warn', alert: true });
  });

  it('give the guardian its box, "in sync" and how long ago, or its status in words', () => {
    const ago = (iso: string) => view(demo((d) => online(d, iso))).byId('guardian').value;
    expect(ago('2026-11-12T09:59:40Z')).toBe('Umbrel · in sync · just now');
    expect(ago('2026-11-12T09:15:00Z')).toBe('Umbrel · in sync · 45 min ago');
    expect(ago('2026-11-12T07:00:00Z')).toBe('Umbrel · in sync · 3 h ago');
    const locked = view(demo((d) => ({ guardian: { ...d.guardian, status: 'locked' } }))).byId('guardian');
    expect(locked).toMatchObject({ value: 'Umbrel · locked', tone: 'warn', alert: true, state: 'Needs you' });
    const offline = view(demo((d) => ({ guardian: { ...d.guardian, status: 'offline' } }))).byId('guardian');
    expect(offline).toMatchObject({ value: 'Umbrel · offline', tone: 'bad', alert: true, state: 'Needs you' });
  });

  it('say "Checking…" while the guardian is asked, its settled tone kept for what counts as a change', () => {
    const g = view(demo((d) => ({ ...online(d), syncing: true })), { checking: true }).byId('guardian');
    expect(g).toMatchObject({ value: 'Checking…', tone: 'checking', settled: 'good', state: 'Checking', alert: false });
  });

  it('count the guardian as being asked while a sync runs, while it reconnects, or before it ever answered', () => {
    expect(guardianChecking({ syncing: false, synced: true })).toBe(false);
    expect(guardianChecking({ syncing: true, synced: true })).toBe(true);
    expect(guardianChecking({ syncing: false, synced: true, guardianReconnecting: true })).toBe(true);
    expect(guardianChecking({ syncing: false, synced: false })).toBe(true);
  });

  it('turn the hardware wallet amber with "Needs you" when an issue is about it', () => {
    const hw = view(demo(() => ({ hardwareConfirmRequired: true }))).byId('hardware');
    expect(hw).toMatchObject({ value: 'Needs you', tone: 'warn', alert: true });
  });

  it('warn about no daily limit and no alert contacts in words', () => {
    const { byId } = view(demo((d) => ({ dailyLimit: { ...d.dailyLimit, off: true }, contacts: [] })));
    expect(byId('limit')).toMatchObject({ value: 'Off', tone: 'warn', alert: true });
    expect(byId('contacts')).toMatchObject({ value: 'Nobody yet', tone: 'warn', alert: true });
    expect(view(demo((d) => ({ contacts: d.contacts.slice(0, 1) }))).byId('contacts').value).toBe('1 person');
  });

  it("give phone safety the first note, a count, or no dot while the phone hasn't said yet", () => {
    const lock = { id: 'no-screen-lock' as const, title: 'Set a screen lock', body: '…' };
    const emu = { id: 'emulator' as const, title: 'Running in a simulator', body: '…' };
    expect(view(demo(), { notes: [lock] }).byId('phone-safety')).toMatchObject({ value: 'Set a screen lock', tone: 'warn', alert: true });
    expect(view(demo(), { notes: [lock, emu] }).byId('phone-safety').value).toBe('2 things to check');
    const s = demo();
    const unknown = securityTiles(s, { now: NOW, os: 'ios', checking: false, phoneNotes: undefined, needing: [] }).protection.find((t) => t.id === 'phone-safety')!;
    expect(unknown).toMatchObject({ value: 'Checking…', tone: 'none' });
  });

  it('keep "Lost a Savings key?" whenever Savings can be had', () => {
    expect(view(demo()).tiles.savingsLost).toBe(true);
    expect(view(demo((d) => ({ savings: { ...d.savings, status: 'not-available' } }))).tiles.savingsLost).toBe(false);
  });

  it('in Recovery Key mode, are the keys of that mode and the refills, with the rows that never opened anything still not buttons', () => {
    const s = demo((d) => ({ mode: 'recoveryKey', recoveryKey: { ...d.recoveryKey, refillsLeft: 5, refillsTotal: 8, savedKey: 'kit' } }));
    const ios = view(s);
    expect(ios.tiles.keys.map((t) => [t.title, t.value, t.action])).toEqual([
      ['Hardware wallet', 'Ledger Nano X', null],
      ['This phone', 'Spends with Face ID', null],
      ['Recovery Key', 'Printed kit', null],
      ['Lost a key?', 'Start a recovery', { pathname: '/recover/choose' }],
    ]);
    expect(ios.tiles.protection.map((t) => [t.title, t.value, t.action])).toEqual([
      ['Refills', '5 of 8 left', { pathname: '/rk/refills' }],
      ['Refill amount', '200,000 sats', { pathname: '/settings/refills' }],
      ['Phone safety', 'No issues found', 'phone-safety'],
    ]);
    expect(ios.tiles.savingsLost).toBe(false);
    const android = view(s, { os: 'android' });
    expect(android.byId('phone').value).toBe('Spends with your fingerprint');
    expect(android.byId('refill-amount').value).toMatch(/^200,000 sats, \d+ at a time$/);
    const low = view(demo((d) => ({ mode: 'recoveryKey', recoveryKey: { ...d.recoveryKey, refillsLeft: 1 } }))).byId('refills');
    expect(low).toMatchObject({ tone: 'warn', alert: true, state: 'Needs you' });
  });

  it('read as title, value and state, without the middle dots', () => {
    expect(tileLabel({ title: 'Guardian', value: 'Umbrel · in sync · 2 min ago', state: 'Working' })).toBe('Guardian, Umbrel, in sync, 2 min ago, Working');
    expect(tileLabel({ title: 'Lost a key?', value: 'Start a recovery', state: '' })).toBe('Lost a key?, Start a recovery');
  });

  it('never show a status by colour alone: every amber or red tile says so in its value', () => {
    const s = demo((d) => ({ backup: null, contacts: [], hardwareConfirmRequired: true, dailyLimit: { ...d.dailyLimit, off: true }, guardian: { ...d.guardian, status: 'offline' } }));
    const { all } = view(s, { notes: [{ id: 'no-screen-lock', title: 'Set a screen lock', body: '…' }] });
    for (const t of all.filter((x) => x.tone === 'warn' || x.tone === 'bad')) {
      expect(t.alert).toBe(true);
      expect(t.state).toBe('Needs you');
    }
  });
});

describe('Security tab: when the entrance plays', () => {
  const sig = (s: WalletState, checking = false) => {
    const { banner, all } = view(s, { checking });
    return securitySignature(banner, all);
  };

  it('plays on the first visit after launch', () => {
    expect(shouldPlayEntrance(null, sig(demo(online)))).toBe(true);
  });

  it('does not play again on a tab switch with nothing changed', () => {
    const s = sig(demo(online));
    expect(shouldPlayEntrance(s, sig(demo(online)))).toBe(false);
  });

  it('is not replayed by a sync, a new "min ago" or a new backup date', () => {
    const before = sig(demo(online));
    expect(sig(demo((d) => ({ ...online(d), syncing: true })), true)).toBe(before);
    expect(sig(demo((d) => online(d, '2026-11-12T08:00:00Z')))).toBe(before);
    expect(sig(demo((d) => ({ ...online(d), backup: { ...d.backup!, lastBackedUpAt: '2026-11-12T09:00:00Z' } })))).toBe(before);
  });

  it('plays again after a change made while the tab was out of view', () => {
    const before = sig(demo(online));
    expect(shouldPlayEntrance(before, sig(demo((d) => ({ guardian: { ...d.guardian, status: 'locked' } }))))).toBe(true);
    expect(shouldPlayEntrance(before, sig(demo((d) => ({ ...online(d), contacts: [] }))))).toBe(true);
    expect(shouldPlayEntrance(before, sig(demo((d) => ({ ...online(d), mode: 'recoveryKey' }))))).toBe(true);
  });
});

describe('Security tab: what a change plays', () => {
  const need = securityBanner([{ text: 'This phone is not backed up.', key: 'phone', fix: { pathname: '/backup' } }]);
  const set = securityBanner([]);

  it('not set to all set: the fixed key, and the whole sequence', () => {
    expect(bannerChange(need, set)).toEqual({ fixed: ['phone'], broke: [], allSet: true, needs: false });
  });

  it('all set to not set: the key turns amber, with no celebration', () => {
    expect(bannerChange(set, need)).toEqual({ fixed: [], broke: ['phone'], allSet: false, needs: true });
  });

  it('one of two fixed: that key turns green, the banner stays amber', () => {
    const two = securityBanner([
      { text: 'Your guardian is locked, so phone-only payments are paused.', key: 'guardian', fix: { pathname: '/settings/guardian' } },
      { text: 'This phone is not backed up.', key: 'phone', fix: { pathname: '/backup' } },
    ]);
    expect(bannerChange(two, need)).toEqual({ fixed: ['guardian'], broke: [], allSet: false, needs: false });
  });
});

describe('syncAgo', () => {
  it('says just now, minutes, hours, then the day', () => {
    expect(syncAgo('2026-11-12T10:00:00Z', NOW)).toBe('just now');
    expect(syncAgo('2026-11-12T09:59:00Z', NOW)).toBe('1 min ago');
    expect(syncAgo('2026-11-12T08:59:00Z', NOW)).toBe('1 h ago');
    expect(syncAgo('2026-11-12T10:05:00Z', NOW)).toBe('just now');
    expect(syncAgo('not a date', NOW)).toBe('just now');
    expect(syncAgo('2026-11-03T08:00:00Z', NOW)).toBe('Nov 3');
  });
});
