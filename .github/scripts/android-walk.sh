#!/usr/bin/env bash
# Walks through the demo with Maestro (apps/mobile/.maestro/demo-walk.yaml) in a booted Android emulator, after
# android-launch.sh opened the app, and records what happened for demo-walk-report.py. Run by
# reactivecircus/android-emulator-runner in .github/workflows/android-launch.yml, but works against any emulator or
# phone adb can see, with the app installed and maestro on the PATH:
#
#   APP_ID=app.trikey.wallet OUT=launch-out WALK_OUT=walk-out bash .github/scripts/android-walk.sh
#
# It runs only if the launch check saw the app running (OUT/status.env says alive=yes; without OUT/status.env it runs
# anyway): a launch failure is the launch report's to explain. It empties the logs, runs the flow (at most
# WALK_TIMEOUT seconds, 480 by default), then saves into WALK_OUT: Maestro's console output, its JUnit report, debug
# output and screenshots (maestro/), the full logcat of the walk, the crash buffer, the app's exit records, a screenshot
# of the end, any tombstones, and status.env (what it saw, as key=value lines). It does not judge: the report script
# does. It exits 0 unless it was called wrongly, so the report runs on what it collected.
set -uo pipefail

: "${APP_ID:?APP_ID: the application id (android.package)}"
: "${WALK_OUT:?WALK_OUT: directory for the results}"
OUT="${OUT:-}"
FLOW="${FLOW:-apps/mobile/.maestro/demo-walk.yaml}"
WALK_TIMEOUT="${WALK_TIMEOUT:-480}"

[[ "${APP_ID}" =~ ^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$ ]] || { echo "Unexpected application id: ${APP_ID}" >&2; exit 2; }
[[ "${WALK_TIMEOUT}" =~ ^[0-9]+$ ]] || { echo "WALK_TIMEOUT must be a number" >&2; exit 2; }
[ -f "${FLOW}" ] || { echo "No flow at ${FLOW}" >&2; exit 2; }

mkdir -p "${WALK_OUT}"
: > "${WALK_OUT}/status.env"
status() { printf '%s=%s\n' "$1" "$(printf '%s' "$2" | tr '\n' ' ')" >> "${WALK_OUT}/status.env"; }
sh_() { adb shell "$@" 2>/dev/null | tr -d '\r'; }

status platform android
status app_id "${APP_ID}"
status flow "${FLOW}"
status timeout_seconds "${WALK_TIMEOUT}"

if [ -n "${OUT}" ] && [ -f "${OUT}/status.env" ]; then
  launch_alive="$(grep -m 1 '^alive=' "${OUT}/status.env" | cut -d= -f2-)"
  if [ "${launch_alive}" != yes ]; then
    status walk skipped
    status skip_reason "the launch check did not see the app running (alive=${launch_alive:-?}); its report says why"
    echo "Demo walk skipped: the launch check failed"
    exit 0
  fi
fi
if ! command -v maestro >/dev/null 2>&1; then
  status walk not-run
  status skip_reason "maestro is not on the PATH (the 'Install Maestro' step did not run or failed)"
  exit 0
fi

adb wait-for-device
serial="$(adb get-serialno 2>/dev/null | tr -d '\r')"
status device_serial "${serial}"
device=()
[ -n "${serial}" ] && device=(--device "${serial}")
status device_abi "$(sh_ getprop ro.product.cpu.abi)"
status device_sdk "$(sh_ getprop ro.build.version.sdk)"
status maestro_version "$(maestro --version 2>/dev/null | tail -n 1)"

# The flow names the app by app.json's package; a build with another one (TRIKEY_ANDROID_PACKAGE) gets a copy with its own.
flow_dir="${WALK_OUT}/flow"
mkdir -p "${flow_dir}"
flow="${flow_dir}/$(basename "${FLOW}")"
sed -E "s/^appId: .*/appId: ${APP_ID}/" "${FLOW}" > "${flow}"

# The log of the walk only, in big buffers.
adb logcat -G 16M >/dev/null 2>&1 || true
adb logcat -b all -c || adb logcat -c || true

mkdir -p "${WALK_OUT}/maestro"
start="$(date +%s)"
status started_at "$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
echo "Running ${FLOW} with Maestro on ${serial:-the emulator} (at most ${WALK_TIMEOUT} s)"
# The driver can take a while to start on a slow emulator.
export MAESTRO_DRIVER_STARTUP_TIMEOUT="${MAESTRO_DRIVER_STARTUP_TIMEOUT:-180000}"
timeout --kill-after=30 "${WALK_TIMEOUT}" \
  maestro "${device[@]}" test --no-ansi \
    --format junit --output "${WALK_OUT}/maestro/report.xml" \
    --debug-output "${WALK_OUT}/maestro/debug" --flatten-debug-output \
    --test-output-dir "${WALK_OUT}/maestro/output" \
    "${flow}" 2>&1 | tee "${WALK_OUT}/maestro-console.txt"
rc="${PIPESTATUS[0]}"
status maestro_exit "${rc}"
status timed_out "$([ "${rc}" = 124 ] || [ "${rc}" = 137 ] && echo yes || echo no)"
status walk_seconds "$(($(date +%s) - start))"
status walk ran
echo "Maestro exited ${rc} after $(($(date +%s) - start)) s"

# On a failure, what was on screen (texts, ids, accessibility labels): the reporter posts it, since the screenshots are
# only in the artifact, which cannot be read from the check's annotations.
if [ "${rc}" != 0 ]; then
  timeout 90 maestro "${device[@]}" hierarchy > "${WALK_OUT}/hierarchy.json" 2>/dev/null || true
  [ -s "${WALK_OUT}/hierarchy.json" ] || rm -f "${WALK_OUT}/hierarchy.json"
fi

final_pid="$(sh_ pidof "${APP_ID}")"
status final_pid "${final_pid}"
status alive "$([ -n "${final_pid}" ] && echo yes || echo no)"
status resumed "$(sh_ dumpsys activity activities | grep -m 1 -E 'topResumedActivity|mResumedActivity' | sed 's/^ *//')"

adb exec-out screencap -p > "${WALK_OUT}/screen-end.png" 2>/dev/null || rm -f "${WALK_OUT}/screen-end.png"
adb logcat -d -v threadtime > "${WALK_OUT}/logcat-all.txt" 2>&1 || true
adb logcat -d -b crash -v threadtime > "${WALK_OUT}/logcat-crash.txt" 2>&1 || true
sh_ dumpsys activity exit-info "${APP_ID}" > "${WALK_OUT}/exit-info.txt" || true

# Tombstones (readable with root, which android-launch.sh asked for): the newest three, from the launch or the walk.
mkdir -p "${WALK_OUT}/tombstones"
for t in $(sh_ ls -t /data/tombstones/ | grep -v '\.pb$' | head -n 3); do
  adb pull "/data/tombstones/${t}" "${WALK_OUT}/tombstones/${t}.txt" >/dev/null 2>&1 || true
done
rmdir "${WALK_OUT}/tombstones" 2>/dev/null || true

echo "Saved:"; ls -la "${WALK_OUT}"
exit 0
