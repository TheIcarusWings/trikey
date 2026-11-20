# Packaging Trikey Guardian

One Docker image runs on Umbrel, Start9 and plain Docker. The Umbrel and Start9 packages wrap
that image; `compose/` runs it with Docker Compose.

- `docker/Dockerfile`: the image (build context = repository root). Reproducible: see `VERIFY.md`.
- `docker/oci-digests.sh`: prints the digests that identify an image (used by CI and `VERIFY.md`).
- `VERIFY.md`: rebuild a release and compare its digest with the image on GHCR.
- `umbrel/`: an Umbrel community app store (`umbrel-app-store.yml` plus the app folder `trikey-guardian/`).
- `compose/`: plain Docker (a Mac, a Windows PC, Linux, a NAS): `docker-compose.yml`, `.env.example` and the user guide
  (`compose/README.md`), with an optional node profile. Each release attaches the compose file with the image pinned by
  digest (`trikey-guardian-compose.yml`) and the settings (`trikey-guardian.env.example`), made by
  `compose/release-compose.sh` (`docker.yml`, job `compose-files`); `publish-release.yml` runs that script again and
  publishes only if the release's files are byte for byte the same. `.github/workflows/compose.yml` runs
  `compose/smoke-test.sh` against the regtest stack.
- `start9/`: the StartOS package (TypeScript SDK 3.1). It has its own `package.json`, and is not
  one of the monorepo's npm workspaces (`packages/*`, `apps/*`), so a root `npm install` does not touch it.

Both platforms put their authenticating proxy in front of the guardian (Umbrel's app gateway; on
Start9 a basic-auth gate, see `start9/README.md`), and the packages say which platform with
`TRIKEY_PLATFORM` (`umbrel`, `start9`). The guardian's own login is the unlock passphrase (web
sessions); before setup there is none, and the platform's login guards only its own path: other
apps' containers on the box reach the port directly. So on every platform first-run setup asks for
a one-time setup code (DESIGN.md, "First run without a platform login"), except from the platform's
login proxy where the guardian can recognise it (`TRIKEY_TRUSTED_PROXY`, Umbrel):

| Platform | Setup code | Where the owner finds it |
|---|---|---|
| Umbrel | not asked through umbrelOS 2's app gateway (`TRIKEY_TRUSTED_PROXY=gateway`); asked on umbrelOS 1, whose `app_proxy` sidecar is not trusted | the app's logs (Settings > Troubleshoot), if ever asked |
| Start9 | always (`TRIKEY_SETUP_CODE`, drawn at install) | Actions > Show Setup Code, and next to the web password |
| plain Docker | always, new at every start | `docker compose logs guardian \| grep setup.code` |

A new platform package sets `TRIKEY_TRUSTED_PROXY` only to an address that nothing but its own
login proxy can connect from. A host name (a container name) belongs there only when the platform
itself creates a fixed, legitimate holder of that name before the guardian starts: on a shared
Docker network any other app can claim a free name as its `container_name` or a network alias, and
the guardian would then trust that app. The guardian checks each name once at startup and never
trusts one that named no address, or more than one, then. That is why the Umbrel package lists
`gateway` only, not umbrelOS 1's sidecar names. Never publish the port to the internet.

Bitcoin Core's RPC: Umbrel and Start9 give the guardian a full RPC user (Umbrel's `umbrel`, Start9's
cookie), so keep no funds in the node's own wallet there. Where the owner sets the credentials (plain
Docker), a restricted `rpcauth` user with `rpcwhitelist` is the better choice; DESIGN.md, "The node's
RPC credential", lists the calls to allow.

## Build the image locally

```sh
docker build -f packaging/docker/Dockerfile -t trikey-guardian:local .
docker run --rm -p 127.0.0.1:3000:3000 -v trikey-dev-data:/data \
  -e ELECTRUM_HOST=... -e ELECTRUM_PORT=50001 \
  trikey-guardian:local
```

Then open http://localhost:3000 with the setup code from the output (`setup.code`). Persistent state goes in `/data`. Never pass real keys
or credentials on the command line or bake them into the image. The environment variables
are listed in `apps/guardian/README.md`. For silent payments the guardian also needs
`BITCOIN_RPC_HOST`, `BITCOIN_RPC_PORT`, `BITCOIN_RPC_USER` and `BITCOIN_RPC_PASS` (all four).
`SP_SCAN_THREADS` (optional) sets how many worker threads scan for silent payments; by default one
less than the CPU cores. The Umbrel and Start9 packages leave it at the default.

A plain `docker build` is fine for trying things out. A *release* image is built with a fixed
build time and a pinned BuildKit so that anyone can reproduce it: `VERIFY.md` has the exact
commands, and `.github/workflows/reproducible.yml` builds every change twice and fails if the
two images differ. `.github/workflows/docker.yml` publishes the release image with the same options.

When you change the Dockerfile, a workflow or anything the image is built from, keep these in step:
`docker.yml`, `reproducible.yml` and the commands in `VERIFY.md` must build the same way.
The pins that need an occasional deliberate update (each in a commit of its own, with the new
digest from the registry): the Dockerfile frontend and `NODE_IMAGE` in `docker/Dockerfile`, and the
BuildKit image in the two workflows and `VERIFY.md`.

## Install the Umbrel community store

An Umbrel community store has to be a repository whose **root** contains `umbrel-app-store.yml`.
This folder lives in the monorepo, so the store has to live in its own repository: create
`trikey-umbrel-store` (suggested name, next to this repository) with one commit in it, for example
a README. Then, in Umbrel: App Store, then Community App Stores, and add that repository's URL.

`.github/workflows/umbrel-store.yml` keeps the store in step. On a release tag `v*`, `publish-release.yml`
dispatches it once the release is **published and signed** (docs/design/signed-releases.md). It checks the published
release's signature (`packaging/release-signature.py`, the publisher key in `packaging/release-signer.npub`), takes the
digest from the artifact of the docker.yml run of the tag's commit in which `verified` succeeded, requires the signed
compose file to pin that same digest (and the tag to still point at it), copies `packaging/umbrel/` into the store
repository with the image pinned by that digest, and pushes. A draft, an unsigned release or another digest: no store
update. Run it by hand on the tag to retry. (Up to 0.1.26 `docker.yml` called it while the release was still a draft.) It needs one secret, `UMBREL_STORE_TOKEN`: a fine-grained personal access token with
"Contents: read and write" on the store repository only, best kept in the `release` environment
(`docs/android-signing.md`, "The `release` environment").
It runs only when the repository variable `UMBREL_STORE_AUTOPUBLISH` is `true` (**Settings → Secrets and variables →
Actions → Variables**): set it together with the token. Without it the job is skipped, so a release does not stop to
ask for approval of a job with nothing to do, and the maintainer copies the store by hand: the same files from the
release tag, the image pinned by the digest in the release's `trikey-guardian-compose.yml`, once
`python3 packaging/release-signature.py check` passes on the release's files. With the variable but
without the secret, it does nothing and says so in the run's annotations. (To use another
repository name, set the repository variable `UMBREL_STORE_REPO` to `owner/name`.) The workflow
refuses to publish if `umbrel-app.yml` and `docker-compose.yml` do not name the tag's version, so
bump both before tagging. Bump the image version in `compose/docker-compose.yml` with them
(`e2e/test/unit/compose-guardian.test.ts` checks that it names the same one).

The compose file passes the node's Bitcoin RPC details (`BITCOIN_RPC_*`) from the variables Umbrel
exports for the `bitcoin` dependency, because the silent payment scanner needs them.

**umbrelOS backups leave the guardian out, on purpose** (DESIGN.md, "The platforms' backups leave the
guardian out"), as StartOS backups do (`start9/startos/backups.ts`). `umbrel-app.yml` lists
`backupIgnore: data/*`: umbreld reads it relative to the app's folder, so the contents of the folder
mounted at `/data` (key 3's keystore, the nostr key, the alert channels' key file, the hardware unlock
slots, the rules' state, the encrypted notes) never go into a backup, while the empty folder does, so a
restore brings it back owned by the image's user. Checked in umbreld's source (getumbrel/umbrel,
`modules/apps/app.ts` `getBackupIgnoredFilePaths`, `modules/backups/backups.ts`, which writes the paths
into Kopia's ignore file) and against the umbrel-apps store, where Bitcoin Node, Electrs, Lightning
Node and others use the same key; not yet tried on a real Umbrel (TODO(verify)). So an Umbrel restored
from a backup starts a new, empty guardian: set it up, then in the phone app Settings, Guardian,
**Replace guardian**, with the phone and the hardware wallet, exactly as after a lost box. An Umbrel
backup made by 0.1.21-alpha or earlier still holds the guardian's data. umbrelOS's migration to another
Umbrel copies everything, the guardian included: after it, never start the guardian on the old box again.

It also sets `TRIKEY_EXTRA_ENTROPY: ${APP_SEED}`. umbrelOS gives every app an `APP_SEED`: the hex
HMAC-SHA256 of the Umbrel's own seed and the app id (64 hex characters, the same on every start). The
guardian mixes it into every new setup seed, next to its OS draw and the browser's 32 bytes
(DESIGN.md, "Entropy", `trikey/guardian-seed/v1`), so a guardian whose generator turns out predictable
still gets a seed nobody can guess from relay traffic. It changes nothing for a guardian already set
up. If a future umbrelOS passed `APP_SEED` in another format, the guardian hashes it to 32 bytes with
SHA-256 and carries on: it never stops starting over this value. StartOS has no per-service seed, so the Start9
package draws 32 bytes itself, once at install, and keeps them on its own `startos` volume (`start9/README.md`).

## Build and sideload the Start9 package

See `start9/README.md`. In short, with `start-cli`, Docker, `make`, `jq` and Node.js installed
and a packaging workspace set up:

```sh
cd packaging/start9
npm ci --ignore-scripts
make            # trikey-guardian_x86_64.s9pk and trikey-guardian_aarch64.s9pk
```

Sideload an `.s9pk` from StartOS (System, Sideload Service) or with `start-cli package install -s`.
The package pulls `ghcr.io/theicaruswings/trikey-guardian:<version>`, so the image of that version
has to be published first (or built locally under that name).

`.github/workflows/start9.yml` type-checks the package and builds both `.s9pk` files on every pull
request that touches it (or the guardian's environment contract) and on every release tag (called by
`docker.yml` with the digest of the image it pushed and `verified` reproduced, which is the image packed; run by hand on
a tag, it takes that digest from the verified docker.yml run of the tag's commit, never from an input), and keeps
them as workflow artifacts. They are signed with a throwaway key, so they are for testing, not
attached to releases: `start9/README.md`, "CI".
