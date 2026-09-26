"""Minimal check: the key-free TAIEX-brief series in lib.data — TWSE MI_5MINS_HIST / FMTQIK /
BFI82U / MI_MARGN and TAIFEX futContractsDateDown. No network: the exchange session is stubbed
and replays answers recorded once each on 2026-09-26 (tests/fixtures/tw_market_public/); the
clock is frozen at 2026-09-26 10:00 Taipei so "today" and the current month never drift.

  - gate: without BLAVE_AGENT_LOCAL=1 every *_public fetch raises and makes no request
  - index / turnover: one request per month, ROC dates, same columns and units as Blave
  - 三大法人 / 融資: one request per trading day taken from the index (holidays cost nothing);
    外資自營商 in dealer, 融資 in 張 and 融資金額 仟元 × 1,000 = 元
  - a no-data answer for a past trading day raises instead of caching a hole
  - TAIFEX: POST, cp950 CSV; an end past the last published day (HTML answer) steps back a
    day at a time; an HTML answer for a window that ended over a week ago raises
  - attrs['source'] names the exchange; lang=en attribution has an English twin

Run: cd blave-agent && MPLBACKEND=Agg .venv/bin/python tests/check_tw_market_public.py
"""
import csv
import json
import os
import sys
import tempfile
from datetime import datetime as _real_dt
from pathlib import Path

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
os.environ.setdefault("MPLBACKEND", "Agg")

import pandas as pd
import requests

import lib.data as D

FIX = Path(ROOT) / "tests" / "fixtures" / "tw_market_public"
fails = 0


def check(cond, msg):
    global fails
    print(("  PASS  " if cond else "  FAIL  ") + msg)
    fails += (not cond)


NOW = _real_dt(2026, 9, 26, 10, 0, tzinfo=D._TPE)


class Frozen(_real_dt):
    @classmethod
    def now(cls, tz=None):
        return NOW.astimezone(tz) if tz else NOW.replace(tzinfo=None)

    @classmethod
    def utcnow(cls):
        return NOW.astimezone(D.timezone.utc).replace(tzinfo=None)


D.datetime = Frozen


class Resp:
    def __init__(self, body, status=200):
        self.status_code, self.content = status, body

    def json(self):
        return json.loads(self.content.decode("utf-8-sig"))

    def raise_for_status(self):
        if self.status_code >= 400:
            raise requests.HTTPError(str(self.status_code), response=self)


def fx(name):
    body = (FIX / name).read_bytes()
    fn = getattr(D._TW_PUBLIC_SESSION, "patch", {}).get(name)
    return json.dumps(fn(json.loads(body)), ensure_ascii=False).encode() if fn else body


NO_DATA = json.dumps({"stat": "很抱歉，沒有符合條件的資料!"}, ensure_ascii=False).encode()
LAST_PUBLISHED = "2026/09/24"


class Session:
    """GET → TWSE fixtures (BFI82U / MI_MARGN answer the recorded 09-24 day for any day unless
    listed in `holes`); POST → TAIFEX CSV while queryEndDate ≤ its last published day, else HTML."""
    def __init__(self, holes=(), taifex_last=LAST_PUBLISHED, patch=None):
        self.gets, self.posts, self.holes, self.taifex_last = [], [], set(holes), taifex_last
        self.patch = patch or {}   # fixture name → fn(payload dict) → payload dict

    def get(self, url, params=None, headers=None, timeout=None):
        p = dict(params or {})
        self.gets.append((url, p))
        if url == D._TWSE_INDEX_HIST and p.get("date") == "20260901":
            return Resp(fx("twse_mi_5mins_hist_2026-09.json"))
        if url == D._TWSE_FMTQIK and p.get("date") == "20260901":
            return Resp(fx("twse_fmtqik_2026-09.json"))
        if url in (D._TWSE_INDEX_HIST, D._TWSE_FMTQIK) and p.get("date") in ("20260801", "20261001"):
            return Resp(NO_DATA)   # August left empty, so a stray 08-31 row could only come from September's answer
        day = p.get("dayDate") or p.get("date")
        if url in (D._TWSE_BFI82U, D._TWSE_MI_MARGN):
            if day in self.holes:
                return Resp(NO_DATA)
            return Resp(fx("twse_bfi82u_20260924.json" if url == D._TWSE_BFI82U else "twse_mi_margn_20260924.json"))
        raise requests.exceptions.ConnectionError(f"no fixture for {url} {p}")

    def post(self, url, data=None, headers=None, timeout=None):
        self.posts.append(dict(data))
        if url == D._TAIFEX_FUT_INST and data["queryEndDate"] <= self.taifex_last:
            return Resp(fx("taifex_futinst_txf_2026-09-01_2026-09-24.csv"))
        return Resp(fx("taifex_futinst_past_last_day.html"))


class NoWait:
    def acquire(self):
        pass


def fresh(**kw):
    D._CACHE_DIR = Path(tempfile.mkdtemp(prefix="twmkt-"))
    D._TW_PUBLIC_SESSION = Session(**kw)
    D._TW_PUBLIC_LIMITER = NoWait()
    D._TWSE_LIMITER = NoWait()
    return D._TW_PUBLIC_SESSION


# ── gate ──
os.environ.pop("BLAVE_AGENT_LOCAL", None)
s = fresh()
for fn, args in ((D.fetch_twmarket_index_public, ()), (D.fetch_twmarket_margin_public, ()),
                 (D.fetch_twfutures_institutional_public, ("TX",))):
    try:
        fn(*args, "2026-09-01", "2026-09-26")
        check(False, f"{fn.__name__}: no BLAVE_AGENT_LOCAL → raises")
    except D.TwPublicUnavailable:
        check(not s.gets and not s.posts, f"{fn.__name__}: no BLAVE_AGENT_LOCAL → raises, zero requests")
os.environ["BLAVE_AGENT_LOCAL"] = "1"

# ── index / turnover ──
s = fresh()
idx = D.fetch_twmarket_index_public("2026-09-01", "2026-09-26")
raw = json.loads(fx("twse_mi_5mins_hist_2026-09.json"))["data"]
check(list(idx.columns) == ["Open", "High", "Low", "Close"] and len(idx) == len(raw)
      and idx.index[0] == pd.Timestamp("2026-09-01") and idx.index.tz is None
      and idx.loc["2026-09-01", "Close"] == 46948.72 and idx.attrs.get("source") == "TWSE",
      f"TAIEX from MI_5MINS_HIST: {len(idx)} rows, naive ROC→AD dates, 09-01 close 46,948.72, source TWSE")
check(len(s.gets) == 1, "one request for the month")
turn = D.fetch_twmarket_turnover_public("2026-09-01", "2026-09-26")
check(list(turn.columns) == D._TWMARKET_TURNOVER_COLUMNS and turn.loc["2026-09-01", "value"] == 1187571567117.0
      and turn.loc["2026-09-01", "volume"] == 13000849196.0 and turn.loc["2026-09-01", "trades"] == 5301801.0,
      "turnover from FMTQIK: volume 股 / value 元 / trades, as recorded")

# ── 三大法人 / 融資: one request per index trading day ──
s = fresh()
inst = D.fetch_twmarket_institutional_public("2026-09-01", "2026-09-26")
bfi = [(u, p) for u, p in s.gets if u == D._TWSE_BFI82U]
check(len(bfi) == len(raw) and {p["dayDate"] for _, p in bfi} == {d.strftime("%Y%m%d") for d in idx.index},
      f"BFI82U asked once per trading day in the index ({len(bfi)}), no holiday requests")
last = inst.loc["2026-09-24"]
check(list(inst.columns) == D._TWMARKET_INST_COLUMNS and last["foreign"] == -32964613655.0
      and last["investment_trust"] == -12823263300.0 and last["dealer"] == 4235536088.0 - 2897105667.0 + 0.0
      and last["total"] == -44449446534.0 and inst.attrs.get("source") == "TWSE",
      "BFI82U: net 元, 外資 excludes 外資自營商 (counted in dealer), 合計 as TWSE prints it")
mg = D.fetch_twmarket_margin_public("2026-09-01", "2026-09-26")
m = mg.loc["2026-09-24"]
check(list(mg.columns) == D._TWMARKET_MARGIN_COLUMNS and m["margin_balance"] == 9279712.0
      and m["margin_balance_prev"] == 9282262.0 and m["margin_balance_value"] == 615103402000.0
      and m["short_balance"] == 202008.0 and m["short_balance_prev"] == 213059.0,
      "MI_MARGN 信用交易統計: balances in 張, 融資金額 仟元 × 1,000 = 元")
s = fresh(holes={"20260922"})
try:
    D.fetch_twmarket_institutional_public("2026-09-01", "2026-09-26")
    check(False, "no-data answer for a past trading day raises")
except D.TwPublicUnavailable as e:
    check("2026-09-22" in str(e), f"no-data answer for a past trading day raises, not cached as a hole ({e})")

# ── mutations the recorded day does not exercise ──
def foreign_dealer(j):
    j["data"] = [["外資自營商", "100", "40", "60"] if r[0] == "外資自營商" else r for r in j["data"]]
    return j
s = fresh(patch={"twse_bfi82u_20260924.json": foreign_dealer})
inst2 = D.fetch_twmarket_institutional_public("2026-09-01", "2026-09-26").loc["2026-09-24"]
check(inst2["foreign"] == -32964613655.0 and inst2["dealer"] == 4235536088.0 - 2897105667.0 + 60.0,
      "外資自營商 non-zero: counted in dealer, foreign unchanged")
def neighbour(j):
    j["data"] = [["115/08/31", "1.00", "2.00", "0.50", "1.50"]] + j["data"]
    return j
Frozen_now = NOW
NOW = _real_dt(2026, 10, 5, 10, 0, tzinfo=D._TPE)   # Aug + Sep are one past span → one raw call
s = fresh(patch={"twse_mi_5mins_hist_2026-09.json": neighbour})
idx2 = D.fetch_twmarket_index_public("2026-08-01", "2026-09-30")
check(pd.Timestamp("2026-08-31") not in idx2.index and len(idx2) == len(raw),
      "a neighbour month's row in the September answer is dropped, not stored as August")
NOW = _real_dt(2026, 9, 24, 16, 0, tzinfo=D._TPE)   # a trading day, index already has it
s = fresh(holes={"20260924"})
inst3 = D.fetch_twmarket_institutional_public("2026-09-01", "2026-09-24")
check(inst3.index[-1] == pd.Timestamp("2026-09-23"), "today not published yet: skipped, frame ends the day before")
s = fresh(holes={"20260923"})
mg3 = D.fetch_twmarket_margin_public("2026-09-01", "2026-09-24")
check(pd.Timestamp("2026-09-23") not in mg3.index and mg3.index[-1] == pd.Timestamp("2026-09-24"),
      "yesterday in the same month not out yet (MI_MARGN past midnight): skipped, not a failure")
s = fresh(holes={"20260922"})
try:
    D.fetch_twmarket_margin_public("2026-09-01", "2026-09-24")
    check(False, "two days back with no data raises")
except D.TwPublicUnavailable:
    check(True, "two days back with no data raises")
NOW = Frozen_now

# ── TAIFEX ──
s = fresh()
fut = D.fetch_twfutures_institutional_public("TXF", "2026-09-01", "2026-09-26")
ends = [p["queryEndDate"] for p in s.posts]
check(ends == ["2026/09/26", "2026/09/25", "2026/09/24"] and all(p["commodityId"] == "TXF" for p in s.posts),
      f"end past the last published day steps back a day at a time: {ends}")
rows = list(csv.reader(fx("taifex_futinst_txf_2026-09-01_2026-09-24.csv").decode("cp950").splitlines()))
hdr = {n: i for i, n in enumerate(rows[0])}
want = [r for r in rows[1:] if r and r[0] == "2026/09/24" and r[hdr["身份別"]].startswith("外資")][0]
check(list(fut.columns) == D._TWFUT_INST_COLUMNS and fut.index[-1] == pd.Timestamp("2026-09-24")
      and fut.loc["2026-09-24", "foreign_net_oi"] == float(want[hdr["多空未平倉口數淨額"]])
      and fut.loc["2026-09-24", "foreign_net_deal"] == float(want[hdr["多空交易口數淨額"]])
      and fut.attrs.get("source") == "TAIFEX",
      f"TX 外資 net OI = TAIFEX 多空未平倉口數淨額 ({want[hdr['多空未平倉口數淨額']]}), source TAIFEX")
Frozen_now = NOW
NOW = _real_dt(2026, 10, 20, 10, 0, tzinfo=D._TPE)
s = fresh(taifex_last="2026/08/31")
try:
    D._taifex_inst_raw("TXF", "2026-09-01", "2026-10-01")
    check(False, "HTML for a window that ended over a week ago raises")
except D.TwPublicUnavailable:
    check(len(s.posts) <= 8, f"HTML for a window that ended over a week ago raises after {len(s.posts)} tries")
NOW = Frozen_now
try:
    D.fetch_twfutures_institutional_public("TE", "2026-09-01", "2026-09-26")
    check(False, "unsupported id raises")
except D.TwPublicUnavailable:
    check(True, "unsupported futures id raises TwPublicUnavailable")

check(D.PUBLIC_SOURCE_EN[D._TWSE_SOURCE_ZH] == D._TWSE_SOURCE_EN
      and D.PUBLIC_SOURCE_EN[D._TAIFEX_SOURCE_ZH] == D._TAIFEX_SOURCE_EN
      and D.PUBLIC_SOURCE_EN[D._TW_PUBLIC_SOURCE_ZH] == D._TW_PUBLIC_SOURCE_EN, "each zh attribution has an en twin")

print("all checks passed" if not fails else f"FAILED: {fails}")
sys.exit(1 if fails else 0)
