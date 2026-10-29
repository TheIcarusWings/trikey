# Trikey Guardian on StartOS

The StartOS package of the guardian (`apps/guardian`). It wraps the image from
`packaging/docker/Dockerfile`, published as `ghcr.io/theicaruswings/trikey-guardian`.
Written for `@start9labs/start-sdk` 3.1.1 (pinned in `package.json` and the lockfile),
following Start9's `hello-world-startos`, `electrs-startos` and `mempool-startos`.

This folder is its own npm project. The monorepo's workspaces are `packages/*` and `apps/*`, so
the root `npm install` does not see it; install here with `npm ci`.

## Build

Needs Docker (running), `make`, `jq`, Node.js and npm, `start-cli`, and a packaging workspace for
the signing key (`start-cli s9pk init-workspace`; see Start9's environment setup guide).

```sh
npm ci
npx tsc --noEmit    # type-check
make                # trikey-guardian_x86_64.s9pk, trikey-guardian_aarch64.s9pk
make x86            # one architecture
```

The `Makefile` includes the SDK's `s9pk.mk`. The image is built for amd64 and arm64 only, so
`ARCHES` leaves out riscv64. The package pulls the image by tag; publish the image of the same
version first (`.github/workflows/docker.yml` on a tag).

## What the package defines

| | |
|---|---|
| Package id | `trikey-guardian` |
| Image | `guardian`: `ghcr.io/theicaruswings/trikey-guardian:<version>` (`manifest/index.ts`) |
| Volumes | `main` at `/data` (the guardian's state and key 3's encrypted keystore); `startos` (the web UI password, not mounted into the container) |
| Daemons | `chown-data` (oneshot, root: the volume is root-owned, the image runs as uid 1000), then `guardian` (the image's own CMD, `node --import tsx apps/guardian/src/main.ts`) |
| Interface | `ui`, HTTP on port 3000. The only listener. |
| Health check | `Web Interface`: `GET /api/status` on port 3000 answers 2xx (runs in the container, like the image's `HEALTHCHECK`) |
| Dependencies | `bitcoind` and `electrs`, both required and `running` |
| Actions | `set-web-password` |
| Backups | none, on purpose (see below) |

### Dependencies and the guardian's environment

`main.ts` resolves both dependencies on the internal bridge and passes them to the guardian:

| Variable | From |
|---|---|
| `ELECTRUM_HOST`, `ELECTRUM_PORT` | `sdk.host.getBridgeAddress` of Electrs' plaintext Electrum binding (host id `electrum`, port 50001) |
| `BITCOIN_RPC_HOST`, `BITCOIN_RPC_PORT` | the bridge address of Bitcoin's RPC binding (host id `rpc`, port 8332, the RPC proxy that also serves pruned blocks) |
| `BITCOIN_RPC_USER`, `BITCOIN_RPC_PASS` | Bitcoin's RPC cookie `/.cookie` on the `bitcoind` volume (mounted read-only in the guardian's container), `__cookie__:<password>`, read by the package runtime and passed only as environment |
| `BITCOIN_NETWORK` | `bitcoin`: Start9's Bitcoin package runs mainnet only |

All of them are needed for silent payment scanning (`getblock <hash> 3`). Addresses and cookie are
read with `.const()`, so the service restarts by itself when one appears or changes (including when
Bitcoin restarts and writes a new cookie). While one is missing, `main` runs only a failing health
check that says which: the guardian is never started with a made-up address.

### The web UI is behind a password

The guardian has no authentication of its own (`apps/guardian/README.md`, "Do not expose it"), and
StartOS does not authenticate a bound port. So the interface is bound with a basic-auth gate
(`addSsl.auth`, user `admin`), and the password is made by the `set-web-password` action. Until it
exists, `interfaces.ts` binds nothing and a critical task asks for it, so the guardian is not
reachable. The password is in `store.json` on the `startos` volume in the clear (StartOS needs the
clear text to enforce it); it is not a key. The plaintext port stays on the server and the
internal bridge, as for every StartOS `http` binding, so another service on the same server could
reach it without the password.

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
  `bitcoin-core-startos` `startos/utils.ts` and README (the `next/31.x` branch).
- Version format `<upstream>:<revision>`: SDK docs, `versions.md`.

Not checked, because there is no StartOS server or `start-cli` here (nothing was packed or run):

- `TODO(verify)` `s9pk pack`: that `start-cli` accepts the manifest, icon, license and
  instructions, and pulls `ghcr.io/theicaruswings/trikey-guardian:0.1.0` (the tag exists only
  after the first release).
- `TODO(verify)` that the version ranges (`>=28.4:0` for Bitcoin, `>=0.11.1:0` for Electrs) match
  what the Start9 registry publishes. They are looser than the ones in `mempool-startos`.
- `TODO(verify)` that the basic-auth gate on `addSsl` also protects the plaintext HTTP address the
  way the SDK's newer docs describe (`proxy.auth`). SDK 3.1.1 only has `addSsl.auth`.
- `TODO(verify)` that Bitcoin's RPC proxy on port 8332 accepts the cookie as user `__cookie__` for
  `getblock <hash> 3` (mempool-startos reads the same cookie for the same proxy).
- `TODO(verify)` that the chown oneshot and `uid 1000` are right for the `main` volume, and that
  `sdk.useEntrypoint()` runs the image's CMD (no ENTRYPOINT) as expected.
- `TODO(verify)` the install flow: critical task for the password, then Open UI, basic-auth
  prompt, guardian setup screen.
- English only: there are no translations.

## Updating

Bump the version in three places, in the same commit: `startos/manifest/index.ts` (the image
tag), `startos/versions/current.ts` (`<version>:0`; raise the revision after the colon for a
change that touches only the package), and, for Umbrel, `packaging/umbrel/`. Then publish the
image for that tag before building the `.s9pk`.
