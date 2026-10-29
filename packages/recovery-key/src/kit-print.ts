/**
 * The printable Recovery Kit: one self-contained HTML page (no fonts, images
 * or scripts from anywhere) that the phone hands to the share sheet or the
 * print dialog, plus the QR code alone as SVG.
 *
 * The page holds key 3 in the clear. The app must not save it: render, print
 * or share, then drop it.
 */
import { encodeQR, type ErrorCorrection } from 'qr';
import { bip48Path, getNetwork } from '@trikey/core';
import { kitFingerprint, kitQrText, kitRecoveryKeyExpression, kitVault, kitWords, type RecoveryKit } from './kit.js';

/** 25% of the code can be lost and it still reads: a 65x65 module code for a seed kit. */
export const KIT_QR_ECC: ErrorCorrection = 'quartile';

/** The QR code as the module matrix (true = dark), without the quiet zone. */
export function qrMatrix(text: string, ecc: ErrorCorrection = KIT_QR_ECC): boolean[][] {
  const m = encodeQR(text, 'raw', { ecc, border: 1 });
  return m.slice(1, -1).map((row) => row.slice(1, -1));
}

/** An SVG of `text` as a QR code with a 4-module quiet zone; one path, crisp edges, scales to any size. */
export function qrSvg(text: string, opts: { ecc?: ErrorCorrection; sizeMm?: number; title?: string } = {}): string {
  const m = qrMatrix(text, opts.ecc);
  const n = m.length + 8;
  let d = '';
  m.forEach((row, y) => {
    let x = 0;
    while (x < row.length) {
      if (!row[x]) {
        x++;
        continue;
      }
      let run = 1;
      while (row[x + run]) run++;
      d += `M${x + 4} ${y + 4}h${run}v1h-${run}z`;
      x += run;
    }
  });
  const size = opts.sizeMm ? ` width="${opts.sizeMm}mm" height="${opts.sizeMm}mm"` : '';
  const title = opts.title ? `<title>${esc(opts.title)}</title>` : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n} ${n}"${size} shape-rendering="crispEdges" role="img">${title}<rect width="${n}" height="${n}" fill="#fff"/><path fill="#000" d="${d}"/></svg>`;
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

const NETWORK_LABEL = { bitcoin: 'Bitcoin', testnet: 'Testnet', signet: 'Signet', regtest: 'Regtest' } as const;

export interface KitPrintOptions {
  /** Shown as the kit's date (default: now). */
  date?: Date;
  /** A name the user gave the wallet, shown under the title. */
  walletName?: string;
  /** The hardware wallet's name, used in the instructions ("your Ledger"). Default "hardware wallet". */
  hardwareName?: string;
}

export interface PrintableKit {
  /** The whole page, ready to print or share. Holds key 3: do not store it. */
  html: string;
  /** The QR code alone. */
  qrSvg: string;
  qrText: string;
  recoveryWords: string[];
  mapWords: string[];
  descriptor: string;
  /** The vault fingerprint ("ab12 cd34 ef56 7890"), also shown in the app. */
  fingerprint: string;
  network: RecoveryKit['network'];
  date: string;
  kind: 'seed' | 'xpub';
}

function wordList(words: string[], start = 1): string {
  return words.map((w, i) => `<li><span class="n">${i + start}</span>${esc(w)}</li>`).join('');
}

/** Renders the kit as a printable page (A4 or Letter, black on white). */
export function renderKit(kit: RecoveryKit, opts: KitPrintOptions = {}): PrintableKit {
  const date = (opts.date ?? new Date()).toISOString().slice(0, 10);
  const network = getNetwork(kit.network);
  const qrText = kitQrText(kit);
  const svg = qrSvg(qrText, { title: 'Trikey Recovery Kit QR code' });
  const { recoveryWords, mapWords } = kitWords(kit);
  const descriptor = kitVault(kit).descriptor();
  const fingerprint = kitFingerprint(kit);
  const rk = kitRecoveryKeyExpression(kit);
  const hw = esc(opts.hardwareName ?? 'hardware wallet');
  const seed = kit.recoveryKey.kind === 'seed';
  const testnet = kit.network !== 'bitcoin';
  const title = seed ? 'Trikey Recovery Kit' : 'Trikey Wallet Map';
  const path = `m/48'/${network.coinType}'/${seed ? (kit.recoveryKey as { account: number }).account : 0}'/2'`;

  const instructions = seed
    ? [
        `<b>Keep this sheet apart from your ${hw}'s seed words.</b> Anyone who has both can take your money.`,
        `Keep it away from your phone too. Don't photograph it, scan it into a computer or save it in the cloud.`,
        `On its own it moves nothing. With your phone or your ${hw}, it moves everything right away. There is no waiting period.`,
        `To recover, open Trikey, choose <b>Recover with your Recovery Kit</b> and scan the QR code. If the code is damaged, type all the words, the 12 Recovery Key words first.`,
        `Check that the wallet fingerprint above matches the one in Trikey's settings.`,
      ]
    : [
        `This sheet holds no key. Your Recovery Key is your second hardware wallet (fingerprint ${esc(rk.fingerprint)}).`,
        `Keep that device apart from your ${hw}'s seed words. Anyone who has both can take your money.`,
        `To recover, open Trikey, choose <b>Recover with your Recovery Kit</b>, scan this QR code and connect the second hardware wallet.`,
        `Check that the wallet fingerprint above matches the one in Trikey's settings.`,
      ];

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>
@page { size: auto; margin: 12mm; }
* { box-sizing: border-box; }
html, body { margin: 0; background: #fff; color: #000; }
body { font: 10.5pt/1.4 -apple-system, "Helvetica Neue", Helvetica, Arial, sans-serif; padding: 16px; max-width: 190mm; margin: 0 auto; }
h1 { font-size: 20pt; margin: 0 0 2px; letter-spacing: -0.01em; }
h2 { font-size: 11pt; margin: 14px 0 6px; text-transform: uppercase; letter-spacing: 0.06em; }
p { margin: 0 0 6px; }
.meta { font-size: 10pt; }
.meta b, .mono { font-family: ui-monospace, Menlo, Consolas, "Courier New", monospace; }
.test { border: 2px solid #000; padding: 6px 10px; margin: 10px 0; font-weight: 700; }
.top { display: flex; gap: 18px; align-items: flex-start; margin-top: 12px; flex-wrap: wrap; }
.qr { width: 62mm; max-width: 100%; flex: none; }
.qr svg { display: block; width: 100%; height: auto; }
.how { flex: 1; min-width: 200px; }
.how ol { margin: 0; padding-left: 18px; }
.how li { margin-bottom: 5px; }
ol.words { list-style: none; padding: 0; margin: 0; display: grid; grid-template-columns: repeat(4, 1fr); gap: 4px 10px; }
ol.words li { border-bottom: 1px solid #000; padding: 3px 0; font-family: ui-monospace, Menlo, Consolas, "Courier New", monospace; font-size: 11.5pt; font-weight: 600; break-inside: avoid; }
ol.map { grid-template-columns: repeat(6, 1fr); gap: 2px 8px; }
ol.map li { font-size: 8.5pt; font-weight: 400; padding: 1px 0; border-bottom-color: #999; }
.n { display: inline-block; min-width: 2.4em; font-weight: 400; font-size: 0.8em; }
.desc { font-size: 7.5pt; word-break: break-all; border: 1px solid #999; padding: 6px; }
.small { font-size: 8.5pt; }
footer { margin-top: 14px; font-size: 8.5pt; border-top: 1px solid #000; padding-top: 6px; }
@media (max-width: 520px) { ol.words { grid-template-columns: repeat(2, 1fr); } ol.map { grid-template-columns: repeat(3, 1fr); } .qr { width: 100%; } }
</style>
</head>
<body>
<header>
<h1>${title}</h1>
${opts.walletName ? `<p>${esc(opts.walletName)}</p>` : ''}
<p class="meta">Made ${date} · Network: ${NETWORK_LABEL[kit.network]} · Wallet fingerprint: <b>${esc(fingerprint)}</b></p>
</header>
${testnet ? `<p class="test">TEST NETWORK (${NETWORK_LABEL[kit.network]}). This kit does not control real bitcoin.</p>` : ''}
<section class="top">
<div class="qr">${svg}</div>
<div class="how">
<h2>${seed ? 'Your Recovery Key' : 'Your wallet map'}</h2>
<p>${seed ? 'This sheet is the third key of your Trikey wallet. Use it only if you lose your phone or your ' + hw + '.' : 'This sheet tells Trikey which coins belong to your wallet.'}</p>
<ol>${instructions.map((i) => `<li>${i}</li>`).join('')}</ol>
</div>
</section>
${
  seed
    ? `<section>
<h2>Recovery Key words</h2>
<ol class="words">${wordList(recoveryWords)}</ol>
</section>`
    : ''
}
<section>
<h2>Wallet map words</h2>
<p class="small">Only needed if the QR code can't be scanned.${seed ? ' Type them after the 12 Recovery Key words.' : ''}</p>
<ol class="words map">${wordList(mapWords, seed ? recoveryWords.length + 1 : 1)}</ol>
</section>
<section>
<h2>For other wallet software</h2>
<p class="small">${seed ? `The 12 Recovery Key words are a standard BIP 39 seed (key path ${path}, fingerprint <span class="mono">${esc(rk.fingerprint)}</span>).` : `Recovery Key: fingerprint <span class="mono">${esc(rk.fingerprint)}</span>.`} With the descriptor below, wallets such as Sparrow or Bitcoin Core can rebuild this wallet. Its coins are no older than block ${kit.creationHeight}.</p>
<p class="mono desc">${esc(descriptor)}</p>
</section>
<footer>Trikey · 2-of-3: phone, ${hw}, Recovery Key · ${title} format 1</footer>
</body>
</html>
`;
  return {
    html,
    qrSvg: svg,
    qrText,
    recoveryWords,
    mapWords,
    descriptor,
    fingerprint,
    network: kit.network,
    date,
    kind: kit.recoveryKey.kind,
  };
}

/** The key path the kit's Recovery Key uses (for display). */
export const recoveryKeyPath = (kit: RecoveryKit) => bip48Path(getNetwork(kit.network), kit.recoveryKey.kind === 'seed' ? kit.recoveryKey.account : 0);
