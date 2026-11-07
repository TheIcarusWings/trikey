/**
 * The release supply chain in .github/workflows, checked for what must not drift:
 *
 * - only release tags (v*) get release credentials: the one job that may push the guardian image, the jobs that get
 *   the Android release key or the Umbrel store token, all run only on a v* tag ref and declare the `release`
 *   environment (docs/android-signing.md, "The `release` environment"); runs on a branch go through jobs that are
 *   passed no secrets and have no write access to packages;
 * - what is published downstream of the image is the digest docker.yml pushed, not the tag resolved again;
 * - the release job checks every APK's certificate against packaging/android/release-cert.sha256 before uploading;
 * - every action is pinned to a full commit SHA.
 */
import { readdirSync, readFileSync } from 'node:fs';
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

  it('hands the pushed digest to start9.yml and umbrel-store.yml, which it calls', () => {
    for (const name of ['start9', 'umbrel-store']) {
      const job = wf.jobs[name]!;
      expect(job.uses).toBe(`./.github/workflows/${name}.yml`);
      expect(job.needs).toBe('publish');
      expect(job.with).toEqual({ 'image-digest': '${{ needs.publish.outputs.digest }}' });
      expect(job.permissions?.packages ?? 'read').toBe('read');
    }
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
    expect(job.env!['DIGEST']).toBe('${{ needs.publish.outputs.digest }}');
    const pin = job.steps!.find((s) => s.name === 'Pin the image in the compose file')!;
    expect(pin.run).toContain('pinned="${IMAGE}:${VERSION}@${DIGEST}"');
    expect(pin.run).toContain('grep -Fxq "    image: ${pinned}"');
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
  it('dispatches docker.yml, reproducible.yml and android-apk.yml (docker.yml calls the packaging workflows)', () => {
    const script = workflow('release.yml').jobs['release']!.steps!.map((s) => s.run ?? '').join('\n');
    expect(script).toContain('for wf in docker.yml reproducible.yml android-apk.yml; do');
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
    const upload = steps.findIndex((s) => s.uses?.startsWith('softprops/action-gh-release@'));
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
          expect(job.if, where).toMatch(/github\.ref_type == 'tag' && startsWith\(github\.ref_name, 'v'\)|needs\.publish\.outputs\.digest/);
        } else {
          expect(job.environment, where).toBe('release');
        }
      }
    }
  });
});
