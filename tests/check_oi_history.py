"""Minimal check for fetch_open_interest_history in lib/data.py — no network, no key.

The monthly cache asks for whole months (from the 1st), and the api answers 400 when a window
starts before the exchange's first bucket — so a Gate fetch from its documented first day
(2026-03-28) used to go out as 2026-03-01 and fail. Every request must be moved up to the
exchange's start; 400 / 404 must raise on the first call (a bad argument / an unlisted coin is
an answer), 503 must be retried and then raise.
Run: cd blave-agent && .venv/bin/python tests/check_oi_history.py
"""
import json
import os
import sys
import tempfile
import time
from pathlib import Path
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import requests
from lib import data as d

fails = 0
def check(cond, msg):
    global fails
    print(("  PASS  " if cond else "  FAIL  ") + msg); fails += (not cond)

d.time.sleep = lambda s: None
HDRS = {'api-key': 'k', 'secret-key': 's'}

def _resp(status, body):
    r = requests.Response()
    r.status_code = status
    r.url = 'https://api.blave.org/oi_imbalance/get_history'
    r._content = json.dumps(body).encode()
    return r

calls = []
def serve(answer):
    def fake_get(url, **kw):
        calls.append(kw.get('params') or {})
        return answer
    calls.clear()
    d.requests.get = fake_get

OK = _resp(200, {'data': {'timestamp': [1774656000.0, 1774742400.0], 'alpha': [1.5, '2.5'],
                          'close': [1.0, 1.0], 'exchanges': ['gate']}})

with tempfile.TemporaryDirectory() as tmp:
    d._CACHE_DIR = Path(tmp)

    serve(OK)
    df = d.fetch_open_interest_history('BTC', '1d', '2026-03-28', '2026-04-02', HDRS, exchange='gate')
    first = calls[0] if calls else {}
    check(first.get('start_date') == '2026-03-28', f"gate request moved up to its first day: {first.get('start_date')}")
    check(first.get('oi_exchange') == 'gate', f"oi_exchange sent: {first.get('oi_exchange')}")
    check(list(df.columns) == ['alpha'] and list(df['alpha']) == [1.5, 2.5], f"alpha column: {df.to_dict('list')}")
    check(str(df.index[0]) == '2026-03-28 00:00:00', f'UTC index at the bucket start: {df.index[0]}')

    serve(OK)
    d.fetch_open_interest_history('BTCUSDT', '1d', '2021-01-01', '2021-12-05', HDRS)
    sent = [c.get('start_date') for c in calls]
    check(sent and min(sent) == '2021-12-01', f'binance start moved up to 2021-12-01: {sent}')
    check(all('oi_exchange' not in c for c in calls), 'default exchange not sent')

    check(d._OI_HISTORY_START == {'binance': '2021-12-01', 'bybit': '2025-08-21', 'gate': '2026-03-28'},
          f'exchange floors: {d._OI_HISTORY_START}')

    serve(OK)
    d.fetch_open_interest_history('BTC', '1d', '2026-03-28', '2026-04-02', HDRS, exchange='Gate')
    check(not calls, f"'Gate' served from the 'gate' cache ({len(calls)} calls)")
    d._CACHE_DIR = Path(tmp) / 'fresh'
    d.fetch_open_interest_history('BTC', '1d', '2026-03-28', '2026-04-02', HDRS, exchange='Gate')
    check(calls and calls[0].get('start_date') == '2026-03-28' and calls[0].get('oi_exchange') == 'gate',
          f"'Gate' lower-cased: floor applied, oi_exchange sent as gate: {calls[:1]}")
    d._CACHE_DIR = Path(tmp)
    dirs = sorted(p.name for p in Path(tmp).iterdir() if p.name != 'fresh')
    check(dirs == ['oi_history_1d_BTCUSDT', 'oi_history_gate_1d_BTC'], f'oi_history_* cache dirs, none for Gate: {dirs}')

    serve(OK)
    df = d.fetch_open_interest_history('BTC', '1d', '2021-01-01', '2021-06-01', HDRS)
    check(df.empty and not calls, f'window wholly before binance history: empty, {len(calls)} calls')

    # an empty past month is a marker, re-checked once it is older than 24 h
    serve(_resp(200, {'data': {'timestamp': [], 'alpha': []}}))
    d.fetch_open_interest_history('ETH', '1d', '2026-05-01', '2026-05-03', HDRS)
    marker = Path(tmp) / 'oi_history_1d_ETH' / '2026-05.parquet'
    check(marker.exists() and len(calls) == 1, f'empty month cached as a marker ({len(calls)} call)')
    d.fetch_open_interest_history('ETH', '1d', '2026-05-01', '2026-05-03', HDRS)
    check(len(calls) == 1, f'fresh marker not re-fetched ({len(calls)} calls)')
    old = time.time() - 25 * 3600
    os.utime(marker, (old, old))
    d.fetch_open_interest_history('ETH', '1d', '2026-05-01', '2026-05-03', HDRS)
    check(len(calls) == 2, f'marker older than 24 h re-fetched ({len(calls)} calls)')

    for status, body in ((400, {'error': 'period must be at least 5min, in min / h / d units'}),
                         (404, {'error': 'DOGE is not a collected symbol on gate'})):
        serve(_resp(status, body))
        try:
            d.fetch_open_interest_history('DOGE', '1w', '2026-05-01', '2026-05-03', HDRS, exchange='gate')
            check(False, f'{status} raised')
        except requests.HTTPError as exc:
            check(exc.response.status_code == status and len(calls) == 1 and body['error'] in str(exc),
                  f'{status} raised on the first call with its body ({len(calls)} call)')

    serve(_resp(503, {'error': 'gate open interest data unavailable for BTC'}))
    try:
        d.fetch_open_interest_history('BTC', '1h', '2026-06-01', '2026-06-02', HDRS, exchange='gate')
        check(False, '503 raised')
    except requests.HTTPError as exc:
        check(exc.response.status_code == 503 and len(calls) > 1, f'503 retried then raised ({len(calls)} calls)')

print('\nall passed' if not fails else f'\n{fails} FAILED')
sys.exit(1 if fails else 0)
