/**
 * Fixtures shared by the end-to-end tests. Every key is a throwaway: published BIP 39 test mnemonics for the hardware
 * wallets, fresh random seeds for phones. Regtest only.
 */
import { afterEach } from 'vitest';
import * as btc from '@scure/btc-signer';
import { generateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { NETWORKS } from '@trikey/core';
import { RpcClient, RpcError, RpcTimeoutError, SimplePoolRelayPool, identityFromMnemonic, type Policy } from '@trikey/protocol';
import { TrikeyWallet, WalletError, type WalletDeps, type WalletSnapshot } from '@trikey/wallet';
import { MemoryCloudBackupStore, MemoryKeyValueStore, MemoryPasskeyPrf, MemorySecureKeyStore, SoftwareHardwareProvider, SoftwareHardwareSigner } from '@trikey/wallet/testing';
import type { E2eRig } from './rig.js';
import { waitFor } from './wait.js';

export const network = NETWORKS.regtest;

/** Published BIP 39 test vectors (never for real funds). */
export const HARDWARE_MNEMONICS = {
  one: 'legal winner thank year wave sausage worth useful legal winner thank yellow',
  two: 'zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo wrong',
};

/** A fresh 24-word seed. The chain is shared between test files, so nothing derived from a fixed seed may be reused. */
export const newMnemonic = () => generateMnemonic(wordlist, 256);

export const RULES: Policy = { dailyLimitSats: 100_000, recoveryDelayDays: 7, alertContacts: [], sweepFeeCapSats: 20_000 };

export const softwareDevice = (mnemonic = HARDWARE_MNEMONICS.one, kind: 'ledger' | 'trezor' = 'ledger') =>
  new SoftwareHardwareSigner({ mnemonic, network: 'regtest', kind, model: `${kind} (simulated)` });

export interface Phone {
  deps: WalletDeps;
  secure: MemorySecureKeyStore;
  kv: MemoryKeyValueStore;
  provider: SoftwareHardwareProvider;
}

/** One phone's platform: secure store, app storage, a hardware wallet in software; the guardian's clock. */
export function newPhone(rig: E2eRig, device: SoftwareHardwareSigner, extra: Partial<WalletDeps> = {}): Phone {
  const secure = new MemorySecureKeyStore();
  const kv = new MemoryKeyValueStore();
  const provider = new SoftwareHardwareProvider(device);
  return {
    secure,
    kv,
    provider,
    deps: {
      network: 'regtest',
      secureStore: secure,
      store: kv,
      relayPool: () => new SimplePoolRelayPool(),
      hardware: provider,
      cloud: new MemoryCloudBackupStore(),
      passkey: new MemoryPasskeyPrf(),
      clock: rig.clock,
      // Real Electrs and a real node answer in milliseconds to seconds, not microseconds.
      rpcTimeoutMs: rig.kind === 'regtest' ? 30_000 : 8_000,
      rpcRetryIntervalMs: 0,
      recoveryCodeKdf: { m: 64, t: 1, p: 1 }, // cheap Argon2 for tests only
      ...extra,
    },
  };
}

/** A p2wpkh address of a fixed throwaway key: somebody else's wallet. */
export const externalAddress = (seed = 2) => btc.p2wpkh(secp256k1.getPublicKey(new Uint8Array(32).fill(seed), true), network.btc).address!;

/**
 * Syncs the wallet until `pred` holds. Electrs sees a new transaction or block a moment after the node, so a sync right
 * after a broadcast or a mine may still show the old state.
 */
export async function syncUntil(w: TrikeyWallet, pred: (s: WalletSnapshot) => boolean, what: string, timeoutMs = 30_000): Promise<WalletSnapshot> {
  let last: WalletSnapshot | undefined;
  return waitFor(
    async () => {
      last = await w.sync();
      return pred(last) ? last : undefined;
    },
    `${what} (balance ${last ? JSON.stringify(last.balance) : 'unknown'})`,
    { timeoutMs, intervalMs: 300 },
  );
}

export async function walletError(p: Promise<unknown>): Promise<WalletError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof WalletError) return e;
    throw e;
  }
  throw new Error('expected a WalletError');
}

export async function rpcError(p: Promise<unknown>): Promise<RpcError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof RpcError || e instanceof RpcTimeoutError) return e as RpcError;
    throw e;
  }
  throw new Error('expected an RpcError');
}

/** The guardian's recent log, for a failure message. */
export const logTail = (rig: E2eRig, n = 40) => rig.logLines.slice(-n).join('\n');

/** Call inside a suite: when a test fails, print the end of the guardian's log (the node's and Electrs' logs come from the workflow). */
export function logGuardianOnFailure(rig: () => E2eRig | undefined, lines = 60): void {
  afterEach((ctx) => {
    const r = rig();
    if (r && ctx.task.result?.state === 'fail') console.error(`\n--- guardian log, last ${lines} lines, after "${ctx.task.name}" ---\n${logTail(r, lines)}\n---`);
  });
}

/**
 * The phone's own RPC channel to the guardian (the same nostr identity as a wallet created from `mnemonic`), for calling
 * methods the wallet does not expose or needs to see the raw error of. Close it when done.
 */
export function phoneRpc(rig: E2eRig, mnemonic: string, timeoutMs = rig.kind === 'regtest' ? 30_000 : 8_000): { rpc: RpcClient; close(): void } {
  const pool = new SimplePoolRelayPool();
  const rpc = new RpcClient({
    pool,
    relays: rig.relayUrls,
    secretKey: identityFromMnemonic(mnemonic).secretKey,
    peer: rig.pubkey,
    now: () => rig.nowSec(),
    defaultTimeoutMs: timeoutMs,
  });
  return {
    rpc,
    close: () => {
      rpc.close();
      pool.close();
    },
  };
}
