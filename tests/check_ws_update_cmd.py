"""`workspace_update` — the desktop's 更新雲端主機 as a machine command (runtime/ws_update.py,
command_listener; spec .claude/output/specs/cloud-workspace-update-command-0160.md §2, §9.1).

No network: the official repo is a local git repo built here (two commits, the real
manager/update_workspace.py), ws_update.REPO is patched in-process to point at it, and the clone
gets the official origin URL set after cloning (update_workspace's origin check, the same trick
tests/check_update_workspace.py uses). systemctl / sudo / tmux are fakes on PATH.

  1. args → ValueError; local mode → LOCAL_MODE; no git → NO_GIT; nothing written.
  2. single flight: a live job → UPDATE_RUNNING; a dead one → runs.
  3. lock held by another update → UPDATE_RUNNING, the status file byte-for-byte untouched (M2).
  4. applying is on disk when start() returns (before the ack).
  5. Popen fails → failed start_failed; job file unwritable → child killed, failed start_failed (M4).
  6. anchor: ls-remote ≠ clone HEAD → once more; twice → failed anchor_mismatch, no plan/apply.
  7. clone fails / times out → failed fetch_failed, temp dir gone.
  8. end to end with the real script: changed_here → --allow, --restart-ok, --wait-busy 600 every
     time, no --allow when empty; done/updated, VERSION written, job file and clone gone.
  9. M1 end to end: first apply restart_deferred(busy) → status back to applying (restart_retry)
     before the second plan; second apply without the first --allow → updated. Mutation: reusing
     the first --allow makes the run end failed.
 9b. 永豐 worker busy (sinopac_worker busy, reconciler restart ok / none) → the same one retry;
     reconciler refused + 永豐 busy, or 永豐 failed → no retry.
 10. apply answers locked → ws_update writes nothing after it (M2).
 11. listener restart: live job adopted; dead job + applying + lock free → failed interrupted;
     dead job + lock held → status untouched; job file removed either way; stale clones swept.
 12. UPDATE_RUNNING: resume / resume_wait (with and without strategies) / restart_reconciler are
     refused while a job runs or the lock is held; halt / close_all / downtime_hold go through.
 12a. apply timeout (first or retry) → failed, outcome error, reason apply_timeout (R1); run_tree
     kills the whole tree and confirms it.
 13. the report carries can_ws_update: True.
 14. mutation: drop the anchor comparison → the mismatch case stops being caught.
 15. contract: the CLI and JSON fields ws_update relies on are still in update_workspace.py.

Run: cd blave-agent && .venv/bin/python tests/check_ws_update_cmd.py
"""
import fcntl
import importlib.util
import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RUNTIME = os.path.join(ROOT, "runtime")
SCRIPT_SRC = os.path.join(ROOT, "manager", "update_workspace.py")
BASE = tempfile.mkdtemp(prefix="ws-update-cmd-")
os.environ.update({"BLAVE_AGENT_HOME": BASE, "BLAVECLAW_HOME": BASE, "BLAVE_AGENT_BASE": BASE,
                   "BLAVE_AGENT_WORKSPACE": os.path.join(BASE, "ws0"),
                   "BLAVE_AGENT_STATE": os.path.join(BASE, "state")})
os.environ.pop("BLAVE_AGENT_LOCAL", None)
os.environ.pop("BLAVE_PROXY_TOKEN", None)
sys.path.insert(0, RUNTIME)
import ws_update as W  # noqa: E402
import command_listener as cl  # noqa: E402

TEST_PREFIX = f"blave-wsupd-test{os.getpid()}-"
W.TMP_PREFIX = TEST_PREFIX
fails = 0


def check(cond, msg):
    global fails
    print(("ok   " if cond else "FAIL ") + msg)
    fails += 0 if cond else 1


GIT_ENV = {"PATH": "/usr/bin:/bin", "HOME": BASE, "GIT_CONFIG_GLOBAL": os.devnull,
           "GIT_CONFIG_NOSYSTEM": "1", "GIT_AUTHOR_NAME": "t", "GIT_AUTHOR_EMAIL": "t@t",
           "GIT_COMMITTER_NAME": "t", "GIT_COMMITTER_EMAIL": "t@t"}


def g(repo, *args):
    return subprocess.run(["git", "-C", repo, *args], env=GIT_ENV, capture_output=True,
                          text=True, check=True).stdout.strip()


def write(path, text):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as f:
        f.write(text)


def read(path):
    with open(path) as f:
        return f.read()


def make_official():
    repo = tempfile.mkdtemp(prefix="official-", dir=BASE)
    subprocess.run(["git", "init", "-q", repo], env=GIT_ENV, check=True)
    write(os.path.join(repo, "lib/data.py"), "v = 1\n")
    write(os.path.join(repo, "manager/reconciler.py"), "RESTART_STOP_PATH = 'x'\n")
    write(os.path.join(repo, "AGENTS.md"), "agents v1\n")
    write(os.path.join(repo, "VERSION"), "2026-09-01-a\n")
    shutil.copy(SCRIPT_SRC, os.path.join(repo, "manager/update_workspace.py"))
    g(repo, "add", "-A")
    g(repo, "commit", "-qm", "v1")
    v1 = g(repo, "rev-parse", "HEAD")
    write(os.path.join(repo, "lib/data.py"), "v = 2\n")
    write(os.path.join(repo, "references/a.md"), "ref\n")
    write(os.path.join(repo, "VERSION"), "2026-09-23-b\n")
    g(repo, "add", "-A")
    g(repo, "commit", "-qm", "v2")
    return repo, v1


def make_workspace(repo, v1):
    ws = tempfile.mkdtemp(prefix="ws-", dir=BASE)
    tar = subprocess.run(["git", "-C", repo, "archive", v1], env=GIT_ENV, capture_output=True,
                         check=True).stdout
    subprocess.run(["tar", "-x", "-C", ws], input=tar, check=True)
    os.remove(os.path.join(ws, "manager/update_workspace.py"))
    write(os.path.join(ws, "AGENTS.md"), "agents — edited on this machine\n")  # changed here
    os.makedirs(os.path.join(ws, "state"), exist_ok=True)
    return os.path.realpath(ws)


BIN = os.path.join(BASE, "bin")
STATE_F = os.path.join(BASE, "unit_state")
SUDO_LOG = os.path.join(BASE, "sudo.log")
write(os.path.join(BIN, "systemctl"), f'#!/bin/sh\ncat "{STATE_F}"\n')
write(os.path.join(BIN, "sudo"), f'#!/bin/sh\necho "$@" >> "{SUDO_LOG}"\nexit 0\n')
write(os.path.join(BIN, "tmux"), "#!/bin/sh\nexit 1\n")
for n in ("systemctl", "sudo", "tmux"):
    os.chmod(os.path.join(BIN, n), 0o755)
os.environ["PATH"] = BIN + os.pathsep + os.environ.get("PATH", "")


def unit(state):
    write(STATE_F, state + "\n")


REAL = {"clone": W.clone, "ls_remote": W.ls_remote, "run_tree": W.run_tree, "clone_head": W.clone_head,
        "child_argv": W._child_argv, "kill_tree": W.kill_tree, "plan_allow": W.plan_allow}


def restore():
    """Back to the baseline: real functions, except the clone that gets the official origin."""
    W.clone, W.ls_remote, W.run_tree, W.clone_head = (official_clone, REAL["ls_remote"], REAL["run_tree"],
                                                      REAL["clone_head"])
    W._child_argv, W.kill_tree, W.plan_allow = REAL["child_argv"], REAL["kill_tree"], REAL["plan_allow"]
    W.WAIT_BUSY_S = 600


def official_clone(dest):
    REAL["clone"](dest)
    g(dest, "remote", "set-url", "origin", "https://github.com/Blave-TW/blave-agent")


def status(ws):
    p = os.path.join(ws, "state", "workspace_update.json")
    return json.loads(read(p)) if os.path.exists(p) else None


def test_tmps():
    return [n for n in os.listdir(tempfile.gettempdir()) if n.startswith(TEST_PREFIX)]


def hold_lock(ws):
    fh = open(os.path.join(ws, "state", "workspace_update.lock"), "a+b")
    fcntl.flock(fh.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
    return fh


def sleeper(seconds, tag="ws_update.py"):
    """A live process whose command line names the script (the job's identity check)."""
    return subprocess.Popen([sys.executable, "-c", "import sys, time; time.sleep(float(sys.argv[1]))",
                             str(seconds), tag])


def raises(fn, *a):
    try:
        fn(*a)
    except Exception as e:  # noqa: BLE001
        return f"{type(e).__name__}: {e}"
    return None


pushes = []


def start(ws, args=None, local=False):
    return W.start({} if args is None else args, ws, local, "cid1", cl._pid_cmdline_or_none, cl._child_kw,
                   lambda: pushes.append(1))


procs = []
try:
    repo, v1 = make_official()
    W.REPO = repo
    W.clone = official_clone
    unit("inactive")

    # ── 1. shapes, local mode, no git ──
    ws = make_workspace(repo, v1)
    for bad in ({"ref": "main"}, {"allow": []}, ["x"]):
        e = raises(start, ws, bad)
        check(e and e.startswith("ValueError: workspace_update takes no arguments") and status(ws) is None,
              f"1 args {bad!r} → ValueError, nothing written")
    e = raises(start, ws, {}, True)
    check(e and "LOCAL_MODE" in e and status(ws) is None, "1 local mode → LOCAL_MODE, nothing written")
    real_which = W.git_path
    W.git_path = lambda: None
    e = raises(start, ws)
    W.git_path = real_which
    check(e and "NO_GIT" in e and status(ws) is None, "1 no git → NO_GIT, nothing written")
    e = raises(cl.dispatch, {"cmd": "workspace_update", "args": {"x": 1}, "id": "c"})
    check(e and "takes no arguments" in e, "1 through dispatch: the same refusal")

    # ── 2–4. single flight, lock, applying before the ack ──
    live = sleeper(30)
    procs.append(live)
    write(os.path.join(ws, W.JOB_REL), json.dumps({"pid": live.pid, "started_at": 1, "cmd_id": "x"}))
    e = raises(start, ws)
    check(e and "UPDATE_RUNNING" in e and status(ws) is None, "2 a live job → UPDATE_RUNNING, nothing written")
    other = sleeper(30, tag="something_else.py")
    procs.append(other)
    write(os.path.join(ws, W.JOB_REL), json.dumps({"pid": other.pid, "started_at": 1, "cmd_id": "x"}))
    W._child_argv = lambda w, c: [sys.executable, "-c", "import time; time.sleep(3)", "ws_update.py"]
    r = start(ws)
    st = status(ws)
    check(r == "started" and st and st["state"] == "applying" and st["phase"] == "fetch" and st["to"] is None
          and st["from"] == "2026-09-01-a" and isinstance(st["ts"], int),
          f"2 a pid that is not ws_update (reused) is no job → started; 4 applying already on disk ({st})")
    job = json.loads(read(os.path.join(ws, W.JOB_REL)))
    check(job["pid"] == W._PROC["proc"].pid and job["cmd_id"] == "cid1", "…job file records the child")
    e = raises(start, ws)
    check(e and "UPDATE_RUNNING" in e, "2 pressed again while it runs → UPDATE_RUNNING")
    W._PROC["proc"].wait()
    deadline = time.time() + 5
    while not pushes and time.time() < deadline:
        time.sleep(0.05)
    check(pushes, "…the watcher pushes a report when the child ends")
    os.remove(os.path.join(ws, "state", "workspace_update.json"))
    held = hold_lock(ws)
    write(os.path.join(ws, "state", "workspace_update.json"), '{"state": "applying", "ts": 7}')
    before = read(os.path.join(ws, "state", "workspace_update.json"))
    e = raises(start, ws)
    check(e and "UPDATE_RUNNING" in e and read(os.path.join(ws, "state", "workspace_update.json")) == before,
          "3 lock held by the chat path → UPDATE_RUNNING, its status byte-for-byte untouched")
    held.close()
    restore()

    # ── 5. failures after applying was written ──
    ws5 = make_workspace(repo, v1)
    W._child_argv = lambda w, c: [os.path.join(BASE, "no-such-python"), "ws_update.py"]
    e = raises(start, ws5)
    st = status(ws5)
    check(e and e.startswith("RuntimeError: START_FAILED") and st["state"] == "failed"
          and st["outcome"] == "stopped" and st["reason"] == "start_failed",
          f"5 Popen fails → START_FAILED, status failed start_failed, never left at applying ({st})")
    killed = []
    W._child_argv = lambda w, c: [sys.executable, "-c", "import time; time.sleep(60)", "ws_update.py"]
    W.kill_tree = lambda pid: killed.append(pid) or REAL["kill_tree"](pid)
    os.makedirs(os.path.join(ws5, W.JOB_REL))  # os.replace onto a directory fails
    e = raises(start, ws5)
    st = status(ws5)
    alive = True
    if killed:
        try:
            os.kill(killed[0], 0)
        except ProcessLookupError:
            alive = False
    check(e and "START_FAILED" in e and killed and not alive and st["state"] == "failed"
          and st["reason"] == "start_failed",
          f"5 job file unwritable → the child's tree killed, status failed start_failed ({e})")
    restore()

    # ── 6. anchor ──
    ws6 = make_workspace(repo, v1)
    calls = {"ls": 0, "script": 0}
    real_head = g(repo, "rev-parse", "HEAD")

    def ls_remote_once_wrong():
        calls["ls"] += 1
        return "0" * 40 if calls["ls"] == 1 else real_head
    W.ls_remote = ls_remote_once_wrong
    W.main(["--workspace", ws6])
    st = status(ws6)
    check(calls["ls"] == 2 and st["state"] == "done" and st["outcome"] == "updated",
          f"6 HEAD moved between ls-remote and clone → once more, then on ({st})")
    ws6b = make_workspace(repo, v1)
    W.ls_remote = lambda: "0" * 40
    real_rt = W.run_tree

    def count_script(argv, *a, **kw):
        if argv[-1:] and any(str(x).endswith("update_workspace.py") for x in argv):
            calls["script"] += 1
        return real_rt(argv, *a, **kw)
    W.run_tree = count_script
    W.main(["--workspace", ws6b])
    st = status(ws6b)
    check(st["state"] == "failed" and st["outcome"] == "stopped" and st["reason"] == "anchor_mismatch"
          and calls["script"] == 0 and read(os.path.join(ws6b, "VERSION")).strip() == "2026-09-01-a",
          f"6 mismatch twice → failed anchor_mismatch, no plan, no apply ({st})")
    restore()

    # ── 7. clone fails / times out ──
    ws7 = make_workspace(repo, v1)
    W.REPO = os.path.join(BASE, "no-such-repo")
    W.ls_remote = lambda: real_head
    W.main(["--workspace", ws7])
    st = status(ws7)
    check(st["state"] == "failed" and st["outcome"] == "stopped" and st["reason"] == "fetch_failed"
          and not test_tmps(), f"7 clone fails → failed fetch_failed, temp dir removed ({st})")
    W.REPO = repo
    real_git = W.git

    def git_clone_times_out(*args, timeout):
        if args[0] == "clone":
            raise W.Timeout(True)
        return real_git(*args, timeout=timeout)
    W.git = git_clone_times_out
    W.clone = REAL["clone"]
    W.main(["--workspace", ws7])
    W.git = real_git
    st = status(ws7)
    check(st["reason"] == "fetch_failed" and st["outcome"] == "stopped" and not test_tmps(),
          "7 clone times out → failed fetch_failed, temp dir removed")
    restore()

    # ── 8. end to end with the real script ──
    ws8 = make_workspace(repo, v1)
    argvs = []

    def record(argv, *a, **kw):
        if any(str(x).endswith("update_workspace.py") for x in argv):
            argvs.append(list(argv))
        return REAL["run_tree"](argv, *a, **kw)
    W.run_tree = record
    write(os.path.join(ws8, W.JOB_REL), json.dumps({"pid": os.getpid(), "started_at": 1, "cmd_id": "x"}))
    W.main(["--workspace", ws8])
    st = status(ws8)
    plan_argv = [a for a in argvs if "plan" in a]
    apply_argv = [a for a in argvs if "apply" in a]
    check(len(plan_argv) == 1 and len(apply_argv) == 1 and apply_argv[0][1] == "-I"
          and apply_argv[0][apply_argv[0].index("--allow") + 1] == "AGENTS.md"
          and "--restart-ok" in apply_argv[0]
          and apply_argv[0][apply_argv[0].index("--wait-busy") + 1] == "600"
          and apply_argv[0][apply_argv[0].index("--expect-head") + 1] == real_head,
          f"8 plan's changed_here → --allow AGENTS.md; --restart-ok and --wait-busy 600; the anchor as --expect-head ({apply_argv})")
    check(st["state"] == "done" and st["outcome"] == "updated" and st["to"] == "2026-09-23-b"
          and read(os.path.join(ws8, "VERSION")).strip() == "2026-09-23-b"
          and read(os.path.join(ws8, "AGENTS.md")) == "agents v1\n" and st["replaced_changed"] == ["AGENTS.md"],
          f"8 the real script: done/updated, VERSION written, the changed official file replaced ({st})")
    check(not os.path.exists(os.path.join(ws8, W.JOB_REL)) and not test_tmps(),
          "8 job file and clone removed when it ends")
    argvs.clear()
    W.main(["--workspace", ws8])
    apply_argv = [a for a in argvs if "apply" in a]
    st = status(ws8)
    check(apply_argv and "--allow" not in apply_argv[0] and "--restart-ok" in apply_argv[0]
          and st["outcome"] == "up_to_date",
          "8 nothing changed here → no --allow at all; up_to_date")
    restore()

    # ── 9. M1 end to end: busy → retry with a fresh plan ──
    def m1_run(mutate_allow=False):
        ws9 = make_workspace(repo, v1)
        unit("active")
        inflight = os.path.join(ws9, "state", "execution", "inflight", "s1.json")
        write(inflight, "{}")
        seen = []

        def busy_once(argv, *a, **kw):
            is_script = any(str(x).endswith("update_workspace.py") for x in argv)
            if is_script and "plan" in argv:
                seen.append(("plan", (status(ws9) or {}).get("state"), (status(ws9) or {}).get("phase")))
            out = REAL["run_tree"](argv, *a, **kw)
            if is_script and "apply" in argv:
                seen.append(("apply", argv[argv.index("--allow") + 1] if "--allow" in argv else None,
                             json.loads(out[1].strip().splitlines()[-1]).get("outcome")))
                if os.path.exists(inflight):
                    os.remove(inflight)  # the leg in flight finished during the retry's plan
            return out
        W.run_tree = busy_once
        W.WAIT_BUSY_S = 1
        if mutate_allow:
            first = {}
            W.plan_allow = lambda p: first.setdefault("a", REAL["plan_allow"](p))
        W.main(["--workspace", ws9])
        restore()
        unit("inactive")
        return ws9, seen

    ws9, seen = m1_run()
    st = status(ws9)
    check(seen[:2] == [("plan", "applying", "plan"), ("apply", "AGENTS.md", "restart_deferred")]
          and seen[2] == ("plan", "applying", "restart_retry") and seen[3] == ("apply", None, "updated"),
          f"9 restart_deferred(busy) → status back to applying (restart_retry) before a fresh plan; "
          f"the retry carries no --allow (nothing changed here any more) ({seen})")
    check(st["state"] == "done" and st["outcome"] == "updated" and st["restarted"] is True
          and read(os.path.join(ws9, "VERSION")).strip() == "2026-09-23-b",
          f"9 …and ends done/updated with the restart and VERSION ({st})")
    ws9m, seen_m = m1_run(mutate_allow=True)
    st_m = status(ws9m)
    check(st_m["state"] == "failed" and "--allow names files" in (st_m.get("reason") or ""),
          f"9/14 mutation: a retry reusing the first --allow ends failed — the check above would go red ({st_m.get('reason')})")

    # ── 10. apply lost the lock ──
    ws10 = make_workspace(repo, v1)
    theirs = '{"state": "applying", "outcome": null, "from": "x", "to": "y", "ts": 5}'

    def apply_locked(argv, *a, **kw):
        if any(str(x).endswith("update_workspace.py") for x in argv) and "apply" in argv:
            write(os.path.join(ws10, "state", "workspace_update.json"), theirs)
            return 1, json.dumps({"mode": "apply", "outcome": "stopped", "locked": True,
                                  "reason": "another update is running on this machine"}) + "\n"
        return REAL["run_tree"](argv, *a, **kw)
    W.run_tree = apply_locked
    W.main(["--workspace", ws10])
    check(read(os.path.join(ws10, "state", "workspace_update.json")) == theirs,
          "10 apply answered locked → nothing written after it, the other update's status stands")
    restore()

    # the chat path holds the lock for its whole apply: every status write of this run is skipped
    # (fetch / clone / plan phases included), and the real script's apply answers locked
    ws10b = make_workspace(repo, v1)
    write(os.path.join(ws10b, "state", "workspace_update.json"), theirs)
    held = hold_lock(ws10b)
    W.main(["--workspace", ws10b])
    held.close()
    check(read(os.path.join(ws10b, "state", "workspace_update.json")) == theirs
          and read(os.path.join(ws10b, "VERSION")).strip() == "2026-09-01-a",
          "10 lock held through the whole run: no phase write, no result write, nothing applied (M2)")

    # ── 12a. apply timeout ──
    ws12 = make_workspace(repo, v1)

    def apply_times_out(argv, *a, **kw):
        if any(str(x).endswith("update_workspace.py") for x in argv) and "apply" in argv:
            raise W.Timeout(True)
        return REAL["run_tree"](argv, *a, **kw)
    W.run_tree = apply_times_out
    W.main(["--workspace", ws12])
    st = status(ws12)
    check(st["state"] == "failed" and st["outcome"] == "error" and st["reason"] == "apply_timeout"
          and not test_tmps(),
          f"12a apply killed on timeout → failed, outcome error (may have written part), apply_timeout ({st})")
    ws12b = make_workspace(repo, v1)
    n_apply = []

    def retry_times_out(argv, *a, **kw):
        if any(str(x).endswith("update_workspace.py") for x in argv) and "apply" in argv:
            n_apply.append(1)
            if len(n_apply) == 2:
                raise W.Timeout(True)
            write(os.path.join(ws12b, "state", "workspace_update.json"),
                  json.dumps({"state": "done", "outcome": "restart_deferred", "ts": 1}))
            return 1, json.dumps({"outcome": "restart_deferred", "restart": "busy"}) + "\n"
        return REAL["run_tree"](argv, *a, **kw)
    W.run_tree = retry_times_out
    W.main(["--workspace", ws12b])
    st = status(ws12b)
    check(len(n_apply) == 2 and st["state"] == "failed" and st["outcome"] == "error"
          and st["reason"] == "apply_timeout", f"12a the retry's apply times out → the same ({st})")
    restore()
    # P2-1 (audit): the retry's plan fails after the first apply already wrote files — never `stopped`
    def retry_plan_fails(ws_r, first_status, gone):
        n = []

        def fake(argv, *a, **kw):
            if any(str(x).endswith("update_workspace.py") for x in argv):
                n.append("apply" if "apply" in argv else "plan")
                if n.count("plan") == 2:
                    raise W.Timeout(gone)
                if "apply" in argv:
                    p = os.path.join(ws_r, "state", "workspace_update.json")
                    if first_status:
                        write(p, json.dumps(first_status))
                    elif os.path.exists(p):
                        os.remove(p)
                    return 1, json.dumps({"outcome": "restart_deferred", "restart": "busy"}) + "\n"
            return REAL["run_tree"](argv, *a, **kw)
        W.run_tree = fake
        W.main(["--workspace", ws_r])
        restore()
        return status(ws_r)
    firstd = {"state": "done", "outcome": "restart_deferred", "from": "2026-09-01-a", "to": "2026-09-23-b", "restarted": False, "ts": 1}
    before_tmps = set(test_tmps())
    st = retry_plan_fails(make_workspace(repo, v1), firstd, False)
    kept_clone = set(test_tmps()) - before_tmps
    check(st["state"] == "done" and st["outcome"] == "restart_deferred" and kept_clone,
          f"P2-1 retry plan times out, tree not confirmed gone: the first apply's result is written back, not `stopped`; the clone is left for the sweep ({st})")
    for n_ in kept_clone:
        shutil.rmtree(os.path.join(tempfile.gettempdir(), n_), ignore_errors=True)
    st = retry_plan_fails(make_workspace(repo, v1), None, True)
    check(st["state"] == "failed" and st["outcome"] == "error" and st["reason"] == "plan_timeout",
          f"P2-1 …and with no first result to restore: failed `error` (may have written part), never `stopped` ({st})")

    # 永豐 worker busy (the reconciler restarted or had nothing to do): retried once like the
    # reconciler's busy; a refused reconciler restart, or a failed 永豐 one, is not
    def first_apply_says(ws_r, first):
        seen = []

        def fake(argv, *a, **kw):
            if any(str(x).endswith("update_workspace.py") for x in argv):
                if "plan" in argv:
                    seen.append(("plan", (status(ws_r) or {}).get("phase")))
                    return REAL["run_tree"](argv, *a, **kw)
                seen.append(("apply",))
                n = seen.count(("apply",))
                doc = dict(first) if n == 1 else {"outcome": "updated", "restart": None}
                write(os.path.join(ws_r, "state", "workspace_update.json"),
                      json.dumps({"state": "done", "outcome": doc["outcome"], "ts": n}))
                return (1 if n == 1 else 0), json.dumps(doc) + "\n"
            return REAL["run_tree"](argv, *a, **kw)
        W.run_tree = fake
        W.main(["--workspace", ws_r])
        restore()
        return seen, status(ws_r)
    for first, want in ((dict(restart="ok", sinopac_worker="busy"), True),
                        (dict(restart=None, sinopac_worker="busy"), True),
                        (dict(restart="refused", sinopac_worker="busy"), False),
                        (dict(restart="ok", sinopac_worker="failed"), False)):
        first = dict(first, outcome="restart_deferred" if first["sinopac_worker"] == "busy" or
                     first["restart"] == "refused" else "restart_failed")
        seen_r, st_r = first_apply_says(make_workspace(repo, v1), first)
        retried = seen_r == [("plan", "plan"), ("apply",), ("plan", "restart_retry"), ("apply",)]
        once = seen_r == [("plan", "plan"), ("apply",)]
        check((retried and st_r["outcome"] == "updated") if want else (once and st_r["outcome"] == first["outcome"]),
              f"9b first apply {first} → {'plan + apply once more (restart_retry), ends updated' if want else 'no retry'} "
              f"({seen_r}, {st_r.get('outcome')})")

    t0 = time.time()
    try:
        W.run_tree([sys.executable, "-c", "import subprocess, sys, time; "
                    "subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(60)']); time.sleep(60)"],
                   1, dict(os.environ))
        to = None
    except W.Timeout as e:
        to = e
    check(to is not None and to.gone and time.time() - t0 < 20,
          "12a run_tree on timeout kills the whole tree (grandchild too) and confirms it is gone")

    # ── 11. listener restart ──
    ws11 = make_workspace(repo, v1)
    live = sleeper(1)
    procs.append(live)
    write(os.path.join(ws11, W.JOB_REL), json.dumps({"pid": live.pid, "started_at": 1, "cmd_id": "x"}))
    write(os.path.join(ws11, "state", "workspace_update.json"), '{"state": "applying", "ts": 1}')
    adopted = []
    real_adopt = W._adopt
    W._adopt = lambda *a, **kw: adopted.append(a[1]["pid"]) or real_adopt(*a, poll_s=0.1)
    W.resume_watch(ws11, cl._pid_cmdline_or_none, lambda: pushes.append("adopt"))
    W._adopt = real_adopt
    check(adopted == [live.pid] and status(ws11)["state"] == "applying",
          "11 job alive at listener start → a watcher again, status untouched")
    deadline = time.time() + 10
    while "adopt" not in pushes and time.time() < deadline:
        time.sleep(0.1)
    st = status(ws11)
    check("adopt" in pushes and st["state"] == "failed" and st["reason"] == "interrupted",
          f"11 …it then dies without a result → failed interrupted, report pushed ({st})")
    ws11b = make_workspace(repo, v1)
    write(os.path.join(ws11b, W.JOB_REL), json.dumps({"pid": 999999, "started_at": 1, "cmd_id": "x"}))
    write(os.path.join(ws11b, "state", "workspace_update.json"),
          '{"state": "applying", "from": "2026-09-01-a", "to": null, "ts": 1}')
    stale = tempfile.mkdtemp(prefix=TEST_PREFIX)
    os.utime(stale, (time.time() - 7200, time.time() - 7200))
    fresh = tempfile.mkdtemp(prefix=TEST_PREFIX)
    W.resume_watch(ws11b, cl._pid_cmdline_or_none, lambda: None)
    st = status(ws11b)
    check(st["state"] == "failed" and st["outcome"] == "error" and st["reason"] == "interrupted"
          and not os.path.exists(os.path.join(ws11b, W.JOB_REL)),
          f"11 dead job + applying + lock free → failed interrupted, job file removed ({st})")
    check(not os.path.exists(stale) and os.path.exists(fresh),
          "11 a killed job's clone older than an hour is swept, a fresh one stays")
    shutil.rmtree(fresh, ignore_errors=True)
    ws11c = make_workspace(repo, v1)
    write(os.path.join(ws11c, W.JOB_REL), json.dumps({"pid": 999999, "started_at": 1, "cmd_id": "x"}))
    theirs = '{"state": "applying", "from": "a", "ts": 3}'
    write(os.path.join(ws11c, "state", "workspace_update.json"), theirs)
    held = hold_lock(ws11c)
    W.resume_watch(ws11c, cl._pid_cmdline_or_none, lambda: None)
    held.close()
    check(read(os.path.join(ws11c, "state", "workspace_update.json")) == theirs
          and not os.path.exists(os.path.join(ws11c, W.JOB_REL)),
          "11 dead job + lock held (the chat path is applying) → status untouched, dead job file removed")

    # ── 12. UPDATE_RUNNING in dispatch ──
    ws_disp = make_workspace(repo, v1)
    cl.WORKSPACE = ws_disp
    ran = []
    stub = {n: (lambda args, _n=n: ran.append(_n) or f"{_n} ok") for n in
            ("halt", "resume", "resume_wait", "close_all", "downtime_hold", "restart_reconciler")}
    real_handlers = {n: cl.HANDLERS[n] for n in stub}
    real_in_ws, real_ensure = cl._in_workspace, cl._ensure_reconciler_running
    cl.HANDLERS.update(stub)
    cl._in_workspace = lambda fn, args: fn(args)
    cl._ensure_reconciler_running = lambda: "reconciler ok"
    try:
        live = sleeper(30)
        procs.append(live)
        write(os.path.join(ws_disp, W.JOB_REL), json.dumps({"pid": live.pid, "started_at": 1, "cmd_id": "x"}))
        starts = [("resume", {}), ("resume_wait", {}), ("resume", {"strategies": ["a"]}),
                  ("resume_wait", {"strategies": ["a"]}), ("restart_reconciler", {})]
        res = [raises(cl.dispatch, {"cmd": c, "args": a}) for c, a in starts]
        check(all(r and r.startswith("RuntimeError: UPDATE_RUNNING") for r in res) and not ran,
              f"12 job running: resume / resume_wait (with and without strategies) / restart_reconciler refused ({res})")
        res = [raises(cl.dispatch, {"cmd": c, "args": a}) for c, a in
               (("halt", {}), ("close_all", {}), ("downtime_hold", {"strategies": ["a"]}))]
        check(res == [None, None, None] and ran == ["halt", "close_all", "downtime_hold"],
              "12 …halt, close_all and downtime_hold are never held back")
        live.kill()
        live.wait()
        ran.clear()
        held = hold_lock(ws_disp)
        r = raises(cl.dispatch, {"cmd": "resume", "args": {"strategies": ["a"]}})
        held.close()
        check(r and "UPDATE_RUNNING" in r and not ran, "12 the chat path's apply holds the lock → resume refused too")
        r = raises(cl.dispatch, {"cmd": "resume", "args": {}})
        check(r is None and ran == ["resume"], "12 nothing running → resume goes through")
    finally:
        cl.HANDLERS.update(real_handlers)
        cl._in_workspace, cl._ensure_reconciler_running = real_in_ws, real_ensure

    # ── P3 (audit) ──
    os.environ["SOME_API_TOKEN"] = "x"
    env = W.script_env()
    os.environ.pop("SOME_API_TOKEN")
    check("PATH" in env and "SOME_API_TOKEN" not in env and not [k for k in env if k.upper() not in W.SCRIPT_ENV_KEEP],
          "P3-1 the update child's environment is a whitelist: an unknown agent.env key does not reach it")
    tnow = time.time()
    check(W.job_alive({"pid": 4242, "started_at": tnow}, lambda pid: None) is True and W.job_alive({"pid": 4242}, lambda pid: "") is False
          and W.job_alive({"pid": 4242}, lambda pid: "python other.py") is False,
          "P3-7 job_alive: could not tell (None, powershell timeout) = alive; gone or someone else's pid = dead")
    # R-1 (re-audit): "could not tell" is alive only for as long as a run can last
    wsr = make_workspace(repo, v1)
    for ago, want in ((91 * 60, False), (89 * 60, True)):
        write(os.path.join(wsr, W.JOB_REL), json.dumps({"pid": 4242, "started_at": int(time.time()) - ago, "cmd_id": "x"}))
        check(W.running(wsr, lambda pid: None) is want,
              f"R-1 command line unreadable, job started {ago // 60} min ago → {'still blocks' if want else 'no longer blocks'} 啟動下單")
    check(W.job_alive({"pid": 4242}, lambda pid: None) is False, "R-1 …no started_at at all → not taken for alive")
    W.resume_watch(wsr, lambda pid: None, lambda: None)   # job file still says 89 min: adopted, untouched
    write(os.path.join(wsr, W.JOB_REL), json.dumps({"pid": 4242, "started_at": int(time.time()) - 91 * 60, "cmd_id": "x"}))
    write(os.path.join(wsr, "state", "workspace_update.json"), '{"state": "applying", "ts": 1}')
    W.resume_watch(wsr, lambda pid: None, lambda: None)
    check((status(wsr) or {}).get("reason") == "interrupted" and not os.path.exists(os.path.join(wsr, W.JOB_REL)),
          "R-1 …and at listener start such a job is settled (interrupted, job file removed)")
    wsl = make_workspace(repo, v1)
    W._child_argv = lambda w, c: [sys.executable, "-c", "import sys; sys.stderr.write('[ws_update] clone ok\\n')", "ws_update.py"]
    start(wsl)
    W._PROC["proc"].wait()
    restore()
    logp = os.path.join(wsl, W.LOG_REL)
    check(os.path.exists(logp) and "[ws_update] clone ok" in read(logp),
          "P3-3 the child's step lines land in state/logs/workspace_update.log (truncated per run)")

    # ── 13. report flag ──
    pr_src = read(os.path.join(RUNTIME, "portfolio_reporter.py"))
    check('"can_ws_update": True,' in pr_src, "13 the report carries can_ws_update: True")
    check(cl.HANDLERS.get("workspace_update") is not None, "13 …and the handler is registered")

    # ── 14. mutation: no anchor comparison ──
    src = read(os.path.join(RUNTIME, "ws_update.py"))
    check(src.count("        if got == anchor:\n") == 1, "14 the anchor comparison is where the mutation expects it")
    spec = importlib.util.spec_from_loader("ws_update_mut", loader=None)
    M = importlib.util.module_from_spec(spec)
    exec(compile(src.replace("        if got == anchor:\n", "        if True:\n"), "ws_update_mut", "exec"), M.__dict__)
    M.REPO, M.TMP_PREFIX = repo, TEST_PREFIX
    M.ls_remote = lambda: "0" * 40
    M_real_clone = M.clone
    M.clone = lambda d: (M_real_clone(d), g(d, "remote", "set-url", "origin", "https://github.com/Blave-TW/blave-agent"))
    ws14 = make_workspace(repo, v1)
    M.main(["--workspace", ws14])
    st = status(ws14)
    check(st.get("reason") != "anchor_mismatch",
          f"14 mutation: without the comparison the mismatch is not caught — test 6 would go red ({st.get('reason')})")

    # ── 15. contract with update_workspace.py ──
    us = read(SCRIPT_SRC)
    check(all(x in us for x in ('choices=("plan", "apply")', '"--clone"', '"--workspace"', '"--expect-head"',
                                '"--allow"', '"--restart-ok"', '"--wait-busy"', '"changed_here"',
                                'result["restart"]', 'result["sinopac_worker"]', '"locked": True', '"outcome"')),
          "15 update_workspace.py still takes the CLI and gives the JSON fields ws_update relies on")
    check(W.LOCK_REL == os.path.join("state", "workspace_update.lock") and '"state/workspace_update.lock"' in us,
          "15 one lock file, both sides")
    # the job runs as `python -I ws_update.py`: no runtime dir on sys.path, so the module must load on
    # the standard library alone and write / read its status without atomic_file
    ws15 = make_workspace(repo, v1)
    probe = ("import importlib.util, json, sys\n"
             "spec = importlib.util.spec_from_file_location('w', sys.argv[1]); m = importlib.util.module_from_spec(spec)\n"
             "spec.loader.exec_module(m)\n"
             "ok = m._atomic_file() is None and m.write_status(sys.argv[2], m.applying_doc('a', None, 'fetch'))\n"
             "print(json.dumps([ok, m.read_status(sys.argv[2]), 'atomic_file' in sys.modules]))\n")
    r = subprocess.run([sys.executable, "-I", "-c", probe, os.path.join(RUNTIME, "ws_update.py"), ws15],
                       capture_output=True, text=True, timeout=60)
    try:
        ok15, st15, af15 = json.loads(r.stdout.strip().splitlines()[-1])
    except (ValueError, IndexError):
        ok15, st15, af15 = False, None, True
    left = [n for n in os.listdir(os.path.join(ws15, "state")) if n.endswith(".tmp")]
    check(ok15 is True and st15 and st15.get("phase") == "fetch" and af15 is False and not left,
          f"15 under python -I: stdlib only, status written by hand (random temp + replace, none left) and read back ({r.stderr[-200:]})")
finally:
    for p in procs:
        try:
            p.kill()
            p.wait(timeout=5)
        except Exception:  # noqa: BLE001
            pass
    for n in test_tmps():
        shutil.rmtree(os.path.join(tempfile.gettempdir(), n), ignore_errors=True)
    shutil.rmtree(BASE, ignore_errors=True)

print("\nFAILED" if fails else "\nall ok")
sys.exit(1 if fails else 0)
