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
| Savings (optional) | A second wallet, `wsh(sortedmulti(2, phone, hardware, recoveryKey))` at BIP 48 account 1', the Recovery Key a second hardware wallet; the guardian only watches it ("Savings" below) | The daily limit lives in the guardian's code; only a script keeps phone + guardian away from money. Opt-in, never part of onboarding |
| First client | React Native mobile app | Ledger Bluetooth and Trezor Connect have JS SDKs |
| UI kit | shadcn/ui: react-native-reusables + NativeWind in the app, shadcn/ui + Tailwind in the guardian web UI. Zinc neutrals, Geist type, light and dark themes. | One set of tokens and components across the phone and the home server |
| Transport | Nostr: NIP-44 encryption inside NIP-59 gift wraps | Outbound-only connections, no accounts, relays see ciphertext |
| Entropy | Every key from one checked function on the OS CSPRNG; the guardian's seed mixes in the browser's (and on Umbrel the platform's) randomness, key 3 the phone's; no dice | See "Entropy": guards catch gross failures, the setup mix, the key-3 mix and 2-of-3 cover subtle ones |
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
   - **Payments into the optional Savings wallet count like any payment** (the owner's decision, 2026-11-01): the guardian is not told which wallet is Savings for this rule and counts an output to it as leaving the wallet. A phone thief registering their own wallet as "Savings" therefore gains nothing.
   - **The limit can be turned off** (strictly opt-in; docs/design/savings-and-limit-off.md, section 4). "Off" is the largest limit there is, all bitcoin there will ever be, so the policy and its hash are unchanged; every other rule stays, and the guardian still counts what it co-signs. It is a loosening: only with a fresh hardware approval whose text says it in words (`Trikey policy v2 ... limit=off ...`, rule 4), never at pairing and never while a recovery is pending or ready. Turning it back on is tightening: the phone alone, at once. The guardian alerts the paired phone (`limit_off`) and every alert contact (a NIP-17 DM) when it is turned off, logs it as a warning, and tells the phone when it is on again (`limit_on`). It remembers the limit before (`limitBeforeOff`): after a recovery the adopted wallet starts with the limit **on** at that value (rotation, below). The phone offers it only to a guardian that reports the `limit_off` feature. With the limit off the guardian is a second signature, not a brake: a thief who gets into the phone sends everything at once.
4. **Loosening the rules needs the hardware wallet.** That covers raising the limit, shortening the delay, changing the sweep fee cap, adding or removing alert contacts, and stopping the alert contacts from locking the guardian (rule 8). The phone alone can only tighten: lower the limit, lengthen the delay or let the alert contacts lock the guardian, **also while a recovery runs** (tightening never helps a thief; a running recovery keeps the delay and fee cap it started with). On mainnet the rules must name at least one alert contact: a pairing without one, or any change that removes the last one, is refused even with a hardware approval; test networks allow it and report `warnings: ['no_alert_contacts']`.
   - **How the hardware wallet approves:** a BIP137 `signmessage` signature from a single-sig key recorded at pairing. Ledger, Trezor and Coldcard all support it. The signed text is one line that shows the new values in clear, so the user checks them on the device screen:
     `Trikey policy v1 wallet=<id> seq=<n> limit=<sats> delay=<d>d feecap=<sats> contacts=<k> hash=<policyHash> expires=<ISO8601Z>`
     and, for no daily limit only, version 2 with the limit in words (older guardians refuse it, `1202`):
     `Trikey policy v2 wallet=<id> seq=<n> limit=off delay=<d>d feecap=<sats> contacts=<k> hash=<policyHash> expires=<ISO8601Z>`
     and, while the alert contacts may lock the guardian (rule 8) or when a change stops them, version 3, which says which in words (older guardians refuse it, `1202`):
     `Trikey policy v3 wallet=<id> seq=<n> limit=<sats|off> delay=<d>d feecap=<sats> contacts=<k> lock=<on|off> hash=<policyHash> expires=<ISO8601Z>`
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
8. **Alert contacts can lock the guardian** (strictly opt-in, off by default; docs/design/contact-lock.md). The owner's choice, as a rule of the wallet (`contactLock`): while it is on, an alert contact of the active wallet who sees something the owner did not do (a recovery starting, the limit turned off, rules changed) can send the guardian the single word `LOCK` as a NIP-17 DM from any nostr app, and the guardian locks: the same locked state as the web UI's Lock or the phone's `guardian.lock`, so nothing is co-signed and phone-only payments stop, while recoveries, their timers and their alerts run on as on any locked guardian (a ready recovery is co-signed once the owner unlocks). A contact can **only lock**: never unlock, change rules or see balances. Unlocking stays with the owner (the passphrase in the web UI, or the phone's `guardian.unlock`).
   - **The setting.** Off is not part of the policy at all, so its hash, its approval text and every older phone and guardian are exactly as before. On is a tightening (the phone alone, at pairing too, and during a recovery); off takes a protection away, so it needs a hardware approval over the version-3 text (`lock=off`, rule 4). It carries over to a wallet a recovery adopts. The phone offers it only to a guardian that reports the `contact_lock` feature (in `guardian.status`, and in `pair.prepare` for pairing).
   - **Who may.** Only current alert contacts of the active wallet, only while it is on. Anyone else (strangers, the paired phone's key, a recovery's recipients no longer in the rules) gets no answer at all, so the command cannot probe who is a contact or whether the setting is on. A contact gets a short answer: locked, already locked, or not allowed (setting off). A message counts once (remembered across restarts, since relays re-deliver old wraps), only within 10 minutes of the guardian's clock, and at most 5 per contact per hour.
   - **Who is told.** The guardian logs it ("Locked by alert contact npub… via nostr") and alerts, durably and retried like the other alerts, the paired phone (`guardian_locked`, `reason: contact`, naming the contact; the phone shows the name it keeps for them) and every other alert contact (a DM saying who and when). The contacts are also told when the setting goes on (how to lock) and off, and while it is on the recovery and limit-off DMs end with how to lock.

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
  | `savings.register`, `savings.unregister`, `savings.get` | Watch the phone's optional Savings wallet (watch-only, no approval: the guardian holds no Savings key), stop, read it back. Then `wallet.sync` with `wallet: 'savings'` serves its coins, `tx.broadcast` relays its spends, and a spent Savings coin raises `savings_moved` to the phone and the alert contacts |
  | `singlekey.register` | Register the phone's single-key coins (public data only): the helper coin's account (`m/84'/c'/1'` xpub) and coins by outpoint and script. Then `sign` accepts the helper input, `wallet.sync` with `wallet: 'helper'` serves them and `tx.broadcast` relays their sweeps into the vault |
  | `sp.register`, `sp.unregister` | Hand the guardian the silent payment scan key (with `B_spend`, labels and birth height) so it scans the node's blocks; take it back |
  | `sp.scan` | The payments the scanner found (`sp_received` alerts announce new ones) |
  | `guardian.unlock` | Unlock after a restart (refused after 5 failed tries in a row until the web UI unlocks, and while a recovery the phone did not start runs) |
  | `guardian.lock` | Lock the guardian remotely (alert contacts can lock it too, with a `LOCK` DM, when the owner allows it: rule 8) |
  | `guardian.status` | Read guardian state (with `warnings`, e.g. `no_alert_contacts`) |

- **Every request carries:**
  - an id, so retries are idempotent;
  - a NIP-40 expiry;
  - the hash of the PSBT it refers to.
- **Replay protection:** old rumors are dropped. Strangers (senders that are not the paired phone, an alert contact or a phone with recovery access) get their own small replay cache and seen-wrap set, so they cannot push a peer's entries out; refused `sign` / `recovery.start` / `recovery.update` are rate limited per sender, and repeated identical refusals are one log entry with a count.
- **Relays:** several, with the user's own relay optional (Umbrel has a Nostr Relay app).
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

- **Stolen phone:** the thief can spend at most the daily limit. They can't raise it, because that needs the hardware wallet. **With the limit turned off** (the owner's explicit choice, hardware-approved) they can send everything at once; the alerts arrive after the money has left. A recovery they start triggers the alerts. They cannot hide the vault from a later recovery either: change past the gap limit counts against the limit (rule 3). They cannot starve the owner's unlock: the phone's `guardian.unlock` has its own throttle, stops after 5 failures until the web UI unlocks, and is refused while a recovery the phone did not start runs.
- **Alert contacts are what makes Delay & Notify work.** Without one, a recovery is announced only to the paired phone, which may be the thief's: a phone-only thief could then sweep the whole vault to a wallet of its own (keeping key 2, adding its own "hardware" key) and nobody would hear of it. So **on mainnet the guardian requires at least one alert contact**, at pairing and for every rule change. **A contact can be the user's own nostr app on another device** (a laptop, a tablet, a second phone): it only needs a nostr key that can receive NIP-17 DMs and reply `CANCEL <id>`. Test networks allow zero contacts and say so (`warnings: ['no_alert_contacts']` in `policy.get`, `guardian.status` and the web UI).
- **Contested recovery stalemate (by design).** A stolen phone can cancel every recovery the hardware wallet starts, and the hardware wallet can cancel every recovery the phone starts. Each contested cancel pauses phone payments until the hardware wallet resumes them. So if the phone is stolen and the user has **no backup of key 2**, the thief and the owner block each other: **the vault is frozen, not lost**. Nobody can take the funds (the thief holds one key, the owner one key, the guardian co-signs only within the rules), and the owner gets out by restoring key 2 from its backup (then phone + hardware spend directly, no guardian needed) or, failing that, by waiting the thief out. This is the price of letting any key holder cancel; the alternative (letting one side's cancels win) would let that side's thief win.
- **Burglary (phone + home server):**
  - An unplugged guardian is locked, so the burglar holds one usable key.
  - If the thief keeps the guardian powered, they can only reach the daily limit, and any recovery triggers the 7-day alerts.
  - Tell users to keep the hardware wallet's seed words outside the home.
- **Remote compromise of the home server** gives up one key of three. That's the same exposure as Bitkey's server being breached.
- **Savings (optional).** Phone + guardian, together or compromised, cannot move Savings: the guardian holds no Savings key. What can: the phone with the hardware wallet, or the Recovery Key with either of them. A burglar who finds the phone, a powered box and a Recovery Key kept at home takes Savings too, so the Recovery Key belongs away from home, apart from the hardware wallet's seed words. A compromised guardian can hide Savings' balance from the phone or stay silent when it moves (its tripwire), which costs nothing it was trusted with. Turning the Savings watch off or swapping it for another wallet (the paired phone alone can) is announced to the phone and every alert contact (`savings_unwatched`), so a phone thief cannot quietly blind the tripwire before moving Savings with a second key. The watched Savings record survives a recovery, so whoever completes one (normally the owner) can read Savings' descriptor and balance from the guardian; it moves nothing.
- **Malicious relays** can drop messages but can't read or forge them. A relay change from the web UI (a security event in the activity log) can at worst move the phone to relays that drop everything; the old relays stay watched until the owner stops them and the phone moves only to relays the guardian answered it over.
- **Contested recovery** (a thief cancels a genuine recovery): phone-only spending stays paused, so the thief can't drain either. Same as Bitkey.
- **After a recovery the guardian trusts its outcome:** the phone that started it becomes the new wallet's paired phone. That is what the Delay & Notify period protects; a thief who gets that far already holds the new wallet's keys. The hardware wallet must re-prove its authorization key for the new wallet before it can loosen anything, and the old wallet's recovery access grants are revoked.
- **Retired wallets are dead to the guardian:** no co-signing, no recovery, no re-pairing of the same key set, under any descriptor (another origin fingerprint, chaincode or role order is the same keys to key 3). The hardware authorization key must derive from the hardware account, so a phone thief cannot pair a retired (or any) key set with an authorization key of its own. Coins sent to a retired wallet's address later can only move with two of its own keys.
- **Retiring needs the phone and the hardware wallet together** (the paired phone's nostr key plus a `retire-wallet` approval) and is refused during a recovery, so a hardware-held thief cannot end the guardian's protection in the middle of its own recovery.
- **Reset rotates key 3.** With the old key 3 and no wallet state, anyone holding the web UI, the passphrase and a stolen hardware wallet could pair the user's own wallet again with their own phone and no alert contacts, then run a recovery nobody else hears about. A new key 3 cannot co-sign the old wallet at all (its funds stay with the phone and the hardware wallet), so a reset can only lose the guardian's help, never the user's money to a thief. Reset is refused while a recovery runs or a sweep awaits broadcast.
- **Remote lock** is allowed for the paired phone at any time and, only when the owner turned rule 8 on, for the alert contacts; for nobody else. It only removes capability. A thief with the phone can lock the guardian (a nuisance: unlock needs the passphrase), but could not have done more with it than the daily limit anyway.
- **Alert contacts locking (rule 8, opt-in).** A contact, or someone who stole a contact's nostr key, can at worst **lock** the guardian, as often as the owner unlocks it (5 messages per contact per hour): a nuisance, never a loss. While it is locked the owner pays with the hardware wallet, and a ready recovery waits for the unlock, which a contact could already delay more by cancelling it. The owner unlocks and, if it happens again, removes that contact or turns rule 8 off, both with the hardware wallet. It gives a contact nothing else: no unlock, no rule change, no balances, and strangers get no answer to learn from. What it buys: a contact who sees an alert the owner cannot have caused (a phone thief's recovery, the limit off) can stop the guardian co-signing at once, without waiting for the owner. It does not stop a recovery (`CANCEL` does) and does not help against a thief holding the phone and the hardware wallet, who needs no guardian. The phone alone can turn it on, never off: a phone thief would want it off, and that needs the hardware wallet.
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

## Entropy

Guessable keys would lose money silently, so where each key's randomness comes from is spelled out here.

**Where every key comes from.** Every key and secret Trikey makes is drawn through one function, `secureRandomBytes` ([`packages/core/src/random.ts`](packages/core/src/random.ts)). It reads the platform's own CSPRNG (`crypto.getRandomValues`, filled by the operating system) and checks it on every call.

| Key or secret | Where | Source |
|---|---|---|
| Key 2, guardian mode (24 words) | `packages/wallet` `newMnemonic` | 32 bytes from `secureRandomBytes`, then `entropyToMnemonic`. On the phone that is `expo-crypto`: `SecRandomCopyBytes` on iOS, `SecureRandom` on Android. |
| Key 2, Recovery Key mode (24 words) | `packages/recovery-key` `newPhoneMnemonic` | Same. |
| Recovery Kit key (12 words) | `packages/recovery-key` `newRecoveryKeyEntropy` | 16 bytes from `secureRandomBytes` on the same phone. |
| Key 3, guardian mode | `apps/guardian` `generateSeed` (`trikey/guardian-seed/v1`), then `trikey/key3/v1` | 32 bytes from `secureRandomBytes` (Node's webcrypto, Linux `getrandom`) at setup or reset, mixed with 32 bytes from the setup browser's `crypto.getRandomValues` and, on Umbrel, the app's `APP_SEED` (below); then mixed with the phone's contribution at pairing (below). |
| Key 1, the hardware wallet | The device | The device's own generator, outside Trikey's control. Trikey only ever sees its xpub. |
| Guardian nostr key, NIP-59 wrap keys | `identity.ts`, `transport.ts` | `randomSecretKey`: 32 bytes from `secureRandomBytes`, drawn again only if they are not a valid secp256k1 scalar. |
| Backup data key, nonces, salts, recovery code, passkey PRF salt | `packages/wallet/src/backup.ts`, `wallet.ts` | `secureRandomBytes`. |
| Pairing secret, message ids, pairing session id | `packages/protocol/src/pairing.ts`, `envelope.ts`, `apps/guardian/src/pairing.ts` | `secureRandomBytes`. |
| Guardian keystore salt and nonce, silent-payment key encryption | `apps/guardian/src/keystore.ts`, `silent/service.ts` | `secureRandomBytes`. |
| NIP-44 nonces and NIP-59 back-dating (RPC and the guardian's NIP-17 alert DMs) | `packages/protocol/src/transport.ts` | `secureRandomBytes` and `secureRandomInt`, no longer `Math.random` or nostr-tools' own generator. Back-dating hides when a message was sent, so it should not come from a predictable generator. The wrap's public `expiration` is derived from that same back-dated `created_at` (`created_at + 2 days + the class TTL ceiling`), never from the send time, so it does not undo the back-dating; relays still see when an event arrives. |

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
- **`extra`:** `TRIKEY_EXTRA_ENTROPY`, 32 bytes as hex; any other non-empty value is hashed to 32 bytes (SHA-256), so a value in another format never stops the guardian from starting. The Umbrel package sets it to the app's `APP_SEED`, which umbrelOS derives from the Umbrel's own seed and the app id (HMAC-SHA256), so it comes from another moment of the box's life (the Umbrel's setup). The Start9 package sets nothing.
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
  phone key is not usable), at the 6-block fee estimate, broadcast through the guardian. "Move to Spending" pays a
  Spending address; the hardware wallet shows it as an outgoing payment and the app says so. Spending and Savings coins
  are never mixed in one transaction.
- **The guardian's part** (`apps/guardian/src/savings.ts`, `PolicyEngine.registerSavings`): it watches the descriptor
  (`GuardedWallet.savings`), serves its chain data and relays its spends, and scans it on every block and every two
  minutes. A spend after the first scan raises a durable `savings_moved` notice to the paired phone and every alert
  contact (a tripwire: an honest guardian says Savings moved; a compromised one stays silent). Turning the watch off, or
  swapping it for another Savings wallet, is announced to the phone and every contact the same way (`savings_unwatched`);
  the phone, which did not ask for it, registers Savings again at its next sync. It refuses to watch any
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
- Savings (optional, docs/design/savings-and-limit-off.md): `SAVINGS_ACCOUNT` in core; `savings.*` in the protocol; the guardian's watch (`apps/guardian/src/savings.ts`); `TrikeyWallet.startSavings` ... `replaceSavingsKey` in `packages/wallet`; `apps/mobile/app/savings/`.
- `packages/recovery-key/`: Recovery Key mode (no home server): the printed Recovery Kit, the chain of BIP 68 timelocked refills and its scheduler, the single-key spending balance with CPFP, an Esplora client, and recovery with any two keys.
- `apps/mobile/`: the React Native app (Expo). Demo, regtest-simulator and real modes; guardian mode runs on `@trikey/wallet` with Ledger, Trezor and QR adapters, secure key storage and a recovery-code backup file. Recovery Key mode runs on `@trikey/recovery-key` (`src/data/rk-service.ts`), on test networks only.
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
