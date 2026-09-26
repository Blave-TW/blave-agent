"""Where 群益's 身分證字號 + trading password actually live on a cloud box.

The runtime's `credentials` command (runtime/capital_connect.divert_credentials)
writes them to <base>/credentials/capital_vault.json — owned by and readable
only by Administrator, the identity the worker and the capital reconciler run
as — and leaves sentinels in .env (`capital_api_key=` empty,
`capital_password=vault:<fingerprint>`) so venue discovery keeps working. It is
a separate file for the 群益 order code only — out of .env, so strategies and
the agent do not pick it up in passing (SYSTEM could still take it on purpose).

Imported two ways: capital_worker.py runs as a bare script with lib/ on
sys.path (`import capital_vault`), order_capital.py as `lib.capital_vault`.
Keep it free of other lib imports.
"""
import hashlib
import json
import os
import time

VAULT = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))),
                     "credentials", "capital_vault.json")
PW_PREFIX = "vault:"
# = runtime/capital_connect's "block" path: a login that answered 300/307,
# keyed on the credential fingerprint. Every login path here refuses to try
# again with the same credentials — three wrong passwords lock the account.
BLOCK = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                     "state", "capital_login_block.json")
BLOCK_CODES = (300, 307)


def fingerprint(login_id, password):
    """= runtime/capital_connect.vault_fingerprint (tests pin the two equal)."""
    return hashlib.sha256(f"capital-vault-v1\0{login_id}\0{password}".encode()).hexdigest()[:16]


def _read_block(login_id, password):
    try:
        with open(BLOCK, encoding="utf-8") as f:
            block = json.load(f)
    except (OSError, ValueError):
        return None
    return block if isinstance(block, dict) and block.get("fp") == fingerprint(login_id, password) else None


def _write_block(block):
    try:
        os.makedirs(os.path.dirname(BLOCK), exist_ok=True)
        with open(BLOCK + ".tmp", "w", encoding="utf-8") as f:
            json.dump(block, f)
        os.replace(BLOCK + ".tmp", BLOCK)
        return True
    except OSError:
        return False


def login_blocked(login_id, password, consume_retry=False):
    """The code that blocks a login with exactly these credentials, or None.
    consume_retry=True only from the onboarding probe (`--once`): a post-unlock
    retry the runtime granted (`allow_once` + `grant`) is taken by CREATING its
    claim file exclusively — of two probes racing for it, one wins — then the
    block is written back as spent, and only then is this one call let through."""
    block = _read_block(login_id, password)
    if not block:
        return None
    grant = block.get("grant")
    if consume_retry and block.get("allow_once") and isinstance(grant, str) and grant.isalnum():
        try:
            fd = os.open(f"{BLOCK}.claim-{grant}", os.O_CREAT | os.O_EXCL | os.O_WRONLY)
            os.close(fd)
        except OSError:
            return block.get("code")  # another probe took it (or it cannot be claimed): no login
        if _write_block(dict(block, allow_once=False, unlock_used=True)):
            return None
    return block.get("code")


def block_login(login_id, password, code):
    if code not in BLOCK_CODES:
        return
    prev = _read_block(login_id, password) or {}
    _write_block({"fp": fingerprint(login_id, password), "code": code, "at": int(time.time()),
                  "unlock_used": bool(prev.get("unlock_used"))})


def clear_block(login_id, password):
    """After a successful login: drop the block for exactly these credentials
    (and its claim files) — a probe the runtime gave up on (timeout) must not
    leave a stale block behind a working login."""
    import glob
    if _read_block(login_id, password) is None:
        return
    for path in [BLOCK] + glob.glob(BLOCK + ".claim-*"):
        try:
            os.remove(path)
        except OSError:
            pass


def resolve(env):
    """(login_id, password) for SKCOM login from a parsed .env mapping; the
    vault when .env holds the sentinel. (None, None) when nothing is bound."""
    env = {k.casefold(): v for k, v in env.items()}  # the desktop may send CAPITAL_API_KEY
    login_id = env.get("capital_api_key") or env.get("capital_id")
    password = env.get("capital_password")
    if not (password or "").startswith(PW_PREFIX):
        return login_id, password
    try:
        with open(VAULT, encoding="utf-8") as f:
            v = json.load(f)
    except PermissionError:
        raise RuntimeError("capital credentials vault not readable by this identity — "
                           "群益 code must run as Administrator (NSSM worker / schtasks vehicle)")
    except (OSError, ValueError) as e:
        raise RuntimeError(f"capital credentials vault unreadable ({type(e).__name__}) — rebind 群益")
    return v.get("capital_api_key"), v.get("capital_password")
