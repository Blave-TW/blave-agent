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
  8. blocked login: one HALT + one P1 event per block, the worker is not restarted while blocked
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
check("3 the passwords are in memory only: no vault file", not os.path.exists(P["vault"])
      and pc._LOCAL["secrets"] == {"account": ACCT, "password": PW, "ca_password": CAPW, "live": True})
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
g = dict(GOOD)
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
check("6 a child given the line logs in with it: passwords and production from memory",
      got == {"pw": PW, "ca": CAPW, "live": True}, got)
open(P["vault"], "w").write(json.dumps({"president_password": "from-file", "live": True}))
got = child({"BLAVE_AGENT_LOCAL": "1"})
check("6 the agent's own process (desktop, no line): cannot log in — and a vault file is never read",
      got.get("err") == "RuntimeError", got)
os.remove(P["vault"])
check("6 the line holds the passwords and production, not the account", json.loads(pc.secret_line()) == {
    "president_password": PW, "president_ca_password": CAPW, "live": True})

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
      peek == {"president_password": PW, "president_ca_password": CAPW, "live": True}, peek)

# ── 8. blocked login ──
from lib import president_vault as pv  # noqa: E402

halts, evs = [], []
import lib.guard as guard  # noqa: E402
import events  # noqa: E402

guard.trip_halt = lambda reason, source: halts.append((reason, source))
events.append = lambda t, payload=None, ts=None: evs.append((t, payload))
fp = pv.fingerprint({"account": ACCT, "password": PW, "ca_path": P["pfx"], "ca_password": CAPW})
pv.BLOCK = os.path.join(WS, "state", "president_login_block.json")
pv._write_block({"fp": fp, "kind": "PASSWORD", "at": 1})
w = pc._LOCAL["worker"]
w.wanted, w.proc = True, type("Dead", (), {"poll": lambda self: 1, "pid": 1})()
spawns = []
w._spawn = lambda: spawns.append(1)
for _ in range(3):
    pc.local_tick()
check("8 a block: one HALT and one P1 event, however many ticks",
      len(halts) == 1 and evs.count(("president_login_blocked", {"kind": "PASSWORD"})) == 1, (halts, evs))
w.respawn_at = 0
pc.local_tick()
check("8 the worker is not restarted while blocked", spawns == [])
check("8 the status says why", pc.read_status()["worker"]["error"] == "BLOCKED:PASSWORD")
pv._write_block({"fp": fp, "kind": "PASSWORD", "at": 2})
pc.local_tick()
check("8 a new block (after a release) is told again", len(halts) == 2)
pv._write_block({"fp": "other", "kind": "PASSWORD", "at": 3})
w.respawn_at = 0
pc.local_tick()
check("8 a block for other credentials is not ours: no HALT, and the worker comes back",
      len(halts) == 2 and spawns == [1], (halts, spawns))
os.remove(pv.BLOCK)

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
