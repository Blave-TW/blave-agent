"""TWSE stock daily strategies wait on trading days only (desktop 0.1.27 dev test, 2026-10-18).

wait_for_bar's expected bar is a UTC calendar floor. A 1d fetch_twstock_price* strategy has no
bar on Saturday, Sunday or a TWSE holiday, so it used to wait on one that never comes: a P2
"K 棒沒到位" every Sunday, Monday morning and day after a holiday, and Monday's bar run twice
(once as "Sunday", once as itself). Simulated minute by minute over a week, in-process:

  1. a TW stock Type A and a Type C universe: no stale alert; every trading-day bar computed
     exactly once (Monday's on Tuesday 08:00 TPE, like every other weekday's); nothing on the
     holiday; the holiday table never asked on Sat/Sun/Mon, and on the day after the holiday
     once per TW_BAR_MAP_RECHECK_SECONDS (a withdrawn ad-hoc closure is seen), not every minute.
  2. Friday's bar really late (lands Saturday 13:00 TPE): still alerts, on Friday's bar, and
     runs once it lands.
  3. not TW stock daily → the plain calendar floor every minute of the week, holiday table never
     asked, state shape unchanged: crypto, TXF, a crypto Type C built from TEMPLATE_C (whose
     comments name fetch_twstock_price), a mixed crypto + TW Type C, fetch_twstock_ohlcv.
     The crypto template strategy computes all 8 daily bars.
  4. a holiday-table outage left a wait and an alert behind: once the map succeeds they are
     cleared, so the next real late bar alerts after 15 minutes, saying 15.
  5. runtime/portfolio_reporter._recomputed_since (補齊部位): a machine restarted on Sunday or
     Monday morning counts a TW stock daily strategy on Friday's bar as current; crypto
     unchanged. Its detection and the workspace's agree on every source above.

Run: cd blave-agent && .venv/bin/python tests/check_tw_stock_bar_calendar.py
"""
import importlib.util
import json
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
template_c = open(os.path.join(ROOT, "strategies", "TEMPLATE_C.py"), encoding="utf-8").read()
assert "fetch_twstock_price" in template_c, "TEMPLATE_C no longer names fetch_twstock_price: case 3 tests nothing"
SOURCES = {
    "tws": 'SYMBOL = "2330"\nINTERVAL = "1d"\nfrom lib.data import fetch_twstock_price_adj\n',
    "twc": 'INTERVAL = "1d"\nUNIVERSE = ["1101", "2330"]\nfrom lib.data import fetch_twstock_price_adj_batch\n',
    "btc": 'SYMBOL = "BTCUSDT"\nINTERVAL = "1d"\nfrom lib.data import fetch_kline\n',
    "txf": 'SYMBOL = "TXF"\nINTERVAL = "1d"\nfrom lib.data import fetch_twfutures_ohlcv, fetch_twstock_price\n',
    "cryc": template_c + "\nfrom lib.data import fetch_kline_batch\n",
    "mixc": 'INTERVAL = "1d"\nfrom lib.data import fetch_kline_batch, fetch_twstock_price_adj_batch\n',
    "ohlc": 'SYMBOL = "2330"\nINTERVAL = "1d"\nfrom lib.data import fetch_twstock_ohlcv\n',
    # fetch_kline only in a comment: still TW stock daily (red if detection reads plain text)
    "twk": 'INTERVAL = "1d"\n# like fetch_kline(sym, "1d", START, END, hdrs) for crypto\n'
           'from lib.data import fetch_twstock_price_batch\n',
    "txp": 'SYMBOL = "TXF"\nINTERVAL = "1d"\nfrom lib.data import fetch_txf_daily_public, fetch_twstock_price\n',
}
CRYPTO_BARS = {"btc", "cryc"}   # a bar every calendar day
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
real_holiday = lambda day, unknown=False: holiday_calls.append((_Clock.at, day)) or day == HOLIDAY
wfb._tw_holiday = real_holiday
wfb._load_strategy_module = lambda n: types.SimpleNamespace(INTERVAL="1d")
land = {}   # trading day → naive UTC moment its bar lands (default 17:35 TPE that day)
seen, runs, alerts = [], [], []
cur = {"name": None}


def newest_bar():
    if cur["name"] in CRYPTO_BARS:   # crypto: yesterday's daily bar closes at 00:00 UTC
        return datetime.combine((_Clock.at - timedelta(days=1)).date(), datetime.min.time())
    days = [d for d in TRADING if _Clock.at >= land.get(d, datetime(d.year, d.month, d.day, 9, 35))]
    return datetime.combine(max(days), datetime.min.time())


def fresh(mod, expected):
    seen.append((_Clock.at, expected))
    last = newest_bar()
    if cur["name"] in ("twc", "cryc", "mixc"):
        return last, last >= expected, "1101", {"1101": last, "2330": last}
    return last, last >= expected, None, {"": last}


wfb._check_freshness = fresh
wfb._run_strategy_protected = lambda n: runs.append((_Clock.at, newest_bar())) or True
wfb._alert_stale = lambda name, expected, minutes, *a, **k: alerts.append((_Clock.at, expected, minutes))


def simulate(name, start, end, state=None):
    del seen[:], runs[:], alerts[:], holiday_calls[:]
    cur["name"] = name
    _Clock.at = start
    os.makedirs("state/bar_wait", exist_ok=True)
    wfb._save_state(name, {**wfb._default_state(), **(state or {})})
    while _Clock.at < end:
        wfb._tick(name)
        _Clock.at += timedelta(minutes=1)


cwd = os.getcwd()
os.chdir(BASE)
try:
    is_tw = getattr(wfb, "_tw_stock_daily", lambda n: False)
    check(is_tw("tws") and is_tw("twc"), "TW stock Type A and Type C universe detected")
    check(is_tw("twk"), "TW stock strategy naming fetch_kline only in a comment: detected")
    for n in ("btc", "txf", "cryc", "mixc", "ohlc", "txp"):
        check(not is_tw(n), f"{n}: not TW stock daily")

    # ── 1. a week: Fri 10-16 08:00 TPE → Fri 10-23 09:00 TPE ──────────────────────
    for name in ("tws", "twc"):
        simulate(name, U(16), U(23, 1))
        check(not alerts, f"{name}: no stale alert on Sat, Sun, Monday before close, the holiday or the day after "
                          f"(got {[(a.strftime('%a %H:%M'), e.date().isoformat()) for a, e, _ in alerts]})")
        computed = [b.date() for _, b in runs]
        check(computed == [date(2026, 10, d) for d in (15, 16, 19, 20, 22)],
              f"{name}: every trading-day bar computed exactly once, in order (got {[c.isoformat() for c in computed]})")
        mon = [t for t, b in runs if b.date() == date(2026, 10, 19)]
        check(mon == [U(20)], f"{name}: Monday's bar runs once, Tuesday 08:00 TPE (got {mon})")
        weekend = [c for c in holiday_calls if U(17, 0, 1) <= c[0] < U(20)]
        check(not weekend, f"{name}: holiday table not asked after Saturday's run until Tuesday ({len(weekend)} calls)")
        after = {c[0] for c in holiday_calls if U(22) <= c[0] < U(23)}
        hourly = 24 * 3600 / wfb.TW_BAR_MAP_RECHECK_SECONDS + 1
        check(len(after) <= hourly, f"{name}: day after the holiday asks the table once per re-check interval, not every "
                                    f"minute ({len(after)} minutes asked, at most {hourly:.0f})")

    # a holiday on Friday: Saturday and Monday mornings wait on Thursday's bar
    wfb._tw_holiday = lambda day, unknown=False: day == date(2026, 10, 16)
    for t in (U(17, 0, 1), U(19, 0, 1)):
        st = {"last_processed_bar": "2026-10-15T00:00:00"}
        try:
            got = wfb._tw_skip_holidays(wfb._tw_skip_weekend(wfb._expected_closed_bar_open("1d", t)), st)
        except AttributeError as e:
            got = e
        check(got == U(15), f"Friday holiday, {t:%a} 08:00 TPE: expected → Thursday (got {got})")
    wfb._tw_holiday = real_holiday

    # ── 2. Friday's bar really late: lands Saturday 13:00 TPE ─────────────────────
    land[date(2026, 10, 16)] = U(17, 5)
    simulate("tws", U(16, 12), U(18))
    check(alerts and alerts[0][1] == U(16) and alerts[0][0] == U(17, 0, 15),
          f"late Friday bar: alerts at Saturday 08:15 TPE on Friday's bar (got {alerts[:1]})")
    fri = [t for t, b in runs if b.date() == date(2026, 10, 16)]
    check(fri == [U(17, 5)], f"…and runs once when it lands (got {fri})")
    land.clear()

    # ── 3. everything else: the calendar floor, every minute of the week ──────────
    for name in ("btc", "txf", "cryc", "mixc", "ohlc"):
        simulate(name, U(16), U(23, 1))
        off = [(t, e) for t, e in seen if e != wfb._expected_closed_bar_open("1d", t)]
        check(seen and not off, f"{name}: expected bar = calendar floor on every probe ({len(seen)} probes, {off[:2]})")
        if name != "txf":   # TXF asks the table through its own _tw_futures_closed
            check(not holiday_calls, f"{name}: holiday table never asked ({len(holiday_calls)} calls)")
        check("tw_bar_map" not in wfb._load_state(name), f"{name}: state shape unchanged")
        if name in CRYPTO_BARS:
            got = [b.date().isoformat() for _, b in runs]
            check(got == [f"2026-10-{d}" for d in range(15, 23)],
                  f"{name}: all 8 daily bars computed, weekend and TW holiday included (got {got})")

    # ── 4. table outage left a wait behind; the next real late bar says 15 minutes ─
    land[date(2026, 10, 22)] = U(23, 5)
    left = {"last_processed_bar": "2026-10-20T00:00:00", "last_seen_bar": "2026-10-20T00:00:00",
            "pending_since": U(22).isoformat(), "stall_alert_at": (U(22, 0, 15) - datetime(1970, 1, 1)).total_seconds()}
    simulate("tws", U(22, 1), U(23, 1), state=left)
    st = wfb._load_state("tws")
    check(alerts and alerts[0][0] == U(23, 0, 15) and alerts[0][2] == 15,
          f"leftover wait cleared: Thursday's late bar alerts Fri 08:15 TPE, waited 15 min (got {alerts[:1]})")
    land.clear()
finally:
    os.chdir(cwd)

# ── 5. runtime: 補齊部位 after a weekend restart ─────────────────────────────────
os.environ["BLAVE_AGENT_WORKSPACE"] = BASE
sys.path.insert(0, os.path.join(ROOT, "runtime"))
import portfolio_reporter as pr   # noqa: E402
import strategy_reporter as sr   # noqa: E402

pr.WORKSPACE, pr.WORKSPACE_STATE = BASE, os.path.join(BASE, "state")
os.makedirs(os.path.join(BASE, "manager"), exist_ok=True)
open(os.path.join(BASE, "manager", "wait_for_bar.py"), "w").write("")
check(wfb._PRICE_FETCHERS == set(sr._PRICE_FETCHERS), "workspace price-fetcher table = runtime strategy_reporter's")
pr_tw = getattr(pr, "_tw_stock_daily", None)
os.chdir(BASE)
disagree = [n for n in SOURCES if pr_tw is None or pr_tw(n, {}) != wfb._tw_stock_daily(n)]
os.chdir(cwd)
check(pr_tw is not None and not disagree, f"runtime and workspace agree which strategies are TW stock daily ({disagree})")
vens = {"paper": {"pair": "x"}}
epoch = lambda t: (t - datetime(1970, 1, 1)).total_seconds()


def recomputed(name, boot, processed):
    p = os.path.join(BASE, "state", "bar_wait", f"{name}.json")
    json.dump({"last_processed_bar": processed, "last_seen_bar": processed}, open(p, "w"))
    os.utime(p, (epoch(boot) - 3600, epoch(boot) - 3600))   # last written before the boot
    return pr._recomputed_since(epoch(boot), {"amounts": {name: 100}, "exchanges": {name: "paper"}}, vens)


for boot, label in ((U(18, 4), "Sunday 12:00 TPE"), (U(19, 2), "Monday 10:00 TPE")):
    check(recomputed("tws", boot, "2026-10-16T00:00:00") is True,
          f"TW stock daily, restart {label}, on Friday's bar: current (補齊部位 enabled)")
    check(recomputed("cryc", boot, "2026-10-16T00:00:00") is False,
          f"crypto daily (template comments), restart {label}, on Friday's bar: not current, as before")
check(recomputed("tws", U(20, 1), "2026-10-16T00:00:00") is False,
      "TW stock daily, restart Tuesday 09:00 TPE still on Friday's bar: not current")

shutil.rmtree(BASE, ignore_errors=True)
print("\ncheck_tw_stock_bar_calendar: " + ("PASS" if not fails else f"FAILED ({fails})"))
sys.exit(1 if fails else 0)
