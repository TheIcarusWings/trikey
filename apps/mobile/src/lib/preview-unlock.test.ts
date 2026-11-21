import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { decode } from 'nostr-tools/nip19';
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { featureOn, previewOnUntil, setPreviewUntil } from './features';
import { finishUnlock, loadPreview, readChallenge, startChallenge, turnOffPreview } from './preview-store';
import { CHALLENGE_MINUTES, PREVIEW_CONTENT, PREVIEW_HOURS, PREVIEW_KIND, challengeCode, checkUnlock, showCode, type Challenge } from './preview-unlock';
import { PUBLISHER_PUBKEY } from './publisher-key';

const ROOT = join(__dirname, '..', '..', '..', '..');
// A throwaway key standing in for the publisher's.
const sk = generateSecretKey();
const pk = getPublicKey(sk);
const NOW = 1_800_000_000;
const challenge: Challenge = { code: 'a1b2c3d4e5f60718', issuedAt: NOW - 60 };

function signed(over: Partial<{ kind: number; content: string; tags: string[][]; created_at: number }> = {}, key = sk) {
  return JSON.stringify(finalizeEvent({ kind: PREVIEW_KIND, content: PREVIEW_CONTENT, tags: [['challenge', challenge.code]], created_at: NOW - 30, ...over }, key));
}
const check = (raw: string, c: Challenge | null = challenge, now = NOW) => checkUnlock(raw, c, now, { pubkey: pk });

describe('the preview unlock', () => {
  afterEach(() => setPreviewUntil(0));

  it('accepts the publisher key signing this phone challenge, for 24 hours', () => {
    expect(check(signed())).toEqual({ ok: true, until: NOW + PREVIEW_HOURS * 3600 });
  });

  it('refuses another key, another challenge, another kind or text, an extra tag, a bad signature', () => {
    expect(check(signed({}, generateSecretKey()))).toMatchObject({ ok: false, reason: expect.stringContaining("publisher key") });
    expect(check(signed({ tags: [['challenge', 'ffffffffffffffff']] }))).toMatchObject({ ok: false, reason: expect.stringContaining('another challenge') });
    expect(check(signed({ tags: [['challenge', challenge.code], ['p', pk]] }))).toMatchObject({ ok: false });
    expect(check(signed({ kind: 1420 }))).toMatchObject({ ok: false });
    expect(check(signed({ content: 'something else' }))).toMatchObject({ ok: false });
    const forged = JSON.parse(signed());
    forged.sig = forged.sig.replace(/^./, (c: string) => (c === '0' ? '1' : '0'));
    expect(check(JSON.stringify(forged))).toMatchObject({ ok: false, reason: expect.stringContaining('signature') });
    const moved = JSON.parse(signed());
    moved.created_at += 1; // signed fields changed after signing
    expect(check(JSON.stringify(moved))).toMatchObject({ ok: false });
  });

  it('refuses a stale challenge, one signed before it, no challenge, and anything not an event', () => {
    expect(check(signed(), challenge, challenge.issuedAt + CHALLENGE_MINUTES * 60 + 1)).toMatchObject({ ok: false, reason: expect.stringContaining('ran out') });
    expect(check(signed({ created_at: challenge.issuedAt - 3600 }))).toMatchObject({ ok: false, reason: expect.stringContaining('time') });
    expect(check(signed(), null)).toMatchObject({ ok: false });
    expect(check('not json')).toMatchObject({ ok: false });
    expect(check('[1,2]')).toMatchObject({ ok: false });
  });

  it('checks against the pinned publisher key by default', () => {
    expect(checkUnlock(signed(), challenge, NOW)).toMatchObject({ ok: false, reason: expect.stringContaining('publisher key') });
    const pinned = readFileSync(join(ROOT, 'packaging', 'release-signer.npub'), 'utf8').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
    expect(decode(pinned[0]!).data).toBe(PUBLISHER_PUBKEY);
  });

  it('makes a 16-digit challenge from 8 bytes, shown in groups of four', () => {
    expect(challengeCode(new Uint8Array([0xa1, 0xb2, 0xc3, 0xd4, 0xe5, 0xf6, 0x07, 0x18]))).toBe('a1b2c3d4e5f60718');
    expect(() => challengeCode(new Uint8Array(4))).toThrow();
    expect(showCode('a1b2c3d4e5f60718')).toBe('a1b2 c3d4 e5f6 0718');
  });

  it('keeps the unlock tool on the same kind and text', () => {
    const tool = readFileSync(join(ROOT, 'tools', 'release', 'unlock-preview.mjs'), 'utf8');
    expect(tool).toContain(`const KIND = ${PREVIEW_KIND};`);
    expect(tool).toContain(`const CONTENT = '${PREVIEW_CONTENT}';`);
    expect(tool).not.toContain('SimplePool'); // it never publishes the event
  });
});

describe('preview on this phone', () => {
  afterEach(() => setPreviewUntil(0));

  function memoryKv() {
    const m = new Map<string, string>();
    return { m, kv: { get: async (k: string) => m.get(k) ?? null, set: async (k: string, v: string) => void m.set(k, v), remove: async (k: string) => void m.delete(k) } };
  }

  it('turns preview features on in the public app once unlocked, once only per challenge, and off again', async () => {
    const { kv } = memoryKv();
    expect(featureOn('trezor', 'release')).toBe(false);
    const now = Math.floor(Date.now() / 1000);
    const c = await startChallenge(kv, () => new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]), now);
    expect(await readChallenge(kv)).toEqual(c);
    const raw = JSON.stringify(finalizeEvent({ kind: PREVIEW_KIND, content: PREVIEW_CONTENT, tags: [['challenge', c.code]], created_at: now }, sk));
    // Signed by another key than the pinned one: refused, and the challenge stays open.
    expect((await finishUnlock(kv, raw, now)).ok).toBe(false);
    expect(featureOn('trezor', 'release')).toBe(false);
    // With the throwaway key standing in for the publisher's: on, and the challenge used up.
    expect(await finishUnlock(kv, raw, now, { pubkey: pk })).toEqual({ ok: true, until: now + PREVIEW_HOURS * 3600 });
    expect(previewOnUntil()).toBe(now + PREVIEW_HOURS * 3600);
    expect(featureOn('trezor', 'release')).toBe(true);
    expect((await finishUnlock(kv, raw, now, { pubkey: pk })).ok).toBe(false);
    expect(featureOn('savings', 'release')).toBe(false); // test stage stays off
    await turnOffPreview(kv);
    expect(featureOn('trezor', 'release')).toBe(false);
  });

  it('loads an unlock that has not run out, and drops one that has', async () => {
    const { kv, m } = memoryKv();
    const now = Math.floor(Date.now() / 1000);
    m.set('trikey.preview.until', String(now + 3600));
    await loadPreview(kv, now);
    expect(previewOnUntil()).toBe(now + 3600);
    m.set('trikey.preview.until', String(now - 1));
    await loadPreview(kv, now);
    expect(previewOnUntil()).toBeNull();
    expect(m.has('trikey.preview.until')).toBe(false);
  });
});
