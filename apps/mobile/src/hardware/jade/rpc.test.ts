/**
 * Jade's RPC framing over a byte pipe (rpc.ts), against a scripted Jade: requests are CBOR maps with an id of at most 16
 * characters, replies may come in any split and with `log` lines in between, errors map to the adapters' codes, replies
 * split over several messages are joined with `get_extended_data`, and a dropped link or a timeout ends the wait.
 */
import { describe, expect, it } from 'vitest';
import { CborIncomplete, decodeCbor, encodeCbor, type CborValue } from './cbor';
import type { JadeConnection } from './link';
import { JadeRpc, JadeRpcError } from './rpc';

type Msg = Record<string, CborValue>;

/** A pipe whose "Jade" is a function from request to replies; replies are cut into `piece`-byte chunks. */
function scripted(answer: (req: Msg) => Array<Record<string, unknown>>, piece = 7) {
  const data = new Set<(b: Uint8Array) => void>();
  const downs = new Set<(e?: Error) => void>();
  let inbound = new Uint8Array(0);
  const requests: Msg[] = [];
  const conn: JadeConnection & { drop(): void } = {
    device: { id: 'x', name: 'Jade 123456' },
    async write(bytes) {
      const j = new Uint8Array(inbound.length + bytes.length);
      j.set(inbound);
      j.set(bytes, inbound.length);
      inbound = j;
      for (;;) {
        let d;
        try {
          d = decodeCbor(inbound);
        } catch (e) {
          if (e instanceof CborIncomplete) return;
          throw e;
        }
        inbound = inbound.slice(d.end);
        const req = d.value as Msg;
        requests.push(req);
        setTimeout(() => {
          for (const reply of answer(req)) {
            const b = encodeCbor(reply);
            for (let at = 0; at < b.length; at += piece) for (const l of data) l(b.slice(at, at + piece));
          }
        }, 0);
        if (inbound.length === 0) return;
      }
    },
    onData(l) {
      data.add(l);
      return () => data.delete(l);
    },
    onDisconnect(l) {
      downs.add(l);
      return () => downs.delete(l);
    },
    async close() {},
    drop() {
      for (const l of downs) l(new Error('gone'));
    },
  };
  return { conn, requests };
}

describe('JadeRpc', () => {
  it('sends { id, method, params } and reads the reply however it is split, skipping log lines', async () => {
    const { conn, requests } = scripted((req) => [{ log: new Uint8Array([73, 32, 104, 105]) }, { id: req.id, result: { JADE_VERSION: '1.0.41' } }], 3);
    const rpc = new JadeRpc(conn);
    expect(await rpc.call('get_version_info')).toEqual({ JADE_VERSION: '1.0.41' });
    expect(await rpc.call('get_xpub', { network: 'testnet', path: [] })).toEqual({ JADE_VERSION: '1.0.41' });
    expect(requests[0]).toEqual({ id: expect.any(String), method: 'get_version_info' });
    expect(requests[1]).toEqual({ id: expect.any(String), method: 'get_xpub', params: { network: 'testnet', path: [] } });
    for (const r of requests) expect((r.id as string).length).toBeLessThanOrEqual(16);
    expect(requests[0]!.id).not.toBe(requests[1]!.id);
  });

  it('ignores replies to other ids, and takes the "00" error the Jade sends for a message it could not read', async () => {
    const { conn } = scripted((req) => [{ id: 'other', result: 'not mine' }, { id: req.id, result: 'mine' }]);
    const rpc = new JadeRpc(conn);
    expect(await rpc.call('ping')).toBe('mine');
    const bad = scripted(() => [{ id: '00', error: { code: -32600, message: 'Invalid RPC Request message' } }]);
    await expect(new JadeRpc(bad.conn).call('ping')).rejects.toMatchObject({ jadeCode: -32600, code: 'invalid-request' });
  });

  it('maps the firmware error codes (cbor_rpc.h)', async () => {
    const cases: Array<[number, string, RegExp]> = [
      [-32000, 'user-rejected', /declined on the Jade/],
      [-32002, 'device-locked', /locked/],
      [-32003, 'invalid-request', /another network/],
      [-32601, 'invalid-request', /firmware does not know "frobnicate"/],
      [-32603, 'device-error', /Failed to sign \(-32603\)/],
    ];
    for (const [code, ours, text] of cases) {
      const { conn } = scripted((req) => [{ id: req.id, error: { code, message: 'Failed to sign', data: null } }]);
      const err = await new JadeRpc(conn).call('frobnicate').catch((e: unknown) => e);
      expect(err).toBeInstanceOf(JadeRpcError);
      expect(err).toMatchObject({ code: ours, jadeCode: code, kind: 'jade-ble' });
      expect((err as Error).message).toMatch(text);
    }
  });

  it('joins a reply split over several messages with get_extended_data (sign_psbt)', async () => {
    const parts = [new Uint8Array([1, 2]), new Uint8Array([3]), new Uint8Array([4, 5, 6])];
    let origid = '';
    const { conn, requests } = scripted((req) => {
      if (req.method === 'sign_psbt') {
        origid = req.id as string;
        return [{ id: req.id, seqnum: 1, seqlen: 3, result: parts[0] }];
      }
      const p = req.params as Msg;
      expect(p).toEqual({ origid, orig: 'sign_psbt', seqnum: expect.any(Number), seqlen: 3 });
      return [{ id: req.id, seqnum: p.seqnum, seqlen: 3, result: parts[(p.seqnum as number) - 1] }];
    });
    const rpc = new JadeRpc(conn);
    expect(await rpc.callJoined('sign_psbt', { network: 'testnet', psbt: new Uint8Array([9]) })).toEqual(new Uint8Array([1, 2, 3, 4, 5, 6]));
    expect(requests.map((r) => [r.method, (r.params as Msg | undefined)?.seqnum])).toEqual([
      ['sign_psbt', undefined],
      ['get_extended_data', 2],
      ['get_extended_data', 3],
    ]);
    // One message: no extended data asked for.
    const one = scripted((req) => [{ id: req.id, seqnum: 1, seqlen: 1, result: new Uint8Array([7]) }]);
    expect(await new JadeRpc(one.conn).callJoined('sign_psbt', {})).toEqual(new Uint8Array([7]));
    expect(one.requests).toHaveLength(1);
  });

  it('refuses parts out of order', async () => {
    const { conn } = scripted((req) => [{ id: req.id, seqnum: 2, seqlen: 3, result: new Uint8Array([1]) }]);
    await expect(new JadeRpc(conn).callJoined('sign_psbt', {})).rejects.toThrow(/out of order/);
  });

  it('ends the wait when the link drops, when the time is up, or when the caller cancels', async () => {
    const silent = scripted(() => []);
    const rpc = new JadeRpc(silent.conn);
    const p = rpc.call('auth_user', {}, { timeoutMs: null });
    await new Promise((r) => setTimeout(r, 5));
    silent.conn.drop();
    await expect(p).rejects.toMatchObject({ code: 'disconnected' });
    await expect(rpc.call('ping')).rejects.toMatchObject({ code: 'disconnected' });

    const slow = scripted(() => []);
    await expect(new JadeRpc(slow.conn).call('ping', undefined, { timeoutMs: 20 })).rejects.toMatchObject({ code: 'timeout' });

    const ac = new AbortController();
    const waiting = new JadeRpc(scripted(() => []).conn).call('sign_message', {}, { timeoutMs: null, signal: ac.signal });
    ac.abort();
    await expect(waiting).rejects.toMatchObject({ code: 'cancelled' });
  });

  it('skips bytes that are not CBOR and goes on', async () => {
    const data = new Set<(b: Uint8Array) => void>();
    const conn: JadeConnection = {
      device: { id: 'x', name: 'Jade' },
      write: async (b) => {
        const req = decodeCbor(b).value as Msg;
        setTimeout(() => {
          for (const l of data) l(new Uint8Array([0xff, 0xff, ...encodeCbor({ id: req.id, result: 1 })]));
        }, 0);
      },
      onData: (l) => (data.add(l), () => data.delete(l)),
      onDisconnect: () => () => {},
      close: async () => {},
    };
    const rpc = new JadeRpc(conn);
    expect(await rpc.call('ping')).toBe(1);
    expect(rpc.junk).toBeGreaterThan(0);
  });
});
