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
  president_probe    `lib/president_worker.py --once`; {"after_unlock": true}
                     runs `--unblock` first (the lib allows that once per block).
  president_finish   `lib/president_worker.py --install` (NSSM, LocalSystem).

Another way to get the certificate onto the machine (an issuance the agent runs
for the user) is one more command that ends where president_pfx ends: the
`cert` section with its own `source`, then the same probe and finish. Add its
name to COMMANDS and _JOBS, and to the api allow-list.

Vault (<base>/credentials/president_vault.json, = lib/president_vault.VAULT)
and president.pfx: SYSTEM + Administrators only. Unlike 群益's, both must be
readable by SYSTEM: the worker runs as LocalSystem, the reconciler as
Administrator. On a cloud box the agent's shell is SYSTEM too, so this keeps the
secrets and the production switch out of .env and out of the agent's ordinary
paths — it is not a wall against SYSTEM set on bypassing it.

Never put a secret, a pfx byte, a certificate subject (it carries the national
id) or a broker message into a return value, an exception, the status or a log.
"""
import hashlib
import json
import os
import subprocess
import sys
import threading
import time

import capital_connect as cc

WORKSPACE = os.environ.get("BLAVE_AGENT_WORKSPACE", "/opt/blave-agent/workspace")
IS_WINDOWS = os.name == "nt"

COMMANDS = ("president_setup", "president_pfx_key", "president_pfx", "president_probe",
            "president_finish")
UNITRADE_PIN = "unitrade==1.0.0.7"
LIVE_URL = "https://viploginm.pfctrade.com"
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
                "TIMEOUT": "timeout", "NON_TEST_SERVER": "unknown", "UNKNOWN": "unknown"}

_SECTIONS = ("setup", "cert", "probe", "worker")
_busy = threading.Lock()
_status_lock = threading.Lock()


def _paths():
    cred = os.path.join(os.path.dirname(WORKSPACE), "credentials")
    return {
        "cred": cred,
        "vault": os.path.join(cred, "president_vault.json"),
        "pfx": os.path.join(cred, "president.pfx"),
        "key": os.path.join(cred, "president_pfx_key.json"),
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
        with open(path + ".tmp", "w", encoding="utf-8") as f:
            json.dump(st, f)
        os.replace(path + ".tmp", path)
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
    tmp = f"{path}.{os.urandom(4).hex()}.tmp"
    try:
        with open(tmp, "wb") as f:
            f.write(data)
        if IS_WINDOWS:
            cc._icacls(tmp, "/inheritance:r", "/grant:r", "*S-1-5-18:F", "*S-1-5-32-544:F")
        os.replace(tmp, path)
    except BaseException:
        try:
            os.remove(tmp)
        except OSError:
            pass
        raise


def _write_vault(d):
    try:
        _write_private(_paths()["vault"], json.dumps(d).encode("utf-8"))
    except Exception as e:
        _refuse("VAULT_FAILED", type(e).__name__)


def divert_credentials(env, local=False):
    """_cmd_credentials hook: the trading password → the vault, production
    switched on there, sentinels + the fixed certificate path and production
    host → .env. Returns the env mapping to write. Unchanged on the desktop and
    off Windows (production stays off there: test hosts only), and for a write
    that does not carry both the account and a real password."""
    if not any(k.casefold().startswith("president_") for k in env):
        return env
    if local or not IS_WINDOWS:
        return env
    vals = {k.casefold(): v for k, v in env.items()}
    account, password = vals.get(_ACCOUNT), vals.get(_SECRET)
    if not account or not password or password.startswith(VAULT_PW_PREFIX):
        return env
    if not lib_supports_vault():
        _refuse("LIB_OUTDATED", "update the workspace before binding 統一期貨")
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
    p = _paths()
    for path in (p["vault"], p["pfx"], p["key"], p["status"]):
        try:
            os.remove(path)
        except FileNotFoundError:
            pass
        except OSError as e:
            print(f"[president_connect] {os.path.basename(path)} not removed ({type(e).__name__})",
                  file=sys.stderr)
    if IS_WINDOWS:
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
        _refuse("PFX_EXPIRED", "this certificate has expired — renew it first")
    return {"not_after": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(exp)), "not_after_ts": exp,
            "issuer_checked": checked}


# ── the steps ────────────────────────────────────────────────────────────────

def _python():
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


def run_probe(push=None, after_unlock=False):
    _update("probe", status="running", reset=True)
    if push:
        push()
    p = _paths()
    py = _python()
    if after_unlock:
        r = cc._run_quiet([py, p["worker"], "--unblock"], 60, "unblock")
        if r.returncode != 0:
            _update("probe", status="failed", state="unblock_used")
            _refuse("UNBLOCK_USED", "this block was already released once — re-enter the password")
    started = time.time() - 1
    try:
        rc = cc._run_quiet([py, p["worker"], "--once"], PROBE_TIMEOUT_S, "probe").returncode
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
    _update("cert", status="importing", error=None, source="upload")
    if push:
        push()
    p = _paths()
    try:
        pfx, password = cc.open_envelope(args["key_id"], args["envelope"], key_path=p["key"])
        meta = inspect_pfx(pfx, password)
        vault = _read_vault()
        if not vault.get(_SECRET):
            _refuse("NOT_BOUND", "save the account and trading password first")
        try:
            _write_private(p["pfx"], pfx)
        except Exception as e:
            _refuse("VAULT_FAILED", type(e).__name__)
        _write_vault(dict(vault, **{_CA_PW: password}))
        pfx = password = None
    except Exception as e:
        _update("cert", status="failed", error=cc._code(e, "IMPORT_FAILED"))
        raise
    _update("cert", status="ok", error=None, source="upload", not_after=meta["not_after"],
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
    if cmd == "president_pfx":
        cc.check_pfx_args(args)
    elif cmd == "president_probe":
        if args and not (set(args) == {"after_unlock"} and args["after_unlock"] is True):
            _refuse("BAD_ARGS", "president_probe takes nothing or {\"after_unlock\": true}")
    elif args:
        _refuse("BAD_ARGS", f"{cmd} takes no arguments")
    if cmd in ("president_probe", "president_finish") and not os.path.isfile(_paths()["pfx"]):
        # an unreadable certificate is a CERT block in the lib: never log in without one
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
