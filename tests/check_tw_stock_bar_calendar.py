"""TWSE stock daily strategies wait on trading days only (desktop 0.1.27 dev test, 2026-10-18).

wait_for_bar's expected bar is a UTC calendar floor. A 1d fetch_twstock_price* strategy has no
bar on Saturday, Sunday or a TWSE holiday, so it used to wait on one that never comes: a P2
"K 棒沒到位" every Sunday, Monday morning and day after a holiday, and Monday's bar run twice
(once as "Sunday", once as itself). Simulated minute by minute over a week, in-process:

  1. a TW stock Type A and a Type C universe: no stale alert; every trading-day bar computed
     exactly once (Monday's on Tuesday 08:00 TPE, like every other weekday's); nothing on the
     holiday; the holiday table never asked on Sat/Sun/Mon, and not once per minute on the day
     after the holiday.
  2. Friday's bar really late (lands Saturday 13:00 TPE): still alerts, on Friday's bar, and
     runs once it lands.
  3. crypto and TXF 1d strategies: the expected bar is the plain calendar floor, unchanged
     (crypto never asks the holiday table; TXF only through its own _tw_futures_closed).

Run: cd blave-agent && .venv/bin/python tests/check_tw_stock_bar_calendar.py
"""
import importlib.util
import os
import shutil
import sys
import tempfile
import types
from datetime import date, datetime, timedelta

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

import dotenv
dotenv.dotenv_values = lambda *a, **k: {}   # never read a workspace .env

fails = 0


def check(cond, msg):
    global fails
    print(("  PASS  " if cond else "  FAIL  ") + msg)
    fails += (not cond)


BASE = tempfile.mkdtemp(prefix="tw-bar-cal-")
SOURCES = {
    "tws": 'SYMBOL = "2330"\nINTERVAL = "1d"\nfrom lib.data import fetch_twstock_price_adj\n',
    "twc": 'INTERVAL = "1d"\nUNIVERSE = ["1101", "2330"]\nfrom lib.data import fetch_twstock_price_adj_batch\n',
    "btc": 'SYMBOL = "BTCUSDT"\nINTERVAL = "1d"\nfrom lib.data import fetch_kline\n',
    "txf": 'SYMBOL = "TXF"\nINTERVAL = "1d"\nfrom lib.data import fetch_twfutures_ohlcv, fetch_twstock_price\n',
}
for n, src in SOURCES.items():
    os.makedirs(os.path.join(BASE, "strategies", n))
    open(os.path.join(BASE, "strategies", n, "strategy.py"), "w").write(src)

spec = importlib.util.spec_from_file_location("wfb_twcal", os.path.join(ROOT, "manager", "wait_for_bar.py"))
wfb = importlib.util.module_from_spec(spec)
spec.loader.exec_module(wfb)

U = lambda d, h=0, m=0: datetime(2026, 10, d, h, m)   # naive UTC; Taipei = +8
HOLIDAY = date(2026, 10, 21)                        # a made-up Wednesday on the TWSE table
TRADING = [date(2026, 10, d) for d in (15, 16, 19, 20, 22)]


class _Clock(datetime):
    at = U(16)

    @classmethod
    def now(cls, tz=None):
        return cls.at.replace(tzinfo=tz) if tz else cls.at


wfb.datetime = _Clock
wfb.time = types.SimpleNamespace(time=lambda: (_Clock.at - datetime(1970, 1, 1)).total_seconds(),
                                 monotonic=__import__("time").monotonic)
holiday_calls = []
wfb._tw_holiday = lambda day: holiday_calls.append((_Clock.at, day)) or day == HOLIDAY
wfb._load_strategy_module = lambda n: types.SimpleNamespace(INTERVAL="1d")
land = {}   # trading day → naive UTC moment its bar lands (default 17:35 TPE that day)
seen, runs, alerts = [], [], []


def newest_bar():
    days = [d for d in TRADING if _Clock.at >= land.get(d, datetime(d.year, d.month, d.day, 9, 35))]
    return datetime.combine(max(days), datetime.min.time())


def fresh(mod, expected):
    seen.append(expected)
    last = newest_bar()
    if cur["type_c"]:
        latest = {"1101": last, "2330": last}
        return last, last >= expected, "1101", latest
    return last, last >= expected, None, {"": last}


wfb._check_freshness = fresh
wfb._run_strategy_protected = lambda n: runs.append((_Clock.at, newest_bar())) or True
wfb._alert_stale = lambda name, expected, *a, **k: alerts.append((_Clock.at, expected))
cur = {"type_c": False}


def simulate(name, start, end):
    del seen[:], runs[:], alerts[:], holiday_calls[:]
    cur["type_c"] = name == "twc"
    _Clock.at = start
    os.makedirs("state/bar_wait", exist_ok=True)
    wfb._save_state(name, wfb._default_state())
    while _Clock.at < end:
        wfb._tick(name)
        _Clock.at += timedelta(minutes=1)


cwd = os.getcwd()
os.chdir(BASE)
try:
    is_tw = getattr(wfb, "_tw_stock_daily", lambda n: False)
    check(is_tw("tws") and is_tw("twc"), "TW stock Type A and Type C universe detected")
    check(not is_tw("btc") and not is_tw("txf"), "crypto and TXF (even with a stock feature) not")

    # ── 1. a week: Fri 10-16 08:00 TPE → Fri 10-23 09:00 TPE ──────────────────────
    for name in ("tws", "twc"):
        simulate(name, U(16), U(23, 1))
        check(not alerts, f"{name}: no stale alert on Sat, Sun, Monday before close, the holiday or the day after "
                          f"(got {[(a.strftime('%a %H:%M'), e.date().isoformat()) for a, e in alerts]})")
        computed = [b.date() for _, b in runs]
        check(computed == [date(2026, 10, d) for d in (15, 16, 19, 20, 22)],
              f"{name}: every trading-day bar computed exactly once, in order (got {[c.isoformat() for c in computed]})")
        mon = [t for t, b in runs if b.date() == date(2026, 10, 19)]
        check(mon == [U(20)], f"{name}: Monday's bar runs once, Tuesday 08:00 TPE (got {mon})")
        weekend = [c for c in holiday_calls if U(17, 0, 1) <= c[0] < U(20)]
        check(not weekend, f"{name}: holiday table not asked after Saturday's run until Tuesday ({len(weekend)} calls)")
        after = [c for c in holiday_calls if U(22) <= c[0] < U(23)]
        check(len(after) <= 2, f"{name}: day after the holiday asks the table once, not every minute ({len(after)} calls)")

    # a holiday on Friday: Saturday and Monday mornings wait on Thursday's bar
    wfb._tw_holiday = lambda day: day == date(2026, 10, 16)
    for t in (U(17, 0, 1), U(19, 0, 1)):
        st = {"last_processed_bar": "2026-10-15T00:00:00"}
        try:
            got = wfb._tw_skip_holidays(wfb._tw_skip_weekend(wfb._expected_closed_bar_open("1d", t)), st)
        except AttributeError as e:
            got = e
        check(got == U(15), f"Friday holiday, {t:%a} 08:00 TPE: expected → Thursday (got {got})")
    wfb._tw_holiday = lambda day: holiday_calls.append((_Clock.at, day)) or day == HOLIDAY

    # ── 2. Friday's bar really late: lands Saturday 13:00 TPE ─────────────────────
    land[date(2026, 10, 16)] = U(17, 5)
    simulate("tws", U(16, 12), U(18))
    check(alerts and alerts[0][1] == U(16) and alerts[0][0] == U(17, 0, 15),
          f"late Friday bar: alerts at Saturday 08:15 TPE on Friday's bar (got {alerts[:1]})")
    fri = [t for t, b in runs if b.date() == date(2026, 10, 16)]
    check(fri == [U(17, 5)], f"…and runs once when it lands (got {fri})")
    land.clear()

    # ── 3. crypto / TXF: plain calendar floor (TXF's own off-session check may ask the table) ──
    for name in ("btc", "txf"):
        bad = []
        for t in (U(17, 1), U(18, 1), U(19, 1), U(21, 1), U(22, 1)):
            os.makedirs("state/bar_wait", exist_ok=True)
            wfb._save_state(name, wfb._default_state())
            del seen[:], holiday_calls[:]
            _Clock.at = t
            cur["type_c"] = False
            wfb._tick(name)
            if seen != [wfb._expected_closed_bar_open("1d", t)] or (name == "btc" and holiday_calls):
                bad.append((t, seen[:], len(holiday_calls)))
        check(not bad, f"{name}: expected bar = calendar floor ({bad})")
        check("tw_bar_map" not in wfb._load_state(name), f"{name}: state file shape unchanged")
finally:
    os.chdir(cwd)
    shutil.rmtree(BASE, ignore_errors=True)

print("\ncheck_tw_stock_bar_calendar: " + ("PASS" if not fails else f"FAILED ({fails})"))
sys.exit(1 if fails else 0)
