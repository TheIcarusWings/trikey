/**
 * Signed releases (docs/design/signed-releases.md): packaging/release-signature.py, which makes a release's manifest and
 * checks its signature (in publish-release.yml through packaging/check-release-assets.sh, and in umbrel-store.yml), and
 * the guard rails of tools/release/sign-release.mjs, the owner's side.
 *
 * Events are signed here with nostr-tools, as the owner's signer app would, and checked by the Python, which has its
 * own BIP 340: support/bip340-test-vectors.csv is the BIP's own file
 * (github.com/bitcoin/bips, bip-0340/test-vectors.csv, fetched 2026-11-10).
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decode, npubEncode } from 'nostr-tools/nip19';
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { E2E_DIR } from '../../src/compose.js';

const ROOT = join(E2E_DIR, '..');
const SCRIPT = join(ROOT, 'packaging', 'release-signature.py');
const TAG = 'v0.1.99-alpha';
const MANIFEST = `trikey-${TAG}-SHA256SUMS`;
const EVENT = `${MANIFEST}.event.json`;

const py = (...args: string[]) => spawnSync('python3', ['-I', SCRIPT, ...args], { encoding: 'utf8' });

/** A release folder with two files, signed by `sk` (a fresh key unless given), and a signer file naming `signer`. */
function release(opts: { sk?: Uint8Array; signer?: Uint8Array; edit?: (tpl: Record<string, unknown>) => void } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'trikey-signed-'));
  const assets = join(dir, 'assets');
  mkdirSync(assets);
  writeFileSync(join(assets, `trikey-alpha-${TAG}.apk`), 'apk\n');
  writeFileSync(join(assets, 'trikey-guardian-compose.yml'), 'services: {}\n');
  const sk = opts.sk ?? generateSecretKey();
  writeFileSync(join(dir, 'signer.npub'), `# test\n${npubEncode(getPublicKey(opts.signer ?? sk))}\n`);
  const made = py('manifest', '--tag', TAG, '--dir', assets);
  expect(made.status, made.stderr).toBe(0);
  const tpl = JSON.parse(made.stdout) as Record<string, unknown>;
  opts.edit?.(tpl);
  writeFileSync(join(assets, EVENT), JSON.stringify(finalizeEvent(tpl as never, sk)));
  return { dir, assets, check: (tag = TAG) => py('check', '--tag', tag, '--dir', assets, '--signer-file', join(dir, 'signer.npub')) };
}

describe('packaging/release-signature.py', () => {
  it("verifies BIP 340 exactly as the BIP's test vectors say", () => {
    const code = [
      'import csv, importlib.util, sys',
      `spec = importlib.util.spec_from_file_location("rs", ${JSON.stringify(SCRIPT)})`,
      'rs = importlib.util.module_from_spec(spec); spec.loader.exec_module(rs)',
      'bad = []',
      `for row in csv.DictReader(open(${JSON.stringify(join(E2E_DIR, 'test', 'unit', 'support', 'bip340-test-vectors.csv'))})):`,
      '    got = rs.schnorr_verify(bytes.fromhex(row["message"]), bytes.fromhex(row["public key"]), bytes.fromhex(row["signature"]))',
      '    if got != (row["verification result"] == "TRUE"): bad.append(row["index"])',
      'print("ok" if not bad else "bad " + ",".join(bad))',
    ].join('\n');
    expect(execFileSync('python3', ['-I', '-B', '-c', code], { encoding: 'utf8' }).trim()).toBe('ok');
  });

  it('pins Trikey\'s publisher npub, the one the Zapstore listing names, and reads it as nostr-tools does', () => {
    const pinned = readFileSync(join(ROOT, 'packaging', 'release-signer.npub'), 'utf8').split('\n').filter((l) => l.trim() && !l.startsWith('#'));
    expect(pinned).toHaveLength(1);
    expect(pinned[0]).toBe((parse(readFileSync(join(ROOT, 'zapstore.yaml'), 'utf8')) as { pubkey: string }).pubkey);
    const code = `import importlib.util; spec = importlib.util.spec_from_file_location("rs", ${JSON.stringify(SCRIPT)}); rs = importlib.util.module_from_spec(spec); spec.loader.exec_module(rs); print(rs.read_signer(${JSON.stringify(join(ROOT, 'packaging', 'release-signer.npub'))}))`;
    expect(execFileSync('python3', ['-I', '-B', '-c', code], { encoding: 'utf8' }).trim()).toBe(decode(pinned[0]! as `npub1${string}`).data);
  });

  it('accepts a release signed by the pinned key, and makes the manifest sha256sum reads', () => {
    const r = release();
    const out = r.check();
    expect(out.stdout).toContain('signed by the pinned key');
    expect(out.status).toBe(0);
    const manifest = readFileSync(join(r.assets, MANIFEST), 'utf8');
    expect(manifest.split('\n').filter(Boolean).map((l) => l.split('  ')[1])).toEqual([`trikey-alpha-${TAG}.apk`, 'trikey-guardian-compose.yml']);
    expect(execFileSync('sha256sum', ['-c', MANIFEST], { cwd: r.assets, encoding: 'utf8' })).toContain('OK');
  });

  it('refuses another key, a changed, added or missing file, and a manifest edited to match', () => {
    const other = release({ signer: generateSecretKey() });
    expect(other.check()).toMatchObject({ status: 1, stdout: expect.stringContaining('not by the pinned key') });

    const changed = release();
    writeFileSync(join(changed.assets, 'trikey-guardian-compose.yml'), 'services: {evil: {}}\n');
    expect(changed.check()).toMatchObject({ status: 1, stdout: expect.stringContaining('does not list exactly') });

    const added = release();
    writeFileSync(join(added.assets, 'evil.apk'), 'x');
    expect(added.check()).toMatchObject({ status: 1, stdout: expect.stringContaining('does not list exactly') });

    const removed = release();
    execFileSync('rm', [join(removed.assets, `trikey-alpha-${TAG}.apk`)]);
    expect(removed.check()).toMatchObject({ status: 1, stdout: expect.stringContaining('does not list exactly') });

    // The file changed and the manifest rewritten to match: the event's x tag no longer names the manifest.
    const rewritten = release();
    writeFileSync(join(rewritten.assets, 'trikey-guardian-compose.yml'), 'services: {evil: {}}\n');
    py('manifest', '--tag', TAG, '--dir', rewritten.assets);
    expect(rewritten.check()).toMatchObject({ status: 1, stdout: expect.stringContaining('tags are not') });
  });

  it("refuses one release's signature on another, and events that are not exactly the expected one", () => {
    const r = release();
    const other = 'v0.1.100-alpha';
    copyFileSync(join(r.assets, MANIFEST), join(r.assets, `trikey-${other}-SHA256SUMS`));
    copyFileSync(join(r.assets, EVENT), join(r.assets, `trikey-${other}-SHA256SUMS.event.json`));
    // (Both releases' files now sit together, so the manifests also no longer list exactly the other files.)
    expect(r.check(other)).toMatchObject({ status: 1, stdout: expect.stringContaining('["version", "v0.1.100-alpha"]') });

    const cases: Record<string, [(tpl: Record<string, unknown>) => void, string]> = {
      'another kind': [(t) => (t['kind'] = 1), 'kind 1, not 1420'],
      'another content': [(t) => (t['content'] = 'gm'), 'content is not'],
      'an extra tag': [(t) => (t['tags'] = [...(t['tags'] as string[][]), ['client', 'x']]), 'tags are not'],
      'a time before signed releases': [(t) => (t['created_at'] = 1_700_000_000), 'not a plausible time'],
      'a time two days ahead': [(t) => (t['created_at'] = Math.floor(Date.now() / 1000) + 2 * 86400), 'not a plausible time'],
    };
    for (const [what, [edit, message]] of Object.entries(cases)) {
      expect(release({ edit }).check(), what).toMatchObject({ status: 1, stdout: expect.stringContaining(message) });
    }
  });

  it('refuses a broken signature, a forged id and an extra field', () => {
    const edit = (r: { assets: string }, f: (e: Record<string, unknown>) => void) => {
      const path = join(r.assets, EVENT);
      const e = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
      f(e);
      writeFileSync(path, JSON.stringify(e));
    };
    const sig = release();
    edit(sig, (e) => (e['sig'] = `${String(e['sig']).slice(0, -2)}${String(e['sig']).endsWith('00') ? '11' : '00'}`));
    expect(sig.check()).toMatchObject({ status: 1, stdout: expect.stringContaining('the signature does not verify') });
    const id = release();
    edit(id, (e) => (e['id'] = '0'.repeat(64)));
    expect(id.check()).toMatchObject({ status: 1, stdout: expect.stringContaining("id is not the hash") });
    const extra = release();
    edit(extra, (e) => (e['note'] = 'hi'));
    expect(extra.check()).toMatchObject({ status: 1, stdout: expect.stringContaining('exactly the fields') });
  });

  it('says how to sign an unsigned release', () => {
    const dir = mkdtempSync(join(tmpdir(), 'trikey-unsigned-'));
    writeFileSync(join(dir, `trikey-alpha-${TAG}.apk`), 'apk\n');
    expect(py('check', '--tag', TAG, '--dir', dir)).toMatchObject({ status: 1, stdout: expect.stringContaining(`node tools/release/sign-release.mjs ${TAG}`) });
  });
});

describe('tools/release/sign-release.mjs', () => {
  const tool = join(ROOT, 'tools', 'release', 'sign-release.mjs');
  const run = (args: string[], env: Record<string, string> = {}) =>
    spawnSync('node', [tool, ...args], { encoding: 'utf8', env: { PATH: process.env['PATH'] ?? '', ...env }, input: '' });

  it('refuses an nsec or a hex secret key, wherever it is given, without echoing it', () => {
    // Not a key: anything that starts like one is refused before it is parsed.
    const nsec = `nsec1${'q'.repeat(58)}`;
    for (const [args, env] of [
      [[TAG, nsec], {}],
      [[nsec], {}],
      [[TAG, 'a'.repeat(64)], {}],
      [[TAG], { TRIKEY_BUNKER: nsec }],
    ] as const) {
      const r = run([...args], env);
      expect(r.status, JSON.stringify(args)).toBe(2);
      expect(r.stderr).toContain('never takes an nsec');
      expect(r.stdout + r.stderr).not.toContain(nsec);
    }
  });

  it('asks the signer only for the pinned key, and checks and uploads only what passes the release check', () => {
    const src = readFileSync(tool, 'utf8');
    // The key the signer must have is the pinned one, read from packaging/release-signer.npub.
    expect(src).toContain("join(root, 'packaging', 'release-signer.npub')");
    expect(src).toMatch(/if \(pk !== pinned\) fail\(/);
    // The upload comes after the same check publish-release.yml runs, and never replaces files (no --clobber).
    const check = src.indexOf("['-I', SCRIPT, 'check'");
    const upload = src.indexOf("['release', 'upload'");
    expect(check).toBeGreaterThan(-1);
    expect(upload).toBeGreaterThan(check);
    expect(src).not.toContain('--clobber');
    // Only a draft is signed.
    expect(src).toMatch(/if \(!release\.isDraft\) fail\(/);
  });
});
