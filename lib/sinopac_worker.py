"""SinoPac (永豐期貨) futures worker — the machine's one Shioaji login.

NOT live-verified as a whole: tested with a faked SDK (tests/check_sinopac_futures.py).
M0-b (2026-11-16, real account, 1.7.11) ran the raw calls once: a TMF market IOC buy and its
close both Filled. Until lib/venue_traits' sinopac row lists "futures" in verified_modes this
worker does not log in at all.

M0-b, 1.7.11:
- contracts load in the background after login. fetch_contracts() then raises
  ShioajiTimeoutError "exclusive access lost", so it is never called; api.Contracts is deprecated
  and Contracts.status does not exist at runtime. Contracts come from contracts v2
  (api.contracts.futures(root) → bases with code + delivery_date), which raises until the load
  is done: login waits for it up to CONTRACTS_WAIT_S, a read before then fails and is retried.
  Month codes are root + month letter + last year digit (TMFK6 … TMFI7) = president_contracts.
- list_positions read right after a Filled order still returned []. Every send writes the
  lib/sinopac_vault marker first; this worker's own pre-send read and its snapshot re-read wait
  until ORDER_SETTLE_S after it, so an empty read inside that window is never taken as flat.
- login(subscribe_trade=True), passed explicitly at the SDK default (the exclusive-access error
  above is not caused by it). Orders are confirmed by update_status polling only (no order
  callback is registered), so the subscription is not needed for that; False is unmeasured.

Why one process holds the login: every Shioaji client of one national id
counts against the same 5-connection cap, and a 451 Too Many Connections can
lock out the person's other sessions. So this worker is the only login on the
machine — it reads margin + positions every POLL_S into
state/sinopac_account.json (lib/sinopac_futures_account.py only reads that file) and
places the futures orders lib/order_sinopac.py hands it as request files in
state/sinopac_orders/.

A login that never reached an answer (timeout, connection, network down, 503 maintenance, 451 too
many connections) is tried again for good — spaced (LOGIN_RETRY_S, then LOGIN_RETRY_LONG_S),
persisted across restarts, 451 waits LOGIN_451_WAIT_S — with a `waiting` snapshot the reconciler
skips the round on, and exchange_unreachable as the streak's notice (Wei 11-17, as 群益). Every
login is recorded as failed BEFORE it is tried and the record stays until the session has held
LOGIN_STABLE_S: a process killed mid-login, or crashing soon after one, restarts on the same ladder
— never an immediate login (the national id's 1000 logins a day and its 451 lock are shared). Any
other failed login —
credentials, certificate, not signed, no futures account, the SDK version, anything unidentified —
stops the worker (exit LOGIN_STOPPED_EXIT, written to state/sinopac_login_stopped.json). Only `--once` (the user
confirming a login) clears it. The stop is the user's P1 venue_login_blocked, sent once; it stops
永豐 only — no HALT. A read that fails after a good login keeps the session and retries on the
next tick — never a re-login.

Shioaji's native core prints the national id to fds 1/2 ("Session Property
modification ok … /PYAPI/<id>/", M0-a 2026-11-15): both fds go through
quiet_sdk for the worker's whole life. Importing shioaji opens shioaji.log in the
cwd (M0-b; reproduced on macOS: the import alone creates it), which is the
workspace, and may carry the same session line (unread). SJ_LOG_PATH is a file
path the core opens instead (macOS import: the null device leaves no file; an
unopenable path falls back to stdout, i.e. through quiet_sdk), so null_sdk_log()
forces it to the null device before every shioaji import.

M0-a on Windows (2026-11-15): the console is not UTF-8 (printing Chinese raised
UnicodeEncodeError), and a process that exits without api.logout() never exits
— Shioaji's session threads keep it alive. So stdout/stderr are UTF-8 with
errors replaced, SIGTERM / SIGBREAK become a normal exit through the finally
that logs out, and the entry point ends with os._exit.

The futures-enabled marker (ENABLED_PATH) is what makes flatten and the account reader treat 永豐
as bound: a worker that cannot write it does not log in (exit STATE_EXIT), or the reconciler would
trade a venue a close-all skips. The login record above fails the same way.

Credentials come from lib/sinopac_vault.resolve, never from .env values (it holds sentinels): a
machine not bound through the connect flow, or a desktop whose app has not handed them over, exits
NOT_BOUND_EXIT with no STOP and no notice. An unbind or rebind seen in .env logs out and exits the
same way — the cloud's unbind has no right to stop this service.

Desktop (runtime/sinopac_local.py): the credentials are the first line on stdin, then STOP_ON_EOF=1 in the environment makes the closing of stdin the
stop request — Windows has no signal that reaches the finally — taken between requests, never
mid-order.

Run: python lib/sinopac_worker.py          (daemon)
     python lib/sinopac_worker.py --once   (one login + read → state/sinopac_probe.json)
     python lib/sinopac_worker.py --sim-test   (the signing review's simulation order → state/sinopac_sim_test.json)
     python lib/sinopac_worker.py --install / --uninstall   (Windows cloud: NSSM blave-agent-sinopac)
"""
import os
import sys

# Before any other import, in the process itself (not when a test imports this file): the workspace folders come
# off sys.path and only lib/ is reachable from the workspace, through lib/secret_imports.py (audit 2026-11-19 M1).
# os is loaded at interpreter startup and runpy is imported only once the workspace is off sys.path.
# Same block in lib/president_worker.py, lib/capital_worker.py, lib/sinopac_worker.py, manager/reconciler.py,
# manager/flatten.py.
if __name__ == "__main__" and not __package__:
    _WS = os.path.dirname(os.path.dirname(os.path.realpath(__file__)))
    _OWN = {os.path.normcase(os.path.realpath(d)) for d in (_WS, os.path.join(_WS, "lib"), os.path.join(_WS, "manager"))}
    sys.path[:] = [p for p in sys.path if os.path.normcase(os.path.realpath(p or os.curdir)) not in _OWN]
    import runpy
    _imports = runpy.run_path(os.path.join(_WS, "lib", "secret_imports.py"))
    _imports["install"](_WS, _imports["SCRIPT_SIBLINGS"])

import contextlib
import errno
import hashlib
import json
import re
import signal
import socket
import ssl
import threading
import time

WORKSPACE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if not any(type(f).__name__ == "WorkspaceLibFinder" for f in sys.meta_path) and WORKSPACE not in sys.path:  # imported by a test; a run has the finder
    sys.path.append(WORKSPACE)

from lib import events, guard, president_contracts as contracts, sinopac_vault, tw_clock, venue_traits  # noqa: E402
from lib.winreplace import atomic_replace, load_json, read_retry  # noqa: E402

STATE = os.path.join(WORKSPACE, "state")
OUT_PATH = os.path.join(STATE, "sinopac_account.json")
PROBE_PATH = os.path.join(STATE, "sinopac_probe.json")
STOP_PATH = sinopac_vault.LOGIN_STOPPED_PATH  # the reconciler skips 永豐 while it exists
TAGS_PATH = os.path.join(STATE, "sinopac_order_tags.json")
# the same derivations as lib/order_sinopac.py (producer side)
ORDERS_DIR = os.path.join(STATE, "sinopac_orders")
REFRESH_FLAG = os.path.join(STATE, "sinopac_refresh")
HEARTBEAT_PATH = os.path.join(STATE, "heartbeat", "sinopac_worker")
RETRY_PATH = os.path.join(STATE, "sinopac_login_retry.json")
# = lib/venue_traits sinopac bound_marker: this machine has had 永豐 futures. Written by every start
# past the gate, never removed (an unbind keeps it), so a lost snapshot reads as an error, not as
# a machine that never had futures (Wei 11-17)
ENABLED_PATH = os.path.join(STATE, "sinopac_futures_enabled.json")
# = runtime/sinopac_service.WANTED: written by the connect flow's last step, removed on rebind / unbind
WANTED_PATH = os.path.join(STATE, "sinopac_worker_wanted.json")

POLL_S = 60
# waits after the 1st..5th unanswered login in a row, then LOGIN_RETRY_LONG_S for good (Wei 11-17:
# retry like 群益, never a STOP). Each failed login logs out, so no connection is held meanwhile.
# The streak's notice is exchange_unreachable UNREACHABLE_AFTER_S in (the 6th failure, 25 min), then every
# UNREACHABLE_REPEAT_S; the reconciler skips those rounds (`waiting` snapshot), so it sends none.
LOGIN_RETRY_S = (60, 120, 240, 480, 600)
LOGIN_RETRY_LONG_S = 1800
UNREACHABLE_AFTER_S = 1500
UNREACHABLE_REPEAT_S = 7200
# = api agent_events.CAPITAL_UNREADABLE_P1_MIN: the platform raises the notice to P1 from here on (Wei
# 11-17, as 群益). The 30-minute retries alone would land at 145 and 175: one retry is moved onto it
UNREACHABLE_P1_AT_S = 150 * 60
LOGIN_451_WAIT_S = 600  # resume plan §4: after a 451, wait 10 minutes
# a session that held this long was not a crash loop: its login record is dropped. A crash before
# it climbs the ladder — at most ~48 logins a day, under the national id's 1000
LOGIN_STABLE_S = 1800
REQUEST_CHECK_S = 0.5
CONFIRM_POLL_S = 1.0
CONTRACTS_WAIT_S = 60.0
CONTRACTS_POLL_S = 1.0
SEND_MARGIN_S = 5.0  # a request waits out the settle window only when this much is left to confirm
# One update_status call's cap. The SDK default is 30 s = lib/order_sinopac.WORKER_STALE_S, and _confirm
# beats only between calls: one call hanging that long reads as a dead worker to the next requester.
# 5 s keeps the heartbeat under ~6 s old and lets the confirm loop see its own deadline.
UPDATE_STATUS_TIMEOUT_S = 5.0
# After an entry's fill the position is read every LAG_PROBE_S, only to time when it shows, counted
# from the send as ORDER_SETTLE_S is (state/sinopac_settle_lag.json, for
# sinopac_vault.ORDER_SETTLE_MEASURED_S): those reads never replace the snapshot, so nothing trades
# on them. They go on past the window up to LAG_PROBE_MAX_S = 3 × ORDER_SETTLE_S: the 11-23 bound
# was ~21 s, so a lag just past 20 s is timed rather than recorded as "not seen", and a measured
# value can still be checked against M3's "window ≥ twice the lag" (≤ 30 reads per fill).
# Closes are not timed: an empty read is what M0-b's lag looked like, so "flat" would be seen early.
LAG_PROBE_S = 2.0
LAG_PROBE_MAX_S = 60.0
LAG_PATH = os.path.join(STATE, "sinopac_settle_lag.json")
LAG_KEEP = 20
LOGIN_STOPPED_EXIT = 3
UNVERIFIED_EXIT = 4
STATE_EXIT = 5  # the futures-enabled marker or the login record not written: no login, try again later
NOT_BOUND_EXIT = 6  # not bound through the connect flow, credentials not handed over, or unbound: no STOP
STOP_ON_EOF = "BLAVE_SINOPAC_STOP_ON_EOF"
_STOP = threading.Event()  # set by _watch_stdin; read only between requests
VERIFIED = "futures" in venue_traits.verified_modes("sinopac")
SDK_VERSION = "1.7.11"  # the version M0 ran; any other is refused before a login
ROOTS = contracts.ROOTS
TERMINAL = {"Filled", "Cancelled", "Failed", "Inactive"}
FAILED = {"Failed", "Inactive"}

# 身分證 (A123456789), 居留證 old (AB12345678) and new (A812345678); any case — a hand-typed
# .env value can be lowercase and the SDK echoes it as given
_ID_RE = re.compile(r"(?<![A-Za-z0-9])[A-Z][A-D1289]\d{8}(?![0-9])", re.IGNORECASE)
# A value printed under its field name: the SDK's account repr and order events carry the futures
# account (broker_id / account_id — the 11-23 live run's worker log had both in full), the owner's
# name, and the credentials by name. Python repr, dict and `name: value` forms alike.
_FIELD_RE = re.compile(
    r"""(['"]?\b(?:account_id|broker_id|person_id|username|api_key|secret_key|ca_passwd|ca_path)\b['"]?\s*[:=]\s*)"""
    r"""(['"]?)[^'",\s)}\]]+""", re.IGNORECASE)
# 1.7.11 echoes the API key on a bad signature: "Detail: key: <API Key> not match signature."
_KEY_RE = re.compile(r"(\bkey\s*:\s*)[^\s'\",]+", re.IGNORECASE)
# Anything shaped like a key or secret: 24+ characters of a token alphabet with a letter and a digit
_TOKEN_RE = re.compile(r"(?<![A-Za-z0-9+=_-])(?=[A-Za-z0-9+_-]*\d)(?=[A-Za-z0-9+_-]*[A-Za-z])"
                       r"[A-Za-z0-9+_-]{24,}={0,2}(?![A-Za-z0-9+=_-])")
# This login's own values (remember_secrets), masked wherever they turn up whatever their shape
_SECRETS = set()
SECRET_MIN_LEN = 6


def remember_secrets(*values):
    for v in values:
        v = str(v or "").strip()
        if len(v) >= SECRET_MIN_LEN:
            _SECRETS.add(v)


def redact(text):
    """The national ID, the futures account and the credentials out of anything the worker writes."""
    text = _ID_RE.sub("<id>", str(text))
    for v in sorted(tuple(_SECRETS), key=len, reverse=True):
        text = text.replace(v, "<redacted>")
    text = _FIELD_RE.sub(lambda m: f"{m.group(1)}{m.group(2)}<redacted>", text)
    text = _KEY_RE.sub(lambda m: f"{m.group(1)}<redacted>", text)
    return _TOKEN_RE.sub("<redacted>", text)


class quiet_sdk:
    """fds 1 and 2 through a pipe each, every line masked by redact() before it reaches the
    original fd. Catches what native code writes (Python-level redirection does not). A
    process without usable fds 1/2 (no console) is left as is: nothing can print there."""

    def __enter__(self):
        self._saved, self._threads = [], []
        try:
            sys.stdout.flush()
            sys.stderr.flush()
        except (OSError, ValueError, AttributeError):
            pass
        try:
            for fd in (1, 2):
                saved = os.dup(fd)
                r, wfd = os.pipe()
                os.dup2(wfd, fd)
                os.close(wfd)
                self._saved.append((fd, saved))
                t = threading.Thread(target=self._pump, args=(r, saved), daemon=True)
                t.start()
                self._threads.append(t)
        except OSError:
            self._restore()
        return self

    @staticmethod
    def _pump(r, out):
        # never stops reading before EOF: a pump that quits would block every later write once
        # the pipe fills, the order path included
        buf = b""
        while True:
            try:
                chunk = os.read(r, 65536)
            except OSError:
                break
            if not chunk:
                break
            buf += chunk
            lines = buf.split(b"\n")
            buf = lines.pop()
            if len(buf) > 65536:
                lines.append(buf)
                buf = b""
            for ln in lines:
                try:
                    os.write(out, redact(ln.decode("utf-8", "replace")).encode("utf-8") + b"\n")
                except OSError:
                    pass
        if buf:
            try:
                os.write(out, redact(buf.decode("utf-8", "replace")).encode("utf-8"))
            except OSError:
                pass
        try:
            os.close(r)
        except OSError:
            pass

    def _restore(self):
        try:
            sys.stdout.flush()
            sys.stderr.flush()
        except (OSError, ValueError, AttributeError):
            pass
        for fd, saved in self._saved:
            os.dup2(saved, fd)  # the pipe's last write end closes: its pump reads EOF
        for t in self._threads:
            t.join(2)
        for (_, saved), t in zip(self._saved, self._threads):
            if not t.is_alive():  # a live pump keeps writing to it; a reused fd number would get that
                os.close(saved)
        self._saved, self._threads = [], []

    def __exit__(self, *exc):
        self._restore()
        return False


def _utf8_console():
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except (AttributeError, ValueError, OSError):
            pass


def _exit_on_signals():
    """SIGTERM (systemd, kill) and SIGBREAK (Windows service stop) unwind like Ctrl-C, so the
    finally blocks log out instead of the process dying mid-session or hanging on its threads."""
    def stop(signum, _frame):
        raise SystemExit(0)
    for name in ("SIGTERM", "SIGBREAK"):
        sig = getattr(signal, name, None)
        if sig is not None:
            try:
                signal.signal(sig, stop)
            except (ValueError, OSError):
                pass


def _log(msg):
    print(f"[sinopac_worker] {redact(msg)}", flush=True)  # never a key, id or account number


def _enum(v):
    """'Filled' from an SDK enum (1.7.x EnumMixin.value) or a plain string (1.5.x)."""
    return str(getattr(v, "value", v) or "")


def _atomic_write(path, payload):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = f"{path}.{os.getpid()}.tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False)
    atomic_replace(tmp, path)


def _read_text(path):
    with open(path, encoding="utf-8") as f:
        return f.read()


def _read_env(path):
    # a swallowed Windows replace-window PermissionError would read as "keys missing" and
    # write the STOP record, which only the user's confirmed login clears
    env = {}
    try:
        text = read_retry(_read_text, path)
    except FileNotFoundError:
        return env
    for line in text.splitlines():
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            k, v = line.split("=", 1)
            env[k.strip()] = v.strip().strip("'\"")
    return env


def creds():
    """This machine's 永豐 login, from the credential store (lib/sinopac_vault.resolve): .env holds
    sentinels under the locked lowercase names, never the values."""
    return sinopac_vault.resolve(_read_env(os.path.join(WORKSPACE, ".env")))


def _bound_key():
    """.env's sinopac_api_key sentinel now: changes on an unbind (gone) or a rebind (another key)."""
    try:
        return _read_env(os.path.join(WORKSPACE, ".env")).get("sinopac_api_key", "")
    except OSError:
        return None  # unreadable this time (Windows mid-replace): not taken as an unbind


class LoginError(RuntimeError):
    """`reason`: the venue_login_blocked class (api notify._LOGIN_BLOCK_REASON)."""

    def __init__(self, msg, reason="UNKNOWN"):
        super().__init__(msg)
        self.reason = reason


def _futures_account(sj, api, accounts):
    """The login's futures account, picked by its AccountType (1.7: Stock / Future / Intl)."""
    future = getattr(getattr(sj, "AccountType", None), "Future", None)
    for a in accounts or []:
        if future is not None and getattr(a, "account_type", None) == future:
            return a
    return api.futopt_account


def null_sdk_log():
    """Before any `import shioaji`: forced, so an SJ_LOG_PATH from the shell cannot point it back
    at the workspace. Has no effect once shioaji is imported in this process."""
    os.environ["SJ_LOG_PATH"] = os.devnull


def login(c, require_signed=True):
    """(api, futures account). Logs out on every failure path. require_signed=False: the signing
    review's simulation test only (run_sim_test), on an account that is not signed yet."""
    null_sdk_log()
    import shioaji as sj

    version = str(getattr(sj, "__version__", "") or "")
    if version != SDK_VERSION:
        raise LoginError(f"shioaji {version or '(unknown version)'} installed — the 永豐 futures "
                         f"worker runs on {SDK_VERSION} only; nothing logged in", "VERSION")
    remember_secrets(c["sinopac_api_key"], c["sinopac_secret_key"], c.get("sinopac_ca_passwd"),
                     c.get("sinopac_person_id"))
    api = sj.Shioaji(simulation=not c["live"])
    try:
        accounts = api.login(api_key=c["sinopac_api_key"], secret_key=c["sinopac_secret_key"],
                             subscribe_trade=True)
        for a in list(accounts or []) + [getattr(api, "futopt_account", None)]:
            remember_secrets(getattr(a, "account_id", None), getattr(a, "broker_id", None),
                             getattr(a, "username", None))
        if c["live"]:
            try:
                ok = api.activate_ca(ca_path=c["sinopac_ca_path"], ca_passwd=c["sinopac_ca_passwd"],
                                     person_id=c["sinopac_person_id"] or c["sinopac_ca_passwd"])
            except Exception as e:
                if retryable(e):
                    raise
                raise LoginError(f"activate_ca failed: {_sanitize(e)}", "CERT") from None
            if not ok:
                raise LoginError("activate_ca returned falsy — certificate not usable", "CERT")
        acct = _futures_account(sj, api, accounts)
        if acct is None:
            raise LoginError("login returned no futures account (期貨戶未開或 API 未勾期貨)", "NO_FUTURES")
        if require_signed and getattr(acct, "signed", True) is False:
            raise LoginError("futures account not signed (期貨 API 聲明書未簽或審核中)", "NOT_SIGNED")
        if not wait_contracts(api):
            # not a failed login (no STOP, no P1): every read fails until the list is there
            _log(f"contract list not loaded {CONTRACTS_WAIT_S:.0f}s after login — reads retry")
        return api, acct
    except Exception:
        try:
            api.logout()
        except Exception:
            pass
        raise


def _sanitize(e):
    # Shioaji error texts can carry the person id ("CA not activated for: A123456789")
    return redact(f"{type(e).__name__}: {e}")[:200]


def _sdk_classes(e):
    # shioaji is imported only inside login(): its classes are matched by name. The hierarchy is
    # 1.7.11's type stubs (_core.pyi, read 11-17); measured so far: a wrong secret (BadRequestError)
    return {k.__name__ for k in type(e).__mro__}


def too_many_connections(e):
    return bool(re.search(r"\b451\b", str(e))) or "too many connection" in str(e).lower()


# A machine whose network is not up yet (boot) or just dropped: these stay plain OSError — unlike
# ETIMEDOUT / ECONNREFUSED / ECONNRESET, Python maps them to no TimeoutError / ConnectionError
# subclass. By number only: FileNotFoundError / PermissionError on the certificate are OSErrors too
# and must stay a CERT stop. Windows sockets report the WSA numbers.
_NETWORK_ERRNOS = frozenset(v for v in (getattr(errno, n, None) for n in (
    "ENETUNREACH", "EHOSTUNREACH", "ENETDOWN", "EHOSTDOWN", "ENETRESET",
    "WSAENETUNREACH", "WSAEHOSTUNREACH", "WSAENETDOWN", "WSAEHOSTDOWN", "WSAENETRESET")) if v is not None)


_OS_STOPS = (FileNotFoundError, PermissionError, IsADirectoryError, NotADirectoryError,
             ssl.SSLCertVerificationError)


def retryable(e):
    """The login never got an answer: a timeout, a connection error (ShioajiTimeoutError /
    ShioajiConnectionError subclass the builtins), the network down or unreachable, DNS while the
    network comes up, 503 maintenance, 451 too many connections. Never one of this module's own
    LoginErrors."""
    if isinstance(e, LoginError):
        return False
    if isinstance(e, (TimeoutError, ConnectionError, socket.gaierror)):
        return True
    if isinstance(e, OSError) and (e.errno in _NETWORK_ERRNOS
                                   or getattr(e, "winerror", None) in _NETWORK_ERRNOS):
        return True
    # any other OSError is the connection too (EADDRNOTAVAIL at boot, a TLS handshake cut short) —
    # except a file the login could not read and a server certificate that did not verify
    if isinstance(e, OSError) and not isinstance(e, _OS_STOPS):
        return True
    return "SystemMaintenance" in _sdk_classes(e) or too_many_connections(e)


# login(receive_window=) at the SDK default, 30000 ms: a request stamped further off is refused
RECEIVE_WINDOW_S = 30


def _clock_off():
    """lib/tw_clock's measured skew past the receive window; False when not measured."""
    try:
        s = tw_clock.gross_skew()
    except Exception:
        return False
    return s is not None and abs(s) > RECEIVE_WINDOW_S


def _login_reason(e):
    """The venue_login_blocked class (api notify._LOGIN_BLOCK_REASON; the connect screen reads it
    from the probe and STOP files). TOO_MANY and TIMEOUT are retried, never a stop. KEY: a mistyped
    secret raised BadRequestError "StatusCode: 400, Detail: key: <API Key> not match signature."
    (11-23 live run, 1.7.11); the stubs' AuthError family (HTTP 401) is read as KEY too. CLOCK is
    unmeasured: a refusal while this machine's clock is measured off past RECEIVE_WINDOW_S (checked
    first: a skewed request may come back as the same bad signature)."""
    if isinstance(e, LoginError):
        return e.reason
    names = _sdk_classes(e)
    if "AccountNotSignError" in names:
        return "NOT_SIGNED"
    if "CaError" in names:
        return "CERT"
    if too_many_connections(e):
        return "TOO_MANY"
    if retryable(e):
        return "TIMEOUT"
    if isinstance(e, ImportError):
        return "VERSION"  # shioaji missing or broken: the connect step reinstalls it
    if "ShioajiError" in names and _clock_off():  # the broker refused, not one of our own checks
        return "CLOCK"
    if "AuthError" in names or ("BadRequestError" in names and "not match signature" in str(e).lower()):
        return "KEY"
    return "UNKNOWN"


# ── reads ────────────────────────────────────────────────────────────────────

def futures_bases(api, root):
    """Contracts v2 bases of `root` (R1/R2 continuous aliases included — never ordered).
    Raises until the SDK's background contract load is done."""
    return list(api.contracts.futures(root))


def wait_contracts(api, wait_s=None):
    """True once every root's list answers; False past the wait (the exception type before the
    load is not recorded, so any exception counts as not loaded yet)."""
    deadline = time.time() + (CONTRACTS_WAIT_S if wait_s is None else wait_s)
    while True:
        try:
            for root in ROOTS:
                futures_bases(api, root)
            return True
        except Exception:
            if time.time() >= deadline or _STOP.is_set():
                return False
        _beat()
        time.sleep(CONTRACTS_POLL_S)


def _year_month(d):
    """(year, month) of a delivery date — a date, or text like 2026/11/18, 2026-11-18,
    20261118, 202611 (the base's type is not recorded) — else None."""
    if hasattr(d, "year") and hasattr(d, "month"):
        return int(d.year), int(d.month)
    parts = re.findall(r"\d+", str(d or ""))
    if len(parts) >= 2 and len(parts[0]) == 4:  # 2026/1/20, 2026-01-20: split on the separators
        y, m = int(parts[0]), int(parts[1])
    elif len(parts) == 1 and len(parts[0]) in (6, 8):  # 20260120, 202601: one unbroken run
        y, m = int(parts[0][:4]), int(parts[0][4:6])
    else:
        return None
    return (y, m) if 1 <= m <= 12 else None


def _delivery(api, base):
    """(year, month) the base delivers in: its delivery_date, else api.contracts.info(base)'s
    delivery_date / delivery_month. None when neither says."""
    ym = _year_month(getattr(base, "delivery_date", None))
    if ym:
        return ym
    info = api.contracts.info(base)
    return _year_month(getattr(info, "delivery_date", None)) or \
        _year_month(getattr(info, "delivery_month", None))


def listed_contracts(api):
    """{root: [month codes]} from the broker's contract list (R1/R2 aliases dropped). A month code
    whose delivery month disagrees with president_contracts' reading of it fails the read: the
    contract pick would be trading on a wrong calendar."""
    out = {}
    for root in ROOTS:
        codes = []
        for b in futures_bases(api, root):
            code = str(getattr(b, "code", "") or "").upper()
            if not contracts.PROD_RE.match(code):
                continue
            ym = _delivery(api, b)
            if ym and contracts.prod_id(root, *ym) != code:
                raise RuntimeError(f"contract list: {code} delivers {ym[0]}-{ym[1]:02d}, which is "
                                   f"{contracts.prod_id(root, *ym)} — month code reading is wrong")
            codes.append(code)
        out[root] = sorted(codes)
    return out


def contract_for(api, code):
    """The base to order `code` (a month code) on, from the broker's list."""
    if not contracts.PROD_RE.match(code):
        raise ValueError(f"{code!r} is not a month contract (R1/R2 cannot be ordered)")
    for b in futures_bases(api, code[:3]):
        if str(getattr(b, "code", "") or "").upper() == code:
            return b
    raise ValueError(f"contract {code} is not in the broker's list — not trading on a guess")


def position_row(api, p):
    """One FuturePosition → {'root','productid','net',...}, None for other products.
    Unverified: whether `code` is the month code (TXFK6; M0-b's reads after the fills were
    still empty) — falls back to the contract list's base for that code when it is not."""
    code = str(getattr(p, "code", "") or "").upper()
    if contracts.PROD_RE.match(code):
        pid = code
    else:
        b = api.contracts.get(code) if code else None
        info = api.contracts.info(b) if b is not None else None
        root = str(getattr(info, "root", "") or "").upper()
        if root not in ROOTS:
            if code[:3] in ROOTS:
                raise RuntimeError(f"list_positions: {code!r} looks like {code[:3]} but cannot be read")
            return None
        ym = _delivery(api, b)
        if not ym:
            raise RuntimeError(f"list_positions: {code!r} has no delivery month")
        pid = contracts.prod_id(root, *ym)
    qty = int(p.quantity)
    net = qty if _enum(p.direction) == "Buy" else -qty
    return {"root": pid[:3], "productid": pid, "net": net,
            "avg_cost": float(getattr(p, "price", 0) or 0),
            "floating_pnl": float(getattr(p, "pnl", 0) or 0)}


def read_account(api, acct):
    snap = {"ok": True, "error": None, "currency": "TWD", "positions": [],
            "query_started_at": time.time()}
    m = api.margin(acct)
    snap["equity"] = float(m.equity)                                  # 權益數 (unverified vs app)
    snap["available"] = float(getattr(m, "available_margin", 0) or 0)  # 可用保證金
    snap["initial_margin"] = float(getattr(m, "initial_margin", 0) or 0)
    snap["maintenance_margin"] = float(getattr(m, "maintenance_margin", 0) or 0)
    snap["day_flow"] = float(getattr(m, "deposit_withdrawal", 0) or 0)  # not a flow source
    for p in api.list_positions(acct) or []:
        r = position_row(api, p)
        if r and r["net"]:
            snap["positions"].append(r)
    snap["listed"] = listed_contracts(api)
    snap["account_fp"] = hashlib.sha256(
        f"sinopac-account-v1\0{getattr(acct, 'account_id', '')}".encode()).hexdigest()[:16]
    snap["account_masked"] = mask_account(getattr(acct, "account_id", ""))
    return snap


def mask_account(account_id):
    """The done page's account line: the last 4 characters only (`****1234`); "" when none."""
    a = str(account_id or "").strip()
    return "****" + a[-4:] if len(a) > 4 else ("****" if a else "")


def _write_snapshot(snap):
    snap["read_at"] = time.time()
    _atomic_write(OUT_PATH, snap)


# ── orders ───────────────────────────────────────────────────────────────────

def _tags_today():
    today = time.strftime("%Y-%m-%d", time.gmtime(time.time() + 8 * 3600))
    try:
        book = load_json(TAGS_PATH, encoding="utf-8")
    except (OSError, ValueError):
        book = {}
    return today, (book.get("tags", []) if book.get("date") == today else [])


class UserRefusal(ValueError):
    """A refusal worded for the user's order-failure card: answered without the exception name."""


def pick_contract(rows, root, intent, action, lots, listed, now=None, book_months=None):
    """(contract code, octype name) or raises ValueError — the check is on a
    position read taken right before the send, inside the one session.

    book_months: the 'YYYY-MM' months the caller's book holds for `root` (empty = none), or None
    (no book: the calendar decides, president_contracts.bot_rows). A month outside them is the
    user's own: never closed, never added to, never opened into, and it does not block the bot's."""
    book = None if book_months is None else {root: set(book_months)}
    keep, _residue, manual = contracts.bot_rows([r for r in rows if r["root"] == root],
                                                listed, now, book, broker="永豐")
    held = [r for r in keep if r["net"]]
    if len(held) > 1:
        raise ValueError(f"{root} is held in several months "
                         f"{sorted(r['productid'] for r in held)} — no order until one settles")
    if intent == "reduce":
        if not held:
            raise ValueError(f"no open {root} position of the bot's — nothing to close")
        net = held[0]["net"]
        if action != ("sell" if net > 0 else "buy"):
            raise ValueError(f"{held[0]['productid']} is {net:+d} — a {action} would add to it")
        if lots > abs(net):
            raise ValueError(f"closing {lots} of {held[0]['productid']} but only {abs(net)} held")
        return held[0]["productid"], "Cover"
    code = held[0]["productid"] if held else contracts.computed_near(root, now)
    if code in {r["productid"] for r in manual}:
        raise UserRefusal(f"你在永豐 app 自己持有 {code}，Blave 不會開進同一個月份。平掉那筆後，"
                          f"下一輪會照訊號開倉。")
    if code not in (listed or {}).get(root, []):
        raise ValueError(f"contract {code} is not in the broker's list — not trading on a guess")
    return code, "Auto"


def _fills(trade):
    deals = list(getattr(trade.status, "deals", None) or [])
    qty = sum(int(d.quantity) for d in deals)
    avg = sum(float(d.price) * int(d.quantity) for d in deals) / qty if qty else 0.0
    reported = int(getattr(trade.status, "deal_quantity", 0) or 0)
    return max(qty, reported), avg


def _refresh(api, trade, deadline=None):
    # 1.7.11 takes the account or one trade, never both ("Cannot specify both account and trade",
    # every fill of the 11-23 live run)
    left = UPDATE_STATUS_TIMEOUT_S if deadline is None else deadline - time.time()
    api.update_status(trade=trade, timeout=int(max(1.0, min(UPDATE_STATUS_TIMEOUT_S, left)) * 1000))
    oid = str(getattr(trade.order, "id", "") or "")
    for t in api.list_trades() or []:
        if oid and str(getattr(t.order, "id", "")) == oid:
            return t
    return trade


class _NotSettled(Exception):
    pass


def _wait_settled(req):
    """Hold the pre-send position read until it starts ORDER_SETTLE_S after this machine's last
    send (M0-b: a read right after a fill still showed none — a close would read "nothing held",
    a second close the old position). Waits when that leaves SEND_MARGIN_S before the request
    expires, else _NotSettled: nothing sent, the caller's next round asks again."""
    try:
        ready = sinopac_vault.settled_at()
    except sinopac_vault.MarkerUnreadable as e:
        raise _NotSettled(str(e)) from None
    if ready <= time.time():
        return
    if ready > float(req["expires_at"]) - SEND_MARGIN_S:
        raise _NotSettled(f"the last 永豐 send was under {sinopac_vault.ORDER_SETTLE_S}s ago — its "
                          f"position read is not settled yet; nothing sent")
    while True:
        left = ready - time.time()
        if left <= 0:
            return
        _beat()
        time.sleep(min(REQUEST_CHECK_S, left))


def _check_request(fields):
    """Before any gate reads the request (audit M5): guard.check_restart_stop and the HALT freeze
    let a 'cancel' or a missing intent through, and pick_contract reads anything but 'reduce' as
    an entry — so only the exact values lib/order_sinopac writes pass."""
    if fields["intent"] not in ("entry", "reduce"):
        raise ValueError(f"intent {fields['intent']!r} is not entry or reduce — not sent")
    if fields["action"] not in ("buy", "sell"):
        raise ValueError(f"action {fields['action']!r} is not buy or sell — not sent")
    if fields["symbol"] not in ROOTS:
        raise ValueError(f"symbol {fields['symbol']!r} is not one of {'/'.join(ROOTS)} — not sent")
    qty = fields["qty"]
    if isinstance(qty, bool) or not isinstance(qty, int) or qty < 1:
        raise ValueError(f"qty {qty!r} is not a whole number of lots >= 1 — not sent")


def execute(api, acct, req, simulation, timeout=None):
    """One request → response dict. A refusal is 'rejected'; a request that came inside the
    settle window of the previous send is 'deferred' (nothing sent either way)."""
    import shioaji as sj

    fields = {k: req.get(k) for k in ("venue", "market", "symbol", "action", "qty", "unit", "intent")}
    try:
        _check_request(fields)
        if time.time() > float(req.get("expires_at") or 0):
            raise ValueError("request expired before the worker took it")
        _wait_settled(req)
        # the requester (flatten / close_symbol) holds the user's pass in its own process; the
        # request carries it for this one reduce, and only around the gate check
        with contextlib.ExitStack() as passes:
            if fields["intent"] == "reduce" and req.get("halt_close_pass") is True:
                passes.enter_context(guard.halt_close_pass(fields["symbol"], "sinopac_worker"))
            if fields["intent"] == "reduce" and req.get("close_all_pass") is True:
                passes.enter_context(guard.close_all_relay(fields["symbol"], "sinopac_worker"))
            guard.check_restart_stop(fields["intent"], fields)
        guard.check_account_hold("sinopac", fields["intent"], fields)
        if fields["intent"] == "entry":
            _check_entry_hold(fields)
        tag = req.get("client_tag")
        today, tags = _tags_today()
        if tag and tag in tags:
            raise ValueError(f"client_tag {tag!r} was already sent today")
        snap = read_account(api, acct)
        months = req.get("book_months")
        if months is not None and not (isinstance(months, list) and all(isinstance(m, str) for m in months)):
            raise ValueError("the request's book_months is not a list of months")
        code, octype = pick_contract(snap["positions"], fields["symbol"], fields["intent"],
                                     fields["action"], int(fields["qty"]), snap["listed"],
                                     book_months=months)
        contract = contract_for(api, code)

        def order_of(price_type):
            # sj.FuturesOrder, not the deprecated sj.Order (1.7.11)
            return sj.FuturesOrder(
                action=sj.Action.Buy if fields["action"] == "buy" else sj.Action.Sell,
                price=0, quantity=int(fields["qty"]),
                price_type=getattr(sj.FuturesPriceType, price_type), time_in_force=sj.TimeInForce.IOC,
                octype=getattr(sj.FuturesOCType, octype), custom_field=tag, account=acct)
    except _NotSettled as e:
        err = _sanitize(e)
        guard.audit("order_deferred", error=err, **fields)
        return {"status": "deferred", "error": err, "symbol": fields["symbol"]}
    except Exception as e:
        err = redact(e)[:200] if isinstance(e, UserRefusal) else _sanitize(e)
        guard.audit("order_error", error=err, **fields)
        return {"status": "rejected", "error": err, "symbol": fields["symbol"]}

    deadline = time.time() + (timeout or max(5.0, float(req["expires_at"]) - time.time()))
    # M0-b: TMF MKT + IOC filled, buy and close. A Failed MKT with no fill sent nothing, so it is
    # sent once more as MKP (range market) + IOC (that path is unmeasured). Never after Cancelled
    # (an IOC the market did not take) or an unknown outcome — either may already be a position.
    for price_type in ("MKT", "MKP"):
        try:
            sinopac_vault.mark_order_sent()
        except OSError as e:
            err = f"last-order marker not written ({type(e).__name__}) — not sent"
            guard.audit("order_error", error=err, contract=code, price_type=price_type, **fields)
            return {"status": "rejected", "error": err, "symbol": code, "price_type": price_type}
        guard.audit("order_sent", contract=code, price_type=price_type, **fields)
        try:
            trade = api.place_order(contract, order_of(price_type))
        except Exception as e:
            # a timeout here may still have reached the exchange: never report it as refused
            err = _sanitize(e)
            guard.audit("order_unknown_status", error=err, contract=code, price_type=price_type, **fields)
            return {"status": "unknown", "error": err, "symbol": code, "price_type": price_type}
        if tag and price_type == "MKT":
            try:
                _atomic_write(TAGS_PATH, {"date": today, "tags": tags + [tag]})
            except OSError as e:
                _log(f"client_tag book not written: {type(e).__name__}")
        status, trade = _confirm(api, acct, trade, deadline)
        qty, avg = _fills(trade)
        if not (status == "Failed" and not qty and price_type == "MKT"):
            break
        guard.audit("order_error", error=_sanitize(getattr(trade.status, "msg", "") or status),
                    contract=code, price_type=price_type, retry="MKP", **fields)
    base = {"symbol": code, "seqno": str(getattr(trade.order, "seqno", "") or ""),
            "ordno": str(getattr(trade.order, "ordno", "") or ""), "broker_status": status,
            "price_type": price_type, "simulation": simulation}
    if status in FAILED and not qty:
        err = _sanitize(getattr(trade.status, "msg", "") or status)
        guard.audit("order_error", error=err, contract=code, price_type=price_type, **fields)
        # from_broker: 永豐 itself refused it (every earlier 'rejected' is this worker's own check);
        # only this one can be the market being shut (lib/order_sinopac._submit_futures)
        return dict(base, status="rejected", error=err, from_broker=True)
    if qty:
        guard.audit("order_filled", contract=code, fill_qty=qty, avg_fill_price=avg,
                    price_type=price_type, **fields)
        before = sum(int(r["net"]) for r in snap["positions"] if r["productid"] == code)
        want = before + (qty if fields["action"] == "buy" else -qty)
        if fields["intent"] == "entry" and want:
            _arm_lag_probe(code, want, sinopac_vault.last_order_at() or time.time(), simulation)
    return dict(base, status="filled" if qty else "sent", fill_qty=float(qty), avg_fill_price=avg)


def _confirm(api, acct, trade, deadline):
    """Poll to a terminal status or the deadline: (status text, latest trade)."""
    while True:
        _beat()  # a confirm can outlast WORKER_STALE_S: the next caller must not read the worker as down
        try:
            trade = _refresh(api, trade, deadline)
        except Exception as e:
            _log(f"update_status failed: {_sanitize(e)}")
        status = _enum(trade.status.status)
        if status in TERMINAL or time.time() >= deadline:
            return status, trade
        time.sleep(CONFIRM_POLL_S)


def _check_entry_hold(fields):
    """lib/tw_clock's entry gate, at send time: an entry outside the regular session is queued to
    the open and read as unfilled, and a clock past SKEW_BLOCK_S off sends on a wrong session.
    The reconciler holds these first and tells the user; this is the order path's own backstop."""
    hold = tw_clock.entry_hold()
    if hold is None:
        return
    guard.audit("order_denied_session", why=hold["why"], **fields)
    if hold["why"] == "clock":
        raise ValueError(f"entry held: this machine's clock is {hold['skew']:+.0f} s off the api's")
    raise ValueError("entry held: outside the TAIFEX regular session (it would queue to the open)")


_LAG_PROBE = {}


def _arm_lag_probe(code, want_net, sent_at, simulation, now=None):
    """Time the next reads against this entry, from its send (a later one replaces an unfinished one)."""
    now = time.time() if now is None else now
    _LAG_PROBE.clear()
    _LAG_PROBE.update(contract=code, want_net=int(want_net), sent_at=float(sent_at),
                      simulation=bool(simulation), next_at=now + LAG_PROBE_S)


def _record_lag(lag_s, p, now):
    try:
        book = load_json(LAG_PATH, encoding="utf-8")
        samples = book.get("samples") if isinstance(book, dict) else None
    except (OSError, ValueError):
        samples = None
    samples = (samples if isinstance(samples, list) else [])[-(LAG_KEEP - 1):]
    samples.append({"at": now, "lag_s": lag_s, "from": "send", "contract": p["contract"],
                    "want_net": p["want_net"], "simulation": p["simulation"],
                    "window_s": sinopac_vault.ORDER_SETTLE_S, "probe_every_s": LAG_PROBE_S,
                    "probe_max_s": LAG_PROBE_MAX_S})
    try:
        _atomic_write(LAG_PATH, {"samples": samples})
    except OSError as e:
        _log(f"settle lag not written ({type(e).__name__})")
    _log(f"position lag after an entry: {p['contract']} "
         + (f"seen {lag_s:.1f}s after the send" if lag_s is not None
            else f"not seen within {LAG_PROBE_MAX_S:.0f}s of the send"))


def _probe_lag(api, acct):
    """One due read of the armed entry's position: records the lag from the send the first time it
    shows, or that it did not show inside LAG_PROBE_MAX_S. A failed read is skipped, never retried in
    a loop."""
    if not _LAG_PROBE:
        return
    now = time.time()
    if now < _LAG_PROBE["next_at"]:
        return
    p = dict(_LAG_PROBE)
    if now - p["sent_at"] > LAG_PROBE_MAX_S:
        _LAG_PROBE.clear()
        _record_lag(None, p, now)
        return
    _LAG_PROBE["next_at"] = now + LAG_PROBE_S
    try:
        # capped like update_status: these reads run between requests, a hang must not age the heartbeat
        rows = [position_row(api, x) for x in
                api.list_positions(acct, timeout=int(UPDATE_STATUS_TIMEOUT_S * 1000)) or []]
    except Exception as e:
        _log(f"lag read failed: {_sanitize(e)}")
        return
    if sum(int(r["net"]) for r in rows if r and r["productid"] == p["contract"]) == p["want_net"]:
        _LAG_PROBE.clear()
        _record_lag(round(now - p["sent_at"], 1), p, now)


def serve_requests(api, acct, simulation):
    """Take every pending request (oldest first). Returns how many were served."""
    try:
        names = sorted(n for n in os.listdir(ORDERS_DIR) if n.endswith(".req.json"))
    except OSError:
        return 0
    served = 0
    for n in names:
        rid = n[:-len(".req.json")]
        base = os.path.join(ORDERS_DIR, rid)
        try:
            os.rename(base + ".req.json", base + ".taken")  # the requester can no longer cancel it
        except OSError:
            continue
        try:
            req = load_json(base + ".taken", encoding="utf-8")
            resp = execute(api, acct, req, simulation)
        except Exception as e:
            resp = {"status": "rejected", "error": _sanitize(e)}
        try:
            _atomic_write(base + ".resp.json", resp)
        except OSError as e:
            # the order may be out: the requester's OrderNotConfirmed parks it, the worker stays up
            _log(f"answer to {rid} not written ({type(e).__name__}) — the requester reads it as unconfirmed")
        served += 1
    return served


# ── loop ─────────────────────────────────────────────────────────────────────

ORDER_FILES_MAX_AGE_S = 86400


def _sweep_orders():
    """What a requester that died before reading its answer left in ORDERS_DIR (answers, taken and
    cancelled requests, temp files): gone after a day. A live requester removes its own."""
    try:
        names = os.listdir(ORDERS_DIR)
    except OSError:
        return
    cutoff = time.time() - ORDER_FILES_MAX_AGE_S
    for n in names:
        path = os.path.join(ORDERS_DIR, n)
        try:
            if os.path.getmtime(path) < cutoff:
                os.remove(path)
        except OSError:
            pass


def _beat():
    # a full disk must not take the worker (and its session) down: a missed beat only reads as stale
    try:
        os.makedirs(os.path.dirname(HEARTBEAT_PATH), exist_ok=True)
        with open(HEARTBEAT_PATH, "w"):
            pass
    except OSError:
        pass


def _settled_read_at():
    """When an early re-read counts as showing every send so far: ORDER_SETTLE_S after the last."""
    try:
        return max(time.time(), sinopac_vault.settled_at())
    except sinopac_vault.MarkerUnreadable:
        return time.time() + sinopac_vault.ORDER_SETTLE_S


def _held_rows():
    """The last snapshot's rows as 'TXFK6 +2', or None — read before the stop replaces it."""
    try:
        rows = load_json(OUT_PATH, encoding="utf-8").get("positions")
        out = [f"{str(r['productid'])[:12]} {int(r['net']):+d}" for r in rows if int(r.get("net") or 0)]
        return out[:10] or None
    except (OSError, ValueError, AttributeError, KeyError, TypeError):
        return None


def _login_stopped(err, reason="UNKNOWN"):
    """The daemon's failed login: STOP record, then the user's P1 — once, since a daemon start with
    the record present exits before this. Only 永豐 stops: no HALT is tripped."""
    held = _held_rows()
    _atomic_write(STOP_PATH, {"at": time.time(), "error": err, "reason": reason})
    _clear_retry()
    # the P1 before the snapshot: with STOP written, a later start exits before this — a failed
    # snapshot write must not cost the user's only notice (audit N-C)
    events.emit("venue_login_blocked", venue="sinopac", reason=reason, positions=held)
    try:
        _write_snapshot({"ok": False, "error": err, "login_stopped": True})
    except OSError as e:
        _log(f"stopped snapshot not written ({type(e).__name__})")
    _log(f"login failed — stopped until the user confirms a login (--once): {err}")
    sys.exit(LOGIN_STOPPED_EXIT)


def _retry_state():
    """{failures, retry_at, error, since, announced_at} of the running streak of unanswered logins
    (since: its first failure; announced_at: its last exchange_unreachable)."""
    none = {"failures": 0, "retry_at": 0.0, "error": None, "since": None, "announced_at": None}
    try:
        s = load_json(RETRY_PATH, encoding="utf-8")
        st = {"failures": int(s.get("failures") or 0), "retry_at": float(s.get("retry_at") or 0),
              "error": s.get("error"), "since": float(s["since"]) if s.get("since") else None,
              "announced_at": float(s["announced_at"]) if s.get("announced_at") else None}
    except FileNotFoundError:
        return none
    except (OSError, ValueError, AttributeError, TypeError):
        # unreadable: spaced as the longest wait, never an immediate login (451)
        return dict(none, failures=1, retry_at=time.time() + LOGIN_RETRY_LONG_S, since=time.time())
    if st["retry_at"] < time.time() - 2 * LOGIN_RETRY_LONG_S:
        return none  # left by a worker stopped mid-wait long ago: a new streak
    return st


def _clear_retry():
    try:
        os.remove(RETRY_PATH)
    except OSError:
        pass


def _last_positions():
    try:
        rows = load_json(OUT_PATH, encoding="utf-8").get("positions")
        return rows if isinstance(rows, list) else []
    except (OSError, ValueError, AttributeError):
        return []


def _wait_retry(retry_at, failures, err, positions, st=None):
    """Logged out until retry_at, the snapshot restamped every POLL_S (lib/sinopac_futures_account
    reads it as `waiting`: the reconciler skips the round instead of counting a failed read). It
    carries the last read's rows, never read as positions (ok false), for a later stop's P1. No
    heartbeat meanwhile: lib/order_sinopac refuses an order before writing its request.
    `st` = the streak: a notice that falls due inside the wait goes out then, not at the next
    login — a 451's 10-minute spacing would otherwise push the 25-minute one to 30."""
    while time.time() < retry_at and not _STOP.is_set():
        if st is not None:
            _announce_if_due(st, time.time())
        at = time.strftime("%H:%M", time.gmtime(retry_at + 8 * 3600))
        text = (f"永豐登入失敗 {failures} 次（{err}），{at} 再試" if err
                else f"永豐上一次登入沒有結果（程序中斷），{at} 再試")
        try:
            _write_snapshot({"ok": False, "waiting": "login_retry", "retry_at": retry_at,
                             "positions": positions, "error": text})
        except OSError as e:
            _log(f"waiting snapshot not written ({type(e).__name__})")
        until = retry_at
        if st is not None:
            due = next_announce_at(st["since"], st["announced_at"])
            if due is not None and due > time.time():
                until = min(until, due)
        _STOP.wait(max(0.0, min(POLL_S, until - time.time())))


def next_announce_at(since, announced_at):
    """When announce_due next turns true for this streak (None: no streak)."""
    if since is None:
        return None
    if announced_at is None:
        return since + UNREACHABLE_AFTER_S
    if _p1_pending(since, announced_at):
        return since + UNREACHABLE_P1_AT_S
    return announced_at + UNREACHABLE_REPEAT_S


def _announce_if_due(st, now):
    """exchange_unreachable for this streak when due (never while HALT is set); the time it went
    out is kept in st and on disk, so a restart does not send it twice."""
    if not announce_due(st["since"], st["announced_at"], now) or guard.halted():
        return
    events.emit("exchange_unreachable", venue="sinopac", minutes=int((now - st["since"]) // 60), code="login")
    st["announced_at"] = now
    try:
        _atomic_write(RETRY_PATH, st)
    except OSError as e:
        _log(f"login retry state not written ({type(e).__name__})")


def retry_wait_s(failures, e=None):
    """The wait after the `failures`-th unanswered login in a row: LOGIN_RETRY_S, then
    LOGIN_RETRY_LONG_S for good; at least LOGIN_451_WAIT_S after a 451."""
    wait = LOGIN_RETRY_S[failures - 1] if failures <= len(LOGIN_RETRY_S) else LOGIN_RETRY_LONG_S
    return max(wait, LOGIN_451_WAIT_S) if e is not None and too_many_connections(e) else wait


def _p1_pending(since, announced_at):
    """No notice sent yet at or past the P1 mark of this streak."""
    return announced_at is None or announced_at - since < UNREACHABLE_P1_AT_S


def announce_due(since, announced_at, now):
    """exchange_unreachable is due: the streak is UNREACHABLE_AFTER_S old and none was sent, it
    reached UNREACHABLE_P1_AT_S with none sent there yet, or the last one is UNREACHABLE_REPEAT_S
    old — 25, 150, 270, 390 … minutes (群益: 30, 150, 270)."""
    if since is None or now - since < UNREACHABLE_AFTER_S:
        return False
    if announced_at is None:
        return True
    if now - since < UNREACHABLE_P1_AT_S:
        return False  # the second one waits for the mark: a 145-minute repeat would be P2 again
    if _p1_pending(since, announced_at):
        return True
    return now - announced_at >= UNREACHABLE_REPEAT_S


def p1_aligned_wait(wait, since, announced_at, now, floor=0.0):
    """`wait`, cut so the next login lands on the streak's P1 mark when it would otherwise step
    over it with no notice there yet (never below `floor`: a 451's wait stays)."""
    mark = since + UNREACHABLE_P1_AT_S
    if since is not None and now < mark < now + wait and _p1_pending(since, announced_at):
        return max(mark - now, floor)
    return wait


def _note_attempt(st):
    """The login about to run, written down as already failed (failures + 1, the wait that follows
    it, a 451 wait kept): a process that dies inside it — killed mid-login, the native layer
    hanging — or crashes soon after it restarts on the ladder. Raises OSError when it cannot be
    written: the caller does not log in."""
    now = time.time()
    failures = st["failures"] + 1
    wait = retry_wait_s(failures)
    if st["error"] and too_many_connections(st["error"]):
        wait = max(wait, LOGIN_451_WAIT_S)
    st = dict(st, failures=failures, since=st["since"] or now, retry_at=now + wait)
    _atomic_write(RETRY_PATH, st)
    return st


def _note_logout():
    """A session that ended on request (signal, the desktop's stop): the next start is not a crash
    — no climb — but still waits the first spacing."""
    try:
        _atomic_write(RETRY_PATH, {"failures": 0, "retry_at": time.time() + LOGIN_RETRY_S[0],
                                   "error": None, "since": None, "announced_at": None})
    except OSError as e:
        _log(f"logout record not written ({type(e).__name__})")


def _login_with_retry(c, bound_key=None):
    """login(c). An unanswered login (retryable) is tried again for good, spaced by retry_wait_s;
    the streak survives a restart (RETRY_PATH). Its notice is exchange_unreachable (announce_due:
    25, 150, then every 2 h; one retry is moved onto the 150-min P1 mark), never while HALT is set (as the
    reconciler's: that event says trading resumes by itself). Any other failure stops
    (_login_stopped). The record of the good login stays: _serve drops it after LOGIN_STABLE_S."""
    st = _retry_state()
    positions = _last_positions()
    # the reconciler reads a missing or stale snapshot as a failed read (three in a row HALT): a
    # start — a reboot, the network not up yet — says it is logging in before the first try
    try:
        _write_snapshot({"ok": False, "waiting": "login", "positions": positions, "error": "永豐登入中"})
    except OSError as e:
        _log(f"logging-in snapshot not written ({type(e).__name__})")
    while True:
        _wait_retry(st["retry_at"], st["failures"], st["error"], positions, st)
        if _STOP.is_set():
            sys.exit(0)  # nothing held: no session yet
        if bound_key is not None and _bound_key() not in (None, bound_key):
            _log("永豐 unbound or rebound while waiting to log in — not logging in")
            sys.exit(NOT_BOUND_EXIT)
        try:
            st = _note_attempt(st)
        except OSError as e:
            _log(f"login record not written ({type(e).__name__}) — not logging in")
            sys.exit(STATE_EXIT)
        try:
            out = login(c)
        except Exception as e:
            err = _sanitize(e)
            if not retryable(e):
                _login_stopped(err, _login_reason(e))
            now = time.time()
            if announce_due(st["since"], st["announced_at"], now) and not guard.halted():
                events.emit("exchange_unreachable", venue="sinopac", minutes=int((now - st["since"]) // 60),
                            code="login")
                st["announced_at"] = now
            wait = p1_aligned_wait(retry_wait_s(st["failures"], e), st["since"], st["announced_at"], now,
                                   LOGIN_451_WAIT_S if too_many_connections(e) else 0.0)
            st.update(retry_at=now + wait, error=err)
            try:
                _atomic_write(RETRY_PATH, st)
            except OSError as e2:
                _log(f"login retry state not written ({type(e2).__name__}) — the attempt's own record stands")
            _log(f"login failed ({err}) — try {st['failures'] + 1} in {wait:.0f}s")
            continue
        # the streak is over: a crash later in this session restarts on the ladder (failures,
        # retry_at kept) but must not date an unreachable notice from this streak's start
        try:
            _atomic_write(RETRY_PATH, dict(st, error=None, since=None, announced_at=None))
        except OSError as e:
            _log(f"login retry state not reset ({type(e).__name__})")
        return out


def _mark_enabled():
    """True once the marker is on disk. False = it could not be written: no login (audit F4)."""
    if os.path.exists(ENABLED_PATH):
        return True
    try:
        _atomic_write(ENABLED_PATH, {"at": time.time()})
        return True
    except OSError as e:
        _log(f"futures-enabled marker not written ({type(e).__name__}) — not logging in")
        return False


def run_once():
    """The user's confirmed login: one login + read → probe file; clears STOP on success."""
    if not VERIFIED:
        _atomic_write(PROBE_PATH, {"ok": False, "error": "unverified", "read_at": time.time()})
        _log("永豐 futures is not live-verified yet — no login")
        return UNVERIFIED_EXIT
    try:
        c = creds()
    except sinopac_vault.NotBound as e:  # nothing was logged in with: no marker, no STOP touched
        _atomic_write(PROBE_PATH, {"ok": False, "error": "not bound", "read_at": time.time()})
        _log(f"probe not run: {e}")
        return NOT_BOUND_EXIT
    except Exception as e:
        c = e  # bound, but the store fails: the probe file says so below
    if not _mark_enabled():
        try:
            _atomic_write(PROBE_PATH, {"ok": False, "error": "state not writable", "read_at": time.time()})
        except OSError:
            pass
        return STATE_EXIT
    with quiet_sdk():
        return _run_once(c)


def _run_once(c):
    api = None
    try:
        if isinstance(c, Exception):
            raise c
        api, acct = login(c)
        snap = read_account(api, acct)
        _atomic_write(PROBE_PATH, dict(snap, read_at=time.time(), simulation=not c["live"]))
        was_stopped = os.path.exists(STOP_PATH)
        try:
            os.remove(STOP_PATH)
        except OSError:
            pass
        if was_stopped:
            # canon notifications.md venue_login_recovered: the user's confirmed login lifted the stop
            events.emit("venue_login_recovered", venue="sinopac")
        _clear_retry()
        _log(f"probe ok equity={snap['equity']} positions="
             f"{[(r['productid'], r['net']) for r in snap['positions']]}")
        return 0
    except Exception as e:
        err = _sanitize(e)
        # reason: the venue_login_blocked class (NOT_SIGNED tells the connect page to wait for review)
        _atomic_write(PROBE_PATH, {"ok": False, "error": err, "reason": _login_reason(e),
                                   "read_at": time.time()})
        _log(f"probe failed: {err}")
        return 2
    finally:
        if api is not None:
            api.logout()


SIM_PATH = os.path.join(STATE, "sinopac_sim_test.json")
SIM_CONFIRM_S = 15.0


def run_sim_test():
    """`--sim-test` (runtime/sinopac_connect sinopac_sim_test): the test 永豐's signing review wants
    — one simulation-mode login and one futures order (TMF near month, 1 lot, market IOC: the
    shape the live path sends; UNMEASURED in simulation). Never production, never the bot's book,
    no last-order marker. → SIM_PATH {ok, broker_status | reason, read_at}; exit 0 when 永豐 took it."""
    if not VERIFIED:
        _atomic_write(SIM_PATH, {"ok": False, "error": "unverified", "read_at": time.time()})
        return UNVERIFIED_EXIT
    try:
        c = dict(creds(), live=False)
    except sinopac_vault.NotBound as e:
        _atomic_write(SIM_PATH, {"ok": False, "error": "not bound", "read_at": time.time()})
        _log(f"simulation test not run: {e}")
        return NOT_BOUND_EXIT
    # a simulation order still goes through the restart stop and the HALT freeze: while trading is
    # stopped on this machine nothing is sent, test orders included
    try:
        guard.check_restart_stop("entry", {"venue": "sinopac", "market": "futures", "symbol": "TMF",
                                           "action": "buy", "qty": 1, "unit": "lots", "simulation": True})
    except guard.Halted as e:
        _atomic_write(SIM_PATH, {"ok": False, "error": "trading stopped on this machine", "read_at": time.time()})
        _log(f"simulation test not run: {e}")
        return 2
    with quiet_sdk():
        api = None
        try:
            api, acct = login(c, require_signed=False)
            import shioaji as sj
            code, octype = pick_contract([], "TMF", "entry", "buy", 1, listed_contracts(api))
            trade = api.place_order(contract_for(api, code), sj.FuturesOrder(
                action=sj.Action.Buy, price=0, quantity=1, price_type=sj.FuturesPriceType.MKT,
                time_in_force=sj.TimeInForce.IOC, octype=getattr(sj.FuturesOCType, octype), account=acct))
            status, trade = _confirm(api, acct, trade, time.time() + SIM_CONFIRM_S)
            ok = status not in FAILED
            _atomic_write(SIM_PATH, {"ok": ok, "broker_status": status, "read_at": time.time()})
            _log(f"simulation test order {status}")
            return 0 if ok else 2
        except Exception as e:
            _atomic_write(SIM_PATH, {"ok": False, "error": _sanitize(e), "reason": _login_reason(e),
                                     "read_at": time.time()})
            _log(f"simulation test failed: {_sanitize(e)}")
            return 2
        finally:
            if api is not None:
                api.logout()


def main():
    os.chdir(WORKSPACE)  # lib/guard's HALT / audit paths are workspace-relative
    # started from inside an agent turn, its first order would take that turn's order lock and hold
    # it for the worker's life (lib/guard._turn_money_lock); the reconciler drops them the same way
    os.environ.pop("BLAVE_TURN_INTERRUPT_FILE", None)
    os.environ.pop("BLAVE_TURN_PID", None)
    guard.mark_money_process()
    if not VERIFIED:
        _log("永豐 futures is not live-verified yet — no login")
        return UNVERIFIED_EXIT
    try:
        # first: on the desktop this takes the daemon's credentials line off stdin, before the
        # stop-on-EOF watch drains the pipe
        c = creds()
    except sinopac_vault.NotBound as e:
        _log(f"not started: {e}")
        return NOT_BOUND_EXIT
    except Exception as e:
        c = e  # bound, but the store fails: _serve stops on it, past the marker
    if not os.path.exists(WANTED_PATH):
        # the connect flow has not finished (a rebind deletes it): whoever started this daemon — the
        # Linux shim, the desktop supervisor, or NSSM at a Windows boot — no login before the flow's own
        _log("not started: the 永豐 connect flow has not finished on this machine")
        return NOT_BOUND_EXIT
    if not _mark_enabled():
        return STATE_EXIT
    if os.path.exists(STOP_PATH):
        _log("a previous login failed — not logging in until the user confirms one (--once)")
        return LOGIN_STOPPED_EXIT
    _watch_stdin()
    with quiet_sdk():
        return _serve(c)


def _watch_stdin():
    """STOP_ON_EOF: the parent closing our stdin (or dying) asks for a stop."""
    if os.environ.get(STOP_ON_EOF) != "1":
        return

    def watch():
        try:
            while os.read(0, 4096):
                pass
        except OSError:
            pass
        _STOP.set()
    threading.Thread(target=watch, daemon=True, name="stdin-eof").start()


def _serve(c=None):
    _sweep_orders()
    try:
        if c is None:
            c = creds()
        if isinstance(c, Exception):
            raise c
    except sinopac_vault.NotBound as e:
        _log(f"not started: {e}")
        sys.exit(NOT_BOUND_EXIT)
    except Exception as e:
        _login_stopped(_sanitize(e), _login_reason(e))
    bound_key = sinopac_vault.bound_env(c["sinopac_api_key"], c["sinopac_secret_key"])["sinopac_api_key"]
    api, acct = _login_with_retry(c, bound_key)
    login_at = time.time()
    on_request = False
    _beat()
    simulation = not c["live"]
    try:
        while True:
            if _STOP.is_set():
                on_request = True
                return 0
            now_key = _bound_key()
            if now_key is not None and now_key != bound_key:
                # unbound or bound to another key: the cloud's unbind cannot stop this service, so
                # it leaves by itself (its shim / NSSM start the next one only if still wanted)
                _log("永豐 unbound or rebound — logging out")
                return NOT_BOUND_EXIT  # no logout record: drop() just removed the retry file
            if login_at is not None and time.time() - login_at >= LOGIN_STABLE_S:
                _clear_retry()
                login_at = None
            _beat()
            try:
                _write_snapshot(read_account(api, acct))
            except Exception as e:
                # keep the session: a re-login per failed read is how a machine walks into 451
                _log(f"read failed: {_sanitize(e)}")
                try:
                    _write_snapshot({"ok": False, "error": _sanitize(e)})
                except OSError as e2:
                    _log(f"failed-read snapshot not written ({type(e2).__name__})")
            next_read = time.time() + POLL_S
            while time.time() < next_read and not _STOP.is_set():
                time.sleep(REQUEST_CHECK_S)
                _beat()
                if serve_requests(api, acct, simulation):
                    next_read = _settled_read_at()  # the next caller sees the fill, not M0-b's []
                try:
                    _probe_lag(api, acct)
                except Exception as e:  # measurement only: never the session's end
                    _LAG_PROBE.clear()
                    _log(f"lag probe dropped: {_sanitize(e)}")
                if os.path.exists(REFRESH_FLAG):
                    try:
                        os.remove(REFRESH_FLAG)
                    except OSError:
                        pass
                    next_read = min(next_read, _settled_read_at())
    except (SystemExit, KeyboardInterrupt):
        on_request = True
        raise
    finally:
        try:
            api.logout()
        except Exception:
            pass
        if on_request:
            _note_logout()


# ── Windows cloud service (NSSM): lib/president_worker's recipe ─────────────────────────────────
# Linux runs it from blave-agent-sinopac.service; a Windows cloud box (opened for 群益 / 統一) from
# this NSSM service, installed by the connect flow's finish step and removed on unbind.
SERVICE = "blave-agent-sinopac"
DEPLOYMENTS_PATH = os.path.join(STATE, "deployments.json")
INSTALL_WAIT_S = 120
NSSM_RESTART_DELAY_MS = 60000  # = blave-agent-sinopac.service RestartSec; the login record spaces logins


def _nssm(*args, timeout=60):
    import subprocess
    r = subprocess.run(["nssm", *args], capture_output=True, timeout=timeout)
    return r.returncode


def _deployments(update):
    try:
        deps = load_json(DEPLOYMENTS_PATH, encoding="utf-8")
    except FileNotFoundError:
        deps = {}
    except ValueError:
        deps = None
    except OSError as e:  # still locked: skip rather than write the others away
        _log(f"deployments.json not updated ({type(e).__name__})")
        return
    if not isinstance(deps, dict):
        _log("deployments.json does not parse — set aside as .corrupt")
        atomic_replace(DEPLOYMENTS_PATH, DEPLOYMENTS_PATH + ".corrupt")
        deps = {}
    update(deps)
    _atomic_write(DEPLOYMENTS_PATH, deps)


def install():
    """Install (or re-point) and start the service, LocalSystem (the vault is SYSTEM +
    Administrators); wait for its first snapshot. Exit 0 when it reads ok, 2 otherwise."""
    import shutil
    if os.name != "nt":
        _log("install: Windows only (Linux runs blave-agent-sinopac.service)")
        return 2
    if os.environ.get("BLAVE_AGENT_LOCAL") == "1":
        # on the user's own PC a LocalSystem service running agent-writable files would hand it SYSTEM
        _log("install: not on the desktop app — cloud machines only")
        return 2
    if not shutil.which("nssm"):
        _log("install: nssm not found on PATH")
        return 2
    started = time.time() - 2
    if _nssm("status", SERVICE) == 0:
        _nssm("stop", SERVICE, timeout=90)
    elif _nssm("install", SERVICE, sys.executable, os.path.abspath(__file__)) != 0:
        _log("install: nssm install failed")
        return 2
    log = os.path.join(STATE, "sinopac_worker.log")
    os.makedirs(STATE, exist_ok=True)
    steps = [("set", SERVICE, "Application", sys.executable),
             ("set", SERVICE, "AppParameters", os.path.abspath(__file__)),
             ("set", SERVICE, "AppDirectory", WORKSPACE),
             ("set", SERVICE, "AppStdout", log),
             ("set", SERVICE, "AppStderr", log),
             ("set", SERVICE, "AppEnvironmentExtra", "SJ_LOG_PATH=" + os.devnull),
             ("set", SERVICE, "Start", "SERVICE_AUTO_START"),
             ("set", SERVICE, "AppRestartDelay", str(NSSM_RESTART_DELAY_MS))]
    # stopped on purpose: a failed login (STOP), the gate shut, not bound — never restarted into a login
    steps += [("set", SERVICE, "AppExit", str(code), "Exit")
              for code in (LOGIN_STOPPED_EXIT, UNVERIFIED_EXIT, NOT_BOUND_EXIT)]
    steps.append(("start", SERVICE))
    for step in steps:
        if _nssm(*step, timeout=90) != 0:
            _log(f"install: nssm {step[0]} {step[2] if step[0] == 'set' else ''} failed")
            return 2
    _deployments(lambda d: d.setdefault("sinopac_worker", {
        "type": "daemon", "expect_every_minutes": 5,
        "registered_at": time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime())}))
    deadline = time.time() + INSTALL_WAIT_S
    while time.time() < deadline:
        time.sleep(3)
        try:
            snap = load_json(OUT_PATH, encoding="utf-8")
        except (OSError, ValueError):
            continue
        if (snap.get("read_at") or 0) >= started:
            _log(f"install: service running, first snapshot ok={snap.get('ok')}")
            return 0 if snap.get("ok") else 2
    _log("install: service started but wrote no snapshot in time")
    return 2


def uninstall():
    if os.name != "nt":
        return 2
    _nssm("stop", SERVICE, timeout=90)
    rc = _nssm("remove", SERVICE, "confirm")
    _deployments(lambda d: d.pop("sinopac_worker", None))
    _log(f"uninstall: nssm remove rc={rc}")
    return 0 if rc == 0 else 2


def _hard_exit(code):
    """Past every finally (logged out): a lingering native session thread must not keep the
    process alive (Windows M0-a), so flush and leave without waiting for threads."""
    try:
        sys.stdout.flush()
        sys.stderr.flush()
    except (OSError, ValueError):
        pass
    os._exit(code if isinstance(code, int) else 1)


if __name__ == "__main__":
    if "--install" in sys.argv[1:]:
        sys.exit(install())
    if "--uninstall" in sys.argv[1:]:
        sys.exit(uninstall())
    _utf8_console()
    _exit_on_signals()
    rc = 1
    try:
        rc = (run_once() if "--once" in sys.argv[1:] else run_sim_test() if "--sim-test" in sys.argv[1:]
              else main())
    except KeyboardInterrupt:
        rc = 0
    except SystemExit as e:
        rc = e.code if isinstance(e.code, int) else (0 if e.code is None else 1)
    except Exception as e:
        _log(f"worker crashed: {_sanitize(e)}")
    _hard_exit(rc)
