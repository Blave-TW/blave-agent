"""Minimal check for the future-window short-circuit in _extend_cache_single — no network.

"Give me data for a date that has not happened yet" is a legitimate question (forward
settlement date, scheduled backfill span) whose answer is an empty frame, not an error.
Because the upper bound is computed locally the lib can tell that apart from a reversed
range; the API cannot, so it would 400. Two things must still reach the API: a caller who
passed `end` explicitly and got the order backwards (a typo they should read), and a
malformed `start` (the 400 names the format).

The cut-off is Taipei's, not the machine's — the boxes run UTC, 8 h behind — so the
cross-midnight window (UTC 23:30 = Taipei 07:30 next day) is checked on frozen time.
Run: cd blave-agent && .venv/bin/python tests/check_future_window_no_fetch.py
"""
import os, sys, tempfile
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
# The subject is the Blave single-file layout; the key-free exchange path in front of it
# (tests/check_tw_free_daily.py) is pinned off so nothing here can reach twse.com.tw.
os.environ['BLAVE_TWSTOCK_DAILY_SOURCE'] = 'blave'
from datetime import datetime as _dt, timedelta, timezone
from pathlib import Path
import pandas as pd
import requests
from lib import data as d

fails = 0
def check(cond, msg):
    global fails
    print(("  PASS  " if cond else "  FAIL  ") + msg); fails += (not cond)

calls = []
served = {'status': 400, 'body': '{"error": "start must not be after end"}'}

def _resp(status, body):
    r = requests.Response()
    r.status_code = status
    r.url = 'https://api.blave.org/studio/market/twstock/price/2330'
    r._content = body.encode()
    return r

def fake_get(url, **kw):
    calls.append(kw.get('params'))
    return _resp(served['status'], served['body'])

d.requests.get = fake_get


def frozen(utc_iso):
    """datetime shim pinned to one instant; strptime/timedelta arithmetic stay real."""
    fixed = _dt.fromisoformat(utc_iso).replace(tzinfo=timezone.utc)

    class _Frozen(_dt):
        @classmethod
        def utcnow(cls):
            return fixed.replace(tzinfo=None)

        @classmethod
        def now(cls, tz=None):
            return fixed.astimezone(tz) if tz else fixed.replace(tzinfo=None)
    return _Frozen


def run_case(label, utc_iso, start, end, expect_empty, expect_calls):
    orig_dt = d.datetime
    d.datetime = frozen(utc_iso)
    try:
        with tempfile.TemporaryDirectory() as tmp:
            d._CACHE_DIR = Path(tmp)
            calls.clear()
            out = d.fetch_twstock_price('2330', start, end, {})
            ok = isinstance(out, pd.DataFrame) and out.empty == expect_empty
            check(ok and len(calls) == expect_calls,
                  f'{label}: empty={out.empty} calls={len(calls)} '
                  f'(want empty={expect_empty} calls={expect_calls})')
    finally:
        d.datetime = orig_dt


# ── the cross-midnight window: UTC 2026-09-18 23:30 = Taipei 2026-09-19 07:30 ──
# The bound is Taipei tomorrow, inclusive: anything up to it still asks the API (the
# conservative direction — a needless call beats a silent empty), past it is short-
# circuited. 09-20 is the one that bites: on a UTC-based bound (tomorrow_utc = 09-19)
# it would have been swallowed as "future" while Taipei still had a day to go.
served['status'], served['body'] = 200, '{"data": []}'
run_case('Taipei today is not the future (UTC 23:30, Taipei next day)',
         '2026-09-18T23:30:00', '2026-09-19', None, expect_empty=True, expect_calls=1)
run_case('Taipei tomorrow still fetches — a UTC bound would have swallowed it',
         '2026-09-18T23:30:00', '2026-09-20', None, expect_empty=True, expect_calls=1)
run_case('past Taipei tomorrow short-circuits',
         '2026-09-18T23:30:00', '2026-09-21', None, expect_empty=True, expect_calls=0)
# the same three with no UTC/Taipei date skew, to show the rule reads the same either side
run_case('no skew: today fetches',
         '2026-09-18T08:00:00', '2026-09-18', None, expect_empty=True, expect_calls=1)
run_case('no skew: tomorrow fetches',
         '2026-09-18T08:00:00', '2026-09-19', None, expect_empty=True, expect_calls=1)
run_case('no skew: day after tomorrow short-circuits',
         '2026-09-18T08:00:00', '2026-09-20', None, expect_empty=True, expect_calls=0)

# ── end=None + far-future start: empty frame, upstream untouched ──────────────
FUTURE = (_dt.now(timezone.utc) + timedelta(days=400)).strftime('%Y-%m-%d')
with tempfile.TemporaryDirectory() as tmp:
    d._CACHE_DIR = Path(tmp)
    served['status'], served['body'] = 400, '{"error": "start must not be after end"}'
    calls.clear()
    out = d.fetch_twstock_price('2330', FUTURE, None, {})
    check(isinstance(out, pd.DataFrame) and out.empty, 'future start returns an empty frame')
    check(calls == [], f'future start makes zero upstream calls: {calls}')

    # the monthly layout answers a reversed range the same way — same empty-frame
    # shape (a bare DataFrame, not None), also without calling. Driven directly:
    # every twstock_* dataset is on the single-file layout, so there is no public
    # twstock fetcher left that exercises the monthly branch.
    monthly_calls = []
    monthly = d._extend_cache_monthly(
        'zz_layout_shape_probe', {'id': '2330'},
        lambda s, e: monthly_calls.append((s, e)) or pd.DataFrame(),
        '2026-12-01', '2026-01-01')
    check(isinstance(monthly, pd.DataFrame) and monthly.empty and monthly_calls == [],
          'monthly layout: same empty-frame shape, no call')

    # ── caller supplied `end` and got the order wrong → still a 400 they can read ──
    calls.clear()
    try:
        d.fetch_twstock_price('2330', FUTURE, '2026-01-05', {})
        check(False, 'explicit reversed range raised')
    except requests.HTTPError as exc:
        check('start must not be after end' in str(exc),
              f'explicit reversed range still 400s: {exc}')
        check(len(calls) == 1, 'and it did reach the API exactly once')

    # ── a malformed start is not a future window: the API must name the format ──
    served['body'] = '{"error": "Invalid start date, expected YYYY-MM-DD"}'
    calls.clear()
    try:
        d.fetch_twstock_price('2330', '2027/01/01', None, {})
        check(False, 'malformed start raised')
    except requests.HTTPError as exc:
        check('expected YYYY-MM-DD' in str(exc), f'malformed start still reaches the API: {exc}')

print('FAILED' if fails else 'ALL PASS')
sys.exit(1 if fails else 0)
