"""A close that only partly fills is not a close (audit Delta 4 #2).

OKX's _confirm returns a canceled-with-fill order; any venue can. Close-all
and close_symbol used to count it as closed and zero the bot's book, leaving
the unfilled rest open on the venue as nobody's — counted as the user's, and
bought on top of at the next entry. Now: every venue's executed_qty is
compared with what was asked; a shortfall keeps the remainder in the book and
says 「未平完」. Made-up numbers; no network.

Run: cd blave-agent && .venv/bin/python tests/check_partial_close.py
"""
import json
import os
import sys
import tempfile
import types

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WS = tempfile.mkdtemp(prefix="partial-")
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
import lib.portfolio as pf  # noqa: E402
import lib.venue_wiring as vw  # noqa: E402

fails = 0


def check(cond, msg):
    global fails
    print(("ok   " if cond else "FAIL ") + msg)
    fails += 0 if cond else 1


vw.read_env = lambda *a, **k: {"OKX_API_KEY": "x"}
vw.detect_venue = lambda env: "okx"
ERRS = []
flatten._read_env = lambda path=".env": {"OKX_API_KEY": "x", "OKX_SECRET_KEY": "x", "OKX_PASSPHRASE": "x"}
flatten._wait_for_inflight = lambda *a, **k: []
flatten._record_order_error = lambda *a, **k: ERRS.append(a)
flatten.guard = types.SimpleNamespace(halted=lambda: True, trip_halt=lambda *a: None,
                                      restart_stopped=lambda: False)
FILL = {"swap": 0.004, "spot": 0.2}
acct = types.ModuleType("lib.account_okx")
acct.get_positions = lambda env: [{"symbol": "BTCUSDT", "side": "long", "size": 0.01, "mark_price": 70000.0}]
order = types.ModuleType("lib.order_okx")
order.format_qty = lambda env, s, q: "1"
order.close_position_partial = lambda env, sym, side, size, client_order_id=None: \
    {"status": "canceled", "executed_qty": FILL["swap"], "avg_price": 70000.0}
order.get_spot_balances = lambda env: {"ETH": 1.0}
order.get_spot_price = lambda env, sym: 2000.0
order.place_spot_market_order = lambda env, sym, side, base_qty=None, quote_qty=None, client_order_id=None: \
    {"status": "canceled", "executed_qty": FILL["spot"], "avg_price": 2000.0}
sys.modules["lib.account_okx"], sys.modules["lib.order_okx"] = acct, order
for p in ("lib/account_okx.py", "lib/order_okx.py"):
    open(p, "w").close()


def fresh():
    del ERRS[:]
    json.dump({"seeded_at": "2026-09-01T00:00:00", "own_only_basis": 1, "symbols": {}},
              open("manager/ledger_seed.json", "w"))
    open("manager/orders.jsonl", "w").write(
        json.dumps({"ts": "2026-09-02T00:00:00", "symbol": "BTCUSDT", "exchange": "okx",
                    "legs": [{"signed_diff": 700.0, "signed_qty": 0.01, "executed_qty": 0.01}]}) + "\n"
        + json.dumps({"ts": "2026-09-02T00:00:01", "symbol": "ETHUSDT@spot", "exchange": "okx",
                      "legs": [{"signed_diff": 1000.0, "signed_qty": 0.5, "executed_qty": 0.5}]}) + "\n")
    json.dump({"amounts": {"btc": 700}, "exchanges": {"btc": "okx"}}, open("manager/portfolio_config.json", "w"))


print("== close-all")
fresh()
flatten._LOCK = None
ok = flatten.flatten()
book = pf.ledger_positions("okx")
check(ok is False and any("未平完" in str(e) for e in ERRS),
      f"a 0.004 fill on a 0.01 close: close-all reports failure and says 未平完 ({ERRS[:1]})")
check(abs(book.get("BTCUSDT", {}).get("qty", 0) - 0.006) < 1e-12,
      f"…the unfilled 0.006 stays the bot's in the book ({book.get('BTCUSDT')})")
check(abs(book.get("ETHUSDT@spot", {}).get("qty", 0) - 0.3) < 1e-12,
      f"spot: 0.2 sold of the bot's 0.5 — 0.3 stays in the book ({book.get('ETHUSDT@spot')})")
FILL.update(swap=0.01, spot=0.5)
fresh()
flatten._LOCK = None
ok = flatten.flatten()
check(ok is True and pf.ledger_positions("okx") == {} and not ERRS,
      "a full fill: closed, the book is empty, no error")

print("== close_symbol")
sys.path.append(os.path.join(ROOT, "manager"))  # close_symbol imports `flatten` as a sibling
import close_symbol as cs  # noqa: E402
cs.wait_inflight = lambda sym: []
acct.get_equity = lambda env: {"equity": 1000}
order.get_open_orders = lambda env, sym: []
order.get_open_algo_orders = lambda env, sym, ord_types=None: []
order.CLOSE_ALGO_ORD_TYPES = ()
order.__name__ = "lib.order_okx"
cs_errs = []
pf._record_order_error = lambda *a, **k: cs_errs.append(a)
for fill, want_ok in ((0.004, False), (0.01, True)):
    FILL["swap"] = fill
    fresh()
    open_after = [0.01 - fill]
    reads = [0]

    def positions(env, o=open_after):
        # the read before and the re-read after the cancel see 0.01; the read after the close
        # sees what is left
        reads[0] += 1
        size = 0.01 if reads[0] <= 2 else o[0]
        return [{"symbol": "BTCUSDT", "side": "long", "size": size, "mark_price": 70000.0}] if size > 1e-12 else []
    acct.get_positions = positions
    ctx = cs.Ctx(venue="okx", sym="BTCUSDT", side="long", env={}, key="k", generic=True,
                 acct=acct, order=order)
    del cs_errs[:]
    rc = cs.run_close(ctx)
    qty = (pf.ledger_positions("okx").get("BTCUSDT") or {}).get("qty", 0)
    if want_ok:
        check(rc == cs.OK and qty == 0, f"close_symbol, full fill: OK and the book is zeroed ({rc}, {qty})")
    else:
        check(rc != cs.OK and any("未平完" in str(e) for e in cs_errs) and abs(qty - 0.006) < 1e-12,
              f"close_symbol, 0.004 of 0.01: not OK, 未平完, 0.006 stays in the book ({rc}, {qty})")

print("\n" + ("all ok" if not fails else f"{fails} FAILED"))
sys.exit(1 if fails else 0)
