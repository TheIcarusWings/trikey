/**
 * Routing of the owner's own wallets (docs/design/multi-wallet.md, sections 3 "Routing" and 4), in front of the first
 * wallet's handlers:
 *
 * - a request naming a wallet (`walletId`) reaches that wallet's engine only, and only from its paired phone (or, for the
 *   recovery methods, a phone with recovery access to it; for `recovery.cancel`, its alert contacts); an unknown id is
 *   refused, never applied to the first wallet;
 * - a request without `walletId` means the first wallet, as always, except a `recovery.cancel` naming an own wallet's
 *   recovery (`<slotId>w<n>-...`), and a sender that is only one own wallet's phone or recovery peer (after a recovery
 *   moved that wallet to a new phone);
 * - `recovery.access` is tried against the first wallet's hardware authorization key, then each own wallet's;
 * - `wallet.add.prepare` / `wallet.add` add a wallet (the first wallet's paired phone, unlocked).
 *
 * A guardian without own wallets answers exactly as before (and `wallet.add.*` refuses nothing it did not refuse before:
 * they are new methods).
 */
import { ErrorCode, RpcError, type HandlerContext, type Handlers, type MethodName } from '@trikey/protocol';
import type { Guardian } from '../guardian.js';
import { takeRequestWrite } from '../rate-limit.js';
import { BOX_METHODS, ROUTED_METHODS, type OwnWallets } from './service.js';
import type { OwnWallet } from './runtime.js';

/** How long a request id is remembered: the protocol's longest request TTL (1 h) plus clock skew (as `runOnceAcrossRestarts`). */
const REMEMBER_MS = (3600 + 120) * 1000;

type AnyHandler = (params: unknown, ctx: HandlerContext) => unknown;

/** Where a request goes: the first wallet's handlers, or an own wallet's. */
export function routeOf(g: Guardian, wallets: OwnWallets, method: MethodName, params: unknown, sender: string): 'first' | OwnWallet {
  const p = (params ?? {}) as { walletId?: unknown; recoveryId?: unknown };
  const firstReg = g.engine.registration();
  if (typeof p.walletId === 'string') {
    if (firstReg && p.walletId === firstReg.walletId) {
      if (!g.authorizeHost(sender, method)) throw new RpcError(ErrorCode.Unauthorized, 'This phone may not act on that wallet.');
      return 'first';
    }
    const w = wallets.byWalletId(p.walletId);
    if (!w) throw new RpcError(ErrorCode.InvalidParams, `This guardian guards no wallet ${p.walletId}.`, { reason: 'unknown_wallet', walletId: p.walletId });
    if (!wallets.mayAct(w, sender, method)) throw new RpcError(ErrorCode.Unauthorized, 'This phone may not act on that wallet.');
    return w;
  }
  // An alert contact's (or any peer's) cancel names the recovery, and the recovery id names its wallet.
  if (method === 'recovery.cancel') {
    const w = wallets.byRecoveryId(p.recoveryId);
    if (w) {
      if (!wallets.mayAct(w, sender, method)) throw new RpcError(ErrorCode.Unauthorized);
      return w;
    }
  }
  if (g.authorizeHost(sender, method)) return 'first';
  // A phone that is only one own wallet's (a recovery moved that wallet to it): that wallet.
  const mine = wallets.forSender(sender);
  if (mine.length === 1) return mine[0];
  if (mine.length > 1) throw new RpcError(ErrorCode.InvalidParams, 'Name the wallet this request is for (walletId).', { reason: 'wallet_required' });
  return 'first';
}

export function withOwnWallets(g: Guardian, first: Handlers): Handlers {
  const wallets = g.wallets;
  const out: Record<string, unknown> = { ...first };
  for (const m of ROUTED_METHODS) {
    const h = first[m] as AnyHandler | undefined;
    if (!h) continue;
    out[m] = (params: unknown, ctx: HandlerContext) => {
      const to = routeOf(g, wallets, m, params, ctx.sender);
      if (to === 'first') return h(params, ctx);
      return (wallets.handlersOf(to)[m] as AnyHandler)(params, ctx);
    };
  }
  // The first wallet's other methods (Savings, silent payments, the helper coin, unwatch, pairing) stay the first
  // wallet's; a phone that is only an own wallet's may not call them on the first wallet's account.
  for (const m of Object.keys(first) as MethodName[]) {
    if (ROUTED_METHODS.includes(m) || BOX_METHODS.includes(m) || m === 'recovery.access' || m === 'pair' || m === 'pair.prepare') continue;
    if (m.startsWith('hosted.')) continue;
    const h = first[m] as AnyHandler;
    out[m] = (params: unknown, ctx: HandlerContext) => {
      if (wallets.active().length && !g.authorizeHost(ctx.sender, m)) throw new RpcError(ErrorCode.Unauthorized, 'Only the first wallet has this, and this phone is not its phone.');
      return h(params, ctx);
    };
  }
  // The hardware wallet lets a new phone in: the first wallet's key first (as before), then each own wallet's.
  const access = first['recovery.access'] as AnyHandler | undefined;
  if (access)
    out['recovery.access'] = async (params: unknown, ctx: HandlerContext) => {
      let firstError: unknown;
      if (g.engine.registration()) {
        try {
          return await access(params, ctx);
        } catch (e) {
          if (!(e instanceof RpcError) || !wallets.active().length) throw e;
          firstError = e;
        }
      }
      for (const w of wallets.active()) {
        try {
          return await (wallets.handlersOf(w)['recovery.access'] as AnyHandler)(params, ctx);
        } catch (e) {
          if (!(e instanceof RpcError)) throw e;
          firstError ??= e;
        }
      }
      throw firstError ?? new RpcError(ErrorCode.PolicyViolation, 'No wallet of this guardian matches that hardware wallet.');
    };
  out['wallet.add.prepare'] = (params: unknown, ctx: HandlerContext) => wallets.prepare(ctx.sender, params as never);
  // Outside `runOnceAcrossRestarts` (this wrapper sits in front of it), so the durable record is applied here: a
  // replayed `wallet.add` after a restart must not create a second wallet (security sweep 2 follow-up).
  out['wallet.add'] = async (params: unknown, ctx: HandlerContext) => {
    takeRequestWrite(g, ctx.sender);
    const fresh = await g.service.rememberRequest(`${ctx.sender}:${ctx.id}`, ctx.createdAt * 1000 + REMEMBER_MS, g.clock.now());
    if (!fresh) throw new RpcError(ErrorCode.Unavailable, 'This request was already handled before the guardian restarted. Send a new request.');
    return g.pairMutex.run(() => wallets.add(ctx.sender, params as never));
  };
  return out as Handlers;
}
