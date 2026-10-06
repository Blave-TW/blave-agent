"""Minimal check: TWSE BFI82U row names from every era land in the right fetch_twmarket_institutional
column, and months cached while the old names were unmapped (NaN foreign / dealer) get fetched
again exactly once. No network: answers recorded 2026-10-06 (tests/fixtures/tw_market_public/
twse_bfi82u_legacy_eras.json), the index of trading days is stubbed.

  - 2004-05-03 外資 / 自營商, 2009-05-15 外資及陸資 / 自營商, 2017-12-15 外資及陸資 / 自營商(自行買賣)
    + 自營商(避險), 2017-12-18 外資及陸資(不含外資自營商) + 外資自營商, 2024-03-15 the same with a
    non-zero 外資自營商: no NaN, nets as TWSE prints them (= FinMind / the Blave series). Before
    2017-12-18 the three buckets add up to 合計; from then on they do not (TWSE leaves 外資自營商,
    already inside 自營商, out of 合計, and the series puts it in dealer), so only values are checked
  - an unknown row name, a missing bucket row or a '--' value raises instead of caching NaN
  - a cached month with NaN foreign or dealer is re-fetched; clean months are not; the sweep is
    a single pass, so a later call makes no BFI82U request
  - a fetch cut short keeps the months already fetched (one request per day: month by month)

Run: cd blave-agent && MPLBACKEND=Agg .venv/bin/python tests/check_bfi82u_legacy_rows.py
"""
import atexit
import json
import math
import os
import shutil
import sys
import tempfile
from datetime import datetime as _real_dt
from pathlib import Path

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
os.environ.setdefault("MPLBACKEND", "Agg")
os.environ["BLAVE_AGENT_LOCAL"] = "1"

import pandas as pd

import lib.data as D

ERAS = json.loads((Path(ROOT) / "tests" / "fixtures" / "tw_market_public"
                   / "twse_bfi82u_legacy_eras.json").read_text(encoding="utf-8"))
fails = 0


def check(cond, msg):
    global fails
    print(("  PASS  " if cond else "  FAIL  ") + msg)
    fails += (not cond)


# foreign, investment_trust, dealer, total — TWSE 買賣差額, identical to FinMind on each day
WANT = {
    "20040503": (-6599853336, -255269212, -2487324350, -9342446898),
    "20090515": (-2987265191, None, None, None),
    "20171215": (-4280447060, -146756178, -287719946 - 2702385082, -7417308266),
    "20171218": (-126160633, 1015915590, -47890474 - 130946756 + 0, 710917727),
    # 外資自營商 -56,080: in foreign instead of dealer, both columns are off by it
    "20240315": (-11716251664, 2089574058, 1309064588 - 5302430482 - 56080, -13620043500),
}
for day, want in WANT.items():
    got = D._bfi82u_row(ERAS[day])
    names = [r[0] for r in ERAS[day]["data"]]
    sums = got[0] + got[1] + got[2] == got[3] if day < "20171218" else True
    check(not any(math.isnan(v) for v in got)
          and all(w is None or g == w for g, w in zip(got, want)) and sums,
          f"{day} {names[:-1]}: no NaN, nets as printed"
          + (", foreign+trust+dealer = 合計" if day < "20171218" else ""))


def raises(body):
    try:
        D._bfi82u_row(body)
        return False
    except D.TwPublicUnavailable:
        return True


check(raises({"data": [["外資淨額", "1", "0", "1"], ["合計", "1", "0", "1"]]}),
      "unknown row name raises, never cached as a NaN column")
rows = ERAS["20240315"]["data"]
check(raises({"data": [r for r in rows if r[0] != "外資及陸資(不含外資自營商)"]}),
      "a day without its foreign row raises")
check(raises({"data": [r[:3] + ["--"] if r[0] == "投信" else r for r in rows]}),
      "a '--' net raises")

# ── cache: NaN months from the old mapping are re-fetched once ──
NOW = _real_dt(2026, 10, 6, 10, 0, tzinfo=D._TPE)


class Frozen(_real_dt):
    @classmethod
    def now(cls, tz=None):
        return NOW.astimezone(tz) if tz else NOW.replace(tzinfo=None)

    @classmethod
    def utcnow(cls):
        return NOW.astimezone(D.timezone.utc).replace(tzinfo=None)


class Resp:
    def __init__(self, body):
        self.status_code, self.body = 200, body

    def json(self):
        return self.body

    def raise_for_status(self):
        pass


class Session:
    def __init__(self):
        self.days = []

    def get(self, url, params=None, headers=None, timeout=None):
        assert url == D._TWSE_BFI82U, url
        self.days.append(params["dayDate"])
        return Resp(ERAS.get(params["dayDate"], {"stat": "throttled"}))


class NoWait:
    def acquire(self):
        pass


D.datetime = Frozen
D._CACHE_DIR = Path(tempfile.mkdtemp(prefix="bfi82u-"))
atexit.register(shutil.rmtree, D._CACHE_DIR, ignore_errors=True)
D._TWSE_LIMITER = D._TW_PUBLIC_LIMITER = NoWait()
D._TW_PUBLIC_SESSION = s = Session()
DAYS = pd.to_datetime(["2004-05-03", "2017-12-15", "2017-12-18"])
D.fetch_twmarket_index_public = lambda a, b: pd.DataFrame(
    index=[d for d in DAYS if pd.Timestamp(a) <= d <= pd.Timestamp(b)])

cache = D._monthly_cache_dir("twmarket_public", {"kind": "institutional"})
cache.mkdir(parents=True)
cols = D._TWMARKET_INST_COLUMNS
nan = float("nan")
# as the old mapping cached them: foreign NaN to 2017-12-15, dealer NaN to 2014-11
pd.DataFrame([[nan, -255269212.0, nan, -9342446898.0]], columns=cols,
             index=pd.to_datetime(["2004-05-03"])).to_parquet(cache / "2004-05.parquet")
pd.DataFrame([[nan, -146756178.0, -2990105028.0, -7417308266.0],
              [-126160633.0, 1015915590.0, -178837230.0, 710917727.0]], columns=cols,
             index=pd.to_datetime(["2017-12-15", "2017-12-18"])).to_parquet(cache / "2017-12.parquet")
clean = pd.DataFrame([[1.0, 2.0, 3.0, 6.0]], columns=cols, index=pd.to_datetime(["2018-01-02"]))
clean.to_parquet(cache / "2018-01.parquet")
pd.DataFrame().to_parquet(cache / "2010-02.parquet")   # empty-month marker

df = D.fetch_twmarket_institutional_public("2004-05-01", "2004-05-31")
check(s.days == ["20040503"] and df.loc["2004-05-03", "foreign"] == -6599853336.0
      and df.loc["2004-05-03", "dealer"] == -2487324350.0,
      f"2004-05 cached with NaN foreign/dealer: re-fetched ({s.days}), now 外資 / 自營商 values")
check(not (cache / "2017-12.parquet").exists() and (cache / "2018-01.parquet").exists()
      and (cache / "2010-02.parquet").exists(),
      "same pass dropped 2017-12 (NaN on 12-15 only), kept the clean month and the empty marker")
s.days.clear()
df = D.fetch_twmarket_institutional_public("2017-12-01", "2017-12-31")
check(s.days == ["20171215", "20171218"] and not df.isna().any().any()
      and df.loc["2017-12-15", "foreign"] == -4280447060.0,
      f"2017-12 fetched again ({s.days}), no NaN left")
pd.DataFrame([[nan, 0.0, 0.0, 0.0]], columns=cols,
             index=pd.to_datetime(["2017-11-01"])).to_parquet(cache / "2017-11.parquet")
s.days.clear()
D.fetch_twmarket_institutional_public("2004-05-01", "2017-12-31")
check(s.days == [] and (cache / "2017-11.parquet").exists(),
      "single pass: a later call re-checks nothing and makes no BFI82U request")
pd.testing.assert_frame_equal(pd.read_parquet(cache / "2018-01.parquet"), clean)

# 2024-04-01 is not recorded, so the session fails there — 2024-03 must already be on disk
DAYS = pd.to_datetime(["2024-03-15", "2024-04-01"])
s.days.clear()
try:
    D.fetch_twmarket_institutional_public("2024-03-01", "2024-04-30")
    cut = False
except D.TwPublicUnavailable:
    cut = True
check(cut and s.days == ["20240315", "20240401"] and (cache / "2024-03.parquet").exists()
      and not (cache / "2024-04.parquet").exists()
      and pd.read_parquet(cache / "2024-03.parquet").loc["2024-03-15", "dealer"] == -3993421974.0,
      "fetch cut short in 2024-04: 2024-03 already cached, not fetched again next run")

print("all checks passed" if not fails else f"FAILED: {fails}")
sys.exit(1 if fails else 0)
