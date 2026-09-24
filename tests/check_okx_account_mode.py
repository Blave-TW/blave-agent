"""Minimal check that an OKX account in Spot mode is named, not a generic failure — no network.

What it protects: an OKX account in Spot mode (acctLv 1) refuses every swap order
with 51010 "Request unsupported under current account mode" (measured on the demo
account 2026-09-23). The user must see what to change, and see it at the bind —
not after the first order fails.

Asserts: the account read (get_equity — the read the bind, the desktop gate and
the cloud retest go through) raises account_okx.AccountModeError on acctLv 1
carrying the user message and the token the desktop/web map on, and passes on
2 / 3 / 4; a 51010 on any account read raises the same; order_okx raises
AccountModeError (still an OKXError) on a 51010 order reply, top-level and per
row; a swap order on an acctLv-1 account raises before any order request is
sent, and that result is not cached; the two libs' message and token agree.

Run: cd blave-agent && .venv/bin/python tests/check_okx_account_mode.py
"""
import json, os, sys, tempfile

import requests

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
os.chdir(tempfile.mkdtemp(prefix="okx-mode-"))  # guard's state/ lands here

from lib import account_okx, order_okx  # noqa: E402

fails = 0


def check(cond, msg):
    global fails
    print(("ok   " if cond else "FAIL ") + msg)
    fails += 0 if cond else 1


ENV = {"OKX_API_KEY": "k", "OKX_SECRET_KEY": "s", "OKX_PASSPHRASE": "p", "OKX_DEMO": "true"}
REPLIES = {}  # path prefix -> body
SENT = []


def _fake(method, url, **k):
    path = url.split("www.okx.com", 1)[1]
    SENT.append((method, path))
    body = next((b for p, b in REPLIES.items() if path.startswith(p)),
                {"code": "0", "data": []})
    r = requests.Response()
    r.status_code, r._content, r.url = 200, json.dumps(body).encode(), url
    return r


requests.get = lambda url, **k: _fake("GET", url, **k)
requests.post = lambda url, **k: _fake("POST", url, **k)
requests.request = lambda method, url, **k: _fake(method, url, **k)


def config(lv, pos_mode="net_mode"):
    return {"code": "0", "data": [{"acctLv": lv, "posMode": pos_mode, "uid": "1"}]}


def raised(fn, *a):
    try:
        fn(*a)
    except Exception as e:
        return e
    return None


check(account_okx.ACCOUNT_MODE_MSG == order_okx.ACCOUNT_MODE_MSG
      and account_okx.ACCOUNT_MODE_TOKEN == order_okx.ACCOUNT_MODE_TOKEN == "okx_account_mode",
      "both libs carry the same message and token")
USER_MSG = "OKX 帳戶模式不支援合約：到 OKX 設定 → 帳戶模式，改成合約模式或跨幣種保證金"
check(order_okx.ACCOUNT_MODE_MSG == USER_MSG, "the user message is the agreed wording")

# ── account read ────────────────────────────────────────────────────────────
REPLIES.clear()
REPLIES["/api/v5/account/config"] = config("1")
REPLIES["/api/v5/account/balance"] = {"code": "0", "data": [{"totalEq": "100"}]}
SENT.clear()
e = raised(account_okx.get_equity, ENV)
check(isinstance(e, account_okx.AccountModeError) and str(e).startswith(USER_MSG)
      and "[okx_account_mode]" in str(e) and getattr(e, "code", None) == "okx_account_mode",
      f"get_equity on acctLv 1 → AccountModeError with message + token ({str(e)[:60]}…)")
check(("GET", "/api/v5/account/balance") not in SENT, "…raised before the balance read")
for lv in ("2", "3", "4"):
    REPLIES["/api/v5/account/config"] = config(lv)
    try:
        eq = account_okx.get_equity(ENV)
        check(eq["equity"] == 100.0, f"get_equity on acctLv {lv} reads normally")
    except Exception as ex:
        check(False, f"get_equity on acctLv {lv} raised {ex}")

REPLIES["/api/v5/account/config"] = config("2")
REPLIES["/api/v5/account/positions"] = {"code": "51010", "msg": "Request unsupported under "
                                        "current account mode", "data": []}
e = raised(account_okx.get_positions, ENV)
check(isinstance(e, account_okx.AccountModeError) and "[okx_account_mode]" in str(e)
      and str(getattr(e, "code", "")) == "51010",
      "a 51010 on an account read → AccountModeError, venue code kept")
check(account_okx.classify(e) is not None or account_okx.venue_errors is None,
      "classify still answers for it")

# ── order path ──────────────────────────────────────────────────────────────
REPLIES.clear()
REPLIES["/api/v5/trade/order"] = {"code": "1", "msg": "Operation failed", "data": [
    {"sCode": "51010", "sMsg": "You can't complete this request under your current account mode"}]}
e = raised(order_okx._send, "POST", "/api/v5/trade/order", ENV, {"instId": "ETH-USDT-SWAP"})
check(isinstance(e, order_okx.AccountModeError) and isinstance(e, order_okx.OKXError)
      and str(e).startswith(USER_MSG) and e.code == "51010",
      "order reply 51010 (top-level fail, row sCode) → AccountModeError, still an OKXError")
REPLIES["/api/v5/trade/order"] = {"code": "0", "data": [{"sCode": "51010", "sMsg": "mode"}]}
e = raised(order_okx._send, "POST", "/api/v5/trade/order", ENV, {"instId": "ETH-USDT-SWAP"})
check(isinstance(e, order_okx.AccountModeError), "51010 on a row under code 0 → AccountModeError")
REPLIES["/api/v5/trade/order"] = {"code": "1", "data": [{"sCode": "51008", "sMsg": "margin"}]}
e = raised(order_okx._send, "POST", "/api/v5/trade/order", ENV, {"instId": "ETH-USDT-SWAP"})
check(type(e) is order_okx.OKXError, "another order error stays a plain OKXError")

REPLIES.clear()
REPLIES["/api/v5/account/config"] = config("1")
REPLIES["/api/v5/public/instruments"] = {"code": "0", "data": [
    {"ctVal": "0.1", "lotSz": "0.01", "minSz": "0.01", "tickSz": "0.01", "state": "live"}]}
REPLIES["/api/v5/market/ticker"] = {"code": "0", "data": [{"last": "2000", "markPx": "2000"}]}
order_okx._pos_mode_cache.clear()
SENT.clear()
e = raised(order_okx.place_market_order, ENV, "ETHUSDT", "long", 0.1)
check(isinstance(e, order_okx.AccountModeError) and str(e).startswith(USER_MSG),
      "swap market order on acctLv 1 → AccountModeError")
check(not any(p == "/api/v5/trade/order" for _, p in SENT),
      f"…and no order request was sent ({[p for _, p in SENT]})")
check("k" not in order_okx._pos_mode_cache, "the refusal is not cached")
REPLIES["/api/v5/account/config"] = config("2", "long_short_mode")
check(order_okx.get_position_mode(ENV) == "long_short_mode",
      "after the user switches mode, the next read goes through")

print("\nALL OK" if not fails else f"\n{fails} FAILED")
sys.exit(1 if fails else 0)
