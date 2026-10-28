"""Trade history: a hand-wired venue's send that reported no fill in time (row A) and its
late fill (row B, lib.portfolio.book_late_fill) are one row; an A never confirmed says so;
an A the account showed never filled (audit unfilled_order_cleared) says that instead.
Rows are the shapes win-test-5 (群益, 2026-10-27/28) wrote. Every surface reads the
report's `orders`, so this is the one place the rule lives (runtime/portfolio_reporter).

Run: cd blave-agent && .venv/bin/python tests/check_order_history_pairing.py
"""
import json
import os
import shutil
import sys
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BASE = tempfile.mkdtemp(prefix="order-hist-")
WS = os.path.join(BASE, "workspace")
os.makedirs(os.path.join(WS, "manager"))
os.makedirs(os.path.join(WS, "state"))
os.environ["BLAVE_AGENT_BASE"] = BASE
os.environ["BLAVE_AGENT_WORKSPACE"] = WS
os.environ.pop("BLAVE_AGENT_LOCAL", None)
sys.path.insert(0, os.path.join(ROOT, "runtime"))

import portfolio_reporter  # noqa: E402

fails = 0


def check(cond, msg, got=None):
    global fails
    print(("ok   " if cond else "FAIL ") + msg + ("" if cond else f"\n     got: {got!r}"))
    fails += 0 if cond else 1


SPEC = {"type": "futures_contracts", "contract_value": 10, "currency": "TWD", "lot_size": 1, "margin": 35050}


def sent(ts, side, venue="capital", sym="TMF"):
    q = 1.0 if side == "BUY" else -1.0
    return {"ts": ts, "action": side, "symbol": sym, "signed_diff": q, "exchange": venue, "asset_spec": SPEC,
            "contributors": [{"strategy": "tmf_capital_oneshot", "position": 1.0, "amount": 1.0}],
            "legs": [{"signed_diff": 0.0, "reduce_only": side == "SELL", "fill_price": 0.0, "executed_qty": 0.0,
                      "exchange": venue, "signed_qty": 0.0}]}


def late(ts, side, price=None, venue="capital", sym="TMF", contract="TM2611"):
    q = 1.0 if side == "BUY" else -1.0
    leg = {"signed_diff": q, "reduce_only": side == "SELL", "signed_qty": q, "executed_qty": 1.0,
           "resolved_symbol": contract}
    if price:
        leg["fill_price"] = price
    return {"ts": ts, "action": side, "symbol": sym, "signed_diff": q, "exchange": venue, "late_fill": True,
            "contributors": [], "legs": [leg]}


OKX = {"ts": "2026-10-28T02:30:00", "action": "BUY", "symbol": "BTCUSDT", "signed_diff": 500.0, "exchange": "okx",
       "legs": [{"signed_diff": 0.0, "executed_qty": 0.0, "fill_price": 0.0}]}
REJECTED = dict(sent("2026-10-28T02:31:00", "BUY"), legs=[{"signed_diff": 1.0, "error": "保證金不足"}])


def write(rows, audit=()):
    with open(os.path.join(WS, "manager", "orders.jsonl"), "w", encoding="utf-8") as f:
        f.writelines(json.dumps(r) + "\n" for r in rows)
    with open(os.path.join(WS, "state", "audit.jsonl"), "w", encoding="utf-8") as f:
        f.writelines(json.dumps(r) + "\n" for r in audit)


try:
    # 1. win-test-5 10/28: buy and sell each parked, then claimed (the sell with no price)
    write([sent("2026-10-27T01:40:06.209327", "BUY"),
           sent("2026-10-28T02:27:08.158402", "BUY"), late("2026-10-28T02:27:33.242767", "BUY", 46934.0),
           sent("2026-10-28T02:28:18.578315", "SELL"), late("2026-10-28T02:28:43.662225", "SELL"), OKX, REJECTED])
    rows = portfolio_reporter.recent_orders()
    tmf = [r for r in rows if r.get("symbol") == "TMF" and "error" not in r["legs"][0]]
    check(len(tmf) == 3, "five TMF lines → three rows: the 10/27 send, one buy, one sell", [r.get("fill_state") for r in tmf])
    buy, sell = tmf[1], tmf[2]
    check(buy["fill_state"] == "late" and buy["ts"] == "2026-10-28T02:27:33.242767" and buy["signed_diff"] == 1.0
          and buy["legs"] == [late("x", "BUY", 46934.0)["legs"][0]] and buy["asset_spec"] == SPEC
          and buy["contributors"][0]["strategy"] == "tmf_capital_oneshot",
          "late buy: one row at the fill's time, its contract and price, the send's asset_spec and contributors", buy)
    check(sell["fill_state"] == "late" and sell["signed_diff"] == -1.0 and sell["legs"][0]["resolved_symbol"] == "TM2611"
          and "fill_price" not in sell["legs"][0], "late sell without a reported price: merged, no price invented", sell)
    check(tmf[0]["fill_state"] == "unconfirmed" and tmf[0]["signed_diff"] == 1.0,
          "10/27 send (no claim ever came, no clear): unconfirmed", tmf[0])
    okx = next(r for r in rows if r.get("exchange") == "okx")
    rej = next(r for r in rows if r.get("legs") and "error" in r["legs"][0])
    check("fill_state" not in okx,
          "a crypto row with nothing filled is not touched (only hand-wired venues park)", okx)
    check("fill_state" not in rej, "a send with a leg error is a failure, not an unconfirmed fill", rej)

    # 2. still parked (統一 the same way): no B, no clear
    write([sent("2026-10-28T03:00:00", "BUY", venue="president", sym="TXF")],
          [{"ts": "2026-10-28T02:59:59.990000+00:00", "event": "order_unfilled_parked", "venue": "president",
            "symbol": "TXF", "lots": 1.0}])
    rows = portfolio_reporter.recent_orders()
    check(len(rows) == 1 and rows[0]["fill_state"] == "unconfirmed", "統一 send still parked: unconfirmed", rows)

    # 3. cleared: the account never moved
    write([sent("2026-10-28T03:00:00", "BUY", venue="president", sym="TXF"),
           sent("2026-10-28T03:10:00", "SELL", venue="capital", sym="TMF")],
          [{"ts": "2026-10-28T03:00:30.000000+00:00", "event": "unfilled_order_cleared", "venue": "president",
            "symbol": "TXF", "contract": "TX2611", "lots": 1.0},
           {"ts": "2026-10-28T03:09:00.000000+00:00", "event": "unfilled_order_cleared", "venue": "capital",
            "symbol": "TMF", "lots": -1.0}])
    rows = portfolio_reporter.recent_orders()
    check(rows[0]["fill_state"] == "unfilled", "統一 send then unfilled_order_cleared: unfilled", rows[0])
    check(rows[1]["fill_state"] == "unconfirmed", "a clear from BEFORE the send does not clear it", rows[1])

    # 4. a late fill and its send straddling the screen cut still pair
    filler = [dict(OKX, ts=f"2026-10-28T04:{i:02d}:00", legs=[{"executed_qty": 0.01, "fill_price": 1.0}]) for i in range(25)]
    write([sent("2026-10-28T03:59:00", "BUY")] + filler + [late("2026-10-28T04:30:00", "BUY", 46000.0)])
    rows = portfolio_reporter.recent_orders()
    check(len(rows) == portfolio_reporter.ORDERS_TAIL and rows[-1]["fill_state"] == "late"
          and rows[-1]["asset_spec"] == SPEC, "send 26 lines before its late fill: still one merged row", rows[-1])

    # 5. the three states are a contract with the renderers: the desktop paints exactly these
    with open(os.path.join(ROOT, "shell", "renderer", "trade.js"), encoding="utf-8") as f:
        js = f.read()
    hist = js[js.index("function trPaintHist("):js.index("function trPaintSet(")]
    check(all(f'"{s}"' in hist for s in ("late", "unconfirmed", "unfilled")),
          "desktop trPaintHist reads the same three fill_state values the reporter writes")
finally:
    shutil.rmtree(BASE, ignore_errors=True)

print("ALL PASS" if not fails else f"{fails} FAIL")
sys.exit(1 if fails else 0)
