#!/usr/bin/env bash
# Signs the Android release APK and checks the result. Run by .github/workflows/android-build.yml, from the repository
# root, in one of two jobs:
#
# - SIGNING=one-off: in the build job itself, with a throwaway key made here (keytool). No secrets.
# - SIGNING=release: in its own job, `sign`, which runs only on a release tag (v*), declares the `release` environment
#   and is the only job that ever gets the ANDROID_RELEASE_KEYSTORE secrets. That job runs no npm, Gradle or other
#   build code: it gets the APK the build job made (an artifact of the same run) and runs only this script.
#
# Input (environment): UNSIGNED (the APK Gradle made), APPLICATION_ID, SIGNING, ARCHITECTURES, TRIKEY_ANDROID_VARIANT,
# and for SIGNING=release RELEASE_KEYSTORE (base64 PKCS12), RELEASE_PASS and RELEASE_ALIAS (optional). Writes
# dist/<name>.apk and dist/<name>.apk.sha256, and name, sha256, size and signer to GITHUB_OUTPUT.
set -euo pipefail
: "${UNSIGNED:?}" "${APPLICATION_ID:?}" "${SIGNING:?}" "${ARCHITECTURES:?}" "${TRIKEY_ANDROID_VARIANT:?}"
RELEASE_KEYSTORE="${RELEASE_KEYSTORE:-}"
RELEASE_PASS="${RELEASE_PASS:-}"
RELEASE_ALIAS="${RELEASE_ALIAS:-}"
mkdir -p dist
bt="$(ls -d "${ANDROID_HOME}"/build-tools/*/ | sort -V | tail -n 1)"
bt="${bt%/}"

# The names the app's update check looks for (apps/mobile/src/lib/update-check.ts, assetNames).
if [ "${GITHUB_REF_TYPE}" = "tag" ] && [ "${TRIKEY_ANDROID_VARIANT}" = foss ]; then
  name="trikey-alpha-foss-${GITHUB_REF_NAME}"
elif [ "${GITHUB_REF_TYPE}" = "tag" ]; then
  name="trikey-alpha-${GITHUB_REF_NAME}"
elif [ "${TRIKEY_ANDROID_VARIANT}" = foss ]; then
  name="trikey-alpha-foss-0.1.0-${GITHUB_SHA::7}"
else
  name="trikey-alpha-0.1.0-${GITHUB_SHA::7}"
fi

keystore="${RUNNER_TEMP}/signing.p12"
# Gone however the script ends.
trap 'rm -f "${keystore}"' EXIT
case "${SIGNING}" in
  release)
    # Only for a release tag: the workflows never pass the key to anything else, and this refuses it anyway.
    [ "${GITHUB_REF_TYPE}" = tag ] && [[ "${GITHUB_REF_NAME}" == v* ]] \
      || { echo "::error::signing: release is only for release tags (v*), not ${GITHUB_REF_TYPE} ${GITHUB_REF_NAME}"; exit 1; }
    # The project's release key. A release is never signed with anything else: without the secrets,
    # or without the pinned certificate, the job stops instead of falling back to a one-off key.
    [ -n "${RELEASE_KEYSTORE}" ] && [ -n "${RELEASE_PASS}" ] \
      || { echo "::error::signing: release, but the ANDROID_RELEASE_KEYSTORE secrets are not set (docs/android-signing.md)"; exit 1; }
    [ -s packaging/android/release-cert.sha256 ] \
      || { echo "::error::signing: release, but packaging/android/release-cert.sha256 is missing"; exit 1; }
    base64 -d <<<"${RELEASE_KEYSTORE}" > "${keystore}" \
      || { echo "::error::ANDROID_RELEASE_KEYSTORE is not valid base64"; exit 1; }
    # A secret set from a pipe (`security find-generic-password -w | gh secret set ...`) can keep the
    # line break the command printed at the end: it is not part of the password.
    KS_PASS="${RELEASE_PASS%%[$'\r\n']*}"
    alias="${RELEASE_ALIAS:-trikey}"
    ;;
  one-off)
    # A key that exists for this job only: random password (masked), never written to the repository,
    # the artifact or a secret store, and deleted below.
    KS_PASS="$(openssl rand -hex 24)"
    echo "::add-mask::${KS_PASS}"
    alias=trikey-test
    keytool -genkeypair -keystore "${keystore}" -storetype PKCS12 \
      -alias "${alias}" -keyalg RSA -keysize 3072 -validity 3650 \
      -dname "CN=Trikey one-off test key, O=Trikey alpha test build" \
      -storepass "${KS_PASS}" -keypass "${KS_PASS}"
    ;;
  *) echo "::error::Unknown signing: ${SIGNING}"; exit 1 ;;
esac
export KS_PASS

# apksigner replaces the debug signature Gradle put on the APK.
"${bt}/apksigner" sign --ks "${keystore}" --ks-type PKCS12 --ks-key-alias "${alias}" \
  --ks-pass env:KS_PASS --key-pass env:KS_PASS \
  --out "dist/${name}.apk" "${UNSIGNED}"
rm -f "${keystore}"
unset KS_PASS RELEASE_PASS RELEASE_KEYSTORE

# Checks: aligned, signed by the expected key and not the public debug key, the right app, the
# native code for every architecture asked for, and a JavaScript bundle inside (so it runs
# without Metro).
"${bt}/zipalign" -c 4 "dist/${name}.apk"
certs="$("${bt}/apksigner" verify --verbose --print-certs "dist/${name}.apk")"
echo "${certs}"
if grep -qi 'Android Debug' <<<"${certs}"; then echo "::error::The APK is still signed with the debug key"; exit 1; fi
# The signers' certificate digests, however this apksigner labels the lines ("Signer #1 ...", or per scheme or
# SDK range in other versions): every one must be the same certificate.
digests="$(grep -oiE 'certificate SHA-256 digest: *[0-9a-f:]+' <<<"${certs}" | sed -E 's/.*[Dd]igest: *//' | tr -d ':' | tr 'A-F' 'a-f' | sort -u)"
if [ -z "${digests}" ] || [ "$(wc -l <<<"${digests}")" != 1 ]; then
  report="$(head -n 40 <<<"${certs}" | sed 's/%/%25/g' | awk '{printf "%s%%0A", $0}')"
  echo "::error::Could not read exactly one signing certificate digest from apksigner (found: ${digests:-none}). Its report:%0A${report}"
  exit 1
fi
signer="${digests}"
if [ "${SIGNING}" = release ]; then
  pinned="$(grep -v '^#' packaging/android/release-cert.sha256 | tr -d ' :\n\r' | tr 'A-F' 'a-f')"
  [[ "${pinned}" =~ ^[0-9a-f]{64}$ ]] || { echo "::error::packaging/android/release-cert.sha256 does not hold a SHA-256"; exit 1; }
  [ "${signer}" = "${pinned}" ] \
    || { echo "::error::The APK is signed by ${signer}, not by the release key ${pinned} (packaging/android/release-cert.sha256)"; exit 1; }
else
  grep -q 'Trikey one-off test key' <<<"${certs}" || { echo "::error::The APK is not signed with the one-off key"; exit 1; }
fi
echo "signer=${signer}" >> "${GITHUB_OUTPUT}"
# (Captured first: a pipe into grep -q would end the writer early and trip pipefail.)
badging="$("${bt}/aapt2" dump badging "dist/${name}.apk")"
grep -qF "package: name='${APPLICATION_ID}'" <<<"${badging}" \
  || { echo "::error::Unexpected package name (expected ${APPLICATION_ID})"; exit 1; }
listing="$(unzip -l "dist/${name}.apk")"
grep -q 'assets/index.android.bundle' <<<"${listing}" \
  || { echo "::error::No embedded JavaScript bundle: this build would need Metro"; exit 1; }
IFS=',' read -ra abis <<<"${ARCHITECTURES}"
for abi in "${abis[@]}"; do
  grep -q "lib/${abi}/" <<<"${listing}" ||{ echo "::error::No native libraries for ${abi} in the APK"; exit 1; }
done

(cd dist && sha256sum "${name}.apk" > "${name}.apk.sha256")
echo "name=${name}" >> "${GITHUB_OUTPUT}"
echo "sha256=$(cut -d' ' -f1 "dist/${name}.apk.sha256")" >> "${GITHUB_OUTPUT}"
echo "size=$(stat -c %s "dist/${name}.apk")" >> "${GITHUB_OUTPUT}"
