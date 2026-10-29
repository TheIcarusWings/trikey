# Guardian web UI: HTTP API

This is the contract between `@trikey/guardian-web` and the guardian backend. The UI
only ever calls the endpoints below, through the `GuardianApi` interface in
`src/api/client.ts`. `src/api/http.ts` implements it with `fetch`; `src/api/mock.ts`
implements it in memory so the UI runs without a backend.

The TypeScript types in `src/api/types.ts` are the source of truth for every body.
This file lists the endpoints, status codes and behavior the types do not carry.

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

  Codes the UI reacts to: `bad_passphrase` (401), `rate_limited` (429, with an
  optional `retryAfterSeconds`), `locked` (409), `not_found` (404), `invalid` (400).
  Any other code is shown as a generic failure using `message`.
- Responses must send `Cache-Control: no-store`.
- Mutating requests (`POST`, `DELETE`) only accept `application/json`, which keeps
  plain cross-site HTML forms from reaching them. Also check `Origin` against the
  box's own host.
- The UI is a single-page app with client-side routes (`/`, `/setup`, `/locked`,
  `/activity`, `/rules`, `/recovery`, `/pair`, `/host`). Serve `index.html` for every
  non-`/api` path that is not a file in `dist/`.
- A strict CSP works: the app has no inline scripts and loads all fonts and scripts
  from its own origin. QR codes are drawn locally.

## Which endpoints work when

| Guardian state | Allowed |
|---|---|
| Setup not complete | `GET /status`, `GET /setup/preflight`, `POST /setup` |
| Locked | `GET /status`, `POST /unlock` |
| Unlocked | everything |

Anything else answers `409 locked` (or `409 setup_required` before setup). The UI
reads `GET /status` first and shows the matching screen, and polls it every 15 s
(every 3 s on the locked screen, so an unlock from the phone shows up quickly).

## Endpoints

### Status and lifecycle

| Method and path | Request | Response | Notes |
|---|---|---|---|
| `GET /api/status` | none | `GuardianStatus` | Always available. `setupComplete`, `state` (`locked` or `unlocked`), `lockedAt` and `lockReason` while locked, `relays[]`, `chain`, `wallets[]`, `dailySpend`, `recoveryInProgress`. |
| `GET /api/setup/preflight` | none | `SetupPreflight` | First run only. Node and Electrs detection, sync state, and the relay choices to offer. |
| `POST /api/setup` | `{ passphrase, relays: string[] }` | `GuardianStatus` | First run only. Creates key 3, encrypts it under an Argon2id key from the passphrase, connects the chosen relays. The guardian ends up unlocked. `400 invalid` if `relays` is empty or the passphrase is too short (the UI requires at least 12 characters). |
| `POST /api/unlock` | `{ passphrase }` | `GuardianStatus` | `401 bad_passphrase` on a wrong passphrase. Rate limit this (`429 rate_limited`). |
| `POST /api/lock` | none | `GuardianStatus` | Drops key 3 from memory. |

**Passphrase handling.** The UI sends the passphrase in exactly one request body.
It is held in component state only while the form is open, cleared as soon as the
request settles, and never written to storage, the URL or logs. The backend must not
log request bodies for `/api/setup` and `/api/unlock`.

### Activity and rules

| Method and path | Response | Notes |
|---|---|---|
| `GET /api/activity?limit=100` | `{ "entries": ActivityEntry[] }` | Newest first. `limit` defaults to 100; the server may cap it. The UI filters by `kind` itself. |
| `GET /api/rules` | `Rules` | Read-only. The guardian changes rules only via the phone app over nostr (`policy.update`), so the UI has no write endpoint. |

`ActivityEntry.result` is one of `co-signed`, `refused`, `locked`, `ok`,
`rule-changed`. `kind` is one of `payment`, `recovery`, `rules`, `system`.
`summary` is optional; the dashboard shows it instead of `event` when present.

### Recovery

| Method and path | Response | Notes |
|---|---|---|
| `GET /api/recovery` | `{ "recovery": RecoveryInProgress \| null }` | `null` when no Delay & Notify recovery is running. |
| `POST /api/recovery/:id/cancel` | `204` | Cancels the running recovery and re-enables phone-only payments. `404 not_found` if `:id` is not the running recovery. Logs an activity entry. |

### Pairing

| Method and path | Response | Notes |
|---|---|---|
| `POST /api/pairing` | `PairingSession` (`201`) | Creates a one-time session and invalidates any earlier one. `uri` is what the QR code encodes: the guardian's nostr pubkey, its relays and a one-time code. Suggested lifetime 5 minutes. |
| `GET /api/pairing/:id` | `PairingSession` | The UI polls this every 2 s while `status` is `waiting`. `status` moves to `paired` when a phone completes the `pair` method, or `expired` after `expiresAt`. |
| `GET /api/phones` | `{ "phones": PairedPhone[] }` | Phones paired to this guardian. |

### Hosting for family (later feature)

| Method and path | Request | Response | Notes |
|---|---|---|---|
| `GET /api/hosting` | none | `HostingOverview` | `wallets[]` (active and invited) and the latest `pendingInvite`, if still valid. The host never sees balances or amounts. |
| `POST /api/hosting/invites` | `{ name }` | `FamilyInvite` (`201`) | `name` is private to the host. The one-time link expires after 24 hours. Also adds an `invited` entry to `wallets`. |
| `DELETE /api/hosting/invites/:id` | none | `204` | Cancels a pending invite and drops its `invited` wallet entry. |

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
