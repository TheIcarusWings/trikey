/**
 * "Host for someone" (docs/design/family-hosting.md): the disclosure stays true, rows show names, states and dates but
 * never amounts, Stop hosting gives notice and "stop now" needs the typed confirmation, the invite link exists only in
 * the answer that made it, and the HTTP client calls the guardian's real endpoints. (No DOM tests: helpers, the demo
 * data and the client the page uses.)
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMockApi } from '../src/api/mock';
import { createHttpApi } from '../src/api/http';
import type { HostedWallet } from '../src/api/types';
import { HOST_DISCLOSURE, RESET_WHILE_HOSTING, STOP_NOW_CONFIRMATION, STOP_NOW_WARNING, hostedWalletActions, hostedWalletLine, paymentsLine } from '../src/lib/hosting';

describe('what the host is told', () => {
  it('says the page shows no amounts but the box stores what it co-signs (no "never sees amounts")', () => {
    const text = HOST_DISCLOSURE.join(' ');
    expect(text).toMatch(/this page never shows their balance or their payments/);
    expect(text).toMatch(/Your box does store the payments it co-signs for them/);
    expect(text).toMatch(/Reset is refused/);
    expect(text).toMatch(/30 days/);
    expect(text).not.toMatch(/never sees amounts/i);
  });

  it('stop now says what it costs, and reset says why it is refused', () => {
    expect(STOP_NOW_CONFIRMATION).toBe('STOP HOSTING NOW');
    expect(STOP_NOW_WARNING).toMatch(/lose their money/);
    expect(RESET_WHILE_HOSTING).toMatch(/Stop hosting/);
  });
});

describe('a hosted wallet row', () => {
  const base: HostedWallet = { id: 'w', name: 'Dad', state: 'active', since: '2026-10-01T12:00:00Z', recoveryDelayDays: 7, paymentsThisWeek: 1 };

  it('shows names, states and dates, never an amount', () => {
    expect(hostedWalletLine(base)).toBe('Since 1 October 2026 · 7-day recovery wait');
    expect(paymentsLine(base)).toBe('Signed 1 payment this week');
    expect(hostedWalletLine({ ...base, state: 'recovering', recoveryReadyAt: '2026-11-12T10:00:00Z' })).toBe('Recovery waiting until 12 November 2026. Keep this box on and unlocked.');
    expect(hostedWalletLine({ ...base, state: 'leaving', endsAt: '2026-12-01T10:00:00Z' })).toMatch(/until 1 December 2026 to move/);
    expect(hostedWalletLine({ ...base, state: 'ended', endedAt: '2026-12-01T10:00:00Z' })).toMatch(/key here is gone/);
    expect(hostedWalletLine({ id: 'i', name: 'Ana', state: 'invited', inviteId: 'x' })).toBe('Invite sent · not accepted yet');
    expect(paymentsLine({ ...base, state: 'ended' })).toBeUndefined();
  });

  it('offers Stop hosting only while active (refused during a recovery), removal only once over', () => {
    expect(hostedWalletActions(base)).toEqual({ cancelInvite: false, stop: true, stopNow: true, remove: false });
    expect(hostedWalletActions({ ...base, state: 'recovering' })).toEqual({ cancelInvite: false, stop: false, stopNow: false, remove: false });
    expect(hostedWalletActions({ ...base, state: 'leaving' })).toMatchObject({ stop: false, stopNow: true });
    expect(hostedWalletActions({ ...base, state: 'left' })).toMatchObject({ remove: true });
    expect(hostedWalletActions({ id: 'i', name: 'Ana', state: 'invited' })).toMatchObject({ cancelInvite: true });
  });
});

describe('the demo API', () => {
  it('is available; an invite link exists only in the answer that created it', async () => {
    const api = createMockApi('default');
    const before = await api.getHosting();
    expect(before.available).toBe(true);
    expect(before.pendingInvite?.link).toBeUndefined();
    const inv = await api.createFamilyInvite({ name: 'Sis' });
    expect(inv.link).toMatch(/^trikey:\/\/invite\?v=1&/);
    const after = await api.getHosting();
    expect(after.pendingInvite).toMatchObject({ name: 'Sis' });
    expect(after.pendingInvite?.link).toBeUndefined();
  });

  it('Stop hosting: notice first, then stop now with the typed confirmation, then remove', async () => {
    const api = createMockApi('default');
    const leaving = await api.stopHosting('hw_ana');
    expect(leaving.state).toBe('leaving');
    expect(Date.parse(leaving.endsAt!) - Date.now()).toBeGreaterThan(29 * 86_400_000);
    await expect(api.stopHosting('hw_ana', { now: true })).rejects.toMatchObject({ code: 'invalid' });
    const ended = await api.stopHosting('hw_ana', { now: true, confirm: STOP_NOW_CONFIRMATION });
    expect(ended.state).toBe('ended');
    const list = await api.removeHostedWallet('hw_ana');
    expect(list.wallets.find((w) => w.id === 'hw_ana')).toBeUndefined();
    await expect(api.removeHostedWallet('hw_dad')).rejects.toMatchObject({ code: 'still_hosted' });
  });
});

describe('the HTTP client', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('calls the guardian hosting endpoints', async () => {
    const calls: { method: string; url: string; body?: string }[] = [];
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      calls.push({ method: init.method ?? 'GET', url, ...(init.body ? { body: String(init.body) } : {}) });
      return new Response(JSON.stringify({ available: true, wallets: [], pendingInvite: null, id: 'w', name: 'Dad', state: 'leaving' }), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    const api = createHttpApi('');
    await api.getHosting();
    await api.stopHosting('abc', { now: true, confirm: STOP_NOW_CONFIRMATION });
    await api.removeHostedWallet('abc');
    await api.cancelFamilyInvite('inv1');
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual(['GET /api/hosting', 'POST /api/hosting/wallets/abc/stop', 'DELETE /api/hosting/wallets/abc', 'DELETE /api/hosting/invites/inv1']);
    expect(JSON.parse(calls[1].body!)).toEqual({ now: true, confirm: STOP_NOW_CONFIRMATION });
  });
});
