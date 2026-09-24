"""Minimal check of tests/live_testnet_scenarios.py's safety guards — no network.

The harness trades on demo accounts with real order code; these are the guards
that keep it there. Asserts: the env file must be exactly the expected path
(not another file, not a symlink to one) and every venue in it must carry its
demo flag; a credential in the process environment, BLAVE_AGENT_WORKSPACE or a
proxy is refused; the transport guard refuses a live host BEFORE the request
is sent (Binance futures and spot incl. the old spot testnet host, OKX without / with a wrong
x-simulated-trading header, plain http, a Telegram call) and lets the demo
hosts through; DNS for a non-demo host is refused; the REAL lib pointed at the
live host with *_DEMO=false is stopped at the transport; order attribution on
the wire is recorded per request; key values are redacted; a child refuses a
workspace this harness did not make; an OKX account in Spot mode, an unfunded
account and a refused manual position stop the venue with a message, before
any order.

The HTTP adapter and DNS are stubbed underneath the guard, so nothing here can
reach a network even if a guard were broken.

Run: cd blave-agent && .venv/bin/python tests/check_live_testnet_guards.py
"""
import importlib.util
import json
import os
import socket
import sys
import tempfile
import urllib.request

import requests
import requests.adapters

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
spec = importlib.util.spec_from_file_location(
    "live_testnet_scenarios", os.path.join(ROOT, "tests", "live_testnet_scenarios.py"))
H = importlib.util.module_from_spec(spec)
spec.loader.exec_module(H)

fails = 0


def check(cond, msg):
    global fails
    print(("ok   " if cond else "FAIL ") + msg)
    fails += 0 if cond else 1


def raises(exc, fn, *a, **k):
    try:
        fn(*a, **k)
    except exc as e:
        return str(e) or True
    except Exception as e:  # the wrong exception is a failure too
        return False if not isinstance(e, exc) else True
    return False


TMP = os.path.realpath(tempfile.mkdtemp(prefix="testnet-guards-"))
os.chdir(TMP)
GOOD = os.path.join(TMP, "testnet.env")
with open(GOOD, "w") as f:
    f.write("BINANCE_API_KEY=binkey123456\nBINANCE_SECRET_KEY=binsecret123456\nBINANCE_DEMO=true\n"  # gitleaks:allow
            "OKX_API_KEY=okxkey123456\nOKX_SECRET_KEY=okxsecret123456\nOKX_PASSPHRASE=okxpass123\n"  # gitleaks:allow
            "OKX_DEMO=true\n")


def env_file(name, body):
    path = os.path.join(TMP, name)
    with open(path, "w") as f:
        f.write(body)
    return path


# ── 1. preflight ────────────────────────────────────────────────────────────
envs, secrets = H.preflight(GOOD, expected=GOOD, environ={}, cwd=TMP)
check(sorted(envs) == ["binance", "okx"], f"venues from the file: {sorted(envs)}")
check(envs["okx"] == {"OKX_API_KEY": "okxkey123456", "OKX_SECRET_KEY": "okxsecret123456",  # gitleaks:allow
                      "OKX_PASSPHRASE": "okxpass123", "OKX_DEMO": "true"},
      "a venue's env holds only its own lines + its demo flag")
check("okxpass123" in secrets and "binsecret123456" in secrets, "secret values collected for redaction")

other = env_file("other.env", open(GOOD).read())
check(raises(H.Fatal, H.preflight, other, expected=GOOD, environ={}, cwd=TMP),
      "a different file (same content) is refused")
link = os.path.join(TMP, "link.env")
os.symlink(GOOD, link)
check(raises(H.Fatal, H.preflight, link, expected=link, environ={}, cwd=TMP),
      "the expected path being a symlink is refused")
check(raises(H.Fatal, H.preflight, os.path.join(TMP, "missing.env"),
             expected=os.path.join(TMP, "missing.env"), environ={}, cwd=TMP),
      "a missing file is refused")
no_flag = env_file("noflag.env", "BINANCE_API_KEY=a1b2c3d4e5\nBINANCE_SECRET_KEY=f6g7h8i9j0\n")
check(raises(H.Fatal, H.preflight, no_flag, expected=no_flag, environ={}, cwd=TMP),
      "keys without BINANCE_DEMO=true are refused")
false_flag = env_file("falseflag.env", open(GOOD).read().replace("OKX_DEMO=true", "OKX_DEMO=false"))
check(raises(H.Fatal, H.preflight, false_flag, expected=false_flag, environ={}, cwd=TMP),
      "OKX_DEMO=false is refused")
unknown = env_file("unknown.env", open(GOOD).read() + "BINGX_API_KEY=x1y2z3w4v5\n")
check(raises(H.Fatal, H.preflight, unknown, expected=unknown, environ={}, cwd=TMP),
      "a venue without a demo host here (BingX) is refused")
stray = env_file("stray.env", open(GOOD).read() + "OTHER_SECRET_KEY=zzzzzzzz\n")
check(raises(H.Fatal, H.preflight, stray, expected=stray, environ={}, cwd=TMP),
      "a stray credential of another prefix is refused")
for environ, what in (({"BINANCE_API_KEY": "x"}, "a venue key in the process env"),
                      ({"BLAVE_API_KEY": "x"}, "a workspace .env loaded into the process env"),
                      ({"BLAVE_AGENT_WORKSPACE": "/x"}, "BLAVE_AGENT_WORKSPACE"),
                      ({"HTTPS_PROXY": "http://p:1"}, "a proxy variable")):
    check(raises(H.Fatal, H.preflight, GOOD, expected=GOOD, environ=environ, cwd=TMP),
          f"{what} is refused")
check(raises(H.Fatal, H.check_environ, {}, os.path.join(H.REAL_WORKSPACE, "x")),
      "running from inside ~/Blave/workspace is refused")

# ── 2. transport guard (adapter + DNS stubbed UNDER the guard) ──────────────
SENT, LOOKED_UP = [], []


def fake_send(self, request, *a, **k):
    SENT.append(request.url)
    r = requests.Response()
    r.status_code, r._content, r.url = 200, b"{}", request.url
    r.request = request
    return r


def fake_getaddrinfo(host, *a, **k):
    LOOKED_UP.append(host)
    return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("127.0.0.1", 443))]


requests.adapters.HTTPAdapter.send = fake_send
socket.getaddrinfo = fake_getaddrinfo
H.install_http_guard(["binance", "okx"])
check(raises(H.Fatal, H.install_http_guard, ["binance"]), "the guard refuses a second install")


def attempt(method, url, **kw):
    n = len(SENT)
    try:
        requests.request(method, url, timeout=5, **kw)
    except H.LiveHostRefused as e:
        return "refused", str(e)
    return ("sent" if len(SENT) > n else "not sent"), ""


for url in ("https://fapi.binance.com/fapi/v1/time", "https://api.binance.com/api/v3/time",
            "https://testnet.binance.vision/api/v3/order", "https://api1.binance.com/api/v3/order",
            "https://demo-api.binance.com.evil.example/api/v3/order",
            "https://api.bybit.com/v5/market/time", "https://api.telegram.org/botX/sendMessage",
            "http://demo-fapi.binance.com/fapi/v1/time"):
    got, why = attempt("GET", url)
    check(got == "refused" and url not in SENT, f"refused before sending: {url}")
got, why = attempt("POST", "https://www.okx.com/api/v5/trade/order", data='{"tag":"96ee7de3fd4bBCDE"}')
check(got == "refused" and "LIVE" in why, "OKX without x-simulated-trading is refused (live trading)")
got, _ = attempt("GET", "https://www.okx.com/api/v5/account/balance",
                 headers={"x-simulated-trading": "0"})
check(got == "refused", "OKX with x-simulated-trading: 0 is refused")
for url, headers in (("https://demo-fapi.binance.com/fapi/v1/time", {}),
                     ("https://demo-api.binance.com/api/v3/time", {}),
                     ("https://www.okx.com/api/v5/account/balance", {"x-simulated-trading": "1"})):
    got, _ = attempt("GET", url, headers=headers)
    check(got == "sent", f"demo host goes through: {url}")

check(bool(raises(H.LiveHostRefused, socket.getaddrinfo, "fapi.binance.com", 443)),
      "DNS for a live host is refused")
try:
    urllib.request.urlopen("https://api.telegram.org/", timeout=2)
    stopped = False
except Exception as e:  # urllib wraps it in URLError
    stopped = isinstance(getattr(e, "reason", e), H.LiveHostRefused)
check(stopped, "a non-requests client (urllib) is stopped at DNS")
check("api.telegram.org" not in LOOKED_UP and "fapi.binance.com" not in LOOKED_UP,
      "no live hostname ever reached the (stubbed) resolver")
socket.getaddrinfo("demo-fapi.binance.com", 443)
check("demo-fapi.binance.com" in LOOKED_UP, "DNS for a demo host passes")

# ── 3. the real lib, flag off → stopped at the transport ────────────────────
sys.path.insert(0, ROOT)
from lib import order_binance, order_okx  # noqa: E402

live_env = {"BINANCE_API_KEY": "binkey123456", "BINANCE_SECRET_KEY": "binsecret123456",  # gitleaks:allow
            "BINANCE_DEMO": "false"}
n = len(SENT)
check(bool(raises(H.LiveHostRefused, order_binance.get_mark_price, live_env, "ETHUSDT"))
      and len(SENT) == n, "order_binance with BINANCE_DEMO=false: live URL refused, nothing sent")
okx_live = {"OKX_API_KEY": "k", "OKX_SECRET_KEY": "s", "OKX_PASSPHRASE": "p", "OKX_DEMO": "false"}
check(bool(raises(H.LiveHostRefused, order_okx.get_mark_price, okx_live, "ETHUSDT"))
      and len(SENT) == n, "order_okx with OKX_DEMO=false: refused (no simulated header)")
demo_env = dict(live_env, BINANCE_DEMO="true")
try:
    order_binance.get_mark_price(demo_env, "ETHUSDT")
except H.LiveHostRefused:
    check(False, "order_binance with BINANCE_DEMO=true must pass the guard")
except Exception:
    pass  # the stub's empty body is not a price — only the host matters here
check(any(u.startswith("https://demo-fapi.binance.com/") for u in SENT[n:]),
      "order_binance with BINANCE_DEMO=true reaches demo-fapi")
n = len(SENT)
check(bool(raises(H.LiveHostRefused, order_binance.get_spot_price, live_env, "ETHUSDT"))
      and len(SENT) == n, "order_binance spot with BINANCE_DEMO=false: api.binance.com refused")
from lib import account_binance  # noqa: E402
check(bool(raises(H.LiveHostRefused, account_binance.get_holdings, live_env)) and len(SENT) == n,
      "account_binance with BINANCE_DEMO=false: refused, nothing sent")
for fn in (lambda: order_binance.get_spot_price(demo_env, "ETHUSDT"),
           lambda: order_binance.place_spot_market_order(demo_env, "ETHUSDT", "buy", quote_qty=10),
           lambda: order_binance.get_spot_balances(demo_env),
           lambda: account_binance.get_holdings(demo_env)):
    try:
        fn()
    except H.LiveHostRefused as e:
        check(False, f"a demo spot request was refused: {e}")
    except Exception:
        pass  # stub bodies are not venue shapes — only the host matters here
spot_hosts = {u.split("/")[2] for u in SENT[n:]} - {"demo-fapi.binance.com"}
check(spot_hosts == {"demo-api.binance.com"},
      f"every Binance spot request with BINANCE_DEMO=true goes to demo-api ({sorted(spot_hosts)})")

# ── 4. attribution recorded from the wire ───────────────────────────────────
H.WIRE.clear()
attempt("POST", "https://demo-fapi.binance.com/fapi/v1/order",
        data="symbol=ETHUSDT&newClientOrderId=x-52DDFAFNrc1&signature=s")
attempt("POST", "https://demo-fapi.binance.com/fapi/v1/order",
        data="symbol=ETHUSDT&newClientOrderId=plain1&signature=s")
attempt("POST", "https://www.okx.com/api/v5/trade/order", headers={"x-simulated-trading": "1"},
        data=json.dumps({"instId": "ETH-USDT-SWAP", "tag": "96ee7de3fd4bBCDE"}))
attempt("POST", "https://www.okx.com/api/v5/trade/order", headers={"x-simulated-trading": "1"},
        data=json.dumps({"instId": "ETH-USDT-SWAP"}))
attempt("GET", "https://demo-fapi.binance.com/fapi/v2/positionRisk")
check([w["ok"] for w in H.WIRE] == [True, False, True, False],
      f"attribution per order request (reads not counted): {[w['ok'] for w in H.WIRE]}")

# ── 5. redaction and the child's workspace check ────────────────────────────
H.REDACT.secrets |= secrets
check(H.REDACT("sig for okxsecret123456 and binkey123456") == "sig for *** and ***",
      "key values are redacted from output")
not_ws = tempfile.mkdtemp(prefix="not-a-ws-")
check(raises(H.Fatal, H.check_workspace, not_ws), "a temp dir without the marker is not a workspace")
check(raises(H.Fatal, H.check_workspace, ROOT), "the repo is not a workspace")

# ── 6. setup failures stop the venue with a message, before any order ──────
from types import SimpleNamespace  # noqa: E402

from lib import account_okx  # noqa: E402


def run_stub(venue, acct, order=None):
    r = object.__new__(H.VenueRun)
    r.venue, r.env, r.sym, r.results = venue, {}, "ETHUSDT", []
    r.acct, r.order = acct, order or SimpleNamespace()
    return r


def mode_1(env):
    raise account_okx.AccountModeError("acctLv=1")


placed = []
r = run_stub("okx", SimpleNamespace(check_account_mode=mode_1,
                                    AccountModeError=account_okx.AccountModeError,
                                    get_equity=lambda env: placed.append("read") or {"equity": 1e5}),
             SimpleNamespace(place_market_order=lambda *a, **k: placed.append("order")))
e = raises(H.SetupFailed, r.ready)
check(e == "OKX 帳戶模式不支援合約，請切到合約模式或跨幣種保證金" and not placed,
      "OKX acctLv 1 stops the venue with the mode message, before any read or order")
r = run_stub("okx", SimpleNamespace(check_account_mode=lambda env: "2",
                                    AccountModeError=account_okx.AccountModeError,
                                    get_equity=lambda env: {"equity": 1e5}))
check(not raises(H.SetupFailed, r.ready) and r.equity == 1e5, "OKX acctLv 2 passes")
r = run_stub("gateio", SimpleNamespace(get_equity=lambda env: {"equity": 0.0}))
e = raises(H.SetupFailed, r.ready)
check(bool(e) and "first transfer" in e, "a Gate.io futures account without funds stops the venue")
r.equity, r.A = 100.0, 60.0
check(bool(raises(H.SetupFailed, r.need_margin)), "equity under 4 × A stops the venue")


def refused(*a, **k):
    raise RuntimeError("OKX error 51010: account mode")


r = run_stub("okx", SimpleNamespace(), SimpleNamespace(place_market_order=refused))
e = raises(H.SetupFailed, r.manual, "long", 0.03)
check(bool(e) and "could not be opened" in e and "51010" in e,
      "a manual position the venue refuses is a SetupFailed with the venue's reason, not a traceback")
r = run_stub("okx", SimpleNamespace(), SimpleNamespace(place_market_order=lambda *a, **k: False))
check(bool(raises(H.SetupFailed, r.manual, "long", 0.0001)), "a manual below the minimum too")

# ── 6b. Gate.io book past the market-order price bound ─────────────────────
import types  # noqa: E402

_gate_replies = {}


def _gate_get(url, params=None, **k):
    r = requests.Response()
    r.status_code, r.url = 200, url
    r._content = json.dumps(_gate_replies["tickers" if "tickers" in url else "contract"]).encode()
    return r


_real_get = requests.get
requests.get = _gate_get
gate_order = types.SimpleNamespace(_contract=lambda s: "ETH_USDT", PREFIX="/api/v4",
                                   _host=lambda env: "https://api-testnet.gateapi.io")
_gate_replies["contract"] = {"order_price_deviate": "0.02", "market_order_slip_ratio": "0.05"}
_gate_replies["tickers"] = [{"mark_price": "2660", "lowest_ask": "2784.3", "highest_bid": "2650"}]
r = run_stub("gateio", SimpleNamespace(get_equity=lambda env: {"equity": 1e5}), gate_order)
e = raises(H.SetupFailed, r.ready)
check(bool(e) and "MARKET_PRICE_TOO_DEVIATED" in e,
      "Gate.io book past mark × (1 + order_price_deviate) stops the venue before any order")
_gate_replies["tickers"] = [{"mark_price": "2660", "lowest_ask": "2660.5", "highest_bid": "2659.5"}]
r = run_stub("gateio", SimpleNamespace(get_equity=lambda env: {"equity": 1e5}), gate_order)
check(not raises(H.SetupFailed, r.ready), "a Gate.io book near the mark passes")
requests.get = _real_get

# ── 7. spot setup stops ─────────────────────────────────────────────────────
def spot_stub(venue, order):
    r = object.__new__(H.SpotRun)
    r.venue, r.env, r.sym, r.key, r.base, r.quote = venue, {}, "ETHUSDT", "ETHUSDT@spot", "ETH", "USDT"
    r.results, r.acct, r.order = [], SimpleNamespace(), order
    return r


H.time.sleep = lambda s: None


def unreadable(env):
    raise RuntimeError("-2015 Invalid API-key")


r = spot_stub("okx", SimpleNamespace(get_spot_balances=unreadable))
e = raises(H.SetupFailed, r.ready)
check(bool(e) and "spot wallet read failed" in e, "an unreadable spot wallet stops the venue")
def okx_public(ask, buy_lmt):
    def send(method, path, env, params=None):
        if path.endswith("price-limit"):
            return [{"buyLmt": str(buy_lmt), "sellLmt": "2600"}]
        return [{"asks": [[str(ask), "1"]], "bids": [["2700", "1"]]}]
    return send


r = spot_stub("okx", SimpleNamespace(get_spot_balances=lambda env: {"USDT": 100.0, "ETH": 0.5},
                                     _spot_inst=lambda s: "ETH-USDT",
                                     _send=okx_public(2750, 2701.84)))
e = raises(H.SetupFailed, r.ready)
check(bool(e) and "outside the venue's price limit" in e,
      "OKX demo book outside the price limit (every market buy canceled) stops the venue")
r = spot_stub("okx", SimpleNamespace(get_spot_balances=lambda env: {"USDT": 100.0, "ETH": 0.5},
                                     _spot_inst=lambda s: "ETH-USDT",
                                     _send=okx_public(2701, 2750)))
r.ready()
check(r.quote_bal == 100.0 and r.base0 == r.user == 0.5, "spot ready: quote balance and the "
      "user's starting coins read")
r.A = 30.0
check(bool(raises(H.SetupFailed, r.need_margin)), "spot quote balance under 6 × A stops the venue")
r = spot_stub("okx", SimpleNamespace(place_spot_market_order=refused))
e = raises(H.SetupFailed, r.manual_buy, 30.0)
check(bool(e) and "could not be bought" in e, "a refused buy of the user's own coins stops the venue")
check(bool(raises(H.SetupFailed, H.SpotRun.__init__, object.__new__(H.SpotRun), "okx", {},
                  "ETHBTC")), "a spot pair without a USDT/USDC quote is refused")

print("\nALL OK" if not fails else f"\n{fails} FAILED")
sys.exit(1 if fails else 0)
