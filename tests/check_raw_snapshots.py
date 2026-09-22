"""Minimal check for the raw cross-exchange snapshot fetchers in lib/data.py — no network,
no key: long/short ratio, open interest, CVD (table + coin each) and the liquidation matrix.

The fixtures' TOP-LEVEL key sets are the ones captured live on 2026-09-22 from the anonymous
studio twins (`/studio/charts/long_short_ratio/table` …), which the api serves from the same
builder as the api-key endpoints (`api/crypto/web_routes.py` + `api/enterprise/crypto/routes.py`
both call `build_table` / `get_coin`) — that top level is what the docstrings promise and what a
strategy indexes into. Inner field sets are deliberately not mirrored here; they are checked on
the api side (`api/tests/check_long_short_ratio.py`, `check_oi_table.py`, `check_cvd.py`).

What must hold: 200 → the `data` dict untouched; coin endpoints swallow 404 (a coin no source
collects is an answer, not an error) while the TABLE endpoints do not (a 404 there is a broken
path, never "no coins"); 503 raises after _retry_get's backoff on every one of them — an empty
table would read as "nothing is happening".
Run: cd blave-agent && .venv/bin/python tests/check_raw_snapshots.py
"""
import json
import os
import sys
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import requests
from lib import data as d

fails = 0
def check(cond, msg):
    global fails
    print(("  PASS  " if cond else "  FAIL  ") + msg); fails += (not cond)

HDRS = {'api-key': 'k', 'secret-key': 's'}

# top-level shapes as captured live 2026-09-22
SHAPES = {
    'lsr_table':  {"coins", "sources", "summary", "tokens_shown", "tokens_total", "full", "updated_at"},
    'lsr_coin':   {"latest", "series", "sources", "symbol", "token_id", "updated_at"},
    'oi_table':   {"coins", "exchanges", "total", "summary", "tokens_shown", "tokens_total", "full", "updated_at"},
    'oi_coin':    {"exchanges", "windows", "series", "oi_total", "market_cap", "oi_mcap",
                   "oi_mcap_rank", "tokens_total", "symbol", "token_id", "updated_at"},
    'cvd_table':  {"coins", "exchanges", "total", "tokens_shown", "tokens_total", "full", "updated_at"},
    'cvd_coin':   {"exchanges", "windows", "series", "symbol", "token_id", "updated_at"},
    'liq_matrix': {"exchanges", "coins", "others", "total", "buckets", "covered_hours",
                   "window_hours", "window_start", "window_end", "updated_at"},
}

# (fetcher, args, shape key, endpoint, expected query params, swallows 404?)
CASES = [
    (d.fetch_long_short_ratio_table, (HDRS,),        'lsr_table',  'long_short_ratio/get_table',    None,                            False),
    (d.fetch_long_short_ratio_coin, ('BTC', HDRS),   'lsr_coin',   'long_short_ratio/get_coin',     {'symbol': 'BTC'},               True),
    (d.fetch_open_interest_table,    (HDRS,),         'oi_table',   'oi_imbalance/get_table',        None,                            False),
    (d.fetch_open_interest_coin,     ('BTC', HDRS),   'oi_coin',    'oi_imbalance/get_coin',         {'symbol': 'BTC'},               True),
    (d.fetch_cvd_table,             (HDRS,),         'cvd_table',  'taker_intensity/get_cvd_table', None,                            False),
    (d.fetch_cvd_coin,              ('BTC', HDRS),   'cvd_coin',   'taker_intensity/get_cvd_coin',  {'symbol': 'BTC'},               True),
    (d.fetch_liquidation_exchanges, (HDRS,),         'liq_matrix', 'liquidation/get_exchanges',     {'hours': 24, 'top_n': 10},      False),
]

check(len(CASES) == len(SHAPES) and {c[2] for c in CASES} == set(SHAPES),
      'every recorded shape has a fetcher and vice versa')

calls = []
def serve(status, body):
    def fake_get(url, **kw):
        calls.append((url, kw.get('params'), kw.get('headers')))
        r = requests.Response()
        r.status_code = status
        r.url = url
        r._content = body.encode()
        return r
    d.requests.get = fake_get

d.time.sleep = lambda s: None  # the 503 backoff would otherwise take ~2 minutes

for fn, args, shape_key, endpoint, params, swallows_404 in CASES:
    name = fn.__name__
    payload = {k: {} for k in SHAPES[shape_key]}

    serve(200, json.dumps({"data": payload}))
    calls.clear()
    out = fn(*args)
    check(out == payload and set(out) == SHAPES[shape_key],
          f'{name}: 200 → the data dict untouched, all {len(payload)} keys')
    check(calls == [(f'{d.BASE}/{endpoint}', params, HDRS)],
          f'{name}: one GET to /{endpoint} with {params} + headers: {calls}')

    serve(404, '{"error": "ZZZZ is not a collected symbol"}')
    calls.clear()
    if swallows_404:
        check(fn(*args) is None, f'{name}: 404 (uncollected coin) → None, no raise')
        check(len(calls) == 1, f'{name}: 404 is not retried')
    else:
        try:
            fn(*args)
            check(False, f'{name}: a 404 on a table must raise, not read as an empty table')
        except requests.HTTPError as exc:
            check(exc.response.status_code == 404, f'{name}: 404 raises (a table has no 404 answer)')

    serve(503, '{"error": "data unavailable"}')
    calls.clear()
    try:
        fn(*args)
        check(False, f'{name}: 503 raised')
    except requests.HTTPError as exc:
        check(exc.response.status_code == 503 and len(calls) > 1,
              f'{name}: 503 raises after retries ({len(calls)} attempts) — never an empty snapshot')

print('FAILED' if fails else 'ALL PASS')
sys.exit(1 if fails else 0)
