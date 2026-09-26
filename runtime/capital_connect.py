"""群益 (Capital) cloud connect without RDP: the deterministic machine side.

The user issues the certificate on their own Windows PC, exports a pfx, and the
app uploads it here end-to-end encrypted: this machine mints a one-time RSA key
(`capital_pfx_key`, public half rides back on the command ack), the app seals
the pfx + export password to it, the api only relays ciphertext
(`capital_pfx`). Nothing here goes through the agent (AGENTS.md "No LLM in the
execution loop"): every step is a command with a fixed outcome, and the outcome
is written to state/capital_connect.json, which the portfolio report carries as
`capital_connect` — the one status both the desktop app and the web read.

Identity: SKCOM reads the RUNNING identity's CurrentUser\\My and needs a
password logon to unlock the key (SSH key auth and WinRM give NTE_PERM at
import, 602 at login — capital-experiments round 1). The worker and the
reconciler already run as .\\Administrator under NSSM, so the pfx goes into
Administrator's store through the same schtasks /RU /RP vehicle
lib/capital_probe.ps1 uses. Not SYSTEM: the agent's shell is SYSTEM, and the
trading password must stay out of its reach (spec §6-B) — see the vault below.

Vault: on a cloud Windows box the 身分證字號 + trading password live in
<base>/credentials/capital_vault.json, owned by and readable only by
Administrator (SYSTEM, i.e. this process and the agent, cannot open it). .env
keeps sentinel values so venue discovery, pairing, eviction and unbind work
unchanged. This stops accidental reads (a strategy's load_dotenv, `cat .env`);
it is not a wall against a SYSTEM process set on bypassing it — SYSTEM can read
rdp_password.txt and run as Administrator.

Ack/refusal shape follows command_listener: success returns a dict, refusal
raises ValueError("CODE: text"). Never put a secret, a pfx byte or a raw probe
line (full account numbers) into a return value, an exception or a log.
"""
import base64
import hashlib
import hmac
import json
import os
import re
import secrets
import shutil
import subprocess
import sys
import threading
import time

WORKSPACE = os.environ.get("BLAVE_AGENT_WORKSPACE", "/opt/blave-agent/workspace")
IS_WINDOWS = os.name == "nt"

COMMANDS = ("capital_setup", "capital_pfx_key", "capital_pfx", "capital_probe", "capital_finish")
ALG = "RSA-OAEP-256+A256GCM"
KEY_TTL_S = 900             # = the api queue TTL: a key outliving its upload window is useless
PFX_MAX_BYTES = 16 * 1024   # Wei's real one is 5,268 bytes with two CA certs
VEHICLE_TASK = "BlaveCapitalImport"
VEHICLE_TIMEOUT_S = 90
PROBE_TIMEOUT_S = 120
SETUP_TIMEOUT_S = 1200
SNAPSHOT_WAIT_S = 150       # worker login ~10s + first tick; NSSM start is seconds
WORKER_SERVICE = "blave-agent-capital"
ADMIN_ACCOUNT = "Administrator"
# The id sentinel is EMPTY on purpose: every capital lib before the vault reads
# `capital_api_key or capital_id` and raises "missing" before any COM call, so
# a reconciler still running old code in memory fails fast instead of sending
# the sentinel as a password (three of those = 307, account locked).
# A legacy `capital_id` line is blanked too, or it would feed old code a real id.
VAULT_ID_SENTINEL = ""
VAULT_PW_PREFIX = "vault:"
PW_BLOCK_STATES = ("pw_wrong", "pw_locked")
_ID_KEYS = ("capital_api_key", "capital_id")
_PW_KEY = "capital_password"

# SKCOM login codes → the spec's states (capital-broker.md Step 5 + the COM manual)
CODE_STATES = {
    300: "pw_wrong",
    307: "pw_locked",
    321: "verify_needed",
    507: "device_code",
    600: "cert_old",
    602: "cert_unusable",
    604: "cert_expired",
    9996: "api_version",
}

_busy = threading.Lock()
_status_lock = threading.Lock()


def _paths():
    base = os.path.dirname(WORKSPACE)
    cred = os.path.join(base, "credentials")
    return {
        "cred": cred,
        "vault": os.path.join(cred, "capital_vault.json"),
        "key": os.path.join(cred, "capital_pfx_key.json"),
        "stage": os.path.join(cred, "capital_stage"),
        "admin_pw": os.path.join(cred, "rdp_password.txt"),
        "status": os.path.join(WORKSPACE, "state", "capital_connect.json"),
        "probe_ps1": os.path.join(WORKSPACE, "lib", "capital_probe.ps1"),
        "setup_ps1": os.path.join(WORKSPACE, "lib", "capital_setup.ps1"),
        "snapshot": os.path.join(WORKSPACE, "state", "capital_account.json"),
        "deployments": os.path.join(WORKSPACE, "state", "deployments.json"),
        "worker": os.path.join(WORKSPACE, "lib", "capital_worker.py"),
        # = lib/capital_vault.BLOCK: a login that answered 300/307, keyed on the
        # credential fingerprint; no login path retries until the user re-enters them
        "block": os.path.join(WORKSPACE, "state", "capital_login_block.json"),
        "env": os.path.join(WORKSPACE, ".env"),
    }


def _refuse(code, text=""):
    raise ValueError(f"{code}: {text}" if text else code)


def _code(e, default):
    head = str(e).split(":", 1)[0]
    return head if re.fullmatch(r"[A-Z_]+", head) else default


def _kw(**kw):
    kw.setdefault("stdin", subprocess.DEVNULL)
    if IS_WINDOWS:
        kw["creationflags"] = kw.get("creationflags", 0) | subprocess.CREATE_NO_WINDOW
    return kw


# ── status (state/capital_connect.json) ──────────────────────────────────────

_SECTIONS = ("setup", "cert", "probe", "worker")


def _blank():
    return {"v": 1, "updated_at": None, "busy": None,
            "vault": True if os.path.exists(_paths()["vault"]) else None,
            **{s: {"status": "idle", "at": None} for s in _SECTIONS}}


def read_status():
    """The report's `capital_connect`; None = never started on this machine."""
    try:
        with open(_paths()["status"], encoding="utf-8") as f:
            st = json.load(f)
    except (OSError, ValueError):
        return None
    return st if isinstance(st, dict) else None


def _update(section=None, create=True, **fields):
    """create=False: only amend an existing file. The report's contract is
    "no capital_connect = never started", so a bind/unbind outside the connect
    flow (an RDP-era user re-saving credentials, a Linux box) must not create
    it — the UI would send a trading user back through setup."""
    with _status_lock:
        st = read_status()
        if st is None:
            if not create:
                return None
            st = _blank()
        now = int(time.time())
        if section:
            cur = st.get(section) if isinstance(st.get(section), dict) else {}
            cur.update(fields, at=now)
            st[section] = cur
        else:
            st.update(fields)
        st["updated_at"] = now
        path = _paths()["status"]
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path + ".tmp", "w", encoding="utf-8") as f:
            json.dump(st, f)
        os.replace(path + ".tmp", path)
        return st


# ── Windows ACL helpers ──────────────────────────────────────────────────────

def _icacls(path, *args):
    r = subprocess.run(["icacls", path, *args], capture_output=True, timeout=30, **_kw())
    if r.returncode != 0:
        raise OSError(f"icacls exit {r.returncode}")


def restrict_admins(path):
    """SYSTEM + Administrators only, no inheritance (drops the Users:(RX) the
    workspace hands every new file — round 1 found .env readable by any local
    user). Best-effort on a cloud box; no-op elsewhere."""
    if not IS_WINDOWS:
        return False
    try:
        _icacls(path, "/inheritance:r", "/grant:r", "*S-1-5-18:F", "*S-1-5-32-544:F")
        return True
    except (OSError, subprocess.SubprocessError):
        return False


def _restrict_dir(path):
    os.makedirs(path, exist_ok=True)
    if IS_WINDOWS:
        _icacls(path, "/inheritance:r", "/grant:r",
                "*S-1-5-18:(OI)(CI)F", "*S-1-5-32-544:(OI)(CI)F")


# ── vault ────────────────────────────────────────────────────────────────────

def lib_supports_vault(workspace=None):
    """The workspace's capital libs must read the vault before anything points
    them at it: an old worker would log in with the sentinel as the password,
    and three wrong passwords lock the account (307)."""
    lib = os.path.join(workspace or WORKSPACE, "lib")
    try:
        for name in ("capital_worker.py", "order_capital.py"):
            with open(os.path.join(lib, name), encoding="utf-8") as f:
                if "capital_vault" not in f.read():
                    return False
        return os.path.isfile(os.path.join(lib, "capital_vault.py"))
    except OSError:
        return False


def vault_fingerprint(login_id, password):
    # .env's account identity (command_listener._account_identity) hashes the
    # credential VALUES; a constant sentinel would make every rebind look like
    # the same account
    return hashlib.sha256(f"capital-vault-v1\0{login_id}\0{password}".encode()).hexdigest()[:16]


def _write_vault(login_id, password):
    p = _paths()
    # the directory first: provisioning leaves it inheriting C:\ (Users can
    # read), and the plaintext exists in it for the moments before its own ACL
    _restrict_dir(p["cred"])
    tmp = f"{p['vault']}.{secrets.token_hex(4)}.tmp"  # a stale one may already be unwritable
    try:
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump({"capital_api_key": login_id, "capital_password": password}, f)
        if IS_WINDOWS:
            # owner and the only reader = Administrator. SYSTEM keeps delete +
            # read-attributes and nothing else: enough to rename this into place
            # and to replace or drop it on a rebind/unbind, not to open it
            _icacls(tmp, "/setowner", ADMIN_ACCOUNT)
            _icacls(tmp, "/inheritance:r", "/grant:r", f"{ADMIN_ACCOUNT}:R", "*S-1-5-18:(D,RA)")
        os.replace(tmp, p["vault"])
    except BaseException:
        try:
            os.remove(tmp)  # SYSTEM keeps delete at every stage above
        except OSError:
            pass
        raise
    if IS_WINDOWS:
        try:
            open(p["vault"], encoding="utf-8").close()
        except PermissionError:
            return True
        return False  # SYSTEM can still open it: the ACL did not take
    return True


def divert_credentials(env, local=False):
    """_cmd_credentials hook: capital's real values → the vault, sentinels →
    .env. Returns the env mapping to write. Falls back to writing the plain
    values (the pre-vault behaviour) wherever the vault cannot be honoured."""
    cap = {k: v for k, v in env.items() if k.casefold() in _ID_KEYS + (_PW_KEY,)}
    if not cap:
        return env
    login_id = next((v for k, v in cap.items() if k.casefold() in _ID_KEYS), None)
    password = next((v for k, v in cap.items() if k.casefold() == _PW_KEY), None)
    if local or not IS_WINDOWS or not login_id or not password or not lib_supports_vault():
        _update(create=False, vault=False)
        return env
    try:
        isolated = _write_vault(login_id, password)
    except Exception as e:
        # the pre-vault behaviour beats a bind that cannot be made at all
        print(f"[capital_connect] vault not written ({type(e).__name__}) — plain .env", file=sys.stderr)
        _update(create=False, vault=False)
        return env
    _update(create=False, vault=bool(isolated))
    fp = vault_fingerprint(login_id, password)
    out = {k: v for k, v in env.items() if k.casefold() not in _ID_KEYS + (_PW_KEY,)}
    id_key = next((k for k in cap if k.casefold() in _ID_KEYS), "capital_api_key")
    pw_key = next(k for k in cap if k.casefold() == _PW_KEY)
    out[id_key] = VAULT_ID_SENTINEL
    if id_key.casefold() != "capital_id" and _env_has("capital_id"):
        out["capital_id"] = VAULT_ID_SENTINEL  # a legacy line would feed old code a real id
    out[pw_key] = VAULT_PW_PREFIX + fp
    return out


def _env_has(key):
    try:
        with open(_paths()["env"], encoding="utf-8") as f:
            return any(l.split("=", 1)[0].strip().casefold() == key for l in f)
    except OSError:
        return False


def drop_vault(names):
    """credentials_remove hook: unbinding capital deletes the vault too."""
    if not any(n.casefold() in _ID_KEYS + (_PW_KEY,) for n in names):
        return
    try:
        os.remove(_paths()["vault"])
    except FileNotFoundError:
        pass
    except OSError as e:
        print(f"[capital_connect] vault not removed ({type(e).__name__})", file=sys.stderr)
    try:
        _update(create=False, vault=None)
    except OSError:
        pass


# ── wrong-password guard ─────────────────────────────────────────────────────

def _cred_fp():
    """Fingerprint of the credentials .env points at now (the vault's is in the
    sentinel; plain ones are hashed the same way lib/capital_vault does)."""
    try:
        with open(_paths()["env"], encoding="utf-8") as f:
            lines = f.read().splitlines()
    except OSError:
        return None
    vals = {}
    for line in lines:
        k, _, v = line.partition("=")
        vals[k.strip().casefold()] = v.strip().strip("'\"")
    pw = vals.get(_PW_KEY) or ""
    if pw.startswith(VAULT_PW_PREFIX):
        return pw[len(VAULT_PW_PREFIX):] or None
    login_id = vals.get("capital_api_key") or vals.get("capital_id")
    return vault_fingerprint(login_id, pw) if login_id and pw else None


def _read_block():
    try:
        with open(_paths()["block"], encoding="utf-8") as f:
            block = json.load(f)
    except (OSError, ValueError):
        return None
    fp = _cred_fp()
    return block if isinstance(block, dict) and fp and block.get("fp") == fp else None


def _write_block(block):
    path = _paths()["block"]
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path + ".tmp", "w", encoding="utf-8") as f:
        json.dump(block, f)
    os.replace(path + ".tmp", path)


def pw_blocked():
    """The 群益 code (300/307) that blocks another login with these same
    credentials, or None. 300 clears only when the user re-enters them; 307
    also allows ONE retry after the user says they unlocked (grant_unlock_retry)."""
    block = _read_block()
    return block.get("code") if block else None


def block_login(code):
    fp = _cred_fp()
    if not fp:
        return
    prev = _read_block() or {}
    # the one post-unlock retry is spent for these credentials, whatever it answered
    _write_block({"fp": fp, "code": code, "at": int(time.time()),
                  "unlock_used": bool(prev.get("unlock_used"))})


def clear_block():
    import glob
    for path in [_paths()["block"]] + glob.glob(_paths()["block"] + ".claim-*"):
        try:
            os.remove(path)
        except OSError:
            pass


def _close_unlock_window():
    block = _read_block()
    if block and block.get("allow_once"):  # still spent: the retry is never handed out twice
        _write_block(dict(block, allow_once=False))


def grant_unlock_retry():
    """Spec w-pw-locked 「繼續」: the user unlocked at 群益 without changing the
    password. Exactly one login is allowed — spent here, before it happens, so a
    probe that dies half-way does not hand out a second one. Only the probe
    (`capital_worker.py --once`) consumes `allow_once`; the NSSM worker and the
    order lib keep refusing throughout."""
    block = _read_block()
    if not block:
        return  # nothing blocks these credentials: an ordinary probe
    if block.get("code") != 307:
        _refuse("PW_RECHECK_NEEDED", "群益 refused this trading password — re-enter it")
    if block.get("unlock_used"):
        _refuse("PW_RECHECK_NEEDED", "the one retry after unlocking was used — change the password at 群益 and re-enter it")
    # the grant id names the one claim file lib/capital_vault may create (O_EXCL):
    # two probes racing for the retry cannot both get it
    _write_block(dict(block, allow_once=True, unlock_used=True, grant=secrets.token_hex(8)))


# ── one-time key + envelope ──────────────────────────────────────────────────

def _crypto():
    try:
        from cryptography.hazmat.primitives import hashes, serialization
        from cryptography.hazmat.primitives.asymmetric import padding, rsa
        from cryptography.hazmat.primitives.ciphers.aead import AESGCM
        from cryptography.hazmat.primitives.serialization import pkcs12
        from cryptography import x509
    except ImportError:
        _refuse("CRYPTO_MISSING", "run capital_setup first")
    return {"hashes": hashes, "ser": serialization, "padding": padding, "rsa": rsa,
            "AESGCM": AESGCM, "pkcs12": pkcs12, "x509": x509}


def _oaep(c):
    return c["padding"].OAEP(mgf=c["padding"].MGF1(algorithm=c["hashes"].SHA256()),
                             algorithm=c["hashes"].SHA256(), label=None)


def cmd_pfx_key(args):
    if args:
        _refuse("BAD_ARGS")
    c = _crypto()
    priv = c["rsa"].generate_private_key(public_exponent=65537, key_size=3072)
    key_id = secrets.token_hex(16)
    expires_at = int(time.time()) + KEY_TTL_S
    pem = priv.private_bytes(c["ser"].Encoding.PEM, c["ser"].PrivateFormat.PKCS8,
                             c["ser"].NoEncryption()).decode()
    spki = priv.public_key().public_bytes(c["ser"].Encoding.DER,
                                          c["ser"].PublicFormat.SubjectPublicKeyInfo)
    p = _paths()
    os.makedirs(p["cred"], exist_ok=True)
    tmp = p["key"] + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump({"key_id": key_id, "expires_at": expires_at, "pem": pem}, f)
    restrict_admins(tmp)
    os.replace(tmp, p["key"])  # one key at a time: a newer request voids the older
    return {"key_id": key_id, "alg": ALG, "spki": base64.b64encode(spki).decode(),
            "expires_at": expires_at}


def _b64(s, what):
    try:
        return base64.b64decode(s, validate=True)
    except (ValueError, TypeError):
        _refuse("ENVELOPE_INVALID", f"{what} is not base64")


def check_pfx_args(args):
    """Shape only (the api checks the same); runs before a Deferred is built."""
    if not isinstance(args, dict) or set(args) != {"key_id", "envelope"}:
        _refuse("BAD_ARGS", "needs key_id and envelope")
    if not isinstance(args["key_id"], str) or not re.fullmatch(r"[0-9a-f]{32}", args["key_id"]):
        _refuse("BAD_ARGS", "bad key_id")
    env = args["envelope"]
    if (not isinstance(env, dict) or env.get("v") != 1 or env.get("alg") != ALG
            or not all(isinstance(env.get(k), str) for k in ("ek", "iv", "ct"))
            or len(env["ct"]) > (PFX_MAX_BYTES * 2) or len(env["ek"]) > 1024 or len(env["iv"]) > 64):
        _refuse("BAD_ARGS", "bad envelope")


def open_envelope(key_id, envelope):
    """→ (pfx bytes, export password). Consumes the key: deleted before the
    decrypt is attempted, so a key is good for exactly one upload whatever
    happens next."""
    c = _crypto()
    path = _paths()["key"]
    try:
        with open(path, encoding="utf-8") as f:
            rec = json.load(f)
    except (OSError, ValueError):
        rec = None
    try:
        os.remove(path)
    except OSError:
        pass
    if (not isinstance(rec, dict) or not isinstance(rec.get("key_id"), str)
            or not hmac.compare_digest(rec["key_id"], key_id)
            or not isinstance(rec.get("expires_at"), int) or rec["expires_at"] < time.time()):
        _refuse("KEY_EXPIRED", "request a new key and upload again")
    priv = c["ser"].load_pem_private_key(rec["pem"].encode(), password=None)
    ek, iv, ct = (_b64(envelope[k], k) for k in ("ek", "iv", "ct"))
    try:
        aes_key = priv.decrypt(ek, _oaep(c))
        plain = c["AESGCM"](aes_key).decrypt(iv, ct, key_id.encode())
        body = json.loads(plain.decode("utf-8"))
    except Exception:
        _refuse("ENVELOPE_INVALID", "could not decrypt")
    if (not isinstance(body, dict) or not isinstance(body.get("pfx"), str)
            or not isinstance(body.get("password"), str)):
        _refuse("ENVELOPE_INVALID", "bad payload")
    pfx = _b64(body["pfx"], "pfx")
    if len(pfx) > PFX_MAX_BYTES:
        _refuse("PFX_TOO_LARGE", f"over {PFX_MAX_BYTES} bytes")
    return pfx, body["password"]


def _der_len(data, i):
    first = data[i]
    if first < 0x80:
        return first, i + 1
    n = first & 0x7F
    if n == 0 or n > 4 or i + 1 + n > len(data):
        raise ValueError
    return int.from_bytes(data[i + 1:i + 1 + n], "big"), i + 1 + n


def _looks_like_pfx(data):
    """PFX ::= SEQUENCE { version INTEGER 3, ... } spanning the whole file.
    cryptography reports a wrong password and a corrupt file with one message;
    a structurally whole file that will not open is a wrong password."""
    try:
        if len(data) < 8 or data[0] != 0x30:
            return False
        length, i = _der_len(data, 1)
        return i + length == len(data) and data[i:i + 3] == b"\x02\x01\x03"
    except (ValueError, IndexError):
        return False


def inspect_pfx(pfx, password):
    """→ {thumbprint, cn, not_after} of a 群益 end-entity cert with its key."""
    c = _crypto()
    if len(pfx) > PFX_MAX_BYTES:
        _refuse("PFX_TOO_LARGE", f"over {PFX_MAX_BYTES} bytes")
    try:
        key, cert, _extra = c["pkcs12"].load_key_and_certificates(
            pfx, password.encode("utf-8") if password else None)
    except Exception:
        if _looks_like_pfx(pfx):
            _refuse("PFX_PASSWORD", "the export password does not open this file")
        _refuse("PFX_INVALID", "not a certificate file")
    if key is None or cert is None:
        _refuse("PFX_INVALID", "no certificate with a private key inside")
    oid = c["x509"].NameOID
    ous = [a.value for a in cert.subject.get_attributes_for_oid(oid.ORGANIZATIONAL_UNIT_NAME)]
    issuer = cert.issuer.rfc4514_string()
    if "The Capital Group" not in ous or "TaiCA" not in issuer:
        _refuse("PFX_NOT_CAPITAL", "not a 群益 certificate")
    not_after = getattr(cert, "not_valid_after_utc", None)
    if not_after is None:  # cryptography < 42
        not_after_ts = cert.not_valid_after.replace(tzinfo=None)
        import calendar
        exp = calendar.timegm(not_after_ts.timetuple())
    else:
        exp = int(not_after.timestamp())
    if exp <= time.time():
        _refuse("PFX_EXPIRED", "this certificate has expired — renew it first")
    cns = cert.subject.get_attributes_for_oid(oid.COMMON_NAME)
    return {
        "thumbprint": hashlib.sha1(cert.public_bytes(c["ser"].Encoding.DER)).hexdigest().upper(),
        "cn": cns[0].value if cns else "",
        "not_after": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(exp)),
        "not_after_ts": exp,
    }


# ── the Administrator vehicle ────────────────────────────────────────────────

def admin_password():
    """Same sources as command_listener._capital_admin_password. Never logged."""
    p = _paths()
    try:
        with open(p["admin_pw"], encoding="utf-8") as f:
            pw = f.read().strip()
        if pw:
            return pw
    except (OSError, ValueError):
        pass
    try:
        with open(os.path.join(WORKSPACE, ".env"), encoding="utf-8") as f:
            for line in f.read().splitlines():
                k, _, v = line.partition("=")
                if k.strip().casefold() == "admin_password" and v.strip():
                    return v.strip()
    except (OSError, ValueError):
        pass
    _refuse("ADMIN_PASSWORD_MISSING", "the machine's Administrator password is not on file")


def _run_quiet(argv, timeout, what):
    """subprocess.run whose failures never carry argv: a TimeoutExpired's str()
    embeds the full command line, and several here hold a password."""
    try:
        return subprocess.run(argv, capture_output=True, timeout=timeout, **_kw())
    except subprocess.TimeoutExpired:
        raise RuntimeError(f"{what} timed out")
    except OSError as e:
        raise RuntimeError(f"{what} could not start ({type(e).__name__})")


def _as_administrator(command, admin_pw, done, timeout):
    """One-shot schtasks password vehicle (capital_probe.ps1's pattern). `done()`
    returns the result or None while waiting."""
    _run_quiet(["cmd", "/c", f"schtasks /delete /tn {VEHICLE_TASK} /f >nul 2>nul"], 30, "schtasks delete")
    r = _run_quiet(["schtasks", "/create", "/tn", VEHICLE_TASK, "/tr", command, "/sc", "once",
                    "/st", "00:00", "/ru", ADMIN_ACCOUNT, "/rp", admin_pw, "/rl", "HIGHEST", "/f"],
                   30, "schtasks create")
    try:
        if r.returncode != 0:
            _refuse("IMPORT_FAILED", "could not schedule the Administrator task (password wrong?)")
        if _run_quiet(["schtasks", "/run", "/tn", VEHICLE_TASK], 30, "schtasks run").returncode != 0:
            _refuse("IMPORT_FAILED", "could not start the Administrator task")
        deadline = time.time() + timeout
        while time.time() < deadline:
            time.sleep(1)
            got = done()
            if got is not None:
                return got
        _refuse("IMPORT_FAILED", f"no result after {timeout}s")
    finally:
        _run_quiet(["cmd", "/c", f"schtasks /delete /tn {VEHICLE_TASK} /f >nul 2>nul"], 30, "schtasks delete")


def import_via_vehicle(pfx, password, meta, admin_pw):
    p = _paths()
    stage = p["stage"]
    shutil.rmtree(stage, ignore_errors=True)
    _restrict_dir(stage)
    nonce = secrets.token_hex(8)
    try:
        with open(os.path.join(stage, "c.pfx"), "wb") as f:
            f.write(pfx)
        with open(os.path.join(stage, "pw.txt"), "w", encoding="utf-8") as f:
            f.write(password)
        with open(os.path.join(stage, "meta.json"), "w", encoding="utf-8") as f:
            json.dump({"nonce": nonce, "thumbprint": meta["thumbprint"], "cn": meta["cn"],
                       "not_after_ts": meta["not_after_ts"]}, f)
        me, py = os.path.abspath(__file__), sys.executable
        if " " in me or " " in py or " " in stage:
            _refuse("IMPORT_FAILED", "a path contains a space")
        result_path = os.path.join(stage, "result.json")

        def done():
            try:
                with open(result_path, encoding="utf-8") as f:
                    res = json.load(f)
            except (OSError, ValueError):
                return None
            return res if res.get("nonce") == nonce else None

        res = _as_administrator(f"{py} {me} --vehicle-import {stage}", admin_pw, done,
                                VEHICLE_TIMEOUT_S)
    finally:
        shutil.rmtree(stage, ignore_errors=True)
    if res.get("error") == "PFX_OLDER":
        _refuse("PFX_OLDER", "this machine already has a newer certificate for this ID — upload the latest export")
    if not res.get("ok"):
        _refuse("IMPORT_FAILED", str(res.get("error") or "import did not take")[:200])
    return {"removed": int(res.get("removed") or 0), "already": bool(res.get("already"))}


_PS_LIST = (
    "$now = Get-Date; "
    "$r = @(Get-ChildItem Cert:\\CurrentUser\\My | Where-Object { "
    "$_.Subject -like '*OU=The Capital Group*' -and $_.Issuer -like '*TaiCA*' } | "
    "ForEach-Object { [pscustomobject]@{ t = $_.Thumbprint; cn = $_.GetNameInfo('SimpleName', $false); "
    "expired = ($_.NotAfter -lt $now); key = $_.HasPrivateKey; "
    "exp = ([DateTimeOffset]$_.NotAfter).ToUnixTimeSeconds() } }); "
    "ConvertTo-Json -InputObject $r -Compress"
)


def _ps(script, timeout=60):
    r = subprocess.run(["powershell", "-NoProfile", "-NonInteractive", "-Command", script],
                       capture_output=True, timeout=timeout, **_kw())
    return r.returncode, r.stdout.decode("utf-8", "replace").strip()


def _list_capital_certs():
    rc, out = _ps(_PS_LIST)
    if rc != 0:
        raise RuntimeError(f"cert listing failed (exit {rc})")
    got = json.loads(out or "[]")
    return got if isinstance(got, list) else [got]


def plan_before_import(certs, new_thumb, new_cn, new_exp):
    """→ (action, delete_first): "refuse" when a cert of the same ID already
    here runs LONGER than the upload (an old backup — importing it would
    later delete the good one); "installed" when this exact cert is already
    here with its key (nothing to do, nothing to risk); else "import", after
    deleting only a keyless copy of the same cert (it keeps its broken key
    link through a re-import — capital-broker.md Step 5, 602 notes)."""
    same = [c for c in certs if (c.get("t") or "").upper() == new_thumb.upper()]
    if any(c.get("cn") == new_cn and (c.get("t") or "").upper() != new_thumb.upper()
           and c.get("key") and not c.get("expired") and (c.get("exp") or 0) > new_exp for c in certs):
        return "refuse", []
    if same and same[0].get("key"):
        return "installed", []
    return "import", [c["t"] for c in same]


def plan_removals(certs, new_thumb, new_cn, new_exp):
    """Once the new cert is in WITH its key: other certs of the same ID that
    end earlier (a renewal revokes the old one — 604 if SKCOM picks it) and
    any expired one (600). Another ID's valid cert stays."""
    return [c["t"] for c in certs
            if c.get("t") and c["t"].upper() != new_thumb.upper()
            and (c.get("expired") or (new_cn and c.get("cn") == new_cn and (c.get("exp") or 0) <= new_exp))]


def _remove_cert(thumb):
    if not re.fullmatch(r"[0-9A-Fa-f]{40}", thumb):
        raise RuntimeError("bad thumbprint")
    rc, _ = _ps(f"Remove-Item -Path 'Cert:\\CurrentUser\\My\\{thumb}' -ErrorAction Stop")
    if rc != 0:
        raise RuntimeError("remove failed")


def _certutil_import(pfx, pw):
    r = subprocess.run(["certutil", "-user", "-p", pw, "-importpfx", "My", pfx, "NoRoot"],
                       capture_output=True, timeout=60, **_kw())
    return r.returncode


def vehicle_import(stage):
    """Runs AS Administrator inside the schtasks vehicle. Writes result.json.
    Nothing already in the store is touched until the new cert is confirmed
    present with its private key; the pfx and its password are deleted right
    after certutil."""
    meta = json.load(open(os.path.join(stage, "meta.json"), encoding="utf-8"))
    result = {"nonce": meta.get("nonce"), "ok": False}
    pfx = os.path.join(stage, "c.pfx")
    pw_path = os.path.join(stage, "pw.txt")
    try:
        thumb, cn, exp = meta["thumbprint"], meta.get("cn"), int(meta["not_after_ts"])
        action, delete_first = plan_before_import(_list_capital_certs(), thumb, cn, exp)
        if action == "refuse":
            result["error"] = "PFX_OLDER"
            return
        if action == "import":
            for t in delete_first:
                _remove_cert(t)
            with open(pw_path, encoding="utf-8") as f:
                pw = f.read()
            try:
                result["certutil"] = _certutil_import(pfx, pw)
            finally:
                pw = None
                for path in (pw_path, pfx):
                    try:
                        os.remove(path)
                    except OSError:
                        pass
        after = _list_capital_certs()
        mine = [c for c in after if (c.get("t") or "").upper() == thumb.upper()]
        if not mine or not mine[0].get("key"):
            result["error"] = f"certutil exit {result.get('certutil')}; cert present={bool(mine)}"
            return
        removed = 0
        for t in plan_removals(after, thumb, cn, exp):
            try:
                _remove_cert(t)
                removed += 1
            except RuntimeError:
                pass
        result.update(ok=True, removed=removed, already=action == "installed")
    except Exception as e:
        result["error"] = type(e).__name__
    finally:
        for path in (pw_path, pfx):
            try:
                os.remove(path)
            except OSError:
                pass
        tmp = os.path.join(stage, "result.json.tmp")
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(result, f)
        os.replace(tmp, os.path.join(stage, "result.json"))


# ── probe ────────────────────────────────────────────────────────────────────

def probe_state(obj, exit_code):
    """capital_probe.ps1's JSON + exit → the status `probe` fields. Account
    numbers never leave here: only whether each market answered."""
    if not isinstance(obj, dict):
        obj = {}
    accounts = obj.get("accounts") if isinstance(obj.get("accounts"), dict) else {}
    out = {"code": None, "futures": bool(accounts.get("futures")),
           "securities": bool(accounts.get("securities"))}
    if obj.get("ok") and exit_code == 0:
        out["state"] = "ok" if (out["futures"] or out["securities"]) else "no_accounts"
        out["code"] = 0
        return out
    stage = obj.get("stage")
    code = obj.get("code")
    if not isinstance(code, int):
        # workspaces before the `code` field only carry it in the message
        m = re.search(r"code=(\d+)", str(obj.get("error") or ""))
        code = int(m.group(1)) if m else None
    out["code"] = code
    if exit_code == 3 or stage == "probe":
        out["state"] = "timeout"
    elif stage == "setup" or exit_code == 1:
        out["state"] = "vehicle_failed"
    elif stage == "env":
        out["state"] = "no_credentials"
    elif code in CODE_STATES:
        out["state"] = CODE_STATES[code]
    elif stage == "accounts" and code is None:
        out["state"] = "no_accounts"
    else:
        out["state"] = "unknown"
    return out


def _last_json(text):
    for line in reversed(text.splitlines()):
        line = line.strip()
        if line.startswith("{"):
            try:
                return json.loads(line)
            except ValueError:
                continue
    try:
        return json.loads(text)
    except ValueError:
        return None


def run_probe(push=None):
    _update("probe", status="running")
    if push:
        push()
    ps1 = _paths()["probe_ps1"]
    try:
        r = subprocess.run(["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", ps1,
                            "-TimeoutSec", str(PROBE_TIMEOUT_S)],
                           capture_output=True, timeout=PROBE_TIMEOUT_S + 60, **_kw())
        rc, obj = r.returncode, _last_json(r.stdout.decode("utf-8", "replace"))
    except subprocess.TimeoutExpired:
        rc, obj = 3, None
    except OSError:
        rc, obj = 1, {"ok": False, "stage": "setup"}
    st = probe_state(obj, rc)
    if st["state"] in PW_BLOCK_STATES:
        block_login(st["code"])
    elif st["state"] == "ok":
        clear_block()
    else:
        _close_unlock_window()  # the retry never reached a login
    _update("probe", status="ok" if st["state"] == "ok" else "failed", **st)
    return st


# ── setup / finish ───────────────────────────────────────────────────────────

def run_setup(push=None):
    _update("setup", status="running", error=None)
    if push:
        push()
    try:
        r = subprocess.run(["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File",
                            _paths()["setup_ps1"]], capture_output=True, timeout=SETUP_TIMEOUT_S, **_kw())
        rc, out = r.returncode, r.stdout.decode("utf-8", "replace")
    except (subprocess.TimeoutExpired, OSError):
        rc, out = -1, ""
    failed = []
    if rc != 0:
        obj = None
        start = 0 if out.startswith("{") else out.rfind("\n{") + 1
        if start > 0 or out.startswith("{"):
            try:
                obj = json.loads(out[start:])
            except ValueError:
                obj = None
        errs = (obj or {}).get("errors") or []
        failed = [str(e).split(" :", 1)[0] for e in errs] or ["script"]
    # the one-time key, the envelope and the pfx check run in THIS interpreter
    try:
        import cryptography  # noqa: F401
    except ImportError:
        try:
            pip = _run_quiet([sys.executable, "-m", "pip", "install", "--quiet", "cryptography"], 600, "pip")
            ok = pip.returncode == 0
        except RuntimeError:
            ok = False
        if not ok:
            failed.append("cryptography")
    if failed:
        _update("setup", status="failed", error="SETUP_FAILED:" + ",".join(failed))
        _refuse("SETUP_FAILED", ", ".join(failed))
    _update("setup", status="ok", error=None)
    return {"setup": "ok"}


def _python_for_worker():
    return shutil.which("python") or (r"C:\Python314\python.exe"
                                      if os.path.isfile(r"C:\Python314\python.exe") else None)


def _nssm(step, timeout=30):
    r = _run_quiet(["nssm", *step], timeout, f"nssm {step[0]}")
    if r.returncode != 0:
        _refuse("NSSM_FAILED", f"nssm {step[0]} {step[2] if len(step) > 2 and step[0] == 'set' else ''}".strip())


def _register_worker_deployment():
    path = _paths()["deployments"]
    try:
        with open(path, encoding="utf-8") as f:
            deps = json.load(f)
    except (OSError, ValueError):
        deps = {}
    if not isinstance(deps, dict):
        deps = {}
    deps.setdefault("capital_worker", {"type": "daemon", "expect_every_minutes": 5,
                                       "registered_at": time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime())})
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path + ".tmp", "w", encoding="utf-8") as f:
        json.dump(deps, f, indent=2)
    os.replace(path + ".tmp", path)


def run_finish(push=None):
    st = read_status() or {}
    if (st.get("probe") or {}).get("state") != "ok":
        _refuse("PROBE_NOT_OK", "login has not passed yet")
    _update("worker", status="running", error=None)
    if push:
        push()
    try:
        admin_pw = admin_password()
        py = _python_for_worker()
        if not py:
            _refuse("NSSM_FAILED", "python.exe not found")
        p = _paths()
        started = time.time() - 2
        exists = _run_quiet(["nssm", "status", WORKER_SERVICE], 30, "nssm status").returncode == 0
        if exists:
            _run_quiet(["nssm", "stop", WORKER_SERVICE], 60, "nssm stop")
        else:
            _nssm(["install", WORKER_SERVICE, py, p["worker"]])
        log = os.path.join(WORKSPACE, "state", "capital_worker.log")
        for step in (["set", WORKER_SERVICE, "Application", py],
                     ["set", WORKER_SERVICE, "AppParameters", p["worker"]],
                     ["set", WORKER_SERVICE, "AppDirectory", WORKSPACE],
                     ["set", WORKER_SERVICE, "AppEnvironmentExtra", f"BLAVE_AGENT_WORKSPACE={WORKSPACE}"],
                     ["set", WORKER_SERVICE, "ObjectName", f".\\{ADMIN_ACCOUNT}", admin_pw],
                     ["set", WORKER_SERVICE, "AppStdout", log],
                     ["set", WORKER_SERVICE, "AppStderr", log],
                     ["set", WORKER_SERVICE, "Start", "SERVICE_AUTO_START"],
                     ["start", WORKER_SERVICE]):
            _nssm(step, timeout=90 if step[0] == "start" else 30)
        _register_worker_deployment()
        deadline = time.time() + SNAPSHOT_WAIT_S
        snap = None
        while time.time() < deadline:
            time.sleep(3)
            try:
                with open(p["snapshot"], encoding="utf-8") as f:
                    s = json.load(f)
            except (OSError, ValueError):
                continue
            if isinstance(s, dict) and (s.get("read_at") or 0) >= started:
                snap = s
                break
        if snap is None:
            _refuse("SNAPSHOT_TIMEOUT", "the worker wrote no snapshot")
        if not snap.get("ok"):
            m = re.search(r"code=(\d+)", str(snap.get("error") or ""))
            code = int(m.group(1)) if m else None
            if CODE_STATES.get(code) in PW_BLOCK_STATES:
                # an NSSM worker re-logs in on every restart: stop it before a
                # wrong password becomes a locked account
                _run_quiet(["nssm", "stop", WORKER_SERVICE], 60, "nssm stop")
                block_login(code)
            _refuse("SNAPSHOT_ERROR", CODE_STATES.get(code, "unknown") if code else "unknown")
    except Exception as e:
        _update("worker", status="failed", error=_code(e, "NSSM_FAILED"))
        raise
    _update("worker", status="ok", error=None)
    return {"worker": "ok"}


# ── dispatch ─────────────────────────────────────────────────────────────────

def run_pfx(args, push=None):
    _update("cert", status="importing", error=None)
    if push:
        push()
    try:
        pfx, password = open_envelope(args["key_id"], args["envelope"])
        meta = inspect_pfx(pfx, password)
        admin_pw = admin_password()
        imported = import_via_vehicle(pfx, password, meta, admin_pw)
        pfx = password = None
    except Exception as e:
        _update("cert", status="failed", error=_code(e, "IMPORT_FAILED"))
        raise
    _update("cert", status="ok", error=None, not_after=meta["not_after"])
    blocked = pw_blocked()
    probe = ({"state": CODE_STATES.get(blocked, "pw_wrong"), "code": blocked, "skipped": True}
             if blocked else run_probe(push))
    return {"cert": {"not_after": meta["not_after"], "removed_old": imported["removed"]},
            "probe": probe}


def _sweep_interrupted():
    """A runtime publish restarts the bridge and kills a Deferred mid-step: the
    status keeps `busy` and a section stuck at running/importing, and the stage
    dir may still hold the plaintext pfx + password. Called only from dispatch
    (never at import — the vehicle and lib/venue.py import this module while a
    step may be in flight in the bridge)."""
    if not _busy.acquire(blocking=False):
        return
    try:
        st = read_status()
        if not st or not st.get("busy"):
            return
        shutil.rmtree(_paths()["stage"], ignore_errors=True)
        _close_unlock_window()
        for sec in _SECTIONS:
            if (st.get(sec) or {}).get("status") in ("running", "importing"):
                _update(sec, status="failed", error="INTERRUPTED")
        _update(busy=None)
    finally:
        _busy.release()


def dispatch(cmd, args, deferred_cls, push=None, local=False):
    """command_listener's HANDLERS entry for every name in COMMANDS."""
    if local:
        _refuse("LOCAL_MODE", "the desktop connects 群益 on this computer, not through these commands")
    if not IS_WINDOWS:
        _refuse("NOT_WINDOWS", "群益 needs a Windows host")
    _sweep_interrupted()
    if cmd == "capital_pfx_key":
        return cmd_pfx_key(args)
    if cmd == "capital_pfx":
        check_pfx_args(args)
        job = lambda: run_pfx(args, push)  # noqa: E731
    elif cmd == "capital_probe" and set(args) == {"after_unlock"} and args["after_unlock"] is True:
        job = lambda: run_probe(push)  # noqa: E731
    elif args:
        _refuse("BAD_ARGS", f"{cmd} takes no arguments")
    elif cmd in ("capital_probe", "capital_finish") and pw_blocked():
        _refuse("PW_RECHECK_NEEDED", "群益 refused this trading password — re-enter it before trying again")
    elif cmd == "capital_setup":
        job = lambda: run_setup(push)  # noqa: E731
    elif cmd == "capital_probe":
        job = lambda: run_probe(push)  # noqa: E731
    elif cmd == "capital_finish":
        job = lambda: run_finish(push)  # noqa: E731
    else:
        _refuse("BAD_ARGS", "unknown capital command")
    if not _busy.acquire(blocking=False):
        _refuse("BUSY", f"another 群益 step is running ({(read_status() or {}).get('busy')})")
    try:
        _update(busy=cmd)
        if cmd == "capital_probe" and args:
            grant_unlock_retry()
    except Exception:
        try:
            _update(busy=None)
        finally:
            _busy.release()
        raise

    def cleanup():
        try:
            _update(busy=None)
        finally:
            _busy.release()

    return deferred_cls(job, cleanup=cleanup)


if __name__ == "__main__" and len(sys.argv) == 3 and sys.argv[1] == "--vehicle-import":
    vehicle_import(sys.argv[2])
