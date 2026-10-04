"""_fetch_fundamental_batch: parallel first pass and statement `types=`.

Pins: the 4-way first pass returns exactly what a one-at-a-time pass returns, never has more
than 4 requests out, stops handing out requests after a 4xx, and a failed chunk is still
retried serially / raised; `types=` is sent to the api, cut locally again (an api that ignores
it answers every item — that answer is kept as the full cache file), the subset cached under
its own file — a later full read never sees the subset — and served from a fresh full cache
file without a request.
No network. Run: cd blave-agent && .venv/bin/python tests/check_fundamental_batch_types.py
"""
import os, shutil, sys, tempfile, threading, time
from pathlib import Path
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import requests
from lib import data as d

TMP = Path(tempfile.mkdtemp(prefix="fundtypes-"))
d._CACHE_DIR = TMP
d._FUNDAMENTAL_RETRY_PASSES = ((50, 0), (10, 0), (5, 0))

fails = 0
def check(cond, msg):
    global fails
    print(("  PASS  " if cond else "  FAIL  ") + msg); fails += (not cond)

class _R:
    def __init__(self, body): self._b = body
    def json(self): return self._b

def rows(sid):
    return [{"date": "2026-03-31", "stock_id": sid, "type": "Equity", "value": float(sid)},
            {"date": "2026-03-31", "stock_id": sid, "type": "TotalAssets", "value": 2.0},
            {"date": "2026-06-30", "stock_id": sid, "type": "Equity", "value": 3.0}]

calls, live, peak = [], [0], [0]
lock = threading.Lock()
def fake(behaviour, delay=0.0):
    def _get(url, **kw):
        ids = kw["params"]["stock_ids"].split(",")
        with lock:
            calls.append((ids, kw["params"].get("types")))
            live[0] += 1; peak[0] = max(peak[0], live[0])
        try:
            time.sleep(delay)
            return behaviour(ids, kw["params"].get("types"))
        finally:
            with lock:
                live[0] -= 1
    return _get

def reset():
    calls.clear(); peak[0] = 0
    shutil.rmtree(TMP, ignore_errors=True)

def all_rows(ids, types):   # an api without `types`: every item, whatever was asked
    return _R({"data": {s: rows(s) for s in ids if s != "9999"}, "failed": []})

IDS = [str(1000 + i) for i in range(160)] + ["9999"]

# 1. parallel first pass == serial pass
reset()
d._FUNDAMENTAL_BATCH_WORKERS = 1
d._retry_get = fake(all_rows)
serial = d.fetch_twstock_balance_sheet_batch(IDS, {})
reset()
d._FUNDAMENTAL_BATCH_WORKERS = 4
d._retry_get = fake(all_rows, delay=0.2)
par = d.fetch_twstock_balance_sheet_batch(IDS, {})
check(sorted(par) == sorted(serial) and len(par) == 160
      and all(par[s].equals(serial[s]) for s in serial), "4-way first pass returns the same frames as serial")
check(peak[0] > 1 and len(calls) == 4, f"first pass really overlaps ({peak[0]} in flight, {len(calls)} calls)")
reset()
d._retry_get = fake(all_rows, delay=0.05)
d.fetch_twstock_balance_sheet_batch([str(5000 + i) for i in range(500)], {})
check(len(calls) == 10 and 1 < peak[0] <= 4, f"10 chunks, never more than 4 in flight ({peak[0]})")

# 2. failed ids across parallel chunks → retried one request at a time, then raised
reset()
d._retry_get = fake(lambda ids, t: _R({"data": {s: rows(s) for s in ids if s not in ("1001", "1120")},
                                       "failed": [s for s in ids if s in ("1001", "1120")]}), delay=0.05)
try:
    d.fetch_twstock_financials_batch(IDS[:160], {})
    check(False, "persistent failure → raises")
except RuntimeError as e:
    tail = str(e).split(":")[-1]
    check("1001" in tail and "1120" in tail and "1002" not in tail, "persistent failure → names only the failed ids")
check([c[0] for c in calls[4:]] == [["1001", "1120"], ["1001", "1120"]],
      f"retry passes are serial and carry only the failed ids ({[c[0] for c in calls[4:]]})")
check(not (TMP / "twstock_fin_1001.parquet").exists() and (TMP / "twstock_fin_1002.parquet").exists(),
      "failed id uncached, its chunk-mates cached")

# 3. one chunk times out in the parallel pass → retried, full result
reset()
seen = set()
def flaky(ids, t):
    if "1060" in ids and "once" not in seen:
        seen.add("once")
        raise requests.exceptions.ReadTimeout("timed out")
    return all_rows(ids, t)
d._retry_get = fake(flaky)
out = d.fetch_twstock_financials_batch(IDS[:160], {})
check(len(out) == 160, "a timed-out chunk is retried and the result is complete")

# 4. a 4xx in any parallel chunk is raised, and no new request goes out after it
reset()
class _Resp: status_code = 400
def bad(ids, t):
    if "5000" in ids:
        raise requests.HTTPError("400", response=_Resp())
    return all_rows(ids, t)
d._retry_get = fake(bad, delay=0.05)
try:
    d.fetch_twstock_financials_batch([str(5000 + i) for i in range(500)], {})
    check(False, "4xx → raises")
except requests.HTTPError:
    check(len(calls) <= 5, f"4xx in the first chunk → raised, the other 9 chunks mostly never sent ({len(calls)} calls)")

# 5. types: sent, cut locally against an api that ignores it, cached apart from the full file
reset()
d._retry_get = fake(all_rows)
sub = d.fetch_twstock_balance_sheet_batch(["2330", "9999"], {}, types=["Equity"])
check(calls[0][1] == "Equity", f"types sent to the api ({calls[0][1]})")
check(list(sub) == ["2330"] and set(sub["2330"]["type"]) == {"Equity"} and len(sub["2330"]) == 2,
      "old api answered every item → only Equity rows returned")
check(len(d.pd.read_parquet(TMP / "twstock_bs_2330.parquet")) == 3,
      "old api's every-item answer kept as the full cache file (all 3 rows, not the subset)")
calls.clear()
full = d.fetch_twstock_balance_sheet_batch(["2330"], {})
check(not calls and len(full["2330"]) == 3, "later full read served from that file, every item")
calls.clear()
again = d.fetch_twstock_balance_sheet_batch(["2330"], {}, types=("Equity",))
check(not calls and again["2330"].equals(sub["2330"]), "fresh full cache → subset cut locally, no request")
none_ = d.fetch_twstock_balance_sheet_batch(["2330"], {}, types="EPS")
check(not calls and none_ == {}, "full cache without the item → absent, no request")

# 6. an api that honours types: subset cached apart, full file never written
reset()
def honours(ids, t):
    keep = set(t.split(",")) if t else None
    return _R({"data": {s: [r for r in rows(s) if keep is None or r["type"] in keep] for s in ids},
               "failed": []})
d._retry_get = fake(honours)
sub = d.fetch_twstock_balance_sheet_batch(["2330"], {}, types=["Equity"])
check(len(sub["2330"]) == 2 and not (TMP / "twstock_bs_2330.parquet").exists(),
      "new api's subset answer never written under the full cache name")
calls.clear()
full = d.fetch_twstock_balance_sheet_batch(["2330"], {})
check(len(calls) == 1 and calls[0][1] is None and len(full["2330"]) == 3,
      "later full read refetches without types and gets every item")

# 7. a subset cache serves the same subset, any order / duplicates
reset()
d._retry_get = fake(honours)
d.fetch_twstock_financials_batch(["2330"], {}, types=["TotalAssets", "Equity"])
calls.clear()
hit = d.fetch_twstock_financials_batch(["2330"], {}, types=["Equity", "TotalAssets", "Equity"])
check(not calls and len(hit["2330"]) == 3, "subset cache hit regardless of order / duplicates")
other = d.fetch_twstock_financials_batch(["2330"], {}, types=["Equity"])
check(len(calls) == 1 and len(other["2330"]) == 2, "a different subset is its own cache entry")

# 8. validation
for badt in ([], ["a,b"], ["x" * 101], [f"T{i}" for i in range(51)]):
    try:
        d.fetch_twstock_financials_batch(["2330"], {}, types=badt)
        check(False, f"types={str(badt)[:30]} → ValueError")
    except ValueError:
        check(True, f"types={str(badt)[:30]} → ValueError")

shutil.rmtree(TMP, ignore_errors=True)
print("ALL PASS" if not fails else f"{fails} FAILED")
sys.exit(1 if fails else 0)
