"""HALT is a full freeze (Wei 2026-10-17, 0.1.27): while state/HALT exists no
order of any kind leaves the machine — entries, reduces, closes, a flip's close
leg, SL/TP — whoever tripped it (the user's 暫停, or a safety trip). The one way
to close while paused is the user's explicit close: manager/flatten.py and
manager/close_symbol.py take the process-wide close pass, and the close-all leg
the reconciler finishes for flatten (paper TW stocks after hours) runs inside
the thread-local one.

  G  transport (lib/guard.check_restart_stop, which every order lib's gate calls)
  R  lib.portfolio.reconcile: reduce / close / flip / safety HALT / deferred close-all
  E  lib.execute: a reduce TWAP stops at its next slice too
  P  the close pass is held by exactly flatten.py and close_symbol.py

No network, no exchange, no process but this one's own child. Run:
    .venv/bin/python tests/check_halt_freeze.py
"""
import json
import os
import re
import subprocess
import sys
import tempfile
import threading

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
os.chdir(tempfile.mkdtemp(prefix="halt-freeze-"))
os.makedirs("manager", exist_ok=True)
open("manager/portfolio_config.json", "w").write('{"self_ledger": false}')

from lib import execute, guard, order_paper, portfolio  # noqa: E402

red = 0


def check(ok, name):
    global red
    print(("ok   " if ok else "FAIL ") + name)
    if not ok:
        red += 1


def refused(intent):
    try:
        guard.check_restart_stop(intent, {"symbol": "BTCUSDT"})
        return False
    except guard.Halted:
        return True


def audits(event):
    try:
        rows = [json.loads(line) for line in open(guard.AUDIT_PATH)]
    except OSError:
        return []
    return [r for r in rows if r.get("event") == event]


def reset_halt():
    if guard.halted():
        guard.clear_halt("test")


# ── G: transport ─────────────────────────────────────────────────────────────
print("== G transport")
check(not any(refused(i) for i in ("entry", "reduce", "protective", "cancel")),
      "G0 not halted: every intent passes")
guard.trip_halt("user request", "web")
check(all(refused(i) for i in ("entry", "reduce", "protective")),
      "G1 HALT: entry, reduce and protective are all refused")
check(not refused("cancel") and not refused("cancel_all") and not refused("leverage"),
      "G2 …cancels and leverage still pass (they open and close nothing)")
check(len(audits("order_denied_halt")) >= 3, "G3 every refusal is audited as order_denied_halt")
try:
    order_paper._gate("reduce", symbol="BTCUSDT", side="sell", qty=0.01)
    lib_refused = False
except guard.Halted:
    lib_refused = True
check(lib_refused, "G4 a real order lib's gate (paper) refuses the reduce too")
with guard.halt_close_pass("BTCUSDT", "test"):
    in_pass = {i: refused(i) for i in ("reduce", "protective")}
    try:
        order_paper._gate("entry", symbol="BTCUSDT", side="buy", qty=0.01)
        entry_out = True
    except guard.Halted:
        entry_out = False
    seen = []
    t = threading.Thread(target=lambda: seen.append(refused("reduce")))
    t.start()
    t.join()
check(not in_pass["reduce"] and in_pass["protective"] and not entry_out,
      f"G5 inside a close pass: the reduce passes; SL/TP and an entry stay refused ({in_pass}, {entry_out})")
check(seen == [True], "G6 the thread-local pass is this thread's only")
check(refused("reduce"), "G7 …and ends with the block")
check(len(audits("order_allowed_halt_close")) == 1, "G8 the passed reduce is audited")
reset_halt()

child = subprocess.run([sys.executable, "-c", f"""
import os, sys
sys.path.insert(0, {ROOT!r})
from lib import guard
guard.trip_halt("close all positions", "flatten")
def refused(intent):
    try:
        guard.check_restart_stop(intent, {{"symbol": "BTCUSDT"}})
        return False
    except guard.Halted:
        return True
before = refused("reduce")
guard.grant_halt_closes("flatten")
print(before, refused("reduce"), refused("protective"))
"""], capture_output=True, text=True, cwd=tempfile.mkdtemp(prefix="halt-freeze-child-"))
check(child.stdout.split() == ["True", "False", "True"],
      f"G9 the process-wide pass (flatten / close_symbol): reduces go, SL/TP never "
      f"({child.stdout.strip()} {child.stderr.strip()[-200:]})")

# ── R: reconcile ─────────────────────────────────────────────────────────────
print("== R reconcile")
SHARES = {"type": "shares"}
TARGET = {
    "BTCUSDT": {"side": "long", "size": 100.0, "exchange": "okx", "asset_spec": None,
                "market": "swap", "contributors": [], "gated": False},
    "SOLUSDT": {"side": "short", "size": 50.0, "exchange": "okx", "asset_spec": None,
                "market": "swap", "contributors": [], "gated": False},
}
ACTUAL = {
    "BTCUSDT": {"side": "long", "size": 300.0, "exchange": "okx"},   # reduce 300 → 100
    "ETHUSDT": {"side": "long", "size": 50.0, "exchange": "okx"},    # no target: close
    "SOLUSDT": {"side": "long", "size": 50.0, "exchange": "okx"},    # flip long → short
    "2330": {"side": "long", "size": 1000.0, "exchange": "paper", "asset_spec": SHARES},
}
portfolio.aggregate_portfolio = lambda: {k: dict(v) for k, v in TARGET.items()}
portfolio._paper_tw_closed_keys = lambda target, actual: set()  # the TW session is open
placed = []


def spy(symbol, signed_diff, asset_spec=None, reduce_only=False, exchange=None, contributors=None):
    # last field: sent inside a close pass — and the real gate then lets a reduce through
    placed.append((symbol, round(signed_diff, 2), reduce_only,
                   guard.halt_closes_allowed() and not refused("reduce")))
    return False


def recon():
    del placed[:]
    portfolio.reconcile(get_positions_fn=lambda: {k: dict(v) for k, v in ACTUAL.items()},
                        place_order_fn=spy, threshold=10)
    return sorted(placed)


def keep_2330():
    # the close-all flatten deferred: "2330" held after the TW close
    portfolio.defer_paper_tw_close(["2330"])


TARGET["2330"] = {"side": "long", "size": 1000.0, "exchange": "paper", "asset_spec": SHARES,
                  "market": "spot", "contributors": [], "gated": False}
r = recon()
check({("BTCUSDT", -200.0, True, False), ("ETHUSDT", -50.0, True, False),
       ("SOLUSDT", -50.0, True, False)} <= set(r), f"R0 control, not halted: the legs go ({r})")
guard.trip_halt("user request", "web")
n_denied = len(audits("order_denied_halt"))
check(recon() == [], f"R1 user 暫停: the reduce, the close and the flip's close leg are all held ({placed})")
denied = audits("order_denied_halt")[n_denied:]
check({d.get("symbol") for d in denied} >= {"BTCUSDT", "ETHUSDT", "SOLUSDT"}
      and any(d.get("intent") == "reduce" for d in denied),
      f"R2 …each one audited order_denied_halt with its intent ({[(d.get('symbol'), d.get('intent')) for d in denied]})")
snap = json.load(open("manager/last_reconcile.json"))
check("halt_freeze" in (snap.get("caps") or []), "R3 the snapshot's caps say this lib freezes (the pages read it)")
reset_halt()

del TARGET["2330"]
guard.trip_halt("close all positions", "web")
keep_2330()
r = recon()
check(r == [("2330", -1000.0, True, True)],
      f"R4 the close-all leg flatten deferred goes, inside the close pass; nothing else does ({r})")
check(not guard.halt_closes_allowed(), "R5 …the pass is gone after the leg")
reset_halt()
os.remove(portfolio._PAPER_TW_CLOSE_PATH)  # the spy fills nothing; the real close empties the row

for source in ("reconciler", "execute", "portfolio", "settings"):
    guard.trip_halt(f"safety trip ({source})", source)
    r = recon()
    check(r == [], f"R6 a safety HALT ({source}) freezes the same way ({r})")
    reset_halt()
r = recon()
check(("BTCUSDT", -200.0, True, False) in r and ("ETHUSDT", -50.0, True, False) in r
      and ("SOLUSDT", -50.0, True, False) in r,
      f"R7 啟動下單 (HALT lifted): the held exits go ({r})")

# ── E: executions ────────────────────────────────────────────────────────────
print("== E executions")
guard.trip_halt("user request", "web")
why, stop = {}, threading.Event()
fn = execute._make_slice_fn("BTCUSDT", None, True, "okx", "sell", stop, {"id": "okx"}, why)
try:
    fn("BTCUSDT", "sell", 50.0)
    raised = False
except RuntimeError:
    raised = True
check(raised and stop.is_set() and why.get("stop") == "halt",
      f"E1 a reduce TWAP's next slice is not sent under HALT; the execution stops ({why})")
sent = []
import lib.venue_wiring as _vw  # noqa: E402
_real_auto = _vw.auto_place_order
_vw.auto_place_order = lambda *a, **k: sent.append(a) or {"avg_price": 1.0, "executed_qty": 1.0}
execute.resolve_execution = lambda contributors, config=None: {"type": "twap", "duration_min": 30}
with guard.halt_close_pass("2454@spot", "test"):
    out = execute.dispatch_order("2454@spot", -500.0, None, True, "paper")
check(isinstance(out, dict) and len(sent) == 1 and not execute.list_inflight(),
      f"E2 a deferred close-all leg under a TWAP style goes as one market order on this thread ({out})")
_vw.auto_place_order = _real_auto
reset_halt()

# ── P: who holds the close pass ──────────────────────────────────────────────
print("== P close-pass holders")
holders, scoped = set(), set()
for base in ("lib", "manager", "runtime", "strategies", "allocators"):
    for dirpath, _, files in os.walk(os.path.join(ROOT, base)):
        for f in files:
            if not f.endswith(".py"):
                continue
            path = os.path.join(dirpath, f)
            src = open(path, encoding="utf-8").read()
            rel = os.path.relpath(path, ROOT)
            if re.search(r"\bgrant_halt_closes\(", src) and rel != "lib/guard.py":
                holders.add(rel)
            if re.search(r"\bhalt_close_pass\(", src) and rel != "lib/guard.py":
                scoped.add(rel)
check(holders == {"manager/flatten.py", "manager/close_symbol.py"},
      f"P1 the process-wide pass: flatten.py and close_symbol.py only ({sorted(holders)})")
check(scoped == {"lib/portfolio.py"}, f"P2 the thread-local pass: lib/portfolio.py only ({sorted(scoped)})")
flat = open(os.path.join(ROOT, "manager", "flatten.py"), encoding="utf-8").read()
check(flat.index("grant_halt_closes(") > flat.index("claim_close_all_pass()"),
      "P3 flatten takes the pass only past the restart-stop branch (no pass → nothing closes there)")

print(f"\ncheck_halt_freeze: {red} FAILED" if red else "\ncheck_halt_freeze: all ok")
sys.exit(1 if red else 0)
