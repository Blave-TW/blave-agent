"""Minimal check: txf_settlement_mask marks the pre-settlement bar on the live tick too.

On a live tick that bar is the LAST bar. The loop used to stop at index.max(), so the
13:30 settlement right after it was never considered: the backtest (which sees the next
bar) went flat into settlement, live held through it. The loop now reaches one bar past
the last label — one bar, not one day, so an earlier tick does not flatten hours early.

A settlement postponed past a closed 3rd Wednesday is read from the index: 2026-02-18 fell in
the Lunar New Year closure and TAIFEX settled 202602 on 2026-02-23 (the trading days are the
ones in the recorded futDataDown answer, tests/fixtures/taifex_fut_daily/).

Run: cd blave-agent && .venv/bin/python tests/check_settlement_mask_live.py
"""
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

import csv

import pandas as pd

from lib.data import txf_settlement_mask

fails = 0


def check(cond, msg):
    global fails
    print(("  PASS  " if cond else "  FAIL  ") + msg)
    fails += (not cond)


# 2025-03-19 is the third Wednesday: settlement 13:30 Taipei
day = pd.Timestamp("2025-03-19", tz="Asia/Taipei")
h60 = pd.DatetimeIndex([pd.Timestamp("2025-03-18", tz="Asia/Taipei") + pd.Timedelta(hours=h) for h in (9, 10, 11, 12, 13)]
                       + [day + pd.Timedelta(hours=h) for h in (9, 10, 11, 12, 13)]
                       + [pd.Timestamp("2025-03-20 09:00", tz="Asia/Taipei")])
settle_bar = day + pd.Timedelta(hours=13)

full = txf_settlement_mask(h60)
check(full[full].index.tolist() == [settle_bar], "backtest (next bar visible): 13:00 on settlement day marked, nothing else")
live = txf_settlement_mask(h60[h60 <= settle_bar])
check(bool(live.iloc[-1]), "live tick whose last bar is 13:00 on settlement day: marked")
early = txf_settlement_mask(h60[h60 <= day + pd.Timedelta(hours=12)])
check(not early.any(), "live tick at 12:00 on settlement day: not marked (one bar, not one day)")

m1 = pd.date_range(day + pd.Timedelta(hours=8, minutes=45), day + pd.Timedelta(hours=13, minutes=29), freq="1min")
check(bool(txf_settlement_mask(m1).iloc[-1]), "1m: live tick at 13:29 marked")
check(not txf_settlement_mask(m1[:-1]).any(), "1m: live tick at 13:28 not marked")

naive = h60.tz_convert("UTC").tz_localize(None)       # the kline cache's naive-UTC form
check(txf_settlement_mask(naive[naive <= settle_bar.tz_convert("UTC").tz_localize(None)]).iloc[-1],
      "naive-UTC index: same")

# ── postponed settlement: February 2026 ──
TPE = "Asia/Taipei"
fix = os.path.join(ROOT, "tests", "fixtures", "taifex_fut_daily")


def trading_days(name):
    with open(os.path.join(fix, name), encoding="cp950") as f:
        return sorted({r[0].replace("/", "-") for r in csv.reader(f) if r[0][:1].isdigit() and r[17].strip() == "一般"})


feb, sep = trading_days("futDataDown_TX_2026-02.csv"), trading_days("futDataDown_TX_2026-09.csv")
check("2026-02-18" not in feb and "2026-02-23" in feb, "fixture: 2026-02-18 (3rd Wednesday) closed, 02-23 the next trading day")


def marked(index):
    m = txf_settlement_mask(index)
    return [t.tz_convert(TPE).strftime("%Y-%m-%d %H:%M") if t.tzinfo else str(t) for t in index[m.values]]


def daily(days):
    return pd.DatetimeIndex([pd.Timestamp(d, tz=TPE) for d in days])


check(marked(daily(feb)) == ["2026-02-23 00:00"], f"1d: the 02-23 bar is marked (postponed), nothing else {marked(daily(feb))}")
check(marked(daily(sep)) == ["2026-09-16 00:00"], f"1d: an ordinary month is unchanged {marked(daily(sep))}")


def session_bars(days, night_before=()):
    """60m labels: day session 08:00–13:00, plus the evening session opening each listed day
    (15:00 the day before … 04:00)."""
    out = []
    for d in days:
        day = pd.Timestamp(d, tz=TPE)
        out += [day + pd.Timedelta(hours=h) for h in range(8, 14)]
    for d in night_before:
        day = pd.Timestamp(d, tz=TPE)
        out += [day + pd.Timedelta(hours=h) for h in range(15, 29)]
    return pd.DatetimeIndex(sorted(out))


# every evening session that runs: after each trading day, 02-11 (the eve of the closure) included
h60f = session_bars(feb, night_before=feb)
check(marked(h60f) == ["2026-02-23 13:00"], f"60m with evening sessions: only 13:00 on 02-23 {marked(h60f)}")
live = h60f[h60f <= pd.Timestamp("2026-02-23 13:00", tz=TPE)]
check(bool(txf_settlement_mask(live).iloc[-1]), "live tick whose last bar is 13:00 on 02-23: marked")
check(not txf_settlement_mask(h60f[h60f <= pd.Timestamp("2026-02-23 12:00", tz=TPE)]).any(),
      "live tick at 12:00 on 02-23: not marked")
check(marked(h60f.tz_convert("UTC").tz_localize(None)) == ["2026-02-23 05:00:00"], "naive-UTC index: same bar")

# a symbol with no bars on an open 3rd Wednesday: its next bar day is flattened as well (the bar
# before Wednesday is over a day away, so it stays unmarked exactly as before)
sparse = session_bars([d for d in sep if d != "2026-09-16"])
check(marked(sparse) == ["2026-09-17 13:00"], f"a symbol that did not trade on settlement Wednesday: flattened once more, never less {marked(sparse)}")

print("all checks passed" if not fails else f"FAILED: {fails}")
sys.exit(1 if fails else 0)
