"""The reconciler's own machine-restart gate (fail-closed, Wei 2026-09-22).

The runtime writes state/reconciler_stopped.json after a reboot and then tries to
kill the reconciler; this check is about the kill NOT landing. Runs the real
`__main__` loop of manager/reconciler.py (no network: the one order path,
lib.portfolio.reconcile, is a spy) in a temp workspace.

Asserts:
  1. with the record present a live reconciler reconciles nothing — no round at
     all, so no entry, no close, no stop — while its heartbeat stays fresh;
  2. the record is read every round: removing it (啟動下單) makes the very next
     round reconcile, in the same process — also when the daemon had already
     reconciled before the record appeared (force_next, not the 5-min heartbeat);
  3. the record landing mid-round: place_order sends none of the remaining legs;
  4. a TWAP already in flight stops at the next slice, both directions;
  5. the paths agree (runtime writer, reporter, lib/guard, reconciler).

Run: cd blave-agent && .venv/bin/python tests/check_reconciler_restart_gate.py
"""
import json
import os
import runpy
import shutil
import sys
import tempfile
import threading
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TMP = tempfile.mkdtemp(prefix="restart-gate-")
# notify config = none: lib.notify here and in every child falls back to a log line, never a real Telegram
os.environ["BLAVE_AGENT_HOME"] = os.environ["BLAVECLAW_HOME"] = TMP
os.makedirs(os.path.join(TMP, "state", "heartbeat"))
os.makedirs(os.path.join(TMP, "manager"))
json.dump({"amounts": {"btc_1h": 1000}, "exchanges": {"btc_1h": "binance"}},
          open(os.path.join(TMP, "manager", "portfolio_config.json"), "w"))
os.environ["BLAVE_AGENT_BASE"] = TMP
os.environ["BLAVE_AGENT_WORKSPACE"] = TMP
os.environ.pop("BLAVE_AGENT_LOCAL", None)
sys.path.insert(0, ROOT)
sys.path.insert(0, os.path.join(ROOT, "runtime"))
cwd = os.getcwd()
os.chdir(TMP)

fails = 0


def check(cond, msg):
    global fails
    print(("ok   " if cond else "FAIL ") + msg)
    fails += 0 if cond else 1


import lib.portfolio  # noqa: E402
import lib.venue_wiring  # noqa: E402
import lib.execute  # noqa: E402

RECONCILER = os.path.join(ROOT, "manager", "reconciler.py")
RECORD = os.path.join(TMP, "state", "reconciler_stopped.json")
HB = os.path.join(TMP, "state", "heartbeat", "reconciler")
real_sleep = time.sleep
lib.venue_wiring.sweep_orphan_orders = lambda: 0
lib.execute.reap_dead_inflight = lambda: None


class _Done(BaseException):
    pass


def run_loop(schedule, stop_at):
    """Run the real loop; schedule = {tick: "add" | "remove"} applied as each
    POLL_INTERVAL sleep ends. Returns (ticks at which reconcile ran, heartbeat
    fresh at each tick)."""
    rounds, hb_fresh, tick, main_ns = [], [], {"n": 0}, {}

    def _spy(**kw):
        rounds.append(tick["n"])
        return []

    def _sleep(_s):
        main_ns.update(sys._getframe(1).f_globals)
        tick["n"] += 1
        hb_fresh.append(os.path.exists(HB) and time.time() - os.path.getmtime(HB) < 5)
        act = schedule.get(tick["n"])
        if act == "add":
            json.dump({"reason": "machine_restart"}, open(RECORD, "w"))
        elif act == "remove":
            os.remove(RECORD)
        if tick["n"] >= stop_at:
            raise _Done

    lib.portfolio.reconcile = _spy
    time.sleep = _sleep
    try:
        runpy.run_path(RECONCILER, run_name="__main__")
    except _Done:
        pass
    finally:
        time.sleep = real_sleep
        # the singleton lock dies with the process in real life; this "process" runs again
        if isinstance(main_ns.get("_singleton_fd"), int):
            os.close(main_ns["_singleton_fd"])
    return rounds, hb_fresh


# 1–2: record from startup, removed at tick 4
json.dump({"reason": "machine_restart", "at": 1, "down_to": 2}, open(RECORD, "w"))
rounds, hb = run_loop({4: "remove"}, 7)
check(not [r for r in rounds if r < 4] and all(hb[:4]),
      "record present: 4 live rounds, heartbeat fresh, reconcile() never called "
      "— no order of any kind, closes included")
check(rounds and rounds[0] == 4,
      "record removed (啟動下單): the very next round reconciles, same process — read every round")
MARKER = os.path.join(TMP, "state", "heartbeat", "reconciler.gated")
check(os.path.exists(MARKER) and abs(os.path.getmtime(MARKER) - os.path.getmtime(HB)) < 5,
      "P2: the gated reconciler touches state/heartbeat/reconciler.gated with its heartbeat every round "
      "— the runtime's proof that the running process honours the record")

# 2: a daemon that had reconciled already, then got gated, then released
rounds, _ = run_loop({2: "add", 5: "remove"}, 8)
check(rounds[:1] == [0] and not [r for r in rounds if 0 < r < 5] and 5 in rounds,
      "already reconciled before the record appeared: nothing while gated, and the round right "
      "after 啟動下單 reconciles (force_next — the 5-min heartbeat is not due)")

# 2b: after 啟動下單 on a machine with nothing bound on the web (Type B on its own .env
# keys): the reconciler starts clean and idles — no reconcile, no crash, heartbeat fresh
json.dump({"ids": []}, open(os.path.join(TMP, "manager", "credentials.ui.json"), "w"))
open(os.path.join(TMP, ".env"), "w").write("BINANCE_API_KEY=typeb\nBINANCE_SECRET_KEY=typeb\n")
rounds, hb = run_loop({}, 5)
check(rounds == [] and all(hb),
      "nothing bound on the web (Type B keys in .env only), record gone: the reconciler starts, "
      "idles on the no-venue gate (no reconcile, no orders), heartbeat fresh")
os.remove(os.path.join(TMP, "manager", "credentials.ui.json"))
os.remove(os.path.join(TMP, ".env"))

# 3: place_order with the record present
ns = runpy.run_path(RECONCILER)
sent = []
real_dispatch = lib.execute.dispatch_order
lib.execute.dispatch_order = lambda *a, **k: sent.append(a) or {"avg_price": 1}
try:
    json.dump({"reason": "machine_restart"}, open(RECORD, "w"))
    r_entry = ns["place_order"]("BTCUSDT", 100.0, exchange="binance")
    r_close = ns["place_order"]("BTCUSDT", -100.0, reduce_only=True, exchange="binance")
    check(r_entry is False and r_close is False and not sent,
          "record lands mid-round: place_order sends neither the entry nor the close leg")
    os.remove(RECORD)
    ns["place_order"]("BTCUSDT", 100.0, exchange="binance")
    check(len(sent) == 1, "…no record: place_order dispatches again")
finally:
    lib.execute.dispatch_order = real_dispatch

# 4: TWAP in flight — the record appears after two slices
for reduce_only, side in ((False, "buy"), (True, "sell")):
    placed = []

    def _auto(symbol, signed, asset_spec, reduce_only_, exchange, **kw):
        placed.append(signed)
        if len(placed) == 2:
            json.dump({"reason": "machine_restart"}, open(RECORD, "w"))
        return {"avg_price": 100.0, "executed_qty": abs(signed) / 100.0, "exchange": "binance"}

    real_auto = lib.venue_wiring.auto_place_order
    lib.venue_wiring.auto_place_order = _auto
    stop, why = threading.Event(), {}
    try:
        summary = lib.execute.run_twap(
            "BTCUSDT", side, 500.0, 0.001, 5,
            lib.execute._make_slice_fn("BTCUSDT", None, reduce_only, "binance", side, stop,
                                       {"id": "binance"}, why),
            f"t_{side}", stop_event=stop, notify_slices=False, send_telegram_fn=lambda m: None)
    finally:
        lib.venue_wiring.auto_place_order = real_auto
        if os.path.exists(RECORD):
            os.remove(RECORD)
    check(len(placed) == 2 and stop.is_set() and why.get("stop") == "restart",
          f"TWAP {'close' if reduce_only else 'entry'} leg: record appears after slice 2 of 5 — "
          f"slices 3–5 never sent (sent {len(placed)})")

# 4b: chase (post-only, cancel-replace) — outer loop and the wait on a resting order
lib.execute._CHASE_POLL_S = 0.02
lib.execute._CHASE_TIMEOUT_S = 2.0
real_auto = lib.venue_wiring.auto_place_order
for label, record_at_start in (("outer", True), ("inner", False)):
    calls = {"place": 0, "status": 0, "cancel": 0, "market": 0}

    def _place(remaining, px, *a, **k):
        calls["place"] += 1
        return {"order_id": f"o{calls['place']}", "status": "new"}

    def _status(oid):
        calls["status"] += 1
        if calls["status"] == 1 and not record_at_start:
            json.dump({"reason": "machine_restart"}, open(RECORD, "w"))  # lands while resting
        return {"status": "new", "executed_qty": 0.0, "avg_price": 0.0}

    def _cancel(oid):
        calls["cancel"] += 1
        return {"status": "canceled"}

    tools = {"bbo": lambda: (100.0, 100.1), "place": _place, "status": _status,
             "cancel": _cancel, "venue": "binance"}
    lib.venue_wiring.auto_place_order = lambda *a, **k: calls.__setitem__("market", calls["market"] + 1)
    if record_at_start:
        json.dump({"reason": "machine_restart"}, open(RECORD, "w"))
    stop = threading.Event()
    t0 = time.time()
    try:
        lib.execute._chase_thread("BTCUSDT", 100.0, None, False, "binance", None, tools, stop)
    finally:
        lib.venue_wiring.auto_place_order = real_auto
        if os.path.exists(RECORD):
            os.remove(RECORD)
    took = time.time() - t0
    if record_at_start:
        check(calls["place"] == 0 and calls["market"] == 0 and stop.is_set(),
              f"chase {label}: record present at the top of the loop — nothing posted, no market "
              f"escalation ({calls})")
    else:
        check(calls["place"] == 1 and calls["cancel"] >= 1 and calls["market"] == 0
              and calls["status"] <= 3 and took < 1.5,
              f"chase {label}: record lands while an order rests — cancelled at the next poll "
              f"(not at the window's end), never re-posted, no market escalation ({calls}, {took:.2f}s)")

# 5: one file
import command_listener as cl  # noqa: E402
import portfolio_reporter  # noqa: E402
from lib import guard  # noqa: E402

rec_path = ns["RESTART_STOP_PATH"]
check(os.path.relpath(cl.RESTART_STOP_PATH, cl.WORKSPACE) == str(rec_path) == guard.RESTART_STOP_PATH
      == os.path.relpath(os.path.join(portfolio_reporter.WORKSPACE_STATE, "reconciler_stopped.json"),
                         portfolio_reporter.WORKSPACE),
      "runtime writer, reporter, lib/guard and the reconciler gate name the same file")

os.chdir(cwd)
shutil.rmtree(TMP, ignore_errors=True)
print("\nFAILED" if fails else "\nall ok")
sys.exit(1 if fails else 0)
