"""Minimal check that a timestamp rejection resyncs and retries once — no network.

What it protects (Bybit demo 2026-09-24): /v5/position/list answered retCode
10002 because the request reached Bybit 6.15 s after it was signed (recv_window
5 s); the read failed and the whole run aborted. A live user sees that as a
failed position read or a failed order. Every venue lib now treats its
timestamp code — Bybit 10002, OKX 50102, Gate.io REQUEST_EXPIRED, BingX 100421,
Binance -1021 (already did) — the same way: measure the offset against the
venue's own public server time, re-sign with it, retry once.

Asserts, for the order lib's and the account lib's signed call of each venue:
one timestamp rejection → exactly one server-time read and one retry, which
succeeds and carries the venue's clock (here 7 s ahead of ours); a rejection
that persists raises after that one retry — never a loop. Plus: Gate.io's
MARKET_PRICE_TOO_DEVIATED is a PriceDeviatedError with the user message and
token, still a GateioError.

Run: cd blave-agent && .venv/bin/python tests/check_clock_skew_retry.py
"""
import json, os, sys, tempfile, time
from datetime import datetime, timezone
from urllib.parse import parse_qs, urlsplit

import requests

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
os.chdir(tempfile.mkdtemp(prefix="clock-skew-"))

from lib import (account_binance, account_bingx, account_bybit, account_gateio,  # noqa: E402
                 account_okx, order_binance, order_bingx, order_bybit, order_gateio, order_okx)

fails = 0


def check(cond, msg):
    global fails
    print(("ok   " if cond else "FAIL ") + msg)
    fails += 0 if cond else 1


AHEAD_MS = 7000
STATE = {"bad": 0, "signed": [], "time_reads": 0, "venue": None}
TIME_PATHS = ("/v5/market/time", "/api/v5/public/time", "/api/v4/spot/time",
              "/openApi/swap/v2/server/time", "/fapi/v1/time", "/api/v3/time")
REJECT = {
    "bybit": (200, {"retCode": 10002, "retMsg": "invalid request, please check your server "
                                                "timestamp or recv_window param"}),
    "okx": (401, {"code": "50102", "msg": "Timestamp request expired", "data": []}),
    "gateio": (401, {"label": "REQUEST_EXPIRED", "message": "gap between request Timestamp "
                                                            "and server time exceeds 60"}),
    "bingx": (200, {"code": 100421, "msg": "Null timestamp or timestamp mismatch"}),
    "binance": (400, {"code": -1021, "msg": "Timestamp for this request is outside of the "
                                            "recvWindow."}),
}
OK = {"bybit": {"retCode": 0, "result": {}}, "okx": {"code": "0", "data": []},
      "gateio": {"total": "1"}, "bingx": {"code": 0, "data": {}}, "binance": {"ok": 1}}


def server_ms():
    return int(time.time() * 1000) + AHEAD_MS


def _time_body(path):
    ms = server_ms()
    return {"/v5/market/time": {"retCode": 0, "result": {"timeNano": str(ms * 1_000_000)}},
            "/api/v5/public/time": {"code": "0", "data": [{"ts": str(ms)}]},
            "/api/v4/spot/time": {"server_time": ms},
            "/openApi/swap/v2/server/time": {"code": 0, "data": {"serverTime": ms}},
            "/fapi/v1/time": {"serverTime": ms},
            "/api/v3/time": {"serverTime": ms}}[path]


def signed_ts_ms(url, headers):
    """The timestamp the request was signed with, in ms."""
    h = {k.lower(): v for k, v in (headers or {}).items()}
    if "x-bapi-timestamp" in h:
        return int(h["x-bapi-timestamp"])
    if "ok-access-timestamp" in h:
        t = datetime.strptime(h["ok-access-timestamp"], "%Y-%m-%dT%H:%M:%S.%fZ")
        return int(t.replace(tzinfo=timezone.utc).timestamp() * 1000)
    if "timestamp" in h:
        return int(h["timestamp"]) * 1000
    q = parse_qs(urlsplit(url).query)
    return int(q["timestamp"][0])


def _fake(method, url, headers=None, data=None, params=None, **k):
    path = urlsplit(url).path
    r = requests.Response()
    r.url = url
    if path in TIME_PATHS:
        STATE["time_reads"] += 1
        r.status_code, body = 200, _time_body(path)
    else:
        STATE["signed"].append(signed_ts_ms(url, headers))
        if STATE["bad"] > 0:
            STATE["bad"] -= 1
            r.status_code, body = REJECT[STATE["venue"]]
        else:
            r.status_code, body = 200, OK[STATE["venue"]]
    r._content = json.dumps(body).encode()
    return r


requests.request = lambda method, url, **k: _fake(method, url, **k)
requests.get = lambda url, **k: _fake("GET", url, **k)
requests.post = lambda url, **k: _fake("POST", url, **k)
for m in (order_binance, order_bybit, order_okx, order_gateio, order_bingx):
    m.time.sleep = lambda s: None

ENVS = {
    "bybit": {"BYBIT_API_KEY": "k", "BYBIT_SECRET_KEY": "s", "BYBIT_DEMO": "true"},
    "okx": {"OKX_API_KEY": "k", "OKX_SECRET_KEY": "s", "OKX_PASSPHRASE": "p", "OKX_DEMO": "true"},
    "gateio": {"GATEIO_API_KEY": "k", "GATEIO_SECRET_KEY": "s", "GATEIO_DEMO": "true"},
    "bingx": {"BINGX_API_KEY": "k", "BINGX_SECRET_KEY": "s", "BINGX_DEMO": "true"},
    "binance": {"BINANCE_API_KEY": "k", "BINANCE_SECRET_KEY": "s", "BINANCE_DEMO": "true"},
}
CALLS = [
    ("bybit", order_bybit, lambda e: order_bybit._send(e, "GET", "/v5/position/list",
                                                         {"category": "linear"})),
    ("bybit", account_bybit, lambda e: account_bybit._request(e, "GET", "/v5/position/list",
                                                                {"category": "linear"})),
    ("okx", order_okx, lambda e: order_okx._send("GET", "/api/v5/account/balance", e)),
    ("okx", account_okx, lambda e: account_okx._request(e, "GET", "/api/v5/account/balance")),
    ("gateio", order_gateio, lambda e: order_gateio._send("GET", "/futures/usdt/accounts", e)),
    ("gateio", account_gateio, lambda e: account_gateio._request(e, "GET",
                                                                   "/futures/usdt/accounts")),
    ("bingx", order_bingx, lambda e: order_bingx._send("GET", "/openApi/swap/v2/user/balance", e)),
    ("bingx", account_bingx, lambda e: account_bingx._signed_get("/openApi/swap/v2/user/balance",
                                                                   e)),
    ("binance", order_binance, lambda e: order_binance._send("GET", "/fapi/v2/account", e)),
    ("binance", account_binance, lambda e: account_binance._signed(
        "GET", account_binance._fapi(e), "/fapi/v2/account", e)),
]


def reset(mod, venue, bad):
    off = getattr(mod, "_time_offset")
    for k in off:
        off[k] = 0
    STATE.update(bad=bad, signed=[], time_reads=0, venue=venue)


for venue, mod, call in CALLS:
    name = mod.__name__.split(".")[-1]
    reset(mod, venue, bad=1)
    try:
        call(ENVS[venue])
        err = None
    except Exception as e:
        err = e
    s = STATE["signed"]
    shifted = len(s) == 2 and abs((s[1] - s[0]) - AHEAD_MS) < 1500
    check(err is None and len(s) == 2 and STATE["time_reads"] == 1 and shifted,
          f"{name}: one timestamp rejection → one server-time read, one retry on the venue's "
          f"clock, success (signed {len(s)}×, time reads {STATE['time_reads']}, "
          f"shift {(s[1] - s[0]) if len(s) == 2 else '-'} ms{f', {err}' if err else ''})")

    reset(mod, venue, bad=99)
    try:
        call(ENVS[venue])
        err = None
    except Exception as e:
        err = e
    # order_binance predates this: it resyncs on each of its 3 attempts — bounded too
    most = 3 if name == "order_binance" else 2
    check(err is not None and len(STATE["signed"]) == most,
          f"{name}: a rejection that persists raises after {most - 1} "
          f"retr{'y' if most == 2 else 'ies'}, never loops (signed {len(STATE['signed'])}×)")

# ── Gate.io price deviation ─────────────────────────────────────────────────
REJECT["gateio"] = (400, {"label": "MARKET_PRICE_TOO_DEVIATED",
                          "message": "buy market order stop match price 2713.2 less than ask1 "
                                     "price 2784.3 while mark_price 2660 and slip ratio 0.05"})
reset(order_gateio, "gateio", bad=1)
try:
    order_gateio._send("POST", "/futures/usdt/orders", ENVS["gateio"],
                       {"contract": "ETH_USDT", "size": 1, "price": "0", "tif": "ioc"})
    err = None
except Exception as e:
    err = e
check(isinstance(err, order_gateio.PriceDeviatedError) and isinstance(err, order_gateio.GateioError)
      and str(err).startswith(order_gateio.PRICE_DEVIATED_MSG)
      and "[gateio_price_deviated]" in str(err) and err.code == "MARKET_PRICE_TOO_DEVIATED"
      and len(STATE["signed"]) == 1,
      "Gate.io MARKET_PRICE_TOO_DEVIATED → PriceDeviatedError (message + token, label kept), "
      "not retried")

print("\nALL OK" if not fails else f"\n{fails} FAILED")
sys.exit(1 if fails else 0)
