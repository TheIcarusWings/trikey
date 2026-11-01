/**
 * What email, ntfy and webhook alerts say (docs/design/notifications.md, "Content"): every alert the guardian can raise,
 * for the owner and for contacts with and without a nostr key, is plain text with nothing a mail client or the ntfy app
 * could turn into a link; a contact without a nostr key is never told to reply CANCEL or LOCK (it would do nothing);
 * a contact with one is told to reply on nostr, not here; the guardian's name is checked; `defang` breaks links.
 */
import { describe, expect, it } from 'vitest';
import { alertText, noticeText, noticeToWire, type ContactReach } from '../src/alerts.js';
import type { Guardian } from '../src/guardian.js';
import type { DueAlert, LimitNotice, RecoveryRecord } from '../src/policy/index.js';
import { DEFAULT_GUARDIAN_NAME, TITLES, checkGuardianName, defang, finish, isLinkFree, maskEmail, topicHint } from '../src/notify/render.js';

const T = Date.UTC(2026, 10, 1, 12, 0, 0);
const CONTACT = 'c1'.repeat(32);
const fakeGuardian = (contactLock: boolean) =>
  ({ engine: { status: () => ({ rules: { contactLock } }), activity: () => [] } }) as unknown as Guardian;

const rec = {
  id: '1-0123456789ab',
  walletId: '0123456789abcdef',
  survivingRole: 'app',
  startedAt: T,
  readyAt: T + 7 * 86_400_000,
  cancelledAt: T + 3600_000,
  cancelledBy: { kind: 'contact', pubkey: CONTACT },
  completedAt: T + 8 * 86_400_000,
  sweepTxid: 'ab'.repeat(32),
  recipients: [CONTACT],
} as unknown as RecoveryRecord;

const alerts: DueAlert[] = (['recovery_started', 'recovery_reminder', 'recovery_ready', 'recovery_cancelled', 'recovery_completed'] as const).map((kind) => ({
  id: `${rec.id}/${kind}`,
  kind,
  recoveryId: rec.id,
  dueAt: T,
  recipients: [CONTACT],
  survivingRole: 'app',
  amountSats: 123_456_789n,
  readyAt: rec.readyAt,
  daysLeft: 3,
}));

const notices: LimitNotice[] = (['limit_off', 'limit_on', 'contact_lock', 'savings_moved', 'savings_unwatched'] as const).map((kind) => ({
  id: `${kind}-1`,
  kind,
  walletId: '0123456789abcdef',
  at: T,
  sequence: 4,
  limitSats: 500_000n,
  reason: 'phone',
  contact: CONTACT,
  savingsWalletId: 'aa11bb22cc33dd44',
  replacedBy: kind === 'savings_unwatched' ? 'ee55ff66aa77bb88' : undefined,
  txid: 'cd'.repeat(32),
  amountSats: 2_000_000n,
  recipients: [CONTACT],
  sent: [],
}));

const reaches: ContactReach[] = ['nostr', 'none'];

describe('every alert, for every reader, is link-free plain text', () => {
  it('recovery alerts', () => {
    for (const lock of [false, true])
      for (const a of alerts) {
        const g = fakeGuardian(lock);
        const owner = alertText(g, a, rec, 'short');
        expect(isLinkFree(owner), owner).toBe(true);
        for (const reach of reaches) {
          const text = alertText(g, a, rec, 'long', reach);
          expect(isLinkFree(text), text).toBe(true);
          const sent = finish({ title: TITLES[a.kind]!, body: text, priority: 'urgent' }, 'Home vault');
          expect(sent.body).toBe(`${text.trim()}\n\n${sent.body.split('\n\n').at(-1)}`); // defang changed nothing
          expect(sent.title).toBe(`Home vault: ${TITLES[a.kind]}`);
        }
      }
  });

  it('notices', () => {
    for (const lock of [false, true])
      for (const n of notices) {
        const owner = noticeToWire(n)?.message;
        if (owner) expect(isLinkFree(owner), owner).toBe(true);
        for (const reach of reaches) {
          const text = noticeText(n, lock, reach);
          expect(isLinkFree(text), text).toBe(true);
        }
      }
  });
});

describe('controls only where they work', () => {
  it('a contact without a nostr key is told to contact the owner, never to reply CANCEL or LOCK', () => {
    const g = fakeGuardian(true);
    for (const a of alerts) {
      const text = alertText(g, a, rec, 'long', 'none');
      expect(text).not.toMatch(/CANCEL |LOCK|reply to this message|Trikey app/);
    }
    expect(alertText(g, alerts[0]!, rec, 'long', 'none')).toMatch(/contact (them|the owner)/);
    expect(noticeText(notices[0]!, true, 'none')).not.toMatch(/LOCK/);
  });

  it('a contact with a nostr key is told to reply on nostr, and that replying here does nothing', () => {
    const g = fakeGuardian(true);
    const started = alertText(g, alerts[0]!, rec, 'long', 'nostr');
    expect(started).toContain(`CANCEL ${rec.id}`);
    expect(started).toMatch(/nostr message/);
    expect(started).toMatch(/Replying here does nothing/);
    expect(started).toMatch(/replying LOCK to the guardian's nostr message/);
    expect(noticeText(notices[0]!, true, 'nostr')).toMatch(/replying LOCK to the guardian's nostr message/);
    expect(noticeText(notices[0]!, false, 'nostr')).not.toMatch(/LOCK/);
  });

  it('the nostr DM itself is unchanged', () => {
    const g = fakeGuardian(false);
    expect(alertText(g, alerts[0]!, rec)).toContain('To stop it, reply to this message with:');
    expect(alertText(g, alerts[0]!, rec)).toBe(alertText(g, alerts[0]!, rec, 'long', 'dm'));
  });
});

describe('names, hints and the link check', () => {
  it("checks the guardian's name: letters, digits, spaces, - and ' only, at most 32", () => {
    expect(checkGuardianName('  Home   vault ')).toBe('Home vault');
    expect(checkGuardianName("Mum's guardian-2")).toBe("Mum's guardian-2");
    expect(checkGuardianName('')).toBe(DEFAULT_GUARDIAN_NAME);
    expect(checkGuardianName(undefined)).toBe(DEFAULT_GUARDIAN_NAME);
    expect(checkGuardianName('line\nbreak')).toBe('line break');
    for (const bad of ['evil.example.com', 'https://x', 'a@b', 'x'.repeat(33), '<b>', '-dash first', 'tab\u0000']) expect(() => checkGuardianName(bad), bad).toThrow();
  });

  it('masks addresses and topics so a message carries no domain or secret', () => {
    expect(maskEmail('maria@example.com')).toBe('m…@e…');
    expect(isLinkFree(maskEmail('maria@example.com'))).toBe(true);
    expect(topicHint('trikey-alerts-x7f3k2')).toBe('tri…');
    expect(topicHint('abc')).toBe('a…');
  });

  it('finds and breaks links, email addresses and domains; leaves amounts, times, npubs and txids alone', () => {
    for (const bad of ['see https://evil.example', 'www.evil.example', 'mail me at a@evil.example', 'go to evil.example now', 'HXXP://x', 'mailto:x'])
      expect(isLinkFree(bad), bad).toBe(false);
    for (const good of ['0.01000000 BTC (1,000,000 sats)', '2026-11-08 12:00 UTC', `npub1${'q'.repeat(58)}`, 'ab'.repeat(32), 'Recovery 1-0123456789ab.', 'j…@e…', 'LOCK.'])
      expect(isLinkFree(good), good).toBe(true);
    const d = defang('Click https://evil.example/login or www.evil.example, or write to a@evil.example');
    expect(isLinkFree(d)).toBe(true);
    expect(d).toContain('hxxps[:]//evil[.]example');
    const sent = finish({ title: 'x', body: 'visit evil.example', priority: 'low' }, 'Home');
    expect(sent.body).toContain('evil[.]example');
    expect(sent.body).toMatch(/Trikey alerts never contain links/);
  });
});
