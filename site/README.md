# trikey.app

The project website and the domain verification files the mobile app needs.
Plain HTML and CSS: no build step, no framework, no JavaScript, and no requests
to other sites (a strict `Content-Security-Policy` meta tag enforces this).

| Path | What it is |
|---|---|
| `index.html`, `style.css` | The landing page |
| `404.html` | Not-found page (GitHub Pages serves it automatically) |
| `img/` | Phone screenshots, rendered from `design/screens` (light and dark WebP) |
| `fonts/` | Geist and Geist Mono (latin, variable `woff2`) with their OFL license texts |
| `favicon.svg` | The logo |
| `CNAME` | Custom domain for GitHub Pages: `trikey.app` |
| `.nojekyll` | Turns off Jekyll, so dot-directories are served as they are |
| `.well-known/apple-app-site-association` | iOS: passkeys for `app.trikey.wallet` (needs a Team ID) |
| `.well-known/assetlinks.json` | Android: passkeys for `app.trikey.wallet` (needs a signing fingerprint) |
| `.well-known/security.txt` | RFC 9116 contact, points to the repo's private security advisories |

## Preview locally

```sh
npx serve site
# or
python3 -m http.server -d site
```

Then open the address it prints.

## Deployment

`.github/workflows/pages.yml` deploys `site/` with GitHub Pages. It runs on
pushes to `main` that change `site/**` or the workflow itself, and by hand
from the Actions tab (`workflow_dispatch`).

Before uploading, the workflow checks that:

- both `.well-known` JSON files parse;
- `index.html` has no `src` or `href` pointing at an `http(s)://` address other
  than `github.com` and `trikey.app`.

Then it uploads `site/` (with hidden files included, because `.well-known` and
`.nojekyll` start with a dot) and deploys it to the `github-pages` environment.

## One-time setup (repository owner)

1. **Pages source.** In the repository, go to Settings, then Pages, and set
   Source to **GitHub Actions**.
2. **Custom domain.** In the same page, set the custom domain to `trikey.app`.
   The `CNAME` file in `site/` records it. Once the certificate is issued, tick
   **Enforce HTTPS**.
3. **DNS at the registrar**, for the apex domain `trikey.app`:

   | Type | Name | Value |
   |---|---|---|
   | A | `@` | `185.199.108.153` |
   | A | `@` | `185.199.109.153` |
   | A | `@` | `185.199.110.153` |
   | A | `@` | `185.199.111.153` |
   | AAAA | `@` | `2606:50c0:8000::153` |
   | AAAA | `@` | `2606:50c0:8001::153` |
   | AAAA | `@` | `2606:50c0:8002::153` |
   | AAAA | `@` | `2606:50c0:8003::153` |

   Optionally add `www` as a CNAME to `theicaruswings.github.io`. GitHub then
   redirects `www.trikey.app` to the apex.
4. **Verify the domain.** In the GitHub account's settings (Settings, Pages,
   Add a domain), verify `trikey.app` by adding the TXT record GitHub shows. This
   stops anyone else from claiming the domain on GitHub Pages if the repo's
   Pages setup is ever removed.
5. **First deploy.** Run the "Pages" workflow from the Actions tab, or push a
   change under `site/` to `main`.

`.app` is on the browsers' HSTS preload list, so every browser insists on HTTPS
for `trikey.app`. Until GitHub has issued the certificate (this can take up to an
hour or so after DNS resolves, sometimes longer) the site simply won't load.
That is expected, not a misconfiguration.

## Fill in the passkey files

Both files are valid JSON with placeholders. Passkeys will not work until you
replace them. The background is in
[`apps/mobile/docs/passkeys.md`](../apps/mobile/docs/passkeys.md).

### `.well-known/apple-app-site-association`

Edit the line `"apps": ["TEAMID.app.trikey.wallet"]` and replace `TEAMID` with
your **Apple Team ID**: ten characters, found in the Apple Developer account
under Membership details. Keep the `.app.trikey.wallet` bundle id after it.

### `.well-known/assetlinks.json`

Edit the line `"REPLACE_WITH_SHA256_FINGERPRINT"` and replace it with the SHA-256
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
  It should list your package and fingerprint.

Both files must be served over HTTPS with no redirect. Pages serves the apex
domain directly, so that holds for `https://trikey.app/.well-known/...`.

> **Known caveat: content type.** GitHub Pages serves the extensionless
> `apple-app-site-association` file as `application/octet-stream`, not
> `application/json`, and there is no way to set headers on Pages. Apple's CDN
> generally accepts it, because it parses the body. If passkeys fail on iOS with
> `bad-configuration`, check this first: if the CDN URL above returns nothing,
> the host will have to serve the file with the right type (a small proxy or
> a different static host).

## Housekeeping

- `security.txt` expires on **2027-10-29**. Move the `Expires` date forward at
  least once a year.
- The domain is the passkey relying party ID. Keep hosting these files for as
  long as backups made with passkeys exist; see the warning in
  `apps/mobile/docs/passkeys.md`.
- Fonts are Geist and Geist Mono from `@fontsource-variable/geist` and
  `@fontsource-variable/geist-mono`, under the SIL Open Font License 1.1
  (`fonts/OFL-*.txt`).
