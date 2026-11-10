# Signed releases: a manifest signed with Trikey's nostr key

Status: decided, not built. Written 2026-11-10, against `main` at 0.1.26.

Like Sparrow Wallet ([sparrowwallet.com/download](https://sparrowwallet.com/download/), read 2026-11-10: a manifest of
every file's SHA-256 and a PGP signature of it), each Trikey release gets a **manifest of its files, signed by a key
GitHub never holds**, and the pipeline **refuses to publish a release without that signature**.

## 1. The owner's decisions (2026-11-10)

1. **The key is Trikey's nostr publisher key**, the npub in `zapstore.yaml`
   (`npub1qussfnkjk6fvr36syatltxl0ks5pssyx7hrhf8zpnp9mf04e5j2sswedj9`), not a new PGP key. It is already public on the
   Zapstore listings, already kept off GitHub, and the app can already check its signatures (BIP 340, `@noble/curves`).
2. **No signature, no release.** `publish-release.yml` publishes a draft only when the manifest carries a valid
   signature by that key.

## 2. Why the key must never be a GitHub secret

The signature is worth something only because it comes from somewhere other than GitHub. Today everything that makes
a release lives there: the source, the workflows, the APK release key (the `release` environment), the `.sha256` files
and the release page. Whoever takes over the account or a workflow can make every one of them. A signing key stored as a
GitHub secret would join that list: the same takeover would sign its own release and the check would pass. It is
also the Zapstore publisher key, so it would publish to Zapstore as Trikey too.

So: **only the npub (public) is in the repository.** The secret key stays in the owner's signer app (Amber, nsec.app),
reached over NIP-46, the way `zsp` already signs Zapstore releases (docs/zapstore.md). The tool below never reads an
nsec and refuses one. docs/zapstore.md suggests keeping the nsec in a password manager; with this, an offline backup
(paper, or a password manager that is not synced) and the signer app for use is better, since this key now guards
every release.

## 3. What is signed

**The manifest**, `trikey-<tag>-SHA256SUMS`, in `sha256sum` format (so `sha256sum -c --ignore-missing` works on it),
one line per file of the release, in a fixed order:

```
<sha256>  trikey-alpha-<tag>.apk
<sha256>  trikey-alpha-foss-<tag>.apk
<sha256>  trikey-guardian-compose.yml
<sha256>  trikey-guardian.env.example
```

The guardian image is covered through the compose file, which pins it by digest (and the digest is the one
`reproducible.yml` rebuilt). The existing per-file `.sha256` files stay, for whoever uses them today.

CI makes the manifest from the files `packaging/check-release-assets.sh` checked, and attaches it to the draft.

**The signature**, `trikey-<tag>-SHA256SUMS.event.json`: a nostr event signed by the publisher key.

- `kind`: one regular kind reserved for this, used for nothing else (picked when it is built from the kinds no NIP
  assigns, and checked exactly), so a signature for a release can never pass for a note, a Zapstore event or anything a
  nostr app acts on.
- `tags`: `["x", "<sha256 of the manifest>"]` and `["version", "<tag>"]`.
- `content`: one line for people, `Trikey release <tag>: the files listed in trikey-<tag>-SHA256SUMS`.
- It is attached to the draft release. It is not published to relays (open question 2).

Anyone can check it with standard tools: `nak verify` on the event, the pubkey against the npub above, the `x` tag
against `sha256sum trikey-<tag>-SHA256SUMS`, then `sha256sum -c` on the manifest.

## 4. The release, step by step

Unchanged up to the draft (docs/releasing.md, section 4). Then:

1. The pipeline builds and checks every file as today and attaches the manifest to the draft.
2. **The owner signs**: `node tools/release/sign-release.mjs v0.1.27-alpha`. The tool downloads the manifest from the
   draft (`gh`), prints the files and their hashes and the tag, asks the signer app over NIP-46 (a `bunker://` URL,
   approved in Amber), checks the signature it gets back against the pinned npub, and uploads the event to the draft.
   Sign only once the pipeline's checks are green: the signature says "the owner released these exact files".
3. **The owner approves** the `release` environment, as today.
4. **`publish-release.yml` checks the signature** (below) and publishes. Without it, the job fails with the command to
   run; sign, then re-run the job.

## 5. The check that blocks publishing

In the `publish` job, before anything is published, next to `check-release-assets.sh` (which then expects the two new
files too):

- the event is well formed; its id is the hash of its serialized form; its BIP 340 signature is valid;
- its pubkey is the one in `packaging/release-signer.npub` (a test keeps it equal to `zapstore.yaml`'s);
- its kind is the reserved one, its `version` tag is the tag being published, its `x` tag is the SHA-256 of the
  manifest as attached;
- the manifest lists exactly the release's other files, in the fixed order, each with the hash of the file GitHub
  serves;
- the check runs again in the step that compares the published files after publishing, as the other checks do.

It runs in Node with `nostr-tools` (already a dependency), installed with `--ignore-scripts`. Changing the pinned key
is a pull request, so it is visible.

## 6. What it protects, and what it doesn't

| Attack | Before | With the signed manifest |
|---|---|---|
| A malicious workflow change, a compromised build dependency, a leaked `GITHUB_TOKEN` | Can get a release through the pipeline | Cannot: the pipeline won't publish without the owner's signature |
| The APK release key stolen from the `release` environment | Can sign APKs the pipeline publishes | Can still sign APKs, but the pipeline won't publish them unsigned |
| **Someone with the owner's GitHub account publishing a release by hand** (`gh release create`) | Nothing stops it | **Not stopped by the gate**, which is part of the pipeline the attacker skips. Caught only by whatever checks the signature: the app's update check (phase 3), Zapstore (already signed by this key), people following VERIFY.md |
| The publisher key stolen | (Zapstore only) | Not enough alone: the files must also get onto GitHub. Two separate compromises needed |
| The owner signs a bad release (malicious code merged unnoticed) | | Not stopped: the signature says who released it, not that the code is safe. Reproducible builds and other people's signatures (phase 4) address that |
| The signer device compromised | | Same as the key stolen |
| The key lost | | No release until the key is replaced: a PR changing the pinned npub (and the Zapstore listings move with it). The offline backup avoids that |

Immutable releases (the beta checklist, section 1) still matter: once published, nothing can swap the files under
the signature.

## 7. Plan

1. **This decision:** the manifest in CI, `tools/release/sign-release.mjs`, the check in `publish-release.yml`,
   `packaging/release-signer.npub` and its test, the steps in docs/releasing.md. A small PR.
2. **People can check it:** a "Check a release's signature" section in packaging/VERIFY.md.
3. **The app checks it** (a later decision): "Check for updates" offers an APK only when the release's manifest is
   signed by the npub built into the app and lists that APK's hash. This is what catches a release published by hand
   from a stolen GitHub account. A new key then needs an app release signed by the old one that names the new one.
4. **Others sign too**, once the APKs are reproducible (`android-reproducible.yml`, step 1 in PR #231): people who
   rebuild a release sign the same manifest, as Bitcoin Core's builders do
   ([guix.sigs](https://github.com/bitcoin/bitcoin/blob/master/contrib/verify-binaries/README.md)).

## 8. Open questions for the owner

1. **The event kind:** fine to pick a free regular kind when it is built, or should it go through a NIP?
2. **Publish the event to relays too?** It would leave a public, dated record GitHub cannot remove, and give the app
   (phase 3) a second channel for it. It would also show on the publisher's npub in clients that list every kind.
3. **The Umbrel store:** `umbrel-store.yml` updates the store after a release. Should it also refuse a release whose
   signature does not check, so the box gets nothing the owner did not sign?
4. **The per-file `.sha256` files:** keep them (as proposed) or drop them once the manifest is there?
