# Android signing and updates

From **0.1.7-alpha**, every release APK is signed with the same key: the Trikey release key. Android installs an APK over
an installed app only when both have the same signature, so a new release now updates the app in place and the wallet on
the phone stays. Builds up to 0.1.6-alpha were signed with a one-off key each, so moving from one of those to 0.1.7-alpha
needs one last uninstall (which deletes the wallet on that phone: make a backup first).

Pull-request builds and manual runs of the **Android test APK** workflow on a branch still get a one-off key: they never see
the release key (their jobs are passed no secrets at all), and they cannot update a release build or be updated by one.

## Two APKs, two apps

From 0.1.9-alpha, every release has two APKs, built from the same code:

| APK | App (launcher label, application id) | What it is |
|---|---|---|
| `trikey-alpha-v<version>.apk` | **Trikey**, `app.trikey.wallet` | The **standard** build. It contains Google's libraries: Google Sign-In, for the Google Drive backup a later release can switch on (it needs Google Play services on the phone), Google's ML Kit to read QR codes, and the Google Play services provider for passkeys. |
| `trikey-alpha-foss-v<version>.apk` | **Trikey FOSS**, `app.trikey.wallet.foss` | **No Google code**, for phones without Google Play services (GrapheneOS, /e/OS, LineageOS) and for app stores that take only free software. QR codes are read by the open source zxing-cpp. There is no Google Drive backup: the backup is the recovery code plus the backup file, which you can still save to Google Drive, or anywhere else, by hand from the share sheet. Settings, About says "Trikey (no Google)". |

From 0.1.23-alpha they are **two apps**: each has its own application id (the FOSS one adds `.foss`), launcher label and
URL scheme (`trikey-foss://` for the FOSS app, so Trezor Suite Lite's answer reaches the app that asked). Both can be
installed on one phone and are listed separately (Zapstore, Obtainium). Both are signed with the same release key, and
each release updates the same app: the standard APK updates Trikey, the FOSS APK updates Trikey FOSS. Only a downgrade (an
older version) is refused. Each app keeps its own wallet: installing one does not move or copy the other's wallet;
restoring a backup does. The in-app **Check for updates** offers the APK of the app it runs in. The build of the FOSS APK
fails if any Google Play services, Firebase, ML Kit or Google data transport class, or ML Kit's `libbarhopper` library, is
in it (`apps/mobile/scripts/apk-google-scan.mts`).

Up to 0.1.21-alpha both APKs had the standard app's id (`app.trikey.wallet`), so one replaced the other.

### Moving from the no-Google APK of 0.1.21-alpha or earlier

That APK installed as `app.trikey.wallet`, the standard app's id. Android cannot turn an installed app into another
one, so the new FOSS APK does not update it: it installs as a second app, **Trikey FOSS**, which starts empty. Your
wallet is still in the old app (its launcher label is "Trikey"), and nothing has happened to it. Two ways on:

1. **Stay without Google (recommended for this build's users).** Have your backup ready: the recovery code and the
   backup file. If you are not sure you still have both, make a new backup in the old app first (Security tab, the
   backup row).
   1. Install `trikey-alpha-foss-v<version>.apk` (0.1.23-alpha or later). It appears next to the old app as Trikey FOSS.
   2. Open Trikey FOSS. Its first screen has "Used Trikey without Google before?", which says the same as this list.
      Tap **I already have a Trikey wallet**, then **My phone, but I have its backup**, open the backup file and enter
      the recovery code. A Recovery Key wallet: **I have a Recovery Kit**, with the kit and your hardware wallet.
   3. Check that Trikey FOSS shows your wallet and its balance, then uninstall the old app. Until then keep it: it still
      holds the wallet. Both hold the same phone key after the restore, so keeping both gives no extra safety, and only
      one should be in use.
2. **Switch to the standard build.** Install `trikey-alpha-v<version>.apk` over the old app: it has the same id, so it
   updates in place and keeps the wallet, now with Google's libraries.

The old app's **Check for updates** offers the new FOSS APK, which installs as the second app as in step 1. Obtainium
cannot install it over the old app either (the package differs): remove that entry and add the repository again with
the FOSS filter (below).

**Check the new app's signer before you restore into it.** An update of an installed app is checked by Android: it
refuses one that is not signed by the installed app's key. A *new* app has nothing to be compared with, so Android
installs it whoever signed it, and the old app's update sheet showed only a checksum from the same release (which
proves nothing about who made the file). So before step 1.2: install [AppVerifier](https://github.com/soupslurpr/AppVerifier)
(F-Droid or Accrescent), open it, pick **Trikey FOSS** (`app.trikey.wallet.foss`), and compare the SHA-256 it shows
with [the release key's](#the-release-keys-certificate). If they differ, uninstall Trikey FOSS and restore nothing.
From 0.1.23-alpha the app's update sheet shows the release certificate built into the app, and warns when an update
would install as a new app.

## The release key's certificate

Its SHA-256 is in [`packaging/android/release-cert.sha256`](../packaging/android/release-cert.sha256):
`C6:C4:6A:13:32:72:51:11:41:3A:7B:03:13:E2:F2:F3:7B:10:F0:CE:4C:8D:A1:CA:C3:C9:2D:17:9A:16:2D:A7`. The release build
refuses to publish an APK signed by anything else, each release's notes repeat it, and from 0.1.23-alpha the app has
it built in (`apps/mobile/src/lib/release-cert.ts`) and shows it in Settings, About, Check for updates. On the phone,
[AppVerifier](https://github.com/soupslurpr/AppVerifier) shows an installed app's certificate SHA-256. To check an APK
file on a computer (Android SDK build tools):

```sh
apksigner verify --print-certs trikey-alpha-v0.1.7-alpha.apk | grep 'SHA-256'
```

The digest it prints must equal the one in that file.

## Updates without downloading by hand

[Obtainium](https://github.com/ImranR98/Obtainium) watches a GitHub repository's releases and installs new APKs:

1. Install Obtainium (from its GitHub releases or F-Droid).
2. **Add app**, URL `https://github.com/TheIcarusWings/trikey`. Under the source options, turn on **Include prereleases**:
   every Trikey release is a pre-release for now.
3. Tell Obtainium which of the two apps you want: under **Filter APKs by regular expression**, enter
   - `^trikey-alpha-v.*\.apk$` for the standard app (Trikey), or
   - `^trikey-alpha-foss-v.*\.apk$` for the app without Google code (Trikey FOSS).

   Without a filter Obtainium asks which APK to install each time (or picks one), and the `.apk.sha256` files are not
   APKs, so they never match. The two are separate apps: to have both, add the repository twice, once with each filter.
   Changing the filter of an entry does not switch apps (Obtainium refuses an APK with another package); to move from
   one to the other, see "Moving from the no-Google APK" above: the wallet moves by restoring its backup.
4. Optionally, under **Verify the certificate**, paste the SHA-256 from `packaging/android/release-cert.sha256`, so
   Obtainium refuses an APK signed by another key. Android refuses such an update anyway. Both APKs have that certificate.

Obtainium then shows when a release is out, and installs it with one tap.

## For the maintainer: the key

The key lives only in two places: the `release` environment's secrets (or, until they are moved there, the repository's
Actions secrets), for the build, and the maintainer's own backup. Neither the repository nor any artifact or log ever
contains it.

- **Losing it** means no release can update an installed app again: every tester would have to uninstall once more.
  Keep the `.p12` file and its password backed up (a password manager, plus an offline copy).
- **Leaking it** lets someone sign an APK that Android would accept as an update of Trikey. They would still need the
  user to install it, but treat a leak as serious: make a new key, tell testers, and change the pinned certificate.

### Making it (once, on a Mac or Linux)

```sh
mkdir -p ~/trikey-signing && cd ~/trikey-signing && umask 077
openssl req -x509 -newkey rsa:4096 -sha256 -days 10950 -nodes \
  -keyout key.pem -out cert.pem -subj "/CN=Trikey release/O=Trikey"
openssl pkcs12 -export -inkey key.pem -in cert.pem -name trikey -out trikey-release.p12 \
  -certpbe PBE-SHA1-3DES -keypbe PBE-SHA1-3DES -macalg sha1
rm key.pem
openssl x509 -in cert.pem -noout -fingerprint -sha256
```

The `pkcs12` step asks for a password twice: use a long random one and keep it in your password manager. The last line
prints the certificate's SHA-256: that goes in `packaging/android/release-cert.sha256`. It is public, so it can be in the
repository. Back up `trikey-release.p12` (and the password) before anything else.

### Giving it to the build

The secrets:

| Name | Value |
| --- | --- |
| `ANDROID_RELEASE_KEYSTORE` | the `.p12` file in base64: `base64 -i trikey-release.p12 \| pbcopy` on a Mac copies it (Linux: `base64 -w0 trikey-release.p12`) |
| `ANDROID_RELEASE_KEYSTORE_PASSWORD` | the password |
| `ANDROID_RELEASE_KEY_ALIAS` | optional; only if the key's alias is not `trikey` |

They belong in the `release` environment (next section). Repository secrets of the same names (**Settings → Secrets and
variables → Actions → New repository secret**) also work, and are where they were before the environment existed.

Only a release tag's signing job reads them. `.github/workflows/android-apk.yml` passes them only from its `apk-release`
job, which runs only on a `v*` tag; a run on a branch goes through a separate job with no secrets. In
`.github/workflows/android-build.yml` the build job (npm, Expo, Gradle) never sees them: it hands the APK to a separate
`sign` job, which declares `environment: release`, runs no build code, decodes the keystore into the runner's temporary
folder, signs (`packaging/android/sign-apk.sh`), deletes it, and checks the APK's certificate against
`packaging/android/release-cert.sha256`. The release job checks both APKs' certificates against that file once more
before it uploads anything.

These are not the SSH or GPG keys on a GitHub account: those sign commits and log in to GitHub. An Android app is signed
with its own key, made as above.

## How a release is published

`release.yml` creates the tag and a **draft** release. The builds attach their files to the draft: both APKs and their
`.sha256` (`android-apk.yml`), and the compose files with the guardian image pinned by digest (`docker.yml`). A draft is
invisible outside the repository: GitHub's public API does not list it, so Obtainium, Zapstore and the app's **Check for
updates** do not see it, nor does anyone on the releases page. Last, `publish-release.yml` waits for the builds, then,
in the `release` environment, checks the draft (`packaging/check-release-assets.sh`): exactly the expected files, each
the one GitHub lists, the checksums, both APKs signed by the pinned certificate and nothing else and each the right
app, and the compose file running the image by the digest `docker.yml` pushed. Only then does it publish the release.

If a release stays a draft, the Publish release run says why. Fix that (re-run the failed build), then re-run Publish
release. Do not publish a draft by hand: that skips the checks.

### Immutable releases

A token with `contents: write` (every release job has one, and so could a workflow edited on a branch) can replace a
published release's files, unless the repository makes releases immutable. With it on, a published release's files and
its tag cannot be changed or deleted by anyone; only a draft can still change, which is why the files are checked
right before the draft is published. **The owner turns it on once:** the repository → **Settings → General**, scroll to
**Releases**, tick **Enable release immutability**, and save. Releases published before stay as they were; every one
after is immutable. The Publish release run says "is immutable" on success, and warns "Release is not immutable" while
the setting is off.

## The `release` environment

Everything that publishes or signs runs in a GitHub environment named `release`: the `sign` job of
`android-build.yml` (the Android release key), the `publish` job of `docker.yml` (the only job that can push the guardian
image to GHCR), the `publish` job of `umbrel-store.yml` (`UMBREL_STORE_TOKEN`) and the `publish` job of
`publish-release.yml` (which makes the GitHub release public). Those jobs also refuse to run on
anything but a `v*` tag ref, but that is a line in a workflow file, which anyone who can push a branch can edit. The
environment is the part a workflow file cannot change: its secrets reach only jobs that name it, and its rule decides
which refs those jobs may run on.

**Before the owner sets it up**, GitHub creates `release` by itself the first time a job names it, with no protection
rules (GitHub's documented behaviour for an environment that does not exist yet). Such a job still gets the repository
secrets, so releases keep working exactly as before; the environment only starts protecting anything once the steps
below are done.

**Setting it up (the repository owner, once):**

1. On GitHub, open the repository, then **Settings → Environments**. If `release` is already listed (made by a release
   run), click it; otherwise click **New environment**, type `release`, and click **Configure environment**.
2. Under **Deployment branches and tags**, change **No restriction** to **Selected branches and tags**. Click **Add
   deployment branch or tag rule**, set **Ref type** to **Tag**, type `v*` as the name pattern, and click **Add rule**.
   No branch rule: no branch may deploy to `release`.
3. Optional but recommended: tick **Required reviewers**, add yourself, and click **Save protection rules**. Every
   release then waits for your approval before it signs or publishes (Actions shows *Review deployments* on the run;
   docker.yml, each of the two Android signing jobs, the Umbrel store job (only when `UMBREL_STORE_AUTOPUBLISH` is set,
   packaging/README.md) and Publish release ask, so approve all waiting
   jobs; the last one, Publish release, comes once the draft release has every file and they are checked). This is
   what stops someone with only write access (a stolen token, a misbehaving automation) from releasing by pushing a
   `v*` tag. Leave **Allow administrators to bypass configured protection rules** off if you want the rule to bind you
   too.
4. Under **Environment secrets**, click **Add environment secret** for each of `ANDROID_RELEASE_KEYSTORE`,
   `ANDROID_RELEASE_KEYSTORE_PASSWORD`, `ANDROID_RELEASE_KEY_ALIAS` (if you use it) and `UMBREL_STORE_TOKEN`, with the same
   values as the repository secrets (from your backup and password manager: GitHub never shows a secret's value again).
5. Release once (or re-run the last release's builds with `release.yml`, *redispatch*) and check that the APKs are
   signed and the image and the Umbrel store are published.
6. Then delete the repository copies: **Settings → Secrets and variables → Actions → Repository secrets**, the bin icon
   next to `ANDROID_RELEASE_KEYSTORE`, `ANDROID_RELEASE_KEYSTORE_PASSWORD`, `ANDROID_RELEASE_KEY_ALIAS` and
   `UMBREL_STORE_TOKEN`. From now on a workflow on any other ref, edited or not, cannot read them.

Where an environment secret and a repository secret have the same name, the job in the environment gets the
environment's. Optional, further:

- **The image** (recommended; the release run warns "Image pushed with GITHUB_TOKEN" until it is done). Without it,
  `packages: write` comes from GITHUB_TOKEN, which any workflow file on any branch can ask for: a workflow pushed to a
  branch could push its own image over `ghcr.io/theicaruswings/trikey-guardian:<version>`. Nothing this repository
  ships names the image by that tag alone (the release's compose file, the Umbrel store and the Start9 package all use
  the digest the release pushed), but people who type the tag would get it. To close it, in this order, so no release
  breaks in between:
  1. Make the token. GitHub, your avatar → **Settings → Developer settings → Personal access tokens → Tokens
     (classic) → Generate new token → Generate new token (classic)**. Note `trikey GHCR push`; **Expiration**: a date
     you will remember (a year), and put a reminder in your calendar: once it expires, releases stop at "Log in to
     GHCR" until you replace it. Tick **only** `write:packages` (GitHub ticks `read:packages` with it). **Generate
     token**, and copy it. GHCR does not take fine-grained tokens; this classic one can write every package of your
     account, so it goes nowhere but the `release` environment.
  2. Store it. This repository → **Settings → Environments → release → Environment secrets → Add environment
     secret**: name `GHCR_PUSH_TOKEN`, value the token, **Add secret**. Not a repository secret: only the `release`
     environment's jobs, on `v*` tags, can read it.
  3. Release once (or run **Actions → Release → Run workflow**, *redispatch* ticked, on `main`). The Docker run's
     `publish` job now says "Pushing with GHCR_PUSH_TOKEN" and has no "Image pushed with GITHUB_TOKEN" warning.
  4. Take write access away from the repository's GITHUB_TOKEN. Your avatar → **Your profile → Packages →
     trikey-guardian → Package settings** (right-hand column). Under **Manage Actions access**: if **Inherit access
     from source repository (recommended)** is ticked, untick it (with it, every workflow of this repository inherits
     write access). Then, in the same list, set the role of `TheIcarusWings/trikey` to **Read** (if it is not
     listed: **Add Repository**, pick it, role **Read**). Leave **Manage access** (people) as it is.
  5. Check: the next release's `publish` job pushes with the token as in step 3. A branch workflow that tries to push
     now gets `denied: permission_denied: write_package`.

  `docker.yml` pushes with `GHCR_PUSH_TOKEN` when it is set, and with GITHUB_TOKEN (and the warning) otherwise. To undo,
  delete the secret and set the repository's role back to **Write** first.
- **Tags.** A `v*` tag is what the rule lets through, and anyone with write access can push one. Required reviewers
  (step 3) is the guard against that. A tag ruleset (**Settings → Rules → Rulesets → New ruleset → New tag ruleset**,
  target `v*`, *Restrict creations*) can also limit who creates them, but `release.yml` creates the tag with
  GITHUB_TOKEN: check that a ruleset you add still lets it, or create release tags by hand.
