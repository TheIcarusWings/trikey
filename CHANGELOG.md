# Changelog

Trikey is pre-alpha and not audited. Each release has a guardian image
(`ghcr.io/theicaruswings/trikey-guardian`, pinned by digest in the
[Umbrel community store](https://github.com/TheIcarusWings/trikey-umbrel-store)) and an Android test APK on its
[GitHub release](https://github.com/TheIcarusWings/trikey/releases). How to install and test:
[docs/alpha-test-plan.md](docs/alpha-test-plan.md).

## Unreleased

## 0.1.8-alpha (2026-11-01)

- **Savings, an optional vault that phone + guardian can never spend** (option K). Settings > Savings: your hardware
  wallet and a second hardware wallet as the Recovery Key; any two of phone, hardware wallet and Recovery Key move it,
  the guardian holds no Savings key. Moving money in is a normal payment, counted against the daily limit. The guardian
  watches it and tells your phone and every alert contact when money leaves it, and when the watch is turned off or
  swapped. Backups include it, every lost-key case has a way back, and a one-page **Savings wallet map** can be printed
  (no secrets on it). Wallets without Savings work exactly as before (#87, #88).
- **Alert contacts can lock the guardian, if you allow it** (Settings > Alert contacts, off by default). A contact sends
  the single word `LOCK` from any nostr app; the guardian locks as if you had, and you and every other contact are told
  who did it. Contacts can never unlock or change anything. Turning it off needs the hardware wallet. While it is off a
  contact's `LOCK` is not an option at all: no answer, and it never counts later (#85, #86).
- **Alerts by email, ntfy and webhook** (guardian web UI, Settings > Notifications): email through your own account
  (Gmail, Fastmail, Proton presets), ntfy push (your own server or ntfy.sh), or a signed webhook (Home Assistant, Apprise,
  an SMS gateway). For you and for each alert contact, also people without nostr. Plain text, never links. Changes are
  made only in the web UI and announced on every channel; alerts still go out while the guardian is locked (#91).
  Proton Mail Bridge and other relays with a self-signed certificate work by pinning that certificate, and during a
  recovery the email app password can still be replaced, so a revoked password can't silence the warnings (#93).
- **App: never left on the first screen with a wallet set up.** After switching wallet mode, or at the end of a setup on
  an iPhone, the app could stay on Welcome over a set-up wallet (where the Network picker then refused every tap); it now
  starts from the entry screen after a switch, and Welcome moves on to Home when it is in front of a set-up wallet (#73).
- App: an honest message when a build has no cloud backup, and the snags of a first iPhone build from a Mac in the README
  (#74). The web build prints the Recovery Kit itself, not the app's screen (#90). Shared backup files no longer stay in
  the app's cache (#83). "Not audited" now always comes with "open source" (#84).
- Demo mode backs up and restores like the build it runs in (a backup file and a recovery code where there are no
  passkeys) and shows the Network picker, for the setup tutorials (#79).
- Docs: a security review brief for anyone reviewing Trikey (#77, #78, #82), the design for hosting a guardian for family
  (#89, not built in this release), the owner's decisions of 1 November, and the first release-key build named right
  (#80).
- CI: every GitHub Action moved to its Node 24 release (#81).

## 0.1.7-alpha (2026-11-01)

- **Android: releases now update in place.** Every release APK from this one on is signed with the Trikey release key
  (certificate SHA-256 in `packaging/android/release-cert.sha256`), so a newer release installs over the older one and
  the wallet on the phone stays. Builds up to 0.1.6-alpha had a one-off key each: moving from one of those to 0.1.7-alpha
  needs a last uninstall, which deletes the wallet on that phone, so back up first. The release build refuses to publish
  an APK signed by any other key. Android's version code now follows the version (0.1.7 is 107). How to check an APK and
  how to get updates with Obtainium: [docs/android-signing.md](docs/android-signing.md) (#60).
- **App: Check for updates** (Android, Settings > About). Asks GitHub for the newest release only when you tap it, and
  offers the APK with its SHA-256; Android's installer takes it from there. It only opens downloads from Trikey's own
  releases (#68).
- **App: a Ledger that dropped Bluetooth is reconnected.** During setup the app kept the Ledger's connection from the
  connect step; a Flex dropped it while the phone scanned the guardian's code, and the protection screen then failed with
  "The device disconnected" on every try. A held connection that turns out to be gone is now replaced by a fresh one and
  the step runs again, once (#65).
- **App: after a recovery, a phone whose access ran out switches to the new wallet at once.** It could keep showing
  "recovering" for 10 to 30 seconds after the guardian had taken the new wallet over: its status check could reach the
  guardian just before the takeover and go unanswered. It now acts on the guardian's "wallet adopted" alert directly,
  with the same checks of the new wallet as before (#66).
- **App: the Network picker no longer closes the app.** On the first screen, picking a network while a wallet already
  existed threw an error out of the tap, which closes a release build; the picker now says why the network can't change
  (#71). Found on an iPhone.
- CI: the demo walk is walked again once when Maestro's iOS driver loses its connection mid-walk (#64), and other apps'
  "isn't responding" dialogs on the Android emulator no longer hide the app from it (#67).

## 0.1.6-alpha (2026-10-31)

- **App: fixes connecting a Ledger** ("Ledger error: invalid number provided"; every Ledger, from 0.1.0). The app
  gave Ledger's signer kit key paths with a leading `m/` (`m/48'/0'/0'/2'`), which it reads as a number and refuses;
  it now passes `48'/0'/0'/2'`. A test builds the Ledger Bitcoin app's real commands from those paths. No guardian
  or protocol change (#56).
- App: Ledger and Trezor now match what their libraries really do, found by checking every remaining call against the
  installed SDKs after the fix above. The Ledger "Bitcoin Test" app writes regtest addresses as `tb1...`, so the address
  check no longer fails there. A failed Bluetooth connection and a lost session now say so, instead of a bare "Ledger
  error", and errors that keep their text in `originalError` show it. Wallet names with a leading or trailing space are
  refused before the Ledger refuses them. A Trezor failure or cancellation now shows its reason, instead of "Trezor
  error". New tests run the real Ledger signer kit against a scripted Bitcoin app, and the Trezor signer through the
  real connect-mobile client (#59).
- App: a Trezor signs Trikey's messages (pairing and hardware approvals) with the script type it would infer anyway,
  stated explicitly, which firmware 2.13.0 and later accept without a warning. On older firmware and the Model One the
  device warns about the path first, then signs; the app's prompt and the test plan now say that is expected. Checked
  against the firmware sources: no Trezor refuses that path ([docs/design/hardware-auth-path.md](docs/design/hardware-auth-path.md),
  #61, #62).

## 0.1.5-alpha (2026-10-31)

- **You can turn the daily limit off, with your hardware wallet.** It is an option for people who do not want a
  limit: Settings, Daily limit, "Turn off the daily limit". The hardware wallet must approve it, and its screen says
  `limit=off` in words (the version-2 policy text, `Trikey policy v2 ... limit=off ...`). It is refused at pairing and
  while a recovery runs. The app says plainly what it means: whoever holds your phone and your guardian together can
  then spend everything at once. Your phone and every alert contact (including any removed in the same change) are
  told, and the alert is retried for 7 days. Your phone alone can turn the limit back on, since that only tightens.
  After a recovery, the new wallet starts with the limit back on at its last value (0 when that is not known), until
  your hardware wallet turns it off again. Phones offer it only to a guardian that reports the `limit_off` feature
  (`guardian.status.features`); older guardians keep refusing it. The guardian web page shows "No daily limit" on
  Home and Rules (#53).
- **App: a new wallet leads with Receive.** Right after setup, Home showed 0 and an active Send that only failed two
  screens later. While a wallet has no balance and no payments, Receive is the main button, and Send opens a sheet
  that explains how to receive first (#46).
- Guardian web: Settings, Relays says "add it back" or "add them back" to match how many relays you stop watching,
  and its remove buttons are larger touch targets (#48).
- CI also opens every PR's app in the iOS Simulator (a Release build for the simulator, no signing and no Apple
  account) and fails on a crash at start, with the crash report and the app's log lines in the check's annotations
  (`ios-launch.yml`). The iOS build instructions now build Release, so the app runs without Metro (#49).
- CI also walks through the demo after the launch check, on the Android emulator and in the iOS Simulator, with Maestro
  (`apps/mobile/.maestro/demo-walk.yaml`: Welcome into Demo mode, Home, Send to the amount, Receive, Settings, Activity),
  and fails the pull request when a step fails or the app crashes on the way, with the failing step, Maestro's error,
  what was on screen and the app's log lines in the check's annotations (#51).
- Docs: the test plan installs the APK from the Releases page and explains testing on an iPhone from your own Mac
  (#52); [docs/https-access.md](docs/https-access.md) explains reaching the guardian over HTTPS (Tailscale first, your
  own domain second), which passkeys will need (#47); design proposal for an optional Savings wallet that phone and
  guardian cannot spend, and for turning the limit off:
  [docs/design/savings-and-limit-off.md](docs/design/savings-and-limit-off.md) (#50); decisions for passkey unlock
  (#44).
- Site: `trikey.app/passkey-test` checks whether your password manager supports the passkey PRF extension that
  passkey unlock will need (#43).

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
