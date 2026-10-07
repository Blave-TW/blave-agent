"""統一期貨 (President) cloud connect: the deterministic machine side.

Same shape as runtime/capital_connect.py (whose one-time key, envelope and ACL
helpers it reuses): every step is a command with a fixed outcome, the outcome is
written to state/president_connect.json, and the portfolio report carries it as
`president_connect` — the one status the web reads. Nothing goes through the
agent. Windows cloud boxes only in v1.

Steps, in the order the page walks them:
  credentials        the 自動下單 form (command_listener._cmd_credentials →
                     divert_credentials here): account + trading password.
                     The password goes to the vault, production is switched on
                     there ("live": true), .env gets sentinels and the fixed
                     certificate path / production host.
  president_setup    unitrade (pinned) into the worker's python; cryptography
                     into this one (the envelope and the pfx check run here).
  president_pfx_key  one-time RSA key; the ack carries the public half.
  president_pfx      {key_id, envelope}: the user's .pfx + its password, sealed
                     in the browser. Opened and checked HERE (a wrong password
                     never reaches the broker — the SDK sends the trading
                     password before it opens the certificate, so a bad pfx
                     would cost a login try), then stored as
                     credentials/president.pfx (fixed name: the user's file
                     name carries the national id), its password into the
                     vault; then one read-only login (the probe).
  president_pfx_local {key_id, envelope}: the certificate the user applied for
                     themselves over RDP (logged in as Administrator, in
                     憑證e總管). The envelope carries only the password ("pfx"
                     must be ""; a file in it is refused, not ignored). The
                     newest file in LOCAL_CERT_DIR (Administrator's PSCCA) the
                     password opens and that has not expired is COPIED to
                     credentials/president.pfx — the original stays for next
                     year's renewal — then the same vault write and probe as
                     president_pfx. Only the platform copies from PSCCA; no
                     code here runs, drives or logs in to 憑證e總管.
  president_probe    `lib/president_worker.py --once`; {"after_unlock": true}
                     runs `--unblock` first (the lib allows that once per block).
  president_finish   `lib/president_worker.py --install` (NSSM, LocalSystem).

Any other way to get the certificate onto the machine is one more command that
ends where president_pfx ends: the `cert` section with its own `source`, then
the same probe and finish. Add its name to COMMANDS and _JOBS, and to the api
allow-list.

Vault (<base>/credentials/president_vault.json, = lib/president_vault.VAULT)
and president.pfx: SYSTEM + Administrators only. Unlike 群益's, both must be
readable by SYSTEM: the worker runs as LocalSystem, the reconciler as
Administrator. On a cloud box the agent's shell is SYSTEM too, so this keeps the
secrets and the production switch out of .env and out of the agent's ordinary
paths — it is not a wall against SYSTEM set on bypassing it.

Never put a secret, a pfx byte, a certificate subject (it carries the national
id) or a broker message into a return value, an exception, the status or a log.
"""
import base64
import hashlib
import hmac
import json
import os
import re
import shutil
import signal
import subprocess
import sys
import threading
import time

import atomic_file
import capital_connect as cc

WORKSPACE = os.environ.get("BLAVE_AGENT_WORKSPACE", "/opt/blave-agent/workspace")
IS_WINDOWS = os.name == "nt"

COMMANDS = ("president_setup", "president_pfx_key", "president_pfx", "president_pfx_local",
            "president_probe", "president_finish")
UNITRADE_PIN = "unitrade==1.0.0.7"
LIVE_URL = "https://viploginm.pfctrade.com"
# where 憑證e總管 saves for the account it runs under; RDP logs in as Administrator
LOCAL_CERT_DIR = r"C:\Users\Administrator\PSCCA"
# 待補(Wei 提供):統一(PSC)憑證的 issuer 與 OU 字串。補上之前,上傳只檢查檔案用那組密碼
# 打得開、裡面有私鑰、還沒過期;status 的 cert.issuer_checked 照實寫 false。
CERT_ISSUER_MARK = None
CERT_OU_MARK = None
PROBE_TIMEOUT_S = 150
SETUP_TIMEOUT_S = 900
FINISH_TIMEOUT_S = 240
VAULT_PW_PREFIX = "vault:"
CA_SENTINEL = "vault:ca"
_ACCOUNT, _SECRET, _CA_PW = "president_account", "president_password", "president_ca_password"
# lib/president_worker.py's LoginError classes → the page's states
LOGIN_STATES = {"CERT_MISMATCH": "cert_mismatch", "CERT": "cert", "PASSWORD": "password",
                "BLOCKED": "blocked", "MAINTENANCE": "maintenance", "HOST": "host",
                "TIMEOUT": "timeout", "TRANSIENT": "retry_later", "NON_TEST_SERVER": "unknown",
                "UNKNOWN": "unknown"}

_SECTIONS = ("setup", "cert", "probe", "worker")
# desktop state, this process only (see "desktop app" below)
_LOCAL = {"key": None, "secrets": None, "pending": None, "worker": None, "on_secrets": None,
          "cert_check_at": 0.0}
_busy = threading.Lock()
_status_lock = threading.Lock()


def _paths():
    cred = os.path.join(os.path.dirname(WORKSPACE), "credentials")
    return {
        "cred": cred,
        "vault": os.path.join(cred, "president_vault.json"),
        "pfx": os.path.join(cred, "president.pfx"),
        "key": os.path.join(cred, "president_pfx_key.json"),
        "logs": os.path.join(cred, "president_logs"),  # = lib/president_vault.SDK_LOG_DIR
        "legacy_logs": os.path.join(WORKSPACE, "state", "president_logs"),
        "status": os.path.join(WORKSPACE, "state", "president_connect.json"),
        "probe": os.path.join(WORKSPACE, "state", "president_probe.json"),
        "worker": os.path.join(WORKSPACE, "lib", "president_worker.py"),
    }


def _refuse(code, text=""):
    raise ValueError(f"{code}: {text}" if text else code)


# ── status (state/president_connect.json) ────────────────────────────────────

def _blank():
    return {"v": 1, "updated_at": None, "busy": None,
            **{s: {"status": "idle", "at": None} for s in _SECTIONS}}


def read_status():
    """The report's `president_connect`; None = never started on this machine."""
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


# ── vault + certificate file ─────────────────────────────────────────────────

def lib_supports_vault(workspace=None):
    """The workspace's lib must take production from the vault (ce830b7): an
    older one reads PRESIDENT_LIVE from .env and this bind would never reach
    the production host."""
    path = os.path.join(workspace or WORKSPACE, "lib", "president_vault.py")
    try:
        with open(path, encoding="utf-8") as f:
            src = f.read()
    except OSError:
        return False
    return "def live():" in src and "president_vault.json" in src


def account_fp(account):
    return hashlib.sha256(f"president-account-v1\0{account}".encode()).hexdigest()[:16]


def vault_fingerprint(account, password):
    # .env's account identity (command_listener._account_identity) hashes the
    # credential VALUES: a constant sentinel would make every rebind look alike
    return hashlib.sha256(f"president-vault-v1\0{account}\0{password}".encode()).hexdigest()[:16]


def _read_vault():
    try:
        with open(_paths()["vault"], encoding="utf-8") as f:
            v = json.load(f)
    except (OSError, ValueError):
        return {}
    return v if isinstance(v, dict) else {}


def _write_private(path, data):
    """Write `data` (bytes) to `path`, readable by SYSTEM + Administrators only,
    ACL set before the rename; the plaintext tmp is removed on any failure."""
    cred = _paths()["cred"]
    cc._restrict_dir(cred)  # credentials\ first: provisioning leaves it inheriting C:\

    def _system_admins_only(tmp):  # strict, not cc.restrict_admins: a failed ACL must refuse the write
        if IS_WINDOWS:
            cc._icacls(tmp, "/inheritance:r", "/grant:r", "*S-1-5-18:F", "*S-1-5-32-544:F")

    with atomic_file.replacing(path, "wb", prepare=_system_admins_only) as f:
        f.write(data)


def _write_vault(d):
    try:
        _write_private(_paths()["vault"], json.dumps(d).encode("utf-8"))
    except Exception as e:
        _refuse("VAULT_FAILED", type(e).__name__)


def divert_credentials(env, local=False):
    """_cmd_credentials hook: the trading password → the vault, production
    switched on there, sentinels + the fixed certificate path and production
    host → .env. Returns the env mapping to write. Unchanged on the desktop;
    refused on a cloud box that is not Windows (v1) — written as is there, the
    trading password would sit in .env with no way to production — and for any
    統一 write without both the account and a real password: a lone password
    (or certificate password) would land in .env as plaintext, a lone account
    or sentinel would point .env at a vault written for someone else.
    Refused BUSY while a 統一 step runs in this process: president_pfx writes
    the vault too, and the two would overwrite each other. The lock is
    in-process (the chat bind runs this from another process, where the
    on-disk `busy` must not be swept either — it would mark a live step
    INTERRUPTED); run_pfx covers that side by re-reading the vault."""
    if not any(k.casefold().startswith("president_") for k in env):
        return env
    if local:
        return env
    if not IS_WINDOWS:
        _refuse("NOT_WINDOWS", "統一期貨 needs a Windows cloud machine in this version")
    vals = {k.casefold(): v for k, v in env.items()}
    account, password = vals.get(_ACCOUNT), vals.get(_SECRET)
    if not account or not password or password.startswith(VAULT_PW_PREFIX):
        _refuse("INCOMPLETE", "統一期貨 takes the account and the trading password together")
    if not lib_supports_vault():
        _refuse("LIB_OUTDATED", "update the workspace before binding 統一期貨")
    if not _busy.acquire(blocking=False):
        _refuse("BUSY", f"another 統一 step is running ({(read_status() or {}).get('busy')})")
    try:
        return _divert(env, account, password)
    finally:
        _busy.release()


def _divert(env, account, password):
    p = _paths()
    afp = account_fp(account)
    old = _read_vault()
    carry = old.get(_CA_PW) if old.get("account_fp") == afp and os.path.isfile(p["pfx"]) else None
    vault = {_SECRET: password, "live": True, "account_fp": afp}
    if carry is not None:
        vault[_CA_PW] = carry
    _write_vault(vault)
    if carry is None:
        # a certificate left from another account (or none): upload again
        try:
            os.remove(p["pfx"])
        except OSError:
            pass
        _update("cert", create=False, reset=True, status="idle")
    for sec in ("probe", "worker"):
        _update(sec, create=False, reset=True, status="idle")
    drop = (_SECRET, _CA_PW, "president_ca_path", "president_url")
    out = {k: v for k, v in env.items() if k.casefold() not in drop}
    out[_SECRET] = VAULT_PW_PREFIX + vault_fingerprint(account, password)
    out[_CA_PW] = CA_SENTINEL
    out["president_ca_path"] = p["pfx"]
    out["president_url"] = LIVE_URL
    return out


def drop_vault(names=None):
    """Unbind / eviction hook: the vault (and so the production switch), the
    certificate, a pending key and the status go; the worker service is asked
    to remove itself. `names` (credentials_remove) — only when they are 統一's."""
    if names is not None and not any(str(n).casefold().startswith("president_") for n in names):
        return
    local = _LOCAL["secrets"] is not None or os.environ.get("BLAVE_AGENT_LOCAL") == "1"
    if local:
        _LOCAL["worker"].stop("unbound")
        _LOCAL["secrets"] = None
    p = _paths()
    for path in (p["vault"], p["pfx"], p["key"], p["status"]):
        try:
            os.remove(path)
        except FileNotFoundError:
            pass
        except OSError as e:
            print(f"[president_connect] {os.path.basename(path)} not removed ({type(e).__name__})",
                  file=sys.stderr)
    # the SDK's logs carry the login id; the worker may still be writing while it stops
    for path in (p["logs"], p["legacy_logs"]):
        if os.path.lexists(path):
            shutil.rmtree(path, ignore_errors=True)
            if os.path.lexists(path):
                print(f"[president_connect] {os.path.basename(path)} not fully removed", file=sys.stderr)
    if IS_WINDOWS and not local:
        py = cc._python_for_worker()
        if py and os.path.isfile(p["worker"]):
            try:  # not waited for: a stopping service can take a minute
                subprocess.Popen([py, p["worker"], "--uninstall"], **cc._kw(
                    stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL))
            except OSError as e:
                print(f"[president_connect] worker uninstall not started ({type(e).__name__})",
                      file=sys.stderr)


# ── certificate check ────────────────────────────────────────────────────────

def inspect_pfx(pfx, password):
    """→ {not_after, not_after_ts, issuer_checked}. Opens the file the way the
    SDK will: wrong password / not a certificate / no key / expired are refused
    here, before any broker contact."""
    c = cc._crypto()
    if len(pfx) > cc.PFX_MAX_BYTES:
        _refuse("PFX_TOO_LARGE", f"over {cc.PFX_MAX_BYTES} bytes")
    loaded = None
    for pw in ([None, b""] if not password else [password.encode("utf-8")]):
        try:
            loaded = c["pkcs12"].load_key_and_certificates(pfx, pw)
            break
        except Exception:
            continue
    if loaded is None:
        if cc._looks_like_pfx(pfx):
            _refuse("PFX_PASSWORD", "the certificate password does not open this file")
        _refuse("PFX_INVALID", "not a certificate file")
    key, cert, _extra = loaded
    if key is None or cert is None:
        _refuse("PFX_INVALID", "no certificate with a private key inside")
    oid = c["x509"].NameOID
    checked = CERT_ISSUER_MARK is not None or CERT_OU_MARK is not None
    if CERT_ISSUER_MARK is not None and CERT_ISSUER_MARK not in cert.issuer.rfc4514_string():
        _refuse("PFX_NOT_PRESIDENT", "not a 統一期貨 certificate")
    if CERT_OU_MARK is not None and CERT_OU_MARK not in [
            a.value for a in cert.subject.get_attributes_for_oid(oid.ORGANIZATIONAL_UNIT_NAME)]:
        _refuse("PFX_NOT_PRESIDENT", "not a 統一期貨 certificate")
    not_after = getattr(cert, "not_valid_after_utc", None)
    if not_after is None:  # cryptography < 42
        import calendar
        exp = calendar.timegm(cert.not_valid_after.timetuple())
    else:
        exp = int(not_after.timestamp())
    if exp <= time.time():
        e = ValueError("PFX_EXPIRED: this certificate has expired — renew it first")
        e.not_after = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(exp))  # a date, nothing personal
        raise e
    return {"not_after": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(exp)), "not_after_ts": exp,
            "issuer_checked": checked}


# ── the steps ────────────────────────────────────────────────────────────────

def _python():
    if os.environ.get("BLAVE_AGENT_LOCAL") == "1":
        return sys.executable  # the desktop's venv: unitrade goes where the worker runs
    py = cc._python_for_worker()
    if not py:
        _refuse("PYTHON_MISSING", "python.exe not found")
    return py


def run_setup(push=None):
    _update("setup", status="running", error=None)
    if push:
        push()
    failed = []
    try:
        py = _python()
        r = cc._run_quiet([py, "-m", "pip", "install", "--quiet", UNITRADE_PIN], SETUP_TIMEOUT_S, "pip")
        if r.returncode != 0 or cc._run_quiet([py, "-c", "import unitrade.unitrade"], 120,
                                              "import").returncode != 0:
            failed.append("unitrade")
    except (RuntimeError, ValueError):
        failed.append("unitrade")
    try:
        import cryptography  # noqa: F401
    except ImportError:
        try:
            ok = cc._run_quiet([sys.executable, "-m", "pip", "install", "--quiet", "cryptography"],
                               600, "pip").returncode == 0
        except RuntimeError:
            ok = False
        if not ok:
            failed.append("cryptography")
    if failed:
        _update("setup", status="failed", error="SETUP_FAILED:" + ",".join(failed))
        _refuse("SETUP_FAILED", ", ".join(failed))
    _update("setup", status="ok", error=None)
    return {"setup": "ok"}


def probe_state(obj, exit_code):
    """president_worker --once's probe file + exit → the status `probe` fields.
    Only a class leaves here — never the broker's or the SDK's text."""
    if not isinstance(obj, dict):
        return {"state": "timeout" if exit_code is None else "unknown"}
    if obj.get("ok") and exit_code == 0:
        return {"state": "ok", "equity_read": obj.get("equity") is not None,
                "test_mode": obj.get("test_mode") is True}
    err = str(obj.get("error") or "")
    for kind, state in LOGIN_STATES.items():
        if f"login failed: {kind} " in err or err.endswith(f"login failed: {kind}"):
            return {"state": state}
    if "missing from .env" in err or "vault" in err:
        return {"state": "no_credentials"}
    return {"state": "unknown"}


def _worker_run(flag, timeout, what):
    if _LOCAL["secrets"] is not None:
        return _local_run(flag, timeout, what)
    return cc._run_quiet([_python(), _paths()["worker"], flag], timeout, what)


def run_probe(push=None, after_unlock=False):
    _update("probe", status="running", reset=True)
    if push:
        push()
    p = _paths()
    if after_unlock:
        r = _worker_run("--unblock", 60, "unblock")
        if r.returncode != 0:
            _update("probe", status="failed", state="unblock_used")
            _refuse("UNBLOCK_USED", "this block was already released once — re-enter the password")
    started = time.time() - 1
    try:
        rc = _worker_run("--once", PROBE_TIMEOUT_S, "probe").returncode
    except RuntimeError:
        rc = None
    try:
        with open(p["probe"], encoding="utf-8") as f:
            obj = json.load(f)
        if not isinstance(obj, dict) or (obj.get("read_at") or 0) < started:
            obj = None  # a file left by an earlier probe says nothing about this one
    except (OSError, ValueError):
        obj = None
    st = probe_state(obj, rc)
    _update("probe", status="ok" if st["state"] == "ok" else "failed", **st)
    return st


def run_pfx(args, push=None):
    return _import_cert(args, push, "upload", lambda pfx, password: (pfx, inspect_pfx(pfx, password)))


def run_pfx_local(args, push=None):
    return _import_cert(args, push, "local", _pick_local)


def _local_candidates():
    """PSCCA's .pfx files, newest first. An unreadable folder or file counts as
    absent: an OSError's text carries the path, the file name the national id."""
    try:
        names = os.listdir(LOCAL_CERT_DIR)
    except OSError:
        return []
    found = []
    for name in names:
        path = os.path.join(LOCAL_CERT_DIR, name)
        if not name.lower().endswith(".pfx") or os.path.islink(path):
            continue
        try:
            if os.path.isfile(path):
                found.append((os.path.getmtime(path), path))
        except OSError:
            continue
    return [path for _, path in sorted(found, reverse=True)]


def _pick_local(sent, password):
    """→ (bytes, meta) of the newest PSCCA file the password opens and that has
    not expired; all failing → the newest one's code."""
    if sent:
        _refuse("ENVELOPE_INVALID", "this step takes the certificate password only")
    first = None
    for path in _local_candidates():
        try:
            with open(path, "rb") as f:
                data = f.read(cc.PFX_MAX_BYTES + 1)
        except OSError:
            continue
        try:
            return data, inspect_pfx(data, password)
        except ValueError as e:
            first = first or e
    if first is None:
        _refuse("PFX_NONE_FOUND", "no certificate file in the 憑證e總管 folder")
    raise first


def _import_cert(args, push, source, pick):
    _update("cert", status="importing", error=None, source=source)
    if push:
        push()
    p = _paths()
    try:
        pfx, password = cc.open_envelope(args["key_id"], args["envelope"], key_path=p["key"])
        pfx, meta = pick(pfx, password)
        bound = _read_vault()
        if not bound.get(_SECRET):
            _refuse("NOT_BOUND", "save the account and trading password first")
        try:
            _write_private(p["pfx"], pfx)
        except Exception as e:
            _refuse("VAULT_FAILED", type(e).__name__)
        # re-read right before the write: a bind from another process (the chat
        # bind) in between must not be rolled back by this step's older copy
        vault = _read_vault()
        try:
            if not vault.get(_SECRET):
                _refuse("NOT_BOUND", "save the account and trading password first")
            if vault.get("account_fp") != bound.get("account_fp"):
                _refuse("REBOUND", "the account changed during the upload — upload the certificate again")
            _write_vault(dict(vault, **{_CA_PW: password}))
        except Exception:
            # the new certificate must not stay next to the old (or no) password:
            # a login would try it with that one and spend a broker try
            try:
                os.remove(p["pfx"])
            except OSError:
                pass
            raise
        pfx = password = None
    except Exception as e:
        _update("cert", status="failed", error=cc._code(e, "IMPORT_FAILED"))
        raise
    _update("cert", status="ok", error=None, source=source, not_after=meta["not_after"],
            issuer_checked=meta["issuer_checked"])
    return {"cert": {"not_after": meta["not_after"], "issuer_checked": meta["issuer_checked"]},
            "probe": run_probe(push)}


def run_finish(push=None):
    st = read_status() or {}
    if (st.get("probe") or {}).get("state") != "ok":
        _refuse("PROBE_NOT_OK", "login has not passed yet")
    _update("worker", status="running", error=None)
    if push:
        push()
    try:
        r = cc._run_quiet([_python(), _paths()["worker"], "--install"], FINISH_TIMEOUT_S, "install")
        if r.returncode != 0:
            _refuse("WORKER_FAILED", "the 統一 worker did not start with a good snapshot")
    except Exception as e:
        _update("worker", status="failed", error=cc._code(e, "WORKER_FAILED"))
        raise
    _update("worker", status="ok", error=None)
    return {"worker": "ok"}


# ── dispatch ─────────────────────────────────────────────────────────────────

def _sweep_interrupted():
    """A runtime publish restarts the bridge and kills a Deferred mid-step: the
    status keeps `busy` and a section stuck at running/importing."""
    if not _busy.acquire(blocking=False):
        return
    try:
        st = read_status()
        if not st or not st.get("busy"):
            return
        for sec in _SECTIONS:
            if (st.get(sec) or {}).get("status") in ("running", "importing"):
                _update(sec, status="failed", error="INTERRUPTED")
        _update(busy=None)
    finally:
        _busy.release()


_JOBS = {
    "president_setup": lambda args, push: run_setup(push),
    "president_pfx": lambda args, push: run_pfx(args, push),
    "president_pfx_local": lambda args, push: run_pfx_local(args, push),
    "president_probe": lambda args, push: run_probe(push, after_unlock=bool(args)),
    "president_finish": lambda args, push: run_finish(push),
}


def dispatch(cmd, args, deferred_cls, push=None, local=False):
    """command_listener's HANDLERS entry for every name in COMMANDS."""
    if local:
        _refuse("LOCAL_MODE", "the desktop connects 統一期貨 on this computer, not through these commands")
    if not IS_WINDOWS:
        _refuse("NOT_WINDOWS", "統一期貨 needs a Windows host in this version")
    _sweep_interrupted()
    if cmd == "president_pfx_key":
        if not _read_vault().get(_SECRET):
            _refuse("NOT_BOUND", "save the account and trading password first")
        return cc.cmd_pfx_key(args, key_path=_paths()["key"])
    if cmd not in _JOBS:
        _refuse("BAD_ARGS", "unknown 統一 command")
    if cmd in ("president_pfx", "president_pfx_local"):
        cc.check_pfx_args(args)
    elif cmd == "president_probe":
        if args and not (set(args) == {"after_unlock"} and args["after_unlock"] is True):
            _refuse("BAD_ARGS", "president_probe takes nothing or {\"after_unlock\": true}")
    elif args:
        _refuse("BAD_ARGS", f"{cmd} takes no arguments")
    if cmd in ("president_probe", "president_finish") and (
            not os.path.isfile(_paths()["pfx"]) or _CA_PW not in _read_vault()):
        # an unreadable certificate is a CERT block in the lib, and one without its
        # password in the vault logs in with "" — never log in without both. Key
        # presence, not truthiness: a pfx with no password stores "".
        _refuse("CERT_MISSING", "upload the certificate first")
    if not _busy.acquire(blocking=False):
        _refuse("BUSY", f"another 統一 step is running ({(read_status() or {}).get('busy')})")
    try:
        _update(busy=cmd)
    except Exception:
        _busy.release()
        raise

    def cleanup():
        try:
            _update(busy=None)
        finally:
            _busy.release()

    return deferred_cls(lambda: _JOBS[cmd](args, push), cleanup=cleanup)


# ── desktop app (BLAVE_AGENT_LOCAL=1, Windows) ───────────────────────────────
# The commands above refuse in local mode. The app drives its own flow through
# ONE daemon command only its main process can send, `president_local`
# {op, sealed?, after_unlock?} (runtime/local_daemon.LOCAL_ONLY):
#   setup    unitrade into the desktop's venv (the worker's interpreter)
#   cert     {sealed: account, password, ca_password, live, src}: the file the
#            user chose (their PSCCA folder, or one they picked) is opened and
#            checked HERE (wrong password / not a certificate / expired never
#            reach the broker), COPIED to credentials/president.pfx (the
#            original stays for next year's renewal), .env written through the
#            normal bind (_cmd_credentials: eviction, manifest) with sentinels
#   secrets  {sealed: account, password, ca_password, live}: the app re-sends
#            the bundle after every daemon start; refused unless it is the
#            account and password .env was bound with
#   probe    `president_worker.py --once` ({after_unlock: true}: --unblock first)
#   start    the worker as this daemon's child, until its first good snapshot
#   stop     the worker stops (and is not restarted)
# Secrets live in this process's memory and travel to a child as one stdin line
# (lib/president_vault.STDIN_FLAG) — never a file, never the environment. The
# sealed payload is AES-GCM under a key derived from the daemon's HMAC secret,
# which exists only in the app's and this process's memory, so the command file
# on disk holds no plaintext. There is no ACL to set: the agent runs as the same
# user, and lib/president_vault.resolve gives it nothing to log in with.

LOCAL_OPS = ("setup", "cert", "secrets", "probe", "start", "stop")
_SEAL_INFO = b"president-local-seal-v1"
_SEAL_AAD = b"president-local-v1"
SEALED_MAX_CHARS = 8192
LOCAL_RESPAWN_S = 10
CERT_NOTICE_DAYS = ((0, "president_cert_expired"), (7, "president_cert_expiry_near"),
                    (31, "president_cert_expiring"))
_CHILD_FLAGS = {"BLAVE_PRESIDENT_LOCAL": "1", "BLAVE_PRESIDENT_STDIN": "1"}
_ACCOUNT_RE = re.compile(r"^[0-9]{11}$")


def _cl():
    import command_listener
    return command_listener


def set_seal_key(daemon_secret):
    """local_daemon at start: the key the app seals president_local payloads with."""
    _LOCAL["key"] = (hmac.new(daemon_secret.encode(), _SEAL_INFO, hashlib.sha256).digest()
                     if daemon_secret else None)


def open_sealed(blob):
    """base64(nonce 12 ‖ ciphertext ‖ tag 16) → dict. Any failure is one code:
    which part failed tells nobody anything useful."""
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


def _bundle(d, need_src=False):
    """The sealed payload's shape, checked; → {account, password, ca_password, live[, src]}."""
    acct, pw, ca, live = d.get("account"), d.get("password"), d.get("ca_password"), d.get("live")
    if not (isinstance(acct, str) and _ACCOUNT_RE.fullmatch(acct)):
        _refuse("BAD_ARGS", "the account is 11 digits")
    if not (isinstance(pw, str) and 0 < len(pw) <= 128 and not re.search(r"[\r\n\0]", pw)):
        _refuse("BAD_ARGS", "trading password")
    if not (isinstance(ca, str) and len(ca) <= 128 and not re.search(r"[\r\n\0]", ca)):
        _refuse("BAD_ARGS", "certificate password")
    if not isinstance(live, bool):
        _refuse("BAD_ARGS", "live must be true or false")
    out = {"account": acct, "password": pw, "ca_password": ca, "live": live}
    if need_src:
        src = d.get("src")
        if not (isinstance(src, str) and os.path.isabs(src) and src.lower().endswith(".pfx")
                and "\0" not in src and len(src) <= 1024):
            _refuse("BAD_ARGS", "certificate file")
        out["src"] = src
    return out


def _bound_env(b):
    p = _paths()
    return {_ACCOUNT: b["account"], _SECRET: VAULT_PW_PREFIX + vault_fingerprint(b["account"], b["password"]),
            _CA_PW: CA_SENTINEL, "president_ca_path": p["pfx"], "president_url": LIVE_URL}


def local_bind_gate(env):
    """command_listener._cmd_credentials, desktop, venue PRESIDENT: written only
    by the cert step below, for exactly the bundle it just checked — the
    certificate copied in place and opened with that password. A chat bind
    never gets here (its process keeps LOCAL_OPEN_VENUES paper-only)."""
    b = _LOCAL["pending"]
    want = _bound_env(b) if b else None
    got = {k.casefold(): v for k, v in env.items()}
    if not want or any(got.get(k) != v for k, v in want.items()) or set(got) != set(want) \
            or not os.path.isfile(_paths()["pfx"]):
        _refuse("NOT_CHECKED", "統一期貨 is bound from the app's connect flow on this computer")


def secret_line():
    """The one line a child that logs in reads off its stdin; "" = nothing to hand over."""
    s = _LOCAL["secrets"]
    if not s:
        return ""
    return json.dumps({_SECRET: s["password"], _CA_PW: s["ca_password"], "live": s["live"]})


def child_flags():
    return dict(_CHILD_FLAGS) if _LOCAL["secrets"] else {}


def _local_run(flag, timeout, what):
    cl = _cl()
    try:
        return subprocess.run([sys.executable, _paths()["worker"], flag], cwd=WORKSPACE,
                              input=(secret_line() + "\n").encode("utf-8"), capture_output=True,
                              timeout=timeout, env=cl._local_child_env(**_CHILD_FLAGS), **cl._child_kw())
    except subprocess.TimeoutExpired:
        raise RuntimeError(f"{what} timed out")
    except OSError as e:
        raise RuntimeError(f"{what} could not start ({type(e).__name__})")


def _env_bound_to(b):
    """.env holds this account, bound with this password (the sentinel's fingerprint)."""
    try:
        from lib import president_vault as pv
        env = pv.read_env(os.path.join(WORKSPACE, ".env"))
    except (ImportError, OSError):
        return False
    return (env.get(_ACCOUNT) == b["account"]
            and env.get(_SECRET) == VAULT_PW_PREFIX + vault_fingerprint(b["account"], b["password"]))


def _set_secrets(b):
    _LOCAL["secrets"] = {k: b[k] for k in ("account", "password", "ca_password", "live")}
    cb = _LOCAL["on_secrets"]
    if cb:
        try:  # the reconciler got its line at spawn: a new bundle needs a new reconciler
            cb()
        except Exception as e:
            print(f"[president_connect] reconciler respawn failed ({type(e).__name__})", file=sys.stderr)


class _LocalWorker:
    """lib/president_worker.py as this daemon's child (an NSSM LocalSystem
    service on a user's own computer would hand SYSTEM to whatever writes the
    workspace — the agent). Restarted after it exits, except while its login
    is blocked; stopped with the daemon. Read-only: it never sends an order."""

    def __init__(self):
        self.proc = None
        self.wanted = False
        self.respawn_at = None
        self.lock = threading.Lock()

    def _pid_path(self):
        return os.path.join(WORKSPACE, "state", "president_worker.pid")

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
            _refuse("NO_SECRETS", "the app has not handed over the 統一 credentials")
        cl = _cl()
        log = os.path.join(WORKSPACE, "state", "president_worker.log")
        os.makedirs(os.path.dirname(log), exist_ok=True)
        try:
            if os.path.getsize(log) > 5 * 1024 * 1024:
                os.replace(log, log + ".1")
        except OSError:
            pass
        with atomic_file.open_append(log) as logf:
            self.proc = subprocess.Popen([sys.executable, _paths()["worker"]], cwd=WORKSPACE,
                                         env=cl._local_child_env(**_CHILD_FLAGS), stdout=logf, stderr=logf,
                                         **cl._child_kw(stdin=subprocess.PIPE))
        try:  # the pipe stays open: closing it is how stop() asks first
            self.proc.stdin.write((line + "\n").encode("utf-8"))
            self.proc.stdin.flush()
        except OSError:
            pass
        try:
            with atomic_file.replacing(self._pid_path()) as f:
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
            p.terminate()
            try:
                p.wait(5)
            except subprocess.TimeoutExpired:
                p.kill()
        try:
            os.remove(self._pid_path())
        except OSError:
            pass

    def tick(self, blocked):
        with self.lock:
            if not self.wanted or self.proc is None or self.proc.poll() is None or blocked:
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
                print(f"[president_connect] worker restart failed ({type(e).__name__})", file=sys.stderr)
                self.respawn_at = time.time() + LOCAL_RESPAWN_S

    def reap_orphan(self, pid_cmdline):
        """A worker left by a daemon that died: it holds credentials nobody manages any more."""
        try:
            with open(self._pid_path()) as f:
                pid = int(f.read().strip())
        except (OSError, ValueError):
            return
        try:
            cmd = pid_cmdline(pid) if pid > 0 else ""
        except Exception:
            cmd = ""
        if "president_worker.py" in cmd and os.path.abspath(_paths()["worker"]) in cmd:
            try:
                os.kill(pid, signal.SIGTERM)
            except OSError:
                pass
        try:
            os.remove(self._pid_path())
        except OSError:
            pass


_LOCAL["worker"] = _LocalWorker()


def _block_on_file():
    """(kind, mark) of the lib's login block for the credentials handed over,
    or None. mark tells one block from the next (a release and a new failure)."""
    s = _LOCAL["secrets"]
    if not s:
        return None
    try:
        from lib import president_vault as pv
        b = pv._read_block()
        fp = pv.fingerprint({"account": s["account"], "password": s["password"],
                             "ca_path": _paths()["pfx"], "ca_password": s["ca_password"]})
        if b.get("fp") != fp or not pv._blocking(b) or b.get("allow_once"):
            return None
    except Exception:
        return None
    kind = str(b.get("kind") or "UNKNOWN")
    return kind, f"{fp}:{b.get('at')}"


def _halt_and_tell(kind):
    """Login blocked: every 統一 strategy stops (a desktop binds one venue at a
    time, so that is the machine's HALT — 啟動下單 lifts it once the login is
    fixed) and the user hears about it (P1, runtime/events)."""
    try:
        from lib.guard import trip_halt
        trip_halt(f"統一期貨登入被擋({kind}),Blave 已先停止下單 / 統一 login blocked ({kind})",
                  "president")
    except Exception as e:
        print(f"[president_connect] halt failed ({type(e).__name__})", file=sys.stderr)
    try:
        import events
        events.append("president_login_blocked", {"kind": kind})
    except Exception:
        pass


def _cert_notice(now=None):
    """One event per threshold per certificate: 31 days (P2), 7 days, expired (P1)."""
    st = read_status() or {}
    cert = st.get("cert") or {}
    exp = cert.get("not_after")
    if cert.get("status") != "ok" or not isinstance(exp, str):
        return
    try:
        ts = time.mktime(time.strptime(exp, "%Y-%m-%dT%H:%M:%SZ")) - time.timezone
    except ValueError:
        return
    days = (ts - (now or time.time())) / 86400
    sent = st.get("cert_notified") if isinstance(st.get("cert_notified"), dict) else {}
    if sent.get("not_after") != exp:
        sent = {"not_after": exp, "sent": []}
    for limit, ev in CERT_NOTICE_DAYS:
        if days <= limit:
            if ev not in sent["sent"]:
                try:
                    import events
                    events.append(ev, {"days": max(0, int(days)), "not_after": exp})
                except Exception:
                    pass
                sent["sent"] = sent["sent"] + [ev]
                _update(cert_notified=sent)
            return


def local_tick():
    """local_daemon's supervise loop, once a second."""
    blocked = _block_on_file()
    if blocked:
        st = read_status() or {}
        if st.get("block_seen") != blocked[1]:
            _update(block_seen=blocked[1])
            _update("worker", status="failed", error=f"BLOCKED:{blocked[0]}",
                    wanted=_LOCAL["worker"].wanted)
            _halt_and_tell(blocked[0])
    _LOCAL["worker"].tick(bool(blocked))
    if time.time() - _LOCAL["cert_check_at"] > 600:
        _LOCAL["cert_check_at"] = time.time()
        _cert_notice()


def local_info():
    """The status file's `president_local` (the app reads whether it must re-send)."""
    return {"secrets": _LOCAL["secrets"] is not None, "worker_running": _LOCAL["worker"].running()}


def local_shutdown():
    _LOCAL["worker"].stop("daemon stopping")
    _LOCAL["secrets"] = None


def _local_cert(b, push):
    _update("cert", status="importing", error=None, source="local", reset=True)
    if push:
        push()
    p = _paths()
    try:
        try:
            with open(b["src"], "rb") as f:
                data = f.read(cc.PFX_MAX_BYTES + 1)
        except OSError:
            _refuse("READ_FAILED", "the certificate file could not be read")
        meta = inspect_pfx(data, b["ca_password"])
        os.makedirs(p["cred"], exist_ok=True)
        with atomic_file.replacing(p["pfx"], "wb", perm=0o600) as f:
            f.write(data)
        data = None
        _LOCAL["pending"] = b
        try:
            _cl()._cmd_credentials({"env": _bound_env(b)})
        finally:
            _LOCAL["pending"] = None
    except Exception as e:
        _update("cert", status="failed", error=cc._code(e, "IMPORT_FAILED"),
                not_after=getattr(e, "not_after", None))
        raise
    for sec in ("probe", "worker"):
        _update(sec, reset=True, status="idle")
    _update("cert", status="ok", error=None, source="local", not_after=meta["not_after"],
            issuer_checked=meta["issuer_checked"])
    _LOCAL["worker"].stop("certificate replaced")
    _set_secrets(b)
    return {"cert": {"not_after": meta["not_after"], "issuer_checked": meta["issuer_checked"]}}


def _local_start(push):
    st = read_status() or {}
    if (st.get("probe") or {}).get("state") != "ok":
        _refuse("PROBE_NOT_OK", "login has not passed yet")
    _update("worker", status="running", error=None, wanted=True)
    if push:
        push()
    out = os.path.join(WORKSPACE, "state", "president_account.json")
    t0 = time.time()
    try:
        _LOCAL["worker"].start()
        deadline = t0 + FINISH_TIMEOUT_S
        while time.time() < deadline:
            try:
                if os.path.getmtime(out) >= t0:
                    with open(out, encoding="utf-8") as f:
                        if (json.load(f) or {}).get("ok") is True:
                            _update("worker", status="ok", error=None, wanted=True)
                            return {"worker": "ok"}
            except (OSError, ValueError, AttributeError):
                pass
            if _block_on_file():
                _refuse("BLOCKED", "the 統一 login is blocked")
            time.sleep(2)
        _refuse("WORKER_FAILED", "the 統一 worker wrote no good snapshot in time")
    except Exception as e:
        _LOCAL["worker"].stop("start failed")
        _update("worker", status="failed", error=cc._code(e, "WORKER_FAILED"), wanted=False)
        raise


def _local_jobs(op, args):
    if op == "setup":
        return lambda push: run_setup(push)
    if op == "cert":
        b = _bundle(open_sealed(args.get("sealed")), need_src=True)
        if not lib_supports_vault():
            _refuse("LIB_OUTDATED", "update the workspace before binding 統一期貨")
        return lambda push: _local_cert(b, push)
    if op == "probe":
        if _LOCAL["secrets"] is None:
            _refuse("NO_SECRETS", "the app has not handed over the 統一 credentials")
        if not os.path.isfile(_paths()["pfx"]):
            _refuse("CERT_MISSING", "choose the certificate first")
        return lambda push: run_probe(push, after_unlock=args.get("after_unlock") is True)
    if op == "start":
        if _LOCAL["secrets"] is None:
            _refuse("NO_SECRETS", "the app has not handed over the 統一 credentials")
        return lambda push: _local_start(push)
    return None


def local_dispatch(args, deferred_cls, push=None):
    """command_listener's handler for `president_local` (desktop only)."""
    if os.environ.get("BLAVE_AGENT_LOCAL") != "1":
        _refuse("NOT_LOCAL", "president_local runs on the desktop app only")
    op = args.get("op") if isinstance(args, dict) else None
    allowed = {"op", "sealed"} if op in ("cert", "secrets") else \
        {"op", "after_unlock"} if op == "probe" else {"op"}
    if op not in LOCAL_OPS or set(args) - allowed:
        _refuse("BAD_ARGS", "unknown president_local shape")
    if op == "probe" and "after_unlock" in args and args["after_unlock"] is not True:
        _refuse("BAD_ARGS", "after_unlock must be true")
    if not IS_WINDOWS:
        _refuse("NOT_WINDOWS", "統一期貨 needs Windows")
    if op == "stop":
        _LOCAL["worker"].stop("asked")
        _update("worker", create=False, wanted=False)
        return {"worker": "stopped"}
    if op == "secrets":
        b = _bundle(open_sealed(args.get("sealed")))
        if not _env_bound_to(b):
            _refuse("REBOUND", "this computer's .env is bound to other 統一 credentials")
        _set_secrets(b)
        w = (read_status() or {}).get("worker") or {}
        if w.get("wanted") and w.get("status") == "ok":
            try:
                _LOCAL["worker"].start()
            except Exception as e:
                _update("worker", status="failed", error=cc._code(e, "WORKER_FAILED"))
        return {"secrets": "ok"}
    _sweep_interrupted()
    job = _local_jobs(op, args)
    if not _busy.acquire(blocking=False):
        _refuse("BUSY", f"another 統一 step is running ({(read_status() or {}).get('busy')})")
    try:
        _update(busy="president_local:" + op)
    except Exception:
        _busy.release()
        raise

    def cleanup():
        try:
            _update(busy=None)
        finally:
            _busy.release()

    return deferred_cls(lambda: job(push), cleanup=cleanup)
