"""群益 login stopped (300/307): only 群益 stops, the user is told once, the machine never HALTs.

Before: a worker stopped on 300/307 wrote ok=false snapshots; account_capital has no classify, so
each round counted an UNKNOWN read failure and the third HALTed the whole machine — every venue,
under a reason that never said "群益 login". Through the real reconcile round and the real login
block (only the broker session is faked; World: check_capital_ledger_paths):

  O  blocked: a flipped signal sends nothing, closes included, never a HALT however many rounds;
     place_order(exchange='capital') skips. Block gone with the snapshot still ok=false: the
     third round HALTs (the old path, still there for a real outage).
  N  venue_login_blocked: one event per automatic block (worker loop, order lib), class only
     (300 PASSWORD, 307 LOCKED) plus the held rows; never for a probe's (explicit) block or a
     runtime-rewritten one; a block whose own notice failed is sent from the reconciler's round
     once, past the writer's minute.

Run: cd blave-agent && .venv/bin/python tests/check_capital_login_stop.py
"""
import importlib.util
import json
import os
import sys
import tempfile
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
TMP = tempfile.mkdtemp(prefix="capital-stop-", dir=os.environ.get("SCRATCHPAD") or None)
os.chdir(TMP)
os.environ["BLAVE_AGENT_HOME"] = os.environ["BLAVECLAW_HOME"] = TMP

fails = 0


def check(cond, msg, detail=None):
    global fails
    print(("ok   " if cond else "FAIL ") + msg + ("" if cond or detail is None else f"  {detail}"))
    fails += 0 if cond else 1


spec = importlib.util.spec_from_file_location("ledger_paths", os.path.join(ROOT, "tests", "check_capital_ledger_paths.py"))
harness = importlib.util.module_from_spec(spec)
spec.loader.exec_module(harness)
w = harness.capital_world(TMP)

from lib import capital_vault as cv, events, guard, portfolio  # noqa: E402

cv.BLOCK = os.path.join(TMP, "state", "capital_login_block.json")
EMITS, EMIT_OK = [], [True]


def fake_emit(ev_type, **payload):
    if not EMIT_OK[0]:
        return None
    EMITS.append((ev_type, {k: v for k, v in payload.items() if v is not None}))
    return len(EMITS)


events.emit = fake_emit
w.setup(2)
# the reconciler's dotenv_values() finds the workspace .env from its own file's folder; here it
# lives in the repo, so the call is pointed at this workspace's credentials
import dotenv  # noqa: E402
dotenv.dotenv_values = lambda *a, **k: {"capital_api_key": "A1", "capital_password": "trade-pw"}
from manager import reconciler as rec  # noqa: E402
rec.send_telegram = lambda *_: None
rec._read_env = lambda: {}
skew = [0.0]
_t = time.time
time.time = lambda: _t() + skew[0]


def snapshot(ok=True):
    if ok:
        w.write_snapshot()
    else:
        json.dump({"ok": False, "error": "login failed code=307", "read_at": time.time()},
                  open(os.path.join(TMP, "state", "capital_account.json"), "w"))


def round_():
    sent = len(w.sent)
    try:
        portfolio.reconcile(get_positions_fn=rec._get_positions_guarded, place_order_fn=rec.place_order,
                            threshold=rec._symbol_threshold, send_telegram_fn=lambda *_: None)
        out = "ok"
    except rec.ReadSkipped:
        out = "skipped"
    except Exception as e:
        out = f"{type(e).__name__}: {e}"
    rec._next_round()
    return out, w.sent[sent:]


# ── O ────────────────────────────────────────────────────────────────────────
w.signal(1)
snapshot()
out, sent = round_()
check(out == "ok" and w.rows == {"TX2610": 2}, "healthy: the book is built, 2 long", (out, sent, w.rows))
skew[0] += 60
snapshot()   # the worker's next read shows the fill

cv.record_login("A1", "trade-pw", 307, auto=True)   # the worker's loop login answered 307
check(EMITS == [("venue_login_blocked", {"venue": "capital", "reason": "LOCKED", "positions": ["TX2610 +2"]})],
      "N: the automatic 307 block sends one venue_login_blocked, class LOCKED and the held rows", EMITS)
w.signal(-1)
snapshot(ok=False)
results = [round_() for _ in range(6)]
check(all(r == ("skipped", []) for r in results) and not guard.halted(),
      "O: blocked, ok=false snapshot, the signal flips: 6 rounds skipped, nothing sent, never a HALT", results)
check(rec._consecutive_failures == 0, "O: the stop is not counted as a failed read", rec._consecutive_failures)
check(rec.place_order("TXF", -2, exchange="capital", reduce_only=True) is False, "O: a close leg is skipped too")
skew[0] += 120
round_()
check(len(EMITS) == 1, "N: no second notice for the same block from the reconciler's retry", EMITS)

# the user re-entered the password (runtime clears the block): the old path is back, and a real
# outage still HALTs on the third round
cv.clear_block("A1", "trade-pw")
results = [round_() for _ in range(3)]
check(guard.halted(), "O: no block, ok=false three rounds: HALT as before (a real outage still speaks)", results)
guard.clear_halt("test")
rec._consecutive_failures = 0

# ── N: explicit and rewritten blocks are not sent; a failed append is retried once ──────────────
EMITS.clear()
cv.record_login("A1", "trade-pw", 300)   # the probe (--once): the user is looking at the answer
skew[0] += 120
round_()
check(EMITS == [], "N: a probe's 300 block sends nothing, now or from the reconciler's retry", EMITS)
cv.clear_block("A1", "trade-pw")
EMIT_OK[0] = False
cv.record_login("A1", "trade-pw", 300, auto=True)
EMIT_OK[0] = True
check(EMITS == [] and not json.load(open(cv.BLOCK)).get("notified"), "N: a failed append leaves the block unnotified")
round_()
check(EMITS == [], "N: the reconciler leaves the writer its minute", EMITS)
skew[0] += rec.STOP_NOTICE_RETRY_AFTER_S + 1
round_()
round_()
check(len(EMITS) == 1 and EMITS[0][1].get("reason") == "PASSWORD", "N: past the minute the round sends it, once", EMITS)
cv.clear_block("A1", "trade-pw")
open(cv.BLOCK, "w").write(json.dumps({"fp": cv.fingerprint("A1", "trade-pw"), "code": 307, "at": 1,
                                      "unlock_used": False}))   # what runtime/capital_connect.block_login writes
EMITS.clear()
round_()
check(EMITS == [] and rec._capital_login_stopped(), "N: a runtime-written block stops 群益 but is never sent", EMITS)
cv.clear_block("A1", "trade-pw")
check(not rec._capital_login_stopped(), "a block for these credentials gone: not stopped")
open(cv.BLOCK, "w").write(json.dumps({"fp": cv.fingerprint("A1", "old-pw"), "code": 300, "at": 1, "auto": True}))
check(not rec._capital_login_stopped(), "a block on other credentials (the user re-entered the password) does not stop")

print("\ncheck_capital_login_stop: " + ("all ok" if not fails else f"FAILED ({fails})"))
sys.exit(1 if fails else 0)
