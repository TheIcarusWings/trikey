#!/usr/bin/env python3
"""Judges what .github/scripts/ios-launch.sh recorded and reports it; also reports a failed iOS build.

    python3 .github/scripts/ios-launch-report.py launch-out
    python3 .github/scripts/ios-launch-report.py --build-log build-logs/xcodebuild.log --step "Build the app"

Launch (the first form) fails (exit 1) when the simulator did not boot, the app did not install or launch, its
process was gone after the wait, it left a crash report (.ips), or its log shows a fatal error: a JavaScript error
(React Native's `javascript` log category at error level), "Unhandled JS Exception", RCTFatal, a Swift "Fatal
error", an uncaught Objective-C exception. The lines that say why are printed as `::error` annotations, most
telling first (the crash report's exception, reason and top frames, then the log lines): CI log downloads are
blocked for us and annotations can still be read through the checks API (see e2e.yml). GitHub keeps only 10
error annotations per step, so the lines go in a few numbered annotations of up to 20 lines each rather than one
each. When the app runs, it prints one `::notice` with the first JavaScript log lines. It writes report.txt into
the directory, and a summary to $GITHUB_STEP_SUMMARY when set. The same style as android-launch-report.py.

Build (the second form) posts the `error:` lines of a build log first, then its last 60 lines, the same way, and
exits 0 (the step that failed has already failed the job).
"""
from __future__ import annotations

import json
import os
import re
import sys
from dataclasses import dataclass, field
from pathlib import Path

MAX_LINES = 80
LINES_PER_ANNOTATION = 20
MAX_LINE_CHARS = 400
TITLE = "iOS launch"
BUILD_TITLE = "iOS build"
BUILD_ERROR_LINES = 40
BUILD_TAIL_LINES = 60

JS_ERROR = re.compile(
    r"(\w*Error\b|Exception|Invariant Violation|Unhandled|is not a function|undefined is not|"
    r"Cannot read propert|Requiring unknown module|has not been registered|TurboModuleRegistry)"
)
# Fatal whatever the level or category: the app is about to end, or React Native gave up on the JavaScript.
FATAL = re.compile(
    r"(Unhandled JS Exception|RCTFatal|\bFatal error\b|Terminating app due to uncaught exception|"
    r"libc\+\+abi: terminating|\*\*\* Assertion failure|Invariant Violation|has not been registered|"
    r"Requiring unknown module|EXC_BAD_ACCESS|EXC_CRASH)"
)
# Other processes' lines (SpringBoard, runningboardd, launchd_sim) that tell how the app ended.
ENDED = re.compile(r"(exited|terminat|crash|watchdog|jetsam|killed|signal|died|8badf00d|scene-create)", re.I)
KEYCHAIN = re.compile(r"(-34018|errSecMissingEntitlement)")

# `log stream/show --style compact`: "2026-10-30 12:34:56.789 E  Trikey[1234:5e6f] [com.facebook.react.log:javascript] msg"
COMPACT = re.compile(
    r"^(?P<ts>\d{4}-\d\d-\d\d \d\d:\d\d:\d\d\.\d+)\s+(?P<ty>[A-Za-z]{1,2})\s+(?P<proc>[^\[\]\s]+)"
    r"\[(?P<pid>\d+):(?P<tid>[0-9A-Fa-fx]+)\]\s+(?:\[(?P<sub>[^\]]*)\]\s+)?(?P<msg>.*)$"
)
# The default style: "2026-10-30 12:34:56.789012+0000 0x5e6f Error 0x0 1234 0 Trikey: (React) [com.facebook.react.log:javascript] msg"
DEFAULT = re.compile(
    r"^(?P<ts>\d{4}-\d\d-\d\d \d\d:\d\d:\d\d\.\d+[+-]\d{4})\s+0x[0-9a-f]+\s+(?P<ty>\w+)\s+0x[0-9a-f]+\s+"
    r"(?P<pid>\d+)\s+\d+\s+(?P<proc>[^:\s]+):\s+(?:\((?P<lib>[^)]*)\)\s+)?(?:\[(?P<sub>[^\]]*)\]\s+)?(?P<msg>.*)$"
)
# The headers and the closing statistics of `log stream` / `log show`, not part of any message.
NOT_LOG = re.compile(r"^(Filtering the log data|Timestamp\s|(Log|Activity|Signpost|Boundary|Statistics|TTL)\s+-|-{8,})")
LEVELS = {"df": "N", "default": "N", "i": "I", "info": "I", "db": "D", "debug": "D",
          "e": "E", "error": "E", "f": "F", "fault": "F"}
ANSI = re.compile(r"\x1b\[[0-9;]*[A-Za-z]")


@dataclass
class Entry:
    proc: str
    pid: str
    level: str  # N(otice/default), I, D, E, F
    sub: str
    msg: str
    extra: list[str] = field(default_factory=list)  # continuation lines (a JavaScript stack, a multi-line message)

    @property
    def is_js(self) -> bool:
        return ("javascript" in self.sub or "[javascript]" in self.msg or "ReactNativeJS" in self.msg
                or "tid:com.facebook.react.JavaScript" in self.msg)

    def text(self) -> str:
        return "\n".join([self.msg, *self.extra])

    def lines(self, more: int = 12) -> list[str]:
        where = f"{self.proc} [{self.sub}]" if self.sub else self.proc
        out = [clip(f"{self.level} {where}: {self.msg}".rstrip())]
        out += [clip("    " + x.strip()) for x in self.extra[:more] if x.strip()]
        return out


def clip(text: str) -> str:
    text = ANSI.sub("", text).rstrip()
    return text if len(text) <= MAX_LINE_CHARS else text[: MAX_LINE_CHARS - 1] + "…"


def parse_log(text: str) -> list[Entry]:
    out: list[Entry] = []
    for raw in text.splitlines():
        m = COMPACT.match(raw) or DEFAULT.match(raw)
        if m:
            level = LEVELS.get(m.group("ty").lower(), "N")
            out.append(Entry(proc=m.group("proc"), pid=m.group("pid"), level=level,
                             sub=m.group("sub") or "", msg=m.group("msg")))
        elif out and raw.strip() and not NOT_LOG.match(raw):
            out[-1].extra.append(raw)
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


# --- Crash reports ---------------------------------------------------------------------------------------------

def parse_ips(text: str) -> tuple[dict, dict] | None:
    """An .ips file: one line of JSON (the header), then one JSON document (the report). None if it is not one."""
    first, _, rest = text.partition("\n")
    try:
        header = json.loads(first)
        body = json.loads(rest) if rest.strip() else {}
    except ValueError:
        return None
    return (header if isinstance(header, dict) else {}), (body if isinstance(body, dict) else {})


def frame_line(n: int, frame: dict, images: list) -> str:
    idx = frame.get("imageIndex")
    image = images[idx].get("name", "?") if isinstance(idx, int) and 0 <= idx < len(images) else "?"
    if frame.get("symbol"):
        where = f"{frame['symbol']} + {frame.get('symbolLocation', 0)}"
    else:
        where = f"{image} + {hex(frame.get('imageOffset', 0))}"
    src = f" ({frame['sourceFile']}:{frame.get('sourceLine', '?')})" if frame.get("sourceFile") else ""
    return clip(f"  #{n:<2} {image:<28} {where}{src}")


def summarise_ips(name: str, header: dict, body: dict) -> list[str]:
    exc = body.get("exception") or {}
    kind = exc.get("type", "?")
    signal = f" ({exc['signal']})" if exc.get("signal") else ""
    subtype = f", {exc['subtype']}" if exc.get("subtype") else ""
    codes = f", codes {exc['codes']}" if exc.get("codes") else ""
    out = [clip(f"Crash report {name}: {kind}{signal}{subtype}{codes}, "
                f"{header.get('app_name') or body.get('procName', '?')} {header.get('app_version', '')}".rstrip())]
    if exc.get("message"):
        out.append(clip(f"Exception message: {exc['message']}"))
    term = body.get("termination") or {}
    if term:
        reasons = term.get("reasons") or []
        out.append(clip(f"Termination: {term.get('namespace', '?')} code {term.get('code', '?')}"
                        f"{' ' + term['indicator'] if term.get('indicator') else ''}"
                        f"{' by ' + str(term['byProc']) if term.get('byProc') else ''}"
                        f"{': ' + '; '.join(map(str, reasons)) if reasons else ''}"))
    # Application specific information: the uncaught exception's name and reason (RCTFatal's JavaScript error).
    asi = body.get("asi") or {}
    for lib, values in asi.items():
        for value in values if isinstance(values, list) else [values]:
            for i, line in enumerate(str(value).splitlines()[:10]):
                out.append(clip(("Application specific (" + lib + "): " if i == 0 else "    ") + line.strip()))
    images = body.get("usedImages") or []
    leb = body.get("lastExceptionBacktrace") or []
    if leb:
        out.append("Last exception backtrace:")
        out += [frame_line(i, f, images) for i, f in enumerate(leb[:12])]
    threads = body.get("threads") or []
    fi = body.get("faultingThread")
    crashed = threads[fi] if isinstance(fi, int) and 0 <= fi < len(threads) else next(
        (t for t in threads if t.get("triggered")), None)
    if crashed:
        label = crashed.get("queue") or crashed.get("name") or ""
        out.append(f"Crashed thread {fi if isinstance(fi, int) else '?'}{' (' + label + ')' if label else ''}:")
        out += [frame_line(i, f, images) for i, f in enumerate((crashed.get("frames") or [])[:15])]
    return out


def summarise_text_crash(name: str, text: str) -> list[str]:
    """An older plain-text .crash report: the exception lines and the first frames of the crashed thread."""
    out = [f"Crash report {name}:"]
    keep = re.compile(r"^(Exception Type|Exception Codes|Exception Reason|Termination Reason|Crashed Thread|"
                      r"Application Specific Information|\*\*\* Terminating)")
    lines = text.splitlines()
    out += [clip(x) for x in lines if keep.match(x)][:12]
    m = re.search(r"^Crashed Thread:\s+(\d+)", text, re.M)
    if m:
        start = next((i for i, x in enumerate(lines) if re.match(rf"^Thread {m.group(1)} Crashed", x)), None)
        if start is not None:
            out += [clip("  " + x) for x in lines[start + 1:start + 16] if x.strip()]
    return out


def crash_reports(out_dir: Path, bundle_id: str, exe: str) -> list[list[str]]:
    reports = []
    folder = out_dir / "crash-reports"
    for path in sorted(folder.glob("*")) if folder.is_dir() else []:
        text = read(path)
        parsed = parse_ips(text)
        if parsed:
            header, body = parsed
            ident = header.get("bundleID") or (body.get("bundleInfo") or {}).get("CFBundleIdentifier")
            proc = body.get("procName") or header.get("app_name") or header.get("name")
            if ident != bundle_id and proc != exe:
                continue
            if not (body.get("exception") or body.get("termination") or body.get("threads")):
                continue  # not a crash (a hang or a stackshot): it is in the artifact
            reports.append(summarise_ips(path.name, header, body))
        elif bundle_id in text or exe in text:
            reports.append(summarise_text_crash(path.name, text))
    return reports


# --- Output ----------------------------------------------------------------------------------------------------

def escape(message: str) -> str:
    return message.replace("%", "%25").replace("\r", "%0D").replace("\n", "%0A")


def annotate(kind: str, title: str, lines: list[str]) -> None:
    print(f"::{kind} title={title}::{escape(chr(10).join(lines))}")


def annotate_chunks(title: str, head: list[str], lines: list[str]) -> None:
    annotate("error", title, head)
    chunks = [lines[i:i + LINES_PER_ANNOTATION] for i in range(0, len(lines), LINES_PER_ANNOTATION)]
    for n, chunk in enumerate(chunks, 1):
        annotate("error", f"{title} log {n} of {len(chunks)}", chunk)


def dedupe_entries(entries: list[Entry], more: int = 12) -> list[str]:
    seen, out = set(), []
    for e in entries:
        key = (e.proc, e.msg.strip())
        if key in seen or not e.msg.strip():
            continue
        seen.add(key)
        out += e.lines(more)
    return out


def write_summary(heading: str, intro: str, report: list[str]) -> None:
    path = os.environ.get("GITHUB_STEP_SUMMARY")
    if not path:
        return
    with open(path, "a", encoding="utf-8") as f:
        f.write(f"## {heading}\n\n{intro}\n\n")
        f.write("```\n" + "\n".join(report).replace("```", "'''") + "\n```\n")


# --- Build failure ---------------------------------------------------------------------------------------------

BUILD_ERROR = re.compile(
    r"(\berror: |\bfatal error:|^\*\* (BUILD|ARCHIVE) FAILED|xcodebuild: error|^\[!\] |npm ERR!|"
    r"^CommandError:|^Error: |PhaseScriptExecution .* failed|Command \S+ failed with a nonzero exit code|"
    r"The following build commands failed|Undefined symbols? for architecture|ld: |clang: error)"
)

BUILD_WARNING = re.compile(r"\bwarning: ")


def report_build(log: Path, step: str) -> int:
    text = ANSI.sub("", read(log))
    lines = [x.rstrip() for x in text.splitlines()]
    if not lines:
        annotate("error", BUILD_TITLE, [f"{step} failed and left no log at {log}."])
        return 0
    errors = list(dict.fromkeys(clip(x.strip()) for x in lines
                                if BUILD_ERROR.search(x) and not BUILD_WARNING.search(x)))[:BUILD_ERROR_LINES]
    tail = [clip(x) for x in lines[-BUILD_TAIL_LINES:] if x.strip()]
    head = [f"{step} failed. {len(errors)} error line(s) from {log.name} first, then its last {len(tail)} lines "
            f"({len(lines)} lines in all; the whole log is in the ios-build-logs artifact)."]
    body = errors + (["--- last lines ---"] if errors else []) + tail
    annotate_chunks(BUILD_TITLE, head, body)
    write_summary(f"iOS build: {step} failed", f"Log: `{log.name}`.", head + body)
    return 0


# --- Launch ----------------------------------------------------------------------------------------------------

def report_launch(out_dir: Path) -> int:
    status = read_status(out_dir / "status.env")
    if not status:
        annotate("error", TITLE, [f"The launch step left no results in {out_dir}: the launch script did not run or "
                                  "was stopped. See the 'Launch in the iOS Simulator' step."])
        return 1

    bundle_id = status.get("bundle_id", "")
    exe = status.get("executable", "")
    wait = status.get("wait_seconds", "?")
    device = f"{status.get('device_name') or '?'}, {status.get('device_runtime') or '?'}"
    xcode = status.get("xcode", "?")

    def fail(head: list[str], lines: list[str]) -> int:
        annotate_chunks(TITLE, head, lines)
        (out_dir / "report.txt").write_text("\n".join(head + lines) + "\n", encoding="utf-8")
        write_summary("iOS launch check: failed", summary_intro(status), head + lines)
        return 1

    if status.get("boot") != "ok":
        return fail([f"The iOS Simulator did not boot ({status.get('boot', 'no simulator')}; {device}; {xcode})."],
                    [clip(x) for x in read(out_dir / "boot.txt").strip().splitlines()[-15:]])
    if status.get("install") != "ok":
        return fail([f"simctl install of {status.get('app', 'the app')} failed on {device}:"],
                    [clip(x) for x in read(out_dir / "install.txt").strip().splitlines()[-15:]])

    log_text = read(out_dir / "log-app.txt")
    stream_text = read(out_dir / "log-stream.txt")
    # Both logs hold the same lines when both worked; take the longer, and the other if it has the fatal lines.
    entries = parse_log(log_text)
    streamed = parse_log(stream_text)
    if len(streamed) > len(entries):
        entries = streamed
    app = [e for e in entries if e.proc == exe]
    others = [e for e in entries if e.proc != exe and bundle_id in e.text() and ENDED.search(e.text())]

    reports = crash_reports(out_dir, bundle_id, exe)
    js = [e for e in app if e.is_js and e.level in "EF" and JS_ERROR.search(e.text())]
    fatal = [e for e in app if FATAL.search(e.text()) and e not in js]
    keychain = [e for e in app if KEYCHAIN.search(e.text())]
    alive = status.get("alive") == "yes"
    launched = status.get("launch") == "ok"
    failed = not alive or bool(reports or js or fatal)

    if not failed:
        first = [x for e in app if e.is_js for x in e.lines(2)][:6]
        lines = [f"{bundle_id} is running after {wait} s (pid {status.get('final_pid')}, {device}; {xcode})."]
        lines += ["First JavaScript log lines:", *first] if first else [
            "No JavaScript log lines (a release build logs only warnings and errors)."]
        if keychain:
            lines.append(f"Note: {len(keychain)} keychain error line(s) (-34018): the simulator build is not signed, "
                         "so the Keychain refuses it; see the ios-launch.yml header.")
        annotate("notice", TITLE, lines)
        (out_dir / "report.txt").write_text("\n".join(lines) + "\n", encoding="utf-8")
        write_summary("iOS launch check: passed", summary_intro(status), lines)
        return 0

    pids = status.get("pids", "")
    if not launched:
        what = f"simctl launch {bundle_id} failed"
    elif not alive and not pids:
        what = f"{bundle_id} never showed a process in {wait} s"
    elif not alive:
        what = (f"{bundle_id} died within {wait} s of starting (pids {pids}; "
                f"seen alive for {status.get('seconds_seen_alive', '?')} s)")
    else:
        what = f"{bundle_id} is still running after {wait} s but crashed or logged a fatal error"
    kinds = [k for k, v in (("crash report", reports), ("JavaScript error", js), ("fatal error in the log", fatal)) if v]
    head = [what + (": " + ", ".join(kinds) if kinds else "") + f". {device}; {xcode}."]
    if not launched:
        head += [clip(x) for x in read(out_dir / "launch.txt").strip().splitlines()[-6:]]
    if status.get("js_bundle") == "no":
        head.append("The app has no main.jsbundle: a Release build should embed it.")
    if keychain:
        head.append(f"{len(keychain)} keychain error line(s) (-34018): the simulator build is not signed, so the "
                    "Keychain refuses it; see the ios-launch.yml header.")

    relevant: list[str] = []
    for r in reports[:2]:
        relevant += r
    relevant += dedupe_entries(fatal) + dedupe_entries(js) + dedupe_entries(others[-15:], more=2)
    if not (reports or js or fatal):
        # Nothing labelled as a crash: show the end of what the app logged, errors and faults first.
        loud = [e for e in app if e.level in "EF"]
        relevant += dedupe_entries((loud or app)[-40:], more=4)
        if not app:
            relevant.append(f"The app logged nothing ({len(entries)} log lines matched in all). "
                            "The whole simulator log is log-all.txt in the ios-launch-logs artifact.")
    relevant = list(dict.fromkeys(relevant))[:MAX_LINES]
    return fail(head, relevant)


def summary_intro(status: dict[str, str]) -> str:
    return (f"`{status.get('app', '')}` ({status.get('bundle_id', '')} {status.get('app_version', '')}) on "
            f"{status.get('device_name') or '?'}, {status.get('device_runtime') or '?'}; {status.get('xcode', '')}. "
            "The app's log, the whole simulator log, a screenshot and any crash reports are in the "
            "`ios-launch-logs` artifact.")


def main(argv: list[str]) -> int:
    if len(argv) > 1 and argv[1] == "--build-log":
        if len(argv) < 3:
            print("usage: ios-launch-report.py --build-log LOG [--step NAME]", file=sys.stderr)
            return 2
        step = argv[argv.index("--step") + 1] if "--step" in argv[:-1] else "The build"
        return report_build(Path(argv[2]), step)
    return report_launch(Path(argv[1] if len(argv) > 1 else "launch-out"))


if __name__ == "__main__":
    sys.exit(main(sys.argv))
