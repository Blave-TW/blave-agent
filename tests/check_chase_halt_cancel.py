"""暫停 pulls a resting chase order at once (Wei 2026-10-19, 0.1.27): the chase used to
see state/HALT only at its next 1 s status poll, and on OKX demo a resting maker
order filled inside that second (testnet 0.1.27 F6). The status poll stays at
1 s; HALT and the restart stop are re-checked every _HALT_POLL_S while the order
rests, and the existing retire path cancels it.

  H1  HALT while a limit rests (status poll left at 5 s): cancelled within 0.5 s
      of the trip, no status read before the cancel, no re-post, no market,
      nothing booked, no order error
  H2  partial fill before the cancel lands: booked once, exactly the partial
  H3  cancel raises but the order already filled: booked once, no crash
  H4  cancel never confirms: no crash, one notice, no kick, no re-post
  H5  restart stop lands while a limit rests: same prompt cancel
  H6  paper: the real lib/order_paper resting limit is cancelled on HALT, no fill
  H7  stop set from outside (a flip / overdue run, no HALT): same prompt cancel, one placement
  H8  Bybit (real lib/order_bybit, transport stubbed): its cancel is asynchronous — accepted,
      first read still PartiallyFilled, the end state has more filled → the final qty is
      booked, exactly once
  H9  Bybit: the order never reads terminal after the accepted cancel → uncertain path:
      one notice, nothing booked, no kick, no re-post
  H10/H11  the same two on Bybit spot (cancel_spot_order / get_spot_order)

No network. Run:
    .venv/bin/python tests/check_chase_halt_cancel.py
"""
import json
import os
import sys
import tempfile
import threading
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
os.chdir(tempfile.mkdtemp(prefix="chase-halt-cancel-"))
os.makedirs("manager", exist_ok=True)

from lib import execute, guard, order_bybit, order_paper, venue_wiring  # noqa: E402

red = 0


def check(ok, name):
    global red
    print(("ok   " if ok else "FAIL ") + name, flush=True)
    if not ok:
        red += 1


def config(self_ledger):
    with open("manager/portfolio_config.json", "w") as f:
        json.dump({"self_ledger": self_ledger}, f)


def reset():
    guard.clear_halt("test")
    for p in ("manager/orders.jsonl", "manager/order_errors.json", "state/execution/kick",
              guard.RESTART_STOP_PATH):
        if os.path.exists(p):
            os.remove(p)
    notes.clear()


def orders():
    try:
        return [json.loads(x) for x in open("manager/orders.jsonl")]
    except OSError:
        return []


def order_errors():
    p = "manager/order_errors.json"
    return json.load(open(p)) if os.path.exists(p) else None


notes = []
execute._notify_fn = notes.append
execute._CHASE_POLL_S, execute._CHASE_TIMEOUT_S = 5.0, 20.0
_real_auto = venue_wiring.auto_place_order


class Venue:
    """One resting order "o1". fill = base filled by the time the cancel lands;
    cancel_raises: the cancel call raises; status_dies_after_cancel: status
    reads raise once a cancel was attempted (venue unreachable)."""

    def __init__(self, fill=0.0, filled_first=False, cancel_raises=False,
                 status_dies_after_cancel=False):
        self.fill, self.filled_first = fill, filled_first
        self.cancel_raises, self.status_dies = cancel_raises, status_dies_after_cancel
        self.calls, self.cancel_tried, self.placed = [], False, threading.Event()

    def _log(self, name):
        self.calls.append((time.monotonic(), name))

    def tools(self):
        return {"venue": "binance", "bbo": lambda: (100.0, 100.1),
                "place": self.place, "status": self.status, "cancel": self.cancel}

    def place(self, *a, **k):
        self._log("place")
        self.placed.set()
        return {"order_id": "o1", "status": "new"}

    def status(self, oid):
        self._log("status")
        if self.cancel_tried and self.status_dies:
            raise RuntimeError("venue unreachable")
        if self.cancel_tried or self.filled_first:
            done = "filled" if self.filled_first else "canceled"
            return {"status": done, "executed_qty": self.fill, "avg_price": 100.0}
        return {"status": "new", "executed_qty": 0.0, "avg_price": 0.0}

    def cancel(self, oid):
        self._log("cancel")
        self.cancel_tried = True
        if self.cancel_raises:
            raise RuntimeError("cancel: venue error")
        return {"status": "canceled"}

    def first(self, name):
        return next((t for t, n in self.calls if n == name), None)

    def count(self, name):
        return sum(1 for _, n in self.calls if n == name)


def run(v, signed_diff=100.0, reduce_only=False, trip=lambda: guard.trip_halt("user request", "web"),
        stop=None):
    """Chase with v's toolkit; trip() 0.2 s after the order rests. Returns
    (seconds from trip to first cancel, market orders sent)."""
    market = []
    venue_wiring.auto_place_order = lambda *a, **k: market.append(a) or False
    at = {}

    def _tripper():
        v.placed.wait(5)
        time.sleep(0.2)
        at["t"] = time.monotonic()
        trip()

    th = threading.Thread(target=_tripper, daemon=True)
    th.start()
    try:
        execute._chase_thread("BTCUSDT", signed_diff, None, reduce_only, "binance", None,
                              v.tools(), stop or threading.Event())
    finally:
        venue_wiring.auto_place_order = _real_auto
    th.join(5)
    c = v.first("cancel")
    return (c - at["t"] if c is not None and "t" in at else None), market


# H1
config(False)
reset()
v = Venue()
lag, market = run(v)
before_cancel = [n for t, n in v.calls if t < (v.first("cancel") or 0)]
check(lag is not None and lag < 0.5,
      f"H1 HALT while a chase limit rests: cancel {lag if lag is None else round(lag, 3)}s after the trip (< 0.5)")
check(before_cancel == ["place"], f"H1 no status poll between the rest and the cancel ({before_cancel})")
check(v.count("place") == 1 and not market, f"H1 no re-post, no market ({v.count('place')}, {len(market)})")
check(orders() == [] and not order_errors(), f"H1 nothing booked, no order error ({orders()}, {order_errors()})")

# H2 — self_ledger: the partial is the book
config(True)
reset()
v = Venue(fill=0.3)
lag, market = run(v)
rows = orders()
leg = rows[0]["legs"][0] if rows else {}
check(lag is not None and lag < 0.5, f"H2 partial: cancelled promptly ({lag})")
check(len(rows) == 1 and leg.get("signed_qty") == 0.3 and leg.get("signed_diff") == 30.0
      and rows[0].get("failed") is True,
      f"H2 the 0.3 filled before the cancel is booked once, residual left to re-diff ({rows})")
check(v.count("place") == 1 and not market, "H2 no re-post, no market after the cancel")
check(any("$30.00/$100.00" in n for n in notes), f"H2 done notice names the partial ({notes})")

# H3 — cancel raises, the order had already filled
config(True)
reset()
v = Venue(fill=1.0, cancel_raises=True)
v.filled_first = False


def _fill_then_halt():
    v.filled_first = True  # the fill lands just before the pause
    guard.trip_halt("user request", "web")


lag, market = run(v, trip=_fill_then_halt)
rows = orders()
check(lag is not None and lag < 0.5, f"H3 cancel attempted promptly ({lag})")
check(len(rows) == 1 and rows[0]["legs"][0].get("signed_qty") == 1.0,
      f"H3 filled-before-cancel booked exactly once ({rows})")
check(not order_errors() and not any("error" in n.lower() for n in notes),
      f"H3 no crash, no error notice ({order_errors()}, {notes})")
check(os.path.exists("state/execution/kick"), "H3 kick touched (the fill moved the position)")

# H4 — cancel never confirms
config(False)
reset()
v = Venue(cancel_raises=True, status_dies_after_cancel=True)
lag, market = run(v)
uncertain = [n for n in notes if "could not confirm" in n]
check(lag is not None and lag < 0.5, f"H4 cancel attempted promptly ({lag})")
check(len(uncertain) == 1 and not any("Chase execution error" in n for n in notes),
      f"H4 one 'could not confirm' notice, no crash ({notes})")
check(not os.path.exists("state/execution/kick") and v.count("place") == 1 and not market,
      "H4 no kick, no re-post, no market while the order's fate is unknown")
check(orders() == [], f"H4 nothing booked ({orders()})")

# H5 — the machine-restart stop
config(False)
reset()
v = Venue()


def _restart_stop():
    os.makedirs("state", exist_ok=True)
    open(guard.RESTART_STOP_PATH, "w").write("{}")


lag, market = run(v, trip=_restart_stop)
check(lag is not None and lag < 0.5 and v.count("place") == 1 and not market,
      f"H5 restart stop while a limit rests: cancelled promptly ({lag}), no re-post")
reset()

# H6 — paper: the real ledger
config(False)
reset()
order_paper.current_price = lambda symbol, env=None: (100.0, None)
order_paper.get_bbo = lambda env, symbol: {"bid": 99.0, "ask": 99.1}  # below the mark: rests
penv = {}
ptools = {
    "venue": "paper",
    "bbo": lambda: (99.0, 99.1),
    "place": lambda usd, px, cid, buy, **k: order_paper.place_limit_order(
        penv, "BTCUSDT", "long", round(usd / px, 6), px, client_order_id="x-test-1",
        post_only=True),
    "status": lambda oid: venue_wiring._norm_order(order_paper.get_order(penv, "BTCUSDT", oid)),
    "cancel": lambda oid: order_paper.cancel_order(penv, "BTCUSDT", order_id=oid),
}
pv = Venue()
pv.tools = lambda: ptools
_place = ptools["place"]


def _paper_place(*a, **k):
    out = _place(*a, **k)
    pv.placed.set()
    return out


ptools["place"] = _paper_place
t_trip = {}


def _paper_trip():
    t_trip["t"] = time.monotonic()
    guard.trip_halt("user request", "web")


_, market = run(pv, trip=_paper_trip)
done = time.monotonic()
led = json.load(open(order_paper.LEDGER_PATH))
rows = list(led["orders"].values())
pos = float(led["positions"].get("BTCUSDT", {}).get("qty", 0) or 0)
check(len(rows) == 1 and rows[0]["status"] == "canceled"
      and rows[0].get("reason") == "canceled by caller",
      f"H6 paper resting limit cancelled by the chase on HALT ({[(r['status'], r.get('reason')) for r in rows]})")
check(done - t_trip["t"] < 1.0, f"H6 chase returned {done - t_trip['t']:.2f}s after the trip (< 1)")
check(pos == 0 and not led.get("fills") and orders() == [] and not market,
      f"H6 no paper fill, nothing booked (pos {pos}, fills {len(led.get('fills') or [])})")
reset()

# H7
config(False)
reset()
v, ev = Venue(), threading.Event()
lag, market = run(v, trip=ev.set, stop=ev)
check(lag is not None and lag < 0.5 and v.count("place") == 1 and not market and not guard.halted(),
      f"H7 stop set from outside while a limit rests: cancelled promptly ({lag}), one placement, no market")
reset()



class BybitWire:
    """order_bybit._request stand-in. Resting reads New; after the cancel is accepted the
    reads walk `after` (orderStatus, cumExecQty), repeating its last row."""

    def __init__(self, after, category="linear"):
        self.after, self.cancelled, self.reads_after, self.placed = after, False, 0, threading.Event()
        self.category = category

    def __call__(self, env, method, path, params=None, body=None, retries=3):
        got = (body or params or {}).get("category")
        assert got == self.category, f"{path}: category {got!r}, want {self.category!r}"
        if path == "/v5/order/cancel":
            self.cancelled = True
            return {"orderId": "b1"}
        if path in ("/v5/order/realtime", "/v5/order/history"):
            if not self.cancelled:
                st, q = "New", "0"
            else:
                st, q = self.after[min(self.reads_after, len(self.after) - 1)]
                self.reads_after += 1
            return {"list": [{"orderStatus": st, "cumExecQty": q, "qty": "1", "avgPrice": "100"}]}
        raise AssertionError(f"unexpected Bybit request {method} {path}")


def bybit_chase(wire, spot=False, symbol="BTCUSDT"):
    """A chase on the real order_bybit cancel/get_order (spot: the spot twins); HALT 0.2 s
    after the order rests."""
    market = []
    venue_wiring.auto_place_order = lambda *a, **k: market.append(a) or False
    real = order_bybit._request
    order_bybit._request = wire

    def _place(*a, **k):
        wire.placed.set()
        return {"order_id": "b1", "status": "open"}

    get, cancel = ((order_bybit.get_spot_order, lambda oid: order_bybit.cancel_spot_order({}, "BTCUSDT", oid))
                   if spot else
                   (order_bybit.get_order, lambda oid: order_bybit.cancel_order({}, "BTCUSDT", order_id=oid)))
    tools = {"venue": "bybit", "bbo": lambda: (100.0, 100.1), "place": _place,
             "status": lambda oid: venue_wiring._norm_order(get({}, "BTCUSDT", oid)),
             "cancel": cancel}

    def _tripper():
        wire.placed.wait(5)
        time.sleep(0.2)
        guard.trip_halt("user request", "web")

    th = threading.Thread(target=_tripper, daemon=True)
    th.start()
    try:
        execute._chase_thread(symbol, 100.0, None, False, "bybit", None, tools, threading.Event())
    finally:
        order_bybit._request = real
        venue_wiring.auto_place_order = _real_auto
    th.join(5)
    return market


# H8
config(True)
reset()
w = BybitWire([("PartiallyFilled", "0.3"), ("PartiallyFilledCanceled", "0.5")])
market = bybit_chase(w)
rows = orders()
check(len(rows) == 1 and rows[0]["legs"][0].get("signed_qty") == 0.5
      and rows[0]["legs"][0].get("signed_diff") == 50.0 and not market,
      f"H8 Bybit async cancel: the end state's 0.5 is booked once, not the 0.3 read right after the ack ({rows})")
check(any("$50.00/$100.00" in n for n in notes) and not any("could not confirm" in n for n in notes),
      f"H8 done notice names the final fill ({notes})")

# H9
config(True)
reset()
w = BybitWire([("New", "0")])
market = bybit_chase(w)
check(orders() == [] and not market and not os.path.exists("state/execution/kick")
      and sum("could not confirm" in n for n in notes) == 1,
      f"H9 Bybit cancel accepted but never terminal: uncertain — one notice, nothing booked, no kick ({orders()}, {notes})")

# H10/H11 — spot
config(True)
reset()
w = BybitWire([("PartiallyFilled", "0.3"), ("PartiallyFilledCanceled", "0.5")], category="spot")
market = bybit_chase(w, spot=True, symbol="BTCUSDT@spot")
rows = orders()
check(len(rows) == 1 and rows[0]["legs"][0].get("signed_qty") == 0.5 and not market
      and w.reads_after >= 2,
      f"H10 Bybit spot async cancel: the end state's 0.5 is booked once, not the 0.3 ({rows})")
config(True)
reset()
w = BybitWire([("New", "0")], category="spot")
market = bybit_chase(w, spot=True, symbol="BTCUSDT@spot")
check(orders() == [] and not market and not os.path.exists("state/execution/kick")
      and sum("could not confirm" in n for n in notes) == 1,
      f"H11 Bybit spot cancel accepted but never terminal: uncertain, nothing booked ({orders()}, {notes})")
reset()

print("ALL OK" if not red else f"{red} FAILED")
sys.exit(1 if red else 0)
