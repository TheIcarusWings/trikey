import { createServer, type Server, type Socket } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { ElectrumClient, ElectrumError, ElectrumUnavailableError, LineDecoder } from '../src/chain/electrum.js';
import { isLinked, medianTimePast, parseHeader, splitHeaders } from '../src/chain/headers.js';
import { ChainService } from '../src/chain/chain.js';
import { FakeElectrum, headerHash, makeHeader } from './support/fake-electrum.js';
import { makeWallet } from './helpers.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(cond: () => boolean, timeoutMs = 3000) {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
    await sleep(10);
  }
}

describe('LineDecoder (Electrum framing)', () => {
  it('splits on newlines across chunk boundaries, drops blank lines and CRs', () => {
    const d = new LineDecoder();
    expect(d.push('{"a":')).toEqual([]);
    expect(d.push('1}\n{"b"')).toEqual(['{"a":1}']);
    expect(d.push(':2}\r\n\n{"c":3}\n{"d"')).toEqual(['{"b":2}', '{"c":3}']);
    expect(d.push(':4}\n')).toEqual(['{"d":4}']);
  });

  it('refuses a line that never ends', () => {
    const d = new LineDecoder(16);
    expect(d.push('0123456789')).toEqual([]);
    expect(() => d.push('0123456789')).toThrow(/too long/);
    // and recovers for the next message
    expect(d.push('{}\n')).toEqual(['{}']);
  });
});

describe('block headers', () => {
  it('parses, links and computes median time past like consensus', () => {
    const times = [100, 300, 200, 500, 400, 700, 600, 900, 800, 1100, 1000, 50];
    const hs: string[] = [];
    let prev = '00'.repeat(32);
    for (const t of times) {
      const h = makeHeader(prev, t);
      hs.push(h);
      prev = headerHash(h);
    }
    const parsed = splitHeaders(hs.join(''));
    expect(parsed[3].time).toBe(500);
    expect(parsed[3].prevHash).toBe(parsed[2].hash);
    expect(isLinked(parsed)).toBe(true);
    expect(isLinked([parsed[0], parsed[2]])).toBe(false);
    // The last 11 times are 300..1100 plus 50: sorted, element 5 is 600.
    expect(medianTimePast(parsed)).toBe(600);
    expect(medianTimePast(parsed.slice(0, 3))).toBe(200);
    expect(() => parseHeader('00')).toThrow();
  });
});

describe('ElectrumClient', () => {
  let fake: FakeElectrum;
  let client: ElectrumClient | undefined;
  let raw: Server | undefined;

  afterEach(async () => {
    client?.stop();
    client = undefined;
    await fake?.stop();
    if (raw) await new Promise<void>((r) => raw!.close(() => r()));
    raw = undefined;
  });

  it('handshakes, subscribes to headers and frames fragmented replies', async () => {
    fake = new FakeElectrum({ blocks: 5 });
    fake.fragment = true;
    const port = await fake.start();
    client = new ElectrumClient({ host: '127.0.0.1', port, minBackoffMs: 20, maxBackoffMs: 50 });
    client.start();
    await client.waitReady(2000);
    expect(client.serverVersion?.[0]).toBe('FakeElectrs 0.1');
    expect(client.tip?.height).toBe(4);
    expect(fake.calls.map((c) => c.method).slice(0, 2)).toEqual(['server.version', 'blockchain.headers.subscribe']);

    const r = await client.request<{ hex: string }>('blockchain.block.headers', [0, 5]);
    expect(splitHeaders(r.hex)).toHaveLength(5);
    // concurrent requests are matched by id
    const [a, b] = await Promise.all([client.request('server.ping'), client.request('blockchain.block.headers', [4, 1])]);
    expect(a).toBeNull();
    expect((b as { count: number }).count).toBe(1);
  });

  it('maps error replies, follows header notifications and reconnects after a drop', async () => {
    fake = new FakeElectrum({ blocks: 3 });
    const port = await fake.start();
    client = new ElectrumClient({ host: '127.0.0.1', port, minBackoffMs: 20, maxBackoffMs: 50 });
    const tips: number[] = [];
    const states: boolean[] = [];
    client.onHeader((h) => tips.push(h.height));
    client.onStatus((s) => states.push(s));
    client.start();
    await client.waitReady(2000);

    await expect(client.request('blockchain.transaction.get', ['ab'.repeat(32)])).rejects.toBeInstanceOf(ElectrumError);

    fake.mine(2, 1_800_000_000);
    await waitFor(() => client!.tip?.height === 4);
    expect(tips).toContain(4);

    fake.dropConnections();
    await waitFor(() => states.includes(false));
    await expect(client.request('server.ping')).rejects.toBeInstanceOf(ElectrumUnavailableError);
    await waitFor(() => client!.connected, 3000);
    expect(states).toEqual([true, false, true]);
    await expect(client.request('server.ping')).resolves.toBeNull();
  });

  it('times out requests the server never answers, and drops a server that sends garbage', async () => {
    let conns = 0;
    let mode: 'silent' | 'garbage' = 'silent';
    raw = createServer((s: Socket) => {
      conns++;
      s.setEncoding('utf8');
      s.on('data', (chunk: string) => {
        for (const line of chunk.split('\n').filter(Boolean)) {
          const req = JSON.parse(line);
          if (req.method === 'server.version') s.write(`${JSON.stringify({ id: req.id, result: ['x', '1.4'] })}\n`);
          else if (req.method === 'blockchain.headers.subscribe')
            s.write(`${JSON.stringify({ id: req.id, result: { height: 0, hex: makeHeader('00'.repeat(32), 1) } })}\n`);
          else if (mode === 'garbage') s.write('this is not json\n');
          // otherwise: never answer
        }
      });
      s.on('error', () => {});
    });
    await new Promise<void>((r) => raw!.listen(0, '127.0.0.1', () => r()));
    const port = (raw.address() as { port: number }).port;
    client = new ElectrumClient({ host: '127.0.0.1', port, requestTimeoutMs: 100, minBackoffMs: 20, maxBackoffMs: 40 });
    client.start();
    await client.waitReady(2000);
    await expect(client.request('server.ping')).rejects.toThrow(/timed out/);

    mode = 'garbage';
    await expect(client.request('server.ping')).rejects.toBeInstanceOf(ElectrumUnavailableError);
    await waitFor(() => conns >= 2);
  });

  it('ChainService computes the tip MTP and scans a wallet with a gap limit', async () => {
    fake = new FakeElectrum({ blocks: 15, startTime: 1_000_000, spacing: 100 });
    const port = await fake.start();
    client = new ElectrumClient({ host: '127.0.0.1', port });
    client.start();
    await client.waitReady(2000);
    const chain = new ChainService({ electrum: client });
    const tip = await chain.tip();
    expect(tip.height).toBe(14);
    // times 1_000_000 + 100 * (4..14): median is block 9
    expect(tip.medianTimePast).toBe(1_000_900);
    expect(tip.time).toBe(1_001_400);

    const wallet = await makeWallet();
    const pay = (chainIdx: 0 | 1, index: number, value: number, n: number) =>
      fake.addUtxo(wallet.derive(chainIdx, index).script, { txid: n.toString(16).padStart(64, '0'), vout: 1, value, height: 10 });
    pay(0, 0, 1000, 1);
    pay(0, 5, 2000, 2);
    pay(1, 3, 3000, 3);
    pay(0, 45, 4000, 4); // past the gap after index 5
    const found = await chain.walletUtxos(wallet);
    expect(found.map((u) => [u.chain, u.index, u.value]).sort()).toEqual([
      [0, 0, 1000n],
      [0, 5, 2000n],
      [1, 3, 3000n],
    ]);
    // A known-used index extends the scan.
    const more = await chain.walletUtxos(wallet, { minIndex: { 0: 45 } });
    expect(more.map((u) => u.index).sort((a, b) => a - b)).toEqual([0, 3, 5, 45]);
  });
});
