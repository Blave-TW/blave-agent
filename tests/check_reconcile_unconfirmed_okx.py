"""An OKX swap market order whose outcome is unknown, through real reconcile rounds: parked, not
reported as 拒單, not sent again; the next rounds query it by clOrdId and book the fill once, or
release it and send the order again — no network, no keys (requests.post / get are faked).

The order path is the real one: lib.portfolio.reconcile → lib.venue_wiring.auto_place_order →
lib.order_okx.place_market_order, and the park is queried through the real
venue_wiring.query_parked_order → order_okx.resolve_unknown_order. Only the transport, the mark,
the position mode and the account's position read are stubbed. Every number is made up.

Asserts:
- POST read timeout: one POST, an order_unconfirmed row (no plain rejection row), the "outcome
  unknown" notice and not "Order failed", parked by client id, no HALT;
- OKX cannot find it yet: no POST, still parked;
- OKX answers FILLED: booked once from OKX's qty and price, park cleared, no POST that round or
  the next (the book holds it);
- POST 50004, then OKX answers canceled with nothing filled: released, nothing booked, the order
  is sent once more and fills — the book ends at the target, neither doubled nor missing.

Run: cd blave-agent && .venv/bin/python tests/check_reconcile_unconfirmed_okx.py
"""
import json
import os
import sys
import tempfile
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WS = tempfile.mkdtemp(prefix="reconcile-unconfirmed-okx-")
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
import lib.order_okx as ok  # noqa: E402
import lib.account_okx as ao  # noqa: E402

fails = 0


def check(cond, msg):
    global fails
    print(("ok   " if cond else "FAIL ") + msg)
    fails += 0 if cond else 1


MARK = 50_000.0
OKX_ENV = {"OKX_API_KEY": "k", "OKX_SECRET_KEY": "s", "OKX_PASSPHRASE": "p"}
venue_wiring.read_env = lambda path=".env": dict(OKX_ENV)
venue_wiring.detect_venue = lambda env: "okx"
ok._sync_time = lambda env: None
ok.get_position_mode = lambda env: "net_mode"
ok.get_mark_price = lambda env, sym: MARK
ok._rules_cache["BTC-USDT-SWAP"] = {"ct_val": 0.01, "lot_sz": "1", "min_sz": 1.0, "tick_sz": "0.1",
                                    "active": True, "equity": False}
_skew = {"s": 0.0}   # the confirm poll's sleeps advance its own clock, not the test's
ok.time = type("T", (), {"time": staticmethod(lambda: time.time() + _skew["s"]),
                         "sleep": staticmethod(lambda s: _skew.__setitem__("s", _skew["s"] + s))})
POS = []   # what the account holds, base units
ao.get_positions = lambda env: [{"symbol": "BTCUSDT", "side": "long", "size": q, "mark_price": MARK}
                                for q in POS if q]


class Resp:
    def __init__(self, status, body=None, text=None):
        self.status_code, self._body = status, body
        self.text = text if text is not None else str(body)

    def json(self):
        if self._body is None:
            raise ValueError("not json")
        return self._body


def okx(rows, code="0", msg=""):
    return Resp(200, {"code": code, "msg": msg, "data": rows})


NOT_FOUND = okx([], code="51603", msg="Order does not exist")
NET = {"post": None, "get": NOT_FOUND}
POSTS, GETS = [], []


def _answer(x):
    if isinstance(x, BaseException):
        raise x
    return x


def _post(url, data=None, headers=None, timeout=None):
    POSTS.append(json.loads(data))
    return _answer(NET["post"])


def _get(url, headers=None, timeout=None):
    GETS.append(url)
    return _answer(NET["get"]) if "/api/v5/trade/order?" in url else okx([])


ok.requests.post, ok.requests.get = _post, _get


def order_row(cid, state, fill_ct, avg):
    return okx([{"ordId": "88", "clOrdId": cid, "state": state, "sz": "1", "accFillSz": fill_ct,
                 "avgPx": avg, "fee": "-0.01", "feeCcy": "USDT"}])


CFG = "manager/portfolio_config.json"
json.dump({"seeded_at": "2026-09-01T00:00:00", "own_only_basis": 1, "symbols": {}},
          open("manager/ledger_seed.json", "w"))
open("strategies/btc_trend/strategy.py", "w").write('MARKET = "swap"\n')
json.dump({"symbol": "BTCUSDT", "position": 1.0, "market": "swap", "updated_at": int(time.time())},
          open("strategies/btc_trend/state.json", "w"))


def amount(x):
    json.dump({"amounts": {"btc_trend": x}, "exchanges": {"btc_trend": "okx"}}, open(CFG, "w"))


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
    return float((portfolio.ledger_positions().get("BTCUSDT") or {}).get("qty") or 0)


def parked_cid(cid):
    return next((e for e in unconfirmed.load().values() if e.get("client_order_id") == cid), None)


# ── POST read timeout → parked, not 拒單 ─────────────────────────────────────
amount(500)
NET["post"] = requests.exceptions.ReadTimeout("read timed out")
n = round_()
cid1 = POSTS[0].get("clOrdId") if POSTS else None
p1 = parked_cid(cid1)
check(n == 1 and POSTS[0]["sz"] == "1" and POSTS[0].get("tag") == ok.BROKER_TAG,
      f"the failing round sends one attributed POST of 1 contract ({POSTS})")
check(len(rows("order_unconfirmed")) == 1 and not [r for r in rows() if not r.get("kind")],
      f"an order_unconfirmed row, no plain rejection row ({rows()})")
check(any("下單結果不明" in x for x in sent) and not any("Order failed" in x or "拒單" in x for x in sent),
      f"the notice says outcome unknown, not 下單失敗／拒單 ({sent})")
check(p1 is not None and p1["venue"] == "okx" and p1["venue_symbol"] == "BTCUSDT" and p1["order_id"] is None,
      f"parked by client id under okx / BTCUSDT ({unconfirmed.load()})")
check(not guard.halted(), "no HALT")

n = round_()
check(n == 0 and any(f"clOrdId={cid1}" in g for g in GETS) and parked_cid(cid1),
      f"OKX cannot find it yet: no POST, queried by clOrdId, still parked ({n}, {GETS})")

NET["get"] = order_row(cid1, "filled", "1", str(MARK))
POS[:] = [0.01]
n = round_()
b = booked()
check(len(b) == 1 and abs(b[0]["legs"][0]["executed_qty"] - 0.01) < 1e-12 and b[0]["legs"][0]["fill_price"] == MARK
      and not unconfirmed.load(), f"FILLED: booked once from OKX's qty (base) and price, park cleared ({b})")
check(n == 0 and abs(book_qty() - 0.01) < 1e-12, f"…and that round sends nothing ({n}, book {book_qty()})")
check(round_() == 0 and len(booked()) == 1, "the next round sends nothing either and books nothing more")

# ── POST 50004 → parked; canceled with nothing filled → released, sent again ──
amount(1000)
NET["post"], NET["get"] = okx([], code="50004", msg="Endpoint request timeout"), NOT_FOUND
n = round_()
cid2 = POSTS[0].get("clOrdId") if POSTS else None
check(n == 1 and cid2 and cid2 != cid1 and parked_cid(cid2) and not [r for r in rows() if not r.get("kind")],
      f"50004: one POST, parked, not a rejection ({n}, {rows()[-1:]})")
check(round_() == 0 and parked_cid(cid2) and len(booked()) == 1, "still unknown: nothing sent, nothing booked")


def _get_after_release(url, headers=None, timeout=None):
    # the released park reads canceled; the resend's confirm poll reads its own fill
    GETS.append(url)
    if "/api/v5/trade/order?" not in url:
        return okx([])
    if f"clOrdId={cid2}" in url:
        return order_row(cid2, "canceled", "0", "")
    return order_row("x", "filled", "1", str(MARK))


ok.requests.get = _get_after_release
NET["post"] = okx([{"ordId": "99", "clOrdId": "x", "sCode": "0"}])
n = round_()
r2 = [r for r in rows("order_unconfirmed") if r.get("park_id") == f"cid:{cid2}"]
check(not unconfirmed.load() and len(booked()) == 1 and r2 and r2[0].get("released") is True
      and r2[0].get("filled") is False, f"canceled with nothing filled: released, nothing booked ({r2})")
check(n == 1 and POSTS[0].get("clOrdId") not in (cid1, cid2),
      f"…and the order is sent once more, under a new client id ({POSTS})")
POS[:] = [0.02]
n = round_()
check(n == 0 and abs(book_qty() - 0.02) < 1e-12,
      f"the book ends at the target: 0.02 BTC, neither doubled nor missing ({n}, {book_qty()})")

print("all checks passed" if not fails else f"FAILED: {fails}")
sys.exit(1 if fails else 0)
