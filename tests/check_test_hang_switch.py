"""The test-only hang switch (BLAVE_TEST_HANG_BEFORE_SEND, spec live-order-hang-wake-0158 §6).

- on only from the environment of whoever starts the service: a planted workspace file
  (.env, portfolio_config, a state file) does not turn it on; a reconciler started from inside an
  agent turn (turn variables set) refuses it, and start_reconciler.sh drops it there too
- the desktop daemon takes it out of its own environment and hands it to the reconciler only;
  every other child (agent turns included) is built without it
- one loud line at reconciler start when it is on
- on: the leg parks after its inflight marker and before the send, with no progress touch;
  the send is never reached while parked; a stop requested meanwhile means it is not sent at all
- off: place_order is the same call as before — no sleep, the send goes at once

Run: cd blave-agent && .venv/bin/python tests/check_test_hang_switch.py
"""
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import types

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TMP = tempfile.mkdtemp(prefix="test-hang-")
os.chdir(TMP)
os.environ["BLAVE_AGENT_HOME"] = os.environ["BLAVECLAW_HOME"] = TMP
os.environ.pop("BLAVE_TEST_HANG_BEFORE_SEND", None)
sys.path.insert(0, ROOT)
sys.path.insert(0, os.path.join(ROOT, "runtime"))

from lib import events, execute, guard, portfolio  # noqa: E402
from manager import reconciler as rec  # noqa: E402
import command_listener as cl  # noqa: E402
import local_daemon  # noqa: E402

ENV = "BLAVE_TEST_HANG_BEFORE_SEND"
fails = 0


def check(cond, msg):
    global fails
    print(("ok   " if cond else "FAIL ") + msg)
    fails += 0 if cond else 1


events._appender = lambda t, p: None
execute._notify_fn = lambda m: None
check(rec.TEST_HANG_ENV == ENV == local_daemon.TEST_HANG_ENV, "one name on both sides")

# ── parsing: only a positive number or forever, never from inside a turn ─────────────────────
for raw, want in (("600", 600.0), (" 30 ", 30.0), ("forever", float("inf")), ("INF", float("inf")),
                  ("0", None), ("-5", None), ("nan", None), ("abc", None), ("", None)):
    check(rec._test_hang_from_env({ENV: raw}) == want, f"parse {raw!r} -> {want}")
check(rec._test_hang_from_env({}) is None, "absent -> off")
for turn_var in ("BLAVE_TURN_PID", "BLAVE_TURN_INTERRUPT_FILE"):
    check(rec._test_hang_from_env({ENV: "600", turn_var: "123:x"}) is None,
          f"agent turn ({turn_var} set) -> refused")

# ── off: zero behaviour change ────────────────────────────────────────────────────────────────
check(rec._TEST_HANG_S is None, "importing the module never turns it on (only __main__ reads env)")
real_time = rec.time
slept, called = [], []


class FakeTime:
    def __init__(self):
        self.now = 1000.0

    def monotonic(self):
        return self.now

    def sleep(self, s):
        slept.append(s)
        self.now += s
        if self.on_sleep:
            self.on_sleep()

    def __getattr__(self, name):
        return getattr(real_time, name)


ft = FakeTime()
ft.on_sleep = None
rec.time = ft
real_dispatch = execute.dispatch_order
execute.dispatch_order = lambda *a, **k: called.append(a) or {"executed_qty": 1}
try:
    out = rec.place_order("BTCUSDT", 10, exchange="paper")
    check(out == {"executed_qty": 1} and called and not slept, "off: sent at once, no park")
finally:
    rec.time = real_time
    execute.dispatch_order = real_dispatch

# ── on: parks after the marker, before the send ──────────────────────────────────────────────
os.makedirs("manager", exist_ok=True)
os.makedirs("state/heartbeat", exist_ok=True)
os.makedirs("strategies/s", exist_ok=True)
open("strategies/s/strategy.py", "w").write('INTERVAL = "1h"\n')
json.dump({"symbol": "BTCUSDT", "position": 1}, open("strategies/s/state.json", "w"))
os.makedirs("state/bar_wait", exist_ok=True)
json.dump({"last_processed_bar": None, "last_attempt_failed_at": None}, open("state/bar_wait/s.json", "w"))
json.dump({"self_ledger": False, "amounts": {"s": 100}, "exchanges": {"s": "paper"}},
          open("manager/portfolio_config.json", "w"))
portfolio.drift_band = lambda symbol: portfolio._DRIFT_BAND_FLOOR
rec.PROGRESS_PATH.write_text("{}")
rec._progress_on = True


class Escape(BaseException):   # reconcile catches Exception from a send as an order error
    pass


for label, seconds in (("60s", 60.0), ("forever", float("inf"))):
    del slept[:], called[:]
    seen = []

    def during(label=label):
        seen.append(([m.get("key") for m in execute.list_inflight()], len(called),
                     os.path.getmtime(rec.PROGRESS_PATH)))
        if seconds == float("inf") and len(slept) >= 500:
            raise Escape()
    ft.now, ft.on_sleep = 1000.0, during
    rec.time, rec._TEST_HANG_S = ft, seconds
    execute.dispatch_order = lambda *a, **k: called.append(a) or {"executed_qty": 1, "avg_price": 1.0}
    try:
        os.utime(rec.PROGRESS_PATH, (5000, 5000))
        try:
            portfolio.reconcile(lambda: {}, rec.place_order)
            escaped = False
        except Escape:
            escaped = True
        parked = [s for s in seen if s[0] == ["BTCUSDT#market"] and s[1] == 0]
        check(seen and len(parked) == len(seen),
              f"{label}: every parked moment has the marker on disk and no send yet ({len(seen)} looks)")
        check(all(s[2] != 5000 and s[2] == seen[0][2] for s in seen),
              f"{label}: the progress stamp is not touched while parked")
        if seconds == float("inf"):
            check(escaped and not called and sum(slept) >= 499, "forever: never returns, never sends")
        else:
            check(not escaped and len(called) == 1 and abs(sum(slept) - 60) < 1e-6,
                  "60s: parks 60 s, then sends once")
    finally:
        rec.time, rec._TEST_HANG_S = real_time, None
        execute.dispatch_order = real_dispatch
        execute._own_markers.clear()
        shutil.rmtree(execute._INFLIGHT_DIR, ignore_errors=True)

del slept[:], called[:]
ft.now, ft.on_sleep = 1000.0, lambda: execute.request_stop() if len(slept) == 3 else None
rec.time, rec._TEST_HANG_S = ft, 10.0
execute.dispatch_order = lambda *a, **k: called.append(a) or {"executed_qty": 1}
try:
    check(rec.place_order("BTCUSDT", 10, exchange="paper") is False and not called,
          "a stop requested while parked: the leg is not sent")
finally:
    execute._stop_requested.clear()
    rec.time, rec._TEST_HANG_S = real_time, None
    execute.dispatch_order = real_dispatch

# ── desktop daemon: only the reconciler gets it, from the daemon's own start ─────────────────
base_env = cl._local_child_env
environ = {ENV: "forever", "PATH": "/usr/bin"}
child_env = local_daemon._reconciler_env(base_env, environ)
check(ENV not in environ, "daemon: taken out of its own environment")
check(child_env().get(ENV) == "forever" and child_env(BLAVE_PRESIDENT_LOCAL="1").get(ENV) == "forever",
      "daemon: the reconciler child gets it (with or without extra variables)")
check(local_daemon._reconciler_env(base_env, {"PATH": "/usr/bin"}) is base_env,
      "daemon, off: the reconciler's env builder is the same function as before")
os.environ[ENV] = "forever"   # an agent's environment leaking into the daemon process
try:
    check(ENV not in cl._local_child_env(), "every other daemon child (agent turns, account reads) is built without it")
finally:
    os.environ.pop(ENV, None)

# ── start_reconciler.sh drops it when started from inside a turn ─────────────────────────────
sh = open(os.path.join(ROOT, "manager", "start_reconciler.sh")).read().splitlines()
line = next(x for x in sh if "unset BLAVE_TEST_HANG_BEFORE_SEND" in x)
for turn, kept in (({}, True), ({"BLAVE_TURN_PID": "1:x"}, False), ({"BLAVE_TURN_INTERRUPT_FILE": "/t"}, False)):
    r = subprocess.run(["bash", "-c", line + '; printf %s "${BLAVE_TEST_HANG_BEFORE_SEND-}"'],
                       env={"PATH": os.environ.get("PATH", "/usr/bin:/bin"), ENV: "600", **turn},
                       capture_output=True, text=True, timeout=10)
    check((r.stdout == "600") == kept, f"start_reconciler.sh {turn or 'service start'}: {'kept' if kept else 'dropped'}")

# ── end to end: a real reconciler start, three ways ──────────────────────────────────────────
ON = "TEST SWITCH BLAVE_TEST_HANG_BEFORE_SEND ON"


def start_log(extra_env, plant=False):
    ws = tempfile.mkdtemp(prefix="test-hang-ws-")
    os.makedirs(os.path.join(ws, "manager"))
    os.makedirs(os.path.join(ws, "state"))
    cfg = {"self_ledger": False, "amounts": {}, "exchanges": {}}
    if plant:   # everything an agent could write in a workspace
        open(os.path.join(ws, ".env"), "w").write(f"{ENV}=forever\nexport {ENV}=forever\n")
        cfg[ENV] = "forever"
        open(os.path.join(ws, "state", ENV), "w").write("forever")
        open(os.path.join(ws, "manager", ENV), "w").write("forever")
    json.dump(cfg, open(os.path.join(ws, "manager", "portfolio_config.json"), "w"))
    env = {"PATH": os.environ.get("PATH", "/usr/bin:/bin"), "HOME": ws, "BLAVE_AGENT_HOME": ws,
           "BLAVE_AGENT_WORKSPACE": ws, "PYTHONDONTWRITEBYTECODE": "1", **extra_env}
    logf = os.path.join(ws, "out.log")
    with open(logf, "w") as f:
        p = subprocess.Popen([sys.executable, os.path.join(ROOT, "manager", "reconciler.py")], cwd=ws, env=env,
                             stdout=f, stderr=subprocess.STDOUT)
    deadline = time.time() + 60
    try:
        while time.time() < deadline and p.poll() is None:
            if "Reconciler started" in open(logf).read():
                time.sleep(0.5)
                break
            time.sleep(0.1)
    finally:
        if p.poll() is None:
            p.kill()
        p.wait(timeout=10)
        out = open(logf).read()
        shutil.rmtree(ws, ignore_errors=True)
    return out


log = start_log({ENV: "600"})
check("Reconciler started" in log and log.count(ON) == 1,
      "service environment: one loud line at start" + ("" if ON in log else f"\n{log[-2000:]}"))
log = start_log({ENV: "600", "BLAVE_TURN_PID": "4242:x"})
check("Reconciler started" in log and ON not in log and "ignored" in log,
      "started from inside an agent turn: refused, says so")
log = start_log({}, plant=True)
check("Reconciler started" in log and ON not in log and ENV not in log,
      "workspace files planted (.env, portfolio_config, state, manager): stays off")

shutil.rmtree(TMP, ignore_errors=True)
print(f"\n{'FAIL' if fails else 'PASS'} ({fails} failing)")
sys.exit(1 if fails else 0)
