/**
 * `hosting.json` and the invites (docs/design/family-hosting.md, section 7): persistent across restarts, single use,
 * 24 hours, bound to the first phone, burned after failures, capped (4 pending, 8 hosted), the secret kept only as a hash.
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HostingRegistry, INVITE_ANSWER_WINDOW_MS } from '../src/hosting/registry.js';
import { INVITE_MAX_FAILURES, INVITE_TTL_MS, MAX_HOSTED_WALLETS, MAX_PENDING_INVITES } from '../src/hosting/types.js';
import { T0, nostrKey } from './helpers.js';

let dir: string;
let path: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'trikey-hosting-'));
  path = join(dir, 'hosting.json');
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const PHONE = nostrKey(81);
const OTHER = nostrKey(82);

describe('invites', () => {
  it('no file: no guests, nothing to answer', async () => {
    const r = new HostingRegistry(path);
    await r.load();
    expect(r.slots).toEqual([]);
    expect(r.answering(T0)).toBe(false);
  });

  it('stores only the secret hash, with a fresh 8-byte slot id, and survives a restart', async () => {
    const r = new HostingRegistry(path);
    const c = await r.createInvite(' Dad ', T0);
    if (!c.ok) throw new Error(c.message);
    expect(c.secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(c.slot).toMatchObject({ name: 'Dad', state: 'invited' });
    expect(c.slot.slotId).toMatch(/^[0-9a-f]{16}$/);
    const text = await readFile(path, 'utf8');
    expect(text).not.toContain(c.secret);
    const again = new HostingRegistry(path);
    await again.load();
    expect(again.check(c.secret, PHONE, T0 + 1000)).toMatchObject({ ok: true });
    expect(again.answering(T0 + 1000)).toBe(true);
  });

  it('binds to the first phone; another phone is refused (claimed); a wrong secret matches nothing', async () => {
    const r = new HostingRegistry(path);
    const c = await r.createInvite('Dad', T0);
    if (!c.ok) throw new Error();
    await r.bind(c.slot.slotId, PHONE, 'ab'.repeat(32));
    expect(r.check(c.secret, OTHER, T0)).toEqual({ ok: false, reason: 'claimed' });
    expect(r.check('A'.repeat(43), PHONE, T0)).toEqual({ ok: false, reason: 'no_invite' });
    await expect(r.bind(c.slot.slotId, OTHER, 'cd'.repeat(32))).rejects.toThrow(/another phone/);
  });

  it('expires after 24 hours, and is burned after too many failures', async () => {
    const r = new HostingRegistry(path);
    const c = await r.createInvite('Dad', T0);
    if (!c.ok) throw new Error();
    expect(r.check(c.secret, PHONE, T0 + INVITE_TTL_MS)).toEqual({ ok: false, reason: 'expired' });
    await r.expire(T0 + INVITE_TTL_MS);
    expect(r.slot(c.slot.slotId)!.state).toBe('expired');
    expect(r.answering(T0 + INVITE_TTL_MS + INVITE_ANSWER_WINDOW_MS - 1)).toBe(true);
    expect(r.answering(T0 + INVITE_TTL_MS + INVITE_ANSWER_WINDOW_MS)).toBe(false);
    const d = await r.createInvite('Ana', T0);
    if (!d.ok) throw new Error();
    for (let i = 0; i < INVITE_MAX_FAILURES; i++) await r.fail(d.slot.slotId);
    expect(r.check(d.secret, PHONE, T0)).toEqual({ ok: false, reason: 'expired' });
  });

  it('a used invite answers "used"', async () => {
    const r = new HostingRegistry(path);
    const c = await r.createInvite('Dad', T0);
    if (!c.ok) throw new Error();
    await r.update((f) => {
      const s = f.slots[0];
      s.state = 'active';
      s.acceptedAt = T0;
    });
    expect(r.check(c.secret, PHONE, T0)).toEqual({ ok: false, reason: 'used' });
  });

  it('at most 4 pending and 8 hosted; cancelling frees a place; names are 1..64 characters', async () => {
    const r = new HostingRegistry(path);
    expect(await r.createInvite('', T0)).toMatchObject({ ok: false, code: 'invalid' });
    expect(await r.createInvite('x'.repeat(65), T0)).toMatchObject({ ok: false, code: 'invalid' });
    const made = [];
    for (let i = 0; i < MAX_PENDING_INVITES; i++) made.push(await r.createInvite(`G${i}`, T0));
    expect(await r.createInvite('one more', T0)).toMatchObject({ ok: false, code: 'too_many_invites' });
    const first = made[0];
    if (!first.ok) throw new Error();
    expect((await r.cancelInvite(first.slot.invite!.id))?.state).toBe('cancelled');
    expect(r.check(first.secret, PHONE, T0)).toEqual({ ok: false, reason: 'expired' });
    expect((await r.createInvite('again', T0)).ok).toBe(true);
    // Fill the hosted places: active slots count against the 8.
    await r.update((f) => {
      for (let i = 0; i < MAX_HOSTED_WALLETS - MAX_PENDING_INVITES; i++) f.slots.push({ slotId: `${i}`.padStart(16, 'a'), name: `A${i}`, state: 'active', createdAt: T0 });
    });
    await r.cancelInvite(r.pending(T0)[0].slotId);
    expect(await r.createInvite('ninth', T0)).toMatchObject({ ok: true });
    expect(await r.createInvite('tenth', T0)).toMatchObject({ ok: false });
  });
});
