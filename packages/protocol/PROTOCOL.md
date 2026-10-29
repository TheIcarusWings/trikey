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

All objects are strict (unknown members are rejected), except `policy` objects, which keep unknown members.

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

### Methods

`Hex32` = 64 lowercase hex chars. `UnixSeconds` = integer. `KeyOrigin` = `{ fingerprint: 8 hex, path: "m/48'/0'/0'/2'", xpub: string }`.

| Method | Params | Result |
|---|---|---|
| `pair` | `pairingSecret`, `deviceName` (1-64), `network` (`bitcoin`\|`testnet`\|`signet`\|`regtest`), `phoneKey: KeyOrigin`, `descriptor?` | `guardianKey: KeyOrigin`, `descriptor?`, `guardianVersion` |
| `sign` | `psbt`, `memo?` | `psbt` (with the guardian's partial signatures) |
| `policy.get` | `{}` | `policy`, `sequence`, `policyHash` |
| `policy.update` | `policy`, `approval?` | `policy`, `sequence`, `policyHash` |
| `recovery.start` | `sweepPsbt`, `newDescriptor` | `recovery` |
| `recovery.cancel` | `recoveryId` | `recovery` |
| `recovery.status` | `recoveryId?` (default: the active one) | `recovery` (or `null`), `psbt?` (the signed sweep, once `ready`) |
| `guardian.unlock` | `{kind:"passphrase", passphrase}` or `{kind:"hardware", secret: hex}` | `unlocked: boolean` |
| `guardian.status` | `{}` | `state` (`locked`\|`unlocked`), `paired`, `policySequence`, `activeRecoveryId`, `version`, `time` |

**Policy** (`dailyLimitSats`, `recoveryDelayDays`, `perTxLimitSats?`, `allowlist?`; unknown members preserved). `policyHash` = hex SHA-256 of the *canonical JSON* of the policy: object keys sorted by UTF-16 code unit, no whitespace, `undefined` members dropped, finite numbers only.

**Hardware approval** for `policy.update`: `{ signature, address, sequence, expiresAt }`. `signature` is a BIP 137 signature (base64, 65 bytes, header 27-42) by the hardware wallet's pairing-time single-sig address over the ASCII text

```
trikey-policy-v1:<policyHash>:<sequence>:<expiresAt>
```

`sequence` must be greater than the guardian's current one and `expiresAt` in the future. (The guardian decides which changes need an approval; tightening may not.)

**Recovery** object: `{ recoveryId, state: pending|ready|cancelled|completed, startedAt, executeAfter, newDescriptor, sweepPsbtHash, completedAt?, cancelledAt? }`.

### Alerts

`params` is `{ type, at, message? , ...}` with `type` one of:

| `type` | extra members |
|---|---|
| `recovery_started` | `recoveryId`, `executeAfter` |
| `daily_reminder` | `recoveryId`, `executeAfter`, `daysRemaining` |
| `recovery_cancelled` | `recoveryId`, `cancelledBy?` (`phone`\|`hardware`\|`guardian`\|`contact`) |
| `recovery_completed` | `recoveryId`, `txid?` |
| `guardian_locked` | `reason?` (`restart`\|`manual`\|`tamper`) |

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
| 1100 | GuardianLocked | unlock it first |
| 1101 | UnlockFailed | |
| 1200 | PolicyViolation | a limit or rule forbids this |
| 1201 | ApprovalRequired | the change needs hardware approval |
| 1202 | ApprovalInvalid | bad signature or message mismatch |
| 1203 | ApprovalExpired | |
| 1204 | StaleSequence | |
| 1300 | RecoveryNotFound | |
| 1301 | RecoveryAlreadyActive | |
| 1302 | RecoveryNotActive | |
| 1400 | PsbtInvalid | |
| 1401 | PsbtRejected | |
| 1500 | RateLimited | |
| 1501 | Unavailable | try again later |

## 4. Validation, expiry and replay

A receiver MUST, in this order, silently drop (no reply, so nothing can be probed) any event that fails:

1. **Wrap:** kind 1059, correct `id` and signature (recompute from the fields; do not trust a cached "verified" flag), a `p` tag with its own pubkey, content at most 400,000 chars.
2. **Decryption:** NIP-44 wrap -> seal (kind 13, valid signature) -> rumor; `rumor.pubkey == seal.pubkey`; rumor `id` correct.
3. **Peer:** the seal's author is the expected peer. The phone expects exactly the guardian. The guardian accepts its paired phones, and any sender only for `pair`.
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

The phone scans it, derives its key, and sends `pair` to the guardian's `npub` on those relays. The guardian accepts a `pair` from an unknown pubkey only if `pairingSecret` matches the live, unused secret (constant-time comparison; one attempt budget per code is advisable), then adds the sender to its peers and burns the secret. `pair` carries the phone's key origin (key 2 of the 2-of-3) and optionally a descriptor proposal; the result carries the guardian's key origin (key 3).

## 7. Compatibility notes

* Add new methods or optional result members freely; never change the meaning of an existing error code or field. A breaking envelope change bumps the `trikey` tag value.
* The `policy.update` approval text (`trikey-policy-v1:...`) is the current candidate for the hardware wallet authorization (see DESIGN.md, open question 1). If the project settles on a PSBT-based approval instead, it will be a new `approval` variant, not a change to this one.
