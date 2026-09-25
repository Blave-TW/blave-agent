"""A Binance key that can withdraw, cannot trade, or whose permissions cannot
be read, never reaches .env — on a CLOUD box too, not just the desktop (the
check has to run on the machine: the user's whitelist holds the machine's IP,
so the same question asked from the app's computer comes back -2015 and
decides nothing). Withdrawal permission is gated since Wei 2026-09-25 (a
leaked key must not be able to move money out; reverses 09-22).

The gate is command_listener._binance_bind_check, called from _cmd_credentials
— the one .env writer, shared by the web connect flow, the desktop app and the
chat bind. A refusal must leave the machine byte-identical: _cmd_credentials
also evicts the venue the user is trading on today, so a half-applied refusal
would unbind a working venue on the way to writing nothing.

No network: _binance_restrictions is replaced (and its own HTTP→code mapping is
exercised with a fake urlopen).

Run: cd blave-agent && .venv/bin/python tests/check_credentials_withdraw_gate.py
"""
import io
import json
import os
import sys
import tempfile
import time
import urllib.error

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BASE = tempfile.mkdtemp(prefix="cred-withdraw-gate-")
WS = os.path.join(BASE, "workspace")
os.makedirs(os.path.join(WS, "manager"))
os.environ["BLAVE_AGENT_BASE"] = BASE
os.environ["BLAVE_AGENT_WORKSPACE"] = WS
os.environ.pop("BLAVE_AGENT_LOCAL", None)  # cloud box — the gate is NOT local-only
sys.path.insert(0, os.path.join(ROOT, "runtime"))
sys.path.insert(0, ROOT)
os.chdir(WS)  # lib/guard writes state/HALT relative to the cwd — keep it out of the repo
import command_listener as cl  # noqa: E402

REAL_RESTRICTIONS = cl._binance_restrictions
fails = 0
KEY, SECRET = "K" * 64, "s" * 64
ENV = {"BINANCE_API_KEY": KEY, "BINANCE_SECRET_KEY": SECRET}
ENV_PATH = os.path.join(WS, ".env")
MANIFEST = os.path.join(WS, "manager", "credentials.ui.json")
CONFIG = os.path.join(WS, "manager", "portfolio_config.json")
MIRROR = os.path.join(WS, "manager", "amounts.ui.json")
HALT = os.path.join(WS, "state", "HALT")
GOOD = {"ipRestrict": True, "enableWithdrawals": False,
        "enableSpotAndMarginTrading": True, "enableFutures": True}
# the state a refusal must not touch: another venue's live credentials, the
# platform's own data keys, a user comment, and the bind manifest naming okx
# 值一律用 not-a-real-* 前綴:gitleaks 會把 "okx-secret" 這種形狀當成真的外洩擋下 commit
SEED = ["BLAVE_API_KEY=not-a-real-blave-key", "BLAVE_SECRET_KEY=not-a-real-blave-secret",
        "OKX_API_KEY=not-a-real-okx-key", "OKX_SECRET_KEY=not-a-real-okx-secret",
        "OKX_PASSPHRASE=not-a-real-okx-pass", "# user's own line"]


def check(cond, msg):
    global fails
    print(("ok   " if cond else "FAIL ") + msg)
    fails += 0 if cond else 1


calls = []
crons = []
# a bind with funded strategies re-syncs the schedules, which on this dev box
# would shell out to the REAL crontab. Stubbed, not avoided by leaving the
# amounts out: the refusals have to be shown not to touch the schedules either.
cl._sync_strategy_crons = lambda names: crons.append(sorted(names))


def answer(value):
    def fake(api_key, secret):
        calls.append((api_key, secret))
        if isinstance(value, Exception):
            raise value
        return value
    cl._binance_restrictions = fake


def reset():
    """Back to the seeded machine: okx bound and routed, nothing halted. The
    routing files matter — a bind EVICTS the previous venue and blanks its
    `exchanges` values, so a refusal that got that far would unbind the venue
    the user is trading on today while saving nothing — and `amounts` is what
    makes a bind reach the schedule re-sync (stubbed above)."""
    calls.clear()
    crons.clear()
    cl._binance_rl_until = 0.0  # a rate-limit cooldown one case armed would
    #                             otherwise refuse the next case before it asks
    with open(ENV_PATH, "w") as f:
        f.write("\n".join(SEED) + "\n")
    with open(MANIFEST, "w") as f:
        json.dump({"ids": ["okx"], "saved_at": "seed"}, f)
    for p in (CONFIG, MIRROR):
        with open(p, "w") as f:
            json.dump({"amounts": {"s1": 100}, "exchanges": {"s1": "okx"}}, f)
    if os.path.exists(HALT):
        os.remove(HALT)


def state():
    return tuple(open(p).read() for p in (ENV_PATH, MANIFEST, CONFIG, MIRROR)) + (
        os.path.exists(HALT),)


def refused(env=ENV):
    """→ the ValueError text, or None when the write went through."""
    try:
        cl._cmd_credentials({"env": dict(env)})
        return None
    except ValueError as e:
        return str(e)


# 1. the refusals — every one of them leaves the machine exactly as it was
for name, value, code in (
        ("withdrawals enabled", dict(GOOD, enableWithdrawals=True), "WITHDRAW_ENABLED"),
        ("withdrawals enabled beats every trading flag (checked first)",
         dict(GOOD, enableWithdrawals=True, enableSpotAndMarginTrading=False,
              enableFutures=False, ipRestrict=False), "WITHDRAW_ENABLED"),
        ("withdrawals field missing",
         {k: v for k, v in GOOD.items() if k != "enableWithdrawals"}, "UNKNOWN"),
        ("withdrawals field not a bool", dict(GOOD, enableWithdrawals="false"), "UNKNOWN"),
        ("neither spot nor futures enabled",
         dict(GOOD, enableSpotAndMarginTrading=False, enableFutures=False), "TRADING_DISABLED"),
        ("answer is not the permission object", "<html>", "UNKNOWN"),
        ("network down", cl._BinanceCheckFailed("NETWORK", "URLError"), "NETWORK"),
        ("rate limited", cl._BinanceCheckFailed("RATE_LIMITED", "HTTPError 429"), "RATE_LIMITED"),
        ("some other exception type", OSError("down"), "UNKNOWN"),
):
    reset()
    before = state()
    answer(value)
    msg = refused()
    check(bool(msg) and msg.startswith(code + ":") and len(calls) == 1
          and KEY not in msg and SECRET not in msg,
          f"refused with {code}, no key value in the message: {name}")
    check(state() == before and not crons,
          f"nothing written, okx not evicted, routing/schedules/halt untouched: {name}")

# half a pair can never be verified — and the sibling already in .env is not a
# stand-in for the one that is missing
reset()
answer(GOOD)
check((refused({"BINANCE_API_KEY": KEY}) or "").startswith("INCOMPLETE_PAIR:")
      and not calls and state()[0] == "\n".join(SEED) + "\n",
      "half a pair: refused before asking Binance, nothing written")

# 2. _binance_restrictions' own HTTP → code mapping (no _binance_restrictions stub)
cl._binance_restrictions = REAL_RESTRICTIONS


def http_error(status, body):
    def fake_urlopen(req, timeout=None):
        raise urllib.error.HTTPError(
            "https://api.binance.com", status, "err", {}, io.BytesIO(body))
    cl.urllib.request.urlopen = fake_urlopen


real_urlopen = cl.urllib.request.urlopen
for status, body, code in (
        (401, b'{"code":-2015,"msg":"Invalid API-key, IP, or permissions"}', "IP_OR_KEY"),
        (400, b'{"code":-2014,"msg":"API-key format invalid."}', "BAD_KEY_FORMAT"),
        (401, b'{"code":-1022,"msg":"Signature for this request is not valid."}', "BAD_SECRET"),
        (400, b'{"code":-1021,"msg":"Timestamp for this request..."}', "CLOCK"),
        (429, b"", "RATE_LIMITED"),
        (418, b"", "RATE_LIMITED"),
        (503, b"<html>bad gateway</html>", "UNKNOWN"),
):
    reset()
    http_error(status, body)
    before = state()
    msg = refused()
    check(bool(msg) and msg.startswith(code + ":") and state() == before,
          f"HTTP {status} → {code}, nothing written")
# 2b. RATE_LIMITED arms a cooldown (audit S-2). Nothing above this layer backs
# off — the web command endpoint has no rate limit and the user just presses
# 連接 again — and a retried 429 becomes a 418 that bans this machine's IP from
# Binance, strategy orders included. So the second attempt must not reach the
# network at all.
sent = []


def counting_http_error(status):
    def fake_urlopen(req, timeout=None):
        sent.append(1)
        raise urllib.error.HTTPError(
            "https://api.binance.com", status, "err", {}, io.BytesIO(b""))
    cl.urllib.request.urlopen = fake_urlopen


cl._binance_rl_until = 0.0
reset()
counting_http_error(429)
before = state()
check((refused() or "").startswith("RATE_LIMITED:") and len(sent) == 1,
      "429 → RATE_LIMITED, nothing saved")
# the window's LENGTH and its CLOCK, pinned in absolute terms: a deadline built
# from time.time() is ~1.7e9 and would sail through a "did it move" check while
# a system clock step (NTP, a VM resume) silently cancels or freezes the
# cooldown. monotonic seconds since boot are nowhere near that magnitude.
armed = cl._binance_rl_until - time.monotonic()
check(59 <= armed <= 61, f"429 locks for ~60s, not merely 'longer' ({armed:.1f}s)")
check(cl._binance_rl_until < time.time() - 86400,
      "the deadline is on the monotonic clock, not wall clock")
msg = refused()
check(msg.startswith("RATE_LIMITED:") and len(sent) == 1 and state() == before,
      "inside the cooldown: refused with no request at all")
cl._binance_rl_until = time.monotonic() - 1  # the window has passed
check((refused() or "").startswith("RATE_LIMITED:") and len(sent) == 2,
      "cooldown over: the next attempt goes out again")
counting_http_error(418)
cl._binance_rl_until = time.monotonic() - 1
refused()
armed = cl._binance_rl_until - time.monotonic()
check(299 <= armed <= 301,
      f"418 (IP ban) locks for ~300s, the app's own window ({armed:.1f}s)")
cl._binance_rl_until = 0.0
cl.urllib.request.urlopen = real_urlopen

# 3. the passing cases — spot OR futures is enough (lib/order_binance places both);
#    withdrawals must be off in every one of them
for name, value, verdict in (
        ("spot and futures", GOOD, "OK"),
        ("spot only", dict(GOOD, enableFutures=False), "OK"),
        ("futures only", dict(GOOD, enableSpotAndMarginTrading=False), "OK"),
        ("no IP whitelist (advise, don't block)", dict(GOOD, ipRestrict=False), "NO_IP_RESTRICT"),
):
    reset()
    answer(value)
    try:
        out = cl._cmd_credentials({"env": dict(ENV)})
    except ValueError as e:
        out = None
        check(False, f"{name} → written ({e})")
    if out is None:
        continue
    body = open(ENV_PATH).read()
    check(f"BINANCE_API_KEY={KEY}" in body and f"BINANCE_SECRET_KEY={SECRET}" in body
          and "BLAVE_API_KEY=not-a-real-blave-key" in body and "OKX_API_KEY" not in body,
          f"{name} → written, okx evicted, platform keys kept")
    check(out["binance"] == {"checked": True, "code": verdict,
                             "ipRestrict": value["ipRestrict"],
                             "spot": value["enableSpotAndMarginTrading"],
                             "futures": value["enableFutures"]}
          and out["credentials"] == 2,
          f"{name} → ack says it was checked: {out['binance']}")

# 4. everything that is not Binance is untouched by the Binance gate: no call, no verdict
import lib.account_okx as okx  # noqa: E402

okx.withdraw_enabled = lambda env: False  # the cloud withdrawal gate runs on OKX too (5.)
for name, env in (
        ("paper", {"PAPER_API_KEY": "paper", "PAPER_SECRET_KEY": "paper"}),
        ("okx", {"OKX_API_KEY": "k", "OKX_SECRET_KEY": "s", "OKX_PASSPHRASE": "p"}),
        ("gateio", {"GATEIO_API_KEY": "k", "GATEIO_SECRET_KEY": "s"}),
):
    reset()
    answer(dict(GOOD, enableFutures=False, enableSpotAndMarginTrading=False))  # would refuse if asked
    out = None
    try:
        out = cl._cmd_credentials({"env": dict(env)})
    except ValueError as e:
        check(False, f"{name} bind raised {e}")
    check(out is not None and not calls and out["binance"] is None
          and f"{sorted(env)[0]}=" in open(ENV_PATH).read(),
          f"{name}: bound without asking Binance anything, binance=None in the ack")

# 5. a cloud box refuses an OKX / BingX / Bybit key that can withdraw too (Wei 2026-09-25):
#    one request to the venue, no account read; unreadable = refusal; Gate.io has no check
import importlib  # noqa: E402

ENV_OF = {"OKX": {"OKX_API_KEY": "k", "OKX_SECRET_KEY": "s", "OKX_PASSPHRASE": "p"},
          "BINGX": {"BINGX_API_KEY": "k", "BINGX_SECRET_KEY": "s"},
          "BYBIT": {"BYBIT_API_KEY": "k", "BYBIT_SECRET_KEY": "s"}}
check(sorted(cl._WITHDRAW_CHECKED) == sorted(ENV_OF), "withdrawal is checked for exactly OKX, BingX, Bybit")
for vid, venv in ENV_OF.items():
    mod = importlib.import_module(f"lib.account_{vid.lower()}")
    real_wd, real_eq = mod.withdraw_enabled, mod.get_equity
    mod.get_equity = lambda env: (_ for _ in ()).throw(AssertionError("cloud bind must not read the account"))
    seen = []
    for wname, wval, wcode in (("withdrawals on", True, "WITHDRAW_ENABLED:"),
                               ("permission endpoint refuses", Exception("40001 " + venv[f"{vid}_API_KEY"]), "UNKNOWN:"),
                               ("answer is not a bool", "false", "UNKNOWN:")):
        reset()
        before = state()

        def _wd(env, wval=wval):
            seen.append(dict(env))
            if isinstance(wval, Exception):
                raise wval
            return wval
        mod.withdraw_enabled = _wd
        msg = refused(venv)
        check(bool(msg) and msg.startswith(wcode) and state() == before and not crons and "k" * 4 not in msg,
              f"cloud {vid}: {wname} → {wcode} nothing written, okx not evicted")
    if vid == "BYBIT":
        # audit A-1: a stale BYBIT_DEMO=true in .env (or in the payload) must not turn the
        # check off — the real withdraw_enabled asks the LIVE host; a live key answering
        # "Withdraw" is refused, a key the live host rejects as a credential is a demo key
        import requests
        mod.withdraw_enabled = real_wd
        real_req = requests.request
        wire = []

        class _Live:
            status_code, ok = 200, True

            def __init__(self, payload):
                self.payload = payload

            def raise_for_status(self):
                pass

            def json(self):
                return self.payload

        def _answer(payload):
            def fake(method, url, **kw):
                wire.append((method, url))
                return _Live(payload)
            requests.request = fake
        try:
            for where, seed_extra, payload_extra in (("in .env", ["BYBIT_DEMO=true"], {}),
                                                     ("in the payload", [], {"BYBIT_DEMO": "true"})):
                reset()
                with open(ENV_PATH, "a") as f:
                    f.write("".join(l + "\n" for l in seed_extra))
                before = state()
                del wire[:]
                _answer({"retCode": 0, "result": {"permissions": {"Wallet": ["AccountTransfer", "Withdraw"]}}})
                msg = refused(dict(venv, **payload_extra))
                check(bool(msg) and msg.startswith("WITHDRAW_ENABLED:") and state() == before
                      and wire and all(u.startswith(mod.LIVE_HOST + "/v5/user/query-api") for _, u in wire),
                      f"cloud BYBIT: demo flag {where} + live key with Withdraw → asked the LIVE host, refused")
                reset()
                with open(ENV_PATH, "a") as f:
                    f.write("".join(l + "\n" for l in seed_extra))
                del wire[:]
                _answer({"retCode": 10003, "retMsg": "API key is invalid."})
                check(refused(dict(venv, **payload_extra)) is None and wire
                      and f"BYBIT_API_KEY={venv['BYBIT_API_KEY']}" in open(ENV_PATH).read(),
                      f"cloud BYBIT: demo flag {where} + a key the live host rejects as a credential = demo key → written")
                reset()
                with open(ENV_PATH, "a") as f:
                    f.write("".join(l + "\n" for l in seed_extra))
                _answer({"retCode": 10006, "retMsg": "Too many visits!"})
                msg = refused(dict(venv, **payload_extra))
                check(bool(msg) and msg.startswith("UNKNOWN:"),
                      f"cloud BYBIT: demo flag {where} + live host answers something else (rate limit) → no verdict, refused")
            reset()
            _answer({"retCode": 10003, "retMsg": "API key is invalid."})
            msg = refused(venv)
            check(bool(msg) and msg.startswith("UNKNOWN:"),
                  "cloud BYBIT: no demo flag + live host rejects the credential → refused (not a demo key)")
        finally:
            requests.request = real_req
    if vid == "BINGX":
        # the real withdraw_enabled against BingX's real answer shapes (three keys measured
        # 2026-09-25): both permission endpoints are HTTP 200 with NO {code,msg,data} envelope;
        # apiRestrictions carries no enableWithdrawals (and its enableFutures /
        # enableSpotAndMarginTrading read False even on a key with both trading permissions —
        # useless for trading); apiPermissions.permissions is an int list: [2] read-only,
        # [2, 5] read + withdraw, [1, 2, 3, 5] read + spot + futures + withdraw
        import requests
        mod.withdraw_enabled = real_wd
        real_get = requests.get
        RESTR = {"ipRestrict": False, "createTime": 1758700000000, "permitsUniversalTransfer": False,
                 "enableReading": True, "enableFutures": False, "enableSpotAndMarginTrading": False}

        class _Bare:
            status_code = 200

            def __init__(self, payload):
                self.payload = payload

            def json(self):
                return self.payload

        def _answer(restr, perms):
            def fake(url, **kw):
                if "/account/apiRestrictions?" in url:
                    return _Bare(restr)
                if "/account/apiPermissions?" in url:
                    return _Bare(perms)
                raise AssertionError(f"unexpected BingX call {url.split('?')[0]}")
            requests.get = fake
        try:
            check(mod._BINGX_WITHDRAW_CODES == frozenset({5}) and mod._BINGX_PERMISSION_CODES == frozenset({1, 2, 3}),
                  "cloud BINGX: code tables = measured 2026-09-25 (1, 3 = trading, 2 = read, 5 = withdraw)")
            for wname, restr, perms, wcode in (
                    ("read-only key: [2], no enableWithdrawals", RESTR, {"permissions": [2], "ipAddresses": [], "note": "n", "apiKey": "k"}, None),
                    ("read + withdraw key: [2, 5] (measured)", RESTR, {"permissions": [2, 5], "ipAddresses": [], "note": "n", "apiKey": "k"}, "WITHDRAW_ENABLED:"),
                    ("read + spot + futures trading key: [1, 2, 3]", RESTR, {"permissions": [1, 2, 3], "ipAddresses": [], "note": "n", "apiKey": "k"}, None),
                    ("read + spot + futures + withdraw key: [1, 2, 3, 5] (measured)", RESTR, {"permissions": [1, 2, 3, 5], "ipAddresses": [], "note": "n", "apiKey": "k"}, "WITHDRAW_ENABLED:"),
                    ("apiRestrictions carries the bool → it wins (True)", dict(RESTR, enableWithdrawals=True), {"permissions": [2]}, "WITHDRAW_ENABLED:"),
                    ("apiRestrictions carries the bool → it wins (False)", dict(RESTR, enableWithdrawals=False), {"permissions": [2, 5]}, None),
                    ("an unmapped code", RESTR, {"permissions": [2, 99]}, "UNKNOWN:"),
                    ("permissions missing", RESTR, {"ipAddresses": []}, "UNKNOWN:"),
                    ("permissions not ints", RESTR, {"permissions": ["2"]}, "UNKNOWN:"),
                    ("permissions empty", RESTR, {"permissions": []}, "UNKNOWN:"),
                    ("enveloped error", RESTR, {"code": 100001, "msg": "signature error", "data": None}, "UNKNOWN:")):
                reset()
                before = state()
                _answer(restr, perms)
                msg = refused(venv)
                if wcode is None:
                    check(msg is None and f"BINGX_API_KEY={venv['BINGX_API_KEY']}" in open(ENV_PATH).read(),
                          f"cloud BINGX: {wname} → written ({msg})")
                else:
                    check(bool(msg) and msg.startswith(wcode) and state() == before,
                          f"cloud BINGX: {wname} → {wcode} nothing written ({msg})")
            reset()
            _answer(RESTR, {"permissions": [2, 4]})
            check((refused(venv) or "").startswith("UNKNOWN:"),
                  "cloud BINGX: a code outside both tables (4 has never been seen on a key) → refused until mapped")
        finally:
            requests.get = real_get
    reset()
    mod.withdraw_enabled = lambda env: (_ for _ in ()).throw(AssertionError("half a pair must be refused before asking"))
    half = dict(list(venv.items())[:-1])
    msg = refused(half)
    check(bool(msg) and msg.startswith("INCOMPLETE_PAIR:") and state()[0] == "\n".join(SEED) + "\n",
          f"cloud {vid}: half a pair is refused before asking the venue (the .env sibling is no stand-in)")
    reset()
    mod.withdraw_enabled = lambda env: False
    out = cl._cmd_credentials({"env": dict(venv)})
    check(out["binance"] is None and all(f"{k}={v}" in open(ENV_PATH).read() for k, v in venv.items()),
          f"cloud {vid}: withdrawals off → written")
    del mod.withdraw_enabled
    reset()
    msg = refused(venv)
    check(bool(msg) and "no permission check" in msg and state()[0] == "\n".join(SEED) + "\n",
          f"cloud {vid}: a lib without withdraw_enabled is refused, never silently unchecked")
    mod.withdraw_enabled, mod.get_equity = real_wd, real_eq

print("all ok" if not fails else f"{fails} FAILED")
sys.exit(1 if fails else 0)
