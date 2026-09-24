"""The runtime half of the downtime pause, on a workspace WITHOUT lib/downtime.py —
which is every machine in the fleet between the runtime release and the lib one.
No network, no lib/downtime import: this file must pass with the runtime alone.

What it protects:
  1. the stop detector's clock logic — the first start ever (no stamp) is NOT a
     stop (an upgraded fleet must not be paused), short ticks and a clock set
     backwards are nothing, a sleep inside the process and a restart after a
     gap are reported once with the real interval;
  2. a gap that cannot be handed over holds the scheduler, then is let through
     with a record on the machine only (state/audit.jsonl — P3, never an event);
  3. on an old workspace nothing changes: the gap is a delivered no-op, the
     whole-machine resume / resume_wait behave exactly as before, the
     per-strategy forms and downtime_hold fail loudly instead of pretending,
     the report says can_downtime_pause = false and downtime_pause = null;
  4. the marker lib/downtime.runtime_supports() greps for is in command_listener.

Run: cd blave-agent && .venv/bin/python tests/check_downtime_watch.py
"""
import json
import os
import shutil
import sys
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BASE = tempfile.mkdtemp(prefix="downtime-watch-")
WS = os.path.join(BASE, "workspace")
# an OLD workspace: today's lib minus the downtime module
shutil.copytree(os.path.join(ROOT, "lib"), os.path.join(WS, "lib"),
                ignore=shutil.ignore_patterns("__pycache__", "downtime.py"))
os.environ["BLAVE_AGENT_BASE"] = BASE
os.environ["BLAVE_AGENT_WORKSPACE"] = WS
os.environ.pop("BLAVE_AGENT_LOCAL", None)
os.chdir(WS)
sys.path.insert(0, os.path.join(ROOT, "runtime"))

import command_listener as cl  # noqa: E402
import portfolio_reporter  # noqa: E402

# a whole-machine start with no reconciler heartbeat starts one: never a real systemctl/tmux here
cl._restart_reconciler = lambda args: "reconciler restarted"

fails = 0


def check(cond, msg):
    global fails
    print(("ok   " if cond else "FAIL ") + msg)
    fails += 0 if cond else 1


try:
    # ── 1. clock logic ───────────────────────────────────────────────────────
    reports = []
    cl._bound_venue = lambda: True
    real_report = cl._downtime_report
    cl._downtime_report = lambda a, b: reports.append((a, b)) or True
    check(cl._downtime_check(now=1_000_000) is None and not reports,
          "first start ever (no stamp): NOT a stop — an upgraded fleet is not paused")
    check(abs(float(open(cl.DOWNTIME_WATCH).read()) - 1_000_000) < 1e-6, "…and the stamp is written")
    check(cl._downtime_check(now=1_000_005) is None and cl._downtime_check(now=1_000_080) is None
          and not reports, "5 s and 75 s ticks: nothing")
    check(cl._downtime_check(now=1_000_080 + 8 * 3600) == (1_000_080, 1_000_080 + 8 * 3600)
          and len(reports) == 1, "asleep 8 h inside the same process: reported once, with the real interval")
    check(cl._downtime_check(now=1_000_000) is None and len(reports) == 1,
          "clock set backwards: re-base, no report")
    cl._downtime_last = None   # a new process: only the stamp on disk is left
    check(cl._downtime_check(now=1_000_000 + 600) == (1_000_000, 1_000_600) and len(reports) == 2,
          "restart after 10 min (app closed / VM stopped): the stamp on disk carries the gap")
    open(cl.DOWNTIME_WATCH, "w").write("half a fl")
    cl._downtime_last = None
    check(cl._downtime_check(now=2_000_000) is None and len(reports) == 2,
          "unreadable stamp = no history, not a stop")
    cl._bound_venue = lambda: False
    check(cl._downtime_check(now=2_000_000 + 9000) is not None and len(reports) == 2,
          "no venue bound: the gap is noted but nothing is reported")
    cl._bound_venue = lambda: True

    # ── 2. undeliverable ─────────────────────────────────────────────────────
    cl._downtime_report = lambda a, b: False
    t0 = 2_009_000
    tries = cl.DOWNTIME_REPORT_TRIES
    got = [cl._downtime_check(now=t0 + 3600 + i) for i in range(tries - 1)]
    check(all(g and g[0] == t0 for g in got) and cl._downtime_pending(),
          "undeliverable: baseline kept, the same gap retried, the scheduler told NOT to tick meanwhile")
    cl._downtime_check(now=t0 + 3600 + tries)
    rec = [json.loads(l) for l in open(os.path.join(WS, "state", "audit.jsonl"))
           if '"downtime_check_failed"' in l]
    check(not cl._downtime_pending() and len(rec) == 1 and rec[0]["down_from"] == t0
          and not os.path.exists(os.path.join(WS, "state", "events.jsonl")),
          "…then let through: ONE state/audit.jsonl record, no events.jsonl at all (P3), scheduler released")
    check(cl._downtime_check(now=t0 + 3650) is None, "…and re-based")

    # ── 3. an old workspace: nothing changes, nothing pretends ───────────────
    cl._downtime_report = real_report
    check(cl._downtime_report(1_000_000, 1_010_000) is True and not os.path.exists("state/downtime_pause.json"),
          "old workspace: the gap is a delivered no-op (no subprocess, no pause)")
    os.makedirs("manager", exist_ok=True)
    os.makedirs("strategies/btc_1h", exist_ok=True)
    json.dump({"amounts": {"btc_1h": 1000}, "exchanges": {"btc_1h": "binance"}},
              open("manager/portfolio_config.json", "w"))
    json.dump({"position": 1, "symbol": "BTCUSDT"}, open("strategies/btc_1h/state.json", "w"))
    halt = os.path.join("state", "HALT")
    for cmd, args in (("resume", {"strategies": ["btc_1h"]}), ("resume_wait", {"strategies": ["btc_1h"]}),
                      ("downtime_hold", {"strategies": ["btc_1h"]})):
        open(halt, "w").write("{}")
        try:
            cl._in_workspace(cl.dispatch, {"cmd": cmd, "args": args})
            check(False, f"{cmd} with names on an old workspace reported success")
        except RuntimeError as e:
            check("lib/downtime.py" in str(e) and os.path.exists(halt),
                  f"{cmd} with names on an old workspace: refused by name of the missing piece, HALT untouched")
    for bad in ({"strategies": []}, {"strategies": ["../x"]}, {"strategies": "btc_1h"}):
        try:
            cl._in_workspace(cl.dispatch, {"cmd": "resume", "args": bad})
            check(False, f"bad strategies arg accepted: {bad}")
        except ValueError:
            pass
    check(os.path.exists(halt), "malformed `strategies` is refused — never read as whole-machine")
    check(cl._in_workspace(cl.dispatch, {"cmd": "resume_wait", "args": {}})
          == "resumed_wait gated=1; reconciler restarted"
          and json.load(open("state/signal_gate.json")) == {"btc_1h": 1.0} and not os.path.exists(halt),
          "whole-machine resume_wait: the old gate behaviour (baseline now, HALT cleared) + reconciler start")
    open(halt, "w").write("{}")
    check(cl._in_workspace(cl.dispatch, {"cmd": "resume", "args": {}}) == "resumed; reconciler restarted"
          and not os.path.exists(halt) and not os.path.exists("state/signal_gate.json"),
          "whole-machine resume: the old behaviour (gate removed, HALT cleared) + reconciler start")
    report = portfolio_reporter.build_report()
    check(report["can_downtime_pause"] is False and report["downtime_pause"] is None,
          "report: can_downtime_pause = false, downtime_pause = null — the page draws no card")

    # ── 4. the marker ────────────────────────────────────────────────────────
    src = open(os.path.join(ROOT, "runtime", "command_listener.py"), "rb").read()
    check(src.count(b"DOWNTIME_RESUME_PROTOCOL = ") == 1
          and {"resume", "resume_wait", "downtime_hold"} <= set(cl.HANDLERS),
          "DOWNTIME_RESUME_PROTOCOL appears exactly once (the assignment) beside the three handlers")
finally:
    os.chdir(ROOT)
    shutil.rmtree(BASE, ignore_errors=True)

print("\nFAILED" if fails else "\nall ok")
sys.exit(1 if fails else 0)
