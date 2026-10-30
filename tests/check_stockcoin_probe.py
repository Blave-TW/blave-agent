"""tests/live_stockcoin_verify.py --probe-all against a fake venue — no network, no order.

Asserts: a -1157 contract is recorded api_closed and the next contract is still
ordered, and so is one after a bare -1149; a global error (-1002, or balance
wording in the message) stops before the next contract; a contract that opens
and closes is tradable with its fill price and fees; a close rejected once is
re-closed before the next contract; CLEANUP reads every contract's legs and open
orders after a stop (also after a dropped connection or Ctrl-C) and closes a leg
the probe left behind (exit 2 while it stays open); an account that is not flat
at the start is refused before any order; anything but "y" at the prompt places
nothing; the JSON lands at --out.

Run: cd blave-agent && .venv/bin/python tests/check_stockcoin_probe.py
"""
import builtins
import importlib.util
import json
import os
import sys
import tempfile
from datetime import datetime, timezone
from urllib.parse import parse_qsl, urlsplit

import requests

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
WORK = tempfile.mkdtemp(prefix="stockcoin-probe-")
os.chdir(WORK)
os.environ["BLAVE_AGENT_HOME"] = os.environ["BLAVECLAW_HOME"] = WORK

fails = 0


def check(cond, msg, detail=None):
    global fails
    print(("ok   " if cond else "FAIL ") + msg + ("" if cond or detail is None else f"  {detail}"))
    fails += 0 if cond else 1


class Resp:
    def __init__(self, body, status=200):
        self.status_code = status
        self.text = json.dumps(body)

    def json(self):
        return json.loads(self.text)


CONTRACTS = [{"symbol": s, "baseToken": s.split("-")[0], "lastPrice": px, "bid": px, "ask": px}
             for s, px in (("NVDA-PERP-USDT", "200"), ("SAMSUNG-PERP-USDT", "50"),
                           ("XAU-PERP-USDT", "4000"), ("TSLA-PERP-USDT", "400"))]


class Venue:
    def __init__(self, open_reply, leftover=None, start_legs=None, close_fails=(), msgs=None,
                 query_down=()):
        self.msgs = msgs or {}
        self.query_down = set(query_down)  # venue symbols whose OPEN order's query always times out
        self.open_reply = open_reply      # venue symbol -> "fill" | error code
        self.legs = dict(start_legs or {})  # venue symbol -> contracts long
        self.leftover = leftover          # venue symbol whose close never lands
        self.close_fails = set(close_fails)
        self.calls, self.orders, self.n = [], {}, 0

    def __call__(self, method, url, headers=None, data=None, timeout=None, params=None):
        u = urlsplit(url)
        q = {**dict(parse_qsl(u.query)), **(params or {}), **(dict(parse_qsl(data)) if data else {})}
        method = method.upper()
        path = u.path.replace("/openapi/v1", "")
        self.calls.append((method, path, q))
        if path.endswith("/getContracts"):
            return Resp(CONTRACTS)
        if path.endswith("/contract/ticker/24hr"):
            px = next(c["lastPrice"] for c in CONTRACTS if c["symbol"] == q["symbol"])
            return Resp([{"symbol": q["symbol"], "lastPrice": px, "volume": "0", "quoteVolume": "0"}])
        if path == "/futures/commissionRate":
            return Resp({"symbol": q["symbol"], "openTakerFee": "0.0005", "closeTakerFee": "0.0005"})
        if path == "/futures/orders/open":
            return Resp([])
        if path == "/futures/positions":
            rows = [{"symbol": s, "side": "LONG", "position": str(n), "available": str(n), "lastPrice": "1"}
                    for s, n in self.legs.items() if n and (not q.get("symbol") or q["symbol"] == s)]
            return Resp(rows)
        if path == "/futures/trades":
            return Resp([{"orderId": oid, "fee": "0.01"} for oid in self.orders])
        if path == "/futures/order" and method == "GET":
            if q.get("symbol") in self.query_down and self.orders[q["orderId"]].get("side") == "BUY_OPEN":
                raise requests.exceptions.ReadTimeout("fake query timeout")
            return Resp(self.orders[q["orderId"]])
        if path == "/futures/order" and method == "POST":
            sym, side = q["symbol"], q["side"]
            if side == "BUY_OPEN":
                rep = self.open_reply.get(sym, "fill")
                if isinstance(rep, BaseException):
                    raise rep
                if rep != "fill":
                    return Resp({"code": int(rep), "msg": self.msgs.get(rep, f"fake {rep}")}, 400)
                self.legs[sym] = self.legs.get(sym, 0) + int(q["quantity"])
            else:
                if sym in self.close_fails:
                    self.close_fails.discard(sym)
                    return Resp({"code": -1999, "msg": "fake close failure"}, 400)
                if sym != self.leftover:
                    self.legs[sym] = max(self.legs.get(sym, 0) - int(q["quantity"]), 0)
            self.n += 1
            oid = str(self.n)
            px = next(c["lastPrice"] for c in CONTRACTS if c["symbol"] == sym)
            self.orders[oid] = {"orderId": oid, "clientOrderId": q["clientOrderId"], "status": "FILLED",
                                "executedQty": q["quantity"], "origQty": q["quantity"], "avgPrice": px,
                                "side": side}
            return Resp({"orderId": oid})
        raise AssertionError(f"unmocked {method} {path}")

    def posts(self):
        return [(q["symbol"], q["side"]) for m, p, q in self.calls if m == "POST" and p == "/futures/order"]


env_path = os.path.join(WORK, "stockcoin.env")
with open(env_path, "w") as fh:
    fh.write("STOCKCOIN_API_KEY=not-a-real-key\nSTOCKCOIN_SECRET_KEY=not-a-real-secret\n")
os.chmod(env_path, 0o600)
TODAY = datetime.now(timezone.utc).strftime("%Y-%m-%d")


def run(venue, answer="y", extra=()):
    """Fresh import each run: the script patches requests' adapter and chdirs."""
    requests.request = venue
    requests.get = lambda url, params=None, headers=None, timeout=None: venue("GET", url, headers, None, timeout, params)
    builtins.input = lambda prompt="": answer
    out = os.path.join(WORK, f"probe-{len(venue.calls)}-{id(venue)}.json")
    sys.argv = ["live_stockcoin_verify.py", "--env", env_path, "--trade", "--confirm", TODAY,
                "--probe-all", "--only", "NONE", "--out", out, *extra]
    spec = importlib.util.spec_from_file_location("lsv", os.path.join(ROOT, "tests", "live_stockcoin_verify.py"))
    lsv = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(lsv)
    lsv.time.sleep = lambda s: None
    from lib import order_stockcoin
    order_stockcoin._rules_cache.clear()
    try:
        lsv.main()
        code = 0
    except SystemExit as e:
        code = e.code
    report = json.load(open(out)) if os.path.exists(out) else None
    return code, report


# 1: NVDA fills, SAMSUNG -1157, XAU fills, TSLA -1157 → all four tried, exit 0
v = Venue({"SAMSUNG-PERP-USDT": "-1157", "TSLA-PERP-USDT": "-1157"})
code, rep = run(v)
res = {r["venue_symbol"]: r for r in rep["results"]}
check(code == 0, "all handled, account flat → exit 0", code)
check(res["SAMSUNG-PERP-USDT"]["result"] == "api_closed" and res["TSLA-PERP-USDT"]["result"] == "api_closed",
      "-1157 is recorded 不開放 API", {k: r["result"] for k, r in res.items()})
check(("XAU-PERP-USDT", "BUY_OPEN") in v.posts(), "after a -1157 the next contract is still ordered", v.posts())
n = res["NVDA-PERP-USDT"]
check(n["result"] == "tradable" and n["open"]["avg_price"] == 200.0 and n["close"]["avg_price"] == 200.0
      and n["category"] == "美股" and res["XAU-PERP-USDT"]["category"] == "商品"
      and res["SAMSUNG-PERP-USDT"]["category"] == "韓股", "tradable row carries fill prices and the category", n)
check(v.posts().count(("NVDA-PERP-USDT", "SELL_CLOSE")) == 1, "a tradable contract is closed at once", v.posts())

# 2: a key error or balance wording on SAMSUNG's open → stop; XAU / TSLA never ordered; CLEANUP still reads
for stop_code, stop_msg in (("-1002", None), ("-1149", "insufficient balance")):
    v = Venue({"SAMSUNG-PERP-USDT": stop_code}, msgs={stop_code: stop_msg} if stop_msg else None)
    code, rep = run(v)
    posts = v.posts()
    check(not any(s in ("XAU-PERP-USDT", "TSLA-PERP-USDT") for s, _ in posts),
          f"global error {stop_code} {stop_msg or ''} stops before the next contract", posts)
    i_fail = max(i for i, (m, p, q) in enumerate(v.calls) if m == "POST" and q.get("symbol") == "SAMSUNG-PERP-USDT")
    after = v.calls[i_fail + 1:]
    check(any(p == "/futures/positions" and not q.get("symbol") for m, p, q in after)
          and sum(p == "/futures/orders/open" for m, p, q in after) >= 2,
          f"CLEANUP reads every contract's legs and open orders after the {stop_code} stop")
    check(rep["stopped"] and len(rep["results"]) == 2 and code == 0, "the report says it stopped", rep["stopped"])

# 2b: a bare -1149 (could be one contract's position limit) is recorded and the probe goes on
v = Venue({"SAMSUNG-PERP-USDT": "-1149"})
code, rep = run(v)
check(("XAU-PERP-USDT", "BUY_OPEN") in v.posts() and not rep["stopped"],
      "a bare -1149 is a per-contract error, the next contract is still ordered", v.posts())

# 3: NVDA's close never lands → per-contract re-close, then stop; CLEANUP tries again; exit 2
v = Venue({}, leftover="NVDA-PERP-USDT")
code, rep = run(v)
closes = [p for p in v.posts() if p == ("NVDA-PERP-USDT", "SELL_CLOSE")]
check(code == 2 and len(closes) >= 3 and ("SAMSUNG-PERP-USDT", "BUY_OPEN") not in v.posts(),
      "a leg that will not close stops the probe; CLEANUP retries it; exit 2", (code, v.posts()))

# 4: a close rejected once with a per-contract code is closed by the recheck, and the probe goes on
v = Venue({}, close_fails={"NVDA-PERP-USDT"})
code, rep = run(v)
nv = next(r for r in rep["results"] if r["venue_symbol"] == "NVDA-PERP-USDT")
check(("TSLA-PERP-USDT", "BUY_OPEN") in v.posts() and code == 0 and v.legs.get("NVDA-PERP-USDT") == 0
      and "close failed" in nv["msg"], "a failed close is re-closed before the next contract; the row says so",
      (code, v.posts(), nv["msg"]))

# 4b: a dropped connection (state unknown) and an interrupt both stop, and CLEANUP still runs
for exc, label in ((requests.exceptions.ConnectionError("fake drop"), "a dropped connection"),
                   (KeyboardInterrupt(), "Ctrl-C")):
    v = Venue({"SAMSUNG-PERP-USDT": exc})
    try:
        code, rep = run(v)
    except KeyboardInterrupt:
        code, rep = "interrupted", None
    i_fail = max(i for i, (m, p, q) in enumerate(v.calls) if m == "POST" and q.get("symbol") == "SAMSUNG-PERP-USDT")
    check(not any(s in ("XAU-PERP-USDT", "TSLA-PERP-USDT") for s, _ in v.posts())
          and any(p == "/futures/positions" and not q.get("symbol") for m, p, q in v.calls[i_fail + 1:]),
          f"{label} stops the probe and CLEANUP still reads every contract", (code, v.posts()))

# 4c: the open is accepted but its query times out for the whole confirm window (an
# OrderNotConfirmed that never read the order); the leftover close goes through. Stop anyway,
# never order the next contract on a live key while orders cannot be read
from lib import order_stockcoin as _osc  # noqa: E402
_defaults = _osc._confirm.__defaults__
_osc._confirm.__defaults__ = (0.2,)
v = Venue({}, query_down={"SAMSUNG-PERP-USDT"})
code, rep = run(v)
_osc._confirm.__defaults__ = _defaults
check(("SAMSUNG-PERP-USDT", "BUY_OPEN") in v.posts()
      and not any(s in ("XAU-PERP-USDT", "TSLA-PERP-USDT") for s, _ in v.posts()) and rep and rep["stopped"],
      "an order the query side cannot read stops the probe before the next contract", (code, v.posts()))

# 5: not flat at the start → refused, no order
v = Venue({}, start_legs={"BTC-PERP-USDT": 1})
code, rep = run(v)
check(code == 1 and not v.posts() and rep is None, "an account holding a leg is refused before any order", code)

# 6: anything but y → no order
v = Venue({})
code, rep = run(v, answer="Y ")
check(code == 1 and not v.posts(), "the prompt needs exactly y", code)

# 6b: --symbols narrows the run; a symbol the venue does not list refuses before any order
v = Venue({"SAMSUNG-PERP-USDT": "-1157"})
code, rep = run(v, extra=("--symbols", "samsungusdt,XAUUSDT"))
check(code == 0 and {r["symbol"] for r in rep["results"]} == {"SAMSUNGUSDT", "XAUUSDT"}
      and ("NVDA-PERP-USDT", "BUY_OPEN") not in v.posts(), "--symbols orders only the named contracts", v.posts())
v = Venue({})
code, rep = run(v, extra=("--symbols", "XAUUSDT,NOPEUSDT"))
check(code == 1 and not v.posts(), "--symbols with an unlisted symbol is refused before any order", code)

# 7: --probe-all without --trade is refused
v = Venue({})
requests.request = v
sys.argv = ["x", "--env", env_path, "--probe-all"]
spec = importlib.util.spec_from_file_location("lsv2", os.path.join(ROOT, "tests", "live_stockcoin_verify.py"))
lsv = importlib.util.module_from_spec(spec)
spec.loader.exec_module(lsv)
try:
    lsv.main()
    check(False, "--probe-all without --trade is refused")
except SystemExit as e:
    check("--trade" in str(e.code) and not v.calls, "--probe-all without --trade is refused before any request")

print(f"\n{'FAILED: ' + str(fails) if fails else 'all ok'}")
sys.exit(1 if fails else 0)
