"""Minimal check for _fetch_alpha_raw in lib/data.py — no network.

One ReadTimeout used to kill the whole strategy round (uid 8232, eth_ti_1h); the
chunk fetch must now retry transients, still fail fast on 403, and still raise
once the retries are spent instead of parsing a 5xx body.
Run: cd blave-agent && .venv/bin/python tests/check_fetch_alpha_retry.py
"""
import os, sys
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import json
import requests
from lib import data as d

fails = 0
def check(cond, msg):
    global fails
    print(("  PASS  " if cond else "  FAIL  ") + msg); fails += (not cond)

d.time.sleep = lambda s: None

def _resp(status, body):
    r = requests.Response()
    r.status_code = status
    r.url = 'https://api.blave.org/x/get_alpha'
    r._content = json.dumps(body).encode()
    return r

calls = []
def serve(*answers):
    seq = list(answers)
    def fake_get(url, **kw):
        calls.append(url)
        a = seq.pop(0) if len(seq) > 1 else seq[0]
        if isinstance(a, Exception):
            raise a
        return a
    calls.clear()
    d.requests.get = fake_get

ARGS = ('taker_intensity/get_alpha', {'symbol': 'ETHUSDT', 'period': '1h'}, {}, '2026-09-01', '2026-09-02')
OK = _resp(200, {'data': {'timestamp': [1788220800, 1788224400], 'alpha': [0.5, '-1.25']}})

serve(requests.exceptions.ReadTimeout('read timed out'), OK)
try:
    df = d._fetch_alpha_raw(*ARGS)
    check(len(calls) == 2, f'ReadTimeout retried once ({len(calls)} calls)')
    check(list(df['alpha']) == [0.5, -1.25], f'alpha values intact: {list(df["alpha"])}')
    check(str(df.index[0]) == '2026-09-01 00:00:00+00:00' and df.index.is_monotonic_increasing,
          f'utc time index: {df.index[0]}')
except Exception as exc:
    check(False, f'ReadTimeout then 200 should succeed, raised {type(exc).__name__}: {exc}')

serve(_resp(403, {'error': 'invalid api key'}))
try:
    d._fetch_alpha_raw(*ARGS)
    check(False, '403 raised')
except requests.HTTPError as exc:
    check(exc.response.status_code == 403 and len(calls) == 1, f'403 raised after {len(calls)} call(s)')

serve(_resp(503, {'error': 'upstream busy'}))
try:
    d._fetch_alpha_raw(*ARGS)
    check(False, 'persistent 503 raised')
except requests.HTTPError as exc:
    check(exc.response.status_code == 503 and len(calls) == 3,
          f'503 raised HTTPError after {len(calls)} calls (capped at 3)')

print('FAILED' if fails else 'ALL PASS')
sys.exit(1 if fails else 0)
