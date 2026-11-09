"""Minimal check for the Taiwan endpoint wrappers in lib/data.py — no network.

  1. The 31-day-capped endpoints (gov_bank, news) split a longer span into consecutive
     windows the api accepts (end − start ≤ 31 days), with no day skipped or asked twice; a
     reversed range or one over a year raises before any request.
  2. Long-format tables keep every row of a date (a dedup on the date index would drop
     two of the three large-trader rows per day).
  3. fetch_twfutures_daily maps TXF → TX and sends aggregate=1 only when asked.
  4. fetch_twstock_screener POSTs its body through the retrying helper (a 503 is retried; the
     last one's body, e.g. themes_unavailable, reaches the exception).
  5. fetch_twstock_market_value goes through the one-file cache: a second call for the same
     span does not ask again.
  6. Theme / chip-breadth frames keep a theme's {zh,en,cn} name intact, send the right query,
     refuse a bad scope / range locally; margin maintenance lands in the one-file cache.
  7. The retail long/short ratio history maps MXF → MTX, sends only start / end, keeps the
     api's oldest-first rows on a date index; an empty range is an empty frame with the schema.
Run: cd blave-agent && .venv/bin/python tests/check_tw_endpoint_wrappers.py
"""
import json
import os
import sys
import tempfile
from datetime import date
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import requests
from lib import data as d

fails = 0


def check(cond, msg):
    global fails
    print(("  PASS  " if cond else "  FAIL  ") + msg)
    fails += (not cond)


calls = []
answers = {}


def _resp(status, body):
    r = requests.Response()
    r.status_code = status
    r._content = json.dumps(body).encode()
    return r


def fake(method):
    def send(url, **kw):
        calls.append((method, url, dict(kw.get('params') or {}), kw.get('json')))
        queue = answers.get(url.split('/studio/market/')[-1])
        status, body = queue.pop(0) if isinstance(queue, list) else (200, queue or {'data': []})
        return _resp(status, body)
    return send


d.requests.get = fake('get')
d.requests.post = fake('post')
d.time.sleep = lambda s: None

# ── 1. capped windows ────────────────────────────────────────────────────────
calls.clear()
d.fetch_twstock_gov_bank('2330', '2026-01-01', '2026-03-15', {})
spans = [(date.fromisoformat(p['start']), date.fromisoformat(p['end'])) for _, _, p, _ in calls]
check(all((e - s).days <= 31 for s, e in spans), f'every window within the api cap: {spans}')
check(spans[0][0] == date(2026, 1, 1) and spans[-1][1] == date(2026, 3, 15), 'windows cover start..end')
check(all((b[0] - a[1]).days == 1 for a, b in zip(spans, spans[1:])), 'windows are consecutive, no overlap')
for args, why in ((('2026-03-01', '2026-02-01'), 'start after end'),
                  (('2025-01-01', '2026-01-05'), 'a span over a year')):
    calls.clear()
    try:
        d.fetch_twstock_gov_bank('2330', *args, {})
        check(False, f'{why} raises')
    except ValueError as e:
        check(not calls, f'{why} raises ValueError before any request: {e}')
calls.clear()
d.fetch_twstock_news('2330', None, None, {})
check(len(calls) == 1 and calls[0][2] == {}, f'start None = one request, api default window: {calls}')
calls.clear()
d.fetch_twstock_gov_bank('2330', None, '2026-06-30', {})
check([c[2] for c in calls] == [{'start': '2026-06-24', 'end': '2026-06-30'}],
      f'start None with an end = the 7 days up to it, never a reversed range: {calls}')

answers['twstock/news/2330'] = {'data': [
    {'date': '2026-11-02 09:04:00', 'stock_id': '2330', 'title': 'a', 'source': 's', 'link': 'l'}]}
df = d.fetch_twstock_news('2330', '2026-11-01', '2026-11-03', {})
check(str(df.index[0]) == '2026-11-02 09:04:00' and df.index.name == 'date', f'news index = publication time: {df.index}')

# ── 2. long format keeps every row of a date ─────────────────────────────────
rows = [{'date': '2026-11-05', 'futures_id': 'TX', 'contract_type': t, 'market_open_interest': 1}
        for t in ('week', '202611', 'all')]
answers['twfutures/large_traders/TX'] = {'futures_id': 'TX', 'data': rows}
calls.clear()
lt = d.fetch_twfutures_large_traders('txf', '2026-11-01', None, {})
check(len(lt) == 3 and list(lt['contract_type']) == ['week', '202611', 'all'], f'three rows on one date kept: {len(lt)}')
check(calls[0][1].endswith('/large_traders/TX') and calls[0][2] == {'start': '2026-11-01'},
      f'TXF → TX, end None not sent: {calls[0]}')
empty = d.fetch_twoption_institutional('TXO', '2026-11-01', '2026-11-02', {})
check(empty.empty and isinstance(empty.index, d.pd.DatetimeIndex), 'empty answer = empty date-indexed frame')
check('long_open_interest_balance_volume' in empty.columns, f'empty answer keeps the columns: {list(empty.columns)}')
gb = d.fetch_twstock_gov_bank('9999', '2026-01-01', '2026-01-02', {})
check(gb.empty and list(gb.columns)[:2] == ['stock_id', 'bank_name'], 'empty windowed answer keeps the columns too')

# ── 3. futures daily aggregate flag ──────────────────────────────────────────
calls.clear()
d.fetch_twfutures_daily('TXF', '2026-10-01', '2026-10-31', {})
d.fetch_twfutures_daily('MXF', '2026-10-01', '2026-10-31', {}, aggregate=True)
check('aggregate' not in calls[0][2] and calls[0][1].endswith('/daily/TX'), f'raw by default: {calls[0]}')
check(calls[1][2].get('aggregate') == '1' and calls[1][1].endswith('/daily/MTX'), f'aggregate=1 when asked: {calls[1]}')

# ── 4. screener POST with retry ──────────────────────────────────────────────
answers['twstock/screener/run'] = [(503, {'error': 'busy'}),
                                   (200, {'as_of': '2026-11-06', 'dates': {}, 'total': 1, 'columns': [],
                                          'sort': {'indicator': 'per', 'dir': 'asc'},
                                          'rows': [{'stock_id': '2330', 'per': 20.1}]})]
calls.clear()
flt = [{'indicator': 'per', 'operator_id': 2, 'value': 25}]
sc = d.fetch_twstock_screener({}, filters=flt, sort={'indicator': 'per', 'dir': 'asc'}, limit=50)
check([c[0] for c in calls] == ['post', 'post'], f'POST, retried once after 503: {[c[0] for c in calls]}')
check(calls[-1][3] == {'filters': flt, 'include_types': [], 'limit': 50, 'sort': {'indicator': 'per', 'dir': 'asc'}},
      f'body as documented: {calls[-1][3]}')
check(list(sc['stock_id']) == ['2330'] and sc.attrs['total'] == 1 and sc.attrs['as_of'] == '2026-11-06',
      'rows + attrs')

answers['twstock/screener/run'] = [(503, {'error': 'themes_unavailable'})] * 6
try:
    d.fetch_twstock_screener({}, filters=flt)
    check(False, 'exhausted 503 raises')
except requests.HTTPError as e:
    check('themes_unavailable' in str(e), f'last 5xx carries the body: {e}')

# ── 5. market value through the one-file cache ───────────────────────────────
answers['twstock/market_value/2330'] = {'stock_id': '2330', 'data': [
    {'date': '2025-01-02', 'stock_id': '2330', 'market_value': 27000000000000},
    {'date': '2025-01-03', 'stock_id': '2330', 'market_value': 27500000000000}]}
with tempfile.TemporaryDirectory() as tmp:
    d._CACHE_DIR = Path(tmp)
    calls.clear()
    mv = d.fetch_twstock_market_value('2330', '2025-01-01', '2025-01-31', {})
    first = len(calls)
    mv2 = d.fetch_twstock_market_value('2330', '2025-01-01', '2025-01-31', {})
    check(list(mv.columns) == ['market_value'] and len(mv) == 2, f'one column, two rows: {mv}')
    check(first >= 1 and len(calls) == first, f'second call served from cache ({first} → {len(calls)} requests)')
    check(mv2.equals(mv), 'cached frame equals the fetched one')
    check(Path(tmp, 'twstock_mv_2330.parquet').exists(), 'single-file layout')

# ── 6. themes / chip breadth / margin maintenance ────────────────────────────
answers['twstock/theme/overview'] = {'date': '2026-11-06', 'summary': {'up': 0}, 'themes': [
    {'slug': 'ai', 'name': {'zh': 'AI', 'en': 'AI', 'cn': 'AI'}, 'count': 12,
     'returns': {'d1': -4.84, 'd20': -20.32}, 'top5': [{'stock_id': '2317', 'name': '鴻海'}]}]}
calls.clear()
th = d.fetch_twstock_theme_overview({}, window=10)
check(calls[0][2] == {'window': 10} and th.index.tolist() == ['ai'], f'theme overview by slug: {calls[0]}')
check(th.loc['ai', 'name'] == {'zh': 'AI', 'en': 'AI', 'cn': 'AI'} and 'returns.d20' in th.columns,
      f'name kept as the {{zh,en,cn}} dict, the rest flattened: {list(th.columns)}')
check(th.attrs['date'] == '2026-11-06' and 'themes' not in th.attrs, 'payload fields ride in attrs')
answers['twstock/chip_breadth/sector'] = {'as_of': '2026-11-06', 'groups': [
    {'slug': 'shipping', 'name': '航運', 'total': 28, 'foreign': {'buy': 24, 'ratio': 85.7, 'gap': 26, 'rank': 2},
     'trust': {'buy': 7, 'ratio': 25.0, 'gap': 0, 'rank': 12}}]}
calls.clear()
cb = d.fetch_twstock_chip_breadth('sector', {}, window=60, inst='trust')
check(calls[0][2] == {'window': 60, 'inst': 'trust'} and cb.loc['shipping', 'foreign.gap'] == 26
      and cb.loc['shipping', 'name'] == '航運', f'chip breadth params + flattened groups: {list(cb.columns)}')
for bad in (lambda: d.fetch_twstock_chip_breadth('industry', {}), lambda: d.fetch_twstock_theme_index('ai', {}, range='5y')):
    try:
        bad()
        check(False, 'bad scope / range raises')
    except ValueError:
        check(True, 'bad scope / range raises ValueError locally')
answers['twstock/theme/ai/index'] = {'base_date': '2026-10-14', 'points': [
    {'date': '2026-10-14', 'value': 100.0, 'taiex': 100.0, 'tpex': 100.0, 'is_backfill': False, 'n': 12,
     'snapshot_ym': '2026-10'}]}
ti = d.fetch_twstock_theme_index('ai', {}, range='1y')
check(isinstance(ti.index, d.pd.DatetimeIndex) and ti.attrs['base_date'] == '2026-10-14', 'theme index by date')
answers['twstock/theme/constituents/gone'] = [(503, {'error': 'not_yet_effective'})] * 6
try:
    d.fetch_twstock_theme_constituents('gone', {})
    check(False, 'exhausted 503 raises')
except requests.HTTPError as e:
    check('not_yet_effective' in str(e), f'theme 5xx carries the body: {e}')
answers['twmarket/margin_maintenance'] = {'data': [{'date': '2026-11-05', 'maintenance_ratio': 155.741},
                                                   {'date': '2026-11-06', 'maintenance_ratio': 151.93}]}
with tempfile.TemporaryDirectory() as tmp:
    d._CACHE_DIR = Path(tmp)
    mm = d.fetch_twmarket_margin_maintenance('2026-11-01', '2026-11-06', {})
    check(list(mm.columns) == ['maintenance_ratio'] and mm.iloc[-1, 0] == 151.93, f'margin maintenance: {mm}')
    check(Path(tmp, 'twmarket_margin_maint_TWSE.parquet').exists(), 'margin maintenance in the one-file cache')

# ── 7. retail long/short ratio history ───────────────────────────────────────
row = {'futures_id': 'MTX', 'market_open_interest': 96708, 'institutional_long_open_interest': 6870,
       'institutional_short_open_interest': 52454, 'retail_long_open_interest': 89838,
       'retail_short_open_interest': 44254, 'retail_long_short_ratio': 47.13570749059023}
answers['twfutures/retail_long_short_ratio/MTX/history'] = {'futures_id': 'MTX', 'data': [
    dict(row, date='2026-11-05', retail_long_short_ratio=40.5), dict(row, date='2026-11-06')]}
calls.clear()
lsr = d.fetch_twfutures_retail_long_short_ratio_history('MXF', '2026-11-01', '2026-11-07', {})
check(calls[0][1].endswith('/retail_long_short_ratio/MTX/history')
      and calls[0][2] == {'start': '2026-11-01', 'end': '2026-11-07'}, f'MXF → MTX, start / end sent: {calls[0]}')
check(isinstance(lsr.index, d.pd.DatetimeIndex) and lsr.index.strftime('%Y-%m-%d').tolist() == ['2026-11-05', '2026-11-06']
      and lsr['retail_long_short_ratio'].tolist() == [40.5, 47.13570749059023]
      and lsr.loc['2026-11-06', 'retail_long_open_interest'] == 89838, f'history rows by date, order kept: {lsr}')
answers['twfutures/retail_long_short_ratio/TMF/history'] = {'futures_id': 'TMF', 'data': []}
calls.clear()
empty = d.fetch_twfutures_retail_long_short_ratio_history('tmf', None, None, {})
check(calls[0][2] == {} and empty.empty and list(empty.columns) == d._TWFUT_RETAIL_LSR_COLUMNS
      and isinstance(empty.index, d.pd.DatetimeIndex), f'start None sends nothing; empty keeps the schema: {empty.columns}')

print('FAILED' if fails else 'ALL PASS')
sys.exit(1 if fails else 0)
