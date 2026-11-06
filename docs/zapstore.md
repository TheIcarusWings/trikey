# Trikey on Zapstore

[Zapstore](https://zapstore.dev) is an Android app store built on nostr. Each listing and release is a nostr event
signed by the publisher, and the Zapstore app installs an update only when it comes from the same publisher and is
signed by the same APK key.

## For users

Trikey is listed on Zapstore from 0.1.10-alpha. Install Zapstore (from zapstore.dev), search for **Trikey**, and install it. Updates then show up in Zapstore. The
listing's publisher is Trikey's own npub (below), and the APK is the same file as on the
[GitHub releases page](https://github.com/TheIcarusWings/trikey/releases), signed with the Trikey release key
(certificate SHA-256 in [`packaging/android/release-cert.sha256`](../packaging/android/release-cert.sha256)). An APK
of the same app from Zapstore, Obtainium or GitHub installs over the others and keeps the wallet.

There are two apps (from 0.1.21-alpha; [android-signing.md](android-signing.md), "Two APKs, two apps"): **Trikey**
(`app.trikey.wallet`, the standard build, with Google's libraries) and **Trikey FOSS** (`app.trikey.wallet.foss`, no
Google code). The **Trikey** listing has the standard app. **Trikey FOSS** gets its own listing once the maintainer has
published it (below); until then, take its APK from GitHub or Obtainium. Each app has its own wallet: to move one from
the other, restore your backup file and recovery code in the new app.

Publisher npub: `npub1qussfnkjk6fvr36syatltxl0ks5pssyx7hrhf8zpnp9mf04e5j2sswedj9`. Check it on the listing before installing. It is also
`trikey@trikey.app` (NIP-05, from [`site/.well-known/nostr.json`](../site/.well-known/nostr.json)), so nostr apps and Zapstore
show it verified by the trikey.app domain.

## For the maintainer: setting it up (once)

Nothing secret goes into the repository or into GitHub's secrets. [`zapstore.yaml`](../zapstore.yaml) at the
repository root describes the listing; Zapstore reads it and picks up each GitHub release by itself, once a proof
links the APK signing certificate to Trikey's publisher npub (NIP-C1).

1. **A nostr key just for Trikey**, not a personal one: make it in a nostr app or signer (Amber, nsec.app), give it a
   profile (name Trikey, the icon, website `https://trikey.app`), and keep its nsec in your password manager next to
   the APK key's backup.
2. **Install `zsp`** on your own computer, from [its releases](https://github.com/zapstore/zsp/releases) or with
   `go install github.com/zapstore/zsp/v2/cmd/zsp@latest`.
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

Releases after that need nothing: when the release workflow publishes a GitHub release with the APK, Zapstore
publishes it on its next visit. The proof expires after a while; `zsp` says when and renews it.

What it publishes: the standard APK (`trikey-alpha-v<version>.apk`, the `match` in `zapstore.yaml`), on Zapstore's
main channel although every Trikey release is still a GitHub pre-release (`prerelease_channel: main`), with that
version's changelog section as release notes.

## For the maintainer: the second listing, Trikey FOSS (once, after the first release with it)

Zapstore lists apps by application id, so Trikey FOSS (`app.trikey.wallet.foss`) is a listing of its own, beside Trikey's,
from the same repository, publisher npub and APK certificate. Its description is
[`packaging/zapstore/foss/zapstore.yaml`](../packaging/zapstore/foss/zapstore.yaml): the same as the root file but
`match` takes only the FOSS APK (`trikey-alpha-foss-v<version>.apk`), `release_filter` skips the releases up to
0.1.20-alpha (whose FOSS APK still had the standard app's id: publishing one would put it under the wrong app), and the
name, summary and description are Trikey FOSS's. zsp's wizard reads `./zapstore.yaml`, which is why the file is in a
folder of its own.

Run this on your own computer, after the release workflow has published the first release with the new id (0.1.21-alpha
or later) and both APKs are on its GitHub release page:

1. Update `zsp` (step 2 above) and check what Zapstore would publish; this reads only, it signs and uploads nothing:

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
   (or look at the listing in Zapstore): it should show the new version as published. If Zapstore did not pick it up by
   itself (its indexer may look only at the repository-root `zapstore.yaml`, which takes the standard APK), publish each
   release yourself, from the repository root, after the release workflow has attached the APKs:

   ```sh
   zsp publish packaging/zapstore/foss/zapstore.yaml
   ```

   and ask Zapstore (an issue on [zapstore/relay](https://github.com/zapstore/relay), with both app ids, the repository
   URL and the path of the second config) to track the second app. Nothing about Trikey's own listing changes.

Like the first listing, this needs no secret in the repository or in GitHub.
