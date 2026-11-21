#!/usr/bin/env bash
# Runs the UI flows (apps/mobile/.maestro/regtest) on a booted Android emulator, in order, against the regtest back end of
# e2e/scripts/ui-rig.ts, and records what happened for ui-e2e-report.py. Run by reactivecircus/android-emulator-runner
# in .github/workflows/android-launch.yml (the ui-e2e job), but works against any emulator adb can see, with maestro on
# the PATH and the rig running on this computer:
#
#   APK=trikey-test.apk APP_ID=app.trikey.wallet.test UI_OUT=ui-out bash .github/scripts/android-ui-e2e.sh
#
# What it does to the emulator first (a throwaway one: it sets a screen lock):
# - installs the test build (APK);
# - `adb reverse tcp:7777`: the app reaches the rig's relay at ws://127.0.0.1:7777, the URL in the guardian's pairing
#   code (the guardian on this computer uses the same one);
# - keeps the screen on, sets the PIN 1234, and enrols a fingerprint (00-fingerprint.yaml in Android's Settings): Trikey
#   keeps the phone's key behind the fingerprint, as on a phone;
# - keeps a finger on the emulator's sensor in the background (`adb emu finger touch 1` and `finger remove`, every two
#   seconds): that is the enrolment's touches, and the answer to every fingerprint prompt the flows meet.
#
# Then each flow (FLOWS, by default every NN-*.yaml in order) runs through android-walk.sh, which saves Maestro's output,
# the logcat of that flow and, on a failure, what was on screen, into UI_OUT/<flow>/. A flow runs only if the ones before
# it passed: they build on each other (the wallet the first one makes is the one the others pay from). UI_OUT/status.env
# says which ran and how they ended. It exits 0 unless it was called wrongly: the report judges.
set -uo pipefail

: "${APK:?APK: path of the test build APK}"
: "${APP_ID:?APP_ID: the application id of the test build}"
: "${UI_OUT:?UI_OUT: directory for the results}"
FLOW_DIR="${FLOW_DIR:-apps/mobile/.maestro/regtest}"
PIN=1234
RIG_URL="${RIG_URL:-http://127.0.0.1:8790}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

[[ "${APP_ID}" =~ ^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$ ]] || { echo "Unexpected application id: ${APP_ID}" >&2; exit 2; }
[ -f "${APK}" ] || { echo "No APK at ${APK}" >&2; exit 2; }
[ -d "${FLOW_DIR}" ] || { echo "No flows in ${FLOW_DIR}" >&2; exit 2; }

mkdir -p "${UI_OUT}"
: > "${UI_OUT}/status.env"
status() { printf '%s=%s\n' "$1" "$(printf '%s' "$2" | tr '\n' ' ')" >> "${UI_OUT}/status.env"; }
sh_() { adb shell "$@" 2>/dev/null | tr -d '\r'; }

adb wait-for-device
# Root (google_apis images allow it) for tombstones after a native crash, as android-launch.sh does; fine if refused.
if adb root >/dev/null 2>&1; then sleep 2; adb wait-for-device; fi
status device_sdk "$(sh_ getprop ro.build.version.sdk)"
status device_abi "$(sh_ getprop ro.product.cpu.abi)"
status app_id "${APP_ID}"

if ! curl -fsS --max-time 10 "${RIG_URL}/health" > "${UI_OUT}/rig-health.json" 2>&1; then
  status setup "the rig does not answer at ${RIG_URL} (see the step that starts it)"
  echo "The rig does not answer at ${RIG_URL}"
  exit 0
fi

echo "Installing $(basename "${APK}")"
if ! adb install -r "${APK}" > "${UI_OUT}/install.txt" 2>&1; then
  status setup "the APK did not install: $(tail -n 1 "${UI_OUT}/install.txt")"
  cat "${UI_OUT}/install.txt"
  exit 0
fi

# The relay, on this computer, at the same URL for the guardian and the app.
adb reverse tcp:7777 tcp:7777 > /dev/null || { status setup "adb reverse tcp:7777 failed"; exit 0; }
status reverse "$(adb reverse --list | tr '\n' ' ')"
# Awake for the whole run (a screen lock is set below), and no other app's "isn't responding" dialogs over Trikey.
sh_ svc power stayon true > /dev/null || true
sh_ settings put system screen_off_timeout 2147483647 > /dev/null || true
sh_ settings put global hide_error_dialogs 1 > /dev/null || true
sh_ settings put secure anr_show_background 0 > /dev/null || true
sh_ input keyevent KEYCODE_WAKEUP > /dev/null || true
sh_ wm dismiss-keyguard > /dev/null || true
# A freshly booted CI emulator's launcher is busy for a while (and then says it "isn't responding"): let it settle.
sh_ input keyevent KEYCODE_HOME > /dev/null || true
sleep 20

# The finger on the sensor: touch, lift, every two seconds, until this script ends.
( while :; do adb -e emu finger touch 1 > /dev/null 2>&1; sleep 0.6; adb -e emu finger remove > /dev/null 2>&1; sleep 1.4; done ) &
finger=$!
trap 'kill "${finger}" 2>/dev/null || true' EXIT

# A screen lock, then the fingerprint (Android's Settings, driven by 00-fingerprint.yaml).
sh_ locksettings set-pin "${PIN}" > "${UI_OUT}/locksettings.txt" || true
status lock "$(tr '\n' ' ' < "${UI_OUT}/locksettings.txt")"
sh_ am start -a android.settings.FINGERPRINT_ENROLL > "${UI_OUT}/enroll-start.txt" || true

run_flow() { # flow file, app id -> UI_OUT/<name>/; prints Maestro's exit code (the walk's own output goes to stderr)
  local file="$1" app="$2" name
  name="$(basename "${file}" .yaml)"
  {
    echo "::group::Flow ${name}"
    APP_ID="${app}" FLOW="${file}" WALK_OUT="${UI_OUT}/${name}" WALK_TIMEOUT="${WALK_TIMEOUT:-600}" bash "${HERE}/android-walk.sh"
    echo "::endgroup::"
  } >&2
  grep -m 1 '^maestro_exit=' "${UI_OUT}/${name}/status.env" 2>/dev/null | cut -d= -f2-
}

rc="$(run_flow "${FLOW_DIR}/00-fingerprint.yaml" com.android.settings)"
sh_ dumpsys fingerprint > "${UI_OUT}/dumpsys-fingerprint.txt" || true
status flow_00-fingerprint "${rc:-not-run}"
if [ "${rc}" != 0 ]; then
  status stopped_at 00-fingerprint
  exit 0
fi
sh_ input keyevent KEYCODE_HOME > /dev/null || true

flows="${FLOWS:-$(cd "${FLOW_DIR}" && ls [0-9][0-9]-*.yaml | grep -v '^00-' | tr '\n' ' ')}"
status flows "${flows}"
for f in ${flows}; do
  name="$(basename "${f}" .yaml)"
  rc="$(run_flow "${FLOW_DIR}/${f}" "${APP_ID}")"
  status "flow_${name}" "${rc:-not-run}"
  if [ "${rc}" != 0 ]; then
    status stopped_at "${name}"
    break
  fi
done

# What the rig and the guardians logged, for the report and the artifact.
curl -fsS --max-time 10 "${RIG_URL}/log?guardian=1&lines=200" > "${UI_OUT}/guardian-1-tail.json" 2>/dev/null || true
curl -fsS --max-time 10 "${RIG_URL}/log?guardian=2&lines=200" > "${UI_OUT}/guardian-2-tail.json" 2>/dev/null || true
echo "Saved:"; ls -la "${UI_OUT}"
exit 0
