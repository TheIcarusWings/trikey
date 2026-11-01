# Guardian for family (hosting a guardian for someone): design proposal

Status: **phase 1 built** (2026-11-01, branch `feature/family-hosting`). Written as a proposal the same day against
`main` at `b8fd81c` (after Savings); the owner's decisions are recorded in section 14, and what was built, where it differs
from the proposal and what is still open are in section 15. Sections 0 to 13 are the proposal as reviewed; where the
build differs, section 15 says so.

Someone who runs a Trikey Guardian (the **host**) holds key 3 for a person they know (the **guest**), who has no home
server. The guest keeps key 1 (their own hardware wallet) and key 2 (their own phone). DESIGN.md fixes four things:
invite-only; a separate key per hosted wallet; BIP 89 chaincode delegation (`packages/core/src/tweak.ts`) so the host
does not learn the guest's addresses or balance; and the app must say, when an invite is accepted, that a dishonest host
could skip the delay and suppress alerts while teaming up with a thief.

**The short answer.** Hosting is feasible with BIP 89, with one rule weaker than for the host's own wallet and one new
cost:

| Question | Verdict |
|---|---|
| Daily limit without addresses (section 4) | **Feasible, exactly.** Core already counts `Σ inputs − Σ outputs proven by delegated tweaks` (`analyzePsbt`, `packages/core/src/psbt.ts`). What is **not** feasible is rule 3's "change only within reach of a scan": the guardian can prove an output belongs to the guest's three account keys, never that it sits at an index the guest's hardware wallet can sign. A phone thief can therefore park coins where only key 2 + key 3 reach them, at no cost against the limit. That freezes coins; it steals nothing. Mitigated by a key 2 backup (required for guests) and a ledger of every coin key 3 co-signed. |
| Recovery without addresses (section 5) | **Feasible.** The guest's surviving key and phone build the sweep from their own chain data, as today's phones already do; the host checks everything it can without addresses (keys, signatures, destination, fee cap, the three clocks) plus "every coin I co-signed is in the sweep". It cannot check that the sweep holds every coin received from outside: that becomes the guest phone's job. A guest without any backup is saved by an encrypted **wallet map** the host stores but cannot read (key from the hardware wallet's chaincode). |
| Chain data for the guest's phone (section 6) | **Not from the host** (it would learn every address). Phase 1: the guest's own Esplora if they have one, else a public Esplora through the Recovery Key mode client (`EsploraChainSource`, `packages/recovery-key/src/esplora.ts`), which sees the guest's addresses and IP address. That trade is the price of hiding them from the host, and the app must say so. |

The recommended architecture keeps the host's own wallet byte for byte as today: one policy engine per hosted wallet
("slot"), each in its own directory, next to the untouched `guardian-state.json` (section 2).

## 0. What exists today

### The guardian guards one wallet

| Assumption | Where |
|---|---|
| One active wallet plus retired ones: `GuardianState.active`, `retired[]`, one `hardwareSequence`, one `recoveries[]`, one activity log | `apps/guardian/src/policy/types.ts` (`GuardianState`, `GuardedWallet`) |
| Every engine method works on `draft.active`; `register` refuses with `already_registered` when one exists | `apps/guardian/src/policy/engine.ts` (`register`, `cosign`, `startRecovery`, ...) |
| The wallet is a full descriptor: `MultisigWallet.fromDescriptor(reg.descriptor)` | `engine.ts` `wallet()`, `nostr/handlers.ts` `walletOf()` (a cache of 8) |
| Change is change only if it pays `wallet.derive(chain, index)` within `CHANGE_WINDOW` (20) of the high-water marks | `apps/guardian/src/policy/inspect.ts` (`paysDerivedAddress`, `CHANGE_WINDOW`, `MAX_SELF_INDEX`) |
| A recovery completes only if the sweep spends every unspent coin of the wallet's derived addresses (gap limit 20, from the marks) | `apps/guardian/src/recovery-runner.ts` (`checkCoverage`) |
| The hardware authorization key must derive from the hardware xpub in the descriptor at `<account>/0/0` | `engine.ts` (`authKeyMismatch`); docs/design/hardware-auth-path.md |
| Wallet id = `sha256(descriptor)[:16]`; "same wallet" is compared by the sorted account pubkeys | `packages/core/src/wallet.ts` (`fingerprint`), `engine.ts` (`keySetOf`) |
| Who may call what: the paired phone everything; recovery-access phones `RECOVERY_PEER_METHODS`; contacts `recovery.cancel`; strangers `recovery.access` and pairing | `apps/guardian/src/guardian.ts` (`authorize`, `isKnownSender`) |
| Pairing: one session at a time, 5 minutes, memory only, 32-byte secret | `apps/guardian/src/pairing.ts` (`PAIRING_TTL_MS`); `packages/protocol/src/pairing.ts` |
| Key 3 per pairing: `trikey/key3/v1` from the setup seed, the phone's `c` and the pairing context; without `entropy`, the guardian's own key | `apps/guardian/src/keystore.ts` (`key3`, `key3Context`); DESIGN.md "Entropy" |
| The phone gets key 3 as the guardian's real account xpub (its real chaincode) | `nostr/handlers.ts` (`ownKey`, `guardianKey`); `packages/wallet/src/wallet.ts` (`keyExpressionOf(prep.guardianKey)`) |
| The phone's chain data all comes from the guardian (`GuardianChainSource`), built inside the wallet | `packages/wallet/src/chain.ts`, `packages/wallet/src/wallet.ts` (`this.chainSource ??= new GuardianChainSource(...)`) |
| Savings watch, silent-payment scanning, single-key coins, the replaced wallet: all belong to the one active wallet | `apps/guardian/src/savings.ts`, `silent/`, `singlekey.ts`; `GuardedWallet.watched/savings/singleKey` |
| Reset forgets every wallet and makes a new seed, so every key 3 changes | `guardian.ts` (`reset`); DESIGN.md "Reset guardian" |

### What BIP 89 delegation already gives

`packages/core/src/tweak.ts` computes, for a non-hardened path, the sum of the BIP 32 `IL` values ("tweak"), so a child
key is `account key + tweak·G`. Every PSBT carries one tweak per role in a `CCDT` proprietary field
(`MultisigWallet.psbtFields`). Core's `analyzePsbt` matches **inputs** by account pubkeys plus those tweaks
(`delegatedScripts`) and marks an **output** `isSelf` when its tweaks rebuild its script from the account pubkeys. Key 3
already signs as `account key + tweak` (`apps/guardian/src/policy/signer.ts`, `addCosignerSignatures`). What the guardian
adds today on top of core is the descriptor: the change window and the coverage scan. `cosignerKeyExpression` and
`bareKeyExpression` (`packages/core/src/wallet.ts`) already build a key 3 xpub from a raw account pubkey and an
**app-chosen chaincode**; nothing uses them yet.

### The UI the owner has seen

| Mockup | What it promises |
|---|---|
| `apps/guardian-web/src/pages/host.tsx` (behind `VITE_FEATURE_HOST_FOR_SOMEONE`, `src/lib/features.ts`), data in `src/api/mock.ts` (`hostedWallets`: Ana active, Dad invited) | "Host a guardian for someone"; a name only the host sees; a one-time invite link and QR, expiring after 24 hours; "You can't spend their money or see their balance"; per wallet "Since ..., 7-day recovery wait", "Signed 2 payments this week"; "To stop hosting, ask them to choose Replace guardian first". |
| `apps/guardian-web/src/api/types.ts` (`FamilyInvite`, `HostedWallet`, `HostingOverview`) | `HostedWallet.paymentsThisWeek`: "The host never sees amounts or balances." |
| `apps/guardian-web/API.md` "Hosting for family"; `apps/guardian/src/http/api.ts` | `GET /api/hosting` answers empty; `POST/DELETE /api/hosting/invites` answer `501 not_available`. |
| `apps/mobile/app/(onboarding)/guardian-invite.tsx`; `design/screens/Family-Invite.dc.html`, `Family-Accept.dc.html` | "Maria invites you to use her guardian": what Maria can't do (spend, lock you out, raise your limit, see your balance or addresses), what you trust her with (box online, honest wait and alerts, never helping a thief). |

This design keeps that UI. Section 9 lists the few sentences that must change to be true (amounts the box does see, and
the dishonest-host sentence DESIGN.md requires).

## 1. Terms and goals

- **Host slot:** the host's own wallet, exactly as today (`guardian-state.json`).
- **Guest slot:** one hosted wallet with everything that belongs to it: its key 3, registration, rules, limit window,
  recoveries, retired wallets, notices, activity, the ledger (section 4) and the wallet map (section 5).
- **Private mode:** the guest sends only account pubkeys and per-PSBT tweaks (BIP 89). This design's default.
- **Shared mode:** the guest sends the full descriptor, so the slot works exactly like the host's wallet (full rule 3,
  coverage scan, chain data from the host's Electrs). Discussed as an alternative (decision 1); not in phase 1.

Goals: the host's wallet behaves exactly as today; a guest cannot touch or read the host's wallet or another guest's;
the host learns no guest address it did not co-sign and no balance; every guest's money moves with the guest's phone and
hardware wallet alone, whatever the host does. Non-goals: protecting a guest from a host who teams up with a thief (it
cannot be done with this script; section 13), and two hosts sharing key 3 (DESIGN.md "Later still"; it needs a different
script, so a separate design).

## 2. A guardian with several wallets (question 1)

### Options

| | How | For | Against |
|---|---|---|---|
| **A. One state, many wallets** | `GuardianState` version 3: `wallets: Record<slotId, GuardedWallet & {...}>`, a migration from version 2 | One file, one save | Every engine method changes (`draft.active` is used throughout `engine.ts`); the host's wallet goes through a migration and new code paths; one guest's flood of activity entries shares the host's caps (`DEFAULT_MAX_ACTIVITY`, `DEFAULT_MAX_REFUSALS`) |
| **B. One engine per slot** (recommended) | The existing `PolicyEngine` once per slot, each with its own `StateStore` and file; a small registry of slots; `Guardian` routes each request to one engine | The host's engine and file are untouched (no migration); each guest has its own mutex, caps, counters and recovery ids; removing a guest is retiring one engine | The engine learns a "delegated" registration (section 4); chain time and the signer are wired per engine; routing in `guardian.ts` |
| C. One guardian process per guest | A second container per guest | Strong isolation | Several nostr identities, unlocks and Umbrel apps for one box; not what the mockup shows |

**Recommendation: B.** The engine is already a single-wallet state machine with rotation and retirement; hosting is
several of them side by side, not one bigger one.

### Storage

```
<dataDir>/guardian-state.json          host slot, unchanged (version 2)
<dataDir>/service.json                 unchanged (relays, host's phone, sweeps of the host slot)
<dataDir>/hosting.json                 NEW: invites (secret hashes), slot registry
<dataDir>/hosted/<slotId>/state.json   NEW: the guest slot's GuardianState (same format, delegated registration)
<dataDir>/hosted/<slotId>/slot.json    NEW: the slot's sweeps (SweepRecord), ledger, wallet maps
```

`hosting.json` holds, per slot: `slotId` (12 random bytes, hex), the host's private name for the guest ("Dad"), state
(`invited`, `active`, `leaving`, `left`), invite id, created/accepted times, the guest phone's nostr pubkey, and the key-3
mix record (section 7). Absent file: no guests, which is every guardian today. An older guardian ignores the new files
(guests then get no answers; their money still moves with phone + hardware wallet).

### What changes in the engine

- `Registration` gets `mode?: 'delegated'` and, in that mode, `accountPubkeys: { app, hardware, cosigner }` instead of
  `descriptor`, and `hardwareAuth.tweak` (section 7). Absent `mode`: today's registration, so the host's file is read
  unchanged.
- `wallet(reg)` returns either `MultisigWallet` (full) or an account-keys-only view; `inspectPsbt` gets a delegated path
  (section 4). `keySetOf` already works on account pubkeys.
- `startRecovery`, `updateRecovery`, `completeRecovery`, `rotateAfterSweep` take the destination as account pubkeys in
  delegated mode (section 5).
- Per-engine options: `maxActivity` 1,000 and `maxRefusals` 200 for guests (host: today's 5,000 and 1,000), a ledger
  cap (2,000 unspent coins), notices as today (`MAX_NOTICES` 32), access grants as today (`MAX_ACCESS_GRANTS` 8).
- Recovery ids carry the slot (`<slotId>-<n>-<txid12>`), so `recovery.cancel` and the `CANCEL <id>` DM
  (`dm-cancel.ts`) find the right slot.

### Routing (how a request names its wallet)

Each guest phone is its own nostr peer, so **the sender names the slot**; no wallet field is added to the envelope
(`packages/protocol/src/envelope.ts`, `PROTOCOL_VERSION` stays `'1'`).

| Sender | Slot | Methods |
|---|---|---|
| The host's paired phone | host | everything, as today |
| A guest's paired phone | that guest's | `sign`, `policy.get`, `policy.update`, `recovery.*`, `phone.resume`, `hardware.confirm`, `wallet.retire`, `guardian.status` (the slot's view), `fees.estimate`, `tx.broadcast` (only transactions this slot co-signed or swept), `relays.ack`, `hosted.coins`, `hosted.map.get` |
| A phone with recovery access to a guest slot | that slot | the same subset as `RECOVERY_PEER_METHODS`, minus `wallet.sync` and `tx.get`, plus `hosted.coins`, `hosted.map.get` |
| An alert contact | every slot that lists it | `recovery.cancel` (by recovery id), `CANCEL <id>` DMs |
| A stranger | none | `recovery.access` (tried against each slot's hardware key, version-2 text only for guest slots), `hosted.prepare` / `hosted.pair` while an invite is pending, `pair.prepare` / `pair` as today |

A phone pubkey belongs to one slot only: pairing refuses a guest phone that is the host's phone or another guest's.
Guests never get `wallet.sync`, `tx.get` (asking for a funding transaction reveals the coin), `guardian.unlock`,
`guardian.lock`, `savings.*`, `singlekey.register`, `sp.*`, `wallet.unwatch`. They get a typed error, not silence, so an
app bug shows.

`guardian.status` for a guest is built from the slot: its wallet id, limit, recovery, warnings, `key3Mixed`, features,
relays and lock state. It never carries the host's wallet id, Savings, watched wallet, or the contact who locked the box
(`lock.contact` is left out for guests).

### Shared parts

- **Lock and unlock** stay global: the host's passphrase unlocks the keystore and installs a signer in every engine
  (`Guardian.installSigner`); locking removes them all. After every restart guests wait for the host to unlock.
- **Chain time** (`chainSeen`, `timeFloor`) is per engine but read from the same Electrs tip.
- **Relays:** one list. A relay change (`PUT /api/relays`) must also reach every guest phone (`relays_changed`, then
  their own `relays.ack`); today `announceRelays` sends to the paired phone and recovery peers only.
- **Reset** is refused while any guest slot is `active` or `leaving` (it rotates the seed, so every guest's key 3 would
  vanish). The web UI says why and how to stop hosting first.

### Caps and rate limits per guest

| What | Limit | Today's equivalent |
|---|---|---|
| Hosted wallets | 8 (decision 6) | none |
| Pending invites | 4, each 24 hours, single use | one pairing session |
| `sign`, `recovery.start`, `recovery.update` refusals | per sender, as today (`DEFAULT_REFUSAL_LIMIT`, 30 per 10 min) | same |
| `sign` requests | 60 per hour per slot | none |
| `tx.broadcast` | `DEFAULT_BROADCAST_LIMIT` (20 per 10 min) per slot | per sender |
| Activity / refusals kept | 1,000 / 200 per slot | 5,000 / 1,000 |
| Ledger | 2,000 unspent coins per slot; over that, `sign` refuses new change (`ledger_full`) | none |
| Wallet maps | 4 KB each, 2 per slot (current wallet, a running recovery's destination) | none |

A guest can cost the host bounded disk and CPU, never a co-signature for the host's wallet: the host slot's key 3, state
and authorization are separate.

### Web UI

The host page stays as mocked (`pages/host.tsx`), wired to the real API (`GET /api/hosting`, `POST` and `DELETE
/api/hosting/invites`), plus:

- `HostedWallet.state` gains `recovering`, `leaving`, `left`; a recovering slot shows "Recovery waiting until <date>.
  Keep this box on and unlocked." (no amounts).
- "Stop hosting" (section 7) and a typed confirmation for "stop now".
- Activity shows the host's wallet plus hosting events (invite made, accepted, cancelled; a guest's recovery started,
  completed; a guest left; stop hosting). A guest's co-signatures appear only as the weekly count.
- Reset explains that it is refused while hosting.
- The build flag is replaced by the guardian reporting hosting in `GET /api/hosting` (`available: true`).

## 3. What the host learns (question 2)

| The host's guardian learns | Needs it? | Notes |
|---|---|---|
| The guest's three account pubkeys | Yes: to match inputs and sign (`analyzePsbt`) | Not the chaincodes, so no child key, no address |
| Per co-signed PSBT: every input's amount and full previous transaction (`nonWitnessUtxo`), every output's amount and script, which outputs are the guest's (tweaks), the fee | Yes: the limit (rule 3) and the segwit fee attack (rule 1) | So it sees **whom the guest pays and how much**, for phone-only payments, and the change coins it co-signed into existence |
| Tweaks | Yes: to sign | Reveal no index and no chaincode (HMAC outputs). Equal tweaks across PSBTs show address reuse |
| A recovery's sweep | Yes | **The guest's whole balance at that moment** (the sweep must move every coin) and the destination's account pubkeys |
| Timing and count of phone-only payments | Inherent | The mockup's "payments this week" |
| The guest phone's nostr pubkey, the guest's alert contacts' nostr pubkeys | Yes: authorization and alerts | The guest's chosen contacts become known to the host |
| The guest's rules (limit, delay, fee cap, contact count) | Yes | |
| The hardware wallet's key at `<account>/0/0` (the authorization key) | Yes: approvals | Lets the host recognise receive address 0/0 if it is ever spent through it |
| The guest phone's IP address | No | Only if the guest uses a relay the host runs (Umbrel's Nostr Relay app). The invite should not put the host's own relay first |

The host does **not** learn: any receive address, a coin received from outside until it is spent through the
guardian, payments made with phone + hardware wallet, the balance between recoveries, Savings, silent payments.

Two limits on that promise, to be said plainly:

- **Chain analysis.** From every co-signed transaction the host can follow the chain forward with the usual heuristics
  (its change, the transaction that later spends it, and so on). BIP 89 stops the host from *deriving* addresses, not
  from watching coins it has seen.
- **The guardian sees, the UI does not show.** The mockup's "The host never sees amounts or balances" is true of the web
  page only. The guardian stores co-signed PSBT data in the slot's files (the limit window needs it), so a host with
  shell access reads it. The copy changes accordingly (section 9).

What it needs anyway and cannot avoid: amounts of what it co-signs (or there is no limit), and the sweep (or there is no
recovery).

## 4. The daily limit without addresses (question 3)

### What works unchanged

| Part of rule 3 | Private mode |
|---|---|
| `Σ inputs − Σ change`, fee included | **Works.** Inputs and their amounts are proven by tweaks plus `nonWitnessUtxo`; an output is change when its three tweaks rebuild its script from the guest's account pubkeys. This is core's `analysis.outflow` / `vaultIn − selfOut` (`packages/core/src/psbt.ts`). |
| Rolling 24 hours, keyed by outpoint; a replay counted once; an RBF replacement counts as the larger amount | **Works.** Outpoints and shares (`splitOutflow`, `usageWith`, `apps/guardian/src/policy/limit.ts`) need no addresses. |
| Clock checked against the chain (`clock_ahead_of_chain`, monotonic `timeFloor`) | **Works.** Chain time comes from the host's own node. |
| Payments to Savings count as leaving | Works trivially: the guardian does not know Savings. |
| Limit off | Works (same rule, same approval text); phase 2 (section 10). |
| Coins spent by phone + hardware wallet | Not seen, and need not be: the limit bounds only what key 3 co-signs. Same as today ("Big payment ... the guardian isn't involved"). |

### What does not work: "change only within reach"

Today an output counts as change only if it pays `wallet.derive(chain, index)` with `index ≤ high-water + 20`
(`inspect.ts`). That rule does two jobs: it keeps every co-signed change coin inside the range the next gap-limit scan
covers, and, because the address is derived from the descriptor, it guarantees the coin is one the owner's hardware
wallet can sign (its registered multisig at a real path).

**Neither can be checked in private mode, and no variant of BIP 89 can.** Any test the guardian can run on a PSBT
output, it can run on every output on the chain. A test that says "this script is the guest's registered change at some
index" is therefore a test that finds the guest's change on chain, which is exactly what delegation hides. The tweak test
works only because the phone hands over the tweaks for that one output; and since the phone chooses them, they bind the
output to the three account keys and to nothing else.

The consequence: a thief holding the guest's phone can send coins to an output whose tweaks are valid but come from no
derivation path (or from an index far beyond any scan), and it counts as change, free against the limit. Such a coin:

- is spendable by **key 2 + key 3**: both sign by "account key + tweak" in software (the phone's key, `signer.ts`);
- is **not** spendable by the hardware wallet: Ledger, Coldcard, Jade and BitBox02 sign only inputs that match their
  registered multisig at a path, and Trezor needs the cosigners' nodes;
- is moved out by the thief only through key 3, so under the limit, counted as outflow like any payment.

So it **freezes** coins against a hardware + guardian recovery; it does not raise what a phone thief can steal (the daily
limit per day, as today).

### Options

| | What | Privacy | Rule 3 |
|---|---|---|---|
| **P. Pure delegation + mitigations** (recommended) | Change = tweak-proven self output, any tweak; no index window. Every self output key 3 co-signs goes into the slot's **ledger** (outpoint, script, amount, the three tweaks). Key 2 backup **required** for hosted wallets. | As in section 3 | Limit exact; "within reach" replaced by "the guardian remembers it" |
| H. Also share the hardware wallet's change node (`<account>/1` xpub) | The guardian checks the hardware tweak derives at `/1/i` | The host recognises every spent change coin on chain (the witness shows the key) | Proves only the hardware key; the phone's and key 3's tweaks can still be off-path, and registered devices then refuse. **Does not fix it.** Rejected. |
| C. Share all three change nodes | The guardian checks change exactly as today | The host derives every change address: most of the balance after the first payment | Full |
| S. Shared mode (full descriptor) | The host slot's code path | None from the host | Full, plus coverage and chain data from the host |

**Recommendation: P for phase 1**, with:

1. **The ledger** (`slot.json`): every self output of every co-signed PSBT, pruned when a later co-signed PSBT or a
   recovery check finds it spent. `hosted.coins` returns it to the slot's phone and to a recovery-access phone.
2. **The new phone classifies ledger coins** against the descriptor: it searches each coin's tweaks on chains 0 and 1
   up to index 10,000 (one HMAC-SHA512 per index and role, no curve work) and reports coins that match no path as
   "reachable only with your phone key and the guardian".
3. **Key 2 backup required** (decision 2): with key 2 restored, phone + guardian move such coins (raising the limit
   first with the hardware wallet), as for any stolen-phone case.
4. **Disclosure**: the guest's settings say that payments with the phone alone are limited, and that a thief with the
   phone can make coins that need the phone key backup to recover.

The high-water marks and `CHANGE_WINDOW` stay exactly as they are for the host slot.

## 5. Recovery (Delay & Notify) without addresses (question 4)

### Who builds the sweep

Today the guardian does not build the sweep either: the surviving key's phone builds and signs it, the guardian checks
it and, before completing, scans the wallet for coverage (`recovery-runner.ts`, `checkCoverage`). For a guest:

| Situation | Builds the sweep | Has the descriptor from | Chain data from |
|---|---|---|---|
| Hardware wallet lost, phone survives | the guest's phone, signed by key 2 | the phone | its own chain source (section 6) |
| Phone lost, key 2 backup | none: restore key 2, no recovery needed (as today) | the backup | the chain source in the backup |
| Phone lost, no backup | a new phone let in by the hardware wallet (`recovery.access`, version 2 text, bound to the slot's wallet id), signed by the hardware wallet | the **wallet map** from the host (below), or a printed copy | its own chain source |

The destination keeps the surviving key and the slot's key 3 (same account pubkey; the new phone picks a new key 3
chaincode), so the slot adopts it, as wallet rotation does today.

### What the host verifies

| Check | Today | Guest slot |
|---|---|---|
| Inputs are the wallet's, `nonWitnessUtxo` matches | descriptor | tweaks against the account pubkeys |
| One signature per input, all by one surviving key (phone or hardware) | yes | yes |
| Destination keeps the surviving key, drops the lost one, is not this or a retired key set | descriptor | account pubkeys sent with `recovery.start` |
| Every output pays the destination | derived address | tweaks against the destination's account pubkeys |
| Fee within the cap | yes | yes |
| Delay anchored at `max(clock, median time past)`, start height recorded, three clocks at completion | yes | yes (chain time is the host's node) |
| Sweep inputs still unspent | Electrs scan | Electrs by the inputs' own scripts (the guardian has them; the host's own Electrs, so nothing leaks) |
| **Every unspent coin of the wallet is in the sweep** | scan of every derived address from the marks | **only the ledger:** every ledger coin still unspent must be in the sweep or named in `abandon` |

`abandon` is new: a list of ledger outpoints the sweep leaves behind on purpose (the coins of section 4 that the
hardware wallet cannot sign). The alerts name them ("this recovery leaves 2 coins, 0.01 BTC, behind"), so a contact
sees it. Without it, one unreachable coin would block a hardware recovery forever.

Coins received from outside cannot be checked by the host. **Completeness becomes the guest phone's job**: it scans
with its chain source, merges the ledger, and (decision 4) cross-checks the unspent set against a second server before
it signs. A coin the phone misses stays in the old wallet after the rotation, which key 3 then refuses ("retired wallets
are dead", rule 7): it needs the surviving key plus the lost one. That risk is new for guests (section 13).

Everything else is today's recovery: `recovery.update` adds late coins without restarting the delay (now also from the
ledger), contested cancels pause phone payments until `phone.resume`, the host's node broadcasts the sweep, and the slot
rotates once a node has accepted it.

### The wallet map: a guest with no backup at all

A new phone holding only the hardware wallet cannot rebuild the descriptor: the lost phone's xpub and key 3's
chaincode (chosen by the phone) are not on the hardware wallet, and the host never had them. Without the descriptor the
phone cannot find coins sent to receive addresses. So:

- At `hosted.pair` (and in `recovery.start`, for the destination) the phone uploads a **wallet map**:
  XChaCha20-Poly1305 over `{ version, network, descriptor, birthHeight }`, key
  `K = HKDF-SHA256(ikm = the hardware wallet's account chaincode, salt = "trikey/hosted-map/v1", info = guardian pubkey || wallet id)`.
- The host cannot read it: it never sees any chaincode. The hardware wallet (or its seed words) gives the chaincode back
  through an ordinary xpub export, with no new device feature.
- **Write-once per wallet.** A thief with the phone knows `K` too (the descriptor is on the phone) and could otherwise
  replace the map with a wrong one. The guardian refuses to overwrite a wallet's map; a new wallet brings its own in
  `recovery.start`. The new phone checks the decrypted descriptor: its account pubkeys must equal the slot's, its hardware
  xpub the device's, and the ledger's tweaks must appear at some path.
- `hosted.map.get` serves it to the slot's phone and to a recovery-access phone.
- The app also offers a printed copy (the descriptor QR, as Savings does), and devices that store their registration
  (Coldcard, Jade, Passport, Keystone) can export it.

If the host loses the map and the guest has no backup and no printout, the wallet's receive coins cannot be found.
That is why decision 2 makes a key 2 backup a requirement for guests.

### A malicious host

It cannot spend alone (one key of three) and cannot stop the guest moving money with phone + hardware wallet (Replace
guardian needs no guardian). It can refuse service: stay offline, stay locked, refuse to co-sign, never complete a
recovery, lose the map. It can lie in `guardian.status`. And, the stated trust: **with a thief holding either of the
guest's keys it can co-sign anything at once**, skipping the limit, the delay and the alerts, because those rules exist
only in the guardian's code (docs/design/savings-and-limit-off.md makes the same point for the host's own wallet).
Nothing in this design changes that; section 9 says it to the guest.

### Adoption after a recovery, in delegated mode

- The adopted wallet's hardware authorization key: carried over when the hardware wallet survived; otherwise the new
  phone sends it with `hardware.confirm`, as `hardwareAuth` plus the tweak at `<account>/0/0` (section 7), since the
  guardian cannot derive it from an xpub it never sees.
- The destination's wallet map, sent with `recovery.start`, becomes the slot's map at rotation.
- The ledger starts with the sweep's outputs (they are the new wallet's coins, and the guardian knows them).

## 6. Chain data for the guest's phone (question 5)

The host's guardian cannot serve it privately: Electrs is queried by script, so serving the guest's balance means
learning every address.

| Option | Privacy | Effort | Notes |
|---|---|---|---|
| **The guest's own Esplora / Electrs** | Best | A URL setting | Most guests have no server; that is why they are guests |
| **Public Esplora** (Recovery Key mode's path) | The server sees every address and the IP address; can hide coins, not move them | Low: `EsploraChainSource` already implements `@trikey/wallet`'s `ChainSource` | Defaults `DEFAULT_ESPLORA_URLS`; the privacy text `PUBLIC_SERVER_PRIVACY_NOTE` exists |
| The host's Electrs through the guardian | None from the host | None | That is shared mode |
| Compact block filters (BIP 157/158) from the host's node | The host sees which blocks are fetched (padding helps) | High: Core's `blockfilterindex`, filters (~20 kB/block) and whole blocks do not fit nostr events; needs a direct connection | Later |
| Public Electrum over Tor | Better than plain public | React Native has no Tor or raw TCP without native modules | Later |

**Recommendation:** a chain-server setting per hosted wallet, as Recovery Key mode has: the guest's own server, else a
public Esplora, with the Recovery Key mode privacy note shown at accept time. The host still serves what leaks nothing:
`fees.estimate`, the lock state, and broadcasting transactions it co-signed. Funding transactions for `nonWitnessUtxo`
come from the guest's server (never `tx.get` from the host). Amounts are not trusted from the server: the phone checks
every raw transaction against its txid, as Recovery Key mode does. Before a recovery sweep, the phone checks the unspent
set against a second public server (decision 4).

`TrikeyWallet` builds its `GuardianChainSource` itself (`packages/wallet/src/wallet.ts`); it needs a chain-source factory
in its deps. `EsploraChainSource` stays in `packages/recovery-key` (it imports `@trikey/wallet`'s types), and the app,
which depends on both, passes it in.

Mainnet: Recovery Key mode stays on test networks partly because of the public server (DESIGN.md). A hosted wallet on
mainnet with a public server is a new exposure; decision 5.

## 7. Invites and pairing (question 6)

### The flow

1. **Host, web UI:** "Create invite link" with a name only the host sees (`POST /api/hosting/invites`). The guardian
   stores the invite in `hosting.json` (secret as SHA-256, never in clear), single use, 24 hours, at most 4 pending,
   surviving restarts (unlike today's 5-minute pairing session, because the guest is somewhere else).
2. **The link and QR:**
   `trikey://invite?v=1&npub=<guardian npub>&relay=<url>...&secret=<32 bytes, base64url>&exp=<unix>&net=<network>&label=<host's label>`.
   Same rules as the pairing URI (`packages/protocol/src/pairing.ts`; `MAX_PAIRING_TTL_SEC` is already 24 hours). The
   mockup's `trikey:invite?g=<npub>&c=7Q2K` has a 4-character code: too short to be the only secret of a link that
   travels over chat apps; the link carries the full 32 bytes and nobody types it.
3. **Guest, phone:** scans or opens the link; the app shows the host's label and npub and the disclosure (section 9),
   and asks for an explicit acknowledgement.
4. **`hosted.prepare`** `{ inviteSecret, network, entropy }`: checks the secret without using it up, binds the invite to
   this sender, derives the slot's key 3 and answers its **account pubkey only** (no chaincode), the guardian version and
   `features`.
5. The phone picks a random chaincode for key 3, builds the descriptor (`cosignerKeyExpression`), registers it on the
   hardware wallet, shows the first address on the device, and makes the BIP 137 pairing proof.
6. **`hosted.pair`** `{ inviteSecret, deviceName, walletLabel, network, accountPubkeys: { app, hardware },
   hardwareAuth: { pubkey, path, tweak }, proof, rules, walletMap, phoneNostrPubkey }`. The guardian checks everything
   `register` checks today (distinct keys, the cosigner slot, rules, a contact on mainnet, no limit off at pairing,
   no retired key set) and burns the invite.

New method names, not new fields on `pair`, so older guardians answer "method not found" and the host's own pairing is
untouched.

### Key 3 for a guest

```
seed3 = HMAC-SHA512(key  = guardian setup seed,
                    data = "trikey/key3-hosted/v1" || u32be(len) || network || u32be(len) || slotId
                           || u32be(32) || guest phone nostr pubkey || u32be(32) || c)
key 3 = BIP 32 master of seed3, account m/48'/<coin>'/0'/2'
```

- The same construction as `trikey/key3/v1` (`keystore.ts`), with its own label: a guest's key can never equal a key of
  the host's own pairings, and `slotId` is fresh randomness per invite, so no two slots share a key ("never reused").
- **`c` is required.** Today a pairing without `entropy` gets the guardian's own key (`ownKey`); a guest must never get it.
- Stored with the slot like `Key3Mix` (not secret); derived again at every unlock. DESIGN.md "Entropy" applies as is,
  including what the mix does not protect against.
- The answer is the account pubkey alone. The descriptor's key 3 chaincode is the phone's, so even the guardian's own
  real chaincode for that key says nothing about the guest's addresses. Device check (decision 11): every supported device
  must accept a cosigner given as a depth-0 xpub without origin (`bareKeyExpression`), or else as a synthetic
  `[fp/48'/c'/0'/2']` origin over the same pubkey and chaincode; the alpha test plan gets a step per device.

### The hardware authorization key without the xpub

`authKeyMismatch` derives `<account>/0/0` from the hardware xpub, which a guest slot never has. Instead the phone sends
`t`, the hardware wallet's tweak for `[0, 0]` (`tweakFromPath`), and the guardian requires
`hardwareAuth.pubkey == H + t·G` with `H` the hardware account pubkey in the key set. That keeps the binding the
hardware-auth note relies on: whoever signs for `H + t·G` knows the discrete log of `H`, the hardware slot of the
multisig, because `t` is public; a phone cannot pick `t` to land on a key of its own without knowing `H`'s private key.
The path stays `m/48'/c'/0'/2'/0/0` (docs/design/hardware-auth-path.md). Cost: the host learns the hardware key of
receive address 0/0 (section 3).

### Wallet id

`fingerprint()` hashes the descriptor, which the host never sees and so could not check. Guest wallets use a **key-set
id**: `sha256("trikey/keyset/v1" || app || hardware || cosigner)` (compressed account pubkeys in role order), first 16
hex characters, the same shape as `WalletId`. Both sides compute it; it goes into every approval text (`wallet=<id>`), the
pairing proof (`Trikey pair v1 wallet=<id> guardian=<pubkey>`, unchanged format), `recovery-access v2`, and the guest's
recovery code.

### Removing a guest, and a guest leaving

- **Host, "Stop hosting":** the slot goes to `leaving` with a date (default 30 days, decision 8). The guest's phone and
  contacts get a durable `hosting_ending` notice. Until the date the slot co-signs and runs recoveries as before; then it
  retires (`retired: hosting_ended`) and its key-3 mix record is deleted, so the key can no longer be derived. The key
  set stays recorded (rule 7). Refused while the slot's recovery is pending or ready. "Stop now" exists, behind a typed
  confirmation that says what it costs: a guest who has lost one key at that moment loses the money.
- **What the guest does:** Replace guardian (phone + hardware wallet sweep to a wallet with a new guardian, another
  host, or Recovery Key mode), then `wallet.retire` with a hardware approval, as today.
- **Guest leaving on their own:** the same `wallet.retire`; the host's UI shows "left" and offers to delete the record.
- **Cancel invite:** `DELETE /api/hosting/invites/:id`, as mocked.

## 8. Alerts and contacts (question 7)

- Each slot has its own alert contacts in its rules; on mainnet at least one, as today. Recovery alerts, `limit_off`,
  `hosting_ending` and the other notices go to the guest's phone and the guest's contacts only, from the guardian's one
  nostr identity. The text names the wallet by the label the guest chose (`walletLabel`), never the host's private name
  and nothing of the host's wallet.
- A pubkey can be a contact of several slots (the host is a natural contact of a guest). Cancels are routed by recovery
  id, which carries the slot.
- **Does the host hear about a guest's recovery?** Options: nothing; the web UI status only; DMs. **Recommendation: the
  web UI only** ("Dad's wallet: recovery waiting until 12 November. Keep this box on and unlocked."), no amounts, plus
  DMs only if the guest adds the host as an alert contact, which the accept screen suggests. The host needs to know a
  recovery runs (it must keep the box on, unlock it after a power cut and not reset), and a family host who calls the
  guest to ask "was that you?" is a useful check. Amounts stay out of the UI.
- Against a dishonest host, the guest's contacts help nothing: the alerts come from the host's box. Section 9 says so.

## 9. What the guest and the host are told (question 8)

### The guest, before accepting (replaces the copy in `guardian-invite.tsx` and `Family-Accept.dc.html`)

> **<Host> invites you to use their guardian**
>
> **What <Host> can't do**
> - Spend your money alone. Their box holds one of your three keys.
> - Lock you out. Your phone and your <device> can always move your money without them.
> - See your addresses or your balance. Their box does see each payment it co-signs (the amount and who you pay) and,
>   if you ever recover your wallet, the total.
>
> **What you're trusting them with**
> - Keeping the box online, and unlocking it after every restart, so payments with your phone alone work.
> - Running the recovery wait and the alerts honestly. **If <Host>, or someone who gets into their box, teams up with
>   someone who has your phone or your <device>, they can skip the daily limit and the wait, and keep the alerts silent:
>   that person could take everything at once.** Your alert contacts would not hear of it either.
> - Telling you before they stop hosting.
>
> **What else changes**
> - Your app reads your balance from <server>. It sees all your addresses and your IP address, but cannot move your
>   money. (Use your own server in Settings if you have one.)
> - You must keep a backup of your phone key. A hosted wallet needs it to recover in every case.
>
> [ ] I understand <Host> could help a thief skip the wait.
>
> You can move to your own guardian any time.

The current mockup's "Raise your daily limit. Only your Ledger can." is true of an honest box only; it moves under
"trusting" in the form above. "See your balance or your addresses" gains the sentence about co-signed payments.

### The host, when making an invite and when a guest accepts (extends the alert in `pages/host.tsx`)

> **You'll hold one of their three keys.** You can't spend their money, and this page never shows their balance or their
> payments. Your box does store the payments it co-signs for them: treat its data as theirs.
>
> They're counting on you to keep this box online, unlock it after every restart, let a recovery wait run its full
> length, and never help anyone get around it. While you host, Reset is refused. To stop, use Stop hosting: they get 30
> days to move.

`HostedWallet.paymentsThisWeek`'s comment changes from "The host never sees amounts or balances" to "The page shows no
amounts or balances".

## 10. Features for guests (question 9)

| Feature | Guests | Why |
|---|---|---|
| Daily limit, delay, fee cap, alert contacts, rule changes with hardware approval | Phase 1 | The engine's rules, unchanged |
| Limit off (rule 3) | Phase 2 | Same rule and text (`Trikey policy v2`); phase 1 stays small |
| Contact lock (rule 8) | Phase 2, per slot | A guest's contact's `LOCK` must stop only that slot ("paused"), not the host's box; the engine's lock is global today (`Guardian.lockByContact`). A host's contact's `LOCK` still locks the whole box, guests included (a nuisance to say in the host UI) |
| `guardian.lock` / `guardian.unlock` from a guest | Never unlock; lock as per-slot pause in phase 2 | Unlock is the host's passphrase. Until then a guest who fears a phone thief lowers the limit to 0 (tightening, phone alone) |
| Savings watch | No | `savings.register` sends Savings' descriptor, so the host would see Savings. The guest's phone watches Savings through its own chain source; the tripwire alert then comes from the phone, which is weaker |
| Silent payments (`sp.register`), the helper coin (`singlekey.register`) | No | The scan key would show the host every payment received; scanning costs the host's CPU per guest |
| Watching the replaced wallet (`pair.replacesDescriptor`) | No | It reveals the old wallet. The guest's phone watches it through its chain source |
| Recovery code (`trikey://recover`) | Yes | Carries the guardian npub, relays, network and the slot's wallet id; no secret. The guest prints it; the host's UI can show it again |

## 11. Protocol summary and compatibility

| Method | New or changed | Who |
|---|---|---|
| `hosted.prepare`, `hosted.pair` | new | a stranger holding a pending invite |
| `hosted.coins` | new: the slot's ledger | the guest's phone, a recovery-access phone |
| `hosted.map.get` | new | the same |
| `recovery.start` | optional `destinationKeys` (instead of `destinationDescriptor`), `destinationMap`, `abandon` | guest slots |
| `recovery.update` | optional `abandon` | guest slots |
| `hardware.confirm` | optional `hardwareAuth.tweak` | guest slots |
| `guardian.status` | the slot's view; `features` lists `family_hosting` | all |
| Alerts | `hosting_ending` | guest phones and contacts |
| Approval texts | none new; `wallet=` carries the key-set id | |

`GUARDIAN_FEATURES` (`packages/protocol/src/policy.ts`) gains `familyHosting: 'family_hosting'`, reported by
`hosted.prepare` (an unpaired guest cannot call `guardian.status`) and in `guardian.status`.

| Combination | What happens |
|---|---|
| Old phone, any guardian | Cannot parse `trikey://invite` (unknown code). The host's own phone is unaffected. |
| New phone, old guardian | `hosted.prepare` answers method not found; the app says "This guardian can't host wallets yet: ask <host> to update it". |
| Host's phone, new guardian | Exactly as today: the host slot's file, methods and answers are unchanged (a golden test). |
| Guardian downgraded with guests | The old version ignores `hosting.json`; guests get no answers, their money moves with phone + hardware. The release notes say so. |
| Guest backup | Version 3 when hosted (the guardian record, the chain server setting, the descriptor with its key 3 chaincode); an older app refuses it, as for Savings' version 2. |

## 12. Phasing (question 10)

### Phase 1: the smallest useful, safe slice (built; mainnet allowed, decision 5)

Multi-wallet core, invites and pairing, co-signing under the limit, guest-built recovery with the ledger and the wallet
map, guest chain data from Esplora, the host page live.

| Package | Changes | Tests |
|---|---|---|
| `packages/core` | `keySetId(acct)`; a cosigner key expression with a synthetic origin if devices need it | Vectors for `keySetId`; `tweakFromPath` at `[0,0]` against `MultisigWallet.derive` |
| `packages/protocol` | Invite URI (encode, decode, the pairing URI's rules), `hosted.*` schemas, `recovery.start` / `recovery.update` / `hardware.confirm` optional members, `hosting_ending` alert, `family_hosting` | Schema round trips; strict schemas refuse unknown members; old `pair` unchanged |
| `apps/guardian` | `hosting.json` registry and invites; `hosted/<slotId>/` engines; routing in `authorize`, `isKnownSender`, handlers and DM cancel; `key3-hosted/v1`; delegated `Registration` and `inspectPsbt` path; ledger; wallet maps (write-once); delegated recovery with ledger coverage and `abandon`; input-unspent checks by script; rotation inside a slot; slot `guardian.status`; caps and rate limits; reset refused while hosting; stop hosting with notice; `relays_changed` to every phone | Host slot golden test (a version-2 state file loads and saves byte for byte; every existing test passes untouched); isolation (a guest's `sign` never touches the host engine, a guest cannot read host status, two guests cannot see each other); key-3 vectors (`key3-hosted/v1` differs from `key3/v1` on the same inputs; refused without `c`); limit with tweaks (replay, RBF, off-path change counted as change and ledgered); invites (expiry, single use, persistence across restart, cancel, burn after failures); recovery (ledger coin missing refused, `abandon` alerted, input spent refused, three clocks, rotation adopts with the destination map); caps; reset refusal |
| `packages/wallet` | Hosted mode: invite parsing in `parseScannedCode`, `hosted.prepare` / `hosted.pair`, key 3 chaincode, PSBTs to the guardian without `bip32Derivation`, a chain-source factory in deps, wallet map make / read / verify, recovery from map + ledger with the coin classification, backup version 3, key 2 backup required | Hosted pairing against the guardian in-process; a sweep built from a map alone; classification of off-path ledger coins; backup round trip |
| `packages/recovery-key` | None (its `EsploraChainSource` is reused) | |
| `apps/mobile` | The invite screen wired (section 9 copy, the acknowledgement), the chain-server setting (as in Recovery Key mode), "Hosted by <label>" in Settings > Guardian | Screen tests for the copy and the checkbox |
| `apps/guardian-web` | Host page on the real API, slot states, stop hosting, reset refusal text; build flag replaced by `available` | Page tests against the mock and the HTTP API |
| `e2e` | Host + guest on regtest: invite, pair, co-sign under the limit, phone-lost recovery from the map, rotation, co-sign on the adopted wallet; every transaction through `tools/consensus-verify` | The regtest stack needs an Esplora HTTP endpoint for the guest (the stack runs Electrs only) |
| Docs | DESIGN.md "Later" becomes a section; PROTOCOL.md "Family hosting"; API.md; the alpha test plan's device step for the key 3 shape | |

### Phase 2

Limit off and contact lock for guests (per-slot pause), `guardian.lock` from a guest as a per-slot pause, the guest's
"leave" screen, the host's view of a guest's recovery code in the web UI, and extra alert channels (email, ntfy, webhook)
for guests and their contacts: each guest's own, never the host's (docs/design/notifications.md). (The second-server check before a sweep and
mainnet came into phase 1: decisions 4 and 5.)

### Phase 3 and later

Shared mode as an opt-in (decision 1); compact block filters from the host's node; Savings for guests if wanted;
two hosts for key 3 (a new script, a separate design).

## 13. What this cannot protect against

- **A dishonest host with a thief.** The host, or anyone who controls the host's box, together with someone holding the
  guest's phone or hardware wallet, can move everything at once with no delay and no alerts. The limit and the delay
  exist only in the guardian's code. The guest's contacts hear nothing: the alerts come from that box.
- **A dishonest host alone** cannot spend, but can stop co-signing, stay locked or offline, never complete a recovery,
  lose the wallet map, lie in its status, and read every payment it co-signed, the total of any recovery and the guest's
  contacts' nostr keys.
- **The host's box breaks, is reset or the host disappears.** The guest moves money with phone + hardware wallet
  (Replace guardian). A guest who has also lost one of those keys loses the money: key 3 has no backup (DESIGN.md).
- **The public chain server** sees all of the guest's addresses and IP address, and can hide coins. A hidden coin missed
  by a recovery sweep stays in the old wallet, where key 3 refuses it after the rotation.
- **A phone thief's off-path change** (section 4): free against the limit, recoverable only with key 2 (hence the
  required backup) or the hardware wallet's seed words in software.
- **Chain analysis** from co-signed transactions (section 3).
- **Locks that are not the guest's doing.** The host's own lock, a restart, or a `LOCK` from one of the host's contacts
  stop the guest's phone-only payments until the host unlocks.
- **A relay run by the host** sees the guest phone's IP address.
- **Coercion** of the host or the guest.

What a guest can do to the host: send requests up to the caps above. A guest cannot reach the host's wallet, key 3, rules
or status, or another guest's, and a guest's key 3 cannot sign for any other slot (its own derivation, its own engine).

## 14. Decisions for the owner

1. **Privacy mode.** Private (BIP 89) only in phase 1, shared mode (the guest gives the host the full descriptor) later
   as an opt-in, or both from the start. *Recommendation:* private only in phase 1, as DESIGN.md says; shared mode is
   phase 3 if guests ask for the host's chain data.
2. **Rule 3 for guests.** Accept "change = output proven by tweaks" with the ledger, and make a key 2 backup a
   requirement for hosted wallets. *Recommendation:* yes to both; the alternative that keeps rule 3 (sharing the change
   chain) shows the host most of the balance.
3. **Wallet map.** The host stores an encrypted, write-once wallet map keyed by the hardware wallet's chaincode.
   *Recommendation:* yes, required at pairing, plus the offer to print the descriptor.
4. **Guest chain data.** The guest's own server, else a public Esplora, with the Recovery Key mode note; the app checks
   the unspent set against a second public server before signing a recovery sweep. *Recommendation:* yes.
5. **Mainnet.** *Recommendation:* test networks only in phases 1 and 2; mainnet after the alpha, behind the same
   pre-alpha warning as the rest of guardian mode, once the public-server exposure is accepted for mainnet.
6. **Architecture and limits.** One engine per slot with the host's file untouched; at most 8 hosted wallets and 4
   pending invites; invites single use for 24 hours. *Recommendation:* yes.
7. **The host and guests' recoveries.** *Recommendation:* the web UI shows that a recovery runs and until when, no
   amounts, no DMs; the accept screen suggests adding the host as an alert contact.
8. **Stopping hosting.** *Recommendation:* 30 days' notice by default with a durable notice to the guest and their
   contacts; "stop now" behind a typed confirmation; refused while the slot's recovery runs.
9. **Reset while hosting.** *Recommendation:* refused until every guest slot has left or ended.
10. **Disclosure.** *Recommendation:* adopt section 9's texts, including the required checkbox, and update
    `guardian-invite.tsx`, `Family-Accept.dc.html` and `pages/host.tsx` to match.
11. **Key 3's shape in the guest's descriptor.** A depth-0 xpub without origin, or a synthetic BIP 48 origin.
    *Recommendation:* test both on every supported device in phase 1 and keep whichever all of them register.
12. **Features for guests.** *Recommendation:* phase 1 has the limit, delay, fee cap, contacts and hardware-approved
    changes; limit off and a per-slot contact lock come in phase 2; Savings watch, silent payments and the replaced-wallet
    watch are never served by the host.
13. **`abandon` in recoveries.** Let a sweep leave named ledger coins behind, announced in the alerts.
    *Recommendation:* yes; without it one off-path coin blocks a hardware recovery for good.

### The owner's decisions (2026-11-01)

| # | Decision |
|---|---|
| 1 | Privacy: BIP 89 only in phase 1; a "shared" mode later, as an opt-in. **Yes.** |
| 2 | Rule 3 for guests: change proven by tweaks plus the co-signed-coin ledger, and a key 2 backup **required**. **Yes.** |
| 3 | Wallet map: required at pairing (encrypted, write-once on the host), plus an offer to print the descriptor. **Yes.** |
| 4 | Chain data: the guest's own server, else a public Esplora, with a second-server check before sweeps. **Yes.** |
| 5 | **Mainnet allowed from the start** (overriding the "test networks only" recommendation), behind the same pre-alpha / "not audited, open source" warning and consent the app uses for mainnet in guardian mode; every mainnet path for guests goes through it. |
| 6 | One engine per hosted wallet; at most 8 hosted wallets and 4 pending invites; invites single use for 24 hours. **Yes.** |
| 7 | The host sees guests' recoveries in the web UI without amounts, no DMs; the accept screen suggests adding the host as an alert contact. **Yes.** |
| 8 | Stopping hosting: 30 days' notice by default; "stop now" behind a typed confirmation; refused while that wallet's recovery runs. **Yes.** |
| 9 | Reset refused while hosting. **Yes.** |
| 10 | Section 9's disclosure texts with a required "I understand" checkbox; the mockups and copy that overstated privacy updated. **Yes.** |
| 11 | Key 3's shape: test the depth-0 xpub against a synthetic origin through every device integration in code, keep what all accept, and document what needs real devices. **Yes** (section 15: depth-0 kept). |
| 12 | Guests in phase 1: limit, delay, fee cap, contacts, hardware-approved changes; limit off and contact lock in phase 2; never Savings watch, silent payments or the replaced-wallet watch. **Yes.** |
| 13 | `abandon` in recoveries. **Yes.** |

## 15. What phase 1 built

### Per component

| Where | What |
|---|---|
| `packages/core` | `keySetId(acct)` (`sha256("trikey/keyset/v1" || app || hardware || cosigner)[:16]`), a fixed vector; `syntheticCosignerKeyExpression` (the decision-11 alternative, for tests). |
| `packages/protocol` | `trikey://invite` (`encodeInviteUri`, `decodeInviteUri`, in `decodeTrikeyUri`); `hosted.prepare`, `hosted.pair`, `hosted.coins`, `hosted.map.get`, `hosted.access`; the hosted form of `recovery.start` (a union with the descriptor form), `abandon` on `recovery.update`, `tweak` on `hardware.confirm`; the `hosting_ending` alert and `wallet_retired` reason `hosting_ended`; `guardian.status.hosting`; `GUARDIAN_FEATURES.familyHosting`; recovery codes' `hosted=1`. PROTOCOL.md "Family hosting". |
| `apps/guardian` | `src/hosting/`: `registry.ts` (`hosting.json`, invites), `engine.ts` (`HostedEngine`, one per slot), `service.ts` (routing, key 3 per slot at unlock, stop hosting, reset refusal, background work), `handlers.ts` (guests' methods and the router in front of the host's), `recovery.ts`, `alerts.ts`, `dm-cancel.ts`, `http.ts`. `keystore.ts` gained `trikey/key3-hosted/v1`. The host's files are touched only to call into hosting (`guardian.ts`: authorize, known senders, signer install and drop, tick, reset refusal, `relays_changed` to guests; `nostr/handlers.ts`: the router; `dm-cancel.ts`: a guest id goes to its slot). `FAMILY_HOSTING=false` turns it off. |
| `packages/wallet` | Hosted mode: `acceptInvite` (disclosure and mainnet consent required), `deps.hostedChain` (never the host's chain), PSBTs to the guardian without derivations, receiving only after a key 2 backup, `hostedCoins` (ledger classification), wallet map encrypt / decrypt / verify (`src/hosted.ts`), recovery with the hardware wallet lost (key 2 signs every coin by tweak, off-path ones included) and with the phone lost (`recoverHostedWithHardware`: `hosted.access`, the map, `abandon` for off-path coins), the second-server check before both, backup version 3, `hardware.confirm` with the tweak, invites and hosted recovery codes in `parseScannedCode`. |
| `apps/mobile` | The invite screen (section 9 word for word, the checkbox, the mainnet warning, the contact suggestion), `readInvite` / `acknowledgeInvite` / `setUpRules` accepting the invite, the chain source (`src/data/hosted.ts`: Recovery Key mode's `EsploraChainSource` plus a look-up by script, the guest's server or the public one, a second public server for the check), Settings > Guardian "Hosted by", a chain-server screen, hosted recovery codes, the demo. |
| `apps/guardian-web` | The host page on the real API (`available` replaces the build flag), states (`recovering`, `leaving`, `ended`, `left`), Stop hosting with notice and "stop now" with the typed confirmation, removal, the corrected disclosure, the Reset page's reason. API.md. |

### How the host-unchanged guarantee and isolation are tested

- Every existing guardian test passes untouched. A committed version-2 state file (`test/fixtures/guardian-state-v2.golden.json`)
  loads and saves byte for byte; end to end, the host's `guardian-state.json` is byte for byte the same across two guests
  pairing, paying, starting and cancelling recoveries, a relay change, a restart and stopping hosting, and the host's
  `guardian.status` and `policy.get` answers are unchanged (`test/hosting.e2e.test.ts`).
- Isolation: a guest's phone gets typed errors for `wallet.sync`, `tx.get`, Savings, silent payments, `guardian.lock` and
  `guardian.unlock`; its status is its slot's; one guest cannot see or cancel another's recovery; a guest's contact
  cannot cancel another slot's or the host's recovery ids; the host's phone never reaches a guest slot; a phone pubkey
  belongs to one slot; `tx.broadcast` relays only what the slot co-signed.

### Deviations from the proposal (the safest option was taken each time)

1. **`hosted.access` instead of a looser `recovery.access`.** Answering a guest wallet through `recovery.access` would have
   made its `descriptor` and `guardianKey` optional, changing the host's RPC shape. A new method keeps `recovery.access`
   byte for byte; recovery codes of guest wallets say `hosted=1`.
2. **Slot ids are 8 random bytes, recovery ids `<slotId>g<n>-<txid12>`.** 12 bytes and `<slotId>-<n>-<txid12>` would not fit
   the protocol's `RecoveryId` (40 characters) nor the `CANCEL <id>` pattern; this form fits both, so no schema widens and
   old contact apps still cancel. 64 bits of slot randomness are ample next to the phone's 32-byte contribution.
3. **The ledger and the wallet maps live in `state.json`**, not `slot.json`, so a co-signature is never handed out before
   the ledger entry is durable (the same write as the limit's record). `slot.json` keeps the co-signed sweeps.
4. **The host's own `guardian.status` does not list `family_hosting`** (its answers stay as they were); guests see it in
   their status and in `hosted.prepare`.
5. **Strangers keep an answer for 10 minutes after an invite is used or ran out** (as for pairing codes), so a second
   phone hears "already used" rather than a timeout.
6. **A guest's own key 2 backup is enforced as "no receive address before a backup"** in the wallet.
7. **The regtest stack has no Esplora endpoint:** the wallet's and the app's end-to-end tests use an in-process stand-in
   over the rig's chain; the real `EsploraChainSource` is covered by Recovery Key mode's tests and the factory's own.

### Guests and the host's extra alert channels

The host's email, ntfy and webhook channels (docs/design/notifications.md) are the host's: they carry the host's own
wallet's alerts and host-level events (restarted and locked, relays changed, the channels changed) only. A guest's alerts
(its recoveries, `hosting_ending`, the end of hosting) are sent by the hosted alerter (`src/hosting/alerts.ts`) to the
guest's phone and the guest's own alert contacts as nostr DMs, and never enter the notifier, not even for a host contact
who is also the guest's contact. Guests have no extra channels in phase 1 (phase 2). The guest's `guardian.status` does
not show the host's channels. `test/hosting-notify.e2e.test.ts` checks that the host's channels receive no guest recovery
id, wallet id, label, amount or alert type while a guest's recovery and Stop hosting run, that they still work for a
host-level event, and that hosting and the notifier keep to their own files (`hosting.json`, `hosted/` against
`notifications.json`, `notifications-key.json`).

### Key 3's shape (decision 11)

Kept: **a depth-0 xpub with no origin** (`cosignerKeyExpression`, `[ownfp]xpub`). Through the integrations in code
(`apps/mobile/src/hardware/common/key3-shape.test.ts`): Ledger's wallet policy key info is `[fp]xpub`, Trezor's multisig
nodes carry the xpub with the `[chain, index]` suffix and no origin, the Coldcard file says `Derivation: m` with the key's
own fingerprint, and the descriptor imports as is. A synthetic origin (`[fp/48'/c'/0'/2']`, the xpub serialized at depth
4 with an invented parent) gives the same addresses and is accepted by the same code, but claims a derivation that does
not exist, so it is only the fallback. Needs real devices (alpha test plan, step 15): Ledger's Bitcoin app with a no-origin
external key, Coldcard's depth-0 fingerprint check, Trezor signing, Jade / Passport / Keystone descriptor import, BitBox02.

### Open questions

1. **Off-path coins on the phone side.** The phone finds ledger coins at no derivation path through the chain source's
   look-up by script (`unspentByScript`); a public server that hides them makes a hardware-lost sweep leave them out (the
   guardian then blocks the completion until they are swept or abandoned, so nothing is lost silently).
2. **The second server is a fixed public one per network** (`SECOND_ESPLORA_URLS`). A guest with their own server still
   asks a public one for the check; whether to let them name a second own server is open.
3. **Printing the descriptor** (decision 3's offer) uses the existing wallet-details export; a dedicated "print your
   wallet" step at acceptance is not built.
4. **Guest wallets' recovery code in the host's web UI** (section 10) is not shown yet; the guest's own app makes it.
5. **Per-slot `LOCK`** (phase 2): a host contact's `LOCK` still locks the whole box, guests included.
6. **Alert-contact DMs of a guest's recovery come from the host's box**, which a dishonest host can keep silent (section
   13); nothing in phase 1 changes that, by design.
