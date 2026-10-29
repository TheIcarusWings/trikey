/**
 * The Esplora REST API over a `SimChain`: the routes the wallet uses, with
 * Esplora's answers and error bodies. `simFetch` serves them in-process
 * (no network, works anywhere `fetch` would); `startFakeEsplora` (Node only)
 * serves them over HTTP.
 */
import type { FetchLike } from '../esplora.js';
import { SimChain, SimRejection } from './sim-chain.js';

export interface RouteResult {
  status: number;
  body: string;
  type: 'text' | 'json';
}

const text = (body: string, status = 200): RouteResult => ({ status, body, type: 'text' });
const json = (v: unknown, status = 200): RouteResult => ({ status, body: JSON.stringify(v), type: 'json' });

export interface FakeEsploraHooks {
  /** Called before each request; return a result to answer it instead (fault injection). */
  intercept?: (method: string, path: string, body: string) => RouteResult | undefined;
  /** Every request, for assertions (method and path). */
  log?: { method: string; path: string }[];
}

export function routeEsplora(chain: SimChain, method: string, path: string, body = '', hooks: FakeEsploraHooks = {}): RouteResult {
  hooks.log?.push({ method, path });
  const hit = hooks.intercept?.(method, path, body);
  if (hit) return hit;
  const p = path.replace(/\?.*$/, '');
  let m: RegExpExecArray | null;
  if (method === 'POST' && p === '/tx') {
    try {
      return text(chain.submit(body.trim()));
    } catch (e) {
      if (e instanceof SimRejection) return text(`sendrawtransaction RPC error: ${JSON.stringify({ code: e.rpcCode, message: e.reason })}`, 400);
      throw e;
    }
  }
  if (method !== 'GET') return text('Method not allowed', 405);
  if (p === '/blocks/tip/height') return text(String(chain.height));
  if (p === '/blocks/tip/hash') return text(chain.blockHash(chain.height));
  if (p === '/fee-estimates') return json(chain.feeEstimates);
  if ((m = /^\/tx\/([0-9a-f]{64})$/.exec(p))) {
    const t = chain.getTx(m[1]!);
    return t ? json(t.json) : text('Transaction not found', 404);
  }
  if ((m = /^\/tx\/([0-9a-f]{64})\/hex$/.exec(p))) {
    const t = chain.getTx(m[1]!);
    return t ? text(t.hex) : text('Transaction not found', 404);
  }
  if ((m = /^\/tx\/([0-9a-f]{64})\/status$/.exec(p))) {
    const t = chain.getTx(m[1]!);
    return t ? json(t.status) : text('Transaction not found', 404);
  }
  if ((m = /^\/tx\/([0-9a-f]{64})\/outspend\/(\d+)$/.exec(p))) return json(chain.outspend(m[1]!, Number(m[2])));
  if ((m = /^\/address\/([^/]+)\/(utxo|txs)(?:\/chain\/([0-9a-f]{64}))?$/.exec(p))) {
    const script = chain.scriptOf(decodeURIComponent(m[1]!));
    if (!script) return text('Invalid Bitcoin address', 400);
    if (m[2] === 'utxo') return json(chain.scriptUtxos(script));
    const { mempool, confirmed } = chain.scriptTxs(script);
    if (!m[3]) return json([...mempool.slice(0, 50), ...confirmed.slice(0, 25)]);
    const at = confirmed.findIndex((t) => t.txid === m![3]);
    return json(at < 0 ? [] : confirmed.slice(at + 1, at + 26));
  }
  return text('Not found', 404);
}

/** A `fetch` that answers Esplora requests from `chain` in-process (base URL `sim://esplora`). */
export function simFetch(chain: SimChain, hooks: FakeEsploraHooks = {}): FetchLike {
  return async (url, init) => {
    const path = url.replace(/^[a-z]+:\/\/[^/]+/, '').replace(/^\/api/, '');
    const r = routeEsplora(chain, init?.method ?? 'GET', path, init?.body ?? '', hooks);
    return { ok: r.status >= 200 && r.status < 300, status: r.status, text: async () => r.body };
  };
}
