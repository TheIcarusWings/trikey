# @trikey/e2e

End-to-end tests against real Bitcoin infrastructure: a **regtest bitcoind** and a **real Electrs** in Docker, the
**real guardian service** in-process (as `apps/guardian/test/support/rig.ts` runs it), driven by the **real
`@trikey/wallet`** with its software hardware wallet over in-memory nostr relays.

The other tests use a fake Electrum server and a fake Bitcoin Core RPC. These check what fakes cannot: the guardian's
Electrum client against Electrs, broadcasting into a real mempool with real relay policy (dust, minimum relay fee, RBF,
`non-BIP68-final`), silent payment scanning over real `getblock <hash> 3`, and BIP 68 locks against real consensus.

Regtest only. The RPC credentials in `docker-compose.yml` are throwaway values for a chain with no value; every port is
published on `127.0.0.1` only. All keys in the tests are throwaway.

## Run it locally

Needs Docker with the compose plugin, and Node 22.

```sh
npm ci
npm run stack:up -w @trikey/e2e      # pulls the images, starts them, creates the funding wallet, mines 101 blocks
npm run test:e2e -w @trikey/e2e      # TRIKEY_E2E=1 vitest run
npm run stack:down -w @trikey/e2e    # stops the stack and deletes the chain
```

Without `TRIKEY_E2E` set, `vitest run` skips the end-to-end suites and says why, so nothing here needs Docker by
accident. The root `npm test` does not run this package (it has no `test` script).

Other commands (`npm run stack -w @trikey/e2e -- <command>`):

| Command | |
|---|---|
| `status` | node and Electrs heights, the funding wallet's balance |
| `mine [n]` | mine `n` blocks (default 1) and wait for Electrs |
| `send <address> <sats>` | pay an address from the funding wallet |
| `logs` | the containers' logs |
| `setup` | `up` without starting the containers (create the wallet, mine to 101, wait for Electrs) |

Ports and credentials come from the environment, the same variables for the compose file and the tests:
`E2E_RPC_USER`, `E2E_RPC_PASS` (no quotes in it), `E2E_RPC_PORT` (18443), `E2E_ELECTRS_PORT` (50001), `E2E_RPC_HOST`,
`E2E_ELECTRS_HOST`, `E2E_FUNDING_WALLET` (`funding`).

## Without Docker

```sh
npm run test:unit -w @trikey/e2e     # the stack scripts' own logic against scripted stand-ins; the compose file and workflow
npm run test:dry -w @trikey/e2e      # TRIKEY_E2E=fake: the same end-to-end tests on the guardian's in-process fakes
npm run typecheck -w @trikey/e2e
```

The dry run is a check of the test code itself: it runs the real guardian, wallet and the transaction builders, but a
fake chain answers, so the checks that need a real node's opinion (relay policy, BIP 68, the node's mempool) are
skipped there (those tests return after building and signing their transactions).

## The stack

| Service | Image | Notes |
|---|---|---|
| `bitcoind` | `bitcoin/bitcoin:32.1` (Electrs 0.12 needs its `/rest/spenttxouts`) | `-regtest -txindex -acceptnonstdtxn=0`: regtest accepts non-standard transactions unless told otherwise, and relay policy is what is tested |
| `electrs` | `getumbrel/electrs:v0.12.0` | romanz/electrs as Umbrel ships it; the credentials go in through a generated config file, since Electrs takes `auth` from a file only |

Both are pinned by tag and digest (the multi-arch index digest). To update a pin, take the new tag's
`Docker-Content-Digest` from the Docker Hub registry API and change tag and digest together.

Electrs does not index while bitcoind is in initial block download, which an empty regtest chain is. So the stack is
usable once `stack:up` has mined the first blocks (it waits for Electrs to reach the node's height); the compose file
does not wait for Electrs by itself.

## The tests

Files in `test/`, run one after the other (they share the chain and move the node's clock):

| File | Proves |
|---|---|
| `vault.test.ts` | Guardian setup against real Electrs and bitcoind (preflight, sync status), pairing, lock and unlock from the phone; funding the vault from the funding wallet, mempool then block, balance and history match the node's UTXO set; a payment within the limit is co-signed by the guardian, relayed into the real mempool (fee as quoted, at a relayable feerate) and mined; a payment over the limit is signed by the hardware wallet without the guardian |
| `relay-policy.test.ts` | Valid 2-of-3 spends the real node still refuses (a dust output, a feerate under the minimum relay fee, an underpaying replacement) come back as `1601` carrying the node's own reason, with nothing in the mempool; a replacement that pays more is relayed and replaces the first |
| `recovery.test.ts` | "I lost my hardware wallet": the sweep of three coins (both chains, one after an address gap); the guardian waits while the chain's median time is short of the delay even though its own clock has passed it; after the node's clock and 12 blocks catch up it co-signs, broadcasts into the real mempool, the sweep is mined and spends every coin; the new wallet is adopted, holds everything, and pays within the limit |
| `silent-payments.test.ts` | An outside payer built with `@trikey/silent-payments` (Core cannot pay silent payment addresses) pays the phone's `tsp1` address and its labelled one; the guardian's scanner reads real `getblock <hash> 3`, finds both and alerts the phone; the wallet checks the matches and sweeps them into the vault through the guardian; mined |
| `bip68.test.ts` | A `buildSpend` 2-of-3 input with `sequence: 10` is `non-BIP68-final` until exactly block coin height + 10 and is mined in that block; the same for a height `nLockTime` (`non-final`); the Recovery Key refill chain (`@trikey/recovery-key`) is refused while its parent is unconfirmed and until a period after the parent confirmed, then accepted and mined in order |
| `unit/*.test.ts` | The helpers, without Docker |

`src/rig.ts` has the two chains behind one `E2eRig` interface: `RegtestRig` (the real stack) and `FakeRig` (dry run).
The guardian's clock is a `ManualClock`; on the real chain the node's clock (`setmocktime`) follows it and only ever
moves forward, because Core refuses blocks more than two hours ahead of its clock.

## When it fails

1. The failing test prints the end of the guardian's log; CI also prints the containers' logs.
2. `npm run stack -w @trikey/e2e -- status` shows whether the node and Electrs agree on the height.
3. Electrs not reaching the node's height: `npm run stack:logs -w @trikey/e2e`; check its config line
   (`electrs --conf`) and that bitcoind accepted its credentials.
4. A relay-policy assertion on the node's wording: Core's reject reasons are matched loosely (`dust`, `min relay fee`,
   `insufficient fee`, `non-BIP68-final`, `non-final`); a newer Core may word one differently.
