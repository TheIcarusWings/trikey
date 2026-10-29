# Packaging Trikey Guardian

One Docker image runs on both Umbrel and Start9. The Umbrel and Start9 packages wrap
that image.

- `docker/Dockerfile`: the image (build context = repository root).
- `umbrel/`: an Umbrel community app store (`umbrel-app-store.yml` plus the app folder `trikey-guardian/`).
- `start9/`: a StartOS service skeleton (TypeScript SDK).

## Build the image locally

```sh
docker build -f packaging/docker/Dockerfile -t trikey-guardian:local .
docker run --rm -p 3000:3000 -v "$PWD/.trikey-data:/data" \
  -e ELECTRUM_HOST=... -e ELECTRUM_PORT=50001 \
  trikey-guardian:local
```

Then open http://localhost:3000. Persistent state goes in `/data`. Never pass real keys
or credentials on the command line or bake them into the image.

## Install the Umbrel community store

The store has to be a repository whose root contains `umbrel-app-store.yml`. This folder
lives in the monorepo, so publish it as its own repository (or a subtree split) first.
Then, in Umbrel: App Store, then Community App Stores, and add the repository URL.

## Build and sideload the Start9 package

The skeleton is unverified against the current StartOS SDK. Check the `TODO(verify)`
markers first.

```sh
cd packaging/start9
npm install @start9labs/start-sdk   # TODO(verify): version to pin
make            # produces trikey-guardian.s9pk
make verify
```

Sideload the `.s9pk` from StartOS (System, Sideload Service) or with `start-cli`.
