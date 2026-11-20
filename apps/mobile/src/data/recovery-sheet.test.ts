/**
 * The printed recovery sheet (`recovery-sheet.ts`): what each wallet's part holds (name, hardware wallet, wallet id,
 * guardian npub and relays, the "Recover on a new phone" code as text and QR code), one page per wallet or one sheet
 * listing them all, the banners, escaping, that nothing secret can reach it, and the demo's. The real service's sheet,
 * with two wallets on a real guardian, is in real-wallets-phase2.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { npubEncode } from 'nostr-tools/nip19';
import { decodeRecoveryUri, encodePairingUri } from '@trikey/protocol';
import { qrSvg } from '@trikey/recovery-key';
import { parseScannedCode } from '@trikey/wallet/scan';
import { createMockWalletService } from './mock';
import { recoverySheetWallet, renderRecoverySheet } from './recovery-sheet';

/** secp256k1's generator x coordinate: a valid x-only key, nobody's guardian. */
const GUARDIAN = '79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798';
const RELAYS = ['wss://relay.example.com', 'wss://nos.lol'];
const DATE = new Date('2026-11-05T09:00:00Z');

const main = () => recoverySheetWallet({ name: 'Main', device: 'Ledger Nano X', walletId: '0123456789abcdef', network: 'testnet', guardianPubkey: GUARDIAN, relays: RELAYS });
const business = () => recoverySheetWallet({ name: 'Business', device: 'Trezor Safe 3', walletId: 'fedcba9876543210', network: 'testnet', guardianPubkey: GUARDIAN, relays: RELAYS });
const count = (html: string, s: string) => html.split(s).length - 1;

describe('recovery sheet: a wallet', () => {
  it("holds the guardian's npub and relays, the wallet id and the code a new phone scans, bound to that wallet", () => {
    const w = main();
    expect(w).toMatchObject({ name: 'Main', device: 'Ledger Nano X', walletId: '0123456789abcdef', network: 'testnet', guardianNpub: npubEncode(GUARDIAN), relays: RELAYS });
    expect(w.hosted).toBeUndefined();
    expect(decodeRecoveryUri(w.recoveryCode)).toEqual({ guardianPubkey: GUARDIAN, relays: RELAYS, network: 'testnet', walletId: '0123456789abcdef' });
    // The app's scanner reads it as the guardian's own "Recover on a new phone" code.
    expect(parseScannedCode(w.recoveryCode, { network: 'testnet' })).toMatchObject({ kind: 'recovery', guardian: { npub: npubEncode(GUARDIAN), relays: RELAYS, walletId: '0123456789abcdef' }, network: 'testnet' });
  });

  it('a hosted wallet says so in its code', () => {
    const w = recoverySheetWallet({ name: 'Mine', device: 'Jade', walletId: '0123456789abcdef', network: 'signet', guardianPubkey: GUARDIAN, relays: RELAYS, hosted: true });
    expect(w.hosted).toBe(true);
    expect(decodeRecoveryUri(w.recoveryCode).hosted).toBe(true);
    expect(renderRecoverySheet([w], { date: DATE }).html).toContain("Your host's guardian waits the security waiting period");
  });

  it('refuses a key, relay or wallet id that is not valid', () => {
    expect(() => recoverySheetWallet({ ...main(), guardianPubkey: 'nope', relays: RELAYS })).toThrow();
    expect(() => recoverySheetWallet({ ...main(), guardianPubkey: GUARDIAN, relays: [] })).toThrow();
    expect(() => recoverySheetWallet({ ...main(), guardianPubkey: GUARDIAN, relays: RELAYS, walletId: 'demo-wallet' })).toThrow();
  });
});

describe('recovery sheet: the page', () => {
  it('one wallet: a sheet named after it, with its QR code, ids and the steps naming its device', () => {
    const w = main();
    const sheet = renderRecoverySheet([w], { layout: 'list', date: DATE });
    // One wallet is one sheet, whatever was asked.
    expect(sheet).toMatchObject({ layout: 'each', date: '2026-11-05', wallets: [w] });
    const { html } = sheet;
    expect(html).toContain('<title>Trikey recovery sheet — &quot;Main&quot;</title>');
    expect(html).toContain('<h1>Trikey recovery sheet — &quot;Main&quot;</h1>');
    expect(html).toContain('Made 2026-11-05 · Network: Testnet');
    expect(html).toContain('TEST NETWORK (Testnet)');
    expect(html).toContain(qrSvg(w.recoveryCode, { ecc: 'medium', title: 'Recovery code of Main' }));
    expect(html).toContain(w.recoveryCode.replace(/&/g, '&amp;'));
    expect(html).toContain('0123 4567 89ab cdef');
    expect(html).toContain(npubEncode(GUARDIAN));
    for (const r of RELAYS) expect(html).toContain(r);
    expect(html).toContain('Approve on the Ledger Nano X.');
    expect(html).toContain('<i>I already have a Trikey wallet</i>, then <i>My phone and its backup</i>');
    expect(html).toContain('nobody can move money with it');
    expect(count(html, 'class="sheet')).toBe(1);
    expect(html).not.toContain('page-break-after: always;"');
    // Self-contained: nothing loaded from anywhere.
    expect(html).not.toMatch(/<script|<link|src=|url\(/i);
  });

  it('several wallets, one page each: a sheet per wallet, a page break between, each with its own code and device', () => {
    const [a, b] = [main(), business()];
    const { html, layout } = renderRecoverySheet([a, b], { layout: 'each', date: DATE });
    expect(layout).toBe('each');
    expect(html).toContain('<title>Trikey recovery sheets</title>');
    expect(count(html, 'class="sheet')).toBe(2);
    expect(count(html, 'class="sheet break"')).toBe(1);
    expect(html).toContain('<h1>Trikey recovery sheet — &quot;Main&quot;</h1>');
    expect(html).toContain('<h1>Trikey recovery sheet — &quot;Business&quot;</h1>');
    expect(html).toContain(qrSvg(a.recoveryCode, { ecc: 'medium', title: 'Recovery code of Main' }));
    expect(html).toContain(qrSvg(b.recoveryCode, { ecc: 'medium', title: 'Recovery code of Business' }));
    expect(html).toContain('Approve on the Trezor Safe 3.');
    expect(html).toContain('fedc ba98 7654 3210');
    expect(count(html, '<ol class="how">')).toBe(2);
    // Business's part comes after the break.
    expect(html.indexOf('class="sheet break"')).toBeLessThan(html.indexOf('Trezor Safe 3'));
  });

  it('several wallets, all on one sheet: one heading, the steps once, a part per wallet with its own code', () => {
    const [a, b] = [main(), business()];
    const { html, layout } = renderRecoverySheet([a, b], { layout: 'list', date: DATE });
    expect(layout).toBe('list');
    expect(count(html, '<h1>')).toBe(1);
    expect(html).toContain('<h1>Trikey recovery sheet — every wallet</h1>');
    expect(html).toContain('2 wallets on one phone');
    expect(count(html, '<ol class="how">')).toBe(1);
    expect(html).toContain("Approve on the wallet&#39;s hardware wallet.");
    expect(count(html, 'class="wallet"')).toBe(2);
    expect(html).toContain('<h2>Main</h2>');
    expect(html).toContain('<h2>Business</h2>');
    expect(html).toContain(a.recoveryCode.replace(/&/g, '&amp;'));
    expect(html).toContain(b.recoveryCode.replace(/&/g, '&amp;'));
    expect(html).not.toContain('class="sheet');
  });

  it('mainnet has no test banner; names are escaped', () => {
    const w = recoverySheetWallet({ name: '<b>Mom & "Dad"</b>', device: 'Coldcard <Q>', walletId: '0123456789abcdef', network: 'bitcoin', guardianPubkey: GUARDIAN, relays: RELAYS });
    const { html } = renderRecoverySheet([w], { date: DATE });
    expect(html).not.toContain('TEST NETWORK');
    expect(html).not.toContain('<b>Mom');
    expect(html).toContain('&lt;b&gt;Mom &amp; &quot;Dad&quot;&lt;/b&gt;');
    expect(html).toContain('Coldcard &lt;Q&gt;');
  });

  it('refuses a code that is not its wallet\'s, a pairing code (it carries a secret), and no wallet at all', () => {
    const w = main();
    expect(() => renderRecoverySheet([{ ...w, walletId: 'fedcba9876543210' }])).toThrow(/does not match/);
    const pairing = encodePairingUri({ guardianPubkey: GUARDIAN, relays: RELAYS, secret: 'a'.repeat(43), expiresAt: 1_900_000_300 }, 1_900_000_000);
    expect(() => renderRecoverySheet([{ ...w, recoveryCode: pairing }])).toThrow();
    expect(() => renderRecoverySheet([{ ...w, recoveryCode: `${w.recoveryCode}&secret=abc` }])).toThrow();
    expect(() => renderRecoverySheet([])).toThrow();
  });

  it('is the same page for the same wallets and day (snapshot)', () => {
    expect(renderRecoverySheet([main(), business()], { layout: 'list', date: DATE }).html).toMatchSnapshot();
  });
});

describe('recovery sheet: the demo', () => {
  it('lists both demo wallets, marked as the demo, one page each or all on one', async () => {
    const svc = createMockWalletService({ networkDelayMs: 0, deviceDelayMs: 0, secondWallet: true });
    const each = svc.recoverySheet!('each')!;
    expect(each).toMatchObject({ demo: true, layout: 'each' });
    expect(each.wallets.map((w) => [w.name, w.device])).toEqual([
      ['Main', svc.getState().hardware.model],
      ['Business', 'Trezor Safe 3'],
    ]);
    expect(each.html).toContain('DEMO. Made-up guardian and wallet ids');
    expect(svc.recoverySheet!('list')!.layout).toBe('list');
  });

  it('the demo as it starts: one wallet, one page', () => {
    const svc = createMockWalletService({ networkDelayMs: 0, deviceDelayMs: 0 });
    expect(svc.recoverySheet!('each')!.wallets.map((w) => w.name)).toEqual(['Main']);
  });
});
