# trikey.app

The project website and the domain verification files the mobile app needs.
Plain HTML and CSS with one small script of our own (`js/story.js`): no build step,
no framework, no tracking and no requests to other sites (a strict
`Content-Security-Policy` meta tag enforces this). The script turns the film
scenes into pinned scroll scenes; without it, or with reduced motion, the page is
a plain stack of cards and reads the same.

| Path | What it is |
|---|---|
| `index.html`, `style.css` | The landing page |
| `media/films/` | The launch films for the web: "Nobody in the middle" in the hero and the three "If a key goes missing" episodes in the key picker. 720p H.264 with the voiceover, captions burned in, a poster and a WebVTT file each (about 12 MB in all). Nothing loads until someone presses play |
| `js/story.js` | Scroll scenes: sticky stages, shot timing, video scrubbing. Progressive enhancement only |
| `404.html` | Not-found page (Vercel serves it automatically) |
| `img/` | Phone screenshots, rendered from `design/screens` (light and dark WebP) |
| `media/` | Photos (WebP) and three short muted video loops (H.264 MP4, under 1 MB each) taken from the launch film footage, plus one generated still of the three keys. Loops are hidden for people who prefer reduced motion; the poster image stays. |
| `fonts/` | Geist and Geist Mono (latin, variable `woff2`) with their OFL license texts |
| `favicon.svg` | The logo |
| `vercel.json` | Response headers: `application/json` for the Apple file, HSTS and other security headers |
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

The site is hosted on **Vercel**, deployed from this GitHub repository:

- every push to `main` that changes `site/` deploys to production at `https://trikey.app`;
- pull requests get a preview deployment.

`site/` has no build step. Vercel serves it as static files and applies the headers in `vercel.json`.

Before Vercel deploys, `.github/workflows/site.yml` runs these checks on pushes and pull requests that touch `site/`:

- both `.well-known` JSON files and `vercel.json` must parse;
- `index.html` must not have any `src` or `href` pointing at an `http(s)://` address other than `github.com` and `trikey.app`.

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
