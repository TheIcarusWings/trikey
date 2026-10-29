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
* **Seal** and **wrap** are exactly as in NIP-59 (NIP-44 v2 encryption; the wrap is encrypted with the throwaway key's conversation key with the recipient). Their `created_at` is randomised up to 2 days into the past, as NIP-59 recommends.
* **Wrap tags:** `["p", <recipient pubkey>]` and `["expiration", <unix seconds>]` (same value as the rumor's, so relays can purge it).
* The wrap is the only thing published. Publish it to every relay in the shared relay list; a message needs to reach just one.
* **Subscribing:** `{"kinds":[1059], "#p":[<own pubkey>], "since": now - 2 days - 10 min}`. The look-back is needed because wrap timestamps are back-dated; staleness is judged on the rumor (section 4), never on the wrap.
* **Implementation note (reference code).** The seal layer is encrypted with the conversation key of the two static keys, which never change between a phone and its guardian, so `@trikey/protocol` caches it per (secret key, peer) (`ConversationKeyCache`); only the wrap layer's ECDH with the throwaway key is done per message. The guardian opens each incoming wrap once (`openGiftWrap`) and routes the rumor by kind: 21420 to the RPC server, 14 (NIP-17 DMs from alert contacts) to the DM handler. Neither changes anything on the wire.

### Rumor tags

| Tag | Required | Meaning |
|---|---|---|
| `["p", <recipient>]` | yes, exactly one | must equal the receiving pubkey |
| `["trikey", "1"]` | yes, exactly one | protocol version; anything else is rejected |
| `["expiration", <unix seconds>]` | yes, exactly one | NIP-40 expiry; the message is void from this second on |
| `["psbt", <hex sha256>]` | iff the message carries a PSBT | sha256 of the *decoded* PSBT bytes; see below |

The rumor `content` is the JSON message (section 3), at most 200,000 characters. The rumor `id` must be correct and `rumor.pubkey` must equal `seal.pubkey`.

**PSBT hash rule.** A message carries a PSBT when it is a `sign` request (`params.psbt`), a `recovery.start` request (`params.sweepPsbt`), or a success response whose `result.psbt` is a string. Such a message MUST have a `psbt` tag equal to the lowercase-hex SHA-256 of the base64-decoded PSBT, and a message without a PSBT MUST NOT have one. At most one PSBT per message.

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

### Methods

`Hex32` = 64 lowercase hex chars. `Sats` = integer 0..2,100,000,000,000,000 (exact as a JSON number). `UnixSeconds` = integer. `KeyOrigin` = `{ fingerprint: 8 hex, path: "m/48'/0'/0'/2'", xpub: string }`. `WalletId` = 16 lowercase hex chars (the engine's `MultisigWallet.fingerprint()`). `RecoveryId` = `[0-9a-z-]{1,40}`. `HardwareApproval`, `Policy` and `Recovery` are defined below.

| Method | Params | Result |
|---|---|---|
| `pair.prepare` | `pairingSecret`, `network` | `guardianKey: KeyOrigin`, `guardianVersion` |
| `pair` | `pairingSecret`, `deviceName` (1-64), `network` (`bitcoin`\|`testnet`\|`signet`\|`regtest`), `phoneKey: KeyOrigin`, `descriptor`, `phoneNostrPubkey: Hex32`, `hardwareAuth: { pubkey, path }`, `hardwareAuthProof`, `rules: Policy`, `replacesWalletId?: WalletId` | `guardianKey: KeyOrigin`, `descriptor`, `walletId`, `guardianVersion` |
| `sign` | `psbt`, `memo?` | `psbt` (with the guardian's partial signatures) |
| `policy.get` | `{}` | `policy`, `nextHardwareSequence`, `policyHash` |
| `policy.update` | `policy`, `approval?` | `policy`, `nextHardwareSequence`, `policyHash` |
| `recovery.start` | `sweepPsbt`, `newDescriptor` | `recovery` |
| `recovery.cancel` | `recoveryId`, `approval?` | `recovery`, `contested: boolean` |
| `recovery.status` | `recoveryId?` (default: the active one) | `recovery` (or `null`), `psbt?` (the signed sweep, once the guardian has co-signed it) |
| `phone.resume` | `approval` | `phoneSpending: "enabled"` |
| `guardian.unlock` | `{kind:"passphrase", passphrase}` or `{kind:"hardware", secret: hex}` | `unlocked: boolean` |
| `guardian.status` | `{}` | `state` (`locked`\|`unlocked`), `paired`, `nextHardwareSequence`, `phoneSpending` (`enabled`\|`paused_recovery`\|`paused_contested`\|`retired`), `activeRecoveryId`, `version`, `time`, `dailyLimit?: { limitSats, usedSats, availableSats }`, `walletId?`, `hardwareConfirmRequired?` |
| `guardian.lock` | `{}` | `state: "locked"` (see "Locking from the phone") |
| `wallet.sync` | `historyLimit?` (1-500, default 100) | `tipHeight`, `tipHash`, `utxos`, `utxosTruncated`, `balance: { confirmedSats, unconfirmedSats }`, `history`, `historyTruncated`, `nextReceiveIndex`, `nextChangeIndex`, `gapLimit` (see "Chain data") |
| `tx.get` | `txid: Hex32`, `witness?: boolean` (default `true`) | `txHex` |
| `tx.broadcast` | `txHex` | `txid` |
| `fees.estimate` | `targets?` (1-8 block targets, 1-1008; default `[1, 3, 6, 144]`) | `estimates: [{ target, satPerVb \| null }]`, `minRelaySatPerVb` |
| `recovery.access` | `approval: { kind: "bip137", expiresAt, signature }` | `descriptor`, `walletId`, `network`, `guardianKey`, `hardwareAuth`, `policy`, `nextHardwareSequence`, `phoneSpending`, `activeRecoveryId`, `accessExpiresAt` (see "Recovery access") |
| `hardware.confirm` | `hardwareAuth: { pubkey, path }`, `hardwareAuthProof` | `walletId`, `hardwareAuth`, `nextHardwareSequence` (see "Wallet rotation") |
| `wallet.retire` | `approval` (of `retire-wallet`) | `walletId`, `retiredAt` (see "Replacing the guardian") |

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
| recovery access | `Trikey recovery-access v1 guardian=<guardian nostr pubkey hex> phone=<new phone's nostr pubkey hex> expires=<ISO>` (no wallet id and no sequence: see "Recovery access") |

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

1. **`pair.prepare`** `{ pairingSecret, network }` returns the guardian's key (key 3). The phone needs it first: the pairing proof signs the wallet id and the guardian's account pubkey, and the wallet id is the fingerprint of the full descriptor, which contains that key. It does not use up the secret.
2. The phone builds `wsh(sortedmulti(2, <phone>, <hardware>, <guardian>))` (keys in that order), computes `walletId` and the guardian's raw account pubkey (the public key inside `guardianKey.xpub`), has the hardware wallet BIP 137-sign `pairingMessage(walletId, cosignerAccountPubkey)` with a single-sig key it will use for all later approvals, and sends **`pair`**:
   * `descriptor`, `phoneKey`, `network`: the wallet;
   * `phoneNostrPubkey`: the phone's nostr key, which MUST equal the authenticated sender; it receives alerts and may cancel recoveries;
   * `hardwareAuth: { pubkey, path }`: the compressed pubkey (33 bytes hex) of the authorization key and the path the device signs with;
   * `hardwareAuthProof`: the BIP 137 signature (base64) over the pairing text;
   * `rules`: the initial policy.

   The guardian checks the descriptor, that the three keys are distinct and that the guardian key sits in its slot, the rules, the key (and, when the path lies under the hardware xpub, that it derives from it) and the proof. It then registers the wallet and burns the secret.

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
| `cancelledAt?`, `cancelledBy?`, `completedAt?` | `cancelledBy` is `app` \| `contact` \| `hardware` |

* **`recovery.start`**: the sweep PSBT must be signed on every input by **one** surviving key, either the phone's or the hardware wallet's. The guardian reads which from the signatures. `newDescriptor` must keep the surviving key and drop the other user key. The fee must not exceed `sweepFeeCapSats`. Alerts go to the paired phone and every alert contact.
* **`recovery.cancel`** may be sent by the paired phone or an alert contact (the guardian authenticates the sender's nostr key; it must let contacts through its peer check for this method) without `approval`, or with an `approval` of `cancel-recovery` for the hardware wallet. `contested` is true unless the canceller holds the key that started the recovery (the phone cancelling a phone-started recovery, or the hardware wallet cancelling a hardware-started one); a contested cancel pauses phone payments (`phoneSpending: paused_contested`) until `phone.resume`.
* **`phone.resume`** needs an approval of `resume-phone` and only works when phone payments are paused by a contested cancel and no recovery is running.
* **`recovery.status`**: the engine marks a recovery `completed` when it co-signs the sweep, not when the sweep confirms. `psbt` is that co-signed sweep; broadcasting it is up to the phone or the guardian service.

**Cancelling from a regular nostr app.** Alert contacts also get each recovery alert as a NIP-17 private DM (kind 14 rumor in a NIP-59 gift wrap), so they can read it in Damus, Amethyst or Primal. A contact cancels by replying to that DM with `CANCEL <recoveryId>` (case-insensitive, nothing else on the line); the guardian treats it like `recovery.cancel` from that contact. Alert contacts may call `recovery.cancel` and nothing else.

### Wallet rotation: the guardian adopts a recovery's destination wallet

A recovery sweeps the wallet to a new wallet that keeps the surviving key. When that new wallet also keeps **this guardian's key**, the guardian becomes its guardian; otherwise it just retires the old wallet. The guardian holds **one active wallet** and any number of **retired** ones (read-only history: it co-signs nothing for them, starts no recovery of them, and answers `1004 WalletRetired` when a request spends from one).

1. **When.** Not when the guardian co-signs the sweep, but once a node has **accepted the sweep** (the broadcast went through, or Electrs already knows the transaction). Confirmation is not awaited: after completion key 3 refuses everything for the swept wallet, so nobody but the user (the surviving key plus the lost one) could make a conflicting spend, and waiting for blocks would leave the recovered user without a guardian (no co-signing, no CPFP through the guardian) for no added safety.
2. **What carries over.** The rules (limit, delay, fee cap, contacts) and the hardware sequence counter. The 24 h limit window starts empty: phone payments were paused for the whole delay (at least 7 days), so nothing spent from the old wallet is still inside it.
3. **The paired phone** becomes the phone that sent `recovery.start` (the surviving phone, or the new phone that got in with `recovery.access`). It gets a `wallet_adopted` alert, and `guardian.status` shows the new `walletId`.
4. **The hardware authorization key** is re-established for the new wallet's hardware key: when the hardware wallet survived, the same key; when it was replaced, the key at the same path relative to the new hardware xpub (when the old key's path lies below the hardware account by non-hardened steps; otherwise the guardian knows no key until the phone sends one). Either way it is **unconfirmed**, and every hardware approval (policy loosening, hardware cancel, `phone.resume`, `wallet.retire`) is refused with `1209` until **`hardware.confirm`**: the paired phone sends `hardwareAuth` and a fresh BIP 137 `hardwareAuthProof` over `pairingMessage(newWalletId, cosignerAccountPubkey)`, exactly as at pairing. The key must be the expected one (and, below the hardware xpub, derive from it). Co-signing within the limit and tightening the rules work meanwhile. Sending `hardware.confirm` again for a confirmed wallet with the same key and a valid proof is a no-op.
5. **Recovery access** grants (`recovery.access`) belonged to the old wallet and are revoked.

### Replacing the guardian

When the box dies or is replaced, the phone and the hardware wallet move the funds to a new wallet whose third key is the **new** guardian's (that sweep needs no guardian).

* **Old guardian still alive:** the paired phone sends **`wallet.retire`** with a hardware approval of `retire-wallet` (stale sequence `1204`, bad signature `1202`, a running recovery `1301`). The wallet is retired: from then on every co-sign is refused, the old phone is no longer a peer, and pairing is open again for a new wallet (the web UI can make a pairing code). The same descriptor can never be paired again on that guardian (`1004`). The phone gets a `wallet_retired` alert too.
* **Old guardian gone:** nothing to do on its side. A fresh guardian pairs the phone like any other (section 6): the phone builds a new descriptor with its existing key 2, the existing hardware key and the new guardian's key from `pair.prepare`, so the wallet id, the pairing proof and every later approval are new. `replacesWalletId` names the old wallet for the guardian's log; nothing else is different.

### Locking from the phone

**`guardian.lock`** drops key 3 from the guardian's memory, as the web UI's Lock button does, for when the user thinks the box was physically compromised. Only the paired phone may send it (anyone else is dropped without an answer, section 4). It needs no approval because it only reduces what the guardian can do, and it is answered `{ state: "locked" }` even when the guardian already was. The phone (and the web UI) see a `guardian_locked` alert with `reason: "remote"`. Unlocking is unchanged: `guardian.unlock` or the web UI.

### Chain data

The guardian already has the wallet's descriptor and the user's own Electrs, so it serves the paired phone's chain data and broadcasts for it: the phone never asks a public server. `wallet.sync`, `tx.get`, `tx.broadcast` and `fees.estimate` need no key 3, so they **work while the guardian is locked**. Only the paired phone may call them (plus, for the reads, a phone with recovery access); requests from anyone else are dropped without an answer like every other unauthorized request. Amounts are `Sats` (JSON numbers); heights are 0 while unconfirmed.

* **`wallet.sync`** scans both chains of the descriptor (receive `0`, change `1`) the way the guardian checks recovery coverage: until `gapLimit` (20) consecutive addresses have no history.
  * `utxos`: `{ txid, vout, valueSats, height, confirmations, chain, index }`, every unspent output, confirmed ones first by value, at most 500 (`utxosTruncated` says there are more; `balance` always counts all of them). `chain`/`index` are the derivation steps below the account keys, which the phone needs to build the PSBT input.
  * `history`: `{ txid, height, confirmations, time?, netSats, feeSats? }`, newest first (unconfirmed, then by height), at most `historyLimit` (`historyTruncated`). `netSats` is what the transaction did to the wallet's balance: received minus spent, fee included, negative for payments. `feeSats` is present when every input belongs to the wallet (otherwise the guardian does not know all input amounts). `time` is the block's timestamp.
  * `nextReceiveIndex` / `nextChangeIndex`: the first index with no history on each chain. The phone receives at `nextReceiveIndex` and sends change to `nextChangeIndex`.
* **`tx.get`** returns a raw transaction (for PSBT `nonWitnessUtxo`) after checking it hashes to `txid`, so a confused Electrs cannot hand the phone a different transaction. With `witness: false` it is the serialization without witness data: same txid, all `nonWitnessUtxo` needs, and much smaller. Unknown: `1600 TxNotFound`. At most 150,000 hex characters, else `1603 TxTooLarge`.
* **`tx.broadcast`** relays a fully signed raw transaction, but **only one that spends at least one output paying one of the wallet's addresses** (within the scanned range), so the guardian is not an open relay. Otherwise `1602 ForeignTransaction`. A transaction that does not parse is `-32602`; one the node refuses (double spend, too low a fee, bad signature) is `1601 BroadcastRejected` with the node's reason in `message` and `data.reason`. The result is the txid the guardian computed.
* **`fees.estimate`** asks the node (`blockchain.estimatefee`) per target and converts BTC/kvB to sat/vB; `satPerVb` is `null` where the node has no estimate (usual on regtest and signet, and right after a restart). `minRelaySatPerVb` is the node's relay fee floor.
* Electrs unreachable or not synced: `1501 Unavailable`; try again later.

The phone keeps its own "spent today" estimate for showing the remaining limit and choosing the signing path, but the guardian's count is the truth: `guardian.status.dailyLimit`, and `data` of an `over_daily_limit` refusal (`limit`, `used`, `outflow`, `wouldUse`).

### Recovery access

"Lost phone, no backup": the user has a new phone, the hardware wallet and the guardian. The new phone has a fresh nostr key that the guardian does not know, and it knows neither the descriptor nor the guardian's key, only the guardian's `npub` and relays (the web UI's "Recover on a new phone" code, section 6). `recovery.access` lets the hardware wallet vouch for it:

1. The phone asks the device for the authorization key (the same path the wallet used at pairing; it is derived the same way on every phone, see the guardian README) and has it BIP 137-sign `recoveryAccessMessage({ guardianPubkey, phonePubkey, expiresAt })`, with `expiresAt` at most 24 h ahead.
2. **`recovery.access`** from any sender, once a wallet is paired. The guardian rebuilds the text with *its own* nostr key and the *sender's* key, so the signature is no use to another phone or against another guardian, and verifies it against the paired `hardwareAuth`. Wrong signature `1202`, expired `1203`, too far ahead `1206`. It does not consume a hardware sequence number.
3. The sender may then, until `accessExpiresAt` (durably, across guardian restarts), call `guardian.status`, `wallet.sync`, `tx.get`, `fees.estimate`, `recovery.start`, `recovery.status`, `recovery.cancel` (only with a hardware approval) and `recovery.access` again. Not `sign`, `policy.*`, `tx.broadcast`, `phone.resume` or `guardian.unlock`. The result gives the phone everything it needs to sweep: the descriptor, the wallet id, the guardian's key and the rules (for the sweep fee cap).

Anyone holding the hardware wallet can thus start a recovery from any phone, which is the design: a recovery is announced to the paired phone and every alert contact, and any of them can cancel it (DESIGN.md, threat model). The web UI's activity log shows every access grant. While its access lasts, a phone with recovery access also gets the protocol alerts (best effort; it is not one of the recovery's recorded recipients), and it can poll `recovery.status`.

### Alerts

`params` is `{ type, at, message? , ...}` (`at` in unix seconds) with `type` one of the engine's alert kinds (`AlertKind`), plus `guardian_locked`, which the service raises itself:

| `type` | extra members |
|---|---|
| `recovery_started` | `recoveryId`, `readyAt`, `survivingRole`, `amountSats` |
| `recovery_reminder` | the same, plus `daysLeft` (whole days until `readyAt`). Sent every 24 h; after downtime only the latest one |
| `recovery_ready` | `recoveryId`, `readyAt`, `survivingRole`, `amountSats` (the delay has elapsed) |
| `recovery_cancelled` | `recoveryId`, `cancelledBy` (`app`\|`contact`\|`hardware`), `contested?` |
| `recovery_completed` | `recoveryId`, `txid?` |
| `guardian_locked` | `reason?` (`restart`\|`manual`\|`remote`\|`tamper`); `remote` = `guardian.lock` from the phone |
| `wallet_adopted` | `walletId`, `previousWalletId`, `recoveryId`, `hardwareConfirmRequired` (see "Wallet rotation") |
| `wallet_retired` | `walletId`, `reason` (`retired`\|`recovered`\|`reset`), `successorWalletId?` |

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
| 1602 | ForeignTransaction | `tx.broadcast` of a transaction that spends none of the wallet's coins |
| 1603 | TxTooLarge | `tx.get` of a transaction longer than 150,000 hex characters (`witness: false` may fit) |

### Engine refusals to error codes

The guardian service maps the engine's `Refusal.reason` to an error code and puts the refusal (without secrets) in `data`:

| Engine refusal | Code |
|---|---|
| `guardian_locked` | 1100 |
| `not_registered`, `not_authorized` | 1001 |
| `already_registered` | 1003 |
| `invalid_registration`, `invalid_rules` | -32602 (InvalidParams) |
| `over_daily_limit`, `not_signed_by_app`, `signature_count`, `hardware_signed_outside_recovery`, `sweep_fee_exceeds_cap`, `delay_not_elapsed`, `recovery_signers`, `invalid_destination`, `destination_drops_surviving_key`, `destination_keeps_lost_key`, `sweep_not_to_destination` | 1200 |
| `hardware_approval_required` | 1201 |
| `approval_invalid_signature`, `unsupported_approval` | 1202 |
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
| `invalid_psbt`, `foreign_input`, `missing_non_witness_utxo`, `non_witness_utxo_mismatch`, `invalid_signature` | 1400 |

## 4. Validation, expiry and replay

A receiver MUST, in this order, silently drop (no reply, so nothing can be probed) any event that fails:

1. **Wrap:** kind 1059, correct `id` and signature (recompute from the fields; do not trust a cached "verified" flag), a `p` tag with its own pubkey, content at most 400,000 chars.
2. **Decryption:** NIP-44 wrap -> seal (kind 13, valid signature) -> rumor; `rumor.pubkey == seal.pubkey`; rumor `id` correct.
3. **Peer:** the seal's author is the expected peer. The phone expects exactly the guardian. The guardian accepts its paired phones, alert contacts for `recovery.cancel`, phones holding recovery access for the recovery methods, and any sender only for `pair.prepare` / `pair` (around a pairing session) and `recovery.access`.
4. **Envelope:** rumor kind 21420, tags as in section 2, JSON valid against the schemas, PSBT hash matches.
5. **Time**, using the rumor's `created_at` and `expiration` and the receiver's clock:

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

A phone that restarts while a request is unanswered can re-send it with the same `id` once it is subscribed again. The relays may then replay the guardian's original answer (it is stored until its expiration), which the phone receives before it re-sends; the reference client keeps recent answers that matched no call and resolves a call that re-uses their `id` with them (its replay guard would otherwise drop the fresh answer for that `id` as a duplicate).

For state-changing methods (`guardian.unlock`, `guardian.lock`, `pair`, `policy.update`, `recovery.start`, `recovery.cancel`, `phone.resume`, `hardware.confirm`, `wallet.retire`) the guardian remembers handled ids **across restarts**. A retry of a request it handled before restarting gets `1501 Unavailable` instead of running again, because its cached response was lost. The phone should then check the state (`guardian.status`, `recovery.status`, `policy.get`) and, if needed, send a new request with a new `id`.

## 5. Relays

* The relay list comes from the pairing URI. Both sides use the same list; publish to all, subscribe on all.
* A relay must accept kind 1059 and honour `#p` filters. Relays that implement NIP-40 will purge wraps at their expiration.
* PSBT messages are large after two layers of base64 (roughly 1.8x the PSBT's base64 size); choose relays that accept events of a few hundred KB.
* A hostile relay can drop, delay or replay events. It cannot read or alter them (altered ciphertext fails the MAC; a re-signed wrap fails to decrypt) and replays are caught by section 4.

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
trikey://recover?v=1&npub=<npub1...>&relay=<url>[&relay=<url>...]&net=<bitcoin|testnet|signet|regtest>[&label=<text>]
```

It carries **no secret and no expiry**: the npub and relays are not secret, and what admits the phone is the hardware wallet's `recovery.access` signature (section 3, "Recovery access"), not this code. `relay` and `label` follow the pairing rules; `net` tells the phone which network to create its wallet on. A decoder MUST refuse a recovery code that carries a `secret`, and the two codes are never interchangeable (`decodeRecoveryUri` refuses a pairing code and vice versa; `decodeTrikeyUri` tells them apart).

## 7. Compatibility notes

* Add new methods or optional result members freely; never change the meaning of an existing error code or field. A breaking envelope change bumps the `trikey` tag value.
* Hardware approvals are an `approval` object with a `kind`. Only `bip137` exists. If the project settles on a PSBT-based approval (see DESIGN.md, open question 1), it will be a new `kind`, not a change to `bip137`.
* The policy is deliberately closed: a new rule means a new engine rule first, then a new `Policy` member and a new `policyHash` input (which changes every hash, so it needs a protocol version bump).
