/**
 * Family hosting and Settings > Server (docs/design/family-hosting.md, "Chain sources and guests"). The host's chain
 * source is what its guardian checks a guest recovery's coins against and broadcasts a guest's transactions through,
 * so:
 * - a guest's `guardian.status` says where the host's guardian reads the chain: its kind, and a public server's name,
 *   never the address of the host's own node;
 * - a switch is announced to every guest phone (`chain_source_changed`, in the guest's words), over nostr only: the
 *   host's email, ntfy and webhook channels get the host's own announcement and nothing of a guest;
 * - a public server is refused while a guest's recovery runs, as while the host's own recovery runs.
 */
import { getPublicKey } from 'nostr-tools/pure';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { RpcClient, SimplePoolRelayPool, decodeInviteUri, type Alert } from '@trikey/protocol';
import { ElectrumBackend } from '../src/chain/backend.js';
import { ElectrumClient } from '../src/chain/electrum.js';
import { buildBackend, type ChainSource } from '../src/chain/source.js';
import { MNEMONICS } from './helpers.js';
import { FakeElectrum, GuardianRig } from './support/index.js';
import { destinationAfterHardwareLoss, fakeMap, hostedWallet, phoneSweep, type HostedFixture, withHostedRulesApproval } from './support/hosted.js';
import { pairInRig } from './security/support.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor<T>(fn: () => T | undefined | false | Promise<T | undefined | false>, what: string, timeoutMs = 10_000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await sleep(20);
  }
}

let rig: GuardianRig;
let other: FakeElectrum;
const pool = new SimplePoolRelayPool();
let guestRpc: RpcClient;
const guestKey = new Uint8Array(32).fill(81);
const guestPub = getPublicKey(guestKey);
const guestAlerts: Alert[] = [];
const LABEL = 'Granny wallet';
let guest: HostedFixture;

beforeAll(async () => {
  // Public servers and `other.lan` go to a second fake Electrs; the rest as in production.
  other = new FakeElectrum({ blocks: 40, startTime: Math.floor(Date.now() / 1000) - 40 * 600 });
  const port = await other.start();
  const factory = (s: ChainSource, o: { probe: boolean }) => {
    if (s.kind === 'public' || (s.kind === 'electrum' && s.host === 'other.lan'))
      return new ElectrumBackend(new ElectrumClient({ host: '127.0.0.1', port, minBackoffMs: 20, maxBackoffMs: 100 }));
    return buildBackend(s, { network: 'regtest', electrum: { minBackoffMs: 20, maxBackoffMs: 100 }, probe: o.probe });
  };
  rig = await GuardianRig.start({ http: true, chainBackend: factory });
  await pairInRig(rig);
  const inv = await rig.api('POST', '/hosting/invites', { name: 'Granny' });
  const secret = decodeInviteUri(inv.body.link, rig.nowSec()).secret;
  guestRpc = new RpcClient({ pool, relays: rig.relayUrls, secretKey: guestKey, peer: rig.pubkey, now: () => rig.nowSec(), defaultTimeoutMs: 5000 });
  guestRpc.onAlert((a) => void guestAlerts.push(a));
  const prep = await guestRpc.call('hosted.prepare', { inviteSecret: secret, network: 'regtest', entropy: '7a'.repeat(31) + '0e' });
  guest = await hostedWallet({ cosignerPub: prep.cosignerAccountPubkey, app: MNEMONICS.app2, hardware: MNEMONICS.hardware2 });
  await guestRpc.call('hosted.pair', withHostedRulesApproval({
    inviteSecret: secret,
    deviceName: 'Guest phone',
    walletLabel: LABEL,
    network: 'regtest',
    accountPubkeys: { app: guest.accountPubkeys.app, hardware: guest.accountPubkeys.hardware },
    hardwareAuth: guest.hardwareAuth,
    hardwareAuthProof: guest.proof,
    rules: { dailyLimitSats: 100_000, recoveryDelayDays: 7, alertContacts: [], sweepFeeCapSats: 20_000 },
    walletMap: fakeMap(),
    phoneNostrPubkey: guestPub,
  }, guest, rig.nowSec() * 1000));
}, 60_000);

afterAll(async () => {
  guestRpc?.close();
  pool.close();
  await rig?.stop();
  await other?.stop();
});

describe("family hosting and the host's chain source", { timeout: 60_000 }, () => {
  it("a guest's status says where the host's guardian reads the chain, without the host's own node's address", async () => {
    const st = await guestRpc.call('guardian.status', {});
    expect(st.chainSource).toEqual({ kind: 'own', backend: 'electrum', host: 'own' });
    // The host's own Electrs is at 127.0.0.1 in this rig: not named to the guest (the relays are, as to every phone).
    expect(JSON.stringify(st.chainSource)).not.toContain('127.0.0.1');
    expect(st.features).toEqual(['family_hosting', 'limit_off', 'contact_lock', 'short_wraps', 'pairing_rules_approval', 'approval_contacts']);
  });

  it("a public server is refused while a guest's recovery runs", async () => {
    const c = rig.fund(guest.wallet.derive(0, 0).script, 150_000n);
    const dest = await destinationAfterHardwareLoss(guest, MNEMONICS.hardware);
    const sweep = await phoneSweep(guest, dest, [{ txid: c.txid, vout: 0, value: c.value, chain: 0, index: 0, prevTxHex: c.rawTx }]);
    const started = await guestRpc.call('recovery.start', { sweepPsbt: Buffer.from(sweep).toString('base64'), destinationKeys: dest.accountPubkeys, destinationMap: fakeMap() });
    expect((await rig.api('GET', '/chain')).body.recoveryRunning).toBe(true);
    const refused = await rig.api('PUT', '/chain', { kind: 'public', host: 'electrum.example.org' });
    expect(refused).toMatchObject({ status: 409, body: { error: { code: 'recovery_pending' } } });
    await guestRpc.call('recovery.cancel', { recoveryId: started.recovery.recoveryId });
    expect((await rig.api('GET', '/chain')).body.recoveryRunning).toBe(false);
  });

  it("a switch reaches the guest's phone in its own words, and never the host's channels with anything of the guest", async () => {
    const g = rig.guardian;
    const phone = vi.spyOn(g, 'notifyPhone');
    const enqueue = vi.spyOn(g.notifier, 'enqueue');
    Object.defineProperty(g.notifier, 'configured', { get: () => true, configurable: true });

    expect((await rig.api('PUT', '/chain', { kind: 'public', host: 'electrum.example.org' })).status).toBe(200);
    const pub = await waitFor(() => guestAlerts.find((a) => a.type === 'chain_source_changed'), "the guest's chain_source_changed");
    expect(pub).toMatchObject({ kind: 'public', backend: 'electrum', host: 'electrum.example.org' });
    expect((pub as { message: string }).message).toMatch(/host's guardian now reads the blockchain from a public server \(electrum\.example\.org\)/);
    expect((pub as { message: string }).message).toMatch(/Your phone still reads your wallet from its own chain server/);
    expect((await guestRpc.call('guardian.status', {})).chainSource).toEqual({ kind: 'public', backend: 'electrum', host: 'electrum.example.org' });
    // The host's phone got the host's alert; the host's channels the host's announcement, with nothing of the guest.
    expect(phone).toHaveBeenCalledWith(expect.objectContaining({ type: 'chain_source_changed', host: 'electrum.example.org' }));
    const events = enqueue.mock.calls.map((c) => c[0]);
    // (The host's contact may still be owed its pairing notice, `contact_added`: the host's own, with nothing of the guest.)
    expect(events.map((e) => e.type).filter((t) => t !== 'contact_added')).toEqual(['chain_source_changed']);
    const text = JSON.stringify(events.map((e) => [e.owner, e.contacts?.text('nostr')]));
    for (const secret of [LABEL, 'Granny', guest.walletId, guestPub]) expect(text).not.toContain(secret);

    // Back to an own node: the guest is told, without that node's name.
    guestAlerts.length = 0;
    expect((await rig.api('PUT', '/chain', { kind: 'electrum', host: 'other.lan', tls: false })).status).toBe(200);
    const own = await waitFor(() => guestAlerts.find((a) => a.type === 'chain_source_changed'), "the guest's second chain_source_changed");
    expect(own).toMatchObject({ kind: 'own', backend: 'electrum', host: 'own' });
    expect(JSON.stringify(own)).not.toContain('other.lan');
    expect((await guestRpc.call('guardian.status', {})).chainSource).toEqual({ kind: 'own', backend: 'electrum', host: 'own' });
  });
});
