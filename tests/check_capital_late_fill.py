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


# flatten's close (audit 11-06 P2-1): more lots reported than sent never reaches the book — a
# 1-lot close booked as 2 leaves a reverse lot in the book the account never held
def close(lots, rows):
    deliveries.clear(); Fills.fills.clear(); clk.t = 0.0; pump["raise_at"] = None
    plan.update(rows=rows, raise_after=None)
    return oc.close_position_partial({}, "TM2610", "long", lots)


c = close(1, [(0.5, 2)])
check(c["status"] == "sent" and c["executed_qty"] == 0 and not c["avg_price"],
      f"flatten close of 1, 2 reported filled: returned sent / 0, flatten's unconfirmed-close path ({c})")
check('"source": "close_position_partial"' in open("state/audit.jsonl").read(), "the refused overfill close is audited")
c = close(2, [(0.5, 2)])
check(c["status"] == "filled" and c["executed_qty"] == 2, f"flatten close of 2, 2 filled: booked as filled ({c})")
c = close(2, [(0.5, 1)])
check(c["executed_qty"] == 1, f"flatten close of 2, 1 filled: the partial passes through as 1 ({c})")

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
        parked_row = reconciler._pending_sent(reconciler.CAPITAL_PENDING_PATH)["TMF"]
        check(len(rec) == 1 and rec[0][:2] == ("TMF", "capital") and want in rec[0][2] and "不用自己補單" in rec[0][2]
              and rec[0][3] == {"kind": "order_unconfirmed", "park_id": reconciler._park_id("capital:TMF", parked_row)}
              and "下單失敗" not in rec[0][2],
              f"{res['status']} {res['fill_qty']:g}/8 → one order_unconfirmed row (titled 結果不明, not 下單失敗) carrying the park id: what Blave does, no hand re-entry ({rec})")

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
check(r_park == reconciler._park_id("capital:TMF", halted["TMF"]) and after == halted, f"a full fill beside a halted 群益 row leaves the row as it was ({after})")

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

# ── every way a 群益 park is settled releases its order_unconfirmed row (audit 11-06 §2.2) ──
# The row carries the park id (above); without the release the page paints 結果不明 for good.
import time as _time  # noqa: E402
from lib import guard  # noqa: E402

real = {n: getattr(reconciler, n) for n in ("_capital_nets", "_book_late_fill_or_halt", "_row_booked")}
real_booked_ids = portfolio._booked_park_ids
NOW = _time.time() + 10 * reconciler.QUEUED_HOLD_S   # every leg below is past its hold


def park_row(root, contract, lots=1.0, halted=False, at=1.0):
    r = {"root": root, "lots": lots, "legs": [{"at": at, "lots": lots, "status": "filled", "seq_no": f"S{at:g}"}],
         "reads": [], "months_expected": {contract: 0.0}}
    if halted:
        r["halted"] = True
    return r


def seed(rows):
    _json.dump(rows, open(reconciler.CAPITAL_PENDING_PATH, "w"))
    errs = [{"kind": "order_unconfirmed", "park_id": reconciler._park_id(f"capital:{k}", v), "symbol": k,
             "exchange": "capital", "error": "x", "ts": "t"} for k, v in rows.items()]
    _json.dump(errs, open("manager/order_errors.json", "w"))


def released():
    return {e["park_id"]: (e.get("released"), e.get("filled")) for e in _json.load(open("manager/order_errors.json"))}


def claim(rows, nets, booked_ids=(), book=True):
    seed(rows)
    reconciler._capital_nets = lambda root=None: dict(nets)
    portfolio._booked_park_ids = lambda field="unconfirmed_park_id": set(booked_ids)
    reconciler._book_late_fill_or_halt = lambda *a, **k: book
    reconciler._capital_claim_pending(NOW)
    return released(), reconciler._pending_sent(reconciler.CAPITAL_PENDING_PATH)


guard.clear_halt("test")
row = park_row("TMF", "TM2611")
pid = reconciler._park_id("capital:TMF", row)
rel, left = claim({"TMF": row}, {"TM2611": 0.0}, booked_ids={pid})
check(rel[pid] == (True, True) and "TMF" not in left, f"late_fill_already_booked → row released, filled ({rel})")
rel, left = claim({"TMF": row}, {"TM2611": 1.0})
check(rel[pid] == (True, True) and "TMF" not in left, f"late_fill_adopted → row released, filled ({rel})")
rel, left = claim({"TMF": row}, {"TM2611": 1.0}, book=None)
check(rel[pid] == (True, True) and "TMF" not in left,
      f"late_fill_dropped_after_reset → row released, filled (the lots did fill; they are the user's) ({rel})")
rel, left = claim({"TMF": row}, {"TM2611": 0.0})
check(rel[pid] == (True, False) and "TMF" not in left, f"unfilled_order_cleared → row released, not filled ({rel})")
hrow = park_row("TMF", "TM2611", halted=True)
hpid = reconciler._park_id("capital:TMF", hrow)
rel, left = claim({"TMF": hrow}, {"TM2611": 2.0})
check(rel[hpid] == (True, False) and "TMF" not in left,
      f"parked_order_dropped (HALT cleared, still unexplained) → row released, not filled ({rel})")
# two roots in one round, the first adopted: the claim's book-id set must survive the booking
mrow = park_row("MXF", "MTX2611", at=2.0)
mpid = reconciler._park_id("capital:MXF", mrow)
try:
    rel, left = claim({"TMF": row, "MXF": mrow}, {"TM2611": 1.0, "MTX2611": 0.0}, booked_ids={mpid})
    ok = rel[pid] == (True, True) and rel[mpid] == (True, True) and not left
except TypeError as e:
    ok, rel = False, e
check(ok, f"two parked roots, the first adopted: the second still settles by its park id ({rel})")
# the park side: a new send finds the old row already booked and drops it
seed({"TMF": row})
reconciler._row_booked = lambda key, r: True
new_pid = reconciler._capital_park("TMF", {"status": "sent", "fill_qty": 0, "seq_no": "S77", "symbol": "TM0000"},
                                   1, {"TM2611": 1.0}, "entry")
rel = released()
check(rel[pid] == (True, True) and isinstance(new_pid, str) and new_pid != pid,
      f"_capital_park drops a row the book already holds → that row released, filled ({rel}, {new_pid})")
reconciler._row_booked = real["_row_booked"]

# ── overfill: more lots reported than sent is not booked; parked + HALT (audit 11-06 Q3-1) ──
os.remove(reconciler.CAPITAL_PENDING_PATH)
os.remove("manager/order_errors.json")
reconciler._capital_sent_at.clear()
rec.clear()
reconciler._capital_nets = lambda root=None: {"TM2611": 0.0}
oc.place_futures_market_order = lambda env, sym, action, lots, intent: {
    "status": "filled", "fill_qty": 2.0, "avg_fill_price": 23456.0, "seq_no": "0000000000077", "symbol": "TM2611"}
try:
    out = reconciler._capital_place_order("TMF", 1, {"type": "futures_contracts"})
finally:
    oc.place_futures_market_order = place
prow = reconciler._pending_sent(reconciler.CAPITAL_PENDING_PATH).get("TMF") or {}
reason = (guard.halt_info() or {}).get("reason", "")
check(out is False and guard.halted() and "比送出的 1 口多" in reason and not rec
      and prow.get("lots") == 1.0 and prow.get("halted") is True and prow.get("months_expected") == {"TM2611": 0.0}
      and prow["legs"][0].get("broker_ack") is True and "order_overfill_refused" in open("state/audit.jsonl").read(),
      f"2 lots reported for a 1-lot send: nothing booked, the send parked (halted, broker_ack), HALT with the reason, "
      f"no order_errors row beside it ({out}, {prow}, {reason!r}, {rec})")
# under that HALT an unexplained account does not re-trip HALT over the overfill reason
portfolio._booked_park_ids = lambda field="unconfirmed_park_id": set()
reconciler._capital_nets = lambda root=None: {"TM2611": 2.0}
for _ in range(reconciler.PENDING_SENT_MAX_READS + 1):
    reconciler._capital_claim_pending(NOW)
check("比送出的 1 口多" in (guard.halt_info() or {}).get("reason", "")
      and "TMF" in reconciler._pending_sent(reconciler.CAPITAL_PENDING_PATH),
      "while halted, reads that do not explain the overfilled send keep the row and the overfill HALT reason")
# the account shows exactly the sent lot: adopted (booked once, by the claim), even under HALT
booked_calls = []
reconciler._book_late_fill_or_halt = lambda *a, **k: booked_calls.append(a) or True
reconciler._capital_nets = lambda root=None: {"TM2611": 1.0}
reconciler._capital_claim_pending(NOW)
check(len(booked_calls) == 1 and booked_calls[0][3:5] == ("TM2611", 1.0)
      and "TMF" not in reconciler._pending_sent(reconciler.CAPITAL_PENDING_PATH),
      f"the account shows the one lot sent: the claim books 1, not the 2 reported ({booked_calls})")

# the api keeps 200 characters of a halt reason (api openclaw/agent_events halt.reason): the last
# step (Start trading / 啟動下單 — Wei: the button the sentence names) must survive, on the longest root, lot count and seq
reasons, real_trip, real_park, real_en = [], guard.trip_halt, reconciler._capital_park, reconciler._en
guard.trip_halt = lambda msg, src: reasons.append(msg)
reconciler._capital_park = lambda *a, **k: None
try:
    sym = max(reconciler._CAPITAL_FUTURES_SPEC, key=len)
    for en in (True, False):
        reconciler._en = lambda en=en: en
        reconciler._capital_overfill(sym, sym, {"fill_qty": 9999.0, "seq_no": "9" * 13}, 9998, 9998, None, "entry")
finally:
    guard.trip_halt, reconciler._capital_park, reconciler._en = real_trip, real_park, real_en
check(len(reasons) == 2 and all(len(r) <= 200 for r in reasons)
      and reasons[0].endswith("Start trading.") and reasons[1].endswith("「啟動下單」。"),
      f"overfill HALT reason ≤ 200 characters in both languages ({[len(r) for r in reasons]})")

# 統一's claim, same shadowing as 群益's (audit 11-06 P2-4): two contracts in one round, the
# first adopted — the book-id set must survive that booking for the second
real_pres = {n: getattr(reconciler, n) for n in ("_president_nets",)}
pres = {"TMFJ6": {"root": "TMF", "lots": 1.0, "net_expected": 0.0, "legs": [{"at": 1.0}]},
        "MXFJ6": {"root": "MXF", "lots": 1.0, "net_expected": 0.0, "legs": [{"at": 2.0}]}}
_json.dump(pres, open(reconciler.PENDING_SENT_PATH, "w"))
reconciler._president_nets = lambda: {"TMFJ6": 1.0, "MXFJ6": 0.0}
portfolio._booked_park_ids = lambda field="late_fill_park_id": {reconciler._park_id("MXFJ6", pres["MXFJ6"])}
reconciler._book_late_fill_or_halt = lambda *a, **k: True
try:
    reconciler._president_claim_pending(NOW)
    left, err = reconciler._pending_sent(), None
except TypeError as e:
    left, err = None, e
for n, f in real_pres.items():
    setattr(reconciler, n, f)
check(err is None and left == {},
      f"統一: two parked contracts, the first adopted: the second still settles by its park id ({err or left})")

guard.clear_halt("test")
for n, f in real.items():
    setattr(reconciler, n, f)
portfolio._booked_park_ids = real_booked_ids

print("all checks passed" if not fails else f"FAILED: {fails}")
sys.exit(1 if fails else 0)
