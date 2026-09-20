"""Minimal check for fetch_liquidation_coin in lib/data.py — no network, no key.

The fixture's top-level keys are copied from api/tests/check_liquidation_coin.py's SHAPE; the
window / exchange / point field sets are written out here by hand against the api implementation
(`api/crypto/liquidation/coin.py`), so drift in those three levels is caught only if someone
updates both sides — the top level is the one that is really chained.
404 → None (uncollected symbol is an answer, not an error); 503 → raises after _retry_get's
backoff (upstream feed silent — 0 is not "unknown"); 200 → the `data` dict untouched.
Run: cd blave-agent && .venv/bin/python tests/check_liquidation_coin.py
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
SHAPE = {"symbol", "rank", "updated_at", "windows", "exchanges", "detail_complete", "series"}
WINDOW_KEYS = {"covered_hours", "total_liq_usd", "long_liq_usd", "short_liq_usd",
               "long_pct", "short_pct", "by_exchange"}
EXCHANGE_KEYS = {"exchange", "listed", "last_event_at", "price_basis", "coverage", "time_basis"}
POINT_KEYS = {"ts", "long_liq_usd", "short_liq_usd"}


def window(total):
    return {"covered_hours": 1.0, "total_liq_usd": total, "long_liq_usd": total * 0.6,
            "short_liq_usd": total * 0.4, "long_pct": 0.6, "short_pct": 0.4,
            "by_exchange": {"binance": {"total_liq_usd": total, "long_liq_usd": total * 0.6,
                                        "short_liq_usd": total * 0.4}}}


PAYLOAD = {
    "symbol": "BTC", "rank": 1, "updated_at": "2026-09-21T06:30:00+00:00",
    "windows": {h: window(float(int(h)) * 100) for h in ("1", "4", "12", "24")},
    "exchanges": [{"exchange": "binance", "listed": True, "last_event_at": "2026-09-21T06:30:00+00:00",
                   "price_basis": "trade_avg", "coverage": "sampled_1s", "time_basis": "event"}],
    "detail_complete": True,
    "series": {"bucket_seconds": 3600,
               "points": [{"ts": f"2026-09-20T{h:02d}:00:00+00:00", "long_liq_usd": 1.0, "short_liq_usd": 2.0}
                          for h in range(24)]},
}

# the fixture itself must match the api-side SHAPE, or the checks below prove nothing
check(set(PAYLOAD) == SHAPE and set(PAYLOAD["windows"]) == {"1", "4", "12", "24"}
      and all(set(w) == WINDOW_KEYS for w in PAYLOAD["windows"].values())
      and all(set(e) == EXCHANGE_KEYS for e in PAYLOAD["exchanges"])
      and len(PAYLOAD["series"]["points"]) == 24
      and all(set(p) == POINT_KEYS for p in PAYLOAD["series"]["points"]),
      'fixture mirrors api/tests/check_liquidation_coin.py SHAPE')

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

d.time.sleep = lambda s: None  # 503 backoff would otherwise take ~2 minutes

serve(200, json.dumps({"data": PAYLOAD}))
calls.clear()
out = d.fetch_liquidation_coin('BTC', HDRS)
check(out == PAYLOAD, '200 → the data dict, untouched')
check(calls == [(f'{d.BASE}/liquidation/get_coin', {'symbol': 'BTC'}, HDRS)],
      f'one GET to /liquidation/get_coin with symbol + headers: {calls}')

serve(404, '{"error": "ABCD is not a collected symbol"}')
calls.clear()
check(d.fetch_liquidation_coin('ABCD', HDRS) is None, '404 (uncollected symbol) → None, no raise')
check(len(calls) == 1, '404 is not retried')

serve(503, '{"error": "liquidation data unavailable"}')
calls.clear()
try:
    d.fetch_liquidation_coin('BTC', HDRS)
    check(False, '503 raised')
except requests.HTTPError as exc:
    check(exc.response.status_code == 503, '503 (upstream silent) raises HTTPError, not None / {}')
    check(len(calls) > 1, f'503 was retried before raising ({len(calls)} attempts)')

serve(400, '{"error": "symbol is required"}')
try:
    d.fetch_liquidation_coin('', HDRS)
    check(False, '400 raised')
except requests.HTTPError as exc:
    check(exc.response.status_code == 400 and 'symbol is required' in str(exc),
          '400 raises with the server reason (only 404 is swallowed)')

print('FAILED' if fails else 'ALL PASS')
sys.exit(1 if fails else 0)
