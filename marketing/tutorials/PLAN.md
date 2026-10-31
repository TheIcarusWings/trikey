# Setup tutorials: plan

Short videos that walk a tester through installing and setting up Trikey, step by step, following
`docs/alpha-test-plan.md`. They're for people who are about to test, so they're practical: no story, no music bed
under the important bits, and every step visible on screen.

Status: **plan, waiting for the owner's go-ahead.** Nothing is produced yet.

## Ground rules

- **The test plan is the source of truth.** Each video names the test-plan section it follows. When the plan or
  the UI changes, the video is re-rendered from the repo, not edited by hand.
- **Test networks first.** Every walkthrough runs on **signet**. Mainnet appears once, in video 3, with the app's
  own warning on screen and a line saying plainly: pre-alpha, not audited, only an amount you can afford to lose.
- **Fake data only.** Demo balances, `tb1q…` demo addresses, the demo contacts. No real keys, seeds, npubs, IPs or
  hostnames. Recovery codes on screen are visibly fake (the demo's).
- **No third-party logos.** Umbrel, Ledger, Trezor and GitHub are named in text. Their screens are shown as clean
  illustrations, or as real screen recordings the owner provides.
- **Honest status.** Every video opens with the release it was made for ("Trikey 0.1.7-alpha · signet") and ends
  with "Pre-alpha · not audited".

## The videos

Each is 16:9 at 1080p (the format for YouTube, the website and desktop viewers), 1 to 3 minutes long, with burned-in
step captions and a WebVTT file. The list follows the controller's suggestion, refined:

| # | Video | Follows | Length | Footage |
|---|---|---|---|---|
| 1 | **Install the guardian on Umbrel** | "Install the guardian on the Umbrel", step 1 | ~2:00 | Umbrel steps: illustration (or owner's recording). Guardian: web UI mocks |
| 2 | **Install the app** | "Install the APK", "Or on an iPhone" | ~1:30 | GitHub release page, Android install prompts: illustration. 0.1.7 "Check for updates" row: app |
| 3 | **Create your wallet** | Steps 2 to 5 | ~3:00 | App + guardian web mocks side by side; hardware wallet: illustration |
| 4 | **Receive and send** | Steps 6 to 8 | ~2:00 | App; hardware approval: illustration |
| 5 | **Lock, unlock and change your limit** | Steps 9 and 10 | ~1:30 | App + guardian web (`locked`, `limitoff`) |
| 6 | **Lost your phone?** | Steps 11 and 12 | ~2:30 | App (restore, recovery) + guardian web (`recovery`, `recoveryready`) |

Video 1 also covers the troubleshooting cards most testers hit: the "401" when the store address is mistyped, and
"Create guardian" staying disabled while Electrs syncs. Replace guardian (step 13) and the developer self-test
(step 14) are left out: too niche for video.

### Script outlines

1. **Install the guardian on Umbrel.** What the guardian is (key 3, on your own server) → App Store, ⋯, Community
   App Stores → paste the store address (copy, don't type) → install Trikey Guardian (Umbrel adds Bitcoin Node and
   Electrs if missing) → open it from the home screen, not by port → "Set up your guardian": node and Electrs found,
   network shown → choose a passphrase → relays → "Create guardian" → after a restart: unlock (from the phone or the
   page). Card: "Create guardian stays grey? Electrs is still syncing."
2. **Install the app.** Android: the newest pre-release on GitHub Releases → download the APK (check the
   `.sha256`) → allow installs from this source → Play Protect warning is expected. From 0.1.7: updates install over
   the old app; Settings › About › Check for updates (and Obtainium, if the controller confirms the setup). iPhone:
   one card with the Mac + free Apple ID route and the 7-day limit, pointing to the test plan.
3. **Create your wallet.** First screen: network picker (signet), the pill → connect the hardware wallet (Ledger:
   the "Bitcoin Test" app; Trezor: Suite Lite) → verify the first address on the device → on the guardian page,
   make a pairing code (lasts 5 minutes, works once) → scan it → protection: daily limit, waiting period, alert
   contacts → approve on the hardware wallet → backup: write the recovery code on paper, save the backup file →
   Home, leading with Receive. A short mainnet aside: the warning switch, and what changes.
4. **Receive and send.** Receive address → fund from a signet faucet → send inside the limit: phone + Face ID, the
   guardian co-signs → send over the limit: the app asks for the hardware wallet, approve on the device.
5. **Lock, unlock and change your limit.** Lock the guardian from the phone; unlock from the phone or the page →
   raise the limit with a hardware approval → (advanced) turning the limit off, and the alert it sends.
6. **Lost your phone?** Have the backup: restore on a new phone, no waiting. No backup: hardware wallet + guardian
   start a recovery, the waiting period and daily alerts, anyone can cancel a fake one, the move to the new wallet.

## How the footage is made

Everything that can be regenerated from code is:

- **App screens.** First choice: the app's **Demo mode**, driven by **Maestro flows with `startRecording`** on the
  CI Android emulator. A new workflow (`tutorials-record.yml`, manual trigger) runs the flows in
  `apps/mobile/.maestro/tutorials/` and uploads the recordings as an artifact. The same flows run in the iOS
  Simulator if we want iPhone footage. Fallback: the app's web build in Demo mode, recorded with Playwright in a phone
  frame (runs in this session's container).
- **Guardian web pages.** `apps/guardian-web` under vite with `?mock=firstrun|locked|unpaired|recovery|recoveryready|limitoff`,
  recorded with Playwright in a browser frame.
- **Hardware wallets, Umbrel, GitHub, Android system prompts.** Clean illustrations drawn in HTML/SVG, with the
  real labels and button names but no logos. If the owner records real Umbrel or device screens (no personal data
  on them), they replace the illustrations.
- **Composition.** The existing HTML timeline renderer in `marketing/render/`: phone and browser frames, numbered
  step captions, tap highlights, zooms on the part that matters, chapter cards, burned-in captions plus a WebVTT file.
- **Voice.** Captions only by default: tutorials are often watched muted, and captions re-render for free when the
  UI changes. A voiceover can be added later with the same stock voice as the films (about 0.2 Higgsfield credits a
  line; roughly 15 credits for all six videos including retakes). That spend needs a separate yes.

## What I need from the app (asked through the controller, not changed by me)

1. **A demo walk through setup.** Can Demo mode run the onboarding screens (connect hardware, scan guardian,
   protection, backup) with a simulated hardware wallet and a simulated pairing? If not, a "tutorial" flag that
   makes those steps succeed with fake data would let Maestro record them.
2. **Stable testIDs** on the onboarding screens, the send flow's limit and hardware-approval screens, and the
   recovery screens, so the flows don't depend on wording.
3. **Fixed demo data**: the same balance, addresses and contacts every run, so re-renders match.

## Where things live

- `marketing/tutorials/`: this plan, one script file per video (steps, captions, timing), and the illustrations.
- `apps/mobile/.maestro/tutorials/*.yaml` and `.github/workflows/tutorials-record.yml`: app recording (through a
  PR the controller reviews).
- `marketing/render/videos/t1-…t6-….html`: the compositions. `marketing/render/make.sh t1` re-renders one.
- Outputs (git-ignored): `marketing/out/trikey-t<n>-<name>.mp4`.
- Website: 720p web cuts in `site/media/tutorials/` and a **trikey.app/setup** page that lists them in order next to
  the matching test-plan steps (built together with the landing-page session).

## Order of work

1. Owner's go-ahead on this plan (and on the voiceover question).
2. Video 1 first, as the pilot: guardian web footage from the mocks plus Umbrel illustrations. The owner reviews it
   before the rest are made.
3. The Maestro recording workflow and flows, once the controller confirms what Demo mode can show.
4. Videos 2 to 6, then the /setup page.
5. Re-render after each release that changes a screen shown in a video.
