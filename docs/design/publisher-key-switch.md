# Switching the publisher key to the founder's npub: plan

Status: proposal, not decided. Written 2026-11-12, against `main` after 0.1.27-alpha.

The owner asked what it would take to publish Trikey with their personal nostr key (Icarus Wings,
`npub19tzp8lf3klmqj3dz9mz0qnuvjp7uyy9993gmljmyaxs8phztj7wsnujvq5`) and retire the separate Trikey account
(`npub1qussfnkjk6fvr36syatltxl0ks5pssyx7hrhf8zpnp9mf04e5j2sswedj9`, `trikey@trikey.app`). Fewer accounts, one
profile, one Lightning address. This document lists what the Trikey key does today, what a switch costs, and the
order to do it in, so the decision can be made on paper first.

## 1. What the Trikey key does today

| Job | Where | What a switch changes |
|---|---|---|
| Signs every GitHub release's manifest (kind 1420) | `packaging/release-signer.npub`, `tools/release/sign-release.mjs`, `packaging/release-signature.py` | The pinned npub |
| Gates publishing: `publish-release.yml` refuses a release it didn't sign; `umbrel-store.yml` checks it again before pinning the Umbrel image | `packaging/check-release-assets.sh` (reads the pinned file) | Nothing beyond the pinned file |
| Publishes both Zapstore listings, `app.trikey.wallet` and `app.trikey.wallet.foss` | `zapstore.yaml`, `packaging/zapstore/foss/zapstore.yaml` (`pubkey:`), the NIP-C1 proof linking the APK signing certificate to it | New listings under the new key (section 3) |
| Checks Zapstore picked up a release | `.github/scripts/zapstore-published.mjs` (`AUTHOR`), `e2e/test/unit/zapstore-check.test.ts` | The hex key |
| Is `trikey@trikey.app` and `_@trikey.app` (NIP-05) | `site/.well-known/nostr.json` | Point both at the new key, or drop them |
| Is what people verify against | `packaging/VERIFY.md`, `docs/zapstore.md` | Both keys, with the release where the change happened |
| Not a secret anywhere in the repo | `.gitleaks.toml` allowlists its hex | The new hex |

The apps don't check the key yet. "The app checks it" is phase 3 of docs/design/signed-releases.md, not built. So no
installed app needs an update to follow a switch. **That makes now the cheapest time to switch.** Once phase 3
ships, every installed app pins the key, and changing it needs a release signed by the old key that names the new one.

## 2. What it costs

**Security, the main cost.** Whoever holds the publisher key can sign a release that the pipeline, the Umbrel store
and Zapstore accept. A stolen key alone isn't enough: the attacker also needs the files on GitHub (signed-releases.md,
section 6). But it is one of the two locks.

- **Today:** the Trikey key does one thing. It lives in Amber and is used only to sign releases and Zapstore events.
- **After a switch:** the personal key would sign releases *and* everything personal: notes, likes, DMs, zaps, logins
  to nostr websites.
- **Why that matters:** more use means more ways to lose it, such as a client that holds the nsec, a phishing login
  page, or a browser extension.
- **If the personal key leaks,** the attacker gets the personal identity and one of the two locks on every Trikey
  update.
- **The mitigation:** the personal key also lives only in a signer (Amber, a bunker), never pasted into a client. Is
  that true today? Check every app signed in as Icarus Wings: does it hold the nsec, or ask Amber?

**Bus factor.** Today the listings say "Trikey's own npub publishes the apps, so they don't depend on one person's
key" (docs/zapstore.md). The Trikey key could be handed to a co-maintainer one day without handing over a personal
identity. A personal key can't. While Trikey has one maintainer this is theoretical, but a switch makes it harder to
add one later.

**Zapstore users.** A listing belongs to the key that publishes it. New key, new listings. People who installed
Trikey from the current listings keep getting updates only from those, so they must be told to move (section 3).

**What gets simpler.** One account and one profile to keep. No second identity in Amber. The Lightning address
(`icaruswings@getalby.com`, on the site since TheIcarusWings/trikey#259) is on the same profile people zap.

## 3. The switch, in order

The idea is that the old key vouches for the new one before it steps back, so anyone who trusts the old key can
follow the change.

1. **Decide the cutover release**, for example 0.1.28-alpha. Everything below lands before or with it.
2. **The old key announces the new one.** The Trikey key signs, through Amber, a public note:
   > "From Trikey 0.1.28-alpha, releases and Zapstore listings are signed by
   > npub19tzp8lf3klmqj3dz9mz0qnuvjp7uyy9993gmljmyaxs8phztj7wsnujvq5. This key stops signing releases."

   It's published to the same relays as release events. The note's id goes into VERIFY.md, so the handover is
   checkable from the repository and from nostr.
3. **One PR changes the pins:**
   - `packaging/release-signer.npub`;
   - `AUTHOR` in `zapstore-published.mjs` and its test;
   - `pubkey:` and the "Published by" text in both `zapstore.yaml` files;
   - `nostr.json`: `trikey` and `_` move to the new hex, so `trikey@trikey.app` keeps working and points at the
     founder;
   - the `.gitleaks.toml` allowlist;
   - VERIFY.md: a table with each key and the releases it signed;
   - docs/zapstore.md and signed-releases.md.

   0.1.27-alpha and earlier stay signed by the old key, and the checks keep accepting them as they are. Only new
   tags need the new key.
4. **The cutover release is signed with the new key** (`sign-release.mjs`, a bunker link from the personal account in
   Amber).
5. **New Zapstore listings:**
   - `zsp` makes a new NIP-C1 proof, linking the same APK signing certificate to the new key;
   - then `zsp publish` for both apps.
   - The APK signing key doesn't change, so Android accepts the update over an installed Trikey whichever listing it
     came from.
6. **Point the old listings at the new ones:**
   - publish one last update of each old listing (old key), whose description says where the new listing is;
   - then, if Zapstore supports it, a deletion request (NIP-09) for the old app events, so they stop showing in
     search.
7. **Retire the old key.** Remove it from Amber and from the signer bunker connections. Keep its offline backup for a
   while, in case a deletion or a correction needs signing. The `~/.config/trikey/nip46/<old signer>.key` file
   `sign-release.mjs` kept can be deleted.

Nothing else moves:
- the APK signing key and its certificate pin (`packaging/android/release-cert.sha256`);
- the Docker images;
- the Umbrel and Start9 packages;
- the guardian;
- the app's nostr protocol.

## 4. What users see

- **Zapstore:** a new Trikey listing by Icarus Wings. The old one says "moved" in its description, then disappears
  if the deletion works. People who installed from the old listing have to install from the new one once: Android
  updates in place, since the APK signature is the same.
- **People who verify releases:** VERIFY.md says which key signed which releases, and links the old key's handover
  note.
- **The site and README:** "published by Icarus Wings" instead of "published by Trikey's own npub".

## 5. Open questions

For the owner:
1. **Switch or keep?** Our recommendation is to keep the Trikey key for releases and Zapstore. Using the personal
   Lightning address for donations is fine either way: it only decides where gifts land and can't affect what users
   install.
2. If switching: **which release is the cutover?**
3. Is the personal key used only through a signer today? (Section 2.)

For Zapstore (zapstore/relay#16 is the place to ask):
4. Can one APK signing certificate be linked (NIP-C1) to two publisher keys while listings move? If not, the old
   proof must be removed first, and there's a window with no working listing.
5. Does Zapstore honour a deletion request for an app's events, or keep showing the old listing?
6. Is there a way to move an app's listing to a new key, so that installed users follow it without reinstalling?
