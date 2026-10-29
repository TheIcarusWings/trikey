/**
 * Test fixtures for the wallet. Every key is a throwaway: the hardware wallets
 * use published BIP 39 test mnemonics, phones generate fresh keys. Regtest only.
 */
import * as btc from '@scure/btc-signer';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { NETWORKS } from '@trikey/core';
import { SimplePoolRelayPool, type Filter, type NostrEvent, type PublishOutcome, type RelayPool, type SubscriptionHandlers } from '@trikey/protocol';
import type { WalletDeps } from '../src/index.js';
import { MemoryCloudBackupStore, MemoryKeyValueStore, MemoryPasskeyPrf, MemorySecureKeyStore } from '../src/testing/index.js';
import type { ManualClock } from '@trikey/guardian/testing';

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
    },
  };
}
