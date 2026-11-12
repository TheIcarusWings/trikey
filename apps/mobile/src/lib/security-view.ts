/**
 * What the Security tab says (docs/design/motion.md, section 8): the banner, the tiles and their status dots, worked
 * out from the wallet state. Pure, so it can be tested: app/(tabs)/security.tsx and src/components/security-hub.tsx draw
 * it. Nothing here changes the wallet; it only reads it.
 */
import type { RecoveryKeyKind, WalletState } from '@/data/types';
import { formatSats, formatShortDate } from '../data/format';
import { guardianBox } from './labels';
import type { PhoneSafetyNote } from './phone-safety';

/**
 * One of the three keys in the banner's mark: the hardware wallet on top, this phone bottom left, and bottom right the
 * guardian (the Recovery Key in Recovery Key mode, drawn in the same corner).
 */
export type SecurityKey = 'hardware' | 'phone' | 'guardian';

/** Where a tap goes: a route and its params, as `router.push` takes them. */
export type Fix = { pathname: string; params?: Record<string, string> };

/** Something that needs the person, what it is about (a key, or none), and where it is fixed. */
export interface SecurityIssue {
  text: string;
  key: SecurityKey | null;
  fix: Fix;
}

const to = (pathname: string, params?: Record<string, string>): Fix => (params ? { pathname, params } : { pathname });

/** What needs the person's attention, most urgent first. An empty list is "You're all set". */
export function needsYou(state: WalletState): SecurityIssue[] {
  const out: SecurityIssue[] = [];
  const brand = state.hardware.brand;
  const backUp = to('/backup', { again: '1' });
  if (state.recovery) {
    // As Home's recovery notice: one that someone else started and nobody answered yet opens the alert.
    const needsAnswer = state.recovery.origin === 'someone-else' && !state.recovery.acknowledged;
    out.push({ text: 'A recovery is running. Check it, or cancel it if it was not you.', key: null, fix: to(needsAnswer ? '/recover/alert' : '/recover/waiting') });
  }
  // Both are put right on Home, with the hardware wallet (its "Resume" and "Confirm" cards).
  if (state.phoneSpending === 'paused_contested') out.push({ text: `Phone payments are paused until your ${brand} resumes them.`, key: 'hardware', fix: to('/home') });
  if (state.hardwareConfirmRequired) out.push({ text: `Your ${brand} needs to see the new wallet once.`, key: 'hardware', fix: to('/home') });
  if (state.mode === 'recoveryKey') {
    if (state.recoveryKey.refillsLeft <= 1) out.push({ text: 'Your refills are running out. Approve more with your hardware wallet.', key: null, fix: to('/rk/refills') });
    return out;
  }
  const guardian = to('/settings/guardian');
  if (state.guardian.status === 'locked') out.push({ text: 'Your guardian is locked, so phone-only payments are paused.', key: 'guardian', fix: guardian });
  if (state.guardian.status === 'offline') out.push({ text: "Your guardian can't be reached, so phone-only payments are paused.", key: 'guardian', fix: guardian });
  if (!state.backup) out.push({ text: 'This phone is not backed up.', key: 'phone', fix: backUp });
  // A backup made before Savings existed does not know it.
  else if (state.savings.status === 'active' && state.savings.createdAt && state.backup.lastBackedUpAt < state.savings.createdAt)
    out.push({ text: "Your backup doesn't include Savings yet. Back up this phone again.", key: 'phone', fix: backUp });
  // Coin control: labels and freezes changed since (they come back with a restore only if they are in it).
  else if (state.backup.labelsNewer) out.push({ text: "Your backup doesn't have your latest coin labels and freezes. Back up this phone again.", key: 'phone', fix: backUp });
  if (state.contacts.length === 0) out.push({ text: 'Nobody would be alerted about a recovery. Add an alert contact.', key: null, fix: to('/settings/contacts') });
  return out;
}

/** The banner: all set, or how many things need the person, the first of them, where it is fixed, and its keys. */
export interface SecurityBanner {
  ok: boolean;
  title: string;
  detail: string;
  /** Where the chevron goes: the first issue's fix. None when all is set. */
  fix: Fix | null;
  /** The keys drawn amber and dashed, in the mark's order. */
  needing: SecurityKey[];
}

const KEY_ORDER: SecurityKey[] = ['hardware', 'phone', 'guardian'];

export function securityBanner(issues: SecurityIssue[]): SecurityBanner {
  const first = issues[0];
  if (!first) return { ok: true, title: "You're all set", detail: 'All three keys are working.', fix: null, needing: [] };
  const keys = new Set(issues.map((i) => i.key));
  return {
    ok: false,
    title: issues.length === 1 ? '1 thing needs you' : `${issues.length} things need you`,
    detail: first.text,
    fix: first.fix,
    needing: KEY_ORDER.filter((k) => keys.has(k)),
  };
}

/** What the banner says to a screen reader, and announces (politely) when it changes. */
export function bannerSpeech(banner: Pick<SecurityBanner, 'title' | 'detail'>): string {
  return `${banner.title}. ${banner.detail}`;
}

/**
 * A tile's status dot: `good` (green), `warn` (amber), `bad` (red: the guardian offline), `checking` (the guardian is
 * being asked: a ring every 1.2s), or `none` (no dot: "Lost a key?").
 */
export type TileTone = 'good' | 'warn' | 'bad' | 'checking' | 'none';

export type TileIcon = 'hardware' | 'phone' | 'guardian' | 'recoveryKey' | 'lost' | 'limit' | 'delay' | 'contacts' | 'phoneSafety' | 'refills' | 'refillAmount';

/** `phone-safety` opens the sheet with the phone's notes; a route opens that screen; `null`: the tile is not a button. */
export type TileAction = Fix | 'phone-safety' | null;

export interface SecurityTile {
  id: string;
  icon: TileIcon;
  title: string;
  /** The line under the title. */
  value: string;
  tone: TileTone;
  /** The tone once the guardian has answered: what a "change" is measured by, so a sync alone is not one. */
  settled: TileTone;
  /** The status in a word or two, said with the tile ("Working", "Needs you"). */
  state: string;
  /** The value line is the warning itself ("Not backed up"): amber and a little bolder. */
  alert: boolean;
  action: TileAction;
}

export interface SecurityTiles {
  keys: SecurityTile[];
  protection: SecurityTile[];
  /** "Lost a Savings key?" stays a row of its own under the keys: Savings can be had (guardian mode). */
  savingsLost: boolean;
}

const KEY_KIND_LABEL: Record<RecoveryKeyKind, string> = {
  paper: 'Printed kit',
  nfc: 'NFC card',
  hardware: 'Second hardware wallet',
};

/** "just now", "2 min ago", "3 h ago", then the day ("Nov 3"). */
export function syncAgo(iso: string, now: Date): string {
  const minutes = Math.floor((now.getTime() - new Date(iso).getTime()) / 60_000);
  if (!(minutes >= 1)) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  if (minutes < 24 * 60) return `${Math.floor(minutes / 60)} h ago`;
  return formatShortDate(iso);
}

/** The guardian is being asked now: a sync is running, the connection is being made again, or it never answered yet. */
export function guardianChecking(state: Pick<WalletState, 'syncing' | 'synced' | 'guardianReconnecting'>): boolean {
  return state.syncing || !!state.guardianReconnecting || !state.synced;
}

function stateWord(tone: TileTone, good: string): string {
  if (tone === 'checking') return 'Checking';
  if (tone === 'warn' || tone === 'bad') return 'Needs you';
  return tone === 'good' ? good : '';
}

function tile(t: Omit<SecurityTile, 'state' | 'settled' | 'alert'> & { settled?: TileTone; good?: string; alert?: boolean }): SecurityTile {
  const { good = 'Working', settled, alert, ...rest } = t;
  return { ...rest, settled: settled ?? t.tone, state: stateWord(t.tone, good), alert: alert ?? false };
}

/**
 * The tiles, two across: "Your keys" and "Protection". Each sits where the Security tab's row for it used to be and
 * goes where that row went. In Recovery Key mode the keys are the hardware wallet, this phone and the Recovery Key, and
 * Protection is the refills (the mode has no limit, waiting period or contacts).
 *
 * `checking`: the guardian is being asked (`guardianChecking`). `phoneNotes`: the phone-safety notes, or undefined
 * while the phone has not said yet. `needing`: the banner's keys, so a key tile and its mark always agree.
 */
export function securityTiles(
  state: WalletState,
  opts: { now: Date; os: 'ios' | 'android'; checking: boolean; phoneNotes: PhoneSafetyNote[] | undefined; needing: SecurityKey[] },
): SecurityTiles {
  const { now, os, checking, phoneNotes, needing } = opts;
  const rk = state.mode === 'recoveryKey';
  const needs = (k: SecurityKey) => needing.includes(k);
  const ios = os === 'ios';

  const hardware = tile({
    id: 'hardware',
    icon: 'hardware',
    title: 'Hardware wallet',
    value: needs('hardware') ? 'Needs you' : state.hardware.model,
    tone: needs('hardware') ? 'warn' : 'good',
    alert: needs('hardware'),
    action: null,
  });
  const lost = tile({ id: 'lost', icon: 'lost', title: 'Lost a key?', value: 'Start a recovery', tone: 'none', action: to('/recover/choose') });
  const notes = phoneNotes;
  const safetyTone: TileTone = notes === undefined ? 'none' : notes.length ? 'warn' : 'good';
  const phoneSafety = tile({
    id: 'phone-safety',
    icon: 'phoneSafety',
    title: 'Phone safety',
    value: notes === undefined ? 'Checking…' : notes.length === 0 ? 'No issues found' : notes.length === 1 ? notes[0]!.title : `${notes.length} things to check`,
    tone: safetyTone,
    good: 'No issues',
    alert: safetyTone === 'warn',
    action: 'phone-safety',
  });

  if (rk) {
    const k = state.recoveryKey;
    const low = k.refillsLeft <= 1;
    return {
      keys: [
        hardware,
        tile({ id: 'phone', icon: 'phone', title: 'This phone', value: ios ? 'Spends with Face ID' : 'Spends with your fingerprint', tone: 'good', action: null }),
        tile({
          id: 'recovery-key',
          icon: 'recoveryKey',
          title: 'Recovery Key',
          value: k.savedKey === 'hardware' ? 'Second hardware wallet' : k.savedKey === 'kit' ? 'Printed kit' : KEY_KIND_LABEL[k.keyKind],
          tone: 'good',
          action: null,
        }),
        lost,
      ],
      protection: [
        tile({ id: 'refills', icon: 'refills', title: 'Refills', value: `${k.refillsLeft} of ${k.refillsTotal} left`, tone: low ? 'warn' : 'good', good: 'On', alert: low, action: to('/rk/refills') }),
        tile({
          id: 'refill-amount',
          icon: 'refillAmount',
          title: 'Refill amount',
          value: ios ? `${formatSats(k.refillAmountSats)} sats` : `${formatSats(k.refillAmountSats)} sats, ${k.refillCount} at a time`,
          tone: 'good',
          good: 'On',
          action: to('/settings/refills'),
        }),
        phoneSafety,
      ],
      savingsLost: false,
    };
  }

  const { backup, guardian, dailyLimit, contacts } = state;
  const box = guardianBox(guardian);
  const guardianTone: TileTone = guardian.status === 'online' ? 'good' : guardian.status === 'locked' ? 'warn' : 'bad';
  const guardianValue =
    guardian.status === 'online' ? `${box} · in sync · ${syncAgo(guardian.lastSeenAt, now)}` : guardian.status === 'locked' ? `${box} · locked` : `${box} · offline`;
  const phoneNeeds = needs('phone');
  return {
    keys: [
      hardware,
      tile({
        id: 'phone',
        icon: 'phone',
        title: 'This phone',
        value: !backup ? 'Not backed up' : phoneNeeds ? 'Back up again' : `Backed up · ${formatShortDate(backup.lastBackedUpAt)}`,
        tone: phoneNeeds || !backup ? 'warn' : 'good',
        alert: phoneNeeds || !backup,
        action: to('/backup', { again: '1' }),
      }),
      tile({
        id: 'guardian',
        icon: 'guardian',
        title: 'Guardian',
        value: checking ? 'Checking…' : guardianValue,
        tone: checking ? 'checking' : guardianTone,
        settled: guardianTone,
        alert: !checking && guardianTone !== 'good',
        action: to('/settings/guardian'),
      }),
      lost,
    ],
    protection: [
      tile({
        id: 'limit',
        icon: 'limit',
        title: 'Daily limit',
        value: dailyLimit.off ? 'Off' : `${formatSats(dailyLimit.limitSats)} sats`,
        tone: dailyLimit.off ? 'warn' : 'good',
        good: 'On',
        alert: !!dailyLimit.off,
        action: to('/settings/limit'),
      }),
      tile({ id: 'delay', icon: 'delay', title: 'Security waiting period', value: `${state.recoveryDelayDays} days`, tone: 'good', good: 'On', action: to('/settings/delay') }),
      tile({
        id: 'contacts',
        icon: 'contacts',
        title: 'Alert contacts',
        value: contacts.length === 0 ? 'Nobody yet' : `${contacts.length} ${contacts.length === 1 ? 'person' : 'people'}`,
        tone: contacts.length === 0 ? 'warn' : 'good',
        good: 'On',
        alert: contacts.length === 0,
        action: to('/settings/contacts'),
      }),
      phoneSafety,
    ],
    // A new phone without a backup finds Savings at the guardian, so the row is there whenever Savings can be had.
    savingsLost: state.savings.status !== 'not-available',
  };
}

/** What a tile says to a screen reader: its title, its value and its state ("Guardian, Umbrel, in sync, 2 min ago, Working"). */
export function tileLabel(t: Pick<SecurityTile, 'title' | 'value' | 'state'>): string {
  return [t.title, t.value.replace(/ · /g, ', '), t.state].filter(Boolean).join(', ');
}

/**
 * What the tab shows, as one string: the banner's state and keys and each tile's settled tone. The entrance plays again
 * when this differs from what was last shown, so a sync, a new "min ago" or a new date is not a change.
 */
export function securitySignature(banner: Pick<SecurityBanner, 'ok' | 'needing'>, tiles: Pick<SecurityTile, 'id' | 'settled'>[]): string {
  return [banner.ok ? 'ok' : 'need', banner.needing.join('+'), ...tiles.map((t) => `${t.id}:${t.settled}`)].join('|');
}

/**
 * Whether the tab's entrance plays as it comes into view: the first time after launch (nothing shown yet), and after a
 * change made while it was out of view. Not on every tab switch.
 */
export function shouldPlayEntrance(lastShown: string | null, now: string): boolean {
  return lastShown !== now;
}

/**
 * What a change seen on the tab plays. `fixed`: keys that turn from amber to green (a green ring draws round each);
 * `broke`: keys that turn amber; `allSet`: the banner turns from "needs you" to "You're all set" (the whole sequence,
 * haptic `success`); `needs`: the reverse (no celebration, no haptic).
 */
export function bannerChange(from: Pick<SecurityBanner, 'ok' | 'needing'>, to_: Pick<SecurityBanner, 'ok' | 'needing'>): { fixed: SecurityKey[]; broke: SecurityKey[]; allSet: boolean; needs: boolean } {
  return {
    fixed: from.needing.filter((k) => !to_.needing.includes(k)),
    broke: to_.needing.filter((k) => !from.needing.includes(k)),
    allSet: !from.ok && to_.ok,
    needs: from.ok && !to_.ok,
  };
}
