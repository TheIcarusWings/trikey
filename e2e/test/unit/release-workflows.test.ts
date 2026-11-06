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
