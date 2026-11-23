"""永豐期貨 wired into the reconciler, flatten and the account reader — no broker, no network.

0. Gate off (the shipped row has no verified mode; the odd-lot path is gone): hand_wired /
   native_units stay off; the reconciler has no 永豐 block; the six lowercase env names are 永豐's
   own (cred_env) and still pair as a bound venue, so the keys can be unbound.
S6 (Wei 11-17). Old odd-lot-era keys on a machine that never had futures (no bound_marker),
   gate off and gate on: runtime/account_reader and flatten leave 永豐 out and the report says
   account false — no read failure. A machine that has had futures (the worker's durable marker)
   with its snapshot gone: account_reader reports the read failure and close-all reports 永豐
   failed, never skipped.
The rest flips the gate in this process (the trait row + the libs' VERIFIED):
1. Reconciler lag: a snapshot read inside the last send's settle window raises
   SinopacCacheLagError (TRANSIENT: the round is skipped, never read as flat), also when the
   file turned lagging between the check and the read. 1b: the same with the real account lib and
   marker — an empty read that started after the send, before it, or just inside the window skips
   the round and sends no entry; one started ORDER_SETTLE_S after it reads flat.
2. Reconciler park / claim: a 'sent' entry 永豐 took unreported is parked (broker_ack, P1 row
   with its park id) and holds the next entry; a later settled read that moved one month by the
   lots books it there; an unchanged account clears it once the hold is over; an IOC 永豐 itself
   cancelled is parked without a row and cleared on the first settled read; an unknown outcome
   (OrderNotConfirmed, no month) is parked and claimed from the month that moved; three reads
   that explain nothing HALT. A deferred send (SnapshotNotSettled) defers the close and the
   flip's entry; a stopped login sends nothing. The book's months reach the order lib.
3. Order lib refusal mapping: only 永豐's own refusal after the send (from_broker) while the
   weekly table says shut is SessionClosed(from_broker, market_closed); the worker's own
   refusals and an in-session refusal stay SinopacError; an unknown outcome names its month when
   the worker did; a close of unknown outcome comes back status 'unknown'.
4. Flatten: the market_closed refusal is a [order_reject:market_closed] row with why
   market_closed (what command_listener._refused_closed_only lifts the unbind's HALT on); an
   ordinary refusal is not; dust only for [order_reject:below_min_size]; a 'sent' close is parked
   and noted unconfirmed.
5. runtime/account_reader: a lagging snapshot leaves positions unknown (None, ok false), never {}.

Run: cd blave-agent && .venv/bin/python tests/check_sinopac_futures_wiring.py
"""
import importlib
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
TMP = tempfile.mkdtemp(prefix="sinopac-wiring-")
os.environ["BLAVE_AGENT_HOME"] = os.environ["BLAVECLAW_HOME"] = TMP
os.environ.pop("BLAVE_AGENT_LOCAL", None)
sys.path.insert(0, ROOT)
os.chdir(TMP)
os.makedirs("state", exist_ok=True)
os.makedirs("manager", exist_ok=True)
with open("manager/portfolio_config.json", "w") as f:
    f.write("{}")

fails = 0


def check(cond, msg, detail=None):
    global fails
    print(("ok   " if cond else "FAIL ") + msg + ("" if cond or detail is None else f"  -- {detail}"))
    fails += 0 if cond else 1


def raises(exc, fn):
    try:
        fn()
    except exc as e:
        return e
    return None


# a stand-in shioaji: lib/order_sinopac imports it at the top; nothing here logs in
_sj = types.ModuleType("shioaji")
_sj.__version__ = "1.7.11"
sys.modules["shioaji"] = _sj

from lib import venue_traits  # noqa: E402

# ── 0. gate off ──────────────────────────────────────────────────────────────
SJ = venue_traits.SINOPAC
check("futures" not in venue_traits.verified_modes(SJ), "shipped row: futures not verified")
check(not venue_traits.has(SJ, "hand_wired") and not venue_traits.has(SJ, "native_units"),
      "gate off: hand_wired / native_units off — nothing routes or sizes 永豐 futures")
from manager import reconciler  # noqa: E402

check(SJ not in reconciler._HAND_WIRED, "gate off: the reconciler routes no 永豐 block")
# audit S6: the gate-flip commit renames the account lib; the reconciler's import must follow it
_want_acct = ("lib.account_sinopac" if "futures" in venue_traits.verified_modes(SJ)
              else "lib.sinopac_futures_account")
check(reconciler._sinopac_acct().__name__ == _want_acct,
      f"the reconciler reads 永豐 through the account lib the gate state names ({_want_acct})",
      reconciler._sinopac_acct().__name__)
names = ("sinopac_api_key", "sinopac_secret_key", "sinopac_ca_path", "sinopac_ca_passwd",
         "sinopac_person_id", "SINOPAC_LIVE")
check([venue_traits.cred_env(n) for n in names]
      == [("SINOPAC", "API_KEY"), ("SINOPAC", "SECRET_KEY")] + [("SINOPAC", "EXTRA")] * 4,
      "cred_env: the six names bound machines use are 永豐's own, casefolded")
import lib.venue_wiring as vw  # noqa: E402
_real_read_env = vw.read_env
vw.read_env = lambda path=".env": {"sinopac_api_key": "k", "sinopac_secret_key": "s", "sinopac_ca_path": "p"}
check(reconciler._env_venue_ids() == {"sinopac"}, "the lowercase pair still reads as a bound 永豐",
      reconciler._env_venue_ids())
vw.read_env = _real_read_env

# ── flip the gate in this process ────────────────────────────────────────────
ROW = venue_traits.TRAITS[SJ]
ROW.update(hand_wired=True, native_units=True, verified_modes=("futures",))
reconciler = importlib.reload(reconciler)
check(reconciler._HAND_WIRED.get(SJ) == (reconciler._sinopac_get_positions, reconciler._sinopac_place_order),
      "gate on: _HAND_WIRED routes 永豐 to its block")
from lib import order_sinopac as osj, sinopac_futures_account as acct_mod, sinopac_vault as vault  # noqa: E402
from lib import guard, tw_clock  # noqa: E402
import lib.portfolio as lp  # noqa: E402

osj.FUTURES_VERIFIED = acct_mod.VERIFIED = True
vault.LAST_ORDER_PATH = os.path.join(TMP, "state", "sinopac_last_order_at")
vault.LOGIN_STOPPED_PATH = os.path.join(TMP, "state", "sinopac_login_stopped.json")
reconciler.SINOPAC_PENDING_PATH = os.path.join(TMP, "state", "sinopac_pending_sent.json")


class FakeAcct:
    """lib/sinopac_futures_account as the reconciler reads it."""
    SnapshotLag = acct_mod.SnapshotLag
    contract_month = staticmethod(acct_mod.contract_month)

    def __init__(self):
        self.rows, self.caught_up, self.lag_on_read, self.started = [], True, False, 1000.0
        self.wait = None

    def waiting(self):
        return self.wait

    def snapshot_caught_up(self, snap=None):
        return self.caught_up, self.started, 900.0

    def position_rows(self):
        if self.lag_on_read:
            raise acct_mod.SnapshotLag("lagging")
        return [dict(r) for r in self.rows]

    def split_position_rows(self, now=None, book_months=None):
        return self.position_rows(), [], []

    def get_positions(self, env, book_months=None):
        out = {}
        for r in self.position_rows():
            out[r["root"]] = {"side": "long" if r["net"] > 0 else "short", "size": float(abs(r["net"])),
                              "productid": r["productid"]}
        return out


ACCT = FakeAcct()
reconciler._sinopac_acct = lambda: ACCT
reconciler._tw_close_held = lambda sym, venue: False
reconciler._tw_halt_close_held = lambda sym, venue: False
reconciler._tw_entry_held = lambda sym, venue: False
reconciler._queued_until = lambda: None
ROWS_ERR, BOOKED, RELEASED = [], [], []
lp._record_order_error = lambda sym, vid, err, extra=None, repeat=False: ROWS_ERR.append((sym, vid, err, extra))
lp.book_months = lambda venue=None, config=None: None
lp.book_late_fill = lambda root, venue, contract, lots, park_id=None, ordernos=None: BOOKED.append(
    (root, venue, contract, lots)) or {"ok": True}
lp._booked_park_ids = lambda field="unconfirmed_park_id": set()
lp.late_fill_booked = lambda pid: False
lp.mark_park_released = lambda pid, filled: RELEASED.append((pid, filled))
SENDS, NEXT, MONTHS = [], [], []


def _place(env, sym, action, lots, intent, client_tag=None, confirm_timeout=30, book_months=None):
    SENDS.append((sym, action, lots, intent))
    MONTHS.append(book_months)
    out = NEXT.pop(0)
    if isinstance(out, BaseException):
        raise out
    return out


osj.place_futures_market_order = _place


def pending():
    try:
        with open(reconciler.SINOPAC_PENDING_PATH, encoding="utf-8") as f:
            return json.load(f)
    except FileNotFoundError:
        return {}


def reset():
    if os.path.exists(reconciler.SINOPAC_PENDING_PATH):
        os.remove(reconciler.SINOPAC_PENDING_PATH)
    if guard.halted():
        guard.clear_halt("test")
    for b in (ROWS_ERR, BOOKED, RELEASED, SENDS, NEXT, MONTHS):
        b.clear()
    reconciler._closes_deferred.clear()
    ACCT.rows, ACCT.caught_up, ACCT.lag_on_read = [], True, False


# ── 1. lag ───────────────────────────────────────────────────────────────────
reset()
from lib import venue_errors  # noqa: E402
ACCT.caught_up = False
e = raises(reconciler.SinopacCacheLagError, lambda: reconciler._sinopac_get_positions(claim=True))
check(e is not None and reconciler._classify(SJ, e) == venue_errors.TRANSIENT,
      "a read started inside the settle window: SinopacCacheLagError, TRANSIENT (round skipped)", e)
ACCT.caught_up, ACCT.lag_on_read = True, True
e = raises(reconciler.SinopacCacheLagError, lambda: reconciler._sinopac_get_positions())
check(e is not None, "the file turned lagging between the check and the read: still a skipped round", e)
ACCT.lag_on_read = False
ACCT.rows = [{"root": "TXF", "productid": "TXFL6", "net": -2}]
got = reconciler._sinopac_get_positions()
check(got == {"TXF": {"side": "short", "size": 2.0, "exchange": SJ, "months": {"2026-12": -2.0}}},
      "a settled read: lots per root with the month", got)

# ── 1b. lag, with the real account lib and marker (audit M3) ────────────────
# an empty read inside the settle window never reaches the diff as flat, so it cannot re-open the
# book's lots; this holds only for a window at least as long as 永豐's real lag (still to be timed)
reset()
_real_snap = acct_mod._SNAPSHOT
acct_mod._SNAPSHOT = os.path.join(TMP, "state", "sinopac_account.json")
reconciler._sinopac_acct = lambda: acct_mod
lp.book_months = lambda venue=None, config=None: {"TXF": {"2026-12"}}  # the book holds TXF lots


def _snap_at(q, sent):
    with open(acct_mod._SNAPSHOT, "w") as f:
        json.dump({"ok": True, "equity": 1.0, "positions": [], "read_at": time.time(), "query_started_at": q,
                   "listed": {"TXF": ["TXFL6"]}, "account_fp": "abc"}, f)
    with open(vault.LAST_ORDER_PATH, "w") as f:
        f.write(repr(sent))
    vault._last_order_mem = 0.0


_sent = time.time() - 5
for q, label in ((_sent + 1, "a [] read started 1 s after the send"),
                 (_sent - 1, "a [] read started before the send and written after it"),
                 (_sent + vault.ORDER_SETTLE_S - 0.01, "a [] read started just inside the window")):
    _snap_at(q, _sent)
    e = raises(reconciler.SinopacCacheLagError, lambda: reconciler._sinopac_get_positions(claim=True))
    sent_before = len(SENDS)
    res = reconciler._sinopac_place_order("TXF", 1.0)
    check(e is not None and res is False and len(SENDS) == sent_before,
          f"real lib: {label} — the round is skipped and no entry goes out, never read as flat", e)
_snap_at(_sent + vault.ORDER_SETTLE_S, _sent)
check(reconciler._sinopac_get_positions() == {},
      "real lib: a read started ORDER_SETTLE_S after the send — flat is flat (the window's edge)")
os.remove(acct_mod._SNAPSHOT)
acct_mod._SNAPSHOT = _real_snap
reconciler._sinopac_acct = lambda: ACCT
lp.book_months = lambda venue=None, config=None: None

# ── 2. park / claim ──────────────────────────────────────────────────────────
reset()
NEXT.append({"status": "sent", "broker_status": "Submitted", "fill_qty": 0.0, "symbol": "TXFL6", "ordno": "A1"})
res = reconciler._sinopac_place_order("TXF", 1.0)
row = pending().get("TXF")
check(res and res["executed_qty"] == 0 and row and row["lots"] == 1.0 and row["legs"][0].get("broker_ack")
      and row["months_expected"] == {}, "'sent' with 永豐's status not final: parked with broker_ack", (res, row))
check(len(ROWS_ERR) == 1 and ROWS_ERR[0][3].get("kind") == reconciler.KIND_NO_REPORT
      and ROWS_ERR[0][3].get("park_id"), "…one order_unconfirmed row carrying the park id", ROWS_ERR)
check(reconciler._sinopac_place_order("TXF", 1.0) is False and len(SENDS) == 1,
      "the next entry on the root waits while it is parked (nothing sent)", SENDS)
ACCT.rows = [{"root": "TXF", "productid": "TXFL6", "net": 1}]
reconciler._sinopac_claim_pending(ACCT.started)
check(BOOKED == [("TXF", SJ, "TXFL6", 1.0)] and "TXF" not in pending(),
      "a settled read showing the lots in one month: booked there, row gone", (BOOKED, pending()))

reset()
NEXT.append({"status": "sent", "broker_status": "Submitted", "fill_qty": 0.0, "symbol": "TXFL6"})
reconciler._sinopac_place_order("TXF", 1.0)
reconciler._sinopac_claim_pending(time.time())   # the read's start, now: inside the hold
check("TXF" in pending() and not BOOKED, "unchanged account inside the broker_ack hold: kept", pending())
p = pending()
p["TXF"]["legs"][0]["at"] = time.time() - reconciler.QUEUED_HOLD_S - 5
with open(reconciler.SINOPAC_PENDING_PATH, "w") as f:
    json.dump(p, f)
reconciler._sinopac_claim_pending(time.time())
check("TXF" not in pending() and not BOOKED, "unchanged past the hold: cleared, nothing booked", pending())

reset()
NEXT.append({"status": "sent", "broker_status": "Cancelled", "fill_qty": 0.0, "symbol": "TXFL6"})
reconciler._sinopac_place_order("TXF", 1.0)
check("TXF" in pending() and not pending()["TXF"]["legs"][0].get("broker_ack") and not ROWS_ERR,
      "an IOC 永豐 cancelled: parked without broker_ack, no P1 row", (pending(), ROWS_ERR))
reconciler._sinopac_claim_pending(ACCT.started)
check("TXF" not in pending(), "…cleared on the first settled read that shows nothing moved", pending())

reset()
nc = osj.OrderNotConfirmed("took it, no answer")
nc.contract = None
NEXT.append(nc)
ACCT.rows = [{"root": "MXF", "productid": "MXFL6", "net": 1}]
res = reconciler._sinopac_place_order("MXF", -1.0, reduce_only=True)
row = pending().get("MXF")
check(res and res["status"] == "unknown" and row and row["lots"] == -1.0 and row["legs"][0].get("broker_ack")
      and row["months_expected"] == {"MXFL6": 1.0},
      "unknown outcome (no month): parked with the root's month baseline, never re-sent", (res, row))
check(reconciler._sinopac_place_order("MXF", -1.0, reduce_only=True) is False and len(SENDS) == 1,
      "the next close waits while one may sit queued at 永豐", SENDS)
ACCT.rows = []
reconciler._sinopac_claim_pending(ACCT.started)
check(BOOKED == [("MXF", SJ, "MXFL6", -1.0)] and "MXF" not in pending(),
      "…claimed from the one month that moved by the parked lots", BOOKED)

reset()
NEXT.append({"status": "sent", "broker_status": "Submitted", "fill_qty": 0.0, "symbol": "TMFL6"})
reconciler._sinopac_place_order("TMF", 2.0)
ACCT.rows = [{"root": "TMF", "productid": "TMFL6", "net": 5}]
for i in range(reconciler.PENDING_SENT_MAX_READS):
    reconciler._sinopac_claim_pending(ACCT.started + i)
check(guard.halted() and pending().get("TMF", {}).get("halted"),
      "three settled reads that explain nothing: HALT, the row marked halted", guard.halt_info())

reset()
NEXT.append({"status": "filled", "broker_status": "PartFilled", "fill_qty": 1.0, "symbol": "TXFL6"})
res = reconciler._sinopac_place_order("TXF", 2.0)
row = pending().get("TXF")
check(res["executed_qty"] == 1.0 and row and row["lots"] == 1.0 and row["legs"][0].get("broker_ack")
      and len(ROWS_ERR) == 1 and "1／2" in ROWS_ERR[0][2],
      "a short fill while 永豐's status is not final: the rest parked with broker_ack, one row", (row, ROWS_ERR))

reset()
import lib.venue_wiring as _vw  # noqa: E402
_real_hwv = _vw.hand_wired_venue
_vw.hand_wired_venue = lambda: SJ
ACCT.rows = [{"root": "TXF", "productid": "TXFL6", "net": 1}]
CLAIMED = []
_real_claim = reconciler._sinopac_claim_pending
reconciler._sinopac_claim_pending = lambda started: CLAIMED.append(started)
reconciler._claim_parked = True
got = reconciler.get_positions()
reconciler._claim_parked = False
check(got.get("TXF", {}).get("exchange") == SJ and CLAIMED == [ACCT.started],
      "get_positions on a 永豐-routed machine reads its block and claims parked sends (claim=True)", (got, CLAIMED))
reconciler._sinopac_claim_pending = _real_claim
NEXT.append({"status": "filled", "broker_status": "Filled", "fill_qty": 1.0, "symbol": "TXFL6"})
res = reconciler.place_order("TXF", 1.0, exchange=SJ)
check(res and res["exchange"] == SJ and SENDS == [("TXF", "buy", 1, "entry")] and not pending(),
      "place_order(exchange=sinopac) reaches the block; a full fill parks nothing", (res, SENDS))
with open(vault.LOGIN_STOPPED_PATH, "w") as f:
    f.write("{}")
ACCT.caught_up = False
_real_cur = reconciler._current_venue
reconciler._current_venue = lambda: SJ
e = raises(reconciler.ReadSkipped, lambda: reconciler._get_positions_guarded())
check(e is not None and reconciler._consecutive_failures == 0,
      "a read failing while the worker's login is stopped: ReadSkipped, not a counted failure", e)
os.remove(vault.LOGIN_STOPPED_PATH)
# S7: the worker waiting to retry a login that got no answer — skipped, no failure count, no outage clock
ACCT.wait, ACCT.caught_up = "login_retry", True
_real_rows = ACCT.position_rows
ACCT.position_rows = lambda: (_ for _ in ()).throw(RuntimeError("sinopac worker error: 永豐登入失敗 1 次"))
reconciler._outage.update(since=None, announced=False)
e = raises(reconciler.ReadSkipped, lambda: reconciler._get_positions_guarded())
check(e is not None and reconciler._consecutive_failures == 0 and reconciler._outage.get("since") is None,
      "a read failing while the worker waits for its login retry: ReadSkipped — no failure count toward HALT "
      "and no outage clock (the worker sends that streak's exchange_unreachable itself)", e)
ACCT.wait = None
e = raises(Exception, lambda: reconciler._get_positions_guarded())
check(e is not None and not isinstance(e, reconciler.ReadSkipped) and reconciler._consecutive_failures == 1,
      "…the same failure without the retry is a counted failure (the skip is the retry's, nothing wider)", e)
reconciler._consecutive_failures = 0
ACCT.position_rows = _real_rows
reconciler._current_venue = _real_cur
_vw.hand_wired_venue = _real_hwv

reset()
lp.book_months = lambda venue=None, config=None: {"TXF": {"2026-12"}}
NEXT.extend([{"status": "filled", "broker_status": "Filled", "fill_qty": 1.0, "symbol": "TXFL6"}] * 2)
reconciler._sinopac_place_order("TXF", -1.0, reduce_only=True)
reconciler._sinopac_place_order("MXF", 1.0)
check(MONTHS == [{"2026-12"}, set()],
      "the reconciler hands the book's months to the worker (a root the book does not hold: none)", MONTHS)
reset()
lp.book_months = lambda venue=None, config=None: None
NEXT.append({"status": "filled", "broker_status": "Filled", "fill_qty": 1.0, "symbol": "TXFL6"})
reconciler._sinopac_place_order("TXF", 1.0)
check(MONTHS == [None], "no book: None (the worker's calendar rule)", MONTHS)

reset()
NEXT.append(osj.SnapshotNotSettled("inside the window"))
check(reconciler._sinopac_place_order("TXF", -1.0, reduce_only=True) is False and "TXF" in reconciler._closes_deferred,
      "the worker deferred the close: nothing sent, the close is deferred this round")
check(reconciler._sinopac_place_order("TXF", 1.0) is False and len(SENDS) == 1,
      "…and the flip's entry waits for it", SENDS)

reset()
ACCT.caught_up = False
check(reconciler._sinopac_place_order("TXF", 1.0) is False and not SENDS,
      "a snapshot not caught up with the last send: nothing sent (the park baseline would predate it)")

reset()
with open(vault.LOGIN_STOPPED_PATH, "w") as f:
    f.write("{}")
check(reconciler.place_order("TXF", 1.0, exchange=SJ) is False and not SENDS,
      "the worker's login stopped: place_order skips 永豐, nothing sent")
os.remove(vault.LOGIN_STOPPED_PATH)

# ── 3. order lib refusal mapping ─────────────────────────────────────────────
osj.place_futures_market_order = importlib.reload(osj).place_futures_market_order  # the real one again
osj.FUTURES_VERIFIED = True
osj._worker_alive = lambda: None
osj._write_request = lambda req: None
RESP = {}
osj._await_response = lambda rid, timeout: dict(RESP)
osj.guard = types.SimpleNamespace(check_restart_stop=lambda *a: None, check_account_hold=lambda *a: None,
                                  entry_blocked=lambda: False, audit=lambda *a, **k: None,
                                  halt_closes_allowed=lambda: False, close_all_granted=lambda: False)
osj.tw_clock = types.SimpleNamespace(entry_hold=lambda now=None: None, queued_until=lambda now=None: None)


def shut(closed):
    osj.tw_clock.queued_until = (lambda now=None: time.time() + 600) if closed else (lambda now=None: None)


def close_raises(resp, closed):
    RESP.clear()
    RESP.update(resp)
    shut(closed)
    return raises(osj.SinopacError, lambda: osj.place_futures_market_order({}, "TXF", "sell", 1, "reduce"))


broker = {"status": "rejected", "error": "委託失敗", "from_broker": True, "symbol": "TXFL6"}
broker["broker_status"] = "Failed"
SHUT_EXC = e = close_raises(broker, True)
check(isinstance(e, osj.SessionClosed) and e.from_broker and str(e) == "委託失敗" and e.code == "Failed",
      "永豐 refused a sent close while the table says shut: SessionClosed from_broker, carrying 永豐's own "
      "text and status (never our wording as its reply)", e)
e = close_raises(broker, False)
check(e is not None and not isinstance(e, osj.SessionClosed), "the same refusal in session: a plain failure", e)
e = close_raises({"status": "rejected", "error": "no open TXF position — nothing to close"}, True)
check(e is not None and not isinstance(e, osj.SessionClosed),
      "the worker's own refusal (never sent) while shut: a plain failure, never market_closed", e)
check(e is not None and "永豐 refused" not in str(e) and str(e).startswith("Blave 沒送出這筆單：")
      and " / " not in str(e)
      and "永豐 refused" in str(close_raises(broker, False)),
      "the worker's own refusal says Blave did not send it; only 永豐's own reads as 永豐 refusing", e)
RESP.clear()
RESP.update({"status": "unknown", "error": "timeout", "symbol": "TXFL6"})
e = raises(osj.OrderNotConfirmed, lambda: osj.place_futures_market_order({}, "TXF", "sell", 1, "reduce"))
check(e is not None and e.contract == "TXFL6", "unknown outcome: OrderNotConfirmed naming the worker's month", e)
r = osj.close_position_partial({}, "TXF", "long", 1)
check(r["status"] == "unknown" and r["executed_qty"] == 0.0 and r["resolved_symbol"] == "TXFL6",
      "a close of unknown outcome comes back status 'unknown' (flatten notes it unconfirmed)", r)
from lib import reject_token  # noqa: E402
for fn in (lambda: osj.format_qty({}, "TXF", 0.4), lambda: osj.close_position_partial({}, "TXF", "long", 0.4)):
    e = raises(ValueError, fn)
    check(e is not None and str(e).startswith(f"[order_reject:{reject_token.BELOW_MIN_SIZE}]"),
          "under one lot: ValueError tagged below_min_size (flatten's only dust)", e)

# ── 4. flatten ───────────────────────────────────────────────────────────────
sys.path.insert(0, os.path.join(ROOT, "manager"))
import flatten  # noqa: E402  (chdir's to ROOT — everything that writes is patched below)

os.chdir(TMP)
flatten.LOCK_PATH = os.path.join(TMP, "flatten.lock")
flatten.LAST_PATH = os.path.join(TMP, "last_flatten.json")
errors, fsends, zeroed, parks = [], [], set(), []
flatten._record_order_error = lambda sym, vid, err, extra=None: errors.append((sym, vid, err, extra))
flatten._append_reconciler_log = lambda row: None
flatten.zero_ledger_symbols = lambda syms, venue=None: zeroed.update(syms)
flatten._kick_reconciler = lambda: None
flatten._wait_for_inflight = lambda *a, **k: []
flatten._wait_snapshot_settled = lambda *a, **k: None
flatten._reconciler = lambda: types.SimpleNamespace(
    _sinopac_nets=lambda root=None: {"TXFL6": 2.0}, SINOPAC_PENDING_PATH="x",
    PendingUnreadable=RuntimeError, _pending_sent=lambda path: {},
    _sinopac_park=lambda *a, **k: parks.append(a) or "p")
flatten.load_portfolio_config = lambda: {"self_ledger": False}
flatten._load_ledger_seed = lambda: {"seeded_at": "2026-01-01T00:00:00", "symbols": {}}
lp.book_ready = lambda config=None: True
lp.claim_unvenued_rows = lambda: None
HALTED = [False]
flatten.guard = types.SimpleNamespace(
    halted=lambda: HALTED[0], trip_halt=lambda *a: HALTED.__setitem__(0, True),
    restart_stopped=lambda: False, grant_halt_closes=lambda *a: None, hold_turn_money=lambda: None,
    TurnMoneyBusy=type("TurnMoneyBusy", (RuntimeError,), {}))
flatten._read_env = lambda path=".env": {"sinopac_api_key": "k", "sinopac_secret_key": "s"}
tw_clock.skew = tw_clock.gross_skew = lambda now=None: 0.0   # measured: _tw_clock_probe asks nothing
POS = {}
OUTCOME = []
_acct = types.ModuleType("lib.account_sinopac")
_acct.get_positions = lambda env, **k: dict(POS)
_order = types.ModuleType("lib.order_sinopac")
_order.format_qty = osj.format_qty


def _close(env, sym, side, size, client_order_id=None):
    fsends.append((sym, side, size))
    out = OUTCOME.pop(0)
    if isinstance(out, BaseException):
        raise out
    return out


_order.close_position_partial = _close
# audit M2: flatten hands the book's months only to libs that take them (_takes) — the real ones must
check(flatten._takes(osj.close_position_partial, "book_months")
      and flatten._takes(acct_mod.get_positions, "book_months"),
      "flatten passes the book's months to the real close_position_partial and get_positions")
sys.modules["lib.account_sinopac"], sys.modules["lib.order_sinopac"] = _acct, _order
os.makedirs(os.path.join(TMP, "lib"), exist_ok=True)   # flatten checks lib/<kind>_<venue>.py relative to cwd
for _k in ("account", "order"):
    open(os.path.join(TMP, "lib", f"{_k}_sinopac.py"), "w").close()

# S6: a machine holding only the odd-lot era's sinopac_* keys (the futures worker never started
# there, so no bound_marker) — gate on, account lib in place: nothing reads or flattens 永豐
sys.path.insert(0, os.path.join(ROOT, "runtime"))
os.environ["BLAVE_AGENT_WORKSPACE"] = TMP
import account_reader  # noqa: E402
import portfolio_reporter  # noqa: E402
import venue_traits as rt_traits  # noqa: E402  (the runtime's own copy)

os.chdir(TMP)
account_reader.WORKSPACE = portfolio_reporter.WORKSPACE = TMP
rt_traits.TRAITS[SJ].update(hand_wired=True, native_units=True, verified_modes=("futures",))
_old = {"sinopac_api_key": "k", "sinopac_secret_key": "s", "sinopac_ca_path": "/x.pfx", "sinopac_ca_passwd": "p"}
with open(os.path.join(TMP, ".env"), "w") as f:
    f.write("".join(f"{k}={v}\n" for k, v in _old.items()))
_marker = os.path.join(TMP, venue_traits.get(SJ, "bound_marker"))
if os.path.exists(_marker):
    os.remove(_marker)
_rep = portfolio_reporter.venues().get(SJ, {})
check(account_reader._venues(_old) == [] and flatten._venues(_old) == []
      and _rep.get("credentials") and _rep.get("account") is False,
      "S6, gate on: odd-lot-era keys on a machine that never had futures — not read, not flattened, the report lists the "
      "keys (so they can be unbound) with account false: no read failure",
      (account_reader._venues(_old), flatten._venues(_old), _rep))
with open(_marker, "w") as f:
    f.write("{}")
check(account_reader._venues(_old) == [SJ] and flatten._venues(_old) == [SJ]
      and portfolio_reporter.venues()[SJ]["account"] is True,
      "…once the futures worker has started there (its marker), both read and flatten 永豐",
      (account_reader._venues(_old), flatten._venues(_old)))
rt_traits.TRAITS[SJ].update(hand_wired=False, native_units=False, verified_modes=())
check(account_reader._venues(_old) == [] and portfolio_reporter.venues()[SJ]["account"] is False,
      "S6, gate off: unverified — not read even with the marker there")
os.remove(os.path.join(TMP, ".env"))


def run(pos, outcome):
    errors.clear(), fsends.clear(), zeroed.clear(), parks.clear()
    POS.clear()
    POS.update(pos)
    OUTCOME[:] = list(outcome)
    HALTED[0] = False
    if os.path.exists(flatten.LAST_PATH):
        os.remove(flatten.LAST_PATH)
    flatten._RUN.update(unconfirmed=set(), why={}, err={}, reply={}, first_err=None, venues=[])
    flatten._SJ_BASE = None
    flatten._LOCK = None
    res = flatten.flatten()
    if flatten._LOCK is not None:
        flatten._LOCK.close()
    last = json.load(open(flatten.LAST_PATH)) if os.path.exists(flatten.LAST_PATH) else {}
    return res, last


def whys(last, key="TXF"):
    return [u.get("why") for u in last.get("unclosed", []) if u.get("key") == key]


TXF = {"TXF": {"side": "long", "size": 2.0, "productid": "TXFL6"}}
# S6 (Wei 11-17): a machine that has had futures (marker present) whose snapshot is gone
_real_gp = _acct.get_positions


def _gone(env, **k):
    raise RuntimeError("sinopac snapshot missing — is the 永豐 futures worker (lib/sinopac_worker.py) running?")


_acct.get_positions = _gone
res, last = run(TXF, [])
_acct.get_positions = _real_gp
check(res is False and not fsends and any(x[1] == SJ and "snapshot missing" in x[2] for x in errors)
      and SJ in flatten._RUN["venues"],
      "S6: had futures, snapshot gone → close-all reports 永豐 failed (an error row), never skips it", errors)
res, last = run(TXF, [SHUT_EXC])
mine = [x for x in errors if x[0] == "TXF"]
check(len(fsends) == 1 and len(mine) == 1 and "[order_reject:market_closed]" in mine[0][2]
      and whys(last) == ["market_closed"] and res is False,
      "flatten: 永豐's shut-market refusal → one market_closed row, why market_closed (sent once)", (errors, last))
check([u.get("reply") for u in last.get("unclosed", []) if u.get("key") == "TXF"] == ["委託失敗"],
      "flatten: the unbind box's broker reply is 永豐's own text", last.get("unclosed"))
sys.path.insert(0, os.path.join(ROOT, "runtime"))
import command_listener  # noqa: E402

os.chdir(TMP)
check(command_listener._refused_closed_only(last),
      "close_then_unbind: only a shut-market refusal left → the press's own HALT may be lifted", last)
res, last = run(TXF, [osj.SinopacError("永豐 refused the order: 保證金不足")])
check(whys(last) and whys(last) != ["market_closed"] and not command_listener._refused_closed_only(last)
      and not any("market_closed" in x[2] for x in errors),
      "flatten: an ordinary 永豐 refusal is not market_closed — the unbind keeps its pause", (errors, last))
res, last = run({"TXF": {"side": "long", "size": 0.5, "productid": "TXFL6"}}, [])
check(not fsends and not errors and "TXF" in zeroed,
      "flatten: under one lot is dust ([order_reject:below_min_size]): nothing sent, the key counts as flat",
      (fsends, errors, zeroed))
_plain = types.ModuleType("lib.order_sinopac")
_plain.close_position_partial = _close


def _bad_qty(env, sym, qty, price=None):
    raise ValueError("contract suspended")


_plain.format_qty = _bad_qty
sys.modules["lib.order_sinopac"] = _plain
res, last = run(TXF, [])
check(not fsends and errors and "TXF" not in zeroed and whys(last),
      "flatten: an untagged ValueError is no dust — an error row, the key left open", (errors, last))
sys.modules["lib.order_sinopac"] = _order
res, last = run(TXF, [{"status": "sent", "broker_status": "Submitted", "executed_qty": 0.0,
                       "resolved_symbol": "TXFL6", "avg_price": 0.0}])
check(parks and parks[0][0] == "TXF" and parks[0][2] == -2 and parks[0][3] == {"TXFL6": 2.0}
      and parks[0][1]["broker_ack"] and whys(last) == [] and last.get("unconfirmed"),
      "flatten: a 'sent' close is parked for the reconciler's claim (baseline read before it) and noted "
      "unconfirmed", (parks, last))

# ── 5. account reader ────────────────────────────────────────────────────────
os.chdir(TMP)
acct_mod = importlib.reload(acct_mod)
acct_mod.VERIFIED = True
acct_mod._SNAPSHOT = os.path.join(TMP, "state", "sinopac_account.json")
now = time.time()
with open(acct_mod._SNAPSHOT, "w") as f:
    json.dump({"ok": True, "equity": 50010.0, "positions": [], "read_at": now, "query_started_at": now - 1,
               "listed": {}, "account_fp": "abc"}, f)
with open(vault.LAST_ORDER_PATH, "w") as f:
    f.write(repr(now - 5))
vault._last_order_mem = 0.0
sys.modules["lib.account_sinopac"] = acct_mod
import account_reader  # noqa: E402

os.rename(acct_mod._SNAPSHOT, acct_mod._SNAPSHOT + ".away")
entry = account_reader.read_venue(SJ, {})
check(entry["ok"] is False and entry.get("error") and os.path.exists(_marker),
      "S6: had futures (marker kept), snapshot gone → account_reader reports the read failure", entry)
os.rename(acct_mod._SNAPSHOT + ".away", acct_mod._SNAPSHOT)
entry = account_reader.read_venue(SJ, {})
check(entry["positions"] is None and entry["ok"] is False and entry["error"]["type"] == "SnapshotLag"
      and entry["error"]["stage"] == "get_positions" and entry["equity"] == 50010.0,
      "account_reader: a read inside the settle window leaves positions unknown, never {} (M0-b's [])", entry)
with open(vault.LAST_ORDER_PATH, "w") as f:
    f.write(repr(now - 3600))
entry = account_reader.read_venue(SJ, {})
check(entry["ok"] is True and entry["positions"] == {}, "…and a settled read of a flat account reads flat", entry)

print(f"\n{'FAILED: ' + str(fails) if fails else 'all passed'}")
sys.exit(1 if fails else 0)
