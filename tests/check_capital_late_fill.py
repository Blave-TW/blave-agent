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

# entries go only in the TAIFEX regular session (lib/tw_clock); this test's clock is the
# wall clock, so it pins the session open
import lib.tw_clock  # noqa: E402
lib.tw_clock.in_session = lambda ts: True

oc.capital_vault.LAST_ORDER_PATH = os.path.abspath("state/capital_last_order_at")  # not the repo's

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
new_close = []


class Sess:
    futures_account = "F0"
    login_id = "A1"
    events = Fills

    class order:
        @staticmethod
        def SendFutureOrderCLR(_login, _async, p):
            orders_sent.append(p.nQty)
            new_close.append(p.sNewClose)
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
portfolio._record_order_error = lambda sym, venue, err, extra=None, repeat=False: rec.append((sym, venue, str(err), extra))
# place_futures_market_order is replaced below, so no Read-Your-Writes mark is written here; the
# mark belongs to the order lib (lib.capital_vault.mark_order_sent), not the reconciler
check(not hasattr(reconciler, "_capital_mark_order_sent") and callable(oc.capital_vault.mark_order_sent),
      "the send mark lives in lib.capital_vault, the reconciler has no copy to stub")
place = oc.place_futures_market_order
os.makedirs("manager", exist_ok=True)
for res, want in (({"status": "sent", "fill_qty": 0.0, "seq_no": "0000000000009", "symbol": "TM0000"}, "還沒回報成交"),
                  ({"status": "filled", "fill_qty": 5.0, "seq_no": "1", "symbol": "TM2610"}, "5／8"),
                  ({"status": "filled", "fill_qty": 8.0, "seq_no": "1", "symbol": "TM2610"}, None)):
    rec.clear()
    # each case on its own: a short send parks and holds the next entry (_capital_claim_pending)
    reconciler._capital_sent_at.clear()
    if os.path.exists(reconciler.CAPITAL_PENDING_PATH):
        os.remove(reconciler.CAPITAL_PENDING_PATH)
    oc.place_futures_market_order = lambda env, sym, action, lots, intent, _r=res: _r
    try:
        leg = reconciler._capital_place_order("TMF", 8, {"type": "futures_contracts"})
    finally:
        oc.place_futures_market_order = place
    if want is None:
        check(not rec and leg["executed_qty"] == 8.0, "fully filled: nothing recorded")
    else:
        check(len(rec) == 1 and rec[0][:2] == ("TMF", "capital") and want in rec[0][2] and "不用自己補單" in rec[0][2]
              and rec[0][3] == {"kind": "order_unconfirmed"} and "下單失敗" not in rec[0][2],
              f"{res['status']} {res['fill_qty']:g}/8 → one order_unconfirmed row (titled 結果不明, not 下單失敗): what Blave does, no hand re-entry ({rec})")

# the park file unreadable when the send comes back short: nothing will claim it, so the row must
# not promise "booked by itself, no hand re-entry" (v045 final2 P3-a)
rec.clear()
reconciler._capital_sent_at.clear()
os.makedirs("state", exist_ok=True)
open(reconciler.CAPITAL_PENDING_PATH, "w").write("{not json")
oc.place_futures_market_order = lambda env, sym, action, lots, intent: {"status": "sent", "fill_qty": 0.0, "seq_no": "0000000000010", "symbol": "TM0000"}
try:
    reconciler._capital_place_order("TMF", -2, {"type": "futures_contracts"}, reduce_only=True)
finally:
    oc.place_futures_market_order = place
    os.remove(reconciler.CAPITAL_PENDING_PATH)
sent_rows = [r for r in rec if "0000000000010" in r[2]]
check(len(sent_rows) == 1 and "不用自己補單" not in sent_rows[0][2] and "核對這筆" in sent_rows[0][2] and "平倉照常" in sent_rows[0][2],
      f"park file unreadable: the row tells the user to check this order, never 'no hand re-entry' ({rec})")

# a halted row and a fill that leaves nothing unfilled beside it: the row keeps its lots and baseline
# (as 統一's), else it is rebased to 0 lots and the unexplained lots vanish from the audit trail
import json as _json  # noqa: E402
halted = {"TMF": {"root": "TMF", "lots": 1.0, "legs": [{"at": 1.0, "lots": 1.0, "status": "sent", "seq_no": "S9"}],
                  "reads": [1, 2, 3], "months_expected": {"TM2611": 0.0}, "halted": True}}
_json.dump(halted, open(reconciler.CAPITAL_PENDING_PATH, "w"))
r_park = reconciler._capital_park("TMF", {"status": "filled", "fill_qty": 1.0, "symbol": "TM2611", "seq_no": "S10"}, -1, {"TM2611": 3.0})
after = _json.load(open(reconciler.CAPITAL_PENDING_PATH))
os.remove(reconciler.CAPITAL_PENDING_PATH)
check(r_park is True and after == halted, f"a full fill beside a halted 群益 row leaves the row as it was ({after})")

# D3 (Wei 11-05): a reduce goes as sNewClose=1 (平倉, the broker refuses an over-close) only with
# CLOSE_CODE_ON; off (until the live TMF run) everything stays 2 (自動), entries always
def send_code(intent):
    deliveries.clear(); Fills.fills.clear(); clk.t = 0.0; plan.update(rows=[(0.5, 1)], raise_after=None)
    oc.place_futures_market_order({}, "TM0000", "sell", 1, intent=intent, confirm_timeout=15)
    return new_close[-1]


check(oc.CLOSE_CODE_ON is False and send_code("reduce") == 2 and send_code("entry") == 2,
      "close code off by default: entries and closes go as 2 (自動), the live-tested setting")
oc.CLOSE_CODE_ON = True
check(send_code("reduce") == 1 and send_code("entry") == 2, "close code on: a reduce goes as 1 (平倉), an entry as 2")
check('"new_close": 1' in open("state/audit.jsonl").read(), "the audit row says which code went out")
oc.CLOSE_CODE_ON = False

print("all checks passed" if not fails else f"FAILED: {fails}")
sys.exit(1 if fails else 0)
