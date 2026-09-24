"""A spot buy's fee comes out of the coin bought — the book must hold what arrived.

Every venue reports the pre-fee fill (`executed_qty`) and the fee separately;
the wallet receives executed − fee when the fee is in the base coin. Booking
the pre-fee quantity made every full close (close-all included) sell one fee's
worth of the user's own coins of that asset. The book now takes
lib.venue_wiring.spot_book_qty; executed_qty keeps its meaning.

A wallet simulator stands in for the venue (0.1% fee); the order path, the
book and close-all are the real ones. The user holds 0.5 ETH throughout, and
after the bot buys and fully closes it must hold EXACTLY 0.5 ETH.

Run: cd blave-agent && .venv/bin/python tests/check_spot_fee_book.py
"""
import json
import os
import sys
import tempfile
import time
import types

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WS = tempfile.mkdtemp(prefix="spotfee-")
os.environ["BLAVE_AGENT_HOME"] = os.environ["BLAVECLAW_HOME"] = WS
os.environ["BLAVE_AGENT_BASE"] = WS
os.environ["BLAVE_AGENT_WORKSPACE"] = WS
os.environ.pop("BLAVE_AGENT_LOCAL", None)
for d in ("manager", "state", "strategies/eth_spot", "lib"):
    os.makedirs(os.path.join(WS, d), exist_ok=True)
sys.path.insert(0, ROOT)


def _no_real_env(event, args):
    if event == "open" and os.path.abspath(str(args[0])) == os.path.join(ROOT, ".env"):
        raise PermissionError("the repo .env must never be read by a test")


sys.addaudithook(_no_real_env)
os.chdir(WS)

from lib import portfolio, venue_wiring  # noqa: E402
import lib.order_binance as ob  # noqa: E402
import lib.account_binance as ab  # noqa: E402

portfolio._notify_best_effort = lambda msg: None
portfolio._record_order_error = lambda *a, **k: None

fails = 0


def check(cond, msg):
    global fails
    print(("ok   " if cond else "FAIL ") + msg)
    fails += 0 if cond else 1


PRICE = 2000.0
FEE = 0.001
USER_ETH = 0.5
WALLET = {}
MODE = ["base"]  # the buy fee's asset: "base" (ETH) | "bnb" | "none" (no fee field)
SELLS = []

venue_wiring.read_env = lambda path=".env": {"BINANCE_API_KEY": "k", "BINANCE_SECRET_KEY": "k"}
venue_wiring.detect_venue = lambda env: "binance"
ob.get_spot_rules = lambda env, sym: {"step": "0.00000001", "min_qty": 0.00000001,
                                      "min_notional": 1.0, "price_tick": "0.01", "active": True}
ob.get_spot_price = lambda env, sym: PRICE
ob.get_spot_balances = lambda env: dict(WALLET)
ab.get_positions = lambda env: []


def _market(env, symbol, side, base_qty=None, quote_qty=None, client_order_id=None):
    """The venue: a buy spends quote, credits executed − fee (base-coin fee) or
    executed (fee paid in BNB); a sell debits exactly base_qty, fee in USDT."""
    if side == "buy":
        gross = float(f"{quote_qty / PRICE:.12g}")
        out = {"status": "FILLED", "avg_price": PRICE, "executed_qty": gross, "quote_qty": quote_qty}
        if MODE[0] == "base":
            fee = float(f"{gross * FEE:.12g}")
            WALLET["ETH"] = WALLET.get("ETH", 0.0) + gross - fee
            out.update(commission=fee, commission_asset="ETH")
        elif MODE[0] == "mixed":
            # BNB runs out mid-order: the first fill pays in BNB, the second in ETH
            eth_fee = float(f"{gross / 2 * FEE:.12g}")
            WALLET["ETH"] = WALLET.get("ETH", 0.0) + gross - eth_fee
            out.update(commission=0.00005, commission_asset="BNB",
                       commissions={"BNB": 0.00005, "ETH": eth_fee})
        elif MODE[0] == "bnb":
            WALLET["ETH"] = WALLET.get("ETH", 0.0) + gross
            WALLET["BNB"] = WALLET.get("BNB", 1.0) - 0.0001
            out.update(commission=0.0001, commission_asset="BNB")
        else:  # a venue whose fill carries no fee field; it still took 0.1% of the coin
            WALLET["ETH"] = WALLET.get("ETH", 0.0) + gross * (1 - FEE)
        return out
    qty = float(ob.format_spot_qty(env, symbol, base_qty))
    SELLS.append(qty)
    WALLET["ETH"] = float(f"{WALLET['ETH'] - qty:.12g}")
    return {"status": "FILLED", "avg_price": PRICE, "executed_qty": qty,
            "quote_qty": qty * PRICE, "commission": qty * PRICE * FEE, "commission_asset": "USDT"}


ob.place_spot_market_order = _market
CFG, SEED, ORDERS = "manager/portfolio_config.json", "manager/ledger_seed.json", "manager/orders.jsonl"


def signal(pos):
    open("strategies/eth_spot/strategy.py", "w").write('MARKET = "spot"\n')
    json.dump({"symbol": "ETHUSDT", "position": pos, "market": "spot", "updated_at": int(time.time())},
              open("strategies/eth_spot/state.json", "w"))


def fresh(mode):
    MODE[0] = mode
    for p in (SEED, ORDERS, "manager/last_reconcile.json", "manager/spot_scope.json"):
        if os.path.exists(p):
            os.remove(p)
    WALLET.clear()
    WALLET.update(ETH=USER_ETH, USDT=10000.0)
    del SELLS[:]
    json.dump({"amounts": {"eth_spot": 100}, "exchanges": {"eth_spot": "binance"}}, open(CFG, "w"))
    json.dump({"seeded_at": "2026-09-01T00:00:00", "own_only_basis": 1, "symbols": {}}, open(SEED, "w"))


def rnd():
    def place(symbol, diff, spec=None, **kw):
        kw.pop("contributors", None)
        return venue_wiring.auto_place_order(symbol, diff, spec, **kw)
    portfolio.reconcile(get_positions_fn=venue_wiring.auto_get_positions, place_order_fn=place,
                        threshold=10)


def bot_eth():
    return (portfolio.ledger_positions("binance").get("ETHUSDT@spot") or {}).get("qty", 0.0)


# ── the booking rule, per venue shape ────────────────────────────────────────
q = venue_wiring.spot_book_qty
check(q("binance", "ETHUSDT", "buy", {"executed_qty": 0.05, "commission": 0.00005,
                                      "commission_asset": "ETH"}) == (0.04995, True)
      and q("okx", "ETHUSDT", "buy", {"executed_qty": 0.05, "commission": 0.00005,
                                      "commission_asset": "eth"}) == (0.04995, True)
      and q("gateio", "ETHUSDT", "buy", {"executed_qty": 0.05, "commission": 0.00005,
                                         "commission_asset": "ETH"}) == (0.04995, True),
      "Binance / OKX / Gate.io: a base-coin fee comes off the booked quantity")
check(q("bybit", "ETHUSDT", "buy", {"executed_qty": 0.05, "commission": 0.00005}) == (0.04995, True),
      "Bybit: no fee asset in the fill, but its spot buy fee is always the base coin (measured)")
check(q("binance", "ETHUSDT", "buy", {"executed_qty": 0.05, "commission": 0.0001,
                                      "commission_asset": "BNB"}) == (0.05, True)
      and q("paper", "ETHUSDT", "buy", {"executed_qty": 0.05, "commission": 0.1,
                                        "commission_asset": "USDT"}) == (0.05, True),
      "a fee paid in BNB or USDT leaves the coin untouched")
check(q("bingx", "ETHUSDT", "buy", {"executed_qty": 0.05}) == (0.0499, False),
      "no fee field (BingX): 0.2% assumed and flagged — never more than arrived")
check(q("binance", "ETHUSDT", "sell", {"executed_qty": 0.05, "commission": 0.1,
                                       "commission_asset": "USDT"}) == (0.05, True),
      "a sell's fee is in the quote: the coins that left are the fill")

# ── buy, then a full close through the reconciler ────────────────────────────
print("== base-coin fee: buy, signal flat, full close")
fresh("base")
signal(1.0)
rnd()
held = WALLET["ETH"] - USER_ETH
check(abs(bot_eth() - held) < 1e-15 and abs(held - 0.04995) < 1e-12,
      f"the book holds what arrived: {bot_eth()} (the fill was 0.05, 0.1% fee in ETH)")
signal(0.0)
rnd()
check(WALLET["ETH"] == USER_ETH and SELLS == [0.04995] and bot_eth() == 0.0,
      f"the close sells exactly the bot's 0.04995: the user's 0.5 ETH untouched ({WALLET['ETH']!r})")

print("== BNB fee")
fresh("bnb")
signal(1.0)
rnd()
check(bot_eth() == 0.05, f"a BNB fee: the whole fill arrived and is booked ({bot_eth()})")
signal(0.0)
rnd()
check(WALLET["ETH"] == USER_ETH and SELLS == [0.05], f"…closed exactly, user untouched ({WALLET['ETH']!r})")

print("== no fee field")
fresh("none")
signal(1.0)
rnd()
check(bot_eth() == 0.0499 and os.path.exists("state/audit.jsonl")
      and any('"spot_fee_unknown"' in l for l in open("state/audit.jsonl")),
      f"no fee reported: 0.2% assumed and flagged in the audit ({bot_eth()})")
signal(0.0)
rnd()
check(WALLET["ETH"] >= USER_ETH and SELLS == [0.0499],
      f"…the close never reaches the user's coins; the bot's unknown-fee margin stays behind "
      f"({WALLET['ETH']!r})")

# ── the chase (limit) path and TWAP / custom slices book the same quantity ──
print("== limit / sliced executions")
ob.place_spot_limit_order = lambda env, sym, side, qty, price, client_order_id=None, post_only=False: \
    {"order_id": "77", "status": "NEW"}
ob.get_spot_order = lambda env, sym, oid: {"status": "FILLED", "executed_qty": 0.05, "avg_price": PRICE,
                                           "orig_qty": 0.05, "commission": 0.00005,
                                           "commission_asset": "ETH"}
tk = venue_wiring.auto_limit_toolkit("ETHUSDT@spot")
tk["place"](100.0, PRICE, None, True)
st = tk["status"]("77")
check(st["executed_qty"] == 0.05 and st["book_qty"] == 0.04995,
      f"chase status: executed_qty stays the fill, book_qty is net of the ETH fee ({st})")
with open(os.path.join(ROOT, "lib", "execute.py"), encoding="utf-8") as f:
    ex = f.read()
check(ex.count('float(placed.get("book_qty", base))') == 2 and ex.count('st.get("book_qty", st["executed_qty"])') == 2
      and 'float(placed.get("book_qty", qty))' in ex and 'filled_base=sum(f.get("book", f["base"]) for f in fills)' in ex,
      "lib/execute books book_qty at every slice / chase / fallback site")

print("== BNB runs out mid-order (part BNB, part coin)")
fresh("mixed")
signal(1.0)
rnd()
check(abs(bot_eth() - (WALLET["ETH"] - USER_ETH)) < 1e-15,
      f"booked per fill asset: only the ETH part comes off ({bot_eth()})")
signal(0.0)
rnd()
check(WALLET["ETH"] == USER_ETH, f"…the close leaves the user exactly 0.5 ({WALLET['ETH']!r})")

print("== chase fills: fee read from the venue's fills")
ob.get_spot_order = lambda env, sym, oid: {"status": "FILLED", "executed_qty": 0.05, "avg_price": PRICE,
                                           "orig_qty": 0.05}   # Binance's order query: no fee
FEES = {"77": {"ETH": 0.00005}}
calls = []
ob.get_spot_fill_fees = lambda env, sym, oid: calls.append(oid) or FEES.get(str(oid))
tk = venue_wiring.auto_limit_toolkit("ETHUSDT@spot")
tk["place"](100.0, PRICE, None, True)
st1, st2 = tk["status"]("77"), tk["status"]("77")
check(st1["book_qty"] == 0.04995 and st2["book_qty"] == 0.04995 and calls == ["77"],
      f"Binance chase buy: myTrades says 0.00005 ETH → booked exactly, read once per order ({st1}, {calls})")
FEES["77"] = {"BNB": 0.0001}
tk = venue_wiring.auto_limit_toolkit("ETHUSDT@spot")
tk["place"](100.0, PRICE, None, True)
check(tk["status"]("77")["book_qty"] == 0.05, "…a BNB fee: the whole fill is booked")
FEES["77"] = None
tk = venue_wiring.auto_limit_toolkit("ETHUSDT@spot")
tk["place"](100.0, PRICE, None, True)
check(tk["status"]("77")["book_qty"] == 0.0499, "…fills unreadable: the conservative cap, flagged")
import lib.order_bybit as bxo  # noqa: E402
bxo._request = lambda env, m, path, params=None, body=None, retries=3: {"list": [
    {"orderStatus": "Filled", "qty": "0.05", "cumExecQty": "0.05", "avgPrice": "2000",
     "cumExecFee": "0.00005"}]}
row = bxo.get_spot_order({}, "ETHUSDT", "9")
check(row.get("commission") == 0.00005 and venue_wiring.spot_book_qty("bybit", "ETHUSDT", "buy", row) == (0.04995, True),
      f"Bybit chase: the order row now carries cumExecFee → booked exactly ({row})")

# ── close-all ────────────────────────────────────────────────────────────────
print("== close-all")
from manager import flatten  # noqa: E402  (chdirs to the repo root on import)
os.chdir(WS)
flatten._read_env = lambda path=".env": {"BINANCE_API_KEY": "k", "BINANCE_SECRET_KEY": "k"}
flatten._wait_for_inflight = lambda *a, **k: []
flatten._record_order_error = lambda *a, **k: None
flatten.guard = types.SimpleNamespace(halted=lambda: True, trip_halt=lambda *a: None,
                                      restart_stopped=lambda: False)
import lib.account_binance as _ab  # noqa: E402
_ab.get_account_id = lambda env: "U1"  # close-all checks the book's account first — no network
for p in ("lib/account_binance.py", "lib/order_binance.py"):
    open(p, "w").close()
for mode in ("base", "bnb"):
    fresh(mode)
    signal(1.0)
    rnd()
    del SELLS[:]
    flatten._LOCK = None
    flatten.flatten()
    check(WALLET["ETH"] == USER_ETH and len(SELLS) == 1,
          f"{mode} fee: close-all sells the bot's coins only — the user's 0.5 ETH exact "
          f"({WALLET['ETH']!r}, sold {SELLS})")

print("\n" + ("all ok" if not fails else f"{fails} FAILED"))
sys.exit(1 if fails else 0)
