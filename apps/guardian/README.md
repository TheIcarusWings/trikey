# Trikey Guardian

Key 3 of a Trikey 2-of-3 wallet, running on the user's own Umbrel or Start9. It
co-signs phone payments under a daily limit, runs Delay & Notify recovery, and
talks to the phone and alert contacts over nostr. See `DESIGN.md` at the repository
root for the why, `packages/protocol/PROTOCOL.md` for the wire protocol and
`apps/guardian-web/API.md` for the web UI's API.

## Do not expose it

The guardian has no user authentication of its own. Its HTTP port must only be
reachable through the platform's authenticating proxy (Umbrel's `app_proxy`,
Start9's interface). Anyone who can reach the port directly can lock the guardian,
create pairing codes and read its activity log, and a DNS-rebinding page in the
user's browser would pass its same-origin checks. Do not publish the port on the
LAN or the internet.

Network use: outbound `wss://` to the nostr relays chosen at setup (and alert
contacts' NIP-17 inbox relays, `wss://` only), TCP to Electrs and optionally HTTP to
Bitcoin Core on the platform's internal network. The only inbound traffic is HTTP
on `PORT`.

## Running

```sh
node --import tsx apps/guardian/src/main.ts
```

| Variable | Default | |
|---|---|---|
| `PORT` | `3000` | HTTP (web UI and `/api`) |
| `TRIKEY_DATA_DIR` | `/data` | State, see below |
| `TRIKEY_WEB_DIR` | none | The built web UI (`apps/guardian-web/dist`) |
| `ELECTRUM_HOST`, `ELECTRUM_PORT` | none, `50001` | Electrs, plain TCP. Without it, recoveries cannot complete. |
| `BITCOIN_RPC_HOST`, `_PORT`, `_USER`, `_PASS` | none | Optional: sync progress and a broadcast fallback |
| `BITCOIN_NETWORK` | `bitcoin` | `bitcoin`, `testnet`, `signet`, `regtest`; also `mainnet`, `main`, `testnet3`, `testnet4`, `test` |
| `TRIKEY_LOG_LEVEL` | `info` | `debug` for more |

For the web UI's dev server (`VITE_API=http`), run the guardian with `PORT=8787` or
set `GUARDIAN_API_PROXY`.

The guardian refuses to start if `BITCOIN_NETWORK` differs from the network key 3
or the paired wallet was created for.

## State

All files in `TRIKEY_DATA_DIR` are mode 0600 and written atomically.

| File | Holds |
|---|---|
| `keystore.json` | Key 3: a BIP39 seed encrypted with XChaCha20-Poly1305 under Argon2id(passphrase), m = 64 MiB, t = 3, p = 1. Never overwritten. There is no backup, by design. |
| `nostr-identity.json` | The guardian's nostr key, **unencrypted** so a locked guardian can still answer the phone and send alerts (trade-off in `src/identity.ts`). |
| `guardian-state.json` | The policy engine: registration, rules, limit accounting, recoveries, activity. |
| `service.json` | Relays, the paired phone's name, co-signed sweeps and their broadcast state, the service log, recently handled request ids. |
| `unlock-throttle.json` | Failed unlock attempts (exponential backoff after 3, up to 1 hour). |

After every start the guardian is locked: key 3 is decrypted only by an unlock
(web UI or `guardian.unlock` from the paired phone) and kept only in memory.

## Layout

```
src/
  main.ts             entry point: config, start, SIGTERM
  config.ts           environment
  guardian.ts         the service: lifecycle, setup, lock/unlock, nostr authorization, tick
  keystore.ts         key 3 at rest (Argon2id + XChaCha20-Poly1305), KeystoreSigner
  unlock-throttle.ts  persistent unlock rate limit
  identity.ts         the guardian's nostr key
  pairing.ts          one-time pairing sessions
  alerts.ts           Delay & Notify alerts: protocol notifications + NIP-17 DMs
  dm-cancel.ts        "CANCEL <id>" replies from alert contacts
  recovery-runner.ts  completing a recovery: chain time, UTXO coverage, broadcast
  service-state.ts    service.json
  observed-store.ts   read-only view of the engine's saved state
  nostr/              RPC handlers, wire conversions, NIP-17 DMs
  chain/              Electrum client, headers, Bitcoin Core RPC, ChainService
  http/               HTTP server (headers, origin checks, static), API routes
  policy/             the policy engine (pure decisions, no I/O)
```

## Tests

`npm test -w @trikey/guardian`. `test/guardian.e2e.test.ts` runs the real service
with a temp data dir, two in-memory relays, a fake Electrs and a simulated phone
and alert contact, all on regtest with throwaway keys.
