"""Every official venue's one-way / hedge detection, as the netted exit reads it.

lib.venue_wiring._netted_exit (paper scenario MP-04) sends a PLAIN order for the
bot's book share only when the account keeps one net position per symbol. That
decision rests on each lib's own mode read — this runs each one against the
venue's real answer shapes (only the HTTP leaf is stubbed) and checks the
wiring maps it: one-way → True, hedge → False, unreadable → None.

Run: cd blave-agent && .venv/bin/python tests/check_net_mode.py
"""
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
os.chdir(ROOT)

from lib import venue_wiring  # noqa: E402
import lib.order_binance as ob  # noqa: E402
import lib.order_bingx as ngx  # noqa: E402
import lib.order_okx as ox  # noqa: E402
import lib.order_gateio as gx  # noqa: E402
import lib.order_bybit as bx  # noqa: E402
import lib.order_paper as px  # noqa: E402

fails = 0


def check(cond, msg):
    global fails
    print(("ok   " if cond else "FAIL ") + msg)
    fails += 0 if cond else 1


ENV = {"BINANCE_API_KEY": "k", "BINGX_API_KEY": "k", "OKX_API_KEY": "k",
       "GATEIO_API_KEY": "k", "GATEIO_SECRET_KEY": "s", "BYBIT_API_KEY": "k"}
mode = venue_wiring._net_position_mode


def cases(lib, vid, stub, one_way, hedge, cache):
    got = []
    for answer in (one_way, hedge):
        getattr(lib, cache).clear()
        stub(answer)
        got.append(mode(lib, vid, ENV, "BTCUSDT"))
    return got


# the HTTP leaf each lib's get_position_mode calls, answering like the venue does
got = cases(ob, "binance", lambda a: setattr(ob, "_request", lambda *x, **k: a),
            {"dualSidePosition": False}, {"dualSidePosition": True}, "_position_mode_cache")
check(got == [True, False], f"Binance: dualSidePosition false → net, true → hedge ({got})")
got = cases(ngx, "bingx", lambda a: setattr(ngx, "_request", lambda *x, **k: a),
            {"dualSidePosition": "false"}, {"dualSidePosition": "true"}, "_position_mode_cache")
check(got == [True, False], f"BingX: the STRING 'false' → net, 'true' → hedge ({got})")
got = cases(ox, "okx", lambda a: setattr(ox, "_send", lambda *x, **k: a),
            [{"posMode": "net_mode", "acctLv": "2"}], [{"posMode": "long_short_mode", "acctLv": "2"}],
            "_pos_mode_cache")
check(got == [True, False], f"OKX: net_mode → net, long_short_mode → hedge ({got})")
got = cases(gx, "gateio", lambda a: setattr(gx, "_send", lambda *x, **k: a),
            {"in_dual_mode": False}, {"in_dual_mode": True}, "_pos_mode_cache")
check(got == [True, False], f"Gate.io: in_dual_mode false → net, true → hedge ({got})")

got = []
for rows in ([{"positionIdx": 0, "size": "0.01"}],
             [{"positionIdx": 1, "size": "0.01"}, {"positionIdx": 2, "size": "0"}]):
    bx._request = lambda env, m, path, params=None, body=None, retries=3, r=rows: {"list": r}
    got.append(mode(bx, "bybit", ENV, "BTCUSDT"))
check(got == [True, False], f"Bybit: positionIdx 0 → net, 1/2 → hedge (per symbol, never cached) ({got})")

check(mode(px, "paper", ENV, "BTCUSDT") is True, "paper: always one net position")


def _boom(*a, **k):
    raise RuntimeError("timeout")


ob._position_mode_cache.clear()
ob._request = _boom
check(mode(ob, "binance", ENV, "BTCUSDT") is None,
      "an unreadable mode is None — the netted exit is not taken on a guess")

# ── the netted exit itself: only with a recorded netted amount, a known one-way mode,
# and two reads in a row ──
import json  # noqa: E402
import tempfile  # noqa: E402
import threading  # noqa: E402
import lib.portfolio as pf  # noqa: E402
os.chdir(tempfile.mkdtemp(prefix="netmode-"))
os.makedirs("state", exist_ok=True)
pf._ACCOUNT_SHORT_MIN_S = 0
SENT = []
fake = type("O", (), {})()
fake.place_market_order = lambda env, sym, d, q, client_order_id=None, reduce_only=False: \
    SENT.append((d, q, reduce_only)) or {"executed_qty": q, "avg_price": 50000.0}
fake.get_contract_rules = lambda env, sym: {"step": "0.001", "contract_value": 1}
POS = {"long": 0.0, "short": 0.03}
venue_wiring._held_base = lambda env, vid, sym, side: POS[side]
MODE = [True]
venue_wiring._net_position_mode = lambda order, vid, env, sym: MODE[0]
row = {"owned": 0.02, "unit_cost": 50000.0, "full": True, "legacy": False, "netted": 0.02}


def exit_(r=row):
    return venue_wiring._netted_exit({}, "binance", fake, "BTCUSDT", "long", -1000.0, r, key="BTCUSDT")


MODE[0] = None
check(exit_() is None and exit_() is None and SENT == [],
      "position mode unreadable: never the netted path (nothing sent, the normal path runs)")
MODE[0] = False
check(exit_() is None and SENT == [], "hedge mode: never the netted path")
MODE[0] = True
check(exit_({**row, "netted": 0.0}) is None and SENT == [],
      "no recorded netted amount (the user closed the bot's position by hand): the normal path")
first = exit_()
second = exit_()
check(first is False and isinstance(second, dict) and SENT == [("short", 0.02, False)]
      and second.get("netted_exit") is True,
      f"netted, one-way, two reads: a plain short of the book's 0.02 ({first}, {SENT})")
del SENT[:]
exit_({**row, "netted": 0.005})
exit_({**row, "netted": 0.005})
check(SENT == [("short", 0.005, False)], f"never more than the recorded netted amount ({SENT})")

# ── recording: only a one-way account nets; hedge or unknown records nothing ──
POS.update(long=0.0, short=0.03)
for m, want in ((True, 0.03), (False, 0.0), (None, 0.0)):
    MODE[0] = m
    got = venue_wiring._netted_room({}, "binance", fake, "BTCUSDT", "long")
    check(got == want, f"netted room with mode {m}: {got} (want {want})")
MODE[0] = True

# ── the book: an exit of the netted share lowers `netted` by what it restored ──
os.makedirs("manager", exist_ok=True)
json.dump({"seeded_at": "2026-01-01T00:00:00", "own_only_basis": 1, "symbols": {}},
          open("manager/ledger_seed.json", "w"))
with open("manager/orders.jsonl", "w") as f:
    for ts, leg in (("2026-02-01T00:00:00", {"signed_diff": 2000.0, "signed_qty": 0.04,
                                             "netted_qty": 0.02}),
                    ("2026-02-02T00:00:00", {"signed_diff": -500.0, "signed_qty": -0.01,
                                             "reduce_only": True, "netted_exit": True})):
        f.write(json.dumps({"ts": ts, "symbol": "BTCUSDT", "exchange": "binance",
                            "legs": [leg]}) + "\n")
row = pf.ledger_positions("binance").get("BTCUSDT", {})
check(abs(row.get("qty", 0) - 0.03) < 1e-12 and abs(row.get("netted", 0) - 0.01) < 1e-12,
      f"entry 0.04 (0.02 netted), netted exit 0.01 → book 0.03 with 0.01 netted ({row})")

# ── close-all's restore: never more than the recorded netted amount ──
_cwd = os.getcwd()
from manager import flatten  # noqa: E402  (chdirs to the repo root on import)
os.chdir(_cwd)
flatten._record_order_error = lambda *a, **k: None
del SENT[:]
fake.format_qty = lambda env, sym, q: str(q)
flatten._restore_netted("binance", fake, {}, [{"symbol": "BTCUSDT", "side": "short", "size": 0.05}],
                        {"BTCUSDT": {"side": "long", "qty": 0.02, "netted": 0.01, "size": 1000.0}},
                        set(), set())
check(SENT == [("short", 0.01, False)],
      f"close-all restores the recorded 0.01, not the book's 0.02 or the account's 0.05 ({SENT})")
del SENT[:]
MODE[0] = False
flatten._restore_netted("binance", fake, {}, [{"symbol": "BTCUSDT", "side": "short", "size": 0.05}],
                        {"BTCUSDT": {"side": "long", "qty": 0.02, "netted": 0.01, "size": 1000.0}},
                        set(), set())
check(SENT == [], "…and nothing on a hedge-mode account")
MODE[0] = True

# ── a chase (limit) entry records its netted share too, read once before any fill ──
import lib.execute as ex  # noqa: E402
FIN, ROOM_CALLS = [], []
ex._finish = lambda *a, **k: FIN.append(k)
ex._reap_own = ex._touch_kick = lambda *a, **k: None
ex._get_notify = lambda: (lambda m: None)
ex._CHASE_POLL_S = 0.0


def _room(buy):
    ROOM_CALLS.append(buy)
    return 0.05 if len(ROOM_CALLS) == 1 else 0.0  # the user's short shrinks as fills land


tools = {"venue": "binance", "bbo": lambda: (50000.0, 50000.1), "netted_room": _room,
         "place": lambda usd, px, cid, buy, **k: {"order_id": "1"},
         "status": lambda oid: {"status": "filled", "executed_qty": 0.02, "avg_price": 50000.0},
         "cancel": lambda oid: {"status": "canceled"}}
ex._chase_thread("BTCUSDT", 1000.0, None, False, "binance", [], tools, threading.Event())
check(ROOM_CALLS == [True] and FIN and abs(FIN[-1].get("netted_qty", 0) - 0.02) < 1e-12,
      f"chase entry: room read once (0.05), netted_qty = min(room, filled 0.02) "
      f"({ROOM_CALLS}, {FIN[-1:] and FIN[-1].get('netted_qty')})")
del FIN[:], ROOM_CALLS[:]
ex._chase_thread("BTCUSDT", -1000.0, None, True, "binance", [], tools, threading.Event())
check(not ROOM_CALLS and not FIN[-1].get("netted_qty"), "a chase reduce records no netted share")

# ── HALT's netted-restore pass: this thread, one order, the named symbol / direction /
# at most the named quantity — armed by the order lib itself ──
import ast  # noqa: E402
import requests  # noqa: E402
from lib import guard  # noqa: E402

guard.trip_halt("test", "test")
check(guard.entry_blocked(), "HALT blocks an entry")
with guard.netted_restore("BTCUSDT", "short", 0.02, "test"):
    check(guard.entry_blocked(), "an open pass alone lets nothing through: the order must arm it")
    for args, why in ((("ETHUSDT", "short", 0.02), "another symbol"),
                      (("BTCUSDT", "long", 0.02), "the other direction"),
                      (("BTCUSDT", "short", 0.021), "more than the recorded quantity")):
        guard.arm_restore(*args)
        check(guard.entry_blocked(), f"{why} does not arm it")
    guard.arm_restore("BTCUSDT", "short", 0.02, reduce_only=True)
    check(guard.entry_blocked(), "a reduce-only order does not arm it")
    res = []

    def _other():
        guard.arm_restore("BTCUSDT", "short", 0.02)
        res.append(guard.entry_blocked())
    t = threading.Thread(target=_other)
    t.start()
    t.join()
    check(res == [True], "another thread cannot use this thread's pass")
    guard.arm_restore("BTC-USDT", "short", 0.02)
    check(not guard.entry_blocked(), "the restore itself (any symbol spelling) passes")
    check(guard.entry_blocked(), "…once: a second order in the same pass is blocked")
    guard.arm_restore("BTCUSDT", "short", 0.01)
    check(guard.entry_blocked(), "a spent pass cannot be armed again")
try:
    with guard.netted_restore("BTCUSDT", "short", 0.02, "test"):
        guard.arm_restore("BTCUSDT", "short", 0.02)
        raise RuntimeError("venue down")
except RuntimeError:
    pass
check(guard.entry_blocked(), "an order that raised inside the pass leaves no pass behind")

# every order lib arms with its own order, first thing in place_market_order
for mod in (ob, ox, bx, gx, ngx, px):
    fn = [n for n in ast.parse(open(mod.__file__).read()).body
          if isinstance(n, ast.FunctionDef) and n.name == "place_market_order"][0]
    first = ast.unparse(fn.body[1]) if len(fn.body) > 1 else ""
    check(first == "guard.arm_restore(symbol, direction, qty, reduce_only)",
          f"{mod.__name__}.place_market_order arms the pass with its own order ({first})")

# …and each lib's entry gate spends it: one entry order through, the next one refused
_BODY = {"code": "0", "data": [{"sCode": "0", "ordId": "1"}], "retCode": 0, "result": {},
         "msg": "", "id": 1, "status": "finished", "orderId": 1}


def _fake(method, url, **k):
    r = requests.Response()
    r.status_code, r.url = 200, url
    r._content = json.dumps(_BODY).encode()
    return r


import importlib  # noqa: E402
import socket  # noqa: E402


def _no_network(*a, **k):
    raise OSError("no network in this test")


socket.socket.connect = _no_network
# the mode checks above stubbed these libs' HTTP leaves; the gate needs the real ones
ob, ox, bx, gx, ngx = (importlib.reload(m) for m in (ob, ox, bx, gx, ngx))
requests.request = _fake
requests.get = lambda url, **k: _fake("GET", url, **k)
requests.post = lambda url, **k: _fake("POST", url, **k)
requests.delete = lambda url, **k: _fake("DELETE", url, **k)
KEYS = {"BINANCE_API_KEY": "k", "BINANCE_SECRET_KEY": "s", "OKX_API_KEY": "k", "OKX_SECRET_KEY": "s",
        "OKX_PASSPHRASE": "p", "BYBIT_API_KEY": "k", "BYBIT_SECRET_KEY": "s", "GATEIO_API_KEY": "k",
        "GATEIO_SECRET_KEY": "s", "BINGX_API_KEY": "k", "BINGX_SECRET_KEY": "s"}
ENTRY = {
    ob: lambda: ob._request("POST", "/fapi/v1/order", KEYS, {"symbol": "BTCUSDT", "side": "SELL",
                                                            "type": "MARKET", "quantity": "0.02"}),
    ox: lambda: ox._request("POST", "/api/v5/trade/order", KEYS, {
        "instId": "BTC-USDT-SWAP", "tdMode": "cross", "side": "sell", "ordType": "market", "sz": "2"}),
    bx: lambda: bx._request(KEYS, "POST", "/v5/order/create", body={
        "category": "linear", "symbol": "BTCUSDT", "side": "Sell", "orderType": "Market", "qty": "0.02"}),
    gx: lambda: gx._request("POST", "/futures/usdt/orders", KEYS, {
        "contract": "BTC_USDT", "size": -200, "price": "0", "tif": "ioc"}),
    ngx: lambda: ngx._request("POST", "/openApi/swap/v2/trade/order", KEYS, {
        "symbol": "BTC-USDT", "side": "SELL", "positionSide": "BOTH", "type": "MARKET",
        "quantity": "0.02"}),
}


def _halted(fn):
    try:
        fn()
    except guard.Halted:
        return True
    except Exception:
        return False
    return False


for mod, send in ENTRY.items():
    with guard.netted_restore("BTCUSDT", "short", 0.02, "test"):
        guard.arm_restore("BTCUSDT", "short", 0.02)
        first, second = _halted(send), _halted(send)
    check(not first and second and _halted(send),
          f"{mod.__name__}: the armed restore passes the HALT gate once; a second entry and one "
          f"outside the pass are refused ({first}, {second})")
guard.clear_halt("test")

# ── an unconfirmed exchange account gets no Blave order at all, closes included (D6 #2) ──
REDUCE = {
    ob: ("binance", lambda: ob._request("POST", "/fapi/v1/order", KEYS, {
        "symbol": "BTCUSDT", "side": "SELL", "type": "MARKET", "quantity": "0.02",
        "reduceOnly": "true"})),
    ox: ("okx", lambda: ox._request("POST", "/api/v5/trade/order", KEYS, {
        "instId": "BTC-USDT-SWAP", "tdMode": "cross", "side": "sell", "ordType": "market",
        "sz": "2", "reduceOnly": "true"})),
    bx: ("bybit", lambda: bx._request(KEYS, "POST", "/v5/order/create", body={
        "category": "linear", "symbol": "BTCUSDT", "side": "Sell", "orderType": "Market",
        "qty": "0.02", "reduceOnly": True})),
    gx: ("gateio", lambda: gx._request("POST", "/futures/usdt/orders", KEYS, {
        "contract": "BTC_USDT", "size": -200, "price": "0", "tif": "ioc", "reduce_only": True})),
    ngx: ("bingx", lambda: ngx._request("POST", "/openApi/swap/v2/trade/order", KEYS, {
        "symbol": "BTC-USDT", "side": "SELL", "positionSide": "BOTH", "type": "MARKET",
        "quantity": "0.02", "reduceOnly": "true"})),
}
CANCEL = {
    ob: lambda: ob._request("DELETE", "/fapi/v1/allOpenOrders", KEYS, {"symbol": "BTCUSDT"}),
    gx: lambda: gx._request("DELETE", "/futures/usdt/orders", KEYS, query="contract=BTC_USDT"),
}


def _hold(state):
    os.makedirs("state", exist_ok=True)
    json.dump(state, open(guard.ACCOUNT_GUARD_PATH, "w"))


for mod, (venue, send) in REDUCE.items():
    _hold({"book_hold": {"venue": venue, "reason": "?", "ask": True}})
    held_reduce, held_entry = _halted(send), _halted(ENTRY[mod])
    _hold({"book_hold": {"venue": "somewhere-else", "reason": "?", "ask": True}})
    free_reduce = not _halted(send)
    check(held_reduce and held_entry and free_reduce,
          f"{mod.__name__}: a book hold on {venue} refuses the close as well as the entry; "
          f"a hold on another venue does not ({held_reduce}, {held_entry}, {free_reduce})")
_hold({"book_hold": {"venue": "binance", "reason": "?"}})
check(not _halted(CANCEL[ob]), "…a cancel still passes (it places nothing)")
_hold({"pending": {"venue": "binance", "reason": "account changed"}})
check(not _halted(REDUCE[ob][1]), "a pending trip without HALT holds nothing (HALT-clear = resume)")
guard.trip_halt("account changed", "reconciler")
check(_halted(REDUCE[ob][1]), "…under its HALT it refuses the close too")
_hold({"bind_reset": {"venue": "binance", "at": 1}})
check(_halted(REDUCE[ob][1]), "a bind that found another account: nothing before 啟動下單")
_hold({"bind_reset": {"venue": "binance", "at": 1, "acked": True}})
check(not _halted(REDUCE[ob][1]), "…an acknowledged one holds nothing")
_hold({"book_hold": {"venue": "paper", "reason": "?", "ask": True},
       "pending": {"venue": "paper", "reason": "?"}})
try:
    px._gate("reduce", symbol="BTCUSDT", side="sell", qty=0.01)
    paper_ok = True
except guard.Halted:
    paper_ok = False
check(not guard.account_held("paper") and paper_ok,
      "paper is never held: the simulated account is nobody else's (D7 #2)")
guard.clear_halt("test")

# …and a running exit TWAP / chase stops before its next child order
SLICES = []
import lib.venue_wiring as _vw  # noqa: E402
_vw.auto_place_order = lambda *a, **k: SLICES.append(a) or {"avg_price": 100.0, "executed_qty": 0.01}
_hold({"book_hold": {"venue": "binance", "reason": "?", "ask": True}})
why = {}
stop = threading.Event()
fn = ex._make_slice_fn("BTCUSDT", None, True, "binance", "sell", stop, {"id": "binance"}, why)
try:
    fn("BTCUSDT", "sell", 50.0)
    raised = False
except RuntimeError:
    raised = True
check(raised and not SLICES and stop.is_set() and why.get("stop") == "account_hold",
      f"TWAP: the exit slice under a book hold is not sent; the execution stops ({SLICES}, {why})")
os.remove(guard.ACCOUNT_GUARD_PATH)
fn = ex._make_slice_fn("BTCUSDT", None, True, "binance", "sell", threading.Event(), {"id": "binance"}, {})
fn("BTCUSDT", "sell", 50.0)
check(len(SLICES) == 1, "…control: with no hold the same exit slice goes out")
PLACED, FIN = [], []
ex._finish = lambda *a, **k: FIN.append(k)
_hold({"book_hold": {"venue": "binance", "reason": "?", "ask": True}})
chase_tools = {"venue": "binance", "bbo": lambda: (100.0, 100.1),
               "place": lambda *a, **k: PLACED.append(a) or {"order_id": "1"},
               "status": lambda oid: {"status": "open", "executed_qty": 0.0, "avg_price": 0.0},
               "cancel": lambda oid: {"status": "canceled"}}
ex._chase_thread("BTCUSDT", -1000.0, None, True, "binance", [], chase_tools, threading.Event())
check(not PLACED and FIN, f"chase: an exit under a book hold places nothing and still books ({PLACED})")
os.remove(guard.ACCOUNT_GUARD_PATH)

print("\n" + ("all ok" if not fails else f"{fails} FAILED"))
sys.exit(1 if fails else 0)
