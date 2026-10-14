"""Windows: os.replace onto a state file loses with PermissionError (WinError 5) while another
process reads it (second Windows test machine 10-14: state/president_connect.json during 統一's
「切到測試主機」, Defender at 100% CPU). The ack came back ok:false and `busy` stayed on disk, so the
page held 「確認中…」 with no retry button.

Simulates the PermissionError by patching os.replace, so it runs on macOS/Linux too:
  ① runtime/atomic_file.replacing: a few PermissionErrors then success → lands, no temp left;
    every attempt fails → raises after the bounded retries, target unchanged, temp removed;
    another OSError → raises at once; POSIX default → one attempt (unchanged)
  ② lib/winreplace.atomic_replace: the same contract (the lib copy, separate update channel)
  ③ every lib/ and manager/ write onto a state file another process reads goes through
    atomic_replace (enumerated: a new bare os.replace onto one of them turns this red)
  ④ president_connect: a step whose status write fails for good → ack-side error raised,
    then the step-end write fails too → the lock is released at once, `busy` is cleared
    (and a section left running is failed INTERRUPTED) as soon as writes work again;
    a newer step that owns the lock by then is left alone
  ⑤ president_connect: the step-end write wins after transient failures → busy cleared inline
  ⑥ the step-end READ fails → swept in the background too (not taken for "nothing to do")
  ⑦ several failed step ends → one sweep thread, one replace attempt per round, deadline cap
  ⑧ cert stuck at importing: kept at a step's end, removed only by the killed-step sweep
  ⑨ half-updated workspace (no lib/winreplace.py): every importer loads, plain os.replace

Run: cd blave-agent && python3 tests/check_win_replace_retry.py
"""
import ast
import json
import os
import shutil
import sys
import tempfile
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TMP = tempfile.mkdtemp(prefix="check-win-replace-")
WS = os.path.join(TMP, "workspace")
for d in ("lib", "state", "manager"):
    os.makedirs(os.path.join(WS, d))
os.environ["BLAVE_AGENT_WORKSPACE"] = WS
os.environ["BLAVE_AGENT_HOME"] = os.environ["BLAVECLAW_HOME"] = TMP
os.environ.pop("BLAVE_AGENT_LOCAL", None)
sys.path.insert(0, os.path.join(ROOT, "runtime"))
sys.path.insert(0, ROOT)

import atomic_file  # noqa: E402
import president_connect as pc  # noqa: E402
from lib import winreplace  # noqa: E402

fails = []
WIN = (0.05, 0.1, 0.2, 0.4, 0.5)
real_replace = os.replace


def check(name, ok, got=None):
    print(("PASS  " if ok else "FAIL  ") + name + ("" if ok or got is None else f"  → {got!r}"))
    if not ok:
        fails.append(name)


class Flaky:
    """os.replace stand-in: the first `n` calls raise `exc`, later ones replace."""

    def __init__(self, n, exc=PermissionError):
        self.n, self.exc, self.calls = n, exc, 0

    def __call__(self, src, dst, **kw):
        self.calls += 1
        if self.calls <= self.n:
            raise self.exc(5, "Access is denied")
        return real_replace(src, dst, **kw)


def temps(d):
    return [n for n in os.listdir(d) if n.endswith(".tmp")]


def with_patch(mod, delays, flaky, fn):
    sleeps = []
    real_sleep = mod.time.sleep
    mod.REPLACE_RETRY_DELAYS, mod.time.sleep, os.replace = delays, sleeps.append, flaky
    err = None
    try:
        fn()
    except OSError as e:
        err = e
    finally:
        os.replace, mod.time.sleep = real_replace, real_sleep
    return err, sleeps


try:
    # ── ① runtime/atomic_file ──
    real_delays = atomic_file.REPLACE_RETRY_DELAYS
    d = os.path.join(TMP, "a")
    os.makedirs(d)
    f = os.path.join(d, "status.json")

    def write_new():
        with atomic_file.replacing(f, encoding="utf-8") as fh:
            fh.write("NEW")

    for label, flaky, delays in (("transient", Flaky(2), WIN), ("persistent", Flaky(99), WIN),
                                 ("other OSError", Flaky(99, FileNotFoundError), WIN),
                                 ("POSIX default", Flaky(1), ())):
        with open(f, "w") as fh:
            fh.write("OLD")
        err, sleeps = with_patch(atomic_file, delays, flaky, write_new)
        body = open(f).read()
        if label == "transient":
            check("① transient PermissionError: the write lands after two waits",
                  err is None and body == "NEW" and sleeps == [0.05, 0.1] and flaky.calls == 3,
                  (err, body, sleeps, flaky.calls))
        elif label == "persistent":
            check("① persistent PermissionError: raises after len(delays)+1 attempts (~1.25 s), target unchanged",
                  isinstance(err, PermissionError) and body == "OLD" and flaky.calls == len(WIN) + 1
                  and abs(sum(sleeps) - 1.25) < 1e-9, (err, body, flaky.calls, sleeps))
        elif label == "other OSError":
            check("① another OSError raises at once, no wait",
                  isinstance(err, FileNotFoundError) and flaky.calls == 1 and sleeps == [], (err, flaky.calls))
        else:
            check("① POSIX config: one attempt, the error surfaces as before",
                  isinstance(err, PermissionError) and flaky.calls == 1 and sleeps == [], (err, flaky.calls))
        check(f"① {label}: no temp left", temps(d) == [], temps(d))
    atomic_file.REPLACE_RETRY_DELAYS = real_delays
    check("① module default is () off Windows", os.name == "nt" or real_delays == (), real_delays)

    # ── ② lib/winreplace ──
    real_lib_delays = winreplace.REPLACE_RETRY_DELAYS
    check("② lib and runtime retry the same way", real_lib_delays == real_delays
          and (os.name != "nt" or real_lib_delays == WIN), (real_lib_delays, real_delays))
    for label, flaky, delays in (("transient", Flaky(3), WIN), ("persistent", Flaky(99), WIN),
                                 ("POSIX default", Flaky(1), ())):
        src = os.path.join(d, "x.tmp")
        with open(f, "w") as fh:
            fh.write("OLD")
        with open(src, "w") as fh:
            fh.write("NEW")
        err, sleeps = with_patch(winreplace, delays, flaky, lambda: winreplace.atomic_replace(src, f))
        body = open(f).read()
        if label == "transient":
            check("② transient: lands after three waits", err is None and body == "NEW"
                  and sleeps == [0.05, 0.1, 0.2], (err, body, sleeps))
        elif label == "persistent":
            check("② persistent: raises after the bounded attempts, target unchanged",
                  isinstance(err, PermissionError) and body == "OLD" and flaky.calls == len(WIN) + 1, (err, flaky.calls))
        else:
            check("② POSIX config: one attempt", isinstance(err, PermissionError) and flaky.calls == 1, flaky.calls)
        if os.path.exists(src):
            os.remove(src)
    winreplace.REPLACE_RETRY_DELAYS = real_lib_delays

    # ── ③ enumeration: state files other processes read go through atomic_replace ──
    MUST = {
        ("lib/execute.py", "save_state"), ("lib/execute.py", "_write_inflight_marker"),
        ("lib/guard.py", "trip_halt"), ("lib/guard.py", "trip_halt_for"),
        ("lib/portfolio.py", "_save_ledger_seed"), ("lib/portfolio.py", "_save_account_short"),
        ("lib/portfolio.py", "_report_ledger_adoption"), ("lib/portfolio.py", "_save_signal_gate"),
        ("lib/portfolio.py", "_drift_sigma"),
        ("lib/order_paper.py", "_save"), ("lib/order_president.py", "record"),
        ("lib/runner.py", "_write_json_atomic"), ("lib/validation.py", "write_mcpt_to_stats"),
        ("lib/president_worker.py", "_atomic_write"), ("lib/president_quote.py", "_atomic_write"),
        ("lib/capital_worker.py", "_write_snapshot"), ("lib/capital_worker.py", "_write_probe"),
        ("lib/capital_vault.py", "mark_order_sent"), ("lib/capital_vault.py", "_write_block"),
        ("lib/president_vault.py", "replace_json"),
        ("manager/reconciler.py", "_save_outage"), ("manager/reconciler.py", "_save_account_guard"),
        ("manager/reconciler.py", "_save_account_id_read"), ("manager/wait_for_bar.py", "_save_state"),
    }
    bare, routed = set(), set()
    for rel in sorted({m[0] for m in MUST}):
        tree = ast.parse(open(os.path.join(ROOT, rel), encoding="utf-8").read())
        for fn in ast.walk(tree):
            if not isinstance(fn, (ast.FunctionDef, ast.AsyncFunctionDef)):
                continue
            for node in ast.walk(fn):
                if not isinstance(node, ast.Call):
                    continue
                if (isinstance(node.func, ast.Attribute) and node.func.attr == "replace"
                        and isinstance(node.func.value, ast.Name) and node.func.value.id == "os"):
                    bare.add((rel, fn.name))
                elif isinstance(node.func, ast.Name) and node.func.id == "atomic_replace":
                    routed.add((rel, fn.name))
    check("③ every listed state-file writer calls atomic_replace", not sorted(MUST - routed), sorted(MUST - routed))
    check("③ none of them still calls os.replace directly", not sorted(MUST & bare), sorted(MUST & bare))

    # ── ④ president_connect: the step-end write fails, busy still clears ──
    pc.SWEEP_RETRY_S = 0.05
    atomic_file.REPLACE_RETRY_DELAYS = (0.001,) * 3
    os.replace = real_replace
    status = pc._paths()["status"]

    class D:
        def __init__(self, fn, cleanup=None):
            self.fn, self.cleanup = fn, cleanup

    def start_step(name):
        """dispatch's lock + busy write, without its broker preconditions."""
        assert pc._busy.acquire(blocking=False)
        pc._update(busy=name)
        return D(lambda: None, cleanup=pc._release_step)

    def read():
        with open(status, encoding="utf-8") as fh:
            return json.load(fh)

    def wait_for(cond, s=3.0):
        end = time.time() + s
        while time.time() < end:
            if cond():
                return True
            time.sleep(0.02)
        return cond()

    def step_body():
        pc._update("probe", status="running", reset=True, env="test")
        os.replace = Flaky(10 ** 6)          # Defender / a reader holding the file from here on
        pc._update(env="test")               # the write that failed on the test machine

    dd = start_step("president_local:host")
    dd.fn = step_body
    err = None
    try:
        dd.fn()
    except OSError as e:
        err = e
    check("④ the step's own write fails → the error reaches the ack", isinstance(err, PermissionError), err)
    dd.cleanup()                               # the step-end write fails too (still patched)
    check("④ the lock is released even though the step-end write failed",
          pc._busy.acquire(blocking=False) and (pc._busy.release() or True))
    check("④ while writes keep failing, busy is still on disk (nothing claims otherwise)",
          read().get("busy") == "president_local:host", read())
    os.replace = real_replace                  # the reader lets go
    check("④ writes work again → busy cleared without any new command",
          wait_for(lambda: read().get("busy") is None), read())
    st = read()
    check("④ the section the step left running → failed INTERRUPTED (the page shows a retry)",
          st["probe"]["status"] == "failed" and st["probe"]["error"] == "INTERRUPTED", st["probe"])
    check("④ untouched sections stay as they were", st["setup"]["status"] == "idle", st["setup"])
    check("④ no temp left in state/", temps(os.path.dirname(status)) == [], temps(os.path.dirname(status)))

    # a newer step owns the lock by the time writes work again: the sweep leaves it alone
    dd = start_step("president_local:probe")
    os.replace = Flaky(10 ** 6)
    dd.cleanup()
    assert pc._busy.acquire(blocking=False)    # the newer step
    os.replace = real_replace
    pc._update(busy="president_local:test_order")
    time.sleep(pc.SWEEP_RETRY_S * 6)
    check("④ a newer step's busy is not cleared by the old step's retry",
          read().get("busy") == "president_local:test_order", read())
    pc._update(busy=None)
    pc._busy.release()

    # ── ⑤ transient failure at step end: cleared inline, no background retry needed ──
    dd = start_step("president_local:setup")
    os.replace = Flaky(2)
    dd.cleanup()
    os.replace = real_replace
    check("⑤ step-end write wins after transient PermissionErrors → busy cleared at once",
          read().get("busy") is None, read())
    check("⑤ lock released", pc._busy.acquire(blocking=False) and (pc._busy.release() or True))

    # ── ⑥ the step-end READ fails (same contention, reader side) → not "nothing to do" ──
    import builtins
    real_open = builtins.open

    def deny_status(p, *a, **kw):
        if os.path.abspath(str(p)) == os.path.abspath(status):
            raise PermissionError(13, "Permission denied")
        return real_open(p, *a, **kw)

    dd = start_step("president_local:host")
    pc._update("probe", status="running", reset=True, env="test")
    pc.open = deny_status                      # module-level name shadows the builtin for pc only
    dd.cleanup()
    check("⑥ unreadable status at step end: lock released", pc._busy.acquire(blocking=False) and (pc._busy.release() or True))
    check("⑥ …and busy still on disk while the read keeps failing", read().get("busy") == "president_local:host", read())
    del pc.open
    check("⑥ readable again → the background sweep clears busy", wait_for(lambda: read().get("busy") is None), read())
    check("⑥ the stuck section → failed INTERRUPTED", read()["probe"]["status"] == "failed", read()["probe"])

    # ── ⑦ one sweeper at a time; it holds the lock for one replace attempt, not the backoff ──
    doc = read()
    with real_open(status, "w") as fh:
        json.dump(dict(doc, busy=None), fh)
    os.replace = Flaky(10 ** 6)
    for name in ("president_local:a", "president_local:b", "president_local:c"):
        assert pc._busy.acquire(blocking=False)
        doc = read()
        with real_open(status, "w") as fh:     # busy set by hand: writes are failing
            json.dump(dict(doc, busy=name), fh)
        pc._release_step()
    sweepers = [t for t in __import__("threading").enumerate() if t.name == "president-sweep" and t.is_alive()]
    check("⑦ three failed step ends → one sweep thread", len(sweepers) == 1, len(sweepers))
    before = os.replace.calls
    rounds = 6
    time.sleep(pc.SWEEP_RETRY_S * rounds)
    per_round = (os.replace.calls - before) / rounds
    check("⑦ background sweep: one replace attempt per round (no backoff while holding the lock)",
          0 < per_round <= 1.5, per_round)
    os.replace = real_replace
    check("⑦ writes work again → cleared", wait_for(lambda: read().get("busy") is None), read())
    check("⑦ the 5-minute cap is a deadline", hasattr(pc, "SWEEP_FOR_S") and not hasattr(pc, "SWEEP_RETRIES"))

    # ── ⑧ cert stuck at importing: a step that ran to its end keeps the pfx; a killed one drops it ──
    pfx = pc._paths()["pfx"]
    os.makedirs(os.path.dirname(pfx), exist_ok=True)

    def cert_stuck(busy):
        with real_open(pfx, "wb") as fh:
            fh.write(b"OLD-CERT-IN-USE")
        pc._update(busy=busy)
        pc._update("cert", status="importing")

    cert_stuck("president_local:cert")
    assert pc._busy.acquire(blocking=False)
    pc._release_step()                          # its own failure write failed: old cert still in use
    check("⑧ step end: cert stuck at importing → failed, the certificate in use is kept",
          read()["cert"]["status"] == "failed" and os.path.exists(pfx), (read()["cert"], os.path.exists(pfx)))
    cert_stuck("president_local:cert")          # a step killed mid-upload (runtime restart)
    pc._sweep_interrupted()
    check("⑧ sweep of a killed step: the half-imported certificate is removed (unchanged rule)",
          read()["cert"]["status"] == "failed" and not os.path.exists(pfx), (read()["cert"], os.path.exists(pfx)))

    # ── ⑨ half-updated workspace: lib/winreplace.py not landed → every importer still loads ──
    import subprocess
    hw = os.path.join(TMP, "half")
    for sub in ("lib", "manager"):
        shutil.copytree(os.path.join(ROOT, sub), os.path.join(hw, sub), ignore=shutil.ignore_patterns("__pycache__"))
    os.remove(os.path.join(hw, "lib", "winreplace.py"))
    probe = (
        "import importlib, os, sys\n"
        "sys.path.insert(0, os.getcwd())\n"
        "bad = []\n"
        "for m in ('lib.guard', 'lib.execute', 'lib.portfolio', 'lib.order_paper', 'lib.order_president',\n"
        "          'lib.runner', 'lib.validation', 'lib.president_vault', 'lib.capital_vault', 'lib.president_quote',\n"
        "          'lib.president_worker', 'lib.capital_worker', 'manager.reconciler', 'manager.wait_for_bar'):\n"
        "    try:\n"
        "        mod = importlib.import_module(m)\n"
        "    except Exception as e:\n"
        "        bad.append(f'{m}: {type(e).__name__}'); continue\n"
        "    if m != 'manager.wait_for_bar' and getattr(mod, 'atomic_replace', None) is not os.replace:\n"
        "        bad.append(f'{m}: no fallback')\n"
        "import manager.wait_for_bar as w\n"
        "w._save_state('x', {'a': 1})\n"
        "print('BAD', bad)\n")
    r = subprocess.run([sys.executable, "-c", probe], cwd=hw, capture_output=True, text=True, timeout=300)
    check("⑨ without lib/winreplace.py: all 13 importers load and fall back to os.replace, wait_for_bar still saves",
          r.returncode == 0 and "BAD []" in r.stdout
          and os.path.exists(os.path.join(hw, "state", "bar_wait", "x.json")), (r.returncode, r.stdout[-300:], r.stderr[-600:]))
finally:
    os.replace = real_replace
    shutil.rmtree(TMP, ignore_errors=True)

print()
print("ALL PASS" if not fails else f"{len(fails)} FAILED: {fails}")
sys.exit(1 if fails else 0)
