# Guardian web UI: HTTP API

This is the contract between `@trikey/guardian-web` and the guardian backend
(`apps/guardian/src/http/`). The UI only ever calls the endpoints below, through the
`GuardianApi` interface in `src/api/client.ts`. `src/api/http.ts` implements it with
`fetch`; `src/api/mock.ts` implements it in memory so the UI runs without a backend.

The TypeScript types in `src/api/types.ts` are the source of truth for every body.
The guardian re-exports them type-only (`apps/guardian/src/http/types.ts`), so a
change here that the server does not follow fails `npm run typecheck`. This file
lists the endpoints, status codes and behavior the types do not carry.

**Deployment and sessions.** Keep the guardian behind the platform's authenticating
proxy (Umbrel's `app_proxy`, Start9's interface), never exposed beyond it. It does not
rely on the proxy alone (other apps' containers on the same box can likely reach it
directly; security review 2026-10, finding 10b): every endpoint needs a **session**,
except `GET /api/status` (reduced to `PublicStatus` without one), `POST /api/session`,
`DELETE /api/session`, and the first-run endpoints until setup completes.
`POST /api/session` with the unlock passphrase signs the browser in: the guardian sets
an `HttpOnly; SameSite=Strict` cookie (`Secure` when the request came over HTTPS, as
`X-Forwarded-Proto` says), a random 32-byte token held in memory only. A session ends
after 30 minutes without a request, 12 hours after sign-in, at sign-out, at a reset or a
passphrase change, and when the guardian restarts. Without one, everything else answers `401 unauthenticated`.

**The cookie alone is no session.** Cookies are bound to a host, not to a port (RFC 6265): on Umbrel every app is
`http://umbrel.local:<port>`, so the browser sends `trikey_session` to every other app the owner opens, and that app's
server could replay it to the guardian. So every answer that signs the browser in (`POST /api/session`, `/setup`,
`/passphrase`, `/reset`) also carries `sessionSecret` (32 more random bytes, base64url; the guardian keeps only its
sha256), and every request must send it back as **`X-Trikey-Session: <sessionSecret>`**. A request with the cookie but
without the right secret is signed out (`401 unauthenticated`; `GET /api/status` answers `PublicStatus`), and
`DELETE /api/session` then ends nothing. The page keeps the secret in `sessionStorage` (scoped to scheme, host and port:
no other app reads it), so a reload keeps the session. A new tab asks the guardian's other open tabs for it over a
`BroadcastChannel` (also per origin) and, if none is open, shows the sign-in screen. There is deliberately no endpoint
that hands out the secret for the cookie: another app on the host has the cookie and its server can set any header, so
it would get the secret too (`src/api/session.ts`). A request with **two** `trikey_session` cookies (another app on the
host can set one at a more specific path, `Path=/api`, which the browser sends first) has no session either: it is
answered as signed out with `Set-Cookie`s that clear the cookie at every path a cookie sent with it could have. Where the
platform's login proxy is recognised (`TRIKEY_TRUSTED_PROXY`, Umbrel), a session signed in through it or from the
guardian's own container is accepted afterwards only from there. Not `__Host-`: that prefix needs `Secure`, and Umbrel's
local address is plain HTTP. Scripts: take `sessionSecret` from the sign-in answer and send it with the cookie.

## Conventions

- All paths are under `/api` on the same origin that serves the UI.
- Bodies are JSON (`Content-Type: application/json`). Timestamps are ISO 8601 UTC
  strings. Amounts are integer sats.
- Collections and nullable values are wrapped in an object (`{ "entries": [...] }`)
  so fields can be added later.
- Errors use one shape, with the HTTP status set to match:

  ```json
  { "error": { "code": "bad_passphrase", "message": "That passphrase is not right." } }
  ```

  Codes: `unauthenticated` (401, no session, or a cookie without its `X-Trikey-Session`, or two session cookies: sign in), `bad_passphrase` (401), `rate_limited` (429, with `retryAfterSeconds` and a
  `Retry-After` header), `locked` (409), `setup_required` (409), `already_setup` (409), `setup_code_required` (403) and
  `bad_setup_code` (401) (the first run, below),
  `already_paired` (409), `recovery_pending` (409), `sweep_pending` (409), `not_found` (404), `invalid` (400, 413 or 415), `forbidden`
  (403, a cross-origin request, or one without `Origin` from outside the box's own container), `not_available` (501), `internal` (500). The UI
  reacts to the first few and shows any other code as a generic failure using `message`.
- Every response sends `Cache-Control: no-store` (API) and security headers: a CSP
  with `default-src 'self'` and no `'unsafe-inline'`, `X-Frame-Options: DENY`,
  `Referrer-Policy: no-referrer`, `X-Content-Type-Options: nosniff`.
- **State-changing requests** (`POST`, `PUT`, `DELETE`) must carry a JSON body with
  `Content-Type: application/json` (the client sends `{}` when it has nothing to
  send; anything else is `415`), and must be same-origin: the guardian checks
  `Sec-Fetch-Site: same-origin` when the browser sends it, else `Origin` against
  `Host` / `X-Forwarded-Host` (`403 forbidden`). A request with neither header (not a browser: every browser sends
  `Origin` on these methods) is accepted only from the guardian's own container (loopback) or the platform's login
  proxy (`TRIKEY_TRUSTED_PROXY`), judged by the socket's address; from anywhere else `403 forbidden` (security review
  2026-11). Scripts send `Origin: <the address they open the page at>`. Bodies are limited to 16 KiB.
- The UI is a single-page app with client-side routes (`/` Home, `/setup`, `/sign-in`, `/locked`,
  `/wallet` (also while locked), `/activity`, `/rules`, `/recovery`, `/phones`, `/settings`, `/passphrase`, `/reset`; `/pair` and `/recover-phone`
  redirect to `/phones`; `/host` exists only in a build with `VITE_FEATURE_HOST_FOR_SOMEONE=true`). The guardian serves
  `index.html` for every non-`/api` path that is not a file in `dist/` (a missing
  file under `/assets/` is a `404`).
- **Password managers.** The passphrase works with them (Proton Pass, 1Password, Bitwarden,
  iCloud Keychain, Google): set-up, unlock, sign-in, change passphrase and reset are real `<form>`s with a submit
  button, the passphrase fields say `current-password` or `new-password`, and each form carries
  the same fixed user name (`username`, "Trikey Guardian", off-screen and out of the tab order) so
  one saved entry fills them all. Set-up's and Change passphrase's two `new-password` fields carry a `passwordrules` hint
  (at least 12 characters, any printable), so a generated passphrase fills both. Passkeys need HTTPS:
  WebAuthn does not run on a plain-HTTP address other than `localhost`.
- A strict CSP works: the app has no inline scripts and loads all fonts and scripts
  from its own origin. QR codes are drawn locally. If a build ever adds an inline
  script to `index.html`, the guardian allows exactly that script by its hash.

## Which endpoints work when

| Guardian state | Allowed |
|---|---|
| Setup not complete | `GET /status`, `GET /setup/preflight`, `POST /setup/code`, `POST /setup` (no session needed; setup signs the browser in; setup needs the setup code unless the request came through the platform's login proxy) |
| No session (after setup) | `GET /status` (as `PublicStatus`), `POST /session`, `DELETE /session` |
| Locked, signed in | `GET /status`, `GET /wallet` (read-only), `POST /unlock`, `POST /reset`, the session endpoints |
| Unlocked, signed in | everything |

Without a session anything else answers `401 unauthenticated`; with one, `409 locked`
(or `409 setup_required` before setup; `409 already_setup` for the setup endpoints
afterwards). The UI reads `GET /status` first and shows the matching screen (sign-in when
it says `authenticated: false`), and polls it every 15 s (every 3 s on the locked screen,
so an unlock from the phone shows up quickly); any `401 unauthenticated` sends it back to
the sign-in screen. The guardian is locked after every start of its process.

## Endpoints

### Status and lifecycle

| Method and path | Request | Response | Notes |
|---|---|---|---|
| `GET /api/status` | none | `GuardianStatus` or `PublicStatus` | Always available. Without a session (after setup) only `PublicStatus`: `authenticated: false`, `setupComplete`, `state`, `network`, `version`. With one (`authenticated: true`): `setupComplete`, `state` (`locked` or `unlocked`), `lockedAt` and `lockReason` (`restart`, `manual` from this UI, `remote` from the paired phone's `guardian.lock`, or `contact`: an alert contact sent `LOCK` over nostr, allowed only while the rules' `contactLock` is on) while locked, `lockedBy` (with `contact`: that contact's npub), `relays[]` (with live connection state), `chain` (`synced` once Electrs answers, `syncing` with `progress` when Bitcoin Core RPC reports initial block download, else `unavailable`; `height`; `mempoolUnseen: true` when the guardian found that its Electrum server reports no unconfirmed transactions, so payments to the wallet show only once confirmed), `wallets[]` (zero or one: the engine guards one active wallet), `retiredWallets[]` (wallets it guarded before, read-only history: `reason` `recovered` with the `successorId` it guards now, or `retired`), `hardwareConfirmRequired` (after the guardian took over a recovered wallet, until the phone confirms the hardware wallet), `dailySpend` (`usedSats`, `limitSats`, and `limitOff: true` while there is no daily limit), `savings?` (the phone's optional Savings wallet, which this guardian only watches and cannot sign for: `id`, `watchedSince`, `balanceSats`/`unconfirmedSats`/`scannedAt` from its last scan, and `lastMoved: { at, sats, txid }`, the newest time coins left it; absent without Savings), `recoveryInProgress`, and `phoneSpending`, `network`, `npub`, `version`, `warnings?` (`no_alert_contacts`: a recovery would be announced only to the paired phone; mainnet guardians refuse that, test networks warn). |
| `POST /api/session` | `{ passphrase, unlock? }` | `GuardianStatus` with `sessionSecret` | Signs the browser in (sets the session cookie; send `sessionSecret` back as `X-Trikey-Session`). With `unlock: true` a locked guardian is unlocked by the same passphrase (that attempt counts against the unlock's rate limit). `401 bad_passphrase`, `429 rate_limited`: sign-in has its own rate limit (exponential backoff after 3 failures, persisted), which neither the unlock, the reset nor the phone's `guardian.unlock` shares. |
| `DELETE /api/session` | `{}` | `PublicStatus` | Signs the browser out (clears the cookie). Ends the session only with its `X-Trikey-Session`. |
| `GET /api/setup/preflight` | none | `SetupPreflight` | First run only. `electrs` is `found` when Electrs answers; `node` is `found` when Bitcoin Core RPC answers (or, without RPC settings, when Electrs does). The relay choices to offer. Since 0.1.9: `electrsProblem` (while `electrs` is `missing`: why, in plain words), `platform` (`umbrel`, `start9` or `docker`) and `setupCodeRequired` (for this request: false only through the platform's recognised login proxy, or on a guardian without `TRIKEY_PLATFORM`). |
| `POST /api/setup/code` | `{ code }` | `{ ok: true }` | First run only. Checks the setup code (below) before the owner types a passphrase; sets nothing up. `403 setup_code_required` without a code, `401 bad_setup_code`, `429 rate_limited` after 10 wrong codes in a minute. Without `setupCodeRequired` any code passes. |
| `POST /api/setup` | `{ passphrase, relays: string[], entropy?, setupCode? }` | `GuardianStatus` | First run only. With `setupCodeRequired`, `setupCode` must be the setup code (checked first, same answers as `POST /setup/code`). Creates key 3 (a fresh BIP39 seed; the BIP48 account key), encrypts it under an Argon2id key from the passphrase, connects the chosen relays. The guardian ends up unlocked. `entropy`: 32 bytes from the browser's `crypto.getRandomValues` as 64 lowercase hex characters, mixed into the new seed with the guardian's own (DESIGN.md, "Entropy", `trikey/guardian-seed/v1`); never logged or stored. The UI always sends it; it is optional for other clients. `400 invalid` if `relays` is empty, has more than 8 entries or a URL that is not `wss://` (or `ws://` on a local host), the passphrase has fewer than 12 characters, or `entropy` is present but not exactly 64 lowercase hex characters. There is no backup of key 3, by design. |
| `POST /api/unlock` | `{ passphrase }` | `GuardianStatus` | `401 bad_passphrase` on a wrong passphrase (with `retryAfterSeconds` once the next try has to wait). Rate limited with exponential backoff after 3 failures (`429 rate_limited`); the count survives restarts. The phone's `guardian.unlock`, the reset and the sign-in each have their own count, so a stolen phone guessing away never delays this UI (security review 2026-10, finding 4). Unlocking takes a few seconds on a Raspberry Pi (Argon2id). |
| `POST /api/lock` | `{}` | `GuardianStatus` | Drops key 3 from memory and invalidates a pairing code in progress. The phone gets a `guardian_locked` alert. |
| `POST /api/passphrase` | `{ passphrase, newPassphrase }` | `GuardianStatus` | "Change passphrase", see below. Unlocked only (`409 locked`). |
| `POST /api/reset` | `{ passphrase, confirm, entropy? }` | `GuardianStatus` | "Reset guardian", see below. Works locked or unlocked and ends unlocked. `entropy` as for setup (the new key 3's seed); `400 invalid` if present and malformed. |

**Reset guardian.** Forgets every wallet (active and retired), its rules, recoveries and
limit records, and **creates a new key 3**; the old key 3 is destroyed (the keystore file is
replaced, the one exception to "never overwritten"). The nostr identity, the relays (change them with
`PUT /api/relays`), the unlock passphrase and the service log stay. `confirm` must be exactly `RESET GUARDIAN`
(`RESET_CONFIRMATION` in `src/api/types.ts`), else `400 invalid`; the passphrase is checked like
an unlock, with a rate limit of its own (`401 bad_passphrase`, `429 rate_limited`). It ends every web session (the browser that reset is signed in again). Refused with
`409 recovery_pending` while a recovery is pending or ready (it would make a running recovery
disappear), and with `409 sweep_pending` while a co-signed sweep has not been broadcast yet and still can be (its
signature would be lost with key 3). The paired phone gets a `wallet_retired` alert (reason
`reset`) first. Why a new key 3 rather than keeping it: with the old key and no wallet state,
anyone holding this UI, the passphrase and a stolen hardware wallet could pair the user's own
wallet again with a phone of their choosing and no alert contacts, and run a recovery only they
hear about. A wallet that used the old key 3 stays spendable with its phone and hardware wallet.

**Change passphrase** (Settings, Passphrase; DESIGN.md, "Changing the passphrase"). Unlocked only. `passphrase` is the
current one, checked like an unlock and through the **unlock's own rate limit** (`401 bad_passphrase` with
`retryAfterSeconds` once the next try has to wait, `429 rate_limited`; a wrong one is logged in Activity, "Passphrase
change refused"). `newPassphrase` follows setup's rule (`400 invalid`: fewer than 12 characters after NFKC, or more
than 1024) and must not be the current one (`400 same_passphrase`). The guardian encrypts the same key 3 again under the
new passphrase (a fresh Argon2id salt and nonce, the keystore's `createdAt` kept, so a hardware unlock slot keeps
working), opens the new file once to check it, and replaces `keystore.json` atomically: a crash leaves the old file or
the new one. Then it ends every web session (the browser that changed it gets a new cookie in this answer), logs
"Passphrase changed", and tells the paired phone (`passphrase_changed`) and the owner's own alert channels. Key 3, the
wallet, the rules, the relays and the nostr identity do not change, and neither do the recovery code, backup file or
recovery sheet (none of them uses the passphrase). A copy of the data directory made before the change still opens with
the old passphrase. The phone cannot change the passphrase (there is no nostr method for it). The UI checks the new
passphrase with the same rule before sending (`src/lib/passphrase.ts`, shared with set-up). It takes three Argon2id
runs (the current passphrase, the new file, its check): several seconds, longer on a Raspberry Pi.

**The setup code.** Before setup, whoever reached the port first could set the guardian up. On plain Docker nothing
guards the port; on Umbrel and Start9 the platform's login guards only its own path, and other apps' containers reach
the port directly (security review 2026-11, finding 3). So on every platform (`TRIKEY_PLATFORM` set) the guardian asks
for a one-time code, 16 Crockford base32 characters (`XXXX-XXXX-XXXX-XXXX`, 80 bits), except from the platform's login
proxy (`TRIKEY_TRUSTED_PROXY`, recognised by the socket's address; Umbrel's app gateway, `gateway`). Where it comes from: made from the OS
generator at every start, kept in memory only and printed in the log (`setup.code code=...`), or handed in by the
platform (`TRIKEY_SETUP_CODE`: Start9 draws it at install and shows it in its Show Setup Code action; the log has it
too). The UI asks for it first (`POST /api/setup/code`) and sends it again with `POST /api/setup`; the page says where
to find it by `platform`. Case, spaces and dashes do not matter, and `O`, `I` and `L` read as `0`, `1` and `1`. After
setup the code opens nothing.

**Passphrase handling.** The UI sends the passphrase in exactly one request body.
It is held in component state only while the form is open, cleared as soon as the
request settles, and never written to storage, the URL or logs. The guardian never
logs request bodies.

### Activity and rules

| Method and path | Response | Notes |
|---|---|---|
| `GET /api/activity?limit=100` | `{ "entries": ActivityEntry[] }` | Newest first. `limit` defaults to 100 and is capped at 500. Entries merge the policy engine's log (ids `e…`) and the service's (ids `s…`: unlocks, pairing, broadcasts, why a recovery is waiting). The UI filters by `kind` itself. |
| `GET /api/rules` | `Rules` | Read-only. The guardian changes rules only via the phone app over nostr (`policy.update`), so the UI has no write endpoint. `404 not_found` before a wallet is paired. `sweepFeeCapSats` is the absolute fee cap the engine enforces. `dailyLimitOff: true` while there is no daily limit (the phone turned it off with a hardware approval; `dailyLimitSats` is then the protocol maximum, 21 million BTC, and should not be shown as a number). Contacts are named by their shortened `npub` (the guardian knows no names). `contactLock`: whether the alert contacts may lock this guardian with a `LOCK` DM (opt-in, set from the phone; turning it off needs the hardware wallet); absent from older guardians, meaning off. |

### Wallet (view and receive only)

| Method and path | Response | Notes |
|---|---|---|
| `GET /api/wallet` | `WalletOverview` | Signed in; **works while locked** (public chain data and the limit's counters, nothing needs key 3); `409 setup_required` before setup. Nothing here spends: payments are made from the phone. Before pairing: `{ paired: false, state, network }`. Else `walletId`, `walletName`, `balance` (`confirmedSats` and `unconfirmedSats`; the page shows their sum, as the phone does, and the unconfirmed part under it as "waiting to confirm"), `payments[]` (unconfirmed first, then newest first, at most 100, `paymentsTruncated` when there are more: `txid`, `direction` `in`\|`out`\|`self`, `amountSats` (out: paid to others, the fee apart when known, as in the phone's `wallet_tx`), `feeSats?` (when every input was the wallet's), `confirmations`, `at?` (block time; absent while unconfirmed)), `receive` (`address`, `index`), `readAt` and `tipHeight` (when the chain data was read), `dailyLimit` (`limitSats`, `usedSats`, `leftSats`, `limitOff?`: the policy engine's numbers, the same as `GET /status`'s `dailySpend` and the phone's), `savings?` (as in `GET /status`). Answered from the live wallet's last read (no chain call); with none yet (just started or paired) the guardian reads the chain once (one read for concurrent requests, reused 15 s). If it cannot read the chain, `chainError` (plain words, never the node's address) and no `balance`, `payments` or `receive`. **The receive address** follows the phone's rule: the first unused address of the receive chain after the highest used one (the `nextReceiveIndex` of `wallet.sync`), derived from the stored descriptor; a visit never moves it on, a payment to it does. **Family hosting:** only the host's own wallet, nothing of a guest's (the guardian does not know a guest's addresses) and no guest counts. No explorer links: the page shows a txid with a copy button. |

`ActivityEntry.result` is one of `co-signed`, `refused`, `locked`, `ok`,
`rule-changed`. `kind` is one of `payment`, `recovery`, `rules`, `system`.
`summary` is optional; the dashboard shows it instead of `event` when present.

### Own wallets (several wallets of the box's owner)

A guardian may guard more than one wallet of its owner, each with its own hardware wallet, rules and recoveries
(docs/design/multi-wallet.md). The first wallet keeps every endpoint above; the others are named by their wallet id.

| Request | Response | Notes |
|---|---|---|
| `GET /api/wallets` | `{ "wallets": WalletSummary[] }` | Signed in; works while locked. The first wallet, then each wallet added, with `name`, `account` (its BIP 48 account on the shared phone and key 3 seeds), `hardwareFingerprint`, `recoveryInProgress` and `dailySpend` (those four only once there is more than one wallet). `GET /api/status`'s `wallets` is the same list. |
| `GET /api/wallets/:id` | `WalletOverview` | As `GET /api/wallet`, for that wallet (the first by its id, too). `404 not_found` for an id the guardian does not guard. |
| `GET /api/rules?wallet=<id>` | `Rules` | That wallet's rules (`walletName` is its name). Without `wallet`: the first wallet's, as before. |
| `GET /api/recovery?wallet=<id>` | `{ "recovery": RecoveryInProgress \| null }` | That wallet's running recovery. Without `wallet`: the first wallet's. `GET /api/status`'s `recoveryInProgress` is true while any wallet's runs. |
| `GET /api/activity?wallet=<id>` | `{ "entries": ActivityEntry[] }` | That wallet's entries and the box's own. Without `wallet`: every wallet's; once there is more than one, each entry about a wallet names it (`wallet`). |

### Recovery

| Method and path | Response | Notes |
|---|---|---|
| `GET /api/recovery` | `{ "recovery": RecoveryInProgress \| null }` | `null` when no Delay & Notify recovery is running. `state` is `ready` once the delay is over; `waitingFor` then says why the guardian has not completed it yet (locked, the chain's median time not yet past the end of the delay, the sweep leaving coins behind, ...). `destination` is the sweep's output address. |

There is no cancel endpoint. The policy engine records who cancelled a recovery,
because that decides whether phone-only payments stay paused (a "contested"
cancel): the paired phone (`recovery.cancel`), an alert contact (replying
`CANCEL <id>` to the alert DM, or `recovery.cancel` over nostr), or the hardware
wallet (a signed `cancel-recovery` approval). The box's web UI is none of these.
(An earlier draft had `POST /api/recovery/:id/cancel` "re-enabling phone-only
payments", which the engine cannot do safely.)

### Relays

| Method and path | Request | Response | Notes |
|---|---|---|---|
| `GET /api/relays` | none | `RelaySettings` | Unlocked only. `relays[]`: in use now, each with its live connection state (the pairing and recovery codes carry these). `retiring[]`: relays a change removed that the guardian still listens and publishes on, newest change first, each with its live connection state and `since` (when it was removed). They have no end date: they stay until the owner stops watching them (`DELETE /api/relays/retiring`). `options[]`: the relays offered at setup, as suggestions. `lastChange`: the latest change and, once the paired phone said it switched (`relays.ack`, or a new pairing on the new list), `phoneConfirmedAt`: absent while the phone has not confirmed. `max`: 8. `maxRetiring`: 16, the most old relays watched at once. |
| `PUT /api/relays` | `{ relays: string[] }` | `RelaySettings` | Unlocked only. Replaces the list, with the setup's rules: `400 invalid` if it is empty, has more than 8 entries or a URL that is not `wss://` (or `ws://` on a local or `.onion` host), or carries credentials or a fragment; URLs are normalised and duplicates dropped. The same relays in another order change nothing. Otherwise, at once: the guardian listens and publishes on the new relays and on the removed ones (`retiring`, with no end date, whether or not the phone confirms), sends the paired phone a `relays_changed` alert over both, and logs a "Relays changed" security event. The phone moves once the guardian answers it over the new relays (PROTOCOL.md, "Changing relays"). A relay that comes back into the list is no longer old. `409 retiring_full` if the change would leave more than `maxRetiring` (16) old relays: nothing is dropped behind the owner's back, so stop watching some first (below); `409 setup_required`. Print a new recovery sheet afterwards: a sheet or backup made before the change keeps working only while its old relays are watched. |
| `DELETE /api/relays/retiring` | `{}` | `RelaySettings` | Unlocked only (same checks as `PUT /api/relays`: `401` signed out, `409 locked`). Stops watching **all** old relays: the guardian no longer listens or publishes on them, so recovery sheets and phone backups made before the change, and phones that have not switched yet, that only know them stop reaching it. Logs one "Old relays dropped" security event naming them and how many. Nothing to drop: `200`, nothing logged. |
| `DELETE /api/relays/retiring/:url` | `{}` | `RelaySettings` | As above for **one** old relay. `:url` is the relay URL, percent-encoded (`wss%3A%2F%2Frelay.example.com`); it is normalised like in `PUT`. `404 not_found` if it is not one of `retiring` (a current relay is never dropped this way). To watch a dropped relay again, add it back with `PUT /api/relays`. |

There is no undo endpoint: put the old list back with another `PUT` (the phone, still on relays that work, follows
again). Old relays are kept because printed recovery sheets, which carry the relay list, are kept for years: stopping
them is the owner's explicit choice, and the web UI asks first. A change can only cost availability, not funds: relays carry nothing but encrypted gift wraps, and the phone moves
only to relays the guardian answered it over.

### Notifications (email, ntfy, webhook, Telegram)

Extra, **notify-only** alert channels (docs/design/notifications.md): the same warnings as the nostr alerts, never a
control (cancelling a recovery and `LOCK` stay nostr DMs), plain text without links. They are the owner's delivery
settings, **outside the hardware-approved rules**: only this UI changes them (never the phone), and every change is
announced on every channel before and after it (the removed ones, over the email account and the Telegram bot as they
were before) and to the paired phone (`notifications_changed`). Types: `NotificationSettings`, `NotificationSettingsInput`,
`NotifyDestination`, `NotifyTestInput`, `NotifyTestResult`, `TelegramSettings`, `TelegramFindResult` in `src/api/types.ts`.

| Method and path | Request | Response | Notes |
|---|---|---|---|
| `GET /api/notifications` | none | `NotificationSettings` | Unlocked only. `guardianName` (how messages name this guardian), `paymentAlerts` (opt-in, off by default: the owner's own channels also get a short line for each payment in or out of the wallet or Savings and when it confirms, amounts only, never to contacts), `smtp?` (the owner's email account: host, port, `security` `tls`\|`starttls`, username, From address, `pin?` (a pinned certificate: `sha256`, its fingerprint `AB:CD:...`, and `certificate`, true when the certificate itself was pasted rather than only its fingerprint), `passwordSet`, `health`), `telegram?` (the Telegram bot: `bot` `{ username, name }` as Telegram's `getMe` gave them when the token was saved, `tokenSet`, `health`), `destinations[]` (each one channel: `audience` `owner`\|`contact`, `kind` `email`\|`ntfy`\|`webhook`\|`telegram`, `contact?` the alert contact's pubkey with `contactNpub` and `contactInRules`, the address or hints (`telegram: { chatId, name }`, the name as Find showed it), `health`), `contacts[]` (the rules' alert contacts, to attach a channel to), `recoveryRunning`, `pending` (messages still being retried), `defaultNtfyServer` (`https://ntfy.sh`), `limits`. **Secrets never come back**: not the app password, not an ntfy topic (only its first characters) or token, not a webhook URL (only its origin) or secret, not the Telegram bot token. `health.state` is `ok`, `failing` (with `lastError` in plain words and `lastErrorAt`) or `untested`. |
| `PUT /api/notifications` | `NotificationSettingsInput` | `NotificationSettings` | Unlocked only. Replaces everything (as `PUT /api/relays` does); `paymentAlerts` omitted keeps it as it was, and turning it on or off is a change, announced like the others. A channel with an `id` is a stored one: omit a secret to keep the stored one (`token: null` / `secret: null` clears an optional one); a channel without `id` is new. **A stored secret stays with the address it was saved for**: an ntfy channel moved to another `server` needs its `topic` again (`400` without it) and loses its stored `token` unless a new one comes with it; a webhook with a new `url` (any change, the same origin included) loses its stored `secret` unless a new one comes with it. `smtp: null` removes the account (refused while an email channel needs it); `password` omitted keeps the stored one, only while `host`, `port`, `security`, `username` and the pin stay as they are: changing any of them (setting, replacing or removing the pin included) needs the `password` again (`400`), so a saved app password is never sent to a server or account it was not typed for; the From address can change without it. `smtp.pin`: the server's certificate (one PEM block) or its SHA-256 fingerprint (64 hex digits, colons and openssl's `sha256 Fingerprint=` allowed) to pin, for a server with a self-signed certificate such as Proton Mail Bridge: TLS then accepts exactly that certificate instead of the public CAs (never "any certificate"); omitted keeps the stored pin, `null` removes it; the same certificate again is no change; a private key, several certificates or a SHA-1 fingerprint are refused (`400`). Setting, changing or removing the pin is a change of the account, announced like one. `telegram`: omitted (or `{}`) keeps the bot; `{ token }` sets it up or changes it: the guardian first asks Telegram (`getMe`) and refuses (`400`, in plain words) a token Telegram refuses, or when it cannot reach Telegram; the same token again is no change; `null` removes the bot (refused while a Telegram channel needs it). A Telegram channel is `{ audience, kind: "telegram", contact?, telegram: { chatId, name? } }` (`chatId` from Find; `name` as Find showed it); Telegram channels need the bot. Checks (`400 invalid`, in plain words): name (letters, digits, spaces, `-`, `'`, at most 32), email addresses, the account (TLS or STARTTLS only), ntfy topics (`[-_A-Za-z0-9]{1,64}`), ntfy and webhook URLs (`https://` anywhere, `http://` only on the local network: private IPv4 ranges, IPv6 ULA, `.local`, `.lan`, `.home.arpa`, `.internal`, `.home`, single-label names; never loopback, link-local, reserved or `.onion`; no credentials or `#`), webhook secrets (16 to 256 printable characters), Telegram tokens (as @BotFather shows them) and chat ids, webhooks for the owner only, and the caps: 24 channels, 3 of each kind for the owner, one email, one ntfy topic and one Telegram chat per alert contact, 10 contacts without a nostr key. `409 recovery_pending`: while a recovery runs, removing or changing a channel, the email account or the Telegram bot is refused; adding is allowed, and so is a new `password` for the same account (same host, port, `security`, username, From address and pin) and a new token for the same bot (same bot id), announced like any change. `429 rate_limited`: more than 30 changes an hour. A change is logged ("Alert channels changed", listing it). |
| `POST /api/notifications/test` | `{ destination }` or `{ smtp: true }` | `NotifyTestResult` | Unlocked only. Sends "Test message" now to one channel, or through the email account to its own From address, and records the result in its `health` and the activity log. A send that fails is still `200`, with `ok: false` and `error`. `404 not_found` for an unknown channel; `429 rate_limited` after 10 tests in 10 minutes. |
| `POST /api/notifications/telegram/find` | `{}` | `TelegramFindResult` | Unlocked only. "Find": one short poll of Telegram (`getUpdates`, no wait), only now (the guardian never polls by itself), listing the private chats that sent `/start` to the bot lately (Telegram keeps a day), newest first: `chatId`, `name` (first and last, as the person set them: anyone can choose any), `username?`, `at`, at most 20; and the `bot`. `409 not_found` without a bot; `429 rate_limited` after 10 in 10 minutes; `502 telegram_failed` with Telegram's refusal in plain words: a bot with a webhook set by another service ("This bot has a webhook set: another service already uses it ... Make a new bot with @BotFather just for the guardian"), another program polling it, a revoked token, Telegram unreachable. |

**Delivery.** Every alert becomes one message per channel, kept on disk and retried (1, 2, 5, 10, 30 minutes, then
hourly) for 7 days, as the nostr notices are; each alert goes once; a newer recovery reminder replaces an older one not
yet delivered. A channel that starts failing, works again, or loses a message after 7 days is logged ("Alert channel
failing", "Alert channel works again", "Alert not delivered"). Rate limits: 20 messages an hour per channel and 60 an
hour through the email account (more wait, they are not dropped). Messages go out **while the guardian is locked**: the
secrets are sealed under a key file on the box, not the unlock passphrase.

### Server (where the guardian reads the blockchain)

| Method and path | Request | Response | Notes |
|---|---|---|---|
| `GET /api/chain` | none | `ChainSettings` | Unlocked. `source` (the RPC password never: `passSet`), `summary` (`own` or `public`), `origin` (`environment`: Umbrel, Start9 or `.env`; `settings`: chosen here), `platform` (TRIKEY_PLATFORM), `environment` (the summary of the source the platform set, when it set one), `nodeRpc` (the Bitcoin Core of BITCOIN_RPC_*: host, port, user, never the password), `status` (`connected`, `server`, `height`, `error`, Bitcoin Core's `rescans`, `mempoolUnseen` as in `GET /api/status`), the `publicServers` listed for the network, `recoveryRunning`. |
| `PUT /api/chain` | `ChainSourceInput` | `ChainSettings` | Unlocked. Switches at once. `electrum` `{ host, port?, tls, certSha256? }`; `core` `{ rpc: { host, port, user, pass? }, wallet? }` (leave `pass` out to keep the stored one, or to use `nodeRpc`'s, only for the same `host`, `port` and `user`: another port, even on the same host, needs `pass` again, `400`); `public` `{ preset }` or `{ host, port?, certSha256? }` (always TLS). `400 invalid` (plain TCP or RPC to an internet address, a pin without TLS, a "public" server on the owner's network, ...); `409 recovery_pending` for a public server while a recovery runs. Logged in Activity and announced to the paired phone (`chain_source_changed`) and on every alert channel. The source in use again (saved twice, the form unchanged) changes nothing: not logged, not announced, not pinned. |
| `DELETE /api/chain` | none | `ChainSettings` | Unlocked. "Use the server Umbrel set": forgets the choice made here (`chain-source.json`) and goes back to the `environment` source, which the guardian then follows again. Logged and announced like `PUT` when the server changes (nothing when it is the same one); `409 recovery_pending` when that source is a public server and a recovery runs (the environment's own node is always allowed); `404 not_found` when the environment sets no source. Nothing to do (`origin` already `environment`): `200`. |
| `POST /api/chain/test` | `ChainSourceInput` | `ChainTestResult` | Unlocked. "Test connection": connects (Electrum: and checks the server's network by its first block; Bitcoin Core: version 24+ and network, no wallet made) without switching. `{ ok, server?, height?, error? }`. |

### Recovery code

| Method and path | Response | Notes |
|---|---|---|
| `GET /api/recovery-code` | `RecoveryCode` | Unlocked only. The permanent "Recover on a new phone" code (with the current relays: after a relay change, print it again) for a phone that has neither the old phone nor its backup: `uri` (`trikey://recover?v=1&npub=…&relay=…&net=…&wallet=…`, PROTOCOL.md section 6; `wallet` lets the phone sign the wallet-bound `recovery.access` text) is what the QR code encodes. It carries **no secret** and does not expire (the hardware wallet's `recovery.access` signature is what lets a phone in), so the page offers to print it. `404 not_found` while no wallet is paired. |

### Pairing

| Method and path | Response | Notes |
|---|---|---|
| `POST /api/pairing` | `PairingSession` (`201`) | Unlocked only. Creates a one-time session and invalidates any earlier one. `uri` is what the QR code encodes (`trikey://pair?v=1&npub=…&relay=…&secret=…&exp=…`, PROTOCOL.md section 6): the guardian's nostr pubkey, its relays and a one-time secret. The secret expires after 5 minutes, allows 5 wrong attempts and is burned by a successful `pair`. `409 already_paired` while a wallet is active: the first phone to pair wins. Once that wallet is retired (`wallet.retire`, or a recovery to another guardian) or after a reset, pairing is open again; a retired wallet itself can never be paired again. |
| `GET /api/pairing/:id` | `PairingSession` | The UI polls this every 2 s while `status` is `waiting`. `status` moves to `paired` when a phone completes the `pair` method, or `expired` after `expiresAt` (or too many wrong attempts, or a lock). `404 not_found` for anything but the latest session. |
| `GET /api/phones` | `{ "phones": PairedPhone[] }` | Phones paired to this guardian (zero or one). `name` is the `deviceName` the phone sent. |

### Hosting for family

The guardian holds key 3 for people its owner knows (docs/design/family-hosting.md). "Host for someone" shows when
`GET /api/hosting` answers `available: true` (the old `VITE_FEATURE_HOST_FOR_SOMEONE` build flag is gone). The page
shows guests' names (the host's private names), states, dates and a weekly count of co-signed payments: **never an
amount, a balance or an address**, although the box stores the payments it co-signs for them (the disclosure says so).
All of these need an unlocked guardian.

| Method and path | Request | Response | Notes |
|---|---|---|---|
| `GET /api/hosting` | none | `HostingOverview` | `available` (false with `FAMILY_HOSTING=false`), `wallets` (`HostedWallet[]`: `invited`, `active`, `recovering` with `recoveryReadyAt`, `leaving` with `endsAt`, `ended`, `left`; `paused: true` while the guest's side paused it: one of their contacts sent `LOCK`, or their phone asked. Not who, and the host cannot resume it: only the guest's hardware wallet does), `pendingInvite` (the latest, **without** its link), `limits` (8 hosted wallets, 4 pending invites). |
| `POST /api/hosting/invites` | `{ name }` (1-64 characters) | `FamilyInvite` (`201`) | The only answer that carries the `trikey://invite?...` link: the guardian keeps a hash of its secret. Single use, 24 hours. `409 too_many_invites` (4 pending) or `too_many_wallets` (8). |
| `DELETE /api/hosting/invites/:id` | `{}` | `HostingOverview` | Cancels a pending invite (by invite id). `404` if it was accepted or is unknown. |
| `POST /api/hosting/wallets/:id/stop` | `{ now?: boolean, confirm?: string }` | `HostedWallet` | Without `now`: 30 days' notice (`leaving`, `endsAt`); the guest's phone and contacts are told (`hosting_ending`). With `now: true` and `confirm: "STOP HOSTING NOW"`: ends at once, the slot's key 3 is deleted (`ended`). `409 recovery_pending` while that wallet's recovery runs; `400 invalid` without the confirmation. |
| `DELETE /api/hosting/wallets/:id` | `{}` | `HostingOverview` | Removes an `ended` or `left` wallet from the list (`409 still_hosted` otherwise). |

`POST /api/reset` answers `409 hosting_active` while any guest wallet is hosted (a reset makes a new seed, so every
guest's key 3 would vanish): stop hosting first. Hosting events (invite made or cancelled, accepted, a guest's recovery
started, completed or cancelled, a guest's wallet paused or resumed, stopping, ended, a guest left) appear in
`GET /api/activity`, by name and date only.

## Running the UI

| Command | What it does |
|---|---|
| `npm run dev -w @trikey/guardian-web` | Dev server on port 5174 with the mock API. |
| `VITE_API=http npm run dev -w @trikey/guardian-web` | Dev server that proxies `/api` to `GUARDIAN_API_PROXY` (default `http://127.0.0.1:8787`). |
| `npm run build -w @trikey/guardian-web` | Production build in `dist/`. Uses the HTTP API unless `VITE_API=mock` is set. |

See `.env.example` for `VITE_API`, `VITE_API_BASE` and `GUARDIAN_API_PROXY`.

### Mock scenarios

The mock keeps state in memory (a reload starts over). Pick the starting state with
`?mock=` in the URL:

| URL | State |
|---|---|
| `/` | Unlocked, one phone paired, a week of activity |
| `/?mock=firstrun` | Brand-new box, setup wizard first |
| `/?mock=dockerfirstrun` | Brand-new guardian on plain Docker: the setup code first (the mock's is `7K3M-Q9TX-2HWB-F4NR`) |
| `/?mock=locked` | The box just restarted |
| `/?mock=recovery` | A Delay & Notify recovery is running |
| `/?mock=recoveryready` | The recovery's waiting period is over, but the guardian cannot complete it yet (`waitingFor`) |
| `/?mock=unpaired` | Set up, no phone paired yet |
| `/?mock=syncing` | Unlocked, node still syncing, one relay down |
| `/?mock=signedout` | Set up and locked, this browser not signed in: the sign-in screen |
| `/?mock=oldrelays` | Two old relays still watched after a change months ago; the phone switched |
| `/?mock=publicserver` | The guardian reads the chain from a public server (Settings > Server) |
| `/?mock=notify` | Email, ntfy, a webhook and a Telegram bot (with a chat for someone without nostr) set up in Settings > Notifications; the webhook is failing. In the mock a Telegram token starting with `000` is refused and one starting with `111` stands for a bot with a webhook set elsewhere |

The Wallet page (`/wallet?mock=…`) follows the scenario: the demo wallet (a pending payment in, two phone payments today) in most, no wallet yet with `unpaired`, a chain the guardian cannot read with `syncing`, no daily limit with `limitoff`, Savings with `savings`, read-only with `locked`. Its address is a golden vector of a wallet made of published test mnemonics on signet.

In the mock any unlock passphrase works except the literal `wrong` (also for the reset and as the current passphrase of a change). In dev, run
`trikeyMock.completePairing()` in the browser console to pretend a phone scanned
the current pairing code.
