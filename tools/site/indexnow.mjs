#!/usr/bin/env node
// Tells IndexNow search engines (Bing, Yandex, Seznam, Naver and others; not Google) which trikey.app pages are new
// or changed, so a new blog post is found within a day or two instead of at the next crawl. https://www.indexnow.org
//
//   node tools/site/indexnow.mjs --before old-sitemap.xml --after site/sitemap.xml [--dry-run]
//
// The pages sent are those in the new sitemap that are missing from the old one or whose <lastmod> changed. The key is
// public by design: IndexNow checks it by fetching https://trikey.app/<key>.txt, which proves the site's owner sent the
// list. It is not a secret and gives no access to anything.
// Exit 0: sent, or nothing to send. Exit 1: IndexNow refused the list. Exit 2: bad arguments or files.
// Runs from .github/workflows/site.yml after a push to main has been deployed. Standard library only.
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const HOST = 'trikey.app';
export const ENDPOINT = 'https://api.indexnow.org/indexnow';
const SITE_DIR = fileURLToPath(new URL('../../site/', import.meta.url));

/** The key: the one file in site/ named <32 hex>.txt, whose content is that name. */
export function readKey(siteDir = SITE_DIR) {
  const files = readdirSync(siteDir).filter((f) => /^[0-9a-f]{32}\.txt$/.test(f));
  if (files.length !== 1) throw new Error(`expected exactly one IndexNow key file in site/, found ${files.length}`);
  const key = files[0].slice(0, -4);
  const content = readFileSync(resolve(siteDir, files[0]), 'utf8').trim();
  if (content !== key) throw new Error(`site/${files[0]} must contain its own name (${key}), not "${content}"`);
  return key;
}

/** Map of <loc> to <lastmod> (or '') from sitemap XML. */
export function sitemapEntries(xml) {
  const entries = new Map();
  for (const m of xml.matchAll(/<url>([\s\S]*?)<\/url>/g)) {
    const loc = /<loc>([^<]+)<\/loc>/.exec(m[1])?.[1]?.trim();
    if (!loc) continue;
    entries.set(loc, /<lastmod>([^<]+)<\/lastmod>/.exec(m[1])?.[1]?.trim() ?? '');
  }
  return entries;
}

/** URLs in the new sitemap that are new, or whose lastmod changed, and that are on HOST. */
export function changedUrls(beforeXml, afterXml) {
  const before = sitemapEntries(beforeXml);
  const changed = [];
  for (const [loc, lastmod] of sitemapEntries(afterXml)) {
    if (new URL(loc).host !== HOST) continue;
    if (!before.has(loc) || before.get(loc) !== lastmod) changed.push(loc);
  }
  return changed;
}

/** The JSON body IndexNow expects. */
export function payload(urls, key) {
  return { host: HOST, key, keyLocation: `https://${HOST}/${key}.txt`, urlList: urls };
}

async function main(argv) {
  const arg = (name) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const beforeFile = arg('--before');
  const afterFile = arg('--after');
  if (!beforeFile || !afterFile) throw new Error('usage: indexnow.mjs --before <sitemap.xml> --after <sitemap.xml> [--dry-run]');
  const urls = changedUrls(readFileSync(beforeFile, 'utf8'), readFileSync(afterFile, 'utf8'));
  if (!urls.length) {
    process.stdout.write('No new or changed pages in the sitemap: nothing to send.\n');
    return 0;
  }
  const body = payload(urls, readKey());
  process.stdout.write(`Pages to send (${urls.length}):\n${urls.map((u) => `  ${u}`).join('\n')}\n`);
  if (argv.includes('--dry-run')) {
    process.stdout.write('Dry run: not sent.\n');
    return 0;
  }
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify(body),
  });
  // 200 OK and 202 Accepted both mean received; 202 means the key is still being checked.
  if (res.status === 200 || res.status === 202) {
    process.stdout.write(`IndexNow accepted the list (HTTP ${res.status}).\n`);
    return 0;
  }
  process.stderr.write(`IndexNow refused the list: HTTP ${res.status} ${(await res.text()).slice(0, 300)}\n`);
  return 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (code) => (process.exitCode = code),
    (e) => {
      process.stderr.write(`${e.message}\n`);
      process.exitCode = 2;
    },
  );
}
