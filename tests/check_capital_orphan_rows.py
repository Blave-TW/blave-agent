"""Minimal check: 群益 order_unconfirmed rows written before they carried a park id are released
once no park is left on their root (win-test-6 11-06: two such rows painted 結果不明 for days after
the claim had settled both sends). Unparked sends and rows of a root still parked stay.

Run: cd blave-agent && python3 tests/check_capital_orphan_rows.py
"""
import json
import os
import sys
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
os.chdir(tempfile.mkdtemp(prefix="capital-orphan-", dir=os.environ.get("SCRATCHPAD") or None))
os.makedirs("state", exist_ok=True)
os.makedirs("manager", exist_ok=True)

from manager import reconciler  # noqa: E402

fails = 0


def check(cond, msg):
    global fails
    print(("  PASS  " if cond else "  FAIL  ") + msg)
    fails += (not cond)


def row(sym, seq, ts, **extra):
    return {"kind": "order_unconfirmed", "ts": ts, "symbol": sym, "exchange": "capital",
            "error": f"群益收了 {sym} 1 口（序號 {seq}），還沒回報成交。{sym} 新倉先停，平倉照常。", **extra}


def run(pending, errs):
    json.dump(pending, open(reconciler.CAPITAL_PENDING_PATH, "w"))
    json.dump(errs, open("manager/order_errors.json", "w"))
    reconciler._capital_nets = lambda root=None: {}
    reconciler._capital_claim_pending(0.0)
    return {(e["symbol"], e.get("park_id") or e["error"][:30]): (e.get("released"), e.get("filled"))
            for e in json.load(open("manager/order_errors.json"))}


# old rows on machines are matched by these words: changing them would release unparked sends
check(reconciler.CAPITAL_UNPARKED_WORDS == "Blave 記不進待確認紀錄", "the unparked words are the ones old rows carry")

# filled: a row naming its seq only by a 群益 late fill of that seq — not by a later TMF fill (the
# cleared send re-sent), not by a 統一 order number that happens to match; a row naming no seq (TXF)
# by a later fill on its symbol
with open("manager/orders.jsonl", "w") as f:
    f.write(json.dumps({"ts": "2026-11-06T14:00:00", "symbol": "TMF", "exchange": "capital", "late_fill": True,
                        "late_fill_ordernos": ["2315621839697"], "legs": [{"executed_qty": 1.0}]}) + "\n")
    f.write(json.dumps({"ts": "2026-11-06T14:01:00", "symbol": "TMF", "exchange": "president", "late_fill": True,
                        "late_fill_ordernos": ["2315621839314"], "legs": [{"executed_qty": 1.0}]}) + "\n")
    f.write(json.dumps({"ts": "2026-11-06T14:30:00", "symbol": "TMF", "exchange": "capital",
                        "legs": [{"executed_qty": 1.0}]}) + "\n")
    f.write(json.dumps({"ts": "2026-11-06T14:30:00", "symbol": "TXF", "exchange": "capital",
                        "legs": [{"executed_qty": 1.0}]}) + "\n")

old_open = row("TMF", "2315621839314", "2026-11-06T14:21:06")
old_close = row("TMF", "2315621839697", "2026-11-06T14:22:57")
old_unparked = row("TMF", "1", "2026-11-06T14:20:00")
old_unparked["error"] = "群益收了 TMF 1 口（序號 1），還沒回報成交，Blave 記不進待確認紀錄。TMF 新倉先停，平倉照常。"
new_unparked = row("TMF", "2", "2026-11-06T14:20:30", unparked=True)
other_venue = dict(row("TMF", "3", "2026-11-06T14:20:40"), exchange="president")

out = run({}, [old_unparked, new_unparked, other_venue, old_open, old_close])
vals = list(out.values())
check(vals[3] == (True, False) and vals[4] == (True, True),
      f"no park left on TMF: both old rows released; a seq is filled only by a 群益 late fill of it ({vals})")
check(vals[0] == (None, None) and vals[1] == (None, None) and vals[2] == (None, None),
      f"unparked sends (old by words, new by field) and another venue's row stay ({vals})")
out = run({}, [row("TXF", "?", "2026-11-06T14:21:30")])
check(list(out.values()) == [(True, True)], f"a row naming no seq: filled by a later fill on its symbol ({out})")
out = run({}, [row("TMF", "6", "2026-11-06T14:21:40", close_all=True), row("TMF", "7", "2026-11-06T14:21:50", inflight_id="x")])
check(list(out.values()) == [(None, None), (None, None)],
      f"全部平倉 rows (close_all, inflight_id) are released by their own path, not this one ({out})")

parked = {"TMF": {"root": "TMF", "lots": 1.0, "legs": [{"at": 1.0, "lots": 1.0, "seq_no": "9"}],
                  "reads": [], "months_expected": None}}
out = run(parked, [row("TMF", "2315621839314", "2026-11-06T14:21:06"), row("MXF", "5", "2026-11-06T14:21:10")])
vals = list(out.values())
check(vals[0] == (None, None) and vals[1] == (True, False),
      f"TMF still parked: its old row stays; MXF has no park: released ({vals})")

# malformed files never stop the claim round (it reads the 群益 account before any order goes)
mxf = {"MXF": dict(parked["TMF"], root="MXF")}
for desc, bad_line in (("a row whose ts is a list", None), ("an orders.jsonl line that is a list", '["late_fill_ordernos"]')):
    if bad_line:
        with open("manager/orders.jsonl", "a") as f:
            f.write(bad_line + "\n")
    try:
        out = run(mxf, [dict(row("TMF", "8", "x"), ts=["2026-11-06"])])
        ok = "MXF" in reconciler._pending_sent(reconciler.CAPITAL_PENDING_PATH)
        if not bad_line:  # the row itself is still released: its odd ts only goes into a str key
            ok = ok and list(out.values()) == [(True, False)]
    except Exception as e:
        ok, out = False, f"{type(e).__name__}: {e}"
    check(ok, f"{desc}: _capital_claim_pending finishes the round ({out})")

print("all checks passed" if not fails else f"FAILED: {fails}")
sys.exit(1 if fails else 0)
