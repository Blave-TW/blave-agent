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


MODE = {"raise": None}
CALLS = []
ANSWER = {"res": None}
sent = []


def place(symbol, signed_diff, asset_spec=None, reduce_only=False, exchange=None, contributors=None):
    CALLS.append((symbol, signed_diff))
    if MODE["raise"] is not None:
        raise MODE["raise"]
    return rec.place_order(symbol, signed_diff, asset_spec=asset_spec, reduce_only=reduce_only,
                           exchange=exchange, contributors=contributors)


venue_wiring.query_parked_order = lambda venue, sym, oid: ANSWER["res"]


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
        return [json.loads(x) for x in open("manager/orders.jsonl") if "unconfirmed_order_id" in x]
    except OSError:
        return []


MODE["raise"] = None
for _ in range(2):   # the first rounds may only write the own-positions baseline
    if round_():
        break
# start flat: amounts 0 closes what the warm-up bought, then the real amount again
json.dump({"amounts": {"tw_c": 0}, "exchanges": {"tw_c": "paper"}, "asset_specs": {}},
          open("manager/portfolio_config.json", "w"))
round_()
json.dump({"amounts": {"tw_c": 16_000}, "exchanges": {"tw_c": "paper"}, "asset_specs": {}},
          open("manager/portfolio_config.json", "w"))

MODE["raise"] = NotConfirmed("order X1 accepted but not queryable (-2013)", venue="paper",
                             venue_symbol="2330", order_id="X1")
n = round_()
u = rows("order_unconfirmed")
check(n == 1, f"the failing round sends the order once ({n})")
check(len(u) == 1 and u[0].get("symbol") == KEY and u[0].get("strategies") == ["tw_c"],
      f"order_errors row: kind order_unconfirmed, strategies [tw_c] ({rows()[-1:]})")
check(KEY in parked() and parked()[KEY]["order_id"] == "X1", "the order is parked with its id")
check(any("Order outcome unknown" in x for x in sent) and not any("Order failed" in x for x in sent),
      f"notice says outcome unknown, not Order failed ({sent})")
check(not guard.halted(), "no HALT")

n = round_()
check(n == 0, f"query has no answer: the symbol gets no order — no resend ({n})")
check(parked()[KEY]["reads"] == 1 and not rows("order_unconfirmed")[-1].get("stuck"),
      "still parked, read counted, no reminder yet")

unconfirmed.update(KEY, "X1", parked_at=time.time() - 3700)
round_()
round_()
stuck = [r for r in rows("order_unconfirmed") if r.get("stuck")]
check(len(stuck) == 1 and stuck[0].get("strategies") == ["tw_c"],
      f"an hour on: one stuck reminder, not one per round ({len(stuck)})")
check(not guard.halted(), "still no HALT")

ask = parked()[KEY]["signed_diff"]
price = 2420.0 / 32.0
ANSWER["res"] = (ask / price, price)
n = round_()
b = booked()
check(len(b) == 1 and b[0]["legs"][0]["executed_qty"] == ask / price
      and b[0]["legs"][0]["signed_qty"] > 0 and b[0]["legs"][0]["fill_price"] == price,
      f"FILLED: booked from the venue's qty and price ({b})")
check(KEY not in parked(), "park cleared")
check(n == 0, f"…and that round sends nothing: the book holds the fill ({n})")
ANSWER["res"] = None

# a second unknown right after (the book was then emptied by the agent's resolve below)
json.dump({"amounts": {"tw_c": 32_000}, "exchanges": {"tw_c": "paper"}, "asset_specs": {}},
          open("manager/portfolio_config.json", "w"))
MODE["raise"] = NotConfirmed("order X2 still NEW after 15s", venue="paper",
                             venue_symbol="2330", order_id="X2")
before = len(rows("order_unconfirmed"))
round_()
check(len(rows("order_unconfirmed")) == before + 1 and parked()[KEY]["order_id"] == "X2",
      "a second unknown on the same symbol within the hour: a new row (not throttled)")

try:
    unconfirmed.resolve("2330", 1.0)
    check(False, "resolve with a fill but no price must refuse")
except ValueError:
    check(True, "resolve refuses a fill without its price")
unconfirmed.resolve("2330", 0)
check(KEY not in parked() and len(booked()) == 1, "resolve(symbol, 0): released, nothing booked")
MODE["raise"] = None
n = round_()
check(n == 1, f"released: the next round trades it again ({n})")

MODE["raise"] = RuntimeError("insufficient paper cash (1 < 2)")
json.dump({"amounts": {"tw_c": 3_200_000}, "exchanges": {"tw_c": "paper"}, "asset_specs": {}},
          open("manager/portfolio_config.json", "w"))
round_()
last = rows()[-1]
check(last.get("kind") is None and last.get("strategies") == ["tw_c"] and KEY not in parked(),
      f"a plain rejection: strategy names, no kind, nothing parked ({last})")

MODE["raise"] = None
Path(unconfirmed.PATH).write_text("{not json")
n = round_()
check(n == 0, f"park file unreadable: nothing is sent this round ({n})")
check(Path(unconfirmed.PATH).read_text() == "{not json", "…and the file is left as is")

print("all checks passed" if not fails else f"FAILED: {fails}")
sys.exit(1 if fails else 0)
