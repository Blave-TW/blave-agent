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

Login failures leave this module as a CLASS only (CERT_MISMATCH, CERT,
PASSWORD, HOST, TIMEOUT, TRANSIENT, MAINTENANCE, BLOCKED, UNKNOWN), never the broker's
text: when the certificate does not match the account, the SDK's message is
f"{national id} {certificate json}". Every broker string that is passed on
goes through sanitize() first.

統一 locks an account after three wrong logins. A CERT*/PASSWORD answer blocks
every further login on this machine with the same credentials
(<base>/credentials/president_login_block.json, keyed on their fingerprint — no secret is
written) until `.env` changes or the user releases it (`python
lib/president_worker.py --unblock`, only after they unlocked the account at the
broker) — a release allows one login, and its failure blocks again; one
unclassifiable rejection blocks too — whether the broker answered it or the SDK
raised on it — because an unknown text may be a wrong password. A TIMEOUT
counts too, and TIMEOUT_BLOCK_AT of them in a row block (see there). A
TRANSIENT answer (a known non-credential refusal: the per-minute cap, the
broker's back end down, maintenance) never counts — the worker backs off. No
login is attempted in the broker's 05:30–05:50 login maintenance.

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
from urllib.parse import urlparse

_WS = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ENV_PATH = os.path.join(_WS, ".env")
VAULT = os.path.join(os.path.dirname(_WS), "credentials", "president_vault.json")
# Next to the vault, not in state/: the agent's guards cover credentials/, and a block the
# agent could delete would let a worker that restarts on its own spend the broker's three
# tries (audit 2026-10-07 S2). The old spot is moved over on first read.
BLOCK = os.path.join(os.path.dirname(VAULT), "president_login_block.json")
LEGACY_BLOCK = os.path.join(_WS, "state", "president_login_block.json")
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
AUTH_CLASSES = ("CERT_MISMATCH", "CERT", "PASSWORD")
# The broker's real wrong-password text has not been seen (it is only guessed
# from the SDK's own strings): an unclassifiable refusal may be a wrong password,
# and the user's own typo in the app plus two of ours locks the account — so one
# unclassifiable refusal blocks.
UNKNOWN_BLOCK_AT = 1
# A login that timed out may have had its password checked before the broker went
# quiet, so it counts — but not at 1: a bare "Max retries exceeded" /
# ConnectionError also lands in TIMEOUT, and the worker re-logs in after every
# backoff, so a short network outage is a run of TIMEOUTs on a password that is
# right (the broker counts only wrong ones), and one release per block would be
# spent on the network. A wrong password normally gets a fast refusal (PASSWORD /
# UNKNOWN → blocked at once); two timeouts in a row with no good login between
# them is where "the broker may be counting these" outweighs "the network is
# flaky". Worst case left: two silent wrong-password checks + the user's own
# typo in the app = the broker's three.
TIMEOUT_BLOCK_AT = 2
# Refusals the SDK names that are not about the credentials (lib core/error and
# core/httpclient 1.0.0.7: MSG012 per-minute cap, the back end's DB / host link).
# Matched only after every credential class, so a text that also names the
# password stays PASSWORD.
TRANSIENT_TEXTS = ("超過每分鐘限制", "DB連線錯誤", "後臺連線失敗",
                   # 待補:統一 maintenance text seen outside 05:30–05:50 has not been captured;
                   # "維護" is the guess until a real one is
                   "維護")
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
        "HOST": "the login host could not be reached",
        "TIMEOUT": "the login did not answer in time",
        "TRANSIENT": "the broker turned the login away for a reason that is not the credentials — retried later",
        "MAINTENANCE": "broker login maintenance (05:30–05:50 Taipei) — not attempted",
        "BLOCKED": "a previous login with these credentials was refused — not attempted until "
                   "the credentials in .env change (統一 locks the account after three wrong logins)",
        "NON_TEST_SERVER": "the server is not a test server and production is not switched on",
        "LIVE_NOT_OPEN": "the first production login after the test host was refused without a reason — "
                         "production API access is probably not open yet; not blocked this once",
        "UNKNOWN": "the broker refused the login",
    }

    def __init__(self, kind):
        self.kind = kind
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
    # HOST only when the request never reached the broker; a connection that
    # broke after the request went out (aborted / reset / read timeout) may
    # already have had its password checked — that is TIMEOUT, never given back
    if any(t in s for t in ("Connection aborted", "RemoteDisconnected", "Connection reset",
                            "ConnectionResetError", "ReadTimeout", "Read timed out")):
        return "TIMEOUT"
    if any(t in s for t in ("NameResolution", "getaddrinfo", "Failed to establish", "ConnectTimeout",
                            "Connection refused", "SSLError", "CERTIFICATE_VERIFY_FAILED")):
        return "HOST"
    if (s.strip() == "Timeout" or "timed out" in s.lower() or "Max retries" in s
            or "ConnectionError" in s):
        return "TIMEOUT"
    if any(t in s for t in ("密碼", "查無此使用者", "使用者密碼未設定")):
        return "PASSWORD"
    if any(t in s for t in TRANSIENT_TEXTS):
        return "TRANSIENT"
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


# ── login block (shared by every caller on this machine) ─────────────────────

def _pfx_readable(ca_path):
    try:
        with open(ca_path, "rb"):
            return True
    except (OSError, TypeError):
        return False


def _cert_identity(ca_path):
    """The certificate as the fingerprint sees it: a hash of the .pfx file's
    bytes, so `C:\\x.pfx`, `c:\\x.pfx`, a relative path or an 8.3 short name
    are one certificate (rewriting .env with an equivalent spelling must not
    look like new credentials and buy a fresh wrong-password try), while a
    renewed certificate (new bytes) is a real change. Unreadable file → its
    normalized absolute path (the SDK will fail on it anyway)."""
    try:
        with open(ca_path, "rb") as f:
            return "sha256:" + hashlib.sha256(f.read()).hexdigest()
    except OSError:
        return "path:" + os.path.normcase(os.path.abspath(ca_path or ""))


def fingerprint(creds):
    raw = "\0".join([creds.get("account") or "", creds.get("password") or "",
                      _cert_identity(creds.get("ca_path")), creds.get("ca_password") or ""])
    return hashlib.sha256(f"president-login-v2\0{raw}".encode()).hexdigest()[:16]


def _migrate_block():
    """A block written before it moved: carried over once (a move, so an agent
    cannot keep a stale copy around to resurrect), its claim with it."""
    if os.path.exists(BLOCK) or not os.path.exists(LEGACY_BLOCK):
        return
    try:
        os.makedirs(os.path.dirname(BLOCK), exist_ok=True)
        with open(LEGACY_BLOCK, encoding="utf-8") as f:
            b = json.load(f)
        if isinstance(b, dict):
            replace_json(BLOCK, b)
        os.remove(LEGACY_BLOCK)
        if os.path.exists(LEGACY_BLOCK + ".claim"):
            os.close(os.open(BLOCK + ".claim", os.O_CREAT | os.O_WRONLY))
            os.remove(LEGACY_BLOCK + ".claim")
    except (OSError, ValueError):
        pass


def _read_block():
    _migrate_block()
    try:
        with open(BLOCK, encoding="utf-8") as f:
            b = json.load(f)
        return b if isinstance(b, dict) else {}
    except (OSError, ValueError):
        return {}


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
        os.replace(tmp, path)
    except BaseException:
        try:
            os.remove(tmp)
        except OSError:
            pass
        raise


def _write_block(block):
    try:
        replace_json(BLOCK, block)
    except OSError:
        pass


def _blocking(b):
    return (b.get("kind") in AUTH_CLASSES or int(b.get("unknown") or 0) >= UNKNOWN_BLOCK_AT
            or int(b.get("timeout") or 0) >= TIMEOUT_BLOCK_AT)


def _gate(creds):
    """(blocking class or None, whether this call took the released try).
    A block the user released (unblock()) lets exactly ONE login through: the
    first caller to create the claim file takes it and the block goes back to
    closed before the login is even tried, so a failure re-blocks at once and
    two racing processes cannot both spend a try."""
    b = _read_block()
    if b.get("fp") != fingerprint(creds):
        return None, False
    if not _blocking(b):
        return None, False
    if b.get("allow_once"):
        try:
            os.close(os.open(BLOCK + ".claim", os.O_CREAT | os.O_EXCL | os.O_WRONLY))
        except OSError:
            return b.get("kind") or "UNKNOWN", False  # another process took the one try
        _write_block(dict(b, allow_once=False))
        return None, True
    return b.get("kind") or "UNKNOWN", False


def blocked(creds):
    """The class that blocks a login with exactly these credentials, or None
    (taking the released try when there is one — see _gate)."""
    return _gate(creds)[0]


# The first production login after the test host passed (president_worker --once
# --first-live): an unclassified refusal there is most likely "the broker has not
# opened production API access yet", not a wrong password (the same password just
# logged in on the test host). That one is recorded but not blocked — once per
# credentials; any later UNKNOWN blocks as before (Wei 2026-10-07, audit B6).
FIRST_LIVE_GRACE = False


def _take_live_grace(creds):
    fp = fingerprint(creds)
    b = _read_block()
    if b.get("fp") != fp:
        b = {"fp": fp, "unknown": 0, "timeout": 0}
    if b.get("live_grace_used") or _blocking(b):
        return False
    _write_block(dict(b, live_grace_used=True, at=int(time.time()), last="LIVE_NOT_OPEN"))
    return True


def _refused(creds, kind):
    """Record a refused login; the class the caller raises."""
    if kind == "UNKNOWN" and FIRST_LIVE_GRACE and creds.get("live") and _take_live_grace(creds):
        return "LIVE_NOT_OPEN"
    _record(creds, kind)
    return kind


def login_paused():
    """The class blocking logins with the credentials in use, or None. Read-only
    (never takes the released try). A released block still counts: the venue's
    strategies stay paused until a login has actually passed (_clear), which
    is what lifts the pause in manager/reconciler. Credentials that cannot be
    resolved → None (that failure is reported where the login happens)."""
    try:
        creds = resolve()
    except Exception:
        return None
    b = _read_block()
    if b.get("fp") != fingerprint(creds) or not _blocking(b):
        return None
    return str(b.get("kind") or "UNKNOWN")


def _give_back_try():
    """The released try never reached the broker (HOST: no connection), so it
    did not count there and is not spent here. A TIMEOUT is not given back —
    the broker may have checked the password before going quiet."""
    b = _read_block()
    if b.get("fp"):
        try:
            os.remove(BLOCK + ".claim")
        except OSError:
            pass
        _write_block(dict(b, allow_once=True))


def unblock():
    """The user says the account is unlocked at the broker (and the password is
    right): allow ONE login with the blocked credentials. Once per block — a
    second release needs changed credentials in .env (which is a new block if
    they fail too). Returns "released", "none" (nothing blocked) or "used"."""
    b = _read_block()
    if not b.get("fp") or not _blocking(b):
        return "none"  # a single TIMEOUT on record blocks nothing: no release to spend on it
    if b.get("unblock_used"):
        return "used"
    try:
        os.remove(BLOCK + ".claim")
    except OSError:
        pass
    _write_block(dict(b, allow_once=True, unblock_used=True, released_at=int(time.time())))
    return "released"


def _record(creds, kind):
    fp = fingerprint(creds)
    b = _read_block()
    if b.get("fp") != fp:
        b = {"fp": fp, "unknown": 0, "timeout": 0}
    if kind in AUTH_CLASSES:
        b.update(kind=kind, at=int(time.time()))
        _write_block(b)
    elif kind in ("UNKNOWN", "TIMEOUT"):
        field = kind.lower()
        b.update(at=int(time.time()), **{field: int(b.get(field) or 0) + 1})
        if b.get("kind") not in AUTH_CLASSES:
            b["kind"] = kind
        _write_block(b)


def _clear():
    # a good login: whatever was blocked was other credentials (or these, now fixed)
    for path in (BLOCK, BLOCK + ".claim"):
        try:
            os.remove(path)
        except OSError:
            pass


def in_login_maintenance(now=None):
    t = (now or datetime.now(TAIPEI)).astimezone(TAIPEI).time()
    return LOGIN_MAINTENANCE[0] <= t < LOGIN_MAINTENANCE[1]


# ── the one login path (worker and order lib) ────────────────────────────────
LOGIN_TIMEOUT_S = 30


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


def login(creds, log_dir):
    """A logged-in Unitrade, or LoginError. The caller MUST logout() in a
    finally: the SDK starts non-daemon threads (logger, sockets) at login and a
    process that exits without logout() hangs on them forever — failed logins
    included (measured on the test host 2026-09-30). The returned object is
    logged out here on every failure path."""
    import threading

    if in_login_maintenance():
        raise LoginError("MAINTENANCE")
    kind, released_try = _gate(creds)
    if kind:
        raise LoginError("BLOCKED")
    if not _pfx_readable(creds.get("ca_path")):
        # the SDK sends the password before it opens the certificate: an unreadable
        # .pfx would spend a broker login try for nothing
        _record(creds, "CERT")
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
        if t.is_alive():
            _record(creds, "TIMEOUT")
            raise LoginError("TIMEOUT")
        if "exc" in box:
            kind = classify(f"{type(box['exc']).__name__} {box['exc']}")
            # an SDK that raised on an answer it could not parse may still have
            # been refused a wrong password: same rule as a refusal it returned
            kind = _refused(creds, kind)
            if released_try and kind == "HOST":
                _give_back_try()
            raise LoginError(kind)
        resp = box["resp"]
        if not resp.ok:
            kind = _refused(creds, classify(resp.error))
            if released_try and kind == "HOST":
                _give_back_try()
            raise LoginError(kind)
        if not creds["live"] and api.test_mode is not True:
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
