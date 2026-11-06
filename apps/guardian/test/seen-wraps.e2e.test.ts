/**
 * The guardian's inbox keeps the ids of the wraps it handled in its data directory, so after a restart (an update)
 * the two days of wraps the relays send again are skipped before any signature check or decryption. On the owner's
 * Umbrel the relays held 1115 wraps addressed to the guardian. Throwaway keys, a local relay.
 */
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { afterEach, describe, expect, it } from 'vitest';
import { SeenWraps, SimplePoolRelayPool, WRAP_BACKDATE_SEC, generateMessageId, wrapMessage, type NostrEvent } from '@trikey/protocol';
import { DevRelay } from '@trikey/protocol/dev/relay';
import { Inbox, seenWrapsFile } from '../src/nostr/inbox.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(cond: () => boolean, what: string, timeoutMs = 20_000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await sleep(20);
  }
}
const nowSec = () => Math.floor(Date.now() / 1000);

const guardianKey = generateSecretKey();
const guardianPub = getPublicKey(guardianKey);
const phoneKey = generateSecretKey();
const phonePub = getPublicKey(phoneKey);
const strangerKey = generateSecretKey();

const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const f of cleanup.splice(0).reverse()) await f();
});

/**
 * `n` requests from `from` sent over the last day by a phone before 0.1.10 (back-dated up to two days, expiring two
 * days and an hour after that), as the relays still keep them: the old ones stale by now.
 */
function requests(from: Uint8Array, n: number): NostrEvent[] {
  const now = nowSec();
  return Array.from({ length: n }, (_, i) => {
    const sent = now - Math.floor((i / n) * 86_400);
    for (;;) {
      const { wrap } = wrapMessage({ id: generateMessageId(), method: 'guardian.status', params: {} }, { senderSecretKey: from, recipient: guardianPub, now: sent, backdateSec: WRAP_BACKDATE_SEC });
      // One the relays still keep, and the guardian's subscription still asks for.
      if (Number(wrap.tags.find((t) => t[0] === 'expiration')![1]) > now + 600 && wrap.created_at > now - WRAP_BACKDATE_SEC) return wrap;
    }
  });
}

async function setup() {
  const relay = new DevRelay();
  await relay.start();
  const dir = await mkdtemp(join(tmpdir(), 'trikey-seen-'));
  cleanup.push(() => relay.stop(), () => rm(dir, { recursive: true, force: true }));
  return { relay, dir, file: join(dir, 'seen-wraps.json') };
}

function inbox(relay: DevRelay, file: string) {
  const pool = new SimplePoolRelayPool({ maxWaitMs: 2000 });
  const rpc: string[] = [];
  const box = new Inbox({
    pool,
    relays: [relay.url],
    secretKey: guardianKey,
    pubkey: guardianPub,
    now: nowSec,
    onRpc: (o) => void rpc.push(o.sender),
    onDm: () => {},
    isPeer: (s) => s === phonePub,
    seen: new SeenWraps({ storage: seenWrapsFile(file), now: nowSec, saveDelayMs: 50 }),
  });
  // Close and drain: the seen-ids file is saved after a short delay, and must not land in the folder while it is removed.
  cleanup.push(() => pool.close(), async () => {
    box.close();
    await box.drain();
  });
  return { box, rpc };
}

describe('the guardian inbox across a restart', () => {
  it('opens each wrap once, keeps the peers\' ids in the data directory, and opens none of them again after a restart', { timeout: 60_000 }, async () => {
    const { relay, file } = await setup();
    const mine = requests(phoneKey, 200);
    const strangers = requests(strangerKey, 5);
    for (const e of [...mine, ...strangers]) relay.events.set(e.id, e);

    const first = inbox(relay, file);
    await first.box.start();
    await waitFor(() => first.box.opened === 205, 'every wrap opened');
    expect(first.rpc.filter((s) => s === phonePub)).toHaveLength(200);
    first.box.close();
    await first.box.drain(); // what the guardian's stop() does: saves the ids
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    const saved = JSON.parse(await readFile(file, 'utf8')) as { ids: [string, number][] };
    expect(saved.ids.map(([id]) => id).sort()).toEqual(mine.map((e) => e.id).sort()); // the peer's only

    // Restarted (a new process: nothing in memory): the phone's 200 are skipped before any crypto.
    const second = inbox(relay, file);
    await second.box.start();
    await sleep(500);
    expect(second.box.opened).toBe(5); // the strangers' ones, which are not kept
    expect(second.rpc.filter((s) => s === phonePub)).toHaveLength(0);

    // A new request still gets through, once, also after the relay connection drops and everything is sent again.
    const fresh = requests(phoneKey, 1)[0]!;
    await new SimplePoolRelayPool().publish([relay.url], fresh);
    await waitFor(() => second.rpc.filter((s) => s === phonePub).length === 1, 'the new request');
    relay.dropConnections('reset');
    await sleep(2500);
    expect(second.rpc.filter((s) => s === phonePub)).toHaveLength(1);
    expect(second.box.opened).toBe(6);
  });

  it('a missing or broken file starts empty (every wrap is opened, as before)', { timeout: 30_000 }, async () => {
    const { relay, file } = await setup();
    for (const e of requests(phoneKey, 3)) relay.events.set(e.id, e);
    await import('node:fs/promises').then((fs) => fs.writeFile(file, 'not json'));
    const box = inbox(relay, file);
    await box.box.start();
    await waitFor(() => box.box.opened === 3, 'every wrap opened');
  });
});
