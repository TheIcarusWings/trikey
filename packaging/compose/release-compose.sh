#!/usr/bin/env bash
# Makes a release's plain-Docker files from this folder: trikey-guardian-compose.yml (docker-compose.yml with the
# guardian image pinned by digest and no TRIKEY_IMAGE override), trikey-guardian.env.example (.env.example as is) and
# trikey-guardian-compose.sha256.
#
# Two callers, so the two can never disagree:
#   - .github/workflows/docker.yml, job compose-files, makes the files it attaches to the draft release;
#   - packaging/check-release-assets.sh (publish-release.yml) makes them again from the tag's commit and requires the
#     draft's files to be these, byte for byte. A file swapped on the draft (another entrypoint, a privileged guardian,
#     docker.sock mounted, other settings) is then not published, even with a matching .sha256.
#
# Input (environment): IMAGE (ghcr.io/theicaruswings/trikey-guardian), VERSION (0.1.22-alpha), DIGEST (sha256:...),
# TAG (v0.1.22-alpha), OUT (the folder to write to). COMPOSE_DIR: default the folder of this script.
set -euo pipefail
: "${IMAGE:?}" "${VERSION:?}" "${DIGEST:?}" "${TAG:?}" "${OUT:?}"
COMPOSE_DIR="${COMPOSE_DIR:-$(dirname "${BASH_SOURCE[0]}")}"
[[ "${DIGEST}" =~ ^sha256:[0-9a-f]{64}$ ]] || { echo "::error::unexpected digest ${DIGEST}"; exit 1; }
[ "${TAG}" = "v${VERSION}" ] || { echo "::error::version ${VERSION} is not the tag ${TAG}'s"; exit 1; }
mkdir -p "${OUT}"
pinned="${IMAGE}:${VERSION}@${DIGEST}"
{
  echo "# Trikey Guardian ${TAG}: the image is pinned by digest (${pinned})."
  echo "# Check it against your own build: packaging/VERIFY.md. Settings: trikey-guardian.env.example, saved as .env."
  # The release copy runs exactly this image: no TRIKEY_IMAGE override.
  sed -E "s|^(    image: )\\\$\{TRIKEY_IMAGE:-${IMAGE}:[^}]+\}\$|\1${pinned}|" "${COMPOSE_DIR}/docker-compose.yml"
} > "${OUT}/trikey-guardian-compose.yml"
grep -Fxq "    image: ${pinned}" "${OUT}/trikey-guardian-compose.yml" \
  || { echo "::error::could not pin the image in packaging/compose/docker-compose.yml (its image: line changed?)"; exit 1; }
# Only settings count: the header comments may name the override.
if grep -v '^[[:space:]]*#' "${OUT}/trikey-guardian-compose.yml" | grep -q 'TRIKEY_IMAGE'; then echo "::error::the release copy still names TRIKEY_IMAGE"; exit 1; fi
cp "${COMPOSE_DIR}/.env.example" "${OUT}/trikey-guardian.env.example"
(cd "${OUT}" && sha256sum trikey-guardian-compose.yml trikey-guardian.env.example > trikey-guardian-compose.sha256)
