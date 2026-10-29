/**
 * NIP-17 private direct messages: a kind-14 rumor, sealed (kind 13) and gift
 * wrapped (kind 1059, NIP-59) to the recipient. This is what Damus, Amethyst and
 * Primal show as DMs, so alert contacts need nothing but their usual nostr app.
 *
 * Sending: to the guardian's relays plus the recipient's DM inbox relays
 * (their kind-10050 list, looked up on our relays; only `wss://` entries are
 * used, so a contact's list cannot point the guardian at hosts on the LAN).
 *
 * Receiving: every gift wrap addressed to the guardian is opened; kind-14
 * rumors are handed to `onMessage` with the verified author. The RPC server
 * opens the same wraps for kind-21420 rumors and ignores these, and vice versa.
 */
import { RecentSet, normalizeRelayUrl, SUBSCRIPTION_LOOKBACK_SEC, type RelayPool, type PublishOutcome, type Subscription, type NostrEvent } from '@trikey/protocol';
import * as nip17 from 'nostr-tools/nip17';
import { getEventHash, verifyEvent } from 'nostr-tools/pure';
import { errorText, silentLogger, type Logger } from '../log.js';
import type { GuardianIdentity } from '../identity.js';

export const DM_KIND = 14;
export const DM_RELAY_LIST_KIND = 10050;
const MAX_DM_RELAYS = 8;
const MAX_CONTENT = 4000;
const RELAY_CACHE_MS = 3_600_000;

export interface IncomingDm {
  /** Verified author (x-only hex). */
  sender: string;
  content: string;
  /** Rumor timestamp, unix seconds (set by the sender; not authenticated as a time). */
  createdAt: number;
  rumorId: string;
}

export interface DirectMessagesOptions {
  pool: RelayPool;
  relays: string[];
  identity: GuardianIdentity;
  onMessage: (dm: IncomingDm) => void | Promise<void>;
  /** Unix seconds. */
  now?: () => number;
  log?: Logger;
  /** Look up recipients' kind-10050 DM relays. Default true. */
  discoverRelays?: boolean;
}

export class DirectMessages {
  private sub?: Subscription;
  private readonly seen = new RecentSet();
  private readonly relayCache = new Map<string, { at: number; relays: string[] }>();
  private readonly log: Logger;

  constructor(private readonly o: DirectMessagesOptions) {
    this.log = o.log ?? silentLogger;
  }

  private now(): number {
    return this.o.now ? this.o.now() : Math.floor(Date.now() / 1000);
  }

  start(): void {
    if (this.sub) return;
    this.sub = this.o.pool.subscribe(
      this.o.relays,
      { kinds: [1059], '#p': [this.o.identity.pubkey], since: this.now() - SUBSCRIPTION_LOOKBACK_SEC },
      { onevent: (e) => this.onWrap(e) },
    );
  }

  close(): void {
    this.sub?.close();
    this.sub = undefined;
  }

  private onWrap(wrap: NostrEvent): void {
    if (!wrap || typeof wrap.id !== 'string' || this.seen.seen(wrap.id)) return;
    const clean: NostrEvent = {
      id: wrap.id,
      pubkey: wrap.pubkey,
      created_at: wrap.created_at,
      kind: wrap.kind,
      tags: wrap.tags,
      content: wrap.content,
      sig: wrap.sig,
    };
    if (clean.kind !== 1059 || typeof clean.content !== 'string' || clean.content.length > 100_000) return;
    if (!verifyEvent(clean)) return;
    let rumor: ReturnType<typeof nip17.unwrapEvent>;
    try {
      rumor = nip17.unwrapEvent(clean, this.o.identity.secretKey);
    } catch {
      return; // not for us, or not a valid seal
    }
    if (rumor.kind !== DM_KIND) return; // RPC traffic (kind 21420) is the RpcServer's
    try {
      if (getEventHash(rumor) !== rumor.id) return;
    } catch {
      return;
    }
    if (!Array.isArray(rumor.tags) || !rumor.tags.some((t) => t[0] === 'p' && t[1] === this.o.identity.pubkey)) return;
    if (typeof rumor.content !== 'string' || rumor.content.length > MAX_CONTENT) return;
    void Promise.resolve(
      this.o.onMessage({ sender: rumor.pubkey, content: rumor.content, createdAt: rumor.created_at, rumorId: rumor.id }),
    ).catch((e: unknown) => this.log.error('dm.handler_failed', { error: errorText(e) }));
  }

  /** Sends a NIP-17 DM. Resolves with the per-relay outcomes; `some(o => o.ok)` means delivered to at least one relay. */
  async send(recipient: string, text: string): Promise<PublishOutcome[]> {
    const relays = await this.relaysFor(recipient);
    const wrap = nip17.wrapEvent(this.o.identity.secretKey, { publicKey: recipient }, text);
    return this.o.pool.publish(relays, wrap);
  }

  private async relaysFor(pubkey: string): Promise<string[]> {
    const own = [...this.o.relays];
    if (this.o.discoverRelays === false) return own;
    const cached = this.relayCache.get(pubkey);
    let theirs: string[];
    if (cached && Date.now() - cached.at < RELAY_CACHE_MS) theirs = cached.relays;
    else {
      theirs = await this.lookupDmRelays(pubkey).catch(() => []);
      this.relayCache.set(pubkey, { at: Date.now(), relays: theirs });
    }
    return [...new Set([...own, ...theirs])].slice(0, Math.max(own.length, MAX_DM_RELAYS));
  }

  /** The recipient's kind-10050 DM inbox relays, as found on our relays (wss:// only). */
  private lookupDmRelays(pubkey: string, timeoutMs = 3000): Promise<string[]> {
    return new Promise((resolve) => {
      let best: NostrEvent | undefined;
      let sub: Subscription | undefined = undefined;
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        sub?.close();
        const urls: string[] = [];
        for (const t of best?.tags ?? []) {
          if (t[0] !== 'relay' || typeof t[1] !== 'string') continue;
          try {
            const u = normalizeRelayUrl(t[1]);
            if (u.startsWith('wss://')) urls.push(u);
          } catch {
            /* skip malformed entries */
          }
        }
        resolve(urls.slice(0, MAX_DM_RELAYS));
      };
      const timer = setTimeout(finish, timeoutMs);
      sub = this.o.pool.subscribe(
        this.o.relays,
        { kinds: [DM_RELAY_LIST_KIND], authors: [pubkey], limit: 1 },
        {
          onevent: (e) => {
            if (e.pubkey !== pubkey || e.kind !== DM_RELAY_LIST_KIND || !verifyEvent({ ...e })) return;
            if (!best || e.created_at > best.created_at) best = e;
          },
          oneose: finish,
        },
      );
      if (done) sub.close();
    });
  }
}
