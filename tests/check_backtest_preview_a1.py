"""Minimal check for the save dialog's previews (spec tw-holdings-a1 B1–B3).

lib/runner: a Type A backtest writes strategies/<name>/backtest_state.json — the position the
scheduler would write from the last bar (before clamp_spot), that bar's label and close, and
code_hash — and removes an older one when the scheduler would not compute that bar yet. A
Type C preview carries `closes` (the last row's close per held symbol).
runtime/portfolio_reporter.backtest_previews: unpicked strategies (drafts) are included, a
picked one with a state.json is not, code_hash must match, `latest` says whether the bar is
still the newest closed one (US daily on the New York close), and at most PREVIEW_EXTRA_MAX
drafts ride along.

Run: cd blave-agent && MPLBACKEND=Agg .venv/bin/python tests/check_backtest_preview_a1.py
"""
import contextlib
import io
import json
import shutil
import os
import sys
import tempfile
import time
from datetime import datetime, timedelta
from pathlib import Path

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WS = Path(tempfile.mkdtemp(prefix="a1-preview-", dir=os.environ.get("SCRATCHPAD") or None))
os.environ["BLAVE_AGENT_WORKSPACE"] = str(WS)
os.environ["BLAVE_AGENT_BASE"] = str(WS)
os.environ.setdefault("MPLBACKEND", "Agg")
sys.path.insert(0, ROOT)
sys.path.insert(0, os.path.join(ROOT, "runtime"))

import dotenv
dotenv.dotenv_values = lambda *a, **k: {}

import numpy as np
import pandas as pd

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

rng = np.random.default_rng(7)
IDX = pd.date_range("2025-01-01", periods=200, freq="D")
px = 100 * np.exp(np.cumsum(rng.normal(0, 0.02, 200)))
DF = pd.DataFrame({"Open": px, "High": px * 1.01, "Low": px * 0.99, "Close": px, "Volume": 1.0}, index=IDX)
# the bar after the last one has not closed: the scheduler computes on DF's last row
runner._utcnow = lambda: (IDX[-1] + pd.Timedelta(days=1, hours=3)).to_pydatetime()


def strat(name, src, market="spot"):
    d = WS / "strategies" / name
    d.mkdir(parents=True, exist_ok=True)
    (d / "strategy.py").write_text(src)
    return d, {"STRATEGY_NAME": name, "SYMBOL": "BTCUSDT", "INTERVAL": "1d", "START": "2025-01-01",
               "FEE": 0.0005, "MCPT": False, "MARKET": market, "__file__": str(d / "strategy.py")}


def signals(df):
    s = pd.Series(np.where(df["Close"] > df["Close"].rolling(10).mean(), 1.0, np.nan), index=df.index)
    # by date, not position (a position-based tail would be look-ahead): short on the second-last bar, then held
    s[s.index == IDX[-2]] = -0.5
    s[s.index == IDX[-1]] = np.nan
    return s


def run(cfg, fetch, compute):
    with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
        runner.run(dict(cfg), fetch, compute)


SDIR, CFG = strat("ta", 'INTERVAL = "1d"\nMARKET = "spot"\n# Type A\n')
run(CFG, lambda h: DF.copy(), signals)
pv = json.loads((SDIR / runner.BACKTEST_STATE_FILE).read_text()) if (SDIR / runner.BACKTEST_STATE_FILE).exists() else None
check(pv is not None and pv["type"] == "signal" and pv["symbol"] == "BTCUSDT" and pv["market"] == "spot",
      f"Type A backtest writes a signal preview ({pv and {k: pv[k] for k in ('type', 'symbol', 'market')}})")
check(pv is not None and pv["position"] == -0.5,
      "…the last signal held by ffill, before clamp_spot (lib/portfolio clamps the net spot target)")
check(pv is not None and pv["close"] == float(DF["Close"].iloc[-1]) and pv["bar_at"] == int(IDX[-1].timestamp()),
      "…with the last bar's close and label (B3: shares = amount / close)")
check(pv is not None and pv["code_hash"] == code_hash((SDIR / "strategy.py").read_bytes()), "…stamped with code_hash")

# a minute after the close, the newest bar not in yet: inside the grace the scheduler waits for it
clock = runner._utcnow
runner._utcnow = lambda: (IDX[-1] + pd.Timedelta(days=1, minutes=1)).to_pydatetime()
run(CFG, lambda h: DF.iloc[:-1].copy(), signals)
kept = json.loads((SDIR / runner.BACKTEST_STATE_FILE).read_text()) if (SDIR / runner.BACKTEST_STATE_FILE).exists() else None
check(kept == pv, "data not computable yet: no new preview, the older one of the same code stays (the dialog still prices from it)")
(SDIR / runner.BACKTEST_STATE_FILE).write_text(json.dumps(dict(pv, code_hash="0" * 16)))
run(CFG, lambda h: DF.iloc[:-1].copy(), signals)
check(not (SDIR / runner.BACKTEST_STATE_FILE).exists(), "…an older one of other code is removed")
runner._utcnow = clock
run(CFG, lambda h: DF.copy(), signals)

# ── Type C carries closes for held symbols
CDIR, CCFG = strat("tc", 'INTERVAL = "1d"\nMARKET = "spot"\n# basket\n')
CL = pd.DataFrame({"AAAUSDT": px, "BBBUSDT": px[::-1].copy(), "CCCUSDT": px * 2}, index=IDX)


def basket(d):
    c, o = d
    w = np.zeros(c.shape)
    w[:, 0], w[:, 1] = 0.5, 0.5
    return w, pd.concat({"close": c, "open": o}, axis=1)


run(dict(CCFG, SYMBOL=None), lambda h: (CL.copy(), CL.copy()), basket)
cpv = json.loads((CDIR / runner.BACKTEST_STATE_FILE).read_text())
check(cpv["type"] == "portfolio" and cpv["market"] == "spot" and cpv["weights"] == {"AAAUSDT": 0.5, "BBBUSDT": 0.5, "CCCUSDT": 0.0}
      and cpv["bar_at"] == int(IDX[-1].timestamp()) and cpv["rebalance_at"] == int(IDX[0].timestamp()),
      "Type C preview keeps the 0.1.26 shape: last row's weights, its bar, the first bar of the unchanged run")
check(cpv.get("closes") == {"AAAUSDT": float(CL["AAAUSDT"].iloc[-1]), "BBBUSDT": float(CL["BBBUSDT"].iloc[-1])},
      f"Type C preview: closes of the held symbols only ({cpv.get('closes')})")

# ── the reporter
import portfolio_reporter as pr  # noqa: E402

NOW = runner._utcnow()
got = pr.backtest_previews({"amounts": {}}, pr.strategy_states(), now=NOW)
a, c = got.get("ta"), got.get("tc")
check(a is not None and a["type"] == "signal" and a["position"] == -0.5 and a["close"] == pv["close"] and a["latest"] is True,
      f"unpicked (draft) Type A previewed, latest ({a})")
check(c is not None and c["weights"] == {"AAAUSDT": 0.5, "BBBUSDT": 0.5} and set(c["closes"]) == {"AAAUSDT", "BBBUSDT"},
      f"unpicked Type C previewed with closes ({c and c.get('closes')})")
check(a is not None and a["daily_tw"] is False and a["daily_us"] is False and "code_hash" not in a,
      "crypto daily: daily_tw / daily_us false; code_hash not forwarded")
later = pr.backtest_previews({"amounts": {}}, pr.strategy_states(), now=NOW + timedelta(days=3)).get("ta")
check(later is not None and later["latest"] is False, "a newer bar has closed since: still forwarded, latest false")

(SDIR / "state.json").write_text(json.dumps({"symbol": "BTCUSDT", "position": 1.0}))
check("ta" not in pr.backtest_previews({"amounts": {"ta": 100.0}}, pr.strategy_states(), now=NOW),
      "picked and already has a state.json: no preview (the scheduler's signal is used)")
check("ta" in pr.backtest_previews({"amounts": {}}, pr.strategy_states(), now=NOW),
      "unpicked with an old state.json: still previewed (the scheduler is not computing it)")
(SDIR / "state.json").unlink()

(SDIR / "strategy.py").write_text('INTERVAL = "1d"\nMARKET = "spot"\n# edited\n')
check("ta" not in pr.backtest_previews({"amounts": {}}, pr.strategy_states(), now=NOW), "strategy.py changed since the backtest: none")

# ── Taiwan stocks: the preview carries the unadjusted close (the save dialog's share count) —
# the strategy's own close is adjusted, anchored at its fetch window's start
day = pd.Timestamp(IDX[-1]).strftime("%Y-%m-%d")
(WS / "twfake.py").write_text(f"""
import pandas as pd
def batch(codes, start, end, hdrs):
    return {{c: pd.DataFrame({{"Close": [111.0, 222.0, 999.0]}}, index=pd.to_datetime(["2025-07-01", "{day}", "2099-01-01"])) for c in codes}}
""")
fetch0, runner.TW_CLOSE_FETCH = runner.TW_CLOSE_FETCH, "twfake:batch"
TDIR, TCFG = strat("twa", 'INTERVAL = "1d"\nMARKET = "spot"\n# Type A TW\n')
run(dict(TCFG, SYMBOL="2330"), lambda h: DF.copy(), signals)
tpv = json.loads((TDIR / runner.BACKTEST_STATE_FILE).read_text())
check(tpv.get("raw_closes") == {"2330": 222.0} and tpv["close"] == float(DF["Close"].iloc[-1]),
      f"Taiwan Type A preview: raw_closes = the unadjusted close of its bar's date, close stays the strategy's ({tpv.get('raw_closes')})")
got = pr.backtest_previews({"amounts": {}}, pr.strategy_states(), now=NOW).get("twa")
check(got is not None and got.get("raw_closes") == {"2330": 222.0}, f"…forwarded by the reporter ({got and got.get('raw_closes')})")
check("raw_closes" not in (a or {}), "crypto previews carry no raw_closes (no lookup)")
runner.TW_CLOSE_FETCH = "twfake:nope"
run(dict(TCFG, SYMBOL="2330"), lambda h: DF.copy(), signals)
check("raw_closes" not in json.loads((TDIR / runner.BACKTEST_STATE_FILE).read_text()), "lookup failed: the preview is written without it")
runner.TW_CLOSE_FETCH = fetch0
shutil.rmtree(TDIR)

for i in range(pr.PREVIEW_EXTRA_MAX + 2):
    d = WS / "strategies" / f"x{i}"
    d.mkdir()
    (d / "strategy.py").write_text('INTERVAL = "1d"\n')
    (d / runner.BACKTEST_STATE_FILE).write_text(json.dumps(dict(cpv, code_hash=code_hash(b'INTERVAL = "1d"\n'))))
    os.utime(d / runner.BACKTEST_STATE_FILE, (time.time() + 10 + i, time.time() + 10 + i))
drafts = [n for n in pr.backtest_previews({"amounts": {}}, pr.strategy_states(), now=NOW) if n.startswith("x")]
check(sorted(drafts) == sorted(f"x{i}" for i in range(2, pr.PREVIEW_EXTRA_MAX + 2)),
      f"at most PREVIEW_EXTRA_MAX drafts, newest files first ({sorted(drafts)})")

# the newest file's code no longer matches: it must not take a draft's slot (x1 moves back in)
(WS / "strategies" / f"x{pr.PREVIEW_EXTRA_MAX + 1}" / "strategy.py").write_text('INTERVAL = "1d"\n# edited\n')
drafts = [n for n in pr.backtest_previews({"amounts": {}}, pr.strategy_states(), now=NOW) if n.startswith("x")]
check(sorted(drafts) == sorted(f"x{i}" for i in range(1, pr.PREVIEW_EXTRA_MAX + 1)),
      f"a file with a changed code_hash does not use up a draft slot ({sorted(drafts)})")

# ── US daily signal on a stock perp (NVDA prices, NVDAUSDT traded): previewed, `latest` on the
# New York calendar (final at 17:00 NY), so the save dialog stops waiting for one
US_SRC = ('SYMBOL = "NVDAUSDT"\nMARKET = "swap"\nINTERVAL = "1d"\n\n\ndef fetch_data(hdrs):\n'
          '    from lib.data import fetch_usstock_price\n'
          '    return fetch_usstock_price("NVDA", "2024-01-01", None, hdrs)\n')


def us_draft(name, src, bar_day):
    d = WS / "strategies" / name
    d.mkdir(parents=True, exist_ok=True)
    (d / "strategy.py").write_text(src)
    (d / runner.BACKTEST_STATE_FILE).write_text(json.dumps({
        "type": "signal", "symbol": "NVDAUSDT", "market": "swap", "position": 1.0, "close": 216.47,
        "bar_at": int(pd.Timestamp(bar_day).timestamp()), "code_hash": code_hash(src.encode())}))


def us_pv(name, now):
    return pr.backtest_previews({"amounts": {name: 1000.0}}, pr.strategy_states(), now=now).get(name)


us_draft("us_tue", US_SRC, "2026-10-20")
for now, want, why in ((datetime(2026, 10, 20, 22, 30), True, "Tue 18:30 NY: Tue's bar is final"),
                       (datetime(2026, 10, 21, 20, 0), True, "Wed 16:00 NY: Wed's not final yet, Tue's is latest"),
                       (datetime(2026, 10, 21, 21, 30), False, "Wed 17:30 NY: Wed's is final, Tue's stale")):
    got = us_pv("us_tue", now)
    check(got is not None and got["latest"] is want and got["symbol"] == "NVDAUSDT" and got["close"] == 216.47
          and got["daily_tw"] is False and got["daily_us"] is True and got["bar_date"] == "2026-10-20",
          f"US daily preview, {why} ({got and got.get('latest')})")
us_draft("us_fri", US_SRC, "2026-11-06")
for now, why in ((datetime(2026, 11, 8, 12, 0), "Sunday"), (datetime(2026, 11, 9, 15, 0), "Monday before the close"),
                 (datetime(2026, 11, 9, 21, 30), "Mon 16:30 EST (21:30 UTC is past 17:00 only in summer)")):
    got = us_pv("us_fri", now)
    check(got is not None and got["latest"] is True, f"Friday's bar still latest: {why} ({got and got.get('latest')})")
# the copy agrees with the scheduler's bar on non-holiday days (summer, winter, either side of 17:00 NY)
from manager import wait_for_bar as wfb  # noqa: E402
nows = [datetime(2026, 10, 19, 0, 0) + timedelta(minutes=37 * k) for k in range(400)] + \
       [datetime(2026, 11, 2, 0, 0) + timedelta(minutes=37 * k) for k in range(400)]
bad = [n for n in nows if pr._us_latest_closed_date(n) != wfb._us_expected(n).strftime("%Y-%m-%d")]
check(not bad, f"_us_latest_closed_date = wait_for_bar._us_expected off holidays ({bad[:3]})")
us_draft("us_mix", US_SRC.replace("from lib.data import fetch_usstock_price",
                                  "from lib.data import fetch_usstock_price, fetch_kline"), "2026-10-20")
check(us_pv("us_mix", datetime(2026, 10, 20, 22, 30)) is None, "US prices next to crypto ones: no preview (no live path)")
us_draft("us_4h", US_SRC.replace('INTERVAL = "1d"', 'INTERVAL = "4h"'), "2026-10-20")
check(us_pv("us_4h", datetime(2026, 10, 20, 22, 30)) is None, "US prices, not daily: no preview")

print("all checks passed" if not fails else f"FAILED: {fails}")
sys.exit(1 if fails else 0)
