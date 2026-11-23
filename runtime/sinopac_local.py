"""永豐 (SinoPac) futures on the desktop app: lib/sinopac_worker.py as local_daemon's child.

The desktop counterpart of the cloud's blave-agent-sinopac.service (runtime/sinopac_service.py),
in the shape of capital_local's _LocalWorker. What differs, because this worker holds the one
Shioaji login of the user's national id and sends the orders:

  wanted    the cloud's rule, sinopac_service.wanted (gate open, bound through the connect flow,
            no STOP record), plus the app having handed over the credentials for exactly this
            binding; checked every WANTED_EVERY_S: an unbind stops it, a confirmed login (which
            clears STOP) starts it. The credentials go to the worker as its first stdin line.
  respawn   RESPAWN_S after any exit — the worker also spaces its own logins across restarts
            (its login record) — and only every UNVERIFIED_RESPAWN_S after UNVERIFIED_EXIT.
  stop      by closing its stdin (lib/sinopac_worker STOP_ON_EOF): it logs out between requests
            and exits. On Windows nothing else reaches its finally (terminate() is
            TerminateProcess, and reaches the venv launcher only), so the tree is killed only
            once STOP_GRACE_S has passed. A daemon that dies closes the pipe as well.
  log       SJ_LOG_PATH is the null device in its environment: shioaji's own log prints the
            national id. The worker's stdout (masked by its quiet_sdk) goes to state/.
"""
import base64
import hashlib
import hmac
import json
import os
import re
import signal
import subprocess
import sys
import threading
import time

import atomic_file
import sinopac_service
import venue_traits

WORKSPACE = os.environ.get("BLAVE_AGENT_WORKSPACE", "/opt/blave-agent/workspace")
UNVERIFIED_EXIT = 4                          # = lib/sinopac_worker.UNVERIFIED_EXIT
STOP_ON_EOF = "BLAVE_SINOPAC_STOP_ON_EOF"    # = lib/sinopac_worker.STOP_ON_EOF
RESPAWN_S = 60
UNVERIFIED_RESPAWN_S = 1800
STOP_GRACE_S = 20  # a request in flight confirms within its own deadline; logout takes seconds
SHUTDOWN_WAIT_S = 2
WANTED_EVERY_S = 5
LOG_MAX = 5 * 1024 * 1024


def _paths():
    return {"worker": os.path.join(WORKSPACE, sinopac_service.WORKER),
            "pid": os.path.join(WORKSPACE, "state", "sinopac_worker.pid"),
            "log": os.path.join(WORKSPACE, "state", "sinopac_worker.log")}


def _cl():
    import command_listener
    return command_listener


def _kill(p):
    """Past the grace: the tree on Windows (the venv launcher's child holds the session)."""
    if os.name == "nt":
        import capital_local
        capital_local._kill_tree(p.pid)
    try:
        p.kill()
    except OSError:
        pass


def _drop_pid():
    try:
        os.remove(_paths()["pid"])
    except OSError:
        pass


class _Worker:
    def __init__(self):
        self.proc = None
        self.respawn_at = 0.0
        self.stop_by = None   # kill deadline of a stop asked for
        self.check_at = 0.0
        self.started_at = None  # when the running worker was spawned (the app's 「連接中…」 grace)
        self.lock = threading.Lock()

    def running(self):
        return self.proc is not None and self.proc.poll() is None

    def tick(self, now=None):
        now = time.time() if now is None else now
        with self.lock:
            p = self.proc
            if p is not None and p.poll() is not None:
                self.respawn_at = now + (UNVERIFIED_RESPAWN_S if p.returncode == UNVERIFIED_EXIT else RESPAWN_S)
                self.proc, self.stop_by = None, None
                _drop_pid()
            if self.stop_by is not None:
                if now >= self.stop_by and self.running():
                    _kill(self.proc)
                return
            if now < self.check_at:
                return
            self.check_at = now + WANTED_EVERY_S
            ok, _why = sinopac_service.wanted(WORKSPACE)
            if ok is None:
                return
            # and handed over by the app for exactly this binding (a rebind elsewhere, or none yet)
            ok = ok and _SEAL["secrets"] is not None and _env_bound_to(_SEAL["secrets"])
            if not ok:
                if self.running():
                    self._ask_stop(now)
                return
            if self.proc is None and now >= self.respawn_at:
                try:
                    self._spawn()
                except OSError as e:
                    print(f"[sinopac_local] worker not started ({type(e).__name__})", file=sys.stderr)
                    self.respawn_at = now + RESPAWN_S

    def _spawn(self):
        cl, p = _cl(), _paths()
        os.makedirs(os.path.dirname(p["log"]), exist_ok=True)
        try:
            if os.path.getsize(p["log"]) > LOG_MAX:
                os.replace(p["log"], p["log"] + ".1")
        except OSError:
            pass
        line = secret_line()
        if not line:
            raise OSError("no credentials handed over")
        env = cl._local_child_env(**{STOP_ON_EOF: "1", "SJ_LOG_PATH": os.devnull, **_CHILD_FLAGS})
        with atomic_file.open_append(p["log"]) as logf:
            # the credentials are the first line; then the pipe stays open: closing it is the stop request
            self.proc = subprocess.Popen([sys.executable, p["worker"]], cwd=WORKSPACE, env=env,
                                         stdout=logf, stderr=logf, **cl._child_kw(stdin=subprocess.PIPE))
        self.started_at = time.time()
        try:
            self.proc.stdin.write((line + "\n").encode("utf-8"))
            self.proc.stdin.flush()
        except OSError:
            pass  # it died at once: reaped by the next tick
        try:
            with atomic_file.replacing(p["pid"]) as f:
                f.write(str(self.proc.pid))
        except OSError:
            pass

    def _ask_stop(self, now):
        try:
            self.proc.stdin.close()
        except (OSError, AttributeError):
            pass
        self.stop_by = now + STOP_GRACE_S

    def stop_now(self, why=""):
        """An unbind or rebind: ask it to leave now (the next tick kills it past STOP_GRACE_S)."""
        with self.lock:
            if self.running() and self.stop_by is None:
                self._ask_stop(time.time())

    def shutdown(self, wait=None):
        """The daemon is leaving: ask and wait briefly, never kill. The app kills the daemon
        9 s after asking (shell/daemon.js stop) and the reconciler's stop comes after this; a
        worker still logging out finishes on its own, and one that hung is reaped at the next
        start. The pid file stays for that."""
        wait = SHUTDOWN_WAIT_S if wait is None else wait
        with self.lock:
            p, self.proc, self.stop_by = self.proc, None, None
        if p is None or p.poll() is not None:
            _drop_pid()
            return
        try:
            p.stdin.close()
        except (OSError, AttributeError):
            pass
        try:
            p.wait(wait)
            _drop_pid()
        except subprocess.TimeoutExpired:
            pass

    def reap_orphan(self, pid_cmdline, grace=None):
        """A worker left by a daemon that died: its stdin pipe closed with that daemon, so it is
        logging out on its own — waited for (a second worker would be a second login), killed past
        the grace. Before this daemon's first tick."""
        grace = STOP_GRACE_S if grace is None else grace
        p = _paths()
        try:
            with open(p["pid"]) as f:
                pid = int(f.read().strip())
        except (OSError, ValueError):
            return
        target = os.path.abspath(p["worker"])

        def ours():
            try:
                cmd = pid_cmdline(pid) if pid > 0 else ""
            except Exception:
                cmd = ""
            return "sinopac_worker.py" in cmd and target in cmd

        deadline = time.time() + grace
        while ours() and time.time() < deadline:
            time.sleep(0.5)
        if ours():
            if os.name == "nt":
                import capital_local
                capital_local._kill_tree(pid)
            else:
                try:
                    os.kill(pid, signal.SIGKILL)
                except OSError:
                    pass
        _drop_pid()


_W = _Worker()


def local_tick():
    _W.tick()


def local_shutdown():
    _W.shutdown()


def reap_orphan(pid_cmdline):
    _W.reap_orphan(pid_cmdline)


# ── credentials (desktop): the app's encrypted store → this process's memory → the worker's stdin ──
# The app seals {api_key, secret_key, person_id, ca_password, live[, src]} with a key derived from
# the daemon's HMAC secret (president_connect / capital_local: same scheme, its own info string, so
# a 統一 or 群益 payload never opens here) and sends it in `sinopac_local`:
#   bind     {sealed + src}: the .pfx the user chose is opened HERE with the CA password (the
#            national id when ca_password is ""), copied to credentials/sinopac.pfx, .env gets the
#            sentinels (sinopac_service.store) — no login
#   secrets  {sealed}: re-sent after every daemon start; refused unless .env was bound with it
#   setup / probe / sim_test / start: runtime/sinopac_connect's steps (local=True). probe is the
#            user's 「確認登入」: `sinopac_worker.py --once` with the credentials as its stdin line —
#            a pass clears a login STOP, and the supervisor starts the worker again
#   stop     the worker is no longer wanted (it leaves between requests)
# Every op but bind / secrets answers later (Deferred); progress is state/sinopac_connect.json
# (the report's `sinopac_connect`).
# The agent runs as the same user and gets nothing it could log in with: .env holds sentinels.
LOCAL_OPS = ("bind", "secrets", "setup", "probe", "sim_test", "start", "stop")
_SEAL_INFO = b"sinopac-local-seal-v1"
_SEAL_AAD = b"sinopac-local-v1"
SEALED_MAX_CHARS = 8192
_ID_RE = re.compile(r"^[A-Z][0-9A-D][0-9]{8}$")  # designer sinopac-connect f-id-bad
_KEY_RE = re.compile(r"^[^\s\0]{1,256}$")
_CHILD_FLAGS = {"BLAVE_SINOPAC_STDIN": "1", "BLAVE_SINOPAC_LOCAL": "1"}  # = lib/sinopac_vault
_SEAL = {"key": None, "secrets": None}


class Refused(ValueError):
    def __init__(self, code, text=""):
        super().__init__(f"{code}: {text}" if text else code)
        self.code = code


def set_seal_key(daemon_secret):
    _SEAL["key"] = (hmac.new(daemon_secret.encode(), _SEAL_INFO, hashlib.sha256).digest()
                    if daemon_secret else None)


def open_sealed(blob):
    """base64(nonce 12 ‖ ciphertext ‖ tag 16) → dict; any failure is one code."""
    if not _SEAL["key"]:
        raise Refused("NO_SEAL", "this daemon was started without a secret")
    if not isinstance(blob, str) or not 0 < len(blob) <= SEALED_MAX_CHARS:
        raise Refused("SEAL_INVALID")
    import capital_connect as cc
    try:
        raw = base64.b64decode(blob, validate=True)
        d = json.loads(cc._crypto()["AESGCM"](_SEAL["key"]).decrypt(raw[:12], raw[12:], _SEAL_AAD))
    except ValueError as e:
        if str(e).startswith("CRYPTO_MISSING"):
            raise
        raise Refused("SEAL_INVALID")
    except Exception:
        raise Refused("SEAL_INVALID")
    if not isinstance(d, dict):
        raise Refused("SEAL_INVALID")
    return d


def _bundle(d, need_src=False):
    key, sec, pid, ca, live = (d.get("api_key"), d.get("secret_key"), d.get("person_id"),
                               d.get("ca_password"), d.get("live"))
    if not (isinstance(key, str) and _KEY_RE.fullmatch(key)) or not (isinstance(sec, str) and _KEY_RE.fullmatch(sec)):
        raise Refused("BAD_ARGS", "API key / secret")
    if not (isinstance(pid, str) and _ID_RE.fullmatch(pid)):
        raise Refused("BAD_ARGS", "national id format")
    if not (isinstance(ca, str) and len(ca) <= 128 and not re.search(r"[\r\n\0]", ca)):
        raise Refused("BAD_ARGS", "certificate password")
    if not isinstance(live, bool):
        raise Refused("BAD_ARGS", "live must be true or false")
    out = {"api_key": key, "secret_key": sec, "person_id": pid, "ca_password": ca, "live": live}
    if need_src and "src" in d:  # absent: 〔改金鑰〕 keeps the certificate already stored (_bind)
        src = d.get("src")
        if not (isinstance(src, str) and os.path.isabs(src) and src.lower().endswith(".pfx")
                and "\0" not in src and len(src) <= 1024):
            raise Refused("BAD_ARGS", "certificate file")
        out["src"] = src
    return out


# The steps that log in with what this daemon holds (= shell/sinopac_local.js LOGIN_OPS): each carries
# `expect`, the set the app last saved, sealed the same way. Not setup / stop (no login), not bind /
# secrets (they hand over the set themselves).
_LOGIN_OPS = ("probe", "sim_test", "start")


def _held_matches(blob):
    """A login step runs only when this daemon holds the set the app saved last (same rule as
    president_connect._held_matches, 0.1.57): a bind the app saw as SENT may still have failed here,
    leaving the old key or certificate password, and a login with it is a wrong-credential login
    against the user's national id."""
    s = _SEAL["secrets"]
    if s is None:
        raise Refused("NO_SECRETS", "the app has not handed over the 永豐 credentials")
    want = _bundle(open_sealed(blob))
    # an empty certificate password means the national id (_bind stores it filled in)
    eff = lambda b: dict(b, ca_password=b["ca_password"] or b["person_id"])  # noqa: E731
    want, s = eff(want), eff(s)
    same = all(hmac.compare_digest(want[k].encode(), s[k].encode())
               for k in ("api_key", "secret_key", "person_id", "ca_password"))
    if not same or not _env_bound_to(s):
        raise Refused("SECRETS_STALE", "this computer still holds other 永豐 credentials — connect again")


def _env_bound_to(b):
    try:
        env = sinopac_service.env_values(WORKSPACE)
    except (OSError, ValueError):
        return False
    return env.get("sinopac_api_key") == sinopac_service.bound_env(b["api_key"], b["secret_key"], WORKSPACE)["sinopac_api_key"]


def secret_line():
    """The worker's stdin line (lib/sinopac_vault.take_local_line); "" = nothing handed over."""
    s = _SEAL["secrets"]
    if not s:
        return ""
    return json.dumps({"sinopac_api_key": s["api_key"], "sinopac_secret_key": s["secret_key"],
                       "sinopac_ca_passwd": s["ca_password"] or s["person_id"],
                       "sinopac_person_id": s["person_id"], "live": s["live"]})


def _set_secrets(b):
    _SEAL["secrets"] = {k: b[k] for k in ("api_key", "secret_key", "person_id", "ca_password", "live")}


def _bind(b):
    """The file the user chose, opened here with the one-field rule (sinopac_connect.open_pfx), then
    stored; no login. A refusal leaves whatever was bound before untouched."""
    import sinopac_connect
    path = b.get("src") or sinopac_service.paths(WORKSPACE)["pfx"]
    try:
        with open(path, "rb") as f:
            data = f.read(sinopac_connect.cc.PFX_MAX_BYTES + 1)
    except OSError:
        if "src" not in b:
            raise Refused("NO_CERT", "no certificate stored on this computer — choose the .pfx file")
        raise Refused("READ_FAILED", "the certificate file could not be read")
    try:
        sinopac_connect.open_pfx(data, b)  # before the worker is stopped: a wrong password changes nothing
    except ValueError as e:
        # the form's error lives in the status too: cert.error, and cert.not_after for PFX_EXPIRED
        code = sinopac_connect.cc._code(e, "PFX_INVALID")
        na = getattr(e, "not_after", None)
        sinopac_connect._update("cert", error=code, not_after=na)
        raise Refused(code, f"not_after {na}" if na else "")
    _W.stop_now("rebinding")
    out = sinopac_connect.store_cert(data, b, local=True)
    _set_secrets(dict(b, ca_password=b["ca_password"] or b["person_id"]))
    return out


def kill_tree(p):
    """A child holding the credentials line: its whole tree (the venv launcher's interpreter on
    Windows, its own session on POSIX)."""
    if os.name == "nt":
        import capital_local
        capital_local._kill_tree(p.pid)
    else:
        try:
            os.killpg(p.pid, signal.SIGKILL)
        except OSError:
            pass
    try:
        p.kill()
    except OSError:
        pass


def local_dispatch(args, deferred_cls=None, push=None):
    """command_listener's handler for `sinopac_local` (desktop only; local_daemon.LOCAL_ONLY)."""
    if os.environ.get("BLAVE_AGENT_LOCAL") != "1":
        raise Refused("NOT_LOCAL", "sinopac_local runs on the desktop app only")
    op = args.get("op") if isinstance(args, dict) else None
    allowed = {"op", "sealed"} if op in ("bind", "secrets") else {"op", "expect"} if op in _LOGIN_OPS else {"op"}
    if op not in LOCAL_OPS or set(args) - allowed or (op in _LOGIN_OPS and "expect" not in args):
        raise Refused("BAD_ARGS", "unknown sinopac_local shape")
    if "futures" not in venue_traits.verified_modes(sinopac_service.VENUE):
        raise Refused("NOT_OPEN", "永豐 futures is not open yet")
    if op == "secrets":
        b = _bundle(open_sealed(args.get("sealed")))
        if not _env_bound_to(b):
            raise Refused("REBOUND", "this computer's .env is bound to other 永豐 credentials")
        _set_secrets(b)
        return {"secrets": "ok"}
    if op == "bind":
        return _bind(_bundle(open_sealed(args.get("sealed")), need_src=True))
    if op == "stop":
        _drop_wanted()
        _W.stop_now("asked")
        return {"worker": "stopped"}
    import sinopac_connect as sc
    if op == "setup":
        return sc.start_step("sinopac_local:setup", lambda: sc.run_setup(True, push), deferred_cls)
    try:
        sc.need_bound(op)
    except ValueError as e:
        raise Refused(sc.cc._code(e, "NOT_BOUND"), "connect 永豐 first")
    if not secret_line():
        raise Refused("NO_SECRETS", "the app has not handed over the 永豐 credentials")
    _held_matches(args["expect"])
    if _W.running():
        # one login per national id at a time on this machine: the worker holds it
        raise Refused("WORKER_RUNNING", "the 永豐 worker is logged in")
    if op == "probe":
        return sc.start_step("sinopac_local:probe", lambda: sc.run_probe(True, push), deferred_cls)
    if op == "sim_test":
        if not sc.sim_window_open(True):
            sc._update("sim", next_open_at=sc.next_sim_open(True))
            raise Refused("SIM_CLOSED", "the simulation test runs weekdays 08:00–20:00 Taipei")
        return sc.start_step("sinopac_local:sim_test", lambda: sc.run_sim_test(True, push), deferred_cls)
    if ((sc.read_status() or {}).get("probe") or {}).get("state") != "ok":
        raise Refused("PROBE_NOT_OK", "the production login has not passed yet")
    return sc.start_step("sinopac_local:start", lambda: sc.run_finish(True, push), deferred_cls)


def _drop_wanted():
    try:
        os.remove(os.path.join(WORKSPACE, sinopac_service.WANTED))
    except FileNotFoundError:
        pass


def local_info():
    """The daemon status doc's `sinopac_local`: `needs_secrets` true = .env is bound through the
    connect flow but this daemon holds no bundle for it (a restart) — the app re-sends `secrets`.
    `worker_started_at`: the running worker's spawn (epoch s), None when none runs."""
    try:
        bound = sinopac_service.bound(WORKSPACE) is True
    except Exception:
        bound = False
    have = _SEAL["secrets"] is not None and _env_bound_to(_SEAL["secrets"])
    running = _W.running()
    return {"secrets": have, "needs_secrets": bound and not have, "worker_running": running,
            "worker_started_at": _W.started_at if running else None}


def drop_local(names):
    """credentials_remove / eviction hook: unbinding 永豐 forgets the bundle and stops the worker."""
    if names is not None and not any(str(n).casefold().startswith("sinopac_") for n in names):
        return
    _SEAL["secrets"] = None
    _W.stop_now("unbound")
