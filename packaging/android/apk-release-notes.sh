#!/usr/bin/env bash
# Writes this APK's part of the release notes (.github/workflows/android-build.yml), which android-apk.yml puts
# together for the release, in this order:
# - dist/release-notes-common.md (written for the standard build): signing, which of the two APKs to pick, how to install;
# - dist/release-notes-<variant>.md (each build): the APK's name, checksum, size and what it was built from.
# Input (environment): NAME, SHA256, SIGNER, SIZE, SIGNING (from sign-apk.sh), TRIKEY_ANDROID_VARIANT, ARCHITECTURES.
set -euo pipefail
if [ "${SIGNING}" = release ]; then
  signing_note="**Signed with the Trikey release key** (certificate SHA-256 \`${SIGNER}\`, also in
packaging/android/release-cert.sha256). Every release from 0.1.7-alpha on has this signature, so it installs over
the previous one and the wallet on the phone stays. Builds up to 0.1.6-alpha had one-off keys: moving from one of
those needs a last uninstall, which deletes the wallet on that phone, so make a backup (recovery code and backup
file) first. To get updates without downloading by hand, see docs/android-signing.md (Obtainium)."
else
  signing_note="**This is a test build, signed with a one-off key made by the build job.** The key is thrown away
after the build, so Android will not install this build over another one, or another over it: uninstall first.
Uninstalling deletes the wallet on that phone, so make a backup (recovery code and backup file) before you do."
fi
# Both APK names, whichever variant this job built.
standard_name="${NAME/trikey-alpha-foss-/trikey-alpha-}"
foss_name="${standard_name/trikey-alpha-/trikey-alpha-foss-}"
size_mb="$(awk -v b="${SIZE}" 'BEGIN { printf "%.1f", b / 1048576 }')"

if [ "${TRIKEY_ANDROID_VARIANT}" = standard ]; then
  cat > dist/release-notes-common.md <<EOF
## Trikey alpha test build (Android)

${signing_note}

**Which APK?** There are two builds of the same code, as two apps: each updates itself, and both can be on one
phone, each with its own wallet.

- \`${standard_name}.apk\`: the **standard** build, "Trikey" (app.trikey.wallet). It contains Google's
  libraries: QR codes are read with Google's ML Kit, and Google Drive backup can be switched on in a later release
  (it needs Google Play services on the phone).
- \`${foss_name}.apk\`: **no Google code**, "Trikey FOSS" (app.trikey.wallet.foss), for phones without Google
  Play services (GrapheneOS, /e/OS, LineageOS) or if you prefer an app without it. QR codes are read with the
  open source zxing-cpp. It will never offer Google Drive backup: the backup is the recovery code plus the backup
  file, which you can still save to Google Drive or anywhere else from the share sheet. Settings, About says
  "Trikey (no Google)".

Today both do the same: Google Drive backup is not switched on in either yet. Not sure? Take the standard one.

**Had the no-Google APK of 0.1.21-alpha or earlier?** It had the standard app's id, so this FOSS APK cannot
update it: it installs as a second app, next to the old one, and starts empty. Your wallet is still in the old
app. In Trikey FOSS, tap "I already have a Trikey wallet", then "My phone, but I have its backup", and open your
backup file with your recovery code. Uninstall the old app once the wallet shows in the new one. (Or install
the standard APK over the old app: it updates in place and keeps the wallet, with Google's libraries.)

- Pre-alpha, open source, not audited. Test networks only (signet, testnet4). Never put real bitcoin in it.
- Install: download the APK on the phone, open it, and allow installing from this source when Android asks.
- Passkeys and Google Drive backup are not in these builds; the backup is a recovery code plus a backup file.
- Check for updates (Settings, About) offers the APK of the build you have installed.
- How to test it: docs/alpha-test-plan.md in the repository.
EOF
fi

if [ "${TRIKEY_ANDROID_VARIANT}" = foss ]; then
  heading="No Google: \`${NAME}.apk\`"
  checked="- Checked by the build: no Google Play services, Firebase, ML Kit or data transport code in it."
else
  heading="Standard: \`${NAME}.apk\`"
  checked=""
fi
cat > "dist/release-notes-${TRIKEY_ANDROID_VARIANT}.md" <<EOF

### ${heading}

- SHA-256 \`${SHA256}\`
- ${size_mb} MB, built for ${ARCHITECTURES} from commit ${GITHUB_SHA::12}.
${checked}
EOF
cat dist/release-notes-*.md >> "${GITHUB_STEP_SUMMARY}"
