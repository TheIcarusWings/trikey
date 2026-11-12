# Moving the publisher key to the founder's npub: migration

Status: **decided** by the owner on 2026-11-12. In progress; the checklist in section 3 tracks it. Steps 1 to 5 done on
2026-11-12: 0.1.27-alpha is on the old listings (Zapstore check run 43234449450), and the handover note is event
`b827ae9455387962b1c84cf588d46c9b5bdda7ad904b88b42a91073fca87f423` (packaging/publisher-handover.event.json).

Trikey's releases and Zapstore listings move from the Trikey account
(`npub1qussfnkjk6fvr36syatltxl0ks5pssyx7hrhf8zpnp9mf04e5j2sswedj9`, hex `072104ce…a495`, `trikey@trikey.app`) to
the founder's own key (Icarus Wings, `npub19tzp8lf3klmqj3dz9mz0qnuvjp7uyy9993gmljmyaxs8phztj7wsnujvq5`, hex
`2ac413fd31b7f60945a22ec4f04f8c907dc210a52c51bfcb64e9a070dc4b979d`, `icaruswings@trikey.app`). The reasons: one account
and one profile to keep, and that profile already carries the donation Lightning address. The Trikey account is
retired at the end.

**Cutover release: 0.1.28-alpha.** 0.1.27-alpha and every earlier release stay signed by the Trikey key, and the
checks keep accepting them as they are. From 0.1.28-alpha on, only the founder's key is accepted.

## 1. What the publisher key does

| Job | Where |
|---|---|
| Signs every GitHub release's manifest (kind 1420) | `packaging/release-signer.npub`, `tools/release/sign-release.mjs`, `packaging/release-signature.py` |
| Gates publishing: `publish-release.yml` refuses a release it didn't sign; `umbrel-store.yml` checks it again before pinning the Umbrel image | `packaging/check-release-assets.sh` (reads the pinned file) |
| Publishes both Zapstore listings, `app.trikey.wallet` and `app.trikey.wallet.foss`, after a NIP-C1 proof links the APK signing certificate to it | `zapstore.yaml`, `packaging/zapstore/foss/zapstore.yaml` (`pubkey:`) |
| Is what the Zapstore check looks for | `.github/scripts/zapstore-published.mjs` (`AUTHOR`), `e2e/test/unit/zapstore-check.test.ts` |
| Is `trikey@trikey.app` and `_@trikey.app` (NIP-05) | `site/.well-known/nostr.json` |
| Is what people verify against | `packaging/VERIFY.md`, `docs/zapstore.md`, docs/design/signed-releases.md |

The apps don't check the key yet: that is phase 3 of signed-releases.md, not built. So no installed app needs an
update to follow the move.

## 2. What the move costs, and how it is kept small

- **One key for everything.** The founder's key now signs releases as well as notes, zaps and nostr logins.
  - A leak of it is one of the two locks on every Trikey update. The other lock is the GitHub account
    (signed-releases.md, section 6).
  - **Rule from now on:** the founder's key is used only through a signer (Amber, or a bunker), and never pasted into
    a nostr client or website. Any app that holds the nsec directly is signed out and signed in again through Amber.
- **Bus factor.** A co-maintainer can't be handed a personal key. If one joins, releases move to a project key again,
  following this same procedure.
- **Zapstore users** move to the new listings once. The APK signing key is unchanged, so Android updates in place
  whichever listing a Trikey came from.

## 3. Checklist

The old key vouches for the new one before it steps back, so anyone who trusts it can follow the change. **Owner**
steps need the owner's signer; the Mac ones run in the local session on the owner's Mac. Secrets never pass through a
Claude session: the owner types bunker links and keystore passwords themselves.

1. [x] **Repo:** both Zapstore descriptions announce the move (merged with this document).
2. [x] **Owner (Mac):** publish 0.1.27-alpha on the current listings with the Trikey key, from an up-to-date `main`.
   This also closes TheIcarusWings/trikey#258.

   ```
   zsp publish zapstore.yaml
   zsp publish packaging/zapstore/foss/zapstore.yaml
   ```

   Zapstore users get 0.1.27 and the notice that the listing moves.
3. [x] **Owner (Mac):** `node tools/release/sign-release.mjs v0.1.27-alpha --relays-only`, which publishes 0.1.27's
   signature to relays.
4. [x] **Owner (phone):** the handover note. Post it from the **Trikey** account, signing in Amber with the Trikey key:

   > Trikey's publisher key changes. From Trikey 0.1.28-alpha, releases and the Zapstore listings are signed by
   > Icarus Wings, npub19tzp8lf3klmqj3dz9mz0qnuvjp7uyy9993gmljmyaxs8phztj7wsnujvq5 (icaruswings@trikey.app). This key
   > signs no more releases. Install Trikey from the new Zapstore listing to keep getting updates. Details:
   > https://github.com/TheIcarusWings/trikey/blob/main/docs/design/publisher-key-switch.md

   Then send the note's link (`nevent1…` or `note1…`; public) to the controller session.
5. [x] **Repo:** one PR moves the pins:
   - `packaging/release-signer.npub`;
   - `AUTHOR` in `zapstore-published.mjs` and its test;
   - `pubkey:` and the "published by" text in both `zapstore.yaml` files;
   - `nostr.json`: `trikey` and `_` point at the founder's key;
   - the `.gitleaks.toml` allowlist;
   - VERIFY.md: a table of keys and the releases each signed, with the handover note's id;
   - docs/zapstore.md and signed-releases.md.

   Merged before 0.1.28-alpha is tagged.
6. [ ] **Repo:** release 0.1.28-alpha (release.yml), as usual.
7. [ ] **Owner (Mac):** sign 0.1.28-alpha with the founder's key:
   - in Amber, create a new bunker connection for the Icarus Wings account;
   - run `node tools/release/sign-release.mjs v0.1.28-alpha` and give it that link.

   The tool refuses any key other than the pinned one, so it also proves step 5 is in place.
8. [ ] **Owner (Mac):** the new Zapstore listings. Run `zsp` with the founder's bunker link, which links the APK
   signing certificate to the founder's key (NIP-C1). Then:

   ```
   zsp publish zapstore.yaml
   zsp publish packaging/zapstore/foss/zapstore.yaml
   ```

   If zsp or Zapstore refuses a second key for the same certificate, stop and ask on zapstore/relay#16 (section 5).
9. [ ] **Repo:** the Zapstore check passes for 0.1.28-alpha under the new key, and the release's signature is on
   relays (VERIFY.md, `nak req -k 1420 -a 2ac413fd…`).
10. [ ] **Owner:** retire the Trikey account:
    - optionally, a deletion request (NIP-09) for the old listings' app events, if Zapstore honours it;
    - remove the Trikey key from Amber and its bunker connections;
    - delete `~/.config/trikey/nip46/072104ce…a495.key` on the Mac;
    - keep the offline backup of the key for a few months, in case a correction ever needs signing with it.

Nothing else moves:
- the APK signing key and its certificate pin (`packaging/android/release-cert.sha256`);
- the Docker images;
- the Umbrel and Start9 packages;
- the guardian;
- the app's nostr protocol;
- the guardian relay.

## 4. What users see

- **Zapstore:** the current listings get 0.1.27 with a note that the listing moves. From 0.1.28, Trikey is listed by
  Icarus Wings. Installing from the new listing updates the app in place, with no data lost.
- **People who verify releases:** VERIFY.md says which key signed which releases, and links the handover note signed
  by the old key.
- **trikey@trikey.app** keeps resolving, to the founder's key.

## 5. Open questions for Zapstore

Ask on zapstore/relay#16, before step 8 if possible:

1. Can one APK signing certificate be linked (NIP-C1) to two publisher keys while the listings move? If not, the old
   proof has to go first, which leaves a short window with no working listing.
2. Does Zapstore honour a deletion request for an app's events, or keep showing the old listing?
3. Is there a way to move a listing to a new key, so that installed users follow without reinstalling?
