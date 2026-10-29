# Packaging Trikey Guardian

One Docker image runs on both Umbrel and Start9. The Umbrel and Start9 packages wrap
that image.

- `docker/Dockerfile`: the image (build context = repository root). Reproducible: see `VERIFY.md`.
- `docker/oci-digests.sh`: prints the digests that identify an image (used by CI and `VERIFY.md`).
- `VERIFY.md`: rebuild a release and compare its digest with the image on GHCR.
- `umbrel/`: an Umbrel community app store (`umbrel-app-store.yml` plus the app folder `trikey-guardian/`).
- `start9/`: the StartOS package (TypeScript SDK 3.1). It has its own `package.json`, and is not
  one of the monorepo's npm workspaces (`packages/*`, `apps/*`), so a root `npm install` does not touch it.

The guardian has no login of its own, so both platforms put their authenticating proxy in front
of it (Umbrel's `app_proxy`; on Start9 a basic-auth gate, see `start9/README.md`). Never publish
its port directly.

## Build the image locally

```sh
docker build -f packaging/docker/Dockerfile -t trikey-guardian:local .
docker run --rm -p 3000:3000 -v "$PWD/.trikey-data:/data" \
  -e ELECTRUM_HOST=... -e ELECTRUM_PORT=50001 \
  trikey-guardian:local
```

Then open http://localhost:3000. Persistent state goes in `/data`. Never pass real keys
or credentials on the command line or bake them into the image. The environment variables
are listed in `apps/guardian/README.md`. For silent payments the guardian also needs
`BITCOIN_RPC_HOST`, `BITCOIN_RPC_PORT`, `BITCOIN_RPC_USER` and `BITCOIN_RPC_PASS` (all four).

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

`.github/workflows/umbrel-store.yml` keeps the store in step. On a release tag `v*` it waits for
the image to be published, copies `packaging/umbrel/` into the store repository with the image
pinned by digest, and pushes. It needs one secret in this repository, `UMBREL_STORE_TOKEN`: a
fine-grained personal access token with "Contents: read and write" on the store repository only.
Without the secret it does nothing and says so in the run's annotations. (To use another
repository name, set the repository variable `UMBREL_STORE_REPO` to `owner/name`.) The workflow
refuses to publish if `umbrel-app.yml` and `docker-compose.yml` do not name the tag's version, so
bump both before tagging.

The compose file passes the node's Bitcoin RPC details (`BITCOIN_RPC_*`) from the variables Umbrel
exports for the `bitcoin` dependency, because the silent payment scanner needs them.

## Build and sideload the Start9 package

See `start9/README.md`. In short, with `start-cli`, Docker, `make`, `jq` and Node.js installed
and a packaging workspace set up:

```sh
cd packaging/start9
npm ci
make            # trikey-guardian_x86_64.s9pk and trikey-guardian_aarch64.s9pk
```

Sideload an `.s9pk` from StartOS (System, Sideload Service) or with `start-cli package install -s`.
The package pulls `ghcr.io/theicaruswings/trikey-guardian:<version>`, so the image of that version
has to be published first.
