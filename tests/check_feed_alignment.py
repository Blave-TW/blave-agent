"""Minimal check: lib.data.align_feed attaches external (non-price) feeds by publication time,
live refuses a bar whose row has not been published, and the runner's look-ahead replay
cuts recorded feeds by publication time too. No network: fetchers are stubbed.

  - a row is visible from the first bar whose close (label + interval) is at/after its
    publication time — backtest and live alike (monthly revenue stamped at the filing month,
    三大法人 stamped at the trading date, a Blave alpha stamped at its bucket open)
  - a missing due row: NaN mid-history, trailing bars trimmed in a backtest,
    FeedNotPublished on the last bar inside live_feeds(); not-yet-due rows raise nothing
  - economic calendar: `real` visible 5 minutes after its release; no-time events from next day
  - runner: a daily feed ffilled onto intraday bars before publication is refused as
    偷看未來; the same strategy through align_feed passes; a live tick on an unpublished row
    raises and leaves state.json alone
  - wait_for_bar: an unpublished row is "not ready" — no fetch_error alert, no backoff, and
    the stale alert only fires 15 minutes after the row was DUE and names the feed

Run: cd blave-agent && MPLBACKEND=Agg .venv/bin/python tests/check_feed_alignment.py
"""
import contextlib
import importlib.util
import io
import json
import os
import sys
import tempfile
import types
from datetime import datetime, timedelta
from pathlib import Path

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
os.environ.setdefault("MPLBACKEND", "Agg")

import dotenv
dotenv.dotenv_values = lambda *a, **k: {}   # never read the workspace .env

import numpy as np
import pandas as pd

import lib.data as D
import lib.runner as runner

runner.dotenv_values = dotenv.dotenv_values

fails = 0


def check(cond, msg):
    global fails
    print(("  PASS  " if cond else "  FAIL  ") + msg)
    fails += (not cond)


def quiet(fn, *a, **k):
    with contextlib.redirect_stdout(io.StringIO()):
        return fn(*a, **k)


TPE = "Asia/Taipei"
DAYS = pd.bdate_range("2026-09-14", "2026-09-23")                     # Mon 09-14 … Wed 09-23
INST = pd.DataFrame({"foreign_net": np.arange(len(DAYS), dtype=float)}, index=DAYS)
DAILY = pd.DataFrame({"Close": 1.0}, index=DAYS)                         # fetch_twstock_price*: naive Taipei dates

# ── daily bars: 三大法人 for D (published D 20:00) is known by bar D's close ─────────────
got = D.align_feed(DAILY, INST, "twstock_institutional", "1d", bar_tz=TPE)
check((got["foreign_net"].to_numpy() == INST["foreign_net"].to_numpy()).all(),
      "daily bars: bar D carries 三大法人[D] (served D 20:05 < bar close D+1 00:00)")

# ── a feed stamped at the period it is FILED in (FinMind: March revenue = 04-01) ─────────
REV = pd.DataFrame({"revenue": [100.0, 200.0]}, index=pd.DatetimeIndex(["2026-03-01", "2026-04-01"]))
rbars = pd.DataFrame({"Close": 1.0}, index=pd.bdate_range("2026-04-01", "2026-04-14"))
for scope, label in ((contextlib.nullcontext, "backtest"), (D.live_feeds, "live")):
    with scope():
        r = quiet(D.align_feed, rbars, REV, "twstock_monthly_revenue", "1d", bar_tz=TPE)["revenue"]
    check((r.loc[:"2026-04-10"] == 100.0).all() and (r.loc["2026-04-13":] == 200.0).all(),
          f"{label}: the 04-01-stamped revenue (filed by 04-10, FinMind 18:00, api day cache → "
          f"04-11 08:00) is invisible to every bar before it")

# ── intraday bars (naive UTC, like fetch_twfutures_ohlcv 60m) ──────────────────────────
HOURS = (9, 10, 11, 12, 13, 20)
TW = pd.DatetimeIndex([d + pd.Timedelta(hours=h) for d in pd.bdate_range("2026-09-21", "2026-09-23", tz=TPE)
                       for h in HOURS])
H60 = pd.DataFrame({"Close": 1.0}, index=TW.tz_convert("UTC").tz_localize(None))
got = D.align_feed(H60, INST, "twstock_institutional", "60m", bar_tz="UTC")["foreign_net"]
day_of = pd.Series(TW.normalize().tz_localize(None), index=H60.index)
prev_val = INST["foreign_net"].shift(1).reindex(day_of).to_numpy()
same_val = INST["foreign_net"].reindex(day_of).to_numpy()
is_night = np.asarray(TW.hour == 20)
check(np.array_equal(got.to_numpy()[~is_night], prev_val[~is_night]) and
      np.array_equal(got.to_numpy()[is_night], same_val[is_night]),
      "60m bars: day-session bars carry D-1, the 20:00 bar (close 21:00) carries D")

# ── not published yet ────────────────────────────────────────────────────────────────
late = INST.iloc[:-1]                                                   # 09-23 not in yet
out = io.StringIO()
with contextlib.redirect_stdout(out):
    trimmed = D.align_feed(DAILY, late, "twstock_institutional", "1d", bar_tz=TPE)
check(len(trimmed) == len(DAILY) - 1 and "cut" in out.getvalue(),
      "backtest: the trailing bar whose row is due but missing is trimmed, with a printed note")
try:
    with D.live_feeds():
        D.align_feed(DAILY, late, "twstock_institutional", "1d", bar_tz=TPE)
    check(False, "live: missing due row must raise FeedNotPublished")
except D.FeedNotPublished as e:
    check(e.due_at == pd.Timestamp("2026-09-23 20:05", tz=TPE),
          f"live: FeedNotPublished for the 09-23 row, due 09-23 20:05 Taipei (got {e.due_at})")
with D.live_feeds():
    at_13 = D.align_feed(H60[H60.index <= pd.Timestamp("2026-09-23 05:00")], late,
                         "twstock_institutional", "60m", bar_tz="UTC")
check(at_13["foreign_net"].iloc[-1] == INST["foreign_net"].iloc[-2],
      "live 13:00 bar on 09-23: the 09-23 row is not due yet → no raise, uses 09-22")
monday = H60[H60.index <= pd.Timestamp("2026-09-21 02:00")]             # Mon 10:00 Taipei
with D.live_feeds():
    m = D.align_feed(monday, INST.loc[:"2026-09-18"], "twstock_institutional", "60m", bar_tz="UTC")
check(m["foreign_net"].iloc[-1] == INST.loc["2026-09-18", "foreign_net"],
      "live Monday 10:00: needs Friday's row only (the weekend is not a gap)")
night = pd.DatetimeIndex([pd.Timestamp("2026-09-18 13:00", tz=TPE)]
                         + [pd.Timestamp("2026-09-18", tz=TPE) + pd.Timedelta(hours=h) for h in range(15, 24)]
                         + [pd.Timestamp("2026-09-19", tz=TPE) + pd.Timedelta(hours=h) for h in range(0, 6)]
                         + [pd.Timestamp("2026-09-21 09:00", tz=TPE)])   # Fri day, Fri night → Sat 05:00, Mon 09:00
NB = pd.DataFrame({"Close": 1.0}, index=night.tz_convert("UTC").tz_localize(None))
with D.live_feeds():
    nb = D.align_feed(NB, INST.loc[:"2026-09-18"], "twfutures_institutional", "60m", bar_tz="UTC")
check(nb["foreign_net"].iloc[-1] == INST.loc["2026-09-18", "foreign_net"] and not nb["foreign_net"].isna().any(),
      "night-session bars dated Saturday 00:00–05:00 do not make Saturday a due date: Monday 09:00 needs Friday")
holed = INST.drop(pd.Timestamp("2026-09-17"))
h = D.align_feed(DAILY, holed, "twstock_institutional", "1d", bar_tz=TPE)["foreign_net"]
check(np.isnan(h.loc["2026-09-17"]) and h.loc["2026-09-16"] == INST.loc["2026-09-16", "foreign_net"],
      "a hole mid-history is NaN on that bar, not the previous day's value")

# ── Blave alpha (stamped at the bucket open, final at its close) ─────────────────────
HR = pd.date_range("2026-09-23 00:00", periods=10, freq="1h")
ALPHA = pd.DataFrame({"alpha": np.arange(10.0)}, index=HR)
a = D.align_feed(pd.DataFrame(index=HR), ALPHA, "holder_concentration", "1h", bar_tz="UTC")["alpha"]
check((a.to_numpy() == ALPHA["alpha"].to_numpy()).all(), "1h alpha: bar L carries alpha[L] (final at L's close)")
d_alpha = pd.DataFrame({"alpha": [1.0, 2.0]}, index=pd.DatetimeIndex(["2026-09-22", "2026-09-23"]))
a = D.align_feed(pd.DataFrame(index=HR), d_alpha, "holder_concentration", "1h", bar_tz="UTC")["alpha"]
check((a == 1.0).all(), "daily alpha on 1h bars: 09-23's value (final 09-24 00:00) is invisible all day 09-23")
try:
    with D.live_feeds():
        D.align_feed(pd.DataFrame(index=HR), ALPHA.iloc[:-1], "holder_concentration", "1h", bar_tz="UTC")
    check(False, "live alpha: missing last bucket must raise")
except D.FeedNotPublished:
    check(True, "live alpha: the last bar's bucket missing → FeedNotPublished")

# ── economic calendar ────────────────────────────────────────────────────────────────
CAL = pd.DataFrame({"datetime": pd.to_datetime(["2026-09-22 00:00", "2026-09-23 20:30"]),
                    "time": [None, "20:30"], "subject": "CPI", "real": [2.9, 3.1]})
EB = pd.date_range("2026-09-22 18:30", "2026-09-23 21:30", freq="1h", tz=TPE)
e = D.align_feed(EB, CAL, "economic_calendar", "1h")["real"]
check(np.isnan(e.loc[:"2026-09-22 22:30"]).all() and e.loc["2026-09-22 23:30"] == 2.9,
      "no-time event (stamped 00:00): visible only from the next day")
check(e.loc["2026-09-23 19:30"] == 2.9 and e.loc["2026-09-23 20:30"] == 3.1,
      "20:30 release (+5 min api cache): invisible to the bar closing 20:30, visible to the next")
pending = CAL.assign(real=[2.9, None])
try:
    with D.live_feeds():
        D.align_feed(EB, pending, "economic_calendar", "1h")
    check(False, "econ live: released but no actual must raise")
except D.FeedNotPublished:
    check(True, "econ live: release time passed, actual not in → FeedNotPublished")
try:
    D.align_feed(H60, INST, "twstock_institutional", "60m")
    check(False, "naive bars without bar_tz must raise")
except ValueError:
    check(True, "naive bars without bar_tz → ValueError (no silent 8h guess)")

# ── runner: look-ahead replay cuts recorded feeds by publication time ────────────────
WS = Path(tempfile.mkdtemp(prefix="feed-align-", dir=os.environ.get("SCRATCHPAD") or None))
os.chdir(WS)
runner._REPO_ROOT = WS
rng = np.random.default_rng(11)
DAYS2 = pd.bdate_range("2025-01-01", "2025-12-31")
BIG = pd.DatetimeIndex([d + pd.Timedelta(hours=h) for d in DAYS2.tz_localize(TPE) for h in HOURS])
px = 20000 * np.exp(np.cumsum(rng.normal(0, 0.003, len(BIG))))
TXF = pd.DataFrame({"Open": px, "High": px, "Low": px, "Close": px, "Volume": 1.0},
                   index=BIG.tz_convert("UTC").tz_localize(None))
FLOW = pd.DataFrame({"foreign_net": rng.normal(0, 1, len(DAYS2))}, index=DAYS2)
D.fetch_twfutures_ohlcv = lambda symbol, schema, start, end, headers: TXF.copy()
D.fetch_twfutures_institutional = lambda futures_id, start, end, headers: FLOW.copy()


def naive_join(hdrs):                        # D's flow ffilled onto D's own day-session bars
    from lib.data import fetch_twfutures_ohlcv, fetch_twfutures_institutional
    df = fetch_twfutures_ohlcv("TXF", "60m", "2025-01-01", None, hdrs)
    flow = fetch_twfutures_institutional("TX", "2025-01-01", None, hdrs)["foreign_net"]
    tpe_day = df.index.tz_localize("UTC").tz_convert(TPE).normalize().tz_localize(None)
    df["flow"] = flow.reindex(tpe_day).to_numpy()
    return df


def aligned(hdrs):
    from lib.data import fetch_twfutures_ohlcv, fetch_twfutures_institutional, align_feed
    df = fetch_twfutures_ohlcv("TXF", "60m", "2025-01-01", None, hdrs)
    flow = fetch_twfutures_institutional("TX", "2025-01-01", None, hdrs)
    al = align_feed(df, flow, "twfutures_institutional", "60m", bar_tz="UTC")
    return df.loc[al.index].join(al.rename(columns={"foreign_net": "flow"}))


def flow_signal(df):
    return (df["flow"] > 0).astype(float).where(df["flow"].notna())


def backtest(name, fetch, compute, env="backtest"):
    os.environ["BLAVE_MODE"] = env
    out, refused = io.StringIO(), None
    with contextlib.redirect_stdout(out):
        try:
            runner.run({"STRATEGY_NAME": name, "SYMBOL": "TXF", "INTERVAL": "60m", "START": "2025-01-01",
                        "FEE": 0.0001, "MCPT": False}, fetch, compute)
        except SystemExit as e:
            refused = str(e)
    os.environ.pop("BLAVE_MODE", None)
    return refused, out.getvalue()


saved = runner.LOOKAHEAD_CUTS
runner.LOOKAHEAD_CUTS = 40
refused, _ = backtest("flow_naive", naive_join, flow_signal)
check(bool(refused) and "偷看未來" in refused,
      "runner: 期貨法人[D] ffilled onto D's day-session bars (published 18:00) → refused as 偷看未來")
refused, out = backtest("flow_aligned", aligned, flow_signal)
check(refused is None and "Look-ahead check: passed" in out and "fetch_data + compute_signals" in out,
      "runner: the same feed through align_feed passes the look-ahead check" + (f" — {refused}" if refused else ""))
runner.LOOKAHEAD_CUTS = saved

STATE = WS / "strategies" / "flow_live" / "state.json"
STATE.parent.mkdir(parents=True, exist_ok=True)
STATE.write_text(json.dumps({"position": 0.5}))
D.fetch_twfutures_institutional = lambda futures_id, start, end, headers: FLOW.iloc[:-1].copy()
raised = None
try:
    backtest("flow_live", aligned, flow_signal, env="live")
except D.FeedNotPublished as e:
    raised = e
check(raised is not None and json.loads(STATE.read_text())["position"] == 0.5,
      "runner live tick on an unpublished row: FeedNotPublished, state.json untouched")

# ── wait_for_bar ───────────────────────────────────────────────────────────────────
spec = importlib.util.spec_from_file_location("wfb", os.path.join(ROOT, "manager", "wait_for_bar.py"))
wfb = importlib.util.module_from_spec(spec)
spec.loader.exec_module(wfb)
wfb.STATE_DIR = str(WS / "state" / "bar_wait")
calls = {"fetch_error": 0, "stale": [], "run": 0}
wfb._alert_failure = lambda: types.SimpleNamespace(alert=lambda *a, **k: calls.__setitem__("fetch_error", calls["fetch_error"] + 1))
wfb._alert_stale = lambda name, expected, minutes, straggler: calls["stale"].append((minutes, straggler))
wfb._run_strategy_protected = lambda name: calls.__setitem__("run", calls["run"] + 1) or True
due = pd.Timestamp("2026-09-23 20:00", tz=TPE)


def raising_fetch(h):
    raise D.FeedNotPublished("twfutures_institutional", pd.Timestamp("2026-09-23", tz=TPE), due,
                             pd.Timestamp("2026-09-23 21:00", tz=TPE))


wfb._load_strategy_module = lambda name: types.SimpleNamespace(INTERVAL="1h", fetch_data=raising_fetch)
due_utc = due.tz_convert("UTC").tz_localize(None).to_pydatetime()


class Clock(datetime):
    now_value = None

    @classmethod
    def now(cls, tz=None):
        return cls.now_value.replace(tzinfo=tz) if tz else cls.now_value


wfb.datetime = Clock
for minutes_after_due in (-300, 5, 16):
    Clock.now_value = due_utc + timedelta(minutes=minutes_after_due)
    st = wfb._load_state("w")
    st["last_attempt_failed_at"] = None
    wfb._save_state("w", st)
    wfb._tick("w")
state = json.loads((WS / "state" / "bar_wait" / "w.json").read_text())
check(calls["fetch_error"] == 0 and calls["run"] == 0 and state.get("last_attempt_failed_at") is None,
      "wait_for_bar: unpublished row = not ready — no fetch_error alert, no backoff, strategy not run")
check(len(calls["stale"]) == 1 and calls["stale"][0][1] == "twfutures_institutional"
      and state["pending_since"] == due_utc.isoformat(),
      f"wait_for_bar: stale alert only once 15 min past the row's due time, naming the feed ({calls['stale']})")

print("all checks passed" if not fails else f"FAILED: {fails}")
sys.exit(1 if fails else 0)
