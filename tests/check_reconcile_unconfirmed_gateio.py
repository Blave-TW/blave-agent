"""A Gate.io futures market order whose outcome is unknown, through real reconcile rounds: parked,
not reported as 拒單, not sent again; the next rounds query it by text, then by the account's
fills, and book the fill once, or release it and send the order again — no network, no keys
(requests.request is faked).

The order path is the real one: lib.portfolio.reconcile → lib.venue_wiring.auto_place_order →
lib.order_gateio.place_market_order, and the park is queried through the real
venue_wiring.query_parked_order → order_gateio.resolve_unknown_order. Only the transport, the
mark, and the account's position read are stubbed. Every number is made up.

Asserts:
- POST read timeout: one attributed POST, an order_unconfirmed row (no plain rejection row), the
  "outcome unknown" notice and not "Order failed", parked by the full `t-` text, no HALT;
- Gate.io cannot find it and no fill of ours: no POST, still parked;
- a fill carrying our text appears: booked once from Gate.io's qty (base) and price, park
  cleared, no POST that round or the next (the book holds it);
- POST HTTP 502, then Gate.io answers finished with nothing filled: released, nothing booked, the
  order is sent once more and fills — the book ends at the target, neither doubled nor missing.

Run: cd blave-agent && .venv/bin/python tests/check_reconcile_unconfirmed_gateio.py
"""
import json
import os
import sys
import tempfile
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WS = tempfile.mkdtemp(prefix="reconcile-unconfirmed-gateio-")
os.environ["BLAVE_AGENT_HOME"] = os.environ["BLAVECLAW_HOME"] = WS
os.environ["BLAVE_AGENT_BASE"] = WS
os.environ["BLAVE_AGENT_WORKSPACE"] = WS
os.environ.pop("BLAVE_AGENT_LOCAL", None)
for d in ("manager", "state", "strategies/btc_trend"):
    os.makedirs(os.path.join(WS, d), exist_ok=True)
os.symlink(os.path.join(ROOT, "lib"), os.path.join(WS, "lib"))
sys.path.insert(0, ROOT)


def _no_real_env(event, args):
    if event == "open" and os.path.abspath(str(args[0])) == os.path.join(ROOT, ".env"):
        raise PermissionError("the repo .env must never be read by a test")


sys.addaudithook(_no_real_env)
os.chdir(WS)

import requests  # noqa: E402
from lib import guard, portfolio, unconfirmed, venue_wiring  # noqa: E402
import lib.order_gateio as gt  # noqa: E402
import lib.account_gateio as ag  # noqa: E402

fails = 0


def check(cond, msg):
    global fails
    print(("ok   " if cond else "FAIL ") + msg)
    fails += 0 if cond else 1


MARK = 50_000.0
GATE_ENV = {"GATEIO_API_KEY": "k", "GATEIO_SECRET_KEY": "s"}
venue_wiring.read_env = lambda path=".env": dict(GATE_ENV)
venue_wiring.detect_venue = lambda env: "gateio"
gt._sync_time = lambda env: None
gt._pos_mode_cache["k"] = "single"
gt.get_mark_price = lambda env, sym: MARK
gt._rules_cache["fut:BTC_USDT"] = {"multiplier": "0.0001", "min_ct": 1, "tick": "0.1",
                                   "active": True, "equity": False}
_skew = {"s": 0.0}   # the confirm poll's sleeps advance its own clock, not the test's
gt.time = type("T", (), {"time": staticmethod(lambda: time.time() + _skew["s"]),
                         "sleep": staticmethod(lambda s: _skew.__setitem__("s", _skew["s"] + s)),
                         "strftime": staticmethod(time.strftime)})
POS = []   # what the account holds, base units
ag.get_positions = lambda env: [{"symbol": "BTCUSDT", "side": "long", "size": q, "mark_price": MARK}
                                for q in POS if q]


class Resp:
    def __init__(self, status, body=None, text=None):
        self.status_code, self._body = status, body
        self.ok = 200 <= status < 400
        self.text = text if text is not None else ("" if body is None else json.dumps(body))

    def json(self):
        if self._body is None:
            raise ValueError("not json")
        return self._body


NOT_FOUND = Resp(404, {"label": "ORDER_NOT_FOUND", "message": "Order not found"})
NET = {"post": None, "order": lambda url: NOT_FOUND, "trades": []}
POSTS, GETS, HEADERS = [], [], []


def _answer(x):
    if isinstance(x, BaseException):
        raise x
    return x


def _request(method, url, headers=None, data=None, timeout=None):
    HEADERS.append(headers or {})
    if method == "POST":
        POSTS.append(json.loads(data))
        return _answer(NET["post"])
    GETS.append(url)
    if "/my_trades_timerange" in url:
        return Resp(200, NET["trades"] if "offset=0" in url else [])
    if "/my_trades" in url:
        return Resp(200, [])
    if "/futures/usdt/orders/" in url:
        return _answer(NET["order"](url))
    return Resp(200, [])


gt.requests.request = _request


def order_row(oid, text, left, fill_price):
    return Resp(200, {"id": oid, "contract": "BTC_USDT", "size": 100, "left": left,
                      "status": "finished", "finish_as": "filled" if left == 0 else "ioc",
                      "fill_price": fill_price, "text": text})


CFG = "manager/portfolio_config.json"
json.dump({"seeded_at": "2026-09-01T00:00:00", "own_only_basis": 1, "symbols": {}},
          open("manager/ledger_seed.json", "w"))
open("strategies/btc_trend/strategy.py", "w").write('MARKET = "swap"\n')
json.dump({"symbol": "BTCUSDT", "position": 1.0, "market": "swap", "updated_at": int(time.time())},
          open("strategies/btc_trend/state.json", "w"))


def amount(x):
    json.dump({"amounts": {"btc_trend": x}, "exchanges": {"btc_trend": "gateio"}}, open(CFG, "w"))


sent = []


def round_():
    del POSTS[:], GETS[:], HEADERS[:]

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
    return float((portfolio.ledger_positions().get("BTCUSDT") or {}).get("qty") or 0)


def parked_cid(cid):
    return next((e for e in unconfirmed.load().values() if e.get("client_order_id") == cid), None)


# ── POST read timeout → parked, not 拒單 ─────────────────────────────────────
amount(500)
NET["post"] = requests.exceptions.ReadTimeout("read timed out")
n = round_()
cid1 = POSTS[0].get("text") if POSTS else None
p1 = parked_cid(cid1)
check(n == 1 and POSTS[0]["size"] == 100 and POSTS[0]["price"] == "0" and POSTS[0]["tif"] == "ioc"
      and all(h.get("X-Gate-Channel-Id") == "blave" for h in HEADERS),
      f"the failing round sends one attributed POST of 100 contracts ({POSTS})")
check(len(rows("order_unconfirmed")) == 1 and not [r for r in rows() if not r.get("kind")],
      f"an order_unconfirmed row, no plain rejection row ({rows()})")
check(any("下單結果不明" in x for x in sent) and not any("Order failed" in x or "拒單" in x for x in sent),
      f"the notice says outcome unknown, not 下單失敗／拒單 ({sent})")
check(p1 is not None and str(cid1).startswith("t-") and p1["venue"] == "gateio"
      and p1["venue_symbol"] == "BTCUSDT" and p1["order_id"] is None,
      f"parked by the full text under gateio / BTCUSDT ({unconfirmed.load()})")
check(not guard.halted(), "no HALT")

n = round_()
check(n == 0 and any(g.endswith(f"/orders/{cid1}") for g in GETS)
      and any("/my_trades_timerange" in g for g in GETS) and parked_cid(cid1),
      f"Gate.io cannot find it, no fill of ours: no POST, queried by text then fills, still parked ({n}, {GETS})")

NET["trades"] = [{"trade_id": "1", "order_id": "88", "contract": "BTC_USDT", "size": 100,
                  "price": str(MARK), "text": cid1},
                 {"trade_id": "2", "order_id": "5", "contract": "BTC_USDT", "size": 300,
                  "price": "1", "text": "t-someone-else"}]
POS[:] = [0.01]
n = round_()
b = booked()
check(len(b) == 1 and abs(b[0]["legs"][0]["executed_qty"] - 0.01) < 1e-12 and b[0]["legs"][0]["fill_price"] == MARK
      and not unconfirmed.load(), f"a fill with our text: booked once from Gate.io's qty (base) and price, park cleared ({b})")
check(n == 0 and abs(book_qty() - 0.01) < 1e-12, f"…and that round sends nothing ({n}, book {book_qty()})")
check(round_() == 0 and len(booked()) == 1, "the next round sends nothing either and books nothing more")

# ── POST HTTP 502 → parked; finished with nothing filled → released, sent again ──
amount(1000)
NET["post"], NET["trades"] = Resp(502, None, "Bad Gateway"), []
NET["order"] = lambda url: NOT_FOUND
n = round_()
cid2 = POSTS[0].get("text") if POSTS else None
check(n == 1 and cid2 and cid2 != cid1 and parked_cid(cid2) and not [r for r in rows() if not r.get("kind")],
      f"HTTP 502: one POST, parked, not a rejection ({n}, {rows()[-1:]})")
check(round_() == 0 and parked_cid(cid2) and len(booked()) == 1, "still unknown: nothing sent, nothing booked")

# the parked text now reads finished with nothing filled; the resend's poll reads its own fill
NET["order"] = lambda url: (order_row(91, cid2, 100, "0") if url.endswith(f"/orders/{cid2}")
                            else order_row(99, "t-x", 0, str(MARK)))
NET["post"] = Resp(201, {"id": 99, "contract": "BTC_USDT", "size": 100, "left": 100, "status": "open"})
n = round_()
r2 = [r for r in rows("order_unconfirmed") if r.get("park_id") == f"cid:{cid2}"]
check(not unconfirmed.load() and len(booked()) == 1 and r2 and r2[0].get("released") is True
      and r2[0].get("filled") is False, f"finished with nothing filled: released, nothing booked ({r2})")
check(n == 1 and POSTS[0].get("text") not in (cid1, cid2),
      f"…and the order is sent once more, under a new text ({POSTS})")
POS[:] = [0.02]
n = round_()
check(n == 0 and abs(book_qty() - 0.02) < 1e-12,
      f"the book ends at the target: 0.02 BTC, neither doubled nor missing ({n}, {book_qty()})")

print("all checks passed" if not fails else f"FAILED: {fails}")
sys.exit(1 if fails else 0)
