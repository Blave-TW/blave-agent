"""TWSE/TPEx intraday strategies are quiet after the close (manager/wait_for_bar.py, _tw_stock_minute,
_tw_stock_bar_exists, _tw_fut_quiet with kind "stock").

29026's canary_2330_1m (1m, fetch_twstock_ohlcv) sent bar_stale at 13:47 Taipei, 15 minutes: the
13:30 closing-auction bar landed at 13:31, the wall clock moved on to 13:31.. bars that never come.
Asserted here:

  1. _tw_stock_bar_exists against Blave's real labels: tests/fixtures/twstock_bar_labels.json is
     2330's 1m cache 2026-07-01..08-06 and its 5m..60m buckets. No observed label is judged
     missing; judged-but-absent is only 13:25–13:29 (counted on purpose) and one untraded minute.
  2. the known rows (1m 13:24 / 13:30 exist, 13:31 / 13:25-as-counted; 60m 13:00 holds 13:30,
     14:00 not; weekends; holidays), and a version that drops the 13:30 auction bar fails them.
  3. the real _tick on a fake clock: the 13:47 alert gone, pending_since None 13:31–13:59, polled
     on the throttle minutes only; the 13:30 bar missing still alerts; weekend and holiday 0
     alerts; the next open's 09:00 bar runs at 09:01 and, missing, alerts at 09:16; a wrong
     holiday table still runs every bar; 5m/30m/60m closes; a strategy mixing in a crypto price
     keeps the old alert; a crypto strategy never asks the table.

Run: cd blave-agent && .venv/bin/python tests/check_tw_stock_quiet.py
     BAR_WAIT_UNDER_TEST=<path to another wait_for_bar.py> runs the same checks against that copy
     (an older one has no _tw_stock_bar_exists: sections 1–2 FAIL, section 3 shows its alerts).
"""
import importlib.util
import json
import os
import shutil
import sys
import tempfile
import types
from collections import Counter
from datetime import date, datetime, timedelta

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

import dotenv
dotenv.dotenv_values = lambda *a, **k: {}   # never read the workspace .env

BASE = tempfile.mkdtemp(prefix="tw-stock-quiet-")
stub_bin = os.path.join(BASE, "bin")
os.makedirs(stub_bin)
with open(os.path.join(stub_bin, "crontab"), "w") as f:
    f.write("#!/bin/sh\nexit 0\n")
os.chmod(os.path.join(stub_bin, "crontab"), 0o755)
os.environ["PATH"] = stub_bin + os.pathsep + os.environ.get("PATH", "")

spec = importlib.util.spec_from_file_location(
    "wfb", os.environ.get("BAR_WAIT_UNDER_TEST") or os.path.join(ROOT, "manager", "wait_for_bar.py"))
wfb = importlib.util.module_from_spec(spec)
spec.loader.exec_module(wfb)

fails = 0


def check(cond, msg):
    global fails
    print(("ok   " if cond else "FAIL ") + msg)
    fails += 0 if cond else 1


TPE = timedelta(hours=8)
M1 = timedelta(minutes=1)
HOLIDAYS = set()
asked = []


def hol(d):
    asked.append(d)
    return d in HOLIDAYS


def T(mo, d, h, mi=0):
    """Taipei wall time (2026) → naive UTC (what the module works in)."""
    return datetime(2026, mo, d, h, mi) - TPE


STEP = {"1m": 1, "5m": 5, "15m": 15, "30m": 30, "60m": 60}
FIX = json.load(open(os.path.join(ROOT, "tests", "fixtures", "twstock_bar_labels.json")))


def runs_to_minutes(runs, step):
    out = []
    for run in runs.split(","):
        a, _, b = run.partition("-")
        ha, ma = map(int, a.split(":"))
        hb, mb = map(int, (b or a).split(":"))
        out += range(ha * 60 + ma, hb * 60 + mb + 1, step)
    return out


def observed(sch):
    return {datetime.fromisoformat(d) + timedelta(minutes=m)
            for d, runs in FIX["series"][sch].items() for m in runs_to_minutes(runs, STEP[sch])}


# a full trading day's labels per schema: the most common day in the cache
FULL_DAY = {sch: runs_to_minutes(Counter(FIX["series"][sch].values()).most_common(1)[0][0], STEP[sch])
            for sch in STEP}

have = hasattr(wfb, "_tw_stock_bar_exists")
check(have, "wait_for_bar has _tw_stock_bar_exists")


def exists(mo, d, h, mi, td_min):
    return wfb._tw_stock_bar_exists(T(mo, d, h, mi), timedelta(minutes=td_min), hol)


# ── 1. against the cache's real labels ─────────────────────────────────────────
NO_DATA = {date(2026, 7, 10)}   # a weekday the cache has no bars for; left out, not called a holiday


def fixture_failures():
    bad = []
    for sch, step in STEP.items():
        td = timedelta(minutes=step)
        obs = observed(sch)
        pred, t = set(), datetime(2026, 7, 1)
        while t < datetime(2026, 8, 7):
            if t.date() not in NO_DATA and wfb._tw_stock_bar_exists(t - TPE, td, hol):
                pred.add(t)
            t += td
        missed = sorted(obs - pred)
        extra = sorted(x for x in pred - obs if not (sch in ("1m", "5m") and "13:25" <= x.strftime("%H:%M") <= "13:29"))
        if missed:
            bad.append(f"{sch} missed {[str(x) for x in missed[:3]]}")
        if len(extra) > (1 if sch == "1m" else 0):   # 1m: 07-03 10:56 untraded
            bad.append(f"{sch} extra {[str(x) for x in extra[:3]]}")
    return bad


if have:
    bad = fixture_failures()
    check(not bad, f"fixture: every observed label judged existing, nothing else but 13:25–13:29 "
                   f"and 07-03 10:56 (untraded) ({sum(len(v) for v in FIX['series'].values())} day-series)"
                   + (f" — {bad}" if bad else ""))

# ── 2. the known rows ─────────────────────────────────────────────────────────
KNOWN = [  # Taipei (mo, d, h, mi), td minutes, want, label — 10-27 Tue
    ((10, 27, 8, 59), 1, False, "1m 08:59"),
    ((10, 27, 9, 0), 1, True, "1m 09:00 (start label, first bar)"),
    ((10, 27, 13, 24), 1, True, "1m 13:24 (last continuous minute)"),
    ((10, 27, 13, 27), 1, True, "1m 13:27 counted (call auction; TAIEX prints it)"),
    ((10, 27, 13, 30), 1, True, "1m 13:30 (closing auction)"),
    ((10, 27, 13, 31), 1, False, "1m 13:31"),
    ((10, 27, 13, 59), 1, False, "1m 13:59"),
    ((10, 27, 13, 30), 5, True, "5m 13:30"),
    ((10, 27, 13, 35), 5, False, "5m 13:35"),
    ((10, 27, 13, 30), 15, True, "15m 13:30 (the auction alone)"),
    ((10, 27, 13, 45), 15, False, "15m 13:45"),
    ((10, 27, 13, 30), 30, True, "30m 13:30"),
    ((10, 27, 14, 0), 30, False, "30m 14:00"),
    ((10, 27, 13, 0), 60, True, "60m 13:00 (holds 13:30)"),
    ((10, 27, 14, 0), 60, False, "60m 14:00"),
    ((10, 27, 8, 0), 60, False, "60m 08:00"),
    ((10, 27, 9, 0), 60, True, "60m 09:00"),
    ((10, 24, 10, 0), 60, False, "Saturday 10:00"),
    ((10, 25, 9, 0), 1, False, "Sunday 09:00"),
    ((10, 26, 9, 0), 1, True, "Monday 09:00"),
    ((10, 28, 10, 0), 60, False, "holiday 10-28 10:00"),
    ((10, 28, 13, 30), 1, False, "holiday 10-28 13:30"),
    ((10, 29, 9, 0), 1, True, "the day after the holiday 09:00"),
]


def known_failures():
    HOLIDAYS.add(date(2026, 10, 28))
    try:
        return [label for (mo, d, h, mi), tdm, want, label in KNOWN if exists(mo, d, h, mi, tdm) is not want]
    finally:
        HOLIDAYS.discard(date(2026, 10, 28))


if have:
    bad = known_failures()
    check(not bad, f"known rows ({len(KNOWN)}) hold" + (f" — {bad}" if bad else ""))
    BEFORE = [  # expected (Taipei), td minutes, want (Taipei) — the last existing bar before it
        ((10, 27, 13, 31), 1, (10, 27, 13, 30)),
        ((10, 28, 8, 59), 1, (10, 27, 13, 30)),
        ((10, 27, 14, 0), 60, (10, 27, 13, 0)),
        ((10, 28, 8, 0), 60, (10, 27, 13, 0)),
        ((10, 27, 14, 0), 30, (10, 27, 13, 30)),
        ((10, 27, 13, 35), 5, (10, 27, 13, 30)),
        ((10, 26, 8, 59), 1, (10, 23, 13, 30)),   # Monday morning → Friday's close
    ]
    got = [(e, wfb._tw_stock_last_bar_before(T(*e), timedelta(minutes=m), hol)) for e, m, _ in BEFORE]
    check(all(g == T(*w) for (_, g), (_, _, w) in zip(got, BEFORE)),
          f"last bar before ({len(BEFORE)} rows) → {[(e, str(g + TPE) if g else None) for e, g in got]}")
    HOLIDAYS.add(date(2026, 10, 28))
    g = wfb._tw_stock_last_bar_before(T(10, 29, 8, 59), M1, hol)
    HOLIDAYS.discard(date(2026, 10, 28))
    check(g == T(10, 27, 13, 30), f"…over the 10-28 holiday → 10-27 13:30 ({g and g + TPE})")

    # the rule broken: the 13:30 closing auction left out of the session
    close = wfb._TW_STOCK_CLOSE
    wfb._TW_STOCK_CLOSE = 13 * 60 + 30
    wrong_known, wrong_fix = known_failures(), fixture_failures()
    wfb._TW_STOCK_CLOSE = close
    check("1m 13:30 (closing auction)" in wrong_known and wrong_fix,
          f"a session without the 13:30 auction fails the known rows ({wrong_known}) and the fixture")

# ── 3. the real _tick on a fake clock ─────────────────────────────────────────
WS = os.path.join(BASE, "ws")
STOCK = ('SYMBOL = "2330"\nINTERVAL = "{iv}"\nfrom lib.data import fetch_twstock_ohlcv\n'
         'def fetch_data(h):\n    return fetch_twstock_ohlcv(SYMBOL, "{iv}", h)\n')
for n, src in (("s1", STOCK.format(iv="1m")), ("s5", STOCK.format(iv="5m")),
               ("s30", STOCK.format(iv="30m")), ("s60", STOCK.format(iv="60m")),
               ("slots", STOCK.format(iv="1m")),
               ("smix", 'INTERVAL = "1m"\nfrom lib.data import fetch_twstock_ohlcv, fetch_kline\n'
                        'def fetch_data(h):\n    return fetch_twstock_ohlcv("2330", "1m", h), '
                        'fetch_kline("BTCUSDT", "1m", "2026-01-01", None, h)\n'),
               ("btc", 'SYMBOL = "BTCUSDT"\nINTERVAL = "1m"\nfrom lib.data import fetch_kline\n'
                       'def fetch_data(h):\n    return fetch_kline(SYMBOL, "1m", "2026-01-01", None, h)\n')):
    os.makedirs(os.path.join(WS, "strategies", n))
    open(os.path.join(WS, "strategies", n, "strategy.py"), "w").write(src)
os.makedirs(os.path.join(WS, "manager"))
json.dump({"amounts": {"slots": 1}, "exchanges": {"slots": ""},
           "asset_specs": {"slots": {"type": "futures_contracts", "contract_value": 2000}}},
          open(os.path.join(WS, "manager", "portfolio_config.json"), "w"))
os.makedirs(os.path.join(WS, "state", "bar_wait"))
cwd = os.getcwd()
os.chdir(WS)
wfb._tw_holiday = hol
try:
    class _Clock(datetime):
        at = T(10, 27, 10)

        @classmethod
        def now(cls, tz=None):
            return cls.at.replace(tzinfo=tz) if tz else cls.at
    wfb.datetime = _Clock
    wfb.time = types.SimpleNamespace(time=lambda: (_Clock.at - datetime(1970, 1, 1)).total_seconds(),
                                     monotonic=lambda: 0.0, sleep=lambda s: None)
    mods, load = {}, wfb._load_strategy_module
    wfb._load_strategy_module = lambda n: mods.get(n) or mods.setdefault(n, load(n))
    feed = {"labels": [], "td": M1}
    fetches, alerts, runs, states = [], [], [], []

    def freshness(mod, expected):
        now = _Clock.at
        fetches.append(now)
        seen = [x for x in feed["labels"] if x + feed["td"] <= now]   # api drops the forming bar
        last = max(seen) if seen else None
        return last, last is not None and last >= expected, None, ({"": last} if last else None)
    wfb._check_freshness = freshness
    wfb._alert_stale = lambda name, expected, minutes, who, computed=False: alerts.append((_Clock.at, minutes))
    wfb._run_strategy_protected = lambda name: runs.append(_Clock.at) or True

    def labels(sch, first, last, skip=()):
        """Taipei dates first..last, every weekday off HOLIDAYS, a full day's labels as naive UTC."""
        out, d = [], first
        while d <= last:
            if d.weekday() <= 4 and d not in HOLIDAYS:
                base = datetime(d.year, d.month, d.day) - TPE
                out += [base + timedelta(minutes=m) for m in FULL_DAY[sch]]
            d += timedelta(days=1)
        return sorted(x for x in out if x not in skip)

    def drive(name, start, end, reset=True):
        if reset:
            wfb._save_state(name, wfb._default_state())
        del fetches[:], alerts[:], runs[:], states[:]
        t = start
        while t < end:
            _Clock.at = t + timedelta(seconds=10)
            wfb._tick(name)
            states.append((t, wfb._load_state(name)))
            t += M1
        return wfb._load_state(name)

    def tpe(xs):
        return [(x + TPE).strftime("%m-%d %H:%M") for x in xs]

    def shown():
        return [(s, m) for s, m in zip(tpe(a for a, _ in alerts), (m for _, m in alerts))]

    D = lambda mo, d: date(2026, mo, d)

    # 29026's case: 1m, Tue 10-27 13:00 → 15:00, every bar in
    feed.update(labels=labels("1m", D(10, 26), D(10, 27)), td=M1)
    st = drive("s1", T(10, 27, 13, 0), T(10, 27, 15, 0))
    check(not alerts, f"1m close, every bar in: no bar_stale (29026: 13:47, 15 minutes) → {shown()}")
    check(T(10, 27, 13, 31) in [r.replace(second=0) for r in runs] and st["last_seen_bar"] == T(10, 27, 13, 30).isoformat(),
          f"…the 13:30 closing-auction bar runs at 13:31 → {tpe(runs[-2:])}")
    window = [s for t, s in states if T(10, 27, 13, 31) <= t < T(10, 27, 14, 0)]
    check(window and all(s["pending_since"] is None for s in window),
          f"…pending_since None on every tick 13:31–13:59 → {sorted({s['pending_since'] for s in window if s['pending_since']})[:2]}")
    after = [x for x in fetches if x >= T(10, 27, 13, 32)]
    check(after and all((x + TPE).minute % 15 in (0, 5) for x in after),
          f"…after the close it fetches only on the throttle minutes → {tpe(after[:6])}")

    # the 13:30 bar never comes: still alerts (the wait from 13:26, the call-auction minutes counted)
    feed.update(labels=labels("1m", D(10, 26), D(10, 27), skip={T(10, 27, 13, 30)}), td=M1)
    drive("s1", T(10, 27, 13, 0), T(10, 27, 15, 0))
    check(len(alerts) == 1 and alerts[0][0] <= T(10, 27, 13, 47) + timedelta(seconds=10),
          f"1m, the 13:30 bar missing: one alert by 13:47 → {shown()}")

    # 13:30 → the next morning's open, every bar in
    feed.update(labels=labels("1m", D(10, 26), D(10, 28)), td=M1)
    drive("s1", T(10, 27, 13, 0), T(10, 28, 9, 30))
    first = [r for r in runs if r > T(10, 28, 8)][:1]
    check(not alerts and tpe(first) == ["10-28 09:01"],
          f"1m next open: no alert overnight, the 09:00 bar runs at 09:01 (not throttled to 09:05) → "
          f"{shown()} {tpe(first)}")
    st0900 = [s for t, s in states if t == T(10, 28, 9, 0)][0]
    check(st0900["pending_since"] is None, "…09:00 tick (expected 08:59, none) is quiet")

    # the open's first bar does not come: timed from its own due minute
    feed.update(labels=labels("1m", D(10, 26), D(10, 28), skip={T(10, 28, 9, 0)}), td=M1)
    feed["labels"] = [x for x in feed["labels"] if x < T(10, 28, 9)]
    drive("s1", T(10, 27, 13, 0), T(10, 28, 9, 30))
    check(shown()[:1] == [("10-28 09:16", 15)], f"1m 09:00 bar missing: alert 09:16, waited 15 → {shown()}")

    # a weekend: Fri 10-23 13:00 → Mon 10-26 09:30
    feed.update(labels=labels("1m", D(10, 22), D(10, 26)), td=M1)
    drive("s1", T(10, 23, 13, 0), T(10, 26, 9, 30))
    off = [x for x in fetches if T(10, 23, 13, 32) <= x < T(10, 26, 9, 1) and (x + TPE).minute % 15 not in (0, 5)]
    first = [r for r in runs if r > T(10, 26, 8)][:1]
    check(not alerts and not off and tpe(first) == ["10-26 09:01"],
          f"1m weekend: no alert, throttled until the open, Monday 09:00 bar at 09:01 → {shown()} {tpe(off[:3])} {tpe(first)}")

    # a holiday on the table: 10-28 closed
    HOLIDAYS.add(D(10, 28))
    feed.update(labels=labels("1m", D(10, 26), D(10, 29)), td=M1)
    drive("s1", T(10, 27, 13, 0), T(10, 29, 9, 30))
    first = [r for r in runs if r > T(10, 29, 8)][:1]
    check(not alerts and tpe(first) == ["10-29 09:01"],
          f"1m over the 10-28 holiday: no alert, 10-29 09:00 bar at 09:01 → {shown()} {tpe(first)}")

    # the table wrong: 10-28 on it, the market traded — back to every bar within 5 minutes
    feed.update(labels=labels("1m", D(10, 26), D(10, 27)) + [datetime(2026, 10, 28) - TPE + timedelta(minutes=m)
                                                              for m in FULL_DAY["1m"]], td=M1)
    drive("s1", T(10, 27, 13, 0), T(10, 28, 10, 0))
    day = [r for r in runs if r > T(10, 28, 8)]
    gaps = [b - a for a, b in zip(day, day[1:])]
    check(day and day[0] <= T(10, 28, 9, 5) + timedelta(seconds=10) and gaps and max(gaps) <= M1,
          f"table says closed but bars land: first run {tpe(day[:1])}, then every bar (max gap {max(gaps) if gaps else None})")
    HOLIDAYS.discard(D(10, 28))

    # longer bars at the close
    for name, sch, td, want in (("s5", "5m", timedelta(minutes=5), "10-27 13:35"),
                                ("s30", "30m", timedelta(minutes=30), "10-27 14:00"),
                                ("s60", "60m", timedelta(hours=1), "10-27 14:00")):
        feed.update(labels=labels(sch, D(10, 26), D(10, 28)), td=td)
        drive(name, T(10, 27, 12, 0), T(10, 28, 11, 0))
        close_run = [r for r in runs if T(10, 27, 13, 31) <= r < T(10, 27, 15)]
        check(not alerts and tpe(close_run[-1:]) == [want],
              f"{sch}: the bar holding 13:30 runs at {want}, no alert to the next morning → {shown()} {tpe(close_run)}")

    # sized in contracts, priced off the stock: the stock's session
    feed.update(labels=labels("1m", D(10, 26), D(10, 27)), td=M1)
    drive("slots", T(10, 27, 13, 0), T(10, 27, 15, 0))
    check(not alerts, f"lots strategy on fetch_twstock_ohlcv: quiet after the close → {shown()}")

    # mixed with a crypto price: unchanged (the old alert)
    drive("smix", T(10, 27, 13, 0), T(10, 27, 15, 0))
    check(shown()[:1] == [("10-27 13:47", 15)], f"stock + fetch_kline: the old 13:47 alert kept → {shown()}")

    # crypto: never asks the table, no new state key
    del asked[:]
    st = drive("btc", T(10, 27, 13, 0), T(10, 27, 15, 0))
    check(not asked and "tw_fut_holiday" not in st, f"crypto 1m: no holiday ask, no tw_fut_holiday ({len(asked)})")
finally:
    os.chdir(cwd)
    shutil.rmtree(BASE, ignore_errors=True)

print("\nALL OK" if not fails else f"\n{fails} FAILED")
sys.exit(1 if fails else 0)
