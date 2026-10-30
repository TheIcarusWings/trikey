import * as nip44 from 'nostr-tools/nip44';
import * as nip17 from 'nostr-tools/nip17';
import { createRumor, createSeal, unwrapEvent } from 'nostr-tools/nip59';
import { finalizeEvent, generateSecretKey } from 'nostr-tools/pure';
import { describe, expect, it } from 'vitest';
import {
  EnvelopeError,
  GIFT_WRAP_KIND,
  WRAP_BACKDATE_SEC,
  ReplayGuard,
  TRIKEY_RPC_KIND,
  buildRumorTemplate,
  checkFreshness,
  generateMessageId,
  openGiftWrap,
  psbtHash,
  readRumor,
  unwrapMessage,
  wrapMessage,
  type Message,
} from '../src/index.js';
import { fakePsbt, keypair } from './helpers.js';

const NOW = 1_800_000_000;
const phone = keypair();
const guardian = keypair();

const statusReq = (): Message => ({ id: generateMessageId(), method: 'guardian.status', params: {} });

function wrapToGuardian(message: Message, over: Partial<Parameters<typeof wrapMessage>[1]> = {}) {
  return wrapMessage(message, { senderSecretKey: phone.secretKey, recipient: guardian.pubkey, now: NOW, ...over });
}

function reason(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (e) {
    if (e instanceof EnvelopeError) return e.reason;
    throw e;
  }
  return undefined;
}

describe('wrapMessage / unwrapMessage', () => {
  it('round-trips a request through rumor, seal and gift wrap', () => {
    const msg = statusReq();
    const { wrap } = wrapToGuardian(msg);
    expect(wrap.kind).toBe(GIFT_WRAP_KIND);
    expect(wrap.kind).toBe(1059);
    expect(wrap.pubkey).not.toBe(phone.pubkey); // signed by a throwaway key
    expect(wrap.tags.find((t) => t[0] === 'p')?.[1]).toBe(guardian.pubkey);
    // The public expiration is later than the rumor's and is not NOW + 300 (that would reveal the send time).
    const wrapExp = Number(wrap.tags.find((t) => t[0] === 'expiration')?.[1]);
    expect(wrapExp).toBeGreaterThanOrEqual(NOW + 3600);
    expect(wrapExp).toBeLessThanOrEqual(NOW + 3600 + WRAP_BACKDATE_SEC);
    expect(wrap.content).not.toContain('guardian.status');

    const incoming = unwrapMessage(wrap, { recipientSecretKey: guardian.secretKey, expectedPeer: phone.pubkey, now: NOW });
    expect(incoming.message).toEqual(msg);
    expect(incoming.sender).toBe(phone.pubkey);
    expect(incoming.meta).toMatchObject({ id: (msg as { id: string }).id, cls: 'request', createdAt: NOW, expiration: NOW + 300 });
  });

  it('puts the expiration and version tags on the rumor and the sha256 of the PSBT when there is one', () => {
    const psbt = fakePsbt();
    const t = buildRumorTemplate(
      { id: generateMessageId(), method: 'sign', params: { psbt } },
      { recipient: guardian.pubkey, now: NOW },
    );
    expect(t.kind).toBe(TRIKEY_RPC_KIND);
    expect(t.tags).toContainEqual(['expiration', String(NOW + 300)]);
    expect(t.tags).toContainEqual(['trikey', '1']);
    expect(t.tags).toContainEqual(['psbt', psbtHash(psbt)]);
    const plain = buildRumorTemplate(statusReq(), { recipient: guardian.pubkey, now: NOW });
    expect(plain.tags.some((x) => x[0] === 'psbt')).toBe(false);
  });

  it('carries PSBTs in responses with their hash', () => {
    const psbt = fakePsbt(9);
    const res: Message = { id: generateMessageId(), result: { psbt } };
    const { wrap } = wrapMessage(res, { senderSecretKey: guardian.secretKey, recipient: phone.pubkey, now: NOW });
    const inc = unwrapMessage(wrap, { recipientSecretKey: phone.secretKey, expectedPeer: guardian.pubkey, now: NOW });
    expect(inc.message).toEqual(res);
    expect(inc.meta.cls).toBe('response');
  });

  it('accepts any author when no expectedPeer is given (pairing)', () => {
    const { wrap } = wrapToGuardian(statusReq());
    const inc = unwrapMessage(wrap, { recipientSecretKey: guardian.secretKey, now: NOW });
    expect(inc.sender).toBe(phone.pubkey);
  });

  it('rejects an author other than the expected peer', () => {
    const stranger = keypair();
    const { wrap } = wrapMessage(statusReq(), { senderSecretKey: stranger.secretKey, recipient: guardian.pubkey, now: NOW });
    expect(reason(() => unwrapMessage(wrap, { recipientSecretKey: guardian.secretKey, expectedPeer: phone.pubkey, now: NOW }))).toBe(
      'wrong_peer',
    );
  });

  it('rejects a wrap addressed to someone else', () => {
    const { wrap } = wrapToGuardian(statusReq());
    const other = keypair();
    expect(reason(() => unwrapMessage(wrap, { recipientSecretKey: other.secretKey, now: NOW }))).toBe('bad_wrap');
  });

  it('rejects a tampered wrap, even one that was verified before', () => {
    const { wrap } = wrapToGuardian(statusReq());
    // finalizeEvent marks the object as verified; tampering must still be caught.
    const tampered = { ...wrap, content: wrap.content.slice(0, -4) + 'AAAA' };
    expect(reason(() => unwrapMessage(tampered, { recipientSecretKey: guardian.secretKey, now: NOW }))).toBe('bad_wrap');
    const mutated = structuredClone(wrap);
    mutated.tags.push(['x', 'y']);
    expect(reason(() => unwrapMessage(mutated, { recipientSecretKey: guardian.secretKey, now: NOW }))).toBe('bad_wrap');
  });

  it('rejects a re-signed wrap whose ciphertext was altered', () => {
    const { wrap } = wrapToGuardian(statusReq());
    const k = generateSecretKey();
    const forged = finalizeEvent(
      { kind: 1059, created_at: wrap.created_at, tags: wrap.tags, content: wrap.content.slice(0, -4) + 'AAAA' },
      k,
    );
    expect(reason(() => unwrapMessage(forged, { recipientSecretKey: guardian.secretKey, now: NOW }))).toBe('decrypt_failed');
  });

  it('rejects a seal whose author differs from the rumor author', () => {
    // Mallory seals a rumor claiming to be from the phone.
    const mallory = keypair();
    const rumor = createRumor(
      buildRumorTemplate(statusReq(), { recipient: guardian.pubkey, now: NOW }),
      phone.secretKey,
    );
    const seal = createSeal(rumor, mallory.secretKey, guardian.pubkey);
    const wrapKey = generateSecretKey();
    const wrap = finalizeEvent(
      {
        kind: 1059,
        created_at: NOW,
        tags: [['p', guardian.pubkey]],
        content: nip44.encrypt(JSON.stringify(seal), nip44.getConversationKey(wrapKey, guardian.pubkey)),
      },
      wrapKey,
    );
    expect(reason(() => unwrapMessage(wrap, { recipientSecretKey: guardian.secretKey, now: NOW }))).toBe('decrypt_failed');
  });

  it('rejects a mismatching or missing PSBT hash', () => {
    const psbt = fakePsbt();
    const msg: Message = { id: generateMessageId(), method: 'sign', params: { psbt } };
    for (const mutate of [
      (tags: string[][]) => tags.map((t) => (t[0] === 'psbt' ? ['psbt', 'ab'.repeat(32)] : t)),
      (tags: string[][]) => tags.filter((t) => t[0] !== 'psbt'),
    ]) {
      const template = buildRumorTemplate(msg, { recipient: guardian.pubkey, now: NOW });
      template.tags = mutate(template.tags);
      const rumor = createRumor(template, phone.secretKey);
      const seal = createSeal(rumor, phone.secretKey, guardian.pubkey);
      const wk = generateSecretKey();
      const wrap = finalizeEvent(
        {
          kind: 1059,
          created_at: NOW,
          tags: [['p', guardian.pubkey]],
          content: nip44.encrypt(JSON.stringify(seal), nip44.getConversationKey(wk, guardian.pubkey)),
        },
        wk,
      );
      expect(reason(() => unwrapMessage(wrap, { recipientSecretKey: guardian.secretKey, now: NOW }))).toBe('psbt_hash_mismatch');
    }
  });

  it('rejects malformed payloads and reports the id and RPC error to answer with', () => {
    const bad = { id: generateMessageId(), method: 'wallet.drain', params: {} } as unknown as Message;
    const template = { kind: TRIKEY_RPC_KIND, created_at: NOW, content: JSON.stringify(bad), tags: [['p', guardian.pubkey], ['trikey', '1'], ['expiration', String(NOW + 60)]] };
    const rumor = createRumor(template, phone.secretKey);
    const seal = createSeal(rumor, phone.secretKey, guardian.pubkey);
    const wk = generateSecretKey();
    const wrap = finalizeEvent(
      { kind: 1059, created_at: NOW, tags: [['p', guardian.pubkey]], content: nip44.encrypt(JSON.stringify(seal), nip44.getConversationKey(wk, guardian.pubkey)) },
      wk,
    );
    try {
      unwrapMessage(wrap, { recipientSecretKey: guardian.secretKey, now: NOW });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(EnvelopeError);
      const err = e as EnvelopeError;
      expect(err.reason).toBe('bad_payload');
      expect(err.messageId).toBe((bad as { id: string }).id);
      expect(err.sender).toBe(phone.pubkey);
      expect(err.errorCode).toBe(-32601);
    }
  });

  it('refuses to build a message with an excessive TTL or invalid params', () => {
    expect(() => wrapToGuardian(statusReq(), { ttlSec: 7200 })).toThrow(RangeError);
    expect(() => wrapToGuardian({ id: generateMessageId(), method: 'sign', params: { psbt: 'nope' } } as Message)).toThrow();
  });
});

describe('freshness and replay', () => {
  it('drops expired requests', () => {
    const { wrap } = wrapToGuardian(statusReq(), { ttlSec: 60 });
    expect(reason(() => unwrapMessage(wrap, { recipientSecretKey: guardian.secretKey, now: NOW + 61 }))).toBe('expired');
    expect(reason(() => unwrapMessage(wrap, { recipientSecretKey: guardian.secretKey, now: NOW + 59 }))).toBeUndefined();
  });

  it('drops rumors older than the window and those from the future', () => {
    const { wrap } = wrapToGuardian(statusReq(), { ttlSec: 3600 });
    expect(
      reason(() => unwrapMessage(wrap, { recipientSecretKey: guardian.secretKey, now: NOW + 3601 })),
    ).toMatch(/expired|stale/);
    expect(reason(() => unwrapMessage(wrap, { recipientSecretKey: guardian.secretKey, now: NOW - 500 }))).toBe('future');
    expect(reason(() => unwrapMessage(wrap, { recipientSecretKey: guardian.secretKey, now: NOW - 100 }))).toBeUndefined(); // within skew
  });

  it('classifies freshness directly', () => {
    const base = { cls: 'request' as const, createdAt: NOW, expiration: NOW + 300 };
    expect(checkFreshness(base, NOW)).toBe('ok');
    expect(checkFreshness(base, NOW + 300)).toBe('expired');
    expect(checkFreshness({ ...base, expiration: NOW + 5000 }, NOW)).toBe('ttl_too_long');
    expect(checkFreshness({ ...base, createdAt: NOW - 4000, expiration: NOW + 10 }, NOW)).toBe('stale');
    // alerts get a week
    expect(checkFreshness({ cls: 'alert', createdAt: NOW - 86400 * 3, expiration: NOW + 86400 }, NOW)).toBe('ok');
  });

  it('a ReplayGuard admits an id once', () => {
    const guard = new ReplayGuard();
    const msg = statusReq();
    const { wrap } = wrapToGuardian(msg);
    const opts = { recipientSecretKey: guardian.secretKey, now: NOW, guard };
    expect(unwrapMessage(wrap, opts).message).toEqual(msg);
    expect(reason(() => unwrapMessage(wrap, opts))).toBe('replay');
    // The same request re-wrapped (a retry) is also a duplicate.
    const again = wrapToGuardian(msg, { createdAt: NOW });
    expect(reason(() => unwrapMessage(again.wrap, opts))).toBe('replay');
  });

  it('a ReplayGuard forgets ids once they can no longer pass the time checks, and stays bounded', () => {
    const guard = new ReplayGuard({ maxEntries: 50 });
    const meta = (i: number, createdAt = NOW) => ({
      sender: phone.pubkey,
      id: `id-${String(i).padStart(16, '0')}`,
      cls: 'request' as const,
      createdAt,
      expiration: createdAt + 60,
    });
    expect(guard.admit(meta(0), NOW)).toBe('ok');
    expect(guard.admit(meta(0), NOW + 10)).toBe('duplicate');
    // after expiry the time check fires first
    expect(guard.admit(meta(0), NOW + 61)).toBe('expired');
    for (let i = 1; i <= 200; i++) guard.admit(meta(i), NOW + 1);
    expect(guard.size).toBeLessThanOrEqual(50);
    // The most recent ids are still remembered.
    expect(guard.admit(meta(200), NOW + 2)).toBe('duplicate');
  });
});

describe('openGiftWrap', () => {
  it('stays NIP-59 compatible both ways: nostr-tools opens our wraps, and we open its NIP-17 DMs', () => {
    const msg = statusReq();
    const { wrap } = wrapToGuardian(msg);
    const rumor = unwrapEvent(wrap, guardian.secretKey);
    expect(rumor).toMatchObject({ kind: TRIKEY_RPC_KIND, pubkey: phone.pubkey });
    expect(JSON.parse(rumor.content)).toEqual(msg);

    const dm = nip17.wrapEvent(phone.secretKey, { publicKey: guardian.pubkey }, 'CANCEL 1-0123456789ab');
    const opened = openGiftWrap(dm, { recipientSecretKey: guardian.secretKey });
    expect(opened).toMatchObject({ sender: phone.pubkey, recipient: guardian.pubkey, wrapId: dm.id, rumor: { kind: 14, content: 'CANCEL 1-0123456789ab' } });
    // A DM is not an RPC message.
    expect(reason(() => readRumor(opened, { now: Math.floor(Date.now() / 1000) }))).toBe('bad_rumor');
  });

  it('opens once, then reads: the same checks as unwrapMessage', () => {
    const msg = statusReq();
    const { wrap } = wrapToGuardian(msg);
    const opened = openGiftWrap(wrap, { recipientSecretKey: guardian.secretKey, conversationKeys: null });
    expect(reason(() => readRumor(opened, { expectedPeer: guardian.pubkey, now: NOW }))).toBe('wrong_peer');
    expect(readRumor(opened, { expectedPeer: phone.pubkey, now: NOW }).message).toEqual(msg);
    expect(reason(() => openGiftWrap(wrap, { recipientSecretKey: phone.secretKey }))).toBe('bad_wrap');
  });
});
