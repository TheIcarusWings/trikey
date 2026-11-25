/**
 * Settings > About > "Check for updates" (Android only): is there a Trikey release on GitHub newer than this app, and
 * where is its APK. The logic is pure and the network comes in as an argument, so the tests run without one.
 *
 * Privacy: the app asks GitHub only when the person taps the row. There is no background, scheduled or start-up
 * check, and none should be added: a wallet should not phone home unasked, and every request tells GitHub this phone's
 * IP address and that it runs Trikey. The request carries no account, token or wallet data.
 *
 * Releases are tagged `v0.1.6-alpha` (asset `trikey-alpha-v0.1.6-alpha.apk`). Up to 0.1.25-alpha every one was a GitHub
 * pre-release; later ones are normal releases. The list (not `/releases/latest`, which skips pre-releases) has both, and
 * both count. Drafts never do: GitHub's public API does not list them, and a draft in the answer is skipped
 * anyway (a release is a draft until every file is attached and checked: .github/workflows/publish-release.yml). From
 * 0.1.9 a release carries two Android builds: the standard one and the one without Google code
 * (`trikey-alpha-foss-v0.1.9-alpha.apk`), from 0.1.23 two apps (app.trikey.wallet, app.trikey.wallet.foss). The check
 * offers the APK of the build that is installed, so an update never swaps one for the other.
 *
 * Who signed the APK is not something a file of the same release can show: the release's `.sha256` comes from the same
 * place as the APK, so whoever could replace one could replace both. The app does not fetch it. What tells is the
 * signing certificate, whose SHA-256 is built into the app (release-cert.ts). Android itself refuses an update signed by
 * another key than the installed app's; an APK with another application id is a new app, which Android has nothing to
 * compare with, so the update sheet then tells the person to check the certificate (`newApp`).
 *
 * **The release's signature** (docs/design/signed-releases.md, phase 3): before offering an APK, the app downloads the
 * release's manifest (`trikey-<tag>-SHA256SUMS`) and its signature (`.event.json`) and checks them as publish-release.yml
 * does: a kind-1420 event by the publisher key built into the app (publisher-key.ts), whose `x` tag is the manifest's
 * SHA-256, and a manifest line for this APK whose hash is the one GitHub gives for the file (the asset's `digest`).
 * A release published by hand from a stolen GitHub account has no valid signature, so the app shows it as unsigned and
 * offers no download (`unsigned`).
 */

import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { verifyEvent, type Event } from 'nostr-tools/pure';
import type { AndroidVariant } from './android-variant';
import type { BuildChannel } from './build-channel';
import { PUBLISHER_PUBKEY } from './publisher-key';

const REPO = 'TheIcarusWings/trikey';
export const RELEASES_API_URL = `https://api.github.com/repos/${REPO}/releases?per_page=10`;
/** The list of releases, for when there is no single release to point at. */
export const RELEASES_PAGE_URL = `https://github.com/${REPO}/releases`;
/** Every APK the app opens starts with this. */
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

/**
 * The file name of `variant`'s APK in a release. The names are made in packaging/android/sign-apk.sh (run by
 * .github/workflows/android-build.yml) and checked before publication by packaging/check-release-assets.sh.
 */
export function assetNames(tag: string, variant: AndroidVariant = 'standard', channel: BuildChannel = 'release'): { apk: string } {
  // Trikey Test (a test build, its own app) is `trikey-test-alpha-<tag>.apk`. The `-alpha` stays after 1.0
  // (`trikey-alpha-v1.0.0.apk`): installed apps look for these exact names, so new ones would strand them (DESIGN.md).
  const prefix = channel === 'test' ? 'trikey-test-alpha' : 'trikey-alpha';
  return { apk: variant === 'foss' ? `${prefix}-foss-${tag}.apk` : `${prefix}-${tag}.apk` };
}

/** The application id of the app each release APK installs as (android-variant.js; from 0.1.23, two apps; from 0.1.31, Trikey Test). */
export function releaseAppId(variant: AndroidVariant = 'standard', channel: BuildChannel = 'release'): string {
  return (variant === 'foss' ? 'app.trikey.wallet.foss' : 'app.trikey.wallet') + (channel === 'test' ? '.test' : '');
}

export interface Release {
  tag: string;
  version: Version;
  /** The release's title on GitHub ("Trikey v0.1.7-alpha (alpha test build)"), or the tag. */
  name: string;
  /** The release's page on GitHub, or `RELEASES_PAGE_URL` when GitHub gave something else. */
  pageUrl: string;
  apkUrl: string;
  /** The APK's SHA-256 as GitHub gives it (the asset's `digest`), when it does. */
  apkSha256?: string;
  /** The release's manifest and its signature, when the release has them. */
  manifestUrl?: string;
  eventUrl?: string;
}

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);

function downloadUrl(assets: unknown[], name: string): string | null {
  const asset = assets.find((a) => isObject(a) && a.name === name);
  return isObject(asset) && isReleaseDownloadUrl(asset.browser_download_url) ? asset.browser_download_url : null;
}

/** One entry of GitHub's release list, if it is a published Trikey release with an APK of `variant`. */
export function readRelease(raw: unknown, variant: AndroidVariant = 'standard', channel: BuildChannel = 'release'): Release | null {
  if (!isObject(raw) || raw.draft === true || typeof raw.tag_name !== 'string') return null;
  const tag = raw.tag_name;
  const version = parseTag(tag);
  if (!version || !Array.isArray(raw.assets)) return null;
  const names = assetNames(tag, variant, channel);
  const apkUrl = downloadUrl(raw.assets, names.apk);
  if (!apkUrl) return null;
  const title = typeof raw.name === 'string' ? raw.name.trim().slice(0, 120) : '';
  const apkAsset = raw.assets.find((a) => isObject(a) && a.name === names.apk);
  const digest = isObject(apkAsset) && typeof apkAsset.digest === 'string' ? /^sha256:([0-9a-f]{64})$/.exec(apkAsset.digest)?.[1] : undefined;
  const manifestUrl = downloadUrl(raw.assets, manifestName(tag));
  const eventUrl = downloadUrl(raw.assets, `${manifestName(tag)}.event.json`);
  return {
    tag,
    version,
    name: title || tag,
    pageUrl: isReleasePageUrl(raw.html_url) ? raw.html_url : RELEASES_PAGE_URL,
    apkUrl,
    ...(digest ? { apkSha256: digest } : {}),
    ...(manifestUrl ? { manifestUrl } : {}),
    ...(eventUrl ? { eventUrl } : {}),
  };
}

/** The newest Trikey release with an APK of `variant` in GitHub's list, drafts and other tags skipped. */
export function pickRelease(list: unknown[], variant: AndroidVariant = 'standard', channel: BuildChannel = 'release'): Release | null {
  let best: Release | null = null;
  for (const raw of list) {
    const release = readRelease(raw, variant, channel);
    if (release && (!best || compareVersions(release.version, best.version) > 0)) best = release;
  }
  return best;
}

export type UpdateCheck =
  | { kind: 'up-to-date'; current: string }
  | {
      kind: 'available';
      current: string;
      release: Release;
      /** The application id the APK installs as. */
      appId: string;
      /**
       * The APK is another app than the one running (another application id): Android installs it beside this one,
       * with no installed app to check its signature against. Only known when the caller says which app is running.
       */
      newApp: boolean;
    }
  /** GitHub answered, but no release in its list has an APK. */
  | { kind: 'none'; current: string }
  /** A newer release is on GitHub, but it isn't validly signed by the publisher key: no download is offered. */
  | { kind: 'unsigned'; current: string; release: Release; reason: string };

export const RELEASE_KIND = 1420;
export const manifestName = (tag: string) => `trikey-${tag}-SHA256SUMS`;
const contentLine = (tag: string) => `Trikey release ${tag}: the files listed in ${manifestName(tag)}`;

export type SignatureCheck = { ok: true } | { ok: false; reason: string };

/**
 * Whether `eventJson` is the publisher key's signature of `manifest` for `tag`, and the manifest lists `apkName` with
 * `apkSha256`. The same rules as packaging/release-signature.py's check. `pubkey` and `verify` are for the tests.
 */
export function checkReleaseSignature(
  tag: string,
  manifest: string,
  eventJson: string,
  apkName: string,
  apkSha256: string | undefined,
  opts: { pubkey?: string; verify?: (e: Event) => boolean } = {}
): SignatureCheck {
  const pubkey = opts.pubkey ?? PUBLISHER_PUBKEY;
  const verify = opts.verify ?? verifyEvent;
  let ev: unknown;
  try {
    ev = JSON.parse(eventJson);
  } catch {
    return { ok: false, reason: 'its signature file is not a signature' };
  }
  if (!isObject(ev)) return { ok: false, reason: 'its signature file is not a signature' };
  const fields = Object.keys(ev).sort().join(',');
  if (fields !== 'content,created_at,id,kind,pubkey,sig,tags') return { ok: false, reason: 'its signature file is not a signature' };
  if (ev.pubkey !== pubkey) return { ok: false, reason: "it is signed by another key than Trikey's publisher key" };
  const manifestSha = bytesToHex(sha256(new TextEncoder().encode(manifest)));
  const tags = JSON.stringify(ev.tags);
  if (ev.kind !== RELEASE_KIND || ev.content !== contentLine(tag) || tags !== JSON.stringify([['x', manifestSha], ['version', tag]]))
    return { ok: false, reason: 'its signature is for other files or another release' };
  let valid = false;
  try {
    const { id, pubkey: pk, created_at, kind, tags: t, content, sig } = ev;
    valid = verify({ id, pubkey: pk, created_at, kind, tags: t, content, sig } as Event);
  } catch {
    valid = false;
  }
  if (!valid) return { ok: false, reason: 'its signature does not check' };
  const line = manifest.split('\n').find((l) => l.endsWith(`  ${apkName}`));
  const listed = line && /^([0-9a-f]{64}) {2}/.exec(line)?.[1];
  if (!listed) return { ok: false, reason: 'its signed list of files has no APK for this app' };
  if (!apkSha256) return { ok: false, reason: "GitHub didn't give the APK's checksum, so it can't be matched to the signature" };
  if (listed !== apkSha256) return { ok: false, reason: 'its APK is not the one that was signed' };
  return { ok: true };
}

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
 * Asks GitHub for the latest releases (one request) and compares the newest with `currentVersion`. Only releases with
 * an APK of `opts.variant` (the installed build, standard by default) count. `opts.installedAppId`, the running app's
 * application id, tells whether the APK would install as another app (`newApp`). Throws `UpdateCheckError`. Call it only
 * from a tap: see the top of this file.
 */
export async function checkForUpdate(
  currentVersion: string,
  fetchFn: FetchLike,
  opts: { timeoutMs?: number; variant?: AndroidVariant; channel?: BuildChannel; installedAppId?: string; pubkey?: string } = {}
): Promise<UpdateCheck> {
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
  const variant = opts.variant ?? 'standard';
  const channel = opts.channel ?? 'release';
  const release = pickRelease(list, variant, channel);
  if (!release) return { kind: 'none', current: shown };
  if (compareVersions(release.version, current) <= 0) return { kind: 'up-to-date', current: shown };
  const signature = await releaseSignature(release, assetNames(release.tag, variant, channel).apk, fetchFn, timeoutMs, opts.pubkey);
  if (!signature.ok) return { kind: 'unsigned', current: shown, release, reason: signature.reason };
  const appId = releaseAppId(variant, channel);
  const installed = opts.installedAppId?.trim();
  return { kind: 'available', current: shown, release, appId, newApp: !!installed && installed !== appId };
}

/** Downloads the release's manifest and signature (two more requests, to GitHub's release files) and checks them. */
async function releaseSignature(release: Release, apkName: string, fetchFn: FetchLike, timeoutMs: number, pubkey?: string): Promise<SignatureCheck> {
  if (!release.manifestUrl || !release.eventUrl) return { ok: false, reason: 'it has no signature' };
  const get = (url: string) =>
    withTimeout(timeoutMs, async (signal) => {
      const res = await fetchFn(url, { headers: {}, signal });
      if (!res.ok) throw new UpdateCheckError('server', res.status);
      return res.text();
    });
  let manifest: string;
  let event: string;
  try {
    [manifest, event] = await Promise.all([get(release.manifestUrl), get(release.eventUrl)]);
  } catch (e) {
    if (e instanceof UpdateCheckError) throw e;
    throw new UpdateCheckError('offline');
  }
  return checkReleaseSignature(release.tag, manifest, event, apkName, release.apkSha256, pubkey ? { pubkey } : {});
}
