# Several wallets in one phone app: design proposal

Status: **proposal**, written 2026-11-05 against `main` at `b0c3bb5` (after family hosting phases 1 and 2, Savings,
the live wallet and the web Wallet page). Nothing here is built. The owner's questions are in section 9.

The owner's ask (2026-11-01, deferred then in favour of family hosting): "Allow the same phone app to have multiple
wallets where the only key that changes is the hardware wallet."

**The short answer.**

| Question | Verdict |
|---|---|
| What changes per wallet | The hardware wallet, as asked. Under the hood each wallet also gets **its own phone key** (its own 24 words) and **its own key 3**. The person sees one phone and one guardian; the keys stay apart so the wallets are not linked on chain and one wallet's backup never holds another's key (section 2). |
| The phone | `@trikey/wallet` already keeps a wallet under a storage key of the app's choosing and its secrets under random ids. The app holds several such wallets, shows one at a time and listens for all (section 4). |
| The guardian | Today it guards one wallet of its owner plus hosted guests. It gains **own wallets**: more wallets of its owner, each in its own slot with today's engine (full descriptor, full rule 3, live wallet, Savings). They pair with an ordinary pairing code, so phones need no protocol change (section 3). |
| BIP 89 | Not for own wallets: the owner's guardian just knows both, as it knows the first. Someone who wants privacy from the box's owner uses family hosting, which already exists and works from the same phone. |
| Smallest slice | Phase 1 is the phone only: several wallets in the app, each with its own guardian, a hosted wallet next to your own, or a second wallet on your own guardian through your own invite. Phase 2 adds own wallets on the guardian (section 8). |

## 0. What exists today

| Assumption | Where |
|---|---|
| One wallet per app, per mode and network: `trikey.wallet.<mode>.<network>`, the app's notes under `.app` | `apps/mobile/src/data/real.ts` (`walletKey`, `RealWalletService.w`) |
| The wallet package takes any storage key; secrets get random ids (`trikey.key2.<tag>`, `trikey.nostr.<tag>`), recorded in the state | `packages/wallet/src/wallet.ts` (`WalletDeps.storageKey`, `TrikeyWallet.create`), `state.ts` (`WalletState.secrets`) |
| Key 2 is one 24-word seed: the vault at BIP 48 account 0', Savings at account 1', the helper coin at `m/84'/c'/1'`, silent payments at BIP 352's paths, the nostr identity at NIP-06 account 0 | `packages/wallet/src/keys.ts`, `packages/core/src/network.ts` (`SAVINGS_ACCOUNT`), `packages/protocol/src/identity.ts` |
| The guardian knows a phone only by the nostr pubkey that signs its gift wraps; `pair` requires `phoneNostrPubkey` to equal the sender | PROTOCOL.md sections 1 and 3 ("Pairing"); `apps/guardian/src/service-state.ts` (`phones[]`) |
| The guardian guards one active wallet of its owner (`register` refuses `already_registered`), plus up to 8 hosted guests, each in its own engine, routed by the sender's pubkey; a pubkey belongs to one slot | docs/design/family-hosting.md sections 0 and 2; `apps/guardian/src/hosting/` |
| Key 3 per pairing: `trikey/key3/v1` binds the network, the pairing session and the phone's nostr pubkey; a guest's is `trikey/key3-hosted/v1` | DESIGN.md "Entropy"; `apps/guardian/src/keystore.ts` |
| The backup is one file per wallet, `trikey-backup-<random id>.tkb`; the header names no wallet; a new backup replaces only that wallet's previous file; restore picks the newest file | `packages/wallet/src/backup.ts`; `TrikeyWallet.createBackup`, `findBackup` |
| Savings is a second wallet inside a wallet (same phone seed at account 1', the same hardware wallet, a Recovery Key), shown next to Spending | DESIGN.md "Savings"; docs/design/savings-and-limit-off.md |
| Key 2 sits behind the phone's biometrics; viewing balances needs no unlock | `SecureKeyStore.save(..., { requireBiometrics: true })` for key 2 only |

## 1. Goal and scope

**What "several wallets" means here.** One phone app holds several guardian-mode wallets. Each is a whole Trikey
wallet as today: its own hardware wallet (key 1), its own phone key (key 2), its own key 3, its own rules, alert
contacts, recoveries, backup, and optionally its own Savings. The app shows one at a time and switches between them.

**The literal reading**, and the two cases it fits:

1. **A household sharing one phone and one guardian**, two people each with their own hardware wallet.
2. **One person with two hardware wallets** for separate purposes ("Daily" on a Trezor, "Business" on a Ledger).

**The nearby readings:**

| Reading | Covered? |
|---|---|
| Several guardians: one wallet on your box, one on your parents' box | **Yes, phase 1.** Each wallet pairs with its own guardian as today. |
| A hosted wallet next to your own (you are a guest on someone's guardian and also have your own) | **Yes, phase 1.** One wallet is an ordinary pairing, the other an accepted invite. |
| Savings | **Unchanged.** It stays part of each wallet (each wallet may have its own), not an entry in the switcher. |
| A second wallet with the same hardware wallet | **No** in phase 1 (section 2). Savings already covers "a second pot with the same device". |
| Recovery Key mode wallets in the switcher | **Later.** It is its own service in the app (`rk-service.ts`) and stays on test networks. |
| Wallets on different networks side by side | **No.** All wallets in the app share the network the app runs on. |
| One wallet on several phones | **No.** A wallet has one phone key. |
| Two guardians sharing key 3 of one wallet | **No.** Another script, a separate design (family-hosting.md section 1). |

**Out of scope:** hiding a wallet, a cap across wallets (section 9, question 7), moving coins between wallets other
than as an ordinary payment.

## 2. Keys and scripts

Every wallet stays `wsh(sortedmulti(2, key2, key1, key3))` on BIP 48, exactly as today.

### The phone key (key 2): its own seed per wallet

| | How | For | Against |
|---|---|---|---|
| L. The same key 2 in every wallet (the ask read literally) | Every wallet uses the same phone account xpub | One seed | **Links the wallets on chain**: the phone's child key at the same index is the same pubkey in both scripts, visible in every spend's witness. One backup holds both people's key 2. One nostr identity for all, so the guardian cannot route by sender. Rejected. |
| A. One seed, one BIP 48 account per wallet | Wallet *n* at account 2*n* (account 1' is Savings), Savings at 2*n*+1 | One set of 24 words | Every path scheme changes: Savings' fixed account 1', the helper's `m/84'/c'/1'`, the silent payment paths, the nostr identity's NIP-06 account. A restore must scan accounts. A household's two members share one backup, so each holds the other's key 2. |
| **S. One seed per wallet** (recommended) | `TrikeyWallet.create` once per wallet | Each wallet is today's wallet: every path, the backup format and Savings unchanged. Its own nostr identity comes from its own seed. Removing a wallet forgets one seed. A household member's backup holds only their own key. | One more backup per wallet (section 4 keeps it to one step). |

**Recommendation: S.** The person still sees "only the hardware wallet changes": the new phone key is made and backed
up by the app in the same flow.

### The hardware wallet (key 1)

Each wallet's own device at BIP 48 account 0', with its authorization key at `<account>/0/0`, as today. The app
refuses a device whose master fingerprint already belongs to another wallet on this phone ("This Ledger already holds
'Daily'. Use Savings for a second pot with it."). Two reasons: the same device at account 0' would put the same
hardware pubkeys in both wallets (linked on chain), and the same authorization key in two wallets makes an old
`recovery.access` text (version 1, without a wallet id) ambiguous. A second wallet on the same device at account 2'
and up is possible later; it needs a new account rule and a device test.

The device registers each wallet under its own name ("Trikey Daily", at most 16 characters), so its screen says which
wallet it signs for.

### Key 3: always its own

Key 3 is per wallet whatever the guardian does: `trikey/key3/v1` binds the pairing session and the phone's nostr
pubkey, and each wallet has its own of both. A guest slot's key is `trikey/key3-hosted/v1`. No new derivation.

### On the guardian: a second wallet of the owner, against a hosting slot

| | What the guardian knows | Rule 3 | Chain data for the phone | Features |
|---|---|---|---|---|
| **Own wallet** (new, recommended for the owner's wallets) | The full descriptor, as for the first wallet | Full (change within the gap window, coverage scan) | From the guardian (live wallet, `wallet.sync`) | All of today's: limit off, contact lock, Savings watch, live wallet, owner channels; silent payments later |
| **Hosted wallet** (built) | Account pubkeys only (BIP 89) | Tweak-proven change plus the ledger | The phone's own or a public Esplora | Limit, delay, contacts, limit off, per-slot pause; no Savings, no silent payments, no live wallet, no Speed up |

An own wallet is the "shared mode" family-hosting.md left for later (decision 1), for a wallet the box's owner answers
for. **BIP 89 does not apply to it:** BIP 89 hides a wallet from the box's owner, and here the owner is the one who
adds it. A household member who wants privacy from the box's owner takes a hosted slot instead (an invite from the
Host page), from the same phone or their own.

**Reusing the slot engine.** Hosting's `HostedEngine` is a separate engine for wallets without a descriptor; an own
wallet needs the host's `PolicyEngine`, which already is a single-wallet state machine with rotation and retirement.
So: one `PolicyEngine` per own wallet, with hosting's pattern around it (a slot registry, a directory per slot, routing
by sender). Per-wallet key 3 and per-wallet rules come with the engine.

## 3. Guardian side

### Storage

```
<dataDir>/guardian-state.json            the first wallet, unchanged (version 2, the golden file)
<dataDir>/service.json                   unchanged (relays, phones, sweeps)
<dataDir>/hosting.json, hosted/<slotId>/ unchanged (guests)
<dataDir>/wallets.json                   NEW: own wallets: slot id, the owner's name for it, state, phone pubkey, key-3 mix record
<dataDir>/wallets/<slotId>/guardian-state.json   NEW: that wallet's engine state, the same version-2 format
<dataDir>/wallets/<slotId>/live-wallet.json      NEW: its live wallet cache (likewise its Savings watch and sweeps)
```

Absent `wallets.json`: no own wallets, which is every guardian today, and every code path runs as before. Own wallets
are counted apart from guests: at most 4 own wallets next to the first, and 8 hosted (question 12).

### What runs per wallet, and what stays shared

Today the `Guardian` class wires one engine to its helpers: the recovery runner, the live wallet, the Savings monitor,
`RecentlyCosigned` and `KnownCoins`, the silent payment scanner, the single-key coins. That wiring becomes a
**per-wallet runtime** (engine plus helpers); the first wallet is runtime 0 with its files where they are. This is
the bulk of the work.

| Per wallet | Shared by the box |
|---|---|
| Key 3, rules, daily limit window, delay, fee cap, alert contacts, contact-lock setting, limit off | The guardian's nostr identity and relays (`relays_changed` goes to every wallet's phone, as it does to guests') |
| Recoveries (ids carry the slot as guests' do, `<slotId>w<n>-<txid12>`, which fits `RecoveryId` and `CANCEL <id>`), Delay & Notify, rotation, retirement | Lock and unlock (key 3 of every wallet in memory or none), the passphrase |
| Live wallet scripts, `wallet_tx` to that wallet's phone, Savings watch, `tx.broadcast` shortcuts by wallet id | The chain source and its tip; the three clocks |
| Activity log (the web UI merges them) | Reset (forgets every own wallet) |

### Pairing an own wallet

1. **Web UI**, Wallets page: "Add a wallet", with a name ("Ben", "Business"). The guardian makes a pairing code bound
   to a new slot: the same `trikey://pair` code, same rules (24 hours at most, single use, the secret kept as a hash,
   surviving a restart as invites do).
2. **Phone**: an ordinary pairing (`pair.prepare`, `pair`) from the new wallet's own nostr identity. The guardian sees
   which code was used and registers the wallet in that slot's engine. Key 3 is `trikey/key3/v1` with that pairing's
   session id.

So **phones need no protocol change**: an older app can pair an own wallet too (on its own phone). The guardian checks
what `register` checks today, plus: the phone pubkey is in no other slot (host, own or guest), and the hardware account
key is in no other active wallet on this box.

Why a code from the web UI, and not a request from an already paired phone: adding a wallet is the box owner's call,
the same as the first pairing. A phone thief should not be able to add wallets to the owner's box. (Alternative in
question 9.)

### Routing

By sender, as for guests. Each own wallet's phone gets every method the first wallet's phone gets, on its own
wallet: `sign`, `policy.*`, `recovery.*`, `wallet.sync`, `tx.*`, `savings.*`, `phone.resume`, `hardware.confirm`,
`wallet.retire`, `guardian.status` (its wallet's view). A wallet's phone never reaches another wallet. Alert contacts:
`recovery.cancel` and `CANCEL <id>` find the wallet by the recovery id. `recovery.access` is tried against each
wallet's hardware authorization key; the version-2 text names the wallet id.

### Rules per wallet

- **Daily limit:** per wallet, each with its own window. A payment from one own wallet to another counts like any
  payment, as payments into Savings do (owner's decision, 2026-11-01): a thief gains nothing by calling a wallet of
  their own "the other wallet". The app shows the total a phone thief could reach (section 6).
- **Alert contacts:** per wallet. One person can be a contact of several. On mainnet each wallet needs at least one.
  Contacts' DMs name the wallet by the name the owner gave it when the box has more than one wallet ("Business:
  recovery started"); with one wallet they stay as today.
- **Delay & Notify:** per wallet. A recovery of one wallet pauses phone-only payments of that wallet only.
- **Limit off, contact lock:** per wallet, with today's rules and approval texts (`wallet=` names that wallet).

### Lock, pause and unlock

- **Lock stays global.** One passphrase unlocks every key 3; a restart locks them all.
- **An own wallet's phone acts like the first wallet's phone** (recommended, question 6): `guardian.lock` locks the
  box, `guardian.unlock` with the passphrase unlocks it (the per-phone throttle as today), and its contacts' `LOCK`
  locks the box when its contact lock is on. Locking only removes capability, and own wallets are the owner's.
- **One extra rule:** `guardian.unlock` is refused while a recovery of **any** wallet runs that this phone did not
  start (today: of its wallet). A thief holding the phone holds every wallet's phone key.
- The alternative is hosting's per-wallet **pause** for own wallets too: the phone and its contacts stop only that
  wallet, its hardware wallet resumes it. Better when the wallets belong to different people; more code paths.

### Notifications

- **Nostr alerts** go to the wallet's own phone identity and the wallet's contacts.
- **The owner's channels** (email, ntfy, webhook) carry every own wallet's alerts, each line naming the wallet,
  with a per-wallet "send to the owner's channels" switch in the web UI (on by default). A contact's email or ntfy
  carries the alerts of the wallets that list that contact. Guests stay as they are (no channels).
- Changes to these settings are announced as today, on every channel and to every wallet's phone.

### Web UI

- **Wallets page** (new): each wallet with its name, its phone, its state (paired, recovering, retired), "Add a
  wallet", and a recovery code per wallet (`trikey://recover?...&wallet=<id>`).
- **Wallet page per wallet** (the page from #120): a wallet picker at the top; `GET /api/wallet` stays the first
  wallet's, `GET /api/wallets` and `GET /api/wallets/:id` serve the others, view and receive only, also while locked.
- **Rules and Recovery:** per wallet, with the same picker. **Activity:** merged, with a wallet column and a filter.
- **Reset:** lists every wallet it forgets; refused while any wallet's recovery runs or a sweep waits (today's rule
  over every wallet). Hosting's refusal is unchanged.

## 4. Phone side

### Storage and the switcher

- Each wallet is one `TrikeyWallet` under its own storage key: the first keeps `trikey.wallet.<mode>.<network>`
  untouched; the others take `trikey.wallet.<mode>.<network>.<tag>` (8 random bytes). Secrets already have their own
  ids.
- A small index, `trikey.wallets.<mode>.<network>`: the order, each wallet's storage key and name, and the one shown
  last. No index: one wallet, which is every install today.
- **Home** gets a switcher at the top: the wallet's name and its device ("Daily · Trezor Safe 3"). Tapping it opens a
  sheet with every wallet and its balance, and "Add a wallet".
- At most 8 wallets per phone.

### Which wallet pays and receives

- **The wallet shown pays and receives.** Send's review screen starts with "From: Daily" and the device it will need;
  Receive shows the wallet's name above the address. Switching wallets cancels a quote in progress.
- A scanned or opened payment request (`bitcoin:` URI) opens Send in the wallet shown, with "From" changeable before
  review.
- The wrong device is caught: the app checks the connected device's fingerprint and says "This is the Ledger of
  'Business'. Connect the Trezor of 'Daily'." (The device could not sign anyway: it holds the other registration.)
- Alerts for a wallet not shown name it ("Business: payment received") and tapping one switches to it.

### Background

Every wallet stays open for alerts: one relay connection per relay, shared by all wallets, with each wallet's own
subscription. The wallet shown syncs as today; the others sync on their `wallet_tx` alerts and every 10 minutes, so
the switcher's balances stay fresh.

### Adding a wallet

Settings > Wallets > "Add a wallet": a name, then the usual onboarding steps for a new wallet: connect the hardware
wallet, make the phone key, then one of:

- **"With my guardian"**: scan the "Add a wallet" code from the guardian's web UI (phase 2). The app recognises the
  guardian (same npub as another wallet) and keeps its relays. An older guardian answers `already_registered`; the app
  says "Your guardian guards one wallet. Update it, or make an invite on its Host page."
- **"With another guardian"**: scan its pairing code (phase 1).
- **"With an invite"**: a family-hosting invite (phase 1), including one from your own guardian's Host page.

Then rules, alert contacts (offering the other wallets' contacts), and the backup.

### Backups

- **One file per wallet**, today's format (payload version 1, 2 with Savings, 3 hosted), so an older app can restore
  each file.
- **"Back up all wallets"** makes them in one step. The same passkey seals every file (each with its own PRF salt).
  The recovery code: one per wallet by default; the person may use **one code for the wallets they choose** (theirs,
  not their partner's): the app keeps it in memory during that one step, never on disk (question 8).
- **Restore** lists every backup in the cloud store, opens each with the passkey or a code, and restores the newest
  file per wallet id. Today's `findBackup` picks one newest file; it gains a "list all" sibling.
- The guardian's recovery code is per wallet (`&wallet=<id>`); the printed sheet names the wallet.

### The phone's nostr identity

**One per wallet** (recommended, question 3), from each wallet's own seed (NIP-06 account 0, as today).

| | Privacy | Simplicity |
|---|---|---|
| **Per wallet** | The guardian treats each wallet as if it had its own phone. Relays can still link them (one IP, one connection, the same moments) | No protocol change: routing by sender works as for guests; a restored backup finds its slot by itself |
| One for all | Relays and the guardian see one pubkey for all wallets | Needs a wallet field in every request and a new pairing for every wallet but the first; the guardian's "a pubkey belongs to one slot" goes |

### Removing a wallet

Settings > Wallets > a wallet > "Remove from this phone". Allowed when the wallet is empty, or when its backup is newer
than its last change (the app checks and says so). If it is empty, the app first offers to release it on the guardian
(`wallet.retire`, hardware approval), so the slot frees up. Removing deletes that wallet's state, its secrets and its
index entry; nothing of the other wallets is touched.

### Savings per wallet

Each wallet may have its own Savings: its own seed at account 1', its own hardware wallet and its own Recovery Key.
Home shows the current wallet's Spending and Savings. Own wallets on the guardian get the Savings watch; hosted
wallets still do not (family-hosting decision 12).

## 5. Recovery

| Situation | What happens |
|---|---|
| Lost phone, backups | Restore every wallet's file on the new phone (one passkey opens them all). Nothing changes on the guardian: each wallet's identity comes from its seed. |
| Lost phone, no backup | Per wallet, as today: its recovery code, its hardware wallet's `recovery.access`, Delay & Notify, a sweep to a new wallet that the guardian adopts. Several recoveries can run at once, each with its own delay and alerts. A household's members each recover their own. |
| Lost phone, some backups | Restore those; recover the others with their hardware wallets. |
| Lost one hardware wallet | Only that wallet: its seed words, or Delay & Notify with phone + guardian. The other wallets are untouched. |
| Guardian dies or is stolen | Every wallet's money still moves with the phone and that wallet's hardware wallet. "Replace guardian" runs per wallet; the app offers "Move all wallets" and walks through them one device at a time ("2 of 3 moved"). The new guardian needs one pairing code per wallet in phase 2 (question 10). |
| Guardian reset | Forgets every own wallet, as it forgets the first today; refused while any recovery runs. |

## 6. Privacy and threat model

- **A shared phone is a shared key.** Phone biometrics are per device, not per person: everyone who can unlock the
  phone can see every wallet's balance and history, and can spend from each wallet up to its daily limit with phone +
  guardian. The hardware wallets keep the rest apart: nobody raises another's limit, turns it off or approves a rule
  change without that wallet's device. The app says this when a second wallet is added to a phone that already has
  one: "Anyone who can unlock this phone can see this wallet and spend up to its daily limit."
- **Recoveries between household members.** With the phone, one member can start a recovery of the other's wallet
  (phone key survives, a new "hardware" key). Its alert reaches the shared phone, which both use, and the wallet's
  alert contacts, who can cancel. Mainnet already requires a contact; for a household the app suggests one outside it.
- **The box's owner sees every own wallet**: balances, addresses, payments, Savings, as for the first. Someone who must
  not be seen by the owner uses a hosted slot (BIP 89), ideally from their own phone.
- **A stolen phone now exposes every wallet on it:** the sum of their daily limits per day (the app shows it), every
  wallet's history, and every wallet's contested-recovery stalemate. Each wallet's alerts and contacts still work.
  Locking the guardian from the web UI stops all of them at once.
- **Per-wallet app lock?** OS biometrics cannot tell household members apart, so a per-wallet Face ID adds nothing. A
  per-wallet passcode mixed into key 2's encryption could; it is a later option (question 11).
- **Relays** can link one phone's wallets (one IP, one connection, the same moments). They see ciphertext only.
- **The guardian keeps wallets apart:** a wallet's phone cannot read, sign for or recover another wallet; only lock
  and unlock are box-wide.

## 7. Compatibility and migration

| Combination | What happens |
|---|---|
| Existing single-wallet install | Unchanged: same storage key, no index. Adding a wallet writes the index and leaves the first wallet's state as it is. |
| App downgraded with several wallets | The older app opens the first wallet only; the others' state and secrets stay untouched until the newer app is back. |
| Older app restoring from a cloud with several backups | It restores the newest file only (`findBackup`). The others stay in the store; the release notes say so. |
| New app, older guardian (phase 2 feature missing) | A second `pair` is refused with `already_registered`; the app explains. Other guardians and invites work. |
| Guardian downgraded with own wallets | The older version ignores `wallets.json`: those wallets' phones get no answers; their money moves with phone + hardware wallet. The release notes say so. |
| Older app pairing an own wallet | Works: it is an ordinary pairing. |
| Backups, recovery codes, approval texts | No format change. |
| Protocol | No new method or field for phones. PROTOCOL.md notes that one guardian may guard several wallets of its owner, routed by the sender's pubkey, and that contacts' DMs may name a wallet. |

## 8. Phasing

### Phase 1: the phone only (no guardian change)

The app holds several wallets: the index, the switcher, "From" and wallet names in Send and Receive, alerts for every
wallet, "Add a wallet" with another guardian or with an invite, per-wallet backups with "Back up all", restore of
every file, removal, the shared-phone notice.

What it covers: several guardians; a hosted wallet next to your own; and the literal ask through **your own invite**: a
second wallet hosted on your own guardian. That second wallet has hosting's limits (no Savings, no live wallet, chain
data from an Esplora server of your own or a public one; key 2 backup required), and the invite
screen, recognising your own guardian, says so plainly instead of warning about a dishonest host.

| Package | Changes | Tests |
|---|---|---|
| `packages/wallet` | `listBackups` next to `findBackup`; a relay pool several wallets can share (a wallet closes only a pool it opened); otherwise one `TrikeyWallet` per wallet, unchanged | Several wallets on one store and secure store, apart; list and restore of several files |
| `apps/mobile` | The index, a wallet set in the real service, the switcher, Send/Receive wallet names, background listening, add / remove / rename, "Back up all", restore of several, the device-fingerprint check, the shared-phone notice, the demo | Screen tests; the real service against the rig with two wallets on two guardians and a hosted one |
| Docs | DESIGN.md, the alpha test plan (two wallets on one phone) | |

### Phase 2: own wallets on the guardian

`wallets.json`, a `PolicyEngine` and runtime per own wallet, codes from "Add a wallet", routing, per-wallet live
wallet and Savings watch, box-wide lock rules, owner channels per wallet, the Wallets page, the Wallet, Rules and
Recovery pages per wallet. The phone gains nothing but the "With my guardian" path, already shaped in phase 1.

Tests as hosting's: the first wallet's `guardian-state.json` byte for byte the same through everything an own wallet
does; isolation between wallets; key 3 differs per wallet; a phone pubkey in one slot only; reset, relays and lock over
every wallet.

### Later

Silent payments per own wallet (the scanner's CPU grows with every scan key), a per-wallet passcode, Recovery Key mode
wallets in the switcher, one pairing code for several wallets (Replace guardian for a household), a second wallet on the
same hardware wallet at another account.

## 9. Open questions for the owner

1. **What "only the hardware wallet changes" means.** *Recommendation:* to the person, yes: same phone, same guardian,
   another hardware wallet. Under the hood each wallet gets its own phone key and key 3. *Alternative:* literally the
   same phone key in every wallet: one backup, but the wallets are linked on chain and a household shares one key.
2. **Phone key per wallet.** *Recommendation:* its own 24 words per wallet. *Alternative:* one seed, a BIP 48 account
   per wallet: one set of words, every path scheme changes, household members share a backup.
3. **Nostr identity.** *Recommendation:* one per wallet, from its seed; no protocol change. *Alternative:* one for all
   with a wallet field in every request.
4. **A second own wallet on the guardian.** *Recommendation:* own wallets in shared mode (the guardian knows the
   descriptor; every feature). *Alternative:* only hosted slots (BIP 89) for yourself, which works today with
   hosting's limits.
5. **Phasing.** *Recommendation:* the phone first (phase 1), with your own invite as the stopgap for the literal ask;
   own wallets on the guardian in phase 2. *Alternative:* ship both together.
6. **Lock for own wallets.** *Recommendation:* box-wide, like the first wallet's (phone lock, contacts' `LOCK`,
   passphrase unlock). *Alternative:* hosting's per-wallet pause, better when the wallets belong to different people.
7. **Daily limits.** *Recommendation:* per wallet; the app shows the total a phone thief could reach. *Alternative:* an
   extra cap across all wallets of one phone (the guardian would have to be told which wallets share a phone).
8. **Backups.** *Recommendation:* one file per wallet, one passkey for all, one recovery code per wallet unless the
   person chooses one for several of their own. *Alternatives:* strictly one code per wallet; or one combined file (a
   new format, and members of a household share it).
9. **Who may add a wallet on the guardian.** *Recommendation:* a code from the web UI, like the first pairing.
   *Alternative:* an existing wallet's phone with its hardware approval, no trip to the web UI.
10. **Replace guardian for several wallets.** *Recommendation:* one code per wallet in phase 2; a code for several
    later. *Alternative:* build the multi-wallet code in phase 2.
11. **Per-wallet passcode on a shared phone.** *Recommendation:* later; phase 1 states plainly what a shared phone
    means. *Alternative:* a passcode per wallet in phase 1.
12. **Caps.** *Recommendation:* 8 wallets per phone; 4 own wallets per guardian next to the first, apart from the 8
    hosted. *Alternative:* own wallets share hosting's 8.
13. **The owner's email, ntfy and webhook for own wallets.** *Recommendation:* every own wallet's alerts, named, with
    a per-wallet switch (on by default). *Alternative:* the first wallet's only, as for guests.
14. **The same hardware wallet in two wallets.** *Recommendation:* refused; Savings is the second pot for one device.
    *Alternative:* allow it at BIP 48 account 2' and up.
