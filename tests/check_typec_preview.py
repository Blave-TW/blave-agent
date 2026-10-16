"""Minimal check: a Type C backtest leaves a preview of its last row, and nothing trades on it.

lib/runner writes strategies/<name>/backtest_state.json (typec_live_state of the last row +
code_hash) only when a live tick would compute that same row (lib.bar_ready.computes_now, every
case in tests/check_typec_preview_parity.py) and align_feed cut nothing off the fetch's tail;
otherwise it writes none and removes an older one. runtime/portfolio_reporter.typec_previews forwards it for a picked strategy with no
live weights, only while code_hash is the current strategy.py's. wait_for_bar never reads it:
a tick still probes and never writes state.json from it. Also pins the timeout constants the
workspace and the runtime keep in step, and the run budget left after a slow probe.

Run: cd blave-agent && MPLBACKEND=Agg .venv/bin/python tests/check_typec_preview.py
"""
import contextlib
import importlib.util
import io
import json
import os
import re
import sys
import tempfile
import time
import types
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WS = Path(tempfile.mkdtemp(prefix="typec-preview-", dir=os.environ.get("SCRATCHPAD") or None))
os.environ["BLAVE_AGENT_WORKSPACE"] = str(WS)
os.environ["BLAVE_AGENT_BASE"] = str(WS)
os.environ.setdefault("MPLBACKEND", "Agg")
sys.path.insert(0, ROOT)
sys.path.insert(0, os.path.join(ROOT, "runtime"))

import dotenv
dotenv.dotenv_values = lambda *a, **k: {}   # never read the workspace .env

import numpy as np
import pandas as pd

import lib.data as data
import lib.runner as runner
from lib.strategy import code_hash

runner.dotenv_values = lambda *a, **k: {}

fails = 0


def check(cond, msg):
    global fails
    print(("  PASS  " if cond else "  FAIL  ") + msg)
    fails += (not cond)


os.chdir(WS)
runner._REPO_ROOT = WS
os.environ["BLAVE_MODE"] = "backtest"

rng = np.random.default_rng(5)
IDX = pd.bdate_range("2024-01-01", periods=260)
CLOSE = pd.DataFrame(100 * np.exp(np.cumsum(rng.normal(0.0003, 0.012, (260, 4)), axis=0)),
                     index=IDX, columns=["1101", "2330", "2454", "3008"])
OPEN = CLOSE.shift(1).fillna(CLOSE.iloc[0])
SDIR = WS / "strategies" / "pf"
SDIR.mkdir(parents=True)
SRC = SDIR / "strategy.py"
SRC.write_text('INTERVAL = "1d"\nMARKET = "spot"\n# basket\n')
PREVIEW = SDIR / runner.BACKTEST_STATE_FILE
CONFIG = {"STRATEGY_NAME": "pf", "INTERVAL": "1d", "START": "2024-01-01", "FEE": 0.003, "WARMUP": 20,
          "MARKET": "spot", "__file__": str(SRC)}


def compute(d):
    c, o = d
    mom = c.pct_change(20, fill_method=None)
    rank = mom.rank(axis=1, ascending=False, method="first", na_option="bottom")
    w = pd.DataFrame(np.where((rank <= 2) & mom.notna(), 0.5, 0.0), index=c.index, columns=c.columns)
    s = pd.Series(c.index.to_period("W"), index=c.index)
    w[~(s != s.shift(1)).to_numpy()] = np.nan
    return w.ffill().fillna(0.0).values, pd.concat({"close": c, "open": o}, axis=1)


def backtest(fetch):
    with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
        runner.run(dict(CONFIG), fetch, compute)
    return json.loads(PREVIEW.read_text()) if PREVIEW.exists() else None


pv = backtest(lambda h: (CLOSE.copy(), OPEN.copy()))
w, pdf = compute((CLOSE, OPEN))
want = runner.typec_live_state(w[20:], pdf.iloc[20:], market="spot")
check(pv is not None and pv["weights"] == want["weights"] and pv["bar_at"] == want["bar_at"]
      and pv["rebalance_at"] == want["rebalance_at"],
      "complete data: the preview is the live tick's target for the last row")
check(pv is not None and pv.get("code_hash") == code_hash(SRC.read_bytes()), "…stamped with the file's code_hash")
check(not (SDIR / "state.json").exists(), "a backtest never writes state.json")

never = CLOSE.copy()
never["3008"] = np.nan   # a tick would never compute on this (tests/check_typec_preview_parity.py has every case)
check(backtest(lambda h: (never, OPEN.copy())) is None,
      "the scheduler would not compute on this data: no preview, and the older one is removed")

backtest(lambda h: (CLOSE.copy(), OPEN.copy()))


def trimmed(h):
    if data._feed_trims is not None:   # what align_feed records when it cuts the tail
        data._feed_trims.append(IDX[-1])
    return CLOSE.iloc[:-1].copy(), OPEN.iloc[:-1].copy()


check(backtest(trimmed) is None, "align_feed cut the fetch's tail: no preview")
check(data._feed_trims is None, "…the trim recorder is switched off after the fetch")
pv = backtest(lambda h: (CLOSE.copy(), OPEN.copy()))

# ── the reporter forwards it while the code matches, and only for a picked strategy without live weights
import portfolio_reporter as pr  # noqa: E402

check(pr._code_hash(b"x = 1\n") == code_hash(b"x = 1\n"), "runtime hash = lib.strategy.code_hash")
cfg = {"amounts": {"pf": 1000000.0}}
# report clock: the bar after the preview's has not closed yet (crypto-style UTC daily labels)
NOW_PV = datetime(1970, 1, 1) + timedelta(seconds=pv["bar_at"], days=1, hours=9)
got = pr.typec_previews(cfg, pr.strategy_states(), now=NOW_PV).get("pf")
check(got is not None and got["weights"] == pr._portfolio_weights(pv["weights"]) and got["bar_at"] == pv["bar_at"]
      and got["market"] == "spot" and "code_hash" not in got,
      f"picked, no state.json, hash matches: previewed ({got})")
check(got is not None and got.get("bar_date") == datetime.fromtimestamp(pv["bar_at"], timezone.utc).strftime("%Y-%m-%d"),
      f"no Taiwan price fetcher: bar_date is the UTC date of bar_at ({got and got.get('bar_date')})")
check(pr.typec_previews({"amounts": {}}, {}) == {}, "not picked: no preview")

# the trading date of a Taiwan bar, both label conventions lib.data uses, vs crypto and mixed
for label, idx in (("batch daily prices (UTC-midnight date labels)", pd.date_range(end="2026-10-14", periods=3, freq="D")),
                   ("fetch_twstock_ohlcv 1d (Asia/Taipei midnight = 16:00 UTC the day before)",
                    pd.date_range(end="2026-10-14", periods=3, freq="D", tz="Asia/Taipei"))):
    c = pd.DataFrame(1.0, index=idx, columns=["2330", "2454"])
    b_at = runner.typec_live_state(np.full((3, 2), 0.5), pd.concat({"close": c, "open": c}, axis=1))["bar_at"]
    check(pr._bar_date(b_at, {"tw_stock"}) == "2026-10-14" and pr._bar_date(b_at, {"tw_futures"}) == "2026-10-14",
          f"Taiwan, {label}: bar_date = the trading date 2026-10-14 (UTC date would be "
          f"{datetime.fromtimestamp(b_at, timezone.utc):%Y-%m-%d})")
utc_late = int(datetime(2026, 10, 14, 20, 0, tzinfo=timezone.utc).timestamp())   # 04:00 the next day in Taipei
check(pr._bar_date(utc_late, {"crypto"}) == "2026-10-14" and pr._bar_date(utc_late, {"crypto", "tw_stock"}) == "2026-10-14"
      and pr._bar_date(utc_late, set()) == "2026-10-14",
      "crypto, mixed markets and unknown: UTC date")
SRC.write_text('INTERVAL = "1d"\nMARKET = "spot"\nfrom lib.data import fetch_twstock_price_adj_batch\n# basket\n')
PREVIEW.write_text(json.dumps(dict(pv, code_hash=code_hash(SRC.read_bytes()), bar_at=b_at)))
tw = pr.typec_previews(cfg, pr.strategy_states(), now=datetime(2026, 10, 14, 6, 0)).get("pf") or {}   # 14:00 Taipei
check(tw.get("bar_date") == "2026-10-14", f"a Taiwan strategy's preview carries the Taiwan trading date ({tw.get('bar_date')})")
# ── only while it is the newest closed bar, judged at report time (Wei 10-16) ─────────────
TWSRC = 'INTERVAL = "1d"\nMARKET = "spot"\nfrom lib.data import fetch_twstock_price_adj_batch\n# basket\n'


def tw_preview(trading_date, label_tz=None):
    """The preview a Taiwan backtest leaves whose last bar is `trading_date`, labelled the
    batch-price way (UTC midnight) or the fetch_twstock_ohlcv way (Asia/Taipei)."""
    ts = pd.Timestamp(trading_date, tz=label_tz) if label_tz else pd.Timestamp(trading_date)
    SRC.write_text(TWSRC)
    PREVIEW.write_text(json.dumps(dict(pv, code_hash=code_hash(SRC.read_bytes()), bar_at=int(ts.timestamp()))))


def shown(now):
    return "pf" in pr.typec_previews(cfg, pr.strategy_states(), now=now)


def tpe(y, mo, d, h, mi=0):
    return datetime(y, mo, d, h, mi) - timedelta(hours=8)   # Taipei wall clock → naive UTC


for tz in (None, "Asia/Taipei"):
    lab = "Asia/Taipei labels" if tz else "UTC-midnight labels"
    tw_preview("2026-10-14", tz)                                             # Wednesday
    check(shown(tpe(2026, 10, 14, 17, 30)) and shown(tpe(2026, 10, 15, 9, 0)),
          f"Taiwan ({lab}): Wed's bar is shown Wed evening and Thu morning before the close (still the newest)")
    check(not shown(tpe(2026, 10, 15, 17, 30)),
          f"Taiwan ({lab}): backtest run yesterday — Thu after the close Wed's bar is stale: no preview")
    tw_preview("2026-10-13", tz)                                             # an in-session Wed backtest ends on Tue
    check(shown(tpe(2026, 10, 14, 11, 0)) and not shown(tpe(2026, 10, 14, 17, 30)),
          f"Taiwan ({lab}): backtest during Wed's session (last bar Tue) — fine at 11:00, gone once Wed has closed")
    tw_preview("2026-10-16", tz)                                             # Friday
    check(shown(tpe(2026, 10, 17, 12, 0)) and shown(tpe(2026, 10, 19, 9, 0)) and not shown(tpe(2026, 10, 19, 14, 0)),
          f"Taiwan ({lab}): across the weekend — Fri's bar holds Sat and Mon morning, gone after Mon's close")
SRC.write_text('INTERVAL = "1d"\nMARKET = "spot"\n# basket\n')
PREVIEW.write_text(json.dumps(pv))
bar = datetime(1970, 1, 1) + timedelta(seconds=pv["bar_at"])
check(shown(bar + timedelta(days=1, hours=1)) and not shown(bar + timedelta(days=2, hours=1))
      and not shown(bar + timedelta(hours=12)),
      "crypto-style daily: shown while its bar is the newest closed one, gone a bar later (a backtest run yesterday)")
import lib.bar_ready as br  # noqa: E402
check(all(pr._expected_closed_bar_open(br.interval_to_timedelta(iv), n) == br.expected_closed_bar_open(iv, n)
          for iv in ("15m", "4h", "1d", "1w") for n in (datetime(2026, 10, 16, 9, 26), datetime(2026, 10, 16, 0, 0))),
      "runtime copy of expected_closed_bar_open = lib/bar_ready's")
SRC.write_text('INTERVAL = "1d"\n# basket, edited\n')
check(pr.typec_previews(cfg, pr.strategy_states(), now=NOW_PV) == {}, "strategy.py changed since the backtest: no preview")
SRC.write_text('INTERVAL = "1d"\nMARKET = "spot"\n# basket\n')
SRC.write_text('INTERVAL = "1d"\nMARKET = "spot"\nfrom lib.data import fetch_usstock_price\n# basket\n')
pv_us = dict(pv, code_hash=code_hash(SRC.read_bytes()))
PREVIEW.write_text(json.dumps(pv_us))
check(pr.typec_previews(cfg, pr.strategy_states(), now=NOW_PV) == {}, "US-stock prices (live refuses them): no preview")
SRC.write_text('INTERVAL = "1d"\nMARKET = "spot"\n# basket\n')
PREVIEW.write_text(json.dumps(pv))
(SDIR / "state.json").write_text(json.dumps({"type": "portfolio", "weights": {"2330": 0.0}, "rebalance_at": 1}))
check(pr.typec_previews(cfg, pr.strategy_states(), now=NOW_PV) == {},
      "live state.json present (even all-zero weights): the live row wins, no preview")
(SDIR / "state.json").unlink()
check("previews" in pr.build_report(), "build_report carries `previews`")

# ── wait_for_bar never reads it
spec = importlib.util.spec_from_file_location("wfb", os.path.join(ROOT, "manager", "wait_for_bar.py"))
wfb = importlib.util.module_from_spec(spec)
spec.loader.exec_module(wfb)
probed = []
wfb._check_freshness = lambda mod, expected: probed.append(1) or (None, False, None, None)
wfb._run_strategy_protected = lambda name: (_ for _ in ()).throw(AssertionError("ran"))
wfb._load_strategy_module = lambda name: types.SimpleNamespace(INTERVAL="1d")
with contextlib.redirect_stdout(io.StringIO()):
    wfb._tick("pf")
st = json.loads((WS / "state" / "bar_wait" / "pf.json").read_text())
check(probed and not (SDIR / "state.json").exists() and not st.get("last_processed_bar"),
      "a tick with a preview on disk still probes, writes no state.json, processes no bar")

# ── timeouts the two update channels keep in step; the run gets what the probe left
cl_src = open(os.path.join(ROOT, "runtime", "command_listener.py"), encoding="utf-8").read()
n = lambda pat: int(re.search(pat, cl_src, re.M).group(1))
check(n(r"^STATS_REFRESH_TIMEOUT_S = (\d+)") == wfb.RUN_TIMEOUT_SECONDS == 1200,
      "runtime STATS_REFRESH_TIMEOUT_S = wait_for_bar RUN_TIMEOUT_SECONDS = 1200")
check(n(r"^SCHEDULER_TICK_TIMEOUT_SECONDS = (\d+)") == wfb.TICK_BUDGET_SECONDS,
      "wait_for_bar TICK_BUDGET_SECONDS = the scheduler's tick timeout")
spec2 = importlib.util.spec_from_file_location("wfb2", os.path.join(ROOT, "manager", "wait_for_bar.py"))
wfb2 = importlib.util.module_from_spec(spec2)
spec2.loader.exec_module(wfb2)
alerts = []
wfb2._alert_failure = lambda: types.SimpleNamespace(alert=lambda *a: alerts.append(a))
wfb2._STARTED = time.monotonic() - (wfb2.TICK_BUDGET_SECONDS - 30)
check(wfb2._run_strategy_protected("pf") is False and alerts and "not started" in alerts[0][2],
      "a probe that used the tick budget: the run is not started (alerted), never SIGKILLed mid-run")

print("all checks passed" if not fails else f"FAILED: {fails}")
sys.exit(1 if fails else 0)
