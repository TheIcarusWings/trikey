#!/usr/bin/env python3
"""Judges what android-walk.sh or ios-walk.sh recorded of the demo walk (apps/mobile/.maestro/demo-walk.yaml) and
reports it.

    python3 .github/scripts/demo-walk-report.py walk-out [launch-out]

Fails (exit 1) when Maestro failed a step or was stopped, or when the app crashed during the walk even though the steps
passed (Android: a FATAL EXCEPTION or a native crash in the log; iOS: a crash report, or a fatal error such as
"Unhandled JS Exception" in the log). The walk is skipped, and this exits 0 with a notice, when the launch check did
not see the app running: the launch report has already failed the job and says why.

What it says goes in `::error` annotations, most telling first, because CI log downloads are blocked for us and
annotations can still be read through the checks API (see e2e.yml): the failing step and Maestro's error; the steps
before it; Maestro's own detail (the JUnit failure, the error lines of maestro.log); then the app's log lines of the
walk, found the same way as the launch reports find them (android-launch-report.py and ios-launch-report.py, which
this imports). GitHub keeps only 10 error annotations per step, so the lines go in a few annotations of up to 20 lines
each. When the walk passes it prints one `::notice`, and a `::warning` if the app logged JavaScript errors on the way
(a screen that broke would have failed a step). It writes report.txt into the directory, and a summary to
$GITHUB_STEP_SUMMARY when set.
"""
from __future__ import annotations

import importlib.util
import json
import os
import re
import sys
import xml.etree.ElementTree as ET
from dataclasses import dataclass
from pathlib import Path

HERE = Path(__file__).resolve().parent
LINES_PER_ANNOTATION = 20
MAX_LOG_LINES = 60
MAX_LINE_CHARS = 400
STEPS_BEFORE_FAILURE = 8
ARTIFACT = {"android": "android-demo-walk", "ios": "ios-demo-walk"}
PLATFORM_NAME = {"android": "Android", "ios": "iOS"}

# Maestro's plain-text output (`--no-ansi`): "    Tap on id: home-balance... COMPLETED"
STEP_LINE = re.compile(r"^(?P<indent>\s*)(?P<desc>.+?)\.\.\. (?P<status>COMPLETED|FAILED|SKIPPED|WARNED|RUNNING|PENDING)\s*$")
ERROR_HINT = re.compile(
    r"(Element not found|Assertion is false|is not visible|not found|Failed|Error|Exception|Timed out|timeout|"
    r"Unable to|Could not|No devices|not installed|Unknown|Invalid)", re.I)
ANSI = re.compile(r"\x1b\[[0-9;]*[A-Za-z]")


def load(name: str):
    """Imports a sibling script (android-launch-report.py) as a module, for its log parsing."""
    mod_name = name.replace("-", "_")
    spec = importlib.util.spec_from_file_location(mod_name, HERE / f"{name}.py")
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    sys.modules[mod_name] = module  # dataclasses look their module up here
    spec.loader.exec_module(module)
    return module


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


def clip(text: str) -> str:
    text = ANSI.sub("", str(text)).replace("\r", "").rstrip()
    return text if len(text) <= MAX_LINE_CHARS else text[: MAX_LINE_CHARS - 1] + "…"


def escape(message: str) -> str:
    return message.replace("%", "%25").replace("\r", "%0D").replace("\n", "%0A")


def annotate(kind: str, title: str, lines: list[str]) -> None:
    print(f"::{kind} title={title}::{escape(chr(10).join(lines))}")


def chunks(lines: list[str]) -> list[list[str]]:
    return [lines[i:i + LINES_PER_ANNOTATION] for i in range(0, len(lines), LINES_PER_ANNOTATION)]


# --- Maestro's results -------------------------------------------------------------------------------------------

@dataclass
class Step:
    desc: str
    status: str
    error: str = ""
    depth: int = 0


def describe(command: object) -> str:
    """A command from commands.json ({"tapOnElement": {"selector": {...}, "label": ...}}) in a few words."""
    if not isinstance(command, dict):
        return clip(str(command))[:200]
    for kind, body in command.items():
        if body is None:
            continue
        if isinstance(body, dict):
            if body.get("label"):
                return clip(body["label"])
            if body.get("description"):
                return clip(body["description"])
            detail = {k: v for k, v in body.items() if v not in (None, False, [], {}) and k not in ("optional",)}
            return clip(f"{kind} {json.dumps(detail, separators=(',', ':'))}")[:200]
        return clip(f"{kind} {body}")[:200]
    return "?"


def error_text(error: object) -> str:
    if isinstance(error, dict):
        for key in ("message", "localizedMessage", "detailMessage"):
            if error.get(key):
                return clip(error[key])
        return clip(json.dumps(error))[:MAX_LINE_CHARS]
    return clip(error) if error else ""


def steps_from_json(walk: Path) -> list[Step]:
    """Maestro's commands.json (--test-output-dir) or commands-*.json (older --debug-output): every command it ran."""
    steps: list[Step] = []
    for path in sorted(walk.glob("maestro/**/commands*.json")):
        try:
            data = json.loads(read(path))
        except ValueError:
            continue
        if isinstance(data, dict):
            data = data.get("commands") or []
        for item in data if isinstance(data, list) else []:
            if not isinstance(item, dict):
                continue
            meta = item.get("metadata") or {}
            command = meta.get("evaluatedCommand") or item.get("command") or meta.get("command")
            steps.append(Step(desc=describe(command), status=str(meta.get("status") or "?"),
                              error=error_text(meta.get("error")), depth=int(meta.get("depth") or 0)))
        if steps:
            break
    return steps


def steps_from_console(console: str) -> list[Step]:
    """The step lines of Maestro's console output, each with its last status."""
    order: list[tuple[int, str]] = []
    last: dict[tuple[int, str], str] = {}
    for raw in console.splitlines():
        m = STEP_LINE.match(ANSI.sub("", raw).rstrip())
        if not m:
            continue
        key = (len(m.group("indent")), m.group("desc").strip())
        if key not in last:
            order.append(key)
        last[key] = m.group("status")
    return [Step(desc=clip(desc), status=last[(indent, desc)], depth=indent // 2) for indent, desc in order]


def junit_failures(walk: Path) -> list[str]:
    out: list[str] = []
    for path in walk.glob("maestro/**/*.xml"):
        try:
            root = ET.parse(path).getroot()
        except (ET.ParseError, OSError):
            continue
        for case in root.iter("testcase"):
            for fail in list(case.iter("failure")) + list(case.iter("error")):
                text = (fail.get("message") or "") + ("\n" + fail.text if fail.text else "")
                out += [clip(x) for x in text.strip().splitlines() if x.strip()][:10]
    return list(dict.fromkeys(out))


def maestro_log_errors(walk: Path) -> list[str]:
    out: list[str] = []
    for path in walk.glob("maestro/**/maestro.log"):
        lines = read(path).splitlines()
        out += [clip(x) for x in lines if re.search(r"\b(ERROR|FATAL)\b|Exception:|Caused by:", x)]
    return list(dict.fromkeys(out))[-15:]


def console_errors(console: str) -> list[str]:
    lines = [clip(x) for x in console.splitlines() if x.strip()]
    return [x for x in lines if not STEP_LINE.match(x) and ERROR_HINT.search(x)][-12:]


def mark(status: str) -> str:
    return {"COMPLETED": "ok  ", "FAILED": "FAIL", "SKIPPED": "skip", "WARNED": "warn"}.get(status, status[:4].lower().ljust(4))


# --- The app's log during the walk -------------------------------------------------------------------------------

@dataclass
class AppLog:
    crashed: bool
    kinds: list[str]
    lines: list[str]  # crash lines first, then context, for a failure
    js: list[str]  # JavaScript error lines (a warning when the walk passed)


def android_log(walk: Path, status: dict[str, str]) -> AppLog:
    mod = load("android-launch-report")
    app_id = status.get("app_id", "")
    all_text = read(walk / "logcat-all.txt")
    entries = mod.parse(all_text)
    crash_entries = mod.parse(read(walk / "logcat-crash.txt"))
    if crash_entries and not any(e.raw in all_text for e in crash_entries[:3]):
        entries = entries + crash_entries
    exit_info = read(walk / "exit-info.txt")
    pids = mod.app_pids(status, entries, exit_info, app_id)
    app_lines = [e for e in entries
                 if e.pid in pids or e.tag in mod.CRASH_TAGS or (e.tag == "ActivityManager" and app_id in e.msg)]
    (walk / "logcat-app.txt").write_text("\n".join(e.raw for e in app_lines) + "\n", encoding="utf-8")
    fatal = mod.fatal_blocks(entries)
    native = mod.native_crash(entries, pids)
    js = mod.js_errors(entries, pids)
    am = [e for e in entries if e.tag == "ActivityManager" and app_id in e.msg
          and re.search(r"has died|crash|ANR", e.msg)]
    kinds = [k for k, v in (("Java/Kotlin FATAL EXCEPTION", fatal), ("native crash", native)) if v]
    lines = mod.dedupe(fatal) + mod.dedupe(native) + mod.dedupe(js) + mod.dedupe(am)
    if fatal or native:
        lines += mod.exit_reasons(exit_info, pids)
    if not (fatal or native or js):
        own = [e for e in app_lines if e.pid in pids]
        loud = [e for e in own if e.level in "WEF"]
        lines += mod.dedupe((loud or own)[-30:])
        if not own:
            lines.append(f"The app logged nothing during the walk ({len(entries)} logcat lines in all; logcat-all.txt in the artifact).")
    return AppLog(crashed=bool(fatal or native), kinds=kinds, lines=list(dict.fromkeys(lines))[:MAX_LOG_LINES],
                  js=mod.dedupe(js)[:LINES_PER_ANNOTATION])


def ios_log(walk: Path, status: dict[str, str]) -> AppLog:
    mod = load("ios-launch-report")
    bundle_id, exe = status.get("bundle_id", ""), status.get("executable", "")
    entries = mod.parse_log(read(walk / "log-app.txt"))
    streamed = mod.parse_log(read(walk / "log-stream.txt"))
    if len(streamed) > len(entries):
        entries = streamed
    app = [e for e in entries if e.proc == exe]
    others = [e for e in entries if e.proc != exe and bundle_id in e.text() and mod.ENDED.search(e.text())]
    reports = mod.crash_reports(walk, bundle_id, exe)
    js = [e for e in app if e.is_js and e.level in "EF" and mod.JS_ERROR.search(e.text())]
    fatal = [e for e in app if mod.FATAL.search(e.text()) and e not in js]
    kinds = [k for k, v in (("crash report", reports), ("fatal error in the log", fatal)) if v]
    lines: list[str] = []
    for r in reports[:2]:
        lines += r
    lines += mod.dedupe_entries(fatal) + mod.dedupe_entries(js) + mod.dedupe_entries(others[-10:], more=2)
    if not (reports or fatal or js):
        loud = [e for e in app if e.level in "EF"]
        lines += mod.dedupe_entries((loud or app)[-30:], more=4)
        if not app:
            lines.append(f"The app logged nothing during the walk ({len(entries)} log lines matched; log-app.txt in the artifact).")
    return AppLog(crashed=bool(reports or fatal), kinds=kinds, lines=list(dict.fromkeys(lines))[:MAX_LOG_LINES],
                  js=mod.dedupe_entries(js, more=4)[:LINES_PER_ANNOTATION])


# --- Report ------------------------------------------------------------------------------------------------------

def device_text(platform: str, status: dict[str, str]) -> str:
    if platform == "android":
        return f"the Android emulator (API {status.get('device_sdk') or '?'}, {status.get('device_abi') or '?'})"
    return f"{status.get('device_name') or '?'} ({status.get('device_runtime') or '?'}, {status.get('xcode') or '?'})"


def write_summary(heading: str, intro: str, report: list[str]) -> None:
    path = os.environ.get("GITHUB_STEP_SUMMARY")
    if not path:
        return
    with open(path, "a", encoding="utf-8") as f:
        f.write(f"## {heading}\n\n{intro}\n\n")
        f.write("```\n" + "\n".join(report).replace("```", "'''") + "\n```\n")


def on_screen(walk: Path) -> list[str]:
    """The texts, ids and accessibility labels on screen when the walk failed (`maestro hierarchy`), in screen order."""
    raw = read(walk / "hierarchy.json")
    if not raw.strip():
        return []
    try:
        tree = json.loads(raw[raw.find("{"):])
    except ValueError:
        return []
    out: list[str] = []

    def visit(node: object) -> None:
        if not isinstance(node, dict):
            return
        attrs = node.get("attributes") or {}
        if isinstance(attrs, dict):
            parts = []
            for key, label in (("resource-id", "id"), ("text", "text"), ("accessibilityText", "label"), ("hintText", "hint")):
                value = str(attrs.get(key) or "").strip()
                if value and f'"{value}"' not in " ".join(parts):
                    parts.append(f'{label} "{value}"')
            if parts:
                out.append(clip(" · ".join(parts)))
        for child in node.get("children") or []:
            visit(child)

    visit(tree)
    return list(dict.fromkeys(out))


def main(argv: list[str]) -> int:
    walk = Path(argv[1] if len(argv) > 1 else "walk-out")
    launch = Path(argv[2]) if len(argv) > 2 else None
    status = read_status(walk / "status.env")
    platform = status.get("platform", "")
    title = f"Demo walk ({PLATFORM_NAME.get(platform, platform or '?')})"

    if not status:
        launch_status = read_status(launch / "status.env") if launch else {}
        if launch is not None and launch_status.get("alive") != "yes":
            annotate("notice", "Demo walk", ["The demo walk did not run: the launch check did not see the app running (see its report)."])
            return 0
        annotate("error", "Demo walk", [f"The walk left no results in {walk}: the walk script did not run or was stopped. "
                                        "See the step that runs it (android-walk.sh or ios-walk.sh)."])
        return 1

    walk_state = status.get("walk", "")
    if walk_state == "skipped":
        annotate("notice", title, [f"The demo walk did not run: {status.get('skip_reason', 'the launch check failed')}."])
        return 0
    if walk_state != "ran":
        lines = [f"The demo walk did not run: {status.get('skip_reason', 'unknown reason')}."]
        annotate("error", title, lines)
        write_summary(f"{title}: not run", "", lines)
        return 1

    device = device_text(platform, status)
    artifact = ARTIFACT.get(platform, "the walk's artifact")
    console = read(walk / "maestro-console.txt")
    steps = steps_from_json(walk) or steps_from_console(console)
    log = android_log(walk, status) if platform == "android" else ios_log(walk, status)
    rc = status.get("maestro_exit", "?")
    timed_out = status.get("timed_out") == "yes"
    seconds = status.get("walk_seconds", "?")
    maestro_failed = rc != "0"
    failed = maestro_failed or log.crashed

    done = [s for s in steps if s.status == "COMPLETED"]
    failing = [s for s in steps if s.status == "FAILED"]
    # The innermost failed command says what went wrong (its runFlow fails with it).
    culprit = max(failing, key=lambda s: s.depth) if failing else None

    if not failed:
        lines = [f"The demo walk passed on {device}: {len(done)} steps in {seconds} s "
                 f"(Welcome to Demo mode, Home, Send to an amount, Receive, Settings, Activity; Maestro {status.get('maestro_version', '?')})."]
        annotate("notice", title, lines)
        if status.get("retried_after_driver_lost") == "yes":
            annotate("warning", f"{title} retried",
                     ["Maestro's driver lost its connection to the simulator during the first walk, so the walk ran again and "
                      "passed. The first try's output is in `maestro-first-try/` in the artifact."])
        if log.js:
            annotate("warning", f"{title} JavaScript errors",
                     ["The walk passed, but the app logged JavaScript errors on the way:", *log.js[:LINES_PER_ANNOTATION - 1]])
        report = lines + (["JavaScript errors:", *log.js] if log.js else [])
        (walk / "report.txt").write_text("\n".join(report) + "\n", encoding="utf-8")
        write_summary(f"{title}: passed", f"On {device}. Maestro's output and the app's log are in the `{artifact}` artifact.", report)
        return 0

    # Failed. The head: which step, and why.
    if maestro_failed:
        if culprit:
            n = steps.index(culprit) + 1
            what = f"The demo walk failed on {device} at step {n} of {len(steps)}: \"{culprit.desc}\"."
        elif timed_out:
            what = f"The demo walk was stopped after {status.get('timeout_seconds', '?')} s on {device}."
        elif not steps:
            what = f"Maestro did not run the flow on {device} (exit {rc})."
        else:
            what = f"The demo walk failed on {device} (Maestro exit {rc}) after {len(done)} steps."
        head = [what]
        if timed_out and culprit:
            head.append(f"Maestro was stopped after {status.get('timeout_seconds', '?')} s.")
        error = culprit.error if culprit and culprit.error else ""
        junit = junit_failures(walk)
        if not error and junit:
            error = junit[0]
        if error:
            head.append(f"Maestro: {error}")
        if log.crashed:
            head.append("The app crashed during the walk: " + ", ".join(log.kinds) + " (below).")
    else:
        head = [f"Every step of the demo walk passed on {device}, but the app crashed during it: {', '.join(log.kinds)}."]
    head.append(f"{len(done)} of {len(steps)} steps passed, in {seconds} s. Screenshots (the failing step's and the last "
                f"screen), Maestro's JUnit report, commands.json and maestro.log, and the app's whole log are in the "
                f"`{artifact}` artifact.")

    # The steps up to the failure, with their outcome.
    step_lines: list[str] = []
    if steps:
        stop = steps.index(culprit) if culprit else len(steps) - 1
        shown = steps[max(0, stop - STEPS_BEFORE_FAILURE):stop + 1]
        if stop - STEPS_BEFORE_FAILURE > 0:
            step_lines.append(f"... {stop - STEPS_BEFORE_FAILURE} earlier steps passed")
        step_lines += [clip(f"{mark(s.status)} {'  ' * s.depth}{s.desc}" + (f"  -- {s.error}" if s.error else "")) for s in shown]
        rest = steps[stop + 1:]
        if rest:
            step_lines.append(clip(f"... then {len(rest)} more step(s), not run: " + "; ".join(s.desc for s in rest[:4])))

    # Maestro's own detail: the JUnit failure, maestro.log errors, the console's error lines.
    detail = junit_failures(walk) + maestro_log_errors(walk) + console_errors(console)
    if maestro_failed and not steps:
        detail += [clip(x) for x in console.splitlines() if x.strip()][-15:]
    detail = list(dict.fromkeys(detail))[:LINES_PER_ANNOTATION]

    annotate("error", title, head)
    if step_lines:
        annotate("error", f"{title} steps", step_lines[:LINES_PER_ANNOTATION])
    if detail:
        annotate("error", f"{title} Maestro detail", detail)
    screen = on_screen(walk)
    if screen:
        annotate("error", f"{title} on screen", ["What was on screen when it failed (maestro hierarchy):", *screen[:LINES_PER_ANNOTATION - 1]])
    log_chunks = chunks(log.lines)
    for n, chunk in enumerate(log_chunks, 1):
        annotate("error", f"{title} app log {n} of {len(log_chunks)}", chunk)

    report = head + ["", "Steps:", *step_lines, "", "Maestro:", *detail, "", "App log:", *log.lines]
    (walk / "report.txt").write_text("\n".join(report) + "\n", encoding="utf-8")
    write_summary(f"{title}: failed", f"On {device}. Maestro's output and the app's log are in the `{artifact}` artifact.", report)
    return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv))
