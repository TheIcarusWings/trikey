# Security review, October 2026: findings and fixes

An independent review of the Trikey Guardian (the code that holds key 3) found the issues below.
Each one is fixed, and each proof of concept the reviewer wrote is now a regression test that fails
on the code before the fix and passes after it. All tests use regtest (one engine test builds a
mainnet descriptor from published test mnemonics and never touches a network) and throwaway keys.

| # | Severity | Finding | Fix | Regression test |
|---|---|---|---|---|
| 1 | HIGH | **Hidden change past the gap limit.** Any output to a derived vault address with index ≤ 100,000 counted as change, while coverage and `wallet.sync` scan with gap limit 20: a phone-only thief could move the whole vault to change index 99,999 for the fee, and a recovery then "completed" with the coin stranded. | Persisted per-chain high-water marks (highest index seen used on chain or co-signed). An output is change only within 20 of its chain's mark; anything further counts as outflow. The marks rise with co-signed change and with what `wallet.sync` finds (incoming payments to fresh addresses), and coverage, `wallet.sync` and the broadcast relay check scan at least to them. An adopted wallet starts from its sweep's outputs. | `apps/guardian/test/security/hidden-change.test.ts` |
| 2a | HIGH | **Clock trust, recovery start.** `readyAt = now + delay` on the system clock: a clock set back during `recovery.start` shortened the delay unseen. | `readyAt = max(clock, chain MTP) + delay`; the start height is stored; completion needs MTP ≥ `readyAt`, height ≥ start + delay × 144 (× 1 on regtest, where blocks are mined on demand) and the clock ≥ `readyAt`, checked by the engine and reported by the runner. No chain data at start: refused (`chain_unavailable`). The "started" alert counts days from the anchored start. | `apps/guardian/test/security/clock-trust.test.ts` |
| 2b | HIGH | **Clock trust, limit window.** Stepping the clock forward opened a fresh 24 h window per step. | The engine refuses to co-sign while the clock is more than 3 h ahead of the chain's MTP (`clock_ahead_of_chain`; without any chain observation `chain_unavailable`), and keeps a persisted monotonic window time that never goes backwards. The existing guard for a clock moved back stays. | `apps/guardian/test/security/clock-trust.test.ts` |
| 3 | MEDIUM | **Re-pairing a retired key set** under a different descriptor (other origin fingerprint), with an authorization key of the pairer's choosing: retirement was checked by descriptor hash, inputs are matched by account pubkeys plus delegated tweaks. | Wallets are compared by their sorted set of account pubkeys at registration, recovery destinations and rotation (chaincodes deliberately not part of it: tweaks are delegated, so another chaincode does not change what key 3 signs; a role swap is caught too). The hardware authorization key must be a non-hardened child of the hardware account (the wallet's `m/48'/c'/0'/2'/0/0`); any other path is refused at pairing and at `hardware.confirm`. | `apps/guardian/test/security/repair-retired.test.ts` |
| 4 | MEDIUM | **A stolen phone could starve unlock**: phone `guardian.unlock` and the web UI shared one throttle. | Separate persisted throttles for the phone's unlock, the web unlock, the reset (and the new web sign-in). The phone may not unlock after 5 failures in a row until a web unlock, nor while a recovery it did not start is pending or ready. `guardian.lock` from the phone stays allowed. | `apps/guardian/test/security/unlock-starvation.test.ts` |
| 5 | MEDIUM (design) | **No alert contacts** meant only the (possibly stolen) phone heard of a recovery. | On mainnet a pairing needs at least one alert contact and no rule change may remove the last one (even with a hardware approval). Test networks allow zero and report `warnings: ['no_alert_contacts']` in `policy.get`, `guardian.status` and `GET /api/status` (the web dashboard shows it). `DESIGN.md` says a contact can be the user's own nostr app on another device. | `apps/guardian/test/security/alert-contacts.test.ts` |
| 6 | LOW-MEDIUM | **A recovery started between completion and rotation** kept "running" against the adopted wallet. | The rotation cancels the swept wallet's other pending recoveries (`cancelledBy: superseded`, a new protocol enum value), and the running recovery is scoped to the active wallet, in the engine and in the service. | `apps/guardian/test/security/superseded-recovery.test.ts` |
| 7 | LOW | **A sweep that can never be broadcast blocked reset forever.** | After a failed broadcast a sweep is marked dead when its transaction does not decode, a later recovery's sweep of the same wallet was broadcast, or an input was spent by another transaction with 6 confirmations. Dead sweeps are not retried and reset ignores them. | `apps/guardian/test/security/stale-sweep.test.ts` |
| 8 | LOW | **Dust after the start blocked recovery** (and cancelling to include it restarted the delay). | New protocol method `recovery.update` (`recoveryId`, `sweepPsbt`): the surviving key re-signs the sweep with the new coins; the guardian accepts it for the running recovery only with the same destination and surviving key, a superset of the original inputs (all the wallet's) and the fee within the cap, without restarting the delay. Completion re-checks everything. Schema, PSBT tag rule, `PROTOCOL.md` and tests. | `apps/guardian/test/security/dust-after-start.test.ts`, `packages/protocol/test/schemas.test.ts` |
| 9 | LOW | **Refusals flooded the state file and the activity log**, evicting `cosign_signed` entries. | Refused `sign` / `recovery.start` / `recovery.update` are rate limited per sender (30 per 10 minutes). An identical refusal right after the previous one is counted on it (`count`, `lastAt`). A refusal that changes nothing else is not written to disk. Refusals live in their own bucket of the log (1000), so they only push out older refusals. | `apps/guardian/test/security/refusal-flood.test.ts` |
| 10a | LOW/INFO | **Strangers could fill the replay guard and the seen-wrap set** shared with the paired phone; `pair` spam cost a disk write each. | `RpcServer` takes `isPeer`: strangers get their own small replay guard and response cache (a request first seen from a stranger stays a duplicate when the sender becomes a peer). The inbox keeps strangers' wrap ids, and wraps that do not open, in a set of their own. A `pair` with a wrong secret is refused before anything is written. | `apps/guardian/test/security/stranger-flood.test.ts`, `packages/protocol/test/stranger-cache.test.ts` |
| 10b | LOW/INFO | **The web API had no authentication**; other apps' containers on an Umbrel can likely reach the guardian without `app_proxy`. | Sessions: `POST /api/session` with the unlock passphrase (its own throttle; `unlock: true` also unlocks) sets an HttpOnly, SameSite=Strict cookie (Secure over HTTPS), a random token held in memory (hashed), expiring after 30 minutes idle or 12 hours, at sign-out, reset and restart. Every `/api` endpoint needs one, except `GET /api/status` (reduced to non-sensitive fields) and first-run setup until it completes. The web UI has a sign-in screen and sign-out; `API.md` and the mock are updated. | `apps/guardian/test/security/web-sessions.test.ts` |
| 10c | LOW/INFO | **`recovery.access` approvals were not bound to a wallet**, so a grant revoked by a rotation could be had again with the same signature. | A version-2 text names the wallet id (`Trikey recovery-access v2 wallet=<id> ...`); the recovery QR code carries the id (`&wallet=`), and the wallet signs v2 when it knows it (and when renewing). Version 1 stays accepted for compatibility, except a signature whose grant was revoked: kept by the hash of r‖s (so another header byte is the same proof) until it expires. | `apps/guardian/test/security/recovery-access-wallet.test.ts` |
| 10d | LOW/INFO | **High-S BIP137 signatures were accepted** (a second valid encoding of every approval). | Refused. | `apps/guardian/test/security/bip137-high-s.test.ts` |
| 10e | INFO | **Tightening rules during a recovery** is allowed but `DESIGN.md` said no rule changes are. | `DESIGN.md` rule 4 now says the phone may tighten during a recovery (a running recovery keeps its own delay and fee cap). | (docs) |
| 10f | INFO | **The contested-recovery stalemate** was not documented. | `DESIGN.md`'s threat model: a stolen phone can cancel every hardware recovery; without a key 2 backup the vault is frozen, not lost. | (docs) |

## Behaviour changes for the phone and the web UI

- **Pairing:** the hardware authorization key must be at a non-hardened path below the hardware
  account (the wallet already uses `<account>/0/0`). On mainnet, the initial rules must name an alert
  contact. **`apps/mobile` (`real.ts`, `setUpRules`) pairs with `alertContacts: []`, so pairing a
  mainnet wallet from the app is refused until the app asks for a contact first** (not changed here:
  `apps/mobile` is out of this change's scope).
- **Spending:** change counts only within 20 of the high-water mark; the wallet takes change indexes
  from `wallet.sync`, so it is unaffected. A guardian whose clock runs more than 3 h ahead of the
  chain refuses to co-sign (`1501`). Refusals are rate limited per sender.
- **Recovery:** `recovery.start` needs the guardian's chain data; the delay may end a little later
  than the nominal date if blocks are slow (never earlier). `recovery.update` is available (the
  wallet does not call it yet). Superseded recoveries report `cancelledBy: superseded`.
- **Unlock from the phone:** refused after 5 failures in a row until a web unlock, and during a
  recovery the phone did not start (`1101`, `data.reason`).
- **`recovery.access`:** the wallet signs the wallet-bound v2 text when the recovery code names the
  wallet or when renewing; old codes and phones keep working with v1.
- **Web UI:** signing in is required (the passphrase; it also unlocks a locked guardian). A guardian
  restart signs everyone out.

## Upgrading an existing guardian

State written before these fixes keeps working: a wallet without high-water marks starts from none
(the first `wallet.sync` raises them, so until then change beyond index 19 counts as outflow); a
recovery started before the fix has no start height, so only the clock and the median time past are
checked for it; an authorization key paired at another path keeps working for approvals, but a
`hardware.confirm` after a rotation needs the new path.

## Test counts

With the consensus verifier built (`npm run build:verifier`, `TRIKEY_CONSENSUS_VERIFY` set), root
`npm run typecheck` is clean and `npm test` passes: core 113, protocol 137 (132 before), recovery-key
68, silent-payments 73, wallet 88, guardian 291 (240 before; 51 of them in `test/security/`), mobile
416. Every file under `apps/guardian/test/security/` was run against the code before its fix and
fails there.
