"""President Futures (統一期貨) account snapshot worker.

The machine's one long-lived Unitrade login: polls margin (權益數) and open
positions every 60 s and writes state/president_account.json, which
lib/account_president.py (the platform readers) only reads. Orders do not go
through here — lib/order_president.py opens its own short session per order
(two concurrent logins on one account measured fine on the test host).

lib/order_president.py touches state/president_refresh after every send; the
sleep loop early-ticks on it so a fill reaches the snapshot in seconds.

Broker maintenance (Taipei): login 05:30–05:50, account queries 06:00–07:30
(domestic futures trading 07:00–07:27 sits inside it). Inside a window no
query is made and the last good snapshot is re-stamped with `maintenance`
set — the market is closed then, so the carried positions are still true,
and a planned outage never reads as a dead worker.

Run: python lib/president_worker.py              (daemon)
     python lib/president_worker.py --unblock    (the user unlocked the account at the broker)
     python lib/president_worker.py --once       (one read → state/president_probe.json)
     python lib/president_worker.py --install    (Windows: NSSM service blave-agent-president)
     python lib/president_worker.py --uninstall
"""
import hashlib
import json
import os
import sys
import time
from datetime import datetime, time as dtime, timedelta, timezone

try:
    import president_vault  # run as a script: lib/ is sys.path[0]
except ImportError:
    from lib import president_vault

WORKSPACE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
STATE = os.path.join(WORKSPACE, "state")
OUT_PATH = os.path.join(STATE, "president_account.json")
PROBE_PATH = os.path.join(STATE, "president_probe.json")
REFRESH_FLAG = os.path.join(STATE, "president_refresh")
HEARTBEAT_PATH = os.path.join(STATE, "heartbeat", "president_worker")
BACKOFF_PATH = os.path.join(STATE, "president_worker_backoff.json")
SDK_LOG_DIR = president_vault.SDK_LOG_DIR

POLL_S = 60
REFRESH_CHECK_S = 2
MIN_TICK_SPACING_S = 10
BACKOFF_MAX_S = 1800
TAIPEI = timezone(timedelta(hours=8), "Asia/Taipei")  # no ZoneInfo: Windows has no tz database
ROOTS = ("TXF", "MXF", "TMF")
MAINTENANCE = (
    (dtime(5, 30), dtime(5, 50), "login"),
    (dtime(6, 0), dtime(7, 30), "account"),
)
_RATE_LIMITED = "超過每分鐘限制"  # unitrade Error.MSG012
MARGIN_CURRENCY = "NTT"


def _log(msg):
    print(f"[president_worker] {msg}", flush=True)  # never the account / login id


def maintenance(now=None):
    """The broker window `now` falls in ('login' / 'account'), or None."""
    t = (now or datetime.now(TAIPEI)).astimezone(TAIPEI).time()
    for start, end, label in MAINTENANCE:
        if start <= t < end:
            return label
    return None


class RateLimited(RuntimeError):
    """Unitrade's per-minute query cap — skip the tick, keep the last snapshot."""


def _atomic_write(path, payload):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path + ".tmp", "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False)
    os.replace(path + ".tmp", path)


def _write_snapshot(payload):
    # float: the order lib compares it with its last send to the sub-second
    payload["read_at"] = time.time()
    _atomic_write(OUT_PATH, payload)


def _check(resp, call):
    if resp is None or not resp.ok:
        err = str(getattr(resp, "error", "") or "")
        if _RATE_LIMITED in err:
            raise RateLimited(f"{call}: {err}")
        raise RuntimeError(f"{call} failed: {president_vault.sanitize(err) or 'no answer'}")
    return resp


def position_row(p):
    """One DPosition → a snapshot row, or None for a non-TXF/MXF/TMF product.
    Raises on a futures row whose contract code the lib can't read."""
    product = str(getattr(p, "product", "") or "").upper()
    if product not in ROOTS or str(getattr(p, "call_put", "") or "").strip():
        return None
    pid = str(getattr(p, "productid", "") or "").upper()
    if not (len(pid) == 5 and pid[:3] == product and pid[3] in "ABCDEFGHIJKL" and pid[4].isdigit()):
        raise RuntimeError(f"get_position: {product} row with unreadable contract code {pid!r}")
    # current_*_open_position is the open interest: on the live account (10-02) an
    # MXFJ6 row read ot_qty_b=3, current_buy_open_position=2 and the broker's app
    # showed 2. ot_qty is kept for debugging only — never reconciled on.
    return {
        "root": product,
        "productid": pid,
        "month": str(getattr(p, "month", "") or ""),
        "net": int(p.current_buy_open_position) - int(p.current_sell_open_position),
        "debug_ot_net": int(p.ot_qty_b) - int(p.ot_qty_s),
        "avg_cost_buy": float(p.open_buy_position_average_cost or 0),
        "avg_cost_sell": float(p.open_sell_position_average_cost or 0),
        "floating_pnl": float(p.floating_pnl or 0),
        "point_value": int(p.product_base_number or 0),
    }


def _num(obj, name):
    v = getattr(obj, name, None)
    try:
        return None if v is None or v == "" else float(v)
    except (TypeError, ValueError):
        return None


_LISTED = {"at": 0.0, "value": None}
LISTED_TTL_S = 300


def _listed_contracts(api):
    """{root: [contract codes]} the broker lists now (cached 5 min), or None —
    lib/president_contracts tells a settled expired month from a still-trading
    one with it."""
    if time.time() - _LISTED["at"] < LISTED_TTL_S and _LISTED["value"] is not None:
        return _LISTED["value"]
    out = {}
    try:
        for root in ROOTS:
            r = api.get_domestic_contracts(root, "F")
            if not r or not r.ok:
                return None  # unknown — never a partial list
            out[root] = [str(c.prod_id).upper() for c in r.data or []]
    except Exception:
        return None
    _LISTED.update(at=time.time(), value=out)
    return out


def read_account(api, actno):
    """One margin + position read. RateLimited on the SDK's per-minute cap."""
    snap = {"ok": True, "error": None, "equity": None, "available": None,
            "initial_margin": None, "maintenance_margin": None, "day_flow": None,
            "margin_updated": None, "margin_error": None, "currency": "TWD",
            "positions": [], "maintenance": None,
            # what the order lib and the reconciler compare with their last send
            "query_started_at": time.time()}
    # currency "NTT": "" answers 查無資料 on the live account too (10-02); .data is
    # one DMargin there, not a list — both shapes are taken
    m = api.daccount.get_margin(actno, MARGIN_CURRENCY)
    d = (m.data[0] if isinstance(m.data, list) and m.data else m.data) if m is not None and m.ok else None
    if d is not None and getattr(d, "optequity", None) is not None:
        # only optequity is required; a missing side field is None, not a failed round
        snap["equity"] = float(d.optequity)                  # 權益數 (matched the app, 10-02)
        snap["available"] = _num(d, "ordcexcess")            # 可動用保證金
        snap["initial_margin"] = _num(d, "iamt")             # 原始保證金
        snap["maintenance_margin"] = _num(d, "mamt")         # 維持保證金
        snap["day_flow"] = _num(d, "dwamt")                  # 當日出入金 — unverified as a flow source
        snap["margin_updated"] = f"{getattr(d, 'update_date', '') or ''} {getattr(d, 'update_time', '') or ''}".strip() or None
    elif m is not None and _RATE_LIMITED in str(m.error or ""):
        raise RateLimited(f"get_margin: {m.error}")
    else:
        # 查無資料 on an unfunded account is an answer, not a dead link
        snap["margin_error"] = president_vault.sanitize(
            getattr(m, "error", "") or ("optequity missing" if d is not None else "no data"))
    snap["listed"] = _listed_contracts(api)
    p = _check(api.daccount.get_position(actno, "", ""), "get_position")
    for row in p.data or []:
        r = position_row(row)
        if r and r["net"]:
            snap["positions"].append(r)
    snap["data_at"] = int(time.time())
    # which account, without writing the account number down
    snap["account_fp"] = hashlib.sha256(f"president-account-v1\0{actno}".encode()).hexdigest()[:16]
    return snap


def _backoff_and_exit(error):
    try:
        with open(BACKOFF_PATH, encoding="utf-8") as f:
            n = int(json.load(f).get("failures", 0))
    except (OSError, ValueError, AttributeError, TypeError):
        n = 0
    try:
        _atomic_write(BACKOFF_PATH, {"failures": n + 1})
    except OSError:
        pass
    _write_snapshot({"ok": False, "error": president_vault.sanitize(error)})
    time.sleep(min(30 * 2 ** n, BACKOFF_MAX_S))
    sys.exit(1)


def _login():
    creds = president_vault.resolve()
    api = president_vault.login(creds, SDK_LOG_DIR)
    accounts = api.get_accounts() or []
    if not accounts:
        api.logout()
        raise RuntimeError("login returned no futures account")
    return api, accounts[0]


def _sleep_until_refresh():
    """Sleep up to POLL_S; tick early on the refresh flag, but not before
    ORDER_SETTLE_S after the flag was touched — a read that starts sooner does
    not count as showing the send (president_vault.ORDER_SETTLE_S)."""
    slept = 0
    while slept < POLL_S:
        time.sleep(REFRESH_CHECK_S)
        slept += REFRESH_CHECK_S
        try:
            touched = os.path.getmtime(REFRESH_FLAG)
        except OSError:
            continue
        if slept >= MIN_TICK_SPACING_S and time.time() >= touched + president_vault.ORDER_SETTLE_S:
            try:
                os.remove(REFRESH_FLAG)
            except OSError:
                pass
            return


def run_once():
    """Log in, read once, write state/president_probe.json, log out. Exit 0/2."""
    api = None
    try:
        api, actno = _login()
        snap = read_account(api, actno)
        _atomic_write(PROBE_PATH, dict(snap, read_at=time.time(), test_mode=api.test_mode))
        _log(f"probe ok equity={snap['equity']} margin_error={snap['margin_error']} "
             f"positions={[(r['productid'], r['net']) for r in snap['positions']]}")
        return 0
    except Exception as e:
        err = president_vault.sanitize(f"{type(e).__name__}: {e}")
        _atomic_write(PROBE_PATH, {"ok": False, "error": err, "read_at": time.time()})
        _log(f"probe failed: {err}")
        return 2
    finally:
        if api is not None:
            api.logout()


def main():
    last_good = None
    api = actno = None
    try:
        while True:
            os.makedirs(os.path.dirname(HEARTBEAT_PATH), exist_ok=True)
            with open(HEARTBEAT_PATH, "w"):
                pass
            window = maintenance()
            if window:
                if last_good:
                    _write_snapshot(dict(last_good, maintenance=window))
                else:
                    _write_snapshot({"ok": False, "error": f"統一期貨 {window} maintenance — "
                                                          f"no snapshot yet", "maintenance": window})
                _sleep_until_refresh()
                continue
            try:
                if api is None:
                    api, actno = _login()
                    try:
                        os.remove(BACKOFF_PATH)
                    except OSError:
                        pass
                snap = read_account(api, actno)
            except RateLimited as e:
                _log(f"tick skipped: {president_vault.sanitize(str(e))}")
                _sleep_until_refresh()
                continue
            except Exception as e:
                if api is None:
                    # the login itself failed: no second attempt now (a wrong password
                    # retried in a loop is how accounts get locked) — back off
                    err = president_vault.sanitize(f"{type(e).__name__}: {e}")
                    _log(f"login failed: {err}")
                    _backoff_and_exit(err)
                # a session that went stale across a maintenance window gets one fresh login
                api.logout()
                api = None
                try:
                    api, actno = _login()
                    snap = read_account(api, actno)
                except Exception as e2:
                    err = president_vault.sanitize(f"{type(e2).__name__}: {e2}")
                    _log(f"tick failed: {president_vault.sanitize(f'{type(e).__name__}: {e}')} / retry: {err}")
                    if api is not None:
                        api.logout()
                        api = None
                    _backoff_and_exit(err)
            _write_snapshot(snap)
            last_good = snap
            _log(f"snapshot ok equity={snap['equity']} positions={len(snap['positions'])}")
            _sleep_until_refresh()
    finally:
        if api is not None:
            api.logout()


# ── Windows service (NSSM), same recipe as runtime/capital_connect.run_finish ──
SERVICE = "blave-agent-president"
DEPLOYMENTS_PATH = os.path.join(STATE, "deployments.json")
INSTALL_WAIT_S = 120


def _nssm(*args, timeout=60):
    import subprocess
    r = subprocess.run(["nssm", *args], capture_output=True, timeout=timeout)
    return r.returncode


def _deployments(update):
    try:
        with open(DEPLOYMENTS_PATH, encoding="utf-8") as f:
            deps = json.load(f)
    except (OSError, ValueError):
        deps = {}
    if not isinstance(deps, dict):
        deps = {}
    update(deps)
    _atomic_write(DEPLOYMENTS_PATH, deps)


def install():
    """Install (or re-point) and start the service; wait for its first snapshot.
    LocalSystem, unlike 群益: Unitrade has no Windows-identity constraint. The
    interpreter is this one — the one `pip install unitrade` went into. Exit 0
    with the snapshot's verdict printed, 2 on failure."""
    import shutil
    if os.name != "nt":
        _log("install: Windows only (v1)")
        return 2
    if os.environ.get("BLAVE_AGENT_LOCAL") == "1":
        # on the user's own PC the agent runs as the user: a LocalSystem service
        # executing agent-writable files would hand it SYSTEM
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
    log = os.path.join(STATE, "president_worker.log")
    os.makedirs(STATE, exist_ok=True)
    for step in (("set", SERVICE, "Application", sys.executable),
                 ("set", SERVICE, "AppParameters", os.path.abspath(__file__)),
                 ("set", SERVICE, "AppDirectory", WORKSPACE),
                 ("set", SERVICE, "AppStdout", log),
                 ("set", SERVICE, "AppStderr", log),
                 ("set", SERVICE, "Start", "SERVICE_AUTO_START"),
                 ("start", SERVICE)):
        if _nssm(*step, timeout=90) != 0:
            _log(f"install: nssm {step[0]} {step[2] if step[0] == 'set' else ''} failed")
            return 2
    _deployments(lambda d: d.setdefault("president_worker", {
        "type": "daemon", "expect_every_minutes": 5,
        "registered_at": time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime())}))
    deadline = time.time() + INSTALL_WAIT_S
    while time.time() < deadline:
        time.sleep(3)
        try:
            with open(OUT_PATH, encoding="utf-8") as f:
                snap = json.load(f)
        except (OSError, ValueError):
            continue
        if (snap.get("read_at") or 0) >= started:
            if not snap.get("ok") and any(k in str(snap.get("error")) for k in president_vault.AUTH_CLASSES
                                          + ("BLOCKED",)):
                _nssm("stop", SERVICE, timeout=90)  # a refused login must not be retried by restarts
            _log(f"install: service running, first snapshot ok={snap.get('ok')} "
                 f"error={snap.get('error')}")
            return 0 if snap.get("ok") else 2
    _log("install: service started but wrote no snapshot in time")
    return 2


def uninstall():
    if os.name != "nt":
        return 2
    _nssm("stop", SERVICE, timeout=90)
    rc = _nssm("remove", SERVICE, "confirm")
    _deployments(lambda d: d.pop("president_worker", None))
    _log(f"uninstall: nssm remove rc={rc}")
    return 0 if rc == 0 else 2


if __name__ == "__main__":
    if "--once" in sys.argv[1:]:
        # the first production login after the test host: president_vault.FIRST_LIVE_GRACE
        president_vault.FIRST_LIVE_GRACE = "--first-live" in sys.argv[1:]
        sys.exit(run_once())
    if "--install" in sys.argv[1:]:
        sys.exit(install())
    if "--uninstall" in sys.argv[1:]:
        sys.exit(uninstall())
    if "--unblock" in sys.argv[1:]:
        # only after the user says the account is unlocked at the broker
        state = president_vault.unblock()
        _log({"released": "unblock: one login allowed; a failure blocks again",
              "none": "unblock: nothing was blocked",
              "used": "unblock: refused — this block was already released once; it lifts "
                      "only when the credentials in .env change"}[state])
        sys.exit(0 if state != "used" else 2)
    try:
        main()
    except KeyboardInterrupt:  # `nssm stop` sends Ctrl-C; main's finally already logged out
        sys.exit(0)
