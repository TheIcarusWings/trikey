import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  RELEASES_API_URL,
  RELEASES_PAGE_URL,
  UpdateCheckError,
  assetNames,
  checkForUpdate,
  compareVersions,
  isReleaseDownloadUrl,
  parseAppVersion,
  parseTag,
  pickRelease,
  releaseAppId,
  type FetchLike,
} from './update-check';

const DL = 'https://github.com/TheIcarusWings/trikey/releases/download/';

/** One entry of GitHub's release list, as the API gives it (the fields the app reads). */
function release(tag: string, over: Record<string, unknown> = {}) {
  const apk = `trikey-alpha-${tag}.apk`;
  return {
    tag_name: tag,
    name: `Trikey ${tag} (alpha test build)`,
    draft: false,
    prerelease: true,
    html_url: `https://github.com/TheIcarusWings/trikey/releases/tag/${tag}`,
    assets: [
      { name: apk, browser_download_url: `${DL}${tag}/${apk}` },
      { name: `${apk}.sha256`, browser_download_url: `${DL}${tag}/${apk}.sha256` },
    ],
    ...over,
  };
}

const reply = (status: number, body: unknown) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => (typeof body === 'string' ? JSON.parse(body) : body),
  text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
});

/** A stand-in for the network: the release list at the API URL, files by URL, and a log of what was asked. */
function fakeGitHub(list: unknown, files: Record<string, string> = {}, status = 200) {
  const asked: string[] = [];
  const fetchFn: FetchLike = async (url) => {
    asked.push(url);
    if (url === RELEASES_API_URL) return reply(status, list);
    if (url in files) return reply(200, files[url]!);
    return reply(404, 'Not Found');
  };
  return { fetchFn, asked };
}

describe('release tags', () => {
  it('reads v<major>.<minor>.<patch> with or without -alpha', () => {
    expect(parseTag('v0.1.7-alpha')).toEqual({ major: 0, minor: 1, patch: 7, alpha: true });
    expect(parseTag('v1.10.0')).toEqual({ major: 1, minor: 10, patch: 0, alpha: false });
  });

  it('refuses anything else', () => {
    for (const tag of ['0.1.7', 'v0.1', 'v0.1.7-beta', 'v0.1.7-alpha.2', 'nightly', 'v01.1.7', ' v0.1.7', 'v0.1.7 ', '']) {
      expect(parseTag(tag)).toBeNull();
    }
  });

  it("reads the app's own version as app.json has it", () => {
    expect(parseAppVersion('0.1.6')).toEqual({ major: 0, minor: 1, patch: 6, alpha: false });
    expect(parseAppVersion('')).toBeNull();
    expect(parseAppVersion('dev')).toBeNull();
  });
});

describe('comparing versions', () => {
  const v = (tag: string) => parseTag(tag)!;

  it('compares the numbers, not the text', () => {
    expect(compareVersions(v('v0.1.10'), v('v0.1.9'))).toBeGreaterThan(0);
    expect(compareVersions(v('v0.2.0'), v('v0.1.99'))).toBeGreaterThan(0);
    expect(compareVersions(v('v1.0.0'), v('v0.9.9'))).toBeGreaterThan(0);
    expect(compareVersions(v('v0.1.6'), v('v0.1.6'))).toBe(0);
  });

  it('puts an alpha just below the same numbers without it', () => {
    expect(compareVersions(v('v0.1.7-alpha'), v('v0.1.7'))).toBeLessThan(0);
    expect(compareVersions(v('v0.1.7-alpha'), v('v0.1.6'))).toBeGreaterThan(0);
  });
});

describe('download URLs', () => {
  it("accepts this repository's release files", () => {
    expect(isReleaseDownloadUrl(`${DL}v0.1.7-alpha/trikey-alpha-v0.1.7-alpha.apk`)).toBe(true);
  });

  it('refuses other hosts, repositories and odd paths', () => {
    for (const url of [
      'https://example.com/trikey.apk',
      'http://github.com/TheIcarusWings/trikey/releases/download/v0.1.7-alpha/a.apk',
      'https://github.com/someone/trikey/releases/download/v0.1.7-alpha/a.apk',
      'https://github.com/TheIcarusWings/trikey-fork/releases/download/v0.1.7-alpha/a.apk',
      'https://github.com/TheIcarusWings/trikey/releases/download.evil.com/a.apk',
      `${DL}v0.1.7-alpha/../../../../evil/a.apk`,
      `${DL}../a.apk`,
      `${DL}v0.1.7-alpha/a.apk?x=1`,
      `${DL}v0.1.7-alpha/a.apk#x`,
      `${DL}v0.1.7-alpha/sub/a.apk`,
      `${DL}a.apk`,
      `${DL}v0.1.7-alpha/`,
      42,
      undefined,
    ]) {
      expect(isReleaseDownloadUrl(url)).toBe(false);
    }
  });
});

describe('picking the release', () => {
  it('takes the newest by version, whatever the order of the list', () => {
    const picked = pickRelease([release('v0.1.6-alpha'), release('v0.1.8-alpha'), release('v0.1.7-alpha')]);
    expect(picked).toMatchObject({
      tag: 'v0.1.8-alpha',
      name: 'Trikey v0.1.8-alpha (alpha test build)',
      pageUrl: 'https://github.com/TheIcarusWings/trikey/releases/tag/v0.1.8-alpha',
      apkUrl: `${DL}v0.1.8-alpha/trikey-alpha-v0.1.8-alpha.apk`,
    });
    expect(picked).not.toHaveProperty('sha256Url');
  });

  it('never offers a draft, even the newest (a release is a draft until publish-release.yml has checked it)', () => {
    expect(pickRelease([release('v0.2.0-alpha', { draft: true })])).toBeNull();
    expect(pickRelease([release('v0.2.0-alpha', { draft: true }), release('v0.1.9-alpha')])?.tag).toBe('v0.1.9-alpha');
  });

  it('skips drafts, other tags and releases without the APK', () => {
    const picked = pickRelease([
      release('v0.3.0-alpha', { draft: true }),
      release('v0.2.9-beta'),
      release('nightly'),
      release('v0.2.8-alpha', { assets: [] }),
      release('v0.2.7-alpha', { assets: [{ name: 'trikey-alpha-v0.2.7-alpha.apk.sha256', browser_download_url: `${DL}v0.2.7-alpha/trikey-alpha-v0.2.7-alpha.apk.sha256` }] }),
      release('v0.2.6-alpha', { assets: [{ name: 'trikey-alpha-v0.2.6-alpha.apk', browser_download_url: 'https://example.com/trikey.apk' }] }),
      release('v0.1.6-alpha'),
    ]);
    expect(picked?.tag).toBe('v0.1.6-alpha');
  });

  it('counts pre-releases and full releases alike', () => {
    expect(pickRelease([release('v0.1.6-alpha'), release('v0.1.7', { prerelease: false })])?.tag).toBe('v0.1.7');
  });

  it('copes with what is not a release', () => {
    expect(pickRelease([null, 'x', 3, [], { tag_name: 7 }, { tag_name: 'v0.1.7', assets: 'no' }])).toBeNull();
    expect(pickRelease([])).toBeNull();
  });

  it('falls back to the tag and the releases page when GitHub gives no usable title or page', () => {
    const picked = pickRelease([release('v0.1.7-alpha', { name: '   ', html_url: 'https://example.com/x' })]);
    expect(picked?.name).toBe('v0.1.7-alpha');
    expect(picked?.pageUrl).toBe(RELEASES_PAGE_URL);
  });

});

describe('checking for an update', () => {
  const tag = 'v0.1.7-alpha';

  it("finds a newer version with one request, and never fetches the release's own checksum", async () => {
    // The .sha256 comes from the same release as the APK: whoever could replace one could replace both, so it shows
    // nothing about who signed it. The signer to expect is built into the app (release-cert.ts).
    const { fetchFn, asked } = fakeGitHub([release(tag), release('v0.1.6-alpha')]);
    const result = await checkForUpdate('0.1.6', fetchFn);
    expect(result).toMatchObject({ kind: 'available', current: '0.1.6', release: { tag }, appId: 'app.trikey.wallet', newApp: false });
    expect(result).not.toHaveProperty('sha256');
    expect(asked).toEqual([RELEASES_API_URL]);
  });

  it('says the app is up to date on the same or an older release, and asks only once', async () => {
    const { fetchFn, asked } = fakeGitHub([release('v0.1.6-alpha'), release('v0.1.5-alpha')]);
    expect(await checkForUpdate('0.1.6', fetchFn)).toEqual({ kind: 'up-to-date', current: '0.1.6' });
    expect(await checkForUpdate('0.1.7', fetchFn)).toEqual({ kind: 'up-to-date', current: '0.1.7' });
    expect(asked).toEqual([RELEASES_API_URL, RELEASES_API_URL]);
  });

  it('says so when no release has an APK', async () => {
    const { fetchFn } = fakeGitHub([release('v0.1.7-alpha', { assets: [] })]);
    expect(await checkForUpdate('0.1.6', fetchFn)).toEqual({ kind: 'none', current: '0.1.6' });
  });

  const failure = async (promise: Promise<unknown>) => {
    const e = await promise.then(
      () => null,
      (err: unknown) => err
    );
    expect(e).toBeInstanceOf(UpdateCheckError);
    return e as UpdateCheckError;
  };

  it("names GitHub's rate limit", async () => {
    for (const status of [403, 429]) {
      const e = await failure(checkForUpdate('0.1.6', fakeGitHub({ message: 'API rate limit exceeded' }, {}, status).fetchFn));
      expect(e.kind).toBe('rate-limited');
      expect(e.status).toBe(status);
    }
  });

  it('names a phone that is offline', async () => {
    const offline: FetchLike = async () => {
      throw new TypeError('Network request failed');
    };
    const e = await failure(checkForUpdate('0.1.6', offline));
    expect(e.kind).toBe('offline');
    expect(e.message).toMatch(/online/);
  });

  it('gives up when GitHub does not answer in time', async () => {
    const hangs: FetchLike = (_url, init) =>
      new Promise((_resolve, reject) => init.signal?.addEventListener('abort', () => reject(new Error('Aborted'))));
    expect((await failure(checkForUpdate('0.1.6', hangs, { timeoutMs: 10 }))).kind).toBe('offline');
  });

  it('names a server error and an unreadable answer', async () => {
    expect((await failure(checkForUpdate('0.1.6', fakeGitHub([], {}, 502).fetchFn))).kind).toBe('server');
    expect((await failure(checkForUpdate('0.1.6', fakeGitHub({ message: 'hi' }).fetchFn))).kind).toBe('unreadable');
    expect((await failure(checkForUpdate('0.1.6', fakeGitHub('<html>').fetchFn))).kind).toBe('unreadable');
  });

  it('does not ask GitHub when it cannot read its own version', async () => {
    const { fetchFn, asked } = fakeGitHub([release(tag)]);
    expect((await failure(checkForUpdate('', fetchFn))).kind).toBe('unknown-version');
    expect(asked).toEqual([]);
  });

  it('sends no credentials', async () => {
    const seen: Record<string, string>[] = [];
    const fetchFn: FetchLike = async (url, init) => {
      seen.push(init.headers);
      return reply(200, url === RELEASES_API_URL ? [] : '');
    };
    await checkForUpdate('0.1.6', fetchFn);
    expect(seen.flatMap((h) => Object.keys(h).map((k) => k.toLowerCase()))).not.toContain('authorization');
  });
});

describe('the two Android builds', () => {
  /** A release with both APKs, as android-apk.yml publishes them from 0.1.9 on. */
  function both(tag: string) {
    const r = release(tag);
    const foss = `trikey-alpha-foss-${tag}.apk`;
    return {
      ...r,
      assets: [
        ...r.assets,
        { name: foss, browser_download_url: `${DL}${tag}/${foss}` },
        { name: `${foss}.sha256`, browser_download_url: `${DL}${tag}/${foss}.sha256` },
      ],
    };
  }

  it('names the APK of each build as the release workflow does', () => {
    expect(assetNames('v0.1.9-alpha')).toEqual({ apk: 'trikey-alpha-v0.1.9-alpha.apk' });
    expect(assetNames('v0.1.9-alpha', 'foss')).toEqual({ apk: 'trikey-alpha-foss-v0.1.9-alpha.apk' });
    // The workflow's names (packaging/android/sign-apk.sh, run by .github/workflows/android-build.yml), so the app and the releases agree.
    const workflow = readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../packaging/android/sign-apk.sh'), 'utf8');
    expect(workflow).toContain('name="trikey-alpha-foss-${GITHUB_REF_NAME}"');
    expect(workflow).toContain('name="trikey-alpha-${GITHUB_REF_NAME}"');
  });

  it('offers the installed build its own APK, never the other one', async () => {
    const list = [both('v0.1.9-alpha')];
    const standard = await checkForUpdate('0.1.8', fakeGitHub(list).fetchFn);
    const foss = await checkForUpdate('0.1.8', fakeGitHub(list).fetchFn, { variant: 'foss' });
    expect(standard).toMatchObject({ kind: 'available', release: { apkUrl: `${DL}v0.1.9-alpha/trikey-alpha-v0.1.9-alpha.apk` }, appId: 'app.trikey.wallet' });
    expect(foss).toMatchObject({ kind: 'available', release: { apkUrl: `${DL}v0.1.9-alpha/trikey-alpha-foss-v0.1.9-alpha.apk` }, appId: 'app.trikey.wallet.foss' });
  });

  it("says when the APK is another app than the running one, which Android cannot check against this one's signature", async () => {
    const list = [both('v0.1.22-alpha')];
    const run = (variant: 'standard' | 'foss', installedAppId?: string) =>
      checkForUpdate('0.1.21', fakeGitHub(list).fetchFn, { variant, ...(installedAppId === undefined ? {} : { installedAppId }) });
    // The usual case: the update is the same app, and Android refuses it unless it has the installed app's signature.
    expect(await run('standard', 'app.trikey.wallet')).toMatchObject({ newApp: false });
    expect(await run('foss', 'app.trikey.wallet.foss')).toMatchObject({ newApp: false });
    // A FOSS build that still has the standard app's id (as the no-Google build did up to 0.1.21): a first install.
    expect(await run('foss', 'app.trikey.wallet')).toMatchObject({ newApp: true, appId: 'app.trikey.wallet.foss' });
    expect(await run('standard', 'org.example.fork')).toMatchObject({ newApp: true });
    // Not told which app runs: no claim either way.
    expect(await run('foss')).toMatchObject({ newApp: false });
    expect(await run('foss', '  ')).toMatchObject({ newApp: false });
  });

  it('knows the application id of each release APK (android-variant.js)', async () => {
    expect(releaseAppId()).toBe('app.trikey.wallet');
    expect(releaseAppId('foss')).toBe('app.trikey.wallet.foss');
    const { androidAppFor } = (await import('../../android-variant.js')) as unknown as {
      androidAppFor: (v: string, s: { package: string; label: string; scheme: string }) => { package: string };
    };
    const app = JSON.parse(readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../app.json'), 'utf8')) as {
      expo: { android: { package: string } };
    };
    for (const variant of ['standard', 'foss'] as const) {
      expect(androidAppFor(variant, { package: app.expo.android.package, label: '', scheme: '' }).package).toBe(releaseAppId(variant));
    }
  });

  it('skips releases without an APK of the installed build (older ones, or one whose FOSS build failed)', async () => {
    // 0.1.10 has only the standard APK: the FOSS build stays on 0.1.9, the newest it can install.
    const list = [release('v0.1.10-alpha'), both('v0.1.9-alpha'), release('v0.1.8-alpha')];
    expect(pickRelease(list, 'foss')?.tag).toBe('v0.1.9-alpha');
    expect(pickRelease(list)?.tag).toBe('v0.1.10-alpha');
    expect(await checkForUpdate('0.1.9', fakeGitHub(list).fetchFn, { variant: 'foss' })).toEqual({ kind: 'up-to-date', current: '0.1.9' });
    expect(await checkForUpdate('0.1.8', fakeGitHub([release('v0.1.8-alpha')]).fetchFn, { variant: 'foss' })).toEqual({ kind: 'none', current: '0.1.8' });
  });
});
