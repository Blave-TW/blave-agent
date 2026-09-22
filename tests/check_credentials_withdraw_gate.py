"""A Binance key that cannot trade, or whose permissions cannot be read, never
reaches .env — on a CLOUD box too, not just the desktop (the check has to run
on the machine: the user's whitelist holds the machine's IP, so the same
question asked from the app's computer comes back -2015 and decides nothing).
Withdrawal permission is NOT gated (Wei 2026-09-22): a withdrawal-enabled key
binds like any other.

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
#    withdrawals on or off makes no difference
for name, value, verdict in (
        ("spot and futures", GOOD, "OK"),
        ("spot only", dict(GOOD, enableFutures=False), "OK"),
        ("futures only", dict(GOOD, enableSpotAndMarginTrading=False), "OK"),
        ("no IP whitelist (advise, don't block)", dict(GOOD, ipRestrict=False), "NO_IP_RESTRICT"),
        ("withdrawals enabled (not gated)", dict(GOOD, enableWithdrawals=True), "OK"),
        ("withdrawals enabled, no whitelist",
         dict(GOOD, enableWithdrawals=True, ipRestrict=False), "NO_IP_RESTRICT"),
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

# 4. everything that is not Binance is untouched: no call, no verdict
for name, env in (
        ("paper", {"PAPER_API_KEY": "paper", "PAPER_SECRET_KEY": "paper"}),
        ("okx", {"OKX_API_KEY": "k", "OKX_SECRET_KEY": "s", "OKX_PASSPHRASE": "p"}),
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

print("all ok" if not fails else f"{fails} FAILED")
sys.exit(1 if fails else 0)
