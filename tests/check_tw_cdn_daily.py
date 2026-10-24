"""Minimal check: Taiwan daily bars from the Blave CDN (lib.data _fetch_twstock_daily_cdn and the
'cdn' chain). No network: the CDN answers from tests/fixtures/tw_cdn/ (files cut from the real
2026-10-15 build — the exchanges' numbers, footers as published), the exchange session replays
tests/fixtures/tw_free_daily/, and Blave is a stub.

  - parity: 2330 2024-01 from the CDN equals the exchange path (STOCK_DAY), raw and adjusted
  - 減資 / split smooth: 2603 2022-09-19 (raw +109%) and 0050 2025-06-18 (raw −74.8%) move less
    than the 10% limit adjusted; the factor comes from the file's footer events
  - chain: CDN first on the desktop and on a cloud machine (no Blave / exchange request when it
    serves); CDN down → Blave → exchange (desktop only; the cloud raises Blave's access error);
    manifest enabled=false, an id it lacks, a start before 2010-01-04 → next source
  - cache: a fresh manifest is not re-asked; a stock file is downloaded once and again only when
    the manifest lists a later last day (with If-None-Match)
  - tail: days after the CDN's asof that the exchange already published come from the exchange
    for those days only
  - batch: served from the CDN, per stock and from the whole-market files (same frames), with or
    without Blave access; with access one Blave /batch for an id the CDN does not list or a start
    before 2010-01-04; an id on no source → BatchIncomplete;
    an id the CDN lists but with no rows in the window → empty frame, no exchange crawl;
    a cloud machine's Blave batch with a column-less empty frame for an id → no KeyError
  - stale edge: a stock / recent file older than the manifest says is used once and asked again
  - hot cache: a current-month exchange file written after the last 17:35 final is not re-fetched
  - CDN behind the latest final: a per-stock batch fills the days from the exchange (final days only,
    single stock too); still short → Blave when it answers, else attrs['asof'] + ⚠️ and
    FeedNotPublished in a live scope; the whole-market path probes the exchange to tell a late CDN
    from a holiday
  - cloud lag: no exchange tail or probe; the holiday table tells a closed day (CDN frame, complete)
    from an open one (Blave for the lagging id; no access + live → FeedNotPublished)

Run: cd blave-agent && MPLBACKEND=Agg .venv/bin/python tests/check_tw_cdn_daily.py
"""
import contextlib
import io
import json
import os
import sys
import tempfile
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
os.environ.setdefault("MPLBACKEND", "Agg")

import pandas as pd
import pyarrow.parquet as pq
import requests

import lib.data as D

CDN = Path(ROOT) / "tests" / "fixtures" / "tw_cdn"
FREE = Path(ROOT) / "tests" / "fixtures" / "tw_free_daily"
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
        self.text = self.content.decode("utf-8", "replace")

    def json(self):
        return json.loads(self.content.decode("utf-8-sig"))

    def raise_for_status(self):
        if self.status_code >= 400:
            raise requests.HTTPError(f"{self.status_code}", response=self)


class FakeCdn:
    """Serves tests/fixtures/tw_cdn/<key>; ETag = 'v<n>-<key>' (the manifest's follows its content);
    `manifest` overrides the file."""
    def __init__(self, manifest=None, down=False):
        self.calls, self.down, self.version = [], down, 1
        self.override = {}          # key → bytes served instead of the fixture (a stale edge copy)
        self.manifest = manifest if manifest is not None else json.loads((CDN / "manifest.json").read_text())

    def get(self, key, etag=None):
        self.calls.append((key, etag))
        if self.down:
            raise D.TwCdnUnavailable(f"{key}: HTTP 503 (test)")
        body = json.dumps(self.manifest).encode() if key == "manifest.json" else None
        tag = f'"m{hash(body)}"' if body is not None else f'"v{self.version}-{key}"'
        if etag == tag:
            return None, tag
        if body is not None:
            return body, tag
        if key in self.override:
            return self.override[key], f'"stale-{key}"'
        path = CDN / key
        if not path.exists():
            raise D.TwCdnUnavailable(f"{key}: HTTP 403 (test)")
        return path.read_bytes(), tag


EX_ROUTES = [
    (D._TWSE_STOCK_DAY_ALL, {"response": "open_data"}, "twse_stock_day_all.csv"),
    (D._TPEX_MAINBOARD, {}, "tpex_mainboard_quotes.json"),
    (D._TWSE_STOCK_DAY, {"stockNo": "2330", "date": "20240101"}, "twse_stock_day_2330_2024-01.json"),
    (D._TWSE_EXRIGHT, {"startDate": "20240101"}, "twse_twt49u_2024.json"),
    (D._TWSE_REDUCTION, {"startDate": "20240101"}, "twse_twtauu_2024.json"),
    (D._TWSE_PAR_CHANGE, {"startDate": "20240101"}, "twse_twtb8u_2024.json"),
    (D._TWSE_ETF_SPLIT, {"startDate": "20240101"}, "twse_twtcau_2024.json"),
]


class FakeExchange:
    def __init__(self):
        self.calls = []

    def get(self, url, params=None, headers=None, timeout=None):
        params = dict(params or {})
        self.calls.append((url, params))
        for r_url, need, name in EX_ROUTES:
            if url == r_url and all(params.get(k) == v for k, v in need.items()):
                return FakeResponse((FREE / name).read_bytes())
        raise requests.exceptions.ConnectionError(f"no fixture for {url} {params}")


blave_calls = []


def blave_no_access(url, **kw):
    blave_calls.append(url)
    raise requests.HTTPError("403 Client Error: FORBIDDEN (test)", response=FakeResponse({"code": "ERR005"}, 403))


def blave_ok(url, **kw):
    blave_calls.append(url)
    if "/batch/" in url:
        ids = kw.get("params", {}).get("stock_ids", "").split(",")
        return FakeResponse({"data": {i: [{"date": "2024-01-02", "open": 1, "close": 2}] for i in ids}, "failed": []})
    return FakeResponse({"data": [{"date": "2024-01-02", "open": 1, "high": 2, "low": 1, "close": 2, "volume": 3}]})


D.time.sleep = lambda s: None
os.environ.pop("BLAVE_TWSTOCK_DAILY_SOURCE", None)
os.environ["BLAVE_AGENT_LOCAL"] = "1"


def fresh(manifest=None, down=False, blave=blave_no_access):
    D._CACHE_DIR = Path(tempfile.mkdtemp())
    cdn = FakeCdn(manifest, down)
    D._tw_cdn_get = cdn.get
    D._TW_PUBLIC_SESSION = FakeExchange()
    D._TW_PUBLIC_LIMITER = D._RateLimiter(1000, 1.0)
    D._TWSE_LIMITER = D._RateLimiter(1000, 1.0)
    D._retry_get = blave
    blave_calls.clear()
    return cdn


# freeze "now" after the fixture manifest's asof publication so no tail is asked unless a test wants one
_real_expected = D._tw_official_expected_day
_real_cdn_expected = D._tw_cdn_expected_asof


def pin_now(asof):
    D._tw_official_expected_day = lambda now=None: asof
    D._tw_cdn_expected_asof = lambda now=None: asof


def t_parity():
    cdn = fresh()
    pin_now(cdn.manifest["asof"])
    a = D.fetch_twstock_price("2330", "2024-01-01", "2024-01-31", {})
    check(a.attrs.get("source") == "TWSE" and a.attrs.get("via") == "Blave CDN" and blave_calls == []
          and D._TW_PUBLIC_SESSION.calls == [], "desktop default: the CDN serves 2330, no Blave / exchange request")
    os.environ["BLAVE_TWSTOCK_DAILY_SOURCE"] = "public"
    try:
        b = quiet(D.fetch_twstock_price, "2330", "2024-01-01", "2024-01-31", {})
        ba = quiet(D.fetch_twstock_price_adj, "2330", "2024-01-01", "2024-01-31", {})
    finally:
        del os.environ["BLAVE_TWSTOCK_DAILY_SOURCE"]
    check(b.attrs.get("source") == "TWSE" and "via" not in b.attrs, "'public' forces the exchange path")
    check(len(a) == len(b) == 22 and a.index.equals(b.index), "same 22 days as STOCK_DAY")
    check(a[D._TW_DAILY_COLS].equals(b[D._TW_DAILY_COLS]),
          "CDN 2330 2024-01 OHLCV == the exchange path, value for value (MI_INDEX vs STOCK_DAY)")
    aa = D.fetch_twstock_price_adj("2330", "2024-01-01", "2024-01-31", {})
    ratio = aa / ba
    check(aa.index.equals(ba.index) and float((ratio.max() / ratio.min() - 1).max()) < 1e-4,
          "adjusted: the same moves, one constant ratio (the CDN accumulates factors from 2010, "
          "the exchange path from the window start)")


def t_smooth():
    cdn = fresh()
    pin_now(cdn.manifest["asof"])
    for sid, start, end, day in (("2603", "2022-09-01", "2022-09-30", "2022-09-19"),
                                 ("0050", "2025-06-02", "2025-06-30", "2025-06-18")):
        raw = D.fetch_twstock_price(sid, start, end, {})["Close"]
        adj = D.fetch_twstock_price_adj(sid, start, end, {})["Close"]
        r_raw = raw.pct_change().loc[day]
        r_adj = adj.pct_change().loc[day]
        check(abs(r_raw) > 0.5 and abs(r_adj) < 0.10,
              f"{sid} {day}: raw move {r_raw:+.1%}, adjusted {r_adj:+.1%} (inside the 10% limit)")
        check((adj.pct_change().dropna().abs() < 0.10).all(), f"{sid}: every adjusted day-move in {start[:7]} within 10%")


def t_chain():
    fresh(down=True)
    df = quiet(D.fetch_twstock_price, "2330", "2024-01-01", "2024-01-31", {})
    check(df.attrs.get("source") == "TWSE" and "via" not in df.attrs and len(blave_calls) == 1,
          "CDN down → Blave (403, no access) → the exchange")
    fresh(down=True, blave=blave_ok)
    df = quiet(D.fetch_twstock_price, "2330", "2024-01-01", "2024-01-31", {"api-key": "x"})
    check(df.attrs.get("source") == "Blave" and D._TW_PUBLIC_SESSION.calls == [],
          "CDN down, Blave access → Blave before the exchange (CDN → Blave → exchange → FinMind)")
    m = json.loads((CDN / "manifest.json").read_text())
    m["enabled"] = False
    cdn = fresh(manifest=m)
    pin_now(m["asof"])
    df = quiet(D.fetch_twstock_price, "2330", "2024-01-01", "2024-01-31", {})
    check("via" not in df.attrs and [k for k, _ in cdn.calls] == ["manifest.json"],
          "manifest enabled=false → no stock file asked, the next source serves")
    cdn = fresh()
    try:
        quiet(D._fetch_twstock_daily_cdn, "2330", "2009-12-01", "2024-01-31")
        check(False, "a start before the CDN's first_day raises TwCdnUnavailable (→ next source)")
    except D.TwCdnUnavailable:
        check(True, "a start before the CDN's first_day raises TwCdnUnavailable (→ next source)")
    cdn = fresh()
    try:
        quiet(D._fetch_twstock_daily_cdn, "9998", "2024-01-01", "2024-01-31")
        check(False, "an id not in the manifest raises TwCdnUnavailable")
    except D.TwCdnUnavailable:
        check(True, "an id not in the manifest raises TwCdnUnavailable")
    del os.environ["BLAVE_AGENT_LOCAL"]
    try:
        cdn = fresh(blave=blave_ok)
        pin_now(cdn.manifest["asof"])
        df = D.fetch_twstock_price("2330", "2024-01-01", "2024-01-31", {"api-key": "x"})
        check(df.attrs.get("via") == "Blave CDN" and blave_calls == [] and D._TW_PUBLIC_SESSION.calls == [],
              "cloud default: the CDN first too, no Blave / exchange request when it serves")
        fresh(down=True, blave=blave_no_access)
        try:
            quiet(D.fetch_twstock_price, "2330", "2024-01-01", "2024-01-31", {})
            check(False, "cloud, CDN down, no Blave access: the access error, never the exchange")
        except requests.HTTPError:
            check(D._TW_PUBLIC_SESSION.calls == [] and len(blave_calls) == 1,
                  "cloud, CDN down, no Blave access: the access error, never the exchange")
    finally:
        os.environ["BLAVE_AGENT_LOCAL"] = "1"


def t_cache():
    cdn = fresh()
    pin_now(cdn.manifest["asof"])
    D.fetch_twstock_price("2330", "2024-01-01", "2024-01-31", {})
    D.fetch_twstock_price("2330", "2024-01-01", "2024-01-31", {})
    keys = [k for k, _ in cdn.calls]
    check(keys == ["manifest.json", "stock/2330.parquet"], f"two calls: one manifest + one stock GET (got {keys})")
    m = json.loads(json.dumps(cdn.manifest))
    m["stocks"]["2330"][2] = "2099-01-01"
    cdn.manifest = m
    meta = D._tw_cdn_dir() / "manifest.json.meta.json"
    meta.write_text(json.dumps({**json.loads(meta.read_text()), "checked_at": time.time() - 7200}))
    cdn.version = 1
    D.fetch_twstock_price("2330", "2024-01-01", "2024-01-31", {})
    check(cdn.calls[-1] == ("stock/2330.parquet", '"v1-stock/2330.parquet"'),
          "an hour later the manifest lists a later last day → the stock file is asked again with If-None-Match (304 → cached copy)")


def t_tail():
    cdn = fresh()
    asof = cdn.manifest["asof"]
    nxt = (pd.Timestamp(asof) + pd.Timedelta(days=3)).strftime("%Y-%m-%d")
    pin_now(asof)
    D._tw_official_expected_day = lambda now=None: nxt
    asked = []
    real = D._fetch_twstock_daily_public

    def fake_public(sid, s, e, adjust=False):
        asked.append((sid, s, e))
        f = D._tw_daily_frame([(pd.Timestamp(nxt), 1.0, 1.0, 1.0, 1.0, 5.0)])
        f.attrs["source"] = "TWSE"
        return f
    D._fetch_twstock_daily_public = fake_public
    try:
        df = D.fetch_twstock_price("2330", "2024-01-01", None, {})
    finally:
        D._fetch_twstock_daily_public = real
    check(asked and asked[0][1] == (pd.Timestamp(asof) + pd.Timedelta(days=1)).strftime("%Y-%m-%d")
          and df.index[-1] == pd.Timestamp(nxt) and df.attrs.get("via") == "Blave CDN",
          f"exchange asked only from the day after the CDN's asof {asof}; its bar appended")


def t_batch():
    cdn = fresh()
    pin_now(cdn.manifest["asof"])
    ids = ["2330", "2603"]
    per = D.fetch_twstock_price_adj_batch(ids, "2022-08-01", "2022-10-31", {})
    check(set(per) == set(ids) and all(list(f.columns) == ["Open", "Close"] for f in per.values())
          and blave_calls == [] and all(f.attrs.get("via") == "Blave CDN" for f in per.values()),
          "batch: the CDN serves every id it lists, Blave is not asked")
    fresh()
    D._TW_CDN_WHOLE_MARKET_IDS = 1
    try:
        whole = D.fetch_twstock_price_adj_batch(ids, "2022-08-01", "2022-10-31", {})
        whole_raw = D.fetch_twstock_price_batch(ids, "2022-08-01", "2022-10-31", {})
    finally:
        D._TW_CDN_WHOLE_MARKET_IDS = 40
    check(all(whole[i].equals(per[i]) for i in ids), "whole-market year files give the same frames as per-stock files")
    check(set(whole_raw) == set(ids) and list(whole_raw["2603"].columns) == D._TW_DAILY_COLS, "raw batch: OHLCV")
    cdn = fresh(blave=blave_ok)
    pin_now(cdn.manifest["asof"])
    got = D.fetch_twstock_price_adj_batch(["2330", "9998"], "2024-01-01", "2024-01-31", {"api-key": "x"})
    asked = [u for u in blave_calls if "/batch/" in u]
    check(got["2330"].attrs.get("via") == "Blave CDN" and "via" not in got["9998"].attrs and len(asked) == 1,
          "with Blave access: CDN for 2330, one Blave /batch for the id the CDN does not list")
    fresh(blave=blave_ok)
    pin_now(cdn.manifest["asof"])
    got = D.fetch_twstock_price_adj_batch(["2330"], "2009-06-01", "2024-01-31", {"api-key": "x"})
    check("via" not in got["2330"].attrs and len(blave_calls) == 1, "a start before 2010-01-04 → the Blave batch")
    fresh()
    D._TW_CDN_WHOLE_MARKET_IDS = 1
    try:
        quiet(D.fetch_twstock_price_adj_batch, ids, "2009-06-01", "2024-01-31", {})
        check(False, "a big batch from before the CDN's first day raises at once")
    except D.BatchIncomplete as e:
        check(e.failed == ids and "2010-01-04" in str(e) and D._TW_PUBLIC_SESSION.calls == [],
              "a big batch from before the CDN's first day raises at once, naming 2010-01-04 (no exchange crawl)")
    finally:
        D._TW_CDN_WHOLE_MARKET_IDS = 40
    fresh()
    try:
        quiet(D.fetch_twstock_price_adj_batch, ["2330", "9998"], "2024-01-01", "2024-01-31", {})
        check(False, "an id no source has → BatchIncomplete")
    except D.BatchIncomplete as e:
        check(e.failed == ["9998"] and "2330" in e.partial, "an id no source has → BatchIncomplete (failed = that id)")


def t_stale_edge():
    """P1-4: a CDN edge still serving the previous file right after a publication is not taken as
    current — the cached copy's last day is read from the file, so the next call asks again."""
    cdn = fresh()
    pin_now(cdn.manifest["asof"])
    good = (CDN / "stock" / "2603.parquet").read_bytes()
    t = pq.read_table(io.BytesIO(good))
    old = t.slice(0, t.num_rows - 5)
    buf = io.BytesIO()
    pq.write_table(old.replace_schema_metadata(t.schema.metadata), buf)
    cdn.override["stock/2603.parquet"] = buf.getvalue()
    df = D.fetch_twstock_price("2603", "2022-07-01", "2022-11-30", {})
    old_last = pd.Timestamp(old.column("date").to_pandas().max())
    check(df.index[-1] == old_last, f"the stale copy is served for now (ends {old_last.date()})")
    meta = json.loads((D._tw_cdn_dir() / "stock" / "2603.parquet.meta.json").read_text())
    check(meta["last"] == str(old_last.date()), "its recorded last day is the file's own, not the manifest's")
    del cdn.override["stock/2603.parquet"]
    n = len(cdn.calls)
    df = D.fetch_twstock_price("2603", "2022-07-01", "2022-11-30", {})
    check(cdn.calls[n:] == [("stock/2603.parquet", '"stale-stock/2603.parquet"')] and df.index[-1] > old_last,
          "the next call asks again and gets the current file")
    cdn = fresh()
    cdn.override["recent.parquet"] = (CDN / "events.parquet").read_bytes()   # wrong bytes for recent
    D._TW_CDN_WHOLE_MARKET_IDS = 1
    try:
        quiet(D.fetch_twstock_price_batch, ["2330", "2603"], "2022-08-01", "2022-10-31", {})
        del cdn.override["recent.parquet"]
        n = len(cdn.calls)
        D.fetch_twstock_price_batch(["2330", "2603"], "2022-08-01", "2022-10-31", {})
    finally:
        D._TW_CDN_WHOLE_MARKET_IDS = 40
    check(("recent.parquet", None) in cdn.calls[n:],
          "recent.parquet whose sha256 differs from the manifest is asked again (unconditionally) next call")


def t_open_year_kept():
    """The open year's file is not re-downloaded just because it grew: recent.parquet carries the
    new days while the cached copy reaches recent_from."""
    m = json.loads((CDN / "manifest.json").read_text())
    m["years"]["2022"]["immutable"] = False
    m["recent_from"] = "2022-10-03"
    cdn = fresh(manifest=m)
    pin_now(m["asof"])
    D._TW_CDN_WHOLE_MARKET_IDS = 1
    try:
        D.fetch_twstock_price_batch(["2330", "2603"], "2022-08-01", "2022-10-31", {})
        m2 = json.loads(json.dumps(m))
        m2["files"]["year/2022.parquet"] = "0" * 64          # the open year was republished
        cdn.manifest = m2
        meta = D._tw_cdn_dir() / "manifest.json.meta.json"
        meta.write_text(json.dumps({**json.loads(meta.read_text()), "checked_at": time.time() - 7200}))
        n = len(cdn.calls)
        D.fetch_twstock_price_batch(["2330", "2603"], "2022-08-01", "2022-10-31", {})
    finally:
        D._TW_CDN_WHOLE_MARKET_IDS = 40
    asked = [k for k, _ in cdn.calls[n:]]
    check("year/2022.parquet" not in asked, f"the grown open year is not asked again while its copy reaches recent_from ({asked})")


def t_empty_in_window():
    """P0 + P1-7: an id with no rows in the window."""
    cdn = fresh()
    pin_now(cdn.manifest["asof"])
    D._TW_CDN_WHOLE_MARKET_IDS = 1
    try:
        got = D.fetch_twstock_price_adj_batch(["2330", "0050"], "2022-08-01", "2022-10-31", {})
    finally:
        D._TW_CDN_WHOLE_MARKET_IDS = 40
    check(got["0050"].empty and not got["2330"].empty and D._TW_PUBLIC_SESSION.calls == [],
          "whole-market path: 0050 has no rows in the 2022 window on the CDN → empty frame, zero exchange requests")
    del os.environ["BLAVE_AGENT_LOCAL"]
    real = D._fetch_twstock_cached_batch
    try:
        ok = pd.DataFrame({"Open": [1.0], "Close": [2.0]}, index=pd.DatetimeIndex(["2024-01-02"]))
        D._fetch_twstock_cached_batch = lambda *a, **k: {"2330": ok, "6999": pd.DataFrame()}
        got = D.fetch_twstock_price_adj_batch(["2330", "6999"], "2024-01-01", "2024-01-31", {"api-key": "x"})
        check(got["6999"].empty and list(got["2330"].columns) == ["Open", "Close"],
              "cloud machine: the Blave batch's column-less empty frame for an id comes back as is, no KeyError")
    except Exception as e:
        check(False, f"cloud machine adj batch with an empty id: {type(e).__name__}: {e}")
    finally:
        D._fetch_twstock_cached_batch = real
        os.environ["BLAVE_AGENT_LOCAL"] = "1"


def t_hot_cache():
    fresh()
    D._tw_official_expected_day = _real_expected
    calls = []

    def raw(s, e):
        calls.append((s, e))
        return D._tw_daily_frame([(pd.Timestamp(s), 1.0, 1.0, 1.0, 1.0, 1.0)])
    month = datetime.now(timezone.utc).replace(tzinfo=None).strftime("%Y-%m")
    start = f"{month}-01"
    D._extend_cache_monthly("twstock_daily", {"id": "x", "src": "twse"}, raw, start, None,
                            present_fresh_after=datetime.now(timezone.utc).replace(tzinfo=None) - timedelta(hours=1))
    n = len(calls)
    D._extend_cache_monthly("twstock_daily", {"id": "x", "src": "twse"}, raw, start, None,
                            present_fresh_after=datetime.now(timezone.utc).replace(tzinfo=None) - timedelta(hours=1))
    check(n == 1 and len(calls) == 1, "current month written after the last final: the second call fetches nothing")
    D._extend_cache_monthly("twstock_daily", {"id": "x", "src": "twse"}, raw, start, None,
                            present_fresh_after=datetime.now(timezone.utc).replace(tzinfo=None) + timedelta(hours=1))
    check(len(calls) == 2, "a newer final than the file → one delta fetch")
    last = D._tw_last_final_utc(datetime(2026, 10, 17, 12, 0, tzinfo=D._TPE))    # a Saturday
    check(last == datetime(2026, 10, 16, 9, 35), f"last final before Sat 12:00 Taipei = Fri 17:35 (09:35 UTC) (got {last})")


def t_stale_manifest():
    """M1: a CDN behind the latest 17:35 final. Per stock (<=40 ids) the batch fills the days from
    the exchange like the single-stock path, final days only; the whole-market path cannot, so it
    names the day (attrs['asof'] + ⚠️) and a live scope refuses it (FeedNotPublished) — unless
    the exchange shows no session after the CDN's day (a holiday)."""
    real = D._fetch_twstock_daily_public
    real_exright = D._tw_exright_for
    m = json.loads((CDN / "manifest.json").read_text())
    m["asof"] = "2024-02-29"
    m["stocks"]["0050"][2] = "2024-02-29"
    final = "2024-03-04"

    def bars(*days):
        f = D._tw_daily_frame([(pd.Timestamp(d), 1.0, 1.0, 1.0, 1.0, 5.0) for d in days])
        f.attrs["source"] = "TWSE"
        return f

    def run(fn, live=False):
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            try:
                if live:
                    with D.live_feeds():
                        return fn(), None, out.getvalue()
                return fn(), None, out.getvalue()
            except D.FeedNotPublished as e:
                return None, e, out.getvalue()

    try:
        # per stock, the exchange answers: filled through the final, today's unfinal bar left out
        fresh(manifest=m)
        pin_now("2024-02-29")
        D._tw_official_expected_day = lambda now=None: final
        D._fetch_twstock_daily_public = lambda sid, s, e, adjust=False: bars("2024-03-01", final, "2024-03-05")
        D._tw_exright_for = lambda *a, **k: pd.DataFrame(columns=["stock_id", "prev_close", "ref_price"],
                                                         index=pd.DatetimeIndex([], name="date"))   # no event
        got, err, _ = run(lambda: D.fetch_twstock_price_adj_batch(["2330"], "2024-01-01", None, {}), live=True)
        check(err is None and got["2330"].index[-1] == pd.Timestamp(final) and got["2330"].attrs.get("asof") == final,
              "per-stock batch, CDN behind: the days after its asof come from the exchange, through the 17:35 final only")
        got_one = D.fetch_twstock_price("2330", "2024-01-01", None, {})
        check(got_one.index[-1] == pd.Timestamp(final), "single stock: the exchange's unfinal bar after the final is cut too")
        # per stock, the exchange cannot answer: named outside live, refused inside
        fresh(manifest=m)

        def down(*a, **k):
            raise requests.exceptions.ConnectionError("exchange down (test)")
        D._fetch_twstock_daily_public = down
        got, err, out = run(lambda: D.fetch_twstock_price_adj_batch(["2330"], "2024-01-01", None, {}))
        check(err is None and got["2330"].attrs.get("asof") == "2024-02-29" and "served through 2024-02-29" in out,
              "per-stock batch, CDN behind and exchange down, backtest: ⚠️ line + attrs['asof'] = the CDN's day")
        got, err, _ = run(lambda: D.fetch_twstock_price_adj_batch(["2330"], "2024-01-01", None, {}), live=True)
        check(err is not None and str(err.need) == final and err.due_at.tzinfo is not None
              and D._feed_refused is None,
              "per-stock batch, CDN behind and exchange down, live: FeedNotPublished (wait_for_bar waits, no priming)")
        import importlib.util
        spec = importlib.util.spec_from_file_location("wfb_cdn", os.path.join(ROOT, "manager", "wait_for_bar.py"))
        W = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(W)
        check(W._is_feed_wait(err) and W._FeedWait(err).due_at == err.due_at,
              "wait_for_bar reads it as a feed wait (_FeedWait: _maybe_prime returns, the alert names the feed)")
        import lib.events as EV
        import lib.notify as NT
        sent, real_send, real_emit = [], NT.send_text, EV.emit
        NT.send_text, EV.emit = sent.append, (lambda *a, **k: None)
        try:
            W._alert_stale("s", datetime(2024, 3, 4), 20, W._FeedWait(err))
        finally:
            NT.send_text, EV.emit = real_send, real_emit
        check(sent and "台股日 K 本身" in sent[0] and "K 棒已到" not in sent[0] and "移除" not in sent[0],
              "the stale alert for a late CDN says the daily bars themselves are late (not 'K 棒已到')")
        # whole-market files: one probe tells a late CDN from a holiday
        m2 = json.loads((CDN / "manifest.json").read_text())
        m2["stocks"]["2330"][2] = m2["asof"]
        nxt = "2026-10-15"
        fresh(manifest=m2)
        pin_now(m2["asof"])
        D._tw_official_expected_day = lambda now=None: nxt
        D._TW_CDN_WHOLE_MARKET_IDS = 1
        D._fetch_twstock_daily_public = lambda sid, s, e, adjust=False: bars(nxt)
        got, err, out = run(lambda: D.fetch_twstock_price_batch(["2330", "2603"], "2022-08-01", None, {}))
        check(err is None and got["2330"].attrs.get("asof") == m2["asof"] and got["2330"].index[-1] == pd.Timestamp(m2["asof"])
              and f"served through {m2['asof']}" in out,
              "whole-market batch, CDN behind: ⚠️ line + attrs['asof'] = the CDN's day")
        got, err, _ = run(lambda: D.fetch_twstock_price_batch(["2330", "2603"], "2022-08-01", None, {}), live=True)
        check(err is not None and err.due_at.hour == 18, "whole-market batch, CDN behind, live: FeedNotPublished due at the CDN's 18:05")
        D._fetch_twstock_daily_public = lambda sid, s, e, adjust=False: bars()
        got, err, out = run(lambda: D.fetch_twstock_price_batch(["2330", "2603"], "2022-08-01", None, {}), live=True)
        check(err is None and got["2330"].attrs.get("asof") == nxt and "⚠️" not in out,
              "whole-market batch, no session after the CDN's day (holiday): served, no ⚠️, live not refused")
    finally:
        D._fetch_twstock_daily_public = real
        D._tw_exright_for = real_exright
        D._TW_CDN_WHOLE_MARKET_IDS = 40


def t_stale_more():
    """Re-audit R1–R4: the single-stock chain refuses a late CDN in a live scope like the batch
    (outside its fallback try); ids served by the key-free fallback stop at the 17:35 final too;
    a whole-market recent.parquet older than the manifest is not taken as complete; a holiday
    (empty exchange tail) and a suspended id are never refused."""
    real, real_exright = D._fetch_twstock_daily_public, D._tw_exright_for
    m = json.loads((CDN / "manifest.json").read_text())
    m["asof"] = "2024-02-29"
    m["stocks"]["0050"][2] = "2024-02-29"
    final = "2024-03-04"

    def bars(*days):
        f = D._tw_daily_frame([(pd.Timestamp(d), 1.0, 1.0, 1.0, 1.0, 5.0) for d in days])
        f.attrs["source"] = "TWSE"
        return f

    def down(*a, **k):
        raise requests.exceptions.ConnectionError("exchange down (test)")

    def run(fn, live=True):
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            try:
                if live:
                    with D.live_feeds():
                        return fn(), None, out.getvalue()
                return fn(), None, out.getvalue()
            except D.FeedNotPublished as e:
                return None, e, out.getvalue()

    def setup(manifest, asof, official):
        fresh(manifest=manifest)
        pin_now(asof)
        D._tw_official_expected_day = lambda now=None: official

    try:
        # R1
        setup(m, "2024-02-29", final)
        D._fetch_twstock_daily_public = down
        got, err, _ = run(lambda: D.fetch_twstock_price("2330", "2024-01-01", None, {}))
        check(err is not None and str(err.need) == final and len(blave_calls) == 1,
              "R1 single stock, CDN behind and exchange down, live: Blave asked (403 here), then FeedNotPublished — "
              "not the free chain")
        got, err, _ = run(lambda: D.fetch_twstock_price("2330", "2024-01-01", None, {}), live=False)
        check(err is None and got.attrs.get("asof") == "2024-02-29" and got.attrs.get("via") == "Blave CDN",
              "R1 single stock, same, backtest: served through the CDN's day, attrs['asof'] names it")
        # R2
        setup(m, "2024-02-29", final)
        D._fetch_twstock_daily_public = lambda sid, s, e, adjust=False: bars("2024-03-01", final, "2024-03-05")
        got, err, _ = run(lambda: D.fetch_twstock_price_batch(["2330", "9999"], "2024-01-01", None, {}))
        one, err1, _ = run(lambda: D.fetch_twstock_price("9999", "2024-01-01", None, {}))
        check(err is None and err1 is None and got["9999"].index[-1] == pd.Timestamp(final)
              and one.index[-1] == pd.Timestamp(final) and one.attrs.get("source") == "TWSE",
              "R2 an id the CDN lacks (key-free fallback), live: batch and single stop at the 17:35 final, source kept")
        # R4a: a holiday — the exchange tail comes back empty
        setup(m, "2024-02-29", final)
        D._fetch_twstock_daily_public = lambda sid, s, e, adjust=False: D._tw_daily_frame([])
        got, err, out = run(lambda: D.fetch_twstock_price_batch(["2330"], "2024-01-01", None, {}))
        one, err1, _ = run(lambda: D.fetch_twstock_price("2330", "2024-01-01", None, {}))
        check(err is None and err1 is None and got["2330"].attrs.get("asof") == final and "⚠️" not in out,
              "R4 holiday: an empty exchange tail counts as complete — live not refused, no ⚠️ (batch and single)")
        # R4b: a suspended id (not trading on the CDN's day), exchange down
        setup(m, "2024-02-29", final)
        D._fetch_twstock_daily_public = down
        got, err, _ = run(lambda: D.fetch_twstock_price_batch(["2603"], "2022-08-01", None, {}))
        one, err1, _ = run(lambda: D.fetch_twstock_price("2603", "2022-08-01", None, {}))
        check(err is None and err1 is None and not got["2603"].empty,
              "R4 a suspended id (its last day before the CDN's) is never counted as behind, even with the exchange down")
        # R3: whole-market files with an edge copy of recent.parquet from before the publication
        m2 = json.loads((CDN / "manifest.json").read_text())
        m2["stocks"]["2330"][2] = m2["asof"]
        cdn = fresh(manifest=m2)
        pin_now(m2["asof"])
        good = pq.read_table(CDN / "recent.parquet")
        dates = good.column("date").to_pandas()
        old = good.filter(pd.Series(pd.to_datetime(dates) < pd.Timestamp(m2["asof"])).to_numpy())
        buf = io.BytesIO()
        pq.write_table(old.replace_schema_metadata(good.schema.metadata), buf)
        cdn.override["recent.parquet"] = buf.getvalue()
        D._TW_CDN_WHOLE_MARKET_IDS = 1
        D._fetch_twstock_daily_public = down
        got, err, _ = run(lambda: D.fetch_twstock_price_batch(["2330", "2603"], "2022-08-01", None, {}))
        check(err is not None and str(err.need) == m2["asof"],
              "R3 whole-market, recent.parquet older than the manifest: not complete — live refuses")
    finally:
        D._fetch_twstock_daily_public, D._tw_exright_for = real, real_exright
        D._TW_CDN_WHOLE_MARKET_IDS = 40


def t_cloud_lag():
    """A cloud machine (no BLAVE_AGENT_LOCAL) whose CDN is a day short of the latest final: never
    the exchange; the holiday table decides — a closed day is no gap, an open one goes to Blave
    (single stock and batch), and without Blave access a live tick still refuses."""
    m = json.loads((CDN / "manifest.json").read_text())
    m["asof"] = "2024-02-29"
    final = "2024-03-01"
    closed, kind = [], ["holiday"]

    def blave(url, **kw):
        if url.endswith("/twmarket/holidays"):
            return FakeResponse({"published": True, "year": 2024,
                                 "data": [{"date": d, "name": "test", "type": kind[0]} for d in closed]})
        return blave_ok(url, **kw)

    def setup(blave_fn):
        cdn = fresh(manifest=m, blave=blave_fn)
        pin_now(m["asof"])
        D._tw_official_expected_day = lambda now=None: final
        D._HOLIDAY_MEMO.clear()
        return cdn

    del os.environ["BLAVE_AGENT_LOCAL"]
    try:
        closed[:] = [final]
        setup(blave)
        df = D.fetch_twstock_price("2330", "2024-01-01", None, {"api-key": "x"})
        bat = D.fetch_twstock_price_adj_batch(["2330"], "2024-01-01", None, {"api-key": "x"})["2330"]
        check(df.attrs.get("via") == "Blave CDN" and df.attrs.get("asof") == final
              and bat.attrs.get("via") == "Blave CDN" and D._TW_PUBLIC_SESSION.calls == []
              and all(u.endswith("/holidays") for u in blave_calls),
              "cloud, CDN a day short, the day closed in the holiday table: the CDN frame, complete through it")
        for k, closes in (("adhoc_closed", True), ("makeup_trading", False)):
            kind[0] = k
            del blave_calls[:]
            setup(blave)
            bat = D.fetch_twstock_price_adj_batch(["2330"], "2024-01-01", None, {"api-key": "x"})["2330"]
            only_table = all(u.endswith("/holidays") for u in blave_calls)
            check((bat.attrs.get("via") == "Blave CDN" and bat.attrs.get("asof") == final and only_table) if closes
                  else not only_table,
                  f"cloud, CDN a day short, the day a {k!r} row: "
                  + ("a closure — the CDN frame, no Blave price call" if closes else "not a closed type — goes to Blave"))
        kind[0] = "holiday"
        closed[:] = ["2024-02-28"]
        setup(blave)
        df = D.fetch_twstock_price("2330", "2024-01-01", None, {"api-key": "x"})
        bat = D.fetch_twstock_price_adj_batch(["2330", "2603"], "2024-01-01", None, {"api-key": "x"})
        check(df.attrs.get("source") == "Blave" and "via" not in bat["2330"].attrs
              and bat["2603"].attrs.get("via") == "Blave CDN" and D._TW_PUBLIC_SESSION.calls == [],
              "cloud, CDN a day short of an open session: Blave for the lagging id (2603 delisted: CDN), never the exchange")
        setup(lambda url, **kw: blave(url, **kw) if url.endswith("/holidays") else blave_no_access(url, **kw))
        try:
            with contextlib.redirect_stdout(io.StringIO()), D.live_feeds():
                D.fetch_twstock_price("2330", "2024-01-01", None, {})
            check(False, "cloud, CDN short, no Blave access, live: FeedNotPublished")
        except D.FeedNotPublished:
            check(D._TW_PUBLIC_SESSION.calls == [], "cloud, CDN short, no Blave access, live: FeedNotPublished")
    finally:
        os.environ["BLAVE_AGENT_LOCAL"] = "1"


def main():
    t_parity()
    t_smooth()
    t_chain()
    t_cache()
    t_tail()
    t_batch()
    t_stale_edge()
    t_open_year_kept()
    t_empty_in_window()
    t_hot_cache()
    t_stale_manifest()
    t_stale_more()
    t_cloud_lag()
    D._tw_official_expected_day = _real_expected
    D._tw_cdn_expected_asof = _real_cdn_expected
    print(f"\n{'ALL PASS' if not fails else f'{fails} FAIL'}")
    sys.exit(1 if fails else 0)


if __name__ == "__main__":
    main()
