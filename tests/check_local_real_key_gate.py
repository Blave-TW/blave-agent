"""Desktop: a real exchange key reaches .env only through the permission gate
(audit S2). The gate lives in command_listener._cmd_credentials — the one
writer — so every caller shares it; the chat bind is refused outright on the
desktop. No network: _binance_restrictions is replaced.

Run: cd blave-agent && .venv/bin/python tests/check_local_real_key_gate.py
"""
import os
import stat
import sys
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BASE = tempfile.mkdtemp(prefix="local-keygate-")
WS = os.path.join(BASE, "workspace")
os.makedirs(os.path.join(WS, "manager"))
os.environ["BLAVE_AGENT_BASE"] = BASE
os.environ["BLAVE_AGENT_WORKSPACE"] = WS
os.environ["BLAVE_AGENT_LOCAL"] = "1"
sys.path.insert(0, os.path.join(ROOT, "runtime"))
sys.path.insert(0, ROOT)
os.chdir(WS)  # lib/guard writes state/HALT relative to the cwd — keep it out of the repo
import command_listener as cl  # noqa: E402

fails = 0
KEY, SECRET = "K" * 64, "s" * 64
ENV = {"BINANCE_API_KEY": KEY, "BINANCE_SECRET_KEY": SECRET}
ENV_PATH = os.path.join(WS, ".env")
GOOD = {"ipRestrict": True, "enableWithdrawals": False,
        "enableSpotAndMarginTrading": True, "enableFutures": True}


def check(cond, msg):
    global fails
    print(("ok   " if cond else "FAIL ") + msg)
    fails += 0 if cond else 1


calls = []


def answer(value):
    def fake(api_key, secret):
        calls.append((api_key, secret))
        if isinstance(value, Exception):
            raise value
        return value
    cl._binance_restrictions = fake


def refused(env=ENV):
    """→ the ValueError text, or None when the write went through."""
    try:
        cl._cmd_credentials({"env": dict(env)})
        return None
    except ValueError as e:
        return str(e)


# 1. the default process (= the agent's, where lib.venue.bind runs): paper only
answer(GOOD)
msg = refused()
check(msg and "模擬交易" in msg and not calls and not os.path.exists(ENV_PATH),
      "default LOCAL_OPEN_VENUES: a Binance key is refused before anything is asked or written")

# 2. the daemon's process opens Binance — from here on the gate is what decides
cl.LOCAL_OPEN_VENUES = frozenset(cl.LOCAL_OPEN_VENUES | {"BINANCE"})
for name, value in (
        ("withdrawals enabled", dict(GOOD, enableWithdrawals=True)),
        ("withdrawals field missing", {k: v for k, v in GOOD.items() if k != "enableWithdrawals"}),
        ("withdrawals field not a bool", dict(GOOD, enableWithdrawals="false")),
        ("neither spot nor futures trading enabled", dict(GOOD, enableFutures=False, enableSpotAndMarginTrading=False)),
        ("answer is not an object", "<html>"),
        ("network error", OSError("down")),
        ("HTTP error", RuntimeError("401")),
):
    calls.clear()
    answer(value)
    msg = refused()
    check(bool(msg) and len(calls) == 1 and not os.path.exists(ENV_PATH)
          and KEY not in msg and SECRET not in msg,
          f"gate refuses: {name} — .env untouched, no key value in the message")

calls.clear()
answer(GOOD)
check(refused({"BINANCE_API_KEY": KEY}) is not None and not os.path.exists(ENV_PATH),
      "half a pair is never a bind: refused")

# 3. a venue with no checker cannot ride along when someone widens the switch
cl.LOCAL_OPEN_VENUES = frozenset(cl.LOCAL_OPEN_VENUES | {"BINGX"})
msg = refused({"BINGX_API_KEY": "a" * 32, "BINGX_SECRET_KEY": "b" * 32})
check(bool(msg) and "no permission check" in msg and not os.path.exists(ENV_PATH),
      "a widened switch without a checker still writes nothing")

# 4. the passing case: written, 0600, no-whitelist keys are NOT refused (Wei: advise, don't block)
calls.clear()
answer(dict(GOOD, ipRestrict=False))
check(refused() is None and calls == [(KEY, SECRET)], "all good (even without an IP whitelist) → written")
body = open(ENV_PATH).read()
check(f"BINANCE_API_KEY={KEY}" in body and f"BINANCE_SECRET_KEY={SECRET}" in body
      and stat.S_IMODE(os.stat(ENV_PATH).st_mode) == 0o600, ".env holds the pair, mode 0600")

# 4b. spot OR futures is enough (lib/order_binance places both) — same rule as the app's screen
for name, value in (("spot only", dict(GOOD, enableFutures=False)), ("futures only", dict(GOOD, enableSpotAndMarginTrading=False))):
    os.remove(ENV_PATH)
    answer(value)
    check(refused() is None and os.path.exists(ENV_PATH), f"{name} trading enabled → written")

# 5. paper needs no gate
calls.clear()
check(refused({"PAPER_API_KEY": "paper", "PAPER_SECRET_KEY": "paper"}) is None and not calls,
      "paper binds without asking any exchange")

# 6. chat bind on the desktop: refused before the runtime is even loaded
import lib.venue as venue  # noqa: E402
loaded = []
venue._runtime_listener = lambda: loaded.append(1) or cl
try:
    venue.bind("binance", dict(ENV))
    check(False, "lib.venue.bind refuses a real venue on the desktop")
except ValueError as e:
    check("連接交易所" in str(e) and not loaded and KEY not in str(e),
          "lib.venue.bind refuses a real venue on the desktop, runtime never touched")

# 7. cloud unchanged: the gate is local-only
os.environ.pop("BLAVE_AGENT_LOCAL")
calls.clear()
answer(dict(GOOD, enableWithdrawals=True))
check(refused() is None and not calls, "cloud box: no gate, same behaviour as before")
try:
    venue.bind("binance", dict(ENV))
    check(bool(loaded), "cloud box: chat bind still goes through the runtime")
except Exception as e:  # noqa: BLE001
    check(False, f"cloud box: chat bind raised {type(e).__name__}: {e}")

print("all ok" if not fails else f"{fails} FAILED")
sys.exit(1 if fails else 0)
