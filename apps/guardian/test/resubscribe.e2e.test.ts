/**
 * The guardian keeps listening across a relay restart (and a dropped connection): its one gift-wrap subscription
 * (the inbox, which feeds the RPC server and the DMs) is opened again by the pool, and a phone's next request is
 * answered. Before 0.1.9 the subscription ended for good when a relay restarted (nostr-tools closed it on the
 * connection's `error`, or reconnected with a `since` that skips back-dated gift wraps). Regtest, throwaway keys.
 */
import { generateSecretKey } from 'nostr-tools/pure';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RpcClient, SimplePoolRelayPool, decodePairingUri } from '@trikey/protocol';
import { GuardianRig } from './support/index.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(cond: () => boolean, what: string, timeoutMs = 8000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await sleep(20);
  }
}

let rig: GuardianRig;
let pool: SimplePoolRelayPool;
let phone: RpcClient;

beforeAll(async () => {
  rig = await GuardianRig.start({ relayCount: 1 });
  pool = new SimplePoolRelayPool({ resubscribeBackoffMs: [200] });
  phone = new RpcClient({ pool, relays: rig.relayUrls, secretKey: generateSecretKey(), peer: rig.pubkey, now: () => rig.nowSec(), defaultTimeoutMs: 6000 });
  await phone.start();
}, 30_000);

afterAll(async () => {
  phone?.close();
  pool?.close();
  await rig?.stop();
});

const prepare = async () => {
  const p = decodePairingUri(rig.pairingUri(), rig.nowSec());
  return phone.call('pair.prepare', { pairingSecret: p.secret, network: 'regtest' });
};
const resubscribes = () => rig.logLines.filter((l) => l.includes('nostr.resubscribe')).length;

describe('the guardian after its relay drops', { timeout: 30_000 }, () => {
  it('answers before', async () => {
    expect((await prepare()).guardianKey.xpub).toMatch(/^tpub/);
    expect(rig.guardian.relayStatus()).toEqual([{ url: rig.relayUrls[0], connected: true }]);
  });

  it('subscribes again after a relay restart and answers the next request', async () => {
    const relay = rig.relays[0]!;
    const before = resubscribes();
    await relay.stop();
    await sleep(300);
    await relay.start(); // same URL
    await waitFor(() => resubscribes() > before, 'the guardian to resubscribe');
    await waitFor(() => rig.guardian.relayStatus()[0]!.connected, 'the relay to show as connected');
    expect((await prepare()).guardianKey.xpub).toMatch(/^tpub/);
  });

  it('and after the connection is reset under it', async () => {
    const before = resubscribes();
    rig.relays[0]!.dropConnections('reset');
    await waitFor(() => resubscribes() > before, 'the guardian to resubscribe');
    expect((await prepare()).guardianKey.xpub).toMatch(/^tpub/);
  });
});
