"""A BingX market order whose answer is lost, through real reconcile rounds — no network, no keys.

The order call is lib/order_bingx.place_market_order itself under a faked transport (only BingX
URLs are answered), so what reaches lib/portfolio is the exception the lib really raises; the
park is settled by the real venue_wiring.query_parked_order → order_bingx.resolve_unknown_order.
The workspace is tests/check_reconcile_unconfirmed.py's harness; the book is read for venue bingx.

Asserts, per failure (POST read timeout / dropped connection / HTTP 503 / 100500, and the confirm
poll never reading the order):
- the round sends the order POST once; order_errors gets kind order_unconfirmed, not a rejection;
  the notice is 下單結果不明, never "Order failed"; no HALT;
- while BingX cannot find the order (109421) or the query times out: no POST, still parked;
- found FILLED: booked once from BingX's qty and price, park cleared, nothing sent, and later
  rounds neither book it again nor send it;
- found CANCELED with nothing filled: released, nothing booked, the next round trades again.
Remove the lib fix and the first assertion of each case fails (拒單, resent next round).

Run: cd blave-agent && .venv/bin/python tests/check_reconcile_unconfirmed_bingx.py
"""
import contextlib
import io
import json
import os
import socket
import sys
import tempfile
import time
from pathlib import Path

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WS = Path(tempfile.mkdtemp(prefix="reconcile-unconfirmed-bingx-", dir=os.environ.get("SCRATCHPAD") or None))
sys.path.insert(0, ROOT)
os.chdir(WS)
os.symlink(os.path.join(ROOT, "lib"), WS / "lib")
for d in ("state", "manager", "strategies/tw_c"):
    (WS / d).mkdir(parents=True, exist_ok=True)
(WS / ".env").write_text("PAPER_API_KEY=paper\nPAPER_SECRET_KEY=paper\nPAPER_BOUND_TS=1\n"
                         "PAPER_INITIAL_EQUITY=1000\n")
json.dump({"rates": {"TWD": 32.0}, "ts": int(time.time())}, open("state/paper_fx.json", "w"))
(WS / "strategies/tw_c/strategy.py").write_text('MARKET = "spot"\n')
json.dump({"type": "portfolio", "market": "spot", "weights": {"2330": 1.0}},
          open("strategies/tw_c/state.json", "w"))
json.dump({"amounts": {"tw_c": 16_000}, "exchanges": {"tw_c": "bingx"}, "asset_specs": {}},
          open("manager/portfolio_config.json", "w"))

socket.socket.connect = lambda *a, **k: (_ for _ in ()).throw(OSError("offline test"))
import pandas as pd  # noqa: E402
import requests  # noqa: E402
import lib.data as data  # noqa: E402

data.fetch_twstock_price = lambda code, *a: pd.DataFrame({"Close": [2420.0]}, index=pd.to_datetime(["2026-10-16"]))
from lib import guard, order_bingx as ob, paper_data, unconfirmed, portfolio, venue_wiring  # noqa: E402
from lib import order_paper  # noqa: E402

paper_data.tw_session_open = lambda env=None, now=None: True
order_paper.tw_session_open = paper_data.tw_session_open
from manager import reconciler as rec  # noqa: E402

# the book is read and written for the venue the order went to (a real BingX machine: detect_venue)
portfolio.book_venue = lambda: "bingx"

KEY = "2330@spot"
BX_ENV = {"BINGX_API_KEY": "k", "BINGX_SECRET_KEY": "s"}
fails = 0


def check(cond, msg):
    global fails
    print(("ok   " if cond else "FAIL ") + msg)
    fails += 0 if cond else 1


ob.time.sleep = lambda s: None
ob.get_position_mode = lambda env: "oneway"
ob.format_qty = lambda env, symbol, qty, price=None: "0.001"
ob._sync_time = lambda env: None
# the real dispatch reads this workspace's .env (paper keys only); the fake BingX keys go in here
_resolve = getattr(ob, "resolve_unknown_order", None)
if _resolve is not None:
    ob.resolve_unknown_order = lambda env, *a, **k: _resolve({**env, **BX_ENV}, *a, **k)


class Resp:
    def __init__(self, status, body=None, text=None):
        self.status_code, self._body = status, body
        self.text = text if text is not None else str(body)

    def json(self):
        if self._body is None:
            raise ValueError("not json")
        return self._body


BX = {"post": None, "get": None}
POSTS, GETS = [], []
_post, _request = requests.post, requests.request


def answer(x):
    if isinstance(x, BaseException):
        raise x
    return x


def fake_post(url, *a, **k):
    if "bingx" not in url:
        return _post(url, *a, **k)
    POSTS.append(url)
    return answer(BX["post"])


def fake_request(method, url, *a, **k):
    if "bingx" not in url:
        return _request(method, url, *a, **k)
    GETS.append(url)
    return answer(BX["get"])


requests.post, requests.request = fake_post, fake_request


def ok(d):
    return Resp(200, {"code": 0, "msg": "", "data": d})


ACCEPTED = ok({"order": {"orderId": 987654321987654321}})
NOT_FOUND = Resp(200, {"code": 109421, "msg": "order does not exist"})


def order(status, qty, px):
    return ok({"order": {"orderId": 987654321987654321, "status": status, "avgPrice": str(px),
                         "executedQty": str(qty), "origQty": str(qty), "clientOrderId": "x"}})


MODE = {"bingx": False}
CALLS = []
sent = []


PRICE = 2420.0 / 32.0


def place(symbol, signed_diff, asset_spec=None, reduce_only=False, exchange=None, contributors=None):
    """Every leg goes to the BingX lib (what venue_wiring.auto_place_order does on a BingX key: a
    fresh rc… id per call). MODE bingx: the transport answers BX; else it fills in full."""
    CALLS.append((symbol, signed_diff, reduce_only))
    keep = dict(BX)
    if not MODE["bingx"]:
        BX.update(post=ACCEPTED, get=order("FILLED", abs(signed_diff) / PRICE, PRICE))
    try:
        r = ob.place_market_order(BX_ENV, "BTCUSDT", "long" if signed_diff > 0 else "short", 0.001,
                                  client_order_id=venue_wiring._cid(), reduce_only=reduce_only)
    finally:
        BX.update(keep)
    return dict(r, exchange="bingx")


def amount(x):
    json.dump({"amounts": {"tw_c": x}, "exchanges": {"tw_c": "bingx"}, "asset_specs": {}},
              open("manager/portfolio_config.json", "w"))


def round_():
    del CALLS[:]
    with contextlib.redirect_stdout(io.StringIO()):
        portfolio.reconcile(rec._get_positions_guarded, place, threshold=rec.THRESHOLD,
                            send_telegram_fn=sent.append)
    return len(CALLS)


def rows(kind=None):
    try:
        out = json.load(open("manager/order_errors.json"))
    except OSError:
        return []
    return [r for r in out if kind is None or r.get("kind") == kind]


def booked():
    out = []
    try:
        for x in open("manager/orders.jsonl"):
            if "unconfirmed_park_id" in x:
                out.append(json.loads(x))
    except OSError:
        pass
    return out


for _ in range(2):   # the first rounds may only write the own-positions baseline
    if round_():
        break
amount(0)
round_()

target = 16_000
CASES = (
    ("POST read timeout", requests.exceptions.ReadTimeout("read timed out"), None, "fill"),
    ("POST dropped connection", requests.exceptions.ConnectionError("RemoteDisconnected"), None, "none"),
    ("POST HTTP 503", Resp(503, None, "Service Unavailable"), None, "fill"),
    ("POST 100500", Resp(200, {"code": 100500, "msg": "System busy"}), None, "none"),
    ("confirm poll never reads it", ACCEPTED, requests.exceptions.ReadTimeout("t"), "fill"),
)
for label, post, poll, outcome in CASES:
    target += 16_000
    amount(target)
    del POSTS[:], GETS[:], sent[:]
    before, n_booked = {json.dumps(r, sort_keys=True) for r in rows()}, len(booked())
    MODE["bingx"], BX["post"], BX["get"] = True, post, poll or NOT_FOUND
    n = round_()
    pk = list(unconfirmed.load().values())
    pid = unconfirmed.park_id(pk[0]) if pk else None
    fresh = [r for r in rows() if json.dumps(r, sort_keys=True) not in before]
    new = [r for r in fresh if r.get("park_id") == pid]
    check(n == 1 and len(POSTS) == 1 and len(new) == 1 and new[0].get("kind") == "order_unconfirmed"
          and len(pk) == 1 and pk[0]["venue"] == "bingx" and pk[0]["venue_symbol"] == "BTCUSDT"
          and not [r for r in fresh if not r.get("kind")],
          f"{label}: one POST, parked as order_unconfirmed, not a rejection ({len(POSTS)} POSTs, {fresh})")
    check(any("下單結果不明" in x for x in sent) and not any("Order failed" in x for x in sent)
          and not guard.halted(), f"{label}: 下單結果不明 notice, no 'Order failed', no HALT")
    if len(pk) != 1:
        MODE["bingx"] = False
        unconfirmed.resolve("2330", 0) if pk else None
        guard.clear_halt("test") if guard.halted() else None
        continue
    for get_answer in (NOT_FOUND, requests.exceptions.ReadTimeout("t"), Resp(502, None, "Bad Gateway")):
        BX["get"] = get_answer
        del POSTS[:]
        n = round_()
        check(n == 0 and not POSTS and len(unconfirmed.load()) == 1,
              f"{label}: BingX answers {getattr(get_answer, 'status_code', type(get_answer).__name__)}: "
              f"no POST, still parked")
    MODE["bingx"] = False
    del POSTS[:]
    if outcome == "fill":
        qty = pk[0]["signed_diff"] / PRICE
        BX["get"] = order("FILLED", qty, PRICE)
        n = round_()
        b = booked()[n_booked:]
        check(len(b) == 1 and abs(b[0]["legs"][0]["executed_qty"] - qty) < 1e-9 and not unconfirmed.load()
              and n == 0 and not POSTS,
              f"{label}: found FILLED → booked once from BingX's numbers, park cleared, nothing sent ({n}, {b})")
        n = round_()
        check(len(booked()) == n_booked + 1 and n == 0 and not POSTS,
              f"{label}: the next round books nothing more and sends nothing ({n})")
    else:
        BX["get"] = order("CANCELED", 0, 0)
        n = round_()
        check(not unconfirmed.load() and len(booked()) == n_booked and n == 1 and len(POSTS) == 1,
              f"{label}: found CANCELED with nothing filled → released, nothing booked, traded again ({n})")

# a plain BingX rejection is still one
target += 16_000
amount(target)
MODE["bingx"], BX["post"] = True, Resp(200, {"code": 101204, "msg": "Insufficient margin"})
del POSTS[:]
round_()
MODE["bingx"] = False
last = [r for r in rows() if "101204" in str(r.get("error"))]
check(len(POSTS) == 1 and last and last[-1].get("kind") is None and not unconfirmed.load(),
      f"a plain BingX rejection: recorded as one, nothing parked ({len(POSTS)} POSTs, {len(last)} rows, {unconfirmed.load()})")

print("FAILED" if fails else "all ok")
sys.exit(1 if fails else 0)
