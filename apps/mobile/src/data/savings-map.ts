/**
 * The printed Savings wallet map (docs/design/savings-and-limit-off.md, open question 10): one self-contained page (no
 * fonts, images or scripts from anywhere), in the Recovery Kit's style, that lets the owner or an heir find and recover
 * Savings with its keys alone, even without Trikey: the descriptor (text and QR code), the three keys (role, master
 * fingerprint, path, xpub), the first receive address to check against, and what to do with it.
 *
 * It holds no secret. Every key on it is public (an xpub), and the page is built only from the named public fields of
 * `SavingsMapData`, so nothing else that travels with them can reach it; a private extended key is refused outright. It
 * is private all the same: whoever reads it can follow Savings' balance and history, so the page and the screen before
 * the print dialog both say so.
 */
import { MultisigWallet, getNetwork, type NetworkName } from '@trikey/core';
import { qrSvg } from '@trikey/recovery-key';
import type { ErrorCorrection } from 'qr';
import type { IsoDate, SavingsMapData, SavingsMapKey } from './types';

/**
 * The descriptor is about 460 characters (three xpubs with origins, `/<0;1>/*`, the checksum). Lowercase letters rule out
 * the alphanumeric mode, so it is a byte-mode code: version 17 (85 x 85 modules) at "medium" (15% may be lost), printed
 * 80 mm wide, so about 0.95 mm a module, as the Recovery Kit's code. "Quartile" would need 97 modules, harder for a laptop
 * camera (Sparrow); the text below the code is the fallback for a damaged one. One static code, not an animated or split
 * one: paper can't animate, and wallets import a descriptor from one plain-text QR code.
 */
export const SAVINGS_MAP_QR_ECC: ErrorCorrection = 'medium';

const NETWORK_LABEL: Record<NetworkName, string> = { bitcoin: 'Bitcoin', testnet: 'Testnet', signet: 'Signet', regtest: 'Regtest' };

/** Public extended key prefixes (BIP 32 and the SLIP 132 variants). Anything else, a `…prv` above all, is refused. */
const PUBLIC_KEY = /^[xtuvyzUVYZ]pub[0-9A-Za-z]+$/;
const PRIVATE_IN_DESCRIPTOR = /[[\](,][xtuvyzUVYZ]prv|^[xtuvyzUVYZ]prv/;

const ROLE: Record<SavingsMapKey['role'], string> = { phone: 'This phone', hardware: 'Hardware wallet', recoveryKey: 'Recovery Key' };

/** "ab12cd34ef567890" as "ab12 cd34 ef56 7890", as the Recovery Kit shows its fingerprint. */
export const groupWalletId = (id: string) => id.replace(/(.{4})(?=.)/g, '$1 ');

/** "48h/1h/1h/2h" as "m/48'/1'/1'/2'". */
export const displayPath = (originPath: string) => `m/${originPath.replace(/h/g, "'")}`;

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/**
 * The map's data from Savings' descriptor (keys in phone, hardware, Recovery Key order, as the wallet writes it): each
 * key's fingerprint, path and xpub, and the first receive address (receive chain, index 0). Throws on a descriptor that
 * is not a checksummed `wsh(sortedmulti(2, …))` of three public keys.
 */
export function savingsMapData(input: {
  descriptor: string;
  network: NetworkName;
  walletId: string;
  createdAt?: IsoDate;
  models?: { hardware?: string; recoveryKey?: string };
}): SavingsMapData {
  if (PRIVATE_IN_DESCRIPTOR.test(input.descriptor)) throw new Error('A Savings wallet map holds public keys only.');
  const wallet = MultisigWallet.fromDescriptor(input.descriptor, getNetwork(input.network));
  const key = (role: SavingsMapKey['role'], k: (typeof wallet.keys)['app'], model?: string): SavingsMapKey => ({
    role,
    ...(model ? { model } : {}),
    fingerprint: k.fingerprint,
    path: displayPath(k.originPath),
    xpub: k.xpub,
  });
  return {
    network: input.network,
    walletId: input.walletId,
    descriptor: input.descriptor.trim(),
    keys: [key('phone', wallet.keys.app), key('hardware', wallet.keys.hardware, input.models?.hardware), key('recoveryKey', wallet.keys.cosigner, input.models?.recoveryKey)],
    firstAddress: wallet.derive(0, 0).address,
    ...(input.createdAt ? { createdAt: input.createdAt } : {}),
  };
}

/** Refuses anything that is not plainly public before it reaches the page. */
function assertPublic(data: SavingsMapData): void {
  if (PRIVATE_IN_DESCRIPTOR.test(data.descriptor)) throw new Error('A Savings wallet map holds public keys only.');
  if (data.keys.length !== 3) throw new Error('A Savings wallet map needs its three keys.');
  for (const k of data.keys) if (!PUBLIC_KEY.test(k.xpub)) throw new Error('A Savings wallet map holds public keys only.');
}

/** Renders the map as a printable page (A4 or Letter, black on white). The date is the day it is made (default today). */
export function renderSavingsMap(data: SavingsMapData, opts: { date?: Date } = {}): { html: string; date: string } {
  assertPublic(data);
  const date = (opts.date ?? new Date()).toISOString().slice(0, 10);
  const network = NETWORK_LABEL[data.network];
  const testnet = data.network !== 'bitcoin';
  const title = 'Trikey Savings — wallet map';
  const hardware = data.keys.find((k) => k.role === 'hardware');
  const hw = esc(hardware?.model ?? 'hardware wallet');
  const svg = qrSvg(data.descriptor, { ecc: SAVINGS_MAP_QR_ECC, title: 'Savings descriptor QR code' });
  const created = data.createdAt ? ` · Savings made ${esc(data.createdAt.slice(0, 10))}` : '';

  const instructions = [
    `<b>This sheet is not a key: nobody can spend with this sheet alone.</b> It shows which keys spend Savings and lets any descriptor-capable wallet, such as Sparrow or Bitcoin Core, watch Savings and spend it with two of the three keys.`,
    `<b>Any two of the three keys move the money:</b> this phone and the ${hw}, or the Recovery Key with either of them. One key alone moves nothing, and Trikey's guardian holds none of them.`,
    `The phone's key comes from the phone backup: restore it in Trikey, or rebuild Savings from the other two keys.`,
    `Keep this sheet with your Recovery Key or with your papers. Don't keep it with any seed words.`,
    `To recover without Trikey, import the descriptor (scan the QR code or type the text) into a multisig wallet, check that its first address matches the one below, then sign with two of the keys.`,
  ];

  const keyRows = data.keys
    .map(
      (k) => `<tr>
<td class="role">${esc(ROLE[k.role])}${k.model ? `<br><span class="small">${esc(k.model)}</span>` : ''}</td>
<td class="mono">${esc(k.fingerprint)}</td>
<td class="mono">${esc(k.path)}</td>
<td class="mono xpub">${esc(k.xpub)}</td>
</tr>`,
    )
    .join('\n');

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
h2 { font-size: 10.5pt; margin: 12px 0 5px; text-transform: uppercase; letter-spacing: 0.06em; }
p { margin: 0 0 6px; }
.meta { font-size: 9.5pt; }
.meta b, .mono { font-family: ui-monospace, Menlo, Consolas, "Courier New", monospace; }
.test, .demo { border: 2px solid #000; padding: 6px 10px; margin: 8px 0; font-weight: 700; }
.private { border: 1px solid #000; padding: 6px 10px; margin: 8px 0; }
.top { display: flex; gap: 16px; align-items: flex-start; margin-top: 10px; flex-wrap: wrap; }
.qr { width: 80mm; max-width: 100%; flex: none; }
.qr svg { display: block; width: 100%; height: auto; }
.how { flex: 1; min-width: 200px; }
.how ol { margin: 0; padding-left: 18px; }
.how li { margin-bottom: 4px; }
table { width: 100%; border-collapse: collapse; font-size: 8.5pt; }
th, td { text-align: left; vertical-align: top; border-bottom: 1px solid #999; padding: 4px 6px 4px 0; }
th { font-weight: 600; border-bottom-color: #000; }
td.role { font-weight: 600; white-space: nowrap; }
td.xpub, .desc, .addr { word-break: break-all; }
.desc { font-size: 8pt; border: 1px solid #999; padding: 6px; }
.addr { font-size: 10pt; font-weight: 600; }
.small { font-size: 8.5pt; font-weight: 400; }
footer { margin-top: 12px; font-size: 8.5pt; border-top: 1px solid #000; padding-top: 6px; }
@media (max-width: 520px) { .qr { width: 100%; } }
</style>
</head>
<body>
<header>
<h1>${esc(title)}</h1>
<p class="meta">Made ${esc(date)} · Network: ${esc(network)} · Savings wallet id: <b>${esc(groupWalletId(data.walletId))}</b>${created}</p>
</header>
${data.demo ? `<p class="demo">DEMO. Made-up keys and addresses from Trikey's demo mode: not a real wallet, nothing to recover.</p>` : ''}
${testnet ? `<p class="test">TEST NETWORK (${esc(network)}). This wallet does not hold real bitcoin.</p>` : ''}
<p class="private"><b>Private, though it can't move money.</b> Anyone who reads this sheet can see Savings' balance and every payment into and out of it, now and later. It holds no private key, seed words or recovery code.</p>
<section class="top">
<div class="qr">${svg}</div>
<div class="how">
<h2>What this is</h2>
<p>The map of your Savings wallet: a 2-of-3 multisig (<span class="mono">wsh(sortedmulti(2, …))</span>) of this phone, your ${hw} and your Recovery Key.</p>
<ol>${instructions.map((i) => `<li>${i}</li>`).join('')}</ol>
</div>
</section>
<section>
<h2>The three keys</h2>
<table>
<thead><tr><th>Key</th><th>Master fingerprint</th><th>Derivation path</th><th>Extended public key (xpub)</th></tr></thead>
<tbody>
${keyRows}
</tbody>
</table>
</section>
<section>
<h2>First receive address</h2>
<p class="small">The wallet you import the descriptor into must show this as its first receive address (receive chain, index 0).</p>
<p class="mono addr">${esc(data.firstAddress)}</p>
</section>
<section>
<h2>Output descriptor</h2>
<p class="small">The QR code holds exactly this text. <span class="mono">&lt;0;1&gt;</span> stands for both receive (0) and change (1) addresses (BIP 389); a wallet that predates it needs two descriptors, one with <span class="mono">0</span> and one with <span class="mono">1</span> in its place, and recomputes the checksum after the <span class="mono">#</span>.</p>
<p class="mono desc">${esc(data.descriptor)}</p>
</section>
<footer>Trikey · Savings: 2-of-3, this phone, ${hw}, Recovery Key · No private keys, seed words or recovery codes on this page · Savings wallet map format 1</footer>
</body>
</html>
`;
  return { html, date };
}
