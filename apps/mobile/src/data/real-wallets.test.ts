/**
 * Several wallets in one app (docs/design/multi-wallet.md): the real wallet service against the real guardian in-process
 * (regtest, throwaway keys). One phone, two wallets each with its own (software) hardware wallet.
 *
 * - With one wallet nothing changes: the list holds it, "Add a wallet" is offered (the guardian lists `own_wallets`).
 * - "Add a wallet" with the first wallet's device is refused; with a new one it is added at account 2, not shown yet.
 * - The switcher shows the other wallet: it pays within its own limit, receives at its own address, names its device.
 * - The total of the daily limits; the wallet shown last opens again after a restart.
 * - One backup (version 4) brings both back on a new phone.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as btc from '@scure/btc-signer';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { NETWORKS } from '@trikey/core';
import { SimplePoolRelayPool } from '@trikey/protocol';
import { GuardianRig } from '@trikey/guardian/testing';
import { openBackup } from '@trikey/wallet';
import { MemoryCloudBackupStore, MemoryKeyValueStore, MemoryPasskeyPrf, MemorySecureKeyStore, SoftwareHardwareProvider, SoftwareHardwareSigner } from '@trikey/wallet/testing';
import { createRealWalletService, type RealWalletService } from './real';
import { WalletServiceError } from './errors';
import { fromLine, toLine, totalLimitText } from './wallets';

const ledger = new SoftwareHardwareSigner({ mnemonic: 'legal winner thank year wave sausage worth useful legal winner thank yellow', network: 'regtest', kind: 'ledger', model: 'Nano X (simulated)' });
const trezor = new SoftwareHardwareSigner({ mnemonic: 'zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo wrong', network: 'regtest', kind: 'trezor', model: 'Safe 3 (simulated)' });
const provider = new SoftwareHardwareProvider(ledger);
const passkey = new MemoryPasskeyPrf();
passkey.supported = false;
const cloud = new MemoryCloudBackupStore();
const externalAddress = (seed = 2) => btc.p2wpkh(secp256k1.getPublicKey(new Uint8Array(32).fill(seed), true), NETWORKS.regtest.btc).address!;

let rig: GuardianRig;
let svc: RealWalletService;
const kv = new MemoryKeyValueStore();
const secure = new MemorySecureKeyStore();
const services: RealWalletService[] = [];

async function failure(p: Promise<unknown>): Promise<WalletServiceError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof WalletServiceError) return e;
    throw e;
  }
  throw new Error('expected a WalletServiceError');
}

function service(opts: { kv?: MemoryKeyValueStore; secure?: MemorySecureKeyStore } = {}): Promise<RealWalletService> {
  return createRealWalletService({
    mode: 'simulator',
    platform: { os: 'ios', isSecure: true, secureKeys: opts.secure ?? new MemorySecureKeyStore(), kv: opts.kv ?? new MemoryKeyValueStore(), cloudBackups: [cloud], passkeys: passkey },
    hardware: () => [provider],
    clock: rig.clock,
    relayPool: () => new SimplePoolRelayPool(),
    rpcTimeoutMs: 5000,
    rpcRetryIntervalMs: 0,
    syncIntervalMs: 0,
    syncJoinMs: 0,
    yieldToUi: async () => {},
    recoveryCodeKdf: { m: 64, t: 1, p: 1 },
  }).then((s) => {
    services.push(s);
    return s;
  });
}

beforeAll(async () => {
  rig = await GuardianRig.start();
  svc = await service({ kv, secure });
  provider.device = ledger;
  await svc.connectHardware('simulated');
  await svc.pairGuardian(rig.pairingUri());
  await svc.setUpRules(100_000, 7);
  await svc.sync();
  await svc.idle();
}, 60_000);

afterAll(async () => {
  for (const s of services) await s.close().catch(() => undefined);
  await rig?.stop();
});

describe('several wallets in the app', { timeout: 90_000 }, () => {
  it('with one wallet: the list holds it, and "Add a wallet" is offered', () => {
    const v = svc.getState().wallets!;
    expect(v.list).toEqual([expect.objectContaining({ account: 0, name: 'Main', current: true, dailyLimitSats: 100_000 })]);
    expect(v.canAdd).toBe(true);
    expect(v.total).toBeUndefined();
    expect(fromLine(v)).toBeNull();
    expect(toLine(v)).toBeNull();
  });

  it('refuses the first wallet\'s device, and adds Business with a new one (not shown yet)', async () => {
    provider.device = ledger;
    expect((await failure(svc.addWallet!({ name: 'Business', hardware: 'simulated', dailyLimitSats: 50_000 }))).kind).toBe('hardware_in_use');
    provider.device = trezor;
    const added = await svc.addWallet!({ name: 'Business', hardware: 'simulated', dailyLimitSats: 50_000 });
    expect(added).toMatchObject({ account: 2, name: 'Business', current: false, dailyLimitSats: 50_000 });
    expect(added.device).toMatch(/Trezor/);
    const v = svc.getState().wallets!;
    expect(v.list.map((w) => w.name)).toEqual(['Main', 'Business']);
    expect(v.current.name).toBe('Main');
    expect(v.total).toEqual({ sats: 150_000, off: false });
    expect(totalLimitText(v.total)).toMatch(/150,000 sats a day/);
    expect(svc.getState().activity.some((i) => i.type === 'security' && i.event.kind === 'wallet-added')).toBe(true);
  });

  it('switches to Business: it receives at its own address, pays within its own limit, and names itself', async () => {
    const mainAddress = svc.getState().receiveAddress;
    await svc.switchWallet!(2);
    expect(svc.wallet!.account).toBe(2);
    const st = svc.getState();
    expect(st.wallets!.current.name).toBe('Business');
    expect(fromLine(st.wallets)).toBe('From: Business');
    expect(toLine(st.wallets)).toBe('To: Business');
    // The device it needs: Business's own (the simulator calls every device "simulated").
    expect(st.wallets!.current.device).toMatch(/Trezor/);
    expect(svc.wallet!.state.hardware!.fingerprint).toBe(trezor.info.fingerprint);
    const addr = (await svc.receiveAddress()).address;
    expect(addr).not.toBe(mainAddress);
    rig.fund(svc.wallet!.multisig().derive(0, 0).script, 200_000n);
    await svc.sync();
    await svc.idle();
    expect(svc.getState().balanceSats).toBe(200_000);
    expect(svc.getState().dailyLimit.limitSats).toBe(50_000);
    const q = svc.quoteSend({ address: externalAddress(), amountSats: 20_000, speed: 'normal' });
    if (!q.ok) throw new Error(q.message);
    expect(q.quote.plan.signer).toBe('phone+guardian');
    const tx = await svc.sendPayment(q.quote);
    expect(tx).toMatchObject({ amountSats: 20_000 });
  });

  it('opens on the wallet shown last after a restart, and switches back', async () => {
    const again = await service({ kv, secure });
    expect(again.getState().wallets!.current.name).toBe('Business');
    expect(again.wallet!.account).toBe(2);
    await again.close();
    await svc.switchWallet!(0);
    expect(svc.getState().wallets!.current.name).toBe('Main');
    expect(svc.wallet!.account).toBe(0);
  });

  it('one backup holds both wallets, and a new phone gets both back', async () => {
    const backup = await svc.createBackup('file');
    const code = svc.recoveryCode()!;
    const name = [...cloud.files.keys()].find((k) => k.startsWith('trikey-backup-'))!;
    const { payload } = await openBackup(cloud.files.get(name)!, { recoveryCode: code });
    expect(payload.v).toBe(4);
    expect(payload.wallets?.map((w) => w.name)).toEqual(['Business']);
    expect(backup.unlockedBy).toContain('recovery-code');
    const P = await service();
    await P.restoreFromBackup({ recoveryCode: code });
    const v = P.getState().wallets!;
    expect(v.list.map((w) => [w.account, w.name])).toEqual([
      [0, 'Main'],
      [2, 'Business'],
    ]);
  });
});

describe('wallet names', () => {
  it('1 to 16 characters, not one the phone uses already', async () => {
    const { walletNameProblem } = await import('./wallets');
    const view = { list: [{ account: 0, name: 'Main', device: 'Ledger', current: true, balanceSats: 0, dailyLimitSats: 1 }], current: { account: 0, name: 'Main', device: 'Ledger', current: true, balanceSats: 0, dailyLimitSats: 1 }, canAdd: true, guardianUpdateNeeded: false };
    expect(walletNameProblem('', view)).toMatch(/name/);
    expect(walletNameProblem('x'.repeat(17), view)).toMatch(/16/);
    expect(walletNameProblem('main', view)).toMatch(/already/);
    expect(walletNameProblem('Business', view)).toBeUndefined();
  });
});
