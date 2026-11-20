"""systemd ExecStart shim for blave-agent-sinopac.service (Linux cloud): the 永豐 futures worker.
A Windows cloud box runs the worker as the NSSM service blave-agent-sinopac instead
(lib/sinopac_worker.py --install, from the connect flow's finish step); the store below serves both.

Why a shim: control/updater.py's apply_jobs installs a release unit only when its ExecStart is
python3 + one flat module in /opt/blave-agent/current/ (the root boundary), and lib/sinopac_worker.py
lives in the workspace. It execs the worker (no python layer left above it): systemd's SIGTERM
reaches the worker, whose handler unwinds through the finally that logs out.

How it starts: blave-agent-sinopac.timer starts the service every two
minutes and after boot; starting a running service does nothing. jobs.json enables the timer only
while venue_traits opens 永豐 futures (the gate-flip commit sets both; tests/check_sinopac_local.py §9). The agent user has no sudo for
this unit, so nothing else can. While the worker is not wanted this exits 0 at once, and
Restart=on-failure leaves it down until the next tick. The worker's own non-zero exits (STOP,
gate shut, state not writable, a crash) are restarted RestartSec later and land here again: STOP
and a shut gate then stay down; login spacing across restarts is the worker's (its login record).

Wanted = the futures gate open (venue_traits verified_modes), 永豐 bound through the connect flow
(the four `vault:` sentinels in .env — plain values, as a 零股 bind left them, never start it), and
no STOP record (a failed login stays stopped until the user confirms one). The desktop's supervisor
(runtime/sinopac_local.py) asks the same wanted(), plus "the app handed the credentials over".

Credential store (= lib/sinopac_vault, which the worker resolves through; the 統一 shape): the API
key, secret, CA password and national id are never written to .env. store() puts the certificate
at <base>/credentials/sinopac.pfx and, on a cloud box, the four values in sinopac_vault.json beside
it (Windows: SYSTEM + Administrators; Linux: 0600 to the one machine user the agent shares — out of
.env and the agent's ordinary paths, not a wall); on the desktop they stay in the app's encrypted
store and reach the worker only as its stdin line (runtime/sinopac_local). .env gets the sentinels
through command_listener._cmd_credentials, which refuses any 永豐 write store() did not stage
(bind_gate): a chat bind or a plain `credentials` command cannot bind 永豐. drop() on unbind.

Import-safety: the updater's health check imports every runtime module on every tick — nothing
runs at import.
"""
import hashlib
import json
import os
import subprocess
import sys

import atomic_file
import venue_traits

WORKSPACE = os.environ.get("BLAVE_AGENT_WORKSPACE", "/opt/blave-agent/workspace")
VENUE = "sinopac"
WORKER = os.path.join("lib", "sinopac_worker.py")
LOGIN_STOPPED = os.path.join("state", "sinopac_login_stopped.json")  # = lib/sinopac_vault.LOGIN_STOPPED_PATH
# written by the connect flow's last step (sinopac_connect.run_finish), gone on a rebind or an unbind:
# a bound machine runs no worker until its login passed, so a not-yet-signed account mid-connect never
# turns into a worker's login STOP and its P1
WANTED = os.path.join("state", "sinopac_worker_wanted.json")
# = lib/sinopac_vault.SECRETS / PW_PREFIX (names locked, lowercase; the worker reads exactly these)
SECRETS = ("sinopac_api_key", "sinopac_secret_key", "sinopac_ca_passwd", "sinopac_person_id")
PW_PREFIX = "vault:"
IS_WINDOWS = os.name == "nt"
_PENDING = {"env": None}  # the .env lines store() is writing right now (bind_gate)


def fingerprint(api_key, secret_key):
    """= lib/sinopac_vault.fingerprint (tests/check_sinopac_local.py compares the two)."""
    return hashlib.sha256(f"sinopac-vault-v1\0{api_key}\0{secret_key}".encode()).hexdigest()[:16]


def paths(workspace=None):
    ws = workspace or WORKSPACE
    cred = os.path.join(os.path.dirname(ws), "credentials")
    return {"cred": cred, "vault": os.path.join(cred, "sinopac_vault.json"),
            "pfx": os.path.join(cred, "sinopac.pfx"), "env": os.path.join(ws, ".env"),
            "state": os.path.join(ws, "state"), "worker": os.path.join(ws, WORKER)}


def bound_env(api_key, secret_key, workspace=None):
    """= lib/sinopac_vault.bound_env: the lines a connect-flow bind writes."""
    return {"sinopac_api_key": PW_PREFIX + fingerprint(api_key, secret_key),
            "sinopac_secret_key": PW_PREFIX + "secret", "sinopac_ca_passwd": PW_PREFIX + "ca",
            "sinopac_person_id": PW_PREFIX + "id", "sinopac_ca_path": paths(workspace)["pfx"]}


def env_values(workspace):
    """{name (casefolded): value} of .env; FileNotFoundError / OSError / ValueError pass through."""
    out = {}
    for line in atomic_file.read_bytes(os.path.join(workspace, ".env")).decode("utf-8").splitlines():
        k, sep, v = line.strip().partition("=")
        if sep and not k.startswith("#"):
            out[k.strip().casefold()] = v.strip().strip("'\"")
    return out


def bound(workspace):
    """True: the four sentinels the connect flow writes are in .env. Plain values (a 零股 bind from
    before the store) or none = False; an .env that cannot be read (Windows mid-replace past the
    retries, a decode error) = None: unknown, nothing started and nothing stopped on it."""
    try:
        env = env_values(workspace)
    except FileNotFoundError:
        return False
    except (OSError, ValueError):
        return None
    return all(str(env.get(k) or "").startswith(PW_PREFIX) for k in SECRETS)


def bind_gate(env):
    """command_listener._cmd_credentials, every mode, venue SINOPAC: written only by store(), for
    exactly the lines it staged. Raises ValueError otherwise (nothing written)."""
    want = _PENDING["env"]
    got = {k.casefold(): v for k, v in env.items()}
    if not want or got != want:
        raise ValueError("永豐期貨只能從連接帳戶的流程綁定 (SinoPac is bound from the connect flow only)")


def _write_private(path, data):
    """bytes → path: Windows cloud SYSTEM + Administrators (ACL before the rename, as
    president_connect), POSIX 0600. The folder is created 0700."""
    os.makedirs(os.path.dirname(path), mode=0o700, exist_ok=True)
    prepare = None
    if IS_WINDOWS and os.environ.get("BLAVE_AGENT_LOCAL") != "1":
        import capital_connect as cc
        cc._restrict_dir(os.path.dirname(path))

        def prepare(tmp):  # a failed ACL refuses the write
            cc._icacls(tmp, "/inheritance:r", "/grant:r", "*S-1-5-18:F", "*S-1-5-32-544:F")
    with atomic_file.replacing(path, "wb", perm=0o600, prepare=prepare) as f:
        f.write(data)


def store(bundle, pfx, local=False, workspace=None):
    """Bind 永豐 from a checked bundle {api_key, secret_key, person_id, ca_password, live} and the
    certificate bytes (opened with the CA password by the caller, before this). Certificate (and on
    a cloud box the vault) first, then .env through _cmd_credentials; a failure there drops the
    files again, leaving the machine unbound."""
    p = paths(workspace)
    try:  # a rebind starts the connect flow over: no worker until its login passed again
        os.remove(os.path.join(os.path.dirname(p["state"]), WANTED))
    except FileNotFoundError:
        pass
    _write_private(p["pfx"], pfx)
    try:
        if not local:
            doc = {"sinopac_api_key": bundle["api_key"], "sinopac_secret_key": bundle["secret_key"],
                   "sinopac_ca_passwd": bundle["ca_password"] or bundle["person_id"],
                   "sinopac_person_id": bundle["person_id"], "live": bundle["live"] is True}
            _write_private(p["vault"], json.dumps(doc).encode("utf-8"))
        env = bound_env(bundle["api_key"], bundle["secret_key"], workspace)
        import command_listener
        _PENDING["env"] = env
        try:
            command_listener._cmd_credentials({"env": env})
        finally:
            _PENDING["env"] = None
    except BaseException:
        _drop_files(p)
        raise


def _drop_files(p):
    for path in (p["vault"], p["pfx"], os.path.join(os.path.dirname(p["state"]), WANTED),
                 os.path.join(p["state"], "sinopac_login_stopped.json"),
                 os.path.join(p["state"], "sinopac_login_retry.json"),
                 os.path.join(p["state"], "sinopac_probe.json")):
        try:
            os.remove(path)
        except FileNotFoundError:
            pass
        except OSError as e:
            print(f"[sinopac_service] {os.path.basename(path)} not removed ({type(e).__name__})", file=sys.stderr)


def drop(names=None, workspace=None):
    """Unbind / eviction: vault, certificate, the STOP / retry / probe records (a rebind must not
    start stopped). The futures-enabled marker stays (venue_traits bound_marker). The worker leaves
    by itself once .env loses its sentinel (lib/sinopac_worker); a Windows cloud service is removed.
    `names` (credentials_remove): only when they are 永豐's."""
    if names is not None and not any(str(n).casefold().startswith("sinopac_") for n in names):
        return
    p = paths(workspace)
    _drop_files(p)
    # the connect flow's own files (runtime/sinopac_connect): a reconnect starts from the form
    for path in (os.path.join(p["state"], "sinopac_connect.json"), os.path.join(p["state"], "sinopac_sim_test.json"),
                 os.path.join(p["cred"], "sinopac_pfx_key.json")):
        try:
            os.remove(path)
        except OSError:
            pass
    if IS_WINDOWS and os.environ.get("BLAVE_AGENT_LOCAL") != "1" and os.path.isfile(p["worker"]):
        try:  # not waited for: a stopping service can take a minute
            subprocess.Popen([sys.executable, p["worker"], "--uninstall"], stdin=subprocess.DEVNULL,
                             stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        except OSError as e:
            print(f"[sinopac_service] worker uninstall not started ({type(e).__name__})", file=sys.stderr)


def wanted(workspace):
    """(wanted, why not) — the one rule both platforms start the worker by. None = .env
    unreadable this time: neither start nor stop."""
    if "futures" not in venue_traits.verified_modes(VENUE):
        return False, "永豐 futures not live-verified"
    keys = bound(workspace)
    if keys is None:
        return None, ".env unreadable"
    if not keys:
        return False, "永豐 not bound through the connect flow"
    if not os.path.exists(os.path.join(workspace, WANTED)):
        return False, "永豐 connect flow not finished"
    if os.path.exists(os.path.join(workspace, LOGIN_STOPPED)):
        return False, "永豐 login stopped until the user confirms one"
    return True, None


def main():
    ok, why = wanted(WORKSPACE)
    if not ok:
        print(f"[sinopac_service] not started: {why}", flush=True)
        return 0
    os.chdir(WORKSPACE)
    os.environ["SJ_LOG_PATH"] = os.devnull  # the worker forces it too; set before anything else runs
    worker = os.path.join(WORKSPACE, WORKER)
    os.execv(sys.executable, [sys.executable, worker])


if __name__ == "__main__":
    sys.exit(main())
