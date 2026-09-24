"""Unbind → rebind → 啟動下單 (paper scenario matrix TC-13, TC-28; 2026-09-23).

TC-28: an unbind that confirmed the reconciler stopped leaves a stop mark; a
start inside the 15 s "running right now" window then starts it again instead
of reading the stopped daemon's last heartbeat as alive.

TC-13: a full unbind parks the old account's snapshot (manager/last_reconcile.json)
and account-guard state (state/venue_account.json). A rebind to the SAME account
gets them back — the guard judges it exactly as before; any other account starts
without them, so its first start does not trip the guard on the old account's
positions. Identity = the venue credential values + PAPER_BOUND_TS.

Runtime only, no network, no supervisor (stopped / started are stubs). Keys are
not-a-real-* strings.

Run: cd blave-agent && .venv/bin/python tests/check_unbind_rebind_account_state.py
"""
import json
import os
import shutil
import sys
import tempfile
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BASE = tempfile.mkdtemp(prefix="unbind-rebind-")
os.environ["BLAVE_AGENT_HOME"] = os.environ["BLAVECLAW_HOME"] = BASE
WS = os.path.join(BASE, "workspace")
shutil.copytree(os.path.join(ROOT, "lib"), os.path.join(WS, "lib"),
                ignore=shutil.ignore_patterns("__pycache__"))
os.makedirs(os.path.join(WS, "state", "heartbeat"))
os.makedirs(os.path.join(WS, "manager"))
os.environ["BLAVE_AGENT_BASE"] = BASE
os.environ["BLAVE_AGENT_WORKSPACE"] = WS
os.environ.pop("BLAVE_AGENT_LOCAL", None)
os.chdir(WS)
sys.path.insert(0, os.path.join(ROOT, "runtime"))

import command_listener as cl  # noqa: E402

# a bind now reads the exchange account id (command_listener._bind_book_accounts);
# these keys are fake — answer "unreadable" without asking OKX
sys.path.insert(0, WS)
import lib.account_okx as _okx  # noqa: E402


def _no_account_id(env):
    raise RuntimeError("no network in this test")


_okx.get_account_id = _no_account_id

fails = 0


def check(cond, msg):
    global fails
    print(("ok   " if cond else "FAIL ") + msg)
    fails += 0 if cond else 1


SNAP = os.path.join(WS, "manager", "last_reconcile.json")
GUARD = os.path.join(WS, "state", "venue_account.json")
HB = os.path.join(WS, "state", "heartbeat", "reconciler")
OKX = {"OKX_API_KEY": "not-a-real-okx-key", "OKX_SECRET_KEY": "not-a-real-okx-secret",
       "OKX_PASSPHRASE": "not-a-real-okx-pass"}
OKX2 = dict(OKX, OKX_API_KEY="not-a-real-okx-key-2")
stop_ok, starts = {"v": True}, []
cl._stop_reconciler = lambda: stop_ok["v"]
cl._restart_reconciler = lambda args: starts.append(1) or "reconciler restarted"
cl._stray_reconciler_pids = lambda: []
cl._reconciler_supervised = lambda: False
cl._sync_strategy_crons = lambda names: None


def paper(ts):
    return {"PAPER_API_KEY": "paper", "PAPER_SECRET_KEY": "paper", "PAPER_BOUND_TS": str(ts)}


def trading_on(env):
    """A bound machine that has traded: config, snapshot with a live actual, guard state."""
    for p in (SNAP, GUARD, cl.PARKED_ACCOUNT_STATE, cl.RECONCILER_STOP_MARK, os.path.join(WS, ".env")):
        if os.path.exists(p):
            os.remove(p)
    open(os.path.join(WS, ".env"), "w").write("BLAVE_API_KEY=not-a-real-blave\n")
    cl.dispatch({"cmd": "credentials", "args": {"env": dict(env)}})
    venue = next(iter(env)).split("_")[0].lower()
    json.dump({"amounts": {"a1": 1000}, "exchanges": {"a1": venue}},
              open(os.path.join(WS, "manager", "portfolio_config.json"), "w"))
    json.dump({"actual": {"BTCUSDT": {"side": "long", "size": 1000}}, "target": {}}, open(SNAP, "w"))
    json.dump({"venue": venue, "account_id": "acct-1"}, open(GUARD, "w"))
    return open(SNAP).read(), open(GUARD).read()


def unbind(env):
    return cl.dispatch({"cmd": "credentials_remove", "args": {"env": list(env)}})


try:
    # ── identity ────────────────────────────────────────────────────────────
    ident = cl._account_identity
    check(ident(["OKX_API_KEY=a", "OKX_SECRET_KEY=b"]) == ident(["OKX_SECRET_KEY=b", "OKX_API_KEY=a"])
          and ident(["OKX_API_KEY=a", "OKX_SECRET_KEY=b"]) != ident(["OKX_API_KEY=a2", "OKX_SECRET_KEY=b"]),
          "identity: the credential values, order-free; another key = another account")
    check(ident(["OKX_API_KEY=a", "BLAVE_API_KEY=x", "DATA_POLYGON_API_KEY=y", "# c", "OKX_DEMO=true"])
          == ident(["OKX_API_KEY=a"]) and ident(["BLAVE_API_KEY=x"]) is None,
          "…platform keys, data-source keys, flags and comments are not the account; none at all = None")
    check(ident([f"{k}={v}" for k, v in paper(100).items()]) != ident([f"{k}={v}" for k, v in paper(200).items()]),
          "…paper: a newer PAPER_BOUND_TS is a new account (the paper ledger is re-seeded)")

    # ── TC-13: another account after a full unbind starts clean ──────────────
    trading_on(OKX)
    unbind(OKX)
    parked = json.load(open(cl.PARKED_ACCOUNT_STATE)) if os.path.exists(cl.PARKED_ACCOUNT_STATE) else {}
    check(not os.path.exists(SNAP) and not os.path.exists(GUARD)
          and set(parked.get("files") or {}) == {SNAP, GUARD},
          "full unbind (stop confirmed): snapshot and guard state parked, then cleared")
    cl.dispatch({"cmd": "credentials", "args": {"env": dict(OKX2)}})
    check(not os.path.exists(SNAP) and not os.path.exists(GUARD)
          and not os.path.exists(cl.PARKED_ACCOUNT_STATE),
          "rebind with another key: the old account's snapshot and guard state are dropped — its "
          "first start has nothing to trip on")

    # ── same account: exactly today's behaviour ─────────────────────────────
    snap_before, guard_before = trading_on(OKX)
    unbind(OKX)
    cl.dispatch({"cmd": "credentials", "args": {"env": dict(OKX)}})
    check(open(SNAP).read() == snap_before and open(GUARD).read() == guard_before
          and not os.path.exists(cl.PARKED_ACCOUNT_STATE),
          "rebind the SAME key: snapshot and guard state restored byte for byte (the guard judges "
          "it as before the unbind)")

    for label, ts2, want_back in (("same PAPER_BOUND_TS", 100, True), ("newer PAPER_BOUND_TS", 200, False)):
        snap_before, _ = trading_on(paper(100))
        unbind(paper(100))
        cl.dispatch({"cmd": "credentials", "args": {"env": paper(ts2)}})
        back = os.path.exists(SNAP) and open(SNAP).read() == snap_before
        check(back == want_back and not os.path.exists(cl.PARKED_ACCOUNT_STATE),
              f"paper rebind, {label}: {'restored' if want_back else 'dropped'}")

    # ── what must NOT park ──────────────────────────────────────────────────
    trading_on(OKX)
    stop_ok["v"] = False
    unbind(OKX)
    stop_ok["v"] = True
    check(os.path.exists(SNAP) and os.path.exists(GUARD) and not os.path.exists(cl.PARKED_ACCOUNT_STATE)
          and not os.path.exists(cl.RECONCILER_STOP_MARK),
          "stop NOT confirmed (membership kept): nothing parked, no stop mark — today's behaviour")
    trading_on(OKX)
    os.makedirs(cl.PARKED_ACCOUNT_STATE)  # the park write cannot land
    unbind(OKX)
    check(os.path.exists(SNAP) and os.path.exists(GUARD),
          "park write fails: the snapshot and guard state stay where they were")
    os.rmdir(cl.PARKED_ACCOUNT_STATE)
    snap_before, _ = trading_on(OKX)
    outside = os.path.join(BASE, "outside.txt")
    same = cl._account_identity(open(os.path.join(WS, ".env")).read().splitlines())
    json.dump({"identity": same, "files": {outside: "planted", SNAP: "stale"}},
              open(cl.PARKED_ACCOUNT_STATE, "w"))
    cl.dispatch({"cmd": "credentials", "args": {"env": dict(OKX)}})
    check(not os.path.exists(outside) and open(SNAP).read() == snap_before
          and not os.path.exists(cl.PARKED_ACCOUNT_STATE),
          "same account, but a parked entry naming any other path is never written, and live "
          "state is never overwritten by a parked copy")

    # ── TC-28: the unbind's stop mark outranks a fresh heartbeat ─────────────
    trading_on(OKX)
    open(HB, "w").close()
    cl._clock = lambda: time.time()
    hb_at = time.time() - 3
    os.utime(HB, (hb_at, hb_at))
    unbind(OKX)
    check(os.path.exists(cl.RECONCILER_STOP_MARK) and os.path.getmtime(cl.RECONCILER_STOP_MARK) >= hb_at,
          "confirmed unbind stop: stop mark written after the last heartbeat")
    cl.dispatch({"cmd": "credentials", "args": {"env": dict(OKX)}})
    del starts[:]
    cl._resume_started_at = None
    r = cl.dispatch({"cmd": "resume", "args": {}})
    check(starts == [1] and r.endswith("reconciler restarted"),
          f"unbind → rebind → start inside 15 s: the stopped daemon is started again ({r})")
    now = time.time() + 2
    os.utime(HB, (now, now))  # the restarted one beats after the mark
    del starts[:]
    cl._resume_started_at = None
    r = cl.dispatch({"cmd": "resume", "args": {}})
    check(not starts and r.endswith("reconciler already running"),
          "…a heartbeat newer than the mark is a live daemon: not restarted mid-round")
finally:
    os.chdir(ROOT)
    shutil.rmtree(BASE, ignore_errors=True)

print("\nFAILED" if fails else "\nall ok")
sys.exit(1 if fails else 0)
