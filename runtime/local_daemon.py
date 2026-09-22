"""Local daemon: the desktop build's host for the live-trading chain.

One framework, two places to run it. This process runs the SAME scheduler
thread and the SAME command handlers as the cloud box (command_listener), the
same reconciler (manager/reconciler.py) and the same report builder
(portfolio_reporter.build_report). Only two things differ from the cloud:

  where commands come from   a file queue under <workspace>/state/local_cmd/
                             instead of the api's Redis queue
  who supervises the daemons this process, instead of systemd / NSSM

Design + the reasons behind each choice: blave-canon
output/specs/desktop-local-daemon-design-2026-09.md.

Command file (written by the app as <id>.json.tmp, then renamed):
    {"body": "<JSON string of {id, cmd, args, ts}>", "mac": "<hex>"}
    mac = HMAC-SHA256(secret, body as UTF-8 bytes)
The MAC is over the exact string, so the two ends never have to agree on a
canonical JSON. The secret arrives on stdin at startup — not in the environment
(`ps -E` shows that to the same user) and never on disk. `halt` alone is
accepted unsigned: it is the safe direction, the agent is allowed to pull it,
and it is the stop button that works while the app is shut.

What the MAC is NOT: isolation from the agent. The agent runs as the same OS
user, so it can still delete state/HALT, edit portfolio_config.json or .env,
import command_listener and call _cmd_resume, start its own reconciler, import
lib/order_*, or kill this daemon and start one with a secret of its own. The
cloud box has none of that isolation either — there, as here, those are
AGENTS.md behaviour rules. The MAC stops exactly two things: a command file the
agent drops into in/ (resume / amounts / credentials), and a replay of a real
one (ts window + the in-memory seen-id set; acks on disk are not trusted for it).

Ack: state/local_cmd/ack/<id>.json = {id, cmd, ok, result | error, ts} — the
same shape the api's /ack stores.
Status: state/local_status.json = build_report() + a "daemon" block.

Import-safe (the cloud updater imports every runtime module as a health
check): nothing runs until main().
"""
import hashlib
import hmac
import json
import os
import re
import select
import signal
import stat
import subprocess
import sys
import threading
import time

try:
    import fcntl
except ImportError:  # Windows — the desktop build does not run there yet
    fcntl = None

# Mirror of api/openclaw/agent_command.py ALLOWED (tests/check_local_daemon.py
# fails when the two drift). `telegram_reset` stays out here for the same
# reason it stays out there.
ALLOWED = frozenset({
    "halt", "resume", "resume_wait", "downtime_hold", "amounts", "execution", "credentials",
    "credentials_remove", "restart_reconciler", "retest_accounts", "close_all",
    "delete_strategy", "manage_optimize", "manage_backtest", "manage_cancel",
    "report_pause", "report_resume", "report_run_now", "report_delete",
    "report_edit_pending", "preferences_set", "tz_set", "reply_lang_set",
})
UNSIGNED_OK = frozenset({"halt"})

MAX_BYTES = 16 * 1024      # = the api's MAX_BYTES on the way in
TS_WINDOW_S = 120          # a signed command older/newer than this is a replay
ACK_KEEP_S = 24 * 3600     # also the replay memory: an acked id never runs twice
SECRET_MIN_CHARS = 32
POLL_S = 0.5
STATUS_EVERY_S = 15
ACCOUNT_EVERY_S = 60       # the cloud's account timer cadence
ACCOUNT_TIMEOUT_S = 180
RESTART_DELAY_S = 10       # = manager/start_reconciler.sh's `sleep 10`
# Shutdown has to fit between an app's SIGTERM and the SIGKILL that follows it:
# the runner gets SWEEP_BUDGET_S to cancel its own resting orders, the daemon
# waits STOP_GRACE_S for it, then kills.
SWEEP_BUDGET_S = 3
STOP_GRACE_S = 5
SEEN_KEEP_S = 3600         # replay memory, well past TS_WINDOW_S
_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")


def _log(msg):
    """Never takes a payload — a command body may hold an exchange key."""
    try:
        print(f"[local_daemon] {msg}", file=sys.stderr, flush=True)
    except (OSError, ValueError):
        # stderr is a pipe to the app: a SIGKILLed app leaves it broken, and a
        # log line that raises would abort the very shutdown it announces
        pass


def _wait_parent_gone(ppid):
    """Blocks until whoever started us is gone; returns why. stdin EOF alone is
    not enough — any other process holding the pipe's write end keeps it open
    after the parent dies — so the parent pid is polled alongside it."""
    while True:
        if ppid == 1 or os.getppid() != ppid:
            return "parent process is gone"
        try:
            # raw fd, not sys.stdin: a thread parked inside the buffered reader
            # holds its lock and aborts the interpreter at shutdown
            if select.select([0], [], [], 1)[0] and not os.read(0, 4096):
                return "parent closed stdin"
        except (OSError, ValueError):
            return "parent closed stdin"


def sign(secret, body):
    return hmac.new(secret.encode(), body.encode("utf-8"), hashlib.sha256).hexdigest()


def _slide_events(events_mod, evs):
    """No platform acks events here, so events.unsent() would return the OLDEST
    MAX_SEND lines forever and everything newer would never reach the status file
    (the app's timeline and its P1 notifications both read from there). When the
    window is full, ack its older half ourselves: the next build starts from the
    middle, and the hourly rotate() can finally drop what is below the mark.

    Full = truncated, by either cap: the count (MAX_SEND) or the byte cap
    (MAX_SEND_BYTES can cut the window short of MAX_SEND lines) — so ask whether
    the file has anything newer than the window's last line, not how long it is.
    Call this only AFTER the status file was written: acking first would hide the
    older half of a window nobody ever got to read."""
    # < 20 lines cannot be a truncated window (256KB / 8KB per line ≥ 32); it is an
    # event appended between the build and this check — leave it for the next round
    if not isinstance(evs, list) or len(evs) < 20:
        return
    try:
        if evs[-1]["id"] < events_mod._last_id():
            events_mod.save_acked(evs[len(evs) // 2 - 1]["id"])
    except (KeyError, TypeError, IndexError):
        pass


def _write_json_atomic(path, doc):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = f"{path}.{os.getpid()}.tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(doc, f, ensure_ascii=False)
    os.replace(tmp, path)


class Rejected(Exception):
    """A command file that never reaches dispatch(). The message is a shape,
    never a value from the file."""


def parse_command(raw, stem, secret, now, seen, not_before=0):
    """bytes of one queue file → {id, cmd, args}, or raise Rejected.
    `seen(id)` answers "did this daemon already take this id" — memory, not the
    ack files: those sit where the agent can delete them. `not_before` (daemon
    start) covers the one gap memory has, a replay right after a restart."""
    if len(raw) > MAX_BYTES:
        raise Rejected("payload too large")
    try:
        doc = json.loads(raw.decode("utf-8"))
        body = doc["body"]
        entry = json.loads(body)
    except (ValueError, KeyError, TypeError, AttributeError):
        raise Rejected("bad command file")
    if not isinstance(body, str) or not isinstance(entry, dict):
        raise Rejected("bad command file")
    cid, cmd = entry.get("id"), entry.get("cmd")
    if not isinstance(cid, str) or not _ID_RE.fullmatch(cid) or cid != stem:
        raise Rejected("bad id")
    if cmd not in ALLOWED:
        raise Rejected("unknown command")  # never echoes the value, like the api
    if cmd not in UNSIGNED_OK:
        mac = doc.get("mac")
        if not secret or not isinstance(mac, str) or \
                not hmac.compare_digest(mac, sign(secret, body)):
            raise Rejected("bad signature")
        ts = entry.get("ts")
        if isinstance(ts, bool) or not isinstance(ts, (int, float)) \
                or abs(now - ts) > TS_WINDOW_S or ts < not_before:
            raise Rejected("stale command")
    if seen(cid):
        raise Rejected("duplicate id")
    args = entry.get("args") if isinstance(entry.get("args"), dict) else {}
    return {"id": cid, "cmd": cmd, "args": args}


def _pid_cwd(pid):
    """realpath of a process's cwd, "" when it cannot be read."""
    try:
        return os.path.realpath(os.readlink(f"/proc/{int(pid)}/cwd"))
    except (OSError, ValueError):
        pass
    try:  # macOS: no /proc
        out = subprocess.run(["lsof", "-a", "-p", str(int(pid)), "-d", "cwd", "-Fn"],
                             capture_output=True, text=True, timeout=10).stdout
    except (OSError, subprocess.SubprocessError, ValueError):
        return ""
    for line in out.splitlines():
        if line.startswith("n"):
            return os.path.realpath(line[1:])
    return ""


def run_reconciler(script):
    """`--run-reconciler`: manager/reconciler.py, unmodified, in this process —
    plus the two things it lacks for a machine whose supervisor can vanish.

    Parent gone (stdin EOF — the daemon was SIGKILLed, or the app took it down)
    → leave, the same way as on SIGTERM. "App gone = trading stops" has to hold
    for the one process that actually sends orders, not just for the daemon.

    Leaving = cancel our own resting limit orders (chase posts them) within
    SWEEP_BUDGET_S, then exit: an order left on the book would fill while
    nobody is there to see it. Runs on the main thread (signal handler), so no
    new reconcile round starts meanwhile. What the budget does not cover, the
    reconciler's own startup sweep + reap_dead_inflight pick up next start."""
    import runpy

    ws = os.getcwd()
    if ws not in sys.path:
        sys.path.insert(0, ws)

    def _sweep():
        try:
            from lib.venue_wiring import sweep_orphan_orders
            n = sweep_orphan_orders()
            if n:
                _log(f"cancelled {n} resting order(s) on the way out")
        except Exception as e:
            _log(f"exit sweep skipped: {type(e).__name__}: {e}")

    def _leave(*_):
        signal.signal(signal.SIGTERM, signal.SIG_IGN)
        _log("reconciler leaving")
        t = threading.Thread(target=_sweep, daemon=True)
        t.start()
        t.join(SWEEP_BUDGET_S)
        os._exit(0)

    ppid = os.getppid()

    def _watch_parent():
        _wait_parent_gone(ppid)
        os.kill(os.getpid(), signal.SIGTERM)
        time.sleep(SWEEP_BUDGET_S + 2)  # main thread wedged in C: leave anyway
        os._exit(0)

    signal.signal(signal.SIGTERM, _leave)
    threading.Thread(target=_watch_parent, daemon=True, name="parent-watch").start()
    runpy.run_path(script, run_name="__main__")


class SingleInstance:
    """flock held for the life of the process — released by the OS on any exit,
    so there is no stale-pid case to reason about. The pid inside is for humans."""

    def __init__(self, path):
        self.path, self.fd = path, None

    def acquire(self):
        os.makedirs(os.path.dirname(self.path), exist_ok=True)
        fd = os.open(self.path, os.O_CREAT | os.O_RDWR, 0o600)
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            os.close(fd)
            return False
        os.ftruncate(fd, 0)
        os.write(fd, str(os.getpid()).encode())
        self.fd = fd
        return True


class ReconcilerSupervisor:
    """What systemd's Restart=always / start_reconciler.sh are on the cloud box.

    Double-order guard: the reconciler inherits the flock on
    state/local_reconciler.lock, so the lock lives exactly as long as that
    process — including an orphan left by a SIGKILLed daemon. A new reconciler
    is never started while the lock is held."""

    def __init__(self, workspace, child_env, pid_cmdline):
        self.ws = os.path.realpath(workspace)
        self._child_env, self._pid_cmdline = child_env, pid_cmdline
        self._lock = threading.RLock()
        self._proc = None
        self._wanted = False
        self._respawn_at = None
        self.restarts = 0
        self.last_exit_code = None
        self.last_exit_at = None
        self._lock_path = os.path.join(workspace, "state", "local_reconciler.lock")
        self._pid_path = os.path.join(workspace, "state", "local_reconciler.pid")

    # — the two hooks command_listener calls —
    def restart_reconciler(self):
        with self._lock:
            self._wanted = False
            if not self._stop_locked():
                raise RuntimeError("a reconciler is still running and could not be stopped")
            self._spawn_locked()
            self._wanted = True

    def stop_reconciler(self):
        with self._lock:
            self._wanted = False
            self._respawn_at = None
            return self._stop_locked()

    def reap_orphan(self):
        """Daemon start: a reconciler nobody supervises must not keep trading.
        True when nothing holds the lock afterwards."""
        with self._lock:
            fd = self._free_lock()
            if fd is None:
                _log("a reconciler from a previous daemon is still running and could not be stopped")
                return False
            os.close(fd)
            return True

    def info(self):
        """`running` is about the workspace, not about our own child: a
        reconciler we do not own still trades."""
        with self._lock:
            running = self._proc is not None and self._proc.poll() is None
            pid, orphan = (self._proc.pid if running else None), False
            if not running:
                fd = self._try_lock()
                if fd is None:
                    running = orphan = True
                    pid = self._orphan_pid()
                else:
                    os.close(fd)
            return {"wanted": self._wanted, "running": running, "orphan": orphan,
                    "pid": pid,
                    "restarts": self.restarts, "last_exit_code": self.last_exit_code,
                    "last_exit_at": self.last_exit_at}

    def tick(self):
        """Crash recovery; called about once a second."""
        with self._lock:
            if not self._wanted or self._proc is None or self._proc.poll() is None:
                return
            if self._respawn_at is None:
                self.last_exit_code = self._proc.returncode
                self.last_exit_at = int(time.time())
                self._respawn_at = time.time() + RESTART_DELAY_S
                _log(f"reconciler exited (code {self.last_exit_code}) — "
                     f"restarting in {RESTART_DELAY_S}s")
                return
            if time.time() < self._respawn_at:
                return
            self._respawn_at = None
            try:
                self._spawn_locked()
                self.restarts += 1
            except Exception as e:
                _log(f"reconciler restart failed: {type(e).__name__}: {e}")
                self._respawn_at = time.time() + RESTART_DELAY_S

    def _try_lock(self):
        os.makedirs(os.path.dirname(self._lock_path), exist_ok=True)
        fd = os.open(self._lock_path, os.O_CREAT | os.O_RDWR, 0o600)
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            return fd
        except OSError:
            os.close(fd)
            return None

    def _wait_lock(self, seconds):
        deadline = time.time() + seconds
        while True:
            fd = self._try_lock()
            if fd is not None or time.time() >= deadline:
                return fd
            time.sleep(0.2)

    def _orphan_pid(self):
        """The pid on file, only if that process really is a reconciler — after
        a reboot the number belongs to whatever got it next."""
        try:
            with open(self._pid_path) as f:
                pid = int(f.read().strip())
        except (OSError, ValueError):
            return None
        if pid <= 0 or "reconciler.py" not in self._pid_cmdline(pid):
            return None
        return pid if _pid_cwd(pid) == self.ws else None  # someone else's workspace

    def _free_lock(self):
        """fd holding the lock once nothing else does, else None."""
        fd = self._try_lock()
        if fd is not None:
            return fd
        pid = self._orphan_pid()
        if pid is None:
            return None
        _log(f"stopping a reconciler left by a previous daemon (pid {pid})")
        for sig, wait in ((signal.SIGTERM, STOP_GRACE_S), (signal.SIGKILL, 3)):
            try:
                os.kill(pid, sig)
            except OSError:
                pass
            fd = self._wait_lock(wait)
            if fd is not None:
                return fd
        return None

    def _stop_locked(self):
        p = self._proc
        if p is not None and p.poll() is None:
            p.terminate()
            try:
                p.wait(STOP_GRACE_S)
            except subprocess.TimeoutExpired:
                p.kill()
                try:
                    p.wait(3)
                except subprocess.TimeoutExpired:
                    return False
        if p is not None and p.stdin:
            p.stdin.close()
        self._proc = None
        fd = self._free_lock()  # ours is gone; this is about anyone else's
        if fd is None:
            return False
        os.close(fd)
        return True

    def _spawn_locked(self):
        fd = self._free_lock()
        if fd is None:
            raise RuntimeError("another reconciler holds the lock — not starting a second one")
        try:
            log_path = os.path.join(self.ws, "state", "reconciler.log")
            try:
                if os.path.getsize(log_path) > 5 * 1024 * 1024:
                    os.replace(log_path, log_path + ".1")
            except OSError:
                pass
            with open(log_path, "ab") as logf:
                # Through run_reconciler below, holding a pipe we never write
                # to: its EOF is how the reconciler learns this daemon is gone,
                # SIGKILL included.
                self._proc = subprocess.Popen(
                    [sys.executable, os.path.abspath(__file__), "--run-reconciler",
                     os.path.join("manager", "reconciler.py")],
                    cwd=self.ws, env=self._child_env(), stdin=subprocess.PIPE,
                    stdout=logf, stderr=logf, pass_fds=(fd,))
        finally:
            os.close(fd)  # the child's copy keeps the lock
        tmp = f"{self._pid_path}.{os.getpid()}.tmp"
        with open(tmp, "w") as f:
            f.write(str(self._proc.pid))
        os.replace(tmp, self._pid_path)
        _log(f"reconciler started (pid {self._proc.pid})")


class Daemon:
    def __init__(self, workspace, secret):
        self.ws = workspace
        self.secret = secret
        self.state = os.path.join(workspace, "state")
        self.in_dir = os.path.join(self.state, "local_cmd", "in")
        self.ack_dir = os.path.join(self.state, "local_cmd", "ack")
        self.status_path = os.path.join(self.state, "local_status.json")
        self.started_at = int(time.time())
        self.stop = threading.Event()
        self.dirty = threading.Event()
        self.account_kick = threading.Event()
        self._status_lock = threading.Lock()
        self._seen = {}     # id -> taken at; the replay memory (see parse_command)
        self._ignored = set()  # non-regular entries in in/ we could not remove

        import command_listener as cl
        import events
        import portfolio_reporter
        self.cl, self.events, self.reporter = cl, events, portfolio_reporter
        self.sup = ReconcilerSupervisor(workspace, cl._local_child_env, cl._pid_cmdline)
        try:
            with open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "VERSION")) as f:
                self.version = f.read().strip()
        except OSError:
            self.version = None

    # — acks —
    def _ack_path(self, cid):
        return os.path.join(self.ack_dir, f"{cid}.json")

    def write_ack(self, cmd_id, cmd, ok, result=None, error=None):
        """Drop-in for command_listener._send_ack (same signature, same shape)."""
        doc = {"id": cmd_id, "cmd": cmd, "ok": bool(ok), "ts": int(time.time())}
        doc["result" if ok else "error"] = result if ok else error
        try:
            _write_json_atomic(self._ack_path(cmd_id), doc)
        except (OSError, TypeError, ValueError) as e:
            _log(f"ack write failed: {type(e).__name__}")

    def _prune_acks(self):
        cutoff = time.time() - ACK_KEEP_S
        try:
            for name in os.listdir(self.ack_dir):
                p = os.path.join(self.ack_dir, name)
                if os.path.getmtime(p) < cutoff:
                    os.remove(p)
        except OSError:
            pass

    # — command loop —
    def _pending(self):
        try:
            names = [n for n in os.listdir(self.in_dir) if n.endswith(".json")]
        except OSError:
            return []
        paths = [os.path.join(self.in_dir, n) for n in names]

        def _mt(p):
            try:
                return os.path.getmtime(p)
            except OSError:
                return 0
        return sorted(paths, key=lambda p: (_mt(p), p))

    def _read_command_file(self, path):
        """bytes of a REGULAR file, else None. in/ is writable by anything the
        user runs: a FIFO there would park a plain open() forever (and with it
        `halt`), a directory named x.json would be retried twice a second."""
        try:
            fd = os.open(path, os.O_RDONLY | os.O_NONBLOCK | os.O_NOFOLLOW)
        except OSError:
            fd = None
        try:
            if fd is not None and stat.S_ISREG(os.fstat(fd).st_mode):
                return os.read(fd, MAX_BYTES + 1)
        except OSError:
            return None
        finally:
            if fd is not None:
                os.close(fd)
        try:
            if os.path.isdir(path) and not os.path.islink(path):
                os.rmdir(path)
            else:
                os.remove(path)
        except OSError:
            if path not in self._ignored:
                self._ignored.add(path)
                _log("ignoring a non-file entry in the command queue")
        return None

    def _reject(self, stem, why):
        """Failure ack for a file that never reached dispatch — never over an
        ack that is already there (O_EXCL): a junk file named after a finished
        command must not turn its success into a failure."""
        _log(f"rejected a command file: {why}")
        if not _ID_RE.fullmatch(stem):
            return
        doc = {"id": stem, "cmd": None, "ok": False, "ts": int(time.time()),
               "error": f"Rejected: {why}"}
        try:
            fd = os.open(self._ack_path(stem), os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        except OSError:
            return
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(doc, f, ensure_ascii=False)

    def handle_file(self, path):
        if path in self._ignored:
            return
        stem = os.path.basename(path)[:-len(".json")]
        raw = self._read_command_file(path)
        if raw is None:
            return
        # Removed BEFORE dispatch, like the cloud's BLPOP: a crash mid-command
        # must not replay it on the next start — the user presses again.
        try:
            os.remove(path)
        except OSError as e:
            _log(f"could not remove a command file ({type(e).__name__}) — not running it")
            return
        now = time.time()
        for k in [k for k, t in self._seen.items() if now - t > SEEN_KEEP_S]:
            del self._seen[k]
        try:
            command = parse_command(raw, stem, self.secret, now, self._seen.__contains__,
                                    not_before=self.started_at - 1)
        except Rejected as e:
            self._reject(stem, str(e))
            return
        self._seen[command["id"]] = now  # before dispatch: covers deferred commands too
        cid, cmd = command["id"], command["cmd"]
        cl = self.cl
        try:
            result = cl.dispatch(command)
            if isinstance(result, cl.Deferred):
                _log(f"{cmd} {cid} deferred")
                threading.Thread(target=cl._run_deferred, args=(cid, cmd, result),
                                 daemon=True, name="command-deferred").start()
                return
            _log(f"{cmd} {cid} ok: {result}")
            self.write_ack(cid, cmd, True, result, None)
        except Exception as e:
            err = f"{type(e).__name__}: {e}"  # handlers raise shapes, not contents
            _log(f"{cmd} {cid} FAILED: {err}")
            self.write_ack(cid, cmd, False, None, err)
        finally:
            self.dirty.set()
            self.account_kick.set()

    # — status —
    def write_status(self):
        with self._status_lock:
            try:
                doc = self.reporter.build_report()
            except Exception as e:
                _log(f"status build failed: {type(e).__name__}: {e}")
                doc = {"error": f"{type(e).__name__}"}
            doc["daemon"] = {
                "pid": os.getpid(), "started_at": self.started_at,
                "heartbeat_at": int(time.time()), "version": self.version,
                "signed": bool(self.secret), "reconciler": self.sup.info(),
            }
            try:
                _write_json_atomic(self.status_path, doc)
            except (OSError, TypeError, ValueError) as e:
                _log(f"status write failed: {type(e).__name__}")
            else:
                _slide_events(self.events, doc.get("events"))

    def _status_loop(self):
        last_rotate = time.time()
        while not self.stop.is_set():
            self.write_status()
            if self.dirty.wait(timeout=STATUS_EVERY_S):
                self.dirty.clear()
                # a command's downstream effect (reconcile snapshot) lands a few
                # seconds later — same second look the cloud's report thread takes
                self.write_status()
                self.stop.wait(8)
            if time.time() - last_rotate > 3600:
                last_rotate = time.time()
                self.events.rotate()  # nothing acks locally; this is the 2MB cap only

    def _account_loop(self):
        """The cloud's once-a-minute account timer, plus an early read whenever
        a command ran or an order was logged — so the page shows a fill within
        seconds instead of at the next minute."""
        reader = os.path.join(os.path.dirname(os.path.abspath(__file__)), "account_reader.py")
        orders = os.path.join(self.ws, "manager", "orders.jsonl")
        last_run, seen = 0.0, None
        while not self.stop.is_set():
            try:
                mtime = os.path.getmtime(orders)
            except OSError:
                mtime = None
            due = time.time() - last_run >= ACCOUNT_EVERY_S or mtime != seen \
                or self.account_kick.is_set()
            if due and self.cl._bound_venue():
                seen, last_run = mtime, time.time()
                self.account_kick.clear()
                try:
                    subprocess.run([sys.executable, reader], cwd=self.ws,
                                   env=self.cl._local_child_env(), stdin=subprocess.DEVNULL,
                                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                                   timeout=ACCOUNT_TIMEOUT_S)
                except (OSError, subprocess.SubprocessError) as e:
                    _log(f"account read failed: {type(e).__name__}")
                self.dirty.set()
            self.stop.wait(2)

    def _supervise_loop(self):
        while not self.stop.is_set():
            self.sup.tick()
            self.stop.wait(1)

    def _watch_parent(self):
        """The app that started us is gone. With no app there is no stop button
        and nobody to confirm anything, so trading stops with it — through the
        same stop event SIGTERM sets, so the reconciler is stopped and the last
        status written either way."""
        why = _wait_parent_gone(self._ppid)
        time.sleep(0.2)  # a dying parent's pipes close a moment before we are re-parented
        if os.getppid() != self._ppid:
            # nobody reads our stderr any more; anything still printing to it
            # (command_listener does) must not raise mid-shutdown
            try:
                fd = os.open(os.devnull, os.O_WRONLY)
                os.dup2(fd, 2)
                os.close(fd)
            except OSError:
                pass
        _log(f"{why} — shutting down")
        self.stop.set()

    def run(self, watch_parent):
        cl = self.cl
        for d in (self.in_dir, self.ack_dir):
            os.makedirs(d, exist_ok=True)
        self.sup.reap_orphan()
        cl._LOCAL_HOST = self.sup
        # Real-money Binance opens for THIS process only. Every `credentials`
        # command that reaches it is HMAC-signed by the app, and the app's main
        # process runs its own permission check first for the UX
        # (shell/binance_link.js) — the one that decides is the writer's,
        # command_listener._binance_bind_check, which runs in every mode.
        # command_listener.LOCAL_OPEN_VENUES itself stays paper-only, so the
        # chat bind (lib/venue.bind, running in the agent's process) still
        # cannot bind a real exchange on the desktop — that is a product rule
        # (a key pasted in chat stays in the chat history), not a gap in the
        # permission check. That writer's rate-limit cooldown is module state
        # and this daemon imports it, so a desktop user pressing 連接 again is
        # held off the wire by the same window the cloud path uses — on top of
        # binance_link.js's own lock in the app process.
        cl.LOCAL_OPEN_VENUES = frozenset(cl.LOCAL_OPEN_VENUES | {"BINANCE"})
        cl._send_ack = self.write_ack  # the transport swap, ack side
        cl._ON_APPLIED = cl._ON_PROGRESS = self.dirty.set
        cl._resume_mgmt_watch()
        loops = [cl._scheduler_loop, self._status_loop, self._account_loop,
                 self._supervise_loop]
        if watch_parent:
            self._ppid = os.getppid()
            loops.append(self._watch_parent)
        for fn in loops:
            threading.Thread(target=fn, daemon=True, name=fn.__name__).start()
        _log(f"started (pid {os.getpid()}, signed={bool(self.secret)})")
        last_beat = last_prune = 0.0
        while not self.stop.is_set():
            now = time.time()
            if now - last_beat >= 5:
                last_beat = now
                cl._beat()
            if now - last_prune >= 600:
                last_prune = now
                self._prune_acks()
            for path in self._pending():
                self.handle_file(path)
            self.stop.wait(POLL_S)
        _log("stopping")
        if not self.sup.stop_reconciler():
            _log("reconciler not confirmed stopped")
        self.write_status()


def _link_current(base):
    """<base>/current = this runtime dir — the cloud layout lib/events,
    lib/venue and two handlers resolve the runtime through. A real directory
    there is someone else's and is left alone; a link is re-pointed every start
    (a moved .app leaves it dangling)."""
    here = os.path.dirname(os.path.abspath(__file__))
    link = os.path.join(base, "current")
    # On a cloud box `current` IS a symlink (the updater swaps releases through
    # it) — main() refuses to run there at all, so by here a link is ours.
    if os.path.lexists(link) and not os.path.islink(link):
        return
    try:
        if os.path.islink(link) and os.path.realpath(link) == os.path.realpath(here):
            return
        tmp = f"{link}.{os.getpid()}.tmp"
        os.symlink(here, tmp)
        os.replace(tmp, link)
    except OSError as e:
        _log(f"could not link {link}: {type(e).__name__}")


def _read_line_fd0():
    """First line of stdin, byte by byte off the raw fd — nothing may be left in
    a Python-side buffer, or _watch_parent's EOF read would race it."""
    out = bytearray()
    while len(out) < 4096:
        b = os.read(0, 1)
        if not b or b == b"\n":
            break
        out += b
    return out.decode("utf-8", "replace").strip()


def main(argv=None):
    argv = sys.argv[1:] if argv is None else argv
    if fcntl is None:
        _log("needs a POSIX system")
        return 2
    if argv[:1] == ["--run-reconciler"] and len(argv) == 2:
        run_reconciler(argv[1])
        return 0
    # The app sets the switch; this file never does. Started by hand or by a
    # cloud unit without it, the daemon must not re-point <base>/current or
    # take over a machine that systemd already runs.
    if os.environ.get("BLAVE_AGENT_LOCAL") != "1":
        _log("BLAVE_AGENT_LOCAL=1 is not set — this is not a desktop install, not starting")
        return 2
    base = os.environ.get("BLAVE_AGENT_BASE") or ""
    ws = os.environ.get("BLAVE_AGENT_WORKSPACE") or ""
    # no /opt/blave-agent fallback here: a desktop daemon pointed at nothing
    # must not go looking for a workspace on its own
    if not (os.path.isabs(base) and os.path.isabs(ws) and os.path.isdir(ws)):
        _log("BLAVE_AGENT_BASE / BLAVE_AGENT_WORKSPACE must be absolute, existing paths")
        return 2
    if os.path.exists(os.path.join(base, "control")):
        _log("<base>/control exists — this is a cloud machine, not starting")
        return 2
    secret = ""
    if "--secret-stdin" in argv:
        secret = _read_line_fd0()
        if len(secret) < SECRET_MIN_CHARS:
            _log(f"secret on stdin must be at least {SECRET_MIN_CHARS} characters")
            return 2
    single = SingleInstance(os.path.join(ws, "state", "local_daemon.lock"))
    if not single.acquire():
        _log("another local daemon already owns this workspace — exiting")
        return 3
    os.chdir(ws)
    _link_current(base)
    daemon = Daemon(ws, secret)
    for sig in (signal.SIGTERM, signal.SIGINT):
        signal.signal(sig, lambda *_: daemon.stop.set())
    daemon.run(watch_parent="--secret-stdin" in argv)
    return 0


if __name__ == "__main__":
    sys.exit(main())
