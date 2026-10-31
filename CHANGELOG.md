# Changelog

Trikey is pre-alpha and not audited. Each release has a guardian image
(`ghcr.io/theicaruswings/trikey-guardian`, pinned by digest in the
[Umbrel community store](https://github.com/TheIcarusWings/trikey-umbrel-store)) and an Android test APK on its
[GitHub release](https://github.com/TheIcarusWings/trikey/releases). How to install and test:
[docs/alpha-test-plan.md](docs/alpha-test-plan.md).

## Unreleased

- CI also opens every PR's app in the iOS Simulator (a Release build for the simulator, no signing and no Apple
  account) and fails on a crash at start, with the crash report and the app's log lines in the check's annotations
  (`ios-launch.yml`). The iOS build instructions now build Release, so the app runs without Metro.
- CI also walks through the demo after the launch check, on the Android emulator and in the iOS Simulator, with Maestro
  (`apps/mobile/.maestro/demo-walk.yaml`: Welcome into Demo mode, Home, Send to the amount, Receive, Settings, Activity),
  and fails the pull request when a step fails or the app crashes on the way, with the failing step, Maestro's error and
  the app's log lines in the check's annotations and the screenshots in an artifact.

## 0.1.4-alpha (2026-10-30)

- **App: a lost-phone recovery no longer shows the guardian offline for most of the wait.** The new phone's access to
  the guardian lasts 12 hours at a time (your hardware wallet vouches for it), and once it ran out the guardian ignored
  the phone, so every check waited 30 seconds for an answer that never came and the app showed the guardian offline,
  while the recovery went on at the guardian regardless. The phone now keeps when its access ends (and says so in
  the wallet snapshot), asks the guardian nothing while it has run out (`recovery_access_expired`, at once instead of
  after a timeout) and leaves the guardian's status as last known. The waiting screen says "The recovery continues at
  your guardian. To see its progress here, approve again with your hardware wallet", makes "Keep following" the main
  button then, and shows "Following until 14:05" before. Approving again brings syncing back right away, and
  the guardian's alerts (including the one that says it took the new wallet over) still reach a phone whose access
  ran out, and if it missed that one, "Keep following" switches it to the new wallet. No protocol or guardian change
  (#41).
- **App: the guardian no longer shows offline right after a lost-phone recovery.** A sync asked for while another
  ran was dropped, so the switch to the new wallet's sync could be lost and a late failure marked the guardian offline
  until the next timer; syncs now queue (#39).
- **Guardian: old relays stay watched until you stop them.** After you change relays, the guardian keeps the
  removed ones until you stop them: printed recovery sheets (which carry the relay list) are kept for years and an old
  sheet must keep working. Settings, Relays lists the old
  relays (still watched since the change, and whether your phone confirmed it switched) with "Stop watching", for
  one or all of them, after a confirmation that says what stops working: recovery sheets and phone backups made
  before the change, and phones that have not switched yet. It is logged ("Old relays dropped"). At most 16 old
  relays are watched: a change that would leave more is refused until you stop some, and nothing is dropped on its
  own. An existing `service.json` loads as before (its end dates are ignored and the relays kept). New:
  `DELETE /api/relays/retiring` and `/api/relays/retiring/:url`; `GET`/`PUT /api/relays` give each old relay `since`
  instead of `until`, and `maxRetiring`; `PUT` can answer `409 retiring_full` (#38).
- **App: fixes the Android APK closing as soon as it opens** (every APK from 0.1.0). The Trezor link loads
  `@sinclair/typebox`, whose ES build declares a top-level `var Object` that breaks once Metro turns it into
  CommonJS; the app now uses typebox's CommonJS build (#34).
- CI opens every PR's APK in an Android emulator and fails on a crash at start, with the crash log on the PR
  (#34).
- **Guardian: change relays** in Settings, for when a relay disappears or you want your own. The guardian moves at
  once and keeps listening and publishing on the old relays (see the entry above), so nothing that still knows only
  them (the phone, an older backup, a printed recovery sheet) is cut off. The phone is told (`relays_changed`, and
  `guardian.status.relays`) and switches by itself, but only once the guardian has answered it over the new relays
  (`relays.ack`), so an unreachable or mistyped relay never strands it. The change is a security event in the activity
  log; pairing and recovery codes carry the new list. Phones from before this keep working over the old relays. New:
  `GET`/`PUT /api/relays`; protocol: the `relays_changed` alert, `relays.ack`, `guardian.status.relays`
  (#37).
- Guardian: refuses to pair a phone whose random contribution is one byte repeated: its generator is broken
  (entropy review I3, #36).
- Guardian: after a crash the process exits with 1, not 0, so Umbrel's `restart: on-failure` brings it back
  instead of leaving the app at 502 (#30).
- Recovery Key: the kit's word-check positions are picked uniformly (entropy review I4, #33).

## 0.1.3-alpha (2026-10-30)

- **Guardian: fixes the guardian stopping right after setup** ("Maximum call stack size exceeded") when a
  nostr relay could not be reached. nostr-tools' relay calls `close()` from its own error handler and Node's
  WebSocket fires the error again from inside `close()`; every relay pool now uses a WebSocket whose
  `close()` runs once (#29).
- Guardian: reports its real version (it said 0.1.0).
- Guardian web: the passphrase works with password managers (Proton Pass, 1Password, Bitwarden, iCloud,
  Google): one saved entry fills setup, unlock, sign-in and reset, and setup can use a generated passphrase
  (#27).
- Design proposal for passkey sign-in and unlock: [docs/design/passkey-unlock.md](docs/design/passkey-unlock.md)
  (#28).

## 0.1.2-alpha (2026-10-30)

- **Guardian: fixes the image not starting** ("Cannot find package 'zod'"): 0.1.0-alpha and 0.1.1-alpha left
  a dependency out of the image. CI now starts the built image and waits for `/api/status` before a release
  (#23).
- Security, from the [entropy review](docs/security/entropy-review.md):
  - new guardian setup seeds mix in 32 bytes from the setup browser and, on Umbrel, the app's `APP_SEED`, so a
    predictable guardian generator alone no longer gives key 3 (M1, #24);
  - a stricter randomness lint (L1, #21);
  - a gift wrap's public expiration no longer reveals when it was sent (L2, #20);
  - an RNG health test and crypto known-answer tests before any key is made, on the guardian and the phone
    (L3, #22).
- Umbrel: the app ships its `data` folder so the guardian (uid 1000) can write its state (#11).
- Guardian: a data folder it cannot write is refused at once, saying whose it is (#12).
- App: a network strip on every screen on test networks and in the demo (#13), AA contrast and 44 pt targets
  (#19), "Review" on the amount screen and Copy first on Receive.
- Guardian web: the same network strip across the top on test networks (#14).
- Docs: the test plan covers installing from the community store and testing on mainnet or a test network
  (#18).

## 0.1.1-alpha (2026-10-30)

- Mainnet in guardian mode, behind a pre-alpha warning the tester must accept; Recovery Key mode stays on test
  networks (#8).
- Guardian: silent payment scanning on several CPU cores (`SP_SCAN_THREADS`), falling back to one thread if
  the workers cannot start.
- App: haptics, Send max, Wallet details (the descriptor, to recover in another wallet), Report a problem,
  Android back no longer leaves no-going-back screens, a button to the setting when Bluetooth is off or its
  permission was refused, the recovery's line for coins that arrive late.

## 0.1.0-alpha (2026-10-30)

- First pre-release: the phone app (guardian mode and Recovery Key mode), the guardian with its web UI, the
  Umbrel and Start9 packages, and the Android test APK.
- Known issue: the guardian image cannot start (fixed in 0.1.2-alpha).
