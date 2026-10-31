#!/usr/bin/env bash
# Walks through the demo with Maestro (apps/mobile/.maestro/demo-walk.yaml) in the iOS Simulator that ios-launch.sh
# booted and opened the app in, and records what happened for demo-walk-report.py. Run by
# .github/workflows/ios-launch.yml, but works on any Mac with Xcode and maestro on the PATH:
#
#   OUT=launch-out WALK_OUT=walk-out bash .github/scripts/ios-walk.sh
#
# It takes the simulator, the bundle id and the executable name from OUT/status.env (DEVICE_UDID, BUNDLE_ID and EXE
# override them), and runs only if the launch check saw the app running: a launch failure is the launch report's to
# explain. It streams the app's log, runs the flow (at most WALK_TIMEOUT seconds, 600 by default; the first run on a
# simulator also installs Maestro's XCTest driver), then saves into WALK_OUT: Maestro's console output, its JUnit
# report, debug output and screenshots (maestro/), the app's log during the walk (streamed, and `log show` afterwards),
# a screenshot of the end, the crash reports (.ips) the app left, and status.env (what it saw, as key=value lines). It
# does not judge: the report script does. It exits 0 unless it was called wrongly, so the report runs on what it
# collected.
set -uo pipefail

: "${OUT:?OUT: directory of the launch check, whose status.env names the simulator and the app}"
: "${WALK_OUT:?WALK_OUT: directory for the results}"
FLOW="${FLOW:-apps/mobile/.maestro/demo-walk.yaml}"
WALK_TIMEOUT="${WALK_TIMEOUT:-600}"

[[ "${WALK_TIMEOUT}" =~ ^[0-9]+$ ]] || { echo "WALK_TIMEOUT must be a number" >&2; exit 2; }
[ -f "${FLOW}" ] || { echo "No flow at ${FLOW}" >&2; exit 2; }

mkdir -p "${WALK_OUT}"
WALK_OUT="$(cd "${WALK_OUT}" && pwd)"
: > "${WALK_OUT}/status.env"
status() { printf '%s=%s\n' "$1" "$(printf '%s' "$2" | tr '\n' ' ')" >> "${WALK_OUT}/status.env"; }
launch() { grep -m 1 "^$1=" "${OUT}/status.env" 2>/dev/null | cut -d= -f2-; }

# Runs a command for at most $1 seconds; 124 when it had to be stopped. (macOS has no `timeout`.)
with_timeout() {
  local secs="$1"; shift
  "$@" &
  local pid=$! waited=0
  while kill -0 "${pid}" 2>/dev/null; do
    if [ "${waited}" -ge "${secs}" ]; then
      kill "${pid}" 2>/dev/null; sleep 5; kill -9 "${pid}" 2>/dev/null
      wait "${pid}" 2>/dev/null
      return 124
    fi
    sleep 1
    waited=$((waited + 1))
  done
  wait "${pid}"
}

UDID="${DEVICE_UDID:-$(launch device_udid)}"
BUNDLE_ID="${BUNDLE_ID:-$(launch bundle_id)}"
EXE="${EXE:-$(launch executable)}"
status platform ios
status flow "${FLOW}"
status timeout_seconds "${WALK_TIMEOUT}"
status device_udid "${UDID}"
status device_name "$(launch device_name)"
status device_runtime "$(launch device_runtime)"
status xcode "$(launch xcode)"
status bundle_id "${BUNDLE_ID}"
status executable "${EXE}"

if [ "$(launch alive)" != yes ]; then
  status walk skipped
  status skip_reason "the launch check did not see the app running (alive=$(launch alive)); its report says why"
  echo "Demo walk skipped: the launch check failed"
  exit 0
fi
[[ "${BUNDLE_ID}" =~ ^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$ ]] || { echo "Unexpected bundle id: ${BUNDLE_ID}" >&2; exit 2; }
[[ "${EXE}" =~ ^[A-Za-z0-9_.-]+$ ]] || { echo "Unexpected executable name: ${EXE}" >&2; exit 2; }
[[ "${UDID}" =~ ^[A-Fa-f0-9-]+$ ]] || { echo "Unexpected simulator udid: ${UDID}" >&2; exit 2; }
if ! command -v maestro >/dev/null 2>&1; then
  status walk not-run
  status skip_reason "maestro is not on the PATH (the 'Install Maestro' step did not run or failed)"
  exit 0
fi
status maestro_version "$(maestro --version 2>/dev/null | tail -n 1)"

# The flow names the app by app.json's bundle id; a build with another one (TRIKEY_IOS_BUNDLE_ID) gets a copy with its own.
mkdir -p "${WALK_OUT}/flow" "${WALK_OUT}/maestro"
flow="${WALK_OUT}/flow/$(basename "${FLOW}")"
sed -E "s/^appId: .*/appId: ${BUNDLE_ID}/" "${FLOW}" > "${flow}"

# Crash reports newer than this marker are from the walk.
marker="${WALK_OUT}/.walk-marker"
touch "${marker}"
sleep 1
log_start="$(date '+%Y-%m-%d %H:%M:%S')"
status log_start "${log_start}"
predicate="process == \"${EXE}\" OR eventMessage CONTAINS \"${BUNDLE_ID}\""
xcrun simctl spawn "${UDID}" log stream --level debug --style compact --predicate "${predicate}" \
  > "${WALK_OUT}/log-stream.txt" 2>&1 &
stream_pid=$!
sleep 2

start="$(date +%s)"
status started_at "$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
echo "Running ${FLOW} with Maestro on ${UDID} (at most ${WALK_TIMEOUT} s)"
# The driver can take a while to start on a fresh simulator.
export MAESTRO_DRIVER_STARTUP_TIMEOUT="${MAESTRO_DRIVER_STARTUP_TIMEOUT:-180000}"
with_timeout "${WALK_TIMEOUT}" \
  maestro --device "${UDID}" test --no-ansi \
    --format junit --output "${WALK_OUT}/maestro/report.xml" \
    --debug-output "${WALK_OUT}/maestro/debug" --flatten-debug-output \
    --test-output-dir "${WALK_OUT}/maestro/output" \
    "${flow}" > "${WALK_OUT}/maestro-console.txt" 2>&1
rc=$?
cat "${WALK_OUT}/maestro-console.txt"
status maestro_exit "${rc}"
status timed_out "$([ "${rc}" = 124 ] && echo yes || echo no)"
status walk_seconds "$(($(date +%s) - start))"
status walk ran
echo "Maestro exited ${rc} after $(($(date +%s) - start)) s"

# On a failure, what was on screen (the reporter posts it; the screenshots are only in the artifact).
if [ "${rc}" != 0 ]; then
  with_timeout 90 maestro --device "${UDID}" hierarchy > "${WALK_OUT}/hierarchy.json" 2>/dev/null || true
  [ -s "${WALK_OUT}/hierarchy.json" ] || rm -f "${WALK_OUT}/hierarchy.json"
fi

final_pid="$(xcrun simctl spawn "${UDID}" launchctl list 2>/dev/null \
  | awk -v id="UIKitApplication:${BUNDLE_ID}[" 'index($3, id) == 1 && $1 ~ /^[0-9]+$/ { print $1; exit }')"
status final_pid "${final_pid}"
status alive "$([ -n "${final_pid}" ] && echo yes || echo no)"
xcrun simctl io "${UDID}" screenshot "${WALK_OUT}/screen-end.png" >/dev/null 2>&1 || rm -f "${WALK_OUT}/screen-end.png"

# A simulator app's crash report is written on the host by ReportCrash, a few seconds after the crash.
find_reports() {
  local dir
  for dir in "${HOME}/Library/Logs/DiagnosticReports" /Library/Logs/DiagnosticReports; do
    [ -d "${dir}" ] || continue
    find "${dir}" -type f \( -name '*.ips' -o -name '*.crash' \) -newer "${marker}" 2>/dev/null
  done
}
ours() { grep -l -F -e "${BUNDLE_ID}" -e "\"${EXE}\"" "$@" 2>/dev/null; }
[ "${rc}" = 0 ] || sleep 5 # a failed walk may be a crash: give its report time to be written
reports="$(find_reports | while IFS= read -r f; do ours "${f}"; done)"
mkdir -p "${WALK_OUT}/crash-reports"
count=0
if [ -n "${reports}" ]; then
  while IFS= read -r f; do
    [ -n "${f}" ] || continue
    cp "${f}" "${WALK_OUT}/crash-reports/" && count=$((count + 1))
  done <<<"${reports}"
fi
rmdir "${WALK_OUT}/crash-reports" 2>/dev/null || true
status crash_reports "${count}"

sleep 2
kill "${stream_pid}" 2>/dev/null
wait "${stream_pid}" 2>/dev/null
# `log show` as well: the stream can miss the first lines of a process that dies at once.
with_timeout 120 xcrun simctl spawn "${UDID}" log show --style compact --info --debug --start "${log_start}" \
  --predicate "${predicate}" > "${WALK_OUT}/log-app.txt" 2>&1 || true

echo "Saved:"; ls -la "${WALK_OUT}"
exit 0
