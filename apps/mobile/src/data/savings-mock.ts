/**
 * Savings for the demo: the same `SavingsActions` as the real wallet, with made-up data and timers, so every Savings screen
 * can be looked at without a guardian, a chain or a second hardware wallet. The demo starts without Savings (as everyone
 * does: it is strictly optional); "Create Savings" sets up an empty one, and Settings > Developer can show one holding money.
 * The addresses are real-looking samples; they hold nothing.
 */
import { WalletServiceError } from './errors';
import { emptySavings } from './savings-empty';
import type { SavingsActions } from './savings-actions';
import type { MockHooks } from './rk-mock';
import type { HardwareKind, Sats, SavingsActivityItem, SavingsDevice, SavingsQuote, SavingsSigners, SavingsState } from './types';

/** The demo's Savings receive addresses (index 0, 1, ...): samples, not anyone's wallet. */
export const DEMO_SAVINGS_ADDRESSES = [
  'tb1q4wsvsakhjue3pm8a38zqp6xj7gd39mwq4wsvsakhjue3pm8a38zqp6xj7g',
  'tb1qlne8shken3nsuf7w3n0n49yvvwgyhw7glne8shken3nsuf7w3n0n49yvvw',
  'tb1qf46d46c8jajmvgusmm5z4x4e8ntmneswf46d46c8jajmvgusmm5z4x4e8n',
];
export const DEMO_SAVINGS_DESCRIPTOR =
  "wsh(sortedmulti(2,[c0ffee01/48h/1h/1h/2h]tpubDEMOphoneSAVINGSxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx/<0;1>/*,[7c1e5a90/48h/1h/1h/2h]tpubDEMOhardwareSAVINGSxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx/<0;1>/*,[5e7d2c4b/48h/1h/1h/2h]tpubDEMOrecoveryKEYxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx/<0;1>/*))#demo5av1";

/** The demo's fee for a Savings payment (one 2-of-3 input, two outputs, at the slow rate). */
const DEMO_SAVINGS_FEE: Sats = 640;
const MIN_PAYMENT: Sats = 546;

export const isDemoSavingsAddress = (address: string) => DEMO_SAVINGS_ADDRESSES.includes(address.trim());

const RECOVERY_KEY_DEVICES: Record<HardwareKind, SavingsDevice> = {
  simulated: { brand: 'simulated device', model: 'Second simulated device', fingerprint: '5e7d2c4b' },
  ledger: { brand: 'Ledger', model: 'Ledger Nano S Plus', fingerprint: '5e7d2c4b' },
  trezor: { brand: 'Trezor', model: 'Trezor Safe 3', fingerprint: '5e7d2c4b' },
  bitbox02: { brand: 'BitBox02', model: 'BitBox02', fingerprint: '5e7d2c4b' },
  qr: { brand: 'Coldcard', model: 'Coldcard Mk4', fingerprint: '5e7d2c4b' },
};

/** Savings holding money, for Settings > Developer: the balance the design shows (0.48 BTC). */
export function demoFilledSavings(hardware: { brand: string; model: string }): SavingsState {
  const iso = (s: string) => new Date(s).toISOString();
  return {
    status: 'active',
    balanceSats: 48_000_000,
    unconfirmedSats: 0,
    walletId: 'd3m05av1n6s00001',
    descriptor: DEMO_SAVINGS_DESCRIPTOR,
    createdAt: iso('2026-10-02T10:00:00'),
    hardware: { brand: hardware.brand, model: hardware.model, fingerprint: '7c1e5a90' },
    recoveryKey: RECOVERY_KEY_DEVICES.trezor,
    watchedByGuardian: true,
    activity: [
      { id: 'sv-1', txid: 'e5a1c0d2'.padEnd(64, '7'), kind: 'received', amountSats: 30_000_000, at: iso('2026-10-25T09:30:00'), status: 'confirmed' },
      { id: 'sv-2', txid: '91bd44f0'.padEnd(64, '3'), kind: 'received', amountSats: 18_000_000, at: iso('2026-10-02T10:20:00'), status: 'confirmed' },
    ],
    creating: null,
  };
}

export function createMockSavings(h: MockHooks, nextId: (prefix: string) => string): SavingsActions {
  const sv = (): SavingsState => h.get().savings;
  const patch = (change: Partial<SavingsState> | ((s: SavingsState) => Partial<SavingsState>)) =>
    h.update((s) => ({ savings: { ...s.savings, ...(typeof change === 'function' ? change(s.savings) : change) } }));
  let receiveIndex = 0;
  const requireActive = () => {
    if (sv().status !== 'active') throw new WalletServiceError('wrong_state', 'Set up Savings first.');
  };
  const requireCreating = () => {
    const c = sv().creating;
    if (!c) throw new WalletServiceError('wrong_state', 'Start creating Savings first.');
    return c;
  };

  return {
    async start() {
      if (sv().status === 'active') throw new WalletServiceError('wrong_state', 'This wallet already has Savings.');
      if (sv().status !== 'available') throw new WalletServiceError('not_available', 'Your guardian cannot watch a Savings wallet yet. Update it first.');
      await h.wait(h.networkDelay);
      patch({ creating: { phone: true, hardware: false } });
    },
    async connectHardware() {
      requireCreating();
      await h.wait(h.deviceDelay);
      patch((s) => ({ creating: { ...s.creating!, hardware: true } }));
    },
    async connectRecoveryKey(kind: HardwareKind) {
      const c = requireCreating();
      if (!c.hardware) throw new WalletServiceError('wrong_state', `Connect your ${h.get().hardware.brand} first.`);
      await h.wait(h.deviceDelay * 2);
      const device = RECOVERY_KEY_DEVICES[kind];
      patch((s) => ({ creating: { ...s.creating!, recoveryKey: device } }));
      return device;
    },
    async finish() {
      const c = requireCreating();
      if (!c.hardware || !c.recoveryKey) throw new WalletServiceError('wrong_state', 'Connect your hardware wallet and your Recovery Key first.');
      await h.wait(h.deviceDelay * 2);
      const hw = h.get().hardware;
      patch({
        status: 'active',
        walletId: 'd3m05av1n6s00001',
        descriptor: DEMO_SAVINGS_DESCRIPTOR,
        createdAt: h.now.toISOString(),
        hardware: { brand: hw.brand, model: hw.model, fingerprint: '7c1e5a90' },
        recoveryKey: c.recoveryKey,
        watchedByGuardian: true,
        creating: null,
      });
      return { descriptor: DEMO_SAVINGS_DESCRIPTOR, firstAddress: DEMO_SAVINGS_ADDRESSES[0]!, watchedByGuardian: true };
    },
    cancelCreate() {
      if (sv().creating) patch({ creating: null });
    },
    async receiveAddress(opts = {}) {
      requireActive();
      if (opts.verifyOnDevice) await h.wait(h.deviceDelay);
      const address = DEMO_SAVINGS_ADDRESSES[Math.min(receiveIndex, DEMO_SAVINGS_ADDRESSES.length - 1)]!;
      return { address, verifiedOnDevice: !!opts.verifyOnDevice };
    },
    quote({ address, amountSats, max }) {
      if (sv().status !== 'active') return { ok: false, problem: 'not_ready', message: 'Set up Savings first.' };
      if (!/^(tb1|bc1|bcrt1)[a-z0-9]{20,}$/i.test(address.trim())) return { ok: false, problem: 'invalid_address', message: 'Not a valid address.' };
      const balance = sv().balanceSats;
      const amount = max ? balance - DEMO_SAVINGS_FEE : amountSats;
      if (max && amount < MIN_PAYMENT) return { ok: false, problem: 'amount_too_small', message: 'After the network fee, what is left in Savings is less than the smallest payment.' };
      if (amount < MIN_PAYMENT) return { ok: false, problem: 'amount_too_small', message: `The smallest payment is ${MIN_PAYMENT} sats.` };
      if (amount + DEMO_SAVINGS_FEE > balance) return { ok: false, problem: 'insufficient_funds', message: `Not enough in Savings: ${balance} sats.` };
      const quote: SavingsQuote = {
        address: address.trim(),
        amountSats: amount,
        feeSats: DEMO_SAVINGS_FEE,
        totalSats: amount + DEMO_SAVINGS_FEE,
        toSpending: address.trim() === h.get().receiveAddress,
        ...(max ? { max: true as const } : {}),
      };
      return { ok: true, quote };
    },
    async send(quote: SavingsQuote, signers: SavingsSigners) {
      requireActive();
      // Two keys, at least one of them a hardware wallet: a device step either way.
      await h.wait(h.deviceDelay * (signers === 'hardware+recoveryKey' ? 2 : 1));
      const item: SavingsActivityItem = {
        id: nextId('sv'),
        txid: nextId('5a').replace(/[^0-9a-f]/g, '').padEnd(64, 'a'),
        kind: quote.toSpending ? 'to-spending' : 'sent',
        amountSats: quote.amountSats,
        feeSats: quote.feeSats,
        at: h.now.toISOString(),
        status: 'pending',
        address: quote.address,
        signedBy: signers,
      };
      patch((s) => ({ balanceSats: s.balanceSats - quote.totalSats, activity: [item, ...s.activity] }));
      if (quote.toSpending) h.update((s) => ({ balanceSats: s.balanceSats + quote.amountSats }));
      return { txid: item.txid, amountSats: quote.amountSats, feeSats: quote.feeSats };
    },
    async replaceKey(lost, opts = {}) {
      requireActive();
      await h.wait(h.deviceDelay * 3);
      const fee = sv().balanceSats > 0 ? DEMO_SAVINGS_FEE : 0;
      const moved = Math.max(0, sv().balanceSats - fee);
      const item: SavingsActivityItem = { id: nextId('sv'), txid: nextId('6b').replace(/[^0-9a-f]/g, '').padEnd(64, 'b'), kind: 'key-replacement', amountSats: moved, feeSats: fee, at: h.now.toISOString(), status: 'pending' };
      patch((s) => ({
        balanceSats: moved,
        walletId: 'd3m05av1n6s00002',
        ...(lost === 'recoveryKey' ? { recoveryKey: { ...RECOVERY_KEY_DEVICES[opts.recoveryKeyKind ?? 'trezor'], fingerprint: '2b9f6d13' } } : {}),
        activity: moved > 0 ? [item, ...s.activity] : s.activity,
      }));
      return { movedSats: moved, feeSats: fee };
    },
    async findOnGuardian() {
      await h.wait(h.networkDelay);
      return sv().descriptor ? { descriptor: sv().descriptor! } : null;
    },
  };
}

/** Called by the demo's `sendPayment`: a payment to a Savings address lands in Savings ("Add to Savings"). */
export function creditDemoSavings(s: SavingsState, amountSats: Sats, txid: string, at: string, id: string): SavingsState {
  return { ...s, unconfirmedSats: s.unconfirmedSats + amountSats, balanceSats: s.balanceSats + amountSats, activity: [{ id, txid, kind: 'received', amountSats, at, status: 'pending' }, ...s.activity] };
}

export { emptySavings };
