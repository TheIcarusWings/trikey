# Security review brief

Status: a starting point for anyone reviewing Trikey's security. It was written for review firms, but there is no
budget for a paid review (DESIGN.md, "MVP build order", step 4): independent reviewers, in any amount of depth, are
welcome, and so are reports from testers. Written 2026-11-01 against `main` at `791ff82` (0.1.7-alpha). It is documentation only and changes
no code. Every statement points at the file or section it comes from; anything we have not checked ourselves is
marked **to confirm**.

## 1. What Trikey is

Trikey is an open-source (MIT) 2-of-3 bitcoin wallet in which every key belongs to the user. Key 1 is any hardware
wallet, key 2 lives in a React Native phone app, and key 3 is the **Trikey Guardian**, a Docker app on the user's own
Umbrel (a Start9 package exists but is untested). The vault is a plain `wsh(sortedmulti(2, key1, key2, key3))` on
BIP 48 paths, so any multisig wallet can recover it without Trikey. The guardian co-signs phone-only payments under
a rolling 24-hour limit and runs Bitkey-style Delay & Notify recovery (7, 14 or 30 days) with alerts to the user's
alert contacts. Phone and guardian talk only through nostr relays (NIP-44 inside NIP-59 gift wraps), so the
guardian opens no inbound port to the internet. A second mode, **Recovery Key mode**, needs no home server: key 3 is
a printed Recovery Kit or a second hardware wallet, and the phone spends from a small single-key balance refilled by
a chain of pre-signed, BIP 68-timelocked transactions (DESIGN.md, "Recovery Key mode"). The project is pre-alpha:
test networks, plus mainnet in guardian mode behind a warning (README.md, SECURITY.md).

### Security goals by scenario

These are the goals the design claims. We want the review to tell us where the code does not meet them.

| Scenario | Goal (one sentence) | Source |
|---|---|---|
| Stolen phone, unlocked | The thief can spend at most the daily limit per 24 h, cannot raise it, cannot hide coins past the gap limit, and any recovery they start is announced to every alert contact. | DESIGN.md threat model "Stolen phone"; rules 3, 4, 5 |
| Stolen phone, limit turned off | Accepted: the thief sends everything at once; the alerts arrive afterwards. | Rule 3 (last bullet); docs/design/savings-and-limit-off.md §4 |
| Stolen phone, no key 2 backup | The vault is frozen, not lost: phone and hardware wallet can cancel each other's recoveries, nobody can take the funds. | Threat model "Contested recovery stalemate" |
| Lost phone with backup | Key 2 is restored from the encrypted backup (recovery code or passkey), with no waiting. | "Recovery flows" table |
| Lost phone, no backup | Hardware wallet + guardian sweep to a new wallet after Delay & Notify; the new phone gets in only with a hardware-signed `recovery.access`. | Rule 5; PROTOCOL.md "Recovery access" |
| Lost hardware wallet | Restore from seed words, or phone + guardian sweep after Delay & Notify. | "Recovery flows" |
| Stolen hardware wallet (with PIN) | Nothing alone; a recovery it starts is announced and cancellable. | savings-and-limit-off.md §5 |
| Compromised guardian or Umbrel (remote) | One key of three; it cannot spend alone, though it can refuse to sign and stay silent. | Threat model "Remote compromise"; savings-and-limit-off.md §5 |
| Guardian + phone together | Accepted: everything (no script rule stops two keys). | savings-and-limit-off.md introduction and §5 |
| Burglary (phone + home server) | An unplugged guardian is locked (one usable key); a powered one still gives only the daily limit, and recoveries alert for 7+ days. | Threat model "Burglary" |
| Guardian dead, stolen or replaced | Phone + hardware sweep to a new wallet ("Replace guardian"); a still-running old box can be retired so it co-signs nothing. | "Recovery flows"; rule 7; "Replace guardian" |
| Guardian reset by someone with the passphrase | A reset rotates key 3, so it can lose the guardian's help but never re-pair the user's wallet to a thief. | Threat model "Reset rotates key 3" |
| Malicious relay | Can drop, delay or replay events; cannot read or forge them; replays are dropped. | Threat model "Malicious relays"; PROTOCOL.md §4, §5 |
| Malicious alert contact | May call `recovery.cancel` and nothing else; a contested cancel pauses phone payments until the hardware wallet resumes them (a nuisance, not a theft). | PROTOCOL.md "Recovery" (`recovery.cancel`, "Cancelling from a regular nostr app"); rule 5.4 |
| Attacker controls the box's clock (NTP) | Cannot shorten a recovery delay or open a fresh limit window. | Threat model "The guardian's clock is not trusted alone"; rule 3; rule 5.5 |
| Web UI reached by another container or page | Every `/api` call needs a session opened with the passphrase, except reduced status and first-run setup. | Threat model "The web UI has its own sessions" |
| Recovery Key mode, stolen phone | The spending balance plus at most one refill per 1,008 blocks until the owner sweeps. | "Recovery Key mode", "The trade-offs" |
| Recovery Key mode, kit found | Nothing alone; kit + seed words take everything with no undo window. | Same |

## 2. Scope proposal

### Size

Non-test TypeScript, counted at `791ff82` with
`find packages apps e2e tools packaging -type f \( -name '*.ts' -o -name '*.tsx' \) -not -path '*/node_modules/*' -not -path '*/test/*' -not -path '*/__tests__/*' -not -name '*.test.ts' -not -name '*.test.tsx' -not -name '*.d.ts' -exec wc -l {} +`
(lines include comments, which are dense in this code base).

| Path | Files | Lines | Notes |
|---|---:|---:|---|
| `packages/core/src` | 10 | 1,525 | descriptors, BIP 48 wallet, PSBT build/analyze, RNG and its health test, BIP 89 tweaks, timelocks |
| `packages/protocol/src` | 14 | 3,524 | nostr RPC, schemas (1,076), transport, envelope, pairing URIs, approval texts; `dev/relay.ts` (206) is a test relay |
| `packages/wallet/src` | 15 | 7,755 | phone logic; `wallet.ts` alone is 4,755; `testing/` (288) is test support |
| `packages/recovery-key/src` | 20 | 4,865 | Recovery Key mode; `testing/` (529) is test support |
| `packages/silent-payments/src` | 10 | 1,043 | BIP 352 |
| `apps/guardian/src` | 48 | 11,377 | `policy/` 3,018, `nostr/` 1,331, `http/` 1,318, `chain/` 1,253, `silent/` 906, top level 3,551 (`guardian.ts` 1,168, `keystore.ts` 555, `recovery-runner.ts` 358) |
| `apps/guardian-web/src` | 50 | 4,754 | React UI; `api/mock.ts` (486) is the dev mock |
| `apps/mobile/src` | 150 | 16,695 | `data/` 7,148 (`real.ts` 1,596, `rk-service.ts` 1,353, `mock.ts` 761), `components/` 3,725, `hardware/` 3,205, `platform/` 1,955, `lib/` 554 |
| `apps/mobile/app` | 57 | 6,485 | Expo Router screens |
| `e2e/src`, `e2e/scripts` | 12 | 1,072 | regtest harness |
| `packaging/start9/startos` | 19 | 576 | Start9 wrapper (untested) |
| `tools/consensus-verify/src` | 1 | 98 | Rust, libbitcoinconsensus wrapper (test tool) |
| **Total** (with a few config files) | 412 | 59,836 | |

Rough split: the must-review items below touch about 25,000 to 30,000 of these lines; most of `apps/mobile/app`,
`apps/mobile/src/components` and `apps/guardian-web/src` is UI.

### 2a. Must review

**1. Guardian policy engine.** The rules that make key 3 more than a second signature.

- Where: `apps/guardian/src/policy/` (`engine.ts` 1,581, `inspect.ts`, `limit.ts`, `rules.ts`, `authorizer.ts`,
  `bip137.ts`, `clock.ts`, `storage.ts`, `types.ts`), `apps/guardian/src/recovery-runner.ts`,
  `apps/guardian/src/guardian.ts`, `service-state.ts`, `singlekey.ts`, `rate-limit.ts`, `unlock-throttle.ts`.
  About 5,500 lines. Spec: DESIGN.md "Rules the guardian enforces" (rules 1-7), "Recovery flows", "Wallet
  rotation"; PROTOCOL.md §3 "Policy", "Hardware approvals", "Recovery", "Wallet rotation", "No daily limit".
- Key questions:
  - Can a holder of key 2 and the phone's nostr key get key 3 to co-sign more than the limit in any 24 h, by any
    sequence of requests (RBF replacements, replays, change past the high-water mark + 20, the silent-payment
    helper input, inputs at arbitrary BIP 89 tweaks, refusals that leave state behind)?
  - Is the outflow formula (`Σ vault inputs − Σ outputs to derived vault addresses`, `inspect.ts`,
    `core/src/psbt.ts`) right in every shape, and can an output be counted as change that a later scan would
    not find?
  - Approvals: is the text always rebuilt from the request and guardian state (never from the phone), are
    sequence (+1..+1000), 24 h expiry, wallet binding, high-S refusal and the auth-key derivation check
    (`authKeyMismatch`) enforced on every path, including `hardware.confirm` after a rotation and the v1/v2 policy
    texts (`limit=off`)? Is "tighten without hardware" exactly lower-limit / longer-delay?
  - Delay & Notify: can a recovery complete before the delay on all three clocks (system clock, median time past,
    block count), complete without alerts having been queued to every contact, sweep to a destination that drops
    the surviving key or keeps the lost one, or exceed the fee cap? Are `recovery.update`, contested cancel,
    `phone.resume`, superseded recoveries and dead sweeps sound?
  - Clock and chain time: `clock_ahead_of_chain` (3 h), the persisted monotonic window time, `chain_unavailable`.
    What can a lying Electrs do to these checks?
  - Retired wallets and rotation: can a retired key set be co-signed, recovered, re-paired or swept to under any
    descriptor (rule 7)? Does adoption carry over only what PROTOCOL.md "Wallet rotation" lists (limit back on,
    access grants revoked)?
  - Limit off: refused at pairing and during a recovery, alert to every contact, back on after a recovery.
  - Do the fixes and regression tests of the October 2026 guardian review (`SECURITY-REVIEW.md`,
    `apps/guardian/test/security/`) hold, and did they introduce new issues?

**2. Key generation and entropy.**

- Where: `packages/core/src/random.ts` (276), `random-health.ts` (299); `apps/guardian/src/keystore.ts`
  (`generateSeed`, `trikey/guardian-seed/v1`, `trikey/key3/v1`), `pin-random.ts`, `rng-check.ts`, `identity.ts`;
  `apps/guardian-web/src/lib/random.ts`; `packages/wallet/src/keys.ts`, `packages/recovery-key/src/keys.ts`;
  `apps/mobile/src/platform/polyfills.ts`, `polyfill-install.ts`, `rng-startup.ts`, `self-test.ts`,
  `apps/mobile/src/hardware/common/random.native.ts`; the lint in `packages/core/test/randomness-lint.test.ts`.
  About 2,000 lines. Spec: DESIGN.md "Entropy"; `docs/security/entropy-review.md`.
- Key questions: Is every key and secret drawn through `secureRandomBytes` on all three platforms, including inside
  dependencies we cannot lint (nostr-tools, Ledger DMK's `uuid`)? Are the two HMAC-SHA512 mixes (key = OS draw or
  guardian seed, tag, length-prefixed fields) sound, and are the claims in DESIGN.md about what they cover
  accurate? Can load order on the phone ever make `react-native-get-random-values` the source? Does the health
  test latch correctly?

**3. Phone ↔ guardian protocol.**

- Where: `packages/protocol/src` (`transport.ts`, `envelope.ts`, `server.ts`, `client.ts`, `schemas.ts`,
  `pairing.ts`, `approval.ts`, `policy.ts`, `identity.ts`, `relay-url.ts`, `pool.ts`); guardian side
  `apps/guardian/src/nostr/` (`handlers.ts` 804, `inbox.ts`, `wire.ts`, `dm.ts`), `apps/guardian/src/pairing.ts`,
  `dm-cancel.ts`; phone side in `packages/wallet/src/wallet.ts`. About 5,000 lines. Spec:
  `packages/protocol/PROTOCOL.md` (all of it).
- Key questions:
  - Gift wrap: are seal/wrap signatures, `rumor.pubkey == seal.pubkey`, the rumor id, tags and the PSBT hash tag
    checked before anything else, in the order of PROTOCOL.md §4? Is the `ConversationKeyCache` safe?
  - Replay: the in-memory guard (4,096 entries), the separate stranger cache, the persisted ids of state-changing
    methods across restarts, the 1 h / 7 day windows and clock skew. Can a relay replay anything that changes
    state, for example after a guardian restart?
  - Authorization matrix per method: paired phone, alert contacts (`recovery.cancel` only, including the NIP-17
    `CANCEL <id>` path), phones with recovery access (the listed subset), strangers (`pair.prepare`, `pair`,
    `recovery.access` only). Is any method reachable by a sender it should not be?
  - Pairing: 32-byte secret, constant-time compare, 5-minute TTL, attempt budget, `phoneNostrPubkey` equal to the
    sender, the descriptor and slot checks, `replacesDescriptor` watching. Is there a way to pair a wallet whose
    "hardware" key the attacker controls?
  - Relay changes (`PUT /api/relays`, `relays_changed`, `relays.ack`): can anyone but the paired guardian move the
    phone?
  - Metadata: what does a relay learn (npub, sizes, arrival times, IPs), and do the wrap timestamps hide send times
    as PROTOCOL.md "Wrap timestamps" claims?

**4. PSBT construction and what each signer checks.**

- Where: `packages/core/src/psbt.ts` (`buildSpend`, `buildSweep`, `analyzePsbt`, helper-input checks),
  `wallet.ts`, `descriptor.ts`, `tweak.ts`, `timelock.ts`; `apps/guardian/src/policy/inspect.ts`, `signer.ts`,
  `keystore.ts` (key 3 signing, RFC 6979, low-S); `packages/wallet/src/send.ts`, `silent.ts`, and the checks in
  `wallet.ts` around lines 4590-4680 (co-signed PSBT is the same transaction with valid signatures);
  `apps/mobile/src/hardware/common/psbt.ts`, `hardware/trezor/convert.ts`. About 2,500 lines.
- Key questions:
  - Key 3 signs inputs whose script matches `sortedmulti` of the account pubkeys plus tweaks the PSBT carries
    (BIP 89 `CCDT` proprietary fields, `readTweaks` in `psbt.ts`). Is accepting requester-chosen tweaks safe for
    signing (no related-key or cross-input misuse) and for accounting?
  - `nonWitnessUtxo` is required and checked against the txid and `witnessUtxo` (segwit v0 fee attack). Is that
    true for every input the guardian or phone signs, including sweeps and the helper input?
  - What does the phone check before it signs with key 2, and before it asks the hardware wallet to sign
    (amounts, change detection, fee: estimates from the guardian are capped at 2,000 sat/vB in `send.ts`)? What
    can a lying guardian (it serves all chain data: `wallet.sync`, `tx.get`, `fees.estimate`) make the phone sign?
  - Do Ledger (registered wallet policy, `hardware/ledger/policy.ts`), Trezor and QR devices recognise change and
    show the real recipients for these PSBTs?
  - Consensus: are all transaction shapes covered by `tools/consensus-verify` tests (CONTRIBUTING.md "Consensus
    checks")?

**5. Key storage on the phone.**

- Where: `apps/mobile/src/platform/secure-key-store.ts` (`expo-secure-store`, `WHEN_UNLOCKED_THIS_DEVICE_ONLY`,
  `requireAuthentication` for key 2), `packages/wallet/src/wallet.ts` (what is stored with and without
  biometrics: key 2 with; the nostr key, the helper key and the silent-payment scan key without),
  `packages/wallet/src/backup.ts` (380), `packages/wallet/src/state.ts`, `apps/mobile/src/platform/passkey.ts`,
  `platform/cloud/`, `platform/backup-files*.ts`, `platform/key-value-store.ts`; Recovery Key mode state
  (`packages/recovery-key/src/state.ts`, HMAC-SHA256 under a secure-store key). About 1,800 lines.
- Key questions: Does `expo-secure-store` 58.0.2 really bind key 2 to the current biometric set on iOS and Android,
  and does it allow a device-passcode fallback (**to confirm**)? Is the backup format sound: random data key,
  XChaCha20-Poly1305, slot AAD, Argon2id (m = 19 MiB, t = 2, p = 1, `DEFAULT_RECOVERY_CODE_KDF`) over a 120-bit
  recovery code, HKDF-SHA256 over the passkey PRF output? What leaks from what is stored without biometrics? What
  does a thief with the unlocked phone but no biometrics get?

**6. Key storage and unlock on the guardian.**

- Where: `apps/guardian/src/keystore.ts` (Argon2id m = 64 MiB, t = 3, p = 1, 16-byte salt; XChaCha20-Poly1305
  with the header in the AAD; KDF parameters bounded on read; passphrase NFKC, 12 to 1,024 characters),
  `identity.ts` (nostr key unencrypted, mode 0600), `files.ts` (atomic writes), `unlock-throttle.ts`,
  `http/sessions.ts`, `silent/service.ts` (scan key at rest under its own file key). State files:
  `apps/guardian/README.md` "State". About 1,400 lines.
- Key questions: Is key 3 only ever in memory while unlocked, and wiped on lock? Are the four throttles
  (web unlock, phone unlock with its 5-failure stop, reset, sign-in) independent and persisted? Can the phone's
  `guardian.unlock` (passphrase sent through relays, encrypted) or the web reset be abused? Is the keystore format
  safe against parameter downgrade or file swapping?

### 2b. Should review

| Item | Where (size) | Key questions |
|---|---|---|
| Recovery Key mode: timelocked refills | `packages/recovery-key/src` (4,865; `refills.ts`, `spending.ts`, `kit.ts`, `recovery.ts`, `scheduler.ts`, `esplora.ts`), `apps/mobile/src/data/rk-*.ts` (about 2,000) | Does any holder of the signed chain get more than one refill per 1,008 blocks, including across batches (`nLockTime` on later batches)? Fee bounds (2% at signing, 5% fails verification), CPFP, invalidation detection. Kit format 1 (SHA-256 checksum, base32 QR, wallet-map words). What a lying Esplora can do. The app never passes `allowMainnet` (`rk-service.ts`). |
| Silent payments | `packages/silent-payments/src` (1,043), `packages/wallet/src/silent.ts`, `guardian-sp.ts`, `apps/guardian/src/silent/` (906), `apps/guardian/src/singlekey.ts` | BIP 352 correctness beyond the official vectors; the guardian's narrow helper-input allowance (DESIGN.md "Silent payments"); the phone's check of every scanner match; worker threads and key copies; reorg handling. |
| Hardware wallet integrations | `apps/mobile/src/hardware/` (3,205): `ledger/` (DMK over BLE, wallet policy + HMAC), `trezor/` (Connect Mobile through Suite Lite deep links), `qr/` (UR, BBQr) | Can another app on the phone answer a Trezor deep-link callback (`trezor-callback`) with a forged xpub or signature? Is the xpub at setup bound to the device the user verifies (first address on the device)? Are UR/BBQr decoders robust to hostile frames? Message signing paths per `docs/design/hardware-auth-path.md`. |
| Guardian web UI auth, sessions, CSRF | `apps/guardian/src/http/` (1,318: `server.ts`, `api.ts`, `sessions.ts`, `activity.ts`), `apps/guardian-web/src` (4,754), `apps/guardian-web/API.md` | Session tokens (32 bytes, stored hashed, 30 min idle, 12 h max), cookie flags, `checkOrigin` (`Sec-Fetch-Site`, else `Origin` vs `Host` or `X-Forwarded-Host`, which any client can send: is that a gap?), JSON-only state changes, first-run setup race (unauthenticated until setup completes), DNS rebinding without the proxy, CSP, path traversal in static files. |
| Docker image and Umbrel packaging | `packaging/docker/Dockerfile`, `packaging/umbrel/trikey-guardian/` (`docker-compose.yml`, `umbrel-app.yml`), `.github/workflows/docker.yml`, `umbrel-store.yml` | Runs as uid 1000, `npm ci --ignore-scripts`, base image by digest, TypeScript run through `tsx` at runtime. The guardian receives Bitcoin Core RPC credentials (`BITCOIN_RPC_*`) and `APP_SEED`; what can other containers on the Umbrel network reach (**to confirm**: whether Umbrel's `app_proxy` requires the Umbrel login for this app)? |
| Reproducible build and releases | `packaging/VERIFY.md`, `packaging/docker/oci-digests.sh`, `.github/workflows/reproducible.yml`; Android signing `docs/android-signing.md`, `packaging/android/release-cert.sha256`; the in-app update check (`apps/mobile/src/lib/update-check.ts`) | Does a match prove what VERIFY.md says? Can the update check be pointed at an APK that is not Trikey's own release? |

### 2c. Out of scope, or later

| Item | Why | Where |
|---|---|---|
| Marketing material | Not product code; moved to a separate repository | README.md "Repository" |
| Website `site/` (trikey.app) | Static site on Vercel. One exception worth a look: it hosts the passkey association files (`apple-app-site-association`, `assetlinks.json`) that let apps use passkeys for the RP ID, so whoever controls the site influences which apps can evaluate the backup's passkey PRF (`apps/mobile/docs/passkeys.md`). | `site/` |
| Design mockups | Static HTML | `design/`, `docs/*.html` |
| Hosting a guardian for family | Mockup only: the API answers `501 not_available`; the app's "I have an invite" screen is a fixed demo | DESIGN.md "Later: guardian for family"; `apps/guardian/src/http/api.ts`; `docs/alpha-test-plan.md` "Known limits" |
| Start9 package | Skeleton, never run on a Start9 | `packaging/start9/`; DESIGN.md open question 4 |
| Passkey unlock of the guardian | Proposal, not built | `docs/design/passkey-unlock.md` |
| Savings wallet | Design only (the limit-off part of that document is built and is in scope above) | `docs/design/savings-and-limit-off.md` |
| Hardware-wallet unlock of the guardian | Not built: `guardian.unlock` with `kind: "hardware"` answers `1101` | DESIGN.md open question 1; `apps/guardian/src/nostr/handlers.ts` |
| Dev tooling | `packages/protocol/src/dev/relay.ts`, `apps/guardian/test/support`, `apps/mobile/scripts`, `e2e/` | — |

## 3. Architecture and trust boundaries

### Components and who holds which key

| Component | Holds | Talks to |
|---|---|---|
| Hardware wallet (key 1) | Its seed; Trikey sees only the BIP 48 account xpub and BIP 137 signatures from `<account>/0/0` | The phone: Ledger over BLE (Device Management Kit), Trezor through the Suite Lite app by deep link, others by QR |
| Phone app (key 2) | Key 2 seed (secure store, biometrics); derived from it without biometrics: the nostr key (NIP-06), the silent-payment scan key and helper key (BIP 352, BIP 84 `m/84'/c'/1'`); the descriptor, rules, send log | Nostr relays; the hardware wallet; cloud storage (iCloud Drive, Google Drive) or a file for the encrypted backup; GitHub (update check, Android, on tap); in Recovery Key mode an Esplora server |
| Trikey Guardian (key 3) | Setup seed in `keystore.json` (encrypted; decrypted only in memory while unlocked); nostr key and silent-payment scan key (readable without the passphrase, by design) | Nostr relays (outbound `wss://`), alert contacts' NIP-17 inbox relays, Electrs (plain TCP), Bitcoin Core RPC (optional); inbound HTTP on `PORT` only |
| Guardian web UI | Nothing; a session cookie | The guardian's HTTP API, through Umbrel's `app_proxy` |
| Alert contacts | Their own nostr key | Receive NIP-17 DMs, may reply `CANCEL <id>` |

```
  Hardware wallet (key 1)
        │  BLE (Ledger) / Suite Lite deep link (Trezor) / QR (UR, BBQr)
        ▼
  Phone app (key 2) ──wss──▶ nostr relays ◀──wss── Trikey Guardian (key 3)   [Umbrel, Docker]
                             (public by        │          │      │      │
                              default)         │          │      │      └─ HTTP :3000 ◀── app_proxy ◀── LAN browser (web UI)
                                               │          │      │                    ◀── other containers? (to confirm)
  Alert contacts' nostr apps ◀── NIP-17 DMs ───┘          │      └─ RPC (optional) ── Bitcoin Core
                                                          └─ plain TCP ── Electrs ── Bitcoin Core

  Every phone ↔ guardian message: JSON-RPC rumor (kind 21420) in a NIP-44 seal in a NIP-59 gift wrap (kind 1059).
  Both sides only connect out; the guardian's only listener is the HTTP port.
```

### What crosses each boundary

| Boundary | What crosses | Who is trusted for what |
|---|---|---|
| Phone ↔ relays ↔ guardian | Gift wraps (kind 1059) carrying JSON-RPC rumors (kind 21420): PSBTs, descriptors and xpubs at pairing, policies and approvals, the guardian passphrase in `guardian.unlock`, the silent-payment scan private key in `sp.register`, alerts. In clear: the recipient `p` tag, back-dated `created_at`, a derived `expiration`, sizes; relays also see arrival times and IP addresses. | Relays: nothing beyond carrying events (PROTOCOL.md §5). Default relays: `relay.damus.io`, `nos.lol`, `relay.primal.net` (`apps/guardian/src/config.ts`). |
| Guardian ↔ alert contacts | NIP-17 DMs (kind 14 rumors in gift wraps), no `expiration` tag | Contacts: may cancel recoveries only |
| Guardian ↔ Electrs | Plain TCP on the box: addresses scanned, transactions, broadcasts, headers | Trusted for chain data; headers are checked to link up, not for proof of work (threat model) |
| Guardian ↔ Bitcoin Core RPC | `getblock <hash> 3` for the scanner, sync status, broadcast fallback; with Umbrel's RPC user | Trusted; the guardian holds full RPC credentials |
| Browser ↔ guardian HTTP | Passphrase (setup, sign-in, unlock, reset), the 32 bytes of setup entropy, pairing secrets, the recovery code, activity and rules | `app_proxy` in front; the guardian's own sessions behind it |
| Phone ↔ hardware wallet | PSBTs, wallet registration, messages to sign (pairing proof, approvals, recovery access) | The device screen is the user's check |
| Phone ↔ cloud / file | Encrypted `.tkb` backup | Nothing: it needs the recovery code or the passkey PRF |
| Phone (Recovery Key mode) ↔ Esplora | Every vault and spending address, raw transactions, the phone's IP | Confirmations and the tip, not amounts (funding transactions are checked against the txid) |

### Guardian HTTP API (behind `app_proxy`)

From `apps/guardian/src/http/api.ts` and `apps/guardian-web/API.md`. All need a session except where noted.

| Endpoint | Purpose |
|---|---|
| `GET /api/status` | Status; reduced fields without a session |
| `POST /api/session`, `DELETE /api/session` | Sign in with the passphrase (its own throttle; may also unlock), sign out |
| `GET /api/setup/preflight`, `POST /api/setup` | First-run setup (no session until setup completes); carries the browser's 32 bytes of entropy |
| `POST /api/unlock`, `POST /api/lock` | Unlock with the passphrase, lock |
| `GET /api/activity`, `GET /api/rules`, `GET /api/recovery`, `GET /api/phones` | Read state |
| `GET`/`PUT /api/relays`, `DELETE /api/relays/retiring[/:url]` | Relay list and its change (a security event) |
| `GET /api/recovery-code` | The permanent "Recover on a new phone" code (no secret) |
| `POST /api/pairing`, `GET /api/pairing/:id` | One-time pairing code (5-minute secret) |
| `POST /api/reset` | New key 3; passphrase and typed confirmation; refused during a recovery or a pending sweep |
| `/api/hosting...` | Family hosting placeholder, `501` |

## 4. Cryptography and dependencies

### Constructions and primitives

| What | Where it is used | Implementation |
|---|---|---|
| secp256k1 ECDSA, RFC 6979, low-S, `SIGHASH_ALL` | Key 3 signing (`apps/guardian/src/keystore.ts`), signature checks (`packages/core/src/psbt.ts`), phone and software signers | `@noble/curves`, `@scure/btc-signer` |
| BIP 32, BIP 39 | Every software key; 24 words for key 2 and the guardian seed, 12 for the Recovery Kit | `@scure/bip32`, `@scure/bip39` |
| BIP 48 (`m/48'/c'/0'/2'`), BIP 84 (helper `m/84'/c'/1'`; RK spending `m/84'/c'/0'`), NIP-06 (`m/44'/1237'/0'/0/0`), BIP 352 paths | `packages/wallet/src/keys.ts`, `packages/protocol/src/identity.ts`, `packages/recovery-key/src/keys.ts` | |
| Descriptors (BIP 380 checksum, BIP 389 multipath), PSBT (BIP 174, v0) | `packages/core/src/descriptor.ts`, `psbt.ts`; only `wsh(sortedmulti(2,…))` is accepted | `@scure/btc-signer` |
| BIP 89 chaincode delegation (`CCDT` proprietary PSBT fields) | Every input key 3 signs is matched through the delegated tweaks (`readTweaks`, `delegatedScripts`); also kept for family hosting (`packages/core/src/tweak.ts`) | Own code over `@noble/curves` |
| BIP 137 message signatures (verify; high-S refused; headers 27-42; verified by pubkey) | Pairing proof, approvals, `hardware.confirm`, `recovery.access` (`apps/guardian/src/policy/bip137.ts`, `authorizer.ts`; `packages/protocol/src/approval.ts`; `packages/wallet/src/bip137.ts`) | Own code |
| BIP 68 relative and absolute timelocks | Recovery Key refills (`packages/core/src/timelock.ts`, `packages/recovery-key/src/refills.ts`) | Own code |
| BIP 352 silent payments v1.1 | `packages/silent-payments`, `apps/guardian/src/silent/` | Own code, checked against the BIP's vectors |
| NIP-44 v2 (explicit nonce from `secureRandomBytes`), NIP-59 gift wrap (own wrap/seal code, fresh wrap key per message), NIP-17 DMs, NIP-40 expiration, NIP-19 | `packages/protocol/src/transport.ts`, `envelope.ts`; `apps/guardian/src/nostr/dm.ts` | `nostr-tools` (NIP-44, event signing with BIP 340 Schnorr) |
| Argon2id | Guardian keystore: m = 64 MiB, t = 3, p = 1 (`keystore.ts`). Backup recovery-code slot: m = 19 MiB, t = 2, p = 1 over a 120-bit code (`packages/wallet/src/backup.ts`) | `@noble/hashes/argon2` |
| XChaCha20-Poly1305 | Guardian keystore, backup (data key and slots), silent-payment scan key at rest | `@noble/ciphers` |
| HKDF-SHA256 | Backup passkey slot KEK from the WebAuthn PRF output (`backup.ts`) | `@noble/hashes` |
| HMAC-SHA512 seed mixing | `trikey/guardian-seed/v1` (key = OS draw; data = browser entropy and `APP_SEED`), `trikey/key3/v1` (key = guardian seed; data = network, pairing id, phone pubkey, phone's 32 bytes) (`keystore.ts`; DESIGN.md "Entropy") | `@noble/hashes` |
| HMAC-SHA256 | Recovery Key mode state document (`packages/recovery-key/src/state.ts`) | `@noble/hashes` |
| SHA-256 | `policyHash` (canonical JSON), the rumor's `psbt` tag, session token storage, kit checksum | `@noble/hashes` |
| WebAuthn PRF | Phone backup passkey slot (`apps/mobile/src/platform/passkey.ts`); RP ID from `EXPO_PUBLIC_PASSKEY_RP_ID` | `react-native-passkey` |
| CSPRNG with guards and a start-up health test (16 × 32-byte blocks, 8-sigma bounds) plus known-answer tests (HMAC-SHA512, SHA-256, secp256k1, BIP 39, BIP 32) | `packages/core/src/random.ts`, `random-health.ts`; sources: `expo-crypto` on the phone, `node:crypto` webcrypto on the guardian, `crypto.getRandomValues` in the setup browser | Own code |
| Constant-time comparison | Pairing secret (PROTOCOL.md §6) | |

### Security-relevant third-party dependencies

Versions as resolved in `package-lock.json` (the `package.json` ranges are carets; the lockfile pins them, and the
Docker build uses `npm ci`).

| Package | Version | Used by | For |
|---|---|---|---|
| `@noble/curves` | 2.4.0 (and 2.0.1 inside `nostr-tools`) | core, wallet, guardian, silent-payments, recovery-key | secp256k1, Schnorr |
| `@noble/hashes` | 2.4.0 (2.0.1 inside `nostr-tools`; 1.8.0 inside Ledger DMK and `bitcoinjs-lib`) | all | SHA-2, HMAC, HKDF, Argon2id |
| `@noble/ciphers` | 2.1.1 | wallet, guardian | XChaCha20-Poly1305 |
| `@scure/bip32`, `@scure/bip39`, `@scure/base` | 2.4.0 | all | HD keys, mnemonics, encodings |
| `@scure/btc-signer` | 2.4.1 | core, wallet, guardian, recovery-key, silent-payments, mobile | PSBT, scripts, sighash |
| `nostr-tools` | 2.25.4 | protocol, wallet, guardian, mobile | NIP-44, event signing, relay pool |
| `ws` | 8.22.0 | protocol (guardian side) | WebSocket client |
| `zod` | 4.6.7 (protocol, wallet); 3.25.76 at the root for other dependents | protocol, wallet | Message and backup schemas |
| `@ledgerhq/device-management-kit` | 1.11.0 | mobile | Ledger transport and sessions |
| `@ledgerhq/device-signer-kit-bitcoin` | 1.3.3 | mobile | Ledger Bitcoin app (wallet policy, PSBT, message signing) |
| `@ledgerhq/device-transport-kit-react-native-ble` | 1.3.2 (with `react-native-ble-plx` 3.4.0) | mobile | BLE |
| `@trezor/connect-mobile` | 10.0.1 (`@trezor/connect-common` 10.0.1) | mobile | Trezor through Suite Lite deep links |
| `@keystonehq/bc-ur-registry` 0.8.1, `@ngraveio/bc-ur` 1.1.13, `bbqr` 1.2.0 | | mobile | QR transport for air-gapped devices |
| `bitcoinjs-lib` | 6.1.10 | mobile (hardware adapters, **to confirm** which calls) | |
| `expo-secure-store` | 58.0.2 | mobile | Keychain / Keystore for key 2 |
| `expo-crypto` | 58.0.7 | mobile | The random source (`getRandomValues`) |
| `react-native-get-random-values` | 2.1.0 | mobile (via Ledger DMK's `uuid`) | Must never become the source (DESIGN.md "Source pinning") |
| `react-native-passkey` | 3.6.2 | mobile | WebAuthn PRF |
| `react-native-cloud-storage` 3.3.0, `@react-native-google-signin/google-signin` 16.2.0 | | mobile | Cloud backup |
| `expo-print` 58.0.8, `expo-sharing` 58.0.21, `expo-file-system` 58.0.13, `expo-camera` 58.0.14 | | mobile | Kit printing, backup file, QR scanning |
| `expo` 58.0.21, `react-native` 0.88.1 | | mobile | Runtime |
| `qr` 0.7.2 | | recovery-key | Recovery Kit QR |
| `qrcode` 1.5.4, `react-router-dom` 7.18.5, `vite` 8.3.5 (build) | | guardian-web | Pairing QR, routing, build |
| Base image `node:22-bookworm-slim@sha256:4b150b48…` | | Docker image | Runtime (`packaging/docker/Dockerfile`) |

`@simplewebauthn/server` is named in the passkey-unlock decisions but is not a dependency yet.

## 5. Known issues and accepted risks

### By design (documented)

| Risk | Where it is stated |
|---|---|
| The daily limit exists only in the guardian's code. Phone + guardian (or root on the box + the phone) can spend everything; with the limit turned off, phone + an honest guardian can too. Savings, which would fix this for part of the money, is design only. | savings-and-limit-off.md introduction, §4, §5; DESIGN.md rule 3 |
| Remote compromise of the home server gives one key; it can also refuse to co-sign and suppress alerts. | Threat model; savings-and-limit-off.md §5 |
| A family host could skip the delay and suppress alerts while teaming up with a thief (feature not built; the app must say so on accepting an invite). | DESIGN.md "Later: guardian for family" |
| The hardware wallet cannot verify a silent payment recipient: it shows a `bc1p…` output, not `sp1…`. BIP 375 / 374 (PSBTv2 with DLEQ proofs) is not implemented. | DESIGN.md "Silent payments" |
| Trezor firmware up to core 2.12.5 and every Model One show a path warning before signing at `m/48'/c'/0'/2'/0/0`; the user must accept it. None of this is tested on hardware. | docs/design/hardware-auth-path.md §4, §6 |
| Contested recovery stalemate: with a stolen phone and no key 2 backup, the vault is frozen until the backup is restored or the thief gives up. | Threat model |
| Anyone with the hardware wallet can start a recovery from any phone (the recovery code holds no secret); only the alerts and cancel protect against it, so mainnet requires at least one alert contact. | PROTOCOL.md "Recovery access"; threat model "Alert contacts" |
| Electrs and the node are trusted for chain data; headers are not checked for proof of work. The guardian talks to Electrs over plain TCP. | Threat model; `apps/guardian/src/config.ts` |
| The guardian's nostr key is unencrypted (mode 0600) and the scan key is outside the passphrase, so a copy of the data directory reveals the nostr identity and every received silent payment (not spendable). | Threat model; DESIGN.md "Silent payments" |
| Relays can drop messages; a relay change from the web UI can at worst move the phone to relays that drop everything. | Threat model "Malicious relays" |
| The web UI relies on the platform proxy against DNS rebinding; other containers can likely reach the port directly (hence the sessions). | Threat model "The web UI has its own sessions"; `apps/guardian/README.md` "Do not expose it" |
| The key-3 mix (`trikey/key3/v1`) does not help against a dishonest guardian or a guardian whose whole generator is predictable to a relay reader; the setup mix covers the latter only for new seeds. | DESIGN.md "Entropy"; entropy-review.md M1 |
| Recovery Key mode: key 2 and a paper kit come from the same phone's generator; a public Esplora server sees the whole wallet; kit + seed words take everything with no undo window; a stuck refill below the mempool minimum cannot be bumped until package relay. | DESIGN.md "Entropy" and "Recovery Key mode" |
| Notifications while the app is asleep rely on nostr DMs to the user's nostr app; there is no push. | DESIGN.md open question 2 |
| JavaScript cannot zero strings or intermediate BIP 32 nodes; the guardian keeps its setup seed in memory while unlocked. | entropy-review.md I5 |

### Left over from the entropy review

| Item | State at `791ff82` |
|---|---|
| I1: BIP 340 `aux_rand` for nostr events comes from raw `crypto.getRandomValues` | Accepted (safe by BIP 340's construction) |
| I2: `pair.prepare` can be repeated within a session, so a phone can choose among key-3 xpubs | Accepted, no direct impact |
| I5: the encrypted `.tkb` backup stays in the app's cache folder after the share sheet | Still the case (`apps/mobile/src/platform/backup-files.native.ts` writes to `Paths.cache` and does not delete) |
| S1: `expo-print` on Android may write the kit page (key 3 in clear) to a cache file | Not confirmed; needs a device |
| S2: a second bundled copy of `@trikey/core/random` would be pinned only on first use | Not confirmed; no single-instance marker in `packages/core/src` |
| L1 residue: the randomness lint cannot see value aliasing or code inside dependencies | Accepted |

### Inconsistencies found while writing this brief (to confirm)

- `TRIKEY_EXTRA_ENTROPY`: DESIGN.md "Entropy" says a value that is not exactly 32 bytes makes the guardian refuse
  to start; `parseExtraEntropy` in `apps/guardian/src/config.ts` (and `apps/guardian/README.md`) hashes any other
  value to 32 bytes instead. One of them should change.
- DESIGN.md "Repository state" says Recovery Key mode screens are demo-only, while `apps/mobile/src/data/rk-service.ts`
  drives a real `RecoveryKeyWallet` on test networks. Which is current is to confirm.
- README.md and SECURITY.md say "not audited"; `SECURITY-REVIEW.md` records an independent review of the guardian
  (October 2026) and `docs/security/entropy-review.md` a review of randomness. Neither covered the phone app, the
  wallet package or Recovery Key mode as a whole.
- The guardian's `checkOrigin` accepts an `Origin` that matches `X-Forwarded-Host`, a header a non-browser client
  can set freely. Browsers cannot set it cross-origin, and a session cookie is needed anyway, so this may be fine;
  we would like it confirmed.

### Open questions in DESIGN.md

1. How the hardware wallet unlocks the guardian (not built; passphrase only).
2. Notifications when the phone app is asleep.
3. Defaults: daily limit, delay, relays.
4. Start9 packaging details and the official Umbrel store submission.

## 6. What exists to help the reviewer

### Tests

Run on 2026-11-01 at `791ff82` with `npx vitest run --reporter=dot` per package, without the consensus verifier
built (so core's 79 consensus cases were skipped; CI builds it and fails instead of skipping).

| Package | Test files | Tests |
|---|---:|---|
| `packages/core` | 10 | 218 passed, 79 skipped (consensus verifier not built) |
| `packages/protocol` | 12 | 173 passed |
| `packages/wallet` | 18 | 158 passed |
| `packages/recovery-key` | 10 | 83 passed |
| `packages/silent-payments` | 2 | 73 passed (includes the BIP 352 vectors) |
| `apps/guardian` | 44 | 366 passed, 1 skipped; `test/security/` holds one regression file per finding of the October review |
| `apps/guardian-web` | 4 | 23 passed |
| `apps/mobile` | 34 | 527 passed, 2 failed (`src/metro-config.test.ts`, the `@sinclair/typebox` resolver; most likely our local `node_modules`, **to confirm** on a clean `npm ci`) |
| `e2e` | 9 | Not run here: needs Docker (regtest bitcoind and Electrs) |

Notable suites: `apps/guardian/test/guardian.e2e.test.ts` (the real service with in-memory relays, a fake Electrs,
a simulated phone and contact), `rotation*.test.ts`, `limit*.test.ts`, `recovery.test.ts`, `protocol-parity.test.ts`
(the engine's approval texts and policy hash against `@trikey/protocol`), `key3-mix.e2e.test.ts` and
`setup-entropy.test.ts` (vectors against `node:crypto`), `packages/core/test/randomness-lint.test.ts`,
`packages/core/test/consensus.test.ts` (every transaction shape through libbitcoinconsensus), and `e2e/test/`
(`vault`, `recovery`, `bip68`, `relay-policy`, `silent-payments` against real bitcoind and Electrs).

### CI (`.github/workflows/`)

| Workflow | What it checks |
|---|---|
| `ci.yml` | Builds `tools/consensus-verify`, `npm ci`, `npm run typecheck`, `npm test`; a `secrets` job runs gitleaks (`.gitleaks.toml`) |
| `e2e.yml` | The regtest end-to-end suite with real bitcoind and Electrs |
| `docker.yml` | Builds the guardian image and smoke-starts it (waits for `/api/status`) |
| `reproducible.yml` | Builds the image twice and compares digests |
| `android-launch.yml`, `ios-launch.yml` | Builds the app, opens it in an emulator or simulator, walks the demo with Maestro, fails on a crash |
| `android-build.yml`, `android-apk.yml` | Release APK, signed with the release key (`packaging/android/release-cert.sha256`) |
| `umbrel-store.yml` | Publishes the Umbrel store copy with the image pinned by digest |
| `site.yml` | Validates the website |

### Running it locally

- Everything: Node 22, `npm install`, `npm run typecheck`, `npm test` (CONTRIBUTING.md). Consensus checks:
  `npm run build:verifier` (Rust and a C++ compiler), then `TRIKEY_CONSENSUS_VERIFY` or the default path.
- One process with the real guardian, two relays and a fake Electrs: `npm run dev-rig -w @trikey/mobile`
  (`apps/mobile/docs/dev-regtest.md`, with commands such as `skip <days>` to end a recovery delay). The same
  document describes the full regtest stack (bitcoind, Electrs, a relay, the guardian) for a phone or emulator.
- Real bitcoind and Electrs in Docker: `npm run stack:up -w @trikey/e2e`, then `npm run test:e2e -w @trikey/e2e`
  (`e2e/README.md`).
- The guardian on its own: `node --import tsx apps/guardian/src/main.ts` with the variables in
  `apps/guardian/README.md` "Running"; the web UI against a mock or a real guardian: `apps/guardian-web/API.md`
  "Running the UI".
- The app: Expo (`apps/mobile/README.md`); its "Regtest simulator" mode uses the real wallet code with a software
  hardware wallet. Developer settings include a crypto self-test.
- Hands-on flows with real devices: `docs/alpha-test-plan.md` (pairing, limit, approvals, lock/unlock, backup and
  restore, the lost-phone recovery, Replace guardian).
- Reproducing the published image: `packaging/VERIFY.md`.

### Earlier reviews and design notes

- `SECURITY-REVIEW.md`: the October 2026 guardian review, its findings, fixes and behaviour changes.
- `docs/security/entropy-review.md`: the randomness review (M1, L1-L3 fixed; the rest above).
- `docs/design/hardware-auth-path.md`, `docs/design/savings-and-limit-off.md`, `docs/design/passkey-unlock.md`.
- `DESIGN.md` (decisions, rules, threat model) and `packages/protocol/PROTOCOL.md` (wire format, error codes) are
  the specification the code is meant to implement; a finding where code and these documents disagree is useful
  either way.

## 7. Practicalities

- **Repository:** https://github.com/TheIcarusWings/trikey (public, MIT).
- **What to review:** a tag chosen at the start of the review. Release tags look like `v0.1.7-alpha`; the brief was
  written at `791ff82`, which is the `v0.1.7-alpha` tag. The sizes in section 2 will drift a little by then.
- **Contact:** the owner of the GitHub repository, through the repository. No email address is published.
- **Findings:** as private reports first, through GitHub's private vulnerability reporting (Security, Report a
  vulnerability; `SECURITY.md`), not public issues. We publish fixed findings afterwards in the style of
  `SECURITY-REVIEW.md`, each with a regression test.
- **Networks:** use regtest, signet or testnet with throwaway keys. Do not test against anyone's mainnet guardian.
- **What we would like back:** findings with severity and a proof of concept where possible (we turn them into
  regression tests), and a statement of what was and was not covered, by path, so the remaining parts can be
  reviewed later.
