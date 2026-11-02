# Trikey on Zapstore

[Zapstore](https://zapstore.dev) is an Android app store built on nostr. Each listing and release is a nostr event
signed by the publisher, and the Zapstore app installs an update only when it comes from the same publisher and is
signed by the same APK key.

## For users

Install Zapstore (from zapstore.dev), search for **Trikey**, and install it. Updates then show up in Zapstore. The
listing's publisher is Trikey's own npub (below), and the APK is the same file as on the
[GitHub releases page](https://github.com/TheIcarusWings/trikey/releases), signed with the Trikey release key
(certificate SHA-256 in [`packaging/android/release-cert.sha256`](../packaging/android/release-cert.sha256)). An APK
from Zapstore, Obtainium or GitHub installs over the others and keeps the wallet.

Publisher npub: _not set up yet_.

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
4. Put the publisher npub on this page (it is public).

Releases after that need nothing: when the release workflow publishes a GitHub release with the APK, Zapstore
publishes it on its next visit. The proof expires after a while; `zsp` says when and renews it.

What it publishes: the standard APK (`trikey-alpha-v<version>.apk`, the `match` in `zapstore.yaml`), on Zapstore's
main channel although every Trikey release is still a GitHub pre-release (`prerelease_channel: main`), with that
version's changelog section as release notes.
