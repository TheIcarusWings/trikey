/**
 * Shared set-up for the Recovery Key service tests: a simulated chain (`@trikey/recovery-key/testing`: BIP 68,
 * signatures, replacement rules), the package's software hardware wallets, in-memory stores, regtest, throwaway keys.
 */
import * as btc from '@scure/btc-signer';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { afterAll } from 'vitest';
import { NETWORKS } from '@trikey/core';
import { SimChain, simFetch } from '@trikey/recovery-key/testing';
import { MemoryKeyValueStore, MemorySecureKeyStore, SoftwareHardwareProvider, SoftwareHardwareSigner } from '@trikey/wallet/testing';
import { WalletServiceError } from './errors';
import { createRkWalletService, type RkWalletService } from './rk-service';
import type { DevicePrompt, KitProof, RecoveryKit } from './types';

export const HARDWARE = 'legal winner thank year wave sausage worth useful legal winner thank yellow';
export const HARDWARE_2 = 'zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo wrong';
export const HARDWARE_3 = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
export const PERIOD = 1008;
export const externalAddress = (seed = 2) => btc.p2wpkh(secp256k1.getPublicKey(new Uint8Array(32).fill(seed), true), NETWORKS.regtest.btc).address!;

export async function failure(p: Promise<unknown>): Promise<WalletServiceError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof WalletServiceError) return e;
    throw e;
  }
  throw new Error('expected a WalletServiceError');
}

export const wordsProof = (kit: RecoveryKit): KitProof => ({ words: Object.fromEntries(kit.challenge.map((p) => [p, kit.recoveryWords[p - 1]!])) });

const opened: RkWalletService[] = [];

/** Call once at the top of a test file: closes every service the file opened. */
export function closeServicesAfterAll(): void {
  afterAll(async () => {
    for (const s of opened) await s.close();
  });
}

/** A simulated chain, a hardware wallet (and a second one), and phones that can be opened on them. */
export function world() {
  const chain = new SimChain({ height: 200 });
  const fetch = simFetch(chain);
  const device = new SoftwareHardwareSigner({ mnemonic: HARDWARE, network: 'regtest', kind: 'ledger', model: 'Nano X (simulated)' });
  const second = new SoftwareHardwareSigner({ mnemonic: HARDWARE_2, network: 'regtest', kind: 'coldcard', model: 'Second device' });
  class Provider extends SoftwareHardwareProvider {
    async connect(opts?: { kind?: string }) {
      return opts?.kind === 'coldcard' ? second : super.connect();
    }
  }
  const provider = new Provider(device);
  async function phone(opts: { secure?: MemorySecureKeyStore; kv?: MemoryKeyValueStore; mode?: 'simulator' | 'real'; server?: string } = {}) {
    const secure = opts.secure ?? new MemorySecureKeyStore();
    const kv = opts.kv ?? new MemoryKeyValueStore();
    const prompts: DevicePrompt[] = [];
    const svc = await createRkWalletService({
      mode: opts.mode ?? 'simulator',
      platform: { os: 'ios', isSecure: true, secureKeys: secure, kv },
      hardware: () => [provider],
      network: 'regtest',
      fetch,
      defaultServer: () => opts.server ?? 'sim://esplora',
      secondDeviceKind: 'coldcard',
      syncIntervalMs: 0,
      yieldToUi: async () => {},
    });
    svc.prompts.subscribe(() => {
      const p = svc.prompts.getSnapshot();
      if (p) prompts.push(p);
    });
    opened.push(svc);
    return { svc, secure, kv, prompts };
  }
  /** Pays `sats` to `address` and confirms it. */
  const fund = (address: string, sats: bigint) => {
    chain.fund(address, sats);
    chain.mine(1);
  };
  return { chain, fetch, device, second, provider, phone, fund };
}
export type World = ReturnType<typeof world>;
export type Phone = Awaited<ReturnType<World['phone']>>;

/** RK-Create: key 1, the paper kit, the proof; then a vault with `sats`. Optionally RK-Refills too. */
export async function setUp(w: World, sats = 5_000_000n, opts: { approve?: boolean; phone?: Phone } = {}) {
  const p = opts.phone ?? (await w.phone());
  await p.svc.connectHardware('simulated');
  p.svc.setRecoveryKeyKind('paper');
  const kit = await p.svc.rk!.makeKit();
  const { fingerprint } = await p.svc.rk!.confirmKit(wordsProof(kit));
  w.fund(p.svc.rk!.vaultAddress(), sats);
  await p.svc.sync();
  if (opts.approve !== false) {
    await p.svc.rk!.approveRefills();
    // Approving sends refill 1 at once (the scheduler runs in the background): wait for that, so what follows is deterministic.
    await p.svc.sync();
  }
  return { p, kit, fingerprint };
}

/** The kit as a person types it back: the 12 words, then the wallet map. */
export const typed = (kit: RecoveryKit) => [...kit.recoveryWords, ...kit.mapWords].join(' ');
