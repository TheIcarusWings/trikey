/**
 * A hardware wallet that signs Trikey's texts from a microSD card, in the app: the real wallet service, the real
 * guardian in-process (regtest, throwaway keys), and the app's real QR provider and signer, with the file screens played
 * by a fake Passport (2nd generation) and a mocked file saver and picker standing in for the phone's (a "card" in
 * memory). The fake reads the request file the way its firmware does (2 lines: text, path; legacy address type), signs
 * with the key at the path, and writes `<name>-signed-001.txt` next to it (docs/design/hardware-auth-path.md §7):
 *
 * - connect: the owner picks "Passport (2nd generation)"; the phone scans its key export;
 * - pairing in guardian mode: the phone hands over `trikey-pair.txt`, the device signs it, the owner picks the signed
 *   file; a wrong file first (Trikey's own request) stays a hint;
 * - notes: two rounds, two files (`trikey-notes-1of2.txt`, `trikey-notes-2of2.txt`), each screen saying which round;
 * - hardware unlock is not offered: the reason (a card round trip per restart; the passphrase works) is said.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HDKey } from '@scure/bip32';
import { NETWORKS } from '@trikey/core';
import { GuardianRig } from '@trikey/guardian/testing';
import { MemoryCloudBackupStore, MemoryKeyValueStore, MemoryPasskeyPrf, MemorySecureKeyStore, SoftwareHardwareSigner } from '@trikey/wallet/testing';
import { QrBridge, type DeviceFile, type DeviceFileIo, type QrFileRequest, type QrRequest } from '../hardware/qr/bridge';
import { messageAddresses } from '../hardware/qr/message';
import { QrProvider } from '../hardware/qr/provider';
import { HARDWARE_UNLOCK_UNAVAILABLE } from './hardware-unlock-actions';
import { createRealWalletService, type RealWalletService } from './real';

const MNEMONIC = 'legal winner thank year wave sausage worth useful legal winner thank yellow';
const ACCOUNT = "m/48'/1'/0'/2'";

/** The phone's file saver and picker, mocked: "saving" puts the file on the card, "picking" returns what the test says. */
class FakeCard implements DeviceFileIo {
  readonly files = new Map<string, string>();
  readonly saved: string[] = [];
  /** What the owner picks next (the test sets it; by default the newest signed file). */
  next?: DeviceFile;

  async saveToFolder(name: string, text: string): Promise<boolean> {
    this.files.set(name, text);
    this.saved.push(name);
    return true;
  }

  async share(name: string, text: string): Promise<void> {
    await this.saveToFolder(name, text);
  }

  async pick(): Promise<DeviceFile | null> {
    const chosen = this.next;
    this.next = undefined;
    if (chosen) return chosen;
    const signed = [...this.files.keys()].filter((n) => n.includes('-signed-')).at(-1);
    return signed ? { name: signed, bytes: new TextEncoder().encode(this.files.get(signed)!) } : null;
  }
}

/**
 * Plays a Passport gen 2 with its microSD card: answers the phone's QR and file screens the way its firmware does
 * (flows/health_check_microsd_flow.py, health_check_common_flow.py). The key is a software one; everything between it
 * and the wallet is the app's own code.
 */
class FakePassport {
  readonly requests: QrFileRequest[] = [];
  readonly shown: QrRequest[] = [];
  readonly signed: string[] = [];
  readonly hints: Array<string | undefined> = [];
  /** Pick Trikey's own request file first, once (a mistake the phone must catch). */
  pickRequestFirst = false;
  private readonly seen = new WeakSet<object>();
  readonly device: SoftwareHardwareSigner;

  constructor(
    readonly bridge: QrBridge,
    readonly card: FakeCard,
  ) {
    this.device = new SoftwareHardwareSigner({ mnemonic: MNEMONIC, network: 'regtest', kind: 'qr', requireRegistration: false });
    bridge.subscribe(() => this.tick());
  }

  private tick() {
    const snap = this.bridge.getSnapshot();
    if (!snap || this.seen.has(snap.request)) return;
    this.seen.add(snap.request);
    queueMicrotask(() => void this.answer(snap.request));
  }

  /** Account Tools > Sign a Message > Sign with microSD: reads the file, signs, writes `<name>-signed-001.<ext>`. */
  private async signFromCard(name: string) {
    const data = this.card.files.get(name)!;
    const lines = data.split('\n').filter((l, i, all) => !(i === all.length - 1 && l === ''));
    if (lines.length !== 2) throw new Error(`Passport: format is invalid (${lines.length} lines)`);
    const [text, subpath] = lines as [string, string];
    const sig = await this.device.signMessage(subpath.replace(/h/g, "'"), text);
    this.signed.push(text);
    const pub = HDKey.fromExtendedKey(await this.device.getXpub(ACCOUNT), NETWORKS.regtest.bip32).derive('m/0/0').publicKey!;
    const address = messageAddresses(pub, 'regtest').p2pkh;
    const [base, ext] = [name.slice(0, name.lastIndexOf('.')), name.slice(name.lastIndexOf('.'))];
    this.card.files.set(`${base}-signed-001${ext}`, `-----BEGIN BITCOIN SIGNED MESSAGE-----\n${text}\n-----BEGIN BITCOIN SIGNATURE-----\n${address}\n${sig}\n-----END BITCOIN SIGNATURE-----\n`);
  }

  private async answer(r: QrRequest) {
    this.shown.push(r);
    if (r.type === 'show') return this.bridge.finishShow();
    if (r.type === 'scan') {
      if (r.purpose !== 'device-key') return this.bridge.cancel();
      const xpub = await this.device.getXpub(ACCOUNT);
      this.bridge.submitFrame(JSON.stringify({ xfp: this.device.info.fingerprint.toUpperCase(), p2wsh_deriv: ACCOUNT, p2wsh: xpub }));
      return;
    }
    // The microSD round trip: save to the card, sign on the device, pick the signed file.
    this.requests.push(r);
    await this.bridge.saveFile(this.card);
    await this.signFromCard(r.file.name);
    if (this.pickRequestFirst) {
      this.pickRequestFirst = false;
      this.card.next = { name: r.file.name, bytes: new TextEncoder().encode(this.card.files.get(r.file.name)!) };
      this.hints.push((await this.bridge.pickFile(this.card)).hint);
    }
    await this.bridge.pickFile(this.card);
  }
}

let rig: GuardianRig;
const opened: RealWalletService[] = [];

async function phone(bridge: QrBridge) {
  const svc = await createRealWalletService({
    mode: 'real',
    platform: { os: 'android', isSecure: true, secureKeys: new MemorySecureKeyStore(), kv: new MemoryKeyValueStore(), cloudBackups: [new MemoryCloudBackupStore()], passkeys: Object.assign(new MemoryPasskeyPrf(), { supported: false }) },
    hardware: () => [new QrProvider({ network: 'regtest', qr: { bridge } })],
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
  return svc;
}

beforeAll(async () => {
  rig = await GuardianRig.start();
}, 30_000);

afterAll(async () => {
  for (const s of opened) await s.close();
  await rig?.stop();
});

describe('a Passport (2nd generation) signing from its microSD card, in the app', { timeout: 120_000 }, () => {
  const bridge = new QrBridge();
  const card = new FakeCard();
  const passport = new FakePassport(bridge, card);
  let svc: RealWalletService;

  it('connects as the model the owner picked', async () => {
    svc = await phone(bridge);
    const hw = await svc.connectHardware('qr', 'passport');
    expect(hw).toEqual({ kind: 'qr', brand: 'Passport (2nd generation)', model: 'Passport (2nd generation)', qrModel: 'passport' });
  });

  it('pairs with the guardian: the request file goes to the card, the device signs it, the signed file comes back and is checked', async () => {
    passport.pickRequestFirst = true;
    await svc.pairGuardian(rig.pairingUri());
    await svc.setUpRules(100_000, 7);
    expect(svc.wallet!.state.stage).toBe('paired');
    expect(svc.wallet!.state.hardware).toMatchObject({ kind: 'qr', qrModel: 'passport' });
    const pair = passport.requests[0]!;
    expect(pair).toMatchObject({ purpose: 'message-file', title: 'Sign on your Passport (2nd generation)', file: { name: 'trikey-pair.txt' } });
    expect(card.files.get('trikey-pair.txt')).toMatch(/^Trikey pair v1 wallet=[0-9a-f]{16} guardian=0[23][0-9a-f]{64}\nm\/48h\/1h\/0h\/2h\/0\/0\n$/);
    expect(card.files.has('trikey-pair-signed-001.txt')).toBe(true);
    expect(pair.notes!.join(' ')).toMatch(/proves to your guardian/);
    // Picking Trikey's own file first was caught, and the owner could pick again.
    expect(passport.hints[0]).toMatch(/the file Trikey made \(the request\)/);
    // Then the rules the wallet starts with (seq=0), in a file of its own, which the device shows.
    expect(passport.signed).toEqual([expect.stringMatching(/^Trikey pair v1 /), expect.stringMatching(/^Trikey policy v1 wallet=[0-9a-f]{16} seq=0 limit=100000 delay=7d feecap=\d+ contacts=\d+ hash=[0-9a-f]{64} expires=\S+Z$/)]);
    expect(card.files.get('trikey-rules.txt')).toMatch(/^Trikey policy v1 wallet=[0-9a-f]{16} seq=0 /);
    expect(passport.requests[1]!.notes!.join(' ')).toMatch(/rules your wallet starts with/);
    // The wallet goes onto the device and the first address is compared, by QR as for any QR device.
    expect(passport.shown.map((r) => r.purpose)).toEqual(['device-key', 'message-file', 'wallet', 'message-file', 'address']);
  });

  it('notes on the guardian: two files, one per round, each screen saying which round', async () => {
    expect(svc.notes!.state()).toMatchObject({ available: true, on: false });
    const before = passport.requests.length;
    await svc.notes!.enable();
    const rounds = passport.requests.slice(before);
    expect(rounds.map((r) => [r.title, r.file.name])).toEqual([
      ['Sign on your Passport (2nd generation) (1 of 2)', 'trikey-notes-1of2.txt'],
      ['Sign on your Passport (2nd generation) (2 of 2)', 'trikey-notes-2of2.txt'],
    ]);
    expect(card.saved.slice(-2)).toEqual(['trikey-notes-1of2.txt', 'trikey-notes-2of2.txt']);
    expect(new Set(rounds.map((r) => r.detail))).toEqual(new Set([expect.stringMatching(/^Trikey labels key v1 /)]));
    expect(svc.notes!.state()).toMatchObject({ on: true });
    await svc.notes!.disable();
  });

  it('hardware unlock is not offered: the reason says the card round trip and that the passphrase works', async () => {
    const state = svc.hardwareUnlock!.state();
    expect(state).toMatchObject({ available: false, on: false, unavailable: 'microsd' });
    expect(state!.unavailableText).toBe(HARDWARE_UNLOCK_UNAVAILABLE.microsd);
    expect(state!.unavailableText).toMatch(/microSD card.*passphrase unlocks your guardian/);
    const n = passport.requests.length;
    await expect(svc.hardwareUnlock!.enable()).rejects.toMatchObject({ message: expect.stringMatching(/Passport signs Trikey.s texts only from a microSD card.*passphrase/) });
    expect(passport.requests.length).toBe(n);
  });
});
