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
open("manager/portfolio_config.json", "w").write(json.dumps({"self_ledger": False, "messages": {
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


def run(target_usd, held_usd, fill, spec=None, exchange=None, sym="BTCUSDT"):
    del sent[:]
    target = {sym: {"side": "long" if target_usd >= 0 else "short", "size": abs(target_usd),
                    "exchange": exchange, "asset_spec": spec, "contributors": []}}
    actual = {sym: {"side": "long", "size": abs(held_usd)}}
    portfolio.aggregate_portfolio = lambda: target
    portfolio.reconcile(get_positions_fn=lambda: actual,
                        place_order_fn=lambda symbol, signed_diff, spec, **kw: fill,
                        threshold=10, send_telegram_fn=lambda text: sent.append(text))
    return [(t.split("|")[0], {"amount": float(t.split("|")[1])}) for t in sent if "|" in t]


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

# 群益: the leg keeps the month contract that filled — orders.jsonl's symbol is the book key (TXF),
# so without it the pages can never show 「大台（TX2610）」 (audit-0.1.13-desktop D1)
open("manager/orders.jsonl", "w").close()
run(2, 0, {"executed_qty": 2, "avg_price": 23000.0, "exchange": "capital", "resolved_symbol": "TX2610", "status": "filled"},
    spec={"type": "futures_contracts"}, exchange="capital")
rows = [json.loads(x) for x in open("manager/orders.jsonl") if x.strip()]
check(rows and rows[-1]["legs"][0].get("resolved_symbol") == "TX2610", f"capital leg carries resolved_symbol: {rows[-1:] }")
open("manager/orders.jsonl", "w").close()
run(2, 0, {"executed_qty": 0.0, "avg_price": 0.0, "exchange": "capital", "resolved_symbol": "TM0000", "status": "sent"},
    spec={"type": "futures_contracts"}, exchange="capital")
rows = [json.loads(x) for x in open("manager/orders.jsonl") if x.strip()]
check(not rows or "resolved_symbol" not in rows[-1]["legs"][0],
      f"an unconfirmed capital order (0 filled) does not carry its alias as the month contract: {rows[-1:]}")

# Sent but nothing filled yet (群益/統一 park it, work order live-order-batch0 B): no
# "Bought TXF 0 lots", but the row stays — it is the trade history's row A — and the order
# stays in reconcile()'s return so the 5-second re-run still claims a late fill.
FUT = {"type": "futures_contracts"}
open("manager/orders.jsonl", "w").close()
del sent[:]
target = {"TXF": {"side": "long", "size": 1, "exchange": "capital", "asset_spec": FUT, "contributors": []}}
portfolio.aggregate_portfolio = lambda: target
ret = portfolio.reconcile(get_positions_fn=lambda: {"TXF": {"side": "long", "size": 0}},
                          place_order_fn=lambda symbol, signed_diff, spec, **kw: {
                              "status": "sent", "executed_qty": 0, "sent_qty": 1, "sent_symbol": "TX2612",
                              "avg_price": 0, "exchange": "capital"},
                          threshold=10, send_telegram_fn=lambda text: sent.append(text))
rows = [json.loads(x) for x in open("manager/orders.jsonl") if x.strip()]
check(not [t for t in sent if "|" in t], f"0 filled: no buy notice: {sent}")
check(len(rows) == 1 and rows[0]["legs"][0].get("sent_qty") == 1 and rows[0]["legs"][0].get("executed_qty") == 0,
      f"0 filled: orders.jsonl still has the send with sent_qty: {rows}")
check(len(ret) == 1, f"0 filled: reconcile() still returns it (the late-fill re-run): {ret}")
os.environ["BLAVE_AGENT_BASE"] = os.getcwd()
os.environ["BLAVE_AGENT_WORKSPACE"] = os.getcwd()
sys.path.insert(0, os.path.join(ROOT, "runtime"))
import portfolio_reporter  # noqa: E402
paired = portfolio_reporter.pair_unconfirmed_orders(rows, lambda names: [])
check(paired and paired[-1].get("fill_state") == "unconfirmed",
      f"0 filled: the row pairs as 送出未確認: {paired}")

got = run(0, 57.67, {"executed_qty": 0, "avg_price": 0})
check(got == [], f"0 filled reduce-only close: no Closed notice: {got}")
open("manager/orders.jsonl", "w").close()
run(100, 0, {"executed_qty": 0.001, "avg_price": 82300.0})  # a held position the zero row lands on
got = run(200, 0, {"executed_qty": 0, "avg_price": 0})
check(got == [], f"0 filled crypto entry: no notice for the requested $200: {got}")
rows = [json.loads(x) for x in open("manager/orders.jsonl") if x.strip()]
leg = rows[-1]["legs"][0] if rows else {}
check(len(rows) == 2 and leg.get("signed_diff") == 0 and leg.get("executed_qty") == 0,
      f"0 filled crypto entry: the row stays, its leg records signed_diff 0, not the $200 asked: {rows[-1:]}")
book, _ = portfolio._ledger_walk()
check(abs(book.get("BTCUSDT", {}).get("cost", 0) - 82.3) < 0.01,
      f"0 filled crypto entry: the book replayed from orders.jsonl does not grow by the request: {book}")
# the fill that shows up later comes in through the park-and-claim path, once per park id
park = {"venue": "binance", "parked_at": 0, "signed_diff": 200, "sign": 1, "contributors": []}
portfolio.book_unconfirmed("BTCUSDT", park, 0.002, 82300.0, source="venue", pid="P-late")
portfolio.book_unconfirmed("BTCUSDT", park, 0.002, 82300.0, source="venue", pid="P-late")
book, _ = portfolio._ledger_walk()
claimed = [r for r in (json.loads(x) for x in open("manager/orders.jsonl") if x.strip())
           if r.get("unconfirmed_park_id") == "P-late"]
check(len(claimed) == 1 and abs(book.get("BTCUSDT", {}).get("cost", 0) - 246.9) < 0.01,
      f"a later fill is claimed once and the book holds only it: {len(claimed)} rows, {book}")
fills = iter([{"executed_qty": 0.0005, "avg_price": 82300.0}, {"executed_qty": 0, "avg_price": 0}])
del sent[:]
target = {"BTCUSDT": {"side": "short", "size": 60, "exchange": None, "asset_spec": None, "contributors": []}}
portfolio.aggregate_portfolio = lambda: target
portfolio.reconcile(get_positions_fn=lambda: {"BTCUSDT": {"side": "long", "size": 60}},
                    place_order_fn=lambda symbol, signed_diff, spec, **kw: next(fills),
                    threshold=10, send_telegram_fn=lambda text: sent.append(text))
got = [t.split("|")[0] for t in sent if "|" in t]
check(got == ["order_close_long"], f"flip, close filled and entry 0: only the close is announced: {sent}")

# the default templates: a paper TW stock row is TWD, not "$" (paper e2e 0127b1 B2)
open("manager/portfolio_config.json", "w").write(json.dumps({"self_ledger": False}))
del sent[:]
portfolio._paper_tw_closed_keys = lambda target, diff_actual: set()
run(500000, 0, {"executed_qty": 460, "avg_price": 1085.0}, exchange="paper", sym="2330@spot")
tw_line = list(sent)
run(200, 0, {"executed_qty": 0.002, "avg_price": 82300.0})
check(len(tw_line) == 1 and tw_line[0].endswith(" 499,100 TWD") and "$" not in tw_line[0]
      and len(sent) == 1 and sent[0].endswith(" $164.60"),
      f"default notice: a TW stock fill reads TWD, crypto keeps $: {tw_line} / {sent}")

print("\n" + ("PASS" if not fails else f"{fails} FAILED"))
sys.exit(1 if fails else 0)
