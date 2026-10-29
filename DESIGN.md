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
| Key 3 | Trikey Guardian on the user's Umbrel or Start9 (both in the MVP) | Bitkey's features with no third party |
| No home server | Recovery Key mode (below) | Same script; Bitcoin's timelock rules enforce the limit |
| Key 2 backup | Encrypted cloud backup, unlocked by passkey | The user picks the cloud. Losing the backup is survivable: see the recovery flows. |
| Optional extra | Timelocked heir/backstop path for miniscript-capable devices | Opt-in only, so the default stays universal |
| First client | React Native mobile app | Ledger Bluetooth and Trezor Connect have JS SDKs |
| UI kit | shadcn/ui: react-native-reusables + NativeWind in the app, shadcn/ui + Tailwind in the guardian web UI. Zinc neutrals, Geist type, light and dark themes. | One set of tokens and components across the phone and the home server |
| Transport | Nostr: NIP-44 encryption inside NIP-59 gift wraps | Outbound-only connections, no accounts, relays see ciphertext |
| Later | Guardian for family (invite-only hosting) | See the end of this document |

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
Hardware (key 1) ───┘   outbound only           └── alerts: nostr DMs to the user's devices and contacts
```

### Mobile app (React Native)
- **Key 2:** BIP39 seed, encrypted at rest with a key from the Secure Enclave or Android Keystore. Those chips can't hold secp256k1 keys directly, so they wrap the seed instead. Unlocking needs biometrics.
- **Hardware wallets:**
  - Ledger over Bluetooth (`@ledgerhq/device-signer-kit-bitcoin`);
  - Trezor via `@trezor/connect`;
  - air-gapped devices via PSBT QR (UR/BBQr).
- **Wallet registration** on devices that need it (Ledger, BitBox02, Jade, Coldcard), plus showing the first address on the device.
- **Cloud backup of key 2 + the descriptor:**
  - XChaCha20-Poly1305 under a random data key;
  - the data key is wrapped by a passkey PRF slot (WebAuthn L3, iOS 18+, Google Password Manager);
  - more unlock slots can be added later, such as a Recovery Code.

### Trikey Guardian (Docker container)
- **Packaging:** one image, shipped as an Umbrel app (`umbrel-app.yml`, depending on `bitcoin` + `electrs`) and a Start9 service package.
- **Chain data and broadcasting** go through the local node and Electrs. No public servers are used.
- **Web UI on the box:**
  - pairing QR;
  - status (locked or unlocked);
  - activity log;
  - current rules;
  - recoveries in progress.
- **Keeps key 3 only in memory.** On disk it is encrypted. After any restart the guardian is *locked* until the user unlocks it with:
  - **the hardware wallet:** a deterministic secret obtained over the phone. The mechanism is still open; see "Open questions".
  - **or a passphrase:** stretched with Argon2id.
  
  A stolen, unplugged box is useless.
- **Holds no backup of key 3.** If the box dies, phone + hardware sweep to a new wallet with a fresh guardian ("Replace guardian").

## Rules the guardian enforces

The rules follow Bitkey's own spend rules and recovery code (`server/src/api/mobile_pay/src/spend_rules`, `server/src/api/recovery`).

1. **Inputs belong to the wallet.** The guardian rebuilds every input script from the descriptor. It requires `nonWitnessUtxo` and checks it against the txid, which blocks the segwit v0 fee attack.
2. **One existing signature per input,** valid under `SIGHASH_ALL`.
   - **Phone signature:** the everyday path. It counts against the daily limit.
   - **Hardware signature:** only accepted as part of a recovery.
3. **Daily limit.** The guardian counts `Σinputs − Σchange` (the fee included) over a rolling 24 hours, keyed by outpoint:
   - a replayed transaction is never counted twice;
   - an RBF replacement counts as the larger of the old and new amounts;
   - **change is only change within reach of a scan:** an output counts as change only if it pays the wallet's own derived address at an index no more than 20 (the gap limit) past that chain's *high-water mark*, the highest index seen used on chain or co-signed. Anything further out counts as leaving the wallet. The marks are persisted, rise with every co-signed change output and with what `wallet.sync` finds (a payment to a fresh receive address), and every scan of the wallet (coverage before a recovery completes, `wallet.sync`, the broadcast relay check) reaches at least them, so no coin key 3 co-signed is ever out of sight;
   - **the window's clock is checked against the chain:** the guardian refuses to co-sign while the system clock is more than 3 hours ahead of the chain's median time past (`clock_ahead_of_chain`), and the time it counts the window with never goes backwards (persisted), so stepping the clock forward or back cannot open a fresh window.
4. **Loosening the rules needs the hardware wallet.** That covers raising the limit, shortening the delay, changing the sweep fee cap, and adding or removing alert contacts. The phone alone can only tighten: lower the limit or lengthen the delay, **also while a recovery runs** (tightening never helps a thief; a running recovery keeps the delay and fee cap it started with). On mainnet the rules must name at least one alert contact: a pairing without one, or any change that removes the last one, is refused even with a hardware approval; test networks allow it and report `warnings: ['no_alert_contacts']`.
   - **How the hardware wallet approves:** a BIP137 `signmessage` signature from a single-sig key recorded at pairing. Ledger, Trezor and Coldcard all support it. The signed text is one line that shows the new values in clear, so the user checks them on the device screen:
     `Trikey policy v1 wallet=<id> seq=<n> limit=<sats> delay=<d>d feecap=<sats> contacts=<k> hash=<policyHash> expires=<ISO8601Z>`
   - The guardian rebuilds this text from the request and never trusts text from the phone. The sequence number must increase (by at most 1000), and an approval is valid for at most 24 hours.
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

## Protocol (nostr)

- **Identity:**
  - The phone's nostr key is derived from the key 2 seed (NIP-06 path).
  - The guardian has its own key, shown in the pairing QR together with its relays.
- **Messages:** JSON-RPC rumors (kind 21420, in the ephemeral range) inside NIP-59 gift wraps (kind 1059), encrypted with NIP-44 to the guardian's pubkey. The full wire format is in [`packages/protocol/PROTOCOL.md`](packages/protocol/PROTOCOL.md).
- **Methods:**

  | Method | Purpose |
  |---|---|
  | `pair.prepare`, `pair` | Pair the phone with the guardian (one-time code from the guardian's web UI); `pair` can also name the wallet it replaces, with its descriptor, so the new guardian watches it |
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
  | `singlekey.register` | Register the phone's single-key coins (public data only): the helper coin's account (`m/84'/c'/1'` xpub) and coins by outpoint and script. Then `sign` accepts the helper input, `wallet.sync` with `wallet: 'helper'` serves them and `tx.broadcast` relays their sweeps into the vault |
  | `sp.register`, `sp.unregister` | Hand the guardian the silent payment scan key (with `B_spend`, labels and birth height) so it scans the node's blocks; take it back |
  | `sp.scan` | The payments the scanner found (`sp_received` alerts announce new ones) |
  | `guardian.unlock` | Unlock after a restart (refused after 5 failed tries in a row until the web UI unlocks, and while a recovery the phone did not start runs) |
  | `guardian.lock` | Lock the guardian remotely |
  | `guardian.status` | Read guardian state (with `warnings`, e.g. `no_alert_contacts`) |

- **Every request carries:**
  - an id, so retries are idempotent;
  - a NIP-40 expiry;
  - the hash of the PSBT it refers to.
- **Replay protection:** old rumors are dropped. Strangers (senders that are not the paired phone, an alert contact or a phone with recovery access) get their own small replay cache and seen-wrap set, so they cannot push a peer's entries out; refused `sign` / `recovery.start` / `recovery.update` are rate limited per sender, and repeated identical refusals are one log entry with a count.
- **Relays:** several, with the user's own relay optional (Umbrel has a Nostr Relay app).
- **No public standard exists** for PSBT exchange over nostr, so this is our own spec. Publish it as a NIP draft once it's stable.

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
| Guardian dies or is stolen | phone + hardware | "Replace guardian": sweep to a new wallet with a new guardian |
| Guardian replaced, old box still running | phone + hardware | Also retire the wallet on the old box; it then co-signs nothing for it |

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
- **What carries over:** the rules and the hardware approval counter. The limit window starts empty
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
identity, relays and passphrase. It needs the passphrase again and a typed confirmation, and is
refused while a recovery is pending or ready, or while a co-signed sweep waits to be broadcast (and
still can be: a sweep that never can is given up, see rule 5). It ends every web session. Key 3
is rotated rather than kept so that a reset can never be used to re-pair the user's wallet with a
different phone (see the threat model).

**Recovery code.** Besides the one-time pairing code, the web UI shows a permanent "Recover on a new
phone" code (`trikey://recover?...`): the guardian's npub, relays and network, no secret. It can be
printed and kept with the hardware wallet.

## Threat model

- **Stolen phone:** the thief can spend at most the daily limit. They can't raise it, because that needs the hardware wallet. A recovery they start triggers the alerts. They cannot hide the vault from a later recovery either: change past the gap limit counts against the limit (rule 3). They cannot starve the owner's unlock: the phone's `guardian.unlock` has its own throttle, stops after 5 failures until the web UI unlocks, and is refused while a recovery the phone did not start runs.
- **Alert contacts are what makes Delay & Notify work.** Without one, a recovery is announced only to the paired phone, which may be the thief's: a phone-only thief could then sweep the whole vault to a wallet of its own (keeping key 2, adding its own "hardware" key) and nobody would hear of it. So **on mainnet the guardian requires at least one alert contact**, at pairing and for every rule change. **A contact can be the user's own nostr app on another device** (a laptop, a tablet, a second phone): it only needs a nostr key that can receive NIP-17 DMs and reply `CANCEL <id>`. Test networks allow zero contacts and say so (`warnings: ['no_alert_contacts']` in `policy.get`, `guardian.status` and the web UI).
- **Contested recovery stalemate (by design).** A stolen phone can cancel every recovery the hardware wallet starts, and the hardware wallet can cancel every recovery the phone starts. Each contested cancel pauses phone payments until the hardware wallet resumes them. So if the phone is stolen and the user has **no backup of key 2**, the thief and the owner block each other: **the vault is frozen, not lost**. Nobody can take the funds (the thief holds one key, the owner one key, the guardian co-signs only within the rules), and the owner gets out by restoring key 2 from its backup (then phone + hardware spend directly, no guardian needed) or, failing that, by waiting the thief out. This is the price of letting any key holder cancel; the alternative (letting one side's cancels win) would let that side's thief win.
- **Burglary (phone + home server):**
  - An unplugged guardian is locked, so the burglar holds one usable key.
  - If the thief keeps the guardian powered, they can only reach the daily limit, and any recovery triggers the 7-day alerts.
  - Tell users to keep the hardware wallet's seed words outside the home.
- **Remote compromise of the home server** gives up one key of three. That's the same exposure as Bitkey's server being breached.
- **Malicious relays** can drop messages but can't read or forge them.
- **Contested recovery** (a thief cancels a genuine recovery): phone-only spending stays paused, so the thief can't drain either. Same as Bitkey.
- **After a recovery the guardian trusts its outcome:** the phone that started it becomes the new wallet's paired phone. That is what the Delay & Notify period protects; a thief who gets that far already holds the new wallet's keys. The hardware wallet must re-prove its authorization key for the new wallet before it can loosen anything, and the old wallet's recovery access grants are revoked.
- **Retired wallets are dead to the guardian:** no co-signing, no recovery, no re-pairing of the same key set, under any descriptor (another origin fingerprint, chaincode or role order is the same keys to key 3). The hardware authorization key must derive from the hardware account, so a phone thief cannot pair a retired (or any) key set with an authorization key of its own. Coins sent to a retired wallet's address later can only move with two of its own keys.
- **Retiring needs the phone and the hardware wallet together** (the paired phone's nostr key plus a `retire-wallet` approval) and is refused during a recovery, so a hardware-held thief cannot end the guardian's protection in the middle of its own recovery.
- **Reset rotates key 3.** With the old key 3 and no wallet state, anyone holding the web UI, the passphrase and a stolen hardware wallet could pair the user's own wallet again with their own phone and no alert contacts, then run a recovery nobody else hears about. A new key 3 cannot co-sign the old wallet at all (its funds stay with the phone and the hardware wallet), so a reset can only lose the guardian's help, never the user's money to a thief. Reset is refused while a recovery runs or a sweep awaits broadcast.
- **Remote lock** is allowed for the paired phone at any time and for nobody else; it only removes capability. A thief with the phone can lock the guardian (a nuisance: unlock needs the passphrase), but could not have done more with it than the daily limit anyway.
- **The recovery code holds no secret.** The guardian's npub and relays are visible on the relays anyway; what lets a new phone in is the hardware wallet's `recovery.access` signature, bound to that phone's nostr key and (version 2, when the code carries the wallet id) to the wallet. A version-1 signature whose grant a rotation or retirement revoked is refused until it expires.
- **The guardian's clock is not trusted alone.** An attacker who controls the box's NTP can move the system clock: a recovery's delay counts from the later of the clock and the chain's median time past at the start (a clock set back cannot shorten it), and completes only when the clock, the median time past and the block count all agree (a clock pushed forward cannot either). The daily limit's window is not opened by stepping the clock: the guardian refuses to co-sign while the clock is more than 3 hours ahead of the chain, and its window time never goes backwards. Without chain data a recovery does not start, and co-signing stops once the last chain observation is 3 hours old.
- **The web UI has its own sessions.** Every API call needs a session (the unlock passphrase signs a browser in; an HttpOnly, SameSite=Strict cookie, idle-expiring, in memory), except the reduced status and first-run setup until it completes, because other apps' containers on the box can likely reach the guardian without going through the platform's proxy. Still keep the port behind the proxy (Umbrel's `app_proxy`, Start9's interfaces), which also stops DNS rebinding.
- **The guardian's nostr key is stored unencrypted** (mode 0600), so a locked guardian can still answer the phone and receive an unlock. It can't sign transactions.
- **Electrs and the node are trusted** for chain data; headers are checked to link up but not for proof of work.
- **Nuisances, not thefts:**
  - Anyone who knows a wallet address can send a coin after a recovery starts. That blocks completion, because the sweep must spend every coin, until the surviving key adds it with `recovery.update` (the delay runs on).
  - Anyone who sees the guardian's npub on a relay can burn a 5-minute pairing code with wrong attempts (at no disk write: a wrong secret is refused before anything is recorded).
  - Anyone with a web session can delay unlocks through the web throttle; without one, only sign-ins, which have their own throttle. A stolen phone's guesses never delay the web UI.
  - A flood of refused requests costs no state write and only pushes out older refusals in the activity log, never co-signatures or other entries.

## Recovery Key mode (no home server)

Built in [`packages/recovery-key`](packages/recovery-key) (`@trikey/recovery-key`). The app drives it through one facade, `RecoveryKeyWallet`, whose methods follow the `RK-*` screens.

- **Keys.** The vault is the same `wsh(sortedmulti(2, phone, hardware, recoveryKey))` on BIP 48 as guardian mode.
  - Key 1, the hardware wallet: its BIP 48 account key.
  - Key 2, the phone: one seed with two accounts. BIP 48 for the vault, BIP 84 (`m/84'/c'/0'`) for the **spending balance**, a single-key `wpkh` wallet the phone spends from with Face ID alone (it also restores in any BIP 84 wallet).
  - Key 3, the **Recovery Key**: a fresh 12-word BIP 39 seed made in memory and printed on the Recovery Kit, or a second hardware wallet, of which only the xpub is needed (the kit is then a wallet map with no secret). The user proves the kit is saved by typing three of its words or scanning the printout; then key 3 is wiped from the phone and only its xpub stays. (An NFC card is still a later option.)
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
  - **Cost.** Per transaction with a taproot output: the input key sum, input_hash, then **one** multiplication of `A` by `input_hash·b_scan` (instead of the tweak `input_hash·A` and then `b_scan` times it, which halves the work; checked against the package and every BIP 352 receiving vector), then `B_spend + t_k·G` and the labels. Transactions without a taproot output, or without an eligible prevout type, are skipped before any curve work. Measured on a synthetic 2,000-transaction block, pure JS on one 2.8 GHz Xeon core (Node 22, `apps/guardian/test/sp-perf.test.ts`): about 6 ms per scanned transaction; 12.1 s per block when every transaction pays a taproot output (0.08 blocks/s), 3.8 s when 30% do (0.26 blocks/s; the package's two-multiplication path took 23.1 s and 7.2 s). A Raspberry Pi 4 (Cortex-A72) is roughly 3-4 times slower per core: about 12-15 s per block like the 30% one, so following the tip costs a few percent of one core, but a first scan from a birth height one month back (about 4,300 blocks) takes most of a day. Faster later: blocks in worker threads (a Pi has four cores), or an index that serves the per-transaction tweak data, which leaves one ECDH per transaction.
- **The wallet's side** (not built yet; the guardian side is). The wallet still takes any scanner (`LocalSilentPaymentScanner` for a phone with its own full node, and the tests) and reads its single-key coins from a `SingleKeyChainSource` (the user's own Electrum or Esplora). To use the guardian for all of it, the wallet needs (`apps/guardian/test/support/wallet-adapters.ts` has the two adapters, and the guardian's end-to-end test runs the real wallet on them):
  - after `enableSilentPayments`, call `singlekey.register` with `helper: state.helper.account` (and again with `coins` for any silent payment it found without the guardian), then turn on `silentPaymentsViaGuardian`;
  - a `SingleKeyChainSource` over the guardian (`GuardianSingleKeyChain`): `wallet.sync` with `wallet: 'helper'` (helper `utxos` carry their `script`; other single-key coins are in `coins`), `tx.get`, `tx.broadcast`, `fees.estimate`; set it as `singleKeyChain` by default in guardian mode;
  - a `SilentPaymentScanner` over `sp.scan` (`GuardianSilentPaymentScanner`), after `sp.register` with `receiver.scanKeys()` and the birth height (again when a label is added: re-registering the same keys re-scans), and `sp.unregister` when silent payments are turned off or the wallet leaves the guardian;
  - handle the `sp_received` alert (run `scanSilentPayments`, then `sweepSilentPayments`), and the errors `1700` (show "needs your node's RPC", fall back to the local scanner) and `1701` (register again).
- **The hardware wallet cannot verify the recipient.** It shows the output as a plain taproot address (`bc1p…`), not `sp1…`: it cannot check that the output really pays the address the user typed, only that the phone says so. The app shows both, so the user can compare the taproot address on both screens. Only BitBox02 can verify a silent payment today, through BIP 375's PSBT fields with BIP 374 DLEQ proofs. For Trikey that means a PSBTv2 whose output carries the recipient's keys (`PSBT_OUT_SP_V0_INFO`) and the phone's ECDH share for the helper input with its DLEQ proof (`PSBT_GLOBAL_SP_ECDH_SHARE`, `PSBT_GLOBAL_SP_DLEQ`); the device checks the proof against the helper's public key, computes the output itself and shows `sp1…`. Trikey's PSBTs are version 0 and carry neither yet: that is the later path.
- **Privacy trade-offs.**
  - A payment carries the helper input next to the vault inputs, so it links the helper coin to the vault on chain, and a vault spend with one P2WPKH input is a recognizable shape.
  - The helper change and the vault change are both visible as change-like outputs.
  - A phone with the helper coin's key can be linked to every silent payment it made (the helper's history is one chain of change).
  - The scanning server (the guardian, or whoever holds the scan key) learns every payment received; so does anyone who copies the guardian's data directory (the scan key is not under the passphrase, so that scanning works while locked).
  - Each sweep is a 1-input, 1-output transaction from a taproot coin into the vault's multisig, so the vault is linked to each received coin (but not the received coins to each other).
  - Recovery Key mode has a single-key spending balance (`m/84'/c'/0'`) whose coins are eligible inputs, so it could send silent payments from that balance without a helper; that is not built yet.

## Later: guardian for family

Someone who runs a guardian can host one for a person they know.
- **How it works:** invite-only (QR or link), with a separate key per hosted wallet.
- **Privacy:** BIP 89 chaincode delegation (`packages/core/src/tweak.ts`) hides the guest's addresses and balance from the host.
- **The trust involved:** a dishonest host could skip the delay and suppress alerts while teaming up with a thief. The app must state this when an invite is accepted.
- **Later still:** two hosts could share the key 3 role.

## Open questions

1. **How the hardware wallet unlocks the guardian.** Rule changes now use BIP137 message signatures (see rule 4); which signing paths each device allows still has to be tested on real hardware. Unlocking with the hardware wallet is still open: Trezor has CipherKeyValue (SLIP-11), Ledger has no symmetric-key API. Until then, unlocking uses the passphrase.
2. **Notifications when the phone app is asleep.**
   - Nostr DMs reach the user's regular nostr app (zero infrastructure).
   - Real push on iOS needs Apple's push service, called with credentials only the app's publisher holds. That means running a stateless "empty ping" bridge, which conflicts with "we run nothing".
   - The guardian could also send email through the user's own SMTP settings.
3. **Defaults:** daily limit, delay (7 days?), relays.
4. **Start9 packaging details** (SDK version), and how the official Umbrel store submission works.

## Repository state

- `packages/core/`: descriptors (BIP380 checksum, BIP389 multipath), BIP48 wallets, PSBT build, sign, analyze and finalize, software signer. `tweak.ts` holds the BIP 89 tweak math, kept for family hosting.
- `packages/protocol/`: the nostr RPC (schemas, gift-wrap transport with per-peer NIP-44 conversation key caching, replay guard, client and server, pairing and recovery URIs, NIP-06 phone identity, an in-memory relay for tests). Spec in `PROTOCOL.md`.
- `packages/wallet/`: the phone's side (key 2, pairing, payments, rules, recovery, backup), platform-agnostic; the app supplies storage and hardware adapters. It finishes a recovery (switching to the adopted wallet after checking it, then `confirmHardware()`), replaces the guardian (pair the new one, sweep, retire the old wallet, sweep stray coins later), locks the guardian remotely, parses every Trikey QR (`parseScannedCode`), and keeps a send log that travels in the backup. Chain data comes from the guardian.
- `apps/guardian/`: the guardian. `src/policy/` is the policy engine (spend checks, daily limit, rule changes with BIP137 approvals, Delay & Notify, wallet rotation with one active wallet plus retired ones, state format version 2 with migration from version 1). Around it: key storage (Argon2id, m=64 MiB, t=3, then XChaCha20-Poly1305), lock/unlock (also from the phone), reset, the nostr RPC server and NIP-17 alert DMs behind one shared inbox, an Electrum client (sweep completeness, broadcast, chain time) and the HTTP API for the web UI. Entry point `src/main.ts`.
- `apps/guardian-web/`: the guardian's web UI, including the recovery code and the reset. Its API is in `API.md`.
- `packages/recovery-key/`: Recovery Key mode (no home server): the printed Recovery Kit, the chain of BIP 68 timelocked refills and its scheduler, the single-key spending balance with CPFP, an Esplora client, and recovery with any two keys.
- `apps/mobile/`: the React Native app (Expo). Demo, regtest-simulator and real modes; guardian mode runs on `@trikey/wallet` with Ledger, Trezor and QR adapters, secure key storage and a recovery-code backup file. Recovery Key mode screens are still demo-only.
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
4. **Testnet and signet beta,** then an independent security review before mainnet.
