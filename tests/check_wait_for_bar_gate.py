"""Minimal check: manager/wait_for_bar.py's gate path (0.1.22 ②, design §1–§4, §6, §9). The
strategy child is a fake that follows a plan file (write .started / .probe.json, sleep, exit
with a code, write state.json) so every row of the design's exit-code table is driven:

  A. _wait_child: RUN_TIMEOUT_SECONDS counts from .probe.json — a child slow BEFORE the probe
     is not killed, one slow AFTER it is (rc -1, alert, backoff)
  B. the table: rc 0 + ready → processed (last_processed_bar = expected, data_bar = observed,
     heartbeat, ticks.jsonl line with the state); 75 + not ready → pending_since, no heartbeat,
     no failure; rc≠0 without probe → fetch_error alert + backoff; rc≠0 with probe → crash
     alert + strategy.log + backoff; rc 0 without .started → gate_unsupported, bar NOT
     processed, no heartbeat; probe without .started → wrapper error; feed_wait → pending_since
     from due_at; rc≠0 without .started → crash alert
  C. _choose_path: no flag in lib/runner.py → probe; strategy without lib.runner/run( → probe;
     first time → verify; .started seen → gate; strategy.py / lib/runner.py changed → verify
     again; unsupported key → probe until the key changes
  D. _tick end to end: the verify tick probes in-process first and then starts the gate child
     (last_path gate); a later tick goes straight to the child; the probe-path tick of an
     unsupported strategy runs _run_strategy_protected as before
  E. fast path: 1m crypto slow-tick (data_bar = next slot) hits; 1h / 1d crypto, TXF 1d
     (16:00 label) and TXF 60m (whole-hour label) do not; a future-dated data_bar never hits
  F. the bar_wait state keys written anywhere in the file == the documented set == _default_state
  G. _spawn_gate_child: stdin=DEVNULL, env carries BLAVE_EXPECTED_BAR, CREATE_NO_WINDOW on nt;
     lock line 2 = child pid; handshake leftovers are cleared before the run
  H. TAIFEX session table (TXF/MXF/TMF strategies on fetch_twfutures_ohlcv): judged on the bar's
     [open, close) — 60m 08:00 / 30m 08:30 / 60m 13:00 labels are open, 60m 14:00 and 05:00 are
     not; settlement day (third Wednesday) closes 13:30; closed slots are not polled and reset
     pending_since AND stall_alert_at; the 13:45 close → 15:00 open gap raises no bar_stale
     and the 15:00 / 15:05 bars are polled every minute (no stall throttle); the daily slot
     is not polled before 13:45 TWN and not late before 15:00 TWN; weekends have no slot;
     a crypto strategy is untouched

Run: cd blave-agent && .venv/bin/python tests/check_wait_for_bar_gate.py
"""
import importlib.util
import json
import os
import re
import subprocess
import sys
import tempfile
import time
import types
from datetime import datetime, timedelta

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WFB = os.path.join(ROOT, "manager", "wait_for_bar.py")

spec = importlib.util.spec_from_file_location("wfb", WFB)
wfb = importlib.util.module_from_spec(spec)
spec.loader.exec_module(wfb)

fails = 0


def check(cond, msg):
    global fails
    print(("  PASS  " if cond else "  FAIL  ") + msg)
    fails += (not cond)


WS = tempfile.mkdtemp(prefix="wfb-gate-")
os.chdir(WS)
wfb.STATE_DIR = os.path.join(WS, "state", "bar_wait")
wfb.ROOT = os.path.join(WS, "fakeroot")
os.makedirs(os.path.join(wfb.ROOT, "lib"))
RUNNER_PY = os.path.join(wfb.ROOT, "lib", "runner.py")
open(RUNNER_PY, "w").write("# fake lib/runner.py\nEXPECTED_BAR_GATE = 1\n")
wfb.CHILD_POLL_SECONDS = 0.05
wfb.RUN_TIMEOUT_SECONDS = 1.0

alerts, stale = [], []
wfb._alert_failure = lambda: types.SimpleNamespace(alert=lambda name, code, out: alerts.append((name, code, out)))
wfb._alert_stale = lambda name, expected, minutes, who: stale.append((name, minutes, who))

# The fake strategy: `# lib.runner run(` keeps _choose_path's text test happy; __main__ follows
# the plan at $TICK22_PLAN: sleep_before, started, probe, sleep_after, state, rc.
FAKE = '''# fake strategy — lib.runner run( text for _choose_path
INTERVAL = "1m"   # NOW 14:43:20 → expected 14:42
import json, os, sys, time
if __name__ == "__main__":
    plan = json.load(open(os.environ["TICK22_PLAN"]))
    name = plan["name"]
    hs = os.path.join("state", "bar_wait")
    print("fake child: expected env =", os.environ.get("BLAVE_EXPECTED_BAR"), "stdin isatty", sys.stdin.isatty() if False else None)
    print("STDIN", sys.stdin.read() == "")
    time.sleep(plan.get("sleep_before", 0))
    if plan.get("started"):
        json.dump({"pid": os.getpid(), "at": time.time(), "expected": os.environ.get("BLAVE_EXPECTED_BAR")},
                  open(os.path.join(hs, name + ".started"), "w"))
    if plan.get("probe") is not None:
        probe = dict(plan["probe"])
        if not plan.get("probe_raw"):
            probe["pid"] = os.getpid()
            probe["expected"] = os.environ.get("BLAVE_EXPECTED_BAR")
        json.dump(probe, open(os.path.join(hs, name + ".probe.json"), "w"))
    time.sleep(plan.get("sleep_after", 0))
    if plan.get("state") is not None:
        json.dump(plan["state"], open(os.path.join("strategies", name, "state.json"), "w"))
    if plan.get("crash"):
        raise RuntimeError("fake strategy crashed")
    sys.exit(plan.get("rc", 0))
'''

NOW = datetime(2026, 10, 11, 14, 43, 20)
EXPECTED = datetime(2026, 10, 11, 14, 42)
EXP_ISO = EXPECTED.isoformat()


def setup(name, src=FAKE):
    d = os.path.join(WS, "strategies", name)
    os.makedirs(d, exist_ok=True)
    with open(os.path.join(d, "strategy.py"), "w") as f:
        f.write(src)
    os.makedirs(wfb.STATE_DIR, exist_ok=True)
    for leftover in ("state.json",):
        try:
            os.remove(os.path.join(d, leftover))
        except OSError:
            pass
    return d


def plan(name, **kw):
    p = os.path.join(WS, f"plan_{name}.json")
    json.dump({"name": name, **kw}, open(p, "w"))
    os.environ["TICK22_PLAN"] = p


def probe_doc(ready, observed, straggler=None, feed_wait=None):
    return {"expected": EXP_ISO, "observed_ts": observed, "ready": ready, "straggler": straggler,
            "feed_wait": feed_wait, "pid": 0, "at": time.time()}


def gate(name, state=None):
    state = state if state is not None else wfb._default_state()
    alerts.clear()
    stale.clear()
    wfb._run_gate(name, state, NOW, EXPECTED, EXP_ISO)
    return state


def hb(name):
    return os.path.exists(os.path.join(WS, "state", "heartbeat", name))


def ticks(name):
    p = os.path.join(wfb.STATE_DIR, f"{name}.ticks.jsonl")
    return [json.loads(l) for l in open(p)] if os.path.exists(p) else []


# ── A. timeout counts from the probe ─────────────────────────────────────────
setup("slowfetch")
plan("slowfetch", started=True, sleep_before=1.6, probe=probe_doc(True, EXP_ISO), state={"position": 1.0})
t0 = time.monotonic()
st = gate("slowfetch")
check(st["last_processed_bar"] == EXP_ISO and not alerts and time.monotonic() - t0 >= 1.5,
      "A: a child slow BEFORE .probe.json (fetch) is not killed by RUN_TIMEOUT_SECONDS")
setup("slowrun")
plan("slowrun", started=True, probe=probe_doc(True, EXP_ISO), sleep_after=3.0, state={"position": 1.0})
t0 = time.monotonic()
st = gate("slowrun")
check(alerts and alerts[0][1] == -1 and "killed after exceeding" in alerts[0][2]
      and st["last_attempt_failed_at"] and st["last_processed_bar"] is None and time.monotonic() - t0 < 2.5,
      f"A: a child slow AFTER .probe.json is killed at RUN_TIMEOUT_SECONDS: rc -1 alert + backoff ({alerts[:1]})")

# ── B. the exit-code table ───────────────────────────────────────────────────
setup("ok")
plan("ok", started=True, probe=probe_doc(True, "2026-10-11T14:43:00"), state={"position": 1.0, "symbol": "BTCUSDT"})
st = gate("ok")
check(st["last_processed_bar"] == EXP_ISO and st["last_processed_data_bar"] == "2026-10-11T14:43:00"
      and st["last_seen_bar"] == "2026-10-11T14:43:00" and st["pending_since"] is None
      and st["last_attempt_failed_at"] is None and st["stall_alert_at"] is None and st["last_path"] == "gate",
      f"B: rc 0 ready → processed; data_bar = the bar actually computed (14:43 on the 14:42 slot) ({st})")
check(hb("ok") and not alerts, "B: rc 0 → heartbeat touched, no alert")
rows = ticks("ok")
check(len(rows) == 1 and rows[0]["expected"] == EXP_ISO and rows[0]["data_bar"] == "2026-10-11T14:43:00"
      and rows[0]["state"] == 1.0 and rows[0]["secs"] > 0,
      f"B: ticks.jsonl got one line {{at, expected, data_bar, secs, state=position}} ({rows})")
check(st["gate_verified_key"] == wfb._gate_key("ok"), "B: .started seen → gate_verified_key = (strategy.py, lib/runner.py) key")

setup("okc")
plan("okc", started=True, probe=probe_doc(True, EXP_ISO, straggler="ETHUSDT"),
     state={"type": "portfolio", "weights": {"BTCUSDT": 0.5}, "bar_at": EXP_ISO})
gate("okc")
check(ticks("okc")[0]["state"] == {"BTCUSDT": 0.5}, "B: Type C ticks.jsonl state = weights")

setup("wait")
plan("wait", started=True, probe=probe_doc(False, "2026-10-11T14:41:00"), rc=75)
st = gate("wait")
check(st["last_processed_bar"] is None and st["pending_since"] == NOW.isoformat()
      and st["last_seen_bar"] == "2026-10-11T14:41:00" and st["last_attempt_failed_at"] is None
      and not hb("wait") and not alerts and not ticks("wait"),
      f"B: 75 not ready → pending_since set, last_seen_bar = observed, no heartbeat / alert / failure ({st})")
st["pending_since"] = (NOW - timedelta(minutes=16)).isoformat()
plan("wait", started=True, probe=probe_doc(False, "2026-10-11T14:41:00", straggler="ETHUSDT"), rc=75)
wfb._run_gate("wait", st, NOW, EXPECTED, EXP_ISO)
check(stale == [("wait", 16, "ETHUSDT")] and st["stall_alert_at"], f"B: 16 min pending → one stale alert naming the straggler ({stale})")

setup("feed")
fw = {"source": "twfutures_institutional", "need": "2026-10-10T16:00:00",
      "due_at": "2026-10-11T12:00:00", "last_bar": "2026-10-11T13:00:00"}
plan("feed", started=True, probe=probe_doc(False, "2026-10-11T13:00:00", straggler="twfutures_institutional", feed_wait=fw), rc=75)
st = gate("feed")
check(st["pending_since"] == "2026-10-11T12:00:00" and not alerts,
      f"B: feed_wait → pending_since counts from due_at ({st['pending_since']})")
st["pending_since"] = (NOW - timedelta(minutes=20)).isoformat()
wfb._run_gate("feed", st, NOW, EXPECTED, EXP_ISO)
check(stale and isinstance(stale[0][2], wfb._FeedWait) and stale[0][2] == "twfutures_institutional"
      and stale[0][2].due_at == datetime(2026, 10, 11, 12, 0),
      "B: feed_wait stale alert carries a _FeedWait with the due time (the 「等的是外部資料」 text)")

setup("fetcherr")
plan("fetcherr", started=True, probe=None, crash=True)
st = gate("fetcherr")
check(alerts and alerts[0][1] == "fetch_error" and "fake strategy crashed" in alerts[0][2]
      and st["last_attempt_failed_at"] and st["last_processed_bar"] is None and not hb("fetcherr"),
      f"B: rc≠0 with .started and no probe → fetch_error alert with the output tail + backoff ({alerts[:1]})")

setup("crash")
plan("crash", started=True, probe=probe_doc(True, EXP_ISO), crash=True)
st = gate("crash")
log = open(os.path.join(WS, "strategies", "crash", "strategy.log")).read()
check(alerts and alerts[0][1] == 1 and "fake strategy crashed" in alerts[0][2] and "fake strategy crashed" in log
      and st["last_attempt_failed_at"] and st["last_processed_bar"] is None,
      "B: rc≠0 with probe → crash alert (rc), output appended to strategy.log, backoff")

setup("legacy")
plan("legacy", started=False, probe=None, state={"position": 1.0})
st = gate("legacy")
check(st["gate_unsupported_key"] == wfb._gate_key("legacy") and st["gate_unsupported_at"]
      and st["last_processed_bar"] is None and not hb("legacy") and not alerts and not ticks("legacy"),
      f"B: rc 0 without .started → gate_unsupported_*, bar NOT processed, no heartbeat ({st})")

setup("early")
plan("early", started=False, probe=None, crash=True)
st = gate("early")
check(alerts and alerts[0][1] == 1 and st["last_attempt_failed_at"] and st["gate_unsupported_key"] is None,
      "B: rc≠0 without .started (crashed before run()) → crash alert + backoff, not 'unsupported'")

setup("oops")
plan("oops", started=False, probe=probe_doc(True, EXP_ISO))
raised = None
try:
    gate("oops")
except RuntimeError as e:
    raised = e
check(raised is not None and "without .started" in str(raised), "B: probe without .started → wrapper error (RuntimeError)")

setup("swallow")
plan("swallow", started=True, probe=probe_doc(False, "2026-10-11T14:41:00"), rc=0)
st = gate("swallow")
check(st["pending_since"] == NOW.isoformat() and st["last_processed_bar"] is None and not hb("swallow") and not alerts,
      "B: rc 0 but probe says not ready (a __main__ swallowing SystemExit) → not-ready bookkeeping, no crash")

for label, raw in (("stale pid", {**probe_doc(True, EXP_ISO), "pid": 1}),
                   ("other bar", {**probe_doc(True, EXP_ISO), "expected": "2026-10-11T14:41:00", "pid": None})):
    setup("leftover")
    plan("leftover", started=True, probe=raw, probe_raw=True, state={"position": 1.0})
    raised = None
    try:
        gate("leftover")
    except RuntimeError as e:
        raised = e
    check(raised is not None and "not this tick" in str(raised) and wfb._load_state("leftover").get("last_processed_bar") is None,
          f"B: a probe that is not this tick's ({label}) → wrapper error, bar not processed")

# Windows venv launcher: proc.pid is the launcher, run() writes its own (different) pid into
# both .started and .probe.json — the probe is this tick's when it matches .started
setup("launcher")
st = wfb._default_state()
wfb._apply("launcher", st, 0, {"pid": 777, "at": time.time(), "expected": EXP_ISO},
           {**probe_doc(True, EXP_ISO), "pid": 777}, "", 1.0, NOW, EXPECTED, EXP_ISO, child_pid=999)
check(st["last_processed_bar"] == EXP_ISO, "B: probe pid == .started pid, ≠ proc.pid (venv launcher) → processed")
raised = None
try:
    wfb._apply("launcher", wfb._default_state(), 0, {"pid": 777, "at": time.time(), "expected": EXP_ISO},
               {**probe_doc(True, EXP_ISO), "pid": 1}, "", 1.0, NOW, EXPECTED, EXP_ISO, child_pid=777)
except RuntimeError as e:
    raised = e
check(raised is not None and "not this tick" in str(raised), "B: probe pid ≠ .started pid → wrapper error even when it equals proc.pid")

# ── C. _choose_path ───────────────────────────────────────────────────────────
setup("cp")
st = wfb._default_state()
check(wfb._choose_path("cp", st) == "verify", "C: first time (no key) → verify")
open(RUNNER_PY, "w").write("# fake lib/runner.py without the flag\n")
check(wfb._choose_path("cp", st) == "probe", "C: lib/runner.py without EXPECTED_BAR_GATE → probe")
open(RUNNER_PY, "w").write("# fake lib/runner.py\nEXPECTED_BAR_GATE = 1\n")
setup("norun", 'INTERVAL = "1h"\nimport lib.runner\n')
check(wfb._choose_path("norun", wfb._default_state()) == "probe", "C: strategy that never calls run( → probe")
setup("norun2", 'INTERVAL = "1h"\n# run( but not through the runner\n')
check(wfb._choose_path("norun2", wfb._default_state()) == "probe", "C: strategy without lib.runner → probe")
st["gate_verified_key"] = wfb._gate_key("cp")
check(wfb._choose_path("cp", st) == "gate", "C: verified key matches → gate")
with open(os.path.join(WS, "strategies", "cp", "strategy.py"), "a") as f:
    f.write("\n# edited\n")
check(wfb._choose_path("cp", st) == "verify", "C: strategy.py changed → verify again")
st["gate_verified_key"] = wfb._gate_key("cp")
open(RUNNER_PY, "w").write("# fake lib/runner.py, new build\nEXPECTED_BAR_GATE = 1\n")
check(wfb._choose_path("cp", st) == "verify", "C: lib/runner.py changed → verify again")
st["gate_unsupported_key"] = wfb._gate_key("cp")
check(wfb._choose_path("cp", st) == "probe", "C: unsupported key matches → probe")
with open(os.path.join(WS, "strategies", "cp", "strategy.py"), "a") as f:
    f.write("# edited again\n")
check(wfb._choose_path("cp", st) == "verify", "C: unsupported but the key changed → tried again (verify)")

# ── D. _tick end to end ──────────────────────────────────────────────────────
class Clock(datetime):
    @classmethod
    def now(cls, tz=None):
        return NOW.replace(tzinfo=tz) if tz else NOW


wfb.datetime = Clock
probes = []


def fake_probe(mod, expected):
    probes.append(expected)
    return datetime(2026, 10, 11, 14, 42), True, None


wfb._check_freshness = fake_probe
runs = []
real_protected = wfb._run_strategy_protected
wfb._run_strategy_protected = lambda name: runs.append(name) or True

setup("e2e")
plan("e2e", started=True, probe=probe_doc(True, EXP_ISO), state={"position": 0.0})
alerts.clear()
wfb._tick("e2e")
st = wfb._load_state("e2e")
check(probes == [EXPECTED] and st["last_path"] == "gate" and st["last_processed_bar"] == EXP_ISO
      and st["gate_verified_key"] == wfb._gate_key("e2e") and not runs and hb("e2e"),
      f"D: verify tick = in-process probe first, then the gate child; state saved ({st['last_path']}, probes {len(probes)})")
check(not os.path.exists(os.path.join(wfb.STATE_DIR, "e2e.lock")), "D: lock released")
wfb._tick("e2e")
check(len(probes) == 1, "D: the processed bar → fast path (no probe, no child)")
st = wfb._load_state("e2e")
st["last_processed_bar"] = None
st["last_processed_data_bar"] = None
wfb._save_state("e2e", st)
plan("e2e", started=True, probe=probe_doc(True, "2026-10-11T14:43:00"), state={"position": 1.0})
wfb._tick("e2e")
st = wfb._load_state("e2e")
check(len(probes) == 1 and st["last_processed_data_bar"] == "2026-10-11T14:43:00" and len(ticks("e2e")) == 2,
      "D: verified → the next tick goes straight to the child, no in-process probe")

setup("e2e_legacy")
plan("e2e_legacy", started=False, probe=None, state={"position": 1.0})
probes.clear()
wfb._tick("e2e_legacy")
st = wfb._load_state("e2e_legacy")
check(probes == [EXPECTED] and st["gate_unsupported_key"] and st["last_processed_bar"] == EXP_ISO and hb("e2e_legacy"),
      "D: verify tick on a strategy that ignores the env → probed, ran, counted as processed (what the probe path would have done), marked unsupported")
wfb._tick("e2e_legacy")
st = wfb._load_state("e2e_legacy")
st["last_processed_bar"] = None
wfb._save_state("e2e_legacy", st)
wfb._tick("e2e_legacy")
st = wfb._load_state("e2e_legacy")
check(len(probes) == 2 and runs == ["e2e_legacy"] and st["last_path"] == "probe" and st["last_processed_bar"] == EXP_ISO,
      "D: unsupported → later ticks take the probe path and _run_strategy_protected, as before")
wfb._run_strategy_protected = real_protected

# the probe path saves a not-ready state exactly as before (the shared _note_not_ready)
wfb._check_freshness = lambda mod, expected: (datetime(2026, 10, 11, 14, 41), False, None)
setup("e2e_wait")
wfb._tick("e2e_wait")
st = wfb._load_state("e2e_wait")
check(st["pending_since"] == NOW.isoformat() and st["last_seen_bar"] == "2026-10-11T14:41:00"
      and st["last_path"] == "probe" and st["last_processed_bar"] is None,
      "D: verify tick, probe says not ready → no child, not-ready bookkeeping as before")

# ── E. fast path ─────────────────────────────────────────────────────────────
def hit(last_processed, data_bar, interval, now):
    st = {**wfb._default_state(), "last_processed_bar": last_processed, "last_processed_data_bar": data_bar}
    exp = wfb._expected_closed_bar_open(interval, now)
    return wfb._is_processed(st, exp, exp.isoformat(), now)


cases = {
    "1m crypto, slow 14:42 tick computed 14:43 → the 14:43 slot is done":
        hit("2026-10-11T14:42:00", "2026-10-11T14:43:00", "1m", datetime(2026, 10, 11, 14, 44, 30)),
    "1m crypto, normal tick (data_bar = expected) → next slot runs":
        hit("2026-10-11T14:42:00", "2026-10-11T14:42:00", "1m", datetime(2026, 10, 11, 14, 44, 30)),
    "1h crypto → next slot runs":
        hit("2026-10-11T13:00:00", "2026-10-11T13:00:00", "1h", datetime(2026, 10, 11, 15, 1)),
    "1d crypto → next slot runs":
        hit("2026-10-10T00:00:00", "2026-10-10T00:00:00", "1d", datetime(2026, 10, 12, 0, 5)),
    "TXF 1d (16:00 UTC label) → next slot runs":
        hit("2026-10-11T00:00:00", "2026-10-11T16:00:00", "1d", datetime(2026, 10, 13, 1, 0)),
    "TXF 1d same slot → done":
        hit("2026-10-11T00:00:00", "2026-10-11T16:00:00", "1d", datetime(2026, 10, 12, 3, 0)),
    "TXF 60m (whole-hour label) → next slot runs":
        hit("2026-10-12T00:00:00", "2026-10-12T00:00:00", "60m", datetime(2026, 10, 12, 2, 1)),
    "TXF 60m same slot → done":
        hit("2026-10-12T00:00:00", "2026-10-12T00:00:00", "60m", datetime(2026, 10, 12, 1, 30)),
    "future-dated data_bar (joined calendar) never hits":
        hit("2026-10-11T14:42:00", "2030-01-01T00:00:00", "1m", datetime(2026, 10, 11, 14, 44, 30)),
    "no data_bar (probe path) → equality only":
        hit("2026-10-11T14:42:00", None, "1m", datetime(2026, 10, 11, 14, 44, 30)),
}
hits = {k for k, v in cases.items() if v}
want = {"1m crypto, slow 14:42 tick computed 14:43 → the 14:43 slot is done",
        "TXF 1d same slot → done", "TXF 60m same slot → done"}
check(hits == want, f"E: fast-path hit set == the three expected ({sorted(hits ^ want)})")

# ── F. state keys ────────────────────────────────────────────────────────────
src = open(WFB, encoding="utf-8").read()
written = set(re.findall(r'state\["(\w+)"\]\s*=', src))
DOC = {"last_processed_bar", "pending_since", "last_seen_bar", "stall_alert_at", "last_attempt_failed_at",
       "wrapper_error_alerted_at", "last_processed_data_bar", "last_path", "gate_verified_key",
       "gate_unsupported_key", "gate_unsupported_at"}
check(written == DOC, f"F: every state[...] key written == the documented set ({sorted(written ^ DOC)})")
check(set(wfb._default_state()) == DOC, "F: _default_state() has every key (old files upgrade on load)")
for k in ("last_processed_bar", "last_seen_bar", "last_attempt_failed_at", "wrapper_error_alerted_at"):
    check(k in src.split("def _tick")[0] or k in src, f"F: {k} kept (portfolio_reporter._recomputed_since reads it)")

# ── G. the spawn ─────────────────────────────────────────────────────────────
kw = wfb._child_kw()
check(kw == {"stdin": subprocess.DEVNULL}, f"G: posix child kw = stdin DEVNULL ({kw})")


class _NtOs:
    name = "nt"

    def __getattr__(self, k):
        return getattr(os, k)


NO_WINDOW = 0x08000000
had = hasattr(subprocess, "CREATE_NO_WINDOW")
if not had:
    subprocess.CREATE_NO_WINDOW = NO_WINDOW
wfb.os = _NtOs()
try:
    kw = wfb._child_kw()
finally:
    wfb.os = os
    if not had:
        del subprocess.CREATE_NO_WINDOW
check(kw == {"stdin": subprocess.DEVNULL, "creationflags": NO_WINDOW}, f"G: nt child kw adds CREATE_NO_WINDOW ({kw})")
check("**_child_kw()" in src.split("def _spawn_gate_child")[1].split("def _wait_child")[0]
      and "**_child_kw()" in src.split("def _run_strategy_protected")[1].split("def _child_kw")[0],
      "G: both launchers pass **_child_kw()")

setup("spawn")
for leftover in ("spawn.started", "spawn.probe.json", "spawn.out"):
    open(os.path.join(wfb.STATE_DIR, leftover), "w").write("stale")
plan("spawn", started=True, probe=probe_doc(True, EXP_ISO), state={"position": 1.0})
lock = wfb._acquire_lock("spawn")
wfb._clear_handshake("spawn")
check(not any(os.path.exists(os.path.join(wfb.STATE_DIR, f)) for f in ("spawn.started", "spawn.probe.json", "spawn.out")),
      "G: handshake leftovers cleared before the run")
proc = wfb._spawn_gate_child("spawn", EXP_ISO)
pids = wfb._lock_pids(lock)
rc, started, probe, out = wfb._wait_child(proc, "spawn")
wfb._release_lock(lock)
check(pids == [os.getpid(), proc.pid], f"G: lock = holder pid + child pid during the run ({pids})")
check(rc == 0 and started and probe["ready"] and f"expected env = {EXP_ISO}" in out and "STDIN True" in out,
      f"G: child saw BLAVE_EXPECTED_BAR, stdin empty (DEVNULL), output captured to .out ({out.strip()[-80:]})")

# ── H. TAIFEX session table ──────────────────────────────────────────────────
TXF = FAKE.replace('INTERVAL = "1m"', 'INTERVAL = "5m"\nSYMBOL = "TMF"\n# from lib.data import fetch_twfutures_ohlcv')
setup("txf5", TXF)
check(wfb._tw_index_futures_strategy("txf5") and not wfb._tw_index_futures_strategy("e2e"),
      "H: detection = SYMBOL TXF/MXF/TMF + fetch_twfutures_ohlcv in the source")
td5 = timedelta(minutes=5)
U = lambda y, mo, d, h, mi: datetime(y, mo, d, h, mi) - timedelta(hours=8)   # Taipei → naive UTC
sess = {
    "Mon 08:45 day open": wfb._tw_fut_slot(U(2026, 10, 12, 8, 45), td5) is not None,
    "Mon 13:45 closing bin": wfb._tw_fut_slot(U(2026, 10, 12, 13, 45), td5) is not None,
    "Mon 13:50 closed": wfb._tw_fut_slot(U(2026, 10, 12, 13, 50), td5) is None,
    "Mon 14:55 closed": wfb._tw_fut_slot(U(2026, 10, 12, 14, 55), td5) is None,
    "Mon 15:00 night open": wfb._tw_fut_slot(U(2026, 10, 12, 15, 0), td5) == (U(2026, 10, 12, 15, 5),) * 2,
    "Tue 04:55 night last": wfb._tw_fut_slot(U(2026, 10, 13, 4, 55), td5) is not None,
    "Tue 05:05 closed": wfb._tw_fut_slot(U(2026, 10, 13, 5, 5), td5) is None,
    "Tue 08:40 closed": wfb._tw_fut_slot(U(2026, 10, 13, 8, 40), td5) is None,
    "Sat 04:55 (Friday night)": wfb._tw_fut_slot(U(2026, 10, 17, 4, 55), td5) is not None,
    "Sat 09:00 closed": wfb._tw_fut_slot(U(2026, 10, 17, 9, 0), td5) is None,
    "Sun 15:00 closed": wfb._tw_fut_slot(U(2026, 10, 18, 15, 0), td5) is None,
    "Mon 00:00 closed (no Sunday night)": wfb._tw_fut_slot(U(2026, 10, 12, 0, 0), td5) is None,
    "1m 13:46 (minute-END close) in": wfb._tw_fut_slot(U(2026, 10, 12, 13, 46), timedelta(minutes=1)) is not None,
    "1m 13:47 closed": wfb._tw_fut_slot(U(2026, 10, 12, 13, 47), timedelta(minutes=1)) is None,
    "1m 05:00 (minute-END night close) in": wfb._tw_fut_slot(U(2026, 10, 13, 5, 0), timedelta(minutes=1)) is not None,
    "5m 05:00 closed (no bin opens at the night close)": wfb._tw_fut_slot(U(2026, 10, 13, 5, 0), td5) is None,
    # 60m / 30m labels are whole / half hours: the 08:45–09:00 bar is labelled 08:00
    "60m 08:00 label (00:00 UTC) = first day bar, polled from 09:00":
        wfb._tw_fut_slot(datetime(2026, 10, 12, 0, 0), timedelta(hours=1)) == (datetime(2026, 10, 12, 1, 0),) * 2,
    "30m 08:30 label (00:30 UTC) in": wfb._tw_fut_slot(datetime(2026, 10, 12, 0, 30), timedelta(minutes=30)) is not None,
    "60m 13:00 label (05:00 UTC, closes 13:45) in": wfb._tw_fut_slot(datetime(2026, 10, 12, 5, 0), timedelta(hours=1)) is not None,
    "60m 14:00 label closed": wfb._tw_fut_slot(datetime(2026, 10, 12, 6, 0), timedelta(hours=1)) is None,
    "60m 07:00 label (07:00–08:00) closed": wfb._tw_fut_slot(U(2026, 10, 12, 7, 0), timedelta(hours=1)) is None,
    "60m 15:00 label night in": wfb._tw_fut_slot(U(2026, 10, 12, 15, 0), timedelta(hours=1)) is not None,
    "60m 23:00 label (closes midnight) in": wfb._tw_fut_slot(U(2026, 10, 12, 23, 0), timedelta(hours=1)) is not None,
    "60m 04:00 label (closes 05:00) in": wfb._tw_fut_slot(U(2026, 10, 13, 4, 0), timedelta(hours=1)) is not None,
    "60m 05:00 label closed": wfb._tw_fut_slot(U(2026, 10, 13, 5, 0), timedelta(hours=1)) is None,
    "5m 08:40 label (closes 08:45) closed": wfb._tw_fut_slot(U(2026, 10, 12, 8, 40), td5) is None,
    # settlement day 2026-10-21 (third Wednesday): expiring month stops at 13:30
    "settlement 5m 13:25 in": wfb._tw_fut_slot(U(2026, 10, 21, 13, 25), td5) is not None,
    "settlement 5m 13:30 closed": wfb._tw_fut_slot(U(2026, 10, 21, 13, 30), td5) is None,
    "settlement 5m 13:45 closed": wfb._tw_fut_slot(U(2026, 10, 21, 13, 45), td5) is None,
    "settlement 1m 13:30 (END label) in": wfb._tw_fut_slot(U(2026, 10, 21, 13, 30), timedelta(minutes=1)) is not None,
    "settlement 1m 13:32 closed": wfb._tw_fut_slot(U(2026, 10, 21, 13, 32), timedelta(minutes=1)) is None,
    "settlement 60m 13:00 in": wfb._tw_fut_slot(datetime(2026, 10, 21, 5, 0), timedelta(hours=1)) is not None,
    "settlement 15:00 night open": wfb._tw_fut_slot(U(2026, 10, 21, 15, 0), td5) is not None,
    "a Wednesday that is not the third (10-14) keeps 13:45": wfb._tw_fut_slot(U(2026, 10, 14, 13, 45), td5) is not None,
}
check(all(sess.values()), f"H: session table ({[k for k, v in sess.items() if not v]})")
td1d = timedelta(days=1)
check(wfb._tw_fut_slot(datetime(2026, 10, 11), td1d) == (datetime(2026, 10, 12, 5, 45), datetime(2026, 10, 12, 7, 0)),
      "H: daily slot labelled 10-11 00:00 UTC = Monday 10-12's bar: poll from 13:45 TWN, late after 15:00 TWN")
check(wfb._tw_fut_slot(datetime(2026, 10, 10), td1d) is None and wfb._tw_fut_slot(datetime(2026, 10, 9), td1d) is None,
      "H: daily slots ending on Saturday / Sunday have no bar")
check(wfb._tw_fut_slot(datetime(2026, 10, 15), td1d) is not None, "H: Friday's daily slot exists")

# the day close → night open sequence, 5m, with a probe that only sees the bars that exist
probes.clear()
alerts.clear()
stale.clear()
seen = {"last": U(2026, 10, 12, 13, 45)}
wfb._check_freshness = lambda mod, expected: probes.append(expected) or (seen["last"], seen["last"] >= expected, None)
setup("txf5", TXF.replace("# from lib.data import fetch_twfutures_ohlcv", "# from lib.data import fetch_twfutures_ohlcv\n# not lib.runner run( here"))
wfb._run_strategy_protected = lambda name: runs.append(name) or True
runs.clear()
st = wfb._default_state()
st["gate_unsupported_key"] = wfb._gate_key("txf5")   # keep this one on the probe path (fake child not needed)
wfb._save_state("txf5", st)
timeline = []


def at(y, mo, d, h, mi, s=30, name="txf5"):
    global NOW
    NOW = U(y, mo, d, h, mi) + timedelta(seconds=s)
    n_probe, n_run = len(probes), len(runs)
    wfb._tick(name)
    timeline.append((f"{h:02d}:{mi:02d}", len(probes) - n_probe, len(runs) - n_run))


at(2026, 10, 12, 13, 50)                      # 13:45 bin closed at 13:50 → run it
check(timeline[-1] == ("13:50", 1, 1), f"H: 13:50 tick runs the 13:45 closing bin ({timeline[-1]})")
st = wfb._load_state("txf5")
st["stall_alert_at"] = time.time()             # as if the last bar before the close had stalled and alerted
wfb._save_state("txf5", st)
for mi in range(55, 60):
    at(2026, 10, 12, 13, mi)
for h in (14,):
    for mi in range(0, 60):
        at(2026, 10, 12, h, mi)
at(2026, 10, 12, 15, 0)
at(2026, 10, 12, 15, 4)
check(all(p == 0 and r == 0 for _, p, r in timeline[1:]) and not stale and not alerts,
      f"H: 13:55 → 15:04: no probe, no run, no bar_stale across the 75-minute gap ({sum(p for _, p, _ in timeline[1:])} probes)")
st = wfb._load_state("txf5")
check(st["pending_since"] is None and st["stall_alert_at"] is None,
      "H: nothing pending across the gap, and a stall alerted before the close is forgotten (no throttle into the night)")
at(2026, 10, 12, 15, 5, 10)                   # 15:00 bin closes 15:05; data not in yet
check(timeline[-1] == ("15:05", 1, 0) and wfb._load_state("txf5")["pending_since"] == NOW.isoformat(),
      f"H: 15:05:10 polls the 15:00 bin at full speed, pending starts now ({timeline[-1]})")
at(2026, 10, 12, 15, 5, 45)
check(timeline[-1] == ("15:05", 1, 0), "H: polled again within the same minute-slot (no throttle)")
seen["last"] = U(2026, 10, 12, 15, 0)
at(2026, 10, 12, 15, 6)
check(timeline[-1] == ("15:06", 1, 1) and wfb._load_state("txf5")["last_processed_bar"] == U(2026, 10, 12, 15, 0).isoformat(),
      f"H: the 15:00 bin runs as soon as it lands ({timeline[-1]})")
seen["last"] = U(2026, 10, 12, 15, 5)
at(2026, 10, 12, 15, 10, 40)
check(timeline[-1] == ("15:10", 1, 1), f"H: the 15:05 bin runs on the 15:10 tick ({timeline[-1]})")
check(not stale and not alerts, "H: still no alert")
# a genuinely late in-session bar still alerts after 15 minutes, counted from the bar close
seen["last"] = U(2026, 10, 12, 15, 5)
for mi in range(16, 33):
    at(2026, 10, 12, 15, mi)   # pending from the 15:16:30 poll → alert at 15:31:30, throttled after
check(len(stale) == 1 and stale[0][1] == 15 and wfb._load_state("txf5")["stall_alert_at"],
      f"H: a 5m bar 15 minutes late inside the session → exactly one bar_stale ({stale})")

# daily: no poll before 13:45 TWN, late only from 15:00 TWN, weekend slot skipped
TXFD = TXF.replace('INTERVAL = "5m"', 'INTERVAL = "1d"')
setup("txfd", TXFD)
st = wfb._default_state()
st["gate_unsupported_key"] = wfb._gate_key("txfd")
wfb._save_state("txfd", st)
seen["last"] = datetime(2026, 10, 10, 16, 0)   # Friday 10-10's bar (label Taipei midnight = 16:00 UTC prev day)
probes.clear()
runs.clear()
stale.clear()
for h, mi in ((8, 15), (9, 0), (12, 0), (13, 40)):
    at(2026, 10, 12, h, mi, name="txfd")
check(all(p == 0 for _, p, _ in timeline[-4:]), "H: daily — Monday morning slots not polled before 13:45 TWN")
at(2026, 10, 12, 13, 46, name="txfd")
check(timeline[-1][1] == 1 and wfb._load_state("txfd")["pending_since"] == datetime(2026, 10, 12, 7, 0).isoformat(),
      f"H: daily — polled from 13:45 TWN, pending counts from 15:00 TWN ({timeline[-1]})")
at(2026, 10, 12, 15, 14, name="txfd")
check(not stale, "H: daily — 15:14 TWN: not late yet")
at(2026, 10, 12, 15, 16, name="txfd")
check(len(stale) == 1, f"H: daily — 15:16 TWN without the bar → bar_stale ({stale})")
seen["last"] = datetime(2026, 10, 11, 16, 0)   # Monday's bar published
at(2026, 10, 12, 15, 30, name="txfd")
check(timeline[-1][2] == 1 and wfb._load_state("txfd")["last_processed_bar"] == datetime(2026, 10, 11).isoformat(),
      "H: daily — Monday's bar runs when published")
probes.clear()
at(2026, 10, 17, 16, 0, name="txfd")   # Saturday
at(2026, 10, 18, 16, 0, name="txfd")   # Sunday
check(not probes and wfb._load_state("txfd")["pending_since"] is None, "H: daily — weekend slots skipped, nothing pending")

# a crypto strategy never sees the table
setup("btc5", FAKE.replace('INTERVAL = "1m"', 'INTERVAL = "5m"'))
st = wfb._default_state()
st["gate_unsupported_key"] = wfb._gate_key("btc5")
wfb._save_state("btc5", st)
seen["last"] = U(2026, 10, 12, 13, 45)
probes.clear()
at(2026, 10, 12, 14, 5, name="btc5")
check(len(probes) == 1 and wfb._load_state("btc5")["pending_since"] == NOW.isoformat(),
      "H: a crypto 5m strategy at 14:05 TWN polls as before (no session table)")

os.chdir(ROOT)
print("all checks passed" if not fails else f"FAILED: {fails}")
sys.exit(1 if fails else 0)
