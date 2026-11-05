# Trikey Guardian on plain Docker

Run the guardian (key 3 of your Trikey wallet) without Umbrel or Start9: on a Mac or a Windows PC with Docker
Desktop, on Linux, or on a NAS (Synology, QNAP, Unraid, TrueNAS). It is the same image the Umbrel and Start9 packages
run (`ghcr.io/theicaruswings/trikey-guardian`), started with Docker Compose.

> **Pre-alpha.** Try it on signet or testnet4 first. See the main [README](../../README.md) and
> [`docs/alpha-test-plan.md`](../../docs/alpha-test-plan.md).

- [What you need](#what-you-need)
- [The box must stay on](#the-box-must-stay-on)
- [Quick start](#quick-start)
- [Settings (.env)](#settings-env)
- [Finding your Electrum server](#finding-your-electrum-server)
- [Electrum over TLS](#electrum-over-tls)
- [The setup code](#the-setup-code)
- [Step by step: Mac, Windows, Linux, NAS](#step-by-step)
- [Opening the web UI from another computer](#opening-the-web-ui-from-another-computer)
- [After a restart: unlock](#after-a-restart-unlock)
- [Updating](#updating)
- [Backups, and what losing the data means](#backups-and-what-losing-the-data-means)
- [Bitcoin Core alone](#bitcoin-core-alone)
- [A node in this file (`--profile node`)](#a-node-in-this-file---profile-node)
- [No node at all?](#no-node-at-all)
- [Changing the server later (Settings > Server)](#changing-the-server-later-settings--server)
- [Troubleshooting](#troubleshooting)
- [Files here](#files-here)

## What you need

- **Docker with Compose v2** (`docker compose version` answers). Docker Desktop has it; on Linux install Docker Engine
  and the Compose plugin; on a NAS, its container app (below).
- **A Bitcoin node that this computer can reach**, best with an Electrum server (Electrs or Fulcrum). The guardian
  reads the chain from one of three kinds of server (`CHAIN_SOURCE`), as Sparrow Wallet does:
  - **your own Electrum server** (`electrum`, the default): your node on another box (Umbrel, Start9, RaspiBlitz,
    myNode, Parmanode, a NAS running Fulcrum), on this same computer (`ELECTRUM_HOST=host.docker.internal`), or the
    node this compose file can run for you (`--profile node`, [below](#a-node-in-this-file---profile-node));
  - **your own Bitcoin Core alone** (`core`): no Electrum server needed ([Bitcoin Core alone](#bitcoin-core-alone));
  - **a public server** (`public`), if you have no node at all, at a cost in privacy ([No node at all?](#no-node-at-all)).

  It must be on the same network as the guardian's key: a signet guardian needs a signet node.
- **Internet access, outbound only.** The guardian talks to your phone through nostr relays over outbound WebSocket
  connections. Nothing comes in: no port forwarding on your router, and it works behind any NAT. The one port in the
  compose file is the web UI, for you.
- About 300 MB of disk for the image and a few MB for the guardian's data.

## The box must stay on

The guardian is key 3. It co-signs your phone's payments within the daily limit, and it runs Delay & Notify: it
counts down a recovery and sends the alerts. **It does that only while it runs.** A laptop that sleeps, a PC that is
shut down at night or Docker Desktop that is not started means: phone payments that need the guardian fail, and
alerts about a recovery go out late (the delay still counts in chain time, and alerts go out once it runs again).
Your money is not at risk while it is off (the phone and the hardware wallet can always pay together), but the
protection is.

So:

- **A NAS or a small always-on computer is ideal.**
- **Mac:** System Settings, Battery (or Energy on a desktop Mac), Options: turn on **Prevent automatic sleeping on power
  adapter when the display is off**, and keep it plugged in. In Docker Desktop, Settings, General: turn on **Start
  Docker Desktop when you sign in**. From the Terminal, `sudo pmset -c sleep 0` does the same as the first switch.
- **Windows:** Settings, System, Power: set **When plugged in, put my device to sleep after** to **Never**. In Docker
  Desktop, Settings, General: **Start Docker Desktop when you sign in to your computer**. Docker Desktop runs only
  while you are signed in to Windows.
- **Linux:** `sudo systemctl enable docker`, so Docker (and with it the guardian, `restart: unless-stopped`) starts at boot.

After every restart of the computer or the container, the guardian is **locked** until you unlock it:
[After a restart: unlock](#after-a-restart-unlock).

## Quick start

1. Get the two files of the latest release from <https://github.com/TheIcarusWings/trikey/releases> into a new folder,
   for example `trikey-guardian`:
   - `trikey-guardian-compose.yml`: save it as **`docker-compose.yml`**. It pins the image by its digest, so you run
     exactly the image that release built (and can check: [Updating](#updating)).
   - `trikey-guardian.env.example`: save it as **`.env`** (with the dot).

   (Releases from 0.1.9-alpha on carry these files. The copy in this folder of the repository names the image by its
   version tag and is for development.)
2. Edit `.env`: at least `BITCOIN_NETWORK` and `ELECTRUM_HOST` (see [Settings](#settings-env)).
3. In that folder:
   ```sh
   docker compose up -d
   docker compose logs guardian | grep setup.code
   ```
   The second line prints the [setup code](#the-setup-code), for example
   `INFO setup.code code=7K3M-Q9TX-2HWB-F4NR`.
4. Open <http://localhost:3000>. Enter the setup code, then choose the unlock passphrase. The page checks that it
   reaches your node and Electrum server before it lets you continue.
5. Pair your phone with the QR code the guardian shows, as in the alpha test plan, step 2.

## Settings (.env)

All settings live in `.env`, next to `docker-compose.yml`. After a change run `docker compose up -d` (it recreates
the container with the new settings; the data stays).

| Setting | What it is |
|---|---|
| `BITCOIN_NETWORK` | `mainnet`, `testnet4`, `signet` or `regtest`. Key 3 is made for this network and the guardian refuses to start on another one later. |
| `CHAIN_SOURCE` | `electrum` (your Electrum server, the default), `core` (your Bitcoin Core alone) or `public` (a public server). The first choice only: the web page's Settings > Server can change it, and its choice then wins. |
| `ELECTRUM_HOST` | Your Electrum server's host name or IP address, as this computer reaches it. |
| `ELECTRUM_PORT` | Empty for the usual port: 50001, or 50002 with TLS. |
| `ELECTRUM_TLS` | `1` for TLS. Use it for any server on another machine that offers TLS. |
| `ELECTRUM_TLS_CERT_SHA256` | With TLS: the SHA-256 fingerprint of the server's own certificate (self-signed, as Fulcrum makes). [Electrum over TLS](#electrum-over-tls). |
| `ELECTRUM_ALLOW_PUBLIC_PLAINTEXT` | `1` allows plain TCP to a server on the internet. Not advised. |
| `PUBLIC_ELECTRUM_SERVER`, `PUBLIC_ELECTRUM_CERT_SHA256` | With `CHAIN_SOURCE=public`: a listed server's id or `host:port` of another public one (empty: the first listed for your network), and its certificate pin if it is self-signed. |
| `BITCOIN_RPC_HOST`, `_PORT`, `_USER`, `_PASS` | All four or none: your Bitcoin Core's RPC. Needed for `CHAIN_SOURCE=core`. Otherwise optional: the guardian then shows sync progress, broadcasts through the node when the Electrum server fails, and scans for silent payments. |
| `BITCOIN_RPC_ALLOW_PUBLIC` | `1` allows plain RPC to an address on the internet. Not advised. |
| `BITCOIN_CORE_WALLET` | With `CHAIN_SOURCE=core`: the watch-only wallet's name in Bitcoin Core (default `trikey-guardian`). |
| `TRIKEY_UI_BIND` | `127.0.0.1` (default): only this computer opens the web UI. See [another computer](#opening-the-web-ui-from-another-computer). |
| `TRIKEY_UI_PORT` | The web UI's port on this computer, default 3000. |
| `TRIKEY_RELAYS` | Optional: the nostr relays the first-run screen offers, comma-separated `wss://` URLs. |
| `SP_SCAN_THREADS` | Optional: worker threads for the silent payment scanner. |
| `FAMILY_HOSTING` | Optional: `false` turns hosting family members' wallets off (no invites in the web UI). |

The compose file also sets `TRIKEY_PLATFORM=docker`, which turns the setup code on. Leave it.

**Plain TCP or TLS.** The guardian connects over plain TCP only to an address on this computer or your own network:
loopback, `10.x`, `172.16.x` to `172.31.x`, `192.168.x`, Tailscale's `100.64.x` to `100.127.x`, IPv6 `fc00::/7`, or
link-local. It resolves the host name before every connection, checks every address, and connects to the checked one.
For anything else it refuses plain TCP (the log says `electrum.connect_failed ... is not on this box or your own
network`): use TLS. Plain TCP across the internet would show every address of your wallet to anyone on the way.

Bitcoin Core's RPC has no TLS at all. Use it only on your own network or through a tunnel such as Tailscale.

## Finding your Electrum server

The usual addresses (check your node's own page: names and ports change between versions):

| Your node | `ELECTRUM_HOST` | Plain TCP | TLS |
|---|---|---|---|
| Umbrel (Electrs app) | the Umbrel's IP address, e.g. `192.168.1.20` (or `umbrel.local`) | 50001 | via Tor only |
| Start9 (Electrs) | see the Electrs service's Interfaces page (LAN address) | | the LAN port shown there, with Start9's own CA |
| RaspiBlitz, myNode (Electrs) | the node's IP address | 50001 | 50002, self-signed |
| Fulcrum (anywhere) | its host | 50001 | 50002, self-signed |
| A node on this computer | `host.docker.internal` | as configured | as configured |
| `--profile node` | `electrs` | 50001 | |

- **Prefer an IP address or a `.local` name on your network**, or a Tailscale name (`node.tailXXXX.ts.net`, which
  resolves to a `100.x` address and so counts as your own network).
- For Start9's TLS, its root CA is not a public one: pin the certificate ([below](#electrum-over-tls)) or give the
  container the CA with `NODE_EXTRA_CA_CERTS` (an extra mounted file; for people who know Docker).

## Electrum over TLS

With `ELECTRUM_TLS=1` and nothing else, the server's certificate must be signed by a public CA and name the host in
`ELECTRUM_HOST`. That fits a server behind a reverse proxy with a Let's Encrypt certificate.

Fulcrum, and Electrs behind stunnel or nginx on a home node, mostly use a **self-signed certificate**. Then pin it:
set `ELECTRUM_TLS_CERT_SHA256` to the certificate's SHA-256 fingerprint. The guardian then accepts exactly that
certificate (whatever names and dates it carries) and nothing else, and it compares it before it sends a single byte.

Read the fingerprint **on the node itself** (where you know you are talking to the right machine), from its
certificate file:

```sh
openssl x509 -in /path/to/fulcrum/cert.pem -noout -fingerprint -sha256
# sha256 Fingerprint=AB:CD:EF:...      paste all of it, or only the hex part
```

or, from a computer on your home network that you trust, from the server:

```sh
openssl s_client -connect 192.168.1.20:50002 </dev/null 2>/dev/null | openssl x509 -noout -fingerprint -sha256
```

If the server later makes a new certificate, the guardian stops connecting and its log names the fingerprint it saw
(`electrum.connect_failed ... it shows SHA-256 ...`). Check that it is really your server's new certificate, then put
the new value in `.env` and run `docker compose up -d`.

## The setup code

On Umbrel and Start9 the platform's login stands in front of the guardian's page, so only you see its first screen.
On plain Docker nothing does: anyone who reaches the port before you (another user of this computer, a device on your
network if you exposed it) could press "Set up" and become the owner of key 3 and its passphrase.

So, until it is set up, the guardian asks for a **one-time setup code** that it prints in its own log when it starts,
as Jupyter does with its token. Reading the container's log takes the Docker access that only you have.

- `docker compose logs guardian | grep setup.code` (on a NAS: the container's **Log** tab).
- 16 letters and digits, like `7K3M-Q9TX-2HWB-F4NR`. Case, spaces and dashes do not matter.
- **A new code at every start.** If the page says the code is wrong after you restarted the container, take the new
  one from the log.
- 10 wrong codes in a minute and the guardian waits a minute before it takes the next one.
- Once the guardian is set up, the code is gone: the unlock passphrase is the login from then on.

## Step by step

### Docker Desktop on a Mac

1. Install [Docker Desktop](https://docs.docker.com/desktop/setup/install/mac-install/) (Apple silicon or Intel) and start it.
2. Create a folder, put `docker-compose.yml` and `.env` in it ([Quick start](#quick-start), step 1), edit `.env`.
   (`.env` starts with a dot, so Finder hides it: press Cmd+Shift+. to see it, or edit it in the Terminal with
   `nano .env`.)
3. In the Terminal, in that folder: `docker compose up -d`, then `docker compose logs guardian | grep setup.code`.
4. Open <http://localhost:3000>.
5. Keep the Mac awake: [The box must stay on](#the-box-must-stay-on).

### Docker Desktop on Windows

1. Install [Docker Desktop](https://docs.docker.com/desktop/setup/install/windows-install/) with the WSL 2 backend and start it.
2. Create a folder, for example `C:\trikey-guardian`, with `docker-compose.yml` and `.env` in it, and edit `.env` in
   Notepad (save it as "All files", named exactly `.env`, not `.env.txt`).
3. In PowerShell, in that folder: `docker compose up -d`, then `docker compose logs guardian | Select-String setup.code`.
4. Open <http://localhost:3000>.
5. Turn sleep off: [The box must stay on](#the-box-must-stay-on).

### Linux

1. Install Docker Engine and the Compose plugin from [Docker's instructions](https://docs.docker.com/engine/install/)
   for your distribution, and `sudo systemctl enable --now docker`.
2. `mkdir ~/trikey-guardian && cd ~/trikey-guardian`, add the two files, edit `.env`.
3. `docker compose up -d` and `docker compose logs guardian | grep setup.code` (with `sudo` unless your user is in
   the `docker` group).
4. Open <http://localhost:3000>. On a headless server, open it from another computer through an SSH tunnel:
   `ssh -L 3000:127.0.0.1:3000 you@server`, then <http://localhost:3000> on your computer. Nothing else to change.

### Synology (Container Manager)

DSM 7.2 or later, with **Container Manager** from the Package Center.

1. In File Station, create a folder, for example `docker/trikey-guardian`, and upload `docker-compose.yml` and `.env`
   into it (edit `.env` before uploading). `ELECTRUM_HOST` is your node's address as seen from the NAS.
2. Container Manager, **Project**, **Create**: name `trikey-guardian`, path: that folder. It finds the
   `docker-compose.yml` there ("Use existing docker-compose.yml"). Container Manager runs Docker Compose in that
   folder, which reads `.env` from it. Skip the Web Station page. Finish: it pulls the image and starts it.
3. Container Manager, **Container**, `trikey-guardian-guardian-1`, **Log**: the `setup.code` line.
4. The web UI is on the NAS's own `127.0.0.1` by default, which no other computer can open. Either set
   `TRIKEY_UI_BIND=0.0.0.0` in `.env` and open `http://<nas-address>:3000` (read
   [another computer](#opening-the-web-ui-from-another-computer) first), or better put DSM's reverse proxy in front
   (HTTPS, same section). Then **Project**, the project, **Action**, **Build** (or Stop, then Start) to apply it.

The guardian's data is in a **named volume** (`trikey-guardian_guardian-data`), not in a shared folder. That is on
purpose: Docker creates a named volume owned by the image's user (uid 1000), while a shared folder you map would
belong to your DSM user, and the guardian could not write to it (`/data is not writable by this process`). If you
want the data in a shared folder anyway, see [Backups](#backups-and-what-losing-the-data-means), "A folder instead of
the volume".

### QNAP (Container Station)

Container Station 3: **Applications**, **Create**, name `trikey-guardian`, and paste the content of
`docker-compose.yml`. Container Station does not read a `.env` file there, so put your values into the YAML: in the
`environment:` section of `guardian`, replace each `${NAME:-default}` with your value (for example
`ELECTRUM_HOST: 192.168.1.20`), and in `ports:` write `"127.0.0.1:3000:3000"` (or `"3000:3000"` for the network,
read [another computer](#opening-the-web-ui-from-another-computer)). Create, then the container's **Logs** for the
setup code.

### Unraid

Unraid's Docker page runs single containers, not compose files. Install the **Docker Compose Manager** plugin from
Community Applications, add a stack named `trikey-guardian`, paste `docker-compose.yml` into it and the content of
`.env` into its environment file, then **Compose Up**. The log is in the container's **Logs**. (Or use the Unraid
terminal: put the two files in `/mnt/user/appdata/trikey-guardian` and run `docker compose up -d` there.)

### TrueNAS SCALE

TrueNAS 24.10 or later: **Apps**, **Discover Apps**, the ⋮ menu, **Install via YAML**. Paste `docker-compose.yml`
with the values from `.env` filled in, as for QNAP (the YAML form does not read a `.env` file). The container's logs
show the setup code. For the web UI from another computer, see the next section.

## Opening the web UI from another computer

By default the web UI listens on `127.0.0.1` only: right for a Mac or a PC, where you open it on the same computer.
On a NAS you open it from another computer, and there are three ways, best first.

1. **Tailscale (encrypted, no port on your network).** With Tailscale on the NAS and on your computer, keep
   `TRIKEY_UI_BIND=127.0.0.1` and run on the NAS `tailscale serve --bg 3000`: the guardian is then at
   `https://<nas-name>.<tailnet>.ts.net` for your own devices only, with a real certificate. (Or set
   `TRIKEY_UI_BIND` to the NAS's Tailscale IP, `100.x.y.z`: encrypted by Tailscale, plain HTTP in the browser.) See
   [`docs/https-access.md`](../../docs/https-access.md), path A, which was written for Umbrel but works the same way.
2. **The NAS's reverse proxy with HTTPS.** Synology: Control Panel, Login Portal, Advanced, Reverse Proxy: source
   `HTTPS`, a host name of yours, port 443; destination `HTTP`, `localhost`, port 3000. Keep `TRIKEY_UI_BIND=127.0.0.1`
   so only the proxy reaches the guardian.
3. **The port on your network.** `TRIKEY_UI_BIND=0.0.0.0` in `.env`, then `docker compose up -d`, and open
   `http://<nas-address>:3000`. **The passphrase then crosses your network over plain HTTP**: anyone who can watch
   your network (a guest on your Wi-Fi, a compromised device) could read it as you type it, and with it sign in. Use
   this on a network you trust, or for the first setup only, then switch to 1 or 2.

Never forward the port on your router, and never put the guardian on the internet: the guardian needs no inbound
connection at all, and its web UI is meant for you on your own network.

## After a restart: unlock

After the container or the computer restarts, the guardian starts **locked**: key 3 stays encrypted on disk, and the
guardian co-signs nothing until you unlock it. Recoveries, their timers and their alerts go on while it is locked.

Unlock it at <http://localhost:3000> (or your address) with the passphrase, or from the phone app (Settings,
Guardian: type the passphrase in the unlock box). Your phone gets a "guardian restarted and is locked" message when that happens.

## Updating

1. Download `trikey-guardian-compose.yml` of the new release into your folder as `docker-compose.yml` (keep your
   `.env`; compare it with the release's `trikey-guardian.env.example` for new settings).
2. ```sh
   docker compose pull
   docker compose up -d
   ```
3. Unlock the guardian (it restarted).

**Check what runs.** The release's compose file names the image by digest
(`ghcr.io/theicaruswings/trikey-guardian:<version>@sha256:...`), and `docker compose images` shows what you run.
[`packaging/VERIFY.md`](../VERIFY.md) explains how to rebuild the release from its source and compare the digest
yourself. On a NAS that pulls images through its own UI, compare the digest it shows with the release's
`trikey-guardian-compose.yml`.

The release also carries `trikey-guardian-compose.sha256` with the SHA-256 of both files.

## Backups, and what losing the data means

The guardian's data is the named volume `trikey-guardian_guardian-data` (`docker volume ls`). It holds key 3,
encrypted with your passphrase, the guardian's nostr identity, the paired wallet's rules and the activity log.

**Key 3 has no backup, by design** (DESIGN.md, "Holds no backup of key 3"): a backup would be one more copy of a key
to steal. If the volume is lost (a dead disk, `docker compose down -v`, a reset NAS), you lose the guardian, not your
money: the phone and the hardware wallet are two of three keys and can always pay together. Use **Replace guardian**
in the phone app: set up a new guardian, then the phone and the hardware wallet move the funds to a new wallet with
the new guardian's key (alpha test plan, step 13).

So you do not need to back the volume up. Do not restore an old copy over a running guardian either: it would carry
out-of-date limits and recovery state.

- **Never** run `docker compose down -v` (the `-v` deletes the volume) unless you mean to delete the guardian.
  `docker compose down` and `up` keep it.
- **Moving to another computer:** stop the guardian (`docker compose stop`), copy the volume
  (`docker run --rm -v trikey-guardian_guardian-data:/data -v "$PWD":/out alpine tar -C /data -czf /out/guardian-data.tgz .`),
  restore it on the new computer into the same volume name before the first start, start it there, and never start
  the old one again. Two guardians with the same key on the relays would answer the phone twice. Or simply set up a
  new guardian and use Replace guardian.

**A folder instead of the volume.** If you want the data in a folder you choose (a NAS share, say), replace
`guardian-data:/data` with `./data:/data`, create the folder first and give it to uid 1000, the user the image runs
as: `mkdir data && sudo chown 1000:1000 data`. On a Synology share, where you cannot chown easily, add
`user: "<your-uid>:<your-gid>"` (from `id` over SSH) to the `guardian` service instead, so the guardian runs as the
folder's owner. Without one of the two, the guardian exits with `/data is not writable by this process`.

## A node in this file (`--profile node`)

For a computer with no node: this compose file can run Bitcoin Core and Electrs next to the guardian.

```sh
# in .env:
#   ELECTRUM_HOST=electrs
#   BITCOIN_RPC_HOST=bitcoind
#   BITCOIN_RPC_PORT=8332
#   BITCOIN_RPC_USER=trikey
#   BITCOIN_RPC_PASS=<a long random password, letters and digits: openssl rand -hex 24>
docker compose --profile node up -d
docker compose logs -f bitcoind electrs      # watch the sync
```

Always add `--profile node` to `up`, `pull` and `down` for this setup, or Compose leaves the node alone.

| Network | Disk | First sync |
|---|---|---|
| signet, testnet4 | some tens of GB | hours |
| mainnet | about 850 GB (Bitcoin Core about 800 GB, Electrs' index on top), growing | several days, on a fast disk; far longer on a NAS with hard disks |

Mainnet is for a NAS with a large disk (an SSD helps a lot), not a laptop. Until Bitcoin Core has synced and Electrs
has indexed, the guardian's first-run page says the node is still syncing (you can set up already; payments wait).

**The images and why these.** Both are pinned by tag and digest (the multi-arch index, so amd64 and arm64 work), the
same pins as the repository's end-to-end tests (`e2e/docker-compose.yml`), which run the guardian against them in CI:

- `bitcoin/bitcoin:32.1`: Bitcoin Core's own Docker image.
- `getumbrel/electrs:v0.12.0`: romanz/electrs, the Electrum server Umbrel uses, as Umbrel builds and ships it.
  Electrs publishes no image of its own, and this is the build the guardian is tested against on Umbrel. Fulcrum
  (`cculianu/fulcrum`) works too if you run it yourself; point `ELECTRUM_HOST` at it.

The node runs unpruned with the REST interface on (Electrs 0.12 needs both) and its RPC on the containers' own
network only: no port is published on this computer. The RPC user and password come from `.env`, never from the
compose file. Its data lives in the volumes `trikey-guardian_bitcoin-data` and `trikey-guardian_electrs-data`.

To update the pins, change the tag and digest in a commit of its own, here and in `e2e/docker-compose.yml` together
(`e2e/test/unit/compose-guardian.test.ts` checks that they match).

## Bitcoin Core alone

No Electrum server? The guardian can read the chain from Bitcoin Core alone, the way Sparrow Wallet does: set
`CHAIN_SOURCE=core` and the four `BITCOIN_RPC_*` settings (or choose "Your own Bitcoin Core" in Settings > Server).

- Bitcoin Core **24 or later**.
- The guardian creates a **watch-only descriptor wallet** in your node (`trikey-guardian`, or `BITCOIN_CORE_WALLET`):
  no private keys, nothing can be spent from it. It imports the descriptors of the wallets it watches (your Trikey
  wallet, Savings, a replaced wallet, the phone's helper account), and Bitcoin Core follows those addresses itself.
- **The first import scans the chain** from the wallet's birthday (for your Trikey wallet: the guardian's setup day).
  On mainnet that takes from minutes to an hour or more; until it is done the guardian says "Bitcoin Core is scanning the
  chain for this wallet" and the phone shows the wallet as not available yet. A wallet whose start the guardian does not
  know (a replaced wallet, the helper account) is scanned from the genesis block: hours on mainnet.
- **A pruned node** works only while it still has the blocks since the wallet's birthday; otherwise the guardian refuses
  the import and says why. Use an unpruned node, or an Electrum server.
- Bitcoin Core's **RPC has no encryption**: the guardian sends it only to an address on this computer or your own
  network (or a Tailscale address). Use the RPC user and password from your node's settings (Umbrel's Bitcoin Node app
  lists them where it explains how to connect a wallet), or `__cookie__` and the cookie's password for a cookie file (it changes at every
  restart of the node).
- Removing that wallet from Bitcoin Core loses nothing: the guardian imports again (with a new scan).

## No node at all?

Then the guardian can use a **public Electrum server**, as a last resort: `CHAIN_SOURCE=public` (or "A public server" in
Settings > Server). The guardian offers a few well-known, long-running servers (TLS, CA-verified), and you can name
another public one:

| Network | Servers |
|---|---|
| mainnet | `electrum.blockstream.info:50002` (Blockstream), `electrum.emzy.de:50002` (Emzy), `bitcoin.lukechilds.co:50002` (Luke Childs), `electrum.bitaroo.net:50002` (Bitaroo) |
| testnet | `electrum.blockstream.info:60002` (testnet3), `mempool.space:40002` (testnet4) |
| signet | `mempool.space:60602` |

**What it costs.** A public server sees every address of the wallets the guardian watches, and this computer's IP
address, and can link them. It could hide coins from the guardian or delay confirmations (which can hold up a payment
or a recovery). It **cannot** spend, and it cannot change any rule: the keys and the rules stay where they are. Your
own node avoids all of this; use one if you can. While a recovery runs, the guardian refuses to switch to a public
server (switching to your own node is always allowed).

## Changing the server later (Settings > Server)

The guardian's web page has **Settings > Server**, like Sparrow Wallet's Server preferences: it shows the server in use
and whether it is connected, lets you choose another one of the three kinds, and has **Test connection** (which connects
without switching). A change is announced to your phone, on every alert channel (email, ntfy, webhook, Telegram, yours and your
contacts') and in Activity, because a change of server is a change of whom the guardian trusts for chain data. The
phone shows the kind in Settings > Guardian ("Your node", or "Public server: <host>" with the warning above).

The choice is kept in the guardian's data (`chain-source.json`, the RPC password sealed) and wins over `.env` from then
on. To go back to `.env`, choose the same settings there again in the page.

## Troubleshooting

`docker compose logs guardian` shows one event per line, without keys, passphrases or request bodies, so the log is
fine to share in a bug report (except the `setup.code` line before setup).

- **"Electrum server not reachable" on the first-run page.** The page shows the guardian's reason. Look for
  `electrum.connect_failed` in the log:
  - `connection refused`: wrong port, or the server does not listen on the network (Electrs often listens on
    `127.0.0.1` only by default: set its `electrum_rpc_addr` to `0.0.0.0:50001`);
  - `is not on this box or your own network`: set `ELECTRUM_TLS=1`, or use the server's local address;
  - `not signed by a public CA`: pin the certificate with `ELECTRUM_TLS_CERT_SHA256`;
  - `does not speak TLS on this port`: the port is plain TCP; set `ELECTRUM_TLS=0` or use the TLS port;
  - `host.docker.internal` on Linux needs the `extra_hosts` line of the compose file (it is there; keep it) and the
    server listening on the Docker bridge, not only on `127.0.0.1`.
- **The container exits at once with `config.invalid`.** The log line says which setting is wrong.
- **`/data is not writable by this process`.** You replaced the volume with a folder: see "A folder instead of the
  volume".
- **The setup code is refused.** The container restarted since you copied it: take the newest `setup.code` line.
- **The page does not open from another computer.** `TRIKEY_UI_BIND` is `127.0.0.1`: see
  [another computer](#opening-the-web-ui-from-another-computer).
- **The phone cannot reach the guardian.** Check that the computer is awake and has internet access, and that the
  guardian is unlocked; the Home page lists the relays and whether they are connected.

## Files here

- `docker-compose.yml`: the guardian, and the optional node profile.
- `.env.example`: every setting, with comments.
- `smoke-test.sh`: CI's check (`.github/workflows/compose.yml`): the compose file is valid, the guardian from it comes
  up healthy on `127.0.0.1`, reaches Electrs on regtest, and keeps setup closed without the setup code.

Releases attach the pinned copy, `trikey-guardian-compose.yml`, and `trikey-guardian.env.example`
(`.github/workflows/docker.yml`, job `compose-files`). When a release bumps the image version, bump it here too, in
step with `packaging/umbrel/trikey-guardian/docker-compose.yml` (a test checks that both name the same version).
