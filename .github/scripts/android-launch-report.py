#!/usr/bin/env python3
"""Judges what .github/scripts/android-launch.sh recorded and reports it.

    python3 .github/scripts/android-launch-report.py launch-out

Fails (exit 1) when the APK did not install, the app's process was gone after the wait, or the log shows a
crash: a Java/Kotlin FATAL EXCEPTION, a JavaScript error (ReactNativeJS at error level), or a native crash
(libc "Fatal signal", crash_dump's DEBUG lines). The lines that say why are printed as `::error`
annotations, most telling first: CI log downloads are blocked for us and annotations can still be read
through the checks API (see e2e.yml). GitHub keeps only 10 error annotations per step, so the lines go in a
few numbered annotations of up to 20 lines each rather than one each. When the app runs, it prints one
`::notice` with the first JavaScript log lines.

Also writes logcat-app.txt (the app's own lines plus the crash-related tags) and report.txt into the
directory, and a summary to $GITHUB_STEP_SUMMARY when set.
"""
from __future__ import annotations

import os
import re
import sys
from dataclasses import dataclass
from pathlib import Path

MAX_LINES = 80
LINES_PER_ANNOTATION = 20
MAX_LINE_CHARS = 400
TITLE = "APK launch"

# Tags that matter even from another process (crash_dump writes the native crash report as DEBUG).
CRASH_TAGS = {
    "AndroidRuntime", "ReactNativeJS", "ReactNative", "ReactNativeJNI", "unknown:ReactNative",
    "Hermes", "HermesVM", "libc", "DEBUG", "SoLoader", "ExpoModulesCore",
}
JS_ERROR = re.compile(
    r"(\w*Error\b|Exception|Invariant Violation|Unhandled|is not a function|undefined is not|"
    r"Cannot read propert|Requiring unknown module|has not been registered|TurboModuleRegistry)"
)
# threadtime: "10-30 12:34:56.789  1234  1250 E Tag     : message"
LINE = re.compile(r"^\d\d-\d\d\s+\S+\s+(\d+)\s+(\d+)\s+([VDIWEFA])\s+(.*?)\s*: ?(.*)$")


@dataclass(frozen=True)
class Entry:
    pid: str
    level: str
    tag: str
    msg: str
    raw: str

    def short(self) -> str:
        text = f"{self.level} {self.tag}: {self.msg}".rstrip()
        return text if len(text) <= MAX_LINE_CHARS else text[: MAX_LINE_CHARS - 1] + "…"


def parse(text: str) -> list[Entry]:
    out = []
    for raw in text.splitlines():
        m = LINE.match(raw)
        if m:
            out.append(Entry(pid=m.group(1), level=m.group(3), tag=m.group(4), msg=m.group(5), raw=raw))
    return out


def read(path: Path) -> str:
    try:
        return path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return ""


def read_status(path: Path) -> dict[str, str]:
    status = {}
    for line in read(path).splitlines():
        key, sep, value = line.partition("=")
        if sep:
            status[key.strip()] = value.strip()
    return status


def app_pids(status: dict[str, str], entries: list[Entry], exit_info: str, app_id: str) -> set[str]:
    pids = set(status.get("pids", "").split()) | set(status.get("final_pid", "").split())
    start = re.compile(r"Start proc (\d+):" + re.escape(app_id) + r"(?:/|:|\s)")
    died = re.compile(r"Process " + re.escape(app_id) + r" \(pid (\d+)\)")
    for e in entries:
        for rx in (start, died):
            m = rx.search(e.msg)
            if m:
                pids.add(m.group(1))
    for m in re.finditer(r"\bpid=(\d+)", exit_info):
        pids.add(m.group(1))
    return {p for p in pids if p}


def fatal_blocks(entries: list[Entry]) -> list[Entry]:
    """Each FATAL EXCEPTION with the AndroidRuntime lines of the same process that follow it."""
    out: list[Entry] = []
    for i, e in enumerate(entries):
        if e.tag == "AndroidRuntime" and "FATAL EXCEPTION" in e.msg:
            out.append(e)
            for f in entries[i + 1:]:
                if f.pid != e.pid:
                    continue
                if f.tag != "AndroidRuntime" or "FATAL EXCEPTION" in f.msg:
                    break
                out.append(f)
    return out


JS_TAGS = {"ReactNativeJS", "unknown:ReactNative", "ReactNative", "ReactNativeJNI", "Hermes", "HermesVM"}


def js_errors(entries: list[Entry], pids: set[str]) -> list[Entry]:
    """Error-level JavaScript/React Native lines, if any of them reads like an error (message and stack)."""
    errs = [e for e in entries if e.level in "EF" and e.tag in JS_TAGS and (not pids or e.pid in pids)]
    return errs if any(JS_ERROR.search(e.msg) for e in errs) else []


def native_crash(entries: list[Entry], pids: set[str]) -> list[Entry]:
    out: list[Entry] = []
    frames = 0
    for e in entries:
        if e.tag == "libc" and "Fatal signal" in e.msg and (not pids or e.pid in pids):
            out.append(e)
        elif e.tag == "DEBUG" and e.level in "EF":
            if re.search(r"#\d+ pc ", e.msg):
                if frames < 25:
                    out.append(e)
                frames += 1
            elif re.search(r"Abort message|signal \d+|Cause:|pid: \d+|Build fingerprint|backtrace:", e.msg):
                out.append(e)
    # A tombstone from an unrelated process is not ours: without the app's own "Fatal signal" line, keep the
    # DEBUG lines only if they name one of the app's pids.
    if out and pids and not any(e.tag == "libc" for e in out):
        named = {m.group(1) for e in out for m in [re.search(r"pid: (\d+)", e.msg)] if m}
        if not named & pids:
            return []
    return out


def exit_reasons(exit_info: str, pids: set[str]) -> list[str]:
    """The ApplicationExitInfo lines for this launch's processes (reason, description)."""
    lines, keep = [], False
    for line in exit_info.splitlines():
        s = line.strip()
        m = re.search(r"\bpid=(\d+)", s)
        if m:
            keep = m.group(1) in pids
        if keep and re.search(r"\b(reason|description|status|subreason)=", s):
            lines.append("exit-info: " + s)
    return lines[:6]


def dedupe(entries: list[Entry]) -> list[str]:
    seen, out = set(), []
    for e in entries:
        key = (e.tag, e.msg.strip())
        if key in seen or not e.msg.strip():
            continue
        seen.add(key)
        out.append(e.short())
    return out


def escape(message: str) -> str:
    return message.replace("%", "%25").replace("\r", "%0D").replace("\n", "%0A")


def annotate(kind: str, title: str, lines: list[str]) -> None:
    print(f"::{kind} title={title}::{escape(chr(10).join(lines))}")


def main(argv: list[str]) -> int:
    out_dir = Path(argv[1] if len(argv) > 1 else "launch-out")
    status = read_status(out_dir / "status.env")
    summary_path = os.environ.get("GITHUB_STEP_SUMMARY")

    if not status:
        annotate("error", TITLE, [f"The emulator step left no results in {out_dir}: the emulator did not boot, or the launch script did not run. See the 'Launch the APK in an emulator' step."])
        return 1

    app_id = status.get("app_id", "")
    if status.get("install") != "ok":
        detail = read(out_dir / "install.txt").strip().splitlines()[-10:]
        annotate("error", TITLE, [f"adb install of {status.get('apk', 'the APK')} failed on a {status.get('device_abi', '?')} emulator (API {status.get('device_sdk', '?')}):", *detail])
        return 1

    all_text = read(out_dir / "logcat-all.txt")
    entries = parse(all_text)
    crash_entries = parse(read(out_dir / "logcat-crash.txt"))
    # The crash buffer is in the default dump too; use it alone only if the main dump has none of it.
    if crash_entries and not any(e.raw in all_text for e in crash_entries[:3]):
        entries = entries + crash_entries
    exit_info = read(out_dir / "exit-info.txt")
    pids = app_pids(status, entries, exit_info, app_id)

    app_lines = [e for e in entries
                 if e.pid in pids or e.tag in CRASH_TAGS or (e.tag == "ActivityManager" and app_id in e.msg)]
    (out_dir / "logcat-app.txt").write_text("\n".join(e.raw for e in app_lines) + "\n", encoding="utf-8")

    alive = status.get("alive") == "yes"
    wait = status.get("wait_seconds", "?")
    fatal = fatal_blocks(entries)
    js = js_errors(entries, pids)
    native = native_crash(entries, pids)
    am = [e for e in entries if e.tag == "ActivityManager" and app_id in e.msg
          and re.search(r"has died|Force finishing|crash|ANR|Killing", e.msg)]
    reasons = exit_reasons(exit_info, pids)
    failed = not alive or bool(fatal or js or native)

    if not failed:
        rn = [e.short() for e in app_lines if e.tag == "ReactNativeJS"][:6]
        lines = [f"{app_id} is running after {wait} s (pid {status.get('final_pid')}, {status.get('device_abi')} emulator, API {status.get('device_sdk')})."]
        lines += ["First JavaScript log lines:", *rn] if rn else ["No ReactNativeJS lines were logged."]
        annotate("notice", TITLE, lines)
        report = lines
    else:
        if not alive and not pids:
            what = f"{app_id} never showed a process in {wait} s"
        elif not alive:
            what = f"{app_id} died within {wait} s of starting (pids {' '.join(sorted(pids))}; seen alive for {status.get('seconds_seen_alive', '?')} s)"
        else:
            what = f"{app_id} is still running after {wait} s but logged a crash or an error"
        kinds = [k for k, v in (("Java/Kotlin FATAL EXCEPTION", fatal), ("JavaScript error", js), ("native crash", native)) if v]
        head = [what + (": " + ", ".join(kinds) if kinds else "") + "."]
        relevant = dedupe(fatal) + dedupe(js) + dedupe(native) + dedupe(am)
        if not (fatal or js or native):
            # Nothing labelled as a crash: show the end of what the app logged, warnings and errors first.
            own = [e for e in app_lines if e.pid in pids]
            loud = [e for e in own if e.level in "WEF"]
            relevant += dedupe((loud or own)[-40:])
        relevant = list(dict.fromkeys(relevant))[:MAX_LINES]
        annotate("error", TITLE, head + reasons)
        chunks = [relevant[i:i + LINES_PER_ANNOTATION] for i in range(0, len(relevant), LINES_PER_ANNOTATION)]
        for n, chunk in enumerate(chunks, 1):
            annotate("error", f"{TITLE} log {n} of {len(chunks)}", chunk)
        report = head + reasons + relevant

    (out_dir / "report.txt").write_text("\n".join(report) + "\n", encoding="utf-8")
    if summary_path:
        with open(summary_path, "a", encoding="utf-8") as f:
            f.write(f"## Android launch check: {'failed' if failed else 'passed'}\n\n")
            f.write(f"`{status.get('apk', '')}` on a {status.get('device_abi', '?')} emulator, API {status.get('device_sdk', '?')}. ")
            f.write("The full logcat, the app's lines, a screenshot and any tombstones are in the `android-launch-logcat` artifact.\n\n")
            f.write("```\n" + "\n".join(report).replace("```", "'''") + "\n```\n")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
