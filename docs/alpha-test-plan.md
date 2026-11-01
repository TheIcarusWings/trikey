# Trikey alpha test plan: guardian mode on mainnet or a test network

A checklist for the first hands-on test, written for the owner of the Umbrel. It covers **guardian mode only**,
with an **Android phone**, a **Ledger (Bluetooth) or Trezor (through Trezor Suite Lite)** and the **Umbrel** as the
guardian's box. You choose one of two paths: **mainnet** on your everyday node, with a small amount of real bitcoin, or a
**test network** (signet or testnet4), with test coins. "Before you start" explains both.

Plan on two sittings: one evening for "Before you start", then an afternoon for steps 1 to 11 and 14. Steps 12 and 13 are
separate, and step 12 takes a week if you let it finish. On mainnet, add the time Electrs needs to index the chain if it is
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
  says "Pre-alpha · not audited" instead of "Pre-alpha · test network". The Ledger needs the **Bitcoin** app, not "Bitcoin Test".
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
  guardian either. Check the box's internet connection (a relay that is down only matters if all of them are). The relays are
  chosen at setup and cannot be changed afterwards in this build; note which ones you picked in the bug report.

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

**Start9 variant.** The steps in the app are the same, but the Start9 package cannot be used for this round: it is written for
Start9's Bitcoin package, which runs mainnet only, and `packaging/start9/startos/main.ts` hard-codes `BITCOIN_NETWORK: 'bitcoin'`.
It has not been tried for this round, and Start9 is out of it (see "Known limits").

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
(`.github/workflows/android-apk.yml`). Take the newest pre-release. Before a release is made, every pull request that touches
the app already builds it and opens it in an Android emulator (and in the iOS Simulator), so a build that crashes at start
does not reach a release. A local build is in `apps/mobile/README.md`, "Android".

What kind of build it is:

- A **release build** with the app's code inside it. Nothing needs to run on a computer, and it starts in **Real** mode.
- From 0.1.7-alpha, signed with the **Trikey release key**: a newer release installs over the older one and the wallet on the
  phone stays. To get updates without downloading by hand, use Obtainium ([docs/android-signing.md](android-signing.md)).
  Builds up to 0.1.6-alpha had a one-off key each: to move from one of those, **uninstall it first, which deletes the wallet
  on that phone**. Back up first.
- No passkeys and no Google Drive or iCloud backup in this build. The backup is a recovery code plus a backup file.
- Built for 64-bit phones by default (every phone from the last several years).

To install: check the file against the `.sha256`, copy the APK to the phone, open it, and allow installing from that source
when Android asks. Play Protect may warn about an unknown app; that is expected for a sideloaded test build.

**Updating the app.** A newer release installs over the installed one and keeps the wallet (both are signed with the Trikey
release key). Three ways, pick one:

- In the app: **Settings → About → Check for updates**. It asks GitHub only when you tap it, says whether a newer version
  exists, and **Download** hands the APK to Android's installer. Check the SHA-256 it shows against the release's `.sha256`.
- Obtainium, which watches the repository's releases for you: see [docs/android-signing.md](android-signing.md).
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
- **Path A:** pick Mainnet. The pill changes to "Pre-alpha · not audited", and a warning appears, "Mainnet means real bitcoin":
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
  period (7 days is the shortest). The button "Approve on Ledger" has the device approve the rules.
- Then in Settings, **Alert contacts**, **Add contact**: name it "Me", paste **your own npub** (or scan it), and approve on the
  device. Adding a contact needs the hardware wallet; that is on purpose. **On mainnet this step cannot be skipped.** On a
  test network the app would let you skip it, but do it anyway, because step 12 needs the contact.

You should see: after approval, the Alert contacts list shows "Me" with the shortened npub, next to "This phone, always
included". On the Guardian page, **Rules** shows the same daily limit, waiting period and the contact, and Activity lists the rule changes.

If it goes wrong, collect:

- The message on the phone and what the device displayed.
- The guardian's Activity page (screenshot) and its log.
- Whether the npub you pasted is the one from your own nostr app (it starts with `npub1`).

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

If it goes wrong, collect:

- Which side you locked from and unlocked from, and the status the other side showed.
- The guardian log, and the Activity page (it records unlocks and locks, with "via" web or phone).

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

---

## Known limits of this round

- **Pre-alpha and not audited.** Nothing here should be taken as a statement about what is safe with real money. The test
  networks (signet, testnet4) are the safe way to run this plan; mainnet is there for a tester who accepts the risk.
- **Mainnet is allowed in guardian mode, at your own risk.** The network picker offers it, with a warning to accept first
  (pre-alpha, not audited, only an amount you can afford to lose). It is there for a tester whose node runs mainnet and stays
  there (Path A). Use a small amount. On mainnet the guardian will not pair without at least one alert contact, so the app does not let
  you skip that step. Recovery Key mode stays on test networks only.
- **Out of this round:** Recovery Key mode ("No home server?"), passkeys, iCloud and Google Drive backup (the backup
  is a recovery code plus a backup file), QR-based devices (Coldcard Q, Keystone, Passport, Jade, SeedSigner), BitBox02, the
  "I have an invite" screen (a fixed demo; family hosting comes later), silent payments and Start9.
- **iOS** is possible from your own Mac only ("Or on an iPhone"): a free Apple ID's install lasts **7 days**, and nobody has
  run it on a real iPhone yet, so report anything iOS-specific. Android stays the main platform of this round.
- **The APK is signed with a one-off key.** To move to a newer build you uninstall first, which wipes the wallet from that phone.
  Back up before every update.
- **The recovery wait is 7 days at the shortest** and cannot be sped up on a real network (step 12).
- **Public relays.** The phone and the guardian talk through public nostr relays. They can drop or delay messages. A flaky
  relay shows up as a timeout, not as a wrong answer. Report which relays you used.
- **Alerts reach you through nostr direct messages**, so they need a nostr app with working DM relays. That is part of what is being tested.
- **One network at a time on the Umbrel.** On Path A the node stays on mainnet; on Path B it is switched. See "Before you start".
- **The from-source route and this workflow are untested on real hardware.** If a command here does not match what you see on your
  box, trust what you see and tell me.

---

## What to keep out of bug reports

- The **recovery code**, the **backup file**, the guardian's **passphrase** and any **seed words**, even on a test network.
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
