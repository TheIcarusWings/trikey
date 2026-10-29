/**
 * `RecoveryKeyWallet`: Recovery Key mode as the phone app uses it, one method
 * per thing the RK screens do.
 *
 *   RK-Create   create, connectHardware, createRecoveryKit | useHardwareRecoveryKey, confirmKitSaved
 *   RK-Refills  previewRefills, approveRefills
 *   RK-Home     sync / home, runScheduler, send, receiveAddress, speedUpRefill, payFromVault
 *   RK-Recover  readKit, recoverWithKit (static: kit + hardware on a new phone;
 *               instance: kit + this phone), replaceRecoveryKey (phone + hardware)
 *
 * Like `TrikeyWallet`, it keeps non-secret state in the app's `KeyValueStore`
 * (with a MAC, see `state.ts`), key 2 in the `SecureKeyStore` behind
 * biometrics (loaded only to sign), and reaches hardware wallets through the
 * app's `HardwareProvider`. Chain data comes from an Esplora server.
 *
 * Mainnet is refused unless `allowMainnet` is set; the app does not set it
 * during the alpha.
 */
import { base64, hex } from '@scure/base';
import * as btc from '@scure/btc-signer';
import { HDKey } from '@scure/bip32';
import { mnemonicToSeedSync } from '@scure/bip39';
import {
  CHANGE,
  MultisigWallet,
  RECEIVE,
  SoftwareSigner,
  TX_OPTS,
  analyzePsbt,
  bip48Path,
  buildSpend,
  combinePsbts,
  finalizePsbt,
  getNetwork,
  parsePsbt,
  SEQUENCE_RBF,
  encodeRelativeBlocks,
  type KeyExpression,
  type Network,
  type NetworkName,
  type Role,
} from '@trikey/core';
import type { HardwareKind, HardwareProvider, HardwareSigner, HardwareWalletPolicy, KeyValueStore, SecureKeyStore } from '@trikey/wallet';
import { RecoveryKeyError, asRandomSourceError, type RecoveryKeyErrorCode } from './errors.js';
import { DUST_SATS, chooseRefillFeeRate, defaultRefillFeePolicy, estimateFor, refillVsize, type FeeRates } from './fees.js';
import { BIP39_WORDLIST, deriveKey2, entropyFromMnemonic, keyFromDevice, mnemonicFromEntropy, newPhoneMnemonic, newRecoveryKeyEntropy, recoveryKeyFromEntropy, vaultAccountOf } from './keys.js';
import { decodeKit, encodeKitBytes, formatFingerprint, kitMnemonic, kitRecoveryKeyExpression, kitVault, tokenizeWords, wipeKit, type RecoveryKit } from './kit.js';
import { renderKit, type KitPrintOptions, type PrintableKit } from './kit-print.js';
import {
  DEFAULT_PERIOD_BLOCKS,
  REFILL_CHANGE_VOUT,
  REFILL_SPEND_VOUT,
  buildRefillChain,
  chainTail,
  finalizeRefill,
  maxRefills,
  refillPromptText,
  verifyRefillChain,
  type ChainHead,
  type RefillChainRecord,
  type StoredRefill,
  type UnsignedRefill,
  type VaultCoin,
} from './refills.js';
import { refillStates, summarizeChain, type ChainSummary, type ChainView, type RefillState } from './chain-state.js';
import { decide, type Decision } from './scheduler.js';
import { SPENDING_INTERNAL, SPENDING_RECEIVE, SpendingAccount, buildCpfpChild, buildSpendingPayment, finalizeSpending, signSpendingPsbt, type SpendingCoin } from './spending.js';
import { scanAccount, type EsploraClient, type ScanResult } from './esplora.js';
import { DEFAULT_SWEEP_FEE_CAP_SATS, buildVaultSweep, gatherVaultCoins, signVaultTx, type VaultSigner } from './recovery.js';
import { decodeRawTx, vsizeOf } from './script-verify.js';
import { StateStore, type HardwareRecord, type RkAlert, type RkConfig, type RkState } from './state.js';
import { secureRandomBytes } from '@trikey/core/random';

export interface Clock {
  now(): number;
}

export interface RecoveryKeyDeps {
  network: NetworkName;
  /** Required for network `bitcoin`. The app does not set it during the alpha. */
  allowMainnet?: boolean;
  secureStore: SecureKeyStore;
  store: KeyValueStore;
  hardware?: HardwareProvider;
  /** Chain data. Point it at your own server (see `PUBLIC_SERVER_PRIVACY_NOTE`). */
  esplora: EsploraClient;
  clock?: Clock;
  storageKey?: string;
  /** Overrides for a new wallet's settings. */
  config?: Partial<RkConfig>;
}

/** A hardware wallet that can sign several PSBTs in one session (one confirmation flow). Optional. */
export interface BatchHardwareSigner extends HardwareSigner {
  signPsbts(psbtsBase64: string[], wallet: HardwareWalletPolicy): Promise<string[]>;
}

const isBatchSigner = (hw: HardwareSigner): hw is BatchHardwareSigner => typeof (hw as BatchHardwareSigner).signPsbts === 'function';

export type RkEvent =
  | { type: 'state' }
  /** The hardware wallet is about to be asked: show this so the user can compare it with the device screen. */
  | { type: 'hardware_prompt'; purpose: 'refills' | 'vault-payment' | 'recovery-sweep' | 'register' | 'address'; text: string; step?: number; steps?: number }
  | { type: 'refill_broadcast'; position: number; txid: string }
  /** A refill was broadcast, but not by this phone: someone else has the signed chain. */
  | { type: 'unexpected_broadcast'; position: number; txid: string }
  | { type: 'refills_invalidated'; position: number; spentBy?: string; byThisPhone: boolean }
  /** A vault coin moved in a transaction this phone did not make: two keys are in other hands. */
  | { type: 'foreign_vault_spend'; txid: string }
  | { type: 'refills_low'; left: number }
  | { type: 'refills_exhausted' }
  | { type: 'cpfp_suggested'; position: number; txid: string; childFeeSats: number; targetRate: number; parentRate: number };

/** Proof that the kit is saved: a scan of the printed QR code, or the words at the asked positions. */
export type KitProof = { scanned: string } | { words: Record<number, string> } | { mapSaved: true };

export interface HardwareSummary {
  kind: HardwareKind;
  model?: string;
  fingerprint: string;
  xpub: string;
}

export interface VaultSummary {
  descriptor: string;
  fingerprint: string;
  firstAddress: string;
  addressVerified: boolean;
}

export interface RefillScheduleItem {
  position: number;
  amountSats: number;
  /** Earliest block it can confirm in, if everything before it confirms as early as allowed. */
  earliestHeight: number;
  /** When that is, at ten minutes a block (ms since the epoch). */
  earliestAt: number;
}

export interface RefillPreview {
  mode: 'fresh' | 'extend';
  amountSats: number;
  count: number;
  maxCount: number;
  periodBlocks: number;
  feeRate: number;
  feeRateSource: 'estimate' | 'floor' | 'capped';
  feePerRefillSats: number;
  totalSats: number;
  vaultBalanceSats: number;
  schedule: RefillScheduleItem[];
}

export interface HomeState {
  tipHeight: number;
  syncedAt: number;
  spending: { confirmedSats: number; unconfirmedSats: number; totalSats: number };
  vault: { confirmedSats: number; unconfirmedSats: number; totalSats: number };
  nextRefill?: {
    position: number;
    amountSats: number;
    /** ready: can go now; waiting: timelocked; arriving: in the mempool; pending: after the previous one confirms. */
    status: 'ready' | 'waiting' | 'arriving' | 'pending';
    atHeight?: number;
    inBlocks?: number;
    etaMs?: number;
  };
  refills: { left: number; total: number; status: ChainSummary['status']; needsApproval: boolean; invalidated?: ChainSummary['invalidated'] };
  alerts: RkAlert[];
  activity: { txid: string; kind: 'refill' | 'sent' | 'received' | 'speed_up'; netSats: number; height: number; position?: number }[];
}

export interface SendQuote {
  address: string;
  amountSats: number;
  feeSats: number;
  feeRate: number;
  totalSats: number;
  inputs: { txid: string; vout: number }[];
  changeIndex: number;
}

interface Synced {
  at: number;
  tip: number;
  vault: ScanResult;
  spending: ScanResult;
  states: RefillState[];
  summary: ChainSummary;
  rates: FeeRates;
}

const BLOCK_MS = 600_000;

function refuseMainnet(deps: { network: NetworkName; allowMainnet?: boolean }): Network {
  if (deps.network === 'bitcoin' && !deps.allowMainnet) throw new RecoveryKeyError('mainnet_refused', 'Recovery Key mode is test-network only for now (set allowMainnet to override).');
  return getNetwork(deps.network);
}

function defaultConfig(network: NetworkName, over: Partial<RkConfig> = {}): RkConfig {
  const amount = over.refillAmountSats ?? 200_000;
  return {
    refillAmountSats: amount,
    refillCount: 8,
    periodBlocks: DEFAULT_PERIOD_BLOCKS,
    topUpBelowSats: amount,
    lowRefillsAt: 2,
    refillFeePolicy: defaultRefillFeePolicy(network),
    sweepFeeCapSats: DEFAULT_SWEEP_FEE_CAP_SATS,
    feeTarget: 3,
    ...over,
  };
}

/** Merges `returned` into `ours` and checks it is the same transaction, now signed by `role` on every input. */
function checkSignedBy(ours: Uint8Array, returned: Uint8Array, vault: MultisigWallet, role: Role, who: string): Uint8Array {
  try {
    const merged = combinePsbts([ours, returned]);
    const a = analyzePsbt(merged, vault.accountPubkeys(), vault.network);
    if (a.txid !== parsePsbt(ours).id) throw new Error('the transaction changed');
    if (a.inputs.some((i) => !i.signedBy.includes(role))) throw new Error('not every input is signed');
    return merged;
  } catch (e) {
    throw new RecoveryKeyError('hardware_invalid_response', `${who} returned a bad signature: ${(e as Error).message}`, { cause: e });
  }
}

function wordMatches(typed: string, word: string): boolean {
  const t = tokenizeWords(typed)[0] ?? '';
  if (t === word) return true;
  if (t.length < 4) return false;
  const hits = BIP39_WORDLIST.filter((w) => w.startsWith(t.slice(0, 4)));
  return hits.length === 1 && hits[0] === word;
}

function randomPositions(n: number, of: number): number[] {
  const picked = new Set<number>();
  const r = secureRandomBytes(32);
  let i = 0;
  while (picked.size < n) picked.add((r[i++ % 32]! + i) % of + 1);
  return [...picked].sort((a, b) => a - b);
}

/** Connects through `provider` and checks the device is `fingerprint`. */
async function withDevice<T>(provider: HardwareProvider | undefined, fingerprint: string, kind: HardwareKind | undefined, fn: (hw: HardwareSigner) => Promise<T>, reuse?: HardwareSigner): Promise<T> {
  const session = reuse && reuse.info.fingerprint === fingerprint ? reuse : undefined;
  if (!session && !provider) throw new RecoveryKeyError('hardware_unavailable', 'No hardware wallet connection is available.');
  const hw = session ?? (await provider!.connect({ kind }));
  try {
    if (hw.info.fingerprint !== fingerprint) throw new RecoveryKeyError('hardware_mismatch', `Connect the device with fingerprint ${fingerprint}, not ${hw.info.fingerprint}.`);
    return await fn(hw);
  } finally {
    if (!session) await hw.close().catch(() => {});
  }
}

async function readDeviceKey(hw: HardwareSigner, network: Network, account: number): Promise<KeyExpression> {
  try {
    return keyFromDevice(hw.info.fingerprint, await hw.getXpub(bip48Path(network, account)), network, account);
  } catch (e) {
    throw new RecoveryKeyError('hardware_invalid_response', `The hardware wallet returned an unusable key: ${(e as Error).message}`, { cause: e });
  }
}

function deviceSigner(hw: HardwareSigner, policy: HardwareWalletPolicy, role: Role, label: string, onPrompt?: (text: string) => void, text?: string): VaultSigner {
  return {
    role,
    label,
    sign: async (psbt) => {
      if (text) onPrompt?.(text);
      return base64.decode(await hw.signPsbt(base64.encode(psbt), policy));
    },
  };
}

function seedSigner(mnemonic: string, role: Role, label: string, network: Network): VaultSigner {
  return { role, label, sign: (psbt) => new SoftwareSigner(role, mnemonic, label).signPsbt(psbt, network) };
}

async function registerOn(hw: HardwareSigner, name: string, descriptor: string, emit?: (e: RkEvent) => void): Promise<HardwareWalletPolicy> {
  emit?.({ type: 'hardware_prompt', purpose: 'register', text: `Register the wallet "${name}" on your device` });
  const { hmac } = await hw.registerWallet({ name, descriptor });
  return { name, descriptor, ...(hmac ? { registration: { hmac } } : {}) };
}

export class RecoveryKeyWallet {
  readonly network: Network;
  private s: RkState;
  private readonly clock: Clock;
  private readonly listeners = new Set<(e: RkEvent) => void>();
  private saving: Promise<void> = Promise.resolve();
  private hwSession?: HardwareSigner;
  /** Key 3 while the kit is being saved: in memory only, wiped on confirmation. */
  private pendingKit?: { kit: RecoveryKit; positions: number[]; device?: { kind: HardwareKind; model?: string; fingerprint: string } };
  private synced?: Synced;
  private vaultCache?: { descriptor: string; wallet: MultisigWallet; addresses: Map<string, { address: string; script: Uint8Array }> };

  private constructor(
    private readonly deps: RecoveryKeyDeps,
    state: RkState,
    private readonly store: StateStore,
  ) {
    this.network = getNetwork(deps.network);
    this.clock = deps.clock ?? { now: () => Date.now() };
    this.s = state;
  }

  // ===========================================================================
  // Creating and opening

  /** Creates key 2 (fresh from `secureRandomBytes`, or `mnemonic` to import one) and a new wallet with no vault yet. */
  static async create(deps: RecoveryKeyDeps, opts: { mnemonic?: string } = {}): Promise<RecoveryKeyWallet> {
    const network = refuseMainnet(deps);
    const store = new StateStore(deps.store, deps.secureStore, deps.storageKey);
    if (await store.exists()) throw new RecoveryKeyError('wallet_exists', 'This phone already has a Recovery Key wallet.');
    let mnemonic: string;
    try {
      mnemonic = opts.mnemonic ?? newPhoneMnemonic();
    } catch (e) {
      throw asRandomSourceError(e);
    }
    const pub = deriveKey2(mnemonic, network);
    const key2Id = `${store.key}.key2.${hex.encode(secureRandomBytes(8))}`;
    const entropy = entropyFromMnemonic(mnemonic);
    try {
      await deps.secureStore.save(key2Id, entropy, { requireBiometrics: true });
    } finally {
      entropy.fill(0);
    }
    await store.init();
    const clock = deps.clock ?? { now: () => Date.now() };
    const state: RkState = {
      v: 1,
      network: network.name,
      createdAt: clock.now(),
      stage: 'new',
      secrets: { key2: key2Id },
      key2: pub,
      indices: { vaultReceive: 0, vaultChange: 0, spendingReceive: 0, spendingInternal: 0 },
      config: defaultConfig(network.name, deps.config),
      ownTxids: [],
      ownVaultSpends: [],
      reported: [],
      alerts: [],
      previousVaults: [],
    };
    await store.save(state);
    return new RecoveryKeyWallet(deps, state, store);
  }

  /** The wallet on this phone, checked (MAC, then the refill chain's links and signatures); undefined if none. */
  static async open(deps: RecoveryKeyDeps): Promise<RecoveryKeyWallet | undefined> {
    refuseMainnet(deps);
    const store = new StateStore(deps.store, deps.secureStore, deps.storageKey);
    const state = await store.load();
    if (!state) return undefined;
    if (state.network !== deps.network) throw new RecoveryKeyError('network_mismatch', `The saved wallet is on ${state.network}, not ${deps.network}.`);
    const w = new RecoveryKeyWallet(deps, state, store);
    if (state.chain) verifyRefillChain(state.chain, { vault: w.vault(), spending: w.spendingAccount() });
    return w;
  }

  get state(): Readonly<RkState> {
    return this.s;
  }

  on(listener: (e: RkEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(e: RkEvent): void {
    for (const l of this.listeners) {
      try {
        l(e);
      } catch {
        /* a listener's failure is its own */
      }
    }
  }

  private async update(fn: (s: RkState) => void): Promise<void> {
    const run = this.saving.then(async () => {
      const next = JSON.parse(JSON.stringify(this.s)) as RkState;
      fn(next);
      await this.store.save(next);
      this.s = next;
    });
    this.saving = run.catch(() => {});
    await run;
    this.emit({ type: 'state' });
  }

  async close(): Promise<void> {
    const hw = this.hwSession;
    this.hwSession = undefined;
    await hw?.close().catch(() => {});
    this.dropPendingKit();
  }

  private dropPendingKit(): void {
    if (this.pendingKit) wipeKit(this.pendingKit.kit);
    this.pendingKit = undefined;
  }

  /** Removes key 2 and the state from this phone. */
  async forget(): Promise<void> {
    await this.close();
    await this.deps.secureStore.remove(this.s.secrets.key2);
    await this.store.clear();
  }

  // ===========================================================================
  // Keys

  private async withKey2<T>(reason: string, fn: (mnemonic: string) => Promise<T>): Promise<T> {
    let entropy: Uint8Array | null;
    try {
      entropy = await this.deps.secureStore.load(this.s.secrets.key2, reason);
    } catch (e) {
      throw new RecoveryKeyError('key_unavailable', 'The phone key could not be unlocked.', { cause: e });
    }
    if (!entropy) throw new RecoveryKeyError('key_unavailable', 'The phone key is missing from this phone.');
    let mnemonic: string;
    try {
      mnemonic = mnemonicFromEntropy(entropy);
    } finally {
      entropy.fill(0);
    }
    return fn(mnemonic);
  }

  private requireReady(): void {
    if (this.s.stage !== 'ready' || !this.s.vault) throw new RecoveryKeyError('wrong_state', 'The wallet is not set up yet.');
  }

  /** The vault as a core `MultisigWallet` (phone, hardware, Recovery Key = app, hardware, cosigner). */
  vault(): MultisigWallet {
    this.requireReady();
    const d = this.s.vault!.descriptor;
    if (this.vaultCache?.descriptor !== d) this.vaultCache = { descriptor: d, wallet: MultisigWallet.fromDescriptor(d, this.network), addresses: new Map() };
    return this.vaultCache.wallet;
  }

  /** A vault address (cached: deriving three keys per address adds up over a scan). */
  private vaultAddress(chain: number, index: number): { address: string; script: Uint8Array } {
    const vault = this.vault();
    const k = chain + '/' + index;
    let a = this.vaultCache!.addresses.get(k);
    if (!a) this.vaultCache!.addresses.set(k, (a = pickAddr(vault.derive(chain, index))));
    return a;
  }

  spendingAccount(): SpendingAccount {
    return new SpendingAccount(this.network, this.s.key2.spending);
  }

  private devicePolicy(descriptor = this.s.vault?.descriptor): HardwareWalletPolicy {
    const rec = this.s.hardware!;
    if (!descriptor) throw new RecoveryKeyError('wrong_state', 'No vault yet.');
    const hmac = rec.registered?.descriptor === descriptor ? rec.registered.hmac : undefined;
    return { name: rec.policyName, descriptor, ...(hmac ? { registration: { hmac } } : {}) };
  }

  private hardwareProvider(): HardwareProvider {
    if (!this.deps.hardware) throw new RecoveryKeyError('hardware_unavailable', 'No hardware wallet connection is available.');
    return this.deps.hardware;
  }

  private withHardware<T>(fn: (hw: HardwareSigner) => Promise<T>): Promise<T> {
    const rec = this.s.hardware;
    if (!rec) throw new RecoveryKeyError('wrong_state', 'No hardware wallet is set up.');
    return withDevice(this.deps.hardware, rec.fingerprint, rec.kind, fn, this.hwSession);
  }

  // ===========================================================================
  // RK-Create

  /** Step 1: connect the hardware wallet (key 1) and read its BIP 48 key. The session stays open for the next steps. */
  async connectHardware(opts: { kind?: HardwareKind; account?: number } = {}): Promise<HardwareSummary> {
    if (this.s.stage === 'ready') throw new RecoveryKeyError('wrong_state', 'This wallet is already set up.');
    const old = this.hwSession;
    this.hwSession = undefined;
    await old?.close().catch(() => {});
    const hw = await this.hardwareProvider().connect({ kind: opts.kind });
    try {
      const key = await readDeviceKey(hw, this.network, opts.account ?? 0);
      if (key.xpub === this.s.key2.vault.xpub || hw.info.fingerprint === this.s.key2.vault.fingerprint)
        throw new RecoveryKeyError('hardware_mismatch', 'That device holds the phone key.');
      const rec: HardwareRecord = { kind: hw.info.kind, model: hw.info.model, fingerprint: hw.info.fingerprint, key, policyName: 'Trikey RK', addressVerified: false };
      this.hwSession = hw;
      await this.update((s) => {
        s.hardware = rec;
        s.stage = 'hardware';
      });
      return { kind: rec.kind, model: rec.model, fingerprint: rec.fingerprint, xpub: key.xpub };
    } catch (e) {
      await hw.close().catch(() => {});
      throw e;
    }
  }

  /**
   * Step 2 (paper kit): makes key 3 in memory and renders the Recovery Kit.
   * Key 3 exists only in this object and on the printout until
   * `confirmKitSaved`, which wipes it. Calling again makes a new key 3.
   *
   * Key 3 is 16 bytes from `secureRandomBytes`: the same phone generator as key 2 (see DESIGN.md, "Entropy";
   * `useHardwareRecoveryKey` avoids that).
   */
  async createRecoveryKit(opts: KitPrintOptions = {}): Promise<PrintableKit> {
    if (this.s.stage !== 'hardware' || !this.s.hardware) throw new RecoveryKeyError('wrong_state', 'Connect the hardware wallet first.');
    const creationHeight = await this.deps.esplora.tipHeight();
    let entropy: Uint8Array;
    try {
      entropy = newRecoveryKeyEntropy();
    } catch (e) {
      throw asRandomSourceError(e);
    }
    this.dropPendingKit();
    const kit: RecoveryKit = {
      network: this.network.name,
      creationHeight,
      recoveryKey: { kind: 'seed', entropy, account: 0 },
      phone: this.s.key2.vault,
      hardware: this.s.hardware.key,
    };
    this.pendingKit = { kit, positions: randomPositions(3, 12) };
    return renderKit(kit, { hardwareName: hardwareName(this.s.hardware.kind), ...opts });
  }

  /**
   * Step 2 (second hardware wallet): key 3 is another device; only its xpub
   * is needed. Renders the wallet map (no secret) to print and keep with it.
   */
  async useHardwareRecoveryKey(opts: KitPrintOptions & { kind?: HardwareKind } = {}): Promise<PrintableKit> {
    if (this.s.stage !== 'hardware' || !this.s.hardware) throw new RecoveryKeyError('wrong_state', 'Connect the hardware wallet first.');
    const old = this.hwSession;
    this.hwSession = undefined;
    await old?.close().catch(() => {});
    const creationHeight = await this.deps.esplora.tipHeight();
    const hw = await this.hardwareProvider().connect({ kind: opts.kind });
    try {
      if (hw.info.fingerprint === this.s.hardware.fingerprint) throw new RecoveryKeyError('hardware_mismatch', 'That is your main hardware wallet. Connect the second one.');
      if (hw.info.fingerprint === this.s.key2.vault.fingerprint) throw new RecoveryKeyError('hardware_mismatch', 'That device holds the phone key.');
      const key = await readDeviceKey(hw, this.network, 0);
      const kit: RecoveryKit = { network: this.network.name, creationHeight, recoveryKey: { kind: 'xpub', key }, phone: this.s.key2.vault, hardware: this.s.hardware.key };
      this.dropPendingKit();
      this.pendingKit = { kit, positions: [], device: { kind: hw.info.kind, model: hw.info.model, fingerprint: hw.info.fingerprint } };
      return renderKit(kit, { hardwareName: hardwareName(this.s.hardware.kind), ...opts });
    } finally {
      await hw.close().catch(() => {});
    }
  }

  /** The Recovery Key word positions (1-based) the user must type to prove the kit is saved. */
  kitChallenge(): number[] {
    if (!this.pendingKit) throw new RecoveryKeyError('wrong_state', 'No Recovery Kit is being made.');
    return [...this.pendingKit.positions];
  }

  /**
   * Step 3: the user saved the kit. Checks the proof (a scan of the printed
   * QR code, or the asked words), builds the vault, registers it on the
   * hardware wallet and checks the first address there, then wipes key 3
   * from the phone: only its xpub stays.
   */
  async confirmKitSaved(proof: KitProof, opts: { verifyAddress?: boolean } = {}): Promise<VaultSummary> {
    const p = this.pendingKit;
    if (!p || this.s.stage !== 'hardware') throw new RecoveryKeyError('wrong_state', 'No Recovery Kit is being made.');
    const want = encodeKitBytes(p.kit);
    if ('scanned' in proof) {
      let got: Uint8Array;
      try {
        got = encodeKitBytes(decodeKit(proof.scanned));
      } catch (e) {
        throw new RecoveryKeyError('kit_not_confirmed', 'That scan is not this Recovery Kit.', { cause: e });
      }
      if (got.length !== want.length || got.some((b, i) => b !== want[i])) throw new RecoveryKeyError('kit_not_confirmed', 'That is a different Recovery Kit.');
    } else if ('words' in proof) {
      if (p.kit.recoveryKey.kind !== 'seed') throw new RecoveryKeyError('kit_not_confirmed', 'This kit has no words to check: scan it instead.');
      const words = kitMnemonic(p.kit).split(' ');
      for (const pos of p.positions) if (!wordMatches(proof.words[pos] ?? '', words[pos - 1]!)) throw new RecoveryKeyError('kit_not_confirmed', `Word ${pos} does not match the kit.`, { detail: { position: pos } });
    } else if (p.kit.recoveryKey.kind === 'seed') {
      throw new RecoveryKeyError('kit_not_confirmed', 'Check a few words of the kit, or scan it.');
    }
    const rk = kitRecoveryKeyExpression(p.kit);
    const vault = new MultisigWallet(this.network, { app: this.s.key2.vault, hardware: this.s.hardware!.key, cosigner: rk });
    const descriptor = vault.descriptor();
    const first = vault.derive(RECEIVE, 0).address;
    const reg = await this.withHardware(async (hw) => {
      const policy = await registerOn(hw, this.s.hardware!.policyName, descriptor, (e) => this.emit(e));
      let verified = false;
      if (opts.verifyAddress ?? true) {
        this.emit({ type: 'hardware_prompt', purpose: 'address', text: `Check that your device shows ${first}` });
        const shown = await hw.displayAddress(policy, 0, 0);
        if (shown !== first) throw new RecoveryKeyError('address_mismatch', `The device shows ${shown}, the phone computed ${first}. Do not use this wallet.`);
        verified = true;
      }
      return { hmac: policy.registration?.hmac, verified };
    });
    const kind = p.kit.recoveryKey.kind;
    const device = p.device;
    const creationHeight = p.kit.creationHeight;
    this.dropPendingKit();
    await this.update((s) => {
      s.recoveryKey = { kind: kind === 'seed' ? 'kit' : 'hardware', key: rk, savedAt: this.clock.now(), ...(device ? { device } : {}) };
      s.vault = { descriptor, fingerprint: vault.fingerprint(), creationHeight };
      s.hardware = { ...s.hardware!, registered: { descriptor, ...(reg.hmac ? { hmac: reg.hmac } : {}) }, addressVerified: reg.verified };
      s.stage = 'ready';
    });
    return { descriptor, fingerprint: formatFingerprint(vault.fingerprint()), firstAddress: first, addressVerified: reg.verified };
  }

  /** The vault fingerprint as the kit shows it. */
  fingerprint(): string {
    this.requireReady();
    return formatFingerprint(this.s.vault!.fingerprint);
  }

  // ===========================================================================
  // Chain data

  /** Re-reads the chain: vault, spending balance, refill states. */
  private async refresh(): Promise<Synced> {
    this.requireReady();
    const esplora = this.deps.esplora;
    const vault = this.vault();
    const spending = this.spendingAccount();
    const vaultScan = await scanAccount(esplora, (c, i) => ({ chain: c, index: i, ...this.vaultAddress(c, i) }), {
      minIndex: { 0: this.s.indices.vaultReceive, 1: this.s.indices.vaultChange },
    });
    const spendScan = await scanAccount(esplora, (c, i) => ({ chain: c, index: i, ...pickAddr(spending.derive(c, i)) }), {
      minIndex: { 0: this.s.indices.spendingReceive, 1: this.s.indices.spendingInternal },
    });
    const rates = await esplora.feeEstimates().catch(() => ({}) as FeeRates);
    const tip = Math.max(vaultScan.tip, spendScan.tip);
    const view: ChainView = {
      tip,
      tx: (id) => {
        const t = vaultScan.txs.get(id) ?? spendScan.txs.get(id);
        return t && { confirmed: t.status.confirmed, height: t.status.block_height };
      },
      spender: (id, vout) => vaultScan.coins.find((c) => c.txid === id && c.vout === vout)?.spentBy,
    };
    const chain = this.s.chain;
    const states = chain && chain.descriptor === vault.descriptor() ? refillStates(chain, view) : [];
    const summary = summarizeChain(states);
    const synced: Synced = { at: this.clock.now(), tip, vault: vaultScan, spending: spendScan, states, summary, rates };
    this.synced = synced;
    // Remember the last refill height and the indices the chain server has seen used.
    const lastRefill = summary.lastConfirmedHeight;
    const nv = vaultScan.nextIndex;
    const ns = spendScan.nextIndex;
    const st = this.s;
    if (
      (lastRefill !== undefined && lastRefill > (st.lastRefillHeight ?? -1)) ||
      (nv[0] ?? 0) > st.indices.vaultReceive ||
      (nv[1] ?? 0) > st.indices.vaultChange ||
      (ns[0] ?? 0) > st.indices.spendingReceive ||
      (ns[1] ?? 0) > st.indices.spendingInternal
    ) {
      await this.update((s) => {
        if (lastRefill !== undefined) s.lastRefillHeight = Math.max(s.lastRefillHeight ?? 0, lastRefill);
        s.indices.vaultReceive = Math.max(s.indices.vaultReceive, nv[0] ?? 0);
        s.indices.vaultChange = Math.max(s.indices.vaultChange, nv[1] ?? 0);
        s.indices.spendingReceive = Math.max(s.indices.spendingReceive, ns[0] ?? 0);
        s.indices.spendingInternal = Math.max(s.indices.spendingInternal, ns[1] ?? 0);
      });
    }
    await this.noticeForeignVaultSpends(synced);
    return synced;
  }

  /** A vault coin spent by a transaction that is neither one of ours nor a refill: two keys are elsewhere. */
  private async noticeForeignVaultSpends(sy: Synced): Promise<void> {
    const refills = new Set(this.s.chain?.refills.map((r) => r.txid) ?? []);
    const own = new Set(this.s.ownTxids);
    const known = new Set(this.s.alerts.filter((a) => a.kind === 'foreign_vault_spend').map((a) => (a as { txid: string }).txid));
    const foreign = new Set<string>();
    for (const c of sy.vault.coins) if (c.spentBy && !own.has(c.spentBy.txid) && !refills.has(c.spentBy.txid) && !known.has(c.spentBy.txid)) foreign.add(c.spentBy.txid);
    if (!foreign.size) return;
    await this.update((s) => {
      for (const txid of foreign) s.alerts.push({ kind: 'foreign_vault_spend', at: this.clock.now(), txid });
    });
    for (const txid of foreign) this.emit({ type: 'foreign_vault_spend', txid });
  }

  /** Syncs and returns what RK-Home shows. */
  async sync(): Promise<HomeState> {
    return this.homeFrom(await this.refresh());
  }

  /** The last synced home state, without network. */
  home(): HomeState | undefined {
    return this.synced && this.homeFrom(this.synced);
  }

  private homeFrom(sy: Synced): HomeState {
    const sum = (cs: { value: bigint; height: number }[], conf: boolean) => Number(cs.filter((c) => (c.height > 0) === conf).reduce((s, c) => s + c.value, 0n));
    const spendC = sum(sy.spending.unspent, true);
    const spendU = sum(sy.spending.unspent, false);
    const vaultC = sum(sy.vault.unspent, true);
    const vaultU = sum(sy.vault.unspent, false);
    const n = sy.summary.next;
    let nextRefill: HomeState['nextRefill'];
    if (n) {
      const now = this.clock.now();
      const st = n.state;
      if (st.status === 'in_mempool') nextRefill = { position: n.position, amountSats: n.amountSats, status: 'arriving' };
      else if (st.status === 'broadcastable_at') {
        const inBlocks = Math.max(0, st.height - (sy.tip + 1));
        nextRefill = { position: n.position, amountSats: n.amountSats, status: n.ready ? 'ready' : 'waiting', atHeight: st.height, inBlocks, etaMs: now + inBlocks * BLOCK_MS };
      } else {
        const period = this.s.chain?.periodBlocks ?? DEFAULT_PERIOD_BLOCKS;
        nextRefill = { position: n.position, amountSats: n.amountSats, status: 'pending', inBlocks: period, etaMs: now + (period + 1) * BLOCK_MS };
      }
    }
    const refillIds = new Map(this.s.chain?.refills.map((r) => [r.txid, r.position]) ?? []);
    const own = new Set(this.s.ownTxids);
    const mine = new Map(sy.spending.coins.map((c) => [`${c.txid}:${c.vout}`, c.value]));
    const activity = [...sy.spending.txs.values()]
      .map((t) => {
        const inSum = t.vin.reduce((s, v) => s + (mine.get(`${v.txid}:${v.vout}`) ?? 0n), 0n);
        const outSum = sy.spending.coins.filter((c) => c.txid === t.txid).reduce((s, c) => s + c.value, 0n);
        const netSats = Number(outSum - inSum);
        const position = refillIds.get(t.txid);
        const kind: HomeState['activity'][number]['kind'] = position ? 'refill' : netSats >= 0 ? 'received' : inSum > 0n && t.vin.some((v) => refillIds.has(v.txid)) && own.has(t.txid) && t.vout.length === 1 ? 'speed_up' : 'sent';
        return { txid: t.txid, kind, netSats, height: t.status.confirmed ? t.status.block_height ?? 0 : 0, ...(position ? { position } : {}) };
      })
      .sort((a, b) => (a.height === 0 ? -1 : b.height === 0 ? 1 : b.height - a.height));
    const needsApproval = sy.summary.status !== 'live' || sy.summary.left <= this.s.config.lowRefillsAt;
    return {
      tipHeight: sy.tip,
      syncedAt: sy.at,
      spending: { confirmedSats: spendC, unconfirmedSats: spendU, totalSats: spendC + spendU },
      vault: { confirmedSats: vaultC, unconfirmedSats: vaultU, totalSats: vaultC + vaultU },
      nextRefill,
      refills: { left: sy.summary.left, total: sy.summary.total, status: sy.summary.status, needsApproval, ...(sy.summary.invalidated ? { invalidated: sy.summary.invalidated } : {}) },
      alerts: [...this.s.alerts],
      activity,
    };
  }

  // ===========================================================================
  // RK-Refills

  private async planBatch(sy: Synced, opts: { amountSats?: number; count?: number; periodBlocks?: number }) {
    const vault = this.vault();
    const chain = this.s.chain;
    const live = chain && chain.descriptor === vault.descriptor() && sy.summary.status === 'live';
    let head: ChainHead;
    let amount: bigint;
    let period: number;
    let startPosition: number;
    if (live) {
      const tail = chainTail(chain)!;
      amount = BigInt(chain.amountSats);
      period = chain.periodBlocks;
      if ((opts.amountSats !== undefined && opts.amountSats !== chain.amountSats) || (opts.periodBlocks !== undefined && opts.periodBlocks !== period))
        throw new RecoveryKeyError('wrong_state', 'More refills continue the current chain at its amount and period; change them once it runs out.');
      head = { inputs: [{ txid: tail.txid, vout: REFILL_CHANGE_VOUT, value: tail.value, chain: CHANGE, index: tail.changeIndex, prevTxHex: tail.txHex }], sequences: [encodeRelativeBlocks(period)], lockTime: 0 };
      startPosition = chain.refills.length + 1;
    } else {
      if (sy.states.some((s) => s.state.status === 'in_mempool')) throw new RecoveryKeyError('refill_in_flight', 'A refill is on its way. Approve new refills once it confirms.');
      amount = BigInt(opts.amountSats ?? this.s.config.refillAmountSats);
      period = opts.periodBlocks ?? this.s.config.periodBlocks;
      encodeRelativeBlocks(period);
      const coins = sy.vault.unspent.filter((c) => c.height > 0);
      if (!coins.length) throw new RecoveryKeyError('insufficient_funds', 'The vault has no confirmed coins yet.');
      const oldRefills = new Set(chain?.refills.map((r) => r.txid) ?? []);
      const inputs: VaultCoin[] = [];
      for (const c of coins) inputs.push({ txid: c.txid, vout: c.vout, value: c.value, chain: c.chain, index: c.index, prevTxHex: await this.prevTx(c.txid) });
      const last = this.s.lastRefillHeight;
      // The first refill of a new batch waits out the period after the last refill that confirmed.
      const lockTime = last !== undefined && last + period > sy.tip + 1 ? last + period - 1 : 0;
      head = { inputs, sequences: inputs.map((c) => (oldRefills.has(c.txid) && c.vout === REFILL_CHANGE_VOUT ? encodeRelativeBlocks(period) : SEQUENCE_RBF)), lockTime };
      startPosition = 1;
    }
    const total = head.inputs.reduce((s, c) => s + c.value, 0n);
    let rate;
    try {
      rate = chooseRefillFeeRate(sy.rates, this.s.config.refillFeePolicy, amount, refillVsize(1));
    } catch (e) {
      throw new RecoveryKeyError('fee_too_high', (e as Error).message, { cause: e });
    }
    const maxCount = maxRefills(total, amount, rate.satPerVb, head.inputs.length);
    return { mode: (live ? 'extend' : 'fresh') as 'extend' | 'fresh', head, amount, period, rate, maxCount, startPosition, total };
  }

  private async prevTx(txid: string): Promise<string> {
    const local = this.s.chain?.refills.find((r) => r.txid === txid);
    return local ? local.txHex : this.deps.esplora.txHex(txid);
  }

  private schedule(sy: Synced, plan: { mode: 'extend' | 'fresh'; head: ChainHead; period: number; startPosition: number; amount: bigint }, count: number): RefillScheduleItem[] {
    const now = this.clock.now();
    const next = sy.tip + 1;
    let h: number;
    if (plan.mode === 'fresh') h = Math.max(next, plan.head.lockTime + 1);
    else {
      // Walk the refills still to come in the current chain.
      h = next;
      let first = true;
      for (const s of sy.states) {
        if (s.state.status === 'confirmed' || s.state.status === 'invalidated') continue;
        if (s.state.status === 'broadcastable_at') h = Math.max(next, s.state.height);
        else if (!first) h += plan.period;
        first = false;
      }
      h += plan.period;
    }
    return Array.from({ length: count }, (_, k) => {
      const height = h + k * plan.period;
      return { position: plan.startPosition + k, amountSats: Number(plan.amount), earliestHeight: height, earliestAt: now + (height - next) * BLOCK_MS };
    });
  }

  /** What RK-Refills shows before the user approves: amounts, dates, fees. */
  async previewRefills(opts: { amountSats?: number; count?: number; periodBlocks?: number } = {}): Promise<RefillPreview> {
    const sy = await this.refresh();
    const plan = await this.planBatch(sy, opts);
    const count = Math.min(opts.count ?? this.s.config.refillCount, plan.maxCount);
    const feePer = Math.ceil(plan.rate.satPerVb * refillVsize(1));
    return {
      mode: plan.mode,
      amountSats: Number(plan.amount),
      count,
      maxCount: plan.maxCount,
      periodBlocks: plan.period,
      feeRate: plan.rate.satPerVb,
      feeRateSource: plan.rate.source,
      feePerRefillSats: feePer,
      totalSats: Number(plan.amount) * count,
      vaultBalanceSats: Number(sy.vault.unspent.reduce((s, c) => s + c.value, 0n)),
      schedule: this.schedule(sy, plan, count),
    };
  }

  /**
   * Builds a batch of refills, has the hardware wallet sign them (in one
   * session; in one call if the device supports `signPsbts`), then the phone
   * (one Face ID), checks every signature and link, and stores the chain.
   * Extends the current chain if it is live, else starts a fresh one from
   * every confirmed vault coin.
   */
  async approveRefills(opts: { amountSats?: number; count?: number; periodBlocks?: number } = {}): Promise<{ mode: 'fresh' | 'extend'; from: number; to: number; feeRate: number; schedule: RefillScheduleItem[] }> {
    const sy = await this.refresh();
    const plan = await this.planBatch(sy, opts);
    const count = opts.count ?? this.s.config.refillCount;
    if (count > plan.maxCount)
      throw new RecoveryKeyError('insufficient_funds', `The vault can pay for ${plan.maxCount} refill(s) of ${plan.amount} sats, not ${count}.`, { detail: { maxCount: plan.maxCount } });
    return this.signAndStoreBatch(sy, plan, count);
  }

  private async signAndStoreBatch(
    sy: Synced,
    plan: Awaited<ReturnType<RecoveryKeyWallet['planBatch']>>,
    count: number,
    hw?: HardwareSigner,
  ): Promise<{ mode: 'fresh' | 'extend'; from: number; to: number; feeRate: number; schedule: RefillScheduleItem[] }> {
    const vault = this.vault();
    const spendIndices = Array.from({ length: count }, (_, k) => this.s.indices.spendingInternal + k);
    const changeIndices = Array.from({ length: count }, (_, k) => this.s.indices.vaultChange + k);
    const unsigned = buildRefillChain({
      vault,
      spending: this.spendingAccount(),
      head: plan.head,
      params: { amount: plan.amount, count, periodBlocks: plan.period, feeRate: plan.rate.satPerVb },
      startPosition: plan.startPosition,
      spendIndices,
      changeIndices,
    });
    const stored = await this.signRefills(unsigned, hw);
    const now = this.clock.now();
    const batch = { id: hex.encode(secureRandomBytes(8)), createdAt: now, createdHeight: sy.tip, from: plan.startPosition, to: plan.startPosition + count - 1, feeRate: plan.rate.satPerVb };
    const record: RefillChainRecord =
      plan.mode === 'extend'
        ? { ...this.s.chain!, refills: [...this.s.chain!.refills, ...stored], batches: [...this.s.chain!.batches, batch] }
        : { id: hex.encode(secureRandomBytes(8)), descriptor: vault.descriptor(), amountSats: Number(plan.amount), periodBlocks: plan.period, refills: stored, batches: [batch] };
    verifyRefillChain(record, { vault, spending: this.spendingAccount() });
    await this.update((s) => {
      s.chain = record;
      s.indices.spendingInternal += count;
      s.indices.vaultChange += count;
    });
    return { mode: plan.mode, from: batch.from, to: batch.to, feeRate: batch.feeRate, schedule: this.schedule(sy, plan, count) };
  }

  private async signRefills(unsigned: UnsignedRefill[], session?: HardwareSigner): Promise<StoredRefill[]> {
    const vault = this.vault();
    const n = unsigned.length;
    const signOn = async (hw: HardwareSigner): Promise<Uint8Array[]> => {
      const policy = this.devicePolicy();
      unsigned.forEach((r, i) => this.emit({ type: 'hardware_prompt', purpose: 'refills', text: refillPromptText(r, unsigned[0]!.position + n - 1), step: i + 1, steps: n }));
      let returned: string[];
      if (isBatchSigner(hw)) returned = await hw.signPsbts(unsigned.map((r) => base64.encode(r.psbt)), policy);
      else {
        returned = [];
        for (const r of unsigned) returned.push(await hw.signPsbt(base64.encode(r.psbt), policy));
      }
      if (returned.length !== n) throw new RecoveryKeyError('hardware_invalid_response', 'The hardware wallet did not sign every refill.');
      return returned.map((b, i) => {
        let bytes: Uint8Array;
        try {
          bytes = base64.decode(b);
        } catch (e) {
          throw new RecoveryKeyError('hardware_invalid_response', 'The hardware wallet returned something that is not a PSBT.', { cause: e });
        }
        return checkSignedBy(unsigned[i]!.psbt, bytes, vault, 'hardware', 'The hardware wallet');
      });
    };
    const byHw = session ? await signOn(session) : await this.withHardware(signOn);
    const both = await this.withKey2(`Approve ${n} refill${n === 1 ? '' : 's'}`, async (m) => {
      // One seed derivation for the whole batch (PBKDF2 is slow on a phone).
      const master = HDKey.fromMasterSeed(mnemonicToSeedSync(m), this.network.bip32);
      try {
        return byHw.map((p) => {
          const tx = btc.Transaction.fromPSBT(p, TX_OPTS);
          if (tx.sign(master as unknown as Parameters<btc.Transaction['sign']>[0], [btc.SigHash.ALL]) === 0) throw new RecoveryKeyError('internal', 'the phone key signs no input of this refill');
          return checkSignedBy(p, tx.toPSBT(), vault, 'app', 'The phone');
        });
      } finally {
        master.wipePrivateData();
      }
    });
    return both.map((p, i) => finalizeRefill(unsigned[i]!, p));
  }

  /** The signed refills, for whoever needs to broadcast them (the scheduler does). */
  refillTransactions(): { position: number; txid: string; txHex: string }[] {
    return (this.s.chain?.refills ?? []).map((r) => ({ position: r.position, txid: r.txid, txHex: r.txHex }));
  }

  // ===========================================================================
  // RK-Home: the scheduler

  /**
   * Syncs, decides (see `scheduler.ts`) and acts: broadcasts the next refill
   * when it is unlocked and the spending balance is low, records and reports
   * unexpected broadcasts, invalidation and low refills, suggests CPFP. Call
   * it when the app opens and from a background task.
   */
  async runScheduler(opts: { broadcast?: boolean } = {}): Promise<{ decisions: Decision[]; broadcast?: string; home: HomeState }> {
    let sy = await this.refresh();
    const decisions = decide({
      tip: sy.tip,
      states: sy.states,
      spendingBalanceSats: sy.spending.unspent.reduce((s, c) => s + c.value, 0n),
      topUpBelowSats: BigInt(this.s.config.topUpBelowSats),
      ownBroadcasts: new Set(this.s.ownTxids),
      reported: new Set(this.s.reported),
      ownVaultSpends: new Set(this.s.ownVaultSpends),
      targetFeeRate: estimateFor(sy.rates, this.s.config.feeTarget),
      lowAt: this.s.config.lowRefillsAt,
    });
    let broadcast: string | undefined;
    for (const d of decisions) {
      if (d.kind === 'unexpected_broadcast') {
        await this.update((s) => {
          s.reported.push(d.txid);
          s.alerts.push({ kind: 'unexpected_broadcast', at: this.clock.now(), position: d.position, txid: d.txid });
        });
        this.emit({ type: 'unexpected_broadcast', position: d.position, txid: d.txid });
      } else if (d.kind === 'invalidated') {
        const seen = this.s.alerts.some((a) => a.kind === 'refills_invalidated' && a.spentBy === d.spentBy && a.position === d.position);
        if (!seen) {
          await this.update((s) => void s.alerts.push({ kind: 'refills_invalidated', at: this.clock.now(), position: d.position, spentBy: d.spentBy, byThisPhone: d.byThisPhone }));
          this.emit({ type: 'refills_invalidated', position: d.position, spentBy: d.spentBy, byThisPhone: d.byThisPhone });
        }
      } else if (d.kind === 'broadcast' && (opts.broadcast ?? true)) {
        const r = await this.broadcastRefill(d.position);
        if (r.ok) broadcast = r.txid;
      } else if (d.kind === 'offer_cpfp') {
        this.emit({ type: 'cpfp_suggested', position: d.position, txid: d.txid, childFeeSats: d.childFeeSats, targetRate: d.targetRate, parentRate: d.parentRate });
      } else if (d.kind === 'low') this.emit({ type: 'refills_low', left: d.left });
      else if (d.kind === 'exhausted') this.emit({ type: 'refills_exhausted' });
    }
    if (broadcast) sy = await this.refresh();
    return { decisions, broadcast, home: this.homeFrom(sy) };
  }

  /**
   * Broadcasts refill `position` (recorded as this phone's first, so it is
   * never mistaken for someone else's). A refill that is still timelocked
   * comes back `{ ok: false, reason: 'non-BIP68-final' }`.
   */
  async broadcastRefill(position: number): Promise<{ ok: true; txid: string } | { ok: false; reason: string }> {
    const r = this.s.chain?.refills.find((x) => x.position === position);
    if (!r) throw new RecoveryKeyError('wrong_state', `There is no refill ${position}.`);
    if (!this.s.ownTxids.includes(r.txid)) await this.update((s) => void s.ownTxids.push(r.txid));
    try {
      await this.deps.esplora.broadcast(r.txHex);
    } catch (e) {
      if (e instanceof RecoveryKeyError && e.code === 'broadcast_rejected') return { ok: false, reason: String(e.detail?.reason ?? e.message) };
      throw e;
    }
    this.emit({ type: 'refill_broadcast', position, txid: r.txid });
    return { ok: true, txid: r.txid };
  }

  /**
   * CPFP: speeds up a refill stuck in the mempool by spending its output to
   * the spending balance with a fee for both. The phone alone signs.
   */
  async speedUpRefill(opts: { position?: number; feeRate?: number } = {}): Promise<{ txid: string; childFeeSats: number; packageRate: number }> {
    const sy = await this.refresh();
    const stuck = sy.states.find((s) => s.state.status === 'in_mempool' && (opts.position === undefined || s.position === opts.position));
    if (!stuck) throw new RecoveryKeyError('nothing_to_bump', 'No refill is waiting in the mempool.');
    const r = this.s.chain!.refills.find((x) => x.position === stuck.position)!;
    const target = opts.feeRate ?? estimateFor(sy.rates, 1) ?? estimateFor(sy.rates, this.s.config.feeTarget);
    if (target === undefined) throw new RecoveryKeyError('chain_source', 'The chain server has no fee estimate; give a fee rate.');
    const changeIndex = this.s.indices.spendingInternal;
    const plan = buildCpfpChild({
      account: this.spendingAccount(),
      parentOutput: { txid: r.txid, vout: REFILL_SPEND_VOUT, value: BigInt(this.s.chain!.amountSats), chain: SPENDING_INTERNAL, index: r.spendIndex, height: 0, prevTxHex: r.txHex },
      parentVsize: vsizeOf(decodeRawTx(r.txHex)),
      parentFee: BigInt(r.feeSats),
      targetRate: target,
      changeIndex,
    });
    const signed = await this.withKey2('Speed up the refill', async (m) => signSpendingPsbt(plan.psbt, m, this.network));
    const done = finalizeSpending(signed);
    await this.update((s) => {
      s.ownTxids.push(done.txid);
      s.indices.spendingInternal = Math.max(s.indices.spendingInternal, changeIndex + 1);
    });
    await this.deps.esplora.broadcast(done.txHex);
    return { txid: done.txid, childFeeSats: Number(plan.childFee), packageRate: plan.packageRate };
  }

  // ===========================================================================
  // RK-Home: the spending balance

  /** A fresh receive address of the spending balance (for paying the phone directly). */
  async receiveAddress(): Promise<{ address: string; index: number }> {
    const index = this.s.indices.spendingReceive;
    await this.update((s) => void (s.indices.spendingReceive = index + 1));
    return { address: this.spendingAccount().derive(SPENDING_RECEIVE, index).address, index };
  }

  private feeRateFor(sy: Synced, feeRate?: number): number {
    if (feeRate !== undefined) return feeRate;
    return estimateFor(sy.rates, this.s.config.feeTarget) ?? this.s.config.refillFeePolicy.floorSatPerVb;
  }

  private async spendingCoins(sy: Synced): Promise<SpendingCoin[]> {
    return sy.spending.unspent.map((c) => ({ txid: c.txid, vout: c.vout, value: c.value, chain: c.chain, index: c.index, height: c.height }));
  }

  async quoteSend(req: { address: string; amountSats: number; feeRate?: number }): Promise<SendQuote> {
    const sy = await this.refresh();
    const feeRate = this.feeRateFor(sy, req.feeRate);
    const changeIndex = this.s.indices.spendingInternal;
    const plan = buildSpendingPayment({ account: this.spendingAccount(), coins: await this.spendingCoins(sy), address: req.address, amount: BigInt(req.amountSats), feeRate, changeIndex });
    return {
      address: req.address,
      amountSats: req.amountSats,
      feeSats: Number(plan.fee),
      feeRate,
      totalSats: req.amountSats + Number(plan.fee),
      inputs: plan.inputs.map((c) => ({ txid: c.txid, vout: c.vout })),
      changeIndex,
    };
  }

  /** Pays from the spending balance with Face ID alone. */
  async send(req: { address: string; amountSats: number; feeRate?: number }): Promise<{ txid: string; feeSats: number }> {
    const sy = await this.refresh();
    const feeRate = this.feeRateFor(sy, req.feeRate);
    const changeIndex = this.s.indices.spendingInternal;
    const account = this.spendingAccount();
    const coins = await this.spendingCoins(sy);
    const first = buildSpendingPayment({ account, coins, address: req.address, amount: BigInt(req.amountSats), feeRate, changeIndex });
    // Pin every amount to its funding transaction before signing.
    const withPrev = await Promise.all(first.inputs.map(async (c) => ({ ...c, prevTxHex: await this.prevTx(c.txid) })));
    const plan = buildSpendingPayment({ account, coins: withPrev, address: req.address, amount: BigInt(req.amountSats), feeRate, changeIndex });
    const signed = await this.withKey2('Approve the payment', async (m) => signSpendingPsbt(plan.psbt, m, this.network));
    const done = finalizeSpending(signed);
    await this.update((s) => {
      s.ownTxids.push(done.txid);
      if (plan.change) s.indices.spendingInternal = Math.max(s.indices.spendingInternal, changeIndex + 1);
    });
    await this.deps.esplora.broadcast(done.txHex);
    return { txid: done.txid, feeSats: Number(done.fee) };
  }

  // ===========================================================================
  // RK-Home: the vault

  /** A fresh vault deposit address, optionally shown on the hardware wallet. */
  async vaultReceiveAddress(opts: { verifyOnDevice?: boolean } = {}): Promise<{ address: string; index: number; verifiedOnDevice: boolean }> {
    const index = this.s.indices.vaultReceive;
    const address = this.vault().derive(RECEIVE, index).address;
    let verified = false;
    if (opts.verifyOnDevice) {
      const shown = await this.withHardware(async (hw) => {
        this.emit({ type: 'hardware_prompt', purpose: 'address', text: `Check that your device shows ${address}` });
        return hw.displayAddress(this.devicePolicy(), 0, index);
      });
      if (shown !== address) throw new RecoveryKeyError('address_mismatch', `The device shows ${shown}, the phone computed ${address}.`);
      verified = true;
    }
    await this.update((s) => void (s.indices.vaultReceive = index + 1));
    return { address, index, verifiedOnDevice: verified };
  }

  /**
   * A big payment from the vault (phone + hardware). Coins the refill chain
   * does not need are spent first; if the payment must touch the chain's next
   * input, the remaining refills become invalid (`invalidatesRefills`), and
   * with `reapproveRefills` a fresh batch from the payment's change is signed
   * in the same hardware session.
   */
  async payFromVault(req: { address: string; amountSats: number; feeRate?: number }, opts: { reapproveRefills?: boolean | { count?: number } } = {}): Promise<{ txid: string; feeSats: number; invalidatesRefills: boolean; refills?: { from: number; to: number } }> {
    const sy = await this.refresh();
    const vault = this.vault();
    const feeRate = this.feeRateFor(sy, req.feeRate);
    const next = sy.summary.next;
    const reserved = new Set(next && next.state.status === 'broadcastable_at' ? this.s.chain!.refills[next.position - 1]!.inputs.map((i) => `${i.txid}:${i.vout}`) : []);
    const confirmed = sy.vault.unspent.filter((c) => c.height > 0);
    const free = confirmed.filter((c) => !reserved.has(`${c.txid}:${c.vout}`));
    const changeIndex = this.s.indices.vaultChange;
    const attempt = async (coins: typeof confirmed) => {
      const utxos = await Promise.all(coins.map(async (c) => ({ txid: c.txid, vout: c.vout, value: c.value, chain: c.chain, index: c.index, prevTxHex: await this.prevTx(c.txid) })));
      return buildSpend({ wallet: vault, utxos, recipients: [{ address: req.address, amount: BigInt(req.amountSats) }], feeRate, changeIndex });
    };
    let plan;
    let invalidates = false;
    try {
      plan = await attempt(free);
    } catch (e) {
      if (!(e instanceof Error) || !/insufficient funds/.test(e.message)) throw e;
      try {
        plan = await attempt(confirmed);
      } catch (e2) {
        if (e2 instanceof Error && /insufficient funds/.test(e2.message)) throw new RecoveryKeyError('insufficient_funds', e2.message, { cause: e2 });
        throw e2;
      }
      invalidates = plan.inputs.some((u) => reserved.has(`${u.txid}:${u.vout}`));
    }
    const text = `Send ${req.amountSats} sats to ${req.address} from the vault, fee ${plan.fee} sats`;
    const run = async (hw: HardwareSigner) => {
      this.emit({ type: 'hardware_prompt', purpose: 'vault-payment', text });
      const byHw = checkSignedBy(plan.psbt, base64.decode(await hw.signPsbt(base64.encode(plan.psbt), this.devicePolicy())), vault, 'hardware', 'The hardware wallet');
      const both = await this.withKey2('Approve the vault payment', async (m) => checkSignedBy(byHw, await new SoftwareSigner('app', m).signPsbt(byHw, this.network), vault, 'app', 'The phone'));
      const { txid, txHex } = finalizePsbt(both);
      await this.update((s) => {
        s.ownTxids.push(txid);
        s.ownVaultSpends.push(txid);
        if (plan.change) s.indices.vaultChange = Math.max(s.indices.vaultChange, changeIndex + 1);
      });
      await this.deps.esplora.broadcast(txHex);
      let refills: { from: number; to: number } | undefined;
      if (invalidates && opts.reapproveRefills && plan.change) {
        // A fresh batch from the payment's change, signed in this same session.
        const count = typeof opts.reapproveRefills === 'object' && opts.reapproveRefills.count ? opts.reapproveRefills.count : this.s.config.refillCount;
        const fresh = await this.refresh();
        const amount = BigInt(this.s.config.refillAmountSats);
        const period = this.s.config.periodBlocks;
        const last = this.s.lastRefillHeight;
        const changeScript = hex.encode(vault.derive(CHANGE, plan.change.index).script);
        const ptx = parsePsbt(plan.psbt);
        const vout = Array.from({ length: ptx.outputsLength }, (_, i) => i).find((i) => hex.encode(ptx.getOutput(i).script!) === changeScript)!;
        const head: ChainHead = {
          inputs: [{ txid, vout, value: plan.change.amount, chain: CHANGE, index: plan.change.index, prevTxHex: txHex }],
          sequences: [SEQUENCE_RBF],
          lockTime: last !== undefined && last + period > fresh.tip + 1 ? last + period - 1 : 0,
        };
        const rate = chooseRefillFeeRate(fresh.rates, this.s.config.refillFeePolicy, amount, refillVsize(1));
        const maxCount = maxRefills(plan.change.amount, amount, rate.satPerVb, 1);
        const n = Math.min(count, maxCount);
        if (n > 0) {
          const r = await this.signAndStoreBatch(fresh, { mode: 'fresh', head, amount, period, rate, maxCount, startPosition: 1, total: plan.change.amount }, n, hw);
          refills = { from: r.from, to: r.to };
        }
      }
      return { txid, refills };
    };
    const out = await this.withHardware(run);
    return { txid: out.txid, feeSats: Number(plan.fee), invalidatesRefills: invalidates, ...(out.refills ? { refills: out.refills } : {}) };
  }

  // ===========================================================================
  // RK-Recover

  /** Reads a kit (QR text or words) and looks up what it holds. */
  static async readKit(deps: Pick<RecoveryKeyDeps, 'network' | 'allowMainnet' | 'esplora'>, input: string): Promise<{ fingerprint: string; network: NetworkName; creationHeight: number; kind: 'seed' | 'xpub'; vaultSats: number; unconfirmedSats: number; hardwareFingerprint: string }> {
    refuseMainnet(deps);
    const kit = decodeKit(input);
    try {
      if (kit.network !== deps.network) throw new RecoveryKeyError('network_mismatch', `This kit is for ${kit.network}, not ${deps.network}.`);
      const vault = kitVault(kit);
      const coins = await gatherVaultCoins(deps.esplora, vault);
      return {
        fingerprint: formatFingerprint(vault.fingerprint()),
        network: kit.network,
        creationHeight: kit.creationHeight,
        kind: kit.recoveryKey.kind,
        vaultSats: Number(coins.totalSats),
        unconfirmedSats: Number(coins.unconfirmedSats),
        hardwareFingerprint: kit.hardware.fingerprint,
      };
    } finally {
      wipeKit(kit);
    }
  }

  private static async sweep(opts: {
    esplora: EsploraClient;
    vault: MultisigWallet;
    signers: VaultSigner[];
    destinationScript: Uint8Array;
    feeCapSats: number;
    feeTarget: number;
    feeRate?: number;
    minIndex?: Record<number, number>;
  }): Promise<{ txid: string; amountSats: number; feeSats: number; unconfirmedSats: number }> {
    const coins = await gatherVaultCoins(opts.esplora, opts.vault, { minIndex: opts.minIndex });
    const rates = await opts.esplora.feeEstimates().catch(() => ({}) as FeeRates);
    const feeRate = opts.feeRate ?? estimateFor(rates, opts.feeTarget) ?? 1;
    const plan = buildVaultSweep({ vault: opts.vault, coins, destinationScript: opts.destinationScript, feeRate, feeCapSats: BigInt(opts.feeCapSats) });
    const { txid, txHex } = await signVaultTx(plan.psbt, opts.vault, opts.signers);
    await opts.esplora.broadcast(txHex);
    return { txid, amountSats: Number(plan.amountSats), feeSats: Number(plan.feeSats), unconfirmedSats: Number(coins.unconfirmedSats) };
  }

  /** Kit signers: the seed on the paper kit, or the second hardware wallet it maps. */
  private static kitSigner(kit: RecoveryKit, network: Network, provider: HardwareProvider | undefined, descriptor: string, emit: (e: RkEvent) => void): VaultSigner {
    if (kit.recoveryKey.kind === 'seed') return seedSigner(kitMnemonic(kit), 'cosigner', 'Your Recovery Kit', network);
    const fp = kit.recoveryKey.key.fingerprint;
    return {
      role: 'cosigner',
      label: 'Your second hardware wallet',
      sign: (psbt) =>
        withDevice(provider, fp, undefined, async (hw) => {
          const policy = await registerOn(hw, 'Trikey RK', descriptor, emit);
          emit({ type: 'hardware_prompt', purpose: 'recovery-sweep', text: 'Move every vault coin to your new wallet' });
          return base64.decode(await hw.signPsbt(base64.encode(psbt), policy));
        }),
    };
  }

  /**
   * Kit + hardware wallet, on a new phone (the old one is lost or stolen).
   * Sweeps every vault coin to `destination.address`, or to a fresh vault on
   * this phone: a new key 2, the same hardware wallet at the next BIP 48
   * account, and a new Recovery Key whose kit `confirmNewKit` must show and
   * confirm before anything moves.
   */
  static async recoverWithKit(
    deps: RecoveryKeyDeps,
    opts: {
      kit: string;
      destination: { address: string } | { newVault: true };
      /** Show and print the new kit, then return the proof it was saved (or false to stop). */
      confirmNewKit?: (kit: PrintableKit, challenge: number[]) => Promise<KitProof | false>;
      feeRate?: number;
      onEvent?: (e: RkEvent) => void;
    },
  ): Promise<{ txid: string; amountSats: number; feeSats: number; unconfirmedSats: number; wallet?: RecoveryKeyWallet }> {
    const network = refuseMainnet(deps);
    const kit = decodeKit(opts.kit);
    const emit = opts.onEvent ?? (() => {});
    try {
      if (kit.network !== deps.network) throw new RecoveryKeyError('network_mismatch', `This kit is for ${kit.network}, not ${deps.network}.`);
      const vault = kitVault(kit);
      const descriptor = vault.descriptor();
      const cfg = defaultConfig(network.name, deps.config);
      const hwFp = kit.hardware.fingerprint;
      const account = vaultAccountOf(kit.hardware, network);
      // The hardware wallet must be key 1 of this kit's vault.
      const checkKey1 = async (hw: HardwareSigner) => {
        const key = await readDeviceKey(hw, network, account);
        if (key.xpub !== kit.hardware.xpub) throw new RecoveryKeyError('kit_mismatch', 'This hardware wallet is not the one in the Recovery Kit.');
      };
      const key1Signer = (connect: <T>(fn: (hw: HardwareSigner) => Promise<T>) => Promise<T>): VaultSigner => ({
        role: 'hardware',
        label: 'Your hardware wallet',
        sign: (psbt) =>
          connect(async (hw) => {
            await checkKey1(hw);
            const policy = await registerOn(hw, 'Trikey RK', descriptor, emit);
            emit({ type: 'hardware_prompt', purpose: 'recovery-sweep', text: `Move every coin of wallet ${formatFingerprint(vault.fingerprint())} to your new wallet` });
            return base64.decode(await hw.signPsbt(base64.encode(psbt), policy));
          }),
      });
      const hwSigner = key1Signer((fn) => withDevice(deps.hardware, hwFp, undefined, fn));
      const kitSigner = RecoveryKeyWallet.kitSigner(kit, network, deps.hardware, descriptor, emit);
      if ('address' in opts.destination) {
        let script: Uint8Array;
        try {
          script = btc.OutScript.encode(btc.Address(network.btc).decode(opts.destination.address));
        } catch {
          throw new RecoveryKeyError('invalid_address', `Not a valid ${network.name} address.`);
        }
        return await RecoveryKeyWallet.sweep({ esplora: deps.esplora, vault, signers: [kitSigner, hwSigner], destinationScript: script, feeCapSats: cfg.sweepFeeCapSats, feeTarget: cfg.feeTarget, feeRate: opts.feeRate });
      }
      if (!opts.confirmNewKit) throw new RecoveryKeyError('wrong_state', 'A new vault needs a new Recovery Kit: pass confirmNewKit.');
      // A wallet made for this recovery earlier (the sweep failed or the app stopped) is reused.
      let w = await RecoveryKeyWallet.open(deps);
      if (w && w.s.recoveringFrom?.descriptor !== descriptor) throw new RecoveryKeyError('wallet_exists', 'This phone already has a Recovery Key wallet.');
      if (!w) {
        w = await RecoveryKeyWallet.create(deps);
        await w.update((s) => void (s.recoveringFrom = { descriptor }));
      }
      const ww = w;
      if (w.s.stage !== 'ready') {
        await w.connectHardware({ account: account + 1 });
        if (w.s.hardware!.fingerprint !== hwFp) throw new RecoveryKeyError('hardware_mismatch', 'Connect the hardware wallet of the Recovery Kit.');
        await w.withHardware(checkKey1);
        const printable = await w.createRecoveryKit();
        const proof = await opts.confirmNewKit(printable, w.kitChallenge());
        if (!proof) throw new RecoveryKeyError('kit_not_confirmed', 'The new Recovery Kit was not saved. Nothing moved.');
        await w.confirmKitSaved(proof);
      }
      const dest = w.vault().derive(RECEIVE, 0).script;
      const res = await RecoveryKeyWallet.sweep({
        esplora: deps.esplora,
        vault,
        signers: [kitSigner, key1Signer((fn) => ww.withHardware(fn))],
        destinationScript: dest,
        feeCapSats: cfg.sweepFeeCapSats,
        feeTarget: cfg.feeTarget,
        feeRate: opts.feeRate,
      });
      await w.update((s) => {
        s.ownTxids.push(res.txid);
        s.recoveringFrom = undefined;
        s.indices.vaultReceive = Math.max(s.indices.vaultReceive, 1);
        s.previousVaults.push({ descriptor, sweptBy: res.txid, at: w!.clock.now(), reason: 'kit+hardware' });
      });
      return { ...res, wallet: w };
    } finally {
      wipeKit(kit);
    }
  }

  /** Switches this wallet to `newVault` after a sweep: the old chain is gone, a new one must be approved. */
  private async adoptVault(next: { descriptor: string; fingerprint: string; creationHeight: number; key2Vault: KeyExpression; hardware: HardwareRecord; recoveryKey: RkState['recoveryKey'] }, sweptBy: string, reason: RkState['previousVaults'][number]['reason']) {
    const old = this.s.vault!.descriptor;
    await this.update((s) => {
      s.previousVaults.push({ descriptor: old, sweptBy, at: this.clock.now(), reason });
      s.ownTxids.push(sweptBy);
      s.ownVaultSpends.push(sweptBy);
      s.vault = { descriptor: next.descriptor, fingerprint: next.fingerprint, creationHeight: next.creationHeight };
      s.key2 = { ...s.key2, vault: next.key2Vault };
      s.hardware = next.hardware;
      s.recoveryKey = next.recoveryKey;
      s.chain = undefined;
      s.indices.vaultReceive = 1;
      s.indices.vaultChange = 0;
    });
    this.synced = undefined;
  }

  /**
   * Builds a new vault for this phone: key 2 at the next BIP 48 account, the
   * given hardware key, and a new Recovery Key whose kit must be confirmed.
   */
  private async newVaultWithNewKit(hwKey: KeyExpression, hwRec: Omit<HardwareRecord, 'key' | 'registered' | 'addressVerified'>, confirmNewKit: (kit: PrintableKit, challenge: number[]) => Promise<KitProof | false>, hw: HardwareSigner) {
    const account = vaultAccountOf(this.s.key2.vault, this.network) + 1;
    const key2Vault = await this.withKey2('Make your new vault', async (m) => deriveKey2(m, this.network, { vaultAccount: account }).vault);
    const creationHeight = await this.deps.esplora.tipHeight();
    const entropy = newRecoveryKeyEntropy();
    const kit: RecoveryKit = { network: this.network.name, creationHeight, recoveryKey: { kind: 'seed', entropy, account: 0 }, phone: key2Vault, hardware: hwKey };
    try {
      const printable = renderKit(kit, { hardwareName: hardwareName(hwRec.kind) });
      const positions = randomPositions(3, 12);
      const proof = await confirmNewKit(printable, positions);
      if (!proof) throw new RecoveryKeyError('kit_not_confirmed', 'The new Recovery Kit was not saved. Nothing moved.');
      const want = encodeKitBytes(kit);
      if ('scanned' in proof) {
        const got = encodeKitBytes(decodeKit(proof.scanned));
        if (got.length !== want.length || got.some((b, i) => b !== want[i])) throw new RecoveryKeyError('kit_not_confirmed', 'That is a different Recovery Kit.');
      } else if ('words' in proof) {
        const words = kitMnemonic(kit).split(' ');
        for (const pos of positions) if (!wordMatches(proof.words[pos] ?? '', words[pos - 1]!)) throw new RecoveryKeyError('kit_not_confirmed', `Word ${pos} does not match the kit.`);
      } else throw new RecoveryKeyError('kit_not_confirmed', 'Check a few words of the kit, or scan it.');
      const rk = recoveryKeyFromEntropy(entropy, this.network, 0);
      const vault = new MultisigWallet(this.network, { app: key2Vault, hardware: hwKey, cosigner: rk });
      const descriptor = vault.descriptor();
      const policy = await registerOn(hw, hwRec.policyName, descriptor, (e) => this.emit(e));
      const first = vault.derive(RECEIVE, 0).address;
      this.emit({ type: 'hardware_prompt', purpose: 'address', text: `Check that your device shows ${first}` });
      const shown = await hw.displayAddress(policy, 0, 0);
      if (shown !== first) throw new RecoveryKeyError('address_mismatch', `The device shows ${shown}, the phone computed ${first}.`);
      return {
        vault,
        next: {
          descriptor,
          fingerprint: vault.fingerprint(),
          creationHeight,
          key2Vault,
          hardware: { ...hwRec, key: hwKey, registered: { descriptor, ...(policy.registration ? { hmac: policy.registration.hmac } : {}) }, addressVerified: true },
          recoveryKey: { kind: 'kit' as const, key: rk, savedAt: this.clock.now() },
        },
      };
    } finally {
      entropy.fill(0);
    }
  }

  /**
   * Kit + this phone (the hardware wallet and its seed words are lost).
   * Sweeps to `destination.address`, or to a fresh vault: this phone's key at
   * the next account, a new hardware wallet (connected now; it must not be the
   * lost one) and a new Recovery Key (the kit has been read into a phone, so
   * it is replaced).
   */
  async recoverWithKit(opts: {
    kit: string;
    destination: { address: string } | { newVault: true };
    confirmNewKit?: (kit: PrintableKit, challenge: number[]) => Promise<KitProof | false>;
    feeRate?: number;
  }): Promise<{ txid: string; amountSats: number; feeSats: number; unconfirmedSats: number }> {
    this.requireReady();
    const kit = decodeKit(opts.kit);
    try {
      const vault = this.vault();
      if (kitVault(kit).descriptor() !== vault.descriptor()) throw new RecoveryKeyError('kit_mismatch', 'This Recovery Kit belongs to another wallet.');
      const phone: VaultSigner = { role: 'app', label: 'This phone', sign: (p) => this.withKey2('Move your vault', async (m) => new SoftwareSigner('app', m).signPsbt(p, this.network)) };
      const kitSigner = RecoveryKeyWallet.kitSigner(kit, this.network, this.deps.hardware, vault.descriptor(), (e) => this.emit(e));
      const common = { esplora: this.deps.esplora, vault, signers: [kitSigner, phone], feeCapSats: this.s.config.sweepFeeCapSats, feeTarget: this.s.config.feeTarget, feeRate: opts.feeRate, minIndex: { 0: this.s.indices.vaultReceive, 1: this.s.indices.vaultChange } };
      if ('address' in opts.destination) {
        let script: Uint8Array;
        try {
          script = btc.OutScript.encode(btc.Address(this.network.btc).decode(opts.destination.address));
        } catch {
          throw new RecoveryKeyError('invalid_address', `Not a valid ${this.network.name} address.`);
        }
        const res = await RecoveryKeyWallet.sweep({ ...common, destinationScript: script });
        await this.update((s) => {
          s.ownTxids.push(res.txid);
          s.ownVaultSpends.push(res.txid);
        });
        return res;
      }
      if (!opts.confirmNewKit) throw new RecoveryKeyError('wrong_state', 'A new vault needs a new Recovery Kit: pass confirmNewKit.');
      const lost = this.s.hardware!.fingerprint;
      const hw = await this.hardwareProvider().connect({});
      try {
        if (hw.info.fingerprint === lost) throw new RecoveryKeyError('hardware_mismatch', 'That is the hardware wallet you lost. If you have it back, you do not need to recover.');
        if (hw.info.fingerprint === this.s.key2.vault.fingerprint) throw new RecoveryKeyError('hardware_mismatch', 'That device holds the phone key.');
        const hwKey = await readDeviceKey(hw, this.network, 0);
        const { vault: nv, next } = await this.newVaultWithNewKit(hwKey, { kind: hw.info.kind, model: hw.info.model, fingerprint: hw.info.fingerprint, policyName: this.s.hardware!.policyName }, opts.confirmNewKit, hw);
        const res = await RecoveryKeyWallet.sweep({ ...common, destinationScript: nv.derive(RECEIVE, 0).script });
        await this.adoptVault(next, res.txid, 'kit+phone');
        return res;
      } finally {
        await hw.close().catch(() => {});
      }
    } finally {
      wipeKit(kit);
    }
  }

  /**
   * Phone + hardware wallet (the Recovery Kit is lost, or may have been seen):
   * sweeps to a fresh vault with the same phone and hardware wallet (at their
   * next BIP 48 accounts) and a new Recovery Key.
   */
  async replaceRecoveryKey(opts: { confirmNewKit: (kit: PrintableKit, challenge: number[]) => Promise<KitProof | false>; feeRate?: number }): Promise<{ txid: string; amountSats: number; feeSats: number; unconfirmedSats: number }> {
    this.requireReady();
    const vault = this.vault();
    const rec = this.s.hardware!;
    return this.withHardware(async (hw) => {
      const account = vaultAccountOf(rec.key, this.network) + 1;
      const hwKey = await readDeviceKey(hw, this.network, account);
      const { vault: nv, next } = await this.newVaultWithNewKit(hwKey, { kind: rec.kind, model: rec.model, fingerprint: rec.fingerprint, policyName: rec.policyName }, opts.confirmNewKit, hw);
      const oldPolicy = this.devicePolicy();
      const signers: VaultSigner[] = [
        { ...deviceSigner(hw, oldPolicy, 'hardware', 'Your hardware wallet', (t) => this.emit({ type: 'hardware_prompt', purpose: 'recovery-sweep', text: t }), `Move every coin of this vault to your new vault ${formatFingerprint(nv.fingerprint())}`) },
        { role: 'app', label: 'This phone', sign: (p) => this.withKey2('Move your vault', async (m) => new SoftwareSigner('app', m).signPsbt(p, this.network)) },
      ];
      const res = await RecoveryKeyWallet.sweep({
        esplora: this.deps.esplora,
        vault,
        signers,
        destinationScript: nv.derive(RECEIVE, 0).script,
        feeCapSats: this.s.config.sweepFeeCapSats,
        feeTarget: this.s.config.feeTarget,
        feeRate: opts.feeRate,
        minIndex: { 0: this.s.indices.vaultReceive, 1: this.s.indices.vaultChange },
      });
      await this.adoptVault(next, res.txid, 'phone+hardware');
      return res;
    });
  }
}

function pickAddr(d: { address: string; script: Uint8Array }) {
  return { address: d.address, script: d.script };
}

function hardwareName(kind: HardwareKind): string {
  return { ledger: 'Ledger', trezor: 'Trezor', coldcard: 'Coldcard', bitbox02: 'BitBox02', jade: 'Jade', qr: 'hardware wallet' }[kind];
}
