"""Minimal check for the BYO (desktop) kline source in lib/data.py — no network.

Covers the two things that silently produce wrong numbers rather than an error:
the array-of-arrays → five-column conversion (a shifted index reads volume as a
price), and the startTime pager (a stuck or over-stepping cursor loses bars in
the middle of a deep 1min history, which just looks like a thinner backtest).
Plus the fleet guarantee: with BLAVE_KLINE_SOURCE unset, fetch_kline still goes
through the Blave API path.
Run: cd blave-agent && .venv/bin/python tests/check_binance_kline_adapter.py
"""
import os, sys
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
os.environ.pop('BLAVE_KLINE_SOURCE', None)
import pandas as pd
from lib import data as d

fails = 0
def check(cond, msg):
    global fails
    print(("  PASS  " if cond else "  FAIL  ") + msg); fails += (not cond)


# ── array-of-arrays → OHLCV frame ─────────────────────────────────────────────
# A real fapi row: 12 fields, prices as strings, close time / quote volume /
# taker splits after index 5. Two rows share an open time (chunk boundaries
# overlap by one bar on purpose).
def _row(open_ms, o, h, l, c, v):
    return [open_ms, o, h, l, c, v, open_ms + 59999, '1234.5', 100, '10', '20', '0']

rows = [
    _row(1704067200000, '42000.1', '42100.2', '41900.3', '42050.4', '11.5'),
    _row(1704067260000, '42050.4', '42080.0', '42000.0', '42010.0', '7.25'),
    _row(1704067200000, '42000.1', '42100.2', '41900.3', '42050.4', '11.5'),   # duplicate bar
]
df = d._binance_klines_to_df(rows)

check(list(df.columns) == ['Open', 'High', 'Low', 'Close', 'Volume'],
      f'five columns, in order — got {list(df.columns)}')
check(len(df) == 2, f'duplicate bar dropped — {len(df)} rows')
check(df.index.is_monotonic_increasing, 'index sorted')
check(str(df.index.tz) == 'UTC', f'index is tz-aware UTC — got {df.index.tz}')
check(str(df.index[0]) == '2024-01-01 00:00:00+00:00', f'open time is the index — got {df.index[0]}')
check(all(str(t) == 'float64' for t in df.dtypes), f'all float — got {dict(df.dtypes)}')
first = df.iloc[0]
check((first['Open'], first['High'], first['Low'], first['Close'], first['Volume'])
      == (42000.1, 42100.2, 41900.3, 42050.4, 11.5), 'OHLCV read off indices 1-5')
check(d._binance_klines_to_df([]).empty
      and list(d._binance_klines_to_df([]).columns) == ['Open', 'High', 'Low', 'Close', 'Volume'],
      'empty response still returns the five-column frame')


# ── startTime pager ───────────────────────────────────────────────────────────
# Fake fapi holding 2500 one-minute bars; a page is capped at 1000, same as the
# real one. Every bar must come back exactly once.
BAR_MS, N_BARS = 60_000, 2500
EPOCH_MS = 1704067200000

class _Resp:
    def __init__(self, payload): self._p = payload
    def json(self): return self._p

requests_seen = []
def fake_get(url, params, **kw):
    requests_seen.append(params['startTime'])
    lo = max(params['startTime'], EPOCH_MS)
    hi = min(params['endTime'], EPOCH_MS + (N_BARS - 1) * BAR_MS)
    page = [_row(t, '1', '2', '0.5', '1.5', '3')
            for t in range(EPOCH_MS, EPOCH_MS + N_BARS * BAR_MS, BAR_MS)
            if lo <= t <= hi][:params['limit']]
    return _Resp(page)

d._binance_get = fake_get
paged = d._fetch_binance_kline_raw('BTCUSDT', '1min', '2024-01-01', '2024-01-03')
check(len(paged) == N_BARS, f'pager returned every bar — {len(paged)} of {N_BARS}')
check(list(paged.index) == list(pd.to_datetime(
        range(EPOCH_MS, EPOCH_MS + N_BARS * BAR_MS, BAR_MS), unit='ms', utc=True)),
      'no bar lost or repeated across pages')
check(requests_seen == sorted(requests_seen) and len(set(requests_seen)) == len(requests_seen),
      f'cursor moved forward every page — {requests_seen}')
check(d._BINANCE_KLINES.startswith('https://fapi.binance.com'),
      f'USDT-M futures, not spot — {d._BINANCE_KLINES}')
try:
    d._fetch_binance_kline_raw('BTCUSDT', '1year', '2024-01-01', '2024-01-03')
    check(False, 'unsupported interval raises')
except ValueError:
    check(True, 'unsupported interval raises')


# ── the fleet never takes the new path ────────────────────────────────────────
took = []
d._fetch_kline_raw = lambda *a, **k: took.append('blave')
d._fetch_binance_kline_raw = lambda *a, **k: took.append('binance')
d._extend_cache_monthly = lambda prefix, params, fetch_raw_fn, start, end: (
    fetch_raw_fn(start, end), pd.DataFrame(columns=['Open', 'High', 'Low', 'Close', 'Volume']))[1]

check(d._kline_source() == 'blave', 'unset BLAVE_KLINE_SOURCE means the Blave API')
d.fetch_kline('BTC/USDT', '1h', '2024-01-01', None, {'api-key': 'x'})
check(took == ['blave'], f'unset → Blave API path — {took}')

took.clear()
os.environ['BLAVE_KLINE_SOURCE'] = 'binance'
d.fetch_kline('BTC/USDT', '1h', '2024-01-01', None, {'api-key': 'x'})
check(took == ['binance'], f'binance → direct path — {took}')
took.clear()
d.fetch_kline_batch(['BTC/USDT', 'ETHUSDT'], '1h', '2024-01-01', None, {})
check(took == ['binance', 'binance'], f'batch fans out per symbol — {took}')
os.environ.pop('BLAVE_KLINE_SOURCE')

print('FAILED' if fails else 'ALL PASS')
sys.exit(1 if fails else 0)
