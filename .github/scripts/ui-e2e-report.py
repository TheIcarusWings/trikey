#!/usr/bin/env python3
"""Judges what android-ui-e2e.sh recorded of the UI flows (apps/mobile/.maestro/regtest) and reports it.

    python3 .github/scripts/ui-e2e-report.py ui-out

Fails (exit 1) unless every flow ran and passed and the app did not crash. Each flow's results are in ui-out/<flow>/,
as android-walk.sh saves them; this reads them with demo-walk-report.py's functions (Maestro's steps, its errors, what
was on screen, the app's log). What it says goes in annotations, because CI log downloads are blocked for us and
annotations can be read through the checks API: one `::notice` listing the flows that passed; for the flow that failed,
`::error`s with the failing step and Maestro's error, the steps before it, Maestro's detail, the screen's texts, the
app's log, and the end of the guardian's and the rig's logs. GitHub keeps 10 error annotations per step, which this
stays under. It writes report.txt into the directory, and a summary to $GITHUB_STEP_SUMMARY when set.
"""
from __future__ import annotations

import importlib.util
import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
ARTIFACT = "android-ui-e2e"


def load(name: str):
    mod_name = name.replace("-", "_")
    spec = importlib.util.spec_from_file_location(mod_name, HERE / f"{name}.py")
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    sys.modules[mod_name] = module
    spec.loader.exec_module(module)
    return module


walk = load("demo-walk-report")
clip, read, read_status = walk.clip, walk.read, walk.read_status
LINES = walk.LINES_PER_ANNOTATION


def annotate(kind: str, title: str, lines: list[str]) -> None:
    """As demo-walk-report.py's, with the title escaped as a property (a comma or a colon would end it)."""
    prop = title.replace("%", "%25").replace("\r", "%0D").replace("\n", "%0A").replace(":", "%3A").replace(",", "%2C")
    print(f"::{kind} title={prop}::{walk.escape(chr(10).join(lines))}")


def flow_title(flow_dir: Path) -> str:
    """The flow's own `name:` line, else its file name."""
    status = read_status(flow_dir / "status.env")
    text = read(Path(status.get("flow", ""))) if status.get("flow") else ""
    for line in text.splitlines():
        if line.startswith("name:"):
            return f"{flow_dir.name}: {line[5:].strip()}"
        if line.strip() == "---":
            break
    return flow_dir.name


def guardian_tail(out: Path, n: int) -> list[str]:
    try:
        data = json.loads(read(out / f"guardian-{n}-tail.json") or "{}")
    except ValueError:
        return []
    return [clip(x) for x in data.get("lines") or []]


def failed_flow(out: Path, flow_dir: Path, status: dict[str, str]) -> list[str]:
    """Annotations for the flow that failed; returns the report's lines."""
    fstatus = read_status(flow_dir / "status.env")
    title = f"UI flow {flow_dir.name}"
    console = read(flow_dir / "maestro-console.txt")
    steps = walk.steps_from_json(flow_dir) or walk.steps_from_console(console)
    log = walk.android_log(flow_dir, {**fstatus, "platform": "android"})
    failing = [s for s in steps if s.status == "FAILED"]
    culprit = max(failing, key=lambda s: s.depth) if failing else None
    done = [s for s in steps if s.status == "COMPLETED"]
    rc = fstatus.get("maestro_exit", "?")

    if culprit:
        head = [f"{flow_title(flow_dir)}: failed at step {steps.index(culprit) + 1} of {len(steps)}: \"{culprit.desc}\"."]
    elif fstatus.get("walk") != "ran":
        head = [f"{flow_title(flow_dir)}: did not run: {fstatus.get('skip_reason', '?')}."]
    elif fstatus.get("timed_out") == "yes":
        head = [f"{flow_title(flow_dir)}: stopped after {fstatus.get('timeout_seconds', '?')} s."]
    else:
        head = [f"{flow_title(flow_dir)}: failed (Maestro exit {rc}) after {len(done)} steps."]
    error = culprit.error if culprit and culprit.error else ""
    junit = walk.junit_failures(flow_dir)
    if not error and junit:
        error = junit[0]
    if error:
        head.append(f"Maestro: {error}")
    if log.crashed:
        head.append("The app crashed during the flow: " + ", ".join(log.kinds) + " (below).")
    head.append(f"{len(done)} of {len(steps)} steps passed in {fstatus.get('walk_seconds', '?')} s. Screenshots, Maestro's output, "
                f"the logcat and the guardians' logs are in the `{ARTIFACT}` artifact.")

    step_lines: list[str] = []
    if steps:
        stop = steps.index(culprit) if culprit else len(steps) - 1
        shown = steps[max(0, stop - walk.STEPS_BEFORE_FAILURE * 2):stop + 1]
        if stop - walk.STEPS_BEFORE_FAILURE * 2 > 0:
            step_lines.append(f"... {stop - walk.STEPS_BEFORE_FAILURE * 2} earlier steps passed")
        step_lines += [clip(f"{walk.mark(s.status)} {'  ' * s.depth}{s.desc}" + (f"  -- {s.error}" if s.error else "")) for s in shown]
    detail = list(dict.fromkeys(junit + walk.maestro_log_errors(flow_dir) + walk.console_errors(console)))[:LINES]
    # The app's (and any dialog's) texts first: the status bar's many nodes come before them in some windows' order.
    raw = walk.on_screen(flow_dir)
    bar = [x for x in raw if 'com.android.systemui:id/' in x]
    screen = [x for x in raw if x not in bar] + bar

    annotate("error", title, head)
    if step_lines:
        annotate("error", f"{title} steps", step_lines[-LINES:])
    if detail:
        annotate("error", f"{title} Maestro detail", detail)
    if screen:
        annotate("error", f"{title} on screen", ["On screen when it failed (maestro hierarchy):", *screen[:LINES - 1]])
    if flow_dir.name == "00-fingerprint":
        # Android's own screens: what the device setup said, instead of Trikey's logs.
        device = [f"locksettings: {read(out / 'locksettings.txt').strip() or '?'}",
                  f"enrolment screen: {read(out / 'enroll-start.txt').strip() or '?'}",
                  *[clip(x) for x in read(out / "dumpsys-fingerprint.txt").splitlines() if x.strip()][:LINES - 2]]
        annotate("error", f"{title} device", device)
        for chunk in walk.chunks(log.lines)[:1]:
            annotate("error", f"{title} Settings log", chunk)
        return head + ["", "Steps:", *step_lines, "", "Maestro:", *detail, "", "On screen:", *screen, "", "Device:", *device]
    for chunk in walk.chunks(log.lines)[:1]:
        annotate("error", f"{title} app log", chunk)
    # Guardian 2 exists once Replace guardian ran (it guards the wallet from then on): both, the newest lines of each.
    g2 = guardian_tail(out, 2)
    guardian = guardian_tail(out, 1)[-(LINES // 2 if g2 else LINES):]
    if guardian:
        annotate("error", f"{title} guardian 1 log", guardian)
    if g2:
        annotate("error", f"{title} guardian 2 log", g2[-LINES:])
    rig = [clip(x) for x in read(out / "rig.log").splitlines() if x.strip()][-LINES:]
    if rig:
        annotate("error", f"{title} rig log", rig)
    return head + ["", "Steps:", *step_lines, "", "Maestro:", *detail, "", "On screen:", *screen, "", "App log:", *log.lines,
                   "", "Guardian 1:", *guardian, "", "Guardian 2:", *g2, "", "Rig:", *rig]


def main(argv: list[str]) -> int:
    out = Path(argv[1] if len(argv) > 1 else "ui-out")
    status = read_status(out / "status.env")
    title = "UI flows (Simulator on regtest)"
    if not status:
        annotate("error", title, [f"No results in {out}: android-ui-e2e.sh did not run or was stopped (see the emulator step)."])
        return 1
    if status.get("setup"):
        lines = [f"The UI flows did not start: {status['setup']}."]
        rig = [clip(x) for x in read(out / "rig.log").splitlines() if x.strip()][-LINES:]
        annotate("error", title, lines)
        if rig:
            annotate("error", f"{title} rig log", rig)
        return 1

    names = ["00-fingerprint"] + [Path(f).stem for f in status.get("flows", "").split()]
    results = {n: status.get(f"flow_{n}") for n in names}
    passed = [n for n in names if results[n] == "0"]
    failed = next((n for n in names if results[n] not in (None, "0")), None)
    not_run = [n for n in names if results[n] is None]
    crashed = []
    for n in passed:
        d = out / n
        if n != "00-fingerprint" and walk.android_log(d, {**read_status(d / "status.env"), "platform": "android"}).crashed:
            crashed.append(n)

    timing = lambda n: read_status(out / n / "status.env").get("walk_seconds", "?")  # noqa: E731
    summary = [f"Passed: {', '.join(f'{n} ({timing(n)} s)' for n in passed) or 'none'}."]
    if failed:
        summary.append(f"Failed: {failed}.")
    if not_run:
        summary.append(f"Not run (they need the ones before them): {', '.join(not_run)}.")
    if crashed:
        summary.append(f"The app crashed during: {', '.join(crashed)} (see the logcat in the `{ARTIFACT}` artifact).")

    report = list(summary)
    if failed:
        report += [""] + failed_flow(out, out / failed, status)
    ok = not failed and not not_run and not crashed and len(names) > 1
    if ok:
        annotate("notice", title, [f"Every UI flow passed on the Android emulator (API {status.get('device_sdk', '?')}):",
                                   *[flow_title(out / n) for n in passed]])
    else:
        annotate("error", f"{title}: summary", summary)
    (out / "report.txt").write_text("\n".join(report) + "\n", encoding="utf-8")
    walk.write_summary(f"{title}: {'passed' if ok else 'failed'}", f"Results in the `{ARTIFACT}` artifact.", report)
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv))
