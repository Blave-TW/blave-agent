"""fetch_twstock_ratios / fetch_twstock_ratios_batch: the wrapper around the ratios endpoints.

Pins: more than 50 ids go out in chunks of at most 50 against batch/ratios; a frame is wide,
indexed by quarter-end date, with a null ratio as NaN (not 0); start / end cut the returned
rows while the cache keeps the whole history (a second call with another range sends no
request); an id absent from the body (an ETF) or with no quarter in range is absent from the
result; the single-stock fetcher lets the api's 404 through and returns an empty frame for
empty data; both names resolve to the statements' publication timing.
No network. Run: cd blave-agent && .venv/bin/python tests/check_twstock_ratios.py
"""
import math, os, shutil, sys, tempfile
from pathlib import Path
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import requests
from lib import data as d

TMP = Path(tempfile.mkdtemp(prefix="twratios-"))
d._CACHE_DIR = TMP
d._FUNDAMENTAL_RETRY_PASSES = ((50, 0), (10, 0), (5, 0))
d._FUNDAMENTAL_BATCH_WORKERS = 1

fails = 0
def check(cond, msg):
    global fails
    print(("  PASS  " if cond else "  FAIL  ") + msg); fails += (not cond)

class _R:
    def __init__(self, body): self._b = body
    def json(self): return self._b

def rows(sid):
    return [{"date": "2025-12-31", "stock_id": sid, "roe_q": 9.5, "roe_ttm": 33.1, "gross_margin_q": None,
             "current_ratio": 245.7635, "fcf_q": 287363030000.0},
            {"date": "2026-03-31", "stock_id": sid, "roe_q": 10.2, "roe_ttm": 36.0, "gross_margin_q": None,
             "current_ratio": 240.1, "fcf_q": 1.0},
            {"date": "2026-06-30", "stock_id": sid, "roe_q": 11.3934, "roe_ttm": 40.3342, "gross_margin_q": None,
             "current_ratio": 245.7635, "fcf_q": 2.0}]

ETF = "0050"
calls = []
def batch_get(url, **kw):
    ids = kw["params"]["stock_ids"].split(",")
    calls.append((url, ids, dict(kw["params"])))
    return _R({"data_type": "ratios", "data": {s: rows(s) for s in ids if s != ETF}, "failed": []})

# 1. 120 ids → 3 requests of at most 50, to batch/ratios, with no date params
d._retry_get = batch_get
ids = [str(1000 + i) for i in range(119)] + [ETF]
out = d.fetch_twstock_ratios_batch(ids, {})
check([len(c[1]) for c in calls] == [50, 50, 20], f"120 ids → chunks of 50/50/20 ({[len(c[1]) for c in calls]})")
check(all(c[0].endswith("/studio/market/twstock/batch/ratios") for c in calls), "requests go to batch/ratios")
check(all(set(c[2]) == {"stock_ids"} for c in calls), "whole history is asked for (no start / end sent)")
check(len(out) == 119 and ETF not in out, "id absent from the body (ETF) is absent from the result")

# 2. frame shape
df = out["1000"]
check(list(df.index.strftime("%Y-%m-%d")) == ["2025-12-31", "2026-03-31", "2026-06-30"], "index = quarter-end dates, ascending")
check({"roe_q", "roe_ttm", "current_ratio", "fcf_q"} <= set(df.columns), "wide ratio columns")
check(df["roe_ttm"].iloc[-1] == 40.3342 and df["fcf_q"].iloc[0] == 287363030000.0, "values pass through unscaled")
check(math.isnan(df["gross_margin_q"].iloc[-1]), "null ratio → NaN, not 0")

# 3. start / end cut locally; the cache answers without a request
calls.clear()
cut = d.fetch_twstock_ratios_batch(["1000", "1001"], {}, start="2026-01-01", end="2026-03-31")
check(not calls and list(cut["1000"].index.strftime("%Y-%m-%d")) == ["2026-03-31"], "start / end cut the cached history, no request")
none = d.fetch_twstock_ratios_batch(["1000"], {}, start="2030-01-01")
check(none == {}, "no quarter in range → id absent")
check((TMP / "twstock_ratios_1000.parquet").exists(), "cache file is twstock_ratios_<id>.parquet")

# 4. single stock: same frame, cut by start
one = d.fetch_twstock_ratios("1000", {}, start="2026-04-01")
check(not calls and len(one) == 1 and one["roe_q"].iloc[0] == 11.3934, "single fetch reads the same cache and cuts by start")

# 5. single stock, empty data → empty frame, nothing cached
shutil.rmtree(TMP, ignore_errors=True)
d._retry_get = lambda url, **kw: _R({"stock_id": "9999", "data": []})
empty = d.fetch_twstock_ratios("9999", {}, start="2020-01-01")
check(empty.empty and not (TMP / "twstock_ratios_9999.parquet").exists(), "empty data → empty frame, not cached")

# 6. single stock, 404 (ETF) → the api's HTTPError reaches the caller
class _Resp: status_code = 404
def not_found(url, **kw):
    raise requests.HTTPError("404 — No data found for stock_id: 0050", response=_Resp())
d._retry_get = not_found
try:
    d.fetch_twstock_ratios(ETF, {})
    check(False, "404 → raises")
except requests.HTTPError as e:
    check(e.response.status_code == 404, "404 (no statements) → requests.HTTPError, not an empty frame")

# 7. publication timing: both names share the statements' entry
check(d.FEED_TIMING["twstock_ratios"] is d.FEED_TIMING["twstock_financials"]
      and d.FEED_TIMING["twstock_ratios_batch"] is d.FEED_TIMING["twstock_financials"],
      "align_feed timing = twstock_financials")

# 8. a new quarter's statements going live since the cache was written → refetch, not 30 days stale
#    (asked of _filing_due_since directly: the last due date can be >30 days back, where the
#    plain age rule would refetch anyway and hide a missing 'twstock_ratios' rule)
import time
import pandas as pd
now = pd.Timestamp.now(tz="Asia/Taipei")
stamps = pd.date_range("2024-01-01", now.normalize().tz_localize(None), freq="QS").tz_localize("Asia/Taipei")
last_due = max(t for t in d._quarterly_report_available(stamps) if t <= now)
check(d._filing_due_since("twstock_ratios", (last_due - pd.Timedelta(hours=1)).timestamp()),
      f"ratios cache written before the {last_due:%Y-%m-%d %H:%M} statements due time → refetched")
check(not d._filing_due_since("twstock_ratios", time.time()), "a ratios cache written after it → kept")

shutil.rmtree(TMP, ignore_errors=True)
print("ALL PASS" if not fails else f"{fails} FAILED")
sys.exit(1 if fails else 0)
