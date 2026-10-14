"""Signals keep computing with no venue bound; nothing turns them into an order (Wei 2026-10-13).

The Type A/C scheduler no longer waits for a bound venue (command_listener._run_scheduler_cycle),
so the 策略組合 page shows the latest target positions on a machine that never connected an
exchange. What must stay true, each asserted here:

  1. no venue + picked strategies → every Type A/C name is ticked; a Type B name never is, and
     the cycle touches no crontab / schtasks / reconciler start.
  2. the REAL tick (wait_for_bar.py → strategy.py → lib/runner) on an unbound workspace writes
     state.json and nothing else: no process of the tick imports ANY lib/order_*.py,
     lib/account_*.py or lib/venue_wiring (enumerated from disk — a new venue lib is covered
     the day it lands), and none opens a socket.
  3. full unbind, stop NOT confirmed (membership kept): signals stay frozen while the survivor
     reconciler's heartbeat is fresh — it is the one process that could still trade a moved
     target — and resume once that heartbeat is stale; right after a sleep / clock jump a stale
     heartbeat still freezes for SIGNALS_GAP_GRACE_S. The report carries signals_frozen
     {since, pending} exactly while frozen.
  4. full unbind, stop confirmed: members and amounts are kept, routing is blanked, Type B crons
     are dropped; the kept (and re-picked) Type A/C members are ticked, routed nowhere, and no
     reconciler is started.
  5. through all of it the runtime process never imports an order lib; with no venue bound
     no path starts the reconciler (resume, resume_wait, restart_reconciler).
  6. desktop mode (BLAVE_AGENT_LOCAL=1): the real tick again loads no venue module and gets
     no BLAVE_TW_BROKER.

Runtime + workspace, no network, no supervisor, never a real crontab.

Run: cd blave-agent && .venv/bin/python tests/check_signals_without_venue.py
"""
import glob
import importlib.util
import json
import os
import shutil
import sys
import tempfile
import time

# The real tick runs strategies under this interpreter: without pandas they never write
# state.json and part 3 fails as if it were a logic bug.
if importlib.util.find_spec("pandas") is None:
    sys.exit(f"ENVIRONMENT: pandas is not importable from {sys.executable} — this is not a test "
             f"failure. Run with blave-agent/.venv/bin/python.")

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BASE = tempfile.mkdtemp(prefix="signals-no-venue-")
os.environ["BLAVE_AGENT_HOME"] = os.environ["BLAVECLAW_HOME"] = BASE
WS = os.path.join(BASE, "workspace")
shutil.copytree(os.path.join(ROOT, "lib"), os.path.join(WS, "lib"),
                ignore=shutil.ignore_patterns("__pycache__"))
os.makedirs(os.path.join(WS, "state", "heartbeat"))
os.makedirs(os.path.join(WS, "manager"))
for f in ("wait_for_bar.py", "alert_failure.py"):
    shutil.copy(os.path.join(ROOT, "manager", f), os.path.join(WS, "manager"))
os.environ["BLAVE_AGENT_BASE"] = BASE
os.environ["BLAVE_AGENT_WORKSPACE"] = WS
os.environ.pop("BLAVE_AGENT_LOCAL", None)
os.chdir(WS)
sys.path.insert(0, os.path.join(ROOT, "runtime"))

import command_listener as cl  # noqa: E402
import portfolio_reporter as pr  # noqa: E402

fails = 0


def check(cond, msg):
    global fails
    print(("ok   " if cond else "FAIL ") + msg)
    fails += 0 if cond else 1


# every venue lib on disk, by module name — the list the tick and this process are held to
MONEY = sorted("lib." + os.path.basename(p)[:-3]
               for pat in ("order_*.py", "account_*.py", "*_worker.py", "*_vault.py",
                           "president_quote.py")
               for p in glob.glob(os.path.join(ROOT, "lib", pat))) + ["lib.venue_wiring"]

CFG = os.path.join(WS, "manager", "portfolio_config.json")
ENV = os.path.join(WS, ".env")
HB = cl.RECONCILER_HEARTBEAT
B_RAN = os.path.join(WS, "typeb_ran")

HEAD = ("import sys\nfrom pathlib import Path\n"
        "sys.path.insert(0, str(Path(__file__).parent.parent.parent))\n"
        "import numpy as np, pandas as pd\n")
# bars run through the hour that is still forming, so "the last closed bar is in" holds
# whichever side of an hour boundary the two processes read the clock on
STRATEGY_A = HEAD + '''
STRATEGY_NAME = "sa"
SYMBOL = "BTCUSDT"
INTERVAL = "1h"
START = "2024-01-01"
FEE = 0.0005
MCPT = False
def fetch_data(headers=None):
    idx = pd.date_range(end=pd.Timestamp.now("UTC").tz_localize(None).floor("h"), periods=300, freq="h")
    c = pd.Series(100 + np.cumsum(np.sin(np.arange(300) / 7.0)), index=idx)
    return pd.DataFrame({"Open": c, "High": c * 1.001, "Low": c * 0.999, "Close": c, "Volume": 1.0})
def compute_signals(df):
    return pd.Series(1.0, index=df.index)
if __name__ == "__main__":
    from lib.runner import run
    run(locals(), fetch_data, compute_signals, send_telegram_fn=None)
'''
STRATEGY_C = HEAD + '''
STRATEGY_NAME = "sc"
INTERVAL = "1h"
START = "2024-01-01"
FEE = 0.001
def fetch_data(headers=None):
    idx = pd.date_range(end=pd.Timestamp.now("UTC").tz_localize(None).floor("h"), periods=300, freq="h")
    r = np.random.default_rng(9).normal(0.0003, 0.01, (300, 2))
    return pd.DataFrame(100 * np.exp(np.cumsum(r, axis=0)), index=idx, columns=["AAAUSDT", "BBBUSDT"])
def compute_signals(c):
    w = np.zeros(c.shape)
    w[:, 0] = 0.5
    return w, pd.concat({"close": c, "open": c}, axis=1)
if __name__ == "__main__":
    from lib.runner import run
    run(locals(), fetch_data, compute_signals, send_telegram_fn=None)
'''
# Type B: no INTERVAL. If anything ever ran it, the file below exists.
STRATEGY_B = f'open({B_RAN!r}, "w").close()\n'
for name, src in (("sa", STRATEGY_A), ("sc", STRATEGY_C), ("sb", STRATEGY_B)):
    os.makedirs(os.path.join(WS, "strategies", name))
    open(os.path.join(WS, "strategies", name, "strategy.py"), "w").write(src)

# ── nothing here may reach this computer's crontab, a supervisor or an exchange ──
cl._ac_migration_done = True
real_restart = cl._restart_reconciler
crons, starts, spawned = [], [], []
stop_ok = {"v": True}
cl._sync_strategy_crons = lambda names: crons.append(set(names))
cl._stop_reconciler = lambda: stop_ok["v"]
cl._restart_reconciler = lambda args: starts.append("restart") or "reconciler restarted"
cl._ensure_reconciler_running = lambda: starts.append("ensure") or "reconciler restarted"
cl._stray_reconciler_pids = lambda: []
_real_run, _real_popen = cl.subprocess.run, cl.subprocess.Popen


def _no_spawn(*a, **k):
    spawned.append(a[0] if a else k.get("args"))
    raise OSError("this test spawns nothing")


def unbound_env():
    open(ENV, "w").write("BLAVE_API_KEY=not-a-real-blave\nblave_secret_key=not-a-real-blave\n"
                         "OPENAI_API_KEY=not-a-real-service-key\n")


def set_cfg(amounts, exchanges):
    json.dump({"amounts": amounts, "exchanges": exchanges}, open(CFG, "w"))


def cycle(real_tick=False):
    """One scheduler cycle; returns the Type A/C names it ticked."""
    ticked, threads = [], []
    real = cl._tick_one

    def tick(name):
        ticked.append(name)
        if real_tick:
            real(name)

    class _T(cl.threading.Thread):
        def start(self):
            threads.append(self)
            super().start()

    real_thread, cl._tick_one, cl.threading.Thread = cl.threading.Thread, tick, _T
    try:
        cl._run_scheduler_cycle()
        for t in threads:
            t.join(120)
    finally:
        cl._tick_one, cl.threading.Thread = real, real_thread
    return sorted(ticked)


def age_heartbeat(seconds):
    os.makedirs(os.path.dirname(HB), exist_ok=True)
    open(HB, "a").close()
    t = time.time() - seconds
    os.utime(HB, (t, t))


try:
    # ── 1. never bound: A/C tick, B does not, nothing else is touched ────────
    unbound_env()
    set_cfg({"sa": 0, "sc": 0, "sb": 0}, {"sa": "", "sc": "", "sb": ""})
    check(not cl._bound_venue(), "setup: no venue bound (a lone service key is not a venue)")
    cl.subprocess.run = cl.subprocess.Popen = _no_spawn
    try:
        got = cycle()
    finally:
        cl.subprocess.run, cl.subprocess.Popen = _real_run, _real_popen
    check(got == ["sa", "sc"], f"no venue, strategies picked: every Type A/C is ticked, Type B is not → {got}")
    check(not crons and not starts and not spawned,
          f"…and the cycle syncs no crontab, starts no reconciler, spawns nothing → {crons} {starts} {spawned}")
    deps = json.load(open(os.path.join(WS, "state", "deployments.json")))
    check(sorted(deps) == ["sa", "sc"], "…the registry lists the two as scheduled (the page's 排程 column)")
    set_cfg({}, {})
    check(cycle() == [], "nothing picked: nothing ticked")

    # ── 2. the real tick writes state.json and loads no venue code ───────────
    shim = os.path.join(BASE, "shim")
    os.makedirs(shim)
    trace = os.path.join(BASE, "trace.jsonl")
    open(os.path.join(shim, "sitecustomize.py"), "w").write(
        "import atexit, json, os, socket, sys\n"
        "_net = []\n"
        "def _refuse(self, *a, **k):\n"
        "    _net.append(repr(a[:1]))\n"
        "    raise OSError('no network in this test')\n"
        "socket.socket.connect = socket.socket.connect_ex = _refuse\n"
        "def _dump():\n"
        "    with open(os.environ['SWV_TRACE'], 'a') as f:\n"
        "        f.write(json.dumps({'argv': sys.argv, 'net': _net, 'tw': os.environ.get('BLAVE_TW_BROKER'),\n"
        "                            'mods': sorted(m for m in sys.modules if m.startswith('lib.'))}) + '\\n')\n"
        "atexit.register(_dump)\n")
    real_env, real_py = cl._strategy_subprocess_env, cl._workspace_python
    cl._strategy_subprocess_env = lambda *a, **k: {**real_env(*a, **k), "PYTHONPATH": shim,
                                                    "SWV_TRACE": trace, "MPLBACKEND": "Agg"}
    cl._workspace_python = lambda: sys.executable  # the interpreter that has pandas here
    set_cfg({"sa": 0, "sc": 0, "sb": 0}, {"sa": "", "sc": "", "sb": ""})
    try:
        got = cycle(real_tick=True)
    finally:
        cl._strategy_subprocess_env, cl._workspace_python = real_env, real_py

    def state(name):
        try:
            return json.load(open(os.path.join(WS, "strategies", name, "state.json")))
        except (OSError, ValueError):
            return None

    sa, sc = state("sa"), state("sc")
    check(got == ["sa", "sc"] and isinstance(sa, dict) and sa.get("position") == 1.0,
          f"real tick, no venue: Type A state.json carries the signal → {sa}")
    check(isinstance(sc, dict) and (sc.get("weights") or {}).get("AAAUSDT") == 0.5,
          f"real tick, no venue: Type C state.json carries the weights → {sc}")
    rows = [json.loads(l) for l in open(trace)] if os.path.exists(trace) else []
    ran = {os.path.basename(os.path.dirname(r["argv"][0])) for r in rows if r["argv"][0].endswith("strategy.py")}
    check(ran == {"sa", "sc"} and len(rows) >= 4,
          f"…traced both wait_for_bar processes and both strategy processes → {len(rows)} rows, ran {sorted(ran)}")
    loaded = sorted({m for r in rows for m in r["mods"] if m in MONEY})
    check(len(MONEY) >= 15 and not loaded,
          f"…none of the {len(MONEY)} venue modules on disk was imported by any of them → {loaded}")
    check(not any(r["net"] for r in rows), "…and none opened a socket")
    check(not os.path.exists(B_RAN), "Type B was never run")
    check(not os.path.isdir(os.path.join(WS, "state", "execution", "money_pids"))
          or not os.listdir(os.path.join(WS, "state", "execution", "money_pids")),
          "no process marked itself as a money process (lib/guard.mark_money_process)")

    # ── 3. full unbind, stop NOT confirmed: frozen while the survivor may be alive ──
    def bound_and_trading():
        open(ENV, "w").write("BLAVE_API_KEY=not-a-real-blave\nSINOPAC_API_KEY=not-a-real-key\n"
                             "SINOPAC_SECRET_KEY=not-a-real-secret\n")
        for p in (cl.RECONCILER_STOP_MARK,):
            if os.path.exists(p):
                os.remove(p)
        set_cfg({"sa": 1000, "sc": 1000, "sb": 1000}, {"sa": "sinopac", "sc": "sinopac", "sb": "sinopac"})
        age_heartbeat(2)  # a reconciler is running
        del crons[:]

    def unbind():
        return cl.dispatch({"cmd": "credentials_remove",
                            "args": {"env": ["SINOPAC_API_KEY", "SINOPAC_SECRET_KEY"]}})

    bound_and_trading()
    check(cl._bound_venue() and cycle() == ["sa", "sc"], "bound: ticked as always")
    stop_ok["v"] = False
    unbind()
    stop_ok["v"] = True
    kept = json.load(open(CFG))
    check(not cl._bound_venue() and kept["amounts"] == {"sa": 1000, "sc": 1000, "sb": 1000}
          and kept["exchanges"]["sa"] == "sinopac" and crons == [set()],
          "unbind, stop not confirmed: membership and routing kept, Type B crons dropped")
    check(cycle() == [], "…reconciler heartbeat fresh: NOT ticked — a survivor could trade a moved target")
    rep = pr.build_report()
    since = (rep.get("signals_frozen") or {}).get("since")
    check(isinstance(since, int) and abs(since - time.time()) < 60
          and rep["signals_frozen"]["pending"] == [],
          f"…report: signals_frozen {{since, pending: []}} (sa / sc have state.json; Type B sb has none but no signal to draw either) → {rep.get('signals_frozen')}")
    os.remove(os.path.join(WS, "strategies", "sc", "state.json"))
    check(pr.build_report()["signals_frozen"]["pending"] == ["sc"],
          "…a picked Type A/C name with no state.json is listed in pending, not left to read as 0; Type B never is")
    age_heartbeat(cl.RECONCILER_ALIVE_S - 30)
    check(cycle() == [] and pr.build_report()["signals_frozen"]["since"] == since,
          "…still inside the alive window: not ticked, `since` not rewritten")
    age_heartbeat(cl.RECONCILER_ALIVE_S + 5)
    cl._downtime_gap_seen = time.monotonic()
    check(cycle() == [], "…heartbeat stale right after a sleep / clock jump: still frozen (grace)")
    cl._downtime_gap_seen = time.monotonic() - cl.SIGNALS_GAP_GRACE_S - 1
    check(cycle() == ["sa", "sc"], "…heartbeat stale (the daemon is gone): signals compute again")
    check(pr.build_report()["signals_frozen"] is None and not os.path.exists(cl.SIGNALS_FROZEN_PATH),
          "…and the report's signals_frozen is null again")

    # ── 4. full unbind, stop confirmed: clean sheet, then picked again with no venue ──
    bound_and_trading()
    unbind()
    kept = json.load(open(CFG))
    check(kept["amounts"] == {"sa": 1000, "sc": 1000, "sb": 1000}
          and kept["exchanges"] == {"sa": "", "sc": "", "sb": ""} and crons == [set()]
          and os.path.exists(cl.RECONCILER_STOP_MARK),
          "unbind, stop confirmed: members and amounts kept (Wei 10-14), routing blanked, Type B crons dropped, stop marked")
    del spawned[:]
    cl.subprocess.run = cl.subprocess.Popen = _no_spawn
    try:
        got = cycle()
    finally:
        cl.subprocess.run, cl.subprocess.Popen = _real_run, _real_popen
    check(got == ["sa", "sc"] and not starts and not spawned,
          f"…the kept Type A/C members keep computing signals, routed nowhere, nothing started → {got}")
    del crons[:]
    cl.subprocess.run = cl.subprocess.Popen = _no_spawn
    try:
        cl.dispatch({"cmd": "amounts", "args": {"amounts": {"sa": 500, "sc": 0}}})
        got = cycle()
    finally:
        cl.subprocess.run, cl.subprocess.Popen = _real_run, _real_popen
    again = json.load(open(CFG))
    check(got == ["sa", "sc"],
          f"picked again with no venue (heartbeat older than the stop mark): ticked → {got}")
    check(again["exchanges"] == {"sa": "", "sc": ""}, f"…routed to no venue → {again['exchanges']}")
    check(not starts and not spawned, f"…no reconciler started, nothing spawned → {starts} {spawned}")
    check(os.path.exists(os.path.join(WS, "state", "HALT")), "…and the unbind's HALT still stands")

    # ── 5. this process; no start path with no venue ──────────────────────────
    mine = sorted(m for m in sys.modules if m in MONEY)
    check(not mine, f"the runtime process imported no venue module through any of the above → {mine}")
    check(not os.path.exists(B_RAN), "Type B never ran")
    cl._restart_reconciler = real_restart
    os.remove(HB)
    cl.subprocess.run = cl.subprocess.Popen = _no_spawn
    try:
        r1 = cl._restart_reconciler({})
        r2 = cl._cmd_restart_reconciler({})
        json.dump({"reason": "machine_restart", "at": 1, "down_from": 1, "down_to": 2},
                  open(cl.RESTART_STOP_PATH, "w"))
        r3 = cl._start_after_restart_stop()
    finally:
        cl.subprocess.run, cl.subprocess.Popen = _real_run, _real_popen
    check(all("no venue bound" in str(r) for r in (r1, r2, r3)) and not spawned,
          f"no venue: restart_reconciler and a start after a restart stop start nothing → {r1!r} {r3!r}")
    check(not os.path.exists(cl.RESTART_STOP_PATH), "…the user's start still lifts the restart record")
    os.chmod(ENV, 0)
    cl.subprocess.run = cl.subprocess.Popen = _no_spawn
    try:
        try:
            r4 = cl._restart_reconciler({})
        except RuntimeError as e:
            r4 = e
    finally:
        os.chmod(ENV, 0o600)
        cl.subprocess.run, cl.subprocess.Popen = _real_run, _real_popen
    check(isinstance(r4, RuntimeError) and ".env" in str(r4) and not spawned,
          f".env unreadable: restart_reconciler raises (an error ack), not a silent 'not started' → {r4!r}")
    os.rename(ENV, ENV + ".gone")
    try:
        r5 = cl._restart_reconciler({})
    finally:
        os.rename(ENV + ".gone", ENV)
    check("no venue bound" in str(r5), f"….env absent is plainly unbound, not an error → {r5!r}")

    # ── 6. desktop mode: the real tick again ───────────────────────────────────
    os.environ["BLAVE_AGENT_LOCAL"] = "1"
    open(trace, "w").close()
    for n in ("sa", "sc"):
        for p in (os.path.join(WS, "strategies", n, "state.json"), os.path.join(WS, "state", "bar_wait", n + ".json")):
            if os.path.exists(p):
                os.remove(p)
    cl._strategy_subprocess_env = lambda *a, **k: {**real_env(*a, **k), "PYTHONPATH": shim,
                                                    "SWV_TRACE": trace, "MPLBACKEND": "Agg"}
    cl._workspace_python = lambda: sys.executable
    try:
        got = cycle(real_tick=True)
    finally:
        cl._strategy_subprocess_env, cl._workspace_python = real_env, real_py
        os.environ.pop("BLAVE_AGENT_LOCAL", None)
    rows = [json.loads(l) for l in open(trace)]
    loaded = sorted({m for r in rows for m in r["mods"] if m in MONEY})
    check(got == ["sa", "sc"] and state("sa") and state("sc") and len(rows) >= 4,
          f"desktop mode, no venue: both ticked and wrote state.json ({len(rows)} processes traced)")
    check(not loaded and not any(r["net"] for r in rows) and not any(r["tw"] for r in rows),
          f"…no venue module, no socket, no BLAVE_TW_BROKER in any tick process → {loaded}")
finally:
    os.chdir(ROOT)
    shutil.rmtree(BASE, ignore_errors=True)

print("\ncheck_signals_without_venue: " + ("PASS" if not fails else f"FAILED ({fails})"))
sys.exit(1 if fails else 0)
