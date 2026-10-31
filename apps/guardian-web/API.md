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
after 30 minutes without a request, 12 hours after sign-in, at sign-out, at a reset, and
when the guardian restarts. Without one, everything else answers `401 unauthenticated`.

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

  Codes: `unauthenticated` (401, no session: sign in), `bad_passphrase` (401), `rate_limited` (429, with `retryAfterSeconds` and a
  `Retry-After` header), `locked` (409), `setup_required` (409), `already_setup` (409),
  `already_paired` (409), `recovery_pending` (409), `sweep_pending` (409), `not_found` (404), `invalid` (400, 413 or 415), `forbidden`
  (403, a cross-origin request), `not_available` (501), `internal` (500). The UI
  reacts to the first few and shows any other code as a generic failure using `message`.
- Every response sends `Cache-Control: no-store` (API) and security headers: a CSP
  with `default-src 'self'` and no `'unsafe-inline'`, `X-Frame-Options: DENY`,
  `Referrer-Policy: no-referrer`, `X-Content-Type-Options: nosniff`.
- **State-changing requests** (`POST`, `PUT`, `DELETE`) must carry a JSON body with
  `Content-Type: application/json` (the client sends `{}` when it has nothing to
  send; anything else is `415`), and must be same-origin: the guardian checks
  `Sec-Fetch-Site: same-origin` when the browser sends it, else `Origin` against
  `Host` / `X-Forwarded-Host` (`403 forbidden`). Bodies are limited to 16 KiB.
- The UI is a single-page app with client-side routes (`/` Home, `/setup`, `/sign-in`, `/locked`,
  `/activity`, `/rules`, `/recovery`, `/phones`, `/settings`, `/reset`; `/pair` and `/recover-phone`
  redirect to `/phones`; `/host` exists only in a build with `VITE_FEATURE_HOST_FOR_SOMEONE=true`). The guardian serves
  `index.html` for every non-`/api` path that is not a file in `dist/` (a missing
  file under `/assets/` is a `404`).
- **Password managers.** The passphrase works with them (Proton Pass, 1Password, Bitwarden,
  iCloud Keychain, Google): set-up, unlock, sign-in and reset are real `<form>`s with a submit
  button, the passphrase fields say `current-password` or `new-password`, and each form carries
  the same fixed user name (`username`, "Trikey Guardian", off-screen and out of the tab order) so
  one saved entry fills them all. Set-up's two `new-password` fields carry a `passwordrules` hint
  (at least 12 characters, any printable), so a generated passphrase fills both. Passkeys need HTTPS:
  WebAuthn does not run on a plain-HTTP address other than `localhost`.
- A strict CSP works: the app has no inline scripts and loads all fonts and scripts
  from its own origin. QR codes are drawn locally. If a build ever adds an inline
  script to `index.html`, the guardian allows exactly that script by its hash.

## Which endpoints work when

| Guardian state | Allowed |
|---|---|
| Setup not complete | `GET /status`, `GET /setup/preflight`, `POST /setup` (no session needed; setup signs the browser in) |
| No session (after setup) | `GET /status` (as `PublicStatus`), `POST /session`, `DELETE /session` |
| Locked, signed in | `GET /status`, `POST /unlock`, `POST /reset`, the session endpoints |
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
| `GET /api/status` | none | `GuardianStatus` or `PublicStatus` | Always available. Without a session (after setup) only `PublicStatus`: `authenticated: false`, `setupComplete`, `state`, `network`, `version`. With one (`authenticated: true`): `setupComplete`, `state` (`locked` or `unlocked`), `lockedAt` and `lockReason` (`restart`, `manual` from this UI, or `remote` from the paired phone's `guardian.lock`) while locked, `relays[]` (with live connection state), `chain` (`synced` once Electrs answers, `syncing` with `progress` when Bitcoin Core RPC reports initial block download, else `unavailable`; `height`), `wallets[]` (zero or one: the engine guards one active wallet), `retiredWallets[]` (wallets it guarded before, read-only history: `reason` `recovered` with the `successorId` it guards now, or `retired`), `hardwareConfirmRequired` (after the guardian took over a recovered wallet, until the phone confirms the hardware wallet), `dailySpend` (`usedSats`, `limitSats`, and `limitOff: true` while there is no daily limit), `recoveryInProgress`, and `phoneSpending`, `network`, `npub`, `version`, `warnings?` (`no_alert_contacts`: a recovery would be announced only to the paired phone; mainnet guardians refuse that, test networks warn). |
| `POST /api/session` | `{ passphrase, unlock? }` | `GuardianStatus` | Signs the browser in (sets the session cookie). With `unlock: true` a locked guardian is unlocked by the same passphrase (that attempt counts against the unlock's rate limit). `401 bad_passphrase`, `429 rate_limited`: sign-in has its own rate limit (exponential backoff after 3 failures, persisted), which neither the unlock, the reset nor the phone's `guardian.unlock` shares. |
| `DELETE /api/session` | `{}` | `PublicStatus` | Signs the browser out (clears the cookie). |
| `GET /api/setup/preflight` | none | `SetupPreflight` | First run only. `electrs` is `found` when Electrs answers; `node` is `found` when Bitcoin Core RPC answers (or, without RPC settings, when Electrs does). The relay choices to offer. |
| `POST /api/setup` | `{ passphrase, relays: string[], entropy? }` | `GuardianStatus` | First run only. Creates key 3 (a fresh BIP39 seed; the BIP48 account key), encrypts it under an Argon2id key from the passphrase, connects the chosen relays. The guardian ends up unlocked. `entropy`: 32 bytes from the browser's `crypto.getRandomValues` as 64 lowercase hex characters, mixed into the new seed with the guardian's own (DESIGN.md, "Entropy", `trikey/guardian-seed/v1`); never logged or stored. The UI always sends it; it is optional for other clients. `400 invalid` if `relays` is empty, has more than 8 entries or a URL that is not `wss://` (or `ws://` on a local host), the passphrase has fewer than 12 characters, or `entropy` is present but not exactly 64 lowercase hex characters. There is no backup of key 3, by design. |
| `POST /api/unlock` | `{ passphrase }` | `GuardianStatus` | `401 bad_passphrase` on a wrong passphrase (with `retryAfterSeconds` once the next try has to wait). Rate limited with exponential backoff after 3 failures (`429 rate_limited`); the count survives restarts. The phone's `guardian.unlock`, the reset and the sign-in each have their own count, so a stolen phone guessing away never delays this UI (security review 2026-10, finding 4). Unlocking takes a few seconds on a Raspberry Pi (Argon2id). |
| `POST /api/lock` | `{}` | `GuardianStatus` | Drops key 3 from memory and invalidates a pairing code in progress. The phone gets a `guardian_locked` alert. |
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

**Passphrase handling.** The UI sends the passphrase in exactly one request body.
It is held in component state only while the form is open, cleared as soon as the
request settles, and never written to storage, the URL or logs. The guardian never
logs request bodies.

### Activity and rules

| Method and path | Response | Notes |
|---|---|---|
| `GET /api/activity?limit=100` | `{ "entries": ActivityEntry[] }` | Newest first. `limit` defaults to 100 and is capped at 500. Entries merge the policy engine's log (ids `e…`) and the service's (ids `s…`: unlocks, pairing, broadcasts, why a recovery is waiting). The UI filters by `kind` itself. |
| `GET /api/rules` | `Rules` | Read-only. The guardian changes rules only via the phone app over nostr (`policy.update`), so the UI has no write endpoint. `404 not_found` before a wallet is paired. `sweepFeeCapSats` is the absolute fee cap the engine enforces. `dailyLimitOff: true` while there is no daily limit (the phone turned it off with a hardware approval; `dailyLimitSats` is then the protocol maximum, 21 million BTC, and should not be shown as a number). Contacts are named by their shortened `npub` (the guardian knows no names). |

`ActivityEntry.result` is one of `co-signed`, `refused`, `locked`, `ok`,
`rule-changed`. `kind` is one of `payment`, `recovery`, `rules`, `system`.
`summary` is optional; the dashboard shows it instead of `event` when present.

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

### Hosting for family (later feature)

The UI hides "Host for someone" (no navigation entry, no route) until this works: build with
`VITE_FEATURE_HOST_FOR_SOMEONE=true` to see it.

The engine holds a single wallet, so hosting is not available yet.

| Method and path | Request | Response | Notes |
|---|---|---|---|
| `GET /api/hosting` | none | `HostingOverview` | Answers `{ "wallets": [], "pendingInvite": null }` for now. |
| `POST /api/hosting/invites` | `{ name }` | `501 not_available` | When it exists: `FamilyInvite` (`201`); `name` is private to the host; the one-time link expires after 24 hours. |
| `DELETE /api/hosting/invites/:id` | `{}` | `501 not_available` | When it exists: `204`, cancels a pending invite. |

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
| `/?mock=locked` | The box just restarted |
| `/?mock=recovery` | A Delay & Notify recovery is running |
| `/?mock=recoveryready` | The recovery's waiting period is over, but the guardian cannot complete it yet (`waitingFor`) |
| `/?mock=unpaired` | Set up, no phone paired yet |
| `/?mock=syncing` | Unlocked, node still syncing, one relay down |
| `/?mock=signedout` | Set up and locked, this browser not signed in: the sign-in screen |
| `/?mock=oldrelays` | Two old relays still watched after a change months ago; the phone switched |

In the mock any unlock passphrase works except the literal `wrong` (also for the reset). In dev, run
`trikeyMock.completePairing()` in the browser console to pretend a phone scanned
the current pairing code.
