/**
 * Family hosting, the service side (docs/design/family-hosting.md): the slot registry, one `HostedEngine` per guest
 * wallet, routing by sender nostr key, key 3 per slot at unlock, stopping hosting, and the background work (expiring
 * invites, ending slots whose notice ran out, guest recoveries, guest alerts).
 *
 * Isolation is structural: a guest's phone (or a phone with recovery access to a guest's wallet) is routed to its own
 * slot's engine and nothing else; the host's `PolicyEngine`, its file and its handlers never see a guest's request. A
 * guardian with no guests has no `hosting.json`, and every host code path runs exactly as before.
 */
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { hex } from '@scure/base';
import type { MethodName } from '@trikey/protocol';
import { GUARDIAN_FEATURES } from '@trikey/protocol';
import type { Guardian } from '../guardian.js';
import { hostedKey3Context, hostedKey3Mix, type GuardianSeed, type KeystoreSigner } from '../keystore.js';
import { errorText } from '../log.js';
import { SlidingWindowLimiter, DEFAULT_BROADCAST_LIMIT } from '../rate-limit.js';
import { readJsonFile, writeFileAtomic } from '../files.js';
import { HostedEngine, deserializeHosted, keySetKey, serializeHosted, type HostedStore } from './engine.js';
import { HostingRegistry } from './registry.js';
import { HostedAlerter } from './alerts.js';
import { HostedRecoveryRunner } from './recovery.js';
import { HOSTED_SIGN_LIMIT, STOP_HOSTING_NOTICE_MS, STOP_NOW_CONFIRMATION, type HostedState, type SlotFile, type SlotRecord } from './types.js';

/** A guest wallet's recovery id: `<slotId>g<n>-<txid12>` (fits the protocol's `RecoveryId` and the `CANCEL` DM's pattern). */
export const HOSTED_RECOVERY_ID = /^([0-9a-f]{16})g\d+-[0-9a-f]{12}$/;

export function slotOfRecoveryId(id: unknown): string | undefined {
  const m = typeof id === 'string' ? HOSTED_RECOVERY_ID.exec(id) : null;
  return m ? m[1] : undefined;
}

/** What a guest's paired phone may call (anything else gets a typed error, so an app bug shows). */
export const GUEST_METHODS: ReadonlySet<MethodName> = new Set<MethodName>([
  'guardian.status',
  'sign',
  'policy.get',
  'policy.update',
  'recovery.start',
  'recovery.update',
  'recovery.cancel',
  'recovery.status',
  'phone.resume',
  'hardware.confirm',
  'wallet.retire',
  'fees.estimate',
  'tx.broadcast',
  'relays.ack',
  'hosted.coins',
  'hosted.map.get',
  'hosted.access',
]);

/** What a phone with recovery access to a guest's wallet may call. */
export const GUEST_RECOVERY_METHODS: ReadonlySet<MethodName> = new Set<MethodName>([
  'guardian.status',
  'fees.estimate',
  'hosted.access',
  'recovery.start',
  'recovery.update',
  'recovery.status',
  'recovery.cancel',
  'hosted.coins',
  'hosted.map.get',
]);

/** The features a guest sees: only what the host serves for guests in phase 1. */
export const GUEST_FEATURES = [GUARDIAN_FEATURES.familyHosting];

class HostedFileStore implements HostedStore {
  constructor(readonly path: string) {}
  async load(): Promise<HostedState | undefined> {
    let text: string;
    try {
      text = await readFile(this.path, 'utf8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw e;
    }
    return deserializeHosted(text);
  }
  async save(state: HostedState): Promise<void> {
    await writeFileAtomic(this.path, serializeHosted(state));
  }
}

export interface GuestRoute {
  slot: SlotRecord;
  engine: HostedEngine;
  role: 'phone' | 'peer';
}

export type StopOutcome =
  | { ok: true; slot: SlotRecord }
  | { ok: false; code: 'not_found' | 'invalid' | 'recovery_pending' | 'not_hosting'; message: string };

export class Hosting {
  readonly registry: HostingRegistry;
  readonly engines = new Map<string, HostedEngine>();
  private readonly slotFiles = new Map<string, SlotFile>();
  private readonly signers = new Map<string, KeystoreSigner>();
  /** Per slot: `sign` requests per hour. */
  readonly signLimiter = new SlidingWindowLimiter(HOSTED_SIGN_LIMIT);
  /** Per slot: `tx.broadcast`. */
  readonly broadcastLimiter: SlidingWindowLimiter;
  readonly alerts: HostedAlerter;
  readonly recovery: HostedRecoveryRunner;
  /** Off with FAMILY_HOSTING=false: no invites, and guests' requests are dropped like a stranger's. */
  readonly enabled: boolean;

  constructor(private readonly g: Guardian) {
    this.registry = new HostingRegistry(join(g.config.dataDir, 'hosting.json'));
    this.broadcastLimiter = new SlidingWindowLimiter(DEFAULT_BROADCAST_LIMIT);
    this.alerts = new HostedAlerter(g, this);
    this.recovery = new HostedRecoveryRunner(g, this);
    this.enabled = g.config.familyHosting !== false;
  }

  private slotDir(slotId: string): string {
    return join(this.g.config.dataDir, 'hosted', slotId);
  }

  /** Loads `hosting.json` and the engines of the slots that hold a wallet. Nothing to do without the file. */
  async load(): Promise<void> {
    await this.registry.load();
    for (const s of this.registry.slots) if (s.state === 'active' || s.state === 'leaving' || s.state === 'ended' || s.state === 'left') await this.openEngine(s.slotId);
  }

  async openEngine(slotId: string): Promise<HostedEngine> {
    const existing = this.engines.get(slotId);
    if (existing) return existing;
    const dir = this.slotDir(slotId);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const chain = {
      tip: async () => {
        const t = await this.g.chain.tip();
        return { height: t.height, medianTimePastMs: t.medianTimePast * 1000 };
      },
    };
    const engine = await HostedEngine.open({ slotId, store: new HostedFileStore(join(dir, 'state.json')), clock: this.g.clock, chain });
    this.engines.set(slotId, engine);
    const raw = (await readJsonFile(join(dir, 'slot.json'))) as SlotFile | undefined;
    this.slotFiles.set(slotId, raw && raw.version === 1 && Array.isArray(raw.sweeps) ? raw : { version: 1, sweeps: [] });
    return engine;
  }

  slotFile(slotId: string): SlotFile {
    return this.slotFiles.get(slotId) ?? { version: 1, sweeps: [] };
  }

  async updateSlotFile(slotId: string, fn: (f: SlotFile) => void): Promise<void> {
    const next = JSON.parse(JSON.stringify(this.slotFile(slotId))) as SlotFile;
    fn(next);
    await writeFileAtomic(join(this.slotDir(slotId), 'slot.json'), JSON.stringify(next, null, 2));
    this.slotFiles.set(slotId, next);
  }

  /** Slots that hold a guest wallet now (active or leaving), with their engines. */
  liveSlots(): { slot: SlotRecord; engine: HostedEngine }[] {
    return this.registry.live().flatMap((slot) => {
      const engine = this.engines.get(slot.slotId);
      return engine ? [{ slot, engine }] : [];
    });
  }

  // -------------------------------------------------------------------------
  // Routing by sender

  /** The guest slot whose paired phone (or a phone with recovery access) `sender` is. Never the host's phone or peers. */
  route(sender: string): GuestRoute | undefined {
    if (!this.enabled) return undefined;
    for (const { slot, engine } of this.liveSlots()) if (engine.registration()?.appNostrPubkey === sender) return { slot, engine, role: 'phone' };
    for (const { slot, engine } of this.liveSlots()) if (engine.hasRecoveryAccess(sender)) return { slot, engine, role: 'peer' };
    return undefined;
  }

  /** `sender` is the host's paired phone or holds recovery access to the host's wallet. */
  private hostPeer(sender: string): boolean {
    return this.g.engine.registration()?.appNostrPubkey === sender || this.g.hasRecoveryAccess(sender);
  }

  isGuestContact(sender: string): boolean {
    return this.enabled && this.liveSlots().some(({ engine }) => engine.isAlertContact(sender));
  }

  isKnownSender(sender: string): boolean {
    return !!this.route(sender) || this.isGuestContact(sender);
  }

  /**
   * Who may call what, for what hosting decides (`undefined`: the host's rules decide, unchanged): a guest's phone or
   * recovery peer is let through (its own slot's handlers answer, with a typed error for what guests may not call); a
   * stranger reaches `hosted.prepare` / `hosted.pair` while an invite is pending and `hosted.access` while a guest wallet
   * exists; a guest's alert contact reaches `recovery.cancel` (routed by recovery id).
   */
  authorize(sender: string, method: MethodName): boolean | undefined {
    if (!this.enabled) return undefined;
    if (this.hostPeer(sender)) return undefined;
    if (this.route(sender)) return true;
    if (method === 'hosted.prepare' || method === 'hosted.pair') return this.registry.answering(this.g.clock.now());
    if (method === 'hosted.access') return this.liveSlots().length > 0;
    if (method === 'recovery.cancel' && this.isGuestContact(sender)) return true;
    return undefined;
  }

  /** Every guest phone and recovery peer (for `relays_changed`). */
  phones(): string[] {
    const out = new Set<string>();
    for (const { engine } of this.liveSlots()) {
      const p = engine.registration()?.appNostrPubkey;
      if (p) out.add(p);
      for (const peer of engine.recoveryPeers()) out.add(peer);
    }
    return [...out];
  }

  /** Every key set a new slot must not register: the host's wallets and every slot's. */
  forbiddenKeySets(except?: string): Set<string> {
    const out = new Set<string>();
    for (const [id, e] of this.engines) if (id !== except) for (const k of e.keySets()) out.add(k);
    return out;
  }

  // -------------------------------------------------------------------------
  // Key 3 per slot

  /** Unlock: derives every live slot's key 3 from the seed and its record, and installs it. */
  installSigners(seed: GuardianSeed): void {
    this.dropSigners();
    for (const { slot, engine } of this.liveSlots()) {
      const reg = engine.registration();
      if (!slot.key3Mix || !reg) continue;
      try {
        const { signer } = seed.hostedKey3(reg.network, slot.key3Mix);
        try {
          engine.setSigner(signer);
          this.signers.set(slot.slotId, signer);
        } catch (e) {
          signer.wipe();
          this.g.log.error('hosting.key3_mismatch', { slot: slot.slotId, error: errorText(e) });
        }
      } catch (e) {
        this.g.log.error('hosting.key3_failed', { slot: slot.slotId, error: errorText(e) });
      }
    }
  }

  dropSigners(): void {
    for (const [id, s] of this.signers) {
      this.engines.get(id)?.setSigner(undefined);
      s.wipe();
    }
    this.signers.clear();
  }

  /** A freshly paired slot's key 3 (already in the engine). */
  adoptSigner(slotId: string, signer: KeystoreSigner): void {
    this.signers.get(slotId)?.wipe();
    this.signers.set(slotId, signer);
  }

  /** `trikey/key3-hosted/v1` for a slot and a phone. */
  key3Record(slotId: string, phonePubkey: string, entropy: string) {
    return hostedKey3Mix(entropy, hostedKey3Context({ network: this.g.config.network, slotId, phonePubkey }));
  }

  // -------------------------------------------------------------------------
  // Reset, stop hosting

  /** Reset rotates the seed, so every guest's key 3 would vanish: refused while any guest wallet is hosted (decision 9). */
  blocksReset(): SlotRecord | undefined {
    return this.registry.live()[0];
  }

  /**
   * "Stop hosting" (decision 8): by default 30 days' notice (the slot keeps co-signing and running recoveries meanwhile,
   * and its phone and contacts get a durable `hosting_ending` notice); `now` ends it at once, behind a typed
   * confirmation. Refused while the slot's recovery runs.
   */
  async stop(slotId: string, opts: { now?: boolean; confirm?: unknown } = {}): Promise<StopOutcome> {
    const slot = this.registry.slot(slotId);
    if (!slot || slot.removedAt) return { ok: false, code: 'not_found', message: 'No such hosted wallet.' };
    if (slot.state !== 'active' && slot.state !== 'leaving') return { ok: false, code: 'not_hosting', message: 'This wallet is not hosted any more.' };
    const engine = this.engines.get(slotId);
    const running = engine?.activeRecord();
    if (running) return { ok: false, code: 'recovery_pending', message: `A recovery of this wallet is running (until ${new Date(running.readyAt).toISOString().slice(0, 10)}). Hosting cannot stop until it completes or is cancelled.` };
    const now = this.g.clock.now();
    if (opts.now) {
      if (opts.confirm !== STOP_NOW_CONFIRMATION) return { ok: false, code: 'invalid', message: `Type ${STOP_NOW_CONFIRMATION} to confirm.` };
      const ended = await this.end(slotId, 'now');
      if (!ended.ok) return ended;
      return { ok: true, slot: this.registry.slot(slotId)! };
    }
    if (slot.state === 'leaving') return { ok: true, slot };
    const endsAt = now + STOP_HOSTING_NOTICE_MS;
    if (engine?.registration()) await engine.noteHostingEnding(endsAt);
    await this.registry.update((f) => {
      const s = f.slots.find((x) => x.slotId === slotId)!;
      s.state = 'leaving';
      s.endsAt = endsAt;
      s.stoppedAt = now;
    });
    await this.g.logEvent({ type: 'hosting_stopping', name: slot.name, endsAt });
    this.g.log.warn('hosting.stopping', { slot: slotId, endsAt: new Date(endsAt).toISOString() });
    void this.alerts.run();
    return { ok: true, slot: this.registry.slot(slotId)! };
  }

  /** Ends a slot: its wallet retires, its key 3 record is deleted (the key can no longer be derived), its phone is told. */
  private async end(slotId: string, how: 'now' | 'notice'): Promise<StopOutcome> {
    const engine = this.engines.get(slotId);
    const res = engine ? await engine.endHosting() : ({ ok: true } as const);
    if (!res.ok) return { ok: false, code: 'recovery_pending', message: 'A recovery of this wallet is running.' };
    const signer = this.signers.get(slotId);
    engine?.setSigner(undefined);
    signer?.wipe();
    this.signers.delete(slotId);
    const now = this.g.clock.now();
    const name = this.registry.slot(slotId)?.name ?? '';
    await this.registry.update((f) => {
      const s = f.slots.find((x) => x.slotId === slotId)!;
      s.state = 'ended';
      s.endedAt = now;
      delete s.key3Mix;
    });
    await this.g.logEvent({ type: 'hosting_ended', name, how });
    this.g.log.warn('hosting.ended', { slot: slotId, how });
    if ('phone' in res && res.phone && res.walletId) {
      await this.g.notifyPeer(res.phone, {
        type: 'wallet_retired',
        walletId: res.walletId,
        reason: 'hosting_ended',
        ...this.g.stampNow(),
        message: 'Your host stopped hosting this wallet. Its guardian key is gone: move your money with your phone and your hardware wallet (Replace guardian).',
      });
    }
    return { ok: true, slot: this.registry.slot(slotId)! };
  }

  /** A guest retired its wallet (`wallet.retire`): the slot is `left`, its key 3 record deleted. */
  async noteLeft(slotId: string): Promise<void> {
    const signer = this.signers.get(slotId);
    this.engines.get(slotId)?.setSigner(undefined);
    signer?.wipe();
    this.signers.delete(slotId);
    const name = this.registry.slot(slotId)?.name ?? '';
    await this.registry.update((f) => {
      const s = f.slots.find((x) => x.slotId === slotId)!;
      s.state = 'left';
      s.endedAt = this.g.clock.now();
      delete s.key3Mix;
    });
    await this.g.logEvent({ type: 'hosting_guest_left', name });
  }

  /** Removes an ended, left, cancelled or expired slot from the host's list (its files stay, for the record). */
  async remove(slotId: string): Promise<boolean> {
    const s = this.registry.slot(slotId);
    if (!s || s.removedAt || s.state === 'active' || s.state === 'leaving' || s.state === 'invited') return false;
    await this.registry.update((f) => void (f.slots.find((x) => x.slotId === slotId)!.removedAt = this.g.clock.now()));
    return true;
  }

  // -------------------------------------------------------------------------
  // Background work

  async tick(): Promise<void> {
    if (!this.enabled && !this.registry.slots.length) return;
    const now = this.g.clock.now();
    try {
      await this.registry.mutex.run(() => this.registry.expire(now));
      for (const { slot, engine } of this.liveSlots()) {
        await engine.tick();
        if (slot.state === 'leaving' && slot.endsAt !== undefined && now >= slot.endsAt && !engine.activeRecord()) await this.end(slot.slotId, 'notice');
      }
      await this.recovery.run();
      await this.alerts.run();
    } catch (e) {
      this.g.log.error('hosting.tick_failed', { error: errorText(e) });
    }
  }

  /** The host's web UI overview: names, states and dates only; no amounts, balances or addresses. */
  overview(): { slot: SlotRecord; engine?: HostedEngine }[] {
    return this.registry.slots.filter((s) => !s.removedAt).map((slot) => ({ slot, engine: this.engines.get(slot.slotId) }));
  }

  /** Hex of a slot's key 3 account pubkey, for logs and tests. */
  cosignerOf(slotId: string): string | undefined {
    return this.engines.get(slotId)?.registration()?.accountPubkeys.cosigner;
  }

  /** Sorted key-set key of the host's wallets (none here: the host's descriptor wallets are compared in their own engine). */
  static keySetOf(acct: { app: Uint8Array; hardware: Uint8Array; cosigner: Uint8Array }): string {
    return keySetKey({ app: hex.encode(acct.app), hardware: hex.encode(acct.hardware), cosigner: hex.encode(acct.cosigner) });
  }
}
