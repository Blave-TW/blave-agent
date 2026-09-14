"""Minimal check for the reconciler's read-failure classification and account guard — no network.

What it protects (uid 8232, 2026-09-09): OKX answered 50001 / 50013 for ~15 min,
the old wrapper halted after ANY three failed position reads, and HALT only
clears by hand — entries were blocked for four days. Transient errors now skip
the round instead; key rejections still halt at once; anything unrecognised
keeps the three-strikes halt. The old rule also guarded a real danger — an
empty read after a key swap re-buys the whole target — which the account guard
now covers explicitly.

Asserts: every account lib's REAL raise path (fake HTTP responses) classifies
per its venue table, body code before HTTP status; order-lib exceptions too;
transient failures neither count nor reset the counter; the 30-min
exchange_unreachable event fires once and exchange_recovered follows; a
credential error halts at once; unknown halts at 3; an existing HALT is never
cleared; 3a (empty read at a trigger) and 3b (account id changed) trip, hold
while HALT stands, and are confirmed by the user clearing HALT; a key change
is a trigger and the raw key never reaches the state file.

Run: cd blaveclaw-config && python3 tests/check_reconciler_autohalt.py
"""
import json, os, sys, tempfile

import requests

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
os.chdir(tempfile.mkdtemp(prefix="autohalt-"))
os.makedirs("manager", exist_ok=True)
open("manager/portfolio_config.json", "w").write("{}")

from lib import (account_binance, account_bingx, account_bybit, account_gateio,  # noqa: E402
                 account_okx, guard, order_binance, order_bingx, order_bybit, order_gateio,
                 order_okx, venue_errors)
from manager import reconciler as rec  # noqa: E402

T, C, U = venue_errors.TRANSIENT, venue_errors.CREDENTIAL, venue_errors.UNKNOWN
fails = 0


def check(cond, msg):
    global fails
    print(("ok   " if cond else "FAIL ") + msg)
    fails += 0 if cond else 1


# ── 1. real account-lib raise paths ─────────────────────────────────────────
_reply = {}


def _fake_http(*a, **k):
    r = requests.Response()
    r.status_code, body = _reply["r"]
    r._content = body if isinstance(body, bytes) else json.dumps(body).encode()
    r.url = "https://venue.test/x"
    return r


requests.get = requests.post = requests.request = _fake_http

# Observed live 2026-09-14 on Bybit mainnet (valid key, deliberately wrong
# secret): /v5/position/list AND /v5/user/query-api both answered HTTP 200 with
# this body. The HTTP-401-empty-body case below was never observed but stays —
# it is a valid fail-closed path. Key material stripped from retMsg.
BYBIT_BAD_SIGN = {"retCode": 10004, "retMsg": "error sign! ...", "result": {}}

ENVS = {
    account_okx: {"OKX_API_KEY": "k", "OKX_SECRET_KEY": "s", "OKX_PASSPHRASE": "p"},
    account_bybit: {"BYBIT_API_KEY": "k", "BYBIT_SECRET_KEY": "s"},
    account_bingx: {"BINGX_API_KEY": "k", "BINGX_SECRET_KEY": "s"},
    account_binance: {"BINANCE_API_KEY": "k", "BINANCE_SECRET_KEY": "s"},
    account_gateio: {"GATEIO_API_KEY": "k", "GATEIO_SECRET_KEY": "s"},
}
LIB_CASES = [
    (account_okx, 200, {"code": "50001", "msg": "busy"}, T, "OKX 50001 service unavailable"),
    (account_okx, 200, {"code": "50013", "msg": "busy"}, T, "OKX 50013 systems busy"),
    (account_okx, 401, {"code": "50119", "msg": "no key"}, C, "OKX 50119 (with HTTP 401)"),
    (account_okx, 401, {"code": "50102", "msg": "ts"}, U, "OKX 50102 clock beats HTTP 401"),
    (account_okx, 503, b"<html>down</html>", T, "OKX non-JSON 503"),
    (account_bybit, 401, b"", C, "Bybit HTTP 401 with empty body (fail-closed path)"),
    (account_bybit, 200, BYBIT_BAD_SIGN, C, "Bybit wrong secret = HTTP 200 retCode 10004 (live)"),
    (account_bybit, 403, b"", U, "Bybit HTTP 403 stays unknown"),
    (account_bybit, 200, {"retCode": 10006, "retMsg": "rate"}, T, "Bybit 10006"),
    (account_bybit, 200, {"retCode": 10003, "retMsg": "key"}, C, "Bybit 10003"),
    (account_bybit, 200, {"retCode": 10002, "retMsg": "ts"}, U, "Bybit 10002 clock"),
    (account_bingx, 200, {"code": 100410, "msg": "rate"}, T, "BingX 100410 with HTTP 200"),
    (account_bingx, 200, {"code": 100413, "msg": "key"}, C, "BingX 100413 with HTTP 200"),
    (account_bingx, 200, {"code": 100421, "msg": "ts"}, U, "BingX 100421 clock"),
    (account_bingx, 504, b"gateway", T, "BingX non-JSON 504"),
    (account_binance, 400, {"code": -2015, "msg": "key"}, C, "Binance -2015"),
    (account_binance, 429, {"code": -1003, "msg": "rate"}, T, "Binance -1003"),
    (account_binance, 418, b"banned", U, "Binance HTTP 418 IP ban stays unknown"),
    (account_gateio, 401, {"label": "INVALID_KEY", "message": "k"}, C, "Gate INVALID_KEY"),
    (account_gateio, 401, {"label": "REQUEST_EXPIRED", "message": "t"}, U,
     "Gate REQUEST_EXPIRED beats HTTP 401"),
    (account_gateio, 503, {"label": "SERVER_ERROR", "message": "x"}, T, "Gate SERVER_ERROR"),
    (account_gateio, 500, b"oops", T, "Gate bare 5xx"),
]
for lib, status, body, want, why in LIB_CASES:
    _reply["r"] = (status, body)
    try:
        lib.get_positions(ENVS[lib])
        check(False, f"{why}: get_positions did not raise")
        continue
    except Exception as e:
        got = rec._classify(lib.__name__.split("_", 1)[1], e)
    check(got == want, f"{why} → {got}")

# the same live shape on the account-id endpoint: get_account_id raises
# (never returns a bogus id), and the error is a key rejection
_reply["r"] = (200, BYBIT_BAD_SIGN)
try:
    account_bybit.get_account_id(ENVS[account_bybit])
    got = None
except Exception as e:
    got = rec._classify("bybit", e)
check(got == C, f"Bybit get_account_id on HTTP 200 retCode 10004 raises, credential → {got}")

# Gate USER_NOT_FOUND = "futures account not opened": get_positions reads it as
# flat, so the raise site is exercised through _request directly
_reply["r"] = (404, {"label": "USER_NOT_FOUND", "message": "x"})
try:
    account_gateio._request(ENVS[account_gateio], "GET", "/futures/usdt/accounts")
    got = None
except Exception as e:
    got = rec._classify("gateio", e)
check(got == U, f"Gate USER_NOT_FOUND is not a bad key → {got}")

# ── 2. order-lib exceptions + the venue-agnostic floor ──────────────────────
ORDER_CASES = [
    ("okx", order_okx.OKXError(503, "non-JSON", "p"), T, "OKXError carrying HTTP 503"),
    ("okx", order_okx.OKXError("50013", "busy", "p"), T, "OKXError 50013"),
    ("okx", order_okx.OKXError("N/A", "shape", "p"), U, "OKXError N/A"),
    ("bybit", order_bybit.BybitError("x", code=10006), T, "BybitError retCode 10006"),
    ("bybit", order_bybit.BybitError("legacy call, no code"), U, "BybitError without code"),
    ("bingx", order_bingx.BingXError(109500, "x", "p"), T, "BingXError 109500"),
    ("binance", order_binance.BinanceError(-1021, "ts", "p"), U, "BinanceError -1021"),
    ("binance", order_binance.BinanceError(503, "non-JSON", "p"), T, "BinanceError HTTP 503"),
    ("binance", order_binance.BinanceError(-2014, "key", "p"), C, "BinanceError -2014"),
    ("gateio", order_gateio.GateioError("TOO_BUSY", "x", "p"), T, "GateioError TOO_BUSY"),
    ("gateio", order_gateio.GateioError(502, "x", "p"), T, "GateioError HTTP 502"),
    ("okx", requests.exceptions.ReadTimeout(), T, "ReadTimeout"),
    ("bingx", requests.exceptions.ConnectionError(), T, "ConnectionError"),
    ("capital", rec.CapitalCacheLagError("lag"), T, "CapitalCacheLagError"),
    ("capital", RuntimeError("capital snapshot stale"), U, "capital: everything else unknown"),
    ("paper", RuntimeError("ledger"), U, "paper: unknown"),
    (None, requests.exceptions.Timeout(), T, "no venue resolved: agnostic floor"),
]
for venue, exc, want, why in ORDER_CASES:
    got = rec._classify(venue, exc)
    check(got == want, f"{why} → {got}")

# ── 3. the state machine, driven through _get_positions_guarded ─────────────
ENV = {"OKX_API_KEY": "key-A", "OKX_SECRET_KEY": "sekret-A", "OKX_PASSPHRASE": "pp",
       "BLAVE_API_KEY": "blave"}
S = {"venue": "okx", "acct": "A", "acct_calls": 0, "next": None}
POS = {"BTCUSDT": {"side": "long", "size": 100.0}}
TARGET = {"BTCUSDT": {"side": "long", "size": 100.0, "gated": False}}
emitted, sent = [], []


def _positions():
    nxt = S["next"]
    if isinstance(nxt, Exception):
        raise nxt
    return POS if nxt is None else nxt


def _acct_id(env):
    S["acct_calls"] += 1
    if isinstance(S["acct"], Exception):
        raise S["acct"]
    return S["acct"]


rec._read_env = lambda: dict(ENV)
rec.get_positions = _positions
rec._current_venue = lambda: S["venue"]
rec.aggregate_portfolio = lambda: TARGET
rec.send_telegram = sent.append
rec.events.emit = lambda t, **p: emitted.append((t, p))
account_okx.get_account_id = _acct_id


def snapshot(actual):
    with open("manager/last_reconcile.json", "w") as f:
        json.dump({"actual": actual}, f)


def reset(venue="okx"):
    guard.clear_halt("test")
    if os.path.exists(rec.ACCOUNT_GUARD_PATH):
        os.remove(rec.ACCOUNT_GUARD_PATH)
    rec._account_guard = {}
    rec._consecutive_failures = 0
    rec._reset_outage()
    if os.path.exists(rec.OUTAGE_PATH):
        os.remove(rec.OUTAGE_PATH)
    rec._guard_due, rec._key_fp = True, None
    rec._halt_file_seen = False
    S.update(venue=venue, acct="A", acct_calls=0, next=None)
    snapshot(POS)
    del emitted[:], sent[:]


def ext_clear():
    """The web's 啟動下單 on a live daemon: clear_halt runs in ANOTHER process,
    so only the file goes; the reconciler's poll must notice."""
    rec._sync_halt_flag(os.path.getmtime(guard.HALT_PATH))
    os.remove(guard.HALT_PATH)
    rec._sync_halt_flag(0)


def rnd(now, nxt=None):
    """One round. Returns 'ok' | 'skip' | the raised exception."""
    S["next"] = nxt
    try:
        rec._get_positions_guarded(now=now)
        return "ok"
    except rec.ReadSkipped:
        return "skip"
    except Exception as e:
        return e


# 3.1 transient: no count, no halt, one event at 30 min, recovered after
reset()
check(rnd(0) == "ok", "startup round passes the guard and seeds the account id")
busy = order_okx.OKXError("50001", "Service temporarily unavailable", "p")
outs = [rnd(t, busy) for t in range(60, 2400, 300)]  # 60 … 2160
check(all(o == "skip" for o in outs), "every transient round is skipped (no orders)")
check(rec._consecutive_failures == 0 and not guard.halted(), "transient never counts or halts")
ups = [p for t, p in emitted if t == "exchange_unreachable"]
check(len(ups) == 1 and ups[0] == {"venue": "okx", "minutes": 30, "code": "50001"},
      f"exchange_unreachable exactly once at 30 min: {ups}")
check(rnd(2400) == "ok", "first good read after the outage passes the guard")
downs = [p for t, p in emitted if t == "exchange_recovered"]
check(downs == [{"venue": "okx", "minutes": 39}], f"exchange_recovered after the event: {downs}")
del emitted[:]
rnd(2700, busy)
rnd(2760)
check(not emitted, "a short blip after recovery emits nothing (clock reset)")

# 3.2 credential: halt at once, reason names the code
reset()
rnd(0)
out = rnd(60, order_okx.OKXError("50111", "Invalid OK-ACCESS-KEY", "p"))
check(isinstance(out, order_okx.OKXError), "credential error propagates (not a skip)")
check(guard.halted() and "50111" in guard.halt_info()["reason"]
      and guard.halt_info()["source"] == "reconciler", "credential halts at once, names 50111")
check(len(sent) == 1 and "rejected the API key / permission (okx 50111)" in sent[0],
      "one Telegram, naming the key rejection and its code")

# 3.3 unknown: three strikes; transient in between neither counts nor resets
reset()
rnd(0)
weird = RuntimeError("something new")
rnd(60, weird)
rnd(360, busy)
rnd(660, weird)
check(rec._consecutive_failures == 2 and not guard.halted(),
      "unknown, transient, unknown → counter 2, not halted")
rnd(960, weird)
check(guard.halted(), "third unknown halts")
check("could not classify (last: okx RuntimeError: something new)" in guard.halt_info()["reason"]
      and sent and "could not classify" in sent[-1] and "unreachable" not in sent[-1],
      "unknown halt names the unclassified error, never 'unreachable'")

# 3.3b in-memory HALT release — the path uid 8232 takes once the fix ships. The
# web resume runs clear_halt in the command listener, so only the FILE goes;
# this process's own flag must follow it, except for a HALT that never landed.
_real_send = order_okx._send


def entry_allowed():
    """A real order_okx entry request (network send stubbed): True when the
    transport-level HALT gate lets it through."""
    order_okx._send = lambda *a, **k: [{"ordId": "1", "sCode": "0"}]
    try:
        order_okx._request("POST", "/api/v5/trade/order", ENV, body={
            "instId": "BTC-USDT-SWAP", "tdMode": "cross", "side": "buy",
            "ordType": "market", "sz": "1"})
        return True
    except guard.Halted:
        return False
    finally:
        order_okx._send = _real_send


# (1) restart: HALT left on disk by the previous process
reset()
os.makedirs(os.path.dirname(guard.HALT_PATH), exist_ok=True)
with open(guard.HALT_PATH, "w") as f:
    json.dump({"reason": "left by the previous process", "source": "reconciler"}, f)
rec._sync_halt_flag(os.path.getmtime(guard.HALT_PATH))  # first poll after start
guard.trip_halt("lib-level trip in this process", "portfolio")  # sets the flag, not via _halt
os.remove(guard.HALT_PATH)  # web resume, another process
check(guard.halted() and not entry_allowed(), "restart case: flag still set until the poll")
rec._sync_halt_flag(0)
check(not guard.halted() and entry_allowed(),
      "restart case: poll sees the file gone → flag released, entries allowed")

# (2) the reconciler trips its own HALT, then the web resume removes the file
reset()
rnd(0)
rnd(60, order_okx.OKXError("50111", "Invalid OK-ACCESS-KEY", "p"))
check(os.path.exists(guard.HALT_PATH) and rec._halt_file_seen, "own trip wrote the file, marked seen")
os.remove(guard.HALT_PATH)  # removed before any poll saw it — _halt marked it itself
check(guard.halted() and not entry_allowed(), "own trip: flag still set until the poll")
rec._sync_halt_flag(0)
check(not guard.halted() and entry_allowed(), "own trip: released, entries allowed")

# (3) trip_halt sets the flag but the file write fails (full disk)
reset()
rnd(0)
_real_replace = os.replace


def _enospc(*a, **k):
    raise OSError(28, "No space left on device")


os.replace = _enospc
try:
    out = rnd(60, order_okx.OKXError("50111", "Invalid OK-ACCESS-KEY", "p"))
finally:
    os.replace = _real_replace
check(isinstance(out, OSError) and not os.path.exists(guard.HALT_PATH)
      and not rec._halt_file_seen, "full disk: write failed, file never seen")
for _ in range(3):
    rec._sync_halt_flag(0)
check(guard.halted() and not entry_allowed(), "full disk: never released, entries still refused")
if os.path.exists(guard.HALT_PATH + ".tmp"):
    os.remove(guard.HALT_PATH + ".tmp")
guard.clear_halt("test")

# 3.4 an existing HALT is never cleared by recovery
reset()
rnd(0)
guard.trip_halt("user request", "user")
rnd(60, busy)
rnd(360)
check(guard.halted() and guard.halt_info()["source"] == "user", "recovery leaves a user HALT alone")

# 3.5 3a: empty read at a trigger (venue without an account id → only 3a)
reset(venue="binance")
spot_flat = {"ETHUSDT@spot": {"side": None, "size": 0.0}}
check(rnd(0, spot_flat) == "skip" and guard.halted()
      and "read back empty" in guard.halt_info()["reason"],
      "startup read empty (flat spot rows only) vs non-empty snapshot+target → HALT")
n_sent = len(sent)
check(rnd(60, spot_flat) == "skip" and len(sent) == n_sent,
      "held while HALT stands, no second Telegram")
ext_clear()
check(rnd(120, spot_flat) == "ok" and not rec._account_guard.get("pending"),
      "user clearing HALT confirms — the stale snapshot does not re-trip")
reset(venue="binance")
snapshot({})
check(rnd(0, {}) == "ok" and not guard.halted(), "empty snapshot + empty read → no trip")
reset(venue="binance")
rnd(0)
rnd(60, {})
check(not guard.halted(), "empty read on a NON-trigger round is not checked")

# 3.6 3b: account id changes at a key-change trigger
reset()
rnd(0)
check(rec._account_guard == {"venue": "okx", "account_id": "A"}, "account id seeded")
calls = S["acct_calls"]
S["acct"] = "B"
rnd(60)
check(S["acct_calls"] == calls and not guard.halted(),
      "no trigger → account id not read, nothing trips")
ENV["OKX_API_KEY"], ENV["OKX_SECRET_KEY"] = "key-B", "sekret-B"
check(rnd(120) == "skip" and guard.halted()
      and "account changed" in guard.halt_info()["reason"], "key change + new account → HALT")
raw = open(rec.ACCOUNT_GUARD_PATH).read()
check("key-B" not in raw and "sekret-B" not in raw, "raw keys never reach the state file")
check(rec._load_account_guard().get("pending", {}).get("account_id") == "B",
      "pending survives a restart")
check(rnd(420) == "skip", "held while HALT stands")
ext_clear()
check(rnd(480) == "ok" and rec._account_guard == {"venue": "okx", "account_id": "B"},
      "user clearing HALT adopts account B")
ENV["BLAVE_API_KEY"] = "blave-rotated"
calls = S["acct_calls"]
rnd(540)
check(S["acct_calls"] == calls, "a BLAVE_* key change is not a venue key change")

# 3.7 the account-id read is fail-soft: never a strike, a halt or a hold
reset()
S["acct"] = order_okx.OKXError("50120", "API key has no permission", "p")
check(rnd(0) == "ok" and not guard.halted() and not rec._guard_due
      and rec._consecutive_failures == 0,
      "account-id read with a CREDENTIAL-looking code → round proceeds, no halt, trigger cleared")
S["acct"] = order_okx.OKXError("50013", "busy", "p")
ENV["OKX_API_KEY"] = "key-C"
check(rnd(60) == "ok" and not rec._guard_due, "account-id read transient → round proceeds")
S["acct"] = None
ENV["OKX_API_KEY"] = "key-D"
check(rnd(120) == "ok" and not guard.halted(), "no id returned → 3b skipped, round proceeds")
S["acct"] = order_okx.OKXError("50120", "perm", "p")
ENV["OKX_API_KEY"] = "key-E"
check(rnd(180, {}) == "skip" and "read back empty" in guard.halt_info()["reason"],
      "3a still runs when the account-id read fails")

# 3.8 3a stays quiet under a HALT the user already set (全部平倉: the account
# empties under a flatten HALT while last_reconcile.json is pre-flatten)
reset(venue="binance")
guard.trip_halt("close all positions", "flatten")
rec._sync_halt_flag(os.path.getmtime(guard.HALT_PATH))
check(rnd(0, {}) == "ok" and guard.halt_info()["source"] == "flatten"
      and not rec._account_guard.get("pending") and not sent,
      "flatten HALT + stale snapshot + empty read → no 3a, the user's HALT untouched")

# 3.9 a retrip never overwrites someone else's HALT; it may rewrite our own
reset()
rnd(0)  # seeds A
guard.trip_halt("user request", "web")
S["acct"] = "Z"
ENV["OKX_API_KEY"] = "key-F"
check(rnd(60) == "skip" and guard.halt_info()["source"] == "web"
      and guard.halt_info()["reason"] == "user request"
      and rec._account_guard.get("pending", {}).get("account_id") == "Z",
      "account change under the user's HALT → held; that HALT keeps source web")
check(sent and "resuming confirms this account" in sent[-1], "…and the user is told why")
ext_clear()
check(rnd(120) == "ok" and rec._account_guard.get("account_id") == "Z", "resume confirms Z")
reset()
rnd(0)
rnd(60, order_okx.OKXError("50111", "Invalid OK-ACCESS-KEY", "p"))  # our own HALT
S["acct"] = "Y"
ENV["OKX_API_KEY"] = "key-G"
check(rnd(120) == "skip" and guard.halt_info()["source"] == "reconciler"
      and "account changed" in guard.halt_info()["reason"],
      "the reconciler's own HALT is re-tripped with the account reason")

# 3.10 only a transient error is an outage; no "resumes by itself" while halted
reset()
rnd(0)
rnd(60, weird)
check(rec._outage["since"] is None, "unknown error does not start the outage clock")
rnd(120, order_okx.OKXError("50111", "Invalid OK-ACCESS-KEY", "p"))
check(rec._outage["since"] is None and not os.path.exists(rec.OUTAGE_PATH),
      "credential error does not start it either")
for t in range(180, 2400, 300):
    rnd(t, busy)
check(rec._outage["since"] == 180 and not [e for e in emitted if e[0] == "exchange_unreachable"],
      "transient outage under a HALT: clock runs, no exchange_unreachable")

# 3.11 restart mid-outage: the clock and the announcement survive
reset()
rnd(0)
for t in (60, 360, 660, 960):
    rnd(t, busy)
rec._outage = rec._load_outage(now=1000)  # watchdog restart
check(rec._outage["since"] == 60 and not rec._outage["announced"],
      "restart before 30 min keeps the outage start")
for t in (1260, 1560, 1860):
    rnd(t, busy)
rec._outage = rec._load_outage(now=1900)  # restart again, after the event
check(rec._outage["announced"], "the announcement is persisted")
rnd(2160, busy)
ups = [p for t, p in emitted if t == "exchange_unreachable"]
check(ups == [{"venue": "okx", "minutes": 30, "code": "50001"}],
      f"exchange_unreachable once across restarts: {ups}")
rnd(2400)
downs = [p for t, p in emitted if t == "exchange_recovered"]
check(downs == [{"venue": "okx", "minutes": 39}] and not os.path.exists(rec.OUTAGE_PATH),
      f"exchange_recovered after a restart, state file removed: {downs}")
reset()
rnd(0)
rnd(60, busy)
check(rec._load_outage(now=60 + rec.OUTAGE_STALE_S + 1)["since"] is None,
      "a saved outage older than OUTAGE_STALE_S is dropped at load")

# 3.12 an account lib whose update skipped lib/venue_errors.py still works
import importlib.util  # noqa: E402
import lib as _libpkg  # noqa: E402

_hidden = sys.modules.pop("lib.venue_errors")
delattr(_libpkg, "venue_errors")
sys.modules["lib.venue_errors"] = None  # import now raises ImportError
try:
    _spec = importlib.util.spec_from_file_location(
        "account_okx_no_verr", os.path.join(ROOT, "lib", "account_okx.py"))
    _bare = importlib.util.module_from_spec(_spec)
    _spec.loader.exec_module(_bare)
finally:
    sys.modules["lib.venue_errors"] = _hidden
    _libpkg.venue_errors = _hidden
_reply["r"] = (200, {"code": "50001", "msg": "busy"})
try:
    _bare.get_positions(ENVS[account_okx])
    err = None
except Exception as e:
    err = e
check(_bare.venue_errors is None and str(err).startswith("OKX error 50001")
      and _bare.classify(err) is None and rec._classify(None, err) == U,
      "no venue_errors: the lib imports, raises its usual message, classify → None → unknown")

# 3.13 reconcile level: a skipped round never reaches place_order_fn
from lib import portfolio  # noqa: E402

portfolio.aggregate_portfolio = lambda: {
    "BTCUSDT": {"side": "long", "size": 100.0, "exchange": "okx", "asset_spec": None,
                "market": "swap", "contributors": [], "gated": False}}
placed = []


def spy(symbol, signed_diff, asset_spec=None, reduce_only=False, exchange=None,
        contributors=None):
    placed.append((symbol, round(signed_diff, 2), reduce_only))
    return False


def recon(now, nxt=None):
    S["next"] = nxt
    del placed[:]
    try:
        portfolio.reconcile(get_positions_fn=lambda: rec._get_positions_guarded(now=now),
                            place_order_fn=spy, threshold=10)
        return "ok"
    except rec.ReadSkipped:
        return "skip"


reset()
rnd(0)
check(recon(60, {}) == "ok" and placed == [("BTCUSDT", 100.0, False)],
      f"control: a good round places the entry {placed}")
check(recon(360, busy) == "skip" and placed == [], "transient round: place_order_fn never called")
ETH = {"ETHUSDT": {"side": "long", "size": 50.0}}
guard.trip_halt("user request", "web")
rec._sync_halt_flag(os.path.getmtime(guard.HALT_PATH))
check(recon(660, ETH) == "ok" and ("ETHUSDT", -50.0, True) in placed,
      f"control: under a plain HALT the reduce leg still goes out {placed}")
rec._save_account_guard({"venue": "okx", "account_id": "A", "pending": {
    "reason": "exchange account changed", "venue": "okx", "account_id": "B"}})
check(recon(960, ETH) == "skip" and placed == [],
      "pending account-guard trip: not even the reduce leg reaches place_order_fn")

# 3.14 the main loop releases a cleared HALT BEFORE it reconciles
_src = open(os.path.join(ROOT, "manager", "reconciler.py"), encoding="utf-8").read()
_main = _src[_src.index("if __name__ == '__main__':"):]
check(0 <= _main.find("_sync_halt_flag(current_mtimes") < _main.find("orders = reconcile("),
      "main loop: _sync_halt_flag runs before reconcile() on every poll")

print(f"\ncheck_reconciler_autohalt: {'PASS' if not fails else f'{fails} FAILED'}")
sys.exit(1 if fails else 0)
