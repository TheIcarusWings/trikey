/**
 * A QR hardware wallet that signs Trikey's texts, in the app: the real wallet service, the real guardian in-process
 * (regtest, throwaway keys), and the app's real QR provider and signer, with the QR screens played by a fake Coldcard Q
 * that reads what the phone shows and answers as the firmware does (docs/design/hardware-auth-path.md, "QR devices"):
 *
 * - connect: the owner picks "Coldcard Q"; the phone scans its BBQr key export;
 * - pairing in guardian mode: the device scans `signmessage m/48h/1h/0h/2h/0/0 ascii:Trikey pair v1 ...`, signs, and the
 *   phone scans the signature (Coldcard's armored block, address included), checks it, then registers the wallet and
 *   compares the first address;
 * - notes: two rounds of the same text, each screen saying which round it is;
 * - a model that signs no text (SeedSigner) cannot pair: the reason is said before anything is signed;
 * - Settings, "Hardware wallet model": back to "Other" turns notes off, and a known model turns them back on.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HDKey } from '@scure/bip32';
import { NETWORKS } from '@trikey/core';
import { GuardianRig } from '@trikey/guardian/testing';
import { MemoryCloudBackupStore, MemoryKeyValueStore, MemoryPasskeyPrf, MemorySecureKeyStore, SoftwareHardwareSigner } from '@trikey/wallet/testing';
import { encodeBbqr } from '../hardware/qr/bbqr';
import { QrBridge, type QrScanRequest, type QrShowRequest } from '../hardware/qr/bridge';
import { messageAddresses } from '../hardware/qr/message';
import { QrProvider } from '../hardware/qr/provider';
import { createRealWalletService, type RealWalletService } from './real';

const MNEMONIC = 'legal winner thank year wave sausage worth useful legal winner thank yellow';
const OTHER = 'zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo wrong';
const ACCOUNT = "m/48'/1'/0'/2'";

/**
 * Plays a Coldcard Q in front of the phone's camera: answers the phone's QR screens the way its firmware does. The
 * signing key is a software one (`SoftwareHardwareSigner`); everything between it and the wallet is the app's own code.
 */
class FakeColdcardQ {
  readonly shown: QrShowRequest[] = [];
  readonly scans: QrScanRequest[] = [];
  readonly signed: string[] = [];
  private answer?: string;
  private readonly seen = new WeakSet<object>();
  readonly device: SoftwareHardwareSigner;

  constructor(
    readonly bridge: QrBridge,
    mnemonic = MNEMONIC,
  ) {
    this.device = new SoftwareHardwareSigner({ mnemonic, network: 'regtest', kind: 'qr', requireRegistration: false });
    bridge.subscribe(() => this.tick());
  }

  private tick() {
    const snap = this.bridge.getSnapshot();
    if (!snap || this.seen.has(snap.request)) return;
    this.seen.add(snap.request);
    queueMicrotask(() => void this.answerRequest(snap.request.type === 'show' ? snap.request : (snap.request as QrScanRequest)));
  }

  private async answerRequest(r: QrShowRequest | QrScanRequest) {
    if (r.type === 'show') {
      this.shown.push(r);
      if (r.purpose === 'message') {
        // The Coldcard reads the line, shows the text and the path, and signs with the key at that path.
        const m = /^signmessage (\S+) ascii:(.*)$/.exec(r.frames[0]!);
        if (!m) throw new Error(`not a signmessage QR: ${r.frames[0]}`);
        const sig = await this.device.signMessage(m[1]!.replace(/h/g, "'"), m[2]!);
        this.signed.push(m[2]!);
        // It prints the legacy address of that key next to the signature.
        const pub = HDKey.fromExtendedKey(await this.device.getXpub(ACCOUNT), NETWORKS.regtest.bip32).derive('m/0/0').publicKey!;
        const address = messageAddresses(pub, 'regtest').p2pkh;
        this.answer = `-----BEGIN BITCOIN SIGNED MESSAGE-----\n${m[2]}\n-----BEGIN BITCOIN SIGNATURE-----\n${address}\n${sig}\n-----END BITCOIN SIGNATURE-----\n`;
      }
      this.bridge.finishShow();
      return;
    }
    this.scans.push(r);
    if (r.purpose === 'device-key') {
      const xpub = await this.device.getXpub(ACCOUNT);
      const json = JSON.stringify({ xfp: this.device.info.fingerprint.toUpperCase(), p2wsh_deriv: ACCOUNT, p2wsh: xpub });
      for (const frame of encodeBbqr(new TextEncoder().encode(json), 'J')) this.bridge.submitFrame(frame);
    } else if (r.purpose === 'signed-message') {
      this.bridge.submitFrame(this.answer!);
    } else this.bridge.cancel();
  }
}

let rig: GuardianRig;
const rigs: GuardianRig[] = [];
const opened: RealWalletService[] = [];

async function phone(bridge: QrBridge, on: GuardianRig = rig) {
  const svc = await createRealWalletService({
    mode: 'real',
    platform: { os: 'ios', isSecure: true, secureKeys: new MemorySecureKeyStore(), kv: new MemoryKeyValueStore(), cloudBackups: [new MemoryCloudBackupStore()], passkeys: Object.assign(new MemoryPasskeyPrf(), { supported: false }) },
    hardware: () => [new QrProvider({ network: 'regtest', qr: { bridge } })],
    clock: on.clock,
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
  return svc;
}

beforeAll(async () => {
  rig = await GuardianRig.start();
}, 30_000);

afterAll(async () => {
  for (const s of opened) await s.close();
  for (const r of [rig, ...rigs]) await r?.stop();
});

describe('a Coldcard Q over QR codes, in the app', { timeout: 120_000 }, () => {
  const bridge = new QrBridge();
  const cc = new FakeColdcardQ(bridge);
  let svc: RealWalletService;

  it('connects as the model the owner picked', async () => {
    svc = await phone(bridge);
    const hw = await svc.connectHardware('qr', 'coldcard-q');
    expect(hw).toEqual({ kind: 'qr', brand: 'Coldcard Q', model: 'Coldcard Q', qrModel: 'coldcard-q' });
    expect(cc.scans.map((s) => s.title)).toEqual(['Connect your Coldcard Q']);
  });

  it('pairs with the guardian: the device signs the pairing text by QR, the phone checks it, then the wallet is registered', async () => {
    await svc.pairGuardian(rig.pairingUri());
    await svc.setUpRules(100_000, 7);
    expect(svc.getState().onboarded || svc.wallet!.state.stage === 'paired').toBe(true);
    expect(svc.wallet!.state.hardware).toMatchObject({ kind: 'qr', qrModel: 'coldcard-q' });
    const message = cc.shown.find((r) => r.purpose === 'message')!;
    expect(message.frames[0]).toMatch(/^signmessage m\/48h\/1h\/0h\/2h\/0\/0 ascii:Trikey pair v1 wallet=[0-9a-f]{16} guardian=0[23][0-9a-f]{64}$/);
    expect(message.title).toBe('Sign on your Coldcard Q');
    expect(message.notes!.join(' ')).toMatch(/proves to your guardian/);
    // Then the rules the wallet starts with (seq=0), which the device shows, with a note that says what to check.
    expect(cc.signed).toEqual([expect.stringMatching(/^Trikey pair v1 /), expect.stringMatching(/^Trikey policy v1 wallet=[0-9a-f]{16} seq=0 limit=100000 delay=7d feecap=\d+ contacts=\d+ hash=[0-9a-f]{64} expires=\S+Z$/)]);
    expect(cc.shown.filter((r) => r.purpose === 'message')[1]!.notes!.join(' ')).toMatch(/rules your wallet starts with/);
    // After the signature: the wallet goes onto the device, and the first address is compared.
    expect(cc.shown.map((r) => r.purpose)).toEqual(expect.arrayContaining(['message', 'wallet', 'address']));
  });

  it('notes on the guardian: the same text twice, each screen saying which round', async () => {
    expect(svc.notes!.state()).toMatchObject({ available: true, on: false });
    const before = cc.shown.length;
    await svc.notes!.enable();
    const rounds = cc.shown.slice(before).filter((r) => r.purpose === 'message');
    expect(rounds.map((r) => r.title)).toEqual(['Sign on your Coldcard Q (1 of 2)', 'Sign on your Coldcard Q (2 of 2)']);
    expect(rounds[0]!.notes!.join(' ')).toMatch(/will show the same text twice/);
    expect(new Set(rounds.map((r) => r.detail))).toEqual(new Set([expect.stringMatching(/^Trikey labels key v1 /)]));
    expect(svc.notes!.state()).toMatchObject({ on: true });
    await svc.notes!.disable();
  });

  it('Settings, "Hardware wallet model": "Other" signs no text, so notes are not offered; the right model brings them back', async () => {
    await svc.setHardwareModel!('other');
    expect(svc.getState().hardware).toMatchObject({ kind: 'qr', qrModel: 'other' });
    expect(svc.notes!.state()).toMatchObject({ available: false, unavailable: 'hardware', unavailableText: expect.stringMatching(/Hardware wallet model/) });
    await svc.setHardwareModel!('coldcard-q');
    expect(svc.getState().hardware).toMatchObject({ brand: 'Coldcard Q', qrModel: 'coldcard-q' });
    expect(svc.notes!.state()).toMatchObject({ available: true });
  });
});

describe('a QR model that signs no text', { timeout: 60_000 }, () => {
  it('SeedSigner co-signs payments but cannot pair a guardian: the reason is said, nothing is signed', async () => {
    // A guardian of its own: the first one is paired already.
    const own = await GuardianRig.start();
    rigs.push(own);
    const bridge = new QrBridge();
    const device = new FakeColdcardQ(bridge, OTHER);
    const svc = await phone(bridge, own);
    await svc.connectHardware('qr', 'seedsigner');
    expect(svc.getState().hardware).toMatchObject({ brand: 'SeedSigner', qrModel: 'seedsigner' });
    await svc.pairGuardian(own.pairingUri());
    const err = await svc.setUpRules(100_000, 7).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toMatchObject({ message: expect.stringMatching(/SeedSigner doesn.t sign messages with a multisig key/) });
    expect(device.shown.filter((r) => r.purpose === 'message')).toEqual([]);
    expect(device.signed).toEqual([]);
  });
});
