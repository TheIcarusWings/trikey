/**
 * The phone's pull to refresh, as the guardian sees it: a burst of `guardian.status`, `fees.estimate` and `wallet.sync`
 * against a slow Electrs (every request ~160 ms, one after the other on the connection, as an Umbrel's electrs 0.11).
 * Regtest, throwaway keys and published BIP39 test mnemonics only.
 */
import { hex } from '@scure/base';
import { HDKey } from '@scure/bip32';
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MultisigWallet, type KeyExpression } from '@trikey/core';
import { RpcClient, SimplePoolRelayPool, decodePairingUri, pairingMessage } from '@trikey/protocol';
import { signMessage } from '../src/policy/index.js';
import { AUTH_PATH, appSigner, hwAuthPrivateKey, hwAuthPubkey, hwSigner, network, withRulesApproval } from './helpers.js';
import { GuardianRig } from './support/index.js';

/** An Umbrel's electrs 0.11, per request (LIVE_MEASURE_DELAY_MS to change it). */
const DELAY = Number(process.env.LIVE_MEASURE_DELAY_MS ?? 160);

let rig: GuardianRig;
const pool = new SimplePoolRelayPool();
const phoneKey = generateSecretKey();
let phone: RpcClient;
let wallet: MultisigWallet;

beforeAll(async () => {
  rig = await GuardianRig.start();
  const p = decodePairingUri(rig.pairingUri(), rig.nowSec());
  phone = new RpcClient({ pool, relays: rig.relayUrls, secretKey: phoneKey, peer: rig.pubkey, now: () => rig.nowSec(), defaultTimeoutMs: 15_000 });
  const prep = await phone.call('pair.prepare', { pairingSecret: p.secret, network: 'regtest' });
  const cosigner: KeyExpression = {
    fingerprint: prep.guardianKey.fingerprint,
    originPath: prep.guardianKey.path.replace(/^m\//, '').replace(/'/g, 'h'),
    xpub: prep.guardianKey.xpub,
  };
  wallet = new MultisigWallet(network, { app: await appSigner().getKey(network), hardware: await hwSigner().getKey(network), cosigner });
  const cosignerPub = hex.encode(HDKey.fromExtendedKey(prep.guardianKey.xpub, network.bip32).publicKey!);
  const app = wallet.keys.app;
  await phone.call('pair', withRulesApproval({
    pairingSecret: p.secret,
    deviceName: 'Refresh test phone',
    network: 'regtest',
    phoneKey: { fingerprint: app.fingerprint, path: `m/${app.originPath.replace(/h/g, "'")}`, xpub: app.xpub },
    descriptor: wallet.descriptor(),
    phoneNostrPubkey: getPublicKey(phoneKey),
    hardwareAuth: { pubkey: hwAuthPubkey(), path: AUTH_PATH },
    hardwareAuthProof: signMessage(pairingMessage(wallet.fingerprint(), cosignerPub), hwAuthPrivateKey()),
    rules: { dailyLimitSats: 100_000, recoveryDelayDays: 7, alertContacts: [], sweepFeeCapSats: 20_000 },
  }, rig.nowSec() * 1000));
  for (let i = 0; i < 6; i++) rig.fund(wallet.derive(i % 2 === 0 ? 0 : 1, i).script, BigInt(50_000 + i));
  // Warm: the live wallet watched (subscriptions), transactions and block times known.
  await phone.call('wallet.sync', {});
  await rig.guardian.chain.watchWallet(wallet);
  await phone.call('wallet.sync', {});
}, 60_000);

afterAll(async () => {
  phone?.close();
  pool.close();
  await rig?.stop();
});

/** Each reply's time since the first request was sent (ms). `feesAfterSync`: as the phone asks now (fees after the pull). */
async function burst(opts: { feesAfterSync?: boolean } = {}): Promise<{ status: number; fees: number; sync: number }> {
  const t0 = performance.now();
  const at = <T>(p: Promise<T>) => p.then(() => performance.now() - t0);
  const fees = () => at(phone.call('fees.estimate', { targets: [1, 3, 6, 144] }));
  if (opts.feesAfterSync) {
    const syncP = at(phone.call('wallet.sync', {}));
    const [sync, status] = await Promise.all([syncP, at(phone.call('guardian.status', {}))]);
    return { status, sync, fees: await fees() };
  }
  // The order 0.1.12 asked in: status and fees next to wallet.sync, all awaited.
  const [status, f, sync] = await Promise.all([at(phone.call('guardian.status', {})), fees(), at(phone.call('wallet.sync', {}))]);
  return { status, fees: f, sync };
}

const fmt = (o: Record<string, number>) =>
  Object.entries(o)
    .map(([k, v]) => `${k} ${v.toFixed(0)} ms`)
    .join(', ');

describe(`a pull's requests on an Electrs taking ${DELAY} ms per request, one after the other`, { timeout: 60_000 }, () => {
  it('wallet.sync waits for one round trip to Electrs, not for fee estimates', async () => {
    rig.electrs.requestDelayMs = DELAY;
    try {
      const t = async (fn: () => Promise<unknown>) => {
        const s = performance.now();
        await fn();
        return performance.now() - s;
      };
      rig.guardian.chain.forgetFees();
      const alone = {
        status: await t(() => phone.call('guardian.status', {})),
        sync: await t(() => phone.call('wallet.sync', {})),
        fees: await t(() => phone.call('fees.estimate', { targets: [1, 3, 6, 144] })),
        feesKept: await t(() => phone.call('fees.estimate', { targets: [1, 3, 6, 144] })),
      };
      // 0.1.12's burst, fee estimates kept by the guardian (asked < 60 s ago, no block since).
      const kept = await burst();
      // A new block: estimates read again. The phone asks for them once the pull's wallet.sync is answered.
      rig.guardian.chain.forgetFees();
      const fresh = await burst({ feesAfterSync: true });
      console.log(`\nElectrs at ${DELAY} ms/request. Alone: ${fmt(alone)}. 0.1.12's burst, fees kept: ${fmt(kept)}. Fees not kept, asked after the pull: ${fmt(fresh)}`);
      // Uncached, the fees are five requests on the server; the pull's wallet.sync is one (a ping) plus the relays, or
      // two when the guardian's own live wallet pass had a ping on its way (it must not ride on one sent before it).
      // 0.1.12 waited for the five behind its ping too: six.
      expect(alone.fees).toBeGreaterThan(5 * DELAY - 20);
      expect(alone.feesKept).toBeLessThan(DELAY);
      expect(kept.sync).toBeLessThan(3 * DELAY);
      expect(fresh.sync).toBeLessThan(3 * DELAY);
      expect(fresh.fees - fresh.sync).toBeGreaterThan(5 * DELAY - 20);
    } finally {
      rig.electrs.requestDelayMs = 0;
    }
  });
});
