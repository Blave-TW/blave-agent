"""Desktop: a real exchange key reaches .env only through the permission gate
(audit S2). The gate lives in command_listener._cmd_credentials — the one
writer — so every caller shares it; the chat bind is refused outright on the
desktop. No network: _binance_restrictions is replaced, and for OKX / BingX /
Gate.io / Bybit (checked by the venue's own lib/account_<id>.get_equity) the
requests calls are stubbed. Keys are not-a-real-* strings.

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
# an eviction clears the old venue's routing and re-syncs the schedules; with
# no config on this fake machine the first logs a FileNotFoundError every time
# (noise that hides a real one) and the second would shell out to the DEV BOX's
# real crontab. Routing/eviction itself is covered by check_venue_bind.py and
# check_credentials_withdraw_gate.py.
with open(os.path.join(WS, "manager", "portfolio_config.json"), "w") as f:
    f.write("{}")
cl._sync_strategy_crons = lambda names: None


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
cl.LOCAL_OPEN_VENUES = frozenset(cl.LOCAL_OPEN_VENUES | {"KUCOIN"})
msg = refused({"KUCOIN_API_KEY": "not-a-real-kucoin-key", "KUCOIN_SECRET_KEY": "not-a-real-kucoin-secret"})
check(bool(msg) and "no permission check" in msg and not os.path.exists(ENV_PATH),
      "a widened switch without a checker still writes nothing")
check(sorted(cl._LOCAL_KEY_CHECKS) == ["BINGX", "BYBIT", "GATEIO", "OKX"],
      "the venues with a desktop checker are exactly OKX, BingX, Gate.io, Bybit (a new one is a decision)")
check(sorted(cl._WITHDRAW_CHECKED) == ["BINGX", "BYBIT", "OKX"] and cl._WITHDRAW_CHECKED <= set(cl._LOCAL_KEY_CHECKS),
      "withdrawal permission is checked for exactly OKX, BingX, Bybit (Gate.io exposes no such field)")
trade_src = open(os.path.join(ROOT, "shell", "renderer", "trade.js"), encoding="utf-8").read()
import re  # noqa: E402
flagged = {m.group(1).upper() for m in re.finditer(r'(\w+): \{[^}]*noWdCheck: true', trade_src)}
check(flagged == set(cl._LOCAL_KEY_CHECKS) - cl._WITHDRAW_CHECKED,
      f"the app flags exactly the unchecked venues (noWdCheck) so the user is told to check by hand: {sorted(flagged)}")

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

# 4c. OKX / BingX / Gate.io / Bybit: the venue's own signed account read decides, before any write
import requests  # noqa: E402
import importlib  # noqa: E402

VENUE_ENV = {
    "OKX": {"OKX_API_KEY": "not-a-real-okx-key", "OKX_SECRET_KEY": "not-a-real-okx-secret",
            "OKX_PASSPHRASE": "not-a-real-okx-pass"},
    "BINGX": {"BINGX_API_KEY": "not-a-real-bingx-key", "BINGX_SECRET_KEY": "not-a-real-bingx-secret"},
    "GATEIO": {"GATEIO_API_KEY": "not-a-real-gate-key", "GATEIO_SECRET_KEY": "not-a-real-gate-secret"},
    "BYBIT": {"BYBIT_API_KEY": "not-a-real-bybit-key", "BYBIT_SECRET_KEY": "not-a-real-bybit-secret"},
}
wire, echo = [], []


class _Rejected:
    """Every venue's "bad key" shape at once: HTTP 401, OKX/BingX `code`, Gate `label`,
    Bybit `retCode` — and a message that echoes key material, as Bybit's 10004 does."""
    status_code, ok, url = 401, False, "https://api.example.invalid/v5/x?sign=abc"

    @property
    def text(self):
        return "invalid key " + " ".join(echo)

    def json(self):
        return {"code": 50111, "msg": self.text, "label": "INVALID_KEY", "message": self.text,
                "retCode": 10003, "retMsg": self.text}

    def raise_for_status(self):
        raise requests.HTTPError(f"401 Client Error: Unauthorized for url: {self.url} {self.text}")


def _rejecting(*a, **k):
    wire.append(a[:2])
    return _Rejected()


def _no_wire(*a, **k):
    raise AssertionError("network call during a stubbed check")


real_wire = (requests.get, requests.post, requests.request)
cl.LOCAL_OPEN_VENUES = frozenset(cl.LOCAL_OPEN_VENUES | set(VENUE_ENV))
before = open(ENV_PATH).read()  # the Binance pair from 4b: a refused bind must not evict it
try:
    for vid, venv in VENUE_ENV.items():
        mod = importlib.import_module(f"lib.account_{vid.lower()}")
        real_eq = mod.get_equity
        # fails: the real lib against a venue that answers "bad key" — nothing written
        requests.get = requests.post = requests.request = _rejecting
        del wire[:]
        echo[:] = venv.values()
        msg = refused(venv)
        check(bool(msg) and msg.startswith("REJECTED:") and wire and open(ENV_PATH).read() == before
              and not any(v in msg for v in venv.values()) and "https://" not in msg,
              f"{vid}: the venue refuses the key → REJECTED with its error, .env byte-for-byte as "
              f"before (nothing written, nothing evicted), no key value or URL in the message")
        # half a pair: refused before any call
        requests.get = requests.post = requests.request = _no_wire
        half = dict(list(venv.items())[:-1])
        msg = refused(half)
        check(bool(msg) and msg.startswith("INCOMPLETE_PAIR:") and open(ENV_PATH).read() == before,
              f"{vid}: an incomplete payload is refused before asking (the .env sibling is no stand-in)")
        # an answer that is not an equity: refused
        mod.get_equity = lambda env: {"equity": "0"}
        msg = refused(venv)
        check(bool(msg) and msg.startswith("UNKNOWN:") and open(ENV_PATH).read() == before,
              f"{vid}: an unreadable answer is a refusal, nothing written")
        # the account reads; then the key's withdrawal permission decides (Wei 2026-09-25):
        # on / unreadable / not a bool → refused, nothing written; off → written
        mod.get_equity = lambda env: {"equity": 0.0, "currency": "USDT"}
        real_wd = getattr(mod, "withdraw_enabled", None)
        if vid in cl._WITHDRAW_CHECKED:
            check(callable(real_wd), f"{vid}: lib/account_{vid.lower()} ships withdraw_enabled")
            for wname, wval, wcode in (("withdrawals on", True, "WITHDRAW_ENABLED:"),
                                       ("permission endpoint refuses", Exception("40001 " + list(venv.values())[0]), "UNKNOWN:"),
                                       ("answer is not a bool", "false", "UNKNOWN:")):
                def _wd(env, wval=wval):
                    if isinstance(wval, Exception):
                        raise wval
                    return wval
                mod.withdraw_enabled = _wd
                msg = refused(venv)
                check(bool(msg) and msg.startswith(wcode) and open(ENV_PATH).read() == before
                      and not any(v in msg for v in venv.values()),
                      f"{vid}: {wname} → {wcode} nothing written, no key value in the message")
            del mod.withdraw_enabled
            msg = refused(venv)
            check(bool(msg) and "no permission check" in msg and open(ENV_PATH).read() == before,
                  f"{vid}: a lib without withdraw_enabled is refused, never silently unchecked")
            mod.withdraw_enabled = lambda env: False
        else:
            check(real_wd is None, f"{vid}: no withdrawal check exists (the app tells the user to check by hand)")
        # passes: written
        seen = []
        mod.get_equity = lambda env, seen=seen: seen.append(dict(env)) or {"equity": 0.0, "currency": "USDT"}
        check(refused(venv) is None and seen and all(seen[0].get(k) == v for k, v in venv.items()),
              f"{vid}: the venue accepts the key (checked with the payload's own fields) → written")
        body = open(ENV_PATH).read()
        check(all(f"{k}={v}" in body for k, v in venv.items()) and "BINANCE_API_KEY" not in body
              and stat.S_IMODE(os.stat(ENV_PATH).st_mode) == 0o600,
              f"{vid}: .env holds its fields (0600) and the previous venue was evicted as for any bind")
        mod.get_equity = real_eq
        if real_wd is not None:
            mod.withdraw_enabled = real_wd
        open(ENV_PATH, "w").write(before)
        os.chmod(ENV_PATH, 0o600)
    # an old workspace with no lib/account_<id>: no checker there → nothing written
    sys.modules["lib.account_okx"] = None
    msg = refused(VENUE_ENV["OKX"])
    check(bool(msg) and "no permission check" in msg and open(ENV_PATH).read() == before,
          "OKX on a workspace without lib/account_okx: refused, nothing written")
    del sys.modules["lib.account_okx"]
finally:
    requests.get, requests.post, requests.request = real_wire
daemon_src = open(os.path.join(ROOT, "runtime", "local_daemon.py"), encoding="utf-8").read()
check('{"BINANCE", "OKX", "BINGX", "GATEIO", "BYBIT"}' in daemon_src,
      "local_daemon.py opens exactly Binance + the four checked venues on the desktop")

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

# 7. the cloud box runs the SAME Binance check (2026-09-22 — it used to write
# whatever it was handed; the web connect flow lands here too). Only the
# local-only parts above are local: the paper-only switch and the
# no-checker-no-bind rule. Full verdict coverage: check_credentials_withdraw_gate.py
os.environ.pop("BLAVE_AGENT_LOCAL")
os.remove(ENV_PATH)
calls.clear()
answer(dict(GOOD, enableFutures=False, enableSpotAndMarginTrading=False))
msg = refused()
check(msg is not None and msg.startswith("TRADING_DISABLED:") and len(calls) == 1
      and not os.path.exists(ENV_PATH),
      "cloud box: a key that cannot trade is refused there too")
calls.clear()
answer(GOOD)
check(refused() is None and calls == [(KEY, SECRET)] and os.path.exists(ENV_PATH),
      "cloud box: a clean key binds")
try:
    venue.bind("binance", dict(ENV))
    check(bool(loaded), "cloud box: chat bind still goes through the runtime")
except Exception as e:  # noqa: BLE001
    check(False, f"cloud box: chat bind raised {type(e).__name__}: {e}")

print("all ok" if not fails else f"{fails} FAILED")
sys.exit(1 if fails else 0)
