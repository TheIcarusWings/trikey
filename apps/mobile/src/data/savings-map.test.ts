/**
 * The printed Savings wallet map (docs/design/savings-and-limit-off.md, open question 10): what the page holds (title,
 * network, date, wallet id, the descriptor as text and QR code, the three keys, the first address, the instructions and
 * the privacy warning), that it never carries private material even when private material travels with its data, that
 * its keys and first address are the descriptor's own (checked here without Trikey's wallet code), that text is escaped,
 * and that the demo makes one with obviously fake data. The real service's map is in real-savings.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { HDKey } from '@scure/bip32';
import { mnemonicToSeedSync } from '@scure/bip39';
import * as btc from '@scure/btc-signer';
import { getNetwork, keyExpressionFromMaster, sortedMultiDescriptor, type NetworkName } from '@trikey/core';
import { qrMatrix, qrSvg } from '@trikey/recovery-key';
import { createMockWalletService } from './mock';
import { SAVINGS_MAP_QR_ECC, displayPath, groupWalletId, renderSavingsMap, savingsMapData } from './savings-map';
import { DEMO_SAVINGS_ADDRESSES } from './savings-mock';
import type { SavingsMapData } from './types';

const PHONE_MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const HW_MNEMONIC = 'legal winner thank year wave sausage worth useful legal winner thank yellow';
const RK_MNEMONIC = 'zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo wrong';
/** A made-up recovery code, as the phone backup's would look. */
const RECOVERY_CODE = 'TRK1-QWER-TYUI-OPAS-DFGH-JKLZ';
const DATE = new Date('2026-11-01T09:00:00Z');

function savings(networkName: NetworkName) {
  const network = getNetwork(networkName);
  const path = `m/48'/${network.coinType}'/1'/2'`;
  const masters = [PHONE_MNEMONIC, HW_MNEMONIC, RK_MNEMONIC].map((m) => HDKey.fromMasterSeed(mnemonicToSeedSync(m), network.bip32));
  const keys = masters.map((m) => keyExpressionFromMaster(m, path));
  const descriptor = sortedMultiDescriptor(keys);
  const phoneXprv = masters[0]!.derive(path).privateExtendedKey;
  const phoneMasterXprv = masters[0]!.privateExtendedKey;
  return { network, path, keys, descriptor, phoneXprv, phoneMasterXprv };
}

/** Receive address 0, the textbook way: each xpub's /0/0 child, sorted, in a 2-of-3 P2WSH. */
function firstAddressByHand(xpubs: string[], networkName: NetworkName): string {
  const network = getNetwork(networkName);
  const pubs = xpubs.map((x) => HDKey.fromExtendedKey(x, network.bip32).derive('m/0/0').publicKey!);
  pubs.sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
  return btc.p2wsh(btc.p2ms(2, pubs), network.btc).address!;
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

describe('Savings wallet map: the data', () => {
  it("takes each key's fingerprint, path and xpub from the descriptor, in phone, hardware, Recovery Key order, and the first address", () => {
    const s = savings('testnet');
    const data = savingsMapData({ descriptor: s.descriptor, network: 'testnet', walletId: '0123456789abcdef', models: { hardware: 'Ledger Nano X', recoveryKey: 'Trezor Safe 3' } });
    expect(data.keys.map((k) => k.role)).toEqual(['phone', 'hardware', 'recoveryKey']);
    expect(data.keys.map((k) => k.xpub)).toEqual(s.keys.map((k) => k.xpub));
    expect(data.keys.map((k) => k.fingerprint)).toEqual(s.keys.map((k) => k.fingerprint));
    expect(data.keys.every((k) => k.path === "m/48'/1'/1'/2'")).toBe(true);
    expect(data.keys.map((k) => k.model)).toEqual([undefined, 'Ledger Nano X', 'Trezor Safe 3']);
    expect(data.descriptor).toBe(s.descriptor);
    expect(data.firstAddress).toBe(firstAddressByHand(s.keys.map((k) => k.xpub), 'testnet'));
    expect(data.firstAddress).toMatch(/^tb1q/);
  });

  it('on mainnet: xpubs at coin type 0 and a bc1 address', () => {
    const s = savings('bitcoin');
    const data = savingsMapData({ descriptor: s.descriptor, network: 'bitcoin', walletId: '0123456789abcdef' });
    expect(data.keys.every((k) => k.xpub.startsWith('xpub') && k.path === "m/48'/0'/1'/2'")).toBe(true);
    expect(data.firstAddress).toBe(firstAddressByHand(s.keys.map((k) => k.xpub), 'bitcoin'));
    expect(data.firstAddress).toMatch(/^bc1q/);
  });

  it('refuses a descriptor with a bad checksum or a private key', () => {
    const s = savings('testnet');
    const broken = s.descriptor.slice(0, -1) + (s.descriptor.endsWith('q') ? 'p' : 'q');
    expect(() => savingsMapData({ descriptor: broken, network: 'testnet', walletId: '0123456789abcdef' })).toThrow();
    const withPrivate = s.descriptor.replace(s.keys[0]!.xpub, s.phoneXprv);
    expect(() => savingsMapData({ descriptor: withPrivate, network: 'testnet', walletId: '0123456789abcdef' })).toThrow(/public keys only/);
  });

  it('formats the wallet id and paths as the app shows them', () => {
    expect(groupWalletId('0123456789abcdef')).toBe('0123 4567 89ab cdef');
    expect(displayPath('48h/1h/1h/2h')).toBe("m/48'/1'/1'/2'");
  });
});

describe('Savings wallet map: the page', () => {
  const s = savings('testnet');
  const data = savingsMapData({
    descriptor: s.descriptor,
    network: 'testnet',
    walletId: '0123456789abcdef',
    createdAt: '2026-10-02T10:00:00.000Z',
    models: { hardware: 'Ledger Nano X', recoveryKey: 'Trezor Safe 3' },
  });
  const { html, date } = renderSavingsMap(data, { date: DATE });

  it('has the title, the network, the date made, the wallet id', () => {
    expect(date).toBe('2026-11-01');
    expect(html).toContain('<title>Trikey Savings — wallet map</title>');
    expect(html).toContain('<h1>Trikey Savings — wallet map</h1>');
    expect(html).toContain('Made 2026-11-01');
    expect(html).toContain('Network: Testnet');
    expect(html).toContain('TEST NETWORK (Testnet)');
    expect(html).toContain('0123 4567 89ab cdef');
    expect(html).toContain('Savings made 2026-10-02');
  });

  it('has the full descriptor with its checksum, as text and as the QR code', () => {
    expect(s.descriptor).toMatch(/#[a-z0-9]{8}$/);
    expect(html).toContain(esc(s.descriptor));
    expect(html).toContain(qrSvg(s.descriptor, { ecc: SAVINGS_MAP_QR_ECC, title: 'Savings descriptor QR code' }));
    // One code: version 17 at "medium" for a ~460-character descriptor, printed 80 mm wide (about 0.95 mm a module).
    expect(s.descriptor.length).toBeGreaterThan(440);
    expect(qrMatrix(s.descriptor, SAVINGS_MAP_QR_ECC).length).toBe(85);
    expect(html).toContain('.qr { width: 80mm;');
  });

  it('has the three keys: role, device, master fingerprint, path, xpub', () => {
    expect(html).toContain('This phone');
    expect(html).toContain('Hardware wallet<br><span class="small">Ledger Nano X</span>');
    expect(html).toContain('Recovery Key<br><span class="small">Trezor Safe 3</span>');
    for (const k of s.keys) {
      expect(html).toContain(`<td class="mono">${k.fingerprint}</td>`);
      expect(html).toContain(`<td class="mono xpub">${k.xpub}</td>`);
    }
    expect(html.split(`<td class="mono">${esc("m/48'/1'/1'/2'")}</td>`).length - 1).toBe(3);
  });

  it('has the first receive address and the instructions, with the privacy warning', () => {
    expect(html).toContain(data.firstAddress);
    expect(html).toContain('This sheet is not a key: nobody can spend with this sheet alone.');
    expect(html).toContain('Sparrow or Bitcoin Core');
    expect(html).toContain('two of the three keys');
    expect(html).toContain('Keep this sheet with your Recovery Key or with your papers.');
    expect(html).toContain("The phone's key comes from the phone backup");
    expect(html).toContain('Any two of the three keys move the money');
    expect(html).toContain("Anyone who reads this sheet can see Savings' balance and every payment into and out of it");
  });

  it('is self-contained: no script, no remote resource', () => {
    // The QR code's SVG namespace is a name, not something fetched.
    expect(html.replaceAll('xmlns="http://www.w3.org/2000/svg"', '')).not.toMatch(/<script|<link|<img|src=|url\(|https?:\/\//i);
  });

  it('never carries private material, even when it travels with the data', () => {
    const tainted = { ...data, mnemonic: PHONE_MNEMONIC, xprv: s.phoneXprv, masterXprv: s.phoneMasterXprv, recoveryCode: RECOVERY_CODE, seed: mnemonicToSeedSync(PHONE_MNEMONIC) } as SavingsMapData;
    const page = renderSavingsMap(tainted, { date: DATE }).html;
    for (const secret of [PHONE_MNEMONIC, s.phoneXprv, s.phoneMasterXprv, RECOVERY_CODE, 'abandon abandon', 'TRK1-']) expect(page).not.toContain(secret);
    expect(page).not.toMatch(/[xtuvyzUVYZ]prv/);
    expect(page).toBe(html);
  });

  it('refuses a private key in place of an xpub, or in the descriptor', () => {
    const swapped: SavingsMapData = { ...data, keys: data.keys.map((k) => (k.role === 'phone' ? { ...k, xpub: s.phoneXprv } : k)) };
    expect(() => renderSavingsMap(swapped)).toThrow(/public keys only/);
    expect(() => renderSavingsMap({ ...data, descriptor: data.descriptor.replace(s.keys[0]!.xpub, s.phoneXprv) })).toThrow(/public keys only/);
    expect(() => renderSavingsMap({ ...data, keys: data.keys.slice(0, 2) })).toThrow(/three keys/);
  });

  it('escapes every text it is given', () => {
    const hostile: SavingsMapData = {
      ...data,
      walletId: '<b>id</b>',
      keys: data.keys.map((k) => (k.role === 'hardware' ? { ...k, model: '<script>alert("x")</script> & Co' } : k)),
    };
    const page = renderSavingsMap(hostile, { date: DATE }).html;
    expect(page).not.toContain('<script>');
    expect(page).not.toContain('<b>id</b>');
    expect(page).toContain('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; Co');
    expect(page).toContain('&lt;b&gt;i d&lt;');
  });

  it('on mainnet: no test network banner', () => {
    const m = savings('bitcoin');
    const page = renderSavingsMap(savingsMapData({ descriptor: m.descriptor, network: 'bitcoin', walletId: '0123456789abcdef' }), { date: DATE }).html;
    expect(page).toContain('Network: Bitcoin');
    expect(page).not.toContain('TEST NETWORK');
    expect(page).not.toContain('DEMO');
    expect(page).toContain('your hardware wallet');
  });
});

describe('Savings wallet map: the demo', () => {
  it('has none before Savings, then one with obviously fake data, marked as the demo', async () => {
    const wallet = createMockWalletService({ deviceDelayMs: 0, networkDelayMs: 0 });
    const sv = wallet.savings!;
    expect(sv.walletMap()).toBeNull();
    await sv.start();
    await sv.connectHardware();
    await sv.connectRecoveryKey('trezor');
    const done = await sv.finish();
    const map = sv.walletMap()!;
    expect(map.demo).toBe(true);
    expect(map.descriptor).toBe(done.descriptor);
    expect(map.firstAddress).toBe(DEMO_SAVINGS_ADDRESSES[0]);
    expect(map.keys.map((k) => k.role)).toEqual(['phone', 'hardware', 'recoveryKey']);
    expect(map.keys.every((k) => k.xpub.startsWith('tpubDEMO') && k.path === "m/48'/1'/1'/2'")).toBe(true);
    expect(map.keys[2]!.model).toBe('Trezor Safe 3');
    expect(map.html).toContain('DEMO. Made-up keys and addresses');
    expect(map.html).toContain(esc(done.descriptor));
    expect(map.html).toContain(map.keys[0]!.xpub);
  });
});
