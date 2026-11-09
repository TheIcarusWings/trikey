# Trikey alpha test plan: guardian mode on mainnet or a test network

A checklist for the first hands-on test, written for the owner of the Umbrel. It covers **guardian mode only**,
with an **Android phone**, a **Ledger (Bluetooth) or Trezor (through Trezor Suite Lite)** and the **Umbrel** as the
guardian's box. You choose one of two paths: **mainnet** on your everyday node, with a small amount of real bitcoin, or a
**test network** (signet or testnet4), with test coins. "Before you start" explains both.

Plan on two sittings: one evening for "Before you start", then an afternoon for steps 1 to 11 and 14. Steps 12 and 13 are
separate; 15 to 17 are optional and can come any time after step 11, and step 12 takes a week if you let it finish. On mainnet, add the time Electrs needs to index the chain if it is
not indexed yet, which can be a day or more on a fresh install.

How to read it. Each step says what you do, **what you should see**, and **if it goes wrong, collect**: what to write down and
send me. "Settings" means the gear on Home, or the Settings tab in older builds. "Guardian page" means the guardian's web
page, opened from the Umbrel dashboard. Keep a notes file open and paste into it as you go (the bug report template is at the end).

---

## Before you start

### Pick your path: mainnet or a test network

Trikey is **pre-alpha and not audited**. Both paths test the same things; they differ in what is at risk and in what you
have to do to the Umbrel. **The phone's network must match the node's.** It is chosen once: a wallet is made on one network
and cannot change networks later, and the guardian remembers the network of its wallet and refuses to start on another.

**Path A: mainnet, on your everyday node.** You keep the node as it is. Nothing to switch.

- **Real bitcoin is at risk.** Use only an amount you can afford to lose. The app makes you accept a warning to that effect
  before it lets you go on (see the first screen under "The steps").
- **At least one alert contact is required.** On mainnet the guardian will not pair without one, and the app does not let you
  skip that step (step 4).
- **Electrs must be fully indexed before chain data shows.** The guardian's **Create guardian** button stays disabled until it
  finds the node and Electrs, and the wallet shows no chain data until Electrs has caught up. If Electrs already runs on your
  Umbrel and says it is synced, you are fine. On a fresh install the index can take a day or more.
- **What looks different on mainnet.** There is no coloured network strip across the top of the app, and the first screen's pill
  says "Pre-alpha · not audited · open source" instead of "Pre-alpha · test network". The Ledger needs the **Bitcoin** app, not "Bitcoin Test".
  Addresses start with `bc1`.
- You fund the wallet with a small amount sent from your own wallet (step 6), and your test payments go to your own wallet too.

**Path B: a test network (signet or testnet4).** No real money, but the Umbrel's node has to run that network (see "Signet or
testnet4 on the Umbrel").

- A coloured strip across the top of every screen says "Signet · pre-alpha · coins here have no value" (or Testnet).
- The Ledger needs the **Bitcoin Test** app. Addresses start with `tb1`.
- An alert contact is optional on a test network (the guardian then warns that none is set), but this plan adds one in step 4 anyway.
- You fund the wallet from a faucet (step 6).

**Signet is the easier test choice.** It is small, quick to sync, and its coins are easier to get. Testnet4 works the same way in
the app. In the app the picker says **Testnet** for testnet4; it uses the same address and key formats (`tb1...`). The guardian
maps Umbrel's `testnet4` to the same thing, so the app cannot tell testnet4 from the old testnet3. **Be sure the node and the
faucet are both testnet4** (or both signet, which has its own picker entry and no ambiguity).

### What you need

- The Android phone (Android 7 or newer), with the camera, Bluetooth and "Nearby devices" permissions allowed when the app asks.
- The Ledger (Nano X, Stax or Flex: the ones with Bluetooth) **with the right Bitcoin app installed**, or a Trezor with Trezor
  Suite Lite on the phone.
  - Ledger: mainnet uses the **"Bitcoin"** app; the test networks use a separate app, **"Bitcoin Test"**. Install the one for your
    path from Ledger Live. "Bitcoin Test" may only show up in the catalogue once Developer mode is switched on in Ledger Live's settings.
  - Trezor: the phone talks to the Trezor through Trezor Suite Lite (Trikey hands the request over and gets the answer back). Install
    Suite Lite first and open it once. On a test network, if Suite Lite will not show test coins, stop and tell me: that is a finding.
- Updated firmware on the hardware wallet. Note the model and firmware version now; the bug reports ask for them.
- A nostr app on your phone or computer with an account whose **npub** you know (Damus, Amethyst or Primal). You will add that npub as an
  alert contact and the guardian will send it direct messages. In that app, check that it has a DM (inbox) relay list set; the
  guardian delivers alerts to it.
- Paper and a pen. The recovery code is shown once.
- Another wallet of yours to send coins to, on the same network as the Trikey wallet (Sparrow, Electrum or anything else). Its
  addresses start with `bc1` on mainnet and `tb1` on a test network. On a test network, returning coins to the faucet's address also works.
- Mainnet only: a small amount of bitcoin in that other wallet, to fund the Trikey wallet with.

### Signet or testnet4 on the Umbrel (Path B only)

On Path A, skip this section and go to "Electrs and the node".

What I could confirm, and what I could not.

- Confirmed in the code of Umbrel's Bitcoin app (`getumbrel/umbrel-apps`, `bitcoin/exports.sh`): the app reads a `chain` setting
  and passes `testnet4`, `signet` and `regtest` through as its network (and `main` and `test` as mainnet and testnet). Umbrel
  then exports that network as `APP_BITCOIN_NETWORK` to every app that depends on the node. Electrs gets it too
  (`ELECTRS_NETWORK` in the Electrs compose file), and the Trikey guardian's compose file also uses it (`BITCOIN_NETWORK`).
- Not confirmed from Umbrel's own pages: **where the switch is in the interface.** Community posts say it is in the Bitcoin Node
  app, under Settings, Advanced settings, a Network option, followed by a restart. I could not open those posts from here, so
  look for that option in your Umbrel version. If there is no such option, tell me before editing any files on the box.
- **One network at a time.** The node runs one chain. While it is on signet, anything else on the box that needs the mainnet node
  (Lightning, mempool, other wallets) is down or confused, and Electrs has to build its index for the new network. Mainnet data
  is kept on disk, so switching back later resumes it. If the Umbrel is your everyday node, think about whether that is
  acceptable, or use Path A, or a spare box.
- Whether Electrs v0.11 indexes testnet4 cleanly is something I have not seen. Signet is the safer bet.

Do this:

1. In the Bitcoin Node app, switch the network to **signet** (or testnet4) and restart the node. Let it sync.
2. Install **Electrs** if it is not installed. Open it and wait until it says it is synced.
3. Check the node and Electrs both say the new network.

### Electrs and the node (both paths)

Wait for Electrs to finish syncing before the guardian's setup page will let you continue.

- **Versions:** Electrs 0.12 needs a recent Bitcoin Core (one with the `/rest/spenttxouts` REST endpoint,
  bitcoin/bitcoin#33657) and the node's REST interface turned on. Trikey's CI tests against Bitcoin Core 32.1 with
  Electrs 0.12.0. If Electrs keeps restarting with "failed to open index … http status: 404", the node is too old
  or REST is off; Umbrel's own apps normally pair matching versions, so update both from the App Store first.
- A quick check on the box: `sudo docker ps` should show both running, and the guardian's first-run page (below) reports
  whether it found them.

### Install the guardian on the Umbrel

Each release publishes a public, multi-arch image, `ghcr.io/theicaruswings/trikey-guardian:<version>`, and a community app
store, `https://github.com/TheIcarusWings/trikey-umbrel-store`, that installs it. The store pins the image by digest. It
currently carries version 0.1.1-alpha. Nothing to build, and no SSH needed.

1. In Umbrel, open the **App Store**, then the **⋯** menu, then **Community App Stores**.
2. Paste exactly `https://github.com/TheIcarusWings/trikey-umbrel-store` and press **Add**. Copy and paste it rather than
   typing it: a typo shows "HTTP Error: 401 Unauthorized", because GitHub answers an unknown repository with a login request.
3. Open the **Trikey** store that now appears, and install **Trikey Guardian**. It needs Bitcoin Node and Electrs; Umbrel installs
   them if they are missing.
4. Open **Trikey Guardian** from the Umbrel home screen. Do not type `umbrel.local:3010` into the browser: Umbrel's login
   protects the app, and only the home-screen icon goes through it. The guardian has no password of its own, so never publish
   its port on your network or the internet.

You should see: the guardian's "Set up your guardian" page (step 1).

Optional, for passkeys later: to reach the guardian over HTTPS (Tailscale first, or your own domain), see `docs/https-access.md`. It is not needed for this test.

**To update to a newer release:** in the App Store, refresh the Trikey store, then update the app (or reinstall it).

**Umbrel backups leave the guardian out, on purpose** (from the release after 0.1.21-alpha; as on Start9). They would be
one more copy of key 3 and its secrets, and a restored copy would bring back old limits and spending. So an Umbrel
restored from a backup does not bring the guardian back: Trikey Guardian starts empty, as on a new box. Set it up again
(step 1), then in the phone app Settings, **Guardian**, **Replace guardian**, with the phone and the hardware wallet
(step 13). If you test a restore, write down whether the guardian started empty and whether its page loaded (it must be
able to write its data folder). An Umbrel backup made by 0.1.21-alpha or earlier still holds the guardian's data: treat
it like the passphrase it was made with.

**Logs.** In Umbrel: Settings, Troubleshoot, then the app. Over SSH:
```sh
sudo umbreld client apps.logs.query --appId trikey-guardian
sudo docker logs --tail 300 trikey-guardian_server_1      # same, from Docker
```
Guardian log lines have one event per line and carry no keys or request bodies, so they are fine to send.

**If the install does not work:**

- **"HTTP Error: 401 Unauthorized" when adding the store.** The address is not exactly the one above. Paste it again.
- **"Refused to connect" on the app's port.** The app is not running at all: the install has not finished, or it failed. Check the
  App Store entry and the logs. It is not a guardian problem yet.
- **The guardian exits at once, and the log says "/data is not writable by this process (uid 1000; the folder belongs to uid 0)".**
  Its data folder was created by Docker as root. From 0.1.1-alpha the store ships the data folder, so a new install is fine.
  On an older install, uninstall the app and install it again. (That deletes the guardian's data, so do it before you have a wallet on it.)
- **The guardian exits at once with "Cannot find package 'zod'".** The 0.1.0-alpha and 0.1.1-alpha images left a dependency out
  and cannot start at all. Refresh the store and install 0.1.2-alpha or later.
- **A 502 right after setup, and the log ends with "Maximum call stack size exceeded" (nostr-tools `pool.js`).** One nostr relay
  could not be reached, and up to 0.1.2-alpha that took the whole guardian down. Fixed in 0.1.3-alpha: update from the store.
- **A 502 that stays after the guardian crashed.** Up to 0.1.3-alpha a crash ended with exit code 0, which Umbrel's
  `restart: on-failure` takes for a deliberate stop, so the app stayed down. Restart it from the Umbrel home screen (right-click or
  long-press the app). Later versions exit with 1 after a crash, so Umbrel restarts them by itself.
- **"No relay is connected" on the guardian's Home.** The Umbrel cannot reach any of the chosen relays, so the phone cannot reach the
  guardian either. Check the box's internet connection (a relay that is down only matters if all of them are). From 0.1.8-alpha
  the relays can be changed in the guardian's web UI (Settings, Change relays); note which ones you use in the bug report.

**From source (developers).** To test a commit that is not released, build the image on the box and install a copy of the app that
uses it. This follows `packaging/README.md`. I have not run it on a real Umbrel, so treat each step as "check, then continue".

1. SSH in and get the source at the commit you want to test: `git clone https://github.com/TheIcarusWings/trikey.git`, then
   `git checkout <commit or tag>`.
2. Build the image on the box, so it matches the CPU (Intel or Raspberry Pi). It takes a few minutes, and more on a Pi:
   `sudo docker build -f packaging/docker/Dockerfile -t trikey-guardian:local .`
3. Copy `packaging/umbrel/trikey-guardian` to `~/trikey-guardian-app`, and change `image:` in its `docker-compose.yml` to
   `trikey-guardian:local`. Leave the rest alone.
4. Copy that folder into the official store's folder under `~/umbrel/app-stores/` (run `ls ~/umbrel/app-stores/` first; the name
   differs per box), check that `sudo umbreld client appStore.registry.query` lists `trikey-guardian`, then run
   `sudo umbreld client apps.install.mutate --appId trikey-guardian`. Umbrel may remove a folder it does not know after an
   update; repeat this step if the app disappears. The guardian's data lives in the app's own data folder.
5. Open it from the home screen, as above. Uninstall it before you install from the store, so there is only one Trikey Guardian.

**Start9 variant.** The steps in the app are the same, but Start9 is out of this round (see "Known limits"). The package
(`packaging/start9`) now builds in CI: every pull request that touches it, and every release, makes an x86_64 and an aarch64
`.s9pk` (workflow artifacts of `.github/workflows/start9.yml`). Nobody has installed one on a Start9 server yet, and they are
signed with a throwaway key, so they are not attached to releases (`packaging/start9/README.md`, "CI"). It is written for
Start9's Bitcoin package, which runs mainnet only (`BITCOIN_NETWORK: 'bitcoin'` in `startos/main.ts`), so it would only fit
Path A. A maintainer who sideloads one: report the install flow (the web UI password task, then the setup screen without a
setup code) and whether the guardian sees Bitcoin and Electrs.

### Without Umbrel or Start9: plain Docker (a Mac, a PC, Linux, a NAS)

From the release after 0.1.8-alpha the guardian also runs with Docker Compose on any computer with Docker, against a
node and Electrum server (Electrs or Fulcrum) you already have somewhere: on another box (Umbrel, Start9, RaspiBlitz,
myNode), on a NAS, or in the same compose file (`--profile node`). The full guide, with the steps for Docker Desktop on
Mac and Windows, Linux, Synology, QNAP, Unraid and TrueNAS, is [`packaging/compose/README.md`](../packaging/compose/README.md).
In short:

1. From the release page, download `trikey-guardian-compose.yml` (save it as `docker-compose.yml`) and
   `trikey-guardian.env.example` (save it as `.env`) into a new folder.
2. In `.env`, set `BITCOIN_NETWORK` (the network you picked above) and `ELECTRUM_HOST` (your Electrum server's address;
   `ELECTRUM_TLS=1` for one on another machine that offers TLS).
3. `docker compose up -d`, then `docker compose logs guardian | grep setup.code`: the **setup code**. With no platform
   login in front of the page, the guardian asks for it before the first setup, so nobody else who reaches the port can
   set it up before you.
4. Open <http://localhost:3000> (on a NAS, see the guide's "Opening the web UI from another computer"), enter the setup
   code, and continue with step 1 below.

**The computer must stay on.** The guardian co-signs and sends recovery alerts only while it runs: a laptop that sleeps
stops both (the guide says how to keep a Mac or a PC awake). A NAS is ideal. After every restart, unlock it (step 9).

Note in the bug report: the platform (Docker Desktop on Mac or Windows, Linux, which NAS), and where your Electrum server
runs.

### The guardian needs a node and Electrs that are ready

The guardian's first screen ("Set up your guardian") shows whether it found the node and Electrs. Its **Create guardian** button
stays disabled until both are found. If it will not enable, your Electrs is probably still syncing or on a different network from
the node. Do not make a guardian on the wrong network: the guardian remembers the network of its wallet and refuses to start on another.

### Coins and limits

Get your first coins sent to an address from the app (step 6), not to a different wallet. Choose the daily limit to match what you have.

**Path A, mainnet.** Decide the amount now, and make it small enough to lose. Network fees on mainnet are real money too, so
count them in. For example, with 60,000 sats: set the limit to 20,000, pay 5,000 (inside the limit), pay 25,000 (over it),
raise the limit to 50,000. No faucet is involved: you fund the wallet from your own wallet in step 6.

**Path B, a test network.** Faucets change, rate-limit and run dry; check the current limits before relying on one.

- Signet: signetfaucet.com is the usual one (it pays small amounts, on the order of a few thousand sats a request, once a
  day per address and per IP). Others exist; ask in a signet chat if it is empty.
- Testnet4: mempool.space has a testnet4 faucet; testnet.help and CypherFaucet were also listed as working recently.

Because faucet amounts are small, the same example applies: with 60,000 sats, set the limit to 20,000, pay 5,000 (inside the
limit), pay 25,000 (over it), raise the limit to 50,000.

### Install the APK

Where it comes from: every release on [GitHub's Releases page](https://github.com/TheIcarusWings/trikey/releases) has
`trikey-alpha-v<version>.apk` and its `.apk.sha256`, built by the **Android test APK** workflow
(`.github/workflows/android-apk.yml`). Take the newest pre-release.

**Which APK.** From 0.1.9-alpha a release has two APKs; from 0.1.23-alpha they are two apps (each with its own wallet),
pick one or install both:

- `trikey-alpha-v<version>.apk`, the **standard** build, **Trikey** on the home screen: it contains Google's libraries (ML Kit reads the QR codes, and
  Google Drive backup can be switched on in a later release; that needs Google Play services on the phone).
- `trikey-alpha-foss-v<version>.apk`, **no Google code**, **Trikey FOSS** on the home screen: for a phone without Google Play services (GrapheneOS, /e/OS,
  LineageOS) or if you prefer it. The open source zxing-cpp reads the QR codes. It never offers Google Drive backup: the
  backup is the recovery code plus the backup file, which you can still put in Google Drive or anywhere else yourself from
  the share sheet. Settings → About shows "Trikey (no Google)".

Both are signed with the same key, but they have their own application id (`app.trikey.wallet` and
`app.trikey.wallet.foss`): they sit side by side, and installing one never touches the other's wallet. Today they do
the same, because Google Drive backup is not switched on yet; the difference to test is the QR scanning.

**Had the no-Google APK of 0.1.21-alpha or earlier?** It had the standard app's id, so the new FOSS APK installs as a
second app next to it, empty, and your wallet stays in the old one. Restore it in Trikey FOSS ("I already have a Trikey
wallet", "My phone, but I have its backup", backup file and recovery code), check it is there, then uninstall the old app.
Or install the standard APK over the old app, which keeps the wallet. The steps are in
[docs/android-signing.md](android-signing.md), "Moving from the no-Google APK". Please test it and report:

1. With the old no-Google build (0.1.21-alpha or earlier) holding a wallet, install the new FOSS APK. It appears as a
   second app, **Trikey FOSS**; the old one (**Trikey**) still opens with its wallet.
2. Trikey FOSS opens on Welcome with "Used Trikey without Google before?"; tapping it explains the move.
3. Restore the backup in Trikey FOSS. It shows the same wallet and balance; a payment from it works.
4. Uninstall the old app; Trikey FOSS still works. Settings → About says "Trikey (no Google)", and Check for updates
   offers the FOSS APK.
5. Both apps on one phone (the standard one and Trikey FOSS, each with its own wallet): a Trezor through Trezor Suite Lite
   answers to the app that asked, with no "Open with" question (the FOSS app's links are `trikey-foss://`). If you have the
build without Google code, scan every kind of code the plan asks for (pairing code, contact, address, an animated QR from
your hardware wallet, the Recovery Kit) and note in the report that you used `foss`. Before a release is made, every pull request that touches
the app already builds it and opens it in an Android emulator (and in the iOS Simulator), so a build that crashes at start
does not reach a release. A local build is in `apps/mobile/README.md`, "Android".

What kind of build it is:

- A **release build** with the app's code inside it. Nothing needs to run on a computer, and it starts in **Real** mode.
- From 0.1.7-alpha, signed with the **Trikey release key**: a newer release installs over the older one of the same app
  and the wallet on the phone stays. To get updates without downloading by hand, use Obtainium ([docs/android-signing.md](android-signing.md)).
  Builds up to 0.1.6-alpha had a one-off key each: to move from one of those, **uninstall it first, which deletes the wallet
  on that phone**. Back up first.
- No passkeys and no Google Drive or iCloud backup in this build. The backup is a recovery code plus a backup file.
- Built for 64-bit phones by default (every phone from the last several years).
- The build without Google code is checked when it is made: no Google Play services, Firebase, ML Kit or Google data
  transport code is in it.

To install: check the file against the `.sha256`, copy the APK to the phone, open it, and allow installing from that source
when Android asks.

**Play Protect.** Android may stop the install with "Unsafe app blocked" (or "App scan recommended"). That is expected for
any APK from outside the Play Store that Google has not seen before; it says nothing about this file. Tap **More details**,
then **Install anyway**. What does tell you the file is the real one: its SHA-256 matches the release's `.sha256`, and it
is signed with the Trikey release certificate (`apksigner verify --print-certs`, compared with
`packaging/android/release-cert.sha256`; see [docs/android-signing.md](android-signing.md)). The warning can come back with
an update; the same two checks apply.

**Updating the app.** A newer release installs over the installed one and keeps the wallet (both are signed with the Trikey
release key). Three ways, pick one:

- In the app: **Settings → About → Check for updates**. It asks GitHub only when you tap it, says whether a newer version
  exists, and **Download** hands the APK to Android's installer. It offers the APK of the build you have (standard or
  without Google code). Check the SHA-256 it shows against the release's `.sha256`. If Play Protect blocks it, see
  above: **More details**, **Install anyway**, after the checks.
- Obtainium, which watches the repository's releases for you: see [docs/android-signing.md](android-signing.md), with the
  filter for the APK you want.
- By hand, from the Releases page, as above.

Note in the report which way you used, and that the wallet was still there after the update.

### Or on an iPhone (a Mac is needed)

There is no TestFlight build in this round (that needs a paid Apple Developer account), so an iPhone gets the app from your
own Mac, signed with a free Apple ID.

1. On the Mac: Xcode, signed in with your Apple ID (Xcode, Settings, Accounts). A free account is enough.
2. Get the code at the release you are testing and install its packages:
   `git clone https://github.com/TheIcarusWings/trikey.git`, `cd trikey`, `git checkout v<version>`, `npm ci`.
3. Plug the iPhone in and build a Release build onto it (it runs on its own, without the Mac):
   ```sh
   cd apps/mobile
   TRIKEY_DISABLE_ICLOUD=1 TRIKEY_IOS_BUNDLE_ID=com.<yourname>.trikey npx expo run:ios --device --configuration Release
   ```
4. On the iPhone: Settings, General, VPN & Device Management, trust your developer profile. Then open Trikey.
5. Seven days later the profile expires and Trikey stops opening. Build it again; if `expo run:ios` then fails with
   `No profiles … were found`, use `xcodebuild -allowProvisioningUpdates` as in `apps/mobile/README.md` ("Renewing an
   expired profile"), and trust the renewed profile on the phone again. The wallet stays on the phone.

If the build stops with an error, `apps/mobile/README.md` ("iOS (free Apple ID)") lists the snags met on a first build and their
fixes (UTF-8 shell for CocoaPods, the device UDID, the iOS platform download, opening Xcode once for the signing profile).

You should see: the same first screen as on Android. The steps below are the same; where they name an Android screen or
setting, use the iPhone's equivalent and note any difference in the report.

Things to know:

- A free Apple ID's install lasts **7 days**. After that the app stops opening until you run step 3 again. The wallet stays on
  the phone, but make a backup first anyway.
- No iCloud backup and no passkeys in this build (a free Apple ID cannot sign them); the backup is a recovery code plus a
  backup file, as on Android.
- Ledger over Bluetooth works the same way; iOS asks for Bluetooth permission the first time.

---

## The steps

In the app, setting up a wallet is one flow in this order: **hardware wallet, then scan the guardian, then limit and waiting
period (approved on the hardware wallet), then backup.** Steps 1 to 5 below follow that flow, with the guardian's own setup first.
The guardian's pairing code lasts 5 minutes and works once, so only make one when the app is on the scan screen.

Open Trikey. The first screen has a **Network** picker, and a small **wallet mode** link under the buttons. Pick the network of
your path here, before "Create a wallet"; it must match the node's, and it cannot be changed afterwards.

- **Path B:** pick Signet (or Testnet for testnet4). The pill says "Pre-alpha · test network".
- **Path A:** pick Mainnet. The pill changes to "Pre-alpha · not audited · open source", and a warning appears, "Mainnet means real bitcoin":
  Trikey is pre-alpha and has not been audited, a bug could lose what you put in, use only an amount you can afford to lose.
  Switch on **I understand, and I'll use a small amount**. Until you do, "Create a wallet" and "I already have a Trikey
  wallet" stay disabled. Mainnet is offered in guardian mode only.

### 1. Guardian setup and passphrase

Do:

- Open Trikey Guardian. On "Set up your guardian", choose a **passphrase of at least 12 characters** (a few random words
  work), type it twice, and keep the three public relays ticked unless you have a reason not to.
- Write the passphrase down on paper, with the date. Nobody can recover it for you.
- Press **Create guardian**.

You should see: the Pairing page ("Pair a phone") with a QR code, and a Dashboard that says **Unlocked**. The Dashboard shows
the node and Electrs ("Chain data") as found. Restart the guardian from Umbrel once (or reboot the box): it comes back
**Locked**, and the web page asks for the passphrase. Unlock it, and the Dashboard says Unlocked again. This is by design:
after every start the guardian is locked until you unlock it.

If it goes wrong, collect:

- A screenshot of the setup page and of the Dashboard.
- The guardian log (Umbrel Settings, Troubleshoot, or `sudo docker logs --tail 300 trikey-guardian_server_1`), and `sudo docker ps` output.
- Which network the node says it is on, and the Electrs sync state.
- Do not send the passphrase.

### 2. Pairing (QR scan)

Do (this follows the hardware step in the app; see step 3):

- On the app's "Pair your guardian" screen, point the camera at the guardian's QR code from **Pair a phone**.
- No camera, or the scan will not take? Paste the code in the box under the camera ("trikey://pair?...").

You should see: "Reaching your guardian...", then "Guardian found" on the next screen. On the Guardian page, Pair a phone
now lists the phone as paired.

If it goes wrong, collect:

- The exact message under the camera, and how long after making the code you scanned it (the code expires after 5 minutes and works once).
- The guardian log around that minute. Wrong attempts burn the code: make a new one and try once.
- Whether the guardian's relays are reachable from the Umbrel (a relay that is down or rate-limiting looks like a timeout). Try
  other relays if the guardian was set up with only one.
- The relay list shown at Settings, Guardian, Relays.

### 3. Connect the hardware wallet and verify the first address on the device

Do:

- In the app, "Create a wallet", **Continue**, then pick your device. Ledger: unlock it, open **Bitcoin** (mainnet) or
  **Bitcoin Test** (test networks), keep Bluetooth on, approve sharing the public key. Trezor: unlock it, keep it connected;
  Suite Lite opens and returns you to Trikey. When the Trezor signs Trikey's messages (pairing, and every hardware approval
  later), firmware before 2.13.0 and the Model One first warn about the path ("Unknown derivation path" or "Wrong address
  path for selected coin"): that is expected, continue. Note in the report which one you saw, with the firmware version.
  If Suite Lite returns you to Trikey but Trikey keeps waiting, tell me: each request carries a one-time check that the
  answer must bring back, and a Suite Lite that drops it would be a finding.
- During setup the device asks you to approve the new 2-of-3 wallet (the app's checklist for your device lists it; it may come
  at the connect screen or at "Approve on Ledger" once you set the limit in step 4). **Read the device's screen**: it should say
  Trikey and 2 of 3.
- Once you are on Home, go to **Receive**, then **Verify on Ledger** (or Trezor). The device shows the address.

You should see: "<device> connected", a device prompt for the wallet, and on the verify screen "Your device agrees". **Compare the
address on the device with the one on the phone yourself**, at least the first and last groups of characters. The app says
"Your device agrees" when its own check passes; you are the second check.

If it goes wrong, collect:

- Device model and firmware, Ledger app version ("Bitcoin" or "Bitcoin Test"; or the Suite Lite version), the phone's Android version.
- The exact message shown ("Couldn't connect", "wrong network", "address mismatch").
- Whether the device screen showed anything at the moment of the failure, and what.
- If the app says the Ledger returned a key for the wrong network, you probably opened the wrong Ledger app: "Bitcoin Test" on
  mainnet, or "Bitcoin" on a test network.
- **If the two addresses differ, stop and report it before using the wallet.**

### 4. Rules and contacts

Do:

- During setup, "Set your daily limit": pick a limit that fits the coins you will fund the wallet with (use Custom) and the waiting
  period (7 days is the shortest). The button "Approve on Ledger" has the device approve the rules. With a guardian and an app
  from this release the device asks for **one more confirmation** after the pairing text and the wallet: a text that starts
  `Trikey policy v1 wallet=... seq=0` (or `v3`, with `lock=on`, when contacts may lock the guardian). **Read it on the
  device**: `limit=` must be the daily limit you chose, in sats, and `delay=` the waiting period (`7d`); `feecap=` is the
  sweep fee cap and `contacts=` the number of alert contacts. `seq=0` means "the rules the wallet starts with". The Guardian
  page's **Rules** must then show exactly those values. The same extra confirmation comes when you add a wallet (18a),
  accept a family invite (18) and replace the guardian (13).
- **With a guardian and an app from this release** the text is `Trikey policy v4 wallet=... seq=0 limit=... delay=7d feecap=...
  lock=off contacts=npub1abcdefgh..wxyz expires=...`: every alert contact by name, as `npub1`, 8 characters, `..` and the
  last 4. **Compare each with the npub in that contact's nostr app** (for "Me": your own); the phone lists them the same way,
  with the names you gave. A contact you do not recognise: reject on the device. With five or more contacts (fewer with huge
  values) the device shows `contacts=<count>:<code>` instead; the Guardian page's **Rules** shows the same code under the
  contacts once they are stored. On a Jade check that the whole `contacts=` part is visible before the "...".
- Each contact gets a nostr message within a minute: "you are now an alert contact of the bitcoin wallet that <guardian
  name> guards". Check that "Me" got it in your nostr app. Activity's "Wallet paired" entry lists the contacts the same way.
- Then in Settings, **Alert contacts**, **Add contact**: name it "Me", paste **your own npub** (or scan it), and approve on the
  device. Adding a contact needs the hardware wallet; that is on purpose. **On mainnet this step cannot be skipped.** On a
  test network the app would let you skip it, but do it anyway, because step 12 needs the contact.

You should see: after approval, the Alert contacts list shows "Me" with the npub as the device showed it (`npub1abcdefgh..wxyz`),
next to "This phone, always included". The device's text named "Me" (`contacts=...`). On the Guardian page, **Rules** shows the
same daily limit, waiting period and the contact (as on the device), and Activity says "alert contacts added: npub1..". "Me"
gets a nostr message saying it is now an alert contact; removing a contact sends that contact "you are no longer an alert
contact" (try it with a throwaway npub you hold).

- Optional, needs an app from before this release and a guardian from this release: change the daily limit (still works:
  the contacts stay the same), then try to add a contact (refused: "Update the Trikey app ... show the alert contacts").

- Optional, needs an app from 0.1.19 or older: pair a **new** guardian (this release) with it. It must refuse with a
  message that says to update the Trikey app, and pair nothing (the guardian's Activity says "Pairing refused: Update the Trikey app..."). An updated
  app pairs a guardian from 0.1.19 or older as before, with no extra confirmation (that guardian does not ask for it).

If it goes wrong, collect:

- The message on the phone and what the device displayed.
- The text the device showed for the rules (a photo is fine: it holds no secret), if the values looked wrong.
- The guardian's Activity page (screenshot) and its log.
- Whether the npub you pasted is the one from your own nostr app (it starts with `npub1`).

#### The phone itself (Security tab)

- Check: with no screen lock on the phone, the **Security** tab says "Set a screen lock"; set one,
  come back to Trikey, and the note is gone. On an Android phone whose last security update is more than 6 months old
  it says "Look for a system update"; in an emulator or the iOS simulator it says the app is fine for testing, not for
  real money on mainnet. None of this is sent anywhere (the guardian's Activity page shows nothing about it).

### 5. Backup: the recovery code and the backup file

Do:

- On "Back up this phone", choose **Create backup with a recovery code**. It takes a few seconds; keep the app open.
- The code is shown **once**. Write it on paper and tick "I've written it down".
- Press **Save backup file** and send the file somewhere that is *not this phone*: Files on a cloud drive, an email to yourself,
  or a computer. Check that you can see the file there. The file ends in `.tkb`. Keep the code and the file apart: either one
  alone is useless.
- Later, Settings, **This phone** shows "Backed up to ...".

You should see: a recovery code of five groups of letters and digits, then the share sheet. No passkey and no cloud choice in this
build ("coming later").

If it goes wrong, collect:

- The message shown, and whether the share sheet opened.
- Whether the backup option says the phone has nowhere to keep a backup.
- **Never send me the recovery code, and never send the backup file and the code together.** On a test network it would be
  harmless, but on mainnet it is not, so build the habit on both: say "I have both" instead.

### 6. Funding the wallet

Do:

- On Home, **Receive**. Copy the address (or show it as a QR code).
- Path B: request coins from the faucet to it.
- Path A: send a small amount to it from your own wallet. Check the address on the device first (step 3), and mind the network fee.
- Pull down on Home to refresh while you wait.

You should see: the balance appears as soon as the guardian's Electrs sees the transaction, and an incoming entry on the
Activity tab (unconfirmed, then confirmed after a block: a few minutes on signet, longer on testnet4, about ten minutes on
mainnet). The guardian's Dashboard stays online. On mainnet, if nothing shows up, Electrs may still be indexing; check its sync state.

If it goes wrong, collect:

- The funding transaction id and the address, and a look at the address on a public block explorer for your network
  (mempool.space has mainnet, signet and testnet4). If the explorer shows it and the app does not, the guardian's node or Electrs is the suspect.
- The guardian log and Electrs's own log in Umbrel.
- The guardian's Dashboard, "Chain data" line.

**Check the guardian's Wallet page** (web UI, **Wallet**, between Home and Activity; view and receive only):

- The balance matches the phone's (an unconfirmed payment is shown apart), the payment is listed under Pending then
  Confirmed with its confirmations, and "Daily limit" shows the same used and left as the phone.
- The address under **Receive** is **the same as the phone's Receive** (compare every character). Reload the page a few
  times: it stays the same. Once your payment to it arrives, both the page and the phone (after a refresh) move to the
  same next address.
- Lock the guardian (step 9): the page still opens (from the Locked screen, **View the wallet**) and the header says
  **Locked**. A txid has a copy button and no link.

If they differ, collect both addresses, a screenshot of each, and the guardian log: the page must never show an address
the phone does not.

### 7. A payment inside the limit

Do:

- Home, **Send**, paste an address from your second wallet, an amount under the daily limit, **Review**.
- Review should say it is signed by this phone and your guardian. Press **Send with fingerprint**.

You should see: no prompt on the hardware wallet. The payment goes out, and shows up in Activity, then confirms. On the
Guardian page, Dashboard "Phone-only today" moves up by the amount plus the fee, and Activity lists the payment as co-signed.

If it goes wrong, collect:

- The message on the Review screen (for example "guardian locked", "offline", "over the limit").
- The guardian's Activity page and log at that time, and the txid if it was broadcast.

### 8. A payment over the limit, through the device

Do:

- Send an amount that, with what you spent today, is over the daily limit. (The limit is counted over a rolling 24 hours,
  outflow plus fee.)

You should see: the app hands over to **Approve on your Ledger** (or Trezor), with a message such as "... is over today's limit
... Your hardware wallet signs this one instead of the guardian". The device shows the amount, the address and the fee: **check
them against the phone.** Approve. The payment goes out without the guardian.

If it goes wrong, collect:

- What the device showed, what the phone showed, and the amounts you used, the limit and the amount already spent today.
- The message under the button if it did not complete, and the device model and app version.

#### Speed up a payment waiting to confirm

Do:

- Send a small payment at **Slow** (step 7) and, before it confirms, open Activity: it says **Speed up ›** under it (also
  on its details screen). It is easiest when the network is busy, or on signet or testnet4 right after a block.
- Tap it. You should see the amount and the address **unchanged**, the network fee now and the new one (sats and
  sat/vB), the three speeds with their fees, and what speeding up costs, all before anything is signed. Pick **Fast**.
- Within today's limit: **Speed up with fingerprint**, no prompt on the hardware wallet, then "Signed. Sending…".
- Then speed the same payment up again at a fee over what is left of today's limit (or with the guardian locked from its
  web page): the screen says the hardware wallet signs this one, and the device shows the same payment with the higher fee.

You should see: Activity shows **one** row for the payment, now "sped up", with the new fee (never the old and the new
side by side, not even for a moment while the guardian's alert comes in); the explorer shows the new transaction and the
old one gone; on the Guardian page, "Phone-only today" goes up by the **extra fee only** for the co-signed speed-up, and
not at all for the hardware one. A send-max payment has no change to pay from, and an incoming payment is not yours to
speed up: the app should say so. On mainnet the new fee is never under 1 sat/vB.

- Check: every speed-up above went through the phone's check of the original before signing; none was refused with
  "This faster payment does not match the payment you sent" (if one was, note the `speedup.check_failed` log line: it
  holds only a reason code).

If it goes wrong, collect: both transaction ids, the fees the screen showed, the guardian's Activity page and the log
lines starting with `tx.broadcast` and `live.wallet_tx`, and whether Activity showed two rows.

### 9. Guardian lock and unlock, from the phone and from the web page

Do:

1. **Lock from the phone.** Settings, **Guardian**, **Lock guardian**, **Lock it now**.
   You should see: Guardian status "Locked on ...", and the web page showing Locked. Try a small payment: the app should hand
   it to the hardware wallet ("The guardian is locked...").
2. **Unlock from the phone.** On the same Guardian screen, type the guardian's passphrase in the unlock box.
   You should see: status "Online", and a small payment goes through with just the phone again.
3. **Lock and unlock from the web page.** On the Guardian page's Dashboard, **Lock now**; then on the Locked page enter the
   passphrase.
   You should see: the phone's Guardian screen follows (status Locked, then Online); pull down to refresh if it lags.
4. Try a wrong passphrase on the web page once or twice. You should see "That passphrase isn't right" and, after a few wrong
   tries, a wait before the next attempt.
5. **Sealed unlock** (a guardian and an app with this release). Restart the guardian, then unlock from the phone with the
   passphrase (step 2), once with a wrong passphrase first. You should see: the wrong one is refused as before, the right
   one unlocks with no extra step; the Activity line reads "Guardian unlocked with the passphrase from the phone" and
   does **not** say "sent it unsealed". If you still have an older app on another phone, unlock from it once: it works,
   and its Activity line ends with "The phone sent it unsealed (an older Trikey app): update the app". A message saying
   the guardian "restarted or locked again while this phone was unlocking it" should only appear if you restarted or
   locked the guardian during the unlock; tapping again then works.

If it goes wrong, collect:

- Which side you locked from and unlocked from, and the status the other side showed.
- The guardian log, and the Activity page (it records unlocks and locks, with "via" web or phone). The log lines
  `guardian.unlock_key_stale` and `guardian.unlock_unsealed` help with step 5; neither holds a secret.

### 10. Raising the limit with a hardware approval

Do:

- Settings, **Daily limit**, type a higher number. The button says "Approve on Ledger"; approve on the device.
- Then lower it again: you should see "Lowering it works from your phone", with no device prompt. (Raising needs the device;
  lowering does not.)

You should see: the new limit on Settings, on Home, and on the guardian's Rules page. A payment that was over the old limit now
goes through with the phone and guardian.

If it goes wrong, collect:

- The device prompt text (a rule change shows what changes), and the message on the phone.
- The guardian's Rules page and log.

### 11. Delete the app and restore from the backup

Before you start: you have the **recovery code on paper**, the **backup file saved somewhere other than the phone**, and a little
test balance. Make a fresh backup first if you changed rules since step 5 (Settings, This phone).

Do:

- Uninstall Trikey. (This deletes the phone key and the backup that lived inside the app.) Install the same APK again.
- Open it: **I already have a Trikey wallet**, **New phone, backup still there**. It will probably say it found no backup on
  this phone. Choose **Open a backup file**, pick the `.tkb` file, then type the recovery code. If the app says your wallet is
  on another network, use the button it offers.

You should see: the wallet comes back with its balance, the same guardian ("Online"), the rules and contacts. A small payment inside
the limit works with the phone and guardian, which shows the phone key is the same.

If it goes wrong, collect:

- Whether the file picker could see the file, and the message after typing the code (wrong code or wrong file look different).
- If the app opens with a wallet already in it right after reinstalling, say so (Android's own app-data restore could do that).
- Guardian log and Activity for the time of the restore.

### 12. The lost-phone recovery path, and how short the delay can be

**The shortest delay is 7 days, and it cannot be shortened for a real test.** I checked: the guardian accepts only 7, 14 or 30
(`RECOVERY_DELAYS` in `apps/guardian/src/policy/types.ts`; the same three values in the wire schema, and in the app's two
pickers). The guardian also finishes a recovery only when both its own clock and the chain's median time have passed the end of the
delay (DESIGN.md, "Threat model"), so moving the Umbrel's clock forward does nothing. On a real network you therefore choose
between two things:

- **12a, the part you can do in an afternoon:** start the recovery, check everything *around* the wait, and cancel it.
- **12b, optional, a week:** start it again and let it run to the end.

For the whole recovery to finish in minutes, the only way is the **simulator**: in the app it is regtest with a software
hardware wallet against a guardian on a computer (`apps/mobile/docs/dev-regtest.md`, "Quickest path: dev-rig", with
`skip <days>` to move the guardian's clock and mine past it). It needs the app's clock moved by the same amount too, which a
**browser preview can do and a phone cannot**, so run that one from the web preview on a computer, and do not expect it to test
Ledger, Umbrel or the Android build. It is a developer exercise, not part of this checklist. To reach the simulator on the phone:
Settings (the gear on Home, or the Settings tab in older builds) → Developer → Wallet mode. (This build also blocks plain
`ws://` and `http://` traffic, which a relay on a computer on your home network would need, so the simulator on the phone is not
usable with it anyway.)

Prepare: run step 11 first so you hold the backup file and code, because this test removes the wallet from the phone. Make
sure the wallet has a small balance. On the Guardian page, open **Recover on a new phone** and keep that QR code and its text
open (or print it: it holds no secret).

Do (12a):

1. Remove the wallet from the phone: uninstall and reinstall the APK. Do not open the backup file.
2. In Trikey: **I already have a Trikey wallet**, then **Lost my phone and the backup**. Scan the guardian's "Recover on a new
   phone" code (or paste it, or paste the npub and a relay), connect the hardware wallet, and approve on it.
3. The phone shows the recovery waiting screen with the date it completes, 7 days out, and "Alerts sent: ... daily".
4. On the Guardian page, a **Recovery** item appears in the menu, the Dashboard says "A recovery is in progress", and
   phone-only payments are paused.
5. In your nostr app, the guardian's direct message should arrive for the npub you added as a contact, with the recovery id and
   the line `CANCEL <recovery id>`. **Reply with exactly that line.**
6. You should get a reply "recovery ... is cancelled", the guardian's Activity should say it was cancelled by a contact, and the
   phone's waiting screen should say it was cancelled. A cancel by someone other than the key that started the recovery is
   treated as contested: phone-only payments stay paused until the hardware wallet approves **Resume** (Home, "Resume with Ledger").
7. Now restore this phone from the backup (step 11's procedure) and **Resume with Ledger** if Home offers it.

Do (12b, optional): repeat 1 to 4 and leave it. Come back each day: you should see a reminder DM every 24 hours. After 7 days
the guardian's DM says it is ready; the phone shows "Almost done" while the guardian co-signs and the sweep is broadcast.
You should see: "Your money is safe", the funds moved to a new wallet (check the explorer), the new wallet guarded by the
same guardian, and a request to **Confirm on your Ledger** once. Then make a backup of this new wallet (it is a different wallet).

If it goes wrong, collect:

- Which step, the recovery id, and what the phone and the guardian's Recovery page showed.
- Whether the DM arrived (and from which app), how long after the start. If it did not, the guardian log lines about direct
  messages, and your nostr app's DM relay list.
- The guardian's Activity page and log.

### 13. Replace guardian (optional)

You need a second guardian to replace the first with. The simplest on one box is a second container from the same image
(the published `ghcr.io/theicaruswings/trikey-guardian:<version>`, or `trikey-guardian:local` if you built from source), on the
Umbrel's app network with its own data folder, reached only through an SSH tunnel (never publish its port). Make the data
folder yourself first, as the user you log in as: a folder that Docker creates belongs to root, and the guardian could not
write to it (see "If the install does not work"). I have not tested this; adapt the network and Electrs names to what
`sudo docker ps` and `sudo docker network ls` show on your box, and set `BITCOIN_NETWORK` to the node's network (`bitcoin`
for mainnet).

```sh
mkdir -p "$HOME/trikey-guardian-2"
sudo docker run -d --name trikey-guardian-2 --init --restart on-failure \
  --network umbrel_main_network \
  -v "$HOME/trikey-guardian-2:/data" -p 127.0.0.1:3011:3000 \
  -e PORT=3000 -e TRIKEY_DATA_DIR=/data \
  -e ELECTRUM_HOST=<electrs container address> -e ELECTRUM_PORT=50001 \
  -e BITCOIN_NETWORK=signet \
  trikey-guardian:local          # or ghcr.io/theicaruswings/trikey-guardian:<version>
ssh -L 3011:127.0.0.1:3011 umbrel@umbrel.local     # then open http://127.0.0.1:3011
```

Do: set the second guardian up as in step 1, then Settings, **Guardian**, **Replace guardian**, **Scan new guardian**, and let the
app show you the plan. It makes one transaction with a network fee, approved on the hardware wallet.

You should see: a list of what happens, a "Moving to the new guardian" progress screen, then "Guardian replaced". Home now
shows the new guardian, the old wallet appears under Settings, Guardian, "Old wallets" (retired on the old box), and the coins
are in the new wallet. Make a new backup.

If it goes wrong, collect: the step the progress screen stopped at, both guardians' logs, the sweep transaction id, and whether the
old guardian was running.

### 14. Developer: crypto self-test

Do: Settings (the gear on Home, or the Settings tab in older builds) → Developer → **Crypto self-test**, press the row.

You should see: "Running...", then a pass summary with a green dot. It exercises key derivation, a multisig address, NIP-44
encryption and a NIP-59 gift wrap on the phone, and checks that the random source is the pinned one. Any failing step is
listed under the row.

If it goes wrong, collect: a screenshot including the failing steps, and the phone model and Android version.

Also in Developer, look but do not change anything yet: the **Wallet mode** switcher (Demo, Simulator, Real) and the Network line
(for example "Signet · chosen when the wallet was created", or "Mainnet" on Path A). Switching modes restarts the app on another wallet and deletes nothing, but
Simulator is regtest only.

### 15. Email and push alerts (optional)

The guardian can also send its alerts by email (through your own email account), ntfy push, Telegram and a webhook
(docs/design/notifications.md). They carry warnings only: cancelling a recovery and locking the guardian stay with nostr.
Set them up on the Guardian page, **Settings**, **Notifications**.

**Email.** You need an **app password**: a password your email provider makes for one app, which you can revoke. Never
type your account password here. Pick your provider's button to fill in the server, then the user name (your address),
the From address (usually the same) and the app password, and **Save email account**, then **Send a test message** (it goes
to the From address).

- **Gmail**: turn on 2-Step Verification, then Google Account, Security, **App passwords**, make one named "Trikey". Server
  `smtp.gmail.com`, port 465, TLS. Paste the 16 letters with or without the spaces.
- **Fastmail**: Settings, Privacy & Security, **Manage app passwords**, new password with access to SMTP. Server
  `smtp.fastmail.com`, port 465, TLS.
- **Proton Mail**: SMTP needs a paid plan with your own domain: Settings, IMAP/SMTP, **SMTP tokens**, make a token for an
  address on that domain. Server `smtp.protonmail.ch`, port 587, STARTTLS, user name the address, password the token.
- **Proton Mail Bridge** (any paid Proton plan, no own domain needed): Bridge must run where the guardian can reach it on
  your network (out of the box it listens only on its own computer, 127.0.0.1). Pick **Proton Mail Bridge** to fill in
  port 1025 and STARTTLS, enter the address of the machine running Bridge, and as user name and password the ones Bridge
  shows for your address (not your Proton password). Bridge makes its own self-signed certificate, so **pin it**: in
  Bridge, Settings, Advanced settings, **Export TLS certificates**, then paste the contents of `cert.pem` (never
  `key.pem`) into **Pinned certificate**; or, from a computer on your network, run
  `openssl s_client -connect <bridge address>:1025 -starttls smtp </dev/null 2>/dev/null | openssl x509 -noout -fingerprint -sha256`
  and paste the `sha256 Fingerprint=...` line. Save, then **Send a test message**.

**ntfy.** Install the ntfy app on your phone and subscribe to a topic.

- **Your own server (recommended):** install **ntfy** from the Umbrel App Store, create a user and an access token there,
  and in the guardian use the box's address, for example `http://192.168.1.20:<port>` (the `umbrel.local` name may not
  work from inside the guardian), your topic, and the token. Plain `http://` is accepted only for addresses on your own
  network.
- **ntfy.sh:** leave the server as `https://ntfy.sh` and use a **long random topic** (20 characters or more): anyone who
  knows a topic there can read it and send fake alerts to it. The page warns about short ones.

**Webhook.** For Home Assistant: make an automation with a **Webhook** trigger, copy its URL
(`http://homeassistant.local:8123/api/webhook/<id>`, or the box's address instead of `homeassistant.local`), add a
notify action with `{{ trigger.json.title }}` and `{{ trigger.json.message }}`, and paste the URL in the guardian (a
signing secret is optional; Home Assistant cannot check it). To see a payload without Home Assistant, run `nc -l 8099` on a computer in your network and
use `http://<that computer's address>:8099/`: the request (headers and JSON) prints in the terminal; the test then reports
a failure after 15 seconds, since `nc` does not answer.

**Telegram.** In Telegram, open a chat with **@BotFather** (blue tick), send `/newbot`, give it a name and a user name
ending in `bot`, and copy the token it shows. In the guardian, **Add Telegram**, paste the token and **Save bot**: the page
shows the bot's `@name` (a wrong token is refused with "Telegram refused the bot token"). Make a new bot for the guardian;
don't reuse one another service uses. Then under **Add a channel**, choose **Telegram**, open the bot in Telegram
(search its `@name`), send `/start`, press **Find** and pick your name. For an alert contact, send them the bot's `@name`
and ask them to send `/start` too, then Find and pick theirs (check the name and the time: anyone can write to a bot).
The page says it plainly: Telegram can read these alerts, as an email provider can.

**Alert contacts.** Under **Add a channel**, pick an alert contact (by npub) and add their email, ntfy topic or Telegram,
or pick "Someone without a nostr app" for a person who only reads email or Telegram. Each new address gets a welcome
message, so tell them first.

Do: set up one email channel for yourself, one ntfy topic and one Telegram chat, press **Send a test message** on each,
then do step 9 again (lock from the phone) and restart the guardian app on the Umbrel.

You should see:
- The test messages arrive, named with the guardian's name you set, plain text, no links.
- The phone's Settings, **Alert contacts** lists them under "Email and push alerts" (masked), and its Activity shows
  "Email and push alerts changed" after each change.
- "Guardian locked" (from the phone) and "Guardian restarted and is locked" arrive by email, ntfy and Telegram, the second
  one while the guardian is still locked.
- Telegram messages are plain text: no bold, no link preview, nothing to tap; payments and test messages arrive silently.
  The phone lists the Telegram chat as "Telegram (M…)" (the first letter of the name) under "Email and push alerts".
- **Find** on a bot that another service uses with a webhook says so ("This bot has a webhook set ...") instead of
  listing chats. A Telegram chat whose person blocked the bot shows **Failing** ("blocked the bot"); the bot itself stays
  working.
- Every change you make is announced on every channel; a channel you remove gets a last message saying so.
- A wrong app password shows as **Failing** next to the email account with the server's answer, and in Activity as
  "Alert channel failing"; fixing it shows "works again".
- With Proton Mail Bridge: without the pin the test fails with a certificate error; with it, the test arrives, and the
  account shows "Pinned certificate: SHA-256 ..." matching what Bridge (or `openssl`) shows. Pinning another
  certificate's fingerprint makes the test fail with "not the pinned one: it shows SHA-256 ...". Each pin change is
  announced like any change.
- During a recovery (step 12a, before you cancel it): the email account can still get a **new app password** (announced
  as "email account changed: app password"), but changing its server or user name, removing a channel or the pin is
  refused until the recovery ends. The same for the Telegram bot: a new token of the same bot (after `/revoke` in
  @BotFather) is accepted and announced as "Telegram bot changed: bot token"; another bot, or removing a chat, is refused.

If it goes wrong, collect: the error shown next to the channel, the guardian's Activity page and log lines starting with
`notify.`, your provider, and the server, port and encryption you used, and with Bridge the pinned fingerprint (never
the password or token; never the Telegram bot token either).

### 16. Alert contacts can lock the guardian (optional)

You need a second nostr account that is an alert contact: a friend's, or a second account in your own nostr app (Amethyst,
0xchat, Damus and Primal can hold more than one). Add it as in step 4. The contact sends the guardian the single word `LOCK`
as a direct message, in the conversation where the guardian's alerts arrive (docs/design/contact-lock.md).

Do:

1. **While the setting is off** (the default): from the contact's account, send `LOCK`.
   You should see: nothing at all. No answer to the contact, the guardian stays unlocked, Activity shows nothing.
2. **Turn it on.** Settings, **Alert contacts**, **Contacts can lock the guardian**. The phone alone turns it on.
   You should see: every alert contact told that it is on; the Guardian page's Rules showing "Contacts can lock the
   guardian: On". The `LOCK` from step 1 must not lock the guardian now, even if a relay delivers it again.
3. **Lock as the contact.** Send `LOCK` again.
   You should see: the contact gets "locked" back; the guardian is locked (key out of memory, phone payments go to the
   hardware wallet as in step 9); the phone's Home and Activity, the web page's Locked screen and every other contact name the
   contact who did it. Sending `LOCK` once more answers "already locked". Email and ntfy (step 15) get it too.
4. **Unlock** with the passphrase, from the phone or the web page. A contact can never unlock: send `UNLOCK` or anything else
   from the contact and check that nothing happens.
5. **Turn it off.** It needs a hardware approval. Then send `LOCK` from the contact once more: nothing, as in step 1.

If it goes wrong, collect: the contact's npub (shortened), the exact text sent and the nostr app used, the time, the
guardian's Activity page and the log lines starting with `dm.lock`, and which relays the contact's app uses.

### 17. Savings (optional, needs a second hardware wallet)

Savings is a separate 2-of-3 that the guardian holds no key in: your phone, your hardware wallet and a **Recovery Key**,
which is a second hardware wallet (a Trezor beside a Ledger, for example) or, if you have none, a printed kit. Any two of
the three move it; the guardian only watches it and warns everyone when money leaves (docs/design/savings-and-limit-off.md).

Do:

1. **Create it.** Settings, **Savings**, follow the screens: approve on the hardware wallet, then connect the Recovery Key.
   Print the **Savings wallet map** and check it has no seed words or keys on it, only what is needed to find the wallet.
   You should see: a Savings card on Home; the guardian's Activity shows Savings being watched.
2. **Move money in.** From Spending, send a small amount to a Savings receive address (verify it on the device).
   You should see: it counts against the daily limit like any payment (over the limit it goes to the hardware wallet, as in
   step 8), and it shows in Savings once confirmed.
3. **Move money out with phone + hardware wallet.** Savings, **Send**, a small amount back to Spending.
   You should see: no guardian and no limit involved; once it is broadcast, the phone, every alert contact and the email and
   ntfy channels get "Money moved out of Savings" with the amount.
4. **Move money out with phone + Recovery Key** (the Ledger left aside). Same as 3, signed on the Recovery Key.
5. **Speed up a Savings payment.** Send a small amount out of Savings again and, before it confirms, tap it on the
   Savings screen ("Speed up ›"). It is easiest when the network is busy, or on signet or testnet4 right after a block.
   You should see: the old fee, the new fee and the difference before anything is signed; the amount and address
   unchanged; the hardware wallet (or the Recovery Key, if you pick it) shows the same payment with the higher fee; Savings
   then lists one payment marked "sped up", not two; the explorer shows the new transaction and the old one gone; and **no
   second** "Money moved out of Savings" alert on the phone, the contacts or the email and ntfy channels (the guardian's
   Activity shows "Savings payment sped up"). A "Move everything" payment has no change to pay from: the app should say it
   cannot be sped up.
6. **Restore** (step 11 again, after 1 to 5): the restored phone shows Savings with the right balance.
7. **Turn the watch off** (or replace the Recovery Key). You should see the phone and every contact told about it.

If it goes wrong, collect: which two keys signed, for a speed-up both transaction ids, both devices' models and firmware, the transaction id, the screen and
message, the guardian's Activity page and the log lines starting with `savings`.

---

### 18a. A second wallet in the same app (optional; needs a second hardware wallet and a guardian with `own_wallets`)

Every wallet shares this phone's key, its backup and your guardian; only the hardware wallet differs. Each sits at its own
BIP 48 account (the second at `2'`), so nothing on chain links them (docs/design/multi-wallet.md).

Do:

1. **Add it.** Settings, **Wallets**, **Add a wallet**: a name ("Business"), a daily limit, then connect the **new**
   hardware wallet. You should see: the device registers the wallet as "Trikey Business" and shows its first address, which
   matches the phone; the guardian's Activity shows "Wallet "Business" added"; the phone says anyone who can unlock it can
   spend up to each wallet's daily limit. Connecting the first wallet's device instead must be refused.
   **With a guardian and an app from this release** the **first** wallet's device is asked too, after the new one approved
   its rules: a text `Trikey add-wallet v1 wallet=<first wallet id> new=<new wallet id> seq=...`. Approve it on the first
   wallet's device. The first wallet's alert contacts get a nostr message "a wallet was added to the guardian ...". With an
   app from before this release and a guardian from this one, "Add a wallet" must be refused with "Update the Trikey app".
1b. **The owner's escape hatch.** On the guardian's web page, Settings, **Wallets and hardware unlock**, **Review**: both
   wallets are listed, with "Hardware unlock is on" for a wallet you turned it on for (step 18d; the first wallet's alert
   contacts are told when you do). **Turn hardware unlock off** for one: the passphrase still unlocks. Optional, at the
   end of 18a (instead of step 7's Remove): **Remove...** the second wallet, type `REMOVE WALLET`: the guardian stops
   guarding it (the phone gets "removed"; its money stays with the phone and its device), and its contacts and the first
   wallet's are told. While a recovery of that wallet runs, the page offers no Remove (it says why) and the guardian
   refuses it; Reset is refused too, with no way past it.
2. **Device check.** Note what each device says when it signs for the second wallet: its own key stays at `0'` (no new
   path warning), the phone's and the guardian's keys show at account `2'`. Report the model and firmware.
3. **Pay from each.** Switch at the top of Home. Pay inside each wallet's own limit, then over the second one's limit
   (its own device signs). You should see: Send's review starts with "From: Business"; Receive names the wallet; the
   guardian's Wallet, Rules and Activity pages have a wallet picker, and each wallet's limit counts on its own.
4. **Back up again** and restore (step 11): both wallets come back with one recovery code.
5. **Savings for the second wallet** (a guardian with `own_wallets_2`, and a third device as its Recovery Key). Shown
   "Business", Savings, **Set up Savings**. You should see: the phone's Savings key at `m/48'/<coin>'/3'/2'`, the second
   wallet's own device at `1'`; the first wallet's device is refused as Recovery Key. Send a little in and out: the
   guardian's Wallet page for "Business" shows its Savings card, and the phone gets "Savings moved" under "Business".
   Print its Savings wallet map: the title names "Business".
6. **Background sync.** With "Main" shown, receive into "Business" from another wallet. Within about ten minutes the
   switcher shows Business's new balance without switching.
7. **Rename and remove.** Settings, Wallets, "Business": rename it. Then **Remove this wallet**: refused while it holds
   money; **Move everything to "Main"** (over its limit, its own device signs), then remove it (one approval on its device).
   You should see: the guardian's Activity says the wallet was retired; the account is not offered again to a new wallet.
   **With a frozen coin** (step 18b): before moving, freeze a small coin of "Business" in its Coins. You should see:
   **Include 1 frozen coin (N sats)**, off, saying the coin stays and the wallet can't be removed while it holds it. Move
   with it off: the frozen coin stays, and Remove says so. Switch it on and move again: the wallet is empty in one
   payment (no unfreezing), and Remove works.
9. **Print the recovery sheets.** Settings, Wallets (or Settings, Guardian), **Print a recovery sheet**. With two wallets,
   try **One per wallet** (one page each, to keep with that wallet's device) and **All on one sheet**. You should see: each
   wallet's name, hardware wallet, wallet id, the guardian's npub and relays and a QR code; no seed words, keys or backup
   recovery code. On a spare phone, "I already have a Trikey wallet", "My phone and its backup", scan one sheet's QR
   code: it reads as that wallet's guardian (stop there, unless you mean to start a recovery).
8. **Replace the guardian with two wallets** (a second guardian box): Settings, Guardian, **Replace guardian**, scan the
   new box's code. You should see: the plan lists every wallet with its device and balance; the move asks for each
   wallet's own device in turn ("Business (2 of 2): connect its Trezor"). Unplug the second device on purpose once: the
   first wallet moves, the screen says "1 of 2 moved", and **Go on with the move** finishes the other. On the old box
   both wallets end retired, the first last.

If it goes wrong, collect: both devices' models and firmware, which wallet was shown, the screen and message, and the
guardian's Activity page.

---

### 18b. Coin control: labels, freeze, picking coins, consolidate (optional; a guardian with this release)

Every payment into the wallet is a **coin**. Coin control lets you label coins, freeze one (dust from a stranger, a coin
kept apart), choose which coins pay, and merge small coins into one while fees are low (DESIGN.md, "Coin control").
Labels and freezes stay on this phone and in its backup; the guardian never sees them.

Do:

1. **Get a few coins.** Receive three or four small payments (5,000 to 50,000 sats each) into Spending, and wait for them
   to confirm. On Home, tap **Coins**. You should see: one row per coin, with its amount and confirmations; the totals at
   the top.
2. **Label and freeze.** Open a coin, give it a label ("Salary"), give another one a different label, and switch
   **Frozen** on for the smallest one. You should see: the labels and a "Frozen" section in the list; Security says the
   backup doesn't have your latest labels yet.
3. **Send max leaves the frozen coin.** Send, any address of yours, **Send max**. You should see: the amount is the
   balance minus the frozen coin minus the fee. Don't send it: go back.
4. **Pick coins.** Send a small amount, tap **Choose coins**, pick the two labeled coins (one alone would be enough),
   then **Pay with these 2 coins**. You should see: the frozen coin cannot be picked; the warning "These coins carry
   different labels"; Review shows "Paid with 2 coins you chose"; after sending, both coins are gone from the list and
   the change comes back as a new coin. On the explorer, the transaction spends exactly those two coins.
5. **Consolidate.** Receive two or three more small coins and let them confirm. Coins, **Consolidate coins**, **All small
   coins**, Slow. You should see: "Fees are low now" or "Fees are not low right now" with the rate; the coins merged,
   the fee and the new coin; "Only the network fee counts toward today's limit". Approve it even if the coins hold more
   than what is left of today's limit: the guardian co-signs, and the daily limit used goes up by **the fee only** (Home,
   and the guardian's Rules page). Activity shows "Coins consolidated" with the fee.
6. **Savings** (if you did step 17). Savings, **Coins**: label one, then **Consolidate coins** with your hardware wallet
   (or the Recovery Key). You should see: the phone, every alert contact and the email and ntfy channels get **"Savings
   consolidated"** saying only the network fee left (not "Money moved out of Savings").
7. **BIP 329 export and import.** Settings, Advanced, **Wallet details**, **Export labels**: save the file. Open it in
   Sparrow (File, Import, Labels) on the same wallet's descriptor: the labels show there. Label something in Sparrow,
   export its labels, and **Import labels** here. You should see: "Read N labels…", and the records of another wallet
   (if the file had any) left out.
8. **Back up and restore** (step 11 again). You should see: on the restored phone the labels are back and the coin you
   froze is still frozen. A phone with an older app says the backup needs a newer version of Trikey.
9. **Label an address on Receive.** Receive, **Label this address**, "Invoice 42", save; then pay that address from
   another wallet. You should see: in Coins, the new coin is named "Invoice 42" (it has no label of its own); its row in
   Activity ends in "· Invoice 42", and its payment details show the label and "Label its coin". Give the coin its own
   label: it shows instead, in Coins and in Activity. Receive now shows the next address, unlabeled. Export labels again:
   the file has an `addr` record for it. The same works on Savings' Receive.
10. **Labels in Activity.** A payment you labeled (a note on Send, or a received payment whose coin you labeled) ends its
   Activity row in "· its label"; a long one is cut with "…" and shown whole in the payment's details.

If it goes wrong, collect: the coin's amount and confirmations (not its label), the screen and message, which wallet
(Spending or Savings), for a consolidation the transaction id and the daily limit before and after, and the guardian's
Activity page.

---

### 18c. Notes that survive recovery (optional; a guardian with this release, a Ledger, a Trezor or a QR device that signs texts)

Labels (step 18b) normally live on the phone and in its backup only. This option keeps an **encrypted copy** on the
guardian, so a recovery without the phone and its backup brings them back too (DESIGN.md, "Notes that survive recovery").
Only your hardware wallet can unlock it; the guardian learns roughly how many notes you keep and when you change them.

Do:

1. **Turn it on.** Settings, Advanced, **Wallet details**, **Keep your notes safe with the guardian**. You should see:
   your device asks you to sign the text `Trikey labels key v1 wallet=<id> network=<network>` **twice** (check it on
   the device screen; an older Trezor or a Model One shows its path warning first, as for approvals); then "On. Last copy
   <time>". The guardian's web page, Activity: "Encrypted notes updated". **Write down your device and firmware**, and
   whether the two signatures were accepted: if the app says the device "gave two different signatures", report it
   (device model, firmware, Ledger Bitcoin app version), as that device cannot be used for this.
2. **Edit.** Label a coin. You should see: "Your latest changes go out in a moment", then a new "Last copy" time about
   30 seconds later. Close the app right after a change and open it again: the copy goes out when it comes back.
   Activity shows the update at most once a day.
3. **Lose the phone and its backup** (on a test network, with step 12's short delay). Delete the app (and do not restore
   the backup), recover on the "new" phone with the recovery code and the hardware wallet, and let the recovery finish.
   You should see: on "Your money is safe", **Bring back your notes** with the copy's size and date; one signature on the
   device; then "N coin labels, M payment notes ... came back". The app does not show the old wallet's history after
   a recovery (its coins were swept): the notes are kept in the phone's labels, its next backup and its next copy on
   the guardian. Make a backup of the new phone: it carries them.
4. **Restore from an older backup.** Make a backup, change a label and add another, then restore that backup on another
   phone (step 11). Wallet details: **Bring back your notes** offers the guardian's copy. You should see: the label you
   added after the backup comes back; the one you changed keeps the backup's text (the phone's labels win).
5. **The recovered wallet.** On the recovered phone, Wallet details says to turn it on again for the recovered wallet:
   turn it on (two signatures). The guardian's Activity shows the update.
6. **Turn it off.** Switch it off and confirm "Turn off and delete the copy". You should see: the guardian's Activity
   says "Encrypted notes deleted"; your labels are still on the phone.

If it goes wrong, collect: the device model and firmware, the step and the exact message, and the guardian's Activity
page (it shows no label: the guardian cannot read them).

### 18d. Unlock the guardian with the hardware wallet (optional; a guardian with this release, a Ledger, a Trezor or a QR device that signs texts)

After a restart the guardian is locked until you unlock it. This option lets your hardware wallet unlock it from the
phone with one confirmation, next to the passphrase, which always keeps working (DESIGN.md, "Unlocking the guardian with
the hardware wallet"). It is off by default. Of the QR devices, only those that sign a text by QR code can use it
(Coldcard Q, Jade, Keystone 3, Passport Prime, Specter DIY; step 18e); the others keep the passphrase. Passport (2nd
generation) and Krux sign texts only from a microSD card (step 18f): the option is hidden for them, with a sentence
saying why.

Do:

1. **Turn it on** (the guardian unlocked). Settings, **Guardian**, **Unlock with your <device>**. You should see: your
   device asks you to sign `Trikey unlock key v1 wallet=<id> guardian=<hex> network=<network> slot=<hex>` **twice**
   (check it on the device screen); then "On since <time>". The guardian's web page, Activity: "Hardware unlock turned
   on", with no "sent it unsealed" (the signature travels sealed). If the app says the device "gave two different signatures", report the device model and firmware.
2. **Restart the guardian** (Umbrel: restart the app; Docker: `docker compose restart`). On the phone, Home says
   "Guardian locked" with **Unlock with your <device>**. Tap it, then on the Guardian screen **Unlock with your
   <device>**: one confirmation on the device. You should see: status "Online"; Activity: "Unlocked with the hardware
   wallet" (with no "sent it unsealed": the signature travels sealed, as the passphrase does, step 9.5). Lock again from
   the phone and unlock with the passphrase: it still works.
3. **A wrong device** (if you have a second one): connect it and try to unlock. You should see "didn't unlock the
   guardian"; five failures in a row (passphrase or device) stop the phone until the web page unlocks, as before.
4. **Turn it off.** Switch it off and confirm. You should see: Activity "Hardware unlock turned off"; after the next lock
   only the passphrase unlocks.
5. **Several wallets** (step 18a): each wallet's own hardware wallet can be turned on for the box; each unlocks it alone.

If it goes wrong, collect: the device model and firmware, the step and the exact message, and the guardian's Activity
page and log (they never show the signature).

---

### 18e. QR message signing (optional; untested on hardware: Coldcard Q, Jade, Keystone 3, Passport Prime, Specter DIY)

**Nothing in this step has been tried on a real device yet.** What each device does was read from its firmware source
(DESIGN.md, "Hardware wallets by feature"; docs/design/hardware-auth-path.md, "QR devices"). Pairing a guardian,
approvals that loosen the rules, recovery access, notes and hardware unlock all need the device to sign a short text
with the key `m/48'/<coin>'/0'/2'/0/0`. Over QR codes the phone shows one QR, `signmessage m/48h/1h/0h/2h/0/0
ascii:<text>` (`0h` in place of `1h` on mainnet), the device shows the text and signs, and the phone scans the
signature back. Use a test network.

Do, for each device you have:

1. **Pick the model.** "Create a wallet", **Continue**, **Scan a QR code**, then your device. SeedSigner and "Other"
   should say they "can't set up a guardian wallet" and offer Recovery Key mode (SeedSigner: "It co-signs payments
   only"); the Coldcard Mk4 (no camera) should go to NFC instead (step 18g). Passport (2nd generation) and Krux go on: they sign from a
   microSD card (step 18f). Pick yours, scan its multisig key export.
2. **Pair** (steps 2 to 4). At "Approve", the phone shows **Sign on your <device>** with a QR, the text
   `Trikey pair v1 wallet=<id> guardian=<hex>` under it, numbered steps for your device, and, for Coldcard Q,
   Passport Prime and Specter, the address the device should show. Scan the QR with the device, **check the text and
   the path on its screen**, sign, tap **Scan the signature** and scan what the device shows.
3. **Per device**, what to check and write down:
   - **Coldcard Q** (firmware 1.5.2Q or later): press the QR key and scan; the Coldcard should recognise a message to
     sign. Check the text, the path and that its address matches the one on the phone. Choose to show the signature as
     a QR. Then raise the limit (step 10): its text is about 200 characters, and the Coldcard signs at most 240. Note
     whether the answer QR is the bare signature or the armored block (both are read).
   - **Jade / Jade Plus** (1.0.41 or later), unlocked in **QR mode**: Scan QR, then the QR. Jade shows the text cut after
     about 188 characters and "...", the path and a hash. The pairing text (114 characters) should show in full; a limit
     change (about 200) is cut at the end. Note what it shows, and that the answer QR is accepted (a 65-byte signature).
   - **Keystone 3**: scan from its home screen. Does it accept the path `m/48'/...` at all? It should show the text and
     the path and **no address**. Write down exactly what it shows, and any warning.
   - **Passport Prime**: open account 0 first (the one the path names), then scan. Write down whether your multisig
     account at index 0 exists to sign from, and what it shows (the address should match the phone's).
   - **Specter DIY**: Scan QR code, then the QR. It should show the text, the path and an address that matches the
     phone's.
4. **The same signature twice.** Turn on notes (step 18c) and hardware unlock (step 18d). Each shows **"(1 of 2)"**
   then **"(2 of 2)"**, with "Your <device> will show the same text twice". Sign both. If the app says the device "gave
   two different signatures", report the device and firmware: it cannot be used for notes or unlock.
5. **Wrong things on purpose** (once, any device): sign with another path or account on the device (Passport Prime:
   from account 1), or scan an old signature. The phone should keep the camera open and say the signature "is not from
   this wallet's key", naming the path. Cancel, and try again properly.
6. **Settings, Advanced, Hardware wallet model.** Switch to "Other": notes and hardware unlock say they need a device
   that signs a text. Switch back.
7. **Across devices** (two devices with the same seed, for example a Coldcard Q and a Jade): turn notes on with one,
   then on another phone recover or restore with the other and bring the notes back. The two should give the same
   signature for the same text.

If it goes wrong, collect: device model and firmware, the step, a photo of the device screen and of the phone's QR
screen (the text and the address, never your seed words), and the exact message.

### 18g. A Coldcard over NFC (optional; untested on hardware: Coldcard Mk4, Coldcard Q)

**Nothing in this step has been tried on a real device or phone yet.** The protocol was read from Coldcard's firmware
(`shared/nfc.py`; docs/design/hardware-auth-path.md, "Coldcard over NFC"). The Coldcard plays an NFC tag: for each step
the phone either sends something to it (you open the Coldcard's NFC menu first, then hold the phone to it) or reads what
it shares (it shows the NFC animation). Use a test network (on the Coldcard: Advanced/Tools › Danger Zone › Testnet
Mode, or the equivalent on your firmware).

Before you start: on the Coldcard, **Settings › Hardware On/Off › NFC Sharing › Enable NFC**. On Android, NFC on in
the phone's settings. On an iPhone, the build must have been made with `TRIKEY_IOS_NFC=1` and a paid Apple developer
account (the NFC Tag Reading capability); the alpha's iPhone builds have no NFC, and the app says so in the list of
devices ("This iPhone build of Trikey has no NFC").

Do:

1. **Where the antenna is.** A Mk4: the back of the phone flat on the keypad, over the 8 key. A Q: on the screen. The
   phone's own antenna is usually near its camera (iPhone: the top edge). Write down the position that worked.
2. **Connect.** "Create a wallet", **Continue**, **Coldcard by NFC**, then **Coldcard Mk4** (or Q). Also check that
   **Scan a QR code › Coldcard Mk4** leads to the same place. The phone shows **Connect your Coldcard Mk4** with steps:
   on the Coldcard **Settings › Multisig Wallets › Export XPUB**, OK, account **0**, then **3** (Mk4) or the **NFC key**
   (Q) to share over NFC; tap **Read from the Coldcard** and hold the phone to it. Expected: "Coldcard Mk4 connected".
3. **Pair** (steps 2 to 4). At "Approve": **Sign on your Coldcard Mk4**, the text under it. On the Coldcard **Advanced/
   Tools › NFC Tools › Sign Message**, then **Send to the Coldcard** and hold the phone to it; lift it when the phone
   says done. About 3 seconds later the Coldcard should show the text, the path `m/48'/1'/0'/2'/0/0` and a legacy
   address (`m…`/`n…` on test networks) that **matches the one on the phone**. OK. It then shares the signature: **Read
   from the Coldcard**, hold the phone to it, then X on the Coldcard.
4. **The wallet onto the Coldcard.** **Add the wallet to your Coldcard Mk4**: on the Coldcard **Settings › Multisig
   Wallets › Import**, choose NFC, **Send to the Coldcard**. About 3 seconds later it should show the wallet: check the
   name, **2 of 3** and the three keys, approve, then **I approved it** on the phone. Then **Compare the address**: on
   the Coldcard **Address Explorer**, the wallet's name, address 0, the same as the phone's.
5. **A payment** over the daily limit (step 7): **Sign on your Coldcard Mk4**. On the Coldcard **NFC Tools › Sign
   PSBT**, **Send to the Coldcard**; check the amount and the address on the Coldcard and approve; then **Read from the
   Coldcard** and hold the phone to it. Note whether it shared a partly signed PSBT or a finished transaction (both are
   read). Try a payment that spends many coins (consolidate first with step 18b): over about 7,000 bytes the phone
   should say it is too large for the Coldcard's NFC, before anything is sent.
6. **The same signature twice.** Turn on notes (18c) and hardware unlock (18d): two rounds, "(1 of 2)" and "(2 of 2)",
   each a send and a read.
7. **Wrong things on purpose.** Tap with NFC off on the phone: it should say NFC is off and offer the settings (Android).
   Lift the phone in the middle of a send: it should say it lost the Coldcard, and **Try again** should work. Read
   before the Coldcard shares anything: "not sharing anything yet". Hold the phone to another Coldcard when reading the
   signature: "not from this wallet's key".
8. **iPhone** (only with an NFC build): the iPhone's own "Ready to Scan" sheet opens for each send and read; check that
   writing to the Coldcard works (Core NFC writes NDEF to its Type 5 tag) and that closing that sheet leaves Trikey's
   screen with **Try again**.

If it goes wrong, collect: Coldcard model and firmware version, the phone model and OS version, the step, what the
Coldcard showed (a photo, never your seed words) and the phone's exact message.

---

### 18f. microSD message signing (optional; untested on hardware: Passport 2nd generation, Krux)

**Nothing in this step has been tried on a real device yet.** Passport (2nd generation) and Krux refuse Trikey's key
over a text QR but sign it from a file on their microSD card (DESIGN.md, "microSD message signing";
docs/design/hardware-auth-path.md §7, "microSD"). The phone writes a small text file (`trikey-pair.txt` and so on), you
copy it to the card, sign on the device, and bring back the signed file it writes. You need the device's microSD card
and a way to reach it from the phone: a USB-C (or Lightning) card reader, or a computer. Use a test network.

Do, for each device you have:

1. **Pick the model.** "Create a wallet", **Continue**, **Scan a QR code**, then **Passport (2nd generation)** or
   **Krux**: the line should say "Signs payments by QR, and Trikey's texts from a microSD card", and it should go on
   to the key export (no "can't set up a guardian wallet"). Scan its multisig key export as usual.
2. **Pair** (steps 2 to 4). At "Approve", the phone shows **Sign on your <device>**, the text
   `Trikey pair v1 wallet=<id> guardian=<hex>`, numbered steps and the legacy address (`m…`/`n…` on test networks) the
   device should show. Tap **Save the file (trikey-pair.txt)** and pick the card in the reader. Write down: whether the
   folder picker reaches the card on your phone (Android, iPhone), and the file's name and contents on the card (two
   lines on Passport: the text, `m/48h/1h/0h/2h/0/0`; three on Krux: the same and `p2pkh`). Also try **Share the file**
   once (to a computer, or Files).
3. **On the device:**
   - **Passport (2nd generation)**: any account, **Account Tools > Sign a Message > Sign with microSD**, pick
     `trikey-pair.txt`. It should show the whole text (scroll to the end), then "Sign message with this address?" with
     the address the phone showed. Sign. It should write `trikey-pair-signed-001.txt` next to it.
   - **Krux**: **Sign > Message > Load from SD card**, pick `trikey-pair.txt`. It should show "Message:" with the text
     (cut with "…" on a small screen) and "Address:" with the phone's address, then "Sign?". If it shows "SHA256:" and a
     long number instead, stop and report it: it did not read the file. After signing, choose **Sign to SD card** (keep
     the name `trikey-pair-signed.txt`); once, choose **Sign to QR code** instead and use **Scan the signature instead**
     on the phone.
4. **Bring it back.** Card back in the reader, **Open the signed file**, pick the `-signed` file. The phone should then
   show **Delete these files from the card**, naming the request and the signed file exactly as on the card
   (`trikey-pair.txt` and `trikey-pair-signed-001.txt` on Passport, `trikey-pair-signed.txt` on Krux; only
   `trikey-pair.txt`, under **Delete this file from the card**, after Krux's Sign to QR code), with one button, **I
   deleted them**. Try the system back gesture once: the screen should stay. Delete both files (from the computer too if
   you shared the file) and tap the button; the phone should go on (the wallet is added to the device, then the address
   is compared, as for any QR device). Write down whether the names matched the card and how long the whole round trip
   took.
5. **Wrong files on purpose** (once): pick `trikey-pair.txt` itself (the phone should say it is "the file Trikey made
   (the request)"), and any other text file ("not a signed message"). Edit a copy of the signed file on a computer,
   change one character of the text, and pick it ("a different text"). Each should stay on the same screen with the
   reason; then pick the right file.
6. **Raise the limit** (step 10): the approval text (about 200 characters) goes through the same round trip. On Krux,
   note how much of it the screen shows (the phone says it may cut after about 120 characters on a small screen).
7. **Notes, twice** (step 18c): turning notes on asks for two files, **"(1 of 2)"** `trikey-notes-1of2.txt` and
   **"(2 of 2)"** `trikey-notes-2of2.txt`. Sign both. In round 2, first pick round 1's signed file: the phone should say
   it is "the signed file of the other round". If the app says the device "gave two different signatures", report the
   device and firmware. After each round the delete screen should say the files "can open your notes": the signed
   notes files are the notes' key, so delete them for real (and empty the computer's trash).
8. **Hardware unlock is not offered.** Settings, **Guardian**: under "Unlocking" there is no switch, only a sentence
   saying the device signs only from a microSD card and that the passphrase unlocks the guardian.
9. **Recovery access** (step 12, the lost-phone path, if you run it with this device): the new phone asks the device to sign its request the same way (`trikey-access.txt`).

If it goes wrong, collect: device model and firmware, the step, a photo of the device screen, and the exact message.
The request and signed files of pairing, approvals and recovery access hold no secret (the text, the address and the
signature) and can be sent. **Never send the signed notes files** (`trikey-notes-…-signed…`): that signature is the key
to your notes on the guardian.

---

### 18h. A Jade over Bluetooth (optional; untested on hardware: Jade, Jade Plus)

**Nothing in this step has been tried on a real Jade or phone yet.** The protocol was read from Jade's firmware and its
Python client (github.com/Blockstream/Jade at a59d14c, 1.0.41; docs/design/hardware-auth-path.md, "Jade over
Bluetooth"). Over Bluetooth the Jade is a full key 1, like a Ledger: it registers the wallet, co-signs payments and
signs Trikey's texts (pairing, approvals, recovery access, notes, hardware unlock). Use a test network: a Jade is locked
to mainnet or to the test networks the first time it is unlocked, so use a Jade set up for testnet (or a spare one).

Before you start: firmware **0.1.47 or later** (1.0.41 is current); Bluetooth on in the Jade's settings (Device ›
Settings › Bluetooth; some firmware builds have no Bluetooth at all and say so); Bluetooth on in the phone. Unlocking the
Jade over Bluetooth asks the Jade's **PIN server** through the phone (Blockstream's, unless you set your own in the
Jade's settings, "Blind Oracle"): the phone needs the internet for it.

Do:

1. **Connect.** "Create a wallet", **Continue**, **Jade by Bluetooth**. On the Jade choose **Bluetooth** when it asks how
   to connect. Android asks for the "Nearby devices" permission (Android 12 and later; older Android: location), iOS for
   Bluetooth. Expected: "Looking for your Jade", then "Connecting to Jade XXXXXX". **The first time**, the phone's
   system pairing dialog and the Jade both show a six-digit number: check they are the same and confirm on both.
2. **The PIN-server notice.** Before the first unlock the phone shows **Your Jade's PIN server** and one sentence (the
   server sees this phone's IP address and when the Jade unlocks, never the PIN or keys; in QR mode Trikey contacts no
   PIN server).
   **Continue**. It must not appear again on later connections (it is remembered on the phone).
3. **The PIN.** "Enter your PIN on the Jade": type it on the Jade. The phone shows "Checking your PIN" while it relays to
   the server. Expected: "Jade Plus connected" (or "Jade"). Write down the PIN server the phone named (`j8d.io` for
   Blockstream's). If you set your own PIN server on the Jade, the phone first asks **A PIN server Trikey does not
   know**, naming it: **It is my server**, once (it is remembered). With Blockstream's it must never ask that.
4. **Pair** (steps 2 to 4). "Confirm on your device" with the text: the Jade shows the text (a long one is cut after
   188 characters with "..."; the phone says so), the path `m/48'/1'/0'/2'/0/0` and a hash. Confirm. Then the Jade shows
   the wallet to register: **2 of 3**, sorted, the three keys, and the name (`Trikey`; spaces become "-"). Approve.
   Then it shows the first address: **the same as the phone's**. Confirm.
5. **A payment** over the daily limit (step 7): the phone connects again (**PIN again**: the Jade locks when the
   Bluetooth link that unlocked it drops), then the Jade shows the payment. Check the amount and the address, and that
   the **change is not shown as a payment** (it is recognised as change because the wallet is registered). Approve.
   Try a payment that spends many coins (step 18b): the signed payment comes back in parts; it should still work.
6. **The same signature twice.** Turn on notes (18c) and hardware unlock (18d): two rounds, the same text twice on the
   Jade. If the app says the device "gave two different signatures", report it with the firmware version.
7. **Unlock the guardian** with it (18d step 2): one connection, the PIN, one confirmation.
8. **Wrong things on purpose.** A wrong PIN once (not three times: three wrong PINs in a row wipe the Jade): the phone
   should say "Wrong PIN" and **Try again** should ask again. Turn the phone's internet off before the PIN: the phone
   should say it could not reach the PIN server, and the Jade asks "Failed communicating with Oracle - retry?" (answer
   No; then turn the internet on and try again). Turn the Jade off in the middle of a signature: "The Jade disconnected".
   Cancel on the "Enter your PIN" sheet: the phone stops.
9. **After a reset of pairings** (Jade: Device › Settings › Bluetooth › Reset Pairings): the phone should fail to
   connect until you also remove the Jade in the phone's Bluetooth settings; the "Connecting" sheet says so.
10. **The build without Google** (Android, `foss` APK): steps 1 to 5 must work the same (the Bluetooth library has no
   Google code, and the PIN-server request is a plain https request).

If it goes wrong, collect: Jade model and firmware version (Jade: Device › Info), the phone model and OS version, the
step, what the Jade showed (a photo, never your recovery phrase or PIN) and the phone's exact message.

### 18i. A BitBox02 over USB-C or Bluetooth (optional; untested on hardware: BitBox02, BitBox02 Nova)

**Nothing in this step has been tried on a real BitBox02 or phone yet.** The protocol was read from the BitBox02's
firmware and its official clients (github.com/BitBoxSwiss/bitbox02-firmware at b27f5f68, bitbox-api-rs, bitbox-api-ts,
BitBoxApp; docs/design/hardware-auth-path.md §10). The BitBox02 is a full key 1, like a Ledger: it registers the wallet,
co-signs payments and signs Trikey's texts (pairing, approvals, recovery access, notes, hardware unlock). Use a test
network; either edition (Multi or Bitcoin-only) signs on the test networks.

Before you start: firmware **9.27.1 or later** (update it with the BitBoxApp; older firmware cannot sign Trikey's texts and
the phone says so); the BitBox02 set up (a wallet created or restored, backed up) with the BitBoxApp first. Two ways in:

- **USB-C, Android only** (BitBox02 and Nova): plug it into the phone (a USB-C to USB-C cable, or the BitBox02 directly).
- **Bluetooth, the BitBox02 Nova only, Android and iPhone.** BitBoxApp's own Android app uses USB only, so a Nova over
  Bluetooth on Android is untested by anyone: report what happens.

Do:

1. **Connect.** "Create a wallet", **Continue**, **BitBox02**. USB: Android asks whether Trikey may use the BitBox02:
   **Allow** (the system's dialog). Bluetooth: Android asks for "Nearby devices", iOS for Bluetooth; the first time the
   phone's system pairing dialog and the Nova both show a six-digit code: check they are the same and confirm on both.
   Expected: "Looking for your BitBox02", "Connecting to BitBox02" (or the Nova's Bluetooth name).
2. **Unlock.** "Unlock your BitBox02": enter the password on the BitBox02.
3. **The pairing code** (once per phone and BitBox02). The phone shows **Check the pairing code**: four groups of five
   letters and digits on two lines. The BitBox02 shows "Pairing code" with the same. If they are the same, confirm on the
   BitBox02. Expected: "BitBox02 connected" (or "BitBox02 Nova"). Try rejecting it once on the BitBox02: the phone must
   stop and say the pairing was rejected. Later connections must not ask again (unplug and plug in: password only).
4. **Pair** (steps 2 to 4). "Confirm on your device" with the text. The BitBox02 shows **Sign message**, "Coin: BTC Testnet"
   (or Bitcoin) and **External service key**, then an **Address** starting with `tb1q` (`bc1q` on mainnet): that is this
   key's own single-key address, expected, not the wallet's. Then the text, one screen; check it is the phone's word for
   word and confirm (long touch). Then the wallet to register: the name (`Trikey`), **2-of-3**, and the three keys (shown
   as xpub/tpub): approve. Then the first address: **the same as the phone's**. Confirm.
5. **A payment** over the daily limit (step 7): the BitBox02 shows the recipient and amount and the fee; check that the
   **change is not shown** (the wallet is registered). Approve. With many coins (step 18b) it reads every coin's previous
   transaction: check it still works and how long it takes.
6. **The same signature twice.** Turn on notes (18c) and hardware unlock (18d): two rounds, the same text twice. These two
   sign **without anti-klepto** (on purpose, see DESIGN.md "BitBox02"): if the app says the device "gave two different
   signatures", report it with the firmware version.
7. **Unlock the guardian** with it (18d step 2): one connection, the password, one confirmation.
8. **Wrong things on purpose.** Reject a payment and a text on the BitBox02: "You rejected the request on the device."
   Unplug it (or turn the Nova off) in the middle of a signature: "The BitBox02 disconnected". Cancel on the "Unlock" sheet:
   the phone stops. A BitBox02 on firmware older than 9.27.1 (if you have one): the phone refuses it with the update
   advice.
9. **The build without Google** (Android, `foss` APK): steps 1 to 5 over USB must work the same (the USB module uses only
   Android's own USB API).

If it goes wrong, collect: BitBox02 model (BitBox02 or Nova, Multi or Bitcoin-only) and firmware version (BitBoxApp ›
Device settings), USB or Bluetooth, the phone model and OS version, the step, what the BitBox02 showed (a photo, never
your recovery words or password) and the phone's exact message.

---

### 18j. Change the guardian's passphrase (optional; a guardian and an app with this release)

The passphrase can be changed on the guardian's web page, never from the phone (DESIGN.md, "Changing the passphrase").
It encrypts the same key 3 again: your wallet, its rules and the hardware unlock (step 18d) stay as they are.

Do:

1. **Where.** On the phone, Settings, **Guardian**: a note says the passphrase is changed in the guardian's web page and
   that the app can't change it. On the web page, sign in on a second browser (or a private window) too, so there are
   two sessions.
2. **A mistake first.** Settings, **Passphrase**, **Change passphrase…**. Type a wrong current passphrase and a good new one
   twice. You should see "That isn't the current passphrase."; Activity: "Passphrase change refused". Try a new
   passphrase shorter than 12 characters, and two that differ: the page says so before sending anything.
3. **Change it.** The right current passphrase, a new one twice (let your password manager generate and save it if
   you use one). It takes a few seconds, longer on a Raspberry Pi. You should see "Passphrase changed" with notes: the
   old passphrase no longer works, your recovery does not use the passphrase, and copies of the guardian's data made
   before (a backup, a copied volume) still open with the old one. Activity: "Passphrase changed". The phone's Activity:
   "Guardian passphrase changed". If you set up email, ntfy, Telegram or a webhook (step 15), it says so there too. The
   second browser is signed out; this one stays signed in.
4. **Old and new.** Sign out and in again: the old passphrase is refused, the new one works. Lock the guardian from the
   phone and unlock it there: the old passphrase is refused ("That passphrase didn't work"), the new one unlocks.
5. **After a restart.** Restart the guardian. If the hardware unlock is on (step 18d), it unlocks with your device as
   before, without turning it off and on. Otherwise unlock with the new passphrase. A payment within the limit goes
   through.

If it goes wrong, collect: the step and the exact message, the guardian's Activity page and log (the log lines
`guardian.passphrase_changed` and `guardian.passphrase_change_failed` hold no secret). **Never send either passphrase.**

---

### 18. Host a family member (optional; two phones and two hardware wallets)

Family hosting (docs/design/family-hosting.md): your guardian holds key 3 for someone else's wallet. You need a second
phone with the app (the **guest**) and a second hardware wallet. Mainnet works, behind the same warning as the rest of
guardian mode; a test network is the safer place to try it.

1. **Make an invite.** On the guardian's web page, open **Host for someone**, type a name only you will see ("Dad") and
   choose **Create invite link**. Check: the warning says the page never shows their balance or payments but the box
   stores what it co-signs; the link and QR code appear once; reloading the page shows the invite without its link.
2. **Accept it on the guest's phone.** New wallet, connect the guest's hardware wallet, then on "Pair your guardian" scan
   the invite QR (or "I have an invite from someone" and paste the link). Read the screen: it must say the host's box sees
   each payment it co-signs and a recovery's total, and that the host with a thief could skip the wait and keep the alerts
   silent. **Accept and continue** stays greyed out until "I understand ... could help a thief skip the wait" is ticked
   (and, on mainnet, until the mainnet warning is accepted). Set the rules (on mainnet with an alert contact; adding the
   host as one is suggested) and approve on the device. The device shows the first address: it must match the app.
3. **Check the host learns little.** The web page shows the guest as active with "Signed 0 payments this week", no
   amounts. Settings > Guardian on the guest's phone says "Hosted by ..." and "Chain data: ... (public)".
4. **Back up, then receive.** The guest's Receive screen refuses until the phone key is backed up: back it up (step 5),
   then receive a small amount. The balance comes from the public server (or the guest's own: Settings > Guardian >
   Chain server), never from your guardian.
5. **Pay inside the limit** from the guest's phone: phone + your guardian sign. The web page's count goes to 1.
6. **Reset is refused** on your guardian's web page while you host (it says why).
7. **Stop hosting.** On the web page choose **Stop hosting** for the guest: it shows "until <date> to move"; the guest's
   phone shows that hosting ends on that date. Then try **Stop now...**: it needs `STOP HOSTING NOW` typed. Before doing
   it, make sure the guest moved their money (Replace guardian, or a sweep with phone + hardware wallet).
8. **Optional, test network only: a guest's recovery.** On the guest's phone start "Lost my hardware wallet" with a third
   device. The web page shows "Recovery waiting until <date>. Keep this box on and unlocked." and no amount. Cancel it from
   the guest's phone.
9. **The guest's limit off.** On the guest's phone, Settings > Daily limit > "Turn off the limit": the guest's device must
   show `Trikey policy v2 ... limit=off` with the guest wallet's id (not yours). The guest's phone and the guest's contacts
   are told (by the name the guest gave the wallet); your contacts and your email/ntfy channels get nothing. Turn it back
   on from the guest's phone.
10. **A guest's contact pauses only the guest's wallet.** On the guest's phone, Settings > Alert contacts > "Contacts can
    pause this wallet" on. From that contact's nostr app send `LOCK` to the guardian. Check: the contact's answer names
    the guest's wallet ("... is paused"); the guest's Home shows "This wallet is paused" and a payment with the phone alone
    goes to the hardware wallet; **your** wallet still pays with your phone, and the web page still shows the box unlocked,
    with the guest's row saying "Paused by their side" (not who). Resume it on the guest's phone with "Resume with
    <device>" (one device approval). Restart the box in between if you can: the pause must survive it.
11. **The guest's own pause, and your contacts' lock.** On the guest's phone, Settings > Guardian > "Pause this wallet":
    same as 10, nobody else is told; there is no passphrase form on the guest's phone. Then, if one of **your** contacts
    may lock your box (step 16), have them send `LOCK`: the whole box locks, the guest's phone says your box is locked and
    that only you can unlock it.
12. **The guest leaves.** On the guest's phone, Settings > Guardian > "Leave <host>": "Check if it's safe to release"
    must say what is still there while the wallet holds money. Use "Replace guardian" to move to another guardian (for
    example a second test box): at the end the web page shows the guest as "They moved their wallet
    away". Or, with an empty wallet, release it directly (one device approval).

**Key 3's shape on your device (decision 11).** A hosted wallet's descriptor holds key 3 as a depth-0 xpub with no
origin (`[fingerprint]xpub`, "Derivation: m" in a Coldcard file). The app's integrations accept it in code; a real device
must confirm it. Please report, per device you have: Ledger (the wallet policy registers and shows the first address;
the Bitcoin app treats key 3 as an external key with no origin), Trezor (the multisig address matches and a payment signs),
Coldcard (the multisig file with `Derivation: m` imports; Coldcard checks a depth-0 xpub's fingerprint is its own),
Jade / Passport / Keystone (the descriptor imports and the first address matches), BitBox02 (registers the multisig).
If a device refuses it, say exactly what it showed: the fallback is a synthetic BIP 48 origin over the same key
(`syntheticCosignerKeyExpression`, same addresses), which every integration in code also accepts.

## Known limits of this round

- **Pre-alpha and not audited.** Nothing here should be taken as a statement about what is safe with real money. The test
  networks (signet, testnet4) are the safe way to run this plan; mainnet is there for a tester who accepts the risk.
- **Mainnet is allowed in guardian mode, at your own risk.** The network picker offers it, with a warning to accept first
  (pre-alpha, not audited, only an amount you can afford to lose). It is there for a tester whose node runs mainnet and stays
  there (Path A). Use a small amount. On mainnet the guardian will not pair without at least one alert contact, so the app does not let
  you skip that step. Recovery Key mode stays on test networks only.
- **Out of this round:** Recovery Key mode ("No home server?"), passkeys, iCloud and Google Drive backup (the backup
  is a recovery code plus a backup file), QR-based devices (Coldcard Q, Keystone, Passport, Jade, Krux, SeedSigner; steps 18e, 18f and 18g
  are optional and untested on any device), a Jade over Bluetooth (step 18h, optional and untested), a BitBox02 (step 18i, optional and untested), the silent payments and Start9. Family hosting is new and has its own optional step ("Host a family member" below).
- **iOS** is possible from your own Mac only ("Or on an iPhone"): a free Apple ID's install lasts **7 days**, and nobody has
  run it on a real iPhone yet, so report anything iOS-specific. Android stays the main platform of this round.
- **Updates keep the wallet from 0.1.7-alpha on** (the Trikey release key). Moving from 0.1.6-alpha or older still needs
  one uninstall, which wipes the wallet from that phone. Back up before any update all the same.
- **The recovery wait is 7 days at the shortest** and cannot be sped up on a real network (step 12).
- **Public relays.** The phone and the guardian talk through public nostr relays. They can drop or delay messages. A flaky
  relay shows up as a timeout, not as a wrong answer. Report which relays you used.
- **Alerts reach you through nostr direct messages**, so they need a nostr app with working DM relays. That is part of what is being tested.
  Email, ntfy and webhook alerts (step 15) are optional extras: warnings only, never a way to cancel or lock.
- **One network at a time on the Umbrel.** On Path A the node stays on mainnet; on Path B it is switched. See "Before you start".
- **The from-source route and this workflow are untested on real hardware.** If a command here does not match what you see on your
  box, trust what you see and tell me.

---

## What to keep out of bug reports

- The **recovery code**, the **backup file**, the guardian's **passphrase** and any **seed words**, even on a test network.
- Your email **app password**, **ntfy access tokens**, **webhook URLs** (a Home Assistant webhook URL is itself a secret)
  and **webhook secrets**.
- Everything else is fine to send: screenshots, guardian log lines (they hold no keys or request bodies), npubs, addresses,
  transaction ids, relay URLs.

How to get the phone's own log, if the app crashes: turn on USB debugging, connect the phone to a computer with `adb`, and run
`adb logcat -d > phone-log.txt` straight after the crash. Skim it before sending. There is no in-app log export in this build, so
screenshots of the exact messages matter.

## Bug report template

Copy this, one report per problem.

```
Title: <one line: what you did, what went wrong>

Step in the plan: <number and name, e.g. "8. A payment over the limit">
When: <date, local time, and time zone; the minute helps when matching logs>
Result: <it did not work | it worked but looked wrong | it crashed | I am not sure>

What I did:
  1.
  2.
What I expected (the "you should see" line):
What happened instead (exact wording of any message):

Setup
  App build: <APK file name / commit / draft release tag>
  Phone: <model, Android version>
  Hardware wallet: <Ledger Nano X / Stax / Flex or Trezor model>, firmware <version>,
                   <Ledger "Bitcoin" or "Bitcoin Test" app version | Trezor Suite Lite version>
  Network: <mainnet | signet | testnet4 (shown as Testnet in the app)>
  Guardian: <Umbrel version>, Trikey Guardian <store version, e.g. 0.1.1-alpha | image built from commit>, Bitcoin Node app <version>, Electrs <version>
  Relays in use: <the three defaults | others>
  Guardian state when it happened: <Unlocked | Locked | Offline>, recovery running: <yes | no>
  Limit and what was already spent today:

What I collected
  [ ] Screenshots of the phone screens (including the exact message)
  [ ] Screenshot of the guardian's Dashboard and Activity page
  [ ] Guardian log (last 300 lines around the time): Umbrel Settings, Troubleshoot, or sudo docker logs --tail 300 trikey-guardian_server_1
  [ ] Transaction id(s) and address(es), if a payment was involved
  [ ] Phone log (adb logcat -d), if the app crashed
  [ ] Device screen photo, if the hardware wallet showed something unexpected

Does it happen every time? <always | once | only after ...>
Did you try again? <what changed>
Not included on purpose: recovery code, backup file, passphrase, seed words.
```
