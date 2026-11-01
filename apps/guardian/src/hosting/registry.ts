/**
 * `hosting.json`: the slot registry and the invites (docs/design/family-hosting.md, sections 2 and 7).
 *
 * An invite is persistent (it survives restarts, unlike the host's 5-minute pairing session, because the guest is
 * somewhere else), single use, valid for 24 hours, and stored only as the SHA-256 of its 32-byte secret. Each invite
 * has its own fresh `slotId` (8 random bytes), which `trikey/key3-hosted/v1` mixes into the slot's key 3. The first
 * phone that shows the right secret (`hosted.prepare`) binds the invite: nobody else can finish that pairing. Wrong
 * answers count, and burn the invite after `INVITE_MAX_FAILURES`.
 *
 * Absent file: no guests, which is every guardian before family hosting.
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import { hex } from '@scure/base';
import { secureRandomBytes } from '@trikey/core/random';
import { generatePairingSecret } from '@trikey/protocol';
import { Mutex, readJsonFile, writeFileAtomic } from '../files.js';
import {
  INVITE_MAX_FAILURES,
  INVITE_TTL_MS,
  MAX_HOSTED_WALLETS,
  MAX_PENDING_INVITES,
  type HostingFile,
  type SlotRecord,
} from './types.js';

/** After an invite is used or runs out, strangers' requests for it still get an answer this long. */
export const INVITE_ANSWER_WINDOW_MS = 10 * 60_000;

const digest = (s: string) => createHash('sha256').update(s, 'utf8').digest();

export type InviteCheck =
  | { ok: true; slot: SlotRecord }
  | { ok: false; reason: 'no_invite' | 'expired' | 'used' | 'claimed' | 'wrong_secret' };

export type CreateInviteOutcome = { ok: true; slot: SlotRecord; secret: string } | { ok: false; code: 'invalid' | 'too_many_invites' | 'too_many_wallets'; message: string };

export class HostingRegistry {
  private file: HostingFile = { version: 1, slots: [] };
  readonly mutex = new Mutex();

  constructor(private readonly path: string) {}

  async load(): Promise<void> {
    const raw = (await readJsonFile(this.path)) as HostingFile | undefined;
    if (raw === undefined) return;
    if (!raw || raw.version !== 1 || !Array.isArray(raw.slots)) throw new Error('unsupported hosting.json');
    this.file = raw;
  }

  get slots(): readonly SlotRecord[] {
    return this.file.slots;
  }

  slot(slotId: string): SlotRecord | undefined {
    return this.file.slots.find((s) => s.slotId === slotId);
  }

  /** Changes the file (a copy) and writes it atomically before the change is visible. */
  async update<T>(fn: (f: HostingFile) => T): Promise<T> {
    const next = JSON.parse(JSON.stringify(this.file)) as HostingFile;
    const out = fn(next);
    await writeFileAtomic(this.path, JSON.stringify(next, null, 2));
    this.file = next;
    return out;
  }

  /** Invites that can still be accepted at `now`. */
  pending(now: number): SlotRecord[] {
    return this.file.slots.filter((s) => s.state === 'invited' && s.invite && s.invite.expiresAt > now && s.invite.failures < INVITE_MAX_FAILURES);
  }

  /** Slots that hold (or are about to hold) a guest wallet. */
  live(): SlotRecord[] {
    return this.file.slots.filter((s) => s.state === 'active' || s.state === 'leaving');
  }

  /**
   * Whether strangers' `hosted.prepare` / `hosted.pair` deserve an answer: some invite can still be accepted, or one
   * was used or ran out less than `INVITE_ANSWER_WINDOW_MS` ago (so a second phone hears "already used" rather than
   * nothing, as for the host's pairing codes). Otherwise they are dropped like any stranger's request.
   */
  answering(now: number): boolean {
    if (this.pending(now).length > 0) return true;
    return this.file.slots.some((s) => s.invite && now < Math.max(s.invite.expiresAt <= now ? s.invite.expiresAt : 0, s.acceptedAt ?? 0) + INVITE_ANSWER_WINDOW_MS);
  }

  /** A new invite: a fresh slot id and a 32-byte secret (returned once, stored as its hash). */
  async createInvite(name: unknown, now: number): Promise<CreateInviteOutcome> {
    const n = typeof name === 'string' ? name.trim() : '';
    if (!n || n.length > 64) return { ok: false, code: 'invalid', message: 'Give the invite a name of 1 to 64 characters (only you see it).' };
    return this.mutex.run(async (): Promise<CreateInviteOutcome> => {
      await this.expire(now);
      if (this.pending(now).length >= MAX_PENDING_INVITES)
        return { ok: false, code: 'too_many_invites', message: `At most ${MAX_PENDING_INVITES} invites can wait at once. Cancel one first.` };
      if (this.live().length + this.pending(now).length >= MAX_HOSTED_WALLETS)
        return { ok: false, code: 'too_many_wallets', message: `This guardian hosts at most ${MAX_HOSTED_WALLETS} wallets.` };
      const secret = generatePairingSecret();
      let slotId: string;
      do slotId = hex.encode(secureRandomBytes(8));
      while (this.slot(slotId));
      const slot: SlotRecord = {
        slotId,
        name: n,
        state: 'invited',
        createdAt: now,
        invite: { id: hex.encode(secureRandomBytes(8)), secretHash: digest(secret).toString('hex'), expiresAt: now + INVITE_TTL_MS, failures: 0 },
      };
      await this.update((f) => void f.slots.push(slot));
      return { ok: true, slot, secret };
    });
  }

  /** Cancels an invite that was not accepted (by invite id or slot id). */
  async cancelInvite(id: string): Promise<SlotRecord | undefined> {
    return this.mutex.run(async () => {
      const s = this.file.slots.find((x) => x.state === 'invited' && (x.invite?.id === id || x.slotId === id));
      if (!s) return undefined;
      return this.update((f) => {
        const t = f.slots.find((x) => x.slotId === s.slotId)!;
        t.state = 'cancelled';
        t.removedAt = undefined;
        if (t.invite) t.invite.entropy = undefined;
        return t;
      });
    });
  }

  /** Marks invites past their time (or burned by failures) as expired. Writes only when something changed. */
  async expire(now: number): Promise<void> {
    const stale = this.file.slots.some((s) => s.state === 'invited' && s.invite && (s.invite.expiresAt <= now || s.invite.failures >= INVITE_MAX_FAILURES));
    if (!stale) return;
    await this.update((f) => {
      for (const s of f.slots)
        if (s.state === 'invited' && s.invite && (s.invite.expiresAt <= now || s.invite.failures >= INVITE_MAX_FAILURES)) {
          s.state = 'expired';
          s.invite.entropy = undefined;
        }
    });
  }

  /**
   * Checks an invite secret (constant time against every stored hash) for `sender`, without using it up or binding it
   * (`bind` does). A wrong secret matches no invite, so it cannot be counted against one; strangers' refused requests
   * are bounded upstream (the answer window and the relays' own limits).
   */
  check(secret: string, sender: string, now: number): InviteCheck {
    const want = digest(String(secret));
    for (const s of this.file.slots) {
      if (!s.invite) continue;
      const have = Buffer.from(s.invite.secretHash, 'hex');
      if (have.length !== want.length || !timingSafeEqual(have, want)) continue;
      if (s.state !== 'invited') return { ok: false, reason: s.state === 'active' || s.state === 'leaving' || s.state === 'ended' || s.state === 'left' ? 'used' : 'expired' };
      if (s.invite.expiresAt <= now || s.invite.failures >= INVITE_MAX_FAILURES) return { ok: false, reason: 'expired' };
      if (s.invite.boundTo && s.invite.boundTo !== sender) return { ok: false, reason: 'claimed' };
      return { ok: true, slot: s };
    }
    return { ok: false, reason: 'no_invite' };
  }

  /** `hosted.prepare` with the right secret: binds the invite to `sender` and keeps its key 3 contribution. */
  async bind(slotId: string, sender: string, entropy: string): Promise<void> {
    await this.update((f) => {
      const s = f.slots.find((x) => x.slotId === slotId);
      if (!s?.invite || s.state !== 'invited') throw new Error('not an open invite');
      if (s.invite.boundTo && s.invite.boundTo !== sender) throw new Error('the invite is bound to another phone');
      s.invite.boundTo = sender;
      s.invite.entropy = entropy;
    });
  }

  /** A refused `hosted.pair` (or a bound invite asked by another phone) counts against the invite. */
  async fail(slotId: string): Promise<void> {
    await this.update((f) => {
      const s = f.slots.find((x) => x.slotId === slotId);
      if (s?.invite && s.state === 'invited') s.invite.failures++;
    });
  }
}
