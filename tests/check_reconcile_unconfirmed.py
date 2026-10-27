"""An order the venue took whose outcome is unknown (an order lib's OrderNotConfirmed carrying
venue / symbol / order id) is parked, not reported as a rejection and not sent again — no network.

What it protects (live 2026-10-24, Binance BTCUSDT): the confirm poll answered -2013 for an order
that had filled; reconcile recorded a P1 交易所拒單, and under self_ledger the fill was not in the
book, so the next round would have bought it a second time.

Asserts (real rounds on paper: reconcile → manager/reconciler.place_order, the order call wrapped):
- the failing round writes an order_errors row with kind order_unconfirmed and the strategy names,
  parks the order, and sends the "outcome unknown" notice — not "Order failed";
- while the query has no answer the symbol gets no order at all (no resend), and no HALT;
- an hour on, ONE stuck row, never a second;
- the query answers FILLED → the fill is booked from the venue's numbers, the park is cleared,
  and the round sends nothing (the book already holds it);
- resolve(symbol, 0) from the agent releases it and the next round trades again;
- a second unknown on the same symbol right after is a new row (no 1-hour throttle);
- a plain rejection carries the strategy names, no kind, nothing parked;
- an unreadable park file → nothing is sent that round.

Run: cd blave-agent && .venv/bin/python tests/check_reconcile_unconfirmed.py
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
WS = Path(tempfile.mkdtemp(prefix="reconcile-unconfirmed-", dir=os.environ.get("SCRATCHPAD") or None))
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
json.dump({"amounts": {"tw_c": 16_000}, "exchanges": {"tw_c": "paper"}, "asset_specs": {}},
          open("manager/portfolio_config.json", "w"))

socket.socket.connect = lambda *a, **k: (_ for _ in ()).throw(OSError("offline test"))
import pandas as pd  # noqa: E402
import lib.data as data  # noqa: E402

data.fetch_twstock_price = lambda code, *a: pd.DataFrame({"Close": [2420.0]}, index=pd.to_datetime(["2026-10-16"]))
from lib import guard, order_paper, paper_data, unconfirmed, portfolio, venue_wiring  # noqa: E402

paper_data.tw_session_open = lambda env=None, now=None: True
order_paper.tw_session_open = paper_data.tw_session_open
from manager import reconciler as rec  # noqa: E402

KEY = "2330@spot"
fails = 0


def check(cond, msg):
    global fails
    print(("ok   " if cond else "FAIL ") + msg)
    fails += 0 if cond else 1


class NotConfirmed(unconfirmed.OrderOutcomeUnknown):
    pass


def unknown(oid=None, cid=None):
    return NotConfirmed(f"order {oid or cid} sent, no answer", venue="paper", venue_symbol="2330",
                        order_id=oid, client_order_id=cid)


MODE = {"raise": None}
CALLS = []
ANSWER = {"res": None, "boom": False}
sent = []


def place(symbol, signed_diff, asset_spec=None, reduce_only=False, exchange=None, contributors=None):
    CALLS.append((symbol, signed_diff, reduce_only))
    if MODE["raise"] is not None:
        raise MODE["raise"]
    return rec.place_order(symbol, signed_diff, asset_spec=asset_spec, reduce_only=reduce_only,
                           exchange=exchange, contributors=contributors)


def query(entry):
    if ANSWER["boom"]:
        raise ValueError("bad parked row")
    return ANSWER["res"]


venue_wiring.query_parked_order = query


def amount(x):
    json.dump({"amounts": {"tw_c": x}, "exchanges": {"tw_c": "paper"}, "asset_specs": {}},
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


def parked():
    return unconfirmed.load()


def booked():
    try:
        return [json.loads(x) for x in open("manager/orders.jsonl") if "unconfirmed_park_id" in x]
    except OSError:
        return []


def book_cost():
    return float((portfolio.ledger_positions().get(KEY) or {}).get("size") or 0)


def marker():
    return os.path.isdir("state/execution/inflight") and any(
        f.endswith(".json") for f in os.listdir("state/execution/inflight"))


for _ in range(2):   # the first rounds may only write the own-positions baseline
    if round_():
        break
amount(0)
round_()
amount(16_000)

# ── an entry whose outcome is unknown: parked, not 拒單, never sent again ─────
MODE["raise"] = unknown("X1")
n = round_()
u = rows("order_unconfirmed")
check(n == 1, f"the failing round sends the order once ({n})")
check(len(u) == 1 and u[0].get("symbol") == KEY and u[0].get("strategies") == ["tw_c"],
      f"order_errors row: kind order_unconfirmed, strategies [tw_c] ({rows()[-1:]})")
check(parked().get("X1", {}).get("key") == KEY, "parked under its order id")
note = [x for x in sent if "下單結果不明" in x]
check(len(note) == 1 and "策略 tw_c 的 " in note[0] and "不要手動補單" in note[0] and "🚨" in note[0]
      and not any("Order failed" in x for x in sent), f"machine notice is the canon 🚨 copy ({sent[-1:]})")
check(not guard.halted(), "no HALT")
n = round_()
check(n == 0, f"query has no answer: no resend ({n})")
check(parked()["X1"]["reads"] == 1 and not any(r.get("stuck") for r in rows("order_unconfirmed")),
      "still parked, read counted, no reminder yet")
unconfirmed.update("X1", parked_at=time.time() - 3700)
round_()
round_()
check(len([r for r in rows("order_unconfirmed") if r.get("stuck")]) == 1, "an hour on: one reminder")
unconfirmed.update("X1", reminded_at=time.time() - 86_500)
round_()
round_()
check(len([r for r in rows("order_unconfirmed") if r.get("stuck")]) == 2, "a day later: one more, not one per round")
check(not guard.halted(), "still no HALT")

ANSWER["boom"] = True
try:
    n = round_()
    check(n == 0 and "X1" in parked(), "a parked row that fails to settle: the round still runs, it stays parked")
except Exception as e:
    check(False, f"a parked row that fails to settle killed the round ({type(e).__name__}: {e})")
ANSWER["boom"] = False

ask = parked()["X1"]["signed_diff"]
price = 2420.0 / 32.0
ANSWER["res"] = (ask / price, price)
n = round_()
b = booked()
check(len(b) == 1 and b[0]["unconfirmed_park_id"] == "X1" and b[0]["legs"][0]["executed_qty"] == ask / price
      and b[0]["legs"][0]["signed_qty"] > 0, f"FILLED: booked from the venue's qty and price ({b})")
check("X1" not in parked() and n == 0, f"park cleared; that round sends nothing ({n})")
ANSWER["res"] = None
portfolio.book_unconfirmed(KEY, b[0] | {"signed_diff": ask}, 1.0, 1.0, source="venue", pid="X1")
check(len(booked()) == 1, "a park id already in the book is not booked twice")

# ── while parked: entries held, reduce-only closes of the booked part go out ──
held_cost = book_cost()
amount(32_000)
MODE["raise"] = unknown("X2")
round_()
MODE["raise"] = None
check("X2" in parked() and round_() == 0, "a second entry on the symbol: parked; the next round adds nothing")
amount(0)
n = round_()
legs = list(CALLS)
check(n == 1 and legs[0][2] is True and abs(abs(legs[0][1]) - held_cost) < 1,
      f"target flat while parked: the reduce-only close of the booked part goes out ({legs}, book {held_cost})")
unconfirmed.resolve("2330", 0)

# a parked CLOSE: what it may have taken off is left alone by later closes
amount(16_000)
round_()
amount(0)
MODE["raise"] = unknown("X3")
round_()
MODE["raise"] = None
p3 = parked().get("X3", {})
check(p3.get("reduce_only") is True, f"a close with an unknown outcome is parked too ({p3})")
check(round_() == 0, f"…and no second close goes out for the part it may have sold ({CALLS})")
unconfirmed.resolve("2330", 0)

# ── cannot park → HALT, inflight marker kept ─────────────────────────────────
amount(16_000)
round_()
amount(48_000)
keep_park = unconfirmed.park
unconfirmed.park = lambda *a, **k: (_ for _ in ()).throw(OSError(28, "No space left on device"))
MODE["raise"] = unknown("X4")
round_()
unconfirmed.park = keep_park
check(guard.halted() and marker(), f"park file not writable: HALT, inflight marker kept (halted {guard.halted()}, marker {marker()})")
check(not [r for r in rows() if "X4" in str(r.get("error")) and not r.get("kind")],
      "…and not recorded as a rejection")
guard.clear_halt("test")
for f in os.listdir("state/execution/inflight"):
    os.remove(os.path.join("state/execution/inflight", f))
MODE["raise"] = NotConfirmed("no ids at all")
round_()
check(guard.halted(), "an unknown outcome without ids: HALT")
guard.clear_halt("test")
for f in os.listdir("state/execution/inflight"):
    os.remove(os.path.join("state/execution/inflight", f))

# ── a plain rejection: strategy names, no kind, nothing parked ───────────────
MODE["raise"] = RuntimeError("insufficient paper cash (1 < 2)")
amount(3_200_000)
round_()
last = rows()[-1]
check(last.get("kind") is None and last.get("strategies") == ["tw_c"] and not parked(),
      f"a plain rejection: strategy names, no kind, nothing parked ({last})")
MODE["raise"] = None

# ── TWAP / custom slices: an unknown slice parks and stops the execution ────
from lib import execute  # noqa: E402
import threading  # noqa: E402
keep_auto = venue_wiring.auto_place_order
venue_wiring.auto_place_order = lambda *a, **k: (_ for _ in ()).throw(unknown(cid="x-52DDFAFNtw"))
stop, why = threading.Event(), {}
try:
    execute._place_or_park(KEY, 500.0, None, False, "paper", [{"strategy": "tw_c"}], stop, why)
    check(False, "an unknown slice must not return")
except RuntimeError:
    pk = [e for e in parked().values() if e.get("client_order_id") == "x-52DDFAFNtw"]
    check(stop.is_set() and why.get("stop") == "unknown" and len(pk) == 1 and pk[0]["order_id"] is None,
          "TWAP slice unknown: parked by client id, execution stopped")
venue_wiring.auto_place_order = keep_auto
unconfirmed.resolve("2330", 0)

# ── netted part of an entry is booked with it ────────────────────────────────
portfolio.book_unconfirmed(KEY, {"signed_diff": 100.0, "reduce_only": False, "venue": "paper",
                                 "netted_room": 0.4, "key": KEY}, 1.0, 100.0, source="venue", pid="N1")
nb = [x for x in booked() if x["unconfirmed_park_id"] == "N1"]
check(nb and nb[0]["legs"][0].get("netted_qty") == 0.4, f"netted_qty booked ({nb})")

# ── unreadable park file: nothing is sent, file left as is ───────────────────
Path(unconfirmed.PATH).write_text("{not json")
amount(16_000)
n = round_()
check(n == 0, f"park file unreadable: nothing is sent this round ({n})")
check(Path(unconfirmed.PATH).read_text() == "{not json", "…and the file is left as is")
os.remove(unconfirmed.PATH)

# ── 全部平倉 asks about parked orders first and says what it could not close ─
MODE["raise"] = unknown("X6")
amount(64_000)
round_()
MODE["raise"] = None
from manager import flatten  # noqa: E402
os.chdir(WS)   # importing flatten chdirs to the repo it sits in — run it against the test workspace
flatten._inflight_wait_s = lambda: 0
check("X6" in parked(), "an entry parked before 全部平倉")
with contextlib.redirect_stdout(io.StringIO()):
    flatten.flatten()
check(os.getcwd() == str(WS) and not os.path.exists(os.path.join(ROOT, "manager", "order_errors.json")),
      "flatten ran in the test workspace")
fl = [r for r in rows("order_unconfirmed") if "close-all" in str(r.get("error"))]
check(len(fl) == 1 and fl[0]["symbol"] == KEY and fl[0].get("stuck") is True and fl[0]["exchange"] == "paper",
      f"全部平倉 with an order still parked: a row says it may have filled and was not closed ({fl})")

print("all checks passed" if not fails else f"FAILED: {fails}")
sys.exit(1 if fails else 0)
