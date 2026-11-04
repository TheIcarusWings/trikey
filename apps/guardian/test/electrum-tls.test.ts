/**
 * Electrum over TLS (packaging/compose: the server is often on another machine) and the plain-TCP address rule:
 * plain TCP only to this box or the owner's own network, TLS verified against the public CAs or a pinned certificate.
 */
import { createServer as createTlsServer, type Server as TlsServer } from 'node:tls';
import { connect, createServer as createNetServer } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { ElectrumClient, isLocalAddress, normalizeFingerprint } from '../src/chain/electrum.js';
import { createLogger } from '../src/log.js';
import { FakeElectrum } from './support/fake-electrum.js';
import { selfSignedCert, type TestCert } from './support/self-signed.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(cond: () => boolean, timeoutMs = 3000) {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
    await sleep(10);
  }
}

/** TLS in front of the fake Electrs, as stunnel or nginx in front of Electrs (or Fulcrum's own TLS port). */
async function tlsFront(cert: TestCert, backendPort: number): Promise<{ server: TlsServer; port: number }> {
  const server = createTlsServer({ cert: cert.cert, key: cert.key }, (tlsSocket) => {
    const back = connect({ host: '127.0.0.1', port: backendPort });
    tlsSocket.pipe(back).pipe(tlsSocket);
    const end = () => {
      tlsSocket.destroy();
      back.destroy();
    };
    tlsSocket.on('error', end);
    back.on('error', end);
    tlsSocket.on('close', end);
  });
  server.on('tlsClientError', () => {});
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  return { server, port: (server.address() as { port: number }).port };
}

describe('Electrum over TLS', () => {
  let fake: FakeElectrum | undefined;
  let front: TlsServer | undefined;
  let client: ElectrumClient | undefined;
  const lines: string[] = [];
  const log = createLogger({ level: 'debug', write: (l) => lines.push(l) });

  afterEach(async () => {
    client?.stop();
    client = undefined;
    await fake?.stop();
    fake = undefined;
    if (front) await new Promise<void>((r) => front!.close(() => r()));
    front = undefined;
    lines.length = 0;
  });

  async function start(cert: TestCert) {
    fake = new FakeElectrum({ blocks: 3 });
    const port = await fake.start();
    const f = await tlsFront(cert, port);
    front = f.server;
    return f.port;
  }

  it('connects to a server whose certificate chains to a trusted CA, and says it is TLS', async () => {
    const cert = selfSignedCert();
    const port = await start(cert);
    client = new ElectrumClient({ host: '127.0.0.1', port, tls: true, ca: [cert.cert], minBackoffMs: 20, maxBackoffMs: 50, log });
    client.start();
    await client.waitReady(3000);
    expect(client.tip?.height).toBe(2);
    expect(client.transport).toBe('tls');
    expect(lines.some((l) => /electrum\.connected .*transport=tls /.test(l))).toBe(true);
  });

  it('refuses a self-signed certificate without a pin, and says to pin it', async () => {
    const cert = selfSignedCert();
    const port = await start(cert);
    client = new ElectrumClient({ host: '127.0.0.1', port, tls: true, minBackoffMs: 20, maxBackoffMs: 50, log });
    client.start();
    await waitFor(() => client!.lastError !== undefined);
    expect(client.connected).toBe(false);
    expect(client.lastError).toMatch(/not signed by a public CA.*ELECTRUM_TLS_CERT_SHA256/);
    expect(fake!.calls).toEqual([]); // nothing reached the server
  });

  it('accepts exactly the pinned certificate (self-signed, whatever its names)', async () => {
    const cert = selfSignedCert({ cn: 'fulcrum.invalid' });
    const port = await start(cert);
    client = new ElectrumClient({ host: '127.0.0.1', port, tls: true, certSha256: cert.fingerprint256, minBackoffMs: 20, maxBackoffMs: 50, log });
    client.start();
    await client.waitReady(3000);
    expect(client.transport).toBe('tls-pinned');
    expect(fake!.calls.map((c) => c.method).slice(0, 2)).toEqual(['server.version', 'blockchain.headers.subscribe']);
  });

  it('refuses another certificate than the pinned one before sending anything, and names the one it saw', async () => {
    const cert = selfSignedCert();
    const other = selfSignedCert();
    const port = await start(cert);
    client = new ElectrumClient({ host: '127.0.0.1', port, tls: true, certSha256: other.fingerprint256, minBackoffMs: 20, maxBackoffMs: 50, log });
    client.start();
    await waitFor(() => client!.lastError !== undefined);
    await sleep(100);
    expect(client.connected).toBe(false);
    expect(client.lastError).toContain(cert.fingerprint256);
    expect(client.lastError).toMatch(/not the pinned one/);
    expect(fake!.calls).toEqual([]);
    // Logged once per kind of failure, not on every retry.
    await sleep(200);
    expect(lines.filter((l) => l.includes('electrum.connect_failed')).length).toBe(1);
  });

  it('says so when the port speaks plain TCP, not TLS', async () => {
    // A plain Electrum port answers the TLS hello with text.
    const plain = createNetServer((sock) => {
      sock.on('error', () => {});
      sock.once('data', () => sock.end('{"jsonrpc":"2.0","error":{"code":-32700,"message":"parse error"}}\n'));
    });
    await new Promise<void>((r) => plain.listen(0, '127.0.0.1', () => r()));
    try {
      const port = (plain.address() as { port: number }).port;
      client = new ElectrumClient({ host: '127.0.0.1', port, tls: true, certSha256: selfSignedCert().fingerprint256, minBackoffMs: 20, maxBackoffMs: 50, log });
      client.start();
      await waitFor(() => client!.lastError !== undefined, 4000);
      expect(client.connected).toBe(false);
      expect(client.lastError).toMatch(/does not speak TLS on this port/);
    } finally {
      client?.stop();
      await new Promise<void>((r) => plain.close(() => r()));
    }
  });
});

describe('plain TCP only to this box or the owner network', () => {
  let fake: FakeElectrum | undefined;
  let client: ElectrumClient | undefined;

  afterEach(async () => {
    client?.stop();
    client = undefined;
    await fake?.stop();
    fake = undefined;
  });

  it('classifies addresses: loopback, private, Tailscale, ULA and link-local are local; the rest is the internet', () => {
    for (const ip of ['127.0.0.1', '::1', '10.21.0.5', '172.17.0.1', '192.168.65.254', '100.101.102.103', 'fd12::1', '169.254.1.2', 'fe80::1', '::ffff:192.168.1.2'])
      expect(isLocalAddress(ip), ip).toBe(true);
    for (const ip of ['8.8.8.8', '1.1.1.1', '2a01:4f8::1', '172.32.0.1', '::ffff:8.8.8.8']) expect(isLocalAddress(ip), ip).toBe(false);
  });

  it('refuses a name that resolves to the internet, before connecting, and retries later', async () => {
    let lookups = 0;
    const lines: string[] = [];
    client = new ElectrumClient({
      host: 'electrum.example.com',
      port: 50001,
      minBackoffMs: 20,
      maxBackoffMs: 40,
      resolve: async () => {
        lookups++;
        return [{ address: '203.0.113.7', family: 4 }];
      },
      log: createLogger({ write: (l) => lines.push(l) }),
    });
    client.start();
    await waitFor(() => lookups >= 2);
    expect(client.connected).toBe(false);
    expect(client.lastError).toMatch(/electrum\.example\.com \(203\.0\.113\.7\) is not on this box or your own network.*ELECTRUM_TLS=1/);
    expect(lines.filter((l) => l.includes('ERROR electrum.connect_failed')).length).toBe(1);
  });

  it('refuses a name when any of its addresses is on the internet', async () => {
    let lookups = 0;
    client = new ElectrumClient({
      host: 'mixed.example',
      port: 50001,
      minBackoffMs: 20,
      resolve: async () => {
        lookups++;
        return [
          { address: '192.168.1.5', family: 4 },
          { address: '198.51.100.1', family: 4 },
        ];
      },
    });
    client.start();
    await waitFor(() => lookups >= 1 && client!.lastError !== undefined);
    expect(client.lastError).toMatch(/198\.51\.100\.1/);
  });

  it('connects to the checked address of a local name (a Docker service name, host.docker.internal)', async () => {
    fake = new FakeElectrum({ blocks: 3 });
    const port = await fake.start();
    client = new ElectrumClient({ host: 'electrs', port, minBackoffMs: 20, resolve: async () => [{ address: '127.0.0.1', family: 4 }] });
    client.start();
    await client.waitReady(3000);
    expect(client.transport).toBe('tcp');
  });

  it('with allowPublicPlaintext, an internet address is not refused by the rule (the connection is tried)', async () => {
    fake = new FakeElectrum({ blocks: 3 });
    const port = await fake.start();
    // The resolver says "public", the connection then goes to that address: here a stand-in on loopback is not
    // possible, so check that the rule lets it through to a connect attempt (which fails on this test address).
    let lookups = 0;
    client = new ElectrumClient({
      host: 'public.example',
      port,
      allowPublicPlaintext: true,
      minBackoffMs: 20,
      connectTimeoutMs: 200,
      resolve: async () => {
        lookups++;
        return [{ address: '192.0.2.1', family: 4 }];
      },
    });
    client.start();
    await waitFor(() => lookups >= 1);
    await sleep(50);
    expect(client.lastError ?? '').not.toMatch(/not on this box/);
  });
});

describe('certificate fingerprints', () => {
  it('normalises the forms people paste: colons or not, lower case, openssl output', () => {
    const fp = 'AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89';
    expect(normalizeFingerprint(fp)).toBe(fp);
    expect(normalizeFingerprint(fp.replace(/:/g, '').toLowerCase())).toBe(fp);
    expect(normalizeFingerprint(`sha256 Fingerprint=${fp}`)).toBe(fp);
    expect(normalizeFingerprint('SHA256 Fingerprint=' + fp.toLowerCase())).toBe(fp);
    expect(normalizeFingerprint('abcd')).toBeUndefined();
    expect(normalizeFingerprint('zz'.repeat(32))).toBeUndefined();
  });
});
