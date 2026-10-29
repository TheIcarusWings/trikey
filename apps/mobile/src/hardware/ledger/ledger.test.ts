import { describe, expect, it } from 'vitest';
import { base64, hex } from '@scure/base';
import { addChecksum, analyzePsbt, parsePsbt, stripChecksum } from '@trikey/core';
import { HardwareError, HardwareNotSupportedError } from '../errors';
import { decodePsbtBase64 } from '../common/psbt';
import { makeFixture, deviceSignatures, network, type Fixture } from '../test/fixtures';
import { LEDGER_DESCRIPTOR_TEMPLATE, hmacFromHex, hmacToHex, toLedgerPolicy, toRegisteredLedgerWallet, type LedgerRegisteredWallet, type LedgerWalletPolicy } from './policy';
import { ledgerSignatureToBase64 } from './signature';
import { mapLedgerError } from './errors';
import { appForCoinType, LedgerSigner, type LedgerApp, type LedgerBackend } from './signer';
import { runDeviceAction, type DeviceActionLike, type DeviceActionStateLike } from './device-action';
import { DmkLedgerBackend, ecdsaSignatures, withSighashByte } from './dmk-backend';
import type { PartialSignature } from '../common/psbt';
import type { LedgerMessageSignature } from './signature';

// A known answer: the descriptor of the throwaway test wallet and the wallet policy a Ledger needs for it.
const KAT_DESCRIPTOR =
  "wsh(sortedmulti(2,[73c5da0a/48h/1h/0h/2h]tpubDFH9dgzveyD8zTbPUFuLrGmCydNvxehyNdUXKJAQN8x4aZ4j6UZqGfnqFrD4NqyaTVGKbvEW54tsvPTK2UoSbCC1PJY8iCNiwTL3RWZEheQ/<0;1>/*,[b8688df1/48h/1h/0h/2h]tpubDEfobrrtptRTbKf4gysDhoabneABDTAcdj3Vbn4XwPsLE2pmqpizSPRG6zHsbAMuiSgWmWPsYCLHTKTPpyrGJ5rAoTpKoQNZcxodiPf2tSJ/<0;1>/*,[f92b4e64]tpubD6NzVbkrYhZ4WRqbpH4gqMJAsmR8A72a4VTFURvxBVFBtUhTYNMJLpRCb5c5xbgkEoyMQ29QDRB64M4BmHoY4w32wjZTTP7T4YNHAxE18KP/<0;1>/*))#r5mle00x";
const KAT_KEYS = [
  "[73c5da0a/48'/1'/0'/2']tpubDFH9dgzveyD8zTbPUFuLrGmCydNvxehyNdUXKJAQN8x4aZ4j6UZqGfnqFrD4NqyaTVGKbvEW54tsvPTK2UoSbCC1PJY8iCNiwTL3RWZEheQ",
  "[b8688df1/48'/1'/0'/2']tpubDEfobrrtptRTbKf4gysDhoabneABDTAcdj3Vbn4XwPsLE2pmqpizSPRG6zHsbAMuiSgWmWPsYCLHTKTPpyrGJ5rAoTpKoQNZcxodiPf2tSJ",
  '[f92b4e64]tpubD6NzVbkrYhZ4WRqbpH4gqMJAsmR8A72a4VTFURvxBVFBtUhTYNMJLpRCb5c5xbgkEoyMQ29QDRB64M4BmHoY4w32wjZTTP7T4YNHAxE18KP',
];

const HMAC_HEX = '0f'.repeat(32);

describe('descriptor to Ledger wallet policy', () => {
  it('matches the known answer', () => {
    const policy = toLedgerPolicy({ name: 'Trikey test', descriptor: KAT_DESCRIPTOR });
    expect(policy).toEqual({ name: 'Trikey test', descriptorTemplate: 'wsh(sortedmulti(2,@0/**,@1/**,@2/**))', keys: KAT_KEYS });
    expect(policy.descriptorTemplate).toBe(LEDGER_DESCRIPTOR_TEMPLATE);
  });

  it('writes hardened steps with an apostrophe and leaves the key with no origin as [fingerprint]xpub', () => {
    const { keys } = toLedgerPolicy({ name: 'x', descriptor: KAT_DESCRIPTOR });
    for (const k of keys) expect(k).not.toMatch(/\dh/);
    expect(keys[2]).toMatch(/^\[f92b4e64\]tpub/);
    // No /<0;1>/* suffix on the key info: the template carries it as `/**`.
    for (const k of keys) expect(k).not.toContain('<');
  });

  it('keeps the key order of the descriptor (the HMAC depends on it)', () => {
    const body = stripChecksum(KAT_DESCRIPTOR);
    const inner = /sortedmulti\(2,(.*)\)\)$/.exec(body)![1]!.split(',');
    const reversed = addChecksum(`wsh(sortedmulti(2,${[...inner].reverse().join(',')}))`);
    expect(toLedgerPolicy({ name: 'x', descriptor: reversed }).keys).toEqual([...KAT_KEYS].reverse());
  });

  it('accepts a descriptor without checksum and rejects a wrong one', () => {
    const body = stripChecksum(KAT_DESCRIPTOR);
    expect(toLedgerPolicy({ name: 'x', descriptor: body }).keys).toEqual(KAT_KEYS);
    expect(() => toLedgerPolicy({ name: 'x', descriptor: `${body}#aaaaaaaa` })).toThrowError(HardwareError);
  });

  it('rejects anything that is not wsh(sortedmulti(2, three keys))', () => {
    for (const d of [
      addChecksum('wpkh([b8688df1/84h/1h/0h]tpubDEfobrrtptRTbKf4gysDhoabneABDTAcdj3Vbn4XwPsLE2pmqpizSPRG6zHsbAMuiSgWmWPsYCLHTKTPpyrGJ5rAoTpKoQNZcxodiPf2tSJ/<0;1>/*)'),
      addChecksum("wsh(sortedmulti(2,[b8688df1/48h/1h/0h/2h]tpubDEfobrrtptRTbKf4gysDhoabneABDTAcdj3Vbn4XwPsLE2pmqpizSPRG6zHsbAMuiSgWmWPsYCLHTKTPpyrGJ5rAoTpKoQNZcxodiPf2tSJ/<0;1>/*))"),
    ]) {
      expect(() => toLedgerPolicy({ name: 'x', descriptor: d })).toThrowError(HardwareError);
    }
  });

  it('checks the wallet name (1 to 16 printable ASCII characters)', () => {
    for (const name of ['', 'x'.repeat(17), 'Trikey ₿', 'tab\there']) {
      expect(() => toLedgerPolicy({ name, descriptor: KAT_DESCRIPTOR })).toThrowError(/name/);
    }
    expect(toLedgerPolicy({ name: 'x'.repeat(16), descriptor: KAT_DESCRIPTOR }).name).toHaveLength(16);
  });

  it('turns the stored registration into the HMAC bytes, and refuses to go on without one', () => {
    const w = toRegisteredLedgerWallet({ name: 'x', descriptor: KAT_DESCRIPTOR, registration: { hmac: HMAC_HEX } });
    expect(w.hmac).toEqual(new Uint8Array(32).fill(0x0f));
    expect(w.keys).toEqual(KAT_KEYS);
    expect(() => toRegisteredLedgerWallet({ name: 'x', descriptor: KAT_DESCRIPTOR })).toThrowError(expect.objectContaining({ code: 'wallet-not-registered' }));
    expect(() => hmacFromHex('abcd')).toThrowError(HardwareError);
    expect(hmacToHex(hmacFromHex(HMAC_HEX.toUpperCase()))).toBe(HMAC_HEX);
  });
});

// ------------------------------------------------------------------------------------------------ the signer

class FakeLedger implements LedgerBackend {
  apps: LedgerApp[] = [];
  registered: LedgerWalletPolicy[] = [];
  signedWith: LedgerRegisteredWallet[] = [];
  closed = false;
  hmac = new Uint8Array(32).fill(0x0f);
  fail: unknown;
  /** What `signPsbt` returns; by default the signatures of the throwaway hardware key. */
  signatures?: (psbt: Uint8Array) => Promise<PartialSignature[]>;
  addressOverride?: string;
  message: LedgerMessageSignature = { v: 32, r: `0x${'11'.repeat(32)}`, s: `0x${'22'.repeat(32)}` };
  xpub = '';
  addressOf: (change: boolean, index: number) => string = () => '';
  addressCalls: Array<{ change: boolean; index: number; display: boolean }> = [];

  private maybeFail() {
    if (this.fail) throw this.fail;
  }
  async ensureApp(app: LedgerApp) {
    this.maybeFail();
    this.apps.push(app);
  }
  async getMasterFingerprint() {
    return 'b8688df1';
  }
  async getExtendedPublicKey() {
    this.maybeFail();
    return this.xpub;
  }
  async registerWallet(policy: LedgerWalletPolicy) {
    this.maybeFail();
    this.registered.push(policy);
    return this.hmac;
  }
  async getWalletAddress(_w: LedgerRegisteredWallet, change: boolean, index: number, display: boolean) {
    this.maybeFail();
    this.addressCalls.push({ change, index, display });
    return this.addressOverride ?? this.addressOf(change, index);
  }
  async signPsbt(wallet: LedgerRegisteredWallet, psbt: Uint8Array) {
    this.maybeFail();
    this.signedWith.push(wallet);
    return (this.signatures ?? deviceSignatures)(psbt);
  }
  async signMessage() {
    this.maybeFail();
    return this.message;
  }
  async close() {
    this.closed = true;
  }
}

async function setup(network_: 'regtest' | 'bitcoin' = 'regtest') {
  const f = await makeFixture();
  const backend = new FakeLedger();
  backend.xpub = f.hardwareXpub;
  backend.addressOf = (change, index) => f.wallet.derive(change ? 1 : 0, index).address;
  const signer = new LedgerSigner({ kind: 'ledger', model: 'Nano X', fingerprint: f.hardwareFingerprint }, backend, { network: network_ });
  const registered = { ...f.policy, registration: { hmac: HMAC_HEX } };
  return { f, backend, signer, registered };
}

describe('LedgerSigner', () => {
  it('opens the Bitcoin Test app for testnet-family coin types and Bitcoin for mainnet', async () => {
    const { f, backend, signer } = await setup();
    expect(await signer.getXpub("m/48'/1'/0'/2'")).toBe(f.hardwareXpub);
    expect(backend.apps).toEqual(['Bitcoin Test']);
    expect(appForCoinType(0)).toBe('Bitcoin');
    expect(appForCoinType(1)).toBe('Bitcoin Test');
  });

  it('refuses a key of the wrong network, and normalises SLIP-132 keys', async () => {
    const { f, backend, signer } = await setup();
    // A tpub for a mainnet path: the wrong app is open.
    await expect(signer.getXpub("m/48'/0'/0'/2'")).rejects.toMatchObject({ code: 'invalid-response' });
    expect(backend.apps).toEqual(['Bitcoin']);
    backend.xpub = 'not an xpub';
    await expect(signer.getXpub("m/48'/1'/0'/2'")).rejects.toMatchObject({ code: 'invalid-response' });
    expect(f.hardwareXpub).toMatch(/^tpub/);
    await expect(signer.getXpub('m')).rejects.toMatchObject({ code: 'invalid-request' });
    await expect(signer.getXpub("m/48'/x")).rejects.toMatchObject({ code: 'invalid-request' });
  });

  it('registers the policy (key order kept) and returns the HMAC as hex', async () => {
    const { backend, signer, f } = await setup();
    expect(await signer.registerWallet(f.policy)).toEqual({ hmac: HMAC_HEX });
    expect(backend.registered).toEqual([toLedgerPolicy(f.policy)]);
    expect(backend.registered[0]!.keys).toEqual(KAT_KEYS);
  });

  it('refuses a wallet that does not contain this device, or is for another network', async () => {
    const { f, backend } = await setup();
    const other = new LedgerSigner({ kind: 'ledger', model: 'Nano X', fingerprint: '00000000' }, backend, { network: 'regtest' });
    await expect(other.registerWallet(f.policy)).rejects.toMatchObject({ code: 'invalid-request' });
    const main = new LedgerSigner({ kind: 'ledger', fingerprint: f.hardwareFingerprint }, backend, { network: 'bitcoin' });
    await expect(main.registerWallet(f.policy)).rejects.toMatchObject({ code: 'invalid-request' });
    expect(backend.registered).toHaveLength(0);
  });

  it('shows an address and checks it against the one the wallet derives', async () => {
    const { f, backend, signer, registered } = await setup();
    expect(await signer.displayAddress(registered, 0, 5)).toBe(f.wallet.derive(0, 5).address);
    expect(await signer.displayAddress(registered, 1, 2)).toBe(f.wallet.derive(1, 2).address);
    expect(backend.addressCalls).toEqual([
      { change: false, index: 5, display: true },
      { change: true, index: 2, display: true },
    ]);
    backend.addressOverride = f.wallet.derive(0, 6).address;
    await expect(signer.displayAddress(registered, 0, 5)).rejects.toMatchObject({ code: 'invalid-response' });
    await expect(signer.displayAddress(f.policy, 0, 5)).rejects.toMatchObject({ code: 'wallet-not-registered' });
    await expect(signer.displayAddress(registered, 2 as 0, 5)).rejects.toMatchObject({ code: 'invalid-request' });
    await expect(signer.displayAddress(registered, 0, -1)).rejects.toMatchObject({ code: 'invalid-request' });
  });

  it('signs a PSBT: merges the device signature next to the app key signature, keeping every other field', async () => {
    const { f, backend, signer, registered } = await setup();
    const input = base64.encode(f.psbtAppSigned);
    const out = await signer.signPsbt(input, registered);
    const merged = base64.decode(out);

    const analysis = analyzePsbt(merged, f.wallet.accountPubkeys(), network);
    expect(analysis.inputs[0]!.signedBy.sort()).toEqual(['app', 'hardware']);

    // Everything that was in the PSBT is still there: same transaction, same derivations and tweaks.
    const before = parsePsbt(f.psbtAppSigned);
    const after = parsePsbt(merged);
    expect(after.id).toBe(before.id);
    expect(after.getInput(0).proprietary).toEqual(before.getInput(0).proprietary);
    expect(after.getInput(0).bip32Derivation).toEqual(before.getInput(0).bip32Derivation);
    expect(after.getInput(0).nonWitnessUtxo).toEqual(before.getInput(0).nonWitnessUtxo);
    expect(after.getOutput(1).bip32Derivation).toEqual(before.getOutput(1).bip32Derivation);
    // The backend got the policy plus the HMAC.
    expect(backend.signedWith[0]!.hmac).toEqual(new Uint8Array(32).fill(0x0f));
    expect(backend.signedWith[0]!.keys).toEqual(KAT_KEYS);
  });

  it('signs an unsigned PSBT too, and a second pass changes nothing', async () => {
    const { f, signer, registered } = await setup();
    const once = await signer.signPsbt(f.psbtBase64, registered);
    expect(analyzePsbt(base64.decode(once), f.wallet.accountPubkeys(), network).inputs[0]!.signedBy).toEqual(['hardware']);
    expect(await signer.signPsbt(once, registered)).toBe(once);
  });

  it('never merges a signature that does not verify', async () => {
    const { f, backend, signer, registered } = await setup();
    // Flipped bit inside the DER body.
    backend.signatures = async (psbt) => {
      const sigs = await deviceSignatures(psbt);
      const bad = sigs[0]!.signature.slice();
      bad[10] = bad[10]! ^ 1;
      return [{ ...sigs[0]!, signature: bad }];
    };
    await expect(signer.signPsbt(f.psbtBase64, registered)).rejects.toMatchObject({ code: 'invalid-response' });

    // A valid signature for a different transaction.
    const other = await makeFixture();
    backend.signatures = () => deviceSignatures(other.psbt);
    await expect(signer.signPsbt(f.psbtBase64, registered)).rejects.toMatchObject({ code: 'invalid-response' });

    // A signature by a key that is not in the input script.
    backend.signatures = async (psbt) => {
      const sigs = await deviceSignatures(psbt);
      return [{ ...sigs[0]!, pubkey: f.wallet.derive(0, 4).pubkeys.hardware }];
    };
    await expect(signer.signPsbt(f.psbtBase64, registered)).rejects.toMatchObject({ code: 'invalid-response' });

    // An input that does not exist, no signatures at all, a signature without the sighash byte.
    backend.signatures = async (psbt) => (await deviceSignatures(psbt)).map((s) => ({ ...s, inputIndex: 7 }));
    await expect(signer.signPsbt(f.psbtBase64, registered)).rejects.toMatchObject({ code: 'invalid-response' });
    backend.signatures = async () => [];
    await expect(signer.signPsbt(f.psbtBase64, registered)).rejects.toMatchObject({ code: 'invalid-response' });
    backend.signatures = async (psbt) => (await deviceSignatures(psbt)).map((s) => ({ ...s, signature: s.signature.slice(0, -1) }));
    await expect(signer.signPsbt(f.psbtBase64, registered)).rejects.toMatchObject({ code: 'invalid-response' });
  });

  it('refuses a PSBT that is not a PSBT, and a wallet without registration', async () => {
    const { f, signer, registered } = await setup();
    await expect(signer.signPsbt('!!!', registered)).rejects.toMatchObject({ code: 'invalid-request' });
    await expect(signer.signPsbt(base64.encode(new Uint8Array([1, 2, 3])), registered)).rejects.toMatchObject({ code: 'invalid-request' });
    await expect(signer.signPsbt(f.psbtBase64, f.policy)).rejects.toMatchObject({ code: 'wallet-not-registered' });
  });

  it('signs a message and returns BIP137 base64 (header, r, s)', async () => {
    const { backend, signer } = await setup();
    const sig = base64.decode(await signer.signMessage("m/84'/1'/0'/0/0", 'Trikey pair v1 wallet=abc'));
    expect(sig).toHaveLength(65);
    expect(sig[0]).toBe(32);
    expect(hex.encode(sig.slice(1, 33))).toBe('11'.repeat(32));
    expect(hex.encode(sig.slice(33))).toBe('22'.repeat(32));
    expect(backend.apps).toEqual(['Bitcoin Test']);
    backend.message = { v: 99, r: '0x11', s: '0x22' };
    await expect(signer.signMessage("m/84'/1'/0'/0/0", 'hello')).rejects.toMatchObject({ code: 'invalid-response' });
    await expect(signer.signMessage("m/84'/1'/0'/0/0", 'héllo')).rejects.toMatchObject({ code: 'invalid-request' });
    await expect(signer.signMessage('m', 'hello')).rejects.toMatchObject({ code: 'invalid-request' });
  });

  it('maps device errors to typed errors, and close() never throws', async () => {
    const { f, backend, signer, registered } = await setup();
    backend.fail = { _tag: 'DeviceLockedError' };
    await expect(signer.getXpub("m/48'/1'/0'/2'")).rejects.toMatchObject({ code: 'device-locked' });
    backend.fail = { _tag: 'BtcAppCommandError', errorCode: '6985', message: 'Rejected by user' };
    await expect(signer.signPsbt(f.psbtBase64, registered)).rejects.toMatchObject({ code: 'user-rejected' });
    await signer.close();
    expect(backend.closed).toBe(true);
    backend.close = async () => {
      throw new Error('already closed');
    };
    await expect(signer.close()).resolves.toBeUndefined();
  });
});

describe('message signature encoding', () => {
  it('accepts values with or without 0x and rejects bad ones', () => {
    const a = ledgerSignatureToBase64({ v: 31, r: '0x' + 'ab'.repeat(32), s: 'cd'.repeat(32) });
    const bytes = base64.decode(a);
    expect([bytes[0], bytes[1], bytes[64]]).toEqual([31, 0xab, 0xcd]);
    expect(() => ledgerSignatureToBase64({ v: 26, r: 'ab'.repeat(32), s: 'cd'.repeat(32) })).toThrowError(HardwareError);
    expect(() => ledgerSignatureToBase64({ v: 43, r: 'ab'.repeat(32), s: 'cd'.repeat(32) })).toThrowError(HardwareError);
    expect(() => ledgerSignatureToBase64({ v: 31, r: 'ab'.repeat(31), s: 'cd'.repeat(32) })).toThrowError(HardwareError);
    expect(() => ledgerSignatureToBase64({ v: 31, r: 'zz'.repeat(32), s: 'cd'.repeat(32) })).toThrowError(HardwareError);
  });
});

// ------------------------------------------------------------------------------------------------ error mapping

describe('mapLedgerError', () => {
  const cases: Array<[string, unknown, string]> = [
    ['locked device (DMK tag)', { _tag: 'DeviceLockedError' }, 'device-locked'],
    ['locked device (status word 5515)', { _tag: 'UnknownDeviceExchangeError', errorCode: '5515' }, 'device-locked'],
    ['refused on the device (DA error)', { _tag: 'RefusedByUserDAError' }, 'user-rejected'],
    ['refused by the Bitcoin app (6985)', { _tag: 'BtcAppCommandError', errorCode: '6985' }, 'user-rejected'],
    ['refused (global 5501)', { _tag: 'ActionRefusedError', errorCode: '5501' }, 'user-rejected'],
    ['wrong HMAC (b008)', { _tag: 'BtcAppCommandError', errorCode: 'b008' }, 'wallet-not-registered'],
    ['app not installed (6807)', { _tag: 'OpenAppCommandError', errorCode: '6807' }, 'app-not-open'],
    ['dashboard open (6d00)', { _tag: 'BtcAppCommandError', errorCode: '6D00' }, 'app-not-open'],
    ['Bluetooth off', { _tag: 'BlePoweredOff' }, 'unavailable'],
    ['Bluetooth permission', { _tag: 'BlePermissionsNotGranted' }, 'unavailable'],
    ['link dropped', { _tag: 'DeviceDisconnectedWhileSendingError' }, 'disconnected'],
    ['pairing removed', { _tag: 'PeerRemovedPairingError' }, 'disconnected'],
    ['timeout', { _tag: 'SendApduTimeoutError' }, 'timeout'],
    ['bad data (6a80)', { _tag: 'BtcAppCommandError', errorCode: '6a80' }, 'invalid-request'],
    ['a plain Error that says so', new Error('Device is locked'), 'device-locked'],
    ['a plain timeout Error', new Error('request timed out'), 'timeout'],
    ['something unknown', { _tag: 'WhateverError', message: 'boom' }, 'device-error'],
    ['a string', 'weird', 'device-error'],
  ];
  it.each(cases)('%s', (_name, input, code) => {
    const mapped = mapLedgerError(input);
    expect(mapped).toBeInstanceOf(HardwareError);
    expect(mapped.code).toBe(code);
    expect(mapped.kind).toBe('ledger');
  });

  it('keeps the original error for logs and unwraps nested ones', () => {
    const inner = { _tag: 'DeviceLockedError' };
    const wrapped = { _tag: 'UnknownDAError', originalError: inner };
    expect(mapLedgerError(wrapped).code).toBe('device-locked');
    const raw = { _tag: 'WhateverError' };
    expect(mapLedgerError(raw).detail).toBe(raw);
  });

  it('passes HardwareErrors through and reports unsupported requests as such', () => {
    const e = new HardwareError('cancelled', 'x');
    expect(mapLedgerError(e)).toBe(e);
    const unsupported = mapLedgerError({ _tag: 'BtcAppCommandError', errorCode: '6a82' });
    expect(unsupported).toBeInstanceOf(HardwareNotSupportedError);
  });
});

// ------------------------------------------------------------------------------------------------ DMK glue

function fakeAction<O, E>(states: DeviceActionStateLike<O, E>[], onCancel = () => {}): DeviceActionLike<O, E> {
  return {
    observable: {
      subscribe(observer) {
        let live = true;
        queueMicrotask(() => {
          for (const s of states) if (live) observer.next(s);
          if (live) observer.complete();
        });
        return { unsubscribe: () => (live = false) };
      },
    },
    cancel: onCancel,
  };
}

describe('runDeviceAction', () => {
  it('resolves with the output and reports the interactions the user has to act on', async () => {
    const seen: string[] = [];
    const out = await runDeviceAction(
      fakeAction<string, never>([
        { status: 'pending', intermediateValue: { requiredUserInteraction: 'unlock-device' } },
        { status: 'pending', intermediateValue: { requiredUserInteraction: 'sign-transaction' } },
        { status: 'completed', output: 'done' },
      ]),
      { onInteraction: (i) => seen.push(i) },
    );
    expect(out).toBe('done');
    expect(seen).toEqual(['unlock-device', 'sign-transaction']);
  });

  it('rejects with the DMK error object, and for stopped actions with `cancelled`', async () => {
    const err = { _tag: 'DeviceLockedError' };
    await expect(runDeviceAction(fakeAction([{ status: 'error', error: err }]))).rejects.toBe(err);
    await expect(runDeviceAction(fakeAction([{ status: 'stopped' }]))).rejects.toMatchObject({ code: 'cancelled' });
    await expect(runDeviceAction(fakeAction([{ status: 'pending' }]))).rejects.toMatchObject({ code: 'device-error' });
  });

  it('cancels the device action when the signal aborts', async () => {
    let cancelled = 0;
    const ac = new AbortController();
    const never: DeviceActionLike<string, never> = { observable: { subscribe: () => ({ unsubscribe() {} }) }, cancel: () => cancelled++ };
    const p = runDeviceAction(never, { signal: ac.signal });
    ac.abort();
    await expect(p).rejects.toMatchObject({ code: 'cancelled' });
    expect(cancelled).toBe(1);
    await expect(runDeviceAction(never, { signal: ac.signal })).rejects.toMatchObject({ code: 'cancelled' });
  });
});

describe('DmkLedgerBackend', () => {
  function build() {
    const calls: Array<{ name: string; args: unknown[] }> = [];
    const done = <O>(output: O) => fakeAction<O, never>([{ status: 'completed', output }]);
    const signer = {
      getMasterFingerprint: (...args: unknown[]) => (calls.push({ name: 'fp', args }), done({ masterFingerprint: new Uint8Array([0xb8, 0x68, 0x8d, 0xf1]) })),
      getExtendedPublicKey: (...args: unknown[]) => (calls.push({ name: 'xpub', args }), done({ extendedPublicKey: 'tpubX' })),
      registerWallet: (...args: unknown[]) => (calls.push({ name: 'register', args }), done({ hmac: new Uint8Array(32).fill(1) })),
      getWalletAddress: (...args: unknown[]) => (calls.push({ name: 'address', args }), done({ address: 'bcrt1qaddress' })),
      signPsbt: (...args: unknown[]) => (calls.push({ name: 'signPsbt', args }), done([] as unknown[])),
      signMessage: (...args: unknown[]) => (calls.push({ name: 'signMessage', args }), done({ v: 31, r: '0x', s: '0x' })),
    };
    const dmkCalls: Array<{ deviceAction: { input: { appName: string } } }> = [];
    const dmk = {
      executeDeviceAction: (args: { deviceAction: { input: { appName: string } } }) => (dmkCalls.push(args), done(undefined)),
      disconnect: async () => {},
    };
    const backend = new DmkLedgerBackend(dmk as never, 'session-1', signer as never);
    return { backend, calls, dmkCalls };
  }

  it('opens the app itself and always tells the signer kit to skip its own app opening', async () => {
    const { backend, calls, dmkCalls } = build();
    await backend.ensureApp('Bitcoin Test');
    expect(dmkCalls[0]!.deviceAction.input.appName).toBe('Bitcoin Test');

    expect(await backend.getMasterFingerprint()).toBe('b8688df1');
    expect(await backend.getExtendedPublicKey("m/48'/1'/0'/2'")).toBe('tpubX');
    expect(calls.find((c) => c.name === 'xpub')!.args).toEqual(["m/48'/1'/0'/2'", { skipOpenApp: true, checkOnDevice: false }]);
    await backend.signMessage("m/84'/1'/0'/0/0", 'hi');
    expect(calls.find((c) => c.name === 'signMessage')!.args[2]).toEqual({ skipOpenApp: true });
  });

  it('passes the wallet as policy + HMAC and the PSBT as bytes', async () => {
    const { backend, calls } = build();
    const wallet: LedgerRegisteredWallet = { name: 'x', descriptorTemplate: LEDGER_DESCRIPTOR_TEMPLATE, keys: KAT_KEYS, hmac: new Uint8Array(32).fill(7) };
    expect(await backend.getWalletAddress(wallet, true, 4, true)).toBe('bcrt1qaddress');
    const addr = calls.find((c) => c.name === 'address')!.args;
    expect(addr[0]).toMatchObject({ name: 'x', keys: KAT_KEYS, hmac: new Uint8Array(32).fill(7) });
    expect(addr[1]).toBe(4);
    expect(addr[2]).toEqual({ skipOpenApp: true, checkOnDevice: true, change: true });
    const psbt = new Uint8Array([0x70, 0x73, 0x62, 0x74, 0xff]);
    await backend.signPsbt(wallet, psbt);
    expect(calls.find((c) => c.name === 'signPsbt')!.args[1]).toBe(psbt);
  });

  it('keeps ECDSA partial signatures only, and adds a missing sighash byte', () => {
    const der = hex.decode('3006020101020101');
    const withByte = new Uint8Array([...der, 1]);
    expect(withSighashByte(der)).toEqual(withByte);
    expect(withSighashByte(withByte)).toBe(withByte);
    const pub = new Uint8Array(33).fill(2);
    const result = ecdsaSignatures([
      { inputIndex: 0, pubkey: pub, signature: der },
      { inputIndex: 1, pubkey: pub, signature: withByte },
      { inputIndex: 2, pubkey: pub, signature: withByte, tapleafHash: new Uint8Array(32) },
      { inputIndex: 3, participantPubkey: pub, partialSignature: der },
      { nonsense: true },
    ]);
    expect(result.map((r) => r.inputIndex)).toEqual([0, 1]);
    expect(result[0]!.signature).toEqual(withByte);
  });
});

// ---------------------------------------------------------------------------------- the real Ledger SDK, offline

describe('Ledger Device Management Kit compatibility (offline)', () => {
  it('maps our BIP174 v0 PSBT through the signer kit\'s PSBT pipeline, and accepts our wallet policy', async () => {
    const { makeContainer } = await import('@ledgerhq/device-signer-kit-bitcoin/internal/di.js');
    const { psbtTypes } = await import('@ledgerhq/device-signer-kit-bitcoin/internal/psbt/di/psbtTypes.js');
    const { walletTypes } = await import('@ledgerhq/device-signer-kit-bitcoin/internal/wallet/di/walletTypes.js');
    const { RegisteredWallet } = await import('@ledgerhq/device-signer-kit-bitcoin');

    const logger = { debug() {}, info() {}, warn() {}, error() {}, subscribers: [] };
    const container = makeContainer({ dmk: { getLoggerFactory: () => () => logger } as never, sessionId: 'test' });
    const f: Fixture = await makeFixture();

    const mapper = container.get(psbtTypes.PsbtMapper) as { map(psbt: Uint8Array | string): { isRight(): boolean; extract(): { inputMaps: unknown[]; outputMaps: unknown[] } } };
    for (const psbt of [f.psbt, f.psbtBase64, f.psbtAppSigned]) {
      const mapped = mapper.map(psbt);
      expect(mapped.isRight()).toBe(true);
      const v2 = mapped.extract();
      expect(v2.inputMaps).toHaveLength(1);
      expect(v2.outputMaps).toHaveLength(2);
    }
    expect(decodePsbtBase64(f.psbtBase64)).toEqual(f.psbt);

    const walletBuilder = container.get(walletTypes.WalletBuilder) as { fromRegisteredWallet(w: unknown): { keys: string[]; hmac: Uint8Array } };
    const policy = toRegisteredLedgerWallet({ ...f.policy, registration: { hmac: HMAC_HEX } });
    const built = walletBuilder.fromRegisteredWallet(new RegisteredWallet(policy.name, policy.descriptorTemplate, policy.keys, policy.hmac));
    expect(built.keys).toEqual(policy.keys);
    expect(built.hmac).toEqual(policy.hmac);
  });
});
