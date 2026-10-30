/**
 * A relay that refuses or fails the connection, over the platform's real WebSocket (the other tests use
 * in-memory relays and never see a failing socket). nostr-tools' relay calls `ws.close()` from its own
 * `error` handler and Node's WebSocket dispatches `error` again from inside `close()`, so without
 * `onceCloseWebSocket` one unreachable relay recursed until the stack overflowed and the guardian died
 * ("Maximum call stack size exceeded", seen on a real Umbrel right after setup).
 */
import { createServer } from 'node:net';
import { SimplePool } from 'nostr-tools/pool';
import { describe, expect, it } from 'vitest';
import { SimplePoolRelayPool, createSimplePool, onceCloseWebSocket, type NostrEvent } from '../src/index.js';

/** A localhost port nothing listens on: bound, then released. */
async function closedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((r) => server.close(() => r()));
  return port;
}

const EVENT = { kind: 1, id: '00'.repeat(32), pubkey: '00'.repeat(32), created_at: 1, tags: [], content: '', sig: '00'.repeat(64) } as NostrEvent;

/** Runs `fn` and fails if anything throws outside it (the crash was an uncaught exception, not a rejection). */
async function noUncaught(fn: () => Promise<void>): Promise<void> {
  const errors: unknown[] = [];
  const onError = (e: unknown) => errors.push(e);
  process.on('uncaughtException', onError);
  try {
    await fn();
    await new Promise((r) => setTimeout(r, 300));
  } finally {
    process.off('uncaughtException', onError);
  }
  expect(errors.map(String)).toEqual([]);
}

describe('an unreachable relay', () => {
  it('the once-close WebSocket ignores a second close()', () => {
    const Ws = onceCloseWebSocket()!;
    expect(Ws).toBeDefined();
    expect(onceCloseWebSocket()).toBe(Ws);
    expect(Object.getPrototypeOf(Ws)).toBe(globalThis.WebSocket);
  });

  it('a subscription reports the relay as failed and the process lives', { timeout: 20_000 }, async () => {
    const relays = [`ws://127.0.0.1:${await closedPort()}`, `ws://127.0.0.1:${await closedPort()}`];
    const pool = new SimplePoolRelayPool({ pool: createSimplePool({ enableReconnect: true, enablePing: true }), maxWaitMs: 3000 });
    await noUncaught(async () => {
      const reasons = await new Promise<string[]>((resolve) => {
        pool.subscribe(relays, { kinds: [1] }, { onevent: () => {}, onclose: resolve });
      });
      expect(reasons).toHaveLength(2);
      for (const r of reasons) expect(r).toMatch(/connection failed|closed/);
    });
    pool.close();
  });

  it('a publish resolves with ok: false for it and the process lives', { timeout: 20_000 }, async () => {
    const relays = [`ws://127.0.0.1:${await closedPort()}`];
    const pool = new SimplePoolRelayPool({ maxWaitMs: 3000 });
    await noUncaught(async () => {
      const out = await pool.publish(relays, EVENT);
      expect(out).toEqual([{ relay: relays[0], ok: false, reason: expect.stringMatching(/connection/) }]);
    });
    pool.close();
  });

  it("nostr-tools' own default socket still recurses (this guard can go once nostr-tools fixes it)", { timeout: 20_000 }, async () => {
    // Documents why the guard exists: run the same failure through a plain SimplePool in a child process,
    // so its stack overflow cannot take this test run down.
    const { execFileSync } = await import('node:child_process');
    const port = await closedPort();
    const script = `
      const { SimplePool } = await import(${JSON.stringify(import.meta.resolve('nostr-tools/pool'))});
      process.on('uncaughtException', (e) => { console.log('CRASH ' + e.message); process.exit(0); });
      process.on('unhandledRejection', () => {});
      new SimplePool().subscribeMany(['ws://127.0.0.1:${port}'], { kinds: [1] }, { onevent() {}, onclose() {} });
      setTimeout(() => { console.log('ALIVE'); process.exit(0); }, 3000);`;
    const out = execFileSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    expect(['CRASH Maximum call stack size exceeded', 'ALIVE']).toContain(out.trim());
    // When this says ALIVE, nostr-tools no longer recurses and `onceCloseWebSocket` is only a safety net.
    void SimplePool;
  });
});
