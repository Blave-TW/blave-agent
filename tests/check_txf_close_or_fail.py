"""全部平倉 while 台指期 is shut: sent whatever the time, a refusal is a failure (Wei 11-15) — no network,
no broker, no Windows.

Drives manager/flatten.flatten() end to end on stand-in venue libs, for each of 群益, 統一 and paper,
each beside a Binance position:
  - the clock says shut (measured): the 台指期 close is still sent, nothing written to
    state/paper_tw_close.json, HALT tripped, the key zeroed, no error row;
  - 統一 refuses it (9901 → SessionClosed from_broker) or its own window refuses it: one plain
    failure row (no kind → order_error, P1 real), the book not zeroed, last_flatten unclosed with
    why market_closed and ok false (the unbind holds), sent once and nothing scheduled to resend;
  - 群益 refuses it (CapitalError): market_closed while the weekly session table says shut, an ordinary
    failure inside the session (Wei 11-16);
  - an unbind press (--close-id): the refusal row waits for the whole run, says paused and carries
    close_id, never halt_lifted (the listener rewords it once the HALT really went);
  - a 0.1.53 deferral on disk does not change what flatten sends and is not added to.
The runtime flag the pages read (portfolio_reporter.txf_close_refuses) is checked last.

Run: cd blave-agent && .venv/bin/python tests/check_txf_close_or_fail.py
"""
import json
import os
import sys
import tempfile
import time
import types

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_REPO_ENV = os.path.join(ROOT, ".env")


def _no_repo_env(event, args):
    if event == "open" and args and isinstance(args[0], (str, bytes)):
        if os.path.abspath(os.fsdecode(args[0])) == _REPO_ENV:
            raise RuntimeError("test tried to open the repo .env")


sys.addaudithook(_no_repo_env)
BASE = tempfile.mkdtemp(prefix="txf-fail-", dir=os.environ.get("SCRATCHPAD") or None)
os.environ["BLAVE_AGENT_HOME"] = os.environ["BLAVECLAW_HOME"] = BASE
os.environ.pop("BLAVE_AGENT_LOCAL", None)
sys.path.insert(0, ROOT)
sys.path.insert(0, os.path.join(ROOT, "manager"))
import flatten  # noqa: E402  (chdir's to ROOT — everything that writes is patched below)
import lib.portfolio as lp  # noqa: E402
from lib import tw_clock  # noqa: E402

fails = 0


def check(cond, msg, detail=None):
    global fails
    print(("ok   " if cond else "FAIL ") + msg + ("" if cond or detail is None else f"  -- {detail}"))
    fails += 0 if cond else 1


flatten.LOCK_PATH = os.path.join(BASE, "flatten.lock")
flatten.LAST_PATH = os.path.join(BASE, "last_flatten.json")
flatten.CAPITAL_PENDING_PATH = os.path.join(BASE, "capital_pending_sent.json")
lp._PAPER_TW_CLOSE_PATH = os.path.join(BASE, "paper_tw_close.json")
lp._SEED_LOCK_PATH = os.path.join(BASE, "ledger_seed.lock")
errors, sends, zeroed, halts = [], [], set(), []
flatten._record_order_error = lambda sym, vid, err, extra=None: errors.append((sym, vid, err, extra))
flatten._append_reconciler_log = lambda row: None
flatten.zero_ledger_symbols = lambda syms, venue=None: zeroed.update(syms)
flatten._kick_reconciler = lambda: None
flatten._wait_for_inflight = lambda *a, **k: []
flatten._capital_order_identity_ok = lambda: True
flatten._capital_park_close = lambda *a, **k: None
flatten._reconciler = lambda: types.SimpleNamespace(_capital_nets=lambda root=None: {},
                                                     _capital_park=lambda *a, **k: "p")
CFG = {"self_ledger": False}
LEDGER = {}
flatten.load_portfolio_config = lambda: CFG
flatten.ledger_positions = lambda vid=None: {k: v for k, v in LEDGER.items() if vid is None or v.get("venue") == vid}
flatten._load_ledger_seed = lambda: {"seeded_at": "2026-01-01T00:00:00", "symbols": {}}
lp.book_ready = lambda config=None: True
lp.claim_unvenued_rows = lambda: None
lp.book_account_check = lambda env, vid: ("ok", "")
HALTED = [False]
flatten.guard = types.SimpleNamespace(
    halted=lambda: HALTED[0], trip_halt=lambda *a: halts.append(a) or HALTED.__setitem__(0, True),
    restart_stopped=lambda: False, grant_halt_closes=lambda *a: None, hold_turn_money=lambda: None,
    TurnMoneyBusy=type("TurnMoneyBusy", (RuntimeError,), {}))
ENV = {}
flatten._read_env = lambda path=".env": dict(ENV)
POS = {}
REFUSE = {}   # venue → the exception its close raises (after recording the send)
USER_CLOSE = []   # what flatten passed as user_close to the paper lib (lib/order_paper names it)


def _filled(vid, sym, size):
    sends.append((vid, sym, size))
    if vid in REFUSE:
        raise REFUSE[vid]
    rows = POS.get(vid)   # filled: gone from the account, so a --request-id run re-reads it flat
    if isinstance(rows, list):
        POS[vid] = [r for r in rows if r.get("symbol") != sym]
    elif isinstance(rows, dict):
        POS[vid] = {k: v for k, v in rows.items() if k != sym}
    return {"status": "filled", "executed_qty": float(size), "avg_price": 22000.0}


def _venue(vid, lots_close):
    acct, order = types.ModuleType(f"lib.account_{vid}"), types.ModuleType(f"lib.order_{vid}")
    acct.get_positions = lambda env, **k: POS.get(vid, [])
    order.format_qty = lambda env, sym, size: str(size)
    order.close_position_partial = lambda env, sym, side, size, client_order_id=None, **k: _filled(vid, sym, size)
    if lots_close:   # paper: names user_close like lib/order_paper (a TW stock then fills outside the session)
        order.place_contract_market_order = (lambda env, sym, side, lots, cv, client_order_id=None, reduce_only=False,
                                             user_close=False: USER_CLOSE.append(user_close) or _filled(vid, sym, lots))
    sys.modules[f"lib.account_{vid}"], sys.modules[f"lib.order_{vid}"] = acct, order


for _v in ("capital", "president", "binance"):
    _venue(_v, False)
_venue("paper", True)
BTC = [{"symbol": "BTCUSDT", "side": "long", "size": 0.01, "mark_price": 60000}]
CASES = {  # venue → (env, its 台指期 rows, the book key)
    "capital": ({"CAPITAL_API_KEY": "x", "CAPITAL_PASSWORD": "x"}, {"TM2612": {"side": "long", "size": 2}}, "TMF"),
    "president": ({"president_account": "x"}, {"TXF": {"side": "short", "size": 1}}, "TXF"),
    "paper": ({"PAPER_API_KEY": "x"}, [{"symbol": "MXFR1", "side": "long", "size": 3, "unit": "contracts",
                                        "contract_value": 50, "mark_price": 22000}], "MXFR1"),
}


def shut(closed):
    """closed: the market is shut on a measured clock (pre-open included) — or open."""
    tw_clock.skew = lambda now=None: 0.0
    tw_clock.gross_skew = lambda now=None: 0.0
    tw_clock.queued_until = (lambda now=None: time.time() + 3600) if closed else (lambda now=None: None)
    tw_clock.close_hold = (lambda now=None: {"why": "session", "until": time.time() + 3600}) if closed \
        else (lambda now=None: None)


def run(vid, ledger=True, halted=False):
    env, rows, key = CASES[vid]
    for b in (errors, sends, halts):
        b.clear()
    zeroed.clear()
    if os.path.exists(flatten.LAST_PATH):
        os.remove(flatten.LAST_PATH)
    flatten._RUN.update(unconfirmed=set(), why={}, err={}, reply={}, first_err=None, venues=[])
    HALTED[0] = halted
    ENV.clear()
    ENV.update(env, BINANCE_API_KEY="x", BINANCE_SECRET_KEY="x")
    POS.clear()
    POS.update({vid: list(rows) if isinstance(rows, list) else rows, "binance": BTC})
    LEDGER.clear()
    CFG["self_ledger"] = ledger
    if ledger:
        LEDGER.update({key: {"side": "long" if vid != "president" else "short", "size": 2.0, "qty": 3.0
                             if vid == "paper" else (2.0 if vid == "capital" else 1.0), "venue": vid},
                       "BTCUSDT": {"side": "long", "size": 600.0, "qty": 0.01, "venue": "binance"}})
    flatten._LOCK = None
    res = flatten.flatten()
    if flatten._LOCK is not None:
        flatten._LOCK.close()
    last = json.load(open(flatten.LAST_PATH)) if os.path.exists(flatten.LAST_PATH) else {}
    return res, key, last


# the clock says shut: sent anyway (Wei 11-15 — no time gate on the user's close)
for vid in ("capital", "president", "paper"):
    for ledger in (True, False):
        tag = f"{vid}{'' if ledger else ' (account read)'}"
        shut(True)
        res, key, last = run(vid, ledger)
        check(len([s for s in sends if s[0] == vid]) == 1, f"{tag}, shut by the clock: the 台指期 close is sent", sends)
        check(not os.path.exists(lp._PAPER_TW_CLOSE_PATH), f"{tag}, shut: nothing scheduled for the open")
        check(halts and halts[0][0] == "close all positions", f"{tag}, shut: HALT tripped (the strategies stop)", halts)
        check(("binance", "BTCUSDT", 0.01) in sends, f"{tag}, shut: the Binance leg closes in the same run", sends)
        check(not errors and res is True and (not ledger or key in zeroed) and last.get("ok") is True,
              f"{tag}, shut, the venue takes it: closed, no error row", (errors, sorted(zeroed)))
        if vid == "paper":
            check(USER_CLOSE and all(u is True for u in USER_CLOSE),
                  f"{tag}: flatten passes user_close=True to the paper lib", USER_CLOSE)
            USER_CLOSE.clear()


class SessionClosed(Exception):   # order_president.SessionClosed, matched by name like the real one
    from_broker = False


def refused(vid, exc, ledger=True):
    REFUSE[vid] = exc
    try:
        return run(vid, ledger)
    finally:
        REFUSE.pop(vid, None)


_broker = SessionClosed("統一 rejected the order: statuscode=9901 TTO0001:交易時間已結束")
_broker.from_broker = True
_window = SessionClosed("統一期貨 takes no order now: outside the trading window — reduce TXF not sent, no login")
for name, vid, exc, words in (
        ("統一 answers shut (9901)", "president", _broker, "[order_reject:market_closed]"),
        ("統一's own window refuses before the login", "president", _window, "[order_reject:market_closed]"),
        ("群益 refuses (ncode)", "capital", RuntimeError("群益 rejected the close: ncode=1001 期貨委託失敗"), "群益 rejected")):
    for ledger in (True, False):
        tag = f"{name}{'' if ledger else ' (account read)'}"
        shut(False)
        res, key, last = refused(vid, exc, ledger)
        mine = [e for e in errors if e[0] == key]
        check(len([s for s in sends if s[0] == vid]) == 1, f"{tag}: sent once", sends)
        check(len(mine) == 1 and mine[0][1] == vid and not (mine[0][3] or {}).get("kind") and words in mine[0][2],
              f"{tag}: one plain failure row (order_error: P1 real)", errors)
        check(key not in zeroed and ("binance", "BTCUSDT", 0.01) in sends,
              f"{tag}: the 台指期 book is not zeroed, the Binance leg still closes", (sorted(zeroed), sends))
        check(res is False and last.get("ok") is False and key in [u.get("key") for u in last.get("unclosed", [])],
              f"{tag}: last_flatten ok false with the key unclosed (an unbind holds, the keys stay)", last)
        check(not os.path.exists(lp._PAPER_TW_CLOSE_PATH) and halts,
              f"{tag}: nothing scheduled to resend at the open, HALT stays", halts)
        if vid == "capital":
            # not a CapitalError, and in session anyway: a plain failure, so an unbind pressed while
            # trading keeps its pause (command_listener._lift_own_halt lifts market_closed only)
            check([u.get("why") for u in last.get("unclosed", []) if u.get("key") == key] != ["market_closed"],
                  f"{tag}: why is not market_closed", last.get("unclosed"))
        if vid == "president":
            check([u.get("why") for u in last.get("unclosed", []) if u.get("key") == key] == ["market_closed"],
                  f"{tag}: why market_closed", last.get("unclosed"))
            mine0 = mine[0][2] if mine else ""
            check("休市中沒有平倉" in mine0 and "部位還在" in mine0 and "沒有停損" in mine0, f"{tag}: the row says it could not close and stays", mine0)
res, key, last = refused("president", _broker)
check(any("交易時間已結束" in str(u.get("reply") or "") for u in last.get("unclosed", [])) or
      "交易時間已結束" in json.dumps(last, ensure_ascii=False),
      "統一's own words reach last_flatten (the unbind failure box prints them)", last.get("unclosed"))


class CapitalError(Exception):   # order_capital.CapitalError, matched by name like the real one
    pass


# 群益 (Wei 11-16): no session code in its refusal — the weekly session table decides
_cap_no = CapitalError("order rejected code=4 期貨委託失敗 (msg='')")
for closed in (True, False):
    for ledger in (True, False):
        tag = f"群益 refuses, table says {'shut' if closed else 'open'}{'' if ledger else ' (account read)'}"
        shut(closed)
        res, key, last = refused("capital", _cap_no, ledger)
        mine = [e for e in errors if e[0] == key]
        whys = [u.get("why") for u in last.get("unclosed", []) if u.get("key") == key]
        check(len([s for s in sends if s[0] == "capital"]) == 1 and len(mine) == 1 and not (mine[0][3] or {}).get("kind")
              and key not in zeroed and res is False, f"{tag}: sent once, one plain row, book kept", (sends, errors))
        if closed:
            check(whys == ["market_closed"] and "[order_reject:market_closed]" in mine[0][2] and "沒有停損" in mine[0][2]
                  and not mine[0][3], f"{tag}: market_closed, the paused row (no press of its own HALT here)", (whys, mine))
        else:
            check(whys != ["market_closed"] and "market_closed" not in mine[0][2],
                  f"{tag}: a normal failure — the unbind keeps its pause", (whys, mine))
shut(True)
_cap_os = OSError("SKCOM COM call failed")
res, key, last = refused("capital", _cap_os)
check([u.get("why") for u in last.get("unclosed", []) if u.get("key") == key] != ["market_closed"],
      "群益, table shut, an error that is not CapitalError (may come after the order was taken): not market_closed",
      last.get("unclosed"))

# close-then-unbind (--close-id): flatten never words the row as lifted nor sets halt_lifted — only the
# listener does, after the HALT really went (audit 0.1.55 M2). The row is tagged close_id for it.
flatten.REQUEST_ID, flatten.CLOSE_ID = "r1", "c1"
try:
    for vid, exc in (("capital", _cap_no), ("president", _broker)):
        shut(vid == "capital")   # 統一's own code says shut whatever the table
        res, key, last = refused(vid, exc, ledger=False)   # account read: the re-read sees the Binance close
        mine = [e for e in errors if e[0] == key]
        check(len(mine) == 1 and mine[0][3] == {"close_id": "c1"} and "沒有停損" in mine[0][2]
              and "沒有解除連接" not in mine[0][2] and "[order_reject:market_closed]" in mine[0][2]
              and [u.get("why") for u in last.get("unclosed", [])] == ["market_closed"],
              f"{vid}, close-id run, only the refusal left: the paused row tagged close_id, no halt_lifted", (mine, last))
    shut(True)
    REFUSE["binance"] = RuntimeError("binance said no")
    try:
        res, key, last = refused("capital", _cap_no)
    finally:
        REFUSE.pop("binance", None)
    mine = [e for e in errors if e[0] == key]
    check(len(mine) == 1 and mine[0][3] == {"close_id": "c1"} and "沒有停損" in mine[0][2]
          and sorted(u.get("why") for u in last.get("unclosed", [])) == ["error", "market_closed"],
          "群益 refused shut + Binance failed: the paused row, no halt_lifted", (mine, last.get("unclosed")))
finally:
    flatten.REQUEST_ID, flatten.CLOSE_ID = None, None

# a 0.1.53 deferral already on disk: flatten neither honours it nor adds to it — the close is sent now
with open(lp._PAPER_TW_CLOSE_PATH, "w") as f:
    json.dump({"keys": ["TMF"], "ts": 1}, f)
shut(True)
res, key, last = run("capital")
check([s for s in sends if s[0] == "capital"] and json.load(open(lp._PAPER_TW_CLOSE_PATH))["keys"] == ["TMF"]
      and not errors,
      "群益, shut, a 0.1.53 deferral of TMF on disk: sent now, the file untouched (the reconciler drops it)", (sends, errors))
os.remove(lp._PAPER_TW_CLOSE_PATH)

# the upgrade's dropped 0.1.53 deferral (web audit S1): one row per symbol, so the positions table can
# match each; a key the book can't show this round is said too, never dropped without a row
rows = []
_real_rec, _real_bv = lp._record_order_error, lp.book_venue
lp._record_order_error = lambda sym, vid, err, extra=None: rows.append((sym, vid, err))
lp.book_venue = lambda: "president"


def _deferral(keys, **extra):
    with open(lp._PAPER_TW_CLOSE_PATH, "w") as f:
        json.dump({"keys": keys, "ts": 1, **extra}, f)


try:
    _deferral(["MXF", "TXF", "2317", "2330"])
    lp._drop_tw_deferred({"MXF": {"side": "long", "size": 1, "exchange": "president"},
                          "TXF": {"side": "short", "size": 2, "exchange": "president"},
                          "2317": {"side": "long", "size": 1000, "exchange": "paper"},
                          "2330": {"side": "long", "size": 1000, "exchange": "paper"}}, True)
    check(sorted((r[0], r[1]) for r in rows) == [("2317", "paper"), ("2330", "paper"), ("MXF", "president"),
                                                  ("TXF", "president")]
          and all("," not in r[0] for r in rows)
          and all(r[2] == lp._TW_DEFER_DROPPED for r in rows if r[1] == "president")
          and all(r[2] == lp._TW_DEFER_DROPPED_PAPER for r in rows if r[1] == "paper")
          and not os.path.exists(lp._PAPER_TW_CLOSE_PATH),
          "S1: MXF,TXF and 2317,2330 dropped under HALT → four rows, one symbol each, same text per venue", rows)
    rows.clear()
    _deferral(["MXF", "TXF", "2330"])
    lp._drop_tw_deferred({"MXF": {"side": "long", "size": 1, "exchange": "president"}}, True)
    check(rows == [("MXF", "president", lp._TW_DEFER_DROPPED)],
          "S1: a readable book with no row for TXF / 2330 (the book drops flat rows) → only the held key is said", rows)
    rows.clear()
    _deferral(["MXF", "TXF", "2330"])
    lp._drop_tw_deferred({}, True, book_known=False)
    check(sorted(rows) == sorted([("MXF", "president", lp._TW_DEFER_DROPPED_UNREAD),
                                  ("TXF", "president", lp._TW_DEFER_DROPPED_UNREAD),
                                  ("2330", "paper", lp._TW_DEFER_DROPPED_UNREAD_PAPER)]),
          "S1: a round with no book to read (no baseline) → every dropped key still gets its row, said as unread "
          "(futures on the book's venue, stocks on paper), never dropped silently", rows)
    rows.clear()
    _deferral(["MXF", "TXF"])
    lp._drop_tw_deferred({"MXF": {"side": "long", "size": 0, "exchange": "president"},
                          "TXF": {"side": "long", "size": 1, "exchange": "president"}}, True)
    check(rows == [("TXF", "president", lp._TW_DEFER_DROPPED)],
          "S1: a key the book shows flat is not said; the held one is", rows)
    rows.clear()
    _deferral(["MXF", "TXF", "2330"])
    lp._drop_tw_deferred({"MXF": {"side": "long", "size": 1, "exchange": "president"},
                          "TXF": {"side": "short", "size": 1, "exchange": "president"},
                          "2330": {"side": "long", "size": 1000, "exchange": "paper"}}, False)
    check(sorted(rows) == sorted([("MXF", "president", lp._FUT_TW_CANCEL), ("TXF", "president", lp._FUT_TW_CANCEL),
                                  ("2330", "paper", lp._PAPER_TW_CANCEL)]),
          "S1: resumed before the first round → the old cancel row, one per symbol", rows)
    rows.clear()
    _deferral(["MXF", "TXF"])
    _real_remove = os.remove

    def _deny(path, *a, **k):
        if os.path.basename(path) == "paper_tw_close.json":
            raise PermissionError("locked")
        return _real_remove(path, *a, **k)
    os.remove = _deny
    try:
        lp._drop_tw_deferred({}, True, book_known=False)
    finally:
        os.remove = _real_remove
    check(rows == [] and os.path.exists(lp._PAPER_TW_CLOSE_PATH),
          "S1: a file that can't be removed → no row yet, retried next round", rows)
    lp._drop_tw_deferred({}, True, book_known=False)
    check(sorted(r[0] for r in rows) == ["MXF", "TXF"] and not os.path.exists(lp._PAPER_TW_CLOSE_PATH),
          "S1: …the next round removes it and writes the rows once", rows)
finally:
    lp._record_order_error, lp.book_venue = _real_rec, _real_bv
# through the real recorder: order_errors.json keeps the newest 5, so more keys than that lose the
# first ones in the same round; the sort puts stock codes first, so real-money futures are kept
_cwd = os.getcwd()
os.makedirs(os.path.join(BASE, "rec", "manager"), exist_ok=True)
os.chdir(os.path.join(BASE, "rec"))
try:
    lp.book_venue = lambda: "president"
    _deferral(["1101", "2317", "2330", "2454", "2603", "MXF", "TXF"])
    held7 = {k: {"side": "long", "size": 1, "exchange": "paper" if k[0].isdigit() else "president"}
             for k in ["1101", "2317", "2330", "2454", "2603", "MXF", "TXF"]}
    lp._drop_tw_deferred(held7, True)
    kept = [r["symbol"] for r in json.load(open(os.path.join("manager", "order_errors.json")))]
    check(kept == ["2330", "2454", "2603", "MXF", "TXF"],
          "S1 limit (measured): seven dropped keys through the real recorder → the newest five rows stay, "
          "the futures among them", kept)
finally:
    lp.book_venue = _real_bv
    os.chdir(_cwd)

# the cloud update drops the 0.1.53 deferral before its copy (audit 0.1.55 S3, Wei 11-16): a restart
# that does not happen leaves the old lib running, and it re-reads this file every round.
# _paper_tw_deferred as shipped on origin/main d308ad2e (lib/portfolio.py:810), verbatim.
OLD_PAPER_TW_DEFERRED = '''
def _paper_tw_deferred(diff_actual, halted):
    try:
        rec = load_json(_PAPER_TW_CLOSE_PATH)
        keys = set(rec.get('keys') or [])
    except FileNotFoundError:
        return set()
    except (OSError, ValueError, AttributeError):
        rec, keys = {}, set()
    held = {k for k in keys if float((diff_actual.get(k) or {}).get('size') or 0) > 0}
    if held and not halted:
        restart = bool(rec.get('restart_at'))
        stocks = {k for k in held if _tw_stock(split_key(k)[0])}
        if stocks:
            _record_order_error(','.join(sorted(stocks)), 'paper',
                                _PAPER_TW_CANCEL_RESTART if restart else _PAPER_TW_CANCEL)
        by_venue = {}
        for k in held - stocks:
            by_venue.setdefault((diff_actual.get(k) or {}).get('exchange') or book_venue(), []).append(k)
        for venue, ks in sorted(by_venue.items()):
            _record_order_error(','.join(sorted(ks)), venue,
                                _FUT_TW_CANCEL_RESTART if restart else _FUT_TW_CANCEL)
    if not halted or not held:
        try:
            os.remove(_PAPER_TW_CLOSE_PATH)
        except OSError:
            pass
        return set()
    if held != keys:
        tmp = _PAPER_TW_CLOSE_PATH + '.tmp'
        with open(tmp, 'w') as f:
            json.dump({**rec, 'keys': sorted(held), 'ts': int(time.time())}, f)
        atomic_replace(tmp, _PAPER_TW_CLOSE_PATH)
    return held
'''
import update_workspace as uw  # noqa: E402

UW = os.path.join(BASE, "upd")
UW_FILE = os.path.join(UW, "state", "paper_tw_close.json")
os.makedirs(os.path.join(UW, "manager"))
os.makedirs(os.path.join(UW, "state"))
BOOK = {"TXF": {"side": "long", "size": 1, "exchange": "president"},
        "2330": {"side": "long", "size": 1000, "exchange": "paper"}}
old_ns = dict(vars(lp), _PAPER_TW_CLOSE_PATH=UW_FILE)
exec(OLD_PAPER_TW_DEFERRED, old_ns)


def _uw_rows():
    try:
        return [(r["symbol"], r["error"]) for r in json.load(open(os.path.join(UW, "manager", "order_errors.json")))]
    except FileNotFoundError:
        return []


with open(UW_FILE, "w") as f:
    json.dump({"keys": ["TXF", "2330"], "ts": 1}, f)
check(uw.drop_tw_deferred(ROOT, UW) is None and os.path.exists(UW_FILE) and not _uw_rows(),
      "S3: no HALT → the update leaves the file (the old lib drops it itself and sends nothing)")
open(os.path.join(UW, "state", "HALT"), "w").close()
check(old_ns["_paper_tw_deferred"](BOOK, True) == {"TXF", "2330"},
      "S3 fixture is real: the 0.1.53 round under HALT would send TXF and 2330 from this file")
os.chmod(os.path.join(UW, "state"), 0o555)
try:
    res = uw.drop_tw_deferred(ROOT, UW)
finally:
    os.chmod(os.path.join(UW, "state"), 0o755)
check(res and res["dropped"] is False and "not removed" in res.get("error", "") and os.path.exists(UW_FILE)
      and not _uw_rows(), "S3: a file that can't be removed stays, no row, the reason returned (update not stopped)", res)
res = uw.drop_tw_deferred(ROOT, UW)
check(res == {"dropped": True} and not os.path.exists(UW_FILE)
      and sorted(_uw_rows()) == sorted([("TXF", lp._TW_DEFER_DROPPED_UNREAD),
                                        ("2330", lp._TW_DEFER_DROPPED_UNREAD_PAPER)]),
      "S3: under HALT the update drops the file through the clone's _drop_tw_deferred: one unread row per key",
      (res, _uw_rows()))
check(old_ns["_paper_tw_deferred"](BOOK, True) == set(),
      "S3: the 0.1.53 round that runs after it (restart deferred / failed) finds nothing to send")
_cwd = os.getcwd()
os.chdir(UW)
_real_path = lp._PAPER_TW_CLOSE_PATH
lp._PAPER_TW_CLOSE_PATH = UW_FILE
try:
    lp._drop_tw_deferred(BOOK, True)
finally:
    lp._PAPER_TW_CLOSE_PATH = _real_path
    os.chdir(_cwd)
check(len(_uw_rows()) == 2, "S3: the new lib's first round after the restart writes no second row", _uw_rows())
with open(UW_FILE, "w") as f:
    json.dump({"keys": ["TXF"], "ts": 1}, f)
res = uw.drop_tw_deferred(os.path.join(BASE, "no-clone"), UW)
check(res and res["dropped"] is True and res.get("rowless") is True and res.get("error")
      and not os.path.exists(UW_FILE) and len(_uw_rows()) == 2,
      "S3: the clone's lib can't run → the file still goes (never sent outranks the row), said in the result", res)

# the report says which rule this workspace's flatten.py follows (the pages pick their sentence by it)
sys.path.insert(0, os.path.join(ROOT, "runtime"))
import portfolio_reporter as pr  # noqa: E402
WS = os.path.join(BASE, "ws")
os.makedirs(os.path.join(WS, "manager"))
pr.WORKSPACE = WS
check(pr.txf_close_refuses() is False, "reporter: no flatten.py → txf_close_refuses false")
with open(os.path.join(WS, "manager", "flatten.py"), "w", encoding="utf-8") as f:
    f.write(open(os.path.join(ROOT, "manager", "flatten.py"), encoding="utf-8").read())
check(pr.txf_close_refuses() is True, "reporter: this flatten.py → txf_close_refuses true")
with open(os.path.join(WS, "manager", "flatten.py"), "w", encoding="utf-8") as f:
    f.write("def _defer_tw_close(vid, key, exc):\n    pass\n")
check(pr.txf_close_refuses() is False, "reporter: a 0.1.53 flatten.py (defers to the open) → false")
check("txf_close_keeps" not in open(os.path.join(ROOT, "runtime", "portfolio_reporter.py"), encoding="utf-8").read(),
      "reporter: the 0.1.54 draft flag txf_close_keeps is gone")

print()
print("check_txf_close_or_fail: " + ("all ok" if not fails else f"{fails} FAILED"))
sys.exit(1 if fails else 0)
