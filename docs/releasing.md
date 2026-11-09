# Releasing Trikey

How a release goes out, start to finish. The why behind each safeguard is in
[android-signing.md](android-signing.md) ("How a release is published", "The `release` environment") and
[packaging/README.md](../packaging/README.md). Releases are `x.y.z-alpha` for now.

## 1. Move the version

```sh
git checkout -b release/0.1.26 origin/main
node tools/release/bump.mjs 0.1.26
```

It moves all ten places that name the version: the three package.json files, Expo's app.json, the lockfile, the guardian
image tag in the compose file, the Umbrel package and the Start9 manifest, and the Umbrel and Start9 versions. If a file
didn't name the current version it says which, and you fix that one by hand. `e2e/test/unit/release-versions.test.ts`
fails a release PR whose versions disagree.

## 2. Write the notes

- **CHANGELOG.md:** a section `## [0.1.26-alpha] - YYYY-MM-DD` above the last one, in the
  [Keep a Changelog](https://keepachangelog.com) form. `release.yml` takes the GitHub release's notes from it, and Zapstore's
  `zsp` takes the listing's notes from it. Say what changed for the people using it, with the PR numbers, and what to
  update first (the guardian, then the app).
- **packaging/umbrel/trikey-guardian/umbrel-app.yml:** `releaseNotes`, a few lines for the Umbrel App Store.
- **packaging/start9/startos/versions/current.ts:** `releaseNotes`, one paragraph.
- **docs/beta-checklist.md:** tick what this release closes.

## 3. The release PR

Commit with the usual author, push, and open a PR titled `Release 0.1.26-alpha`. Merge it when every check is green,
including the iOS and Android launch checks, with **squash** (GitHub signs the commit it writes). Nothing else should
be merged between the release PR's CI and its merge.

## 4. The pipeline, and three approvals

On the merge, `release.yml` sees a new version with a CHANGELOG section, tags `v0.1.26-alpha`, makes a **draft**
pre-release and dispatches the builds. The `release` environment asks the owner to approve, on the
[Actions page](https://github.com/TheIcarusWings/trikey/actions):

1. **Docker**: pushes the guardian image with `GHCR_PUSH_TOKEN`, after two clean builds give the same digest.
2. **Android test APK**: signs both APKs with the release key (one approval covers both).
3. **Publish release**, last: checks the draft's files (byte-for-byte compose files, the verified digest, both APKs'
   certificate and app id, checksums), then publishes. The release is immutable from then on.

Each run shows **Review deployments**: tick `release`, then **Approve and deploy**. An approval can take a minute to
show. If a check fails, the release stays a draft: fix the cause and re-run that workflow. Don't publish a draft by
hand; the one time it was done (0.1.23) the checks had all passed and only the last comparison was broken.

## 5. After it's public

- **Umbrel store**, unless `UMBREL_STORE_AUTOPUBLISH` is set: copy `packaging/umbrel/` from the tag into
  [trikey-umbrel-store](https://github.com/TheIcarusWings/trikey-umbrel-store), pin the image to the digest the release's
  `trikey-guardian-compose.yml` names (`...:0.1.26-alpha@sha256:...`), update the version line in its README, and
  squash-merge that as a PR.
- **Zapstore:** in a checkout of `main`, `zsp check zapstore.yaml` and `zsp check packaging/zapstore/foss/zapstore.yaml`.
  If `published_version_code` hasn't reached the new version after an hour or two (it hasn't so far: Zapstore doesn't
  pick up our pre-releases, zapstore/relay#16), the owner publishes each with `zsp publish <config>`, signing with the
  Trikey key. Run them separately, not with `&&`. See [zapstore.md](zapstore.md).
- **Devices:** the guardian first, then the apps (docs/alpha-test-plan.md). An iPhone built from source needs a rebuild
  every 7 days.
