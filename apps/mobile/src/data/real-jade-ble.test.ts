/**
 * A Jade over Bluetooth, in the app: the real wallet service, the real guardian in-process (regtest, throwaway keys), and
 * the app's real Jade provider, signer and bridge, with a fake Jade behind a fake Bluetooth link and a fake PIN server
 * (../hardware/test/fake-jade-ble.ts, written from the firmware). Nothing here touches a phone's Bluetooth;
 * docs/alpha-test-plan.md (step 18h) has the device steps.
 *
 * - connect: the owner picks "Jade by Bluetooth"; the phone finds the Jade, shows the PIN-server notice once, relays the
 *   PIN check, and reads the Jade's fingerprint;
 * - pairing in guardian mode: the Jade signs `Trikey pair v1 ...` with `sign_message` at m/48'/1'/0'/2'/0/0, the wallet is
 *   registered on it (`register_multisig`) and the first address is shown on it and compared;
 * - notes: the same text twice, the same signature twice (RFC 6979), never anti-exfil;
 * - a payment over the daily limit: `sign_psbt`, each signature checked before it is used.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as btc from '@scure/btc-signer';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { NETWORKS } from '@trikey/core';
import { GuardianRig } from '@trikey/guardian/testing';
import { MemoryCloudBackupStore, MemoryKeyValueStore, MemoryPasskeyPrf, MemorySecureKeyStore } from '@trikey/wallet/testing';
import { JadeBleBridge, memoryNoticeStore, type JadeBridgeScreen } from '../hardware/jade/bridge';
import { JadeBleProvider } from '../hardware/jade/provider';
import { QrBridge } from '../hardware/qr/bridge';
import { QrProvider } from '../hardware/qr/provider';
import { FakeJade, fakePinServer } from '../hardware/test/fake-jade-ble';
import { createRealWalletService, type RealWalletService } from './real';

const MNEMONIC = 'legal winner thank year wave sausage worth useful legal winner thank yellow';
const externalAddress = (seed = 2) => btc.p2wpkh(secp256k1.getPublicKey(new Uint8Array(32).fill(seed), true), NETWORKS.regtest.btc).address!;

let rig: GuardianRig;
const opened: RealWalletService[] = [];

beforeAll(async () => {
  rig = await GuardianRig.start();
}, 30_000);

afterAll(async () => {
  for (const s of opened) await s.close();
  await rig?.stop();
});

describe('a Jade over Bluetooth, in the app', { timeout: 120_000 }, () => {
  const jade = new FakeJade({ mnemonic: MNEMONIC, mtu: 185 });
  const link = jade.link();
  const bridge = new JadeBleBridge(link);
  const server = fakePinServer();
  const screens: JadeBridgeScreen[] = [];
  bridge.subscribe(() => {
    const s = bridge.getSnapshot();
    if (!s) return;
    screens.push(s);
    // The owner reads the PIN-server notice and goes on.
    if (s.type === 'confirm') queueMicrotask(() => bridge.proceed());
  });
  let svc: RealWalletService;

  beforeAll(async () => {
    svc = await createRealWalletService({
      mode: 'real',
      platform: { os: 'android', isSecure: true, secureKeys: new MemorySecureKeyStore(), kv: new MemoryKeyValueStore(), cloudBackups: [new MemoryCloudBackupStore()], passkeys: Object.assign(new MemoryPasskeyPrf(), { supported: false }) },
      // As on a phone: the Jade over Bluetooth next to QR.
      hardware: () => [new JadeBleProvider({ network: 'regtest', bridge, fetch: server.fetch, notices: memoryNoticeStore() }), new QrProvider({ network: 'regtest', qr: { bridge: new QrBridge() } })],
      clock: rig.clock,
      rpcTimeoutMs: 5000,
      rpcRetryIntervalMs: 0,
      syncIntervalMs: 0,
      syncJoinMs: 0,
      yieldToUi: async () => {},
      recoveryCodeKdf: { m: 64, t: 1, p: 1 },
    });
    opened.push(svc);
    svc.setNetwork('regtest');
    svc.setMode('guardian');
  });

  it('lists "Jade by Bluetooth" where the phone has Bluetooth, and says why where it has none', async () => {
    const options = await svc.getHardwareOptions();
    expect(options.find((o) => o.kind === 'jade-ble')).toMatchObject({ name: 'Jade by Bluetooth', available: true });
    link.supported = false;
    expect((await svc.getHardwareOptions()).find((o) => o.kind === 'jade-ble')).toMatchObject({ available: false, unavailableDetail: 'This phone has no Bluetooth.' });
    link.supported = true;
  });

  it('connects: finds the Jade, shows the PIN-server notice once, relays the PIN check, reads its fingerprint', async () => {
    const hw = await svc.connectHardware('jade-ble');
    expect(hw).toEqual({ kind: 'jade-ble', brand: 'Jade', model: 'Jade Plus' });
    expect(screens.filter((s) => s.type === 'confirm').map((s) => s.title)).toEqual(['Your Jade’s PIN server']);
    expect(server.calls.map((c) => c.url)).toEqual(['https://j8d.io/get_pin']);
    expect(jade.isUnlocked).toBe(true);
  });

  it('pairs with the guardian: the Jade signs the pairing text, the wallet is registered, and the first address is compared on it', async () => {
    await svc.pairGuardian(rig.pairingUri());
    await svc.setUpRules(100_000, 7);
    expect(svc.wallet!.state.hardware).toMatchObject({ kind: 'jade-ble', model: 'Jade Plus', fingerprint: jade.fingerprint });
    // The pairing proof, then the rules the wallet starts with (seq=0), which the Jade shows.
    expect(jade.signedTexts).toEqual([expect.stringMatching(/^Trikey pair v1 wallet=[0-9a-f]{16} guardian=0[23][0-9a-f]{64}$/), expect.stringMatching(/^Trikey policy v1 wallet=[0-9a-f]{16} seq=0 limit=100000 delay=7d feecap=\d+ contacts=\d+ hash=[0-9a-f]{64} expires=\S+Z$/)]);
    const sm = jade.requests.find((r) => r.method === 'sign_message')!;
    expect(sm.params).toEqual({ path: [0x80000030, 0x80000001, 0x80000000, 0x80000002, 0, 0], message: jade.signedTexts[0] });
    expect([...jade.wallets.keys()]).toHaveLength(1);
    expect(jade.requests.some((r) => r.method === 'get_receive_address')).toBe(true);
    expect(svc.getState().hardware).toMatchObject({ kind: 'jade-ble', brand: 'Jade' });
    // The notice was not shown again, whatever the number of connections.
    expect(screens.filter((s) => s.type === 'confirm')).toHaveLength(1);
  });

  it('notes on the guardian: the same text twice, the same signature twice, no anti-exfil', async () => {
    expect(svc.notes!.state()).toMatchObject({ available: true, on: false });
    const before = jade.signedTexts.length;
    await svc.notes!.enable();
    const texts = jade.signedTexts.slice(before);
    expect(texts).toHaveLength(2);
    expect(texts[0]).toBe(texts[1]);
    expect(jade.requests.filter((r) => r.method === 'sign_message').every((r) => !('ae_host_commitment' in (r.params ?? {})))).toBe(true);
    expect(svc.notes!.state()).toMatchObject({ on: true });
    await svc.notes!.disable();
  });

  it('offers hardware unlock', () => {
    expect(svc.wallet!.hardwareUnlockView()).toMatchObject({ available: true });
  });

  it('co-signs a payment over the daily limit with sign_psbt', async () => {
    rig.fund(svc.wallet!.multisig().derive(0, 0).script, 500_000n);
    await svc.sync();
    await svc.idle();
    const q = svc.quoteSend({ address: externalAddress(), amountSats: 120_000, speed: 'normal' });
    if (!q.ok) throw new Error(q.message);
    expect(q.quote.plan).toEqual({ signer: 'hardware', reason: 'over-limit' });
    const tx = await svc.sendPayment(q.quote);
    expect(tx).toMatchObject({ amountSats: 120_000, signedBy: 'phone+hardware' });
    expect(jade.signedPsbts).toHaveLength(1);
    expect(jade.requests.filter((r) => r.method === 'sign_psbt').at(-1)!.params).toMatchObject({ network: 'localtest' });
    expect(rig.electrs.broadcasts.length).toBeGreaterThanOrEqual(1);
    // One connection (and PIN) for setting up and pairing, one for notes, one for the payment: the Jade locks when the
    // Bluetooth link that unlocked it drops (firmware dashboard.c), so each connection asks for the PIN again.
    expect([jade.connects, server.calls.length]).toEqual([3, 3]);
  });
});
