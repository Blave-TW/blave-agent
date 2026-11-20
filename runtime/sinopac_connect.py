"""永豐期貨 (SinoPac) connect: the deterministic machine side.

Same shape as runtime/president_connect.py (one-time key, envelope, a status file the report
carries as `sinopac_connect`), the designer's sinopac-connect-2026-11-17 flow: every step is a
command with a fixed outcome, nothing goes through the agent. Cloud hosts are Linux, and the
Windows boxes opened for 群益 / 統一 (Wei 11-17). Every step refuses while the futures gate is shut.

Cloud steps (the api's agent_command ALLOWED, desktop_auth.CLOUD_MACHINE_ONLY_COMMANDS):
  sinopac_setup     shioaji (pinned) into the worker's python; cryptography into this one.
  sinopac_pfx_key   one-time RSA key (capital_connect.cmd_pfx_key); the ack carries the public half.
  sinopac_pfx       {key_id, envelope}: sealed {pfx, api_key, secret_key, person_id, ca_password}.
                    The certificate is opened HERE before anything is stored or sent to 永豐: an
                    empty ca_password tries the national id (M0-a: they were equal; Wei 11-17 one
                    field), and a certificate that will not open with it is refused PFX_PASSWORD
                    with cert.ca_password_asked — the page then shows the separate field. Then
                    sinopac_service.store: vault + certificate, .env sentinels. No login.
  sinopac_probe     `lib/sinopac_worker.py --once`: one production login, the user's 「確認登入」 /
                    「再查一次」; a pass clears a login STOP. Its class goes to probe.state; only
                    NOT_SIGNED opens the signing step (sim.status "ask") — every other failure is a
                    login error on row ②.
  sinopac_sim_test  `lib/sinopac_worker.py --sim-test`: one futures order in SIMULATION mode, the
                    test 永豐's signing review wants, then up to SIM_CHECKS probes SIM_CHECK_EVERY_S
                    apart until the production login reads signed (spec s-review / s-notyet).
                    Weekdays SIM_OPEN–SIM_CLOSE_CLOUD Taipei (永豐 refuses non-Taiwan IPs after 18:00).
  sinopac_finish    the worker is wanted (sinopac_service.WANTED); Linux: blave-agent-sinopac.timer
                    starts it, this waits for its first snapshot; Windows: NSSM (--install).

Desktop (runtime/sinopac_local.py, `sinopac_local` ops): the same jobs, local=True — the
children that log in get the app's credentials as their first stdin line, and the simulation
window runs to SIM_CLOSE_LOCAL.

Never put a secret, a pfx byte, a certificate subject or a broker message into a return value,
an exception, the status or a log: probe and simulation results leave as classes.
"""
import json
import os
import subprocess
import sys
import threading
import time

import atomic_file
import capital_connect as cc
import sinopac_service
import venue_traits

WORKSPACE = os.environ.get("BLAVE_AGENT_WORKSPACE", "/opt/blave-agent/workspace")
IS_WINDOWS = os.name == "nt"
COMMANDS = ("sinopac_setup", "sinopac_pfx_key", "sinopac_pfx", "sinopac_probe", "sinopac_sim_test",
            "sinopac_finish")
SHIOAJI_PIN = "shioaji==1.7.11"  # = lib/sinopac_worker.SDK_VERSION
SETUP_TIMEOUT_S = 900
PROBE_TIMEOUT_S = 150
SIM_TIMEOUT_S = 150
FINISH_WAIT_S = 300  # the Linux timer ticks every 2 minutes, then a login and a first read
SIM_CHECKS = 5
SIM_CHECK_EVERY_S = 180
SIM_OPEN = (8, 0)
SIM_CLOSE_CLOUD = (18, 0)  # 永豐 refuses a non-Taiwan IP after 18:00 (designer §7)
SIM_CLOSE_LOCAL = (20, 0)
LOGIN_451_WAIT_S = 600  # = lib/sinopac_worker.LOGIN_451_WAIT_S
NOT_BOUND_EXIT = 6      # = lib/sinopac_worker.NOT_BOUND_EXIT
UNVERIFIED_EXIT = 4     # = lib/sinopac_worker.UNVERIFIED_EXIT
_ID_KEYS = ("api_key", "secret_key", "person_id")
_SECTIONS = ("setup", "cert", "probe", "sim", "worker")
# lib/sinopac_worker._login_reason → probe.state (designer §4)
LOGIN_STATES = {"KEY": "key", "NO_FUTURES": "no_futures", "CERT": "cert", "TOO_MANY": "too_many",
                "TIMEOUT": "timeout", "CLOCK": "clock", "VERSION": "version", "NOT_SIGNED": "not_signed",
                "UNKNOWN": "unknown"}
_busy = threading.Lock()
_status_lock = threading.Lock()


def _refuse(code, text=""):
    raise ValueError(f"{code}: {text}" if text else code)


def _paths():
    p = sinopac_service.paths(WORKSPACE)
    st = p["state"]
    return dict(p, key=os.path.join(p["cred"], "sinopac_pfx_key.json"),
                status=os.path.join(st, "sinopac_connect.json"), probe=os.path.join(st, "sinopac_probe.json"),
                sim=os.path.join(st, "sinopac_sim_test.json"), snapshot=os.path.join(st, "sinopac_account.json"),
                wanted=os.path.join(WORKSPACE, sinopac_service.WANTED))


# ── status (state/sinopac_connect.json) ──────────────────────────────────────

def read_status():
    try:
        st = atomic_file.load_json(_paths()["status"], encoding="utf-8")
    except (OSError, ValueError):
        return None
    return st if isinstance(st, dict) else None


def _update(section=None, reset=False, **fields):
    with _status_lock:
        st = read_status() or {"v": 1, "busy": None, **{s: {"status": "idle", "at": None} for s in _SECTIONS}}
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


def _end_step():
    """A step's end: `busy` off, a section it left running failed INTERRUPTED (a runtime publish
    killed the step's thread). Caller holds _busy."""
    st = read_status()
    if not st:
        return
    stuck = [s for s in _SECTIONS if isinstance(st.get(s), dict) and st[s].get("status") in ("running", "importing")]
    for s in stuck:
        _update(s, status="failed", error="INTERRUPTED")
    if st.get("busy"):
        _update(busy=None)


def _release_step():
    try:
        _end_step()
    except (OSError, ValueError) as e:
        print(f"[sinopac_connect] status not written at step end ({type(e).__name__})", file=sys.stderr)
    finally:
        _busy.release()


# ── envelope + certificate ───────────────────────────────────────────────────

def open_envelope(key_id, envelope, key_path):
    """→ (pfx bytes, {api_key, secret_key, person_id, ca_password}). capital_connect.open_envelope's
    recipe (the key is consumed before the decrypt) with 永豐's payload."""
    c = cc._crypto()
    try:
        with open(key_path, encoding="utf-8") as f:
            rec = json.load(f)
    except (OSError, ValueError):
        rec = None
    try:
        os.remove(key_path)
    except OSError:
        pass
    import hmac
    if (not isinstance(rec, dict) or not isinstance(rec.get("key_id"), str)
            or not hmac.compare_digest(rec["key_id"], key_id)
            or not isinstance(rec.get("expires_at"), int) or rec["expires_at"] < time.time()):
        _refuse("KEY_EXPIRED", "request a new key and upload again")
    priv = c["ser"].load_pem_private_key(rec["pem"].encode(), password=None)
    ek, iv, ct = (cc._b64(envelope[k], k) for k in ("ek", "iv", "ct"))
    try:
        body = json.loads(c["AESGCM"](priv.decrypt(ek, cc._oaep(c))).decrypt(iv, ct, key_id.encode()).decode("utf-8"))
    except Exception:
        _refuse("ENVELOPE_INVALID", "could not decrypt")
    if not isinstance(body, dict) or not isinstance(body.get("pfx"), str):
        _refuse("ENVELOPE_INVALID", "bad payload")
    pfx = cc._b64(body["pfx"], "pfx")
    if len(pfx) > cc.PFX_MAX_BYTES:
        _refuse("PFX_TOO_LARGE", f"over {cc.PFX_MAX_BYTES} bytes")
    return pfx, bundle(body, live=True)


def bundle(d, live):
    """The credential fields, shape-checked (sinopac_local's rules); → store()'s bundle."""
    import sinopac_local
    try:
        return sinopac_local._bundle(dict({k: d.get(k) for k in _ID_KEYS + ("ca_password",)},
                                          ca_password=d.get("ca_password") or "", live=live))
    except sinopac_local.Refused as e:
        _refuse(e.code, "the sealed fields")


def open_pfx(pfx, b):
    """(meta, the password that opened it). One field (Wei 11-17): no separate CA password → the
    national id is tried; a certificate it will not open is refused PFX_PASSWORD with the page told
    to ask (cert.ca_password_asked). A separate password that will not open it is PFX_PASSWORD too."""
    import president_connect as pc
    pw = b["ca_password"] or b["person_id"]
    try:
        return pc.inspect_pfx(pfx, pw), pw
    except ValueError as e:
        if cc._code(e, "") == "PFX_PASSWORD" and not b["ca_password"]:
            _update("cert", ca_password_asked=True)
        raise


def store_cert(pfx, b, local, push=None):
    """Checked certificate + bundle → the store. A rebind starts the flow over."""
    _update("cert", status="importing", error=None, reset=False)
    if push:
        push()
    try:
        meta, pw = open_pfx(pfx, b)
        sinopac_service.store(dict(b, ca_password=pw), pfx, local=local, workspace=WORKSPACE)
    except Exception as e:
        _update("cert", status="failed", error=cc._code(e, "IMPORT_FAILED"),
                not_after=getattr(e, "not_after", None))
        raise
    for sec in ("probe", "sim", "worker"):
        _update(sec, reset=True, status="idle")
    _update("cert", reset=True, status="ok", error=None, not_after=meta["not_after"],
            ca_password_asked=bool(b["ca_password"]))
    return {"cert": {"not_after": meta["not_after"]}}


# ── children that log in ─────────────────────────────────────────────────────

def _python(local):
    if local or not IS_WINDOWS:
        return sys.executable  # Linux: the agent venv the unit's ExecStart runs; desktop: its venv
    py = cc._python_for_worker()
    if not py:
        _refuse("PYTHON_MISSING", "python.exe not found")
    return py


def _run_worker(flag, timeout, local):
    """→ returncode; None = timed out or could not start. Desktop: the credentials are the child's
    first stdin line (lib/sinopac_vault.take_local_line), never argv or the environment."""
    argv = [_python(local), _paths()["worker"], flag]
    if not local:
        try:
            return cc._run_quiet(argv, timeout, flag).returncode
        except RuntimeError:
            return None
    import command_listener as cl
    import sinopac_local
    line = sinopac_local.secret_line()
    if not line:
        _refuse("NO_SECRETS", "the app has not handed over the 永豐 credentials")
    try:
        p = subprocess.Popen(argv, cwd=WORKSPACE, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                             start_new_session=not IS_WINDOWS,
                             env=cl._local_child_env(SJ_LOG_PATH=os.devnull, **sinopac_local._CHILD_FLAGS),
                             **cl._child_kw(stdin=subprocess.PIPE))
    except OSError:
        return None
    try:
        p.communicate((line + "\n").encode("utf-8"), timeout=timeout)
    except BaseException:
        sinopac_local.kill_tree(p)  # it holds the credentials line: nothing leaves with it running
        try:
            p.communicate(timeout=5)
        except (subprocess.SubprocessError, OSError, ValueError):
            pass
        return None
    return p.returncode


def _read_since(path, started):
    try:
        obj = atomic_file.load_json(path, encoding="utf-8")
    except (OSError, ValueError):
        return None
    return obj if isinstance(obj, dict) and (obj.get("read_at") or 0) >= started else None


def probe_state(obj, rc):
    """The worker's probe file + exit → probe fields. Classes only."""
    if rc == UNVERIFIED_EXIT:
        return {"state": "not_open"}
    if rc == NOT_BOUND_EXIT:
        return {"state": "no_credentials"}
    if not isinstance(obj, dict):
        return {"state": "timeout" if rc is None else "unknown"}
    if obj.get("ok") and rc == 0:
        return {"state": "ok", "signed": True, "equity_read": obj.get("equity") is not None}
    st = {"state": LOGIN_STATES.get(obj.get("reason"), "unknown")}
    if st["state"] == "too_many":
        st["retry_at"] = int((obj.get("read_at") or time.time()) + LOGIN_451_WAIT_S)  # spec r-451 {time}
    return st


def run_probe(local=False, push=None):
    _update("probe", status="running", reset=True)
    if push:
        push()
    started = time.time() - 1
    rc = _run_worker("--once", PROBE_TIMEOUT_S, local)
    st = probe_state(_read_since(_paths()["probe"], started), rc)
    _update("probe", status="ok" if st["state"] == "ok" else "failed", **st)
    if st["state"] == "not_signed":
        sim = (read_status() or {}).get("sim") or {}
        if sim.get("status") not in ("sent", "review"):
            _update("sim", reset=True, status="ask")  # the only way into the signing step
    elif st["state"] == "ok":
        if IS_WINDOWS and not local:
            _restart_after_relogin()
        sim = ((read_status() or {}).get("sim") or {}).get("status")
        if sim in ("ask", "review", "failed"):  # signed since: the user signed, or the review passed
            _update("sim", status="passed")
    return st


def next_sim_open(local, now=None):
    """Epoch second the simulation window next opens (weekday 08:00 Taipei), from `now`."""
    now = now or time.time()
    t = now + 8 * 3600
    day0 = t - t % 86400  # Taipei midnight, as a shifted epoch
    for d in range(0, 8):
        start = day0 + d * 86400 + SIM_OPEN[0] * 3600 + SIM_OPEN[1] * 60
        if time.gmtime(start).tm_wday < 5 and start > t:
            return int(start - 8 * 3600)
    return int(now)


def sim_window_open(local, now=None):
    t = time.gmtime((now or time.time()) + 8 * 3600)
    close = SIM_CLOSE_LOCAL if local else SIM_CLOSE_CLOUD
    return t.tm_wday < 5 and SIM_OPEN <= (t.tm_hour, t.tm_min) < close


def run_sim_test(local=False, push=None):
    """The simulation order, then the signing review: SIM_CHECKS production probes, SIM_CHECK_EVERY_S
    apart, until one reads signed (spec s-review → passed, else s-notyet)."""
    _update("sim", status="running", reset=True)
    if push:
        push()
    started = time.time() - 1
    rc = _run_worker("--sim-test", SIM_TIMEOUT_S, local)
    obj = _read_since(_paths()["sim"], started)
    if rc != 0 or not isinstance(obj, dict) or not obj.get("ok"):
        st = probe_state(obj, rc) if isinstance(obj, dict) and obj.get("reason") else {}
        state = "rejected" if isinstance(obj, dict) and obj.get("broker_status") else st.get("state", "failed")
        h = time.gmtime(time.time() + 8 * 3600).tm_hour
        if local and h >= SIM_CLOSE_CLOUD[0] and state in ("rejected", "unknown", "key"):
            # spec s-twip: after 18:00 永豐 takes simulation orders from Taiwan IPs only. UNMEASURED —
            # the refusal's shape was never seen; a refusal in that hour on this computer is read as it
            state = "tw_ip"
        fields = {"next_open_at": next_sim_open(local)} if state == "tw_ip" else {}
        _update("sim", status="failed", state=state, **fields)
        return {"sim": state}
    _update("sim", status="review", sent_at=int(time.time()), checks=0)
    if push:
        push()
    for n in range(1, SIM_CHECKS + 1):
        time.sleep(SIM_CHECK_EVERY_S)
        st = run_probe(local, push)
        _update("sim", status="review", checks=n)
        if st["state"] == "ok":
            _update("sim", status="passed")
            return {"sim": "passed"}
        if st["state"] not in ("not_signed", "timeout", "too_many"):  # those two: check again later
            _update("sim", status="failed", state=st["state"])
            return {"sim": st["state"]}
    _update("sim", status="failed", state="not_yet")  # spec s-notyet: NOT_SIGNED after the checks
    return {"sim": "not_yet"}


def run_setup(local=False, push=None):
    _update("setup", status="running", error=None)
    if push:
        push()
    failed = []
    py = _python(local)
    try:
        r = cc._run_quiet([py, "-m", "pip", "install", "--quiet", SHIOAJI_PIN], SETUP_TIMEOUT_S, "pip")
        pin = SHIOAJI_PIN.split("==")[1]
        if r.returncode != 0 or cc._run_quiet(
                [py, "-c", f"import shioaji,sys; sys.exit(shioaji.__version__ != {pin!r})"], 120,
                "import").returncode != 0:
            failed.append("shioaji")  # no wheel for this platform lands here too (Windows on ARM)
    except RuntimeError:
        failed.append("shioaji")
    try:
        import cryptography  # noqa: F401
    except ImportError:
        try:
            if cc._run_quiet([sys.executable, "-m", "pip", "install", "--quiet", "cryptography"], 600,
                             "pip").returncode != 0:
                failed.append("cryptography")
        except RuntimeError:
            failed.append("cryptography")
    if failed:
        _update("setup", status="failed", error="SETUP_FAILED:" + ",".join(failed))
        _refuse("SETUP_FAILED", ", ".join(failed))
    _update("setup", status="ok", error=None)
    return {"setup": "ok"}


def run_finish(local=False, push=None):
    """The worker is wanted from here on; ok once its first snapshot reads the account."""
    _update("worker", status="running", reset=True)
    if push:
        push()
    p = _paths()
    started = time.time() - 1
    try:
        with atomic_file.replacing(p["wanted"], encoding="utf-8") as f:
            json.dump({"at": int(time.time())}, f)
        if IS_WINDOWS and not local:
            r = cc._run_quiet([_python(local), p["worker"], "--install"], FINISH_WAIT_S, "install")
            ok = r.returncode == 0
        else:
            deadline = time.time() + FINISH_WAIT_S
            snap = None
            while time.time() < deadline and snap is None:
                time.sleep(3)
                snap = _read_since(p["snapshot"], started)
            ok = bool(snap and snap.get("ok"))
        if not ok:
            _refuse("WORKER_FAILED", "the 永豐 worker did not read the account")
    except Exception as e:
        _update("worker", status="failed", error=cc._code(e, "WORKER_FAILED"))
        raise
    _update("worker", status="ok", error=None)
    return {"worker": "ok"}


# ── dispatch ─────────────────────────────────────────────────────────────────

def gate():
    """Refusals every step shares: the futures gate, then (login steps) the binding."""
    if "futures" not in venue_traits.verified_modes(sinopac_service.VENUE):
        _refuse("NOT_OPEN", "永豐 futures is not open yet")


def need_bound(cmd):
    if not sinopac_service.bound(WORKSPACE) or not os.path.isfile(_paths()["pfx"]):
        _refuse("NOT_BOUND", "upload the certificate and keys first")
    if cmd in ("sim_test", "sinopac_sim_test"):
        sim = ((read_status() or {}).get("sim") or {}).get("status")
        if sim not in ("ask", "failed"):
            _refuse("NOT_ASKED", "the simulation test runs only after a login read the account as not signed")


SERVICE = "blave-agent-sinopac"  # the Linux unit's name and the Windows NSSM service (lib/sinopac_worker.SERVICE)


def worker_online():
    """The cloud worker service is up (logged in, or in its retry loop about to be): a probe now would
    be a second login of the same national id (audit r2 S3). A check that cannot run reads as up."""
    try:
        if IS_WINDOWS:
            r = cc._run_quiet(["nssm", "status", SERVICE], 30, "nssm status")
            out = ((r.stdout or b"") + (r.stderr or b"")).decode("utf-8", "replace")
            if r.returncode != 0:
                return "Can't open service" not in out  # not installed (before finish) = offline
            return "SERVICE_STOPPED" not in out
        return cc._run_quiet(["systemctl", "is-active", "--quiet", SERVICE + ".service"], 30,
                             "systemctl").returncode == 0
    except RuntimeError:
        return True


def _restart_after_relogin():
    """Windows cloud: NSSM left the service stopped on the login STOP (exit 3 → Exit); the probe that
    cleared the STOP starts it again (Linux: the timer does within two minutes; desktop: the
    supervisor). Only once the connect flow finished — before that, finish starts it."""
    if not os.path.exists(_paths()["wanted"]):
        return
    try:
        cc._run_quiet(["nssm", "start", SERVICE], 90, "nssm start")
    except RuntimeError as e:
        print(f"[sinopac_connect] worker not restarted after the login ({e})", file=sys.stderr)


def start_step(name, job, deferred_cls):
    if not _busy.acquire(blocking=False):
        _refuse("BUSY", f"another 永豐 step is running ({(read_status() or {}).get('busy')})")
    try:
        _update(busy=name)
    except Exception:
        _busy.release()
        raise
    return deferred_cls(job, cleanup=_release_step)


def dispatch(cmd, args, deferred_cls, push=None, local=False):
    """command_listener's HANDLERS entry for every name in COMMANDS (cloud)."""
    if local:
        _refuse("LOCAL_MODE", "the desktop connects 永豐 through the app (sinopac_local)")
    gate()
    if cmd == "sinopac_pfx_key":
        return cc.cmd_pfx_key(args, key_path=_paths()["key"])
    if cmd == "sinopac_pfx":
        cc.check_pfx_args(args)

        def job():
            try:
                pfx, b = open_envelope(args["key_id"], args["envelope"], _paths()["key"])
            except Exception as e:
                _update("cert", status="failed", error=cc._code(e, "IMPORT_FAILED"))
                raise
            return store_cert(pfx, b, local=False, push=push)
        return start_step(cmd, job, deferred_cls)
    if args:
        _refuse("BAD_ARGS", f"{cmd} takes no arguments")
    if cmd == "sinopac_setup":
        return start_step(cmd, lambda: run_setup(False, push), deferred_cls)
    if cmd not in COMMANDS:
        _refuse("BAD_ARGS", "unknown 永豐 command")
    need_bound(cmd)
    if cmd in ("sinopac_probe", "sinopac_sim_test") and worker_online():
        _refuse("WORKER_RUNNING", "the 永豐 worker is online (logged in or retrying): one login at a time")
    if cmd == "sinopac_probe":
        return start_step(cmd, lambda: run_probe(False, push), deferred_cls)
    if cmd == "sinopac_sim_test":
        if not sim_window_open(False):
            _update("sim", next_open_at=next_sim_open(False))
            _refuse("SIM_CLOSED", "the simulation test runs weekdays 08:00–18:00 Taipei on a cloud host")
        return start_step(cmd, lambda: run_sim_test(False, push), deferred_cls)
    probe = (read_status() or {}).get("probe") or {}
    if probe.get("state") != "ok":
        _refuse("PROBE_NOT_OK", "the production login has not passed yet")
    return start_step(cmd, lambda: run_finish(False, push), deferred_cls)
