/**
 * Silent payments for the demo: the same `SilentPaymentActions` as the real wallet, with made-up data and timers, so every
 * silent payment screen can be looked at without a guardian or a chain. The addresses are real-looking samples of keys
 * made from a fixed phrase; they hold nothing.
 */
import { NODE_RPC_TEXT, WalletServiceError } from './errors';
import { emptySilentPayments } from './sp-empty';
import type { SilentPaymentActions } from './sp-actions';
import type { MockHooks } from './rk-mock';
import type { ActivityItem, Sats, SilentPaymentCoin, SilentPaymentsState, WalletState } from './types';

export const DEMO_SP_ADDRESS = 'sp1qqtxav45tagpd9ghte4508c0pp80h7ux6dwper308na6lr3hcv0zsuqnehrv8d59yxz5fhsdmvqzy65tw7g56csdf9t5k7ysk0229zyehq5e9tk5x';
export const DEMO_SP_LABELLED = 'sp1qqtxav45tagpd9ghte4508c0pp80h7ux6dwper308na6lr3hcv0zsuqaptx7hwh59npd30tfgc874pax8t6d5f4r9qh73v2kpa209mw69eu4htv60';
/** Somebody else's silent payment address, for the demo's Send screen. */
export const DEMO_SP_RECIPIENT = 'sp1qqv9ef4k6ckrf5vs4qv69p06wp33caqps80mqhlj6ma35u5lw7q706qkqul3sddgehr4yygxpj46yxw8lmzzvlx5067glgm49kknc4m8cx5smhavp';
export const DEMO_HELPER_ADDRESS = 'bc1q4nzs0v3dfx8wjcl6e7hqkm9u2tpy5a3rg6f0dk';
/** The plain taproot address a hardware wallet shows for the payment to `DEMO_SP_RECIPIENT`. */
export const DEMO_TAPROOT_OUTPUT = 'bc1p5cyxnuxmeuwuvkwfem96lqzszd02n6xdcjrs20cac6yqjjwudpxqkedrcr';

/** Sats per virtual byte the demo's fee estimate says, and the vbytes of one move of a coin into the vault. */
const DEMO_RATE = 4;
const VB_MOVE = 111;
const MIN_NET = 1_000;

const iso = (s: string) => new Date(s).toISOString();

export function demoCoins(): SilentPaymentCoin[] {
  return [
    { id: `a1f07c3e9d54:0`, txid: 'a1f07c3e9d54'.padEnd(64, '0'), valueSats: 30_000, confirmed: true, foundAt: iso('2026-10-28T19:40:00') },
    { id: `3be2d90f17a8:1`, txid: '3be2d90f17a8'.padEnd(64, '0'), valueSats: 12_000, label: 1, confirmed: true, foundAt: iso('2026-10-27T08:15:00') },
  ];
}

/** Fills in `balance` and `move` from the coins. */
export function withCoins(sp: SilentPaymentsState, coins: SilentPaymentCoin[]): SilentPaymentsState {
  const fee = Math.ceil(VB_MOVE * DEMO_RATE);
  const lines = coins.map((c) => ({ id: c.id, valueSats: c.valueSats, feeSats: fee, netSats: Math.max(0, c.valueSats - fee), waiting: c.valueSats - fee < MIN_NET }));
  const ready = lines.filter((l) => !l.waiting);
  return {
    ...sp,
    coins,
    balance: { sats: coins.reduce((a, c) => a + c.valueSats, 0), unconfirmedSats: coins.filter((c) => !c.confirmed).reduce((a, c) => a + c.valueSats, 0) },
    move: { feeRateSatPerVb: DEMO_RATE, ready: ready.length, totalFeeSats: ready.length * fee, totalNetSats: ready.reduce((a, l) => a + l.netSats, 0), coins: lines },
  };
}

export function demoSilentPayments(): SilentPaymentsState {
  return withCoins(
    {
      ...emptySilentPayments('full'),
      setUp: true,
      receiving: true,
      scan: { state: 'ok', source: 'guardian', scannedHeight: 4_812_203, tipHeight: 4_812_203, checkedAt: iso('2026-10-29T15:19:00'), lastMatchAt: iso('2026-10-28T19:40:00') },
      labels: [1],
      helper: { sats: 24_320, unconfirmedSats: 0, funded: true, viaGuardian: true },
    },
    demoCoins(),
  );
}

export function demoSilentActivity(): ActivityItem[] {
  const pay = (tx: Extract<ActivityItem, { type: 'payment' }>['tx']): ActivityItem => ({ type: 'payment', at: tx.at, tx });
  return [
    pay({ id: 'sp-rx-a1f07c3e9d54:0', kind: 'silent_received', amountSats: 30_000, status: 'confirmed', at: iso('2026-10-28T19:40:00'), txid: 'a1f07c3e9d54'.padEnd(64, '0') }),
    pay({ id: 'sp-rx-3be2d90f17a8:1', kind: 'silent_received', amountSats: 12_000, status: 'confirmed', at: iso('2026-10-27T08:15:00'), txid: '3be2d90f17a8'.padEnd(64, '0'), silentLabel: 1 }),
    pay({ id: 'sp-mv-8c41f0aa2b6d', kind: 'silent_sweep', amountSats: 74_556, feeSats: 444, status: 'confirmed', at: iso('2026-10-24T10:02:00'), txid: '8c41f0aa2b6d'.padEnd(64, '0') }),
  ];
}

/** What the demo's Settings > Developer can flip, to look at the 1700 state. */
export interface MockSilentControl {
  nodeRpc: boolean;
}

export function createMockSilentPayments(h: MockHooks, control: MockSilentControl, nextId: (prefix: string) => string): SilentPaymentActions {
  const patch = (change: (sp: SilentPaymentsState) => SilentPaymentsState) => h.update((s) => ({ silentPayments: change(s.silentPayments) }));
  const sp = (): SilentPaymentsState => h.get().silentPayments;
  const labelled = (label: number) => (label === 1 ? DEMO_SP_LABELLED : `${DEMO_SP_ADDRESS.slice(0, -4)}${label.toString(36).padStart(4, 'q')}`);
  let helperIndex = 0;
  let found = false;

  /** The scan state a guardian without its node's RPC is in: receiving paused. */
  const scanState = (): SilentPaymentsState['scan'] =>
    control.nodeRpc
      ? { state: 'ok', source: 'guardian', scannedHeight: 4_812_203, tipHeight: 4_812_203, checkedAt: h.now.toISOString(), ...(sp().scan.lastMatchAt ? { lastMatchAt: sp().scan.lastMatchAt } : {}) }
      : { state: 'needs_node_rpc', source: 'guardian', scannedHeight: sp().scan.scannedHeight, checkedAt: h.now.toISOString(), message: NODE_RPC_TEXT };

  return {
    async enable() {
      await h.wait(h.deviceDelay); // Face ID, the first time
      patch((s) => ({ ...s, setUp: true, receiving: true, scan: scanState() }));
    },
    async disable() {
      await h.wait(h.networkDelay);
      patch((s) => ({ ...s, receiving: false, scan: { ...s.scan, state: 'off' } }));
    },
    async address(opts = {}) {
      if (!sp().setUp) await this.enable();
      if (!sp().receiving) throw new WalletServiceError('silent_payments_off', 'Silent payments are turned off. Turn them on in Settings to get an address.');
      if (opts.label === undefined) return DEMO_SP_ADDRESS;
      if (opts.label < 1) throw new WalletServiceError('invalid_input', "That label can't be used. Labels start at 1.");
      return labelled(opts.label);
    },
    async addLabel() {
      await h.wait(h.networkDelay);
      const label = Math.max(0, ...sp().labels) + 1;
      patch((s) => ({ ...s, labels: [...s.labels, label] }));
      return { label, address: labelled(label) };
    },
    async helperAddress() {
      helperIndex += 1;
      return helperIndex === 1 ? DEMO_HELPER_ADDRESS : `${DEMO_HELPER_ADDRESS.slice(0, -3)}${helperIndex.toString(36).padStart(3, '0')}`;
    },
    async check() {
      await h.wait(h.networkDelay);
      if (!sp().receiving) return { found: 0 };
      if (!control.nodeRpc) {
        patch((s) => ({ ...s, scan: scanState() }));
        throw new WalletServiceError('node_rpc_required', NODE_RPC_TEXT);
      }
      let count = 0;
      if (!found) {
        found = true;
        count = 1;
        const coin: SilentPaymentCoin = { id: `d70c8e15b3a9:0`, txid: 'd70c8e15b3a9'.padEnd(64, '0'), valueSats: 18_500, confirmed: false, foundAt: h.now.toISOString() };
        const item: ActivityItem = { type: 'payment', at: coin.foundAt, tx: { id: `sp-rx-${coin.id}`, kind: 'silent_received', amountSats: coin.valueSats, status: 'pending', at: coin.foundAt, txid: coin.txid } };
        h.update((s) => ({ activity: [item, ...s.activity] }));
        patch((s) => withCoins({ ...s, scan: { ...scanState(), lastMatchAt: coin.foundAt } }, [coin, ...s.coins]));
      } else patch((s) => ({ ...s, scan: scanState() }));
      return { found: count };
    },
    async move() {
      const plan = sp().move;
      const ready = plan.coins.filter((c) => !c.waiting);
      if (!ready.length) return { moved: 0, movedSats: 0, feeSats: 0, waiting: plan.coins.length, failed: 0 };
      await h.wait(h.deviceDelay); // one Face ID for all of them
      let movedSats: Sats = 0;
      let feeSats: Sats = 0;
      const items: ActivityItem[] = [];
      for (const line of ready) {
        const txid = nextId('mv').padEnd(64, '0');
        movedSats += line.netSats;
        feeSats += line.feeSats;
        items.push({ type: 'payment', at: h.now.toISOString(), tx: { id: `sp-mv-${txid}`, kind: 'silent_sweep', amountSats: line.netSats, feeSats: line.feeSats, status: 'pending', at: h.now.toISOString(), txid } });
      }
      const movedIds = new Set(ready.map((r) => r.id));
      h.update((s) => ({ balanceSats: s.balanceSats + movedSats, activity: [...items, ...s.activity] }));
      patch((s) => withCoins(s, s.coins.filter((c) => !movedIds.has(c.id))));
      return { moved: ready.length, movedSats, feeSats, waiting: plan.coins.length - ready.length, failed: 0 };
    },
  };
}

/** A silent payment sent from the demo's wallet: the quote's extras (the helper coin pays a share of the fee). */
export const DEMO_HELPER_FEE: Sats = Math.ceil((68 + 31) * DEMO_RATE);

export function demoNeedsHelper(state: WalletState): boolean {
  return state.mode === 'guardian' && !state.silentPayments.helper.funded;
}
