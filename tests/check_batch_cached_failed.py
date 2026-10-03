"""_fetch_batch_cached must never silently drop ids the server failed to fetch (2026-10-03: the
FinMind hourly quota ran out, per / price_adj batches dropped 7,254 stock-requests and a backtest
went through with 0 trades).

Pins: ids in the body's `failed` (and ids of an errored request) get ONE serial retry pass in
smaller chunks; recovered → returned and cached; still failing → BatchIncomplete (a RuntimeError)
naming the endpoint and the ids, with the ids that did come back in `.partial`, and no cache for
the failed ones; no retry when no request got any answer; DataAccessError is not swallowed.
No network. Run: cd blave-agent && .venv/bin/python tests/check_batch_cached_failed.py
"""
import os, shutil, sys, tempfile
from pathlib import Path
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from lib import data as d

TMP = Path(tempfile.mkdtemp(prefix="batchcached-"))
d._CACHE_DIR = TMP

fails = 0
def check(cond, msg):
    global fails
    print(("  PASS  " if cond else "  FAIL  ") + msg); fails += (not cond)

class _R:
    def __init__(self, body): self._b = body
    def json(self): return self._b

ROWS = [{"date": "2024-01-02", "PER": 10.0, "PBR": 1.0, "dividend_yield": 3.0}]
calls = []
def fake(behaviour):
    def _get(url, **kw):
        ids = kw["params"]["stock_ids"].split(",")
        calls.append(ids)
        return behaviour(ids, len(calls))
    return _get

def run(ids):
    return d.fetch_twstock_per_batch(ids, "2024-01-01", "2024-01-31", {})

def reset():
    calls.clear()
    shutil.rmtree(TMP, ignore_errors=True)

def cached(sid):
    return any(TMP.rglob(f"*{sid}*"))

IDS = [str(1000 + i) for i in range(60)]   # two 50-id chunks

reset()
d._retry_get = fake(lambda ids, n: _R({"data": {s: ROWS for s in ids}, "failed": []}))
out = run(IDS)
check(sorted(out) == sorted(IDS) and len(calls) == 2, f"clean → every id, no retry ({len(calls)} calls)")

reset()
d._retry_get = fake(lambda ids, n: _R({"data": {s: ROWS for s in ids if n > 2 or s != "1003"},
                                       "failed": ["1003"] if n <= 2 and "1003" in ids else []}))
out = run(IDS)
check("1003" in out and calls[2:] == [["1003"]], f"failed once → recovered by one smaller serial request ({calls[2:]})")
check(cached("1003"), "recovered id is cached")

reset()
d._retry_get = fake(lambda ids, n: _R({"data": {s: ROWS for s in ids if s not in ("1003", "1051")},
                                       "failed": [s for s in ids if s in ("1003", "1051")]}))
try:
    run(IDS)
    check(False, "persistent failure → raises")
except d.BatchIncomplete as e:
    msg = str(e)
    check(isinstance(e, RuntimeError) and "/batch/per" in msg and "1003" in msg and "1051" in msg,
          "persistent failure → BatchIncomplete (RuntimeError) names the endpoint and both ids")
    check(sorted(e.failed) == ["1003", "1051"] and "1000" in e.partial and "1003" not in e.partial,
          "…with the good ids in .partial and the failed ones in .failed")
check(len(calls) == 3 and calls[2] == ["1003", "1051"], f"exactly one retry pass, no loop ({len(calls)} calls)")
check(not cached("1003") and not cached("1051") and cached("1000"), "failed ids get no cache; good ids do")

reset()
def _down(ids, n):
    raise ConnectionError("no answer")
d._retry_get = fake(_down)
try:
    run(IDS[:5])
    check(False, "no answer at all → raises")
except d.BatchIncomplete:
    check(len(calls) == 1, f"no answer at all → raises without a retry pass ({len(calls)} calls)")

reset()
def _denied(ids, n):
    raise d.DataAccessError("no access")
d._retry_get = fake(_denied)
try:
    run(IDS[:5])
    check(False, "DataAccessError propagates")
except d.DataAccessError as e:
    check(not isinstance(e, d.BatchIncomplete), "DataAccessError propagates as itself")

    check("remove them from the universe" in msg and "run again later" in msg,
          "message tells the user: usually temporary, a permanently failing id is removed from the universe")

reset()
import requests
def _bad(ids, n):
    resp = requests.Response(); resp.status_code = 400
    raise requests.HTTPError("400 unknown symbol", response=resp)
d._retry_get = fake(_bad)
try:
    run(IDS[:5])
    check(False, "4xx raises")
except d.BatchIncomplete:
    check(False, "4xx raises at once as HTTPError, not as a quota-style BatchIncomplete")
except requests.HTTPError:
    check(len(calls) == 1, f"4xx raises at once as HTTPError, no retry ({len(calls)} calls)")

reset()
d._retry_get = fake(lambda ids, n: _R({"data": {}, "failed": list(ids)}))
try:
    run(IDS)
    check(False, "everything failing → raises")
except d.BatchIncomplete as e:
    check(len(e.failed) == 60 and len(calls) == 2 + 3,
          f"retry gives up after 3 dead requests instead of sending all 6 ({len(calls)} calls)")

reset()
d._retry_get = fake(lambda ids, n: _R({"data": {s: [{"cash_ex_date": "2024-07-01", "stock_ex_date": "", "record_date": "2024-07-01", "cash": 1.0, "stock": 0.0}]
                                                for s in ids if s != "2454"},
                                       "failed": [s for s in ids if s == "2454"]}))
try:
    d.fetch_twstock_dividend_batch(["2330", "2454"], "2024-01-01", "2024-12-31", {})
    check(False, "dividend batch: persistent failure raises")
except d.BatchIncomplete as e:
    check(e.failed == ["2454"] and "2330" in e.partial and len(calls) == 2,
          f"dividend batch: one retry, then BatchIncomplete with 2330 in .partial ({len(calls)} calls)")

shutil.rmtree(TMP, ignore_errors=True)
print(f"\n{'all pass' if not fails else f'{fails} FAILED'}")
sys.exit(1 if fails else 0)
