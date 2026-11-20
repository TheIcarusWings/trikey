# Signed releases: a manifest signed with Trikey's nostr key

Status: decided and built (2026-11-10), against `main` at 0.1.26. The first release it applies to is the first after
0.1.26-alpha.

Like Sparrow Wallet ([sparrowwallet.com/download](https://sparrowwallet.com/download/), read 2026-11-10: a manifest of
every file's SHA-256 and a PGP signature of it), each Trikey release gets a **manifest of its files, signed by a key
GitHub never holds**, and the pipeline **refuses to publish a release without that signature**.

## 1. The owner's decisions (2026-11-10)

1. **The key is Trikey's nostr publisher key**, the npub in `zapstore.yaml`
   (`npub1qussfnkjk6fvr36syatltxl0ks5pssyx7hrhf8zpnp9mf04e5j2sswedj9` up to 0.1.27-alpha; from 0.1.28-alpha the founder's
   `npub19tzp8lf3klmqj3dz9mz0qnuvjp7uyy9993gmljmyaxs8phztj7wsnujvq5`, publisher-key-switch.md), not a new PGP key. It is already public on the
   Zapstore listings, already kept off GitHub, and the app can already check its signatures (BIP 340, `@noble/curves`).
2. **No signature, no release.** `publish-release.yml` publishes a draft only when the manifest carries a valid
   signature by that key.
3. **The event kind is 1420**, a free kind (section 3).
4. **The signature event is published to relays too**, as a public, dated record GitHub cannot remove (section 4).
5. **The Umbrel store is gated too**: it gets a version only after its signature checks (section 5).
6. **The per-file `.sha256` files stay** next to the manifest (section 3).

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

**The manifest**, `trikey-<tag>-SHA256SUMS`, in `sha256sum` format (so `sha256sum -c` works on it): one
`<sha256>  <name>` line for **every other file of the release**, sorted by name. Today that is the two APKs and their
`.sha256` files, the compose file, the settings file and `trikey-guardian-compose.sha256`: every file anyone downloads
is covered, and a file added to or missing from the release breaks the signature.

The guardian image is covered through the compose file, which pins it by digest (and the digest is the one
`reproducible.yml` rebuilt). The existing per-file `.sha256` files stay (the owner's decision), for whoever uses them today; the manifest
lists them too, so they are signed like everything else.

**The owner's signing tool makes the manifest** (`tools/release/sign-release.mjs`, through
`packaging/release-signature.py manifest`), from the draft's files it downloads, so the hashes the owner signs are
computed on the owner's own computer; the checks make it again from the files they download and compare byte for byte.
(The first version of this note had CI make it. Making it where it is signed is simpler, and needs no CI job with
write access.)

**The signature**, `trikey-<tag>-SHA256SUMS.event.json`: a nostr event signed by the publisher key.

- `kind`: **1420**, a regular kind (stored by relays) that no NIP assigns (the kinds list in
  [nostr-protocol/nips](https://github.com/nostr-protocol/nips/blob/master/README.md), read 2026-11-10, goes from 1337
  to 1617; it is not one of Zapstore's either), and an echo of Trikey's RPC kind 21420. Used for nothing else and checked
  exactly, so a signature for a release can never pass for a note, a Zapstore event or anything a nostr app acts on. If
  a NIP ever assigns 1420, the check keeps accepting it only with this exact form (tags, content line, pubkey).
- `tags`: `["x", "<sha256 of the manifest>"]` and `["version", "<tag>"]`.
- `content`: one line for people, `Trikey release <tag>: the files listed in trikey-<tag>-SHA256SUMS`.
- It is attached to the draft release, which is what the checks read, **and published to relays** (section 4).

Anyone can check it with standard tools: `nak verify` on the event, the pubkey against the npub above, the `x` tag
against `sha256sum trikey-<tag>-SHA256SUMS`, then `sha256sum -c` on the manifest.

## 4. The release, step by step

Unchanged up to the draft (docs/releasing.md, section 4). Then:

1. The pipeline builds and checks every file as today and attaches them to the draft.
2. **The owner signs**: `node tools/release/sign-release.mjs v0.1.27-alpha`. The tool downloads every file of the
   draft (`gh`), makes the manifest, prints it, asks for the tag to be typed back, asks the signer app over NIP-46 (a
   `bunker://` URL, approved in Amber; the tool refuses an nsec), checks that the signer's key is the pinned one and
   that the result passes the very check `publish-release.yml` runs, and uploads the manifest and the event to the
   draft (never replacing a file there).
   Sign only once the pipeline's checks are green: the signature says "the owner released these exact files".
   It then **publishes the event to relays**: the relays in the publisher npub's relay list (kind 10002) if it has
   one, else relay.damus.io, nos.lol and relay.primal.net, and says which accepted it. relay.trikey.app stores only
   kinds 1059 and 24133 today; to keep the events there too, 1420 joins its allowlist (its configuration is not in this
   repository). Publishing is a record, not part of the gate: relays may be down or drop events, so the checks read the
   file attached to the release. Anyone can find every Trikey release signature with a filter
   `{"kinds": [1420], "authors": ["<the publisher's hex key>"]}`, and a release whose signature is missing there is a
   reason to ask why. Being published also means clients that list every kind may show these events on the publisher
   npub's profile; the content line says what they are.
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
- the manifest lists exactly the release's other files, sorted by name, each with the hash of the file GitHub serves
  (and `check-release-assets.sh` already checks each download against the digest GitHub lists);
- the event has exactly a nostr event's fields, nothing else, and was made no earlier than 2026-11-10 and at most an
  hour ahead of the checker's clock;
- the step that compares the published files with the checked ones, right after publishing, covers the manifest and
  the event like every other file.

An unsigned draft fails first, with its own message: the command to sign it.

It runs in **Python with the standard library only** (`packaging/release-signature.py`, BIP 340 from the BIP's
reference code, tested against the BIP's own test vectors), so the `release`-environment jobs, which hold write
tokens, run no package code for it, and anyone can run the same check with Python 3 (packaging/VERIFY.md). Changing
the pinned key is a pull request, so it is visible.

### The Umbrel store

Today the store is updated **before** the release is public: `docker.yml` calls `umbrel-store.yml` right after the
image is pushed and verified, while the release is still a draft, so an Umbrel can be offered a version nobody can see
on the releases page yet. To gate it, the store update moves to **after publishing**:

- `docker.yml` no longer calls `umbrel-store.yml`; `publish-release.yml` dispatches it once the release is published
  (as it already dispatches `zapstore-check.yml`).
- `umbrel-store.yml` runs the same signature check on the published release (the manifest and its event as attached),
  then checks that the digest it pins is the one in the signed compose file, before copying the store. Run by hand on a
  tag (a retry), it does the same. No valid signature, no store update.
- The `release` environment and `UMBREL_STORE_TOKEN` stay as they are.

Start9 is "build it yourself" for the beta; when its package is published, the same check goes in front of it.

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

1. **Built:** `packaging/release-signature.py` (the manifest and the check), `tools/release/sign-release.mjs`
   (signing, upload, relays), the check in `check-release-assets.sh` (so `publish-release.yml`) and `umbrel-store.yml`,
   the store update moved to after publishing, `packaging/release-signer.npub` and its test, the steps in
   docs/releasing.md, tests in `e2e/test/unit/release-signature.test.ts` and `release-workflows.test.ts`. Not yet
   tried against a real signer app: the first release after this is that test.
2. **Built: people can check it:** "Check a release's signature" in packaging/VERIFY.md.
3. **The app checks it** (a later decision): "Check for updates" offers an APK only when the release's manifest is
   signed by the npub built into the app and lists that APK's hash. This is what catches a release published by hand
   from a stolen GitHub account. A new key then needs an app release signed by the old one that names the new one.
4. **Others sign too**, once the APKs are reproducible (`android-reproducible.yml`, step 1 in PR #231): people who
   rebuild a release sign the same manifest, as Bitcoin Core's builders do
   ([guix.sigs](https://github.com/bitcoin/bitcoin/blob/master/contrib/verify-binaries/README.md)).

## 8. Open questions for the owner

None left. Answered 2026-11-10: a free kind (1420), published to relays, the Umbrel store gated, and the per-file
`.sha256` files kept (section 1).
