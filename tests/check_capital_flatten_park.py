"""Minimal check: a 群益 close from 全部平倉 that did not report its whole fill is parked in the
reconciler's file (manager/flatten._capital_park_close → reconciler._capital_park), and the
reconciler settles it like its own sends (audit capital-fill-fix-r2 P2-1 / P3-3):
  - 'sent' / 0 (the overfill guard's answer, or no report) → a reduce leg with broker_ack;
  - the reconciler's next close and entry on that root wait; flatten's next press is held;
  - the account moved by the close → booked as a late fill; unchanged past the hold → cleared;
  - a short fill parks the rest; a full fill parks nothing (unless the root has a row);
  - the baseline is read once per root per run and moves with this run's fills;
  - any failure in the park never raises (the close is already out).
Run: cd blave-agent && .venv/bin/python tests/check_capital_flatten_park.py
"""
import json
import os
import sys
import tempfile
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_REPO_ENV = os.path.join(ROOT, ".env")


def _no_repo_env(event, args):
    if event == "open" and args and isinstance(args[0], (str, bytes)):
        if os.path.abspath(os.fsdecode(args[0])) == _REPO_ENV:
            raise RuntimeError("test tried to open the repo .env")


sys.addaudithook(_no_repo_env)
sys.path.insert(0, ROOT)
sys.path.insert(0, os.path.join(ROOT, "manager"))
import flatten  # noqa: E402  (chdir's to ROOT: moved off it right below, before anything writes)
os.chdir(tempfile.mkdtemp(prefix="capital-flat-park-", dir=os.environ.get("SCRATCHPAD") or None))
for d in ("state", "manager"):
    os.makedirs(d)
import lib.portfolio as portfolio  # noqa: E402
from lib import guard, tw_clock  # noqa: E402

tw_clock.queued_until = lambda now=None: None  # in session

fails = 0


def check(cond, msg):
    global fails
    print(("  PASS  " if cond else "  FAIL  ") + msg)
    fails += (not cond)


rec = flatten._reconciler()
check(rec.CAPITAL_PENDING_PATH == flatten.CAPITAL_PENDING_PATH and rec is flatten._reconciler(),
      "the reconciler is loaded once and parks into flatten's path")
nets_calls = []
NETS = {"TM2611": 1.0}
rec._capital_nets = lambda root=None: nets_calls.append(root) or {c: v for c, v in NETS.items()}
booked = []
rec._book_late_fill_or_halt = lambda *a, **k: booked.append(a) or True
portfolio._booked_park_ids = lambda field="unconfirmed_park_id": set()
sent = []
import lib.order_capital as oc  # noqa: E402
oc.place_futures_market_order = lambda *a, **k: sent.append(a) or {"status": "filled", "fill_qty": 1.0}


def pending():
    return rec._pending_sent(rec.CAPITAL_PENDING_PATH)


def reset():
    flatten._CAP_BASE.clear()
    nets_calls.clear(); booked.clear(); sent.clear()
    if os.path.exists(rec.CAPITAL_PENDING_PATH):
        os.remove(rec.CAPITAL_PENDING_PATH)


SENT0 = {"status": "sent", "executed_qty": 0.0, "avg_price": 0.0, "resolved_symbol": "TM0000", "seq_no": "0000000000042"}

# 1. 'sent' / 0 → parked as a reduce leg the broker took
reset()
base = flatten._capital_base("TMF")
pid = flatten._capital_park_close("TMF", "long", 1, SENT0, base)
row = pending().get("TMF") or {}
leg = (row.get("legs") or [{}])[0]
check(isinstance(pid, str) and row.get("lots") == -1.0 and row.get("months_expected") == {"TM2611": 1.0}
      and leg.get("intent") == "reduce" and leg.get("broker_ack") is True and leg.get("seq_no") == "0000000000042",
      f"flatten's sent/0 close of 1 long → parked: -1 lot, reduce, broker_ack, baseline the pre-send read ({row})")

# 2. while parked: flatten's next press is held, the reconciler's close and entry wait
held, until = flatten._capital_close_queued("TMF")
check(held and until and until > time.time(), "flatten's next press on TMF is held by the park row")
check(rec._capital_place_order("TMF", -1, {"type": "futures_contracts"}, reduce_only=True) is False
      and rec._capital_place_order("TMF", 1, {"type": "futures_contracts"}) is False and not sent,
      "the reconciler sends neither a close nor an entry on TMF while the row is there (P3-3)")

# 3. settled by the claim
NETS = {"TM2611": 0.0}
rec._capital_claim_pending(time.time())
check(len(booked) == 1 and booked[0][3:5] == ("TM2611", -1.0) and "TMF" not in pending(),
      f"the account shows the close (1 → 0): booked as a late -1 in TM2611, row gone ({booked})")
reset()
NETS = {"TM2611": 1.0}
flatten._capital_park_close("TMF", "long", 1, SENT0, flatten._capital_base("TMF"))
rec._capital_claim_pending(time.time())
check("TMF" in pending() and not booked, "account unchanged inside the hold: kept (may sit queued to the open)")
rec._capital_claim_pending(time.time() + rec.QUEUED_HOLD_S + 60)
check("TMF" not in pending() and not booked, "account unchanged past the hold: cleared, nothing booked (the book keeps its lot)")

# 4. short and full fills
reset()
NETS = {"TM2611": 2.0}
flatten._capital_park_close("TMF", "long", 2, {"status": "filled", "executed_qty": 1.0, "resolved_symbol": "TM2611",
                                               "seq_no": "S2"}, flatten._capital_base("TMF"))
row = pending().get("TMF") or {}
check(row.get("lots") == -1.0 and row.get("months_expected") == {"TM2611": 1.0},
      f"close 2, 1 filled: the other lot parked against 2 - 1 ({row})")
reset()
r = flatten._capital_park_close("TMF", "short", 1, {"status": "filled", "executed_qty": 1.0, "resolved_symbol": "TM2611"},
                                flatten._capital_base("TMF"))
check(r is None and not os.path.exists(rec.CAPITAL_PENDING_PATH), "a full fill with no row parks nothing")

# 5. one baseline read per root per run, moved by this run's fills
reset()
NETS = {"TM2611": 1.0, "TM2612": 1.0}
b1 = flatten._capital_base("TMF")
flatten._capital_park_close("TMF", "long", 1, {"status": "filled", "executed_qty": 1.0, "resolved_symbol": "TM2611"}, b1)
b2 = flatten._capital_base("TMF")
check(nets_calls == ["TMF"] and b1 == {"TM2611": 1.0, "TM2612": 1.0} and b2 == {"TM2611": 0.0, "TM2612": 1.0},
      f"second close on TMF: baseline from the same read, moved by the first close's fill ({b1} → {b2})")

# 6. a failing park never raises
reset()
real = rec._capital_park
rec._capital_park = lambda *a, **k: (_ for _ in ()).throw(OSError("disk"))
try:
    r = flatten._capital_park_close("TMF", "long", 1, SENT0, None)
    ok = r is False
except Exception as e:
    ok = False
    r = e
rec._capital_park = real
check(ok, f"a park that raises returns False, the flatten goes on ({r})")
rec._capital_nets = lambda root=None: (_ for _ in ()).throw(RuntimeError("worker down"))
check(flatten._capital_base("TMF") is None, "a failed baseline read → None (the reconciler parks without one too)")

guard.clear_halt("test")
print("all checks passed" if not fails else f"FAILED: {fails}")
sys.exit(1 if fails else 0)
