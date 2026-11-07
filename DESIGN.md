# Trikey — design

Trikey is a Bitkey-style 2-of-3 bitcoin wallet in which **every key belongs to
the user**. No company runs a server, a guardian or a cosigner for anyone.

```
Key 1  Hardware wallet     any device: Ledger, Trezor, Coldcard, BitBox02, Jade, Keystone, Passport, SeedSigner, Krux
Key 2  Phone key           in the mobile app, behind Face ID
Key 3  Trikey Guardian     an app on the user's own Umbrel or Start9

Vault: wsh(sortedmulti(2, key1, key2, key3))
```

The guardian does what Bitkey's server does: it co-signs phone-only payments
under a daily limit and runs Delay & Notify recovery. The difference is that it
runs on the user's own home server.

Visual walkthrough (private canvas): https://claude.ai/artifact/NV7SCZja8ik9LAvuCPgegx

## Decisions so far

| Topic | Decision | Why |
|---|---|---|
| Script | Plain `wsh(sortedmulti(2,…))`, BIP48 paths (`m/48'/coin'/0'/2'`) | The only script every hardware wallet can co-sign, Trezor included. Miniscript, taproot multisig and MuSig2 all exclude major devices. |
| Key 3 | Trikey Guardian on the user's Umbrel or Start9 (both in the MVP), or on plain Docker (`packaging/compose`: a Mac, a PC, Linux, a NAS) against the user's own node | Bitkey's features with no third party |
| No home server | Recovery Key mode (below) | Same script; Bitcoin's timelock rules enforce the limit |
| Key 2 backup | Encrypted cloud backup, unlocked by passkey | The user picks the cloud. Losing the backup is survivable: see the recovery flows. |
| Optional extra | Timelocked heir/backstop path for miniscript-capable devices | Opt-in only, so the default stays universal |
| Savings (optional) | A second wallet, `wsh(sortedmulti(2, phone, hardware, recoveryKey))` at BIP 48 account 1', the Recovery Key a second hardware wallet; the guardian only watches it ("Savings" below) | The daily limit lives in the guardian's code; only a script keeps phone + guardian away from money. Opt-in, never part of onboarding |
| First client | React Native mobile app | Ledger Bluetooth and Trezor Connect have JS SDKs |
| UI kit | shadcn/ui: react-native-reusables + NativeWind in the app, shadcn/ui + Tailwind in the guardian web UI. Zinc neutrals, Geist type, light and dark themes. | One set of tokens and components across the phone and the home server |
| Transport | Nostr: NIP-44 encryption inside NIP-59 gift wraps | Outbound-only connections, no accounts, relays see ciphertext |
| Alerts beyond nostr | Email through the owner's own account (SMTP), ntfy, a webhook and Telegram (the owner's bot), all inside the guardian, notify-only; owner-side settings in the web UI, outside the policy, every change announced ("Alerts beyond nostr" below) | The phone may be the stolen one, and not every contact uses nostr; controls stay on signed nostr messages |
| Chain sources | The owner chooses, as in Sparrow Wallet: their own Electrum server (the default: the box's own Electrs on Umbrel and Start9), their own Bitcoin Core alone (a watch-only descriptor wallet in it), or a public Electrum server (TLS, a short list or another one) behind a warning; every change announced on every channel; no switch to a public server during a recovery | Own node first; a public server only for people with none, since it sees the wallets' addresses and could hide coins (it cannot spend or change rules) |
| Entropy | Every key from one checked function on the OS CSPRNG; the guardian's seed mixes in the browser's (and on Umbrel the platform's) randomness, key 3 the phone's; no dice | See "Entropy": guards catch gross failures, the setup mix, the key-3 mix and 2-of-3 cover subtle ones |
| Guardian for family | Invite-only hosting: a guardian holds key 3 for a person its owner knows, one engine per hosted wallet, BIP 89 delegation | See "Guardian for family"; phase 1 built (docs/design/family-hosting.md) |
| Unlocking key 3 | The passphrase always (Argon2id, never removable); opt-in, per own wallet, that wallet's Ledger or Trezor through the phone: a deterministic BIP 137 signature opens an extra unlock slot. The phone keeps nothing that unlocks by itself | See "Unlocking the guardian with the hardware wallet": no new device API (Trezor's CipherKeyValue was not needed), and a stolen phone still cannot undo a lock |
| Unlock secrets in transit | The phone seals the passphrase and the slot signature (in `guardian.unlock` and `unlock.hardware.add`) to a key the guardian holds in memory only, a new one at every lock, unlock and use (`sealed_unlock`) | See "Sealed unlock": the guardian's disk plus an archive of old gift wraps no longer opens a past unlock or slot |

Options considered and dropped, with research in the earlier pages under `docs/`:
- company cosigner (Bitkey's model);
- threshold guardians run by providers;
- miniscript multi-guardian;
- timelock-only;
- pre-signed vaults;
- covenants, which are not active on Bitcoin.

## Components

```
Phone app (key 2) ──┐                           ┌── Trikey Guardian (key 3) ── Bitcoin Node + Electrs
                    ├── nostr relays (E2EE) ────┤        on the same Umbrel / Start9
Hardware (key 1) ───┘   outbound only           └── alerts: nostr DMs to the user's devices and contacts,
                                                    plus email (owner's account), ntfy, webhook, Telegram
```

### Mobile app (React Native)
- **Key 2:** BIP39 seed, encrypted at rest with a key from the Secure Enclave or Android Keystore. Those chips can't hold secp256k1 keys directly, so they wrap the seed instead. Unlocking needs biometrics.
- **Hardware wallets:**
  - Ledger over Bluetooth (`@ledgerhq/device-signer-kit-bitcoin`);
  - a Jade or Jade Plus over Bluetooth (its own RPC over `react-native-ble-plx`, the library the Ledger transport already
    uses): unlocked with its PIN through its PIN server, then like a Ledger ("Jade over Bluetooth" below);
  - Trezor via `@trezor/connect`;
  - a BitBox02 or BitBox02 Nova (its own protocol, written in the app): over USB-C on Android (the app's own small
    USB module, Android's USB API only) or, for the Nova, over Bluetooth on both phones (`react-native-ble-plx`)
    ("BitBox02 over USB-C and Bluetooth" below);
  - air-gapped devices via PSBT QR (UR/BBQr), and message signing over a text QR for the models that can
    (see "Hardware wallets by feature" below);
  - a Coldcard Mk4 or Q over NFC (`react-native-nfc-manager`): the Coldcard plays an NFC tag, and the phone writes NDEF
    records to it or reads what it shares (docs/design/hardware-auth-path.md, "Coldcard over NFC").
- **Wallet registration** on devices that need it (Ledger, BitBox02, Jade, Coldcard), plus showing the first address on the device.
- **Cloud backup of key 2 + the descriptor:**
  - XChaCha20-Poly1305 under a random data key;
  - the data key is wrapped by a passkey PRF slot (WebAuthn L3, iOS 18+, Google Password Manager);
  - more unlock slots can be added later, such as a Recovery Code.

### Hardware wallets by feature

Every feature below except payments needs the hardware wallet to BIP 137-sign a one-line text (at most 240 printable
ASCII characters, `MAX_APPROVAL_MESSAGE_LENGTH`) with the authorization key `m/48'/<coin>'/<account>'/2'/0/0`
(docs/design/hardware-auth-path.md). QR devices do it over a text QR: the phone shows
`signmessage m/48h/<coin>h/<account>h/2h/0/0 ascii:<text>`, the device shows the text, signs, and shows the base64
signature as a QR (Coldcard's armored block is read too); the phone checks it against the key it derived from the
device's xpub before using it. Passport (2nd generation) and Krux refuse that key over a text QR but sign it from a file
on their microSD card: the phone writes the request file, the owner copies it to the card (a card reader on the phone, or
a computer), signs on the device, and brings back the signed file it wrote, which the phone checks the same way ("microSD
message signing" below). The owner picks the QR device's model when adding it (a key export that names its device
fills in "Other"); Settings, "Hardware wallet model" changes it, and wallets made before models existed read as "Other".
The table is `packages/wallet/src/qr-devices.ts` (`messageMethod`: `qr-text`, `microsd` or `none`). **Message signing
over QR and from microSD is read from each firmware's source, not tested on devices yet** (docs/alpha-test-plan.md, "QR
message signing" and "microSD message signing").

A Coldcard Mk4 (no camera) or Q can do all of it over NFC instead (kind `coldcard-nfc`,
`packages/wallet/src/nfc-devices.ts`): the phone writes the same `signmessage` line, a PSBT or the wallet's setup file
to the Coldcard's NFC Tools, and reads back the armored signature, the signed PSBT or the key export. Each step is a
tap of the phone on the Coldcard. Read from Coldcard's firmware (`shared/nfc.py`), **not tested on a device yet**
(docs/alpha-test-plan.md, "Coldcard over NFC"). iPhone builds have NFC only when built with `TRIKEY_IOS_NFC=1`, which
needs a paid Apple developer account (the NFC Tag Reading capability); Android builds always have it.

A BitBox02 does all of it too (kind `bitbox02`, `packages/wallet/src/bitbox02.ts`; "BitBox02 over USB-C and Bluetooth"
below): over USB-C on Android (the BitBox02 and the Nova) or Bluetooth (the Nova, Android and iPhone), after the owner
unlocks it with its password and, the first time, confirms on it the pairing code the phone shows. Firmware 9.27.1 or
later. Read from the BitBox02's firmware and official clients, **not tested on a device yet** (docs/alpha-test-plan.md,
step 18i).

A Jade or Jade Plus over Bluetooth does all of it too (kind `jade-ble`, `packages/wallet/src/ble-devices.ts`;
"Jade over Bluetooth" below): `register_multisig`, `sign_psbt` and `sign_message` over Jade's own RPC, after the owner
unlocks it with the PIN on the Jade. Read from Jade's firmware and client, **not tested on a device yet**
(docs/alpha-test-plan.md, step 18h).

| Device | Payments | Guardian pairing, approvals, recovery access | Notes on the guardian | Hardware unlock | Limits and notes |
|---|---|---|---|---|---|
| Ledger (Bluetooth) | Yes | Yes | Yes | Yes | Shows texts up to 640 bytes in full |
| Trezor (Suite Lite) | Yes | Yes | Yes | Yes | Older firmware warns about the path first |
| Coldcard Q (QR) | Yes | Yes | Yes | Yes | 240 characters at most (Trikey's maximum exactly); no space at either end, never three in a row; shows the text, the path and a legacy `1…` address |
| Jade, Jade Plus (QR mode) | Yes | Yes | Yes | Yes | Signs the whole text but shows only about the first 188 characters, then "..." (policy approvals and recovery access are longer) |
| Jade, Jade Plus (Bluetooth) | Yes | Yes | Yes | Yes | The same 188 characters on screen; the PIN on the Jade at every connection, checked through its PIN server (the phone relays it: below); firmware 0.1.47 or later |
| Keystone 3 (QR) | Yes | Yes | Yes | Yes | Shows no address for this key |
| Passport Prime (QR) | Yes | Yes | Yes | Yes | Signs only from the account the path names: open that account first |
| Specter DIY (QR) | Yes | Yes | Yes | Yes | Shows the text, the path and a legacy address |
| Passport gen 2 (payments by QR) | Yes | Yes, from a microSD file | Yes, from a microSD file (two files when turned on; the phone then asks to delete them) | No: a card round trip after every guardian restart; the passphrase works | Shows the whole text and a legacy address; no space at either end, at most 3 in a row; the file is at most 4096 bytes |
| Krux (payments by QR) | Yes | Yes, from a microSD file (the signature comes back as a file or a QR) | Yes, from a microSD file (two files when turned on; the phone then asks to delete them) | No: as Passport gen 2 | Shows about 10 lines of the text (on the M5StickV about the first 120 characters, on larger screens about 210), then "…", and a legacy address |
| SeedSigner (QR) | Yes | No: decided, payments only (below) | No | No | Recovery Key mode |
| Other QR device | Yes | No (unknown): pick the model in Settings | No | No | Recovery Key mode |
| Coldcard Mk4, Coldcard Q (NFC) | Yes | Yes | Yes | Yes | The Coldcard Q's limits; one tap to send each request and one to read the answer; NFC Sharing on in the Coldcard's settings; iPhone builds need `TRIKEY_IOS_NFC=1` |
| Coldcard Mk4 (QR) | No: no camera (use NFC) | No | No | No | |
| BitBox02, BitBox02 Nova (USB-C on Android; the Nova by Bluetooth on both) | Yes | Yes | Yes | Yes | Firmware 9.27.1 or later; shows "External service key", the key's own `bc1q…` address, then the text (in full up to 640 characters); the pairing code once per phone; notes and an unlock slot made with a BitBox02 open only with a BitBox02 (its signature is not other brands') |

A model that cannot sign a text is refused with its reason (`QrSigner.signMessage`), and the connect screen says so
before a guardian wallet is started, offering Recovery Key mode. Not built: USB for Jade, BIP 322 proofs.

**SeedSigner co-signs payments only (decided 2026-11-06).** Its firmware refuses a message at any `m/48'` path
("Not implemented" in `parse_derivation_path`, and custom paths are "not supported"), so it cannot sign Trikey's texts
with the key the guardian checks. The only way around it is a BIP 322 proof (a PSBT that spends a virtual output),
which SeedSigner would sign *blind*: it shows a 0-sat spend to an empty OP_RETURN with fee 0, never the text. A blind
signature turns each confirmation into a blank cheque for whatever runs on the phone at that moment (malware could swap
a loosening approval in for "pairing"), which is what rule 4 exists to prevent. A key at another path (BIP 84) loses
the guardian's binding to the hardware xpub (docs/design/hardware-auth-path.md §5). So SeedSigner is offered for
Recovery Key mode and as a payment co-signer; a guardian wallet needs another device.

**microSD message signing (Passport gen 2, Krux; built 2026-11-06, untested on devices).** Both firmwares sign at
Trikey's key from a file, with the address type the file names (`apps/mobile/src/hardware/qr/sd-message.ts`, sources in
docs/design/hardware-auth-path.md §7):

- **The request.** Passport: 2 lines, the text then the path (`m/48h/<coin>h/<account>h/2h/0/0`), legacy address by
  default. Krux: 3 lines, the text, the path, `p2pkh` (its signature header is P2PKH's whatever the type, so the
  armored file checks in any BIP 137 tool). `\n` line endings; named for what it is (`trikey-pair.txt`,
  `trikey-approve.txt`, `trikey-access.txt`, `trikey-notes-1of2.txt`), never with `-signed`, which both hide.
- **Handing it over.** "Save the file" asks for a folder (the card through a USB-C or Lightning reader, or Files), or
  "Share the file" opens the share sheet (to a computer). The system folder and file pickers and the share sheet need no
  Google code, so the Android build without Google has them. The copy made for the share sheet is deleted before each
  share and at start.
- **Bringing it back.** "Open the signed file": Passport writes `<name>-signed-001.txt`, Krux `<name>-signed.txt` (or,
  "Sign to QR code", a QR of the signature: "Scan the signature instead"). The phone reads the armored block, checks
  that its text is Trikey's, that its address is the key's, and that the signature verifies against the key derived
  from the device's xpub; then `signWithAuthKey` checks it again. Trikey's own request file, a Krux `.sig` (it signed
  the file's hash with another key because it did not read the file as a message), anything not text, another key or
  another text stay on the screen as a hint, so the owner can pick again or sign again. Nothing that does not verify is
  ever used.
- **Notes: two round trips.** The same text twice, as for every device: "1 of 2" and "2 of 2", two files with the round
  in their names, and the other round's signed file is refused by its name. Both firmwares sign with RFC 6979 and no
  extra entropy (Passport: trezor-crypto `ecdsa_sign_digest` with `USE_RFC6979`, or libsecp256k1's default nonce;
  Krux: embit's libsecp256k1 `ecdsa_sign_recoverable` with no nonce data), so skipping the second signature would
  probably be safe, but the check is what proves it on the owner's own device and firmware, and notes are turned on
  once: it stays. What it cannot catch: an owner who signs once and picks a renamed copy of the first file for round 2.
- **Hardware unlock: not offered.** Every guardian restart would need a card round trip. The switch is hidden and one
  sentence says why and that the passphrase unlocks the guardian.
- **Cleaning up the card (decided 2026-11-07).** The owner's decision: keep offering notes on these devices, with a clear
  step to delete the files. Once the signature checks, the phone shows "Delete these files from the card", the request
  and the signed file by their exact names (the signed one as the file chooser gave it: Passport
  `<name>-signed-001.txt`, Krux `<name>-signed.txt`; only the request after Krux's Sign to QR code), "now, and from any
  computer or email you copied them through", with one button, "I deleted them", and no cancel: the signature is only
  handed on after it (`sdCleanupNotice` in sd-message.ts, a `notice` request on the QR bridge). For the notes it adds
  "They can open your notes" and why (the signature is their key, and the guardian holds the ciphertext); notes take two
  rounds, so two such steps. For pairing, rules, approvals and recovery access the same step says Trikey does not need
  the files again: they hold no secret, but they name the wallet and the guardian, and one rule for every card round
  trip is easier to follow than one for the notes only. The phone cannot delete them itself: it gets no lasting access
  to the card, and the signed file came through the system file chooser. It trusts the owner's word; what it cannot
  catch is a copy it never saw (a computer's trash, a mail sent to yourself), which the step names.

### Jade over Bluetooth (built 2026-11-06, untested on devices)

The phone speaks Jade's own RPC (CBOR maps over one Bluetooth LE service; firmware `main/ble/ble.c`, `main/wire.c`,
client `jadepy/jade.py`) through `react-native-ble-plx`, which the Ledger transport already links: no new native code,
and none from Google, so the Android build without Google has it. The first connection pairs the phone and the Jade (the
same six digits on both, confirmed on both). The protocol, step by step with firmware lines, is in
docs/design/hardware-auth-path.md §9.

- **Unlocking asks the Jade's PIN server, through the phone.** A Jade rebuilds the key to its seed from the PIN and a
  secret held by a "blind" PIN server. Over Bluetooth it cannot reach the server, so after the owner types the PIN on
  the Jade, the phone relays an encrypted exchange between the Jade and the server the Jade names: Blockstream's
  (`j8d.io`) unless the owner set their own on the Jade. The phone uses only the address the Jade gives (no server is
  written in Trikey), only over https (never plain http; it has no Tor, so never the onion address), and passes the
  server's answer to nothing but the Jade's `pin` call. **What the server learns:** that this Jade (by a key of its own,
  which tells its unlocks apart) is unlocking and when, how many wrong PINs in a row (three wipe it), and the phone's IP
  address. **Not** the PIN, the seed, any key, address, wallet or amount, and nothing about Trikey beyond the timing. The
  phone says so in one sentence before the first unlock over Bluetooth, and stops if the owner declines. In QR mode
  Trikey contacts no PIN server (a SeedQR asks none; "QR PIN Unlock" has the owner relay it with another app). The Jade
  clears its keys when the Bluetooth link that unlocked it drops, so every connection (setup, a payment, a text) asks for
  the PIN again.
- **Payments without anti-exfil (decided).** Jade's anti-exfil protocol would stop a malicious Jade from leaking key 1
  through its signature nonces, but only its older `sign_tx` flow has it; `sign_psbt`, which takes Trikey's PSBTs and
  recognises the registered wallet's change, signs with RFC 6979 and no host entropy. Moving payments to `sign_tx`
  would be a second signing path (full previous transactions for each input, change described apart) plus a
  sign-to-contract verifier with no maintained JavaScript implementation. So payments use `sign_psbt`; each signature is
  verified against the transaction before it is used, and every input of the Jade must carry one. The risk left is
  malicious firmware on the Jade itself (open source, reproducible, checked by its secure boot): key 1 alone moves
  nothing, but a leaked key 1 plus a stolen phone would. A candidate for later.
- **Trikey's texts without anti-exfil, on purpose.** `sign_message` without a host commitment signs with RFC 6979 and no
  extra entropy (`wallet_sign_message_hash`, libwally's default nonce), so a text gives the same signature every time,
  which notes and hardware unlock need; the app still signs them twice and compares. The signature is checked against
  the key derived from the Jade's account xpub before it is used.
- **The wallet is registered** (`register_multisig`, the 2-of-3 `sortedmulti` with each key's origin): Jade signs
  without it, but only with it does it recognise the change as change instead of showing it as a payment.

### BitBox02 over USB-C and Bluetooth (built 2026-11-06, untested on devices)

The phone speaks the BitBox02's own protocol (firmware github.com/BitBoxSwiss/bitbox02-firmware at b27f5f68 and its
official clients; step by step with file and line references in docs/design/hardware-auth-path.md §10): 64-byte U2F HID
reports, a request layer that waits while the owner decides on the device, a Noise_XX encrypted channel, and protocol
buffers. Trikey implements the part it needs in TypeScript (`apps/mobile/src/hardware/bitbox02`) because BitBox's
clients do not fit a React Native app: the Rust one's WebAssembly build is gone (and Hermes runs no WebAssembly), the
TypeScript one talks only to WebHID or the BitBoxBridge and brings other majors of the crypto libraries, and there are
no Android or iOS bindings. The tests replay the real implementations' vectors (Noise transcript, pairing code,
anti-klepto, the firmware's own message signatures) and a fake BitBox02 written from the firmware.

- **Two ways in.** USB-C on Android, for the BitBox02 and the Nova, through the app's own Expo module
  (`modules/trikey-usb-hid`: Android's `android.hardware.usb`, no Google code, so the build without Google has it;
  Android asks the owner to allow the device the first time). Bluetooth for the Nova, on Android and iPhone, through
  `react-native-ble-plx` like the Jade (the phone and the Nova bond the first time: the same six digits on both). An
  iPhone has no USB HID, so the original BitBox02 cannot reach one.
- **Pairing.** The BitBox02 asks for its password on its own screen. The first time a phone and a BitBox02 meet, the
  phone shows a pairing code (four groups of five characters from the encrypted channel's handshake) and the BitBox02
  shows the same; the owner confirms it on the BitBox02. A different code means something between them changes the
  connection: reject it. The phone keeps its channel key and the BitBox02's in its app storage, so later connections ask
  only for the password.
- **Payments with anti-klepto (decided).** For every input the phone sends a commitment to a random number, the BitBox02
  commits to its signature nonce, then the phone sends the number and checks the signature used both. A BitBox02 with
  malicious firmware therefore cannot leak key 1 through its nonces, which no other adapter in Trikey can check. Then
  each signature is verified against the transaction, and every input must be signed. The change is the wallet's own
  (the wallet is registered), so the BitBox02 does not show it as a payment.
- **Trikey's texts: anti-klepto, except notes and hardware unlock.** Pairing, approvals, recovery access and the other
  texts use anti-klepto too. Notes and hardware unlock need the same signature every time, so for those two the phone
  sends no commitment: the firmware then signs with a fixed contribution of zeros, deterministic but **not plain RFC
  6979**. The app still signs them twice and compares. Consequence: a notes copy or an unlock slot made with a BitBox02
  opens only with a BitBox02 that has the same seed, and one made with a Ledger, Trezor, Coldcard or Jade does not open
  with a BitBox02. After restoring the seed on another brand, turn notes on again and set up the hardware unlock again
  (the phone says so when it asks the BitBox02 for those two).
- **What the owner sees for a text:** "Sign message", "External service key", an address starting with `bc1q` (the key's
  own single-key address, not the wallet's: the device always shows one), then the text, which it shows in full up to
  640 characters (Trikey's are at most 240). Firmware 9.27.1 (2026-08-31) or later: older firmware refuses a key under
  `m/48'`, and the phone refuses the device with "update it with the BitBoxApp".

### Trikey Guardian (Docker container)
- **Packaging:** one image, shipped as an Umbrel app (`umbrel-app.yml`, depending on `bitcoin` + `electrs`), a Start9 service package, and a Docker Compose file for plain Docker (`packaging/compose`), with an optional node profile.
- **Chain data and broadcasting** go through the chain source the owner chose (Settings > Server, "Chain sources" in the decision table): by default the user's own node and Electrum server (on Umbrel and Start9 the box's own; on plain Docker one on the user's network, plain TCP only to a private address, else TLS, optionally with a pinned certificate), or the user's Bitcoin Core alone, or, for people without a node, a public Electrum server.
- **Live wallet:** the guardian keeps the paired wallet's chain data (and Savings', the replaced wallet's and the helper coins') live: on an Electrum server it subscribes to every script up to the gap (`blockchain.scripthash.subscribe`), with Bitcoin Core it reads the watch-only wallet at every tip poll. `wallet.sync` and the broadcast check are answered from that (a ping first, so it is never staler than asking the server), and the paired phone gets `wallet_tx` the moment a transaction touching the wallet or Savings appears and when it confirms, whichever device made it; opt-in, the owner's own channels get a line too (amounts only), contacts never. A wallet that stops being watched (Savings unregistered, a rotation's old wallet, an own wallet removed, the replaced wallet's watch over) has its subscriptions released at the next pass: `blockchain.scripthash.unsubscribe` (protocol 1.4.2) where the server has it, learnt from its first answer on each connection; on a server without it they are only dropped from the guardian's bookkeeping, so their notifications are ignored, a reconnect does not subscribe them again, and they count against the subscription cap until the connection ends. Every ten minutes a safety pass asks every watched script's status again in one batch (`blockchain.scripthash.subscribe` answers it: one round trip, about 7 s on a slowed Electrs) and reads only the scripts whose status differs from the one held, so a notification lost by the server or the network costs at most ten minutes, never a rescan; it never runs twice at once nor beside a new block's refresh or the pass after it, a reconnect (whose re-subscription compares every status anyway) restarts its timer, and Bitcoin Core alone, polled anyway, has none (`apps/guardian/src/chain/live.ts`, `live-wallet.ts`). Privacy: the subscriptions tell the chosen server nothing a scan does not (the same addresses), except that they belong together and when the guardian is online; for a public server that is one more reason to prefer your own node.
- **Unconfirmed payments, whatever the server sees:** some Electrum servers report no mempool. Electrs 0.11 reads none of Bitcoin Core 32's: Core dropped `bip125-replaceable` from mempool entries (unless run with `-deprecatedrpc=bip125`), Electrs requires it, skips every entry and logs that only at debug level; the symptom is an empty fee histogram while Core holds tens of thousands of transactions. That is every Umbrel with Electrs and Core 32+. It also slows Electrs down: it answers requests on the loop that keeps refetching Core's whole mempool, so every request, a ping included, waits about 7 s (pipelined requests and batches come back together after one such wait). The fixes are `deprecatedrpc=bip125` in Core's configuration, or "Bitcoin Core alone" as the guardian's chain server; the guardian measures a ping with its mempool check and says so plainly when it takes over 3 s. For Umbrel's Electrs app the place to follow is [getumbrel/umbrel-apps#6307](https://github.com/getumbrel/umbrel-apps/issues/6307) (no mempool with Bitcoin Node on Core 32); the web page names the cause and the fixes but carries no link. A coin spent by a payment still waiting then looked unspent to every sync, and a second payment could take it: a double spend that the node refuses, or, paying more, that replaces (cancels) the first payment. Two guards: the phone keeps the coins its own unconfirmed transactions spend out of every quote and the balance (persisted, until a sync lists them confirmed, or shows them gone: listed before and not any more, a coin spent otherwise, two weeks), and shows their change as pending; the guardian keeps every transaction it relayed for the owner as mempool state in `wallet.sync` and the live wallet until the server lists it, a block confirms it, or Bitcoin Core (when configured) says it is gone (`gettxout` of a coin it spends, mempool included). A hosted guest's transactions are never kept. The guardian also tells when the server does not see the mempool (a relayed payment not listed within a minute; an empty fee histogram while Core's mempool is not), and names the cause when Core is 32 or later and the server is Electrs. With Core's RPC configured (always on Umbrel and Start9) it then reads Core's mempool itself every 10 s (`getrawmempool` txid list, `getrawtransaction` of the new ones in batches; never a verbose entry, whose fields Core 32 changed) and keeps those that pay a watched script, spend a coin one lists, or spend an output of one kept, as known mempool state like its own relays: payments to the wallet show unconfirmed and are announced. Nothing is imported into Core. A new block re-reads the scripts of what it keeps at once, each script's history and unspent outputs in one batch (one round trip, not two), so its `wallet_tx` confirmation does not wait for the server's own notification (a slow Electrs sends it long after the block); the scan that waits for that read shares its ping with it. Only without Core's RPC do payments to the wallet wait for a block; `guardian.status.chainSource.mempool` says so to the phone, the web page always.
- **First run needs a one-time setup code**, on every platform, unless the request came through the platform's own login proxy: on plain Docker from the container's log; on Umbrel, where the guardian recognises Umbrel's login proxy, the owner normally never sees it (the app's logs otherwise); on Start9 from the package's Show Setup Code action ("First run without a platform login" in the threat model).
- **Web UI on the box:**
  - pairing QR;
  - status (locked or unlocked);
  - activity log;
  - wallet, view and receive only (also while locked): balance, payments, the daily limit used and left, the receive address by the phone's rule (`GET /api/wallet`);
  - current rules;
  - recoveries in progress;
  - notifications: email, ntfy, webhook and Telegram alerts ("Alerts beyond nostr");
  - the passphrase: changed here and only here ("Changing the passphrase").
- **Keeps key 3 only in memory.** On disk it is encrypted. After any restart the guardian is *locked* until the user unlocks it with:
  - **a passphrase:** stretched with Argon2id, in the web UI or typed on the phone; always there, never removable, changed in the web UI only ("Changing the passphrase");
  - **or, if the owner turned it on, the hardware wallet:** one confirmation on a Ledger or Trezor through the phone, which opens an extra unlock slot ("Unlocking the guardian with the hardware wallet").
  
  A stolen, unplugged box is useless.
- **Holds no backup of key 3.** If the box dies, phone + hardware sweep to a new wallet with a fresh guardian ("Replace guardian").
- **The platforms' backups leave the guardian out (decided 2026-11-07).** StartOS backs up none of it
  (`packaging/start9/startos/backups.ts`), and umbrelOS leaves the contents of its data folder out
  (`backupIgnore: data/*` in `packaging/umbrel/trikey-guardian/umbrel-app.yml`; umbreld reads the path relative to the
  app's folder, `data` being the folder mounted at `/data`, and keeps the empty folder so a restore does not leave Docker
  to make it as root). Up to 0.1.21-alpha an Umbrel backup held all of it. Why, the same on both: the data folder holds
  key 3's keystore (under the passphrase), the nostr identity's key in the clear, the alert channels' key file, the
  hardware unlock slots and the rules' state, so a backup is one more copy of key 3 to steal, and one the passphrase
  change cannot reach ("Changing the passphrase"); and a restored copy is wrong in ways that matter: it rolls back the
  daily-limit accounting, the high-water marks and the replay ids, and can bring back a key 3 the owner reset. So a box
  restored from a backup starts an empty guardian, and the owner sets it up and moves the wallet to it with Replace
  guardian, phone and hardware wallet, exactly as after a lost box. Not covered: umbrelOS's migration to another Umbrel
  (`migration.ts`, an `rsync` of everything) and a plain-Docker move (`packaging/compose`, "Moving to another computer")
  copy the guardian on purpose; the old box must then never start it again.

## Rules the guardian enforces

The rules follow Bitkey's own spend rules and recovery code (`server/src/api/mobile_pay/src/spend_rules`, `server/src/api/recovery`).

1. **Inputs belong to the wallet.** The guardian rebuilds every input script from the descriptor. It requires `nonWitnessUtxo` and checks it against the txid, which blocks the segwit v0 fee attack.
2. **One existing signature per input,** valid under `SIGHASH_ALL`.
   - **Phone signature:** the everyday path. It counts against the daily limit.
   - **Hardware signature:** only accepted as part of a recovery.
3. **Daily limit.** The guardian counts `Σinputs − Σchange` (the fee included) over a rolling 24 hours, keyed by outpoint:
   - a replayed transaction is never counted twice;
   - an RBF replacement counts as the larger of the old and new amounts: a "Speed up" (below) of a payment it co-signed adds only the extra fee, and one of a payment the hardware wallet signed counts in full;
   - **change is only change within reach of a scan:** an output counts as change only if it pays the wallet's own derived address at an index no more than 20 (the gap limit) past that chain's *on-chain high-water mark*, the highest index a scan of the chain source found used. Anything further out counts as leaving the wallet. The marks are persisted and rise only with what the scans find (`wallet.sync`, the live wallet: a payment to a fresh receive address, co-signed change once it is broadcast), **never with a co-signature**: a co-signed transaction may never be broadcast, so before the fix (security review 2026-11, "change-window walk") a phone thief could co-sign thousands of unbroadcast 0-fee self-transfers of one coin and walk the window, and every scan's starting point, to the index limit, where every scan failed (`wallet.sync`, the broadcast check, a recovery's coverage check: Delay & Notify never completed), or then park the vault out of sight of gap-limit scans. Co-signed change is a **pending mark** instead (`apps/guardian/src/policy/marks.ts`): every scan of the wallet (coverage before a recovery completes, `wallet.sync`, the live wallet, the broadcast relay check) reaches the whole window and every pending mark, so no coin key 3 co-signed is ever out of sight, but a pending mark does not widen the window. It goes once a scan sees its index used, once the guardian's own chain source lists every coin of the wallet and none it spends is left (it can no longer confirm), after 30 days, or beyond 64 (the oldest first); losing one hides nothing, since co-signed change lies within the window of a used on-chain address. More safeguards around it:
     - **no co-signature below 0.1 sat/vB** (`fee_rate_too_low`): the default minimum relay fee of Bitcoin Core 29.1 and later; such a transaction never relays, so it is no payment, and every co-signature now costs something against the limit;
     - **successful co-signatures are paced** per wallet on the limit's trusted time: at most 30 in an hour and 200 in a day (`cosign_rate_limited`, `1500` with `retryAfterSeconds`; signing the same transaction again is not a new one). A person paying from a phone, even a shop till, stays far below; anything that walks or floods is slow and leaves a trail;
     - **a public chain server** (Settings > Server) may be lying: one scan of it raises a mark by at most 20 past what the guardian knows (the marks and the pending marks), and Savings' marks the same. The owner's own node and Electrum server are trusted for chain data, as everywhere (threat model);
     - **a mark that rises more than 100 within a day** is logged as a warning and announced once on the owner's own channels (email, ntfy, webhook, Telegram): a lying server, or someone creating addresses;
     - **scans never fail at the index limit:** a scan stops at index 100,000 (included) and returns what it found, whatever the marks or the server say; the change window and the marks stay at most 99,000, well below it;
     - **a guardian from before the fix** kept one set of marks, co-signed and on-chain mixed, possibly walked. At load they become one *legacy* pending mark: every scan still reaches it (change co-signed before the upgrade stays in sight), it does not widen the window, and the on-chain marks start empty, so the first scan sets them from what is really used (until then, as for a new wallet, change past index 19 counts as leaving the wallet; the phone syncs before it pays). The legacy mark goes once the guardian's own chain source shows every coin a remembered co-signature spent as spent (no transaction co-signed before can confirm then). A guardian whose marks a walk took near the limit pays for it with slow scans (each address is derived and asked for) until then, but every scan completes, recovery included;
   - **the window's clock is checked against the chain:** the guardian refuses to co-sign while the system clock is more than 3 hours ahead of the chain's median time past (`clock_ahead_of_chain`), and the time it counts the window with never goes backwards (persisted), so stepping the clock forward or back cannot open a fresh window. The records of what it co-signed (kept 30 days) are pruned on that same trusted time, never on the raw clock: before the fix (security review 2026-11) any request, even one refused as `clock_ahead_of_chain`, pruned them with the clock, so a clock jumped a month ahead and back deleted the day's spends and gave a fresh limit.
   - **Payments into the optional Savings wallet count like any payment** (the owner's decision, 2026-11-01): the guardian is not told which wallet is Savings for this rule and counts an output to it as leaving the wallet. A phone thief registering their own wallet as "Savings" therefore gains nothing.
   - **The limit can be turned off** (strictly opt-in; docs/design/savings-and-limit-off.md, section 4). "Off" is the largest limit there is, all bitcoin there will ever be, so the policy and its hash are unchanged; **any limit of 1,000 BTC or more is "off" for every purpose too** (security review 2026-11: before, one satoshi under the maximum was an ordinary limit that skipped every safeguard below, and the device showed a 16-digit number; no wallet a phone holds needs a brake that large, so a limit there brakes nothing and must look like what it is). A wallet whose stored limit lies between the two when its guardian is upgraded is "off" from then on, announced once like a turning off (nothing before is known, so a recovery restores 0); every other rule stays, and the guardian still counts what it co-signs. It is a loosening: only with a fresh hardware approval whose text says it in words (`Trikey policy v2 ... limit=off ...`, rule 4), never at pairing and never while a recovery is pending or ready. Turning it back on is tightening: the phone alone, at once. The guardian alerts the paired phone (`limit_off`) and every alert contact (a NIP-17 DM) when it is turned off, logs it as a warning, and tells the phone when it is on again (`limit_on`). It remembers the limit before (`limitBeforeOff`): after a recovery the adopted wallet starts with the limit **on** at that value (rotation, below). The phone offers it only to a guardian that reports the `limit_off` feature. With the limit off the guardian is a second signature, not a brake: a thief who gets into the phone sends everything at once.
4. **Loosening the rules needs the hardware wallet.** That covers raising the limit, shortening the delay, changing the sweep fee cap, adding or removing alert contacts, and stopping the alert contacts from locking the guardian (rule 8). The phone alone can only tighten: lower the limit, lengthen the delay or let the alert contacts lock the guardian, **also while a recovery runs** (tightening never helps a thief; a running recovery keeps the delay and fee cap it started with). On mainnet the rules must name at least one alert contact: a pairing without one, or any change that removes the last one, is refused even with a hardware approval; test networks allow it and report `warnings: ['no_alert_contacts']`.
   - **How the hardware wallet approves:** a BIP137 `signmessage` signature from a single-sig key recorded at pairing. Ledger and Trezor sign it over USB or Bluetooth; a Jade over Bluetooth; a Coldcard Mk4 or Q over NFC; Coldcard Q, Jade, Keystone 3, Passport Prime and Specter DIY over a text QR; Passport gen 2 and Krux from a file on their microSD card (see "Hardware wallets by feature"). The signed text is one line that shows the new values in clear, so the user checks them on the device screen:
     `Trikey policy v1 wallet=<id> seq=<n> limit=<sats> delay=<d>d feecap=<sats> contacts=<k> hash=<policyHash> expires=<ISO8601Z>`
     and, for no daily limit only, version 2 with the limit in words (older guardians refuse it, `1202`):
     `Trikey policy v2 wallet=<id> seq=<n> limit=off delay=<d>d feecap=<sats> contacts=<k> hash=<policyHash> expires=<ISO8601Z>`
     and, while the alert contacts may lock the guardian (rule 8) or when a change stops them, version 3, which says which in words (older guardians refuse it, `1202`):
     `Trikey policy v3 wallet=<id> seq=<n> limit=<sats|off> delay=<d>d feecap=<sats> contacts=<k> lock=<on|off> hash=<policyHash> expires=<ISO8601Z>`
     and, for a guardian with the `approval_contacts` feature (security review 2026-11), always version 4, which **names the alert contacts** and says the lock in words:
     `Trikey policy v4 wallet=<id> seq=<n> limit=<sats|off> delay=<d>d feecap=<sats> lock=<on|off> contacts=npub1abcdefgh..wxyz,npub1... expires=<ISO8601Z>`
   - **The contacts on the device** (version 4). Versions 1 to 3 showed only how many contacts there are and a 64-hex hash nobody can check, so a malicious app (or malware on the phone) could replace the owner's contact by its own npub: the device showed exactly what the owner expected, the guardian stored the attacker's contact, and a later recovery was heard only by the attacker. Version 4 shows each contact as `npub1` and the next 8 characters of its npub, `..` and its last 4 (`contactId`: 12 bech32 characters, 60 bits, so a key that shows the same takes about 2^60 tries to find), which the owner compares with the contact's nostr app; the app and the guardian's web page show every contact the same way. The list is used only when it ends within 188 characters (what Jade shows before "...", so no contact ever hides behind it); otherwise the text says `contacts=<k>:<code>`, the number and a code of the list (`contactsCode`: 80 bits of sha256, `1a2b-3c4d-5e6f-7a8b-9c0d`), which the web page (Rules) and the app show next to the contacts. With everyday values (a short sequence, a limit of a million sats) four contacts are named; at the longest values two. There is no hash: every rule is in clear but the rest of each contact's key. The budget: at most 122 characters before ` contacts=` (an 11-digit limit is the longest under "off"), so the longest version-4 text is 205 characters (a pairing naming three contacts), under Coldcard's 240. Why not the whole npub: 63 characters each would leave room for one. Why the code for many contacts, not shorter ids: fewer characters per contact would make a look-alike key cheap to grind (8 characters: 2^40). The code cannot be checked against the contacts in one's head: the owner compares it with the web page (before approving a change that keeps the contacts, after one that changes them), and every contact added or removed is told (below), which is what catches a swap.
   - **Every contact added or removed is told** (`approval_contacts`), at pairing and at every change, phone-only tightening never changes them: a NIP-17 DM retried for 7 days like the other notices ("you are now an alert contact of the wallet <guardian name> guards ...", or "you are no longer ..., call the owner if they did not tell you"), the same on a contact's own extra channels, and one line on the owner's channels naming them; Activity names them (`contactId`), never just a count. A swap the owner did not make reaches the contact it removed.
   - **Compatibility.** A guardian with `approval_contacts` accepts versions 1 to 3 only for an approval that leaves the contacts exactly as they are (an older app raising the limit still works); pairing, `wallet.add`, `hosted.pair` and any change of the contacts over an older text are refused with "update the app" (`app_update_required`). A phone signs version 4 only for a guardian that lists the feature; an older guardian rebuilds only versions 1 to 3 (and still shows only the number). Update both.
   - The guardian rebuilds this text from the request and never trusts text from the phone. The sequence number must increase (by at most 1000), and an approval is valid for at most 24 hours.
   - **The rules a wallet starts with are hardware-approved too** (security review 2026-11; guardians with the `pairing_rules_approval` feature). At pairing (`pair`), when a wallet is added (`wallet.add`) and when a guest accepts an invite (`hosted.pair`), the hardware wallet signs, besides the pairing proof, the same policy text with **`seq=0`** over the rules the wallet starts with (`pairingRulesMessage`): the device shows the limit, the delay, the fee cap, the number of contacts (and `lock=on` when the contacts may lock the guardian) and the hash of the complete rules, and the guardian registers the wallet only with exactly those rules (it rebuilds the text from the rules it will store). Before, the device signed only `Trikey pair v1 wallet=<id> guardian=<hex>`, which names no rule, so a malicious app could start a wallet with rules nobody approved (a limit just below "off", a huge fee cap, its own alert contact) and drain it with phone + guardian. Sequence 0 is below every sequence a later approval may use (they must be above the last accepted one, which starts at 0), and the text names the wallet, whose id covers key 3, so this signature can never approve a later change, another wallet or another guardian; pairing consumes no sequence. "No daily limit" is still refused at pairing even when approved: a wallet starts with a limit, and turning it off is its own approval (`limit=off`) with its own alerts. Every device that signs Trikey's texts (Ledger, Trezor, Coldcard over QR or NFC, Jade over QR or Bluetooth, BitBox02, Keystone 3, Passport, Krux, Specter DIY) just asks for one more confirmation at pairing. A phone sends this approval only to a guardian that reports the feature (an older guardian's strict schema would refuse it, and accepts the rules as before); a guardian with the feature refuses an app that does not send it, with "update the app" (`-32602`, `data.reason: "app_update_required"`): pairing is rare, and that is safer than accepting rules no device showed. Wallets paired before keep their rules; nothing is asked of them.
   - The wallet id in the text stops an approval from being replayed against another wallet that uses the same hardware key.
   - The authorization key must be a non-hardened child of the hardware wallet's multisig account (the wallet uses `<account>/0/0`, e.g. `m/48'/0'/0'/2'/0/0`): the guardian derives it from the hardware xpub itself, so only the holder of the hardware account can pair or approve. Any other path is refused. BIP137 signatures with a high S are refused.
   - No rule changes that need the hardware wallet are accepted while a recovery is running (only the phone's tightening, above).
5. **Delay & Notify (7, 14 or 30 days, as in Bitkey):**
   1. A recovery starts with a sweep signed by the surviving key, going to a new wallet that keeps that key. **It needs the chain tip:** the delay counts from the later of the system clock and the chain's median time past, and the start height is recorded. No chain data, no start.
   2. Starting it pauses phone-only payments.
   3. The guardian then sends daily nostr DM alerts to every registered device and contact.
   4. Any of them can cancel. If the cancel comes from someone other than the holder of the key that started the recovery (a "contested" cancel), phone-only payments stay paused until the hardware wallet signs a `resume-phone` approval.
   5. After the delay, the guardian co-signs the sweep and broadcasts it, once **three clocks agree**: the system clock and the chain's median time past are both past the end of the delay, and the chain has grown by the delay's blocks since the start (144 per day on public networks; 1 per day on regtest, where blocks are mined on demand). Blocks slower than 10 minutes can make the wait a little longer than the nominal delay, never shorter.
   6. Coins that arrive after the start (dust, a late deposit) do not block it: `recovery.update` lets the surviving key re-sign the sweep to include them, to the same destination, as a superset of the original inputs, with the fee within the cap, **without restarting the delay**.
   7. A sweep that can never be broadcast (its coins spent by another transaction 6 blocks deep, a later recovery's sweep broadcast instead) is given up and no longer blocks a reset.
6. **Sweep fee cap.** Recoveries can't burn funds through fees.
7. **The same keys are the same wallet.** Wallets are compared by their set of account pubkeys, not by descriptor: key 3 signs by account pubkeys and the tweaks the PSBT delegates, so another descriptor for the same keys (other origins, chaincodes or role order) is the same wallet. A retired key set is never paired again or swept to.
8. **Alert contacts can lock the guardian** (strictly opt-in, off by default; docs/design/contact-lock.md). The owner's choice, as a rule of the wallet (`contactLock`): while it is on, an alert contact of the active wallet who sees something the owner did not do (a recovery starting, the limit turned off, rules changed) can send the guardian the single word `LOCK` as a NIP-17 DM from any nostr app, and the guardian locks: the same locked state as the web UI's Lock or the phone's `guardian.lock`, so nothing is co-signed and phone-only payments stop, while recoveries, their timers and their alerts run on as on any locked guardian (a ready recovery is co-signed once the owner unlocks). A contact can **only lock**: never unlock, change rules or see balances. Unlocking stays with the owner (the passphrase in the web UI, or the phone's `guardian.unlock`).
   - **The setting.** Off is not part of the policy at all, so its hash, its approval text and every older phone and guardian are exactly as before. On is a tightening (the phone alone, at pairing too, and during a recovery); off takes a protection away, so it needs a hardware approval over the version-3 text (`lock=off`, rule 4). It carries over to a wallet a recovery adopts. The phone offers it only to a guardian that reports the `contact_lock` feature (in `guardian.status`, and in `pair.prepare` for pairing).
   - **Who may.** Only current alert contacts of the active wallet, only while it is on. Anyone else (strangers, the paired phone's key, a recovery's recipients no longer in the rules) gets no answer at all, so the command cannot probe who is a contact or whether the setting is on. While it is on, a contact gets a short answer: locked, or already locked; while it is off, the command does not exist (no answer, nothing logged), for contacts as for anyone. A message counts once (remembered across restarts, since relays re-deliver old wraps), only within 10 minutes of the guardian's clock, and at most 5 per contact per hour.
   - **Who is told.** The guardian logs it ("Locked by alert contact npub… via nostr") and alerts, durably and retried like the other alerts, the paired phone (`guardian_locked`, `reason: contact`, naming the contact; the phone shows the name it keeps for them) and every other alert contact (a DM saying who and when). The contacts are also told when the setting goes on (how to lock) and off, and while it is on the recovery and limit-off DMs end with how to lock.

## Protocol (nostr)

- **Identity:**
  - The phone's nostr key is derived from the key 2 seed (NIP-06 path).
  - The guardian has its own key, shown in the pairing QR together with its relays.
- **Messages:** JSON-RPC rumors (kind 21420, in the ephemeral range) inside NIP-59 gift wraps (kind 1059), encrypted with NIP-44 to the guardian's pubkey. The full wire format is in [`packages/protocol/PROTOCOL.md`](packages/protocol/PROTOCOL.md).
- **Methods:**

  | Method | Purpose |
  |---|---|
  | `pair.prepare`, `pair` | Pair the phone with the guardian (one-time code from the guardian's web UI); the hardware wallet signs the pairing proof and approves the rules the wallet starts with (rule 4); `pair` can also name the wallet it replaces, with its descriptor, so the new guardian watches it |
  | `sign` | Ask for a co-signature |
  | `policy.get` | Read the current rules |
  | `policy.update` | Change the rules (loosening needs a hardware approval) |
  | `recovery.start` | Start a recovery |
  | `recovery.update` | Add coins that arrived after the start to the running recovery's sweep (same destination and surviving key, a superset of its inputs, fee within the cap), without restarting the delay |
  | `recovery.cancel` | Cancel a recovery (phone, alert contact, or hardware approval) |
  | `recovery.status` | Check a recovery |
  | `recovery.access` | Let a new phone with no backup reach the guardian for 24 h, signed by the hardware wallet (bound to the wallet id when the phone knows it) |
  | `phone.resume` | Turn phone payments back on after a contested cancel (hardware approval) |
  | `hardware.confirm` | Confirm the hardware wallet's key after the guardian adopts a recovered wallet |
  | `wallet.retire` | Stop guarding this wallet, e.g. before moving to a new guardian (hardware approval) |
  | `wallet.sync`, `tx.get`, `tx.broadcast`, `fees.estimate` | Chain data from the guardian's own node, so the phone needs no public servers. `wallet.sync` can read the replaced wallet and the phone's single-key coins (`wallet: 'helper'`), and `tx.broadcast` relays a sweep of either into the vault |
  | `wallet.unwatch` | Stop watching the replaced wallet |
  | `savings.register`, `savings.unregister`, `savings.get` | Watch the phone's optional Savings wallet (watch-only, no approval: the guardian holds no Savings key), stop, read it back. Then `wallet.sync` with `wallet: 'savings'` serves its coins, `tx.broadcast` relays its spends, and a spent Savings coin raises `savings_moved` to the phone and the alert contacts |
  | `singlekey.register` | Register the phone's single-key coins (public data only): the helper coin's account (`m/84'/c'/1'` xpub) and coins by outpoint and script. Then `sign` accepts the helper input, `wallet.sync` with `wallet: 'helper'` serves them and `tx.broadcast` relays their sweeps into the vault |
  | `sp.register`, `sp.unregister` | Hand the guardian the silent payment scan key (with `B_spend`, labels and birth height) so it scans the node's blocks; take it back |
  | `sp.scan` | The payments the scanner found (`sp_received` alerts announce new ones) |
  | `guardian.unlock` | Unlock after a restart, with the passphrase or (opt-in) the hardware wallet's signature, sealed to the key the guardian made when it locked ("Sealed unlock"; refused after 5 failed tries in a row until the web UI unlocks, and while a recovery the phone did not start runs) |
  | `unlock.hardware.add`, `unlock.hardware.remove` | Turn unlocking with a wallet's hardware wallet on (its signature, sealed like an unlock's, the guardian unlocked) or off ("Unlocking the guardian with the hardware wallet") |
  | `guardian.lock` | Lock the guardian remotely (alert contacts can lock it too, with a `LOCK` DM, when the owner allows it: rule 8) |
  | `guardian.status` | Read guardian state (with `warnings`, e.g. `no_alert_contacts`) |
  | `labels.put`, `labels.get`, `labels.list`, `labels.delete` | Keep an encrypted copy of the phone's labels per wallet, opt-in, so they survive a recovery; a phone with recovery access may read it ("Notes that survive recovery") |

- **Every request carries:**
  - an id, so retries are idempotent;
  - a NIP-40 expiry;
  - the hash of the PSBT it refers to.
- **Replay protection:** old rumors are dropped. Strangers (senders that are not the paired phone, an alert contact or a phone with recovery access) get their own small replay cache and seen-wrap set, so they cannot push a peer's entries out; refused `sign` / `recovery.start` / `recovery.update` are rate limited per sender (each request holds a slot while it runs and gives it back if it succeeds, so a burst sent at once gets no more than the limit through; up to 0.1.19 the check came before the call and the count after, and overlapping requests all passed), and repeated identical refusals are one log entry with a count.
- **Relays:** several, with the user's own relay optional (Umbrel has a Nostr Relay app). Setup ticks the project's
  relay `wss://relay.trikey.app` (it stores only gift wraps and Nostr Connect events, kinds 1059 and 24133) next to
  three public ones; it sees what any relay sees, ciphertext and metadata, and is never the only one. Trikey keeps its
  subscriptions open itself: a relay whose connection drops (a restart, a network change, Android closing a background
  app's sockets) is subscribed on again after a short backoff, two days and ten minutes back because gift wraps are
  back-dated, and the app does it at once when it comes back to the front (PROTOCOL.md section 5). Every subscription
  is sent that whole look-back again, so both sides keep the ids of the wraps they handled across restarts and skip
  them before any signature check or decryption, and the phone opens new ones a few at a time so the app never stalls
  (PROTOCOL.md section 4, "Handled wraps"). From 0.1.10 a call's wraps are back-dated 10 minutes and gone from the
  relays about an hour later; alerts keep the two days.
- **Changing relays** (web UI, Settings; `PUT /api/relays`, PROTOCOL.md "Changing relays"). The phone, its backups
  and printed recovery sheets all carry the list from pairing, so a change must never cut any of them off. The guardian
  listens *and publishes* on the new relays and on the removed ones at once, and keeps watching the removed ones
  until the owner stops them in Settings (publishing only on the new ones would leave a phone that has not switched
  hearing nothing). There is no timer: printed recovery sheets carry the relay list and are kept for years, and an old
  sheet must keep working. Stopping is explicit, asks first (what stops working: sheets and backups from before the
  change, phones that have not switched) and is logged; at most 16 old relays are watched, and a change over that is
  refused rather than silently dropping the oldest, which are the oldest sheets. It tells the paired
  phone (`relays_changed`, and `guardian.status.relays` for one that missed the alert); the phone takes a list only
  from its paired guardian, with the pairing code's rules, and moves only after the guardian answered its
  `relays.ack` over the new relays alone, so a list it cannot reach (a relay that is down, a typo) leaves it where it
  works. The ack is recorded and shown, but does not end the watching: it proves the phone moved, not that the backups
  and sheets made before did. Pairing and recovery codes carry the new list at once; the web UI asks for a new
  recovery sheet. The change is logged as a security event: someone with the web UI could point the phone at relays
  they run, but relays only carry gift wraps, so the most that buys is dropping messages (availability), which a
  reset with the same passphrase already allows.
- **No public standard exists** for PSBT exchange over nostr, so this is our own spec. Publish it as a NIP draft once it's stable.

## Alerts beyond nostr (email, ntfy, webhook, Telegram)

Besides the phone's protocol alerts and the contacts' NIP-17 DMs, the guardian can send its alerts by **email through the
owner's own email account** (SMTP with an app password; TLS always), **ntfy** push, a **generic webhook** (a signed JSON
payload for Home Assistant, Apprise, an SMS gateway) and **Telegram** (the Bot API, through a bot the owner makes with
@BotFather; outbound only, plain text; Telegram can read these, as an email provider can). Design, payload and rejected
alternatives (WhatsApp among them): docs/design/notifications.md.

- **Notify-only.** They carry the warnings of the matching nostr alert, never a control: cancelling a recovery and
  locking the guardian stay NIP-17 DMs from the contacts in `alertContacts`. Plain text, no links, no buttons; nothing
  beyond "contact the owner" or, for a contact with a nostr key, "reply CANCEL / LOCK to the guardian's nostr message".
- **Who.** The owner's own channels (the phone may be in a thief's hands) get the phone's alerts; an alert contact may
  have an email address, an ntfy topic and/or a Telegram chat next to their nostr key; someone without a nostr app can
  get warnings only.
- **Owner-side settings, outside the policy.** Only the web UI changes them (signed in with the passphrase, unlocked),
  never the phone, which sees them masked and read-only (`guardian.status.notifications`). `Policy`, `policyHash`, the
  approval texts and rule 4 are unchanged: a channel adds warnings, never the power to cancel, and the mainnet minimum is
  still one nostr contact. Every change is announced on **every channel, before and after it** (a removed channel over its
  old address, a changed email account through the old account), to the paired phone (`notifications_changed`) and in the
  activity log; while a recovery runs only additions are accepted, and a new app password for the same email account.
  Email always over TLS with verified certificates; a self-signed server (Proton Mail Bridge) only by pinning exactly its
  certificate. Why this and not hardware-approved channels: the
  notifications design, "Who may change a contact's channels".
- **Durable**, like the nostr notices: queued on disk, retried for 7 days, each alert once; per-channel failures in the
  web UI and the activity log. **They work while the guardian is locked**: their secrets are sealed under a key file on
  the box, not the passphrase (the nostr key's trade-off), so "recovery started" still goes out after a power cut.

## Recovery flows

| Situation | Keys | What happens |
|---|---|---|
| Everyday payment | phone + guardian | Within the limit, Face ID only |
| Big payment, raise the limit | phone + hardware | The guardian isn't involved |
| New phone, backup available | none | Restore key 2 with the passkey, no waiting |
| Lost phone, no backup | hardware + guardian | The new phone scans the guardian's recovery code, the hardware wallet lets it in, Delay & Notify, a sweep to a new wallet, and the guardian then guards that wallet |
| Lost hardware wallet | none, or phone + guardian | Restore the seed words, or use Delay & Notify (the guardian then guards the new wallet) |
| Someone fakes a recovery | any device or contact | Tap Cancel on the alert |
| Guardian offline or locked | phone + hardware | Phone-only payments wait until it's back |
| Box may have been tampered with | phone | Lock the guardian from the phone; unlock with the passphrase once checked |
| A contact sees something the owner didn't do | none | With rule 8 on, the contact replies `LOCK`; the owner is told who, checks, and unlocks (or cancels the recovery) |
| Guardian dies or is stolen | phone + hardware | "Replace guardian": sweep to a new wallet with a new guardian |
| Guardian replaced, old box still running | phone + hardware | Also retire the wallet on the old box; it then co-signs nothing for it |
| Savings: move money out | phone + hardware, or the Recovery Key + either | Never the guardian; no limit and no waiting. The guardian relays it and tells the phone and the contacts |
| Savings: a key lost (phone without backup, hardware wallet and seed words, Recovery Key) | the other two | At once, to a new Savings wallet that keeps the two and replaces the lost one ("Savings" below) |

**Wallet rotation.** The guardian guards one active wallet and keeps the ones it guarded before as
retired, read-only history: it co-signs nothing for them, starts no recovery of them and never pairs
them again. After a recovery whose destination keeps the guardian's key (the wallet package builds it
that way), the guardian adopts the destination; a destination with another guardian's key just
retires the old wallet:

- **When:** once a node has accepted the sweep (broadcast, or already known to Electrs), not when the
  guardian co-signs it and not when it confirms. Before the broadcast the swept wallet stays in place,
  so a sweep no node will relay can still be replaced by a new recovery. Waiting for confirmations
  would add nothing: once the sweep is co-signed, key 3 refuses everything for the old wallet, so only
  the user (surviving key plus the lost one) could make a conflicting spend, while the recovered user
  would be left without co-signing (or CPFP through the guardian) for hours.
- **What carries over:** the rules and the hardware approval counter, except that **a daily limit that
  was off comes back on** at the value it had before it was turned off (0 when that is not known): a
  completed recovery means a key was lost or taken, and the hardware wallet must confirm the new wallet
  before it can turn it off again. The limit window starts empty
  (phone payments were paused for the whole delay). Recovery access grants of the old wallet are
  revoked (and their signatures stay refused until they expire). Any other recovery of the swept
  wallet still pending (one started between the completion and the rotation) is closed
  (`cancelledBy: superseded`): the running recovery is always one of the active wallet.
- **The paired phone** becomes the phone that sent `recovery.start`: the surviving phone, or the new
  phone the hardware wallet let in with `recovery.access`.
- **The hardware authorization key** carries over when the hardware wallet survived, or is derived at
  the same path below the new hardware xpub when it was replaced. It must prove itself again with a
  fresh BIP137 pairing proof over the new wallet id (`hardware.confirm`) before any hardware approval
  (loosening rules, hardware cancel, resume, retire) is accepted again.

**Replace guardian.** The phone and the hardware wallet sweep to a wallet with the new guardian's key
(no guardian needed). If the old box still runs, the phone retires the wallet there (`wallet.retire`,
with a hardware approval, refused during a recovery); pairing is then open again on that box. A fresh
guardian pairs a phone that already has a wallet like any other: same key 2 and hardware key, a new
key 3, so a new descriptor and wallet id.

**Reset guardian** (web UI): forgets every wallet and creates a **new key 3**, keeping the nostr
identity, relays and passphrase (relays are changed in Settings, see "Changing relays"). It needs the passphrase again and a typed confirmation, and is
refused while a recovery is pending or ready, or while a co-signed sweep waits to be broadcast (and
still can be: a sweep that never can is given up, see rule 5). It ends every web session. Key 3
is rotated rather than kept so that a reset can never be used to re-pair the user's wallet with a
different phone (see the threat model).

**Recovery code.** Besides the one-time pairing code, the web UI shows a permanent "Recover on a new
phone" code (`trikey://recover?...`): the guardian's npub, relays and network, no secret. It can be
printed and kept with the hardware wallet.

## Threat model

- **Stolen phone:** the thief can spend at most the daily limit. They can't raise it, because that needs the hardware wallet. **With the limit turned off** (the owner's explicit choice, hardware-approved) they can send everything at once; the alerts arrive after the money has left. A recovery they start triggers the alerts. They cannot hide the vault from a later recovery either: change past the gap limit counts against the limit (rule 3), and co-signing never moves where the gap limit counts from (only what scans see on chain does), so unbroadcast self-transfers cannot walk the window to the index limit and freeze every scan. They cannot starve the owner's unlock: the phone's `guardian.unlock` has its own throttle, stops after 5 failures until the web UI unlocks, and is refused while a recovery the phone did not start runs.
- **A phone alone adding a wallet** (security review 2026-11, Medium-High). `wallet.add` needed only the first wallet's
  paired phone and an unlocked box, and the new wallet's "hardware wallet" (its pairing proof, its rules approval) could be
  the thief's own key; `unlock.hardware.add` for it then stored a slot that unlocks the whole box, so a lock by the owner or
  a contact (rule 8) no longer held against the stolen phone; the planted wallet could not be retired without the thief's
  device, the first wallet cannot retire while others exist, and Reset was refused while the planted wallet's recovery ran;
  only the phone was told. Now (`add_wallet_approval`) adding a wallet needs the **first wallet's hardware wallet** (`Trikey
  add-wallet v1 wallet=<first> new=<new> seq=<n> ...`, its sequence), the first wallet's alert contacts are told of every
  wallet added and every hardware unlock turned on, and the owner has an escape hatch in the web page (signed in with the
  passphrase): see every wallet and unlock slot, turn any slot off, and remove a wallet after the first without its
  hardware wallet (typed `REMOVE WALLET`). Why a web session may: it can already reset the whole guardian (a new key 3,
  every wallet forgotten), and removing one wallet does less. **It gets no power over recoveries**: removing a wallet is
  refused while a recovery of it runs or its sweep waits to be broadcast, and Reset is still refused while any wallet's
  recovery runs (there is no override). Otherwise someone who learnt the passphrase could freeze a wallet whose owner is
  genuinely recovering it (a lost phone or device), leaving its money needing both of its other keys. An override of that
  is not needed either: with the first wallet's approval a phone thief can no longer plant a wallet, so a recovery of a
  wallet after the first is one its owner, or someone holding that wallet's keys, started, and it ends by completing or by
  a cancel from that wallet's phone, hardware wallet or alert contacts. Every removal is announced to the wallet's phone,
  the owner's channels, its contacts and the first wallet's; the money of a removed wallet stays with its phone key and
  hardware wallet (2 of 3).
- **A malicious app swapping an alert contact** (security review 2026-11, High). Before version 4 of the policy text the device showed only the number of contacts, so an app could replace the owner's contact by its own at pairing or at any hardware-approved change, unseen, and later run a recovery only its own "contact" heard of. Now the device names each contact (`contactId`), or shows their number and a code the web page shows too, every contact added or removed is told, and Activity names them (rule 4). What remains: an owner who does not compare the npubs (or, with five or more contacts, the code) with their contacts' apps; a key ground to look like a contact's (2^60 tries); an older guardian, which still shows only the number.
- **A malicious app build at pairing** (security review 2026-11). The app chooses the rules a wallet starts with. Until this release the hardware wallet signed only the pairing proof, which names no rule, and the guardian refused only "no daily limit" there: an app built to steal could pair with a limit one satoshi below "off" (since the same review, 1,000 BTC and more is "off" and refused at pairing whatever is approved), a fee cap as large as all bitcoin or its own alert contact, then send everything with phone + guardian at once. **Since this release the rules a wallet starts with are hardware-approved** (`pair`, `wallet.add`, `hosted.pair`; rule 4): the device shows them, and the guardian refuses rules without a signature over exactly them. What remains: an owner who approves on the device without reading it; and an older app with a guardian that does not have the feature, which still pairs without the approval (update both). A malicious app can still lie on the phone's own screens; the device's screen is what to trust, as for every approval.
- **Alert contacts are what makes Delay & Notify work.** Without one, a recovery is announced only to the paired phone, which may be the thief's: a phone-only thief could then sweep the whole vault to a wallet of its own (keeping key 2, adding its own "hardware" key) and nobody would hear of it. So **on mainnet the guardian requires at least one alert contact**, at pairing and for every rule change. **A contact can be the user's own nostr app on another device** (a laptop, a tablet, a second phone): it only needs a nostr key that can receive NIP-17 DMs and reply `CANCEL <id>`. Test networks allow zero contacts and say so (`warnings: ['no_alert_contacts']` in `policy.get`, `guardian.status` and the web UI).
- **Contested recovery stalemate (by design).** A stolen phone can cancel every recovery the hardware wallet starts, and the hardware wallet can cancel every recovery the phone starts. Each contested cancel pauses phone payments until the hardware wallet resumes them. So if the phone is stolen and the user has **no backup of key 2**, the thief and the owner block each other: **the vault is frozen, not lost**. Nobody can take the funds (the thief holds one key, the owner one key, the guardian co-signs only within the rules), and the owner gets out by restoring key 2 from its backup (then phone + hardware spend directly, no guardian needed) or, failing that, by waiting the thief out. This is the price of letting any key holder cancel; the alternative (letting one side's cancels win) would let that side's thief win.
- **Burglary (phone + home server):**
  - An unplugged guardian is locked, so the burglar holds one usable key.
  - If the thief keeps the guardian powered, they can only reach the daily limit, and any recovery triggers the 7-day alerts.
  - Tell users to keep the hardware wallet's seed words outside the home.
- **Remote compromise of the home server** gives up one key of three. That's the same exposure as Bitkey's server being breached.
- **Savings (optional).** Phone + guardian, together or compromised, cannot move Savings: the guardian holds no Savings key. What can: the phone with the hardware wallet, or the Recovery Key with either of them. A burglar who finds the phone, a powered box and a Recovery Key kept at home takes Savings too, so the Recovery Key belongs away from home, apart from the hardware wallet's seed words. A compromised guardian can hide Savings' balance from the phone or stay silent when it moves (its tripwire), which costs nothing it was trusted with. Turning the Savings watch off or swapping it for another wallet (the paired phone alone can) is announced to the phone and every alert contact (`savings_unwatched`), so a phone thief cannot quietly blind the tripwire before moving Savings with a second key. The watched Savings record survives a recovery, so whoever completes one (normally the owner) can read Savings' descriptor and balance from the guardian; it moves nothing.
- **Encrypted notes on the guardian (opt-in).** The guardian stores ciphertext it cannot open (the key comes from a hardware wallet signature the guardian never sees). With most devices that signature never leaves the phone: it comes back over USB, Bluetooth, NFC or a QR code the phone reads, and only the derived key is kept, in the secure store. **Passport gen 2 and Krux write it to a file on their microSD card** (`trikey-notes-1of2-signed-001.txt` and the like, two when notes are turned on), so a copy of that file, from the card or from a computer or email it passed through, plus a copy of the guardian's `labels/` folder (a stolen box or disk, an old copy of the data) opens every note. What protects it: the file alone opens nothing (the ciphertext is only in the guardian's data, which no platform backup holds: "The platforms' backups leave the guardian out"), and after each round trip the phone names the request and the signed file to delete, from the card and wherever they were copied, and goes on only when the owner says they did ("microSD message signing", "Cleaning up the card"). A file that was not deleted keeps that power for as long as the notes stay on the guardian under that key: the device makes the same signature every time, so turning notes off and on does not change it. It learns **roughly how many notes the owner keeps** (the copy is padded to a size bucket: 4 KiB doubling to 512 KiB) and **when they change** (each upload, at most one stored version per 10 minutes), nothing of what they say. A thief holding the unlocked phone can overwrite or delete the copy (as they could the labels on that phone); the guardian keeps the three newest versions, and the money is never at stake.
- **Unlocking with the hardware wallet (opt-in; "Unlocking the guardian with the hardware wallet").** What an unlock slot changes, case by case:
  - *The box stolen (the disk only).* The slots file holds, per wallet, a salt, a nonce, a 16-byte key check and the encrypted seed: the key comes from a hardware wallet's signature (256 bits, not a guessable passphrase), so the slots add no offline attack; the passphrase slot stays as strong as its passphrase. Combined with an archive of old gift wraps a malicious relay kept past their expiry, the guardian's nostr key on the disk (stored in clear, so a locked guardian can answer) opened an old `guardian.unlock`, and with it the signature: the same exposure as a passphrase the owner once typed on the phone. Sealed unlock closes that, for `guardian.unlock` and for `unlock.hardware.add`, which carries the same signature ("The guardian's disk plus archived gift wraps", below). Turning the option off and on again makes a new slot and makes every earlier signature worthless; a reset rotates key 3. A stolen box is "Replace guardian" either way: never unlock a box you no longer hold.
  - *The phone stolen, without the hardware wallet.* It cannot unlock: the phone keeps neither the signature nor anything derived from it, and the guardian checks every slot signature against the wallet's authorization key, so the phone cannot add a slot of its own either (`unlock_signature_invalid`). Its guesses count against the phone's throttle (5 in a row stop the phone until the web UI unlocks), as wrong passphrases do. A lock by the owner or an alert contact (rule 8) therefore still holds. It can turn the option off: a nuisance (the passphrase remains).
  - *The phone and the hardware wallet together.* They unlock the guardian, as they already could move every coin without it (2 of 3). Nothing new.
  - *A malicious relay.* It sees one more gift wrap and cannot open it (NIP-44 to the guardian's key); it can drop it (the owner uses the passphrase) or replay it: the guardian refuses an old or seen rumor, an id it handled before a restart (`1501`), and an unlock while already unlocked changes nothing.
  - *A compromised phone* (malware on it). It sees the signature in transit and could keep it, so it could unlock the guardian later without the device, until the slot changes: the same as it already sees the passphrase whenever the owner types it on the phone. Unlike the passphrase, the signature opens nothing else (no other use, no other wallet, no other guardian; the text says so) and costs only an off-and-on to replace. A phone suspected of malware: turn the option off, or off and on again from a clean phone.
  - *Replay of a signature elsewhere.* The text names the wallet, the guardian's nostr key, the network and a random slot id, and its prefix is no approval's (rule 4), so it is worthless anywhere else, and no other text of the device unlocks anything.
  - *A guest's hardware wallet* (family hosting) never unlocks the host's box: guests cannot call the methods and are never told the feature.
- **Changing the passphrase** ("Changing the passphrase"). Who could use it, and what for:
  - *Someone with a web session and the passphrase* (a browser left signed in, a leaked passphrase) can change it and
    so keep the owner out of the web UI and out of unlocking after a restart. They could already reset the guardian,
    which costs the owner more (a new key 3); the change is announced to the phone and the owner's channels, the
    hardware unlock still works if it was on, and the money stays with the phone and the hardware wallet (Replace
    guardian). The change cannot touch key 3, the rules or the wallet.
  - *A phone thief* cannot change it: there is no phone method ("Not from the phone" there says why).
  - *Guessing the current passphrase through the change form* is counted by the web unlock's throttle like a wrong
    unlock, so it is no faster than guessing at the unlock form; it can delay the owner's web unlock, as wrong unlocks
    already can ("Nuisances").
  - *A stolen disk or an old copy of the data.* A disk or a copy taken after the change needs the new passphrase. One
    taken before still opens with the old passphrase and gives the same key 3: the change protects the future, not
    copies already made (a copied volume, a snapshot, an Umbrel backup from 0.1.21-alpha or earlier). If both the old passphrase and such a copy
    may be out, use Replace guardian.
  - *A crash in the middle* leaves the old keystore or the new one (one atomic rename), and the unlock slots are bound to
    either (the same key 3 and `createdAt`).
- **Phishing that imitates an alert.** Trikey alerts never carry a link or a button and never ask anyone to sign in,
  in nostr DMs, email, ntfy, Telegram or webhooks alike (the guardian breaks anything link-like before sending, and its name in
  messages may hold no dots); each message says so. A message with a link is not from the guardian. Email and ntfy are
  not signed: an ntfy topic on a public server can be read and posted to by anyone who knows it, so a forged "all clear"
  is possible there; the nostr messages, signed by the guardian's key, remain the reference, and controls exist only there.
- **Silencing or redirecting the extra channels.** A phone thief cannot: no phone method changes them. Someone with
  the web UI and the passphrase can, but every change is announced on every channel before and after it (removed ones
  over their old address, a changed email account through the old one) and to the phone, and nothing can be removed
  while a recovery runs. They could already reset the guardian; the nostr alerts and controls stay as they were.
  Redirecting never hands them a stored secret: a channel moved to another ntfy server needs its topic again and loses
  its token, a new webhook URL loses the signing secret, and a new email server, port, encryption, user name or pinned
  certificate needs the app password again (docs/design/notifications.md, "A secret stays with the address it was saved
  for"; security review 2026-11, findings 1 and 2).
- **The phone itself.** The Security tab shows a calm note when the phone has no screen lock (Android KeyguardManager.isDeviceSecure, iOS deviceOwnerAuthentication, via expo-local-authentication), an Android security patch older than 6 months (`Build.VERSION.SECURITY_PATCH`, `modules/trikey-phone-safety`; iOS has no robust way to tell a supported version, so it is skipped there) or an emulator or simulator (expo-device): read on the phone, never sent to the guardian, any server or analytics.
- **A BitBox02** ("BitBox02 over USB-C and Bluetooth"). Its payments and most texts use anti-klepto, checked by the phone,
  so malicious BitBox02 firmware cannot leak key 1 through those signatures' nonces. Notes and hardware unlock cannot
  (they need the same signature every time): there, as with every other brand, the firmware is trusted. The phone's
  pairing with a BitBox02 (its channel key) sits in the app's storage: someone who copies it can skip only the pairing
  code with that BitBox02, never its password or an approval on it.
- **A Jade over Bluetooth and its PIN server** ("Jade over Bluetooth"). Unlocking it sends an encrypted exchange from the phone to the PIN server the Jade names (Blockstream's by default): that server learns the phone's IP address, when this Jade unlocks and failed PIN counts, never the PIN, keys or wallet. It cannot unlock the Jade without the PIN, and a server that is down or refuses only keeps the Jade locked (the passphrase and the other keys are unaffected; QR mode works without Trikey contacting it). The phone uses only https addresses the Jade gives and calls nothing on the Jade but `pin` with the answer. Payments over Bluetooth do not use Jade's anti-exfil (its PSBT path has none), so a Jade with malicious firmware could in theory leak key 1 through its signature nonces: alone that moves nothing, with a stolen phone it would.
- **Malicious relays** can drop messages but can't read or forge them. A relay change from the web UI (a security event in the activity log) can at worst move the phone to relays that drop everything; the old relays stay watched until the owner stops them and the phone moves only to relays the guardian answered it over.
- **Contested recovery** (a thief cancels a genuine recovery): phone-only spending stays paused, so the thief can't drain either. Same as Bitkey.
- **After a recovery the guardian trusts its outcome:** the phone that started it becomes the new wallet's paired phone. That is what the Delay & Notify period protects; a thief who gets that far already holds the new wallet's keys. The hardware wallet must re-prove its authorization key for the new wallet before it can loosen anything, and the old wallet's recovery access grants are revoked.
- **Retired wallets are dead to the guardian:** no co-signing, no recovery, no re-pairing of the same key set, under any descriptor (another origin fingerprint, chaincode or role order is the same keys to key 3). The hardware authorization key must derive from the hardware account, so a phone thief cannot pair a retired (or any) key set with an authorization key of its own. Coins sent to a retired wallet's address later can only move with two of its own keys.
- **Retiring needs the phone and the hardware wallet together** (the paired phone's nostr key plus a `retire-wallet` approval) and is refused during a recovery, so a hardware-held thief cannot end the guardian's protection in the middle of its own recovery.
- **Reset rotates key 3.** With the old key 3 and no wallet state, anyone holding the web UI, the passphrase and a stolen hardware wallet could pair the user's own wallet again with their own phone and no alert contacts, then run a recovery nobody else hears about. A new key 3 cannot co-sign the old wallet at all (its funds stay with the phone and the hardware wallet), so a reset can only lose the guardian's help, never the user's money to a thief. Reset is refused while a recovery runs or a sweep awaits broadcast.
- **Remote lock** is allowed for the paired phone at any time and, only when the owner turned rule 8 on, for the alert contacts; for nobody else. It only removes capability. A thief with the phone can lock the guardian (a nuisance: unlock needs the passphrase), but could not have done more with it than the daily limit anyway.
- **Alert contacts locking (rule 8, opt-in).** A contact, or someone who stole a contact's nostr key, can at worst **lock** the guardian, as often as the owner unlocks it (5 messages per contact per hour): a nuisance, never a loss. While it is locked the owner pays with the hardware wallet, and a ready recovery waits for the unlock, which a contact could already delay more by cancelling it. The owner unlocks and, if it happens again, removes that contact or turns rule 8 off, both with the hardware wallet. It gives a contact nothing else: no unlock, no rule change, no balances, and strangers get no answer to learn from. What it buys: a contact who sees an alert the owner cannot have caused (a phone thief's recovery, the limit off) can stop the guardian co-signing at once, without waiting for the owner. It does not stop a recovery (`CANCEL` does) and does not help against a thief holding the phone and the hardware wallet, who needs no guardian. The phone alone can turn it on, never off: a phone thief would want it off, and that needs the hardware wallet.
- **A contact's `CANCEL` is the whole message.** The alert DM names the line `CANCEL <id>`, so nostr clients that quote
  the message they reply to would carry it into any answer ("> CANCEL 2-... / Was this you?"). The guardian takes the
  command only as the one line left once blank and quoted (`>`) lines are dropped, as for `LOCK`; anything else that
  names the running recovery's line gets a short DM with the exact line to send, and cancels nothing (up to 0.1.19 the
  line was found anywhere in the message, quotes included).
- **The recovery code holds no secret.** The guardian's npub and relays are visible on the relays anyway; what lets a new phone in is the hardware wallet's `recovery.access` signature, bound to that phone's nostr key and (version 2, when the code carries the wallet id) to the wallet. A version-1 signature whose grant a rotation or retirement revoked is refused until it expires.
- **The guardian's clock is not trusted alone.** An attacker who controls the box's NTP can move the system clock: a recovery's delay counts from the later of the clock and the chain's median time past at the start (a clock set back cannot shorten it), and completes only when the clock, the median time past and the block count all agree (a clock pushed forward cannot either). The daily limit's window is not opened by stepping the clock: the guardian refuses to co-sign while the clock is more than 3 hours ahead of the chain, its window time never goes backwards, and the spend records are only ever pruned on that window time (a jump ahead and back deletes nothing). Without chain data a recovery does not start, and co-signing stops once the last chain observation is 3 hours old.
- **The web UI has its own sessions.** Every API call needs a session (the unlock passphrase signs a browser in; an HttpOnly, SameSite=Strict cookie, idle-expiring, in memory, together with the session's secret in the `X-Trikey-Session` header: below), except the reduced status and first-run setup until it completes, because other apps' containers on the box can reach the guardian without going through the platform's proxy. Still keep the port behind the proxy (Umbrel's app gateway, Start9's interfaces), which also stops DNS rebinding. A request that changes something and carries neither `Origin` nor `Sec-Fetch-Site` (every browser sends `Origin` on a POST, PUT or DELETE) is accepted only from the guardian's own container (loopback) or the platform's login proxy; from anywhere else it is refused (`403 forbidden`). That stops a request forged through another app on the box (a server-side request forgery there rarely sets headers); a client that sets its own headers is judged by the session and the setup code like any other. Scripts send `Origin` with the address they open the page at.
- **The session cookie goes to every app on the same host.** Cookies are bound to a host, not a port (RFC 6265), and on Umbrel every app is `http://umbrel.local:<port>`: when the owner opens another app, the browser sends it `trikey_session`, and that app's server can replay it to the guardian's container (its own requests carry whatever headers it likes, so the `Origin` checks do not apply). With the cookie alone it had a full web session: read the wallet and the activity, change relays, channels and the chain source while unlocked, lock, stop hosting. So the cookie alone is no session: every answer that signs a browser in also carries a per-session secret (`sessionSecret`, 32 random bytes; the guardian keeps its sha256 and compares in constant time), which the page keeps in `sessionStorage` (per scheme, host and port) and sends as `X-Trikey-Session` with every request; the browser never sends it anywhere by itself. A reload keeps it; a new tab gets it from the guardian's other open tabs over a `BroadcastChannel` (also per origin), or signs in again. Not from the server: an endpoint that gave the secret for the cookie would give it to the other app as well, whose server can forge `Sec-Fetch-Site` and `Origin`. A request with two `trikey_session` cookies (one tossed in by another app at a more specific path, which the browser sends first, to sign the owner out) has no session and is answered with cookies that clear both. Where the login proxy is recognised (`TRIKEY_TRUSTED_PROXY`, Umbrel's gateway), a session signed in through it (or from loopback) is accepted only from there afterwards; one signed in from elsewhere (umbrelOS 1's sidecar, which is not trusted) is not bound, so the owner is never locked out. Another app can still sign the owner out (it can also fill the browser's cookie jar for the host until the cookie is dropped): a nuisance, not an access. No `__Host-` prefix: it requires `Secure`, and Umbrel's local address is plain HTTP.
- **First run without a platform login (security review 2026-11, finding 3).** Before setup there is no passphrase, so whoever reached the web UI first could set the guardian up and own key 3. On plain Docker nothing guards the port; on Umbrel and Start9 the platform's login guards only its own path, and every other app's container on the box reaches the guardian's port directly (Umbrel's apps share one Docker network, Start9's services one LXC bridge, and Start9's basic-auth gate covers only the TLS interface). So the guardian asks for a **one-time setup code** (80 bits) on every platform, from every request that did not come through the platform's own login proxy:
  - **Plain Docker:** a new code at every start, in memory only, printed in the log: reading it takes the Docker access only the owner has. The compose file publishes the web UI on 127.0.0.1 by default; on a LAN the passphrase crosses it over plain HTTP, so the guide points to Tailscale or the NAS's HTTPS proxy.
  - **Umbrel: recognise the login proxy, no code for the owner.** umbrelOS 2's app gateway runs inside umbreld on the host and connects to the app's container from the host's address on the app network, which is the container's default gateway (`10.21.0.1`); umbrelOS 1's `app_proxy` was a sidecar container (`trikey-guardian_app_proxy_1`). The package lists only the gateway (`TRIKEY_TRUSTED_PROXY=gateway`), and the guardian compares the socket's own remote address (never a forwarded header) with the gateway read from `/proc/net/route`. It used to list umbrelOS 1's sidecar names too, but on umbrelOS 2 nothing holds them: another app's container could take one as its `container_name` or network alias, Docker's DNS then answers with exactly its address, and that app was trusted, skipped the code and could set the guardian up with its own passphrase (owning key 3). So host names are only for a platform that creates a fixed, legitimate holder before the guardian starts: each is checked once at startup and never trusted while the process runs if it named no address or more than one then; afterwards it is resolved at every request and trusted only while it names exactly one address in total (an IPv4 and an IPv6 address are two holders). Through umbrelOS 2's gateway the owner sees no code; another app's container connects from its own address and is asked for one. On umbrelOS 1 (the `app_proxy` sidecar), or if the gateway is not recognised (a future umbrelOS), the page asks for the code and says where it is: the app's logs (Settings > Troubleshoot). Why this and not the code for everyone: it closes the race with no extra step for the usual owner, and fails closed (to the code) rather than open.
  - **Start9: the code, shown by StartOS.** StartOS's proxy reaches the service over the same bridge as other services, and its address could not be checked on a device here, so no address is trusted. The package draws the code once at install (`store.json`, a volume the guardian never mounts), hands it in (`TRIKEY_SETUP_CODE`) and shows it in its **Show Setup Code** action and next to the web password the owner sets first: one copy and paste in StartOS's own UI, which only the server's owner reaches.
  - What the code does not stop: whatever already acts as the box's host or impersonates the proxy's address on the bridge (a process on the host, an app on the host's network, ARP spoofing from a container with raw sockets). Each of those can also read the plain HTTP between the platform's proxy and the guardian (the passphrase at setup and every unlock), so no check at this layer would; they are outside what this guards, as before.
  - A DNS-rebinding page gets no session (its origin is not the guardian's) and so no more than a signed-out client.
- **The guardian's nostr key is stored unencrypted** (mode 0600), so a locked guardian can still answer the phone and receive an unlock. It can't sign transactions.
- **The guardian's disk plus archived gift wraps** (closed for unlocks from this release; "Sealed unlock"). Every request to the guardian is a gift wrap to its nostr key, which is on its disk. Gift wraps are short-lived on the relays from 0.1.10, but a relay may keep them. Someone who steals the disk *and* holds such an archive could open every past request: before sealing, a `guardian.unlock` gave them the passphrase (and so key 3's seed from `keystore.json`), and a `guardian.unlock` or `unlock.hardware.add` the slot signature (and so the seed from `unlock-slots.json`). Now the phone seals those secrets to a key the guardian holds in memory only and replaces at every lock and unlock and after every use: the disk never holds what opens a seal, and once the key is replaced nothing anywhere does. The key it was locked with is zeroed the moment it unlocks; the one an add used, right after the add. The phone's one-time key is zeroed at once too, so a stolen phone cannot open its own old seals. What remains:
  - **Unlocks and adds before this release, and from older apps.** Their wraps were or are in the clear (the guardian accepts them, and its Activity says "sent it unsealed" so the owner updates the app). A passphrase once typed on a phone before sealing stays exposed to this attack until the owner changes it (web UI, Settings > Passphrase; "Changing the passphrase"), after which it opens no keystore written since; a copy of the disk taken before the change still opens with it (see there). A slot signature sent in the clear stops mattering once the option is turned off and on again from an updated app (a new slot, its signature sealed).
  - **An attacker who holds the nostr key and acts live.** With the disk's nostr key they can answer the phone as the guardian (from the stolen box or a copy) and show it their own unlock key; the phone then seals the next unlock to them. Sealing defeats a passive archive, not impersonation: a stolen box is "Replace guardian", never unlock a box you no longer hold. The phone does not pin `sealed_unlock` once seen: an impersonator would show the feature anyway, and pinning would only strand a guardian rolled back to an older version.
  - **The running box's memory.** Whoever reads the guardian's memory holds the current sealing key, and would see the next unlock or add anyway (and, unlocked, key 3 itself); the key is replaced after every use and every failed try, so near-miss passphrases sealed earlier cannot be read from it later.
  - **The web UI's passphrase over plain HTTP on the LAN** is a separate exposure (a device on the same network can read it in transit), outside the relays and unchanged here: keep the web UI behind the platform's proxy, `127.0.0.1`, Tailscale or an HTTPS proxy ("First run without a platform login").
  - Other requests in the archive give nothing the disk does not: the silent payment scan key is on the disk under its key file, the notes are ciphertext, approvals and recovery-access signatures are bound to one sequence or one phone.
- **The chain source is trusted** for chain data; headers are checked to link up but not for proof of work, transactions against their txid. On plain Docker the Electrum server may be on another machine: plain TCP goes only to a loopback, private or link-local address (resolved and checked before every connection), anything else needs TLS, verified against the public CAs or a pinned certificate; Bitcoin Core's RPC (no TLS, the node's credentials in clear) the same, and stricter: a host name is resolved at every call, every address must be local and not link-local (169.254/16, fe80::/10, where cloud metadata services live), the request goes to the address that was checked (no second lookup a DNS rebinding could change), and redirects are refused (security review 2026-11, finding 4); a literal IP address is used as configured. **A public server** (the owner's explicit choice) sees the watched wallets' addresses and the box's IP address and can hide coins or delay confirmations: that can stall a payment or a recovery's completion, or make the guardian miss a Savings movement, but never spend or change a rule. Because Delay & Notify leans on chain data (spends elsewhere, sweep confirmations), the guardian refuses to switch to a public server while a recovery runs, and every switch is announced on every channel and to the phone, which shows the kind.
- **The node's RPC credential** (security review 2026-11, finding 5). The guardian talks to Bitcoin Core with whatever
  user the platform gives it, and on Umbrel and Start9 that is a full one: Umbrel exports only its Bitcoin Node app's
  `umbrel` RPC user (`APP_BITCOIN_RPC_USER`/`_PASS`), and on Start9 the RPC cookie user, which Bitcoin's RPC proxy lets
  make every call. Whoever takes over the guardian (or reads its environment) can do what that user can: read the node,
  broadcast, and, if the node holds a wallet, use it (send from it, or export its private descriptors with
  `listdescriptors true` while it is unlocked). The guardian itself only reads, broadcasts signed transactions and, with
  Bitcoin Core alone, keeps its own watch-only wallet. What limits the rest:
  - **Keep no funds in the node's own wallet** (the Bitcoin Core the guardian uses), or keep that wallet encrypted and
    locked. Trikey's coins are not there: the node only sees addresses.
  - **A restricted RPC user, where the owner sets the credentials** (plain Docker's `.env`, Settings > Server): make one
    with Bitcoin Core's `share/rpcauth/rpcauth.py trikey`, put its `rpcauth=` line in `bitcoin.conf` with exactly the
    calls the guardian makes, and give the guardian that user. With an Electrum server as the chain source (the default):

    ```
    rpcauth=trikey:<salt>$<hash>
    rpcwhitelist=trikey:getblockchaininfo,getblockcount,getblockhash,getblock,sendrawtransaction,getrawmempool,getrawtransaction,getmempoolinfo,getmempoolentry,getnetworkinfo,gettxout
    rpcwhitelistdefault=0
    ```

    and with **Bitcoin Core alone** (Settings > Server, `CHAIN_SOURCE=core`) the calls of its watch-only wallet too:

    ```
    rpcwhitelist=trikey:getblockchaininfo,getblockcount,getblockhash,getblock,sendrawtransaction,getrawmempool,getrawtransaction,getmempoolinfo,getmempoolentry,getnetworkinfo,gettxout,getbestblockhash,getblockheader,estimatesmartfee,listwallets,loadwallet,createwallet,getdescriptorinfo,importdescriptors,listdescriptors,listsinceblock,listunspent,gettransaction
    ```

    `rpcwhitelistdefault=0` keeps the node's other users (other apps) unrestricted; without it, any `rpcwhitelist`
    line makes every other user's list empty. A whitelist names calls, not wallets: with Bitcoin Core alone the wallet
    calls work on any wallet loaded in the node (`listdescriptors true` included), so the advice above still holds.
    None of the listed calls can sign or send from a wallet. The lists are in `apps/guardian/src/chain/bitcoind.ts`
    (`RPC_METHODS`, `RPC_METHODS_CORE_ALONE`), and a test keeps them, this text and the code in step.
  - **Umbrel** gives an app no other user, and its compose file sets the variables, so there the advice is the first
    point. **Start9**: the package reads the cookie through a subcontainer of its own that runs nothing; the
    guardian's container no longer mounts Bitcoin's volume (its datadir and any wallet files in it). A dedicated
    `rpcauth` user from Bitcoin's `generate-rpc-dependent` action is left for a test on a device
    (packaging/start9/README.md).
- **Nuisances, not thefts:**
  - Anyone who knows a wallet address can send a coin after a recovery starts. That blocks completion, because the sweep must spend every coin, until the surviving key adds it with `recovery.update` (the delay runs on).
  - Anyone who sees the guardian's npub on a relay can burn a 5-minute pairing code with wrong attempts (at no disk write: a wrong secret is refused before anything is recorded).
  - Anyone with a web session can delay unlocks through the web throttle (wrong unlocks, or wrong current passphrases in "Change passphrase", which share it); without one, only sign-ins, which have their own throttle. A stolen phone's guesses never delay the web UI.
  - A flood of refused requests costs no state write and only pushes out older refusals in the activity log, never co-signatures or other entries.
- **Release supply chain** (review 2026-11). What a release ships is what people install without reading code: the
  APKs (by hand, Obtainium, Zapstore, the app's Check for updates), the guardian image and the files that name it.
  - **The image** is pushed only by docker.yml's `publish` job (v* tags, `release` environment), with one tag per
    release and no moving tag; everything shipped names it by the digest that job pushed, and only once two more clean
    builds of the tag (reproducible.yml) gave exactly that digest (the release's compose file, the Umbrel store, the
    Start9 package's packed image, the GitHub release). The arm64 build runs under QEMU from a binfmt image pinned by
    digest. What remains: a
    token that may write the package (until the owner sets up `GHCR_PUSH_TOKEN` and drops GITHUB_TOKEN's write access,
    any branch workflow) can push over a version tag, which reaches only people who pull that tag by name.
  - **Release files** are attached to a draft and published by publish-release.yml only after its checks (both APKs
    signed by `packaging/android/release-cert.sha256`, the compose file pinning the pushed digest, checksums), and are
    locked once the owner turns on immutable releases (docs/android-signing.md). Until then a `contents: write` token
    can replace a published file.
  - **The app's update check** shows the release certificate built into the app, never a checksum from the offered
    release, and warns when an APK would install as a new app (another application id), which Android cannot check
    against the installed one. Android itself refuses an update signed by another key.
  - **Not built yet (TODO):** downloading the APK in the app and checking its signing certificate before handing it to
    Android's installer (`PackageManager.getPackageArchiveInfo(path, GET_SIGNING_CERTIFICATES)` against the built-in
    certificate, in a small local Expo module without Google code, both variants). It needs the
    `REQUEST_INSTALL_PACKAGES` permission and a FileProvider, i.e. a wallet that can ask to install apps, and it can
    only be tested on devices; until then the browser downloads the APK and Android's own signature check on updates,
    plus the warning and AppVerifier for a new app, are what stand between a replaced file and a phone.

## Entropy

Guessable keys would lose money silently, so where each key's randomness comes from is spelled out here.

**Where every key comes from.** Every key and secret Trikey makes is drawn through one function, `secureRandomBytes` ([`packages/core/src/random.ts`](packages/core/src/random.ts)). It reads the platform's own CSPRNG (`crypto.getRandomValues`, filled by the operating system) and checks it on every call.

| Key or secret | Where | Source |
|---|---|---|
| Key 2, guardian mode (24 words) | `packages/wallet` `newMnemonic` | 32 bytes from `secureRandomBytes`, then `entropyToMnemonic`. On the phone that is `expo-crypto`: `SecRandomCopyBytes` on iOS, `SecureRandom` on Android. |
| Key 2, Recovery Key mode (24 words) | `packages/recovery-key` `newPhoneMnemonic` | Same. |
| Recovery Kit key (12 words) | `packages/recovery-key` `newRecoveryKeyEntropy` | 16 bytes from `secureRandomBytes` on the same phone. |
| Key 3, guardian mode | `apps/guardian` `generateSeed` (`trikey/guardian-seed/v1`), then `trikey/key3/v1` | 32 bytes from `secureRandomBytes` (Node's webcrypto, Linux `getrandom`) at setup or reset, mixed with 32 bytes from the setup browser's `crypto.getRandomValues` and the platform's extra entropy (on Umbrel the app's `APP_SEED`, on Start9 the package's own draw; below); then mixed with the phone's contribution at pairing (below). |
| Key 1, the hardware wallet | The device | The device's own generator, outside Trikey's control. Trikey only ever sees its xpub. |
| Guardian nostr key, NIP-59 wrap keys | `identity.ts`, `transport.ts` | `randomSecretKey`: 32 bytes from `secureRandomBytes`, drawn again only if they are not a valid secp256k1 scalar. |
| Backup data key, nonces, salts, recovery code, passkey PRF salt | `packages/wallet/src/backup.ts`, `wallet.ts` | `secureRandomBytes`. |
| Pairing secret, message ids, pairing session id | `packages/protocol/src/pairing.ts`, `envelope.ts`, `apps/guardian/src/pairing.ts` | `secureRandomBytes`. |
| Guardian keystore salt and nonce, silent-payment key encryption | `apps/guardian/src/keystore.ts`, `silent/service.ts` | `secureRandomBytes`. |
| Unlock slot salt and nonce; the slot id | `apps/guardian/src/unlock-slots.ts`; the phone's `enableHardwareUnlock` | `secureRandomBytes`. The slot's key itself comes from the hardware wallet's deterministic signature, not from either generator. |
| Sealed unlock: the guardian's sealing key; the phone's one-time key and NIP-44 nonce | `packages/protocol/src/sealed-unlock.ts` (`UnlockKeyHolder`, `sealUnlock`) | `randomSecretKey` and `secureRandomBytes`. Both keys live in memory only and are zeroed after use (the sealing key at every lock, unlock and use, the one-time key as soon as the seal is made). |
| NIP-44 nonces and NIP-59 back-dating (RPC and the guardian's NIP-17 alert DMs) | `packages/protocol/src/transport.ts` | `secureRandomBytes` and `secureRandomInt`, no longer `Math.random` or nostr-tools' own generator. Back-dating hides when a message was sent, so it should not come from a predictable generator. The wrap's public `expiration` is derived from that same back-dated `created_at` (`created_at + W + the class TTL ceiling`, where `W` is the back-dating window: 2 days for alerts, 10 minutes for requests and responses from 0.1.10, PROTOCOL.md section 2), never from the send time, so it does not undo the back-dating; relays still see when an event arrives. |

`Math.random` is left in one place: the Electrum reconnect jitter, which is timing only. A lint-style test ([`packages/core/test/randomness-lint.test.ts`](packages/core/test/randomness-lint.test.ts), checker in `test/support/randomness-check.ts`) fails CI when the shipped sources (`apps/*/src`, `apps/*/app`, `packages/*/src`) reach randomness any other way: `Math.random`; a random function (`randomBytes`, `getRandomValues`, `randomUUID`, `randomInt`, `randomFill`, `randomSecretKey`, `generateMnemonic`, `generateSecretKey`, nostr-tools' `wrapEvent`/`createWrap`/`createSeal`, ...) imported, destructured or reached as a member from any module other than our own; `globalThis.crypto` / `window.crypto` (except `.subtle`); and `nip44.encrypt` without an explicit nonce. Aliased, namespace, default, `require` and dynamic-import forms are followed. The few files that implement the source itself are allowlisted per rule, with the reason, and a test fails if an exception is no longer needed. It cannot see value aliasing (`const m = Math; m.random()`) or code inside dependencies.

**The guards.** `secureRandomBytes(n)` refuses to answer, with a typed `RandomSourceError`, when:

- `n` is not an integer from 1 to 65,536;
- there is no `crypto.getRandomValues`;
- `crypto.getRandomValues` is no longer the function pinned at start-up (`pinRandomSource`);
- the output is one byte value repeated (a zero-filled buffer, a stuck source);
- the leading 32 bytes of a draw equal the previous draw's (a continuous test; every call draws at least 32 bytes so the check always has a full block).

It never retries silently and never falls back to anything weaker. A source caught stuck, repeating or replaced stays refused until the process restarts. The wallets turn the error into `random_source_failed` before anything is stored.

**What the guards cannot do.** The OS generator's output is already conditioned, so it looks uniformly random whether it was seeded well or not. A generator seeded from 32 known bytes passes every statistical test, and no test on its output can prove it unpredictable. These checks catch gross failures only: a broken or missing polyfill, a buffer that was never filled, a stuck source, a source swapped out after start-up. The defences against a subtly weak generator are the setup mix and the key-3 mix (two and three machines' generators), and the 2-of-3 structure below.

**Start-up health test and known answers.** One shared function ([`packages/core/src/random-health.ts`](packages/core/src/random-health.ts), `@trikey/core/random-health`) runs before any key is made: the guardian runs it in `main.ts` before it opens anything (exit code 70 and a `rng.selftest_failed` line if it fails, so Umbrel shows the app as failing) and in `Guardian.open`; the phone runs it once at start in `bootWallet` and again before key 2, the Recovery Key, the recovery code, the backup and the key-3 contribution. It draws 16 blocks of 32 throwaway bytes, each in its own call, and refuses on a constant block, two equal blocks (a cycle), the same XOR or difference between neighbouring blocks (a counter), 8 equal bytes in a row, one byte value 26 or more times in 512, a block with fewer than 64 or more than 192 one bits of 256, or a total outside 1,792 to 2,304 of 4,096 (8 sigma each; the false-alarm rate is below 10^-13 per run). It also checks known answers for HMAC-SHA512, SHA-256, secp256k1, BIP 39 and BIP 32, so a broken or patched crypto library is caught. A failure is latched like the per-call checks and never retried. Like them it proves nothing about unpredictability; a seeded or `Math.random`-backed generator still passes.

**Source pinning.**

- **The phone.** The app's first import (`apps/mobile/src/platform/polyfills.ts`) installs `crypto.getRandomValues` backed by `expo-crypto` and pins it; on the web it pins the browser's own.
- **The Ledger kit's polyfill.** The Ledger Device Management Kit needs `crypto.getRandomValues` (through `uuid`), and `react-native-get-random-values` used to provide it. That package installs its function only when none exists. It never runs first, so it installs nothing, and the Ledger kit and key generation share the one pinned function. `random.native.ts` checks this right after importing it (`assertRandomSourcePinned`). If load order ever changed and that package's function won, the app fails right there: its implementation calls the same native `ExpoCrypto.getRandomValues`, but falls back to `Math.random` under Chrome's remote debugger.
- **The guardian.** `main.ts` first imports `pin-random.ts`, which pins `node:crypto`'s `webcrypto.getRandomValues`.

Pinning catches accidents, not code already running inside the process, which could do anything anyway. The app's crypto self-test (Settings, Developer) also checks that the source is pinned.

**The guardian's seed from more than one machine (`trikey/guardian-seed/v1`).** The setup seed (and the new seed a reset makes) does not rest on the guardian's generator alone:

```
entropy = HMAC-SHA512(key  = os (32 bytes from secureRandomBytes on the guardian),
                      data = "trikey/guardian-seed/v1" || u32be(len) || browser || u32be(len) || extra)
          truncated to 32 bytes, then BIP 39 (24 words) and the 64-byte seed as before
```

- **`browser`:** 32 bytes from the browser's `crypto.getRandomValues` (`apps/guardian-web/src/lib/random.ts`), sent as `entropy` with `POST /api/setup` and `POST /api/reset`. Another machine's generator, over the local HTTP path, which no nostr relay ever sees. The web UI always sends it.
- **`extra`:** `TRIKEY_EXTRA_ENTROPY`, 32 bytes as hex; any other non-empty value is hashed to 32 bytes (SHA-256), so a value in another format never stops the guardian from starting. The Umbrel package sets it to the app's `APP_SEED`, which umbrelOS derives from the Umbrel's own seed and the app id (HMAC-SHA256), so it comes from another moment of the box's life (the Umbrel's setup). StartOS has no per-service seed, so the Start9 package draws 32 bytes itself, once at install, in the package runtime (another process than the guardian, before setup), and keeps them on its `startos` volume, which the guardian's container does not mount (`packaging/start9/startos/init/seedEntropy.ts`).
- **Both optional:** absent is length 0. `entropy` in a request must be exactly 32 bytes (the guardian refuses the request otherwise); `extra` is always 32 bytes once read (above). A setup without a browser (tests, a script) still works.
- **Why this shape.** `os` is the HMAC key, so the result is a PRF output under a secret key: never weaker than the plain OS draw it replaced, whatever the other inputs are, even chosen by an attacker. If `os` is predictable, the result is HMAC with a known key over 256 bits the attacker does not know (HKDF-Extract with a known salt), so it is as strong as the browser's or the platform's input. The tag and the length prefixes keep every input in its own field.
- **Hygiene.** The inputs are never logged or stored; the guardian zeroes its copies. `TRIKEY_EXTRA_ENTROPY` is removed from the process environment once read.
- **Existing guardians** keep their seed: only new seeds (setup, reset) are made this way. Nothing on disk or on the wire changed format; `entropy` is an extra, optional field of two HTTP requests, which an older guardian ignores.
- **What it does not cover:** code already running on the guardian, or an attacker who also sees the setup browser's traffic to the box. Neither input needs to be secret from the user.
- Vectors are in `apps/guardian/test/setup-entropy.test.ts`, checked against node:crypto's HMAC.

**Key 3 from both sides (`trikey/key3/v1`).** At pairing the phone sends `c`, 32 fresh bytes from its own `secureRandomBytes`, in `pair.prepare` (`entropy`). The guardian makes the wallet's key 3 from its setup seed and `c`:

```
seed3 = HMAC-SHA512(key = guardian setup seed (64-byte BIP 39 seed), data = "trikey/key3/v1" || walletContext || c)
walletContext = u32be(len) || network || u32be(len) || pairing session id || u32be(32) || phone nostr pubkey
key 3 = BIP 32 master of seed3, account m/48'/<coin>'/0'/2'
```

- **The context** binds the network, the pairing session and the phone, so the same `c` sent again gives a different key.
- **Storage.** The guardian stores `c` and the context with the registration. They are not secret: without the seed they say nothing about key 3. It derives key 3 again at every unlock, and keeps the setup seed in memory only while unlocked.
- **Lifecycle.** A wallet rotation keeps the same key 3 and the same record. A reset makes a new seed. A new pairing gets a new `c`.
- **The phone never learns key 3,** only its xpub. It shows "Your guardian's key was made with randomness from both this phone and your guardian" when the guardian answers `key3Mixed: true`.
- **What this is for, and what it is not (entropy review 2026-10, M1).**
  - It protects against the guardian's setup seed being known **on its own**: a seed that leaked without the guardian's nostr traffic, or a flaw in seed generation alone. Such a seed no longer gives key 3.
  - It does **not** protect against a guardian whose whole generator output is predictable to someone who can read the relays (a VM restored from a snapshot, a badly seeded kernel). `c` reaches the guardian in `pair.prepare`, a gift wrap on public relays encrypted to the guardian's nostr key, and that key, like the pairing id in the context, comes from the same generator as the seed. Whoever predicts the generator opens the stored wrap, reads `c` and derives key 3. No transport change fixes that: anything the guardian computes from its own generator and relay traffic, the observer can compute too.
  - That case is covered at setup instead, by `trikey/guardian-seed/v1` above: the browser's and the platform's inputs never cross a relay.
  - It does not protect against a dishonest guardian either, which could ignore `c`, and that cannot be proven without revealing key 3.
- **Compatibility.** A guardian without `entropy` support refuses such a request (its schema is strict), so the app needs a guardian of this version or later. A guardian receiving no `entropy` keeps its own key, as before.
- Vectors are in `apps/guardian/test/key3-mix.e2e.test.ts`, checked against node:crypto's HMAC.

**User-supplied entropy (dice) was considered and not built.** The idea: optional dice rolls mixed into key 2 and the Recovery Kit, plus a "check this on another computer" step that recomputes the words from the phone's random part and the dice. It was dropped for two reasons.

- **The check exports seed-equivalent material.** Showing the OS contribution so the user can recompute the key moves the key off the phone, in a form the phone cannot protect: screenshots, an online second computer, phishing ("paste your hex here to verify").
- **It adds little for a hot phone key.** Dice only help against an honest but broken generator, which the guards above target. Against a malicious phone they help nothing: that phone holds key 2 in the clear anyway.

**The risk this leaves in Recovery Key mode.** Key 2 and a paper Recovery Kit both come from the same phone's generator. A subtle failure the guards cannot see, such as a badly seeded but working CSPRNG, would weaken two of the three keys at once. With two weak keys, the hardware wallet no longer protects the money. Guardian mode does not have this problem: key 3 mixes in a second machine's generator. The mitigation is the existing option to use a **second hardware wallet as the Recovery Key**, whose key comes from that device's own generator. The RK-Create screen now calls it "the strongest choice: its key is not made on this phone". The paper kit stays the simple default.

**What 2-of-3 gives.** A weak key alone cannot move money. One key with poor entropy, whether the phone's, the guardian's or the hardware wallet's, still needs a second key to spend. The hardware wallet's key comes from the device's own generator, outside Trikey's control, which is one more reason the three keys should not share a source.

## Recovery Key mode (no home server)

Built in [`packages/recovery-key`](packages/recovery-key) (`@trikey/recovery-key`). The app drives it through one facade, `RecoveryKeyWallet`, whose methods follow the `RK-*` screens.

- **Keys.** The vault is the same `wsh(sortedmulti(2, phone, hardware, recoveryKey))` on BIP 48 as guardian mode.
  - Key 1, the hardware wallet: its BIP 48 account key.
  - Key 2, the phone: one seed with two accounts. BIP 48 for the vault, BIP 84 (`m/84'/c'/0'`) for the **spending balance**, a single-key `wpkh` wallet the phone spends from with Face ID alone (it also restores in any BIP 84 wallet).
  - Key 3, the **Recovery Key**: a fresh 12-word BIP 39 seed made in memory and printed on the Recovery Kit, or a second hardware wallet, of which only the xpub is needed (the kit is then a wallet map with no secret). The user proves the kit is saved by typing three of its words or scanning the printout; then key 3 is wiped from the phone and only its xpub stays. (An NFC card is still a later option.)
- **No vault address before the device confirms one.** Key 1 reaches the phone from the device, and for an air-gapped device (QR, Coldcard over NFC) by a code or read the phone cannot authenticate: a swapped export would put someone else's key in the vault under the device's fingerprint. So, as in guardian mode, the vault is registered on the device and its first address checked there when the kit is confirmed, for every kind (an air-gapped device gets the compare sheet: the address, to find on its own screen); a mismatch makes no vault. Until a check has passed (`addressVerified`), no vault address is shown, copied or shared (`vaultReceiveAddress` throws `address_unverified`); a vault made before the check was required gets there with *Check on your device* (`vaultReceiveAddress({ verifyOnDevice: true })`). A key export whose xpub's depth or child number contradicts its claimed path is refused (`apps/mobile/src/hardware/qr/export.ts`).
- **Refills are a chain pre-signed by phone + hardware** (default 8 × 200,000 sats, weekly).
  - Refill *k* spends output 1 (the vault change) of refill *k−1* with `nSequence` = 1,008 (BIP 68, blocks), pays the refill amount to a fresh spending address (output 0) and the rest to a fresh vault change address. Segwit inputs only, so every txid is fixed before signing; the unsigned previous refill is each link's `nonWitnessUtxo`, so hardware wallets can check amounts.
  - Whoever holds the signed chain, at most one refill confirms in any 1,008-block window. The fake chain in the tests enforces BIP 68 and a thief broadcasting every refill every block gets exactly one per period.
  - **Refill 1 of the first batch has no timelock**, so the spending balance is usable the day the wallet is made (the screen says "Refill 1 · today"). A timelock there would only delay the owner: the thief's limit comes from the links. **Later batches do need one**, or a new batch would hand out a second refill inside the same period: their first refill carries `nLockTime` = last refill height + period − 1 (and `nSequence` = period when it spends an earlier refill's change). "Approve more" while the chain is live simply appends links to its last refill, so nothing is reset.
  - The phone only broadcasts a refill while the spending balance is below one refill, so unused refills do not pile up on the phone. The scheduler runs when the app opens or from a background task.
- **Fees** are fixed at signing and bumped by **CPFP**.
  - Pre-signed at the 6-block estimate, at least 3 sat/vB on mainnet (the minimum relay fee elsewhere), never more than 2% of the refill (a stored refill above 5% fails verification).
  - A stuck refill is sped up by a child spending its output 0, which the phone alone can sign; the child pays for parent + child at the current target (`speedUpRefill`). The scheduler offers it when a refill in the mempool is below the target.
  - Limit: a refill below the mempool's minimum fee cannot be bumped at all until package relay is available through the chain server (Esplora's `POST /tx` takes one transaction). Hence the floor. TRUC (v3) transactions plus package relay are the later fix.
- **Invalidation.** Any other spend of the chain's next input ends the chain. `payFromVault` spends coins the chain does not need first, so only a payment larger than those invalidates it, and it can sign a fresh batch from its change in the same hardware session. The app tells "my own payment or sweep" (a new batch is needed) from "a vault spend this phone did not make" (two keys are in other hands). A refill this phone did not broadcast is reported once as an unexpected broadcast.
- **The Recovery Kit** (format 1):
  - Payload: version, network, creation height, key 3 (16 bytes of entropy and its account, or an xpub record), the phone's and the hardware's account keys (74 bytes each: fingerprints, account, chain code, public key, so the descriptor comes back byte for byte), and a 4-byte checksum.
  - One QR code: `TRIKEYKIT1:` + base32, all QR alphanumeric characters, 25% error correction (65 × 65 modules).
  - Words for when the QR is damaged: the 12 Recovery Key words (a standard BIP 39 phrase) plus 116 "wallet map" words (the rest of the payload, 11 bits per BIP 39 word). Typos point at the word; four-letter abbreviations work.
  - The printed page (self-contained HTML) shows the title, date, network, the wallet fingerprint the app also shows, the QR, the words, the descriptor for other wallet software, and plain instructions, starting with "keep this sheet apart from your hardware wallet's seed words".
  - **Not encrypted by default.** A kit password would be one more thing to lose, and losing it turns the kit into nothing; the sheet alone moves nothing. Encryption would help only if the kit could be stored next to one of the other keys, which the instructions already forbid. The format reserves a flag for an optional passphrase later.
- **Chain data comes from an Esplora server** (`fetch` only, so it runs in Hermes). Defaults: mempool.space for signet and testnet4, blockstream.info for mainnet; the setting should point at the user's own server (Umbrel and Start9 both run one). A public server learns every address of the vault and the spending balance and the phone's IP address, so it can link them and watch every refill, but it cannot move or freeze coins. The server is trusted for confirmations and the tip, not for amounts: every coin signed for comes with its raw funding transaction checked against the txid.
- **Recovery is immediate,** with any two keys and no Delay & Notify. Each sweep moves every confirmed vault coin and replaces a refill a thief left in the mempool. The fee follows the estimate, capped at 100,000 sats and 5% of the vault.

  | Situation | Keys | Destination |
  |---|---|---|
  | Phone lost or stolen | kit + hardware, on a new phone | an address, or a new vault (new phone key, same hardware wallet at the next BIP 48 account, new kit) |
  | Hardware wallet and its seed words lost | kit + phone | an address, or a new vault (new hardware wallet, new kit) |
  | Recovery Kit lost or seen | phone + hardware | a new vault with a new kit (same devices, next account) |

- **Stored state** is one JSON document with an HMAC under a key in the secure store, and the refill chain's links and signatures are checked again on every open.
- **The trade-offs:**
  - keep the Recovery Kit apart from the seed words; anyone with both takes everything, with no undo window;
  - approve new refill batches every couple of months;
  - a vault payment larger than the coins outside the chain forces a fresh batch;
  - coins received after a batch stay outside the chain until the next fresh batch;
  - a thief with the phone gets the spending balance plus one refill per period until the owner sweeps;
  - a public chain server sees the whole wallet.
- **To check on real devices:** that each device signs inputs with `nSequence` = 1,008 and a non-zero `nLockTime`, and what it shows. Trezor needs the `sequence` passed explicitly when the PSBT is converted to its format. Ledger, Coldcard, BitBox02, Jade, Keystone and Passport sign PSBTs as given but may warn about the timelock. The test is to sign a batch on regtest or signet with each device, run every refill through `tools/consensus-verify`, and broadcast refill 2 before and after its 1,008 blocks.

## Speed up (RBF) of a Spending payment

A payment out of Spending that waits too long to confirm (on mainnet, payments of 0.1.10 went out at 0.11 sat/vB, the
rate Bitcoin Core 29's estimates follow its relay minimum down to) can be sent again with a higher fee
(`TrikeyWallet.quoteSpeedUp` / `speedUp`, the planner of Savings' speed-up, `planFeeBump` and `buildBumpPsbt`):

- **What changes.** Every Spending payment signals RBF (`nSequence` 0xfffffffd). The replacement (BIP 125, as Bitcoin
  Core applies it) spends the same coins and pays the same outputs to everyone else: the amount and the address never
  change. The higher fee comes out of the change: at the estimate for the chosen speed (fast by default; never under
  1 sat/vB on mainnet, as for any payment), and at least the old fee plus the incremental relay fee (taken as at least
  1 sat/vB) for the replacement's size. A change that would be left as dust goes to the fee. A payment with no change
  (send max) cannot be sped up this way, nor a silent payment (its output key depends on the helper coin, which would
  have to sign again), nor a sweep; the app says why.
- **Who signs.** Like any payment: the phone and the guardian within what is left of the daily limit, else the phone and
  the hardware wallet (over the limit, guardian locked or away, a recovery running), and a guardian refusal hands it to
  the hardware wallet as for a payment (the app asks first). The guardian needs nothing new: its per-outpoint count
  (rule 3) takes the larger of the old and new amounts for each coin, so the replacement of a payment it co-signed in the
  last 24 hours adds exactly the extra fee (`apps/guardian/test/limit.test.ts`), and a payment first signed with the
  hardware wallet counts in full when the guardian co-signs its speed-up. The phone's own estimate does the same
  (`spends[].replaces`). Payments first signed with the hardware wallet can be sped up either way.
- **Broadcast.** The guardian relays the replacement through its usual shortcuts: one it co-signed moments ago
  (`RecentlyCosigned`), or a coin it knows (`KnownCoins`), which keeps a coin while an unconfirmed transaction in the
  wallet's history spends it, so a hardware-signed replacement needs no wallet scan either.
- **One row.** The replacement goes into the send log with `replaces` and the original's note; the wallet's history
  shows it in the original's place (the original keeps its own entry, and comes back only if the replacement never
  shows). The guardian's `wallet_tx` for a replacement says so (`replaces`, from the coins its live wallet saw the
  original spend, `live-wallet.ts`), so the phone shows a speed-up made anywhere as the same row, not a second payment,
  and moves the balance by the extra fee only. The owner's own channels read "Payment of X sats sped up: fee now Y".
- **The app.** "Speed up ›" under a pending payment in Activity and on its details screen opens `app/send/speed-up.tsx`:
  the amount (unchanged), the fee now and the new fee (sats and sat/vB), the three speeds with their fees, what it
  costs, who signs, then the usual co-sign or hardware flow ("Signed. Sending…").
- **Not for a family-hosting guest yet.** A wallet hosted on someone else's guardian is refused (`cannot_speed_up`, not
  offered in Activity). Its slot would count a co-signed bump correctly (the same per-outpoint limit), but the slot's coin
  ledger drops only the coins a PSBT spends, so it would keep the replaced payment's change next to the replacement's;
  guest payments go to the slot without BIP 32 derivations; and the host's live wallet never watches a guest, so no
  `replaces` would reach its phone. The guest's `tx.broadcast` relays only what its own slot co-signed, so the host's
  shortcuts (`RecentlyCosigned`, `KnownCoins`, per wallet id) and its `replaces` alerts stay the host's own.
- **Checked before signing.** Before the phone signs a replacement (or hands it to a hardware wallet), `checkFeeBump` (`packages/wallet/src/fee-bump-check.ts`, the idea of Bitkey's FeeBumpVerifier) checks on the phone, for Spending and Savings alike and against that wallet's own descriptor: the original (cached with its witnesses, else `tx.get` with them) hashes to the recorded txid; each input's previous transaction hashes to its txid and pays a script the descriptor derives; each input's witness is the wallet's 2-of-3 witness script with two SIGHASH_ALL signatures valid for its keys; the replacement spends every input once and nothing else, and pays every output exactly but the wallet's own change, which alone may shrink or go. Any failure refuses (`cannot_speed_up`, in words) and logs only a reason code (`speed_up_refused`).
- **Later: CPFP.** An incoming payment waiting to confirm (or a payment that cannot be replaced) could be hurried by a
  child spending its output with a high fee. Not built: the sender can speed up an incoming payment, and a CPFP from
  Spending would spend a coin the guardian must co-sign against the limit for a fee only; Recovery Key mode's spending
  balance has CPFP for its refills.

## Silent payments

Built in [`packages/silent-payments`](packages/silent-payments) (`@trikey/silent-payments`: BIP 352 v1.1 in pure TypeScript, checked against every case of the BIP's official test vectors) and wired into `@trikey/wallet`.

- **Vault inputs can't make a silent payment.** BIP 352 derives the output from the sum of the *eligible* inputs' keys: P2TR, P2WPKH, P2SH-P2WPKH and P2PKH. Inputs with several keys or branches (`CHECKMULTISIG`) are excluded on purpose (a co-signer could re-sign with other keys after the output was derived). So a spend of `wsh(sortedmulti(2,…))` coins alone has no eligible input at all, and there is nothing for the vault's keys to compute.
- **Sending: the helper coin.** The phone keeps a small single-key **P2WPKH helper coin** from key 2's seed, on its own BIP 84 account `m/84'/coin'/1'` (10,000–50,000 sats is plenty; the user funds it from any wallet).
  - Every payment to an `sp1…` (`tsp1…` on the test networks) address spends it next to the vault coins. It is the only eligible input, so **the phone alone derives the output**: input_hash over the smallest outpoint of all inputs, ECDH with the helper key. The vault inputs ride along and are signed as always; neither the guardian nor the hardware wallet computes anything special.
  - The helper pays the fee for its own input and change; its change goes back to a fresh helper address (one helper UTXO, living on in its change). The vault pays the amount and the rest of the fee. No helper coin, or one too small for its share, is a typed refusal that says where to send one.
  - **The outflow** a daily limit counts is the vault's: Σ vault inputs − Σ vault outputs. The helper's value is the phone's, not the vault's, either way: the helper change is never vault change (that would let a thief move vault money to a phone-only output for free), and the helper input is not vault money. The wallet's quote counts exactly that.
  - The helper key and the scan key are kept in the secure store **without biometrics**, like the nostr key: a quote can derive the output and a scan can run without a prompt. Key 2 (and with it the silent payment spend key) stays behind Face ID; signing any payment still needs it. The cost: someone with the unlocked phone could take the helper coin, which is why it stays small.
  - **The guardian co-signs them within the limit** once the phone has registered its helper account (`singlekey.register`); until then rule 1 refuses the helper input as `foreign_input` and such payments go phone + hardware (what the wallet does today without `silentPaymentsViaGuardian`). The allowance is narrow, and every part is tested, refusals included:
    - **at most one** extra input (`too_many_helper_inputs`), and only in a PSBT that pays a **taproot output**. Every silent payment does, so the gate costs nothing; it keeps ordinary payments on exactly the old code path and refusals. It is not a security boundary (anyone can add a taproot output); the outflow rule is.
    - a **P2WPKH** spend of an address of the **registered helper account** (index at most 1,000 per chain);
    - **finalized** by the phone: `finalScriptWitness` = `<sig> <compressed pubkey>` hashing to the script, no scriptSig, the signature a valid low-S SIGHASH_ALL signature over this transaction (so the phone has committed to every input and output, and nothing changes after key 3 signs) (`helper_not_finalized`, `helper_invalid_witness`, `helper_invalid_signature`);
    - backed by a **`nonWitnessUtxo`** that matches its txid, whatever the caller requires for vault inputs.
    Core's `analyzePsbt` does the checks (option `helperInput`, off by default; the default behaviour is pinned by a byte-for-byte golden test). It keeps the helper out of the vault inputs, so the signature-count rules and key 3's signing loop never see it.
  - **The limit counts the vault's outflow: `Σ vault inputs − Σ outputs to vault addresses`**, never below zero. The fee is counted (the vault's share; the helper pays its own), the helper's value is not, and a helper output is never change (outputs count only when they pay a derived vault address), so vault money parked on the phone's key counts in full. The per-outpoint accounting (replays counted once, an RBF replacement as the larger outflow) runs over the vault inputs only. The old formula, `Σ all inputs − Σ vault outputs`, over-counted by exactly the helper's value; the test for that was written first.
  - The helper input reaches the hardware wallet **finalized**, as an external input that is already signed (what Trezor requires for external inputs; others ignore inputs they cannot sign). Which devices sign such a PSBT for a registered multisig wallet still has to be checked on real hardware.
- **Receiving: a single-key wallet on the phone, swept coin by coin.** Received coins don't go into the vault directly: a vault has no single key for the sender's ECDH to target.
  - The scan and spend keys derive from key 2's seed at BIP 352's paths (`m/352'/coin'/0'/1'/0` scan, `/0'/0` spend), with the `sp1…`/`tsp1…` address and labels (the change label `m = 0` is never handed out, and always scanned for).
  - Found coins (single-key P2TR on the phone) show as a separate "silent payments" balance and are swept into the vault's next receive addresses **one coin per transaction**, each to its own address, never consolidated, so the sweeps do not link the payments to each other. Coins worth less than a threshold after the fee wait for cheaper fees.
  - The backup carries what a rescan needs (the wallet's birth height, the labels handed out, the helper's address indexes) and no key: every key derives from key 2's mnemonic.
- **Who scans: the guardian** (`apps/guardian/src/silent/`). The phone registers the scan private key, `B_spend`, its labels (always with 0) and the birth height (`sp.register`, paired phone only). The guardian reads each block from the user's node with its prevouts (`getblock <hash> 3`, Bitcoin Core 23+; Electrs has no per-block prevouts), from the birth height to the tip and then on every new tip, keeps the matches, announces new ones (`sp_received`) and returns them with their tweaks (`sp.scan`). It never holds `b_spend` and never derives a spending key. The phone checks every match against its spend key before keeping it and sweeps quickly, so a lying scanner cannot leave the user with coins only that scanner can find again. Without the node RPC (`BITCOIN_RPC_HOST/PORT/USER/PASS`, already in the packaging contract) every `sp.*` answers `1700`, naming the settings.
  - **It scans while locked.** The scan key can find payments but not spend them, and the guardian is locked after every restart (a power cut), when payments still arrive. So the scan key is encrypted (XChaCha20-Poly1305) under its own random key in `silent-payments-key.json`, not under the passphrase, next to the state in `silent-payments.json`: the same trade-off as the guardian's nostr key. Anyone who copies the data directory learns which payments the phone received; they cannot move them. A copy of the state file alone reveals nothing. `sp.unregister` (or pairing another phone: retire, reset, a rotation to another phone) forgets the key and the matches.
  - **Reorgs.** The scanner keeps the hashes of the last 100 blocks it scanned. Each run checks the newest against the node (a reorg always replaces the newest block); when it changed, it walks back to the last block both agree on, re-scans from there, drops the matches from blocks no longer on the main chain and finds moved payments again at their new height. `sp.scan` repeats the 6 blocks below the phone's `fromHeight`, so a payment a reorg moved into a block the phone already scanned reaches it too. Only confirmed blocks are scanned (no mempool).
  - **Cost.** Per transaction with a taproot output: the input key sum, input_hash, then **one** multiplication of `A` by `input_hash·b_scan` (instead of the tweak `input_hash·A` and then `b_scan` times it, which halves the work; checked against the package and every BIP 352 receiving vector), then `B_spend + t_k·G` and the labels. Transactions without a taproot output, or without an eligible prevout type, are skipped before any curve work. Measured on a synthetic 2,000-transaction block, pure JS (Node 22, `apps/guardian/test/sp-perf.test.ts`) on a virtual machine with four 2.8 GHz Xeon cores, the median of five runs: in one thread, about 5.5 ms per scanned transaction; 10.6 s per block when every transaction pays a taproot output (0.09 blocks/s), 3.2 s when 30% do (0.31 blocks/s; the package's two-multiplication path took 18.6 s and 5.5 s). On three worker threads (below): 3.9 s and 1.4 s, 2.9 and 2.3 times faster (single runs ranged from 1.5 to 2.9 times: the machine is shared). A Raspberry Pi 4 (Cortex-A72, four cores) is roughly 3-4 times slower per core: about 10-13 s per block like the 30% one in one thread, so following the tip costs a few percent of one core, and a first scan from a birth height one month back (about 4,300 blocks) takes most of a day. On three worker threads that block should take about 4-6 s and the first scan 5-7 hours (estimated from these numbers, not measured on a Pi; Bitcoin Core on the same box needs some of the CPU too, to serve the blocks). Faster later: an index that serves the per-transaction tweak data, which leaves one ECDH per transaction.
  - **Threads.** Each block is scanned on worker threads (`apps/guardian/src/silent/scan-pool.ts`): `SP_SCAN_THREADS` of them, by default one less than the cores (three on a Pi 4), and with `1` the main thread scans, as before. The main thread applies the cheap rules, cuts the remaining transactions of the block into a few chunks per worker, and puts the matches back together in block order, so they are the same, byte for byte and in the same order, as in one thread (`apps/guardian/test/sp-threads.test.ts`, on the BIP 352 vectors and synthetic chains with a reorg). Blocks are still applied one at a time in height order, with the same saves, reorg handling and announcements; the only change is that the next block is fetched from the node while one is scanned, so at most two blocks are in memory. Each worker gets its own copy of the scan key, moved to it and zeroed once decoded; the workers live for one run and are terminated at its end, on `sp.unregister`, on a new registration and on shutdown.
- **The wallet's side** (`packages/wallet/src/guardian-sp.ts` and `wallet.ts`). In guardian mode the guardian does all of it by default:
  - `enableSilentPayments` registers the helper account with `singlekey.register` (with the coins found without the guardian, if any), then the scan key, its labels and the birth height with `sp.register` (again when a label is added: re-registering the same keys re-scans). Turning receiving off, or leaving the guardian, sends `sp.unregister`. Registration runs one at a time and never throws for a guardian that cannot be reached: the outcome is in `snapshot().silentPayments.scan`.
  - The single-key coins (the helper, and the received coins until they are swept) come from `GuardianSingleKeyChain` (`wallet.sync` with `wallet: 'helper'`, `tx.get`, `tx.broadcast`, `fees.estimate`); a payment that spends the helper goes to the guardian for its co-signature once the helper is registered.
  - `scanSilentPayments` asks the guardian (`GuardianSilentPaymentScanner` over `sp.scan`), registering again after a `1701`. When the guardian cannot scan (no node RPC, `1700`, shown as `needs_node_rpc`; not answering; no support) it falls back to the scanner passed in the wallet's deps (`LocalSilentPaymentScanner` for a phone with its own full node, and the tests), if there is one.
  - The `sp_received` alert starts a scan at once. Moving the coins into the vault needs the biometric prompt, so `sweepSilentPayments` waits for the person's tap.
- **The hardware wallet cannot verify the recipient.** It shows the output as a plain taproot address (`bc1p…`), not `sp1…`: it cannot check that the output really pays the address the user typed, only that the phone says so. The app shows both, so the user can compare the taproot address on both screens. Only BitBox02 can verify a silent payment today, through BIP 375's PSBT fields with BIP 374 DLEQ proofs. For Trikey that means a PSBTv2 whose output carries the recipient's keys (`PSBT_OUT_SP_V0_INFO`) and the phone's ECDH share for the helper input with its DLEQ proof (`PSBT_GLOBAL_SP_ECDH_SHARE`, `PSBT_GLOBAL_SP_DLEQ`); the device checks the proof against the helper's public key, computes the output itself and shows `sp1…`. Trikey's PSBTs are version 0 and carry neither yet: that is the later path.
- **Privacy trade-offs.**
  - A payment carries the helper input next to the vault inputs, so it links the helper coin to the vault on chain, and a vault spend with one P2WPKH input is a recognizable shape.
  - The helper change and the vault change are both visible as change-like outputs.
  - A phone with the helper coin's key can be linked to every silent payment it made (the helper's history is one chain of change).
  - The scanning server (the guardian, or whoever holds the scan key) learns every payment received; so does anyone who copies the guardian's data directory (the scan key is not under the passphrase, so that scanning works while locked).
  - Each sweep is a 1-input, 1-output transaction from a taproot coin into the vault's multisig, so the vault is linked to each received coin (but not the received coins to each other).
  - Recovery Key mode has a single-key spending balance (`m/84'/c'/0'`) whose coins are eligible inputs, so it could send silent payments from that balance without a helper; that is not built yet.

## Savings (optional)

Built from [docs/design/savings-and-limit-off.md](docs/design/savings-and-limit-off.md), option K (the owner's decision,
2026-11-01): a second wallet for money the owner rarely touches, which the phone and the guardian cannot move, even
together. Strictly optional: a wallet without Savings sets up and works exactly as before (no onboarding step, no rule,
no policy hash or approval text changes, the same version-1 backup).

- **Script and keys.** `wsh(sortedmulti(2, phone, hardware, recoveryKey))`, every key at BIP 48 account 1'
  (`m/48'/<coin>'/1'/2'`, `SAVINGS_ACCOUNT` in `@trikey/core`): key 2's seed, the wallet's own hardware wallet, and a
  **second hardware wallet as the Recovery Key** (the owner's answer to open question 2), of which only the xpub is kept.
  Account 1' gives Savings its own keys and addresses, never Spending's. The guardian holds no Savings key, so no rule of
  the guardian protects Savings: the script does. Every spend needs a key that is not online.
- **Creating it** (Settings > Savings, or from Home's suggestion; never onboarding): key 2's Savings key (biometric
  prompt), the hardware wallet's, the Recovery Key's (which must be another device); Savings is registered on both
  devices (Ledger's HMAC is kept) and each shows its first address, which must match; then the guardian is told to watch
  it. Only with a guardian that reports `savings`: Savings' chain data comes from it. The app then shows the descriptor
  (to keep with the Recovery Key: with it, the two hardware wallets recover Savings in any multisig wallet), offers the
  printed Savings wallet map, and asks for a new backup.
- **The Savings wallet map** (owner's answer 10; `apps/mobile/src/data/savings-map.ts`): one printed page, in the
  Recovery Kit's style and through the same in-memory print path, so the owner or an heir can find and recover Savings
  with its keys alone, without Trikey: the network, the date, the wallet id, the checksummed descriptor as text and as
  one QR code, each key's role, device, master fingerprint, path and xpub, the first receive address to check an import
  against, and what to do. It holds no secret (the page is built from public fields only and refuses a private extended
  key) but shows Savings' balance and history to whoever reads it, which the page and the screen before printing both
  say. Offered at the end of creation, on the Savings screen and in Wallet details; the demo prints one marked as such.
- **Moving money.** Into Savings: a normal payment from Spending to a Savings address, counted against the daily limit
  like any other (owner's answer 3); over the limit the hardware wallet signs. Out of Savings: two of its keys (phone +
  hardware wallet by default; phone + Recovery Key if the hardware wallet is lost; hardware wallet + Recovery Key if the
  phone key is not usable), at the 6-block fee estimate with RBF signalled, broadcast through the guardian. "Move to
  Spending" pays a Spending address; the hardware wallet shows it as an outgoing payment and the app says so. Spending and
  Savings coins are never mixed in one transaction. **Speed up** (`TrikeyWallet.quoteSavingsSpeedUp` /
  `speedUpSavingsSpend`): a Savings payment waiting to confirm is replaced (BIP 125) by one with the same coins and the
  same payments, a higher fee (the 1-block estimate, at least the old fee plus the incremental relay fee for its size)
  taken from the change back to Savings, signed again by two of Savings' keys; the app shows the fee difference first.
  A payment with no change cannot be sped up this way (the payment is never lowered); CPFP from Spending is not built.
  Spending payments are sped up the same way, with the guardian's co-signature within the limit ("Speed up (RBF) of a
  Spending payment", above).
- **The guardian's part** (`apps/guardian/src/savings.ts`, `PolicyEngine.registerSavings`): it watches the descriptor
  (`GuardedWallet.savings`), serves its chain data and relays its spends, and scans it on every block and every two
  minutes. A spend after the first scan raises a durable `savings_moved` notice to the paired phone and every alert
  contact (a tripwire: an honest guardian says Savings moved; a compromised one stays silent). One outflow, one alert: a
  later spend of the same coins is a replacement (RBF); paying out the same (a fee bump) it is only logged
  (`savings_replaced`), paying out something else it is announced again, naming the spend it replaced. Turning the watch off, or
  swapping it for another Savings wallet, is announced to the phone and every contact the same way (`savings_unwatched`);
  the phone, which did not ask for it, registers Savings again at its next sync. **Every transaction counts, not the
  newest few:** a scan's history is cut to 200 entries, unconfirmed first, so someone holding two Savings keys could
  hide a spend behind 200 cheap unconfirmed payments into Savings (an external review found this up to 0.1.19). The
  tripwire now checks every transaction the server lists for a Savings address, each once (remembered in memory),
  first seen first checked, at most 500 reads per scan: a flood costs the guardian one read per transaction, spread over
  scans, and what arrives after a spend waits behind it. While transactions wait unchecked for 30 minutes, or reading
  Savings keeps failing that long, the phone and every contact get `savings_unchecked` (at most daily) rather than
  silence; the first scan records history only once it has checked everything. A Savings spend relayed through
  `tx.broadcast` stays in view until the engine has recorded it. It refuses to watch any
  wallet it could sign for (the guarded, watched or a retired key set, or one holding key 3). A rotation carries the
  record to the adopted wallet; retirement and reset drop it. The web UI shows a "Savings (watched)" card.
- **Backup and recovery.** The backup is version 2 only when Savings exists (`savings`: descriptor, wallet id, the two
  devices' records, the send log; no key); an older app refuses it instead of restoring half a wallet. Lost phone with a
  backup: restore key 2 (it holds the account-1' key). Lost phone, no backup: after the guardian's recovery of Spending,
  the new phone reads Savings' descriptor from the guardian (`savings.get`, or the person pastes the copy they kept), checks
  it holds the hardware wallet's account-1' key, and the hardware wallet + Recovery Key move everything to a new Savings
  with the new phone's key. Lost hardware wallet and seed words: phone + Recovery Key move it to the wallet's new hardware
  wallet. Lost Recovery Key: phone + hardware wallet move it to a new second hardware wallet. Each is one transaction, at
  once (`TrikeyWallet.replaceSavingsKey`).
- **Limit off.** The "Turn off the daily limit?" screen and Home recommend Savings when the limit is off; never required
  (owner's answer 6).
- **Mainnet.** Like the guardian mode's other options (no daily limit, contacts can lock, silent payments), Savings is
  offered wherever the guardian mode is, mainnet included behind its pre-alpha warning: it uses the same script and the
  same signing paths as Spending (checked by Bitcoin Core's verifier in `packages/core/test/savings.test.ts`) and needs
  nothing new from the devices but a second registration. Recovery Key mode stays on test networks for what is its own
  (the timelocked refill chain, the public chain server), none of which Savings uses.
- **What it does not solve** (design note, section 6): the phone and the hardware wallet together still take everything;
  coercion; Spending is as exposed as before; no restriction on where Savings can go; every transfer links the two wallets
  on chain, and the guardian and the alert contacts learn of every Savings move.

## Guardian for family

Someone who runs a guardian (the **host**) can hold key 3 for a person they know (the **guest**), who keeps key 1 (their
own hardware wallet) and key 2 (their own phone). Phases 1 and 2 are built; the design, the owner's decisions and what
is left are in docs/design/family-hosting.md.

- **The host's own wallet is untouched.** Each hosted wallet is a slot with its own policy engine (`apps/guardian/src/hosting/`)
  under `hosted/<slotId>/`, next to `guardian-state.json`, which keeps its version-2 format byte for byte (a golden test
  pins it). A guardian with no guests has no `hosting.json` and runs every host code path as before.
- **Invite-only:** the host makes a single-use invite in the web UI (24 hours, a 32-byte secret kept only as its hash, at
  most 4 pending and 8 hosted wallets). The guest's phone accepts it with `hosted.prepare` / `hosted.pair` after an
  "I understand" checkbox under the disclosure below.
- **A separate key per hosted wallet:** `trikey/key3-hosted/v1`, from the host's seed, a fresh slot id and the guest
  phone's contribution (required); the guest only ever gets its account pubkey.
- **Privacy (BIP 89 only, decision 1):** the guardian knows the guest's three account pubkeys, never a chaincode,
  descriptor, address or balance. Key 3 sits in the guest's descriptor as a depth-0 xpub over that account pubkey and a
  chaincode the phone picks (decision 11). The wallet id is the key-set id. What the host does learn: every payment it
  co-signs (amount and recipient), the total of a recovery, and the guest's contacts' nostr keys.
- **The daily limit without addresses:** inputs and change are proven by the PSBT's tweaks; "change only within reach of
  a scan" cannot be checked without learning addresses, so every co-signed change coin goes into the slot's ledger, which
  a recovery must sweep (or name in `abandon`), and a phone key backup is required for guests (decision 2).
- **Recovery:** the guest's phone (or a new phone the hardware wallet lets in with `hosted.access`) builds the sweep from
  its own chain data and, without a backup, from the encrypted, write-once wallet map the host stores but cannot read.
- **Chain data:** never from the host (it would learn every address): the guest's own server, else a public Esplora,
  with a second server asked before a recovery sweep (decision 4).
- **The trust involved:** a dishonest host, or anyone who controls the host's box, together with someone holding the
  guest's phone or hardware wallet, can skip the limit, the delay and the alerts. The invite screen says so, word for
  word, and needs the checkbox.
- **Mainnet:** allowed (decision 5), behind the same pre-alpha / not-audited consent as guardian mode on mainnet.
- **The host:** sees guests' names, states, recovery dates and a weekly co-signature count, never an amount; cannot
  reset while hosting; stops with 30 days' notice (`hosting_ending`) or at once behind a typed confirmation.
- **Guests' own controls (phase 2):** limit off with the owner's rule and text; the contact lock per slot: a guest
  contact's `LOCK`, or the guest's own `guardian.lock`, **pauses** only that guest's wallet (never the host's box), and
  only the guest's hardware wallet resumes it; a host contact's `LOCK` still locks the whole box. A guest leaves with
  Replace guardian, which then releases its slot, or by releasing an empty wallet; the guardian refuses while a coin it
  co-signed is unspent.
- **Later:** extra alert channels for guests; the host's view of a guest's recovery code; shared mode (the full
  descriptor, opt-in); two hosts sharing the key 3 role (another script, a separate design).

## Coin control (decided 2026-11-05, built)

The owner asked for UTXO management. Built after several wallets phase 2, since both change coin selection and Send;
one wallet at a time, Spending and Savings alike, for every wallet of the phone.

- **Coin list** per wallet (`TrikeyWallet.coins('main' | 'savings')`, `coins.ts`; the app's `app/coins/`): amount,
  confirmations, the payment it came from (a payment this phone made, with recipient and amount; a payment received;
  change of a payment made elsewhere), unconfirmed coins marked, and a label the owner sets. The phone's own pending spends
  (`own-spends.ts`) are applied again, so a coin they spend is never listed, whatever the sync says; their change is.
- **Freeze:** a frozen coin is skipped by automatic selection, Send max and Consolidate, and a manual pick of it is refused
  (`coin_unavailable`): the owner unfreezes it first. When the rest is not enough, the error says what the frozen coins hold.
  A coin frozen after a quote makes that quote stale.
- **One way to the coins.** Every quote reads its coins through one helper (`spendable`): `quoteSend`, `quoteSendMax`,
  the send-max check before sending, both silent payment branches, and Savings' send and send max. `selectCoins` and
  `selectAllCoins` are unchanged but for `useAll`. Speed-ups reuse the original's coins, as RBF must.
- **Pick coins on Send** (`SendRequest.coins`, `SavingsSendRequest.coins`; `app/send/coins.tsx`): every coin picked is
  spent (core `buildSpend({ useAll })`), the rest back as change; Send max of a pick sends those coins. The quote carries
  `mixesLabels` when the coins have different labels, and Review warns that spending them together links them on chain.
- **Consolidate** (`quoteConsolidate` / `consolidate`, `quoteSavingsConsolidate` → `sendFromSavings`;
  `app/coins/consolidate.tsx`): the coins chosen (default every confirmed coin not frozen; the app offers "all small
  coins", under 100,000 sats) into one output at the wallet's next change address, at the slow speed by default. The app
  says whether fees are low now (the slow estimate at most 3 sat/vB). A 2-of-3 P2WSH input is about 105 vB (P2WPKH about
  68 vB), so this matters more here than in a single-key wallet. In the send log it is `purpose: 'consolidate'`; the
  history and Activity show only the fee as leaving.

Owner's decisions, and how they are built:
1. **Labels and freezes live on the phone and in its backup**, with export and import in BIP 329 (`labels-bip329.ts`):
   a coin label is an `output` record, a freeze `spendable: false`, a payment label a `tx` record, each with the wallet's
   `origin`; records of another wallet are left out of an import, records Trikey does not use are kept for the next export.
   One store per phone (`labels-store.ts`, `<storageKey>.labels`, keyed by wallet id), owned by the `WalletSet` and handed
   to every wallet; removing a wallet forgets its labels. Not synced to the guardian (unless the owner turns on an
   encrypted copy there: "Notes that survive recovery" below). The backup carries the whole document
   (`labels`): a backup with coin control (labels, or a consolidation in a send log) is **version 6**, so an older app
   says "update the app" instead of restoring without them; every other backup keeps its version byte for byte. The app
   says when labels changed after the last backup. Export and import go through the share sheet and the file picker
   (Settings > Wallet details).
2. **A consolidation counts against the daily limit only by its fee**: its one output pays the wallet's next change
   address with its BIP 32 derivation, which the guardian already treats as change (within `CHANGE_WINDOW` of the chain's
   highest used index). No rule change: `apps/guardian/test/consolidation.test.ts` pins it, and the regtest e2e checks a
   consolidation the app built.
3. **Coin control covers Savings too.** A Savings consolidation is signed by two of Savings' keys. The guardian, which
   watches every Savings coin, sees that nothing was paid out and says "Savings consolidated", with the fee, to the phone
   and every alert contact (its notification title too), instead of "Money moved out of Savings". The protocol alert is
   unchanged, so older phones read it as before.

**Follow-ups (built 2026-11-05):**
- **Address labels.** Receive (Spending and Savings) labels the address about to be shared (`setAddressLabel`): a BIP 329
  `addr` record, kept with the records an older app keeps as read, so the store's document and the backup keep their
  shape (an older app keeps and exports them). A coin without a label of its own shows its address's (`labelFromAddress`;
  the coin list works out each coin's address only when the wallet has an address label). Imported `addr` records work
  the same way.
- **Labels in Activity.** A payment's label (set on it, or the send log's note) ends its Activity row and shows in its
  details; a received payment without one shows its coins' labels (their own, or their address's while the coin is
  unspent: the guardian's history does not say which address a spent coin sat at).
- **Frozen coins and "Move everything".** `WalletSet.moveFunds({ includeFrozen })` (`SendRequest.includeFrozen`) takes
  the frozen coins too, when the owner asks by name ("Include 1 frozen coin (3,000 sats)", off by default), so a wallet
  holding frozen coins can be emptied and removed without unfreezing them one by one. Every other quote still leaves them.

Later: coin control in Recovery Key mode.

## Notes that survive recovery (decided 2026-11-05, built)

Labels live on the phone and in its backup. When both are lost, a recovery through the guardian (Delay & Notify with the
hardware wallet on a new phone) brings the money back but not the labels. The owner's decision: an **encrypted copy of
the labels on the guardian**, off by default, a Settings option (Wallet details, "Keep your notes safe with the
guardian"). Protocol: PROTOCOL.md, "Encrypted notes".

- **Per wallet.** Each wallet of the phone has its own copy, under its wallet id, encrypted with a key only **that
  wallet's hardware wallet** can make again. A copy carries the wallet's labels, its Savings' (now and before), those of
  wallets it replaced and those brought back from an earlier copy, with the send log's payment notes.
- **The key.** The hardware wallet BIP 137-signs `Trikey labels key v1 wallet=<walletId> network=<network>` (one line:
  Trikey's Ledger and Trezor signers take printable ASCII only) with the authorization key it signs approvals with
  (docs/design/hardware-auth-path.md); key = HKDF-SHA256(`r || s` of the signature, salt = wallet id,
  info = `trikey/labels/v1`), 32 bytes to encrypt and 32 for a key check. `r || s` rather than the 65 signature bytes,
  with `s` in its low form, so a firmware that writes another header byte still makes the same key. The guardian knows
  every xpub, so nothing public goes in. The phone keeps the derived key in its secure store (no biometrics: uploads run
  in the background); it is not in the backup, so a restored phone turns the option on again.
- **Deterministic signatures, checked.** It only works if the device signs the same text the same way on another phone.
  Ledger's Bitcoin app signs messages with RFC 6979 (`crypto_ecdsa_sign_sha256_hash_with_key`, `CX_RND_RFC6979`);
  Trezor signs with RFC 6979 too (`ecdsa_sign_digest` with `USE_RFC6979`, or libsecp256k1's RFC 6979 nonce function
  with a deterministic retry counter); a Jade over Bluetooth signs with RFC 6979 when no anti-exfil host commitment is
  sent, and Trikey never sends one (`wallet_sign_message_hash`, docs/design/hardware-auth-path.md §9); Coldcard Q, Jade (QR mode, never anti-exfil), Keystone 3, Passport Prime and
  Specter DIY sign with RFC 6979 too, over a text QR, a Coldcard Mk4 or Q over NFC (the same firmware code), and Passport gen 2 and Krux from a microSD file (two files when
  the option is turned on, which the phone then asks the owner to delete: the signature in them is the key, "Cleaning up
  the card"): read from the firmware sources, not tested on devices. The QR models that cannot sign a
  text (SeedSigner, the Coldcard Mk4 by QR, "Other") are not offered the option ("Hardware wallets by feature"). **The phone verifies it**: turning the option on asks for the
  signature twice and refuses, in plain words, when the two differ (`hardware_not_deterministic`).
- **The blob.** Version byte, 24-byte nonce, 16-byte key check (HMAC of a constant under the check key: a wrong key is
  told apart before decrypting), then XChaCha20-Poly1305 over the plaintext padded to 4, 8, 16 ... 512 KiB, the header
  and the wallet id as associated data (`packages/wallet/src/labels-crypto.ts`, with vectors).
- **On the guardian** (`apps/guardian/src/labels.ts`): `labels/<walletId>.json`, the newest three versions (one within
  10 minutes of the newest replaces it), at most 512 KiB plus overhead each and 30 uploads per wallet per hour, sent in
  parts of 24 KiB (a gift wrap carries about 40 kB). `labels.put` and `labels.delete` from the paired phone only;
  `labels.get` and `labels.list` also from a phone with recovery access. A wallet reads the copies of its line: its
  own and those of the wallets a recovery swept into it. Retiring a wallet, a recovery to another guardian and a reset
  delete its copies. Not announced on the alert channels; the web UI's Activity shows "Encrypted notes updated" at most
  once a day per wallet.
- **On the phone.** On: two device confirmations, then the copy is sent; after every label change it goes again 30 s
  after the last edit, and when the app comes back to the front if it is still pending; unchanged notes are not sent.
  A copy the guardian already holds for the wallet (another phone's) is merged in first. Off: the guardian deletes every
  copy of the wallet's line, the labels stay on the phone.
- **Bring back your notes.** After a recovery to a new phone (the recovery's last screen), or a restore from a backup
  (Wallet details) whenever the guardian holds a copy this phone does not keep: one device signature, the newest version
  that opens is merged into the phone's labels. **Merge rule: the phone's labels win.** A coin's mark (label and freeze
  together), a payment note, an address label already on the phone stays as it is; only what it lacks is taken. So a
  backup's labels win over the guardian's copy, which fills in what changed after the backup. The labels brought back
  are carried in the wallet's later copies and backups.
- **Older guardians and phones.** The option is offered only by a guardian that lists `labels_backup`; an older phone
  never calls the methods. Never for a wallet hosted on someone else's guardian (guests): the host's guardian refuses
  `labels.*` to guests and does not list the feature to them (later, in the guest's slot, same scheme).
- **Not yet:** the app shows no history of a wallet a recovery swept (its coins were all moved), so the old wallet's
  notes come back into the labels, the backup and later copies, but are not shown on that phone yet.

## Unlocking the guardian with the hardware wallet (decided 2026-11-05, built)

Open question 1. The guardian starts locked after every restart; until now only the passphrase unlocked it, in the web
UI or typed on the phone. The owner's choice: let the hardware wallet do it too, **opt-in, off by default, per own
wallet, Ledger and Trezor only**, the passphrase always kept. Protocol: PROTOCOL.md, "Unlocking with the hardware
wallet"; code: `apps/guardian/src/unlock-slots.ts`, `TrikeyWallet.enableHardwareUnlock` / `unlockGuardianWithHardware`.

- **The same trick as the notes, not a device API.** Ledger has no symmetric-key API, and Trezor's CipherKeyValue
  (SLIP-11) would have served one brand only, so neither is used. The hardware wallet BIP 137-signs, with the
  authorization key it signs approvals with (docs/design/hardware-auth-path.md), one line:
  `Trikey unlock key v1 wallet=<walletId> guardian=<guardian nostr pubkey> network=<network> slot=<slot id>`.
  Ledger and Trezor sign deterministically (RFC 6979; "Notes that survive recovery" has the firmware references), so
  the device signs that text the same way at every unlock. Turning the option on asks for it twice and refuses when the
  two differ (`hardware_not_deterministic`). The key material is `r || s` (low `s`, header byte dropped) through
  HKDF-SHA256, `info = trikey/guardian-unlock/v1`, with a random salt kept on the guardian; the helpers are shared with
  the notes (`@trikey/core` `signatureKeyMaterial`, `sameSignature`, `keyFromSignature`).
- **The guardian checks the signature first.** Unlike the notes key, this key is for the guardian, so the phone sends
  the signature itself (once, over the encrypted RPC) and the guardian verifies it against the wallet's authorization
  key before it derives anything, both when a slot is added and at every unlock. That is what keeps a phone alone from
  adding a slot of its own (it could otherwise unlock after the owner, or an alert contact, locked the guardian). The
  guardian rebuilds the text itself and never takes text from the phone.
- **Unlock slots beside the keystore, not inside it.** Each slot (`unlock-slots.json`) is the 64-byte setup seed
  encrypted with XChaCha20-Poly1305 under the slot's key, with a 16-byte key check (a wrong signature is told apart
  before decrypting, as in the notes blob) and associated data binding the keystore (key 3's account pubkey and its
  `createdAt`), the wallet, the slot id, when it was added, its salt and check. The opened seed is checked against the
  keystore's public key like a passphrase unlock. `keystore.json` is never touched: nothing to migrate, an existing
  passphrase-only guardian loads and unlocks exactly as before, an older guardian on the same data directory ignores
  the file, and nothing here can lose the passphrase path. (docs/design/passkey-unlock.md's keystore version 2, a data
  key with slots, remains the way for passkeys; this needed no data key: the slots wrap the seed itself.) The signature
  and the derived keys live for one request and are zeroed; nothing secret is written or logged.
- **The phone does not keep the key** (the owner's question, decided: it does not). With the key in the phone's secure
  store, a phone unlocked by a thief (or a biometric bypass) would unlock the guardian at will, undoing the very locks
  that exist for a stolen phone: the owner's remote lock, an alert contact's `LOCK` (rule 8), the restart a power cut
  causes. Every unlock therefore needs the hardware wallet, one confirmation. The convenience lost is small (an unlock
  happens after a restart, rarely), and the passphrase is still there when the device is not.
- **One slot per own wallet** (docs/design/multi-wallet.md): any of them, with its own hardware wallet, unlocks the
  whole box (key 3's seed is one seed). Turning it on again replaces the wallet's slot (a new slot id), so every
  earlier signature stops working. Since a wallet can be added only with the first wallet's hardware wallet
  (`add_wallet_approval`), a phone alone cannot plant a wallet and a slot of its own; a slot turned on for any wallet is
  announced to the owner's channels and to the first wallet's alert contacts (and that wallet's), and the web page lists
  every slot and turns any of them off (Settings > Wallets and hardware unlock).
- **Same throttle and refusals as the passphrase from the phone.** A signature that does not open the slot counts as a
  wrong passphrase; 5 failures in a row of either kind stop the phone until the web UI unlocks; a recovery the phone
  did not start refuses it. Asking with a slot id that is gone (turned off or replaced) is not a guess and is not
  counted. The web UI keeps the passphrase only.
- **Lifecycle.** The passphrase can never be removed. Off (`unlock.hardware.remove`) deletes the slot. Retiring a wallet,
  a recovery that leaves the guardian, and a recovery's rotation delete the swept wallet's slot (the adopted wallet turns
  it on again with its own hardware wallet, once confirmed with `hardware.confirm`: a lost or stolen device must not
  keep unlocking); a slot of a wallet the box no longer guards is also dropped at start. A reset deletes every slot
  before it replaces key 3 (they hold the old seed), and a slots file bound to another keystore is dropped. A passphrase
  change needs nothing: the slots do not depend on the passphrase, and the change keeps the keystore's `createdAt`
  they are bound to ("Changing the passphrase"). Family hosting: never; a guest's
  hardware wallet must not unlock the host's guardian, so guests cannot call the methods and are not told the feature.
- **QR devices: only the models that sign a text by QR.** Coldcard Q, Jade, Keystone 3, Passport Prime and Specter DIY
  sign the unlock text over a text QR (two round trips when it is turned on, one per unlock); a Coldcard Mk4 or Q over NFC
  does it with two taps per unlock (send the text, read the signature); a Jade over Bluetooth with its PIN and one
  confirmation per unlock (the PIN goes through its PIN server, "Jade over Bluetooth"). SeedSigner, "Other" and the Coldcard Mk4 by
  QR do not (as for the notes), so there is no signature to unlock with; the app says so and keeps the
  passphrase. Passport gen 2 and Krux sign texts only from a microSD card: a card round trip after every restart is too
  clunky, so the option is hidden for them, with one sentence saying why and that the passphrase works.
- **Seen and said.** The web UI's Activity: "Hardware unlock turned on / off", "Unlocked with the hardware wallet" and
  failed attempts, never the signature. Offered only by a guardian that lists `hardware_unlock`; an older phone never
  calls it. The app: Settings > Guardian, "Unlock with your <device>" (a switch), and on the locked guardian the same
  button above the passphrase field.

## Sealed unlock (decided 2026-11-06, built)

A follow-up from the hardware unlock's review (threat model, "The guardian's disk plus archived gift wraps"). Protocol:
PROTOCOL.md, "Sealed unlock"; code: `packages/protocol/src/sealed-unlock.ts`, `Guardian.unlockSealed` and
`addHardwareUnlock`, `TrikeyWallet.sendUnlock` and `sendHardwareUnlockAdd`.

- **One sealing key at a time, in memory only.** The guardian makes a secp256k1 key pair when it starts (locked), at
  every lock (web UI, `guardian.lock`, a contact's `LOCK`), at every unlock, and after every `guardian.unlock` or
  `unlock.hardware.add` whose seal was made to it, whatever became of that request (a success, a counted failure, a seal
  that opened but had expired, or a refusal: `recovery_pending`, `phone_unlock_disabled`, `rate_limited`,
  `hardware_unlock_off`, an add while locked), and zeroes it at stop. The key a locked
  guardian showed is zeroed the moment it unlocks; a new one serves the add, the only request that carries such a secret
  while unlocked. It never touches the disk or the log (a test scans the data directory). There is no auto-lock to hook;
  a later one would rotate through `lock()` like the others.
- **One key for both, bound to its purpose.** `guardian.status.unlockKey` is shown locked and unlocked, and each seal
  names the method it is for (`for`), so an add's seal can never be taken for an unlock or the reverse (a test sends
  each as the other). Two keys, one per state, would add a status field and buy nothing: in each state only one of the
  two requests is accepted anyway.
- **Rotation after every use and every failed try, no time limit.** A failed unlock is often a near-miss of the
  passphrase; replacing the key after it means even someone who reads the guardian's memory later cannot open that
  seal. The same for every seal made to the key held now that the guardian then refuses without counting (it had
  expired, the phone was rate limited or stopped, a recovery it did not start is running, the hardware unlock is off, an
  add arrived while locked): such a seal usually holds the right secret, and left in memory the key would open it for
  whoever images the box later with the archived wrap (an external review found the key kept in those cases up to
  0.1.19). The refusals that need no secret are checked before the seal is decrypted at all. It costs nothing: the phone reads `guardian.status` before every unlock and add anyway. A timer was not added:
  the key never reaches the disk, so its age adds nothing to the disk-plus-archive attack; a reader of the live memory
  would see the next unlock or add whatever the key's age; and a timer would only turn into stale-key retries for a
  phone that read the key a while ago.
- **NIP-44 v2, no new crypto.** The phone seals from a one-time key with the transport's own primitive (and its padding,
  which hides the passphrase's length to a bucket). NIP-44 takes no associated data, so the purpose, the guardian's nostr
  pubkey, the sealing key, the sending phone, the request id and an expiry are inside the encrypted, MACed plaintext, and
  the guardian compares all of them before it tries the secret. The channel that carries `unlockKey` is already the
  guardian's signed gift wrap; the binding is belt and braces.
- **Stale is not a guess.** A seal to a key the guardian no longer holds (a restart, a lock or unlock, a replaced key)
  is `unlock_key_stale`, not counted, never decrypted and changing nothing (so replaying old seals cannot burn the live
  key); one to the current key past its expiry is `unlock_key_stale` too, not counted, but the key is replaced, and the phone reads the new key and sends
  once more by itself (for the hardware wallet, without asking the device again). An unlock's seal to the current key that
  does not open, or names another purpose, guardian, phone or request, counts as a wrong passphrase: only the paired
  phone's own wraps reach the handler, a relay can neither forge the phone's seal nor replay a request (replay guard,
  `1501` after a restart, and a replayed seal is stale anyway), so no third party can burn the owner's tries, and the
  phone itself already could with wrong passphrases.
- **The add's failures are the add's.** A sealed add that does not open, or whose `walletId` and `slot` are not the
  request's, is `1202` `sealed_unlock_invalid`, unthrottled like a plaintext add's wrong signature: the guardian is
  unlocked then, so there is no seed to guess at, and the key is used up either way.
- **Compatible both ways.** A guardian with `sealed_unlock` still accepts an older phone's plaintext unlock and add,
  logs `guardian.unlock_unsealed` and adds "sent it unsealed (an older Trikey app): update the app" to the Activity line;
  not refused, because the passphrase is how the owner gets back in after a restart. A newer phone seals whenever the
  guardian lists the feature and sends in the clear only to a guardian without it, which answers `sealed` `-32602`.

## Changing the passphrase (decided 2026-11-06, built)

Until now the passphrase chosen at setup could never change, so one typed into an app before sealed unlock, read over
someone's shoulder or kept in a password manager that leaked stayed good for the life of the box. The owner can now
change it, **in the web UI only** (Settings, Passphrase). Code: `keystore.ts` `changeKeystorePassphrase`,
`Guardian.changePassphrase`, `POST /api/passphrase` (apps/guardian-web/API.md), the page `apps/guardian-web/src/pages/passphrase.tsx`;
protocol: PROTOCOL.md, "Changing the passphrase" (a feature and an alert, no method).

- **The same key 3, encrypted again.** The guardian opens `keystore.json` with the current passphrase, checks the seed
  gives the key on file and is the very seed it holds unlocked, seals it again under the new passphrase with a **fresh
  Argon2id salt and a fresh nonce** (and today's KDF parameters, so an old keystore gets them too), opens the new file
  with the new passphrase and compares the seed, and only then replaces `keystore.json` with one atomic rename
  (`writeFileAtomic`: a temp file in the same directory, fsync, rename, fsync of the directory). A crash leaves the old
  file or the new one, never neither and never half of one (a test simulates a crash between the fsync and the rename).
  Nothing else is written: key 3, its public data, the wallets, the rules, the relays and the nostr identity stay as
  they are. A new key 3 is a reset, not a passphrase change.
- **The unlock slots keep working because `createdAt` is kept.** A hardware unlock slot is bound to the keystore by key
  3's account pubkey and the keystore's `createdAt` ("Unlocking the guardian with the hardware wallet"). The change keeps
  both, so `unlock-slots.json` is not touched and every slot still opens to the same seed, before and after a restart.
  The alternative, a new `createdAt` and every slot re-bound in the same step, would write two files that cannot be
  replaced together: a crash between them would leave a slots file bound to "another keystore", which the next start
  drops, silently turning the owner's hardware unlock off. `createdAt` now reads as "when this key 3 was made", which is
  what it always meant to the slots; a reset still changes it (and key 3).
- **Only while unlocked, the current passphrase through the unlock's throttle.** The page is behind a web session
  already, but a session is not the passphrase (a browser left signed in), so the current passphrase is asked again and
  counted by the web unlock's throttle exactly as a wrong unlock is (persisted, backoff after 3 failures); a wrong one is
  logged ("Passphrase change refused"). The new passphrase follows setup's rule, at least 12 characters after NFKC (the
  page and the guardian share it, a test holds them to the same answers), and must differ from the current one. Locked,
  the change is refused: unlock first.
- **Sessions.** The passphrase also signs browsers in, so every web session made with the old one ends; the browser that
  changed it gets a fresh session cookie in the same answer (its old token ends too). Anyone else signs in again with the
  new passphrase.
- **Seen and said.** Activity: "Passphrase changed" (and that other browsers were signed out); the paired phone gets a
  `passphrase_changed` alert and shows a security line ("Guardian passphrase changed … if that wasn't you, lock the
  guardian and use Replace guardian"); the owner's own email, ntfy, webhook and Telegram channels get the same words,
  like the other changes made in the web UI (relays, alert channels, chain source). Alert contacts are not told: the
  passphrase is the owner's box credential, not a wallet rule. Neither passphrase is logged, stored outside the keystore
  or kept by the page after the request (tests scan the log, the data directory and the Activity).
- **What the page says afterwards.** The old passphrase no longer unlocks the guardian or signs in; every copy of it
  (a password manager, paper, one typed into an app older than 0.1.17, which sent it unsealed) is worthless against the
  running box. The recovery does not use the passphrase: the recovery code and backup file restore key 2, the recovery
  sheet lets a new phone reach the guardian with the hardware wallet, and Replace guardian needs only the phone and the
  hardware wallet ("Recovery flows"); none of them is printed again. (The guardian itself still needs the new passphrase,
  or the hardware unlock, to co-sign anything after a restart, a recovery's sweep included.)
- **Backups hold the old passphrase's keystore.** Key 3 does not change, so any copy of the data directory made before
  the change opens with the old passphrase and gives the same key 3: a copied Docker volume or data folder
  (packaging/compose, "Moving to another computer"), a NAS snapshot, an image of the box's disk, and an Umbrel backup
  made by 0.1.21-alpha or earlier. Later Umbrel backups and every StartOS backup leave the guardian out ("The
  platforms' backups leave the guardian out"). The page says so: delete
  such copies, or keep them as safe as the old passphrase. If the old passphrase **and** such a copy may both be in
  someone's hands, a passphrase change is not enough: key 3 has to change, which is "Replace guardian".
- **Not from the phone (decided).** The phone's Settings > Guardian says where to change it (when the guardian lists
  `passphrase_change`) and that the app cannot. Why not a phone path, even sealed (the `sealed_unlock` machinery would
  carry it) and approved by the hardware wallet:
  - *A phone thief who knows the passphrase* (watched it typed, or it is reused) could otherwise change it and so take
    the web UI from the owner: sign-in, unlock after a restart, and with it reset, relays and alert channels. A
    hardware approval would stop a thief with the phone alone; one with the phone and the hardware wallet already moves
    every coin (2 of 3), so the approval would make the path safe, not useful.
  - *The benefit is small.* The passphrase is the box's credential and is typed mostly on the box's own page, behind
    the platform's login on Umbrel and Start9; a change is rare and can wait until the owner is at that page. A phone
    path would add a method, a sealing purpose carrying two passphrases, a hardware text, its throttle and its older-app
    cases, for a convenience few would use.
  - *Every phone-side mistake stays harmless.* Without a method there is nothing a malicious relay, an archived wrap or
    malware on the phone can replay or provoke: the phone holds no passphrase and can only unlock with it.
- **What it does not do.** It does not rotate key 3, the nostr identity, the alert channels' key file or the hardware
  unlock slots (turn the hardware unlock off and on for a new slot); it does not reach guests (family hosting), whose
  keys derive from the same seed and are unaffected; and it does not change a copy of the data made earlier.

## Later: Taproot and threshold signatures (decided 2026-11-03: not now)

Today every Trikey spend is a visible 2-of-3 (`wsh(sortedmulti)`): anyone reading the chain sees a multisig, and two
signatures plus the script cost more than one key's signature. Two ways to fix that were weighed and left for later.

- **FROST (threshold Schnorr), not now.** A 2-of-3 FROST key spends like one ordinary Taproot key: private and cheap.
  But:
  - every signer, the hardware wallet included, has to run the FROST rounds. Ledger, Trezor, Coldcard and Jade do not;
    only FROST devices (Frostsnap) do;
  - key shares are not seeds and the wallet is no standard descriptor, so no other wallet could recover the money
    (against "every key is yours", and the exit through Sparrow or Nunchuk);
  - the signing is interactive and nonce mistakes leak keys; the standards are still settling, and Trikey is not audited;
  - it hides nothing from the guardian, which must read the whole transaction to enforce the limit.

  Revisit when major hardware wallets sign FROST and its BIPs are final.
- **A Taproot wallet type, later and opt-in.** Key path `musig(phone, guardian)`, so everyday payments look like one
  key and cost the least; script leaves for the pairs with the hardware wallet. MuSig2 runs only between the phone and
  the guardian, both our code. The blocker is the hardware wallet's side: Taproot multisig script paths, which Trezor
  does not sign and other devices have to be checked for. A choice next to the default, never a replacement while
  devices are missing. Revisit with the device list.

## Later: several wallets in one app (proposal)

Several wallets on one phone and one guardian, where only the hardware wallet changes: the same phone seed and key 3 seed at a BIP 48 account per wallet, one backup: docs/design/multi-wallet.md (proposal, not built; the owner's decisions of 2026-11-05 are in its section 10).

## Considered and not built: Bitkey hardware wallets as key 1 (2026-11-05)

Bitkey's hardware wallets were checked as Trikey's key 1, from Bitkey's open-source firmware and app.

- **W3 (the 2026 model with a screen): not possible.** Its firmware signs only for a keyset Bitkey's server (WSM)
  has signed, so it refuses any wallet Bitkey did not set up.
- **W1 (the first model, no screen): possible, not supported.** Its firmware derives keys and signs any hash over NFC,
  with no check by Bitkey's server. But it signs blind, and in Trikey the hardware wallet is what stops a compromised
  phone: a payment over the daily limit (or with the limit off) is the phone plus the hardware wallet, without the
  guardian. A device that cannot show what it signs gives no protection there. It would also need NFC on both
  platforms (on iOS, an Apple developer account with the NFC entitlement).
- **What could change it:** firmware that shows the outputs (or enforces a spending policy itself; W1 firmware has a
  dormant one), or a role where blind signing costs little. The only such role is a Savings **Recovery Key**, kept
  apart and used only for a recovery; a Ledger or Trezor already fills it better, so it is built only if owners ask.

## Considered and not built: Spark (spark.money) as a spending pocket (2026-11-06)

Spark is a statechain-style Bitcoin layer 2 by Lightspark: instant, near-free transfers, Lightning interop and
stablecoins (USDB from Brale). Considered only as a small, capped "spending pocket" next to the vault (top-ups as
ordinary Trikey payments within the daily limit), never for the vault. Decided: **not now** (the owner, 2026-11-06),
from Spark's own docs (docs.spark.money, read 2026-11-06) and its Apache-2.0 repo (github.com/buildonspark/spark):

- **One hot key.** The user side co-signs with the operators by FROST through a single-key signer (`SparkSigner`);
  "Does it support MPC/multisig? Not yet." No hardware wallet speaks it. A pocket would have no guardian, no limit and
  no hardware approval: the thing Trikey exists to avoid.
- **Beta.** "Still highly experimental. Expect bugs, rapid iteration, and breaking changes"; "start with small amounts".
- **The way out is not practical from a phone.** Unilateral exit is a beta CLI flow: Bitcoin Core v29, own UTXOs for
  fees, one session, broadcast root to leaves, leaves over about 16,348 sats, relative timelocks of 100+ blocks, and a
  watchtower against a prior owner publishing an old branch.
- **Trust in a few companies.** Operators are Lightspark, Flashnet and Breez; safety rests on at least one deleting its
  key share at each transfer ("moment-in-time" trust), and Lightspark provides deposit/withdrawal liquidity.
- **Privacy off by default** (balances and transfer history publicly queryable until `setPrivacyEnabled(true)`; token
  activity always public), and **stablecoins can be frozen** by their issuer through the operators' freeze lists.
- 0-conf deposits are gated (partner access).

**Revisit when** Spark supports multisig or an external signer a hardware wallet can drive, and its exit is
production-ready. If a pocket is built then: capped, privacy on from the start, the screen naming the different trust,
and the guardian as the pocket's watchtower (Spark's watchtower "holds no toxic data").

## Open questions

1. **How the hardware wallet unlocks the guardian.** Built, opt-in ("Unlocking the guardian with the hardware wallet"): Ledger and Trezor BIP 137-sign a fixed unlock text deterministically, and the guardian, after checking the signature against the wallet's authorization key, derives an unlock slot's key from it, as the notes do. Trezor's CipherKeyValue (SLIP-11) was not needed, and Ledger needs no symmetric-key API. Still open: checking on real devices (firmware versions) that two signatures of the same text are equal, which the app checks each time the option is turned on; QR devices that sign a text by QR (Coldcard Q, Jade, Keystone 3, Passport Prime, Specter DIY) do it over two QR round trips, a Coldcard Mk4 or Q over NFC with taps; the others, including Passport gen 2 and Krux (microSD only), keep the passphrase. Rule changes use BIP137 message signatures too (see rule 4); which signing paths each device allows still has to be tested on real hardware.
2. **Notifications when the phone app is asleep.**
   - Nostr DMs reach the user's regular nostr app (zero infrastructure).
   - Real push on iOS needs Apple's push service, called with credentials only the app's publisher holds. That means running a stateless "empty ping" bridge, which conflicts with "we run nothing".
   - Built: the guardian also sends its alerts by email through the user's own account, ntfy, webhook and Telegram
     (docs/design/notifications.md); an ntfy app on the phone gives real push without anyone running a bridge.
3. **Defaults:** daily limit, delay (7 days?), relays.
4. **Start9 packaging details** (SDK version), and how the official Umbrel store submission works.

## Repository state

- `packages/core/`: descriptors (BIP380 checksum, BIP389 multipath), BIP48 wallets, PSBT build, sign, analyze and finalize, software signer. `tweak.ts` holds the BIP 89 tweak math family hosting uses; `keySetId` names a hosted wallet.
- `packages/protocol/`: the nostr RPC (schemas, gift-wrap transport with per-peer NIP-44 conversation key caching, replay guard, client and server, pairing and recovery URIs, NIP-06 phone identity, an in-memory relay for tests). Spec in `PROTOCOL.md`.
- `packages/wallet/`: the phone's side (key 2, pairing, payments, rules, recovery, backup, labels and their encrypted copy on the guardian), platform-agnostic; the app supplies storage and hardware adapters. It finishes a recovery (switching to the adopted wallet after checking it, then `confirmHardware()`), replaces the guardian (pair the new one, sweep, retire the old wallet, sweep stray coins later), locks the guardian remotely, parses every Trikey QR (`parseScannedCode`), and keeps a send log that travels in the backup. Chain data comes from the guardian.
- `apps/guardian/`: the guardian. `src/policy/` is the policy engine (spend checks, daily limit, rule changes with BIP137 approvals, Delay & Notify, wallet rotation with one active wallet plus retired ones, state format version 2 with migration from version 1). Around it: key storage (Argon2id, m=64 MiB, t=3, then XChaCha20-Poly1305), unlock slots for the hardware wallet (`unlock-slots.ts`), lock/unlock (also from the phone), passphrase change (web UI only), reset, the nostr RPC server and NIP-17 alert DMs behind one shared inbox, email, ntfy, webhook and Telegram alerts (`src/notify/`), an Electrum client (sweep completeness, broadcast, chain time) and the HTTP API for the web UI. `src/hosting/` hosts guests' wallets (family hosting): the slot registry and invites, one engine per hosted wallet, routing by sender, guests' alerts and recoveries. Entry point `src/main.ts`.
- `apps/guardian-web/`: the guardian's web UI, including the recovery code and the reset. Its API is in `API.md`.
- Savings (optional, docs/design/savings-and-limit-off.md): `SAVINGS_ACCOUNT` in core; `savings.*` in the protocol; the guardian's watch (`apps/guardian/src/savings.ts`); `TrikeyWallet.startSavings` ... `replaceSavingsKey` in `packages/wallet`; `apps/mobile/app/savings/`.
- `packages/recovery-key/`: Recovery Key mode (no home server): the printed Recovery Kit, the chain of BIP 68 timelocked refills and its scheduler, the single-key spending balance with CPFP, an Esplora client, and recovery with any two keys.
- `apps/mobile/`: the React Native app (Expo). Demo, regtest-simulator and real modes; guardian mode runs on `@trikey/wallet` with Ledger, Trezor and QR adapters, secure key storage and a recovery-code backup file. Recovery Key mode runs on `@trikey/recovery-key` (`src/data/rk-service.ts`), on test networks only. Android has two builds from the same code (`TRIKEY_ANDROID_VARIANT`, `apps/mobile/android-variant.js`), signed with one key but two apps with their own application id, launcher label and URL scheme (`app.trikey.wallet` "Trikey" and `app.trikey.wallet.foss` "Trikey FOSS", since 0.1.22; before, one id, so one replaced the other), so both can be installed side by side, each with its own wallet storage, and listed separately: the standard one, with Google's libraries (Google Sign-In for Google Drive backup, ML Kit for QR codes), and one without any Google code, which reads QR codes with zxing-cpp through the app's own camera module (`apps/mobile/modules/trikey-qr-camera`) and backs up with the recovery code and backup file only.
- `packaging/`: Docker image, Umbrel community app store entry, Start9 package skeleton.
- `site/`: trikey.app, hosted on Vercel, including the passkey association files.
- `tools/consensus-verify/`: Rust tool that checks transactions against libbitcoinconsensus (Bitcoin Core's script verifier). CI builds it, and the core and Recovery Key tests run every transaction shape through it.
- `design/`: the screen designs. `docs/`: earlier design pages (key 3 options, the refill design).

## MVP build order

1. **Guardian core** (TypeScript): nostr RPC, pairing, policy engine, Delay & Notify, lock/unlock, Electrs client. Integration tests against a local relay and libbitcoinconsensus.
2. **Packaging:** Docker image, then an Umbrel community app store entry, then a Start9 package.
3. **Mobile app:**
   - onboarding (hardware pairing, guardian pairing, backup);
   - home, send and receive;
   - recovery flows;
   - settings (limit, delay, contacts).
4. **Testnet and signet beta, tested by users in the wild:** the owner's friends first, then anyone. There is no budget
   for a paid security review (owner's decision, 2026-11-01): the code is open for anyone to review, and
   `docs/security/review-brief.md` is where a reviewer starts. Without a review, the app keeps saying "not audited, open source"
   wherever it offers mainnet, which it does in guardian mode only, behind a pre-alpha warning the person accepts, for
   use at their own risk with a small amount; Recovery Key mode stays on test networks.
