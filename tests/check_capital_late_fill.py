"""Minimal check: a 群益 futures order whose fill report arrives late is still booked.
8/17 live: fill reports came 15–30 s after the order; with only confirm_timeout (15 s)
the lib returned 'sent' / fill 0 for an order that had filled, and under self_ledger the
next round bought the same lots again. Runs the REAL _send / _finish / _await_fill /
_late_rows against a fake SKCOM with a virtual clock (no Windows, no broker, no waiting),
and the reconciler's _capital_place_order for the user-facing record.

Run: cd blave-agent && python3 tests/check_capital_late_fill.py
"""
import os
import sys
import tempfile
import types

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
os.chdir(tempfile.mkdtemp(prefix="capital-late-", dir=os.environ.get("SCRATCHPAD") or None))
os.makedirs("state", exist_ok=True)

import lib.order_capital as oc

fails = 0


def check(cond, msg):
    global fails
    print(("  PASS  " if cond else "  FAIL  ") + msg)
    fails += (not cond)


class Clock:
    t = 0.0


clk = Clock()
oc.time = types.SimpleNamespace(time=lambda: clk.t, sleep=lambda s: setattr(clk, "t", clk.t + s))

deliveries = []        # (at, seq_no, row)
pump = {"raise_at": None}


class Fills:
    fills = {}


class Pump:
    @staticmethod
    def PumpWaitingMessages():
        if pump["raise_at"] is not None and clk.t >= pump["raise_at"]:
            pump["raise_at"] = None
            raise OSError("COM pump failed (fake)")
        for d in list(deliveries):
            if d[0] <= clk.t:
                Fills.fills.setdefault(d[1], []).append(d[2])
                deliveries.remove(d)


plan = {}
orders_sent = []


class Sess:
    futures_account = "F0"
    login_id = "A1"
    events = Fills

    class order:
        @staticmethod
        def SendFutureOrderCLR(_login, _async, p):
            orders_sent.append(p.nQty)
            seq = f"{len(orders_sent):013d}"
            for at, q in plan["rows"]:
                deliveries.append((clk.t + at, seq, {"qty": float(q), "price": 100.0, "symbol": "TM2610", "fill_id": f"{seq}-{at}", "market": "TF"}))
            if plan.get("raise_after") is not None:
                pump["raise_at"] = clk.t + plan["raise_after"]
            return seq, 0


oc.pythoncom = Pump
oc.sk = types.SimpleNamespace(FUTUREORDER=type("O", (), {}))
oc._get_session = lambda env: Sess
oc._request_snapshot_refresh = lambda: None


def run(lots, rows, raise_after=None, timeout=15):
    deliveries.clear(); Fills.fills.clear(); clk.t = 0.0; pump["raise_at"] = None
    plan.update(rows=rows, raise_after=raise_after)
    r = oc.place_futures_market_order({}, "TM0000", "buy", lots, intent="entry", confirm_timeout=timeout)
    return r, clk.t


check(oc.LATE_REPORT_S >= 30, f"the production late window covers the 15–30 s measured on 8/17 (LATE_REPORT_S={oc.LATE_REPORT_S})")
r, el = run(8, [(0.5, 8)])
check(r["status"] == "filled" and r["fill_qty"] == 8 and el < 3, f"report in 0.5 s (8/14): filled 8, no extra wait ({el:.1f} s)")
r, el = run(8, [(20, 8)])
check(r["status"] == "filled" and r["fill_qty"] == 8 and r["symbol"] == "TM2610",
      f"report at 20 s (8/17): filled 8 — not 'sent' with 0 ({r['status']}, {r['fill_qty']}, {el:.1f} s)")
r, el = run(8, [(1, 5), (6, 3)])
check(r["status"] == "filled" and r["fill_qty"] == 8, f"rows 5 at 1 s and 3 at 6 s (past the 1 s grace): counted 8, not 5 ({r['fill_qty']})")
r, el = run(8, [(60, 8)])
check(r["status"] == "sent" and r["fill_qty"] == 0 and 44 <= el <= 47,
      f"no report within confirm_timeout + LATE_REPORT_S: 'sent' after ~45 s, never longer ({r['status']}, {el:.1f} s)")
r, el = run(8, [(1, 5), (30, 3)], raise_after=10)
check(r["fill_qty"] == 5 and "OSError" in r.get("error", ""),
      f"COM failure while waiting for the rest: the 5 confirmed come back with error, nothing raised ({r})")
audit = open("state/audit.jsonl").read() if os.path.exists("state/audit.jsonl") else ""
check('"late": true' in audit, "a late fill is audited as order_filled (late)")

# reconciler: still unconfirmed / short → recorded in order_errors (the platform turns it into a P1 order_error)
from manager import reconciler  # noqa: E402
import lib.portfolio as portfolio  # noqa: E402
rec = []
portfolio._record_order_error = lambda sym, venue, err, extra=None: rec.append((sym, venue, str(err)))
reconciler._capital_mark_order_sent = lambda: None
place = oc.place_futures_market_order
os.makedirs("manager", exist_ok=True)
for res, want in (({"status": "sent", "fill_qty": 0.0, "seq_no": "0000000000009", "symbol": "TM0000"}, "沒有成交回報"),
                  ({"status": "filled", "fill_qty": 5.0, "seq_no": "1", "symbol": "TM2610"}, "5/8"),
                  ({"status": "filled", "fill_qty": 8.0, "seq_no": "1", "symbol": "TM2610"}, None)):
    rec.clear()
    oc.place_futures_market_order = lambda env, sym, action, lots, intent, _r=res: _r
    try:
        leg = reconciler._capital_place_order("TMF", 8, {"type": "futures_contracts"})
    finally:
        oc.place_futures_market_order = place
    if want is None:
        check(not rec and leg["executed_qty"] == 8.0, "fully filled: nothing recorded")
    else:
        check(len(rec) == 1 and rec[0][:2] == ("TMF", "capital") and want in rec[0][2] and "請到群益" in rec[0][2] and "實際部位" in rec[0][2],
              f"{res['status']} {res['fill_qty']:g}/8 → one order_errors row telling the user to check 群益 ({rec})")

print("all checks passed" if not fails else f"FAILED: {fails}")
sys.exit(1 if fails else 0)
