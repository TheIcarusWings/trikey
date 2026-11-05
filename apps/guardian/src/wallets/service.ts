/**
 * Own wallets, the service side (docs/design/multi-wallet.md, section 3): the registry (`wallets.json`), one `OwnWallet`
 * runtime per wallet the owner added, key 3 per wallet at its account, routing by `walletId`, the box-wide rules (lock,
 * unlock refused while any wallet's recovery the phone did not start runs, reset), and adding a wallet
 * (`wallet.add.prepare` / `wallet.add`).
 *
 * Every wallet shares the paired phone's seed and the key 3 seed of the first pairing (its `key3Mix`); only the hardware
 * wallet differs. Each sits at its own hardened BIP 48 account on both seeds, so nothing on chain links two wallets.
 *
 * A guardian with no own wallet has no `wallets.json`, and every code path runs exactly as before.
 */
import { join } from 'node:path';
import { hex } from '@scure/base';
import { MultisigWallet, getNetwork, type NetworkName } from '@trikey/core';
import { ErrorCode, RpcError, type Handlers, type MethodName, type Params, type Result } from '@trikey/protocol';
import type { Guardian } from '../guardian.js';
import { RECOVERY_PEER_METHODS } from '../guardian.js';
import type { GuardianSeed, KeystoreSigner } from '../keystore.js';
import { errorText } from '../log.js';
import { onceAcrossRestarts, walletHandlers, walletOf } from '../nostr/handlers.js';
import { refusalError, rulesFromPolicy } from '../nostr/wire.js';
import type { Registration } from '../policy/index.js';
import { labelled } from '../runtime.js';
import { WalletsRegistry, type OwnWalletRecord } from './registry.js';
import { OwnWallet, WALLETS_DIR, type OwnWalletHost } from './runtime.js';

export const WALLETS_FILE = 'wallets.json';
/** What the first wallet is called in alerts while the phone has not named it. */
export const DEFAULT_FIRST_NAME = 'First wallet';

/** An own wallet's recovery id: `<slotId>w<n>-<txid12>` (fits the protocol's `RecoveryId` and the `CANCEL` DM's pattern). */
export const OWN_RECOVERY_ID = /^([0-9a-f]{16})w\d+-[0-9a-f]{12}$/;

export function slotOfOwnRecoveryId(id: unknown): string | undefined {
  const m = typeof id === 'string' ? OWN_RECOVERY_ID.exec(id) : null;
  return m ? m[1] : undefined;
}

/** The methods a request may name a wallet in (`walletId`), and that work on each own wallet. */
export const ROUTED_METHODS: readonly MethodName[] = [
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
  'wallet.sync',
  'tx.get',
  'tx.broadcast',
];

/** What the box shares: an own wallet's phone may call them as the first wallet's does. */
export const BOX_METHODS: readonly MethodName[] = ['guardian.unlock', 'guardian.lock', 'relays.ack', 'fees.estimate'];

const bip48Path = (coin: number, account: number) => `48h/${coin}h/${account}h/2h`;

export type AddOutcome = Result<'wallet.add'>;

export class OwnWallets implements OwnWalletHost {
  readonly registry: WalletsRegistry;
  private readonly runtimes = new Map<string, OwnWallet>();
  private readonly handlerSets = new Map<string, Handlers>();

  constructor(private readonly g: Guardian) {
    this.registry = new WalletsRegistry(join(g.config.dataDir, WALLETS_FILE));
  }

  async load(): Promise<void> {
    await this.registry.load();
    for (const rec of this.registry.wallets) {
      const w = new OwnWallet(this.g, rec, this);
      await w.open();
      this.runtimes.set(rec.slotId, w);
    }
  }

  /** Every own wallet after the first, retired ones included, by account. */
  get all(): OwnWallet[] {
    return [...this.runtimes.values()].sort((a, b) => a.account - b.account);
  }

  /** Own wallets after the first that co-sign (registered, not retired). */
  active(): OwnWallet[] {
    return this.all.filter((w) => w.active);
  }

  bySlot(slotId: string): OwnWallet | undefined {
    return this.runtimes.get(slotId);
  }

  /** The active own wallet whose current wallet id is `walletId`. */
  byWalletId(walletId: string): OwnWallet | undefined {
    return this.active().find((w) => w.engine.registration()?.walletId === walletId);
  }

  /** The own wallet a recovery id belongs to (`<slotId>w<n>-...`). */
  byRecoveryId(recoveryId: unknown): OwnWallet | undefined {
    const slot = slotOfOwnRecoveryId(recoveryId);
    return slot ? this.runtimes.get(slot) : undefined;
  }

  /** Own wallets `sender` is the paired phone of, or holds recovery access to. */
  forSender(sender: string): OwnWallet[] {
    return this.active().filter((w) => w.phone() === sender || w.hasRecoveryAccess(sender));
  }

  /** How many wallets the box guards now, the first included. */
  count(): number {
    return (this.g.engine.registration() ? 1 : 0) + this.active().length;
  }

  // ---------------------------------------------------------------------------
  // Names

  label(w: OwnWallet): string | undefined {
    return this.count() > 1 ? w.name : undefined;
  }

  /** The first wallet's name in alerts while the box has more than one wallet. */
  firstLabel(): string | undefined {
    return this.active().length ? (this.registry.firstName ?? DEFAULT_FIRST_NAME) : undefined;
  }

  async markRetired(slotId: string, at: number): Promise<void> {
    await this.registry.update((f) => {
      const r = f.wallets.find((x) => x.slotId === slotId);
      if (r && r.retiredAt === undefined) r.retiredAt = at;
    });
  }

  // ---------------------------------------------------------------------------
  // Routing

  /** An own wallet's methods (wallets/handlers.ts routes a request here by its `walletId`). */
  handlersOf(w: OwnWallet): Handlers {
    let h = this.handlerSets.get(w.slotId);
    if (!h) {
      h = onceAcrossRestarts(this.g, walletHandlers(this.g, w));
      this.handlerSets.set(w.slotId, h);
    }
    return h;
  }

  /**
   * Who may call what on account of own wallets (`Guardian.authorize`, after the host's own rules): an own wallet's paired
   * phone its wallet's methods and the box's; a phone with recovery access to one the recovery methods; its alert contacts
   * `recovery.cancel`; anyone `recovery.access` (a hardware signature decides). Undefined: no say.
   */
  authorize(sender: string, method: MethodName): boolean | undefined {
    const active = this.active();
    if (!active.length) return undefined;
    if (active.some((w) => w.phone() === sender) && (ROUTED_METHODS.includes(method) || BOX_METHODS.includes(method))) return true;
    if (RECOVERY_PEER_METHODS.has(method) && active.some((w) => w.hasRecoveryAccess(sender))) return true;
    if (method === 'recovery.cancel' && active.some((w) => w.isAlertContact(sender))) return true;
    if (method === 'recovery.access') return true;
    return undefined;
  }

  isKnownSender(sender: string): boolean {
    return this.active().some((w) => w.phone() === sender || w.isAlertContact(sender) || w.hasRecoveryAccess(sender));
  }

  /** Whether `sender` may act on `w` with `method`. */
  mayAct(w: OwnWallet, sender: string, method: MethodName): boolean {
    if (w.phone() === sender) return true;
    if (RECOVERY_PEER_METHODS.has(method) && w.hasRecoveryAccess(sender)) return true;
    return method === 'recovery.cancel' && w.isAlertContact(sender);
  }

  // ---------------------------------------------------------------------------
  // Lock and unlock: box-wide

  /** Every own wallet's key 3 from the unlocked seed (each at its account of the first pairing's key 3 seed). */
  installSigners(seed: GuardianSeed): void {
    for (const w of this.all) w.installSigner(seed);
  }

  dropSigners(): void {
    for (const w of this.all) w.dropSigner();
  }

  /** The first running recovery of an own wallet that `phone` did not start, if any (the phone may then not unlock). */
  recoveryNotStartedBy(phone: string | undefined): { wallet: OwnWallet; id: string } | undefined {
    for (const w of this.active()) {
      const rec = w.activeRecord();
      if (!rec) continue;
      const mine = w.phone();
      const startedByPhone = rec.initiator !== undefined ? rec.initiator === phone : rec.survivingRole === 'app' && mine === phone;
      if (!startedByPhone) return { wallet: w, id: rec.id };
    }
    return undefined;
  }

  /** A running recovery of any own wallet. */
  recoveryRunning(): { wallet: OwnWallet; id: string } | undefined {
    for (const w of this.active()) {
      const rec = w.activeRecord();
      if (rec) return { wallet: w, id: rec.id };
    }
    return undefined;
  }

  /** A co-signed sweep of an own wallet still waiting to be broadcast. */
  unsentSweep(): { wallet: OwnWallet; recoveryId: string } | undefined {
    for (const w of this.all) {
      const s = w.sweepStore.get().sweeps.find((x) => x.broadcastAt === undefined && x.deadAt === undefined);
      if (s) return { wallet: w, recoveryId: s.recoveryId };
    }
    return undefined;
  }

  /** Background work of every own wallet; one wallet's failure does not hold the others back. */
  async tick(): Promise<void> {
    for (const w of this.all) {
      try {
        await w.tick();
      } catch (e) {
        this.g.log.error('wallets.tick_failed', { slot: w.slotId, error: errorText(e) });
      }
    }
  }

  /**
   * The guardian's reset: every own wallet is forgotten with the first (their key 3 goes with the old seed). Their phones
   * are told. The accounts stay taken. The caller checked that no recovery runs and no sweep waits.
   */
  async reset(): Promise<string[]> {
    const forgotten: string[] = [];
    for (const w of this.all) {
      const reg = w.engine.registration();
      if (reg) await w.notifyPhone({ type: 'wallet_retired', walletId: reg.walletId, reason: 'reset', ...this.g.stampNow() });
      w.dropSigner();
      const res = await w.engine.reset();
      if (res.ok) forgotten.push(...res.forgotten);
    }
    if (this.registry.exists) await this.registry.update((f) => void (f.wallets = []));
    this.runtimes.clear();
    this.handlerSets.clear();
    return forgotten;
  }

  // ---------------------------------------------------------------------------
  // What the phone and the web UI read

  /** `guardian.status.wallets`: every own wallet of the box, the first included, once there is more than one. */
  summaries(): Result<'guardian.status'>['wallets'] {
    const own = this.all.filter((w) => w.active || w.engine.retiredWallets().length);
    if (!own.length) return undefined;
    const first = this.g.engine.registration();
    const out: NonNullable<Result<'guardian.status'>['wallets']> = [];
    if (first) out.push(summary(first, 0, this.registry.firstName));
    for (const w of own) {
      const reg = w.engine.registration() ?? w.engine.retiredWallets().at(-1)?.registration;
      if (reg) out.push({ ...summary(reg, w.account, w.name), state: w.active ? 'active' : 'retired' });
    }
    return out;
  }

  // ---------------------------------------------------------------------------
  // Adding a wallet

  /** Why `sender` may not add a wallet now, as a protocol error. */
  private requireFirstPhone(sender: string): Registration {
    const first = this.g.engine.registration();
    if (!first) throw refusalError({ reason: 'not_registered' });
    if (first.appNostrPubkey !== sender) throw new RpcError(ErrorCode.Unauthorized, 'Only the phone paired with the first wallet adds wallets.');
    if (this.g.locked) throw new RpcError(ErrorCode.GuardianLocked);
    return first;
  }

  private requireAccount(account: number): void {
    const why = this.registry.refuseAccount(account);
    if (why) throw new RpcError(ErrorCode.InvalidParams, why, { reason: 'account_unavailable', ...(this.registry.nextAccount() !== undefined ? { nextAccount: this.registry.nextAccount() } : {}) });
  }

  /** `wallet.add.prepare`: key 3 of the new wallet at `account`. Reserves nothing. */
  prepare(sender: string, params: Params<'wallet.add.prepare'>): Result<'wallet.add.prepare'> {
    const first = this.requireFirstPhone(sender);
    this.requireAccount(params.account);
    const key = this.g.ownKey3(first, params.account);
    key.signer.wipe();
    return { account: params.account, guardianKey: { fingerprint: key.pub.fingerprint, path: key.pub.path, xpub: key.pub.xpub } };
  }

  /**
   * `wallet.add`: checks what `pair` checks (the engine's `register`), and that the phone key is the paired seed's at
   * `account` and no hardware key is in another wallet of this guardian; creates the slot and announces it.
   */
  async add(sender: string, params: Params<'wallet.add'>): Promise<AddOutcome> {
    const g = this.g;
    const first = this.requireFirstPhone(sender);
    this.requireAccount(params.account);
    const network = getNetwork(first.network);
    const reject = async (message: string, reason = 'invalid_wallet'): Promise<never> => {
      await g.logEvent({ type: 'wallet_add_refused', name: params.name, detail: message });
      throw new RpcError(ErrorCode.InvalidParams, message, { reason });
    };
    let wallet: MultisigWallet;
    try {
      wallet = MultisigWallet.fromDescriptor(params.descriptor, network);
    } catch (e) {
      return reject(`Invalid descriptor: ${errorText(e)}`);
    }
    const firstWallet = walletOf(first);
    // The phone's key: the paired phone seed's (the first wallet's fingerprint), at this wallet's account.
    const app = wallet.keys.app;
    if (app.fingerprint !== firstWallet.keys.app.fingerprint || app.originPath !== bip48Path(network.coinType, params.account))
      return reject(`The phone key must be this phone's key at account ${params.account}' (m/48'/${network.coinType}'/${params.account}'/2').`);
    // A different device: none of its keys may be in another wallet of this guardian (decision: refused, also as a
    // Savings Recovery Key), or it would appear in two wallets.
    const hwFp = wallet.keys.hardware.fingerprint;
    const taken = this.hardwareFingerprints();
    if (taken.has(hwFp))
      return reject(`This hardware wallet (${hwFp}) already holds a key in ${taken.get(hwFp)}. Each wallet needs its own hardware wallet.`, 'hardware_in_use');
    const accountKeys = new Set([firstWallet, ...this.active().map((w) => walletOf(w.engine.registration()!))].flatMap((x) => Object.values(x.accountPubkeys()).map((k) => hex.encode(k))));
    if (Object.values(wallet.accountPubkeys()).some((k) => accountKeys.has(hex.encode(k)))) return reject('A key of this wallet is already in another wallet of this guardian.', 'key_in_use');

    const key = g.ownKey3(first, params.account);
    const slotId = this.registry.newSlotId();
    const rec: OwnWalletRecord = { slotId, account: params.account, name: params.name, addedAt: g.clock.now() };
    const w = new OwnWallet(g, rec, this);
    let res: Awaited<ReturnType<typeof w.engine.register>>;
    try {
      await w.open();
      // A new engine starts locked; this wallet's key 3 is its signer from the registration on (the box is unlocked).
      w.engine.setSigner(key.signer);
      res = await w.engine.register({
        network: first.network,
        descriptor: params.descriptor,
        cosignerAccountPubkey: key.pub.accountPubkey,
        rules: rulesFromPolicy(params.rules),
        hardwareAuth: { kind: 'bip137', pubkey: params.hardwareAuth.pubkey, path: params.hardwareAuth.path },
        hardwareAuthProof: params.hardwareAuthProof,
        appNostrPubkey: sender,
        // The same key 3 seed as the first wallet: one record covers every own wallet.
        ...(first.key3Mix ? { key3Mix: first.key3Mix } : {}),
        signer: key.signer,
      });
    } catch (e) {
      key.signer.wipe();
      throw e;
    }
    if (!res.ok) {
      key.signer.wipe();
      await g.logEvent({ type: 'wallet_add_refused', name: params.name, detail: res.refusal.reason });
      throw refusalError(res.refusal);
    }
    // The registration is on disk in its slot; the registry makes it a wallet of the box (a crash in between leaves an
    // unused directory, and the account free).
    await this.registry.update((f) => {
      f.wallets.push(rec);
      if (!f.accounts.includes(rec.account)) f.accounts.push(rec.account);
      f.accounts.sort((a, b) => a - b);
      if (params.firstName) f.first = { name: params.firstName };
    });
    this.runtimes.set(slotId, w);
    w.adoptSigner(key.signer as KeystoreSigner);
    await w.sweepStore.update((d) => {
      d.phones = [{ pubkey: sender, name: 'Phone', pairedAt: g.clock.now() }];
    });
    const reg = w.engine.registration()!;
    g.log.info('wallets.added', { slot: slotId, account: rec.account, walletId: reg.walletId });
    await g.logEvent({ type: 'wallet_added', name: rec.name, account: rec.account, walletId: reg.walletId });
    await w.notifyPhone({
      type: 'wallet_added',
      walletId: reg.walletId,
      account: rec.account,
      name: rec.name,
      ...g.stampNow(),
      message: `A wallet was added to your guardian: "${rec.name}". If you did not do this, check the guardian now.`,
    });
    g.notifyOwner('wallet_added', labelled(w, `A wallet was added to your guardian with your phone and a new hardware wallet (${reg.walletId}). If you did not do this, check the guardian now.`), reg.walletId);
    // Now that the box has several wallets, the live wallet watches this one too.
    g.live?.changed('wallets');
    return { walletId: reg.walletId, account: rec.account, name: rec.name, descriptor: reg.descriptor, guardianKey: { fingerprint: key.pub.fingerprint, path: key.pub.path, xpub: key.pub.xpub } };
  }

  /** Master fingerprints of every hardware key the box's wallets hold (the first's, its Savings', every own wallet's), and where. */
  hardwareFingerprints(): Map<string, string> {
    const out = new Map<string, string>();
    const first = this.g.engine.registration();
    const firstName = this.registry.firstName ?? DEFAULT_FIRST_NAME;
    if (first) {
      const fw = walletOf(first);
      out.set(fw.keys.hardware.fingerprint, `"${firstName}"`);
      const sv = this.g.engine.savings();
      if (sv) {
        try {
          const s = MultisigWallet.fromDescriptor(sv.descriptor, getNetwork(sv.network as NetworkName));
          for (const k of [s.keys.app, s.keys.hardware, s.keys.cosigner]) if (k.fingerprint !== fw.keys.app.fingerprint && !out.has(k.fingerprint)) out.set(k.fingerprint, `the Savings of "${firstName}"`);
        } catch {
          /* not parsed: nothing to compare */
        }
      }
    }
    for (const w of this.active()) out.set(walletOf(w.engine.registration()!).keys.hardware.fingerprint, `"${w.name}"`);
    return out;
  }
}

function summary(reg: Registration, account: number, name: string | undefined): NonNullable<Result<'guardian.status'>['wallets']>[number] {
  return {
    walletId: reg.walletId,
    account,
    ...(name ? { name } : {}),
    descriptor: reg.descriptor,
    ...(reg.hardwareAuth && reg.hardwareAuthConfirmed ? { hardwareAuth: { pubkey: reg.hardwareAuth.pubkey, path: reg.hardwareAuth.path } } : {}),
  };
}

export { WALLETS_DIR };
