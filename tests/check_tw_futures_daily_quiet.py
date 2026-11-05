"""A TAIFEX 1d strategy no longer alerts every morning, and computes exactly as before
(manager/wait_for_bar.py, _tw_fut_daily_quiet).

Trading day D's bar is labelled D 00:00 Taipei (16:00Z the day before); the UTC floor asks for it
from 08:00 D and the api serves it from D 13:46, so 08:15 alerted every trading day (11-03, 11-04 on
a real machine). The real _tick on a fake clock, the feed serving bars as the api does:

  L  the label: fetch_twfutures_ohlcv's Taipei index, through bar_ready's naive_utc, is 16:00Z.
  S  zero signal difference, old (quiet off) vs new, eight days with a weekend, a holiday and a night
     session on every day: the same runs at the same seconds on the same frames, the same signal off
     a real computation on each; last_processed_bar the same. Old alerts daily, new never. Also
     a feed landing at 14:50 (a strategy joined with after-close data), and 15:40.
  T  when it computes: the 13:50 tick (14:00 if the api cache still holds the old answer).
  B  the same ticks as before the quiet existed, pinned to the times the code before it computed at:
     a row landing after the bar (14:52, 15:07) and a machine opened after the bar (13:52).
  C  the calendar: every (now, seen) row incl. weekend, Monday morning, a holiday, Lunar New Year.
  M  really missing: no bar by 16:00 → one alert at 16:15; the day after, again; a bar landing clears
     it; holiday table wrong (the market traded) → waited on; another label convention → old alerting;
     no data yet → old alerting; a crypto 1d never reaches the code.

Run: cd blave-agent && .venv/bin/python tests/check_tw_futures_daily_quiet.py
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

BASE = tempfile.mkdtemp(prefix="tw-fut-daily-")
spec = importlib.util.spec_from_file_location("wfb", os.path.join(ROOT, "manager", "wait_for_bar.py"))
wfb = importlib.util.module_from_spec(spec)
spec.loader.exec_module(wfb)
from lib.bar_ready import naive_utc  # noqa: E402

fails = 0


def check(cond, msg, detail=None):
    global fails
    print(("ok   " if cond else "FAIL ") + msg + ("" if cond or detail is None else f"  {detail}"))
    fails += 0 if cond else 1


TPE = timedelta(hours=8)
M1 = timedelta(minutes=1)
HOLIDAYS = {date(2026, 11, 11)}
wfb._tw_holiday = lambda d, unknown=False: d in HOLIDAYS


def T(mo, d, h=0, mi=0, s=0):
    return datetime(2026, mo, d, h, mi, s) - TPE


def label(d):
    """Trading day d's bar label, naive UTC."""
    return datetime(d.year, d.month, d.day) - TPE


def trading(d):
    return d.weekday() <= 4 and d not in HOLIDAYS


# ── L ────────────────────────────────────────────────────────────────────────
idx = pd.to_datetime(pd.DatetimeIndex([label(date(2026, 11, 4))]), utc=True).tz_convert("Asia/Taipei")
check(idx[0].date() == date(2026, 11, 4) and naive_utc(idx[0]) == datetime(2026, 11, 3, 16, 0),
      "11-04's bar: Taipei date 11-04 in the frame, 11-03 16:00Z to wait_for_bar", naive_utc(idx[0]))

WS = os.path.join(BASE, "ws")
SRC = 'SYMBOL = "TXF"\nINTERVAL = "1d"\nfrom lib.data import fetch_twfutures_ohlcv\ndef fetch_data(h):\n    return fetch_twfutures_ohlcv("TXF", "1d", "2026-01-01", None, h)\n'
for n, src in (("pcr", SRC), ("btc", 'SYMBOL = "BTCUSDT"\nINTERVAL = "1d"\nfrom lib.data import fetch_kline\ndef fetch_data(h):\n    return fetch_kline("BTCUSDT", "1d", "2026-01-01", None, h)\n')):
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
feed = {"served": lambda d: datetime(d.year, d.month, d.day, 13, 46) - TPE, "skip": set(), "labeller": label, "row": None}
alerts, runs = [], []
PRICE = {d: 23000 + 37 * (i % 11) for i, d in enumerate(date(2026, 10, 1) + timedelta(days=x) for x in range(60))}


def frame(now):
    days = [d for d in PRICE if trading(d) and d not in feed["skip"] and feed["served"](d) <= now]
    return pd.DataFrame({"Close": [PRICE[d] for d in days]}, index=[feed["labeller"](d) for d in days])


class RowWait(Exception):
    source = "txf_pcr"

    def __init__(self, last_bar, due_at):
        self.last_bar, self.due_at = last_bar, due_at


wfb._is_feed_wait = lambda e: isinstance(e, RowWait)


def freshness(mod, expected):
    df = frame(Clock.at)
    if df.empty:
        return None, False, None, None
    last = df.index[-1].to_pydatetime()
    if feed["row"]:   # a joined align_feed row: the bars are in, the row lands later
        day = (last + TPE).date()
        if Clock.at < datetime(day.year, day.month, day.day, *feed["row"]) - TPE:
            raise RowWait(last, datetime(day.year, day.month, day.day, 15, 0) - TPE)
    return last, last >= expected, None, {"": last}


def signal_of(df):
    return int(df["Close"].rolling(3).mean().iloc[-1] < df["Close"].iloc[-1])


wfb._check_freshness = freshness
wfb._alert_stale = lambda name, expected, minutes, who, computed=False: alerts.append((Clock.at, minutes))
wfb._run_strategy_protected = lambda name: runs.append((Clock.at, frame(Clock.at).index[-1], signal_of(frame(Clock.at)))) or True


def drive(name, start, end, reset=True, off=()):
    if reset:
        wfb._save_state(name, wfb._default_state())
    del alerts[:], runs[:]
    t = start
    while t < end:
        if not any(a <= t < b for a, b in off):
            Clock.at = t + timedelta(seconds=5)
            wfb._tick(name)
        t += M1
    return wfb._load_state(name)


def tpe(xs):
    return [(x + TPE).strftime("%m-%d %H:%M") for x in xs]


try:
    # ── S ────────────────────────────────────────────────────────────────────
    real_quiet = wfb._tw_fut_daily_quiet

    def both(start, end):
        wfb._tw_fut_daily_quiet = lambda *a: False
        st_old = drive("pcr", start, end)
        old_runs, old_alerts = list(runs), [a for a, _ in alerts]
        wfb._tw_fut_daily_quiet = real_quiet
        st_new = drive("pcr", start, end)
        return old_runs, old_alerts, st_old, list(runs), [a for a, _ in alerts], st_new

    START, END = T(11, 5, 16), T(11, 13, 16)
    for lands, name in ((lambda d: datetime(d.year, d.month, d.day, 13, 46) - TPE, "the api's 13:46"),
                        (lambda d: datetime(d.year, d.month, d.day, 14, 50) - TPE, "14:50 (joined with after-close data)"),
                        (lambda d: datetime(d.year, d.month, d.day, 15, 40) - TPE, "15:40")):
        feed["served"] = lands
        old_r, old_a, st_o, new_r, new_a, st_n = both(START, END)
        # the first bar lands at a fresh state: skip nothing, compare everything
        check(old_r == new_r and len(new_r) >= 5, f"{name}: the same runs, same second, same bar, same signal ({len(new_r)})",
              [x for x in zip(tpe(a for a, *_ in old_r), tpe(a for a, *_ in new_r)) if x[0] != x[1]][:4])
        check(st_o["last_processed_bar"] == st_n["last_processed_bar"], f"{name}: the same last_processed_bar")
        check(old_a and not new_a, f"{name}: old alerts {len(old_a)} times, new never", tpe(new_a)[:4])
        if "13:46" in name:
            check({(a + TPE).strftime("%H:%M") for a in old_a if (a + TPE).weekday() <= 4 and (a + TPE).date() != date(2026, 11, 12)} <= {"08:15"},
                  "…old: the 08:15 of the real machine", sorted({(a + TPE).strftime("%H:%M") for a in old_a}))
            at = {(r[0] + TPE).strftime("%H:%M") for r in new_r[1:]}   # new_r[0]: the fresh state's first look
            # ── T ────────────────────────────────────────────────────────────
            check(at == {"13:50"}, f"T: computed on the 13:50 tick of the day, the throttle's first past 13:46 (14:00 when the api's 5-minute cache still holds it) → {sorted(at)}")
            days = {(r[0] + TPE).date() for r in new_r}
            check(all(trading(d) for d in days), "T: on trading days only, nothing on the weekend or the holiday", sorted(days))
            check(all((r[1] + TPE).date() == (r[0] + TPE).date() for r in new_r), "T: each run on that same day's bar")

    # ── B ────────────────────────────────────────────────────────────────────
    feed["served"] = lambda d: datetime(d.year, d.month, d.day, 13, 46) - TPE
    B_START, B_END, B_DAYS = T(11, 2, 16), T(11, 6, 16), (3, 4, 5, 6)
    CASES = (("always on, a plain bar", None, (), "13:50"),
             ("always on, the row lands 14:52", (14, 52), (), "14:52"),
             ("always on, the row lands 15:07", (15, 7), (), "15:07"),
             ("opened at 13:52 every day, the bar already in", None, [(T(11, d), T(11, d, 13, 52)) for d in B_DAYS], "13:52"),
             ("opened at 09:00 every day", None, [(T(11, d), T(11, d, 9)) for d in B_DAYS], "13:50"))
    for cname, row, off, want in CASES:
        feed["row"] = row
        drive("pcr", B_START, B_END, off=off)
        got = [(r[0] + TPE).strftime("%m-%d %H:%M") for r in runs[1:]]   # runs[0]: the fresh state's first look
        check(got == [f"11-{d:02d} {want}" for d in B_DAYS], f"B {cname}: computed at {want}, the old tick", got)
        new_times = list(runs)
        wfb._tw_fut_daily_quiet = lambda *a: False
        drive("pcr", B_START, B_END, off=off)
        wfb._tw_fut_daily_quiet = real_quiet
        check([r[:2] for r in runs] == [r[:2] for r in new_times], f"B {cname}: to the second, quiet on or off", tpe(r[0] for r in runs)[:5])
    feed["row"] = None

    # ── C ────────────────────────────────────────────────────────────────────
    q = lambda seen, now: wfb._tw_fut_daily_quiet(label(seen).isoformat() if isinstance(seen, date) else seen, now, wfb._tw_holiday)
    W = date
    ROWS = [
        (W(2026, 11, 3), T(11, 4, 8, 0), True, "Wed 08:00, Tue's bar in"),
        (W(2026, 11, 3), T(11, 4, 8, 15), True, "Wed 08:15 (the false alarm)"),
        (W(2026, 11, 3), T(11, 4, 13, 59), True, "Wed 13:59"),
        (W(2026, 11, 3), T(11, 4, 15, 59), True, "Wed 15:59"),
        (W(2026, 11, 3), T(11, 4, 16, 0), False, "Wed 16:00, Wed's bar still not in: late"),
        (W(2026, 11, 3), T(11, 5, 2, 0), False, "Thu 02:00, night session, Wed's bar not in"),
        (W(2026, 11, 4), T(11, 5, 2, 0), True, "Thu 02:00, night session, Wed's bar in"),
        (W(2026, 11, 2), T(11, 4, 8, 15), False, "Wed 08:15 but Tue's bar never came: late"),
        (W(2026, 11, 6), T(11, 7, 3, 0), True, "Sat 03:00, Friday night session"),
        (W(2026, 11, 6), T(11, 7, 8, 15), True, "Sat 08:15"),
        (W(2026, 11, 6), T(11, 8, 12, 0), True, "Sunday"),
        (W(2026, 11, 6), T(11, 9, 8, 15), True, "Mon 08:15, Friday's bar is the newest due"),
        (W(2026, 11, 6), T(11, 9, 16, 0), False, "Mon 16:00, Monday's not in"),
        (W(2026, 11, 5), T(11, 7, 8, 15), False, "Sat 08:15, Friday's never came"),
        (W(2026, 11, 10), T(11, 11, 16, 30), True, "holiday 11-11 afternoon: Tue's is the newest due"),
        (W(2026, 11, 10), T(11, 12, 8, 15), True, "Thu after the holiday, morning"),
        (W(2026, 11, 10), T(11, 12, 16, 0), False, "Thu 16:00, Thu's not in"),
    ]
    bad = [r[3] for r in ROWS if q(r[0], r[1]) is not r[2]]
    check(not bad, f"calendar rows ({len(ROWS)})", bad)
    lny = {date(2026, 2, 12), date(2026, 2, 13)} | {date(2026, 2, d) for d in range(15, 21)}
    HOLIDAYS.update(lny)
    check(q(date(2026, 2, 11), T(2, 21, 10)) and q(date(2026, 2, 11), T(2, 23, 15)) and not q(date(2026, 2, 11), T(2, 23, 16)),
          "Lunar New Year: quiet through the closure and to the reopening day's 16:00")
    HOLIDAYS.difference_update(lny)
    check(not q(None, T(11, 4, 9)) and not q("x", T(11, 4, 9)), "no data yet, a foreign state value: not quiet")
    check(not q("2026-11-03T00:00:00", T(11, 4, 9)), "a label at UTC midnight (another convention): not quiet, old alerting")
    check(not q(date(2026, 11, 7), T(11, 9, 9)), "a seen bar on a Saturday (the calendar is wrong): not quiet")
    check(not q(date(2026, 11, 11), T(11, 12, 9)), "a seen bar on a table holiday (the table is wrong): not quiet")

    # ── M ────────────────────────────────────────────────────────────────────
    feed["served"] = lambda d: datetime(d.year, d.month, d.day, 13, 46) - TPE
    feed["skip"] = {date(2026, 11, 4)}
    drive("pcr", T(11, 3, 15), T(11, 4, 18))
    check(tpe(a for a, _ in alerts) == ["11-04 16:15"], f"Wed's bar never comes: one alert, 16:15 → {tpe(a for a, _ in alerts)}")
    feed["skip"] = set()
    st = drive("pcr", T(11, 3, 15), T(11, 4, 12))
    feed["skip"] = {date(2026, 11, 4), date(2026, 11, 5)}
    st = drive("pcr", T(11, 4, 12), T(11, 5, 18), reset=False)
    check(tpe(a for a, _ in alerts) == ["11-04 16:15", "11-05 16:15"],
          f"…the next day still missing: nothing more until the 24-hour repeat → {tpe(a for a, _ in alerts)}")
    feed["skip"] = set()
    st = drive("pcr", T(11, 5, 18), T(11, 6, 15), reset=False)
    check(st["stall_alert_at"] is None and st["pending_since"] is None and runs,
          "…the bars land: run, the stall cleared", (st["stall_alert_at"], st["pending_since"]))

    feed["labeller"] = lambda d: datetime(d.year, d.month, d.day)   # labelled at UTC midnight of the date
    drive("pcr", T(11, 3, 15), T(11, 5, 15))
    check(wfb._load_state("pcr").get("last_processed_bar") and runs, "another label convention: still runs (the quiet never decides a run)")
    feed["labeller"] = label

    calls = []
    orig = wfb._tw_fut_daily_quiet
    wfb._tw_fut_daily_quiet = lambda *a: calls.append(1) or orig(*a)
    st = drive("btc", T(11, 3, 15), T(11, 5, 15))
    check(not calls and not any(k.startswith("tw_fut") for k in st), "a crypto 1d never reaches the code, no new state key")
    wfb._tw_fut_daily_quiet = orig
finally:
    os.chdir(ROOT)
    shutil.rmtree(BASE, ignore_errors=True)

print("\ncheck_tw_futures_daily_quiet: " + ("PASS" if not fails else f"FAILED ({fails})"))
sys.exit(1 if fails else 0)
