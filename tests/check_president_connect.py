"""統一期貨 cloud connect (runtime/president_connect.py) — no network, no Windows, no broker.

  1. bind (divert_credentials): desktop untouched, a non-Windows cloud box refused; an old lib refused; the trading
     password and the production switch go to the vault, .env gets sentinels + the fixed
     certificate path + the production host; credentials\\ locked before any plaintext; vault and
     pfx readable by SYSTEM AND Administrators (the worker is LocalSystem); a failed ACL refuses
     the bind and leaves no tmp; the shipped lib resolves the result (production on, password
     from the vault); a rebind of the same account keeps the uploaded certificate, another
     account's is deleted
  2. unbind / eviction (drop_vault): other venues' names do nothing; 統一's take the vault (and so
     the production switch), the pfx, a pending key and the status, and ask the worker service to
     remove itself — through credentials_remove (all seven lines go, not only the two sent) and
     through another venue's bind
  3. dispatch: desktop / non-Windows refused; a key or an upload before the bind → NOT_BOUND; a
     login before the certificate → CERT_MISSING (an unreadable pfx is a CERT block in the lib);
     args shapes; one long step at a time; an interrupted step is swept
  4. probe: every login class the lib writes maps to a state, no text passes; a stale probe file
     is not trusted; the probe is one explicit login (--once); finish needs a
     passed probe
  5. upload (needs `cryptography`): the envelope opens once with 統一's own key file (群益's is not
     touched); a wrong certificate password is refused before anything is written (no broker
     contact); the pfx lands under the fixed name with the uploaded bytes, its password in the
     vault; expired / not a certificate refused; the issuer marks are placeholders until Wei
     supplies them (issuer_checked false), and once set they refuse a foreign certificate
  6. upload write order: a failed vault write removes the landed certificate; a bind racing the upload
  7. president_pfx_local (the user applied over RDP; stand-in folder): none found / a wrong password /
     expired / several → the newest that opens and has not expired, COPIED (the original stays); a file
     in the envelope refused; the file name (national id) in no result, status, exception or output

Run: cd blave-agent && /usr/bin/python3 tests/check_president_connect.py
"""
import base64
import datetime
import json
import os
import shutil
import sys
import tempfile
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TMP = tempfile.mkdtemp(prefix="prescc-")
WS = os.path.join(TMP, "workspace")
for d in ("lib", "state", "manager"):
    os.makedirs(os.path.join(WS, d))
open(os.path.join(WS, "manager", "portfolio_config.json"), "w").write("{}")
os.environ["BLAVE_AGENT_WORKSPACE"] = WS
os.environ["BLAVE_AGENT_HOME"] = os.environ["BLAVECLAW_HOME"] = TMP
os.environ.pop("BLAVE_AGENT_LOCAL", None)
sys.path.insert(0, os.path.join(ROOT, "runtime"))
sys.path.insert(0, ROOT)

import capital_connect as cc  # noqa: E402
import president_connect as pc  # noqa: E402

fails = []


def check(name, cond, detail=""):
    print(("ok   " if cond else "FAIL ") + name + ("" if cond else f"  {detail}"))
    if not cond:
        fails.append(name)


def refused(fn, code):
    try:
        fn()
    except ValueError as e:
        return str(e).split(":", 1)[0] == code or str(e)
    return "no refusal"


P = pc._paths()
pc.IS_WINDOWS = True
cc.IS_WINDOWS = True
cc._kw = lambda **kw: kw  # CREATE_NO_WINDOW exists only on Windows
acl = []


def fake_icacls(path, *a):
    tmps = [f for f in os.listdir(P["cred"]) if f.endswith(".tmp")] if os.path.isdir(P["cred"]) else []
    acl.append((os.path.basename(path), a, bool(tmps)))


cc._icacls = fake_icacls
popen = []
pc.subprocess.Popen = lambda argv, **kw: popen.append(argv)
cc._python_for_worker = lambda: "py"
BIND = {"president_account": "70000011234", "president_password": "trade-pw"}

# ── 1. bind ──
check("1 desktop: untouched", pc.divert_credentials(dict(BIND), local=True) == BIND)
pc.IS_WINDOWS = False
check("1 a cloud box that is not Windows: refused (the password would sit in .env with no way to production)",
      refused(lambda: pc.divert_credentials(dict(BIND)), "NOT_WINDOWS") is True
      and pc.divert_credentials({"OKX_API_KEY": "k"}) == {"OKX_API_KEY": "k"})
pc.IS_WINDOWS = True
check("1 other venues' writes: untouched", pc.divert_credentials({"OKX_API_KEY": "k"}) == {"OKX_API_KEY": "k"})
check("1 a workspace lib that reads production from .env → LIB_OUTDATED, nothing written",
      refused(lambda: pc.divert_credentials(dict(BIND)), "LIB_OUTDATED") is True and not os.path.exists(P["vault"]))
for name in ("president_vault.py", "president_worker.py"):
    shutil.copy(os.path.join(ROOT, "lib", name), os.path.join(WS, "lib"))
check("1 the shipped lib reads the vault", pc.lib_supports_vault())
for label, half in (("the account alone", {"president_account": "1"}),
                    ("the password alone (plaintext into .env)", {"president_password": "pw"}),
                    ("the certificate password alone", {"president_ca_password": "pw"}),
                    ("an upper-case password alone", {"PRESIDENT_PASSWORD": "pw"}),
                    ("the account with a sentinel", {"president_account": "1", "president_password": "vault:x"})):
    check(f"1 cloud Windows: {label} → INCOMPLETE, nothing written",
          refused(lambda: pc.divert_credentials(dict(half)), "INCOMPLETE") is True and not os.path.exists(P["vault"]))
out = pc.divert_credentials(dict(BIND, OTHER="1"))
vault = json.load(open(P["vault"]))
check("1 .env gets the account, sentinels, the fixed certificate path and both hosts (a switch never rewrites .env)",
      out == {"OTHER": "1", "president_account": "70000011234",
              "president_password": "vault:" + pc.vault_fingerprint("70000011234", "trade-pw"),
              "president_ca_password": "vault:ca", "president_ca_path": P["pfx"],
              "president_url": "https://viploginm.pfctrade.com",
              "president_test_url": "https://test167.testpfctrade.com"}, out)
check("1 the vault: the password; a new account starts on the TEST host (統一 opens production after a test order)",
      vault == {"president_password": "trade-pw", "live": False, "account_fp": pc.account_fp("70000011234")}, vault)
check("1 the status says which environment", pc.read_status()["env"] == "test")
check("1 no secret in .env", "trade-pw" not in json.dumps(out))
check("1 credentials\\ locked before any plaintext tmp exists",
      acl and acl[0][0] == "credentials" and acl[0][1][0] == "/inheritance:r" and acl[0][2] is False, acl[:1])
check("1 vault ACL: SYSTEM + Administrators read it (worker = LocalSystem, reconciler = Administrator), before the rename",
      [a for f, a, _ in acl if "president_vault.json." in f and f.endswith(".tmp")]  # atomic_file's .name.hex.tmp
      == [("/inheritance:r", "/grant:r", "*S-1-5-18:F", "*S-1-5-32-544:F")], acl)
check("1 a changed password is a different account identity",
      pc.vault_fingerprint("1", "a") != pc.vault_fingerprint("1", "b"))
with open(os.path.join(WS, ".env"), "w") as f:
    f.write("".join(f"{k}={v}\n" for k, v in out.items()))
import importlib.util  # noqa: E402

spec = importlib.util.spec_from_file_location("president_vault", os.path.join(WS, "lib", "president_vault.py"))
pv = importlib.util.module_from_spec(spec)
spec.loader.exec_module(pv)
creds = pv.resolve()
check("1 the shipped lib resolves the bind: the test host, password from the vault, the fixed pfx path",
      creds["live"] is False and creds["password"] == "trade-pw" and creds["url"] == "https://test167.testpfctrade.com"
      and creds["ca_path"] == P["pfx"] and creds["ca_password"] == "", {k: v for k, v in creds.items() if k != "password"})
out_live = pc.divert_credentials(dict(BIND, president_url=" https://viploginm.pfctrade.com/ "))
with open(os.path.join(WS, ".env"), "w") as f:
    f.write("".join(f"{k}={v}\n" for k, v in out_live.items()))
creds = pv.resolve()
check("1 a bind that names the production host (as pasted) → production on; the lib resolves viploginm",
      creds["live"] is True and creds["url"] == "https://viploginm.pfctrade.com"
      and out_live == {k: v for k, v in out.items() if k != "OTHER"} and pc.read_status()["env"] == "live",
      (creds["url"], out_live))
pc.divert_credentials(dict(BIND, president_password="trade-pw2"))
check("1 a rebind of the same account keeps its environment (the permission is the account's)",
      json.load(open(P["vault"]))["live"] is True)
before_bad = open(P["vault"]).read()
check("1 a bind naming any other host → HOST_NOT_ALLOWED, the vault untouched",
      refused(lambda: pc.divert_credentials(dict(BIND, president_url="https://evil.example")), "HOST_NOT_ALLOWED") is True
      and open(P["vault"]).read() == before_bad)
pc.divert_credentials(dict(BIND, president_url="test167.pfctrade.com"))
with open(os.path.join(WS, ".env"), "w") as f:
    f.write("".join(f"{k}={v}\n" for k, v in out.items()))
check("1 …and the mail's test address → back to the test host, leaving production asks the worker to go",
      json.load(open(P["vault"]))["live"] is False and popen == [["py", P["worker"], "--uninstall"]], popen)
popen.clear()


def failing_icacls(path, *a):
    if os.path.basename(path).endswith(".tmp"):
        raise OSError("icacls exit 5")


cc._icacls = failing_icacls
r = refused(lambda: pc.divert_credentials(dict(BIND, president_password="other")), "VAULT_FAILED")
check("1 a failed ACL refuses the bind and deletes the plaintext tmp",
      r is True and not [f for f in os.listdir(P["cred"]) if f.endswith(".tmp")], r)
check("1 …the old vault stays as it was", json.load(open(P["vault"]))["president_password"] == "trade-pw")
cc._icacls = fake_icacls
open(P["pfx"], "wb").write(b"PFX")
pc._write_vault(dict(vault, president_ca_password="ca-pw"))
pc.divert_credentials(dict(BIND, president_password="new-pw"))
check("1 rebind, same account: the uploaded certificate and its password stay",
      os.path.isfile(P["pfx"]) and json.load(open(P["vault"])).get("president_ca_password") == "ca-pw")
pc.divert_credentials(dict(BIND, president_account="70000099999"))
check("1 rebind, another account: that account's certificate is deleted, its password not carried",
      not os.path.exists(P["pfx"]) and "president_ca_password" not in json.load(open(P["vault"])))

# ── 2. unbind ──
open(P["pfx"], "wb").write(b"PFX")
open(P["key"], "w").write("{}")
for d in ("logs", "legacy_logs"):
    os.makedirs(os.path.join(P[d], "logs"), exist_ok=True)
    open(os.path.join(P[d], "logs", "unitrade.log"), "w").write("login A123456789")
check("2 the connect side and the lib agree on where the SDK logs go (credentials\\, next to the vault)",
      P["logs"] == pv.SDK_LOG_DIR and os.path.dirname(pv.SDK_LOG_DIR) == os.path.dirname(pv.VAULT) == P["cred"])
pc._update("setup", status="ok")
pc.drop_vault(["OKX_API_KEY", "capital_password"])
check("2 other venues' names leave 統一 alone", os.path.exists(P["vault"]) and os.path.exists(P["pfx"]) and not popen)
pc.drop_vault(["PRESIDENT_ACCOUNT"])
check("2 統一's names: vault, pfx, pending key and status gone",
      not any(os.path.exists(P[k]) for k in ("vault", "pfx", "key", "status")))
check("2 …and the SDK logs (the login id is the national id), under credentials\\ and the old state/ spot",
      not os.path.exists(P["logs"]) and not os.path.exists(P["legacy_logs"]))
check("2 …and the worker service is asked to remove itself (not waited for)",
      popen == [["py", P["worker"], "--uninstall"]], popen)
creds_gone = None
try:
    pv.resolve()
except Exception as e:
    creds_gone = type(e).__name__
check("2 after unbind the lib cannot log in on the leftovers (vault unreadable)", creds_gone is not None, creds_gone)
pc.IS_WINDOWS = False
popen.clear()
pc.drop_vault()
check("2 off Windows no service call", not popen)
pc.IS_WINDOWS = True

# ── 3. dispatch ──


class D:
    def __init__(self, fn, cleanup=None):
        self.fn, self.cleanup = fn, cleanup


check("3 desktop refused", refused(lambda: pc.dispatch("president_setup", {}, D, local=True), "LOCAL_MODE") is True)
pc.IS_WINDOWS = False
check("3 not Windows refused", refused(lambda: pc.dispatch("president_setup", {}, D), "NOT_WINDOWS") is True)
pc.IS_WINDOWS = True
check("3 a key before the bind → NOT_BOUND", refused(lambda: pc.dispatch("president_pfx_key", {}, D), "NOT_BOUND") is True)
pc.divert_credentials(dict(BIND))
check("3 a login before the certificate → CERT_MISSING (never a CERT block in the lib)",
      refused(lambda: pc.dispatch("president_probe", {}, D), "CERT_MISSING") is True
      and refused(lambda: pc.dispatch("president_finish", {}, D), "CERT_MISSING") is True)
open(P["pfx"], "wb").write(b"PFX")
check("3 a certificate file whose password never reached the vault → CERT_MISSING (it would log in with \"\")",
      refused(lambda: pc.dispatch("president_probe", {}, D), "CERT_MISSING") is True
      and refused(lambda: pc.dispatch("president_finish", {}, D), "CERT_MISSING") is True)
pc._write_vault(dict(json.load(open(P["vault"])), president_ca_password=""))
d0 = pc.dispatch("president_probe", {}, D)
check("3 …with its password in the vault (an empty one is a password) the probe runs", isinstance(d0, D))
d0.cleanup()
os.remove(P["pfx"])
check("3 args: no-arg steps refuse args (the probe too — no after_unlock any more); pfx needs key_id + envelope",
      refused(lambda: pc.dispatch("president_setup", {"x": 1}, D), "BAD_ARGS") is True
      and refused(lambda: pc.dispatch("president_finish", {"x": 1}, D), "BAD_ARGS") is True
      and refused(lambda: pc.dispatch("president_probe", {"after_unlock": True}, D), "BAD_ARGS") is True
      and refused(lambda: pc.dispatch("president_pfx", {"key_id": "x"}, D), "BAD_ARGS") is True
      and refused(lambda: pc.dispatch("president_pfx_local", {}, D), "BAD_ARGS") is True
      and refused(lambda: pc.dispatch("president_pfx_key", {"x": 1}, D), "BAD_ARGS") is True
      and refused(lambda: pc.dispatch("president_nope", {}, D), "BAD_ARGS") is True)
d1 = pc.dispatch("president_setup", {}, D)
check("3 a second long step while one runs → BUSY",
      refused(lambda: pc.dispatch("president_setup", {}, D), "BUSY") is True
      and pc.read_status()["busy"] == "president_setup")
before = open(P["vault"]).read()
check("3 a bind while a step runs → BUSY, the vault untouched (president_pfx would write it back over the bind)",
      refused(lambda: pc.divert_credentials(dict(BIND, president_password="mid-step")), "BUSY") is True
      and open(P["vault"]).read() == before)
d1.cleanup()
check("3 cleanup releases it", pc.read_status()["busy"] is None)
pc._update("cert", status="importing")
pc._update(busy="president_pfx")
d2 = pc.dispatch("president_setup", {}, D)
st = pc.read_status()
check("3 an interrupted step is swept: section → failed INTERRUPTED, the new step runs",
      st["cert"]["status"] == "failed" and st["cert"]["error"] == "INTERRUPTED" and st["busy"] == "president_setup", st)
d2.cleanup()

# ── 4. probe / finish ──
for kind, state in (("CERT_MISMATCH", "cert_mismatch"), ("CERT", "cert"), ("PASSWORD", "password"),
                    ("MAINTENANCE", "maintenance"), ("TIMEOUT", "timeout"), ("UNKNOWN", "unknown")):
    err = pv.sanitize(f"LoginError: {pv.LoginError(kind)}")
    got = pc.probe_state({"ok": False, "error": err, "read_at": 1}, 2)
    check(f"4 lib {kind} → {state}, no text", got == {"state": state}, got)
check("4 ok: only booleans pass (no equity figure, no account)",
      pc.probe_state({"ok": True, "equity": 123.0, "account_fp": "x", "positions": [1], "test_mode": False}, 0)
      == {"state": "ok", "equity_read": True, "test_mode": False})
check("4 credentials missing → no_credentials; no file → timeout / unknown",
      pc.probe_state({"ok": False, "error": "ValueError: president_account / president_password missing from .env"}, 2)
      == {"state": "no_credentials"} and pc.probe_state(None, None) == {"state": "timeout"}
      and pc.probe_state(None, 0) == {"state": "unknown"})


class _R:
    def __init__(self, rc):
        self.returncode = rc


runs = []


def fake_run(argv, timeout, what, answers={}):
    runs.append(argv[1:])
    flag = argv[2]
    if flag == "--once" and answers.get("probe") is not None:
        json.dump(answers["probe"], open(P["probe"], "w"))
    return _R(answers.get(flag, 0))


cc._run_quiet = lambda argv, timeout, what: fake_run(argv, timeout, what, ANS)
ANS = {"probe": {"ok": True, "equity": 1.0, "read_at": time.time() + 5, "test_mode": True}}
check("4 probe ok, and it says which environment it logged in to",
      pc.run_probe() == {"state": "ok", "equity_read": True, "test_mode": True, "env": "test"}
      and runs[-1] == [P["worker"], "--once"] and pc.read_status()["probe"]["env"] == "test")
check("4 finish on the test host → TEST_ENV (the worker never runs there), even after a passed test probe",
      refused(pc.run_finish, "TEST_ENV") is True)
pc._write_vault(dict(json.load(open(P["vault"])), live=True))
ANS = {"probe": None}
json.dump({"ok": True, "read_at": time.time() - 3600}, open(P["probe"], "w"))
check("4 a probe file older than this run is not trusted", pc.run_probe()["state"] == "unknown")
runs.clear()
ANS = {"probe": {"ok": False, "error": pv.sanitize(f"LoginError: {pv.LoginError('PASSWORD')}"),
                 "read_at": time.time() + 5}}
st = pc.run_probe()
check("4 the probe is the user's 「確認登入」: --once only (one real login; no --unblock exists)", runs == [[P["worker"], "--once"]]
      and st == {"state": "password", "env": "live"}, runs)
check("4 finish without a passed probe → PROBE_NOT_OK", refused(pc.run_finish, "PROBE_NOT_OK") is True)
pc._update("probe", state="ok", env="test")
check("4 finish after a probe that passed on the test host → PROBE_NOT_OK", refused(pc.run_finish, "PROBE_NOT_OK") is True)
pc._update("probe", state="ok", env="live")
runs.clear()
ANS = {"--install": 0}
check("4 finish runs --install", pc.run_finish() == {"worker": "ok"} and runs == [[P["worker"], "--install"]])
ANS = {"--install": 2}
check("4 an install that did not get a good snapshot → WORKER_FAILED",
      refused(pc.run_finish, "WORKER_FAILED") is True and pc.read_status()["worker"]["error"] == "WORKER_FAILED")

import command_listener as cl  # noqa: E402
import local_daemon  # noqa: E402
check("4 command_listener routes every name; the desktop daemon refuses them",
      all(n in cl.HANDLERS for n in pc.COMMANDS) and set(pc.COMMANDS) <= local_daemon.CLOUD_ONLY)
fixture = json.load(open(os.path.join(ROOT, "tests", "fixtures", "api_agent_command_allowed.json")))["allowed"]
check("4 the api allow-list copy carries them all", set(pc.COMMANDS) <= set(fixture))

# command_listener end to end: bind, unbind by two names, eviction by another venue
cl.president_connect.IS_WINDOWS = True
cl.capital_connect.IS_WINDOWS = False
cl._local_mode = lambda: False
cl._write_ui_cred_manifest = lambda lines: None
cl._bind_book_accounts = lambda ids: {}
cl._unpark_account_state = lambda ident: None
cl._sync_strategy_crons = lambda names: None
os.remove(os.path.join(WS, ".env"))
cl._in_workspace(cl._cmd_credentials, {"env": dict(BIND)})
env_text = open(os.path.join(WS, ".env")).read()
check("4 _cmd_credentials writes the sentinels, never the password; it reads as a bound president",
      "president_password=vault:" in env_text and "trade-pw" not in env_text
      and "president_url=https://viploginm.pfctrade.com" in env_text
      and "president_test_url=https://test167.testpfctrade.com" in env_text
      and cl._venue_cred_ids(env_text.splitlines()) == {"PRESIDENT"}, env_text)
open(os.path.join(WS, ".env"), "a").write("PRESIDENT_LIVE=true\npresident_test_url=https://x.testpfctrade.com\n")
popen.clear()
cl._in_workspace(cl._cmd_credentials_remove, {"env": ["president_account", "president_password"]})
env_text = open(os.path.join(WS, ".env")).read()
check("4 unbind by the two form names: all of 統一's lines go, and the vault + certificate",
      "president_" not in env_text.lower() and not os.path.exists(P["vault"]) and popen, env_text)
cl._in_workspace(cl._cmd_credentials, {"env": dict(BIND)})
open(P["pfx"], "wb").write(b"PFX")
cl._withdraw_gate = lambda *a, **k: None
cl._in_workspace(cl._cmd_credentials, {"env": {"FOO_API_KEY": "k", "FOO_SECRET_KEY": "s"}})
check("4 binding another venue evicts 統一 and drops its vault (the production switch) and certificate",
      not os.path.exists(P["vault"]) and not os.path.exists(P["pfx"])
      and "president_" not in open(os.path.join(WS, ".env")).read())

# ── 6. upload write order and a bind racing it (no cryptography needed: envelope and check stubbed) ──
real = {"open_envelope": cc.open_envelope, "inspect_pfx": pc.inspect_pfx, "run_probe": pc.run_probe,
        "_write_private": pc._write_private}
cc.open_envelope = lambda key_id, envelope, key_path=None: (b"NEWPFX", "ca-new")
pc.inspect_pfx = lambda pfx, password: {"not_after": "2027-01-01T00:00:00Z", "not_after_ts": 0, "issuer_checked": False}
pc.run_probe = lambda push=None, after_unlock=False: {"state": "ok"}
ARGS = {"key_id": "k", "envelope": {}}


def write_private_hook(on_pfx=None, fail_vault=False):
    def w(path, data):
        if path == P["vault"] and fail_vault:
            raise OSError("disk full")
        real["_write_private"](path, data)
        if path == P["pfx"] and on_pfx:
            on_pfx()
    return w


pc.divert_credentials(dict(BIND))
pc._write_private = write_private_hook(fail_vault=True)
r = refused(lambda: pc.run_pfx(ARGS), "VAULT_FAILED")
check("6 the vault write fails after the certificate landed → the certificate is removed (no login on the old/no password)",
      r is True and not os.path.exists(P["pfx"]) and "president_ca_password" not in json.load(open(P["vault"])), r)
check("6 …and the probe gate refuses", refused(lambda: pc.dispatch("president_probe", {}, D), "CERT_MISSING") is True)


def other_process_rebinds_same_account():
    real["_write_private"](P["vault"], json.dumps({"president_password": "changed-elsewhere", "live": True,
                                                   "account_fp": pc.account_fp(BIND["president_account"])}).encode())


pc._write_private = write_private_hook(on_pfx=other_process_rebinds_same_account)
pc.run_pfx(ARGS)
v = json.load(open(P["vault"]))
check("6 a same-account rebind from another process mid-upload is kept; only the certificate password is added",
      v["president_password"] == "changed-elsewhere" and v["president_ca_password"] == "ca-new"
      and open(P["pfx"], "rb").read() == b"NEWPFX", v)


def other_process_binds_another_account():
    real["_write_private"](P["vault"], json.dumps({"president_password": "x", "live": True,
                                                   "account_fp": pc.account_fp("70000099999")}).encode())


pc.divert_credentials(dict(BIND))
pc._write_private = write_private_hook(on_pfx=other_process_binds_another_account)
r = refused(lambda: pc.run_pfx(ARGS), "REBOUND")
v = json.load(open(P["vault"]))
check("6 another account bound mid-upload → REBOUND: the certificate removed, the new account's vault left alone",
      r is True and not os.path.exists(P["pfx"]) and "president_ca_password" not in v and v["president_password"] == "x", r)
cc.open_envelope = real["open_envelope"]
pc.inspect_pfx, pc.run_probe, pc._write_private = real["inspect_pfx"], real["run_probe"], real["_write_private"]
pc.drop_vault()

# ── 5. upload ──
try:
    import cryptography  # noqa: F401
    HAVE_CRYPTO = True
except ImportError:
    HAVE_CRYPTO = False
    print(f"SKIP  §5 — no `cryptography` in {sys.executable} (try /usr/bin/python3)")

if HAVE_CRYPTO:
    from cryptography import x509
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import padding, rsa
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    from cryptography.hazmat.primitives.serialization import pkcs12
    from cryptography.x509.oid import NameOID

    def make_pfx(password, days=365, ou="PSC", issuer_o="Some CA"):
        key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
        name = x509.Name([x509.NameAttribute(NameOID.ORGANIZATION_NAME, issuer_o),
                          x509.NameAttribute(NameOID.ORGANIZATIONAL_UNIT_NAME, ou),
                          x509.NameAttribute(NameOID.COMMON_NAME, "TWZ1234567891")])
        now = datetime.datetime.now(datetime.timezone.utc)
        start = now - datetime.timedelta(days=400) if days < 0 else now - datetime.timedelta(days=1)
        cert = (x509.CertificateBuilder().subject_name(name).issuer_name(name).public_key(key.public_key())
                .serial_number(x509.random_serial_number()).not_valid_before(start)
                .not_valid_after(now + datetime.timedelta(days=days)).sign(key, hashes.SHA256()))
        enc = serialization.BestAvailableEncryption(password.encode()) if password else serialization.NoEncryption()
        return pkcs12.serialize_key_and_certificates(b"c", key, cert, None, enc)

    def seal(k, pfx, password):
        pub = serialization.load_der_public_key(base64.b64decode(k["spki"]))
        aes, iv = AESGCM.generate_key(256), os.urandom(12)
        pt = json.dumps({"pfx": base64.b64encode(pfx).decode(), "password": password}).encode()
        ct = AESGCM(aes).encrypt(iv, pt, k["key_id"].encode())
        ek = pub.encrypt(aes, padding.OAEP(mgf=padding.MGF1(hashes.SHA256()), algorithm=hashes.SHA256(), label=None))
        b = lambda x: base64.b64encode(x).decode()  # noqa: E731
        return {"key_id": k["key_id"], "envelope": {"v": 1, "alg": cc.ALG, "ek": b(ek), "iv": b(iv), "ct": b(ct)}}

    probes = []
    pc.run_probe = lambda push=None, after_unlock=False: probes.append(1) or {"state": "ok"}
    pc.divert_credentials(dict(BIND))
    open(cc._paths()["key"], "w").write("capital-key")
    PFX = make_pfx("ca-pw")
    k = pc.dispatch("president_pfx_key", {}, D)
    check("5 統一's one-time key has its own file; 群益's is untouched",
          os.path.isfile(P["key"]) and open(cc._paths()["key"]).read() == "capital-key")
    r = pc.run_pfx(seal(k, PFX, "ca-pw"))
    v = json.load(open(P["vault"]))
    check("5 upload: the pfx lands under the fixed name with the uploaded bytes, its password in the vault, then the probe",
          open(P["pfx"], "rb").read() == PFX and v["president_ca_password"] == "ca-pw" and v["live"] is False
          and probes == [1] and r["probe"] == {"state": "ok"} and not os.path.exists(P["key"]))
    check("5 the certificate's subject (national id) is nowhere in the result or the status",
          "Z1234567891" not in json.dumps(r) and "Z1234567891" not in json.dumps(pc.read_status()))
    check("5 issuer marks are placeholders until Wei supplies them (issuer_checked false, said so)",
          pc.CERT_ISSUER_MARK is None and pc.CERT_OU_MARK is None and r["cert"]["issuer_checked"] is False
          and pc.read_status()["cert"]["source"] == "upload")
    check("5 the key is spent: the same envelope again → KEY_EXPIRED",
          refused(lambda: pc.run_pfx(seal(k, PFX, "ca-pw")), "KEY_EXPIRED") is True)
    os.remove(P["pfx"])
    probes.clear()
    k = cc.cmd_pfx_key({}, key_path=P["key"])
    check("5 a wrong certificate password → PFX_PASSWORD, nothing written, no login",
          refused(lambda: pc.run_pfx(seal(k, PFX, "wrong")), "PFX_PASSWORD") is True
          and not os.path.exists(P["pfx"]) and not probes and pc.read_status()["cert"]["error"] == "PFX_PASSWORD")
    for label, data, pw, code in (("expired", make_pfx("p", days=-1), "p", "PFX_EXPIRED"),
                                  ("not a certificate", b"0" * 64, "p", "PFX_INVALID")):
        k = cc.cmd_pfx_key({}, key_path=P["key"])
        check(f"5 {label} → {code}", refused(lambda: pc.run_pfx(seal(k, data, pw)), code) is True
              and not os.path.exists(P["pfx"]))
    k = cc.cmd_pfx_key({}, key_path=P["key"])
    pc.run_pfx(seal(k, make_pfx(""), ""))
    check("5 a certificate without a password is accepted", os.path.isfile(P["pfx"])
          and json.load(open(P["vault"]))["president_ca_password"] == "")
    pc.CERT_OU_MARK = "Not This OU"
    k = cc.cmd_pfx_key({}, key_path=P["key"])
    check("5 once the marks are set a foreign certificate → PFX_NOT_PRESIDENT",
          refused(lambda: pc.run_pfx(seal(k, PFX, "ca-pw")), "PFX_NOT_PRESIDENT") is True)
    pc.CERT_OU_MARK = None
    pc.drop_vault()
    k = cc.cmd_pfx_key({}, key_path=P["key"])
    check("5 an upload after unbind → NOT_BOUND, no file", refused(lambda: pc.run_pfx(seal(k, PFX, "ca-pw")), "NOT_BOUND") is True
          and not os.path.exists(P["pfx"]))

# ── 7. president_pfx_local (no cryptography needed: envelope stubbed, inspect_pfx keyed on the bytes) ──
import contextlib  # noqa: E402
import io  # noqa: E402

LOCAL = os.path.join(TMP, "PSCCA")
pc.LOCAL_CERT_DIR = LOCAL
NID = "A123456789"
real = {"open_envelope": cc.open_envelope, "inspect_pfx": pc.inspect_pfx, "run_probe": pc.run_probe}
SENT = {"pfx": b""}
cc.open_envelope = lambda key_id, envelope, key_path=None: (SENT["pfx"], "ca-pw")


def fake_inspect(pfx, password):  # the real one is §5's; here the bytes say what it would conclude
    kind = pfx.split(b":", 1)[0]
    if kind == b"EXPIRED":
        pc._refuse("PFX_EXPIRED", "this certificate has expired — renew it first")
    if kind != b"OK" or password != "ca-pw":
        pc._refuse("PFX_PASSWORD", "the certificate password does not open this file")
    return {"not_after": "2027-10-01T00:00:00Z", "not_after_ts": 0, "issuer_checked": False}


pc.inspect_pfx = fake_inspect
probes = []
pc.run_probe = lambda push=None, after_unlock=False: probes.append(1) or {"state": "ok"}


def put(name, data, age_days):
    os.makedirs(LOCAL, exist_ok=True)
    path = os.path.join(LOCAL, name)
    open(path, "wb").write(data)
    t = time.time() - age_days * 86400
    os.utime(path, (t, t))
    return path


def run_local():
    """→ (result or the refusal code, everything that left: result, status, error text, stdout/stderr)."""
    out = io.StringIO()
    with contextlib.redirect_stdout(out), contextlib.redirect_stderr(out):
        try:
            got = pc.run_pfx_local(ARGS)
            err = ""
        except Exception as e:
            got, err = str(e).split(":", 1)[0], f"{type(e).__name__}: {e}"
    return got, json.dumps(got, default=str) + json.dumps(pc.read_status()) + err + out.getvalue()


def reset_local():
    shutil.rmtree(LOCAL, ignore_errors=True)
    for path in (P["pfx"],):
        if os.path.exists(path):
            os.remove(path)
    probes.clear()


pc.divert_credentials(dict(BIND))
reset_local()
got, leak = run_local()
check("7 no folder → PFX_NONE_FOUND, nothing written, no login",
      got == "PFX_NONE_FOUND" and not os.path.exists(P["pfx"]) and not probes
      and pc.read_status()["cert"] == dict(pc.read_status()["cert"], status="failed", error="PFX_NONE_FOUND", source="local"), got)
put("readme.txt", b"OK:x", 0)
put(f"PSC_{NID}_20271001.PFX.bak", b"OK:x", 0)
got, _ = run_local()
check("7 a folder with no .pfx in it → PFX_NONE_FOUND", got == "PFX_NONE_FOUND", got)
reset_local()
put(f"PSC_{NID}_20271001.pfx", b"OTHER:" + NID.encode(), 0)
got, leak = run_local()
check("7 the password opens none → PFX_PASSWORD, nothing written, no login",
      got == "PFX_PASSWORD" and not os.path.exists(P["pfx"]) and not probes, got)
check("7 …the file name is in no result, status, error or output", NID not in leak and "PSC_" not in leak, leak)
reset_local()
put(f"PSC_{NID}_20251001.pfx", b"EXPIRED:", 0)
got, leak = run_local()
check("7 only an expired one → PFX_EXPIRED", got == "PFX_EXPIRED" and not os.path.exists(P["pfx"]) and NID not in leak, got)
put(f"PSC_{NID}_20271001.pfx", b"OTHER:", 0)
got, _ = run_local()
check("7 none passes → the newest one's reason (a renewed file the password does not open: PFX_PASSWORD, not the old one's expiry)",
      got == "PFX_PASSWORD", got)
reset_local()
put(f"PSC_{NID}_20251001.pfx", b"EXPIRED:last-year", 1)
older = put(f"PSC_{NID}_20241001.pfx", b"OK:older", 400)
newest_ok = put(f"PSC_{NID}_20271001.pfx", b"OK:renewed", 3)
put(f"PSC_{NID}_other.pfx", b"OTHER:", 0)
outside = os.path.join(TMP, "elsewhere.pfx")
open(outside, "wb").write(b"OK:outside")
os.symlink(outside, os.path.join(LOCAL, "zz_link.pfx"))
got, leak = run_local()
v = json.load(open(P["vault"]))
check("7 several: the newest one that opens and has not expired is copied under the fixed name, then the probe"
      " (a newer link pointing out of the folder is not followed)",
      isinstance(got, dict) and open(P["pfx"], "rb").read() == b"OK:renewed" and v["president_ca_password"] == "ca-pw"
      and probes == [1] and got["probe"] == {"state": "ok"} and pc.read_status()["cert"]["source"] == "local", got)
check("7 …copied, not moved: every original is still where 憑證e總管 left it (next year's renewal)",
      open(newest_ok, "rb").read() == b"OK:renewed" and len([n for n in os.listdir(LOCAL) if n.endswith(".pfx")]) == 5
      and open(outside, "rb").read() == b"OK:outside")
check("7 …the file name is in no result, status or output", NID not in leak and "PSC_" not in leak, leak)
os.chmod(newest_ok, 0)
unreadable = not os.access(newest_ok, os.R_OK)
os.remove(P["pfx"])
probes.clear()
got, leak = run_local()
if unreadable:  # root reads anything; then the case says nothing
    check("7 a file it cannot read is skipped, never an OSError with the path: the next one that opens is taken",
          isinstance(got, dict) and open(P["pfx"], "rb").read() == b"OK:older" and NID not in leak, leak)
os.chmod(newest_ok, 0o600)
reset_local()
put(f"PSC_{NID}_20271001.pfx", b"OK:renewed", 0)
SENT["pfx"] = b"PFX-IN-THE-ENVELOPE"
got, _ = run_local()
check("7 a file inside the envelope → ENVELOPE_INVALID (this step takes the password only), nothing written",
      got == "ENVELOPE_INVALID" and not os.path.exists(P["pfx"]) and not probes, got)
SENT["pfx"] = b""
pc.drop_vault()
got, _ = run_local()
check("7 before the bind → NOT_BOUND, nothing copied", got == "NOT_BOUND" and not os.path.exists(P["pfx"]), got)
pc.divert_credentials(dict(BIND))
d7 = pc.dispatch("president_pfx_local", {"key_id": "ab" * 16, "envelope": {
    "v": 1, "alg": cc.ALG, "ek": "QUJD", "iv": "AAAA", "ct": "Y3Q="}}, D)
check("7 dispatch: same args check and the same one-step lock as president_pfx",
      isinstance(d7, D) and refused(lambda: pc.dispatch("president_pfx", {}, D), "BAD_ARGS") is True
      and refused(lambda: pc.dispatch("president_setup", {}, D), "BUSY") is True)
d7.cleanup()
cc.open_envelope = real["open_envelope"]
pc.inspect_pfx, pc.run_probe = real["inspect_pfx"], real["run_probe"]
pc.drop_vault()
reset_local()

if HAVE_CRYPTO:
    pc.run_probe = lambda push=None, after_unlock=False: {"state": "ok"}
    pc.divert_credentials(dict(BIND))
    put(f"PSC_{NID}_20251001.pfx", make_pfx("ca-pw", days=-1), 1)
    good = make_pfx("ca-pw")
    put(f"PSC_{NID}_20271001.pfx", good, 2)
    put(f"PSC_{NID}_new-other-pw.pfx", make_pfx("not-this-one"), 0)
    k = pc.dispatch("president_pfx_key", {}, D)
    body = seal(k, b"", "ca-pw")
    r = pc.run_pfx_local(body)
    check("7 real certificates: newest opens with another password, next is good, oldest expired → the good one copied",
          open(P["pfx"], "rb").read() == good and json.load(open(P["vault"]))["president_ca_password"] == "ca-pw"
          and not os.path.exists(P["key"]) and "Z1234567891" not in json.dumps(r) + json.dumps(pc.read_status()))
    pc.run_probe = real["run_probe"]
    pc.drop_vault()

shutil.rmtree(TMP, ignore_errors=True)
print("PASS" if not fails else f"FAIL {len(fails)}")
sys.exit(1 if fails else 0)
