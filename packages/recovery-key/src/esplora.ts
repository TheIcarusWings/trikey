/**
 * Chain data without a home server: an Esplora REST client (the API of
 * Blockstream's electrs and of mempool.space), with `fetch` only, so it runs
 * in Node and in React Native (Hermes).
 *
 * Privacy: point it at your own server. Umbrel and Start9 both run one
 * (mempool, or electrs with its HTTP API). A public server learns every
 * address of the vault and the spending balance, so it can link them all, see
 * every balance and refill, and tie them to your IP address. It cannot move,
 * freeze or redirect a single coin.
 *
 * Trust: the server is trusted for confirmations, the tip height and which
 * coins exist. It is not trusted for amounts: every coin the wallet signs for
 * comes with its raw funding transaction, checked against the txid, and BIP
 * 143 signatures commit to the amounts. A lying server can hide coins or
 * stall refills (denial of service); it cannot make the wallet sign away more
 * than it shows.
 */
import { hex } from '@scure/base';
import type { MultisigWallet, NetworkName } from '@trikey/core';
import type { ChainSnapshot, ChainSource, FeeEstimates } from '@trikey/wallet';
import { RecoveryKeyError } from './errors.js';
import { decodeRawTx, txidOf } from './script-verify.js';
import type { FeeRates } from './fees.js';

/** Defaults per network. Change them: your own server is the private choice. Mainnet is listed for completeness only. */
export const DEFAULT_ESPLORA_URLS: Record<NetworkName, string> = {
  bitcoin: 'https://blockstream.info/api',
  testnet: 'https://mempool.space/testnet4/api',
  signet: 'https://mempool.space/signet/api',
  regtest: 'http://127.0.0.1:3002',
};

export const PUBLIC_SERVER_PRIVACY_NOTE =
  'A public server sees every address of your vault and spending balance and your IP address, so it can link them to you and watch your balance and refills, but it cannot move or freeze your coins.';

/** The subset of `fetch` this client uses (global `fetch` in Node 18+ and React Native). */
export type FetchLike = (
  url: string,
  init?: { method?: string; body?: string; headers?: Record<string, string>; signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

export interface EsploraStatus {
  confirmed: boolean;
  block_height?: number;
  block_hash?: string;
  block_time?: number;
}

export interface EsploraVin {
  txid: string;
  vout: number;
  sequence: number;
  is_coinbase?: boolean;
  prevout?: { scriptpubkey: string; value: number; scriptpubkey_address?: string } | null;
}

export interface EsploraTx {
  txid: string;
  version: number;
  locktime: number;
  vin: EsploraVin[];
  vout: { scriptpubkey: string; value: number; scriptpubkey_address?: string }[];
  status: EsploraStatus;
  fee?: number;
  weight?: number;
}

export interface EsploraUtxo {
  txid: string;
  vout: number;
  value: number;
  status: EsploraStatus;
}

export interface EsploraOutspend {
  spent: boolean;
  txid?: string;
  vin?: number;
  status?: EsploraStatus;
}

const TXID = /^[0-9a-f]{64}$/;

function chainError(message: string, detail?: Record<string, unknown>, cause?: unknown): RecoveryKeyError {
  return new RecoveryKeyError('chain_source', message, { detail, cause });
}

/** Bitcoin Core's reject reason out of an Esplora error body (`sendrawtransaction RPC error: {"code":-26,"message":"non-BIP68-final"}`). */
export function rejectReason(body: string): string {
  const m = /"message"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(body);
  return (m ? m[1]! : body).trim().slice(0, 300);
}

const ALREADY_KNOWN = /txn-already-in-mempool|txn-already-known|already in block chain|Transaction outputs already in utxo set/i;

export class EsploraClient {
  readonly baseUrl: string;
  private readonly fetchFn: FetchLike;
  private readonly timeoutMs: number;

  constructor(opts: { baseUrl: string; fetch?: FetchLike; timeoutMs?: number }) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    const f = opts.fetch ?? (globalThis.fetch as unknown as FetchLike | undefined);
    if (!f) throw new Error('no fetch available');
    this.fetchFn = f;
    this.timeoutMs = opts.timeoutMs ?? 20_000;
  }

  /** The default server for `network` (prefer your own: see `PUBLIC_SERVER_PRIVACY_NOTE`). */
  static forNetwork(network: NetworkName, opts: { baseUrl?: string; fetch?: FetchLike; timeoutMs?: number } = {}): EsploraClient {
    return new EsploraClient({ ...opts, baseUrl: opts.baseUrl ?? DEFAULT_ESPLORA_URLS[network] });
  }

  private async request(path: string, init?: { method?: string; body?: string }): Promise<{ status: number; body: string }> {
    const ctl = typeof AbortController !== 'undefined' ? new AbortController() : undefined;
    const timer = ctl ? setTimeout(() => ctl.abort(), this.timeoutMs) : undefined;
    try {
      const res = await this.fetchFn(`${this.baseUrl}${path}`, {
        method: init?.method ?? 'GET',
        ...(init?.body !== undefined ? { body: init.body, headers: { 'content-type': 'text/plain' } } : {}),
        ...(ctl ? { signal: ctl.signal } : {}),
      });
      return { status: res.status, body: await res.text() };
    } catch (e) {
      throw chainError(`The chain server did not answer (${path}).`, { path }, e);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private async get(path: string, opts: { notFound?: 'undefined' } = {}): Promise<string | undefined> {
    const r = await this.request(path);
    if (r.status === 404 && opts.notFound) return undefined;
    if (r.status < 200 || r.status >= 300) throw chainError(`The chain server answered ${r.status} for ${path}.`, { status: r.status, path, body: r.body.slice(0, 200) });
    return r.body;
  }

  private async getJson<T>(path: string, check: (v: unknown) => boolean, opts: { notFound?: 'undefined' } = {}): Promise<T | undefined> {
    const body = await this.get(path, opts);
    if (body === undefined) return undefined;
    let v: unknown;
    try {
      v = JSON.parse(body);
    } catch (e) {
      throw chainError(`The chain server sent something that is not JSON for ${path}.`, { path }, e);
    }
    if (!check(v)) throw chainError(`The chain server sent an unexpected answer for ${path}.`, { path });
    return v as T;
  }

  async tipHeight(): Promise<number> {
    const h = Number((await this.get('/blocks/tip/height'))!.trim());
    if (!Number.isInteger(h) || h < 0) throw chainError('The chain server sent a bad tip height.');
    return h;
  }

  async tipHash(): Promise<string> {
    const h = (await this.get('/blocks/tip/hash'))!.trim();
    if (!TXID.test(h)) throw chainError('The chain server sent a bad tip hash.');
    return h;
  }

  addressUtxos(address: string): Promise<EsploraUtxo[]> {
    return this.getJson<EsploraUtxo[]>(`/address/${encodeURIComponent(address)}/utxo`, (v) => Array.isArray(v) && v.every(isUtxo)) as Promise<EsploraUtxo[]>;
  }

  /** Every transaction touching `address`: the mempool ones, then confirmed newest first (following Esplora's pages). */
  async addressTxs(address: string, opts: { maxPages?: number } = {}): Promise<EsploraTx[]> {
    const base = `/address/${encodeURIComponent(address)}/txs`;
    const first = (await this.getJson<EsploraTx[]>(base, (v) => Array.isArray(v) && v.every(isTx)))!;
    const out = [...first];
    let confirmed = first.filter((t) => t.status.confirmed);
    // Esplora sends 25 confirmed transactions per page.
    for (let page = 1; confirmed.length >= 25 && page < (opts.maxPages ?? 40); page++) {
      const last = confirmed[confirmed.length - 1]!.txid;
      const next = (await this.getJson<EsploraTx[]>(`${base}/chain/${last}`, (v) => Array.isArray(v) && v.every(isTx)))!;
      out.push(...next);
      confirmed = next;
    }
    return out;
  }

  tx(txid: string): Promise<EsploraTx | undefined> {
    checkTxid(txid);
    return this.getJson<EsploraTx>(`/tx/${txid}`, isTx, { notFound: 'undefined' });
  }

  /** Raw transaction hex, checked to hash to `txid`. */
  async txHex(txid: string): Promise<string> {
    checkTxid(txid);
    const body = (await this.get(`/tx/${txid}/hex`))!.trim().toLowerCase();
    let got: string;
    try {
      got = txidOf(decodeRawTx(body));
    } catch (e) {
      throw chainError('The chain server sent a transaction that does not parse.', { txid }, e);
    }
    if (got !== txid) throw chainError(`The chain server sent a different transaction than ${txid}.`, { txid });
    return body;
  }

  txStatus(txid: string): Promise<EsploraStatus | undefined> {
    checkTxid(txid);
    return this.getJson<EsploraStatus>(`/tx/${txid}/status`, isStatus, { notFound: 'undefined' });
  }

  outspend(txid: string, vout: number): Promise<EsploraOutspend> {
    checkTxid(txid);
    return this.getJson<EsploraOutspend>(`/tx/${txid}/outspend/${vout}`, (v) => typeof v === 'object' && v !== null && typeof (v as EsploraOutspend).spent === 'boolean') as Promise<EsploraOutspend>;
  }

  /** sat/vB by confirmation target. */
  async feeEstimates(): Promise<FeeRates> {
    const v = (await this.getJson<Record<string, number>>('/fee-estimates', (x) => typeof x === 'object' && x !== null && !Array.isArray(x)))!;
    const out: FeeRates = {};
    for (const [k, r] of Object.entries(v)) if (/^\d+$/.test(k) && typeof r === 'number' && r > 0) out[Number(k)] = r;
    return out;
  }

  /**
   * Broadcasts a raw transaction; resolves with its txid. A transaction the
   * server already has counts as broadcast. A refusal is
   * `broadcast_rejected` with Bitcoin Core's reason (`non-BIP68-final`,
   * `bad-txns-inputs-missingorspent`, `insufficient fee`, ...).
   */
  async broadcast(txHex: string): Promise<string> {
    const own = txidOf(decodeRawTx(txHex));
    const r = await this.request('/tx', { method: 'POST', body: txHex });
    if (r.status >= 200 && r.status < 300) {
      const got = r.body.trim();
      if (got !== own) throw chainError(`The chain server reported txid ${got}, expected ${own}.`);
      return own;
    }
    const reason = rejectReason(r.body);
    if (ALREADY_KNOWN.test(reason)) return own;
    throw new RecoveryKeyError('broadcast_rejected', `The network refused the transaction: ${reason}`, { detail: { reason, status: r.status, txid: own } });
  }
}

function checkTxid(txid: string) {
  if (!TXID.test(txid)) throw new RecoveryKeyError('internal', `bad txid ${txid}`);
}
const isStatus = (v: unknown): boolean => typeof v === 'object' && v !== null && typeof (v as EsploraStatus).confirmed === 'boolean';
const isTx = (v: unknown): boolean => {
  const t = v as EsploraTx;
  return typeof t === 'object' && t !== null && typeof t.txid === 'string' && TXID.test(t.txid) && Array.isArray(t.vin) && Array.isArray(t.vout) && isStatus(t.status);
};
const isUtxo = (v: unknown): boolean => {
  const u = v as EsploraUtxo;
  return typeof u === 'object' && u !== null && TXID.test(u.txid) && Number.isInteger(u.vout) && Number.isSafeInteger(u.value) && isStatus(u.status);
};

// ---------------------------------------------------------------------------
// Scanning an account (gap limit)

export interface ScanAddress {
  chain: number;
  index: number;
  address: string;
  script: Uint8Array;
}

export interface ScannedCoin {
  txid: string;
  vout: number;
  value: bigint;
  chain: number;
  index: number;
  /** Funding height; 0 while unconfirmed. */
  height: number;
  /** The transaction spending it, if any (mempool or chain). */
  spentBy?: { txid: string; confirmed: boolean; height?: number };
}

export interface ScanResult {
  tip: number;
  /** Every transaction touching the account. */
  txs: Map<string, EsploraTx>;
  /** Every output the account ever received. */
  coins: ScannedCoin[];
  /** Coins not spent by anything (the balance). */
  unspent: ScannedCoin[];
  /** First unused index per chain. */
  nextIndex: Record<number, number>;
  gapLimit: number;
}

/**
 * Scans addresses chain by chain until `gapLimit` unused in a row (and at
 * least up to `minIndex` on each chain: indices the wallet reserved, such as
 * future refill outputs).
 */
export async function scanAccount(
  client: EsploraClient,
  derive: (chain: number, index: number) => ScanAddress,
  opts: { chains?: number[]; gapLimit?: number; minIndex?: Record<number, number>; concurrency?: number } = {},
): Promise<ScanResult> {
  const gap = opts.gapLimit ?? 20;
  const concurrency = opts.concurrency ?? 6;
  const tip = await client.tipHeight();
  const txs = new Map<string, EsploraTx>();
  const mine = new Map<string, ScanAddress>();
  const nextIndex: Record<number, number> = {};
  for (const chain of opts.chains ?? [0, 1]) {
    let lastUsed = -1;
    let index = 0;
    const floor = opts.minIndex?.[chain] ?? 0;
    while (index - lastUsed - 1 < gap || index < floor) {
      const batch = Array.from({ length: concurrency }, (_, i) => derive(chain, index + i));
      const found = await Promise.all(batch.map((a) => client.addressTxs(a.address)));
      batch.forEach((a, i) => {
        mine.set(hex.encode(a.script), a);
        if (found[i]!.length) {
          lastUsed = Math.max(lastUsed, a.index);
          for (const t of found[i]!) txs.set(t.txid, t);
        }
      });
      index += concurrency;
    }
    nextIndex[chain] = lastUsed + 1;
  }
  const spentBy = new Map<string, ScannedCoin['spentBy']>();
  for (const t of txs.values())
    for (const v of t.vin) if (!v.is_coinbase) spentBy.set(`${v.txid}:${v.vout}`, { txid: t.txid, confirmed: t.status.confirmed, height: t.status.block_height });
  const coins: ScannedCoin[] = [];
  for (const t of txs.values())
    t.vout.forEach((o, vout) => {
      const a = mine.get(o.scriptpubkey);
      if (!a) return;
      coins.push({
        txid: t.txid,
        vout,
        value: BigInt(o.value),
        chain: a.chain,
        index: a.index,
        height: t.status.confirmed ? t.status.block_height ?? 0 : 0,
        spentBy: spentBy.get(`${t.txid}:${vout}`),
      });
    });
  return { tip, txs, coins, unspent: coins.filter((c) => !c.spentBy), nextIndex, gapLimit: gap };
}

// ---------------------------------------------------------------------------
// The wallet package's ChainSource, over Esplora (so the two can converge)

/** `ChainSource` (from @trikey/wallet) for a 2-of-3 vault, over Esplora. */
export class EsploraChainSource implements ChainSource {
  readonly kind = 'esplora';

  constructor(
    readonly client: EsploraClient,
    private readonly wallet: MultisigWallet,
    private readonly opts: { gapLimit?: number; minIndex?: Record<number, number> } = {},
  ) {}

  async sync(opts: { historyLimit?: number } = {}): Promise<ChainSnapshot> {
    const scan = await scanAccount(this.client, (c, i) => ({ chain: c, index: i, ...pick(this.wallet.derive(c, i)) }), this.opts);
    const tipHash = await this.client.tipHash();
    const conf = (h: number) => (h > 0 ? scan.tip - h + 1 : 0);
    const utxos = scan.unspent.map((c) => ({
      txid: c.txid,
      vout: c.vout,
      valueSats: Number(c.value),
      height: c.height,
      confirmations: conf(c.height),
      chain: c.chain as 0 | 1,
      index: c.index,
    }));
    const confirmedSats = utxos.filter((u) => u.height > 0).reduce((s, u) => s + u.valueSats, 0);
    const unconfirmedSats = utxos.filter((u) => u.height === 0).reduce((s, u) => s + u.valueSats, 0);
    const ours = new Set(scan.coins.map((c) => `${c.txid}:${c.vout}`));
    const value = new Map(scan.coins.map((c) => [`${c.txid}:${c.vout}`, Number(c.value)]));
    const history = [...scan.txs.values()]
      .map((t) => {
        const received = scan.coins.filter((c) => c.txid === t.txid).reduce((s, c) => s + Number(c.value), 0);
        const spent = t.vin.reduce((s, v) => s + (value.get(`${v.txid}:${v.vout}`) ?? 0), 0);
        const allOurs = t.vin.every((v) => ours.has(`${v.txid}:${v.vout}`));
        const height = t.status.confirmed ? t.status.block_height ?? 0 : 0;
        return {
          txid: t.txid,
          height,
          confirmations: conf(height),
          ...(t.status.block_time ? { time: t.status.block_time } : {}),
          netSats: received - spent,
          ...(allOurs && typeof t.fee === 'number' ? { feeSats: t.fee } : {}),
        };
      })
      .sort((a, b) => (a.height === 0 ? -1 : b.height === 0 ? 1 : b.height - a.height));
    const limit = opts.historyLimit ?? 100;
    return {
      tipHeight: scan.tip,
      tipHash,
      utxos,
      utxosTruncated: false,
      balance: { confirmedSats, unconfirmedSats },
      history: history.slice(0, limit),
      historyTruncated: history.length > limit,
      nextReceiveIndex: scan.nextIndex[0] ?? 0,
      nextChangeIndex: scan.nextIndex[1] ?? 0,
      gapLimit: scan.gapLimit,
    };
  }

  getTransaction(txid: string): Promise<string> {
    return this.client.txHex(txid);
  }

  broadcast(txHex: string): Promise<string> {
    return this.client.broadcast(txHex);
  }

  async estimateFees(targets: number[] = [1, 3, 6, 144]): Promise<FeeEstimates> {
    const rates = await this.client.feeEstimates();
    const estimates = targets.map((target) => {
      const exact = rates[target];
      const slower = Object.keys(rates)
        .map(Number)
        .filter((t) => t >= target)
        .sort((a, b) => a - b)[0];
      const r = exact ?? (slower !== undefined ? rates[slower] : undefined);
      return { target, satPerVb: r ?? null };
    });
    return { estimates, minRelaySatPerVb: 1 };
  }
}

const pick = (d: { address: string; script: Uint8Array }) => ({ address: d.address, script: d.script });
