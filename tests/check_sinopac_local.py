"""永豐 worker lifecycle: the cloud shim (runtime/sinopac_service.py) and the desktop supervisor
(runtime/sinopac_local.py) — real child processes running a stand-in worker, no shioaji, no login.

  1. wanted(): the shipped gate is open; shut → never, whatever .env says; open → the four connect-flow
     sentinels under the worker's exact names (plain values, as a 零股 bind left them, never),
     no STOP record. The shim exits 0 without exec'ing when not wanted.
  2. desktop, gate shut: ticks never start anything.
  3. desktop, gate open: the child gets SJ_LOG_PATH = the null device and STOP_ON_EOF; an unbind
     closes its stdin and it leaves on its own (no kill); one that ignores the close is killed only
     past STOP_GRACE_S.
  4. respawn: RESPAWN_S after an exit (SESSION_LOST_EXIT included), UNVERIFIED_RESPAWN_S after UNVERIFIED_EXIT; none while STOP.
  5. daemon shutdown asks and waits briefly, never kills; the next start's reap waits for a worker
     still logging out and kills one still there past the grace.
  6. the real worker leaves on stdin EOF when STOP_ON_EOF is set (gate shut: it exits at once, so
     this runs lib/sinopac_worker._watch_stdin directly).
  7. credentials (Wei 11-17: stored like 統一, the agent reads none of them): the store writes the
     certificate and vault 0600 and only sentinels to .env; lib/sinopac_vault resolves them back
     (cloud: the vault; desktop: the stdin line, read before the stop watch); a plain `credentials`
     write of any sinopac_* line is refused; the desktop worker starts only once the app handed the
     bundle over for this binding; unbind drops vault, certificate and STOP.

Run: cd blave-agent && .venv/bin/python tests/check_sinopac_local.py
"""
import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import types

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
# the workspace one level down: the credential store sits beside it (<base>/credentials), inside this temp dir
BASE = tempfile.mkdtemp(prefix="sinopac-local-")
WS = os.path.join(BASE, "workspace")
os.makedirs(os.path.join(WS, "lib"))
os.makedirs(os.path.join(WS, "state"))
os.environ["BLAVE_AGENT_WORKSPACE"] = WS
sys.path.insert(0, os.path.join(ROOT, "runtime"))

fails = 0


def check(cond, msg, detail=None):
    global fails
    print(("ok   " if cond else "FAIL ") + msg + ("" if cond or detail is None else f"  {detail}"))
    fails += 0 if cond else 1


# command_listener stand-in: the two helpers the supervisor takes from it
cl = types.ModuleType("command_listener")
cl._local_child_env = lambda **extra: dict(os.environ, **extra)
cl._child_kw = lambda **kw: dict({"stdin": subprocess.DEVNULL}, **kw)
sys.modules["command_listener"] = cl

import sinopac_local as sl  # noqa: E402
import sinopac_service as svc  # noqa: E402

sl.WORKSPACE = svc.WORKSPACE = WS
ENV = os.path.join(WS, ".env")
STOP = os.path.join(WS, svc.LOGIN_STOPPED)
OUT = os.path.join(WS, "state", "standin.txt")

# the stand-in worker: records its environment, then MODE decides: "eof" leaves on stdin EOF,
# "deaf" ignores it, "exit:<rc>" leaves at once with that code
STANDIN = r'''
import os, sys, time
mode = open(os.path.join(os.path.dirname(__file__), "mode")).read().strip()
out = os.path.join(os.path.dirname(os.path.dirname(__file__)), "state", "standin.txt")
with open(out, "a") as f:
    f.write(f"start SJ_LOG_PATH={os.environ.get('SJ_LOG_PATH')} EOF={os.environ.get('BLAVE_SINOPAC_STOP_ON_EOF')}\n")
if os.environ.get("BLAVE_SINOPAC_STDIN") == "1":
    first = b""
    while not first.endswith(b"\n"):
        b = os.read(0, 1)
        if not b:
            break
        first += b
    with open(out, "a") as f:
        f.write("line " + ("ok" if b'"sinopac_person_id"' in first else "missing") + "\n")
if mode.startswith("exit:"):
    sys.exit(int(mode[5:]))
if mode == "eof":
    while os.read(0, 4096):
        pass
    with open(out, "a") as f:
        f.write("left on eof\n")
    sys.exit(0)
while True:
    time.sleep(0.2)
'''
with open(os.path.join(WS, "lib", "sinopac_worker.py"), "w") as f:
    f.write(STANDIN)


def mode(m):
    with open(os.path.join(WS, "lib", "mode"), "w") as f:
        f.write(m)


def lines():
    try:
        return open(OUT).read().splitlines()
    except FileNotFoundError:
        return []


BUNDLE = {"api_key": "k", "secret_key": "s", "person_id": "A123456789", "ca_password": "", "live": True}
SENTINELS = "".join(f"{k}={v}\n" for k, v in svc.bound_env("k", "s", WS).items())


def bind(text=SENTINELS, wanted=True):
    """.env as given; the connect flow's finish marker too (sinopac_service.WANTED) unless wanted=False."""
    with open(ENV, "w") as f:
        f.write(text)
    marker = os.path.join(WS, svc.WANTED)
    if wanted:
        open(marker, "w").close()
    elif os.path.exists(marker):
        os.remove(marker)


def starts():
    return [x for x in lines() if x.startswith("start")]


def wait_exit(p, s=5.0):
    t = time.time() + s
    while p.poll() is None and time.time() < t:
        time.sleep(0.05)
    return p.poll()


real_modes = svc.venue_traits.verified_modes
gate = {"open": False}
svc.venue_traits.verified_modes = lambda v: (("futures",) if gate["open"] else ()) if v == "sinopac" else real_modes(v)

# ── 1. wanted() ──
bind()
check(real_modes("sinopac") == ("futures",), "1 the shipped gate is open")
check(svc.wanted(WS)[0] is False, "1 gate shut: not wanted even when bound")
gate["open"] = True
check(svc.wanted(WS) == (True, None), "1 gate open + bound through the connect flow + finished + no STOP → wanted")
bind(wanted=False)
check(svc.wanted(WS)[0] is False,
      "1 bound but the connect flow not finished (no login passed yet): not wanted — a not-yet-signed account "
      "mid-connect never becomes a worker STOP and its P1")
bind()
for text, why in (("sinopac_api_key=k\nsinopac_secret_key=s\n", "plain keys (a 零股 bind) — never a futures worker"),
                  (SENTINELS.replace("sinopac_person_id=vault:id\n", ""), "a sentinel missing"),
                  (SENTINELS.replace("sinopac_secret_key=vault:secret", "sinopac_secret_key=s"), "a plain value"),
                  (SENTINELS.replace("#", "").replace("sinopac_api_key=", "#sinopac_api_key="), "commented out")):
    bind(text)
    check(svc.wanted(WS)[0] is False, f"1 not wanted: {why}")
os.remove(ENV)
check(svc.wanted(WS)[0] is False, "1 not wanted: no .env")
with open(ENV, "wb") as f:
    f.write(b"sinopac_api_key=\xff\xfe\n")
check(svc.wanted(WS)[0] is None, "1 an unreadable .env is unknown (None): neither start nor stop")
bind()
open(STOP, "w").close()
check(svc.wanted(WS)[0] is False, "1 not wanted: a STOP record (the user has to confirm a login)")
os.remove(STOP)
# the shim as systemd runs it (its own process, the shipped gate open; the connect flow not
# finished): exits 0 without exec'ing — a stand-in that exits 7 would show
mode("exit:7")
gate["open"] = False
bind(wanted=False)
r = subprocess.run([sys.executable, os.path.join(ROOT, "runtime", "sinopac_service.py")], capture_output=True,
                   timeout=30, env=dict(os.environ, BLAVE_AGENT_WORKSPACE=WS))
check(r.returncode == 0 and not lines(), "1 shim: not wanted → exit 0, worker never started",
      (r.returncode, lines(), r.stderr.decode()[-200:]))
check(b"not started" in r.stdout, "1 shim: a bound machine's reason is logged", r.stdout[-200:])
os.remove(ENV)
r = subprocess.run([sys.executable, os.path.join(ROOT, "runtime", "sinopac_service.py")], capture_output=True,
                   timeout=30, env=dict(os.environ, BLAVE_AGENT_WORKSPACE=WS))
check(r.returncode == 0 and not r.stdout and not r.stderr and not lines(),
      "1 shim: never bound (most machines, the timer every 2 minutes) → exit 0 without a log line",
      (r.returncode, r.stdout[-200:], r.stderr[-200:]))
bind()

# ── 2. desktop, gate shut ──
w = sl._Worker()
now = time.time()
for i in range(5):
    w.tick(now + i * sl.WANTED_EVERY_S)
check(w.proc is None and not lines(), "2 gate shut: no tick starts the worker")

# ── 3. gate open: start, environment, unbind → graceful leave ──
gate["open"] = True
mode("eof")
w = sl._Worker()
w.tick(now)
check(w.proc is None and not lines(), "3 gate open + bound, but the app handed nothing over → not started")
sl._set_secrets(BUNDLE)
w.check_at = 0.0
w.tick(now)
p = w.proc
time.sleep(0.5)
check(p is not None and p.poll() is None
      and lines() == [f"start SJ_LOG_PATH={os.devnull} EOF=1", "line ok"],
      "3 …handed over → started; SJ_LOG_PATH = the null device, STOP_ON_EOF set, credentials as the first "
      "stdin line", lines())
check(open(os.path.join(WS, "state", "sinopac_worker.pid")).read().strip() == str(p.pid), "3 pid file written")
_real_W, sl._W = sl._W, w
_info = sl.local_info()
sl._W = _real_W
check(_info.get("worker_running") is True and isinstance(_info.get("worker_started_at"), float)
      and abs(_info["worker_started_at"] - time.time()) < 30 and sl.local_info().get("worker_started_at") is None,
      "3 the status doc carries the running worker's spawn time (the app's 連接中… grace after a reopen); none when "
      "no worker runs", _info)
w.tick(now + 1)
check(w.proc is p, "3 a running worker is not started twice")
with open(ENV, "wb") as f:
    f.write(b"\xff\xfe")
w.tick(now + sl.WANTED_EVERY_S - 0.5)
w.tick(now + 2 * sl.WANTED_EVERY_S - 0.5)
check(w.stop_by is None and p.poll() is None, "3 an unreadable .env (mid-replace) does not stop it")
bind()
w.check_at = 0.0  # the next tick checks again
bind("other_key=x\n")
w.tick(now + sl.WANTED_EVERY_S)
rc = wait_exit(p)
check(rc == 0 and lines()[-1] == "left on eof" and w.stop_by is not None,
      "3 unbind → stdin closed → the worker leaves by itself (its finally runs: no kill)", (rc, lines()))
w.tick(now + sl.WANTED_EVERY_S + 1)
check(w.proc is None and w.stop_by is None and not os.path.exists(os.path.join(WS, "state", "sinopac_worker.pid")),
      "3 the exit is reaped, pid file gone")
# a worker that ignores the close is killed only past STOP_GRACE_S
bind()
mode("deaf")
os.remove(OUT)
w = sl._Worker()
w.tick(now)
p = w.proc
time.sleep(0.3)
bind("other_key=x\n")
w.tick(now + sl.WANTED_EVERY_S)
w.tick(now + sl.WANTED_EVERY_S + sl.STOP_GRACE_S - 1)
time.sleep(0.3)
alive_in_grace = p.poll() is None
w.tick(now + sl.WANTED_EVERY_S + sl.STOP_GRACE_S)
check(alive_in_grace and wait_exit(p) is not None,
      "3 a worker that ignores the close: left alone inside STOP_GRACE_S, killed past it")

# ── 4. respawn spacing ──
bind()
# 7 = lib/sinopac_worker.SESSION_LOST_EXIT (a session gone after a good login): restarted like a crash
for rc_, gap in ((1, sl.RESPAWN_S), (5, sl.RESPAWN_S), (7, sl.RESPAWN_S), (4, sl.UNVERIFIED_RESPAWN_S)):
    mode(f"exit:{rc_}")
    w = sl._Worker()
    w.tick(now)
    wait_exit(w.proc)
    n0 = len(starts())
    w.tick(now + 1)       # sees the exit
    w.tick(now + 1 + sl.WANTED_EVERY_S)
    early = len(starts()) == n0 and w.proc is None
    w.tick(now + 1 + gap)
    late = w.proc is not None
    if w.proc is not None:
        wait_exit(w.proc)
    check(early and late, f"4 exit {rc_}: not restarted before {gap}s, restarted at {gap}s", (early, late))
mode("exit:3")
w = sl._Worker()
w.tick(now)
wait_exit(w.proc)
open(STOP, "w").close()  # the worker's login failed: it wrote STOP and exited 3
w.tick(now + 1)
w.tick(now + 1 + sl.RESPAWN_S + sl.WANTED_EVERY_S)
check(w.proc is None, "4 a STOP record keeps it down (until the user's confirmed login clears it)")
os.remove(STOP)
w.tick(now + 1 + sl.RESPAWN_S + 2 * sl.WANTED_EVERY_S)
check(w.proc is not None, "4 …and STOP cleared → started again")
wait_exit(w.proc)

# ── 5. daemon shutdown and the next start's reap ──
mode("deaf")
w = sl._Worker()
w.tick(now)
p = w.proc
time.sleep(0.3)
t0 = time.time()
w.shutdown(wait=0.3)
time.sleep(0.5)  # a kill would have landed by now
check(p.poll() is None and time.time() - t0 < 2 and w.proc is None
      and os.path.exists(os.path.join(WS, "state", "sinopac_worker.pid")),
      "5 shutdown asks and returns within its short wait, never kills (the reconciler's stop comes next); "
      "the pid file stays for the reap")
cmdline = lambda pid: (f"{sys.executable} {os.path.join(WS, 'lib', 'sinopac_worker.py')}"  # noqa: E731
                       if pid == p.pid and p.poll() is None else "")
t0 = time.time()
sl._Worker().reap_orphan(cmdline, grace=0.6)
check(wait_exit(p) is not None and time.time() - t0 >= 0.5,
      "5 reap: a worker still there past the grace is killed")
mode("eof")
w = sl._Worker()
w.tick(now)
p = w.proc
time.sleep(0.3)
p.stdin.close()   # its daemon died: the pipe closed with it
t0 = time.time()
sl._Worker().reap_orphan(cmdline, grace=5)
check(p.poll() == 0 and lines()[-1] == "left on eof" and time.time() - t0 < 4,
      "5 reap: an orphan logging out on its own is waited for, not killed", lines()[-1:])

# ── 6. the real worker's stdin watch ──
probe = r'''
import os, sys
sys.path.insert(0, sys.argv[1])
os.environ["BLAVE_SINOPAC_STOP_ON_EOF"] = sys.argv[2]
from lib import sinopac_worker as w
w._watch_stdin()
print("stop" if w._STOP.wait(3) else "no stop", flush=True)
'''
for flag, want in (("1", "stop"), ("0", "no stop")):
    r = subprocess.run([sys.executable, "-c", probe, ROOT, flag], input=b"", capture_output=True, timeout=30,
                       cwd=WS, env=dict(os.environ, BLAVE_AGENT_HOME=WS, BLAVECLAW_HOME=WS))
    check(r.stdout.decode().strip().endswith(want),
          f"6 lib/sinopac_worker: stdin EOF with STOP_ON_EOF={flag} → {want}", r.stderr.decode()[-300:])

# ── 7. credentials: store, resolve, gate, unbind ──
sys.path.insert(0, ROOT)
from lib import sinopac_vault as sv  # noqa: E402

check(svc.fingerprint("k", "s") == sv.fingerprint("k", "s") and svc.SECRETS == sv.SECRETS
      and svc.PW_PREFIX == sv.PW_PREFIX,
      "7 runtime/sinopac_service and lib/sinopac_vault agree on the sentinel scheme")
staged = []


def _fake_credentials(args):
    svc.bind_gate(args["env"])
    staged.append(args["env"])
    # the real _cmd_credentials writes .env only: the finish marker stays as store() left it
    bind("".join(f"{k}={v}\n" for k, v in args["env"].items()), wanted=os.path.exists(os.path.join(WS, svc.WANTED)))


cl._cmd_credentials = _fake_credentials
P = svc.paths(WS)
check(P["cred"] == os.path.join(BASE, "credentials"), "7 (the store under test lives in this test's temp dir)")
os.remove(ENV)
svc.store(BUNDLE, b"PFXBYTES", local=False, workspace=WS)
env_text = open(ENV).read()
vault = json.load(open(P["vault"]))
check(not any(x in env_text for x in ("A123456789", "=k\n", "=s\n"))
      and all(f"{k}=vault:" in env_text for k in svc.SECRETS) and f"sinopac_ca_path={P['pfx']}" in env_text,
      "7 cloud store: .env holds sentinels and the certificate path, none of the four values", env_text)
check(open(P["pfx"], "rb").read() == b"PFXBYTES" and os.stat(P["pfx"]).st_mode & 0o077 == 0
      and os.stat(P["vault"]).st_mode & 0o077 == 0 and os.stat(P["cred"]).st_mode & 0o077 == 0
      and vault["sinopac_ca_passwd"] == "A123456789" and vault["live"] is True,
      "7 …certificate and vault 0600 in a 0700 folder outside the workspace; an empty CA password is the "
      "national id (M0-a)", oct(os.stat(P["vault"]).st_mode))
sv.VAULT, sv.PFX = P["vault"], P["pfx"]
c = sv.resolve(svc.env_values(WS))
check(c == {"sinopac_api_key": "k", "sinopac_secret_key": "s", "sinopac_ca_passwd": "A123456789",
            "sinopac_person_id": "A123456789", "sinopac_ca_path": P["pfx"], "live": True},
      "7 lib/sinopac_vault.resolve gives the worker its login from the vault", c)
for env, why, exc in (({"sinopac_api_key": "k", "sinopac_secret_key": "s"}, "plain values (零股 / agent-written)", sv.NotBound),
                      (dict(svc.env_values(WS), sinopac_api_key="vault:0000000000000000"), "another binding's sentinel",
                       ValueError)):
    try:
        sv.resolve(env)
        got = None
    except Exception as e:
        got = e
    check(isinstance(got, exc), f"7 resolve refuses {why}", got)
check(sv.resolve(dict(svc.env_values(WS), sinopac_live="false"))["live"] is True,
      "7 a leftover sinopac_live line (an old 零股 bind) is ignored: production is the vault's (audit r2 S1)")
for env, why in (({"sinopac_api_key": "k", "sinopac_secret_key": "s"}, "plain keys"),
                 (svc.bound_env("k", "s", WS), "the sentinels, not staged by store()"),
                 ({"SINOPAC_PERSON_ID": "A123456789"}, "a national id in any case")):
    try:
        svc.bind_gate(env)
        refused = False
    except ValueError:
        refused = True
    check(refused, f"7 a credentials write outside store() is refused: {why}")
# desktop: nothing on disk but the certificate; the line is read first, the rest of stdin stays
os.remove(P["vault"])
svc.store(BUNDLE, b"PFXBYTES", local=True, workspace=WS)
check(not os.path.exists(P["vault"]) and os.path.exists(P["pfx"]), "7 desktop store: no vault file, the certificate only")
probe = r'''
import json, os, sys
sys.path.insert(0, sys.argv[1])
from lib import sinopac_vault as sv
sv.VAULT, sv.PFX = sys.argv[2], sys.argv[3]
c = sv.resolve(json.loads(sys.argv[4]))
rest = os.read(0, 100)
print(json.dumps([c["sinopac_person_id"], c["live"], rest.decode()]))
'''
line = sl.secret_line() + "\nREST"
r = subprocess.run([sys.executable, "-c", probe, ROOT, P["vault"], P["pfx"], json.dumps(svc.env_values(WS))],
                   input=line.encode(), capture_output=True, timeout=30, cwd=WS,
                   env=dict(os.environ, BLAVE_SINOPAC_STDIN="1", BLAVE_SINOPAC_LOCAL="1"))
check(r.stdout.decode().strip() == json.dumps(["A123456789", True, "REST"]),
      "7 desktop: the worker resolves from its first stdin line, byte by byte — the rest stays for the "
      "stop-on-EOF watch", (r.stdout.decode(), r.stderr.decode()[-300:]))
r = subprocess.run([sys.executable, "-c", probe, ROOT, P["vault"], P["pfx"], json.dumps(svc.env_values(WS))],
                   input=b"", capture_output=True, timeout=30, cwd=WS,
                   env=dict(os.environ, BLAVE_SINOPAC_STDIN="1", BLAVE_SINOPAC_LOCAL="1"))
check("NotHandedOver" in r.stderr.decode(), "7 desktop with nothing handed over: NotHandedOver (no login, no STOP)",
      r.stderr.decode()[-300:])
# the desktop worker follows the handover: a bundle for another binding starts nothing
mode("deaf")
w = sl._Worker()
sl._set_secrets(dict(BUNDLE, api_key="other"))
w.tick(now)
check(w.proc is None, "7 desktop: a handed-over bundle for another binding starts nothing")
sl._set_secrets(BUNDLE)
# unbind: vault, certificate, STOP / retry records go (a rebind must not start stopped); the marker stays
svc.store(BUNDLE, b"PFXBYTES", local=False, workspace=WS)
for f in ("sinopac_login_stopped.json", "sinopac_login_retry.json", "sinopac_futures_enabled.json"):
    open(os.path.join(WS, "state", f), "w").close()
sl.drop_local(["sinopac_api_key"])
svc.drop(["sinopac_api_key"], workspace=WS)
left = sorted(f for f in ("sinopac_login_stopped.json", "sinopac_login_retry.json", "sinopac_futures_enabled.json")
              if os.path.exists(os.path.join(WS, "state", f)))
check(not os.path.exists(P["vault"]) and not os.path.exists(P["pfx"]) and sl.secret_line() == ""
      and left == ["sinopac_futures_enabled.json"],
      "7 unbind: vault, certificate, the handed-over bundle and the STOP / retry records go; the "
      "futures-enabled marker stays", left)
svc.drop(["binance_api_key"], workspace=WS)  # another venue's unbind touches nothing of ours

# ── 8. connect steps (runtime/sinopac_connect): one-field certificate password, probe classes,
#       NOT_SIGNED as the only way into the simulation step, the simulation window, the desktop's
#       confirm-login handing the credentials over stdin ──
import sinopac_connect as sc  # noqa: E402

sc.WORKSPACE = WS
from cryptography import x509 as _x509  # noqa: E402
from cryptography.hazmat.primitives import hashes as _h, serialization as _ser  # noqa: E402
from cryptography.hazmat.primitives.asymmetric import rsa as _rsa  # noqa: E402
from cryptography.hazmat.primitives.serialization import pkcs12 as _p12  # noqa: E402
import datetime as _dt  # noqa: E402


def make_pfx(password):
    k = _rsa.generate_private_key(public_exponent=65537, key_size=2048)
    name = _x509.Name([_x509.NameAttribute(_x509.NameOID.COMMON_NAME, "test")])
    now = _dt.datetime.now(_dt.timezone.utc)
    cert = (_x509.CertificateBuilder().subject_name(name).issuer_name(name).public_key(k.public_key())
            .serial_number(1).not_valid_before(now - _dt.timedelta(days=1)).not_valid_after(now + _dt.timedelta(days=30))
            .sign(k, _h.SHA256()))
    return _p12.serialize_key_and_certificates(b"t", k, cert, None,
                                               _ser.BestAvailableEncryption(password.encode()))


def code_of(fn):
    try:
        fn()
    except ValueError as e:
        return sc.cc._code(e, "?")
    return None


B1 = dict(BUNDLE, ca_password="")
pfx_id = make_pfx("A123456789")
pfx_other = make_pfx("other-pw")
meta, pw = sc.open_pfx(pfx_id, B1)
check(pw == "A123456789" and meta.get("not_after"),
      "8 one field: no separate CA password → the national id opens the certificate (Wei 11-17)")
check(code_of(lambda: sc.open_pfx(pfx_other, B1)) == "PFX_PASSWORD"
      and (sc.read_status() or {}).get("cert", {}).get("ca_password_asked") is True,
      "8 …a certificate the national id does not open: PFX_PASSWORD and the page is told to ask for the "
      "separate password", sc.read_status())
check(sc.open_pfx(pfx_other, dict(B1, ca_password="other-pw"))[1] == "other-pw"
      and code_of(lambda: sc.open_pfx(pfx_other, dict(B1, ca_password="wrong"))) == "PFX_PASSWORD",
      "8 …the separate password opens it; a wrong one is PFX_PASSWORD")
check(code_of(lambda: sc.open_pfx(b"not a pfx", B1)) == "PFX_INVALID", "8 not a certificate → PFX_INVALID")
# probe classes; NOT_SIGNED alone opens the simulation step
_states = {r: sc.probe_state({"ok": False, "reason": r, "read_at": 1000}, 2)["state"] for r in sc.LOGIN_STATES}
check(_states == {"KEY": "key", "NO_FUTURES": "no_futures", "CERT": "cert", "TOO_MANY": "too_many",
                  "TIMEOUT": "timeout", "CLOCK": "clock", "VERSION": "version", "NOT_SIGNED": "not_signed",
                  "UNKNOWN": "unknown"}
      and sc.probe_state({"ok": False, "reason": "TOO_MANY", "read_at": 1000}, 2)["retry_at"] == 1600
      and sc.probe_state(None, None)["state"] == "timeout" and sc.probe_state(None, sc.NOT_BOUND_EXIT)["state"]
      == "no_credentials" and sc.probe_state({"ok": True, "read_at": 1}, 0)["state"] == "ok",
      "8 probe classes (designer §4); 451 carries its retry time (+10 min)", _states)
_real_run = sc._run_worker
answers = []


def _fake_run(flag, timeout, local):
    reason = answers.pop(0)
    with open(sc._paths()["probe"], "w") as f:
        json.dump({"ok": reason is None, "reason": reason, "read_at": time.time()}, f)
    return 0 if reason is None else 2


sc._run_worker = _fake_run
sims = {}
for reason in ("KEY", "CERT", "TIMEOUT", "NOT_SIGNED"):
    sc._update("sim", reset=True, status="idle")
    answers.append(reason)
    sc.run_probe()
    sims[reason] = sc.read_status()["sim"]["status"]
check(sims == {"KEY": "idle", "CERT": "idle", "TIMEOUT": "idle", "NOT_SIGNED": "ask"},
      "8 the signing step opens only on NOT_SIGNED (Wei 11-17); every other failure stays a login error", sims)
answers.append(None)
sc.run_probe()
check(sc.read_status()["sim"]["status"] == "passed" and sc.read_status()["probe"]["state"] == "ok",
      "8 a later login that reads signed passes the signing step")
sc._run_worker = _real_run
# the simulation window: weekdays 08:00–18:00 Taipei cloud, –20:00 desktop
_mon = 1763337600 - 8 * 3600  # 2025-11-17 00:00 Taipei, a Monday
check([sc.sim_window_open(False, _mon + h * 3600) for h in (7, 8, 17, 18)] == [False, True, True, False]
      and [sc.sim_window_open(True, _mon + h * 3600) for h in (18, 19, 20)] == [True, True, False]
      and not sc.sim_window_open(True, _mon + 5 * 86400 + 10 * 3600),
      "8 simulation window: weekdays 08–18 Taipei on cloud, 08–20 on the desktop, never Saturday")
# the next window: Friday 19:00 Taipei → Monday 08:00; Monday 07:00 → the same day 08:00
check(sc.next_sim_open(False, _mon + 4 * 86400 + 19 * 3600) == _mon + 7 * 86400 + 8 * 3600
      and sc.next_sim_open(True, _mon + 7 * 3600) == _mon + 8 * 3600,
      "8 sim.next_open_at: the next weekday 08:00 Taipei")
# the desktop's confirm-login: the worker gets the credentials as its first stdin line
mode("exit:0")
bind()
sl._set_secrets(BUNDLE)
n0 = len(lines())
rc = sc._run_worker("--once", 30, True)
check(rc == 0 and lines()[n0:] == [f"start SJ_LOG_PATH={os.devnull} EOF=None", "line ok"],
      "8 desktop 確認登入: the probe child gets the credentials as its first stdin line (no argv, no env)",
      (rc, lines()[n0:]))
sl._SEAL["secrets"] = None
check(code_of(lambda: sc._run_worker("--once", 30, True)) == "NO_SECRETS",
      "8 …and refuses to start one with nothing handed over")
sl._set_secrets(BUNDLE)
# sinopac_local ops: shape, gate order, one login at a time
os.environ["BLAVE_AGENT_LOCAL"] = "1"
with open(svc.paths(WS)["pfx"], "wb") as f:  # bound: sentinels (bind()) and the certificate
    f.write(pfx_id)


class _D:
    def __init__(self, fn, cleanup=None):
        self.fn, self.cleanup = fn, cleanup


import base64 as _b64m, hashlib as _hl, hmac as _hm  # noqa: E402
sl.set_seal_key("d" * 40)


def seal(d):
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    key = _hm.new(("d" * 40).encode(), sl._SEAL_INFO, _hl.sha256).digest()
    nonce = os.urandom(12)
    return _b64m.b64encode(nonce + AESGCM(key).encrypt(nonce, json.dumps(d).encode(), sl._SEAL_AAD)).decode()


refusals = {}
for args, why in (({"op": "probe", "sealed": "x"}, "probe takes no sealed"), ({"op": "nope"}, "unknown op"),
                  ({"op": "probe"}, "probe without expect"), ({"op": "sim_test"}, "sim_test without expect"),
                  ({"op": "start"}, "start without expect"),
                  ({"op": "probe", "expect": seal(dict(BUNDLE, secret_key="other"))}, "probe, stale secret"),
                  ({"op": "probe", "expect": seal(dict(BUNDLE, ca_password="other"))}, "probe, stale ca password"),
                  ({"op": "start", "expect": seal(dict(BUNDLE, person_id="B123456789"))}, "start, stale id")):
    try:
        sl.local_dispatch(args, _D)
    except sl.Refused as e:
        refusals[why] = e.code
mode("deaf")
w = sl._W
w.check_at = 0.0
w.tick(time.time())
try:
    sl.local_dispatch({"op": "probe", "expect": seal(BUNDLE)}, _D)
    refusals["worker running"] = None
except sl.Refused as e:
    refusals["worker running"] = e.code
p = w.proc
w.shutdown(wait=0.5)
if p is not None:
    p.kill()  # the stand-in ignores the close ("deaf")
    p.wait(5)
check(refusals == {"probe takes no sealed": "BAD_ARGS", "unknown op": "BAD_ARGS", "probe without expect": "BAD_ARGS",
                   "sim_test without expect": "BAD_ARGS", "start without expect": "BAD_ARGS",
                   "probe, stale secret": "SECRETS_STALE", "probe, stale ca password": "SECRETS_STALE",
                   "start, stale id": "SECRETS_STALE", "worker running": "WORKER_RUNNING"},
      "8 sinopac_local: shapes refused; the three login steps need `expect` and refuse a set other than the one "
      "this daemon holds (同統一 0.1.57); no confirm-login while the worker holds the login", refusals)
# 〔改金鑰〕: bind without src keeps the stored certificate (opened again with the new bundle's password).
# No finish marker here: the machine-side resume after a key change is section 8b
os.remove(os.path.join(WS, svc.WANTED))
staged.clear()
out = sl.local_dispatch({"op": "bind", "sealed": seal(dict(BUNDLE, api_key="k2", secret_key="s2"))}, _D)
check(out["cert"]["not_after"] and staged and staged[-1]["sinopac_api_key"] == svc.bound_env("k2", "s2", WS)["sinopac_api_key"]
      and open(svc.paths(WS)["pfx"], "rb").read() == pfx_id,
      "8 bind without src: new keys, the stored certificate kept", out)
open(svc.paths(WS)["pfx"], "wb").write(make_pfx("A123456789"))
check(code_of(lambda: sl.local_dispatch({"op": "probe", "expect": seal(BUNDLE)}, _D)) == "SECRETS_STALE",
      "8 …after the rebind, a confirm-login carrying the old set is refused, never logged in with")
d = sl.local_dispatch({"op": "probe", "expect": seal(dict(BUNDLE, api_key="k2", secret_key="s2"))}, _D)
check(isinstance(d, _D) and sc._busy.locked(), "8 …a confirm-login with the worker down is a Deferred step")
d.cleanup()

# ── 8b. a key change on a machine that had finished connecting (Wei 11-24): the daemon itself logs in
#        with the new set and, on a pass, starts the worker again through run_finish → WANTED → the
#        supervisor — nothing waits for the app's box. A refused login stays there; a first connect
#        (no WANTED) is unchanged; the app's own probe / start meanwhile are refused (one start) ──
WANTED_P = os.path.join(WS, svc.WANTED)
SNAP = sc._paths()["snapshot"]


def wait_unlocked(s=40.0):
    """Ticks the supervisor meanwhile, as the daemon's loop does (it kills a worker past STOP_GRACE_S)."""
    t = time.time() + s
    while sc._busy.locked() and time.time() < t:
        w.tick(time.time())
        time.sleep(0.1)
    return not sc._busy.locked()


probe_calls = []


on_probe = []  # a hook run inside the next probe (an unbind while it logs in)


def _fake_probe(flag, timeout, local):
    probe_calls.append({"flag": flag, "old_worker_running": w.running()})
    rc = _fake_run(flag, timeout, local)
    while on_probe:
        on_probe.pop(0)()
    return rc


def refusal(args):
    try:
        sl.local_dispatch(args, _D)
    except sl.Refused as e:
        return e.code
    except ValueError as e:  # sinopac_connect.start_step's BUSY
        return sc.cc._code(e, "?")
    return None


sc._run_worker = _fake_probe
B3 = dict(BUNDLE, api_key="k3", secret_key="s3")
# the old worker runs (the connect flow had finished with k2) and ignores the close: killed only past the
# grace, and the new login waits for that (one login per national id)
open(WANTED_P, "w").close()
real_grace = sl.STOP_GRACE_S
sl.STOP_GRACE_S = 1
mode("deaf")
w.check_at = 0.0
w.tick(time.time())
old = w.proc
check(old is not None and old.poll() is None, "8b setup: the worker of the finished connect runs")
with open(SNAP, "w") as f:  # the old key's account, fresh
    json.dump({"ok": True, "equity": 1, "read_at": time.time()}, f)
answers[:] = [None]
out = sl.local_dispatch({"op": "bind", "sealed": seal(B3)}, _D)
check(not os.path.exists(SNAP), "8b key change: the store drops the old key's snapshot (audit M1)")
with open(SNAP, "w") as f:  # what the restarted worker would write (read_at after run_finish starts)
    json.dump({"ok": True, "equity": 1, "read_at": time.time() + 120}, f)
st = sc.read_status() or {}
during = {"probe": refusal({"op": "probe", "expect": seal(B3)}), "start": refusal({"op": "start", "expect": seal(B3)}),
          "bind": refusal({"op": "bind", "sealed": seal(B3)})}
check(out["cert"]["not_after"] and st.get("busy") == sl.RESUME_STEP and sc._busy.locked(),
      "8b key change: bind answers at once and the resume holds the one 永豐 step (busy = sinopac_local:resume)", st.get("busy"))
# refused either way: the old worker still holds the login (WORKER_RUNNING) or the resume holds the step (BUSY)
check(during["probe"] in ("BUSY", "WORKER_RUNNING") and during["start"] in ("BUSY", "PROBE_NOT_OK", "WORKER_RUNNING")
      and during["bind"] == "BUSY",
      "8b …meanwhile the app's own probe / start / another bind are refused, never a second login or start", during)
check(wait_unlocked(), "8b …the resume finishes and releases the step")
sl.STOP_GRACE_S = real_grace
mode("eof")
st = sc.read_status() or {}
check(probe_calls and probe_calls[0]["flag"] == "--once" and probe_calls[0]["old_worker_running"] is False and old.poll() is not None,
      "8b …its 確認登入 runs only after the old worker left (one login per national id)", probe_calls)
check(st.get("probe", {}).get("state") == "ok" and st.get("worker", {}).get("status") == "ok" and os.path.exists(WANTED_P)
      and svc.wanted(WS)[0] is True and not st.get("busy"),
      "8b …login passed → run_finish: worker ok, WANTED back, wanted() true (box never opened)", st)
n0 = len(starts())
w.tick(time.time())  # reaps the old worker (its exit sets the respawn spacing, RESPAWN_S — inside run_finish's wait)
w.check_at = 0.0
w.respawn_at = 0.0
w.tick(time.time())
t_end = time.time() + 5
while len(starts()) < n0 + 1 and time.time() < t_end:  # the stand-in writes its line once it runs
    time.sleep(0.05)
check(w.running() and len(starts()) == n0 + 1, "8b …and the supervisor starts the worker once the respawn spacing passed", starts()[n0:])
check(refusal({"op": "start", "expect": seal(B3)}) == "WORKER_RUNNING",
      "8b …an app's start after that is refused: the worker already holds the login (idempotent)")
p = w.proc
w.shutdown(wait=2)
wait_exit(p)
time.sleep(0.2)
# a refused login (KEY): stays on that row, the worker not wanted
probe_calls.clear()
answers[:] = ["KEY"]
open(WANTED_P, "w").close()
B4 = dict(BUNDLE, api_key="k4", secret_key="s4")
sl.local_dispatch({"op": "bind", "sealed": seal(B4)}, _D)
check(wait_unlocked(), "8b refused login: the resume ends")
st = sc.read_status() or {}
w.check_at = 0.0
w.respawn_at = 0.0
n0 = len(starts())
w.tick(time.time())
check(st.get("probe", {}).get("status") == "failed" and st.get("probe", {}).get("state") == "key"
      and st.get("worker", {}).get("status") == "idle" and not os.path.exists(WANTED_P) and not w.running()
      and len(starts()) == n0 and len(probe_calls) == 1,
      "8b …KEY: probe.state key, worker idle, no WANTED, the supervisor starts nothing",
      (os.path.exists(WANTED_P), w.running(), len(starts()), n0, probe_calls))
# a first connect (no WANTED): bind only, as before — the box walks setup / sign / start
probe_calls.clear()
answers[:] = []
sl.local_dispatch({"op": "bind", "sealed": seal(dict(BUNDLE, api_key="k5", secret_key="s5"))}, _D)
time.sleep(0.5)
st = sc.read_status() or {}
check(not sc._busy.locked() and not st.get("busy") and probe_calls == [] and st.get("probe", {}).get("status") == "idle"
      and not os.path.exists(WANTED_P),
      "8b first connect: no login, no start, nothing held — unchanged", (probe_calls, st))


def rekey(n):
    """A finished connect (WANTED), then a key change to k<n>."""
    open(WANTED_P, "w").close()
    probe_calls.clear()
    sl.local_dispatch({"op": "bind", "sealed": seal(dict(BUNDLE, api_key=f"k{n}", secret_key=f"s{n}"))}, _D)


def unbind():
    sl.drop_local(None)
    svc.drop(workspace=WS)


# the old worker ignores the close and is never killed within RESUME_WAIT_S: no login beside it, the step let go
real_wait, real_grace = sl.RESUME_WAIT_S, sl.STOP_GRACE_S
sl.RESUME_WAIT_S, sl.STOP_GRACE_S = 1, 999
mode("deaf")
open(WANTED_P, "w").close()
sl._set_secrets(dict(BUNDLE, api_key="k5", secret_key="s5"))
w.check_at, w.respawn_at = 0.0, 0.0
w.tick(time.time())
stuck = w.proc
answers[:] = [None]
rekey(6)
t_end = time.time() + 10
while sc._busy.locked() and time.time() < t_end:  # no ticks: nothing kills it
    time.sleep(0.1)
st = sc.read_status() or {}
check(stuck is not None and stuck.poll() is None and probe_calls == [] and not sc._busy.locked() and not st.get("busy")
      and not os.path.exists(WANTED_P) and st.get("probe", {}).get("status") == "idle",
      "8b the old worker still there past RESUME_WAIT_S: no login beside it, the step released, nothing wanted", (probe_calls, st))
stuck.kill()
stuck.wait(5)
w.tick(time.time())
sl.RESUME_WAIT_S, sl.STOP_GRACE_S = real_wait, real_grace
mode("eof")
# a login that got no answer is tried once more (no loop); a 451 after its retry_at
real_retry, real_451 = sl.RESUME_RETRY_S, sc.LOGIN_451_WAIT_S
sl.RESUME_RETRY_S, sc.LOGIN_451_WAIT_S = 0.3, 2
answers[:] = ["TIMEOUT", None]


def _new_key_snapshot():  # the restarted worker's first read (the store dropped the old key's)
    with open(SNAP, "w") as f:
        json.dump({"ok": True, "equity": 1, "read_at": time.time() + 120}, f)


on_probe.append(_new_key_snapshot)
rekey(7)
check(wait_unlocked(), "8b TIMEOUT: the resume ends")
st = sc.read_status() or {}
check(len(probe_calls) == 2 and st.get("probe", {}).get("state") == "ok" and st.get("worker", {}).get("status") == "ok" and os.path.exists(WANTED_P),
      "8b …TIMEOUT then a pass: one more login, then the worker is wanted again", (probe_calls, st))
answers[:] = ["TOO_MANY", "TOO_MANY", None]
t0 = time.time()
rekey(8)
check(wait_unlocked(), "8b 451 twice: the resume ends")
st = sc.read_status() or {}
check(len(probe_calls) == 2 and answers == [None] and time.time() - t0 >= 0.9 and st.get("probe", {}).get("state") == "too_many"
      and st.get("worker", {}).get("status") == "idle" and not os.path.exists(WANTED_P),
      "8b …451: once more after its retry_at (no loop); still 451 → stays on that row, nothing wanted", (probe_calls, answers, st))
# an unbind while the resume logs in, or while it waits to try again: no WANTED left, the step let go at once
def unbind_mid_login():
    unbind()  # drop() also takes the probe file: the login's answer lands after it (a pass)
    with open(sc._paths()["probe"], "w") as f:
        json.dump({"ok": True, "reason": None, "read_at": time.time()}, f)


answers[:] = [None]
on_probe.append(unbind_mid_login)
rekey(9)
check(wait_unlocked(), "8b unbind mid-login: the resume ends")
check(len(probe_calls) == 1 and (sc.read_status() or {}).get("probe", {}).get("state") == "ok" and not os.path.exists(WANTED_P)
      and (sc.read_status() or {}).get("worker", {}).get("status") != "ok",
      "8b …a login passed after an unbind: no run_finish, no WANTED left for the next connect", (probe_calls, sc.read_status()))
bind("".join(f"{k}={v}\n" for k, v in svc.bound_env("k9", "s9", WS).items()), wanted=False)
with open(svc.paths(WS)["pfx"], "wb") as f:
    f.write(pfx_id)
sl._set_secrets(dict(BUNDLE, api_key="k9", secret_key="s9"))
sl.RESUME_RETRY_S, sc.LOGIN_451_WAIT_S = 30, real_451  # a full wait: only the unbind can end it early
answers[:] = ["TIMEOUT"]
rekey(10)
time.sleep(0.5)
unbind()
t0 = time.time()
check(wait_unlocked(5) and time.time() - t0 < 3 and len(probe_calls) == 1 and not os.path.exists(WANTED_P),
      "8b …an unbind during the wait to try again: no second login, the lock gone within a second or two", probe_calls)
sl.RESUME_RETRY_S, sc.LOGIN_451_WAIT_S = real_retry, real_451

# ── 8c. a daemon that died mid-step leaves `busy` in the status file: the next start sweeps it (reap_orphan,
#        before the first tick) — running sections INTERRUPTED, busy off; one that died inside run_finish with
#        WANTED there waits for the first snapshot again instead of reading 「開通中」 over a trading worker ──
sc._update(busy=sl.RESUME_STEP, probe={"status": "running", "at": int(time.time())})
sc._update("probe", status="running")
sl.reap_orphan(lambda pid: "")
st = sc.read_status() or {}
check(not st.get("busy") and st.get("probe", {}).get("status") == "failed" and st.get("probe", {}).get("error") == "INTERRUPTED"
      and not sc._busy.locked(),
      "8c restart mid-probe: busy cleared, probe INTERRUPTED, nothing held", st)
bind("".join(f"{k}={v}\n" for k, v in svc.bound_env("k9", "s9", WS).items()), wanted=True)
with open(svc.paths(WS)["pfx"], "wb") as f:
    f.write(pfx_id)
sc._update("worker", status="running")
sc._update(busy=sl.RESUME_STEP)
with open(SNAP, "w") as f:
    json.dump({"ok": True, "equity": 1, "read_at": time.time() + 120}, f)
sl.reap_orphan(lambda pid: "")
held = sc._busy.locked() and (sc.read_status() or {}).get("busy") == sl.RESUME_STEP
check(held and wait_unlocked(), "8c restart inside run_finish (WANTED there): the finish wait is taken up again under the step")
st = sc.read_status() or {}
check(st.get("worker", {}).get("status") == "ok" and not st.get("busy"),
      "8c …and the worker reads ok once its snapshot is there (not stuck at 開通中)", st)
sc._run_worker = _real_run
os.environ.pop("BLAVE_AGENT_LOCAL", None)

# ── 8e run_finish waits through the worker's 「登入中」／login-retry snapshots (29026 11-24: the first
#       snapshot, written the second the worker started, is {"ok": False, "waiting": "login"} — read as
#       WORKER_FAILED while the login then passed); only an answer settles it ──
_real_wait, _real_poll = sc.FINISH_WAIT_S, sc.FINISH_POLL_S
sc.FINISH_POLL_S = 0.05


def _finish_with(writes, wait_s=3.0):
    """run_finish(local) while a stand-in worker writes `writes` [(delay_s, snapshot), …] in order."""
    sc.FINISH_WAIT_S = wait_s
    if os.path.exists(SNAP):
        os.remove(SNAP)

    def writer():
        for delay, snap in writes:
            time.sleep(delay)
            with open(SNAP, "w") as f:
                json.dump(dict(snap, read_at=time.time()), f)
    t = threading.Thread(target=writer, daemon=True)
    t0 = time.time()
    t.start()
    code = code_of(lambda: sc.run_finish(True))
    t.join()
    return code, time.time() - t0, (sc.read_status() or {}).get("worker", {})


_W_LOGIN = {"ok": False, "waiting": "login", "positions": [], "error": "永豐登入中"}
_W_RETRY = {"ok": False, "waiting": "login_retry", "retry_at": time.time() + 60, "error": "timeout"}
code, took, wk = _finish_with([(0.1, _W_LOGIN), (0.3, _W_RETRY), (0.3, {"ok": True, "equity": 1.0})])
check(code is None and wk.get("status") == "ok" and took >= 0.6,
      "8e 登入中, then a login retry, then a read: the finish waits them out and reads ok", (code, took, wk))
code, took, wk = _finish_with([(0.1, _W_LOGIN), (0.2, _W_RETRY)], wait_s=1.0)
check(code == "WORKER_FAILED" and wk.get("status") == "failed" and took >= 1.0,
      "8e still logging in when the wait runs out: WORKER_FAILED only then (the user's 〔再試一次〕)", (code, took, wk))
code, took, wk = _finish_with([(0.1, {"ok": False, "error": "KEY", "login_stopped": True})])
check(code == "WORKER_FAILED" and took < 1.5,
      "8e a login STOP settles it at once (WORKER_FAILED)", (code, took, wk))
code, took, wk = _finish_with([(0.1, {"ok": False, "error": "read failed"})])
check(code == "WORKER_FAILED" and took < 1.5, "8e a failed read (not waiting) settles it at once", (code, took))
# Windows cloud: `--install`'s exit code judges its first snapshot alone (「登入中」 → 2); not read
_real_win, _real_rq, _real_py = sc.IS_WINDOWS, sc.cc._run_quiet, sc._python
_installs = []


def _fake_install(argv, timeout, what, env=None):
    _installs.append(argv[-1])
    with open(SNAP, "w") as f:
        json.dump(dict(_W_LOGIN, read_at=time.time()), f)
    return types.SimpleNamespace(returncode=2, stdout=b"", stderr=b"")


sc.IS_WINDOWS, sc.cc._run_quiet, sc._python = True, _fake_install, (lambda local: sys.executable)
sc.FINISH_WAIT_S = 3.0
if os.path.exists(SNAP):
    os.remove(SNAP)


def _ok_later():
    time.sleep(0.4)
    with open(SNAP, "w") as f:
        json.dump({"ok": True, "equity": 1.0, "read_at": time.time()}, f)


_t = threading.Thread(target=_ok_later, daemon=True)
_t.start()
code = code_of(lambda: sc.run_finish(False))
_t.join()
check(_installs == ["--install"] and code is None and (sc.read_status() or {}).get("worker", {}).get("status") == "ok",
      "8e Windows cloud: --install exits 2 on its 「登入中」 snapshot, the finish waits on and reads ok",
      (_installs, code, (sc.read_status() or {}).get("worker")))
sc.IS_WINDOWS, sc.cc._run_quiet, sc._python = _real_win, _real_rq, _real_py
sc.FINISH_WAIT_S, sc.FINISH_POLL_S = _real_wait, _real_poll
if os.path.exists(SNAP):
    os.remove(SNAP)

# ── 8d the cloud steps check the workspace's own lib gate too (audit S4): a runtime newer than the
#       workspace refuses before the setup and the certificate, with nothing written and no HALT ──
gate["open"] = True
_ws_vt = os.path.join(WS, "lib", "venue_traits.py")
_real_vt = open(os.path.join(ROOT, "lib", "venue_traits.py"), encoding="utf-8").read()
check(_real_vt.count('\n_SINOPAC_MODES = ("futures",)\n') == 1, "8d the shipped lib gate line is the one sinopac_connect reads")
with open(_ws_vt, "w", encoding="utf-8") as f:
    f.write(_real_vt.replace('_SINOPAC_MODES = ("futures",)', "_SINOPAC_MODES = ()"))
_key_path = sc._paths()["key"]
for _p in (_key_path, os.path.join(WS, "state", "HALT")):
    if os.path.exists(_p):
        os.remove(_p)
_st_before = sc.read_status()
_codes = [code_of(lambda c=c: sc.dispatch(c, {}, None)) for c in ("sinopac_setup", "sinopac_pfx_key", "sinopac_pfx", "sinopac_probe")]
check(_codes == ["WORKSPACE_OLD"] * 4 and not os.path.exists(_key_path) and not os.path.exists(os.path.join(WS, "state", "HALT"))
      and sc.read_status() == _st_before,
      "8d workspace lib shut: setup / pfx_key / pfx / probe refused WORKSPACE_OLD, no key, no status change, no HALT", _codes)
os.remove(_ws_vt)
check(code_of(sc.gate) == "WORKSPACE_OLD", "8d no lib/venue_traits.py in the workspace: refused the same")
with open(_ws_vt, "w", encoding="utf-8") as f:
    f.write(_real_vt)
check(sc.workspace_open() and code_of(sc.gate) is None, "8d the shipped lib in the workspace: the gate passes")
gate["open"] = False
check(code_of(sc.gate) == "NOT_OPEN", "8d this runtime's own gate shut: NOT_OPEN first")
os.remove(_ws_vt)

svc.venue_traits.verified_modes = real_modes

# ── 9 the cloud timer is enabled exactly when the gate is open (Wei 11-20): a closed gate ships
# the unit files but nothing runs on any Linux machine; the gate-flip commit enables both together
with open(os.path.join(ROOT, "runtime", "jobs.json"), encoding="utf-8") as f:
    _units = json.load(f)["linux_units"]
_open = "futures" in svc.venue_traits.verified_modes(svc.VENUE)
check(_units.get("blave-agent-sinopac.service") == {"enable": False}
      and _units.get("blave-agent-sinopac.timer") == {"enable": _open},
      "9 jobs.json: blave-agent-sinopac.timer enabled only while 永豐 futures is open; the service itself never",
      (_open, _units.get("blave-agent-sinopac.timer")))

shutil.rmtree(BASE, ignore_errors=True)
print(f"\nFAILED: {fails}" if fails else "\ncheck_sinopac_local: all passed")
sys.exit(1 if fails else 0)
