/**
 * Settings > About > "Check for updates" (Android only): is there a Trikey release on GitHub newer than this app, and
 * where is its APK. The logic is pure and the network comes in as an argument, so the tests run without one.
 *
 * Privacy: the app asks GitHub only when the person taps the row. There is no background, scheduled or start-up
 * check, and none should be added: a wallet should not phone home unasked, and every request tells GitHub this phone's
 * IP address and that it runs Trikey. The request carries no account, token or wallet data.
 *
 * Every Trikey release is a GitHub pre-release for now (tag `v0.1.6-alpha`, asset `trikey-alpha-v0.1.6-alpha.apk`
 * beside `trikey-alpha-v0.1.6-alpha.apk.sha256`), so pre-releases count.
 */

const REPO = 'TheIcarusWings/trikey';
export const RELEASES_API_URL = `https://api.github.com/repos/${REPO}/releases?per_page=10`;
/** The list of releases, for when there is no single release to point at. */
export const RELEASES_PAGE_URL = `https://github.com/${REPO}/releases`;
/** Every APK and checksum the app opens or reads starts with this. */
export const DOWNLOAD_PREFIX = `https://github.com/${REPO}/releases/download/`;
const RELEASE_PAGE_PREFIX = `https://github.com/${REPO}/releases/tag/`;

export interface Version {
  major: number;
  minor: number;
  patch: number;
  /** `-alpha`: sorts just below the same numbers without it. */
  alpha: boolean;
}

const NUM = '(0|[1-9]\\d{0,5})';
const TAG_RE = new RegExp(`^v${NUM}\\.${NUM}\\.${NUM}(-alpha)?$`);
const APP_VERSION_RE = new RegExp(`^v?${NUM}\\.${NUM}\\.${NUM}(-alpha)?$`);

function toVersion(m: RegExpExecArray | null): Version | null {
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), alpha: !!m[4] };
}

/** A release tag: `v0.1.7` or `v0.1.7-alpha`. Anything else (`nightly`, `v0.1`, `v0.1.7-beta`) is not a Trikey release. */
export function parseTag(tag: string): Version | null {
  return toVersion(TAG_RE.exec(tag));
}

/** The running app's version, as app.json has it (`0.1.6`). */
export function parseAppVersion(version: string): Version | null {
  return toVersion(APP_VERSION_RE.exec(version.trim()));
}

export function formatVersion(v: Version): string {
  return `${v.major}.${v.minor}.${v.patch}`;
}

/** Negative when `a` is older than `b`, zero when the same, positive when newer. */
export function compareVersions(a: Version, b: Version): number {
  return a.major - b.major || a.minor - b.minor || a.patch - b.patch || Number(!a.alpha) - Number(!b.alpha);
}

/**
 * Whether `url` is a file of one of this repository's releases: `<DOWNLOAD_PREFIX><tag>/<file>` and nothing else (no
 * other host or repository, no `..`, query or fragment). Checked again right before the app opens it.
 */
export function isReleaseDownloadUrl(url: unknown): url is string {
  if (typeof url !== 'string' || !url.startsWith(DOWNLOAD_PREFIX)) return false;
  const rest = url.slice(DOWNLOAD_PREFIX.length).split('/');
  return rest.length === 2 && rest.every((part) => /^[A-Za-z0-9._-]+$/.test(part) && !/^\.+$/.test(part));
}

function isReleasePageUrl(url: unknown): url is string {
  if (typeof url !== 'string' || !url.startsWith(RELEASE_PAGE_PREFIX)) return false;
  const tag = url.slice(RELEASE_PAGE_PREFIX.length);
  return /^[A-Za-z0-9._-]+$/.test(tag) && !/^\.+$/.test(tag);
}

/** The file names a release must carry: the APK and, beside it, its checksum. */
export function assetNames(tag: string): { apk: string; sha256: string } {
  const apk = `trikey-alpha-${tag}.apk`;
  return { apk, sha256: `${apk}.sha256` };
}

export interface Release {
  tag: string;
  version: Version;
  /** The release's title on GitHub ("Trikey v0.1.7-alpha (alpha test build)"), or the tag. */
  name: string;
  /** The release's page on GitHub, or `RELEASES_PAGE_URL` when GitHub gave something else. */
  pageUrl: string;
  apkUrl: string;
  /** The `.apk.sha256` file, when the release has one. */
  sha256Url: string | null;
}

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);

function downloadUrl(assets: unknown[], name: string): string | null {
  const asset = assets.find((a) => isObject(a) && a.name === name);
  return isObject(asset) && isReleaseDownloadUrl(asset.browser_download_url) ? asset.browser_download_url : null;
}

/** One entry of GitHub's release list, if it is a published Trikey release with an APK. */
export function readRelease(raw: unknown): Release | null {
  if (!isObject(raw) || raw.draft === true || typeof raw.tag_name !== 'string') return null;
  const tag = raw.tag_name;
  const version = parseTag(tag);
  if (!version || !Array.isArray(raw.assets)) return null;
  const names = assetNames(tag);
  const apkUrl = downloadUrl(raw.assets, names.apk);
  if (!apkUrl) return null;
  const title = typeof raw.name === 'string' ? raw.name.trim().slice(0, 120) : '';
  return {
    tag,
    version,
    name: title || tag,
    pageUrl: isReleasePageUrl(raw.html_url) ? raw.html_url : RELEASES_PAGE_URL,
    apkUrl,
    sha256Url: downloadUrl(raw.assets, names.sha256),
  };
}

/** The newest Trikey release with an APK in GitHub's list, drafts and other tags skipped. */
export function pickRelease(list: unknown[]): Release | null {
  let best: Release | null = null;
  for (const raw of list) {
    const release = readRelease(raw);
    if (release && (!best || compareVersions(release.version, best.version) > 0)) best = release;
  }
  return best;
}

/** The hash in a `.sha256` file (`<64 hex>  trikey-alpha-v0.1.6-alpha.apk`), in lower case. */
export function parseSha256File(text: string): string | null {
  const first = text.trim().split(/\s+/)[0] ?? '';
  return /^[0-9a-fA-F]{64}$/.test(first) ? first.toLowerCase() : null;
}

export type UpdateCheck =
  | { kind: 'up-to-date'; current: string }
  | { kind: 'available'; current: string; release: Release; sha256: string | null }
  /** GitHub answered, but no release in its list has an APK. */
  | { kind: 'none'; current: string };

export type UpdateCheckErrorKind = 'offline' | 'rate-limited' | 'server' | 'unreadable' | 'unknown-version';

const ERROR_TEXT: Record<UpdateCheckErrorKind, string> = {
  offline: "Couldn't reach GitHub. Check that the phone is online and try again.",
  'rate-limited': 'GitHub is turning away requests from this network for now. Try again in an hour, or look on the releases page.',
  server: "GitHub couldn't answer just now. Try again later.",
  unreadable: "GitHub's answer didn't make sense to the app. Look on the releases page instead.",
  'unknown-version': "The app couldn't read its own version, so it can't compare. Look on the releases page instead.",
};

/** Why a check failed, with the sentence the screen shows. */
export class UpdateCheckError extends Error {
  constructor(
    readonly kind: UpdateCheckErrorKind,
    readonly status?: number
  ) {
    super(ERROR_TEXT[kind]);
    this.name = 'UpdateCheckError';
  }
}

/** The part of `fetch` the check uses, so a test can stand in for the network. */
export type FetchLike = (
  url: string,
  init: { headers: Record<string, string>; signal?: AbortSignal }
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown>; text(): Promise<string> }>;

async function withTimeout<T>(ms: number, task: (signal: AbortSignal | undefined) => Promise<T>): Promise<T> {
  const controller = typeof AbortController === 'function' ? new AbortController() : undefined;
  const timer = setTimeout(() => controller?.abort(), ms);
  try {
    return await task(controller?.signal);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Asks GitHub for the latest releases (one request, plus the small checksum file when there is a newer APK) and
 * compares the newest with `currentVersion`. Throws `UpdateCheckError`. Call it only from a tap: see the top of this file.
 */
export async function checkForUpdate(currentVersion: string, fetchFn: FetchLike, opts: { timeoutMs?: number } = {}): Promise<UpdateCheck> {
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const current = parseAppVersion(currentVersion);
  if (!current) throw new UpdateCheckError('unknown-version');

  let list: unknown;
  try {
    list = await withTimeout(timeoutMs, async (signal) => {
      const res = await fetchFn(RELEASES_API_URL, {
        headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
        signal,
      });
      // Unauthenticated, GitHub allows 60 requests an hour per IP address; past that it answers 403 or 429.
      if (res.status === 403 || res.status === 429) throw new UpdateCheckError('rate-limited', res.status);
      if (!res.ok) throw new UpdateCheckError('server', res.status);
      try {
        return await res.json();
      } catch {
        throw new UpdateCheckError('unreadable');
      }
    });
  } catch (e) {
    if (e instanceof UpdateCheckError) throw e;
    throw new UpdateCheckError('offline'); // no connection, DNS, TLS, or no answer in time
  }
  if (!Array.isArray(list)) throw new UpdateCheckError('unreadable');

  const shown = formatVersion(current);
  const release = pickRelease(list);
  if (!release) return { kind: 'none', current: shown };
  if (compareVersions(release.version, current) <= 0) return { kind: 'up-to-date', current: shown };
  return { kind: 'available', current: shown, release, sha256: await fetchSha256(release, fetchFn, timeoutMs) };
}

/** The checksum is a nicety: any failure leaves it out rather than failing the check. */
async function fetchSha256(release: Release, fetchFn: FetchLike, timeoutMs: number): Promise<string | null> {
  const url = release.sha256Url;
  if (!url || !isReleaseDownloadUrl(url)) return null;
  try {
    return await withTimeout(timeoutMs, async (signal) => {
      const res = await fetchFn(url, { headers: {}, signal });
      return res.ok ? parseSha256File((await res.text()).slice(0, 1024)) : null;
    });
  } catch {
    return null;
  }
}
