"""Where 統一期貨's login lives, which host it may reach, and the one login path.

Same contract as lib/capital_vault.py: only the order lib and
lib/president_worker.py call resolve() — lib/account_president.py reads the
worker's snapshot and never holds a password. `.env` holds the values today;
a `vault:` sentinel in president_password / president_ca_password points at
<base>/credentials/president_vault.json instead (no connect flow writes it
yet — the resolver is here so the one that does changes nothing below it).

Host gate: without PRESIDENT_LIVE=true only a *.testpfctrade.com host is
accepted (the test hosts' TLS certificate covers exactly that — the broker's
activation mail writes test167.pfctrade.com, the working URL is
https://test167.testpfctrade.com). With it, president_url (production) is used.

Imported two ways like capital_vault: `import president_vault` from the
worker script (lib/ is sys.path[0]), `lib.president_vault` elsewhere. Keep it
free of other lib imports.
"""
import json
import os
from urllib.parse import urlparse

VAULT = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))),
                     "credentials", "president_vault.json")
PW_PREFIX = "vault:"
TEST_HOST_SUFFIX = ".testpfctrade.com"
_SECRETS = ("president_password", "president_ca_password")


def _fold(env):
    # PowerShell 5 `Set-Content -Encoding UTF8` writes a BOM onto the first key
    return {str(k).lstrip("\ufeff").casefold(): v for k, v in env.items()}


def live(env):
    env = _fold(env)
    return str(env.get("president_live") or "").strip().lower() == "true"


def endpoint(env):
    """The login URL this environment may use, or ValueError."""
    folded = _fold(env)
    if live(env):
        url = (folded.get("president_url") or "").strip()
        if not url:
            raise ValueError("PRESIDENT_LIVE=true but president_url is not set")
    else:
        url = (folded.get("president_test_url") or "").strip()
        host = (urlparse(url).hostname or "").lower()
        if not host.endswith(TEST_HOST_SUFFIX):
            raise ValueError(f"president_test_url host {host or url!r} is not *{TEST_HOST_SUFFIX} — "
                             f"without PRESIDENT_LIVE=true only the broker's test hosts are allowed")
    if urlparse(url).scheme != "https":
        raise ValueError(f"president login URL must be https://, got {url!r}")
    return url.rstrip("/")


def resolve(env):
    """{url, account, password, ca_path, ca_password, live} from a parsed .env
    mapping; secrets come from the vault when .env holds the sentinel."""
    folded = _fold(env)
    creds = {k: folded.get(k) or "" for k in ("president_account", "president_ca_path") + _SECRETS}
    if any(creds[k].startswith(PW_PREFIX) for k in _SECRETS):
        try:
            with open(VAULT, encoding="utf-8") as f:
                v = json.load(f)
        except PermissionError:
            raise RuntimeError("president credentials vault not readable by this identity")
        except (OSError, ValueError) as e:
            raise RuntimeError(f"president credentials vault unreadable ({type(e).__name__}) — rebind 統一期貨")
        for k in _SECRETS:
            if creds[k].startswith(PW_PREFIX):
                creds[k] = v.get(k) or ""
    if not creds["president_account"] or not creds["president_password"]:
        raise ValueError("president_account / president_password missing from .env")
    if not creds["president_ca_path"]:
        raise ValueError("president_ca_path missing from .env (the .pfx certificate)")
    return {"url": endpoint(env), "account": creds["president_account"],
            "password": creds["president_password"], "ca_path": creds["president_ca_path"],
            "ca_password": creds["president_ca_password"], "live": live(env)}


# ── the one login path (worker and order lib) ────────────────────────────────
LOGIN_TIMEOUT_S = 30


class _CwdOs:
    """`os` as the unitrade modules see it, with getcwd() pinned: the SDK writes
    its logs (login URL, login id, account, every order) to os.getcwd()+"/logs",
    which in a reconciler process is the workspace root. chdir is process-wide
    and the reconciler reads relative paths from other threads, so the SDK's own
    view of cwd is pinned instead."""

    def __init__(self, real, cwd):
        self._real, self._cwd = real, cwd

    def getcwd(self):
        return self._cwd

    def __getattr__(self, name):
        return getattr(self._real, name)


def _pin_sdk_logs(log_dir):
    import sys
    os.makedirs(log_dir, exist_ok=True)
    proxy = _CwdOs(os, log_dir)
    for name, mod in list(sys.modules.items()):
        if (name == "unitrade" or name.startswith("unitrade.")) and getattr(mod, "os", None) is os:
            mod.os = proxy


def login(creds, log_dir):
    """A logged-in Unitrade, or raises. The caller MUST logout() in a finally:
    the SDK starts non-daemon threads (logger, sockets) at login and a process
    that exits without logout() hangs on them forever — failed logins included
    (measured on the test host 2026-09-30: no logout → hung until killed;
    logout → exits in 0.5 s). The returned object is logged out here on every
    failure path."""
    import threading
    from unitrade.unitrade import Unitrade

    _pin_sdk_logs(log_dir)
    api = Unitrade()
    box = {}

    def _run():
        try:
            box["resp"] = api.login(creds["url"], creds["account"], creds["password"],
                                    creds["ca_path"], creds["ca_password"] or "")
        except BaseException as e:  # noqa: BLE001 — reported below
            box["exc"] = e

    t = threading.Thread(target=_run, daemon=True, name="president-login")
    t.start()
    t.join(LOGIN_TIMEOUT_S)
    try:
        if t.is_alive():
            raise TimeoutError(f"統一期貨 login did not answer within {LOGIN_TIMEOUT_S}s")
        if "exc" in box:
            raise RuntimeError(f"統一期貨 login raised {type(box['exc']).__name__}: {box['exc']}")
        resp = box["resp"]
        if not resp.ok:
            raise RuntimeError(f"統一期貨 login failed: {resp.error}")
        if not creds["live"] and api.test_mode is not True:
            raise RuntimeError("統一期貨 login reached a non-test server without PRESIDENT_LIVE=true — "
                               "refused")
        return api
    except BaseException:
        api.logout()
        if t.is_alive():
            # a login still in flight can start the SDK threads after this logout
            t.join(LOGIN_TIMEOUT_S)
            api.logout()
        raise
