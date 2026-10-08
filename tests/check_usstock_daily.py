"""Minimal check: lib.data.fetch_usstock_price — US daily bars from Yahoo's chart endpoint, yfinance
as the fallback, desktop app only. No network: the Yahoo session is stubbed and replays answers
recorded 2026-10-01 (tests/fixtures/usstock_daily/, trimmed); yfinance is a stub module fed by the
real yfinance 1.7.0 output recorded the same day.

  - cloud machine (BLAVE_AGENT_LOCAL unset / '0'): UsStockUnavailable with the sentence to relay,
    before any request and without serving a cached snapshot; a live tick says it cannot go live yet
  - caliber: the direct path equals real yfinance history(auto_adjust=True) on the same dates
    (OHLC within 1e-5, Volume exact); the yfinance fallback gives the same numbers again
  - AAPL 2020-08-31 4:1 split reads +3.4 %, not −75 %; Volume is never dividend-scaled
  - chain: Yahoo down → yfinance (⚠️ printed, attrs['source']); Yahoo 404 → UsStockNotFound, no
    fallback; both down / yfinance missing → UsStockUnavailable naming each
  - cache: one snapshot per (symbol, source), served without a request until a newer bar can be
    final; a stale snapshot is replaced whole (a new dividend factor never mixes with the old)
  - a bar is kept only once final (FEED_TIMING 17:00 New York, DST via the zone); align_feed on
    crypto bars sees the day's row from 17:00 NY and refuses live until it lands
  - Yahoo gets its own session / UA / throttle; the Taiwan sources' UA is untouched
  - _sanity_check_ohlc widens a bar whose open / close lies outside high-low, ignores float noise
  - off the desktop even the private fetchers (_yahoo_session, _yahoo_get, both raw fetchers) refuse before a request;
    a cloud scheduled report gets the desktop-only sentence, a live tick the "cannot go live" one
  - no adjclose (Yahoo) / Adj Close filled with Close (yfinance, a dividend in range) and a 200 with no
    bars are failures: never cached; a 429 that outlasts the retries stops both sources for the process
  - a US holiday turning crypto bars NaN in align_feed is announced (day, count, likely cause)
  - the runner and quality_check know the fetcher (publication-time replay; a price, not an indicator)
  - the desktop installs yfinance: WORKSPACE_DEPS pins it and its nine dependencies, yfinance last

Run: cd blave-agent && MPLBACKEND=Agg .venv/bin/python tests/check_usstock_daily.py
"""
import contextlib
import io
import json
import os
import sys
import tempfile
import types
from pathlib import Path

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
os.environ.setdefault("MPLBACKEND", "Agg")

import numpy as np
import pandas as pd
import requests

import lib.data as D

FIX = Path(ROOT) / "tests" / "fixtures" / "usstock_daily"
NY = "America/New_York"
fails = 0


def check(cond, msg):
    global fails
    print(("  PASS  " if cond else "  FAIL  ") + msg)
    fails += (not cond)


def capture(fn, *a, **k):
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        out = fn(*a, **k)
    return out, buf.getvalue()


def chart(sym):
    return json.loads((FIX / f"yahoo_chart_{sym}.json").read_text())


class FakeResponse:
    def __init__(self, body, status=200):
        self.status_code = status
        self._body = body

    def json(self):
        return self._body

    def raise_for_status(self):
        if self.status_code >= 400:
            raise requests.HTTPError(f"{self.status_code}", response=self)


class FakeYahoo:
    """Replays the chart fixtures; `bodies` overrides one symbol's answer, `down` = unreachable,
    `statuses` = HTTP statuses answered (body-less) before the fixtures, one per request."""
    def __init__(self, down=False, bodies=None, statuses=()):
        self.calls, self.down, self.bodies, self.statuses = [], down, dict(bodies or {}), list(statuses)

    def get(self, url, params=None, headers=None, timeout=None):
        self.calls.append((url, dict(params or {}), dict(headers or {})))
        if self.down:
            raise requests.exceptions.ConnectionError("down")
        if self.statuses:
            return FakeResponse({}, self.statuses.pop(0))
        sym = url.rsplit("/", 1)[-1]
        if sym in self.bodies:
            return FakeResponse(self.bodies[sym])
        path = FIX / f"yahoo_chart_{sym}.json"
        if not path.exists():
            return FakeResponse(json.loads((FIX / "yahoo_chart_404.json").read_text()), 404)
        return FakeResponse(json.loads(path.read_text()))


def yf_raw_csv(adj_filled=False):
    """Real yfinance history(auto_adjust=False) for AAPL 2020-08-03..09-04, as it hands it back, plus
    the Dividends column actions=True adds (from the Yahoo answer's own events). adj_filled = what
    yfinance does when Yahoo's answer has no adjclose: Adj Close := Close."""
    h = pd.read_csv(FIX / "yfinance_AAPL_auto_adjust_False.csv", index_col=0)
    h.index = pd.DatetimeIndex(h.index).tz_localize(NY)
    h["Dividends"] = 0.0
    for d in chart("AAPL")["chart"]["result"][0]["events"]["dividends"].values():
        day = pd.Timestamp(d["date"], unit="s", tz="UTC").tz_convert(NY).normalize()
        h.loc[day, "Dividends"] = d["amount"]
    h["Stock Splits"] = 0.0
    if adj_filled:
        h["Adj Close"] = h["Close"]
    return h


class YFRateLimitError(Exception):
    """Same class name as yfinance.exceptions.YFRateLimitError."""


class FakeYF(types.ModuleType):
    def __init__(self, fail=False, adj_filled=False, rate_limited=False):
        super().__init__("yfinance")
        self.calls, self.fail, self.cache_dir = [], fail, None
        self.adj_filled, self.rate_limited = adj_filled, rate_limited
        self.config = types.SimpleNamespace(debug=types.SimpleNamespace(hide_exceptions=True))

    def set_tz_cache_location(self, path):
        self.cache_dir = path

    def Ticker(self, sym):
        mod = self

        class _T:
            def history(self, **kw):
                mod.calls.append((sym, kw))
                if "raise_errors" in kw:
                    raise TypeError("history() got an unexpected keyword argument 'raise_errors'")
                if mod.rate_limited:
                    raise YFRateLimitError("Too Many Requests. Rate limited. Try after a while.")
                if mod.fail:
                    raise RuntimeError("yfinance blocked")
                return yf_raw_csv(mod.adj_filled) if sym == "AAPL" else pd.DataFrame()
        return _T()


sleeps = []
D.time.sleep = lambda s: sleeps.append(s)   # throttle / backoff waits are recorded, not slept


def fresh(down=False, bodies=None, yf_fail=False, yf_missing=False, statuses=(), yf_adj_filled=False,
          yf_rate_limited=False):
    D._CACHE_DIR = Path(tempfile.mkdtemp())
    D._YAHOO_SESSION = FakeYahoo(down, bodies, statuses)
    D._YAHOO_LIMITER = D._RateLimiter(1, 1.0)
    D._YF_CACHE_SET = False
    D._US_BLOCKED.update(yahoo=0.0, yfinance=0.0)
    yf = None if yf_missing else FakeYF(yf_fail, yf_adj_filled, yf_rate_limited)
    sys.modules["yfinance"] = yf
    os.environ["BLAVE_AGENT_LOCAL"] = "1"
    return D._YAHOO_SESSION, yf


def t_symbols():
    check(D._us_symbol(" aapl ") == "AAPL" and D._us_symbol("BRK.B") == "BRK-B" and D._us_symbol("brk-b") == "BRK-B",
          "tickers: 'aapl' → AAPL, 'BRK.B' / 'brk-b' → BRK-B")
    for bad, hint in (("2330", "fetch_twstock_price"), ("AAPLUSDT", "fetch_kline"), ("^GSPC", "indices"),
                      ("", "expects"), ("TOOLONGX", "expects")):
        try:
            D._us_symbol(bad)
            check(False, f"{bad!r} is refused")
        except ValueError as e:
            check(hint in str(e), f"{bad!r} is refused, pointing at {hint}")


def t_cloud_fail_closed():
    s, yf = fresh()
    capture(D.fetch_usstock_price, "AAPL", "2020-08-03", "2020-09-04")   # a snapshot now exists
    n = len(s.calls)
    for val in (None, "0", "true"):
        if val is None:
            os.environ.pop("BLAVE_AGENT_LOCAL", None)
        else:
            os.environ["BLAVE_AGENT_LOCAL"] = val
        os.environ["BLAVE_TWSTOCK_DAILY_SOURCE"] = "public"      # the TW override opens nothing here
        try:
            D.fetch_usstock_price("AAPL", "2020-08-03", "2020-09-04")
            check(False, f"BLAVE_AGENT_LOCAL={val!r}: refused")
        except D.UsStockUnavailable as e:
            check("美股資料目前只在電腦版可用" in str(e) and "cloud machine" in str(e) and "上線" not in str(e),
                  f"BLAVE_AGENT_LOCAL={val!r}: UsStockUnavailable with the sentence to relay")
        finally:
            os.environ.pop("BLAVE_TWSTOCK_DAILY_SOURCE", None)
    os.environ.pop("BLAVE_AGENT_LOCAL", None)
    os.environ["BLAVE_MODE"] = "live"
    try:
        D.fetch_usstock_price("AAPL", "2020-08-03", "2020-09-04")
        check(False, "a live tick is refused")
    except D.UsStockUnavailable as e:
        check("美股策略目前還不能上線" in str(e), "a live tick (no desktop flag, BLAVE_MODE=live): says US strategies cannot go live yet")
    finally:
        os.environ.pop("BLAVE_MODE", None)
    # the desktop daemon's ticks carry BLAVE_AGENT_LOCAL=1 (command_listener._local_child_env, for the key-free
    # TAIFEX / TWSE paths) — the refusal must hold there too, or a US signal would reach the order layer
    os.environ["BLAVE_AGENT_LOCAL"] = "1"
    os.environ["BLAVE_MODE"] = "live"
    try:
        D.fetch_usstock_price("AAPL", "2020-08-03", "2020-09-04")
        check(False, "a desktop live tick is refused")
    except D.UsStockUnavailable as e:
        check("美股策略目前還不能上線" in str(e) and len(s.calls) == n and yf.calls == [],
              "a desktop live tick (BLAVE_AGENT_LOCAL=1 + BLAVE_MODE=live): refused by mode, no request")
    finally:
        os.environ.pop("BLAVE_MODE", None)
        os.environ.pop("BLAVE_AGENT_LOCAL", None)
    os.environ["BLAVE_MODE"] = "live"
    os.environ["BLAVE_SCHEDULED_RUN"] = "1"
    try:
        D.fetch_usstock_price("AAPL", "2020-08-03", "2020-09-04")
        check(False, "a cloud scheduled report is refused")
    except D.UsStockUnavailable as e:
        check("美股資料目前只在電腦版可用" in str(e) and "上線" not in str(e),
              "a cloud scheduled report (BLAVE_MODE=live + BLAVE_SCHEDULED_RUN=1): the desktop-only sentence, not 'cannot go live'")
    finally:
        os.environ.pop("BLAVE_MODE", None)
        os.environ.pop("BLAVE_SCHEDULED_RUN", None)
    for fn, args in ((D._fetch_usstock_yahoo_raw, ("AAPL",)), (D._fetch_usstock_yfinance_raw, ("AAPL",)),
                     (D._yahoo_get, (D._YAHOO_CHART + "AAPL", {})), (D._usstock_daily, ("AAPL", None)),
                     (D._yahoo_session, ())):
        try:
            fn(*args)
            check(False, f"{fn.__name__} off the desktop is refused")
        except D.UsStockNotHere as e:
            check("美股資料目前只在電腦版可用" in str(e), f"{fn.__name__} called directly off the desktop: refused before any request")
    check(len(s.calls) == n and yf.calls == [],
          "off the desktop: no request to Yahoo or yfinance, and the cached snapshot is not served either")
    os.environ["BLAVE_AGENT_LOCAL"] = "1"


def t_parse_and_caliber():
    s, _ = fresh()
    df, out = capture(D.fetch_usstock_price, "AAPL", "2020-08-03", "2020-09-04")
    check(df.attrs.get("source") == "Yahoo" and len(df) == 25 and df.index.tz is None
          and df.index[0] == pd.Timestamp("2020-08-03") and df.index[-1] == pd.Timestamp("2020-09-04"),
          f"AAPL 2020-08-03..09-04 from Yahoo: 25 bars on naive New York dates (got {len(df)}, {df.attrs})")
    check(list(df.columns) == ["Open", "High", "Low", "Close", "Volume"], "columns Open/High/Low/Close/Volume")
    url, params, headers = s.calls[0]
    check(url == D._YAHOO_CHART + "AAPL" and params["interval"] == "1d" and params["events"] == "div,splits"
          and params["period1"] == D._YAHOO_PERIOD1, "one request, whole history, events=div,splits")

    yfa = pd.read_csv(FIX / "yfinance_AAPL_auto_adjust_True.csv", index_col=0)
    yfa.index = pd.DatetimeIndex(yfa.index)
    common = df.index.intersection(yfa.index)
    rel = max(float(np.max(np.abs(df.loc[common, c] / yfa.loc[common, c] - 1))) for c in ("Open", "High", "Low", "Close"))
    check(len(common) == 25 and rel < 1e-5 and (df.loc[common, "Volume"] == yfa.loc[common, "Volume"]).all(),
          f"same bars as real yfinance history(auto_adjust=True): OHLC within 1e-5 (max {rel:.1e}), Volume exact")

    raw = chart("AAPL")["chart"]["result"][0]
    q, adj = raw["indicators"]["quote"][0], raw["indicators"]["adjclose"][0]["adjclose"]
    i = 0
    ratio = adj[i] / q["close"][i]
    check(abs(df["Close"].iloc[i] - adj[i]) < 1e-9 and abs(df["Open"].iloc[i] - q["open"][i] * ratio) < 1e-9
          and abs(df["High"].iloc[i] - q["high"][i] * ratio) < 1e-9 and df["Volume"].iloc[i] == q["volume"][i],
          "Close = adjclose, Open/High/Low × adjclose/close, Volume as Yahoo has it")
    split = df["Close"].pct_change().loc["2020-08-31"]
    check(0.0 < split < 0.05, f"the 2020-08-31 4:1 split reads as the day's real move (+{split:.2%}), not −75 %")
    ex = df.index.get_loc(pd.Timestamp("2020-08-07"))
    raw_ret = q["close"][ex] / q["close"][ex - 1] - 1
    adj_ret = df["Close"].iloc[ex] / df["Close"].iloc[ex - 1] - 1
    check(adj_ret > raw_ret, f"ex-dividend 2020-08-07: the adjusted return adds the dividend back ({adj_ret:.4%} > {raw_ret:.4%})")


def t_fallback():
    s, yf = fresh(down=True)
    df, out = capture(D.fetch_usstock_price, "AAPL", "2020-08-03", "2020-09-04")
    check(df.attrs.get("source") == "yfinance" and len(df) == 25 and "trying yfinance" in out,
          "Yahoo unreachable → yfinance serves it, ⚠️ names the switch")
    check(len(yf.calls) == 1 and yf.calls[0][1].get("auto_adjust") is False and yf.calls[0][1].get("period") == "max"
          and yf.calls[0][1].get("actions") is True and yf.cache_dir == str(D._CACHE_DIR / "yfinance")
          and yf.config.debug.hide_exceptions is False,
          "yfinance asked once for the raw series (auto_adjust=False, actions=True, period=max; errors raised via "
          "config, not the deprecated raise_errors), its db kept in the workspace cache")
    fresh()
    direct, _ = capture(D.fetch_usstock_price, "AAPL", "2020-08-03", "2020-09-04")
    rel = max(float(np.max(np.abs(df[c] / direct[c] - 1))) for c in ("Open", "High", "Low", "Close"))
    check(rel < 1e-5 and (df["Volume"] == direct["Volume"]).all(),
          f"the yfinance path and the direct path give the same bars (max rel {rel:.1e})")

    s, yf = fresh()
    try:
        D.fetch_usstock_price("ZZZZQ", "2020-01-01", None)
        check(False, "unknown ticker raises")
    except D.UsStockNotFound as e:
        check("ZZZZQ" in str(e) and yf.calls == [], "Yahoo 404 Not Found → UsStockNotFound, yfinance not asked")

    s, yf = fresh(down=True, yf_fail=True)
    try:
        capture(D.fetch_usstock_price, "AAPL", "2020-08-03", None)
        check(False, "both sources down raises")
    except D.UsStockUnavailable as e:
        check("Yahoo" in str(e) and "yfinance" in str(e), "both down → UsStockUnavailable naming each source")
    fresh(down=True, yf_missing=True)
    try:
        capture(D.fetch_usstock_price, "AAPL", "2020-08-03", None)
        check(False, "yfinance missing raises")
    except D.UsStockUnavailable as e:
        check("not installed" in str(e), "Yahoo down and yfinance not installed → says so")


def us_files():
    return sorted(p.name for p in D._CACHE_DIR.glob("usstock_daily_*"))


def t_adjclose_missing():
    body = chart("AAPL")
    del body["chart"]["result"][0]["indicators"]["adjclose"]
    s, yf = fresh(bodies={"AAPL": body})
    df, out = capture(D.fetch_usstock_price, "AAPL", "2020-08-03", "2020-09-04")
    check(df.attrs.get("source") == "yfinance" and "no adjclose" in out and us_files() == ["usstock_daily_yfinance_AAPL.parquet"],
          "Yahoo answer without adjclose → refused (no Yahoo snapshot written), yfinance serves the adjusted series")
    s, yf = fresh(bodies={"AAPL": body}, yf_adj_filled=True)
    try:
        capture(D.fetch_usstock_price, "AAPL", "2020-08-03", "2020-09-04")
        check(False, "yfinance's Adj Close := Close fill is refused")
    except D.UsStockUnavailable as e:
        check("Adj Close is Close" in str(e) and us_files() == [],
              "yfinance filling Adj Close with Close (a dividend in range) → refused, nothing cached")
    no_div = yf_raw_csv(adj_filled=True)
    no_div["Dividends"] = 0.0
    yf2 = FakeYF()
    yf2.Ticker = lambda sym: types.SimpleNamespace(history=lambda **kw: no_div)
    fresh(down=True)
    sys.modules["yfinance"] = yf2
    df, _ = capture(D.fetch_usstock_price, "AAPL", "2020-08-03", "2020-09-04")
    check(df.attrs.get("source") == "yfinance" and len(df) == 25,
          "no dividend in range: Adj Close equal to Close is genuine and accepted")


def t_empty_200():
    empty = {"chart": {"result": [{"meta": {"symbol": "SPY"}, "indicators": {"quote": [{}]}}], "error": None}}
    s, yf = fresh(bodies={"SPY": empty})
    try:
        capture(D.fetch_usstock_price, "SPY", "2024-03-11", None)
        check(False, "200 with no bars is a failure")
    except D.UsStockUnavailable as e:
        check("200 with no bars" in str(e) and "yfinance" in str(e) and us_files() == [],
              "Yahoo 200 with no bars → a failure, yfinance tried, nothing cached")
    s.bodies.clear()
    df, _ = capture(D.fetch_usstock_price, "SPY", "2024-03-11", None)
    check(len(df) == 10 and len(s.calls) == 2, "the next call asks again and gets the real bars")


def t_rate_limit():
    s, yf = fresh(statuses=[429])
    df, _ = capture(D.fetch_usstock_price, "AAPL", "2020-08-03", "2020-09-04")
    check(df.attrs.get("source") == "Yahoo" and len(s.calls) == 2, "one 429 then 200: retried, served by Yahoo")
    s, yf = fresh(statuses=[429] * 3, yf_rate_limited=True)
    for sym in ("AAPL", "SPY"):
        try:
            capture(D.fetch_usstock_price, sym, "2020-08-03", None)
        except D.UsStockUnavailable:
            pass
    check(len(s.calls) == 3 and len(yf.calls) == 1,
          f"429 on every retry: the next symbol asks neither Yahoo nor yfinance again (Yahoo {len(s.calls)}, yfinance {len(yf.calls)})")


def t_cache():
    s, _ = fresh()
    capture(D.fetch_usstock_price, "AAPL", "2020-08-03", "2020-09-04")
    capture(D.fetch_usstock_price, "AAPL", "2020-08-10", None)
    check(len(s.calls) == 1, "a second call (and a later window) is served from the snapshot — no request")
    path = D._single_path(D._US_PREFIX, {"symbol": "AAPL", "src": "yahoo"})
    check(path.exists() and path.name == "usstock_daily_yahoo_AAPL.parquet", "one parquet per (symbol, source)")

    snap, _ = D._us_cache_read("AAPL", "yahoo")
    D._write_single(D._US_PREFIX, {"symbol": "AAPL", "src": "yahoo"}, snap, {"fetched_at": "2020-09-04T12:00:00"})
    capture(D.fetch_usstock_price, "AAPL", "2020-08-03", "2020-09-03")
    check(len(s.calls) == 1, "a window whose last bar was final before the snapshot → no request")

    body = chart("AAPL")
    a = body["chart"]["result"][0]["indicators"]["adjclose"][0]["adjclose"]
    body["chart"]["result"][0]["indicators"]["adjclose"][0]["adjclose"] = [x * 0.98 for x in a]   # a new dividend
    s.bodies["AAPL"] = body
    old, _ = capture(D.fetch_usstock_price, "AAPL", "2020-08-03", "2020-09-03")   # still the old snapshot
    newer, _ = capture(D.fetch_usstock_price, "AAPL", "2020-08-03", None)         # needs today → stale → refetch
    ratio = (newer["Close"].loc[old.index] / old["Close"]).to_numpy()
    check(len(s.calls) == 2 and len(old) == 24 and np.allclose(ratio, 0.98, rtol=0, atol=1e-12),
          "a stale snapshot is replaced whole: every bar carries the new factor (no old / new mix)")


def t_publication():
    spec = D.FEED_TIMING["usstock_price"]
    due = lambda d: spec["available"](pd.DatetimeIndex([d], tz=NY))[0].tz_convert("UTC")
    check(spec["tz"] == NY and spec["calendar"] == "us_trading_days" and spec["fresh"] == "raise"
          and due("2026-03-06") == pd.Timestamp("2026-03-06 22:00", tz="UTC")
          and due("2026-03-09") == pd.Timestamp("2026-03-09 21:00", tz="UTC")
          and due("2026-11-02") == pd.Timestamp("2026-11-02 22:00", tz="UTC"),
          "FEED_TIMING usstock_price: 17:00 New York — 22:00 UTC in winter, 21:00 UTC under daylight saving")
    from lib.runner import _feed_source
    check(_feed_source("fetch_usstock_price") == "usstock_price",
          "the runner's look-ahead replay cuts a recorded fetch_usstock_price by publication time")
    from lib.quality_check import _PRICE_OR_META_FETCHERS
    check("fetch_usstock_price" in _PRICE_OR_META_FETCHERS,
          "quality_check reads fetch_usstock_price as the traded instrument's own price, not an external indicator")

    raw = pd.DataFrame({c: [1.0, 1.0] for c in D._US_RAW_COLS},
                       index=pd.DatetimeIndex(["2026-09-23", "2026-09-24"], name="date"))
    at = lambda s: pd.Timestamp(s, tz=NY).tz_convert("UTC")
    check(len(D._us_published(raw, at("2026-09-24 16:59"))) == 1 and len(D._us_published(raw, at("2026-09-24 17:00"))) == 2,
          "today's bar is dropped until 17:00 New York (a session still running is not a bar)")

    sat = at("2026-09-26 10:00")
    check(D._us_stale(at("2026-09-25 16:00"), None, sat) and not D._us_stale(at("2026-09-25 17:30"), None, sat),
          "Saturday: a snapshot from before Friday 17:00 NY is stale, one from after is not")
    check(not D._us_stale(at("2026-09-21 18:00"), "2026-09-21", sat),
          "an end already final when the snapshot was taken → not stale, whatever has happened since")

    tomorrow = (pd.Timestamp.now(tz=NY) + pd.Timedelta(days=1)).normalize()
    body = chart("SPY")
    res = body["chart"]["result"][0]
    res["timestamp"].append(int((tomorrow + pd.Timedelta(hours=9, minutes=30)).timestamp()))
    for k in ("open", "high", "low", "close", "volume"):
        res["indicators"]["quote"][0][k].append(res["indicators"]["quote"][0][k][-1])
    res["indicators"]["adjclose"][0]["adjclose"].append(res["indicators"]["adjclose"][0]["adjclose"][-1])
    fresh(bodies={"SPY": body})
    df, _ = capture(D.fetch_usstock_price, "SPY", "2024-03-11", None)
    snap, _ = D._us_cache_read("SPY", "yahoo")
    check(df.index[-1] == pd.Timestamp("2024-03-22") and snap.index[-1] == pd.Timestamp("2024-03-22"),
          "a bar that is not final yet reaches neither the result nor the cache")


def t_align_feed():
    hours = pd.date_range("2026-09-24 18:00", "2026-09-24 23:00", freq="1h")   # UTC, 1h crypto bars
    bars = pd.DataFrame({"Close": 1.0}, index=hours)
    daily = pd.DataFrame({"Close": [100.0, 101.0]}, index=pd.DatetimeIndex(["2026-09-23", "2026-09-24"]))
    got = D.align_feed(bars, daily, "usstock_price", "1h", bar_tz="UTC")["Close"]
    # bar 20:00 UTC closes 21:00 UTC = 17:00 EDT → first to see 09-24
    check(list(got) == [100.0, 100.0, 101.0, 101.0, 101.0, 101.0],
          f"crypto 1h bars see 09-24's US close from the bar closing at 17:00 New York (got {list(got)})")
    try:
        with D.live_feeds():
            D.align_feed(bars, daily.iloc[:1], "usstock_price", "1h", bar_tz="UTC")
        check(False, "live after 17:00 NY without the day's row → FeedNotPublished")
    except D.FeedNotPublished as e:
        check(e.due_at == pd.Timestamp("2026-09-24 17:00", tz=NY), f"live without the day's row → FeedNotPublished due 17:00 NY (got {e.due_at})")
    weekend = pd.DataFrame({"Close": 1.0}, index=pd.date_range("2026-09-26 12:00", "2026-09-27 12:00", freq="6h"))
    fri = pd.DataFrame({"Close": [101.0, 102.0]}, index=pd.DatetimeIndex(["2026-09-24", "2026-09-25"]))
    with D.live_feeds():
        got = D.align_feed(weekend, fri, "usstock_price", "6h", bar_tz="UTC")["Close"]
    check(len(got) == len(weekend) and (got == 102.0).all(),
          "crypto bars over the weekend carry Friday's close — no Saturday / Sunday row is waited for")


def t_holiday_warning():
    bars = pd.DataFrame({"Close": 1.0}, index=pd.date_range("2026-04-02 00:00", "2026-04-07 00:00", freq="1h"))
    spy = pd.DataFrame({"Close": [1.0, 2.0, 3.0, 4.0]},
                       index=pd.DatetimeIndex(["2026-04-01", "2026-04-02", "2026-04-06", "2026-04-07"]))
    got, out = capture(D.align_feed, bars, spy, "usstock_price", "1h", bar_tz="UTC")
    n = int(got["Close"].isna().sum())
    check(n == 72 and "72 bar(s) set to NaN" in out and "2026-04-03" in out and "holiday" in out,
          f"Good Friday 2026-04-03: the 72 NaN bars are announced with the day and the likely cause (got {n}: {out.strip()[:160]})")
    _, quiet = capture(D.align_feed, bars.loc[:"2026-04-03 19:00"], spy, "usstock_price", "1h", bar_tz="UTC")
    check("set to NaN" not in quiet, "no hole, no warning")


def t_isolation_and_throttle():
    s, _ = fresh()
    check(D._TW_PUBLIC_HEADERS == {"User-Agent": "Mozilla/5.0 (compatible; blave-agent; +https://blave.org)"},
          "the Taiwan sources' User-Agent is unchanged")
    sleeps.clear()
    capture(D.fetch_usstock_price, "AAPL", "2020-08-03", None)
    capture(D.fetch_usstock_price, "SPY", "2024-03-11", None)
    check(all(h == D._YAHOO_HEADERS for _, _, h in s.calls) and D._yahoo_session() is not D._tw_public_session(),
          "Yahoo requests carry Yahoo's own headers on Yahoo's own session")
    check(any(0.5 < w <= 1.0 for w in sleeps), f"two cold symbols back to back are spaced by the 1 s Yahoo throttle (waits {sleeps})")


def t_ohlc_clamp():
    idx = pd.date_range("2026-01-05", periods=4, freq="D")
    df = pd.DataFrame({"Open": [10.0, 12.0, 10.0, 10.0], "High": [11.0, 11.5, 11.0, 9.0],
                       "Low": [9.0, 10.0, 9.0, 9.5], "Close": [10.5, 11.0, 9.0, 9.6]}, index=idx)
    low = pd.DataFrame({"Open": [10.0], "High": [11.0], "Low": [9.5], "Close": [9.2]}, index=idx[:1])
    lo_out, lo_msg = capture(D._sanity_check_ohlc, low, "t")
    check(lo_out["Low"].iloc[0] == 9.2 and lo_out["High"].iloc[0] == 11.0 and "widened" in lo_msg,
          "a close below the low lowers the low to it")
    df.loc[idx[2], "Low"] = np.nextafter(9.0, 10.0)    # float noise: low one ulp (2e-16) above the close
    out, msg = capture(D._sanity_check_ohlc, df, "t")
    check(len(out) == 3 and idx[3] not in out.index, "high < low is still dropped")
    check(out.loc[idx[1], "High"] == 12.0 and out.loc[idx[1], "Low"] == 10.0 and "widened the high/low of 1 bar" in msg,
          "an open above the high widens the high to it (bar kept, ⚠️ printed)")
    check(out.loc[idx[2], "Low"] == df.loc[idx[2], "Low"] and out.loc[idx[0]].equals(df.loc[idx[0]]),
          "float noise (one ulp) and clean bars are left alone")


def t_workspace_deps():
    import re
    src = (Path(ROOT) / "shell" / "main.js").read_text()
    body = re.search(r"const WORKSPACE_DEPS = \[(.*?)\];", src, re.S).group(1)
    pins = re.findall(r'"([^"]+)"', body)
    names = [p.split("==")[0] for p in pins]
    need = ["curl_cffi", "lxml", "peewee", "protobuf", "websockets", "beautifulsoup4", "multitasking",
            "platformdirs", "pytz", "yfinance"]
    check(all(re.fullmatch(r"[A-Za-z0-9_.-]+==[0-9][0-9A-Za-z.]*", p) for p in pins) and len(pins) == 17
          and all(n in names for n in need) and names[-1] == "yfinance",
          "WORKSPACE_DEPS installs yfinance and the nine it pulls in, every one pinned, yfinance last (17 in all)")


def main():
    t_symbols()
    t_cloud_fail_closed()
    t_parse_and_caliber()
    t_fallback()
    t_adjclose_missing()
    t_empty_200()
    t_rate_limit()
    t_cache()
    t_publication()
    t_align_feed()
    t_holiday_warning()
    t_isolation_and_throttle()
    t_ohlc_clamp()
    t_workspace_deps()
    print(f"\n{'ALL PASS' if not fails else f'{fails} FAIL'}")
    sys.exit(1 if fails else 0)


if __name__ == "__main__":
    main()
