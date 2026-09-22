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

REAL_FLATTEN_ID = flatten._capital_order_identity_ok
REAL_REPORTER_ID = pr._capital_order_identity_ok
fails = 0


def check(cond, msg):
    global fails
    print(("ok   " if cond else "FAIL ") + msg)
    fails += 0 if cond else 1


# ── flatten ──────────────────────────────────────────────────────────────────
flatten.LOCK_PATH = os.path.join(BASE, "flatten.lock")
errors, closes, logged, zeroed = [], [], [], set()
LEDGER = {}
CFG = {}
POS = {}      # vid -> positions (or an Exception to raise)
CLOSE = {}    # capital resolved sym -> "raise" | "sent" | "partial"; default = filled
flatten._record_order_error = (
    lambda sym, vid, err, extra=None: errors.append((sym, vid, err, extra)))
flatten._append_reconciler_log = lambda row: logged.append(row["symbol"])
flatten.zero_ledger_symbols = lambda syms: zeroed.update(syms)
flatten.load_portfolio_config = lambda: CFG
flatten.ledger_positions = lambda: dict(LEDGER)
flatten._wait_for_inflight = lambda *a, **k: []
flatten.guard = types.SimpleNamespace(halted=lambda: True, trip_halt=lambda *a: None,
                                      restart_stopped=lambda: False)
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


def run_flatten(identity_ok, ledger=None, capital=CAP_ONE, close=None):
    for bucket in (errors, closes, logged, zeroed):
        bucket.clear()
    CFG.clear()
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


res = run_flatten(False)
MANUAL = {"kind": "manual_close_required", "symbols": "TMF", "reason": "identity"}
check(errors and errors[0][3] == MANUAL, f"wrong identity: row carries kind/symbols/reason ({errors})")
check(("capital", "TM2610") not in closes, "wrong identity: 群益 close NOT sent")
check(("binance", "BTCUSDT") in closes, "wrong identity: crypto leg still closed")
check([e[:2] for e in errors] == [("TMF", "capital")] and "手動平倉" in errors[0][2],
      f"wrong identity: one 群益 error, keyed like the positions table (TMF) ({errors})")
check(res is False, "wrong identity: flatten reports it ran with errors")

run_flatten(True)
check(("capital", "TM2610") in closes and not errors, "Administrator password logon: 群益 closes")

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


def _identity_body(path):
    tree = ast.parse(open(path, encoding="utf-8").read())
    fn = next(n for n in tree.body
              if isinstance(n, ast.FunctionDef) and n.name == "_capital_order_identity_ok")
    return ast.dump(ast.Module(body=fn.body[1:], type_ignores=[]))  # [0] = docstring


check(_identity_body(os.path.join(ROOT, "manager", "flatten.py"))
      == _identity_body(os.path.join(ROOT, "runtime", "portfolio_reporter.py")),
      "flatten and reporter identity checks are the same code (docstrings aside)")

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
lp.load_portfolio_config = lambda: {"self_ledger": True}
os.remove(ERR_PATH)  # each check below must see the row IT wrote
lp.ledger_positions = lambda: {"TMF": {"side": "long"}, "MXF": {"side": "short"},
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
check(cl._CAPITAL_BOOK_KEY == flatten._CAPITAL_BOOK_KEY
      and cl._CAPITAL_FUT_RE.pattern == flatten._CAPITAL_FUT_RE.pattern,
      "listener and flatten map 群益 contracts to the same book keys")
POS["capital"] = CAP_ONE
pr.venues = lambda: {"capital": CAP, "binance": BIN}
check(cl._in_workspace(cl._cmd_close_all, {}) == "close_all=started" and len(popens) == 1,
      "listener: mixed → flatten launched")

print("PASS" if not fails else f"{fails} FAILED")
sys.exit(1 if fails else 0)
