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


def write(rows, audit=()):
    with open(os.path.join(WS, "manager", "orders.jsonl"), "w", encoding="utf-8") as f:
        f.writelines(json.dumps(r) + "\n" for r in rows)
    with open(os.path.join(WS, "state", "audit.jsonl"), "w", encoding="utf-8") as f:
        f.writelines(json.dumps(r) + "\n" for r in audit)


def filled(ts, side, lots, got, venue="president", sym="TXF", contract="TX2611"):
    """A row lib.portfolio.reconcile writes for a send that filled `got` lots of a
    `lots` request (signed_diff stays the pre-rounding / pre-cap request)."""
    q = got if side == "BUY" else -got
    return {"ts": ts, "action": side, "symbol": sym, "signed_diff": lots, "exchange": venue, "asset_spec": SPEC,
            "contributors": [], "legs": [{"signed_diff": q, "reduce_only": side == "SELL", "fill_price": 23000.0,
                                          "executed_qty": got, "exchange": venue, "signed_qty": q,
                                          "resolved_symbol": contract}]}


try:
    # 1. win-test-5 10/28: buy and sell each parked, then claimed (the sell with no price)
    write([sent("2026-10-27T01:40:06.209327", "BUY"),
           sent("2026-10-28T02:27:08.158402", "BUY"), late("2026-10-28T02:27:33.242767", "BUY", 46934.0),
           sent("2026-10-28T02:28:18.578315", "SELL"), late("2026-10-28T02:28:43.662225", "SELL"), OKX])
    rows = portfolio_reporter.recent_orders()
    tmf = [r for r in rows if r.get("symbol") == "TMF"]
    check(len(tmf) == 3, "five TMF lines → three rows: the 10/27 send, one buy, one sell", [r.get("fill_state") for r in tmf])
    buy, sell = (tmf + [{}, {}, {}])[1:3]
    check(buy.get("fill_state") == "late" and buy.get("ts") == "2026-10-28T02:27:33.242767" and buy.get("signed_diff") == 1.0
          and buy.get("legs") == [late("x", "BUY", 46934.0)["legs"][0]] and buy.get("asset_spec") == SPEC
          and (buy.get("contributors") or [{}])[0].get("strategy") == "tmf_capital_oneshot",
          "late buy: one row at the fill's time, its contract and price, the send's asset_spec and contributors", buy)
    check(sell.get("fill_state") == "late" and sell.get("signed_diff") == -1.0
          and (sell.get("legs") or [{}])[0].get("resolved_symbol") == "TM2611"
          and "fill_price" not in (sell.get("legs") or [{}])[0], "late sell without a reported price: merged, no price invented", sell)
    check(tmf[:1] and tmf[0].get("fill_state") == "unconfirmed" and tmf[0].get("signed_diff") == 1.0,
          "10/27 send (no claim ever came, no clear): unconfirmed", tmf[:1])
    okx = next((r for r in rows if r.get("exchange") == "okx"), {})
    check("fill_state" not in okx, "a crypto row with nothing filled is not touched (only hand-wired venues park)", okx)

    # 2. still parked (統一 the same way): no B, no clear
    write([sent("2026-10-28T03:00:00", "BUY", venue="president", sym="TXF")],
          [{"ts": "2026-10-28T02:59:59.990000+00:00", "event": "order_unfilled_parked", "venue": "president",
            "symbol": "TXF", "lots": 1.0}])
    rows = portfolio_reporter.recent_orders()
    check(len(rows) == 1 and rows[0].get("fill_state") == "unconfirmed", "統一 send still parked: unconfirmed", rows)

    # 3. cleared: the account never moved
    write([sent("2026-10-28T03:00:00", "BUY", venue="president", sym="TXF"),
           sent("2026-10-28T03:10:00", "SELL", venue="capital", sym="TMF")],
          [{"ts": "2026-10-28T03:00:30.000000+00:00", "event": "unfilled_order_cleared", "venue": "president",
            "symbol": "TXF", "contract": "TX2611", "lots": 1.0},
           {"ts": "2026-10-28T03:09:00.000000+00:00", "event": "unfilled_order_cleared", "venue": "capital",
            "symbol": "TMF", "lots": -1.0}])
    rows = portfolio_reporter.recent_orders() + [{}, {}]
    check(rows[0].get("fill_state") == "unfilled", "統一 send then unfilled_order_cleared: unfilled", rows[0])
    check(rows[1].get("fill_state") == "unconfirmed", "a clear from BEFORE the send does not clear it", rows[1])

    # 4. a late fill and its send straddling the screen cut still pair
    filler = [dict(OKX, ts=f"2026-10-28T04:{i:02d}:00", legs=[{"executed_qty": 0.01, "fill_price": 1.0}]) for i in range(25)]
    write([sent("2026-10-28T03:59:00", "BUY")] + filler + [late("2026-10-28T04:30:00", "BUY", 46000.0)])
    rows = portfolio_reporter.recent_orders()
    check(len(rows) == portfolio_reporter.ORDERS_TAIL and rows[-1].get("fill_state") == "late"
          and rows[-1].get("asset_spec") == SPEC, "send 26 lines before its late fill: still one merged row", rows[-1])

    # 4b. fully filled rows whose signed_diff is not what was sent are fills, never "unconfirmed":
    # a 統一 flip (close leg only, the entry leg deferred), a fractional diff rounded down,
    # a close capped at what the account holds
    flip = filled("2026-10-28T05:00:00", "SELL", -2.0, 1.0)
    rounded = filled("2026-10-28T05:10:00", "BUY", 1.4, 1.0, venue="capital", sym="TMF", contract="TM2611")
    capped = filled("2026-10-28T05:20:00", "SELL", -2.0, 1.0, venue="capital", sym="TMF", contract="TM2611")
    write([flip, rounded, capped, late("2026-10-28T05:30:00", "SELL", venue="capital")])
    rows = portfolio_reporter.recent_orders()
    check([r.get("fill_state") for r in rows[:3]] == [None, None, None] and rows[:3] == [flip, rounded, capped],
          "統一 flip / rounded / capped rows: untouched", [r.get("fill_state") for r in rows])
    check(len(rows) == 4 and rows[3].get("fill_state") == "late" and "asset_spec" not in rows[3],
          "a late fill with no unconfirmed send before it is not glued onto a filled row", rows[3:])

    # 4c. partial fill (1 of 2) then the rest cleared / filled late: the row shows the lot that filled
    part = filled("2026-10-28T06:00:00", "BUY", 2.0, 1.0)
    write([part, late("2026-10-28T06:01:00", "BUY", venue="president", sym="TXF", contract="TX2611")],
          [{"ts": "2026-10-28T06:00:40.000000+00:00", "event": "unfilled_order_cleared", "venue": "president",
            "symbol": "TXF", "lots": 1.0}])
    rows = portfolio_reporter.recent_orders()
    check(len(rows) == 2 and rows[0] == part and "fill_state" not in rows[0] and rows[1].get("fill_state") == "late",
          "partial fill: not marked unfilled by a clear, its late remainder stays its own row", rows)

    # 4d. a garbled row (legs not a list) does not take the report down
    write([dict(sent("2026-10-28T07:00:00", "BUY"), legs=5), late("2026-10-28T07:01:00", "BUY"), "x", 3])
    try:
        rows = portfolio_reporter.recent_orders()
        ok = len(rows) == 4
    except Exception as e:  # noqa: BLE001
        ok, rows = False, repr(e)
    check(ok, "legs not a list / non-dict lines: the report still builds", rows)

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
