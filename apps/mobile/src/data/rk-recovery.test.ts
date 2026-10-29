/**
 * Recovery Key mode, second half, against the simulated chain (see ./rk-test-support.ts): recovery with the kit, a lost
 * kit, the chain server and the scheduler without the app (the background task).
 */
import { describe, expect, it } from 'vitest';
import { SoftwareHardwareSigner, MemoryKeyValueStore, MemorySecureKeyStore } from '@trikey/wallet/testing';
import { runRkSchedulerOnce } from './rk-background-run';
import { createRkWalletService } from './rk-service';
import { HARDWARE_3, closeServicesAfterAll, externalAddress, failure, setUp, typed, wordsProof, world } from './rk-test-support';
import type { RecoveryKit } from './types';

closeServicesAfterAll();

describe('recovery (RK-Recover)', () => {
  it('kit + hardware wallet on a new phone: reads the kit, then moves everything to a new vault with a new kit', async () => {
    const w = world();
    const { p, kit } = await setUp(w);
    await p.svc.sync();
    w.chain.mine(1);
    await p.svc.sync();

    const B = await w.phone(); // the new phone: nothing on it
    expect(await failure(B.svc.rk!.readKit('not a kit'))).toMatchObject({ kind: 'kit_invalid' });
    const info = await B.svc.rk!.readKit(typed(kit));
    expect(info).toMatchObject({ fingerprint: kit.fingerprint, kind: 'seed', network: 'regtest', matchesThisPhone: false });
    expect(info.vaultSats).toBeGreaterThan(4_000_000);

    const newKits: RecoveryKit[] = [];
    // A new vault shows its kit first, and nothing moves until the proof comes back.
    expect(
      await failure(
        B.svc.rk!.recoverWithKit({
          kit: typed(kit),
          with: 'hardware',
          destination: { newVault: true },
          confirmNewKit: async (k) => (newKits.push(k), false),
        }),
      ),
    ).toMatchObject({ kind: 'kit_invalid' });
    expect(w.chain.mempool()).toHaveLength(0);
    expect(B.svc.getState().onboarded).toBe(false);

    const res = await B.svc.rk!.recoverWithKit({
      kit: typed(kit),
      with: 'hardware',
      destination: { newVault: true },
      confirmNewKit: async (k) => (newKits.push(k), wordsProof(k)),
    });
    expect(res).toMatchObject({ newVault: true, txid: expect.stringMatching(/^[0-9a-f]{64}$/) });
    expect(res.movedSats + res.feeSats).toBe(info.vaultSats);
    w.chain.mine(1);
    await B.svc.sync();
    const last = newKits[newKits.length - 1]!;
    expect(B.svc.getState()).toMatchObject({ onboarded: true, recoveryKey: { stage: 'ready', vaultSats: res.movedSats, fingerprint: last.fingerprint } });
    expect(last.fingerprint).not.toBe(kit.fingerprint);
    // The old kit now finds nothing, and the new vault takes refills.
    expect((await B.svc.rk!.readKit(typed(kit))).vaultSats).toBe(0);
    expect((await B.svc.rk!.approveRefills({ count: 2 })).to).toBe(2);
    // The old phone sees its vault emptied by a transaction it did not make.
    await p.svc.sync();
    expect(p.svc.getState().recoveryKey.notices.map((n) => n.kind)).toContain('foreign_vault_spend');
    expect(p.svc.getState().recoveryKey).toMatchObject({ refillsStatus: 'invalidated', invalidatedBy: { byThisPhone: false }, needsApproval: true });
  }, 120_000);

  it('kit + hardware wallet to an address: no new wallet, the phone stays empty', async () => {
    const w = world();
    const { kit } = await setUp(w, 2_000_000n, { approve: false });
    const B = await w.phone();
    const res = await B.svc.rk!.recoverWithKit({ kit: kit.qrText, with: 'hardware', destination: { address: externalAddress(7) } });
    expect(res).toMatchObject({ newVault: false });
    expect(w.chain.inMempool(res.txid)).toBe(true);
    expect(res.movedSats + res.feeSats).toBe(2_000_000);
    expect(B.svc.getState().onboarded).toBe(false);
    expect(await failure(B.svc.rk!.recoverWithKit({ kit: kit.qrText, with: 'hardware', destination: { address: 'nonsense' } }))).toMatchObject({ kind: 'invalid_input' });
  }, 90_000);

  it('a kit for another network is refused with the network it is for', async () => {
    const w = world();
    const { kit } = await setUp(w, 1_000_000n, { approve: false });
    const other = await w.phone({ mode: 'real' });
    other.svc.setNetwork('signet');
    expect(await failure(other.svc.rk!.readKit(kit.qrText))).toMatchObject({ kind: 'network_mismatch', network: 'regtest' });
  }, 60_000);

  it('kit + this phone when the hardware wallet is gone: a new hardware wallet, a new vault, a new kit', async () => {
    const w = world();
    const { p, kit } = await setUp(w);
    const lost = w.device.info.fingerprint;
    const info = await p.svc.rk!.readKit(typed(kit));
    expect(info.matchesThisPhone).toBe(true);
    // The old device is lost: the next one the phone connects is a new one.
    w.provider.device = new SoftwareHardwareSigner({ mnemonic: HARDWARE_3, network: 'regtest', kind: 'ledger', model: 'New one' });
    const newKits: RecoveryKit[] = [];
    const res = await p.svc.rk!.recoverWithKit({ kit: typed(kit), with: 'phone', destination: { newVault: true }, confirmNewKit: async (k) => (newKits.push(k), wordsProof(k)) });
    expect(res.newVault).toBe(true);
    w.chain.mine(1);
    await p.svc.sync();
    expect(p.svc.getState().recoveryKey).toMatchObject({ fingerprint: newKits[0]!.fingerprint, vaultSats: res.movedSats, refillsStatus: 'none', needsApproval: true });
    expect(w.provider.device.info.fingerprint).not.toBe(lost);
  }, 120_000);

  it('a lost kit: the phone and the hardware wallet move everything to a new vault with a new kit', async () => {
    const w = world();
    const { p, kit } = await setUp(w);
    await p.svc.sync();
    w.chain.mine(1);
    await p.svc.sync();
    const newKits: RecoveryKit[] = [];
    expect(await failure(p.svc.rk!.replaceKit({ confirmNewKit: async (k) => (newKits.push(k), false) }))).toMatchObject({ kind: 'kit_invalid' });
    expect(w.chain.mempool()).toHaveLength(0);
    const res = await p.svc.rk!.replaceKit({ confirmNewKit: async (k) => (newKits.push(k), wordsProof(k)) });
    expect(res.newVault).toBe(true);
    w.chain.mine(1);
    await p.svc.sync();
    const rk = p.svc.getState().recoveryKey;
    expect(rk.fingerprint).toBe(newKits[newKits.length - 1]!.fingerprint);
    expect(rk.fingerprint).not.toBe(kit.fingerprint);
    expect(rk).toMatchObject({ refillsStatus: 'none', needsApproval: true, vaultSats: res.movedSats });
    // The old kit is worth nothing now.
    expect((await p.svc.rk!.readKit(typed(kit))).vaultSats).toBe(0);
  }, 120_000);
});

describe('the chain server (Settings)', () => {
  it('tries a server before using it, and falls back to the default', async () => {
    const w = world();
    const { svc } = await w.phone();
    expect(svc.getState().recoveryKey.server).toEqual({ url: 'sim://esplora', isDefault: true });
    expect(await svc.rk!.testServer('http://127.0.0.1:3003')).toMatchObject({ ok: true, height: 200, message: expect.stringMatching(/block 200/) });
    expect(await svc.rk!.testServer('ftp://nope')).toMatchObject({ ok: false });
    expect(await svc.rk!.testServer('http://example.com/api')).toMatchObject({ ok: false, message: expect.stringMatching(/https/) });
    expect(await svc.rk!.testServer('')).toMatchObject({ ok: false });
    await svc.rk!.setServer('http://192.168.1.5:3002/');
    expect(svc.getState().recoveryKey.server).toEqual({ url: 'http://192.168.1.5:3002', isDefault: false });
    expect(await failure(svc.rk!.setServer('http://example.com'))).toMatchObject({ kind: 'invalid_input' });
    await svc.rk!.setServer(null);
    expect(svc.getState().recoveryKey.server.isDefault).toBe(true);
  });

  it('keeps the chosen server across a restart and reopens a running wallet on it', async () => {
    const w = world();
    const { p } = await setUp(w, 2_000_000n, { approve: false });
    await p.svc.rk!.setServer('http://192.168.1.5:3002');
    expect(p.svc.getState().onboarded).toBe(true);
    await p.svc.sync();
    expect(p.svc.getState().recoveryKey.vaultSats).toBe(2_000_000);
    const again = await w.phone({ secure: p.secure, kv: p.kv });
    expect(again.svc.getState().recoveryKey.server).toEqual({ url: 'http://192.168.1.5:3002', isDefault: false });
  }, 60_000);

  it('refuses a server that is on another network', async () => {
    const answers: Record<string, string> = {
      '/blocks/tip/height': '812345',
      '/block-height/0': '00000000da84f2bafbbc53dee25a72ae507ff4914b867c565be350b0da8bf043', // testnet4's first block
      '/fee-estimates': '{"1":2}',
    };
    const fetch = async (url: string) => {
      const body = answers[url.replace(/^[a-z]+:\/\/[^/]+/, '').replace(/^\/api/, '')];
      return { ok: body !== undefined, status: body !== undefined ? 200 : 404, text: async () => body ?? 'Not found' };
    };
    const svc = await createRkWalletService({
      mode: 'real',
      platform: { os: 'ios', isSecure: true, secureKeys: new MemorySecureKeyStore(), kv: new MemoryKeyValueStore() },
      hardware: () => [],
      network: 'signet',
      fetch,
      syncIntervalMs: 0,
    });
    svc.setNetwork('signet');
    expect(await svc.rk.testServer('https://mempool.example/api')).toMatchObject({ ok: false, message: expect.stringMatching(/different network/) });
    svc.setNetwork('testnet');
    expect(await svc.rk.testServer('https://mempool.example/api')).toMatchObject({ ok: true, height: 812345 });
    await svc.close();
  });
});

describe('the scheduler without the app (the background task)', () => {
  it('opens the wallet, reads the chain and sends the next refill, then leaves it alone', async () => {
    const w = world();
    const { p } = await setUp(w, 5_000_000n, { phone: await w.phone({ mode: 'real' }) });
    await p.kv.set('trikey.app.mode', 'real');
    const [first] = p.svc.wallet!.refillTransactions();
    const run = await runRkSchedulerOnce({ kv: p.kv, secureKeys: p.secure, fetch: w.fetch });
    expect(run).toEqual({ ran: true, network: 'regtest', broadcast: first!.txid });
    expect(w.chain.inMempool(first!.txid)).toBe(true);
    // Nothing new to send: it still runs, and sends nothing.
    expect(await runRkSchedulerOnce({ kv: p.kv, secureKeys: p.secure, fetch: w.fetch })).toEqual({ ran: true, network: 'regtest' });
    // The app opens afterwards and knows the refill is this phone's own: no alarm.
    const open = await w.phone({ secure: p.secure, kv: p.kv, mode: 'real' });
    await open.svc.sync();
    expect(open.svc.getState().recoveryKey.notices).toEqual([]);
    expect(open.svc.getState().recoveryKey.next).toMatchObject({ index: 1, status: 'arriving' });
  }, 90_000);

  it('does nothing outside the real mode, with no wallet, or when the phone will not give up its key', async () => {
    const w = world();
    const kv = new MemoryKeyValueStore();
    const secure = new MemorySecureKeyStore();
    expect(await runRkSchedulerOnce({ kv, secureKeys: secure, fetch: w.fetch })).toEqual({ ran: false, reason: 'not-real-mode' });
    await kv.set('trikey.app.mode', 'real');
    expect(await runRkSchedulerOnce({ kv, secureKeys: secure, fetch: w.fetch })).toEqual({ ran: false, reason: 'no-wallet' });
    const { p } = await setUp(w, 1_000_000n, { approve: false, phone: await w.phone({ mode: 'real' }) });
    await p.kv.set('trikey.app.mode', 'real');
    const locked = Object.assign(Object.create(p.secure) as MemorySecureKeyStore, {
      load: async () => {
        throw new Error('The phone is locked.');
      },
    });
    expect(await runRkSchedulerOnce({ kv: p.kv, secureKeys: locked, fetch: w.fetch })).toMatchObject({ ran: false, reason: 'failed' });
  }, 60_000);
});
