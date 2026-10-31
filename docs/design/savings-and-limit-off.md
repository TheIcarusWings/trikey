# Savings and turning the limit off: design proposal

Status: proposal. Written 2026-10-31, against `main` after 0.1.4-alpha. Device support checked the same
day; see section 3. **Section 4 (turning the limit off) is built** (phase 1), with the owner's answers to open questions 5
(the alert contacts are told too) and 7 (after a recovery the limit comes back at its last value); DESIGN.md (rules 3
and 4) and PROTOCOL.md ("No daily limit") describe it as built. Savings is not built.

The owner raised a concern, and it holds: **the daily limit exists only in the guardian's code.** Today's wallet is
`wsh(sortedmulti(2, phone, hardware, guardian))`. Any two keys satisfy the script, so whoever controls the guardian
(root on the box, or key 3 once it is unlocked) and the phone can spend everything. No rule on the guardian can
prevent that, because such an attacker does not run our rules. Only the script can.

The owner asked for two things, both **strictly optional**. Anyone who does not opt in sees exactly today's app:

1. **Savings**: a second wallet that phone + guardian cannot spend, so a stolen phone plus a compromised guardian
   reaches only the everyday wallet (from here on called "Spending").
2. **The daily limit can be turned off**, as an explicit choice that needs the hardware wallet.

## 1. What a savings script must do

| Requirement | Why |
|---|---|
| R1. Phone + guardian cannot spend it | The point of Savings (the concern above) |
| R2. There is a way back if the hardware wallet and its seed words are lost | A savings wallet that one lost device can freeze for good is unacceptable |
| R3. The owner holding only the hardware wallet can still rescue it once phone and guardian are both in other hands | Otherwise the attacker just waits |
| R4. Every device Trikey supports can register it, show its addresses and sign it | DESIGN.md: "the only script every hardware wallet can co-sign" |
| R5. Nothing changes for people who do not turn it on | The owner's condition |

No single script meets all five. Any script that makes the hardware wallet mandatory (R1 in its strongest form) needs
either miniscript, which fails R4 (section 3), or a timelock. A timelock path for phone + guardian weakens R1 for old
coins and fails R3 for a user with no key 2 backup. So there are two candidates, set side by side below.

### Candidate K: a 2-of-3 with a Recovery Key (universal)

```
wsh(sortedmulti(2, phone', hardware', recoveryKey))     guardian not in it
```

- `phone'` and `hardware'` are the same seed and device as Spending, at **BIP 48 account 1'**
  (`m/48'/<coin>'/1'/2'`). A separate account gives separate keys. Rule 7 ("the same keys are the same wallet") never
  mistakes Savings for Spending, and the two wallets' addresses are not linked by key.
- `recoveryKey` is exactly Recovery Key mode's key 3 (`packages/recovery-key`): either a **second hardware wallet**,
  of which only the xpub is kept, or a 12-word Recovery Kit printed once and wiped from the phone. Kit format 1
  already carries the phone's and the hardware wallet's account keys, so the kit alone rebuilds the descriptor.
- R1: the guardian holds no Savings key at all. R2: phone + Recovery Key. R3: hardware + Recovery Key. R4: plain
  `sortedmulti`, which every device on the list signs today. Bonus: no timelock, so there is no refresh deadline.
- The cost: "every spend needs the hardware wallet" becomes **"every spend needs a key that is not online"** (the
  hardware wallet or the Recovery Key). A thief who holds the phone and finds the Recovery Key takes Savings. The kit
  must live outside the home, like the seed words. The user also keeps one more backup.
- Entropy: a paper kit comes from the phone's generator, as key 2 does. DESIGN.md "Entropy" explains why that puts
  two keys on one source. The setup screen therefore recommends the second hardware wallet first, as RK mode's does.

### Candidate T: hardware mandatory, with a timelocked recovery (miniscript)

```
wsh(andor(pk(HW/<0;1>/*),
          or_d(pk(PH/<0;1>/*), pk(G/<0;1>/*)),
          and_v(v:multi(2, PH/<2;3>/*, G/<2;3>/*), older(N))))

BIP 388 template:  wsh(andor(pk(@0/**),or_d(pk(@1/**),pk(@2/**)),and_v(v:multi(2,@1/<2;3>/*,@2/<2;3>/*),older(N))))
```

- **Primary path:** the hardware wallet AND (the phone OR the guardian). **Recovery path:** phone AND guardian, once
  the coin is `N` blocks old (BIP 68, relative, consensus-enforced). Keys are at account 1' as in K. The guardian's
  Savings key is account 1' of its `trikey/key3/v1` seed. The recovery path reuses the phone's and guardian's keys on
  the `<2;3>` branches, the pattern Liana uses: BIP 388 allows it, and Ledger, Coldcard Edge and Jade handle it
  (section 3).
- Typing (checked by hand, to be checked by a compiler in phase 4b): `pk(HW)` is `Bdue`, `or_d(pk,pk)` is `B`, and
  `and_v(v:multi, older)` is `B`, so `andor` is valid, non-malleable and needs a signature on every path. The input is
  about 125 vB against about 105 vB for today's 2-of-3 (an estimate, not measured).
- **N.** The maximum is 65,535 blocks (about 455 days). Proposed choices: 26,280 (about 6 months) or 52,560 (about a
  year, the default). A shorter `N` means a quicker way back after a lost hardware wallet, and more frequent refreshes.
- **Refresh is the price.** Once a coin is `N` blocks old, phone + guardian can spend it: R1 holds only for coins
  younger than `N`. So the owner must "refresh" Savings (hardware + phone, sending every coin to a new Savings
  address) before the oldest coin's deadline. The app shows "Refresh by 12 March"; the guardian alerts 30 days,
  7 days and 1 day ahead (`savings_refresh_due`). A missed refresh does not lose money. It leaves the old coins at
  today's protection level until the next refresh.
- **The guardian adds Delay & Notify on top of the timelock.** It co-signs the recovery path only inside a
  phone-surviving recovery (`recovery.start`): alerts, cancel, the 7/14/30-day delay. It co-signs the primary path
  with the hardware wallet only inside a hardware-surviving recovery (a lost phone). An honest guardian thus adds a
  cancellable delay to every path it takes part in. A compromised one adds nothing, and the timelock is the floor.
- R2: phone + guardian, after D&N, and once the coins are `N` old; just after a refresh that is up to `N` (a year)
  of waiting. Restoring the seed words onto a new device is still instant. R3: only if the owner has the key 2 backup
  (hardware + restored phone key). With no backup, the owner holds one key, the attacker two, and the attacker wins
  after `N`. R4: fails (section 3).

### Rejected

| Option | Why not |
|---|---|
| `and_v(v:pk(HW), or_d(pk(PH), pk(G)))`, no recovery path | Fails R2: device and seed words lost means the money is lost |
| 2-of-2 hardware + phone | Fails R2 the same way. Phone loss without a backup also freezes it |
| Hardware + guardian only | Lost guardian (a dead box, which holds no backup of key 3) freezes it. Phone is useless |
| `(HW or RK) and (PH or G)` (miniscript) | Fails R3 (hardware + Recovery Key cannot spend) and R4; no better than K |
| Pre-signed vault transactions, covenants (CTV, `OP_VAULT`) | Same reasons as DESIGN.md: fragile, or not active on Bitcoin |

**Recommendation: build K.** It is the only candidate that meets R1 to R5 on every supported device, it reuses the
Recovery Kit and the `sortedmulti` code paths that are already tested, and its guardian is not a signer, so the
guardian's code is not in Savings' security at all. T is documented here as a later option for owners whose devices
pass the phase 4a test and who want "hardware mandatory" in its literal form.

## 2. Savings in detail (K unless marked T)

### Wallet, ids, backup

- **Descriptor:** `wsh(sortedmulti(2,[fp/48h/<coin>h/1h/2h]phone/<0;1>/*,[fp/48h/<coin>h/1h/2h]hw/<0;1>/*,[fp/…]rk/<0;1>/*))`
  with the checksum (BIP 380, BIP 389 multipath, BIP 48 paths). Wallet id: `MultisigWallet.fingerprint()` of it, as
  for Spending. Device name: "Trikey savings" (16 characters at most).
- **Registration** on the devices that need it (Ledger HMAC, Coldcard QR config, Jade descriptor), then the first
  address is shown on the device, as at pairing today.
- **Phone backup:** `BackupPayload` gains `savings: { descriptor, walletId, account, createdAt, nextReceiveIndex,
  nextChangeIndex }`, no key. The payload schema is strict, so an older app would refuse such a backup. The payload
  becomes `v: 2` only when Savings exists, and older apps say "update the app" instead of misreading it.
- **Wallet details** (Settings > Advanced) shows both descriptors, labelled "Spending" and "Savings".
- **Other wallets:** K is a plain 2-of-3, so Sparrow, Nunchuk, Electrum and Bitcoin Core import it as any multisig.
  T needs miniscript: Liana and Nunchuk (wsh miniscript with Coldcard, Jade and Ledger at launch), and Bitcoin Core
  (wsh miniscript signing since 25.0, per a secondary source). Sparrow does not appear to support miniscript (no
  statement from Sparrow found: **unconfirmed**). The descriptor is the backup that matters for T: the keys alone do
  not say `N`.

### Moving money

| Move | Keys | Rule |
|---|---|---|
| Receive into Savings | none | Receive has a "Spending / Savings" choice once Savings is on |
| Spending to Savings | phone + guardian, within the limit; or phone + hardware | Phase 2: counted like any payment. Phase 3: free (below) |
| Savings to Spending, or out | phone + hardware, or Recovery Key + either | No guardian, no limit, like "Big payment" today |
| Refresh (T only) | phone + hardware | Every coin to a fresh Savings address before its deadline |

- **Free transfers into Savings (phase 3).** A payment into Savings moves value to a strictly safer place. A phone thief
  who moves everything into Savings has helped the owner. So the guardian could count outputs that pay **Savings
  addresses it derived itself** (within the high-water mark plus the gap limit, as rule 3 does for change) as kept, not
  sent. The fee still counts. Telling the guardian which wallet is "Savings" is then a loosening: a phone thief could
  register their own wallet as "Savings" and drain it uncounted. So `savings.trust` needs a hardware approval:
  `Trikey savings v1 wallet=<id> seq=<n> savings=<savingsWalletId> expires=<ISO>`. Watch-only registration without it
  (phase 2) is harmless: it adds chain data and alerts, nothing else.
- **Fees.** A Savings spend pays its own fee at the 6-block estimate, signals RBF and is bumped by re-signing (hardware
  again). A move into Spending can also be sped up by CPFP from the Spending output, which phone + guardian sign within
  the limit.
- **UTXO hygiene.** A transfer links the two wallets on chain. Spending and Savings coins are never mixed in one
  transaction. Move in a few larger amounts rather than many small ones. Under T, a refresh consolidates (one more
  link, and done when fees are low).

### The guardian's role

| | K | T |
|---|---|---|
| Holds a Savings key | No | Yes (account 1') |
| Co-signs | Never | Only inside a recovery, after Delay & Notify (above) |
| Policy | None: there is no phone + guardian path | None outside recoveries; recoveries use the delay, contacts and fee cap of the rules |
| Stores | The descriptor, as a watched wallet next to the active one (like `GuardedWallet.watched`) | The same, plus its key's derivation |
| Does | Serves `wallet.sync` for Savings from its node; alerts the phone and contacts when a Savings coin moves (`savings_moved`) | The same, plus refresh reminders (`savings_refresh_due`) |

The `savings_moved` alert is a tripwire, nothing more. An honest guardian tells the contacts that Savings moved, which
catches "phone + Recovery Key" or "phone + hardware" in other hands after the fact. A compromised guardian stays
silent, which costs nothing it was trusted with.

### Recovery and rotation

| Situation | K | T |
|---|---|---|
| Lost phone, backup | Restore key 2 (it holds the account 1' key) | Same |
| Lost phone, no backup | Hardware + Recovery Key, at once, to a new Savings wallet with the new phone's key | Hardware + guardian through Delay & Notify (part of the same recovery as Spending: one record, two sweeps) |
| Lost hardware and seed words | Phone + Recovery Key, at once, to a new Savings wallet with the new device | Phone + guardian through Delay & Notify, broadcast once every coin is `N` blocks old |
| Lost Recovery Key (K) | Phone + hardware to a new Savings wallet with a new kit | — |
| Lost or replaced guardian | Nothing to move. Pair the new guardian, re-send the Savings descriptor to watch | Phone + hardware sweep Savings to a new Savings wallet with the new guardian's key, as "Replace guardian" does for Spending |
| Guardian adopts a recovered wallet (rotation) | The watched Savings record moves to the adopted wallet if the phone sends the new Savings descriptor | The recovery's second sweep goes to the new Savings wallet; the guardian adopts both together |

Under T, one recovery covers both wallets (`recovery.start` gains `savingsSweepPsbt` and `newSavingsDescriptor`), so
there is one delay and one set of alerts. The Savings sweep may become valid later than the Spending sweep (`older(N)`);
the guardian completes Spending when ready and broadcasts the Savings sweep when it matures. That is the new part of the
engine.

### In the app

- **Off by default.** Settings > "Savings", subtitle "Money your phone and guardian can't move". Home stays as it is.
- **Turning it on** (K): what it is, then the Recovery Key (a second hardware wallet, recommended, or a printed kit,
  the RK-Create flow), registration and the first address on the hardware wallet, a new backup. Copy:
  - "Savings is a second wallet for money you rarely touch. Your phone and your guardian can't move it, even together."
  - "Moving money out of Savings needs your Ledger, or your Recovery Key with this phone."
  - "Keep your Recovery Key away from home, apart from your Ledger's seed words."
- **Once on:** Home shows the Spending balance and limit line as today, and under them one row: "Savings
  0.48 BTC ›". The Savings screen has the balance, "Move to Spending", "Add to Savings", Receive, and its activity.
- **Add to Savings:** amount, review ("From Spending to Savings · counts toward today's limit" in phase 2), Face ID.
  Over the limit, the Ledger signs as for any big payment.
- **Move to Spending:** amount, review, then the hardware wallet. The device shows the Spending address as an
  outgoing payment; the app says so ("Your Ledger shows this as a payment to bc1q…: that is your Spending wallet").
- **T only:** "Refresh by 12 March" under the balance, a reminder 30 days ahead, one hardware approval per refresh.
- **Guardian web UI:** a "Savings (watched)" card with the balance, the last movement and "Your guardian can't sign
  for Savings" (K) or "Your guardian signs Savings only in a recovery" (T); a `savings_moved` entry in the activity log.

## 3. What the devices can do

Checked 2026-10-31. Trikey connects Ledger over Bluetooth, Trezor through Trezor Connect, and Coldcard, Jade and
generic QR signers (Keystone, Passport, SeedSigner, Krux) over QR (`apps/mobile/src/hardware`). BitBox02 is in
DESIGN.md's list but has no adapter in the app. K needs only what Spending already uses. T needs miniscript wallet
policies with `older`, and two keys used on two multipath branches.

| Device | K (`sortedmulti`) | T (wsh miniscript with `older`) | Sources |
|---|---|---|---|
| Ledger (Bitcoin app) | Yes (in use) | **Yes** since 2.1.0 (2022-11-16), as a BIP 388 wallet policy registered with an HMAC. 2.4.6 (2026-03-30) refuses `older(n)` with no consensus meaning; ours has one. 2.5.0 (2026-07-24) shows clear text for multisig and "many taproot miniscript" policies. For wsh miniscript the screen shows the raw template, which few users can check: **unconfirmed** whether 2.5 adds text for it. | [CHANGELOG](https://github.com/LedgerHQ/app-bitcoin-new/blob/master/CHANGELOG.md), [Liana devices](https://github.com/wizardsardine/liana/blob/master/doc/SIGNING_DEVICES.md) |
| Trezor | Yes (in use) | **No.** Firmware has only the `multisig` structure. Timelock issue #706 open since 2019-11-13. Draft PR #6936 "[WIP] Miniscript support" (opened 2026-05-15, wsh only, registration UX unfinished). PR #7835 (merged 2026-09-09) adds an experimental `miniscript` build flag, "excluding them from production FW builds". No release note mentions miniscript. | [#706](https://github.com/trezor/trezor-firmware/issues/706), [#6936](https://github.com/trezor/trezor-firmware/pull/6936), [#7835](https://github.com/trezor/trezor-firmware/pull/7835) |
| Coldcard (Mk4/Mk5/Q) | Yes (in use) | **Edge firmware only.** Miniscript since 6.1.0X (2023-06-20); keys reused on another branch allowed since 6.2.2X. Edge is "not yet qualified … DO NOT use for large Bitcoin amounts". Mainline (5.6.3 / 1.5.3Q, 2026-09-30): no miniscript in its history; its descriptor import is `sortedmulti`/`multi` only. Import of a miniscript wallet over QR: **unconfirmed**. | [Mk history](https://github.com/Coldcard/firmware/blob/master/releases/History-Mk.md), [Edge changelog](https://github.com/Coldcard/firmware/blob/edge/releases/EdgeChangeLog.md) |
| Jade / Jade Plus | Yes (in use) | **Yes over USB/BLE:** registered descriptor wallets since 1.0.24 (2023-10-24); a reused-placeholder fix in 1.0.31; Liana requires 1.0.30. Trikey talks to Jade over **QR**, and Liana warns against QR mode: descriptor registration over QR is **unconfirmed**. | [CHANGELOG](https://github.com/Blockstream/Jade/blob/master/CHANGELOG.md), [Liana devices](https://github.com/wizardsardine/liana/blob/master/doc/SIGNING_DEVICES.md) |
| BitBox02 | Yes (no Trikey adapter yet) | Yes per Liana (P2WSH from firmware 9.15.0); not tested by us | [Liana devices](https://github.com/wizardsardine/liana/blob/master/doc/SIGNING_DEVICES.md) |
| Krux | Yes | Per its release notes, wsh and taproot miniscript since v25.03.0; **unconfirmed** by us | [v25.03.0](https://github.com/selfcustody/krux/releases/tag/v25.03.0) |
| Keystone | Yes | **Unconfirmed:** no vendor statement found either way | — |
| Passport | Yes | **No** as far as found: Foundation's forum says it is planned, not shipped | [Foundation forum](https://community.foundation.xyz/t/miniscript-support-on-passport-core-prime-technical-or-other-limitations/405) |
| SeedSigner | Yes | **Unconfirmed, likely no:** no release or PR found | — |

So T would exclude Trezor (one of the two first-class devices), mainline Coldcard, Passport and probably Keystone and
SeedSigner. On Ledger it works, but the user approves a template they cannot read. That is the main reason for
recommending K. The phase 4a test would turn the unconfirmed cells into facts before T is built.

## 4. Turning the daily limit off

**What "off" means.** No cap on what phone + guardian co-sign. Every other rule stays: inputs checked, one phone
signature, the clock checks, phone payments paused during a recovery, Delay & Notify, contacts required on mainnet. The
guardian still counts what it co-signs, so the app can say "sent today".

**How it is stored.** The protocol already allows `dailyLimitSats` up to 2,100,000,000,000,000 (all bitcoin there
will ever be), and a hardware approval can set it today. "Off" is that value. No `Policy` member is added and
`policyHash` is unchanged, so this needs no protocol version bump. What changes:

- **The approval text says it in words.** For this value only, the guardian builds
  `Trikey policy v2 wallet=<id> seq=<n> limit=off delay=<d>d feecap=<sats> contacts=<k> hash=<policyHash> expires=<ISO>`
  (about 200 characters, under the 240 limit). Every other policy keeps the v1 text. An older guardian would build v1
  and refuse the v2 signature (`1202`), so the phone offers "off" only to guardians that report the feature.
- **It is a loosening, like any raise.** It needs a fresh hardware approval (`phoneMayApply` already says so: the
  limit rises). It is refused during a recovery (`RecoveryAlreadyActive`) and refused in `pair`, where rules are not
  hardware-approved: the user turns it off after pairing.
- **Turning it back on is tightening:** any value lower than off, from the phone alone, at once.
- **Recovery and rotation.** A completed recovery means a key was lost or taken. The adopted wallet therefore starts
  with the limit **on**, at the value it had just before it was turned off (recorded as `limitBeforeOff` with the
  approval). When that value is not known (only a limit raised to the maximum before the `limit_off` feature, never
  turned off with it), it comes back as 0: the phone spends nothing alone until the hardware wallet approves a limit
  (owner's decision, 2026-10-31). The owner can turn it off again with the hardware wallet after `hardware.confirm`. "Replace
  guardian" pairs a new guardian, so the limit is on there until approved again.
- **Shown everywhere.** `guardian.status.dailyLimit` gains `off: true` (result members are lenient). Home:
  "No daily limit. Your phone and guardian can send everything" (warning tone). Settings > Daily limit: "Off", with
  "Turn the limit back on". Guardian web UI, Rules: "Daily limit: Off"; activity: "Daily limit turned off (hardware
  approval #12)". New alert `limit_off` to the paired phone, and (recommended, open question 5) to alert contacts.

**What the user gives up.** With the limit off, the guardian is a second signature, not a brake. Concretely:

- **A phone thief who gets past Face ID or the device passcode empties Spending at once.** Today they get the daily
  limit, and the owner has hours to restore key 2 and move the rest with phone + hardware. Shoulder-surfed passcodes
  make this the common theft, not a rare one.
- **Malware on the phone with access to key 2** does the same.
- **Phone + compromised guardian** were already everything. With the limit off, phone + an honest guardian are
  everything too.
- **Delay & Notify does not help.** It protects recoveries. A thief with the phone does not need a recovery; they just
  pay. The alerts arrive after the money has left.

Warning screen (Settings > Daily limit > "Turn off the limit", a link at the bottom, not a button):

> **Turn off the daily limit?**
> Without a limit, your phone and your guardian can send everything in Spending at once, with just Face ID. If someone
> gets into your phone, they can empty Spending before you notice. Your Ledger can't stop it, and nothing waits.
> Savings is not affected: it always needs your Ledger or your Recovery Key.
> [Turn off with Ledger] [Keep the limit]

Without Savings, the screen adds: "Consider Savings first: keep there what you don't need this week." With Savings,
it shows what is exposed: "0.8 BTC in Spending can be sent without your Ledger."

## 5. Threats

K is the Savings column (T's differences in brackets). "Everything" means both wallets.

| Situation | Today | With Savings | Limit off | Both |
|---|---|---|---|---|
| Phone stolen and unlocked | Up to the limit per 24 h; a recovery they start is announced and cancellable | Spending: as today. Savings: nothing (needs hardware or the Recovery Key) [T: or the guardian, only via D&N] | **All of Spending, at once** | All of Spending; Savings safe |
| Guardian compromised (root or key 3) | Nothing alone; can refuse to sign and stay silent | Same; it has no Savings key [T: one key, nothing alone] | Same as today | Same |
| Phone + guardian | Everything | Spending only; Savings safe [T: safe while coins are younger than `N`; the owner must move them with hardware + the key 2 backup first] | Everything | Spending only |
| Hardware stolen (with PIN) | Nothing alone; a recovery attempt is announced and cancellable | Same; Savings needs a second key | Same as today | Same |
| Hardware + phone | Everything | Everything | Everything | Everything |
| Recovery Key found (K) | — | Nothing alone; with the phone or the hardware wallet, Savings | — | Same |
| Burglary: phone, a powered box, a kit kept at home | Up to the limit | Spending up to the limit; **Savings too if the kit was at home** | All of Spending | All of Spending, and Savings if the kit was at home |
| Lost phone | Backup, or hardware + guardian D&N | Savings: backup, or hardware + Recovery Key at once [T: hardware + guardian D&N] | Same as today; limit back on after the recovery | Same |
| Lost hardware and seed words | Phone + guardian D&N | Savings: phone + Recovery Key at once [T: D&N and up to `N` blocks] | Same as today | Same |
| Lost guardian | "Replace guardian" (phone + hardware) | Savings: nothing to do [T: phone + hardware sweep it too] | Same as today | Same |

## 6. What this does not solve

- **Hardware wallet + phone together** still take everything, and so does a user who approves on the device without
  reading. Savings protects against the online keys, not against both personal devices at once.
- **Coercion.** Anyone who can make the owner use the hardware wallet gets Savings.
- **Spending is as exposed as before**, more so with the limit off. Savings only helps for money actually moved there.
- **No restriction on where Savings can go.** Without covenants, no script can say "only back to Spending".
- **Privacy.** Every transfer links the two wallets on chain, and the guardian sees both.
- **T only:** coins past `N` after a missed refresh, a long wait after losing the hardware wallet, and a device screen
  that shows a template instead of a policy.
- **A dishonest app build** can still propose transactions. Only what the hardware wallet shows is checked.

## 7. Changes and plan

**Protocol** (all additive; new methods only to guardians that report them, new alerts dropped by older phones, which
need none of them):

- `savings.register { descriptor }` and `savings.unregister`, paired phone only, no approval (watch-only).
  `wallet.sync` accepts `wallet: "savings"`. `guardian.status.savingsWalletId?`. Alert `savings_moved { txid,
  amountSats }`.
- Phase 3: `savings.trust { approval }` (text above). The engine treats outputs to the trusted Savings wallet as kept.
- Limit off: the `policy v2` approval text, `dailyLimit.off?`, alert `limit_off`.
- T only: `recovery.start` with `savingsSweepPsbt` and `newSavingsDescriptor`, `savings_refresh_due`, and a miniscript
  descriptor type in `@trikey/core` (today `descriptor.ts` accepts only `wsh(sortedmulti(2,…))`).

**Storage.** Guardian state: `GuardedWallet.savings?` (descriptor, wallet id, high-water marks, `trustedAt?`,
`since`) and `limitBeforeOff?`; stays state version 2 (optional members). Phone: `WalletState.savings`,
`BackupPayload` v2 when Savings exists. Docs: DESIGN.md (rules, threat model, recovery table), PROTOCOL.md,
guardian-web `API.md`, CHANGELOG.

**Tests.** Limit off: the v2 text byte for byte in the engine and `@trikey/protocol`; off by approval, on from the
phone; refused in `pair` and during a recovery; reset at rotation; an older guardian refuses the v2 signature. Savings:
the backup v2 round trip and the older-app refusal; the descriptor matches Recovery Kit format 1; a phone thief's
`savings.register` cannot change what the limit counts; `savings.trust` without an approval is refused; with
it, outputs to Savings addresses beyond the gap window still count; every Savings transaction shape through
`tools/consensus-verify`; Ledger, Trezor, Coldcard and Jade sign a Savings PSBT on regtest or signet.

| Phase | Work | Size |
|---|---|---|
| 1. Limit off | Engine (`isLimitOff`, v2 text, `limitBeforeOff`, rotation reset), protocol, app toggle and warning, web UI, tests | S (3-4 days) |
| 2. Savings (K), watch-only guardian | `@trikey/wallet` second wallet on account 1' (reusing `packages/recovery-key`'s kit and xpub records), registration on devices, Home row, Savings screen, transfers, Receive choice, backup v2, Wallet details, guardian watch + `savings_moved`, web card, docs | M-L (2-3 weeks) |
| 3. Free transfers into Savings | `savings.trust` approval, engine counting, app copy, thief tests | S-M (4-5 days) |
| 4a. T spike (only if wanted) | Register and sign the T template on Ledger, Coldcard Edge, Jade over QR, BitBox02, Krux; record what each screen shows | 2-3 days |
| 4b. T (only if wanted) | Miniscript in core (parse, derive, satisfy, finalize), device registration (Ledger policy, Coldcard and Jade descriptors), guardian recovery with a second, maturing sweep, refresh scheduler and alerts | XL (5-7 weeks) |
| 5. Review | Security review of every phase before mainnet users | — |

## 8. Recommendation

Build the limit switch first (phase 1): it is small, and "off" is in effect available already (a hardware approval
can set the limit to 21 million BTC); the work is making it honest and visible and resetting it after a recovery.
Then build Savings as candidate K (phases 2 and 3): a plain 2-of-3 of the phone, the hardware wallet and a Recovery
Key, at account 1', with the guardian only watching. It removes the guardian's code from Savings' security, works on
every supported device including Trezor, and needs no refresh. Recommend a second hardware wallet as the Recovery Key.
Offer Savings in the "turn the limit off" flow. Keep T (hardware mandatory, timelocked phone + guardian path) as a
documented later option, behind the phase 4a test, for owners on Ledger, BitBox02, Jade or Coldcard Edge.

## Open questions for the owner

1. **K or T?** Is "every Savings spend needs a key that is not online (the hardware wallet or the Recovery Key)"
   enough, or is "the hardware wallet, always" worth losing Trezor and mainline Coldcard, plus a yearly refresh?
2. **Recovery Key form.** A second hardware wallet (recommended), the printed kit, or both offered?
3. **Free transfers into Savings** (phase 3), or keep them counted against the limit (simpler, no new approval)?
4. **T only:** `N` of about 6 months or about a year?
5. **Limit off:** tell the alert contacts too (recommended: it is rare, and contacts exist to notice what the owner
   did not do), or only the paired phone?
6. **Limit off and Savings:** only recommend Savings when the limit is turned off, or require it?
7. **After a recovery:** turn the limit back on at its last value (proposed), or keep the owner's choice? Decided: its last value, and 0 when that is not known (not the 100,000-sat preset). The "Turn off the daily
   limit" link stays a small link under Settings > Daily limit.
