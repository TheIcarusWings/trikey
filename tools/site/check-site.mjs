#!/usr/bin/env node
// Checks every HTML page in site/ before it deploys. No dependencies.
//
//   node tools/site/check-site.mjs
//
// Every page: lang, the strict CSP, a title, exactly one h1, alt/width/height on images, JSON-LD that parses, nothing
// loaded from another site (src, srcset, poster and <link href> must be on trikey.app), and links on this site that
// resolve to a file. Pages in search results (no noindex): a description, a canonical URL that matches where the page is
// served, Open Graph tags, a unique title. Links to other sites: only github.com, trikey.app and zapstore.dev (the app's listings), except in blog posts,
// which may cite any https site with rel="noopener". sitemap.xml and blog/feed.xml must be well-formed XML, and the
// sitemap must list exactly the indexable pages.
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SITE_DIR, SITE_URL, fileForPath, isNoindex, urlPathFor } from './build-blog.mjs';

const CSP = "default-src 'self'; base-uri 'none'; form-action 'none'";
const LINK_HOSTS = /^https:\/\/(www\.)?(github\.com|trikey\.app|zapstore\.dev)(\/|$)/;

function htmlFiles(dir, base = dir) {
  const out = [];
  for (const name of readdirSync(dir).sort()) {
    const f = join(dir, name);
    if (statSync(f).isDirectory()) out.push(...htmlFiles(f, base));
    else if (name.endsWith('.html')) out.push(relative(base, f).split('\\').join('/'));
  }
  return out;
}

/** Well-formedness errors in an XML document ([] if fine). Enough for a sitemap and an RSS feed. */
export function checkXml(xml) {
  const errors = [];
  const stack = [];
  let roots = 0;
  const src = String(xml).replace(/^\uFEFF/, '');
  if (!/^<\?xml [^?]*\?>/.test(src)) errors.push('missing <?xml …?> declaration at the very start');
  const token =
    /<!\[CDATA\[[\s\S]*?\]\]>|<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<\/([A-Za-z_][\w:.-]*)\s*>|<([A-Za-z_][\w:.-]*)((?:\s+[A-Za-z_][\w:.-]*\s*=\s*(?:"[^"<]*"|'[^'<]*'))*)\s*(\/?)>|&(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);|[<&]/g;
  let m;
  while ((m = token.exec(src))) {
    const t = m[0];
    if (t === '<' || t === '&') {
      errors.push(`stray "${t}" at offset ${m.index}`);
      continue;
    }
    if (m[1]) {
      const open = stack.pop();
      if (open !== m[1]) errors.push(`</${m[1]}> closes <${open ?? 'nothing'}>`);
    } else if (m[2]) {
      for (const a of m[3].matchAll(/=\s*(?:"([^"]*)"|'([^']*)')/g)) {
        const v = a[1] ?? a[2];
        if (/&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);)/.test(v)) errors.push(`unescaped & in attribute of <${m[2]}>`);
      }
      if (stack.length === 0) roots++;
      if (!m[4]) stack.push(m[2]);
    }
  }
  if (stack.length) errors.push(`unclosed <${stack.join('>, <')}>`);
  if (roots !== 1) errors.push(`expected one root element, found ${roots}`);
  return errors;
}

function attr(tag, name) {
  const m = new RegExp(`\\s${name}\\s*=\\s*"([^"]*)"`, 'i').exec(tag);
  return m ? m[1] : null;
}

/** Problems with one page ([] if fine). rel is its path in site/, e.g. "blog/index.html". */
export function checkPage(siteDir, rel, html) {
  const errors = [];
  const err = (m) => errors.push(`site/${rel}: ${m}`);
  const isBlog = rel.startsWith('blog/');
  const noindex = isNoindex(html);

  if (!/<html\s[^>]*lang="[a-z]{2}(-[A-Za-z]+)?"/.test(html)) err('<html> needs a lang attribute');
  const csp = /<meta http-equiv="Content-Security-Policy" content="([^"]*)">/.exec(html);
  if (!csp) err('no Content-Security-Policy meta tag');
  else if (csp[1] !== CSP) err(`the CSP must be exactly "${CSP}" (got "${csp[1]}")`);
  if (!/<meta name="viewport"/.test(html)) err('no viewport meta tag');

  const title = /<title>([^<]*)<\/title>/.exec(html)?.[1]?.trim();
  if (!title) err('no <title>');
  const h1s = html.match(/<h1[\s>]/g) ?? [];
  if (h1s.length !== 1) err(`needs exactly one <h1>, has ${h1s.length}`);

  if (!noindex) {
    const desc = /<meta name="description" content="([^"]*)">/.exec(html)?.[1];
    if (!desc) err('no meta description');
    else if (desc.length < 50 || desc.length > 200) err(`meta description is ${desc.length} characters (aim for 120 to 160)`);
    const canonical = /<link rel="canonical" href="([^"]*)">/.exec(html)?.[1];
    const expected = SITE_URL + urlPathFor(rel);
    if (!canonical) err('no canonical link');
    else if (canonical !== (expected === SITE_URL ? `${SITE_URL}/` : expected)) err(`canonical is ${canonical}, but the page is served at ${expected}`);
    for (const p of ['og:title', 'og:description', 'og:image', 'og:url', 'og:type']) {
      if (!new RegExp(`<meta property="${p}" content="[^"]+">`).test(html)) err(`no ${p} meta tag`);
    }
    if (!/<meta name="twitter:card" content="[^"]+">/.test(html)) err('no twitter:card meta tag');
  }

  for (const m of html.matchAll(/<script type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g)) {
    try {
      JSON.parse(m[1]);
    } catch (e) {
      err(`JSON-LD doesn't parse: ${e.message}`);
    }
  }
  for (const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)) {
    const type = attr(m[0], 'type');
    if (type === 'application/ld+json') continue;
    if (m[2].trim() !== '') err('inline <script>: scripts must be files on this site (the CSP blocks inline ones)');
  }
  if (/\sstyle="/.test(html)) err('inline style attribute: the CSP blocks it; use a class');

  for (const m of html.matchAll(/<img\b[^>]*>/g)) {
    const tag = m[0];
    if (attr(tag, 'alt') === null) err(`image without alt: ${tag.slice(0, 80)}`);
    if (!attr(tag, 'width') || !attr(tag, 'height')) err(`image without width and height: ${tag.slice(0, 80)}`);
  }

  // Nothing loads from another site.
  for (const m of html.matchAll(/\s(src|srcset|poster|data)\s*=\s*"([^"]*)"/g)) {
    const urls = m[1] === 'srcset' ? m[2].split(',').map((s) => s.trim().split(/\s+/)[0]) : [m[2]];
    for (const u of urls) {
      if (/^(https?:)?\/\//i.test(u) && !/^https:\/\/(www\.)?trikey\.app\//.test(u)) err(`${m[1]} loads from another site: ${u}`);
    }
  }
  for (const m of html.matchAll(/<link\b[^>]*>/g)) {
    const href = attr(m[0], 'href') ?? '';
    if (/^(https?:)?\/\//i.test(href) && !/^https:\/\/trikey\.app\//.test(href)) err(`<link> to another site: ${href}`);
  }

  // Links.
  const pagePath = urlPathFor(rel);
  for (const m of html.matchAll(/<a\b[^>]*>/g)) {
    const href = attr(m[0], 'href');
    if (href === null) continue;
    if (/^https?:\/\//i.test(href)) {
      if (LINK_HOSTS.test(href)) continue;
      if (!isBlog) err(`link to another site (only github.com, trikey.app and zapstore.dev here): ${href}`);
      else if (!/^https:\/\//i.test(href)) err(`link over plain http: ${href}`);
      else if (!/\brel="[^"]*noopener/.test(m[0])) err(`link to another site without rel="noopener": ${href}`);
      continue;
    }
    if (/^(mailto:|obtainium:|#)/i.test(href)) continue;
    if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('//')) {
      err(`link with a scheme that isn't allowed: ${href}`);
      continue;
    }
    // Relative links resolve against the served URL (cleanUrls: /blog/x is in /blog/, /obtainium in /).
    const resolved = new URL(href, `https://x${pagePath.endsWith('/') ? pagePath : pagePath.replace(/[^/]*$/, '')}`).pathname;
    if (!fileForPath(siteDir, resolved)) err(`broken link: ${href}`);
  }
  return errors;
}

/** All problems in site/ ([] if it's fine). */
export function checkSite(siteDir = SITE_DIR) {
  const errors = [];
  const pages = htmlFiles(siteDir);
  const titles = new Map();
  const indexable = [];
  for (const rel of pages) {
    const html = readFileSync(join(siteDir, rel), 'utf8');
    errors.push(...checkPage(siteDir, rel, html));
    if (rel === '404.html') {
      if (!isNoindex(html)) errors.push('site/404.html: must be noindex');
      continue;
    }
    if (isNoindex(html)) continue;
    indexable.push(SITE_URL + (urlPathFor(rel) === '/' ? '/' : urlPathFor(rel)));
    const title = /<title>([^<]*)<\/title>/.exec(html)?.[1]?.trim();
    if (title && titles.has(title)) errors.push(`site/${rel}: same <title> as site/${titles.get(title)}`);
    else if (title) titles.set(title, rel);
  }

  const sitemapFile = join(siteDir, 'sitemap.xml');
  if (!existsSync(sitemapFile)) errors.push('site/sitemap.xml is missing');
  else {
    const xml = readFileSync(sitemapFile, 'utf8');
    errors.push(...checkXml(xml).map((e) => `site/sitemap.xml: ${e}`));
    const locs = [...xml.matchAll(/<loc>([^<]*)<\/loc>/g)].map((m) => m[1]).sort();
    const want = [...indexable].sort();
    for (const u of want) if (!locs.includes(u)) errors.push(`site/sitemap.xml: missing ${u}`);
    for (const u of locs) if (!want.includes(u)) errors.push(`site/sitemap.xml: lists ${u}, which isn't an indexable page`);
  }
  const feedFile = join(siteDir, 'blog', 'feed.xml');
  if (existsSync(feedFile)) errors.push(...checkXml(readFileSync(feedFile, 'utf8')).map((e) => `site/blog/feed.xml: ${e}`));

  const robots = join(siteDir, 'robots.txt');
  if (!existsSync(robots) || !readFileSync(robots, 'utf8').includes(`Sitemap: ${SITE_URL}/sitemap.xml`)) {
    errors.push('site/robots.txt must exist and point to the sitemap');
  }
  return errors;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const errors = checkSite();
  if (errors.length) {
    for (const e of errors) process.stderr.write(`::error::${e}\n`);
    process.exitCode = 1;
  } else {
    process.stdout.write('site/ checks out: every page has its tags, nothing loads from other sites, links resolve.\n');
  }
}
