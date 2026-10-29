/**
 * One run of the refill scheduler without the app on screen: what the background task does. No React, no native
 * modules: the phone's stores come in as arguments, so Node tests it.
 *
 * It opens the Recovery Key wallet the way the app does (the state's integrity check, the refill chain's signatures),
 * asks the chain server what happened, sends the next refill when it is unlocked and the spending balance is low, and
 * closes the wallet. It needs no key and no hardware wallet: the refills are already signed. It does need the secure
 * store's integrity key, which a locked iPhone does not give out; then the run ends quietly and the app does the work
 * the next time it opens.
 */
import { EsploraClient, RecoveryKeyWallet, type FetchLike } from '@trikey/recovery-key';
import type { KeyValueStore, SecureKeyStore } from '@trikey/wallet';
import { rkWalletKey } from './rk-service';
import { defaultServerUrl } from './rk-server';
import { SELECTABLE_NETWORKS, type NetworkName } from './types';

export const MODE_KEY = 'trikey.app.mode';
/** The background task's name. */
export const RK_BACKGROUND_TASK = 'trikey.rk.scheduler';

export type BackgroundRun =
  /** There is no Recovery Key wallet to look after in the mode the app is in (or the app is in demo or simulator mode). */
  | { ran: false; reason: 'no-wallet' | 'not-real-mode' }
  /** It opened the wallet and read the chain; `broadcast` is the refill it sent, if any. */
  | { ran: true; network: NetworkName; broadcast?: string }
  /** It could not (a locked phone, a server that did not answer, a wallet that failed its check). */
  | { ran: false; reason: 'failed'; message: string };

export async function runRkSchedulerOnce(deps: { kv: KeyValueStore; secureKeys: SecureKeyStore; fetch?: FetchLike; clock?: { now(): number } }): Promise<BackgroundRun> {
  const mode = await deps.kv.get(MODE_KEY).catch(() => null);
  if (mode !== 'real') return { ran: false, reason: 'not-real-mode' };
  for (const network of SELECTABLE_NETWORKS) {
    const key = rkWalletKey('real', network);
    if ((await deps.kv.get(key).catch(() => null)) === null) continue;
    let w: RecoveryKeyWallet | undefined;
    try {
      let server: string | undefined;
      try {
        const doc = JSON.parse((await deps.kv.get(`${key}.app`)) ?? 'null') as { server?: unknown } | null;
        if (typeof doc?.server === 'string') server = doc.server;
      } catch {
        /* the default server */
      }
      w = await RecoveryKeyWallet.open({
        network,
        secureStore: deps.secureKeys,
        store: deps.kv,
        storageKey: key,
        esplora: new EsploraClient({ baseUrl: server ?? defaultServerUrl(network), ...(deps.fetch ? { fetch: deps.fetch } : {}) }),
        ...(deps.clock ? { clock: deps.clock } : {}),
      });
      if (!w || w.state.stage !== 'ready') continue;
      const r = await w.runScheduler();
      return { ran: true, network, ...(r.broadcast ? { broadcast: r.broadcast } : {}) };
    } catch (e) {
      return { ran: false, reason: 'failed', message: e instanceof Error ? e.message : String(e) };
    } finally {
      await w?.close().catch(() => undefined);
    }
  }
  return { ran: false, reason: 'no-wallet' };
}
