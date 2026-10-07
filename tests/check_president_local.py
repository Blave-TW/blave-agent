"""統一期貨 on the desktop app (runtime/president_connect local section + lib/president_vault's
in-memory path + local_daemon wiring) — no network, no broker, no Windows.

  1. seal: a payload sealed by shell/president_local.js (node) opens here with the key both sides
     derive from the daemon secret; another secret, a flipped byte, garbage → SEAL_INVALID
  2. shape: account 11 digits, passwords without line breaks, live a bool, the file an absolute .pfx
  3. cert: a wrong certificate password / not a certificate / expired refused before anything is
     written (no .env, no copy); a good one is COPIED (the original stays), .env gets the account,
     sentinels, the fixed path and the production host through the normal bind, the passwords
     land in memory only (no vault file); the file name and the subject are in no status
  4. the bind gate: a 統一 write that did not come from the cert step is refused on the desktop
  5. secrets (after a daemon start): another account / password than .env was bound with → REBOUND
  6. the lib: a child given the line resolves the passwords and production from it; the agent's
     process (BLAVE_AGENT_LOCAL=1, no line) cannot log in; nothing is read from a vault file
  7. the reconciler: the supervisor writes the line first and flags it; run_reconciler hands it
     to lib.president_vault before the strategy code runs
  8. a failed login stops logins (every caller), only an explicit 「確認登入」 tries again; the worker exits for good and
     is never restarted (desktop supervisor, NSSM AppExit)
  9. unbind: worker stopped, passwords dropped, certificate gone; a flatten gets the line on stdin
 10. dispatch: refused off the desktop; president_local is a local-only daemon command

Run: cd blave-agent && /usr/bin/python3 tests/check_president_local.py  (needs `cryptography` and node;
     the repo .venv has no cryptography and SKIPs, like check_president_connect section 5)
"""
import datetime
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BASE = tempfile.mkdtemp(prefix="preslocal-")
WS = os.path.join(BASE, "workspace")
for d in ("lib", "state", "manager"):
    os.makedirs(os.path.join(WS, d))
with open(os.path.join(WS, "manager", "portfolio_config.json"), "w") as f:
    f.write("{}")
for name in ("president_vault.py", "president_worker.py", "guard.py", "__init__.py"):
    src = os.path.join(ROOT, "lib", name)
    if os.path.exists(src):
        shutil.copy(src, os.path.join(WS, "lib"))
os.environ["BLAVE_AGENT_BASE"] = BASE
os.environ["BLAVE_AGENT_WORKSPACE"] = WS
os.environ["BLAVE_AGENT_LOCAL"] = "1"
sys.path.insert(0, os.path.join(ROOT, "runtime"))
sys.path.insert(0, WS)
os.chdir(WS)
import command_listener as cl  # noqa: E402
import local_daemon as ld  # noqa: E402
import president_connect as pc  # noqa: E402

cl._sync_strategy_crons = lambda names: None
pc.IS_WINDOWS = True
fails = []


def check(name, cond, detail=""):
    print(("ok   " if cond else "FAIL ") + name + ("" if cond else f"  {detail}"))
    if not cond:
        fails.append(name)


def code_of(fn):
    try:
        fn()
    except Exception as e:
        return str(e).split(":", 1)[0]
    return None


SECRET = "d" * 64
pc.set_seal_key(SECRET)
P = pc._paths()
NODE = shutil.which("node")


def node_seal(obj, secret=SECRET):
    js = ("const p=require(process.argv[1]);"
          "process.stdout.write(p.sealFor(process.argv[2], JSON.parse(process.argv[3])))")
    return subprocess.run([NODE, "-e", js, os.path.join(ROOT, "shell", "president_local.js"), secret,
                           json.dumps(obj)], capture_output=True, text=True, timeout=30).stdout


try:
    from cryptography import x509
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import rsa
    from cryptography.hazmat.primitives.serialization import pkcs12
    from cryptography.x509.oid import NameOID
except ImportError:
    print("SKIP: needs cryptography")
    sys.exit(0)
if not NODE:
    print("SKIP: needs node (the seal is checked against the app's own code)")
    sys.exit(0)


def make_pfx(password, days=365):
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "TWZ1234567891")])
    now = datetime.datetime.now(datetime.timezone.utc)
    start = now - datetime.timedelta(days=400) if days < 0 else now - datetime.timedelta(days=1)
    cert = (x509.CertificateBuilder().subject_name(name).issuer_name(name).public_key(key.public_key())
            .serial_number(x509.random_serial_number()).not_valid_before(start)
            .not_valid_after(now + datetime.timedelta(days=days)).sign(key, hashes.SHA256()))
    enc = serialization.BestAvailableEncryption(password.encode()) if password else serialization.NoEncryption()
    return pkcs12.serialize_key_and_certificates(b"c", key, cert, None, enc)


class D:
    def __init__(self, fn, cleanup=None):
        self.fn, self._c = fn, cleanup

    def run(self):
        try:
            return self.fn()
        finally:
            if self._c:
                self._c()


ACCT, PW, CAPW = "70000011234", "trade-pw", "ca-pw"
PSCCA = os.path.join(BASE, "PSCCA")
os.makedirs(PSCCA)
SRC = os.path.join(PSCCA, "PSC_Z123456789_20271001.pfx")
with open(SRC, "wb") as f:
    f.write(make_pfx(CAPW))
GOOD = {"account": ACCT, "password": PW, "ca_password": CAPW, "live": True, "src": SRC}

# ── 1. seal ──
blob = node_seal({"a": 1})
check("1 a payload sealed by the app opens here", pc.open_sealed(blob) == {"a": 1}, blob[:20])
check("1 sealed under another daemon secret → SEAL_INVALID",
      code_of(lambda: pc.open_sealed(node_seal({"a": 1}, "e" * 64))) == "SEAL_INVALID")
raw = bytearray(__import__("base64").b64decode(blob))
raw[-1] ^= 1
check("1 a flipped byte → SEAL_INVALID",
      code_of(lambda: pc.open_sealed(__import__("base64").b64encode(bytes(raw)).decode())) == "SEAL_INVALID")
check("1 garbage / empty → SEAL_INVALID", code_of(lambda: pc.open_sealed("!!")) == "SEAL_INVALID"
      and code_of(lambda: pc.open_sealed("")) == "SEAL_INVALID")

# ── 2. shape ──
for label, bad in (("a 10-digit account", {"account": "7000001123"}), ("a password with a newline", {"password": "a\nb"}),
                   ("live as a string", {"live": "true"}), ("a relative file", {"src": "x.pfx"}),
                   ("not a .pfx", {"src": os.path.join(BASE, "x.txt")}), ("no password", {"password": ""})):
    check(f"2 {label} → BAD_ARGS", code_of(lambda: pc._bundle(dict(GOOD, **bad), need_src=True)) == "BAD_ARGS")
check("2 an empty certificate password is allowed (some certificates have none)",
      pc._bundle(dict(GOOD, ca_password=""), need_src=True)["ca_password"] == "")


def cert(b):
    r = pc.local_dispatch({"op": "cert", "sealed": node_seal(b)}, D)
    return r.run()


ENV = os.path.join(WS, ".env")

# ── 3. cert ──
check("3 a wrong certificate password → PFX_PASSWORD, nothing written",
      code_of(lambda: cert(dict(GOOD, ca_password="nope"))) == "PFX_PASSWORD"
      and not os.path.exists(P["pfx"]) and not os.path.exists(ENV))
NOT = os.path.join(PSCCA, "junk.pfx")
open(NOT, "wb").write(b"not a pfx")
check("3 not a certificate → PFX_INVALID", code_of(lambda: cert(dict(GOOD, src=NOT))) == "PFX_INVALID")
OLD = os.path.join(PSCCA, "old.pfx")
open(OLD, "wb").write(make_pfx(CAPW, days=-5))
check("3 expired → PFX_EXPIRED with the date for the page (not the subject)",
      code_of(lambda: cert(dict(GOOD, src=OLD))) == "PFX_EXPIRED"
      and isinstance((pc.read_status()["cert"] or {}).get("not_after"), str))
check("3 outside the daemon (the chat bind's process: paper-only) the bind is refused, nothing written",
      code_of(lambda: cert(GOOD)) not in (None, "OK") and not os.path.exists(ENV))
cl.LOCAL_OPEN_VENUES = frozenset(cl.LOCAL_OPEN_VENUES | {"PRESIDENT"})  # what local_daemon.run does
before = open(SRC, "rb").read()
r = cert(GOOD)
env = open(ENV).read()
check("3 a good one: copied under the fixed name, the original stays",
      open(P["pfx"], "rb").read() == before and open(SRC, "rb").read() == before)
check("3 .env: account, sentinels, the fixed path, the production host — no password",
      f"president_account={ACCT}" in env and "president_password=vault:" + pc.vault_fingerprint(ACCT, PW) in env
      and "president_ca_password=vault:ca" in env and f"president_ca_path={P['pfx']}" in env
      and "president_url=https://viploginm.pfctrade.com" in env and PW not in env and CAPW not in env, env)
check("3 the passwords are in memory only: no vault file; a new account starts on the TEST host whatever the app sent",
      not os.path.exists(P["vault"]) and pc._LOCAL["secrets"] == {"account": ACCT, "password": PW, "ca_password": CAPW, "live": False}
      and pc.read_status()["env"] == "test" and r["env"] == "test")
check("3 .env carries both hosts (switching never rewrites it)", "president_test_url=https://test167.testpfctrade.com" in env)
st = json.dumps(pc.read_status())
check("3 the status: cert ok with its expiry, nothing personal",
      pc.read_status()["cert"]["status"] == "ok" and "Z123456789" not in st and "PSC_" not in st and PW not in st)
check("3 the result carries no secret", PW not in json.dumps(r) and CAPW not in json.dumps(r))

# ── 4. bind gate ──
check("4 a 統一 write that did not come from the cert step → NOT_CHECKED",
      code_of(lambda: cl._cmd_credentials({"env": pc._bound_env(GOOD)})) == "NOT_CHECKED")

# ── 5. secrets ──
pc._LOCAL["secrets"] = None
check("5 another password than .env was bound with → REBOUND, nothing loaded",
      code_of(lambda: pc.local_dispatch({"op": "secrets", "sealed": node_seal(dict(GOOD, password="x"))}, D)) == "REBOUND"
      and pc._LOCAL["secrets"] is None)
check("5 another account → REBOUND",
      code_of(lambda: pc.local_dispatch({"op": "secrets", "sealed": node_seal(dict(GOOD, account="70000099999"))}, D)) == "REBOUND")
g = dict(GOOD, live=False)
g.pop("src")
check("5 the bound ones load", pc.local_dispatch({"op": "secrets", "sealed": node_seal(g)}, D) == {"secrets": "ok"}
      and pc._LOCAL["secrets"]["password"] == PW)

# ── 6. the lib, in child processes ──
PROBE = ("import json,sys;sys.path.insert(0,'.');from lib import president_vault as v\n"
         "try:\n c=v.resolve();print(json.dumps({'pw':c['password'],'ca':c['ca_password'],'live':c['live']}))\n"
         "except Exception as e:\n print(json.dumps({'err':type(e).__name__}))")


def child(env_extra, line=None):
    env = {k: v for k, v in os.environ.items() if not k.startswith("BLAVE_PRESIDENT")}
    env.update(env_extra)
    out = subprocess.run([sys.executable, "-c", PROBE], cwd=WS, env=env, capture_output=True, text=True,
                         input=(line + "\n") if line is not None else "", timeout=60).stdout
    return json.loads(out.strip().splitlines()[-1])


got = child(pc.child_flags(), pc.secret_line())
check("6 a child given the line logs in with it: passwords and the environment from memory",
      got == {"pw": PW, "ca": CAPW, "live": False}, got)
pc._LOCAL["secrets"]["live"] = True
got = child(pc.child_flags(), pc.secret_line())
check("6 …production when the bundle says so", got == {"pw": PW, "ca": CAPW, "live": True}, got)
pc._LOCAL["secrets"]["live"] = False
open(P["vault"], "w").write(json.dumps({"president_password": "from-file", "live": True}))
got = child({"BLAVE_AGENT_LOCAL": "1"})
check("6 the agent's own process (desktop, no line): cannot log in — and a vault file is never read",
      got.get("err") == "RuntimeError", got)
os.remove(P["vault"])
check("6 the line holds the passwords and the environment, not the account", json.loads(pc.secret_line()) == {
    "president_password": PW, "president_ca_password": CAPW, "live": False})

# ── 6c. the probe's hard timeout (0.1.18 Windows: 「確認登入」 spun for 5 minutes) ──
# The Windows venv python.exe is venvlauncher.exe; the interpreter is its child. subprocess.run(timeout=)
# kills the launcher and then waits for the pipes — held open by the orphan — forever. Same shape here:
# a parent that only waits on a grandchild sharing its stdout.
SLEEPER = os.path.join(WS, "sleeper.py")
with open(SLEEPER, "w") as f:
    f.write("import os, subprocess, sys\n"
            "c = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(60)'])\n"
            "open(os.path.join(os.environ['BLAVE_AGENT_WORKSPACE'], 'grandchild.pid'), 'w').write(str(c.pid))\n"
            "c.wait()\n")
t0 = time.time()
code = code_of(lambda: pc._local_run("--once", 1, "probe", argv=[SLEEPER]))
took = time.time() - t0
check("6c _local_run: a child whose grandchild holds the pipes still times out (RuntimeError, within seconds)",
      code == "probe timed out" and took < 8, f"{code} {took:.1f}s")
gpid = int(open(os.path.join(WS, "grandchild.pid")).read())
alive = True
for _ in range(30):  # SIGKILL lands at once; the reparented zombie takes a moment to be reaped
    try:
        os.kill(gpid, 0)
    except OSError:
        alive = False
        break
    time.sleep(0.1)
check("6c the grandchild is gone too (the whole tree is killed, not just the child)", not alive)
real_paths, real_probe_timeout = pc._paths, pc.PROBE_TIMEOUT_S
pc._paths = lambda: dict(real_paths(), worker=SLEEPER)
pc.PROBE_TIMEOUT_S = 1
t0 = time.time()
st6c = pc.run_probe()
pr6c = pc.read_status()["probe"]
check("6c run_probe on that worker: status leaves `running` as failed / timeout, within seconds",
      st6c["state"] == "timeout" and pr6c["status"] == "failed" and pr6c["state"] == "timeout" and time.time() - t0 < 8,
      json.dumps(pr6c))
pc._paths, pc.PROBE_TIMEOUT_S = real_paths, real_probe_timeout
os.remove(SLEEPER)

# ── 6b. test environment (the cloud's president_host / president_test_order, same runtime code) ──
probes = []
real_probe = pc.run_probe
pc.run_probe = lambda push=None: probes.append(pc.current_env()) or (
    pc._update("probe", status="ok", state="ok", env=pc.current_env()) and {"state": "ok", "env": pc.current_env()})
check("6b start before production → TEST_ENV (the worker never runs on the test host)",
      code_of(lambda: pc.local_dispatch({"op": "start"}, D).run()) == "TEST_ENV")
check("6b a host outside the two allowed → HOST_NOT_ALLOWED, before anything runs",
      code_of(lambda: pc.local_dispatch({"op": "host", "url": "evil.example.com"}, D)) == "HOST_NOT_ALLOWED")
check("6b host takes exactly one of env / url", code_of(lambda: pc.local_dispatch({"op": "host"}, D)) == "BAD_ARGS"
      and code_of(lambda: pc.local_dispatch({"op": "host", "env": "prod"}, D)) == "BAD_ARGS")
r6 = pc.local_dispatch({"op": "host", "url": " https://test167.pfctrade.com/ "}, D).run()
check("6b the address as mailed → the test host, then the probe there", r6["env"] == "test" and probes[-1] == "test"
      and pc.read_status()["probe"]["env"] == "test")
ran = []
real_order = pc.run_test_order
pc.run_test_order = lambda push=None: ran.append(pc.current_env()) or {"state": "accepted"}
pc.local_dispatch({"op": "test_order"}, D).run()
check("6b test order after a test-host probe", ran == ["test"])
pc.local_dispatch({"op": "host", "env": "live"}, D).run()
check("6b 營業員說開好了 = host live: bundle switched, probe on production",
      pc._LOCAL["secrets"]["live"] is True and probes[-1] == "live" and pc.read_status()["env"] == "live")
check("6b test order on production → LIVE_ENV", code_of(lambda: pc.local_dispatch({"op": "test_order"}, D)) == "LIVE_ENV")
pc.local_dispatch({"op": "host", "env": "test"}, D).run()
pc.run_probe, pc.run_test_order = real_probe, real_order

# ── 7. reconciler ──
spawned = []


class FakeProc:
    def __init__(self, argv, **kw):
        self.argv, self.kw, self.pid = argv, kw, 4242
        self.written = []
        me = self

        class In:
            def write(self, b):
                me.written.append(b)

            def flush(self):
                pass

            def close(self):
                pass
        self.stdin = In()
        spawned.append(self)

    def poll(self):
        return None


sup = ld.ReconcilerSupervisor(WS, cl._local_child_env, lambda pid: "", lambda **kw: kw,
                              secret_line=pc.secret_line)
sup._free_lock = lambda: os.open(os.devnull, os.O_RDONLY)
sup._confirm_child_lock = lambda: None
real_popen = ld.subprocess.Popen
ld.subprocess.Popen = FakeProc
try:
    sup._spawn_locked()
finally:
    ld.subprocess.Popen = real_popen
p0 = spawned[-1]
check("7 the supervisor flags the reconciler and writes the line first",
      "--president-stdin" in p0.argv and p0.kw["env"].get("BLAVE_PRESIDENT_LOCAL") == "1"
      and json.loads(p0.written[0].decode())["president_password"] == PW, p0.argv)
check("7 …never in the environment", PW not in json.dumps(p0.kw["env"]))
script = os.path.join(WS, "peek.py")
open(script, "w").write("import json\nfrom lib import president_vault as v\n"
                        "open('peek.json','w').write(json.dumps(v._local_secrets()))\n")
pr = subprocess.Popen([sys.executable, os.path.join(ROOT, "runtime", "local_daemon.py"), "--run-reconciler",
                       "peek.py", "--president-stdin"], cwd=WS, stdin=subprocess.PIPE,
                      stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                      env={k: v for k, v in os.environ.items() if k != "BLAVE_AGENT_LOCAL"})
pr.stdin.write((pc.secret_line() + "\n").encode())
pr.stdin.flush()
try:
    pr.wait(60)
finally:
    pr.stdin.close()
peek = json.load(open(os.path.join(WS, "peek.json"))) if os.path.exists(os.path.join(WS, "peek.json")) else None
check("7 run_reconciler hands the line to lib.president_vault before the strategy code runs",
      peek == {"president_password": PW, "president_ca_password": CAPW, "live": False}, peek)

# ── 7b. a new bundle respawns the reconciler only between rounds, off the command thread (audit #7) ──
import threading as _th  # noqa: E402
sup2 = ld.ReconcilerSupervisor(WS, cl._local_child_env, lambda pid: "", lambda **kw: kw, secret_line=pc.secret_line)
resp = []
sup2.respawn_if_running = lambda why: resp.append(why)
marker = os.path.join(WS, "state", "execution", "round")
hold = os.path.join(WS, "state", "execution", "hold")
os.makedirs(os.path.dirname(marker), exist_ok=True)
open(marker, "w").write("1")
t0 = time.time()
th = sup2.respawn_when_idle("test", wait_s=30, poll_s=0.05)
check("7b the caller is not blocked (it returns at once on its own thread)", time.time() - t0 < 1 and th.is_alive())
time.sleep(0.4)
check("7b mid-round (marker up): no respawn yet, new rounds held", resp == [] and os.path.exists(hold))
os.remove(marker)
th.join(5)
check("7b round over → respawned once, hold released", resp == ["test"] and not os.path.exists(hold))
check("7b the daemon wires the bundle hand-over to respawn_when_idle",
      'respawn_when_idle("統一期貨 credentials handed over")' in open(os.path.join(ROOT, "runtime", "local_daemon.py"), encoding="utf-8").read())

# ── 7c. a reconciler started before the hand-over (empty line): 統一 legs skip the round, no order_error (B7) ──
script2 = os.path.join(WS, "peek2.py")
open(script2, "w").write(
    "import json, sys\nsys.path.insert(0, '.')\nfrom lib import president_vault as v\n"
    "from manager import reconciler as rec\nsent = []\n"
    "rec._HAND_WIRED[rec.venue_traits.PRESIDENT] = (lambda: {}, lambda *a, **k: sent.append(a) or {'executed_qty': 1})\n"
    "r = rec.place_order('TXF', 1, exchange='president')\n"
    "open('peek2.json', 'w').write(json.dumps({'ready': v.credentials_ready(), 'r': r, 'sent': len(sent)}))\n")
for d in ("manager",):
    os.makedirs(os.path.join(WS, d), exist_ok=True)
shutil.copy(os.path.join(ROOT, "manager", "reconciler.py"), os.path.join(WS, "manager", "reconciler.py"))
open(os.path.join(WS, "manager", "__init__.py"), "a").close()
for name in os.listdir(os.path.join(ROOT, "lib")):
    if name.endswith(".py") and not os.path.exists(os.path.join(WS, "lib", name)):
        shutil.copy(os.path.join(ROOT, "lib", name), os.path.join(WS, "lib", name))


def run_peek2(line):
    pr2 = subprocess.Popen([sys.executable, os.path.join(ROOT, "runtime", "local_daemon.py"), "--run-reconciler",
                            "peek2.py", "--president-stdin"], cwd=WS, stdin=subprocess.PIPE,
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                           env={k: v for k, v in os.environ.items() if k != "BLAVE_AGENT_LOCAL"})
    pr2.stdin.write((line + "\n").encode())
    pr2.stdin.flush()
    try:
        pr2.wait(90)
    finally:
        pr2.stdin.close()
    try:
        return json.load(open(os.path.join(WS, "peek2.json")))
    except (OSError, ValueError):
        return None


got = run_peek2("{}")
check("7c empty line (not handed over yet): not ready, the 統一 leg is skipped (False), the order lib never called",
      got == {"ready": False, "r": False, "sent": 0}, got)
got = run_peek2(pc.secret_line())
check("7c with the line: ready, the leg goes out", got is not None and got["ready"] is True and got["sent"] == 1, got)

# ── 8. a failed login stops: no automatic re-login anywhere; 「確認登入」 tries once per press (Wei 10-07 MVP) ──
from lib import president_vault as pv  # noqa: E402
import types as _types  # noqa: E402

halts, evs = [], []
import lib.guard as guard  # noqa: E402
import events  # noqa: E402

guard.trip_halt = lambda reason, source: halts.append((reason, source))
events.append = lambda t, payload=None, ts=None: evs.append((t, payload))
SDK = {"logins": 0, "ok": False, "error": "使用者密碼錯誤"}


class FakeUnitrade:
    test_mode = False

    def login(self, *a):
        SDK["logins"] += 1
        return _types.SimpleNamespace(ok=SDK["ok"], error=SDK["error"])

    def logout(self):
        pass

    def get_accounts(self):
        return ["a1"]


fake_ut = _types.ModuleType("unitrade")
fake_utu = _types.ModuleType("unitrade.unitrade")
fake_utu.Unitrade = FakeUnitrade
sys.modules["unitrade"], sys.modules["unitrade.unitrade"] = fake_ut, fake_utu
pv.in_login_maintenance = lambda now=None: False
creds = {"url": "https://viploginm.pfctrade.com", "account": ACCT, "password": PW, "ca_path": P["pfx"],
         "ca_password": CAPW, "live": True}
logdir = os.path.join(BASE, "sdklogs")
try:
    os.remove(pv.STOP)
except OSError:
    pass


def login_kind(**kw):
    try:
        pv.login(creds, logdir, **kw)
    except pv.LoginError as e:
        return e.kind
    return "OK"


check("8 a wrong password → PASSWORD, one broker login, logins stopped", login_kind() == "PASSWORD" and SDK["logins"] == 1 and pv.stopped() == "PASSWORD")
for _ in range(3):
    login_kind()
check("8 stopped: every later login (worker, order lib, flatten) refuses STOPPED without contacting the broker",
      login_kind() == "STOPPED" and SDK["logins"] == 1)
check("8 「確認登入」(explicit) is a real login every press — and a failure keeps the stop",
      login_kind(explicit=True) == "PASSWORD" and SDK["logins"] == 2 and pv.stopped() == "PASSWORD")
SDK["ok"] = True
check("8 a confirmed login that passes lifts the stop", login_kind(explicit=True) == "OK" and SDK["logins"] == 3 and pv.stopped() is None)
check("8 …then ordinary logins go through again", login_kind() == "OK" and SDK["logins"] == 4)
SDK["ok"], SDK["error"] = False, "Read timed out"
check("8 a timeout stops too (any login failure)", login_kind() == "TIMEOUT" and pv.stopped() == "TIMEOUT")
pv.in_login_maintenance = lambda now=None: True
os.remove(pv.STOP)
check("8 maintenance is never attempted and never stops", login_kind() == "MAINTENANCE" and pv.stopped() is None and SDK["logins"] == 5)
pv.in_login_maintenance = lambda now=None: False
SDK["error"] = "使用者密碼錯誤"

# the worker: a failed login exits LOGIN_STOPPED_EXIT for good (no backoff, no retry)
import lib.president_worker as pw  # noqa: E402
pv.use_local_secrets({"president_password": PW, "president_ca_password": CAPW, "live": True})
pw.maintenance = lambda now=None: None
code = None
n0 = SDK["logins"]
try:
    pw.main()
except SystemExit as e:
    code = e.code
snap = json.load(open(pw.OUT_PATH))
check("8 the worker: one login, then exit LOGIN_STOPPED_EXIT with the class in its snapshot (no sleep, no second try)",
      code == pw.LOGIN_STOPPED_EXIT == pc.LOGIN_STOPPED_EXIT and SDK["logins"] == n0 + 1 and snap.get("login_stopped") is True
      and "PASSWORD" in snap.get("error", ""), (code, snap))
check("8 NSSM is told not to restart that exit (cloud)", '("set", SERVICE, "AppExit", str(LOGIN_STOPPED_EXIT), "Exit")'
      in open(os.path.join(ROOT, "lib", "president_worker.py"), encoding="utf-8").read())
check("8 the worker has no --unblock any more", "--unblock" not in open(os.path.join(ROOT, "lib", "president_worker.py"), encoding="utf-8").read())

# the desktop supervisor: an exit 3 is not restarted, the status says why
w = pc._LOCAL["worker"]
w.wanted, w.proc, w.respawn_at = True, type("Dead", (), {"poll": lambda self: pc.LOGIN_STOPPED_EXIT, "pid": 1})(), 0
spawns = []
w._spawn = lambda: spawns.append(1)
for _ in range(5):
    pc.local_tick()
check("8 desktop: a worker that stopped on a failed login is never restarted", spawns == [] and w.wanted is False)
check("8 …the status names the class (the page shows it with 「確認登入」)",
      pc.read_status()["worker"]["error"] == "LOGIN_FAILED:PASSWORD" and pc.read_status()["worker"]["status"] == "failed")
check("8 no HALT and no event for it", not halts and not evs, (halts, evs))
w.wanted, w.proc, w.respawn_at = True, type("Dead", (), {"poll": lambda self: 1, "pid": 1})(), 0
pc.local_tick()
check("8 a worker that died of something else (not a login) is restarted as before", spawns == [1])

# 8d. onboarded, then the login failed (audit integ-0118 B-1): the first ok writes worker.ok_at and no failure
# path clears it — the pages tell "never finished onboarding" from "onboarded, then stopped" by it
env_before = pc.read_status().get("env")
pc._update(env="live")
pc._update("worker", reset=True, status="idle")
pc._update("probe", status="ok", state="ok", env="live")
pc._LOCAL["secrets"]["live"] = True
real_start, real_finish_timeout = w.start, pc.FINISH_TIMEOUT_S
w.start = lambda: open(os.path.join(WS, "state", "president_account.json"), "w").write('{"ok": true}')
pc.FINISH_TIMEOUT_S = 5
pc._local_start(None)
ok_at = pc.read_status()["worker"].get("ok_at")
check("8d the first good snapshot writes worker.ok_at", isinstance(ok_at, int) and ok_at > 0, pc.read_status()["worker"])
w.wanted, w.proc, w.respawn_at = True, type("Dead", (), {"poll": lambda self: pc.LOGIN_STOPPED_EXIT, "pid": 1})(), 0
pc.local_tick()
w8 = pc.read_status()["worker"]
check("8d …a later login failure (local_tick) keeps it next to status=failed", w8["status"] == "failed" and w8.get("ok_at") == ok_at, w8)
w.start = lambda: (_ for _ in ()).throw(RuntimeError("boom"))
code_of(lambda: pc._local_start(None))
w8 = pc.read_status()["worker"]
check("8d …a failed restart (_local_start) keeps it too", w8["status"] == "failed" and w8.get("ok_at") == ok_at, w8)
w.start, pc.FINISH_TIMEOUT_S = real_start, real_finish_timeout
real_rq = pc.cc._run_quiet
pc.cc._run_quiet = lambda argv, timeout, what: subprocess.CompletedProcess(argv, 0)
pc._update("worker", reset=True, status="idle")
pc.run_finish()
check("8d the cloud's run_finish writes ok_at as well", isinstance(pc.read_status()["worker"].get("ok_at"), int))
pc.cc._run_quiet = real_rq
pc._update(env=env_before)
pc._LOCAL["secrets"]["live"] = env_before == "live"

# the reconciler while stopped: 統一 legs skipped (no order lib call, no order_error flood, one log line a round);
# other venues' legs go on; the confirmed login lifts it
import logging as _logging  # noqa: E402
from manager import reconciler as rec  # noqa: E402
sent_r, logs = [], []
rec._HAND_WIRED[rec.venue_traits.PRESIDENT] = (lambda: {}, lambda *a, **k: sent_r.append(("president", a)) or {"executed_qty": 1})
import lib.execute as _ex  # noqa: E402
_ex.dispatch_order = lambda symbol, diff, **k: sent_r.append((k.get("exchange"), symbol)) or {"executed_qty": 1}
_h = _logging.Handler()
_h.emit = lambda r: logs.append(r.getMessage())
_logging.getLogger().addHandler(_h)
pv.use_local_secrets({"president_password": PW, "president_ca_password": CAPW, "live": True})
rec._next_round()
r1 = [rec.place_order("TXF", 1, exchange="president") for _ in range(3)]
r2 = rec.place_order("BTCUSDT", 100, exchange="binance")
check("8 reconciler: 統一 legs skipped while stopped (False, the order lib never called), a crypto leg goes out",
      r1 == [False] * 3 and not [x for x in sent_r if x[0] == "president"] and ("binance", "BTCUSDT") in sent_r and r2)
check("8 …one log line for the round, not one per leg", sum("login stopped" in m for m in logs) == 1, logs)
os.remove(pv.STOP)
rec.place_order("TXF", 1, exchange="president")
check("8 after the confirmed login (stop gone) 統一 legs go out", [x for x in sent_r if x[0] == "president"])
_logging.getLogger().removeHandler(_h)

# ── 9. unbind / flatten ──
flat = []


class FlatProc(FakeProc):
    def __init__(self, argv, **kw):
        super().__init__(argv, **kw)
        flat.append(self)


cl.subprocess.Popen = FlatProc
cl._kick_when_flatten_exits = lambda proc: None
try:
    cl._launch_flatten("")
finally:
    cl.subprocess.Popen = real_popen
fp_ = flat[-1]
check("9 a flatten gets the line on stdin (統一's close logs in), flagged, never in its environment",
      fp_.kw.get("stdin") == subprocess.PIPE and json.loads(fp_.written[0].decode())["president_password"] == PW
      and fp_.kw["env"].get("BLAVE_PRESIDENT_STDIN") == "1" and PW not in json.dumps(fp_.kw["env"]))
stopped = []
w.stop = lambda why="": stopped.append(why)
pc.drop_vault(["PRESIDENT_ACCOUNT"])
check("9 unbind: worker stopped, passwords dropped, certificate gone",
      stopped and pc._LOCAL["secrets"] is None and not os.path.exists(P["pfx"]))
check("9 …and the original in PSCCA stays (the user's renewal needs it)", os.path.exists(SRC))

# ── 10. dispatch ──
os.environ.pop("BLAVE_AGENT_LOCAL")
check("10 off the desktop → NOT_LOCAL", code_of(lambda: pc.local_dispatch({"op": "probe"}, D)) == "NOT_LOCAL")
os.environ["BLAVE_AGENT_LOCAL"] = "1"
check("10 an unknown op / extra key → BAD_ARGS", code_of(lambda: pc.local_dispatch({"op": "x"}, D)) == "BAD_ARGS"
      and code_of(lambda: pc.local_dispatch({"op": "start", "sealed": "x"}, D)) == "BAD_ARGS")
check("10 probe before the credentials are handed over → NO_SECRETS",
      code_of(lambda: pc.local_dispatch({"op": "probe"}, D)) == "NO_SECRETS")
check("10 president_local is local-only: not in the api's list, accepted by the daemon's parser",
      "president_local" in ld.LOCAL_ONLY and "president_local" not in ld.ALLOWED | ld.CLOUD_ONLY
      and "president_local" in cl.HANDLERS)
body = json.dumps({"id": "abc", "cmd": "president_local", "args": {"op": "stop"}, "ts": time.time()})
doc = json.dumps({"body": body, "mac": ld.sign(SECRET, body)}).encode()
check("10 a signed president_local passes the parser", ld.parse_command(doc, "abc", SECRET, time.time(),
                                                                        lambda i: False)["cmd"] == "president_local")
check("10 the cloud commands stay refused on the desktop",
      code_of(lambda: pc.dispatch("president_probe", {}, D, local=True)) == "LOCAL_MODE")

shutil.rmtree(BASE, ignore_errors=True)
print(f"\n{'FAILED: ' + str(len(fails)) if fails else 'all ok'}")
sys.exit(1 if fails else 0)
