"""群益 cloud connect (runtime/capital_connect.py + lib/capital_vault.py) — no network, no Windows.

  1. one-time key + envelope: a WebCrypto-shaped seal (RSA-OAEP-256 wrapping an AES-256-GCM key,
     AAD = key_id) opens once; the key file is gone after ANY attempt; replay, wrong id, expired
     key → KEY_EXPIRED; tampered ciphertext / wrong AAD → ENVELOPE_INVALID
  2. pfx check: a 群益-shaped pfx (AES and legacy 3DES/RC2 encodings) yields thumbprint / CN /
     not_after; wrong password → PFX_PASSWORD, garbage or truncated → PFX_INVALID, another
     issuer → PFX_NOT_CAPITAL, expired → PFX_EXPIRED, oversize → PFX_TOO_LARGE
  3. probe → state: every SKCOM code in CODE_STATES through the new `code` field AND through an
     old workspace's message-only error; exit/stage paths; no account number survives
  4. the store (fake Cert:\ in vehicle_import): nothing touched unless certutil lands the new cert with
     its key; same cert already there → no import; older same-ID + expired go only after; an upload
     older than what is there → PFX_OLDER
  5. vault: sentinels in .env, real values in the vault, only when the workspace libs read it;
     credentials\ locked before any plaintext; a failed ACL deletes the tmp; bind/unbind create no
     status file; the PRE-vault libs from git HEAD fail on the sentinels before any COM object;
     after 300/307 no login path (runtime, worker, order lib) retries the same credentials
  6. dispatch: local / non-Windows refused; one long step at a time (BUSY), released by cleanup; a step
     killed by a bridge restart is swept (stage deleted, section → INTERRUPTED) on the next command;
     command_listener routes all five names here and _cmd_credentials writes the sentinels

Needs `cryptography` (the machine gets it from capital_setup; /usr/bin/python3 on the dev Macs has it).
Run: cd blave-agent && /usr/bin/python3 tests/check_capital_connect.py
"""
import base64
import datetime
import hashlib
import json
import os
import shutil
import sys
import tempfile
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TMP = tempfile.mkdtemp(prefix="capcc-")
WS = os.path.join(TMP, "workspace")
os.makedirs(os.path.join(WS, "lib"))
os.makedirs(os.path.join(WS, "state"))
os.environ["BLAVE_AGENT_WORKSPACE"] = WS
sys.path.insert(0, os.path.join(ROOT, "runtime"))
sys.path.insert(0, ROOT)

from cryptography import x509  # noqa: E402
from cryptography.hazmat.primitives import hashes, serialization  # noqa: E402
from cryptography.hazmat.primitives.asymmetric import padding, rsa  # noqa: E402
from cryptography.hazmat.primitives.ciphers.aead import AESGCM  # noqa: E402
from cryptography.hazmat.primitives.serialization import pkcs12  # noqa: E402
from cryptography.x509.oid import NameOID  # noqa: E402

import capital_connect as cc  # noqa: E402

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


def seal(key_resp, pfx, password, aad=None):
    """What the app does (spec contract): WebCrypto RSA-OAEP(SHA-256) + AES-GCM, AAD = key_id."""
    pub = serialization.load_der_public_key(base64.b64decode(key_resp["spki"]))
    aes = AESGCM.generate_key(256)
    iv = os.urandom(12)
    pt = json.dumps({"pfx": base64.b64encode(pfx).decode(), "password": password}).encode()
    ct = AESGCM(aes).encrypt(iv, pt, (aad or key_resp["key_id"]).encode())
    ek = pub.encrypt(aes, padding.OAEP(mgf=padding.MGF1(hashes.SHA256()), algorithm=hashes.SHA256(), label=None))
    b = lambda x: base64.b64encode(x).decode()  # noqa: E731
    return {"v": 1, "alg": cc.ALG, "ek": b(ek), "iv": b(iv), "ct": b(ct)}


def make_pfx(password, cn="Z123456789", ou="The Capital Group", issuer_o="TaiCA Secure CA",
             days=365, legacy=False):
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    subject = x509.Name([x509.NameAttribute(NameOID.COUNTRY_NAME, "TW"),
                         x509.NameAttribute(NameOID.ORGANIZATION_NAME, issuer_o),
                         x509.NameAttribute(NameOID.ORGANIZATIONAL_UNIT_NAME, ou),
                         x509.NameAttribute(NameOID.COMMON_NAME, cn)])
    now = datetime.datetime.now(datetime.timezone.utc)
    start = now - datetime.timedelta(days=400) if days < 0 else now - datetime.timedelta(days=1)
    cert = (x509.CertificateBuilder().subject_name(subject).issuer_name(subject)
            .public_key(key.public_key()).serial_number(x509.random_serial_number())
            .not_valid_before(start).not_valid_after(now + datetime.timedelta(days=days))
            .sign(key, hashes.SHA256()))
    if legacy:
        enc = (serialization.PrivateFormat.PKCS12.encryption_builder()
               .key_cert_algorithm(pkcs12.PBES.PBESv1SHA1And3KeyTripleDESCBC)
               .hmac_hash(hashes.SHA1()).build(password.encode()))
    else:
        enc = serialization.BestAvailableEncryption(password.encode())
    return pkcs12.serialize_key_and_certificates(b"c", key, cert, None, enc), cert


# ── 1. one-time key + envelope ──
PFX, CERT = make_pfx("exp0rt-pw")
k = cc.cmd_pfx_key({})
key_file = cc._paths()["key"]
check("1 key: 32-hex id, alg, SPKI, 15-minute expiry, private half on disk",
      len(k["key_id"]) == 32 and k["alg"] == cc.ALG and k["expires_at"] - time.time() > 890
      and os.path.isfile(key_file))
env = seal(k, PFX, "exp0rt-pw")
cc.check_pfx_args({"key_id": k["key_id"], "envelope": env})
pfx, pw = cc.open_envelope(k["key_id"], env)
check("1 envelope opens to the same pfx bytes and export password", pfx == PFX and pw == "exp0rt-pw")
check("1 the key is gone after one use", not os.path.exists(key_file))
check("1 replay → KEY_EXPIRED", refused(lambda: cc.open_envelope(k["key_id"], env), "KEY_EXPIRED") is True)
k2 = cc.cmd_pfx_key({})
bad = dict(seal(k2, PFX, "x"), ct=base64.b64encode(b"\0" * 64).decode())
check("1 tampered ciphertext → ENVELOPE_INVALID", refused(lambda: cc.open_envelope(k2["key_id"], bad), "ENVELOPE_INVALID") is True)
check("1 …and that attempt consumed the key too", not os.path.exists(key_file))
k3 = cc.cmd_pfx_key({})
check("1 AAD bound to key_id: sealed for another id → ENVELOPE_INVALID",
      refused(lambda: cc.open_envelope(k3["key_id"], seal(k3, PFX, "x", aad="f" * 32)), "ENVELOPE_INVALID") is True)
k4 = cc.cmd_pfx_key({})
check("1 wrong key_id → KEY_EXPIRED", refused(lambda: cc.open_envelope("0" * 32, seal(k4, PFX, "x")), "KEY_EXPIRED") is True)
k5 = cc.cmd_pfx_key({})
rec = json.load(open(key_file))
rec["expires_at"] = int(time.time()) - 1
json.dump(rec, open(key_file, "w"))
check("1 expired key → KEY_EXPIRED", refused(lambda: cc.open_envelope(k5["key_id"], seal(k5, PFX, "x")), "KEY_EXPIRED") is True)
k6a, k6b = cc.cmd_pfx_key({}), cc.cmd_pfx_key({})
check("1 a newer key voids the older one", refused(lambda: cc.open_envelope(k6a["key_id"], seal(k6a, PFX, "x")), "KEY_EXPIRED") is True)
check("1 check_pfx_args refuses a shape the api would also refuse",
      all(refused(lambda a=a: cc.check_pfx_args(a), "BAD_ARGS") is True for a in (
          {}, {"key_id": "0" * 32}, {"key_id": "0" * 32, "envelope": dict(env, v=2)},
          {"key_id": "0" * 32, "envelope": dict(env, alg="RSA1_5")}, {"key_id": "Z" * 32, "envelope": env})))
check("1 a realistic 5.3KB pfx seals well under the api's 48KB capital_pfx ceiling",
      len(json.dumps({"cmd": "capital_pfx", "args": {"key_id": "0" * 32, "envelope": seal(
          cc.cmd_pfx_key({}), os.urandom(5268), "pw")}})) < 12 * 1024)

# ── 2. pfx check ──
meta = cc.inspect_pfx(PFX, "exp0rt-pw")
check("2 thumbprint = SHA-1 of the DER cert (what Cert:\\ lists), CN, not_after ISO",
      meta["thumbprint"] == hashlib.sha1(CERT.public_bytes(serialization.Encoding.DER)).hexdigest().upper()
      and meta["cn"] == "Z123456789" and meta["not_after"].endswith("Z"))
LEG, _ = make_pfx("pw", legacy=True)
check("2 legacy 3DES/SHA1 pfx (older Windows exports) opens", cc.inspect_pfx(LEG, "pw")["cn"] == "Z123456789")
check("2 wrong export password → PFX_PASSWORD", refused(lambda: cc.inspect_pfx(PFX, "nope"), "PFX_PASSWORD") is True)
check("2 garbage → PFX_INVALID", refused(lambda: cc.inspect_pfx(b"not a pfx at all", "x"), "PFX_INVALID") is True)
check("2 truncated → PFX_INVALID (not blamed on the password)",
      refused(lambda: cc.inspect_pfx(PFX[:-40], "exp0rt-pw"), "PFX_INVALID") is True)
OTHER, _ = make_pfx("pw", ou="Some Bank", issuer_o="Other CA")
check("2 another issuer → PFX_NOT_CAPITAL", refused(lambda: cc.inspect_pfx(OTHER, "pw"), "PFX_NOT_CAPITAL") is True)
OLD, _ = make_pfx("pw", days=-1)
check("2 expired → PFX_EXPIRED", refused(lambda: cc.inspect_pfx(OLD, "pw"), "PFX_EXPIRED") is True)
check("2 oversize → PFX_TOO_LARGE", refused(lambda: cc.inspect_pfx(b"0" * (cc.PFX_MAX_BYTES + 1), "x"), "PFX_TOO_LARGE") is True)

# ── 3. probe → state ──
ACCTS = {"futures": "F0000000963", "securities": "913Y0000329"}
for code, state in cc.CODE_STATES.items():
    new = cc.probe_state({"ok": False, "stage": "login", "code": code, "error": "x"}, 2)
    old = cc.probe_state({"ok": False, "stage": "login", "error": f"login failed code={code} msg"}, 2)
    check(f"3 {code} → {state} (code field and old message)",
          new["state"] == state == old["state"] and new["code"] == code == old["code"])
ok = cc.probe_state({"ok": True, "stage": "done", "accounts": ACCTS}, 0)
check("3 ok with both markets", ok == {"code": 0, "futures": True, "securities": True, "state": "ok"})
check("3 no account number in the state", "963" not in json.dumps(ok) and "329" not in json.dumps(ok))
ts_only = cc.probe_state({"ok": True, "accounts": {"futures": None, "securities": "x"}}, 0)
check("3 securities only → ok, futures false (w-done-ts)", ts_only["state"] == "ok" and not ts_only["futures"])
check("3 accounts stage without a code → no_accounts",
      cc.probe_state({"ok": False, "stage": "accounts", "error": "GetUserAccount returned no TF/TS accounts"}, 2)["state"] == "no_accounts")
check("3 exit 3 → timeout; setup/exit 1 → vehicle_failed; env → no_credentials; other → unknown",
      cc.probe_state(None, 3)["state"] == "timeout"
      and cc.probe_state({"ok": False, "stage": "setup", "error": "rdp_password.txt not found"}, 1)["state"] == "vehicle_failed"
      and cc.probe_state({"ok": False, "stage": "env", "error": "missing"}, 2)["state"] == "no_credentials"
      and cc.probe_state({"ok": False, "stage": "login", "code": 2017}, 2)["state"] == "unknown")
check("3 probe output line picked out of mixed stdout",
      cc._last_json('noise\n{"ok": true, "accounts": {}}\n') == {"ok": True, "accounts": {}}
      and cc._last_json('{\n  "ok": false,\n  "stage": "setup"\n}') == {"ok": False, "stage": "setup"})

# ── 4. which certs go (vehicle_import with a fake store) ──
NOW = int(time.time())
NEW = "A" * 40
certs = [{"t": NEW, "cn": "Z1", "expired": False, "exp": NOW + 300 * 86400, "key": True},
         {"t": "B" * 40, "cn": "Z1", "expired": False, "exp": NOW + 20 * 86400, "key": True},
         {"t": "C" * 40, "cn": "Y9", "expired": True, "exp": NOW - 86400, "key": True},
         {"t": "D" * 40, "cn": "Y9", "expired": False, "exp": NOW + 99 * 86400, "key": True}]
check("4 after import: same ID ending earlier + expired go; another ID's valid cert and the new one stay",
      sorted(cc.plan_removals(certs, NEW, "Z1", NOW + 300 * 86400)) == ["B" * 40, "C" * 40])
check("4 B-3 a same-ID cert ending LATER than the new one is never removed",
      cc.plan_removals(certs + [{"t": "F" * 40, "cn": "Z1", "expired": False, "exp": NOW + 900 * 86400, "key": False}],
                       NEW, "Z1", NOW + 300 * 86400).count("F" * 40) == 0)


def run_vehicle(store, new, certutil_rc=0):
    """vehicle_import against a fake Cert:\\CurrentUser\\My. Returns (result, removed, certutil_called)."""
    stage = tempfile.mkdtemp(dir=TMP)
    json.dump({"nonce": "n1", "thumbprint": new["t"], "cn": new["cn"], "not_after_ts": new["exp"]},
              open(os.path.join(stage, "meta.json"), "w"))
    open(os.path.join(stage, "c.pfx"), "wb").write(b"pfx")
    open(os.path.join(stage, "pw.txt"), "w").write("pw")
    store = [dict(c) for c in store]
    removed, called = [], []

    def certutil(pfx, pw):
        called.append(1)
        if certutil_rc == 0:
            store[:] = [c for c in store if c["t"] != new["t"]] + [dict(new, key=True)]
        return certutil_rc

    def remove(t):
        removed.append(t)
        store[:] = [c for c in store if c["t"] != t]

    saved = cc._list_capital_certs, cc._remove_cert, cc._certutil_import
    cc._list_capital_certs, cc._remove_cert, cc._certutil_import = (lambda: [dict(c) for c in store]), remove, certutil
    try:
        cc.vehicle_import(stage)
    finally:
        cc._list_capital_certs, cc._remove_cert, cc._certutil_import = saved
    left = sorted(os.listdir(stage))
    return json.load(open(os.path.join(stage, "result.json"))), removed, bool(called), left


GOOD_OLD = {"t": "B" * 40, "cn": "Z1", "expired": False, "exp": NOW + 20 * 86400, "key": True}
UPLOAD = {"t": NEW, "cn": "Z1", "expired": False, "exp": NOW + 300 * 86400}
res, removed, called, left = run_vehicle([GOOD_OLD], UPLOAD, certutil_rc=1)
check("4 B-2 certutil fails → nothing in the store is touched (the working cert stays)",
      not res["ok"] and removed == [] and called, f"{res} {removed}")
check("4 the pfx and its password are gone from the stage either way", left == ["meta.json", "result.json"], left)
res, removed, called, _ = run_vehicle([GOOD_OLD], UPLOAD)
check("4 success → the older cert of the same ID goes only now", res["ok"] and removed == ["B" * 40])
res, removed, called, _ = run_vehicle([dict(UPLOAD, key=True), GOOD_OLD], UPLOAD)
check("4 B-2 the same cert already here with its key → no import, nothing risked",
      res["ok"] and res.get("already") and not called and removed == ["B" * 40])
res, removed, called, _ = run_vehicle([dict(UPLOAD, key=False)], UPLOAD)
check("4 a keyless copy of the same cert is removed before the import (its broken key link survives otherwise)",
      res["ok"] and removed == [NEW] and called)
NEWER = {"t": "E" * 40, "cn": "Z1", "expired": False, "exp": NOW + 700 * 86400, "key": True}
res, removed, called, _ = run_vehicle([NEWER], UPLOAD)
check("4 B-3 upload older than the cert already here → PFX_OLDER, no import, nothing removed",
      res.get("error") == "PFX_OLDER" and not called and removed == [], f"{res} {removed}")

# ── 5. vault ──
lib = os.path.join(WS, "lib")
status_path = cc._paths()["status"]
check("5 libs without vault support → divert refuses to point them at it", not cc.lib_supports_vault())
cc.IS_WINDOWS = True
cc._kw = lambda **kw: kw  # CREATE_NO_WINDOW exists only on Windows
calls = []


def fake_icacls(path, *a):
    # A-2: record whether a vault tmp (plaintext) already existed when this ran
    tmps = [f for f in os.listdir(cc._paths()["cred"]) if f.endswith(".tmp")] if os.path.isdir(cc._paths()["cred"]) else []
    calls.append((os.path.basename(path), a, bool(tmps)))


cc._icacls = fake_icacls
if os.path.exists(status_path):
    os.remove(status_path)
out = cc.divert_credentials({"capital_api_key": "Z123456789", "capital_password": "trade-pw"})
check("5 old libs: values stay in .env as before", out == {"capital_api_key": "Z123456789", "capital_password": "trade-pw"})
check("5 A-4 a bind on a machine that never ran a capital_* step creates no capital_connect status",
      not os.path.exists(status_path))
for name in ("capital_worker.py", "order_capital.py", "capital_vault.py"):
    shutil.copy(os.path.join(ROOT, "lib", name), lib)
check("5 the shipped libs read the vault", cc.lib_supports_vault())
out = cc.divert_credentials({"capital_api_key": "Z123456789", "capital_password": "trade-pw", "OTHER": "1"})
vault = json.load(open(cc._paths()["vault"]))
check("5 sentinels in .env (id EMPTY), the real pair in the vault, other keys untouched",
      out == {"OTHER": "1", "capital_api_key": "",
              "capital_password": "vault:" + cc.vault_fingerprint("Z123456789", "trade-pw")}
      and vault == {"capital_api_key": "Z123456789", "capital_password": "trade-pw"}, out)
check("5 A-4 …still no status file from a vault bind either", not os.path.exists(status_path))
open(os.path.join(WS, ".env"), "w").write("capital_id=Z123456789\n")
check("5 A-3 a legacy capital_id line is blanked too (old code reads it as the id)",
      cc.divert_credentials({"capital_api_key": "Z123456789", "capital_password": "trade-pw"}).get("capital_id") == "")
os.remove(os.path.join(WS, ".env"))
check("5 no secret in the sentinels", "Z123456789" not in json.dumps(out) and "trade-pw" not in json.dumps(out))
check("5 A-2 credentials\\ itself is locked down BEFORE any plaintext tmp exists",
      calls and calls[0][0] == "credentials" and calls[0][1][0] == "/inheritance:r" and calls[0][2] is False, calls[:1])
check("5 vault ACL: owner + only reader = Administrator (SYSTEM: delete + read-attributes), set before the rename",
      [a for f, a, _ in calls if f.startswith("capital_vault.json.") and f.endswith(".tmp")][-2:] == [
          ("/setowner", "Administrator"), ("/inheritance:r", "/grant:r", "Administrator:R", "*S-1-5-18:(D,RA)")])


def failing_icacls(path, *a):
    if os.path.basename(path).endswith(".tmp") and a[0] == "/inheritance:r":
        raise OSError("icacls exit 5")


cc._icacls = failing_icacls
out_fail = cc.divert_credentials({"capital_api_key": "Z123456789", "capital_password": "other-pw"})
leftover = [f for f in os.listdir(cc._paths()["cred"]) if f.endswith(".tmp")]
check("5 A-2 icacls fails on the tmp → the plaintext tmp is deleted", leftover == [], leftover)
check("5 A-2 …and the bind falls back to the pre-vault plain .env instead of failing",
      out_fail == {"capital_api_key": "Z123456789", "capital_password": "other-pw"})
cc._icacls = fake_icacls
check("5 a changed password is a different account identity",
      cc.vault_fingerprint("Z123456789", "trade-pw") != cc.vault_fingerprint("Z123456789", "trade-pw2"))
check("5 local mode never diverts", cc.divert_credentials({"capital_password": "p", "capital_api_key": "i"}, local=True)
      == {"capital_password": "p", "capital_api_key": "i"})
import importlib.util  # noqa: E402


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


cv = load("capital_vault", os.path.join(lib, "capital_vault.py"))
check("5 lib resolve(): sentinel → vault values; plain .env → as is; upper-case names too",
      cv.resolve(out) == ("Z123456789", "trade-pw")
      and cv.resolve({"capital_id": "Q1", "capital_password": "p"}) == ("Q1", "p")
      and cv.resolve({"CAPITAL_API_KEY": "Q1", "CAPITAL_PASSWORD": "p"}) == ("Q1", "p"))
check("5 lib fingerprint == runtime fingerprint (the block file is shared)",
      cv.fingerprint("Z1", "p") == cc.vault_fingerprint("Z1", "p"))
cc.drop_vault(["CAPITAL_API_KEY", "CAPITAL_PASSWORD"])
check("5 unbind deletes the vault", not os.path.exists(cc._paths()["vault"]))
check("5 A-4 unbind creates no status file", not os.path.exists(status_path))
try:
    cv.resolve(out)
    gone = False
except RuntimeError:
    gone = True
check("5 resolve() after unbind fails loudly (no silent login with the sentinel)", gone)
os.makedirs(cc._paths()["vault"])  # os.remove on a directory raises
try:
    cc.drop_vault(["capital_password"])
    swallowed = True
except OSError:
    swallowed = False
os.rmdir(cc._paths()["vault"])
check("5 A-1 drop_vault never raises on a vault it cannot delete", swallowed)

# ── 5b. A-3: the libs BEFORE the vault (from git history) fail before any login on the sentinels ──
import subprocess  # noqa: E402


class FakeCOM:
    created = []

    class client:
        @staticmethod
        def CreateObject(*a, **k):
            FakeCOM.created.append(a)
            raise AssertionError("login path reached")

        @staticmethod
        def GetEvents(*a, **k):
            raise AssertionError("login path reached")


def head(path):
    """The file as it was just before the commit that taught it about the vault."""
    intro = subprocess.run(["git", "log", "--reverse", "--format=%H", "-S", "capital_vault", "--", path],
                           cwd=ROOT, capture_output=True, text=True).stdout.split()
    rev = (intro[0] + "^") if intro else "HEAD"
    r = subprocess.run(["git", "show", f"{rev}:{path}"], cwd=ROOT, capture_output=True, text=True)
    if r.returncode != 0 or "capital_vault" in r.stdout:
        return None
    dst = os.path.join(TMP, "old_" + os.path.basename(path))
    open(dst, "w").write(r.stdout)
    return dst


old_oc, old_wk = head("lib/order_capital.py"), head("lib/capital_worker.py")
check("5b git history still has the pre-vault libs to test against", old_oc and old_wk)
if old_oc and old_wk:
    SENT = {"capital_api_key": "", "capital_id": "", "capital_password": "vault:0123456789abcdef"}
    oc = load("old_order_capital", old_oc)
    oc._init_com = lambda: None
    oc.comtypes, oc.sk = FakeCOM, type("sk", (), {"__getattr__": lambda s, n: n})()
    try:
        oc._get_session(SENT)
        err = None
    except Exception as e:
        err = e
    check("5b old order_capital (a reconciler still running it) raises 'missing' before any COM object",
          isinstance(err, ValueError) and "missing" in str(err) and not FakeCOM.created, repr(err))
    wk = load("old_capital_worker", old_wk)
    wk._init_com = lambda: None
    wk.comtypes, wk.sk = FakeCOM, type("sk", (), {"__getattr__": lambda s, n: n})()
    wk._read_env = lambda: dict(SENT)
    wk._write_snapshot = lambda payload: None
    wk.time = type("t", (), {"sleep": staticmethod(lambda s: None), "time": staticmethod(time.time)})
    try:
        wk.main()
        ex = None
    except SystemExit as e:
        ex = e
    check("5b old capital_worker exits on 'missing' before any COM object", ex is not None and not FakeCOM.created)

# ── 5c. B-1: no second login with credentials 群益 answered 300/307 to ──
open(os.path.join(WS, ".env"), "w").write("capital_api_key=\ncapital_password=vault:" +
                                             cc.vault_fingerprint("Z123456789", "trade-pw") + "\n")
cc.block_login(300)
check("5c runtime sees the block for the credentials .env points at", cc.pw_blocked() == 300)
check("5c lib sees the same block (shared file, shared fingerprint)",
      cv.login_blocked("Z123456789", "trade-pw") == 300 and cv.login_blocked("Z123456789", "new-pw") is None)
open(os.path.join(WS, ".env"), "w").write("capital_api_key=\ncapital_password=vault:" +
                                             cc.vault_fingerprint("Z123456789", "new-pw") + "\n")
check("5c re-entered credentials clear it", cc.pw_blocked() is None)
cv.block_login("Z123456789", "new-pw", 307)
check("5c a 307 written by the worker blocks the runtime too", cc.pw_blocked() == 307)
cv.block_login("Z123456789", "new-pw", 602)
check("5c only 300/307 block (602 is not the password's fault)", cc.pw_blocked() == 307)
noc = load("new_order_capital", os.path.join(ROOT, "lib", "order_capital.py"))
noc.capital_vault = cv
noc._init_com = lambda: None
noc.comtypes, noc.sk = FakeCOM, type("sk", (), {"__getattr__": lambda s, n: n})()
try:
    noc._get_session({"capital_api_key": "Z123456789", "capital_password": "new-pw"})
    err = None
except Exception as e:
    err = e
check("5c order_capital refuses to log in with blocked credentials, before any COM object",
      isinstance(err, noc.CapitalError) and "code=307" in str(err) and not FakeCOM.created, repr(err))
nwk = load("new_capital_worker", os.path.join(ROOT, "lib", "capital_worker.py"))
nwk.capital_vault = cv
try:
    nwk._refuse_if_blocked("Z123456789", "new-pw")
    blocked_err = None
except nwk.ProbeError as e:
    blocked_err = e
check("5c worker refuses too, and says which code (so the snapshot maps to pw_locked)",
      blocked_err is not None and blocked_err.code == 307 and "code=307" in str(blocked_err))
check("5c worker backoff: 30s, 60s, … capped at 30 min (not a re-login every 30s)",
      [nwk._backoff_s(n) for n in (0, 1, 2, 5, 6, 20)] == [30, 60, 120, 960, 1800, 1800])
os.remove(cc._paths()["block"])

# ── 6. dispatch ──
class D:
    def __init__(self, fn, cleanup=None):
        self.fn, self.cleanup = fn, cleanup


check("6 local mode refused", refused(lambda: cc.dispatch("capital_probe", {}, D, local=True), "LOCAL_MODE") is True)
cc.IS_WINDOWS = False
check("6 non-Windows refused", refused(lambda: cc.dispatch("capital_probe", {}, D), "NOT_WINDOWS") is True)
cc.IS_WINDOWS = True
d1 = cc.dispatch("capital_probe", {}, D)
check("6 a second long step while one runs → BUSY", refused(lambda: cc.dispatch("capital_setup", {}, D), "BUSY") is True
      and cc.read_status()["busy"] == "capital_probe")
d1.cleanup()
d2 = cc.dispatch("capital_setup", {}, D)
d2.cleanup()
check("6 cleanup releases it", cc.read_status()["busy"] is None)
check("6 args on a no-arg step, bad pfx args → refused before anything starts",
      refused(lambda: cc.dispatch("capital_setup", {"x": 1}, D), "BAD_ARGS") is True
      and refused(lambda: cc.dispatch("capital_pfx", {"key_id": "x"}, D), "BAD_ARGS") is True
      and cc.read_status()["busy"] is None)

stage = cc._paths()["stage"]
os.makedirs(stage, exist_ok=True)
open(os.path.join(stage, "pw.txt"), "w").write("left behind")
cc._update("cert", status="importing")
cc._update(busy="capital_pfx")  # a bridge restart killed the step: lock gone, file still says busy
d3 = cc.dispatch("capital_probe", {}, D)
st = cc.read_status()
check("6 an interrupted step is swept on the next command: stage (plaintext pfx/password) gone, "
      "stuck section → failed INTERRUPTED, then the new step runs",
      not os.path.exists(stage) and st["cert"]["status"] == "failed" and st["cert"]["error"] == "INTERRUPTED"
      and st["busy"] == "capital_probe", json.dumps(st))
d3.cleanup()
d4 = cc.dispatch("capital_probe", {}, D)
check("6 a step that IS running is not swept (its lock is held)",
      refused(lambda: cc.dispatch("capital_setup", {}, D), "BUSY") is True and cc.read_status()["busy"] == "capital_probe")
d4.cleanup()

# B-1 on the runtime side
cc.block_login(300)
check("6 B-1 blocked credentials: capital_probe and capital_finish refused with PW_RECHECK_NEEDED",
      refused(lambda: cc.dispatch("capital_probe", {}, D), "PW_RECHECK_NEEDED") is True
      and refused(lambda: cc.dispatch("capital_finish", {}, D), "PW_RECHECK_NEEDED") is True
      and cc.read_status()["busy"] is None)
saved = (cc.open_envelope, cc.inspect_pfx, cc.admin_password, cc.import_via_vehicle, cc.run_probe)
cc.open_envelope = lambda k, e: (b"pfx", "pw")
cc.inspect_pfx = lambda p, w: {"thumbprint": "A" * 40, "cn": "Z1", "not_after": "2027-01-01T00:00:00Z", "not_after_ts": 1}
cc.admin_password = lambda: "x"
cc.import_via_vehicle = lambda *a: {"removed": 0, "already": False}
probe_calls = []
cc.run_probe = lambda push=None: probe_calls.append(1) or {"state": "ok"}
r = cc.run_pfx({"key_id": "0" * 32, "envelope": {}})
check("6 B-1 capital_pfx still imports but skips its automatic login while blocked",
      not probe_calls and r["probe"].get("skipped") and r["probe"]["state"] == "pw_wrong", r)
cc.open_envelope, cc.inspect_pfx, cc.admin_password, cc.import_via_vehicle, cc.run_probe = saved
os.remove(cc._paths()["block"])


class _R:
    def __init__(self, rc, out=b""):
        self.returncode, self.stdout = rc, out


real_run = cc.subprocess.run
cc.subprocess.run = lambda *a, **k: _R(2, b'{"ok": false, "stage": "login", "code": 300, "error": "x"}')
st = cc.run_probe()
cc.subprocess.run = real_run
check("6 B-1 a probe that answers 300 writes the block (so the next press does not log in)",
      st["state"] == "pw_wrong" and cc.pw_blocked() == 300)
os.remove(cc._paths()["block"])

# B-1: capital_finish whose worker snapshot says 300 stops the NSSM service
quiet = []
saved = (cc._run_quiet, cc.admin_password, cc._python_for_worker, cc.time.sleep)
cc._run_quiet = lambda argv, timeout, what: quiet.append(argv[:3]) or _R(0)
cc.admin_password = lambda: "x"
cc._python_for_worker = lambda: "py"
cc.time.sleep = lambda s: None
cc._update("probe", state="ok")
json.dump({"ok": False, "error": "login failed code=300 wrong", "read_at": int(time.time()) + 999},
          open(cc._paths()["snapshot"], "w"))
fin = refused(lambda: cc.run_finish(), "SNAPSHOT_ERROR")
cc._run_quiet, cc.admin_password, cc._python_for_worker, cc.time.sleep = saved
check("6 B-1 finish with a 300 snapshot: SNAPSHOT_ERROR, the service is stopped, the block is written",
      fin is True and ["nssm", "stop", cc.WORKER_SERVICE] in quiet and cc.pw_blocked() == 300, f"{fin} {quiet}")
os.remove(cc._paths()["block"])

# R-1: 307 → the user unlocked at 群益 without changing the password → exactly one retry
open(os.path.join(WS, ".env"), "w").write("capital_api_key=\ncapital_password=vault:" +
                                             cc.vault_fingerprint("Z123456789", "trade-pw") + "\n")


def unlock_probe(worker_answer):
    """dispatch capital_probe {after_unlock} and run it; the fake probe plays capital_worker --once:
    it may only log in if login_blocked(consume_retry=True) lets it, and reports worker_answer."""
    seen = {}

    def fake_run(*a, **k):
        seen["daemon_during"] = cv.login_blocked("Z123456789", "trade-pw")            # NSSM worker / order lib
        seen["probe_allowed"] = cv.login_blocked("Z123456789", "trade-pw", consume_retry=True) is None
        seen["second_probe"] = cv.login_blocked("Z123456789", "trade-pw", consume_retry=True)
        if not seen["probe_allowed"]:
            return _R(2, json.dumps({"ok": False, "stage": "login", "code": 307, "error": "not attempted"}).encode())
        if worker_answer == 0:
            cv.clear_block("Z123456789", "trade-pw")
            return _R(0, json.dumps({"ok": True, "accounts": {"futures": "F1", "securities": None}}).encode())
        cv.block_login("Z123456789", "trade-pw", worker_answer)
        return _R(2, json.dumps({"ok": False, "stage": "login", "code": worker_answer, "error": "x"}).encode())

    d = cc.dispatch("capital_probe", {"after_unlock": True}, D)
    cc.subprocess.run = fake_run
    try:
        st = d.fn()
    finally:
        cc.subprocess.run = real_run
        d.cleanup()
    return st, seen


cc.block_login(307)
st, seen = unlock_probe(0)
check("R-1 307 + 「我已解鎖」→ one probe login allowed, the NSSM worker / order lib still refused meanwhile, "
      "no second probe login; success clears the block",
      st["state"] == "ok" and seen["probe_allowed"] and seen["daemon_during"] == 307
      and seen["second_probe"] == 307 and cc.pw_blocked() is None, f"{st} {seen}")
cc.block_login(307)
st, seen = unlock_probe(307)
check("R-1 the one retry fails (307 again) → blocked again", st["state"] == "pw_locked" and cc.pw_blocked() == 307)
check("R-1 …and 「我已解鎖」 is not accepted again for the same credentials",
      refused(lambda: cc.dispatch("capital_probe", {"after_unlock": True}, D), "PW_RECHECK_NEEDED") is True
      and cc.read_status()["busy"] is None)
os.remove(cc._paths()["block"])
cc.block_login(307)
st, seen = unlock_probe(300)
check("R-1 the retry answers 300 → blocked as a wrong password, no further unlock retry",
      cc.pw_blocked() == 300
      and refused(lambda: cc.dispatch("capital_probe", {"after_unlock": True}, D), "PW_RECHECK_NEEDED") is True)
os.remove(cc._paths()["block"])
cc.block_login(300)
check("R-1 a 300 block never accepts 「我已解鎖」", refused(
    lambda: cc.dispatch("capital_probe", {"after_unlock": True}, D), "PW_RECHECK_NEEDED") is True)
os.remove(cc._paths()["block"])
cc.block_login(307)
d = cc.dispatch("capital_probe", {"after_unlock": True}, D)
cc.subprocess.run = lambda *a, **k: _R(1, b'{"ok": false, "stage": "setup", "error": "no python"}')
try:
    d.fn()
finally:
    cc.subprocess.run = real_run
    d.cleanup()
blk = json.load(open(cc._paths()["block"]))
check("R-1 a probe that never reached a login closes the window; the retry still counts as used",
      blk.get("allow_once") is False and blk.get("unlock_used") is True
      and refused(lambda: cc.dispatch("capital_probe", {"after_unlock": True}, D), "PW_RECHECK_NEEDED") is True)
os.remove(cc._paths()["block"])
open(os.path.join(WS, ".env"), "w").write("capital_api_key=\ncapital_password=vault:" +
                                             cc.vault_fingerprint("Z123456789", "new-pw") + "\n")
check("R-1 new credentials clear everything (ordinary probe allowed again)", cc.pw_blocked() is None)
check("R-1 {after_unlock} with no block is an ordinary probe; other args still refused",
      refused(lambda: cc.dispatch("capital_probe", {"after_unlock": False}, D), "BAD_ARGS") is True)
d = cc.dispatch("capital_probe", {"after_unlock": True}, D)
d.cleanup()
check("R-2 same ID, same expiry, different thumbprint: the older copy goes once the new one is in",
      cc.plan_removals([{"t": "G" * 40, "cn": "Z1", "expired": False, "exp": 5, "key": True}], NEW, "Z1", 5) == ["G" * 40])

# R-4: a bridge restart between the grant and the probe closes the window (still spent)
open(os.path.join(WS, ".env"), "w").write("capital_api_key=\ncapital_password=vault:" +
                                             cc.vault_fingerprint("Z123456789", "trade-pw") + "\n")
cc.block_login(307)
d = cc.dispatch("capital_probe", {"after_unlock": True}, D)   # granted; the bridge dies before d.fn()
cc._busy.release()                                             # the new process has a fresh lock
d5 = cc.dispatch("capital_setup", {}, D)                       # next command sweeps
d5.cleanup()
blk = json.load(open(cc._paths()["block"]))
check("R-4 the interrupted sweep closes an open unlock window (the retry stays spent)",
      blk.get("allow_once") is False and blk.get("unlock_used") is True
      and cv.login_blocked("Z123456789", "trade-pw", consume_retry=True) == 307, blk)
cc.clear_block()
# R-5: two --once probes racing for one retry — exactly one gets it
cc.block_login(307)
d = cc.dispatch("capital_probe", {"after_unlock": True}, D)
d.cleanup()
blk = json.load(open(cc._paths()["block"]))
import glob  # noqa: E402
open(f"{cv.BLOCK}.claim-{blk['grant']}", "w").close()   # the other probe created the claim first
check("R-5 the claim file is taken already → this probe does not log in",
      cv.login_blocked("Z123456789", "trade-pw", consume_retry=True) == 307)
os.remove(f"{cv.BLOCK}.claim-{blk['grant']}")
first = cv.login_blocked("Z123456789", "trade-pw", consume_retry=True)
_saved_read = cv._read_block
cv._read_block = lambda i, p: dict(blk)   # the second probe read the block before the first wrote it back
second = cv.login_blocked("Z123456789", "trade-pw", consume_retry=True)
cv._read_block = _saved_read
check("R-5 both read allow_once, only the first creates the claim: one login, not two",
      first is None and second == 307, f"{first} {second}")
cc.clear_block()
check("runtime clear_block also removes claim files", not glob.glob(cv.BLOCK + ".claim-*"))
class FakeLib:
    def __init__(self, login_code, fail=None):
        self.login_code, self.fail = login_code, fail

    def SKCenterLib_Login(self, i, p):
        return self.login_code

    def SKCenterLib_GetReturnCodeMessage(self, c):
        return "msg"

    def SKOrderLib_Initialize(self):
        return 0

    def ReadCertByID(self, i):
        return 1 if self.fail == "cert" else 0

    def GetUserAccount(self):
        return 1 if self.fail == "accounts" else 0


def fake_com(lib):
    class C:
        class client:
            @staticmethod
            def CreateObject(*a, **k):
                return lib

            @staticmethod
            def GetEvents(*a, **k):
                return object()
    return C


SK = type("sk", (), {"__getattr__": lambda s, n: n})()


# R-6: a --once login that succeeds clears the block itself (the runtime may have timed out)
cc.block_login(307)
wk6 = load("r6_worker", os.path.join(ROOT, "lib", "capital_worker.py"))
wk6.capital_vault = cv
wk6._init_com = lambda: None
wk6._parse_env = lambda: {"capital_api_key": "Z123456789", "capital_password": "trade-pw"}
wk6._refuse_if_blocked = lambda i, p, consume_retry=False: None   # the retry was granted and claimed
wk6.comtypes, wk6.sk = fake_com(FakeLib(0)), SK   # the real _connect: login answers 0
wk6.pythoncom = type("pc", (), {"PumpWaitingMessages": staticmethod(lambda: None)})
wk6.Events.futures_accounts = ["F1"]
wk6._tick_snapshot = lambda *a: {"equity": 1, "available": 1, "currency": "TWD", "positions": [], "holdings": []}
wk6._write_probe = lambda payload: None
try:
    wk6.run_once()
except SystemExit:
    pass
check("R-6 --once clears the block for these credentials after a successful login", cc.pw_blocked() is None)
cv.block_login("Other", "pw", 300)
cv.clear_block("Z123456789", "trade-pw")
check("R-6 …but never another credential's block", os.path.exists(cv.BLOCK))
os.remove(cv.BLOCK)
# R-7: a login that answers anything but 300/307 clears the block, in both login paths
wk7 = load("r7_worker", os.path.join(ROOT, "lib", "capital_worker.py"))
oc7 = load("r7_order", os.path.join(ROOT, "lib", "order_capital.py"))
wk7.capital_vault = cv
# the order lib refuses up front while a block matches (it never takes the retry), so its own
# after-login recording is exercised with that pre-check stubbed open
oc7.capital_vault = type("cvp", (), {"resolve": staticmethod(cv.resolve), "record_login": staticmethod(cv.record_login),
                                     "login_blocked": staticmethod(lambda i, p, c=False: None)})
oc7._init_com = lambda: None
for label, code, fail in (("321", 321, None), ("602", 602, None), ("600", 600, None),
                          ("login 0, then reading the cert fails", 0, "cert"),
                          ("login 0, then reading the accounts fails", 0, "accounts")):
    for path, run in (("worker", lambda lib: (setattr(wk7, "comtypes", fake_com(lib)), setattr(wk7, "sk", SK),
                                               wk7._connect("Z123456789", "trade-pw"))),
                      ("order lib", lambda lib: (setattr(oc7, "comtypes", fake_com(lib)), setattr(oc7, "sk", SK),
                                                  setattr(oc7, "_session", None),
                                                  oc7._get_session({"capital_api_key": "Z123456789",
                                                                    "capital_password": "trade-pw"})))):
        cv.block_login("Z123456789", "trade-pw", 307)
        try:
            run(FakeLib(code, fail))
        except Exception:
            pass
        check(f"R-7 {path}: {label} → the spent 307 block is cleared", cv.login_blocked("Z123456789", "trade-pw") is None)
for path, run in (("worker", lambda: (setattr(wk7, "comtypes", fake_com(FakeLib(300))), wk7._connect("Z123456789", "trade-pw"))),
                  ("order lib", lambda: (setattr(oc7, "comtypes", fake_com(FakeLib(300))), setattr(oc7, "_session", None),
                                         oc7._get_session({"capital_api_key": "Z123456789", "capital_password": "trade-pw"})))):
    cv.block_login("Z123456789", "trade-pw", 307)
    try:
        run()
    except Exception:
        pass
    check(f"R-7 {path}: a 300 still blocks", cv.login_blocked("Z123456789", "trade-pw") == 300)
for code in (9996, 1, 2017, 99999):
    cv.block_login("Z123456789", "trade-pw", 307)
    cv.record_login("Z123456789", "trade-pw", code)
    check(f"R-8 an unknown / non-password answer ({code}) keeps the block", cv.login_blocked("Z123456789", "trade-pw") == 307)
for code in cv.PASSWORD_OK_CODES:
    cv.block_login("Z123456789", "trade-pw", 307)
    cv.record_login("Z123456789", "trade-pw", code)
    check(f"R-8 {code} (password already checked) clears it", cv.login_blocked("Z123456789", "trade-pw") is None)
check("R-8 the clear-list is exactly the codes that come after the password check",
      set(cv.PASSWORD_OK_CODES) == {0, 2003, 321, 507, 600, 602, 604})
for path, run in (("worker", lambda: (setattr(wk7, "comtypes", fake_com(FakeLib(9996))), wk7._connect("Z123456789", "trade-pw"))),
                  ("order lib", lambda: (setattr(oc7, "comtypes", fake_com(FakeLib(9996))), setattr(oc7, "_session", None),
                                         oc7._get_session({"capital_api_key": "Z123456789", "capital_password": "trade-pw"})))):
    cv.block_login("Z123456789", "trade-pw", 307)
    try:
        run()
    except Exception:
        pass
    check(f"R-8 {path}: login answers 9996 → the block stays", cv.login_blocked("Z123456789", "trade-pw") == 307)
os.remove(cv.BLOCK)
check("after_unlock must be exactly True on the machine too (1 is refused)",
      refused(lambda: cc.dispatch("capital_probe", {"after_unlock": 1}, D), "BAD_ARGS") is True)

import command_listener as cl  # noqa: E402
check("6 command_listener routes the five names through capital_connect",
      all(n in cl.HANDLERS for n in cc.COMMANDS))
cl.capital_connect.IS_WINDOWS = True
cl._local_mode = lambda: False
manifest = []
cl._write_ui_cred_manifest = lambda lines: manifest.append(list(lines))
cl._bind_book_accounts = lambda ids: {}
cl._unpark_account_state = lambda ident: None
cl._sync_strategy_crons = lambda names: None
os.remove(os.path.join(WS, ".env"))
cl._in_workspace(cl._cmd_credentials, {"env": {"capital_api_key": "Z123456789", "capital_password": "trade-pw"}})
env_text = open(os.path.join(WS, ".env")).read()
check("6 _cmd_credentials writes sentinels to .env, never the values",
      "capital_api_key=\n" in env_text and "capital_password=vault:" in env_text
      and "Z123456789" not in env_text and "trade-pw" not in env_text, env_text)
check("6 …the bind still counts as a bound capital venue with an account identity",
      cl._venue_cred_ids(env_text.splitlines()) == {"CAPITAL"} and cl._account_identity(env_text.splitlines()) is not None)
manifest.clear()
real_drop = cl.capital_connect.drop_vault
cl.capital_connect.drop_vault = lambda names: (_ for _ in ()).throw(PermissionError("locked"))
try:
    cl._in_workspace(cl._cmd_credentials_remove, {"env": ["capital_api_key", "capital_password"]})
    finished = True
except Exception:
    finished = False
cl.capital_connect.drop_vault = real_drop
check("6 A-1 a vault that cannot be dropped does not stop the unbind (manifest still shrinks)",
      finished and manifest and "capital_" not in open(os.path.join(WS, ".env")).read(), manifest)
cl._in_workspace(cl._cmd_credentials, {"env": {"capital_api_key": "Z123456789", "capital_password": "trade-pw"}})
cl._in_workspace(cl._cmd_credentials_remove, {"env": ["capital_api_key", "capital_password"]})
check("6 credentials_remove drops the vault with the lines", not os.path.exists(cc._paths()["vault"])
      and "capital_" not in open(os.path.join(WS, ".env")).read())

shutil.rmtree(TMP, ignore_errors=True)
print("PASS" if not fails else f"FAIL {len(fails)}")
sys.exit(1 if fails else 0)
