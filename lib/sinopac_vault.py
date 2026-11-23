"""永豐 futures: when this machine last sent an order, and how long the worker's position read lags it.

manager/flatten reads ORDER_SETTLE_S and last_order_at here (lib.venue_traits snapshot_settle_wait);
lib/sinopac_worker writes the marker right before every place_order and holds its own reads to it;
lib/sinopac_futures_account refuses a position read that started too soon after it.
The worker's login credentials are resolved here too (the section at the end).
Stdlib only (winreplace aside), imported as lib.sinopac_vault.
"""
import hashlib
import json
import logging
import os
import time

try:
    if __package__ == "lib":  # never a same-named file elsewhere on sys.path
        from lib.winreplace import atomic_replace, read_retry
    else:  # loaded with lib/ itself on sys.path
        from winreplace import atomic_replace, read_retry
except ImportError:  # half-updated workspace (lib/winreplace.py not landed): one plain read
    atomic_replace = os.replace

    def read_retry(read, *args, **kwargs):
        return read(*args, **kwargs)


# The one settle window every 永豐 reader and the worker use — never restate the number elsewhere.
# M0-b (2026-11-16, real account, 1.7.11) saw list_positions still return [] right after a Filled
# TMF market IOC. The 2026-11-23 live run (one TMF buy, one close, MKT IOC, each sent once) saw the
# position, then the flat book, in the snapshot within ~20 s of each fill — that snapshot is held
# until this window after the send, so it bounds the lag, it does not time it. 20 s stays (Wei
# 11-23; the runbook's "20 → 30" is void). After an entry the worker reads the position every
# LAG_PROBE_S from the send up to LAG_PROBE_MAX_S and records when it shows
# (state/sinopac_settle_lag.json; closes are not timed); set ORDER_SETTLE_MEASURED_S from the
# non-simulation samples and keep this at least twice it. Too short and a lagging [] read past the window is taken as flat and the position is
# opened again. tests/check_sinopac_futures.py refuses a flipped gate until the lag is measured (M3).
ORDER_SETTLE_S = 20
ORDER_SETTLE_MEASURED_S = None
LAST_ORDER_PATH = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                               "state", "sinopac_last_order_at")
# the worker's failed-login record (lib/sinopac_worker STOP_PATH): only the user's --once clears it
LOGIN_STOPPED_PATH = os.path.join(os.path.dirname(LAST_ORDER_PATH), "sinopac_login_stopped.json")
# = lib/capital_vault.MARKER_UNREADABLE_MAX_S
MARKER_UNREADABLE_MAX_S = ORDER_SETTLE_S * 15
_last_order_mem = 0.0
_marker_unreadable_since = None


class MarkerUnreadable(RuntimeError):
    pass


def _read_text(path):
    with open(path, encoding="utf-8") as f:
        return f.read()


def mark_order_sent():
    """Raises OSError when the marker cannot be written: the worker then does not send (a send
    the other processes cannot see is one they may read as flat)."""
    global _last_order_mem
    _last_order_mem = time.time()
    os.makedirs(os.path.dirname(LAST_ORDER_PATH), exist_ok=True)
    tmp = f"{LAST_ORDER_PATH}.{os.getpid()}.tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        f.write(repr(_last_order_mem))
    atomic_replace(tmp, LAST_ORDER_PATH)


def last_order_at():
    """Unix time of the last 永豐 futures send on this machine, 0.0 if none. A marker that is there
    but unreadable counts as a send just now (nothing reads as settled); past
    MARKER_UNREADABLE_MAX_S it raises MarkerUnreadable."""
    global _marker_unreadable_since
    try:
        disk = float(read_retry(_read_text, LAST_ORDER_PATH).strip() or 0)
    except FileNotFoundError:
        disk = 0.0
    except ValueError:  # not a number: when it was written still bounds the send, and expires
        try:
            disk = os.path.getmtime(LAST_ORDER_PATH)
        except OSError:
            disk = time.time()
    except OSError as e:
        now = time.time()
        if _marker_unreadable_since is None:
            _marker_unreadable_since = now
        if now - _marker_unreadable_since > MARKER_UNREADABLE_MAX_S:
            raise MarkerUnreadable(
                f"永豐下單紀錄 {LAST_ORDER_PATH} 已 {int(now - _marker_unreadable_since)} 秒讀不到"
                f"({type(e).__name__}),永豐部位無法確認是否已更新 / the 永豐 last-order marker has "
                f"been unreadable for {int(now - _marker_unreadable_since)} s") from e
        logging.warning(f"sinopac: last-order marker unreadable ({type(e).__name__}) — read as a send now")
        return max(now, _last_order_mem)
    _marker_unreadable_since = None
    return max(disk, _last_order_mem)


def login_stopped():
    """A failed worker login has stopped 永豐: nothing logs in or trades there until the user confirms."""
    return os.path.exists(LOGIN_STOPPED_PATH)


def settled_at():
    """The earliest a position read may START and still be trusted to show every send so far."""
    last = last_order_at()
    return last + ORDER_SETTLE_S if last else 0.0


# ── credentials (the 統一 / 群益 store: lib/president_vault, runtime/sinopac_service) ──────────
# The API key, secret, CA password and national id never sit in .env: .env holds `vault:` sentinels
# under the six locked names (so bound / unbind / eviction see a 永豐 binding) and the certificate
# path, and the values live in
#   cloud    <base>/credentials/sinopac_vault.json (+ sinopac.pfx beside it), written only by the
#            platform's connect step. Windows: SYSTEM + Administrators. Linux: 0600 to the machine's
#            one user, which the agent shares — out of .env and the agent's ordinary paths, not a
#            wall (lib/president_vault says the same of its own file);
#   desktop  the app's encrypted store; the daemon hands them to the worker alone as ONE stdin line
#            (BLAVE_SINOPAC_STDIN=1) — never a file, never the environment.
# Production ("live") is the vault's / the line's, never .env's: a sinopac_live line there (a 零股
# bind left SINOPAC_LIVE=true on old machines, and the bind never removes it) is not read at all.
_BASE = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
VAULT = os.path.join(_BASE, "credentials", "sinopac_vault.json")
PFX = os.path.join(os.path.dirname(VAULT), "sinopac.pfx")
PW_PREFIX = "vault:"
SECRETS = ("sinopac_api_key", "sinopac_secret_key", "sinopac_ca_passwd", "sinopac_person_id")
STDIN_FLAG = "BLAVE_SINOPAC_STDIN"
LOCAL_FLAG = "BLAVE_SINOPAC_LOCAL"
_LOCAL = None


class NotBound(ValueError):
    """永豐 is not bound through the connect flow here: nothing to log in with, and no login stop."""


class NotHandedOver(NotBound):
    """Desktop: the app has not given the daemon the credentials yet — wait, never a login stop."""


def fingerprint(api_key, secret_key):
    """.env's sinopac_api_key sentinel: the account identity (command_listener._account_identity)
    hashes values, so a constant would make every rebind look alike. = runtime/sinopac_service."""
    return hashlib.sha256(f"sinopac-vault-v1\0{api_key}\0{secret_key}".encode()).hexdigest()[:16]


def bound_env(api_key, secret_key):
    """The .env lines a connect-flow bind writes (runtime/sinopac_service.bound_env)."""
    return {"sinopac_api_key": PW_PREFIX + fingerprint(api_key, secret_key),
            "sinopac_secret_key": PW_PREFIX + "secret", "sinopac_ca_passwd": PW_PREFIX + "ca",
            "sinopac_person_id": PW_PREFIX + "id", "sinopac_ca_path": PFX}


def _local_mode():
    return (_LOCAL is not None or os.environ.get(LOCAL_FLAG) == "1"
            or os.environ.get("BLAVE_AGENT_LOCAL") == "1")


def read_stdin_line(fd=0, limit=8192):
    """One line off the raw fd, byte by byte: the rest of the pipe stays for the worker's
    stop-on-EOF watch (= lib/president_vault.read_stdin_line)."""
    out = bytearray()
    while len(out) < limit:
        b = os.read(fd, 1)
        if not b or b == b"\n":
            break
        out += b
    return out.decode("utf-8", "replace").strip()


def take_local_line():
    """Desktop: the daemon's line, read once, before anything else reads stdin."""
    global _LOCAL
    if _LOCAL is None and os.environ.get(STDIN_FLAG) == "1":
        os.environ.pop(STDIN_FLAG, None)  # read once; a child of ours must not wait on it
        try:
            d = json.loads(read_stdin_line() or "{}")
        except (OSError, ValueError):
            d = {}
        _LOCAL = {k: d[k] for k in SECRETS + ("live",) if k in d} if isinstance(d, dict) else {}
    return _LOCAL or {}


def resolve(env):
    """{sinopac_api_key, sinopac_secret_key, sinopac_ca_path, sinopac_ca_passwd, sinopac_person_id,
    live} for a connect-flow binding. NotBound: no sentinels in .env (never bound, or bound with plain
    values before the store) / NotHandedOver: desktop, nothing handed over yet. ValueError: bound,
    but a vault missing or from another binding — the user connects again. A sinopac_live line is
    ignored: refusing it would dead-end every old 零股 machine's futures connect (audit r2 S1)."""
    env = {k.casefold(): v for k, v in env.items()}
    # sentinels first: a 零股 machine's plain .env (SINOPAC_LIVE=true included) is not bound, never a stop
    if not all(str(env.get(k) or "").startswith(PW_PREFIX) for k in SECRETS):
        raise NotBound("永豐 is not bound through the connect flow (.env holds no vault sentinels)")
    if _local_mode():
        v = take_local_line()
        if not all(isinstance(v.get(k), str) and v.get(k) for k in SECRETS):
            raise NotHandedOver("the Blave app has not handed over the 永豐 credentials")
    else:
        try:
            v = json.loads(read_retry(_read_text, VAULT))
        except PermissionError:
            raise RuntimeError("永豐 credentials vault not readable by this identity")
        except (OSError, ValueError) as e:
            raise ValueError(f"永豐 credentials vault unreadable ({type(e).__name__}) — connect 永豐 again")
        if not isinstance(v, dict) or not all(isinstance(v.get(k), str) and v.get(k) for k in SECRETS):
            raise ValueError("永豐 credentials vault incomplete — connect 永豐 again")
    if env["sinopac_api_key"] != PW_PREFIX + fingerprint(v["sinopac_api_key"], v["sinopac_secret_key"]):
        raise ValueError("永豐 credentials do not match this machine's binding — connect 永豐 again")
    c = {k: v[k] for k in SECRETS}
    c["sinopac_ca_path"] = PFX
    c["live"] = v.get("live") is True
    return c
