"""Minimal check for the Taiwan broker day caches in lib/data.py — no network.
An empty API answer for a day within 3 days of today (Taipei) is NOT written, so the
next call re-fetches it; older empty days and days with rows are written as before.
Covers both _populate_broker_day_cache and _populate_trader_day_cache.
Run: cd blave-agent && .venv/bin/python tests/check_broker_day_cache_recent.py
"""
import os, sys, tempfile
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from datetime import datetime, timedelta
from pathlib import Path
from lib import data as d

fails = 0
def check(cond, msg):
    global fails
    print(("  PASS  " if cond else "  FAIL  ") + msg); fails += (not cond)

class Resp:
    status_code = 200
    def __init__(self, payload): self.payload = payload
    def json(self): return self.payload
    def raise_for_status(self): pass

today = datetime.now(d._TPE).date()
days = [today - timedelta(days=i) for i in range(10, -1, -1)]
with_rows = (today - timedelta(days=1)).isoformat()   # recent day that does have data
row = {'broker_id': '9217', 'broker_name': 'x', 'stock_id': '2330', 'price': 1.0, 'buy': 1, 'sell': 0}

calls = []
def fake_get(url, **kw):
    calls.append(kw['params'])
    return Resp({'data': [dict(row, date=with_rows)]})
d.requests.get = fake_get

for label, key, populate, path_fn in (
        ('stock', '2330', d._populate_broker_day_cache, d._broker_day_cache_path),
        ('trader', '9217', d._populate_trader_day_cache, d._trader_day_cache_path)):
    with tempfile.TemporaryDirectory() as tmp:
        d._CACHE_DIR = Path(tmp)
        calls.clear()
        populate(key, days, {}, rate_limit=1000)
        written = {x for x in days if path_fn(key, x.isoformat()).exists()}
        old_empty = [x for x in days if (today - x).days > 3]
        recent_empty = [x for x in days if (today - x).days <= 3 and x.isoformat() != with_rows]
        check(all(x in written for x in old_empty), f'{label}: empty days older than 3 days are cached')
        check(not any(x in written for x in recent_empty), f'{label}: empty days within 3 days are not cached')
        check(datetime.fromisoformat(with_rows).date() in written, f'{label}: recent day with rows is cached')
        populate(key, days, {}, rate_limit=1000)
        check(len(calls) == 2 and calls[1]['start'] == min(recent_empty).isoformat(),
              f'{label}: second call re-fetches only the uncached recent days ({calls[-1]})')

print('FAILED' if fails else 'all checks passed')
sys.exit(1 if fails else 0)
