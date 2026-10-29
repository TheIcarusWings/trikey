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
create pairing codes and read its activity log (resetting it also needs the
unlock passphrase), and a DNS-rebinding page in the
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
| `BITCOIN_RPC_HOST`, `_PORT`, `_USER`, `_PASS` | none | Optional: sync progress, a broadcast fallback, and the silent payment scanner (`getblock <hash> 3`; without them `sp.*` answers `1700`) |
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
| `keystore.json` | The setup seed key 3 comes from: a BIP39 seed encrypted with XChaCha20-Poly1305 under Argon2id(passphrase), m = 64 MiB, t = 3, p = 1. A wallet paired with the phone's contribution (`pair.prepare` `entropy`) gets key 3 from this seed and that contribution (`trikey/key3/v1`, `src/keystore.ts`); the contribution is kept with the registration in `guardian-state.json`. Never overwritten, except by the web UI's reset, which replaces key 3 on purpose. There is no backup, by design. |
| `nostr-identity.json` | The guardian's nostr key, **unencrypted** so a locked guardian can still answer the phone and send alerts (trade-off in `src/identity.ts`). |
| `guardian-state.json` | The policy engine, format version 2: the active wallet (registration, rules, limit accounting, recovery access grants), retired wallets, recoveries, activity. A version-1 file (one wallet) is migrated when it is loaded and written back as version 2. |
| `service.json` | Relays, the paired phone's name, co-signed sweeps and their broadcast state, the service log, recently handled request ids. (Recovery access grants used to live here; they are moved into the engine on start.) |
| `unlock-throttle.json` | Failed unlock attempts (exponential backoff after 3, up to 1 hour). |
| `silent-payments.json` | The silent payment scanner: the paired phone's registration (B_spend, labels, birth height, the scan key **encrypted**), the last scanned blocks' hashes (for reorgs) and the matches. No spending key. |
| `silent-payments-key.json` | The random key the scan key is encrypted under, **not** under the passphrase, so scanning goes on while the guardian is locked (the scan key finds payments, it cannot spend them; see `src/silent/service.ts`). |

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
  transactions that spend the wallet's own coins, or sweep the wallet it
  replaced into it (below), at most 20 per 10 minutes per phone. Alerts and
  `guardian.status` carry `atMs` (milliseconds) next to the seconds.
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
- **After a recovery the guardian guards the new wallet** (PROTOCOL.md,
  "Wallet rotation"), once the sweep is broadcast: the phone that sent
  `recovery.start` is now the paired phone and gets a `wallet_adopted`
  alert; `guardian.status` carries the new `walletId`. Before any hardware
  approval the phone must send `hardware.confirm` with the authorization
  key and a fresh pairing proof over the new wallet id (until then `1209`).
  The old wallet is retired: everything for it is refused (`1004`).
- **Replace guardian**: `wallet.retire` with a `retire-wallet` approval on
  the old guardian (if it still runs), then pair the new guardian as usual
  with a new descriptor (`replacesWalletId` names the old one). Send the old
  wallet's descriptor as `replacesDescriptor` too and the new guardian
  *watches* it (no co-signing, no recovery): `wallet.sync` with
  `wallet: "replaced"` lists its coins (stray deposits included), `tx.get`
  serves their transactions, and `tx.broadcast` relays the phone's signed sweep
  of them into the new wallet when the old box is gone. The sweep must spend
  only the old wallet's coins, pay only the new wallet's addresses and stay
  under the sweep fee cap. `wallet.unwatch` ends it.
- **Rotation after a recovery**: the phone that was paired to the swept
  wallet gets `wallet_retired` (`recovered`) when another phone is adopted.
- **Remote lock**: `guardian.lock` from the paired phone, answered
  `{ state: "locked" }`, alert `guardian_locked` with reason `remote`.
- **Silent payments** (DESIGN.md, "Silent payments"; PROTOCOL.md, "Silent payments"):
  `singlekey.register` with the helper account (`m/84'/<coin>'/1'` KeyOrigin) makes
  `sign` accept one finalized P2WPKH helper input of that account in a PSBT with a
  taproot output (the limit counts only what leaves the vault) and `wallet.sync`
  serve it (`wallet: "helper"`). `sp.register` with the scan key, `B_spend`, labels
  (with 0) and the birth height starts the scanner; `sp.scan` returns matches,
  `sp_received` announces new ones, `sp.unregister` stops it. `tx.broadcast`
  relays a sweep of matches, registered coins and the helper coin into the vault
  (every output to the vault, fee within the sweep fee cap).
  `test/support/wallet-adapters.ts` is the reference for the wallet's side.
- **Recovery code**: the web UI's "Recover on a new phone" QR code is
  `trikey://recover?v=1&npub=...&relay=...&net=...` (`decodeRecoveryUri`),
  no secret; it gives a new phone the npub and relays for `recovery.access`.

## Layout

```
src/
  main.ts             entry point: pins the random source, config, start, SIGTERM
  pin-random.ts       pins node:crypto's webcrypto.getRandomValues for secureRandomBytes
  config.ts           environment
  guardian.ts         the service: lifecycle, setup, lock/unlock, nostr authorization, tick
  keystore.ts         key 3 at rest (Argon2id + XChaCha20-Poly1305), the trikey/key3/v1 mix, KeystoreSigner
  unlock-throttle.ts  persistent unlock rate limit
  rate-limit.ts       per-phone sliding-window limit for tx.broadcast
  identity.ts         the guardian's nostr key
  pairing.ts          one-time pairing sessions
  alerts.ts           Delay & Notify alerts: protocol notifications + NIP-17 DMs
  dm-cancel.ts        "CANCEL <id>" replies from alert contacts
  recovery-runner.ts  completing a recovery: chain time, UTXO coverage, broadcast
  service-state.ts    service.json
  observed-store.ts   read-only view of the engine's saved state
  nostr/              RPC handlers, wire conversions, NIP-17 DMs, the shared inbox (each wrap opened once)
  chain/              Electrum client, headers, Bitcoin Core RPC, ChainService
  silent/             the silent payment scanner: block scanning (scan.ts), registration, storage, reorgs (service.ts)
  singlekey.ts        the phone's single-key coins: the helper account (P2WPKH derivation, lookup)
  http/               HTTP server (headers, origin checks, static), API routes
  policy/             the policy engine (pure decisions, no I/O)
```

## Tests

`npm test -w @trikey/guardian`. `test/guardian.e2e.test.ts` runs the real service
with a temp data dir, two in-memory relays, a fake Electrs and a simulated phone
and alert contact, all on regtest with throwaway keys; `test/chain-methods.e2e.test.ts`
covers the chain methods and recovery access; `test/silent-payments.e2e.test.ts`
runs the real phone wallet (`@trikey/wallet`) against the guardian for silent payments
(co-signing with the helper coin, the scanner over a fake Bitcoin Core RPC with a
reorg, sweeps). `test/sp-perf.test.ts` measures the scanner (`SP_PERF_TXS=2000` for a
full-size block).

`test/support/` (exported as `@trikey/guardian/testing`) holds the fake Electrs, the
fake Bitcoin Core RPC (`FakeBitcoind`, `getblock <hash> 3` with prevouts) and
`GuardianRig` (`bitcoind: true` adds the node RPC), which runs the real service
in-process for other packages' tests (`@trikey/wallet` uses it).
