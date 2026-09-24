"""Minimal check: the key-free Taiwan daily-bar path in lib.data — TWSE STOCK_DAY / TPEx
tradingStock month by month, 除權息 factors from TWT49U / exDailyQ, FinMind free as the second
source, Blave as the last. No network: the exchange session is stubbed and replays recorded
answers from tests/fixtures/tw_free_daily/ (one real fetch each, 2026-09-24).

  - 2330 2024-01 = 22 rows, values as recorded (01-02 close 593 / 27,997,826 shares, 01-31 628)
  - 6488 (OTC) 2024-01 from TPEx: 成交仟股 ×1,000, ROC dates, name padding harmless
  - market from the full-market files, cached; a non-"no data" TWSE stat never caches empty;
    an empty month is a marker re-asked after a day (empty_marker_ttl_hours=24)
  - 2330 2023 factors from TWT49U = 1.00541 / 1.00468 / 1.00558 / 1.00523, applied forward;
    6488 2023 from exDailyQ; the event table is served from cache on the second call
  - a second price call for the same month makes no request; the throttle spaces requests 1 s
  - source order: exchange → FinMind free → Blave, and BLAVE_TWSTOCK_DAILY_SOURCE=blave
  - FEED_TIMING['twstock_price'] = 17:35 Taipei; align_feed hides today's bar before that

Run: cd blave-agent && MPLBACKEND=Agg .venv/bin/python tests/check_tw_free_daily.py
"""
import contextlib
import io
import json
import os
import sys
import tempfile
import time
from pathlib import Path

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
os.environ.setdefault("MPLBACKEND", "Agg")

import numpy as np
import pandas as pd
import requests

import lib.data as D

FIX = Path(ROOT) / "tests" / "fixtures" / "tw_free_daily"
TPE = "Asia/Taipei"
fails = 0


def check(cond, msg):
    global fails
    print(("  PASS  " if cond else "  FAIL  ") + msg)
    fails += (not cond)


def quiet(fn, *a, **k):
    with contextlib.redirect_stdout(io.StringIO()):
        return fn(*a, **k)


class FakeResponse:
    def __init__(self, body, status=200):
        self.status_code = status
        self.content = body if isinstance(body, bytes) else json.dumps(body, ensure_ascii=False).encode()

    def json(self):
        return json.loads(self.content.decode("utf-8-sig"))

    def raise_for_status(self):
        if self.status_code >= 400:
            raise requests.HTTPError(f"{self.status_code}", response=self)


def _fixture(name):
    return (FIX / name).read_bytes()


ROUTES = [   # (url, params that must match) → fixture file
    (D._TWSE_STOCK_DAY_ALL, {"response": "open_data"}, "twse_stock_day_all.csv"),
    (D._TPEX_MAINBOARD, {}, "tpex_mainboard_quotes.json"),
    (D._TWSE_STOCK_DAY, {"stockNo": "2330", "date": "20240101"}, "twse_stock_day_2330_2024-01.json"),
    (D._TPEX_TRADING_STOCK, {"code": "6488", "date": "2024/01/01"}, "tpex_trading_stock_6488_2024-01.json"),
    (D._TWSE_EXRIGHT, {"startDate": "20230101", "endDate": "20231231"}, "twse_twt49u_2023.json"),
    (D._TWSE_EXRIGHT, {"startDate": "20240101", "endDate": "20241231"}, "twse_twt49u_2024.json"),
    (D._TPEX_EXRIGHT, {"startDate": "2023/01/01", "endDate": "2023/12/31"}, "tpex_exdailyq_2023.json"),
    (D._FINMIND_DATA, {"dataset": "TaiwanStockPrice", "data_id": "2330"}, "finmind_2330_2024-01.json"),
]


class FakeSession:
    """Replays ROUTES; `down` = URLs that raise ConnectionError (site unreachable)."""
    def __init__(self, down=()):
        self.calls, self.down = [], set(down)

    def get(self, url, params=None, headers=None, timeout=None):
        params = dict(params or {})
        self.calls.append((url, params))
        if url in self.down:
            raise requests.exceptions.ConnectionError(f"down: {url}")
        for r_url, need, name in ROUTES:
            if url == r_url and all(params.get(k) == v for k, v in need.items()):
                return FakeResponse(_fixture(name))
        raise requests.exceptions.ConnectionError(f"no fixture for {url} {params}")


sleeps = []
D.time.sleep = lambda s: sleeps.append(s)          # throttle / backoff waits are recorded, not slept
os.environ.pop("BLAVE_TWSTOCK_DAILY_SOURCE", None)
os.environ["BLAVE_AGENT_LOCAL"] = "1"              # the desktop marker: the free chain is the default here


def fresh(down=()):
    """New cache dir + new session + new throttle → every source is cold."""
    tmp = tempfile.mkdtemp()
    D._CACHE_DIR = Path(tmp)
    D._TW_PUBLIC_SESSION = FakeSession(down)
    D._TW_PUBLIC_LIMITER = D._RateLimiter(1, 1.0)
    return D._TW_PUBLIC_SESSION


def urls(session):
    return [u for u, _ in session.calls]


def t_parse_twse():
    s = fresh()
    df = D.fetch_twstock_price("2330", "2024-01-01", "2024-01-31", {})
    check(len(df) == 22 and list(df.columns) == D._TW_DAILY_COLS,
          f"2330 2024-01 from TWSE STOCK_DAY: 22 rows, OHLCV columns (got {len(df)})")
    check(df.index[0] == pd.Timestamp("2024-01-02") and df.index.tz is None,
          "ROC date 113/01/02 → naive 2024-01-02 index")
    check(df.loc["2024-01-02", "Close"] == 593.0 and df.loc["2024-01-02", "Volume"] == 27997826.0
          and df.loc["2024-01-02", "Open"] == 590.0 and df.loc["2024-01-31", "Close"] == 628.0,
          "values match the recorded answer (01-02 O 590 / C 593 / 27,997,826 shares; 01-31 C 628)")
    check(df.attrs.get("source") == "TWSE", f"attrs['source'] = TWSE (got {df.attrs.get('source')})")
    check(urls(s) == [D._TWSE_STOCK_DAY_ALL, D._TPEX_MAINBOARD, D._TWSE_STOCK_DAY],
          "market from the two full-market files, then one STOCK_DAY request for the month")
    n = len(s.calls)
    again = D.fetch_twstock_price("2330", "2024-01-01", "2024-01-31", {})
    check(len(s.calls) == n and again.equals(df), "second call for the same past month: no request, same frame")
    return df


def t_parse_tpex():
    s = fresh()
    df = D.fetch_twstock_price("6488", "2024-01-01", "2024-01-31", {})
    check(len(df) == 22 and df.attrs.get("source") == "TPEx", f"6488 2024-01 from TPEx tradingStock: 22 rows")
    check(df.loc["2024-01-02", "Volume"] == 1451000.0 and df.loc["2024-01-02", "Close"] == 580.0
          and df.loc["2024-01-31", "Close"] == 579.0,
          "成交仟股 1,451 → 1,451,000 shares; 01-02 close 580, 01-31 close 579")
    check(urls(s)[-1] == D._TPEX_TRADING_STOCK and D._TWSE_STOCK_DAY not in urls(s),
          "an OTC id goes to TPEx only (never asks TWSE for it)")
    check(D._tw_public_market("6488") == "tpex" and D._tw_public_market("2330") == "twse"
          and len(s.calls) == 3, "market lookups served from the cached market file (no new request)")


def t_twse_stat_guard():
    fresh()
    D._TW_PUBLIC_SESSION.get = lambda url, params=None, headers=None, timeout=None: FakeResponse(
        {"stat": "很抱歉，沒有符合條件的資料!"})
    check(D._twse_stock_day("3474", "2024-01").empty, "TWSE 「沒有符合條件的資料」 → an empty month")
    D._TW_PUBLIC_SESSION.get = lambda url, params=None, headers=None, timeout=None: FakeResponse(
        {"stat": "查詢日期小於99年1月4日，請重新查詢!"})
    try:
        D._twse_stock_day("2330", "2005-01")
        check(False, "any other TWSE stat raises (never cached as an empty month)")
    except D.TwPublicUnavailable:
        check(True, "any other TWSE stat raises (never cached as an empty month)")


def t_empty_month_ttl():
    """An empty TWSE month is a marker with a day's TTL, not a permanent hole: a throttled
    answer that reads like 「沒有符合條件」 is asked again the next day."""
    s = fresh()
    real_get = s.get

    def get(url, params=None, headers=None, timeout=None):
        if url == D._TWSE_STOCK_DAY:
            s.calls.append((url, dict(params or {})))
            return FakeResponse({"stat": "很抱歉，沒有符合條件的資料!"})
        return real_get(url, params, headers, timeout)
    s.get = get

    def asked():
        return sum(1 for u, _ in s.calls if u == D._TWSE_STOCK_DAY)
    df = quiet(D._fetch_twstock_daily_public, "2330", "2024-01-01", "2024-01-31")
    check(df.empty and asked() == 1, "an empty past month: one STOCK_DAY request, an empty frame")
    quiet(D._fetch_twstock_daily_public, "2330", "2024-01-01", "2024-01-31")
    check(asked() == 1, "a second call the same day makes no request (the empty marker holds)")
    marker = D._monthly_cache_dir("twstock_daily", {"id": "2330", "src": "twse"}) / "2024-01.parquet"
    old = time.time() - 25 * 3600
    os.utime(marker, (old, old))
    quiet(D._fetch_twstock_daily_public, "2330", "2024-01-01", "2024-01-31")
    check(asked() == 2, "a marker older than a day is asked again (empty_marker_ttl_hours=24)")


def t_factors():
    s = fresh()
    ev = D._tw_exright_for("2330", "twse", "2023-01-01", "2023-12-31")
    f = (ev["prev_close"] / ev["ref_price"]).round(5).tolist()
    check(list(ev.index.strftime("%m-%d")) == ["03-16", "06-15", "09-14", "12-14"]
          and f == [1.00541, 1.00468, 1.00558, 1.00523],
          f"2330 2023 TWT49U factors 前收/參考價 = {f} on the four ex-dates")
    check(s.calls[-1][1].get("startDate") == "20230101" and s.calls[-1][1].get("endDate") == "20231231",
          "one TWT49U request covers the year (startDate/endDate, not strDate)")
    n = len(s.calls)
    D._tw_exright_for("2330", "twse", "2023-03-01", "2023-06-30")
    check(len(s.calls) == n, "event table for those months served from the monthly cache (no request)")
    check(len(list((D._CACHE_DIR / "twstock_exright_twse").glob("2023-*.parquet"))) == 12,
          "the year's answer is split into 12 month files")
    days = pd.bdate_range("2023-01-02", "2023-12-29")
    bars = pd.DataFrame({"Open": 100.0, "High": 100.0, "Low": 100.0, "Close": 100.0, "Volume": 1.0}, index=days)
    adj = D._tw_forward_adjust(bars, ev)
    c = adj["Close"]
    check(c.loc["2023-03-15"] == 100.0 and c.loc["2023-03-16"] == 100.54 and c.loc["2023-06-15"] == 101.01
          and c.loc["2023-12-14"] == round(100 * np.prod(f), 2) and (adj["Volume"] == 1.0).all(),
          "forward adjust: bars before an ex-date untouched, from it on × cumulative factor, rounded to 2, volume unchanged")
    tp = D._tw_exright_for("6488", "tpex", "2023-01-01", "2023-12-31")
    check(tp["prev_close"].tolist() == [443.0, 542.0] and tp["ref_price"].tolist() == [436.5, 532.5],
          "6488 2023 exDailyQ: 01-05 443/436.5, 07-19 542/532.5")


def t_adj_entry():
    fresh()
    raw = D.fetch_twstock_price("2330", "2024-01-01", "2024-01-31", {})
    adj = D.fetch_twstock_price_adj("2330", "2024-01-01", "2024-01-31", {})
    check(list(adj.columns) == ["Open", "Close"] and adj.attrs.get("source") == "TWSE",
          "fetch_twstock_price_adj: Open/Close only, source TWSE")
    check(adj["Close"].equals(raw["Close"]) and len(adj) == 22,
          "no 2330 ex-date in 2024-01 (TWT49U 2024) → adjusted equals raw for the month")


def t_throttle():
    s = fresh()
    del sleeps[:]
    D._tw_public_get(D._TWSE_STOCK_DAY_ALL, {"response": "open_data"})
    D._tw_public_get(D._TPEX_MAINBOARD, {})
    check(len(s.calls) == 2 and len(sleeps) == 1 and 0 < sleeps[0] <= 1.0,
          f"two back-to-back requests: the second waits the rest of the second (sleep {sleeps})")
    check(s.calls[0][0] == D._TWSE_STOCK_DAY_ALL and "User-Agent" in D._TW_PUBLIC_HEADERS,
          "requests go through the shared session with the lib's User-Agent")


def t_fallback():
    s = fresh(down={D._TWSE_STOCK_DAY})
    df = quiet(D.fetch_twstock_price, "2330", "2024-01-01", "2024-01-31", {})
    check(len(df) == 22 and df.attrs.get("source") == "FinMind" and df.loc["2024-01-02", "Volume"] == 27997826.0,
          "TWSE unreachable → FinMind free TaiwanStockPrice serves the same 22 rows")
    u = urls(s)
    check(u.count(D._TWSE_STOCK_DAY) == 3 and u.index(D._FINMIND_DATA) > u.index(D._TWSE_STOCK_DAY),
          "order: the exchange (3 tries) before FinMind")

    s = fresh(down={D._TWSE_STOCK_DAY, D._FINMIND_DATA})
    blave_calls = []
    real_retry_get = D._retry_get

    def fake_retry_get(url, **kw):
        blave_calls.append(url)
        return FakeResponse({"data": [{"date": "2024-01-02", "open": 590, "high": 593, "low": 589,
                                       "close": 593, "volume": 27997826}]})
    D._retry_get = fake_retry_get
    try:
        df = quiet(D.fetch_twstock_price, "2330", "2024-01-01", "2024-01-31", {"api-key": "x"})
    finally:
        D._retry_get = real_retry_get
    check(df.attrs.get("source") == "Blave" and blave_calls == [f"{D.BASE}/studio/market/twstock/price/2330"]
          and u.index(D._FINMIND_DATA) < len(s.calls), "both free sources down → the Blave endpoint, last")

    s = fresh()
    os.environ["BLAVE_TWSTOCK_DAILY_SOURCE"] = "blave"
    D._retry_get = fake_retry_get
    try:
        df = D.fetch_twstock_price("2330", "2024-01-01", "2024-01-31", {"api-key": "x"})
    finally:
        D._retry_get = real_retry_get
        del os.environ["BLAVE_TWSTOCK_DAILY_SOURCE"]
    check(df.attrs.get("source") == "Blave" and s.calls == [],
          "BLAVE_TWSTOCK_DAILY_SOURCE=blave: no exchange / FinMind request at all")

    # where the lib runs decides the default: cloud fleet (no desktop flag) = Blave only
    s = fresh()
    blave_calls.clear()
    del os.environ["BLAVE_AGENT_LOCAL"]
    D._retry_get = fake_retry_get
    try:
        df = D.fetch_twstock_price("2330", "2024-01-01", "2024-01-31", {"api-key": "x"})
        check(df.attrs.get("source") == "Blave" and s.calls == [] and len(blave_calls) == 1,
              "cloud default (BLAVE_AGENT_LOCAL absent): Blave only — zero exchange / FinMind requests")
        os.environ["BLAVE_TWSTOCK_DAILY_SOURCE"] = "public"
        s = fresh()
        df = D.fetch_twstock_price("2330", "2024-01-01", "2024-01-31", {})
        check(df.attrs.get("source") == "TWSE" and D._TWSE_STOCK_DAY in urls(s),
              "BLAVE_TWSTOCK_DAILY_SOURCE=public forces the chain even without the desktop flag")
    finally:
        D._retry_get = real_retry_get
        os.environ.pop("BLAVE_TWSTOCK_DAILY_SOURCE", None)
        os.environ["BLAVE_AGENT_LOCAL"] = "1"
    s = fresh()
    df = D.fetch_twstock_price("2330", "2024-01-01", "2024-01-31", {})
    check(df.attrs.get("source") == "TWSE" and urls(s)[-1] == D._TWSE_STOCK_DAY,
          "desktop default (BLAVE_AGENT_LOCAL=1, no override): the exchange chain")

    s = fresh()
    future = (pd.Timestamp.now(tz=TPE) + pd.Timedelta(days=3)).strftime("%Y-%m-%d")
    blave_calls.clear()
    D._retry_get = fake_retry_get
    try:
        df = quiet(D.fetch_twstock_price, "2330", future, None, {})
        check(df.empty and s.calls == [] and blave_calls == [],
              "a start past Taipei tomorrow with end=None: empty frame, no request anywhere")
        D.fetch_twstock_price("2330", "2027/01/01", None, {"api-key": "x"})
    finally:
        D._retry_get = real_retry_get
    check(s.calls == [] and len(blave_calls) == 1, "a malformed start skips the free chain and goes to Blave (whose 400 names the format)")


def t_feed_timing():
    spec = D.FEED_TIMING["twstock_price"]
    due = spec["available"](pd.DatetimeIndex(["2026-09-24"], tz=TPE))[0]
    check(due == pd.Timestamp("2026-09-24 17:35", tz=TPE) and spec["tz"] == TPE and "17:30" in spec["basis"],
          f"FEED_TIMING twstock_price: the day's bar counts from 17:35 Taipei (got {due})")
    check(all(D.FEED_TIMING.get(k) is spec for k in ("twstock_price_adj", "twstock_price_batch", "twstock_price_adj_batch")),
          "the adj / batch fetchers share the entry")
    hours = (9, 10, 11, 12, 13, 15, 16, 17, 18)
    idx = pd.DatetimeIndex([pd.Timestamp("2026-09-24", tz=TPE) + pd.Timedelta(hours=h) for h in hours])
    bars = pd.DataFrame({"Close": 1.0}, index=idx.tz_convert("UTC").tz_localize(None))
    daily = pd.DataFrame({"Close": [100.0, 101.0]}, index=pd.DatetimeIndex(["2026-09-23", "2026-09-24"]))
    got = D.align_feed(bars, daily, "twstock_price", "60m", bar_tz="UTC")["Close"]
    check((got.iloc[:-2] == 100.0).all() and (got.iloc[-2:] == 101.0).all(),
          "60m bars on 09-24: up to the 16:00 bar (close 17:00) carry 09-23's close; 17:00 bar (close 18:00) carries 09-24's")
    try:
        with D.live_feeds():
            D.align_feed(bars, daily.iloc[:1], "twstock_price", "60m", bar_tz="UTC")
        check(False, "live at 18:00 without today's bar → FeedNotPublished")
    except D.FeedNotPublished as e:
        check(e.due_at == pd.Timestamp("2026-09-24 17:35", tz=TPE), f"live at 18:00 without today's bar → FeedNotPublished due 17:35 (got {e.due_at})")
    with D.live_feeds():
        early = D.align_feed(bars.iloc[:5], daily.iloc[:1], "twstock_price", "60m", bar_tz="UTC")
    check(early["Close"].iloc[-1] == 100.0, "live at the 13:00 bar: today's bar is not due yet → no raise, uses 09-23")


def main():
    t_parse_twse()
    t_parse_tpex()
    t_twse_stat_guard()
    t_empty_month_ttl()
    t_factors()
    t_adj_entry()
    t_throttle()
    t_fallback()
    t_feed_timing()
    print(f"\n{'ALL PASS' if not fails else f'{fails} FAIL'}")
    sys.exit(1 if fails else 0)


if __name__ == "__main__":
    main()
