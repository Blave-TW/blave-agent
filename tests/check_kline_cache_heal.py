"""runtime/kline_cache_heal.py: the stray bar a pre-fix api baked into a kline2 past month
is replaced through lib's own completing re-fetch; nothing else is touched (base periods in
any spelling, markers, symlinks, other namespaces); a kline3 or pre-refetch lib is left
alone; the work is staggered and paced, runs once, survives errors a bounded number of
times; portfolio_reporter runs it only after the report went out. No network.

Run: cd blave-agent && .venv/bin/python tests/check_kline_cache_heal.py
"""
import calendar
import os
import socket
import sys
import tempfile
import time
from pathlib import Path

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TMP = tempfile.mkdtemp(prefix="kline-heal-")
WS = os.path.join(TMP, "workspace")
os.makedirs(os.path.join(WS, "lib"))
os.environ["BLAVE_AGENT_WORKSPACE"] = WS
os.environ["BLAVE_AGENT_STATE"] = os.path.join(TMP, "state")
sys.path.insert(0, os.path.join(ROOT, "runtime"))
sys.path.insert(0, ROOT)


def _no_network(*a, **k):
    raise OSError("no network in this test")


socket.socket.connect = _no_network

import numpy as np  # noqa: E402
import pandas as pd  # noqa: E402
import kline_cache_heal as kc  # noqa: E402
import portfolio_reporter as pr  # noqa: E402
from lib import data as d  # noqa: E402  the repo lib drives the end-to-end re-fetch

CACHE = Path(WS) / "cache"
d._CACHE_DIR = CACHE
LIB = Path(WS) / "lib" / "data.py"
LIB_KLINE2 = "PREFIX = 'kline2'\ndef _written_before_month_end(path, ym): ...\n"
fails = 0


def check(cond, msg):
    global fails
    print(("ok   " if cond else "FAIL ") + msg)
    if not cond:
        fails += 1


def ts(y, m, day=1):
    return calendar.timegm((y, m, day, 0, 0, 0))


def mt(p):
    return int(p.stat(follow_symlinks=False).st_mtime) if p.is_symlink() else int(p.stat().st_mtime)


def reset_record():
    if os.path.exists(kc.RECORD_PATH):
        os.remove(kc.RECORD_PATH)


# Fixed clock before FIX_TS, so the passes below cut at the heal start every day the test runs
# (the FIX_TS side of the cutoff is pinned on its own further down).
T0 = kc.FIX_TS - 7 * 86400
PRE_FIX = ts(2026, 9, 15)   # after every test month ended, before the api fix
STRAY = pd.Timestamp("2025-07-01 00:00")
idx = pd.date_range("2025-06-01", "2025-08-01", freq="1h", inclusive="left")
good = pd.DataFrame({c: 100.0 for c in ("Open", "High", "Low", "Close", "Volume")}, index=idx)
bad = good.copy()
bad.loc[STRAY, ["Close", "Volume"]] = [1.0, 0.5]
calls = []


def raw(frame):
    def fetch(s, e):
        calls.append((s, e))
        return frame[(frame.index >= pd.Timestamp(s)) & (frame.index < pd.Timestamp(e))]
    return fetch


check(all(kc.is_base_period(p) for p in ("1m", "5m", "1min", "5min", "5Min", "1T", "5T"))
      and not any(kc.is_base_period(p) for p in ("15m", "15min", "3m", "1h", "1d", "1M", "5M", "50m", "m", "5")),
      "base period = 1 or 5 minutes in any spelling; 1M (a month) is not")

P1H = {"symbol": "BTCUSDT", "period": "1h"}
d._extend_cache_monthly("kline2", P1H, raw(bad), "2025-06-01", "2025-07-31")
d1h = CACHE / "kline2_1h_BTCUSDT"
for f in d1h.glob("*.parquet"):
    os.utime(f, (PRE_FIX, PRE_FIX))
calls.clear()
before = d._extend_cache_monthly("kline2", P1H, raw(good), "2025-06-01", "2025-07-31")
check(before.loc[STRAY, "Close"] == 1.0 and not calls,
      "precondition: a past month is never re-fetched, the stray bar stays")


def put(path, frame, mtime):
    path.parent.mkdir(parents=True, exist_ok=True)
    frame.to_parquet(path)
    os.utime(path, (mtime, mtime))
    return path


one_row = good.iloc[:1]
m1 = pd.date_range("2025-07-01", periods=3 * 1440, freq="1min")
full = pd.DataFrame(np.random.default_rng(1).random((len(m1), 5)),
                    columns=["Open", "High", "Low", "Close", "Volume"], index=m1)
now_ym = time.strftime("%Y-%m", time.gmtime(T0))
OUTSIDE = put(Path(TMP) / "outside" / "2025-07.parquet", good, PRE_FIX)
f = {
    "marker_1h": put(d1h / "2025-05.parquet", pd.DataFrame(), PRE_FIX),
    "1m_full": put(CACHE / "kline2_1m_BTCUSDT" / "2025-07.parquet", full, PRE_FIX),
    "1m_tiny": put(CACHE / "kline2_1m_BTCUSDT" / "2025-08.parquet", one_row, PRE_FIX),
    "1min_full": put(CACHE / "kline2_1min_BTCUSDT" / "2025-07.parquet", full, PRE_FIX),
    "5m_full": put(CACHE / "kline2_5m_ETHUSDT" / "2025-07.parquet", full, PRE_FIX),
    "5min_full": put(CACHE / "kline2_5min_BTCUSDT" / "2025-07.parquet", full, PRE_FIX),
    "5min_tiny": put(CACHE / "kline2_5min_BTCUSDT" / "2025-08.parquet", one_row, PRE_FIX),
    "15m_full": put(CACHE / "kline2_15m_BTCUSDT" / "2025-07.parquet", full, PRE_FIX),
    "base_marker": put(CACHE / "kline2_5m_SOLUSDT" / "2025-05.parquet", pd.DataFrame(), PRE_FIX),
    "current": put(CACHE / "kline2_1h_ETHUSDT" / f"{now_ym}.parquet", good, PRE_FIX),
    "post_fix": put(CACHE / "kline2_4h_ETHUSDT" / "2025-03.parquet", good, ts(2026, 10, 5)),
    "kline3": put(CACHE / "kline3_1h_BTCUSDT" / "2025-07.parquet", good, PRE_FIX),
    "other": put(CACHE / "funding_BTCUSDT" / "2025-07.parquet", good, PRE_FIX),
}
(CACHE / "kline2_4h_BTCUSDT").mkdir()
os.symlink(OUTSIDE, CACHE / "kline2_4h_BTCUSDT" / "2025-07.parquet")
os.symlink(OUTSIDE.parent, CACHE / "kline2_1d_LINKUSDT")
check(f["1m_full"].stat().st_size >= kc.BASE_STRAY_MAX_BYTES
      and kc.MARKER_MAX_BYTES < f["1m_tiny"].stat().st_size < kc.BASE_STRAY_MAX_BYTES
      and f["marker_1h"].stat().st_size <= kc.MARKER_MAX_BYTES,
      "fixture sizes sit on the intended side of both thresholds")

# lib that cannot use the touch, or no longer reads kline2: recorded, nothing scanned
real_heal = kc.heal
kc.heal = lambda *a, **k: (_ for _ in ()).throw(AssertionError("scanned"))
for src, want in (("PREFIX = 'kline3'\n_written_before_month_end\n", "kline3"),
                  ("PREFIX = 'kline2'\n", "pre_refetch"), (None, "missing")):
    reset_record()
    if src is None:
        LIB.unlink()
    else:
        LIB.write_text(src)
    r = kc.run(T0)
    check(r["outcome"] == "skipped" and r["lib"] == want and kc.run(T0 + 99999) == r,
          f"lib {want} → skipped once, never scanned: {r}")
kc.heal = real_heal

# stagger, then paced steps
LIB.write_text(LIB_KLINE2)
reset_record()
kc.random.uniform = lambda a, b: 500
kc.DIRS_PER_STEP = 4
w = kc.run(T0)
check(w["outcome"] == "waiting" and w["next_step_at"] == T0 + 500 and w["lib"] == "kline2",
      f"first tick only schedules: {w}")
check(kc.run(T0 + 499) == w and mt(d1h / "2025-06.parquet") == PRE_FIX, "nothing before the stagger ends")
steps = []
t = T0 + 500
for _ in range(10):
    r = kc.run(t)
    steps.append(r)
    if r["outcome"] != "waiting":
        break
    check(kc.run(r["next_step_at"] - 1) == r, f"no step before next_step_at (step {len(steps)})")
    t = r["next_step_at"]
rec = steps[-1]
gaps = [b["at"] - a["at"] for a, b in zip(steps, steps[1:])]
check(len(steps) == 3 and all(g >= kc.STEP_S for g in gaps),
      f"10 kline2 dirs at 4 per step → 3 steps, STEP_S apart: {[s['cursor'] for s in steps]} gaps {gaps}")
check(rec["outcome"] == "done" and rec["files"] == 5 and rec["dirs"] == 4 and rec["errors"] == 0
      and rec["started_at"] == T0 + 500, f"record {rec}")
check(mt(d1h / "2025-06.parquet") == ts(2025, 6) and mt(d1h / "2025-07.parquet") == ts(2025, 7),
      "1h past months set back to their month start")
check(mt(f["1m_tiny"]) == ts(2025, 8) and mt(f["5min_tiny"]) == ts(2025, 8),
      "near-empty base month (stray bar alone) flagged, 1m and 5min spelling alike")
check(mt(f["15m_full"]) == ts(2025, 7), "15m is not a base period: full month flagged")
for k in ("marker_1h", "1m_full", "1min_full", "5m_full", "5min_full", "base_marker", "current", "kline3", "other"):
    check(mt(f[k]) == PRE_FIX, f"{k} untouched")
check(mt(f["post_fix"]) == ts(2026, 10, 5), "post_fix untouched")
check(mt(OUTSIDE) == PRE_FIX, "symlinked file and symlinked dir: target outside the cache untouched")
check(kc.read_record() == rec, "record persisted")

kc.MARKER_MAX_BYTES, saved = -1, kc.MARKER_MAX_BYTES
real_heal(T0 + 10 ** 6, workspace=WS, limit=100)
kc.MARKER_MAX_BYTES = saved
LINK = CACHE / "kline2_4h_BTCUSDT" / "2025-07.parquet"
check(mt(OUTSIDE) == PRE_FIX and mt(LINK) != ts(2025, 7),
      "symlink skipped on its own (neither target nor link touched), not only because a link is smaller than a marker")

calls.clear()
after = d._extend_cache_monthly("kline2", P1H, raw(good), "2025-06-01", "2025-07-31")
check(after.loc[STRAY, "Close"] == 100.0 and after.loc[STRAY, "Volume"] == 100.0 and calls,
      f"lib's own completing re-fetch replaced the stray bar ({len(calls)} fetch)")
check(mt(d1h / "2025-07.parquet") > ts(2025, 8), "re-fetched month is complete again (mtime past month end)")
calls.clear()
d._extend_cache_monthly("kline2", P1H, raw(good), "2025-06-01", "2025-07-31")
check(not calls, "and is not re-fetched a second time")

kc.heal = lambda *a, **k: (_ for _ in ()).throw(AssertionError("heal ran twice"))
check(kc.run(T0 + 10 ** 7) == rec, "done → never runs again")
kc.heal = real_heal

# errors: whole pass repeated, a file lib re-fetched meanwhile is left alone, MAX_PASSES cap
reset_record()
kc.random.uniform = lambda a, b: 0
kc.DIRS_PER_STEP = 100
for p in d1h.glob("*.parquet"):
    os.utime(p, (PRE_FIX, PRE_FIX))
denied = str(d1h / "2025-06.parquet")
real_utime = kc.os.utime


def utime(path, *a, **k):
    if str(path) == denied:
        raise PermissionError(path)
    return real_utime(path, *a, **k)


kc.os.utime = utime
t = T0 + 1000
kc.run(t)
r1 = kc.run(t)
check(r1["outcome"] == "waiting" and r1["pass"] == 2 and r1["errors"] == 1,
      f"unwritable file counted, pass repeated: {r1}")
os.utime(d1h / "2025-07.parquet", (t + 5, t + 5))   # lib completed it after the heal started
r2 = kc.run(r1["next_step_at"])
check(mt(d1h / "2025-07.parquet") == t + 5, "retry pass leaves a month lib already re-fetched")
r3 = kc.run(r2["next_step_at"])
check(r3["outcome"] == "partial" and r3["pass"] == kc.MAX_PASSES and r3["errors"] == 3,
      f"stops after MAX_PASSES: {r3}")
check(kc.run(r3["next_step_at"] + 10 ** 6) == r3, "partial is final")
kc.os.utime = real_utime

# state dir that cannot be written: no heal at all, so no unbounded rescans
reset_record()
real_write = kc._write_record
kc._write_record = lambda rec: (_ for _ in ()).throw(OSError("read-only"))
kc.heal = lambda *a, **k: (_ for _ in ()).throw(AssertionError("healed without a record"))


def unwritable_run():
    try:
        kc.run(T0)
    except OSError:
        return "raised"
    except AssertionError:
        return "healed"
    return "returned"


check(unwritable_run() == "raised", "no record can be written → raises before any file is touched")
real_write({"at": T0, "lib": "kline2", "outcome": "waiting", "next_step_at": T0, "started_at": None,
            "pass": 1, "cursor": "", "dirs": 0, "files": 0, "errors": 0, "pass_errors": 0})
check(unwritable_run() == "raised", "step claim cannot be written → heal never called")
kc._write_record, kc.heal = real_write, real_heal

# cutoff = min(FIX_TS, started_at): whichever came first, a file written after it came from the fixed api.
# T0 is the wall clock, so the flow above only ever exercises one side of that min; pin both here.
check(kc.FIX_TS == calendar.timegm((2026, 10, 3, 8, 0, 0)),
      "FIX_TS = 2026-10-03 08:00 UTC (a day after the /kline fix reached prod; ship gate in runtime/CHANGELOG.md)")
cuts = []
kc.heal = lambda cutoff, *a, **k: cuts.append(cutoff) or (0, 0, 0, None)
for started in (kc.FIX_TS - 3600, kc.FIX_TS + 3600):
    reset_record()
    real_write({"at": started, "lib": "kline2", "outcome": "waiting", "next_step_at": started, "started_at": None,
                "pass": 1, "cursor": "", "dirs": 0, "files": 0, "errors": 0, "pass_errors": 0})
    kc.run(started)
check(cuts == [kc.FIX_TS - 3600, kc.FIX_TS], f"heal started before FIX_TS cuts at its start, after FIX_TS at FIX_TS: {cuts}")
kc.heal = real_heal

order = []
pr.PROXY_TOKEN = "t"
pr.build_report = lambda: {"config": {}}
pr.report = lambda p: order.append(("report", dict(p))) or '{"status": "ok"}'
pr._handle_ack = lambda resp: order.append(("ack",))
kc.run = lambda: order.append(("heal",)) or (_ for _ in ()).throw(RuntimeError("boom"))
pr.main()
check([o[0] for o in order] == ["report", "ack", "heal"], f"heal runs after the report and ack: {order}")
check(order[0][1].get("kline2_heal") == kc.read_record(), "record rides the report")

order.clear()
pr.report = lambda p: (_ for _ in ()).throw(OSError("down"))
try:
    pr.main()
except SystemExit:
    pass
check(not order, "failed report → no heal this tick")

print("FAILED" if fails else "ALL OK", fails)
sys.exit(1 if fails else 0)
