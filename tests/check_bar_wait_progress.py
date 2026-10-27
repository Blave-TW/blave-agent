"""Data that moves but is still short of the expected bar is a new lag, not a stall
(manager/wait_for_bar.py, the not-ready path of _tick).

A TWSE 1m strategy on the fixed :05 schedule sees M-2 at :05 every minute; M-1 lands by :20, the
runtime's same-minute retry. A pending_since left from the previous session's close made every
such tick re-alert bar_stale and set stall_alert_at, which throttled the strategy to the quarter
marks and denied it the retry (runtime command_listener._not_ready_this_minute): no signal all
session. Asserted here, the real _tick on a fixed clock, freshness probe stubbed:

  P  data moved, still one bar short, pending_since two days old and stall_alert_at set: no
     alert, stall_alert_at None, pending_since restarted at this poll; the next
     minute is polled (not throttled) and the bar runs when it lands.
  S  data not moving: alert once 15 minutes on, then throttled to the quarter marks, no repeat
     inside 24h, repeated after it.
  B  a Type C straggler stepping back is not progress: pending_since is not restarted.
  F  an unpublished align_feed row after the bars moved: lateness still counted from its due time.

Run: cd blave-agent && .venv/bin/python tests/check_bar_wait_progress.py
     BAR_WAIT_UNDER_TEST=<path to another wait_for_bar.py> runs the same checks against that copy.
"""
import importlib.util
import os
import shutil
import sys
import tempfile
import time
from datetime import datetime, timedelta

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BASE = tempfile.mkdtemp(prefix="bar-wait-progress-")
WS = os.path.join(BASE, "workspace")
shutil.copytree(os.path.join(ROOT, "lib"), os.path.join(WS, "lib"),
                ignore=shutil.ignore_patterns("__pycache__"))
os.makedirs(os.path.join(WS, "manager"))
shutil.copy(os.environ.get("BAR_WAIT_UNDER_TEST") or os.path.join(ROOT, "manager", "wait_for_bar.py"),
            os.path.join(WS, "manager", "wait_for_bar.py"))
shutil.copy(os.path.join(ROOT, "manager", "alert_failure.py"), os.path.join(WS, "manager"))
os.makedirs(os.path.join(WS, "strategies", "tw1m"))
open(os.path.join(WS, "strategies", "tw1m", "strategy.py"), "w").write(
    'INTERVAL = "1min"\nSYMBOL = "2330"\ndef fetch_data(headers=None):\n    raise AssertionError\n')

fails = 0


def check(cond, msg):
    global fails
    print(("ok   " if cond else "FAIL ") + msg)
    fails += 0 if cond else 1


cwd = os.getcwd()
sys.path.insert(0, WS)
os.chdir(WS)
try:
    spec = importlib.util.spec_from_file_location("wfb_progress", os.path.join(WS, "manager", "wait_for_bar.py"))
    wfb = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(wfb)

    U = lambda h, m, s=0: datetime(2026, 10, 27, h, m, s)   # naive UTC, a Tuesday; Taipei = +8

    class _Clock(datetime):
        at = U(1, 30)

        @classmethod
        def now(cls, tz=None):
            return cls.at.replace(tzinfo=tz) if tz else cls.at
    wfb.datetime = _Clock

    runs, alerts, probed = [], [], []
    verdict = {"v": None}

    def probe(mod, expected):
        probed.append(expected)
        if isinstance(verdict["v"], Exception):
            raise verdict["v"]
        return verdict["v"]
    wfb._check_freshness = probe
    wfb._run_strategy_protected = lambda n: runs.append(n) or True
    wfb._alert_stale = lambda *a, computed=False: alerts.append(a)

    def tick(at, seen, ready=False, latest=None, **st):
        _Clock.at = at
        if st:
            wfb._save_state("tw1m", {**wfb._default_state(), **st})
        if isinstance(seen, Exception):
            verdict["v"] = seen
        elif latest:   # Type C: seen is the straggler's bar
            verdict["v"] = (seen, ready, min(latest, key=latest.get), latest)
        else:
            verdict["v"] = (seen, ready, None, {"": seen})
        del probed[:], alerts[:]
        wfb._tick("tw1m")
        return wfb._load_state("tw1m")

    # P — 09:30:05 Taipei: expected 01:29, the probe sees 01:28, last tick saw 01:27
    st = tick(U(1, 30, 5), U(1, 28), last_seen_bar="2026-10-27T01:27:00",
              pending_since="2026-10-25T12:25:00", stall_alert_at=time.time() - 600)
    check(probed and not alerts, f"data moved, one bar short, old pending_since: no bar_stale (alerts={alerts})")
    check(st["stall_alert_at"] is None, f"…stall_alert_at None, the runtime's :20 retry may run it "
                                        f"(got {st['stall_alert_at']})")
    check(st["pending_since"] == "2026-10-27T01:30:05",
          f"…pending_since restarted at this poll (got {st['pending_since']})")
    st = tick(U(1, 31, 5), U(1, 29))
    check(probed and not alerts and st["stall_alert_at"] is None,
          "next minute, again one bar short: polled, not throttled, no alert")
    st = tick(U(1, 31, 20), U(1, 30), ready=True)
    check(runs == ["tw1m"] and st["last_processed_bar"] == "2026-10-27T01:30:00" and st["pending_since"] is None,
          f"…the :20 retry finds the bar: it runs (runs={runs}, last_processed_bar={st['last_processed_bar']})")

    # S — a real stall: 01:28 never moves
    st = tick(U(1, 40, 5), U(1, 28), last_seen_bar="2026-10-27T01:28:00",
              pending_since="2026-10-27T01:30:00")
    check(not alerts and st["stall_alert_at"] is None, "stuck 10 minutes: no alert yet")
    st = tick(U(1, 45, 5), U(1, 28))
    check(len(alerts) == 1 and st["stall_alert_at"] is not None, "stuck 15 minutes: alerted once")
    check(st["pending_since"] == "2026-10-27T01:30:00", "…pending_since kept while the data does not move")
    tick(U(1, 46, 5), U(1, 28))
    check(not probed, "…then throttled off the quarter marks")
    tick(U(2, 0, 5), U(1, 28))
    check(probed and not alerts, "…polled on the mark, no repeat inside 24h")
    st = tick(U(2, 15, 5), U(1, 28), last_seen_bar="2026-10-27T01:28:00",
              pending_since="2026-10-27T01:30:00", stall_alert_at=time.time() - 25 * 3600)
    check(len(alerts) == 1, "…repeated after 24h")
    st = tick(U(2, 30, 5), U(2, 28))
    check(not alerts and st["stall_alert_at"] is None and st["pending_since"] == "2026-10-27T02:30:05",
          "the feed comes back one bar short: a new lag, no alert")

    # B — Type C, the straggler steps back (a member that was not waited for is again): no restart
    universe = {"AAA": U(2, 34), "BBB": U(2, 29)}
    st = tick(U(2, 36, 5), U(2, 29), latest=universe, last_seen_bar="2026-10-27T02:30:00",
              pending_since="2026-10-27T02:31:05")
    check(st["pending_since"] == "2026-10-27T02:31:05" and st["last_seen_bar"] == "2026-10-27T02:29:00",
          f"Type C straggler steps back: pending_since kept (got {st['pending_since']})")
    tick(U(2, 46, 5), U(2, 29), latest=universe)
    check(len(alerts) == 1, "…and the wait is still timed from it: alerted 15 minutes on")

    # F — bars moved, an align_feed row due 30 minutes ago is not published
    class _Unpublished(Exception):
        source, due_at, last_bar = "feed", U(2, 10), U(2, 38)
    wfb._is_feed_wait = lambda e: isinstance(e, _Unpublished)
    del runs[:]
    st = tick(U(2, 40, 5), _Unpublished(), last_seen_bar="2026-10-27T02:30:00",
              pending_since="2026-10-27T02:00:00")
    check(st["pending_since"] == "2026-10-27T02:10:00" and len(alerts) == 1,
          f"align_feed row late: timed from its due time, alerted (pending_since={st['pending_since']}, "
          f"alerts={len(alerts)})")
    check(not runs, "nothing ran on an unpublished row")
finally:
    os.chdir(cwd)
    shutil.rmtree(BASE, ignore_errors=True)

print("\ncheck_bar_wait_progress: " + ("PASS" if not fails else f"FAILED ({fails})"))
sys.exit(1 if fails else 0)
