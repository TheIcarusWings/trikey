# Verify the Trikey Guardian image

The guardian generates and holds key 3. You should not have to take our word for what runs on your
server, so the Docker image is built to be reproducible: building the source of a release tag
gives the same image, byte for byte, as the one on GHCR. You can check that yourself in about
fifteen minutes.

Every release (from the first after 0.1.26-alpha) is also **signed by Trikey's publisher key**, off GitHub: see
[Check a release's signature](#check-a-releases-signature) at the end. That takes a minute and Python.

## What you need

- `git`, `jq`, and Docker with `buildx`.
- For a build of the Raspberry Pi (arm64) image on an x86 computer, or the other way around, QEMU
  emulation. This runs a container with `--privileged`, so run the image CI uses, by its digest, and
  only the emulator you need (`arm64` on an x86 computer, `amd64` on an arm64 one):

  ```sh
  docker run --privileged --rm \
    tonistiigi/binfmt:qemu-v10.2.3-68@sha256:400a4873b838d1b89194d982c45e5fb3cda4593fbfd7e08a02e76b03b21166f0 \
    --install arm64
  ```

  Skip this if you only check your own platform (see "A single platform" below).
- About 10 GB of disk and, with emulation, a good half hour.

## 1. Get the source of a release

```sh
TAG=v0.1.0                        # the release you run (Umbrel and Start9 show it)
git clone --branch "$TAG" --depth 1 https://github.com/TheIcarusWings/trikey.git "trikey-$TAG"
cd "trikey-$TAG"
git rev-parse HEAD                # the commit; the release page names the same one
```

Read what you are about to build. `packaging/docker/Dockerfile` is the whole recipe, and
`apps/guardian/` is the code that runs.

## 2. Build it

The commit time is the one timestamp the build is allowed to know. BuildKit uses it for every
file and for the image's `created` field, so the build does not depend on when you run it.

```sh
SOURCE_DATE_EPOCH="$(git log -1 --format=%ct)"

# A builder that runs BuildKit v0.34.1, the version CI uses (same digest as in the workflows).
docker buildx create --name trikey-verify --driver docker-container \
  --driver-opt image=moby/buildkit:v0.34.1@sha256:99368f3e46177c6405b9740e4461d91cee004128daeecca78d4ceac50ec1da5c

docker buildx build \
  --builder trikey-verify \
  --no-cache --pull \
  --platform linux/amd64,linux/arm64 \
  --file packaging/docker/Dockerfile \
  --build-arg SOURCE_DATE_EPOCH="$SOURCE_DATE_EPOCH" \
  --build-arg VERSION="${TAG#v}" \
  --provenance=false --sbom=false \
  --output "type=oci,dest=guardian.tar,rewrite-timestamp=true,oci-mediatypes=true,compression=gzip" \
  .
```

The options matter. A different BuildKit, a missing `rewrite-timestamp=true` or an attestation
that records the build all change the digest without changing a single file of the program.

## 3. Read the digests of your build

```sh
bash packaging/docker/oci-digests.sh guardian.tar
```

It prints the image index and, for each platform, the manifest and config digests:

```text
index    sha256:...
platform linux/amd64 manifest sha256:... config sha256:...
platform linux/arm64 manifest sha256:... config sha256:...
```

(`oci-digests.sh` is a short script: it unpacks the archive, checks that every blob matches its
name, and reads the digests from `index.json`. Read it too.)

## 4. Read the digests of the published image

```sh
docker buildx imagetools inspect ghcr.io/theicaruswings/trikey-guardian:"${TAG#v}"
```

The `Digest:` at the top is the image index. Under `Manifests:` each platform has its own digest.
Compare them with step 3:

- the **index** digest of your build must equal the `Digest:` at the top;
- each **manifest** digest must equal the digest listed for that platform.

The release also builds it twice more from nothing, and ships the image only if those builds give
exactly the pushed digest (`.github/workflows/docker.yml`, job `verified`); the digest is in the
job summary of the "Reproducible image" job of the tag's Docker run (GitHub, Actions tab). And to see what your own server runs, the Umbrel store
copy of the app pins the image by this digest in its `docker-compose.yml`.

If they are all equal, the image on GHCR is the one this source builds.

## A single platform

You can build only your own platform (`--platform linux/amd64`, or `linux/arm64` on a Pi) and
compare that platform's manifest digest. The index digest then differs, because the index lists
both platforms, so compare the `platform ... manifest` line only. Each platform's image is built
on its own, so its digest does not depend on the other platform being built. We expect this to
match; the CI builds both together.

## What a match proves

- The image holds exactly what this source tree, at this commit, builds into. No file was added,
  changed or left out between the public repository and the registry.
- It was built from the Node base image pinned by digest in the Dockerfile, and from npm packages
  whose hashes are in `package-lock.json`. Both are in the repository, so you can review them.
- The build does not depend on who runs it, where, or when: two independent builds in CI
  (`.github/workflows/reproducible.yml`) and yours all agree.

## What it does not prove

- **That the code is good.** It proves the code is the code you can read, not that it is correct
  or free of bugs. Read it, or rely on others who did.
- **That the dependencies are harmless.** The lockfile pins them, so they cannot change quietly,
  but a package that was malicious when it was added would be in the image, and in your build.
- **That the base image and the toolchain are trustworthy.** You trust Docker's Official Node
  image (pinned by digest, built from Debian) and your own Docker and BuildKit. An attacker would
  have to compromise your toolchain and CI in the same way to hide a change.
- **That the registry tag stays put.** A tag can be pushed over later, by anyone who can write the
  package. Compare digests, and run the image by digest
  (`ghcr.io/theicaruswings/trikey-guardian:<version>@sha256:...`) where you can. What a release ships
  does: the compose file attached to the release, the Umbrel store copy, and the Start9 package, whose
  release build packs the image it pulled by the pushed digest. Only the repository's own
  `packaging/compose/docker-compose.yml` and a `.s9pk` you pack yourself follow the tag. Releases push
  no moving tag (`latest`, `0.1`): only `<version>`.
- **That your server, your phone or your hardware wallet is safe.** The image is one link in the chain.
- **The Umbrel and Start9 wrappers.** They hold configuration, not the program, but they decide
  how the image is started. Their sources are in `packaging/umbrel/` and `packaging/start9/`.

## If the digests differ

A difference is not proof of tampering. Check these first, in this order:

1. **BuildKit version and options.** Use exactly the builder and options above.
2. **SOURCE_DATE_EPOCH and VERSION.** `git log -1 --format=%ct` must run in a checkout of the tag
   (a shallow clone is fine). `VERSION` is the tag without the `v`.
3. **The base image.** `grep NODE_IMAGE packaging/docker/Dockerfile`: if the digest no longer
   exists in the registry, that is a reason to ask, not to trust.
4. **Which tag.** `git rev-parse HEAD` must match the commit on the release page.

Then find where the images differ. [`diffoci`](https://github.com/reproducible-containers/diffoci)
compares two images layer by layer and file by file (see its README for how to name an image
archive and a registry image). The two CI builds are kept as an artifact when they differ.

Open an issue with the output. If you find a real difference in a file, that is a security report:
see `SECURITY.md`.

## How the build is made reproducible

- The Dockerfile frontend, the Node base image, BuildKit and the QEMU emulators (`tonistiigi/binfmt`)
  are pinned by digest.
- `npm ci` installs exactly the lockfile, with install scripts off. No `apt-get`, no network use
  other than the npm registry (whose answers are checked against the lockfile's hashes).
- `vite build` names every file by its content hash and writes no build time, host name or path.
  Built from scratch several times (different directories, one CPU or four, different time zones),
  every file in `dist/` came out identical. The CI job above is the standing check.
- File times and the image's `created` field come from the commit time (`SOURCE_DATE_EPOCH`,
  `rewrite-timestamp=true`).
- There are no provenance or SBOM attestations in the image (they record the build and so differ
  per build), and the image labels hold fixed text and the version only.

To update a pin (the base image, BuildKit), change it in a commit of its own with the new digest
and the reason, so the change is visible in review.

## Check a release's signature

Each release has, next to its other files, a manifest `trikey-<tag>-SHA256SUMS` (the SHA-256 of every other file) and
`trikey-<tag>-SHA256SUMS.event.json`, a nostr event that signs the manifest with Trikey's publisher key. That key is
in the owner's signer app, never on GitHub, so a release that someone else put on GitHub (a hijacked account, a
malicious workflow) does not carry a valid signature. Why and what it does not prove: docs/design/signed-releases.md.

**With this repository's script** (Python 3, standard library only):

```sh
git clone https://github.com/TheIcarusWings/trikey && cd trikey
tag=v0.1.27-alpha
mkdir "/tmp/${tag}" && gh release download "${tag}" --repo TheIcarusWings/trikey --dir "/tmp/${tag}"
python3 -I packaging/release-signature.py check --tag "${tag}" --dir "/tmp/${tag}"
```

(Without `gh`, download every file of the release from its page into one folder.) It checks that the manifest lists
exactly the release's other files with their hashes, and that the event is the expected one, signed by the key in
`packaging/release-signer.npub`. Compare that npub with the one on Trikey's Zapstore listings (docs/zapstore.md): the
script trusts the file in your checkout, so a checkout from somewhere else proves nothing.

**With standard tools**, without our script:

1. The files: `sha256sum -c trikey-<tag>-SHA256SUMS` in the folder with the release's files.
2. The event: `nak verify < trikey-<tag>-SHA256SUMS.event.json` ([nak](https://github.com/fiatjaf/nak)), and its
   `pubkey` is Trikey's publisher key (`npub1qussfnkjk6fvr36syatltxl0ks5pssyx7hrhf8zpnp9mf04e5j2sswedj9`, which is
   `072104ced2b692c1c7502757f59befb428184086f5c7749c41984bb4beb9a495` in hex), its `kind` is 1420 and its tags are
   `["x", "<sha256sum of the manifest>"]` and `["version", "<tag>"]`.
3. The same event is on nostr relays: `nak req -k 1420 -a 072104ced2b692c1c7502757f59befb428184086f5c7749c41984bb4beb9a495 wss://relay.damus.io`
   lists every release the publisher signed. A release on GitHub with no signature there is a reason to ask.

What a valid signature proves: the holder of Trikey's publisher key released exactly these files. What it does not:
that the code is safe (reproducible builds and reading the code are for that), or that the key was not stolen.
