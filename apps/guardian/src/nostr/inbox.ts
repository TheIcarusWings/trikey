/**
 * The guardian's one subscription to gift wraps addressed to it.
 *
 * RPC requests from the phone (kind-21420 rumors) and NIP-17 DMs from alert
 * contacts (kind-14 rumors) arrive the same way: NIP-59 gift wraps tagged with
 * the guardian's pubkey. Each wrap is opened once here (`openGiftWrap`: both
 * NIP-44 layers, signatures, rumor id) and handed to whoever handles its rumor
 * kind, instead of the RPC server and the DM handler each decrypting every wrap.
 * Duplicates (the same wrap from several relays) are dropped by wrap id first.
 */
import {
  EnvelopeError,
  RecentSet,
  SUBSCRIPTION_LOOKBACK_SEC,
  TRIKEY_RPC_KIND,
  openGiftWrap,
  type NostrEvent,
  type OpenedWrap,
  type RelayPool,
  type Subscription,
} from '@trikey/protocol';
import { errorText, silentLogger, type Logger } from '../log.js';
import { DM_KIND } from './dm.js';

export interface InboxOptions {
  pool: RelayPool;
  relays: string[];
  secretKey: Uint8Array;
  pubkey: string;
  /** Unix seconds. */
  now: () => number;
  onRpc: (opened: OpenedWrap) => Promise<void> | void;
  onDm: (opened: OpenedWrap) => Promise<void> | void;
  log?: Logger;
}

export class Inbox {
  private sub?: Subscription;
  private starting?: Promise<void>;
  private readonly seen = new RecentSet();
  private readonly log: Logger;
  /** Wraps opened (each at most once), for tests and diagnostics. */
  opened = 0;

  constructor(private readonly o: InboxOptions) {
    this.log = o.log ?? silentLogger;
  }

  /** Subscribes; resolves once the relays reply with EOSE (or after 3 s). */
  start(): Promise<void> {
    this.starting ??= new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 3000);
      this.sub = this.o.pool.subscribe(
        this.o.relays,
        { kinds: [1059], '#p': [this.o.pubkey], since: this.o.now() - SUBSCRIPTION_LOOKBACK_SEC },
        {
          onevent: (e) => void this.onWrap(e),
          oneose: () => {
            clearTimeout(timer);
            resolve();
          },
        },
      );
    });
    return this.starting;
  }

  close(): void {
    this.sub?.close();
    this.sub = undefined;
  }

  private async onWrap(wrap: NostrEvent): Promise<void> {
    if (!wrap || typeof wrap.id !== 'string' || this.seen.seen(wrap.id)) return;
    let opened: OpenedWrap;
    try {
      opened = openGiftWrap(wrap, { recipientSecretKey: this.o.secretKey });
      this.opened++;
    } catch (e) {
      // Not for us, or not a valid wrap: dropped without an answer, like the RPC server does.
      if (!(e instanceof EnvelopeError)) this.log.debug('inbox.open_failed', { error: errorText(e) });
      return;
    }
    try {
      if (opened.rumor.kind === TRIKEY_RPC_KIND) await this.o.onRpc(opened);
      else if (opened.rumor.kind === DM_KIND) await this.o.onDm(opened);
    } catch (e) {
      this.log.error('inbox.handler_failed', { kind: opened.rumor.kind, error: errorText(e) });
    }
  }
}
