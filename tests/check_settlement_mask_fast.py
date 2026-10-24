"""txf_settlement_mask's integer open-day path marks exactly the bars the tz-convert path did.

The open days ("which dates had a day session") used to come from tz-converting, normalizing
and iterating every bar — about 3 s per call on two years of 1m, paid by every backtest's
look-ahead replays and every live tick. They now come from the raw epoch integers (Taipei is
UTC+8 with no DST since 1980). The pre-change function is copied below verbatim as the
reference; every index here must give the same mask, bar for bar.

Inputs: every cache/twfutures*_<schema>_<SYMBOL>/ series on this machine (each in naive-UTC,
UTC-aware and Asia/Taipei forms, plus ns unit), the postponed settlements 2013-08-22,
2015-02-24, 2023-01-30, 2026-02-23 sliced out of them, look-ahead style tail truncations, and
synthetic edge cases that always run. The cache groups are skipped when no cache exists.
Mutated copies of the new code (offset +0, `hour <= 14`, `hour >= 9`, the index unit ignored) must
each disagree with the reference somewhere, so the comparison is proven able to go red.

Run: cd blave-agent && .venv/bin/python tests/check_settlement_mask_fast.py
"""
import csv
import inspect
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

import pandas as pd

import lib.data as data
from lib.data import txf_settlement_mask

TPE = "Asia/Taipei"
fails = 0


def check(cond, msg):
    global fails
    print(("  PASS  " if cond else "  FAIL  ") + msg)
    fails += (not cond)


def old_txf_settlement_mask(index):
    # verbatim pre-change body of lib.data.txf_settlement_mask (docstring dropped)
    import bisect
    import datetime
    from zoneinfo import ZoneInfo

    twn = ZoneInfo('Asia/Taipei')

    def _third_wed(year, month):
        d, count = datetime.date(year, month, 1), 0
        while True:
            if d.weekday() == 2:
                count += 1
                if count == 3:
                    return d
            d = d + datetime.timedelta(days=1)

    def _moment(d):
        ts = pd.Timestamp(datetime.datetime(d.year, d.month, d.day, 13, 30, tzinfo=twn)
                          .astimezone(datetime.timezone.utc))
        return ts.tz_localize(None) if index.tz is None else ts

    mask  = pd.Series(False, index=index)
    start = index.min()
    end   = index.max()
    bar = index.to_series().diff().median() if len(index) > 1 else pd.NaT
    if pd.notna(bar):
        end = end + bar

    local = (index.tz_localize('UTC') if index.tz is None else index).tz_convert(twn)
    daily = pd.notna(bar) and bar >= pd.Timedelta(days=1)
    day_session = local if daily else local[(local.hour >= 8) & (local.hour < 14)]
    open_days = sorted(set(day_session.normalize().unique().date))
    open_set = set(open_days)

    def _mark(ts_settle):
        pos = index.searchsorted(ts_settle) - 1
        if pos >= 0 and (ts_settle - index[pos]) <= pd.Timedelta(days=1):
            mask.iloc[pos] = True

    year, month = start.year, start.month
    while True:
        wed = _third_wed(year, month)
        if _moment(wed) > end:
            break
        _mark(_moment(wed))
        if wed not in open_set:
            nxt = open_days[bisect.bisect_right(open_days, wed):][:1]
            if nxt and (nxt[0] - wed).days <= 14 and _moment(nxt[0]) <= end:
                _mark(_moment(nxt[0]))
        month += 1
        if month > 12:
            month, year = 1, year + 1
    return mask


OLD = {}   # group name -> reference mask, computed once (the reference is the slow one)


def same(name, index, fn=txf_settlement_mask):
    if name not in OLD:
        OLD[name] = old_txf_settlement_mask(index)
    old, new = OLD[name], fn(index)
    ok = old.index.equals(new.index) and (old.values == new.values).all() and old.sum() == new.sum()
    return ok, int(old.sum()), int(new.sum())


GROUPS = []   # (name, index) — every input both the parity run and the mutants use


def add(name, index):
    GROUPS.append((name, index))


def forms(name, index):
    """The forms a strategy can hand in: naive UTC (intraday cache), UTC-aware, Asia/Taipei
    (fetch's 1d form), and the ns unit older pandas always produce."""
    naive = index if index.tz is None else index.tz_convert("UTC").tz_localize(None)
    add(f"{name} naive-UTC", naive)
    add(f"{name} UTC", naive.tz_localize("UTC"))
    add(f"{name} Taipei", naive.tz_localize("UTC").tz_convert(TPE))
    if hasattr(naive, "as_unit"):
        add(f"{name} naive-UTC ns", naive.as_unit("ns"))


# ── synthetic edge cases (always run) ──
def day_bars(d, hours, minutes=(0,)):
    day = pd.Timestamp(d, tz=TPE)
    return [day + pd.Timedelta(hours=h, minutes=m) for h in hours for m in minutes]


def session_60m(days, skip=(), extra=()):
    out = []
    for d in pd.bdate_range(*days):
        ds = d.strftime("%Y-%m-%d")
        if ds in skip:
            continue
        out += day_bars(ds, range(8, 14)) + day_bars(ds, range(15, 24))
    out += list(extra)
    return pd.DatetimeIndex(sorted(set(out)))


# 2025-03-19 is a 3rd Wednesday
rng = ("2025-03-03", "2025-03-31")
forms("syn 60m ordinary month", session_60m(rng))
forms("syn 60m settlement Wed with no bars", session_60m(rng, skip=("2025-03-19",)))
forms("syn 60m settlement Wed night session only",
      session_60m(rng, skip=("2025-03-19",), extra=day_bars("2025-03-19", range(15, 24))))
forms("syn 60m settlement Wed only 14:xx bars",
      session_60m(rng, skip=("2025-03-19",), extra=day_bars("2025-03-19", [14], range(0, 60, 15))))
forms("syn 60m settlement Wed only 08:xx bars",
      session_60m(rng, skip=("2025-03-19",), extra=day_bars("2025-03-19", [8], range(45, 60, 5))))
forms("syn 60m settlement Wed only a 13:59 bar",
      session_60m(rng, skip=("2025-03-19",), extra=day_bars("2025-03-19", [13], [59])))
forms("syn 60m 3-day gap over settlement",
      session_60m(rng, skip=("2025-03-18", "2025-03-19", "2025-03-20")))
forms("syn 60m 3-week gap over settlement",
      session_60m(rng, skip=tuple(d.strftime("%Y-%m-%d") for d in pd.bdate_range("2025-03-12", "2025-03-28"))))
forms("syn 1 bar", pd.DatetimeIndex(day_bars("2025-03-19", [13])))
forms("syn 2 bars", pd.DatetimeIndex(day_bars("2025-03-19", [12, 13])))
forms("syn 1m settlement day to 13:29",
      pd.date_range(pd.Timestamp("2025-03-19 08:45", tz=TPE), pd.Timestamp("2025-03-19 13:29", tz=TPE), freq="1min"))
forms("syn 1d month", pd.DatetimeIndex([pd.Timestamp(d, tz=TPE) for d in pd.bdate_range(*rng)]))
forms("syn 1d settlement Wed missing",
      pd.DatetimeIndex([pd.Timestamp(d, tz=TPE) for d in pd.bdate_range(*rng) if d.strftime("%Y-%m-%d") != "2025-03-19"]))
forms("syn 60m before 1980 (old path)", session_60m(("1979-03-01", "1979-04-30")))
forms("syn 60m straddling 1980 (old path)", session_60m(("1979-12-03", "1980-01-31")))
for unit in ("s", "ms"):
    idx = session_60m(rng, skip=("2025-03-19",), extra=day_bars("2025-03-19", range(15, 24)))
    if hasattr(idx, "as_unit"):
        add(f"syn 60m night-only Wed unit {unit}", idx.as_unit(unit))

# the recorded TAIFEX trading days of February 2026 (3rd Wednesday closed, settled 02-23)
fix = os.path.join(ROOT, "tests", "fixtures", "taifex_fut_daily", "futDataDown_TX_2026-02.csv")
with open(fix, encoding="cp950") as f:
    feb = sorted({r[0].replace("/", "-") for r in csv.reader(f) if r[0][:1].isdigit() and r[17].strip() == "一般"})
forms("fixture 2026-02 1d", pd.DatetimeIndex([pd.Timestamp(d, tz=TPE) for d in feb]))
forms("fixture 2026-02 60m", pd.DatetimeIndex(sorted(b for d in feb for b in day_bars(d, list(range(8, 14)) + list(range(15, 24))))))

# ── every twfutures series in this machine's cache ──
SCHEMAS = ("1m", "5m", "15m", "30m", "60m", "1d")
cache = os.path.join(ROOT, "cache")
series = {}
pat = re.compile(r"^twfutures\d*_(%s)_([A-Z0-9]+)$" % "|".join(SCHEMAS))
for d in sorted(os.listdir(cache)) if os.path.isdir(cache) else []:
    m = pat.match(d)
    if not m:
        continue
    files = sorted(f for f in os.listdir(os.path.join(cache, d)) if re.match(r"^\d{4}-\d{2}\.parquet$", f))
    idx = []
    for f in files:
        try:
            idx.append(pd.read_parquet(os.path.join(cache, d, f), columns=[]).index)
        except Exception:
            continue
    idx = [i for i in idx if len(i)]
    if not idx:
        continue
    full = idx[0].append(idx[1:]) if len(idx) > 1 else idx[0]
    full = pd.DatetimeIndex(full).sort_values()
    full = full[~full.duplicated()]
    series[d] = (m.group(1), full)
print(f"cache series found: {len(series)}" + ("" if series else " — SKIP the cache groups (no cache/twfutures*)"))

for d, (schema, full) in series.items():
    forms(d, full)
    for ymd in ("2013-08-22", "2015-02-24", "2023-01-30", "2026-02-23"):
        t = pd.Timestamp(ymd)
        part = full[(full >= t - pd.Timedelta(days=45)) & (full < t + pd.Timedelta(days=20))]
        if len(part):
            forms(f"{d} around {ymd}", part)
    if schema in ("1m", "60m"):
        for label, cut in (("-1 bar", full[-1]), ("-1 day", full[-1] - pd.Timedelta(days=1)),
                           ("-1 month", full[-1] - pd.Timedelta(days=30))):
            add(f"{d} truncated {label} naive-UTC", full[full < cut])
    if schema == "60m" and d.endswith("_TXF"):   # one series: a cache can hold 100+ 60m dirs
        for k in range(1, 41):   # live ticks walking up to the last bar
            add(f"{d} live tick -{k}", full[:-k])

# ── parity ──
print(f"{'group':70s} {'old.sum':>8s} {'new.sum':>8s}  equal")
bad = 0
for name, idx in GROUPS:
    ok, so, sn = same(name, idx)
    bad += (not ok)
    if not ok or "live tick" not in name:
        print(f"{name:70s} {so:8d} {sn:8d}  {ok}")
check(bad == 0, f"new == old on all {len(GROUPS)} inputs ({bad} differ)")

# ── mutants: the comparison above must be able to fail ──
src = inspect.getsource(data.txf_settlement_mask)
MUTANTS = {
    "+0 hours instead of +8": ("8 * 3600 * per_sec", "0 * 3600 * per_sec"),
    "day session hour <= 14": ("(hour < 14)", "(hour <= 14)"),
    "day session hour >= 9": ("(hour >= 8)", "(hour >= 9)"),
    "unit read as us regardless of the index": ("getattr(index, 'unit', 'ns')", "'us'"),
}
for label, (a, b) in MUTANTS.items():
    if a not in src:
        check(False, f"mutant '{label}': '{a}' not found in txf_settlement_mask — update the mutant")
        continue
    ns = dict(vars(data))
    exec(compile(src.replace(a, b, 1), "<mutant>", "exec"), ns)
    fn = ns["txf_settlement_mask"]
    caught = []
    for name, idx in GROUPS:
        try:
            if not same(name, idx, fn)[0]:
                caught.append(name)
        except Exception as e:
            caught.append(f"{name} ({type(e).__name__})")
    check(bool(caught), f"mutant '{label}' goes red: {len(caught)} input(s), e.g. {caught[:2]}")

print("all checks passed" if not fails else f"FAILED: {fails}")
sys.exit(1 if fails else 0)
