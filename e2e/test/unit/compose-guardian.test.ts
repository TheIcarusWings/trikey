/**
 * packaging/compose (the guardian on plain Docker), checked for the properties that must not drift: the image and its
 * version (in step with the Umbrel package), restart policy, init, health check, a named volume, the web UI on
 * loopback by default, the setup code (TRIKEY_PLATFORM=docker) and, for Umbrel and Start9, no setup code; the node
 * profile on the same pinned images as the regtest stack; every setting of .env.example used; and the release job that
 * attaches the pinned file. The running guardian is checked by packaging/compose/smoke-test.sh (compose.yml).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { COMPOSE_FILE, E2E_DIR } from '../../src/compose.js';

const ROOT = join(E2E_DIR, '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

interface Service {
  image: string;
  profiles?: string[];
  restart?: string;
  init?: boolean;
  ports?: string[];
  volumes?: string[];
  environment?: Record<string, string>;
  healthcheck?: { test: string[] };
  command?: string[];
}
const raw = read('packaging/compose/docker-compose.yml');
const compose = parse(raw) as { name: string; services: Record<string, Service>; volumes: Record<string, unknown> };
const guardian = compose.services['guardian']!;
const umbrel = parse(read('packaging/umbrel/trikey-guardian/docker-compose.yml')) as { services: Record<string, Service> };
const stack = parse(readFileSync(COMPOSE_FILE, 'utf8')) as { services: Record<string, Service> };
const envExample = read('packaging/compose/.env.example');

describe('packaging/compose/docker-compose.yml', () => {
  it('runs the published image, at the version the Umbrel package names (TRIKEY_IMAGE only overrides it for tests)', () => {
    const m = /^\$\{TRIKEY_IMAGE:-(ghcr\.io\/theicaruswings\/trikey-guardian:[0-9A-Za-z.-]+)\}$/.exec(guardian.image);
    expect(m, guardian.image).not.toBeNull();
    expect(m![1]).toBe(umbrel.services['server']!.image);
  });

  it('restarts unless stopped, with an init process, a health check and the data in a named volume', () => {
    expect(guardian.restart).toBe('unless-stopped');
    expect(guardian.init).toBe(true);
    expect(guardian.healthcheck?.test.join(' ')).toContain('/api/status');
    expect(guardian.volumes).toEqual(['guardian-data:/data']);
    expect(compose.volumes).toHaveProperty('guardian-data');
  });

  it('publishes only the web UI, on 127.0.0.1 unless the owner says otherwise', () => {
    expect(guardian.ports).toEqual(['${TRIKEY_UI_BIND:-127.0.0.1}:${TRIKEY_UI_PORT:-3000}:3000']);
    expect(envExample).toMatch(/^TRIKEY_UI_BIND=127\.0\.0\.1$/m);
    for (const name of ['bitcoind', 'electrs']) expect(compose.services[name]!.ports, name).toBeUndefined();
  });

  it('asks for the setup code at first run (TRIKEY_PLATFORM=docker); Umbrel and Start9 say who guards the page', () => {
    expect(guardian.environment?.['TRIKEY_PLATFORM']).toBe('docker');
    expect(umbrel.services['server']!.environment?.['TRIKEY_PLATFORM']).toBe('umbrel');
    expect(read('packaging/start9/startos/main.ts')).toMatch(/TRIKEY_PLATFORM: 'start9'/);
  });

  it('runs the node profile on the same pinned images as the regtest stack, and only with --profile node', () => {
    expect(guardian.profiles).toBeUndefined();
    for (const name of ['bitcoind', 'electrs']) {
      const s = compose.services[name]!;
      expect(s.profiles, name).toEqual(['node']);
      expect(s.image, name).toMatch(/:[A-Za-z0-9._-]+@sha256:[0-9a-f]{64}$/);
      expect(s.image, name).toBe(stack.services[name]!.image);
    }
    const node = compose.services['bitcoind']!.command!.join('\n');
    expect(node).toContain('-prune=0');
    expect(node).toContain('-rest=1');
    // No credentials in the file, and none that would block the guardian alone (no `:?` on them).
    expect(raw).not.toMatch(/BITCOIN_RPC_(USER|PASS):\?/);
    expect(raw).not.toMatch(/rpcpassword=[^"$]/);
  });

  it('uses every setting of .env.example, and .env.example sets no secret', () => {
    const keys = [...envExample.matchAll(/^([A-Z0-9_]+)=(.*)$/gm)].map((m) => ({ key: m[1]!, value: m[2]! }));
    expect(keys.length).toBeGreaterThan(10);
    for (const { key } of keys) expect(raw, key).toContain(`\${${key}`);
    for (const k of ['BITCOIN_RPC_USER', 'BITCOIN_RPC_PASS', 'ELECTRUM_TLS_CERT_SHA256']) expect(keys.find((x) => x.key === k)?.value, k).toBe('');
  });
});

describe('.github/workflows/docker.yml: the release files', () => {
  const wf = parse(read('.github/workflows/docker.yml')) as {
    jobs: Record<string, { needs?: string; if?: string; permissions?: Record<string, string>; steps: { name?: string; run?: string }[]; outputs?: Record<string, string> }>;
  };
  const job = wf.jobs['compose-files']!;

  it('runs after the image is pushed, on tags only, and may write release assets', () => {
    expect(job.needs).toBe('publish');
    expect(job.if).toBe("needs.publish.outputs.digest != ''");
    expect(wf.jobs['publish']!.if).toBe("github.ref_type == 'tag' && startsWith(github.ref_name, 'v')");
    expect(job.permissions).toEqual({ contents: 'write' });
    expect(wf.jobs['publish']!.outputs).toMatchObject({ digest: '${{ steps.build.outputs.digest }}' });
  });

  it('pins the image by digest and attaches the compose file and the settings to the release', () => {
    const script = job.steps.map((s) => s.run ?? '').join('\n');
    expect(script).toContain('pinned="${IMAGE}:${VERSION}@${DIGEST}"');
    expect(script).toContain('gh release upload');
    for (const f of ['trikey-guardian-compose.yml', 'trikey-guardian.env.example', 'trikey-guardian-compose.sha256']) expect(script).toContain(f);
  });
});
