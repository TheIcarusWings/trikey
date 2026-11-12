#!/usr/bin/env node
// Has Zapstore published this Trikey version? Asks Zapstore's relay, read-only, for the Software Release events
// (NIP-82, kind 30063) of both apps at that version. zsp writes their `d` tag as `<application id>@<version>`, the
// version being the GitHub tag without its `v` (`app.trikey.wallet@0.1.25-alpha`).
//
// By any author: a release Trikey's maintainer publishes by hand (`zsp publish`) is signed by Trikey's publisher key,
// but one Zapstore's indexer publishes on its own ("shown as developed by you", says zsp) may be signed by Zapstore's
// key. An event by Trikey's key is preferred; one only by other keys counts too, with a `notice` line naming them, so
// the runs show who signs. The relay admits only the uploaders it accepts (docs/zapstore.md, step 4).
//
//   node .github/scripts/zapstore-published.mjs 0.1.26-alpha
//
// Prints one line per app, `found <d> <event id>` or `missing <d>`, plus, for an app found only by other keys,
// `notice <d> is signed by <pubkey>[,<pubkey>...], not Trikey's publisher key`. Exits
//   0  both apps are published,
//   1  one or both are not (yet),
//   2  the check could not be made: a bad version, no answer from the relay in time, or the relay refused the query.
// It sends one REQ and reads until EOSE; it publishes nothing and needs no key. It does not verify the events'
// signatures (that would need a secp256k1 library): it reports what the relay serves, which is what the Zapstore app
// reads. Used by .github/workflows/zapstore-check.yml (docs/zapstore.md). Node 22's built-in WebSocket, no dependency.
//
// ZAPSTORE_RELAY (default wss://relay.zapstore.dev) and ZAPSTORE_TIMEOUT_MS (default 30000) are for the tests.

const RELAY = process.env.ZAPSTORE_RELAY || 'wss://relay.zapstore.dev';
const TIMEOUT_MS = Number(process.env.ZAPSTORE_TIMEOUT_MS || 30000);
/** Trikey's publisher from 0.1.28-alpha, the founder's npub19tzp8lf3klmqj3dz9mz0qnuvjp7uyy9993gmljmyaxs8phztj7wsnujvq5 (docs/zapstore.md). */
const AUTHOR = '2ac413fd31b7f60945a22ec4f04f8c907dc210a52c51bfcb64e9a070dc4b979d';
const APPS = ['app.trikey.wallet', 'app.trikey.wallet.foss'];
const KIND_RELEASE = 30063;

function fail(message) {
  console.error(`zapstore-published: ${message}`);
  process.exit(2);
}

const version = (process.argv[2] ?? '').replace(/^v/, '');
if (!/^\d+\.\d+\.\d+(-alpha)?$/.test(version)) fail(`expected a version like 0.1.26-alpha, got "${process.argv[2] ?? ''}"`);
if (typeof WebSocket !== 'function') fail('this Node has no built-in WebSocket (Node 22 or later is needed)');

const wanted = APPS.map((app) => `${app}@${version}`);
/** d tag -> the event id by Trikey's key, if any. */
const byTrikey = new Map();
/** d tag -> { id: the first event id, authors: the other keys } for events by other keys. */
const byOthers = new Map();

const HEX64 = /^[0-9a-f]{64}$/;
/** The event's d tag, if it is a release event (kind 30063, with an id and an author); otherwise undefined. */
const releaseD = (event) =>
  (typeof event === 'object' &&
  event !== null &&
  event.kind === KIND_RELEASE &&
  typeof event.id === 'string' &&
  HEX64.test(event.id) &&
  typeof event.pubkey === 'string' &&
  HEX64.test(event.pubkey) &&
  Array.isArray(event.tags) &&
  event.tags.find((t) => Array.isArray(t) && t[0] === 'd')?.[1]) ||
  undefined;

function finish() {
  clearTimeout(timer);
  try {
    socket.close();
  } catch {
    // Closing is best effort; the answer is in.
  }
  let missing = 0;
  for (const d of wanted) {
    const other = byOthers.get(d);
    if (byTrikey.has(d)) console.log(`found ${d} ${byTrikey.get(d)}`);
    else if (other) {
      console.log(`found ${d} ${other.id}`);
      console.log(`notice ${d} is signed by ${[...other.authors].join(',')}, not Trikey's publisher key`);
    } else {
      console.log(`missing ${d}`);
      missing += 1;
    }
  }
  process.exit(missing === 0 ? 0 : 1);
}

const sub = 'trikey-zapstore-check';
const timer = setTimeout(() => fail(`no answer from ${RELAY} within ${TIMEOUT_MS} ms`), TIMEOUT_MS);
const socket = new WebSocket(RELAY);

socket.addEventListener('open', () => {
  socket.send(JSON.stringify(['REQ', sub, { kinds: [KIND_RELEASE], '#d': wanted }]));
});

socket.addEventListener('message', (message) => {
  let data;
  try {
    data = JSON.parse(String(message.data));
  } catch {
    return; // Not a nostr message: ignore it.
  }
  if (!Array.isArray(data) || data[1] !== sub) return; // NOTICE, or another subscription.
  if (data[0] === 'EVENT') {
    // The relay should send only what the filter asks for; check the kind and the d tag anyway.
    const event = data[2];
    const d = releaseD(event);
    if (!d || !wanted.includes(d)) return;
    if (event.pubkey === AUTHOR) {
      if (!byTrikey.has(d)) byTrikey.set(d, event.id);
    } else {
      const other = byOthers.get(d) ?? { id: event.id, authors: new Set() };
      other.authors.add(event.pubkey);
      byOthers.set(d, other);
    }
  } else if (data[0] === 'EOSE') {
    finish();
  } else if (data[0] === 'CLOSED') {
    fail(`${RELAY} closed the query: ${String(data[2] ?? '')}`);
  }
});

socket.addEventListener('error', () => fail(`could not reach ${RELAY}`));
socket.addEventListener('close', () => fail(`${RELAY} closed the connection before answering`));
