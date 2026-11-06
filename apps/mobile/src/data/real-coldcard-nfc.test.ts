/**
 * A Coldcard Mk4 over NFC, in the app: the real wallet service, the real guardian in-process (regtest, throwaway keys),
 * and the app's real NFC provider, signer and bridge, with the NFC screens played by the owner in front of a fake
 * Coldcard (../hardware/test/fake-coldcard-nfc.ts: the firmware's NDEF maker and parser, ported). Nothing here touches a
 * phone's NFC; docs/alpha-test-plan.md has the device steps.
 *
 * - connect: the owner picks "Coldcard by NFC", then the Mk4; the phone reads its multisig key export;
 * - pairing in guardian mode: the phone writes `signmessage m/48h/1h/0h/2h/0/0 ascii:Trikey pair v1 ...`, the Coldcard
 *   signs, the phone reads the armored block and checks it; then the wallet goes onto the Coldcard and the first address
 *   is compared;
 * - notes: the same text twice;
 * - a payment over the daily limit: the PSBT goes to the Coldcard over NFC and comes back signed.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as btc from '@scure/btc-signer';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { NETWORKS } from '@trikey/core';
import { GuardianRig } from '@trikey/guardian/testing';
import { MemoryCloudBackupStore, MemoryKeyValueStore, MemoryPasskeyPrf, MemorySecureKeyStore } from '@trikey/wallet/testing';
import { NfcBridge, type NfcWriteRequest } from '../hardware/nfc/bridge';
import { NfcProvider } from '../hardware/nfc/provider';
import { QrBridge } from '../hardware/qr/bridge';
import { QrProvider } from '../hardware/qr/provider';
import { FakeColdcard, playOwner } from '../hardware/test/fake-coldcard-nfc';
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

describe('a Coldcard Mk4 over NFC, in the app', { timeout: 120_000 }, () => {
  const cc = new FakeColdcard({ mnemonic: MNEMONIC });
  const bridge = new NfcBridge(cc.tag);
  const owner = playOwner(bridge, cc);
  let svc: RealWalletService;

  beforeAll(async () => {
    svc = await createRealWalletService({
      mode: 'real',
      platform: { os: 'android', isSecure: true, secureKeys: new MemorySecureKeyStore(), kv: new MemoryKeyValueStore(), cloudBackups: [new MemoryCloudBackupStore()], passkeys: Object.assign(new MemoryPasskeyPrf(), { supported: false }) },
      // As on a phone: QR and NFC side by side.
      hardware: () => [new NfcProvider({ network: 'regtest', bridge }), new QrProvider({ network: 'regtest', qr: { bridge: new QrBridge() } })],
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

  it('lists "Coldcard by NFC" where the phone has NFC, and says why where it has none', async () => {
    const options = await svc.getHardwareOptions();
    expect(options.find((o) => o.kind === 'coldcard-nfc')).toMatchObject({ name: 'Coldcard by NFC', available: true });
    cc.tag.supported = false;
    cc.tag.unavailableReason = 'This phone has no NFC.';
    expect((await svc.getHardwareOptions()).find((o) => o.kind === 'coldcard-nfc')).toMatchObject({ available: false, unavailableDetail: 'This phone has no NFC.' });
    cc.tag.supported = true;
    cc.tag.unavailableReason = undefined;
  });

  it('connects as the Coldcard the owner picked, by reading its key export over NFC', async () => {
    const hw = await svc.connectHardware('coldcard-nfc', 'coldcard-mk4');
    expect(hw).toEqual({ kind: 'coldcard-nfc', brand: 'Coldcard Mk4', model: 'Coldcard Mk4', qrModel: 'coldcard-mk4' });
    expect(owner.requests.map((r) => r.title)).toEqual(['Connect your Coldcard Mk4']);
  });

  it('pairs with the guardian: the Coldcard signs the pairing text over NFC, the phone checks it, then the wallet is registered', async () => {
    await svc.pairGuardian(rig.pairingUri());
    await svc.setUpRules(100_000, 7);
    expect(svc.getState().onboarded || svc.wallet!.state.stage === 'paired').toBe(true);
    expect(svc.wallet!.state.hardware).toMatchObject({ kind: 'coldcard-nfc', qrModel: 'coldcard-mk4' });
    const message = owner.requests.find((r): r is NfcWriteRequest => r.type === 'write' && r.purpose === 'message')!;
    expect(new TextDecoder().decode(message.message)).toMatch(/signmessage m\/48h\/1h\/0h\/2h\/0\/0 ascii:Trikey pair v1 wallet=[0-9a-f]{16} guardian=0[23][0-9a-f]{64}$/);
    expect(message.title).toBe('Sign on your Coldcard Mk4');
    expect(cc.signedTexts).toEqual([expect.stringMatching(/^Trikey pair v1 /)]);
    // After the signature: the wallet goes onto the Coldcard, and the first address is compared on it.
    expect(cc.wallets).toHaveLength(1);
    expect(cc.wallets[0]).toMatch(/Policy: 2 of 3/);
    expect(owner.requests.map((r) => `${r.type}:${r.purpose}`)).toEqual(expect.arrayContaining(['write:message', 'read:signed-message', 'write:wallet', 'show:wallet', 'show:address']));
    expect(svc.getState().hardware).toMatchObject({ kind: 'coldcard-nfc', brand: 'Coldcard Mk4' });
  });

  it('notes on the guardian: the same text twice over NFC', async () => {
    expect(svc.notes!.state()).toMatchObject({ available: true, on: false });
    const before = owner.requests.length;
    await svc.notes!.enable();
    const rounds = owner.requests.slice(before).filter((r) => r.type === 'write' && r.purpose === 'message');
    expect(rounds.map((r) => r.title)).toEqual(['Sign on your Coldcard Mk4 (1 of 2)', 'Sign on your Coldcard Mk4 (2 of 2)']);
    expect(svc.notes!.state()).toMatchObject({ on: true });
    await svc.notes!.disable();
  });

  it('co-signs a payment over the daily limit: the PSBT goes to the Coldcard over NFC and comes back signed', async () => {
    rig.fund(svc.wallet!.multisig().derive(0, 0).script, 500_000n);
    await svc.sync();
    await svc.idle();
    const q = svc.quoteSend({ address: externalAddress(), amountSats: 120_000, speed: 'normal' });
    if (!q.ok) throw new Error(q.message);
    expect(q.quote.plan).toEqual({ signer: 'hardware', reason: 'over-limit' });
    const before = owner.requests.length;
    const tx = await svc.sendPayment(q.quote);
    expect(tx).toMatchObject({ amountSats: 120_000, signedBy: 'phone+hardware' });
    expect(owner.requests.slice(before).map((r) => `${r.type}:${r.purpose}`)).toEqual(['write:psbt', 'read:signed-psbt']);
    expect(cc.signedPsbts).toHaveLength(1);
    expect(cc.stories).toEqual([]);
    expect(rig.electrs.broadcasts.length).toBeGreaterThanOrEqual(1);
  });
});
