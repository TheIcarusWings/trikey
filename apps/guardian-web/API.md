# Guardian web UI: HTTP API

This is the contract between `@trikey/guardian-web` and the guardian backend
(`apps/guardian/src/http/`). The UI only ever calls the endpoints below, through the
`GuardianApi` interface in `src/api/client.ts`. `src/api/http.ts` implements it with
`fetch`; `src/api/mock.ts` implements it in memory so the UI runs without a backend.

The TypeScript types in `src/api/types.ts` are the source of truth for every body.
The guardian re-exports them type-only (`apps/guardian/src/http/types.ts`), so a
change here that the server does not follow fails `npm run typecheck`. This file
lists the endpoints, status codes and behavior the types do not carry.

**Deployment.** The guardian does no user authentication itself. It must only be
reachable through the platform's authenticating proxy (Umbrel's `app_proxy`,
Start9's interface), never exposed beyond it.

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

  Codes: `bad_passphrase` (401), `rate_limited` (429, with `retryAfterSeconds` and a
  `Retry-After` header), `locked` (409), `setup_required` (409), `already_setup` (409),
  `already_paired` (409), `not_found` (404), `invalid` (400, 413 or 415), `forbidden`
  (403, a cross-origin request), `not_available` (501), `internal` (500). The UI
  reacts to the first few and shows any other code as a generic failure using `message`.
- Every response sends `Cache-Control: no-store` (API) and security headers: a CSP
  with `default-src 'self'` and no `'unsafe-inline'`, `X-Frame-Options: DENY`,
  `Referrer-Policy: no-referrer`, `X-Content-Type-Options: nosniff`.
- **State-changing requests** (`POST`, `DELETE`) must carry a JSON body with
  `Content-Type: application/json` (the client sends `{}` when it has nothing to
  send; anything else is `415`), and must be same-origin: the guardian checks
  `Sec-Fetch-Site: same-origin` when the browser sends it, else `Origin` against
  `Host` / `X-Forwarded-Host` (`403 forbidden`). Bodies are limited to 16 KiB.
- The UI is a single-page app with client-side routes (`/`, `/setup`, `/locked`,
  `/activity`, `/rules`, `/recovery`, `/pair`, `/host`). The guardian serves
  `index.html` for every non-`/api` path that is not a file in `dist/` (a missing
  file under `/assets/` is a `404`).
- A strict CSP works: the app has no inline scripts and loads all fonts and scripts
  from its own origin. QR codes are drawn locally. If a build ever adds an inline
  script to `index.html`, the guardian allows exactly that script by its hash.

## Which endpoints work when

| Guardian state | Allowed |
|---|---|
| Setup not complete | `GET /status`, `GET /setup/preflight`, `POST /setup` |
| Locked | `GET /status`, `POST /unlock` |
| Unlocked | everything |

Anything else answers `409 locked` (or `409 setup_required` before setup;
`409 already_setup` for the setup endpoints afterwards). The UI reads `GET /status`
first and shows the matching screen, and polls it every 15 s (every 3 s on the locked
screen, so an unlock from the phone shows up quickly). The guardian is locked after
every start of its process.

## Endpoints

### Status and lifecycle

| Method and path | Request | Response | Notes |
|---|---|---|---|
| `GET /api/status` | none | `GuardianStatus` | Always available. `setupComplete`, `state` (`locked` or `unlocked`), `lockedAt` and `lockReason` (`restart` or `manual`) while locked, `relays[]` (with live connection state), `chain` (`synced` once Electrs answers, `syncing` with `progress` when Bitcoin Core RPC reports initial block download, else `unavailable`; `height`), `wallets[]` (zero or one: the engine holds one wallet), `dailySpend`, `recoveryInProgress`, and `phoneSpending`, `network`, `npub`, `version`. |
| `GET /api/setup/preflight` | none | `SetupPreflight` | First run only. `electrs` is `found` when Electrs answers; `node` is `found` when Bitcoin Core RPC answers (or, without RPC settings, when Electrs does). The relay choices to offer. |
| `POST /api/setup` | `{ passphrase, relays: string[] }` | `GuardianStatus` | First run only. Creates key 3 (a fresh BIP39 seed; the BIP48 account key), encrypts it under an Argon2id key from the passphrase, connects the chosen relays. The guardian ends up unlocked. `400 invalid` if `relays` is empty, has more than 8 entries or a URL that is not `wss://` (or `ws://` on a local host), or the passphrase has fewer than 12 characters. There is no backup of key 3, by design. |
| `POST /api/unlock` | `{ passphrase }` | `GuardianStatus` | `401 bad_passphrase` on a wrong passphrase (with `retryAfterSeconds` once the next try has to wait). Rate limited with exponential backoff after 3 failures (`429 rate_limited`); the count survives restarts and is shared with the phone's `guardian.unlock`. Unlocking takes a few seconds on a Raspberry Pi (Argon2id). |
| `POST /api/lock` | `{}` | `GuardianStatus` | Drops key 3 from memory and invalidates a pairing code in progress. The phone gets a `guardian_locked` alert. |

**Passphrase handling.** The UI sends the passphrase in exactly one request body.
It is held in component state only while the form is open, cleared as soon as the
request settles, and never written to storage, the URL or logs. The guardian never
logs request bodies.

### Activity and rules

| Method and path | Response | Notes |
|---|---|---|
| `GET /api/activity?limit=100` | `{ "entries": ActivityEntry[] }` | Newest first. `limit` defaults to 100 and is capped at 500. Entries merge the policy engine's log (ids `e…`) and the service's (ids `s…`: unlocks, pairing, broadcasts, why a recovery is waiting). The UI filters by `kind` itself. |
| `GET /api/rules` | `Rules` | Read-only. The guardian changes rules only via the phone app over nostr (`policy.update`), so the UI has no write endpoint. `404 not_found` before a wallet is paired. `sweepFeeCapSats` is the absolute fee cap the engine enforces. Contacts are named by their shortened `npub` (the guardian knows no names). |

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

### Pairing

| Method and path | Response | Notes |
|---|---|---|
| `POST /api/pairing` | `PairingSession` (`201`) | Unlocked only. Creates a one-time session and invalidates any earlier one. `uri` is what the QR code encodes (`trikey://pair?v=1&npub=…&relay=…&secret=…&exp=…`, PROTOCOL.md section 6): the guardian's nostr pubkey, its relays and a one-time secret. The secret expires after 5 minutes, allows 5 wrong attempts and is burned by a successful `pair`. `409 already_paired` once a wallet is registered: the first phone to pair wins. |
| `GET /api/pairing/:id` | `PairingSession` | The UI polls this every 2 s while `status` is `waiting`. `status` moves to `paired` when a phone completes the `pair` method, or `expired` after `expiresAt` (or too many wrong attempts, or a lock). `404 not_found` for anything but the latest session. |
| `GET /api/phones` | `{ "phones": PairedPhone[] }` | Phones paired to this guardian (zero or one). `name` is the `deviceName` the phone sent. |

### Hosting for family (later feature)

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
| `/?mock=unpaired` | Set up, no phone paired yet |
| `/?mock=syncing` | Unlocked, node still syncing, one relay down |

In the mock any unlock passphrase works except the literal `wrong`. In dev, run
`trikeyMock.completePairing()` in the browser console to pretend a phone scanned
the current pairing code.
