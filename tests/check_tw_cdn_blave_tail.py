"""Minimal check: a Taiwan daily request made while the Blave CDN has not published the latest
17:35 final (17:35 to ~18:05, or later when a publication round fails) returns the same frame,
cell for cell, as the CDN alone gives once it has published: the history is the CDN's, and only
the missing day comes from Blave, put on the CDN's adjustment base. Before 0.1.64 the whole
window came from the Blave endpoint, whose adjusted series is on another base (factors from
before 2010, each rounded to 2 decimals), so a low-priced stock's returns changed with the hour.

Stock 6242 (a low-priced stock, the real CDN file in tests/fixtures/tw_cdn/ through 2026-10-16).
The CDN is that file cut at 10-15 (late) or whole (published); Blave serves the same raw bars and
an adjusted series ×1.7319 rounded to 2 decimals, the way the endpoint's level differs.

  - clocks 10-16 17:36 / 17:59 / 18:04 / 21:00 (CDN late): single, per-stock batch, whole-market
    batch, adjusted and raw, cloud and desktop with the exchange down — equal to the frame the
    published CDN gives at 18:06 and on 10-19 08:40; Blave asked only from 10-15's month
  - an ex-dividend on 10-16 itself (Blave has it, the late CDN not yet): no jump, within a cent
  - live scope at 17:36: served, not refused
  - CDN three days late with a 減資 inside the tail: joined on, no jump
  - Blave behind too (to 10-15 only), or without the CDN's last day: served through what joins,
    no NaN row, live refused; an id with no Blave bar while another of the batch has the final is
    complete (it did not trade), alone it is refused
  - BLAVE_TW_DAILY_NOTE counts the frames by source: cdn+blave_tail late, cdn published,
    blave_not_cdn when the CDN is down

Run: cd blave-agent && MPLBACKEND=Agg .venv/bin/python tests/check_tw_cdn_blave_tail.py
"""
import contextlib
import hashlib
import io
import json
import os
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
sys.path.insert(0, os.path.join(ROOT, "tests"))
os.environ.setdefault("MPLBACKEND", "Agg")

import pandas as pd
import pyarrow as pa
import pyarrow.parquet as pq
import requests

import check_tw_cdn_daily as H
import lib.data as D

SID, PREV, LAST = "6242", "2026-10-15", "2026-10-16"
START = "2015-01-02"
K = 1.7319
FULL = pq.read_table(H.CDN / "stock" / f"{SID}.parquet")
EVENTS = json.loads(FULL.schema.metadata[b"blave.events"])
fails = 0


def check(cond, msg):
    global fails
    print(("  PASS  " if cond else "  FAIL  ") + msg)
    fails += (not cond)


class Sc:
    """A test world: the stock(s) (clones of 6242's file), extra (前收盤, 參考價) events, a raw
    price step (減資: the raw price doubles from that day), and what Blave lacks per id."""

    def __init__(self, extra=(), scale=None, ids=(SID,), blave_last=None, blave_drop=()):
        self.extra, self.scale, self.ids = list(extra), scale, ids
        self.blave_last, self.blave_drop = blave_last or {}, set(blave_drop)

    def raw(self):
        t = FULL.to_pandas()
        t = t.assign(date=pd.to_datetime(t["date"])).set_index("date").sort_index()
        if self.scale:
            d, m = self.scale
            cols = ["open", "high", "low", "close"]
            t.loc[t.index >= pd.Timestamp(d), cols] = (t.loc[t.index >= pd.Timestamp(d), cols] * m).round(2)
        return t

    def table(self):
        t = self.raw().reset_index()
        t["date"] = t["date"].dt.date
        return pa.Table.from_pandas(t, schema=FULL.schema.remove_metadata(), preserve_index=False)


def day_event():
    prev = float(Sc().raw().loc[PREV, "close"])
    return [LAST, prev, round(prev - 1.0, 2), "tpex_exright"]


PLAIN = Sc()
EXDIV = Sc(extra=[day_event()])


def cdn_store(asof, sc):
    """{key: bytes} for a CDN whose last day is `asof`."""
    events = EVENTS + [e for e in sc.extra if e[0] <= asof]
    full = sc.table()
    dates = full.column("date").to_pandas()
    stock = full.filter(pd.Series(pd.to_datetime(dates) <= pd.Timestamp(asof)).to_numpy())
    meta = {**FULL.schema.metadata, b"blave.events": json.dumps(events).encode()}
    files, out = {}, {}

    def put(key, table):
        buf = io.BytesIO()
        pq.write_table(table.replace_schema_metadata(meta), buf)
        out[key] = buf.getvalue()

    rows = []
    for sid in sc.ids:
        put(f"stock/{sid}.parquet", stock)
        r = stock.to_pandas()
        r.insert(0, "stock_id", sid)
        rows.append(r)
    rows = pd.concat(rows, ignore_index=True)
    years = {}
    for y, g in rows.groupby(pd.to_datetime(rows["date"]).dt.year):
        put(f"year/{y}.parquet", pa.Table.from_pandas(g, preserve_index=False))
        years[str(y)] = {"immutable": str(y) < asof[:4], "last": str(max(g["date"]))}
    put("recent.parquet", pa.Table.from_pandas(rows[pd.to_datetime(rows["date"]) >= "2026-08-31"],
                                               preserve_index=False))
    ev = pd.DataFrame([(pd.Timestamp(d).date(), sid, p, r, k) for sid in sc.ids for d, p, r, k in events],
                      columns=["date", "stock_id", "prev_close", "ref_price", "kind"])
    put("events.parquet", pa.Table.from_pandas(ev, preserve_index=False))
    for key, body in out.items():
        if not key.startswith("stock/"):
            files[key] = hashlib.sha256(body).hexdigest()
    out["manifest.json"] = json.dumps({
        "schema": D._TW_CDN_SCHEMA, "asof": asof, "enabled": True, "first_day": "2010-01-04",
        "recent_from": "2026-08-31", "stocks": {sid: ["tpex", "2010-01-04", asof] for sid in sc.ids},
        "years": years, "files": files}).encode()
    return out


def blave_series(sc):
    """Blave's raw and adjusted bars: the same raw numbers, adjusted on another base."""
    raw = sc.raw()
    f = pd.Series(1.0, index=raw.index)
    for d, p, r, _ in sorted(EVENTS + sc.extra):
        if p > 0 and r > 0 and pd.Timestamp(d) > raw.index[0]:
            f[raw.index >= pd.Timestamp(d)] *= p / r
    adj = raw[["open", "close"]].mul(f * K, axis=0).round(2)
    return raw, adj


price_calls = []


def blave_stub(sc):
    raw, adj = blave_series(sc)

    def records(sid, frame, cols, s, e):
        last = sc.blave_last.get(sid, "2100-01-01")
        sl = frame[(frame.index >= pd.Timestamp(s)) & (frame.index <= pd.Timestamp(min(e or "2100-01-01", last)))]
        sl = sl[~sl.index.isin(pd.to_datetime(sorted(sc.blave_drop)))]
        return [{"date": str(d.date()), **{c: float(v[c]) for c in cols}} for d, v in sl.iterrows()]

    def get(url, **kw):
        p = kw.get("params") or {}
        if url.endswith("/twmarket/holidays"):
            return H.FakeResponse({"published": True, "year": int(p.get("year", 2026)), "data": []})
        price_calls.append((url, p.get("start")))
        frame, cols = (adj, ["open", "close"]) if "price_adj" in url else \
            (raw, ["open", "high", "low", "close", "volume"])
        if "/batch/" in url:
            return H.FakeResponse({"data": {i: records(i, frame, cols, p["start"], p.get("end"))
                                            for i in p["stock_ids"].split(",") if i in sc.ids}, "failed": []})
        sid = url.rsplit("/", 1)[1]
        return H.FakeResponse({"data": records(sid, frame, cols, p["start"], p.get("end"))})
    return get


class Clock(datetime):
    at = None

    @classmethod
    def now(cls, tz=None):
        return cls.at.astimezone(tz) if tz else cls.at.replace(tzinfo=None)

    @classmethod
    def utcnow(cls):
        return cls.at.astimezone(timezone.utc).replace(tzinfo=None)


def run(when, asof, sc, fn, whole=False, live=False):
    """`fn()` at Taipei `when` against a CDN whose last day is `asof`, from a cold cache."""
    Clock.at = pd.Timestamp(when, tz="Asia/Taipei").to_pydatetime()
    D._CACHE_DIR = Path(tempfile.mkdtemp())
    store = cdn_store(asof, sc)
    D._tw_cdn_get = lambda key, etag=None: (store[key], f'"{hashlib.md5(store[key]).hexdigest()}"') \
        if key in store else (_ for _ in ()).throw(D.TwCdnUnavailable(f"{key}: 403 (test)"))
    D._retry_get = blave_stub(sc)
    D._TW_PUBLIC_SESSION = H.FakeExchange()
    D._HOLIDAY_MEMO.clear()
    D._TW_CDN_WHOLE_MARKET_IDS = 0 if whole else 40
    price_calls.clear()
    try:
        with contextlib.redirect_stdout(io.StringIO()):
            if live:
                with D.live_feeds():
                    return fn()
            return fn()
    finally:
        D._TW_CDN_WHOLE_MARKET_IDS = 40


CALLS = {
    "single adj": lambda: D.fetch_twstock_price_adj(SID, START, None, {"api-key": "x"}),
    "batch adj": lambda: D.fetch_twstock_price_adj_batch([SID], START, None, {"api-key": "x"})[SID],
    "single raw": lambda: D.fetch_twstock_price(SID, START, None, {"api-key": "x"}),
    "batch raw": lambda: D.fetch_twstock_price_batch([SID], START, None, {"api-key": "x"})[SID],
}
LATE = ["2026-10-16 17:36", "2026-10-16 17:59", "2026-10-16 18:04", "2026-10-16 21:00"]


def t_fixture_discriminates():
    D.datetime = Clock
    ref = run("2026-10-16 18:06", LAST, PLAIN, CALLS["single adj"])["Close"]
    _, adj = blave_series(PLAIN)
    b = adj["close"].reindex(ref.index)
    gap = (ref.pct_change() - b.pct_change()).abs()
    check((gap > 0.001).any() and price_calls == [],
          f"{SID}: Blave's adjusted returns differ from the CDN's by up to {gap.max():.2%} a day "
          "(a whole-window switch would show); the published CDN asks Blave nothing")


def t_late_cdn_equals_published():
    D.datetime = Clock
    for with_event, sc in ((False, PLAIN), (True, EXDIV)):
        for name, fn in CALLS.items():
            for whole in ((False, True) if "batch" in name else (False,)):
                ref = run("2026-10-16 18:06", LAST, sc, fn, whole)
                nxt = run("2026-10-19 08:40", LAST, sc, fn, whole)
                tag = f"{name}{' whole-market' if whole else ''}{' ex-div on 10-16' if with_event else ''}"
                check(ref.index[-1] == pd.Timestamp(LAST) and nxt.equals(ref) and price_calls == [],
                      f"{tag}: 18:06 and next day 08:40 — the CDN alone, same frame, no Blave price call")
                for when in LATE:
                    got = run(when, PREV, sc, fn, whole)
                    hist = got.iloc[:-1].equals(ref.iloc[:-1])
                    last = got.iloc[-1] - ref.iloc[-1]
                    if with_event and "adj" in name:
                        tail_ok = got.index[-1] == ref.index[-1] and (last.abs().fillna(0) <= 0.011).all()
                    else:
                        tail_ok = got.equals(ref)
                    starts = [s for _, s in price_calls if s]
                    check(hist and tail_ok and got.attrs.get("via") == "Blave CDN"
                          and got.attrs.get("tail_via") == "Blave" and starts and min(starts) >= "2026-10-01",
                          f"{tag} at {when[11:]}: history == the published CDN's, cell for cell; 10-16 from "
                          f"Blave on the CDN base (Δ {last.abs().max():.4f}); Blave asked from {min(starts or ['-'])}")


def refused(fn):
    try:
        fn()
        return None
    except D.FeedNotPublished as e:
        return e


def t_multi_day_reduction():
    """CDN three days late (10-13), a 減資 on 10-15 (raw price ×2, reference price 2 × the close):
    the three days join on, the event read from Blave's adjusted series — no jump, within the
    rounding of Blave's prices."""
    D.datetime = Clock
    c13 = float(Sc().raw().loc["2026-10-14", "close"])
    sc = Sc(extra=[["2026-10-15", c13, round(c13 * 2, 2), "tpex_reduction"]], scale=("2026-10-15", 2))
    for name in ("single adj", "batch adj", "single raw", "batch raw"):
        for whole in ((False, True) if "batch" in name else (False,)):
            ref = run("2026-10-16 18:06", LAST, sc, CALLS[name], whole)
            got = run("2026-10-16 17:36", "2026-10-13", sc, CALLS[name], whole)
            hist = got.loc[:"2026-10-13"].equals(ref.loc[:"2026-10-13"])
            d = (got.loc["2026-10-14":] - ref.loc["2026-10-14":]).abs()
            tol = (ref.loc["2026-10-14":].abs() * 4e-4).clip(lower=0.011)
            ok = hist and list(got.index[-3:]) == list(ref.index[-3:]) and (d.fillna(0) <= tol.fillna(1)).all().all()
            jump = abs(got["Close"].pct_change().loc["2026-10-15"]) if "adj" in name else 0
            check(ok and got.attrs.get("asof") == LAST and jump < 0.1,
                  f"{name}{' whole-market' if whole else ''}: CDN 10-13, 減資 10-15 — 10-14…16 joined on the "
                  f"CDN base (max Δ {d.max().max():.4f}, 10-15 move {jump:.2%})")


def t_blave_short():
    """Blave behind too, or without the CDN's last day: never a frame taken as complete, never NaN."""
    D.datetime = Clock
    short = Sc(blave_last={SID: PREV})
    for name in ("single adj", "batch adj"):
        ref = run("2026-10-16 18:06", LAST, short, CALLS[name])
        got = run("2026-10-16 17:36", "2026-10-13", short, CALLS[name])
        err = refused(lambda: run("2026-10-16 17:36", "2026-10-13", short, CALLS[name], live=True))
        check(got.attrs.get("asof") == PREV and got.index[-1] == pd.Timestamp(PREV)
              and got.equals(ref.loc[:PREV]) and err is not None and str(err.need) == LAST,
              f"{name}: CDN 10-13, Blave only to 10-15 — served through 10-15 (asof {got.attrs.get('asof')}), "
              f"live refused")
    gap = Sc(blave_drop={PREV})
    for name in ("single adj", "batch adj", "single raw", "batch raw"):
        cdn_only = run("2026-10-16 17:36", PREV, Sc(blave_last={SID: "2000-01-01"}), CALLS[name])
        got = run("2026-10-16 17:36", PREV, gap, CALLS[name])
        err = refused(lambda: run("2026-10-16 17:36", PREV, gap, CALLS[name], live=True))
        check(got.equals(cdn_only) and not got.isna().any().any() and "tail_via" not in got.attrs
              and got.attrs.get("asof") == PREV and err is not None,
              f"{name}: Blave lacks the CDN's last day (10-15) — nothing to join on: the CDN frame as is, "
              f"no NaN row, live refused")


def t_untraded_id():
    """An id with no Blave bar after the CDN's day while another id of the batch has the latest
    final: it did not trade — complete; alone, nothing says so — live refused."""
    D.datetime = Clock
    sc = Sc(ids=(SID, "6243"), blave_last={"6243": PREV})
    fn = lambda: D.fetch_twstock_price_adj_batch([SID, "6243"], START, None, {"api-key": "x"})  # noqa: E731
    err = refused(lambda: run("2026-10-16 17:36", PREV, sc, fn, live=True))
    got = run("2026-10-16 17:36", PREV, sc, fn, live=True) if err is None else {}
    check(err is None and got[SID].index[-1] == pd.Timestamp(LAST) and got["6243"].index[-1] == pd.Timestamp(PREV)
          and got["6243"].attrs.get("asof") == LAST,
          "batch: 6243 without a 10-16 bar on Blave while 6242 has it — complete, live served")
    one = lambda: D.fetch_twstock_price_adj("6243", START, None, {"api-key": "x"})  # noqa: E731
    err = refused(lambda: run("2026-10-16 17:36", PREV, sc, one, live=True))
    check(err is not None, "single 6243, Blave without 10-16: nothing tells a halt from a late Blave — live refused")


def t_desktop_exchange_down():
    D.datetime = Clock
    os.environ["BLAVE_AGENT_LOCAL"] = "1"
    real = D._fetch_twstock_daily_public
    D._fetch_twstock_daily_public = lambda *a, **k: (_ for _ in ()).throw(
        requests.exceptions.ConnectionError("exchange down (test)"))
    try:
        ref = run("2026-10-16 18:06", LAST, PLAIN, CALLS["single adj"])
        got = run("2026-10-16 17:40", PREV, PLAIN, CALLS["single adj"])
        check(got.equals(ref) and got.attrs.get("tail_via") == "Blave",
              "desktop, CDN late and the exchange down: the same frame as the published CDN, tail from Blave")
    finally:
        D._fetch_twstock_daily_public = real
        os.environ.pop("BLAVE_AGENT_LOCAL", None)


def t_live():
    D.datetime = Clock
    ref = run("2026-10-16 18:06", LAST, PLAIN, CALLS["batch adj"])
    try:
        got = run("2026-10-16 17:36", PREV, PLAIN, CALLS["batch adj"], live=True)
        check(got.equals(ref), "live tick at 17:36: served with 10-16 on the CDN base, not refused")
    except D.FeedNotPublished as e:
        check(False, f"live tick at 17:36: refused ({e})")


def t_note():
    """BLAVE_TW_DAILY_NOTE (the strategy-library machine): which source each frame came from."""
    D.datetime = Clock
    path = Path(tempfile.mkdtemp()) / "note.jsonl"
    os.environ["BLAVE_TW_DAILY_NOTE"] = str(path)
    real_get = D._tw_cdn_get
    try:
        got = []
        for when, asof in (("2026-10-16 17:36", PREV), ("2026-10-16 18:06", LAST)):
            path.unlink(missing_ok=True)
            run(when, asof, PLAIN, CALLS["batch adj"])
            got.append(json.loads(path.read_text())["kinds"])
        path.unlink(missing_ok=True)
        Clock.at = pd.Timestamp("2026-10-16 18:06", tz="Asia/Taipei").to_pydatetime()
        D._CACHE_DIR = Path(tempfile.mkdtemp())
        D._tw_cdn_get = lambda key, etag=None: (_ for _ in ()).throw(D.TwCdnUnavailable("down (test)"))
        D._retry_get = blave_stub(PLAIN)
        with contextlib.redirect_stdout(io.StringIO()):
            D.fetch_twstock_price_adj(SID, START, None, {"api-key": "x"})
        down = json.loads(path.read_text())
        check(got == [{"cdn+blave_tail": 1}, {"cdn": 1}] and down == {"kinds": {"blave_not_cdn": 1}, "not_cdn": [SID]},
              f"note: 17:36 {got[0]}, 18:06 {got[1]}, CDN down {down['kinds']}")
        D._tw_cdn_get = real_get
        path.unlink(missing_ok=True)
        run("2026-10-16 18:06", LAST, PLAIN, lambda: D.fetch_twstock_price_adj(SID, "2026-10-20", None, {"api-key": "x"}))
        future = json.loads(path.read_text())["kinds"]
        check(future == {"exchange": 1}, f"note: a window not begun yet (empty frame) is not counted as Blave: {future}")
    finally:
        D._tw_cdn_get = real_get
        os.environ.pop("BLAVE_TW_DAILY_NOTE", None)


def main():
    os.environ.pop("BLAVE_AGENT_LOCAL", None)
    real_dt = D.datetime
    try:
        t_fixture_discriminates()
        t_late_cdn_equals_published()
        t_multi_day_reduction()
        t_blave_short()
        t_untraded_id()
        t_desktop_exchange_down()
        t_live()
        t_note()
    finally:
        D.datetime = real_dt
        D._tw_official_expected_day = H._real_expected
        D._tw_cdn_expected_asof = H._real_cdn_expected
    print(f"\n{'ALL PASS' if not fails else f'{fails} FAIL'}")
    sys.exit(1 if fails else 0)


if __name__ == "__main__":
    main()
