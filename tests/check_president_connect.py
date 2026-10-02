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
     is not trusted; after_unlock runs --unblock first and stops on a spent release; finish needs a
     passed probe
  5. upload (needs `cryptography`): the envelope opens once with 統一's own key file (群益's is not
     touched); a wrong certificate password is refused before anything is written (no broker
     contact); the pfx lands under the fixed name with the uploaded bytes, its password in the
     vault; expired / not a certificate refused; the issuer marks are placeholders until Wei
     supplies them (issuer_checked false), and once set they refuse a foreign certificate

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
check("1 a write without the password (or with a sentinel) is not diverted",
      pc.divert_credentials({"president_account": "1"}) == {"president_account": "1"}
      and pc.divert_credentials({"president_account": "1", "president_password": "vault:x"})
      == {"president_account": "1", "president_password": "vault:x"})
out = pc.divert_credentials(dict(BIND, OTHER="1"))
vault = json.load(open(P["vault"]))
check("1 .env gets the account, sentinels, the fixed certificate path and the production host",
      out == {"OTHER": "1", "president_account": "70000011234",
              "president_password": "vault:" + pc.vault_fingerprint("70000011234", "trade-pw"),
              "president_ca_password": "vault:ca", "president_ca_path": P["pfx"],
              "president_url": "https://viploginm.pfctrade.com"}, out)
check("1 the vault: the password and the production switch", vault == {
    "president_password": "trade-pw", "live": True, "account_fp": pc.account_fp("70000011234")}, vault)
check("1 no secret in .env", "trade-pw" not in json.dumps(out))
check("1 credentials\\ locked before any plaintext tmp exists",
      acl and acl[0][0] == "credentials" and acl[0][1][0] == "/inheritance:r" and acl[0][2] is False, acl[:1])
check("1 vault ACL: SYSTEM + Administrators read it (worker = LocalSystem, reconciler = Administrator), before the rename",
      [a for f, a, _ in acl if f.startswith("president_vault.json.") and f.endswith(".tmp")]
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
check("1 the shipped lib resolves the bind: production on, password from the vault, the fixed pfx path",
      creds["live"] is True and creds["password"] == "trade-pw" and creds["url"] == "https://viploginm.pfctrade.com"
      and creds["ca_path"] == P["pfx"] and creds["ca_password"] == "", {k: v for k, v in creds.items() if k != "password"})


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
pc._update("setup", status="ok")
pc.drop_vault(["OKX_API_KEY", "capital_password"])
check("2 other venues' names leave 統一 alone", os.path.exists(P["vault"]) and os.path.exists(P["pfx"]) and not popen)
pc.drop_vault(["PRESIDENT_ACCOUNT"])
check("2 統一's names: vault, pfx, pending key and status gone",
      not any(os.path.exists(P[k]) for k in ("vault", "pfx", "key", "status")))
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
check("3 args: no-arg steps refuse args; probe takes only {after_unlock: true}; pfx needs key_id + envelope",
      refused(lambda: pc.dispatch("president_setup", {"x": 1}, D), "BAD_ARGS") is True
      and refused(lambda: pc.dispatch("president_finish", {"x": 1}, D), "BAD_ARGS") is True
      and refused(lambda: pc.dispatch("president_probe", {"after_unlock": 1}, D), "BAD_ARGS") is True
      and refused(lambda: pc.dispatch("president_pfx", {"key_id": "x"}, D), "BAD_ARGS") is True
      and refused(lambda: pc.dispatch("president_pfx_key", {"x": 1}, D), "BAD_ARGS") is True
      and refused(lambda: pc.dispatch("president_nope", {}, D), "BAD_ARGS") is True)
d1 = pc.dispatch("president_setup", {}, D)
check("3 a second long step while one runs → BUSY",
      refused(lambda: pc.dispatch("president_setup", {}, D), "BUSY") is True
      and pc.read_status()["busy"] == "president_setup")
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
                    ("BLOCKED", "blocked"), ("MAINTENANCE", "maintenance"), ("HOST", "host"),
                    ("TIMEOUT", "timeout"), ("UNKNOWN", "unknown")):
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
ANS = {"probe": {"ok": True, "equity": 1.0, "read_at": time.time() + 5, "test_mode": False}}
check("4 probe ok", pc.run_probe() == {"state": "ok", "equity_read": True, "test_mode": False}
      and runs[-1] == [P["worker"], "--once"])
ANS = {"probe": None}
json.dump({"ok": True, "read_at": time.time() - 3600}, open(P["probe"], "w"))
check("4 a probe file older than this run is not trusted", pc.run_probe()["state"] == "unknown")
runs.clear()
ANS = {"probe": {"ok": False, "error": pv.sanitize(f"LoginError: {pv.LoginError('PASSWORD')}"),
                 "read_at": time.time() + 5}}
st = pc.run_probe(after_unlock=True)
check("4 after_unlock: --unblock first, then the probe", runs == [[P["worker"], "--unblock"], [P["worker"], "--once"]]
      and st == {"state": "password"}, runs)
runs.clear()
ANS = {"--unblock": 2}
check("4 a spent release → UNBLOCK_USED, no login", refused(lambda: pc.run_probe(after_unlock=True), "UNBLOCK_USED") is True
      and runs == [[P["worker"], "--unblock"]])
check("4 finish without a passed probe → PROBE_NOT_OK", refused(pc.run_finish, "PROBE_NOT_OK") is True)
pc._update("probe", state="ok")
runs.clear()
ANS = {"--install": 0}
check("4 finish runs --install", pc.run_finish() == {"worker": "ok"} and runs == [[P["worker"], "--install"]])
ANS = {"--install": 2}
check("4 an install that did not get a good snapshot → WORKER_FAILED",
      refused(pc.run_finish, "WORKER_FAILED") is True and pc.read_status()["worker"]["error"] == "WORKER_FAILED")

import command_listener as cl  # noqa: E402
import local_daemon  # noqa: E402
check("4 command_listener routes the five names; the desktop daemon refuses them",
      all(n in cl.HANDLERS for n in pc.COMMANDS) and set(pc.COMMANDS) <= local_daemon.CLOUD_ONLY)
fixture = json.load(open(os.path.join(ROOT, "tests", "fixtures", "api_agent_command_allowed.json")))["allowed"]
check("4 the api allow-list copy carries the five", set(pc.COMMANDS) <= set(fixture))

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
          open(P["pfx"], "rb").read() == PFX and v["president_ca_password"] == "ca-pw" and v["live"] is True
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

shutil.rmtree(TMP, ignore_errors=True)
print("PASS" if not fails else f"FAIL {len(fails)}")
sys.exit(1 if fails else 0)
