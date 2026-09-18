"""Minimal check for _retry_get in lib/data.py — no network.

A non-retried 4xx must surface the server's explanation. raise_for_status() alone
prints status + URL, so the API's "start must not be after end" never reached the
strategy author and a bad argument looked exactly like a broken endpoint.
Type and .response must stay as they were — fetch_twstock_dividend and the TXF
export path both branch on exc.response.status_code.
Run: cd blaveclaw-config && .venv/bin/python tests/check_retry_get_4xx_message.py
"""
import os, sys
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import requests
from lib import data as d

fails = 0
def check(cond, msg):
    global fails
    print(("  PASS  " if cond else "  FAIL  ") + msg); fails += (not cond)

URL = 'https://api.blave.org/studio/market/twstock/price/2330'

def _resp(status, body):
    r = requests.Response()
    r.status_code = status
    r.url = URL
    r._content = body.encode()
    return r

calls = []
def serve(status, body):
    def fake_get(url, **kw):
        calls.append(url)
        return _resp(status, body)
    d.requests.get = fake_get

serve(400, '{"error": "start must not be after end"}')
calls.clear()
try:
    d._retry_get(URL, timeout=5)
    check(False, '400 raised')
except requests.HTTPError as exc:
    check('start must not be after end' in str(exc),
          f'400 message carries the server explanation: {exc}')
    check('400' in str(exc), 'status code still in the message')
    check(exc.response is not None and exc.response.status_code == 400,
          '.response survives for callers that branch on status')
    check(len(calls) == 1, '4xx is not retried')

serve(400, '{"error": "Invalid start date, expected YYYY-MM-DD"}')
try:
    d._retry_get(URL, timeout=5)
    check(False, 'bad-date 400 raised')
except requests.HTTPError as exc:
    check('Invalid start date, expected YYYY-MM-DD' in str(exc), f'bad-date reason: {exc}')

# 404 is the shape fetch_twstock_dividend swallows — it must keep reading as 404
serve(404, '{"error": "No data"}')
try:
    d._retry_get(URL, timeout=5)
    check(False, '404 raised')
except requests.HTTPError as exc:
    check(exc.response.status_code == 404, '404 still classifiable by status')

# a body so long it would drown the message is truncated, not dropped
serve(400, '{"error": "' + 'x' * 5000 + '"}')
try:
    d._retry_get(URL, timeout=5)
    check(False, 'long-body 400 raised')
except requests.HTTPError as exc:
    check(len(str(exc)) < 400, f'body truncated, message length {len(str(exc))}')

serve(200, '{"data": []}')
calls.clear()
ok = d._retry_get(URL, timeout=5)
check(ok.status_code == 200 and calls == [URL], '2xx still returns the response unchanged')

print('FAILED' if fails else 'ALL PASS')
sys.exit(1 if fails else 0)
