"""Minimal check: TXF and 股票期貨 daily bars from the Blave CDN (lib.data _txf_daily_cdn,
_stock_futures_batch_free). No network: TAIFEX futDataDown answers from a synthetic month set,
the CDN from files built out of the same rows, Blave is a stub.

  - TXF parity: fetch_txf_daily_public from the CDN equals the TAIFEX path frame for frame
    (values, index, dtypes, attrs['source']), TXF / MXF / TMF, any window; no TAIFEX request
  - TXF fallback: CDN down, enabled:false, unreadable file → the TAIFEX path, same frame, ⚠️ line
  - TXF tail: days after the CDN's asof that TAIFEX already has come from TAIFEX
  - TXF cache: a second call downloads nothing (manifest fresh, txf.parquet sha matches)
  - 股票期貨 without Blave access (desktop): CDN rows in the Blave API's columns and dtypes; an id
    the CDN does not list is skipped; CDN down → TAIFEX per contract-month, cached (a second
    call asks nothing for a past month)
  - with Blave access, and on a cloud machine: the Blave endpoint only, the CDN never asked

Run: cd blave-agent && MPLBACKEND=Agg .venv/bin/python tests/check_twfut_cdn_daily.py
"""
import contextlib
import hashlib
import io
import json
import os
import sys
import tempfile
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
os.environ.setdefault("MPLBACKEND", "Agg")

import pandas as pd
import pyarrow as pa
import pyarrow.parquet as pq
import requests

import lib.data as D

fails = 0


def check(cond, msg):
    global fails
    print(("  PASS  " if cond else "  FAIL  ") + msg)
    fails += (not cond)


HEADER = ("交易日期,契約,到期月份(週別),開盤價,最高價,最低價,收盤價,漲跌價,漲跌%,成交量,結算價,未沖銷契約數,"
          "最後最佳買價,最後最佳賣價,歷史最高價,歷史最低價,是否因訊息面暫停交易,交易時段,價差對單式委託成交量")


def _line(d, code, month, o, h, lo, c, vol, session, settle="-", oi="-", chg="-", pct="-"):
    return f"{d},{code},{month}  ,{o},{h},{lo},{c},{chg},{pct},{vol},{settle},{oi},-,-,-,-,,{session},,"


def _rows():
    """Every weekday 2024-01-02 … 2024-03-29: TX near + next month, both sessions, a spread row;
    CDF the same; a single-trade 盤後 print on 2024-02-01."""
    out = []
    d, i = datetime(2024, 1, 2), 0
    while d <= datetime(2024, 3, 29):
        if d.weekday() < 5:
            ds = d.strftime("%Y/%m/%d")
            third_wed = [x for x in pd.date_range(d.replace(day=1), periods=31) if x.weekday() == 2][2]
            near = d.strftime("%Y%m") if d <= third_wed else (d + pd.offsets.MonthBegin(1)).strftime("%Y%m")
            nxt = (pd.Timestamp(near + "01") + pd.offsets.MonthBegin(1)).strftime("%Y%m")
            p = 17000 + 7 * i
            out += [_line(ds, "TX", near, p, p + 50, p - 40, p + 10, 90000 + i, "一般", settle=p + 10, oi=80000),
                    _line(ds, "TX", near, p - 5, p + 60 if i % 7 else "-", p - 50 if i % 7 else "-", p,
                          30000 + i, "盤後"),
                    _line(ds, "TX", nxt, p + 30, p + 70, p - 10, p + 40, 3000, "一般", settle=p + 40, oi=9000),
                    _line(ds, "TX", f"{near}/{nxt}", 30, 31, 29, 30, 500, "一般"),
                    _line(ds, "CDF", near, 600 + i, 610 + i, 590 + i, 605 + i, 1000 + i, "一般", settle=605 + i,
                          oi=20000 + i, chg="5", pct="0.83%"),
                    _line(ds, "CDF", near, 604 + i, 606 + i, 601 + i, 603 + i, 50, "盤後"),
                    _line(ds, "CDF", nxt, "-", "-", "-", "-", 0, "一般", settle=606 + i, oi=10),
                    _line(ds, "CDF", f"{near}/{nxt}", 1, 1, 1, 1, 5, "一般"),
                    _line(ds, "DHF", near, 30, 31, 29, 30, 7, "一般", settle=30, oi=300)]
            i += 1
        d += timedelta(days=1)
    return out


ROWS = _rows()


class FakeResponse:
    def __init__(self, content, status=200):
        self.content, self.status_code, self.headers = content, status, {}

    def raise_for_status(self):
        if self.status_code >= 400:
            raise requests.HTTPError(f"{self.status_code}", response=self)


class FakeTaifex:
    """futDataDown: the rows of `commodity_id` ('TX', 'CDF' …) dated inside the window."""

    def __init__(self):
        self.calls = []

    def post(self, url, data=None, headers=None, timeout=None):
        self.calls.append(dict(data))
        lo = data["queryStartDate"].replace("/", "-")
        hi = data["queryEndDate"].replace("/", "-")
        keep = [r for r in ROWS if r.split(",")[1] == data["commodity_id"]
                and lo <= r.split(",")[0].replace("/", "-") <= hi]
        return FakeResponse(("\r\n".join([HEADER] + keep) + "\r\n").encode("cp950"))


def _parquet(df):
    buf = io.BytesIO()
    pq.write_table(pa.Table.from_pandas(df, preserve_index=False), buf)
    return buf.getvalue()


def build_cdn(asof, enabled=True):
    """The files the api job publishes, built from ROWS through the lib's own parsers."""
    rows = [r.split(",") for r in ROWS if r.split(",")[0].replace("/", "-") <= asof]
    col = {n: i for i, n in enumerate(HEADER.split(","))}
    bars = D._taifex_near_month_bars([r for r in rows if r[1] == "TX"], col)
    txf = pd.DataFrame({"date": (bars.index + pd.Timedelta(hours=8)).date, "open": bars["Open"].values,
                        "high": bars["High"].values, "low": bars["Low"].values, "close": bars["Close"].values,
                        "volume": bars["Volume"].values})
    sf = D._stock_futures_frame(D._taifex_stock_futures_rows([r for r in rows if r[1] in ("CDF", "DHF")], col))
    sf["date"] = pd.to_datetime(sf["date"]).dt.date
    files = {"txf.parquet": _parquet(txf), "year/2024.parquet": _parquet(sf[sf["date"] < datetime(2024, 3, 1).date()]),
             "recent.parquet": _parquet(sf[sf["date"] >= datetime(2024, 2, 15).date()])}
    manifest = {"schema": "twfutures-daily-v1", "asof": asof, "enabled": enabled, "first_day": "1998-07-21",
                "recent_from": "2024-02-15", "txf": [str(txf["date"].iloc[0]), asof],
                "years": {"2024": {"immutable": False, "last": asof}},
                "stock_futures": {"CDF": ["2024-01-02", asof], "DHF": ["2024-01-02", asof]},
                "files": {k: hashlib.sha256(v).hexdigest() for k, v in files.items()}}
    files["manifest.json"] = json.dumps(manifest).encode()
    return files


class FakeCdn:
    def __init__(self, files, down=False):
        self.files, self.down, self.calls = files, down, []

    def get(self, key, etag=None):
        self.calls.append(key)
        if self.down:
            raise D.TwCdnUnavailable(f"{key}: ConnectionError")
        if key not in self.files:
            raise D.TwCdnUnavailable(f"{key}: HTTP 404")
        tag = hashlib.md5(self.files[key]).hexdigest()
        return (None, etag) if etag == tag else (self.files[key], tag)


blave_calls = []


def blave_ok(url, **kw):
    blave_calls.append(url)

    class R:
        def json(self):
            ids = kw.get("params", {}).get("futures_ids", "").split(",")
            return {"data": {i: [{"date": "2024-01-02", "futures_id": i}] for i in ids}, "failed": []}
    return R()


_TPE = timezone(timedelta(hours=8))
_real_expected = D._taifex_expected_day


def env(files=None, down=False, local=True, access=False, now_day="2024-03-29"):
    D._CACHE_DIR = Path(tempfile.mkdtemp())
    cdn = FakeCdn(files or build_cdn("2024-03-29"), down)
    D._twfut_cdn_get = cdn.get
    tx = FakeTaifex()
    D._TW_PUBLIC_SESSION = tx
    D._tw_public_session = lambda: tx
    D._TW_PUBLIC_LIMITER = D._RateLimiter(1000, 1.0)
    D._retry_get = blave_ok
    blave_calls.clear()
    D._taifex_expected_day = lambda now=None: now_day
    D._tw_cdn_expected_asof = lambda now=None, published=None: now_day
    if local:
        os.environ["BLAVE_AGENT_LOCAL"] = "1"
    else:
        os.environ.pop("BLAVE_AGENT_LOCAL", None)
    if access:
        os.environ.pop("BLAVE_DATA_ACCESS", None)
    else:
        os.environ["BLAVE_DATA_ACCESS"] = "0"
    return cdn, tx


def taifex_path(start, end, symbol="TXF"):
    """The frame fetch_txf_daily_public returned before the CDN: the TAIFEX path alone."""
    env(down=True)
    with contextlib.redirect_stdout(io.StringIO()):
        return D.fetch_txf_daily_public(start, end, symbol)


def same(a, b):
    return (a.equals(b) and a.index.equals(b.index) and a.index.dtype == b.index.dtype
            and list(a.dtypes) == list(b.dtypes) and a.attrs.get("source") == b.attrs.get("source"))


D.time.sleep = lambda s: None
HDR = {"api-key": "k", "secret-key": "s"}

print("TXF parity")
for start, end in (("2024-01-02", "2024-03-29"), ("2024-01-01", "2024-03-31"), ("2024-02-05", "2024-02-20"),
                   ("2024-03-04", "2024-03-04")):
    want = taifex_path(start, end)
    cdn, tx = env()
    got = D.fetch_txf_daily_public(start, end)
    check(same(got, want) and not tx.calls and len(got) >= 1,
          f"{start}→{end}: CDN frame == TAIFEX frame ({len(got)} bars), no TAIFEX request")
for sym in ("MXF", "TMF"):
    want = taifex_path("2024-01-02", "2024-03-29", sym)
    env()
    check(same(D.fetch_txf_daily_public("2024-01-02", "2024-03-29", sym), want), f"{sym}: same frame as TAIFEX")

print("TXF fallback")
want = taifex_path("2024-01-02", "2024-03-29")
for label, files, down in (("CDN down", None, True), ("enabled:false", build_cdn("2024-03-29", enabled=False), False)):
    cdn, tx = env(files, down)
    out = io.StringIO()
    with contextlib.redirect_stdout(out):
        got = D.fetch_txf_daily_public("2024-01-02", "2024-03-29")
    check(same(got, want) and tx.calls and "Blave CDN unavailable" in out.getvalue(), f"{label} → TAIFEX path, ⚠️ line")
broken = build_cdn("2024-03-29")
broken["txf.parquet"] = b"not a parquet"
m = json.loads(broken["manifest.json"])
m["files"]["txf.parquet"] = hashlib.sha256(b"not a parquet").hexdigest()
broken["manifest.json"] = json.dumps(m).encode()
cdn, tx = env(broken)
with contextlib.redirect_stdout(io.StringIO()):
    got = D.fetch_txf_daily_public("2024-01-02", "2024-03-29")
check(same(got, want) and tx.calls, "an unreadable txf.parquet → TAIFEX path")

print("TXF tail and cache")
cdn, tx = env(build_cdn("2024-03-26"), now_day="2024-03-29")
got = D.fetch_txf_daily_public("2024-01-02", "2024-03-29")
check(same(got, want) and tx.calls and all(c["queryStartDate"] >= "2024/03/01" for c in tx.calls),
      f"days after the CDN's asof come from TAIFEX, the rest from the CDN ({len(tx.calls)} request(s))")
cdn, tx = env()
D.fetch_txf_daily_public("2024-01-02", "2024-03-29")
n = len(cdn.calls)
again = D.fetch_txf_daily_public("2024-01-02", "2024-03-29")
check(len(cdn.calls) == n and not tx.calls and same(again, want), "a second call downloads nothing")

print("股票期貨 without Blave access")
cdn, tx = env()
out = io.StringIO()
with contextlib.redirect_stdout(out):
    got = D.fetch_stock_futures_batch_daily(["CDF", "DHF", "ZZF"], "2024-01-15", "2024-03-20", HDR)
api_like = pd.DataFrame([dict(date="2024-01-15", futures_id="CDF", contract_date="202401", open=1.0, max=1.0,
                              min=1.0, close=1.0, spread=0.0, spread_per=0.0, volume=1, settlement_price=1.0,
                              open_interest=1, trading_session="position")])
cdf = got.get("CDF")
check(set(got) == {"CDF", "DHF"} and "ZZF" in out.getvalue() and not tx.calls and not blave_calls,
      "CDN rows for listed ids, an unlisted id skipped, no TAIFEX / Blave request")
check(cdf is not None and list(cdf.columns) == list(api_like.columns) and list(cdf.dtypes) == list(api_like.dtypes),
      f"Blave API columns and dtypes ({None if cdf is None else dict(cdf.dtypes)})")
check(cdf["date"].min() == "2024-01-15" and cdf["date"].max() == "2024-03-20"
      and not cdf["contract_date"].str.contains("/").any() and set(cdf["trading_session"]) == {"position", "after_market"}
      and cdf.attrs.get("source") == "TAIFEX", "window, no spreads, both sessions, attrs['source'] = TAIFEX")
want_sf = {}
cdn, tx = env(down=True)
with contextlib.redirect_stdout(io.StringIO()):
    want_sf = D.fetch_stock_futures_batch_daily(["CDF", "DHF"], "2024-01-15", "2024-03-20", HDR)
n = len(tx.calls)
check(n == 6 and want_sf["CDF"].equals(cdf) and want_sf["DHF"].equals(got["DHF"]),
      f"CDN down → TAIFEX per contract-month, same rows ({n} requests: 2 ids × 3 months)")
with contextlib.redirect_stdout(io.StringIO()):
    D.fetch_stock_futures_batch_daily(["CDF"], "2024-01-15", "2024-02-20", HDR)
check(len(tx.calls) == n, "past months are not asked again")

print("with Blave access / cloud")
cdn, tx = env(access=True)
got = D.fetch_stock_futures_batch_daily(["CDF"], "2024-01-15", "2024-03-20", HDR)
check(blave_calls and not cdn.calls and not tx.calls, "desktop with access: the Blave endpoint, CDN never asked")
cdn, tx = env(local=False, access=True)
got = D.fetch_stock_futures_batch_daily(["CDF"], "2024-01-15", "2024-03-20", HDR)
check(blave_calls and not cdn.calls and not tx.calls, "cloud machine: the Blave endpoint, CDN never asked")
try:
    D.fetch_txf_daily_public("2024-01-02", "2024-03-29")
    check(False, "cloud machine: the TXF key-free path refuses")
except D.TwPublicUnavailable:
    check(not cdn.calls, "cloud machine: the TXF key-free path refuses before the CDN")

D._taifex_expected_day = _real_expected
print(f"\n{'OK' if not fails else f'{fails} FAILED'}")
sys.exit(1 if fails else 0)
