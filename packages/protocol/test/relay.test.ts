import { finalizeEvent, generateSecretKey } from 'nostr-tools/pure';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { DevRelay } from '../src/dev/relay.js';
import { sleep } from './helpers.js';

let relay: DevRelay;
let url: string;
const sockets: WebSocket[] = [];

beforeEach(async () => {
  relay = new DevRelay();
  url = await relay.start();
});
afterEach(async () => {
  for (const s of sockets.splice(0)) s.terminate();
  await relay.stop();
});

async function connect(): Promise<{ ws: WebSocket; msgs: unknown[][] }> {
  const ws = new WebSocket(url);
  sockets.push(ws);
  const msgs: unknown[][] = [];
  ws.on('message', (d) => msgs.push(JSON.parse(d.toString())));
  await new Promise((r) => ws.once('open', r));
  return { ws, msgs };
}

const sk = generateSecretKey();
const mk = (kind: number, created_at: number, tags: string[][] = []) =>
  finalizeEvent({ kind, created_at, tags, content: 'x' }, sk);

describe('DevRelay', () => {
  it('stores events, answers REQ with matches then EOSE, and streams new matches', async () => {
    const { ws, msgs } = await connect();
    const now = Math.floor(Date.now() / 1000);
    const a = mk(1059, now - 10, [['p', 'aa']]);
    const b = mk(1059, now - 10, [['p', 'bb']]);
    const c = mk(1, now - 10, [['p', 'aa']]);
    const old = mk(1059, now - 1000, [['p', 'aa']]);
    for (const e of [a, b, c, old]) ws.send(JSON.stringify(['EVENT', e]));
    await sleep(100);
    expect(msgs.filter((m) => m[0] === 'OK').every((m) => m[2] === true)).toBe(true);

    ws.send(JSON.stringify(['REQ', 's1', { kinds: [1059], '#p': ['aa'], since: now - 100 }]));
    await sleep(100);
    const got = msgs.filter((m) => m[0] === 'EVENT' && m[1] === 's1').map((m) => (m[2] as { id: string }).id);
    expect(got).toEqual([a.id]);
    expect(msgs.some((m) => m[0] === 'EOSE' && m[1] === 's1')).toBe(true);

    const live = mk(1059, now, [['p', 'aa']]);
    ws.send(JSON.stringify(['EVENT', live]));
    await sleep(100);
    expect(msgs.filter((m) => m[0] === 'EVENT' && m[1] === 's1').map((m) => (m[2] as { id: string }).id)).toEqual([a.id, live.id]);

    ws.send(JSON.stringify(['CLOSE', 's1']));
    await sleep(50);
    ws.send(JSON.stringify(['EVENT', mk(1059, now, [['p', 'aa']])]));
    await sleep(100);
    expect(msgs.filter((m) => m[0] === 'EVENT' && m[1] === 's1')).toHaveLength(2);
  });

  it('rejects bad signatures and expired events', async () => {
    const { ws, msgs } = await connect();
    const now = Math.floor(Date.now() / 1000);
    const good = mk(1059, now);
    ws.send(JSON.stringify(['EVENT', { ...good, content: 'tampered' }]));
    ws.send(JSON.stringify(['EVENT', mk(1059, now, [['expiration', String(now - 5)]])]));
    await sleep(100);
    const oks = msgs.filter((m) => m[0] === 'OK');
    expect(oks).toHaveLength(2);
    expect(oks.every((m) => m[2] === false)).toBe(true);
    expect(relay.events.size).toBe(0);
  });

  it('delivers across connections', async () => {
    const a = await connect();
    const b = await connect();
    a.ws.send(JSON.stringify(['REQ', 'x', { kinds: [7] }]));
    await sleep(50);
    const e = mk(7, Math.floor(Date.now() / 1000));
    b.ws.send(JSON.stringify(['EVENT', e]));
    await sleep(100);
    expect(a.msgs.some((m) => m[0] === 'EVENT' && (m[2] as { id: string }).id === e.id)).toBe(true);
  });
});
