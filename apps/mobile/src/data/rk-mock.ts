/**
 * Recovery Key mode for the demo: the same `RecoveryKeyActions` as the real wallet, with made-up data and timers, so
 * every Recovery Key screen can be looked at without a chain or a device. Nothing here is a key: the "kit" is a page
 * of sample words that move no money.
 */
import { WalletServiceError } from './errors';
import { parseServerUrl, defaultServerUrl } from './rk-server';
import type { RecoveryKeyActions } from './rk-actions';
import { buildRefillSchedule } from './rules';
import type { KitProof, NetworkName, RecoveryKit, RecoveryKeyState, Sats, WalletState } from './types';

export const DEMO_FINGERPRINT = '7a3c e91d 04b8 5f26';
const DEMO_WORDS = 'sample demo practice example lesson tutorial picture preview mockup pretend rehearse imagine'.split(' ');
const DEMO_MAP_WORDS = Array.from({ length: 116 }, (_, i) => DEMO_WORDS[(i * 5 + 3) % DEMO_WORDS.length]!);
const DEMO_QR = 'TRIKEYKIT1:DEMOKITNOTAREALKEY';

function demoKit(kind: 'seed' | 'xpub', now: Date): RecoveryKit {
  const date = now.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
  return {
    kind,
    html: `<!doctype html><html><body style="font-family:sans-serif;padding:32px"><h1>Trikey Recovery Kit (demo)</h1><p>This is the demo. It holds no key and moves no money.</p><p>Wallet ${DEMO_FINGERPRINT}</p></body></html>`,
    qrText: DEMO_QR,
    recoveryWords: DEMO_WORDS,
    mapWords: DEMO_MAP_WORDS,
    fingerprint: DEMO_FINGERPRINT,
    network: 'testnet',
    date,
    challenge: kind === 'seed' ? [2, 5, 9] : [],
    ...(kind === 'xpub' ? { device: 'second hardware wallet' } : {}),
  };
}

function checkProof(kit: RecoveryKit, proof: KitProof): void {
  if ('scanned' in proof) {
    if (proof.scanned !== kit.qrText) throw new WalletServiceError('kit_invalid', 'That scan is not this Recovery Kit.');
    return;
  }
  if ('words' in proof) {
    for (const pos of kit.challenge) {
      if ((proof.words[pos] ?? '').trim().toLowerCase() !== kit.recoveryWords[pos - 1]) throw new WalletServiceError('kit_invalid', `Word ${pos} does not match the kit.`);
    }
    return;
  }
  if (kit.kind === 'seed') throw new WalletServiceError('kit_invalid', 'Check a few words of the kit, or scan it.');
}

export interface MockHooks {
  get(): WalletState;
  update(change: Partial<WalletState> | ((s: WalletState) => Partial<WalletState>)): void;
  wait(ms: number): Promise<void>;
  deviceDelay: number;
  networkDelay: number;
  now: Date;
}

export function createMockRecoveryKey(h: MockHooks): RecoveryKeyActions {
  const patchRk = (change: Partial<RecoveryKeyState> | ((r: RecoveryKeyState) => Partial<RecoveryKeyState>)) =>
    h.update((s) => ({ recoveryKey: { ...s.recoveryKey, ...(typeof change === 'function' ? change(s.recoveryKey) : change) } }));
  let kit: RecoveryKit | undefined;

  return {
    keyOptions: () => [
      { kind: 'paper', available: true },
      { kind: 'nfc', available: false, unavailableReason: 'Coming later.' },
      { kind: 'hardware', available: true },
    ],
    async makeKit() {
      await h.wait(h.networkDelay);
      kit = demoKit(h.get().recoveryKey.keyKind === 'hardware' ? 'xpub' : 'seed', h.now);
      return kit;
    },
    async confirmKit(proof) {
      if (!kit) throw new WalletServiceError('wrong_state', 'Make the kit first.');
      checkProof(kit, proof);
      await h.wait(h.deviceDelay);
      const saved = kit.kind === 'seed' ? 'kit' : 'hardware';
      kit = undefined;
      patchRk({ stage: 'ready', savedKey: saved, fingerprint: DEMO_FINGERPRINT });
      return { fingerprint: DEMO_FINGERPRINT };
    },
    async previewRefills(opts = {}) {
      await h.wait(h.networkDelay);
      const rk = h.get().recoveryKey;
      const amountSats = opts.amountSats ?? rk.refillAmountSats;
      const maxCount = Math.max(0, Math.min(52, Math.floor((rk.vaultSats || 4_030_000) / Math.max(1, amountSats)) - 1));
      const count = Math.min(opts.count ?? rk.refillCount, maxCount);
      const schedule = buildRefillSchedule(amountSats, h.now, count).map((r) => ({ index: r.index, amountSats: r.amountSats, at: r.unlocksAt, today: r.index === 1 }));
      return { mode: 'fresh', amountSats, count, maxCount, periodDays: 7, feePerRefillSats: 220, totalSats: amountSats * count, vaultSats: rk.vaultSats, schedule, confirmations: count };
    },
    async approveRefills(opts = {}) {
      const rk = h.get().recoveryKey;
      const amountSats = opts.amountSats ?? rk.refillAmountSats;
      const count = opts.count ?? rk.refillCount;
      await h.wait(h.deviceDelay);
      patchRk({
        refillAmountSats: amountSats,
        refillCount: count,
        refillsLeft: count,
        refillsTotal: count,
        refillsStatus: 'live',
        needsApproval: false,
        invalidatedBy: null,
        refills: buildRefillSchedule(amountSats, h.now, count),
        next: { index: 1, amountSats, status: 'ready' },
      });
      return { from: 1, to: count };
    },
    async speedUp() {
      await h.wait(h.networkDelay);
      patchRk({ speedUp: null });
    },
    dismissNotice(id) {
      patchRk((r) => ({ notices: r.notices.filter((n) => n.id !== id) }));
    },
    vaultAddress: () => 'tb1qdemovaultaddress0000000000000000000000000000000000000',
    async verifyVaultAddress() {
      await h.wait(h.deviceDelay);
      return { address: 'tb1qdemovaultaddress0000000000000000000000000000000000000', verifiedOnDevice: true };
    },
    async readKit(input) {
      await h.wait(h.networkDelay);
      if (!input.trim() || /^bad/i.test(input.trim())) throw new WalletServiceError('kit_invalid', "That isn't a Trikey Recovery Kit.");
      const rk = h.get().recoveryKey;
      return { fingerprint: DEMO_FINGERPRINT, network: 'testnet' as NetworkName, kind: 'seed' as const, vaultSats: rk.vaultSats + rk.spendingSats, unconfirmedSats: 0, hardwareFingerprint: '5d80f6ab', matchesThisPhone: true };
    },
    async recoverWithKit(opts) {
      if (opts.destination && 'newVault' in opts.destination) {
        const fresh = demoKit('seed', h.now);
        const proof = await opts.confirmNewKit?.(fresh);
        if (!proof) throw new WalletServiceError('kit_invalid', 'The new Recovery Kit was not saved. Nothing moved.');
        checkProof(fresh, proof);
      }
      await h.wait(h.deviceDelay);
      const rk = h.get().recoveryKey;
      const total = rk.vaultSats + rk.spendingSats;
      const movedSats = total - 1_200;
      h.update({ onboarded: true });
      patchRk({ spendingSats: 0, vaultSats: movedSats, refillsLeft: 0, refillsTotal: 0, refillsStatus: 'none', needsApproval: true, next: null });
      return { txid: 'c3a7119e5d20'.padEnd(64, '0'), movedSats, feeSats: 1_200, newVault: 'newVault' in opts.destination };
    },
    async replaceKit(opts) {
      const fresh = demoKit('seed', h.now);
      const proof = await opts.confirmNewKit(fresh);
      if (!proof) throw new WalletServiceError('kit_invalid', 'The new Recovery Kit was not saved. Nothing moved.');
      checkProof(fresh, proof);
      await h.wait(h.deviceDelay);
      patchRk({ refillsLeft: 0, refillsTotal: 0, refillsStatus: 'none', needsApproval: true, next: null });
      return { txid: 'd41c8e07b3a9'.padEnd(64, '0'), movedSats: h.get().recoveryKey.vaultSats - 1_200, feeSats: 1_200, newVault: true };
    },
    setRefillDefaults(d: { amountSats: Sats; count: number }) {
      patchRk({ refillAmountSats: d.amountSats, refillCount: d.count });
    },
    async testServer(url) {
      await h.wait(h.networkDelay);
      try {
        parseServerUrl(url);
      } catch (e) {
        return { ok: false, message: e instanceof Error ? e.message : String(e) };
      }
      return { ok: true, height: 4_812_203, message: 'Connected. The chain is at block 4,812,203.' };
    },
    async setServer(url) {
      await h.wait(h.networkDelay);
      const parsed = url === null ? defaultServerUrl('testnet') : parseServerUrl(url);
      patchRk({ server: { url: parsed, isDefault: url === null } });
    },
  };
}
