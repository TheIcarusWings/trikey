/**
 * The release supply chain in .github/workflows, checked for what must not drift:
 *
 * - only release tags (v*) get release credentials: the one job that may push the guardian image, the jobs that get
 *   the Android release key or the Umbrel store token, all run only on a v* tag ref and declare the `release`
 *   environment (docs/android-signing.md, "The `release` environment"); runs on a branch go through jobs that are
 *   passed no secrets and have no write access to packages;
 * - what is published downstream of the image is the digest docker.yml pushed, not the tag resolved again;
 * - the release job checks every APK's certificate against packaging/android/release-cert.sha256 before uploading;
 * - one image tag per release, no moving tag, and GHCR_PUSH_TOKEN preferred (with a warning without it);
 * - release files go to a draft, and only publish-release.yml publishes it, after checking every file
 *   (packaging/check-release-assets.sh, run here against stand-in files);
 * - every action is pinned to a full commit SHA.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { E2E_DIR } from '../../src/compose.js';

const ROOT = join(E2E_DIR, '..');
const WORKFLOWS = join(ROOT, '.github', 'workflows');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

interface Step {
  name?: string;
  uses?: string;
  run?: string;
  if?: string;
  env?: Record<string, string>;
  with?: Record<string, unknown>;
}
interface Job {
  if?: string;
  needs?: string | string[];
  environment?: string | { name: string };
  permissions?: Record<string, string>;
  uses?: string;
  with?: Record<string, unknown>;
  secrets?: Record<string, string> | 'inherit';
  outputs?: Record<string, string>;
  env?: Record<string, string>;
  steps?: Step[];
}
interface Workflow {
  on: Record<string, unknown>;
  permissions?: Record<string, string>;
  env?: Record<string, string>;
  jobs: Record<string, Job>;
}
const workflow = (name: string) => parse(read(`.github/workflows/${name}`)) as Workflow;

const RELEASE_TAG = "github.ref_type == 'tag' && startsWith(github.ref_name, 'v')";
const NOT_RELEASE_TAG = "${{ !(github.ref_type == 'tag' && startsWith(github.ref_name, 'v')) }}";

/** Every `secrets.X` a job reads, other than GITHUB_TOKEN. */
function secretsRead(job: Job): string[] {
  const text = JSON.stringify(job);
  return [...new Set([...text.matchAll(/secrets\.([A-Z0-9_]+)/g)].map((m) => m[1]!))].filter((s) => s !== 'GITHUB_TOKEN').sort();
}

describe('docker.yml', () => {
  const wf = workflow('docker.yml');

  it('gives packages: write to one job, which runs only on release tags in the release environment', () => {
    const writers = Object.entries(wf.jobs).filter(([, j]) => j.permissions?.packages === 'write');
    expect(writers.map(([n]) => n)).toEqual(['publish']);
    const publish = wf.jobs['publish']!;
    expect(publish.if).toBe(RELEASE_TAG);
    expect(publish.environment).toBe('release');
    expect(wf.permissions).toEqual({ contents: 'read' });
  });

  it('builds without pushing on everything else', () => {
    const build = wf.jobs['build']!;
    expect(build.if).toBe(NOT_RELEASE_TAG);
    expect(build.permissions).toEqual({ contents: 'read' });
    const step = build.steps!.find((s) => s.uses?.startsWith('docker/build-push-action@'))!;
    expect(String(step.with!['outputs'])).toContain('push=false');
    expect(JSON.stringify(build)).not.toMatch(/login-action/);
  });

  it('hands the pushed digest, once reproduced, to start9.yml and umbrel-store.yml, which it calls', () => {
    for (const name of ['start9', 'umbrel-store']) {
      const job = wf.jobs[name]!;
      expect(job.uses).toBe(`./.github/workflows/${name}.yml`);
      expect(job.needs).toBe('verified');
      expect(job.if).toBe("needs.verified.outputs.digest != ''");
      expect(job.with).toEqual({ 'image-digest': '${{ needs.verified.outputs.digest }}' });
      expect(job.permissions?.packages ?? 'read').toBe('read');
    }
  });

  it('lets nothing ship the pushed image unless two clean builds of the tag give the same digest', () => {
    const repro = wf.jobs['reproducible']!;
    expect(repro.if).toBe(RELEASE_TAG);
    expect(repro.uses).toBe('./.github/workflows/reproducible.yml');
    expect(repro.needs).toBeUndefined(); // beside publish, not after it
    const verified = wf.jobs['verified']!;
    expect(verified.needs).toEqual(['publish', 'reproducible']);
    const step = verified.steps!.find((s) => s.name === 'The pushed image is the reproduced one')!;
    expect(step.env).toEqual({ PUSHED: '${{ needs.publish.outputs.digest }}', REBUILT: '${{ needs.reproducible.outputs.index-digest }}' });
    expect(step.run).toMatch(/if \[ "\$\{PUSHED\}" != "\$\{REBUILT\}" \]; then[\s\S]*?exit 1/);
    expect(step.run!.indexOf('exit 1\n          fi')).toBeLessThan(step.run!.indexOf('echo "digest=${PUSHED}"'));
    expect(verified.outputs).toEqual({ digest: '${{ steps.compare.outputs.digest }}' });
    // Every job that ships the image takes the digest from `verified`, never from `publish` directly.
    for (const name of ['compose-files', 'start9', 'umbrel-store']) {
      expect(JSON.stringify(wf.jobs[name]), name).not.toContain('needs.publish.outputs.digest');
      expect(JSON.stringify(wf.jobs[name]), name).toContain('needs.verified.outputs.digest');
    }
    // publish-release.yml's digest artifact comes from `verified` too.
    expect(JSON.stringify(verified.steps)).toContain('"name":"guardian-image-digest"');
    expect(JSON.stringify(wf.jobs['publish']!.steps)).not.toContain('guardian-image-digest');
    // reproducible.yml hands back the index digest its two builds agree on, and runs on tags only when called.
    const r = workflow('reproducible.yml');
    expect(r.on).not.toHaveProperty('push');
    expect(r.on['workflow_call']).toEqual({
      outputs: { 'index-digest': expect.objectContaining({ value: '${{ jobs.build-twice.outputs.index-digest }}' }) },
    });
    expect(r.jobs['build-twice']!.outputs).toEqual({ 'index-digest': '${{ steps.compare.outputs.index }}' });
    const compare = r.jobs['build-twice']!.steps!.find((s) => s.name === 'Compare digests')!.run!;
    expect(compare.indexOf('echo "index=${index}" >> "$GITHUB_OUTPUT"')).toBeGreaterThan(compare.indexOf('if diff -u'));
  });
});

describe('the guardian image tags', () => {
  const wf = workflow('docker.yml');
  const publish = wf.jobs['publish']!;
  const step = (name: string) => publish.steps!.find((s) => s.name === name)!;

  it('pushes the version tag only: no latest, <major>.<minor>, sha-... or any other moving tag', () => {
    const build = publish.steps!.find((s) => s.uses?.startsWith('docker/build-push-action@'))!;
    expect(build.with!['tags']).toBe('${{ env.IMAGE }}:${{ steps.params.outputs.version }}');
    expect(String(build.with!['outputs'])).toContain('push=true');
    const code = read('.github/workflows/docker.yml')
      .split('\n')
      .filter((l) => !/^\s*#/.test(l))
      .join('\n');
    expect(code).not.toMatch(/metadata-action|\{\{major\}\}|type=sha|:latest\b|type=raw/);
    // The version is the tag's, and a release version.
    expect(step('Build parameters').run).toContain('version="${GITHUB_REF_NAME#v}"');
    expect(step('Build parameters').run).toContain('^[0-9]+\\.[0-9]+\\.[0-9]+(-alpha)?$');
  });

  it('pushes with GHCR_PUSH_TOKEN when set, else with GITHUB_TOKEN and a warning that says how to close it', () => {
    const login = publish.steps!.find((s) => s.uses?.startsWith('docker/login-action@'))!;
    expect(login.with!['password']).toBe('${{ secrets.GHCR_PUSH_TOKEN || secrets.GITHUB_TOKEN }}');
    const which = step('Which token pushes');
    expect(which.env!['HAS_PUSH_TOKEN']).toBe("${{ secrets.GHCR_PUSH_TOKEN != '' }}");
    expect(which.run).toMatch(/::warning title=Image pushed with GITHUB_TOKEN::.*docs\/android-signing\.md/);
    // A warning, not a failure: releases keep working until the owner has set the token up.
    expect(which.run).not.toMatch(/exit 1/);
    expect(publish.steps!.indexOf(which)).toBeLessThan(publish.steps!.indexOf(login));
    // The owner's steps are written down where the warning points.
    const doc = read('docs/android-signing.md').replace(/\s+/g, ' ');
    for (const words of ['GHCR_PUSH_TOKEN', 'write:packages', 'Manage Actions access', 'Inherit access from source repository', '**Read**'])
      expect(doc).toContain(words);
  });

  it('fails a re-release that would change the digest of a version already on GHCR', () => {
    expect(step('Is this version on GHCR already?').run).toContain('docker buildx imagetools inspect "${IMAGE}:${VERSION}"');
    const digest = step('Digest');
    expect(digest.env!['PREVIOUS']).toBe('${{ steps.previous.outputs.digest }}');
    expect(digest.run).toMatch(/\[ "\$\{PREVIOUS\}" != "\$\{DIGEST\}" \][\s\S]*exit 1/);
  });

  it("pins the pushed digest in the release's compose file", () => {
    const job = wf.jobs['compose-files']!;
    expect(job.env!['DIGEST']).toBe('${{ needs.verified.outputs.digest }}');
    const pin = job.steps!.find((s) => s.name === 'Pin the image in the compose file')!;
    expect(pin.run).toContain('pinned="${IMAGE}:${VERSION}@${DIGEST}"');
    expect(pin.run).toContain('grep -Fxq "    image: ${pinned}"');
  });

  it("makes the release's compose file from the repository's, as the step really runs (0.1.22's release stopped here)", () => {
    const job = wf.jobs['compose-files']!;
    const pin = job.steps!.find((s) => s.name === 'Pin the image in the compose file')!;
    const temp = mkdtempSync(join(tmpdir(), 'trikey-pin-'));
    const digest = `sha256:${'ab'.repeat(32)}`;
    const version = (JSON.parse(read('package.json')) as { version: string }).version + '-alpha';
    execFileSync('bash', ['-c', pin.run!], {
      cwd: ROOT,
      env: { PATH: process.env['PATH'], RUNNER_TEMP: temp, IMAGE: wf.env!['IMAGE'], VERSION: version, DIGEST: digest, TAG: `v${version}` },
      stdio: 'pipe',
    });
    const out = readFileSync(join(temp, 'assets', 'trikey-guardian-compose.yml'), 'utf8');
    expect(out).toContain(`    image: ghcr.io/theicaruswings/trikey-guardian:${version}@${digest}\n`);
    // No setting may still take the override; comments may name it.
    expect(out.split('\n').filter((l) => !/^\s*#/.test(l) && l.includes('TRIKEY_IMAGE'))).toEqual([]);
    expect(readdirSync(join(temp, 'assets')).sort()).toEqual(['trikey-guardian-compose.sha256', 'trikey-guardian-compose.yml', 'trikey-guardian.env.example']);
  });

  it('says in the repository compose file and its README that it follows a tag, and points to the release copy', () => {
    expect(read('packaging/compose/docker-compose.yml')).toMatch(/follows the version\s+# TAG/);
    expect(read('packaging/compose/README.md')).toContain('**follows a tag**');
  });

  it('packs into the Start9 package only the image pulled by the pushed digest, and checks it again after the pack', () => {
    const steps = workflow('start9.yml').jobs['build']!.steps!;
    const image = steps.find((s) => s.name === 'Guardian image')!;
    expect(image.run).toContain("docker image inspect \"${tag}\" --format '{{json .RepoDigests}}'");
    expect(image.run).toContain('refusing to pack it');
    const pack = steps.findIndex((s) => s.name === 'Build the .s9pk');
    const after = steps.findIndex((s) => s.name === 'The packed image is the pushed digest');
    expect(after).toBe(pack + 1);
    expect(steps[after]!.if).toBe("github.ref_type == 'tag'");
    expect(steps[after]!.env!['ID']).toBe('${{ steps.image.outputs.id }}');
  });
});

describe('release.yml', () => {
  const script = workflow('release.yml').jobs['release']!.steps!.map((s) => s.run ?? '').join('\n');

  it('dispatches the builds, then publish-release.yml last (docker.yml calls the packaging workflows)', () => {
    // reproducible.yml is called by docker.yml, which gates on it; dispatching it too would build it a third time.
    expect(script).toContain('for wf in docker.yml android-apk.yml publish-release.yml; do');
  });

  it('creates the tag, then the release as a draft on it, never a published one', () => {
    const createTag = script.indexOf('gh api "repos/${GITHUB_REPOSITORY}/git/refs" -f ref="refs/tags/${TAG}" -f sha="${GITHUB_SHA}"');
    const createDraft = script.indexOf('gh release create "${TAG}" --draft --prerelease --verify-tag');
    expect(createTag).toBeGreaterThan(-1);
    expect(createDraft).toBeGreaterThan(createTag);
    for (const m of script.matchAll(/gh release create [^\n]*/g)) expect(m[0]).toContain('--draft');
  });
});

/** Every line of every workflow that could publish a release or create one published. */
function publishingLines(): string[] {
  return readdirSync(WORKFLOWS)
    .filter((f) => f.endsWith('.yml'))
    .flatMap((f) =>
      read(`.github/workflows/${f}`)
        .split('\n')
        .filter((l) => !/^\s*#/.test(l))
        .filter((l) => /draft=false|--draft=false|draft: false|action-gh-release|gh release create(?![^\n]*--draft)/.test(l))
        .map((l) => `${f}: ${l.trim()}`)
    );
}

describe('release files: attached to a draft, published only after the checks', () => {
  const pub = workflow('publish-release.yml');

  it('lets only publish-release.yml publish a release', () => {
    expect(publishingLines()).toEqual([
      'publish-release.yml: gh api -X PATCH "repos/${GITHUB_REPOSITORY}/releases/${ID}" -F draft=false -F prerelease=true > "${RUNNER_TEMP}/published.json"',
    ]);
  });

  it('attaches the APKs and the compose files only to a draft, never replacing a published release\'s files', () => {
    const jobs = [
      ['android-apk.yml', workflow('android-apk.yml').jobs['release']!],
      ['docker.yml', workflow('docker.yml').jobs['compose-files']!],
    ] as const;
    for (const [name, job] of jobs) {
      const attach = job.steps!.find((s) => s.name === 'Attach to the draft release')!;
      expect(attach, name).toBeDefined();
      const run = attach.run!;
      const isDraft = run.indexOf('--json isDraft --jq .isDraft');
      const refuse = run.indexOf('if [ "${draft}" != "true" ]; then');
      const upload = run.indexOf('gh release upload');
      expect(isDraft, name).toBeGreaterThan(-1);
      expect(refuse, name).toBeGreaterThan(isDraft);
      expect(upload, name).toBeGreaterThan(refuse);
      // The refusal ends the step before the upload.
      expect(run.slice(refuse, upload), name).toMatch(/exit 0\n\s*fi/);
    }
  });

  it('waits for the Docker and Android builds of the tag, which must succeed', () => {
    const wait = pub.jobs['wait']!;
    expect(wait.if).toBe(RELEASE_TAG);
    expect(wait.permissions).toEqual({ actions: 'read', contents: 'read' });
    const run = wait.steps![0]!.run!;
    expect(run).toContain('for wf in docker.yml android-apk.yml; do');
    expect(run).toContain('--branch "${TAG}"');
    expect(run).toMatch(/if \[ "\$\{conclusion\}" != success \]; then[\s\S]*?exit 1/);
  });

  it('publishes in the release environment, after checking every file, and compares the files after', () => {
    const job = pub.jobs['publish']!;
    expect(job.if).toBe(RELEASE_TAG);
    expect(job.needs).toBe('wait');
    expect(job.environment).toBe('release');
    expect(job.permissions).toEqual({ contents: 'write', actions: 'read' });
    const names = job.steps!.map((s) => s.name ?? s.uses ?? '');
    const check = names.indexOf('Check every file');
    const publish = names.indexOf('Publish');
    expect(check).toBeGreaterThan(-1);
    expect(publish).toBeGreaterThan(check);
    const checkRun = job.steps![check]!.run!;
    expect(checkRun).toContain('bash packaging/check-release-assets.sh');
    expect(checkRun).toContain('the tag was changed');
    const publishRun = job.steps![publish]!.run!;
    expect(publishRun.indexOf('The draft\'s files changed during the check')).toBeLessThan(publishRun.indexOf('draft=false'));
    expect(publishRun).toContain('Files changed while publishing');
    expect(publishRun).toContain('Release is not immutable');
    // The digest to expect comes from docker.yml's publish job, not from the release's own compose file.
    const download = job.steps!.find((s) => s.uses?.startsWith('actions/download-artifact@'))!;
    expect(download.with).toMatchObject({ name: 'guardian-image-digest', 'run-id': '${{ needs.wait.outputs.docker-run }}' });
    expect(JSON.stringify(workflow('docker.yml').jobs['verified']!.steps)).toContain('"name":"guardian-image-digest"');
  });

  it('documents the draft, the checks and the owner\'s switch for immutable releases', () => {
    const doc = read('docs/android-signing.md').replace(/\s+/g, ' ');
    expect(doc).toContain('**Settings → General**, scroll to **Releases**, tick **Enable release immutability**');
    expect(doc).toContain('Do not publish a draft by hand');
    // The fingerprint the docs print is the pinned one.
    const pinned = read('packaging/android/release-cert.sha256').split('\n').filter((l) => !l.startsWith('#')).join('').trim();
    expect(doc).toContain(pinned.toUpperCase().match(/../g)!.join(':'));
  });
});

describe('packaging/check-release-assets.sh', () => {
  const TAG = 'v0.1.22-alpha';
  const IMAGE = 'ghcr.io/theicaruswings/trikey-guardian';
  const DIGEST = `sha256:${'d'.repeat(64)}`;
  const CERT = read('packaging/android/release-cert.sha256').split('\n').filter((l) => !l.startsWith('#')).join('').trim();
  const sha = (b: string | Buffer) => createHash('sha256').update(b).digest('hex');

  /** A draft's files as the builds make them, with stand-ins for apksigner and aapt2 that read a marker in the APK. */
  function draft(change: (dir: string, assets: { name: string; digest: string | null }[]) => void = () => {}) {
    const dir = mkdtempSync(join(tmpdir(), 'release-check-'));
    const assets = join(dir, 'assets');
    const tools = join(dir, 'tools');
    mkdirSync(assets);
    mkdirSync(tools);
    writeFileSync(join(tools, 'apksigner'), '#!/usr/bin/env bash\necho "Signer #1 certificate SHA-256 digest: $(sed -n 2p "${@: -1}")"\n', { mode: 0o755 });
    writeFileSync(join(tools, 'aapt2'), '#!/usr/bin/env bash\necho "package: name=\'$(sed -n 1p "${@: -1}")\' versionCode=\'122\'"\n', { mode: 0o755 });
    const files: Record<string, string> = {
      [`trikey-alpha-${TAG}.apk`]: `app.trikey.wallet\n${CERT}\n`,
      [`trikey-alpha-foss-${TAG}.apk`]: `app.trikey.wallet.foss\n${CERT}\n`,
      'trikey-guardian-compose.yml': `services:\n  guardian:\n    image: ${IMAGE}:0.1.22-alpha@${DIGEST}\n  bitcoind:\n    image: bitcoin/bitcoin:32.1@sha256:${'b'.repeat(64)}\n`,
      'trikey-guardian.env.example': 'BITCOIN_NETWORK=signet\n',
    };
    for (const [name, body] of Object.entries(files)) writeFileSync(join(assets, name), body);
    for (const apk of Object.keys(files).filter((n) => n.endsWith('.apk'))) writeFileSync(join(assets, `${apk}.sha256`), `${sha(files[apk]!)}  ${apk}\n`);
    writeFileSync(
      join(assets, 'trikey-guardian-compose.sha256'),
      ['trikey-guardian-compose.yml', 'trikey-guardian.env.example'].map((n) => `${sha(files[n]!)}  ${n}\n`).join('')
    );
    const listed = () => readdirSync(assets).map((name) => ({ name, digest: `sha256:${sha(readFileSync(join(assets, name)))}` }));
    const list = listed();
    change(assets, list);
    writeFileSync(join(dir, 'assets.json'), JSON.stringify(list));
    return { dir, listed };
  }

  function check(dir: string, env: Record<string, string> = {}) {
    try {
      const out = execFileSync('bash', [join(ROOT, 'packaging/check-release-assets.sh')], {
        cwd: ROOT,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          PATH: process.env['PATH'] ?? '',
          TAG,
          ASSETS_DIR: join(dir, 'assets'),
          ASSETS_JSON: join(dir, 'assets.json'),
          IMAGE,
          DIGEST,
          STANDARD_PACKAGE: 'app.trikey.wallet',
          BUILD_TOOLS: join(dir, 'tools'),
          ...env,
        },
      });
      return { ok: true, out };
    } catch (e) {
      return { ok: false, out: String((e as { stdout?: string }).stdout ?? '') };
    }
  }

  it('passes the files the builds make', () => {
    const { dir } = draft();
    const r = check(dir);
    expect(r.out).toContain(`All 7 files of ${TAG} checked.`);
    expect(r.ok).toBe(true);
  });

  it('refuses an APK signed by another key, even with a matching checksum file', () => {
    const { dir } = draft((assets, list) => {
      const apk = `trikey-alpha-foss-${TAG}.apk`;
      const body = `app.trikey.wallet.foss\n${'e'.repeat(64)}\n`;
      writeFileSync(join(assets, apk), body);
      writeFileSync(join(assets, `${apk}.sha256`), `${sha(body)}  ${apk}\n`);
      for (const a of list) a.digest = `sha256:${sha(readFileSync(join(assets, a.name)))}`;
    });
    const r = check(dir);
    expect(r.ok).toBe(false);
    expect(r.out).toContain('not by the release key');
  });

  it('refuses the wrong app (the no-Google APK with the standard id, as up to 0.1.21)', () => {
    const { dir } = draft((assets, list) => {
      const apk = `trikey-alpha-foss-${TAG}.apk`;
      const body = `app.trikey.wallet\n${CERT}\n`;
      writeFileSync(join(assets, apk), body);
      writeFileSync(join(assets, `${apk}.sha256`), `${sha(body)}  ${apk}\n`);
      for (const a of list) a.digest = `sha256:${sha(readFileSync(join(assets, a.name)))}`;
    });
    expect(check(dir)).toMatchObject({ ok: false, out: expect.stringContaining('is not app.trikey.wallet.foss') });
  });

  it('refuses a compose file that does not pin the pushed digest', () => {
    const { dir } = draft();
    expect(check(dir, { DIGEST: `sha256:${'0'.repeat(64)}` })).toMatchObject({ ok: false, out: expect.stringContaining('does not run') });
  });

  it('refuses a missing or an extra file, a file GitHub lists with another digest, and a stale checksum file', () => {
    const missing = draft((_assets, list) => list.splice(0, 1)).dir;
    expect(check(missing)).toMatchObject({ ok: false, out: expect.stringContaining('not the expected ones') });
    const extra = draft((assets, list) => {
      writeFileSync(join(assets, 'evil.apk'), 'x');
      list.push({ name: 'evil.apk', digest: null });
    }).dir;
    expect(check(extra)).toMatchObject({ ok: false, out: expect.stringContaining('not the expected ones') });
    const relisted = draft((_assets, list) => (list[0]!.digest = `sha256:${'1'.repeat(64)}`)).dir;
    expect(check(relisted)).toMatchObject({ ok: false, out: expect.stringContaining('GitHub lists') });
    const stale = draft((assets, list) => {
      writeFileSync(join(assets, 'trikey-guardian.env.example'), 'BITCOIN_NETWORK=mainnet\n');
      for (const a of list) a.digest = `sha256:${sha(readFileSync(join(assets, a.name)))}`;
    }).dir;
    expect(check(stale)).toMatchObject({ ok: false, out: expect.stringContaining('does not match trikey-guardian-compose.sha256') });
  });
});

describe('start9.yml and umbrel-store.yml', () => {
  it('run on a release tag only when called (or dispatched) with the digest, not on a tag push', () => {
    for (const name of ['start9.yml', 'umbrel-store.yml']) {
      const wf = workflow(name);
      expect(wf.on, name).not.toHaveProperty('push');
      expect(wf.on, name).toHaveProperty('workflow_call');
      expect((wf.on['workflow_call'] as { inputs: Record<string, { required: boolean }> }).inputs['image-digest']!.required).toBe(true);
    }
  });

  it('pack and pin the given digest, and fail if the tag moved', () => {
    const start9 = workflow('start9.yml').jobs['build']!.steps!.find((s) => s.name === 'Guardian image')!;
    expect(start9.env!['DIGEST']).toBe('${{ inputs.image-digest }}');
    expect(start9.run).toContain('docker pull --platform "${platform}" "${IMAGE}@${DIGEST}"');
    expect(start9.run).toContain('the tag was changed');
    const umbrel = workflow('umbrel-store.yml').jobs['publish']!;
    expect(umbrel.if).toBe(RELEASE_TAG);
    expect(umbrel.environment).toBe('release');
    const check = umbrel.steps!.find((s) => s.name === 'Check the image digest')!;
    expect(check.env!['DIGEST']).toBe('${{ inputs.image-digest }}');
    expect(check.run).toContain('the tag was changed');
    expect(JSON.stringify(umbrel.steps)).not.toMatch(/seq 1 60/);
  });
});

describe('android-apk.yml and android-build.yml', () => {
  const apk = workflow('android-apk.yml');
  const build = workflow('android-build.yml');

  it('passes the release key only from the release-tag job', () => {
    const withSecrets = Object.entries(apk.jobs).filter(([, j]) => j.secrets !== undefined || secretsRead(j).length > 0);
    expect(withSecrets.map(([n]) => n)).toEqual(['apk-release']);
    expect(apk.jobs['apk-release']!.if).toBe(RELEASE_TAG);
    expect(apk.jobs['apk-release']!.with!['signing']).toBe('release');
    expect(apk.jobs['apk']!.if).toBe(NOT_RELEASE_TAG);
    expect(apk.jobs['apk']!.with!['signing']).toBe('one-off');
    expect(apk.jobs['apk']!.secrets).toBeUndefined();
  });

  it('reads the key only in the sign job, in the release environment, which runs no build code', () => {
    const readers = Object.entries(build.jobs).filter(([, j]) => secretsRead(j).length > 0);
    expect(readers.map(([n]) => n)).toEqual(['sign']);
    const sign = build.jobs['sign']!;
    expect(sign.environment).toBe('release');
    expect(sign.if).toBe("inputs.signing == 'release'");
    const text = JSON.stringify(sign.steps);
    for (const buildCode of ['npm ', 'npx ', 'gradlew', 'setup-node', 'setup-gradle']) expect(text).not.toContain(buildCode);
    expect(secretsRead(build.jobs['apk']!)).toEqual([]);
  });

  it('refuses release signing anywhere but on a v* tag', () => {
    expect(read('packaging/android/sign-apk.sh')).toContain('[ "${GITHUB_REF_TYPE}" = tag ] && [[ "${GITHUB_REF_NAME}" == v* ]]');
  });

  it("checks every APK's certificate against the pinned one before the upload", () => {
    const steps = apk.jobs['release']!.steps!;
    const check = steps.findIndex((s) => /release-cert\.sha256/.test(s.run ?? '') && /apksigner" verify/.test(s.run ?? ''));
    const upload = steps.findIndex((s) => /gh release upload/.test(s.run ?? ''));
    expect(check).toBeGreaterThan(-1);
    expect(upload).toBeGreaterThan(check);
    expect(apk.jobs['release']!.needs).toBe('apk-release');
  });
});

describe('the release job of android-apk.yml', () => {
  it('downloads exactly the two signed APK artifacts, never the -unsigned ones the build jobs also upload', () => {
    const apk = workflow('android-apk.yml');
    const build = read('.github/workflows/android-build.yml');
    // The build jobs upload `<artifact-name>-unsigned` too (the APK the sign job signs).
    expect(build).toMatch(/inputs\.artifact-name \|\| 'trikey-android-apk' \}\}-unsigned/);
    const downloads = Object.values(apk.jobs).flatMap((j) => (j.steps ?? []).filter((s) => s.uses?.startsWith('actions/download-artifact@')));
    expect(downloads.length).toBeGreaterThan(0);
    for (const d of downloads) {
      // A pattern such as trikey-android-apk-* would also match trikey-android-apk-standard-unsigned.
      expect(d.with?.['pattern'], JSON.stringify(d.with)).toBeUndefined();
      expect(String(d.with?.['name'])).not.toMatch(/unsigned/);
    }
    expect(downloads.map((d) => d.with?.['name']).sort()).toEqual(['trikey-android-apk-foss', 'trikey-android-apk-standard']);
  });
});

describe('every workflow', () => {
  const files = readdirSync(WORKFLOWS).filter((f) => f.endsWith('.yml'));

  it('runs QEMU only from the binfmt image pinned by digest, never cached, and VERIFY.md tells users the same one', () => {
    const PINNED = /^tonistiigi\/binfmt:qemu-v[\d.]+(-\d+)?@sha256:[0-9a-f]{64}$/;
    const pins = new Set<string>();
    let uses = 0;
    for (const f of files) {
      const wf = workflow(f);
      for (const [name, job] of Object.entries(wf.jobs)) {
        for (const step of job.steps ?? []) {
          if (!step.uses?.startsWith('docker/setup-qemu-action@')) continue;
          uses++;
          const where = `${f}#${name}`;
          expect(step.with?.['image'], where).toBe('${{ env.BINFMT_IMAGE }}');
          expect(step.with?.['cache-image'], where).toBe(false);
          expect(step.with?.['platforms'], where).toBe('arm64');
          const env = (wf as unknown as { env?: Record<string, string> }).env?.['BINFMT_IMAGE'];
          expect(env, where).toMatch(PINNED);
          pins.add(env!);
        }
      }
      // No other way of starting binfmt, unpinned.
      expect(read(`.github/workflows/${f}`), f).not.toMatch(/tonistiigi\/binfmt(:latest)?\s*(--install|$)/m);
    }
    expect(uses).toBe(3); // docker.yml build and publish, reproducible.yml
    expect(pins.size).toBe(1);
    const [pin] = [...pins];
    const verify = read('packaging/VERIFY.md');
    expect(verify).toContain(pin);
    expect(verify).not.toMatch(/tonistiigi\/binfmt --install/);
  });

  it('pins every action to a full commit SHA, with its version in a comment', () => {
    expect(files.length).toBeGreaterThan(10);
    for (const f of files) {
      for (const line of read(`.github/workflows/${f}`).split('\n')) {
        const m = /^\s*(?:-\s+)?uses:\s*(\S+)(.*)$/.exec(line);
        if (!m || m[1]!.startsWith('./')) continue;
        expect(m[1], `${f}: ${line.trim()}`).toMatch(/^[\w.-]+\/[\w./-]+@[0-9a-f]{40}$/);
        expect(m[2], `${f}: ${line.trim()}`).toMatch(/^ # v\d+(\.\d+)*$/);
      }
    }
  });

  it('reads the release secrets only in jobs that run on release tags in the release environment', () => {
    const release = ['ANDROID_RELEASE_KEYSTORE', 'ANDROID_RELEASE_KEYSTORE_PASSWORD', 'ANDROID_RELEASE_KEY_ALIAS', 'UMBREL_STORE_TOKEN', 'GHCR_PUSH_TOKEN'];
    for (const f of files) {
      const wf = workflow(f);
      for (const [name, job] of Object.entries(wf.jobs)) {
        if (!secretsRead(job).some((s) => release.includes(s))) continue;
        const where = `${f}#${name}`;
        if (job.uses) {
          // A caller of a reusable workflow: only on release tags.
          expect(job.if, where).toMatch(/github\.ref_type == 'tag' && startsWith\(github\.ref_name, 'v'\)|needs\.verified\.outputs\.digest/);
        } else {
          expect(job.environment, where).toBe('release');
        }
      }
    }
  });
});

describe('ios-launch.yml: `launch` is a required check on main, so it must report on every pull request', () => {
  const wf = workflow('ios-launch.yml');
  it('runs on every pull request (no path filter) and skips the Mac job without app changes', () => {
    expect(wf.on['pull_request']).toBeNull();
    expect(wf.jobs['launch']!.needs).toBe('changes');
    expect(wf.jobs['launch']!.if).toBe("needs.changes.outputs.app == 'true'");
    const run = wf.jobs['changes']!.steps![0]!.run!;
    for (const p of ['apps/mobile/*', 'packages/*', 'package-lock.json', '.github/workflows/ios-launch.yml', '.github/scripts/ios-launch*'])
      expect(run).toContain(p);
  });
});
