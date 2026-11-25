// node --test tools/site/ (run by .github/workflows/site.yml)
import { strict as assert } from 'node:assert';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { changedUrls, payload, readKey, sitemapEntries } from './indexnow.mjs';

const map = (entries) =>
  `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${entries
    .map(([loc, lastmod]) => `  <url>\n    <loc>${loc}</loc>\n${lastmod ? `    <lastmod>${lastmod}</lastmod>\n` : ''}  </url>`)
    .join('\n')}\n</urlset>\n`;

test('a published post and the blog index are sent; unchanged pages are not', () => {
  const before = map([
    ['https://trikey.app/', '2026-11-11'],
    ['https://trikey.app/blog', '2026-11-23'],
    ['https://trikey.app/blog/old-post', '2026-11-20'],
  ]);
  const after = map([
    ['https://trikey.app/', '2026-11-11'],
    ['https://trikey.app/blog', '2026-11-24'],
    ['https://trikey.app/blog/new-post', '2026-11-24'],
    ['https://trikey.app/blog/old-post', '2026-11-20'],
  ]);
  assert.deepEqual(changedUrls(before, after), ['https://trikey.app/blog', 'https://trikey.app/blog/new-post']);
});

test('an updated post (new lastmod) is sent', () => {
  const before = map([['https://trikey.app/blog/p', '2026-11-20']]);
  const after = map([['https://trikey.app/blog/p', '2026-11-24']]);
  assert.deepEqual(changedUrls(before, after), ['https://trikey.app/blog/p']);
});

test('nothing changed: nothing to send; a removed page is not sent', () => {
  const same = map([['https://trikey.app/', '2026-11-11']]);
  assert.deepEqual(changedUrls(same, same), []);
  assert.deepEqual(changedUrls(map([['https://trikey.app/gone', '2026-11-01']]), map([])), []);
});

test('a first run (empty old sitemap) sends every page', () => {
  const after = map([['https://trikey.app/', '2026-11-11'], ['https://trikey.app/blog', '']]);
  assert.deepEqual(changedUrls('', after), ['https://trikey.app/', 'https://trikey.app/blog']);
});

test('URLs on another host are never sent (IndexNow rejects the whole list otherwise)', () => {
  assert.deepEqual(changedUrls('', map([['https://example.com/x', '2026-11-11']])), []);
});

test('sitemapEntries reads loc and lastmod', () => {
  const m = sitemapEntries(map([['https://trikey.app/a', '2026-11-01'], ['https://trikey.app/b', '']]));
  assert.equal(m.get('https://trikey.app/a'), '2026-11-01');
  assert.equal(m.get('https://trikey.app/b'), '');
});

test('the repository has exactly one key file, and it contains its own name', () => {
  assert.match(readKey(), /^[0-9a-f]{32}$/);
});

test('readKey refuses a key file whose content does not match its name', () => {
  const dir = mkdtempSync(join(tmpdir(), 'indexnow-'));
  writeFileSync(join(dir, `${'cd'.repeat(16)}.txt`), 'something else\n');
  assert.throws(() => readKey(dir), /must contain its own name/);
});

test('payload names the host, key and key location', () => {
  // A made-up key, built at run time: a 32-hex literal next to "key" reads to gitleaks as a leaked API key.
  const placeholder = 'ab'.repeat(16);
  assert.deepEqual(payload(['https://trikey.app/blog'], placeholder), {
    host: 'trikey.app',
    key: placeholder,
    keyLocation: `https://trikey.app/${placeholder}.txt`,
    urlList: ['https://trikey.app/blog'],
  });
});
