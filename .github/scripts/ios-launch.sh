#!/usr/bin/env bash
# Opens the app in an iOS Simulator and records what happened, for ios-launch-report.py.
# Run by .github/workflows/ios-launch.yml, but works on any Mac with Xcode against a simulator build:
#
#   APP=path/to/Trikey.app OUT=launch-out bash .github/scripts/ios-launch.sh
#
# It reads the bundle id and the executable name from the app's Info.plist, boots a clean iPhone simulator
# (an available one on the newest iOS runtime, erased first, or a new one if the runtime has none), installs
# the app, streams the app's log, launches it, watches its process for WAIT_SECONDS (25 by default), then
# saves into OUT: the app's log (streamed, and `log show` afterwards), the whole simulator log since the
# launch, a screenshot, the crash reports (.ips) the app left, and status.env (what it saw, as key=value
# lines). It does not judge: the report script does. It exits 0 unless it was called wrongly, so the report
# runs on what it collected. DEVICE_UDID picks a simulator instead.
set -uo pipefail

: "${APP:?APP: path of the .app to install (a simulator build)}"
: "${OUT:?OUT: directory for the results}"
WAIT_SECONDS="${WAIT_SECONDS:-25}"
BOOT_TIMEOUT="${BOOT_TIMEOUT:-420}"

[[ "${WAIT_SECONDS}" =~ ^[0-9]+$ ]] || { echo "WAIT_SECONDS must be a number" >&2; exit 2; }
[[ "${BOOT_TIMEOUT}" =~ ^[0-9]+$ ]] || { echo "BOOT_TIMEOUT must be a number" >&2; exit 2; }
APP="${APP%/}"
[ -f "${APP}/Info.plist" ] || { echo "No app bundle at ${APP} (no Info.plist)" >&2; exit 2; }

mkdir -p "${OUT}"
OUT="$(cd "${OUT}" && pwd)"
: > "${OUT}/status.env"
status() { printf '%s=%s\n' "$1" "$(printf '%s' "$2" | tr '\n' ' ')" >> "${OUT}/status.env"; }
PLISTBUDDY="${PLISTBUDDY:-/usr/libexec/PlistBuddy}"
plist() { "${PLISTBUDDY}" -c "Print :$1" "${APP}/Info.plist" 2>/dev/null; }

# Runs a command for at most $1 seconds; 124 when it had to be stopped.
with_timeout() {
  local secs="$1"; shift
  "$@" &
  local pid=$! waited=0
  while kill -0 "${pid}" 2>/dev/null; do
    if [ "${waited}" -ge "${secs}" ]; then
      kill "${pid}" 2>/dev/null; sleep 1; kill -9 "${pid}" 2>/dev/null
      wait "${pid}" 2>/dev/null
      return 124
    fi
    sleep 1
    waited=$((waited + 1))
  done
  wait "${pid}"
}

BUNDLE_ID="$(plist CFBundleIdentifier)"
EXE="$(plist CFBundleExecutable)"
[[ "${BUNDLE_ID}" =~ ^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$ ]] || { echo "Unexpected CFBundleIdentifier: ${BUNDLE_ID}" >&2; exit 2; }
[[ "${EXE}" =~ ^[A-Za-z0-9_.-]+$ ]] || { echo "Unexpected CFBundleExecutable: ${EXE}" >&2; exit 2; }
status app "$(basename "${APP}")"
status bundle_id "${BUNDLE_ID}"
status executable "${EXE}"
status app_version "$(plist CFBundleShortVersionString) ($(plist CFBundleVersion))"
status minimum_os "$(plist MinimumOSVersion)"
status sdk "$(plist DTSDKName)"
status js_bundle "$([ -f "${APP}/main.jsbundle" ] && echo yes || echo no)"
status xcode "$(xcodebuild -version 2>/dev/null | tr '\n' ' ' | sed 's/ *$//')"
status wait_seconds "${WAIT_SECONDS}"

# --- Pick and boot a simulator -------------------------------------------------------------------------------
xcrun simctl list devices available -j > "${OUT}/simctl-devices.json" 2>&1 || true
xcrun simctl list runtimes available -j > "${OUT}/simctl-runtimes.json" 2>&1 || true

if [ -n "${DEVICE_UDID:-}" ]; then
  choice="$(printf 'existing\t%s\t%s\t%s' "${DEVICE_UDID}" "chosen by DEVICE_UDID" "?")"
else
  # Newest iOS runtime that has an iPhone (or can make one). Prints: existing|create, udid|device type, name, runtime.
  # (Written to a file rather than a here-document inside $(...), which macOS's bash 3.2 parses badly.)
  pick="${OUT}/.pick-device.py"
  cat > "${pick}" <<'PY'
import json, re, sys
try:
    devices = json.load(open(sys.argv[1]))["devices"]
    runtimes = json.load(open(sys.argv[2]))["runtimes"]
except Exception as e:  # noqa: BLE001
    print(f"none\t\t\tcannot read simctl output: {e}")
    sys.exit(0)
def version(r):
    return [int(x) for x in re.findall(r"\d+", r.get("version", ""))]
ios = [r for r in runtimes if r.get("isAvailable", True) and (r.get("platform") == "iOS" or r.get("name", "").startswith("iOS"))]
for r in sorted(ios, key=version, reverse=True):
    phones = [d for d in devices.get(r["identifier"], []) if d.get("isAvailable", True) and d.get("name", "").startswith("iPhone")]
    if phones:
        # Prefer a plain current model ("iPhone 17") over Pro/Max/e variants: the most common screen.
        phones.sort(key=lambda d: (len(d["name"]), d["name"]))
        d = phones[0]
        print(f"existing\t{d['udid']}\t{d['name']}\t{r['name']}")
        sys.exit(0)
    types = [t for t in r.get("supportedDeviceTypes", []) if t.get("productFamily") == "iPhone"]
    if types:
        t = types[-1]
        print(f"create\t{t['identifier']}\t{t['name']}\t{r['identifier']}\t{r['name']}")
        sys.exit(0)
print("none\t\t\tno available iOS runtime with an iPhone")
PY
  choice="$(python3 "${pick}" "${OUT}/simctl-devices.json" "${OUT}/simctl-runtimes.json")"
  rm -f "${pick}"
fi
IFS=$'\t' read -r kind first name runtime runtime_name <<<"${choice}"
case "${kind}" in
  existing)
    UDID="${first}"
    # A clean device, like a phone on its first start. Fine if it fails (already clean, or never booted).
    xcrun simctl shutdown "${UDID}" >/dev/null 2>&1 || true
    xcrun simctl erase "${UDID}" >/dev/null 2>&1 || true
    ;;
  create)
    runtime_id="${runtime}"; runtime="${runtime_name}"
    UDID="$(xcrun simctl create "Trikey CI ${name}" "${first}" "${runtime_id}" 2>"${OUT}/simctl-create.txt")" || UDID=""
    ;;
  *)
    UDID=""; runtime="${runtime:-}${runtime_name:-}"
    ;;
esac
status device_name "${name:-}"
status device_runtime "${runtime:-}"
status device_udid "${UDID}"
if [ -z "${UDID}" ]; then
  status boot failed
  { echo "No simulator to boot: ${choice}"; cat "${OUT}/simctl-create.txt" 2>/dev/null; } | tee "${OUT}/boot.txt"
  exit 0
fi

echo "Booting ${name} (${runtime}, ${UDID})"
if with_timeout "${BOOT_TIMEOUT}" xcrun simctl bootstatus "${UDID}" -b > "${OUT}/boot.txt" 2>&1; then
  status boot ok
else
  rc=$?
  status boot "failed (exit ${rc}$([ "${rc}" = 124 ] && echo ", not booted after ${BOOT_TIMEOUT} s"))"
  tail -n 20 "${OUT}/boot.txt"
  exit 0
fi
sleep 3 # let SpringBoard settle after the boot finishes

# --- Install ---------------------------------------------------------------------------------------------------
echo "Installing $(basename "${APP}")"
if with_timeout 300 xcrun simctl install "${UDID}" "${APP}" > "${OUT}/install.txt" 2>&1; then
  status install ok
else
  status install failed
  cat "${OUT}/install.txt"
  exit 0
fi

# --- Launch and watch ------------------------------------------------------------------------------------------
# Crash reports newer than this marker are from this launch.
marker="${OUT}/.launch-marker"
touch "${marker}"
sleep 1
start="$(date '+%Y-%m-%d %H:%M:%S')"
status log_start "${start}"

# The app's own lines, and lines of other processes (SpringBoard, runningboardd, launchd_sim) that name it:
# the latter say when and why it was ended (watchdog, exit, signal).
predicate="process == \"${EXE}\" OR eventMessage CONTAINS \"${BUNDLE_ID}\""
xcrun simctl spawn "${UDID}" log stream --level debug --style compact --predicate "${predicate}" \
  > "${OUT}/log-stream.txt" 2>&1 &
stream_pid=$!
sleep 3

echo "Launching ${BUNDLE_ID}"
launch_ok=no
if with_timeout 120 xcrun simctl launch "${UDID}" "${BUNDLE_ID}" > "${OUT}/launch.txt" 2>&1; then
  launch_ok=yes
fi
cat "${OUT}/launch.txt"
status launch "$([ "${launch_ok}" = yes ] && echo ok || echo failed)"
# "app.trikey.wallet: 12345"
launch_pid="$(awk -v id="${BUNDLE_ID}:" '$1 == id && $2 ~ /^[0-9]+$/ { print $2; exit }' "${OUT}/launch.txt")"
status launch_pid "${launch_pid}"

# The app's pid as launchd_sim sees it ("12345  0  UIKitApplication:app.trikey.wallet[...]"), else the launch pid
# if that process is still there. Simulator apps are ordinary host processes, so kill -0 works on them.
running_pid() {
  local p
  p="$(xcrun simctl spawn "${UDID}" launchctl list 2>/dev/null \
    | awk -v id="UIKitApplication:${BUNDLE_ID}[" 'index($3, id) == 1 && $1 ~ /^[0-9]+$/ { print $1; exit }')"
  if [ -z "${p}" ] && [ -n "${launch_pid}" ] && kill -0 "${launch_pid}" 2>/dev/null; then p="${launch_pid}"; fi
  printf '%s' "${p}"
}

pids=""
alive_since=0
for ((i = 0; i < WAIT_SECONDS; i++)); do
  pid="$(running_pid)"
  if [ -n "${pid}" ]; then
    alive_since=$((alive_since + 1))
    [[ " ${pids} " == *" ${pid} "* ]] || pids="${pids:+${pids} }${pid}"
  fi
  sleep 1
done
final_pid="$(running_pid)"
status pids "${pids}"
status final_pid "${final_pid}"
status alive "$([ -n "${final_pid}" ] && echo yes || echo no)"
status seconds_seen_alive "${alive_since}"
echo "After ${WAIT_SECONDS} s: pid '${final_pid}' (pids seen: '${pids}')"

xcrun simctl io "${UDID}" screenshot "${OUT}/screen.png" >/dev/null 2>&1 || rm -f "${OUT}/screen.png"

# --- Crash reports ---------------------------------------------------------------------------------------------
# A simulator app's crash report is written on the host, by ReportCrash, a few seconds after the crash.
find_reports() {
  local dir
  for dir in "${HOME}/Library/Logs/DiagnosticReports" /Library/Logs/DiagnosticReports; do
    [ -d "${dir}" ] || continue
    find "${dir}" -type f \( -name '*.ips' -o -name '*.crash' \) -newer "${marker}" 2>/dev/null
  done
}
ours() { grep -l -F -e "${BUNDLE_ID}" -e "\"${EXE}\"" "$@" 2>/dev/null; }
reports=""
for ((i = 0; i < 15; i++)); do
  candidates="$(find_reports)"
  [ -n "${candidates}" ] && reports="$(printf '%s\n' "${candidates}" | while IFS= read -r f; do ours "${f}"; done)"
  # Running app: one look is enough. Dead app: wait up to 15 s for its report.
  if [ -n "${reports}" ] || [ -n "${final_pid}" ]; then break; fi
  sleep 1
done
find_reports > "${OUT}/crash-reports-all.txt" || true
mkdir -p "${OUT}/crash-reports"
count=0
if [ -n "${reports}" ]; then
  while IFS= read -r f; do
    [ -n "${f}" ] || continue
    cp "${f}" "${OUT}/crash-reports/" && count=$((count + 1))
  done <<<"${reports}"
fi
rmdir "${OUT}/crash-reports" 2>/dev/null || true
status crash_reports "${count}"

# --- Logs ------------------------------------------------------------------------------------------------------
sleep 2
kill "${stream_pid}" 2>/dev/null
wait "${stream_pid}" 2>/dev/null
# `log show` as well: the stream can miss the first lines of a process that dies at once.
with_timeout 120 xcrun simctl spawn "${UDID}" log show --style compact --info --debug --start "${start}" \
  --predicate "${predicate}" > "${OUT}/log-app.txt" 2>&1 || true
with_timeout 180 xcrun simctl spawn "${UDID}" log show --style compact --info --start "${start}" \
  > "${OUT}/log-all.txt" 2>&1 || true

echo "Saved:"; ls -la "${OUT}"
exit 0
