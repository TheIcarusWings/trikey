# Changelog

Trikey is pre-alpha and not audited. Each release has a guardian image
(`ghcr.io/theicaruswings/trikey-guardian`, pinned by digest in the
[Umbrel community store](https://github.com/TheIcarusWings/trikey-umbrel-store)) and an Android test APK on its
[GitHub release](https://github.com/TheIcarusWings/trikey/releases). How to install and test:
[docs/alpha-test-plan.md](docs/alpha-test-plan.md).

## Unreleased

- **Guardian: change relays** in Settings, for when a relay disappears or you want your own. The guardian moves at
  once and keeps listening and publishing on the old relays for 30 days, so nothing that still knows only them (the
  phone, an older backup, a printed recovery sheet) is cut off meanwhile. The phone is told (`relays_changed`, and
  `guardian.status.relays`) and switches by itself, but only once the guardian has answered it over the new relays
  (`relays.ack`), so an unreachable or mistyped relay never strands it. The change is a security event in the activity
  log; pairing and recovery codes carry the new list. Phones from before this keep working over the old relays for
  the 30 days. New: `GET`/`PUT /api/relays`; protocol: the `relays_changed` alert, `relays.ack`, `guardian.status.relays`.
- Guardian: after a crash the process exits with 1, not 0, so Umbrel's `restart: on-failure` brings it back
  instead of leaving the app at 502.

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
