/**
 * A Coldcard over NFC, end to end in the app's hardware layer: the NFC provider and signer, the bridge the screen drives,
 * and a fake Coldcard behind a fake tag (../test/fake-coldcard-nfc.ts: the firmware's NDEF maker and parser, ported).
 * Covers connecting (the key export), registering the wallet, a PSBT round trip (partly signed and finalized), message
 * signing with every check (good, another key, another text, garbage, Trikey's own request), and what the phone says
 * when NFC is missing, off, or the phone moved away.
 */
import { describe, expect, it } from 'vitest';
import { base64 } from '@scure/base';
import { parsePsbt } from '@trikey/core';
import { verifyBip137Message } from '@trikey/wallet';
import { MNEMONICS, hwSigner } from '../../../../../packages/core/test/helpers';
import { HARDENED, formatPath } from '../common/path';
import { parseWalletPolicy } from '../common/wallet';
import { coldcardMultisigConfig } from '../qr/registration';
import { FakeColdcard, playOwner } from '../test/fake-coldcard-nfc';
import { makeFixture, network } from '../test/fixtures';
import { NfcBridge, type NfcReadRequest, type NfcWriteRequest } from './bridge';
import { textRecord } from './ndef';
import { NfcProvider } from './provider';
import { NfcSigner } from './signer';
import { noNfc } from './transport';

const H = HARDENED;
const ACCOUNT = [48 + H, 1 + H, 0 + H, 2 + H];
const AUTH = "m/48'/1'/0'/2'/0/0";
const TEXT = `Trikey pair v1 wallet=0123456789abcdef guardian=03${'ab'.repeat(32)}`;
const tick = () => new Promise<void>((r) => setTimeout(r, 0));
const until = async (fn: () => boolean) => {
  for (let i = 0; i < 200 && !fn(); i++) await tick();
};

/** A Coldcard with the fixture's hardware seed, and a bridge on its tag. */
async function setup(opts: { owner?: boolean } = {}) {
  const f = await makeFixture();
  const cc = new FakeColdcard({ mnemonic: MNEMONICS.hardware });
  const bridge = new NfcBridge(cc.tag);
  const owner = opts.owner === false ? undefined : playOwner(bridge, cc);
  const signer = new NfcSigner(
    { kind: 'coldcard-nfc', model: 'Coldcard Mk4', fingerprint: f.hardwareFingerprint, qrModel: 'coldcard-mk4' },
    { network: 'regtest', bridge, model: 'coldcard-mk4', knownKeys: [{ path: ACCOUNT, xpub: f.hardwareXpub }] },
  );
  return { f, cc, bridge, owner, signer };
}

describe('NfcProvider', () => {
  it('connects by reading the Coldcard’s multisig export (account 0), as the model the owner picked', async () => {
    const cc = new FakeColdcard({ mnemonic: MNEMONICS.hardware });
    const bridge = new NfcBridge(cc.tag);
    const owner = playOwner(bridge, cc);
    const provider = new NfcProvider({ network: 'regtest', bridge });
    expect(provider.kinds).toEqual(['coldcard-nfc']);
    expect(await provider.isAvailable()).toBe(true);
    expect(await provider.unavailableReason()).toBeUndefined();
    const signer = await provider.connect({ kind: 'coldcard-nfc', qrModel: 'coldcard-mk4' });
    expect(signer.info).toEqual({ kind: 'coldcard-nfc', model: 'Coldcard Mk4', fingerprint: cc.fingerprint, qrModel: 'coldcard-mk4' });
    const r = owner.requests[0] as NfcReadRequest;
    expect(r).toMatchObject({ type: 'read', purpose: 'device-key', title: 'Connect your Coldcard Mk4', actionLabel: 'Read from the Coldcard' });
    expect(r.steps!.join(' ')).toMatch(/Settings › Multisig Wallets › Export XPUB.*account number 0.*press 3 to share over NFC/);
    expect(r.notes!.join(' ')).toMatch(/over the 8 key.*NFC Sharing/);
    // The account key is known from the export: asking for it reads nothing more.
    expect(await signer.getXpub("m/48'/1'/0'/2'")).toBe(await hwSigner().getKey(network).then((k) => k.xpub));
    expect(owner.requests).toHaveLength(1);
    // Another account (Savings is account 1) is read again, for that account.
    const savings = await signer.getXpub("m/48'/1'/1'/2'");
    expect(savings).toMatch(/^tpub/);
    expect((owner.requests[1] as NfcReadRequest).steps!.join(' ')).toMatch(/account number 1/);
    // A Coldcard Q: its NFC key; no model: both.
    expect(new NfcProvider({ network: 'regtest', bridge }).kinds).toEqual(['coldcard-nfc']);
  });

  it('connecting a Coldcard the wallet already knows reads nothing; its answers are still checked against the known keys', async () => {
    const f = await makeFixture();
    // In front of the phone: another Coldcard than the wallet's.
    const other = new FakeColdcard({ mnemonic: MNEMONICS.hardware2 });
    const bridge = new NfcBridge(other.tag);
    const owner = playOwner(bridge, other);
    const provider = new NfcProvider({ network: 'regtest', bridge });
    const signer = await provider.connect({ kind: 'coldcard-nfc', qrModel: 'coldcard-q', known: { fingerprint: f.hardwareFingerprint, account: { path: "m/48'/1'/0'/2'", xpub: f.hardwareXpub } } });
    expect(signer.info).toEqual({ kind: 'coldcard-nfc', model: 'Coldcard Q', fingerprint: f.hardwareFingerprint, qrModel: 'coldcard-q' });
    expect(owner.requests).toEqual([]);
    expect(await signer.getXpub("m/48'/1'/0'/2'")).toBe(f.hardwareXpub);
    // It signs the text with its own key: the phone refuses that signature.
    const p = signer.signMessage(AUTH, TEXT);
    await until(() => !!bridge.getSnapshot()?.hint);
    expect(bridge.getSnapshot()?.hint).toMatch(/another key|not from this wallet’s key/);
    expect((owner.requests[0] as NfcWriteRequest).steps!.join(' ')).toMatch(/NFC Tools › Sign Message/);
    bridge.cancel();
    await expect(p).rejects.toMatchObject({ code: 'cancelled' });
    // A malformed record is not trusted: the export is read.
    const again = provider.connect({ kind: 'coldcard-nfc', known: { fingerprint: 'nope' } });
    await expect(again).resolves.toMatchObject({ info: { fingerprint: other.fingerprint } });
  });

  it('a phone or build without NFC: not available, with the reason; connecting says it too', async () => {
    const bridge = new NfcBridge({ ...noNfc, unavailableReason: 'This iPhone build of Trikey has no NFC.' });
    const provider = new NfcProvider({ network: 'regtest', bridge });
    expect(await provider.isAvailable()).toBe(false);
    expect(await provider.unavailableReason()).toBe('This iPhone build of Trikey has no NFC.');
    await expect(provider.connect({ kind: 'coldcard-nfc' })).rejects.toMatchObject({ code: 'unavailable', message: 'This iPhone build of Trikey has no NFC.' });
    await expect(provider.connect({ kind: 'qr' })).rejects.toMatchObject({ code: 'invalid-request' });
    const ac = new AbortController();
    ac.abort();
    await expect(new NfcProvider({ network: 'regtest', bridge: new NfcBridge(new FakeColdcard({ mnemonic: MNEMONICS.hardware }).tag) }).connect({ signal: ac.signal })).rejects.toMatchObject({ code: 'cancelled' });
  });

  it('refuses an export from another device when the wallet asks for a key again (a hint; the screen stays)', async () => {
    const f = await makeFixture();
    // The owner holds the phone to another Coldcard than the wallet's.
    const other = new FakeColdcard({ mnemonic: MNEMONICS.hardware2 });
    const bridge = new NfcBridge(other.tag);
    const signer = new NfcSigner({ kind: 'coldcard-nfc', fingerprint: f.hardwareFingerprint }, { network: 'regtest', bridge });
    const p = signer.getXpub("m/48'/1'/1'/2'");
    await until(() => !!bridge.getSnapshot());
    expect((bridge.getSnapshot()!.request as NfcReadRequest).title).toBe("Read the key m/48'/1'/1'/2'");
    await other.shareMultisigExport(1);
    await bridge.tap();
    expect(bridge.getSnapshot()?.hint).toMatch(/different device \(master fingerprint \w{8}, not \w{8}\)/);
    bridge.cancel();
    await expect(p).rejects.toMatchObject({ code: 'cancelled' });
  });
});

describe('NfcSigner.registerWallet', () => {
  it('writes the Coldcard multisig setup file over NFC, then asks the owner to approve it on the device', async () => {
    const { f, cc, signer, owner } = await setup();
    expect(await signer.registerWallet(f.policy)).toEqual({});
    expect(cc.wallets).toEqual([coldcardMultisigConfig(parseWalletPolicy(f.policy))]);
    expect(owner!.requests.map((r) => `${r.type}:${r.purpose}`)).toEqual(['write:wallet', 'show:wallet']);
    expect((owner!.requests[0] as NfcWriteRequest).steps!.join(' ')).toMatch(/Settings › Multisig Wallets › Import, and choose NFC/);
    expect(owner!.requests[1]!.instructions).toMatch(/"Trikey test", "2 of 3"/);
  });

  it('refuses a wallet this Coldcard is not in, before anything is shown', async () => {
    const { f, owner } = await setup();
    const other = new NfcSigner({ kind: 'coldcard-nfc', fingerprint: 'deadbeef' }, { network: 'regtest', bridge: new NfcBridge(noNfc) });
    await expect(other.registerWallet(f.policy)).rejects.toMatchObject({ code: 'invalid-request', message: expect.stringMatching(/not part of the wallet/) });
    expect(owner!.requests).toEqual([]);
  });
});

describe('NfcSigner.signPsbt: the PSBT round trip', () => {
  it('writes the PSBT, the Coldcard signs, the phone reads the partly signed PSBT back and merges its signature', async () => {
    const { f, cc, signer, owner } = await setup();
    await signer.registerWallet(f.policy);
    const out = parsePsbt(base64.decode(await signer.signPsbt(f.psbtBase64, f.policy)));
    expect(out.getInput(0).partialSig).toHaveLength(1);
    expect(cc.signedPsbts).toEqual([f.psbt]);
    expect(cc.tag.log.map((l) => l.op)).toEqual(['write', 'write', 'read']);
    const [write, read] = owner!.requests.slice(2) as [NfcWriteRequest, NfcReadRequest];
    expect(write).toMatchObject({ type: 'write', purpose: 'psbt', title: 'Sign on your Coldcard Mk4', actionLabel: 'Send to the Coldcard' });
    expect(write.steps!.join(' ')).toMatch(/NFC Tools › Sign PSBT.*check the amount and the address/);
    expect(read).toMatchObject({ type: 'read', purpose: 'signed-psbt' });
  });

  it('takes the finished transaction when the Coldcard completed and finalized it (the phone signed first)', async () => {
    const { f, cc, signer } = await setup();
    await signer.registerWallet(f.policy);
    const out = parsePsbt(base64.decode(await signer.signPsbt(base64.encode(f.psbtAppSigned), f.policy)));
    expect(out.getInput(0).partialSig).toHaveLength(2);
    expect(cc.stories).toEqual([]);
  });

  it('a Coldcard without the wallet refuses ("Unknown multisig wallet"): the read finds nothing and says so', async () => {
    const { f, cc, signer, bridge } = await setup();
    const p = signer.signPsbt(f.psbtBase64, f.policy);
    await until(() => !!bridge.getSnapshot()?.hint);
    expect(cc.stories).toEqual(['Unknown multisig wallet']);
    expect(bridge.getSnapshot()).toMatchObject({ request: { purpose: 'signed-psbt' }, hint: expect.stringMatching(/stopped waiting for the Coldcard/) });
    bridge.cancel();
    await expect(p).rejects.toMatchObject({ code: 'cancelled' });
  });

  it('the phone moving away, and a damaged transfer (checksum), are hints; tapping again works', async () => {
    const { f, cc, signer, bridge, owner } = await setup();
    await signer.registerWallet(f.policy);
    owner!.state.pause = true;
    const p = signer.signPsbt(f.psbtBase64, f.policy);
    await until(() => bridge.getSnapshot()?.request.purpose === 'psbt');
    cc.signPsbtOverNfc();
    cc.tag.loseNext = true;
    await bridge.tap();
    expect(bridge.getSnapshot()).toMatchObject({ request: { purpose: 'psbt' }, hint: expect.stringMatching(/lost the Coldcard/) });
    await bridge.tap();
    await until(() => bridge.getSnapshot()?.request.purpose === 'signed-psbt');
    cc.tag.corruptNextRead = true;
    await bridge.tap();
    expect(bridge.getSnapshot()).toMatchObject({ request: { purpose: 'signed-psbt' }, hint: expect.stringMatching(/did not arrive whole/) });
    await bridge.tap();
    const out = parsePsbt(base64.decode(await p));
    expect(out.getInput(0).partialSig).toHaveLength(1);
  });

  it('refuses a PSBT that is not this Coldcard’s, before anything is shown', async () => {
    const { f, owner } = await setup();
    const other = new NfcSigner({ kind: 'coldcard-nfc', fingerprint: 'deadbeef' }, { network: 'regtest', bridge: new NfcBridge(noNfc) });
    await expect(other.signPsbt(f.psbtBase64, f.policy)).rejects.toMatchObject({ code: 'invalid-request' });
    expect(owner!.requests).toEqual([]);
  });
});

describe('NfcSigner.signMessage', () => {
  it('writes `signmessage <path> ascii:<text>`, reads the armored block, and checks it against the key at the path', async () => {
    const { signer, owner, cc } = await setup();
    const sig = await signer.signMessage(AUTH, TEXT, { purpose: 'pairing' });
    expect(verifyBip137Message(TEXT, hwSigner().master(network).derive(AUTH).publicKey!, sig)).toBe(true);
    expect(cc.signedTexts).toEqual([TEXT]);
    const [write, read] = owner!.requests as [NfcWriteRequest, NfcReadRequest];
    expect(new TextDecoder().decode(write.message)).toContain(`signmessage m/48h/1h/0h/2h/0/0 ascii:${TEXT}`);
    expect(write).toMatchObject({ purpose: 'message', title: 'Sign on your Coldcard Mk4', detail: TEXT });
    expect(write.steps!.join(' ')).toMatch(/NFC Tools › Sign Message/);
    const notes = write.notes!.join(' ');
    expect(notes).toMatch(/proves to your guardian/);
    expect(notes).toMatch(/path m\/48'\/1'\/0'\/2'\/0\/0 and this address for the key: [mn]\w+/);
    expect(read).toMatchObject({ purpose: 'signed-message', title: 'Read the signature' });
  });

  it('the same text twice (notes, unlock) says which round it is', async () => {
    const { signer, owner } = await setup();
    await signer.signMessage(AUTH, TEXT, { purpose: 'notes', round: { n: 1, of: 2 } });
    await signer.signMessage(AUTH, TEXT, { purpose: 'notes', round: { n: 2, of: 2 } });
    const writes = owner!.requests.filter((r) => r.type === 'write');
    expect(writes.map((r) => r.title)).toEqual(['Sign on your Coldcard Mk4 (1 of 2)', 'Sign on your Coldcard Mk4 (2 of 2)']);
    expect(writes[0]!.notes!.join(' ')).toMatch(/same text twice/);
  });

  it.each([
    ['message-key', /signed with another key|not from this wallet’s key/],
    ['message-text', /signed a different text/],
    ['message-garbage', /holds no signature/],
  ] as const)('%s: a hint, never a signature', async (tamper, hint) => {
    const { signer, bridge, cc } = await setup();
    cc.tamper = tamper;
    const p = signer.signMessage(AUTH, TEXT);
    await until(() => !!bridge.getSnapshot()?.hint);
    expect(bridge.getSnapshot()).toMatchObject({ request: { purpose: 'signed-message' }, hint: expect.stringMatching(hint) });
    bridge.cancel();
    await expect(p).rejects.toMatchObject({ code: 'cancelled' });
  });

  it('garbage, or Trikey’s own request, on the tag: hints', async () => {
    const { signer, bridge, cc, owner } = await setup();
    owner!.state.pause = true;
    const p = signer.signMessage(AUTH, TEXT);
    await until(() => bridge.getSnapshot()?.request.type === 'write');
    cc.signMessageOverNfc();
    await bridge.tap();
    await until(() => bridge.getSnapshot()?.request.type === 'read');
    const shareText = (t: string) => {
      const records = [textRecord(t)];
      cc.tag.read = async () => records;
    };
    shareText('hello');
    await bridge.tap();
    expect(bridge.getSnapshot()?.hint).toMatch(/not a message signature/);
    shareText(`signmessage m/48h/1h/0h/2h/0/0 ascii:${TEXT}`);
    await bridge.tap();
    expect(bridge.getSnapshot()?.hint).toMatch(/still Trikey’s request/);
    bridge.cancel();
    await expect(p).rejects.toMatchObject({ code: 'cancelled' });
  });

  it('refuses a text the Coldcard would refuse, before anything is shown', async () => {
    const { signer, owner } = await setup();
    await expect(signer.signMessage(AUTH, 'a'.repeat(241))).rejects.toMatchObject({ code: 'invalid-request', message: expect.stringMatching(/at most 240/) });
    await expect(signer.signMessage(AUTH, 'two   spaces three')).rejects.toMatchObject({ message: expect.stringMatching(/three spaces/) });
    await expect(signer.signMessage("m/48'", TEXT)).rejects.toMatchObject({ message: expect.stringMatching(/below an account key/) });
    expect(owner!.requests).toEqual([]);
  });
});

describe('NfcSigner.displayAddress', () => {
  it('derives the address and asks the owner to compare it in the Coldcard’s Address Explorer', async () => {
    const { f, signer, owner } = await setup();
    expect(await signer.displayAddress(f.policy, 0, 0)).toBe(f.wallet.derive(0, 0).address);
    expect(owner!.requests[0]).toMatchObject({ type: 'show', purpose: 'address', detail: f.wallet.derive(0, 0).address });
    expect(owner!.requests[0]!.instructions).toMatch(/Address Explorer, pick the wallet "Trikey test".*receive address 0/);
  });
});

describe('NfcBridge: NFC off, cancel, abort', () => {
  it('NFC switched off: the tap says so and offers the settings; turned on, the same tap works', async () => {
    const { signer, bridge, cc, owner } = await setup();
    owner!.state.pause = true;
    cc.tag.enabled = false;
    const p = signer.getXpub("m/48'/1'/1'/2'");
    await until(() => !!bridge.getSnapshot());
    await bridge.tap();
    expect(bridge.getSnapshot()).toMatchObject({ nfcOff: true, hint: expect.stringMatching(/NFC is turned off on this phone/) });
    expect(await bridge.openSettings()).toBe(true);
    cc.tag.enabled = true;
    await cc.shareMultisigExport(1);
    await bridge.tap();
    expect(await p).toMatch(/^tpub/);
  });

  it('one request at a time; cancel and an aborted signal reject with `cancelled`, queued or active', async () => {
    const bridge = new NfcBridge(noNfc);
    const ac = new AbortController();
    const first = bridge.show({ purpose: 'address', title: 'a', instructions: '', continueLabel: 'ok' });
    const second = bridge.show({ purpose: 'address', title: 'b', instructions: '', continueLabel: 'ok' }, ac.signal);
    const third = bridge.show({ purpose: 'address', title: 'c', instructions: '', continueLabel: 'ok' });
    expect(bridge.getSnapshot()?.request.title).toBe('a');
    ac.abort();
    await expect(second).rejects.toMatchObject({ code: 'cancelled' });
    bridge.finishShow();
    await first;
    expect(bridge.getSnapshot()?.request.title).toBe('c');
    bridge.cancel();
    await expect(third).rejects.toMatchObject({ code: 'cancelled' });
    expect(bridge.getSnapshot()).toBeUndefined();
    const pre = new AbortController();
    pre.abort();
    await expect(bridge.show({ purpose: 'address', title: 'd', instructions: '', continueLabel: 'ok' }, pre.signal)).rejects.toMatchObject({ code: 'cancelled' });
  });

  it('a phone without NFC: the tap says why', async () => {
    const bridge = new NfcBridge({ ...noNfc, unavailableReason: 'No NFC here.' });
    const p = bridge.read({ purpose: 'device-key', title: 't', instructions: '', actionLabel: 'Read', alert: 'x', accept: () => 1 });
    await bridge.tap();
    expect(bridge.getSnapshot()).toMatchObject({ nfcOff: false, hint: 'No NFC here.' });
    bridge.cancel();
    await expect(p).rejects.toMatchObject({ code: 'cancelled' });
    expect(formatPath(ACCOUNT)).toBe("m/48'/1'/0'/2'");
  });
});
