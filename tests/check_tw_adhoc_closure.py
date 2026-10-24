"""Ad-hoc market closures (typhoon days) on the holiday table, as the manager reads them.

The api adds a `type: adhoc_closed` row the evening of the day or the next morning (2026-10-23:
both exchanges closed for a typhoon, no K bar anywhere). Every machine's manager reads it the
moment it is served, so the real `_tw_holiday` runs here against a stubbed
`lib.data.fetch_twstock_holidays` (never a stubbed `_tw_holiday`):

  1. the 29026 replay: a TW stock daily Type C stalled on 10-23 (pending_since + stall_alert_at
     set): the wait and the alert are cleared at the next :00 / :05, nothing is fetched or
     alerted through Sat, Sun and the 10-26 holiday, and Tuesday's bar is waited on Wed 08:00.
  2. withdrawn: the row disappears after the map was kept → within TW_BAR_MAP_RECHECK_SECONDS
     the day is computed (fetched); never every minute before that.
  3. a table blip during the closure keeps the map: no fetch, no alert.
  4. parity: for every row type lib.is_tw_trading_day and manager._tw_holiday agree; a lib
     without TW_CLOSED_TYPES makes the manager count any row, as before.

Run: cd blave-agent && .venv/bin/python tests/check_tw_adhoc_closure.py
"""
import importlib.util
import os
import shutil
import sys
import tempfile
import types
from datetime import date, datetime, timedelta

import pandas as pd

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

import dotenv  # noqa: E402
dotenv.dotenv_values = lambda *a, **k: {}   # never read a workspace .env

import lib.data as D  # noqa: E402

fails = 0


def check(cond, msg):
    global fails
    print(("  PASS  " if cond else "  FAIL  ") + msg)
    fails += (not cond)


BASE = tempfile.mkdtemp(prefix="tw-adhoc-")
os.makedirs(os.path.join(BASE, "strategies", "twm"))
open(os.path.join(BASE, "strategies", "twm", "strategy.py"), "w").write(
    'INTERVAL = "1d"\nUNIVERSE = ["1101", "2330"]\nfrom lib.data import fetch_twstock_price_adj_batch\n')

spec = importlib.util.spec_from_file_location("wfb_adhoc", os.path.join(ROOT, "manager", "wait_for_bar.py"))
wfb = importlib.util.module_from_spec(spec)
spec.loader.exec_module(wfb)

U = lambda d, h=0, m=0: datetime(2026, 10, d, h, m)   # naive UTC; Taipei = +8
epoch = lambda t: (t - datetime(1970, 1, 1)).total_seconds()


class _Clock(datetime):
    at = U(24)

    @classmethod
    def now(cls, tz=None):
        return cls.at.replace(tzinfo=tz) if tz else cls.at


wfb.datetime = _Clock
wfb.time = types.SimpleNamespace(time=lambda: epoch(_Clock.at), monotonic=__import__("time").monotonic)
wfb._load_strategy_module = lambda n: types.SimpleNamespace(INTERVAL="1d")

ROWS = {"base": [("2026-10-09", "國慶日", "holiday"), ("2026-10-26", "臺灣光復暨金門古寧頭大捷紀念日", "holiday")]}
table = {"rows": ROWS["base"] + [("2026-10-23", "臨時停市", "adhoc_closed")]}
asked = []


def fake_holidays(headers, year=None, **kw):
    asked.append(_Clock.at)
    if table["rows"] is None:
        return None
    df = pd.DataFrame(table["rows"], columns=["date", "name", "type"])
    df["note"] = None
    df["date"] = pd.to_datetime(df["date"])
    return df


D.fetch_twstock_holidays = fake_holidays
fetched, alerts, runs = [], [], []
NEWEST = datetime(2026, 10, 22)


def fresh(mod, expected):
    fetched.append((_Clock.at, expected))
    return NEWEST, NEWEST >= expected, "1101", {"1101": NEWEST, "2330": NEWEST}


wfb._check_freshness = fresh
wfb._run_strategy_protected = lambda n: runs.append(_Clock.at) or True
wfb._alert_stale = lambda name, expected, minutes, *a, **k: alerts.append((_Clock.at, expected))


def tick_until(end):
    while _Clock.at < end:
        wfb._tick("twm")
        _Clock.at += timedelta(minutes=1)


def reset(at, state):
    del fetched[:], alerts[:], runs[:], asked[:]
    _Clock.at = at
    wfb._save_state("twm", {**wfb._default_state(), **state})


cwd = os.getcwd()
os.chdir(BASE)
os.makedirs("state/bar_wait", exist_ok=True)
try:
    check(wfb._tw_stock_daily("twm"), "the test strategy is TW stock daily")

    # ── 1. the 29026 replay ──────────────────────────────────────────────────────
    stalled = {"last_processed_bar": "2026-10-22T00:00:00", "last_seen_bar": "2026-10-22T00:00:00",
               "pending_since": U(24).isoformat(), "stall_alert_at": epoch(U(24, 0, 15))}
    reset(U(24, 2, 7), stalled)
    wfb._tick("twm")
    st = wfb._load_state("twm")
    check(st.get("stall_alert_at") is not None and not asked,
          "Sat 10:07 TPE: inside the stall throttle nothing runs yet, the table is not asked")
    _Clock.at = U(24, 2, 15)
    wfb._tick("twm")
    st = wfb._load_state("twm")
    check(st.get("pending_since") is None and st.get("stall_alert_at") is None and not fetched and not alerts,
          f"Sat 10:15 TPE (next :00/:05 poll): 10-23 adhoc_closed → wait and alert cleared, nothing fetched ({fetched[:1]})")
    check((st.get("tw_bar_map") or [None, None])[:2] == ["2026-10-23T00:00:00", "2026-10-22T00:00:00"],
          f"the map 10-23 → 10-22 is kept ({st.get('tw_bar_map')})")
    tick_until(U(27, 23, 59))
    check(not fetched and not alerts and not runs,
          f"Sat → Tue 07:59 TPE (weekend, the 10-26 holiday): no fetch, no alert, no run ({fetched[:1]}, {alerts[:1]})")
    ticks = len(set(asked))
    budget = (U(27, 23, 59) - U(24, 2, 15)).total_seconds() / wfb.TW_BAR_MAP_RECHECK_SECONDS + 3   # + a new expected day
    check(asked and ticks <= budget,
          f"the table is re-asked once per {wfb.TW_BAR_MAP_RECHECK_SECONDS // 60} min, not every minute "
          f"({ticks} ticks asked over ~3.9 days, budget {budget:.0f})")
    tick_until(U(28, 0, 1))
    check(fetched and fetched[0] == (U(28), U(27)), f"Wed 08:00 TPE: Tuesday's bar is waited on ({fetched[:1]})")

    # ── 2. the row is withdrawn after the map was kept ───────────────────────────
    table["rows"] = ROWS["base"] + [("2026-10-23", "臨時停市", "adhoc_closed")]
    reset(U(24), {"last_processed_bar": "2026-10-22T00:00:00", "last_seen_bar": "2026-10-22T00:00:00"})
    tick_until(U(24, 0, 10))
    check(not fetched and wfb._load_state("twm").get("tw_bar_map"), "closure in the table: mapped, not fetched")
    table["rows"] = ROWS["base"]
    tick_until(U(24, 0, 59))
    check(not fetched, "withdrawn, map still fresh: not yet re-asked, no fetch")
    tick_until(U(24, 1, 2))
    check(fetched and fetched[0][1] == U(23) and U(24, 0, 59) <= fetched[0][0] <= U(24, 1, 1),
          f"withdrawn: within the re-check interval the day 10-23 is waited on ({fetched[:1]})")
    check(not (wfb._load_state("twm").get("tw_bar_map")), "…and the map is gone")

    # ── 3. a table blip during the closure keeps the map ─────────────────────────
    table["rows"] = ROWS["base"] + [("2026-10-23", "臨時停市", "adhoc_closed")]
    reset(U(24), {"last_processed_bar": "2026-10-22T00:00:00", "last_seen_bar": "2026-10-22T00:00:00"})
    tick_until(U(24, 0, 5))
    table["rows"] = None
    tick_until(U(24, 3, 30))
    check(not fetched and not alerts and wfb._load_state("twm").get("tw_bar_map"),
          f"table unreachable on the re-check: map kept, no fetch, no alert ({fetched[:1]}, {alerts[:1]})")
    table["rows"] = ROWS["base"] + [("2026-10-23", "臨時停市", "adhoc_closed")]

    # ── 4. parity lib ↔ manager, and an older lib ────────────────────────────────
    H = {"api-key": "x", "secret-key": "y"}
    disagree = []
    for kind in ("holiday", "settlement_only", "adhoc_closed", "makeup_trading"):
        table["rows"] = ROWS["base"] + [("2026-10-23", "x", kind)]
        lib_closed = D.is_tw_trading_day("2026-10-23", H) is False
        if lib_closed != wfb._tw_holiday(date(2026, 10, 23)):
            disagree.append(kind)
    check(not disagree, f"every row type: lib.is_tw_trading_day and manager._tw_holiday agree ({disagree})")
    table["rows"] = ROWS["base"] + [("2026-10-23", "x", "makeup_trading")]
    check(wfb._tw_holiday(date(2026, 10, 23)) is False, "a row outside TW_CLOSED_TYPES is not a holiday to the manager")
    saved = D.TW_CLOSED_TYPES
    del D.TW_CLOSED_TYPES
    try:
        check(wfb._tw_holiday(date(2026, 10, 23)) is True, "a lib without TW_CLOSED_TYPES: any row counts, as before")
    finally:
        D.TW_CLOSED_TYPES = saved
    table["rows"] = None
    check(wfb._tw_holiday(date(2026, 10, 23)) is False and wfb._tw_holiday(date(2026, 10, 23), unknown=None) is None,
          "table unreachable: False by default, `unknown` when asked for")
finally:
    os.chdir(cwd)
    shutil.rmtree(BASE, ignore_errors=True)

print("\ncheck_tw_adhoc_closure: " + ("PASS" if not fails else f"FAILED ({fails})"))
sys.exit(1 if fails else 0)
