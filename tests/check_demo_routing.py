"""Minimal check that *_DEMO=true can never reach a live host — no network.

What it protects: BINANCE_DEMO / OKX_DEMO / BYBIT_DEMO / GATEIO_DEMO are what a
demo test run relies on; one request that slips to the live host with a live key
in .env is a real order. Two layers:

1. Static (every module-level live host): each live-host constant is referenced
   only inside the module's host selector, and no other `https://` literal exists
   outside module constants — so no code path can build a live URL by itself.
2. Dynamic (every public function, enumerated by introspection so a function
   added later is covered): the HTTP layer is replaced by a fake that records
   every request; each function is called with the flag on and every recorded
   URL must be on the demo host (OKX: www.okx.com with x-simulated-trading: 1 on
   every request). Transport-injected broker attribution must still ride along
   (Bybit referer, Gate X-Gate-Channel-Id, OKX tag on order POSTs). The flag is
   honoured from the env dict and from os.environ. Control: flag off must hit
   the live host, or the check proves nothing.

The fake answers with generic venue envelopes, so most functions stop at a
shape error after their first reads; section 3 drives each transport's
order-mutating path directly so the POST/DELETE route is covered too.

Run: cd blave-agent && .venv/bin/python tests/check_demo_routing.py
"""
import ast, inspect, json, os, sys, tempfile, time
from urllib.parse import urlsplit

import requests

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
os.chdir(tempfile.mkdtemp(prefix="demo-routing-"))  # guard's state/ lands here

from lib import (account_binance, account_bybit, account_gateio, account_okx,  # noqa: E402
                 order_binance, order_bybit, order_gateio, order_okx)

fails = 0


def check(cond, msg):
    global fails
    print(("ok   " if cond else "FAIL ") + msg)
    fails += 0 if cond else 1


# venue -> (modules, flag, creds, demo hosts, live hosts, host-selector functions)
VENUES = {
    "binance": ((order_binance, account_binance), "BINANCE_DEMO",
                {"BINANCE_API_KEY": "k", "BINANCE_SECRET_KEY": "s"},
                {"demo-fapi.binance.com", "demo-api.binance.com"},
                {"fapi.binance.com", "api.binance.com"},
                {"_base", "_spot", "_fapi", "_sync_time"}),
    "okx": ((order_okx, account_okx), "OKX_DEMO",
            {"OKX_API_KEY": "k", "OKX_SECRET_KEY": "s", "OKX_PASSPHRASE": "p"},
            {"www.okx.com"}, {"www.okx.com"}, {"_send", "_request"}),
    "bybit": ((order_bybit, account_bybit), "BYBIT_DEMO",
              {"BYBIT_API_KEY": "k", "BYBIT_SECRET_KEY": "s"},
              {"api-demo.bybit.com"}, {"api.bybit.com"}, {"_host"}),
    "gateio": ((order_gateio, account_gateio), "GATEIO_DEMO",
               {"GATEIO_API_KEY": "k", "GATEIO_SECRET_KEY": "s"},
               {"api-testnet.gateapi.io"}, {"api.gateio.ws"}, {"_host"}),
}


# ── 1. static: live hosts are reachable only through the selector ──────────
def _live_constants(tree, live_hosts):
    out = set()
    for node in tree.body:
        if isinstance(node, ast.Assign) and isinstance(node.value, ast.Constant) \
                and isinstance(node.value.value, str) and node.value.value.startswith("https://"):
            if urlsplit(node.value.value).hostname in live_hosts:
                out |= {t.id for t in node.targets if isinstance(t, ast.Name)}
    return out


for vid, (mods, _flag, _creds, demo_hosts, live_hosts, selectors) in VENUES.items():
    for mod in mods:
        tree = ast.parse(open(mod.__file__).read())
        consts = _live_constants(tree, live_hosts)
        check(bool(consts), f"{mod.__name__}: live host constant found ({sorted(consts)})")
        module_level = {id(n.value) for n in tree.body if isinstance(n, ast.Assign)}
        stray_literals = [n.lineno for n in ast.walk(tree)
                          if isinstance(n, ast.Constant) and isinstance(n.value, str)
                          and n.value.startswith("https://") and id(n) not in module_level]
        stray_names = []
        for fn in ast.walk(tree):
            if not isinstance(fn, (ast.FunctionDef, ast.AsyncFunctionDef)):
                continue
            for node in ast.walk(fn):
                if isinstance(node, ast.Name) and node.id in consts and fn.name not in selectors:
                    stray_names.append(f"{fn.name}:{node.lineno}")
        if vid == "okx":
            # one host both ways: the demo switch is the header, so every function
            # that calls requests must be the one that sets it
            fns = [fn for fn in ast.walk(tree) if isinstance(fn, ast.FunctionDef)]
            header_fns = {fn.name for fn in fns for n in ast.walk(fn)
                          if isinstance(n, ast.Constant) and n.value == "x-simulated-trading"}
            http_fns = {fn.name for fn in fns for n in ast.walk(fn)
                        if isinstance(n, ast.Attribute) and isinstance(n.value, ast.Name)
                        and n.value.id == "requests" and n.attr in ("get", "post", "request")}
            check(bool(header_fns) and http_fns <= header_fns,
                  f"{mod.__name__}: every HTTP call is in {sorted(header_fns)}, which sets "
                  f"x-simulated-trading" + (f" — also {sorted(http_fns - header_fns)}"
                                            if http_fns - header_fns else ""))
        else:
            check(not stray_names,
                  f"{mod.__name__}: live host constant used only in {sorted(selectors)}"
                  + (f" — also at {stray_names}" if stray_names else ""))
        check(not stray_literals, f"{mod.__name__}: no inline https:// literal"
              + (f" — lines {stray_literals}" if stray_literals else ""))


# ── fake HTTP ───────────────────────────────────────────────────────────────
class _Stop(Exception):
    """Raised by the fake after a call budget — ends confirm/poll loops."""


CALLS = []
BUDGET = {"n": 0}
_BODY = {"retCode": 0, "retMsg": "OK", "result": {}, "code": "0", "data": [], "msg": ""}


def _fake(method, url, params=None, headers=None, data=None):
    BUDGET["n"] += 1
    if BUDGET["n"] > 40:
        raise _Stop()
    CALLS.append({"method": method.upper(), "url": url, "params": params,
                  "headers": dict(headers or {}), "data": data})
    r = requests.Response()
    r.status_code = 200
    r._content = json.dumps(_BODY).encode()
    r.url = url
    return r


def _request(method, url, **k):
    return _fake(method, url, k.get("params"), k.get("headers"), k.get("data"))


def _get(url, **k):
    return _fake("GET", url, k.get("params"), k.get("headers"))


def _post(url, **k):
    return _fake("POST", url, k.get("params"), k.get("headers"), k.get("data"))


def _no_network(*a, **k):
    raise AssertionError("real HTTP attempted — the fake was bypassed")


requests.request, requests.get, requests.post = _request, _get, _post
requests.sessions.Session.request = _no_network
time.sleep = lambda s: None

_CACHES = ("_rules_cache", "_RULES_CACHE", "_pos_mode_cache", "_position_mode_cache")


def _reset(mods):
    for m in mods:
        for c in _CACHES:
            if isinstance(getattr(m, c, None), dict):
                getattr(m, c).clear()
    CALLS.clear()
    BUDGET["n"] = 0


# get_flows short-circuits to [] on Binance / Bybit demo (no on-chain money,
# endpoints not served there) — no request at all is the demo-safe outcome.
NO_HTTP_ON_DEMO = {"account_binance.get_flows", "account_bybit.get_flows"}
# Bybit withdraw_enabled asks the LIVE host on purpose even with the demo flag
# (a stale BYBIT_DEMO=true must not wave a live withdrawal key through; the
# demo host does not serve query-api). Read-only GET, never an order path.
LIVE_ON_DEMO = {"account_bybit.withdraw_enabled"}

_ARGS = {"symbol": "BTCUSDT", "direction": "long", "side": "buy", "qty": 0.01,
         "base_qty": 0.01, "price": 50000.0, "order_id": "1", "ord_id": "1",
         "algo_id": "1", "leverage": 5, "since": int(time.time()) - 3600,
         "sl_price": 40000.0}


def _call(fn, env):
    sig = inspect.signature(fn)
    kw = {}
    for name, p in list(sig.parameters.items())[1:]:
        if fn.__name__ == "place_spot_market_order" and name in ("base_qty", "quote_qty"):
            kw[name] = 10.0 if name == "quote_qty" else None  # a market BUY sizes in quote
        elif name in _ARGS and (p.default is inspect.Parameter.empty or name in
                              ("order_id", "algo_id", "sl_price", "base_qty")):
            kw[name] = _ARGS[name]
        elif p.default is inspect.Parameter.empty:
            raise AssertionError(f"{fn.__qualname__}: no dummy for required arg {name!r}")
    try:
        fn(env, **kw)
    except (_Stop, Exception) as e:  # noqa: B014 — shape errors from the fake are expected
        if isinstance(e, AssertionError):
            raise


def _public_fns(mod):
    for name, fn in inspect.getmembers(mod, inspect.isfunction):
        if name.startswith("_") or fn.__module__ != mod.__name__:
            continue
        params = list(inspect.signature(fn).parameters)
        if params and params[0] == "env":
            yield name, fn


def _hosts():
    return {urlsplit(c["url"]).hostname for c in CALLS}


def _attributed(vid):
    """Broker attribution present where the venue carries it."""
    for c in CALLS:
        h = {k.lower(): v for k, v in c["headers"].items()}
        if vid == "bybit" and h.get("referer") != "Ue001036":
            return False
        if vid == "gateio" and h.get("x-gate-channel-id") != "blave":
            return False
    return True


def _okx_simulated():
    return all(c["headers"].get("x-simulated-trading") == "1" for c in CALLS)


# ── 2. dynamic: every public function, flag on (env dict, then os.environ) ──
for vid, (mods, flag, creds, demo_hosts, live_hosts, _sel) in VENUES.items():
    for source in ("env", "os.environ"):
        env = dict(creds)
        if source == "env":
            env[flag] = "true"
        else:
            os.environ[flag] = "true"
        bad, silent, total, mutated = [], [], 0, 0
        for mod in mods:
            for name, fn in _public_fns(mod):
                _reset(mods)
                _call(fn, env)
                total += 1
                qual = f"{mod.__name__.split('.')[-1]}.{name}"
                if not CALLS:
                    if qual not in NO_HTTP_ON_DEMO:
                        silent.append(qual)
                    continue
                mutated += any(c["method"] in ("POST", "DELETE") for c in CALLS)
                if qual in LIVE_ON_DEMO:
                    ok = _hosts() <= live_hosts and all(c["method"] == "GET" for c in CALLS)
                    if not ok:
                        bad.append(f"{name} -> {sorted(_hosts())} (live read expected)")
                    continue
                ok = _hosts() <= demo_hosts
                if vid == "okx":
                    ok = ok and _okx_simulated()
                ok = ok and _attributed(vid)
                if not ok:
                    bad.append(f"{name} -> {sorted(_hosts())}")
        os.environ.pop(flag, None)
        check(not bad, f"{vid} [{flag} via {source}]: {total} public functions, every "
              f"request on {sorted(demo_hosts)}" + (f" — LEAKED: {bad}" if bad else ""))
        check(not silent, f"{vid} [{source}]: every public function reached the HTTP layer "
              f"({mutated} of them an order-mutating request)"
              + (f" — silent: {silent}" if silent else ""))

    # control: flag off → live host (otherwise the assertion above is vacuous)
    env = dict(creds, **{flag: "false"})
    _reset(mods)
    _call(mods[1].get_positions, env)
    hosts = _hosts()
    if vid == "okx":
        check(hosts <= live_hosts and not _okx_simulated(),
              f"{vid} control: flag off → no x-simulated-trading header")
    else:
        check(bool(hosts) and hosts <= live_hosts,
              f"{vid} control: flag off → live host {sorted(hosts)}")


# ── 3. order-mutating transport path, flag on ───────────────────────────────
MUTATING = {
    "binance": [(lambda env: order_binance._request(
        "POST", "/fapi/v1/order", env, {"symbol": "BTCUSDT", "side": "BUY", "type": "MARKET",
                                        "quantity": "0.001"}),
        "demo-fapi.binance.com"),
        (lambda env: order_binance._request(
            "POST", "/api/v3/order", env, {"symbol": "BTCUSDT", "side": "BUY", "type": "MARKET",
                                           "quoteOrderQty": "10"}, spot=True),
         "demo-api.binance.com"),
        (lambda env: order_binance._request("DELETE", "/fapi/v1/allOpenOrders", env,
                                            {"symbol": "BTCUSDT"}), "demo-fapi.binance.com")],
    "okx": [(lambda env: order_okx._request("POST", "/api/v5/trade/order", env, {
        "instId": "BTC-USDT-SWAP", "tdMode": "cross", "side": "buy", "ordType": "market",
        "sz": "1"}), "www.okx.com")],
    "bybit": [(lambda env: order_bybit._request(env, "POST", "/v5/order/create", body={
        "category": "linear", "symbol": "BTCUSDT", "side": "Buy", "orderType": "Market",
        "qty": "0.001"}), "api-demo.bybit.com"),
        (lambda env: order_bybit._request(env, "POST", "/v5/order/cancel-all",
                                          body={"category": "linear", "symbol": "BTCUSDT"}),
         "api-demo.bybit.com")],
    "gateio": [(lambda env: order_gateio._request("POST", "/futures/usdt/orders", env, {
        "contract": "BTC_USDT", "size": 1, "price": "0", "tif": "ioc"}), "api-testnet.gateapi.io"),
        (lambda env: order_gateio._request("POST", "/spot/orders", env, {
            "currency_pair": "BTC_USDT", "side": "buy", "type": "market", "amount": "10",
            "time_in_force": "ioc"}), "api-testnet.gateapi.io"),
        (lambda env: order_gateio._request("DELETE", "/futures/usdt/orders", env,
                                           query="contract=BTC_USDT"), "api-testnet.gateapi.io")],
}

for vid, cases in MUTATING.items():
    mods, flag, creds = VENUES[vid][0], VENUES[vid][1], VENUES[vid][2]
    env = dict(creds, **{flag: "true"})
    for fn, want in cases:
        _reset(mods)
        try:
            fn(env)
        except Exception:
            pass
        muts = [c for c in CALLS if c["method"] in ("POST", "DELETE")]
        ok = bool(muts) and all(urlsplit(c["url"]).hostname == want for c in muts)
        if vid == "okx":
            ok = ok and _okx_simulated() and all(
                json.loads(c["data"]).get("tag") == order_okx.BROKER_TAG for c in muts)
        ok = ok and _attributed(vid)
        what = muts[0]["url"].split("?")[0] if muts else "(no mutating request)"
        check(ok, f"{vid} mutating {what} → {want}, attribution kept")

# the audit line records which environment an order went to
audit = [json.loads(line) for line in open("state/audit.jsonl")] \
    if os.path.exists("state/audit.jsonl") else []
for vid in ("binance", "bybit", "gateio"):
    check(any(a.get("demo") is True for a in audit
              if a.get("event") == "order_attempt"
              and (a.get("symbol") == "BTCUSDT" or a.get("contract") == "BTC_USDT"
                   or a.get("currency_pair") == "BTC_USDT")),
          f"audit order_attempt carries demo=True ({vid})")

print("\nALL OK" if not fails else f"\n{fails} FAILED")
sys.exit(1 if fails else 0)
