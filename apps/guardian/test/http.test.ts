import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { request as httpRequest, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { checkOrigin, contentSecurityPolicy, inlineScriptHashes, isJsonContentType, startHttpServer, type Route } from '../src/http/server.js';
import { silentLogger } from '../src/log.js';

describe('origin and content-type checks', () => {
  it('trusts Sec-Fetch-Site when the browser sends it', () => {
    expect(checkOrigin({ 'sec-fetch-site': 'same-origin' })).toEqual({ ok: true });
    for (const site of ['cross-site', 'same-site', 'none']) expect(checkOrigin({ 'sec-fetch-site': site, origin: 'http://box' , host: 'box' }).ok).toBe(false);
  });

  it('falls back to Origin vs Host / X-Forwarded-Host', () => {
    expect(checkOrigin({ origin: 'http://umbrel.local:3010', host: 'umbrel.local:3010' }).ok).toBe(true);
    expect(checkOrigin({ origin: 'http://UMBREL.local:3010', host: 'umbrel.local:3010' }).ok).toBe(true);
    // Behind a proxy that rewrites Host
    expect(checkOrigin({ origin: 'http://umbrel.local:3010', host: 'trikey-guardian_server_1:3000', 'x-forwarded-host': 'umbrel.local:3010' }).ok).toBe(true);
    expect(checkOrigin({ origin: 'http://evil.example', host: 'umbrel.local:3010' }).ok).toBe(false);
    expect(checkOrigin({ origin: 'http://umbrel.local:3011', host: 'umbrel.local:3010' }).ok).toBe(false);
    expect(checkOrigin({ origin: 'null', host: 'umbrel.local' }).ok).toBe(false);
    expect(checkOrigin({ origin: 'not a url', host: 'umbrel.local' }).ok).toBe(false);
    // No browser signals at all: a non-browser client (curl), which another site cannot drive.
    expect(checkOrigin({ host: 'umbrel.local' }).ok).toBe(true);
  });

  it('accepts only application/json', () => {
    expect(isJsonContentType('application/json')).toBe(true);
    expect(isJsonContentType('Application/JSON; charset=utf-8')).toBe(true);
    for (const t of [undefined, '', 'text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data; boundary=x', 'application/jsonp'])
      expect(isJsonContentType(t)).toBe(false);
  });

  it('hashes inline scripts into the CSP instead of allowing unsafe-inline', () => {
    const html = '<script src="/a.js"></script><script>alert(1)</script><script type="module">x()</script>';
    const hashes = inlineScriptHashes(html);
    expect(hashes).toEqual(['alert(1)', 'x()'].map((s) => createHash('sha256').update(s).digest('base64')));
    const csp = contentSecurityPolicy(hashes);
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain(`'sha256-${hashes[0]}'`);
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).not.toContain('unsafe-inline');
    expect(inlineScriptHashes('<script src="/theme-init.js"></script>')).toEqual([]);
  });
});

describe('HTTP server', () => {
  let server: Server;
  let port: number;
  let dir: string;
  const calls: unknown[] = [];

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'trikey-http-'));
    const web = join(dir, 'web');
    await mkdir(join(web, 'assets'), { recursive: true });
    await writeFile(join(web, 'index.html'), '<!doctype html><title>t</title><script src="/theme-init.js"></script>');
    await writeFile(join(web, 'assets', 'app-123.js'), 'console.log(1)');
    await writeFile(join(dir, 'secret.txt'), 'do not serve');
    await symlink(join(dir, 'secret.txt'), join(web, 'link.txt'));
    const routes: Route[] = [
      { method: 'GET', path: '/ping', handler: () => ({ status: 200, body: { pong: true } }) },
      {
        method: 'POST',
        path: '/echo/:id',
        handler: ({ params, body }) => {
          calls.push({ params, body });
          return { status: 200, body: { id: params.id } };
        },
      },
      {
        method: 'POST',
        path: '/boom',
        handler: () => {
          throw new Error('database password is hunter2');
        },
      },
    ];
    server = await startHttpServer({ port: 0, host: '127.0.0.1', routes, webDir: web, log: silentLogger });
    port = (server.address() as { port: number }).port;
  });

  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    await rm(dir, { recursive: true, force: true });
  });

  /** Raw request (fetch would add its own Origin / Sec-Fetch headers). */
  function send(method: string, path: string, headers: Record<string, string> = {}, body?: string) {
    return new Promise<{ status: number; headers: Record<string, string | string[] | undefined>; text: string }>((resolve, reject) => {
      const req = httpRequest({ host: '127.0.0.1', port, method, path, headers: { host: `127.0.0.1:${port}`, ...headers } }, (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (text += c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, text }));
      });
      req.on('error', reject);
      if (body !== undefined) req.write(body);
      req.end();
    });
  }
  const json = { 'content-type': 'application/json' };

  it('sets security headers and no-store on API responses', async () => {
    const r = await send('GET', '/api/ping');
    expect(r.status).toBe(200);
    expect(JSON.parse(r.text)).toEqual({ pong: true });
    expect(r.headers['content-security-policy']).toContain("default-src 'self'");
    expect(r.headers['x-frame-options']).toBe('DENY');
    expect(r.headers['referrer-policy']).toBe('no-referrer');
    expect(r.headers['x-content-type-options']).toBe('nosniff');
    expect(r.headers['cache-control']).toBe('no-store');
  });

  it('rejects state-changing requests that are not JSON', async () => {
    for (const ct of [undefined, 'text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data; boundary=x']) {
      const r = await send('POST', '/api/echo/1', ct ? { 'content-type': ct } : {}, 'passphrase=x');
      expect(r.status).toBe(415);
    }
    expect(calls).toHaveLength(0);
  });

  it('rejects cross-origin state-changing requests', async () => {
    const bad = [
      { ...json, 'sec-fetch-site': 'cross-site' },
      { ...json, 'sec-fetch-site': 'same-site' },
      { ...json, origin: 'http://evil.example' },
      { ...json, origin: 'null' },
    ];
    for (const h of bad) {
      const r = await send('POST', '/api/echo/1', h, '{}');
      expect(r.status).toBe(403);
      expect(JSON.parse(r.text).error.code).toBe('forbidden');
    }
    expect(calls).toHaveLength(0);
  });

  it('accepts same-origin JSON requests', async () => {
    const good = [
      { ...json, 'sec-fetch-site': 'same-origin', origin: `http://127.0.0.1:${port}` },
      { ...json, origin: `http://127.0.0.1:${port}` },
      { ...json, origin: 'http://umbrel.local', 'x-forwarded-host': 'umbrel.local' },
      json,
    ];
    for (const h of good) {
      const r = await send('POST', '/api/echo/a%20b', h, '{"x":1}');
      expect(r.status).toBe(200);
    }
    expect(calls).toHaveLength(4);
    expect(calls[0]).toEqual({ params: { id: 'a b' }, body: { x: 1 } });
  });

  it('limits and validates bodies, and never echoes internals', async () => {
    expect((await send('POST', '/api/echo/1', json, 'x'.repeat(20_000))).status).toBe(413);
    expect((await send('POST', '/api/echo/1', json, '{nope')).status).toBe(400);
    const boom = await send('POST', '/api/boom', json, '{}');
    expect(boom.status).toBe(500);
    expect(boom.text).not.toContain('hunter2');
    expect((await send('GET', '/api/nope')).status).toBe(404);
    const wrong = await send('GET', '/api/echo/1');
    expect(wrong.status).toBe(405);
    expect(wrong.headers['allow']).toBe('POST');
  });

  it('serves the UI with an index.html fallback and no path escapes', async () => {
    const index = await send('GET', '/recovery');
    expect(index.status).toBe(200);
    expect(index.headers['content-type']).toContain('text/html');
    expect(index.text).toContain('<title>t</title>');
    expect(index.headers['content-security-policy']).toContain("script-src 'self'");
    const asset = await send('GET', '/assets/app-123.js');
    expect(asset.status).toBe(200);
    expect(asset.headers['content-type']).toContain('text/javascript');
    expect(asset.headers['cache-control']).toContain('immutable');
    expect((await send('GET', '/assets/missing.js')).status).toBe(404);
    for (const p of ['/../secret.txt', '/%2e%2e/secret.txt', '/assets/..%2f..%2fsecret.txt', '/link.txt', '/%00']) {
      const r = await send('GET', p);
      expect(r.text).not.toContain('do not serve');
    }
    expect((await send('POST', '/recovery', json, '{}')).status).toBe(405);
  });
});
