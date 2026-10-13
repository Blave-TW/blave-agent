"""Minimal check: lib/runner.run()'s BLAVE_EXPECTED_BAR gate (0.1.22 ②, design
.claude/output/backend/live-tick-merge-interpreter-design-2026-10-12.md §3–§5). Real run() in a
temp workspace, stub fetch, no network — Type A unless said otherwise:

  1. expected bar AFTER the data → SystemExit(75); .started + .probe.json (ready:false,
     observed) written; NO state.json / stats.json / new version / drift.json
  2. data in → exit 0, probe ready:true with observed = last label, state.json byte-identical
     to the same tick run WITHOUT the env; drift.json written now (moved after the verdict)
  3. fetch raises FeedNotPublished → 75, probe feed_wait carries source/need/due_at/last_bar
  4. no env → no handshake file at all, behaviour of 2 (and FeedNotPublished propagates)
  5. Type C with one column a bar behind → 75, straggler names that column; all in → state
  6. BLAVE_MODE=backtest and a performance refresh ignore the env: no handshake files
  7. garbage env value → gate off (no handshake, normal tick)
  8. the EXPECTED_BAR_GATE flag is readable as text, the exit code is 75

Run: cd blave-agent && MPLBACKEND=Agg .venv/bin/python tests/check_bar_gate_runner.py
"""
import contextlib
import io
import json
import os
import re
import sys
import tempfile
from pathlib import Path

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
os.environ.setdefault("MPLBACKEND", "Agg")

import numpy as np
import pandas as pd

import lib.runner as runner
import lib.strategy as strategy
from lib.data import FeedNotPublished

runner.dotenv_values = lambda *a, **k: {}

fails = 0


def check(cond, msg):
    global fails
    print(("  PASS  " if cond else "  FAIL  ") + msg)
    fails += (not cond)


WS = Path(tempfile.mkdtemp(prefix="bar-gate-"))
os.chdir(WS)
runner._REPO_ROOT = WS
strategy._REPO_ROOT = WS
HS = WS / "state" / "bar_wait"
ENV_KEYS = ("BLAVE_MODE", runner.STATS_REFRESH_ENV, runner.EXPECTED_BAR_ENV)


def run(config, fetch, compute, mode="live", expected=None, refresh=False):
    for k in ENV_KEYS:
        os.environ.pop(k, None)
    os.environ["BLAVE_MODE"] = mode
    if refresh:
        os.environ[runner.STATS_REFRESH_ENV] = "1"
    if expected is not None:
        os.environ[runner.EXPECTED_BAR_ENV] = expected
    rc = 0
    try:
        with contextlib.redirect_stdout(io.StringIO()):
            runner.run(config, fetch, compute)
    except SystemExit as e:
        rc = e.code
    finally:
        for k in ENV_KEYS:
            os.environ.pop(k, None)
    return rc


def rb(p):
    return p.read_bytes() if p.exists() else None


def handshake(name):
    started, probe = HS / f"{name}.started", HS / f"{name}.probe.json"
    return (json.loads(started.read_text()) if started.exists() else None,
            json.loads(probe.read_text()) if probe.exists() else None)


def clear(name):
    for p in (HS / f"{name}.started", HS / f"{name}.probe.json"):
        if p.exists():
            p.unlink()


def frame(n):
    idx = pd.date_range("2024-01-01", periods=n, freq="h")
    close = pd.Series(100 + np.cumsum(np.sin(np.arange(n) / 7.0)), index=idx)
    return pd.DataFrame({"Open": close, "High": close * 1.001, "Low": close * 0.999,
                         "Close": close, "Volume": 1.0}, index=idx)


def compute_a(d):
    return pd.Series(np.where(np.arange(len(d)) % 40 < 20, 1.0, 0.0), index=d.index)


A_DIR = WS / "strategies" / "gate_a"
A_DIR.mkdir(parents=True)
A_SRC = A_DIR / "strategy.py"
A_SRC.write_text("# gate a v1\n")
A_CFG = {"STRATEGY_NAME": "gate_a", "SYMBOL": "BTCUSDT", "INTERVAL": "1h", "START": "2024-01-01",
         "FEE": 0.0005, "MCPT": False, "__file__": str(A_SRC)}
state, stats, vdir, drift = A_DIR / "state.json", A_DIR / "stats.json", A_DIR / "versions", A_DIR / "versions" / "drift.json"

# a backtest first so a version exists and drift.json has something to compare against
run(A_CFG, lambda h: frame(400), compute_a, mode="backtest")
check(stats.exists() and (vdir / "v1.json").exists(), "setup: backtest wrote stats.json + v1")
A_SRC.write_text("# gate a v2 — edited after the backtest, so a live tick flags drift\n")
stats0, idx0 = rb(stats), rb(vdir / "index.json")
data = frame(500)
last = data.index[-1]

# ── 1. not ready: nothing but the handshake ───────────────────────────────────
rc = run(A_CFG, lambda h: data, compute_a, expected=(last + pd.Timedelta("1h")).isoformat())
started, probe = handshake("gate_a")
check(rc == runner.NOT_READY_EXIT == 75, f"1: expected bar after the data → SystemExit(75) (rc {rc})")
check(started and started["expected"] == (last + pd.Timedelta("1h")).isoformat() and started["pid"] == os.getpid(),
      f"1: .started {{pid, at, expected}} ({started})")
check(probe and probe["ready"] is False and probe["observed_ts"] == last.isoformat()
      and probe["straggler"] is None and probe["feed_wait"] is None and probe["expected"] == started["expected"],
      f"1: .probe.json ready:false with the observed bar ({probe})")
check(not state.exists(), "1: no state.json")
check(rb(stats) == stats0 and rb(vdir / "index.json") == idx0 and not (vdir / "v2.json").exists(),
      "1: stats.json / versions untouched")
check(not drift.exists(), "1: drift.json not written on a not-ready tick (flag runs after the verdict)")

# ── 2. ready: identical to the ungated tick ───────────────────────────────────
clear("gate_a")
rc = run(A_CFG, lambda h: data, compute_a)   # no env → the reference tick
check(rc == 0 and state.exists() and handshake("gate_a") == (None, None),
      "4: no env → state.json written, no handshake file")
ref_state = rb(state)
state.unlink()
drift.unlink()
rc = run(A_CFG, lambda h: data, compute_a, expected=last.isoformat())
started, probe = handshake("gate_a")
check(rc == 0 and probe and probe["ready"] is True and probe["observed_ts"] == last.isoformat(),
      f"2: data in → exit 0, probe ready:true observed={probe and probe['observed_ts']}")
check(rb(state) == ref_state, "2: state.json byte-identical to the ungated tick")
check(drift.exists(), "2: drift.json written on the ready tick")
check(rb(stats) == stats0 and not (vdir / "v2.json").exists(), "2: still no stats.json rewrite, no version")

# an earlier expected bar (the tick is late, data already past it) is ready too
clear("gate_a")
state.unlink()
rc = run(A_CFG, lambda h: data, compute_a, expected=(last - pd.Timedelta("1h")).isoformat())
check(rc == 0 and rb(state) == ref_state and handshake("gate_a")[1]["observed_ts"] == last.isoformat(),
      "2b: expected bar before the last one → ready, computed on the data as fetched (not cut), probe says which bar")

# ── 3. FeedNotPublished under the gate → 75 with feed_wait ────────────────────
TPE = "Asia/Taipei"
exc = FeedNotPublished("twfutures_institutional", pd.Timestamp("2026-09-23", tz=TPE),
                       pd.Timestamp("2026-09-23 20:00", tz=TPE), pd.Timestamp("2026-09-23 21:00", tz=TPE))


def raising(h):
    raise exc


clear("gate_a")
state.unlink()
rc = run(A_CFG, raising, compute_a, expected="2026-09-23T13:00:00")
started, probe = handshake("gate_a")
check(rc == 75 and probe and probe["ready"] is False and probe["observed_ts"] == "2026-09-23T13:00:00"
      and probe["straggler"] == "twfutures_institutional"
      and probe["feed_wait"] == {"source": "twfutures_institutional", "need": "2026-09-22T16:00:00",
                                 "due_at": "2026-09-23T12:00:00", "last_bar": "2026-09-23T13:00:00"},
      f"3: FeedNotPublished → 75, probe.feed_wait four fields ({probe})")
check(not state.exists(), "3: no state.json")

# ── 4. no env: FeedNotPublished propagates as before ──────────────────────────
clear("gate_a")
raised = None
try:
    run(A_CFG, raising, compute_a)
except FeedNotPublished as e:
    raised = e
check(raised is exc and handshake("gate_a") == (None, None), "4: no env → FeedNotPublished propagates, no handshake")

# a non-feed error under the gate propagates too (wait_for_bar reads: started, no probe)
clear("gate_a")


def boom(h):
    raise RuntimeError("feed down")


raised = None
try:
    run(A_CFG, boom, compute_a, expected=last.isoformat())
except RuntimeError as e:
    raised = e
started, probe = handshake("gate_a")
check(str(raised) == "feed down" and started and probe is None,
      "3b: fetch_data raising something else → propagates; .started yes, .probe.json no")

# ── 5. Type C ─────────────────────────────────────────────────────────────────
IDX = pd.bdate_range("2023-01-02", periods=300)
rng = np.random.default_rng(3)
CLOSE = pd.DataFrame(100 * np.exp(np.cumsum(rng.normal(0.0003, 0.012, (300, 3)), axis=0)),
                     index=IDX, columns=list("ABC"))


def c_compute(data):
    c = data[0]   # Type C fetch_data returns (close_df, open_df) — the tuple is what judge() keys on
    w = np.zeros(c.shape)
    w[np.arange(len(c)) % 60 < 30, 0] = 0.5
    w[np.arange(len(c)) % 60 >= 30, 1] = 0.5
    return w, pd.concat({"close": c, "open": c}, axis=1)


C_DIR = WS / "strategies" / "gate_c"
C_DIR.mkdir(parents=True)
(C_DIR / "strategy.py").write_text("# gate c\n")
C_CFG = {"STRATEGY_NAME": "gate_c", "INTERVAL": "1d", "START": "2023-01-02", "FEE": 0.001,
         "__file__": str(C_DIR / "strategy.py")}
lagging = CLOSE.copy()
lagging.loc[lagging.index[-1], "B"] = np.nan
c_state = C_DIR / "state.json"
rc = run(C_CFG, lambda h: (lagging, lagging.copy()), c_compute, expected=IDX[-1].isoformat())
started, probe = handshake("gate_c")
check(rc == 75 and probe and probe["ready"] is False and probe["straggler"] == "B"
      and probe["observed_ts"] == IDX[-2].isoformat() and not c_state.exists(),
      f"5: Type C, column B a bar behind → 75, straggler B, observed = B's last valid ({probe})")
clear("gate_c")
rc = run(C_CFG, lambda h: (CLOSE, CLOSE.copy()), c_compute)
ref_c = rb(c_state)
c_state.unlink()
clear("gate_c")
rc = run(C_CFG, lambda h: (CLOSE, CLOSE.copy()), c_compute, expected=IDX[-1].isoformat())
started, probe = handshake("gate_c")
c_doc = json.loads(c_state.read_text()) if c_state.exists() else {}
ref_doc = json.loads(ref_c)
c_doc.pop("updated_at", None)
ref_doc.pop("updated_at", None)
check(rc == 0 and probe["ready"] is True and probe["straggler"] == "A" and c_doc == ref_doc,
      "5: Type C all in → exit 0, state.json equal to the ungated tick (updated_at aside)")

# ── 6. backtest and refresh ignore the env ───────────────────────────────────
clear("gate_a")
A_SRC.write_text("# gate a v1\n")   # back to the backtested code, so the backtest mints nothing new
rc = run(A_CFG, lambda h: data, compute_a, mode="backtest", expected=(last + pd.Timedelta("1h")).isoformat())
check(rc == 0 and handshake("gate_a") == (None, None) and stats.exists(),
      "6: BLAVE_MODE=backtest with the env → full backtest, no handshake")
clear("gate_a")
rc = run(A_CFG, lambda h: data, compute_a, refresh=True, expected=(last + pd.Timedelta("1h")).isoformat())
check(rc == 0 and handshake("gate_a") == (None, None) and json.loads(stats.read_text())["end"] == last.strftime("%Y-%m-%d"),
      "6: performance refresh with the env → stats refreshed, no handshake, not gated")

# ── 7. garbage env → gate off ────────────────────────────────────────────────
clear("gate_a")
state.unlink(missing_ok=True)
rc = run(A_CFG, lambda h: data, compute_a, expected="not-a-date")
check(rc == 0 and rb(state) == ref_state and handshake("gate_a") == (None, None),
      "7: unparseable BLAVE_EXPECTED_BAR → ordinary tick, no handshake")

# ── 8. the text flag wait_for_bar reads ──────────────────────────────────────
src = Path(runner.__file__).read_bytes()
check(re.search(rb"^EXPECTED_BAR_GATE\s*=\s*1\b", src, re.M) is not None, "8: EXPECTED_BAR_GATE = 1 readable as text")
check(runner.NOT_READY_EXIT == 75 and runner.EXPECTED_BAR_ENV == "BLAVE_EXPECTED_BAR", "8: exit 75, env name")

os.chdir(ROOT)
print("all checks passed" if not fails else f"FAILED: {fails}")
sys.exit(1 if fails else 0)
