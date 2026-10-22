"""HALT is a full freeze (Wei 2026-10-17, 0.1.27): while state/HALT exists no
order of any kind leaves the machine — entries, reduces, closes, a flip's close
leg, SL/TP — whoever tripped it (the user's 暫停, or a safety trip). The one way
to close while paused is the user's explicit close: manager/flatten.py and
manager/close_symbol.py take the process-wide close pass, and the close-all leg
the reconciler finishes for flatten (paper TW stocks after hours) runs inside
the thread-local one.

  G  transport (lib/guard.check_restart_stop, which every order lib's gate calls)
  R  lib.portfolio.reconcile: reduce / close / flip / safety HALT / deferred close-all
  E  lib.execute: a reduce TWAP stops at its next slice too
  P  the close pass is held by exactly flatten.py and close_symbol.py
  W  SL/TP under HALT (Binance/OKX/Gate.io/BingX): a pause between open_position's fill
     and its SL/TP refuses them too (Wei: no exception); ProtectionFailed names what is
     missing, and the entry only when there was one
  F  runtime portfolio_reporter.halt_freezes: unknown says "frozen", never "exits still run"

No network, no exchange, no process but this one's own child. Run:
    .venv/bin/python tests/check_halt_freeze.py
"""
import json
import os
import re
import subprocess
import sys
import tempfile
import threading

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
os.chdir(tempfile.mkdtemp(prefix="halt-freeze-"))
os.makedirs("manager", exist_ok=True)
open("manager/portfolio_config.json", "w").write('{"self_ledger": false}')

from lib import execute, guard, order_paper, portfolio  # noqa: E402
from lib import stock_perps  # noqa: E402
# every symbol here is a coin; the real binance_class GETs Binance exchangeInfo
stock_perps.binance_class = lambda sym: "COIN"

red = 0


def check(ok, name):
    global red
    print(("ok   " if ok else "FAIL ") + name)
    if not ok:
        red += 1


def refused(intent):
    try:
        guard.check_restart_stop(intent, {"symbol": "BTCUSDT"})
        return False
    except guard.Halted:
        return True


def audits(event):
    try:
        rows = [json.loads(line) for line in open(guard.AUDIT_PATH)]
    except OSError:
        return []
    return [r for r in rows if r.get("event") == event]


def reset_halt():
    if guard.halted():
        guard.clear_halt("test")


# ── G: transport ─────────────────────────────────────────────────────────────
print("== G transport")
check(not any(refused(i) for i in ("entry", "reduce", "protective", "cancel")),
      "G0 not halted: every intent passes")
guard.trip_halt("user request", "web")
check(all(refused(i) for i in ("entry", "reduce", "protective")),
      "G1 HALT: entry, reduce and protective are all refused")
check(not refused("cancel") and not refused("cancel_all") and not refused("leverage"),
      "G2 …cancels and leverage still pass (they open and close nothing)")
check(len(audits("order_denied_halt")) >= 3, "G3 every refusal is audited as order_denied_halt")
try:
    order_paper._gate("reduce", symbol="BTCUSDT", side="sell", qty=0.01)
    lib_refused = False
except guard.Halted:
    lib_refused = True
check(lib_refused, "G4 a real order lib's gate (paper) refuses the reduce too")
with guard.halt_close_pass("BTCUSDT", "test"):
    in_pass = {i: refused(i) for i in ("reduce", "protective")}
    try:
        order_paper._gate("entry", symbol="BTCUSDT", side="buy", qty=0.01)
        entry_out = True
    except guard.Halted:
        entry_out = False
    seen = []
    t = threading.Thread(target=lambda: seen.append(refused("reduce")))
    t.start()
    t.join()
check(not in_pass["reduce"] and in_pass["protective"] and not entry_out,
      f"G5 inside a close pass: the reduce passes; SL/TP and an entry stay refused ({in_pass}, {entry_out})")
check(seen == [True], "G6 the thread-local pass is this thread's only")
check(refused("reduce"), "G7 …and ends with the block")
check(len(audits("order_allowed_halt_close")) == 1, "G8 the passed reduce is audited")
reset_halt()

child = subprocess.run([sys.executable, "-c", f"""
import os, sys
sys.path.insert(0, {ROOT!r})
from lib import guard
guard.trip_halt("close all positions", "flatten")
def refused(intent):
    try:
        guard.check_restart_stop(intent, {{"symbol": "BTCUSDT"}})
        return False
    except guard.Halted:
        return True
before = refused("reduce")
guard.grant_halt_closes("flatten")
import json
granted = [r.get("source") for r in map(json.loads, open(guard.AUDIT_PATH))
           if r.get("event") == "halt_close_pass_granted"]
print(before, refused("reduce"), refused("protective"), granted == ["flatten"])
"""], capture_output=True, text=True, cwd=tempfile.mkdtemp(prefix="halt-freeze-child-"))
check(child.stdout.split() == ["True", "False", "True", "True"],
      f"G9 the process-wide pass (flatten / close_symbol): reduces go, SL/TP never; the grant is audited with its source "
      f"({child.stdout.strip()} {child.stderr.strip()[-200:]})")

# ── R: reconcile ─────────────────────────────────────────────────────────────
print("== R reconcile")
SHARES = {"type": "shares"}
TARGET = {
    "BTCUSDT": {"side": "long", "size": 100.0, "exchange": "okx", "asset_spec": None,
                "market": "swap", "contributors": [], "gated": False},
    "SOLUSDT": {"side": "short", "size": 50.0, "exchange": "okx", "asset_spec": None,
                "market": "swap", "contributors": [], "gated": False},
}
ACTUAL = {
    "BTCUSDT": {"side": "long", "size": 300.0, "exchange": "okx"},   # reduce 300 → 100
    "ETHUSDT": {"side": "long", "size": 50.0, "exchange": "okx"},    # no target: close
    "SOLUSDT": {"side": "long", "size": 50.0, "exchange": "okx"},    # flip long → short
    "2330": {"side": "long", "size": 1000.0, "exchange": "paper", "asset_spec": SHARES},
}
portfolio.aggregate_portfolio = lambda: {k: dict(v) for k, v in TARGET.items()}
portfolio._paper_tw_closed_keys = lambda target, actual: set()  # the TW session is open
placed = []


def spy(symbol, signed_diff, asset_spec=None, reduce_only=False, exchange=None, contributors=None):
    # last field: sent inside a close pass — and the real gate then lets a reduce through
    placed.append((symbol, round(signed_diff, 2), reduce_only,
                   guard.halt_closes_allowed() and not refused("reduce")))
    return False


def recon():
    del placed[:]
    portfolio.reconcile(get_positions_fn=lambda: {k: dict(v) for k, v in ACTUAL.items()},
                        place_order_fn=spy, threshold=10)
    return sorted(placed)


def keep_2330():
    # the close-all flatten deferred: "2330" held after the TW close
    portfolio.defer_paper_tw_close(["2330"])


TARGET["2330"] = {"side": "long", "size": 1000.0, "exchange": "paper", "asset_spec": SHARES,
                  "market": "spot", "contributors": [], "gated": False}
r = recon()
check({("BTCUSDT", -200.0, True, False), ("ETHUSDT", -50.0, True, False),
       ("SOLUSDT", -50.0, True, False)} <= set(r), f"R0 control, not halted: the legs go ({r})")
guard.trip_halt("user request", "web")
n_denied = len(audits("order_denied_halt"))
check(recon() == [], f"R1 user 暫停: the reduce, the close and the flip's close leg are all held ({placed})")
denied = audits("order_denied_halt")[n_denied:]
check({d.get("symbol") for d in denied} >= {"BTCUSDT", "ETHUSDT", "SOLUSDT"}
      and any(d.get("intent") == "reduce" for d in denied),
      f"R2 …each one audited order_denied_halt with its intent ({[(d.get('symbol'), d.get('intent')) for d in denied]})")
snap = json.load(open("manager/last_reconcile.json"))
check("halt_freeze" in (snap.get("caps") or []), "R3 the snapshot's caps say this lib freezes (the pages read it)")
reset_halt()

del TARGET["2330"]
guard.trip_halt("close all positions", "web")
keep_2330()
r = recon()
check(r == [("2330", -1000.0, True, True)],
      f"R4 the close-all leg flatten deferred goes, inside the close pass; nothing else does ({r})")
check(not guard.halt_closes_allowed(), "R5 …the pass is gone after the leg")
reset_halt()
os.remove(portfolio._PAPER_TW_CLOSE_PATH)  # the spy fills nothing; the real close empties the row

for source in ("reconciler", "execute", "portfolio", "settings"):
    guard.trip_halt(f"safety trip ({source})", source)
    r = recon()
    check(r == [], f"R6 a safety HALT ({source}) freezes the same way ({r})")
    reset_halt()
r = recon()
check(("BTCUSDT", -200.0, True, False) in r and ("ETHUSDT", -50.0, True, False) in r
      and ("SOLUSDT", -50.0, True, False) in r,
      f"R7 啟動下單 (HALT lifted): the held exits go ({r})")

# ── E: executions ────────────────────────────────────────────────────────────
print("== E executions")
guard.trip_halt("user request", "web")
why, stop = {}, threading.Event()
fn = execute._make_slice_fn("BTCUSDT", None, True, "okx", "sell", stop, {"id": "okx"}, why)
try:
    fn("BTCUSDT", "sell", 50.0)
    raised = False
except RuntimeError:
    raised = True
check(raised and stop.is_set() and why.get("stop") == "halt",
      f"E1 a reduce TWAP's next slice is not sent under HALT; the execution stops ({why})")
sent = []
import lib.venue_wiring as _vw  # noqa: E402
_real_auto = _vw.auto_place_order
_vw.auto_place_order = lambda *a, **k: sent.append(a) or {"avg_price": 1.0, "executed_qty": 1.0}
execute.resolve_execution = lambda contributors, config=None: {"type": "twap", "duration_min": 30}
with guard.halt_close_pass("2454@spot", "test"):
    out = execute.dispatch_order("2454@spot", -500.0, None, True, "paper")
check(isinstance(out, dict) and len(sent) == 1 and not execute.list_inflight(),
      f"E2 a deferred close-all leg under a TWAP style goes as one market order on this thread ({out})")
_vw.auto_place_order = _real_auto
reset_halt()

execute._CHASE_POLL_S, execute._CHASE_TIMEOUT_S = 0.02, 2.0
chase = {"place": 0, "status": 0, "cancel": 0, "market": 0}


def _chase_status(oid):
    chase["status"] += 1
    if chase["status"] == 1:
        guard.trip_halt("user request", "web")  # lands while the limit rests
    return {"status": "new", "executed_qty": 0.0, "avg_price": 0.0}


_vw.auto_place_order = lambda *a, **k: chase.__setitem__("market", chase["market"] + 1)
tools = {"bbo": lambda: (100.0, 100.1), "venue": "binance", "status": _chase_status,
         "place": lambda *a, **k: chase.__setitem__("place", chase["place"] + 1) or {"order_id": "o1", "status": "new"},
         "cancel": lambda oid: chase.__setitem__("cancel", chase["cancel"] + 1) or {"status": "canceled"}}
stop, t0 = threading.Event(), __import__("time").time()
try:
    execute._chase_thread("BTCUSDT", -100.0, None, True, "binance", None, tools, stop)
finally:
    _vw.auto_place_order = _real_auto
took = __import__("time").time() - t0
check(chase["place"] == 1 and chase["cancel"] >= 1 and chase["market"] == 0 and chase["status"] <= 3 and took < 1.5,
      f"E3 HALT lands while a chase limit rests: cancelled at the next poll, no re-post, no market ({chase}, {took:.2f}s)")
reset_halt()

# E4/E5 (testnet 0.1.27 P3): the pause lands AFTER the chase's halted() check, so the venue
# wiring's guard refuses the order and raises Halted. That is the pause working, not a crash:
# no "Chase execution error" notice, no order error, no market order.
notes, errors = [], []
_real_notify, _real_err = execute._notify_fn, portfolio._record_order_error
execute._notify_fn = notes.append
portfolio._record_order_error = lambda *a, **k: errors.append(a)


def _refuse():
    guard.trip_halt("user request", "web")
    raise guard.Halted("state/HALT is set — order refused")


def _halt_chase(place, market, timeout, filled_qty=0.0):
    del notes[:], errors[:]
    c = {"place": 0, "cancel": 0, "market": 0, "bbo": 0}

    def bbo():
        c["bbo"] += 1
        return (100.0, 100.1) if c["bbo"] == 1 else (100.5, 100.6)   # moves after the first post

    def _place(*a, **k):
        c["place"] += 1
        return place(c["place"])

    def _market(*a, **k):
        c["market"] += 1
        return market()

    t = {"bbo": bbo, "venue": "binance", "place": _place,
         "status": lambda oid: {"status": "new", "executed_qty": filled_qty, "avg_price": 100.0},
         "cancel": lambda oid: c.__setitem__("cancel", c["cancel"] + 1) or {"status": "canceled"}}
    execute._CHASE_TIMEOUT_S = timeout
    _vw.auto_place_order = _market
    try:
        execute._chase_thread("BTCUSDT", -100.0, None, True, "binance", None, t, threading.Event())
    finally:
        _vw.auto_place_order = _real_auto
        reset_halt()
    return c


c = _halt_chase(lambda n: {"order_id": "o1", "status": "new"} if n == 1 else _refuse(),
                lambda: {"avg_price": 1.0, "executed_qty": 1.0}, 2.0)
check(c["place"] == 2 and c["cancel"] >= 1 and c["market"] == 0 and not errors
      and not any("error" in m.lower() or "crashed" in m for m in notes),
      f"E4 HALT between the halted() check and the re-post: stopped, no error notice, no order error ({c}, {notes}, {errors})")
c = _halt_chase(lambda n: {"order_id": "o1", "status": "new"}, _refuse, 0.1)
check(c["market"] == 1 and c["cancel"] >= 1 and not errors
      and not any("error" in m.lower() or "crashed" in m for m in notes),
      f"E5 HALT before the market remainder: stopped, no error notice, no order error ({c}, {notes}, {errors})")
c = _halt_chase(lambda n: {"order_id": "o1", "status": "new"} if n == 1 else _refuse(),
                lambda: {"avg_price": 1.0, "executed_qty": 1.0}, 2.0, filled_qty=0.3)
check(not errors and any(m.startswith("Chase done: SELL $30.00/$100.00") and "state/HALT set" in m for m in notes)
      and not any("error" in m.lower() or "crashed" in m for m in notes),
      f"E6 part filled before the pause: the user gets what did fill, still no error ({notes}, {errors})")
# E7/E8 (audit 0127-docs-chase P3-B1): the same race with a machine-restart stop or an account
# hold — Halted too — names that stop, not state/HALT, and is no order error either
_real_rs, _real_held = guard.restart_stopped, execute._account_held
for which, want in (("restart", "machine restarted"), ("hold", "exchange account unconfirmed")):
    flag = [False]

    def _refuse_other():
        flag[0] = True
        raise guard.Halted("refused")

    if which == "restart":
        guard.restart_stopped = lambda: flag[0]
    else:
        execute._account_held = lambda ex: flag[0]
    logs = []
    _h = __import__("logging").Handler()
    _h.emit = lambda r: logs.append(r.getMessage())
    _root = __import__("logging").getLogger()
    _lvl = _root.level
    _root.addHandler(_h)
    _root.setLevel(20)
    try:
        _halt_chase(lambda n: {"order_id": "o1", "status": "new"} if n == 1 else _refuse_other(),
                    lambda: {"avg_price": 1.0, "executed_qty": 1.0}, 2.0, filled_qty=0.3)
    finally:
        _root.removeHandler(_h)
        _root.setLevel(_lvl)
        guard.restart_stopped, execute._account_held = _real_rs, _real_held
    check(not errors and any(m.startswith("Chase done: SELL $30.00/$100.00") and f"({want})" in m for m in notes)
          and not any("state/HALT" in m for m in notes) and any(f"chase stopped: {want}" in m for m in logs),
          f"E{7 if which == 'restart' else 8} {which} between the check and the re-post: named '{want}', no order error ({notes}, {errors})")
execute._notify_fn, portfolio._record_order_error = _real_notify, _real_err
execute._CHASE_TIMEOUT_S = 2.0

# ── P: who holds the close pass ──────────────────────────────────────────────
print("== P close-pass holders")
holders, scoped = set(), set()
for base in ("lib", "manager", "runtime", "strategies", "allocators"):
    for dirpath, _, files in os.walk(os.path.join(ROOT, base)):
        for f in files:
            if not f.endswith(".py"):
                continue
            path = os.path.join(dirpath, f)
            src = open(path, encoding="utf-8").read()
            rel = os.path.relpath(path, ROOT)
            if re.search(r"\bgrant_halt_closes\(", src) and rel != "lib/guard.py":
                holders.add(rel)
            if re.search(r"\bhalt_close_pass\(", src) and rel != "lib/guard.py":
                scoped.add(rel)
check(holders == {"manager/flatten.py", "manager/close_symbol.py"},
      f"P1 the process-wide pass: flatten.py and close_symbol.py only ({sorted(holders)})")
check(scoped == {"lib/portfolio.py"}, f"P2 the thread-local pass: lib/portfolio.py only ({sorted(scoped)})")
flat = open(os.path.join(ROOT, "manager", "flatten.py"), encoding="utf-8").read()
check(flat.index("grant_halt_closes(") > flat.index("claim_close_all_pass()"),
      "P3 flatten takes the pass only past the restart-stop branch (no pass → nothing closes there)")

# ── W: a pause between open_position's fill and its SL/TP ────────────────────
print("== W open_position window")
import importlib  # noqa: E402


def _w_err(fn):
    try:
        fn()
    except Exception as e:  # noqa: BLE001
        return e
    return None


for v in ("binance", "okx", "gateio", "bingx"):
    m = importlib.import_module(f"lib.order_{v}")
    hit, sends = [], {"n": 0}

    def _send(*a, **k):
        hit.append(a)
        raise AssertionError("reached the venue")

    m._send = _send
    m.get_position_mode = lambda env: "oneway"
    m.format_price = lambda env, symbol, price: str(price)
    m._position_side = lambda env, direction: "BOTH"

    def _denied():
        return len([r for r in audits("order_denied_halt") if r.get("intent") == "protective"])

    def ok_pf(err, before):
        return (isinstance(err, m.ProtectionFailed) and isinstance(err.__cause__, guard.Halted) and not hit
                and _denied() > before and "啟動下單" in str(err) and "place_protective_orders" in str(err))

    if v != "bingx":  # BingX attaches SL/TP to the entry: no window to test
        def _entry(env, symbol, direction, qty, **k):
            guard.trip_halt("user request", "web")  # the pause lands right after the fill
            return {"order_id": "e1", "status": "filled", "executed_qty": qty}

        m.place_market_order = _entry
        before = _denied()
        err = _w_err(lambda: m.open_position({}, "BTCUSDT", "long", 0.01, sl_price=90000.0, tp_price=110000.0))
        check(ok_pf(err, before) and "OPEN WITH NO STOP-LOSS" in str(err) and "entry filled" in str(err)
              and "stop-loss and take-profit were not placed" in str(err),
              f"W1 {v}: pause after the fill — SL/TP refused, nothing reaches the venue, the error says the "
              f"position has no stop ({str(err)[:90]})")
        reset_halt()

    # SL went out, then the pause: the TP alone is refused (a real _request for the SL would hit the
    # venue, so the SL's POST is answered here and the pause lands right after it)
    real_request = m._request

    def _sl_then_halt(*a, **k):
        guard.trip_halt("user request", "web")
        m._request = real_request
        return ([{"algoId": "s1"}] if v == "okx" else {"algoId": "s1", "id": "s1", "orderId": "s1"})

    if v == "bingx":
        m._unwrap_order = lambda o: o
    m._request = _sl_then_halt
    m.get_open_algo_orders = lambda env, symbol=None: []
    before = _denied()
    err = _w_err(lambda: m.place_protective_orders({}, "BTCUSDT", "long", sl_price=90000.0, tp_price=110000.0))
    m._request = real_request
    check(ok_pf(err, before) and "take-profit was not placed" in str(err) and "stop-loss went out" in str(err)
          and "NO STOP-LOSS" not in str(err) and "entry" not in str(err),
          f"W2 {v}: SL placed, TP refused — names only the TP, says the SL is there ({str(err)[:90]})")
    reset_halt()

    guard.trip_halt("user request", "web")
    before = _denied()
    err = _w_err(lambda: m.place_protective_orders({}, "BTCUSDT", "long", tp_price=110000.0))
    check(ok_pf(err, before) and "take-profit was not placed" in str(err)
          and "entry" not in str(err) and "NO STOP-LOSS" not in str(err),
          f"W3 {v}: standalone place_protective_orders under HALT — no entry story, no claim about the stop "
          f"({str(err)[:90]})")
    reset_halt()

# Bybit sets SL and TP in one trading-stop call (open_position attaches them to the entry):
# a standalone place_protective_orders under HALT raises ProtectionFailed like the other four
import lib.order_bybit as by  # noqa: E402
by_hit = []
by._send = lambda *a, **k: by_hit.append(a) or (_ for _ in ()).throw(AssertionError("reached the venue"))
by.get_contract_rules = lambda env, symbol: {"tick": 0.1, "step": 0.001, "min_qty": 0.001}
by._position_rows = lambda env, symbol: []
by._position_idx = lambda rows, direction: 0
guard.trip_halt("user request", "web")
err = _w_err(lambda: by.place_protective_orders({}, "BTCUSDT", "long", sl_price=90000.0, tp_price=110000.0))
check(isinstance(err, by.ProtectionFailed) and isinstance(err.__cause__, guard.Halted) and not by_hit
      and "stop-loss and take-profit were not placed" in str(err) and "place_protective_orders" in str(err)
      and "entry" not in str(err),
      f"W3 bybit: standalone place_protective_orders under HALT — ProtectionFailed, nothing sent ({str(err)[:90]})")
reset_halt()
_pp = [f for f in sorted(os.listdir(os.path.join(ROOT, "lib"))) if f.startswith("order_") and f != "order_paper.py"
       and "def place_protective_orders" in open(os.path.join(ROOT, "lib", f), encoding="utf-8").read()]
check(_pp and all("guard.protection_halted_text(" in open(os.path.join(ROOT, "lib", f), encoding="utf-8").read() for f in _pp),
      f"every venue lib with place_protective_orders words a HALT refusal as ProtectionFailed ({_pp})")

# ── F: the report's `freeze` when the evidence is missing ────────────────────
print("== F reporter freeze")
_ws = tempfile.mkdtemp(prefix="halt-freeze-ws-")
os.environ["BLAVE_AGENT_BASE"], os.environ["BLAVE_AGENT_WORKSPACE"] = _ws, os.path.join(_ws, "workspace")
sys.path.append(os.path.join(ROOT, "runtime"))
import portfolio_reporter as pr  # noqa: E402


def _absent_raises():
    raise OSError("process list unreadable")


def freezes(fresh, caps, absent, disk):
    pr._reconciler_view = lambda hb, last: (fresh, False)
    pr._reconciler_absent = absent if callable(absent) else (lambda: absent)
    pr._ws_lib_halt_freeze = lambda: disk
    return pr.halt_freezes(hb=1, last={"caps": caps})


check(freezes(True, ["halt_freeze"], False, False) is True, "F1 running reconciler with the cap → freeze")
check(freezes(True, [], True, True) is False, "F2 running reconciler without it (old lib) → no freeze")
check(freezes(False, None, True, True) is True and freezes(False, None, True, False) is False,
      "F3 provably no reconciler → the lib on disk decides")
check(freezes(False, None, False, False) is True,
      "F4 stale heartbeat, a process maybe there → freeze (unknown is the cautious word)")
check(freezes(False, None, _absent_raises, False) is True, "F5 presence check fails → freeze")


def _boom(hb=None, last=None):
    raise RuntimeError("boom")


pr.halt_freezes = _boom
check(pr.halt_state(hb=1, last={})["freeze"] is True, "F6 halt_freezes itself raises → the report still says freeze")

# 「暫停並關閉部位」的 closing(command_listener._mark_halt_closing):只有布林才往畫面送,其他 HALT 沒有這欄
_hp = os.path.join(pr.WORKSPACE_STATE, "HALT")
_had = open(_hp).read() if os.path.exists(_hp) else None
os.makedirs(os.path.dirname(_hp), exist_ok=True)
_seen = []
for _doc in ({"reason": "close all positions", "source": "web", "closing": True},
             {"reason": "close all positions", "source": "web", "closing": False},
             {"reason": "close all positions", "source": "web", "closing": "yes"}, {"reason": "user request"}):
    open(_hp, "w").write(json.dumps(_doc))
    _seen.append(pr.halt_state(hb=1, last={}).get("closing", "absent"))
if _had is None:
    os.remove(_hp)
else:
    open(_hp, "w").write(_had)
check(_seen == [True, False, "absent", "absent"], f"F7 halt_state carries HALT closing only when it is a bool ({_seen})")

print(f"\ncheck_halt_freeze: {red} FAILED" if red else "\ncheck_halt_freeze: all ok")
sys.exit(1 if red else 0)
