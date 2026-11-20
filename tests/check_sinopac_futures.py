"""永豐期貨 futures path without a broker — Shioaji is faked, nothing logs in.

0. Not live-verified yet (lib/venue_traits sinopac row has no verified mode):
   the lib refuses before writing a request, the worker exits without a login
   (daemon and --once), sinopac_futures_account refuses every read. The rest of this
   file flips the three modules' VERIFIED on to test what runs after the gate.
   lib/order_sinopac carries no odd-lot path and never imports shioaji.
1. Contract pick (worker): an entry goes to the computed near month when it is
   listed, adds to the book's held month, is refused when unlisted or when the
   book holds the root in two months; a reduce goes to the held month as Cover,
   refused when it would add, reverse or the root is flat. A month outside the
   book's (book_months; None = the TAIFEX calendar) is the user's: never closed,
   added to or opened into, and it does not block the bot's month.
2. Position rows: a month code is read as is; any other code goes through the
   contracts v2 base (info(base) root + delivery month); an unreadable
   TXF-looking code fails the read; other products are left out.
2b. Contracts v2 (M0-b, 1.7.11): M0-b's TMF list gives six month codes (root +
   month letter + year digit, = president_contracts), R1/R2 dropped, info(base)
   only when a base has no delivery_date; a delivery date that disagrees with
   the code fails the read; the order goes to the listed base; the background
   load is polled with a bound, a read before it is done fails.
3. execute(): a market IOC built with FuturesOrder's 1.7.11 signature; fills
   from deals (floored by deal_quantity); Failed → rejected; place_order
   raising → unknown (never "refused"); HALT sends nothing — entries and
   reduces alike — except a reduce whose request carries the user's close pass;
   the restart record blocks both before place_order, except a reduce whose
   request carries flatten's close-all pass (both passes under HALT too), and
   neither pass outlives its request; a client_tag is refused
   the second time today; an expired request is refused; a request whose
   intent, action, symbol or qty is not exactly what the lib writes is refused
   before any gate (audit M5), under HALT and the restart record too.
3c. Position lag (M0-b: [] right after a fill): the marker is written before
   every send; a request inside ORDER_SETTLE_S with no time to wait is deferred
   (nothing sent), with time it waits and its read starts after the window;
   the account lib refuses the lagging snapshot (SnapshotLag, TRANSIENT).
4. Relay: lib → request file → worker → response, one session; no heartbeat →
   WorkerUnavailable with no request left behind; a close right after the entry
   → SnapshotNotSettled; a request nobody takes is
   cancelled (nothing sent); a taken request with no answer → OrderNotConfirmed;
   under HALT the lib writes no request, except a reduce inside the user's close
   pass, which carries the pass to the worker; close_all_pass only for a reduce
   from the process holding the close-all pass; book_months as a sorted list;
   answered requests leave no files, the worker's start sweeps day-old ones, an
   answer that cannot be written does not stop the worker.
5. Login: no fetch_contracts, subscribe_trade=True; a bounded wait for the
   contract load that never fails the login; CA activated after login in live
   mode only; no futures account → LoginError and logged out; signed=False →
   NOT_SIGNED (the probe file carries the class); a STOP record keeps the daemon
   from logging in. S7 (Wei 11-17): timeout / connection / DNS / 503 / 451
   logins retry for good after spaced, persisted waits (451 ≥ LOGIN_451_WAIT_S)
   with a `waiting` snapshot, never a STOP; exchange_unreachable 25 min into the
   streak, then every 2 h, none under HALT; any credential / certificate /
   signing / unidentified failure stops with one P1. A start past the gate
   writes the durable futures-enabled marker (venue_traits bound_marker).
6. sinopac_futures_account: missing / stale / error snapshots raise; two months of one
   root raise; positions in lots.
7. flatten's TW-broker names (format_qty, close_position_partial) exist.
Also: the MKP retry (once, after a Failed MKT with no fill only), the TAIFEX
entry gate in the lib and the worker, the 1.7.11 pin, the daemon's one
venue_login_blocked, quiet_sdk masking ids written to fd 1, the account lib's
month-aware reads, and the refusing stubs.

Run: cd blave-agent && .venv/bin/python tests/check_sinopac_futures.py
"""
import json, os, sys, tempfile, threading, time, types
from datetime import datetime

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
TMP = tempfile.mkdtemp(prefix="sinopac-")
os.chdir(TMP)
os.makedirs("state", exist_ok=True)
os.environ["BLAVE_AGENT_HOME"] = os.environ["BLAVECLAW_HOME"] = TMP
os.environ["SJ_LOG_PATH"] = "shioaji.log"  # a shell setting the libs must override

fails = 0


def check(cond, msg, detail=None):
    global fails
    print(("ok   " if cond else "FAIL ") + msg + ("" if cond or detail is None else f"  {detail}"))
    fails += 0 if cond else 1


def raises(exc, fn):
    try:
        fn()
    except exc as e:
        return e
    return None


def fresh_marker():
    """No send on this machine yet (the last-order marker lives in TMP, never the repo's state/)."""
    from lib import sinopac_vault as v
    v.LAST_ORDER_PATH = os.path.join(TMP, "state", "sinopac_last_order_at")
    v._last_order_mem = 0.0
    if os.path.exists(v.LAST_ORDER_PATH):
        os.remove(v.LAST_ORDER_PATH)


# ── fake shioaji ─────────────────────────────────────────────────────────────
class _E:
    def __init__(self, v):
        self.value = v

    def __repr__(self):
        return f"<{self.value}>"


sj = types.ModuleType("shioaji")
sj.__version__ = "1.7.11"
sj.Action = types.SimpleNamespace(Buy=_E("Buy"), Sell=_E("Sell"))
sj.FuturesPriceType = types.SimpleNamespace(MKT=_E("MKT"), LMT=_E("LMT"), MKP=_E("MKP"))
sj.AccountType = types.SimpleNamespace(Stock=_E("S"), Future=_E("F"))
sj.TimeInForce = types.SimpleNamespace(IOC=_E("IOC"), ROD=_E("ROD"))
sj.FuturesOCType = types.SimpleNamespace(Auto=_E("Auto"), Cover=_E("Cover"), New=_E("New"))


class FuturesOrder:
    """The 1.7.11 signature (introspected offline from the installed package): an unknown or
    missing keyword fails here as it would there."""

    def __init__(self, action, price, quantity, price_type, time_in_force=None, octype=None,
                 custom_field=None, account=None, *, order_type=None):
        self.action, self.price, self.quantity, self.price_type = action, price, quantity, price_type
        self.time_in_force, self.octype, self.custom_field, self.account = (time_in_force, octype,
                                                                            custom_field, account)


sj.FuturesOrder = FuturesOrder


class ShioajiTimeoutError(Exception):
    pass


class Base:
    """A contracts v2 base: code + delivery_date (M0-b), nothing else."""

    def __init__(self, code, delivery_date=None):
        self.code, self.delivery_date = code, delivery_date


def computed_near(root):
    from lib.president_contracts import computed_near as cn
    return cn(root)


def _ymd(code):
    from lib.president_contracts import month_of
    y, m = month_of(code)
    return f"{y}/{m:02d}/15"


def _listing(extra=()):
    by = {}
    for root in ("TXF", "MXF", "TMF"):
        g = [Base(f"{root}R1"), Base(f"{root}R2"), Base(f"{root}K6", "2026/11/18"),
             Base(f"{root}L6", "2026/12/16")]
        near = computed_near(root)  # today's entry month, so the relay test is date-independent
        if near not in {c.code for c in g}:
            g.append(Base(near, _ymd(near)))
        by[root] = g
    for root, c in extra:
        by[root].append(c)
    return by


class ContractsV2:
    """api.contracts: raises until the background load is done (`not_ready` polls), like 1.7.11."""

    def __init__(self, by_root, not_ready=0, infos=None):
        self.by_root, self.not_ready, self.infos = by_root, not_ready, dict(infos or {})
        self.polls = self.info_calls = 0

    def _loaded(self):
        self.polls += 1
        if self.not_ready > 0:
            self.not_ready -= 1
            raise RuntimeError("contracts not loaded yet")

    def futures(self, root, region=None):
        self._loaded()
        return list(self.by_root.get(root, []))

    def get(self, code, region=None, security_type=None, exchange=None):
        self._loaded()
        return next((b for g in self.by_root.values() for b in g if b.code == code), None)

    def info(self, base):
        self.info_calls += 1
        return self.infos.get(base.code, types.SimpleNamespace(root=None, delivery_date=None,
                                                                delivery_month=None))


class FakeApi:
    def __init__(self, positions=(), fill=("Filled", [(1, 23000.0)]), place_raises=None,
                 login_raises=None, futopt=True, ca_ok=True, extra=(), infos=None, not_ready=0,
                 lag_s=0.0):
        self.calls = []
        self.positions = list(positions)
        self.fill = fill
        self.place_raises = place_raises
        self.login_raises = login_raises
        self.login_kw = None
        self.futopt_account = types.SimpleNamespace(account_id="F0001", signed=True) if futopt else None
        # what login() returns: the futures account is picked from here by its AccountType
        self.accounts = ([types.SimpleNamespace(account_type=sj.AccountType.Stock, account_id="S0001"),
                          types.SimpleNamespace(account_type=sj.AccountType.Future, account_id="F0002",
                                                signed=True)] if futopt else [])
        self.ca_ok = ca_ok
        self.contracts = ContractsV2(_listing(extra), not_ready, infos)
        self.trades = []
        self.logged_out = False
        # M0-b: list_positions right after a fill still reads the old book for this long
        self.lag_s, self.filled_at, self.before_fill = lag_s, 0.0, None
        fresh_marker()  # every FakeApi is an independent case: no earlier send on "this machine"

    def login(self, **kw):
        self.calls.append("login")
        self.login_kw = kw
        if self.login_raises:
            raise self.login_raises
        return self.accounts

    def fetch_contracts(self, **kw):
        self.calls.append("fetch_contracts")
        raise ShioajiTimeoutError("exclusive access lost (concurrent API call started)")

    def activate_ca(self, **kw):
        self.calls.append("activate_ca")
        return self.ca_ok

    def logout(self):
        self.logged_out = True
        self.calls.append("logout")

    def margin(self, acct):
        return types.SimpleNamespace(equity=500000.0, available_margin=400000.0,
                                     initial_margin=80000.0, maintenance_margin=60000.0,
                                     deposit_withdrawal=0.0)

    def list_positions(self, acct):
        rows = self.positions
        if self.before_fill is not None and time.time() - self.filled_at < self.lag_s:
            rows = self.before_fill
        return [types.SimpleNamespace(code=c, direction=sj.Action.Buy if n > 0 else sj.Action.Sell,
                                      quantity=abs(n), price=22900.0, pnl=0.0)
                for c, n in rows]

    def place_order(self, contract, order):
        self.calls.append(("place_order", contract.code, order))
        if self.place_raises:
            raise self.place_raises
        # a list of fills = one per place_order call, in order
        status, deals = self.fill.pop(0) if isinstance(self.fill, list) else self.fill
        if deals and self.lag_s:
            self.before_fill, self.filled_at = list(self.positions), time.time()
            n = sum(q for q, _ in deals) * (1 if order.action.value == "Buy" else -1)
            held = dict(self.positions)
            held[contract.code] = held.get(contract.code, 0) + n
            self.positions = [(c, q) for c, q in held.items() if q]
        st = types.SimpleNamespace(status=_E(status), msg="rejected by test" if status == "Failed" else "",
                                   deals=[types.SimpleNamespace(quantity=q, price=p) for q, p in deals],
                                   deal_quantity=sum(q for q, _ in deals))
        t = types.SimpleNamespace(order=types.SimpleNamespace(id="o1", seqno="s1", ordno="n1"),
                                  status=st, contract=contract)
        self.trades = [t]
        return t

    def update_status(self, acct, trade=None):
        self.calls.append("update_status")

    def list_trades(self):
        return self.trades


holder = {"api": None}
sj.Shioaji = lambda simulation=None: holder["api"]
sys.modules["shioaji"] = sj

from lib import guard, order_sinopac as osj, sinopac_futures_account as account_sinopac, sinopac_worker as w  # noqa: E402

# the credential store, inside this test's temp dir — never <repo parent>/credentials
w.sinopac_vault.VAULT = os.path.join(TMP, "_cred", "sinopac_vault.json")
w.sinopac_vault.PFX = os.path.join(TMP, "_cred", "sinopac.pfx")
assert w.sinopac_vault.VAULT.startswith(TMP)


def _bind_store(api_key="k", secret="s"):
    """TMP bound the way the connect flow binds (runtime/sinopac_service.store): vault + sentinels."""
    sv = w.sinopac_vault
    os.makedirs(os.path.dirname(sv.VAULT), exist_ok=True)
    with open(sv.VAULT, "w") as f:
        json.dump({"sinopac_api_key": api_key, "sinopac_secret_key": secret, "sinopac_ca_passwd": "A123456789",
                   "sinopac_person_id": "A123456789", "live": False}, f)
    with open(os.path.join(TMP, ".env"), "w") as f:
        f.write("".join(f"{k}={v}\n" for k, v in sv.bound_env(api_key, secret).items()))
    open(w.WANTED_PATH, "w").close()  # the connect flow finished (runtime/sinopac_connect.run_finish)

for mod in (osj, w):
    mod.ORDERS_DIR = os.path.join(TMP, "state", "sinopac_orders")
    mod.REFRESH_FLAG = os.path.join(TMP, "state", "sinopac_refresh")
osj.WORKER_HEARTBEAT = w.HEARTBEAT_PATH = os.path.join(TMP, "state", "heartbeat", "sinopac_worker")
w.OUT_PATH = account_sinopac._SNAPSHOT = os.path.join(TMP, "state", "sinopac_account.json")
w.PROBE_PATH = os.path.join(TMP, "state", "sinopac_probe.json")
w.STOP_PATH = os.path.join(TMP, "state", "sinopac_login_stopped.json")
w.TAGS_PATH = os.path.join(TMP, "state", "sinopac_order_tags.json")
w.RETRY_PATH = os.path.join(TMP, "state", "sinopac_login_retry.json")
w.SIM_PATH = os.path.join(TMP, "state", "sinopac_sim_test.json")
w.WANTED_PATH = os.path.join(TMP, "state", "sinopac_worker_wanted.json")
_enabled_rel = os.path.relpath(w.ENABLED_PATH, w.WORKSPACE).replace(os.sep, "/")
w.ENABLED_PATH = os.path.join(TMP, "state", "sinopac_futures_enabled.json")
w.CONFIRM_POLL_S = 0.01
w.CONTRACTS_POLL_S = 0.01
from lib import sinopac_vault as vault  # noqa: E402
fresh_marker()
TPE = w.contracts.TAIPEI
from lib import tw_clock  # noqa: E402
real_entry_hold = tw_clock.entry_hold

# ── 0. the not-yet-verified gate ─────────────────────────────────────────────
check(not osj.FUTURES_VERIFIED and not w.VERIFIED and not account_sinopac.VERIFIED,
      "the shipped trait row keeps all three modules shut")
from lib import venue_traits  # noqa: E402
check(venue_traits.has("sinopac", "snapshot_settle_wait") and vault.ORDER_SETTLE_S >= 20
      and callable(vault.last_order_at),
      "snapshot_settle_wait: flatten finds lib.sinopac_vault's ORDER_SETTLE_S (>= 20 s) and last_order_at")
_measured = vault.ORDER_SETTLE_MEASURED_S
check("futures" not in venue_traits.verified_modes("sinopac")
      or (isinstance(_measured, (int, float)) and _measured > 0 and vault.ORDER_SETTLE_S >= 2 * _measured),
      "the gate flips only with 永豐's own fill → list_positions lag timed (audit M3): ORDER_SETTLE_S "
      "is at least twice ORDER_SETTLE_MEASURED_S", (vault.ORDER_SETTLE_S, _measured))
_src = open(os.path.join(ROOT, "lib", "order_sinopac.py"), encoding="utf-8").read()
_wsrc = open(os.path.join(ROOT, "lib", "sinopac_worker.py"), encoding="utf-8").read()
_login_src = _wsrc[_wsrc.index("def login("):]
import ast  # noqa: E402
_any_sdk = [n.lineno for n in ast.walk(ast.parse(_src))
            if (isinstance(n, ast.Import) and any(a.name.split(".")[0] == "shioaji" for a in n.names))
            or (isinstance(n, ast.ImportFrom) and (n.module or "").split(".")[0] == "shioaji")]
check(not _any_sdk and "shioaji" not in _src,
      "order_sinopac never imports shioaji (futures only: request files; the odd-lot session is gone)",
      _any_sdk)
_gone = [n for n in ("place_order_sinopac", "place_odd_lot_order", "get_sinopac_positions",
                     "get_account_balance", "confirm_order", "reset_connection", "_get_api")
         if hasattr(osj, n)]
check(not _gone, "the odd-lot stock path is removed from lib/order_sinopac (Wei 2026-11-17)", _gone)
check(-1 < _login_src.index("null_sdk_log()") < _login_src.index("import shioaji"),
      "shioaji's log file (opened at import, in the cwd = workspace) is forced to the null device "
      "before the worker's shioaji import")
os.environ["SJ_LOG_PATH"] = "shioaji.log"
w.null_sdk_log()
check(os.environ.get("SJ_LOG_PATH") == os.devnull, "…over a shell setting")
os.makedirs(os.path.dirname(w.HEARTBEAT_PATH), exist_ok=True)
open(w.HEARTBEAT_PATH, "w").close()
e = raises(osj.SinopacError, lambda: osj.place_futures_market_order({}, "TXF", "sell", 1, "reduce"))
check(e is not None and e.code == osj.UNVERIFIED and not os.path.isdir(w.ORDERS_DIR),
      "lib: unverified → refused before any request file", e)
holder["api"] = FakeApi()
real_ws = w.WORKSPACE
w.WORKSPACE = TMP
rc_daemon, rc_once = w.main(), w.run_once()
w.WORKSPACE = real_ws
check(rc_daemon == rc_once == w.UNVERIFIED_EXIT and "login" not in holder["api"].calls,
      "worker: unverified → daemon and --once exit without a login")
check(not os.path.exists(w.ENABLED_PATH), "…and leaves no futures-enabled marker")
w._write_snapshot({"ok": True, "equity": 1.0, "positions": []})
check(raises(RuntimeError, lambda: account_sinopac.get_equity({})) is not None,
      "sinopac_futures_account: unverified → a fresh snapshot is still not read")
os.remove(w.OUT_PATH)
os.remove(w.HEARTBEAT_PATH)
osj.FUTURES_VERIFIED = w.VERIFIED = account_sinopac.VERIFIED = True
# the session / clock gate is tested on its own (3b, 4b); everything else runs as in session
tw_clock.entry_hold = lambda now=None: None

# ── 1. contract pick ─────────────────────────────────────────────────────────
listed = {"TXF": ["TXFK6", "TXFL6"], "MXF": ["MXFK6"], "TMF": ["TMFK6"]}
now = datetime(2026, 10, 30, 10, 0, tzinfo=TPE)
check(w.pick_contract([], "TXF", "entry", "buy", 1, listed, now) == ("TXFK6", "Auto"),
      "entry, flat → computed near month (TXFK6 on 10-30), octype Auto")
check(w.pick_contract([{"root": "TXF", "productid": "TXFL6", "net": 2}], "TXF", "entry", "buy", 1,
                      listed, now, book_months=["2026-12"]) == ("TXFL6", "Auto"),
      "entry adds to the month the book holds")
e = raises(ValueError, lambda: w.pick_contract([], "TXF", "entry", "buy", 1, {"TXF": ["TXFL6"]}, now))
check(e and "not in the broker's list" in str(e), "entry to an unlisted month is refused", e)
two = [{"root": "TXF", "productid": "TXFK6", "net": 1}, {"root": "TXF", "productid": "TXFL6", "net": -1}]
both = ["2026-11", "2026-12"]
check(raises(ValueError, lambda: w.pick_contract(two, "TXF", "entry", "buy", 1, listed, now, book_months=both))
      is not None and raises(ValueError, lambda: w.pick_contract(two, "TXF", "reduce", "sell", 1, listed, now,
                                                                  book_months=both)) is not None,
      "the book holds the root in two months: entry and reduce both refused")
# the user's own other month (opened in the 永豐 app): never closed, added to or opened into, and it
# does not block the bot's month (audit M2)
check(w.pick_contract(two, "TXF", "reduce", "sell", 1, listed, now, book_months=["2026-11"]) == ("TXFK6", "Cover"),
      "user short TXFL6 beside the bot's long TXFK6: the bot's close goes to TXFK6")
check(w.pick_contract(two, "TXF", "entry", "buy", 1, listed, now, book_months=["2026-11"]) == ("TXFK6", "Auto"),
      "…and its entry adds to TXFK6, not the user's month")
user_only = [{"root": "TXF", "productid": "TXFL6", "net": -1}]
check(w.pick_contract(user_only, "TXF", "entry", "buy", 1, listed, now, book_months=[]) == ("TXFK6", "Auto"),
      "the book holds no TXF, the user holds TXFL6: the entry opens the near month, not the user's")
e = raises(ValueError, lambda: w.pick_contract(user_only, "TXF", "reduce", "buy", 1, listed, now, book_months=[]))
check(e is not None and "nothing to close" in str(e),
      "…and a close finds nothing of the bot's (the user's month is never closed)", e)
user_near = [{"root": "TXF", "productid": "TXFK6", "net": -1}]
e = raises(ValueError, lambda: w.pick_contract(user_near, "TXF", "entry", "buy", 1, listed, now, book_months=[]))
check(isinstance(e, w.UserRefusal) and "你在永豐 app 自己持有 TXFK6" in str(e) and "平掉那筆後" in str(e)
      and "/" not in str(e),
      "the user holds the near month itself: no entry into it (a buy would close the user's short); "
      "one Chinese sentence with the way out (audit S-A)", e)
_res = w.execute(FakeApi(positions=[(computed_near("TXF"), -1)]), types.SimpleNamespace(account_id="F0001"),
                 {"venue": "sinopac", "market": "futures", "symbol": "TXF", "action": "buy", "qty": 1,
                  "unit": "lots", "intent": "entry", "client_tag": None, "expires_at": time.time() + 5,
                  "book_months": []}, simulation=True)
check(_res["status"] == "rejected" and _res["error"].startswith("你在永豐 app") and "Error" not in _res["error"],
      "…answered without the exception name, for the order-failure card", _res)
_past = datetime(2026, 11, 19, 10, 0, tzinfo=TPE)  # TXFK6 settled 11-18; no broker list known
e = raises(w.contracts.ListUnknown, lambda: w.pick_contract([{"root": "TXF", "productid": "TXFK6", "net": 1}],
                                                             "TXF", "reduce", "sell", 1, {}, _past))
check(e is not None and str(e).startswith("永豐 ") and "統一" not in str(e),
      "an unknown settled month names 永豐, not 統一 (audit N-A)", e)
check(w.pick_contract(two, "TXF", "reduce", "sell", 1, listed, now) == ("TXFK6", "Cover")
      and w.pick_contract(user_only, "TXF", "entry", "buy", 1, listed, now) == ("TXFK6", "Auto"),
      "no book (None): the TAIFEX calendar decides — a far month is the user's, as the account lib reads it")
long2 = [{"root": "MXF", "productid": "MXFK6", "net": 2}]
check(w.pick_contract(long2, "MXF", "reduce", "sell", 2, listed, now) == ("MXFK6", "Cover"),
      "reduce of a long → the held month, Cover")
check(raises(ValueError, lambda: w.pick_contract(long2, "MXF", "reduce", "buy", 1, listed, now)) is not None,
      "a reduce that would add is refused")
check(raises(ValueError, lambda: w.pick_contract(long2, "MXF", "reduce", "sell", 3, listed, now)) is not None,
      "a reduce larger than the position is refused (no reversal)")
check(raises(ValueError, lambda: w.pick_contract([], "MXF", "reduce", "sell", 1, listed, now)) is not None,
      "a reduce with nothing held is refused")

# ── 2. position rows ─────────────────────────────────────────────────────────
api = FakeApi(extra=[("TXF", Base("TX2026110000"))],
              infos={"TX2026110000": types.SimpleNamespace(root="TXF", delivery_date=None,
                                                           delivery_month="202611")})
row = lambda code, n: types.SimpleNamespace(code=code, direction=sj.Action.Buy if n > 0 else sj.Action.Sell,
                                            quantity=abs(n), price=1.0, pnl=0.0)
r = w.position_row(api, row("TMFK6", -3))
check(r["productid"] == "TMFK6" and r["root"] == "TMF" and r["net"] == -3, "month code read as is, short = negative", r)
r = w.position_row(api, row("TX2026110000", 1))
check(r and r["productid"] == "TXFK6",
      "other code → contracts v2 base, info(base) root + delivery month (the base has no date)", r)
check(raises(RuntimeError, lambda: w.position_row(api, row("TXF999", 1))) is not None,
      "unreadable TXF-looking code fails the read")
check(w.position_row(api, row("2330", 1)) is None, "a non-index product is left out")

# ── 2b. contracts v2: month codes, R1/R2, delivery_date, the background load ─
import datetime as _dt  # noqa: E402
# the TMF list M0-b read on 2026-11-16, with the delivery dates' text and date shapes mixed
m0b = [Base("TMFR1"), Base("TMFR2"), Base("TMFK6", "2026/11/18"), Base("TMFL6", "2026-12-16"),
       Base("TMFA7", _dt.date(2027, 1, 20)), Base("TMFC7", "20270317"), Base("TMFF7"),
       Base("TMFI7", _dt.date(2027, 9, 15))]
api = FakeApi(infos={"TMFF7": types.SimpleNamespace(root="TMF", delivery_date=_dt.date(2027, 6, 16),
                                                    delivery_month="202706")})
api.contracts.by_root["TMF"] = m0b
lst = w.listed_contracts(api)
check(lst["TMF"] == sorted(["TMFK6", "TMFL6", "TMFA7", "TMFC7", "TMFF7", "TMFI7"])
      and api.contracts.info_calls == 1,
      "M0-b's TMF list: six month codes (root + month letter + year digit), R1/R2 dropped; "
      "info(base) only for the one base without delivery_date", (lst["TMF"], api.contracts.info_calls))
check([w.contracts.prod_id("TMF", y, m) for y, m in
       ((2026, 11), (2026, 12), (2027, 1), (2027, 3), (2027, 6), (2027, 9))]
      == ["TMFK6", "TMFL6", "TMFA7", "TMFC7", "TMFF7", "TMFI7"]
      and [w.contracts.month_of(c, datetime(2026, 11, 16, tzinfo=TPE)) for c in ("TMFK6", "TMFA7", "TMFI7")]
      == [(2026, 11), (2027, 1), (2027, 9)],
      "president_contracts reads and writes the month codes exactly as M0-b listed them")
check([w._year_month(x) for x in ("2026/1/20", "2027-1-20", "2026/11/18", "20270120", "202701",
                                  "2027-01-20T00:00:00", _dt.datetime(2027, 1, 20, 13, 30), "", None, "1/20")]
      == [(2026, 1), (2027, 1), (2026, 11), (2027, 1), (2027, 1), (2027, 1), (2027, 1), None, None, None],
      "delivery dates: unpadded text is split on its separators (2026/1/20 is January, not December)")
api.contracts.by_root["TMF"] = [Base("TMFK6", "2026/12/16")]
check(raises(RuntimeError, lambda: w.listed_contracts(api)) is not None,
      "a month code whose delivery_date says another month fails the read (no trading on a wrong calendar)")
check(raises(ValueError, lambda: w.contract_for(FakeApi(), "TMFR1")) is not None
      and w.contract_for(FakeApi(), "TMFK6").code == "TMFK6",
      "the order goes to the listed month base; a continuous R1 is never an order contract")
api = FakeApi(not_ready=3)
check(w.wait_contracts(api, wait_s=5) is True and api.contracts.polls >= 4,
      "wait_contracts polls through the background load (futures() raising) until the list answers")
api = FakeApi(not_ready=10 ** 6)
t0 = time.time()
check(w.wait_contracts(api, wait_s=0.1) is False and time.time() - t0 < 2,
      "wait_contracts gives up past its bound (no unbounded wait)")
api = FakeApi(not_ready=10 ** 6)
check(raises(Exception, lambda: w.read_account(api, types.SimpleNamespace(account_id="F0001"))) is not None,
      "a read while the list is still loading fails (retried next tick), never an empty list")

# ── 3. execute ───────────────────────────────────────────────────────────────
def req(intent="entry", action="buy", qty=1, tag=None, symbol="TXF", ttl=5):
    return {"venue": "sinopac", "market": "futures", "symbol": symbol, "action": action, "qty": qty,
            "unit": "lots", "intent": intent, "client_tag": tag, "expires_at": time.time() + ttl}


acct = types.SimpleNamespace(account_id="F0001")
api = FakeApi(fill=("Filled", [(1, 23000.0), (1, 23010.0)]))
res = w.execute(api, acct, req(qty=2), simulation=True)
po = [c for c in api.calls if isinstance(c, tuple)]
o = po[0][2] if po else None
check(res["status"] == "filled" and res["fill_qty"] == 2.0 and abs(res["avg_fill_price"] - 23005.0) < 1e-9,
      "filled: qty and VWAP from deals", res)
check(o is not None and o.price_type.value == "MKT" and o.time_in_force.value == "IOC"
      and o.octype.value == "Auto" and o.action.value == "Buy" and o.quantity == 2,
      "market IOC, octype Auto, Buy, 2 lots")
api = FakeApi(fill=("Failed", []))
res = w.execute(api, acct, req(), simulation=True)
check(res["status"] == "rejected" and "rejected by test" in res["error"], "Failed → rejected with the broker msg", res)
api = FakeApi(place_raises=TimeoutError("A123456789 timed out"))
res = w.execute(api, acct, req(), simulation=True)
check(res["status"] == "unknown" and "A123456789" not in res["error"],
      "place_order raising → unknown (may have been sent), national id masked", res)
os.makedirs(os.path.dirname(w.HEARTBEAT_PATH), exist_ok=True)
open(w.HEARTBEAT_PATH, "w").close()
os.utime(w.HEARTBEAT_PATH, (time.time() - 100, time.time() - 100))
api = FakeApi(fill=("PendingSubmit", []))
res = w.execute(api, acct, req(), simulation=True, timeout=0.05)
check(res["status"] == "sent" and time.time() - os.path.getmtime(w.HEARTBEAT_PATH) < 5,
      "a confirm still waiting at the deadline → sent, and the heartbeat kept fresh meanwhile", res)
api = FakeApi(fill=("Cancelled", []))
res = w.execute(api, acct, req(), simulation=True)
check(res["status"] == "sent" and res["fill_qty"] == 0.0
      and len([c for c in api.calls if isinstance(c, tuple)]) == 1,
      "IOC not taken (Cancelled, no deals) → sent, no MKP retry", res)

# MKP fallback: once, only after a Failed MKT with no fill
api = FakeApi(fill=[("Failed", []), ("Filled", [(1, 23001.0)])])
res = w.execute(api, acct, req(), simulation=True)
po = [c for c in api.calls if isinstance(c, tuple)]
check(res["status"] == "filled" and res["price_type"] == "MKP" and len(po) == 2
      and [c[2].price_type.value for c in po] == ["MKT", "MKP"]
      and all(c[2].time_in_force.value == "IOC" for c in po),
      "Failed MKT, no fill → sent once more as MKP IOC, and the response says MKP", res)
api = FakeApi(fill=[("Failed", []), ("Failed", [])])
res = w.execute(api, acct, req(), simulation=True)
check(res["status"] == "rejected" and len([c for c in api.calls if isinstance(c, tuple)]) == 2,
      "MKP refused too → rejected after exactly two sends", res)
api = FakeApi(fill=[("Failed", [(1, 23000.0)]), ("Filled", [(1, 23001.0)])])
res = w.execute(api, acct, req(), simulation=True)
check(len([c for c in api.calls if isinstance(c, tuple)]) == 1 and res["fill_qty"] == 1.0,
      "a Failed MKT that carries a fill is never resent", res)
api = FakeApi(place_raises=TimeoutError("timed out"))
res = w.execute(api, acct, req(), simulation=True)
check(res["status"] == "unknown" and len([c for c in api.calls if isinstance(c, tuple)]) == 1,
      "an unknown MKT outcome is never resent as MKP", res)
api = FakeApi(fill=("Filled", [(1, 23000.0)]))
res = w.execute(api, acct, req(), simulation=True)
check(res["price_type"] == "MKT", "a filled MKT reports price_type MKT", res)

# 3b. the TAIFEX entry gate at send time (lib/tw_clock.entry_hold)
for hold, label in (({"why": "session", "until": time.time() + 600}, "outside the regular session"),
                    ({"why": "clock", "skew": 240.0}, "clock off past SKEW_BLOCK_S")):
    tw_clock.entry_hold = lambda now=None, h=hold: h
    api = FakeApi(positions=[("TXFK6", 1)])
    res_e = w.execute(api, acct, req(), simulation=True)
    res_r = w.execute(api, acct, req("reduce", "sell"), simulation=True)
    po = [c for c in api.calls if isinstance(c, tuple)]
    check(res_e["status"] == "rejected" and "entry held" in res_e["error"] and res_r["status"] == "filled"
          and len(po) == 1 and po[0][2].action.value == "Sell",
          f"worker, {label}: the entry is refused before place_order, a reduce still goes", (res_e, res_r))
tw_clock.entry_hold = lambda now=None: None

open("state/HALT", "w").write("test")
api = FakeApi(positions=[("TXFK6", 1)])
res = w.execute(api, acct, req(), simulation=True)
check(res["status"] == "rejected" and not any(isinstance(c, tuple) for c in api.calls),
      "HALT: entry refused before place_order")
res = w.execute(api, acct, req("reduce", "sell"), simulation=True)
check(res["status"] == "rejected" and not any(isinstance(c, tuple) for c in api.calls),
      "HALT: a reduce without the user's close pass is refused before place_order", res)
res = w.execute(api, acct, dict(req("reduce", "sell"), halt_close_pass=True), simulation=True)
check(res["status"] == "filled", "HALT: a reduce carrying the user's close pass goes", res)
res = w.execute(FakeApi(), acct, dict(req(), halt_close_pass=True), simulation=True)
check(res["status"] == "rejected", "HALT: the close pass never lets an entry through", res)
check(not guard.halt_closes_allowed(), "the worker's close pass ends with the request")
os.remove("state/HALT")

open(guard.RESTART_STOP_PATH, "w").write("{}")
for intent, action in (("entry", "buy"), ("reduce", "sell")):
    api = FakeApi(positions=[("TXFK6", 1)])
    res = w.execute(api, acct, req(intent, action), simulation=True)
    check(res["status"] == "rejected" and not any(isinstance(c, tuple) for c in api.calls),
          f"restart record: {intent} refused before place_order")
# the user's 暫停並關閉部位 after a restart (audit M1): flatten claimed the close-all pass in its own
# process, the request carries it — the worker sends that reduce and nothing else
api = FakeApi(positions=[("TXFK6", 1)])
res = w.execute(api, acct, dict(req("reduce", "sell"), close_all_pass=True), simulation=True)
check(res["status"] == "filled", "restart record: a reduce carrying the user's close-all pass goes", res)
api = FakeApi(positions=[("TXFK6", 1)])
res = w.execute(api, acct, dict(req(), close_all_pass=True), simulation=True)
check(res["status"] == "rejected" and not any(isinstance(c, tuple) for c in api.calls),
      "restart record: the close-all pass never lets an entry through", res)
api = FakeApi(positions=[("TXFK6", 1)])
res = w.execute(api, acct, req("reduce", "sell"), simulation=True)
check(res["status"] == "rejected" and not any(isinstance(c, tuple) for c in api.calls)
      and not guard._close_all_granted,
      "…and it ends with that request: the next reduce without it is refused again", res)
api = FakeApi(positions=[("TXFK6", 1)])
res = w.execute(api, acct, dict(req("reduce", "sell"), close_all_pass="yes"), simulation=True)
check(res["status"] == "rejected", "only a literal true counts as the pass", res)
open("state/HALT", "w").write("test")
api = FakeApi(positions=[("TXFK6", 1)])
res = w.execute(api, acct, dict(req("reduce", "sell"), close_all_pass=True), simulation=True)
check(res["status"] == "rejected", "restart record + HALT: the close-all pass alone does not pass the freeze", res)
api = FakeApi(positions=[("TXFK6", 1)])
res = w.execute(api, acct, dict(req("reduce", "sell"), close_all_pass=True, halt_close_pass=True),
                simulation=True)
check(res["status"] == "filled" and not guard.halt_closes_allowed(),
      "restart record + HALT: a reduce carrying both of flatten's passes goes, both closed after", res)
os.remove("state/HALT")
os.remove(guard.RESTART_STOP_PATH)

# audit M5: guard.check_restart_stop lets a cancel through and the HALT freeze a missing intent; the
# worker takes only the exact values lib/order_sinopac writes, before any gate reads them
_bad = {"cancel": dict(req(), intent="cancel"), "no intent": {k: v for k, v in req().items() if k != "intent"},
        "unknown intent": dict(req(), intent="flip"), "action": dict(req(), action="cover"),
        "symbol": dict(req(), symbol="TXFK6"), "qty 0": dict(req(), qty=0), "qty text": dict(req(), qty="1"),
        "qty bool": dict(req(), qty=True), "qty float": dict(req(), qty=1.5)}
for state in ("HALT", "restart record", "nothing"):
    if state == "HALT":
        open("state/HALT", "w").write("test")
    elif state == "restart record":
        open(guard.RESTART_STOP_PATH, "w").write("{}")
    for label, bad in _bad.items():
        api = FakeApi(positions=[("TXFK6", 1)])
        res = w.execute(api, acct, dict(bad, close_all_pass=True, halt_close_pass=True), simulation=True)
        check(res["status"] == "rejected" and not any(isinstance(c, tuple) for c in api.calls)
              and res["error"].endswith("— not sent"),
              f"{state}: a request with a bad {label} is refused before any gate or read (audit M5)", res)
    for p in ("state/HALT", guard.RESTART_STOP_PATH):
        if os.path.exists(p):
            os.remove(p)

api = FakeApi()
first = w.execute(api, acct, req(tag="abc1"), simulation=True)
fresh_marker()  # the tag book, not the settle window, is under test
second = w.execute(api, acct, req(tag="abc1"), simulation=True)
check(first["status"] == "filled" and second["status"] == "rejected"
      and len([c for c in api.calls if isinstance(c, tuple)]) == 1,
      "client_tag refused the second time today", second)
api = FakeApi()
res = w.execute(api, acct, req(ttl=-1), simulation=True)
check(res["status"] == "rejected" and not any(isinstance(c, tuple) for c in api.calls),
      "an expired request is refused")

# the user's own other month in the account, the book's months in the request (audit M2)
from lib.president_contracts import month_of, ym  # noqa: E402
near = computed_near("TXF")
other = next(c for c in ("TXFK6", "TXFL6") if c != near)
near_ym = ym(*month_of(near))
api = FakeApi(positions=[(near, 1), (other, -1)])
res = w.execute(api, acct, dict(req("reduce", "sell"), book_months=[near_ym]), simulation=True)
po = [c for c in api.calls if isinstance(c, tuple)]
check(res["status"] == "filled" and len(po) == 1 and po[0][1] == near and po[0][2].octype.value == "Cover",
      f"worker: the user's {other} beside the bot's {near} — the bot's close goes to {near}", (res, po))
api = FakeApi(positions=[(other, -1)])
res = w.execute(api, acct, dict(req(), book_months=[]), simulation=True)
po = [c for c in api.calls if isinstance(c, tuple)]
check(res["status"] == "filled" and len(po) == 1 and po[0][1] == near,
      f"worker: the book holds no TXF, the user holds {other} — the entry opens {near}", (res, po))
api = FakeApi(positions=[(other, -1)])
res = w.execute(api, acct, dict(req("reduce", "buy"), book_months=[]), simulation=True)
check(res["status"] == "rejected" and not any(isinstance(c, tuple) for c in api.calls),
      f"worker: a close never reaches the user's {other}", res)
api = FakeApi(positions=[(near, -1)])
res = w.execute(api, acct, dict(req(), book_months=[]), simulation=True)
check(res["status"] == "rejected" and not any(isinstance(c, tuple) for c in api.calls),
      f"worker: the user holds {near} itself — the entry is refused, never opened into it", res)
api = FakeApi(positions=[(near, 1)])
res = w.execute(api, acct, dict(req("reduce", "sell"), book_months=near_ym), simulation=True)
check(res["status"] == "rejected" and not any(isinstance(c, tuple) for c in api.calls),
      "worker: book_months that is not a list is refused", res)

# 3c. position lag (M0-b: list_positions right after a Filled order still read [])
api = FakeApi(lag_s=3600)  # the broker's position read never catches up inside this case
seen_marker = []
real_place = api.place_order
api.place_order = lambda c, o: seen_marker.append(vault.last_order_at()) or real_place(c, o)
t0 = time.time()
res = w.execute(api, acct, req(ttl=30), simulation=True)
check(res["status"] == "filled" and seen_marker and seen_marker[0] >= t0,
      "every send writes the last-order marker before place_order", seen_marker)
check(api.list_positions(acct) == [] and api.positions,
      "the fake lags like M0-b: the fill is held, list_positions still reads []")
res = w.execute(api, acct, req("reduce", "sell", ttl=5), simulation=True)
check(res["status"] == "deferred" and len([c for c in api.calls if isinstance(c, tuple)]) == 1,
      "a close right after the fill (too little time to wait out ORDER_SETTLE_S) → deferred, not "
      "'nothing to close', nothing sent", res)
snap = w.read_account(api, acct)
w._write_snapshot(snap)
check(snap["positions"] == [], "the worker's own read inside the window is empty (the lag)")
e = raises(account_sinopac.SnapshotLag, lambda: account_sinopac.get_positions({}))
check(e is not None and account_sinopac.classify(e) == __import__("lib.venue_errors").venue_errors.TRANSIENT,
      "sinopac_futures_account: that empty read is SnapshotLag (TRANSIENT, skip the round), never flat", e)
real_q = account_sinopac.get_query_started_at
account_sinopac.get_query_started_at = lambda: time.time() + 3600  # a newer file, read a second time
e2 = raises(account_sinopac.SnapshotLag, lambda: account_sinopac.get_positions({}))
account_sinopac.get_query_started_at = real_q
check(e2 is not None, "the settle check judges the snapshot it returns, not a second read of the file")
check(raises(account_sinopac.SnapshotLag, lambda: account_sinopac.bot_position_rows()) is not None
      and raises(account_sinopac.SnapshotLag, lambda: account_sinopac.position_rows()) is not None,
      "every position read refuses the unsettled snapshot")
check(w._settled_read_at() >= vault.last_order_at() + vault.ORDER_SETTLE_S - 1e-6,
      "the daemon's re-read after a send starts ORDER_SETTLE_S after it")

# the wait path, scaled: settle 0.4 s, broker lag 0.25 s, a request with time to spare
saved_settle = vault.ORDER_SETTLE_S
vault.ORDER_SETTLE_S, w.SEND_MARGIN_S = 0.4, 0.2
api = FakeApi(lag_s=0.25)
res_in = w.execute(api, acct, req(ttl=5), simulation=True)
sent_at = vault.last_order_at()
reads = []
real_read = w.read_account
w.read_account = lambda a, ac: reads.append(time.time()) or real_read(a, ac)
res_out = w.execute(api, acct, req("reduce", "sell", ttl=5), simulation=True)
w.read_account = real_read
po = [c for c in api.calls if isinstance(c, tuple)]
check(res_in["status"] == "filled" and res_out["status"] == "filled" and len(po) == 2
      and po[1][2].octype.value == "Cover" and reads and reads[0] >= sent_at + vault.ORDER_SETTLE_S,
      "with time left the close waits out the window: its read starts ORDER_SETTLE_S after the "
      "entry, sees the lot and closes it (Cover)", (res_out, reads[:1], sent_at))
time.sleep(vault.ORDER_SETTLE_S)
w._write_snapshot(w.read_account(api, acct))
check(account_sinopac.get_positions({}) == {},
      "a read started after the window: flat is flat")
vault.ORDER_SETTLE_S, w.SEND_MARGIN_S = saved_settle, 5.0
fresh_marker()
with open(vault.LAST_ORDER_PATH, "w") as f:
    f.write("not a number")
check(abs(vault.last_order_at() - os.path.getmtime(vault.LAST_ORDER_PATH)) < 1e-6,
      "a broken marker counts as a send at its mtime (fails closed, expires one window later)")
api = FakeApi()
real_mark = vault.mark_order_sent


def _disk_full():
    raise OSError(28, "No space left on device")


vault.mark_order_sent = _disk_full
res = w.execute(api, acct, req(), simulation=True)
vault.mark_order_sent = real_mark
check(res["status"] == "rejected" and "marker" in res["error"]
      and not any(isinstance(c, tuple) for c in api.calls),
      "the last-order marker cannot be written → nothing sent (a send the reads cannot see)", res)

# ── 4. relay ─────────────────────────────────────────────────────────────────
if os.path.exists(w.HEARTBEAT_PATH):
    os.remove(w.HEARTBEAT_PATH)
e = raises(osj.WorkerUnavailable, lambda: osj.place_futures_market_order({}, "TXF", "buy", 1, "entry"))
check(e is not None and not (os.path.isdir(w.ORDERS_DIR) and os.listdir(w.ORDERS_DIR)),
      "no heartbeat → WorkerUnavailable, no request file written")

os.makedirs(os.path.dirname(w.HEARTBEAT_PATH), exist_ok=True)
open(w.HEARTBEAT_PATH, "w").close()


def pending():
    return [n for n in os.listdir(w.ORDERS_DIR) if n.endswith(".req.json")] if os.path.isdir(w.ORDERS_DIR) else []


open(guard.RESTART_STOP_PATH, "w").write("{}")
for intent, action in (("entry", "buy"), ("reduce", "sell")):
    e = raises(guard.Halted, lambda: osj.place_futures_market_order({}, "TXF", action, 1, intent))
    check(e is not None and not pending(), f"lib: restart record → {intent} refused before any request file")
os.remove(guard.RESTART_STOP_PATH)
open("state/HALT", "w").write("test")
e = raises(guard.Halted, lambda: osj.place_futures_market_order({}, "TXF", "buy", 1, "entry"))
check(e is not None and not pending(), "lib: HALT → entry refused before any request file")
e = raises(guard.Halted, lambda: osj.place_futures_market_order({}, "TXF", "sell", 1, "reduce"))
check(e is not None and not pending(), "lib: HALT → a reduce outside the user's close is refused too")
written = []
real_write, real_await0 = osj._write_request, osj._await_response
osj._write_request = lambda r: written.append(r) or real_write(r)
osj._await_response = lambda rid, timeout: real_await0(rid, 0.3)
with guard.halt_close_pass("TXF", "test"):
    e = raises(osj.WorkerUnavailable, lambda: osj.place_futures_market_order({}, "TXF", "sell", 1, "reduce"))
osj._write_request, osj._await_response = real_write, real_await0
check(e is not None and written and written[0]["halt_close_pass"] is True,
      "lib: HALT + the user's close pass → the reduce is handed over carrying the pass", written)
os.remove("state/HALT")
written = []
osj._write_request = lambda r: written.append(r) or real_write(r)
osj._await_response = lambda rid, timeout: real_await0(rid, 0.3)
raises(osj.WorkerUnavailable, lambda: osj.place_futures_market_order({}, "TXF", "sell", 1, "reduce"))
open(guard.RESTART_STOP_PATH, "w").write("{}")
guard._close_all_granted = True  # what flatten's claim_close_all_pass leaves in its process
for intent, action in (("reduce", "sell"), ("entry", "buy")):
    raises(Exception, lambda: osj.place_futures_market_order({}, "TXF", action, 1, intent,
                                                             book_months={"2026-12", "2026-11"}))
guard._close_all_granted = False
os.remove(guard.RESTART_STOP_PATH)
osj._write_request, osj._await_response = real_write, real_await0
check([r["close_all_pass"] for r in written] == [False, True]
      and [r["intent"] for r in written] == ["reduce", "reduce"],
      "lib: the request says close_all_pass only for a reduce from a process holding the pass "
      "(an entry with it is still refused before any request file)", written)
check(written[0]["book_months"] is None and written[1]["book_months"] == ["2026-11", "2026-12"]
      and json.loads(json.dumps(written[1]))["book_months"] == ["2026-11", "2026-12"],
      "lib: book_months travels as a sorted list; None (no book) stays None", written)

# 4b. the TAIFEX entry gate before the request file
tw_clock.entry_hold = lambda now=None: {"why": "clock", "skew": -300.0}
e = raises(osj.SessionClosed, lambda: osj.place_futures_market_order({}, "TXF", "buy", 1, "entry"))
check(e is not None and e.code == "clock" and not pending(), "lib: clock off → entry refused before any request file", e)
written = []
osj._write_request = lambda r: written.append(r) or real_write(r)
osj._await_response = lambda rid, timeout: real_await0(rid, 0.3)
e = raises(osj.WorkerUnavailable, lambda: osj.place_futures_market_order({}, "TXF", "sell", 1, "reduce"))
osj._write_request, osj._await_response = real_write, real_await0
check(e is not None and written and written[0]["intent"] == "reduce",
      "lib: the entry gate never holds a reduce (handed to the worker)", written)
tw_clock.entry_hold = lambda now=None: None

open(w.HEARTBEAT_PATH, "w").close()
api = FakeApi()
stop = threading.Event()


def serve():
    while not stop.is_set():
        w.serve_requests(api, acct, True)
        time.sleep(0.02)


th = threading.Thread(target=serve, daemon=True)
th.start()
res = osj.place_futures_market_order({}, "txf", "buy", 1, "entry", client_tag="r1", confirm_timeout=5)
check(res["status"] == "filled" and res["symbol"] == computed_near("TXF"),
      "relay round trip: filled through the worker, today's near month", res)
check(api.calls.count("login") == 0, "the requester never logs in (the worker's session is used)")
api.positions = [(res["symbol"], 1)]
e = raises(osj.SnapshotNotSettled,
           lambda: osj.place_futures_market_order({}, "TXF", "sell", 1, "reduce", confirm_timeout=5))
check(e is not None and len([c for c in api.calls if isinstance(c, tuple)]) == 1,
      "relay: a close right after the entry → SnapshotNotSettled (nothing sent), not '永豐 refused'", e)
with open(vault.LAST_ORDER_PATH, "w") as f:  # the entry, ORDER_SETTLE_S + 5 s ago
    f.write(repr(time.time() - vault.ORDER_SETTLE_S - 5))
vault._last_order_mem = 0.0
cl = osj.close_position_partial({}, "TXF", "long", 1, client_order_id="a-very-long-client-order-id")
check(cl["status"] == "filled" and cl["exchange"] == "sinopac" and cl["executed_qty"] == 1.0,
      "close_position_partial: reduce through the worker", cl)
stop.set()
th.join(2)
left = [n for n in os.listdir(w.ORDERS_DIR) if n.endswith((".resp.json", ".taken"))]
check(not left, "an answered request leaves no answer or taken file behind (audit N1)", left)
for n, age in (("old.resp.json", 2 * 86400), ("old.cancelled", 2 * 86400), (".old.tmp", 2 * 86400),
               ("new.resp.json", 60)):
    path = os.path.join(w.ORDERS_DIR, n)
    open(path, "w").close()
    os.utime(path, (time.time() - age, time.time() - age))
w._sweep_orders()
check(sorted(set(os.listdir(w.ORDERS_DIR)) & {"old.resp.json", "old.cancelled", ".old.tmp", "new.resp.json"})
      == ["new.resp.json"],
      "the worker's start sweeps what a dead requester left, older than a day only", os.listdir(w.ORDERS_DIR))
os.remove(os.path.join(w.ORDERS_DIR, "new.resp.json"))
# Windows: a reader holding the answer's target makes the replace fail — the worker stays up (audit M4)
real_aw = w._atomic_write


def _busy(path, payload):
    if path.endswith(".resp.json"):
        raise PermissionError(13, "in use")
    return real_aw(path, payload)


w._atomic_write = _busy
with open(os.path.join(w.ORDERS_DIR, "busy.req.json"), "w") as f:
    json.dump(dict(req(ttl=-1), id="busy"), f)
served = raises(Exception, lambda: w.serve_requests(FakeApi(), acct, True))
w._atomic_write = real_aw
check(served is None and os.path.exists(os.path.join(w.ORDERS_DIR, "busy.taken")),
      "an answer that cannot be written: logged, the worker keeps serving (the requester parks it)", served)
os.remove(os.path.join(w.ORDERS_DIR, "busy.taken"))

real_await = osj._await_response
osj._await_response = lambda rid, timeout: real_await(rid, 0.3)
open(w.HEARTBEAT_PATH, "w").close()
osj_timeout_req = raises(osj.WorkerUnavailable,
                         lambda: osj.place_futures_market_order({}, "TXF", "buy", 1, "entry"))
left = [n for n in os.listdir(w.ORDERS_DIR) if n.endswith(".req.json")]
check(osj_timeout_req is not None and not left, "nobody takes it → cancelled, nothing pending", left)


def take_without_answer():
    for _ in range(200):
        for n in os.listdir(w.ORDERS_DIR):
            if n.endswith(".req.json"):
                b = os.path.join(w.ORDERS_DIR, n[:-len(".req.json")])
                os.rename(b + ".req.json", b + ".taken")
                return
        time.sleep(0.01)


th = threading.Thread(target=take_without_answer, daemon=True)
th.start()
open(w.HEARTBEAT_PATH, "w").close()
e = raises(osj.OrderNotConfirmed, lambda: osj.place_futures_market_order({}, "TXF", "buy", 1, "entry"))
osj._await_response = real_await
th.join(2)
check(e is not None, "taken but unanswered → OrderNotConfirmed (may have been sent)", e)
check(raises(ValueError, lambda: osj.place_futures_market_order({}, "TXFK6", "buy", 1, "entry")) is not None
      and raises(ValueError, lambda: osj.place_futures_market_order({}, "TXF", "buy", 1, "open")) is not None,
      "a month code or an unknown intent is refused before anything is written")

# ── 5. login ─────────────────────────────────────────────────────────────────
holder["api"] = FakeApi()
api_, a = w.login({"sinopac_api_key": "k", "sinopac_secret_key": "s", "sinopac_ca_path": "/c.pfx",
                   "sinopac_ca_passwd": "p", "sinopac_person_id": "", "live": True})
check(holder["api"].calls[:2] == ["login", "activate_ca"], "live: CA activated after login",
      holder["api"].calls)
check("fetch_contracts" not in holder["api"].calls and holder["api"].login_kw.get("subscribe_trade") is True
      and "fetch_contract" not in holder["api"].login_kw,
      "login: never fetch_contracts (M0-b: it raises exclusive access lost while the SDK's own load "
      "runs), subscribe_trade passed explicitly at the SDK default", (holder["api"].calls, holder["api"].login_kw))
holder["api"] = FakeApi(not_ready=5)
api_, a = w.login({"sinopac_api_key": "k", "sinopac_secret_key": "s", "sinopac_ca_path": "",
                   "sinopac_ca_passwd": "", "sinopac_person_id": "", "live": False})
check(api_.contracts.polls >= 6 and not holder["api"].logged_out,
      "login waits (bounded) for the background contract load before the first read")
saved_wait = w.CONTRACTS_WAIT_S
w.CONTRACTS_WAIT_S = 0.05
holder["api"] = FakeApi(not_ready=10 ** 6)
api_, a = w.login({"sinopac_api_key": "k", "sinopac_secret_key": "s", "sinopac_ca_path": "",
                   "sinopac_ca_passwd": "", "sinopac_person_id": "", "live": False})
w.CONTRACTS_WAIT_S = saved_wait
check(a is not None and not holder["api"].logged_out,
      "a list still loading past the wait is not a failed login (no STOP, no P1): reads retry")
check(a.account_id == "F0002", "the futures account is the login's AccountType.Future row", a)
sj.__version__ = "1.7.10"
holder["api"] = FakeApi()
e = raises(w.LoginError, lambda: w.login({"sinopac_api_key": "k", "sinopac_secret_key": "s",
                                          "sinopac_ca_path": "", "sinopac_ca_passwd": "",
                                          "sinopac_person_id": "", "live": False}))
sj.__version__ = "1.7.11"
check(e is not None and "1.7.11" in str(e) and holder["api"].calls == [],
      "another shioaji version → LoginError before any login", e)
holder["api"] = FakeApi(ca_ok=False)
e = raises(w.LoginError, lambda: w.login({"sinopac_api_key": "k", "sinopac_secret_key": "s",
                                          "sinopac_ca_path": "/c.pfx", "sinopac_ca_passwd": "p",
                                          "sinopac_person_id": "", "live": True}))
check(e is not None and e.reason == "CERT" and holder["api"].logged_out,
      "CA refused → LoginError class CERT, logged out", e)
holder["api"] = FakeApi()
w.login({"sinopac_api_key": "k", "sinopac_secret_key": "s", "sinopac_ca_path": "", "sinopac_ca_passwd": "",
         "sinopac_person_id": "", "live": False})
check("activate_ca" not in holder["api"].calls, "simulation: no CA activation")
holder["api"] = FakeApi(futopt=False)
e = raises(w.LoginError, lambda: w.login({"sinopac_api_key": "k", "sinopac_secret_key": "s",
                                          "sinopac_ca_path": "", "sinopac_ca_passwd": "",
                                          "sinopac_person_id": "", "live": False}))
check(e is not None and holder["api"].logged_out, "no futures account → LoginError, logged out")
_bind_store()
_bound = w._read_env(os.path.join(TMP, ".env"))
# audit r2 S1: an old 零股 machine's leftover line neither switches anything nor dead-ends the connect
check(w.sinopac_vault.resolve(dict(_bound, SINOPAC_LIVE="true"))["live"] is False
      and w.sinopac_vault.resolve(dict(_bound, SINOPAC_LIVE="false")) == w.sinopac_vault.resolve(_bound)
      and isinstance(raises(Exception, lambda: w.sinopac_vault.resolve({"sinopac_api_key": "k",
                                                                         "sinopac_secret_key": "s"})),
                     w.sinopac_vault.NotBound),
      "production is the store's, never .env's (a leftover SINOPAC_LIVE line is ignored, either way); plain "
      ".env values are not a binding")
open(w.STOP_PATH, "w").write("{}")
holder["api"] = FakeApi()
real_ws = w.WORKSPACE
w.WORKSPACE = TMP
rc = w.main()
w.WORKSPACE = real_ws
check(rc == w.LOGIN_STOPPED_EXIT and "login" not in holder["api"].calls,
      "STOP record: the daemon exits without logging in")
from lib import venue_traits as _vt  # noqa: E402
check(os.path.exists(w.ENABLED_PATH) and _enabled_rel == _vt.get("sinopac", "bound_marker"),
      "a daemon start past the gate writes the durable futures-enabled marker, at venue_traits' "
      "bound_marker path (Wei 11-17: a machine that has had futures is never dormant again)", _enabled_rel)
os.remove(w.STOP_PATH)
# audit F4: the marker is what flatten / the account reader go by — one that cannot be written means
# no login (the reconciler would trade a venue a close-all skips); a later start tries again
_ep = w.ENABLED_PATH
w.ENABLED_PATH = os.path.join(w.STOP_PATH + ".file", "sinopac_futures_enabled.json")
open(w.STOP_PATH + ".file", "w").close()  # a file where the marker's folder should be
holder["api"] = FakeApi()
w.WORKSPACE = TMP
try:
    rc = w.main()
except SystemExit as x:  # past the marker the daemon would go on to log in or stop
    rc = x.code
rc_once = w.run_once()
w.WORKSPACE = real_ws
check(rc == rc_once == w.STATE_EXIT and "login" not in holder["api"].calls,
      "audit F4: futures-enabled marker not writable → daemon and --once exit STATE_EXIT without a login",
      (rc, rc_once, holder["api"].calls))
os.remove(w.STOP_PATH + ".file")
w.ENABLED_PATH = _ep

# item 3 (Wei 11-17): the worker logs in only with a connect-flow binding — plain .env values (a 零股
# bind, or keys the agent wrote) start nothing: no login, no STOP, no futures-enabled marker, no notice
_ep = w.ENABLED_PATH
w.ENABLED_PATH = os.path.join(TMP, "state", "enabled-plain-check.json")
with open(os.path.join(TMP, ".env"), "w") as f:
    f.write("sinopac_api_key=k\nsinopac_secret_key=s\nsinopac_person_id=A123456789\nSINOPAC_LIVE=true\n")
holder["api"] = FakeApi()
w.WORKSPACE = TMP
rc, rc_once = w.main(), w.run_once()
w.WORKSPACE = real_ws
check(rc == rc_once == w.NOT_BOUND_EXIT and "login" not in holder["api"].calls
      and not os.path.exists(w.STOP_PATH) and not os.path.exists(w.ENABLED_PATH),
      "plain .env values (a 零股 machine, SINOPAC_LIVE=true included): daemon and --once exit NOT_BOUND_EXIT "
      "— no login, no STOP, no futures marker",
      (rc, rc_once, holder["api"].calls))
w.ENABLED_PATH = _ep
_bind_store()
# audit r2 M1: bound, but the connect flow has not finished (a rebind removed the marker): the daemon
# does not log in, whoever started it (NSSM at a Windows boot) — --once still does (the flow's probe)
os.remove(w.WANTED_PATH)
holder["api"] = FakeApi()
w.WORKSPACE = TMP
rc = w.main()
w.WORKSPACE = real_ws
check(rc == w.NOT_BOUND_EXIT and "login" not in holder["api"].calls and not os.path.exists(w.STOP_PATH),
      "audit r2 M1: no connect-flow finish marker → the daemon exits NOT_BOUND_EXIT without a login",
      (rc, holder["api"].calls))
_bind_store()


class _UnbindApi(FakeApi):
    """The second account read finds .env unbound (the cloud unbind cannot stop the service)."""

    def __init__(self, new_env, **kw):
        super().__init__(**kw)
        self.new_env, self.reads = new_env, 0

    def margin(self, acct):
        self.reads += 1
        if self.reads == 1:
            with open(os.path.join(TMP, ".env"), "w") as f:
                f.write(self.new_env)
        return super().margin(acct)


_pp = w.POLL_S
w.POLL_S = 0.05
_unbound = {}
for new_env, why in (("BINANCE_API_KEY=x\nBINANCE_SECRET_KEY=y\n", "unbound"),
                     ("".join(f"{k}={v}\n" for k, v in w.sinopac_vault.bound_env("k2", "s2").items()), "rebound")):
    _bind_store()
    holder["api"] = _UnbindApi(new_env)
    w.WORKSPACE = TMP
    try:
        _unbound[why] = (w._serve(), holder["api"].logged_out, holder["api"].reads)
    finally:
        w.WORKSPACE = real_ws
        if os.path.exists(w.RETRY_PATH):  # the logout's first spacing (60 s): the next pass must not wait it
            os.remove(w.RETRY_PATH)
w.POLL_S = _pp
if os.path.exists(w.RETRY_PATH):
    os.remove(w.RETRY_PATH)
check(_unbound == {"unbound": (w.NOT_BOUND_EXIT, True, 1), "rebound": (w.NOT_BOUND_EXIT, True, 1)},
      "an unbind or rebind seen in .env: the worker logs out and leaves (NOT_BOUND_EXIT) at its next round",
      _unbound)
_bind_store()

# a failed daemon login: STOP record + one venue_login_blocked (sinopac only, no HALT); --once sends none
emitted = []
real_emit = w.events.emit
w.events.emit = lambda t, **p: emitted.append((t, p)) or 1
w._write_snapshot({"ok": True, "positions": [{"root": "TMF", "productid": "TMFK6", "net": -1}]})
_bind_store()
holder["api"] = FakeApi(login_raises=RuntimeError("key refused for A123456789"))
real_ws = w.WORKSPACE
w.WORKSPACE = TMP
os.environ["BLAVE_TURN_INTERRUPT_FILE"], os.environ["BLAVE_TURN_PID"] = "x", "1:1"
try:
    rc = w.main()
except SystemExit as x:
    rc = x.code
check("BLAVE_TURN_INTERRUPT_FILE" not in os.environ and "BLAVE_TURN_PID" not in os.environ,
      "the daemon drops an agent turn's lock variables at start, as the reconciler (audit S-C)")
holder["api"] = FakeApi()
rc2 = w.main()
w.WORKSPACE = real_ws
stop_rec = json.load(open(w.STOP_PATH))
check(rc == rc2 == w.LOGIN_STOPPED_EXIT
      and emitted == [("venue_login_blocked", {"venue": "sinopac", "reason": "UNKNOWN", "positions": ["TMFK6 -1"]})]
      and "login" not in holder["api"].calls,
      "daemon login fails on an unidentified error → stops at once: one venue_login_blocked (venue, class, "
      "last rows); a restart sends none", emitted)
check(not guard.halted() and "A123456789" not in json.dumps(stop_rec),
      "a failed login trips no HALT, and the STOP record carries no national id", stop_rec)
emitted.clear()
holder["api"] = FakeApi(login_raises=RuntimeError("bad key"))
w.WORKSPACE = TMP
rc = w.run_once()
w.WORKSPACE = real_ws
check(rc == 2 and emitted == [] and os.path.exists(w.STOP_PATH),
      "--once failing (the user is watching) sends no P1 and leaves the STOP record", emitted)
w.events.emit = real_emit
os.remove(w.STOP_PATH)
os.remove(os.path.join(TMP, ".env"))

# NOT_SIGNED (api notify._LOGIN_BLOCK_REASON): the futures account reads signed=False after login
_unsigned = FakeApi()
_unsigned.accounts[1].signed = False
holder["api"] = _unsigned
e = raises(w.LoginError, lambda: w.login({"sinopac_api_key": "k", "sinopac_secret_key": "s", "sinopac_ca_path": "",
                                          "sinopac_ca_passwd": "", "sinopac_person_id": "", "live": False}))
check(e is not None and e.reason == "NOT_SIGNED" and _unsigned.logged_out,
      "signed=False → LoginError class NOT_SIGNED, logged out (not UNKNOWN)", e)
_bind_store()
holder["api"] = _unsigned
w.WORKSPACE = TMP
rc = w.run_once()
w.WORKSPACE = real_ws
probe = json.load(open(w.PROBE_PATH))
check(rc == 2 and probe.get("reason") == "NOT_SIGNED" and not probe["ok"],
      "--once: the probe file carries the class too, so the connect page can tell 'wait for review' (audit N-B)",
      probe)
# --sim-test (the signing review's test): an unsigned account still logs in — in SIMULATION, never
# production, no certificate — and one TMF order goes out; the bot's last-order marker is not touched
_sim_api = FakeApi()
_sim_api.accounts[1].signed = False
holder["api"] = _sim_api
_before = w.sinopac_vault.last_order_at()
_sim_modes = []
_real_ctor = sj.Shioaji
sj.Shioaji = lambda simulation=None: _sim_modes.append(simulation) or holder["api"]
w.WORKSPACE = TMP
try:
    rc = w.run_sim_test()
finally:
    w.WORKSPACE = real_ws
    sj.Shioaji = _real_ctor
sim = json.load(open(w.SIM_PATH))
_placed = [c for c in _sim_api.calls if isinstance(c, tuple) and c[0] == "place_order"]
check(rc == 0 and sim.get("ok") is True and len(_placed) == 1 and _placed[0][1].startswith("TMF")
      and "activate_ca" not in _sim_api.calls and _sim_api.logged_out and _sim_modes == [True]
      and w.sinopac_vault.last_order_at() == _before,
      "--sim-test: unsigned account, simulation login, one TMF order, logged out, no last-order marker",
      (rc, sim, _placed, _sim_api.calls))
# the restart stop and the HALT freeze hold the simulation order too: no login, nothing placed
for _stop in (guard.RESTART_STOP_PATH, "state/HALT"):
    _sim_api = FakeApi()
    holder["api"] = _sim_api
    open(_stop, "w").write("{}")
    sj.Shioaji = lambda simulation=None: holder["api"]
    w.WORKSPACE = TMP
    try:
        rc = w.run_sim_test()
    finally:
        w.WORKSPACE = real_ws
        sj.Shioaji = _real_ctor
        os.remove(_stop)
    sim = json.load(open(w.SIM_PATH))
    check(rc == 2 and sim.get("ok") is False and "reason" not in sim and not _sim_api.calls,
          f"--sim-test with {_stop} present: refused before login, nothing placed", (rc, sim, _sim_api.calls))


# the SDK's own classes (1.7.11 stubs: names only, shioaji is imported inside login)
class _Named(Exception):
    pass


def _sdk_err(name, *bases):
    return type(name, bases or (_Named,), {})("x")


CaError = type("CaError", (_Named,), {})
check(w._login_reason(_sdk_err("AccountNotSignError")) == "NOT_SIGNED"
      and w._login_reason(_sdk_err("CaPasswordError", CaError)) == "CERT"
      and w._login_reason(_sdk_err("ShioajiTimeoutError", _Named, TimeoutError)) == "TIMEOUT",
      "SDK login errors: AccountNotSignError → NOT_SIGNED, a CaError → CERT, a timeout → TIMEOUT")
# Wei 11-17 / designer sinopac-connect §4: five more classes the connect screen and the P1 tell apart
ShioajiError = type("ShioajiError", (_Named,), {})
AuthError = type("AuthError", (ShioajiError,), {})
_c0 = {"sinopac_api_key": "k", "sinopac_secret_key": "s", "sinopac_ca_path": "", "sinopac_ca_passwd": "",
       "sinopac_person_id": "", "live": False}
_reasons = {"KEY": w._login_reason(_sdk_err("TokenError", AuthError)),
            "TOO_MANY": w._login_reason(RuntimeError("451 Too Many Connections")),
            "VERSION": w._login_reason(ModuleNotFoundError("No module named 'shioaji'"))}
holder["api"] = FakeApi(futopt=False)
_reasons["NO_FUTURES"] = getattr(raises(w.LoginError, lambda: w.login(_c0)), "reason", None)
_old = sj.__version__
sj.__version__ = "1.5.4"
holder["api"] = FakeApi()
_reasons["VERSION (pin)"] = getattr(raises(w.LoginError, lambda: w.login(_c0)), "reason", None)
sj.__version__ = _old
_real_skew = w.tw_clock.gross_skew
w.tw_clock.gross_skew = lambda now=None: 45.0
_reasons["CLOCK"] = w._login_reason(_sdk_err("TokenError", AuthError))
_reasons["not CLOCK: our own error"] = w._login_reason(ValueError("sinopac_api_key missing"))
w.tw_clock.gross_skew = lambda now=None: 5.0
_reasons["KEY (clock fine)"] = w._login_reason(_sdk_err("TokenError", AuthError))
w.tw_clock.gross_skew = _real_skew
check(_reasons == {"KEY": "KEY", "NO_FUTURES": "NO_FUTURES", "TOO_MANY": "TOO_MANY", "VERSION": "VERSION",
                   "VERSION (pin)": "VERSION", "CLOCK": "CLOCK", "not CLOCK: our own error": "UNKNOWN",
                   "KEY (clock fine)": "KEY"},
      "reason codes: KEY (AuthError family), NO_FUTURES, TOO_MANY (451, still retried), VERSION (pin / missing), "
      "CLOCK (a broker refusal while the clock is measured off > receive_window, ahead of KEY)", _reasons)
check(w.retryable(RuntimeError("451 Too Many Connections")) and not w.retryable(_sdk_err("TokenError", AuthError)),
      "…TOO_MANY stays a retry, KEY a stop")
_retry_cases = {"TimeoutError": TimeoutError("t"), "ShioajiConnectionError": _sdk_err("ShioajiConnectionError",
                                                                                    _Named, ConnectionError),
                "DNS": __import__("socket").gaierror("no name"), "503": _sdk_err("SystemMaintenance"),
                "451": RuntimeError("451 Too Many Connections")}
import errno as _errno  # noqa: E402
# audit F3: the network down / unreachable is a plain OSError (no ConnectionError subclass)
_net = {f"OSError {n}": OSError(getattr(_errno, n), n) for n in ("ENETUNREACH", "EHOSTUNREACH", "ENETDOWN")}
_retry_cases.update(_net)
_stop_cases = {"TokenError": _sdk_err("TokenError"), "CaPasswordError": _sdk_err("CaPasswordError", CaError),
               "AccountNotSignError": _sdk_err("AccountNotSignError"), "unidentified": RuntimeError("bad key"),
               "own LoginError": w.LoginError("x", "TIMEOUT"), "ValueError": ValueError("x"),
               # the certificate file missing or unreadable stays a CERT stop, not a retry
               "FileNotFoundError": FileNotFoundError(_errno.ENOENT, "sinopac.pfx"),
               "PermissionError": PermissionError(_errno.EACCES, "sinopac.pfx"),
               "OSError EACCES": OSError(_errno.EACCES, "denied"), "IsADirectoryError": IsADirectoryError("x"),
               "SSLCertVerificationError": __import__("ssl").SSLCertVerificationError("bad cert")}
# audit r2 S2: every other OSError is the connection — retried (rule changed: a plain OSError used to stop)
import ssl as _ssl  # noqa: E402
_retry_cases.update({"OSError plain": OSError("x"), "EADDRNOTAVAIL": OSError(_errno.EADDRNOTAVAIL, "boot"),
                     "SSLError": _ssl.SSLError("handshake"), "SSLEOFError": _ssl.SSLEOFError("eof")})
check(all(w.retryable(x) for x in _retry_cases.values()) and not any(w.retryable(x) for x in _stop_cases.values()),
      "retryable: timeout / connection / DNS / 503 maintenance / 451 only; credentials, certificate, signing, "
      "this module's own LoginErrors and anything unidentified stop",
      ([k for k, x in _retry_cases.items() if not w.retryable(x)], [k for k, x in _stop_cases.items() if w.retryable(x)]))
check(all(w._login_reason(x) == "TIMEOUT" for x in _net.values()),
      "audit F3: network down / unreachable OSErrors are retried (class TIMEOUT), not a STOP", list(_net))


class _CaRaises(FakeApi):
    def __init__(self, exc, **kw):
        super().__init__(**kw)
        self.exc = exc

    def activate_ca(self, **kw):
        self.calls.append("activate_ca")
        raise self.exc


_live = {"sinopac_api_key": "k", "sinopac_secret_key": "s", "sinopac_ca_path": "/x.pfx", "sinopac_ca_passwd": "p",
         "sinopac_person_id": "", "live": True}
holder["api"] = _CaRaises(OSError(_errno.ENETUNREACH, "Network is unreachable"))
e1 = raises(Exception, lambda: w.login(_live))
holder["api"] = _CaRaises(FileNotFoundError(_errno.ENOENT, "x.pfx"))
e2 = raises(Exception, lambda: w.login(_live))
check(e1 is not None and not isinstance(e1, w.LoginError) and w.retryable(e1)
      and isinstance(e2, w.LoginError) and e2.reason == "CERT",
      "audit F3: activate_ca losing the network is retried; a missing certificate file is still CERT", (e1, e2))


class _FlakyApi(FakeApi):
    """login() raises the next queued error; an empty queue logs in."""

    def __init__(self, errors, **kw):
        super().__init__(**kw)
        self.errors, self.logins = list(errors), 0

    def login(self, **kw):
        self.logins += 1
        if self.errors:
            self.calls.append("login")
            raise self.errors.pop(0)
        return super().login(**kw)


_c = {"sinopac_api_key": "k", "sinopac_secret_key": "s", "sinopac_ca_path": "", "sinopac_ca_passwd": "",
      "sinopac_person_id": "", "live": False}


def _rec():
    """The login retry record, {} when there is none (a missing one must fail a check, not crash the file)."""
    try:
        return json.load(open(w.RETRY_PATH))
    except FileNotFoundError:
        return {}


def _drop(path):
    if os.path.exists(path):
        os.remove(path)
_knobs = ("LOGIN_RETRY_S", "LOGIN_RETRY_LONG_S", "LOGIN_451_WAIT_S", "POLL_S", "UNREACHABLE_AFTER_S",
          "UNREACHABLE_REPEAT_S", "LOGIN_STABLE_S")
saved = {k: getattr(w, k) for k in _knobs}
w.LOGIN_RETRY_S, w.LOGIN_RETRY_LONG_S, w.LOGIN_451_WAIT_S, w.POLL_S = (0.05, 0.05), 0.05, 0.4, 0.02
w.UNREACHABLE_AFTER_S, w.UNREACHABLE_REPEAT_S = 3600, 7200  # no P1 inside these short tests unless set
snaps, real_write = [], w._write_snapshot
w._write_snapshot = lambda s: snaps.append(dict(s)) or real_write(s)
emitted.clear()
w.events.emit = lambda t, **p: emitted.append((t, p)) or 1
try:
    # S7 (Wei 11-17): a timeout, then a connection error, then a good login — no STOP, no P1
    holder["api"] = _FlakyApi([TimeoutError("timed out A123456789"), ConnectionError("reset")])
    api_, a = w._login_with_retry(_c)
    waits = [s for s in snaps if s.get("waiting") == "login_retry"]
    check(snaps and snaps[0].get("waiting") == "login" and not snaps[0]["ok"],
          "S7: before its first login the worker writes a `waiting: login` snapshot — a reboot's first "
          "rounds are skipped, not counted toward HALT", snaps[:1])
    check(holder["api"].logins == 3 and a is not None and not os.path.exists(w.STOP_PATH)
          and _rec().get("failures") == 3 and emitted == [],
          "S7: timeout and connection logins are retried after a spaced wait, no STOP, no P1; the good login's "
          "record stays until the session held LOGIN_STABLE_S (audit F2)", (holder["api"].logins, emitted))
    _drop(w.RETRY_PATH)
    check(waits and all(not s["ok"] and s["retry_at"] > 0 and "A123456789" not in s["error"] for s in waits),
          "…while waiting, a not-ok `waiting: login_retry` snapshot (restamped), no national id", waits[:1])
    # the account lib reads that snapshot as waiting (the reconciler's ReadSkipped), not as a failed read
    real_write({"ok": False, "waiting": "login_retry", "retry_at": time.time() + 60, "error": "x"})
    check(account_sinopac.waiting() == "login_retry", "sinopac_futures_account.waiting() names the retry")
    real_write({"ok": False, "error": "x"})
    check(account_sinopac.waiting() is None, "…and a plain failed snapshot is not waiting")
    # Wei 11-17: unanswered logins are retried for good, never a STOP; the P1 is exchange_unreachable
    # once the streak is UNREACHABLE_AFTER_S old, again every UNREACHABLE_REPEAT_S
    w.UNREACHABLE_AFTER_S, w.UNREACHABLE_REPEAT_S = 0.12, 60
    holder["api"] = _FlakyApi([TimeoutError("t")] * 8)
    w._login_with_retry(_c)
    check(holder["api"].logins == 9 and not os.path.exists(w.STOP_PATH)
          and _rec().get("failures") == 9
          and [t for t, _ in emitted] == ["exchange_unreachable"]
          and emitted[0][1]["venue"] == "sinopac" and emitted[0][1]["code"] == "login",
          "S7: eight unanswered logins in a row — no STOP, one exchange_unreachable once the streak is old "
          "enough, the ninth login gets in", (holder["api"].logins, emitted))
    _drop(w.RETRY_PATH)
    emitted.clear()
    w.UNREACHABLE_AFTER_S, w.UNREACHABLE_REPEAT_S = 3600, 7200
    # the cadence itself, on the shipped values: first P1 25 min in, then every 2 h
    A, R = saved["UNREACHABLE_AFTER_S"], saved["UNREACHABLE_REPEAT_S"]
    w.UNREACHABLE_AFTER_S, w.UNREACHABLE_REPEAT_S = A, R
    check((A, R) == (1500, 7200) and not w.announce_due(0, None, 1499) and w.announce_due(0, None, 1500)
          and not w.announce_due(0, 1500, 1500 + 7200) and w.announce_due(0, 1500, 9000)
          and not w.announce_due(0, 9000, 9000 + 7199) and w.announce_due(0, 9000, 9000 + 7200)
          and not w.announce_due(None, None, 10 ** 6),
          "S7: exchange_unreachable at 25 minutes into the streak, the next one not before 150 min (the P1 "
          "mark, Wei 11-17), then every 2 hours (群益's cadence)")
    w.UNREACHABLE_AFTER_S, w.UNREACHABLE_REPEAT_S = 3600, 7200
    w.LOGIN_RETRY_S, w.LOGIN_RETRY_LONG_S, w.LOGIN_451_WAIT_S = (saved["LOGIN_RETRY_S"], saved["LOGIN_RETRY_LONG_S"],
                                                                 saved["LOGIN_451_WAIT_S"])
    # the whole streak on the shipped values, a fake clock, every login failing at once: the notices
    # land at 25, 150, 270, 390 min — one on the api's P1 mark (Wei 11-17: P2 at 25, P1 from 150)
    w.UNREACHABLE_AFTER_S, w.UNREACHABLE_REPEAT_S = A, R

    def _streak(err=None, hours=7):
        t, n, ann, out = 0.0, 0, None, []
        while t < hours * 3600:
            n += 1
            if w.announce_due(0.0, ann, t):
                out.append(int(t // 60))
                ann = t
            nxt = t + w.p1_aligned_wait(w.retry_wait_s(n, err), 0.0, ann, t,
                                        w.LOGIN_451_WAIT_S if err is not None else 0.0)
            # _wait_retry sends a notice that falls due between two logins at its own time
            while True:
                due = w.next_announce_at(0.0, ann)
                if due is None or due >= nxt:
                    break
                check(w.announce_due(0.0, ann, due) and not w.announce_due(0.0, ann, due - 1),
                      "next_announce_at is the first moment announce_due turns true", (ann, due))
                out.append(int(due // 60))
                ann = due
            t = nxt
        return out

    _sched = _streak()
    check(_sched == [25, 150, 270, 390] and w.UNREACHABLE_P1_AT_S == 150 * 60,
          "Wei 11-17: notices at 25, 150, 270, 390 min — a retry is moved onto the 150-min P1 mark "
          "(30-min retries alone land at 145 / 175)", _sched)
    _sched451 = _streak(RuntimeError("451 Too Many Connections"))
    check(len(_sched451) >= 2 and _sched451[0] == 25 and _sched451[1] >= 150,
          "…a 451 streak still gets its first notice at 25 min and one at or past 150 min", _sched451)
    check(all(w.retry_wait_s(n, RuntimeError("451 Too Many Connections")) >= w.LOGIN_451_WAIT_S for n in range(1, 12)),
          "…and every login after a 451 still waits at least LOGIN_451_WAIT_S (the notice moves, the login does not)")
    # the real wait: a notice due while logged out goes out inside _wait_retry, once, and is kept on disk
    emitted.clear()
    _st = {"failures": 3, "retry_at": 0.0, "error": "451", "since": time.time() - w.UNREACHABLE_AFTER_S - 1,
           "announced_at": None}
    w._wait_retry(time.time() + 0.1, 3, "451", [], _st)
    check([t for t, _ in emitted] == ["exchange_unreachable"] and emitted[0][1]["venue"] == "sinopac"
          and emitted[0][1]["minutes"] == 25 and _st["announced_at"] and _rec().get("announced_at") == _st["announced_at"],
          "_wait_retry: the 25-minute notice goes out during the wait (not at the next login), once, recorded",
          (emitted, _st))
    emitted.clear()
    w.UNREACHABLE_AFTER_S, w.UNREACHABLE_REPEAT_S = 3600, 7200
    check([w.retry_wait_s(n) for n in range(1, 9)] == [60, 120, 240, 480, 600, 1800, 1800, 1800]
          and w.retry_wait_s(1, RuntimeError("451 Too Many Connections")) == 600
          and sum(w.retry_wait_s(n) for n in range(1, 6)) == 1500,
          "S7: waits 1, 2, 4, 8, 10 min (the 6th failure lands 25 min in), then 30 min for good; "
          ">= 10 min after a 451")
    w.LOGIN_RETRY_S, w.LOGIN_RETRY_LONG_S, w.LOGIN_451_WAIT_S = (0.05, 0.05), 0.05, 0.4
    # under HALT no exchange_unreachable (as the reconciler's: it says trading resumes by itself)
    open("state/HALT", "w").write("test")
    w.UNREACHABLE_AFTER_S = 0.0
    holder["api"] = _FlakyApi([TimeoutError("t")] * 2)
    w._login_with_retry(_c)
    os.remove("state/HALT")
    w.UNREACHABLE_AFTER_S = 3600
    check(emitted == [], "S7: no exchange_unreachable while HALT is set", emitted)
    # a credential-class failure in the middle of a retry streak stops at once
    holder["api"] = _FlakyApi([TimeoutError("t"), _sdk_err("CaPasswordError", CaError)])
    e = raises(SystemExit, lambda: w._login_with_retry(_c))
    check(e is not None and holder["api"].logins == 2 and [p["reason"] for _, p in emitted] == ["CERT"],
          "S7: a certificate error after a timeout stops at once with class CERT", emitted)
    os.remove(w.STOP_PATH)
    emitted.clear()
    # the spacing survives a restart: a retry file written by the previous process is waited out
    json.dump({"failures": 1, "retry_at": time.time() + 0.3}, open(w.RETRY_PATH, "w"))
    holder["api"] = _FlakyApi([])
    t0 = time.time()
    w._login_with_retry(_c)
    check(time.time() - t0 >= 0.25 and holder["api"].logins == 1,
          "S7: a restart waits out the persisted retry time before its login", time.time() - t0)
    _drop(w.RETRY_PATH)
    json.dump({"failures": 1, "retry_at": time.time() - 7200}, open(w.RETRY_PATH, "w"))
    holder["api"] = _FlakyApi([])
    snaps.clear()
    w._login_with_retry(_c)
    check(holder["api"].logins == 1 and not [s for s in snaps if s.get("waiting") == "login_retry"],
          "…a retry file from hours ago starts a new streak (no wait)", snaps)
    open(w.RETRY_PATH, "w").write("{not json")
    check(w._retry_state()["failures"] == 1 and w._retry_state()["retry_at"] > time.time(),
          "…an unreadable retry file waits the longest spacing, never an immediate login")
    _drop(w.RETRY_PATH)
    # 451: at least LOGIN_451_WAIT_S before the next login
    holder["api"] = _FlakyApi([RuntimeError("451 Too Many Connections")])
    t0 = time.time()
    w._login_with_retry(_c)
    check(time.time() - t0 >= 0.35 and holder["api"].logins == 2,
          "S7: after a 451 the next login waits LOGIN_451_WAIT_S", time.time() - t0)
    _drop(w.RETRY_PATH)

    # audit F2: every login is on record before it runs — a process killed inside it (or crashing
    # soon after a good one) restarts on the ladder, never at once (451 / 1000 logins a day)
    class _Killed(BaseException):
        pass

    class _KillApi(FakeApi):
        def __init__(self, **kw):
            super().__init__(**kw)
            self.logins = 0

        def login(self, **kw):
            self.logins += 1
            raise _Killed()

    _ladder = (0.1, 0.2, 0.4)
    w.LOGIN_RETRY_S, w.LOGIN_RETRY_LONG_S, w.LOGIN_451_WAIT_S = _ladder, 0.8, 1.0
    gaps = []
    for _ in range(3):
        holder["api"] = _KillApi()
        raises(_Killed, lambda: w._login_with_retry(_c))
        t_kill = time.time()
        rec = _rec()
        gaps.append((rec.get("failures"), round(rec.get("retry_at", 0) - t_kill, 1)))
    check(gaps == [(1, 0.1), (2, 0.2), (3, 0.4)],
          "audit F2: a process killed mid-login leaves a failed attempt on record; each kill climbs the "
          "ladder (no immediate relogin after a crash restart)", gaps)
    holder["api"] = _FlakyApi([])
    t0 = time.time()
    w._login_with_retry(_c)
    check(time.time() - t0 >= 0.3 and holder["api"].logins == 1,
          "audit F2: …the restart after the third kill waits the ladder's wait before its login", time.time() - t0)
    _drop(w.RETRY_PATH)
    # a 451 wait is pending when the process dies; the restart's own attempt is killed too: the next
    # start still waits LOGIN_451_WAIT_S, not the shorter ladder step
    json.dump({"failures": 1, "retry_at": time.time() + 0.05, "since": time.time(),
               "error": "RuntimeError: 451 Too Many Connections"}, open(w.RETRY_PATH, "w"))
    holder["api"] = _KillApi()
    t0 = time.time()
    raises(_Killed, lambda: w._login_with_retry(_c))
    rec = _rec()
    check(time.time() - t0 >= 0.04 and rec.get("failures") == 2 and rec.get("retry_at", 0) - t0 >= w.LOGIN_451_WAIT_S - 0.05,
          "audit F2: a persisted 451 wait is waited out after a restart, and a kill inside the next login "
          "keeps the 451 floor (not the 2nd ladder step)", rec)
    _drop(w.RETRY_PATH)
    # the record cannot be written: no login at all (STATE_EXIT)
    _rp = w.RETRY_PATH
    w.RETRY_PATH = os.path.join(w.PROBE_PATH, "retry.json")  # under a file: the write fails
    holder["api"] = _FlakyApi([])
    e = raises(SystemExit, lambda: w._login_with_retry(_c))
    w.RETRY_PATH = _rp
    check(e is not None and e.code == w.STATE_EXIT and holder["api"].logins == 0,
          "audit F2: a login record that cannot be written → no login, exit STATE_EXIT", e)

    # a crash soon after a good login keeps the record; a session that held LOGIN_STABLE_S drops it; a
    # requested stop (desktop stdin closed / a signal) logs out, no climb, the first spacing kept
    class _ServeApi(FakeApi):
        def __init__(self, on_margin, **kw):
            super().__init__(**kw)
            self.on_margin = on_margin

        def margin(self, acct):
            self.on_margin()
            return super().margin(acct)

    def _crash():
        raise _Killed()

    seen = {}

    def _stable_then_stop():
        seen["record"] = os.path.exists(w.RETRY_PATH)
        w._STOP.set()

    w.WORKSPACE = TMP
    try:
        holder["api"] = _ServeApi(_crash)
        _bind_store()
        raises(_Killed, w._serve)
        rec = _rec()
        crashed = (rec.get("failures"), holder["api"].logged_out)
        _drop(w.RETRY_PATH)
        w.LOGIN_STABLE_S = 0.0
        holder["api"] = _ServeApi(_stable_then_stop)
        t_stop = time.time()
        rc = w._serve()
        rec = _rec()
    finally:
        w.WORKSPACE = real_ws
        w.LOGIN_STABLE_S = saved["LOGIN_STABLE_S"]
        w._STOP.clear()
    check(crashed == (1, True),
          "audit F2: a crash right after a good login logs out and keeps the attempt on record (the restart "
          "climbs)", crashed)
    check(seen == {"record": False} and rc == 0 and holder["api"].logged_out
          and rec.get("failures") == 0 and rec.get("retry_at", 0) - t_stop >= _ladder[0] - 0.05,
          "…a session past LOGIN_STABLE_S drops it; a requested stop logs out (finally) and leaves the first "
          "spacing only, no climb", (seen, rc, rec))
    _drop(w.RETRY_PATH)
    w.LOGIN_RETRY_S, w.LOGIN_RETRY_LONG_S, w.LOGIN_451_WAIT_S = (0.05, 0.05), 0.05, 0.4
    # a good login ends the streak: a crash 26 min into a healthy session, then one unanswered login,
    # must not send an unreachable notice dated from the old streak (nor reach the 150-min P1 early)
    w.UNREACHABLE_AFTER_S = 0.3
    holder["api"] = _FlakyApi([TimeoutError("t")])
    w._login_with_retry(_c)
    ended = _rec()
    time.sleep(0.35)  # the healthy session outlives UNREACHABLE_AFTER_S, then crashes (record kept)
    emitted.clear()
    holder["api"] = _FlakyApi([TimeoutError("t")])
    w._login_with_retry(_c)
    w.UNREACHABLE_AFTER_S = 3600
    check(ended.get("since") is None and ended.get("announced_at") is None and ended.get("failures") == 2
          and emitted == [],
          "audit F2: a good login keeps the crash ladder but ends the streak — the next unanswered login "
          "after a crash starts a new one, no immediate exchange_unreachable", (ended, emitted))
    _drop(w.RETRY_PATH)
    # audit F3: the network not up (boot) or dropped is a plain OSError — retried, never a STOP
    import errno as _errno
    holder["api"] = _FlakyApi([OSError(_errno.ENETUNREACH, "Network is unreachable"),
                               OSError(_errno.EHOSTUNREACH, "No route to host")])
    w._login_with_retry(_c)
    check(holder["api"].logins == 3 and not os.path.exists(w.STOP_PATH) and emitted == [],
          "audit F3: ENETUNREACH / EHOSTUNREACH logins are retried — no STOP, no venue_login_blocked",
          (holder["api"].logins, emitted))
    _drop(w.RETRY_PATH)
    # N-C: the stop's P1 goes out even when its snapshot cannot be written
    w._write_snapshot = lambda s: (_ for _ in ()).throw(OSError("disk full"))
    holder["api"] = _FlakyApi([RuntimeError("bad key")])
    e = raises(SystemExit, lambda: w._login_with_retry(_c))
    check(e is not None and e.code == w.LOGIN_STOPPED_EXIT and [t for t, _ in emitted] == ["venue_login_blocked"]
          and os.path.exists(w.STOP_PATH),
          "audit N-C: a snapshot write failing at the stop still sends its one P1", emitted)
    os.remove(w.STOP_PATH)
    _hb = w.HEARTBEAT_PATH
    w.HEARTBEAT_PATH = os.path.join(w.PROBE_PATH, "beat")  # under a file: the write fails
    check(w._beat() is None, "audit N-C: a heartbeat that cannot be written does not raise")
    w.HEARTBEAT_PATH = _hb
finally:
    w._write_snapshot = real_write
    w.events.emit = real_emit
    for k, v in saved.items():
        setattr(w, k, v)
    for p in (w.STOP_PATH, w.RETRY_PATH):
        if os.path.exists(p):
            os.remove(p)
os.remove(os.path.join(TMP, ".env"))

# exit paths log out (Windows M0-a: a process still logged in never exits)
import signal as _signal  # noqa: E402
real_term = _signal.getsignal(_signal.SIGTERM)
w._exit_on_signals()
check(raises(SystemExit, lambda: _signal.getsignal(_signal.SIGTERM)(_signal.SIGTERM, None)) is not None,
      "SIGTERM unwinds as SystemExit (through the finally that logs out)")
_signal.signal(_signal.SIGTERM, real_term)


class _StopApi(FakeApi):
    def margin(self, acct):
        raise SystemExit(0)  # what the SIGTERM handler raises mid-loop


_bind_store()
holder["api"] = _StopApi()
w.WORKSPACE = TMP
raises(SystemExit, w.main)
w.WORKSPACE = real_ws
check(holder["api"].logged_out, "the daemon stopped mid-loop logs out")
os.remove(os.path.join(TMP, ".env"))

# shioaji's native session line goes to fd 1 with the national id: quiet_sdk masks it
cap = os.path.join(TMP, "fd1.txt")
sys.stdout.flush()
outer = os.dup(1)
fdc = os.open(cap, os.O_WRONLY | os.O_CREAT | os.O_TRUNC)
os.dup2(fdc, 1)
os.close(fdc)
with w.quiet_sdk():
    os.write(1, b"INFO Session Property modification ok /PYAPI/A123456789/ x\npartial A223456789")
    print("python side AB12345678 and A812345678", flush=True)
os.dup2(outer, 1)
os.close(outer)
got = open(cap, encoding="utf-8").read()
check("Session Property modification ok /PYAPI/<id>/" in got and "<id>" in got.split("\n")[1]
      and not any(x in got for x in ("A123456789", "A223456789", "AB12345678", "A812345678")),
      "quiet_sdk: native fd writes and Python prints reach fd 1 with every id masked", got)
check(w.redact("order 2330 qty 1000000000 TXFK6") == "order 2330 qty 1000000000 TXFK6",
      "redact leaves codes and long numbers alone")
check(w.redact("CA not activated for: a123456789 / Ab12345678") == "CA not activated for: <id> / <id>",
      "redact masks a lowercase id too (a hand-typed .env value, echoed as given; audit S1)")

# ── 6. sinopac_futures_account ───────────────────────────────────────────────────────
if os.path.exists(w.OUT_PATH):
    os.remove(w.OUT_PATH)
check(raises(RuntimeError, lambda: account_sinopac.get_equity({})) is not None, "missing snapshot raises")
snap = w.read_account(FakeApi(positions=[(computed_near("TXF"), 2), (computed_near("TMF"), -1)]), acct)
w._write_snapshot(snap)
eq = account_sinopac.get_equity({})
pos = account_sinopac.get_positions({})
check(eq["equity"] == 500000.0 and eq["currency"] == "TWD", "equity from the snapshot", eq)
check(pos.get("TXF", {}).get("size") == 2.0 and pos["TXF"]["side"] == "long"
      and pos.get("TMF", {}).get("side") == "short", "positions in lots per root", pos)
check(account_sinopac.get_account_id({}).startswith("sinopac:") and "F0001" not in json.dumps(snap),
      "account fingerprint, account number never written")
snap = w.read_account(FakeApi(positions=[("TXFK6", 1), ("TXFL6", -1)]), acct)
w._write_snapshot(snap)
both = {"TXF": {account_sinopac.contract_month("TXFK6"), account_sinopac.contract_month("TXFL6")}}
check(raises(RuntimeError, lambda: account_sinopac.get_positions({}, book_months=both)) is not None,
      "one root in two of the bot's months fails the read")
far = w.contracts.prod_id("TXF", *[(y + (m == 12), m % 12 + 1) for y, m in
                                    [w.contracts.month_of(w.contracts.computed_near("TXF"))]][0])
far = w.contracts.prod_id("TXF", *[(y + (m == 12), m % 12 + 1) for y, m in [w.contracts.month_of(far)]][0])
w._write_snapshot(w.read_account(FakeApi(positions=[(computed_near("TXF"), 1), (far, -1)],
                                         extra=[("TXF", Base(far, _ymd(far)))]), acct))
pos = account_sinopac.get_positions({})
check(set(pos) == {"TXF"} and pos["TXF"]["productid"] == computed_near("TXF") and pos["TXF"]["size"] == 1.0,
      "no book: the calendar keeps the near month and leaves a month two out (the user's own) aside", pos)
w._write_snapshot({"ok": False, "error": "x"})
check(raises(RuntimeError, lambda: account_sinopac.get_equity({})) is not None, "ok:false snapshot raises")
s = json.load(open(w.OUT_PATH))
s.update(ok=True, read_at=time.time() - 3600)
json.dump(s, open(w.OUT_PATH, "w"))
check(raises(RuntimeError, lambda: account_sinopac.get_equity({})) is not None, "stale snapshot raises")
check(account_sinopac.contract_month("TXFK6") is not None and account_sinopac.contract_month("2330") is None,
      "contract_month")
near = computed_near("TXF")
snap = w.read_account(FakeApi(positions=[(near, 2), ("MXFL6", 1)]), acct)
w._write_snapshot(snap)
check(abs(account_sinopac.get_query_started_at() - snap["query_started_at"]) < 1e-6
      and account_sinopac.get_query_started_at() <= account_sinopac.get_snapshot_read_at(),
      "get_query_started_at: when the last read began, not after its write")
book = {"TXF": {account_sinopac.contract_month(near)}}
pos = account_sinopac.get_positions({}, book_months=book)
check(set(pos) == {"TXF"} and pos["TXF"]["productid"] == near,
      "book_months: a month the book does not hold (MXF, the user's own) is left out", pos)
check(account_sinopac.contract_month(near) in (account_sinopac.listed_months("TXF") or set()),
      "listed_months: the broker's months for a root", account_sinopac.listed_months("TXF"))
s = json.load(open(w.OUT_PATH))
s["listed"] = {}
s["read_at"] = time.time()
json.dump(s, open(w.OUT_PATH, "w"))
check(account_sinopac.listed_months("TXF") is None, "listed_months: an unread list → None")
from lib import venue_errors  # noqa: E402
check(account_sinopac.classify(w.contracts.ListUnknown("x")) == venue_errors.TRANSIENT
      and account_sinopac.classify(RuntimeError("x")) is None,
      "classify: an unread list past a settlement is TRANSIENT, the rest falls to the floor")
check(not hasattr(account_sinopac, "get_flows"), "no get_flows: equity jumps fall back to 資金異動")

# ── 7. flatten names ─────────────────────────────────────────────────────────
check(osj.format_qty({}, "TXF", 2.0) == "2" and raises(ValueError, lambda: osj.format_qty({}, "TXF", 0.4)),
      "format_qty: whole lots, below 1 raises")
check(callable(getattr(osj, "close_position_partial", None)), "close_position_partial exists")
check(raises(NotImplementedError, lambda: osj.place_stop_order({}, "TXF", "long", 1, 22000)) is not None
      and raises(NotImplementedError, lambda: osj.cancel_order({}, "x")) is not None,
      "place_stop_order / cancel_order refuse (no broker-side stop, nothing verified)")
check(not hasattr(osj, "place_limit_order"),
      "no limit layer at all: lib/execute's chase degrades to market instead of calling a stub")
tw_clock.entry_hold = real_entry_hold

print(f"\n{'FAILED: ' + str(fails) if fails else 'all passed'}")
sys.exit(1 if fails else 0)
