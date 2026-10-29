import { describe, expect, it } from 'vitest';
import { base32nopad } from '@scure/base';
import { decodeQR } from 'qr/decode.js';
import { MultisigWallet } from '@trikey/core';
import {
  KIT_QR_PREFIX,
  SEED_KIT_MAP_WORDS,
  XPUB_KIT_WORDS,
  decodeKit,
  decodeKitBytes,
  encodeKitBytes,
  kitFingerprint,
  kitFromMnemonicAndDescriptor,
  kitMnemonic,
  kitQrText,
  kitVault,
  kitWords,
  wipeKit,
  type RecoveryKit,
} from '../src/kit.js';
import { qrMatrix, renderKit } from '../src/kit-print.js';
import { BIP39_WORDLIST } from '../src/keys.js';
import { MNEMONICS, deviceKey, device, fixtureKeys, fixtureKit, rejects } from './helpers.js';

/** Rasterizes a QR matrix (4 px per module, 4-module quiet zone) to RGBA. */
function raster(m: boolean[][], damage?: (x: number, y: number) => boolean | undefined) {
  const scale = 4;
  const n = m.length + 8;
  const w = n * scale;
  const data = new Uint8Array(w * w * 4);
  for (let py = 0; py < w; py++)
    for (let px = 0; px < w; px++) {
      const mx = Math.floor(px / scale) - 4;
      const my = Math.floor(py / scale) - 4;
      let dark = mx >= 0 && my >= 0 && mx < m.length && my < m.length && m[my]![mx]!;
      const d = damage?.(mx, my);
      if (d !== undefined) dark = d;
      const v = dark ? 0 : 255;
      const o = (py * w + px) * 4;
      data[o] = data[o + 1] = data[o + 2] = v;
      data[o + 3] = 255;
    }
  return { width: w, height: w, data };
}

const same = (a: RecoveryKit, b: RecoveryKit) => {
  expect(b.network).toBe(a.network);
  expect(b.creationHeight).toBe(a.creationHeight);
  expect(b.phone).toEqual(a.phone);
  expect(b.hardware).toEqual(a.hardware);
  expect(kitVault(b).descriptor()).toBe(kitVault(a).descriptor());
};

describe('Recovery Kit payload', () => {
  it('round-trips through bytes, the QR text and the words', async () => {
    const kit = await fixtureKit();
    const bytes = encodeKitBytes(kit);
    expect(bytes.length).toBe(6 + 17 + 74 + 74 + 4);
    same(kit, decodeKitBytes(bytes));

    const qr = kitQrText(kit);
    expect(qr.startsWith(KIT_QR_PREFIX)).toBe(true);
    expect(qr).toMatch(/^[0-9A-Z $%*+\-./:]+$/); // QR alphanumeric mode
    same(kit, decodeKit(qr));
    same(kit, decodeKit(`  ${qr.toLowerCase()}\n`));

    const { recoveryWords, mapWords } = kitWords(kit);
    expect(recoveryWords).toHaveLength(12);
    expect(mapWords).toHaveLength(SEED_KIT_MAP_WORDS);
    expect(SEED_KIT_MAP_WORDS).toBe(116);
    expect(recoveryWords.join(' ')).toBe(kitMnemonic(kit));
    const back = decodeKit([...recoveryWords, ...mapWords].join(' '));
    same(kit, back);
    expect(back.recoveryKey).toEqual(kit.recoveryKey);
  });

  it('rebuilds the exact vault descriptor, so the fingerprint matches the wallet', async () => {
    const { vault } = await fixtureKeys();
    const kit = await fixtureKit();
    expect(kitVault(kit).descriptor()).toBe(vault.descriptor());
    expect(kitFingerprint(kit)).toBe(vault.fingerprint().match(/.{4}/g)!.join(' '));
    expect(kitVault(kit).derive(0, 3).address).toBe(vault.derive(0, 3).address);
  });

  it('reads typed words with numbering, odd spacing, capitals and four-letter abbreviations', async () => {
    const kit = await fixtureKit();
    const { recoveryWords, mapWords } = kitWords(kit);
    const all = [...recoveryWords, ...mapWords];
    const typed = all.map((w, i) => `${i + 1}${i % 2 ? ')' : '.'} ${i % 3 === 0 ? w.slice(0, 4).toUpperCase() : w}${i % 4 === 3 ? '\n' : '   '}`).join('');
    same(kit, decodeKit(typed));
    // The two blocks in the other order.
    same(kit, decodeKit([...mapWords, ...recoveryWords].join(' ')));
  });

  it('round-trips a wallet map whose key 3 is a second hardware wallet', async () => {
    const { phone, hardware } = await fixtureKeys();
    const rkKey = await deviceKey(device(MNEMONICS.rkDevice));
    const kit: RecoveryKit = { network: 'regtest', creationHeight: 0, recoveryKey: { kind: 'xpub', key: rkKey }, phone: phone.vault, hardware };
    const words = kitWords(kit);
    expect(words.recoveryWords).toEqual([]);
    expect(words.mapWords).toHaveLength(XPUB_KIT_WORDS);
    const back = decodeKit(words.mapWords.join(' '));
    expect(back.recoveryKey).toEqual(kit.recoveryKey);
    same(kit, decodeKit(kitQrText(kit)));
    expect(kitVault(back).keys.cosigner).toEqual(rkKey);
    expect(() => kitMnemonic(back)).toThrow(/wallet map/);
  });
});

describe('damaged or wrong kits', () => {
  it('fails the checksum on any changed byte', async () => {
    const bytes = encodeKitBytes(await fixtureKit());
    for (const i of [2, 7, 30, 100, bytes.length - 1]) {
      const bad = bytes.slice();
      bad[i]! ^= 0x01;
      expect((await rejects(() => decodeKitBytes(bad))).code).toBe('kit_checksum');
    }
  });

  it('refuses unknown versions, encryption, reserved flags, unknown networks and wrong lengths', async () => {
    const bytes = encodeKitBytes(await fixtureKit());
    const v2 = bytes.slice();
    v2[0] = 2;
    expect((await rejects(() => decodeKitBytes(v2))).message).toMatch(/version 2/);
    const enc = bytes.slice();
    enc[1]! |= 0x20;
    expect((await rejects(() => decodeKitBytes(enc))).message).toMatch(/encrypted/);
    const res = bytes.slice();
    res[1]! |= 0x80;
    expect((await rejects(() => decodeKitBytes(res))).code).toBe('kit_invalid');
    const net = bytes.slice();
    net[1] = (net[1]! & 0xf0) | 0x9;
    expect((await rejects(() => decodeKitBytes(net))).message).toMatch(/unknown network/);
    expect((await rejects(() => decodeKitBytes(bytes.slice(0, -1)))).code).toBe('kit_invalid');
    expect((await rejects(() => decodeKit(KIT_QR_PREFIX + base32nopad.encode(bytes.slice(0, 40))))).code).toBe('kit_invalid');
  });

  it('catches a misread QR character', async () => {
    const qr = kitQrText(await fixtureKit());
    const i = KIT_QR_PREFIX.length + 50;
    const bad = qr.slice(0, i) + (qr[i] === 'A' ? 'B' : 'A') + qr.slice(i + 1);
    expect((await rejects(() => decodeKit(bad))).code).toBe('kit_checksum');
    expect((await rejects(() => decodeKit(qr.slice(0, i) + '1' + qr.slice(i + 1)))).code).toBe('kit_checksum');
  });

  it('points at a word that is not in the list, and catches valid but wrong words', async () => {
    const { recoveryWords, mapWords } = kitWords(await fixtureKit());
    const typo = [...recoveryWords, ...mapWords];
    typo[20] = 'bitcoinz';
    const e = await rejects(() => decodeKit(typo.join(' ')));
    expect(e.code).toBe('kit_word');
    expect(e.detail?.position).toBe(21);

    // A wrong but valid map word: the kit checksum catches it.
    const swapped = [...recoveryWords, ...mapWords];
    swapped[40] = swapped[40] === 'abandon' ? 'ability' : 'abandon';
    expect((await rejects(() => decodeKit(swapped.join(' ')))).code).toBe('kit_checksum');

    // A wrong Recovery Key word: BIP 39's own checksum (or the kit's) catches it.
    const rk = [...recoveryWords, ...mapWords];
    rk[3] = BIP39_WORDLIST[(BIP39_WORDLIST.indexOf(rk[3]!) + 1) % 2048]!;
    expect((await rejects(() => decodeKit(rk.join(' ')))).code).toBe('kit_checksum');

    // Words from another kit's map with these Recovery Key words.
    const other = await fixtureKit(813);
    const mixed = [...recoveryWords, ...kitWords(other).mapWords.slice(0, 50), ...mapWords.slice(50)];
    expect((await rejects(() => decodeKit(mixed.join(' ')))).code).toBe('kit_checksum');

    expect((await rejects(() => decodeKit(recoveryWords.join(' ')))).code).toBe('kit_invalid');
  });

  it('wipes the secret in place', async () => {
    const kit = await fixtureKit();
    wipeKit(kit);
    expect(kit.recoveryKey.kind === 'seed' && kit.recoveryKey.entropy.every((b) => b === 0)).toBe(true);
  });
});

describe('the printed QR code', () => {
  it('scans back to the kit, and still scans with a quarter of a corner region blotted out', async () => {
    const kit = await fixtureKit();
    const text = kitQrText(kit);
    const m = qrMatrix(text);
    expect(m.length).toBeLessThanOrEqual(69);
    expect(decodeQR(raster(m))).toBe(text);
    // An ink blot over a block of the data area (well within 25% error correction).
    const n = m.length;
    const blot = (x: number, y: number) => (x >= n - 20 && x < n - 8 && y >= n - 20 && y < n - 12 ? true : undefined);
    const scanned = decodeQR(raster(m, blot));
    same(kit, decodeKit(scanned));
  });

  it('does not scan when heavily damaged: the words are the fallback', async () => {
    const kit = await fixtureKit();
    const m = qrMatrix(kitQrText(kit));
    const n = m.length;
    const ruined = (x: number, y: number) => (x >= 10 && x < n - 10 && y >= 10 && y < n - 10 ? (x * 7 + y * 13) % 3 === 0 : undefined);
    expect(() => decodeQR(raster(m, ruined))).toThrow();
    const { recoveryWords, mapWords } = kitWords(kit);
    same(kit, decodeKit([...recoveryWords, ...mapWords].join(' ')));
  });
});

describe('words plus descriptor (other wallet software)', () => {
  it('rebuilds the kit from the 12 words and the printed descriptor', async () => {
    const kit = await fixtureKit(900);
    const desc = kitVault(kit).descriptor();
    const back = kitFromMnemonicAndDescriptor(kitMnemonic(kit), desc, 'regtest', 900);
    same(kit, back);
    const e = await rejects(() => kitFromMnemonicAndDescriptor(MNEMONICS.rkDevice, desc, 'regtest'));
    expect(e.code).toBe('kit_mismatch');
    expect((await rejects(() => kitFromMnemonicAndDescriptor(kitMnemonic(kit), desc.slice(0, -1) + (desc.endsWith('x') ? 'q' : 'x'), 'regtest'))).code).toBe('kit_invalid');
  });
});

describe('printable layout', () => {
  it('holds the title, date, network, fingerprint, QR, words and the instructions', async () => {
    const kit = await fixtureKit();
    const p = renderKit(kit, { date: new Date('2026-10-29T12:00:00Z'), hardwareName: 'Ledger', walletName: 'Family <savings>' });
    expect(p.html).toContain('<title>Trikey Recovery Kit</title>');
    expect(p.html).toContain('2026-10-29');
    expect(p.html).toContain('Network: Regtest');
    expect(p.html).toContain('TEST NETWORK');
    expect(p.html).toContain(p.fingerprint);
    expect(p.html).toContain("Keep this sheet apart from your Ledger's seed words.");
    expect(p.html).toContain('Family &lt;savings&gt;');
    expect(p.html).toContain('<svg');
    for (const w of [...p.recoveryWords, ...p.mapWords]) expect(p.html).toContain(w);
    expect(p.html).toContain(p.descriptor.replace(/</g, '&lt;').replace(/>/g, '&gt;'));
    // Self-contained: nothing loaded from anywhere.
    expect(p.html.replace('http://www.w3.org/2000/svg', '')).not.toMatch(/https?:|<script|<link|@import|url\(/);
    expect(p.qrText).toBe(kitQrText(kit));
    expect(MultisigWallet.fromDescriptor(p.descriptor, kitVault(kit).network).fingerprint()).toBe(kitVault(kit).fingerprint());
  });

  it('prints a wallet map (no secret) for a hardware Recovery Key', async () => {
    const { phone, hardware } = await fixtureKeys();
    const rkKey = await deviceKey(device(MNEMONICS.rkDevice));
    const p = renderKit({ network: 'regtest', creationHeight: 5, recoveryKey: { kind: 'xpub', key: rkKey }, phone: phone.vault, hardware });
    expect(p.html).toContain('Trikey Wallet Map');
    expect(p.html).toContain('This sheet holds no key.');
    expect(p.recoveryWords).toEqual([]);
  });
});
