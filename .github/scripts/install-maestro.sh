#!/usr/bin/env bash
# Installs the Maestro CLI (https://github.com/mobile-dev-inc/maestro) from its GitHub release, pinned by version and
# checked against a SHA-256 written down here, and puts it on the PATH of the next steps. Used by android-launch.yml
# and ios-launch.yml for the demo walk (apps/mobile/.maestro/demo-walk.yaml). Linux and macOS; needs Java 17 or newer.
#
#   MAESTRO_DIR=~/.maestro-cli bash .github/scripts/install-maestro.sh
#
# MAESTRO_DIR (default ~/.maestro-cli) holds the unpacked release; the workflows cache it, keyed by the version and the
# checksum, so a cache hit downloads nothing. A directory that does not hold this version is replaced.
#
# To update: pick a release at https://github.com/mobile-dev-inc/maestro/releases (tag cli-X.Y.Z), download its
# maestro.zip, and set both lines below (sha256sum maestro.zip, or shasum -a 256 on a Mac).
set -euo pipefail

MAESTRO_VERSION="2.11.0"
MAESTRO_SHA256="5384593cb4e7a106489e75a821d157dd43f4e438df6bc308b72e82c685e1283a"
MAESTRO_DIR="${MAESTRO_DIR:-${HOME}/.maestro-cli}"
URL="https://github.com/mobile-dev-inc/maestro/releases/download/cli-${MAESTRO_VERSION}/maestro.zip"

sha256() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi
}

bin="${MAESTRO_DIR}/maestro/bin/maestro"
if [ -x "${bin}" ] && [ "$(cat "${MAESTRO_DIR}/VERSION" 2>/dev/null)" = "${MAESTRO_VERSION} ${MAESTRO_SHA256}" ]; then
  echo "Maestro ${MAESTRO_VERSION} already in ${MAESTRO_DIR} (cache)"
else
  echo "Downloading Maestro ${MAESTRO_VERSION} from ${URL}"
  tmp="$(mktemp -d)"
  curl --fail --silent --show-error --location --retry 3 --retry-delay 5 --output "${tmp}/maestro.zip" "${URL}"
  got="$(sha256 "${tmp}/maestro.zip")"
  if [ "${got}" != "${MAESTRO_SHA256}" ]; then
    echo "::error title=Maestro install::maestro.zip of cli-${MAESTRO_VERSION} has SHA-256 ${got}, expected ${MAESTRO_SHA256}. Not installed."
    exit 1
  fi
  rm -rf "${MAESTRO_DIR}"
  mkdir -p "${MAESTRO_DIR}"
  unzip -q "${tmp}/maestro.zip" -d "${MAESTRO_DIR}"
  rm -rf "${tmp}"
  [ -x "${bin}" ] || { echo "::error title=Maestro install::No maestro/bin/maestro in the cli-${MAESTRO_VERSION} zip"; exit 1; }
  echo "${MAESTRO_VERSION} ${MAESTRO_SHA256}" > "${MAESTRO_DIR}/VERSION"
fi

# No analytics, no update check, no "try our AI" banner in the logs.
export MAESTRO_CLI_NO_ANALYTICS=1 MAESTRO_CLI_ANALYSIS_NOTIFICATION_DISABLED=true MAESTRO_DISABLE_UPDATE_CHECK=true
version="$("${bin}" --version 2>/dev/null | tail -n 1)"
echo "maestro --version: ${version}"
[ "${version}" = "${MAESTRO_VERSION}" ] || echo "::warning title=Maestro install::maestro --version says '${version}', expected ${MAESTRO_VERSION}"

if [ -n "${GITHUB_PATH:-}" ]; then
  echo "${MAESTRO_DIR}/maestro/bin" >> "${GITHUB_PATH}"
  {
    echo "MAESTRO_CLI_NO_ANALYTICS=1"
    echo "MAESTRO_CLI_ANALYSIS_NOTIFICATION_DISABLED=true"
    echo "MAESTRO_DISABLE_UPDATE_CHECK=true"
  } >> "${GITHUB_ENV}"
fi
