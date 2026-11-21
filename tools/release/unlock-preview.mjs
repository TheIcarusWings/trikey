#!/usr/bin/env node
// Signs a phone's preview challenge with Trikey's publisher key, from the owner's signer app, and shows the result as
// a QR code for the phone to scan (docs/design/public-release.md, section 3; apps/mobile/src/lib/preview-unlock.ts):
//
//   node tools/release/unlock-preview.mjs a1b2c3d4e5f60718
//
// The challenge is on the phone: Settings, hold the version row under About, Make a challenge. This tool asks the
// signer app (Amber, nsec.app) over NIP-46, from a bunker:// URL in TRIKEY_BUNKER or typed in, to sign one event of kind
// 1421 for it. Never an nsec: the key stays in the signer app, and this tool refuses one. The signer's key must be the
// pinned one, packaging/release-signer.npub. Nothing is published: the event goes only to the phone.
//
// Needs: node 22 and `npm ci` done in this checkout (nostr-tools, qrcode).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const looksSecret = (s) => /nsec1/i.test(s) || /^[0-9a-f]{64}$/i.test(s.trim());
if (args.some(looksSecret) || looksSecret(process.env.TRIKEY_BUNKER ?? '')) {
  console.error('That looks like a secret key. This tool never takes an nsec: give it a bunker:// URL from your signer app (Amber, nsec.app), which keeps the key.');
  process.exit(2);
}
const code = (args.join('') || '').replace(/\s+/g, '').toLowerCase();
if (!/^[0-9a-f]{16}$/.test(code)) {
  console.error('Usage: node tools/release/unlock-preview.mjs <the 16 hex digits the phone shows>');
  process.exit(2);
}

// Must match apps/mobile/src/lib/preview-unlock.ts (a test checks).
const KIND = 1421;
const CONTENT = 'Unlock Trikey preview on this phone for 24 hours';

const { generateSecretKey, verifyEvent } = await import('nostr-tools/pure');
const { BunkerSigner, parseBunkerInput } = await import('nostr-tools/nip46');
const { decode } = await import('nostr-tools/nip19');
const QRCode = (await import('qrcode')).default;

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const npub = readFileSync(join(root, 'packaging', 'release-signer.npub'), 'utf8')
  .split('\n')
  .map((l) => l.trim())
  .filter((l) => l && !l.startsWith('#'));
if (npub.length !== 1) throw new Error('packaging/release-signer.npub must hold exactly one npub');
const pinned = decode(npub[0]).data;

class Stop extends Error {}
const fail = (msg) => {
  throw new Stop(msg);
};

async function main() {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  let bunker;
  try {
    bunker = process.env.TRIKEY_BUNKER ?? (await rl.question('bunker:// URL from your signer app (Amber, nsec.app): ')).trim();
  } finally {
    rl.close();
  }
  if (looksSecret(bunker)) fail('That looks like a secret key. Give the bunker:// URL from your signer app, never an nsec.');
  const bp = await parseBunkerInput(bunker);
  if (!bp) fail('That is not a bunker:// URL.');

  // The same kept client key as sign-release.mjs, so a link that worked there works here.
  const clientKeyFile = join(homedir(), '.config', 'trikey', 'nip46', `${bp.pubkey}.key`);
  const known = existsSync(clientKeyFile);
  const clientKey = known ? Buffer.from(readFileSync(clientKeyFile, 'utf8').trim(), 'hex') : generateSecretKey();
  if (clientKey.length !== 32) fail(`${clientKeyFile} is not a 32-byte hex key: delete it and run this again.`);
  const signer = BunkerSigner.fromBunker(clientKey, bp, {
    timeout: 180_000,
    onauth: (url) => console.log(`\nYour signer asks you to approve here: ${url}`),
  });
  let event;
  try {
    console.log('\nConnecting to your signer; approve the request there...');
    try {
      await signer.connect();
    } catch (e) {
      if (!/already connected/i.test(String(e?.message ?? e)) || !known)
        fail('Your signer refused the connection, or says this bunker:// link was already used. Create a new connection link in the signer app and give that one.');
    }
    if (!known) {
      mkdirSync(dirname(clientKeyFile), { recursive: true, mode: 0o700 });
      writeFileSync(clientKeyFile, Buffer.from(clientKey).toString('hex') + '\n', { mode: 0o600 });
    }
    const pk = await signer.getPublicKey();
    if (pk !== pinned) fail(`Your signer's key is ${pk}, not Trikey's publisher key ${pinned}. Nothing was signed.`);
    event = await signer.signEvent({ kind: KIND, created_at: Math.floor(Date.now() / 1000), tags: [['challenge', code]], content: CONTENT });
  } finally {
    await signer.close().catch(() => {});
  }
  if (!verifyEvent(event) || event.pubkey !== pinned) fail('The signer returned an event that does not verify for the pinned key.');

  const json = JSON.stringify(event);
  console.log('\nScan this with the phone (Preview screen):\n');
  console.log(await QRCode.toString(json, { type: 'terminal', small: true, errorCorrectionLevel: 'L' }));
  console.log(`Or paste this into the phone:\n${json}\n`);
}

let exit = 0;
try {
  await main();
} catch (e) {
  console.error(`\n${e instanceof Stop ? e.message : e?.stack ?? e}`);
  exit = 1;
}
process.exit(exit);
