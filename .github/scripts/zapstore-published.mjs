#!/usr/bin/env node
// Has Zapstore published this Trikey version? Asks Zapstore's relay, read-only, for the Software Release events
// (NIP-82, kind 30063) of both apps at that version, signed by Trikey's publisher key. zsp writes their `d` tag as
// `<application id>@<version>`, the version being the GitHub tag without its `v` (`app.trikey.wallet@0.1.25-alpha`).
//
//   node .github/scripts/zapstore-published.mjs 0.1.26-alpha
//
// Prints one line per app, `found <d> <event id>` or `missing <d>`, and exits
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
/** Trikey's publisher, npub1qussfnkjk6fvr36syatltxl0ks5pssyx7hrhf8zpnp9mf04e5j2sswedj9 (docs/zapstore.md). */
const AUTHOR = '072104ced2b692c1c7502757f59befb428184086f5c7749c41984bb4beb9a495';
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
/** d tag -> event id, for the events that match. */
const found = new Map();

/** The event's d tag, if it is a release event by Trikey's publisher; otherwise undefined. */
const releaseD = (event) =>
  (typeof event === 'object' &&
  event !== null &&
  event.kind === KIND_RELEASE &&
  event.pubkey === AUTHOR &&
  typeof event.id === 'string' &&
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
  for (const d of wanted) console.log(found.has(d) ? `found ${d} ${found.get(d)}` : `missing ${d}`);
  process.exit(found.size === wanted.length ? 0 : 1);
}

const sub = 'trikey-zapstore-check';
const timer = setTimeout(() => fail(`no answer from ${RELAY} within ${TIMEOUT_MS} ms`), TIMEOUT_MS);
const socket = new WebSocket(RELAY);

socket.addEventListener('open', () => {
  socket.send(JSON.stringify(['REQ', sub, { kinds: [KIND_RELEASE], authors: [AUTHOR], '#d': wanted }]));
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
    // The relay should send only what the filter asks for; check anyway, so another author's event never counts.
    const d = releaseD(data[2]);
    if (d && wanted.includes(d) && !found.has(d)) found.set(d, data[2].id);
  } else if (data[0] === 'EOSE') {
    finish();
  } else if (data[0] === 'CLOSED') {
    fail(`${RELAY} closed the query: ${String(data[2] ?? '')}`);
  }
});

socket.addEventListener('error', () => fail(`could not reach ${RELAY}`));
socket.addEventListener('close', () => fail(`${RELAY} closed the connection before answering`));
