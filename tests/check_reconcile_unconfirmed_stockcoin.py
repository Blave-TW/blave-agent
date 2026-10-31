"""A StockCoin market order whose outcome is unknown, through real reconcile rounds: parked, not
reported as 拒單, not sent again; the next rounds query it by clientOrderId and book the fill once,
or release it and send the order again — no network, no keys (requests.request is faked).

The order path is the real one: lib.portfolio.reconcile → lib.venue_wiring.auto_place_order →
lib.order_stockcoin.place_market_order, and the park is queried through the real
venue_wiring.query_parked_order → order_stockcoin.resolve_unknown_order. Only the transport, the
mark, the contract rules and the account's position read are stubbed. Every number is made up.

Asserts:
- POST read timeout, the clientOrderId lookup answering -2013: one POST, an order_unconfirmed row
  (no plain rejection row), the "outcome unknown" notice and not "Order failed", parked by client
  id under the canonical symbol, no HALT;
- StockCoin still answers -2013 (nothing in the order history either): no POST, still parked;
- StockCoin answers FILLED: booked once from its qty (contracts → base) and price, park cleared,
  no POST that round or the next (the book holds it);
- POST -1007, then the order reads CANCELED with nothing filled: released, nothing booked, the
  order is sent once more and fills — the book ends at the target, neither doubled nor missing;
- an accepted order whose reply shows another contractMultiplier: parked as manual, HALT, no
  rejection row, nothing booked, nothing sent the next round.

Run: cd blave-agent && .venv/bin/python tests/check_reconcile_unconfirmed_stockcoin.py
"""
import json
import os
import sys
import tempfile
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WS = tempfile.mkdtemp(prefix="reconcile-unconfirmed-stockcoin-")
os.environ["BLAVE_AGENT_HOME"] = os.environ["BLAVECLAW_HOME"] = WS
os.environ["BLAVE_AGENT_BASE"] = WS
os.environ["BLAVE_AGENT_WORKSPACE"] = WS
os.environ.pop("BLAVE_AGENT_LOCAL", None)
for d in ("manager", "state", "strategies/nvda_trend"):
    os.makedirs(os.path.join(WS, d), exist_ok=True)
os.symlink(os.path.join(ROOT, "lib"), os.path.join(WS, "lib"))
sys.path.insert(0, ROOT)


def _no_real_env(event, args):
    if event == "open" and os.path.abspath(str(args[0])) == os.path.join(ROOT, ".env"):
        raise PermissionError("the repo .env must never be read by a test")


sys.addaudithook(_no_real_env)
os.chdir(WS)

import requests  # noqa: E402
from types import SimpleNamespace  # noqa: E402
from urllib.parse import parse_qsl, urlsplit  # noqa: E402
from lib import guard, portfolio, unconfirmed, venue_wiring  # noqa: E402
import lib.order_stockcoin as sc  # noqa: E402
import lib.account_stockcoin as acs  # noqa: E402

fails = 0


def check(cond, msg):
    global fails
    print(("ok   " if cond else "FAIL ") + msg)
    fails += 0 if cond else 1


MARK = 180.0
SC_ENV = {"STOCKCOIN_API_KEY": "k", "STOCKCOIN_SECRET_KEY": "s"}
venue_wiring.read_env = lambda path=".env": dict(SC_ENV)
venue_wiring.detect_venue = lambda env: "stockcoin"
sc._sync_time = lambda env: None
sc.get_mark_price = lambda env, sym: MARK
sc.get_contract_rules = lambda env, symbol: {"step": "1", "min_qty": 0.0001, "min_notional": 0.0,
                                             "contract_value": 0.0001}
_skew = {"s": 0.0}   # the confirm poll's sleeps advance its own clock, not the test's
sc.time = SimpleNamespace(time=lambda: time.time() + _skew["s"],
                          sleep=lambda s: _skew.__setitem__("s", _skew["s"] + s),
                          strftime=time.strftime, gmtime=time.gmtime)
POS = []   # what the account holds, base units
acs.get_positions = lambda env: [{"symbol": "NVDAUSDT", "side": "long", "size": q, "mark_price": MARK}
                                 for q in POS if q]


class Resp:
    def __init__(self, status, body=None, text=None):
        self.status_code, self._body = status, body
        self.text = text if text is not None else ("" if body is None else json.dumps(body))

    def json(self):
        if self._body is None:
            raise ValueError("not json")
        return self._body


NOT_FOUND = Resp(400, {"code": -2013, "msg": "Order does not exist"})
NET = {"post": None, "order": lambda q: NOT_FOUND}
POSTS, GETS = [], []


def _request(method, url, headers=None, data=None, timeout=None):
    u = urlsplit(url)
    q = dict(parse_qsl(u.query))
    if method == "POST":
        POSTS.append(dict(parse_qsl(data)))
        x = NET["post"]
        if isinstance(x, BaseException):
            raise x
        return x
    GETS.append((u.path, q))
    if u.path.endswith("/futures/order"):
        return NET["order"](q)
    return Resp(200, [])   # open STOP list, order history, trades


sc.requests.request = _request


def order_row(oid, cid, status, executed, avg):
    return Resp(200, {"orderId": oid, "clientOrderId": cid, "symbol": "NVDA-PERP-USDT", "side": "BUY_OPEN",
                      "status": status, "executedQty": executed, "origQty": "1000", "avgPrice": avg})


CFG = "manager/portfolio_config.json"
json.dump({"seeded_at": "2026-09-01T00:00:00", "own_only_basis": 1, "symbols": {}},
          open("manager/ledger_seed.json", "w"))
open("strategies/nvda_trend/strategy.py", "w").write('MARKET = "swap"\n')
json.dump({"symbol": "NVDAUSDT", "position": 1.0, "market": "swap", "updated_at": int(time.time())},
          open("strategies/nvda_trend/state.json", "w"))


def amount(x):
    json.dump({"amounts": {"nvda_trend": x}, "exchanges": {"nvda_trend": "stockcoin"}}, open(CFG, "w"))


sent = []


def round_():
    del POSTS[:], GETS[:]

    def place(symbol, diff, spec=None, **kw):
        kw.pop("contributors", None)
        return venue_wiring.auto_place_order(symbol, diff, spec, **kw)

    portfolio.reconcile(get_positions_fn=venue_wiring.auto_get_positions, place_order_fn=place,
                        threshold=10, send_telegram_fn=sent.append)
    return len(POSTS)


def rows(kind=None):
    try:
        out = json.load(open("manager/order_errors.json"))
    except OSError:
        return []
    return [r for r in out if kind is None or r.get("kind") == kind]


def booked():
    out = []
    if os.path.exists("manager/orders.jsonl"):
        for x in open("manager/orders.jsonl"):
            if "unconfirmed_park_id" in x:
                out.append(json.loads(x))
    return out


def book_qty():
    return float((portfolio.ledger_positions().get("NVDAUSDT") or {}).get("qty") or 0)


def parked_cid(cid):
    return next((e for e in unconfirmed.load().values() if e.get("client_order_id") == cid), None)


# ── POST read timeout → parked, not 拒單 ─────────────────────────────────────
amount(18)
NET["post"] = requests.exceptions.ReadTimeout("read timed out")
n = round_()
cid1 = POSTS[0].get("clientOrderId") if POSTS else None
p1 = parked_cid(cid1)
check(n == 1 and POSTS[0]["quantity"] == "1000" and POSTS[0]["side"] == "BUY_OPEN" and POSTS[0]["priceType"] == "MARKET",
      f"the failing round sends one market POST of 1000 contracts ({POSTS})")
check(len(rows("order_unconfirmed")) == 1 and not [r for r in rows() if not r.get("kind")],
      f"an order_unconfirmed row, no plain rejection row ({rows()})")
check(any("下單結果不明" in x for x in sent) and not any("Order failed" in x or "拒單" in x for x in sent),
      f"the notice says outcome unknown, not 下單失敗／拒單 ({sent})")
check(p1 is not None and p1["venue"] == "stockcoin" and p1["venue_symbol"] == "NVDAUSDT" and p1["order_id"] is None,
      f"parked by client id under stockcoin / NVDAUSDT ({unconfirmed.load()})")
check(not guard.halted(), "no HALT")

n = round_()
check(n == 0 and any(q.get("clientOrderId") == cid1 for p, q in GETS if p.endswith("/futures/order"))
      and parked_cid(cid1), f"StockCoin cannot find it yet (-2013): no POST, queried by clientOrderId, still parked ({n})")

NET["order"] = lambda q: order_row("88", cid1, "FILLED", "1000", str(MARK))
POS[:] = [0.1]
n = round_()
b = booked()
check(len(b) == 1 and abs(b[0]["legs"][0]["executed_qty"] - 0.1) < 1e-12 and b[0]["legs"][0]["fill_price"] == MARK
      and not unconfirmed.load(), f"FILLED: booked once from StockCoin's qty (base) and price, park cleared ({b})")
check(n == 0 and abs(book_qty() - 0.1) < 1e-12, f"…and that round sends nothing ({n}, book {book_qty()})")
check(round_() == 0 and len(booked()) == 1, "the next round sends nothing either and books nothing more")

# ── POST -1007 → parked; canceled with nothing filled → released, sent again ──
amount(36)
NET["post"], NET["order"] = Resp(400, {"code": -1007, "msg": "TIMEOUT"}), (lambda q: NOT_FOUND)
n = round_()
cid2 = POSTS[0].get("clientOrderId") if POSTS else None
check(n == 1 and cid2 and cid2 != cid1 and parked_cid(cid2) and not [r for r in rows() if not r.get("kind")],
      f"-1007: one POST, parked, not a rejection ({n}, {rows()[-1:]})")
check(round_() == 0 and parked_cid(cid2) and len(booked()) == 1, "still unknown: nothing sent, nothing booked")


def _after_release(q):
    # the released park reads canceled; the resend's confirm poll reads its own fill
    if q.get("clientOrderId") == cid2:
        return order_row("89", cid2, "CANCELED", "0", "0")
    return order_row("99", "x", "FILLED", "1000", str(MARK))


NET["order"] = _after_release
NET["post"] = Resp(200, {"orderId": "99", "clientOrderId": "x", "status": "NEW", "executedQty": "0"})
n = round_()
r2 = [r for r in rows("order_unconfirmed") if r.get("park_id") == f"cid:{cid2}"]
check(not unconfirmed.load() and len(booked()) == 1 and r2 and r2[0].get("released") is True
      and r2[0].get("filled") is False, f"canceled with nothing filled: released, nothing booked ({r2})")
check(n == 1 and POSTS[0].get("clientOrderId") not in (cid1, cid2),
      f"…and the order is sent once more, under a new client id ({POSTS})")
POS[:] = [0.2]
n = round_()
check(n == 0 and abs(book_qty() - 0.2) < 1e-12,
      f"the book ends at the target: 0.2 NVDA, neither doubled nor missing ({n}, {book_qty()})")

# ── accepted, but the reply's contractMultiplier differs → HALT, never resent ──
amount(54)
NET["post"] = Resp(200, {"orderId": "120", "clientOrderId": "x", "status": "NEW", "executedQty": "0"})
NET["order"] = lambda q: Resp(200, {"orderId": "120", "clientOrderId": "x", "symbol": "NVDA-PERP-USDT",
                                    "side": "BUY_OPEN", "status": "FILLED", "executedQty": "1000",
                                    "origQty": "1000", "avgPrice": str(MARK), "contractMultiplier": "0.001"})
plain_before = len([r for r in rows() if not r.get("kind")])
n = round_()
mp = [e for e in unconfirmed.load().values() if str(e.get("order_id")) == "120"]
check(n == 1 and guard.halted() and mp and mp[0].get("manual") is True
      and len([r for r in rows() if not r.get("kind")]) == plain_before and len(booked()) == 1,
      f"multiplier mismatch on an accepted order: one POST, parked as manual, HALT, no rejection row, "
      f"nothing booked ({n}, {mp})")
check(round_() == 0 and abs(book_qty() - 0.2) < 1e-12,
      "the next round sends nothing (HALT) and the book is unchanged")

print("all checks passed" if not fails else f"FAILED: {fails}")
sys.exit(1 if fails else 0)
