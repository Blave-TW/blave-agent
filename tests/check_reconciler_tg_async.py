"""A slow Telegram never stalls the reconciler's main loop (audit release-0157-merged D-M2).

lib/notify waits up to 30 s per chat per chunk. Sent inline, two notices × two chats × two chunks
after one order held the loop for 240 s = HANG_STALL_S: the hang watch killed a healthy reconciler,
and the third such kill in an hour HALTs trading. Here the send is scaled down (DELAY per send) and
the loop's two progress stamps around a burst of notices must stay much closer than the burst takes.

- send_telegram returns at once; the notices go out on their own thread, in order, all of them
- a rejected send is logged as dropped and the next one still goes
- at exit (_tg_flush) what is queued goes first; past the budget the rest is counted and logged
- the startup orphan sweep calls its on_each before every venue call (one stamp per cancel)

Run: cd blave-agent && .venv/bin/python tests/check_reconciler_tg_async.py
"""
import json
import os
import shutil
import sys
import tempfile
import time
import types

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TMP = tempfile.mkdtemp(prefix="rec-tg-")
os.chdir(TMP)
os.environ["BLAVE_AGENT_HOME"] = os.environ["BLAVECLAW_HOME"] = TMP
sys.path.insert(0, ROOT)
sys.path.insert(0, os.path.join(ROOT, "runtime"))

from lib import venue_wiring  # noqa: E402
from manager import reconciler as rec  # noqa: E402
import hang_watch  # noqa: E402

fails = 0


def check(cond, msg, detail=None):
    global fails
    print(("ok   " if cond else "FAIL ") + msg + ("" if cond or detail is None else f"  <- {detail!r}"))
    fails += 0 if cond else 1


os.makedirs("state", exist_ok=True)
os.makedirs("manager", exist_ok=True)
json.dump({"amounts": {}, "exchanges": {}}, open("manager/portfolio_config.json", "w"))
rec._progress_init()
check(rec._progress_on, "(setup) the progress stamp is on")

DELAY = 0.3          # one scaled-down Telegram send (production: up to 30 s)
N = 8                # notices in the burst (production example: 2 notices × 2 chats × 2 chunks)
got = []


def slow_send(msg):
    time.sleep(DELAY)
    if msg == "reject":
        raise RuntimeError("429 Too Many Requests")
    got.append(msg)


rec._raw_send = slow_send
stamps = []
real_progress = rec._progress
rec._progress = lambda: (stamps.append(time.monotonic()), real_progress())

# one order's worth of loop: stamp (place_order out), the notices, stamp (next symbol)
rec._progress()
t0 = time.monotonic()
for i in range(N):
    rec.send_telegram(f"n{i}")
call_s = time.monotonic() - t0
rec._progress()
gap = stamps[-1] - stamps[-2]
check(call_s < DELAY, f"{N} notices queued in {call_s:.3f}s — less than one send ({DELAY}s); inline they took {N * DELAY:.1f}s", call_s)
check(gap < DELAY, "the two stamps around the burst are closer than one send: the watch sees no stall", gap)
# at production scale the same burst inline is N × 30 s; the watch's line is HANG_STALL_S
check(N * 30 >= hang_watch.HANG_STALL_S, f"(the case it guards) {N} sends × 30 s ≥ HANG_STALL_S {hang_watch.HANG_STALL_S}s")

left = rec._tg_flush(time.monotonic() + N * DELAY + 5)
check(left == 0 and got == [f"n{i}" for i in range(N)], "all of them delivered, in order", got)
check(len(stamps) > 4, "the exit flush keeps touching the stamp while it waits", len(stamps))

del got[:]
rec.send_telegram("reject")
rec.send_telegram("after")
rec._tg_flush(time.monotonic() + 5)
check(got == ["after"] and rec._tg_thread.is_alive(), "a rejected send is dropped (logged); the thread lives and the next one goes", got)

del got[:]
for i in range(5):
    rec.send_telegram(f"late{i}")
left = rec._tg_flush(time.monotonic() + DELAY * 1.5)
check(0 < left < 5, "exit budget shorter than the queue: the rest is counted as dropped", left)
rec._tg_flush(time.monotonic() + 5)

# ── bounds, one worker, the cloud's SIGTERM (audit Delta 二 nits) ──
import logging  # noqa: E402
import threading  # noqa: E402
lines = []


class _Grab(logging.Handler):
    def emit(self, r):
        lines.append(r.getMessage())


logging.getLogger().addHandler(_Grab())
gate = threading.Event()
del got[:]
rec._raw_send = lambda m: (gate.wait(10), got.append(m))
rec.send_telegram("hold")             # the worker takes this one and waits on the gate
time.sleep(0.1)
for i in range(rec.TG_QUEUE_MAX):
    rec.send_telegram(f"q{i}")
del lines[:]
rec.send_telegram("one too many")
check(any("already waiting on Telegram" in x and "one too many" in x for x in lines),
      f"queue full ({rec.TG_QUEUE_MAX} waiting): the next one is dropped with a line, the call does not block", lines[-1:])
gate.set()
rec._tg_flush(time.monotonic() + 10)
check(got[:2] == ["hold", "q0"] and len(got) == rec.TG_QUEUE_MAX + 1 and "one too many" not in got, "…the ones that fit still go, in order", len(got))

gate.clear()
del got[:], lines[:]
real_age = rec.TG_MAX_AGE_S
rec.TG_MAX_AGE_S = 0.2
rec.send_telegram("hold2")
time.sleep(0.05)
rec.send_telegram("stale")            # waits behind hold2 for longer than TG_MAX_AGE_S
time.sleep(0.4)
gate.set()
rec._tg_flush(time.monotonic() + 5)
rec.TG_MAX_AGE_S = real_age
check(got == ["hold2"] and any("notification dropped (queued" in x and "stale" in x for x in lines),
      "a notice that waited longer than TG_MAX_AGE_S (Telegram down) is dropped with a line, not sent late", (got, lines[-1:]))

rec._raw_send = slow_send
# Locked first-call init: in a fresh interpreter. Resetting _tg_thread here would orphan the live worker,
# still blocked on the same queue — two consumers, and every later order check goes flaky under load.
import subprocess  # noqa: E402
RACE = """
import sys, threading
sys.path[:0] = [%r, %r]
from manager import reconciler as rec
rec._raw_send = lambda m: None
starts, real = [], rec._threading.Thread
bar = threading.Barrier(8)
ts = [threading.Thread(target=lambda: (bar.wait(), rec.send_telegram("race"))) for _ in range(8)]
rec._threading.Thread = lambda *a, **k: (starts.append(1), real(*a, **k))[1]
[t.start() for t in ts]; [t.join() for t in ts]
rec._threading.Thread = real
print(len(starts), rec._tg_flush(__import__("time").monotonic() + 5))
""" % (ROOT, os.path.join(ROOT, "runtime"))
out = subprocess.run([sys.executable, "-c", RACE], cwd=TMP, capture_output=True, text=True, timeout=60).stdout.split()
check(out == ["1", "0"], "eight threads' first calls at once start one worker (locked init), and all eight go out", out)
workers = [t for t in threading.enumerate() if t.name == "telegram"]
check(len(workers) == 1, "this process still has exactly one Telegram worker (order below depends on it)", len(workers))

src = open(os.path.join(ROOT, "manager", "reconciler.py"), encoding="utf-8").read()
check("if _signal.getsignal(_signal.SIGTERM) in (_signal.SIG_DFL, None):\n        _signal.signal(_signal.SIGTERM, _on_term)" in src,
      "SIGTERM handler only when nobody owns SIGTERM (the desktop's local_daemon has its own and flushes there)")
del got[:], lines[:]
exits = []
real_exit = rec.os._exit
rec.os._exit = lambda code: exits.append(code)
for i in range(3):
    rec.send_telegram(f"t{i}")
rec._on_term(15, None)
rec.os._exit = real_exit
check(exits == [143] and got == ["t0", "t1", "t2"], "cloud SIGTERM: the queue gets TG_TERM_S, then the same exit status as before (143)", (exits, got))
for i in range(40):
    rec.send_telegram(f"u{i}")
real_term = rec.TG_TERM_S
rec.TG_TERM_S = DELAY * 1.5
del lines[:]
rec.os._exit = lambda code: exits.append(code)
rec._on_term(15, None)
rec.os._exit = real_exit
rec.TG_TERM_S = real_term
check(any("dropped: still unsent when the reconciler stopped" in x for x in lines), "…what does not fit in TG_TERM_S is logged as dropped", lines[-1:])
rec._tg_flush(time.monotonic() + 40 * DELAY + 5)

rec._raw_send = None
t0 = time.monotonic()
rec.send_telegram("no bot")
check(time.monotonic() - t0 < 0.05, "no bot paired: logged only, nothing queued")

# ── startup orphan sweep: a stamp before every venue call ──
calls, ticks = [], []
order = types.ModuleType("lib.order_fake")
order.get_open_orders = lambda env: (calls.append("fetch"), [
    {"client_order_id": f"rc{100000000000 + i}", "symbol": "BTCUSDT", "order_id": str(i)} for i in range(3)])[1]
order.cancel_order = lambda env, s, order_id=None: calls.append("cancel")
sys.modules["lib.order_fake"] = order
real_env, real_detect = venue_wiring.read_env, venue_wiring.detect_venue
venue_wiring.read_env = lambda path=".env": {}
venue_wiring.detect_venue = lambda env: "fake"
n = venue_wiring.sweep_orphan_orders(on_each=lambda: ticks.append(len(calls)))
check(n == 3 and ticks == [0, 1, 2, 3], "sweep: on_each before the open-order read and before each of the 3 cancels", (n, ticks))
check(venue_wiring.sweep_orphan_orders() == 3, "sweep without on_each (runtime/local_daemon's exit sweep) unchanged")
venue_wiring.read_env, venue_wiring.detect_venue = real_env, real_detect

os.chdir(ROOT)
shutil.rmtree(TMP, ignore_errors=True)
print("\nALL PASS" if not fails else f"\n{fails} FAIL")
sys.exit(1 if fails else 0)
