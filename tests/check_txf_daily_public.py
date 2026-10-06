"""Minimal check: the key-free TXF daily bars in lib.data — TAIFEX futDataDown (one CSV per
month, per contract and session) stitched into the near-month series fetch_twfutures_ohlcv
('TXF', '1d') serves. No network: the exchange session replays answers recorded on 2026-10-06
(tests/fixtures/taifex_fut_daily/); the clock is frozen at 2026-10-06 15:00 Taipei.

  - gate: without BLAVE_AGENT_LOCAL=1 nothing is requested; the Blave path answers as before
  - parse: 1998-07 (listing month, day session only), a start before listing is clamped
  - stitch: 盤後 row opens the bar and widens high/low, 一般 row closes it, volume is both;
    weeklies and calendar spreads are ignored; settlement day keeps the expiring month,
    the day after moves to the next; a settlement shifted by a holiday (2026-02-23) too;
    no bar on a holiday (the Blave series has one there)
  - shape: Asia/Taipei midnight index, naive UTC in the month file, five float columns,
    attrs['source'] = 'TAIFEX'
  - cache: one request per month, never over one month per request, a past month is not
    re-asked, the current month is re-asked from its last bar; an HTML answer and a settled
    month with no rows raise and cache nothing; the current month may be empty
  - routing: desktop + no Blave data access → TAIFEX for TXF / MXF / TXFR1 '1d' only;
    with access, or any intraday schema, the Blave path exactly as before
  - head: desktop + access + a start before the Blave series (2011-01-03) → the TAIFEX bars
    in front of the recorded Blave ones, attrs['source'] = 'TAIFEX/Blave'; 20 trading days
    each side of the seam with no repeated and no missing day against TAIFEX's own calendar;
    TAIFEX down → the Blave series alone plus a warning; a cloud machine never asks TAIFEX
  - MXF / TMF: the TAIFEX bars start on that contract's listing day (2001-04-09 / 2024-07-29)

Run: cd blave-agent && MPLBACKEND=Agg .venv/bin/python tests/check_txf_daily_public.py
"""
import os
import sys
import tempfile
from datetime import datetime as _real_dt
from pathlib import Path

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
os.environ.setdefault("MPLBACKEND", "Agg")

import pandas as pd

import lib.data as D

FIX = Path(ROOT) / "tests" / "fixtures" / "taifex_fut_daily"
fails = 0


def check(cond, msg):
    global fails
    print(("  PASS  " if cond else "  FAIL  ") + msg)
    fails += (not cond)


NOW = _real_dt(2026, 10, 6, 15, 0, tzinfo=D._TPE)


class Frozen(_real_dt):
    @classmethod
    def now(cls, tz=None):
        return NOW.astimezone(tz) if tz else NOW.replace(tzinfo=None)

    @classmethod
    def utcnow(cls):
        return NOW.astimezone(D.timezone.utc).replace(tzinfo=None)


D.datetime = Frozen
D.time.sleep = lambda s: None

MONTHS = {"1998-07": "futDataDown_TX_1998-07.csv", "2001-04": "futDataDown_TX_2001-04.csv",
          "2010-12": "futDataDown_TX_2010-12.csv", "2011-01": "futDataDown_TX_2011-01.csv",
          "2026-02": "futDataDown_TX_2026-02.csv",
          "2026-09": "futDataDown_TX_2026-09.csv", "2026-10": "futDataDown_TX_2026-10_to_10-06.csv"}
HEADER = (FIX / MONTHS["2026-09"]).read_bytes().splitlines()[0]


class Resp:
    def __init__(self, body):
        self.content, self.status_code = body, 200

    def raise_for_status(self):
        pass


class Session:
    """Replays the recorded months for the rows inside the asked window; a window longer than
    one month gets TAIFEX's HTML alert; months never recorded answer the header alone."""

    def __init__(self, html_for=(), empty=()):
        self.posts, self.html_for, self.empty = [], set(html_for), set(empty)

    def post(self, url, data=None, headers=None, timeout=None):
        assert url == D._TAIFEX_FUT_DAILY, url
        self.posts.append(dict(data))
        s = pd.Timestamp(data["queryStartDate"].replace("/", "-"))
        e = pd.Timestamp(data["queryEndDate"].replace("/", "-"))
        months = list(pd.period_range(s, e, freq="M").strftime("%Y-%m"))
        if e > s + pd.DateOffset(months=1) or any(m in self.html_for for m in months):
            return Resp((FIX / "futDataDown_window_over_one_month.html").read_bytes())
        out = [HEADER]
        for ym in months:
            if ym not in MONTHS or ym in self.empty:
                continue
            for line in (FIX / MONTHS[ym]).read_bytes().splitlines()[1:]:
                if s <= pd.Timestamp(line.split(b",")[0].decode().replace("/", "-")) <= e:
                    out.append(line)
        return Resp(b"\r\n".join(out) + b"\r\n")

    def windows(self):
        return [(p["queryStartDate"], p["queryEndDate"]) for p in self.posts]


class NoWait:
    def acquire(self):
        pass


def fresh(**kw):
    D._CACHE_DIR = Path(tempfile.mkdtemp(prefix="txfpub-"))
    D._TW_PUBLIC_SESSION = Session(**kw)
    D._TW_PUBLIC_LIMITER = NoWait()
    return D._TW_PUBLIC_SESSION


def bar(df, day):
    r = df.loc[pd.Timestamp(day, tz="Asia/Taipei")]
    return tuple(float(r[c]) for c in ("Open", "High", "Low", "Close", "Volume"))


blave_calls = []


BLAVE_2011 = pd.read_csv(FIX / "blave_txf_1d_2011-01-03_2011-02-15.csv", index_col="time", parse_dates=True)


def _blave_raw(symbol, schema, start, end, headers):
    D._check_data_access(headers)   # what the real _fetch_twfutures_raw does first
    blave_calls.append((symbol, schema))
    if start < "2012":              # the recorded Blave series: nothing before 2011-01-03
        return BLAVE_2011[BLAVE_2011.index >= pd.Timestamp(start)]
    idx = pd.DatetimeIndex(["2026-09-01 16:00"])
    return pd.DataFrame({"Open": 1.0, "High": 1.0, "Low": 1.0, "Close": 1.0, "Volume": 1.0}, index=idx)


D._fetch_twfutures_raw_smart = _blave_raw

# ── gate ──
os.environ.pop("BLAVE_AGENT_LOCAL", None)
os.environ["BLAVE_DATA_ACCESS"] = "0"
s = fresh()
try:
    D.fetch_txf_daily_public("2026-09-01", "2026-09-30")
    check(False, "no BLAVE_AGENT_LOCAL → raises")
except D.TwPublicUnavailable:
    check(not s.posts, "no BLAVE_AGENT_LOCAL → TwPublicUnavailable, zero requests")
try:
    D.fetch_twfutures_ohlcv("TXF", "1d", "2026-09-01", "2026-09-30", {})
    check(False, "cloud + no access → DataAccessError")
except D.DataAccessError:
    check(not s.posts and not blave_calls, "cloud machine + no access: DataAccessError as before, no TAIFEX request")
os.environ["BLAVE_AGENT_LOCAL"] = "1"

# ── parse: listing month ──
s = fresh()
df = D.fetch_txf_daily_public("1990-01-01", "1998-07-31")
check(s.windows() == [("1998/07/01", "1998/08/01")], f"start before listing clamps to 1998-07: one request {s.windows()}")
check(len(df) == 9 and df.index[0] == pd.Timestamp("1998-07-21", tz="Asia/Taipei"), f"1998-07: 9 bars from 1998-07-21 ({len(df)})")
check(bar(df, "1998-07-21") == (8131.0, 8131.0, 8036.0, 8045.0, 208.0), "1998-07-21 = 199809 day session as recorded")
check(bar(df, "1998-07-31") == (7660.0, 7683.0, 7600.0, 7600.0, 257.0), "1998-07-31 = 199809 (the far months are listed too)")

# ── stitch: 2026-09 ──
s = fresh()
df = D.fetch_txf_daily_public("2026-09-01", "2026-09-30")
check(s.windows() == [("2026/09/01", "2026/10/01")], f"one request for the month, ending on the next month's first day {s.windows()}")
raw = D._taifex_txf_daily_raw("2026-09-01", "2026-09-30")
check(tuple(raw.loc[pd.Timestamp("2026-08-31 16:00")]) == (46126.0, 47220.0, 45788.0, 47209.0, 57627.0 + 25137.0),
      "09-01: 盤後 row opens the bar and sets the low, 一般 row closes it, volume is both sessions")
check(bar(df, "2026-09-02") == (47201.0, 47343.0, 46131.0, 46189.0, 46145.0 + 38354.0),
      "09-02: 盤後 open and high, 一般 low and close")
check(bar(df, "2026-09-16") == (45533.0, 46093.0, 45330.0, 45759.0, 28491.0 + 22905.0),
      "09-16 settlement day: the expiring 202609 (close 45759 at 13:30), not 202610")
check(bar(df, "2026-09-17") == (46153.0, 47037.0, 46056.0, 46445.0, 50102.0 + 32283.0),
      "09-17: 202610 from its own 盤後 row on")
check(len(df) == 20 and df.index.tz is not None and str(df.index.tz) == "Asia/Taipei"
      and all(t.hour == 0 for t in df.index),
      f"21 trading days less the start day's bar (dated 08-31 16:00 UTC, outside [start, end] like the Blave 1d path), "
      f"Asia/Taipei midnight index ({len(df)})")
check(list(df.columns) == ["Open", "High", "Low", "Close", "Volume"] and all(df.dtypes == float)
      and df.attrs["source"] == "TAIFEX", "five float columns, attrs['source'] = 'TAIFEX'")
cached = pd.read_parquet(D._CACHE_DIR / "twfutures_public_1d_TXF" / "2026-09.parquet")
check(cached.index.tz is None and cached.index[0] == pd.Timestamp("2026-09-01 16:00")
      and cached.index[-1] == pd.Timestamp("2026-09-30 16:00"),
      "month file holds naive UTC (Taipei midnight − 8h): 09-02 … 10-01 bars, as the Blave 1d cache files it")

# ── stitch: holiday-shifted settlement, no holiday bar ──
s = fresh()
df = D.fetch_txf_daily_public("2026-02-01", "2026-02-28")
check(bar(df, "2026-02-23") == (33600.0, 34369.0, 33600.0, 33840.0, 40512.0 + 47486.0),
      "02-23 (settlement shifted past the Lunar New Year): still 202602, its 盤後 row from 02-11 evening")
check(bar(df, "2026-02-24") == (33957.0, 34956.0, 33821.0, 34827.0, 78032.0 + 48895.0), "02-24: 202603")
check(not any(pd.Timestamp("2026-02-12") <= t.tz_localize(None) <= pd.Timestamp("2026-02-22") for t in df.index),
      "no bar inside the closure (the evening session is dated 02-23 by TAIFEX)")

# ── cache ──
s = fresh()
df = D.fetch_txf_daily_public("2026-09-01", None)
check(s.windows() == [("2026/09/01", "2026/10/01"), ("2026/10/01", "2026/10/07")],
      f"cold: one request per past month, then the current month to tomorrow {s.windows()}")
check(df.index[-1] == pd.Timestamp("2026-10-06", tz="Asia/Taipei") and bar(df, "2026-10-06")[0] == 49960.0,
      "today's bar is in once its 一般 row is published")
n = len(s.posts)
df2 = D.fetch_txf_daily_public("2026-09-01", None)
check(s.windows()[n:] == [("2026/10/05", "2026/10/07")] and df2.equals(df),
      f"second call: the past month is not re-asked, the current month from its last bar {s.windows()[n:]}")
raw = D._taifex_txf_daily_raw("2026-08-20", "2026-10-06")
check(s.windows()[n + 1:] == [("2026/08/20", "2026/09/20"), ("2026/09/21", "2026/10/06")],
      f"a span over one month is asked in one-month windows {s.windows()[n + 1:]}")
check(raw.index[0] == pd.Timestamp("2026-08-31 16:00") and len(raw) == 24,
      f"and stitched across them: 20 September + 4 October bars, August unrecorded ({len(raw)})")

s = fresh(html_for=("2026-09",))
try:
    D.fetch_txf_daily_public("2026-09-01", "2026-09-30")
    check(False, "HTML answer → raises")
except D.TwPublicUnavailable:
    check(not (D._CACHE_DIR / "twfutures_public_1d_TXF" / "2026-09.parquet").exists(),
          "HTML answer → TwPublicUnavailable, nothing cached for the month")
s = fresh()
try:
    D.fetch_txf_daily_public("2026-03-01", "2026-03-31")
    check(False, "settled month with no rows → raises")
except D.TwPublicUnavailable:
    check(not (D._CACHE_DIR / "twfutures_public_1d_TXF" / "2026-03.parquet").exists(),
          "a settled month with no rows raises (outage), never cached as empty")
s = fresh(empty=("2026-10",))
df = D.fetch_txf_daily_public("2026-10-01", None)
check(df.empty and df.attrs["source"] == "TAIFEX" and len(s.posts) == 1, "the current month may legitimately be empty")

# ── routing through fetch_twfutures_ohlcv ──
s = fresh()
blave_calls.clear()
for sym in ("TXF", "MXF", "TXFR1"):
    df = D.fetch_twfutures_ohlcv(sym, "1d", "2026-09-01", "2026-09-30", {})
    check(df.attrs.get("source") == "TAIFEX" and bar(df, "2026-09-02")[0] == 47201.0 and not blave_calls,
          f"desktop + no access: {sym} '1d' comes from TAIFEX")
try:
    D.fetch_twfutures_ohlcv("TXF", "1m", "2026-09-01", "2026-09-30", {})
    check(False, "1m with no access → DataAccessError")
except D.DataAccessError:
    check(not blave_calls, "desktop + no access: '1m' is still DataAccessError (no key-free intraday)")
os.environ.pop("BLAVE_DATA_ACCESS", None)
n = len(s.posts)
df = D.fetch_twfutures_ohlcv("TXF", "1d", "2026-09-01", "2026-09-30", {"api-key": "k"})
check(blave_calls == [("TXF", "1d")] and len(s.posts) == n and "source" not in df.attrs,
      "desktop with access: the Blave path, no TAIFEX request")
os.environ["BLAVE_SCHEDULED_RUN"] = "1"
s = fresh()   # a new cache dir: the Blave stub's September bar is already cached in the old one
blave_calls.clear()
df = D.fetch_twfutures_ohlcv("TXF", "1d", "2026-09-01", "2026-09-30", {})
check(df.attrs.get("source") == "TAIFEX" and not blave_calls, "scheduled desktop run with no key in .env: TAIFEX")
df = D.fetch_twfutures_ohlcv("TXF", "1d", "2026-09-01", "2026-09-30", {"api-key": "k"})
check(blave_calls == [("TXF", "1d")], "scheduled desktop run with a key: Blave")
os.environ.pop("BLAVE_SCHEDULED_RUN", None)

# ── TAIFEX head in front of the Blave series ──
def calendar(*months):
    days = set()
    for ym in months:
        for line in (FIX / MONTHS[ym]).read_bytes().decode("cp950").splitlines()[1:]:
            x = line.split(",")
            if x[17].strip() == "一般":
                days.add(x[0].replace("/", "-"))
    return sorted(days)


KEY = {"api-key": "k"}
SEAM = pd.Timestamp("2011-01-03", tz="Asia/Taipei")
s = fresh()
blave_calls.clear()
df = D.fetch_twfutures_ohlcv("TXF", "1d", "2010-12-01", "2011-02-15", KEY)
check(df.attrs.get("source") == "TAIFEX/Blave" and blave_calls == [("TXF", "1d")],
      "desktop + access + start before 2011-01-03: both sources, tagged TAIFEX/Blave")
before, after = df[df.index < SEAM].tail(20), df[df.index >= SEAM].head(20)
got = [t.strftime("%Y-%m-%d") for t in pd.concat([before, after]).index]
want = [d for d in calendar("2010-12", "2011-01") if "2010-12-01" < d]
check(len(before) == 20 and len(after) == 20 and not df.index.duplicated().any() and df.index.is_monotonic_increasing
      and got == want[-len(got):] and got[19:21] == ["2010-12-31", "2011-01-03"],
      f"seam: 20 trading days each side, no repeated and no missing day against TAIFEX's calendar ({got[0]} … {got[-1]})")
check(bar(df, "2010-12-31") == (8892.0, 8997.0, 8892.0, 8988.0, 88956.0) and bar(df, "2011-01-03") == (9000.0, 9030.0, 8995.0, 9020.0, 61366.0),
      "seam: 2010-12-31 is the TAIFEX row, 2011-01-03 the Blave bar, no price adjustment")
os.environ["BLAVE_DATA_ACCESS"] = "0"
tx = D.fetch_twfutures_ohlcv("TXF", "1d", "2010-12-01", "2011-01-31", {})
os.environ.pop("BLAVE_DATA_ACCESS", None)
same = [d for d in after.index if d in tx.index and after.loc[d, "Close"] == tx.loc[d, "Close"]]
check(len(same) == 19 and [d.strftime("%Y-%m-%d") for d in after.index if d not in same] == ["2011-01-19"],
      "the 20 Blave days after the seam close where TAIFEX does, bar the 01-19 settlement day recorded under the old 13:31 roll")
n = len(s.posts)
df = D.fetch_twfutures_ohlcv("TXF", "1d", "2011-01-03", "2011-02-15", KEY)
check(len(s.posts) == n and "source" not in df.attrs, "a start on or after 2011-01-03: no TAIFEX request")

s = fresh(html_for=("2010-12",))
import contextlib
import io
buf = io.StringIO()
with contextlib.redirect_stdout(buf):
    df = D.fetch_twfutures_ohlcv("TXF", "1d", "2010-12-01", "2011-02-15", KEY)
check(df.index[0] == SEAM and "source" not in df.attrs and "TAIFEX unavailable" in buf.getvalue(),
      "TAIFEX down: the Blave series alone, with a printed warning — never a failed fetch")

s = fresh()
os.environ.pop("BLAVE_AGENT_LOCAL", None)
df = D.fetch_twfutures_ohlcv("TXF", "1d", "2010-12-01", "2011-02-15", KEY)
check(not s.posts and df.index[0] == SEAM and "source" not in df.attrs, "cloud machine: Blave alone from 2011-01-03, no TAIFEX request")
os.environ["BLAVE_AGENT_LOCAL"] = "1"

# ── MXF / TMF: TAIFEX bars only from the contract's own listing day ──
s = fresh()
tx, mx = D.fetch_txf_daily_public("2001-04-01", "2001-04-30"), D.fetch_txf_daily_public("2001-04-01", "2001-04-30", "MXF")
check(tx.index[0] == pd.Timestamp("2001-04-02", tz="Asia/Taipei") and mx.index[0] == pd.Timestamp("2001-04-09", tz="Asia/Taipei")
      and mx.equals(tx[tx.index >= mx.index[0]]), "MXF: the same TX bars, from 2001-04-09 (MTX listing day)")
s = fresh()
df = D.fetch_txf_daily_public("2010-12-01", "2010-12-31", "TMF")
check(df.empty and not s.posts and df.attrs["source"] == "TAIFEX", "TMF before 2024-07-29: empty, no request")
df = D.fetch_twfutures_ohlcv("TMF", "1d", "2010-12-01", "2011-02-15", KEY)
check(not s.posts and df.index[0] == SEAM and "source" not in df.attrs, "TMF with access: no TAIFEX head (not listed before 2011), Blave from 2011-01-03")
os.environ["BLAVE_DATA_ACCESS"] = "0"
df = D.fetch_twfutures_ohlcv("MXF", "1d", "2001-04-01", "2001-04-30", {})
check(df.index[0] == pd.Timestamp("2001-04-09", tz="Asia/Taipei"), "MXF with no access: from its listing day too")
os.environ.pop("BLAVE_DATA_ACCESS", None)

print("\nFAILS:", fails)
sys.exit(1 if fails else 0)
