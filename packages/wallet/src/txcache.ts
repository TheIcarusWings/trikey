/**
 * The previous transactions of the wallet's coins (raw hex without witness data), kept on the phone next to the
 * wallet's state but under their own key, so the main document stays small.
 *
 * A payment needs each input's previous transaction (`nonWitnessUtxo`, which hardware wallets and the guardian
 * require). Keeping them means a payment needs fewer round trips to the guardian, and that the phone can still sign
 * a sweep of its coins when no guardian answers any more ("Replace guardian" with the old box gone). Every entry is
 * checked against its txid when it is used, so a damaged cache can only fail, never mislead.
 */
import type { KeyValueStore } from './platform.js';
import { txidOfRaw } from './chain.js';

const MAX_ENTRIES = 600;

export class TxCache {
  private map?: Map<string, string>;
  private saving: Promise<void> = Promise.resolve();

  constructor(
    private readonly kv: KeyValueStore,
    readonly key: string,
  ) {}

  private async load(): Promise<Map<string, string>> {
    if (this.map) return this.map;
    let entries: [string, string][] = [];
    try {
      const raw = await this.kv.get(this.key);
      const j = raw ? (JSON.parse(raw) as unknown) : undefined;
      if (j && typeof j === 'object') entries = Object.entries(j as Record<string, unknown>).filter((e): e is [string, string] => typeof e[1] === 'string');
    } catch {
      /* a cache: start empty */
    }
    this.map ??= new Map(entries);
    return this.map;
  }

  private persist(): Promise<void> {
    const run = this.saving.then(async () => {
      const m = await this.load();
      await this.kv.set(this.key, JSON.stringify(Object.fromEntries(m))).catch(() => undefined);
    });
    this.saving = run.catch(() => undefined);
    return run;
  }

  /** The cached transaction, if it is there and hashes to `txid`. */
  async get(txid: string): Promise<string | undefined> {
    const hex = (await this.load()).get(txid);
    if (!hex) return undefined;
    try {
      if (txidOfRaw(hex) === txid) return hex;
    } catch {
      /* damaged */
    }
    (await this.load()).delete(txid);
    return undefined;
  }

  async has(txid: string): Promise<boolean> {
    return (await this.load()).has(txid);
  }

  async put(entries: { txid: string; txHex: string }[]): Promise<void> {
    if (!entries.length) return;
    const m = await this.load();
    for (const e of entries) m.set(e.txid, e.txHex);
    while (m.size > MAX_ENTRIES) m.delete(m.keys().next().value!);
    await this.persist();
  }

  /** Drops what no coin needs any more. */
  async keepOnly(txids: Set<string>): Promise<void> {
    const m = await this.load();
    let changed = false;
    for (const k of [...m.keys()])
      if (!txids.has(k)) {
        m.delete(k);
        changed = true;
      }
    if (changed) await this.persist();
  }

  async clear(): Promise<void> {
    this.map = new Map();
    await this.saving;
    await this.kv.remove(this.key).catch(() => undefined);
  }
}
