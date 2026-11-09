# Changelog

Trikey is pre-alpha and not audited. Each release has a guardian image
(`ghcr.io/theicaruswings/trikey-guardian`, pinned by digest in the
[Umbrel community store](https://github.com/TheIcarusWings/trikey-umbrel-store)) and an Android test APK on its
[GitHub release](https://github.com/TheIcarusWings/trikey/releases). How to install and test:
[docs/alpha-test-plan.md](docs/alpha-test-plan.md).

## [0.1.26-alpha] - 2026-11-09

A guardian fix for shutting down, and how releases reach you. Update the guardian, then the app.

- **The guardian finishes what it started before it stops.** When the guardian stopped (an Umbrel update or restart),
  an alert still being sent to your contacts, for example about money leaving Savings, could be cut short, and so
  could a save of its state. Now it waits for both, up to a few seconds (#222).
- **Releases are normal GitHub releases now**, not pre-releases: Obtainium no longer needs "Include prereleases", and
  Zapstore should pick each release up by itself. The version still says "alpha", and Trikey is still pre-alpha and not
  audited. After each release a check watches Zapstore and opens an issue if an app isn't updated there (#221).
- For testers: [docs/testers.md](docs/testers.md), a one-page start, and a "Hardware wallet test report" issue form;
  every device but the Ledger is still to be tried on real hardware (#216). The beta checklist records the defaults
  (a 200,000 sats daily limit suggested, a 7-day delay), Start9 as "build it yourself" and the iPhone built from source
  for the beta (#215).
- For maintainers: `tools/release/bump.mjs` moves the version everywhere, docs/releasing.md is the runbook, and the
  changelog uses Keep a Changelog headings so Zapstore gets one release's notes (#217, #218); a flaky test fixed (#220).

## [0.1.25-alpha] - 2026-11-09

Fixes from a third security review (Grok only, on 0.1.24's code), a simpler Home screen for one wallet, and Trikey on
Zapstore and Obtainium. Update the guardian, then the app.

- **The guardian refuses to co-sign while its clock is behind the chain**, as it already did while ahead. Before, a
  phone thief who could also set the home server's clock back could spend the daily limit again for every day they
  moved it. The app now says the guardian's clock is off and to check the box's date and time (#213).
- **Family hosting keeps a guest's coins in view until they are really spent.** A coin left the host's list when the
  chain server did not list it, which is also true of a payment not broadcast yet, or of a malformed reply; a stolen
  guest phone could then make a coin only the guardian can co-sign drop out of a later recovery. Now a coin leaves only
  once the coin its transaction spends is gone, a reply that isn't a list is an error, and leaving the host checks the
  hardware approval first and needs every coin settled (#213).
- **Savings alerts can't be crowded out.** A large spend from Savings hidden behind 400 small ones was never announced,
  and alerts to contacts kept only the last 32. Now every spend is handed over (largest first) before a scan counts as
  complete, and no alert still owed to someone is dropped: past 64, the smallest fold into one total (#213).
- **A `LOCK` dated in the future is remembered and counted** against the contact's limit, so a relay delivering it
  again later can't lock the guardian then (#213).

- **One wallet looks like one wallet.** Home no longer shows a wallet name and switcher by default. Several wallets is
  now a setting (Settings, Wallets), off unless you turn it on; it stays on while the phone holds more than one wallet,
  so no wallet is ever hidden. The demo starts with one wallet (#211).
- **Releases are checked more strictly.** The publish check rebuilds the release's compose file from the tagged code and
  the verified image, and requires it byte for byte; the Umbrel store and Start9 jobs take only the digest verified for
  that commit; release runs are matched by commit, not by name; and a release whose files changed while publishing is
  pulled back (#212).
- **Get it on Android:** both apps are on Zapstore (Trikey and Trikey FOSS), and
  [trikey.app/obtainium](https://trikey.app/obtainium) adds either to Obtainium in one tap (#205, #207, #208).
- The README explains Trikey with diagrams and screenshots, the site no longer says "coming soon", the iPhone build
  docs cover an iPhone on a newer iOS than Xcode knows, and docs/beta-checklist.md lists what stands between this alpha
  and a beta (#203, #204, #206, #209, #210).

## [0.1.24-alpha] - 2026-11-09

The last, low-severity findings of the second security review, and every dependency advisory fixed. Update the
guardian, then the app.

- **Your own phone no longer counts as your alert contact.** On mainnet a wallet needs at least one alert contact other
  than its paired phone, at pairing and at every rule change; a wallet already paired with only the phone keeps working
  and is warned (#194).
- **"Lost my hardware wallet" checks the new device first.** Before anything is swept to the new wallet, the new device
  registers it, shows its first address (it must match) and signs a proof. When a new phone replaces a lost one, the
  Recovery Key's key is read from the device too, not only from the guardian (#195).
- **The recovery code is harder to leak.** No Copy button, the words can't be selected, Android blocks screenshots of
  the screen, and the app covers it in the app switcher (#195).
- **The BitBox02 pairing key moved to the phone's secure storage**, out of phone backups (#195).
- **The phone no longer trusts any address number the guardian reports**: at most 20 past the last one it knows is
  used (#195).
- **Family hosting: a co-signature no longer drops a guest's coins from the host's ledger** before the chain shows them
  spent (#194).
- **A chain server is judged by its address, not its label**: an internet server labelled "your own" is treated as
  public (refused during a recovery) (#194).
- **Local-network filters catch every spelling of an address** (IPv6 forms of local addresses, shorthand IPv4), in one
  shared filter; contacts' `.onion` relays are skipped (#193).
- **Strangers can't fill the guardian's log** with fake CANCEL messages or refused recovery requests, and the right setup
  code always works even while wrong ones are being tried (#194).
- **Dependencies: npm audit reports nothing.** nodemailer (the guardian's email alerts) and Expo's and Ledger's
  libraries updated or pinned past their advisories (#189, #190, #198, #201); the guardian image no longer keeps a code
  cache in /tmp, and the Zapstore tool is pinned (#193).
- **Releases:** the last check before publishing compared the files wrongly and stopped 0.1.23 (#200); the iOS launch
  check now reports on every pull request (#196); a full-history secret scan is clean (#197).

## [0.1.23-alpha] - 2026-11-09

A security release, from a second review of the whole project (two independent AI-run audits compared, each finding
checked against the code and fixed with a test that reproduces it). 0.1.22-alpha was never published: its release
stopped at a check of its own files (#185), so this one has everything it had, and more. Update the guardian, then the
app: with this guardian an older app cannot pair a new wallet, add a wallet or change your alert contacts (it says
"update the app"). Nothing here was exploited that we know of. And on Android, the build without Google is now its own
app.

- **Your hardware wallet now names your alert contacts** when it approves rules (pairing, adding a wallet, a rule
  change): `contacts=npub1abcdefgh..wxyz`, the start and end of each contact's npub, or for many contacts their number
  and a code that the guardian's web page (Rules) and the app show too. Compare them before you approve. Before, it
  showed only how many contacts there were, so a tampered app could swap your contact for its own unseen. Every contact
  added or removed now gets a message, and Activity names them (#180).
- **Adding a wallet needs your first wallet's hardware wallet** (one more confirmation, `Trikey add-wallet v1`), and
  your first wallet's contacts are told of every wallet added and every hardware unlock turned on. Before, a stolen
  phone could add a wallet with a hardware key of its own. **New in the guardian's web page** (Settings > Wallets and
  hardware unlock): see every wallet and its hardware unlock, turn any unlock off, and remove a wallet after the first
  without its hardware wallet (type `REMOVE WALLET`). Removing is refused while that wallet's recovery runs (#180).
- **A stolen phone can no longer freeze a recovery** by co-signing thousands of payments to itself that are never
  sent. Only what the guardian sees on chain moves where it looks for your change now. Co-signing has a minimum fee
  (0.1 sat/vB) and a limit of 30 payments an hour and 200 a day per wallet. A daily limit of 1,000 BTC or more now
  counts as "no limit" for every purpose, and a guardian whose clock was pushed forward no longer forgets payments
  (#179).
- **On Umbrel, another app can no longer use the guardian page's sign-in.** Browsers send a page's cookie to every app
  on the same address, so the sign-in now also needs a secret only the guardian's own tabs hold. Opening the guardian
  in a new tab while none is open asks for your passphrase. The guardian also trusts only Umbrel's own gateway: on
  umbrelOS 1, a new guardian asks for its setup code (in the app's logs, Settings > Troubleshoot) (#175).
- **Umbrel backups leave the guardian out**, as on Start9. A restored Umbrel starts an empty guardian: set it up and use
  **Replace guardian** with your phone and hardware wallet. Backups made by 0.1.21-alpha or earlier still hold a copy
  of the guardian's data (its key under your passphrase): delete them if you can. microSD signing (Passport gen 2,
  Krux) now ends with a step to delete the signed files from the card (#176).
- **Turning hardware unlock off and on again now really replaces it.** The guardian picks the new unlock's id, so an
  old signature (one malware kept, say) can never make the old unlock again. An old copy of the guardian's data still
  opens with the old signature: only Replace guardian revokes that. An older app can't turn hardware unlock on with
  this guardian ("update the app"); unlocking with one you have keeps working (#181).
- **A stranger who reaches the guardian's page can no longer keep you waiting to unlock.** Failed passphrases count
  per address; on Umbrel, your own logins through Umbrel never wait for anyone else's (#181).
- **Bitcoin Core's password is tied to its port too**: changing the port asks for the password again (#181).
- **Messages to your alert contacts reach their own inbox relays**, also when the guardian has its maximum of relays
  (#183).
- **Wallet names in alerts are plain text**: letters, digits, spaces, `-` and `'` only, so a thief can't send your
  contacts a link in a wallet's name (#183).
- **The guardian refuses floods before writing them**: per-sender limits on stored requests, on its memory of handled
  messages (your own phones' entries are never pushed out), and on CANCEL replies (#183).
- **The guardian no longer accepts an unsealed unlock from the phone** (the passphrase or a hardware unlock sent in
  the clear, as apps before 0.1.17-alpha did): an older app must be updated to unlock the guardian or turn hardware
  unlock on. Family hosting: each guest's recovery now has its own lock, so one guest can't hold up another's or the
  host's. Repeated requests (notes, broadcasts, adding a wallet) are recognised after a restart too, contacts' inbox
  relays on your local network are never used, and the phone no longer stores strangers' unreadable messages (#186).
- **Trezor: the reply from Trezor Suite Lite must carry a one-time token**, and the key and addresses must be for the
  path asked for (#182).
- **Recovery Key mode checks the second hardware wallet too**: it registers the vault and shows the same first
  address (test networks only for now) (#182).
- **Jade over Bluetooth reaches only Blockstream's PIN server**, or one you confirm as your own, over https, with no
  redirects (#182).
- **Recovery Key mode's pre-signed refills are encrypted on the phone**, so a phone backup can't broadcast them (#182).
- **Android: Trikey FOSS.** The build without Google code is now its own app (`app.trikey.wallet.foss`, "Trikey FOSS"),
  installable beside the standard Trikey. Had the no-Google APK of 0.1.21-alpha or earlier? The new one installs as a
  separate, empty app: restore your wallet in it from your backup file and recovery code, check it, then uninstall the
  old one (docs/android-signing.md) (#169).
- **Releases are checked before they go out.** A release starts as a draft and is published only after its 7 files,
  their checksums and both APKs' signatures are checked; each release pushes one image tag, which a re-release cannot
  change; the build tools are pinned (#177, #171, #185).
- The daily-limit bar on the guardian's home page is visible again (#172). The docs explain renewing the iPhone's
  7-day profile (#174).

## [0.1.21-alpha] - 2026-11-06

A security release: fixes from an external review of the whole project (an AI-run audit, each finding checked against
the code before fixing). Update the guardian, then the app: a guardian with this release refuses to pair with an older
app. Nothing here was exploited that we know of.

- **Your hardware wallet now approves the rules a new wallet starts with.** When you pair, add a wallet, accept a family
  invite or replace your guardian, your hardware wallet asks for one more confirmation showing your daily limit
  (`limit=`, in sats), waiting period (`delay=`), sweep fee cap and number of alert contacts: check them before you
  approve. Before, only the app chose these rules, so a tampered app could have set a limit high enough to empty the
  wallet with the phone and guardian alone. Wallets already paired keep their rules (#167).
- **A notification channel moved to another server no longer keeps its secrets.** Moving an ntfy channel needs its topic
  again and forgets its token; a webhook with a new address forgets its signing secret; changing the email server, port,
  encryption, user name or pinned certificate needs the app password again (#164).
- **On Umbrel and Start9, only you can set up a new guardian.** Other apps on the same box could reach a guardian not yet
  set up. On Umbrel nothing changes for you (the guardian recognises Umbrel's login); on Start9 the guardian asks for a
  setup code: Actions > Show Setup Code, or the dialog that shows your web password (#164).
- **Bitcoin Core's password goes only where it was checked**, and on Start9 the guardian no longer sees Bitcoin's whole
  data folder. The docs list the exact RPC calls the guardian needs, and advise keeping no funds in the node's own
  wallet (#164).
- **Savings: a payment out can no longer be hidden behind many small payments in.** The guardian now checks every Savings
  transaction; if there are too many to check for half an hour, you and your contacts get "Savings not fully checked"
  instead of silence (#166).
- **Cancelling a recovery by DM: the cancel line must be the whole reply.** A reply quoting the guardian's alert no longer
  cancels; anything else gets a short answer saying exactly what to send (#166).
- **The guardian's one-time unlock key is replaced after every try**, whatever the answer, and **a burst of refused
  payment requests hits the same limit as one after another** (#166).
- **Recovery Key mode: the vault's address waits for your hardware wallet.** QR and NFC devices now confirm the vault's
  first address too; no vault address is shown until one has; key exports that don't match their path are refused
  (#165).

## [0.1.20-alpha] - 2026-11-06

Change the guardian's passphrase, and BitBox02. Update the guardian, then the app; each works with the other side's
older version.

- **Change the guardian's passphrase.** On the guardian's web page, Settings > Passphrase: the current passphrase, then
  the new one twice. Your wallet, its rules and unlocking with your hardware wallet keep working. Other browsers are
  signed out, and your phone and your email, push or Telegram alerts say it happened. The old passphrase stops working
  everywhere (password manager, paper, an older app you once typed it into); your recovery code, backup file and
  recovery sheet don't use it, so there is nothing to print again. A copy of the guardian's data made before the change
  (a backup of the box, a copied Docker volume) still opens with the old passphrase: delete it or keep it safe. The app
  can't change the passphrase, so a stolen phone can't either (#160).
- **BitBox02.** Plug a BitBox02 into an Android phone's USB-C port, or connect a BitBox02 Nova over Bluetooth on Android
  or iPhone. It sets up your wallet, approves payments and rule changes, gives recovery access, keeps your notes on the
  guardian and can unlock the guardian. It needs firmware 9.27.1 or later; the first time, check that the phone and the
  BitBox02 show the same pairing code. Payments are signed so the phone can check the BitBox02 hides nothing in its
  signatures (anti-klepto). Notes and hardware unlock made with a BitBox02 work only with a BitBox02: if you move your
  recovery phrase to another brand, turn them on again. Not yet tried on a real BitBox02: please test (alpha test plan,
  step 18i) (#159).

## [0.1.19-alpha] - 2026-11-06

A fix for the iPhone app, and Jade over Bluetooth. Update the app; the guardian has no changes.

- **iPhone: 0.1.18 closed itself right after opening. Fixed.** A part of the Coldcard NFC code loaded itself in a loop on
  phones; on an iPhone without NFC that stopped the app at launch. Your wallet was not touched. A new test catches this
  kind of mistake, and releases now wait for the iPhone launch check (#158).
- **Jade over Bluetooth.** A Blockstream Jade or Jade Plus can connect over Bluetooth, not only with QR codes: it sets up
  your wallet, co-signs payments, approves your guardian's changes, and can keep your notes on the guardian and unlock
  it. To unlock the Jade you type its PIN on the Jade, and your phone passes an encrypted check between the Jade and its
  PIN server (Blockstream's, unless you set your own); that server sees your phone's IP address and when your Jade
  unlocks, never your PIN or keys, and the app says so before the first unlock. In QR mode Trikey contacts no PIN
  server. Not yet tried on a real Jade: please test (alpha test plan, step 18h) (#156).

## [0.1.18-alpha] - 2026-11-06

More hardware wallets for guardian wallets: Coldcard over NFC, and Passport (2nd generation) and Krux from a microSD
card. Update the guardian, then the app; each works with the other side's older version.

- **Coldcard Mk4, and Coldcard Q without QR codes.** Pick "Coldcard by NFC" and hold your phone to the Coldcard: it
  shares its key, keeps your 2-of-3 wallet, signs payments, and signs Trikey's short texts for your guardian, notes and
  unlock. Turn on NFC Sharing in the Coldcard's settings first. On Android, NFC is optional (phones without it still
  install Trikey, and the app says when NFC is off); on iPhone it needs a build made with a paid Apple developer
  account, which the current test builds don't have, and the app says so. Not yet tried on a real Coldcard: please
  test (alpha test plan, step 18g) (#154).
- **Passport (2nd generation) and Krux can set up a guardian wallet.** They sign Trikey's short texts from their
  microSD card: the phone gives you a small file to copy to the card, you check the text on the device and sign it, and
  you bring the signed file back (Krux can also show the signature as a QR code). The phone checks the signature before
  using it. This covers pairing, approving rule changes, recovery access and notes on the guardian; unlocking the
  guardian isn't offered for them (a card round trip after every restart), so the passphrase works as before. Not yet
  tried on these devices: please test (step 18f) (#153).
- **SeedSigner co-signs payments only.** It can't sign Trikey's texts with the key your guardian checks, and the only
  workaround would make you approve without seeing the text. Use it in Recovery Key mode or as a payment co-signer
  (#153).
- **Telegram: what comes next.** After you save a Telegram bot on the guardian's page, it says that the bot sends
  nothing yet and how to add a Telegram channel for you or a contact, until you have one (#152).
- **Support the project.** Settings > Support the project in the app, and a Support section in the guardian page's
  Settings, show the project's one public donation address, what donations pay for, and a plain warning: you get
  nothing in return, so give only what you'd be fine never seeing again (#137).

## [0.1.17-alpha] - 2026-11-06

Unlock the guardian with your hardware wallet, sealed unlocks, and QR hardware wallets for guardian wallets. Update the
guardian, then the app; each works with the other side's older version.

- **Unlock your guardian with your hardware wallet.** After a restart the guardian is locked until you unlock it. Turn
  on Settings > Guardian > "Unlock with your hardware wallet" (off by default): from then on one confirmation on the
  device unlocks the guardian from your phone, without typing the passphrase, which always keeps working. Your phone
  keeps nothing that can unlock the guardian by itself, so a stolen phone still can't. With several wallets, each
  wallet's device can be turned on separately, and any of them unlocks the guardian (#147).
- **Your unlock is sealed.** Unlocking from the phone, with the passphrase or the hardware wallet, and turning the
  hardware unlock on, are now sealed to a key the guardian keeps only in memory and replaces at every lock, unlock and
  use. Even someone who later steals the guardian's disk and has kept old relay messages can't read them. An older app
  still unlocks; the guardian's Activity page then asks you to update it (#149).
- **QR hardware wallets can set up a guardian wallet.** A Coldcard Q, Jade, Keystone 3, Passport Prime or Specter DIY
  can now pair with your guardian, approve rule changes, let a new phone start a recovery, keep your notes on the
  guardian and unlock it. The phone shows the short text to sign as a QR code; the device shows the same text, signs
  it and shows the signature as a QR code; the phone checks it before using it. Not yet tried on these devices: please
  test (alpha test plan, step 18e) (#150).
- **Trikey asks which QR device you have.** Passport (2nd generation), Krux and SeedSigner co-sign payments but can't
  set up a guardian wallet yet, and the app says so before you start. The Coldcard Mk4 has no camera and needs NFC or
  USB, not supported yet. A QR device added before this version shows as "Other": pick its model in Settings >
  Advanced > Hardware wallet model (#150).
- **Clearer unlock errors.** When the phone may not unlock (too many wrong tries, or a recovery this phone didn't
  start), the app says to unlock on the guardian's web page (#147).

## [0.1.16-alpha] - 2026-11-05

Notes that survive losing your phone, a check on every Speed up, and a note about the phone itself. Update the
guardian, then the app; each works with the other side's older version.

- **Keep your notes safe with the guardian** (Settings > Wallet details, off by default). Your labels, frozen coins,
  payment notes and address labels can be kept as an encrypted copy on your guardian, so they survive losing the phone
  and its backup. The key comes from your hardware wallet (it confirms the same text twice, so any phone can make the
  key again); the guardian stores the copy but cannot read it, and learns only roughly how many notes you keep and when
  they change. It keeps the last three versions. Turning it off deletes the copy. Ledger and Trezor; not yet for
  QR devices or a wallet hosted on someone else's guardian (#143, #144).
- **Bring back your notes.** After a recovery (on its last screen, when the phone has no backup) or a restore, the app
  offers the copy on the guardian: one confirmation on the hardware wallet and the notes come back. Where the phone or
  its backup already has a label, that one is kept. After a recovery, turn the option on again for the recovered
  wallet (#144).
- **Speed up checks the payment first.** Before your phone signs a faster version of a payment (Spending or Savings),
  it checks that the original is really the payment this wallet signed, from its own coins, and that the new version
  only adds fee from your change: same coins, same recipients, same amounts. If anything doesn't match, nothing is
  signed or sent, and the app says so (#145).
- **A note about this phone.** The Security tab tells you, calmly, when the phone has no screen lock, when its Android
  security update is more than 6 months old, or when Trikey runs in an emulator or simulator (fine for testing, not for
  real money). It is worked out on the phone and never sent anywhere (#145).

## [0.1.15-alpha] - 2026-11-05

Coin control, Telegram alerts, labels everywhere, and a calmer guardian home page. Update the guardian, then the app;
each works with the other side's older version.

- **Coin control.** Every payment into your wallet is a coin, and Home has a new **Coins** list (Savings has one too).
  Open a coin to see where it came from, give it a label, or **freeze** it: a frozen coin is never spent until you
  unfreeze it, which suits a tiny coin from a stranger (it may be there to track you) or a coin you keep apart. Send max
  leaves frozen coins alone (#134, #135).
- **Choose coins on Send.** Pick which coins pay. Trikey warns before coins with different labels go out together,
  since that links them on chain (#135).
- **Consolidate.** Merge small coins into one while fees are low (the app says when they are). Only the network fee
  counts toward your daily limit. In Savings, your guardian announces "Savings consolidated" rather than "Money moved
  out of Savings" (#134, #135).
- **Labels in the backup, and BIP 329.** Labels and freezes stay on your phone and in its backup, never on the guardian.
  Settings > Wallet details exports and imports them as a BIP 329 file that Sparrow and other wallets read. A backup with
  labels or a consolidation uses a new format (version 6); older apps say "update the app" for it (#134, #135).
- **Label an address before you share it** (Receive, Spending and Savings). The coin that arrives there shows the label
  unless you give the coin its own. Labels also end their payment's row in Activity and show in its details (#140).
- **Telegram alerts.** Next to email, ntfy and webhooks, the guardian can send its alerts to Telegram, for you and for
  alert contacts who won't install a nostr or ntfy app. Make a bot with @BotFather, paste its token under Settings >
  Notifications > "Add Telegram"; each person sends the bot /start once, then you press Find and pick them. Plain text,
  no links, warnings only; cancelling and locking stay with nostr. Telegram can read these messages, as an email
  provider can, and the page says so. Every change is announced on every channel; during a recovery you can only add
  chats or give the same bot a new token. The app lists Telegram chats under Settings > Alert contacts. WhatsApp is not
  built in (business account, templates and fees, or unofficial clients that break its terms); a webhook can reach it
  through a gateway of your choice (#138).
- **Several wallets, continued.** "Move everything" before removing a wallet can include frozen coins ("Include 1
  frozen coin", off by default). "Print a recovery sheet" (Settings > Wallets or Guardian) prints each wallet's name,
  hardware wallet, wallet id, your guardian's npub and relays and the code a new phone scans, one page per wallet or
  all on one sheet, with no seed words, keys or recovery code (#140).
- **A calmer guardian home page.** The Electrs and Bitcoin Core 32 note shows on Home only when payments to you really
  go unseen until confirmed. When the guardian reads them from Bitcoin Core, Settings > Server explains it as
  information, and on Umbrel or StartOS says there is nothing to do and the lasting fix is the platform's Electrs
  update (#139).
- **Guardian: live wallet housekeeping.** Addresses of a wallet it stops watching are let go at once (unsubscribing on
  the server where supported), and a ten-minute safety pass catches a payment notification the server or the network
  lost, in one round trip, re-reading only what changed (#141).
- Demo: coins with labels, a frozen one, and coin picking in Savings.

## [0.1.14-alpha] - 2026-11-05

Several wallets in one app, and a clearer Server page. Update the guardian first, then the app: an app with several
wallets needs a guardian with this release.

- **Several wallets in one app.** Add a wallet with another hardware wallet (Settings > Wallets, or the switcher at the
  top of Home). Each wallet has its own daily limit, alert contacts, recoveries and Savings (with its own Recovery Key),
  on the same phone and the same guardian. Behind the scenes each wallet uses its own hidden BIP 48 account of the same
  phone and guardian keys, so nothing on chain links the wallets, and one backup and one recovery code hold them all.
  - Send and Receive name the wallet. The app shows the total of the daily limits, because anyone who unlocks the
    phone can spend up to each wallet's limit.
  - Wallets you are not looking at stay up to date in the background.
  - Rename a wallet, or remove one once its money is moved to another (the guardian retires it).
  - "Replace guardian" moves every wallet with one pairing code, each with its own hardware wallet; if one device
    isn't at hand, the others move and that one waits ("1 of 2 moved").
  - On the guardian's web page, a wallet picker on Wallet, Rules, Recovery and Activity; alerts name the wallet.
  - The demo has a second wallet. Silent payments stay with the first wallet for now (#126, #127, #131, #132).
- **Backups:** once there is more than one wallet, the backup uses a new format (version 4, or 5 with an added wallet's
  Savings); older apps say "update the app" for it. An older app on a phone with several wallets opens only the first
  wallet: keep the backup, it brings every wallet back. A guardian downgraded after a wallet was added keeps serving the
  first wallet; the others move with phone + hardware wallet.
- **Settings > Server, simpler on Umbrel and StartOS.** It now says "Connected to this Umbrel's Electrs and Bitcoin
  Core (set up by Umbrel)", with the status and the Electrs warning; choosing another server sits under "Advanced".
  "Use the server Umbrel set" undoes a server saved in the page, so the guardian follows Umbrel again. Saving without a
  change is greyed out and never announced. The home warning says when unconfirmed payments are read from Bitcoin Core,
  and links straight to the "Bitcoin Core alone" option (#128).
- **The Wallet page's balance matches the phone:** the total, with "including … sats waiting to confirm" under it (#128).
- Coin control is on the way: its plan and decisions are in DESIGN.md (#129), and its groundwork (BIP 329 labels, a
  label and freeze store, the coin list) is in (#130); the screens come next.

## [0.1.13-alpha] - 2026-11-05

Fixes from testing 0.1.12 on an Umbrel on mainnet, and a Wallet page on the guardian. Update the guardian and the
app; each works with the other side's older version.

- **Your own unconfirmed payment's coins are never used again.** After a payment, the next sync could list the coin it
  had just spent as unspent again, when the guardian's chain server hadn't seen the payment yet, and a second payment
  could pick it. At the same fee the node refuses that payment; at a higher fee it would have replaced (cancelled) the
  first one. The app now keeps the coins of its own unconfirmed payments out of every payment and of the balance, and
  shows their change as pending, whatever a sync says, until the payment confirms or drops (#121).
- **Electrs on Umbrel can't see Bitcoin Core 32's mempool.** Core 32 dropped a field (`bip125-replaceable`) that Electrs
  0.11.1 requires, so Electrs skips every unconfirmed transaction and answers every request about 7 s late. Incoming
  payments then appear only once confirmed. The guardian now:
  - reads unconfirmed payments from Bitcoin Core itself when it has Core's RPC (Umbrel passes it), so they show and
    alert again before they confirm;
  - treats the payments it broadcast itself as pending until the server lists them;
  - warns on its web page, naming the cause and the two fixes: `deprecatedrpc=bip125` in Bitcoin Core's config, or
    Settings > Server > Bitcoin Core alone;
  - sends the "confirmed" alert sooner after a block (one round trip instead of three).

  Reported upstream: getumbrel/umbrel-apps#6307 and romanz/electrs#1361 (#121).
- **A Wallet page on the guardian's web page** (view and receive only): the balance with unconfirmed apart, payments
  in and out with fee and confirmations, the daily limit used and left, Savings, and the address to receive at, always
  the same one the phone shows. It also works while the guardian is locked, and never shows a hosted guest (#120).
- **Pull to refresh no longer waits for fee estimates.** The guardian keeps them for a minute or until the next block
  and asks for all of them at once; Review waits for fresh ones before it offers to send (#119).
- When every fee speed costs the same, Review picks Fast and says so. The hardware wallet sketch shows the amount and
  the fee with the same decimals, and the fee gets its own line (#121).

## [0.1.12-alpha] - 2026-11-04

Live payments, a faster app, a way to unstick a payment, and family hosting. Update the guardian and the app; each
works with the other side's older version (an older app ignores the new alerts; an older guardian means no live
updates, and the app syncs as before).

- **Payments show up on the phone the moment they happen, from any device.** The guardian keeps your wallet's state
  live: it subscribes to your wallet's addresses on its Electrum server (or reads Bitcoin Core's wallet every 5
  seconds) and tells the phone as soon as a payment in or out reaches the mempool, then again when it confirms,
  whether it was made on this phone, with your hardware wallet elsewhere, or sent to you by someone else. The app
  lists it at once (pending, then confirmed), adjusts the balance, and shows "Incoming 2,000 sats · unconfirmed" for
  a payment coming in. Syncs are much faster too: on an Umbrel's Electrs a sync took about 10 seconds and now takes
  milliseconds (#114).
- **Optional: payment notices on your own email, ntfy or webhook** (guardian web page, Settings > Notifications >
  Payments), also while the app is closed. Off by default, amounts only (never an address or a link), never sent to
  your alert contacts. With a public Electrum server, the server now also learns that your addresses belong
  together and when your guardian is online; your own node remains the better choice (#114).
- **Pull to refresh is quick again.** A pull waits only for the balance and Activity, then the spinner stops;
  silent payments, Savings and the rest finish behind a quiet "Updating…". A pull during a sync that began moments
  ago joins it. With a slow guardian the app no longer syncs back to back: the next periodic sync comes a minute
  after the last one ends. A request the app repeats while the guardian is still working on it never starts a
  second scan (#116).
- **Speed up a payment waiting to confirm** (RBF): "Speed up ›" in Activity and on the payment's details shows the
  old and new fee before signing (never below 1 sat/vB on mainnet). The guardian co-signs within the daily limit,
  where only the extra fee counts; otherwise your hardware wallet signs. Activity keeps one row. Not yet for wallets
  hosted on someone else's guardian (#117).
- **Host a guardian for family** ("Host for someone" in the guardian's web page menu). Invite someone you know with a QR
  code: your guardian then also guards their 2-of-3 wallet, with their own daily limit, contacts and Delay & Notify
  recovery. BIP 89 keeps their addresses and balances from you; their phone reads the chain from its own server.
  They can turn their limit off and pause their wallet (with their hardware wallet), and leave with "Leave <host>".
  The app states plainly what a host could do with a thief before a guest accepts. Your own wallet is unchanged
  (#92, #99).
- Docs: the entropy review's last two suspicions ruled out (#115); the site's Watch section (#113).

## [0.1.11-alpha] - 2026-11-04

A fix release for what was seen on an iPhone with 0.1.10, and the guardian on plain Docker. Update the app and the guardian; each fix works with the
other side's older version.

- **No more "Guardian offline" after the phone slept.** With the screen off for a while, the app came back saying
  "Guardian offline" until a pull to refresh. Nothing was wrong with the guardian: the app had been waiting for an
  answer when the phone went to sleep, and on waking that wait ran out at once, before the app could reconnect. Now:
  - a wait that ran out while the phone slept is not taken as "no answer": the app asks again and waits a little longer;
  - every time the app comes back from the background (iOS cuts all of an app's connections when it suspends it, even
    for a few seconds), it opens its relay connections anew, waits until one relay is back (3 s at most) before it
    syncs, and asks again for any answer it was still waiting for; a connection that silently stopped working (the
    phone's network changed) is also replaced as soon as a message on it goes unacknowledged;
  - a relay that is down is no longer connected to again for every message the app sends (every 10 s while it waits
    for an answer): it is tried again on the same growing schedule as the subscription to it, while the other relays
    get every message;
  - if the guardian was offline before, the app shows "Reconnecting to your guardian…" on return (calm, no red), and
    says "offline" again only if the guardian does not answer a request made after the return;
  - any answer from the guardian clears "offline" (before, only a full sync did);
  - the same on Android, where the phone also closes a background app's connections.
- **A payment shows in Activity at once.** The guardian co-signed in a second, but before it sent any payment (also one
  signed with the hardware wallet) it read the whole wallet from its node again to check that the payment spends the
  wallet's coins (slow on an Umbrel's Electrs), and the app then waited for a whole sync before showing it: about a
  minute. Now the guardian skips that read for a payment it co-signed in the last 30 minutes (it checked the coins when it
  signed), and for one that spends a coin its last sync listed (it checks that coin against its transaction instead);
  anything else is checked as before. The app lists the payment as pending, with amount, fee and transaction id, as soon
  as it is sent, and a payment made right after spends what is left; the next sync shows it once, not twice. With a
  hardware wallet the screen says "Signed. Sending…" as soon as the device has signed, instead of "Waiting for your
  Ledger" until the end. If the guardian does not confirm that a payment went out, the app says it may have, keeps it
  listed as pending until a sync shows whether it did, and asks you not to pay again before then.
- **Fees on mainnet are never below 1 sat/vB.** A mainnet payment went out at 0.11 sat/vB while mempool.space suggested
  1 to 2: newer Bitcoin Core nodes estimate down to 0.1 sat/vB, but many nodes still relay nothing under 1, so such a
  payment may never confirm, and a Spending payment cannot be sped up yet. Every speed the app offers, and every fee
  the wallet picks by itself (sweeps, moves, Savings), is now at least 1 sat/vB on mainnet. Test networks keep the
  node's estimate.
- **The guardian on plain Docker.** Besides Umbrel and Start9, the guardian can run with Docker Compose on a Mac, a
  Windows PC, Linux or a NAS, with your own Electrum server: [packaging/compose](packaging/compose/README.md).
- **Choose the guardian's chain server, like Sparrow** (guardian web UI, Settings > Server): your own Electrum server
  (the default, and what Umbrel and Start9 keep), Bitcoin Core alone (a watch-only wallet in your node, no Electrum
  server needed), or a public Electrum server, always encrypted, behind a clear warning: it sees the wallet's addresses
  and your IP and could hide coins, but can't spend or change rules. Every change is announced to your phone and alert
  channels, and switching to a public server is refused during a recovery. The phone shows which kind it is under
  Settings > Guardian (#105).
- Test plan: what to do when Play Protect says "Unsafe app blocked" when installing or updating the APK.

## [0.1.10-alpha] - 2026-11-03

A fix release for the phone app freezing when it opens. Update the app and the guardian; either alone already helps,
and they work with each other's older versions.

- **The app no longer freezes for a long time when it opens or comes back to the front.** Found on a Pixel 10a and an
  iPhone with 0.1.9: "super slow, and I can't tap anything for a while", every time. The relays held about 600
  encrypted messages addressed to the phone (every answer of the guardian from the last two days: they were dated up to
  two days back, so the relays kept them that long, and every subscription asked for all of them), and the app checked
  the signature of each one (once per relay) and decrypted it again on every start and, since 0.1.9, every time it came
  back to the front, all on the thread that also handles taps. Now:
  - the app remembers which messages it already read, across restarts, and skips them before any signature check or
    decryption; the guardian does the same (in `seen-wraps.json` in its data directory). Measured with 500 such messages
    on two relays (on a laptop; a phone is many times slower): before, 2,000 signature checks and 1,000 decryptions on
    every start and 1,000 more checks after each return to the front, with the app blocked for over 4 s at a time; now,
    on the first start after the update each message is checked and decrypted once, without blocking for more than a few
    tens of milliseconds, and nothing at all on the next starts or after a return to the front;
  - each new message's signature is checked once instead of once per relay plus once more;
  - the app reads new messages a few at a time, so it stays responsive, and an answer it is waiting for goes first;
  - requests and answers are now dated at most 10 minutes back and expire from the relays about an hour after they
    are sent (alerts keep the two days, so a phone that was off still gets them). The old messages expire from the
    relays within two days of the update. Why so little back-dating is enough for calls: PROTOCOL.md section 2.
- **A "Locked" left over from a guardian restart clears by itself.** When a relay connection comes back (after a relay
  or network restart, or when the app returns to the front), the app reads the guardian's status again instead of
  waiting for the next sync: unlocking the guardian in its web UI after an update sends no alert.
- Compatibility: a 0.1.10 guardian still reads requests from older phones (dated up to two days back), and a 0.1.10
  phone still reads answers from older guardians. The guardian lists `short_wraps` in its features.

## [0.1.9-alpha] - 2026-11-03

- **The phone keeps hearing the guardian after a connection drops.** Found on a Pixel 10a (Android 16): Android closes the
  sockets of an app in the background, and the relay library (nostr-tools 2.25) then ended the app's subscription
  instead of reconnecting. Nothing subscribed again: requests still went out, but the answers were never heard, so the
  app showed "Guardian offline" and no balance until it was restarted. The guardian had the same flaw after a relay
  restart, and where the library did reconnect it skipped gift wraps (they are back-dated up to two days). Trikey now
  keeps every subscription open itself, on the phone and on the guardian: a relay that drops is subscribed on again
  after a short backoff (1 s, growing to 30 s), far enough back for back-dated gift wraps, and the app does it at once
  when it comes back to the front. Messages a relay delivers again are not handled twice (#109).
- **A slow guardian is "slow to answer", not "offline".** A sync now waits up to 90 s for the guardian to read the
  wallet from its node (was 30 s). A guardian that answers but takes longer (a slow Electrum server) shows "Slow to
  answer" with the last balance, and phone-only payments stay available; only a guardian that does not answer at all is
  offline (#109).
- **Savings: speed up a payment waiting to confirm** (RBF). The same coins pay the same people the same amount; the
  higher fee, never below what Bitcoin Core requires, comes out of the change back to Savings, and two of Savings' keys
  sign it again. The guardian sends one alert per outflow, not one per replacement, and announces a replacement that
  pays someone else. A payment with no change ("Move everything") cannot be sped up, and the app says why (#98).
- **Android: a second APK without Google code**, for GrapheneOS and other phones without Google Play services: none of
  Google's libraries (it reads QR codes with zxing-cpp instead of ML Kit, and has no Google Drive option). Same app and
  release key, so either APK installs over the other and the wallet stays; CI checks the FOSS one has no Google classes.
  Which to pick, and how in Obtainium: docs/alpha-test-plan.md, docs/android-signing.md (#102).
- **Trikey's own relay, `wss://relay.trikey.app`, is offered at setup** next to damus, nos.lol and Primal, never alone.
  It stores only gift wraps and Nostr Connect events and sees what any relay sees. Existing guardians keep their relays
  and can add it in the web UI (Settings, Change relays) (#106).
- **Zapstore listing**: `zapstore.yaml` and docs/zapstore.md, so Zapstore can publish each release from GitHub; NIP-05
  `trikey@trikey.app` for the publisher npub that signs it (#100, #101, #107, #108).
- Docs: test plan steps 16 (contact lock) and 17 (Savings) (#97); the APK release notes say "open source" with "not
  audited" (#96); DESIGN.md records Taproot (MuSig2) and FROST as decided for later (#103). Fixed: the relay notes in the
  guardian's config and DESIGN.md (relay.trikey.app takes gift wraps and Nostr Connect events only), the NIP-05 file no
  longer points clients to relay.trikey.app for the publisher's profile, and the test plan no longer says relays cannot
  be changed after setup (#109).

## [0.1.8-alpha] - 2026-11-01

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

## [0.1.7-alpha] - 2026-11-01

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

## [0.1.6-alpha] - 2026-10-31

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

## [0.1.5-alpha] - 2026-10-31

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

## [0.1.4-alpha] - 2026-10-30

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

## [0.1.3-alpha] - 2026-10-30

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

## [0.1.2-alpha] - 2026-10-30

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

## [0.1.1-alpha] - 2026-10-30

- Mainnet in guardian mode, behind a pre-alpha warning the tester must accept; Recovery Key mode stays on test
  networks (#8).
- Guardian: silent payment scanning on several CPU cores (`SP_SCAN_THREADS`), falling back to one thread if
  the workers cannot start.
- App: haptics, Send max, Wallet details (the descriptor, to recover in another wallet), Report a problem,
  Android back no longer leaves no-going-back screens, a button to the setting when Bluetooth is off or its
  permission was refused, the recovery's line for coins that arrive late.

## [0.1.0-alpha] - 2026-10-30

- First pre-release: the phone app (guardian mode and Recovery Key mode), the guardian with its web UI, the
  Umbrel and Start9 packages, and the Android test APK.
- Known issue: the guardian image cannot start (fixed in 0.1.2-alpha).
