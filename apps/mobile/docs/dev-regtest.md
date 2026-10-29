# Running a local regtest setup for the simulator mode

The app's **Regtest simulator** mode (Settings, Developer, Wallet mode) is the real wallet code with a
software "hardware wallet" and throwaway keys. It needs the other two parts of a Trikey wallet to be
real, and running on your computer:

```
 phone (app, simulator mode) ──┐
                               ├── nostr relay (DevRelay) ── Trikey Guardian ── Electrs ── bitcoind -regtest
 simulated device (in the app) ┘      port 7777               port 8787         port 50001     port 18443
```

Everything here is for regtest, with keys and passphrases that mean nothing. Never point it at real funds.
The commands run from the repository root unless said otherwise. Nothing leaves your machine except what
you choose to expose on your LAN for a phone to reach.

## Quickest path: `dev-rig` (no bitcoind, no Electrs)

For the web preview or the iOS Simulator, one command starts the real guardian, two relays and a fake Electrs in a
single process (the rig the guardian's own tests use):

```sh
npm run dev-rig -w @trikey/mobile
```

It prints the relay URLs, the passphrase, and a pairing code, then takes commands: `pairing` (a fresh code),
`fund <address> <sats>` (pay an address from the app's Receive screen, confirmed at once), `mine [n]`, `lock`,
`unlock`, `quit`. Open the app in Simulator mode and follow section 6; skip everything else here. The rig forgets
everything when it stops, so remove the simulated wallet in the app (Developer) after restarting it. Its relays
listen on `127.0.0.1` only: for a phone, an Android emulator, or a real chain, use the full setup below.

For the recovery and replacement flows:

| Command | What it is for |
|---|---|
| `pairing 2` | A second guardian on the same chain (started on first use): paste its code in Settings, Guardian, Replace guardian. |
| `recovery-code [2]` | The guardian's "Recover on a new phone" code, for the lost-phone path on a new phone. |
| `offline` / `online` | Stop the first guardian (its relays and the chain keep running), or start it again: Replace guardian with the old box gone. |
| `skip <days>` | Move the guardians' clock ahead and mine past it, so a recovery's wait ends. Move the app's clock by the same amount first (a browser test can; a phone cannot), or the guardian's messages look like they come from the future and are dropped. |
| `status [2]`, `log [2] [n]` | What the guardian holds now, and its last log lines. |

In the app, Settings, Developer, "Use a new simulated hardware wallet" swaps in a fresh simulated device, so "Lost
my hardware wallet" has a replacement to connect.

The rest of this page is that full setup, with a real bitcoind and Electrs.

## 0. What the phone must be able to reach

Only the **relay**. The phone never talks to the guardian directly: both connect out to the relay, and the
guardian reaches Electrs and bitcoind on your computer.

| Where the app runs | Relay URL the guardian must advertise |
|---|---|
| Web preview (`npm run web -w @trikey/mobile`) on the same computer | `ws://127.0.0.1:7777` |
| iOS Simulator | `ws://127.0.0.1:7777` |
| Android emulator | `ws://10.0.2.2:7777` (the emulator's name for your computer) |
| A real phone on your Wi-Fi | `ws://<your computer's LAN IP>:7777`, and the relay must listen on `0.0.0.0` |

Relay URLs go into the pairing code, so set them once when you set the guardian up (step 3). The wallet
accepts `ws://` only for local and private-network hosts (`localhost`, `127.x`, `10.x`, `172.16-31.x`,
`192.168.x`, `.local`, `.lan`, `.onion`).

## 1. bitcoind in regtest

A throwaway config, `~/.bitcoin-regtest/bitcoin.conf`:

```ini
regtest=1
server=1
txindex=1
fallbackfee=0.0002
rpcuser=trikey
rpcpassword=regtest-only-not-a-secret

[regtest]
rpcbind=127.0.0.1
rpcallowip=127.0.0.1
rpcport=18443
port=18444
```

```sh
bitcoind -datadir=$HOME/.bitcoin-regtest -daemon
alias btc='bitcoin-cli -datadir=$HOME/.bitcoin-regtest -regtest'
btc createwallet dev        # a wallet to mine and fund with
```

## 2. Electrs against it

Electrs (romanz/electrs) indexes bitcoind and answers the Electrum protocol. The guardian speaks plain TCP
to it, so no TLS:

```sh
electrs --network regtest \
  --daemon-rpc-addr 127.0.0.1:18443 \
  --daemon-p2p-addr 127.0.0.1:18444 \
  --electrum-rpc-addr 127.0.0.1:50001 \
  --db-dir $HOME/.electrs-regtest \
  --cookie trikey:regtest-only-not-a-secret
```

(Flags differ a little between electrs versions: `electrs --help` is the truth. Regtest needs at least one
block before Electrs starts serving, see step 5.)

### Or: nigiri / docker compose

[Nigiri](https://github.com/vulpemventures/nigiri) starts bitcoind (regtest) and an Electrs together:

```sh
nigiri start
nigiri rpc getblockchaininfo
```

Its Electrum TCP port is usually `50000` (check `docker ps`); use that as `ELECTRUM_PORT` below, and
`nigiri rpc generatetoaddress ...` instead of `btc generatetoaddress ...` to mine. Nigiri's bitcoind RPC
login is `admin1` / `123` on port 18443.

A hand-written `docker-compose.yml` works the same way: one bitcoind container with the config above and
one Electrs container pointed at it. The image names change over time, so pin ones you trust. This is not
tested in this repository.

## 3. The nostr relay (`DevRelay`)

An in-memory relay for development; it forgets everything when it stops.

```sh
HOST=127.0.0.1 PORT=7777 npm run dev:relay -w @trikey/protocol      # simulator or web on this computer
HOST=0.0.0.0   PORT=7777 npm run dev:relay -w @trikey/protocol      # a phone or emulator on your LAN
```

It prints every event it relays. Restarting it is harmless for a paired wallet: both sides reconnect, and
messages still in flight are retried.

## 4. The guardian

```sh
mkdir -p .trikey/guardian-dev        # .trikey/ is git-ignored
PORT=8787 \
TRIKEY_DATA_DIR=$PWD/.trikey/guardian-dev \
BITCOIN_NETWORK=regtest \
ELECTRUM_HOST=127.0.0.1 ELECTRUM_PORT=50001 \
BITCOIN_RPC_HOST=127.0.0.1 BITCOIN_RPC_PORT=18443 \
BITCOIN_RPC_USER=trikey BITCOIN_RPC_PASS=regtest-only-not-a-secret \
TRIKEY_LOG_LEVEL=debug \
node --import tsx apps/guardian/src/main.ts
```

`BITCOIN_RPC_*` are optional (sync progress and a broadcast fallback); `ELECTRUM_*` are needed for
everything chain related.

The guardian starts **locked and not set up**. Set it up once with the relay URL from step 0 (this is
what the web UI's first-run screen does; `curl` works too, as it sends no `Origin` header):

```sh
curl -s localhost:8787/api/setup -H 'content-type: application/json' \
  -d '{"passphrase":"correct horse battery staple","relays":["ws://127.0.0.1:7777"]}'
```

The passphrase needs at least 12 characters; it is what you type into the app's "Unlock guardian" field
after a guardian restart. Argon2id makes setup and unlock take a few seconds.

Then ask for a pairing code (valid for **5 minutes**, one wallet):

```sh
curl -s -X POST localhost:8787/api/pairing | tee /dev/stderr | jq -r .uri     # trikey://pair?v=1&npub=...
```

The same code is on the guardian's web page as a QR (`npm run dev -w @trikey/guardian-web`, or
`npm run build -w @trikey/guardian-web` and `TRIKEY_WEB_DIR=$PWD/apps/guardian-web/dist`). The guardian's
port has no login of its own: keep it on `127.0.0.1`.

## 5. Mining and funding

```sh
ADDR=$(btc -rpcwallet=dev getnewaddress)
btc generatetoaddress 101 $ADDR            # 101 blocks: the first coinbase is spendable
```

Funding the Trikey wallet: open **Receive** in the app, copy its `bcrt1...` address, then

```sh
btc -rpcwallet=dev sendtoaddress bcrt1q...WALLET_ADDRESS 0.01
btc generatetoaddress 1 $ADDR              # confirm it
```

Pull down on Home to sync. Mine a block after every payment to see it confirm. The wallet scans a gap of unused
addresses past the last used one (the guardian reports the gap), so several funding transactions to fresh addresses show up too.

Fee estimates on regtest are usually empty; the wallet then pays the node's minimum relay fee, and says so.

## 6. In the app

1. Settings, Developer, Wallet mode, **Simulator** (or on the first screen, the small "wallet mode" link).
   Nothing is deleted when you switch: each mode keeps its own wallet.
2. Create a wallet, connect the **Simulated device**, paste the pairing code from step 4 (or scan it from the
   guardian's page), set a limit, and make a backup. The "Confirm on your device" sheet shows what a real
   device would show at each step.
3. Pairing must finish within the code's 5 minutes; if it ran out the app says so and asks you to scan again.
4. The simulated device is a seed phrase kept in the app's storage (a fresh one per install), so the wallet
   survives restarts. "Remove this wallet from this phone" (Developer) starts over; then reset the
   guardian too (stop it and delete `.trikey/guardian-dev`, then set it up again), because a guardian pairs
   with one wallet only.

The **Real** mode (testnet, signet or regtest, real hardware wallets) uses the same guardian and relay; only the
device differs.

## Limits of this setup

- On a real phone, cleartext `ws://` to a LAN host must be allowed by the OS: development builds allow it;
  a release APK on Android blocks cleartext traffic unless the build enables it. Untested here.
- The relay forgets everything on restart, and the guardian keeps its data in `.trikey/guardian-dev`. After
  wiping one, wipe the other.
- Electrs needs a couple of blocks before it answers; if the guardian shows "chain unavailable", mine a block.
