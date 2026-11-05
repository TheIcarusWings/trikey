/**
 * The web UI's Wallet page (`GET /api/wallet`): the paired wallet, view and receive only. Nothing here spends, signs or
 * needs key 3, so it answers while the guardian is locked; it is behind the web session like the rest of the API.
 *
 * - **Where the numbers come from.** The live wallet (live-wallet.ts) reads the paired wallet on every change the chain
 *   source reports and on every block; the page answers from its last read (`LiveWallet.lastRead`). Only when there is
 *   none yet (just started, just paired, live wallet off) does it read the chain itself, once at a time, and keeps that
 *   for `COLD_READ_TTL_MS`.
 * - **The receive address** is the phone's rule, not a new one: the first unused address of the receive chain after the
 *   highest used one (`WalletSync.nextReceiveIndex`, which the phone's `wallet.sync` carries too and its Receive screen
 *   derives from), derived from the stored descriptor. A web visit never moves the index on, and the index is never past
 *   the highest used one plus one, so a restore scanning with any gap limit finds a payment to it. Without a read of
 *   the chain there is no address: an address from an older guess could differ from the phone's.
 * - **Family hosting.** Only the host's own registration: a guest's wallet is not the guardian's to show (BIP 89: it
 *   does not know a guest's addresses), and nothing here counts guests.
 * - **Payments** use the words of the phone's `wallet_tx` alerts (`describeTx`): in, out (the fee apart when known),
 *   a move within the wallet.
 */
import type { Guardian } from '../guardian.js';
import type { WalletSync } from '../chain/chain.js';
import { describeTx, LIVE_HISTORY } from '../live-wallet.js';
import type { NetworkName } from '@trikey/core';
import { savingsSummary } from './api.js';
import type { WalletOverview, WalletPayment } from './types.js';

/** A read the page made itself (no live read yet) is reused this long. */
export const COLD_READ_TTL_MS = 15_000;

const iso = (ms: number) => new Date(ms).toISOString();

/** The receive address at `index` of a wallet (its stored descriptor): the phone's `receiveAddress` derivation. */
export function receiveAddressAt(g: Pick<Guardian, 'walletOf'>, w: { descriptor: string; network: NetworkName }, index: number): string {
  return g.walletOf(w).derive(0, index).address;
}

/** The payments of a read of the wallet, unconfirmed ones first, then newest first. */
export function paymentsOf(r: Pick<WalletSync, 'history'>): WalletPayment[] {
  const list = r.history.map((h): WalletPayment & { height: number } => {
    const d = describeTx(h);
    return {
      txid: h.txid,
      direction: d.direction,
      amountSats: Number(d.amountSats),
      ...(d.feeSats !== undefined ? { feeSats: Number(d.feeSats) } : {}),
      confirmations: h.confirmations,
      ...(h.confirmations > 0 && h.time !== undefined ? { at: iso(h.time * 1000) } : {}),
      height: h.height,
    };
  });
  const pending = (p: { confirmations: number }) => (p.confirmations > 0 ? 1 : 0);
  return list.sort((a, b) => pending(a) - pending(b) || b.height - a.height).map(({ height: _, ...p }) => p);
}

interface Read {
  walletId: string;
  at: number;
  sync: WalletSync;
}

const coldReads = new WeakMap<Guardian, Read>();
const reading = new WeakMap<Guardian, Promise<Read>>();

/** The paired wallet's latest read: the live wallet's, else one of its own (shared by concurrent requests). */
async function readWallet(g: Guardian, reg: { walletId: string; descriptor: string; network: NetworkName }): Promise<Read> {
  const live = g.live?.lastRead.get(reg.walletId);
  const cold = coldReads.get(g);
  const fresh = cold && cold.walletId === reg.walletId && g.clock.now() - cold.at < COLD_READ_TTL_MS ? cold : undefined;
  if (live && (!fresh || live.at >= fresh.at)) return { walletId: reg.walletId, ...live };
  if (fresh) return fresh;
  let p = reading.get(g);
  if (!p) {
    p = (async () => {
      const sync = await g.chain.walletSync(g.walletOf(reg), { historyLimit: LIVE_HISTORY, minIndex: g.scanFloor(reg.walletId) });
      const read = { walletId: reg.walletId, at: g.clock.now(), sync };
      coldReads.set(g, read);
      return read;
    })().finally(() => reading.delete(g));
    reading.set(g, p);
  }
  const read = await p;
  if (read.walletId !== reg.walletId) throw new Error('the paired wallet changed during the read');
  return read;
}

/** `GET /api/wallet`. */
export async function walletOverview(g: Guardian): Promise<WalletOverview> {
  const state = g.locked ? 'locked' : 'unlocked';
  const reg = g.engine.registration();
  if (!reg) return { paired: false, state, network: g.config.network };
  const s = g.engine.status();
  const limit = s.dailyLimit;
  const base: WalletOverview = {
    paired: true,
    state,
    network: g.config.network,
    walletId: reg.walletId,
    walletName: 'Main',
    ...(limit
      ? {
          dailyLimit: {
            limitSats: Number(limit.limit),
            usedSats: Number(limit.used),
            leftSats: Number(limit.available),
            ...(limit.off ? { limitOff: true as const } : {}),
          },
        }
      : {}),
    ...(g.engine.savings() ? { savings: savingsSummary(g) } : {}),
  };
  let read: Read;
  try {
    read = await readWallet(g, reg);
  } catch {
    // The error's words can name the owner's own node: the page says it plainly instead.
    return { ...base, chainError: "The guardian can't read the blockchain right now, so it can't show the balance, the payments or an address to receive at. Your phone can." };
  }
  const r = read.sync;
  return {
    ...base,
    balance: { confirmedSats: Number(r.confirmedSats), unconfirmedSats: Number(r.unconfirmedSats) },
    payments: paymentsOf(r),
    ...(r.historyTruncated ? { paymentsTruncated: true } : {}),
    receive: { address: receiveAddressAt(g, reg, r.nextReceiveIndex), index: r.nextReceiveIndex },
    readAt: iso(read.at),
    tipHeight: r.tipHeight,
  };
}
