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

A login that never reached an answer (timeout, connection, 503 maintenance, 451 too many
connections) is tried again for good — spaced (LOGIN_RETRY_S, then LOGIN_RETRY_LONG_S), persisted
across restarts, 451 waits LOGIN_451_WAIT_S — with a `waiting` snapshot the reconciler skips the
round on, and exchange_unreachable as its P1 (Wei 11-17, as 群益). Any other failed login —
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

Run: python lib/sinopac_worker.py          (daemon)
     python lib/sinopac_worker.py --once   (one login + read → state/sinopac_probe.json)
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
import hashlib
import json
import re
import signal
import socket
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

POLL_S = 60
# waits after the 1st..5th unanswered login in a row, then LOGIN_RETRY_LONG_S for good (Wei 11-17:
# retry like 群益, never a STOP). Each failed login logs out, so no connection is held meanwhile.
# The P1 is exchange_unreachable UNREACHABLE_AFTER_S into the streak (the 6th failure, 25 min), then every
# UNREACHABLE_REPEAT_S; the reconciler skips those rounds (`waiting` snapshot), so it sends none.
LOGIN_RETRY_S = (60, 120, 240, 480, 600)
LOGIN_RETRY_LONG_S = 1800
UNREACHABLE_AFTER_S = 1500
UNREACHABLE_REPEAT_S = 7200
LOGIN_451_WAIT_S = 600  # resume plan §4: after a 451, wait 10 minutes
REQUEST_CHECK_S = 0.5
CONFIRM_POLL_S = 1.0
CONTRACTS_WAIT_S = 60.0
CONTRACTS_POLL_S = 1.0
SEND_MARGIN_S = 5.0  # a request waits out the settle window only when this much is left to confirm
LOGIN_STOPPED_EXIT = 3
UNVERIFIED_EXIT = 4
VERIFIED = "futures" in venue_traits.verified_modes("sinopac")
SDK_VERSION = "1.7.11"  # the version M0 ran; any other is refused before a login
ROOTS = contracts.ROOTS
TERMINAL = {"Filled", "Cancelled", "Failed", "Inactive"}
FAILED = {"Failed", "Inactive"}

# 身分證 (A123456789), 居留證 old (AB12345678) and new (A812345678); any case — a hand-typed
# .env value can be lowercase and the SDK echoes it as given
_ID_RE = re.compile(r"(?<![A-Za-z0-9])[A-Z][A-D1289]\d{8}(?![0-9])", re.IGNORECASE)


def redact(text):
    return _ID_RE.sub("<id>", str(text))


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


def creds(env):
    """Names locked by already-bound machines (web CX_VENUES): lowercase sinopac_*."""
    c = {k: env.get(k, "") for k in ("sinopac_api_key", "sinopac_secret_key", "sinopac_ca_path",
                                     "sinopac_ca_passwd", "sinopac_person_id")}
    c["live"] = str(env.get("SINOPAC_LIVE", "")).lower() == "true"
    if not c["sinopac_api_key"] or not c["sinopac_secret_key"]:
        raise ValueError("sinopac_api_key / sinopac_secret_key missing from .env")
    if c["live"] and (not c["sinopac_ca_path"] or not c["sinopac_ca_passwd"]):
        raise ValueError("SINOPAC_LIVE=true but sinopac_ca_path / sinopac_ca_passwd missing")
    return c


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


def login(c):
    """(api, futures account). Logs out on every failure path."""
    null_sdk_log()
    import shioaji as sj

    version = str(getattr(sj, "__version__", "") or "")
    if version != SDK_VERSION:
        raise LoginError(f"shioaji {version or '(unknown version)'} installed — the 永豐 futures "
                         f"worker runs on {SDK_VERSION} only; nothing logged in")
    api = sj.Shioaji(simulation=not c["live"])
    try:
        accounts = api.login(api_key=c["sinopac_api_key"], secret_key=c["sinopac_secret_key"],
                             subscribe_trade=True)
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
            raise LoginError("login returned no futures account (期貨戶未開或 API 未勾期貨)")
        if getattr(acct, "signed", True) is False:
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
    # 1.7.11's type stubs (_core.pyi, read 11-17); which one each failure raises is not measured
    return {k.__name__ for k in type(e).__mro__}


def too_many_connections(e):
    return bool(re.search(r"\b451\b", str(e))) or "too many connection" in str(e).lower()


def retryable(e):
    """The login never got an answer: a timeout, a connection error (ShioajiTimeoutError /
    ShioajiConnectionError subclass the builtins), DNS while the network comes up, 503
    maintenance, 451 too many connections. Never one of this module's own LoginErrors."""
    if isinstance(e, LoginError):
        return False
    if isinstance(e, (TimeoutError, ConnectionError, socket.gaierror)):
        return True
    return "SystemMaintenance" in _sdk_classes(e) or too_many_connections(e)


def _login_reason(e):
    if isinstance(e, LoginError):
        return e.reason
    names = _sdk_classes(e)
    if "AccountNotSignError" in names:
        return "NOT_SIGNED"
    if "CaError" in names:
        return "CERT"
    if retryable(e):
        return "TIMEOUT"
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
            if time.time() >= deadline:
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
    return snap


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


def _refresh(api, acct, trade):
    api.update_status(acct, trade=trade)
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
    return dict(base, status="filled" if qty else "sent", fill_qty=float(qty), avg_fill_price=avg)


def _confirm(api, acct, trade, deadline):
    """Poll to a terminal status or the deadline: (status text, latest trade)."""
    while True:
        _beat()  # a confirm can outlast WORKER_STALE_S: the next caller must not read the worker as down
        try:
            trade = _refresh(api, acct, trade)
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


def _wait_retry(retry_at, failures, err, positions):
    """Logged out until retry_at, the snapshot restamped every POLL_S (lib/sinopac_futures_account
    reads it as `waiting`: the reconciler skips the round instead of counting a failed read). It
    carries the last read's rows, never read as positions (ok false), for a later stop's P1. No
    heartbeat meanwhile: lib/order_sinopac refuses an order before writing its request."""
    while time.time() < retry_at:
        at = time.strftime("%H:%M", time.gmtime(retry_at + 8 * 3600))
        try:
            _write_snapshot({"ok": False, "waiting": "login_retry", "retry_at": retry_at,
                             "positions": positions,
                             "error": f"永豐登入失敗 {failures} 次（{err}），{at} 再試"})
        except OSError as e:
            _log(f"waiting snapshot not written ({type(e).__name__})")
        time.sleep(max(0.0, min(POLL_S, retry_at - time.time())))


def retry_wait_s(failures, e=None):
    """The wait after the `failures`-th unanswered login in a row: LOGIN_RETRY_S, then
    LOGIN_RETRY_LONG_S for good; at least LOGIN_451_WAIT_S after a 451."""
    wait = LOGIN_RETRY_S[failures - 1] if failures <= len(LOGIN_RETRY_S) else LOGIN_RETRY_LONG_S
    return max(wait, LOGIN_451_WAIT_S) if e is not None and too_many_connections(e) else wait


def announce_due(since, announced_at, now):
    """exchange_unreachable is due: the streak is UNREACHABLE_AFTER_S old and none was sent, or the
    last one is UNREACHABLE_REPEAT_S old (群益's cadence, manager/reconciler UNREACHABLE_REPEAT_S)."""
    if since is None or now - since < UNREACHABLE_AFTER_S:
        return False
    return announced_at is None or now - announced_at >= UNREACHABLE_REPEAT_S


def _login_with_retry(c):
    """login(c). An unanswered login (retryable) is tried again for good, spaced by retry_wait_s;
    the streak survives a restart (RETRY_PATH). Its P1 is exchange_unreachable, UNREACHABLE_AFTER_S
    in and every UNREACHABLE_REPEAT_S after, never while HALT is set (as the reconciler's: that
    event says trading resumes by itself). Any other failure stops (_login_stopped)."""
    st = _retry_state()
    positions = _last_positions()
    # the reconciler reads a missing or stale snapshot as a failed read (three in a row HALT): a
    # start — a reboot, the network not up yet — says it is logging in before the first try
    try:
        _write_snapshot({"ok": False, "waiting": "login", "positions": positions, "error": "永豐登入中"})
    except OSError as e:
        _log(f"logging-in snapshot not written ({type(e).__name__})")
    while True:
        _wait_retry(st["retry_at"], st["failures"], st["error"], positions)
        try:
            out = login(c)
        except Exception as e:
            err = _sanitize(e)
            if not retryable(e):
                _login_stopped(err, _login_reason(e))
            now = time.time()
            st["failures"] += 1
            st["since"] = st["since"] or now
            wait = retry_wait_s(st["failures"], e)
            st.update(retry_at=now + wait, error=err)
            if announce_due(st["since"], st["announced_at"], now) and not guard.halted():
                events.emit("exchange_unreachable", venue="sinopac", minutes=int((now - st["since"]) // 60),
                            code="login")
                st["announced_at"] = now
            try:
                _atomic_write(RETRY_PATH, st)
            except OSError as e2:
                _log(f"login retry state not written ({type(e2).__name__}) — a restart retries sooner")
            _log(f"login failed ({err}) — try {st['failures'] + 1} in {wait:.0f}s")
            continue
        _clear_retry()
        return out


def _mark_enabled():
    if os.path.exists(ENABLED_PATH):
        return
    try:
        _atomic_write(ENABLED_PATH, {"at": time.time()})
    except OSError as e:
        _log(f"futures-enabled marker not written ({type(e).__name__})")


def run_once():
    """The user's confirmed login: one login + read → probe file; clears STOP on success."""
    if not VERIFIED:
        _atomic_write(PROBE_PATH, {"ok": False, "error": "unverified", "read_at": time.time()})
        _log("永豐 futures is not live-verified yet — no login")
        return UNVERIFIED_EXIT
    _mark_enabled()
    with quiet_sdk():
        return _run_once()


def _run_once():
    api = None
    try:
        c = creds(_read_env(os.path.join(WORKSPACE, ".env")))
        api, acct = login(c)
        snap = read_account(api, acct)
        _atomic_write(PROBE_PATH, dict(snap, read_at=time.time(), simulation=not c["live"]))
        try:
            os.remove(STOP_PATH)
        except OSError:
            pass
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
    _mark_enabled()
    if os.path.exists(STOP_PATH):
        _log("a previous login failed — not logging in until the user confirms one (--once)")
        return LOGIN_STOPPED_EXIT
    with quiet_sdk():
        return _serve()


def _serve():
    _sweep_orders()
    try:
        c = creds(_read_env(os.path.join(WORKSPACE, ".env")))
    except Exception as e:
        _login_stopped(_sanitize(e), _login_reason(e))
    api, acct = _login_with_retry(c)
    _beat()
    simulation = not c["live"]
    try:
        while True:
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
            while time.time() < next_read:
                time.sleep(REQUEST_CHECK_S)
                _beat()
                if serve_requests(api, acct, simulation):
                    next_read = _settled_read_at()  # the next caller sees the fill, not M0-b's []
                if os.path.exists(REFRESH_FLAG):
                    try:
                        os.remove(REFRESH_FLAG)
                    except OSError:
                        pass
                    next_read = min(next_read, _settled_read_at())
    finally:
        try:
            api.logout()
        except Exception:
            pass


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
    _utf8_console()
    _exit_on_signals()
    rc = 1
    try:
        rc = run_once() if "--once" in sys.argv[1:] else main()
    except KeyboardInterrupt:
        rc = 0
    except SystemExit as e:
        rc = e.code if isinstance(e.code, int) else (0 if e.code is None else 1)
    except Exception as e:
        _log(f"worker crashed: {_sanitize(e)}")
    _hard_exit(rc)
