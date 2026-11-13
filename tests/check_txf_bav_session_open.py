"""Minimal check: TXF 1m bars (stamped at their CLOSE minute) joined to the bid/ask feed (stamped
at its OPEN minute) through align_feed, at the session boundaries and on a live tick.

  - backtest: bar T carries the bid/ask row of T − 1m, also the first bar of a session (08:46 ←
    08:45, 15:01 ← 15:00); a minute-END day of the store (first row 08:46, rows stamped like the
    bars) keeps what it had: 08:46 carries the 05:00 row
  - live: 08:46 / 15:01 with their own row in compute on it, no raise; with it not in yet the
    refusal names that row (08:45 due 08:46:30), never the 05:00 / 13:45 row no session has
    (11-11: due 05:01:30 → a 224-minute bar_stale at 08:46:09, then target_stale), nor a 13:45
    row some days carry
  - every other calendar 'bars' feed (the Blave alphas, bars stamped at their open) still waits
    for its own bucket after a missing bar
  - wait_for_bar at 08:46:09 / 15:01:09: not ready, no bar_stale, no data_missing_at
  - wait_for_bar at 09:28:12 with a real strategy.py child: the check saw the 09:27 bar, the run
    re-fetched the 09:28 one whose 09:27 row is due 09:28:30 → not ready like the check's own
    refusal: no strategy_failed, no last_attempt_failed_at; any other failed run still alerts, so
    does a killed run (signal / timeout) and one whose feed-wait file is older than its launch
  - the feed stops for good (check-side or run-side): ONE bar_stale 15 minutes after the first
    missing row's due, data_missing_at written, target_stale holds; a computed signal ends it
  - lib/portfolio target_stale: a TXF 1m target written at the night's last bar is not stale at
    the 08:46 open (only session time counts); a crypto one keeps wall-clock age

Run: cd blave-agent && MPLBACKEND=Agg .venv/bin/python tests/check_txf_bav_session_open.py
"""
import contextlib
import importlib.util
import io
import json
import os
import shutil
import sys
import tempfile
import time
import types
from datetime import datetime, timedelta

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
os.environ.setdefault("MPLBACKEND", "Agg")

import dotenv
dotenv.dotenv_values = lambda *a, **k: {}   # never read the workspace .env

import numpy as np
import pandas as pd

import lib.data as D

fails = 0


def check(cond, msg):
    global fails
    print(("  PASS  " if cond else "  FAIL  ") + msg)
    fails += (not cond)


TPE = "Asia/Taipei"
SRC = "twfutures_bid_ask_vol"


def utc(stamps):
    """'HH:MM' Taipei on 'YYYY-MM-DD' → naive UTC index, like the fetchers return."""
    return pd.DatetimeIndex([pd.Timestamp(s, tz=TPE) for s in stamps]).tz_convert("UTC").tz_localize(None)


def frame(stamps, seed):
    rng = np.random.default_rng(seed)
    v = rng.integers(1, 500, (len(stamps), 2))
    return pd.DataFrame({"bid_vol": v[:, 0], "ask_vol": v[:, 1], "total_vol": v.sum(axis=1)}, index=utc(stamps))


def bars(stamps):
    return pd.DataFrame({"Close": 1.0}, index=utc(stamps))


def minutes(day, a, b):
    t, out = pd.Timestamp(f"{day} {a}"), []
    while t <= pd.Timestamp(f"{day} {b}"):
        out.append(t.strftime("%Y-%m-%d %H:%M"))
        t += pd.Timedelta(minutes=1)
    return out


def tpe(ts):
    return pd.Timestamp(ts).tz_convert(TPE).strftime("%H:%M:%S")


# 11-10 night → 11-11 day and 11-11 day → 11-11 night, Blave's stamps (measured 11-11): bars to
# 05:00 / from 08:46, to 13:45 / from 15:01; bid/ask to 04:59 / from 08:45, to 13:44 / from 15:00
B_NIGHT = minutes("2026-11-11", "04:55", "05:00") + minutes("2026-11-11", "08:46", "08:50")
F_NIGHT = minutes("2026-11-11", "04:54", "04:59") + minutes("2026-11-11", "08:45", "08:49")
B_DAY = minutes("2026-11-11", "13:40", "13:45") + minutes("2026-11-11", "15:01", "15:05")
F_DAY = minutes("2026-11-11", "13:39", "13:44") + minutes("2026-11-11", "15:00", "15:04")
BAV = pd.concat([frame(F_NIGHT, 1), frame(F_DAY, 2)])
BARS = pd.concat([bars(B_NIGHT), bars(B_DAY)])
COLS = ["bid_vol", "ask_vol", "total_vol"]

# ── backtest: every bar pairs with its own minute ─────────────────────────────────────
got = D.align_feed(BARS, BAV, SRC, "1m", bar_tz="UTC")
own = BAV.reindex(BARS.index - pd.Timedelta(minutes=1))[COLS].to_numpy()
check(len(got) == len(BARS) and np.array_equal(got[COLS].to_numpy(), own),
      "backtest: bar T carries the row of T − 1m everywhere, 08:46 ← 08:45 and 15:01 ← 15:00 included")


def live(b_to, f_to, f_drop=()):
    b = BARS[BARS.index <= utc([b_to])[0]]
    f = BAV[(BAV.index <= utc([f_to])[0]) & ~BAV.index.isin(utc(f_drop) if f_drop else [])]
    try:
        with D.live_feeds():
            return D.align_feed(b, f, SRC, "1m", bar_tz="UTC"), None
    except D.FeedNotPublished as e:
        return None, e


for open_bar, own_row, prev_bar in (("08:46", "08:45", "05:00"), ("15:01", "15:00", "13:45")):
    d = "2026-11-11"
    out, err = live(f"{d} {open_bar}", f"{d} {own_row}")
    check(err is None and (out[COLS].iloc[-1].to_numpy() == BAV.loc[utc([f"{d} {own_row}"])[0], COLS].to_numpy()).all(),
          f"live {open_bar} with the {own_row} row in: no refusal, computes on {own_row}")
    before = (pd.Timestamp(f"{d} {own_row}") - pd.Timedelta(minutes=1)).strftime("%Y-%m-%d %H:%M")
    out, err = live(f"{d} {open_bar}", f"{d} {own_row}", f_drop=[f"{d} {own_row}"])
    check(err is not None and tpe(err.need) == f"{own_row}:00"
          and tpe(err.due_at) == (pd.Timestamp(f"{d} {own_row}") + pd.Timedelta(seconds=90)).strftime("%H:%M:%S"),
          f"live {open_bar} with the {own_row} row not in yet: refused for {own_row} due 30 s after "
          f"the bar's close, not for {prev_bar} (got {err and tpe(err.need)} due {err and tpe(err.due_at)})")

out, err = live("2026-11-11 08:48", "2026-11-11 08:47", f_drop=["2026-11-11 08:47"])
check(err is not None and tpe(err.need) == "08:47:00" and tpe(err.due_at) == "08:48:30",
      "live mid-session 08:48 without its 08:47 row: refused for 08:47 due 08:48:30, as before")

# a minute-END day of the store (before 2026-06-11): rows stamped like the bars, 05:00 and 08:46
END_B = minutes("2026-03-03", "04:58", "05:00") + minutes("2026-03-03", "08:46", "08:48")
END_F = frame(END_B, 3)
e = D.align_feed(bars(END_B), END_F, SRC, "1m", bar_tz="UTC")
check(e.loc[utc(["2026-03-03 08:46"])[0], "bid_vol"] == END_F.loc[utc(["2026-03-03 05:00"])[0], "bid_vol"]
      and not e.iloc[1:].isna().any().any(),
      "minute-END day: 08:46 keeps the 05:00 row it carried before (no new NaN)")

# some minute-START days also carry a row stamped 13:45 (measured: 18 of 102 night opens since
# 2026-06-11): a backtest's 15:01 still uses 15:00, and live must wait for it, not compute on 13:45
X_F = pd.concat([BAV, frame(["2026-11-11 13:45"], 7)]).sort_index()
x = D.align_feed(BARS, X_F, SRC, "1m", bar_tz="UTC")
check(x.loc[utc(["2026-11-11 15:01"])[0], "bid_vol"] == BAV.loc[utc(["2026-11-11 15:00"])[0], "bid_vol"],
      "a day with a 13:45 row: the backtest's 15:01 carries 15:00, as before")
try:
    with D.live_feeds():
        D.align_feed(BARS[BARS.index <= utc(["2026-11-11 15:01"])[0]],
                     X_F[X_F.index <= utc(["2026-11-11 13:45"])[0]], SRC, "1m", bar_tz="UTC")
    err = None
except D.FeedNotPublished as ex:
    err = ex
check(err is not None and tpe(err.need) == "15:00:00",
      f"a day with a 13:45 row, live 15:01 before 15:00 lands: waits for 15:00, not computed on 13:45 "
      f"(got {err and tpe(err.need)})")

# lib/portfolio's copy of the TAIFEX index-futures hours and symbols = wait_for_bar's
from lib import portfolio  # noqa: E402

_s = importlib.util.spec_from_file_location("wfb_pin", os.path.join(ROOT, "manager", "wait_for_bar.py"))
_w = importlib.util.module_from_spec(_s)
_s.loader.exec_module(_w)
check(portfolio._TW_FUT_SYMBOL_RE.pattern == _w._TW_FUT_SYMBOL_RE.pattern
      and portfolio._TW_FUT_SESSIONS == ((timedelta(minutes=_w._TW_FUT_DAY_OPEN), timedelta(minutes=_w._TW_FUT_DAY_CLOSE)),
                                         (timedelta(minutes=_w._TW_FUT_NIGHT_OPEN), timedelta(days=1, minutes=_w._TW_FUT_NIGHT_CLOSE))),
      "lib/portfolio's TAIFEX sessions and symbol rule are wait_for_bar's")

# ── the other calendar 'bars' feeds: bars stamped at their open, each waits for its own bucket ──
BARS_FEEDS = sorted(k for k, v in D.FEED_TIMING.items() if v.get("calendar") == "bars")
check(BARS_FEEDS == sorted(["capital_shortage", "funding_rate", "holder_concentration", "liquidation",
                            "market_direction", "market_sentiment", "squeeze_momentum", "taker_intensity",
                            "top_trader_exposure", "unusual_movement", "whale_hunter", SRC]),
      f"calendar 'bars' feeds are the 11 Blave alphas + {SRC} ({BARS_FEEDS})")
HR = pd.date_range("2026-09-23 00:00", periods=10, freq="1h")
gap_bars = pd.DataFrame(index=HR.drop(HR[5]))                   # no 05:00 bar
for name in BARS_FEEDS:
    if name == SRC:
        continue
    alpha = pd.DataFrame({"alpha": np.arange(10.0)}, index=HR).drop(HR[6])   # no 06:00 bucket
    a = D.align_feed(gap_bars, alpha, name, "1h", bar_tz="UTC")["alpha"]
    try:
        with D.live_feeds():
            D.align_feed(gap_bars.iloc[:6], alpha, name, "1h", bar_tz="UTC")   # last bar 06:00
        raised = False
    except D.FeedNotPublished as ex:
        raised = ex.need.tz_convert("UTC").hour == 6
    check(np.isnan(a.loc[HR[6]]) and a.loc[HR[7]] == 7.0 and a.loc[HR[4]] == 4.0 and raised,
          f"{name}: the bar after a missing bar still needs its own bucket (NaN in a backtest, refused live)")

# ── wait_for_bar ─────────────────────────────────────────────────────────────────────
WS = tempfile.mkdtemp(prefix="txf-bav-", dir=os.environ.get("SCRATCHPAD") or None)
os.chdir(WS)
spec = importlib.util.spec_from_file_location("wfb", os.path.join(ROOT, "manager", "wait_for_bar.py"))
wfb = importlib.util.module_from_spec(spec)
spec.loader.exec_module(wfb)
wfb.STATE_DIR = os.path.join(WS, "state", "bar_wait")
wfb._tw_holiday = lambda day, unknown=False: False
calls = {"failed": [], "stale": [], "run": 0}
wfb._alert_failure = lambda: types.SimpleNamespace(alert=lambda name, code, out, **k: calls["failed"].append((code, out)))
wfb._alert_stale = lambda name, expected, minutes, straggler, computed=False: calls["stale"].append((minutes, straggler))
wfb._alert_lag = lambda name, minutes, straggler: calls["stale"].append((minutes, straggler))


class Clock(datetime):
    at = None

    @classmethod
    def now(cls, tz=None):
        return cls.at.replace(tzinfo=tz) if tz else cls.at


wfb.datetime = Clock
STRAT = '''import json, os, sys
sys.path.insert(0, {root!r})
import dotenv
dotenv.dotenv_values = lambda *a, **k: {{}}   # the run child never reads a real .env either
import pandas as pd
from lib.data import align_feed

SYMBOL = "TXF"
INTERVAL = "1m"
HERE = os.path.dirname(os.path.abspath(__file__))


def _view():   # the n-th fetch_data call (the check in-process, then the run) reads views[n]
    path = os.path.join(HERE, "calls")
    n = os.path.getsize(path) if os.path.exists(path) else 0
    with open(path, "a") as f:
        f.write("x")
    views = json.load(open(os.path.join(HERE, "views.json")))
    return views[min(n, len(views) - 1)]


def fetch_twfutures_ohlcv(symbol, schema, start, end, headers):
    return pd.read_parquet(os.path.join(HERE, "bars.parquet"))


def fetch_twfutures_bid_ask_vol(start, end, headers):
    return pd.read_parquet(os.path.join(HERE, "bav.parquet"))


def fetch_data(hdrs):
    v = _view()
    if v == "boom":
        raise KeyError("strategy bug")
    df = fetch_twfutures_ohlcv(SYMBOL, INTERVAL, "2026-11-01", None, hdrs)
    bav = fetch_twfutures_bid_ask_vol("2026-11-01", None, hdrs)
    df = df[df.index <= pd.Timestamp(v["bars_to"])]
    bav = bav[bav.index <= pd.Timestamp(v["bav_to"])]
    return df.join(align_feed(df, bav, "twfutures_bid_ask_vol", INTERVAL, bar_tz="UTC"))


def compute_signals(df):
    return pd.Series(0.0, index=df.index)


if __name__ == "__main__":
    from lib.runner import run
    run({{"STRATEGY_NAME": "flowz", "SYMBOL": SYMBOL, "INTERVAL": INTERVAL, "START": "2026-11-01",
         "FEE": 0.0001, "MCPT": False}}, fetch_data, compute_signals)
'''
SDIR = os.path.join(WS, "strategies", "flowz")
os.makedirs(SDIR)
open(os.path.join(SDIR, "strategy.py"), "w").write(STRAT.format(root=ROOT))
DAYB = minutes("2026-11-11", "08:46", "13:45")
DAYF = minutes("2026-11-11", "08:45", "13:44")
pd.concat([bars(B_NIGHT[:6]), bars(DAYB), bars(B_DAY[6:])]).to_parquet(os.path.join(SDIR, "bars.parquet"))
pd.concat([frame(F_NIGHT[:6], 4), frame(DAYF, 5), frame(F_DAY[6:], 6)]).to_parquet(os.path.join(SDIR, "bav.parquet"))


def views(*vs):
    json.dump([v if v == "boom" else {"bars_to": str(utc([v[0]])[0]), "bav_to": str(utc([v[1]])[0])} for v in vs],
              open(os.path.join(SDIR, "views.json"), "w"))
    with contextlib.suppress(OSError):
        os.remove(os.path.join(SDIR, "calls"))


def tick(at_tpe, **reset):
    Clock.at = pd.Timestamp(at_tpe, tz=TPE).tz_convert("UTC").tz_localize(None).to_pydatetime()
    st = wfb._load_state("flowz")
    st.update(reset)
    wfb._save_state("flowz", st)
    del calls["failed"][:], calls["stale"][:]
    with contextlib.redirect_stdout(io.StringIO()):
        wfb._tick("flowz")
    return wfb._load_state("flowz")


# the session opens, the strategy's own run stubbed: the check alone decides
real_run = wfb._run_strategy_protected
wfb._run_strategy_protected = lambda name: calls.__setitem__("run", calls["run"] + 1) or True
for at, b_to, f_to, own_row in (("2026-11-11 08:46:09", "2026-11-11 08:46", "2026-11-11 04:59", "08:45"),
                                ("2026-11-11 15:01:09", "2026-11-11 15:01", "2026-11-11 13:44", "15:00")):
    views((b_to, f_to))
    wfb._save_state("flowz", {**wfb._default_state(), "last_processed_bar": None})
    st = tick(at)
    due = pd.Timestamp(f"2026-11-11 {own_row}", tz=TPE) + pd.Timedelta(seconds=90)
    check(not calls["stale"] and not calls["failed"] and calls["run"] == 0 and st["data_missing_at"] is None
          and st["stall_alert_at"] is None and st["last_attempt_failed_at"] is None
          and st["pending_since"] == due.tz_convert("UTC").tz_localize(None).isoformat(),
          f"wait_for_bar {at[11:]}: {own_row} row not in yet → not ready, no bar_stale / data_missing_at, "
          f"timed from its due {tpe(due)} ({calls['stale']}, pending {st['pending_since']})")
    views((b_to, f"2026-11-11 {own_row}"))
    st = tick(at[:17] + "40")
    check(calls["run"] == 1 and not calls["stale"] and st["last_attempt_failed_at"] is None,
          f"wait_for_bar {at[11:17]}40: the {own_row} row in → the strategy runs")
    calls["run"] = 0

# 09:28:12: the check sees the 09:27 bar (its 09:26 row in), the run re-fetches the 09:28 bar
wfb._run_strategy_protected = real_run
os.environ["BLAVE_MODE"] = "live"
wfb._save_state("flowz", wfb._default_state())
views(("2026-11-11 09:27", "2026-11-11 09:26"), ("2026-11-11 09:28", "2026-11-11 09:26"))
st = tick("2026-11-11 09:28:12")
due = pd.Timestamp("2026-11-11 09:28:30", tz=TPE).tz_convert("UTC").tz_localize(None).isoformat()
check(not calls["failed"] and not calls["stale"] and st["last_attempt_failed_at"] is None
      and st["last_processed_bar"] is None and st["pending_since"] == due
      and not os.path.exists(os.path.join(wfb.STATE_DIR, "flowz.feed_wait.json")),
      f"09:28:12 run refused for the 09:27 row (due 09:28:30): not ready — no strategy_failed, no "
      f"last_attempt_failed_at, timed from the due ({[c[0] for c in calls['failed']]}, {st['last_attempt_failed_at']})")
views(("2026-11-11 09:27", "2026-11-11 09:26"), "boom")
wfb._save_state("flowz", wfb._default_state())
st = tick("2026-11-11 09:28:20")
check(len(calls["failed"]) == 1 and calls["failed"][0][0] == 1 and st["last_attempt_failed_at"] is not None,
      "any other failed run: strategy_failed and the retry backoff, as before")
os.environ.pop("BLAVE_MODE", None)

# a feed file the run did not write this time (removing it failed): never taken as a wait
leftover = os.path.join(wfb.STATE_DIR, "flowz.feed_wait.json")
json.dump({"source": SRC, "need": "2026-11-11T01:27:00+00:00", "due_at": "2026-11-11T01:28:30+00:00",
           "last_bar": "2026-11-11T01:28:00+00:00"}, open(leftover, "w"))
os.utime(leftover, (time.time() - 120, time.time() - 120))
check(wfb._read_feed_wait(leftover, time.time()) is None and not os.path.exists(leftover),
      "a feed-wait file older than the run's launch is not a wait (and is removed)")
json.dump({"source": SRC, "need": "2026-11-11T01:27:00+00:00", "due_at": "2026-11-11T01:28:30+00:00",
           "last_bar": "2026-11-11T01:28:00+00:00"}, open(leftover, "w"))
fw = wfb._read_feed_wait(leftover, time.time() - 5)
check(isinstance(fw, wfb._FeedWait) and fw.due_at == datetime(2026, 11, 11, 1, 28, 30),
      "one written since the launch is the run's wait")


class _KilledProc:   # wrote its feed-wait file, then was killed (timeout / signal)
    pid, returncode = 4243, -9

    def __init__(self, args, **kw):
        self.path = os.environ.get(wfb.FEED_WAIT_ENV)

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False

    def communicate(self, timeout=None):
        json.dump({"source": SRC, "need": "2026-11-11T01:27:00+00:00", "due_at": "2026-11-11T01:28:30+00:00",
                   "last_bar": "2026-11-11T01:28:00+00:00"}, open(self.path, "w"))
        return "", ""


real_popen, wfb.subprocess.Popen = wfb.subprocess.Popen, _KilledProc
del calls["failed"][:]
with contextlib.redirect_stdout(io.StringIO()):
    ran = wfb._run_strategy_protected("flowz")
wfb.subprocess.Popen = real_popen
check(ran is False and len(calls["failed"]) == 1 and wfb.FEED_WAIT_ENV not in os.environ,
      "a run killed by a signal / the timeout alerts even with a feed-wait file (and the env is not left set)")

# the bid/ask feed stops at 08:50 while the bars go on: ONE bar_stale 15 minutes after the first
# missing row's due, data_missing_at written, and target_stale can hold the target
real_time = wfb.time
wfb.time = types.SimpleNamespace(time=lambda: pd.Timestamp(Clock.at).tz_localize("UTC").timestamp(),
                                 monotonic=time.monotonic, sleep=lambda s: None)


def outage(label, run):
    wfb._save_state("flowz", {**wfb._default_state(), "last_processed_bar": "2026-11-11T00:50:00"})
    wfb._run_strategy_protected = run
    stale, t = [], pd.Timestamp("2026-11-11 08:52")
    while t <= pd.Timestamp("2026-11-11 09:21"):
        views(*label(t))
        st = tick(f"{t:%Y-%m-%d %H:%M}:10")
        stale += calls["stale"]
        t += pd.Timedelta(minutes=1)
    return st, stale


def check_stuck(t):            # the check meets the missing row itself
    return [(t.strftime("%Y-%m-%d %H:%M"), "2026-11-11 08:50")]


st, stale = outage(check_stuck, lambda name: calls.__setitem__("run", calls["run"] + 1) or True)
check(len(stale) == 1 and stale[0][0] >= 15 and st["data_missing_at"] is not None
      and st["feed_wait_since"] == "2026-11-11T00:52:30",
      f"feed out from 08:51, check-side: exactly one bar_stale ({stale}), data_missing_at written, "
      f"timed from the first missing row's due 08:52:30 ({st['feed_wait_since']})")
target = os.path.join(SDIR, "state.json")   # the target the 08:50 bar's run wrote
open(target, "w").write("{}")
written = pd.Timestamp("2026-11-11 08:50:40", tz=TPE).timestamp()
os.utime(target, (written, written))
age = portfolio._stale_target_age("flowz", now=pd.Timestamp("2026-11-11 09:21:30", tz=TPE).timestamp())
check(age is not None, f"…and target_stale holds the 08:50 target at 09:21 (age {age})")


def run_stuck(t):   # the check is satisfied, every run re-fetches a newer bar whose row is out
    return [((t - pd.Timedelta(minutes=1)).strftime("%Y-%m-%d %H:%M"),
             (t - pd.Timedelta(minutes=2)).strftime("%Y-%m-%d %H:%M"))]


def refused_run(name):
    at = pd.Timestamp(Clock.at)
    return wfb._FeedWait(types.SimpleNamespace(
        source=SRC, need=at.floor("min") - pd.Timedelta(minutes=1),
        due_at=(at.floor("min") + pd.Timedelta(seconds=30)).to_pydatetime(), last_bar=at.floor("min").to_pydatetime()))


st, stale = outage(run_stuck, refused_run)
check(len(stale) == 1 and st["data_missing_at"] is not None and st["last_attempt_failed_at"] is None,
      f"feed out, every run refused (run-side): exactly one bar_stale ({stale}), data_missing_at written")
views(("2026-11-11 09:22", "2026-11-11 09:21"))
wfb._run_strategy_protected = lambda name: True
st = tick("2026-11-11 09:22:40", stall_alert_at=None)   # past the stall throttle's next poll
check(st["feed_wait_since"] is None and st["feed_wait_alert_at"] is None and st["data_missing_at"] is None,
      "the row lands, the strategy computes: the episode is over")


def routine(hm):   # the check meets bar hm before its own row (hm − 1m) is in: due hm:30
    t = pd.Timestamp(f"2026-11-11 {hm}")
    return ((f"2026-11-11 {hm}", (t - pd.Timedelta(minutes=2)).strftime("%Y-%m-%d %H:%M")),)


def due_of(hm):
    return (pd.Timestamp(f"2026-11-11 {hm}", tz=TPE) + pd.Timedelta(seconds=30)).tz_convert("UTC").tz_localize(None).isoformat()


# a pause with no polls (asleep, stopped, restarted later) between two routine refusals
for pause in (16, 60):
    wfb._save_state("flowz", wfb._default_state())
    views(*routine("10:30"))
    tick("2026-11-11 10:30:05")
    back = (pd.Timestamp("2026-11-11 10:30") + pd.Timedelta(minutes=pause)).strftime("%H:%M")
    views(*routine(back))
    st = tick(f"2026-11-11 {back}:05")
    check(not calls["stale"] and st["data_missing_at"] is None and st["pending_since"] == due_of(back)
          and st["feed_wait_since"] == due_of(back),
          f"{pause} min without polls, then a routine refusal: a new wait from its own due — no bar_stale, "
          f"no data_missing_at ({calls['stale']}, pending {st['pending_since']})")
# the close in between: refused at 13:44:05, nothing polls until the 15:01:05 night open
wfb._save_state("flowz", wfb._default_state())
views(*routine("13:44"))
tick("2026-11-11 13:44:05")
views(("2026-11-11 15:01", "2026-11-11 13:44"))
st = tick("2026-11-11 15:01:05")
check(not calls["stale"] and st["data_missing_at"] is None and st["pending_since"] == due_of("15:01"),
      f"refused at 13:44, next poll at the 15:01 open: no bar_stale dated from 13:44 ({calls['stale']})")


def failed_run(name):
    return False


# any other outcome between two refusals ends the wait: a fetch_data error, a failed run
for label, between_views, between_run in (("fetch_error", ("boom",), None),
                                          ("failed run", (("2026-11-11 10:30", "2026-11-11 10:29"),), failed_run)):
    wfb._run_strategy_protected = lambda name: True
    wfb._save_state("flowz", wfb._default_state())
    views(*routine("10:30"))
    tick("2026-11-11 10:30:05")
    views(*between_views)
    if between_run:
        wfb._run_strategy_protected = between_run
    tick("2026-11-11 10:31:05")
    wfb._run_strategy_protected = lambda name: True
    views(*routine("10:32"))
    st = tick("2026-11-11 10:32:05", last_attempt_failed_at=None)
    check(st["feed_wait_since"] == due_of("10:32") and st["pending_since"] == due_of("10:32") and not calls["stale"],
          f"a {label} between two refusals: the second starts its own wait ({st['feed_wait_since']})")

# per feed, and an alert does not carry over a broken wait
st = {**wfb._default_state(), "feed_wait_source": SRC, "feed_wait_since": "2026-11-11T02:00:30",
      "feed_wait_seen_at": "2026-11-11T02:20:05", "feed_wait_alert_at": 1.0}
other = wfb._FeedWait(types.SimpleNamespace(source="twstock_institutional", due_at=datetime(2026, 11, 11, 2, 21)))
same = wfb._FeedWait(types.SimpleNamespace(source=SRC, due_at=datetime(2026, 11, 11, 2, 21, 30)))
check(not wfb._feed_wait_continues(st, other, datetime(2026, 11, 11, 2, 21, 5))
      and wfb._feed_wait_continues(st, same, datetime(2026, 11, 11, 2, 35, 5))
      and not wfb._feed_wait_continues(st, same, datetime(2026, 11, 11, 2, 45, 5)),
      "another feed is its own wait; an alerted wait carries over the throttle's 15 min, not a longer pause")
wfb._end_feed_wait(st)
check(st["feed_wait_alert_at"] is None and st["feed_wait_since"] is None,
      "a wait that ends takes its alert with it (the next wait alerts on its own)")
wfb.time = real_time

# ── target_stale: session time only for a TAIFEX intraday strategy ─────────────────────
os.makedirs("strategies/txfz", exist_ok=True)
open("strategies/txfz/strategy.py", "w").write('SYMBOL = "TMF"\nINTERVAL = "1m"\n'
                                                'df = fetch_twfutures_ohlcv(SYMBOL, INTERVAL, s, e, h)\n')
os.makedirs("strategies/btcz", exist_ok=True)
open("strategies/btcz/strategy.py", "w").write('SYMBOL = "BTCUSDT"\nINTERVAL = "1m"\n'
                                                'df = fetch_kline(SYMBOL, INTERVAL, s, e, h)\n')


def ts(s):
    return pd.Timestamp(s, tz=TPE).timestamp()


def stale_age(name, written, failed, now):
    open(f"strategies/{name}/state.json", "w").write("{}")
    os.utime(f"strategies/{name}/state.json", (written, written))
    json.dump({"data_missing_at": failed}, open(f"state/bar_wait/{name}.json", "w"))
    return portfolio._stale_target_age(name, now=now)


age = stale_age("txfz", ts("2026-11-11 05:01:05"), ts("2026-11-11 08:46:09"), ts("2026-11-11 08:46:42"))
check(age is None, f"TXF 1m target from 05:01, a failure at 08:46: not stale at 08:46:42 (age {age})")
age = stale_age("txfz", ts("2026-11-11 05:01:05"), ts("2026-11-11 09:20:00"), ts("2026-11-11 09:20:30"))
check(age is not None and abs(age - 35.5 * 60) < 1,
      f"…a failure at 09:20: stale, aged by session time 08:45–09:20:30 (age {age})")
age = stale_age("txfz", ts("2026-11-13 13:40:00"), ts("2026-11-16 08:50:00"), ts("2026-11-16 08:50:30"))
check(age is not None and abs(age - (5 * 60 + 14 * 3600 + 5.5 * 60)) < 1,
      f"…Friday 13:40 target, Monday 08:50: Friday's close, Friday night and Monday's open count (age {age})")
age = stale_age("btcz", ts("2026-11-11 05:01:05"), ts("2026-11-11 08:46:09"), ts("2026-11-11 08:46:42"))
check(age is not None and abs(age - (ts("2026-11-11 08:46:42") - ts("2026-11-11 05:01:05"))) < 1,
      f"a crypto 1m target keeps wall-clock age (age {age})")

os.chdir(ROOT)
shutil.rmtree(WS, ignore_errors=True)
print("all checks passed" if not fails else f"FAILED: {fails}")
sys.exit(1 if fails else 0)
