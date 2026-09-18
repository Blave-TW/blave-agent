"""Minimal check for fetch_twstock_market_value_all in lib/data.py — no network.
The `market` / `is_etf` columns and the attrs['twse_ex_etf_market_value'] denominator must
reach the caller whatever the local pandas does: the denominator must not shrink when `top`
slices, and a cache hit missing any of the four (old cache file, or a pandas whose parquet
writer drops DataFrame.attrs) must be refetched rather than served short.
Run: cd blave-agent && .venv/bin/python tests/check_market_value_all_fields.py
"""
import os, sys, tempfile
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import pandas as pd
from pathlib import Path
from lib import data as d

fails = 0
def check(cond, msg):
    global fails
    print(("  PASS  " if cond else "  FAIL  ") + msg); fails += (not cond)

PAYLOAD = {
    'date': '2026-09-17',
    'twse_ex_etf_market_value': 150952470507848,
    'data': [
        {'is_etf': False, 'market': 'TWSE', 'market_value': 62885997412475, 'name': '台積電',
         'rank': 1, 'stock_id': '2330'},
        {'is_etf': False, 'market': 'TPEx', 'market_value': 500000000000, 'name': '某上櫃',
         'rank': 2, 'stock_id': '6488'},
        {'is_etf': True, 'market': 'TWSE', 'market_value': 2383312875000,
         'name': '元大台灣50', 'rank': 3, 'stock_id': '0050'},
    ],
}

class Resp:
    status_code = 200
    def json(self): return PAYLOAD
    def raise_for_status(self): pass

calls = []
d._retry_get = lambda url, **kw: (calls.append(url), Resp())[1]

with tempfile.TemporaryDirectory() as tmp:
    d._CACHE_DIR = Path(tmp)
    df = d.fetch_twstock_market_value_all({})
    check(list(df.columns) == ['rank', 'stock_id', 'name', 'market_value', 'market', 'is_etf'],
          f'columns include market and is_etf, appended last: {list(df.columns)}')
    check(df.loc[0, 'market'] == 'TWSE' and df.loc[1, 'market'] == 'TPEx',
          'market values carried through verbatim')
    check(list(df['is_etf']) == [False, False, True],
          f"is_etf per row, 0050 True: {list(df['is_etf'])}")
    check(list(df[~df['is_etf']]['stock_id']) == ['2330', '6488'],
          'the documented ETF filter df[~df["is_etf"]] works on the returned frame')
    check(df.attrs['twse_ex_etf_market_value'] == 150952470507848,
          'denominator in attrs')

    # cache hit: no second call, both new fields still there
    calls.clear()
    hit = d.fetch_twstock_market_value_all({}, top=1)
    check(calls == [], 'second call within the hour is served from cache')
    check(len(hit) == 1 and list(hit.columns)[-2:] == ['market', 'is_etf'],
          'sliced frame keeps the market and is_etf columns')
    check(hit.attrs['twse_ex_etf_market_value'] == 150952470507848,
          'top slicing does not shrink the whole-market denominator')
    # the widget filter runs on a cache-hit frame, so the bool dtype must survive parquet
    warm = d.fetch_twstock_market_value_all({})
    check(list(warm[~warm['is_etf']]['stock_id']) == ['2330', '6488'],
          'df[~df["is_etf"]] still works after the parquet cache round-trip')

    # A cache hit is only usable with the column AND both attrs. Three shapes to reject:
    # the pre-`market` file, a pandas that dropped attrs entirely, and one that kept only
    # `date` (the shape an older parquet writer leaves behind).
    cols = ['rank', 'stock_id', 'name', 'market_value', 'market', 'is_etf']
    full = pd.DataFrame(PAYLOAD['data'])[cols]
    for label, frame, attrs in (
            ('pre-`market` cache file', full[cols[:4]], {'date': '2026-09-16'}),
            ('cache file with market but no is_etf', full[cols[:5]], {'date': '2026-09-16'}),
            ('cache hit with no attrs at all', full, {}),
            ('cache hit with date but no denominator', full, {'date': '2026-09-16'})):
        stale = frame.copy()
        stale.attrs = dict(attrs)
        d._save_fundamental_cache(d._CACHE_DIR / 'twstock_market_value_all.parquet', stale)
        calls.clear()
        fixed = d.fetch_twstock_market_value_all({})
        check(len(calls) == 1, f'{label} triggers a refetch')
        check({'market', 'is_etf'} <= set(fixed.columns)
              and fixed.attrs.get('date') == '2026-09-17'
              and fixed.attrs.get('twse_ex_etf_market_value') == 150952470507848,
              f'{label}: refetch restores both columns and both attrs')

    # A genuinely null denominator must NOT loop: the key is present, so the cache is usable.
    PAYLOAD['twse_ex_etf_market_value'] = None
    (d._CACHE_DIR / 'twstock_market_value_all.parquet').unlink()
    cold = d.fetch_twstock_market_value_all({})
    calls.clear()
    warm = d.fetch_twstock_market_value_all({})
    check(cold.attrs['twse_ex_etf_market_value'] is None and calls == [],
          'a null denominator is cached, not refetched every call')
    PAYLOAD['twse_ex_etf_market_value'] = 150952470507848

print('FAILED' if fails else 'ALL PASS')
sys.exit(1 if fails else 0)
