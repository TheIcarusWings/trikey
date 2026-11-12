# Trikey on Zapstore

[Zapstore](https://zapstore.dev) is an Android app store built on nostr. Each listing and release is a nostr event
signed by the publisher, and the Zapstore app installs an update only when it comes from the same publisher and is
signed by the same APK key.

## For users

Trikey is listed on Zapstore from 0.1.10-alpha, and Trikey FOSS from 0.1.24-alpha. Install Zapstore (from zapstore.dev), search for **Trikey**, and install the one you want. Updates then show up in Zapstore. The
listing's publisher is the founder's npub (below), and the APK is the same file as on the
[GitHub releases page](https://github.com/TheIcarusWings/trikey/releases), signed with the Trikey release key
(certificate SHA-256 in [`packaging/android/release-cert.sha256`](../packaging/android/release-cert.sha256)). An APK
of the same app from Zapstore, Obtainium or GitHub installs over the others and keeps the wallet.

There are two apps (from 0.1.23-alpha; [android-signing.md](android-signing.md), "Two APKs, two apps"): **Trikey**
(`app.trikey.wallet`, the standard build, with Google's libraries) and **Trikey FOSS** (`app.trikey.wallet.foss`, no
Google code). The **Trikey** listing has the standard app; **Trikey FOSS** has a listing of its own. Each app has its own wallet: to move one from
the other, restore your backup file and recovery code in the new app.

Publisher npub, from 0.1.28-alpha: Icarus Wings, the founder, `npub19tzp8lf3klmqj3dz9mz0qnuvjp7uyy9993gmljmyaxs8phztj7wsnujvq5`
(`icaruswings@trikey.app`, and `trikey@trikey.app` from [`site/.well-known/nostr.json`](../site/.well-known/nostr.json), so
nostr apps and Zapstore show it verified by the trikey.app domain). Check it on the listing before installing.

Up to 0.1.27-alpha the releases were published by Trikey's own npub (`npub1qussfnkjk6fvr36syatltxl0ks5pssyx7hrhf8zpnp9mf04e5j2sswedj9`),
now retired. Zapstore keeps one listing per app, tied to the APK signing certificate, so the listing stays the same and
installed apps keep updating; nothing to reinstall. Moving that certificate's link (NIP-C1 proof) from the old key to
the new one is being settled with Zapstore (zapstore/relay#16), and until it is, a release can reach Zapstore later
than GitHub. Why and how the key moved: [design/publisher-key-switch.md](design/publisher-key-switch.md).

## For the maintainer: setting it up (once)

Nothing secret goes into the repository or into GitHub's secrets. [`zapstore.yaml`](../zapstore.yaml) at the
repository root describes the listing; Zapstore reads it and picks up each GitHub release by itself, once a proof
links the APK signing certificate to the publisher npub (NIP-C1).

1. **The publisher key**: from 0.1.28-alpha the founder's own npub (design/publisher-key-switch.md; until then a key
   just for Trikey). The same key signs every GitHub release's manifest
   (docs/design/signed-releases.md, `tools/release/sign-release.mjs`), so guard it like the APK key: use it only
   through the signer app (a `bunker://` URL), and keep its one backup offline (on paper, or in a password manager that
   does not sync), never on GitHub or in a file on the computer you build from.
2. **Install `zsp`** on your own computer, at the version named here and no other:

   ```sh
   go install github.com/zapstore/zsp/v2/cmd/zsp@v2.0.1
   ```

   Go checks the download against its public checksum database (`go.sum` line
   `github.com/zapstore/zsp/v2 v2.0.1 h1:Md7GkOXv3t4B64PMjRpOa4hH1ruhi8kjEaDVZZV+soE=`), so this is the code everyone
   else gets for v2.0.1. **Why pinned:** zsp is handed the Android release keystore, its password and a live session
   with the publisher signer. Whoever can publish a new zsp version (a taken-over account or a bad merge upstream) would
   get the key that signs every Trikey APK; `@latest` would install that version without anyone looking. To move to a
   newer zsp, read its changes since the pinned version, then change the version and the `h1:` hash here in a pull
   request (security sweep 2). Up to 0.1.23 these steps said `@latest`.
3. **Run `zsp` in a checkout of this repository** and follow the wizard. It asks for the signer (a `bunker://` URL
   from your signer app is safer than pasting the nsec) and for the release keystore (`trikey-release.p12` and its
   password) to prove the certificate is yours. The keystore and the key never leave your computer. When it asks how
   new releases get published, choose to let **Zapstore keep Trikey up to date**.
   Keep the signer app in front while the wizard runs: with Amber in the background the wizard stops with
   `connect to bunker: context deadline exceeded` (nothing is changed; run it again). Commit the `zapstore.yaml` it
   writes, so the repository's copy (which Zapstore reads) matches what the wizard used.
4. **A new publisher key must be admitted by Zapstore first.** Until then the wizard stops at the first upload with
   `blob upload rejected: upload icon: status 403: authenticated pubkey is not allowed`, and nothing is published.
   Zapstore's relay admits an uploader that is on its whitelist, has enough Vertex reputation (follows from
   established nostr accounts), or already has an app listed. Since October 2026 it no longer reads `zapstore.yaml`
   for this: the `pubkey:` line there is harmless but does not admit the key (zsp ignores it), so older Zapstore docs
   that say otherwise are out of date. To ask, open an issue on [zapstore/relay](https://github.com/zapstore/relay)
   with the publisher npub, the repository URL and the APK certificate SHA-256
   (`packaging/android/release-cert.sha256`), then run `zsp` again once the key is admitted.
5. The publisher npub is on this page (it is public).

Releases after that should need nothing: when the release workflow publishes a GitHub release with the APK, Zapstore
is meant to publish it on its next visit. The proof expires after a while; `zsp` says when and renews it.

It did not pick releases up by itself here: the listing stayed at 0.1.10, then at 0.1.24 and 0.1.25, until they were
published by hand (zapstore/relay#16). Up to 0.1.25-alpha every Trikey GitHub release was a **pre-release**, the likely
reason. Since then the release workflow publishes normal releases, marked latest (the version still ends in `-alpha`,
and the notes, the app and the site still say pre-alpha; [android-signing.md](android-signing.md), "How a release is
published").

**Check it after each release.** The **Zapstore check** workflow (`.github/workflows/zapstore-check.yml`) does it for
you: Publish release dispatches it once the GitHub release is public. It asks Zapstore's relay (`wss://relay.zapstore.dev`,
read only, no key or secret) every 10 minutes, for about three hours, for the release events (kind 30063) whose `d` tag
is `app.trikey.wallet@<version>` and `app.trikey.wallet.foss@<version>` (`.github/scripts/zapstore-published.mjs`), by
any author: one Zapstore publishes by itself may be signed by Zapstore's own key rather than the publisher npub above
(zsp: "shown as developed by you"). An event by the publisher npub is preferred; one only by another key counts too,
and the run shows a **Zapstore signer** notice naming that key. If both are there, the run succeeds and logs their
event ids. If not, it
opens an issue titled `Zapstore hasn't picked up v<version>` (one per version: not a second while one is open) that
says which app is missing, and the run fails.

**When it opens that issue**, publish the release yourself, from the repository root of an up-to-date checkout of main,
with the same signer (only the line of the app the issue names, or both):

```sh
git switch main && git pull
zsp publish zapstore.yaml                            # Trikey
zsp publish packaging/zapstore/foss/zapstore.yaml    # Trikey FOSS
```

Then run the check again (Actions, **Zapstore check**, Run workflow, version `0.1.26-alpha` without the `v`); when it
succeeds, close the issue. If Zapstore keeps lagging, tell them on [zapstore/relay](https://github.com/zapstore/relay).
You can also look by hand: `zsp check zapstore.yaml` (read-only) shows the version Zapstore has published
(`published_version_code`) next to the newest release it finds.

What it publishes: the standard APK (`trikey-alpha-v<version>.apk`, the `match` in `zapstore.yaml`), on Zapstore's
main channel (`prerelease_channel: main`, so the older releases, which are GitHub pre-releases, go there too), with
that version's changelog section as release notes.

## For the maintainer: the second listing, Trikey FOSS (once, after the first release with it)

Zapstore lists apps by application id, so Trikey FOSS (`app.trikey.wallet.foss`) is a listing of its own, beside Trikey's,
from the same repository, publisher npub and APK certificate. Its description is
[`packaging/zapstore/foss/zapstore.yaml`](../packaging/zapstore/foss/zapstore.yaml): the same as the root file but
`match` takes only the FOSS APK (`trikey-alpha-foss-v<version>.apk`), `release_filter` skips the releases up to
0.1.21-alpha (whose FOSS APK still had the standard app's id: publishing one would put it under the wrong app), and the
name, summary and description are Trikey FOSS's. zsp's wizard reads `./zapstore.yaml`, which is why the file is in a
folder of its own. zsp reads local files only from inside the config's folder, so that file names its icon and the
changelog by URL (this repository's main branch), not by a `../` path, which zsp refuses with "outside the base
directory". `zsp check` does not load the icon, so only `zsp publish` (or the wizard) would show such an error.

Run this on your own computer, after the release workflow has published the first release with the new id (0.1.23-alpha
or later) and both APKs are on its GitHub release page:

1. Install `zsp` at the version step 2 above pins (`zsp --version`) and check what Zapstore would publish; this reads only, it signs and uploads nothing:

   ```sh
   cd <your checkout of the repository>
   git pull
   zsp check packaging/zapstore/foss/zapstore.yaml
   ```

   It must find `trikey-alpha-foss-v<version>.apk` with app id `app.trikey.wallet.foss` and the certificate in
   `packaging/android/release-cert.sha256`, say the app is not listed yet, and find Trikey's proof for that certificate
   (the same key signs both apps, so the proof made for Trikey covers it).
2. Publish the first release, which creates the listing:

   ```sh
   cd packaging/zapstore/foss
   zsp
   ```

   The wizard says `Using the local zapstore.yaml (...)` and `Found Trikey FOSS (v<version>)`. It finds the existing
   proof (`... is claimed by npub1qussfn...`); have the keystore (`trikey-release.p12`) at hand anyway, in case the proof
   is due for renewal. It asks for the signer (the same `bunker://` from Amber or nsec.app as for Trikey; keep the
   signer app in front). Choose **Publish now**, check the
   preview page it opens (name Trikey FOSS, app id `app.trikey.wallet.foss`, the Trikey icon), and approve. When it asks
   how new releases reach Zapstore, choose **Let Zapstore publish them for you**. It may say it wrote or changed
   `zapstore.yaml` in that folder: do not commit a change that drops `match` or `release_filter`; send any other change
   as a pull request.
3. Check the next release. After the next GitHub release, run `zsp check packaging/zapstore/foss/zapstore.yaml` again
   (or look at the listing in Zapstore, or at the Zapstore check run): it should show the new version as published. If Zapstore did not pick it up by
   itself (its indexer may look only at the repository-root `zapstore.yaml`, which takes the standard APK), publish each
   release yourself, from the repository root, after the release workflow has attached the APKs:

   ```sh
   zsp publish packaging/zapstore/foss/zapstore.yaml
   ```

   and ask Zapstore (an issue on [zapstore/relay](https://github.com/zapstore/relay), with both app ids, the repository
   URL and the path of the second config) to track the second app. Nothing about Trikey's own listing changes.

Like the first listing, this needs no secret in the repository or in GitHub.
