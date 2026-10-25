"""Taiwan futures fetch must back off on 429 instead of failing the round (10-24, a cloud box:
a TW-stock strategy spent the machine's 500/5min api budget and the TXF strategy failed three
rounds in a row). _fetch_twfutures_raw now goes through _retry_get.

Fakes requests.get and time.sleep, so it runs offline and instantly:
  ① one 429, then 200 with data → rows come back;
  ② 429 on every try → raises HTTPError after exactly 6 calls;
  ③ a past month whose fetch is all 429 → _extend_cache_monthly raises and writes no parquet
     (no empty marker that would hide the month forever).

Run: cd blave-agent && python3 tests/check_twfutures_retry.py
"""
import json, os, shutil, sys, tempfile
from pathlib import Path

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
for k in ('BLAVE_DATA_ACCESS', 'BLAVE_AGENT_LOCAL', 'BLAVE_SCHEDULED_RUN'):
    os.environ.pop(k, None)
import requests  # noqa: E402
from lib import data  # noqa: E402

fails = []


def t(name, ok, got=None):
    print(("PASS  " if ok else "FAIL  ") + name + ("" if ok or got is None else f"  → {got!r}"))
    if not ok:
        fails.append(name)


def resp(status, body):
    r = requests.Response()
    r.status_code = status
    r._content = json.dumps(body).encode()
    r.url = f'{data.BASE}/studio/market/twfutures/ohlcv/TXF/1m'
    r.reason = 'Too Many Requests' if status == 429 else 'OK'
    return r


ROW = {'ts': '2026-09-02T01:00:00Z', 'open': 1, 'high': 2, 'low': 0.5, 'close': 1.5, 'volume': 10}
HEADERS = {'api-key': 'x', 'secret-key': 'y'}
real_get, real_sleep, real_cache = data.requests.get, data.time.sleep, data._CACHE_DIR
d = Path(tempfile.mkdtemp(prefix="check-twf-retry-"))


def run(statuses, fn):
    calls = []

    def fake_get(url, **kw):
        calls.append(url)
        status = statuses[min(len(calls), len(statuses)) - 1]
        return resp(status, {'data': [ROW]} if status == 200 else {'error': 'rate limited'})

    data.requests.get, data.time.sleep, data._CACHE_DIR = fake_get, (lambda s: None), d
    err, out = None, None
    try:
        out = fn()
    except Exception as e:
        err = e
    finally:
        data.requests.get, data.time.sleep, data._CACHE_DIR = real_get, real_sleep, real_cache
    return err, out, len(calls)


def raw():
    return data._fetch_twfutures_raw('TXF', '1m', '2026-09-01', '2026-09-10', HEADERS)


try:
    err, df, n = run([429, 200], raw)
    t("① 429 then 200: rows come back", err is None and df is not None and len(df) == 1, (err, df))
    t("① two calls", n == 2, n)

    err, df, n = run([429], raw)
    t("② persistent 429 raises HTTPError", isinstance(err, requests.HTTPError), err)
    t("② exactly 6 calls", n == 6, n)

    err, df, n = run([429], lambda: data._extend_cache_monthly(
        'twfretrycheck_1m_TXF', {'symbol': 'TXF'},
        lambda s, e: data._fetch_twfutures_raw('TXF', '1m', s, e, HEADERS),
        '2026-08-01', '2026-08-31', empty_marker_ttl_hours=24))
    t("③ past month all 429: raises", isinstance(err, requests.HTTPError), err)
    t("③ no parquet written", list(d.rglob('*.parquet')) == [], list(d.rglob('*.parquet')))
finally:
    shutil.rmtree(d, ignore_errors=True)

sys.exit(1 if fails else 0)
