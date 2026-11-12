# Beta checklist: what stands between 0.1.x-alpha and 0.2.0-beta

**0.2.0-beta** means: ready for testers outside the project, on test networks (signet, testnet4, regtest). Mainnet stays
what it is in the alpha: offered in guardian mode only, behind the pre-alpha warning, "not audited, open source", for an
amount you can afford to lose. The plan this follows is DESIGN.md, "MVP build order", step 4 ("Testnet and signet beta,
tested by users in the wild").

Steps 1 to 3 of that plan (the guardian, packaging for Docker and Umbrel, the app) are built. What is left is checking
that it works where people will use it. Tick a box only when it is done; add the release or PR that did it.

Who: **owner** (needs the owner's devices, accounts or decisions), **dev** (code, docs, CI), **testers** (outside the
project).

## 1. Security

- [x] **Third security sweep (Grok only) triaged** (dev; 0.1.25: 9 findings, all fixed, #212, #213). Every finding checked against the code; each real one fixed
      with a regression test, or written down in DESIGN.md as accepted, with the reason.
- [x] **No open finding rated High or Medium** (dev; 0.1.25).
- [x] Second sweep (Grok and Opus): all three batches fixed (0.1.23, 0.1.24).
- [x] Repository settings for a public repo: secret scanning with push protection, private vulnerability reporting,
      required status checks on main, release tags that can't be moved or deleted, immutable releases, Dependabot
      security updates, approval for outside contributors' workflows, no wiki.
- [x] Release secrets only in the `release` environment, `v*` tags only, with required reviewers; the image pushed with
      `GHCR_PUSH_TOKEN` (0.1.24).
- [ ] **The last release-key steps** (owner): delete the repository copies of the Android signing secrets, and set the
      `trikey-guardian` package's Actions access for this repository to **Read** (docs/android-signing.md, "The `release`
      environment", steps 6 and "The image" 4).
- [x] `npm audit` and the Rust tool's `cargo audit`: nothing found (0.1.24).

## 2. The owner's tests on the latest release

On the release the beta will be cut from, guardian first, then the app (docs/alpha-test-plan.md).

- [ ] **The core path with a Ledger** (owner): steps 1 to 12 of the test plan: setup, pairing, rules and contacts,
      backup, a payment inside and one over the limit, lock and unlock, raising the limit, delete and restore, the
      lost-phone recovery.
- [ ] **0.1.23 and 0.1.24 changes** (owner): contacts named on the device for a rule change; hardware unlock off and on
      asks the device again; adding a wallet needs the first wallet's device; the recovery code screen (no Copy);
      on mainnet, the phone alone is not an alert contact.
- [ ] **Android, both apps** (owner): the Pixel is on 0.1.13; update it, and install Trikey FOSS beside Trikey once.
- [ ] **iPhone** (owner): 0.1.24 installed and opens (done 2026-11-09); the steps above on it too.
- [ ] **Alerts** (owner): email, ntfy, Telegram or webhook, and a contact's `CANCEL` (test plan 15 and 16).

## 3. Hardware wallets on real devices

Everything below is built from each firmware's source and its official client, and covered by tests against recorded or
simulated answers. Until someone has done it once on the device, a beta tester could be the first. Each row: one real
device, the latest firmware, a payment, a guardian pairing (or the reason it can't), one rule approval, and hardware
unlock where the device supports it (DESIGN.md, "Hardware wallets by feature"; docs/alpha-test-plan.md has the steps).

| Device | How it connects | Status | Checklist |
|---|---|---|---|
| Ledger (Nano X, Flex, Stax) | Bluetooth | Tested by the owner (core path); hardware unlock, every 0.1.2x approval text and key 3 with no origin (hosted wallets) still to check | [#273](https://github.com/TheIcarusWings/trikey/issues/273) |
| Trezor (Safe 3, Safe 5, Model T) | Trezor Suite Lite (Android) | Not yet. Also checks the one-time reply token (0.1.24) | [#274](https://github.com/TheIcarusWings/trikey/issues/274) |
| Coldcard Q | QR | Not yet | [#265](https://github.com/TheIcarusWings/trikey/issues/265) |
| Coldcard Mk4 / Q | NFC (Android; iPhone needs a paid developer account) | Not yet | [#265](https://github.com/TheIcarusWings/trikey/issues/265) |
| Jade, Jade Plus | QR | Not yet | [#266](https://github.com/TheIcarusWings/trikey/issues/266) |
| Jade, Jade Plus | Bluetooth (PIN server relayed by the phone) | Not yet | [#266](https://github.com/TheIcarusWings/trikey/issues/266) |
| BitBox02 / BitBox02 Nova | USB-C (Android), Bluetooth (Nova) | Not yet | [#267](https://github.com/TheIcarusWings/trikey/issues/267) |
| Keystone 3 | QR | Not yet | [#268](https://github.com/TheIcarusWings/trikey/issues/268) |
| Passport Prime | QR | Not yet | [#264](https://github.com/TheIcarusWings/trikey/issues/264) |
| Passport gen 2 | QR payments, microSD approvals | Not yet | [#264](https://github.com/TheIcarusWings/trikey/issues/264) |
| Krux | QR payments, microSD approvals | Not yet | [#269](https://github.com/TheIcarusWings/trikey/issues/269) |
| SeedSigner | QR (payments only, by design) | Not yet | [#271](https://github.com/TheIcarusWings/trikey/issues/271) |
| Specter DIY | QR | Not yet | [#270](https://github.com/TheIcarusWings/trikey/issues/270) |

Each device's issue (overview: [#272](https://github.com/TheIcarusWings/trikey/issues/272)) holds its feature checklist, ticked as each item passes on a real
device; a device is marked tested in DESIGN.md, with its firmware version, once its checklist passes.

- [ ] **Every row tried once** (owner and testers). Each result comes in as a
      [hardware wallet test report](https://github.com/TheIcarusWings/trikey/issues/new?template=hardware-test.yml) or a
      comment on the device's issue. A row may also be closed by marking the device "not supported in
      the beta" in the app and the docs, if nobody can test it.

## 4. Platforms and installs

- [x] Umbrel: the community app store, pinned by digest each release.
- [ ] **Plain Docker** (owner or testers): `trikey-guardian-compose.yml` from a release on a Mac, a Linux box or a NAS,
      against a node, once.
      - **Linux, 2026-11-11 (dev):** 0.1.26's two release files, following packaging/compose/README.md word for word,
        with `--profile node` on regtest. The image pulled by digest; the setup code in the log and the first-run page
        worked; setup gave the pairing code; after a restart it came back locked and the passphrase unlocked it. No step
        in the guide was wrong. Not covered: pairing a phone (the test machine had no nostr relays) and a signet or
        testnet4 node (no disk for the sync). Still open for the owner or a tester: a phone paired to a plain-Docker guardian on signet.
- [x] **Start9** (owner decision, 2026-11-09): "build it yourself" for the beta. The package builds in CI on every
      release; publishing it (a signing key and a home for the `.s9pk`) waits until after the beta.
- [x] Android: GitHub releases, Obtainium (trikey.app/obtainium), Zapstore (both apps, from 0.1.24).
- [ ] **A release's APKs rebuilt and compared** (dev or testers): on the first release after 0.1.27-alpha, follow
      packaging/VERIFY.md, "Rebuild the Android APK", for both APKs; once in a fork's Actions, once on a computer
      outside GitHub (not compared yet: another path, JDK and SDK).
- [ ] **Zapstore picks up a release by itself** (dev): check with `zsp check` after the next release; if not, keep
      publishing by hand (docs/zapstore.md) and ask Zapstore.
- [x] **iPhone for testers** (owner decision, 2026-11-09): build from source for the beta (apps/mobile/README.md),
      rebuilt every 7 days with a free Apple ID. TestFlight once the donations cover the Apple developer account.

## 5. Product

- [x] **Multi-wallet off by default**, behind a Settings toggle (dev; 0.1.25, #211).
- [x] **Defaults decided** (owner, 2026-11-09; DESIGN.md "Open questions" 3): the ones the app and guardian already
      use: a daily limit of 200,000 sats suggested (presets 100k, 200k, 500k), a 7-day recovery delay (7, 14 or 30), and
      four relays offered at setup (relay.trikey.app, relay.damus.io, nos.lol, relay.primal.net).
- [x] **The website says what testers can do**: trikey.app still says "Coming soon, there's no release yet"; for the
      beta it points to the test plan, the tutorials and the installs (dev; #210).

## 6. Outside testers

- [ ] **At least five people outside the project** set up a wallet on a test network and do the core path (testers;
      [docs/testers.md](testers.md) is where they start).
- [ ] **One to two weeks** with no open bug that loses funds, locks a wallet for good or breaks a recovery (dev).
- [ ] **Their questions answered** in the docs or the site's FAQ (dev).

## 7. Cutting 0.2.0-beta

- [ ] Version `0.2.0-beta` in every place the release script checks; the release notes say what "beta" means (dev).
- [ ] README and SECURITY.md status lines: beta on test networks, mainnet still "not audited, at your own risk" (dev).
- [ ] The usual release: approvals, Umbrel store, Zapstore, the owner's devices (dev and owner).

## After the beta: what 1.0 would need

Not part of this checklist, so nobody mistakes the beta for it: an independent security review, or a long public track
record without serious issues (the owner decided on 2026-11-01 there is no budget for a paid review); store builds
(App Store, Google Play); and the packaging gaps above closed. Until then every release says "not audited".
