"""The desktop daemon samples the api's clock while a TW futures broker is bound — no network.

What it protects: lib/tw_clock's entry gate learns the skew only from Blave api replies, and a
desktop with no Blave data access makes none — its gate then trusts a clock that may be minutes
fast (a pre-open market IOC is queued to the open, read as "not taken" and sent again). The
daemon now GETs the api every CLOCK_EVERY_S and hands the reply to tw_clock.note_reply.

Asserts: clock_sample writes the workspace's state/clock_skew.json (skew from the Date header),
whatever the thread's cwd; _clock_loop samples with 群益 or 統一 bound and not with only a crypto
venue; a workspace without lib/tw_clock.py is skipped.

Run: cd blave-agent && .venv/bin/python tests/check_daemon_clock_sample.py
"""
import json
import os
import shutil
import sys
import tempfile
import threading
import time
import types
from email.utils import formatdate

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RUNTIME = os.path.join(ROOT, "runtime")
BASE = tempfile.mkdtemp(prefix="clock-sample-", dir=os.environ.get("SCRATCHPAD") or None)
WS = os.path.join(BASE, "workspace")
os.makedirs(os.path.join(WS, "lib"))
os.makedirs(os.path.join(WS, "state"))
shutil.copy(os.path.join(ROOT, "lib", "tw_clock.py"), os.path.join(WS, "lib", "tw_clock.py"))
os.environ["BLAVE_AGENT_HOME"] = os.environ["BLAVECLAW_HOME"] = BASE
os.environ["BLAVE_AGENT_BASE"] = BASE
os.environ["BLAVE_AGENT_WORKSPACE"] = WS
os.environ.pop("BLAVE_AGENT_LOCAL", None)
sys.path.insert(0, RUNTIME)
import local_daemon as ld  # noqa: E402

fails = 0


def check(cond, msg, got=None):
    global fails
    print(("ok   " if cond else "FAIL ") + msg + ("" if cond else f"  got={got!r}"))
    fails += 0 if cond else 1


calls = []
FAST = 120


def fake_get(url, timeout=None):
    calls.append(url)
    return types.SimpleNamespace(headers={"Date": formatdate(time.time() - FAST, usegmt=True)})


sys.modules["requests"] = types.SimpleNamespace(get=fake_get)
SKEW = os.path.join(WS, "state", "clock_skew.json")

os.chdir(BASE)   # not the workspace: the sample must still land in it
check(ld.clock_sample(WS) is True and calls and calls[-1].endswith(ld.CLOCK_PATH), "one GET to the api", calls)
rows = json.load(open(SKEW)).get("samples") if os.path.exists(SKEW) else None
check(bool(rows) and abs(rows[-1][1] - FAST) < 3, "the workspace's clock_skew.json holds the +120 s skew", rows)
check(not os.path.exists(os.path.join(BASE, "state", "clock_skew.json")), "nothing written under the cwd")

shutil.rmtree(os.path.join(WS, "lib"))
n = len(calls)
check(ld.clock_sample(WS) is False and len(calls) == n, "no lib/tw_clock.py: skipped, no request")
os.makedirs(os.path.join(WS, "lib"))
shutil.copy(os.path.join(ROOT, "lib", "tw_clock.py"), os.path.join(WS, "lib", "tw_clock.py"))


def loop_samples(env_ids):
    stop = threading.Event()
    me = types.SimpleNamespace(ws=WS, stop=types.SimpleNamespace(is_set=stop.is_set, wait=lambda s: stop.set()),
                               cl=types.SimpleNamespace(_venue_cred_ids=lambda lines: set(env_ids)))
    open(os.path.join(WS, ".env"), "w").write("x=1\n")
    n = len(calls)
    ld.Daemon._clock_loop(me)
    return len(calls) - n


check(loop_samples({"CAPITAL"}) == 1, "群益 bound: the loop samples")
check(loop_samples({"PRESIDENT", "BINANCE"}) == 1, "統一 bound: the loop samples")
check(loop_samples({"BINANCE"}) == 0, "only a crypto venue: no request")
check(ld.Daemon._clock_loop.__name__ in ld.Daemon.run.__code__.co_names, "the daemon starts _clock_loop")

print("\ncheck_daemon_clock_sample: " + ("all ok" if not fails else f"FAILED ({fails})"))
sys.exit(1 if fails else 0)
