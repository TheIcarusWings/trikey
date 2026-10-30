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
* **Seal** and **wrap** are exactly as in NIP-59 (NIP-44 v2 encryption; the wrap is encrypted with the throwaway key's conversation key with the recipient). Their `created_at` is randomised up to 2 days into the past, as NIP-59 recommends. The rumor's `created_at` is the real send time and stays inside the encryption.
* **Wrap tags:** `["p", <recipient pubkey>]` and `["expiration", <unix seconds>]`, so relays can purge it. The wrap's `expiration` is **not** the rumor's: it is cleartext, and `rumor expiration - TTL` would be the send time, which the back-dating exists to hide. See "Wrap timestamps" below.
* The wrap is the only thing published. Publish it to every relay in the shared relay list; a message needs to reach just one.
* **Subscribing:** `{"kinds":[1059], "#p":[<own pubkey>], "since": now - 2 days - 10 min}`. The look-back is needed because wrap timestamps are back-dated; staleness is judged on the rumor (section 4), never on the wrap.
* **Implementation note (reference code).** The seal layer is encrypted with the conversation key of the two static keys, which never change between a phone and its guardian, so `@trikey/protocol` caches it per (secret key, peer) (`ConversationKeyCache`); only the wrap layer's ECDH with the throwaway key is done per message. The guardian opens each incoming wrap once (`openGiftWrap`) and routes the rumor by kind: 21420 to the RPC server, 14 (NIP-17 DMs from alert contacts) to the DM handler. Neither changes anything on the wire.

### Wrap timestamps

Let `W` = 172,800 s (2 days, the back-dating window) and `M` = the largest TTL the message's class allows (section 4: 3,600 s for requests and responses, 604,800 s for alerts). The sender draws `r` uniformly from the integers `0..W` with the checked random source (`secureRandomInt`) and sets, on the wrap:

```
created_at = floor(now) - r
expiration = created_at + W + M          (= now + M + (W - r), in [now + M, now + M + W])
```

* **No send time on the wrap.** The expiration is a function of the wrap's own `created_at` only, and so reveals nothing about `now` that `created_at` does not already: both come from the one draw `r`, and neither depends on the message's TTL. (An independent jitter of the same width would let a watcher intersect the two windows and narrow the send time down.) A relay still sees *when an event arrives*, so this hides the send time from anyone reading stored events later, not from the relay while it receives them.
* **Never in the past.** `created_at + W >= now`, so `expiration >= now + M`, at least one hour ahead when published, whatever the clock rounding.
* **Receivers still accept fresh messages.** Receivers judge freshness on the *rumor's* exact `expiration` (section 4), which is inside the encryption; they never read the wrap's tag. The wrap's expiration is always at or after the rumor's (a message's TTL is at most `M`, and a sender whose own rumor expiration were later would publish that value instead), so a relay never purges a wrap a receiver would still accept.
* **Not the TTL.** The wrap uses the class maximum `M`, not the message's own TTL, so a 30 s status call and a 1 h call look the same; only the class (alert or not) shows.
* **Cost.** A relay may keep a request's wrap for up to `W + M` (about 2 days) instead of minutes. Replay protection is unaffected: it uses the rumor's `created_at` and `expiration` only (section 4), never the wrap's tag, and wrap event ids are deduplicated separately.
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
| `pair.prepare` | `pairingSecret`, `network`, `entropy?: Hex32` (the phone's contribution to key 3, see "Key 3 from both sides") | `guardianKey: KeyOrigin`, `guardianVersion`, `key3Mixed?: boolean` |
| `pair` | `pairingSecret`, `deviceName` (1-64), `network` (`bitcoin`\|`testnet`\|`signet`\|`regtest`), `phoneKey: KeyOrigin`, `descriptor`, `phoneNostrPubkey: Hex32`, `hardwareAuth: { pubkey, path }`, `hardwareAuthProof`, `rules: Policy`, `replacesWalletId?: WalletId`, `replacesDescriptor?` (needs `replacesWalletId`; see "Replacing the guardian") | `guardianKey: KeyOrigin`, `descriptor`, `walletId`, `guardianVersion`, `key3Mixed?: boolean` |
| `sign` | `psbt`, `memo?` | `psbt` (with the guardian's partial signatures) |
| `policy.get` | `{}` | `policy`, `nextHardwareSequence`, `policyHash`, `warnings?` (`["no_alert_contacts"]`: no alert contact, so a recovery is announced only to the paired phone; mainnet guardians refuse such a policy, test networks warn) |
| `policy.update` | `policy`, `approval?` | `policy`, `nextHardwareSequence`, `policyHash` |
| `recovery.start` | `sweepPsbt`, `newDescriptor` | `recovery` |
| `recovery.update` | `recoveryId`, `sweepPsbt` | `recovery` (same id and `readyAt`, the new `sweepTxid`, `amountSats` and `feeSats`) |
| `recovery.cancel` | `recoveryId`, `approval?` | `recovery`, `contested: boolean` |
| `recovery.status` | `recoveryId?` (default: the active one) | `recovery` (or `null`), `psbt?` (the signed sweep, once the guardian has co-signed it) |
| `phone.resume` | `approval` | `phoneSpending: "enabled"` |
| `guardian.unlock` | `{kind:"passphrase", passphrase}` or `{kind:"hardware", secret: hex}` | `unlocked: boolean` (`1101` with `data.reason` `phone_unlock_disabled` after 5 wrong passphrases in a row until the web UI unlocks, or `recovery_pending` while a recovery the phone did not start runs; the phone's attempts have their own rate limit) |
| `guardian.status` | `{}` | `state` (`locked`\|`unlocked`), `paired`, `nextHardwareSequence`, `phoneSpending` (`enabled`\|`paused_recovery`\|`paused_contested`\|`retired`), `activeRecoveryId`, `version`, `time`, `atMs?` (the guardian's clock in milliseconds when it answered, see "Time"), `dailyLimit?: { limitSats, usedSats, availableSats }`, `walletId?`, `hardwareConfirmRequired?`, `watchedWalletId?` (the replaced wallet the guardian watches, if any), `key3Mixed?` (while paired: key 3 was made with the phone's `entropy`), `warnings?` (as `policy.get`'s), `relays?` (the guardian's current relays, section 5 "Changing relays") |
| `guardian.lock` | `{}` | `state: "locked"` (see "Locking from the phone") |
| `wallet.sync` | `historyLimit?` (1-500, default 100), `wallet?` (`"replaced"`, `"helper"` or a `WalletId`; default the paired wallet) | `walletId?`, `tipHeight`, `tipHash`, `utxos`, `utxosTruncated`, `balance: { confirmedSats, unconfirmedSats }`, `history`, `historyTruncated`, `nextReceiveIndex`, `nextChangeIndex`, `gapLimit`, `coins?` (`"helper"` only) (see "Chain data", "Silent payments") |
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
| `relays.ack` | `relays: RelayList` (the relays the phone uses now) | `current: boolean` (they are the guardian's current list, in any order), `relays: RelayList` (the guardian's current list) (paired phone only; see section 5, "Changing relays") |

**Policy** is exactly the four rules the guardian's policy engine enforces, and nothing else:

| Member | Rule |
|---|---|
| `dailyLimitSats` | most the phone + guardian may spend in any rolling 24 h (`Sats`; 0 means never) |
| `recoveryDelayDays` | Delay & Notify period: **7, 14 or 30** |
| `alertContacts` | up to 20 nostr pubkeys (`Hex32`, lowercase) that receive recovery alerts and may cancel a recovery |
| `sweepFeeCapSats` | highest absolute fee a recovery sweep may pay (`Sats`, at least 1) |

The schema is **strict**: any other member (the old `perTxLimitSats` and `allowlist` included) is a validation error, not preserved or ignored, so the protocol never carries a rule the guardian does not enforce. `policyHash` = hex SHA-256 of the canonical JSON (keys sorted by UTF-16 code unit, no whitespace) of the *normalized* policy: `alertContacts` lowercased, deduplicated and sorted, and exactly the four members:

```
{"alertContacts":["<hex>",...],"dailyLimitSats":100000,"recoveryDelayDays":14,"sweepFeeCapSats":20000}
```

This is byte for byte the engine's `policyHash(rules)` (a test compares them). The guardian stores and returns the normalized policy.

**Which changes need the hardware wallet.** The phone alone may only *tighten*: lower `dailyLimitSats` and/or raise `recoveryDelayDays`, nothing else changing. Raising the limit, shortening the delay, changing the fee cap (a lower cap could block a genuine recovery, so it is not a safe direction) or the contacts needs `approval`. Without it the guardian answers `ApprovalRequired`. While a recovery is running, hardware-approved policy changes are refused (`RecoveryAlreadyActive`).

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
| `cancel-recovery` | `Trikey cancel-recovery v1 wallet=<walletId> seq=<n> recovery=<recoveryId> expires=<ISO>` |
| `resume-phone` | `Trikey resume-phone v1 wallet=<walletId> seq=<n> expires=<ISO>` |
| `retire-wallet` | `Trikey retire-wallet v1 wallet=<walletId> seq=<n> expires=<ISO>` |
| pairing proof | `Trikey pair v1 wallet=<walletId> guardian=<cosignerAccountPubkey hex>` |
| recovery access | `Trikey recovery-access v2 wallet=<walletId> guardian=<guardian nostr pubkey hex> phone=<new phone's nostr pubkey hex> expires=<ISO>` when the phone knows the wallet id (from the recovery code, or when renewing), else `Trikey recovery-access v1 guardian=... phone=... expires=<ISO>` (no wallet id and no sequence: see "Recovery access") |

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
   * `replacesWalletId?` / `replacesDescriptor?`: only when this wallet replaces another one (see "Replacing the guardian").

   The guardian checks the descriptor, that the three keys are distinct and that the guardian key sits in its slot, the rules, the key (and, when the path lies under the hardware xpub, that it derives from it) and the proof. It then registers the wallet and burns the secret.

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

### Chain data

The guardian already has the wallet's descriptor and the user's own Electrs, so it serves the paired phone's chain data and broadcasts for it: the phone never asks a public server. `wallet.sync`, `tx.get`, `tx.broadcast` and `fees.estimate` need no key 3, so they **work while the guardian is locked**. Only the paired phone may call them (plus, for the reads, a phone with recovery access); requests from anyone else are dropped without an answer like every other unauthorized request. Amounts are `Sats` (JSON numbers); heights are 0 while unconfirmed.

* **`wallet.sync`** scans both chains of the descriptor (receive `0`, change `1`) the way the guardian checks recovery coverage: until `gapLimit` (20) consecutive addresses have no history.
  * `utxos`: `{ txid, vout, valueSats, height, confirmations, chain, index }`, every unspent output, confirmed ones first by value, at most 500 (`utxosTruncated` says there are more; `balance` always counts all of them). `chain`/`index` are the derivation steps below the account keys, which the phone needs to build the PSBT input.
  * `history`: `{ txid, height, confirmations, time?, netSats, feeSats? }`, newest first (unconfirmed, then by height), at most `historyLimit` (`historyTruncated`). `netSats` is what the transaction did to the wallet's balance: received minus spent, fee included, negative for payments. `feeSats` is present when every input belongs to the wallet (otherwise the guardian does not know all input amounts). `time` is the block's timestamp.
  * `nextReceiveIndex` / `nextChangeIndex`: the first index with no history on each chain. The phone receives at `nextReceiveIndex` and sends change to `nextChangeIndex`.
* **`tx.get`** returns a raw transaction (for PSBT `nonWitnessUtxo`) after checking it hashes to `txid`, so a confused Electrs cannot hand the phone a different transaction. With `witness: false` it is the serialization without witness data: same txid, all `nonWitnessUtxo` needs, and much smaller. Unknown: `1600 TxNotFound`. At most 150,000 hex characters, else `1603 TxTooLarge`.
* **`tx.broadcast`** relays a fully signed raw transaction, but the guardian is not an open relay: it relays **only** (a) one that **spends at least one output paying one of the paired wallet's addresses** (within the scanned range), (b) a **sweep of the watched wallet into the paired wallet** (below), or (c) a **sweep of the phone's single-key coins into the paired wallet** (below). Otherwise `1602 ForeignTransaction`, with `data.reason` naming the rule that failed. Each paired phone may call it at most 20 times per 10 minutes, refused calls included (`1500 RateLimited`, `data.retryAfterSeconds`); the check can scan both wallets on Electrs. It needs no key 3.
  * **A sweep of the watched wallet** (rule b) must satisfy all of: the current pairing named that wallet in `replacesWalletId` and the guardian holds its descriptor (else `data.reason: "spends_no_wallet_coin"`); at most 500 inputs (`too_many_inputs`) and 10 outputs (`too_many_outputs`, which also covers none); **every input** spends a coin of the watched wallet, i.e. its transaction is in the watched wallet's history and the previous output pays one of its addresses, the previous transactions being fetched and checked against their txid (`input_not_from_replaced_wallet`); **every output** pays an address of the paired wallet, receive or change, within the scanned range (`output_not_to_wallet`); the outputs do not exceed the inputs (`outputs_exceed_inputs`); and the fee (inputs minus outputs) is at most the policy's `sweepFeeCapSats` (`1200 PolicyViolation`, `data.reason: "sweep_fee_exceeds_cap"`, `data.fee`, `data.cap`; the fee cap can be raised with a hardware approval like any other rule).
  * **Why all outputs and all inputs.** A sweep moves everything to the new wallet, so there is nothing to pay anyone else: an output elsewhere, even a small one, would let the rule double as a payment channel for a stolen phone key, and an input that is not the watched wallet's would let one watched coin carry any transaction through. Allowing "all outputs except an amount within the fee cap" would add nothing a sweep needs (a fee is not an output) and would be the leak the rule exists to close. The fee cap bounds what miners can take.
  * The guardian does **not** check signatures: a transaction the node would refuse is `1601 BroadcastRejected` with the node's reason. A transaction that does not parse is `-32602`; one the node refuses (double spend, too low a fee, bad signature) is `1601 BroadcastRejected` with the node's reason in `message` and `data.reason`. The result is the txid the guardian computed.
  * **A sweep of the phone's single-key coins** (rule c, see "Silent payments") is checked the same way: at most 500 inputs and 10 outputs; **every input** spends a silent payment the guardian's scanner found, a coin the phone registered (`singlekey.register`, and the previous output must pay exactly the registered script), or a coin of the registered helper account (scanned range) (`input_not_single_key`); **every output** pays an address of the paired wallet (`output_not_to_wallet`); the outputs do not exceed the inputs; and the fee is at most `sweepFeeCapSats` (`1200`, `sweep_fee_exceeds_cap`). It applies as soon as one input is such a coin, so a transaction that spends a match but pays anyone else is refused, not relayed under another rule.
* **`fees.estimate`** asks the node (`blockchain.estimatefee`) per target and converts BTC/kvB to sat/vB; `satPerVb` is `null` where the node has no estimate (usual on regtest and signet, and right after a restart). `minRelaySatPerVb` is the node's relay fee floor.
* Electrs unreachable or not synced: `1501 Unavailable`; try again later.

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

### Recovery access

"Lost phone, no backup": the user has a new phone, the hardware wallet and the guardian. The new phone has a fresh nostr key that the guardian does not know, and it knows neither the descriptor nor the guardian's key, only the guardian's `npub` and relays (the web UI's "Recover on a new phone" code, section 6). `recovery.access` lets the hardware wallet vouch for it:

1. The phone asks the device for the authorization key (the same path the wallet used at pairing; it is derived the same way on every phone, see the guardian README) and has it BIP 137-sign `recoveryAccessMessage({ guardianPubkey, phonePubkey, expiresAt, walletId? })`, with `expiresAt` at most 24 h ahead. With `walletId` (the recovery code carries it since the 2026-10 security review; a phone renewing its access knows it) the text is version 2 and binds the wallet too; without it, version 1.
2. **`recovery.access`** from any sender, once a wallet is paired. The guardian rebuilds the text with *its own* nostr key and the *sender's* key, so the signature is no use to another phone or against another guardian, and verifies it against the paired `hardwareAuth`. Wrong signature `1202`, expired `1203`, too far ahead `1206`. It does not consume a hardware sequence number. Both versions are accepted; a version-1 signature whose grant a wallet rotation or retirement revoked is refused until it expires (`1202`, `data.reason: "approval_revoked"`), whatever its encoding, so the next wallet does not honour it. BIP 137 signatures with a high S are refused (signers only make low-S ones).
3. The sender may then, until `accessExpiresAt` (durably, across guardian restarts), call `guardian.status`, `wallet.sync`, `tx.get`, `fees.estimate`, `recovery.start`, `recovery.status`, `recovery.cancel` (only with a hardware approval) and `recovery.access` again. Not `sign`, `policy.*`, `tx.broadcast`, `phone.resume` or `guardian.unlock`. The result gives the phone everything it needs to sweep: the descriptor, the wallet id, the guardian's key and the rules (for the sweep fee cap).

Anyone holding the hardware wallet can thus start a recovery from any phone, which is the design: a recovery is announced to the paired phone and every alert contact, and any of them can cancel it (DESIGN.md, threat model). The web UI's activity log shows every access grant. While its access lasts, a phone with recovery access also gets the protocol alerts (best effort; it is not one of the recovery's recorded recipients), and it can poll `recovery.status`.

### Alerts

`params` is `{ type, at, atMs?, message? , ...}` (`at` in unix seconds; `atMs` the same moment in unix milliseconds, sent on every alert, see "Time") with `type` one of the engine's alert kinds (`AlertKind`), plus `guardian_locked`, `wallet_adopted`, `wallet_retired`, `sp_received` and `relays_changed`, which the service raises itself. The `type` set is closed: a phone drops an alert whose `type` it does not know as malformed (section 4), so a new type reaches only phones that know it, and must never be needed by an older one to keep working:

| `type` | extra members |
|---|---|
| `recovery_started` | `recoveryId`, `readyAt`, `survivingRole`, `amountSats` |
| `recovery_reminder` | the same, plus `daysLeft` (whole days until `readyAt`). Sent every 24 h; after downtime only the latest one |
| `recovery_ready` | `recoveryId`, `readyAt`, `survivingRole`, `amountSats` (the delay has elapsed) |
| `recovery_cancelled` | `recoveryId`, `cancelledBy` (`app`\|`contact`\|`hardware`), `contested?` |
| `recovery_completed` | `recoveryId`, `txid?` |
| `guardian_locked` | `reason?` (`restart`\|`manual`\|`remote`\|`tamper`); `remote` = `guardian.lock` from the phone |
| `wallet_adopted` | `walletId`, `previousWalletId`, `recoveryId`, `hardwareConfirmRequired` (see "Wallet rotation") |
| `sp_received` | `txid`, `vout`, `valueSats`, `height`, `label?`: the silent payment scanner found a payment in a new block (see "Silent payments"); `sp.scan` has its tweak |
| `relays_changed` | `relays` (`RelayList`): the guardian moved to these relays (its web UI). Sent to the paired phone (and phones with recovery access) over the old and the new relays. See section 5, "Changing relays" |
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

Also drop a wrap *event id* seen before (the same event arrives from several relays).

### Retries and idempotency

If no response arrives, the phone MAY re-send the same request: same `id`, same rumor `created_at` and `expiration`, in a new gift wrap. The guardian runs a request's handler **at most once** per `(sender, id)`. On a duplicate it re-sends the response it computed the first time (it keeps recent responses), or does nothing if the handler is still running. A response is matched to its call by `id`; responses with an unknown `id` are ignored.

A phone that restarts while a request is unanswered can re-send it with the same `id` once it is subscribed again. The relays may then replay the guardian's original answer (it is stored until the wrap's expiration, which is later than the rumor's), which the phone receives before it re-sends; the reference client keeps recent answers that matched no call and resolves a call that re-uses their `id` with them (its replay guard would otherwise drop the fresh answer for that `id` as a duplicate).

For state-changing methods (`guardian.unlock`, `guardian.lock`, `pair`, `policy.update`, `recovery.start`, `recovery.cancel`, `phone.resume`, `hardware.confirm`, `wallet.retire`, `wallet.unwatch`, `singlekey.register`, `sp.register`, `sp.unregister`) the guardian remembers handled ids **across restarts** (`relays.ack` is not among them: running it twice changes nothing). A retry of a request it handled before restarting gets `1501 Unavailable` instead of running again, because its cached response was lost. The phone should then check the state (`guardian.status`, `recovery.status`, `policy.get`) and, if needed, send a new request with a new `id`.

## 5. Relays

* The relay list comes from the pairing URI (and can change later, below). Both sides use the same list; publish to all, subscribe on all.
* A relay must accept kind 1059 and honour `#p` filters. Relays that implement NIP-40 will purge wraps at their (randomised, later) wrap expiration; see "Wrap timestamps".
* PSBT messages are large after two layers of base64 (roughly 1.8x the PSBT's base64 size); choose relays that accept events of a few hundred KB.
* A hostile relay can drop, delay or replay events. It cannot read or alter them (altered ciphertext fails the MAC; a re-signed wrap fails to decrypt) and replays are caught by section 4.

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

For a new phone without the old one or its backup, the guardian's web UI shows a second, permanent QR code with only where to find the guardian:

```
trikey://recover?v=1&npub=<npub1...>&relay=<url>[&relay=<url>...]&net=<bitcoin|testnet|signet|regtest>[&label=<text>][&wallet=<walletId>]
```

It carries **no secret and no expiry**: the npub and relays are not secret, and what admits the phone is the hardware wallet's `recovery.access` signature (section 3, "Recovery access"), not this code. `relay` and `label` follow the pairing rules; `net` tells the phone which network to create its wallet on. A decoder MUST refuse a recovery code that carries a `secret`, and the two codes are never interchangeable (`decodeRecoveryUri` refuses a pairing code and vice versa; `decodeTrikeyUri` tells them apart). `wallet` (optional; older guardians omit it) is the wallet id the guardian guards, for the version-2 `recovery.access` text.

## 7. Compatibility notes

* Add new methods or optional result members freely; never change the meaning of an existing error code or field. A breaking envelope change bumps the `trikey` tag value.
* A new alert `type` is dropped by phones that do not know it (the alert schema is a closed union, and a malformed message is dropped silently, section 4), and a new method is answered `-32601` by guardians that do not know it. So a new alert may only add something an older phone can do without (`relays_changed`: an older phone keeps the old relays, which the guardian watches until its owner stops them), and a phone sends a new method only to a guardian that showed it knows it.
* Hardware approvals are an `approval` object with a `kind`. Only `bip137` exists. If the project settles on a PSBT-based approval (see DESIGN.md, open question 1), it will be a new `kind`, not a change to `bip137`.
* The policy is deliberately closed: a new rule means a new engine rule first, then a new `Policy` member and a new `policyHash` input (which changes every hash, so it needs a protocol version bump).
