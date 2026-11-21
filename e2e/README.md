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
| `hosting.test.ts` | Family hosting (phases 1 and 2): a guest accepts an invite with the contact lock on, its chain data from a server of its own (never the host's guardian); a payment under the limit is co-signed and its change ledgered; the limit off with the hardware wallet and a payment past the old limit; the guest's pause sends a payment to the hardware wallet and the hardware wallet resumes; leaving is refused while money is there, then, once the guest sent everything out and a block confirmed it, the guardian finds its co-signed coins spent on real Electrs and releases the slot |
| `own-wallets.test.ts` | Two wallets in one app (docs/design/multi-wallet.md): one phone seed and one guardian, a second wallet added with its own hardware wallet at account 2 (no key of one in the other's addresses); payments within each wallet's own limit co-signed into the real mempool and one over the limit signed by that wallet's own device; a recovery of the second wallet (its device lost) runs its delay against the chain's median time while the first keeps paying, then is swept and adopted; one backup and one recovery code bring both back on a new phone |
| `own-wallets-phase2.test.ts` | Multi-wallet phase 2: the added wallet's Savings (the phone at account 3', its own device at 1', a Recovery Key of its own) funded and spent on chain, relayed by the guardian into the real mempool and noticed by its tripwire; "Replace guardian" with both wallets and one pairing code onto a second guardian on the same chain: each wallet's sweep mined, the added one at its own account on the new guardian, both retired on the old one (the first last), the added wallet's Savings watched by the new guardian |
| `coin-control.test.ts` | Coin control: a frozen coin left out of Send max (and still unspent on the node), a manual pick spending exactly the coins picked, a consolidation built by the app that the guardian co-signs counting only its fee (the node's fee is the quote's), Savings consolidated with the phone and the hardware wallet and announced as "Savings consolidated", BIP 329's own examples imported and exported again, labels and freezes back after a version-6 backup and restore |
| `unit/*.test.ts` | The helpers, without Docker |

`src/rig.ts` has the two chains behind one `E2eRig` interface: `RegtestRig` (the real stack) and `FakeRig` (dry run).
The guardian's clock is a `ManualClock`; on the real chain the node's clock (`setmocktime`) follows it and only ever
moves forward, because Core refuses blocks more than two hours ahead of its clock.

## UI flows (the app on an Android emulator)

The tests above drive `@trikey/wallet` directly. The UI flows drive the **app itself**: the test build (Trikey Test,
`app.trikey.wallet.test`) in **Simulator mode**, its software hardware wallet on regtest, tapped through by
[Maestro](https://maestro.dev) on an Android emulator, against the same regtest stack and the **real guardian process**
(`apps/guardian/src/main.ts`, set up through its own web API). They are the automated evidence that a feature's
screens work end to end before it goes from the test app into the public app. Real hardware wallets are out of scope.

| Flow (`apps/mobile/.maestro/regtest/`) | What it does (docs/alpha-test-plan.md) |
|---|---|
| `00-fingerprint.yaml` | Android's Settings, not Trikey: enrols a fingerprint on the emulator. The phone's key is kept behind it, as on a phone |
| `01-create-wallet.yaml` | Welcome, Simulator mode, "Create a wallet", the simulated device, the guardian's pairing code pasted, the 200,000 sats daily limit approved on the device, a backup file with a recovery code (steps 2 to 5) |
| `02-receive.yaml` | Receive's address paid 1,000,000 sats by the funding wallet, a block, the balance on Home (step 6) |
| `03-pay-within-limit.yaml` | 10,000 sats: Review says the phone and the guardian sign, "Send with fingerprint", no hardware wallet; the node has it in its mempool (step 7) |
| `04-pay-over-limit.yaml` | 300,000 sats, over the limit: the amount screen and Review hand it to the simulated device; the node has it (step 8) |
| `05-restore-from-backup.yaml` | Settings, "Remove this wallet", then "I already have a Trikey wallet", "My phone, but I have its backup" and the recovery code from flow 01; the same balance comes back from the guardian, and a payment inside the limit works again (step 11) |
| `06-lost-phone-recovery.yaml` | The wallet removed again, "My phone and its backup" lost: the guardian's "Recover on a new phone" code and the simulated device start a recovery; the waiting screen, and the guardian's own API says a recovery is in progress; cancelled from the phone (the guardian agrees), then restored from the backup and a payment (step 12a; the 7-day wait itself is `e2e/test/recovery.test.ts`'s, since the real guardian counts it on its own clock and the chain's) |
| `07-replace-guardian.yaml` | Security, Guardian, Replace guardian with a second real guardian's code: the plan, "Start the move", "Your money moved"; guardian 2 guards the wallet and guardian 1 has retired it (their APIs); a payment co-signed by guardian 2 (step 13) |

They run in order and build on each other (one wallet throughout); a flow runs only if the ones before it passed.

What is outside the phone comes from `scripts/ui-rig.ts` (`npm run ui-rig -w @trikey/e2e`): a nostr relay on
`ws://127.0.0.1:7777`, guardian 1 (and a second guardian on first use, for "Replace guardian"), and a control API on
`http://127.0.0.1:8790` that the flows call from Maestro's `runScript` (`apps/mobile/.maestro/regtest/scripts/rig.js`):
a fresh pairing code, a payment from the funding wallet, a block, what an address received, a value kept between flows.
The header of `scripts/ui-rig.ts` lists the endpoints. The emulator reaches the relay through `adb reverse tcp:7777
tcp:7777`; the pairing code names the same URL for the guardian and the phone. A test build allows plain `ws://` and
`http://` to `127.0.0.1`, `localhost` and `10.0.2.2` only (`apps/mobile/plugins/with-test-cleartext.js`); a release build
allows none.

Fingerprints: `.github/scripts/android-ui-e2e.sh` sets the emulator's screen lock (PIN 1234), runs `00-fingerprint.yaml`,
and keeps a finger on the emulator's sensor in the background (`adb emu finger touch 1`, then `finger remove`, every two
seconds), which answers every fingerprint prompt of the flows. So use a throwaway emulator.

In CI: the `ui-e2e` job of `.github/workflows/android-launch.yml`, on the standard x86_64 test APK that workflow builds.
`.github/scripts/ui-e2e-report.py` posts the flows that passed, and for the one that failed the step, Maestro's error,
the screen's texts and the app's, guardian's and rig's logs, as annotations (readable through the checks API). Everything
else (screenshots, Maestro's output, logcat per flow, the guardians' logs) is in the `android-ui-e2e` artifact.

Locally, with Docker, Node 22, Java 17, Maestro (`bash .github/scripts/install-maestro.sh`) and an x86_64 or arm64
emulator (API 34, Google APIs image) with the test build's APK (`EXPO_PUBLIC_TRIKEY_CHANNEL=test`; the artifact of the
Android launch check, or a local build as in `apps/mobile/README.md`):

```sh
npm ci
npm run stack:up -w @trikey/e2e
npm run ui-rig -w @trikey/e2e &            # until "ui-rig: ready"
APK=path/to/trikey-test.apk APP_ID=app.trikey.wallet.test UI_OUT=ui-out bash .github/scripts/android-ui-e2e.sh
python3 .github/scripts/ui-e2e-report.py ui-out
```

`FLOWS="01-create-wallet.yaml 02-receive.yaml"` runs only some of them (00 always runs first). One flow on its own, once
the emulator has a fingerprint: `maestro test apps/mobile/.maestro/regtest/02-receive.yaml`, with the finger loop from
the script running. The rig keeps everything in memory and in a temporary directory: restart it, and clear the app
(flow 01 does), together.

## When it fails

1. The failing test prints the end of the guardian's log; CI also prints the containers' logs.
2. `npm run stack -w @trikey/e2e -- status` shows whether the node and Electrs agree on the height.
3. Electrs not reaching the node's height: `npm run stack:logs -w @trikey/e2e`; check its config line
   (`electrs --conf`) and that bitcoind accepted its credentials.
4. A relay-policy assertion on the node's wording: Core's reject reasons are matched loosely (`dust`, `min relay fee`,
   `insufficient fee`, `non-BIP68-final`, `non-final`); a newer Core may word one differently.
