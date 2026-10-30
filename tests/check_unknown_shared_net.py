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
  T1  the limit toolkit stores the canonical symbol on a lib's unknown (BingX said BTC-USDT)
  L1  a parked chase limit (limit=True) that reads unfinished is cancelled each round, then
      booked from its end; a cancel that fails keeps it parked and held
  F1/F2/F4  every close-all park holds the book's COST of what it closed (_settle_parked held)
  F4  close-all's main pass wraps an older lib's plain OrderNotConfirmed and parks it
  B1  close-all again over a parked close: the same close is not sent a second time
  D1  close_symbol over a whole account row larger than the book: the fill is booked up to
      the book's own quantity — never through zero into a phantom opposite position

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
                "netted_room": lambda buy: 0.4,
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
check(len(parks) == 1 and list(parks.values())[0]["key"] == "BTCUSDT"
      and list(parks.values())[0].get("limit") is True
      and list(parks.values())[0]["netted_room"] == 0.4,
      f"C1 the post is parked as a limit, with the entry's netted room ({parks})")
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


# ── the limit toolkit ────────────────────────────────────────────────────────
lim = types.ModuleType("lib.order_fakex")
lim.get_bbo = lambda env, sym: {"bid": 100.0, "ask": 100.1}
lim.get_order = lambda env, sym, oid: {}
lim.cancel_order = lambda env, sym, order_id=None, client_order_id=None: {}


def _limit_unknown(env, sym, direction, qty, price, client_order_id=None, reduce_only=False,
                   post_only=False):
    raise unconfirmed.OrderOutcomeUnknown("sent, no answer", venue="fakex",
                                          venue_symbol="BTC-USDT", client_order_id=client_order_id)


lim.place_limit_order = _limit_unknown
sys.modules["lib.order_fakex"] = lim
tk = vw.auto_limit_toolkit("BTCUSDT")
try:
    tk["place"](100.0, 100.0, None, True)
    e = None
except Exception as x:
    e = x
check(isinstance(e, unconfirmed.OrderOutcomeUnknown) and e.venue_symbol == "BTCUSDT"
      and "cancel_cid" in tk,
      f"T1 toolkit: the unknown carries the canonical symbol, cancel_cid offered "
      f"({getattr(e, 'venue_symbol', None)}, {sorted(tk)})")
sys.modules["lib.order_fakex"] = fake

# ── a parked limit is cancelled until it ends ────────────────────────────────
lx = types.ModuleType("lib.order_limitx")
LX = {"cancels": [], "cancel_ok": True, "cancelled": False}


def _lx_cancel(env, sym, order_id=None, client_order_id=None):
    LX["cancels"].append(client_order_id)
    if not LX["cancel_ok"]:
        raise requests.exceptions.ConnectionError("reset")
    LX["cancelled"] = True
    return {"status": "canceled"}


lx.cancel_order = _lx_cancel
lx.resolve_unknown_order = lambda env, sym, order_id=None, client_order_id=None, parked_at=None: \
    (0.002, 100.0) if LX["cancelled"] else None
sys.modules["lib.order_limitx"] = lx


def park_limit():
    err = unconfirmed.OrderOutcomeUnknown("sent", venue="limitx", venue_symbol="BTCUSDT",
                                          client_order_id="rcL1")
    return pf.park_or_halt("BTCUSDT", "limitx", err, -50.0, True, sign=-1, limit=True)


reset()
LX.update(cancels=[], cancel_ok=False, cancelled=False)
park_limit()
held = pf._settle_parked()
check(LX["cancels"] == ["rcL1"] and len(unconfirmed.load()) == 1 and held == {"BTCUSDT": 50.0},
      f"L1 cancel fails: tried once by client id, still parked and held ({LX['cancels']}, {held})")
LX["cancel_ok"] = True
held = pf._settle_parked()
booked = [json.loads(x) for x in open("manager/orders.jsonl")] if os.path.exists("manager/orders.jsonl") else []
check(LX["cancels"] == ["rcL1", "rcL1"] and not unconfirmed.load() and held == {}
      and len(booked) == 1 and booked[0]["legs"][0]["signed_qty"] == -0.002,
      f"L1 next round: cancelled, its partial fill booked from the venue, released ({booked}, {held})")

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
def still_held():
    return pf._settle_parked(query=lambda entry: None, cancel=lambda entry: False)


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
        "fakex", forder, {}, {"ETHUSDT": {"side": "long", "qty": 0.5, "size": 1000.0}})
parks = list(unconfirmed.load().values())
rows = errors()
check(errs == 1 and "ETHUSDT@spot" in unclosed and "ETHUSDT@spot" not in done
      and len(parks) == 1 and parks[0]["key"] == "ETHUSDT@spot" and parks[0]["sign"] == -1,
      f"F1 close-all spot: parked, its book kept ({errs}, {unclosed}, {parks})")
check(parks and parks[0]["signed_diff"] == -1000.0 and still_held() == {"ETHUSDT@spot": 1000.0},
      f"F1 the park holds the book's cost of the 0.5 sold (1000), not 0 ({parks and parks[0]['signed_diff']})")
check(len(rows) == 1 and rows[0].get("kind") == "order_unconfirmed",
      f"F1 one order_unconfirmed row, no 下單失敗 ({rows})")

reset()
vw._net_position_mode = lambda *a, **k: True
done, unclosed = set(), set()
with contextlib.redirect_stderr(io.StringIO()):
    c3, e3 = flatten._restore_netted(
        "fakex", forder, {}, [{"symbol": "BTCUSDT", "side": "short", "size": 0.02}],
        {"BTCUSDT": {"side": "long", "qty": 0.01, "netted": 0.01, "size": 700.0}}, done, unclosed)
parks = list(unconfirmed.load().values())
rows = errors()
check(e3 == 1 and "BTCUSDT" in unclosed and len(parks) == 1 and parks[0]["netted_exit"] is True
      and parks[0]["sign"] == -1,
      f"F2 netted restore: parked as a netted exit reducing the bot's long ({e3}, {parks})")
check(parks and parks[0]["signed_diff"] == -700.0 and still_held() == {"BTCUSDT": 700.0},
      f"F2 the park holds the netted share's book cost (700), not 0 ({parks and parks[0]['signed_diff']})")
check(len(rows) == 1 and rows[0].get("kind") == "order_unconfirmed",
      f"F2 one order_unconfirmed row, no 下單失敗 ({rows})")

reset()
with contextlib.redirect_stderr(io.StringIO()):
    closed, errs, done, unclosed = flatten._flatten_spot(
        "sinopac", forder, {}, {"ETHUSDT": {"side": "long", "qty": 0.5, "size": 1000.0}})
rows = errors()
check(errs == 1 and not unconfirmed.load() and len(rows) == 1 and not rows[0].get("kind"),
      f"F3 a TW broker's plain OrderNotConfirmed is not parked as a crypto order ({rows})")


# ── close-all's main pass, end to end ────────────────────────────────────────
def book(qty, cost, legacy=False):
    json.dump({"seeded_at": "2026-09-01T00:00:00", "own_only_basis": 1, "symbols": {}},
              open("manager/ledger_seed.json", "w"))
    leg = {"signed_diff": cost} if legacy else {"signed_diff": cost, "signed_qty": qty,
                                                "executed_qty": qty}
    open("manager/orders.jsonl", "w").write(json.dumps(
        {"ts": "2026-09-02T00:00:00", "symbol": "BTCUSDT", "exchange": "fakex",
         "legs": [leg]}) + "\n")
    json.dump({"amounts": {"btc": cost}, "exchanges": {"btc": "fakex"}},
              open("manager/portfolio_config.json", "w"))


def own_qty():
    return float((pf.ledger_positions("fakex").get("BTCUSDT") or {}).get("qty") or 0)


ACCT = {"size": 0.01}
facct = types.ModuleType("lib.account_fakex")
facct.get_positions = lambda env: [{"symbol": "BTCUSDT", "side": "long", "size": ACCT["size"],
                                    "mark_price": 50000.0}]
facct.get_equity = lambda env: {"equity": 1000}
fmain = types.ModuleType("lib.order_fakex")
CLOSES = []
MAIN = {"fill": False}


def _main_close(env, sym, side, size, client_order_id=None):
    CLOSES.append((sym, side, size))
    if MAIN["fill"]:
        return {"status": "filled", "executed_qty": size, "avg_price": 70000.0}
    raise OrderNotConfirmed(f"order {client_order_id} still NEW after 15s")


fmain.close_position_partial = _main_close
fmain.format_qty = lambda env, s, q, price=None: "0.01"
for name in ("lib/account_fakex.py", "lib/order_fakex.py"):
    open(name, "w").close()
sys.modules["lib.account_fakex"], sys.modules["lib.order_fakex"] = facct, fmain
flatten._read_env = lambda path=".env": {"FAKEX_API_KEY": "x", "FAKEX_SECRET_KEY": "x"}
flatten._wait_for_inflight = lambda *a, **k: []
_real_query = vw.query_parked_order
vw.query_parked_order = lambda entry: None


def close_all():
    flatten._LOCK = None
    del CLOSES[:]
    with contextlib.redirect_stderr(io.StringIO()):
        ok = flatten.flatten()
    guard.clear_halt("test")
    return ok


def park_close(cost, venue="fakex", reduce_only=True):
    err = unconfirmed.OrderOutcomeUnknown("sent", venue=venue, venue_symbol="BTCUSDT",
                                          client_order_id=f"rcP{cost}{venue}")
    pf.park_or_halt("BTCUSDT", venue, err, -cost if reduce_only else cost, reduce_only,
                    sign=-1 if reduce_only else 1)


reset()
book(0.01, 700.0)
ACCT["size"], MAIN["fill"] = 0.01, False
ok = close_all()
parks = list(unconfirmed.load().values())
check(ok is False and len(CLOSES) == 1 and len(parks) == 1 and parks[0]["key"] == "BTCUSDT"
      and parks[0]["signed_diff"] == -700.0 and str(parks[0]["client_order_id"]).startswith("flat"),
      f"F4 main pass: an older lib's OrderNotConfirmed is parked at the book's cost 700, not the "
      f"500 at the mark ({CLOSES}, {parks})")
check(abs(own_qty() - 0.01) < 1e-12, f"F4 its book is kept ({pf.ledger_positions('fakex')})")
check(not [r for r in errors() if not r.get("kind")], f"F4 no 下單失敗 row ({errors()})")
ok = close_all()
check(ok is False and CLOSES == [] and len(unconfirmed.load()) == 1,
      f"B1 close-all again over a parked close of the whole row: nothing sent ({CLOSES})")
check(any(r.get("close_all") and r.get("kind") == "order_unconfirmed" and "那部分沒平" in r["error"]
          for r in errors()), f"B1 …and the row says that part was not closed ({errors()[-1:]})")

reset()
book(0.02, 1400.0)
ACCT["size"], MAIN["fill"] = 0.02, False
close_all()
parks = list(unconfirmed.load().values())
check(len(CLOSES) == 1 and CLOSES[0][2] == 0.02 and parks and parks[0]["signed_diff"] == -1400.0,
      f"F5 a whole 0.02 / 1400 close of unknown outcome holds its cost 1400 ({CLOSES}, {parks})")
reset()
book(0.02, 1400.0)
ACCT["size"] = 0.01  # the account shows half the book: the close's cost is half of it
close_all()
parks = list(unconfirmed.load().values())
check(len(CLOSES) == 1 and CLOSES[0][2] == 0.01 and parks and parks[0]["signed_diff"] == -700.0,
      f"F5 0.01 closed of a 0.02 / 1400 book: the park holds 700, not 1400 ({CLOSES}, {parks})")

reset()
book(0.02, 1400.0)
ACCT["size"], MAIN["fill"] = 0.02, True
park_close(700.0)
ok = close_all()
check(len(CLOSES) == 1 and abs(CLOSES[0][2] - 0.01) < 1e-12 and abs(own_qty() - 0.01) < 1e-12,
      f"A1 book 0.02 / 1400 with a −700 close parked: the other 0.01 is closed, the parked "
      f"0.01 stays in the book ({CLOSES}, {own_qty()})")
check(ok is False and any("那部分沒平" in r["error"] for r in errors()),
      f"A1 …and the row says the parked part was not closed ({errors()[-1:]})")
reset()
book(0.02, 1400.0)
park_close(300.0, reduce_only=False)
close_all()
check(len(CLOSES) == 1 and abs(CLOSES[0][2] - 0.02) < 1e-12 and own_qty() == 0,
      f"A2 a parked ENTRY holds nothing back: the whole 0.02 is closed ({CLOSES}, {own_qty()})")
reset()
book(0.02, 1400.0)
park_close(1400.0, venue="otherx")
close_all()
check(len(CLOSES) == 1 and abs(CLOSES[0][2] - 0.02) < 1e-12,
      f"A3 a close parked on another venue holds nothing back here ({CLOSES})")
reset()
book(0.02, 1400.0)
park_close(1400.0)
open(unconfirmed.PATH, "w").write("{not json")
ok = close_all()
check(ok is False and CLOSES == [] and any("讀不到" in r["error"] for r in errors()),
      f"C3 the park file unreadable: nothing is closed, the row says why ({CLOSES}, {errors()[-1:]})")
reset()
book(0.02, 1400.0)
_settle = pf._settle_parked
pf._settle_parked = lambda *a, **k: None  # the round's own read failed (a lock held too long)
ok = close_all()
pf._settle_parked = _settle
check(ok is False and CLOSES == [], f"C4 the opening settle could not read the parks: nothing closed ({CLOSES})")
MAIN["fill"] = False

# spot and netted: only the unparked share goes
SOLD = []
forder.place_spot_market_order = lambda env, sym, side, base_qty=None, quote_qty=None, \
    client_order_id=None: SOLD.append(base_qty) or {"status": "filled", "executed_qty": base_qty,
                                                    "avg_price": 2000.0}
reset()
with contextlib.redirect_stderr(io.StringIO()):
    _, _, done, unclosed = flatten._flatten_spot(
        "fakex", forder, {}, {"ETHUSDT": {"side": "long", "qty": 0.5, "size": 1000.0}},
        lambda k: 500.0 if k == "ETHUSDT@spot" else 0.0)
check(SOLD == [0.25] and "ETHUSDT@spot" in unclosed,
      f"S3 spot: 500 of 1000 parked → 0.25 of 0.5 sold, its book kept ({SOLD}, {unclosed})")
del SOLD[:]
with contextlib.redirect_stderr(io.StringIO()):
    flatten._flatten_spot("fakex", forder, {}, {"ETHUSDT": {"side": "long", "qty": 0.5, "size": 1000.0}},
                          lambda k: 1000.0)
check(SOLD == [], f"S3 spot: all of it parked → nothing sold ({SOLD})")
RESTORES = []
forder.place_market_order = lambda env, sym, direction, qty, client_order_id=None, reduce_only=False: \
    RESTORES.append(qty) or {"status": "filled", "executed_qty": qty, "avg_price": 70000.0}
reset()
for held_back, want in ((350.0, [0.005]), (700.0, [])):
    del RESTORES[:]
    done, unclosed = set(), set()
    with contextlib.redirect_stderr(io.StringIO()):
        flatten._restore_netted(
            "fakex", forder, {}, [{"symbol": "BTCUSDT", "side": "short", "size": 0.02}],
            {"BTCUSDT": {"side": "long", "qty": 0.01, "netted": 0.01, "size": 700.0}}, done,
            unclosed, lambda k, h=held_back: h)
    check(RESTORES == want and "BTCUSDT" in unclosed,
          f"N1 netted restore with {held_back:g} of 700 parked: sends {want} ({RESTORES}, {unclosed})")
vw.query_parked_order = _real_query

# ── close_symbol caps what it books at the book's share ──────────────────────
reset()
book(0.006, 420.0)
rc, out = close(True)
parks = list(unconfirmed.load().values())
check(parks and parks[0]["signed_diff"] == -420.0 and parks[0].get("book_cap") == 0.006,
      f"D1 the park holds the book's cost 420 and caps the booking at its 0.006 ({parks})")
pf._settle_parked(query=lambda entry: (0.01, 70000.0), cancel=lambda entry: False)
row = pf.ledger_positions("fakex").get("BTCUSDT")
check(not row or abs(float(row.get("qty") or 0)) < 1e-12,
      f"D1 the account's 0.01 filled: the book goes to 0, not a 0.004 phantom short ({row})")
reset()
book(0.02, 1400.0)
rc, out = close(True)
parks = list(unconfirmed.load().values())
check(parks and parks[0]["signed_diff"] == -700.0 and parks[0].get("book_cap") == 0.02,
      f"D2 0.01 closed of a 0.02 / 1400 book: holds 700, caps at 0.02 ({parks})")
reset()
book(None, 420.0, legacy=True)
rc, out = close(True)
parks = list(unconfirmed.load().values())
check(parks and parks[0].get("book_cap_cost") == 420.0 and "book_cap" not in parks[0],
      f"D3 a book row with no quantity caps in cost ({parks})")
pf._settle_parked(query=lambda entry: (0.01, 70000.0), cancel=lambda entry: False)
booked = [json.loads(x) for x in open("manager/orders.jsonl") if "unconfirmed_park_id" in x]
check(booked and abs(booked[0]["legs"][0]["executed_qty"] - 0.006) < 1e-12,
      f"D3 …the 0.01 fill is booked as 420 ÷ 70000 = 0.006 ({booked})")
reset()
book(0.01, 700.0)
_ledger = pf.ledger_positions
pf.ledger_positions = lambda *a, **k: (_ for _ in ()).throw(OSError("orders.jsonl unreadable"))
rc, out = close(True)
pf.ledger_positions = _ledger
check(rc == cs.FAILED and not unconfirmed.load() and guard.halted(),
      f"D4 the book unreadable: not parked as an empty book — HALT instead ({unconfirmed.load()})")
guard.clear_halt("test")

print("\n" + ("all ok" if not fails else f"{fails} FAILED"))
sys.exit(1 if fails else 0)
