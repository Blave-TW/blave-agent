"""Minimal check: the Blave CDN's adjusted daily bars (lib.data fetch_twstock_price_adj and its batch
twin on the CDN path) move day for day like the Blave endpoint's. No network: the CDN answers from
tests/fixtures/tw_cdn/ (stock files cut from the real build), Blave's numbers for the same days are
tests/fixtures/tw_cdn/blave_price_adj_halts.json (the endpoint's price_adj, 2026-10-18).

  - halted ex-date: an event on a day the stock did not trade (6242 2015-05-26 復牌 / 2016-08-31 除權,
    1805 2011-09-08 減資, 2540 2014-09-23 除權) takes effect on the next traded day, as on Blave — no
    fake jump on the event day; every daily return equals Blave's within the 2-decimal rounding
  - start-independent: the factors accumulate from the stock's first CDN day, so 6242 from 2014 and
    from 2020 (per stock), and 2603 from 2022-08-01 and from 2022-10-03 across its 2022-09-19 減資
    (per stock and whole-market files), are the same prices on the days both cover

Run: cd blave-agent && MPLBACKEND=Agg .venv/bin/python tests/check_tw_cdn_adjust.py
"""
import json
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
sys.path.insert(0, os.path.join(ROOT, "tests"))
os.environ.setdefault("MPLBACKEND", "Agg")

import pandas as pd

import check_tw_cdn_daily as H
import lib.data as D

BLAVE = json.loads((H.CDN / "blave_price_adj_halts.json").read_text())
HALTS = {"6242": ("2014-06-02", "2026-10-16"), "1805": ("2011-07-01", "2011-10-31"),
         "2540": ("2014-08-01", "2014-10-31")}
fails = 0


def check(cond, msg):
    global fails
    print(("  PASS  " if cond else "  FAIL  ") + msg)
    fails += (not cond)


def manifest():
    m = json.loads((H.CDN / "manifest.json").read_text())
    for sid, (_, last) in HALTS.items():
        m["stocks"][sid] = ["tpex" if sid == "6242" else "twse", "2010-01-04", last]
    return m


def rounding_gap(cdn, blave):
    """|CDN return − Blave return| beyond what 2-decimal rounding of both series allows, per day."""
    c, b = cdn.pct_change(), blave.pct_change()
    bound = 0.005 * (1 / cdn + 1 / cdn.shift() + 1 / blave + 1 / blave.shift()) * (1 + b.abs()) + 1e-9
    gap = (c - b).abs() - bound
    return gap[gap > 0].dropna()


def t_halted_ex_date():
    cdn = H.fresh(manifest=manifest())
    H.pin_now(cdn.manifest["asof"])
    for sid in HALTS:
        ref = pd.Series(BLAVE[sid]).rename(index=pd.Timestamp).sort_index()
        a, b = (str(d.date()) for d in ref.index[[0, -1]])
        got = D.fetch_twstock_price_adj(sid, a, b, {})["Close"]
        common = got.index.intersection(ref.index)
        bad = rounding_gap(got[common], ref[common])
        check(len(common) >= 0.95 * len(ref) and bad.empty,
              f"{sid}: {len(common)} days, daily returns == Blave's within rounding"
              + ("" if bad.empty else f" — off on {[str(d.date()) for d in bad.index[:5]]}"))
    adj = D.fetch_twstock_price_adj("6242", "2016-08-01", "2016-09-30", {})["Close"]
    raw = D.fetch_twstock_price("6242", "2016-08-01", "2016-09-30", {})["Close"]
    check(adj["2016-08-31"] == adj["2016-08-30"] and adj["2016-09-14"] == adj["2016-08-30"]
          and raw["2016-09-19"] / raw["2016-09-14"] < 0.9 and abs(adj.pct_change()["2016-09-19"]) < 0.02,
          "6242 除權 2016-08-31 inside a halt: flat through the halt, the factor lands on the 2016-09-19 resumption")


def t_start_independent():
    cdn = H.fresh(manifest=manifest())
    H.pin_now(cdn.manifest["asof"])
    early = D.fetch_twstock_price_adj("6242", "2014-01-02", None, {})
    late = D.fetch_twstock_price_adj("6242", "2020-01-02", None, {})
    check(len(late) > 1000 and early.loc[late.index].equals(late),
          f"6242: start 2014 and start 2020 give the same adjusted prices on all {len(late)} shared days")
    a = D.fetch_twstock_price_adj_batch(["2603"], "2022-08-01", "2022-11-30", {})["2603"]
    b = D.fetch_twstock_price_adj_batch(["2603"], "2022-10-03", "2022-11-30", {})["2603"]
    D._TW_CDN_WHOLE_MARKET_IDS = 0
    try:
        wa = D.fetch_twstock_price_adj_batch(["2603"], "2022-08-01", "2022-11-30", {})["2603"]
        wb = D.fetch_twstock_price_adj_batch(["2603"], "2022-10-03", "2022-11-30", {})["2603"]
    finally:
        D._TW_CDN_WHOLE_MARKET_IDS = 40
    check(len(b) > 30 and a.loc[b.index].equals(b) and wa.equals(a) and wb.equals(b),
          "2603 across its 2022-09-19 減資: start 08-01 and 10-03 agree on shared days, per stock == whole-market")


def main():
    t_halted_ex_date()
    t_start_independent()
    D._tw_official_expected_day = H._real_expected
    D._tw_cdn_expected_asof = H._real_cdn_expected
    print(f"\n{'ALL PASS' if not fails else f'{fails} FAIL'}")
    sys.exit(1 if fails else 0)


if __name__ == "__main__":
    main()
