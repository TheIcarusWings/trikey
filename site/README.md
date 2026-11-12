# trikey.app

The project website, its blog, and the domain verification files the mobile app needs.
Plain HTML and CSS with one small script of our own (`js/story.js`): no build step on
Vercel, no framework, no tracking and no requests to other sites (a strict
`Content-Security-Policy` meta tag enforces this). The blog is written in Markdown and
turned into HTML by a small script in this repo (see [Blog](#blog)); the HTML is committed. The script turns the film
scenes into pinned scroll scenes; without it, or with reduced motion, the page is
a plain stack of cards and reads the same.

| Path | What it is |
|---|---|
| `index.html`, `style.css` | The landing page |
| `media/films/` | The films for the web: "Nobody in the middle" in the hero, the three "If a key goes missing" episodes in the key picker, and in "Watch" the three short explainers (`v1`–`v3`) and the six setup tutorials (`t1`–`t6`). 720p H.264, a poster and a WebVTT captions file each. The films and explainers have captions burned in too. Nothing loads until someone presses play. Exported from the marketing repo with `render/web-export.py` |
| `media/social/` | Vertical (9:16) cuts of the films for the launch-week posts on nostr, linked from the notes rather than shown on the site. 720×1280 H.264 with captions burned in. Re-encoded from the marketing repo's `out/` renders. |
| `js/story.js` | Scroll scenes: sticky stages, shot timing, video scrubbing. Progressive enhancement only |
| `404.html` | Not-found page (Vercel serves it automatically). `noindex` |
| `obtainium.html` | trikey.app/obtainium: one tap to add Trikey to Obtainium |
| `passkey-test.html` | trikey.app/passkey-test: checks a password manager's passkey PRF support. `noindex`, on purpose |
| `blog/posts/*.md` | The blog's posts, in Markdown ([Blog](#blog)). Not deployed (`.vercelignore`) |
| `blog/*.html`, `blog/feed.xml`, `sitemap.xml` | **Generated** by `tools/site/build-blog.mjs`. Don't edit them by hand |
| `blog/blog.css` | The blog's article styles, on top of `style.css` |
| `robots.txt` | Lets every crawler in, points to the sitemap |
| `img/share.png` | The 1200×630 link-preview image (Open Graph and X cards), the logo and the one-line pitch on white |
| `apple-touch-icon.png` | 180×180 logo for home screens; also the logo in the structured data |
| `img/` | Phone screenshots, rendered from `design/screens` (light and dark WebP). The four `phone-onb-*` images are the app's own setup steps, captured from its web build in Demo mode without the demo strip. `donate-qr.svg` is the QR code of `bitcoin:` plus the donation address, made with the `qrcode` package (re-make it if the address changes). `donate-ln-qr.svg` is the QR code of `LIGHTNING:` plus the LNURL of icaruswings@getalby.com (bech32 of `https://getalby.com/.well-known/lnurlp/icaruswings`, upper case), made the same way |
| `media/` | Photos (WebP) and three short muted video loops (H.264 MP4, under 1 MB each) taken from the launch film footage, plus one generated still of the three keys. Loops are hidden for people who prefer reduced motion; the poster image stays. |
| `fonts/` | Geist and Geist Mono (latin, variable `woff2`) with their OFL license texts |
| `favicon.svg` | The logo |
| `vercel.json` | Response headers: `application/json` for the Apple file and `nostr.json` (plus CORS for the latter), HSTS and other security headers, `application/rss+xml` for the feed, `noindex` for the Markdown sources should they ever be served, and caching: a day for `img/` and `media/`, 30 days for `fonts/` (their file names don't change when they do, so not longer) |
| `.well-known/apple-app-site-association` | iOS: passkeys for `app.trikey.wallet` (needs a Team ID) |
| `.well-known/assetlinks.json` | Android: passkeys for `app.trikey.wallet` and `app.trikey.wallet.foss`, the app without Google code (needs a signing fingerprint) |
| `.well-known/nostr.json` | NIP-05: `trikey@trikey.app` and `_@trikey.app` (shown as just `trikey.app`) name Trikey's publisher npub, the key that signs the Zapstore listing (`docs/zapstore.md`). `icaruswings@trikey.app` names the founder's own npub. No `relays` hint: `relay.trikey.app` stores only gift wraps and Nostr Connect events, not profiles, so a client following a hint there would find nothing. Served as JSON with `Access-Control-Allow-Origin: *`, which NIP-05 requires |
| `.well-known/security.txt` | RFC 9116 contact, points to the repo's private security advisories |

## Preview locally

```sh
npx serve site
# or, without the clean URLs Vercel serves (/blog/<slug> then needs .html):
python3 -m http.server -d site
```

Then open the address it prints.

## Deployment

The site is hosted on **Vercel**, deployed from this GitHub repository:

- every push to `main` that changes `site/` deploys to production at `https://trikey.app`;
- pull requests get a preview deployment.

`site/` has no build step. Vercel serves it as static files and applies the headers in `vercel.json`.

Before Vercel deploys, `.github/workflows/site.yml` runs these checks on pushes and pull requests that touch `site/`
or `tools/site/`:

- both `.well-known` JSON files and `vercel.json` must parse;
- `node tools/site/build-blog.mjs --check`: the generated blog pages, feed, sitemap and the home page's FAQ structured
  data match the posts and the page, so a post can't be merged without its HTML;
- `node tools/site/check-site.mjs`, on every HTML page: `lang`, the strict CSP (exactly
  `default-src 'self'; base-uri 'none'; form-action 'none'`, no inline scripts or `style` attributes), a title, exactly
  one `h1`, `alt`, `width` and `height` on every image, JSON-LD that parses, links on the site that resolve, and
  **nothing loaded from another site** (`src`, `srcset`, `poster` and `<link href>` only on trikey.app). Pages without
  `noindex` also need a description, a canonical URL matching where Vercel serves them, Open Graph tags and a unique
  title. Links to other sites may only go to `github.com` and `trikey.app`, except in blog posts, which may cite any
  `https` source (with `rel="noopener"`, which the generator adds). The sitemap must list exactly the indexable pages.

The unit tests in `e2e/test/unit/site-blog.test.ts` cover the Markdown converter, the generator and these checks
(`npm run test:unit --workspace e2e`).

## Blog

Posts are Markdown files in `blog/posts/<slug>.md`. Each is served at `https://trikey.app/blog/<slug>`.

```markdown
---
title: "Two-of-three multisig, explained"  # the page title and h1 (search results show about 60 characters)
description: "…"      # the meta description and the line under the title: 120 to 160 characters
date: 2026-11-10       # published, YYYY-MM-DD
updated: 2026-11-12    # optional: last real change
slug: two-of-three-multisig-explained   # optional; must equal the file name
keywords: [multisig, self-custody]      # optional: picks the related posts; no meta keywords tag
draft: false           # true = not built, listed, in the feed or in the sitemap
queue: 3               # drafts only: its place in the daily queue (below)
image: /blog/img/two-of-three.png       # optional link-preview image, 1200×630, in site/
image_alt: "…"         # required with image
---

The text. Sections start at `##`: the title is the page's only h1.
```

Values are on one line, quoted or bare; `#` starts a comment outside quotes. Unknown keys are a warning, not an error.

The Markdown: `##`–`######` headings, paragraphs, line breaks (two trailing spaces or `\`), `-`/`*` and `1.` lists
(nested by indenting), `>` quotes, fenced code blocks with a language, `---` rules, pipe tables with `:--:` alignment,
`[links](/path)`, `<https://autolinks>`, `[reference][links]`, `![images](/img/x.webp "caption")`, `**bold**`,
`*italic*`, `~~struck~~`, `` `code` `` and footnotes (`[^1]` plus a one-line `[^1]: …`). Raw HTML is escaped and shows
as text. A link to a queued post shows its words without the link until that post is published. The build stops with
a message if a post links somewhere that doesn't exist on this site (or to a draft that isn't queued),
uses a `javascript:`-style link, or has an image that isn't a file in `site/` or has no alt text. Images get their
`width` and `height` from the file. Put a post's images in `site/blog/img/`.

Every post page gets: a canonical URL, Open Graph and X card tags, `BlogPosting` and `BreadcrumbList` JSON-LD, the
date and reading time, up to three related posts (shared keywords first, then the newest), and a standard box: Trikey is
pre-alpha and not audited, with links to the home page, the testers' quickstart and GitHub.

```sh
node tools/site/build-blog.mjs           # write blog/*.html, blog/index.html, blog/feed.xml, sitemap.xml
node tools/site/build-blog.mjs --check   # what CI runs: fails if those are out of date
node tools/site/build-blog.mjs --drafts --out /tmp/trikey-preview   # preview drafts in a copy of site/
npx serve /tmp/trikey-preview            # serves /blog/<slug> the way Vercel does
```

Commit the post and the generated files together. Deleting a post, or making it a draft again, removes its page on the
next build. Node 22 is all it needs: no `npm install`.

`blog/posts/example-post.md` is a draft that shows every supported piece of Markdown; it's never published.

**One post a day** ([docs/blog-plan.md](../docs/blog-plan.md)). A reviewed post waits in `blog/posts/` as a draft
with a `queue` number. Each day `node tools/site/publish-next.mjs` takes the lowest one, dates it today, drops
`draft`, `queue` and `updated`, and rebuilds; `--list` shows the queue. A draft without `queue` is never published by
it.

The build also writes the home page's `FAQPage` structured data (the `faq-jsonld` block in `index.html`) from the
Questions section on the page, so edit the questions and rebuild. The sitemap lists every top-level page without
`noindex`, with the date from its `<meta name="dcterms.modified">` tag: bump that tag when a page changes in a way that
matters.

## Search engines

- **Titles and descriptions** are specific to each page; every indexable page has a canonical URL, Open Graph and X
  card tags with `img/share.png`, and the home page has `Organization`, `WebSite`, `SoftwareApplication` and `FAQPage`
  structured data. JSON-LD is data, not script, so the CSP doesn't apply to it and it stays `default-src 'self'`.
- **`robots.txt`** allows everything and names the sitemap. Pages kept out of results use a `noindex` meta tag instead
  (the 404 page, the passkey test, and the blog index while it has no posts), since a crawler can only see that tag on
  a page it may fetch.
- **Verification**: see [One-time setup](#one-time-setup-repository-owner), step 5.

## One-time setup (repository owner)

1. **Vercel project.** Import the GitHub repo into Vercel and set **Root Directory** to `site`. Pick no framework preset, and leave the build command and output directory empty. The Vercel GitHub app needs access to the repository.
2. **Domains.** In the project's Settings, then Domains:
   - add `trikey.app`;
   - add `www.trikey.app`, set to redirect to `trikey.app`.
3. **DNS at the registrar.** Delete any records that point elsewhere (for example GitHub Pages' `185.199.x.x` and `2606:50c0:...` addresses), then add:

   | Type | Name | Value |
   |---|---|---|
   | A | `@` | `216.198.79.1` |
   | A | `@` | `64.29.17.1` |
   | CNAME | `www` | `cc44458c4c7e6158.vercel-dns-017.com` |

   These are the values Vercel recommended for this project. The older generic ones (`76.76.21.21` and `cname.vercel-dns.com`) also work. Vercel's Domains page always shows the current ones.
4. **HTTPS.** Vercel issues the certificate on its own once DNS resolves.
5. **Search engines.** Verify the domain with a **DNS TXT record** rather than a file in `site/`: it proves the whole
   domain (`trikey.app`, `www`, and any subdomain like `relay.trikey.app`), survives any change to the site, and adds
   nothing to the repo.
   - **Google Search Console**: Add property, **Domain**, `trikey.app`. Google shows a `google-site-verification=…`
     value. At the registrar add a `TXT` record with name `@` and that value, then press Verify. Then, under Sitemaps,
     submit `https://trikey.app/sitemap.xml`.
   - **Bing Webmaster Tools**: Import from Google Search Console (simplest, once Google is verified), or add the site
     and pick DNS verification: a `CNAME` record that Bing names. Then submit the same sitemap. Bing's index also feeds
     DuckDuckGo and others.
   - The verification records stay for as long as you use the tools; deleting them un-verifies the site.

`.app` is on the browsers' HSTS preload list, so every browser insists on HTTPS for `trikey.app`. Until the certificate exists, the site simply won't load. That's expected, not a misconfiguration.

## Fill in the passkey files

Both files are valid JSON with placeholders. Passkeys will not work until you
replace them. The background is in
[`apps/mobile/docs/passkeys.md`](../apps/mobile/docs/passkeys.md).

### `.well-known/apple-app-site-association`

Edit the line `"apps": ["TEAMID.app.trikey.wallet"]` and replace `TEAMID` with
your **Apple Team ID**: ten characters, found in the Apple Developer account
under Membership details. Keep the `.app.trikey.wallet` bundle id after it.

### `.well-known/assetlinks.json`

The file has one statement per Android app: Trikey (`app.trikey.wallet`) and Trikey FOSS
(`app.trikey.wallet.foss`, the build without Google code). Both are signed with the same release key. In each, edit
the line `"REPLACE_WITH_SHA256_FINGERPRINT"` and replace it with the SHA-256
fingerprint of the key that **signs the build the user installs**, in the form
`AA:BB:CC:...` (32 colon-separated bytes). To support several builds, add one
string per key to the `sha256_cert_fingerprints` array:

- **Google Play builds:** the *app signing key* certificate in Play Console,
  under Setup, then App signing.
- **Builds you sign yourself:** your upload or release keystore:
  `keytool -list -v -keystore <keystore> -alias <alias>`.
- **Development builds:** the debug keystore:
  `keytool -list -v -keystore ~/.android/debug.keystore -alias androiddebugkey -storepass android`.
- **EAS builds:** `eas credentials` shows the keystore's SHA-256 fingerprint.

### Check them once live

- **Apple.** Open `https://app-site-association.cdn-apple.com/a/v1/trikey.app`.
  It should show your `TEAMID.app.trikey.wallet` entry. Apple's CDN caches the
  file, so a change can take a while to appear.
- **Google.** Open
  `https://digitalassetlinks.googleapis.com/v1/statements:list?source.web.site=https://trikey.app&relation=delegate_permission/common.get_login_creds`.
  It should list both packages and the fingerprint.

Both files must be served over HTTPS with no redirect. The apex domain serves them directly; only `www` redirects.

`vercel.json` serves the extensionless `apple-app-site-association` file as `application/json`, which is the content type Apple expects.

## Housekeeping

- `security.txt` expires on **2027-10-29**. Move the `Expires` date forward at
  least once a year.
- The domain is the passkey relying party ID. Keep hosting these files for as
  long as backups made with passkeys exist; see the warning in
  `apps/mobile/docs/passkeys.md`.
- Fonts are Geist and Geist Mono from `@fontsource-variable/geist` and
  `@fontsource-variable/geist-mono`, under the SIL Open Font License 1.1
  (`fonts/OFL-*.txt`).
