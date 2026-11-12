"""群益 leg of 全部平倉 under an identity that can't log in to SKCOM — no network,
no exchange, no Windows needed (the identity check is mocked).

Why this exists: the web 全部平倉 runs manager/flatten.py under the bridge's
LocalSystem; SKCOM refuses that identity (602), so the button used to HALT,
"try" 群益, and leave the position open behind a cryptic error. Now:

  - flatten: 群益 positions are NOT sent — one visible error per position —
    while a crypto venue on the same machine still closes;
  - reporter: can_flatten is false when 群益 is the only closable venue
    (the page then offers 暫停 only), true when mixed or identity is fine;
  - listener: a stale-UI close_all on a 群益-only machine acks
    close_all=halted_capital_manual and launches nothing.

And, under self_ledger, a bot position that survives the run keeps its book
(skipped / raised / no price / unconfirmed fill / a venue unreadable → no
stale-entry sweep); 群益 is only sent for a TX/MTX/TM + YYMM futures row, never
for an option row. (Non-near-month futures rows ARE sent, as today — the close
goes out as the near-month alias; a known risk Wei accepted.)

Run: cd blave-agent && python3 tests/check_capital_flatten_identity.py
"""
import ast
import json
import os
import sys
import tempfile
import types

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# Never let this test read the repo's .env: flatten.py chdirs to the repo ROOT
# on import, and that .env holds real exchange keys (2026-09-22 incident).
_REPO_ENV = os.path.join(ROOT, ".env")


def _no_repo_env(event, args):
    if event == "open" and args and isinstance(args[0], (str, bytes)):
        p_ = os.fsdecode(args[0])
        if os.path.abspath(p_) == _REPO_ENV:
            raise RuntimeError(f"test tried to open the repo .env ({p_})")


sys.addaudithook(_no_repo_env)
BASE = tempfile.mkdtemp(prefix="capital-flat-")
# notify config = none: lib.notify here and in every child falls back to a log line, never a real Telegram
os.environ["BLAVE_AGENT_HOME"] = os.environ["BLAVECLAW_HOME"] = BASE
WS = os.path.join(BASE, "workspace")
for d in ("manager", "state", "lib"):
    os.makedirs(os.path.join(WS, d))
os.environ["BLAVE_AGENT_BASE"] = BASE
os.environ["BLAVE_AGENT_WORKSPACE"] = WS
os.environ.pop("BLAVE_AGENT_LOCAL", None)

sys.path.insert(0, ROOT)
sys.path.insert(0, os.path.join(ROOT, "runtime"))
sys.path.insert(0, os.path.join(ROOT, "manager"))
import command_listener as cl  # noqa: E402
import portfolio_reporter as pr  # noqa: E402
import flatten  # noqa: E402  (chdir's to ROOT — everything that writes is patched below)
# the park of an unconfirmed 群益 close (reconciler._capital_park, its own test:
# check_capital_flatten_park.py) is recorded here, not written: this file tests the press-again hold
PARKS = []
flatten._reconciler = lambda: types.SimpleNamespace(
    _capital_nets=lambda root=None: {"TM2610": 2.0},
    _capital_park=lambda root, res, requested, base, intent=None: PARKS.append((root, res, requested, base, intent)) or "p")

REAL_FLATTEN_ID = flatten._capital_order_identity_ok
REAL_REPORTER_ID = pr._capital_order_identity_ok
fails = 0


def check(cond, msg):
    global fails
    print(("ok   " if cond else "FAIL ") + msg)
    fails += 0 if cond else 1


# ── flatten ──────────────────────────────────────────────────────────────────
flatten.LOCK_PATH = os.path.join(BASE, "flatten.lock")
flatten.LAST_PATH = os.path.join(BASE, "last_flatten.json")
flatten.CAPITAL_PENDING_PATH = os.path.join(BASE, "capital_pending_sent.json")
errors, closes, logged, zeroed = [], [], [], set()
LEDGER = {}
CFG = {"self_ledger": False}  # account-read opt-out unless a case turns the book on
POS = {}      # vid -> positions (or an Exception to raise)
CLOSE = {}    # capital resolved sym -> "raise" | "sent" | "partial"; default = filled
flatten._record_order_error = (
    lambda sym, vid, err, extra=None: errors.append((sym, vid, err, extra)))
ROWS = []
flatten._append_reconciler_log = lambda row: logged.append(row["symbol"]) or ROWS.append(row)
flatten.zero_ledger_symbols = lambda syms, venue=None: zeroed.update(syms)
flatten.load_portfolio_config = lambda: CFG
# the book is per venue (lib/portfolio): 群益's keys are its futures, the rest are Binance's
flatten.ledger_positions = lambda vid=None: {k: v for k, v in LEDGER.items()
                                             if vid is None or (vid == "capital") == (k in ("TMF", "TXF", "MXF"))}
flatten._load_ledger_seed = lambda: {"seeded_at": "2026-01-01T00:00:00", "symbols": {}}
import lib.portfolio as _lp0  # noqa: E402
_real_ready = _lp0.book_ready
_lp0.book_ready = lambda config=None: True  # the book cases below have a baseline
WAITS = []
flatten._wait_for_inflight = lambda *a, **k: WAITS.append(k) or []
flatten.guard = types.SimpleNamespace(halted=lambda: True, trip_halt=lambda *a: None,
                                      restart_stopped=lambda: False,
                                      grant_halt_closes=lambda *a: None,
                                      hold_turn_money=lambda: None, TurnMoneyBusy=type("TurnMoneyBusy", (RuntimeError,), {}))
EXTRA_ENV = {}
flatten._read_env = lambda path=".env": dict({
    "CAPITAL_API_KEY": "x", "CAPITAL_PASSWORD": "x",
    "BINANCE_API_KEY": "x", "BINANCE_SECRET_KEY": "x",
}, **EXTRA_ENV)


def _get_positions(vid):
    def fn(env):
        v = POS[vid]
        if isinstance(v, Exception):
            raise v
        return v
    return fn


def _capital_close(env, sym, side, size, client_order_id=None):
    closes.append(("capital", sym))
    how = CLOSE.get(sym)
    if how == "raise":
        raise RuntimeError("SKCOM said no")
    if how == "sent":
        return {"status": "sent", "executed_qty": 0.0, "avg_price": 0.0}
    if how == "partial":
        return {"status": "filled", "executed_qty": size - 1, "avg_price": 22000.0}
    return {"status": "filled", "executed_qty": size, "avg_price": 22000.0}


for _vid in ("capital", "binance"):
    acct = types.ModuleType(f"lib.account_{_vid}")
    acct.get_positions = _get_positions(_vid)
    order = types.ModuleType(f"lib.order_{_vid}")
    order.format_qty = lambda env, sym, size: str(size)
    sys.modules[f"lib.account_{_vid}"] = acct
    sys.modules[f"lib.order_{_vid}"] = order
sys.modules["lib.order_capital"].close_position_partial = _capital_close
sys.modules["lib.order_binance"].close_position_partial = (
    lambda env, sym, side, size, client_order_id=None: closes.append(("binance", sym)) or {})

# real lib/account_capital: dict shape, resolved codes, lots, NO mark_price
CAP_ONE = {"TM2610": {"side": "long", "size": 2}}
BIN_ONE = [{"symbol": "BTCUSDT", "side": "long", "size": 0.01, "mark_price": 60000}]


def run_flatten(identity_ok, ledger=None, capital=CAP_ONE, close=None, keep_last=False):
    for bucket in (errors, closes, logged, zeroed):
        bucket.clear()
    if not keep_last and os.path.exists(flatten.LAST_PATH):
        os.remove(flatten.LAST_PATH)   # each case stands alone: a previous run's unconfirmed close holds the next
    CFG.clear()
    CFG["self_ledger"] = False  # account-read opt-out unless a case turns the book on
    LEDGER.clear()
    CLOSE.clear()
    CLOSE.update(close or {})
    POS.update(capital=capital, binance=BIN_ONE)
    if ledger is not None:
        CFG["self_ledger"] = True
        LEDGER.update(ledger)
    flatten._capital_order_identity_ok = lambda: identity_ok
    flatten._LOCK = None
    res = flatten.flatten()
    if flatten._LOCK is not None:
        flatten._LOCK.close()
    return res


# B-2 (audit 11-05): a 群益 close 群益 took without a report may sit queued to the open; a second close
# from 全部平倉 would fill beside it as the reverse (sNewClose=2) — held until CAPITAL_QUEUED_HOLD_S after
# the REAL send (re-audit N-1: a held press must not restart it; N-2: an old park leg never holds)
import time as _t0  # noqa: E402
from lib import tw_clock as _twc  # noqa: E402
HOLD = flatten.CAPITAL_QUEUED_HOLD_S
_real_qu = _twc.queued_until
_twc.queued_until = lambda now=None: None   # in session unless a case says otherwise
_twc.close_hold = lambda now=None: None     # the broker takes closes (else flatten defers them)


def park(at, intent="reduce"):
    json.dump({"TMF": {"root": "TMF", "lots": -2.0, "legs": [{"at": at, "lots": -2.0, "status": "sent",
                                                             "broker_ack": True, "intent": intent}]}},
              open(flatten.CAPITAL_PENDING_PATH, "w"))


def queued_rows():
    return [e for e in errors if e[3] and e[3].get("kind") == "manual_close_required" and e[3].get("reason") == "queued"]


park(_t0.time() - 120)
run_flatten(True)
q = queued_rows()
check(("capital", "TM2610") not in closes and ("binance", "BTCUSDT") in closes and q
      and abs(q[0][3].get("until", 0) - (_t0.time() - 120 + HOLD)) < 5 and "後再按" in q[0][2] and "看過委託再平" in q[0][2],
      f"the reconciler's unreported close 2 min ago: not sent again, one 'queued' row with when to press again ({errors})")
last = json.load(open(flatten.LAST_PATH))
check("TMF" not in last.get("unconfirmed", []) and any(u.get("key") == "TMF" and u.get("why") == "queued"
                                                         for u in last.get("unclosed", [])),
      f"a held key is unclosed (why queued), never unconfirmed: nothing was sent ({last.get('unclosed')})")
park(_t0.time() - 6 * 3600)
run_flatten(True)
check(("capital", "TM2610") in closes,
      "N-2: a park leg sent 6 h ago (no reconciler claim since: restart stop, login stop) no longer holds the close")
park(_t0.time() - 60, intent="entry")
run_flatten(True)
check(("capital", "TM2610") in closes, "an unreported entry does not hold the close")
os.remove(flatten.CAPITAL_PENDING_PATH)
PARKS.clear()
run_flatten(True, close={"TM2610": "sent"})
check(len(PARKS) == 1 and PARKS[0][0] == "TMF" and PARKS[0][2] == -2 and PARKS[0][3] == {"TM2610": 2.0}
      and PARKS[0][4] == "reduce" and PARKS[0][1]["fill_qty"] == 0 and PARKS[0][1]["status"] == "sent",
      f"a flatten's own 'sent' 群益 close is handed to the reconciler's park: -2 lots, reduce, the pre-send read ({PARKS})")
hold = (json.load(open(flatten.LAST_PATH)).get("capital_hold_until") or {}).get("TMF")
check(hold and abs(hold - (_t0.time() + HOLD)) < 30, f"a flatten's own 'sent' 群益 close in session holds 16 min from its send ({hold})")
rec = json.load(open(flatten.LAST_PATH))
rec["capital_hold_until"] = {"TMF": _t0.time() - 10 * 60 + HOLD}   # sent 10 min ago
json.dump(rec, open(flatten.LAST_PATH, "w"))
run_flatten(True, keep_last=True)
again = (json.load(open(flatten.LAST_PATH)).get("capital_hold_until") or {}).get("TMF")
check(("capital", "TM2610") not in closes and again and abs(again - (_t0.time() - 10 * 60 + HOLD)) < 2,
      f"N-1: pressed again 10 min after the send: held, and the record keeps the same deadline ({again})")
rec = json.load(open(flatten.LAST_PATH))
rec["capital_hold_until"] = {"TMF": _t0.time() - 22 * 60 + HOLD}   # sent 22 min ago
json.dump(rec, open(flatten.LAST_PATH, "w"))
run_flatten(True, keep_last=True)
check(("capital", "TM2610") in closes, "N-1: pressed again 22 min after the send (after a held press): sent")
# N-4: sent out of session (14:00, or a weekend), it may sit queued to the next open — held past
# that open plus settle, as the reconciler's queued_until, not just 16 min; the row names that time
OPEN = _t0.time() + 3600
_twc.queued_until = lambda now=None: OPEN
run_flatten(True, close={"TM2610": "sent"})
hold = (json.load(open(flatten.LAST_PATH)).get("capital_hold_until") or {}).get("TMF")
check(hold and abs(hold - (OPEN + flatten.CAPITAL_SETTLE_S)) < 2,
      f"N-4: an out-of-session 'sent' close holds to the next open + settle ({hold} vs {OPEN})")
_twc.queued_until = lambda now=None: None
flatten._load_cap_queued(json.load(open(flatten.LAST_PATH)), _t0.time())
held, until = flatten._capital_close_queued("TMF", now=_t0.time() + 20 * 60)
check(held and abs(until - (OPEN + flatten.CAPITAL_SETTLE_S)) < 2, "N-4: 20 min later (before the open) still held, until the open")
run_flatten(True, keep_last=True)
q = queued_rows()
check(("capital", "TM2610") not in closes and q and abs(q[0][3].get("until", 0) - (OPEN + flatten.CAPITAL_SETTLE_S)) < 2,
      f"N-4: the held row's until is the open, not 16 min after the send ({q[:1]})")
_twc.queued_until = _real_qu
os.remove(flatten.LAST_PATH)

res = run_flatten(False)
MANUAL = {"kind": "manual_close_required", "symbols": "TMF", "reason": "identity"}
check(errors and errors[0][3] == MANUAL, f"wrong identity: row carries kind/symbols/reason ({errors})")
check(("capital", "TM2610") not in closes, "wrong identity: 群益 close NOT sent")
check(("binance", "BTCUSDT") in closes, "wrong identity: crypto leg still closed")
check([e[:2] for e in errors] == [("TMF", "capital")] and "手動平倉" in errors[0][2],
      f"wrong identity: one 群益 error, keyed like the positions table (TMF) ({errors})")
check(res is False, "wrong identity: flatten reports it ran with errors")

ROWS.clear()
run_flatten(True)
check(("capital", "TM2610") in closes and not errors, "Administrator password logon: 群益 closes")
# 11-09 win-test-6: the row read 「41,906 口」 — 群益's book and 交易歷史 count lots, never price × lots
cap_log = [r for r in ROWS if r.get("exchange") == "capital"]
leg = cap_log[0]["legs"][0] if len(cap_log) == 1 else {}
check(len(cap_log) == 1 and cap_log[0]["signed_diff"] == -2.0 and leg.get("signed_diff") == -2.0
      and leg.get("sent_qty") == 2.0 and leg.get("executed_qty") == 2 and leg.get("signed_qty") == -2.0,
      f"the 群益 close row is in lots (signed_diff -2, sent_qty 2), not 2 × 22000 ({cap_log})")
ROWS.clear()
run_flatten(True, close={"TM2610": "sent"})
cap_log = [r for r in ROWS if r.get("exchange") == "capital"]
check(len(cap_log) == 1 and cap_log[0]["signed_diff"] is None and cap_log[0]["legs"][0].get("sent_qty") == 2.0,
      f"an unreported 群益 close: no booked lots, 交易歷史 shows the 2 sent ({cap_log})")
# 統一 closes through the same loop (no unit on its rows either): its row is lots as well
_pa, _po = types.ModuleType("lib.account_president"), types.ModuleType("lib.order_president")
_pa.get_positions = _get_positions("president")
_po.format_qty = lambda env, sym, size: str(size)
_po.close_position_partial = (lambda env, sym, side, size, client_order_id=None: closes.append(("president", sym))
                              or {"status": "filled", "executed_qty": float(size), "avg_price": 22000.0})
sys.modules["lib.account_president"], sys.modules["lib.order_president"] = _pa, _po
POS["president"] = {"TMF": {"side": "short", "size": 1.0}}
EXTRA_ENV["president_account"] = "x"
ROWS.clear()
run_flatten(True)
pres_log = [r for r in ROWS if r.get("exchange") == "president"]
check(("president", "TMF") in closes and len(pres_log) == 1 and pres_log[0]["signed_diff"] == 1.0
      and pres_log[0]["legs"][0].get("sent_qty") == 1.0,
      f"the 統一 close row is in lots too (signed_diff +1, sent_qty 1) ({pres_log}, {errors})")
EXTRA_ENV.pop("president_account")
POS.pop("president")

# several skipped 群益 positions → ONE merged row (order_errors keeps only 5)
res = run_flatten(False, capital={"TM2610": {"side": "long", "size": 1},
                                  "TX2610": {"side": "short", "size": 1},
                                  "TM2611": {"side": "long", "size": 1}})
cap_rows = [e for e in errors if e[1] == "capital"]
check(len(cap_rows) == 1 and cap_rows[0][0] == "TMF,TXF"
      and cap_rows[0][3] == dict(MANUAL, symbols="TMF,TXF") and "手動平倉" in cap_rows[0][2],
      f"wrong identity, 3 positions / 2 keys → one row, symbols sorted+deduped ({errors})")
check(res is False and not [c for c in closes if c[0] == "capital"], "merged: nothing 群益 sent")

# the real writer: extra fields added, old fields (symbol/error) kept, newest 5
import lib.portfolio as lp  # noqa: E402
_cwd = os.getcwd()
os.chdir(WS)
try:
    for i in range(6):
        lp._record_order_error(f"S{i}", "binance", "x")
    lp._record_order_error("TMF,TXF", "capital", "close-all: 舊原文",
                           {"kind": "manual_close_required", "symbols": "TMF,TXF",
                            "reason": "identity", "symbol": "X", "error": "Y",
                            "exchange": "Z"})
    rows = json.load(open(os.path.join(WS, "manager", "order_errors.json")))
finally:
    os.chdir(_cwd)
last = rows[-1]
check(len(rows) == 5 and last.get("kind") == "manual_close_required"
      and last.get("symbols") == "TMF,TXF" and last.get("reason") == "identity" and "ts" in last
      and "kind" not in rows[0], f"writer: extra fields added, rows without extra unchanged ({rows})")
check(last.get("symbol") == "TMF,TXF" and last.get("exchange") == "capital"
      and last.get("error") == "close-all: 舊原文",
      f"writer: extra can't overwrite the old symbol/exchange/error fields ({last})")
os.remove(os.path.join(WS, "manager", "order_errors.json"))

# ── self_ledger: book keys + the end-of-run sweep ────────────────────────────
BOOK = {"TMF": {"side": "long", "size": 440000.0, "qty": 2.0},
        "BTCUSDT": {"side": "long", "size": 600.0, "qty": 0.01},
        "ETHUSDT": {"side": "long", "size": 300.0, "qty": 0.1}}  # closed by hand earlier
run_flatten(False, BOOK)
check("TMF" not in zeroed, f"self_ledger + skipped 群益: its book NOT zeroed ({sorted(zeroed)})")
check({"BTCUSDT", "ETHUSDT"} <= zeroed, "self_ledger: closed + stale crypto book still zeroed")
check([e[:2] for e in errors] == [("TMF", "capital")], "self_ledger + skipped: 群益 error recorded")
run_flatten(False, {k: v for k, v in BOOK.items() if k != "TMF"})
check(not errors and ("capital", "TM2610") not in closes,
      "self_ledger: a 群益 position the book doesn't claim is not reported as 手動平倉")
run_flatten(True, BOOK)
check(("capital", "TM2610") in closes, "self_ledger + right identity: 群益 found in the TMF book and closed")
check("TMF" in logged and "TM2610" not in logged and "TMF" in zeroed and "TM2610" not in zeroed,
      f"self_ledger: close logged/zeroed under the book key ({logged}, {sorted(zeroed)})")

# every way a bot position can survive the run keeps its book (not zeroed)
run_flatten(True, BOOK, close={"TM2610": "raise"})
check("TMF" not in zeroed and ("TMF", "capital") in [e[:2] for e in errors],
      f"self_ledger: close raised → TMF kept, error under TMF ({sorted(zeroed)}, {errors})")
run_flatten(True, dict(BOOK, TMF={"side": "long", "size": 440000.0, "legacy": True}))
check("TMF" not in zeroed and ("capital", "TM2610") not in closes,
      f"self_ledger: legacy row + no mark price → not sent, TMF kept ({sorted(zeroed)})")
run_flatten(True, BOOK, close={"TM2610": "sent"})
check("TMF" not in zeroed and any("未確認成交" in e[2] for e in errors),
      f"self_ledger: 群益 close 'sent' with 0 filled → not booked flat ({sorted(zeroed)})")
run_flatten(True, BOOK, close={"TM2610": "partial"})
check("TMF" not in zeroed and any("未確認成交" in e[2] for e in errors),
      "self_ledger: 群益 close partially filled → not booked flat")
run_flatten(True, BOOK)  # control for the four above
check("TMF" in zeroed and not errors, "self_ledger: 群益 close filled in full → TMF zeroed")

# after the close (lib/tw_clock.close_hold): 群益 is not sent, the close is deferred to the reconciler's
# first round after the open and said; the crypto leg still closes
_real_ptc = _lp0._PAPER_TW_CLOSE_PATH
_lp0._PAPER_TW_CLOSE_PATH = os.path.join(BASE, "paper_tw_close.json")
_twc.close_hold = lambda now=None: {"why": "session", "until": _t0.time() + 3600}
run_flatten(True, BOOK)
_twc.close_hold = lambda now=None: None
deferred = json.load(open(_lp0._PAPER_TW_CLOSE_PATH)).get("keys") if os.path.exists(_lp0._PAPER_TW_CLOSE_PATH) else None
check(("capital", "TM2610") not in closes and ("binance", "BTCUSDT") in closes and "TMF" not in zeroed
      and deferred == ["TMF"]
      # no clock sample here: the row says the clock is unmeasured, not 休市 (the measured row: check_tw_entry_gate §11)
      and [e[3] for e in errors if e[0] == "TMF"] == [{"kind": "market_closed_deferred", "clock": "unmeasured"}]
      and any("台指期" in e[2] and "開盤後" in e[2] and "休市" not in e[2] for e in errors),
      f"after the close: 群益 not sent, TMF deferred to the open and said, its book kept ({errors}, {deferred})")
os.remove(_lp0._PAPER_TW_CLOSE_PATH)
# pressed in the pre-open (14:55, clock measured): the broker would take it, but queued under HALT
# and unconfirmed — deferred to the open the same way
_real_skew = _twc.skew
_twc.skew = lambda now=None: 0.0
_twc.queued_until = lambda now=None: _t0.time() + 300
run_flatten(True, BOOK)
_twc.queued_until = lambda now=None: None
deferred = json.load(open(_lp0._PAPER_TW_CLOSE_PATH)).get("keys") if os.path.exists(_lp0._PAPER_TW_CLOSE_PATH) else None
check(("capital", "TM2610") not in closes and deferred == ["TMF"] and "TMF" not in zeroed,
      f"pre-open press (measured clock): 群益 not sent, deferred to the open ({errors}, {deferred})")
os.remove(_lp0._PAPER_TW_CLOSE_PATH)
run_flatten(True, BOOK)
check(("capital", "TM2610") in closes and "TMF" in zeroed, "in session (measured clock): closed as before")
_twc.skew = _real_skew
_lp0._PAPER_TW_CLOSE_PATH = _real_ptc

# one venue unreadable → no stale-entry sweep at all (the book has no venue column)
POS_ERR = RuntimeError("capital snapshot stale")
run_flatten(True, BOOK, capital=POS_ERR)
check("TMF" not in zeroed and "ETHUSDT" not in zeroed and "BTCUSDT" in zeroed,
      f"get_positions raised → no sweep; only what was really closed is zeroed ({sorted(zeroed)})")

# same book key on two rows (roll): one closes, the other raises → book kept
TWO = {"TM2610": {"side": "long", "size": 1}, "TM2611": {"side": "long", "size": 1}}
run_flatten(True, BOOK, capital=TWO, close={"TM2611": "raise"})
check(("capital", "TM2610") in closes and "TMF" not in zeroed,
      f"same key, one row closed + one raised → TMF not zeroed ({sorted(zeroed)})")

for opt in ("TXO22000J6", "TX122000L6", "TX122000J6"):
    run_flatten(True, None, capital={opt: {"side": "long", "size": 1}})
    check(not [c for c in closes if c[0] == "capital"] and [e[:2] for e in errors] == [(opt, "capital")],
          f"option row {opt} is never sent as a TX00 futures close ({errors})")

# DATA_<SOURCE> keys are data sources, not venues — they must not stop the sweep
EXTRA_ENV.update(DATA_POLYGON_API_KEY="x", DATA_POLYGON_SECRET_KEY="x")
run_flatten(True, BOOK)
check("ETHUSDT" in zeroed and not any(e[1] == "data_polygon" for e in errors),
      f"DATA_ key bound → still a normal sweep, no venue error ({sorted(zeroed)})")
EXTRA_ENV.clear()
check(flatten._venues({"DATA_POLYGON_API_KEY": "x", "DATA_API_KEY": "x", "BLAVE_API_KEY": "x"})
      == ["data"], "_venues: DATA_<SOURCE> dropped, a venue literally named DATA kept")
# a key with no lib at all (half-entered 其他交易所) can't trade → not a reason to skip the sweep
EXTRA_ENV.update(FOOEX_API_KEY="x", FOOEX_SECRET_KEY="x")
run_flatten(True, BOOK)
check("ETHUSDT" in zeroed and not any(e[1] == "fooex" for e in errors),
      f"key without any lib → sweep still runs ({sorted(zeroed)})")
EXTRA_ENV.clear()
# a venue that can trade (order lib) but can't be read (no account lib)
EXTRA_ENV.update(SINOPAC_API_KEY="x", SINOPAC_SECRET_KEY="x")
run_flatten(True, BOOK)
check("ETHUSDT" not in zeroed and ("*", "sinopac") in [e[:2] for e in errors],
      f"order lib without account lib → no sweep + visible error ({sorted(zeroed)}, {errors})")
EXTRA_ENV.clear()
# a position row with no symbol at all could be any book key
run_flatten(True, BOOK, capital={"": {"side": "long", "size": 1}})
check("ETHUSDT" not in zeroed and "BTCUSDT" in zeroed, "nameless position row → no sweep")

# ── the real identity checks ─────────────────────────────────────────────────
if os.name != "nt":
    check(REAL_FLATTEN_ID() is False and REAL_REPORTER_ID() is False,
          "non-Windows: the real identity checks say no (can't tell → no)")
    # no ctypes.windll here → the try body raises → must still be "no"
    saved = os.name
    os.name = "nt"
    try:
        verdict = (REAL_FLATTEN_ID(), REAL_REPORTER_ID())
    finally:
        os.name = saved
    check(verdict == (False, False), f"identity lookup raising → False ({verdict})")


# The token lookup itself, on a stand-in advapi32 (any OS): the account name and the logon SIDs
# this process's token carries are the inputs; both copies must answer the same.
class _FakeAdvapi:
    SIDS = {"S-1-5-4": 4, "S-1-5-3": 3, "S-1-5-6": 6}

    def __init__(self, name, member):
        self.name, self.member = name, set(member)

    def GetUserNameW(self, buf, n):
        buf.value = self.name
        return 1

    def ConvertStringSidToSidW(self, sddl, ref):
        ref._obj.value = self.SIDS[sddl]
        return 1

    def CheckTokenMembership(self, _tok, sid, ref):
        ref._obj.value = any(self.SIDS[k] == sid.value for k in self.member)
        return 1


def _verdict(name, member, local):
    import ctypes
    saved_name, had = os.name, hasattr(ctypes, "windll")
    saved_windll = getattr(ctypes, "windll", None)
    ctypes.windll = types.SimpleNamespace(advapi32=_FakeAdvapi(name, member),
                                          kernel32=types.SimpleNamespace(LocalFree=lambda p: None))
    if local:
        os.environ["BLAVE_AGENT_LOCAL"] = "1"
    os.name = "nt"
    try:
        got = (REAL_FLATTEN_ID(), REAL_REPORTER_ID())
    finally:
        os.name = saved_name
        os.environ.pop("BLAVE_AGENT_LOCAL", None)
        if had:
            ctypes.windll = saved_windll
        else:
            del ctypes.windll
    return got[0] if got[0] == got[1] else ("differ", got)


INTER, BATCH, SERVICE = ["S-1-5-4"], ["S-1-5-3"], ["S-1-5-6"]
check(_verdict("Administrator", INTER, False) is True and _verdict("Administrator", BATCH, False) is True
      and _verdict("Administrator", SERVICE, False) is True,
      "cloud: Administrator under INTERACTIVE / BATCH / SERVICE → can log in")
check(_verdict("wei", INTER, False) is False and _verdict("SYSTEM", SERVICE, False) is False
      and _verdict("Administrator", [], False) is False,
      "cloud: any other account, or Administrator without a password logon → no")
check(_verdict("wei", INTER, True) is True and _verdict("Administrator", INTER, True) is True,
      "desktop: the signed-in user's INTERACTIVE logon, whatever the name → can log in (全部平倉 includes 群益)")
check(_verdict("wei", BATCH, True) is False and _verdict("wei", SERVICE, True) is False
      and _verdict("Administrator", SERVICE, True) is False and _verdict("wei", [], True) is False,
      "desktop: a scheduled task / service / no interactive logon → no")


def _identity_body(path):
    tree = ast.parse(open(path, encoding="utf-8").read())
    fn = next(n for n in tree.body
              if isinstance(n, ast.FunctionDef) and n.name == "_capital_order_identity_ok")
    return ast.dump(ast.Module(body=fn.body[1:], type_ignores=[]))  # [0] = docstring


check(_identity_body(os.path.join(ROOT, "manager", "flatten.py"))
      == _identity_body(os.path.join(ROOT, "runtime", "portfolio_reporter.py")),
      "flatten and reporter identity checks are the same code (docstrings aside)")

_lp0.book_ready = _real_ready  # the flatten cases are done

# ── reporter can_flatten ─────────────────────────────────────────────────────
open(os.path.join(WS, "manager", "flatten.py"), "w").close()
CAP = {"account": True, "order": True}
BIN = {"account": True, "order": True}
pr._capital_order_identity_ok = lambda: False
check(pr.can_flatten({"capital": CAP}) is False, "reporter: 群益-only + wrong identity → false")
check(pr.can_flatten({"capital": CAP, "binance": BIN}) is True, "reporter: mixed venues → true")
check(pr.can_flatten({"capital": CAP, "sinopac": {"account": False, "order": True}}) is False,
      "reporter: a venue flatten can't close doesn't count")
check(pr.can_flatten({}) is True, "reporter: no venues → unchanged (true)")
pr._capital_order_identity_ok = lambda: True
check(pr.can_flatten({"capital": CAP}) is True, "reporter: 群益-only + right identity → true")

# ── listener last line ───────────────────────────────────────────────────────
POS["capital"] = CAP_ONE  # the snapshot the listener reads
popens = []
cl.subprocess.Popen = lambda *a, **k: popens.append(a) or types.SimpleNamespace(pid=1)
pr.venues = lambda: {"capital": CAP}
pr._capital_order_identity_ok = lambda: False
check(cl._in_workspace(cl._cmd_close_all, {}) == "close_all=halted_capital_manual"
      and not popens, "listener: 群益-only → halted_capital_manual, nothing launched")
check(os.path.isfile(os.path.join(WS, "state", "HALT")), "listener: HALT still tripped")
check(__import__("json").load(open(os.path.join(WS, "state", "HALT"))).get("closing") is False,
      "listener: HALT closing false — nothing is being closed, the pages must not say so")
ERR_PATH = os.path.join(WS, "manager", "order_errors.json")


def _listener_rows():
    try:
        return json.load(open(ERR_PATH))
    except OSError:
        return []


row = (_listener_rows() or [{}])[-1]
check(row.get("kind") == "manual_close_required" and row.get("exchange") == "capital"
      and row.get("reason") == "identity" and row.get("symbols") == "TMF"
      and row.get("symbol") == "*" and "手動平倉" in row.get("error", "") and "ts" in row,
      f"listener: row carries kind + symbols from the snapshot, old fields kept ({row})")
POS["capital"] = {"TM2610": {"side": "long", "size": 1}, "MTX2610": {"side": "short", "size": 1},
                  "TXO22000J6": {"side": "long", "size": 1}}
cl._in_workspace(cl._cmd_close_all, {})
check((_listener_rows() or [{}])[-1].get("symbols") == "MXF,TMF,TXO22000J6",
      f"listener: futures → book keys, others as-is, sorted ({(_listener_rows() or [{}])[-1]})")
POS["capital"] = RuntimeError("capital snapshot stale")
n = len(_listener_rows())
cl._in_workspace(cl._cmd_close_all, {})
row = (_listener_rows() or [{}])[-1]
check(row.get("symbols") == "" and row.get("kind") == "manual_close_required"
      and len(_listener_rows()) == min(n + 1, 5),
      f"listener: snapshot unreadable → symbols \"\", row still written ({row})")
json.dump([{"symbol": f"S{i}"} for i in range(5)], open(ERR_PATH, "w"))
POS["capital"] = CAP_ONE
cl._in_workspace(cl._cmd_close_all, {})
rows = _listener_rows()
check(len(rows) == 5 and rows[-1].get("kind") == "manual_close_required"
      and rows[0].get("symbol") == "S1", f"listener: file full → still newest 5 ({rows})")

# self_ledger on → only the bot's own 群益 positions (same scope as flatten)
POS["capital"] = {"TM2610": {"side": "long", "size": 1}, "TX2610": {"side": "long", "size": 1},
                  "MTX2610": {"side": "long", "size": 1}, "TXO22000J6": {"side": "long", "size": 1}}
_real_cfg, _real_ledger = lp.load_portfolio_config, lp.ledger_positions
_real_seed = lp._load_ledger_seed
lp.load_portfolio_config = lambda: {"self_ledger": True}
lp._load_ledger_seed = lambda: {"seeded_at": "2026-01-01T00:00:00", "symbols": {}}
os.remove(ERR_PATH)  # each check below must see the row IT wrote
lp.ledger_positions = lambda *a: {"TMF": {"side": "long"}, "MXF": {"side": "short"},
                               "BTCUSDT": {"side": "long"}}
cl._in_workspace(cl._cmd_close_all, {})
check((_listener_rows() or [{}])[-1].get("symbols") == "TMF",
      f"listener + self_ledger: only the bot's (TMF), not the user's TXF/TXO or a wrong-side MXF "
      f"({(_listener_rows() or [{}])[-1]})")


def _raise():
    raise ValueError("orders.jsonl unreadable")


lp.ledger_positions = _raise
os.remove(ERR_PATH)
cl._in_workspace(cl._cmd_close_all, {})
check((_listener_rows() or [{}])[-1].get("symbols") == "MXF,TMF,TXF,TXO22000J6",
      f"listener + self_ledger unreadable → falls back to listing all ({(_listener_rows() or [{}])[-1]})")
lp.load_portfolio_config, lp.ledger_positions = _real_cfg, _real_ledger
lp._load_ledger_seed = _real_seed
check(cl._CAPITAL_BOOK_KEY == flatten._CAPITAL_BOOK_KEY
      and cl._CAPITAL_FUT_RE.pattern == flatten._CAPITAL_FUT_RE.pattern,
      "listener and flatten map 群益 contracts to the same book keys")
POS["capital"] = CAP_ONE
pr.venues = lambda: {"capital": CAP, "binance": BIN}
check(cl._in_workspace(cl._cmd_close_all, {}) == "close_all=started" and len(popens) == 1,
      "listener: mixed → flatten launched")

# close-all waits long enough for a reversal's two 群益 orders: 2 × (confirm 15 s + LATE_REPORT_S 30 s)
WAITS.clear(); run_flatten(True)
check(flatten._inflight_wait_s() >= 90 and WAITS and WAITS[0].get("timeout_s") == flatten._inflight_wait_s(),
      f"close-all's in-flight wait ≥ 90 s and flatten() passes it ({flatten._inflight_wait_s()}, {WAITS[:1]})")

# ── cloud 群益 closes as Administrator (unbind-consistency §5 step 2) ─────────────────────────
# off by default: until Wei's real 1-lot close the cloud keeps today's 群益-manual answers
pr._capital_order_identity_ok = lambda: False
pr._cloud_windows = lambda: True
PW = "Adm1n-Secret-xyz"
os.makedirs(os.path.join(BASE, "credentials"), exist_ok=True)
open(os.path.join(BASE, "credentials", "rdp_password.txt"), "w").write(PW)
check(pr.CAPITAL_ADMIN_FLATTEN_ON is False and pr.can_flatten({"capital": CAP}) is False
      and pr.manual_close_venues({"capital": CAP}) == ["capital"],
      "admin switch off by default: 群益-only under the bridge identity stays not closable")
pr.CAPITAL_ADMIN_FLATTEN_ON = True
check(pr.can_flatten({"capital": CAP}) is True and pr.manual_close_venues({"capital": CAP}) == []
      and cl._manual_venues({"capital"}) == set(),
      "switch on, Administrator password on file: 群益 is closable, nothing left manual")
os.remove(os.path.join(BASE, "credentials", "rdp_password.txt"))
check(pr.can_flatten({"capital": CAP}) is False and cl._manual_venues({"capital"}) == {"capital"},
      "no Administrator password on file: as before")
open(os.path.join(BASE, "credentials", "rdp_password.txt"), "w").write(PW)
pr._cloud_windows = lambda: False
check(pr.can_flatten({"capital": CAP}) is False, "not cloud Windows (desktop, Linux): never switches")
pr._cloud_windows = lambda: True

TASKS, DROPS = [], []
import capital_connect as _cc  # noqa: E402
import time as _time  # noqa: E402
_real_run, _real_drop = _cc.run_detached_as_administrator, _cc.drop_task
LAST = os.path.join(WS, "state", "last_flatten.json")
STATUS = cl.ADMIN_FLATTEN_STATUS
TASK_DOES = {"mode": "ok"}   # what the scheduled .cmd does on this machine


def fake_task(command, admin_pw, task):
    TASKS.append((command, admin_pw, task))
    m = TASK_DOES["mode"]
    if m == "silent":
        return
    if m == "nopython":
        open(STATUS, "w").write("nopython")
        return
    open(STATUS, "w").write("running")
    if m == "ok":   # flatten ran: it wrote its record, then the .cmd its exit
        json.dump({"started_at": _time.time(), "done_at": _time.time() + 1}, open(LAST, "w"))
        open(STATUS, "w").write("exit 0")
    elif m == "crash":   # python ran, flatten died before its lock: no record
        open(STATUS, "w").write("exit 1")


_cc.run_detached_as_administrator = fake_task
_cc.drop_task = lambda task: DROPS.append(task)
_real_platform = cl.platform.system
cl.platform.system = lambda: "Windows"
cl._ADMIN_FLATTEN_CMD_S, cl._ADMIN_FLATTEN_POLL_S = 0.6, 0.05
LOGS = []
_real_log = cl._log
cl._log = lambda m: LOGS.append(m)
pr.venues = lambda: {"capital": CAP}


def run_admin(mode):
    TASKS.clear(); DROPS.clear(); TASK_DOES["mode"] = mode
    for f_ in (LAST, STATUS):
        if os.path.exists(f_):
            os.remove(f_)
    n = len(popens)
    ack = cl._in_workspace(cl._cmd_close_all, {})
    for _ in range(60):
        if DROPS:
            break
        _time.sleep(0.05)
    _time.sleep(0.1)
    return ack, popens[n:]


ack, pops = run_admin("ok")
cmd_path = os.path.join(WS, "state", "flatten_admin.cmd")
script = open(cmd_path).read() if os.path.exists(cmd_path) else ""
check(ack == "close_all=started" and len(TASKS) == 1 and not pops
      and TASKS[0][1] == PW and TASKS[0][2] == cl.CAPITAL_FLATTEN_TASK and cmd_path in TASKS[0][0],
      f"群益-only close_all: started through the Administrator task, not the LocalSystem launch ({ack}, {TASKS})")
check(f'cd /d "{WS}"' in script and "manager\\flatten.py" in script and 'set "BLAVE_AGENT_LOCAL="' in script
      and f'set "BLAVE_AGENT_WORKSPACE={WS}"' in script and PW not in script and "where python" in script
      and "echo running>" in script and f'>"{STATUS}" echo exit %ERRORLEVEL%' in script,
      f"the task's .cmd: workspace cwd and env, BLAVE_AGENT_LOCAL cleared, status lines, no password ({script!r})")
check(DROPS == [cl.CAPITAL_FLATTEN_TASK] and not any(PW in m for m in LOGS),
      f"the task is dropped once the flatten wrote done_at; the password reaches no log ({DROPS})")
check("_flatten_already_running" not in cl._launch_flatten_as_admin.__code__.co_names
      and "_flatten_already_running" not in cl._flatten_started_since.__code__.co_names,
      "the watcher reads last_flatten.json, never probes flatten.lock (a probe can make a starting flatten exit)")
for mode, what in (("nopython", "python not on the Administrator's PATH"),
                   ("silent", "the task never ran its .cmd")):
    ack, pops = run_admin(mode)
    check(ack == "close_all=started" and len(pops) == 1 and "powershell" in pops[0][0] and DROPS,
          f"{what}: no 'started' on its say-so — started as this identity instead, task dropped ({ack}, {len(pops)})")
ack, pops = run_admin("crash")
check(ack == "close_all=started" and len(pops) == 1 and "powershell" in pops[0][0] and DROPS
      and any("ended before starting" in m for m in LOGS),
      f"python ran but the flatten never started (exit 1, no record): started as this identity ({len(pops)})")
check(cl._capital_admin_scope(("--venues", "binance", "--request-id", "r1")) is False
      and cl._capital_admin_scope(("--venues", "binance,capital", "--request-id", "r1")) is True,
      "only a scope with 群益 in it switches identity")


def _refused(command, admin_pw, task):
    raise ValueError("ADMIN_TASK_FAILED: could not schedule the Administrator task (password wrong?)")


_cc.run_detached_as_administrator = _refused
n_pop = len(popens)
ack = cl._in_workspace(cl._cmd_close_all, {})
check(ack == "close_all=started" and len(popens) == n_pop + 1 and "powershell" in popens[-1][0],
      f"the Administrator task refused: started as today instead (群益 then recorded manual) ({ack})")
_cc.run_detached_as_administrator, _cc.drop_task = _real_run, _real_drop
cl.platform.system, cl._log = _real_platform, _real_log
pr.CAPITAL_ADMIN_FLATTEN_ON = False

print("PASS" if not fails else f"{fails} FAILED")
sys.exit(1 if fails else 0)
