/**
 * The BitBox02 protocol layers against vectors from the real implementations, so the app's code is checked against the
 * BitBox02 itself and not only against the fake written beside it:
 *
 * - U2F HID framing: the vectors of `bitbox-api-rs/src/u2fframing.rs` (as copied in bitbox-api-ts
 *   `test/u2f-framing.test.ts`);
 * - Noise: the `Noise_XX_25519_ChaChaPoly_SHA256` transcript the Rust `noise-protocol` crate (the firmware's) produces for
 *   fixed keys (bitbox-api-ts `test/noise.test.ts`, "RUST_VECTOR");
 * - the pairing code: firmware `workflow/pairing.rs` test `test_confirm`;
 * - anti-klepto: the Rust implementation's vectors (bitbox-api-ts `test/eth-antiklepto.test.ts`);
 * - message signatures without anti-klepto: firmware `hww/api/bitcoin/signmsg.rs` tests (`TEST_MNEMONIC`, "message"),
 *   reproduced by the fake's signer, and different from plain RFC 6979;
 * - protocol buffers: messages encoded by hand from the `.proto` field numbers.
 */
import { describe, expect, it } from 'vitest';
import { HDKey } from '@scure/bip32';
import { mnemonicToSeedSync } from '@scure/bip39';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { hostCommitment, verifyAntiKlepto } from './antiklepto';
import { HWW_CID, MAX_MESSAGE, ReportReader, encodeReports } from './framing';
import { parseInfo, versionAtLeast } from './hww';
import { ReportSplitter } from './link';
import { NoiseXX, noisePublicKey } from './noise';
import { ProtoMessage, Requests, configWithKeypath, multisigConfig, parseResponse, simpleConfig } from './proto';
import { deserializePairing, pairingCode, serializePairing } from './session';
import { messageHash, s2cCommit, s2cSign } from '../test/s2c';

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
const bytes = (h: string) => Uint8Array.from(h.match(/../g) ?? [], (x) => parseInt(x, 16));
const pinned = (seed: number) => Uint8Array.from({ length: 32 }, (_, i) => (seed + i) & 0xff);
const H = 0x80000000;

describe('U2F HID framing', () => {
  it('encodes a 4-byte payload in one report (Rust vector)', () => {
    const out = encodeReports(new Uint8Array([1, 2, 3, 4]), 0x55, 0xeeeeeeee);
    expect(out.length).toBe(64);
    expect(hex(out.subarray(0, 12))).toBe('eeeeeeee5500040102030400');
    expect(hex(out.subarray(12))).toBe('00'.repeat(52));
  });

  it('encodes 65 bytes in two reports (Rust vector), and reads them back', () => {
    const payload = Uint8Array.from({ length: 65 }, (_, i) => i);
    const out = encodeReports(payload, 0x55, 0xeeeeeeee);
    const want = new Uint8Array(128);
    want.set([0xee, 0xee, 0xee, 0xee, 0x55, 0x00, 0x41], 0);
    want.set(payload.subarray(0, 57), 7);
    want.set([0xee, 0xee, 0xee, 0xee, 0x00], 64);
    want.set(payload.subarray(57), 69);
    expect(hex(out)).toBe(hex(want));
    const reader = new ReportReader(0x55, 0xeeeeeeee);
    expect(reader.push(out.slice(0, 64))).toBeUndefined();
    expect(reader.push(out.slice(64))).toEqual(payload);
  });

  it('round-trips the longest message, and refuses longer ones', () => {
    const payload = Uint8Array.from({ length: MAX_MESSAGE }, (_, i) => (i * 7) & 255);
    const out = encodeReports(payload);
    expect(out.length).toBe(129 * 64);
    const reader = new ReportReader();
    let got: Uint8Array | undefined;
    for (let i = 0; i < out.length; i += 64) got = reader.push(out.slice(i, i + 64));
    expect(got).toEqual(payload);
    expect(() => encodeReports(new Uint8Array(MAX_MESSAGE + 1))).toThrow(/too long/);
  });

  it('refuses another channel, another command, and a continuation out of order', () => {
    const two = encodeReports(new Uint8Array(100));
    expect(() => new ReportReader().push(encodeReports(new Uint8Array(1), 0xc1, 0x12345678))).toThrow(/another channel/);
    expect(() => new ReportReader().push(encodeReports(new Uint8Array(1), 0x83, HWW_CID))).toThrow(/command 0x83/);
    const bad = two.slice(64);
    bad[4] = 1;
    const r = new ReportReader();
    r.push(two.slice(0, 64));
    expect(() => r.push(bad)).toThrow(/continuation 1 instead of 0/);
  });

  it('splits a Bluetooth stream into 64-byte reports, whatever the notification sizes', () => {
    const stream = encodeReports(new Uint8Array(150));
    const got: Uint8Array[] = [];
    const s = new ReportSplitter();
    for (const [a, b] of [
      [0, 20],
      [20, 128],
      [128, 192],
    ] as const)
      s.push(stream.slice(a, b), (r) => got.push(r));
    expect(got.map(hex)).toEqual([0, 64, 128].map((i) => hex(stream.slice(i, i + 64))));
  });
});

describe('HWW info', () => {
  it('reads version, platform, edition, lock and setup state', () => {
    const v = new TextEncoder().encode('v9.27.1');
    expect(parseInfo(new Uint8Array([v.length, ...v, 2, 1, 0, 1]))).toEqual({ version: '9.27.1', platform: 'bitbox02-nova', edition: 'btconly', unlocked: false, initialized: true });
    expect(parseInfo(new Uint8Array([v.length, ...v, 0, 0, 1]))).toEqual({ version: '9.27.1', platform: 'bitbox02', edition: 'multi', unlocked: true });
    expect(() => parseInfo(new Uint8Array([v.length, ...v, 7, 0, 1]))).toThrow(/platform 7/);
    expect(() => parseInfo(new Uint8Array([3, 0x39, 0x2e, 0x31, 0, 0, 1]))).toThrow(/version/);
  });

  it('compares versions', () => {
    expect(versionAtLeast('9.27.1', [9, 27, 1])).toBe(true);
    expect(versionAtLeast('9.28.0', [9, 27, 1])).toBe(true);
    expect(versionAtLeast('9.27.0', [9, 27, 1])).toBe(false);
    expect(versionAtLeast('10.0.0', [9, 27, 1])).toBe(true);
    expect(versionAtLeast('9.3', [9, 27, 1])).toBe(false);
  });
});

describe('Noise_XX_25519_ChaChaPoly_SHA256', () => {
  // bitbox-api-ts test/noise.test.ts RUST_VECTOR: keys (seed + i) & 0xff for seeds 1-4.
  const RUST = {
    initPublic: '07a37cbc142093c8b755dc1b10e86cb426374ad16aa853ed0bdfc0b2b86d1c7c',
    respPublic: 'ab9f2628c325c141e9fb2430f106850f62930bc3f0b12df39a9b84a49c7c1d12',
    m1: '909705b0e7d1817db56cdcb89ba2fabad3e9a01b2c23bc73e3ec9d9a2ff9b827',
    m2: '66b76a4535f74c6f464c8f2395cb051864d00279ac88c3fc793fa00352e2ea5ae7550b01c9d07ecb38a558612fbf50090c6b7a691ae5ab5efa1aa477827a9212ebfa78a710281277cade0e21824e94b290841f1a0f21dcca8e9a0129930f118c',
    m3: '53598f877ef0c1da1a52167e6f4688319054686929f9eb86c614bbcd43a6716fcdef48f606d84a24b0343c3959a19d0091eef9199571a72969177c2cc4068b05',
    hash: '51abd3020a6a628a57e58fc28f060428094dc18270c1d3c1f924ddbbd4255a28',
    initSendCiphertext: 'c82c1e7a316c6bb173b8b0c494c4d31a51903400',
  };

  it('replays the Rust transcript byte for byte', () => {
    expect(hex(noisePublicKey(pinned(1)))).toBe(RUST.initPublic);
    expect(hex(noisePublicKey(pinned(2)))).toBe(RUST.respPublic);
    const phone = new NoiseXX(true, pinned(1), pinned(3));
    const bitbox = new NoiseXX(false, pinned(2), pinned(4));
    const m1 = phone.writeMessage();
    expect(hex(m1)).toBe(RUST.m1);
    bitbox.readMessage(m1);
    const m2 = bitbox.writeMessage();
    expect(hex(m2)).toBe(RUST.m2);
    phone.readMessage(m2);
    const m3 = phone.writeMessage();
    expect(hex(m3)).toBe(RUST.m3);
    bitbox.readMessage(m3);
    const a = phone.finish();
    const b = bitbox.finish();
    expect(hex(a.hash)).toBe(RUST.hash);
    expect(hex(b.hash)).toBe(RUST.hash);
    expect(hex(a.remoteStatic)).toBe(RUST.respPublic);
    expect(hex(b.remoteStatic)).toBe(RUST.initPublic);
    const ct = a.send.encrypt(new Uint8Array(0), bytes('deadbeef'));
    expect(hex(ct)).toBe(RUST.initSendCiphertext);
    expect(hex(b.recv.decrypt(new Uint8Array(0), ct))).toBe('deadbeef');
    // The other direction, and the counters.
    expect(hex(a.recv.decrypt(new Uint8Array(0), b.send.encrypt(new Uint8Array(0), bytes('0102'))))).toBe('0102');
    expect(hex(b.recv.decrypt(new Uint8Array(0), a.send.encrypt(new Uint8Array(0), bytes('03'))))).toBe('03');
  });

  it('fails when a message is altered, or replayed', () => {
    const phone = new NoiseXX(true, pinned(1));
    const bitbox = new NoiseXX(false, pinned(2));
    bitbox.readMessage(phone.writeMessage());
    const m2 = bitbox.writeMessage();
    m2[40]! ^= 1;
    expect(() => phone.readMessage(m2)).toThrow(/did not authenticate/);

    const p2 = new NoiseXX(true, pinned(1));
    const b2 = new NoiseXX(false, pinned(2));
    b2.readMessage(p2.writeMessage());
    p2.readMessage(b2.writeMessage());
    b2.readMessage(p2.writeMessage());
    const a = p2.finish();
    const b = b2.finish();
    const ct = a.send.encrypt(new Uint8Array(0), bytes('aa'));
    expect(hex(b.recv.decrypt(new Uint8Array(0), ct))).toBe('aa');
    expect(() => b.recv.decrypt(new Uint8Array(0), ct)).toThrow(/did not authenticate/);
  });

  it('refuses steps out of order', () => {
    const phone = new NoiseXX(true, pinned(1));
    expect(() => phone.readMessage(new Uint8Array(32))).toThrow(/out of order/);
    expect(() => phone.finish()).toThrow(/not complete/);
  });
});

describe('the pairing code', () => {
  it('is the firmware’s format of the handshake hash (workflow/pairing.rs test_confirm)', () => {
    expect(pairingCode(bytes('59289bdbbbb6b68e8f127f49a525b03013500b3c1af2626f4007ebe44f09c86b'))).toBe('LEUJX W53W2\n3I5DY SP5E2');
  });

  it('pairing data survives the key-value store, and junk reads as nothing', () => {
    const d = { appStaticKey: pinned(5), devices: [pinned(6), pinned(7)] };
    expect(deserializePairing(serializePairing(d))).toEqual(d);
    expect(deserializePairing(null)).toEqual({ devices: [] });
    expect(deserializePairing('{"v":1,"key":"xx","devices":["00"]}')).toEqual({ devices: [] });
    expect(deserializePairing('not json')).toEqual({ devices: [] });
  });
});

describe('anti-klepto', () => {
  it('accepts the Rust implementation’s vectors', () => {
    for (const c of [
      {
        hostNonce: '8b4c26aa2695a34bdbc34235f6c91be14b93037a063b13f7c814101359561092',
        signerCommitment: '0236ff92fe02c08d0d04851e0ce1516104085215f05a178307de60ea53e207f971',
        signature: '7fd66b48ffea2fe048869880bbb3a1819e262af14980e8885df1e5765750cb8f47e01eca356377870356d54853573a955076228e5044cd3dd3a049abe70d5585',
      },
      {
        hostNonce: '9c9471aa529fbad96396b9379938e56195c5aa8e1e22b6e87d226e49d8b1f581',
        signerCommitment: '034e2979d398ce029996ffe99dc310a0f2cf9a5411b166f57a85fc3a24985f16be',
        signature: '48cb61d08c730e36b0285dfd9ece91e88a5ec0898d1c80b93e85b967e0ddcd195ab807640347e8f96e3fad67a971fc52eb4f15b4fa65577bcf4a053e598d057d',
      },
    ]) {
      expect(() => verifyAntiKlepto(bytes(c.hostNonce), bytes(c.signerCommitment), bytes(c.signature))).not.toThrow();
      // Another nonce, or another signature, fails.
      const other = bytes(c.hostNonce);
      other[0]! ^= 1;
      expect(() => verifyAntiKlepto(other, bytes(c.signerCommitment), bytes(c.signature))).toThrow(/anti-klepto/);
      const sig = bytes(c.signature);
      sig[5]! ^= 1;
      expect(() => verifyAntiKlepto(bytes(c.hostNonce), bytes(c.signerCommitment), sig)).toThrow(/anti-klepto/);
    }
  });

  it('the fake’s signer commits and signs as the protocol says, and the check catches a device that ignores the nonce', () => {
    const key = pinned(9);
    const z = pinned(10);
    const nonce = pinned(11);
    const R = s2cCommit(key, z, hostCommitment(nonce));
    const good = s2cSign(key, z, nonce);
    expect(() => verifyAntiKlepto(nonce, R, good.signature)).not.toThrow();
    expect(secp256k1.verify(good.signature, z, secp256k1.getPublicKey(key), { prehash: false })).toBe(true);
    const cheat = s2cSign(key, z, new Uint8Array(32));
    expect(() => verifyAntiKlepto(nonce, R, cheat.signature)).toThrow(/not the one committed to/);
  });
});

describe('message signatures without anti-klepto (deterministic, not RFC 6979)', () => {
  // Firmware signmsg.rs tests, keystore `TEST_MNEMONIC`, message "message", host nonce 32 zero bytes.
  const TEST_MNEMONIC = 'purity concert above invest pigeon category peace tuition hazard vivid latin since legal speak nation session onion library travel spell region blast estate stay';
  const root = HDKey.fromMasterSeed(mnemonicToSeedSync(TEST_MNEMONIC));
  const z = messageHash(new TextEncoder().encode('message'));
  it.each([
    ["m/48'/0'/0'/0/0", '10be07206be68b250970f88faee73e666fa7cfc071965889617b68badef5291d2aee2404a36d5e2e43511b03825e146ade250a8a317accb93bfa2ca10dbbeb1301'],
    ["m/45'/0'/0'/0/0", '29eae5774a7cd1393746121a5533a683d7927fe29066982b88b342a52d216217720610ef451ab9d60e8bbe519057c6619d16a06351aa76d695fe6fb13c5b1f1b00'],
    ["m/84'/0'/0'/0/0", '0f1d542a9e2f374efed4578caa8472d1c31268fb892d39a61544591 85b2d354d3b2bfff0e1615c7725734f43134ab4516b7e7cb39d2dbaaa5f4e8b8aff9f97d000'.replace(' ', '')],
  ])('%s matches the firmware', (path, want) => {
    const key = root.derive(path).privateKey!;
    const { signature, recid } = s2cSign(key, z, new Uint8Array(32));
    expect(hex(signature) + recid.toString(16).padStart(2, '0')).toBe(want);
    // Plain RFC 6979 (what Ledger, Trezor, Coldcard and Jade use) gives another signature for the same key and text.
    expect(hex(secp256k1.sign(z, key, { prehash: false }))).not.toBe(want.slice(0, 128));
  });
});

describe('protocol buffers', () => {
  it('encodes requests as the .proto field numbers say', () => {
    // Request { fingerprint (24): {} }
    expect(hex(Requests.fingerprint())).toBe('c20100');
    // Request { btc_pub (8): { coin 1: TBTC=1, keypath 2: packed [48', 1', 0', 2'], xpub_type 3: TPUB=0 (written: oneof) } }
    expect(hex(Requests.xpub(1, [48 + H, 1 + H, H, 2 + H], 0, false))).toBe('421a' + '0801' + '1214' + 'b0808080' + '08' + '81808080' + '08' + '80808080' + '08' + '82808080' + '08' + '1800');
    // Request { btc (25): { antiklepto_signature 7: { host_nonce 1: 32 bytes } } }
    expect(hex(Requests.antikleptoSignature(new Uint8Array(32).fill(0xaa)))).toBe('ca0124' + '3a22' + '0a20' + 'aa'.repeat(32));
    // BTCScriptConfigWithKeypath { script_config 2: { simple_type 1: P2WPKH=1 }, keypath 3: [48'] }
    expect(hex(configWithKeypath(simpleConfig(1), [48 + H]).finish())).toBe('1202' + '0801' + '1a05' + 'b080808008');
    // A P2WPKH_P2SH simple type (0) is still written: it is a oneof member.
    expect(hex(simpleConfig(0).finish())).toBe('0800');
  });

  it('writes the multisig config with each key', () => {
    const x = { depth: 4, parentFingerprint: bytes('01020304'), childNum: 2 + H, chainCode: new Uint8Array(32).fill(1), publicKey: new Uint8Array(33).fill(2) };
    const m = ProtoMessage.parse(multisigConfig({ threshold: 2, xpubs: [x, x, x], ourIndex: 1 }).finish()).message(2)!;
    expect(m.uint(1)).toBe(2);
    expect(m.uint(3)).toBe(1);
    expect(m.has(4)).toBe(false); // P2WSH = 0, the default
    const keys = m.repeatedBytes(2).map((b) => ProtoMessage.parse(b));
    expect(keys).toHaveLength(3);
    expect(keys.map((k) => [hex(k.bytes(1)), hex(k.bytes(2)), k.uint(3), k.bytes(4).length, k.bytes(5).length])).toEqual(Array(3).fill(['04', '01020304', 2 + H, 32, 33]));
  });

  it('reads responses, nested ones included', () => {
    // Response { pub 5: { pub 1: "tpub" } }
    expect(parseResponse(bytes('2a060a0474707562'))).toEqual({ type: 'pub', pub: 'tpub' });
    // Response { error 2: { code 1: 104, message 2: "aborted" } }
    expect(parseResponse(bytes('120b0868120761626f72746564'))).toEqual({ type: 'error', code: 104, message: 'aborted' });
    // Response { btc 13: { sign_next 3: { type 1: HOST_NONCE=6, index 2: 1, signer commitment 6: { 1: 33 bytes } } } }
    const r = parseResponse(bytes('6a2b' + '1a29' + '0806' + '1001' + '3223' + '0a21' + '02'.repeat(33)));
    expect(r).toMatchObject({ type: 'signNext', next: { type: 6, index: 1, hasSignature: false, signerCommitment: new Uint8Array(33).fill(2) } });
    // Response { btc_sign_next 6: {} }: INPUT 0 (all defaults).
    expect(parseResponse(bytes('3200'))).toMatchObject({ type: 'signNext', next: { type: 0, index: 0, hasSignature: false } });
    // Unknown fields are skipped; a truncated message is refused.
    expect(parseResponse(bytes('2a060a0474707562' + 'f80701'))).toMatchObject({ type: 'pub' });
    expect(() => parseResponse(bytes('2a0a0a04'))).toThrow(/truncated/);
  });
});
