# The first public release, and how features reach it

Status: **decided** by the owner on 2026-11-21. Built: feature stages, the promotion check and the preview unlock.
Open: the release checklist in section 5.

## 1. The owner's decisions (2026-11-21)

- **Version 1.0**, with no paid or independent security review first: the code is open source and anyone can review
  it. Every release keeps saying it is not audited. (This replaces "after the beta: what 1.0 would need" in
  docs/beta-checklist.md, which asked for a review or a long track record.)
- **Networks:** mainnet and the test networks (testnet4, signet). Mainnet stays guardian mode only, behind its
  warning, as today.
- **Platforms:** Android. The iPhone app is built from source with the instructions in the repository
  (apps/mobile/README.md); no App Store or TestFlight for 1.0.
- **Zapstore must work before release:** the listing moved to the founder's key (publisher-key-switch.md, step 8),
  by the Trikey key naming it as delegate if Zapstore doesn't answer.
- **The public app has only what was tested.** Everything else stays in **Trikey Test** until it is.
- **Hardware wallets for 1.0:** Ledger, Trezor and one QR device, each tested on a real device before the release.
- **Three stages**, below, with a dev mode that only the owner can turn on.

## 2. Three stages

| Stage | Where | Who sees it |
|---|---|---|
| **test** | Trikey Test only (`app.trikey.wallet.test`), with Demo, Simulator and regtest | Developers and testers |
| **preview** | The public app, hidden until preview is unlocked on that phone | Only the owner, on real wallets, before a release |
| **public** | The public app | Everyone |

The list is `apps/mobile/src/lib/features.ts`. Each feature has a stage and its evidence.

**Why not one app with a dev mode instead of Trikey Test** (considered, 2026-11-21): Trikey Test keeps its own data,
so an unfinished feature can never touch a real wallet; the public app's users don't carry the test tools; and a
regtest wallet and a mainnet wallet can sit side by side. Demo, Simulator, regtest and Settings > Developer stay in
Trikey Test. The preview stage gives the owner the other half of a dev mode: trying a finished feature on a real
wallet in the real app.

### Rules

1. **Hidden means "can't be turned on", not "can't be read".** A wallet that already uses a feature (Savings set up in
   Trikey Test, then restored in the public app, say) keeps showing and spending it. A stage never strands money.
2. **Recovery is never gated:** restoring, the lost-phone and lost-hardware-wallet recoveries, and Replace guardian
   list every device the phone can talk to. Only making a new wallet is limited to the devices in the build
   (`forNewWallet` on `HardwareList`).
3. **The guardian is one build.** It supports everything; the app decides what it offers. The guardian's own features
   (alerts by email, ntfy, Telegram and webhook; unlocking with the hardware wallet; sealed unlock; changing the
   passphrase) are tracked in section 4 but not gated.
4. **A feature can go back.** If a public feature shows a bug that loses money, locks a wallet for good or breaks a
   recovery, the next release moves it back to preview or test (rule 1 still holds for wallets that use it).

## 3. Promoting a feature

A feature moves **test → preview → public**, one pull request per move, which:

1. changes its `stage` in `features.ts`;
2. adds its **evidence**: a test report or the device's issue for a hardware wallet (a test on a real device is
   required to make a hardware wallet public), the end-to-end tests for software features, the release it was tried on;
3. ticks it in section 4 below, with the version and who tested it;
4. names it in the release notes ("New in Trikey: …").

`apps/mobile/src/lib/features.test.ts` is the check, run by CI on every pull request. It refuses a preview or public
feature with no evidence, and a public hardware wallet without a link to an issue or pull request. It also refuses a
wallet feature that no screen checks (`featureOn('<id>')`).

**Evidence for software features** can be automated: the end-to-end tests against real regtest bitcoind, Electrs and
the guardian (`e2e/`), and the UI flows on an emulator in Simulator mode (being built). **Hardware wallets need a real
device**: recorded answers prove the code, not the device's firmware.

### The preview unlock

Preview turns on for one phone, for 24 hours, when the owner signs that phone's challenge with the publisher key
(`packaging/release-signer.npub`, the key that signs releases). Code: `apps/mobile/src/lib/preview-unlock.ts` (the
check), `preview-store.ts` (the phone's state), `app/settings/preview.tsx` (the screen),
`tools/release/unlock-preview.mjs` (the signing tool).

1. **On the phone:** Settings, **hold the version row** under About for a second and a half; Preview opens. Make a
   challenge: 16 hex digits from the secure random source, good for 15 minutes.
2. **On the computer:** `node tools/release/unlock-preview.mjs <challenge>`, with a bunker:// link from Amber (the
   same kind of link as for signing releases; the tool keeps its connection as `sign-release.mjs` does). Amber asks to
   sign one event of kind 1421, with a fixed text and the challenge as its only tag. The tool refuses any key other
   than the pinned one, and shows the signed event as a QR code. Nothing is published.
3. **On the phone:** scan it, or paste the JSON. The app checks the signature, the pinned key, the kind, the text, the
   tag, a time no earlier than the challenge, and the challenge still open; then preview is on until the time shown,
   and the version row says "preview". Each challenge works once. **Turn preview off** ends it early.

It can't be a code typed into the app: the source is public, so a code (or the check for it) would be in it, and a
scammer could tell someone "type this to unlock support mode". Nobody else can make the publisher key's signature, and
it unlocks only the phone whose challenge it signs. A test build has every feature already, so the row does nothing
there.

## 4. The inventory

What the app offers, its stage, and what it needs to move. "Tested" is a test on the release, by the owner or a tester.

### Wallet features

| Feature | Stage | Needs |
|---|---|---|
| Guardian mode: setup, pairing, daily limit, contacts, payments, lock and unlock | public (not gated) | Re-tested by the owner on the 1.0 release candidate |
| Restore, lost-phone recovery, lost hardware wallet | public (never gated) | Re-tested on the release candidate |
| Replace guardian | public (never gated) | Re-tested (bug fixed in 0.1.30) |
| Phone backup: recovery code, Copy with its protections, passkey | public (not gated) | One check of Copy (new in 0.1.30) |
| Coin control, notes, speed up (RBF) | public (not gated) | Automated: `e2e/test/coin-control.test.ts`, `notes.test.ts`, `spending-speed-up.test.ts` |
| Paying a silent payment address | public (not gated) | Automated: `packages/wallet/test/silent-payments.e2e.test.ts` (against fake chain services, not the regtest stack) |
| Check for updates (Android) | public | The release signature check (signed-releases.md, phase 3) before 1.0 |
| Receiving silent payments | **test** | A test on a real guardian |
| Savings | **test** | A test with a hardware wallet and a Recovery Key |
| Recovery Key mode (no home server) | **test** | A test on a test network |
| A key on someone else's guardian (invites, family hosting) | **test** | A test with two people |
| Several wallets in one app | **test** | A test with two hardware wallets |

### Hardware wallets (making a new wallet)

| Device | Stage | Needs |
|---|---|---|
| Ledger (Bluetooth) | public | The rest of [#273](https://github.com/TheIcarusWings/trikey/issues/273) on the release candidate |
| Trezor | preview | Tests 2 and 3 of [#274](https://github.com/TheIcarusWings/trikey/issues/274) |
| QR devices, each model | preview | The owner's QR device tested (its issue); the others stay preview or go back to test |
| BitBox02, Jade by Bluetooth, Coldcard by NFC, another QR device | test | A tester with the device |

### The guardian's features (not gated: rule 3)

| Feature | Needs before the release notes call it supported |
|---|---|
| Alerts by email, ntfy, Telegram, webhook; a contact's `CANCEL` | One channel tested (test plan 15 and 16) |
| Unlocking with the hardware wallet, sealed unlock, changing the passphrase | A test each on a real guardian |

## 5. Before 1.0 is released

- [x] Feature stages and the promotion check.
- [x] The preview unlock, signed by the publisher key.
- [ ] The release signature check in "Check for updates".
- [ ] UI end-to-end flows in CI for the guardian-mode core path, backup and restore.
- [ ] Zapstore listing on the founder's key (publisher-key-switch.md, step 8).
- [ ] The last release-key steps (docs/beta-checklist.md, section 1).
- [ ] The owner's tests on the release candidate: the core path with a Ledger, Trezor tests 2 and 3, one QR device,
      Replace guardian, Copy of the recovery code.
- [ ] Version 1.0.0 everywhere the release script checks; README, SECURITY.md and the site say 1.0, open source and
      not audited, mainnet at your own risk.
- [ ] The iPhone build-from-source instructions checked against the 1.0 tag.
