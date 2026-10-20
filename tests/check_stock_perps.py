"""Binance US stock perps under BingX's and Bybit's names, both directions — no network.

Every Binance EQUITY symbol in the real 2026-10-20 lists (tests/fixtures/stock_perps_lists.json)
is pushed through venue_name and back through canonical: a name that does not come back is a
position the reconciler reads as flat and buys again. The misses are pinned so a rule change
shows up as a diff, and no Binance coin may ever pick up a stock name. Then the libs' own entry
points (BingX swap name, positions, open orders; Bybit rules, positions, open orders), the BingX
pause hold, and the stock_agreement rejections (Binance -4411, Bybit 110126 — both measured on the
venues' demo accounts).
Run: cd blave-agent && .venv/bin/python tests/check_stock_perps.py
"""
import json, os, sys, tempfile, time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
os.chdir(tempfile.mkdtemp(prefix="stockperps-"))

import requests  # noqa: E402
from lib import (account_bingx, account_bybit, order_binance, order_bingx, order_bybit,  # noqa: E402
                 portfolio, reject_token, stock_perps as sp, venue_wiring as vw)

fails = 0


def check(cond, msg):
    global fails
    print(("ok   " if cond else "FAIL ") + msg)
    fails += 0 if cond else 1


def _no_net(*a, **k):
    raise AssertionError("network call in an offline test")


requests.get = requests.post = requests.request = _no_net

FX = json.load(open(os.path.join(ROOT, "tests", "fixtures", "stock_perps_lists.json")))
BINANCE = {s: (t, b) for s, t, b in FX["binance"]}
BX = [{"symbol": s, "asset": a, "displayName": d, "status": st, "quantityPrecision": 2,
       "pricePrecision": 2, "tradeMinQuantity": 0.01, "tradeMinUSDT": 2, "apiStateOpen": "true"}
      for s, a, d, st in FX["bingx"]]
BY = [{"symbol": s, "symbolType": t, "underlyingTicker": u, "marketRegion": r} for s, t, u, r in FX["bybit"]]


def binance(up):
    sp._binance.update(rows=dict(BINANCE) if up else None, at=time.time() if up else 0.0,
                       failed_at=0.0 if up else time.time())


binance(True)
EQ = sorted(s for s, (t, _) in BINANCE.items() if t == "EQUITY")
COINS = sorted(s for s, (t, _) in BINANCE.items() if t == "COIN")


def resolve(vid, sym, rows):
    try:
        return sp.venue_name(vid, sym, rows)
    except ValueError as e:
        return e


# ── the whole list, both directions ─────────────────────────────────────────
for vid, rows, want_miss in (
        ("bingx", BX, {"BBXUSDT", "QNTXUSDT", "RAMUSDT", "USDEXUSDT"}),
        ("bybit", BY, {"AGPUUSDT", "AKAMUSDT", "BBXUSDT", "BRKBUSDT", "CRMLUSDT", "DISUSDT", "PAYPUSDT",
                       "QNTXUSDT", "STRCUSDT", "STXXUSDT", "USDEXUSDT"})):
    names, misses, bad = {}, set(), []
    venue = {r["symbol"] for r in rows}
    for s in EQ:
        if not s.endswith("USDT"):
            check(sp.venue_name(vid, s, rows) is None, f"{vid}: {s} (not USDT-margined) keeps the plain mapping")
            continue
        got = resolve(vid, s, rows)
        if isinstance(got, ValueError):
            misses.add(s)
            if not str(got).startswith("[order_reject:symbol_unavailable] "):
                bad.append(f"{s}: untagged miss {got}")
        elif got is None or got not in venue:
            bad.append(f"{s} -> {got!r}")
        else:
            names[s] = got
    back = {s: sp.canonical(vid, n, rows) for s, n in names.items()}
    check(not bad, f"{vid}: every Binance EQUITY symbol resolves to a listed row or a tagged miss {bad[:3]}")
    check(all(back[s] == s for s in names),
          f"{vid}: all {len(names)} names read back as the strategy's symbol "
          f"{[(s, names[s], back[s]) for s in names if back[s] != s][:3]}")
    check(len(set(names.values())) == len(names), f"{vid}: no two strategy symbols share one venue row")
    check(misses == want_miss, f"{vid}: misses are exactly the pinned {len(want_miss)} "
                               f"(+{sorted(misses - want_miss)} -{sorted(want_miss - misses)})")
    check(all(sp.venue_name(vid, n, rows) in (None, n) for n in names.values()),
          f"{vid}: mapping a venue name again leaves it as is")
    check(all(sp.venue_name(vid, c, rows) is None for c in COINS),
          f"{vid}: no Binance coin ({len(COINS)}) takes a stock route")

for vid, rows, sym, want in (("bingx", BX, "NVDAUSDT", "NCSKNVDA2USD-USDT"),
                             ("bingx", BX, "AMDUSDT", "NCSKAMD2USD-USDT"),
                             ("bingx", BX, "CSCOUSDT", "NCSKCISCO2USD-USDT"),
                             ("bingx", BX, "SKHYUSDT", "NCSKSKHYP2USD-USDT"),
                             ("bingx", BX, "TSMUSDT", "NCSKTSMU2USD-USDT"),
                             ("bingx", BX, "EWJUSDT", "NCSIEWJ2USD-USDT"),
                             ("bybit", BY, "NVDAUSDT", "NVDAUSDT"),
                             ("bybit", BY, "AMDUSDT", "AMDSTOCKUSDT"),
                             ("bybit", BY, "NOKUSDT", "NOKIAUSDT")):
    check(resolve(vid, sym, rows) == want, f"{vid} {sym} -> {want} (got {resolve(vid, sym, rows)})")
miss = resolve("bingx", "BBXUSDT", BX)
check(isinstance(miss, ValueError) and "BingX 沒有這檔股票永續（BBXUSDT）" in str(miss),
      f"no BingX listing: Chinese reason ({miss})")
def raises_conn(fn):
    try:
        got = fn()
    except requests.exceptions.ConnectionError:
        return True
    return got


# audit P1-2: a second row on a ticker, a rename, a displayName twin — orders refuse, and the old
# position never reads back under the venue's own name (that is "flat" to the reconciler)
two = BX + [{"symbol": "NCSKZZZQ2USD-USDT", "asset": "NCSKZZZQ2USD", "displayName": "NVDA-USDT"}]
check(isinstance(resolve("bingx", "NVDAUSDT", two), ValueError), "BingX displayName twin: the order is refused")
check(raises_conn(lambda: sp.canonical("bingx", "NCSKNVDA2USDUSDT", two)) is True,
      "BingX displayName twin: the NVDA position raises, not read as flat")
renamed = BX + [{"symbol": "NCSKCSCO2USD-USDT", "asset": "NCSKCSCO2USD", "displayName": "CSCO-USDT"}]
check(isinstance(resolve("bingx", "CSCOUSDT", renamed), ValueError),
      "BingX lists NCSKCSCO2USD next to NCSKCISCO2USD: the order is refused, not switched")
check(raises_conn(lambda: sp.canonical("bingx", "NCSKCISCO2USDUSDT", renamed)) is True,
      "BingX rename: the old CISCO position raises, not read as flat")
second = BY + [{"symbol": "AMDXUSDT", "symbolType": "stock", "underlyingTicker": "AMD", "marketRegion": "US"}]
check(isinstance(resolve("bybit", "AMDUSDT", second), ValueError), "Bybit second AMD row: the order is refused")
check(raises_conn(lambda: sp.canonical("bybit", "AMDSTOCKUSDT", second)) is True,
      "Bybit second AMD row: the AMDSTOCKUSDT position raises, not read as flat")
check(sp.canonical("bybit", "CVXSTOCKUSDT", BY) == "CVXSTOCKUSDT",
      "a stock row naming no Binance stock reads as itself (a manual position)")
# audit P1-1: an empty list is a failed read
for vid in ("bingx", "bybit"):
    check(raises_conn(lambda: sp.canonical(vid, "NCSKNVDA2USDUSDT" if vid == "bingx" else "AMDSTOCKUSDT", []))
          is True, f"{vid}: empty contract list -> canonical raises (transient)")
    check(raises_conn(lambda: sp.venue_name(vid, "NVDAUSDT", [])) is True, f"{vid}: empty list -> venue_name raises")
dup = [r for r in BX if r["symbol"] != "NCSKCISCO2USD-USDT"] + [
    {"symbol": "NCSKCSA2USD-USDT", "asset": "NCSKCSA2USD", "displayName": "CSCO-USDT"},
    {"symbol": "NCSKCSB2USD-USDT", "asset": "NCSKCSB2USD", "displayName": "CSCO-USDT"}]
amb = resolve("bingx", "CSCOUSDT", dup)
check(isinstance(amb, ValueError) and "無法確定" in str(amb), f"two displayName matches: refused ({amb})")

# Binance unreadable: plain mapping forward; a renamed row read back raises (never "flat")
binance(False)
check(sp.venue_name("bingx", "NVDAUSDT", BX) is None, "Binance down: BingX keeps the plain mapping")
try:
    sp.canonical("bingx", "NCSKNVDA2USDUSDT", BX)
    check(False, "Binance down: a BingX stock position raises")
except requests.exceptions.ConnectionError:
    check(True, "Binance down: a BingX stock position raises ConnectionError (transient)")
check(sp.canonical("bybit", "NVDAUSDT", BY) == "NVDAUSDT", "Binance down: Bybit bare stock row reads as itself")
try:
    sp.canonical("bybit", "AMDSTOCKUSDT", BY)
    check(False, "Binance down: Bybit AMDSTOCKUSDT raises")
except requests.exceptions.ConnectionError:
    check(True, "Binance down: Bybit AMDSTOCKUSDT raises ConnectionError (transient)")
check(sp.canonical("bingx", "BTCUSDT", BX) == "BTCUSDT", "Binance down: a coin row reads as before")
binance(True)

# ── BingX lib ───────────────────────────────────────────────────────────────
PAUSED = "NCSKSTXX2USD-USDT"
check(any(r["symbol"] == PAUSED and r["status"] == 25 for r in BX), "fixture: STXX is status 25 on BingX")
calls = []


def bx_request(method, path, env, params=None, signed=True, retries=3):
    calls.append(path)
    if path.endswith("/quote/contracts"):
        return BX + [{"symbol": "BTC-USDT", "quantityPrecision": 4, "pricePrecision": 1,
                      "tradeMinQuantity": 0.0001, "tradeMinUSDT": 2, "apiStateOpen": "true", "status": 1}]
    if path.endswith("/trade/openOrders"):
        return {"orders": [{"symbol": "NCSKNVDA2USD-USDT", "orderId": 1}, {"symbol": "BTC-USDT", "orderId": 2}]}
    raise AssertionError(path)


order_bingx._request = bx_request
check(order_bingx._swap_symbol({}, "NVDAUSDT") == "NCSKNVDA2USD-USDT", "order_bingx: NVDAUSDT -> NCSK name")
check(order_bingx._swap_symbol({}, "BTCUSDT") == "BTC-USDT", "order_bingx: BTCUSDT -> BTC-USDT as before")
check(order_bingx.get_contract_rules({}, "NVDAUSDT")["qty_precision"] == 2, "order_bingx: rules of the NCSK row")
check([o["symbol"] for o in order_bingx.get_open_orders({})] == ["NVDAUSDT", "BTCUSDT"],
      "order_bingx: open orders read back under the strategy's names")
check(order_bingx.session_open({}, "STXXUSDT") is False and order_bingx.session_open({}, "NVDAUSDT") is True
      and order_bingx.session_open({}, "BTCUSDT") is True, "order_bingx.session_open: only status 25 is shut")
n = len(calls)
order_bingx.session_open({}, "NVDAUSDT")
check(len(calls) == n, "order_bingx: the contract list is cached between calls")

account_bingx._signed_get = lambda path, env, params=None: [
    {"symbol": "NCSKNVDA2USD-USDT", "positionAmt": "0.5", "positionSide": "LONG", "markPrice": "180"},
    {"symbol": "BTC-USDT", "positionAmt": "-0.01", "positionSide": "SHORT", "markPrice": "60000"}]
account_bingx._public_get = lambda path, params=None: BX
account_bingx._contracts.update(rows=None, at=0.0)
check([p["symbol"] for p in account_bingx.get_positions({})] == ["NVDAUSDT", "BTCUSDT"],
      "account_bingx: NCSKNVDA2USD-USDT position reads as NVDAUSDT")

# ── Bybit lib ───────────────────────────────────────────────────────────────
pub = []


def by_public(env, path, params):
    pub.append(dict(params))
    if "symbol" not in params:
        return {"list": BY, "nextPageCursor": ""}
    return {"list": [{"lotSizeFilter": {"qtyStep": "0.01", "minOrderQty": "0.01"},
                      "priceFilter": {"tickSize": "0.01"}, "symbolType": "stock", "symbol": params["symbol"]}]}


order_bybit._public = by_public
account_bybit._linear_list.update(rows=BY, at=time.time())
order_bybit.get_contract_rules({}, "AMDUSDT")
check(pub[-1].get("symbol") == "AMDSTOCKUSDT", f"order_bybit: AMDUSDT rules read from AMDSTOCKUSDT ({pub[-1]})")
pub.clear()
order_bybit.get_contract_rules({}, "BTCUSDT")
check(pub == [{"category": "linear", "symbol": "BTCUSDT"}], "order_bybit: a coin never reads the full list")
order_bybit._request = lambda env, m, path, params=None, body=None, retries=3: {"list": [
    {"symbol": "AMDSTOCKUSDT", "orderId": "1"}, {"symbol": "BTCUSDT", "orderId": "2"}]}
check([o["symbol"] for o in order_bybit.get_open_orders({})] == ["AMDUSDT", "BTCUSDT"],
      "order_bybit: open orders read back under the strategy's names")

account_bybit._request = lambda env, m, path, params=None: {"list": [
    {"symbol": "AMDSTOCKUSDT", "size": "1", "side": "Buy", "markPrice": "160"},
    {"symbol": "BTCUSDT", "size": "0.01", "side": "Sell", "markPrice": "60000"}]}
account_bybit._linear_list.update(rows=BY, at=time.time())
check([p["symbol"] for p in account_bybit.get_positions({})] == ["AMDUSDT", "BTCUSDT"],
      "account_bybit: AMDSTOCKUSDT position reads as AMDUSDT")

# ── pause hold ──────────────────────────────────────────────────────────────
vw.read_env = lambda path=".env": {}
vw.detect_venue = lambda env: "bingx"
vw.hand_wired_venue = lambda: None
check(vw.paused_symbols({"STXXUSDT", "NVDAUSDT", "BTCUSDT", "STXXUSDT@spot"}) == {"STXXUSDT"},
      "paused_symbols: the paused swap only (spot keys skipped)")
check(portfolio._venue_paused_keys({"STXXUSDT": {"exchange": "bingx"}, "BTCUSDT": {}}, {}) == {"STXXUSDT"},
      "reconcile holds the paused key")
check(portfolio._venue_paused_keys({"STXXUSDT": {"exchange": "paper"}}, {}) == set(), "paper: not held")
vw.detect_venue = lambda env: "okx"
check(vw.paused_symbols({"STXXUSDT"}) == set(), "a venue without session_open: nothing held")

# ── list fetches (audit P1-1) ───────────────────────────────────────────────
class _J:
    status_code = 200
    def __init__(self, body): self.body = body
    def raise_for_status(self): pass
    def json(self): return self.body


pages = []
requests.get = lambda url, headers=None, params=None, timeout=None: _J(pages.pop(0))
account_bybit._linear_list.update(rows=None, at=0.0)
pages[:] = [{"retCode": 10006, "retMsg": "busy", "result": {"list": BY[:3], "nextPageCursor": ""}}]
try:
    account_bybit.linear_rows({}); raised = False
except Exception:
    raised = True
check(raised and account_bybit._linear_list["rows"] is None, "Bybit list retCode != 0 -> raises, nothing cached")
pages[:] = [{"retCode": 0, "result": {"list": [], "nextPageCursor": ""}}]
check(raises_conn(lambda: account_bybit.linear_rows({})) is True and account_bybit._linear_list["rows"] is None,
      "Bybit empty list -> raises, nothing cached")
pages[:] = [{"retCode": 0, "result": {"list": BY[:500], "nextPageCursor": "c2"}},
            {"retCode": 0, "result": {"list": BY[500:], "nextPageCursor": ""}}]
check(len(account_bybit.linear_rows({})) == len(BY), "Bybit list: both pages kept")
pages[:] = [{"retCode": 0, "result": {"list": [], "nextPageCursor": ""}}]
check(len(order_bybit._linear_rows({})) == len(BY) and len(pages) == 1, "order_bybit reads the same cached list")
requests.get = _no_net
order_bingx._contracts.update(rows=None, at=0.0)
order_bingx._request = lambda method, path, env, params=None, signed=True, retries=3: []
try:
    order_bingx._contract_rows({}); raised = False
except order_bingx.BingXError:
    raised = True
check(raised and order_bingx._contracts["rows"] is None, "BingX empty contracts -> raises, nothing cached")

# ── status 25 forbids opening only (audit P1-3) ──────────────────────────────
L = lambda n: {"side": "long", "size": n}
S = lambda n: {"side": "short", "size": n}
hold, close_only = portfolio._paused_split(
    {"ENTRY", "ADD", "REDUCE", "CLOSE", "GONE", "FLIP"},
    {"ENTRY": L(100), "ADD": L(300), "REDUCE": L(50), "CLOSE": L(0), "FLIP": S(100)},
    {"ADD": L(100), "REDUCE": L(100), "CLOSE": L(100), "GONE": L(100), "FLIP": L(100)})
check(hold == {"ENTRY", "ADD"} and close_only == {"FLIP"},
      f"paused: entry/add held, reduce/close/removed go out, a flip only closes ({hold}, {close_only})")

# ── sign_stock_agreement is only ever called by the agent, after the user said yes ──
import re as _re  # noqa: E402
callers = []
for top in ("lib", "manager", "runtime"):
    for dirpath, _, files in os.walk(os.path.join(ROOT, top)):
        for f in files:
            if f.endswith((".py", ".sh", ".ps1", ".js")):
                path = os.path.join(dirpath, f)
                for i, line in enumerate(open(path, errors="replace"), 1):
                    if _re.search(r"sign_stock_agreement\s*\(", line) and not line.lstrip().startswith("def "):
                        callers.append(f"{os.path.relpath(path, ROOT)}:{i}")
check(not callers, f"nothing under lib/ manager/ runtime/ calls sign_stock_agreement ({callers})")


# ── the agreement wall ──────────────────────────────────────────────────────
e = str(order_binance.BinanceError(-4411, "Please sign TradFi-Perps agreement contract", "/fapi/v1/order"))
check(e.startswith("[order_reject:stock_agreement] 要先簽 Binance 股票永續（TradFi-Perps）協議：") and "幫我簽 Binance 股票合約協議" in e,
      f"Binance -4411 -> stock_agreement, Chinese first ({e[:80]})")
e = str(order_bybit.BybitError("bybit /v5/order/create retCode=110126: You must sign the required "
                               "agreement before trading this contract", code=110126))
check(e.startswith("[order_reject:stock_agreement] 要先簽 Bybit 股票永續協議：請用主帳戶"),
      f"Bybit 110126 -> stock_agreement, Chinese first ({e[:80]})")
check(reject_token.plain(e).startswith("要先簽 Bybit"), "the notice text drops the token")
check(reject_token.STOCK_AGREEMENT in reject_token.KINDS, "stock_agreement is a known kind")
check(portfolio._order_error_fresh("AMDUSDT", e, now=1000.0) is True
      and portfolio._order_error_fresh("AMDUSDT", e, now=1060.0) is False,
      "the next round's same refusal sits inside the existing notice cooldown")

# ── signing the Binance agreement (user-consented; stubbed, no network) ─────
class _R:
    def __init__(self, status, text): self.status_code, self.text = status, text
    def json(self): return json.loads(self.text)
_posts, _audits = [], []
_orig_audit = order_binance.guard.audit
order_binance.guard.audit = lambda ev, **kw: _audits.append(ev)
_env = {"BINANCE_API_KEY": "k", "BINANCE_SECRET_KEY": "s"}
def _post_ok(url, data=None, headers=None, timeout=None):
    _posts.append((url, data)); return _R(200, "SUCCESS")
requests.post = _post_ok
for bad in ({}, {"user_consented": False}, {"user_consented": "yes"}):
    try:
        order_binance.sign_stock_agreement(_env, **bad); raised = False
    except (TypeError, PermissionError):
        raised = True
    check(raised and not _posts, f"no user_consented=True ({bad}) -> raises before any request")
check(order_binance.sign_stock_agreement(_env, user_consented=True) is True, "plain-text SUCCESS -> signed")
check(len(_posts) == 1 and _posts[0][0].endswith("/fapi/v1/stock/contract"), "one POST to /fapi/v1/stock/contract")
_keys = sorted(kv.split("=")[0] for kv in _posts[0][1].split("&"))
check(_keys == ["recvWindow", "signature", "timestamp"], f"no parameters besides the signature ({_keys})")
check(_audits == ["stock_agreement_signed"], "the signing is audited")
for status, body, what in ((400, '{"code":-2015,"msg":"Invalid API-key"}', "a JSON error"),
                           (200, "FAILED", "any other text")):
    requests.post = lambda url, data=None, headers=None, timeout=None, _s=status, _b=body: _R(_s, _b)
    try:
        order_binance.sign_stock_agreement(_env, user_consented=True); raised = False
    except order_binance.BinanceError:
        raised = True
    check(raised, f"{what} -> raises, not signed")
requests.post = lambda url, data=None, headers=None, timeout=None: _R(200, "SUCCESS")
try:
    order_binance._send("POST", "/fapi/v1/order", _env); raised = False
except order_binance.BinanceError:
    raised = True
check(raised, "without plain_text a non-JSON reply is still an error")
requests.post = _no_net
order_binance.guard.audit = _orig_audit

print(f"\n{fails} failed")
sys.exit(1 if fails else 0)
