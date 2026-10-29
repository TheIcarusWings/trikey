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

## What the mobile app needs to know

`@trikey/wallet` implements all of this; this is the contract it relies on.

- **Pairing** is `pair.prepare` then `pair` with the secret from the QR code
  (PROTOCOL.md, "Pairing"). Keys in the descriptor are in the order phone,
  hardware wallet, guardian, all at BIP 48 `m/48'/<coin>'/0'/2'`; the wallet
  id is the descriptor's `MultisigWallet.fingerprint()`.
- **The hardware authorization key** (the single-sig key that signs the
  pairing proof and every approval with BIP 137) is the hardware wallet's key
  at `m/48'/<coin>'/0'/2'/0/0`, below its multisig account by non-hardened
  steps. For any such path the guardian checks at pairing that the key
  derives from the hardware xpub in the descriptor. A new phone without a
  backup must find the same key again, so the path is fixed, not chosen.
- **Chain data** comes from the guardian, never from public servers:
  `wallet.sync`, `tx.get`, `tx.broadcast` and `fees.estimate` work while the
  guardian is locked, for the paired phone only. `tx.broadcast` relays only
  transactions that spend the wallet's own coins.
- **Co-signing** (`sign`) needs `nonWitnessUtxo` on every input, the phone's
  signature alone, and an unlocked guardian; the daily limit counts outflow
  plus fee over a rolling 24 h. `guardian.status.dailyLimit` is the count.
- **Recovery without the old phone or a backup**: the new phone's nostr key
  is unknown here, so the hardware wallet vouches for it with a
  `recovery.access` signature over the guardian's and the new phone's nostr
  keys. That phone may then read the wallet and start a recovery for the
  access period (at most 24 h, renewable); every grant appears in the activity
  log. The sweep must spend every coin and keep the surviving key.
- **After a restart** a state-changing request the guardian handled before
  can come back as `1501`: re-read the state and send a new request if the
  change is not there.

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
and alert contact, all on regtest with throwaway keys; `test/chain-methods.e2e.test.ts`
covers the chain methods and recovery access.

`test/support/` (exported as `@trikey/guardian/testing`) holds the fake Electrs and
`GuardianRig`, which runs the real service in-process for other packages' tests
(`@trikey/wallet` uses it).
