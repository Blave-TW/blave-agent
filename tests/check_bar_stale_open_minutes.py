"""bar_stale's 「等了 N 分鐘」 counts only time the market was open (manager/wait_for_bar.py,
_open_minutes; 0.1.56 roadmap: the event row read thousands of minutes across a weekend).

  U  the counter itself: TAIFEX index day + night, stock futures day only (night with lots_night),
     TWSE 09:00–13:30 (also TWSE daily bars), weekends, a holiday, the night after midnight belonging
     to the session that opened the day before. Daily bars and align_feed rows count the same sessions.
  S  which counter each market gets (_session_minutes): TWSE daily asks the holiday table, US daily
     counts NYSE 09:30–16:00 New York (holidays, DST), crypto keeps the wall clock.
  L  the lag alert (_track_lag → _alert_lag) reports session minutes too; crypto stays wall clock.
  E  end to end on the real _tick with a fake clock: a TXF daily strategy whose Friday bar never
     comes: the same alerts at the same times; Friday's stays 15 (late_after_mute), the 24-hour repeats
     on Saturday and Sunday used to say 1515 / 2955 (wall clock since Friday 15:00) and now say 839
     (Friday's night session only). A crypto 1d keeps the wall clock.

Run: cd blave-agent && .venv/bin/python tests/check_bar_stale_open_minutes.py
"""
import importlib.util
import json
import os
import shutil
import sys
import tempfile
import types
from datetime import date, datetime, timedelta

import pandas as pd

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
import dotenv
dotenv.dotenv_values = lambda *a, **k: {}

BASE = tempfile.mkdtemp(prefix="bar-stale-open-")
spec = importlib.util.spec_from_file_location("wfb", os.path.join(ROOT, "manager", "wait_for_bar.py"))
wfb = importlib.util.module_from_spec(spec)
spec.loader.exec_module(wfb)

fails = 0


def check(cond, msg, detail=None):
    global fails
    print(("ok   " if cond else "FAIL ") + msg + ("" if cond or detail is None else f"  {detail}"))
    fails += 0 if cond else 1


TPE = timedelta(hours=8)
M1 = timedelta(minutes=1)
HOLIDAYS = {date(2026, 11, 11)}
wfb._tw_holiday = lambda d, unknown=False: d in HOLIDAYS
hol = lambda d: d in HOLIDAYS


def T(mo, d, h=0, mi=0):
    """Taipei wall time → naive UTC."""
    return datetime(2026, mo, d, h, mi) - TPE


om = wfb._open_minutes

# ── U ────────────────────────────────────────────────────────────────────────
# 2026-11-06 is a Friday, 11-09 a Monday, 11-11 (Wed) on the table.
check(om("index", T(11, 6, 13, 20), T(11, 6, 13, 50)) == 25, "TXF: 13:20 → 13:50 counts to the 13:45 close (25)")
check(om("index", T(11, 6, 13, 40), T(11, 9, 9, 0)) == 5 + 14 * 60 + 15,
      "TXF Fri 13:40 → Mon 09:00: 5 day + the Friday night to Sat 05:00 + Mon 08:45–09:00; no weekend",
      om("index", T(11, 6, 13, 40), T(11, 9, 9, 0)))
check(om("index", T(11, 7, 2, 0), T(11, 7, 6, 0)) == 3 * 60, "Sat 02:00 → 06:00: the night that opened Friday runs to 05:00 (180)")
check(om("lots", T(11, 6, 13, 40), T(11, 9, 9, 0)) == 20, "stock futures, no night session: 5 + 15 (20)")
check(om("lots", T(11, 6, 17, 0), T(11, 6, 18, 0), lots_night=True) == 35, "stock futures with a night session: from 17:25 (35)")
check(om("stock", T(11, 6, 13, 0), T(11, 9, 9, 30)) == 30 + 30, "TWSE: Fri 13:00–13:30 + Mon 09:00–09:30 (60)")
check(om("index", T(11, 10, 13, 0), T(11, 12, 9, 0), hol) == 45 + 14 * 60 + 15,
      "a holiday Wednesday counts nothing (Tue day 45 + Tue night 840 + Thu 08:45–09:00 15); its eve's night stays (not known)",
      om("index", T(11, 10, 13, 0), T(11, 12, 9, 0), hol))
check(om("stock", T(11, 6, 15, 0), T(11, 9, 16, 15)) == 4 * 60 + 30, "TWSE daily (a wait that starts after the close): only Monday's 09:00–13:30 counts")
check(om("stock", T(11, 10, 20, 0), T(11, 12, 10, 0), hol) == 60, "TWSE: the holiday Wednesday counts nothing (Thu 09:00–10:00)")
check(om("day", T(11, 6, 15, 0), T(11, 6, 15, 0)) == 0 and om("index", T(11, 7, 9, 0), T(11, 8, 20, 0)) == 0,
      "an empty span, and a whole weekend, are 0")

# ── S: which counter each market gets (_session_minutes; audit 0156 C-3) ─────────────────────
sm = getattr(wfb, "_session_minutes", None)
check(sm is not None and sm(T(11, 10, 20, 0), T(11, 12, 10, 0), None, True, False) == 60,
      "TWSE daily: the holiday table is asked (holiday Wednesday counts nothing; Thu 09:00–10:00 = 60)",
      sm and sm(T(11, 10, 20, 0), T(11, 12, 10, 0), None, True, False))
check(sm is not None and sm(T(11, 6), T(11, 9), None, False, False) is None, "crypto: None (the wall clock stands)")
us = sm and (lambda a, b: sm(a, b, None, False, True))
U = lambda d, h, mi=0: datetime(2026, 11, d, h, mi)   # naive UTC; New York is UTC-5 after 11-01
check(us is not None and us(U(6, 22), U(9, 15, 30)) == 60,
      "US daily: Fri 17:00 → Mon 10:30 New York counts Monday 09:30–10:30 only (60)", us and us(U(6, 22), U(9, 15, 30)))
check(us is not None and us(U(25, 22), U(27, 15, 30)) == 60,
      "US daily: Thanksgiving (11-26) counts nothing (Fri 09:30–10:30 = 60)", us and us(U(25, 22), U(27, 15, 30)))
check(us is not None and us(datetime(2026, 10, 30, 13, 0), U(2, 15, 30)) == 390 + 60,
      "US daily across the DST change: Fri 13:30–20:00 UTC (EDT, 390) + Mon 14:30–15:30 UTC (EST, 60)",
      us and us(datetime(2026, 10, 30, 13, 0), U(2, 15, 30)))

# ── L: the lag alert counts the same sessions (_track_lag → _alert_lag; audit 0156 C-2) ──────
lag = []
real_lag = wfb._alert_lag
wfb._alert_lag = lambda name, minutes, who: lag.append(minutes)


def lag_minutes(tw_kind, since, now):
    del lag[:]
    st = {"lag_since": since.isoformat(), "lag_seen_at": (now - M1).isoformat(), "last_processed_bar": (since - M1).isoformat(),
          "computed_bar": None, "stall_alert_at": None, "lag_alert_at": None}
    try:
        wfb._track_lag("x", st, now, M1, now - M1, "TXF", tw_kind=tw_kind)
    except TypeError as e:   # an older _track_lag: no session arguments
        return repr(e)
    return lag[0] if lag else None


got = lag_minutes("index", T(11, 6, 13, 40), T(11, 9, 9, 0))
check(got == 5 + 14 * 60 + 15, "TXF 1m lag held Fri 13:40 → Mon 09:00: 860 session minutes, not 3 days of wall clock", got)
got = lag_minutes(None, T(11, 6, 13, 40), T(11, 6, 14, 40))
check(got == 60, "crypto lag: the wall clock (60)", got)
wfb._alert_lag = real_lag

# ── E ────────────────────────────────────────────────────────────────────────
WS = os.path.join(BASE, "ws")
SRC = 'SYMBOL = "TXF"\nINTERVAL = "1d"\nfrom lib.data import fetch_twfutures_ohlcv\ndef fetch_data(h):\n    return fetch_twfutures_ohlcv("TXF", "1d", "2026-01-01", None, h)\n'
BTC = 'SYMBOL = "BTCUSDT"\nINTERVAL = "1d"\nfrom lib.data import fetch_kline\ndef fetch_data(h):\n    return fetch_kline("BTCUSDT", "1d", "2026-01-01", None, h)\n'
for n, src in (("pcr", SRC), ("btc", BTC)):
    os.makedirs(os.path.join(WS, "strategies", n))
    open(os.path.join(WS, "strategies", n, "strategy.py"), "w").write(src)
os.makedirs(os.path.join(WS, "manager"))
json.dump({}, open(os.path.join(WS, "manager", "portfolio_config.json"), "w"))
os.makedirs(os.path.join(WS, "state", "bar_wait"))
os.chdir(WS)


class Clock(datetime):
    at = T(11, 2)

    @classmethod
    def now(cls, tz=None):
        return cls.at.replace(tzinfo=tz) if tz else cls.at


wfb.datetime = Clock
wfb.time = types.SimpleNamespace(time=lambda: (Clock.at - datetime(1970, 1, 1)).total_seconds(),
                                 monotonic=lambda: 0.0, sleep=lambda s: None)
mods, load = {}, wfb._load_strategy_module
wfb._load_strategy_module = lambda n: mods.get(n) or mods.setdefault(n, load(n))
skip = set()
alerts = []


def trading(d):
    return d.weekday() <= 4 and d not in HOLIDAYS


def tw_frame(now):
    days = [date(2026, 10, 1) + timedelta(days=x) for x in range(60)]
    days = [d for d in days if trading(d) and d not in skip and datetime(d.year, d.month, d.day, 13, 46) - TPE <= now]
    return pd.DataFrame({"Close": [1.0] * len(days)}, index=[datetime(d.year, d.month, d.day) - TPE for d in days])


def btc_frame(now):
    last = datetime(2026, 11, 6)   # the Friday 00:00Z bar, then nothing
    return pd.DataFrame({"Close": [1.0]}, index=[last])


def freshness(mod, expected):
    df = (btc_frame if getattr(mod, "SYMBOL", "") == "BTCUSDT" else tw_frame)(Clock.at)
    if df.empty:
        return None, False, None, None
    last = df.index[-1].to_pydatetime()
    return last, last >= expected, None, {"": last}


wfb._check_freshness = freshness
wfb._alert_stale = lambda name, expected, minutes, who, computed=False: alerts.append(((Clock.at + TPE).strftime("%m-%d %H:%M"), minutes))
wfb._run_strategy_protected = lambda name: True


def drive(name, start, end):
    wfb._save_state(name, wfb._default_state())
    del alerts[:]
    t = start
    while t < end:
        Clock.at = t + timedelta(seconds=5)
        wfb._tick(name)
        t += M1


try:
    skip.add(date(2026, 11, 6))
    drive("pcr", T(11, 6, 15, 0), T(11, 9, 16, 30))
    new = list(alerts)
    real = wfb._open_minutes
    wfb._open_minutes = lambda kind, since, now, *a: int((now - since).total_seconds() // 60)   # the wall clock it replaced
    drive("pcr", T(11, 6, 15, 0), T(11, 9, 16, 30))
    old = list(alerts)
    wfb._open_minutes = real
    check([a for a, _ in new] == [a for a, _ in old] == ["11-06 16:15", "11-07 16:15", "11-08 16:15"],
          "TXF daily, Friday's bar never comes: the same alerts at the same times as before", (new, old))
    check([m for _, m in old] == [15, 1515, 2955] and [m for _, m in new] == [15, 839, 839],
          "…Friday's stays 15 (late_after_mute); the weekend repeats said 1515 / 2955, now 839 (Friday's night session 15:00:05–05:00 only)", (old, new))
    skip.clear()

    calls = []
    wfb._open_minutes = lambda *a: calls.append(a) or real(*a)
    drive("btc", T(11, 7, 8, 0), T(11, 9, 9, 0))
    wfb._open_minutes = real
    check(alerts and not calls, "crypto 1d: alerts on the wall clock, the open-time counter never asked", (alerts, len(calls)))

finally:
    os.chdir(ROOT)
    shutil.rmtree(BASE, ignore_errors=True)

print("\ncheck_bar_stale_open_minutes: " + ("PASS" if not fails else f"FAILED ({fails})"))
sys.exit(1 if fails else 0)
