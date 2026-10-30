#!/usr/bin/env bash
# Opens the app in a booted Android emulator and records what happened, for android-launch-report.py.
# Run by reactivecircus/android-emulator-runner in .github/workflows/android-launch.yml, but works against
# any emulator or phone adb can see:
#
#   APK=trikey.apk APP_ID=app.trikey.wallet OUT=launch-out bash .github/scripts/android-launch.sh
#
# It installs the APK (no permissions granted up front: like a phone on its first start), clears the logs,
# starts the launcher activity, watches the app's process for WAIT_SECONDS (25 by default), then saves into
# OUT: the full logcat, the crash buffer, the app's exit records, a screenshot, any tombstones, and
# status.env (what it saw, as key=value lines). It does not judge: the report script does. It exits 0 unless
# it was called wrongly, so the report runs on what it collected.
set -uo pipefail

: "${APK:?APK: path of the APK to install}"
: "${APP_ID:?APP_ID: the application id (android.package)}"
: "${OUT:?OUT: directory for the results}"
WAIT_SECONDS="${WAIT_SECONDS:-25}"

[[ "${APP_ID}" =~ ^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$ ]] || { echo "Unexpected application id: ${APP_ID}" >&2; exit 2; }
[[ "${WAIT_SECONDS}" =~ ^[0-9]+$ ]] || { echo "WAIT_SECONDS must be a number" >&2; exit 2; }
[ -f "${APK}" ] || { echo "No APK at ${APK}" >&2; exit 2; }

mkdir -p "${OUT}"
: > "${OUT}/status.env"
status() { printf '%s=%s\n' "$1" "$2" >> "${OUT}/status.env"; }
sh_() { adb shell "$@" 2>/dev/null | tr -d '\r'; }

adb wait-for-device
# Root (allowed on google_apis images) only to read tombstones after a native crash; fine if refused.
if adb root >/dev/null 2>&1; then sleep 2; adb wait-for-device; fi
status device_abi "$(sh_ getprop ro.product.cpu.abi)"
status device_sdk "$(sh_ getprop ro.build.version.sdk)"
status apk "$(basename "${APK}")"
status app_id "${APP_ID}"
status wait_seconds "${WAIT_SECONDS}"

echo "Installing $(basename "${APK}")"
if adb install -r "${APK}" > "${OUT}/install.txt" 2>&1; then
  status install ok
else
  status install failed
  cat "${OUT}/install.txt"
  exit 0
fi

# Big buffers, then empty, so the log holds this launch and nothing before it.
adb logcat -G 16M >/dev/null 2>&1 || true
adb logcat -b all -c || adb logcat -c || true

activity="$(sh_ cmd package resolve-activity --brief -a android.intent.action.MAIN -c android.intent.category.LAUNCHER "${APP_ID}" | tail -n 1)"
if [[ "${activity}" == "${APP_ID}/"* ]]; then
  echo "Starting ${activity}"
  status activity "${activity}"
  adb shell am start -W -n "${activity}" > "${OUT}/am-start.txt" 2>&1 || true
else
  echo "No launcher activity resolved (${activity}); starting through monkey"
  status activity "monkey"
  adb shell monkey -p "${APP_ID}" -c android.intent.category.LAUNCHER 1 > "${OUT}/am-start.txt" 2>&1 || true
fi
tr -d '\r' < "${OUT}/am-start.txt"

# Every pid the app had while we watched (it can die and be started again by the system).
pids=""
alive_since=0
for ((i = 0; i < WAIT_SECONDS; i++)); do
  pid="$(sh_ pidof "${APP_ID}")"
  if [ -n "${pid}" ]; then
    alive_since=$((alive_since + 1))
    for p in ${pid}; do [[ " ${pids} " == *" ${p} "* ]] || pids="${pids:+${pids} }${p}"; done
  fi
  sleep 1
done

final_pid="$(sh_ pidof "${APP_ID}")"
status pids "${pids}"
status final_pid "${final_pid}"
status alive "$([ -n "${final_pid}" ] && echo yes || echo no)"
status seconds_seen_alive "${alive_since}"
status resumed "$(sh_ dumpsys activity activities | grep -m 1 -E 'topResumedActivity|mResumedActivity' | sed 's/^ *//')"
echo "After ${WAIT_SECONDS} s: pid '${final_pid}' (pids seen: '${pids}')"

adb exec-out screencap -p > "${OUT}/screen.png" 2>/dev/null || rm -f "${OUT}/screen.png"
adb logcat -d -v threadtime > "${OUT}/logcat-all.txt" 2>&1 || true
adb logcat -d -b crash -v threadtime > "${OUT}/logcat-crash.txt" 2>&1 || true
sh_ dumpsys activity exit-info "${APP_ID}" > "${OUT}/exit-info.txt" || true

# Native crashes leave a tombstone; readable with root. Fresh emulator, so any here are from this launch.
mkdir -p "${OUT}/tombstones"
for t in $(sh_ ls -t /data/tombstones/ | grep -v '\.pb$' | head -n 3); do
  adb pull "/data/tombstones/${t}" "${OUT}/tombstones/${t}.txt" >/dev/null 2>&1 || true
done
rmdir "${OUT}/tombstones" 2>/dev/null || true

echo "Saved:"; ls -la "${OUT}"
exit 0
