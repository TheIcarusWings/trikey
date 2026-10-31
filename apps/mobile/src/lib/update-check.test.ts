import { describe, expect, it } from 'vitest';
import {
  RELEASES_API_URL,
  RELEASES_PAGE_URL,
  UpdateCheckError,
  checkForUpdate,
  compareVersions,
  isReleaseDownloadUrl,
  parseAppVersion,
  parseSha256File,
  parseTag,
  pickRelease,
  type FetchLike,
} from './update-check';

const DL = 'https://github.com/TheIcarusWings/trikey/releases/download/';
const HASH = 'ba18630a437f0ca9b51792a2b3966c687bdbf9eacc0785b5983c8f07705a9bd8';

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
      sha256Url: `${DL}v0.1.8-alpha/trikey-alpha-v0.1.8-alpha.apk.sha256`,
    });
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

  it('leaves the checksum out when the release has none', () => {
    const tag = 'v0.1.7-alpha';
    const only = release(tag, { assets: [release(tag).assets[0]] });
    expect(pickRelease([only])?.sha256Url).toBeNull();
  });
});

describe('the checksum file', () => {
  it('reads the hash before the file name', () => {
    expect(parseSha256File(`${HASH}  trikey-alpha-v0.1.6-alpha.apk\n`)).toBe(HASH);
    expect(parseSha256File(HASH.toUpperCase())).toBe(HASH);
  });

  it('refuses anything that is not a SHA-256', () => {
    expect(parseSha256File('')).toBeNull();
    expect(parseSha256File('Not Found')).toBeNull();
    expect(parseSha256File(`${HASH.slice(1)}  a.apk`)).toBeNull();
  });
});

describe('checking for an update', () => {
  const tag = 'v0.1.7-alpha';
  const shaUrl = `${DL}${tag}/trikey-alpha-${tag}.apk.sha256`;

  it('finds a newer version, with its checksum', async () => {
    const { fetchFn, asked } = fakeGitHub([release(tag), release('v0.1.6-alpha')], { [shaUrl]: `${HASH}  trikey-alpha-${tag}.apk\n` });
    const result = await checkForUpdate('0.1.6', fetchFn);
    expect(result).toMatchObject({ kind: 'available', current: '0.1.6', sha256: HASH, release: { tag } });
    expect(asked).toEqual([RELEASES_API_URL, shaUrl]);
  });

  it('still offers the update when the checksum cannot be fetched', async () => {
    const { fetchFn } = fakeGitHub([release(tag)]);
    expect(await checkForUpdate('0.1.6', fetchFn)).toMatchObject({ kind: 'available', sha256: null });
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
