#!/usr/bin/env node
// Signs a draft release with Trikey's nostr publisher key, from the owner's signer app (docs/design/signed-releases.md;
// docs/releasing.md, section 4):
//
//   node tools/release/sign-release.mjs v0.1.27-alpha
//
// 1. Downloads the draft's files (`gh`, signed in as someone who can see drafts) and makes the manifest from them
//    (packaging/release-signature.py), so the hashes signed are the ones computed here, on the owner's own computer.
// 2. Shows the manifest and asks for the tag to be typed back.
// 3. Asks the signer app (Amber, nsec.app) over NIP-46, from a bunker:// URL in TRIKEY_BUNKER or typed in. Never an
//    nsec: the secret key stays in the signer app, and this tool refuses one. The signer's key must be the pinned one,
//    packaging/release-signer.npub.
// 4. Checks the signed event with the same check publish-release.yml runs, uploads the manifest and the event to the
//    draft, and publishes the event to relays (the publisher's relay list, kind 10002, plus Trikey's relay and free public ones).
//
//   node tools/release/sign-release.mjs v0.1.27-alpha --relays-only
//
// publishes the release's event to relays again (when they were down), without signing anything.
//
// Needs: node 22 (WebSocket), `npm ci` done in this checkout (nostr-tools), python3 and gh. TRIKEY_REPO picks another
// repository (owner/name).
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
// Before anything else: an nsec (or a 64-hex secret key) on the command line is refused, and not echoed.
const looksSecret = (s) => /nsec1/i.test(s) || /^[0-9a-f]{64}$/i.test(s.trim());
if (args.some(looksSecret) || looksSecret(process.env.TRIKEY_BUNKER ?? '')) {
  console.error('That looks like a secret key. This tool never takes an nsec: give it a bunker:// URL from your signer app (Amber, nsec.app), which keeps the key.');
  process.exit(2);
}
const tag = args[0];
const relaysOnly = args[1] === '--relays-only';
if (!tag || !/^v\d+\.\d+\.\d+(-[a-z0-9]+)?$/.test(tag) || args.length > 2 || (args.length === 2 && !relaysOnly)) {
  console.error('Usage: node tools/release/sign-release.mjs <tag> [--relays-only]   (e.g. v0.1.27-alpha)');
  process.exit(2);
}

const { generateSecretKey, verifyEvent } = await import('nostr-tools/pure');
const { BunkerSigner, parseBunkerInput } = await import('nostr-tools/nip46');
const { decode } = await import('nostr-tools/nip19');
const { SimplePool } = await import('nostr-tools/pool');

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const REPO = process.env.TRIKEY_REPO ?? 'TheIcarusWings/trikey';
const SCRIPT = join(root, 'packaging', 'release-signature.py');
const MANIFEST = `trikey-${tag}-SHA256SUMS`;
const EVENT = `${MANIFEST}.event.json`;
const KIND = 1420;
// Always published to as well as the publisher's own list (whose write relays may be paid ones that refuse it): Trikey's
// relay and free public ones. The event is public by design; anyone may copy it anywhere.
const FALLBACK_RELAYS = ['wss://relay.trikey.app', 'wss://nos.lol', 'wss://relay.primal.net', 'wss://relay.damus.io'];

const npub = readFileSync(join(root, 'packaging', 'release-signer.npub'), 'utf8')
  .split('\n')
  .map((l) => l.trim())
  .filter((l) => l && !l.startsWith('#'));
if (npub.length !== 1) throw new Error('packaging/release-signer.npub must hold exactly one npub');
const pinned = decode(npub[0]).data;

const run = (cmd, argv, opts = {}) => execFileSync(cmd, argv, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], ...opts });
class Stop extends Error {}
const fail = (msg) => {
  throw new Stop(msg);
};

async function publishToRelays(event) {
  const pool = new SimplePool();
  let relays = [];
  try {
    const list = await pool.get(FALLBACK_RELAYS, { kinds: [10002], authors: [pinned] }, { maxWait: 5000 });
    relays = (list?.tags ?? [])
      .filter((t) => t[0] === 'r' && (!t[2] || t[2] === 'write') && /^wss:\/\/[^\s]+$/.test(t[1] ?? ''))
      .map((t) => t[1]);
  } catch {
    // No relay list found: the fallback relays below.
  }
  relays = [...new Set([...relays, ...FALLBACK_RELAYS])];
  console.log(`\nPublishing the event to ${relays.join(', ')}`);
  const results = await Promise.allSettled(pool.publish(relays, event));
  let ok = 0;
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') ok++;
    console.log(`  ${relays[i]}: ${r.status === 'fulfilled' ? 'accepted' : `not accepted (${r.reason?.message ?? r.reason})`}`);
  });
  pool.close(relays);
  if (ok === 0) console.log(`No relay accepted it. The release is still signed (the file on the draft is what the checks read); try again later with:\n  node tools/release/sign-release.mjs ${tag} --relays-only`);
  return ok;
}

async function main(dir) {
  const release = JSON.parse(run('gh', ['release', 'view', tag, '--repo', REPO, '--json', 'isDraft,assets']));
  const names = release.assets.map((a) => a.name);
  if (relaysOnly) {
    if (!names.includes(EVENT)) fail(`${tag} has no ${EVENT}: sign it first.`);
    run('gh', ['release', 'download', tag, '--repo', REPO, '--dir', dir, '--pattern', EVENT]);
    const event = JSON.parse(readFileSync(join(dir, EVENT), 'utf8'));
    if (!verifyEvent(event) || event.pubkey !== pinned || event.kind !== KIND) fail(`${EVENT} is not a signature by the pinned key.`);
    await publishToRelays(event);
    return;
  }

  if (!release.isDraft) fail(`${tag} is published already. A release is signed while it is a draft, before publish-release.yml publishes it.`);
  if (names.includes(MANIFEST) || names.includes(EVENT)) {
    fail(`${tag}'s draft already has ${names.filter((n) => n === MANIFEST || n === EVENT).join(' and ')}. To sign again, delete both from the draft (Releases page) first.`);
  }

  console.log(`Downloading the ${names.length} files of the draft ${tag} (${REPO})...`);
  run('gh', ['release', 'download', tag, '--repo', REPO, '--dir', dir]);
  const got = readdirSync(dir).sort();
  if (JSON.stringify(got) !== JSON.stringify([...names].sort())) fail(`Downloaded ${got.join(', ')}, but the draft lists ${names.join(', ')}.`);

  const template = JSON.parse(run('python3', ['-I', SCRIPT, 'manifest', '--tag', tag, '--dir', dir]));
  console.log(`\n${MANIFEST}:\n\n${readFileSync(join(dir, MANIFEST), 'utf8')}`);
  console.log(`Signing this says: "I, Trikey's publisher, release exactly these files as ${tag}." Sign only once the`);
  console.log("pipeline's checks are green (docs/releasing.md, section 4).\n");

  // One line at a time, from a terminal or a pipe alike (rl.question loses lines that arrive together).
  const rl = createInterface({ input: process.stdin });
  const lines = rl[Symbol.asyncIterator]();
  const ask = async (question) => {
    process.stdout.write(question);
    const { value, done } = await lines.next();
    if (done) fail('No answer: not signed.');
    return value.trim();
  };
  let bunker;
  try {
    if ((await ask(`Type ${tag} to sign it: `)) !== tag) fail('Not signed.');
    bunker = process.env.TRIKEY_BUNKER ?? (await ask('bunker:// URL from your signer app (Amber, nsec.app): '));
  } finally {
    rl.close();
  }
  if (looksSecret(bunker)) fail('That looks like a secret key. Give the bunker:// URL from your signer app, never an nsec.');
  const bp = await parseBunkerInput(bunker);
  if (!bp) fail('That is not a bunker:// URL.');

  // A bunker:// link's secret works for one connection only: a signer answers a second connect with "already
  // connected". So this tool keeps the key it connected with, one per signer, and uses it again next time, as zsp does
  // (the same link then keeps working). It is this tool's own client key, never Trikey's key: it can only ask the
  // signer, which still shows every request.
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
    console.log('\nConnecting to your signer; approve the requests there (keep the signer app in front)...');
    try {
      await signer.connect();
    } catch (e) {
      if (!/already connected/i.test(String(e?.message ?? e))) throw e;
      if (!known)
        fail(
          'Your signer says this bunker:// link was already used (by an earlier run, or by another app such as zsp). ' +
            'In the signer app, create a new connection link and give that one: this tool then remembers the connection, ' +
            'so the same link works next time. Nothing was signed.',
        );
      // Already connected with the key kept from last time: go on.
    }
    if (!known) {
      mkdirSync(dirname(clientKeyFile), { recursive: true, mode: 0o700 });
      writeFileSync(clientKeyFile, Buffer.from(clientKey).toString('hex') + '\n', { mode: 0o600 });
    }
    const pk = await signer.getPublicKey();
    if (pk !== pinned) fail(`Your signer's key is ${pk}, not Trikey's publisher key ${pinned} (packaging/release-signer.npub). Nothing was signed.`);
    event = await signer.signEvent(template);
  } finally {
    await signer.close().catch(() => {});
  }
  if (!verifyEvent(event) || event.pubkey !== pinned) fail('The signer returned an event that does not verify for the pinned key. Nothing was uploaded.');

  writeFileSync(join(dir, EVENT), JSON.stringify(event) + '\n');
  try {
    console.log(run('python3', ['-I', SCRIPT, 'check', '--tag', tag, '--dir', dir]).trim());
  } catch (e) {
    fail(`The signed release does not pass the check, so nothing was uploaded:\n${e.stdout ?? e.message}`);
  }

  run('gh', ['release', 'upload', tag, join(dir, MANIFEST), join(dir, EVENT), '--repo', REPO]);
  console.log(`\nUploaded ${MANIFEST} and ${EVENT} to the draft ${tag}.`);
  await publishToRelays(event);
  console.log(`\nNext: approve the \`release\` environment for publish-release.yml (or re-run its publish job if it already failed for want of the signature).`);
}

const dir = mkdtempSync(join(tmpdir(), 'trikey-sign-'));
let code = 0;
try {
  await main(dir);
} catch (e) {
  console.error(`\n${e instanceof Stop ? e.message : e?.stack ?? e}`);
  code = 1;
} finally {
  rmSync(dir, { recursive: true, force: true });
}
// The relay and signer sockets may keep the event loop alive.
process.exit(code);
