# Several wallets in one phone app: design proposal

Status: **proposal**, written 2026-11-05 against `main` at `b0c3bb5` (after family hosting phases 1 and 2, Savings,
the live wallet and the web Wallet page), revised the same day to the owner's decision. Nothing here is built. The
owner's decisions and the few questions they raise are in section 10.

The owner's ask (2026-11-01, deferred then in favour of family hosting): "Allow the same phone app to have multiple
wallets where the only key that changes is the hardware wallet."

The owner's decision (2026-11-05): "the best solution is same phone and guardian wallet, only change the hardware
wallet for now; this keeps things simple."

**The short answer.**

| Question | Verdict |
|---|---|
| What changes per wallet | Only the hardware wallet. Every wallet uses **the same phone seed** and **the same guardian key 3 seed**. |
| Unlinkable on chain anyway | Each wallet sits at **its own BIP 48 account** on the phone seed and on the key 3 seed (wallet 2 at 2', wallet 3 at 4', ...). The phone's and the guardian's keys differ per wallet, so nothing on chain links the wallets. The person never sees the account: one phone backup, one recovery code, one guardian. |
| The phone | One seed, one nostr identity, one backup holding the list of wallets. The app shows one wallet at a time with a switcher (section 5). |
| The guardian | "Own wallets": more wallets of its owner, each with its own policy engine (daily limit, contacts, Delay & Notify) and its key 3 at its account. Lock stays box-wide. BIP 89 stays for family hosting only (section 3). |
| The protocol | Requests that act on a wallet carry an optional `walletId`; without it they mean the first wallet, as today. Old guardians refuse the unknown member, so they never act on the wrong wallet (section 4). |
| Order | The guardian goes first: with one identity and a shared seed, a second wallet cannot exist without it. The phone follows in the same or the next release (section 9). |

## 0. What exists today

| Assumption | Where |
|---|---|
| One wallet per app, per mode and network: `trikey.wallet.<mode>.<network>`, the app's notes under `.app` | `apps/mobile/src/data/real.ts` (`walletKey`, `RealWalletService.w`) |
| One seed per wallet; the state records the secrets' ids (`trikey.key2.<tag>`, `trikey.nostr.<tag>`); removing the wallet deletes them | `packages/wallet/src/wallet.ts` (`TrikeyWallet.create`, `forget`), `state.ts` (`WalletState.secrets`) |
| Paths on the phone seed: the vault at `m/48'/c'/0'/2'`, Savings at `m/48'/c'/1'/2'`, the helper coin at `m/84'/c'/1'`, silent payments at `m/352'/c'/0'/...`, the nostr identity at NIP-06 `m/44'/1237'/0'/0/0`. `m/84'/c'/0'` is unused in guardian mode (Recovery Key mode's spending balance, on its own seed) | `packages/wallet/src/keys.ts`, `packages/core/src/network.ts` (`SAVINGS_ACCOUNT`), `packages/protocol/src/identity.ts`, DESIGN.md "Silent payments" |
| Paths on a hardware wallet: the vault at its account 0', Savings at 1' (a Recovery Key device also at 1'); the authorization key at `<account 0'>/0/0` | DESIGN.md rule 4 and "Savings"; `keys.ts` (`authKeyPath`) |
| Key 3: `seed3 = HMAC-SHA512(setup seed, "trikey/key3/v1" || context || c)` per pairing, then account `m/48'/c'/0'/2'` of it (or of the setup seed for a pairing without `entropy`) | DESIGN.md "Entropy"; `apps/guardian/src/keystore.ts` (`cosignerFromSeed`) |
| The guardian knows a phone by the nostr pubkey that signs its gift wraps, guards one wallet of its owner (`register` refuses `already_registered`) plus up to 8 hosted guests; a pubkey belongs to one slot | PROTOCOL.md sections 1 and 3; docs/design/family-hosting.md section 2 |
| Request params are strict schemas: an unknown member is refused | `packages/protocol/src/schemas.ts` (`z.strictObject`) |
| The backup is one file per wallet; payload version 1, 2 with Savings, 3 hosted; restore picks the newest file | `packages/wallet/src/backup.ts`; `TrikeyWallet.createBackup`, `findBackup` |
| Key 2 sits behind the phone's biometrics; viewing balances needs no unlock | `SecureKeyStore.save(..., { requireBiometrics: true })` for key 2 only |

## 1. Goal and scope

**What "several wallets" means here.** One phone app holds several guardian-mode wallets of one guardian. Each has its
own hardware wallet, its own rules, alert contacts, recoveries and history, and optionally its own Savings. They share
the phone seed, the phone's nostr identity, the backup and the guardian. The app shows one at a time.

The two cases it fits:

1. **A household sharing one phone and one guardian**, two people each with their own hardware wallet.
2. **One person with two hardware wallets** for separate purposes ("Daily" on a Trezor, "Business" on a Ledger).

**Not for now:**

| Reading | Why not now |
|---|---|
| Wallets of several guardians in one app; a hosted wallet next to your own | One phone identity is paired with one guardian, and a host refuses a phone pubkey it already knows. Later (question 3). |
| A second wallet with the same hardware wallet | Its key would appear in both wallets. Savings is the second pot for one device. |
| Recovery Key mode wallets in the switcher | Its own service and seed; test networks only. |
| Wallets on different networks side by side; one wallet on several phones; two guardians sharing key 3 | Out of scope. |
| Silent payments and the helper coin for wallets after the first | The helper coin rides along in payments, so sharing it would link the wallets on chain. Later, at an account per wallet. |

## 2. Keys and scripts

Every wallet stays `wsh(sortedmulti(2, key2, key1, key3))` on BIP 48.

### Why accounts, not one shared key

Read literally, "the same phone key and the same key 3" means the same account xpubs in every wallet. Then the
phone's child key at index *i* is the same pubkey in both wallets' scripts, and so is key 3's: every spend's witness
shows them, and anyone can link the wallets on chain. A separate BIP 48 account per wallet gives unrelated keys from
the same seed. It costs the person nothing: one seed, one backup, one guardian, one pairing.

### The account layout (recommended, question 1)

Wallet *n* (the first is *n* = 0) uses account **2*n*** for Spending and **2*n*+1** for its Savings. The first wallet
is exactly today's.

| | Wallet 1 (today) | Wallet 2 | Wallet 3 | Wallet *n*+1 |
|---|---|---|---|---|
| Phone, Spending | `m/48'/c'/0'/2'` | `2'` | `4'` | `2n'` |
| Phone, Savings | `m/48'/c'/1'/2'` | `3'` | `5'` | `(2n+1)'` |
| Key 3 (the key 3 seed) | `m/48'/c'/0'/2'` | `2'` | `4'` | `2n'`, the Spending number |
| Hardware wallet, Spending / Savings | its own `0'` / `1'` | its own `0'` / `1'` | its own `0'` / `1'` | each a different device |
| Hardware authorization key | `<0'>/0/0` of its device | the same on its device | | |
| Helper coin, silent payments | `m/84'/c'/1'`, `m/352'/c'/0'/...` | none for now | none for now | later, per account |
| Phone nostr identity | NIP-06 `m/44'/1237'/0'/0/0` | the same | the same | the same |

- **One number per wallet:** "the wallet at account 2'" means the phone's Spending key and key 3 at 2'. Key 3 needs no
  Savings account (the guardian holds no Savings key), so odd key 3 accounts stay unused.
- **The first wallet keeps 0' and 1'**, so every existing wallet, backup and Savings is untouched.
- **An account is never reused.** A removed or retired wallet's account stays taken (the phone and the guardian both
  remember it), so an old address can never receive into a new wallet.
- **Hardware wallets** keep their own account 0' (and 1' for Savings): each wallet has a different device. The app
  refuses a device whose fingerprint already holds a key in another wallet on this phone, as hardware wallet or as a
  Savings Recovery Key; that key would appear in two wallets.
- **The device registers each wallet under its own name** ("Trikey Daily", 16 characters at most), so its screen says
  which wallet it signs for.
- **Device check:** cosigner keys at account 2' and up (the device's own key stays at 0', so no new path warning).
  The alpha test plan gets a step per device.

### Key 3: one seed, an account per wallet

The key 3 seed is the paired phone's `seed3` (or, for a pairing without `entropy`, the setup seed), as today. The
guardian derives wallet *n*'s key 3 at `m/48'/c'/(2n)'/2'` of it (`cosignerFromSeed` gains the account). No new
mix record, no new label: the record of the first pairing covers every own wallet. A rotation after a recovery keeps
the wallet's key 3 and account, as today. Reset makes a new setup seed, so every key 3 changes.

### On the guardian: own wallets, not hosting slots

| | What the guardian knows | Rule 3 | Chain data for the phone | Key 3 |
|---|---|---|---|---|
| **Own wallet** (new) | The full descriptor, as for the first wallet | Full | From the guardian (live wallet, `wallet.sync`) | The key 3 seed at the wallet's account |
| Hosted wallet (built, unchanged) | Account pubkeys only (BIP 89) | Tweak-proven change plus the ledger | The guest's own or a public Esplora | `trikey/key3-hosted/v1`, its own |

BIP 89 stays for family hosting only: it hides a wallet from the box's owner, and an own wallet is the owner's.

## 3. Guardian side

### Storage

```
<dataDir>/guardian-state.json                  the first wallet, unchanged (version 2, the golden file)
<dataDir>/service.json                         unchanged (relays, phones, sweeps)
<dataDir>/hosting.json, hosted/<slotId>/       unchanged (guests)
<dataDir>/wallets.json                         NEW: own wallets: slot id, account, name, state; accounts ever used
<dataDir>/wallets/<slotId>/guardian-state.json NEW: that wallet's engine state, the same version-2 format
<dataDir>/wallets/<slotId>/...                 NEW: its live wallet cache, Savings watch and sweeps
```

Absent `wallets.json`: no own wallets, which is every guardian today, and every code path runs as before. At most 8
own wallets in all (accounts 0' to 14'), counted apart from the 8 hosted.

### One engine per wallet

The host's `PolicyEngine` is already a single-wallet state machine (rules, limit window, recoveries, rotation,
retirement). Each own wallet gets one, with hosting's pattern around it (a registry, a directory per slot). The
`Guardian` class today wires one engine to its helpers (recovery runner, live wallet, Savings monitor,
`RecentlyCosigned` and `KnownCoins`); that wiring becomes a **per-wallet runtime**, the first wallet being runtime 0
with its files where they are. This is the bulk of the work.

| Per wallet | Shared by the box |
|---|---|
| Key 3 at its account, rules, daily limit window, delay, fee cap, alert contacts, contact-lock setting, limit off | The nostr identity, relays, chain source and its tip, the three clocks |
| Recoveries (ids `<slotId>w<n>-<txid12>`, which fit `RecoveryId` and `CANCEL <id>`), Delay & Notify, rotation, retirement | Lock and unlock (every key 3 in memory, or none), the passphrase |
| Its paired phone (normally the one identity; see section 6), live wallet scripts, `wallet_tx`, Savings watch | Reset (forgets every wallet) |
| Activity log (the web UI merges them) | The owner's email, ntfy and webhook channels |

### Adding a wallet

From the paired phone (recommended, question 2), in two requests like pairing:

1. **`wallet.add.prepare`** `{ account }`: the guardian checks the account is free and even, and answers key 3's xpub
   at that account.
2. The phone builds the descriptor (its key at the same account, the new hardware wallet at 0', key 3), registers it on
   the device, shows the first address there, and has the device sign the pairing proof over the new wallet id.
3. **`wallet.add`** `{ account, name, descriptor, hardwareAuth, hardwareAuthProof, rules }`: the guardian checks what
   `register` checks today (distinct keys, key 3 in its slot at that account, the authorization key under the hardware
   xpub, the proof, the rules, a contact on mainnet, no limit off), and that no hardware key is in another of its
   wallets. It creates the slot and announces it: `wallet_added` to the phone, a line to the owner's channels and in
   the web UI's activity.

A thief holding the phone gains nothing by adding a wallet: it is a new wallet with new keys; the others are untouched.

### Routing

The sender must be the wallet's paired phone; `walletId` picks the engine (absent: the first wallet). Every method
the first wallet's phone has today works per wallet: `sign`, `policy.*`, `recovery.*`, `phone.resume`,
`hardware.confirm`, `wallet.retire`, `wallet.sync`, `tx.get`, `tx.broadcast`, `savings.*`, `guardian.status`.
`sp.*`, `singlekey.register` and `wallet.unwatch` stay the first wallet's for now. Alert contacts' `recovery.cancel`
and `CANCEL <id>` find the wallet by the recovery id. `recovery.access` is tried against each wallet's hardware
authorization key; the version-2 text names the wallet id.

### Rules per wallet

- **Daily limit:** per wallet, each with its own window. A payment from one own wallet to another counts like any
  payment, as payments into Savings do (owner's decision, 2026-11-01). The app shows the total a phone thief could reach.
- **Alert contacts:** per wallet; one person may be a contact of several; on mainnet each wallet needs at least one.
- **Delay & Notify:** per wallet. A recovery of one wallet pauses phone-only payments of that wallet only.
- **Limit off, contact lock:** per wallet, with today's rules and approval texts (`wallet=` names the wallet).

### Lock and unlock: box-wide

- One passphrase unlocks every key 3; a restart locks them all; the phone's `guardian.lock` locks the box.
- A contact's `LOCK` locks the box when the contact is listed by a wallet whose contact lock is on.
- `guardian.unlock` from the phone is refused while a recovery of **any** wallet runs that this phone did not start
  (today: of its wallet), since the phone holds every wallet's phone key.
- No per-wallet pause for own wallets: hosting's pause stays for guests.

### Alerts

- To the phone: the alert carries `walletId` for wallets after the first, and the app files it under that wallet.
- Contacts' DMs and the owner's channels name the wallet ("Business: recovery started") once the box has more than one
  wallet; with one wallet they stay as today. The owner's channels carry every own wallet's alerts.

### Web UI

- **Wallets page** (new): each wallet with its name, account, hardware wallet, state, and its recovery code
  (`trikey://recover?...&wallet=<id>`, printed and kept with that hardware wallet).
- **Wallet, Rules and Recovery pages:** a wallet picker at the top. `GET /api/wallet` stays the first wallet's;
  `GET /api/wallets` and `GET /api/wallets/:id` serve the list and each wallet, view and receive only, also while
  locked. **Activity:** merged, with a wallet column and a filter.
- **Reset:** lists every wallet it forgets; refused while any wallet's recovery runs or a sweep waits. Hosting's
  refusal is unchanged.

## 4. Protocol

- **`walletId`** (optional) in the params of the methods listed under "Routing". Absent: the first wallet, so every
  request an existing phone sends means what it meant.
- **New methods** `wallet.add.prepare`, `wallet.add`; new alert `wallet_added`; `walletId` (optional) on alerts about
  a wallet after the first.
- **`guardian.status`** without `walletId` gains `wallets: [{ walletId, account, name }]` (a lenient result member),
  so a phone restored from an old backup finds every wallet (section 5).
- **Feature** `own_wallets` in `guardian.status.features`. The phone sends `walletId` and the new methods only to a
  guardian that lists it.
- **Old guardians refuse safely.** Request params are strict schemas, so an older guardian refuses a request carrying
  `walletId` (invalid params) and answers `-32601` to the new methods. It never acts on the first wallet instead.
- **Unchanged:** the envelope, `PROTOCOL_VERSION`, pairing, approval texts (`wallet=` already names the wallet),
  recovery codes (`&wallet=` exists).

## 5. Phone side

### State

- **One seed, one nostr identity**, in the secure store as today, now shared by every wallet. They are deleted only
  with the last wallet.
- **Each wallet is one `TrikeyWallet` state document** with its account index and its `walletId` for the guardian:
  the first keeps `trikey.wallet.<mode>.<network>` untouched; the others take `trikey.wallet.<mode>.<network>.a<account>`.
  `deriveKey2` and the hardware, pairing and Savings paths take the account.
- **An index**, `trikey.wallets.<mode>.<network>`: the order, names, accounts ever used, the wallet shown last. A
  separate key, so an older app saving the first wallet cannot strip it. No index: one wallet, every install today.
- **One connection to the guardian** for all wallets: one subscription for the one identity; alerts are dispatched by
  `walletId`. The wallet shown syncs as today; the others on their `wallet_tx` alerts and every 10 minutes.

### The switcher, paying and receiving

- **Home** gets a switcher at the top: the wallet's name and its device ("Daily · Trezor Safe 3"); a sheet lists
  every wallet with its balance, and "Add a wallet". Home shows the current wallet's Spending and Savings.
- **The wallet shown pays and receives.** Send's review starts with "From: Daily" and the device it needs; Receive
  shows the wallet's name above the address; switching cancels a quote in progress. A scanned `bitcoin:` request opens
  in the wallet shown, with "From" changeable before review.
- **The wrong device is caught:** "This is the Ledger of 'Business'. Connect the Trezor of 'Daily'."
- **Alerts** for another wallet name it; tapping one switches.

### Adding a wallet

Settings > Wallets > "Add a wallet": a name, connect the new hardware wallet, then `wallet.add.prepare` / `wallet.add`
at the next free even account. Then rules and alert contacts (offering the other wallets' contacts), then a new backup
(asked for, as after Savings). A guardian without `own_wallets`: "Update your guardian to add a wallet."

### Backups: one for all

- **One file, one recovery code, one passkey.** A single-wallet backup stays byte for byte what it is (version 1, 2
  with Savings, 3 hosted). With more than one wallet the payload is **version 4**: today's fields for the first wallet
  plus `wallets: [{ account, name, descriptor, walletId, hardware, rules, nextHardwareSequence, sendLog, savings,
  retiredWallets, recoveryDestination }]`, every member public, no new secret. An older app refuses version 4 ("update
  the app"), as it refuses Savings' version 2.
- **A restore brings every wallet back**, each in its own state document, and the guardian recognises the one
  identity.
- **A backup older than the last wallet added** still recovers it: the restored phone reads `guardian.status.wallets`,
  checks each descriptor holds its own key at that account, and rebuilds the wallet (the device registration, such as
  Ledger's HMAC, is made again on first use).

### Removing a wallet

Settings > Wallets > a wallet > "Remove". Allowed when it is empty; the app first releases it on the guardian
(`wallet.retire`, its hardware approval). Its account stays taken. The first wallet can be removed only last (it holds
the guardian pairing); removing the last wallet is today's "Remove this wallet".

### Savings per wallet

Each wallet may have its own Savings: the phone at the wallet's odd account, its hardware wallet at 1', and its own
Recovery Key device. The guardian watches each wallet's Savings in that wallet's runtime.

## 6. Recovery

| Situation | What happens |
|---|---|
| Lost phone, backup | Restore the one file: every wallet comes back. Nothing changes on the guardian. |
| Lost phone, no backup | A new phone (a new seed) recovers each wallet with its own hardware wallet: its recovery code, `recovery.access` naming the wallet, Delay & Notify, a sweep to a new wallet with the new seed's key at the same account. Recoveries run side by side. Until one completes, that wallet's paired phone is the old identity; so the guardian keeps the paired phone per wallet, and the phone's identity is the same for all again once every recovery is done. |
| Lost one hardware wallet | That wallet only: its seed words, or Delay & Notify with phone + guardian. |
| Guardian dies or is stolen | Every wallet still moves with the phone and its hardware wallet. "Replace guardian" runs per wallet: pair the new guardian with the first, `wallet.add` (naming the replaced wallet) for each other one, and sweep each with its own device. The app walks through them ("2 of 3 moved"). |
| Guardian reset | Forgets every wallet and makes a new seed; refused while any recovery runs. |

## 7. Privacy and threat model

- **On chain, the wallets are not linked.** Their phone keys and key 3s come from different hardened accounts, and
  their hardware wallets are different devices.
- **Off chain they are.** Every descriptor carries the same phone master fingerprint and the same key 3 fingerprint.
  Whoever sees two descriptors (a printed wallet map, a hardware wallet's registration, an export to another wallet
  app) can tell they belong together. PSBTs carry the fingerprints to the devices.
- **One seed holds every wallet's phone key.** The backup, its recovery code and its passkey give key 2 of every
  wallet. Each wallet's money still needs its hardware wallet or the guardian's rules.
- **A shared phone is a shared key.** Phone biometrics are per device, not per person: everyone who can unlock the
  phone sees every wallet and can spend from each up to its daily limit with phone + guardian. Nobody raises another's
  limit or changes their rules without that wallet's hardware wallet. The app says so when a second wallet is added:
  "Anyone who can unlock this phone can see this wallet and spend up to its daily limit."
- **Recoveries between household members.** With the phone, one member can start a recovery of the other's wallet. Its
  alert reaches the shared phone and that wallet's contacts, who can cancel. The app suggests a contact outside the
  household.
- **A stolen phone exposes every wallet:** the sum of their daily limits per day (the app shows it), every history,
  every wallet's contested-recovery stalemate. Locking the guardian, from the web UI or by a contact, stops them all.
- **Per-wallet passcode: later.** With one seed it could only gate the app's screens, not key 2 itself.
- **The box's owner sees every own wallet**, as the first. Relays see one identity, as today.
- **The guardian keeps wallets apart:** a request reaches only the engine its `walletId` names, and that wallet's key
  3; only lock and unlock are box-wide. A box compromise gives key 3 of every wallet, as any design on one box would.

## 8. Compatibility and migration

| Combination | What happens |
|---|---|
| Existing single-wallet install | Unchanged: same storage, paths, identity and backup format. |
| New phone, older guardian | No `own_wallets`: the app does not offer "Add a wallet". A stray request with `walletId` is refused, never applied to the first wallet. |
| Older phone, new guardian | It sends no `walletId`: the first wallet, as today. |
| Guardian downgraded with own wallets | The older version ignores `wallets.json` and refuses `walletId`: the first wallet works; the others' money moves with phone + hardware wallet. The release notes say so. |
| App downgraded with several wallets | The older app opens the first wallet only. Its "Remove this wallet" would delete the shared seed: the release notes say to keep the backup, which brings every wallet back. |
| Older app, version 4 backup | Refused ("update the app"). |
| Approval texts, recovery codes, the envelope | No change. |

## 9. Phasing

**Phase 1 can no longer be the phone alone.** With one identity and a shared seed, a second wallet needs the
guardian to derive key 3 at an account and to route by `walletId`; the earlier stopgap (your own invite) is gone too,
since a host refuses a phone pubkey it already knows. So the guardian goes first. Its change is invisible until a
phone uses it, so it can ship in the release before the phone's, or in the same one.

### Phase 1: two Spending wallets on one guardian

| Package | Changes | Tests |
|---|---|---|
| `packages/core` | Nothing new (`bip48Path` already takes an account) | Vectors: phone and key 3 at 0', 2', 4' are unrelated keys |
| `packages/protocol` | `walletId` on the routed methods, `wallet.add.prepare`, `wallet.add`, `wallet_added`, `walletId` on alerts, `guardian.status.wallets`, `own_wallets`; PROTOCOL.md | Strict schemas; requests without `walletId` unchanged |
| `apps/guardian` | `wallets.json`, a `PolicyEngine` and runtime per own wallet, `cosignerFromSeed` with an account, routing, box-wide lock rules, alerts naming the wallet, per-wallet live wallet | The first wallet's `guardian-state.json` byte for byte the same through everything another wallet does; isolation; key 3 per account; accounts never reused; an older client's requests unchanged |
| `apps/guardian-web` | Wallets page; picker on Wallet, Rules, Recovery; merged Activity; Reset text | Page tests |
| `packages/wallet` | The account in key and path derivation; `walletId` on requests; shared secrets; backup version 4 and its restore; rebuilding wallets from `guardian.status.wallets` | Two wallets on one seed against the guardian in-process; backup round trip; restore from an older backup |
| `apps/mobile` | The index, the wallet set in the real service, the switcher, "From" and names in Send and Receive, alert dispatch, add / remove / rename, the device check, the shared-phone notice, the demo | Screen tests; the real service against the rig with two wallets |
| `e2e` | Two wallets on regtest: co-sign each under its own limit, a recovery of one while the other pays, every transaction through `tools/consensus-verify` | |

### Phase 2

Savings for wallets after the first (odd accounts), "Move all wallets" for Replace guardian, per-wallet recovery
sheets printed from the app.

### Later

Silent payments and the helper coin per wallet (at an account per wallet; the guardian's scanner costs CPU per scan
key), wallets of other guardians and hosted wallets in the switcher (question 3), a per-wallet passcode for the
screens, a cap across all wallets of one phone, Recovery Key mode wallets.

## 10. Owner's decisions (2026-11-05)

"The best solution is same phone and guardian wallet, only change the hardware wallet for now; this keeps things
simple." What follows from it:

| Topic | Decision |
|---|---|
| Keys | The same phone seed and the same key 3 seed for every wallet; only the hardware wallet differs. |
| Unlinkability | A BIP 48 account per wallet on the phone and on key 3 (section 2), invisible to the person. A literally shared xpub would link the wallets on chain; accounts avoid that at no cost to simplicity. Hardware wallets stay at their own 0'. |
| Nostr identity | One for the phone; `walletId` in the requests that act on a wallet; old guardians refuse it. |
| Backup | One file, one recovery code: the seed plus the list of wallets; a restore brings them all back. |
| Guardian | Own wallets sharing the key 3 seed at their account, each with its own policy (daily limit, contacts, Delay & Notify); the lock box-wide. BIP 89 for family hosting only. |
| A shared phone | Everyone who unlocks it sees and can spend each wallet up to its limit; the app says so. |
| Daily limits | Per wallet; the app shows the total. No cap across wallets for now. |
| Caps | 8 own wallets per guardian, apart from the 8 hosted; the same 8 per phone. |
| Alerts | Name the wallet once there is more than one; the owner's channels carry them all. |
| The same hardware wallet in two wallets | Refused, also as another wallet's Savings Recovery Key. |
| Per-wallet passcode | Later (and with one seed, a screen lock only). |
| Order | The guardian first, then the phone (section 9). |

### Questions this decision raises

1. **Account numbers.** *Recommendation:* Spending at 2*n*, Savings at 2*n*+1 (wallet 2 at 2' and 3', wallet 3 at
   4' and 5'), key 3 at the Spending number: each wallet's pair stays together and Savings works for every wallet.
   *Alternative:* the example's 2', 3', 4' for wallets 2, 3, 4, with their Savings elsewhere (such as 100' + *n*) or
   no Savings for them.
2. **Who may add a wallet.** *Recommendation:* the paired phone with the new hardware wallet's pairing proof,
   announced to the phone, the owner's channels and the web UI's activity; no trip to the box. *Alternative:* a code
   from the web UI, like the first pairing.
3. **Wallets of other guardians, and hosted wallets, in the same app.** *Recommendation:* later; for now the app holds
   the wallets of one guardian. *Alternative:* now, with a second seed and identity per other guardian, which gives
   up "one backup".
