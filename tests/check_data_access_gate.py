"""Minimal check: lib.data refuses Blave calls up front when the desktop shell set
BLAVE_DATA_ACCESS=0 (no balance for the hourly fee / not signed in). No network — every
HTTP call is a sentinel that records it was reached and raises.

  - access=0: a Blave paid function raises RuntimeError before any request, and the message
    tells the model not to look for credentials (2026-09-24 e2e: a KeyError sent the agent
    through .env / os.environ / references for 80 s)
  - access=0: the public paths still reach their sources — Binance klines
    (BLAVE_KLINE_SOURCE=binance), BingX klines (shares _retry_get), TWSE/TPEx daily bars
  - unset / "1": the same paid function goes to requests as before

Run: cd blave-agent && MPLBACKEND=Agg .venv/bin/python tests/check_data_access_gate.py
"""
import os
import sys
import tempfile
from pathlib import Path

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
os.environ.setdefault("MPLBACKEND", "Agg")

import lib.data as D

fails = 0


def check(cond, msg):
    global fails
    print(("  PASS  " if cond else "  FAIL  ") + msg)
    fails += (not cond)


class Reached(Exception):
    pass


reached = []


def sentinel_get(url, *a, **k):
    reached.append(url)
    raise Reached(url)


class FakeSession:
    def get(self, url, *a, **k):
        return sentinel_get(url)


D.requests.get = sentinel_get
D._TW_PUBLIC_SESSION = FakeSession()
D._CACHE_DIR = Path(tempfile.mkdtemp())
D.time.sleep = lambda s: None
HDR = {"api-key": "", "secret-key": ""}
ARGS = ("BTCUSDT", "1h", "2026-09-01", "2026-09-02", HDR)


def outcome(fn, *a, **k):
    reached.clear()
    try:
        fn(*a, **k)
        return None
    except Exception as e:  # noqa: BLE001
        return e


os.environ["BLAVE_DATA_ACCESS"] = "0"
for name, fn, args in [
    ("fetch_holder_concentration", D.fetch_holder_concentration, ARGS),
    ("fetch_long_short_ratio_table", D.fetch_long_short_ratio_table, (HDR,)),
    ("fetch_db_kline (bare requests.get path)", D.fetch_db_kline,
     ("cboe", "VIX", "1d", "2026-09-01", "2026-09-02", HDR)),
    ("fetch_twfutures_ohlcv (bare requests.get path)", D._fetch_twfutures_raw,
     ("TXF", "1d", "2026-09-01", "2026-09-02", HDR)),
]:
    e = outcome(fn, *args)
    check(isinstance(e, RuntimeError) and "do not look for credentials" in str(e) and not reached,
          f"access=0: {name} raises before any request — {type(e).__name__}: {str(e)[:60]}")

os.environ["BLAVE_KLINE_SOURCE"] = "binance"
e = outcome(D.fetch_kline, *ARGS)
check(isinstance(e, Reached) and "binance.com" in reached[0],
      f"access=0: fetch_kline still goes to Binance public — {reached[:1]}")
os.environ.pop("BLAVE_KLINE_SOURCE")

e = outcome(D.fetch_bingx_kline, "BTC-USDT", "1h", "2026-09-01", "2026-09-02")
check(isinstance(e, Reached) and "bingx.com" in reached[0],
      f"access=0: BingX klines still public through _retry_get — {reached[:1]}")

os.environ["BLAVE_TWSTOCK_DAILY_SOURCE"] = "public"
outcome(D.fetch_twstock_price, "2330", "2024-01-01", "2024-01-31", HDR)
check(reached and "twse.com.tw" in reached[0],
      f"access=0: Taiwan daily bars still try the exchange first — {reached[:1]}")
os.environ.pop("BLAVE_TWSTOCK_DAILY_SOURCE")

os.environ.pop("BLAVE_DATA_ACCESS")
e = outcome(D.fetch_holder_concentration, *ARGS)
check(isinstance(e, Reached) and reached[0].startswith(D.BASE),
      f"unset: fetch_holder_concentration reaches requests as before — {reached[:1]}")
os.environ["BLAVE_DATA_ACCESS"] = "1"
e = outcome(D.fetch_holder_concentration, *ARGS)
check(isinstance(e, Reached), "access=1: same")
os.environ.pop("BLAVE_DATA_ACCESS")

# ── scheduled report run on the desktop (report_runner: BLAVE_AGENT_LOCAL=1 + BLAVE_SCHEDULED_RUN=1) ──
# The state comes from the key the shell keeps in .env: empty → no access, before any request;
# a key that stopped working (401, 403 ERR007 / ERR005) means the same. KEY_SCOPE and a chat
# turn keep the raw 403 — its body is what the model must relay.
class R:
    def __init__(self, status, text):
        self.status_code, self.text = status, text

    def raise_for_status(self):
        if self.status_code >= 400:
            raise D.requests.HTTPError(str(self.status_code), response=self)


os.environ["BLAVE_AGENT_LOCAL"] = "1"
os.environ["BLAVE_SCHEDULED_RUN"] = "1"
e = outcome(D.fetch_holder_concentration, *ARGS)
check(isinstance(e, D.DataAccessError) and not reached, "desktop schedule, empty key in .env: DataAccessError, zero requests")
KEY = {"api-key": "k", "secret-key": "s"}
for status, body, want, label in ((401, "unauthorized", D.DataAccessError, "401"),
                                  (403, '{"error_code": "ERR007"}', D.DataAccessError, "403 ERR007"),
                                  (403, '{"error_code": "ERR005"}', D.DataAccessError, "403 ERR005"),
                                  (403, '{"error_code": "KEY_SCOPE"}', D.requests.HTTPError, "403 KEY_SCOPE")):
    D.requests.get = lambda url, *a, _r=R(status, body), **k: _r
    e = outcome(D._retry_get, D.BASE + "/x", headers=KEY)
    check(type(e) is want, f"desktop schedule, {label}: {want.__name__}")
os.environ.pop("BLAVE_SCHEDULED_RUN")
# Own-key chat turn: the shell leaves BLAVE_DATA_ACCESS unset (dataAccess "own"); a dead key is
# the user's own problem to see, not "no balance / not signed in".
D.requests.get = lambda url, *a, **k: R(401, "unauthorized")
e = outcome(D._retry_get, D.BASE + "/x", headers=KEY)
check(type(e) is D.requests.HTTPError, "desktop own-key chat turn (no BLAVE_DATA_ACCESS, no schedule flag), 401: raw HTTPError")
D.requests.get = lambda url, *a, **k: R(403, '{"error_code": "ERR005"}')
e = outcome(D._retry_get, D.BASE + "/x", headers=KEY)
check(type(e) is D.requests.HTTPError, "desktop own-key chat turn, 403 ERR005: raw HTTPError")
os.environ["BLAVE_DATA_ACCESS"] = "1"
D.requests.get = lambda url, *a, **k: R(403, '{"error_code": "ERR007"}')
e = outcome(D._retry_get, D.BASE + "/x", headers=KEY)
check(type(e) is D.requests.HTTPError and "ERR007" in str(e), "desktop chat turn (access=1), 403 ERR007: raw HTTPError with the body")
e = outcome(D._retry_get, D.BASE + "/x", headers={"api-key": ""})
check(type(e) is D.requests.HTTPError, "desktop chat turn: an empty key is not read as no-access (the turn flag decides)")
os.environ.pop("BLAVE_DATA_ACCESS"); os.environ.pop("BLAVE_AGENT_LOCAL")
e = outcome(D._retry_get, D.BASE + "/x", headers={"api-key": ""})
check(type(e) is D.requests.HTTPError, "cloud machine (no flag): unchanged, raw HTTPError")
D.requests.get = sentinel_get

print(f"\n{'ALL PASS' if not fails else f'{fails} FAILED'}")
sys.exit(1 if fails else 0)
