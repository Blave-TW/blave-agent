"""_fetch_fundamental_batch must never silently drop ids the server failed to fetch.

Pins: ids in the body's `failed` (and ids of a chunk whose request errored) are retried in
smaller chunks, one request at a time (but not when no request got any answer —
_retry_get already backed off); still failing → RuntimeError naming the ids and the
endpoint, and no cache file for them; a 4xx is raised at once, not retried; a clean body
returns every id with data, and an id absent from both `data` and `failed` is just absent.
No network. Run: cd blave-agent && .venv/bin/python tests/check_fundamental_batch_failed.py
"""
import os, shutil, sys, tempfile
from pathlib import Path
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import requests
from lib import data as d

TMP = Path(tempfile.mkdtemp(prefix="fundbatch-"))
d._CACHE_DIR = TMP
d._FUNDAMENTAL_RETRY_PASSES = ((50, 0), (10, 0), (5, 0))

fails = 0
def check(cond, msg):
    global fails
    print(("  PASS  " if cond else "  FAIL  ") + msg); fails += (not cond)

class _R:
    def __init__(self, body): self._b = body
    def json(self): return self._b

ROWS = [{"date": "2026-06-30", "type": "EPS", "value": 1.0}]
calls = []
def fake(behaviour):
    def _get(url, **kw):
        ids = kw["params"]["stock_ids"].split(",")
        calls.append(ids)
        return behaviour(ids)
    return _get

def reset():
    calls.clear()
    shutil.rmtree(TMP, ignore_errors=True)

# 1. clean body: data returned, genuinely-empty id absent, one request
reset()
d._retry_get = fake(lambda ids: _R({"data": {s: ROWS for s in ids if s != "9999"}, "failed": []}))
out = d.fetch_twstock_financials_batch(["2330", "2317", "9999"], {})
check(sorted(out) == ["2317", "2330"] and len(calls) == 1, f"clean body → 2330/2317 returned, 9999 absent, 1 call ({len(calls)})")
check(float(out["2330"]["value"].iloc[0]) == 1.0, "clean body → parsed frame value")

# 2. id the server always fails: retried in every pass, then raises naming it; never cached
reset()
d._retry_get = fake(lambda ids: _R({"data": {s: ROWS for s in ids if s != "2454"},
                                    "failed": [s for s in ids if s == "2454"]}))
try:
    d.fetch_twstock_balance_sheet_batch(["2330", "2454"], {})
    check(False, "persistent server failure → raises")
except RuntimeError as e:
    check("2454" in str(e) and "balance_sheet" in str(e) and "2330" not in str(e).split(":")[-1],
          "persistent server failure → RuntimeError names 2454 + endpoint only")
check(calls == [["2330", "2454"], ["2454"], ["2454"]], f"retried only the failed id, serially ({calls})")
check(not (TMP / "twstock_bs_2454.parquet").exists(), "failed id gets no cache file")
check((TMP / "twstock_bs_2330.parquet").exists(), "good id in the same chunk is cached")

# 3. transient: fails once then succeeds → no raise, full result
reset()
seen = set()
def flaky(ids):
    bad = [s for s in ids if s == "2454" and s not in seen]
    seen.update(bad)
    return _R({"data": {s: ROWS for s in ids if s not in bad}, "failed": bad})
d._retry_get = fake(flaky)
out = d.fetch_twstock_monthly_revenue_batch(["2330", "2454"], {})
check(sorted(out) == ["2330", "2454"] and len(calls) == 2, "transient failure → retried and returned in full")

# 4. whole chunk errors (timeout exhausted) → not swallowed, raises
reset()
def boom(url, **kw):
    calls.append(kw["params"]["stock_ids"].split(","))
    raise requests.exceptions.ReadTimeout("read timed out")
d._retry_get = boom
try:
    d.fetch_twstock_financials_batch(["2330", "2317"], {})
    check(False, "chunk exception → raises")
except RuntimeError as e:
    check("2330" in str(e) and "2317" in str(e) and len(calls) == 1,
          f"no response at all → raises after one pass, no shrink-and-retry storm ({len(calls)} calls)")

# 5. 4xx is permanent → raised immediately, no retry
reset()
class _Resp: status_code = 400
def bad_req(url, **kw):
    calls.append(1)
    raise requests.HTTPError("400 — Invalid stock_id in list", response=_Resp())
d._retry_get = bad_req
try:
    d.fetch_twstock_financials_batch(["2330"], {})
    check(False, "4xx → raises")
except requests.HTTPError:
    check(len(calls) == 1, "4xx → raised at once, not retried")

shutil.rmtree(TMP, ignore_errors=True)
print("ALL PASS" if not fails else f"{fails} FAILED")
sys.exit(1 if fails else 0)
