/**
 * Switching the chain source (Settings > Server) is security-relevant: a public server sees the wallets' addresses and
 * could hide coins or delay confirmations. So every change is logged in Activity and announced to the paired phone and
 * on every alert channel; a public server is refused while a recovery runs; and the switch takes effect at once (the
 * guardian reads the new server, and keeps it after a restart).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RECEIVE, buildSweep } from '@trikey/core';
import { ElectrumBackend } from '../../src/chain/backend.js';
import { ElectrumClient } from '../../src/chain/electrum.js';
import { buildBackend, type ChainSource } from '../../src/chain/source.js';
import { FakeElectrum, GuardianRig } from '../support/index.js';
import { MNEMONICS, hwSigner, makeWallet, network, nostrKey } from '../helpers.js';
import { pairInRig } from './support.js';

let rig: GuardianRig | undefined;
let other: FakeElectrum | undefined;
afterEach(async () => {
  await rig?.stop();
  rig = undefined;
  await other?.stop();
  other = undefined;
});

/** Public servers and anything named `other.lan` go to the second fake Electrs; the rest as in production. */
async function rigWithTwoServers() {
  other = new FakeElectrum({ blocks: 40, startTime: Math.floor(Date.now() / 1000) - 40 * 600 });
  const port = await other.start();
  const factory = (s: ChainSource, o: { probe: boolean }) => {
    if (s.kind === 'public' || (s.kind === 'electrum' && s.host === 'other.lan'))
      return new ElectrumBackend(new ElectrumClient({ host: '127.0.0.1', port, minBackoffMs: 20, maxBackoffMs: 100 }));
    return buildBackend(s, { network: 'regtest', electrum: { minBackoffMs: 20, maxBackoffMs: 100 }, probe: o.probe });
  };
  rig = await GuardianRig.start({ http: true, chainBackend: factory });
  return { rig, port };
}

describe('security: changing where the guardian reads the chain', () => {
  it('shows the source in use and the public servers for the network; nothing about it without a session', async () => {
    const { rig } = await rigWithTwoServers();
    expect((await rig.api('GET', '/chain', undefined, { session: false })).status).toBe(401);
    const r = await rig.api('GET', '/chain');
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      source: { kind: 'electrum', host: '127.0.0.1', tls: false },
      summary: { kind: 'own', backend: 'electrum' },
      origin: 'environment',
      status: { connected: true, height: 29 },
      publicServers: [],
      network: 'regtest',
      recoveryRunning: false,
    });
  }, 30_000);

  it('switches at once, logs it in Activity, tells the phone and every channel, and keeps it after a restart', async () => {
    const { rig } = await rigWithTwoServers();
    const g = rig.guardian;
    await pairInRig(rig);
    const phone = vi.spyOn(g, 'notifyPhone');
    const enqueue = vi.spyOn(g.notifier, 'enqueue');
    Object.defineProperty(g.notifier, 'configured', { get: () => true, configurable: true });

    const r = await rig.api('PUT', '/chain', { kind: 'public', host: 'electrum.example.org' });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ source: { kind: 'public', host: 'electrum.example.org', port: 50002 }, summary: { kind: 'public' }, origin: 'settings' });
    await g.chain.backend!.waitReady(3000);
    expect((await g.chain.tip()).height).toBe(39); // the other server's chain

    expect(phone).toHaveBeenCalledWith(expect.objectContaining({ type: 'chain_source_changed', kind: 'public', backend: 'electrum', host: 'electrum.example.org' }));
    const alert = phone.mock.calls.find((c) => c[0].type === 'chain_source_changed')![0] as { message: string };
    expect(alert.message).toMatch(/public server electrum\.example\.org:50002 \(before: your own Electrum server 127\.0\.0\.1:\d+\)/);
    expect(alert.message).toMatch(/could hide coins/);
    const ev = enqueue.mock.calls.map((c) => c[0]).find((e) => e.type === 'chain_source_changed')!;
    expect(ev.owner).toMatch(/public server/);
    expect(ev.contacts?.text('nostr')).toMatch(/alert contact/);

    const activity = await rig.api('GET', '/activity');
    const entry = activity.body.entries.find((e: { summary: string }) => e.summary === 'Server changed to a public one');
    expect(entry.event).toMatch(/now reads the blockchain from the public server electrum\.example\.org:50002/);

    // guardian.status tells the phone.
    const status = await import('./support.js').then((m) => m.callHandler(rig, 'guardian.status', {}));
    expect(status.chainSource).toEqual({ kind: 'public', backend: 'electrum', host: 'electrum.example.org' });

    // The same choice again changes nothing and announces nothing.
    phone.mockClear();
    expect((await rig.api('PUT', '/chain', { kind: 'public', host: 'electrum.example.org' })).status).toBe(200);
    expect(phone).not.toHaveBeenCalled();

    // After a restart the guardian reads the same server.
    await rig.restart();
    expect(rig.guardian.chainSource).toEqual({ kind: 'public', host: 'electrum.example.org', port: 50002 });
    expect(rig.guardian.chainSourceOrigin).toBe('settings');
  }, 60_000);

  it('refuses a public server while a recovery runs; your own node is fine', async () => {
    const { rig } = await rigWithTwoServers();
    const g = rig.guardian;
    const { wallet } = await pairInRig(rig);
    const coin = rig.fund(wallet.derive(RECEIVE, 0).script, 500_000n);
    const dest = await makeWallet({ app: MNEMONICS.app2 });
    const plan = buildSweep({ from: wallet, utxos: [{ txid: coin.txid, vout: 0, value: coin.value, chain: RECEIVE, index: 0, prevTxHex: coin.rawTx }], destination: dest, destinationIndex: 0, feeRate: 2 });
    const rec = await g.engine.startRecovery({ psbt: await hwSigner().signPsbt(plan.psbt, network), destinationDescriptor: dest.descriptor(), initiator: nostrKey(21) });
    expect(rec.ok).toBe(true);

    expect((await rig.api('GET', '/chain')).body.recoveryRunning).toBe(true);
    const refused = await rig.api('PUT', '/chain', { kind: 'public', host: 'electrum.example.org' });
    expect(refused).toMatchObject({ status: 409, body: { error: { code: 'recovery_pending' } } });
    expect(g.chainSource).toMatchObject({ kind: 'electrum', host: '127.0.0.1' });

    const own = await rig.api('PUT', '/chain', { kind: 'electrum', host: 'other.lan', tls: false });
    expect(own.status).toBe(200);
    expect(g.chainSource).toEqual({ kind: 'electrum', host: 'other.lan', port: 50001, tls: false });
  }, 60_000);

  it('refuses what cannot work before switching, and needs a signed-in, unlocked guardian', async () => {
    const { rig } = await rigWithTwoServers();
    expect((await rig.api('PUT', '/chain', { kind: 'electrum', host: '203.0.113.9', tls: false })).body.error).toMatchObject({ code: 'invalid' });
    expect((await rig.api('PUT', '/chain', { kind: 'public', host: '10.0.0.5' })).body.error).toMatchObject({ code: 'invalid' });
    expect((await rig.api('PUT', '/chain', { kind: 'public', host: 'x.example' }, { session: false })).status).toBe(401);
    await rig.lock();
    expect((await rig.api('PUT', '/chain', { kind: 'public', host: 'x.example' })).body.error).toMatchObject({ code: 'locked' });
    expect(rig.guardian.chainSourceOrigin).toBe('environment');
  }, 30_000);

  it('"Test connection" connects to a server without switching to it', async () => {
    const { rig } = await rigWithTwoServers();
    const ok = await rig.api('POST', '/chain/test', { kind: 'electrum', host: 'other.lan', tls: false });
    expect(ok.body).toMatchObject({ ok: true, server: 'FakeElectrs 0.1', height: 39 });
    expect(rig.guardian.chainSource).toMatchObject({ host: '127.0.0.1' });
    const bad = await rig.api('POST', '/chain/test', { kind: 'electrum', host: '203.0.113.9', tls: false });
    expect(bad.body).toMatchObject({ ok: false, error: expect.stringMatching(/on the internet/) });
    const refused = await rig.api('POST', '/chain/test', { kind: 'electrum', host: '127.0.0.1', port: 1, tls: false });
    expect(refused.body.ok).toBe(false);
  }, 30_000);
});
