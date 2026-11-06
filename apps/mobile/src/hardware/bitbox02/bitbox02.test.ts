/**
 * A BitBox02, end to end in the app's hardware layer: the provider and signer, the bridge the screen drives, and a fake
 * BitBox02 (../test/fake-bitbox02.ts, written from the firmware) behind a fake USB or Bluetooth link. Covers connecting
 * (version, setup, unlock, the Noise pairing code over USB and none over Bluetooth, a rejected pairing, an encrypted
 * channel that breaks), the wallet (registration once, an address checked against the phone's), payments (the whole
 * signing flow with previous transactions and anti-klepto; a signature that does not verify, a device that ignores the
 * anti-klepto nonce, a missing signature, a foreign input), and Trikey's texts (anti-klepto for approvals, deterministic
 * for notes and unlock; another key, another text).
 */
import { describe, expect, it } from 'vitest';
import { base64 } from '@scure/base';
import { parsePsbt } from '@trikey/core';
import { verifyBip137Message } from '@trikey/wallet';
import { MNEMONICS, hwSigner } from '../../../../../packages/core/test/helpers';
import { HARDENED } from '../common/path';
import { describeHardwareError } from '../errors';
import { FakeBitBox02, type FakeBitBoxOptions } from '../test/fake-bitbox02';
import { makeFixture, network } from '../test/fixtures';
import { BitBoxBridge, type BitBoxBridgeScreen } from './bridge';
import { BitBox02Provider } from './provider';
import { deserializePairing, memoryPairingStore, serializePairing, type BitBoxPairingStore } from './session';
import { BitBoxSigner, bitboxCoin, bitboxWalletName } from './signer';

const H = HARDENED;
const AUTH = "m/48'/1'/0'/2'/0/0";
const TEXT = `Trikey pair v1 wallet=0123456789abcdef guardian=03${'ab'.repeat(32)}`;
const noWait = { sleep: async () => {} };

function watch(bridge: BitBoxBridge): BitBoxBridgeScreen[] {
  const screens: BitBoxBridgeScreen[] = [];
  bridge.subscribe(() => {
    const s = bridge.getSnapshot();
    if (s) screens.push(s);
  });
  return screens;
}

async function setup(opts: Partial<FakeBitBoxOptions> = {}, pairing: BitBoxPairingStore = memoryPairingStore()) {
  const f = await makeFixture();
  const bitbox = new FakeBitBox02({ mnemonic: MNEMONICS.hardware, ...opts });
  const link = bitbox.link();
  const bridge = new BitBoxBridge([link]);
  const screens = watch(bridge);
  const provider = new BitBox02Provider({ network: 'regtest', bridge, pairing, hww: noWait });
  return { f, bitbox, link, bridge, screens, provider, pairing };
}

async function connected(opts: Partial<FakeBitBoxOptions> = {}) {
  const s = await setup(opts);
  const signer = (await s.provider.connect({ kind: 'bitbox02' })) as BitBoxSigner;
  return { ...s, signer };
}

describe('BitBox02Provider: finding, unlocking and pairing', () => {
  it('over USB: unlock on the device, the pairing code on both screens, then the fingerprint', async () => {
    const { bitbox, provider, screens, bridge } = await setup();
    expect(provider.kinds).toEqual(['bitbox02']);
    expect(await provider.isAvailable()).toBe(true);
    const signer = await provider.connect({ kind: 'bitbox02' });
    expect(signer.info).toEqual({ kind: 'bitbox02', model: 'BitBox02', fingerprint: bitbox.fingerprint });
    expect(signer.info.fingerprint).toBe(hwSigner().master(network).fingerprint.toString(16).padStart(8, '0'));
    expect(screens.map((s) => s.title)).toEqual(['Looking for your BitBox02', 'Connecting to BitBox02', 'Unlock your BitBox02', 'Check the pairing code']);
    // The code the phone showed is the one the BitBox02 showed.
    expect(bitbox.pairingCodes).toHaveLength(1);
    expect(screens[3]!.code).toBe(bitbox.pairingCodes[0]);
    expect(screens[3]!.code).toMatch(/^[A-Z2-7]{5} [A-Z2-7]{5}\n[A-Z2-7]{5} [A-Z2-7]{5}$/);
    expect(bridge.getSnapshot()).toBeUndefined();
    expect(bitbox.requests).toEqual(['fingerprint']);
  });

  it('asks for the pairing code once: the next connection knows the BitBox02, and the BitBox02 knows the phone', async () => {
    const s = await setup();
    await (await s.provider.connect()).close();
    const before = s.screens.length;
    await s.provider.connect();
    expect(s.screens.slice(before).map((x) => x.title)).toEqual(['Looking for your BitBox02', 'Connecting to BitBox02']);
    expect(s.bitbox.pairingCodes).toHaveLength(1);
    // The phone's pairing survives the key-value store.
    const stored = await s.pairing.load();
    expect(stored.devices).toEqual([s.bitbox.noiseStatic]);
    expect(deserializePairing(serializePairing(stored))).toEqual(stored);
  });

  it('asks again when the phone forgot the BitBox02 (or the BitBox02 the phone)', async () => {
    const s = await setup();
    await (await s.provider.connect()).close();
    await s.pairing.save({ ...(await s.pairing.load()), devices: [] });
    await (await s.provider.connect()).close();
    expect(s.bitbox.pairingCodes).toHaveLength(2);
    s.bitbox.pairedApps.length = 0;
    await (await s.provider.connect()).close();
    expect(s.bitbox.pairingCodes).toHaveLength(3);
  });

  it('a pairing rejected on the BitBox02 stops, says why, and remembers nothing', async () => {
    const s = await setup();
    s.bitbox.owner.pairing = false;
    const err = await s.provider.connect().catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'user-rejected', message: expect.stringMatching(/rejected on the BitBox02.*codes were different/) });
    expect((await s.pairing.load()).devices).toEqual([]);
    expect(s.bitbox.conn!.closed).toBe(true);
  });

  it('a Nova over Bluetooth: no Noise pairing code (its Bluetooth pairing did that), named as a Nova', async () => {
    const s = await setup({ transport: 'ble', platform: 'bitbox02-nova' });
    const signer = await s.provider.connect();
    expect(signer.info.model).toBe('BitBox02 Nova');
    // The phone has not seen it, so it asks; the Nova shows the code too (it would skip it only for a phone it knows).
    expect(s.screens.map((x) => x.title)).toEqual(['Looking for your BitBox02', 'Connecting to BitBox02 Nova', 'Unlock your BitBox02 Nova', 'Check the pairing code']);
    expect(s.screens[1]!.notes!.join(' ')).toMatch(/six-digit code/);
    await signer.close();
    const before = s.screens.length;
    s.bitbox.replug();
    await s.provider.connect();
    expect(s.screens.slice(before).map((x) => x.title)).toEqual(['Looking for your BitBox02', 'Connecting to BitBox02 Nova', 'Unlock your BitBox02 Nova']);
  });

  it('no password asked when the BitBox02 is already unlocked', async () => {
    const s = await setup({ unlocked: true });
    await s.provider.connect();
    expect(s.screens.map((x) => x.title)).not.toContain('Unlock your BitBox02');
  });

  it('refuses firmware too old to sign Trikey’s texts, and a BitBox02 with no wallet yet', async () => {
    const old = await setup({ version: '9.27.0' });
    await expect(old.provider.connect()).rejects.toMatchObject({ code: 'not-supported', message: expect.stringMatching(/9\.27\.0.*9\.27\.1 or later with the BitBoxApp/) });
    const blank = await setup({ initialized: false });
    await expect(blank.provider.connect()).rejects.toMatchObject({ code: 'not-supported', message: expect.stringMatching(/no wallet yet/) });
  });

  it('resets an unfinished session on firmware 9.28.0 and later', async () => {
    const s = await setup({ version: '9.28.0' });
    await s.provider.connect();
    expect(s.bitbox.conn!.written.some((r) => r[7] === 0x03 && r[5] === 0 && r[6] === 1)).toBe(true);
    const older = await setup();
    await older.provider.connect();
    expect(older.bitbox.conn!.written.some((r) => r[7] === 0x03 && r[5] === 0 && r[6] === 1)).toBe(false);
  });

  it('the password refused on the device: it stays locked', async () => {
    const s = await setup();
    s.bitbox.owner.unlock = false;
    await expect(s.provider.connect()).rejects.toMatchObject({ code: 'device-locked' });
  });

  it('an encrypted answer that does not authenticate is refused', async () => {
    const s = await setup({ tamper: ['ciphertext'] });
    await expect(s.provider.connect()).rejects.toMatchObject({ code: 'invalid-response', message: expect.stringMatching(/did not authenticate/) });
  });

  it('times out when no BitBox02 is there, cancel stops it, and a phone without a link says why', async () => {
    const s = await setup();
    s.link.present = false;
    const quick = new BitBox02Provider({ network: 'regtest', bridge: s.bridge, scanTimeoutMs: 20, hww: noWait });
    await expect(quick.connect()).rejects.toMatchObject({ code: 'timeout', message: expect.stringMatching(/No BitBox02 found/) });
    const p = s.provider.connect();
    for (let i = 0; i < 100 && !s.bridge.getSnapshot(); i++) await new Promise((r) => setTimeout(r, 1));
    s.bridge.cancel();
    await expect(p).rejects.toMatchObject({ code: 'cancelled' });
    s.link.supported = false;
    expect(await s.provider.isAvailable()).toBe(false);
    const none = new BitBox02Provider({ bridge: new BitBoxBridge([]) });
    expect(await none.isAvailable()).toBe(false);
    expect(await none.unavailableReason()).toMatch(/phone app/);
    await expect(none.connect()).rejects.toMatchObject({ code: 'unavailable' });
    await expect(none.connect({ kind: 'ledger' })).rejects.toMatchObject({ code: 'invalid-request' });
  });

  it('a cable pulled out mid-request fails as a disconnect, so the wallet connects again', async () => {
    const { bitbox, signer } = await connected();
    const p = signer.signMessage(AUTH, TEXT);
    bitbox.conn!.unplug();
    await expect(p).rejects.toMatchObject({ name: 'HardwareError', code: 'disconnected' });
  });
});

describe('BitBoxSigner', () => {
  it('reads the BIP 48 account key without a warning on the device', async () => {
    const { f, bitbox, signer } = await connected();
    expect(await signer.getXpub("m/48'/1'/0'/2'")).toBe(f.hardwareXpub);
    // Only the pairing code was shown: no "unusual keypath" warning for m/48'/c'/0'/2'.
    expect(bitbox.screens.map((s) => s.title)).toEqual(['Pairing code']);
    expect(bitbox.requests).toEqual(['fingerprint', 'btc_pub xpub']);
    // Cached.
    await signer.getXpub("m/48'/1'/0'/2'");
    expect(bitbox.requests).toHaveLength(2);
  });

  it('refuses a key at another path', async () => {
    const { signer } = await connected({ tamper: ['xpub-path'] });
    await expect(signer.getXpub("m/48'/1'/0'/2'")).rejects.toThrow(/another path/);
  });

  it('registers the 2-of-3 once, under its name, and a declined registration is the owner’s refusal', async () => {
    const { f, bitbox, signer } = await connected();
    bitbox.owner.register = false;
    await expect(signer.registerWallet(f.policy)).rejects.toMatchObject({ code: 'user-rejected' });
    bitbox.owner.register = true;
    expect(await signer.registerWallet(f.policy)).toEqual({});
    expect([...bitbox.registered.values()]).toEqual(['Trikey test']);
    expect(bitbox.screens.filter((s) => s.title === 'Register').at(-1)!.body).toBe('Trikey test\n2-of-3');
    const n = bitbox.requests.length;
    await signer.registerWallet(f.policy);
    expect(bitbox.requests.slice(n)).toEqual(['is_script_config_registered']);
    expect(bitboxWalletName('  Trikey savings ')).toBe('Trikey savings');
    expect(bitboxWalletName('é')).toBe('Trikey');
    expect([bitboxCoin('bitcoin'), bitboxCoin('testnet'), bitboxCoin('signet'), bitboxCoin('regtest')]).toEqual([0, 1, 1, 4]);
  });

  it('a wallet without this BitBox02 is refused before asking', async () => {
    const { f, signer } = await connected();
    const other = new BitBoxSigner({ kind: 'bitbox02', fingerprint: '00000000' }, (signer as unknown as { session: never }).session, { network: 'regtest' });
    await expect(other.registerWallet(f.policy)).rejects.toThrow(/not part of the wallet/);
  });

  it('shows an address the BitBox02 derives from the registered wallet, and checks it is the phone’s', async () => {
    const { f, bitbox, signer } = await connected();
    await expect(signer.displayAddress(f.policy, 0, 0)).rejects.toMatchObject({ code: 'device-error', message: /invalid input/ });
    await signer.registerWallet(f.policy);
    expect(await signer.displayAddress(f.policy, 0, 0)).toBe(f.wallet.derive(0, 0).address);
    expect(bitbox.screens.at(-1)).toEqual({ title: 'Receive to', body: `Trikey test\n${f.wallet.derive(0, 0).address}` });
    expect(await signer.displayAddress(f.policy, 1, 7)).toBe(f.wallet.derive(1, 7).address);
    await expect(signer.displayAddress(f.policy, 0, 10_000)).rejects.toMatchObject({ code: 'not-supported' });
    const bad = await connected({ tamper: ['address'] });
    await bad.signer.registerWallet(bad.f.policy);
    await expect(bad.signer.displayAddress(bad.f.policy, 0, 0)).rejects.toThrow(/different address.*Do not use it/);
  });

  it('co-signs a payment: previous transactions, change as the wallet’s own, anti-klepto on every input, signatures verified', async () => {
    const { f, bitbox, signer } = await connected();
    await signer.registerWallet(f.policy);
    const out = await signer.signPsbt(base64.encode(f.psbtAppSigned), f.policy);
    const tx = parsePsbt(base64.decode(out));
    expect(tx.getInput(0).partialSig).toHaveLength(2);
    // The flow the firmware drives: init, input (pass 1) with its previous transaction, outputs, input (pass 2) + nonce.
    const flow = bitbox.requests.slice(bitbox.requests.indexOf('btc_sign_init'));
    expect(flow).toEqual(['btc_sign_init', 'btc_sign_input', 'prevtx_init', 'prevtx_input', 'prevtx_output', 'btc_sign_output', 'btc_sign_output', 'btc_sign_input', 'antiklepto_signature']);
    // Only the payment is shown; the change is the wallet's own.
    expect(bitbox.screens.filter((s) => s.title === 'Send to')).toEqual([{ title: 'Send to', body: `${f.wallet.derive(0, 9).address}\n30000 sat` }]);
    expect(bitbox.signedPayments).toHaveLength(1);
  });

  it('a payment for a wallet the BitBox02 has not registered is refused by it', async () => {
    const { f, signer } = await connected();
    await expect(signer.signPsbt(f.psbtBase64, f.policy)).rejects.toMatchObject({ code: 'device-error' });
  });

  it('refuses a signature that does not verify, a nonce the BitBox02 did not commit to, and a missing signature', async () => {
    for (const [tamper, why] of [
      ['tx-signature', /does not verify/],
      ['antiklepto', /anti-klepto.*not the one committed to/],
      ['skip-input', /did not sign input 0/],
    ] as const) {
      const { f, signer } = await connected({ tamper: [tamper] });
      await signer.registerWallet(f.policy);
      await expect(signer.signPsbt(f.psbtBase64, f.policy)).rejects.toThrow(why);
    }
  });

  it('a payment declined on the device is the owner’s refusal', async () => {
    const { f, bitbox, signer } = await connected();
    await signer.registerWallet(f.policy);
    bitbox.owner.payment = false;
    const err = await signer.signPsbt(f.psbtBase64, f.policy).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'user-rejected' });
    expect(describeHardwareError(err)).toBe('You rejected the request on the device.');
  });

  it('refuses a payment with a coin of another wallet, or without its previous transaction', async () => {
    const { f, bitbox, signer } = await connected();
    await signer.registerWallet(f.policy);
    const tx = parsePsbt(f.psbt);
    const others = tx.getInput(0).bip32Derivation!.filter(([, d]) => d.fingerprint !== parseInt(bitbox.fingerprint, 16));
    tx.updateInput(0, { bip32Derivation: undefined }, true);
    tx.updateInput(0, { bip32Derivation: others }, true);
    expect(tx.getInput(0).bip32Derivation).toHaveLength(2);
    await expect(signer.signPsbt(base64.encode(tx.toPSBT()), f.policy)).rejects.toMatchObject({ code: 'not-supported', message: /not a coin of this wallet/ });
    const bare = parsePsbt(f.psbt);
    bare.updateInput(0, { nonWitnessUtxo: undefined }, true);
    await expect(signer.signPsbt(base64.encode(bare.toPSBT()), f.policy)).rejects.toThrow(/no previous transaction/);
  });

  it('signs approvals and pairing texts with anti-klepto, checked against the key', async () => {
    const { bitbox, signer } = await connected();
    const a = await signer.signMessage(AUTH, TEXT, { purpose: 'pairing' });
    const b = await signer.signMessage(AUTH, TEXT, { purpose: 'approval' });
    expect(a).not.toBe(b); // a fresh nonce each time
    const key = hwSigner().master(network).derive(AUTH).publicKey!;
    expect(verifyBip137Message(TEXT, key, a)).toBe(true);
    expect(verifyBip137Message(TEXT, key, b)).toBe(true);
    expect(base64.decode(a)[0]).toBeGreaterThanOrEqual(31);
    expect(base64.decode(a)[0]).toBeLessThanOrEqual(34);
    expect(bitbox.textsWithAntiKlepto).toEqual([true, true]);
    // What the owner reads on the BitBox02: the external service key, its own address, the text.
    expect(bitbox.screens.slice(-3).map((s) => s.title)).toEqual(['Sign message', 'Address', 'Sign message']);
    expect(bitbox.screens.at(-3)!.body).toBe('Coin: BTC Regtest\nExternal service key');
    expect(bitbox.screens.at(-1)!.body).toBe(TEXT);
  });

  it('signs notes and unlock texts without anti-klepto: the same signature twice', async () => {
    const { bitbox, signer } = await connected();
    const a = await signer.signMessage(AUTH, TEXT, { purpose: 'notes', round: { n: 1, of: 2 } });
    const b = await signer.signMessage(AUTH, TEXT, { purpose: 'notes', round: { n: 2, of: 2 } });
    const c = await signer.signMessage(AUTH, TEXT, { purpose: 'unlock' });
    expect(new Set([a, b, c]).size).toBe(1);
    expect(verifyBip137Message(TEXT, hwSigner().master(network).derive(AUTH).publicKey!, a)).toBe(true);
    expect(bitbox.textsWithAntiKlepto).toEqual([false, false, false]);
  });

  it('refuses a text signature by another key, of another text, or ignoring the nonce; and texts it cannot sign', async () => {
    for (const [tamper, why] of [
      ['message-key', /not from this wallet’s key m\/48'\/1'\/0'\/2'\/0\/0/],
      ['message-text', /not from this wallet’s key/],
      ['antiklepto', /anti-klepto/],
    ] as const) {
      const { signer } = await connected({ tamper: [tamper] });
      await expect(signer.signMessage(AUTH, TEXT, { purpose: 'approval' })).rejects.toMatchObject({ code: 'invalid-response', message: expect.stringMatching(why) });
    }
    const { signer, bitbox } = await connected();
    await expect(signer.signMessage(AUTH, 'héllo')).rejects.toMatchObject({ code: 'invalid-request' });
    await expect(signer.signMessage("m/84'/1'/0'/0/0", TEXT)).rejects.toMatchObject({ code: 'not-supported' });
    await expect(signer.signMessage("m/48'/1'/0'/2'", TEXT)).rejects.toThrow(/below an account key/);
    bitbox.owner.message = false;
    await expect(signer.signMessage(AUTH, TEXT)).rejects.toMatchObject({ code: 'user-rejected' });
  });

  it('a BitBox02 on firmware without m/48\' message signing refuses the text (the provider stops it earlier)', async () => {
    const { bitbox, signer } = await connected();
    bitbox.version = '9.27.0';
    await expect(signer.signMessage(AUTH, TEXT)).rejects.toMatchObject({ code: 'device-error', message: /invalid input \(101\)/ });
    expect(bitbox.requests.at(-1)).toBe('sign_message');
    expect([H]).toHaveLength(1);
  });
});
