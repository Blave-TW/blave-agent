"""Machine restart = trading stopped (runtime only, no network, no systemd).

What it protects:
  1. only an OS boot stops trading: first run ever (no record) and a runtime
     restart (same boot id) do nothing; a new boot on a machine that was trading
     stops the reconciler, writes state/reconciler_stopped.json and ONE
     machine_restart_stopped event — no HALT;
  2. a new boot stops whatever reconciler came up; a machine whose reconciler
     was alive when it went down (halted included, HALT kept) gets the record
     and the event, a dead one does not; a kill that cannot be confirmed is
     retried once, then one audit.jsonl line (P3, no event) — the record stays
     and gates the survivor (tests/check_reconciler_restart_gate.py);
  3. fail-closed order: the record is written BEFORE the kill; stopped_at after
     it, so a heartbeat touched during the kill is not read as a survivor;
  4. Windows: the uptime tick (not the wall clock) tells boots apart, the record
     follows the tick while the machine runs, and the start-type correction runs
     after the stop and only ever updates an existing deployments entry;
  5. run() finishes the check before the scheduler thread or the poll loop exist;
  6. 啟動下單: only resume / resume_wait lift the stop and start the reconciler;
     a failed start fails the ack; a lone restart_reconciler is refused; the
     web's follow-up is swallowed once, and only after a resume start or a
     live survivor; "already running" = a FRESH heartbeat newer than stopped_at
     (or than detection, when the kill never confirmed);
  7. the report: stopped {reason, at} iff the record exists (fresh heartbeat or
     not), alive false meanwhile.

Run: cd blave-agent && .venv/bin/python tests/check_machine_restart_stop.py
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
BASE = tempfile.mkdtemp(prefix="restart-stop-")
# notify config = none: lib.notify here and in every child falls back to a log line, never a real Telegram
os.environ["BLAVE_AGENT_HOME"] = os.environ["BLAVECLAW_HOME"] = BASE
WS = os.path.join(BASE, "workspace")
shutil.copytree(os.path.join(ROOT, "lib"), os.path.join(WS, "lib"),
                ignore=shutil.ignore_patterns("__pycache__"))
os.makedirs(os.path.join(WS, "state", "heartbeat"))
os.makedirs(os.path.join(WS, "manager"))
GATED_RECONCILER = "RESTART_STOP_PATH = Path(guard.RESTART_STOP_PATH)\n"
open(os.path.join(WS, "manager", "reconciler.py"), "w").write(GATED_RECONCILER)
os.environ["BLAVE_AGENT_BASE"] = BASE
os.environ["BLAVE_AGENT_WORKSPACE"] = WS
os.environ.pop("BLAVE_AGENT_LOCAL", None)
os.chdir(WS)
sys.path.insert(0, os.path.join(ROOT, "runtime"))

import command_listener as cl  # noqa: E402
import portfolio_reporter  # noqa: E402

fails = 0


def check(cond, msg):
    global fails
    print(("ok   " if cond else "FAIL ") + msg)
    fails += 0 if cond else 1


STATE = os.path.join(WS, "state")
HALT = os.path.join(STATE, "HALT")
HB = os.path.join(STATE, "heartbeat", "reconciler")
EVENTS = os.path.join(STATE, "events.jsonl")
AUDIT = os.path.join(STATE, "audit.jsonl")
DEPLOY = os.path.join(STATE, "deployments.json")
T = 1_700_000_000
clock = {"t": T}
boot = {"id": "boot-a"}
stops = []
starts = []
stop_ok = {"v": True}
REAL_BOOT_MARKER = cl._boot_marker
REAL_STOP = cl._stop_reconciler
cl._boot_marker = lambda: boot["id"]
cl._clock = lambda: clock["t"]
cl._stop_reconciler = lambda: stops.append(1) or stop_ok["v"]
cl._restart_reconciler = lambda args: starts.append(1) or "reconciler restarted"
cl._uptime_s = lambda: None  # the test clock is fake; P4's check gets its own uptime below


def machine_went_down(at, trading=True, halted=False):
    """The state a machine leaves behind when it goes down at `at`."""
    cl._downtime_write_stamp(at)
    open(HB, "w").close()
    hb_at = at - 3 if trading else at - 3600
    os.utime(HB, (hb_at, hb_at))
    if halted:
        json.dump({"ts": "x", "reason": "user request", "source": "web"}, open(HALT, "w"))
    elif os.path.exists(HALT):
        os.remove(HALT)
    for p in (cl.RESTART_STOP_PATH, EVENTS, AUDIT):
        if os.path.exists(p):
            os.remove(p)
    del stops[:]
    return hb_at


def boot_check(at):
    clock["t"] = at
    return cl._machine_restart_check()


def events():
    if not os.path.exists(EVENTS):
        return []
    return [json.loads(line) for line in open(EVENTS)]


try:
    # ── 1. only an OS boot counts ────────────────────────────────────────────
    machine_went_down(T)
    check(boot_check(T + 60) is None and not stops
          and open(cl.BOOT_RECORD).read() == "boot-a",
          "first run ever (no boot record): nothing stopped, this boot recorded")
    check(boot_check(T + 90) is None and not stops,
          "runtime restart (same boot id): nothing stopped")
    hb_at = machine_went_down(T + 1000)
    boot["id"] = "boot-b"
    info = boot_check(T + 1300)
    rec = json.load(open(cl.RESTART_STOP_PATH)) if os.path.exists(cl.RESTART_STOP_PATH) else {}
    ev = events()
    check(stops == [1] and info == rec and rec.get("reason") == "machine_restart"
          and rec.get("at") == int(hb_at) and rec.get("down_from") == T + 1000
          and rec.get("down_to") == T + 1300,
          "new boot, was trading: reconciler stopped, record = {reason, at: last heartbeat, down_from, down_to}")
    check(len(ev) == 1 and ev[0]["type"] == "machine_restart_stopped"
          and ev[0]["payload"] == {"at": int(hb_at), "down_from": T + 1000,
                                   "down_to": T + 1300, "offline_s": 300},
          "…exactly one machine_restart_stopped event, with the stop interval")
    check(not os.path.exists(HALT), "…and NO HALT (a halt would still let closes out)")
    check(open(cl.BOOT_RECORD).read() == "boot-b"
          and boot_check(T + 1400) is None and stops == [1],
          "…boot recorded: the next runtime restart on this boot does nothing")

    # P4: a runtime already ran on this boot (downgrade, reboot, upgrade back)
    machine_went_down(T + 2000)
    boot["id"] = "boot-b2"
    cl._uptime_s = lambda: 600.0                    # booted at T+2400 - 600 = T+1800
    cl._downtime_write_stamp(T + 2370)              # an older runtime was alive after that
    check(boot_check(T + 2400) is None and not stops and not os.path.exists(cl.RESTART_STOP_PATH)
          and open(cl.BOOT_RECORD).read() == "boot-b2",
          "P4: boot id changed but a runtime already ran on this boot (downgrade then upgrade): "
          "recorded only — nothing stopped, no record")
    machine_went_down(T + 2500)                     # stamp from before this boot
    boot["id"] = "boot-b3"
    cl._uptime_s = lambda: 60.0                     # booted at T+2900 - 60 = T+2840
    check(boot_check(T + 2900) is not None and stops == [1],
          "…a real boot (the stamp predates it) is still judged and stopped")
    machine_went_down(T + 3000)                     # L9: back up within 60 s
    boot["id"] = "boot-b4"
    cl._uptime_s = lambda: 20.0                     # booted at T+3050 - 20 = T+3030
    cl._downtime_write_stamp(T + 3000)              # the stamp is 30 s before that boot
    check(boot_check(T + 3050) is not None and stops == [1],
          "L9: a quick reboot (stamp 30 s before the boot) is still a boot — stopped")
    cl._uptime_s = lambda: None
    os.remove(cl.RESTART_STOP_PATH)

    # ── 2. what gets stopped, what gets recorded ─────────────────────────────
    machine_went_down(T + 5000, halted=True)
    halt_before = open(HALT).read()
    boot["id"] = "boot-c"
    info = boot_check(T + 5200)
    ev = events()
    check(info is not None and stops == [1] and open(HALT).read() == halt_before
          and json.load(open(cl.RESTART_STOP_PATH))["reason"] == "machine_restart"
          and [e["type"] for e in ev] == ["machine_restart_stopped"]
          and open(cl.BOOT_RECORD).read() == "boot-c",
          "halted before the boot (reconciler alive, still closing): stopped, record + event written "
          "so the page stops claiming closes run; HALT content untouched")
    cl._resume_started_at = None
    os.makedirs("manager", exist_ok=True)
    json.dump({"amounts": {}, "exchanges": {}}, open("manager/portfolio_config.json", "w"))
    del starts[:]
    cl.dispatch({"cmd": "resume", "args": {}})
    check(not os.path.exists(HALT) and not os.path.exists(cl.RESTART_STOP_PATH) and starts == [1],
          "…啟動下單 (resume) clears both the HALT and the record, and starts the reconciler")
    cl._resume_started_at = None
    del starts[:]
    machine_went_down(T + 9000, trading=False)
    boot["id"] = "boot-d"
    check(boot_check(T + 9200) is None and stops == [1]
          and not os.path.exists(cl.RESTART_STOP_PATH) and not events(),
          "reconciler already dead before the boot: stopped if it came up, no record, no event")
    machine_went_down(T + 12000)
    os.remove(HB)
    boot["id"] = "boot-e"
    check(boot_check(T + 12200) is None and not events() and not os.path.exists(cl.RESTART_STOP_PATH),
          "reconciler never ran here: no record, no event")
    machine_went_down(T + 15000)
    boot["id"] = "boot-f"
    stop_ok["v"] = False
    info = boot_check(T + 15200)
    rec = json.load(open(cl.RESTART_STOP_PATH)) if os.path.exists(cl.RESTART_STOP_PATH) else {}
    check(info is not None and stops == [1, 1] and rec.get("reason") == "machine_restart"
          and "stopped_at" not in rec and open(cl.BOOT_RECORD).read() == "boot-f",
          "kill not confirmed: retried once; the record stays (it gates the survivor), no stopped_at")
    ev = events()
    audit = [json.loads(line) for line in open(AUDIT)] if os.path.exists(AUDIT) else []
    check([e["type"] for e in ev] == ["machine_restart_stopped"]
          and len(audit) == 1 and audit[0]["event"] == "machine_restart_stop_failed",
          "…the failed kill is P3: one audit.jsonl line, no machine_restart_stop_failed event")
    os.utime(HB, (T + 15205, T + 15205))  # the gated survivor keeps beating
    clock["t"] = T + 15210
    del starts[:]
    check(cl._start_after_restart_stop() == "reconciler already running" and not starts
          and not os.path.exists(cl.RESTART_STOP_PATH) and cl._resume_started_at is not None,
          "…啟動下單 on that machine: the gated survivor is alive — record removed (un-gates it), "
          "nothing restarted, the web's follow-up restart swallowed")
    cl._resume_started_at = None
    # B1: a survivor that died two minutes ago is not "running"
    json.dump({"reason": "machine_restart", "at": 1, "down_to": T + 15200},
              open(cl.RESTART_STOP_PATH, "w"))
    os.utime(HB, (T + 15300, T + 15300))
    clock["t"] = T + 15420
    del starts[:]
    check(cl._start_after_restart_stop() == "reconciler restarted" and starts == [1]
          and not os.path.exists(cl.RESTART_STOP_PATH),
          "heartbeat after the stop but 2 min old (survivor died, still inside the 300 s report "
          "window): 啟動下單 really starts it — 'running' means beaten within 3 poll intervals")
    cl._resume_started_at = None
    # B3: an older workspace whose reconciler has no gate
    open(os.path.join(WS, "manager", "reconciler.py"), "w").write("# old reconciler\n")
    machine_went_down(T + 16000)
    boot["id"] = "boot-f2"
    info = boot_check(T + 16200)
    ev = events()
    audit = [json.loads(line) for line in open(AUDIT)] if os.path.exists(AUDIT) else []
    check([e["type"] for e in ev] == ["machine_restart_stop_failed"]
          and ev[0]["payload"] == {"down_from": T + 16000, "down_to": T + 16200},
          "ungated workspace + kill not confirmed: ONLY machine_restart_stop_failed goes to the "
          "platform — no machine_restart_stopped saying the opposite")
    check(info is not None and os.path.exists(cl.RESTART_STOP_PATH)
          and [a.get("gated") for a in audit if a["event"] == "machine_restart_stop_failed"] == [False],
          "…the record and the audit line stay (gated: false)")
    now = time.time()
    os.utime(HB, (now - 2, now - 2))
    rep = portfolio_reporter.build_report()["reconciler"]
    check(rep["alive"] is False and rep["stopped"] and rep["stopped"]["gated"] is False,
          "…and the report says so without breaking stopped ⇒ alive:false: stopped.gated = false "
          "(ungated reconciler beating since the stop — it may be trading)")
    os.utime(HB, (T + 15990, T + 15990))
    rep = portfolio_reporter.build_report()["reconciler"]
    check(rep["stopped"]["gated"] is True,
          "ungated workspace whose reconciler has NOT beaten since the stop: gated true (nothing running)")
    os.utime(HB, (now - 2, now - 2))
    open(os.path.join(WS, "manager", "reconciler.py"), "w").write(GATED_RECONCILER)
    rep = portfolio_reporter.build_report()["reconciler"]
    check(rep["stopped"]["gated"] is False,
          "P2: gated reconciler.py on disk but the RUNNING process never proved it (no gated marker — "
          "an old process after a failed update restart): gated false")
    MARKER = os.path.join(WS, "state", "heartbeat", "reconciler.gated")
    open(MARKER, "w").close()
    os.utime(MARKER, (now - 2, now - 2))
    rep = portfolio_reporter.build_report()["reconciler"]
    check(rep["alive"] is False and rep["stopped"]["gated"] is True,
          "…the running reconciler touches the gated marker with its heartbeat: gated true, alive false "
          "(it is sending nothing)")
    os.utime(MARKER, (now - 120, now - 120))
    check(portfolio_reporter.build_report()["reconciler"]["stopped"]["gated"] is False,
          "…a marker older than the heartbeat proves nothing: gated false")
    os.remove(MARKER)
    os.remove(cl.RESTART_STOP_PATH)
    stop_ok["v"] = True
    machine_went_down(T + 18000)
    boot["id"] = None
    check(boot_check(T + 18200) is None and not stops
          and open(cl.BOOT_RECORD).read() == "boot-f2",
          "boot id unreadable: nothing judged, record untouched")
    os.environ["BLAVE_AGENT_LOCAL"] = "1"
    boot["id"] = "boot-g"
    check(boot_check(T + 18300) is None and not stops,
          "desktop app (local mode): never — it is stopped on every launch already")
    os.environ.pop("BLAVE_AGENT_LOCAL")

    # ── 3. record before the kill; stopped_at after it ───────────────────────
    hb_at = machine_went_down(T + 20000)
    boot["id"] = "boot-h"
    seen_at_kill = []

    def _slow_stop():
        # the record must already gate the reconciler when the kill starts; an
        # autostarted one touches its heartbeat while nssm stops it
        seen_at_kill.append(os.path.exists(cl.RESTART_STOP_PATH))
        clock["t"] += 30
        os.utime(HB, (clock["t"] - 5, clock["t"] - 5))
        stops.append(1)
        return True

    cl._stop_reconciler = _slow_stop
    info = boot_check(T + 20100)
    cl._stop_reconciler = lambda: stops.append(1) or stop_ok["v"]
    check(seen_at_kill == [True], "fail-closed: the record is on disk BEFORE the kill is attempted")
    check(info and info["at"] == int(hb_at) and info["down_to"] == T + 20100
          and info["stopped_at"] == T + 20130
          and json.load(open(cl.RESTART_STOP_PATH)) == info,
          "at = the pre-stop heartbeat, down_to = detection, stopped_at = after the kill")
    clock["t"] = T + 20140
    del starts[:]
    check(cl._start_after_restart_stop() == "reconciler restarted" and starts == [1],
          "a heartbeat touched DURING the kill is the killed one, not a survivor: 啟動下單 starts it")
    cl._resume_started_at = None

    # ── 4. Windows ───────────────────────────────────────────────────────────
    import ctypes
    import platform
    real_system = platform.system
    had_windll = hasattr(ctypes, "windll")
    tick = types.SimpleNamespace(ms=0)

    class _GetTickCount64:
        restype = None

        def __call__(self):
            return tick.ms

    ctypes.windll = types.SimpleNamespace(kernel32=types.SimpleNamespace(GetTickCount64=_GetTickCount64()))
    nssm = []
    registered = []
    real_nssm_run, real_sub_run = cl._nssm_run, cl.subprocess.run
    real_register = cl._register_reconciler_deployment
    try:
        platform.system = lambda: "Windows"
        cl._boot_marker = REAL_BOOT_MARKER
        cl.subprocess.run = lambda cmd, **kw: types.SimpleNamespace(returncode=0)
        cl._nssm_run = lambda step, timeout=15: nssm.append(step)
        cl._register_reconciler_deployment = lambda start_type_ok=None: registered.append(start_type_ok)
        machine_went_down(T + 30000)
        os.remove(cl.BOOT_RECORD)
        tick.ms = 60_000
        check(boot_check(T + 30010) is None and open(cl.BOOT_RECORD).read() == "win:60000",
              "Windows: first run records the uptime tick")
        tick.ms = 90_000
        check(boot_check(T + 30040) is None and not stops and open(cl.BOOT_RECORD).read() == "win:90000",
              "Windows runtime restart: tick grew = same boot (no wall clock involved), record follows it")
        tick.ms = 30 * 86_400_000

        class _OneTick(BaseException):
            pass

        real_sleep, real_dcheck = cl.time.sleep, cl._downtime_check
        cl.time.sleep = lambda s: (_ for _ in ()).throw(_OneTick())
        cl._downtime_check = lambda now=None: None
        try:
            cl._downtime_watch_loop()
        except _OneTick:
            pass
        finally:
            cl.time.sleep, cl._downtime_check = real_sleep, real_dcheck
        check(open(cl.BOOT_RECORD).read() == f"win:{30 * 86_400_000}",
              "Windows: the watch loop keeps the recorded tick current while the machine runs")
        hb_at = machine_went_down(T + 40000)
        tick.ms = 120_000  # rebooted; already past the tick of the old boot's runtime start
        info = boot_check(T + 40300)
        check(info is not None and stops == [1],
              "Windows reboot after 30 days: tick went backwards = new boot, stopped")
        check(nssm[-1] == ["set", "blaveclaw-reconciler", "Start", "SERVICE_DEMAND_START"]
              and nssm.index(nssm[-1]) >= 0,
              "Windows: every runtime start corrects the reconciler to DEMAND_START")
        order = []
        cl._stop_reconciler = lambda: order.append("stop") or True
        cl._nssm_run = lambda step, timeout=15: order.append("nssm")
        machine_went_down(T + 50000)
        tick.ms = 10_000
        boot_check(T + 50100)
        check(order == ["stop", "nssm"], "…and only after the stop (the stop is not delayed by it)")

        def _fail(step, timeout=15):
            raise RuntimeError("access denied")

        cl._nssm_run = _fail
        del registered[:]
        if os.path.exists(DEPLOY):
            os.remove(DEPLOY)
        boot_check(T + 50200)
        check(registered == [],
              "…a failed correction never registers a deliberately stopped reconciler back")
        json.dump({"reconciler": {"type": "daemon"}}, open(DEPLOY, "w"))
        boot_check(T + 50300)
        check(registered == [False],
              "…but lands on an existing entry (start_type_corrected=False)")
        os.remove(DEPLOY)
    finally:
        platform.system = real_system
        cl._boot_marker = lambda: boot["id"]
        cl._stop_reconciler = lambda: stops.append(1) or stop_ok["v"]
        cl._nssm_run, cl.subprocess.run = real_nssm_run, real_sub_run
        cl._register_reconciler_deployment = real_register
        if not had_windll:
            del ctypes.windll

    machine_went_down(T + 55000)
    open(cl.BOOT_RECORD, "w").write("win:1000")

    def _marker_with_concurrent_refresh():
        open(cl.BOOT_RECORD, "w").write("win:3000")  # another process refreshes meanwhile
        return "win:2000"

    cl._boot_marker = _marker_with_concurrent_refresh
    check(boot_check(T + 55100) is None and not stops,
          "record read before the tick: a refresh landing between the two reads is not a reboot")
    cl._boot_marker = lambda: boot["id"]

    # ── 5. run(): the check is done before anything that can trade exists ───
    machine_went_down(T + 60000)
    boot["id"] = "boot-i"
    clock["t"] = T + 60100
    seen = []

    class _Thread:
        def __init__(self, target=None, **kw):
            seen.append((getattr(target, "__name__", "?"), os.path.exists(cl.RESTART_STOP_PATH),
                         len(stops)))

        def start(self):
            pass

    class _Out(BaseException):
        pass

    def _poll():
        seen.append(("poll", os.path.exists(cl.RESTART_STOP_PATH), len(stops)))
        raise _Out

    real_thread, real_poll, real_mgmt = cl.threading.Thread, cl.poll_once, cl._resume_mgmt_watch
    cl.threading.Thread, cl.poll_once, cl._resume_mgmt_watch = _Thread, _poll, lambda: None
    cl.PROXY_TOKEN = "t"
    try:
        cl.run()
    except _Out:
        pass
    finally:
        cl.threading.Thread, cl.poll_once, cl._resume_mgmt_watch = real_thread, real_poll, real_mgmt
    sched = [s for s in seen if s[0] == "_scheduler_loop"]
    poll = [s for s in seen if s[0] == "poll"]
    check(sched and sched[0][1:] == (True, 1) and poll and poll[0][1:] == (True, 1),
          "run(): reconciler stopped and recorded before the scheduler thread is created "
          "and before the first command is polled")

    # listener start without a reboot: Windows corrects AUTO_START, Linux never calls nssm
    import ctypes
    import platform

    def _run_listener():
        cl.threading.Thread, cl.poll_once, cl._resume_mgmt_watch = _Thread, _poll, lambda: None
        try:
            cl.run()
        except _Out:
            pass
        finally:
            cl.threading.Thread, cl.poll_once, cl._resume_mgmt_watch = real_thread, real_poll, real_mgmt

    nssm_calls = []
    real_nssm_run, real_sub_run = cl._nssm_run, cl.subprocess.run
    cl._nssm_run = lambda step, timeout=15: nssm_calls.append(step)
    cl.subprocess.run = lambda cmd, **kw: types.SimpleNamespace(returncode=0)  # nssm status: installed
    had_windll, real_system = hasattr(ctypes, "windll"), platform.system
    tick_ms = {"v": 0}

    class _Tick:
        restype = None

        def __call__(self):
            return tick_ms["v"]

    try:
        machine_went_down(T + 70000)
        _run_listener()  # Linux (this box's platform, boot id unchanged)
        check(nssm_calls == [] and not stops,
              "Linux listener start: nssm never called, nothing stopped")
        ctypes.windll = types.SimpleNamespace(kernel32=types.SimpleNamespace(GetTickCount64=_Tick()))
        platform.system = lambda: "Windows"
        cl._boot_marker = REAL_BOOT_MARKER
        tick_ms["v"] = 400_000
        open(cl.BOOT_RECORD, "w").write("win:300000")  # same boot: the tick only grew
        machine_went_down(T + 71000)
        _run_listener()  # a runtime update restarting the bridges on an AUTO_START box
        check(nssm_calls == [["set", "blaveclaw-reconciler", "Start", "SERVICE_DEMAND_START"]]
              and not stops and not os.path.exists(cl.RESTART_STOP_PATH) and not events()
              and open(cl.BOOT_RECORD).read() == "win:400000",
              "Windows listener start, no reboot (runtime update): AUTO_START corrected to DEMAND_START, "
              "NOT judged a reboot — nothing stopped, no record, no event")

        def _nssm_broken(step, timeout=15):
            raise RuntimeError("access denied")

        cl._nssm_run = _nssm_broken
        del seen[:]
        tick_ms["v"] = 500_000
        _run_listener()
        check([s for s in seen if s[0] == "_scheduler_loop"] and [s for s in seen if s[0] == "poll"],
              "…a failing correction never blocks the listener: scheduler and poll loop still start")
    finally:
        platform.system = real_system
        cl._boot_marker = lambda: boot["id"]
        cl._nssm_run, cl.subprocess.run = real_nssm_run, real_sub_run
        if not had_windll:
            del ctypes.windll
    json.dump({"reason": "machine_restart", "at": 1, "down_to": T + 71000},
              open(cl.RESTART_STOP_PATH, "w"))  # section 6 starts from a restart-stopped machine

    # ── 6. 啟動下單 ──────────────────────────────────────────────────────────
    clock["t"] = time.time()
    os.makedirs("manager", exist_ok=True)
    json.dump({"amounts": {}, "exchanges": {}}, open("manager/portfolio_config.json", "w"))
    del starts[:]
    cl._resume_started_at = None
    check(cl.dispatch({"cmd": "resume", "args": {}}).endswith("reconciler restarted")
          and starts == [1] and not os.path.exists(cl.RESTART_STOP_PATH),
          "resume on a restart-stopped machine starts the reconciler (desktop cloud start) and clears the record")
    check(cl.dispatch({"cmd": "restart_reconciler", "args": {}}) == "reconciler already started by resume"
          and starts == [1],
          "…the web's follow-up restart_reconciler does not restart it a second time")
    check(cl.dispatch({"cmd": "restart_reconciler", "args": {}}) == "reconciler restarted"
          and starts == [1, 1],
          "…only that one follow-up is swallowed: the next start inside the window is a real one")
    cl._resume_started_at = time.monotonic()
    check(REAL_STOP() is True, "(real _stop_reconciler: nothing running on this dev box)")
    check(cl.dispatch({"cmd": "restart_reconciler", "args": {}}) == "reconciler restarted"
          and starts == [1, 1, 1],
          "…a stop after the resume start ends the window: the next restart is not swallowed")
    cl._stop_reconciler = lambda: stops.append(1) or stop_ok["v"]
    del starts[:]
    cl._resume_started_at = None
    check(cl.dispatch({"cmd": "resume", "args": {}}) == "resumed" and not starts,
          "resume with no restart record: exactly the old behaviour, nothing started")
    json.dump({"reason": "machine_restart"}, open(cl.RESTART_STOP_PATH, "w"))
    cl._restart_reconciler = lambda args: (_ for _ in ()).throw(RuntimeError("sudo rc=1 no rule"))
    try:
        cl.dispatch({"cmd": "resume_wait", "args": {}})
        failed = ""
    except RuntimeError as e:
        failed = str(e)
    check("did not start" in failed and "sudo rc=1 no rule" in failed
          and os.path.exists(cl.RESTART_STOP_PATH) and cl._resume_started_at is None,
          "resume_wait whose start fails: the ack FAILS with the reason; record kept")
    cl._restart_reconciler = lambda args: starts.append(1) or "reconciler restarted"
    del starts[:]
    try:
        cl.dispatch({"cmd": "restart_reconciler", "args": {}})
        refused = False
    except RuntimeError as e:
        refused = "啟動下單" in str(e)
    check(refused and not starts and os.path.exists(cl.RESTART_STOP_PATH),
          "restart_reconciler alone (settings 重啟, a turn, any other path) cannot lift the "
          "restart stop: refused, nothing started, record kept")
    check(cl.dispatch({"cmd": "resume_wait", "args": {}}).endswith("reconciler restarted")
          and starts == [1] and not os.path.exists(cl.RESTART_STOP_PATH),
          "…the user's 啟動下單 (resume_wait) retried: started, record cleared")
    del starts[:]
    cl._resume_started_at = None
    now = time.time()
    json.dump({"reason": "machine_restart", "down_to": int(now) - 3600}, open(cl.RESTART_STOP_PATH, "w"))
    os.utime(HB, (now - 1800, now - 1800))
    check(cl.dispatch({"cmd": "resume", "args": {}}).endswith("reconciler restarted")
          and starts == [1] and not os.path.exists(cl.RESTART_STOP_PATH),
          "heartbeat newer than the boot but STALE (started outside the button, then died): "
          "resume starts it")
    del starts[:]
    cl._resume_started_at = None
    json.dump({"reason": "machine_restart", "down_to": int(now) - 3600}, open(cl.RESTART_STOP_PATH, "w"))
    os.utime(HB, (now - 5, now - 5))
    check(cl.dispatch({"cmd": "resume", "args": {}}).endswith("reconciler already running")
          and not starts and not os.path.exists(cl.RESTART_STOP_PATH),
          "fresh heartbeat newer than the boot (running): not restarted mid-round, record cleared")
    del starts[:]
    cl._resume_started_at = None
    t_frac = int(time.time()) - 3 + 0.9  # the stop finished at .9 of a second
    clock["t"] = t_frac
    json.dump({"reason": "machine_restart", "down_to": int(t_frac)}, open(cl.RESTART_STOP_PATH, "w"))
    os.utime(HB, (int(t_frac) + 0.7, int(t_frac) + 0.7))  # last beat in that same second
    clock["t"] = time.time()
    check(cl.dispatch({"cmd": "resume", "args": {}}).endswith("reconciler restarted")
          and starts == [1] and not os.path.exists(cl.RESTART_STOP_PATH),
          "fractional clock: a heartbeat in the same second as down_to is the stop, not a new start "
          "— resume starts the reconciler (same int comparison as the report)")
    rec_hb = portfolio_reporter._mtime(HB)
    json.dump({"reason": "machine_restart", "down_to": int(t_frac)}, open(cl.RESTART_STOP_PATH, "w"))
    check(portfolio_reporter.restart_stop(portfolio_reporter._mtime(HB)) is not None,
          "…and the report agrees: still stopped")
    os.remove(cl.RESTART_STOP_PATH)
    # B4: a record that cannot be removed fails the start — the reconciler would stay gated
    real_remove = cl.os.remove

    def _locked(path, *a, **k):
        if path == cl.RESTART_STOP_PATH:
            raise PermissionError("locked by antivirus")
        return real_remove(path, *a, **k)

    for label, hb_age in (("start path", 1800), ("already-running path", 2)):
        del starts[:]
        cl._resume_started_at = None
        now = time.time()
        json.dump({"reason": "machine_restart", "down_to": int(now) - 3600},
                  open(cl.RESTART_STOP_PATH, "w"))
        os.utime(HB, (now - hb_age, now - hb_age))
        cl.os.remove = _locked
        try:
            cl.dispatch({"cmd": "resume", "args": {}})
            failed = ""
        except RuntimeError as e:
            failed = str(e)
        finally:
            cl.os.remove = real_remove
        check("could not be removed" in failed and os.path.exists(cl.RESTART_STOP_PATH)
              and cl._resume_started_at is None,
              f"record cannot be removed ({label}): resume FAILS (the reconciler would stay gated), "
              "web follow-up not swallowed")
        os.remove(cl.RESTART_STOP_PATH)
    del starts[:]
    cl._resume_started_at = None
    json.dump({"reason": "machine_restart"}, open(cl.RESTART_STOP_PATH, "w"))
    open(HALT, "w").write("{}")
    real_dl = cl._downtime_lib
    decided = []
    cl._downtime_lib = lambda optional=False: types.SimpleNamespace(
        decide=lambda names, how: decided.append((names, how)) or names)
    try:
        r = cl.dispatch({"cmd": "resume", "args": {"strategies": ["x"]}})
    finally:
        cl._downtime_lib = real_dl
    check(decided == [(["x"], "sync")] and not starts and os.path.exists(cl.RESTART_STOP_PATH)
          and os.path.exists(HALT) and "reconciler" not in r,
          "per-strategy resume (strategies set) does NOT lift the restart stop: no start, record kept")
    os.remove(cl.RESTART_STOP_PATH)
    os.remove(HALT)

    # ── 7. the report ────────────────────────────────────────────────────────
    hb_at = machine_went_down(int(time.time()) - 60)
    boot["id"] = "boot-j"
    boot_check(int(time.time()))
    rep = portfolio_reporter.build_report()["reconciler"]
    check(rep["alive"] is False
          and rep["stopped"] == {"reason": "machine_restart", "at": int(hb_at), "gated": True,
                                 "recomputed": True},
          "report while stopped: alive false (the pre-boot heartbeat is still fresh), stopped {reason, at}")
    later = json.load(open(cl.RESTART_STOP_PATH))["down_to"] + 30
    os.utime(HB, (later, later))
    rep = portfolio_reporter.build_report()["reconciler"]
    check(rep["stopped"] is not None and rep["alive"] is False,
          "a FRESH heartbeat newer than the boot (a gated reconciler still beats): still shown stopped, "
          "alive false — the record alone decides")
    stale = time.time() - 1800
    rec = json.load(open(cl.RESTART_STOP_PATH))
    rec["down_to"] = int(stale) - 600
    json.dump(rec, open(cl.RESTART_STOP_PATH, "w"))
    os.utime(HB, (stale, stale))
    rep = portfolio_reporter.build_report()["reconciler"]
    check(rep["stopped"] is not None and rep["alive"] is False,
          "a STALE heartbeat newer than the boot (started outside the button, died): still shown stopped")
    os.remove(cl.RESTART_STOP_PATH)
    check(portfolio_reporter.build_report()["reconciler"]["stopped"] is None,
          "no record: stopped null")

    # ── 8. small ones ────────────────────────────────────────────────────────
    json.dump({"ts": "2026-01-01T00:00:00+00:00", "reason": "x", "source": "web"}, open(HALT, "w"))
    with open(AUDIT, "w") as f:
        for ev, intent in (("order_denied_halt", "entry"), ("order_denied_restart", "entry"),
                           ("order_denied_restart", "reduce")):
            f.write(json.dumps({"ts": "2026-02-01T00:00:00+00:00", "event": ev, "intent": intent}) + "\n")
    check(portfolio_reporter.halt_state()["blocked"] == 2,
          "HALT + restart record: an entry the restart gate refused first still counts as blocked "
          "by the halt (closes do not)")
    os.remove(HALT)
    os.remove(AUDIT)
    refreshed = []

    class _OneTick(BaseException):
        pass

    real_dc, real_rb, real_sleep = cl._downtime_check, cl._refresh_boot_record, cl.time.sleep
    cl._downtime_check = lambda now=None: (_ for _ in ()).throw(RuntimeError("downtime check broke"))
    cl._refresh_boot_record = lambda: refreshed.append(1)
    cl.time.sleep = lambda s_: (_ for _ in ()).throw(_OneTick())
    try:
        cl._downtime_watch_loop()
    except _OneTick:
        pass
    finally:
        cl._downtime_check, cl._refresh_boot_record, cl.time.sleep = real_dc, real_rb, real_sleep
    check(refreshed == [1], "a failing downtime check does not stop the Windows boot-tick refresh")

    # ── 8b. 1-4: Type A/C keep computing during the stop ─────────────────────
    # The reconciler trades Type A/C state.json. Those strategies are ticked by
    # the runtime's own scheduler (wait_for_bar), which the stop does not gate,
    # so a 補齊部位 after 啟動下單 trades on signals refreshed since the boot —
    # not on the pre-restart ones (only Type B, which the reconciler never
    # trades, is skipped).
    shutil.copy(os.path.join(ROOT, "manager", "wait_for_bar.py"), os.path.join(WS, "manager"))
    cl._ac_migration_done = True  # never let a test touch this computer's crontab
    os.makedirs(os.path.join(WS, "strategies", "sa"), exist_ok=True)
    open(os.path.join(WS, "strategies", "sa", "strategy.py"), "w").write('INTERVAL = "1h"\n')
    json.dump({"amounts": {"sa": 100}, "exchanges": {"sa": "binance"}},
              open(os.path.join(WS, "manager", "portfolio_config.json"), "w"))
    json.dump({"reason": "machine_restart"}, open(cl.RESTART_STOP_PATH, "w"))
    ticked = []
    real_tick, real_bound = cl._tick_one, cl._bound_venue
    real_sync, real_prune = cl._sync_deployment_registry, cl._prune_deployment_registry
    cl._tick_one = lambda name: ticked.append(name)
    cl._bound_venue = lambda: True
    cl._sync_deployment_registry = cl._prune_deployment_registry = lambda names: None
    try:
        cl._run_scheduler_cycle()
        for _ in range(50):
            if ticked:
                break
            time.sleep(0.02)
    finally:
        cl._tick_one, cl._bound_venue = real_tick, real_bound
        cl._sync_deployment_registry, cl._prune_deployment_registry = real_sync, real_prune
        os.remove(cl.RESTART_STOP_PATH)
    check(ticked == ["sa"],
          "restart record present: the scheduler still ticks Type A/C strategies (signals keep "
          "refreshing), so 補齊部位 after 啟動下單 trades on post-boot signals")

    # ── 8c. stopped.recomputed: may 補齊部位 trade current signals yet? ─────
    from datetime import datetime as _dt, timedelta as _td
    down_to = int(time.time()) - 300
    boot = _dt(1970, 1, 1) + _td(seconds=down_to)
    bar_1h = (_dt(1970, 1, 1) + ((boot - _dt(1970, 1, 1)) // _td(hours=1)) * _td(hours=1)
              - _td(hours=1))  # the 1h bar that had just closed when the machine came back
    for n_ in ("ra", "rb"):
        os.makedirs(os.path.join(WS, "strategies", n_), exist_ok=True)
        open(os.path.join(WS, "strategies", n_, "strategy.py"), "w").write('INTERVAL = "1h"\n')
    shutil.copy(os.path.join(ROOT, "manager", "wait_for_bar.py"), os.path.join(WS, "manager"))
    os.makedirs(os.path.join(WS, "state", "bar_wait"), exist_ok=True)
    env_path = os.path.join(WS, ".env")
    open(env_path, "w").write("BINANCE_API_KEY=x\nBINANCE_SECRET_KEY=y\n")
    json.dump({"reason": "machine_restart", "at": 1, "down_to": down_to}, open(cl.RESTART_STOP_PATH, "w"))

    def bar_wait(name, processed, seen=None, mtime=None):
        p_ = os.path.join(WS, "state", "bar_wait", f"{name}.json")
        json.dump({"last_processed_bar": processed.isoformat() if processed else None,
                   "last_seen_bar": seen.isoformat() if seen else None}, open(p_, "w"))
        if mtime is not None:
            os.utime(p_, (mtime, mtime))

    def recomputed(amounts):
        json.dump({"amounts": amounts, "exchanges": {k: "binance" for k in amounts}},
                  open(os.path.join(WS, "manager", "portfolio_config.json"), "w"))
        return portfolio_reporter.build_report()["reconciler"]["stopped"]["recomputed"]

    bar_wait("ra", bar_1h)
    bar_wait("rb", bar_1h - _td(hours=1), mtime=down_to - 60)
    check(recomputed({"ra": 100, "rb": 100}) is False,
          "one funded Type A/C strategy still on the bar before the boot's last closed bar: recomputed false")
    bar_wait("rb", bar_1h)
    check(recomputed({"ra": 100, "rb": 100}) is True,
          "every funded Type A/C strategy processed the bar that had just closed at boot: recomputed true "
          "(the literal 'processed bar ≥ boot time' would wait up to two bars — a bar is labelled by its open)")
    check(recomputed({}) is True, "no funded Type A/C strategy (empty set): recomputed true")
    bar_wait("rb", bar_1h - _td(hours=1))
    check(recomputed({"ra": 100, "rb": 0}) is True,
          "an unfunded strategy does not count (the reconciler trades nothing of it)")
    open(os.path.join(WS, "strategies", "rb", "strategy.py"), "w").write("# Type B, no INTERVAL\n")
    check(recomputed({"ra": 100, "rb": 100}) is True, "a Type B strategy does not count either")
    open(os.path.join(WS, "strategies", "rb", "strategy.py"), "w").write('INTERVAL = "1h"\n')
    bar_wait("rb", bar_1h - _td(hours=1), seen=bar_1h - _td(hours=1), mtime=down_to + 60)
    check(recomputed({"ra": 100, "rb": 100}) is True,
          "market closed / data stalled: a post-boot check found nothing newer than it processed — current")
    bar_wait("rb", bar_1h - _td(hours=1), seen=bar_1h - _td(hours=1), mtime=down_to - 60)
    check(recomputed({"ra": 100, "rb": 100}) is False,
          "…but the same file untouched since before the boot proves nothing: still false")
    os.remove(os.path.join(WS, "state", "bar_wait", "rb.json"))
    check(recomputed({"ra": 100, "rb": 100}) is False, "a strategy with no bar_wait record yet: false")
    # a record without down_to (old / hand-made): the record's own mtime stands in for the boot
    bar_wait("ra", bar_1h)
    bar_wait("rb", bar_1h)
    json.dump({"reason": "machine_restart"}, open(cl.RESTART_STOP_PATH, "w"))
    os.utime(cl.RESTART_STOP_PATH, (down_to, down_to))
    check(recomputed({"ra": 100, "rb": 100}) is True,
          "record with no down_to: falls back to the record's mtime — can still turn true")
    bar_wait("rb", bar_1h - _td(hours=1), mtime=down_to - 60)
    check(recomputed({"ra": 100, "rb": 100}) is False,
          "…and still false while a strategy has not caught up")
    json.dump({"reason": "machine_restart", "at": 1, "down_to": down_to}, open(cl.RESTART_STOP_PATH, "w"))
    # R4: a post-boot check that SAW a newer bar it has not processed is not "caught up"
    bar_wait("rb", bar_1h - _td(hours=1), seen=bar_1h, mtime=down_to + 60)
    check(recomputed({"ra": 100, "rb": 100}) is False,
          "R4: post-boot check saw a newer bar than it processed (still pending): false")
    # B1: the first post-boot check FAILED — the real wait_for_bar._tick flow
    shutil.copy(os.path.join(ROOT, "manager", "alert_failure.py"), os.path.join(WS, "manager"))
    open(os.path.join(WS, "strategies", "rb", "strategy.py"), "w").write(
        'INTERVAL = "1h"\n\ndef fetch_data(*a, **k):\n    raise RuntimeError("feed down")\n')
    six_ago = bar_1h - _td(hours=6)
    bar_wait("rb", six_ago, seen=six_ago, mtime=down_to - 3600)
    tick = subprocess.run([sys.executable, "manager/wait_for_bar.py", "rb"], cwd=WS,
                          capture_output=True, text=True, timeout=120,
                          env={**os.environ, "BLAVE_AGENT_WORKSPACE": WS,
                               "BLAVE_AGENT_HOME": BASE, "BLAVECLAW_HOME": BASE})
    st_rb = json.load(open(os.path.join(WS, "state", "bar_wait", "rb.json")))
    check(isinstance(st_rb.get("last_attempt_failed_at"), (int, float))
          and st_rb["last_attempt_failed_at"] > down_to
          and os.path.getmtime(os.path.join(WS, "state", "bar_wait", "rb.json")) > down_to
          and st_rb.get("last_seen_bar") == six_ago.isoformat(),
          f"(real wait_for_bar._tick after the boot: fetch failed, file saved, last_seen_bar untouched) "
          f"{tick.returncode}")
    check(recomputed({"ra": 100, "rb": 100}) is False,
          "B1: the first post-boot check failed (processed = seen = 6 bars ago) — NOT caught up: false")
    st_rb["last_attempt_failed_at"] = down_to - 86400  # a failure from days before the boot
    json.dump(st_rb, open(os.path.join(WS, "state", "bar_wait", "rb.json"), "w"))
    check(recomputed({"ra": 100, "rb": 100}) is True,
          "…a failure from before the boot does not disable the stalled-market rule")
    # B1c: the other failure field — wait_for_bar's wrapper-error path (the strategy cannot even load)
    open(os.path.join(WS, "strategies", "rb", "strategy.py"), "w").write(
        'INTERVAL = "1h"\nimport nonexistent_module_for_the_test\n')
    bar_wait("rb", six_ago, seen=six_ago, mtime=down_to - 3600)
    subprocess.run([sys.executable, "manager/wait_for_bar.py", "rb"], cwd=WS,
                   capture_output=True, text=True, timeout=120,
                   env={**os.environ, "BLAVE_AGENT_WORKSPACE": WS,
                        "BLAVE_AGENT_HOME": BASE, "BLAVECLAW_HOME": BASE})
    st_rb = json.load(open(os.path.join(WS, "state", "bar_wait", "rb.json")))
    check(isinstance(st_rb.get("wrapper_error_alerted_at"), (int, float))
          and st_rb["wrapper_error_alerted_at"] > down_to and not st_rb.get("last_attempt_failed_at")
          and recomputed({"ra": 100, "rb": 100}) is False,
          "B1c: the strategy failed to even load after the boot (real wait_for_bar wrapper-error path, "
          "wrapper_error_alerted_at only): NOT caught up — false")
    # B2a: an INTERVAL too large for a timedelta is skipped like a Type B, never an exception
    open(os.path.join(WS, "strategies", "rb", "strategy.py"), "w").write('INTERVAL = "99999999999999999999h"\n')
    check(recomputed({"ra": 100, "rb": 100}) is True,
          "B2a: an overflowing INTERVAL is not a Type A/C interval — skipped, true, no exception")
    open(os.path.join(WS, "strategies", "rb", "strategy.py"), "w").write('INTERVAL = "1h"\n')
    # R13: a workspace without wait_for_bar.py schedules no Type A/C — nothing to wait for
    bar_wait("rb", bar_1h - _td(hours=1), mtime=down_to - 60)
    os.remove(os.path.join(WS, "manager", "wait_for_bar.py"))
    check(recomputed({"ra": 100, "rb": 100}) is True,
          "R13: no manager/wait_for_bar.py (old workspace): true — 補齊 is never greyed out for ever")
    shutil.copy(os.path.join(ROOT, "manager", "wait_for_bar.py"), os.path.join(WS, "manager"))
    # B2: a broken INTERVAL / config never costs the report
    open(os.path.join(WS, "strategies", "rb", "strategy.py"), "w").write('INTERVAL = "0m"\n')
    check(recomputed({"ra": 100, "rb": 100}) is True,
          "B2: INTERVAL \"0m\" is not a Type A/C interval (no division by zero), the report still builds")
    open(os.path.join(WS, "strategies", "rb", "strategy.py"), "w").write('INTERVAL = "1h"\n')
    real_rs = portfolio_reporter._recomputed_since
    portfolio_reporter._recomputed_since = lambda *a, **k: 1 // 0
    try:
        rep_b2 = portfolio_reporter.build_report()["reconciler"]["stopped"]
    finally:
        portfolio_reporter._recomputed_since = real_rs
    check(rep_b2 is not None and rep_b2["recomputed"] is False,
          "B2: any exception in the check → recomputed false, the report is still sent")
    os.remove(os.path.join(WS, "state", "bar_wait", "rb.json"))
    os.remove(env_path)
    check(recomputed({"ra": 100, "rb": 100}) is True,
          "no bound venue: the scheduler never runs, so the flag would stay false for ever — true "
          "(nothing can trade either; the reconciler idles)")
    os.remove(cl.RESTART_STOP_PATH)
    for n_ in ("ra", "rb"):
        shutil.rmtree(os.path.join(WS, "strategies", n_))
    shutil.rmtree(os.path.join(WS, "state", "bar_wait"))

    # ── 9. Type B with its own .env keys, nothing bound on the web ──────────
    json.dump({"amounts": {}, "exchanges": {}}, open(os.path.join(WS, "manager", "portfolio_config.json"), "w"))
    json.dump({"ids": []}, open(os.path.join(WS, "manager", "credentials.ui.json"), "w"))
    open(os.path.join(WS, ".env"), "w").write("BINANCE_API_KEY=typeb\nBINANCE_SECRET_KEY=typeb\n")
    json.dump({"reason": "machine_restart", "at": 1, "down_to": 2}, open(cl.RESTART_STOP_PATH, "w"))
    del starts[:]
    cl._resume_started_at = None
    r1 = cl.dispatch({"cmd": "resume", "args": {}})
    r2 = cl.dispatch({"cmd": "restart_reconciler", "args": {}})
    check(not os.path.exists(cl.RESTART_STOP_PATH) and starts == [1]
          and r1.endswith("reconciler restarted") and r2 == "reconciler already started by resume",
          "no venue bound, Type B on its own .env keys: web resume clears the record and starts the "
          "reconciler once; the follow-up restart_reconciler is swallowed, not refused")
    import lib.order_binance as ob  # the workspace copy, as a Type B strategy imports it
    sent_b = []
    real_send_b = ob._send
    ob._send = lambda *a, **k: sent_b.append(a) or {}
    try:
        ob._request("POST", "/fapi/v1/order", {}, {"symbol": "BTCUSDT", "side": "BUY", "type": "MARKET"})
        ob._request("POST", "/fapi/v1/order", {}, {"symbol": "BTCUSDT", "side": "SELL", "type": "MARKET",
                                                   "reduceOnly": "true"})
    finally:
        ob._send = real_send_b
    check(len(sent_b) == 2, "…and the Type B strategy's own lib/order_* entry and close go through again")
    for f_ in (".env", "manager/credentials.ui.json"):
        os.remove(os.path.join(WS, f_))
finally:
    os.chdir(ROOT)
    shutil.rmtree(BASE, ignore_errors=True)

print("\nFAILED" if fails else "\nall ok")
sys.exit(1 if fails else 0)
