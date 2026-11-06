# Trikey nostr protocol, version 1

How the Trikey phone app and the Trikey Guardian (on the user's home server) talk. Both only make outbound connections to nostr relays; everything is end-to-end encrypted, so relays can drop messages but cannot read or forge them. This is Trikey's own spec: no standard exists for PSBT exchange over nostr. The reference implementation is `@trikey/protocol`; "MUST/SHOULD" below describe what a compatible client has to do.

## 1. Identities

| Party | Key |
|---|---|
| Phone | secp256k1 key from the phone's BIP 39 seed, NIP-06 path `m/44'/1237'/0'/0/0` (`identityFromMnemonic` / `identityFromSeed`) |
| Guardian | its own random key, shown as an `npub` in the pairing QR |

Pubkeys are 32-byte x-only keys, lowercase hex on the wire. The guardian only answers pubkeys it paired with (plus `pair` itself, see section 6). Each side accepts messages only from the one peer it expects.

## 2. Transport: NIP-59 gift wrap

Every message (request, response, alert) travels as three nested events:

```
rumor  kind 21420, unsigned, authored by the sender          <- carries the JSON message
 seal  kind 13, signed by the sender, NIP-44 encrypted to the recipient, contains the rumor
 wrap  kind 1059, signed by a fresh random key, NIP-44 encrypted to the recipient, contains the seal
```

* **Rumor kind `21420`** is Trikey's RPC kind. It sits in the ephemeral range (20000-29999) so a rumor leaked onto a relay by mistake would not be stored. Rumors are never published.
* **Seal** and **wrap** are exactly as in NIP-59 (NIP-44 v2 encryption; the wrap is encrypted with the throwaway key's conversation key with the recipient). Their `created_at` is randomised into the past, as NIP-59 recommends: the seal's up to 2 days; the wrap's up to 2 days for alerts and up to 10 minutes for requests and responses (from 0.1.10; see "Wrap timestamps"). The rumor's `created_at` is the real send time and stays inside the encryption.
* **Wrap tags:** `["p", <recipient pubkey>]` and `["expiration", <unix seconds>]`, so relays can purge it. The wrap's `expiration` is **not** the rumor's: it is cleartext, and `rumor expiration - TTL` would be the send time, which the back-dating exists to hide. See "Wrap timestamps" below.
* The wrap is the only thing published. Publish it to every relay in the shared relay list; a message needs to reach just one.
* **Subscribing:** `{"kinds":[1059], "#p":[<own pubkey>], "since": now - 2 days - 10 min}`. The look-back is needed because wrap timestamps are back-dated (alerts by up to 2 days, and requests and responses from senders before 0.1.10 too); staleness is judged on the rumor (section 4), never on the wrap.
* **Each wrap is opened once.** A subscription is sent every stored wrap in its look-back again, on every relay, at every (re)subscription. A receiver SHOULD keep the ids of the wraps it handled across restarts and skip them before checking any signature or decrypting anything; see "Handled wraps" in section 4.
* **Implementation note (reference code).** The seal layer is encrypted with the conversation key of the two static keys, which never change between a phone and its guardian, so `@trikey/protocol` caches it per (secret key, peer) (`ConversationKeyCache`); only the wrap layer's ECDH with the throwaway key is done per message. The guardian opens each incoming wrap once (`openGiftWrap`) and routes the rumor by kind: 21420 to the RPC server, 14 (NIP-17 DMs from alert contacts) to the DM handler. Neither changes anything on the wire.

### Wrap timestamps

Let `W` be the back-dating window of the message's class: 600 s (10 minutes) for requests and responses, 172,800 s (2 days) for alerts (before 0.1.10, 2 days for every message), and `M` = the largest TTL the class allows (section 4: 3,600 s for requests and responses, 604,800 s for alerts). The sender draws `r` uniformly from the integers `0..W` with the checked random source (`secureRandomInt`) and sets, on the wrap:

```
created_at = floor(now) - r
expiration = created_at + W + M          (= now + M + (W - r), in [now + M, now + M + W])
```

* **No send time on the wrap.** The expiration is a function of the wrap's own `created_at` only, and so reveals nothing about `now` that `created_at` does not already: both come from the one draw `r`, and neither depends on the message's TTL. (An independent jitter of the same width would let a watcher intersect the two windows and narrow the send time down.) A relay still sees *when an event arrives*, so this hides the send time from anyone reading stored events later, not from the relay while it receives them.
* **Never in the past.** `created_at + W >= now`, so `expiration >= now + M`, at least one hour ahead when published, whatever the clock rounding.
* **Receivers still accept fresh messages.** Receivers judge freshness on the *rumor's* exact `expiration` (section 4), which is inside the encryption; they never read the wrap's tag. The wrap's expiration is always at or after the rumor's (a message's TTL is at most `M`, and a sender whose own rumor expiration were later would publish that value instead), so a relay never purges a wrap a receiver would still accept.
* **Not the TTL.** The wrap uses the class maximum `M`, not the message's own TTL, so a 30 s status call and a 1 h call look the same; only the class (alert or not) shows.
* **Cost.** A relay keeps a wrap for up to `W + M`: about 70 minutes for a request or response, about 9 days for an alert. Replay protection is unaffected: it uses the rumor's `created_at` and `expiration` only (section 4), never the wrap's tag, and wrap event ids are deduplicated separately.
* **Why requests and responses back-date only 10 minutes (0.1.10).** Back-dating hides the send time from someone who reads stored events later; it never hid it from the relays, which see each event arrive. For an interactive call it hides little even from a later reader: the phone's request and the guardian's answer (and the phone's next one, every minute while the app is open) arrive within seconds of each other, so the pattern of traffic shows when the phone was in use whatever the timestamps say. What the 2-day window did cost was large: every call's two wraps stayed on the relays for 2 days and an hour, and every subscription downloaded all of them again (on the owner's phone, 603 wraps on one relay, each a signature check and two decryptions on every app start). With `W` = 10 minutes the wraps expire about 70 minutes after they are sent, the order of messages within a few minutes is still not given away by `created_at`, and the expiration is still a function of `created_at` only. Alerts are pushed by the guardian when something happens (a recovery started, a payment refused), so their timing says more about the user and the alert must survive a phone that is off for days: they keep the 2-day window. So do NIP-17 DMs to alert contacts, which are read by ordinary nostr apps.
* **Compatibility.** Receivers keep the 2-day-and-10-minute look-back: the guardian for requests from phones before 0.1.10, the phone for alerts (and for answers from guardians before 0.1.10). A guardian from 0.1.10 lists `short_wraps` in `guardian.status.features` (section 7).
* NIP-17 direct messages to alert contacts (`wrapDirectMessage`) carry no `expiration` tag; their seal and wrap `created_at` are back-dated the same way.

### Rumor tags

| Tag | Required | Meaning |
|---|---|---|
| `["p", <recipient>]` | yes, exactly one | must equal the receiving pubkey |
| `["trikey", "1"]` | yes, exactly one | protocol version; anything else is rejected |
| `["expiration", <unix seconds>]` | yes, exactly one | the exact expiry, `created_at + TTL`; the message is void from this second on. Only the receiver sees it (the wrap's public `expiration` is different, see "Wrap timestamps") |
| `["psbt", <hex sha256>]` | iff the message carries a PSBT | sha256 of the *decoded* PSBT bytes; see below |

The rumor `content` is the JSON message (section 3), at most 200,000 characters. The rumor `id` must be correct and `rumor.pubkey` must equal `seal.pubkey`.

**PSBT hash rule.** A message carries a PSBT when it is a `sign` request (`params.psbt`), a `recovery.start` or `recovery.update` request (`params.sweepPsbt`), or a success response whose `result.psbt` is a string. Such a message MUST have a `psbt` tag equal to the lowercase-hex SHA-256 of the base64-decoded PSBT, and a message without a PSBT MUST NOT have one. At most one PSBT per message.

## 3. Messages (JSON, no `jsonrpc` field)

Envelopes, request `params` and `policy`/`approval` objects are strict: an unknown member is rejected, never dropped silently (a rule or field the guardian would ignore must not look accepted). Result objects (`result`, `recovery`) are lenient: a phone ignores members it does not know, so the guardian may add result members.

```jsonc
// request  (phone -> guardian)
{ "id": "<16-64 chars [A-Za-z0-9_-]>", "method": "sign", "params": { ... } }
// success response  (guardian -> phone); same id as the request
{ "id": "...", "result": { ... } }
// error response
{ "id": "...", "error": { "code": 1100, "message": "Guardian is locked", "data": null } }
// alert  (guardian -> phone); has an id for de-duplication, expects no reply
{ "id": "...", "method": "alert", "params": { "type": "recovery_started", ... } }
```

* **`id`** is unique per request (the reference client uses 128 random bits as hex). A retry re-sends the same request with the same `id` (see section 4).
* Direction is fixed: the guardian only accepts requests, the phone only accepts responses and alerts. Anything else is dropped.
* PSBTs are base64 strings (BIP 174, must start with `psbt\xff`), at most 100,000 characters.

### Time

**Every timestamp on the wire is unix time in seconds** (nostr's unit): `startedAt`, `readyAt`, `cancelledAt`, `completedAt`, alert `at`, `time`, and a hardware approval's `expiresAt`. The guardian's policy engine counts **milliseconds** internally (its clock, `startedAt`, `readyAt`, ...), so the guardian service converts with `Math.floor(ms / 1000)` whenever it puts an engine value in a message. The engine's hardware-approval `expiresAt` is already in seconds and passes through unchanged. A millisecond value is rejected by the schemas (above year 2100), which catches a missed conversion. Delays are in days (`delayDays`, `recoveryDelayDays`).

**Milliseconds, only where named `atMs`.** Seconds are too coarse to order events: two alerts, or an alert and a status answer, can share a second. Every alert and `guardian.status` therefore also carry **`atMs`**, unix *milliseconds* on the guardian's clock, with `at` / `time` kept (in seconds, `floor(atMs / 1000)`) for compatibility. For an alert it is when the thing happened (a recovery alert's `atMs` is the millisecond the engine recorded, not when the relay took it); for `guardian.status` it is when the guardian answered. Alerts and status answers share one clock, so a phone can tell whether an alert came before or after a status answer within the same second, and order alerts by `atMs`. It is optional in the schemas only so that messages from guardians before this member still parse; the schemas reject an `atMs` that is not within a second of its seconds twin (a missed conversion), and a phone that finds none falls back to `at` / `time`.

### Methods

`RelayList` = 1-8 distinct relay URLs, each exactly as `normalizeRelayUrl` writes it (the pairing code's rules, section 6). `Hex32` = 64 lowercase hex chars. `Sats` = integer 0..2,100,000,000,000,000 (exact as a JSON number). `UnixSeconds` = integer. `KeyOrigin` = `{ fingerprint: 8 hex, path: "m/48'/0'/0'/2'", xpub: string }`. `WalletId` = 16 lowercase hex chars (the engine's `MultisigWallet.fingerprint()`). `RecoveryId` = `[0-9a-z-]{1,40}`. `HardwareApproval`, `Policy` and `Recovery` are defined below.

| Method | Params | Result |
|---|---|---|
| `pair.prepare` | `pairingSecret`, `network`, `entropy?: Hex32` (the phone's contribution to key 3, see "Key 3 from both sides") | `guardianKey: KeyOrigin`, `guardianVersion`, `key3Mixed?: boolean`, `features?` (as `guardian.status.features`, which an unpaired phone cannot call: the phone puts `contactLock` in `pair`'s rules only when it lists `contact_lock`) |
| `pair` | `pairingSecret`, `deviceName` (1-64), `network` (`bitcoin`\|`testnet`\|`signet`\|`regtest`), `phoneKey: KeyOrigin`, `descriptor`, `phoneNostrPubkey: Hex32`, `hardwareAuth: { pubkey, path }`, `hardwareAuthProof`, `rules: Policy`, `rulesApproval?` (required by guardians with `pairing_rules_approval`, see "Pairing"), `replacesWalletId?: WalletId`, `replacesDescriptor?` (needs `replacesWalletId`; see "Replacing the guardian") | `guardianKey: KeyOrigin`, `descriptor`, `walletId`, `guardianVersion`, `key3Mixed?: boolean` |
| `sign` | `psbt`, `memo?` | `psbt` (with the guardian's partial signatures) |
| `policy.get` | `{}` | `policy`, `nextHardwareSequence`, `policyHash`, `warnings?` (`["no_alert_contacts"]`: no alert contact, so a recovery is announced only to the paired phone; mainnet guardians refuse such a policy, test networks warn) |
| `policy.update` | `policy`, `approval?` | `policy`, `nextHardwareSequence`, `policyHash` |
| `recovery.start` | `sweepPsbt`, `newDescriptor` | `recovery` |
| `recovery.update` | `recoveryId`, `sweepPsbt` | `recovery` (same id and `readyAt`, the new `sweepTxid`, `amountSats` and `feeSats`) |
| `recovery.cancel` | `recoveryId`, `approval?` | `recovery`, `contested: boolean` |
| `recovery.status` | `recoveryId?` (default: the active one) | `recovery` (or `null`), `psbt?` (the signed sweep, once the guardian has co-signed it) |
| `phone.resume` | `approval` | `phoneSpending: "enabled"` |
| `guardian.unlock` | `{kind:"passphrase", passphrase}` or (guardians with `hardware_unlock`) `{kind:"hardware", walletId, slot, signature}` (see "Unlocking with the hardware wallet"), or (guardians with `sealed_unlock`) `{kind:"sealed", sealed}`, either of them sealed to `guardian.status.unlockKey` (see "Sealed unlock") | `unlocked: boolean` (`1101` with `data.reason` `phone_unlock_disabled` after 5 wrong tries in a row, passphrases and hardware signatures alike, until the web UI unlocks, or `recovery_pending` while a recovery the phone did not start runs; for the hardware variant also `hardware_unlock_failed` (the signature does not open the slot: counted like a wrong passphrase) or `hardware_unlock_off` (no slot of that id: not counted); for the sealed variant also `unlock_key_stale` (sealed to a key the guardian no longer holds, or expired: not counted, seal again) or `sealed_unlock_invalid` (sealed to the current key but it does not open, or names another guardian, phone or request: counted like a wrong passphrase); the phone's attempts have their own rate limit) |
| `guardian.status` | `{}` | `state` (`locked`\|`unlocked`), `paired`, `nextHardwareSequence`, `phoneSpending` (`enabled`\|`paused_recovery`\|`paused_contested`\|`retired`), `activeRecoveryId`, `version`, `time`, `atMs?` (the guardian's clock in milliseconds when it answered, see "Time"), `dailyLimit?: { limitSats, usedSats, availableSats, off?: true, limitBeforeOffSats? }` (`off` while there is no daily limit; `limitBeforeOffSats` the limit before it was turned off, when known), `features?` (what the guardian can do beyond the base protocol, see "No daily limit"; unknown names are ignored), `walletId?`, `hardwareConfirmRequired?`, `watchedWalletId?` (the replaced wallet the guardian watches, if any), `key3Mixed?` (while paired: key 3 was made with the phone's `entropy`), `warnings?` (as `policy.get`'s), `relays?` (the guardian's current relays, section 5 "Changing relays"), `savingsWalletId?` (the Savings wallet it watches, guardians with `savings`; see "Savings"), `lock?: { reason, at, contact? }` (while locked, guardians with `contact_lock`: `reason` `restart`\|`manual`\|`remote`\|`contact`, `at` unix seconds, `contact` the alert contact who sent `LOCK`; see "Alert contacts can lock the guardian"), `hardwareUnlock?: { slot, addedAt }` (guardians with `hardware_unlock`: this wallet's hardware wallet can unlock the guardian, `slot` names the text it signs; sent while locked too), `unlockKey?: { pubkey }` (guardians with `sealed_unlock`, locked or unlocked: the key to seal `guardian.unlock`'s and `unlock.hardware.add`'s secret to, new at every lock, unlock and use, see "Sealed unlock") |
| `guardian.lock` | `{}` | `state: "locked"` (see "Locking from the phone") |
| `wallet.sync` | `historyLimit?` (1-500, default 100), `wallet?` (`"replaced"`, `"helper"`, `"savings"` or a `WalletId`; default the paired wallet) | `walletId?`, `tipHeight`, `tipHash`, `utxos`, `utxosTruncated`, `balance: { confirmedSats, unconfirmedSats }`, `history`, `historyTruncated`, `nextReceiveIndex`, `nextChangeIndex`, `gapLimit`, `coins?` (`"helper"` only) (see "Chain data", "Silent payments") |
| `tx.get` | `txid: Hex32`, `witness?: boolean` (default `true`) | `txHex` |
| `tx.broadcast` | `txHex` | `txid` |
| `wallet.unwatch` | `walletId?` (the watched wallet; default whichever is watched) | `unwatched: boolean`, `walletId?` (see "Replacing the guardian") |
| `fees.estimate` | `targets?` (1-8 block targets, 1-1008; default `[1, 3, 6, 144]`) | `estimates: [{ target, satPerVb \| null }]`, `minRelaySatPerVb` |
| `recovery.access` | `approval: { kind: "bip137", expiresAt, signature }` | `descriptor`, `walletId`, `network`, `guardianKey`, `hardwareAuth`, `policy`, `nextHardwareSequence`, `phoneSpending`, `activeRecoveryId`, `accessExpiresAt` (see "Recovery access") |
| `hardware.confirm` | `hardwareAuth: { pubkey, path }`, `hardwareAuthProof` | `walletId`, `hardwareAuth`, `nextHardwareSequence` (see "Wallet rotation") |
| `wallet.retire` | `approval` (of `retire-wallet`) | `walletId`, `retiredAt` (see "Replacing the guardian") |
| `singlekey.register` | `helper?: KeyOrigin` (the helper account, `m/84'/coin'/1'`), `coins?: [{ txid, vout, script }]` (at most 500; P2TR or P2WPKH scripts); at least one | `helper: boolean`, `coins` (how many are registered) (see "Silent payments") |
| `sp.register` | `scanPrivateKey: Hex32`, `spendPublicKey` (compressed), `labels` (1-1000 distinct integers 0..2^32-1, with 0), `birthHeight` | `registered: true`, `birthHeight`, `scannedHeight`, `tipHeight` |
| `sp.unregister` | `{}` | `unregistered: boolean` |
| `sp.scan` | `fromHeight?` | `tipHeight`, `birthHeight`, `scanning`, `matches: [{ txid, vout, valueSats, outputKey, tweak, label?, height }]` (at most 500, oldest first), `matchesTruncated` |
| `savings.register` | `descriptor` (the phone's Savings wallet), `walletId?` (`own_wallets_2`) | `walletId`, `since` (paired phone only; guardians with `savings`; see "Savings") |
| `savings.unregister` | `walletId?` (`own_wallets_2`) | `unregistered: boolean`, `walletId?` |
| `savings.get` | `walletId?` (`own_wallets_2`) | `savings: { walletId, descriptor, since } \| null` |
| `relays.ack` | `relays: RelayList` (the relays the phone uses now) | `current: boolean` (they are the guardian's current list, in any order), `relays: RelayList` (the guardian's current list) (paired phone only; see section 5, "Changing relays") |
| `hosted.prepare` | `inviteSecret` (43 base64url chars), `network`, `entropy: Hex32` (required) | `cosignerAccountPubkey` (compressed, no chaincode), `guardianVersion`, `features?` (see "Family hosting") |
| `hosted.pair` | `inviteSecret`, `deviceName`, `walletLabel` (1-64), `network`, `accountPubkeys: { app, hardware }`, `hardwareAuth: { pubkey, path, tweak: Hex32 }`, `hardwareAuthProof`, `rules: Policy`, `rulesApproval?` (over the key-set id; required by guardians with `pairing_rules_approval`), `walletMap` (base64url, at most 4096 bytes decoded), `phoneNostrPubkey` | `walletId` (the key-set id), `cosignerAccountPubkey`, `guardianVersion` |
| `hosted.coins` | `offset?`, `limit?` (1-100) | `walletId`, `coins: [{ txid, vout, valueSats, script, tweaks: { app, hardware, cosigner }, at }]`, `total`, `nextOffset?` |
| `hosted.map.get` | `walletId?` (default the hosted wallet; or a running recovery's destination) | `walletId`, `map` (or `null`) |
| `hosted.access` | `approval: { kind: "bip137", expiresAt, signature }` (the version-2 access text only) | `walletId`, `network`, `accountPubkeys: { app, hardware, cosigner }`, `hardwareAuth`, `policy`, `nextHardwareSequence`, `phoneSpending`, `activeRecoveryId`, `accessExpiresAt` |
| `wallet.add.prepare` | `account` (even, 2-14) | `account`, `guardianKey: KeyOrigin` (key 3 of the new wallet at that account; see "Own wallets") |
| `wallet.add` | `account`, `name` (1-16), `descriptor`, `hardwareAuth: { pubkey, path }`, `hardwareAuthProof`, `rules: Policy`, `rulesApproval?` (by the new wallet's hardware wallet; required by guardians with `pairing_rules_approval`), `firstName?` (1-16, the first wallet's name), `hardwareKind?`, `replacesWalletId?`, `replacesDescriptor?` (the last three: guardians with `own_wallets_2`) | `walletId`, `account`, `name`, `descriptor`, `guardianKey` (see "Own wallets") |
| `labels.put` | `walletId` (required: the wallet's current id), `upload` (16 random bytes, hex), `part`, `parts`, `bytes`, `sha256: Hex32` (of the whole blob), `data` (base64url, at most 24 KiB decoded) | `walletId`, `received` (parts held), `stored?: { at, bytes, sha256 }` (once the last part arrived) (paired phone only; guardians with `labels_backup`; see "Encrypted notes") |
| `labels.get` | `walletId?`, `of?: WalletId` (default the wallet's current id), `version?` (0 newest, 0-2), `part?` | `of`, `versions: [{ at, bytes, sha256 }]` (newest first; empty: no copy), `part?: { version, index, parts, data }` (paired phone, or a phone with recovery access) |
| `labels.list` | `walletId?` | `copies: [{ of, versions }]` (the wallet's copy and those of the wallets it was recovered from) (paired phone, or a phone with recovery access) |
| `labels.delete` | `walletId?` | `deleted: WalletId[]` (every copy of the wallet's line) (paired phone only) |
| `unlock.hardware.add` | `walletId` (required), `slot` (8 random bytes, hex, picked by the phone), `signature` (the hardware wallet's BIP 137 signature of the unlock text) or (guardians with `sealed_unlock`) `sealed`, that signature sealed to `guardian.status.unlockKey` (see "Sealed unlock") | `walletId`, `slot`, `addedAt` (paired phone only, the guardian unlocked; guardians with `hardware_unlock`; see "Unlocking with the hardware wallet") |
| `unlock.hardware.remove` | `walletId` (required) | `walletId`, `removed: boolean` (paired phone only; locked or unlocked) |

Guardians with `own_wallets` also take an optional **`walletId`** in the params of `guardian.status`, `sign`, `policy.get`, `policy.update`, `recovery.start` (the own form), `recovery.update`, `recovery.cancel`, `recovery.status`, `phone.resume`, `hardware.confirm`, `wallet.retire`, `wallet.sync`, `tx.get` and `tx.broadcast`: the request acts on that wallet of the box's owner. Absent, it means the first wallet, as before (see "Own wallets"). Guardians with `own_wallets_2` take it in `savings.register`, `savings.unregister` and `savings.get` too, and guardians with `labels_backup` in `labels.*`; `unlock.hardware.*` always name it (`hardware_unlock`).

**Policy** is exactly the rules the guardian's policy engine enforces, and nothing else: four always, and one opt-in rule that is present only when it is on:

| Member | Rule |
|---|---|
| `dailyLimitSats` | most the phone + guardian may spend in any rolling 24 h (`Sats`; 0 means never; the largest `Sats`, `LIMIT_OFF_SATS`, means no daily limit, see below) |
| `recoveryDelayDays` | Delay & Notify period: **7, 14 or 30** |
| `alertContacts` | up to 20 nostr pubkeys (`Hex32`, lowercase) that receive recovery alerts and may cancel a recovery |
| `sweepFeeCapSats` | highest absolute fee a recovery sweep may pay (`Sats`, at least 1) |
| `contactLock?` | `true`: the alert contacts may lock the guardian with a `LOCK` DM (opt-in, see "Alert contacts can lock the guardian"). Absent or `false` (normalized away): off, as it always was. Only guardians that report `contact_lock` know this member |

The schema is **strict**: any other member (the old `perTxLimitSats` and `allowlist` included) is a validation error, not preserved or ignored, so the protocol never carries a rule the guardian does not enforce. `policyHash` = hex SHA-256 of the canonical JSON (keys sorted by UTF-16 code unit, no whitespace) of the *normalized* policy: `alertContacts` lowercased, deduplicated and sorted, and exactly the four members, plus `"contactLock":true` (sorted between `alertContacts` and `dailyLimitSats`) only when it is on:

```
{"alertContacts":["<hex>",...],"dailyLimitSats":100000,"recoveryDelayDays":14,"sweepFeeCapSats":20000}
{"alertContacts":["<hex>",...],"contactLock":true,"dailyLimitSats":100000,"recoveryDelayDays":14,"sweepFeeCapSats":20000}
```

So a policy without the opt-in rule hashes exactly as it did before the member existed.

This is byte for byte the engine's `policyHash(rules)` (a test compares them). The guardian stores and returns the normalized policy.

**Which changes need the hardware wallet.** The phone alone may only *tighten*: lower `dailyLimitSats`, raise `recoveryDelayDays` and/or turn `contactLock` on, nothing else changing. Turning `contactLock` off takes a protection away and needs `approval`. Raising the limit, shortening the delay, changing the fee cap (a lower cap could block a genuine recovery, so it is not a safe direction) or the contacts needs `approval`. Without it the guardian answers `ApprovalRequired`. While a recovery is running, hardware-approved policy changes are refused (`RecoveryAlreadyActive`).

**No daily limit.** `dailyLimitSats` = `LIMIT_OFF_SATS` (2,100,000,000,000,000, all bitcoin there will ever be) means there is no cap on what the phone + guardian co-sign. It is not a new `Policy` member, so `policyHash` and the protocol version are unchanged; every other rule still applies, and the guardian still counts what it co-signs (`dailyLimit.usedSats`). Only guardians that list `limit_off` in `guardian.status.features` (`GUARDIAN_FEATURES.limitOff`) know it, and only to them does a phone offer it. Such a guardian:

* accepts it only as a loosening: a fresh hardware approval over the **version-2 policy text** (below), which says `limit=off` in words; refused during a recovery (`RecoveryAlreadyActive`) like every hardware-approved change, and **refused in `pair`** (`-32602`, the engine's `invalid_registration`), even with a `rulesApproval`: a wallet starts with a limit, and the phone turns it off after pairing, with its own approval and alerts;
* lets the phone alone turn it back on: any lower limit is a tightening;
* remembers the limit it had (`dailyLimit.limitBeforeOffSats`), and when a completed recovery makes it adopt the destination wallet, starts that wallet with the limit **on** at that value (0, "never", when it is not known: a maximum limit set before the guardian knew "off"). "Replace guardian" pairs a new guardian, so the phone pairs it with that limit too;
* alerts: `limit_off` to the paired phone and a NIP-17 DM to every alert contact (old and new, when the same change edits them) when it is turned off; `limit_on` to the paired phone when it is on again (also after a recovery). It retries an undelivered one for 7 days, as recovery alerts.

An older guardian rebuilds the version-1 text for that value and so answers `1202` (ApprovalInvalid) to a version-2 signature: it refuses cleanly, never with a limit the device did not show. A phone talking to a guardian without the feature signs the version-1 text for every policy (`approvalMessage` with `legacyPolicyText`), so any other change keeps working.

### Hardware approvals

A `HardwareApproval` is `{ kind: "bip137", sequence, expiresAt, signature }`:

* `signature`: BIP 137 signature (base64, 65 bytes, header 27-42) by the single-sig authorization key recorded at pairing (`hardwareAuth`), over the text from `approvalMessage(action, { walletId, sequence, expiresAt })` below.
* `sequence`: one counter shared by **all** approvals (policy changes, `cancel-recovery`, `resume-phone`, `retire-wallet`), and across wallet rotations (it never goes back when the guardian adopts a new wallet). It must be greater than the highest sequence the guardian has accepted, and at most 1000 greater. `nextHardwareSequence` in `guardian.status` / `policy.get` is the smallest acceptable value. A rejected approval does not consume its sequence.
* `expiresAt`: unix **seconds**, in the future and at most 24 hours after the guardian checks it.
* There is no `address` member: the guardian verifies against the public key, not an address.

The guardian never parses text from the phone. It rebuilds the text from the request and its own state and verifies the signature over that, so the phone must display the same text to the user and ask the device to sign it. `approvalMessage` and `pairingMessage` in `@trikey/protocol` reproduce the engine's functions exactly. The texts are one line of printable ASCII, at most 240 characters:

| Action | Text |
|---|---|
| `policy` | `Trikey policy v1 wallet=<walletId> seq=<n> limit=<sats> delay=<days>d feecap=<sats> contacts=<count> hash=<policyHash> expires=<ISO 8601 UTC, seconds>` (of the *new* policy) |
| `policy` where the alert contacts may lock the guardian: the new policy has `contactLock`, or the current one has and the new one does not (guardians with `contact_lock`) | `Trikey policy v3 wallet=<walletId> seq=<n> limit=<sats\|off> delay=<days>d feecap=<sats> contacts=<count> lock=<on\|off> hash=<policyHash> expires=<ISO>` (`lock=` is the new policy's value, so turning it off says `lock=off`; the limit as in versions 1 and 2; at most 238 characters) |
| `policy` with no daily limit (`dailyLimitSats` = `LIMIT_OFF_SATS`; guardians with `limit_off`) | `Trikey policy v2 wallet=<walletId> seq=<n> limit=off delay=<days>d feecap=<sats> contacts=<count> hash=<policyHash> expires=<ISO>` (the hash is the same `policyHash`; at most 216 characters) |
| `cancel-recovery` | `Trikey cancel-recovery v1 wallet=<walletId> seq=<n> recovery=<recoveryId> expires=<ISO>` |
| `resume-phone` | `Trikey resume-phone v1 wallet=<walletId> seq=<n> expires=<ISO>` |
| `retire-wallet` | `Trikey retire-wallet v1 wallet=<walletId> seq=<n> expires=<ISO>` |
| pairing proof | `Trikey pair v1 wallet=<walletId> guardian=<cosignerAccountPubkey hex>` |
| the rules a wallet starts with (`rulesApproval` in `pair`, `wallet.add`, `hosted.pair`; guardians with `pairing_rules_approval`) | the `policy` text of `rules` with **`seq=0`**: `Trikey policy v1 wallet=<walletId> seq=0 limit=<sats> delay=<days>d feecap=<sats> contacts=<count> hash=<policyHash> expires=<ISO>` (version 3 with `lock=on` when `rules.contactLock`), `pairingRulesMessage(rules, { walletId, expiresAt })` |
| recovery access | `Trikey recovery-access v2 wallet=<walletId> guardian=<guardian nostr pubkey hex> phone=<new phone's nostr pubkey hex> expires=<ISO>` when the phone knows the wallet id (from the recovery code, or when renewing), else `Trikey recovery-access v1 guardian=... phone=... expires=<ISO>` (no wallet id and no sequence: see "Recovery access") |

A `PairingRulesApproval` is `{ kind: "bip137", expiresAt, signature }`: no `sequence` member (the text has `seq=0`), `expiresAt` as for an approval (in the future, at most 24 hours ahead), `signature` by the authorization key the same request registers. Sequence 0 is never a valid `HardwareApproval` (those need a sequence above the last accepted one, which starts at 0, and the schema requires at least 1), so the signature cannot be replayed as a later change; it names the wallet, whose id covers key 3, so it is worth nothing to another wallet or another guardian. Pairing consumes no sequence: `nextHardwareSequence` is still 1 afterwards.

Example: `Trikey resume-phone v1 wallet=0123456789abcdef seq=4 expires=2030-03-17T17:46:40Z`. `walletId` is the `walletId` of the `pair` result (the engine's descriptor fingerprint); `expires` is `expiresAt` as `YYYY-MM-DDTHH:MM:SSZ`.

**Where approvals go**

| Action | Request |
|---|---|
| change the policy beyond tightening | `policy.update` with `approval` |
| cancel a recovery as the hardware wallet | `recovery.cancel` with `approval` (the hardware wallet has no nostr identity, so the request itself may come from any authorized peer) |
| resume phone payments after a contested cancel | `phone.resume` with `approval` |
| retire the wallet on this guardian | `wallet.retire` with `approval` |

After a wallet rotation every approval is refused with `1209 HardwareAuthUnconfirmed` until `hardware.confirm` (see "Wallet rotation").

### Pairing

Pairing is two requests, both allowed from an unpaired sender:

1. **`pair.prepare`** `{ pairingSecret, network, entropy? }` returns the guardian's key (key 3). The phone needs it first: the pairing proof signs the wallet id and the guardian's account pubkey, and the wallet id is the fingerprint of the full descriptor, which contains that key. It does not use up the secret. With `entropy` the key is made from the guardian's seed and the phone's bytes (next section) and the answer says `key3Mixed: true`. The phone may send `pair.prepare` more than once; the last one of the pairing session decides the key that `pair` registers.
2. The phone builds `wsh(sortedmulti(2, <phone>, <hardware>, <guardian>))` (keys in that order), computes `walletId` and the guardian's raw account pubkey (the public key inside `guardianKey.xpub`), has the hardware wallet BIP 137-sign `pairingMessage(walletId, cosignerAccountPubkey)` with a single-sig key it will use for all later approvals, and sends **`pair`**:
   * `descriptor`, `phoneKey`, `network`: the wallet;
   * `phoneNostrPubkey`: the phone's nostr key, which MUST equal the authenticated sender; it receives alerts and may cancel recoveries;
   * `hardwareAuth: { pubkey, path }`: the compressed pubkey (33 bytes hex) of the authorization key and the path the device signs with;
   * `hardwareAuthProof`: the BIP 137 signature (base64) over the pairing text;
   * `rules`: the initial policy;
   * `rulesApproval`: guardians that list `pairing_rules_approval` in `pair.prepare.features` (and `guardian.status.features`): the hardware wallet's BIP 137 signature, by the same authorization key, over `pairingRulesMessage(rules, { walletId, expiresAt })`, the policy text with `seq=0` ("Hardware approvals"), which the device shows so the owner checks the limit, delay, fee cap and number of contacts. The phone sends it only to such a guardian: an older one refuses the member (strict schema) and accepts the rules unapproved, as before;
   * `replacesWalletId?` / `replacesDescriptor?`: only when this wallet replaces another one (see "Replacing the guardian").

   The guardian checks the descriptor, that the three keys are distinct and that the guardian key sits in its slot, the rules, the key (and, when the path lies under the hardware xpub, that it derives from it), the proof and (with `pairing_rules_approval`) the rules approval: it rebuilds the text from the normalized rules it will store, so the wallet starts with exactly the rules the device signed. It then registers the wallet and burns the secret.

   **The rules a wallet starts with are hardware-approved** (security review 2026-11, DESIGN.md rule 4): before, the device signed only the pairing proof, which names no rule, so an app could start a wallet with any rules but "no daily limit" (a limit one satoshi below it, a fee cap as large as all bitcoin, its own alert contact) and drain it with phone + guardian. A guardian with `pairing_rules_approval` refuses:
   * a `pair` with no `rulesApproval` (an app from before): `-32602` (InvalidParams), `data: { reason: "app_update_required" }`, a message that says to update the app; nothing is registered. Pairing is rare, and refusing is safer than accepting rules no device showed;
   * one over other rules, another wallet id or by another key: `1202` (ApprovalInvalid, `data.reason: "approval_invalid_signature"`); expired: `1203`; more than 24 hours ahead: `1206`;
   * "no daily limit", approved or not (`-32602`).

   The same holds for `wallet.add` (signed by the new wallet's hardware wallet, over its id) and `hosted.pair` (over the key-set id). Wallets paired before are unaffected.

### Key 3 from both sides

So that a guardian setup seed known on its own does not give key 3, the phone contributes to it. Format **`trikey/key3/v1`**:

* **`entropy`** on `pair.prepare`: `c`, 32 fresh random bytes from the phone's checked generator, lowercase hex. The app always sends it. It is not secret: without the guardian's seed it says nothing about key 3.
* The guardian derives the wallet's key 3 as

  ```
  seed3 = HMAC-SHA512(key  = the guardian's 64-byte BIP 39 setup seed,
                      data = "trikey/key3/v1" || walletContext || c)
  walletContext = u32be(len) || utf8(network)
               || u32be(len) || utf8(pairing session id)
               || u32be(32)  || the phone's nostr pubkey (the request's sender)
  key 3 = BIP 32 master of seed3, account m/48'/<coin>'/0'/2'
  ```

  The context binds the network, this pairing session and this phone, so the same `c` sent again (to a new pairing, by another phone, on another network) gives another key.
* A guardian that knows `entropy` MUST use it and answers `key3Mixed: true` on `pair.prepare`, on `pair` and (while that wallet is paired) on `guardian.status`. Without `entropy` it uses its own key (the account of its setup seed), as before, and answers `key3Mixed: false`.
* The guardian keeps `c` and `walletContext` with the wallet's registration and derives key 3 again at every unlock. A wallet rotation (the guardian adopting a recovery's destination wallet) keeps the same key 3, and so the same record; a reset makes a new setup seed; a new pairing gets a new `c`.
* The phone never learns key 3: it sees only the account xpub. What this protects against is a guardian seed known on its own (leaked, or weak seed generation alone). Not against a guardian whose whole generator is predictable to someone who reads the relays: `c` travels in this gift wrap, encrypted to the guardian's nostr key, which comes from that same generator. The guardian covers that case at setup, by mixing in entropy that never crosses a relay (DESIGN.md, "Entropy", `trikey/guardian-seed/v1`). Nor against a dishonest guardian: one could ignore `c`, and that cannot be proven without revealing key 3.
* Compatibility: a guardian from before this member has a strict `pair.prepare` schema and drops a request that carries `entropy` as malformed (it answers no unpaired sender), so the phone needs a guardian of this version or later to pair. Phones from before this member send no `entropy` and get the old behaviour.

### Recovery

A `Recovery` object (the engine's `RecoveryView`, with times in seconds):

| Member | |
|---|---|
| `recoveryId` | `RecoveryId` |
| `state` | `pending` \| `ready` \| `cancelled` \| `completed` |
| `survivingRole` | `app` \| `hardware`: the key that signed the sweep |
| `startedAt`, `readyAt` | when it started, and when the delay ends and the guardian may co-sign |
| `delayDays` | 7, 14 or 30, snapshotted at start (later policy changes do not affect a running recovery) |
| `sweepTxid`, `destinationWalletId`, `amountSats`, `feeSats` | what the sweep does |
| `cancelledAt?`, `cancelledBy?`, `completedAt?` | `cancelledBy` is `app` \| `contact` \| `hardware` \| `superseded` (closed by the guardian when another, completed recovery of the same wallet swept it and the wallet rotated) |

* **`recovery.start`**: the sweep PSBT must be signed on every input by **one** surviving key, either the phone's or the hardware wallet's. The guardian reads which from the signatures. `newDescriptor` must keep the surviving key and drop the other user key. The fee must not exceed `sweepFeeCapSats`. Alerts go to the paired phone and every alert contact. The guardian needs its chain data to start one (`1501` `chain_unavailable` without it): the delay counts from the later of its clock and the chain's median time past (`readyAt`), and completes only when its clock, the median time past and the block count since the start (144 per day of delay; 1 on regtest) all agree. Refused `sign`, `recovery.start` and `recovery.update` requests are rate limited per sender (30 per 10 minutes, then `1500` RateLimited).
* **`recovery.update`**: for coins that arrived after the start (a sweep must move every coin of the wallet, so even dust blocks the completion). The surviving key signs a new sweep that spends every input of the current one plus the new coins, to the same destination; the guardian swaps it in **without restarting the delay** if it pays only `newDescriptor` of the running recovery, every input is the wallet's and is signed by the same surviving key alone, it spends a superset of the current sweep's inputs, and the fee is within the cap (the smaller of the cap at the start and now). Everything is checked again at completion. Who may call it: whoever may call `recovery.start`. Errors as for `recovery.start`; `1300`/`1302` when `recoveryId` is not the running recovery.
* **`recovery.cancel`** may be sent by the paired phone or an alert contact (the guardian authenticates the sender's nostr key; it must let contacts through its peer check for this method) without `approval`, or with an `approval` of `cancel-recovery` for the hardware wallet. `contested` is true unless the canceller holds the key that started the recovery (the phone cancelling a phone-started recovery, or the hardware wallet cancelling a hardware-started one); a contested cancel pauses phone payments (`phoneSpending: paused_contested`) until `phone.resume`.
* **`phone.resume`** needs an approval of `resume-phone` and only works when phone payments are paused by a contested cancel and no recovery is running.
* **`recovery.status`**: the engine marks a recovery `completed` when it co-signs the sweep, not when the sweep confirms. `psbt` is that co-signed sweep; broadcasting it is up to the phone or the guardian service.

**Cancelling from a regular nostr app.** Alert contacts also get each recovery alert as a NIP-17 private DM (kind 14 rumor in a NIP-59 gift wrap), so they can read it in Damus, Amethyst or Primal. A contact cancels by replying to that DM with `CANCEL <recoveryId>` (case-insensitive, nothing else on the line); the guardian treats it like `recovery.cancel` from that contact. Alert contacts may call `recovery.cancel` and nothing else.

### Wallet rotation: the guardian adopts a recovery's destination wallet

A recovery sweeps the wallet to a new wallet that keeps the surviving key. When that new wallet also keeps **this guardian's key**, the guardian becomes its guardian; otherwise it just retires the old wallet. The guardian holds **one active wallet** and any number of **retired** ones (read-only history: it co-signs nothing for them, starts no recovery of them, and answers `1004 WalletRetired` when a request spends from one).

1. **When.** Not when the guardian co-signs the sweep, but once a node has **accepted the sweep** (the broadcast went through, or Electrs already knows the transaction). Confirmation is not awaited: after completion key 3 refuses everything for the swept wallet, so nobody but the user (the surviving key plus the lost one) could make a conflicting spend, and waiting for blocks would leave the recovered user without a guardian (no co-signing, no CPFP through the guardian) for no added safety.
2. **What carries over.** The rules (limit, delay, fee cap, contacts) and the hardware sequence counter. Key 3 is the same, and so is how it is derived (`key3Mixed` stays as it was). The 24 h limit window starts empty: phone payments were paused for the whole delay (at least 7 days), so nothing spent from the old wallet is still inside it.
3. **The paired phone** becomes the phone that sent `recovery.start` (the surviving phone, or the new phone that got in with `recovery.access`). It gets a `wallet_adopted` alert, and `guardian.status` shows the new `walletId`. The phone that was paired to the swept wallet, if it is a different one, gets a `wallet_retired` alert with `reason: "recovered"` and `successorWalletId` (and is no longer a peer); with no adopted wallet it gets the alert without a successor.
4. **The hardware authorization key** is re-established for the new wallet's hardware key: when the hardware wallet survived, the same key; when it was replaced, the key at the same path relative to the new hardware xpub (when the old key's path lies below the hardware account by non-hardened steps; otherwise the guardian knows no key until the phone sends one). Either way it is **unconfirmed**, and every hardware approval (policy loosening, hardware cancel, `phone.resume`, `wallet.retire`) is refused with `1209` until **`hardware.confirm`**: the paired phone sends `hardwareAuth` and a fresh BIP 137 `hardwareAuthProof` over `pairingMessage(newWalletId, cosignerAccountPubkey)`, exactly as at pairing. The key must be the expected one (and, below the hardware xpub, derive from it). Co-signing within the limit and tightening the rules work meanwhile. Sending `hardware.confirm` again for a confirmed wallet with the same key and a valid proof is a no-op.
5. **Recovery access** grants (`recovery.access`) belonged to the old wallet and are revoked.

### Replacing the guardian

When the box dies or is replaced, the phone and the hardware wallet move the funds to a new wallet whose third key is the **new** guardian's (that sweep needs no guardian).

* **Old guardian still alive:** the paired phone sends **`wallet.retire`** with a hardware approval of `retire-wallet` (stale sequence `1204`, bad signature `1202`, a running recovery `1301`). The wallet is retired: from then on every co-sign is refused, the old phone is no longer a peer, and pairing is open again for a new wallet (the web UI can make a pairing code). The same descriptor can never be paired again on that guardian (`1004`). The phone gets a `wallet_retired` alert too.
* **Old guardian gone:** nothing to do on its side. A fresh guardian pairs the phone like any other (section 6): the phone builds a new descriptor with its existing key 2, the existing hardware key and the new guardian's key from `pair.prepare`, so the wallet id, the pairing proof and every later approval are new. `replacesWalletId` names the old wallet for the guardian's log. With **`replacesDescriptor`** (the old wallet's descriptor) the new guardian also *watches* the old wallet, so the phone needs no public server to move the money; see below. A phone that sends only `replacesWalletId` (older apps) gets exactly the earlier behaviour: nothing is watched.

**Watching the replaced wallet.** `pair` may carry `replacesDescriptor` together with `replacesWalletId` (a descriptor without the id is `-32602`, from the schema). The guardian then checks that:

1. the descriptor parses as a Trikey wallet on the guardian's network, and its fingerprint equals `replacesWalletId` (else `-32602`, "replacesDescriptor does not hash to replacesWalletId", and the pairing does not happen; like any refused `pair` it counts as one failed attempt against the pairing code);
2. it is not the wallet being paired;
3. it shares the phone's key or the hardware wallet's key with the new wallet (a replacement changes the guardian's key and keeps the user's; one shared key is enough, so a replaced hardware wallet can still be moved).

It stores the descriptor as a **watched-only wallet** that belongs to the paired wallet: the guardian never co-signs for it (key 3 is not in it, or is another guardian's key), starts no recovery of it, accepts no hardware approval for it, and drops it when the paired wallet is retired, rotated or reset. A watched wallet gives the paired phone three things:

* **`wallet.sync` with `wallet: "replaced"`** (or the watched wallet's id) reads its coins and history exactly like the paired wallet's, with `walletId` in the result saying which wallet it is. With no watched wallet, or another id: `1005 WalletNotWatched`. The id of the paired wallet itself is the same as omitting `wallet`. A phone with `recovery.access` may read it too (it can already read the paired wallet).
* **`tx.get`** serves the transactions of its coins, as it serves any transaction Electrs knows, so the phone can build `nonWitnessUtxo` for the sweep.
* **`tx.broadcast`** relays a signed sweep of its coins into the paired wallet (rules under "Chain data").

**`wallet.unwatch`** (the paired phone only, no approval: it only removes capability) stops all three: the watched descriptor is deleted, `wallet.sync` for it answers `1005` and a sweep of its coins is `1602` again. `walletId` names the wallet to drop; omitted, whatever is watched. Nothing watched, or a different id: nothing changes and the answer is `{ "unwatched": false }`, so a repeated request is harmless. `guardian.status.watchedWalletId` says whether a wallet is watched. The phone should send `wallet.unwatch` once the old wallet is empty and it has no use for it (or keep watching to catch late deposits to old addresses, as `sweepStrayCoins` does).

### Locking from the phone

**`guardian.lock`** drops key 3 from the guardian's memory, as the web UI's Lock button does, for when the user thinks the box was physically compromised. Only the paired phone may send it (anyone else is dropped without an answer, section 4). It needs no approval because it only reduces what the guardian can do, and it is answered `{ state: "locked" }` even when the guardian already was. The phone (and the web UI) see a `guardian_locked` alert with `reason: "remote"`. Unlocking is unchanged: `guardian.unlock` or the web UI.

### Alert contacts can lock the guardian

Opt-in (`Policy.contactLock`, DESIGN.md rule 8, docs/design/contact-lock.md). Only guardians that list `contact_lock` in `guardian.status.features` (and in `pair.prepare.features`) know it, and only to them does a phone send it. While it is on, an **alert contact of the active wallet** can lock the guardian from an ordinary nostr app:

* **The command** is a NIP-17 DM to the guardian whose text is the single word `LOCK` (case-insensitive, an optional trailing `.` or `!`, surrounding blank lines and quoted `>` lines ignored, so a reply quoting an alert works). Anything else is not the command (`don't lock it`, `lock?`, `LOCK 3-0123…`). It needs no code from an alert: a contact may lock on what they hear from the owner as much as on an alert, and a mistaken lock costs only an unlock.
* **The effect** is exactly the locked state of `guardian.lock`: key 3 leaves memory, nothing is co-signed (phone-only payments get `1100`); recoveries, their timers and their alerts run on as on any locked guardian (a ready recovery is co-signed once the owner unlocks). Nothing else changes: not the rules, not a recovery. A contact can only lock: never unlock, change rules or read anything.
* **Answers.** While the setting is on, the contact gets one short DM: locked; or already locked (nothing changed, nobody alerted). While it is off, the command does not exist: no answer, nothing changed, nothing logged. Anyone who is not an alert contact of the active wallet (a stranger, the paired phone's key, a running recovery's recipient no longer in the rules) gets **no answer at all**, so the command cannot be used to probe who is a contact or whether the setting is on. Only messages whose own timestamp is within 10 minutes of the guardian's clock count, each message once (remembered durably, as state-changing requests are: relays re-deliver old wraps after a restart), and at most 5 per contact per hour (more are dropped silently).
* **Alerts.** A lock is logged (`Locked by alert contact npub… via nostr`) and alerts, retried for 7 days like `limit_off`: `guardian_locked` with `reason: "contact"` and `contact` to the paired phone, and a NIP-17 DM to every **other** alert contact saying who locked it and when. The guardian also DMs the alert contacts when the setting goes on (how to lock) or off (`LOCK` no longer works), and while it is on, its recovery and `limit_off` DMs end with how to lock.
* **Unlocking** is unchanged: the owner's passphrase in the web UI, or the phone's `guardian.unlock` with its own throttle.
* **The setting**: on is a tightening (the phone alone, also in `pair` and during a recovery); off needs a hardware approval over the version-3 text, `lock=off` (refused during a recovery, like every hardware-approved change). The rules, `contactLock` included, carry over to a wallet a recovery adopts.

### Chain data

The guardian already has the wallet's descriptor and a chain source (the user's own Electrs, see "Chain source" below), so it serves the paired phone's chain data and broadcasts for it: the phone never asks a server itself. `wallet.sync`, `tx.get`, `tx.broadcast` and `fees.estimate` need no key 3, so they **work while the guardian is locked**. Only the paired phone may call them (plus, for the reads, a phone with recovery access); requests from anyone else are dropped without an answer like every other unauthorized request. Amounts are `Sats` (JSON numbers); heights are 0 while unconfirmed.

* **`wallet.sync`** scans both chains of the descriptor (receive `0`, change `1`) the way the guardian checks recovery coverage: until `gapLimit` (20) consecutive addresses have no history.
  * `utxos`: `{ txid, vout, valueSats, height, confirmations, chain, index }`, every unspent output, confirmed ones first by value, at most 500 (`utxosTruncated` says there are more; `balance` always counts all of them). `chain`/`index` are the derivation steps below the account keys, which the phone needs to build the PSBT input.
  * `history`: `{ txid, height, confirmations, time?, netSats, feeSats? }`, newest first (unconfirmed, then by height), at most `historyLimit` (`historyTruncated`). `netSats` is what the transaction did to the wallet's balance: received minus spent, fee included, negative for payments. `feeSats` is present when every input belongs to the wallet (otherwise the guardian does not know all input amounts). `time` is the block's timestamp.
  * `nextReceiveIndex` / `nextChangeIndex`: the first index with no history on each chain. The phone receives at `nextReceiveIndex` and sends change to `nextChangeIndex`.
* **`tx.get`** returns a raw transaction (for PSBT `nonWitnessUtxo`) after checking it hashes to `txid`, so a confused Electrs cannot hand the phone a different transaction. With `witness: false` it is the serialization without witness data: same txid, all `nonWitnessUtxo` needs, and much smaller. Unknown: `1600 TxNotFound`. At most 150,000 hex characters, else `1603 TxTooLarge`.
* **`tx.broadcast`** relays a fully signed raw transaction, but the guardian is not an open relay: it relays **only** (a) one that **spends at least one output paying one of the paired wallet's addresses** (within the scanned range), (b) a **sweep of the watched wallet into the paired wallet** (below), (c) a **sweep of the phone's single-key coins into the paired wallet** (below), or (d) one that **spends at least one coin of the watched Savings wallet** (guardians with `savings`; see "Savings"). Otherwise `1602 ForeignTransaction`, with `data.reason` naming the rule that failed. Each paired phone may call it at most 20 times per 10 minutes, refused calls included (`1500 RateLimited`, `data.retryAfterSeconds`); the check can scan both wallets on Electrs. It needs no key 3.
  * **A sweep of the watched wallet** (rule b) must satisfy all of: the current pairing named that wallet in `replacesWalletId` and the guardian holds its descriptor (else `data.reason: "spends_no_wallet_coin"`); at most 500 inputs (`too_many_inputs`) and 10 outputs (`too_many_outputs`, which also covers none); **every input** spends a coin of the watched wallet, i.e. its transaction is in the watched wallet's history and the previous output pays one of its addresses, the previous transactions being fetched and checked against their txid (`input_not_from_replaced_wallet`); **every output** pays an address of the paired wallet, receive or change, within the scanned range (`output_not_to_wallet`); the outputs do not exceed the inputs (`outputs_exceed_inputs`); and the fee (inputs minus outputs) is at most the policy's `sweepFeeCapSats` (`1200 PolicyViolation`, `data.reason: "sweep_fee_exceeds_cap"`, `data.fee`, `data.cap`; the fee cap can be raised with a hardware approval like any other rule).
  * **Why all outputs and all inputs.** A sweep moves everything to the new wallet, so there is nothing to pay anyone else: an output elsewhere, even a small one, would let the rule double as a payment channel for a stolen phone key, and an input that is not the watched wallet's would let one watched coin carry any transaction through. Allowing "all outputs except an amount within the fee cap" would add nothing a sweep needs (a fee is not an output) and would be the leak the rule exists to close. The fee cap bounds what miners can take.
  * The guardian does **not** check signatures: a transaction the node would refuse is `1601 BroadcastRejected` with the node's reason. A transaction that does not parse is `-32602`; one the node refuses (double spend, too low a fee, bad signature) is `1601 BroadcastRejected` with the node's reason in `message` and `data.reason`. The result is the txid the guardian computed.
  * **A sweep of the phone's single-key coins** (rule c, see "Silent payments") is checked the same way: at most 500 inputs and 10 outputs; **every input** spends a silent payment the guardian's scanner found, a coin the phone registered (`singlekey.register`, and the previous output must pay exactly the registered script), or a coin of the registered helper account (scanned range) (`input_not_single_key`); **every output** pays an address of the paired wallet (`output_not_to_wallet`); the outputs do not exceed the inputs; and the fee is at most `sweepFeeCapSats` (`1200`, `sweep_fee_exceeds_cap`). It applies as soon as one input is such a coin, so a transaction that spends a match but pays anyone else is refused, not relayed under another rule.
* **`fees.estimate`** asks the node (`blockchain.estimatefee`) per target and converts BTC/kvB to sat/vB; `satPerVb` is `null` where the node has no estimate (usual on regtest and signet, and right after a restart). `minRelaySatPerVb` is the node's relay fee floor. The reference guardian keeps the estimates up to 60 s (until a new block or a change of chain source drops them sooner) and asks for every target at once, so callers in that time are answered from memory; the reference phone asks for them after a sync's `wallet.sync` is answered, not next to it.
* Electrs unreachable or not synced: `1501 Unavailable`; try again later.

**Chain source.** Where the guardian reads the chain is the owner's choice in its web UI (Settings > Server), as in
Sparrow Wallet: a private Electrum server (the box's own Electrs on Umbrel and Start9, the default), Bitcoin Core alone
(through a watch-only descriptor wallet in it), or a public Electrum server (TLS, from a short list or another one).
It is not in the policy and no phone can change it. The phone only sees **`guardian.status.chainSource`**
`{ kind: "own" | "public", backend: "electrum" | "core", host }` (absent from older guardians, which use the box's own
node) and the **`chain_source_changed`** alert (the same members) when the owner switches. A public server sees every
address of the wallet and the box's IP address and could hide coins or delay confirmations from the guardian (it
cannot spend or change a rule); the phone shows that warning while `kind` is `public`. During a recovery the guardian
refuses to switch to a public server.

**Unconfirmed transactions.** Some Electrum servers report no mempool at all: Electrs 0.11 reads none of Bitcoin Core
32's (Core dropped `bip125-replaceable` from mempool entries, Electrs requires it and skips every entry), so every
Umbrel with Electrs and Core 32 or later shows an empty fee histogram and no unconfirmed history while Core holds the
transactions (and Electrs answers every request about 7 s late; `deprecatedrpc=bip125` in Core's configuration, or
Bitcoin Core alone as the chain server, fixes both). The guardian therefore keeps every transaction it relayed for the owner through `tx.broadcast` as known
mempool state: until the server lists it (or Bitcoin Core, when configured, says it is gone, or Core's mempool expiry
passed), `wallet.sync` shows its inputs spent, its outputs to the wallet as unconfirmed coins and the transaction
itself in `history` as unconfirmed, and the live wallet announces it (`wallet_tx`). A relayed transaction not listed by
the server within a minute, or an empty fee histogram while Bitcoin Core's mempool is not, tells the guardian that the
server shows no mempool. With Bitcoin Core's RPC configured (always on Umbrel and Start9) it then reads Core's mempool
itself (`getrawmempool`, the txid list only, and the new transactions' raw hex) and keeps those touching its watched
wallets the same way, so payments to the wallet show unconfirmed too. A hosted guest's transactions are never kept.
`guardian.status.chainSource` carries `mempool: "unseen"` only when payments to the wallet show once confirmed (no
mempool on the server and no Core RPC to read instead). The phone also keeps the coins its own payments spent out of
every payment and balance until they confirm, whatever a sync says.

**Live wallet.** Guardians that list `live_wallet` in `guardian.status.features` keep the paired wallet's chain data
live instead of reading it per `wallet.sync`: on an Electrum server they subscribe (`blockchain.scripthash.subscribe`)
to every script of both chains up to `gapLimit` past the last used one (extending as addresses get used), and of the
watched Savings, replaced and helper wallets; Bitcoin Core's watch-only wallet is read again at every tip poll (5 s).
A `wallet.sync` is then answered from memory (milliseconds instead of one request per address), and so is the
`tx.broadcast` check (which also accepts a replacement of an unconfirmed payment by the coin it spends again, without a
wallet scan). Nothing changes on the wire except the **`wallet_tx`** alert: when a transaction touching the
paired wallet (`wallet: "main"`) or Savings (`"savings"`) first appears, in the mempool or already in a block, and once
more when it first confirms, the paired phone gets `{ txid, direction, amountSats, feeSats?, confirmations, wallet }`,
whichever device made it. `direction` is `in` (received `amountSats`), `out` (paid `amountSats` to others, `feeSats`
when every input was the wallet's) or `self` (a move between the wallet's own addresses: `amountSats` 0, `feeSats` the
fee). A transaction that spends a coin an unconfirmed one seen before also spent is a replacement (RBF, "Speed up"):
its alert carries `replaces` (that one's txid), and the phone shows it in that one's place, not next to it (only one of
the two can confirm; older phones ignore the member). Each transaction is announced at most once per state, also across
restarts (the guardian keeps what it announced, and the coins its unconfirmed spends spent); what the wallet held when
the guardian first saw it is history, not news. The phone shows the transaction
at once and syncs for the coins: the alert is a hint, `wallet.sync` stays the truth. Alert contacts never get it. With a
public Electrum server, the server learns that the subscribed addresses belong together and when the guardian is
online (it sees the same addresses at every scan anyway).

The phone keeps its own "spent today" estimate for showing the remaining limit and choosing the signing path, but the guardian's count is the truth: `guardian.status.dailyLimit`, and `data` of an `over_daily_limit` refusal (`limit`, `used`, `outflow`, `wouldUse`).

### Silent payments

BIP 352 silent payments (DESIGN.md, "Silent payments"). The vault's `wsh(sortedmulti)` inputs cannot make one, so the phone keeps a small single-key **helper coin** (P2WPKH, BIP 84 account `m/84'/coin'/1'` of key 2's seed) that every payment to an `sp1…`/`tsp1…` address spends next to the vault coins; and received payments are single-key P2TR coins the phone sweeps into the vault one per transaction. All of these methods are for the **paired phone only** (anyone else is dropped without an answer) and need no key 3, so they **work while the guardian is locked**.

* **`singlekey.register`** gives the guardian the phone's single-key coins, public data only: `helper` is the helper account's `KeyOrigin` (its path must be `m/84'/coin'/1'`, the xpub that account's key at depth 3); `coins` are single-key coins the phone found itself (received silent payments, by outpoint and script). Each member given replaces what was registered (`coins: []` clears them). Bad data: `-32602` (the engine's `invalid_registration`). The registration belongs to the paired wallet and goes with it (rotation, retirement, reset). Once a helper is registered:
  * **`sign` accepts the helper input.** In a PSBT that pays a taproot output, at most **one** input may be not the vault's: a P2WPKH spend of an address of the registered helper account (index at most 1,000 on either chain), already **finalized** (`finalScriptWitness` = `<signature> <compressed pubkey>`, no scriptSig), whose signature is a valid SIGHASH_ALL signature for that key over this transaction, with a `nonWitnessUtxo` matching its txid. Key 3 signs the vault inputs only. Anything else stays a `foreign_input`, or is `invalid_helper_input` (`data.code`: `helper_not_finalized`, `helper_invalid_witness`, `helper_invalid_signature`, `too_many_helper_inputs`); both are `1400`. Without a registered helper, or without a taproot output, the helper is a `foreign_input` as before.
  * **The daily limit counts what leaves the vault:** `Σ vault inputs − Σ outputs paying vault addresses` (fee included, never below zero). The helper's own value adds nothing, and an output to a helper address is never change: vault money sent there counts in full. The limit's per-outpoint accounting (replays counted once, RBF replacements as the larger outflow) runs over the vault inputs only.
  * **`wallet.sync` with `wallet: "helper"`** scans the helper account like a wallet (gap limit 20): `utxos` (each with its P2WPKH `script`), `history`, `balance`, `nextReceiveIndex`/`nextChangeIndex`. Its `coins` are the other single-key coins that are unspent, by `script`: the registered coins and the scanner's matches. With nothing registered: `1005`. `tx.get` serves their transactions like any other.
* **`sp.register`** hands the guardian the receiver's **scan** private key, `B_spend`, the labels (always including the change label 0) and the wallet's birth height. The scan key finds payments but cannot spend them; the guardian never sees `b_spend` and never derives a spending key. It scans from the birth height to the tip, then each new block, reading blocks with their prevouts from the user's own node (`getblock <hash> 3`; Electrs has no per-block prevouts), so it needs the node's RPC: without `BITCOIN_RPC_HOST`/`_PORT`/`_USER`/`_PASS` every `sp.*` is `1700 NodeRpcRequired`. An invalid scan key or spend key is `-32602`; an unreachable node `1501`. Registering the same keys again updates the labels and birth height (and scans again from the birth height when labels were added or it moved back); other keys replace the registration and its matches. The answer comes at once; scanning runs behind (`scannedHeight` is `birthHeight − 1` before the first block). The guardian keeps the scan key encrypted under its own key file, not under the unlock passphrase, so it **keeps scanning while locked** (after every restart).
* **Reorgs.** The guardian keeps the hashes of the last 100 blocks it scanned and, on every run, re-checks the newest against the node; when it changed, it walks back to the last block both agree on and scans again from there. Matches from blocks no longer on the main chain are dropped; a payment a reorg moved is found again at its new height.
* **`sp.scan`** returns what was found: `tipHeight` (the last block scanned), `matches` with `height >= fromHeight − 6` (the answer repeats the 6 blocks below `fromHeight`, so a phone that resumes from `tipHeight + 1` still sees a payment a reorg moved into a block it already scanned; it de-duplicates by outpoint), oldest first, at most 500 (`matchesTruncated`). Each match: `txid`, `vout`, `valueSats`, `outputKey` (x-only), `tweak` (the coin's private key is `b_spend + tweak`), `label?` (absent for the unlabelled address; 0 is the change label), `height`. The guardian waits up to 5 s for a scan in progress; `scanning: true` says it is still catching up. Not registered: `1701`. **The phone checks every match** (the tweak must give the output key, the label must be one of its own) before keeping it.
* **`sp_received`** (alert) announces each payment found in a block after the registration (not the historical ones the first scan finds), once per outpoint, also across reorgs.
* **`sp.unregister`** stops scanning and forgets the scan key and every match (`unregistered: false` when nothing was registered). Pairing another phone (retire, reset, a rotation to another phone) drops the registration too.
* **Sweeps** of found coins go through `tx.broadcast` (rule c in "Chain data"), with the rate limit of every `tx.broadcast`.

### Savings

The phone's optional Savings wallet (DESIGN.md, "Savings"; docs/design/savings-and-limit-off.md, option K):
`wsh(sortedmulti(2, phone, hardware, recoveryKey))` with every key at BIP 48 account 1', the Recovery Key a second
hardware wallet. The guardian holds **no Savings key**: it never co-signs for Savings, and none of the policy applies to
it. It only watches it. Only guardians that list `savings` in `guardian.status.features` (`GUARDIAN_FEATURES.savings`)
know these methods, and only to them does a phone send them (an older one answers `-32601`, and refuses `wallet:
"savings"`, its schema being strict). All are **paired phone only** and need no key 3, so they work while locked.

* **`savings.register`** `{ descriptor }`: watch this Savings wallet. Watch-only, so no approval: it adds chain data and
  alerts, changes no rule, and nothing the daily limit counts (a payment into Savings counts like any payment). Refused
  (`-32602`, the engine's `invalid_registration`) when the descriptor is not a `wsh(sortedmulti(2,...))` of three distinct
  keys on the guardian's network, or is a wallet the guardian can sign for: the paired, the watched (replaced) or a
  retired key set, or any wallet holding the guardian's key 3. The same wallet again changes nothing (`since` is kept);
  another replaces it (a Savings key was replaced). Answers `walletId` (`MultisigWallet.fingerprint()`) and `since` (unix
  seconds).
* **`savings.unregister`** `{}`: stop watching (`unregistered: false` when nothing was watched).
* **Turning the watch off or swapping it is announced.** Both need only the paired phone, so someone holding the phone
  could otherwise blind the tripwire before moving Savings with a second key. A real `savings.unregister`, and a
  `savings.register` that replaces a different watched wallet, raise `savings_unwatched` (`walletId`: the wallet no
  longer watched; `replacedBy`: the one watched instead) to the paired phone and a NIP-17 DM to every alert contact,
  durable and retried for 7 days like `savings_moved`. Registering the same wallet again changes nothing and says
  nothing.
* **`savings.get`** `{}`: `savings: { walletId, descriptor, since }` or `null`. How a new phone without a backup finds
  Savings again: the record belongs to the active wallet and **moves with it when the guardian adopts a recovery's
  destination** (retirement and reset drop it). The phone checks the descriptor against its hardware wallet before
  anything is signed.
* **`wallet.sync`** with `wallet: "savings"` (or the Savings wallet's id) scans it like a wallet, from its own high-water
  marks; none registered: `1005`. `tx.get` serves its transactions like any other.
* **`tx.broadcast`** relays a transaction that spends at least one Savings coin (rule d in "Chain data"), with the rate
  limit of every `tx.broadcast`. The guardian does not check who signed it.
* **The tripwire.** The guardian scans Savings on every new block and every two minutes (and on each `wallet.sync` of
  it). The first scan after registration is history; every later transaction that took value out of Savings (in the
  mempool or a block) is logged and announced once: `savings_moved` to the paired phone, and a NIP-17 DM to every alert
  contact, retried for 7 days like `limit_off`. It cannot tell who signed it (the owner, or two keys in other hands); a
  compromised guardian could stay silent, which costs nothing it was trusted with. **One outflow, one alert:** a spend of
  a Savings coin that an earlier spend also spent is a replacement (RBF). If it pays out the same as the one it replaces
  (the same outputs to everyone but Savings: a fee bump, only the change is smaller) it is logged and not announced;
  otherwise it is announced as a `savings_moved` with `replaces` (the txid it replaced) and `previousAmountSats`.

### Extra alert channels

Guardians that list `notifications` in `guardian.status.features` can also send their alerts by **email** (through the
owner's own email account, SMTP), **ntfy**, a **webhook** and **Telegram** (through a bot the owner makes)
(docs/design/notifications.md). They are notify-only: the
same warnings as the nostr alerts, never a control; `CANCEL` and `LOCK` stay NIP-17 DMs. Nothing about them is on the
wire between phone and guardian except:

* **`guardian.status.notifications`** `{ channels: [{ kind, audience, contact?, hint, failing? }] }`: what the owner set
  up, read-only and **masked** (`hint` is `j…@example.com` or the server's host name, never an ntfy topic, a webhook URL
  or a whole address: anyone who knows a topic on a public ntfy server can read it and post fake alerts to it).
  `audience: "contact"` with `contact` (an alert contact's pubkey) is that contact's extra channel; without `contact`, a
  contact reachable only by that channel. Absent while there are none, and from older guardians.
  **`otherChannels`** (optional, same members, `kind` any `[a-z0-9_]{1,16}`) holds the channels of kinds added after
  `channels` was defined: `telegram` (a chat the guardian's Telegram bot writes to; `hint` is the first letter of the
  chat's name). They are kept apart because a phone validates `channels[].kind` against the first three kinds and would
  refuse the whole status otherwise; older phones ignore `otherChannels`. A phone may skip a kind it does not know.
* **`notifications_changed`** (alert, no extra members): the channels, the email account or the Telegram bot were changed in the web UI.

**They are not in the policy.** Channels are the owner's delivery settings in the guardian, changed only in its web UI
(a signed-in session with the unlock passphrase, on an unlocked guardian), never by any phone, so a stolen phone can
neither remove nor redirect them; every change is announced on every channel before and after it (over the email
account and the Telegram bot as they were before) and to the paired phone, and while a recovery runs only additions are
accepted (and a new app password for the same email account, or a new token for the same bot). The policy,
its hash and every approval text are unchanged, and the contacts who can cancel and lock are still exactly
`Policy.alertContacts` (rule 4 unchanged, including the mainnet minimum of one).

### Family hosting

A guardian that lists `family_hosting` (`GUARDIAN_FEATURES.familyHosting`) holds key 3 for guests' wallets, each in its own
slot next to its owner's wallet (docs/design/family-hosting.md). It knows a guest wallet only by its three account
pubkeys (BIP 89 delegation): never a chaincode, descriptor, address or balance. Its owner's wallet, file, methods and
answers are exactly as without guests (the owner's `guardian.status` does not list `family_hosting`).

**Invites.** The owner makes one in the web UI: `trikey://invite?v=1&npub=<npub>&relay=<url>...&secret=<32 bytes,
base64url>&exp=<unix>&net=<network>[&label=<text>]`, the pairing URI's rules (at most 24 hours) plus the network and a
full 32-byte secret. The guardian keeps only the secret's SHA-256; the invite survives restarts, is single use and binds
to the first phone that shows it (`hosted.prepare`); five refused attempts burn it. Strangers' `hosted.prepare` /
`hosted.pair` are answered while an invite is pending, and for 10 minutes after one was used or ran out.

**Accepting.** `hosted.prepare` derives the slot's key 3 (`trikey/key3-hosted/v1`: HMAC-SHA512 of the owner's seed over
the tag, the length-prefixed network, slot id and guest phone key, and `u32be(32) || entropy`; the phone's `entropy` is
required, so a guest never gets the guardian's own key) and answers its account pubkey only. The phone picks key 3's
chaincode and builds `wsh(sortedmulti(2, key2, key1, [fp]xpub3))` with key 3 as a depth-0 xpub, has the hardware wallet
register it and sign the pairing proof `pairingMessage(walletId, cosignerAccountPubkey)` over the **key-set id**
(`walletId` = the first 16 hex chars of `sha256("trikey/keyset/v1" || app || hardware || cosigner)`, compressed account
pubkeys in role order), and sends `hosted.pair`. The guardian checks what `pair` checks, plus the authorization key as
`pubkey == hardware + tweak·G` at `m/48'/<coin>'/0'/2'/0/0`, the guest's `rulesApproval` over the key-set id (guardians
whose `hosted.prepare.features` list `pairing_rules_approval`; refused without it, as `pair`), refuses "limit off" (as `pair`
does: the guest turns it off afterwards with the hardware wallet), stores the encrypted **wallet map** write-once and
burns the invite. `contactLock`
is accepted from a guardian that lists `contact_lock` in `hosted.prepare.features`.

**Routing.** A guest's phone (and a phone with recovery access to a guest wallet) reaches only its own slot: `sign`,
`policy.get`, `policy.update`, `recovery.*`, `phone.resume`, `hardware.confirm`, `wallet.retire`, `guardian.lock` (the
phone only: a pause, below), `guardian.status` (the slot's view: its key-set id, `features: ["family_hosting",
"limit_off", "contact_lock", "short_wraps"]`, `hosting: { state, endsAt?, paused? }`, `chainSource` as below, never the
owner's wallet, Savings, extra alert channels or which contact locked the box), `fees.estimate`, `tx.broadcast` (only transactions this slot
co-signed), `relays.ack`, `hosted.coins`, `hosted.map.get`, `hosted.access`; anything else answers `1001` with
`data.reason: "not_for_hosted_wallets"`. A guest wallet's recovery ids are `<slotId>g<n>-<txid12>`: `recovery.cancel` and
`CANCEL <id>` DMs with such an id reach that slot only, from its phone or one of its alert contacts.

**Co-signing.** As for the owner's wallet, but change is an output whose three tweaks rebuild its script from the
account pubkeys (no index window: it cannot be checked without learning addresses). Every such output is recorded in the
slot's ledger (`hosted.coins`; at most 2,000, then `sign` answers `1200` with `reason: "ledger_full"`). PSBTs sent to the
guardian need no BIP 32 derivations (the phone strips them). `sign` is limited to 60 requests per hour per slot.

**Recovery.** `recovery.start` takes `{ sweepPsbt, destinationKeys: { app, hardware, cosigner }, destinationMap,
abandon? }` for a guest wallet (the descriptor form is refused there, and the hosted form for the owner's wallet). Every
output must be tweak-proven to the destination; `abandon` names ledger coins the sweep leaves behind on purpose (coins the
hardware wallet cannot sign); the alerts say how many and how much. Before completing, the guardian checks with its own
chain source, by the coins' own outpoints and scripts, that the sweep's inputs are unspent and every unspent ledger
coin is swept or abandoned (an Electrum server is asked per script; Bitcoin Core per outpoint with `gettxout`, so its
watch-only wallet never imports anything of a guest). Coins received from outside are the guest phone's to find (its own chain source, cross-checked with a second
server). A new phone without the old one or a backup uses `hosted.access` (version-2 text only), decrypts the map with
the hardware wallet's chaincode and checks it against `accountPubkeys`. After an adoption without the old hardware
wallet, `hardware.confirm` carries `hardwareAuth.tweak`.

**Limit off and pausing (phase 2).** A guest turns the daily limit off and on exactly as the owner does ("No daily
limit": `policy.update` with the version-2 text over the key-set id; `limit_off` / `limit_on` alerts to the guest's phone
and DMs to its contacts; a recovery's adopted wallet starts with the limit back on). The contact lock works per slot: with
the guest's `contactLock` on, a `LOCK` DM from one of that wallet's alert contacts **pauses** that wallet only, never the
owner's box: its slot co-signs no payment (`sign` answers `1207` with `data: { reason: "wallet_paused", by, at }`) while
the box, the owner's wallet and other guests carry on. The guest's phone gets `wallet_paused` (`walletId`, `by:
"contact"`, `contact`), the wallet's other contacts a DM, the contact an answer naming the wallet by its label; the owner's
contacts and channels hear nothing. While the guest's setting is off, a `LOCK` is silent and remembered, as for the owner.
A guest's `guardian.lock` pauses its own wallet the same way (`{ state: "locked" }`, nobody else told); `guardian.unlock`
stays the owner's (`1001`). `guardian.status.hosting.paused` (`{ by: "contact" | "phone", at, contact? }`) says so while
it lasts. Only the guest's hardware wallet resumes a paused wallet: `phone.resume` with the `resume-phone` approval (the
same call that lifts a contested cancel's pause). A pause is durable (a restart of the box does not lift it), does not
stop a recovery's delay, alerts or completion, and carries over to a recovery's adopted wallet. A `LOCK` from one of the
owner's contacts still locks the whole box, guests included; a contact of both does both, and the answer says both.

**Leaving.** A guest leaves with `wallet.retire` (a `retire-wallet` approval), which retires the wallet in its slot and
deletes the slot's key 3 record. It is refused (`1200`, `data: { reason: "ledger_unspent", coins, sats }`) while a coin
key 3 co-signed is still unspent on the guardian's chain source (looked up by the coins' own outpoints and scripts, as the
recovery's coin check does; nothing imported into Bitcoin Core), since some of them may need key 3 to move; the phone checks the rest (an empty wallet on two servers) before it asks.

**No live wallet for guests.** The guardian never subscribes to a guest wallet's scripts, never imports anything of
it into Bitcoin Core, and sends its phone no `wallet_tx` (a guest's `features` do not list `live_wallet`): it knows no
address of the wallet, and must not learn one. The guest's phone reads its wallet from its own chain server. The
owner's live wallet, its `wallet_tx` alerts and the "Payments" notifications on the owner's channels are about the
owner's own wallets only.

**The owner's chain source.** It is what the guardian checks a guest recovery's coins against and broadcasts a guest's
transactions through (the guest's phone reads its wallet from its own chain server). A guest's `guardian.status.chainSource`
and the `chain_source_changed` alert its phone and recovery peers get when the owner switches carry `kind`, `backend` and,
for a public server, its `host`; for the owner's own node `host` is `"own"` (its address on the owner's network is not
the guest's to know). The guest's alert is sent over nostr only, never on the owner's extra alert channels, and its
`message` is written for the guest. Switching to a public server is refused while a guest wallet's recovery runs, as
while the owner's does.

**Stopping.** The owner's "Stop hosting" sends `hosting_ending` (`walletId`, `endsAt`) to the guest's phone and DMs to
its contacts; at `endsAt` (or at once, behind a typed confirmation) the slot ends: `wallet_retired` with reason
`hosting_ended`, and the slot's key 3 record is deleted. Refused while that wallet's recovery runs. The owner's reset is
refused while any guest wallet is hosted.

### Own wallets

A guardian that lists `own_wallets` (`GUARDIAN_FEATURES.ownWallets`) guards up to 8 wallets of its owner, apart from the
hosted ones (docs/design/multi-wallet.md). They share the paired phone (one seed, one nostr identity) and the key 3 seed
of the first pairing (the setup seed, or `seed3` of "Key 3 from both sides"); only the hardware wallet differs. Each
wallet sits at its own hardened **BIP 48 account** of both seeds: the first wallet at `0'` (its Savings at `1'`), the
wallet added n-th at `(2n)'` (its Savings, later, at `(2n+1)'`): `m/48'/<coin>'/<2n>'/2'` for the phone's key and for key
3. The hardware wallet keeps its own `0'`. So the wallets' phone keys and key 3s are unrelated keys and nothing on chain
links two wallets; off chain, their descriptors carry the same phone and key 3 master fingerprints.

**Adding a wallet.** From the first wallet's paired phone, while the guardian is unlocked: `wallet.add.prepare { account }`
answers key 3 at that account (an even account from 2 up that no wallet ever used: an account is never used twice, also
after a wallet is retired; refused with `-32602`, `data.reason: "account_unavailable"`, `data.nextAccount`). The phone
builds `wsh(sortedmulti(2, key2@account, key1@0', key3@account))`, registers it on the new hardware wallet, shows its first
address there, and has the device sign the pairing proof `pairingMessage(walletId, cosignerAccountPubkey)` and (guardians
with `pairing_rules_approval`) the new wallet's rules, `rulesApproval`. `wallet.add` checks what `pair` checks (three
distinct keys, key 3 in its slot, the authorization key below the hardware xpub, the proof, the rules: an alert contact on
mainnet, no limit off, approved by the new device), and that the phone's key is the paired seed's (the first
wallet's phone fingerprint) at `account`, and that no key of the new device is in another wallet of the box (the first
wallet's hardware wallet, its Savings keys, another own wallet's device: `data.reason: "hardware_in_use"`). It answers the
new wallet's id and announces it: `wallet_added` to the phone, the owner's channels, the web UI's Activity.

**Routing.** A request naming a wallet (`walletId`) reaches that wallet's engine (its own key 3, rules, daily limit window,
alert contacts, Delay & Notify, recoveries, hardware sequence) and nothing else; only its paired phone, a phone with
recovery access to it (the recovery methods) or its alert contacts (`recovery.cancel`) may. An id the guardian does not
guard is refused (`-32602`, `data.reason: "unknown_wallet"`), never applied to the first wallet. Without `walletId` the
request is the first wallet's, exactly as before, except `recovery.cancel` naming an own wallet's recovery, and a sender
that is only one own wallet's phone or recovery peer (after a recovery moved that wallet to a new phone): that wallet's.
An own wallet's recovery ids are `<slotId>w<n>-<txid12>` (they fit `RecoveryId` and `CANCEL <id>`). `recovery.access` is
tried against the first wallet's hardware authorization key, then each own wallet's. Silent payments (`sp.*`),
`singlekey.register` and `wallet.unwatch` stay the first wallet's for now: they take no `walletId`. Savings takes it from
guardians with `own_wallets_2` (below). The first wallet is retired last (`wallet.retire`: `1200`, `data.reason:
"own_wallets_active"`).

**Phase 2 (`own_wallets_2`).** A guardian that also lists `own_wallets_2` (`GUARDIAN_FEATURES.ownWallets2`):

- **Savings per wallet.** `savings.register`, `savings.unregister` and `savings.get` take `walletId`: that wallet's
  Savings, watched in that wallet's runtime (its tripwire, `savings_moved` and `savings_unwatched` to the paired phone and
  that wallet's alert contacts, `wallet.sync` with `wallet: "savings"` and `walletId`, its spends relayed by `tx.broadcast`).
  An own wallet's Savings must hold the paired phone seed's key at the wallet's odd account
  `m/48'/<coin>'/<account + 1>'/2'`, and none of its devices may be in another wallet of the box (`-32602`,
  `data.reason: "hardware_in_use"`): the same hardware wallet is never in two wallets, also as a Savings Recovery Key.
  Savings alerts keep naming the Savings wallet in `walletId`, as before; the phone knows which wallet holds it.
- **The hardware wallet's kind.** `wallet.add` takes `hardwareKind` (`ledger`, `trezor`, ...): kept, and listed in
  `guardian.status.wallets`, so a phone rebuilding the wallet connects the right device. Older entries have none.
- **Moving every wallet ("Replace guardian").** `wallet.add` takes `replacesWalletId` and `replacesDescriptor`, as
  `pair` does: the new guardian watches the replaced wallet of the old guardian, serves its coins (`wallet.sync` with
  `wallet: "replaced"` and the new `walletId`) and relays a sweep of it into the new wallet (`tx.broadcast`). The phone
  pairs the first wallet with `pair`, then adds every other wallet at its own account, each swept with its own device.
- **Removing a wallet.** An own wallet's `wallet.retire` is refused while the guardian's view of it holds coins (`1200`,
  `data.reason: "wallet_not_empty"`, `data.coins`, `data.sats`), as a hosted wallet's leaving is refused while a coin key 3
  co-signed is unspent. Once empty, it retires with the hardware approval, as before; the phone, the owner's channels
  and the web UI's Activity are told, and its account stays taken.

**Box-wide.** One passphrase unlocks every wallet's key 3, `guardian.lock` locks them all; a contact's `LOCK` locks the
box when a wallet that lists the contact lets its contacts lock it. `guardian.unlock` from the phone is refused while a
recovery of **any** wallet runs that the phone did not start. A reset forgets every wallet (refused while any wallet's
recovery runs or a sweep waits). `guardian.status` without `walletId` lists every wallet once there is more than one
(`wallets: [{ walletId, account, name?, hardwareKind?, descriptor, hardwareAuth?, state? }]`), so a phone restored from a backup older
than its last wallet rebuilds it (after checking the descriptor holds its own key at `account`). With `walletId` it is
that wallet's view.

**Alerts.** Alerts about a wallet after the first carry its `walletId` (alerts that already name a wallet keep their
member), and once the box has more than one wallet every text names the wallet (`"Business: ..."`), on the phone, in the
contacts' DMs and on the owner's channels. The live wallet (`wallet_tx`) covers every own wallet.

**Older guardians and phones.** Params are strict, so a guardian before own wallets refuses a request carrying `walletId`
(`-32602`) and answers `-32601` to `wallet.add.*`: it never acts on the first wallet in another's place. A phone sends
them only to a guardian that lists `own_wallets`. A phone before own wallets sends no `walletId`: the first wallet, as
always. Alerts' `walletId` is an optional member such phones drop.

### Recovery access

"Lost phone, no backup": the user has a new phone, the hardware wallet and the guardian. The new phone has a fresh nostr key that the guardian does not know, and it knows neither the descriptor nor the guardian's key, only the guardian's `npub` and relays (the web UI's "Recover on a new phone" code, section 6). `recovery.access` lets the hardware wallet vouch for it:

1. The phone asks the device for the authorization key (the same path the wallet used at pairing; it is derived the same way on every phone, see the guardian README) and has it BIP 137-sign `recoveryAccessMessage({ guardianPubkey, phonePubkey, expiresAt, walletId? })`, with `expiresAt` at most 24 h ahead. With `walletId` (the recovery code carries it since the 2026-10 security review; a phone renewing its access knows it) the text is version 2 and binds the wallet too; without it, version 1.
2. **`recovery.access`** from any sender, once a wallet is paired. The guardian rebuilds the text with *its own* nostr key and the *sender's* key, so the signature is no use to another phone or against another guardian, and verifies it against the paired `hardwareAuth`. Wrong signature `1202`, expired `1203`, too far ahead `1206`. It does not consume a hardware sequence number. Both versions are accepted; a version-1 signature whose grant a wallet rotation or retirement revoked is refused until it expires (`1202`, `data.reason: "approval_revoked"`), whatever its encoding, so the next wallet does not honour it. BIP 137 signatures with a high S are refused (signers only make low-S ones).
3. The sender may then, until `accessExpiresAt` (durably, across guardian restarts), call `guardian.status`, `wallet.sync`, `tx.get`, `fees.estimate`, `recovery.start`, `recovery.status`, `recovery.cancel` (only with a hardware approval), `recovery.access` again, and (guardians with `labels_backup`) `labels.get` and `labels.list`, to bring the wallet's encrypted notes back ("Encrypted notes"). Not `sign`, `policy.*`, `tx.broadcast`, `phone.resume`, `guardian.unlock` or `unlock.hardware.*`. The result gives the phone everything it needs to sweep: the descriptor, the wallet id, the guardian's key and the rules (for the sweep fee cap).

Anyone holding the hardware wallet can thus start a recovery from any phone, which is the design: a recovery is announced to the paired phone and every alert contact, and any of them can cancel it (DESIGN.md, threat model). The web UI's activity log shows every access grant. While its access lasts, a phone with recovery access also gets the protocol alerts (best effort; it is not one of the recovery's recorded recipients), and it can poll `recovery.status`.

### Encrypted notes

Guardians that list **`labels_backup`** (`GUARDIAN_FEATURES.labelsBackup`) keep, for each of the owner's wallets, an encrypted copy of the phone's labels (coin labels and freezes, payment notes, address labels: `packages/wallet/src/labels-store.ts`), so a recovery to a new phone without a backup brings them back too (DESIGN.md, "Notes that survive recovery"). Off by default; the phone offers it only to such a guardian, and never for a wallet hosted on someone else's guardian (a guest's `labels.*` gets `1001`, "A hosted wallet cannot use labels.put on this guardian", and guests are never told the feature).

**The key never reaches the guardian.** The phone has the wallet's hardware wallet BIP 137-sign, with its authorization key (`hardwareAuth`, the key it signs approvals with), the one-line text

```
Trikey labels key v1 wallet=<walletId> network=<network>
```

(printable ASCII only: Trikey's Ledger and Trezor signers sign nothing else) and derives `okm = HKDF-SHA256(ikm = r || s, salt = walletId, info = "trikey/labels/v1", 64)` from the signature's `r` and low-form `s` (not its header byte); the first 32 bytes encrypt, the last 32 make the key check. The signature is deterministic on the supported devices (RFC 6979), so the same device makes the same key on any phone; the phone checks it when the owner turns the option on (two signatures of the text must be equal, else `hardware_not_deterministic` and the option stays off). The signature and the key stay on the phone; the guardian, which knows every xpub, could not derive the key from anything public.

**The blob** (what `labels.put` carries; the guardian checks only its size and hash):

```
0x01 || nonce (24) || check (16) || XChaCha20-Poly1305(key, nonce, padded, aad) (ciphertext and tag)
check  = HMAC-SHA256(check key, "trikey/labels/check/v1")[0..16)   -- a wrong key is told apart before decrypting
aad    = the 41 header bytes || utf8(JSON ["trikey-labels", 1, walletId])
padded = u32be(n) || plaintext (n bytes) || zeros, to the smallest of 4, 8, 16 ... 512 KiB that holds it
plaintext = JSON { version: 1, walletId, network, at (ms), labels: <labels document, version 1> }
```

The labels document carries the wallet's own labels, its Savings' (now and before), those of wallets it replaced, and those brought back from an earlier copy, so a second recovery keeps them too.

**Transfer in parts.** A gift wrap carries at most about 40 kB (NIP-44 encrypts at most 65,535 bytes, and the rumor is encrypted twice), so a blob (at most `MAX_LABELS_BYTES`, 525,312) travels in parts of `LABELS_PART_BYTES` (24 KiB; at most 22). `labels.put`: the parts of one `upload` in any order, each naming the whole blob's `bytes` and `sha256`; the guardian holds them in memory and stores a version when the last one arrives and the whole matches (`-32602` with `data.reason` `labels_upload_mismatch` or `labels_hash_mismatch` otherwise). A new upload drops one that never finished; one idle for 10 minutes, or interrupted by a restart, is dropped too (the phone sends it again). `labels.get` returns one part of one version.

**What the guardian keeps.** `labels/<walletId>.json` under its data directory: the newest **three** versions, each with when it was stored, its size and its hash. A version stored within 10 minutes of the newest replaces it, so a burst of edits makes one version. At most 30 uploads per wallet per hour (`1500` with `data.retryAfterSeconds`). `labels.put` is refused unless `walletId` is the wallet's current id (`labels_wallet_changed`), so a phone that has not yet followed a recovery never stores notes where they could not be opened. Uploads, reads and deletes work while the guardian is locked (only ciphertext is involved).

**Who.** `labels.put` and `labels.delete`: the wallet's paired phone. `labels.get` and `labels.list`: the paired phone, and a phone with recovery access to the wallet ("Recovery access"). A wallet may read the copies of its **line**: its own, and those of the wallets a recovery swept into it, back to the first (a retired wallet whose `successorWalletId` is the next); `of` outside it is `-32602` (`labels_not_this_wallet`). So the new phone of a "lost phone, no backup" recovery reads the old wallet's copy while the recovery waits and after the guardian adopted its new wallet. Strangers get no answer.

**When copies go.** `labels.delete` (the phone turned the option off) deletes the copies of the whole line. Retiring a wallet (`wallet.retire`) deletes its copies; a recovery to another guardian's wallet deletes the swept wallet's; a reset deletes every copy.

**Not announced.** No alert to the phone and nothing on the alert channels (uploads are frequent and harmless); the web UI's Activity shows "Encrypted notes updated" at most once a day per wallet, and "Encrypted notes deleted".

**Older guardians and phones.** A guardian without the feature answers `-32601` to `labels.*`; the phone does not offer the option. An older phone never calls them; the copy then simply stops being updated.

### Unlocking with the hardware wallet

Guardians that list **`hardware_unlock`** (`GUARDIAN_FEATURES.hardwareUnlock`) let each of the owner's wallets turn on unlocking the guardian with **that wallet's hardware wallet**, through the phone, next to the passphrase (DESIGN.md, "Unlocking the guardian with the hardware wallet"). Off by default; the passphrase always stays and cannot be removed. Never for a wallet hosted on someone else's guardian: a guest's `unlock.hardware.*` and `guardian.unlock` get `1001` and guests are never told the feature, so a guest's hardware wallet never unlocks the host's box.

**The text.** The hardware wallet BIP 137-signs, with the wallet's authorization key (`hardwareAuth`, the key it signs approvals with), the one line `unlockKeyMessage` builds:

```
Trikey unlock key v1 wallet=<walletId> guardian=<the guardian's nostr pubkey, hex> network=<network> slot=<slot>
```

`slot` is 8 random bytes in hex the phone picks each time the option is turned on. The supported devices sign deterministically (RFC 6979), so the device signs the same text the same way at every unlock; the phone checks that when the option is turned on (two signatures of the text must be equal, else `hardware_not_deterministic` and nothing is sent). Never an approval: no sequence, no expiry, and its prefix is no approval's.

**`unlock.hardware.add`** (the wallet's paired phone; the guardian unlocked, else `1100`; after a wallet rotation only once `hardware.confirm` was done, else `1209`): the guardian rebuilds the text from its own data (its nostr key, its network, the wallet named, the `slot` sent; it never takes text from the phone) and checks the signature against the wallet's authorization key (`1202` with `data.reason` `unlock_signature_invalid` otherwise), so a phone alone cannot make a slot. It then derives

```
okm   = HKDF-SHA256(ikm = r || s of the signature (low s), salt = 32 random bytes kept with the slot, info = "trikey/guardian-unlock/v1", 64)
check = HMAC-SHA256(okm[32..64), "trikey/guardian-unlock/check/v1")[0..16)
slot  = XChaCha20-Poly1305(okm[0..32), nonce, aad).encrypt(the guardian's 64-byte setup seed)
aad   = utf8(JSON ["trikey-unlock-slot", 1, key 3's account pubkey, the keystore's createdAt, walletId, slot, "hardware", addedAt, salt, check])
```

stores the slot (replacing the wallet's earlier one) in `unlock-slots.json` beside its keystore (which it never changes), and forgets the signature and `okm`. `guardian.status.hardwareUnlock` then names the slot, for that wallet, locked or unlocked.

**`guardian.unlock` with `kind: "hardware"`** (the paired phone of any of the owner's wallets): `walletId` and `slot` name the slot, `signature` is the device's signature of its text. The guardian checks the signature against that wallet's authorization key, derives `okm` again, compares the check, decrypts the seed and checks it against the keystore's public key, exactly as a passphrase opens it. The phone's throttle and refusals are the passphrase's: a signature that does not open the slot is `1101` (`hardware_unlock_failed`) and counts as a wrong passphrase; 5 failures in a row of either kind stop the phone until the web UI unlocks (`phone_unlock_disabled`); a recovery the phone did not start refuses it (`recovery_pending`). No slot for that wallet, or another slot id (turned off, or on again since): `1101` (`hardware_unlock_off`), not counted. The phone does not keep the signature (it is never part of a pending request record): every unlock asks the device.

**`unlock.hardware.remove`** deletes the wallet's slot (the phone turned the option off). The guardian also deletes a wallet's slot when the wallet stops being one it guards: `wallet.retire`, a recovery's rotation (the adopted wallet turns it on again with its own hardware wallet, after `hardware.confirm`), a recovery to another guardian; a reset deletes every slot with key 3. A slots file bound to another keystore is dropped at start.

**Activity, not alerts.** The web UI's Activity shows "Hardware unlock turned on", "Hardware unlock turned off" and "Unlocked with the hardware wallet" (and failed attempts), never the signature. No alert to the phone or on the alert channels.

**Older guardians and phones.** A guardian without the feature answers `-32601` to `unlock.hardware.*` and refuses `guardian.unlock` with `kind: "hardware"` (`-32602`: its schema reserved another shape for it, `{kind, secret}`, which no phone ever sent; this version drops that shape); the phone does not offer the option. An older phone never sends them; the passphrase works as before. The keystore is unchanged, so an older guardian on the same data directory ignores `unlock-slots.json` and unlocks with the passphrase.

### Sealed unlock

Guardians that list **`sealed_unlock`** (`GUARDIAN_FEATURES.sealedUnlock`) take the secrets that open key 3's seed sealed to a key that lives only in the guardian's memory (DESIGN.md, threat model, "The guardian's disk plus archived gift wraps"): the passphrase or the hardware wallet's slot signature in `guardian.unlock`, and the slot signature in `unlock.hardware.add`. Why: the guardian's nostr key is on its disk in the clear (a locked guardian must still receive requests), and every request travels in a gift wrap to that key, so a thief who later holds the disk *and* an archive of old wraps (a relay that kept them past their expiry) could otherwise open a past request and read the passphrase or the signature, and with either key 3's seed.

**The sealing key.** The guardian holds one secp256k1 key pair at a time, in memory only, never on disk and never in a log. It makes a new one when it starts (it starts locked), at every lock (the web UI's Lock, `guardian.lock`, an alert contact's `LOCK`), at every unlock (the one it was locked with is zeroed then, so the seal that unlocked it can never be opened again), after every counted failed unlock from the phone, and after every `unlock.hardware.add` that opened a seal with it; it zeroes it when it stops. `guardian.status` carries its public half, x-only hex as nostr keys are: `unlockKey: { pubkey }`, locked or unlocked (once set up). Never to a guest (guests are not told the feature).

**The seal** (`sealUnlock` / `openSealedUnlock`, `packages/protocol/src/sealed-unlock.ts`). The phone makes a one-time secp256k1 key for this seal only and encrypts, with **NIP-44 v2** (the transport's own primitive, with a random nonce) from that key to `unlockKey.pubkey`, the JSON

```
{ "t": "trikey/sealed-unlock/v1", "for": "guardian.unlock" | "unlock.hardware.add",
  "guardian": <the guardian's nostr pubkey>, "key": <unlockKey.pubkey>,
  "phone": <the phone's nostr pubkey>, "id": <this request's id>, "exp": <unix seconds>,
  "unlock": {"kind":"passphrase", passphrase} | {"kind":"hardware", walletId, slot, signature} }
```

as `sealed: { v: 1, key: <unlockKey.pubkey>, from: <the one-time pubkey>, payload: <NIP-44 payload> }` (`payload` at most 16,384 characters), and sends

* `guardian.unlock { kind: "sealed", sealed }` (`for: "guardian.unlock"`, while locked), or
* `unlock.hardware.add { walletId, slot, sealed }` (`for: "unlock.hardware.add"`, while unlocked; `unlock` is `{kind: "hardware", walletId, slot, signature}` with this request's `walletId` and `slot`), in place of `signature`.

It zeroes the one-time key at once, so the phone cannot open the seal again either. NIP-44 takes no associated data, so everything bound travels inside the encrypted, MACed plaintext and the guardian compares it before it looks at the secret. `for` keeps an add's seal from being taken for an unlock and the reverse. `exp` is the phone's clock plus 300 s; the guardian refuses one more than an hour (plus the 120 s clock skew) ahead. NIP-44 pads the plaintext, so a passphrase's length shows only roughly.

**`guardian.unlock`, sealed.** Already unlocked: `{ unlocked: true }`, nothing opened. Otherwise:

* `key` is not the sealing key it holds (it restarted, locked, unlocked, or replaced the key after a use): `1101` with `data.reason` **`unlock_key_stale`**, nothing decrypted, **not counted**. Also for a seal that opens but whose `exp` has passed (its secret is not tried).
* The seal does not open with the key (damaged, tampered), is not a sealed unlock, or names another `for`, `guardian`, `key`, `phone` (the request's verified sender) or `id`: `1101` with `data.reason` **`sealed_unlock_invalid`**, **counted** as a wrong passphrase. Only the paired phone's own wraps reach this method (everyone else is dropped unanswered, section 4) and a relay cannot forge the phone's seal or make an old request run again (replay guard, `1501` after a restart), so nobody else can spend the owner's tries this way; the phone itself could already, with wrong passphrases.
* Otherwise the secret inside is tried exactly as the plaintext variant of its kind: the same phone throttle (5 failures in a row of any kind stop the phone until the web UI unlocks), the same refusals (`recovery_pending`, `hardware_unlock_off`, `hardware_unlock_failed`, a wrong passphrase).
* After every counted failure the guardian replaces the key (a near-miss passphrase sealed to the old one can then never be opened, even from the guardian's memory). After a success, the unlock replaces it.

**`unlock.hardware.add`, sealed.** Locked (`1100`), another wallet (`unlock_wallet_changed`), or a hardware wallet not yet confirmed (`1209`): refused before anything is opened, the key kept. Otherwise:

* `key` is not the key it holds, or `exp` has passed: `1101` with `data.reason` **`unlock_key_stale`**, nothing opened, nothing changed.
* Opened (whatever follows), the key is used up and replaced.
* The seal does not open, names another `for`, `guardian`, `key`, `phone` or `id`, or its `walletId` and `slot` are not the request's: `1202` with `data.reason` **`sealed_unlock_invalid`**. No throttle, as for a plaintext add's wrong signature (`unlock_signature_invalid`), which is what a sealed one that does not verify gets.

**The phone.** Before an unlock or an add it reads `guardian.status`. A guardian that lists `sealed_unlock` gets the secret sealed, always (one that lists it but shows no `unlockKey` gets nothing); only a guardian without the feature gets it in the clear, as before. On `unlock_key_stale` it reads `guardian.status` once more and sends again, sealed to the new key; a hardware signature is sealed again without asking the device (the device signs the same text the same way, and the phone holds it for the length of the call). A second `unlock_key_stale` is shown to the person ("try again"). A resend with a new id after `1501` is sealed again, since the id is bound. The phone keeps neither the secret, nor the one-time key, nor the sealing key.

**Older phones and guardians.** An older phone sends the secret in the clear; a guardian with `sealed_unlock` still accepts it (unlock and add), logs `guardian.unlock_unsealed` and marks the Activity line ("The phone sent it unsealed (an older Trikey app): update the app…"). A guardian without the feature lists no `unlockKey` and answers `sealed` in either method with `-32602` (its schemas have no such variant); a phone never sends it one.

**What it does not cover.** Requests sent in the clear before this release or by older apps, an attacker who holds the nostr key and answers as the guardian live, and the web UI's passphrase over plain HTTP on a LAN (another path, outside the relays): DESIGN.md says what remains. A passphrase that once travelled in the clear stops mattering once it is changed ("Changing the passphrase", below).

### Changing the passphrase

Guardians that list **`passphrase_change`** (`GUARDIAN_FEATURES.passphraseChange`) let the owner change the unlock passphrase in the guardian's web page (Settings, Passphrase; `POST /api/passphrase`, apps/guardian-web/API.md), only while unlocked and with the current passphrase. There is **no nostr method** for it: a phone cannot change the passphrase, sealed or not (DESIGN.md, "Changing the passphrase", says why). The feature tells the phone two things only: its Settings may say where to change it, and the guardian sends the paired phone a **`passphrase_changed`** alert (no extra members; `message` says it in words) after every change, with the owner's own extra alert channels. Never listed to a guest, and a guest's phone is never told.

Nothing else on the wire changes. The guardian's nostr key, its relays, key 3, the wallet and its rules, any hardware unlock slot (`guardian.status.hardwareUnlock`: the same slot id, the same text to sign) and the sealing key's behaviour stay as they were; the phone's next `guardian.unlock` simply carries the new passphrase (sealed, "Sealed unlock"). A phone never stores the passphrase, so there is nothing to update on it.

### Alerts

`params` is `{ type, at, atMs?, message?, walletId?, ...}` (`walletId`: guardians with `own_wallets`, on alerts about a wallet after the first, see "Own wallets") (`at` in unix seconds; `atMs` the same moment in unix milliseconds, sent on every alert, see "Time") with `type` one of the engine's alert kinds (`AlertKind`), plus `guardian_locked`, `wallet_adopted`, `wallet_retired`, `sp_received`, `relays_changed`, `notifications_changed`, `passphrase_changed`, `chain_source_changed` and `wallet_tx`, which the service raises itself. The `type` set is closed: a phone drops an alert whose `type` it does not know as malformed (section 4), so a new type reaches only phones that know it, and must never be needed by an older one to keep working:

| `type` | extra members |
|---|---|
| `recovery_started` | `recoveryId`, `readyAt`, `survivingRole`, `amountSats` |
| `recovery_reminder` | the same, plus `daysLeft` (whole days until `readyAt`). Sent every 24 h; after downtime only the latest one |
| `recovery_ready` | `recoveryId`, `readyAt`, `survivingRole`, `amountSats` (the delay has elapsed) |
| `recovery_cancelled` | `recoveryId`, `cancelledBy` (`app`\|`contact`\|`hardware`), `contested?` |
| `recovery_completed` | `recoveryId`, `txid?` |
| `guardian_locked` | `reason?` (`restart`\|`manual`\|`remote`\|`tamper`\|`contact`), `contact?`; `remote` = `guardian.lock` from the phone; `contact` = the alert contact `contact` sent `LOCK` (see "Alert contacts can lock the guardian"; phones before it drop this alert and see the lock in `guardian.status`) |
| `wallet_adopted` | `walletId`, `previousWalletId`, `recoveryId`, `hardwareConfirmRequired` (see "Wallet rotation") |
| `sp_received` | `txid`, `vout`, `valueSats`, `height`, `label?`: the silent payment scanner found a payment in a new block (see "Silent payments"); `sp.scan` has its tweak |
| `limit_off` | `sequence` (the hardware approval's), `limitBeforeSats?`: the daily limit was turned off. To the paired phone; alert contacts get a NIP-17 DM saying so in words. See "No daily limit" |
| `limit_on` | `limitSats`, `reason` (`phone`\|`hardware`\|`recovery`): the daily limit is on again; `recovery`: the wallet a recovery adopted starts with it. To the paired phone |
| `savings_moved` | `walletId` (the Savings wallet), `txid`, `amountSats` (what left Savings, fee included), `replaces?` and `previousAmountSats?` (a replacement of a spend announced before that pays out something else; a fee bump is not announced): a Savings coin was spent. To the paired phone; alert contacts get a NIP-17 DM. Guardians with `savings`; see "Savings" |
| `savings_unwatched` | `walletId` (the Savings wallet no longer watched), `replacedBy?` (the one watched instead): `savings.unregister`, or `savings.register` with another wallet. To the paired phone; alert contacts get a NIP-17 DM. See "Savings" |
| `relays_changed` | `relays` (`RelayList`): the guardian moved to these relays (its web UI). Sent to the paired phone (and phones with recovery access) over the old and the new relays. See section 5, "Changing relays" |
| `notifications_changed` | none: the extra alert channels (email, ntfy, webhook, Telegram) were changed in the guardian's web UI; read the new list from `guardian.status.notifications`. Guardians with `notifications`; see "Extra alert channels" |
| `passphrase_changed` | none: the owner changed the guardian's passphrase in its web UI; the old one no longer unlocks it, key 3 and any hardware unlock slot are unchanged. To the paired phone (and the owner's extra alert channels), never a guest's. Guardians with `passphrase_change`; see "Changing the passphrase" |
| `wallet_paused` | `walletId`, `by` (`contact`), `contact?`: a guest's hosted wallet was paused by one of its alert contacts' `LOCK`; its slot co-signs no payment until the guest's hardware wallet resumes it (`phone.resume`). To the guest's phone; the wallet's other contacts get a NIP-17 DM. Phones before it drop it and see `guardian.status.hosting.paused`. See "Family hosting" |
| `chain_source_changed` | `kind` (`own`\|`public`), `backend` (`electrum`\|`core`), `host`: the owner switched where the guardian reads the chain (its web UI, Settings > Server). Also announced on the extra alert channels and in Activity. To a guest wallet's phone: `host` is `"own"` for the owner's own node, and nothing goes on the owner's channels (see "Family hosting"). See "Chain data", "Chain source" |
| `wallet_tx` | `txid`, `direction` (`in`\|`out`\|`self`), `amountSats`, `feeSats?`, `confirmations`, `wallet` (`main`\|`savings`), `replaces?` (the unconfirmed transaction it replaced, RBF): a transaction touching the paired wallet or Savings was first seen (mempool or block), or first confirmed. Paired phone only. Guardians with `live_wallet`; see "Chain data", "Live wallet" |
| `wallet_added` | `walletId`, `account`, `name`: the owner added a wallet with the paired phone and a new hardware wallet (`wallet.add`). Guardians with `own_wallets`; see "Own wallets" |
| `wallet_retired` | `walletId`, `reason` (`retired`\|`recovered`\|`reset`), `successorWalletId?`. Sent to the phone that was paired to the wallet: `retired` after `wallet.retire`; `reset` after the web UI's reset; `recovered` when a recovery swept the wallet and the phone paired to the new wallet is a different one (a lost phone's replacement), or the guardian adopted none (`successorWalletId` is the adopted wallet when there is one). The phone that started the recovery and is adopted gets `wallet_adopted` instead |

Names match the engine (`daily_reminder` was renamed `recovery_reminder`; `daysRemaining` is now `daysLeft`, `executeAfter` is `readyAt`). The engine's `DueAlert` carries `dueAt` and `readyAt` in milliseconds; the service converts both to seconds (`at` and `readyAt`). `daysLeft` is already in days. The engine's due-alert record does not hold `cancelledBy`, the cancel's `contested` flag or the txid; the service reads them from the recovery record (`status().recovery`) when it builds those alerts.

### Error codes

Existing codes never change meaning; new ones are only added. `data` is optional and method-specific.

| Code | Name | Meaning |
|---|---|---|
| -32700 | ParseError | not valid JSON |
| -32600 | InvalidRequest | not a valid message |
| -32601 | MethodNotFound | unknown method, or the guardian has no handler |
| -32602 | InvalidParams | known method, bad params |
| -32603 | InternalError | guardian bug; details are never sent |
| 1001 | Unauthorized | |
| 1002 | PairingRejected | wrong, expired or used pairing secret |
| 1003 | AlreadyPaired | |
| 1004 | WalletRetired | the wallet was retired on this guardian (after a recovery, or `wallet.retire`) |
| 1005 | WalletNotWatched | `wallet.sync` for the replaced wallet, but the guardian watches none (or not that one) |
| 1100 | GuardianLocked | unlock it first |
| 1101 | UnlockFailed | |
| 1200 | PolicyViolation | a limit or rule forbids this |
| 1201 | ApprovalRequired | the change needs hardware approval |
| 1202 | ApprovalInvalid | bad signature or message mismatch |
| 1203 | ApprovalExpired | |
| 1204 | StaleSequence | approval sequence not above the guardian's |
| 1205 | SequenceTooFar | approval sequence more than 1000 ahead |
| 1206 | ApprovalExpiryTooFar | approval expires more than 24 h ahead |
| 1207 | PhoneSpendingPaused | phone payments are paused (contested cancel, or the wallet was swept) |
| 1208 | NothingToResume | `phone.resume` while nothing is paused |
| 1209 | HardwareAuthUnconfirmed | after a wallet rotation: send `hardware.confirm` before any hardware approval |
| 1300 | RecoveryNotFound | |
| 1301 | RecoveryAlreadyActive | |
| 1302 | RecoveryNotActive | |
| 1400 | PsbtInvalid | |
| 1401 | PsbtRejected | |
| 1500 | RateLimited | |
| 1501 | Unavailable | try again later (also: chain data unavailable) |
| 1600 | TxNotFound | `tx.get` of a transaction Electrs does not know |
| 1601 | BroadcastRejected | the node refused the transaction; its reason is in `message` and `data.reason` |
| 1602 | ForeignTransaction | `tx.broadcast` of a transaction that is not a spend of the paired wallet's coins, a sweep of the watched wallet into it, or a sweep of the phone's single-key coins into it; `data.reason` says which rule failed |
| 1603 | TxTooLarge | `tx.get` of a transaction longer than 150,000 hex characters (`witness: false` may fit) |
| 1700 | NodeRpcRequired | `sp.*` on a guardian without its node's RPC (`BITCOIN_RPC_HOST`, `_PORT`, `_USER`, `_PASS`) |
| 1701 | SilentPaymentsNotRegistered | `sp.scan` before `sp.register` (or after `sp.unregister`) |

### Engine refusals to error codes

The guardian service maps the engine's `Refusal.reason` to an error code and puts the refusal (without secrets) in `data`:

| Engine refusal | Code |
|---|---|
| `guardian_locked` | 1100 |
| `not_registered`, `not_authorized` | 1001 |
| `already_registered` | 1003 |
| `invalid_registration`, `invalid_rules` | -32602 (InvalidParams) |
| `over_daily_limit`, `not_signed_by_app`, `signature_count`, `hardware_signed_outside_recovery`, `sweep_fee_exceeds_cap`, `delay_not_elapsed` (`waitingFor: "chain_time" \| "blocks"` when the clock says the delay is over but the chain does not), `recovery_signers`, `invalid_destination`, `destination_drops_surviving_key`, `destination_keeps_lost_key`, `sweep_not_to_destination`, `invalid_recovery_update` | 1200 |
| `hardware_approval_required` | 1201 |
| `approval_invalid_signature`, `unsupported_approval`, `approval_revoked` | 1202 |
| `approval_expired` | 1203 |
| `approval_stale_sequence` | 1204 |
| `approval_sequence_too_far` | 1205 |
| `approval_expiry_too_far` | 1206 |
| `phone_spending_paused` | 1207 |
| `nothing_to_resume` | 1208 |
| `hardware_auth_unconfirmed` | 1209 |
| `wallet_retired` | 1004 |
| `no_recovery` | 1302 (1300 when a specific `recoveryId` is unknown) |
| `recovery_in_progress` | 1301 |
| `invalid_psbt`, `invalid_helper_input`, `foreign_input`, `missing_non_witness_utxo`, `non_witness_utxo_mismatch`, `invalid_signature` | 1400 |
| `chain_unavailable` (no chain data: a recovery cannot start or complete, nor a co-signature once the last chain observation is old), `clock_ahead_of_chain` (the guardian's clock is more than 3 h ahead of the chain's median time past: it co-signs nothing) | 1501 |

## 4. Validation, expiry and replay

A receiver MUST, in this order, silently drop (no reply, so nothing can be probed) any event that fails:

1. **Wrap:** kind 1059, correct `id` and signature (recompute from the fields; do not trust a cached "verified" flag), a `p` tag with its own pubkey, content at most 400,000 chars.
2. **Decryption:** NIP-44 wrap -> seal (kind 13, valid signature) -> rumor; `rumor.pubkey == seal.pubkey`; rumor `id` correct.
3. **Peer:** the seal's author is the expected peer. The phone expects exactly the guardian. The guardian accepts its paired phones, alert contacts for `recovery.cancel`, phones holding recovery access for the recovery methods, and any sender only for `pair.prepare` / `pair` (around a pairing session) and `recovery.access`.
4. **Envelope:** rumor kind 21420, tags as in section 2, JSON valid against the schemas, PSBT hash matches.
5. **Time**, using the rumor's `created_at` and `expiration` (not the wrap's) and the receiver's clock:

   | Check | Requests and responses | Alerts |
   |---|---|---|
   | `expiration > now` | required | required |
   | `created_at <= now + 120 s` (clock skew) | required | required |
   | `created_at >= now - window` | window 1 h | window 7 days |
   | `expiration - created_at <= max TTL` | 1 h | 7 days |

   Default TTLs when sending: 5 minutes for requests and responses, 7 days for alerts.
6. **Replay:** the pair (sender pubkey, message `id`) is remembered until `min(expiration, created_at + window) + 120 s` (bounded LRU, 4096 entries by default). A second message with the same pair is a duplicate. The check is made only for already-authorized senders, so strangers cannot fill the cache.

Also drop a wrap *event id* seen before (the same event arrives from several relays), and a wrap whose public `expiration` tag is more than 120 s in the past, before step 1: the wrap's expiration is never before the rumor's (section 2), so its rumor would fail step 5 anyway.

### Handled wraps

Every subscription is sent the whole look-back again (section 2), so a receiver that opens each delivered wrap afresh does steps 1 and 2 (two signature checks, two decryptions) for every stored wrap, on every relay, at every start and every resubscription: on a phone, minutes of its JS thread. The reference implementation therefore:

* **keeps the ids of handled wraps across restarts** (`SeenWraps`: the phone in its app storage, the guardian in `seen-wraps.json` in its data directory), each until it can no longer be delivered: `min(wrap expiration, wrap created_at + 2 days 10 min) + 10 min`, at most 4096;
* **checks a delivered event's id against them before anything else**: before the event is even parsed (nostr-tools' `alreadyHaveEvent` reads the id from the raw message), so a handled wrap costs no signature check and no decryption;
* **checks each new wrap's signature once**, in step 1, and not again in the relay layer (the reference pool checks only the event's shape and that its id is its hash, and passes on each exact copy once, keyed by id *and* signature);
* opens new wraps a few per turn of the event loop (the phone: 2), those that arrived after the subscription's EOSE first, so that a backlog never blocks the app.

**Why skipping a known id is safe.** An event id is the SHA-256 of the event's serialized content (`[0, pubkey, created_at, kind, tags, content]`, NIP-01), and an id is added only after the wrap passed step 1, i.e. its id was recomputed from the content and its signature checked. A different event cannot have that id (a SHA-256 collision); any event that arrives claiming a known id is either that same wrap again or a forgery that would have failed step 1, and dropping either loses nothing. Forgeries cannot suppress a real wrap the other way round either: a wrap that fails step 1 (`bad_wrap`) is never remembered, and the relay layer, which no longer checks signatures, deduplicates on id plus signature after checking the id is the hash of the content, so a forged copy that arrives first (same content, broken signature) is passed on separately, rejected in step 1, and the real copy from another relay is still opened. A hostile relay can still withhold events, as it always could (section 5). The phone remembers for all its connections (one nostr key) only outcomes that are the same for each of them (an answer that settled a call, an alert, a stale or malformed message); an answer to no call of that connection, a duplicate message id and a wrap from another guardian are remembered by that connection only, in memory, since another connection (to the guardian's new relays, to an old guardian) may still need them.

### Retries and idempotency

If no response arrives, the phone MAY re-send the same request: same `id`, same rumor `created_at` and `expiration`, in a new gift wrap. The guardian runs a request's handler **at most once** per `(sender, id)`. On a duplicate it re-sends the response it computed the first time (it keeps recent responses), or does nothing if the handler is still running: the re-send joins the run under way, whose one answer settles the call. The reference server keeps that last rule apart from the replay guard, so it holds however long the handler runs (a `wallet.sync` on a cold cache, re-sent with a fresh `created_at` after the replay window, still joins it). A response is matched to its call by `id`; responses with an unknown `id` are ignored.

A request that only reads (`guardian.status`, `wallet.sync`, `tx.get`, `fees.estimate`, `policy.get`, `recovery.status`, `savings.get`) MAY be re-sent with a fresh rumor `created_at` and `expiration` (same `id`) once the original is close to expiring: the reference client does so when the phone was suspended longer than the request's TTL. Running such a request twice is harmless, and a guardian that still remembers the `id` answers from its cache. Any other request is re-sent only as it was, and not at all once it has expired, so it never runs twice.

A phone that was suspended (an iPhone with the screen off, an Android app in the background) sees a call's timeout fire late, on waking. The reference client takes that for a suspension, not a silent guardian: it re-sends the request and waits up to 15 s more. It also re-sends every unanswered request when a relay's subscription is back after a drop, since what it sent meanwhile may have been lost with the old connection.

The reference guardian answers `tx.broadcast` without the wallet scan of rule (a) in "Chain data" when it can tell otherwise that the transaction spends a coin of the wallet: it co-signed the transaction in the last 30 minutes (`sign` checked every input, and the txid commits to them), or an input is a coin its last `wallet.sync` of the paired wallet listed, and the previous transaction (checked against its txid) pays that coin's address of the wallet. Both are kept in memory only; on a miss it scans as before.

A phone that restarts while a request is unanswered can re-send it with the same `id` once it is subscribed again. The relays may then replay the guardian's original answer (it is stored until the wrap's expiration, which is later than the rumor's), which the phone receives before it re-sends; the reference client keeps recent answers that matched no call and resolves a call that re-uses their `id` with them (its replay guard would otherwise drop the fresh answer for that `id` as a duplicate).

For state-changing methods (`guardian.unlock`, `guardian.lock`, `pair`, `policy.update`, `recovery.start`, `recovery.cancel`, `phone.resume`, `hardware.confirm`, `wallet.retire`, `wallet.unwatch`, `singlekey.register`, `sp.register`, `sp.unregister`, `unlock.hardware.add`, `unlock.hardware.remove`) the guardian remembers handled ids **across restarts** (`relays.ack` is not among them: running it twice changes nothing). A retry of a request it handled before restarting gets `1501 Unavailable` instead of running again, because its cached response was lost. The phone should then check the state (`guardian.status`, `recovery.status`, `policy.get`) and, if needed, send a new request with a new `id`.

## 5. Relays

* The relay list comes from the pairing URI (and can change later, below). Both sides use the same list; publish to all, subscribe on all.
* A relay must accept kind 1059 and honour `#p` filters. Relays that implement NIP-40 will purge wraps at their (randomised, later) wrap expiration; see "Wrap timestamps".
* PSBT messages are large after two layers of base64 (roughly 1.8x the PSBT's base64 size); choose relays that accept events of a few hundred KB.
* A hostile relay can drop, delay or replay events. It cannot read or alter them (altered ciphertext fails the MAC; a re-signed wrap fails to decrypt) and replays are caught by section 4.
* **Keep the subscription open.** Connections drop: a relay restarts, a phone changes network, Android destroys the sockets of an app in the background. Both sides MUST subscribe again on a relay whose subscription ended (after a short backoff; the reference pool waits 1, 2, 5, 10, then every 30 s, jittered, and the app does it at once when it comes back to the front), and MUST NOT narrow `since` to the newest event seen: a wrap sent while the relay was out of reach can be back-dated by up to 2 days (section 2). The reference pool asks again from as far before the drop as the first subscription asked before its start (2 days and 10 minutes). The events delivered again are dropped by wrap id, before any signature check or decryption ("Handled wraps", section 4), and by the replay guard; a duplicate request is answered from the guardian's response cache, never run again. Once a relay's subscription is back, the reference phone reads `guardian.status` again: what the guardian said meanwhile may be lost (an unlock in the web UI after a restart sends no alert). Publishing alone is not enough: a client that can still publish but no longer listens sends requests whose answers it never hears.

### Changing relays

The guardian's owner can replace its relay list in the web UI (`PUT /api/relays`, apps/guardian-web/API.md) with the pairing code's rules: 1-8 relays, `wss://` or `ws://` on a local or `.onion` host, normalised, duplicates dropped. The phone, its backups and printed recovery codes all hold the list from pairing, so the change is made so that none of them is cut off:

1. **The guardian moves at once and keeps the old relays.** From the change it subscribes and publishes on the new relays *and* the removed ones ("retiring"). There is **no fixed grace period**: it watches the old relays until the owner stops them in the web UI (`DELETE /api/relays/retiring`, apps/guardian-web/API.md), because printed recovery sheets, which carry the relay list, are kept for years and an old sheet must keep working. It publishes everything (answers, alerts) on all of them: a phone that has not switched listens only on the old relays, so an answer sent only to the new ones would never reach it. Pairing and recovery codes carry the new list. At most 16 retiring relays are watched: a change that would exceed it is refused until the owner stops some, and nothing is dropped on its own.
2. **It tells the phone.** The paired phone (and phones with recovery access) get a `relays_changed` alert with the new list, over old and new relays. `guardian.status` carries the current list as `relays`, so a phone that missed the alert (offline longer than the relays keep it) catches up at its next status read.
3. **The phone checks, then moves only to relays that work.** It takes a list only from its paired guardian (the alert or answer arrived on the connection to that guardian, whose key section 4 checked) and only if it passes the pairing code's relay rules, so nobody else can move it. It then connects on the new relays alone and sends **`relays.ack`** `{ relays }` there (a phone that is only recovering sends `guardian.status` instead). Only when the guardian answers over the new relays does the phone store the list (its next backup carries it) and move its connection; requests already sent on the old connection are answered there. No answer: it stays on the relays it has, which the guardian still watches, and tries again at the next alert or status read (the reference wallet at most every 5 minutes for the same list). A relay that is down or mistyped therefore never cuts the phone off: the owner sees in the web UI that the phone has not confirmed, and fixes the list.
4. **`relays.ack`** (paired phone only; anyone else is dropped unanswered) answers `current` (the list is the guardian's current one, in any order) and the current `relays`. With `current: true` the guardian records the confirmation once (the web UI and the activity log show it). With `current: false` the guardian moved again meanwhile; the phone follows `relays` the same way. The ack does **not** end the watching of the old relays: it proves the phone moved, not that a backup restored later (same nostr key, old list) or a recovery code printed before the change did.
5. **Once the owner stops watching an old relay** a phone, backup or recovery code that still knows only it no longer reaches the guardian: the phone has to be paired again, or recover with a recovery code from the web UI. The web UI says so before it stops them, and logs it ("Old relays dropped").

**Versions.** Phones from before relay changes drop `relays_changed` as malformed (an unknown alert `type`, section 4) and ignore `guardian.status.relays` (result members are lenient): they keep working over the old relays for as long as the owner watches them, and lose the guardian only when the owner stops them, unless updated. Guardians from before never send the alert or the member, so a phone never sends them `relays.ack`; if one did, they answer `-32601` (MethodNotFound) to the paired phone, which the phone takes as an answer.

## 6. Pairing

The guardian shows a QR code with a one-time secret:

```
trikey://pair?v=1&npub=<npub1...>&relay=<url>&relay=<url>&secret=<base64url>&exp=<unix seconds>[&label=<text>]
```

| Field | Rules |
|---|---|
| `v` | `1` |
| `npub` | the guardian's NIP-19 `npub` |
| `relay` | 1-8, repeated; `wss://`, or `ws://` only for localhost, `.local`, `.lan`, `.onion` and private IPv4 ranges; no credentials or fragment |
| `secret` | 22-128 chars of `[A-Za-z0-9_-]`; the reference guardian uses 32 random bytes, base64url without padding (43 chars) |
| `exp` | unix seconds, at most 24 h after the code was made; an expired code is rejected |
| `label` | optional, 1-64 chars, shown in the app |

`trikey:pair?...` (no `//`) is accepted too. Total length at most 2000 characters.

The phone scans it, derives its key, and sends `pair.prepare` and then `pair` (see "Pairing" in section 3) to the guardian's `npub` on those relays. The guardian accepts these two methods from an unknown pubkey only if `pairingSecret` matches the live, unused secret (constant-time comparison; one attempt budget per code is advisable); `pair` then adds the sender to its peers and burns the secret.

### Recovery code ("Recover on a new phone")

A guest wallet's code adds `&hosted=1` (and always `&wallet=<walletId>`): the new phone uses `hosted.access` and the wallet
map instead of `recovery.access`.

For a new phone without the old one or its backup, the guardian's web UI shows a second, permanent QR code with only where to find the guardian:

```
trikey://recover?v=1&npub=<npub1...>&relay=<url>[&relay=<url>...]&net=<bitcoin|testnet|signet|regtest>[&label=<text>][&wallet=<walletId>]
```

It carries **no secret and no expiry**: the npub and relays are not secret, and what admits the phone is the hardware wallet's `recovery.access` signature (section 3, "Recovery access"), not this code. `relay` and `label` follow the pairing rules; `net` tells the phone which network to create its wallet on. A decoder MUST refuse a recovery code that carries a `secret`, and the two codes are never interchangeable (`decodeRecoveryUri` refuses a pairing code and vice versa; `decodeTrikeyUri` tells them apart). `wallet` (optional; older guardians omit it) is the wallet id the guardian guards, for the version-2 `recovery.access` text.

## 7. Compatibility notes

* Add new methods or optional result members freely; never change the meaning of an existing error code or field. A breaking envelope change bumps the `trikey` tag value.
* A new alert `type` is dropped by phones that do not know it (the alert schema is a closed union, and a malformed message is dropped silently, section 4), and a new method is answered `-32601` by guardians that do not know it. So a new alert may only add something an older phone can do without (`relays_changed`: an older phone keeps the old relays, which the guardian watches until its owner stops them), and a phone sends a new method only to a guardian that showed it knows it.
* A capability that changes what the phone may ask (rather than adding a method) is announced in `guardian.status.features`; the phone acts on it only when listed (`limit_off`: "No daily limit"; `contact_lock`: "Alert contacts can lock the guardian"; `savings`: the "Savings" methods, whose wallet's chain data comes from the guardian, so a phone makes Savings only with such a guardian; `notifications`: `guardian.status.notifications` and the `notifications_changed` alert, read-only; `live_wallet`: `wallet_tx` alerts and `wallet.sync` from live data, nothing the phone must send differently; `own_wallets`: `walletId` and `wallet.add.*`; `own_wallets_2`: `walletId` on `savings.*`, `wallet.add`'s `hardwareKind` and `replacesWalletId` / `replacesDescriptor`, see "Own wallets"; `pairing_rules_approval`: `rulesApproval` in `pair`, `wallet.add` and `hosted.pair`, which such a guardian requires (an app from before is refused with `-32602`, `data.reason: "app_update_required"`: update the app; a new app sends it only to a guardian that lists the feature, so it still pairs with an older guardian, unapproved as before), see "Pairing"; `sealed_unlock`: `guardian.status.unlockKey` and the `sealed` variants of `guardian.unlock` and `unlock.hardware.add`, which the phone then always uses ("Sealed unlock"); `passphrase_change`: the `passphrase_changed` alert, and the phone may say the passphrase is changed in the web page (no method, "Changing the passphrase"); `short_wraps` (0.1.10): the guardian's answers are back-dated at most 10 minutes and expire about an hour later, section 2. Its alerts still are back-dated up to 2 days, and they arrive on the same subscription, so the reference phone keeps its 2-day look-back either way; a phone MUST NOT shorten its look-back before it has seen `short_wraps`, since the first answers of an older guardian are back-dated up to 2 days). A new approval text gets a new version word (`Trikey policy v2`, `v3`), so an older guardian refuses it with `1202` rather than misreading it.
* Hardware approvals are an `approval` object with a `kind`. Only `bip137` exists. If the project settles on a PSBT-based approval (see DESIGN.md, open question 1), it will be a new `kind`, not a change to `bip137`.
* The policy is deliberately closed: a new rule means a new engine rule first, then a new `Policy` member and a new `policyHash` input. A rule that is always present changes every hash and needs a protocol version bump. An **opt-in** rule (`contactLock`) can avoid that: it is present only when on, so every policy without it, and its hash and approval text, are exactly what they were; it is announced as a feature, sent only to guardians that list it (older ones refuse the member, the schema being strict), and approved over a new text version. A guardian downgraded below the feature ignores the member (it hashes and returns the policy without it, and LOCK messages do nothing).
