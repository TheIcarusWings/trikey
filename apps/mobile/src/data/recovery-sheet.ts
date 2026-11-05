/**
 * The printed recovery sheet (docs/design/multi-wallet.md, "per-wallet recovery sheets"): what a new phone needs to find
 * a wallet's guardian when this phone and its backup are both gone. Per wallet: its name and hardware wallet, its
 * guardian's npub and relays, its wallet id, and its "Recover on a new phone" code (`trikey://recover?...&wallet=<id>`,
 * the code the guardian's page shows) as text and as a QR code, which "I already have a Trikey wallet" > "My phone and
 * its backup" scans.
 *
 * With several wallets the person prints one sheet per wallet (each kept with that wallet's hardware wallet: one page
 * each, `each`) or one sheet listing them all (`list`). One self-contained page (no fonts, images or scripts from
 * anywhere), in the Recovery Kit's and the Savings map's style, printed in memory as they are (`printPage`).
 *
 * It holds no secret: an npub, relay addresses and wallet ids are public, and the page is built only from the named
 * fields of `RecoverySheetWallet`, so nothing else can reach it; a code carrying anything secret is refused outright.
 * Nobody can move money with it: the recovery it starts needs the wallet's hardware wallet, waits the recovery delay and
 * tells the alert contacts.
 */
import { npubEncode } from 'nostr-tools/nip19';
import { decodeRecoveryUri, encodeRecoveryUri } from '@trikey/protocol';
import { qrSvg } from '@trikey/recovery-key';
import { groupWalletId } from './savings-map';
import type { NetworkName, RecoverySheet, RecoverySheetLayout, RecoverySheetWallet } from './types';

const NETWORK_LABEL: Record<NetworkName, string> = { bitcoin: 'Bitcoin', testnet: 'Testnet', signet: 'Signet', regtest: 'Regtest' };

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** One wallet's part of the sheet, from what the phone knows of it. Throws on a guardian key, relay or id that is not valid. */
export function recoverySheetWallet(input: {
  name: string;
  device: string;
  walletId: string;
  network: NetworkName;
  /** The guardian's nostr public key, hex. */
  guardianPubkey: string;
  relays: readonly string[];
  /** A wallet hosted on someone else's guardian: its code says so (the new phone asks the host). */
  hosted?: boolean;
}): RecoverySheetWallet {
  const recoveryCode = encodeRecoveryUri({
    guardianPubkey: input.guardianPubkey,
    relays: [...input.relays],
    network: input.network,
    walletId: input.walletId,
    ...(input.hosted ? { hosted: true as const } : {}),
  });
  const decoded = decodeRecoveryUri(recoveryCode);
  return {
    name: input.name,
    device: input.device,
    walletId: input.walletId,
    network: input.network,
    guardianNpub: npubEncode(input.guardianPubkey),
    relays: decoded.relays,
    recoveryCode,
    ...(input.hosted ? { hosted: true as const } : {}),
  };
}

/** Refuses anything that is not plainly public before it reaches the page: each code must be a recovery code, nothing else. */
function assertPublic(wallets: readonly RecoverySheetWallet[]): void {
  if (!wallets.length) throw new Error('A recovery sheet needs at least one wallet.');
  for (const w of wallets) {
    const p = decodeRecoveryUri(w.recoveryCode); // refuses a pairing code and anything with a secret
    if (p.walletId !== w.walletId || npubEncode(p.guardianPubkey) !== w.guardianNpub) throw new Error('The recovery code does not match its wallet.');
    if (/nsec1|prv[0-9A-Za-z]{20}|secret=/i.test(JSON.stringify(w))) throw new Error('A recovery sheet holds public data only.');
  }
}

/** The steps on a new phone, for one wallet (its device named), or for any of them ("the wallet's hardware wallet"). */
function steps(w: { device: string; hosted?: boolean }): string[] {
  const device = esc(w.device);
  return [
    `<b>This sheet is not a key: nobody can move money with it.</b> It tells a new phone where this wallet's guardian lives.`,
    `If you lose this phone <b>and</b> its backup: install Trikey on a new phone, choose <i>I already have a Trikey wallet</i>, then <i>My phone and its backup</i>, and scan this code (or type the npub and relays below).`,
    `Approve on the ${device}. ${w.hosted ? "Your host's guardian" : 'The guardian'} waits the recovery delay and tells your alert contacts, then moves the money to a new wallet of the new phone and the ${device}.`,
    `Lost the backup only? Make a new one from the phone instead. Lost the ${device}? Recover from this phone: you don't need this sheet.`,
    `Keep this sheet with the ${device} or with your papers. Don't keep it with any seed words.`,
  ];
}

/** One wallet as a block of the page: name, device, ids, the code (QR and text), and with `steps` what to do. */
function walletBlock(w: RecoverySheetWallet, opts: { qrMm: number; steps: boolean; page: boolean }): string {
  const svg = qrSvg(w.recoveryCode, { ecc: 'medium', title: `Recovery code of ${w.name}` });
  return `<section class="wallet${opts.page ? ' page' : ''}">
<h2>${esc(w.name)}</h2>
<div class="top">
<div class="qr" style="width:${opts.qrMm}mm">${svg}</div>
<div class="facts">
<table>
<tr><th>Wallet</th><td>${esc(w.name)}</td></tr>
<tr><th>Hardware wallet</th><td>${esc(w.device)}</td></tr>
<tr><th>Wallet id</th><td class="mono">${esc(groupWalletId(w.walletId))}</td></tr>
<tr><th>Guardian (npub)</th><td class="mono brk">${esc(w.guardianNpub)}</td></tr>
<tr><th>Relays</th><td class="mono brk">${w.relays.map(esc).join('<br>')}</td></tr>
${w.hosted ? '<tr><th>Guardian</th><td>Hosted by someone else (your host)</td></tr>' : ''}
</table>
</div>
</div>
${opts.steps ? `<ol class="how">${steps(w).map((s) => `<li>${s}</li>`).join('')}</ol>` : ''}
<p class="small">Recovery code (the QR code holds exactly this text):</p>
<p class="mono code">${esc(w.recoveryCode)}</p>
</section>`;
}

/**
 * Renders the sheet as a printable page (A4 or Letter, black on white). `each`: one page per wallet, each with the steps;
 * `list`: every wallet on one sheet, the steps once. The date is the day it is made (default today).
 */
export function renderRecoverySheet(wallets: readonly RecoverySheetWallet[], opts: { layout?: RecoverySheetLayout; date?: Date; demo?: boolean } = {}): RecoverySheet {
  assertPublic(wallets);
  const layout: RecoverySheetLayout = wallets.length > 1 ? (opts.layout ?? 'each') : 'each';
  const date = (opts.date ?? new Date()).toISOString().slice(0, 10);
  const network = NETWORK_LABEL[wallets[0]!.network];
  const testnet = wallets[0]!.network !== 'bitcoin';
  const several = wallets.length > 1;
  const title = several ? (layout === 'list' ? 'Trikey recovery sheet — every wallet' : 'Trikey recovery sheets') : `Trikey recovery sheet — "${wallets[0]!.name}"`;
  const banners = `${opts.demo ? `<p class="demo">DEMO. Made-up guardian and wallet ids from Trikey's demo mode: nothing to recover.</p>` : ''}
${testnet ? `<p class="test">TEST NETWORK (${esc(network)}). These wallets do not hold real bitcoin.</p>` : ''}`;
  const header = (name?: string) => `<header>
<h1>${esc(name ? `Trikey recovery sheet — "${name}"` : title)}</h1>
<p class="meta">Made ${esc(date)} · Network: ${esc(network)}${several && layout === 'list' ? ` · ${wallets.length} wallets on one phone` : ''}</p>
</header>
${banners}`;
  const footer = `<footer>Trikey · Recovery sheet · No private keys, seed words, passphrases or backup recovery codes on this page · Recovery sheet format 1</footer>`;

  const body =
    layout === 'list'
      ? `${header()}
<p class="note">One phone holds these wallets, each with its own hardware wallet. To recover one, follow the steps below with its code and its hardware wallet. The steps are the same for each.</p>
<ol class="how">${steps({ device: "wallet's hardware wallet", hosted: wallets.every((w) => w.hosted) }).map((s) => `<li>${s}</li>`).join('')}</ol>
${wallets.map((w) => walletBlock(w, { qrMm: 38, steps: false, page: false })).join('\n')}
${footer}`
      : wallets.map((w, i) => `<div class="sheet${i < wallets.length - 1 ? ' break' : ''}">
${header(w.name)}
${walletBlock(w, { qrMm: 60, steps: true, page: true })}
${footer}
</div>`).join('\n');

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>
@page { size: auto; margin: 12mm; }
* { box-sizing: border-box; }
html, body { margin: 0; background: #fff; color: #000; }
body { font: 10pt/1.4 -apple-system, "Helvetica Neue", Helvetica, Arial, sans-serif; padding: 16px; max-width: 190mm; margin: 0 auto; }
h1 { font-size: 19pt; margin: 0 0 2px; letter-spacing: -0.01em; }
h2 { font-size: 12pt; margin: 14px 0 6px; }
p { margin: 0 0 6px; }
.meta { font-size: 9.5pt; }
.mono { font-family: ui-monospace, Menlo, Consolas, "Courier New", monospace; }
.test, .demo { border: 2px solid #000; padding: 6px 10px; margin: 8px 0; font-weight: 700; }
.break { break-after: page; page-break-after: always; }
.wallet { border-top: 1px solid #000; padding-top: 4px; break-inside: avoid; page-break-inside: avoid; }
.top { display: flex; gap: 16px; align-items: flex-start; flex-wrap: wrap; }
.qr { max-width: 100%; flex: none; }
.qr svg { display: block; width: 100%; height: auto; }
.facts { flex: 1; min-width: 200px; }
.how { margin: 8px 0; padding-left: 18px; }
.how li { margin-bottom: 4px; }
table { width: 100%; border-collapse: collapse; font-size: 9pt; }
th, td { text-align: left; vertical-align: top; border-bottom: 1px solid #999; padding: 3px 6px 3px 0; }
th { font-weight: 600; white-space: nowrap; width: 32%; }
.brk, .code { word-break: break-all; }
.code { font-size: 8pt; border: 1px solid #999; padding: 6px; }
.small { font-size: 8.5pt; }
footer { margin-top: 12px; font-size: 8.5pt; border-top: 1px solid #000; padding-top: 6px; }
</style>
</head>
<body>
${body}
</body>
</html>
`;
  return { layout, wallets: [...wallets], html, date, ...(opts.demo ? { demo: true as const } : {}) };
}
