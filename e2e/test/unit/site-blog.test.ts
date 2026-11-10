/**
 * The trikey.app blog generator (tools/site/build-blog.mjs), its Markdown converter, and the checks every page in
 * site/ must pass (tools/site/check-site.mjs). site/ has no build step on Vercel, so the generated HTML is committed:
 * the first test fails when a post was added or changed without regenerating.
 */
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  BuildError,
  SITE_DIR,
  buildSite,
  diffSite,
  htmlText,
  parseFrontMatter,
  publishedSource,
  queuedPosts,
  validatePost,
  writeSite,
} from '../../../tools/site/build-blog.mjs';
import { publishNext } from '../../../tools/site/publish-next.mjs';
import { checkPage, checkSite, checkXml } from '../../../tools/site/check-site.mjs';
import { markdownToHtml, wordCount } from '../../../tools/site/markdown.mjs';

const temps: string[] = [];
afterEach(() => {
  for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true });
});

/**
 * A copy of site/ without the films and photos (big, and nothing here reads them), and with no posts but the example
 * draft, so the tests don't depend on what's been published. The real posts' pages are left over in the copy until a
 * test writes a build, which removes them.
 */
function siteCopy(): string {
  const dir = mkdtempSync(join(tmpdir(), 'trikey-site-'));
  temps.push(dir);
  const posts = join(SITE_DIR, 'blog', 'posts');
  cpSync(SITE_DIR, dir, {
    recursive: true,
    filter: (src) => !src.startsWith(join(SITE_DIR, 'media')) && !(src.startsWith(`${posts}/`) && !src.endsWith('/example-post.md')),
  });
  return dir;
}

function post(fields: Record<string, string>, body: string): string {
  return `---\n${Object.entries(fields)
    .map(([k, v]) => `${k}: ${v}`)
    .join('\n')}\n---\n\n${body}\n`;
}

const DESC = '"A test post about two-of-three multisig, written for the generator tests, and long enough to be a proper meta description."';

function locs(xml: string): string[] {
  return [...xml.matchAll(/<loc>([^<]*)<\/loc>/g)].map((m) => m[1]);
}

describe('the committed site', () => {
  it('is what the generator writes (run node tools/site/build-blog.mjs and commit if this fails)', () => {
    const { files } = buildSite(SITE_DIR);
    expect(diffSite(SITE_DIR, files)).toEqual([]);
  });

  it('passes every page check: title, description, canonical, one h1, nothing from other sites, links resolve', () => {
    expect(checkSite(SITE_DIR)).toEqual([]);
  });

  it('keeps drafts out of the build, the blog index, the feed and the sitemap', () => {
    const src = readFileSync(join(SITE_DIR, 'blog/posts/example-post.md'), 'utf8');
    expect(parseFrontMatter(src).data.draft).toBe(true);
    const { files, posts } = buildSite(SITE_DIR);
    expect(posts.map((p) => p.slug)).not.toContain('example-post');
    expect([...files.keys()]).not.toContain('blog/example-post.html');
    expect(files.get('blog/index.html')).not.toContain('example-post');
    expect(files.get('blog/feed.xml')).not.toContain('example-post');
    expect(files.get('sitemap.xml')).not.toContain('example-post');
  });

  it('builds the example draft when asked to, as a noindex page', () => {
    const { files } = buildSite(SITE_DIR, { drafts: true });
    const html = files.get('blog/example-post.html')!;
    expect(html).toContain('<meta name="robots" content="noindex">');
    expect(html).toContain('<h1>Example post: what the blog&#39;s Markdown can do</h1>');
    expect(html).toContain('<table>');
    expect(html).toContain('<img src="/img/phone-home.webp" alt="The Trikey home screen');
    expect(html).toMatch(/width="\d+" height="\d+"/);
    expect(html).toContain('&lt;b&gt;Raw HTML&lt;/b&gt;');
    expect(files.get('sitemap.xml')).not.toContain('example-post');
    expect(files.get('blog/feed.xml')).not.toContain('example-post');
  });

  it('gives the home page FAQPage JSON-LD with exactly the questions on the page', () => {
    const html = readFileSync(join(SITE_DIR, 'index.html'), 'utf8');
    const block = /<script type="application\/ld\+json" id="faq-jsonld">([\s\S]*?)<\/script>/.exec(html)![1];
    const faq = JSON.parse(block) as { '@type': string; mainEntity: { name: string; acceptedAnswer: { text: string } }[] };
    expect(faq['@type']).toBe('FAQPage');
    const faqSection = html.slice(html.indexOf('<section id="faq"'), html.indexOf('</section>', html.indexOf('<section id="faq"')));
    const onPage = [...faqSection.matchAll(/<summary>([\s\S]*?)<\/summary>/g)].map((m) => htmlText(m[1]));
    expect(faq.mainEntity.map((q) => q.name)).toEqual(onPage);
    expect(onPage.length).toBeGreaterThan(3);
    for (const q of faq.mainEntity) expect(q.acceptedAnswer.text.length).toBeGreaterThan(20);
  });

  it('describes the app with SoftwareApplication JSON-LD and no invented ratings', () => {
    const html = readFileSync(join(SITE_DIR, 'index.html'), 'utf8');
    const blocks = [...html.matchAll(/<script type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g)].map((m) => JSON.parse(m[1]));
    const graph = blocks.flatMap((b: { '@graph'?: unknown[] }) => b['@graph'] ?? [b]) as Record<string, unknown>[];
    const app = graph.find((n) => n['@type'] === 'SoftwareApplication')!;
    expect(app).toMatchObject({ name: 'Trikey', applicationCategory: 'FinanceApplication', operatingSystem: 'Android, iOS' });
    expect(app.offers).toMatchObject({ price: '0' });
    expect(JSON.stringify(blocks)).not.toMatch(/aggregateRating|"review"/);
    expect(graph.map((n) => n['@type'])).toEqual(expect.arrayContaining(['Organization', 'WebSite']));
  });

  it('keeps noindex on the passkey test and the 404 page, and both out of the sitemap', () => {
    const sitemap = readFileSync(join(SITE_DIR, 'sitemap.xml'), 'utf8');
    for (const f of ['passkey-test.html', '404.html']) {
      expect(readFileSync(join(SITE_DIR, f), 'utf8')).toContain('<meta name="robots" content="noindex">');
    }
    expect(sitemap).not.toContain('passkey-test');
    expect(sitemap).not.toContain('404');
    expect(locs(sitemap)).toEqual(expect.arrayContaining(['https://trikey.app/', 'https://trikey.app/obtainium']));
  });
});

describe('building posts', () => {
  it('builds published posts with their pages, the index, the feed and the sitemap, and nothing else', () => {
    const site = siteCopy();
    const posts = join(site, 'blog/posts');
    writeFileSync(
      join(posts, 'older-post.md'),
      post({ title: '"An older post"', description: DESC, date: '2026-11-01', slug: 'older-post', keywords: '[multisig, recovery]' }, 'Some text about recovery.'),
    );
    writeFileSync(
      join(posts, 'newer-post.md'),
      post(
        { title: '"A newer post"', description: DESC, date: '2026-11-08', updated: '2026-11-09', slug: 'newer-post', keywords: '[multisig]', draft: 'false' },
        'Read [the older one](/blog/older-post) first.\n\n## A section\n\nMore text.',
      ),
    );
    writeFileSync(
      join(posts, 'secret-draft.md'),
      post({ title: '"Not yet"', description: DESC, date: '2026-11-09', draft: 'true' }, 'Unfinished.'),
    );

    const { files, posts: built } = buildSite(site);
    expect(built.map((p) => p.slug)).toEqual(['newer-post', 'older-post']);
    expect([...files.keys()].sort()).toEqual(
      ['blog/feed.xml', 'blog/index.html', 'blog/newer-post.html', 'blog/older-post.html', 'index.html', 'sitemap.xml'].sort(),
    );

    // Newest first on the index.
    const index = files.get('blog/index.html')!;
    expect(index.indexOf('/blog/newer-post')).toBeLessThan(index.indexOf('/blog/older-post'));
    expect(index).not.toContain('secret-draft');
    expect(index).not.toContain('noindex');

    // Sitemap and feed: valid XML, exactly the published posts.
    const sitemap = files.get('sitemap.xml')!;
    expect(checkXml(sitemap)).toEqual([]);
    expect(locs(sitemap).filter((u) => u.includes('/blog'))).toEqual([
      'https://trikey.app/blog',
      'https://trikey.app/blog/newer-post',
      'https://trikey.app/blog/older-post',
    ]);
    expect(sitemap).toContain('<loc>https://trikey.app/blog/newer-post</loc>\n    <lastmod>2026-11-09</lastmod>');
    const feed = files.get('blog/feed.xml')!;
    expect(checkXml(feed)).toEqual([]);
    expect([...feed.matchAll(/<link>([^<]*)<\/link>/g)].map((m) => m[1])).toEqual([
      'https://trikey.app/blog',
      'https://trikey.app/blog/newer-post',
      'https://trikey.app/blog/older-post',
    ]);
    expect(feed).toContain('href="https://trikey.app/blog/older-post"'); // links in the content are absolute

    // The post page: canonical, OG, one h1, BlogPosting JSON-LD, reading time, related posts, the standard box.
    const page = files.get('blog/newer-post.html')!;
    expect(page).toContain('<link rel="canonical" href="https://trikey.app/blog/newer-post">');
    expect(page).toContain('<meta property="og:type" content="article">');
    expect(page.match(/<h1[\s>]/g)).toHaveLength(1);
    expect(page).toContain('min read');
    expect(page).toContain('Trikey is pre-alpha and not audited.');
    expect(page).toContain('<h2 id="related-h">Keep reading</h2>');
    const ld = JSON.parse(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(page)![1]) as { '@graph': Record<string, unknown>[] };
    expect(ld['@graph'][0]).toMatchObject({
      '@type': 'BlogPosting',
      headline: 'A newer post',
      datePublished: '2026-11-08',
      dateModified: '2026-11-09',
      keywords: 'multisig',
    });

    // Written out, the copy passes the same checks as the real site, and a rebuild changes nothing.
    writeSite(site, files);
    expect(checkSite(site)).toEqual([]);
    expect(diffSite(site, buildSite(site).files)).toEqual([]);

    // Making a post a draft removes its page.
    writeFileSync(
      join(posts, 'older-post.md'),
      post({ title: '"An older post"', description: DESC, date: '2026-11-01', draft: 'true' }, 'Some text.'),
    );
    expect(() => buildSite(site)).toThrow(/goes to a draft/); // the newer post links to it
    writeFileSync(join(posts, 'newer-post.md'), post({ title: '"A newer post"', description: DESC, date: '2026-11-08' }, 'Text.'));
    const again = buildSite(site);
    expect(diffSite(site, again.files)).toContain("site/blog/older-post.html is left over from a post that's gone or now a draft");
    expect(writeSite(site, again.files).removed).toEqual(['blog/older-post.html']);
    expect(checkSite(site)).toEqual([]);
  });

  it('marks the blog index noindex while there are no published posts', () => {
    const { files } = buildSite(SITE_DIR);
    if (buildSite(SITE_DIR).posts.length === 0) {
      expect(files.get('blog/index.html')).toContain('<meta name="robots" content="noindex">');
      expect(files.get('sitemap.xml')).not.toContain('/blog');
    } else {
      expect(files.get('blog/index.html')).not.toContain('noindex');
    }
  });

  it('refuses a post with broken front matter, a bad link or an h1 in the text', () => {
    const site = siteCopy();
    const posts = join(site, 'blog/posts');
    writeFileSync(join(posts, 'bad-one.md'), post({ title: '"Bad"', description: DESC, date: '2026-13-01' }, 'x'));
    writeFileSync(join(posts, 'bad-two.md'), post({ title: '"Bad"', description: DESC, date: '2026-11-01', slug: 'other-name' }, 'x'));
    writeFileSync(
      join(posts, 'bad-three.md'),
      post({ title: '"Bad"', description: DESC, date: '2026-11-01' }, '# Another h1\n\n[x](/no-such-page) ![a](/img/nope.png) ![](/img/share.png)'),
    );
    let error: unknown;
    try {
      buildSite(site);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(BuildError);
    const messages = (error as BuildError).errors.join('\n');
    expect(messages).toContain('bad-one.md: "date" is required, as YYYY-MM-DD');
    expect(messages).toContain('"slug" is "other-name" but the file is bad-two.md');
    expect(messages).toContain("the post title is the page's only h1");
    expect(messages).toContain('link "/no-such-page" goes to a page that doesn\'t exist');
    expect(messages).toContain('image "/img/nope.png" isn\'t a file in site/');
    expect(messages).toContain('image without alt text');
  });
});

describe('front matter', () => {
  it('reads the documented format, comments included', () => {
    const { data, body } = parseFrontMatter(
      [
        '---',
        'title: "Two-of-three multisig, explained: what # means"   # the page title / h1',
        "description: 'It''s a description'",
        'date: 2026-11-10',
        'updated: 2026-11-11   # optional',
        'slug: two-of-three-multisig-explained',
        'keywords: [multisig, "self-custody", \'key, with comma\']   # optional',
        'draft: false          # true = not built/listed',
        '---',
        '',
        'Body.',
      ].join('\n'),
    );
    expect(data).toEqual({
      title: 'Two-of-three multisig, explained: what # means',
      description: "It's a description",
      date: '2026-11-10',
      updated: '2026-11-11',
      slug: 'two-of-three-multisig-explained',
      keywords: ['multisig', 'self-custody', 'key, with comma'],
      draft: false,
    });
    expect(body.trim()).toBe('Body.');
  });

  it('rejects what it cannot read', () => {
    expect(() => parseFrontMatter('no front matter')).toThrow(/must start with front matter/);
    expect(() => parseFrontMatter('---\ntitle: "open\n---\n')).toThrow(/unterminated/);
    expect(() => parseFrontMatter('---\ntitle: x\ntitle: y\n---\n')).toThrow(/set twice/);
    expect(() => parseFrontMatter('---\ndescription: >\n  folded\n---\n')).toThrow();
  });

  it('checks the fields', () => {
    const ok = { title: 'T', description: 'x'.repeat(140), date: '2026-11-10' };
    expect(validatePost(ok, 'f.md', 'f').post).toMatchObject({ slug: 'f', draft: false, keywords: [], updated: null });
    expect(validatePost({ ...ok, description: 'short' }, 'f.md', 'f').errors[0]).toMatch(/description is 5 characters/);
    expect(validatePost({ ...ok, description: 'x'.repeat(170) }, 'f.md', 'f').warnings[0]).toMatch(/120 to 160 is best/);
    expect(validatePost({ ...ok, updated: '2026-11-01' }, 'f.md', 'f').errors[0]).toMatch(/before "date"/);
    expect(validatePost({ ...ok, draft: 'yes' }, 'f.md', 'f').errors[0]).toMatch(/"draft" must be true or false/);
    expect(validatePost({ ...ok, author: 'me' }, 'f.md', 'f').warnings[0]).toMatch(/unknown front matter key "author"/);
    expect(validatePost({ ...ok, slug: 'Bad_Slug' }, 'f.md', 'Bad_Slug').errors[0]).toMatch(/lower-case words/);
  });

  it('takes "queue" on drafts only, as a whole number', () => {
    const ok = { title: 'T', description: 'x'.repeat(140), date: '2026-11-10', draft: true };
    expect(validatePost({ ...ok, queue: '3' }, 'f.md', 'f').post).toMatchObject({ queue: 3 });
    expect(validatePost(ok, 'f.md', 'f').post).toMatchObject({ queue: null });
    expect(validatePost({ ...ok, queue: '0' }, 'f.md', 'f').errors[0]).toMatch(/whole number from 1 to 9999/);
    expect(validatePost({ ...ok, queue: 'soon' }, 'f.md', 'f').errors[0]).toMatch(/whole number/);
    expect(validatePost({ ...ok, draft: false, queue: '1' }, 'f.md', 'f').errors[0]).toMatch(/only goes on a draft/);
  });
});

describe('the daily queue', () => {
  it('publishes the lowest queued draft, dated today, and links to it once it is out', () => {
    const site = siteCopy();
    const posts = join(site, 'blog/posts');
    writeFileSync(
      join(posts, 'first-post.md'),
      post({ title: '"First"', description: DESC, date: '2026-11-01' }, 'See [the second](/blog/second-post) and [the third](/blog/third-post).'),
    );
    writeFileSync(
      join(posts, 'second-post.md'),
      post({ title: '"Second"', description: DESC, date: '2026-11-01', updated: '2026-11-02', draft: 'true', queue: '2' }, 'Body two.\n\n---\n\nqueue: 9 in the body stays.'),
    );
    writeFileSync(join(posts, 'third-post.md'), post({ title: '"Third"', description: DESC, date: '2026-11-01', draft: 'true', queue: '1' }, 'Body three.'));
    writeFileSync(join(posts, 'held-post.md'), post({ title: '"Held"', description: DESC, date: '2026-11-01', draft: 'true' }, 'Never queued.'));

    // Links to queued posts show their words without the link, with a warning.
    const first = buildSite(site);
    expect(first.posts.map((p) => p.slug)).toEqual(['first-post']);
    expect(first.files.get('blog/first-post.html')).toContain('See the second and the third.');
    expect(first.warnings.filter((w) => w.includes('is queued'))).toHaveLength(2);
    writeSite(site, first.files);
    expect(queuedPosts(site).map((q) => q.slug)).toEqual(['third-post', 'second-post']);

    expect(publishNext(site, '2026-11-11')).toBe('third-post');
    const third = parseFrontMatter(readFileSync(join(posts, 'third-post.md'), 'utf8')).data;
    expect(third).toMatchObject({ draft: false, date: '2026-11-11' });
    expect(third).not.toHaveProperty('queue');
    const page = readFileSync(join(site, 'blog/first-post.html'), 'utf8');
    expect(page).toContain('<a href="/blog/third-post">the third</a>');
    expect(page).not.toContain('href="/blog/second-post"');
    expect(diffSite(site, buildSite(site).files)).toEqual([]);
    expect(checkSite(site)).toEqual([]);

    expect(publishNext(site, '2026-11-12')).toBe('second-post');
    const second = readFileSync(join(posts, 'second-post.md'), 'utf8');
    expect(parseFrontMatter(second).data).toEqual(expect.objectContaining({ draft: false, date: '2026-11-12' }));
    expect(second).not.toMatch(/^updated:/m);
    expect(second).toContain('queue: 9 in the body stays.'); // only the front matter changes
    expect(publishNext(site, '2026-11-13')).toBeNull(); // the held draft is never published by the queue
    expect(readFileSync(join(site, 'blog/index.html'), 'utf8')).not.toContain('held-post');
  });

  it('leaves the post as it was when the build fails', () => {
    const site = siteCopy();
    const posts = join(site, 'blog/posts');
    const src = post({ title: '"Broken"', description: DESC, date: '2026-11-01', draft: 'true', queue: '1' }, 'A [missing page](/nowhere).');
    writeFileSync(join(posts, 'broken-post.md'), src);
    expect(() => publishNext(site, '2026-11-11')).toThrow(BuildError);
    expect(readFileSync(join(posts, 'broken-post.md'), 'utf8')).toBe(src);
  });

  it('rewrites only the front matter', () => {
    expect(publishedSource('---\ntitle: "T"\ndate: 2026-11-01\ndraft: true   # queued\nqueue: 4\n---\n\ndraft: true\n', '2026-11-20')).toBe(
      '---\ntitle: "T"\ndate: 2026-11-20\ndraft: false\n---\n\ndraft: true\n',
    );
    expect(() => publishedSource('---\n---\n', 'today')).toThrow(/not a date/);
  });
});

describe('Markdown', () => {
  const html = (md: string) => {
    const r = markdownToHtml(md);
    expect(r.errors).toEqual([]);
    return r.html;
  };

  it('escapes HTML everywhere: text, headings, link text and titles, code', () => {
    expect(html('<script>alert(1)</script> & "q"')).toBe('<p>&lt;script&gt;alert(1)&lt;/script&gt; &amp; &quot;q&quot;</p>');
    expect(html('## <img src=x onerror=alert(1)>')).toContain('<h2 id="img-src-x-onerror-alert-1">&lt;img src=x onerror=alert(1)&gt;</h2>');
    expect(html('[<b>x</b>](https://example.com "a \\"b\\" <c>")')).not.toMatch(/<b>|<c>/);
    expect(html('`<i>`')).toBe('<p><code>&lt;i&gt;</code></p>');
    expect(html('```html\n<div onclick="x">\n```')).toBe('<pre><code class="language-html">&lt;div onclick=&quot;x&quot;&gt;\n</code></pre>');
    expect(html('[x](https://example.com/?a="><script>)')).not.toContain('"><script>');
  });

  it('refuses unsafe link targets and images from other sites', () => {
    for (const bad of ['javascript:alert(1)', 'JaVaScRiPt:alert(1)', 'data:text/html,x', 'vbscript:x', '//evil.example/x']) {
      const r = markdownToHtml(`[x](${bad})`);
      expect(r.errors.length, bad).toBe(1);
      expect(r.html).not.toContain('href');
    }
    const img = markdownToHtml('![a](https://example.com/a.png)');
    expect(img.errors[0]).toMatch(/images must be files on this site/);
    expect(img.html).not.toContain('<img');
  });

  it('adds rel="noopener" to links to other sites only', () => {
    expect(html('[a](https://example.com) [b](/obtainium) [c](https://trikey.app/blog) <https://bitcoin.org>')).toBe(
      '<p><a href="https://example.com" rel="noopener">a</a> <a href="/obtainium">b</a> <a href="https://trikey.app/blog">c</a> <a href="https://bitcoin.org" rel="noopener">https://bitcoin.org</a></p>',
    );
  });

  it('handles headings, emphasis, code, breaks and escapes', () => {
    expect(html('## Delay & Notify\n\n## Delay & Notify')).toBe(
      '<h2 id="delay-notify">Delay &amp; Notify</h2>\n<h2 id="delay-notify-2">Delay &amp; Notify</h2>',
    );
    expect(html('**b** *i* _i_ ***bi*** ~~s~~ snake_case_name 2 * 3 \\*not\\*')).toBe(
      '<p><strong>b</strong> <em>i</em> <em>i</em> <strong><em>bi</em></strong> <del>s</del> snake_case_name 2 * 3 *not*</p>',
    );
    expect(html('one  \ntwo\\\nthree\nfour')).toBe('<p>one<br>\ntwo<br>\nthree\nfour</p>');
    expect(html('`` a ` b ``')).toBe('<p><code>a ` b</code></p>');
  });

  it('handles lists, nested lists, numbered lists and loose lists', () => {
    expect(html('- a\n- b\n  - c\n- d')).toBe('<ul>\n<li>a</li>\n<li>b\n<ul>\n<li>c</li>\n</ul></li>\n<li>d</li>\n</ul>');
    expect(html('3. x\n4. y')).toBe('<ol start="3">\n<li>x</li>\n<li>y</li>\n</ol>');
    expect(html('1. x\n\n2. y')).toBe('<ol>\n<li><p>x</p></li>\n<li><p>y</p></li>\n</ol>');
    expect(html('In 2026. A year.')).toBe('<p>In 2026. A year.</p>');
    expect(html('Text\n2026. A year.')).toBe('<p>Text\n2026. A year.</p>');
  });

  it('handles blockquotes, rules, tables, images and figures', () => {
    expect(html('> a\n> *b*')).toBe('<blockquote>\n<p>a\n<em>b</em></p>\n</blockquote>');
    expect(html('---')).toBe('<hr>');
    const table = html('| a | b |\n|:--|--:|\n| 1 | `x|y` |');
    expect(table).toContain('<th scope="col" class="align-left">a</th><th scope="col" class="align-right">b</th>');
    expect(table).toContain('<td class="align-right"><code>x|y</code></td>');
    expect(table).toContain('class="table-scroll"');
    const sized = markdownToHtml('![A phone](/img/p.webp "Caption")', { image: () => ({ width: 520, height: 1125 }) });
    expect(sized.html).toBe(
      '<figure>\n<img src="/img/p.webp" alt="A phone" width="520" height="1125" loading="lazy" decoding="async">\n<figcaption>Caption</figcaption>\n</figure>',
    );
    expect(html('Look: ![x](/a.png) here')).toBe('<p>Look: <img src="/a.png" alt="x" loading="lazy" decoding="async"> here</p>');
  });

  it('handles reference links and footnotes', () => {
    const out = html('See [BIP 48][bip] and a note.[^n]\n\n[bip]: https://github.com/bitcoin/bips "BIPs"\n[^n]: The *note*.');
    expect(out).toContain('<a href="https://github.com/bitcoin/bips" title="BIPs" rel="noopener">BIP 48</a>');
    expect(out).toContain('<sup class="fnref"><a id="fnref-n" href="#fn-n" aria-label="Note 1">1</a></sup>');
    expect(out).toContain('<li id="fn-n">The <em>note</em>. <a class="fnback" href="#fnref-n"');
    expect(out).not.toContain('[bip]:');
  });

  it('leaves Markdown inside code alone', () => {
    expect(html('```\n# not a heading\n[x]: not-a-ref\n**raw**\n```')).toBe(
      '<pre><code># not a heading\n[x]: not-a-ref\n**raw**\n</code></pre>',
    );
  });

  it('counts words for the reading time', () => {
    expect(wordCount('## Two words\n\nAnd **three** more [here](/x).')).toBe(6);
  });
});

describe('page checks', () => {
  it('catch what they are for', () => {
    const bad = `<!doctype html><html><head>
<meta http-equiv="Content-Security-Policy" content="default-src *">
<title>T</title>
<script src="https://cdn.example.com/x.js"></script>
<link rel="stylesheet" href="https://fonts.example.com/f.css">
</head><body><h1>a</h1><h1>b</h1><img src="/x.png"><a href="https://example.com">x</a><a href="/nope">y</a>
<script type="application/ld+json">{oops}</script></body></html>`;
    const errors = checkPage(SITE_DIR, 'page.html', bad).join('\n');
    for (const want of [
      'needs a lang attribute',
      'the CSP must be exactly',
      'exactly one <h1>, has 2',
      'no meta description',
      'no canonical link',
      'src loads from another site: https://cdn.example.com/x.js',
      '<link> to another site: https://fonts.example.com/f.css',
      'image without alt',
      'image without width and height',
      'link to another site (only github.com and trikey.app here): https://example.com',
      'broken link: /nope',
      "JSON-LD doesn't parse",
    ]) {
      expect(errors).toContain(want);
    }
  });

  it('allow cited links in blog posts only with rel="noopener"', () => {
    const page = (a: string) => `<html lang="en"><a href="${a}">x</a></html>`;
    expect(checkPage(SITE_DIR, 'blog/x.html', page('https://example.com" rel="noopener')).join()).not.toContain('another site');
    expect(checkPage(SITE_DIR, 'blog/x.html', page('https://example.com')).join()).toContain('without rel="noopener"');
  });

  it('check that XML is well-formed', () => {
    expect(checkXml('<?xml version="1.0"?>\n<a><b>x &amp; y</b></a>')).toEqual([]);
    expect(checkXml('<?xml version="1.0"?>\n<a><b>x & y</b></a>')).toEqual(['stray "&" at offset 30']);
    expect(checkXml('<?xml version="1.0"?>\n<a><b></a>').length).toBeGreaterThan(0);
    expect(checkXml('<a/>')).toEqual(['missing <?xml …?> declaration at the very start']);
  });
});
