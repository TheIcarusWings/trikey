/**
 * A BitBox02, in the app: the real wallet service, the real guardian in-process (regtest, throwaway keys), and the app's
 * real BitBox02 provider, signer and bridge, with a fake BitBox02 (../hardware/test/fake-bitbox02.ts, written from the
 * firmware) behind a fake USB link. Nothing here touches a phone's USB or Bluetooth; docs/alpha-test-plan.md (step 18i)
 * has the device steps.
 *
 * - connect: the owner picks "BitBox02"; the phone finds it, the owner unlocks it, and the first time compares the
 *   pairing code (the BitBox02 shows the same) and confirms it on the BitBox02;
 * - pairing in guardian mode: the BitBox02 signs `Trikey pair v1 ...` at m/48'/1'/0'/2'/0/0 with anti-klepto, the wallet
 *   is registered on it and the first address is shown on it and compared;
 * - notes: the same text twice, the same signature twice (no anti-klepto: the firmware's deterministic signature);
 * - a payment over the daily limit: the BitBox02's signing flow, anti-klepto on each input, each signature checked.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as btc from '@scure/btc-signer';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { NETWORKS } from '@trikey/core';
import { GuardianRig } from '@trikey/guardian/testing';
import { MemoryCloudBackupStore, MemoryKeyValueStore, MemoryPasskeyPrf, MemorySecureKeyStore } from '@trikey/wallet/testing';
import { BitBoxBridge, type BitBoxBridgeScreen } from '../hardware/bitbox02/bridge';
import { BitBox02Provider } from '../hardware/bitbox02/provider';
import { memoryPairingStore } from '../hardware/bitbox02/session';
import { QrBridge } from '../hardware/qr/bridge';
import { QrProvider } from '../hardware/qr/provider';
import { FakeBitBox02 } from '../hardware/test/fake-bitbox02';
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

describe('a BitBox02 over USB-C, in the app', { timeout: 120_000 }, () => {
  const bitbox = new FakeBitBox02({ mnemonic: MNEMONIC, polls: 1 });
  const link = bitbox.link();
  const bridge = new BitBoxBridge([link]);
  const pairing = memoryPairingStore();
  const screens: BitBoxBridgeScreen[] = [];
  bridge.subscribe(() => {
    const s = bridge.getSnapshot();
    if (s) screens.push(s);
  });
  let svc: RealWalletService;

  beforeAll(async () => {
    svc = await createRealWalletService({
      mode: 'real',
      platform: { os: 'android', isSecure: true, secureKeys: new MemorySecureKeyStore(), kv: new MemoryKeyValueStore(), cloudBackups: [new MemoryCloudBackupStore()], passkeys: Object.assign(new MemoryPasskeyPrf(), { supported: false }) },
      // As on an Android phone: the BitBox02 next to QR.
      hardware: () => [new BitBox02Provider({ network: 'regtest', bridge, pairing, hww: { sleep: async () => {} } }), new QrProvider({ network: 'regtest', qr: { bridge: new QrBridge() } })],
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

  it('lists the BitBox02 where the phone can reach one, and says why where it cannot', async () => {
    const options = await svc.getHardwareOptions();
    expect(options.find((o) => o.kind === 'bitbox02')).toMatchObject({ name: 'BitBox02', detail: 'USB-C, or Bluetooth on the Nova', available: true });
    link.supported = false;
    expect((await svc.getHardwareOptions()).find((o) => o.kind === 'bitbox02')).toMatchObject({ available: false, unavailableDetail: expect.stringMatching(/phone app/) });
    link.supported = true;
  });

  it('connects: finds it, the owner unlocks it and confirms the pairing code, and its fingerprint is read', async () => {
    const hw = await svc.connectHardware('bitbox02');
    expect(hw).toEqual({ kind: 'bitbox02', brand: 'BitBox02', model: 'BitBox02' });
    expect(screens.map((s) => s.title)).toContain('Check the pairing code');
    expect(screens.find((s) => s.code)!.code).toBe(bitbox.pairingCodes[0]);
  });

  it('pairs with the guardian: the BitBox02 signs the pairing text, the wallet is registered, and the first address is compared on it', async () => {
    await svc.pairGuardian(rig.pairingUri());
    await svc.setUpRules(100_000, 7);
    expect(svc.wallet!.state.hardware).toMatchObject({ kind: 'bitbox02', model: 'BitBox02', fingerprint: bitbox.fingerprint });
    // The pairing proof, then the rules the wallet starts with (seq=0), which the BitBox02 shows: both with anti-klepto.
    expect(bitbox.signedTexts).toEqual([expect.stringMatching(/^Trikey pair v1 wallet=[0-9a-f]{16} guardian=0[23][0-9a-f]{64}$/), expect.stringMatching(/^Trikey policy v4 wallet=[0-9a-f]{16} seq=0 limit=100000 delay=7d feecap=\d+ lock=off contacts=\S+ expires=\S+Z$/)]);
    expect(bitbox.textsWithAntiKlepto).toEqual([true, true]);
    expect(bitbox.registered.size).toBe(1);
    expect(bitbox.requests).toContain('btc_pub address');
    expect(bitbox.screens.find((s) => s.title === 'Receive to')!.body).toContain(svc.wallet!.multisig().derive(0, 0).address);
    expect(svc.getState().hardware).toMatchObject({ kind: 'bitbox02', brand: 'BitBox02' });
  });

  it('notes on the guardian: the same text twice, the same signature twice, without anti-klepto', async () => {
    expect(svc.notes!.state()).toMatchObject({ available: true, on: false });
    const before = bitbox.signedTexts.length;
    await svc.notes!.enable();
    const texts = bitbox.signedTexts.slice(before);
    expect(texts).toHaveLength(2);
    expect(texts[0]).toBe(texts[1]);
    expect(bitbox.textsWithAntiKlepto.slice(before)).toEqual([false, false]);
    expect(svc.notes!.state()).toMatchObject({ on: true });
    await svc.notes!.disable();
  });

  it('offers hardware unlock', () => {
    expect(svc.wallet!.hardwareUnlockView()).toMatchObject({ available: true });
  });

  it('co-signs a payment over the daily limit: previous transactions, anti-klepto, each signature checked', async () => {
    rig.fund(svc.wallet!.multisig().derive(0, 0).script, 500_000n);
    await svc.sync();
    await svc.idle();
    const q = svc.quoteSend({ address: externalAddress(), amountSats: 120_000, speed: 'normal' });
    if (!q.ok) throw new Error(q.message);
    expect(q.quote.plan).toEqual({ signer: 'hardware', reason: 'over-limit' });
    const tx = await svc.sendPayment(q.quote);
    expect(tx).toMatchObject({ amountSats: 120_000, signedBy: 'phone+hardware' });
    expect(bitbox.signedPayments).toHaveLength(1);
    // The payment on its screen; the change is the wallet's own and is not shown.
    expect(bitbox.screens.filter((s) => s.title === 'Send to').map((s) => s.body)).toEqual([`${externalAddress()}\n120000 sat`]);
    expect(bitbox.requests.filter((r) => r === 'antiklepto_signature').length).toBeGreaterThanOrEqual(2);
    expect(rig.electrs.broadcasts.length).toBeGreaterThanOrEqual(1);
    // One pairing code for this phone and this BitBox02, however many connections there were.
    expect(bitbox.connects).toBeGreaterThan(1);
    expect(bitbox.pairingCodes).toHaveLength(1);
  });
});
