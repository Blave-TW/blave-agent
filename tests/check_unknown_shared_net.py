"""The shared layer around an order whose outcome is unknown (spec order-unknown-outcome §4.5 /
0.1.37): every caller of an order lib parks it — never a rejection, never a resend. No network.

  W1  the wiring: an older lib's OrderNotConfirmed (a plain Exception) out of place_market_order
      is raised as a parkable OrderOutcomeUnknown with the wiring's rc… id and the canonical symbol
  W2  …the same out of place_spot_market_order
  W3  a requests.ReadTimeout before the send (get_mark_price) and out of place_market_order
      itself is NOT wrapped — the wiring cannot tell before the POST from after
  C1  chase: the limit post's answer is lost → parked (order_unconfirmed row), cancelled by its
      client id, no re-post, no market remainder, no kick, no "Chase execution error"
  C2  chase: the market remainder's outcome is unknown → parked once, no crash row, no kick
  S1  close_symbol (generic key): a close of unknown outcome is parked, not 下單失敗, and the
      output does not tell the user to close it by hand
  S2  close_symbol (named key): not parked (nothing would look it up), the row says 結果不明
  F1  close-all spot: a sale of unknown outcome is parked and its book is kept
  F2  close-all netted restore: parked as a netted exit, its book is kept
  F3  close-all on a TW broker (not a perp venue): its plain OrderNotConfirmed is not wrapped

Run: cd blave-agent && .venv/bin/python tests/check_unknown_shared_net.py
"""
import contextlib
import io
import json
import os
import sys
import tempfile
import threading
import types

import requests

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WS = tempfile.mkdtemp(prefix="unknown-net-", dir=os.environ.get("SCRATCHPAD") or None)
for d in ("manager", "state", "lib"):
    os.makedirs(os.path.join(WS, d), exist_ok=True)
sys.path.insert(0, ROOT)


def _no_real_env(event, args):
    if event == "open" and os.path.abspath(str(args[0])) == os.path.join(ROOT, ".env"):
        raise PermissionError("the repo .env must never be read by a test")


sys.addaudithook(_no_real_env)
os.chdir(WS)
from manager import flatten  # noqa: E402  (chdirs to the repo root on import)
os.chdir(WS)
from lib import execute, guard, stock_perps, unconfirmed  # noqa: E402
import lib.portfolio as pf  # noqa: E402
import lib.venue_wiring as vw  # noqa: E402

stock_perps.binance_class = lambda sym: "COIN"
fails = 0


def check(cond, msg):
    global fails
    print(("ok   " if cond else "FAIL ") + msg, flush=True)
    fails += 0 if cond else 1


def reset():
    for p in ("manager/order_errors.json", "manager/orders.jsonl", unconfirmed.PATH,
              "state/execution/kick", "state/HALT"):
        if os.path.exists(p):
            os.remove(p)
    json.dump({"self_ledger": True}, open("manager/portfolio_config.json", "w"))


def errors():
    p = "manager/order_errors.json"
    return json.load(open(p)) if os.path.exists(p) else []


class OrderNotConfirmed(Exception):
    """An order lib from before lib/unconfirmed (gateio / bybit / bitget / stockcoin today)."""


# ── the wiring (§4.5) ────────────────────────────────────────────────────────
fake = types.ModuleType("lib.order_fakex")
MODE = {"mark": None, "place": None}


def _mark(env, sym):
    if MODE["mark"]:
        raise MODE["mark"]
    return 50000.0


def _place_market(env, sym, direction, qty, client_order_id=None, reduce_only=False):
    raise MODE["place"]


def _place_spot(env, sym, side, base_qty=None, quote_qty=None, client_order_id=None):
    raise MODE["place"]


fake.get_mark_price = _mark
fake.place_market_order = _place_market
fake.place_spot_market_order = _place_spot
fake.format_qty = lambda env, s, q, price=None: f"{q:.6f}"
sys.modules["lib.order_fakex"] = fake
vw.read_env = lambda *a, **k: {}
vw.detect_venue = lambda env: "fakex"
vw.instrument_gate = lambda symbol: None
vw._entry_qty = lambda order, env, sym, qty: qty
vw._netted_room = lambda *a, **k: 0.0


def wiring(symbol, signed):
    try:
        vw.auto_place_order(symbol, signed)
    except Exception as e:
        return e
    return None


reset()
MODE.update(mark=None, place=OrderNotConfirmed("order 9 still NEW after 15s"))
e = wiring("BTCUSDT", 100.0)
check(isinstance(e, unconfirmed.OrderOutcomeUnknown) and e.parkable() and e.venue == "fakex"
      and e.venue_symbol == "BTCUSDT" and str(e.client_order_id).startswith("rc")
      and isinstance(e.__cause__, OrderNotConfirmed),
      f"W1 swap: a plain OrderNotConfirmed is raised parkable with the wiring's id ({e!r}, "
      f"{getattr(e, 'venue_symbol', None)}, {getattr(e, 'client_order_id', None)})")
e = wiring("BTCUSDT@spot", 100.0)
check(isinstance(e, unconfirmed.OrderOutcomeUnknown) and e.parkable()
      and e.venue_symbol == "BTCUSDT" and str(e.client_order_id).startswith("rc"),
      f"W2 spot buy: wrapped the same ({e!r})")
MODE.update(mark=requests.exceptions.ReadTimeout("read timed out"), place=None)
e = wiring("BTCUSDT", 100.0)
check(type(e) is requests.exceptions.ReadTimeout,
      f"W3 a read timeout reading the mark (before any send) is not wrapped ({type(e).__name__})")
MODE.update(mark=None, place=requests.exceptions.ReadTimeout("read timed out"))
e = wiring("BTCUSDT", 100.0)
check(type(e) is requests.exceptions.ReadTimeout,
      f"W3 a raw read timeout out of place_market_order is not wrapped either ({type(e).__name__})")
MODE.update(place=ValueError("BTCUSDT qty 0.000001 is below the minimum"))
check(wiring("BTCUSDT", 100.0) is None, "W3 the below-minimum ValueError skip is untouched")

# ── chase ────────────────────────────────────────────────────────────────────
notes = []
execute._notify_fn = notes.append
execute._CHASE_POLL_S, execute._CHASE_TIMEOUT_S = 0.05, 2.0
_real_auto = vw.auto_place_order


class LimitVenue:
    def __init__(self, post_unknown=False):
        self.post_unknown, self.calls = post_unknown, []

    def tools(self):
        return {"venue": "binance", "bbo": lambda: (100.0, 100.1), "place": self.place,
                "status": self.status, "cancel": lambda oid: self.calls.append(("cancel", oid)),
                "cancel_cid": lambda cid: self.calls.append(("cancel_cid", cid)) or
                {"status": "already_gone"}}

    def place(self, *a, **k):
        self.calls.append(("place",))
        if self.post_unknown:
            raise unconfirmed.OrderOutcomeUnknown(
                "order x-52DDFAFNrc1 sent, no answer", venue="binance", venue_symbol="BTCUSDT",
                client_order_id="x-52DDFAFNrc1")
        return False  # below the venue minimum: the chase goes to its market remainder

    def status(self, oid):
        return {"status": "new", "executed_qty": 0.0, "avg_price": 0.0}

    def count(self, name):
        return sum(1 for c in self.calls if c[0] == name)


def chase(v, market=None):
    sent = []

    def _auto(*a, **k):
        sent.append(a)
        if market is not None:
            raise market
        return False
    vw.auto_place_order = _auto
    try:
        execute._chase_thread("BTCUSDT", 100.0, None, False, "binance", [{"strategy": "s1"}],
                              v.tools(), threading.Event())
    finally:
        vw.auto_place_order = _real_auto
    return sent


reset()
del notes[:]
v = LimitVenue(post_unknown=True)
sent = chase(v)
rows = errors()
parks = unconfirmed.load()
check(v.count("place") == 1 and not sent, f"C1 no re-post, no market remainder ({v.calls}, {len(sent)})")
check(("cancel_cid", "x-52DDFAFNrc1") in v.calls, f"C1 cancelled by its client id ({v.calls})")
check(len(parks) == 1 and list(parks.values())[0]["key"] == "BTCUSDT",
      f"C1 the post is parked ({parks})")
check(len(rows) == 1 and rows[0].get("kind") == "order_unconfirmed",
      f"C1 one order_unconfirmed row, no 下單失敗 row ({rows})")
check(not os.path.exists("state/execution/kick") and not os.path.exists("state/HALT"),
      "C1 no kick, no HALT")
check(not any("execution error" in n for n in notes), f"C1 no 'Chase execution error' ({notes})")

reset()
del notes[:]
v = LimitVenue()
sent = chase(v, market=unconfirmed.OrderOutcomeUnknown(
    "order rc2 sent, no answer", venue="binance", venue_symbol="BTCUSDT", client_order_id="rc2"))
rows = errors()
check(len(sent) == 1 and len(unconfirmed.load()) == 1,
      f"C2 the market remainder went once and is parked ({len(sent)}, {unconfirmed.load()})")
check(len(rows) == 1 and rows[0].get("kind") == "order_unconfirmed",
      f"C2 one order_unconfirmed row, no crash row ({rows})")
check(not os.path.exists("state/execution/kick") and not any("execution error" in n for n in notes),
      f"C2 no kick, no 'Chase execution error' ({notes})")

# ── close_symbol ─────────────────────────────────────────────────────────────
sys.path.append(os.path.join(ROOT, "manager"))  # close_symbol imports `flatten` as a sibling
import close_symbol as cs  # noqa: E402

cs.wait_inflight = lambda sym: []
acct = types.ModuleType("lib.account_fakex")
acct.get_equity = lambda env: {"equity": 1000}
acct.get_positions = lambda env: [{"symbol": "BTCUSDT", "side": "long", "size": 0.01,
                                   "mark_price": 70000.0}]
corder = types.ModuleType("lib.order_fakex")
corder.get_open_orders = lambda env, sym: []
corder.get_open_algo_orders = lambda env, sym: []
corder.cancel_all_orders = lambda env, sym: None
corder.format_qty = lambda env, s, q, price=None: "0.01"


def _close(env, sym, side, size, client_order_id=None):
    raise OrderNotConfirmed(f"order {client_order_id} still NEW after 15s")


corder.close_position_partial = _close


def close(generic):
    ctx = cs.Ctx(venue="fakex", sym="BTCUSDT", side="long", env={}, key="k", generic=generic,
                 acct=acct, order=corder)
    out = io.StringIO()
    with contextlib.redirect_stdout(out):
        rc = cs.run_close(ctx)
    return rc, out.getvalue()


reset()
rc, out = close(True)
parks = list(unconfirmed.load().values())
rows = errors()
check(rc == cs.FAILED and len(parks) == 1 and parks[0]["key"] == "BTCUSDT"
      and parks[0]["sign"] == -1 and parks[0]["reduce_only"] is True
      and str(parks[0]["client_order_id"]).startswith("csym"),
      f"S1 generic key: parked as a reduce of the long, by the close's own id ({rc}, {parks})")
check(len(rows) == 1 and rows[0].get("kind") == "order_unconfirmed",
      f"S1 one order_unconfirmed row, no 下單失敗 ({rows})")
check("UNPROTECTED" not in out and "close failed" not in out and "may have filled" in out,
      f"S1 the output says it may have filled, never 'close it now' ({out[-400:]!r})")
reset()
rc, out = close(False)
rows = errors()
check(rc == cs.FAILED and not unconfirmed.load() and len(rows) == 1
      and "結果不明" in rows[0]["error"] and "UNPROTECTED" not in out,
      f"S2 named key: not parked, the row says 結果不明 ({rows})")

# ── close-all ────────────────────────────────────────────────────────────────
forder = types.ModuleType("lib.order_fakex")
forder.get_spot_balances = lambda env: {"ETH": 1.0}
forder.get_spot_price = lambda env, sym: 2000.0
forder.place_spot_market_order = _place_spot
forder.place_market_order = _place_market
forder.format_qty = lambda env, s, q, price=None: "1"
MODE.update(place=OrderNotConfirmed("order still NEW"))
reset()
with contextlib.redirect_stderr(io.StringIO()):
    closed, errs, done, unclosed = flatten._flatten_spot(
        "fakex", forder, {}, {"ETHUSDT": {"side": "long", "qty": 0.5}})
parks = list(unconfirmed.load().values())
rows = errors()
check(errs == 1 and "ETHUSDT@spot" in unclosed and "ETHUSDT@spot" not in done
      and len(parks) == 1 and parks[0]["key"] == "ETHUSDT@spot" and parks[0]["sign"] == -1,
      f"F1 close-all spot: parked, its book kept ({errs}, {unclosed}, {parks})")
check(len(rows) == 1 and rows[0].get("kind") == "order_unconfirmed",
      f"F1 one order_unconfirmed row, no 下單失敗 ({rows})")

reset()
vw._net_position_mode = lambda *a, **k: True
done, unclosed = set(), set()
with contextlib.redirect_stderr(io.StringIO()):
    c3, e3 = flatten._restore_netted(
        "fakex", forder, {}, [{"symbol": "BTCUSDT", "side": "short", "size": 0.02}],
        {"BTCUSDT": {"side": "long", "qty": 0.01, "netted": 0.01}}, done, unclosed)
parks = list(unconfirmed.load().values())
rows = errors()
check(e3 == 1 and "BTCUSDT" in unclosed and len(parks) == 1 and parks[0]["netted_exit"] is True
      and parks[0]["sign"] == -1,
      f"F2 netted restore: parked as a netted exit reducing the bot's long ({e3}, {parks})")
check(len(rows) == 1 and rows[0].get("kind") == "order_unconfirmed",
      f"F2 one order_unconfirmed row, no 下單失敗 ({rows})")

reset()
with contextlib.redirect_stderr(io.StringIO()):
    closed, errs, done, unclosed = flatten._flatten_spot(
        "sinopac", forder, {}, {"ETHUSDT": {"side": "long", "qty": 0.5}})
rows = errors()
check(errs == 1 and not unconfirmed.load() and len(rows) == 1 and not rows[0].get("kind"),
      f"F3 a TW broker's plain OrderNotConfirmed is not parked as a crypto order ({rows})")

print("\n" + ("all ok" if not fails else f"{fails} FAILED"))
sys.exit(1 if fails else 0)
