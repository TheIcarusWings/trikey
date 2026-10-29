/**
 * Test fixtures for the wallet. Every key is a throwaway: the hardware wallets
 * use published BIP 39 test mnemonics, phones generate fresh keys. Regtest only.
 */
import * as btc from '@scure/btc-signer';
import { hex } from '@scure/base';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { MultisigWallet, NETWORKS } from '@trikey/core';
import { SimplePoolRelayPool, type Filter, type NostrEvent, type PublishOutcome, type RelayPool, type SubscriptionHandlers } from '@trikey/protocol';
import type { ChainSnapshot, ChainSource, FeeEstimates, WalletDeps } from '../src/index.js';
import { MemoryCloudBackupStore, MemoryKeyValueStore, MemoryPasskeyPrf, MemorySecureKeyStore } from '../src/testing/index.js';
import type { FakeElectrum, ManualClock } from '@trikey/guardian/testing';

export const network = NETWORKS.regtest;

/** Published BIP 39 test vectors. */
export const MNEMONICS = {
  hardware: 'legal winner thank year wave sausage worth useful legal winner thank yellow',
  hardware2: 'zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo wrong',
};

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function waitFor<T>(fn: () => T | undefined | false | Promise<T | undefined | false>, what: string, timeoutMs = 8000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await sleep(20);
  }
}

/** A p2wpkh address of a fixed throwaway key: somebody else's wallet. */
export const externalAddress = (seed = 2) => btc.p2wpkh(secp256k1.getPublicKey(new Uint8Array(32).fill(seed), true), network.btc).address!;

/** A relay pool whose incoming events can be dropped (a phone that lost its connection, or crashed before reading the answer). */
export class FlakyPool implements RelayPool {
  readonly inner = new SimplePoolRelayPool();
  dropIncoming = false;
  /** Drop incoming events while this says so. */
  dropWhen?: () => boolean;

  publish(relays: string[], event: NostrEvent): Promise<PublishOutcome[]> {
    return this.inner.publish(relays, event);
  }

  subscribe(relays: string[], filter: Filter, handlers: SubscriptionHandlers) {
    return this.inner.subscribe(relays, filter, {
      ...handlers,
      onevent: (e, relay) => {
        if (!this.dropIncoming && !this.dropWhen?.()) handlers.onevent(e, relay);
      },
    });
  }

  close(): void {
    this.inner.close();
  }
}

/** One phone: its own secure store and app storage; the cloud and the passkey are the user's (shared between phones). */
export interface Phone {
  deps: WalletDeps;
  secure: MemorySecureKeyStore;
  kv: MemoryKeyValueStore;
  pools: RelayPool[];
}

export function phone(opts: {
  clock: ManualClock;
  hardware: WalletDeps['hardware'];
  cloud: MemoryCloudBackupStore;
  passkey: MemoryPasskeyPrf;
  pool?: () => RelayPool;
  rpcTimeoutMs?: number;
  standaloneChain?: WalletDeps['standaloneChain'];
}): Phone {
  const secure = new MemorySecureKeyStore();
  const kv = new MemoryKeyValueStore();
  const pools: RelayPool[] = [];
  return {
    secure,
    kv,
    pools,
    deps: {
      network: 'regtest',
      secureStore: secure,
      store: kv,
      relayPool: () => {
        const p = opts.pool ? opts.pool() : new SimplePoolRelayPool();
        pools.push(p);
        return p;
      },
      hardware: opts.hardware,
      cloud: opts.cloud,
      passkey: opts.passkey,
      clock: opts.clock,
      rpcTimeoutMs: opts.rpcTimeoutMs ?? 5000,
      rpcRetryIntervalMs: 0, // relays here never drop; retries would only add traffic
      recoveryCodeKdf: { m: 64, t: 1, p: 1 }, // cheap Argon2 for tests only
      ...(opts.standaloneChain ? { standaloneChain: opts.standaloneChain } : {}),
    },
  };
}

/**
 * "The user's own node" for a wallet no guardian serves (`WalletDeps.standaloneChain`), read straight from the rig's
 * fake Electrs: unspent outputs by script with a gap limit, raw transactions, and broadcasts into its mempool.
 */
export class FakeNodeChain implements ChainSource {
  readonly kind = 'test-node';
  readonly broadcasts: string[] = [];

  constructor(
    private readonly electrs: FakeElectrum,
    private readonly wallet: MultisigWallet,
  ) {}

  static for(electrs: FakeElectrum, seen?: FakeNodeChain[]): NonNullable<WalletDeps['standaloneChain']> {
    return (w) => {
      const c = new FakeNodeChain(electrs, MultisigWallet.fromDescriptor(w.descriptor, NETWORKS[w.network]));
      seen?.push(c);
      return c;
    };
  }

  private static scriptHash(script: Uint8Array): string {
    return hex.encode(sha256(script).reverse());
  }

  async sync(): Promise<ChainSnapshot> {
    const tip = this.electrs.height;
    const utxos: ChainSnapshot['utxos'] = [];
    const next: number[] = [];
    for (const chain of [0, 1] as const) {
      let gap = 0;
      let first = -1;
      for (let index = 0; gap < 20; index++) {
        const sh = FakeNodeChain.scriptHash(this.wallet.derive(chain, index).script);
        if (!(this.electrs.history.get(sh) ?? []).length) {
          gap++;
          if (first < 0) first = index;
          continue;
        }
        gap = 0;
        first = -1;
        for (const u of this.electrs.unspent.get(sh) ?? [])
          utxos.push({ txid: u.txid, vout: u.vout, valueSats: u.value, height: Math.max(0, u.height), confirmations: u.height > 0 ? tip - u.height + 1 : 0, chain, index });
      }
      next.push(first);
    }
    const confirmed = utxos.filter((u) => u.confirmations > 0).reduce((a, u) => a + u.valueSats, 0);
    const total = utxos.reduce((a, u) => a + u.valueSats, 0);
    return {
      tipHeight: tip,
      tipHash: '00'.repeat(32),
      utxos,
      utxosTruncated: false,
      balance: { confirmedSats: confirmed, unconfirmedSats: total - confirmed },
      history: [],
      historyTruncated: false,
      nextReceiveIndex: next[0]!,
      nextChangeIndex: next[1]!,
      gapLimit: 20,
    };
  }

  async getTransaction(txid: string): Promise<string> {
    const raw = this.electrs.txs.get(txid);
    if (!raw) throw new Error(`unknown transaction ${txid}`);
    const tx = btc.RawTx.decode(hex.decode(raw));
    return hex.encode(btc.RawTx.encode({ ...tx, segwitFlag: false, witnesses: undefined }));
  }

  async broadcast(txHex: string): Promise<string> {
    const err = this.electrs.applyTransaction(txHex);
    if (err) throw new Error(`the node refused it: ${err}`);
    this.electrs.broadcasts.push(txHex);
    this.broadcasts.push(txHex);
    return btc.Transaction.fromRaw(hex.decode(txHex), { allowUnknownOutputs: true }).id;
  }

  async estimateFees(): Promise<FeeEstimates> {
    return {
      estimates: [
        { target: 3, satPerVb: 3 },
        { target: 6, satPerVb: 2 },
      ],
      minRelaySatPerVb: 1,
    };
  }
}
