# Trikey Guardian on StartOS

The StartOS package of the guardian (`apps/guardian`). It wraps the image from
`packaging/docker/Dockerfile`, published as `ghcr.io/theicaruswings/trikey-guardian`.
Written for `@start9labs/start-sdk` 3.1.1 (pinned in `package.json` and the lockfile),
following Start9's `hello-world-startos`, `electrs-startos` and `mempool-startos`.

This folder is its own npm project. The monorepo's workspaces are `packages/*` and `apps/*`, so
the root `npm install` does not see it; install here with `npm ci`.

## Build

Needs Docker (running), `make`, `jq`, Node.js and npm, `mksquashfs` and `tar2sqfs` (Debian and
Ubuntu: `squashfs-tools` and `squashfs-tools-ng`), `start-cli` (CI uses 2.7.0), and a packaging
workspace for the signing key: `start-cli s9pk init-workspace` in the folder *above* the package
(here `packaging/`; see Start9's environment setup guide), or, without the guide checkout it
clones, a `.startos/build.key.pem` next to this README (what CI does, below; `.startos/` is
ignored by git).

```sh
npm ci
npx tsc --noEmit    # type-check
make                # trikey-guardian_x86_64.s9pk, trikey-guardian_aarch64.s9pk
make x86            # one architecture
make x86 FORMAT=true  # without running prettier over startos/ first
```

The `Makefile` includes the SDK's `s9pk.mk`. The image is built for amd64 and arm64 only, so
`ARCHES` leaves out riscv64. The package pulls the image by tag and `s9pk pack` copies it into the
`.s9pk`: publish the image of the same version first (`.github/workflows/docker.yml` on a tag), or
build it locally with that tag (`packaging/README.md`, "Build the image locally"); a local image of
that name is used as is. `assets/` is empty (`.gitkeep`): `s9pk pack` expects the folder.

## CI

`.github/workflows/start9.yml` runs on pull requests that touch this folder, the guardian's
environment contract (`apps/guardian/src/config.ts`), the Dockerfile or the Umbrel compose file,
on release tags (`docker.yml` calls it once the image is pushed) and by hand. It:

- runs `npm ci`, `npx tsc --noEmit` and the SDK's `lint.mjs`;
- checks the environment `main.ts` passes against `config.ts` (every variable is one the guardian
  reads), against the Umbrel package (every variable Umbrel passes is passed here too) and that
  `TRIKEY_PLATFORM` is `start9`; checks that the image tag and `versions/current.ts` name the same
  release, and on a tag that it is the tag's;
- installs `start-cli` from a pinned release of `Start9Labs/start-technologies` (tag
  `start-cli/v<version>`, checked against a SHA-256 in the workflow). Start9's own package CI
  (`start-technologies/.github/workflows/build.yml`, used by `hello-world-startos`) downloads the
  newest release with its `install-start-cli` action; pinning keeps a new `start-cli` from
  changing the build without a commit;
- builds `trikey-guardian_x86_64.s9pk` on `ubuntu-latest` and `trikey-guardian_aarch64.s9pk` on
  `ubuntu-24.04-arm`, each on its own architecture, nothing emulated;
- inspects each manifest (id, architecture, volumes, dependencies, a clean git hash) and uploads
  the `.s9pk` with its `.sha256` as a workflow artifact for 14 days.

The image: on a tag, `docker.yml` passes the digest it just pushed, and the job pulls exactly that
digest for its architecture and tags it locally under the manifest's name (it fails if the tag no
longer points at that digest), so the tag is not re-resolved for what is packed. On a pull request it packs the published image of the manifest's tag when it exists, and
otherwise (a release PR, before the tag) builds the image from the checkout for the runner's
architecture under that name. So a pull request that changes the guardian but not the version
packs the *published* image: the build checks the package, not the guardian.

### Signing, and why the .s9pk is not attached to releases

Every build is signed with a throwaway key made in the job (`start-cli init-key`, copied to
`.startos/build.key.pem`, the minimal workspace Start9's CI provisions). No secrets are involved.
That is fine for checking that the package builds and for a maintainer sideloading a test build,
but not for users: StartOS 0.4.1.2 and later keep a list of trusted signing keys (System, Trusted
Keys) and warn before installing a package that no trusted key signed. With a new key every run,
every release would carry that warning, nobody could pin Trikey's key, and users would learn to
click through the one warning that could tell them a package is not ours. So releases do not
attach the `.s9pk`. To ship them, the maintainers first need one long-lived package key (kept as a
repository secret and used as `.startos/build.key.pem` on tags only, the way Start9's own release
workflow uses its `DEV_KEY`), with its public key published next to the releases so users can add
it under Trusted Keys; then the tag build can upload the files to the release like the APKs.

## What the package defines

| | |
|---|---|
| Package id | `trikey-guardian` |
| Image | `guardian`: `ghcr.io/theicaruswings/trikey-guardian:<version>` (`manifest/index.ts`) |
| Volumes | `main` at `/data` (the guardian's state and key 3's encrypted keystore); `startos` (`store.json`: the web UI password and the extra entropy, not mounted into the container) |
| Daemons | `chown-data` (oneshot, root: the volume is root-owned, the image runs as uid 1000), then `guardian` (the image's own CMD, `node --import tsx apps/guardian/src/main.ts`) |
| Interface | `ui`, HTTP on port 3000. The only listener. |
| Health check | `Web Interface`: `GET /api/status` on port 3000 answers 2xx (runs in the container, like the image's `HEALTHCHECK`) |
| Dependencies | `bitcoind` and `electrs`, both required and `running` |
| Actions | `set-web-password` (its result also shows the setup code), `show-setup-code` |
| Init | `init/seedEntropy.ts` (once: 32 random bytes for `TRIKEY_EXTRA_ENTROPY`), `init/setupCode.ts` (once: the first-run setup code for `TRIKEY_SETUP_CODE`), `init/watchPassword.ts` (the critical task until a web UI password exists) |
| Backups | none, on purpose (see below) |

### Dependencies and the guardian's environment

`apps/guardian/src/config.ts` is the contract. `main.ts` resolves both dependencies on the internal
bridge and passes the guardian the same variables as the Umbrel package (CI checks both):

| Variable | From |
|---|---|
| `PORT`, `TRIKEY_DATA_DIR` | `3000`, `/data` |
| `TRIKEY_PLATFORM` | `start9`: the words of the first-run screen (where the setup code is) |
| `TRIKEY_SETUP_CODE` | the first-run setup code (16 Crockford base32 characters, 80 bits), drawn once at install (`init/setupCode.ts`) into `store.json` on the `startos` volume and shown by the `show-setup-code` action and with the web password. Until it is set up the guardian asks every request for it: the basic-auth gate covers only the TLS interface, and other services reach the plaintext port over the bridge (below; security review 2026-11, finding 3). No address is trusted to skip it (`TRIKEY_TRUSTED_PROXY` unset): StartOS's proxy reaches the service over the same bridge, and its address was not checked on a device |
| `TRIKEY_EXTRA_ENTROPY` | 32 random bytes the package draws once at install (`init/seedEntropy.ts`) and keeps in `store.json` on the `startos` volume; Umbrel passes its `APP_SEED`. Mixed into every new key-3 setup seed (DESIGN.md, "Entropy"); never weakens it |
| `ELECTRUM_HOST`, `ELECTRUM_PORT` | `sdk.host.getBridgeAddress` of Electrs' plaintext Electrum binding (host id `electrum`, port 50001) |
| `BITCOIN_RPC_HOST`, `BITCOIN_RPC_PORT` | the bridge address of Bitcoin's RPC binding (host id `rpc`, port 8332, the RPC proxy that also serves pruned blocks) |
| `BITCOIN_RPC_USER`, `BITCOIN_RPC_PASS` | Bitcoin's RPC cookie `/.cookie` on the `bitcoind` volume, `__cookie__:<password>`, read by the package runtime and passed only as environment. The volume is mounted read-only into a subcontainer of its own that runs nothing (`bitcoind-cookie`), not into the guardian's: the guardian never sees Bitcoin's datadir or any wallet file in it (security review 2026-11, finding 5). The cookie cannot be mounted alone: dependency mounts take a directory, and bitcoind replaces the file at every start |
| `BITCOIN_NETWORK` | `bitcoin`: Start9's Bitcoin package runs mainnet only |

The four `BITCOIN_RPC_*` go together (the guardian takes all or none). With them it reports sync
progress, broadcasts as a fallback, scans for silent payments (`getblock <hash> 3`), and reads
Bitcoin Core's mempool itself whenever they are set, because electrs 0.11 cannot read the mempool
of Bitcoin Core 32 (Core dropped `bip125-replaceable`; getumbrel/umbrel-apps#6307,
romanz/electrs#1361). They come from the `bitcoind` dependency's own interfaces and volume: the
bridge address of its `rpc` host (as mempool-startos resolves it) and the RPC cookie from its
`main` volume (as mempool, electrs, lnd and btcpayserver read it). Bitcoin's package supports no
`rpcuser`/`rpcpassword`, and its RPC proxy accepts the cookie user with every call allowed
(`passthrough_rpccookie` in btc-rpc-proxy), JSON-RPC batches included. So the guardian holds a credential for
every call, wallet calls included: keep no funds in Bitcoin's own wallet on this server (DESIGN.md, "The node's RPC
credential", lists the calls the guardian actually makes).

Left at the guardian's defaults, as on Umbrel: `CHAIN_SOURCE` (the Electrum server above; the web
UI's Settings, Server can change it), `FAMILY_HOSTING` (on), `TRIKEY_RELAYS` (the built-in list),
`SP_SCAN_THREADS` (one less than the cores).

Addresses and cookie are read with `.const()`, so the service restarts by itself when one appears
or changes. That includes every Bitcoin restart (an update, a settings change), because bitcoind
writes a new cookie on every start and the old one stops working; the guardian then starts locked,
like after any restart, until it is unlocked from the phone or the web UI. A dedicated RPC user
would avoid this (Bitcoin's hidden `generate-rpc-dependent` action registers an `rpcauth` user for
a dependent), but no StartOS package uses that path yet and it needs a task on Bitcoin; it is left
for a test on a device. While a dependency is missing, `main` runs only a failing health check
that says which: the guardian is never started with a made-up address.

### The web UI is behind a password

The guardian has no authentication of its own (`apps/guardian/README.md`, "Do not expose it"), and
StartOS does not authenticate a bound port. So the interface is bound with a basic-auth gate
(`addSsl.auth`, user `admin`), and the password is made by the `set-web-password` action. Until it
exists, `interfaces.ts` binds nothing and a critical task asks for it, so the guardian is not
reachable. The password is in `store.json` on the `startos` volume in the clear (StartOS needs the
clear text to enforce it); it is not a key. The plaintext port stays on the server and the
internal bridge, as for every StartOS `http` binding, so another service on the same server could
reach it without the password. That is why first-run setup needs the setup code here (`TRIKEY_SETUP_CODE`):
otherwise such a service could set the guardian up first, with its own passphrase. After setup every
call but the reduced status needs a web session, which only the unlock passphrase opens.

### No backup, on purpose

`backups.ts` backs up nothing. DESIGN.md: the guardian holds no backup of key 3; a lost box is
answered by "Replace guardian". The `main` volume holds key 3's keystore, and a restored copy
would carry stale daily-limit accounting. This is a decision for the maintainers (marked
`TODO(decision)` in `backups.ts`): `sdk.Backups.ofVolumes('main')` is the one-line alternative.

## Checked against what source

Checked, with the source:

- Package layout, `setupManifest` fields, `buildManifest`, `setupInit`/`setupInterfaces`/
  `setupMain`, `sdk.Actions`, `Daemons`, `SubContainer`, `Mounts`, `healthCheck.runHealthScript`,
  `Dependency.required`, `Backups.ofSyncs`, the `s9pk.mk` build: `hello-world-startos`
  (`master`), the SDK 3.1.1 type declarations and its `s9pk.mk`, and the SDK docs in
  `Start9Labs/start-technologies` (`projects/start-sdk/docs/src`). `npx tsc --noEmit` and the SDK's
  own `lint.mjs` pass, `ncc` bundles `startos/index.ts`, and the built manifest has the expected
  id, version, volumes, image and dependencies.
- Package ids (`bitcoind`, `electrs`), health check ids (`bitcoind`, `sync-progress`, `electrs`,
  `sync`), host ids and ports (`rpc` 8332, `electrum` 50001), the RPC cookie at `/.cookie` on
  bitcoind's `main` volume: `electrs-startos` and `mempool-startos` `startos/*.ts`, and
  `bitcoin-core-startos` `startos/utils.ts`, `main.ts` and README (`31.x`, November 2026).
- The version ranges: copied from `mempool-startos` `startos/dependencies.ts`, which reaches both
  services the same way (bitcoind's StartOS 0.4 revisions of each major line, Knots' `knotsprerdts`
  flavor included; electrs `>=0.11.1:11`, today 0.12.0).
- That Bitcoin's RPC proxy on 8332 lets the cookie user make any call, batches included:
  `btc-rpc-proxy` 0.8.2 (`passthrough_rpccookie` users have no `allowed_calls`; the password is
  re-read from the cookie file at every comparison).
- Version format `<upstream>:<revision>`: SDK docs, `versions.md`.
- `s9pk pack` with `start-cli` 2.7.0: the manifest, icon, license, instructions and the image are
  accepted and packed for x86_64 and aarch64 (CI, above; locally for x86_64). The built manifest
  has the expected id, version, volumes, image and dependencies.

Not checked, because there is no StartOS server here (nothing was installed or run):

- `TODO(verify)` that the basic-auth gate on `addSsl` also protects the plaintext HTTP address the
  way the SDK's newer docs describe (`proxy.auth`). SDK 3.1.1 only has `addSsl.auth`.
- `TODO(verify)` that the guardian reaches Bitcoin's RPC proxy with the cookie, and Electrs, over
  the bridge (`getblock <hash> 3`, the mempool calls), and that the seeded extra entropy reaches it.
  And that the cookie is read through the `bitcoind-cookie` subcontainer, including a new cookie
  after Bitcoin restarts (main runs again, as before).
- `TODO(verify)` that the chown oneshot and `uid 1000` are right for the `main` volume, and that
  `sdk.useEntrypoint()` runs the image's CMD (no ENTRYPOINT) as expected.
- `TODO(verify)` the install flow: critical task for the password (its result showing the setup
  code too), then Open UI, basic-auth prompt, the guardian's setup-code step, guardian setup screen.
  And that the `show-setup-code` action shows the same code the guardian asks for (`TRIKEY_SETUP_CODE`).
- `TODO(verify)` which address StartOS's own proxy connects from. If only it can connect from that
  address (no other service through a bridge forward), it could go in `TRIKEY_TRUSTED_PROXY` and the
  owner would not need the code, as on Umbrel.
- English only: there are no translations.

## Updating

Bump the version in three places, in the same commit: `startos/manifest/index.ts` (the image
tag), `startos/versions/current.ts` (`<version>:0`; raise the revision after the colon for a
change that touches only the package), and, for Umbrel, `packaging/umbrel/`. CI fails when the
first two name different releases. Then publish the image for that tag before building the
`.s9pk` (on a tag, CI waits for it).
