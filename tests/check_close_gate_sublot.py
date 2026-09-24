"""A whole-position close of ONE lot worth less than the flat $10 gate goes out
— no network.

What it protects (testnet harness, Gate.io BTCUSDT scenario 7d): one Gate BTC
contract is 0.0001 BTC ≈ $8.4. The bot can hold exactly one (a $11 target rounds
to one contract), but a whole-position close was gated at the flat $10
(_close_threshold → `.flat`), so target 0 never closed it — the bot's own
position stayed open forever. The close gate is now $10 less half a lot while a
lot is under $20 (the smallest position an entry can round to from a $10 gap).

Runs the REAL lib.order_gateio contract rules on the real BTC_USDT spec
(quanto_multiplier 0.0001, order_size_min 1) through a fake HTTP layer, and the
real reconciler gate. Also pins that the lower gate cannot reach the user's
share: the close is sized from the bot's book, capped at what it owns.

Run: cd blave-agent && .venv/bin/python tests/check_close_gate_sublot.py
"""
import json, os, sys, tempfile

import requests

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
os.chdir(tempfile.mkdtemp(prefix="close-sublot-"))
os.makedirs("manager", exist_ok=True)

MARK = 83600.0
SPEC = {"name": "BTC_USDT", "quanto_multiplier": "0.0001", "order_size_min": 1,
        "order_size_max": 1000000, "order_price_round": "0.1", "mark_price": str(MARK),
        "in_delisting": False}


def _fake(method, url, **kw):
    r = requests.Response()
    r.status_code, r.url = 200, url
    body = ([{"contract": "BTC_USDT", "mark_price": str(MARK), "last": str(MARK)}]
            if "tickers" in url else SPEC)
    r._content = json.dumps(body).encode()
    return r


requests.request = lambda m, u, **k: _fake(m, u, **k)
requests.get = lambda u, **k: _fake("GET", u, **k)

from lib import portfolio, venue_wiring, order_gateio  # noqa: E402
from manager import reconciler as rec  # noqa: E402

ENV = {"GATEIO_API_KEY": "k", "GATEIO_SECRET_KEY": "s", "GATEIO_DEMO": "true"}
venue_wiring.read_env = lambda path=".env": dict(ENV)
venue_wiring.detect_venue = lambda env: "gateio"

fails = 0


def check(cond, msg):
    global fails
    print(("ok   " if cond else "FAIL ") + msg)
    fails += 0 if cond else 1


LOT_USD = 0.0001 * MARK  # 8.36
rec._min_order_gate.clear()
close_gate = portfolio._close_threshold(rec._symbol_threshold, "BTCUSDT")
check(abs(close_gate - (10 - LOT_USD / 2)) < 0.01,
      f"Gate BTC: one lot ${LOT_USD:.2f} → the whole-close gate is $10 less half a lot "
      f"(${close_gate:.2f})")

book = {"BTCUSDT": {"side": "long", "size": LOT_USD, "qty": 0.0001}}
orders = portfolio.compute_diff({}, book, threshold=rec._symbol_threshold)
check([round(o["signed_diff"], 2) for o in orders] == [round(-LOT_USD, 2)],
      f"target 0 on the bot's one contract → one close order ({orders})")
flip = portfolio.compute_diff(
    {"BTCUSDT": {"side": "short", "size": 1.0, "exchange": None, "asset_spec": None}},
    book, threshold=rec._symbol_threshold)
check(flip and round(flip[0]["signed_diff"], 2) <= round(-LOT_USD, 2),
      f"a flip closes it too ({flip})")
check(portfolio.compute_diff({}, {"BTCUSDT": {"side": "long", "size": LOT_USD * 0.6,
                                              "qty": 0.00006}},
                             threshold=rec._symbol_threshold) == [],
      "a remainder under the line ($5.02 < $5.82) is still dust — nothing sent")
partial = portfolio.compute_diff(
    {"BTCUSDT": {"side": "long", "size": LOT_USD * 2.8, "exchange": None, "asset_spec": None}},
    {"BTCUSDT": {"side": "long", "size": LOT_USD * 3, "qty": 0.0003}},
    threshold=rec._symbol_threshold)
check(partial == [], "a partial reduce keeps its own gate (flat $10) — no churn")

# the mark rose 30%: a lot is now $10.87, the book still cost $8.36 — still closes
rec._min_order_gate.clear()
_mark = MARK
MARK = _mark * 1.3
check(portfolio.compute_diff({}, book, threshold=rec._symbol_threshold) != [],
      "after a 30% rise the bot's own contract (cost $8.36, lot now $10.87) still closes")
MARK = _mark
rec._min_order_gate.clear()

# a coarse lot keeps the flat $10 on a whole close: $8 of dust is still left alone
rec._min_order_gate.clear()
order_gateio._rules_cache.clear()
SPEC["quanto_multiplier"] = "0.001"  # one lot ≈ $83.6
check(portfolio._close_threshold(rec._symbol_threshold, "BTCUSDT") == rec.THRESHOLD,
      "one lot over $20 → the whole-close gate stays the flat $10 (anything the bot "
      "opens there is at least one lot, over $10)")
SPEC["quanto_multiplier"] = "0.0001"
rec._min_order_gate.clear()
order_gateio._rules_cache.clear()

# the close is the bot's book quantity, never the account's: the user holds two
# more contracts on the same side
venue_wiring._held_base = lambda env, vid, sym, direction: 0.0003
row = {"owned": 0.0001, "full": True, "unit_cost": LOT_USD / 0.0001}
qty, held, lot, _ = venue_wiring._book_reduce_qty(
    ENV, "gateio", order_gateio, "BTCUSDT", "long", -LOT_USD, row)
check(abs(lot - 0.0001) < 1e-12 and abs(qty - 0.0001) < 1e-12,
      f"the close sells the bot's 0.0001, not the account's 0.0003 (qty {qty}, lot {lot})")

print(f"\ncheck_close_gate_sublot: {'PASS' if not fails else f'{fails} FAILED'}")
sys.exit(1 if fails else 0)
