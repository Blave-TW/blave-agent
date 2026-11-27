"""Minimal check: lib.data.fetch_twstock_wide — date × stock tables straight from the Blave CDN's
whole-market files, the same numbers as the batch fetchers without one DataFrame per stock.

  - fixture CDN (tests/fixtures/tw_cdn, 2330 + 2603 2022, a 減資 on 2603 2022-09-19): adjusted
    Open/Close equal fetch_twstock_price_adj_batch, raw OHLC equal fetch_twstock_price_batch, cell
    for cell, on the whole-market path and on the small-pool path; the whole-market path builds no
    per-stock frame
  - a synthetic CDN (three ids 2023): an untraded day keeps Volume / Amount 0 (the batch carries
    the previous day's volume there), a halted day and the days after a delisting are NaN, a stock
    listed mid-window starts NaN, an invalid raw bar is dropped as the batch drops it; Amount is the
    file's 成交金額
  - CDN late (tests/check_tw_cdn_blave_tail.py's 6242 world): the tail from Blave on the CDN base,
    the same cells as the batch; Blave short too → served through what joins, live refused
  - CDN down → the batch's chain (same cells); an id the CDN does not list → the batch for it
  - BLAVE_TW_DAILY_NOTE counts the frames as the batch does

Run: cd blave-agent && MPLBACKEND=Agg .venv/bin/python tests/check_tw_cdn_wide.py
"""
import contextlib
import hashlib
import io
import json
import os
import sys
import tempfile
from pathlib import Path

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
sys.path.insert(0, os.path.join(ROOT, "tests"))
os.environ.setdefault("MPLBACKEND", "Agg")

import numpy as np
import pandas as pd
import pyarrow as pa
import pyarrow.parquet as pq

import check_tw_cdn_daily as H
import check_tw_cdn_blave_tail as T
import lib.data as D

fails = 0


def check(cond, msg):
    global fails
    print(("  PASS  " if cond else "  FAIL  ") + msg)
    fails += (not cond)


def quiet(fn, *a, **k):
    with contextlib.redirect_stdout(io.StringIO()):
        return fn(*a, **k)


def as_wide(frames, ids, field):
    """The table a strategy's fetch_data builds from the batch's {id: frame}."""
    cols = {s: frames[s][field] for s in ids if s in frames and not frames[s].empty}
    return pd.DataFrame(cols).sort_index()


def same(a, b):
    if list(a.columns) != list(b.columns) or not a.index.equals(b.index):
        return False
    x, y = a.to_numpy(float), b.to_numpy(float)
    return bool(((x == y) | (np.isnan(x) & np.isnan(y))).all())


def t_fixture_parity():
    ids = ["2330", "2603"]
    for whole in (True, False):
        cdn = H.fresh()
        H.pin_now(cdn.manifest["asof"])
        D._TW_CDN_WHOLE_MARKET_IDS = 1 if whole else 40
        try:
            adj = quiet(D.fetch_twstock_price_adj_batch, ids, "2022-08-01", "2022-10-31", {})
            raw = quiet(D.fetch_twstock_price_batch, ids, "2022-08-01", "2022-10-31", {})
            H.fresh()
            w = quiet(D.fetch_twstock_wide, ids, "2022-08-01", "2022-10-31", {})
            wr = quiet(D.fetch_twstock_wide, ids, "2022-08-01", "2022-10-31", {},
                       fields=("Open", "High", "Low", "Close"), adjust=False)
        finally:
            D._TW_CDN_WHOLE_MARKET_IDS = 40
        tag = "whole-market files" if whole else "small pool"
        check(set(w) == {"Open", "Close"} and all(same(w[f], as_wide(adj, ids, f)) for f in ("Open", "Close")),
              f"{tag}: adjusted Open / Close == fetch_twstock_price_adj_batch, cell for cell (2603 減資 inside)")
        check(all(same(wr[f], as_wide(raw, ids, f)) for f in ("Open", "High", "Low", "Close")),
              f"{tag}: raw OHLC == fetch_twstock_price_batch, cell for cell")
        check(w["Close"].attrs.get("asof") == cdn.manifest["asof"], f"{tag}: attrs['asof'] is the CDN's day")
    H.fresh()
    D._TW_CDN_WHOLE_MARKET_IDS = 1
    real = D._tw_cdn_bars
    D._tw_cdn_bars = lambda *a, **k: (_ for _ in ()).throw(AssertionError("per-stock frame built"))
    try:
        w = quiet(D.fetch_twstock_wide, ids, "2022-08-01", "2022-10-31", {})
        check(not w["Close"].empty, "whole-market path: no per-stock frame is built (_tw_cdn_bars never called)")
    except AssertionError:
        check(False, "whole-market path: no per-stock frame is built (_tw_cdn_bars never called)")
    finally:
        D._tw_cdn_bars = real
        D._TW_CDN_WHOLE_MARKET_IDS = 40


# ── a synthetic CDN: three ids through 2023 ───────────────────────────────────
DAYS = pd.bdate_range("2023-01-02", "2023-03-31")
ASOF = str(DAYS[-1].date())


def synth_rows():
    rows = []
    for k, d in enumerate(DAYS):
        p = 100 + k
        # A: trades every day except an untraded day (row, null prices, 0 volume) and a halt (no row)
        if d == DAYS[10]:
            rows.append(("1111", d, None, None, None, None, 0, 0))
        elif d != DAYS[20]:
            rows.append(("1111", d, p, p + 1, p - 1, p + 0.5, 1000 + k, (1000 + k) * p))
        # B: delisted after DAYS[30]; one invalid raw bar (high < low) on DAYS[5]
        if d <= DAYS[30]:
            hi, lo = (p - 2, p + 2) if d == DAYS[5] else (p + 2, p - 2)
            rows.append(("2222", d, p, hi, lo, p, 500, 500 * p))
        # C: listed on DAYS[15]
        if d >= DAYS[15]:
            rows.append(("3333", d, 50, 51, 49, 50.5, 0 if d == DAYS[40] else 300, 0 if d == DAYS[40] else 15000))
    df = pd.DataFrame(rows, columns=["stock_id", "date", "open", "high", "low", "close", "volume", "amount"])
    df["date"] = df["date"].dt.date
    df["trades"] = 1
    df["market"] = "twse"
    return df


def synth_store():
    df = synth_rows()
    events = [[str(DAYS[25].date()), 125.0, 120.0, "twse_exright"]]   # on 1111
    out, files = {}, {}

    def put(key, frame, meta=None):
        buf = io.BytesIO()
        t = pa.Table.from_pandas(frame, preserve_index=False)
        pq.write_table(t.replace_schema_metadata(meta or {}), buf)
        out[key] = buf.getvalue()

    for sid, g in df.groupby("stock_id"):
        ev = events if sid == "1111" else []
        put(f"stock/{sid}.parquet", g.drop(columns="stock_id"), {b"blave.events": json.dumps(ev).encode()})
    put("year/2023.parquet", df)
    put("recent.parquet", df[pd.to_datetime(df["date"]) >= DAYS[45]])
    ev = pd.DataFrame([(pd.Timestamp(d).date(), "1111", p, r, k) for d, p, r, k in events],
                      columns=["date", "stock_id", "prev_close", "ref_price", "kind"])
    put("events.parquet", ev)
    for key, body in out.items():
        if not key.startswith("stock/"):
            files[key] = hashlib.sha256(body).hexdigest()
    first = df.groupby("stock_id")["date"].min()
    last = df.groupby("stock_id")["date"].max()
    out["manifest.json"] = json.dumps({
        "schema": D._TW_CDN_SCHEMA, "asof": ASOF, "enabled": True, "first_day": "2010-01-04",
        "recent_from": str(DAYS[45].date()),
        "stocks": {s: ["twse", str(first[s]), str(last[s])] for s in first.index},
        "years": {"2023": {"immutable": False, "last": ASOF}}, "files": files}).encode()
    return out


def synth(fn):
    store = synth_store()
    D._CACHE_DIR = Path(tempfile.mkdtemp())
    D._tw_cdn_get = lambda key, etag=None: (store[key], f'"{hashlib.md5(store[key]).hexdigest()}"') \
        if key in store else (_ for _ in ()).throw(D.TwCdnUnavailable(f"{key}: 403 (test)"))
    D._retry_get = H.blave_no_access
    H.pin_now(ASOF)
    D._TW_CDN_WHOLE_MARKET_IDS = 1
    try:
        return quiet(fn)
    finally:
        D._TW_CDN_WHOLE_MARKET_IDS = 40


def t_synthetic():
    ids = ["1111", "2222", "3333"]
    start = "2023-01-02"
    adj = synth(lambda: D.fetch_twstock_price_adj_batch(ids, start, None, {}))
    raw = synth(lambda: D.fetch_twstock_price_batch(ids, start, None, {}))
    w = synth(lambda: D.fetch_twstock_wide(ids, start, None, {}, fields=("Open", "Close", "Volume", "Amount")))
    wr = synth(lambda: D.fetch_twstock_wide(ids, start, None, {}, fields=("Open", "High", "Low", "Close", "Volume"),
                                            adjust=False))
    check(same(w["Close"], as_wide(adj, ids, "Close")) and same(w["Open"], as_wide(adj, ids, "Open")),
          "synthetic: adjusted Open / Close == the batch (ex-right on 1111, untraded day, halt, delisting, late listing)")
    check(all(same(wr[f], as_wide(raw, ids, f)) for f in ("Open", "High", "Low", "Close")),
          "synthetic: raw OHLC == the batch, the invalid 2222 bar dropped the same way")
    v, a = w["Volume"], w["Amount"]
    check(v.loc[DAYS[10], "1111"] == 0 and a.loc[DAYS[10], "1111"] == 0
          and as_wide(raw, ids, "Volume").loc[DAYS[10], "1111"] == 1009,
          "untraded day: Volume / Amount 0 (the batch shows the previous day's 1009 shares)")
    check(np.isnan(v.loc[DAYS[20], "1111"]) and np.isnan(w["Close"].loc[DAYS[20], "1111"]),
          "halted all day (no row): NaN, price and volume")
    check(v.loc[DAYS[31]:, "2222"].isna().all() and v.loc[:DAYS[14], "3333"].isna().all()
          and v.loc[DAYS[40], "3333"] == 0 and a.loc[DAYS[16], "3333"] == 15000,
          "after a delisting and before a listing: NaN; a 0-volume day of a listed stock stays 0; Amount is 成交金額")
    check(np.isnan(wr["Volume"].loc[DAYS[5], "2222"]),
          "raw: the dropped invalid bar has no Volume either (the batch drops the whole bar)")
    check(list(w["Close"].columns) == ids, "columns in the order asked")
    mid = str(DAYS[10].date())   # a window that starts on 1111's untraded day: the batch carries the day before in
    adj_m = synth(lambda: D.fetch_twstock_price_adj_batch(ids, mid, None, {}))
    raw_m = synth(lambda: D.fetch_twstock_price_batch(ids, mid, None, {}))
    w_m = synth(lambda: D.fetch_twstock_wide(ids, mid, None, {}))
    wr_m = synth(lambda: D.fetch_twstock_wide(ids, mid, None, {}, fields=("Open", "High", "Low", "Close"), adjust=False))
    check(same(w_m["Close"], as_wide(adj_m, ids, "Close")) and same(w_m["Open"], as_wide(adj_m, ids, "Open"))
          and w_m["Close"].loc[DAYS[10], "1111"] == as_wide(adj_m, ids, "Close").loc[DAYS[10], "1111"],
          "start mid-year on an untraded day: the first day carries the last price before the window, as the batch")
    check(all(same(wr_m[f], as_wide(raw_m, ids, f)) for f in ("Open", "High", "Low", "Close")),
          "start mid-year, raw: same as the batch")


# ── CDN late: the 6242 world of check_tw_cdn_blave_tail ──────────────────────
def t_late():
    D.datetime = T.Clock
    sid = T.SID
    wide_adj = lambda: D.fetch_twstock_wide([sid], T.START, None, {"api-key": "x"})  # noqa: E731
    wide_raw = lambda: D.fetch_twstock_wide([sid], T.START, None, {"api-key": "x"},  # noqa: E731
                                            fields=("Open", "High", "Low", "Close"), adjust=False)
    for sc, label in ((T.PLAIN, "plain"), (T.EXDIV, "ex-div on 10-16")):
        for when in ("2026-10-16 17:36", "2026-10-16 21:00"):
            ref = T.run(when, T.PREV, sc, T.CALLS["batch adj"], whole=True)
            got = T.run(when, T.PREV, sc, wide_adj, whole=True)
            ref_r = T.run(when, T.PREV, sc, T.CALLS["batch raw"], whole=True)
            got_r = T.run(when, T.PREV, sc, wide_raw, whole=True)
            check(same(got["Close"], ref[["Close"]].rename(columns={"Close": sid}))
                  and same(got["Open"], ref[["Open"]].rename(columns={"Open": sid}))
                  and got["Close"].index[-1] == pd.Timestamp(T.LAST) and got["Close"].attrs.get("asof") == T.LAST,
                  f"{label} at {when[11:]}: CDN late — 10-16 from Blave on the CDN base, == the batch cell for cell")
            check(all(same(got_r[f], ref_r[[f]].rename(columns={f: sid})) for f in ("Open", "High", "Low", "Close")),
                  f"{label} at {when[11:]}: raw, same as the batch")
        pub = T.run("2026-10-16 18:06", T.LAST, sc, wide_adj, whole=True)
        ref = T.run("2026-10-16 18:06", T.LAST, sc, T.CALLS["batch adj"], whole=True)
        check(same(pub["Close"], ref[["Close"]].rename(columns={"Close": sid})) and T.price_calls == [],
              f"{label}: published CDN — no Blave price call, == the batch")
    short = T.Sc(blave_last={sid: T.PREV})
    got = T.run("2026-10-16 17:36", "2026-10-13", short, wide_adj, whole=True)
    ref = T.run("2026-10-16 17:36", "2026-10-13", short, T.CALLS["batch adj"], whole=True)
    err = T.refused(lambda: T.run("2026-10-16 17:36", "2026-10-13", short, wide_adj, whole=True, live=True))
    check(same(got["Close"], ref[["Close"]].rename(columns={"Close": sid})) and got["Close"].attrs.get("asof") == T.PREV
          and err is not None and str(err.need) == T.LAST,
          "Blave short too: served through 10-15 as the batch, live refused")
    try:
        live = T.run("2026-10-16 17:36", T.PREV, T.PLAIN, wide_adj, whole=True, live=True)
        check(live["Close"].index[-1] == pd.Timestamp(T.LAST), "live at 17:36 with Blave's 10-16: served")
    except D.FeedNotPublished as e:
        check(False, f"live at 17:36 with Blave's 10-16: refused ({e})")


def t_fallback():
    ids = ["2330", "2603"]
    cdn = H.fresh(down=True, blave=H.blave_ok)
    ref = quiet(D.fetch_twstock_price_adj_batch, ids, "2024-01-01", "2024-01-31", {"api-key": "x"})
    H.fresh(down=True, blave=H.blave_ok)
    w = quiet(D.fetch_twstock_wide, ids, "2024-01-01", "2024-01-31", {"api-key": "x"})
    check(same(w["Close"], as_wide(ref, ids, "Close")), "CDN down → the batch's chain, same cells")
    cdn = H.fresh(blave=H.blave_ok)
    H.pin_now(cdn.manifest["asof"])
    D._TW_CDN_WHOLE_MARKET_IDS = 1
    try:
        ref = quiet(D.fetch_twstock_price_adj_batch, ["2330", "2603", "9998"], "2022-08-01", "2022-10-31", {"api-key": "x"})
        H.fresh(blave=H.blave_ok)
        w = quiet(D.fetch_twstock_wide, ["2330", "2603", "9998"], "2022-08-01", "2022-10-31", {"api-key": "x"})
    finally:
        D._TW_CDN_WHOLE_MARKET_IDS = 40
    batch_calls = [u for u in H.blave_calls if "/batch/" in u]
    check(same(w["Close"], as_wide(ref, ["2330", "2603", "9998"], "Close")) and len(batch_calls) == 1,
          "an id the CDN does not list: one Blave /batch for it, merged in, == the batch")


def t_note():
    path = Path(tempfile.mkdtemp()) / "note.jsonl"
    os.environ["BLAVE_TW_DAILY_NOTE"] = str(path)
    try:
        cdn = H.fresh()
        H.pin_now(cdn.manifest["asof"])
        D._TW_CDN_WHOLE_MARKET_IDS = 1
        quiet(D.fetch_twstock_price_adj_batch, ["2330", "2603"], "2022-08-01", "2022-10-31", {})
        ref = path.read_text()
        path.unlink()
        H.fresh()
        quiet(D.fetch_twstock_wide, ["2330", "2603"], "2022-08-01", "2022-10-31", {})
        check(path.read_text() == ref, f"BLAVE_TW_DAILY_NOTE: the same line as the batch ({ref.strip()})")
    finally:
        D._TW_CDN_WHOLE_MARKET_IDS = 40
        os.environ.pop("BLAVE_TW_DAILY_NOTE", None)


def t_args():
    for bad in (dict(fields=("Close", "Turnover")), dict(fields=())):
        try:
            D.fetch_twstock_wide(["2330"], "2024-01-01", None, {}, **bad)
            check(False, f"{bad} → ValueError")
        except ValueError:
            check(True, f"{bad} → ValueError")


def main():
    os.environ["BLAVE_AGENT_LOCAL"] = "1"
    real_dt = D.datetime
    try:
        if "fetch_twstock_wide" not in vars(D):
            check(False, "lib.data.fetch_twstock_wide exists")
        else:
            t_args()
            t_fixture_parity()
            t_synthetic()
            t_fallback()
            t_note()
            os.environ.pop("BLAVE_AGENT_LOCAL", None)
            D._tw_official_expected_day = H._real_expected   # the 6242 world runs on its own clock
            D._tw_cdn_expected_asof = H._real_cdn_expected
            t_late()
    finally:
        D.datetime = real_dt
        D._tw_official_expected_day = H._real_expected
        D._tw_cdn_expected_asof = H._real_cdn_expected
    print(f"\n{'ALL PASS' if not fails else f'{fails} FAIL'}")
    sys.exit(1 if fails else 0)


if __name__ == "__main__":
    main()
