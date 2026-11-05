"""Where 統一期貨's login lives, which host it may reach, and the one login path.

Same contract as lib/capital_vault.py: only the order lib and
lib/president_worker.py log in — lib/account_president.py reads the worker's
snapshot and never holds a password. resolve() reads the workspace `.env`
itself with one parser (a caller-supplied mapping is never trusted: it could
point at another host, and two parsers can disagree on a quoted password — the
wrong one burns a login try). A `vault:` sentinel in president_password /
president_ca_password points at <base>/credentials/president_vault.json.

Host gate: production is switched on only by `"live": true` in the vault —
written by the platform's binding flow, never by `.env` (a PRESIDENT_LIVE line
there is refused, not obeyed: `.env` is a file the agent writes). Without it
only a *.testpfctrade.com host is accepted (the test hosts' TLS certificate
covers exactly that — the broker's mail writes test167.pfctrade.com, the
working URL is https://test167.testpfctrade.com), and a server that reports
itself not a test server is refused after login. With it, president_url is
used. The vault keeps this out of the agent's ordinary write path; on a cloud
box the agent runs as SYSTEM like the worker, so — as lib/capital_vault says
of its own file — it stops accidents, not a SYSTEM process set on bypassing it.

Login failures leave this module as a CLASS only (PASSWORD, CERT, CERT_MISMATCH,
UNKNOWN, TIMEOUT, MAINTENANCE — display only), never the broker's text: when the
certificate does not match the account, the SDK's message is
f"{national id} {certificate json}". Every broker string that is passed on goes
through sanitize() first. The one kept is an UNKNOWN stop's "detail" (below); classify()
sends any text with an id shape to CERT_MISMATCH, so that one never holds an id.

統一 locks an account after three wrong logins, so a failed login STOPS logging in
on this machine: any failure (MAINTENANCE aside — that is never attempted) writes
state/president_login_stop.json with its class, and every later login refuses
with STOPPED without contacting the broker — the worker, the order lib, a flatten.
Only an explicit login (`president_worker.py --once`, the user's 「確認登入」)
tries again, once per press, and a login that passes removes the stop.

One exception (Wei 2026-11-05): a TIMEOUT — the broker unreachable or silent — writes no
stop the first time in a row; the LoginError carries `retry` and the caller may try once
more. The second TIMEOUT in a row stops like any other failure; any login that passes
resets the count (state/president_login_timeouts.json, shared by the worker and the order
lib). A timeout may have delivered the password (unitrade sends it in its first request
and folds connect and read timeouts into one "Timeout"), so this spends at most two of
統一's three tries before the stop, and leaves the third to the user's 「確認登入」.

An UNKNOWN stop keeps the broker's text, sanitized, under "detail" in the stop file —
local only: the platform report copies kind and at, nothing else.

Every order waits on that press, so the stop itself is the user's P1
(venue_login_blocked, notifications.md): once per stop, carrying the class only. An explicit
login that fails is not: the user is looking at the answer. notify_stopped records it in the
stop file; an append that failed is retried from the reconciler's round.

Desktop app (Windows): there is no vault file. The app keeps the trading and
certificate passwords in the OS's encrypted store and hands them to the local
daemon in memory; the daemon gives them to exactly the processes that log in
(the worker, the probe, the reconciler, a flatten) as ONE line on their stdin,
flagged by BLAVE_PRESIDENT_STDIN=1 — never a file, never the environment. Any
process started with BLAVE_PRESIDENT_LOCAL=1 or BLAVE_AGENT_LOCAL=1 reads only
that (the agent's own turns get nothing, so they cannot log in), and production
is whatever that line says (`"live": true`).

Imported two ways like capital_vault: `import president_vault` from the
worker script (lib/ is sys.path[0]), `lib.president_vault` elsewhere. Keep it
free of other lib imports.
"""
import hashlib
import json
import os
import re
import secrets
import time
from datetime import datetime, time as dtime, timedelta, timezone
from contextlib import contextmanager
from urllib.parse import urlparse

try:
    import fcntl
    msvcrt = None
except ImportError:  # Windows
    fcntl = None
    import msvcrt

try:
    if __package__ == "lib":  # never a same-named file elsewhere on sys.path
        from lib.winreplace import atomic_replace
    else:  # run as a script: lib/ is sys.path[0]
        from winreplace import atomic_replace
except ImportError:  # half-updated workspace (lib/winreplace.py not landed): plain replace
    atomic_replace = os.replace
try:
    if __package__ == "lib":  # never a same-named file elsewhere on sys.path
        from lib.winreplace import load_json
    else:  # run as a script: lib/ is sys.path[0]
        from winreplace import load_json
except ImportError:  # half-updated workspace (lib/winreplace.py without load_json): no read retry
    def load_json(path, **open_kw):
        with open(path, **open_kw) as f:
            return json.load(f)

_WS = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ENV_PATH = os.path.join(_WS, ".env")
VAULT = os.path.join(os.path.dirname(_WS), "credentials", "president_vault.json")
# The SDK's own logs carry the login id (the national id) and every order: next
# to the vault (credentials\ — SYSTEM + Administrators on a cloud box), not in
# the agent's state/. Removed with the vault on unbind.
SDK_LOG_DIR = os.path.join(os.path.dirname(VAULT), "president_logs")
LEGACY_SDK_LOG_DIR = os.path.join(_WS, "state", "president_logs")
PW_PREFIX = "vault:"
TEST_HOST_SUFFIX = ".testpfctrade.com"
# the production login hosts (both logged in with a matching TLS certificate, 10-02)
LIVE_HOSTS = ("viploginm.pfctrade.com", "viploginb.pfctrade.com")
TAIPEI = timezone(timedelta(hours=8), "Asia/Taipei")  # no ZoneInfo: Windows has no tz database
LOGIN_MAINTENANCE = (dtime(5, 30), dtime(5, 50))
_SECRETS = ("president_password", "president_ca_password")
# a failed login stops further logins until the user confirms one (see the docstring)
STOP = os.path.join(_WS, "state", "president_login_stop.json")
TIMEOUTS_BEFORE_STOP = 2


def _timeouts_path():
    return os.path.join(os.path.dirname(STOP), "president_login_timeouts.json")  # beside STOP, wherever it points
# How long after a send the worker's next read must START before it counts as
# showing that send (order lib close check, reconciler Read-Your-Writes). An IOC
# market order is filled or killed at the exchange within the second; what is
# unknown is how late the broker's position query reflects it (the test host
# never fills). Live account, 10-02 (TMF 1 lot, one buy + one close): the
# broker's position query showed the fill 12.0 s and 10.9 s after the send
# marker — the marker is written before the ~5–6 s login, so those figures are on
# the same clock this guard uses. 20 s covers both with ~8 s to spare; the worker
# delays its refresh-flag read to match, so a close waits ~20–22 s after the
# previous order.
ORDER_SETTLE_S = 20


LOCAL_FLAG = "BLAVE_PRESIDENT_LOCAL"
STDIN_FLAG = "BLAVE_PRESIDENT_STDIN"
_LOCAL = None  # desktop: what the daemon handed over (use_local_secrets / the stdin line)


def _local_mode():
    return (_LOCAL is not None or os.environ.get(LOCAL_FLAG) == "1"
            or os.environ.get("BLAVE_AGENT_LOCAL") == "1")


def use_local_secrets(d):
    """Desktop: the daemon's bundle {president_password, president_ca_password,
    live}, set by whoever read it (runtime/local_daemon.run_reconciler)."""
    global _LOCAL
    _LOCAL = {k: d[k] for k in ("president_password", "president_ca_password", "live") if k in d} \
        if isinstance(d, dict) else {}


def credentials_ready():
    """False only on the desktop when the daemon has not handed the passwords over
    yet (it gives a reconciler started before that an empty line): a login now
    would fail on a missing password, so callers skip instead of erroring."""
    if not _local_mode():
        return True
    return isinstance(_local_secrets().get("president_password"), str)


def read_stdin_line(fd=0, limit=8192):
    """One line off the raw fd, byte by byte: nothing may stay in a Python-side
    buffer for a later reader of the same fd (the reconciler's parent watch)."""
    out = bytearray()
    while len(out) < limit:
        b = os.read(fd, 1)
        if not b or b == b"\n":
            break
        out += b
    return out.decode("utf-8", "replace").strip()


def _local_secrets():
    if _LOCAL is None and os.environ.get(STDIN_FLAG) == "1":
        os.environ.pop(STDIN_FLAG, None)  # read once; a child of ours must not wait on it
        try:
            d = json.loads(read_stdin_line() or "{}")
        except (OSError, ValueError):
            d = {}
        use_local_secrets(d)
    return _LOCAL or {}


class LoginError(RuntimeError):
    """A failed 統一期貨 login. str() is the class and a fixed description, nothing else."""

    TEXT = {
        "CERT_MISMATCH": "the certificate does not belong to this account",
        "CERT": "the certificate or its password was refused",
        "PASSWORD": "the account or trading password was refused",
        "TIMEOUT": "the login host could not be reached or did not answer in time",
        "MAINTENANCE": "broker login maintenance (05:30–05:50 Taipei) — not attempted",
        "STOPPED": "an earlier login failed — not attempted until the user confirms the login again "
                   "(統一 locks the account after three wrong logins)",
        "NON_TEST_SERVER": "the server is not a test server and production is not switched on",
        "UNKNOWN": "the broker refused the login",
        "BUSY": "another login on this machine is still running — not attempted",
    }

    def __init__(self, kind, retry=False):
        self.kind = kind
        self.retry = retry
        super().__init__(f"統一期貨 login failed: {kind} — {self.TEXT.get(kind, '')}")


# The one place personal-id shapes live: 國民身分證 (letter + 1/2 + 8 digits), 新式居留證
# (letter + 8/9 + 8 digits) and 舊式居留證 (two letters, second A-D, + 8 digits); the
# certificate CN wraps one as "TW" + id + "1".
ID_PATTERN = r"(?:TW)?[A-Z][A-D1289]\d{8}1?"
_ID_RE = re.compile(ID_PATTERN)
_BLOB_RE = re.compile(r"\{.*\}", re.S)


def sanitize(text, limit=200):
    """A broker message safe to log, store or show: no national ids, no dict /
    certificate blobs, bounded length."""
    s = _BLOB_RE.sub("{…}", str(text or ""))
    return _ID_RE.sub("<id>", s)[:limit]


def classify(text):
    """Class of a failed login from the SDK's error text (never returned itself)."""
    s = str(text or "")
    if "subject" in s or "PSCNET" in s or _ID_RE.search(s):
        return "CERT_MISMATCH"
    if "憑證" in s or re.search(r"\b50(1[0-3]|6[01]|70)\b", s):
        return "CERT"
    # the broker unreachable or silent (no connection, reset, read timeout): one class
    if any(t in s for t in ("Connection aborted", "RemoteDisconnected", "Connection reset",
                            "ConnectionResetError", "ReadTimeout", "Read timed out", "NameResolution",
                            "getaddrinfo", "Failed to establish", "ConnectTimeout", "Connection refused",
                            "SSLError", "CERTIFICATE_VERIFY_FAILED", "Max retries", "ConnectionError")) \
            or s.strip() == "Timeout" or "timed out" in s.lower():
        return "TIMEOUT"
    # [SP000101] wrong password, [AG000005] no such login id (統一's own FAQ, PFCEC/unitrade)
    if any(t in s for t in ("密碼", "查無此使用者", "使用者密碼未設定", "[SP000101]", "[AG000005]")):
        return "PASSWORD"
    return "UNKNOWN"


# ── .env ─────────────────────────────────────────────────────────────────────

def read_env(path=None):
    """The workspace `.env`: KEY=VALUE per line, BOM tolerated (PowerShell 5
    writes one), one pair of matching surrounding quotes removed, nothing else
    interpreted. Keys are folded to lower case."""
    env = {}
    with open(path or ENV_PATH, encoding="utf-8-sig") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            v = v.strip()
            if len(v) >= 2 and v[0] == v[-1] and v[0] in "'\"":
                v = v[1:-1]
            env[k.strip().casefold()] = v
    return env


def live():
    """True only when the platform's binding flow wrote `"live": true` into the
    vault. Absent, unreadable or anything but the JSON true → test hosts only.
    Desktop: the daemon's line, never a file."""
    if _local_mode():
        return _local_secrets().get("live") is True
    try:
        with open(VAULT, encoding="utf-8") as f:
            v = json.load(f)
    except (OSError, ValueError):
        return False
    return isinstance(v, dict) and v.get("live") is True


def endpoint(env):
    """The login URL this environment may use, or ValueError."""
    if live():
        url = (env.get("president_url") or "").strip()
        if not url:
            raise ValueError("統一期貨 production is switched on but president_url is not set")
        host = (urlparse(url).hostname or "").lower()
        if host not in LIVE_HOSTS:
            raise ValueError(f"president_url host {host or url!r} is not a known 統一 production "
                             f"login host {LIVE_HOSTS}")
    else:
        if str(env.get("president_live") or "").strip().lower() == "true":
            # refused rather than ignored: whoever wrote it expects production
            raise ValueError("PRESIDENT_LIVE in .env does not switch 統一期貨 to production — "
                             "only the platform's binding flow does (credentials/president_vault.json)")
        url = (env.get("president_test_url") or "").strip()
        host = (urlparse(url).hostname or "").lower()
        if not host.endswith(TEST_HOST_SUFFIX):
            raise ValueError(f"president_test_url host {host or url!r} is not *{TEST_HOST_SUFFIX} — "
                             f"until production is switched on only the broker's test hosts are allowed")
    if urlparse(url).scheme != "https":
        raise ValueError(f"president login URL must be https://, got {url!r}")
    return url.rstrip("/")


def resolve(_ignored=None):
    """{url, account, password, ca_path, ca_password, live} from the workspace
    `.env`; secrets come from the vault when `.env` holds the sentinel. The
    argument is accepted for call compatibility and ignored."""
    try:
        env = read_env()
    except OSError as e:
        raise ValueError(f".env unreadable ({type(e).__name__})")
    creds = {k: env.get(k) or "" for k in ("president_account", "president_ca_path") + _SECRETS}
    if any(creds[k].startswith(PW_PREFIX) for k in _SECRETS) and _local_mode():
        got = _local_secrets()
        for k in _SECRETS:
            if creds[k].startswith(PW_PREFIX):
                if not isinstance(got.get(k), str):
                    raise RuntimeError("president credentials were not handed over by the Blave app "
                                       "— open the app (自動下單) and try again")
                creds[k] = got[k]
    elif any(creds[k].startswith(PW_PREFIX) for k in _SECRETS):
        try:
            with open(VAULT, encoding="utf-8") as f:
                v = json.load(f)
        except PermissionError:
            raise RuntimeError("president credentials vault not readable by this identity")
        except (OSError, ValueError) as e:
            raise RuntimeError(f"president credentials vault unreadable ({type(e).__name__}) — rebind 統一期貨")
        for k in _SECRETS:
            if creds[k].startswith(PW_PREFIX):
                creds[k] = v.get(k) or ""
    if not creds["president_account"] or not creds["president_password"]:
        raise ValueError("president_account / president_password missing from .env")
    if not creds["president_ca_path"]:
        raise ValueError("president_ca_path missing from .env (the .pfx certificate)")
    return {"url": endpoint(env), "account": creds["president_account"],
            "password": creds["president_password"], "ca_path": creds["president_ca_path"],
            "ca_password": creds["president_ca_password"], "live": live()}


# ── login stop (shared by every caller on this machine) ─────────────────────

def _pfx_readable(ca_path):
    try:
        with open(ca_path, "rb"):
            return True
    except (OSError, TypeError):
        return False


def replace_json(path, obj):
    """json.dump to `path` through a fresh O_EXCL temp named the way
    runtime/atomic_file names its own (.<name>.<12 hex>.tmp), so a symlink the
    agent parks at a fixed `path.tmp` is never written through and the runtime's
    start-up sweep clears what a killed writer leaves. lib/ cannot import
    runtime/atomic_file (separate update channels). Raises OSError."""
    d, base = os.path.split(path)
    os.makedirs(d, exist_ok=True)
    tmp = os.path.join(d, f".{base}.{secrets.token_hex(6)}.tmp")
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_BINARY", 0), 0o666)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(obj, f)
        atomic_replace(tmp, path)
    except BaseException:
        try:
            os.remove(tmp)
        except OSError:
            pass
        raise


def stopped():
    """The class of the failed login that stopped logins here, or None."""
    try:
        with open(STOP, encoding="utf-8") as f:
            st = json.load(f)
    except FileNotFoundError:
        return None
    except (OSError, ValueError):
        return "UNKNOWN"  # unreadable is not "clear"
    return str(st.get("kind") or "UNKNOWN") if isinstance(st, dict) else "UNKNOWN"


def _stop(kind, explicit=False, detail=None):
    stop = {"kind": kind, "at": int(time.time())}
    if kind == "UNKNOWN" and detail:
        stop["detail"] = sanitize(detail)
    if explicit:
        stop["notified"] = True
    try:
        replace_json(STOP, stop)
    except OSError:
        pass
    if not explicit:
        notify_stopped()


def _held_rows():
    """The last snapshot's rows as 'TXFK6 +2', or None when it has none to give: the worker
    replaces it with ok=false right after a failed login, and a retried notice comes later."""
    try:
        rows = load_json(os.path.join(_WS, "state", "president_account.json"), encoding="utf-8").get("positions")
        return [f"{str(r['productid'])[:12]} {int(r['net']):+d}" for r in rows][:10] if rows else None
    except (OSError, ValueError, AttributeError, KeyError, TypeError):
        return None


def notify_stopped(min_age=0):
    """The standing stop's P1, once. `min_age`: the reconciler's retry leaves the writer of a
    stop this long to send it itself. Never raises: a notice must not cost a login path."""
    try:
        st = load_json(STOP, encoding="utf-8")
        if not isinstance(st, dict) or st.get("notified") or time.time() - float(st.get("at") or 0) < min_age:
            return
        if __package__ == "lib":
            from lib.events import emit
        else:  # run as a script: lib/ is sys.path[0]
            from events import emit
        if emit("venue_login_blocked", venue="president", reason=str(st.get("kind") or "UNKNOWN"),
                positions=_held_rows()) is not None:
            replace_json(STOP, dict(st, notified=True))
    except (OSError, ValueError, TypeError, ImportError):
        pass


def _clear():
    for path in (STOP, _timeouts_path()):
        try:
            os.remove(path)
        except OSError:
            pass


def _timeout_stops():
    """Count one more TIMEOUT in a row; True when it is the one that stops. A count that
    cannot be read or written stops: an unknown count must not buy another try."""
    try:
        n = int(load_json(_timeouts_path(), encoding="utf-8").get("count") or 0)
    except FileNotFoundError:
        n = 0
    except (OSError, ValueError, AttributeError, TypeError):
        return True
    if n + 1 >= TIMEOUTS_BEFORE_STOP:
        return True
    try:
        replace_json(_timeouts_path(), {"count": n + 1, "at": int(time.time())})
    except OSError:
        return True
    return False


def in_login_maintenance(now=None):
    t = (now or datetime.now(TAIPEI)).astimezone(TAIPEI).time()
    return LOGIN_MAINTENANCE[0] <= t < LOGIN_MAINTENANCE[1]


# ── the one login path (worker and order lib) ────────────────────────────────
LOGIN_TIMEOUT_S = 30
# a holder runs one login: up to LOGIN_TIMEOUT_S, twice that when it hangs and is joined again
LOGIN_LOCK_WAIT_S = 2 * LOGIN_TIMEOUT_S + 15


@contextmanager
def _login_lock(wait_s=None):
    """One login at a time on this machine (worker, orders, 「確認登入」): the STOP and the
    TIMEOUT count are read after the previous login wrote them, so two logins in flight can
    never spend a third try together. An OS lock (flock / msvcrt): the OS drops it when its
    holder dies. LoginError("BUSY") — no stop — when it is not free in time."""
    path = os.path.join(os.path.dirname(STOP), "president_login.lock")
    os.makedirs(os.path.dirname(path), exist_ok=True)
    fd = os.open(path, os.O_CREAT | os.O_RDWR, 0o600)
    deadline = time.time() + (LOGIN_LOCK_WAIT_S if wait_s is None else wait_s)
    try:
        while True:
            try:
                if fcntl:
                    fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                else:
                    os.lseek(fd, 0, os.SEEK_SET)
                    msvcrt.locking(fd, msvcrt.LK_NBLCK, 1)
                break
            except OSError:
                if time.time() > deadline:
                    raise LoginError("BUSY")
                time.sleep(0.1)
        try:
            yield
        finally:
            try:
                if fcntl:
                    fcntl.flock(fd, fcntl.LOCK_UN)
                else:
                    os.lseek(fd, 0, os.SEEK_SET)
                    msvcrt.locking(fd, msvcrt.LK_UNLCK, 1)
            except OSError:
                pass
    finally:
        os.close(fd)


class _CwdOs:
    """`os` as the unitrade modules see it, with getcwd() pinned: the SDK writes
    its logs (login URL, login id, account, every order) to os.getcwd()+"/logs",
    which in a reconciler process is the workspace root. chdir is process-wide
    and the reconciler reads relative paths from other threads, so the SDK's own
    view of cwd is pinned instead."""

    def __init__(self, real, cwd):
        self._real, self._cwd = real, cwd

    def getcwd(self):
        return self._cwd

    def __getattr__(self, name):
        return getattr(self._real, name)


def _pin_sdk_logs(log_dir):
    import sys
    os.makedirs(log_dir, exist_ok=True)
    proxy = _CwdOs(os, log_dir)
    for name, mod in list(sys.modules.items()):
        if (name == "unitrade" or name.startswith("unitrade.")) and getattr(mod, "os", None) is os:
            mod.os = proxy


def login(creds, log_dir, explicit=False):
    """A logged-in Unitrade, or LoginError. The caller MUST logout() in a
    finally: the SDK starts non-daemon threads (logger, sockets) at login and a
    process that exits without logout() hangs on them forever — failed logins
    included (measured on the test host 2026-09-30). The returned object is
    logged out here on every failure path.

    A failure stops logins (STOP); after that only `explicit` (the user's
    「確認登入」 through president_worker --once) contacts the broker again."""
    if in_login_maintenance():
        raise LoginError("MAINTENANCE")
    with _login_lock():
        return _login_locked(creds, log_dir, explicit)


def _login_locked(creds, log_dir, explicit):
    import threading

    if not explicit and stopped():
        raise LoginError("STOPPED")
    if not _pfx_readable(creds.get("ca_path")):
        # the SDK sends the password before it opens the certificate: an unreadable
        # .pfx would spend a broker login try for nothing
        _stop("CERT", explicit)
        raise LoginError("CERT")

    from unitrade.unitrade import Unitrade

    _pin_sdk_logs(log_dir)
    api = Unitrade()
    box = {}

    def _run():
        try:
            box["resp"] = api.login(creds["url"], creds["account"], creds["password"],
                                    creds["ca_path"], creds["ca_password"] or "")
        except BaseException as e:  # noqa: BLE001 — classified below, never passed on
            box["exc"] = e

    t = threading.Thread(target=_run, daemon=True, name="president-login")
    t.start()
    t.join(LOGIN_TIMEOUT_S)
    try:
        text = None
        if t.is_alive():
            kind = "TIMEOUT"
        elif "exc" in box:
            text = f"{type(box['exc']).__name__} {box['exc']}"
            kind = classify(text)
        elif not box["resp"].ok:
            text = str(box["resp"].error)
            kind = classify(text)
        else:
            kind = None
        if kind is not None:
            if kind == "TIMEOUT" and not explicit and not _timeout_stops():
                raise LoginError(kind, retry=True)
            _stop(kind, explicit, text)
            raise LoginError(kind)
        if not creds["live"] and api.test_mode is not True:
            _stop("UNKNOWN", explicit)
            raise LoginError("NON_TEST_SERVER")
        _clear()
        return api
    except BaseException:
        api.logout()
        if t.is_alive():
            # a login still in flight can start the SDK threads after this logout
            t.join(LOGIN_TIMEOUT_S)
            api.logout()
        raise
