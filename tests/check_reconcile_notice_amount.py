"""The order notice announces what FILLED, not what was asked — no network.
2026-09-21 Binance testnet run: a partial close asked for $57.67, the venue sold
0.0003 BTC (~$24.7), the ledger recorded $24.7 (correct) and the Telegram line
said $57.67. The leg's signed_diff is already fill-based; the notice must read
the same number. Asserts: with a fill reported, the notice amount is
executed_qty × fill_price (not sub_diff); without one, it falls back to the
requested amount; lot-based fills announce lots.
Run: cd blave-agent && python3 tests/check_reconcile_notice_amount.py
"""
import os, sys, tempfile
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
os.chdir(tempfile.mkdtemp(prefix="reconnotice-"))
os.makedirs("manager", exist_ok=True)
import json  # noqa: E402
# custom templates: the amount is the only number on the line, so the test can read it back
open("manager/portfolio_config.json", "w").write(json.dumps({"messages": {
    k: k + "|{amount:.2f}" for k in ("order_buy", "order_sell", "order_close_long", "order_close_short")}}))
from lib import portfolio, venue_wiring  # noqa: E402

fails = 0


def check(cond, msg):
    global fails
    print(("ok   " if cond else "FAIL ") + msg)
    fails += 0 if cond else 1


class _FakeOrder:
    rules = {"step": 0.001, "min_qty": 0.001, "min_notional": 5.0, "contract_value": 1}

    def get_contract_rules(self, env, sym):
        return self.rules

    def get_mark_price(self, env, sym):
        return 82300.0


sys.modules["lib.order_binance"] = _FakeOrder()
venue_wiring.read_env = lambda path=".env": {"BINANCE_API_KEY": "k"}
venue_wiring.detect_venue = lambda env: "binance"
portfolio._record_order_error = lambda s, x, e: None
sent = []


def run(target_usd, held_usd, fill, spec=None, exchange=None):
    del sent[:]
    target = {"BTCUSDT": {"side": "long" if target_usd >= 0 else "short", "size": abs(target_usd),
                          "exchange": exchange, "asset_spec": spec, "contributors": []}}
    actual = {"BTCUSDT": {"side": "long", "size": abs(held_usd)}}
    portfolio.aggregate_portfolio = lambda: target
    portfolio.reconcile(get_positions_fn=lambda: actual,
                        place_order_fn=lambda symbol, signed_diff, spec, **kw: fill,
                        threshold=10, send_telegram_fn=lambda text: sent.append(text))
    return [(t.split("|")[0], {"amount": float(t.split("|")[1])}) for t in sent]


# a $57.67 close asked; the venue filled 0.0003 BTC at 82,300 = $24.69
got = run(0, 57.67, {"executed_qty": 0.0003, "avg_price": 82300.0})
check(len(got) == 1 and got[0][0] == "order_close_long" and abs(got[0][1]["amount"] - 24.69) < 0.01,
      f"partial close announces the filled $24.69, not the requested $57.67: {got}")
got = run(0, 57.67, None)
check(len(got) == 1 and abs(got[0][1]["amount"] - 57.67) < 0.01,
      f"no fill reported → falls back to the requested amount: {got}")
got = run(200, 0, {"executed_qty": 0.002, "avg_price": 82300.0})
check(len(got) == 1 and got[0][0] == "order_buy" and abs(got[0][1]["amount"] - 164.6) < 0.01,
      f"entry announces executed_qty × fill price: {got}")
got = run(2, 0, {"executed_qty": 1, "avg_price": 20000.0}, spec={"type": "futures_contracts"}, exchange="capital")
check(len(got) == 1 and got[0][1]["amount"] == 1, f"lot-based: announces the lots filled (1), not the 2 asked: {got}")

print("\n" + ("PASS" if not fails else f"{fails} FAILED"))
sys.exit(1 if fails else 0)
