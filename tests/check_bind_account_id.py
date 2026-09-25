"""Bind records the book's exchange account; a key change nobody can match asks
the user once, and the one-tap answer resolves it — no network, no orders.

What it protects (audit Delta 5, Wei's decisions):
- every bind (web / chat `credentials`, the desktop's `_local_real_key_gate`
  path — both end in command_listener._cmd_credentials) tries get_account_id
  with the keys just written and records it as the venue's book account; an
  unreadable id never refuses the bind (the key's fingerprint is recorded);
- a readable id of ANOTHER account at bind resets that venue's book at once;
- a changed key whose id cannot be read, over an open book, puts the question
  in the report (`account_guard.book_hold` {venue, reason, since});
- `book_account_confirm {venue, same}` answers it: same → the book is kept,
  different → it restarts empty; idempotent, audited, clears the hold, kicks
  the reconciler, never places / closes / cancels an order.

Run: cd blave-agent && .venv/bin/python tests/check_bind_account_id.py
"""
import json
import os
import socket
import sys
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BASE = tempfile.mkdtemp(prefix="bind-acct-")
WS = os.path.join(BASE, "workspace")
os.makedirs(os.path.join(WS, "manager"))
os.symlink(os.path.join(ROOT, "lib"), os.path.join(WS, "lib"))  # the workspace lib = this repo's
os.environ["BLAVE_AGENT_BASE"] = BASE
os.environ["BLAVE_AGENT_WORKSPACE"] = WS
os.environ.pop("BLAVE_AGENT_LOCAL", None)
sys.path.insert(0, os.path.join(ROOT, "runtime"))
sys.path.insert(0, ROOT)
os.chdir(WS)


def _no_network(*a, **k):
    raise OSError("no network in this test")


socket.socket.connect = _no_network

import command_listener as cl  # noqa: E402
import portfolio_reporter as pr  # noqa: E402
from lib import account_binance, account_okx, order_binance  # noqa: E402

fails = 0


def check(cond, msg):
    global fails
    print(("ok   " if cond else "FAIL ") + msg)
    fails += 0 if cond else 1


with open(os.path.join(WS, "manager", "portfolio_config.json"), "w") as f:
    f.write("{}")
cl._sync_strategy_crons = lambda names: None
cl._binance_restrictions = lambda k, s: {"ipRestrict": True, "enableWithdrawals": False,
                                         "enableSpotAndMarginTrading": True, "enableFutures": True}
UID = {"binance": RuntimeError("uid endpoint 403"), "okx": RuntimeError("50120")}


def _uid(venue):
    def get(env):
        if isinstance(UID[venue], Exception):
            raise UID[venue]
        return UID[venue]
    return get


account_binance.get_account_id = _uid("binance")
account_okx.get_account_id = _uid("okx")
ORDER_CALLS = []
for n in ("place_market_order", "place_limit_order", "close_position_partial", "cancel_order",
          "cancel_all_orders", "place_spot_market_order"):
    if hasattr(order_binance, n):
        setattr(order_binance, n, (lambda n: lambda *a, **k: ORDER_CALLS.append(n))(n))

SEED = os.path.join(WS, "manager", "ledger_seed.json")
ORDERS = os.path.join(WS, "manager", "orders.jsonl")
GUARD = os.path.join(WS, "state", "venue_account.json")
KICK = os.path.join(WS, "state", "execution", "kick")


def bind(key, venue="BINANCE", **extra):
    env = {f"{venue}_API_KEY": key, f"{venue}_SECRET_KEY": "s-" + key, **extra}
    try:
        return cl.dispatch({"cmd": "credentials", "args": {"env": env}})
    except Exception as e:
        return e


def confirm(**args):
    try:
        return cl.dispatch({"cmd": "book_account_confirm", "args": args})
    except Exception as e:
        return e


def seed():
    return json.load(open(SEED)) if os.path.exists(SEED) else {}


def open_book(qty=0.001):
    json.dump({"seeded_at": "2026-09-01T00:00:00", "own_only_basis": 1, "symbols": {},
               "venue_account": seed().get("venue_account", {})}, open(SEED, "w"))
    with open(ORDERS, "w") as f:
        f.write(json.dumps({"ts": "2026-09-02T00:00:00", "symbol": "BTCUSDT", "exchange": "binance",
                            "legs": [{"signed_diff": 50.0, "signed_qty": qty}]}) + "\n")


def book_qty():
    cwd = os.getcwd()
    os.chdir(WS)
    try:
        from lib import portfolio
        return (portfolio.ledger_positions("binance").get("BTCUSDT") or {}).get("qty")
    finally:
        os.chdir(cwd)


def hold():
    try:
        return json.load(open(GUARD)).get("book_hold")
    except OSError:
        return None


# 1. cloud bind, id unreadable: binds anyway, the key is the book's identity
r = bind("key-a")
env_now = open(os.path.join(WS, ".env")).read()
rec = seed().get("venue_account", {}).get("binance", {})
check(isinstance(r, dict) and "BINANCE_API_KEY=key-a" in env_now
      and r.get("book_account") == {"binance": "ok"} and rec.get("id") is None and rec.get("fp"),
      f"unreadable id at bind: bound, the key's fingerprint recorded ({r})")
check("key-a" not in open(SEED).read(), "the seed holds a digest, never the key")

# 2. readable id at bind: recorded; later key changes decide themselves
UID["binance"] = "U1"
r = bind("key-b")
check(r.get("book_account") == {"binance": "ok"} and seed()["venue_account"]["binance"]["id"] == "U1",
      f"readable id at bind: recorded as the book's account ({r})")
open_book()
r = bind("key-c")
check(r.get("book_account") == {"binance": "ok"} and book_qty() == 0.001,
      "a new key on the same account (U1): the book is kept, no question")
UID["binance"] = "U2"
r = bind("key-d")
from lib import guard  # noqa: E402
hs = pr.halt_state()
cwd = os.getcwd()
os.chdir(WS)
held_now = guard.account_held("binance")
os.chdir(cwd)
check(r.get("book_account") == {"binance": "reset"} and book_qty() is None
      and "binance" in seed().get("venue_reset", {}) and hold() is None
      and hs["halted"] and hs["source"] == "reconciler" and hs["holds_all"]
      and "no longer manages the positions it opened on the previous account" in hs["reason"]
      and json.load(open(GUARD))["bind_reset"]["venue"] == "binance" and held_now,
      f"another account bound over it (U2): book empty at once, HALT with the account-changed "
      f"reason, no order reaches binance until 啟動下單 (D6 #3) ({r}, {hs})")
cl._ensure_reconciler_running = lambda *a, **k: "stub"
r = cl.dispatch({"cmd": "resume", "args": {}})
os.chdir(WS)
held_now = guard.account_held("binance")
os.chdir(cwd)
check(r.startswith("resumed") and not pr.halt_state()["halted"] and not held_now
      and json.load(open(GUARD))["bind_reset"].get("acked"),
      f"…the user's 啟動下單 is the confirmation: trading resumes, the reconciler still owes the notice ({r})")

# 3. a key change nobody can match, over an open book: the report asks
open_book()
UID["binance"] = RuntimeError("uid endpoint 403")
r = bind("key-e")
h = pr.account_guard()["book_hold"]
check(isinstance(r, dict) and "BINANCE_API_KEY=key-e" in open(os.path.join(WS, ".env")).read()
      and r.get("book_account") == {"binance": "unreadable"} and book_qty() == 0.001
      and h and h["venue"] == "binance" and h["since"] and "same binance account" in h["reason"],
      f"unreadable id + changed key + open book: still bound, book untouched, the report asks ({r}, {h})")

# 3b. 啟動下單 while the question is open: the HALT stays, with the hold's reason — and
# nothing else happens (D6 #6): the restart-stop record stays, no reconciler is started
STARTS = []
cl._ensure_reconciler_running = lambda *a, **k: STARTS.append("ensure") or "stub"
_real_after_restart = cl._start_after_restart_stop
cl._start_after_restart_stop = lambda *a, **k: STARTS.append("after_restart") or "stub"
os.chdir(WS)
guard.trip_halt("user request", "web")
os.chdir(cwd)
os.makedirs(os.path.dirname(cl.RESTART_STOP_PATH), exist_ok=True)
json.dump({"at": 1}, open(cl.RESTART_STOP_PATH, "w"))
for cmd in ("resume", "resume_wait"):
    r = cl.dispatch({"cmd": cmd, "args": {}})
    hs = pr.halt_state()
    check(str(r).startswith("held: binance") and hs["halted"] and hs["holds_all"]
          and "same binance account" in (hs["reason"] or "")
          and os.path.exists(cl.RESTART_STOP_PATH) and not STARTS,
          f"{cmd} under an open question: still HALTed with its reason, holds_all; restart-stop "
          f"record kept, no reconciler start ({r}, {STARTS})")
os.remove(cl.RESTART_STOP_PATH)
cl._start_after_restart_stop = _real_after_restart

# 4. the answers
check(isinstance(confirm(venue="binance", same="yes"), ValueError)
      and isinstance(confirm(venue="../x", same=True), ValueError)
      and isinstance(confirm(venue="binance"), ValueError), "malformed answers are refused")
if os.path.exists(KICK):
    os.remove(KICK)
r = confirm(venue="binance", same=True)
check(r == {"venue": "binance", "same": True, "outcome": "kept"} and book_qty() == 0.001
      and hold() is None and pr.account_guard()["book_hold"] is None and os.path.exists(KICK),
      f"'same': book kept, question gone, the reconciler kicked ({r})")
s1 = open(SEED).read()
r = confirm(venue="binance", same=True)
check(r["outcome"] == "unchanged" and open(SEED).read() == s1, "…answering again changes nothing")
check(pr.halt_state()["halted"] and not pr.halt_state()["holds_all"],
      "…the answer leaves the HALT for the user (plain now: closes would go out)")
r = confirm(venue="binance", same=False)
check(r["outcome"] == "nothing_to_confirm" and open(SEED).read() == s1 and book_qty() == 0.001,
      f"…a stale 'different' from the other device's dialog, after the question is gone: "
      f"nothing written, the kept book stays (D6 #1) ({r})")
r = cl.dispatch({"cmd": "resume", "args": {}})
check(r.startswith("resumed") and not pr.halt_state()["halted"], f"…and 啟動下單 now resumes ({r})")

open_book(0.002)
r = bind("key-f")
check(r.get("book_account") == {"binance": "unreadable"} and hold(), "another unmatched key change asks again")
r = confirm(venue="binance", same=False)
check(r["outcome"] == "reset" and book_qty() is None and hold() is None,
      f"'different': the book starts empty, nothing traded ({r})")
s1 = open(SEED).read()
check(confirm(venue="binance", same=False)["outcome"] == "unchanged" and open(SEED).read() == s1,
      "…answering again changes nothing (no second reset)")
check(isinstance(confirm(venue="binance", same=True), ValueError),
      "…'same' after 'different' is refused: the reset cannot be undone")
if os.path.exists(KICK):
    os.remove(KICK)
check(confirm(venue="okx", same=False)["outcome"] == "nothing_to_confirm" and os.path.exists(KICK),
      "no question on that venue: nothing changes — but the reconciler is kicked, so a stale "
      "question on the page is re-derived within a poll (D7 #3)")
audit = [json.loads(l) for l in open(os.path.join(WS, "state", "audit.jsonl"))
         if '"book_account_confirm"' in l]
check(not ORDER_CALLS and len(audit) == 7 and all(a.get("venue") for a in audit),
      f"no answer placed, closed or cancelled anything; each is audited ({ORDER_CALLS}, {len(audit)})")

# 5. paper binds record nothing (the reconciler reads its ledger stamp)
r = cl.dispatch({"cmd": "credentials", "args": {"env": {
    "PAPER_API_KEY": "paper", "PAPER_SECRET_KEY": "paper", "PAPER_BOUND_TS": "1"}}})
check("book_account" not in r and "paper" not in seed().get("venue_account", {}),
      f"paper bind: exempt ({r})")

# 6. desktop: the local key gate passes, the id does not read — binds anyway
os.environ["BLAVE_AGENT_LOCAL"] = "1"
cl.LOCAL_OPEN_VENUES = frozenset(cl.LOCAL_OPEN_VENUES | {"OKX"})
account_okx.get_equity = lambda env: {"equity": 100.0, "currency": "USDT"}
account_okx.withdraw_enabled = lambda env: False  # the withdrawal gate has its own test (check_local_real_key_gate)
r = bind("okx-key", "OKX", OKX_PASSPHRASE="pp")
check(isinstance(r, dict) and r.get("book_account") == {"okx": "ok"}
      and seed()["venue_account"]["okx"]["id"] is None and "OKX_API_KEY=okx-key" in
      open(os.path.join(WS, ".env")).read(),
      f"desktop bind through the local key gate: unreadable id still binds, key recorded ({r})")
account_okx.get_equity = lambda env: (_ for _ in ()).throw(RuntimeError("50113 invalid sign"))
r = bind("okx-bad", "OKX", OKX_PASSPHRASE="pp")
check(isinstance(r, ValueError) and "REJECTED" in str(r) and "okx-bad" not in
      open(os.path.join(WS, ".env")).read(),
      "…a key the venue itself rejects is still refused by the local gate (unchanged)")
os.environ.pop("BLAVE_AGENT_LOCAL")

print(f"\ncheck_bind_account_id: {'PASS' if not fails else f'{fails} FAILED'}")
sys.exit(1 if fails else 0)
