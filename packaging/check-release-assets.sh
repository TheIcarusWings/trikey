#!/usr/bin/env bash
# Checks a draft release's files before .github/workflows/publish-release.yml publishes it. Once published (with
# GitHub's immutable releases on) they cannot change, and they are what people download, what Obtainium and Zapstore
# install and what the app's "Check for updates" offers. So, against what the release builds made:
#
# - exactly the expected files, none missing and none added;
# - each downloaded file has the SHA-256 GitHub lists for it (GitHub computes it on upload);
# - each .sha256 file names its own file and matches it;
# - both APKs are signed by the release key, packaging/android/release-cert.sha256, and nothing else, and each is the
#   app it should be (app.trikey.wallet, app.trikey.wallet.foss);
# - the compose file runs the guardian image by the digest docker.yml pushed and reproducible.yml rebuilt, and the
#   compose files are byte for byte what packaging/compose/release-compose.sh makes from this commit with that digest;
# - the release is signed: its manifest (trikey-<tag>-SHA256SUMS) lists every other file with its SHA-256, and its
#   event (.event.json) is signed by Trikey's publisher key, packaging/release-signer.npub
#   (packaging/release-signature.py; docs/design/signed-releases.md). The owner signs the draft with
#   tools/release/sign-release.mjs; without that, nothing is published.
#
# Input (environment):
#   TAG               the release tag, v0.1.22-alpha
#   ASSETS_DIR        the release's files, downloaded
#   ASSETS_JSON       the release's assets as GitHub's REST API lists them (a JSON array of {name, digest, ...})
#   IMAGE, DIGEST     the guardian image (ghcr.io/theicaruswings/trikey-guardian) and its digest (sha256:...)
#   STANDARD_PACKAGE  the standard app's application id (android.package in apps/mobile/app.json); FOSS adds .foss
#   CERT_FILE         default packaging/android/release-cert.sha256
#   BUILD_TOOLS       a folder with apksigner and aapt2; default the newest under $ANDROID_HOME/build-tools
#   COMPOSE_SCRIPT    default packaging/compose/release-compose.sh (with docker-compose.yml and .env.example beside it)
#   SIGNER_FILE       default packaging/release-signer.npub
#   SIGNATURE_SCRIPT  default packaging/release-signature.py
set -euo pipefail
: "${TAG:?}" "${ASSETS_DIR:?}" "${ASSETS_JSON:?}" "${IMAGE:?}" "${DIGEST:?}" "${STANDARD_PACKAGE:?}"
CERT_FILE="${CERT_FILE:-packaging/android/release-cert.sha256}"
COMPOSE_SCRIPT="${COMPOSE_SCRIPT:-packaging/compose/release-compose.sh}"
SIGNER_FILE="${SIGNER_FILE:-packaging/release-signer.npub}"
SIGNATURE_SCRIPT="${SIGNATURE_SCRIPT:-packaging/release-signature.py}"
if [ -z "${BUILD_TOOLS:-}" ]; then
  BUILD_TOOLS="$(find "${ANDROID_HOME:?}/build-tools" -mindepth 1 -maxdepth 1 -type d | sort -V | tail -n 1)"
fi
fail() {
  echo "::error title=Release check::$*"
  exit 1
}

[[ "${TAG}" =~ ^v[0-9]+\.[0-9]+\.[0-9]+(-alpha)?$ ]] || fail "not a release tag: ${TAG}"
[[ "${DIGEST}" =~ ^sha256:[0-9a-f]{64}$ ]] || fail "not an image digest: ${DIGEST}"
[[ "${STANDARD_PACKAGE}" =~ ^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$ ]] || fail "not an application id: ${STANDARD_PACKAGE}"
[ -x "${BUILD_TOOLS}/apksigner" ] && [ -x "${BUILD_TOOLS}/aapt2" ] || fail "no apksigner and aapt2 in ${BUILD_TOOLS}"
pinned="$(grep -v '^#' "${CERT_FILE}" | tr -d ' :\n\r' | tr 'A-F' 'a-f')"
[[ "${pinned}" =~ ^[0-9a-f]{64}$ ]] || fail "${CERT_FILE} does not hold a SHA-256"
version="${TAG#v}"

# The names are made by packaging/android/sign-apk.sh and docker.yml's compose-files job; the app's update check
# looks for the APKs by name (apps/mobile/src/lib/update-check.ts, assetNames).
standard="trikey-alpha-${TAG}.apk"
foss="trikey-alpha-foss-${TAG}.apk"
compose=trikey-guardian-compose.yml
env_example=trikey-guardian.env.example
compose_sums=trikey-guardian-compose.sha256
manifest="trikey-${TAG}-SHA256SUMS"
event="${manifest}.event.json"
expected="$(printf '%s\n' "${standard}" "${standard}.sha256" "${foss}" "${foss}.sha256" "${compose}" "${env_example}" "${compose_sums}" "${manifest}" "${event}" | sort)"

# 0. Signed at all? The usual reason for a missing file, so it gets its own message.
listed="$(jq -r '.[].name' "${ASSETS_JSON}" | sort)"
if ! grep -qxF "${manifest}" <<<"${listed}" || ! grep -qxF "${event}" <<<"${listed}"; then
  fail "${TAG} is not signed yet: its draft has no ${manifest} and ${event}. The owner signs it with 'node tools/release/sign-release.mjs ${TAG}' (docs/releasing.md, section 4), then re-runs this job."
fi

# 1. Exactly these files.
[ "${listed}" = "${expected}" ] \
  || fail "the release's files are not the expected ones. Expected: $(tr '\n' ' ' <<<"${expected}"). Found: $(tr '\n' ' ' <<<"${listed}")."

# 2. What was downloaded is what GitHub lists. (Every asset uploaded since mid-2025 has a digest; one without is only
# reported, since the checks below read the file's content anyway.)
while IFS=$'\t' read -r name digest; do
  [ -f "${ASSETS_DIR}/${name}" ] || fail "${name} was not downloaded"
  actual="sha256:$(sha256sum "${ASSETS_DIR}/${name}" | cut -d' ' -f1)"
  if [ -z "${digest}" ] || [ "${digest}" = null ]; then
    echo "::warning title=Release check::GitHub lists no digest for ${name}; its content is checked below."
  elif [ "${digest}" != "${actual}" ]; then
    fail "${name}: downloaded ${actual}, GitHub lists ${digest}"
  fi
done < <(jq -r '.[] | [.name, (.digest // "")] | @tsv' "${ASSETS_JSON}")

# 3. The checksum files: each line names one of this release's files, and matches it.
check_sums() { # <sums file> <file>...
  local sums="$1" line hash file
  shift
  [ "$(grep -c . "${ASSETS_DIR}/${sums}")" = "$#" ] || fail "${sums} does not have exactly $# lines"
  for file in "$@"; do
    line="$(grep -E "^[0-9a-f]{64}  ${file//./\\.}\$" "${ASSETS_DIR}/${sums}")" || fail "${sums} has no line for ${file}"
    hash="${line%% *}"
    [ "${hash}" = "$(sha256sum "${ASSETS_DIR}/${file}" | cut -d' ' -f1)" ] || fail "${file} does not match ${sums}"
  done
}
check_sums "${standard}.sha256" "${standard}"
check_sums "${foss}.sha256" "${foss}"
check_sums "${compose_sums}" "${compose}" "${env_example}"

# 4. The APKs: signed by the release key alone, and the right app.
check_apk() { # <file> <application id>
  local apk="${ASSETS_DIR}/$1" id="$2" certs digests badging
  certs="$("${BUILD_TOOLS}/apksigner" verify --verbose --print-certs "${apk}")" || fail "$1: apksigner does not verify it"
  digests="$(grep -oiE 'certificate SHA-256 digest: *[0-9a-f:]+' <<<"${certs}" | sed -E 's/.*[Dd]igest: *//' | tr -d ':' | tr 'A-F' 'a-f' | sort -u)"
  [ "${digests}" = "${pinned}" ] || fail "$1 is signed by ${digests:-nothing}, not by the release key ${pinned} (${CERT_FILE})"
  badging="$("${BUILD_TOOLS}/aapt2" dump badging "${apk}")"
  grep -qF "package: name='${id}'" <<<"${badging}" || fail "$1 is not ${id}"
  echo "$1: ${id}, signed by the release key ${pinned}"
}
check_apk "${standard}" "${STANDARD_PACKAGE}"
check_apk "${foss}" "${STANDARD_PACKAGE}.foss"

# 5. The compose files are exactly what docker.yml makes from this commit's packaging/compose with the pushed digest:
# the same script, run again here, byte for byte. So not only the image line: no other entrypoint, command, user,
# privileges, capabilities, mounts (docker.sock) or services, and the settings file is the repository's.
images="$(grep -E '^ *image: *[^ ]*trikey-guardian' "${ASSETS_DIR}/${compose}" || true)"
[ "${images}" = "    image: ${IMAGE}:${version}@${DIGEST}" ] \
  || fail "${compose} does not run ${IMAGE}:${version}@${DIGEST} (it has: ${images:-no guardian image})"
made="$(mktemp -d)"
IMAGE="${IMAGE}" VERSION="${version}" DIGEST="${DIGEST}" TAG="${TAG}" OUT="${made}" bash "${COMPOSE_SCRIPT}" > /dev/null \
  || fail "could not make the compose files from ${COMPOSE_SCRIPT}"
for file in "${compose}" "${env_example}" "${compose_sums}"; do
  cmp -s "${made}/${file}" "${ASSETS_DIR}/${file}" \
    || fail "${file} is not the file docker.yml makes from packaging/compose at ${TAG}: $(diff "${made}/${file}" "${ASSETS_DIR}/${file}" | head -n 20 | tr '\n' ' ')"
done
rm -rf "${made}"
echo "${compose}, ${env_example}: as made from packaging/compose at ${TAG}, ${IMAGE}:${version}@${DIGEST}"

# 6. The signature: the manifest lists exactly the other files with their hashes, and the event is signed by the pinned
# publisher key. Standard-library Python only, so this job runs no package code for it.
if ! out="$(python3 -I "${SIGNATURE_SCRIPT}" check --tag "${TAG}" --dir "${ASSETS_DIR}" --signer-file "${SIGNER_FILE}")"; then
  fail "the release's signature does not check: $(tr '\n' ' ' <<<"${out}")"
fi
echo "${out}"

echo "All $(wc -l <<<"${expected}") files of ${TAG} checked."
