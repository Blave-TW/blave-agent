"""`workspace_update`: the desktop's 更新雲端主機 as a machine command, no agent turn.

Spec: .claude/output/specs/cloud-workspace-update-command-0160.md §2. Two roles:

- start(): called by command_listener on the poll loop. Validates, refuses a second
  run, writes `applying` BEFORE the ack (the report pushed right after dispatch has
  to carry it — the desktop recognises this run by the state change), then starts
  this file as a detached child and returns "started". The ack means "started";
  the result rides the report's `workspace_update`.
- __main__: the job. Clones the official repo into a 0700 temp dir, checks the
  clone HEAD against `git ls-remote`, runs the CLONE's manager/update_workspace.py
  plan → apply --allow <changed_here> --restart-ok --wait-busy 600, and when the
  restart had to wait (busy) runs plan + apply once more with the new list.

The child runs under `python -I`: sys.path does not hold the runtime directory, so
this module imports the standard library only; atomic_file is used when it is there
(the listener side) and done by hand otherwise.

state/workspace_update.lock is shared with update_workspace.py (the chat path):
the script holds it for a whole apply. This module never holds it for long — the
apply it starts takes it itself — it only probes it before every status write, so
whichever side loses writes nothing and the other side's status stands.
"""
import argparse
import json
import os
import platform
import re
import shutil
import signal
import subprocess
import sys
import tempfile
import threading
import time

try:
    import fcntl
except ImportError:  # Windows
    fcntl = None
try:
    import msvcrt
except ImportError:  # POSIX
    msvcrt = None

REPO = "https://github.com/Blave-TW/blave-agent"
IS_WINDOWS = platform.system() == "Windows"
STATUS_REL = os.path.join("state", "workspace_update.json")
LOCK_REL = os.path.join("state", "workspace_update.lock")
JOB_REL = os.path.join("state", "workspace_update_job.json")
TMP_PREFIX = "blave-wsupd-"
SCRIPT_NAME = "ws_update.py"
SHA_RE = re.compile(r"^[0-9a-f]{40}$")
# = manager/update_workspace.PATH_RE: --allow names come from the plan's JSON and are
# re-checked here before they become an argument
PATH_RE = re.compile(r"^[A-Za-z0-9_./-]{1,160}$")
LSREMOTE_TIMEOUT_S = 60
CLONE_TIMEOUT_S = 300
PLAN_TIMEOUT_S = 300
# > --wait-busy 600 plus the copy and the restart, < the reporter's 1200 s applying TTL
APPLY_TIMEOUT_S = 900
WAIT_BUSY_S = 600
KILL_CONFIRM_S = 30
STALE_TMP_S = 3600
REASON_MAX = 200
ERR_UPDATE_RUNNING = "UPDATE_RUNNING: the cloud machine is updating — start again when it finishes"


def _log(msg):
    print(f"[ws_update] {msg}", file=sys.stderr, flush=True)


# ── lock / status / job files ────────────────────────────────────────────────

def lock_free(workspace):
    """Probe state/workspace_update.lock: True = nobody holds it (taken and released at
    once), False = an apply is running. A lock file that cannot even be opened counts as
    free — update_workspace.py runs without the lock in that case too."""
    path = os.path.join(workspace, LOCK_REL)
    try:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        fh = open(path, "a+b")
    except OSError:
        return True
    try:
        try:
            if fcntl is not None:
                fcntl.flock(fh.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
                fcntl.flock(fh.fileno(), fcntl.LOCK_UN)
            elif msvcrt is not None:
                fh.seek(0)
                msvcrt.locking(fh.fileno(), msvcrt.LK_NBLCK, 1)
                fh.seek(0)
                msvcrt.locking(fh.fileno(), msvcrt.LK_UNLCK, 1)
        except OSError:
            return False
        return True
    finally:
        fh.close()


def _atomic_file():
    """runtime/atomic_file in the listener; None in the `python -I` child (not on its path)."""
    try:
        import atomic_file
    except ImportError:
        return None
    return atomic_file


def _read_json(path):
    af = _atomic_file()
    try:
        if af is not None:
            doc = af.load_json(path)  # Windows sharing-violation retry
        else:
            with open(path, encoding="utf-8") as f:
                doc = json.load(f)
    except (OSError, ValueError):
        return None
    return doc if isinstance(doc, dict) else None


def _write_json(path, doc):
    """Random-name temp (O_EXCL) + os.replace: atomic_file in the listener, the same by hand
    in the child."""
    os.makedirs(os.path.dirname(path), exist_ok=True)
    af = _atomic_file()
    if af is not None:
        with af.replacing(path, encoding="utf-8") as f:
            json.dump(doc, f, ensure_ascii=False)
        return
    d, base = os.path.split(path)
    fd, tmp = tempfile.mkstemp(dir=d, prefix="." + base + ".", suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(doc, f, ensure_ascii=False)
        os.replace(tmp, path)
    except BaseException:
        try:
            os.remove(tmp)
        except OSError:
            pass
        raise


def read_status(workspace):
    return _read_json(os.path.join(workspace, STATUS_REL))


def write_status(workspace, doc):
    """Only while nobody holds the lock: a probe that fails means the chat path is applying
    and its status stands."""
    if not lock_free(workspace):
        _log("status not written: another update holds the lock")
        return False
    try:
        _write_json(os.path.join(workspace, STATUS_REL), dict(doc, ts=int(time.time())))
        return True
    except (OSError, TypeError, ValueError) as e:
        _log(f"status write failed: {type(e).__name__}")
        return False


def applying_doc(v_from, v_to, phase):
    return {"state": "applying", "outcome": None, "from": v_from, "to": v_to, "phase": phase}


def failed_doc(outcome, reason, v_from, v_to=None):
    """Same shape as update_workspace.status_doc's failed. outcome: stopped = nothing was
    written; error = something may have been."""
    return {"state": "failed", "outcome": outcome, "from": v_from, "to": v_to, "restarted": False,
            "reason": str(reason)[:REASON_MAX], "replaced_changed": [], "backup_dir": None,
            "restart_stopped": False, "version_written": False}


def read_version(workspace):
    try:
        with open(os.path.join(workspace, "VERSION"), encoding="utf-8") as f:
            v = f.read().strip()
    except OSError:
        return None
    return v if re.fullmatch(r"[A-Za-z0-9._-]{1,40}", v) else None


def read_job(workspace):
    return _read_json(os.path.join(workspace, JOB_REL))


def drop_job(workspace, pid=None):
    """Remove the job file; with `pid`, only when it is still that run's."""
    if pid is not None:
        job = read_job(workspace)
        if job and job.get("pid") != pid:
            return
    try:
        os.remove(os.path.join(workspace, JOB_REL))
    except FileNotFoundError:
        pass
    except OSError as e:
        _log(f"job file not removed: {type(e).__name__}")


# Longest a job can run (F twice + P + A + A2 ≈ 57 min) plus margin: past this, a pid whose
# command line cannot be read is no longer taken for a live job.
JOB_MAX_S = 90 * 60


def job_alive(job, pid_cmdline, proc=None, now=None):
    """Alive AND still this script (a reused pid after a reboot is somebody else).
    Same identity rule as command_listener._mgmt_pid_alive. pid_cmdline = its
    _pid_cmdline_or_none: "" no such process, None could not tell."""
    pid = job.get("pid") if isinstance(job, dict) else None
    if not isinstance(pid, int) or isinstance(pid, bool) or pid <= 0:
        return False
    if proc is not None and proc.pid == pid:
        return proc.poll() is None
    cmd = pid_cmdline(pid)
    if cmd is None:
        # could not tell (a loaded Windows box can take powershell past its timeout): alive —
        # settling a live run as interrupted would also drop the single flight — but only for
        # as long as a run can last, or a lookup that keeps failing blocks 啟動下單 for good
        started = job.get("started_at")
        if not isinstance(started, (int, float)) or isinstance(started, bool):
            return False
        return (time.time() if now is None else now) - started < JOB_MAX_S
    return SCRIPT_NAME in cmd


def running(workspace, pid_cmdline):
    """Is an update going on here right now: our job alive, or the lock held (the chat
    path mid-apply). command_listener refuses to start trading while it is."""
    job = read_job(workspace)
    if job and job_alive(job, pid_cmdline, _PROC.get("proc")):
        return True
    return not lock_free(workspace)


# ── child process helpers ────────────────────────────────────────────────────

def _git_env():
    """No user or system config (insteadOf, sslVerify=false, hooks), no password prompt."""
    env = {"PATH": os.environ.get("PATH", "") if IS_WINDOWS else "/usr/bin:/bin",
           "HOME": "/nonexistent", "GIT_CONFIG_GLOBAL": os.devnull, "GIT_CONFIG_NOSYSTEM": "1",
           "GIT_TERMINAL_PROMPT": "0"}
    if IS_WINDOWS:
        env["SYSTEMROOT"] = os.environ.get("SYSTEMROOT", "")
    return env


def git_path():
    return shutil.which("git", path=None if IS_WINDOWS else "/usr/bin:/bin")


# What update_workspace.py (and this child) get from the listener's environment: only what
# finding systemctl / sudo / nssm / python needs. A whitelist: agent.env holds keys of ours
# whose names nobody can enumerate ahead of time.
SCRIPT_ENV_KEEP = ("PATH", "PATHEXT", "SYSTEMROOT", "WINDIR", "COMSPEC", "TEMP", "TMP", "TMPDIR",
                   "LANG", "LC_ALL", "HOME", "USERPROFILE", "PROGRAMDATA", "USER", "LOGNAME")


def script_env():
    return {k: v for k, v in os.environ.items() if k.upper() in SCRIPT_ENV_KEEP}


def _new_group_kw():
    kw = {"stdin": subprocess.DEVNULL}
    if IS_WINDOWS:
        kw["creationflags"] = (getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)
                               | getattr(subprocess, "CREATE_NO_WINDOW", 0))
    else:
        kw["start_new_session"] = True
    return kw


def kill_tree(pid):
    """The whole tree: on Windows proc.kill() only reaches the venv launcher and the real
    interpreter keeps running (command_listener._child_kw)."""
    try:
        if IS_WINDOWS:
            subprocess.run(["taskkill", "/T", "/F", "/PID", str(pid)], capture_output=True,
                           timeout=30, stdin=subprocess.DEVNULL,
                           creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        else:
            os.killpg(pid, signal.SIGKILL)
    except (OSError, subprocess.SubprocessError) as e:
        _log(f"kill failed: {type(e).__name__}")


def _group_gone(pid):
    if IS_WINDOWS:
        return True  # taskkill /T already waited on the tree; proc.wait() covered the root
    try:
        os.killpg(pid, 0)
    except ProcessLookupError:
        return True
    except OSError:
        return True
    return False


class Timeout(Exception):
    def __init__(self, gone):
        super().__init__("timed out")
        self.gone = gone  # every process of the tree confirmed exited


def run_tree(argv, timeout, env, cwd=None):
    """(returncode, stdout). On timeout the whole tree is killed and its exit confirmed
    before Timeout is raised — the clone is deleted afterwards, and a half-run apply that
    lost its files mid-copy is worse than one that was stopped."""
    proc = subprocess.Popen(argv, cwd=cwd, env=env, stdout=subprocess.PIPE,
                            stderr=subprocess.DEVNULL, **_new_group_kw())
    try:
        out, _ = proc.communicate(timeout=timeout)
        return proc.returncode, out.decode("utf-8", "replace")
    except subprocess.TimeoutExpired:
        kill_tree(proc.pid)
        gone = False
        try:
            proc.communicate(timeout=KILL_CONFIRM_S)
            deadline = time.time() + KILL_CONFIRM_S
            while not _group_gone(proc.pid) and time.time() < deadline:
                time.sleep(0.2)
            gone = _group_gone(proc.pid)
        except subprocess.TimeoutExpired:
            pass
        raise Timeout(gone) from None


def git(*args, timeout):
    return run_tree(["git", *args], timeout, _git_env())


# ── the job ──────────────────────────────────────────────────────────────────

class Failed(Exception):
    """gone=False: a killed child's tree could not be confirmed exited — the clone stays."""

    def __init__(self, outcome, reason, gone=True):
        super().__init__(reason)
        self.outcome, self.reason, self.gone = outcome, reason, gone


def ls_remote():
    try:
        rc, out = git("ls-remote", REPO, "HEAD", timeout=LSREMOTE_TIMEOUT_S)
    except (OSError, Timeout):
        raise Failed("stopped", "fetch_failed") from None
    sha = out.split("\t", 1)[0].strip() if rc == 0 else ""
    if not SHA_RE.match(sha):
        raise Failed("stopped", "fetch_failed")
    return sha


def clone(dest):
    try:
        rc, _ = git("clone", "-q", "--filter=blob:none", REPO, dest, timeout=CLONE_TIMEOUT_S)
    except Timeout as t:
        raise Failed("stopped", "fetch_failed", t.gone) from None
    except OSError:
        raise Failed("stopped", "fetch_failed") from None
    if rc != 0:
        raise Failed("stopped", "fetch_failed")


def clone_head(repo):
    try:
        rc, out = git("-C", repo, "rev-parse", "HEAD", timeout=LSREMOTE_TIMEOUT_S)
    except (OSError, Timeout):
        raise Failed("stopped", "fetch_failed") from None
    return out.strip() if rc == 0 else ""


def run_script(repo, workspace, mode, head, allow=None):
    """The clone's own update_workspace.py (it refuses to run from anywhere else).
    Contract pinned by tests/check_ws_update_cmd.py: plan|apply, --clone, --workspace,
    --expect-head, --allow, --restart-ok, --wait-busy; JSON outcome, changed_here,
    restart, locked. Raises Timeout; returns the parsed JSON or None."""
    argv = [sys.executable, "-I", os.path.join(repo, "manager", "update_workspace.py"), mode,
            "--clone", repo, "--workspace", workspace, "--expect-head", head]
    if mode == "apply":
        if allow:
            argv += ["--allow", ",".join(allow)]
        argv += ["--restart-ok", "--wait-busy", str(WAIT_BUSY_S)]
    _, out = run_tree(argv, PLAN_TIMEOUT_S if mode == "plan" else APPLY_TIMEOUT_S,
                      script_env(), cwd=repo)
    lines = [x for x in out.strip().splitlines() if x.strip()]
    try:
        doc = json.loads(lines[-1]) if lines else None
    except ValueError:
        return None
    return doc if isinstance(doc, dict) else None


def plan_allow(p):
    """changed_here, re-checked against the path rule before it becomes an argument."""
    names = p.get("changed_here")
    if not isinstance(names, list):
        raise Failed("stopped", "plan_unreadable")
    for n in names:
        if not (isinstance(n, str) and PATH_RE.match(n) and ".." not in n.split("/")
                and "," not in n):
            raise Failed("stopped", "plan_unreadable")
    return names


def do_plan(repo, workspace, head):
    try:
        p = run_script(repo, workspace, "plan", head)
    except Timeout as t:
        raise Failed("stopped", "plan_timeout", t.gone) from None
    except OSError:
        raise Failed("stopped", "plan_unreadable") from None
    if p is None:
        raise Failed("stopped", "plan_unreadable")
    if p.get("outcome") != "plan":
        raise Failed("stopped", p.get("reason") or p.get("error") or "plan_unreadable")
    return p


def do_apply(repo, workspace, head, allow):
    """The apply's JSON, or None when it lost the lock (the other update's status stands).
    The script writes its own status; when it was killed or crashed before its final write
    the status still says applying, and this run turns it into the failure it is."""
    try:
        a = run_script(repo, workspace, "apply", head, allow)
    except Timeout as t:
        raise Failed("error", "apply_timeout", t.gone) from None
    except OSError:
        raise Failed("error", "apply_unreadable") from None
    if a is not None and a.get("locked") is True:
        _log("apply: another update holds the lock — its status stands")
        return None
    st = read_status(workspace)
    if a is None or (st and st.get("state") == "applying"):
        raise Failed("error", "apply_unreadable")
    return a


def job(workspace, tmp, ctx):
    v_from = read_version(workspace)
    repo = os.path.join(tmp, "repo")
    head = None
    for _attempt in range(2):
        write_status(workspace, applying_doc(v_from, None, "fetch"))
        anchor = ls_remote()
        write_status(workspace, applying_doc(v_from, None, "clone"))
        if os.path.exists(repo):
            shutil.rmtree(repo)
        clone(repo)
        got = clone_head(repo)
        if got == anchor:
            head = anchor
            break
        _log("clone HEAD differs from ls-remote — once more")
    if head is None:
        raise Failed("stopped", "anchor_mismatch")
    _log("clone ok")
    v_to = ctx["to"] = read_version(repo)
    write_status(workspace, applying_doc(v_from, v_to, "plan"))
    p = do_plan(repo, workspace, head)
    a = do_apply(repo, workspace, head, plan_allow(p))
    if a is None:
        return
    _log(f"apply outcome={a.get('outcome')} restart={a.get('restart')}")
    if not (a.get("outcome") == "restart_deferred" and a.get("restart") == "busy"):
        return
    # The restart waited out --wait-busy. Once more, with a fresh plan: the first apply
    # already replaced every changed_here file, so the old --allow would now Stop (and
    # overwrite the first result with a failure). Back to applying first, so the desktop
    # does not take the first, intermediate result for this run's answer.
    first = read_status(workspace)
    write_status(workspace, applying_doc(a.get("version_before", v_from),
                                         a.get("version_clone", v_to), "restart_retry"))
    try:
        allow2 = plan_allow(do_plan(repo, workspace, head))
    except Failed as e:
        # The first apply already wrote files: never end this run as `stopped` (= nothing
        # written). Its own result is still the truth; without it, `error`.
        if not first:
            raise Failed("error", e.reason, e.gone) from None
        write_status(workspace, {k: v for k, v in first.items() if k != "ts"})
        ctx["gone"] = e.gone
        _log("retry plan failed; first result kept")
        return
    a2 = do_apply(repo, workspace, head, allow2)
    if a2 is not None:
        _log(f"retry outcome={a2.get('outcome')} restart={a2.get('restart')}")


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--workspace", required=True)
    ap.add_argument("--cmd-id", default="")
    a = ap.parse_args(argv)
    workspace = os.path.realpath(a.workspace)
    tmp = None
    gone = True
    ctx = {"to": None, "gone": True}
    try:
        try:
            tmp = tempfile.mkdtemp(prefix=TMP_PREFIX)
        except OSError:
            raise Failed("stopped", "tmp") from None
        job(workspace, tmp, ctx)
        gone = ctx["gone"]
    except Failed as e:
        _log(f"failed: {e.outcome} {e.reason if re.fullmatch(r'[a-z_]+', str(e.reason)) else 'stopped by plan'}")
        write_status(workspace, failed_doc(e.outcome, e.reason, read_version(workspace), ctx["to"]))
        gone = e.gone
    except Exception as e:  # never leave `applying` behind — but never overwrite a result either
        _log(f"crashed: {type(e).__name__}")
        st = read_status(workspace)
        if not st or st.get("state") == "applying":
            write_status(workspace, failed_doc("error", "crashed", read_version(workspace), ctx["to"]))
    finally:
        if tmp and gone:
            shutil.rmtree(tmp, ignore_errors=True)
        elif tmp:
            _log("a killed apply may still hold the clone — left for the stale sweep")
        drop_job(workspace, os.getpid())
    return 0


# ── the listener side ────────────────────────────────────────────────────────

_PROC = {"proc": None}


LOG_REL = os.path.join("state", "logs", "workspace_update.log")


def _open_log(workspace):
    """The child's step lines (`[ws_update] clone ok`, `apply outcome=…`), one run per file:
    truncated at each start, so it stays a few lines long. Codes only, never script output."""
    p = os.path.join(workspace, LOG_REL)
    os.makedirs(os.path.dirname(p), exist_ok=True)
    return _atomic_file().open_truncate(p)


def _child_argv(workspace, cmd_id):
    return [sys.executable, "-I", os.path.abspath(__file__), "--workspace", workspace,
            "--cmd-id", str(cmd_id or "")]


def start(args, workspace, local_mode, cmd_id, pid_cmdline, child_kw, push):
    """command_listener's `workspace_update` handler. Everything before the ack: see
    module doc. Raises with a code the desktop maps; returns "started"."""
    if not isinstance(args, dict) or args:
        raise ValueError("workspace_update takes no arguments")
    if local_mode:
        raise RuntimeError("LOCAL_MODE: the desktop's own workspace updates with the app")
    if not git_path():
        raise RuntimeError("NO_GIT: git is not installed on this machine")
    job_doc = read_job(workspace)
    if job_doc and job_alive(job_doc, pid_cmdline, _PROC.get("proc")):
        raise RuntimeError(ERR_UPDATE_RUNNING)
    if not lock_free(workspace):
        raise RuntimeError(ERR_UPDATE_RUNNING)
    v_from = read_version(workspace)
    if not write_status(workspace, applying_doc(v_from, None, "fetch")):
        if not lock_free(workspace):
            raise RuntimeError(ERR_UPDATE_RUNNING)
        raise RuntimeError("START_FAILED: could not write the update status")
    argv = _child_argv(workspace, cmd_id)
    try:
        kw = _new_group_kw()
        kw.pop("stdin", None)
        kw = child_kw(**kw)
        with _open_log(workspace) as logf:
            proc = subprocess.Popen(argv, cwd=workspace, env=script_env(),
                                    stdout=subprocess.DEVNULL, stderr=logf, **kw)
    except (OSError, ValueError, subprocess.SubprocessError) as e:
        write_status(workspace, failed_doc("stopped", "start_failed", v_from))
        raise RuntimeError(f"START_FAILED: could not start the update ({type(e).__name__})") from None
    try:
        _write_json(os.path.join(workspace, JOB_REL),
                    {"pid": proc.pid, "started_at": int(time.time()), "cmd_id": str(cmd_id or "")})
    except OSError as e:
        # no job file = no single flight and nobody to adopt the run: it must not go on
        kill_tree(proc.pid)
        try:
            proc.wait(timeout=KILL_CONFIRM_S)
        except subprocess.TimeoutExpired:
            pass
        write_status(workspace, failed_doc("stopped", "start_failed", v_from))
        raise RuntimeError(f"START_FAILED: could not record the update ({type(e).__name__})") from None
    _PROC["proc"] = proc
    try:
        threading.Thread(target=_watch, args=(proc, push), daemon=True, name="ws-update-watch").start()
    except RuntimeError as e:
        _log(f"watcher not started ({e}); the result comes with the next report")
    return "started"


def _watch(proc, push):
    try:
        proc.wait()
    except Exception as e:
        _log(f"watcher: {type(e).__name__}")
    push()


def _adopt(workspace, job_doc, pid_cmdline, push, poll_s=10):
    try:
        while job_alive(job_doc, pid_cmdline):
            time.sleep(poll_s)
    except Exception as e:
        _log(f"adopted watcher: {type(e).__name__}")
    settle_dead(workspace, job_doc)
    push()


def settle_dead(workspace, job_doc):
    """A job whose process is gone (a bridge restart killed the tree on Windows, a reboot).
    Its `applying` becomes `interrupted` — unless the lock is held: then the chat path is
    applying right now and that status is not ours to touch."""
    st = read_status(workspace)
    if st and st.get("state") == "applying" and lock_free(workspace):
        write_status(workspace, failed_doc("error", "interrupted", st.get("from"), st.get("to")))
    drop_job(workspace, job_doc.get("pid") if isinstance(job_doc, dict) else None)


def sweep_stale_tmp(now=None):
    now = time.time() if now is None else now
    base = tempfile.gettempdir()
    try:
        names = os.listdir(base)
    except OSError:
        return
    for n in names:
        if not n.startswith(TMP_PREFIX):
            continue
        p = os.path.join(base, n)
        try:
            if os.path.isdir(p) and not os.path.islink(p) and now - os.path.getmtime(p) > STALE_TMP_S:
                shutil.rmtree(p, ignore_errors=True)
        except OSError:
            pass


def resume_watch(workspace, pid_cmdline, push):
    """At listener start (next to _resume_mgmt_watch): a run that outlived the previous
    bridge (Linux, KillMode=process) gets a watcher again; a dead one is settled."""
    job_doc = read_job(workspace)
    if job_doc and job_alive(job_doc, pid_cmdline):
        _log(f"adopting running update pid {job_doc.get('pid')}")
        threading.Thread(target=_adopt, args=(workspace, job_doc, pid_cmdline, push),
                         daemon=True, name="ws-update-adopt").start()
        return
    if job_doc:
        settle_dead(workspace, job_doc)
    sweep_stale_tmp()


if __name__ == "__main__":
    sys.exit(main())
