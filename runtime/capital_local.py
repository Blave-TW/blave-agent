"""群益 (Capital) on the desktop app: the machine side of `capital_local`.

The desktop counterpart of runtime/capital_connect.py's cloud steps, in the
shape of president_connect's desktop segment: one command only the app's main
process sends (local_daemon.LOCAL_ONLY, shell/daemon.js MAIN_ONLY_COMMANDS),
every long step a Deferred whose outcome lands in
state/capital_local_connect.json — the report's `capital_local_connect`, the
one status the app's connect modal reads.

Everything runs as the signed-in Windows user. That is the point: SKCOM reads
the certificate from the CALLER's CurrentUser\\My (602 otherwise), and the
certificate step (shell/capital_local.js) put it there as this same user. So
no schtasks vehicle, no Administrator password, no NSSM service — the worker is
this daemon's child (an NSSM service would run with a store that has no
certificate in it).

  setup    the 群益 component, per-user: VC++ 2010 (Microsoft's redist, one UAC
           prompt, only when mfc100/msvcr100 are missing), comtypes into this
           venv (pinned), SKCOM from the pinned zip (SHA256) under %LOCALAPPDATA%\\Blave\\capital (ACL:
           this user only; every file compared with the zip each setup) — the path lib/capital_vault
           .skcom_dll hands the worker and the order lib on the desktop — registered with
           `regsvr32 /s /n /i:user` (HKCU, no UAC), then CreateObject checked.
           Same steps the M0 kit ran on desktop-win-test-4 (2026-10-19).
  bind     {sealed: {id, pw}}: .env gets the sentinels (capital_api_key empty,
           capital_password vault:<fingerprint>) through the ordinary credentials
           write, gated (local_bind_gate) to exactly what this step checked; the
           real values stay in this process's memory and reach a child only as
           one stdin line (lib/capital_vault STDIN_FLAG).
  secrets  {sealed}: a restarted daemon is empty-handed — the app hands the same
           bundle back; refused unless .env is bound to exactly it.
  probe    `lib/capital_worker.py --once` as this user; {after_unlock: true} = the
           one retry after a 307 (capital_connect.grant_unlock_retry). The
           wrong-password guard is capital_connect's, unchanged: it keys on the
           .env sentinel's fingerprint, which holds here too.
  start    `lib/capital_worker.py` as a supervised child; ok once it wrote a good
           snapshot. Never restarted after a 300/307 (it exits LOGIN_STOPPED_EXIT).
  stop     the worker, now.

Never put a secret, the national ID, a certificate subject or a broker message
into a return value, an exception, the status or a log.
"""
import base64
import ntpath
import hashlib
import hmac
import json
import os
import re
import shutil
import signal
import subprocess
import sys
import tempfile
import threading
import time
import urllib.request
import zipfile

import atomic_file
import capital_connect as cc

WORKSPACE = os.environ.get("BLAVE_AGENT_WORKSPACE", "/opt/blave-agent/workspace")
IS_WINDOWS = os.name == "nt"

LOCAL_OPS = ("setup", "bind", "secrets", "probe", "start", "stop")
_SEAL_INFO = b"capital-local-seal-v1"
_SEAL_AAD = b"capital-local-v1"
SEALED_MAX_CHARS = 8192
# = shell/cloud_capital.js ID_RE / PW_RE (the web's too): 身分證, 新式 / 舊式居留證號; the password is not trimmed
_ID_RE = re.compile(r"^[A-Z][1289A-D]\d{8}$")
_PW_RE = re.compile(r"^[^\r\n]{1,64}$")
_ID_KEY, _PW_KEY = "capital_api_key", "capital_password"
_CHILD_FLAGS = {"BLAVE_CAPITAL_STDIN": "1"}   # = lib/capital_vault.STDIN_FLAG
LOGIN_STOPPED_EXIT = 3                         # = lib/capital_worker.LOGIN_STOPPED_EXIT
LOCAL_RESPAWN_S = 10
LOCAL_DRAIN_S = 5
PROBE_TIMEOUT_S = 120
SETUP_TIMEOUT_S = 1200
START_TIMEOUT_S = 150

# M0 kit m0_setup.ps1 (2026-10-19, run on desktop-win-test-4): the component and Microsoft's runtime
# per-user (%LOCALAPPDATA%\Blave\capital, ACL narrowed to this user + SYSTEM + Administrators): C:\ root
# is writable by every local account, and SKCOM runs inside the processes that hold the credentials.
# = lib/capital_vault.local_dir (the worker, the probe and the order lib load from there)
def local_dir():
    if not os.environ.get("LOCALAPPDATA"):
        return None
    return os.path.join(os.environ["LOCALAPPDATA"], "Blave", "capital")


COMTYPES_PIN = "comtypes==1.4.17"
# PyPI 的 comtypes-1.4.17-py3-none-any.whl(10-20 下載核過);pip 只裝得到這一份,索引被換掉就裝不起來
COMTYPES_SHA256 = "4e0a221dde2c589b82977bed802efd71cd5eb67a380347b732e02735e597f586"


# 系統程式一律走 System32 絕對路徑:CreateProcess 沒給路徑時會先找直譯器目錄與目前目錄(daemon 的 cwd 是
# agent 寫得到的 workspace),同名 exe 會以用戶本人身分被執行(含 UAC 那一步)。= shell/winsandbox.js 的做法;
# SystemRoot 不像 `X:\<一層>` 就用 C:\Windows
_ROOT_RE = re.compile(r"[A-Za-z]:\\[^\\/:*?\"<>|\r\n]+")


def _sys32(*parts):
    root = os.environ.get("SystemRoot") or ""
    if not _ROOT_RE.fullmatch(root) or (IS_WINDOWS and not os.path.isdir(ntpath.join(root, "System32"))):
        root = "C:\\Windows"
    return ntpath.join(root, "System32", *parts)


def _powershell():
    return _sys32("WindowsPowerShell", "v1.0", "powershell.exe")   # the M0 kit's, run against this SKCOM on desktop-win-test-4 (2026-10-19)
CAP_ZIP_URL = "https://www.capital.com.tw/Service2/download/api_zip/CapitalAPI_2.13.59.zip"
CAP_ZIP_SHA256 = "e2b5894c148a847f051535c3700f00c2adc88beef4c471701b80d7b68b3470a9"
CAP_ZIP_MAX = 200 * 1024 * 1024
VC_URL = "https://download.microsoft.com/download/1/6/5/165255E7-1014-4D0A-B094-B6A430A6BFFC/vcredist_x64.exe"
VC_MAX = 64 * 1024 * 1024

_SECTIONS = ("setup", "probe", "worker")
_busy = threading.Lock()
_status_lock = threading.Lock()
_LOCAL = {"key": None, "secrets": None, "pending": None, "worker": None, "on_secrets": None}


def _paths():
    return {
        "status": os.path.join(WORKSPACE, "state", "capital_local_connect.json"),
        "probe": os.path.join(WORKSPACE, "state", "capital_probe.json"),
        "snapshot": os.path.join(WORKSPACE, "state", "capital_account.json"),
        "worker": os.path.join(WORKSPACE, "lib", "capital_worker.py"),
        "pid": os.path.join(WORKSPACE, "state", "capital_worker.pid"),
        "log": os.path.join(WORKSPACE, "state", "capital_worker.log"),
        "env": os.path.join(WORKSPACE, ".env"),
    }


def _refuse(code, text=""):
    raise ValueError(f"{code}: {text}" if text else code)


def _cl():
    import command_listener
    return command_listener


# ── status (state/capital_local_connect.json) ───────────────────────────────

def _blank():
    return {"v": 1, "updated_at": None, "busy": None, **{s: {"status": "idle", "at": None} for s in _SECTIONS}}


def read_status():
    """The report's `capital_local_connect`; None = never started on this computer."""
    try:
        with open(_paths()["status"], encoding="utf-8") as f:
            st = json.load(f)
    except (OSError, ValueError):
        return None
    return st if isinstance(st, dict) else None


def _update(section=None, create=True, reset=False, **fields):
    with _status_lock:
        st = read_status()
        if st is None:
            if not create:
                return None
            st = _blank()
        now = int(time.time())
        if section:
            cur = {} if reset or not isinstance(st.get(section), dict) else st[section]
            cur.update(fields, at=now)
            st[section] = cur
        else:
            st.update(fields)
        st["updated_at"] = now
        path = _paths()["status"]
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with atomic_file.replacing(path, encoding="utf-8") as f:
            json.dump(st, f)
        return st


# ── sealed bundle ────────────────────────────────────────────────────────────

def set_seal_key(daemon_secret):
    """local_daemon at start: the key the app seals capital_local payloads with
    (its own info string: a 統一 payload never opens here, nor the reverse)."""
    _LOCAL["key"] = (hmac.new(daemon_secret.encode(), _SEAL_INFO, hashlib.sha256).digest()
                     if daemon_secret else None)


def open_sealed(blob):
    if not _LOCAL["key"]:
        _refuse("NO_SEAL", "this daemon was started without a secret")
    if not isinstance(blob, str) or not 0 < len(blob) <= SEALED_MAX_CHARS:
        _refuse("SEAL_INVALID")
    try:
        raw = base64.b64decode(blob, validate=True)
        d = json.loads(cc._crypto()["AESGCM"](_LOCAL["key"]).decrypt(raw[:12], raw[12:], _SEAL_AAD))
    except ValueError as e:
        if str(e).startswith("CRYPTO_MISSING"):
            raise
        _refuse("SEAL_INVALID")
    except Exception:
        _refuse("SEAL_INVALID")
    if not isinstance(d, dict):
        _refuse("SEAL_INVALID")
    return d


def _bundle(d):
    login_id, pw = d.get("id"), d.get("pw")
    if not (isinstance(login_id, str) and _ID_RE.fullmatch(login_id)):
        _refuse("BAD_ID", "national ID format")
    if not (isinstance(pw, str) and _PW_RE.fullmatch(pw)):
        _refuse("BAD_PW", "trading password")
    return {"id": login_id, "pw": pw}


def _bound_env(b):
    return {_ID_KEY: "", _PW_KEY: "vault:" + cc.vault_fingerprint(b["id"], b["pw"])}


def local_bind_gate(env):
    """command_listener._cmd_credentials, desktop, venue CAPITAL: written only by
    the bind step, for exactly the bundle it holds. A chat bind never gets here
    with a pending bundle, so it is refused."""
    b = _LOCAL["pending"]
    want = _bound_env(b) if b else None
    got = {k.casefold(): v for k, v in env.items()}
    if not want or set(got) != set(want) or any(got.get(k) != v for k, v in want.items()):
        _refuse("NOT_CHECKED", "群益 is bound from the app's connect flow on this computer")


def _env_values():
    out = {}
    try:
        with open(_paths()["env"], encoding="utf-8") as f:
            for line in f.read().splitlines():
                k, _, v = line.partition("=")
                out[k.strip().casefold()] = v.strip().strip("'\"")
    except OSError:
        pass
    return out


def _env_bound_to(b):
    env = _env_values()
    return env.get(_PW_KEY) == _bound_env(b)[_PW_KEY]


def secrets():
    """The bundle handed to children, as the keys lib/capital_vault reads; {} = none."""
    s = _LOCAL["secrets"]
    return {_ID_KEY: s["id"], _PW_KEY: s["pw"]} if s else {}


def secret_line():
    s = secrets()
    return json.dumps(s) if s else ""


def child_flags():
    return dict(_CHILD_FLAGS) if _LOCAL["secrets"] else {}


def _set_secrets(b):
    _LOCAL["secrets"] = {"id": b["id"], "pw": b["pw"]}
    cb = _LOCAL["on_secrets"]
    if cb:
        try:  # the reconciler got its line at spawn: a new bundle needs a new reconciler
            cb()
        except Exception as e:
            print(f"[capital_local] reconciler respawn failed ({type(e).__name__})", file=sys.stderr)


# ── children ─────────────────────────────────────────────────────────────────

def _kill_tree(pid):
    """sys.executable in a venv is the launcher; the interpreter holding the
    credentials line is its child — kill the tree (president_connect learned this)."""
    try:
        if os.name == "nt":
            rc = subprocess.run([_sys32("taskkill.exe"), "/T", "/F", "/PID", str(pid)], capture_output=True, timeout=30,
                                **_cl()._child_kw()).returncode
            return rc == 0
        try:
            os.killpg(pid, signal.SIGKILL)
        except OSError:
            os.kill(pid, signal.SIGKILL)
        return True
    except (OSError, subprocess.SubprocessError):
        return False


def _child_env():
    return _cl()._local_child_env(**_CHILD_FLAGS)


def _local_run(argv, timeout, what):
    """One worker run that reads the credentials line off stdin (same shape as
    president_connect._local_run: Popen + communicate, kill the tree on any exit)."""
    cl = _cl()
    try:
        p = subprocess.Popen([sys.executable] + argv, cwd=WORKSPACE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                             start_new_session=os.name != "nt", env=_child_env(),
                             **cl._child_kw(stdin=subprocess.PIPE))
    except OSError as e:
        raise RuntimeError(f"{what} could not start ({type(e).__name__})")
    try:
        out, err = p.communicate((secret_line() + "\n").encode("utf-8"), timeout=timeout)
    except BaseException as e:
        _kill_tree(p.pid)
        try:
            p.kill()
        except OSError:
            pass
        try:
            p.communicate(timeout=LOCAL_DRAIN_S)
        except (subprocess.SubprocessError, OSError, ValueError):
            pass
        if isinstance(e, subprocess.TimeoutExpired):
            raise RuntimeError(f"{what} timed out")
        raise
    return subprocess.CompletedProcess(p.args, p.returncode, out, err)


class _LocalWorker:
    """lib/capital_worker.py as this daemon's child. Restarted LOCAL_RESPAWN_S after
    it exits, except after a login 群益 refused (exit LOGIN_STOPPED_EXIT); stopped
    with the daemon. Read-only: it never sends an order."""

    def __init__(self):
        self.proc = None
        self.wanted = False
        self.respawn_at = None
        self.lock = threading.Lock()

    def running(self):
        return self.proc is not None and self.proc.poll() is None

    def start(self):
        with self.lock:
            self.wanted, self.respawn_at = True, None
            if not self.running():
                self._spawn()

    def _spawn(self):
        line = secret_line()
        if not line:
            _refuse("NO_SECRETS", "the app has not handed over the 群益 credentials")
        cl, p = _cl(), _paths()
        os.makedirs(os.path.dirname(p["log"]), exist_ok=True)
        try:
            if os.path.getsize(p["log"]) > 5 * 1024 * 1024:
                os.replace(p["log"], p["log"] + ".1")
        except OSError:
            pass
        with atomic_file.open_append(p["log"]) as logf:
            self.proc = subprocess.Popen([sys.executable, p["worker"]], cwd=WORKSPACE, env=_child_env(),
                                         stdout=logf, stderr=logf, **cl._child_kw(stdin=subprocess.PIPE))
        try:  # the pipe stays open: closing it is how stop() asks first
            self.proc.stdin.write((line + "\n").encode("utf-8"))
            self.proc.stdin.flush()
        except OSError:
            pass
        try:
            with atomic_file.replacing(p["pid"]) as f:
                f.write(str(self.proc.pid))
        except OSError:
            pass

    def stop(self, why=""):
        with self.lock:
            self.wanted, self.respawn_at = False, None
            p, self.proc = self.proc, None
        if p is not None and p.poll() is None:
            try:
                p.stdin.close()
            except (OSError, AttributeError):
                pass
            if os.name == "nt":
                _kill_tree(p.pid)  # terminate() reaches the venv launcher only; the worker stays logged in
            else:
                p.terminate()
            try:
                p.wait(5)
            except subprocess.TimeoutExpired:
                p.kill()
        try:
            os.remove(_paths()["pid"])
        except OSError:
            pass

    def tick(self):
        with self.lock:
            if not self.wanted or self.proc is None or self.proc.poll() is None \
                    or self.proc.poll() == LOGIN_STOPPED_EXIT:
                return
            if self.respawn_at is None:
                self.respawn_at = time.time() + LOCAL_RESPAWN_S
                return
            if time.time() < self.respawn_at:
                return
            self.respawn_at = None
            try:
                self._spawn()
            except Exception as e:
                print(f"[capital_local] worker restart failed ({type(e).__name__})", file=sys.stderr)
                self.respawn_at = time.time() + LOCAL_RESPAWN_S

    def reap_orphan(self, pid_cmdline):
        """A worker left by a daemon that died holds credentials nobody manages any more."""
        p = _paths()
        try:
            with open(p["pid"]) as f:
                pid = int(f.read().strip())
        except (OSError, ValueError):
            return
        try:
            cmd = pid_cmdline(pid) if pid > 0 else ""
        except Exception:
            cmd = ""
        if "capital_worker.py" in cmd and os.path.abspath(p["worker"]) in cmd:
            if os.name == "nt":
                _kill_tree(pid)
            else:
                try:
                    os.kill(pid, signal.SIGTERM)
                except OSError:
                    pass
        try:
            os.remove(p["pid"])
        except OSError:
            pass


_LOCAL["worker"] = _LocalWorker()


def local_tick():
    """local_daemon's supervise loop, once a second: a worker stopped by a refused
    login is not restarted; the modal shows why and the user's press re-probes."""
    w = _LOCAL["worker"]
    p = w.proc
    if p is not None and p.poll() == LOGIN_STOPPED_EXIT and w.wanted:
        w.wanted = False
        code = cc.pw_blocked()
        _update("worker", status="failed", error=f"LOGIN_FAILED:{cc.CODE_STATES.get(code, 'unknown')}", wanted=False)
    w.tick()
    _retry_purge(time.time())


def local_info():
    """The status doc's `capital_local` (the app reads whether it must re-send)."""
    return {"secrets": _LOCAL["secrets"] is not None, "worker_running": _LOCAL["worker"].running()}


def local_shutdown():
    _LOCAL["worker"].stop("daemon stopping")
    _LOCAL["secrets"] = None


def drop_local(names):
    """credentials_remove hook: unbinding 群益 stops the worker and forgets the bundle."""
    if not any(str(n).casefold() in (_ID_KEY, "capital_id", _PW_KEY) for n in names):
        return
    _LOCAL["worker"].stop("unbound")
    _LOCAL["secrets"] = None
    cb = _LOCAL["on_secrets"]
    if cb:
        try:  # the reconciler still holds the old line in memory: a new one gets none
            cb()
        except Exception as e:
            print(f"[capital_local] reconciler respawn failed ({type(e).__name__})", file=sys.stderr)
    # what this binding left on disk: SKCOM's own log (it carries the national ID), the probe / account
    # snapshots and the worker log (account numbers). The wrong-password block stays: it is keyed on the
    # credentials, and re-binding the same wrong password must not buy another try toward 307
    p = _paths()
    for f in (p["probe"], p["snapshot"], p["log"], p["log"] + ".1"):
        try:
            os.remove(f)
        except OSError:
            pass
    if not purge_logs():
        _mark_purge()
    _update("worker", create=False, reset=True, status="idle")
    _update("probe", create=False, reset=True, status="idle")


# SKCOM's own log carries the national ID. A reconciler that still has a session open (it is respawned on
# its own thread, after its round) can hold those files locked on Windows, so a purge that leaves anything
# behind is marked and retried from local_tick until it goes — and once at every daemon start while
# 群益 is not bound. Only our own per-user folder: <base>\log and CapitalLog* next to the DLL (SKCOM's
# default before SetLogPath). Never C:\skcom.
PURGE_RETRY_S = 30
_PURGE = {"next": 0.0}


def _purge_flag():
    return os.path.join(WORKSPACE, "state", "capital_log_purge")


def _mark_purge():
    try:
        with atomic_file.replacing(_purge_flag()) as f:
            f.write(str(int(time.time())))
    except OSError:
        pass


def _log_targets():
    base = local_dir()
    if not base:
        return []
    out = [os.path.join(base, "log")]
    sk = os.path.join(base, "skcom", "x64")
    try:
        out += [os.path.join(sk, n) for n in os.listdir(sk) if n.lower().startswith("capitallog")]
    except OSError:
        pass
    return out


def purge_logs():
    """→ True when nothing of SKCOM's log is left in our folder."""
    left = False
    for t in _log_targets():
        if os.path.isdir(t) and not os.path.islink(t):
            shutil.rmtree(t, ignore_errors=True)
        else:
            try:
                os.remove(t)
            except FileNotFoundError:
                pass
            except OSError:
                pass
        left = left or os.path.lexists(t)
    return not left


def _bound():
    return _LOCAL["secrets"] is not None or (_env_values().get(_PW_KEY) or "").startswith("vault:")


def startup_sweep():
    """local_daemon at start: 群益 not bound here → SKCOM's log must not be on disk (an unbind whose purge was
    blocked, an app that quit mid-retry)."""
    if not _bound() and not purge_logs():
        _mark_purge()


def _retry_purge(now):
    if now < _PURGE["next"] or not os.path.exists(_purge_flag()):
        return
    _PURGE["next"] = now + PURGE_RETRY_S
    if _bound():   # bound again since: its log is in use, not leftover
        try:
            os.remove(_purge_flag())
        except OSError:
            pass
        return
    if purge_logs():
        try:
            os.remove(_purge_flag())
        except OSError:
            pass


# ── setup ────────────────────────────────────────────────────────────────────

def _download(url, dest, max_bytes, sha256=None):
    req = urllib.request.Request(url, headers={"User-Agent": "Blave"})
    h = hashlib.sha256()
    n = 0
    with urllib.request.urlopen(req, timeout=120) as r, open(dest, "wb") as f:
        if not r.geturl().startswith("https://"):
            raise RuntimeError("redirected off https")
        while True:
            chunk = r.read(1 << 16)
            if not chunk:
                break
            n += len(chunk)
            if n > max_bytes:
                raise RuntimeError("too large")
            h.update(chunk)
            f.write(chunk)
    if sha256 and h.hexdigest() != sha256:
        raise RuntimeError("sha256 mismatch")


def _vc_present():
    sys32 = os.path.join(os.environ.get("WINDIR", r"C:\Windows"), "System32")
    return all(os.path.isfile(os.path.join(sys32, n)) for n in ("mfc100.dll", "msvcr100.dll"))


_PS_VC = ("$s = Get-AuthenticodeSignature -LiteralPath $env:CAPL_VC; "
          "if ($s.Status -ne 'Valid' -or $s.SignerCertificate.GetNameInfo('SimpleName', $false) -ne 'Microsoft Corporation') { exit 4 }; "
          "$p = Start-Process -FilePath $env:CAPL_VC -ArgumentList '/q', '/norestart' -Verb RunAs -Wait -PassThru; exit $p.ExitCode")


def _ensure_vc(tmp):
    if _vc_present():
        return
    exe = os.path.join(tmp, "vcredist_x64_2010.exe")
    _download(VC_URL, exe, VC_MAX)
    # one UAC prompt (Microsoft's installer, signature checked first); the only system-wide thing here
    subprocess.run([_powershell(), "-NoProfile", "-NonInteractive", "-Command", _PS_VC],
                   capture_output=True, timeout=900, env=dict(os.environ, CAPL_VC=exe), **_cl()._child_kw())
    if not _vc_present():
        raise RuntimeError("vc++ 2010 runtime missing after install")


def _x64_members(zf):
    """The component's own files: everything directly under a …/x64/ folder that holds SKCOM.dll."""
    files = [i for i in zf.infolist() if not i.is_dir()]
    dirs = {i.filename.rsplit("/", 1)[0] for i in files if i.filename.endswith("/SKCOM.dll")
            and i.filename.rsplit("/", 1)[0].rsplit("/", 1)[-1] == "x64"}
    if len(dirs) != 1:
        raise RuntimeError("SKCOM.dll not under exactly one x64 folder in the zip")
    d = dirs.pop()
    out = [i for i in files if i.filename.rsplit("/", 1)[0] == d]
    for i in out:
        name = i.filename.rsplit("/", 1)[1]
        if not name or name in (".", "..") or "\\" in name or ":" in name:
            raise RuntimeError("unsafe zip member")
    return out


def _restrict_dir(path):
    """This user + SYSTEM + Administrators, no inheritance (a shared PC's other accounts cannot plant
    or swap the DLL, nor read SKCOM's log)."""
    os.makedirs(path, exist_ok=True)
    if not IS_WINDOWS:
        return
    r = subprocess.run([_powershell(), "-NoProfile", "-NonInteractive", "-Command",
                        "[Security.Principal.WindowsIdentity]::GetCurrent().User.Value"],
                       capture_output=True, timeout=60, **_cl()._child_kw())
    sid = r.stdout.decode("ascii", "replace").strip()
    if r.returncode != 0 or not re.fullmatch(r"S-1-[0-9-]+", sid):
        raise RuntimeError("current user SID unreadable")
    r = subprocess.run([_sys32("icacls.exe"), path, "/inheritance:r", "/grant:r", f"*{sid}:(OI)(CI)F",
                        "*S-1-5-18:(OI)(CI)F", "*S-1-5-32-544:(OI)(CI)F"], capture_output=True, timeout=60,
                       **_cl()._child_kw())
    if r.returncode != 0:
        raise RuntimeError(f"icacls exit {r.returncode}")


def _sha(data):
    return hashlib.sha256(data).hexdigest()


def _ensure_skcom(tmp):
    """Every setup: the pinned zip (SHA256) is the source of truth — each installed file is compared
    with its copy in the zip and rewritten when it differs or is missing (a swapped DLL is replaced,
    never reused), then the per-user COM registration is pointed at it again."""
    base = local_dir()
    if not base:
        raise RuntimeError("LOCALAPPDATA missing")
    _restrict_dir(base)
    cache, skdir = os.path.join(base, "dl"), os.path.join(base, "skcom", "x64")
    os.makedirs(cache, exist_ok=True)
    z = os.path.join(cache, "CapitalAPI_2.13.59.zip")
    try:
        with open(z, "rb") as f:
            ok = _sha(f.read()) == CAP_ZIP_SHA256
    except OSError:
        ok = False
    if not ok:
        part = os.path.join(tmp, "capitalapi.zip")
        _download(CAP_ZIP_URL, part, CAP_ZIP_MAX, CAP_ZIP_SHA256)
        shutil.copyfile(part, z)
    os.makedirs(skdir, exist_ok=True)
    with zipfile.ZipFile(z) as zf:
        for m in _x64_members(zf):
            data = zf.read(m)
            dst = os.path.join(skdir, m.filename.rsplit("/", 1)[1])
            try:
                with open(dst, "rb") as f:
                    same = _sha(f.read()) == _sha(data)
            except OSError:
                same = False
            if not same:
                with atomic_file.replacing(dst, "wb") as f:   # a loaded DLL cannot be replaced: setup fails, Blave restarts
                    f.write(data)
    r = subprocess.run([_sys32("regsvr32.exe"), "/s", "/n", "/i:user", os.path.join(skdir, "SKCOM.dll")],
                       capture_output=True, timeout=120, **_cl()._child_kw())
    if r.returncode != 0:
        raise RuntimeError(f"regsvr32 exit {r.returncode}")


# the DLL path comes in through the environment (no user text in the script)
_CHECK_COM = ("import os, comtypes.client as c\n"
              "c.GetModule(os.environ['CAPL_SKCOM'])\n"
              "import comtypes.gen.SKCOMLib as sk\n"
              "c.CreateObject(sk.SKCenterLib, interface=sk.ISKCenterLib)\n")


def run_setup(push=None):
    _update("setup", status="running", error=None)
    if push:
        push()
    failed = []
    tmp = tempfile.mkdtemp(prefix="blave-capital-")
    try:
        if sys.maxsize <= 2 ** 32:
            failed.append("python64")
        steps = (("vcredist", lambda: _ensure_vc(tmp)), ("comtypes", _ensure_comtypes),
                 ("skcom", lambda: _ensure_skcom(tmp)), ("createobject", _check_com))
        for name, fn in steps if not failed else ():
            try:
                fn()
            except Exception as e:
                print(f"[capital_local] setup {name} failed ({type(e).__name__})", file=sys.stderr)
                failed.append(name)
                break
        try:
            import cryptography  # noqa: F401  (the sealed bundle opens in this interpreter)
        except ImportError:
            failed.append("cryptography")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    if failed:
        _update("setup", status="failed", error="SETUP_FAILED:" + ",".join(failed))
        _refuse("SETUP_FAILED", ", ".join(failed))
    _update("setup", status="ok", error=None)
    return {"setup": "ok"}


_COMTYPES_OK = ("import comtypes, comtypes.client, pythoncom, sys; "
                f"sys.exit(0 if comtypes.__version__ == '{COMTYPES_PIN.split('==')[1]}' else 3)")


def _ensure_comtypes():
    if cc._run_quiet([sys.executable, "-c", _COMTYPES_OK], 120, "import").returncode == 0:
        return
    # 只裝釘死 hash 的那一份,不讀用戶／環境的 pip 設定(%APPDATA%\\pip\\pip.ini、PIP_*:換索引就是換程式碼)
    req = os.path.join(tempfile.mkdtemp(prefix="blave-comtypes-"), "req.txt")
    try:
        with open(req, "w", encoding="ascii") as f:
            f.write(f"{COMTYPES_PIN} --hash=sha256:{COMTYPES_SHA256}\n")
        env = {k: v for k, v in os.environ.items() if not k.upper().startswith("PIP_")}
        env["PIP_CONFIG_FILE"] = os.devnull
        subprocess.run([sys.executable, "-m", "pip", "install", "--isolated", "--quiet", "--disable-pip-version-check",
                        "--no-deps", "--only-binary", ":all:", "--require-hashes", "-r", req],
                       capture_output=True, timeout=SETUP_TIMEOUT_S, env=env, **_cl()._child_kw())
    except (OSError, subprocess.SubprocessError):
        pass
    finally:
        shutil.rmtree(os.path.dirname(req), ignore_errors=True)
    if cc._run_quiet([sys.executable, "-c", _COMTYPES_OK], 120, "import").returncode != 0:
        raise RuntimeError("comtypes (pinned) / pythoncom not importable")


def _check_com():
    dll = os.path.join(local_dir() or "", "skcom", "x64", "SKCOM.dll")
    r = subprocess.run([sys.executable, "-c", _CHECK_COM], capture_output=True, timeout=120,
                       env=dict(os.environ, CAPL_SKCOM=dll), **_cl()._child_kw())
    if r.returncode != 0:
        raise RuntimeError("CreateObject(SKCenterLib) failed")


# ── bind / probe / start ─────────────────────────────────────────────────────

def _bind(b, push):
    _LOCAL["pending"] = b
    try:
        _cl()._cmd_credentials({"env": _bound_env(b)})
    finally:
        _LOCAL["pending"] = None
    # new credentials: the old login result and worker are someone else's answer
    _LOCAL["worker"].stop("credentials replaced")
    _set_secrets(b)
    for sec in ("probe", "worker"):
        _update(sec, reset=True, status="idle")
    return {"bind": "ok"}


def probe_once(push=None):
    _update("probe", status="running")
    if push:
        push()
    try:
        os.remove(_paths()["probe"])
    except OSError:
        pass
    try:
        r = _local_run([_paths()["worker"], "--once"], PROBE_TIMEOUT_S, "probe")
        rc = r.returncode
        try:
            with open(_paths()["probe"], encoding="utf-8") as f:
                obj = json.load(f)
        except (OSError, ValueError):
            obj = None
    except RuntimeError as e:
        rc, obj = (3, None) if "timed out" in str(e) else (1, {"ok": False, "stage": "setup"})
    st = cc.probe_state(obj, rc)
    if st["state"] in cc.PW_BLOCK_STATES:
        cc.block_login(st["code"])
    elif st["state"] == "ok":
        cc.clear_block()
    else:
        cc._close_unlock_window()
    _update("probe", status="ok" if st["state"] == "ok" else "failed", **st)
    return st


def _start(push):
    probe = (read_status() or {}).get("probe") or {}
    if probe.get("state") != "ok":
        _refuse("PROBE_NOT_OK", "login has not passed yet")
    _update("worker", status="running", error=None, wanted=True)
    if push:
        push()
    out, t0 = _paths()["snapshot"], time.time() - 2
    try:
        _LOCAL["worker"].start()
        deadline = t0 + START_TIMEOUT_S
        while time.time() < deadline:
            try:
                with open(out, encoding="utf-8") as f:
                    s = json.load(f)
                if isinstance(s, dict) and (s.get("read_at") or 0) >= t0:
                    if s.get("ok") is True:
                        # ok_at outlives later failures: "never finished" vs "finished, then failed"
                        _update("worker", status="ok", error=None, wanted=True, ok_at=int(time.time()))
                        return {"worker": "ok"}
                    _refuse("SNAPSHOT_ERROR", "the worker's first read failed")
            except (OSError, ValueError, AttributeError):
                pass
            p = _LOCAL["worker"].proc
            if p is not None and p.poll() == LOGIN_STOPPED_EXIT:
                _refuse("LOGIN_FAILED", "the 群益 worker's login was refused")
            time.sleep(2)
        _refuse("SNAPSHOT_TIMEOUT", "the worker wrote no snapshot in time")
    except Exception as e:
        _LOCAL["worker"].stop("start failed")
        _update("worker", status="failed", error=cc._code(e, "WORKER_FAILED"), wanted=False)
        raise


def _release_step():
    try:
        _update(busy=None)
    finally:
        _busy.release()


def _sweep_interrupted():
    """A daemon that died mid-step leaves `busy` and a section at running."""
    if not _busy.acquire(blocking=False):
        return
    try:
        st = read_status()
        if not st or not st.get("busy"):
            return
        cc._close_unlock_window()
        for sec in _SECTIONS:
            if (st.get(sec) or {}).get("status") == "running":
                _update(sec, status="failed", error="INTERRUPTED")
        _update(busy=None)
    finally:
        _busy.release()


def _need_secrets():
    if _LOCAL["secrets"] is None:
        _refuse("NO_SECRETS", "the app has not handed over the 群益 credentials")


def local_dispatch(args, deferred_cls, push=None):
    """command_listener's handler for `capital_local` (desktop only)."""
    if os.environ.get("BLAVE_AGENT_LOCAL") != "1":
        _refuse("NOT_LOCAL", "capital_local runs on the desktop app only")
    op = args.get("op") if isinstance(args, dict) else None
    allowed = {"op", "sealed"} if op in ("bind", "secrets") else {"op", "after_unlock"} if op == "probe" else {"op"}
    if op not in LOCAL_OPS or set(args) - allowed:
        _refuse("BAD_ARGS", "unknown capital_local shape")
    if op == "probe" and "after_unlock" in args and args["after_unlock"] is not True:
        _refuse("BAD_ARGS", "after_unlock is true or absent")
    if not IS_WINDOWS:
        _refuse("NOT_WINDOWS", "群益 needs Windows")
    if op == "stop":
        _LOCAL["worker"].stop("asked")
        _update("worker", create=False, wanted=False)
        return {"worker": "stopped"}
    if op == "secrets":
        b = _bundle(open_sealed(args.get("sealed")))
        if not _env_bound_to(b):
            _refuse("REBOUND", "this computer's .env is bound to other 群益 credentials")
        _set_secrets(b)
        w = (read_status() or {}).get("worker") or {}
        if w.get("wanted") and w.get("status") == "ok":
            try:
                _LOCAL["worker"].start()
            except Exception as e:
                _update("worker", status="failed", error=cc._code(e, "WORKER_FAILED"))
        return {"secrets": "ok"}
    _sweep_interrupted()
    if op == "bind":
        b = _bundle(open_sealed(args.get("sealed")))
        if not cc.lib_supports_vault():
            _refuse("LIB_OUTDATED", "update the workspace before binding 群益")
        job = lambda push: _bind(b, push)  # noqa: E731
    elif op == "setup":
        job = lambda push: run_setup(push)  # noqa: E731
    elif op == "probe":
        _need_secrets()
        if not args.get("after_unlock") and cc.pw_blocked():
            _refuse("PW_RECHECK_NEEDED", "群益 refused this trading password — re-enter it before trying again")
        job = lambda push: probe_once(push)  # noqa: E731
    else:  # start
        _need_secrets()
        if cc.pw_blocked():
            _refuse("PW_RECHECK_NEEDED", "群益 refused this trading password — re-enter it before trying again")
        job = lambda push: _start(push)  # noqa: E731
    if not _busy.acquire(blocking=False):
        _refuse("BUSY", f"another 群益 step is running ({(read_status() or {}).get('busy')})")
    try:
        _update(busy="capital_local:" + op)
        if op == "probe" and args.get("after_unlock"):
            cc.grant_unlock_retry()
    except Exception:
        _release_step()
        raise
    return deferred_cls(lambda: job(push), cleanup=_release_step)
