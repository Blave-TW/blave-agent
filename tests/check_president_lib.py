"""統一期貨 lib without a broker — near-month roll, confirmation, guards, snapshot.

1. near_month: third-Wednesday 13:30 Taipei is the roll instant (13:29:59
   stays, 13:30:00 rolls — the backtest's TXFR1 changes contract on the 13:31
   bar), December rolls into next year's A contract, a computed contract
   missing from the broker's list is refused, naive times are refused.
2. Orders (Unitrade faked): an entry goes to the computed near month, a
   reduce to the held row's own productid (even when the near month has
   rolled past it); issend=False and a 9999 reply raise; 0000 with no fill is
   'sent' (never resubmitted); an IOC cancel (0002) settles early; fills come
   from on_match via the orderno of OUR seq's reply; HALT blocks entries not
   closes; a client_tag is refused the second time today; the session is
   logged out on every path.
3. Host gate: without PRESIDENT_LIVE only *.testpfctrade.com.
4. Snapshot: rows net per root, several months net and drop productid,
   an ot_qty / current_open disagreement fails the read, maintenance windows.
5. Interface: every `order.<name>(` call site in lib/ and manager/ (the grep
   venue-onboarding §3 prescribes) is implemented here or named unreachable
   for a TW broker with the reason; order_capital's futures names all exist.

Run: cd blave-agent && python3 tests/check_president_lib.py
"""
import json, os, sys, tempfile, threading, types
from datetime import datetime

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
TMP = tempfile.mkdtemp(prefix="president-")
os.chdir(TMP)
os.makedirs("state", exist_ok=True)
os.environ["BLAVE_AGENT_HOME"] = os.environ["BLAVECLAW_HOME"] = TMP

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


# a fake `unitrade.unitrade` — only DOrderObject is imported by the order path
_ut = types.ModuleType("unitrade")
_utu = types.ModuleType("unitrade.unitrade")
_utu.DOrderObject = type("DOrderObject", (), {})
sys.modules.setdefault("unitrade", _ut)
sys.modules.setdefault("unitrade.unitrade", _utu)

from lib import account_president, guard, order_president as op, president_vault, president_worker  # noqa: E402
from lib.order_president import TAIPEI  # noqa: E402

# ── 1. near month ────────────────────────────────────────────────────────────
T = lambda *a: datetime(*a, tzinfo=TAIPEI)  # noqa: E731
check(op.settlement_at(2026, 10) == T(2026, 10, 21, 13, 30), "Oct 2026 settles Wed 10/21 13:30")
check(op.settlement_at(2026, 12) == T(2026, 12, 16, 13, 30), "Dec 2026 settles Wed 12/16 13:30")
check(op.settlement_at(2027, 1) == T(2027, 1, 20, 13, 30), "Jan 2027 settles Wed 1/20 13:30")
LISTED = ["TXFJ6", "TXFK6", "TXFL6"]
check(op.near_month("TXF", LISTED, T(2026, 10, 21, 13, 29, 59)) == "TXFJ6", "settlement day 13:29:59 → J6")
check(op.near_month("TXF", LISTED, T(2026, 10, 21, 13, 30, 0)) == "TXFK6", "settlement day 13:30:00 → K6")
check(op.near_month("TXF", LISTED, T(2026, 10, 21, 13, 31)) == "TXFK6", "settlement day 13:31 → K6")
check(op.near_month("TXF", LISTED, T(2026, 9, 30, 10, 0)) == "TXFJ6", "a normal day → the month's own contract")
check(op.near_month("TMF", ["TMFL6", "TMFA7", "TMFB7"], T(2026, 12, 16, 13, 31)) == "TMFA7",
      "December settlement 13:31 → next year's A contract")
check(op.near_month("MXF", ["MXFL6", "MXFA7"], T(2026, 12, 16, 13, 29)) == "MXFL6", "December 13:29 → L6")
e = raises(op.PresidentError, lambda: op.near_month("TXF", ["TXFJ6", "TXFL6"], T(2026, 10, 21, 13, 31)))
check(e is not None and "TXFK6" in str(e), "computed contract missing from the broker list → refused", e)
check(raises(ValueError, lambda: op.near_month("TXF", LISTED, datetime(2026, 10, 1))) is not None,
      "naive time refused")

# ── 3. host gate ─────────────────────────────────────────────────────────────
BASE = {"president_account": "A", "president_password": "P", "president_ca_path": "c.pfx",
        "president_ca_password": "", "president_test_url": "https://test167.testpfctrade.com"}
check(president_vault.resolve(BASE)["url"] == "https://test167.testpfctrade.com", "test host accepted")
for bad in ("https://test167.pfctrade.com", "https://www.pfctrade.com", "http://x.testpfctrade.com",
            "https://evil.com/.testpfctrade.com"):
    check(raises(ValueError, lambda: president_vault.resolve(dict(BASE, president_test_url=bad))) is not None,
          f"without PRESIDENT_LIVE {bad} refused")
live = dict(BASE, PRESIDENT_LIVE="true", president_url="https://api.pfctrade.example")
check(president_vault.resolve(live)["url"] == "https://api.pfctrade.example" and president_vault.resolve(live)["live"],
      "PRESIDENT_LIVE=true uses president_url")
check(raises(ValueError, lambda: president_vault.resolve(dict(BASE, PRESIDENT_LIVE="true"))) is not None,
      "PRESIDENT_LIVE without president_url refused")

# ── 2. orders ────────────────────────────────────────────────────────────────
NOW_LIST = [op.near_month("TMF", [f"TMF{c}{d}" for c in op.MONTH_CODES for d in "0123456789"])]


class Resp:
    def __init__(self, **kw):
        self.__dict__.update(kw)


class FakeApi:
    def __init__(self, script, issend=True):
        self.script, self.issend, self.sent, self.logged_out = script, issend, [], False
        self.dtrade = types.SimpleNamespace(order=self._order, on_reply=None, on_match=None)

    def get_domestic_contracts(self, root, kind):
        return Resp(ok=True, error="", data=[Resp(prod_id=p.replace("TMF", root)) for p in NOW_LIST])

    def get_accounts(self):
        return ["A1"]

    def _order(self, o):
        self.sent.append(o)
        if not self.issend:
            return Resp(issend=False, errorcode="MSG014", errormsg="尚未連線", seq="")

        def fire():
            for kind, row in self.script:
                if kind == "reply":
                    self.dtrade.on_reply(Resp(seq="S1", productid=o.productid, **row))
                else:
                    self.dtrade.on_match(Resp(**row))
        threading.Timer(0.05, fire).start()
        return Resp(issend=True, errorcode="", errormsg="", seq="S1")

    def logout(self):
        self.logged_out = True


apis = []


def use(script, issend=True):
    api = FakeApi(script, issend)
    apis.append(api)

    class _Ctx:
        def __enter__(self):
            return api

        def __exit__(self, *a):
            api.logout()
    op._session = lambda env: _Ctx()
    return api


op._TAGS_PATH = os.path.join(TMP, "state", "tags.json")
op._REFRESH_FLAG = os.path.join(TMP, "state", "president_refresh")
account_president._SNAPSHOT = os.path.join(TMP, "state", "president_account.json")


def snapshot(rows, **kw):
    json.dump(dict({"ok": True, "read_at": __import__("time").time(), "equity": 100000.0,
                    "positions": rows}, **kw), open(account_president._SNAPSHOT, "w"))


ACK = ("reply", {"statuscode": "0000", "orderstatus": "委託成功", "orderno": "O1", "matchqty": 0, "nomatchqty": 1})

api = use([ACK])
r = op.place_futures_market_order({}, "TMF", "buy", 1, "entry", confirm_timeout=0.6)
o = api.sent[0]
check(r["status"] == "sent" and r["fill_qty"] == 0 and r["ack"] == "0000" and r["symbol"] == NOW_LIST[0],
      "0000 with no fill → 'sent', on the computed near month", r)
check((o.bs, o.ordertype, o.ordercondition, o.opencloseflag, o.orderqty, o.dtrade) == ("B", "M", "I", "", 1, "N"),
      "market IOC, opencloseflag '', 1 lot", vars(o))
check(len(api.sent) == 1 and api.logged_out, "sent once, logged out")

api = use([ACK, ("match", {"orderno": "O1", "matchseq": "M1", "matchqty": 1, "matchprice": 23000.0}),
           ("reply", {"statuscode": "0004", "orderstatus": "完全成交", "orderno": "O1", "matchqty": 1})])
r = op.place_futures_market_order({}, "TMF", "buy", 1, "entry", confirm_timeout=3)
check(r["status"] == "filled" and r["fill_qty"] == 1 and r["avg_fill_price"] == 23000.0, "fill from on_match", r)

api = use([ACK, ("reply", {"statuscode": "0004", "orderstatus": "完全成交", "orderno": "O1", "matchqty": 1})])
r = op.place_futures_market_order({}, "TMF", "buy", 1, "entry", confirm_timeout=1)
check(r["status"] == "filled" and r["fill_qty"] == 1, "a 0004 reply without its match row still reads filled", r)

import time as _t  # noqa: E402
api = use([ACK, ("reply", {"statuscode": "0002", "orderstatus": "刪單成功", "orderno": "O1", "matchqty": 0})])
t0 = _t.time()
r = op.place_futures_market_order({}, "TMF", "sell", 1, "entry", confirm_timeout=8)
check(r["status"] == "sent" and _t.time() - t0 < 3, "IOC cancel (0002) settles early as unfilled", r)

api = use([("reply", {"statuscode": "9999", "orderstatus": "錯誤:ERR 保證金不足", "orderno": ""})])
e = raises(op.PresidentError, lambda: op.place_futures_market_order({}, "TMF", "buy", 1, "entry", confirm_timeout=2))
check(e is not None and "9999" in str(e) and api.logged_out, "9999 reply raises with the broker text", e)

api = use([], issend=False)
e = raises(op.PresidentError, lambda: op.place_futures_market_order({}, "TMF", "buy", 1, "entry"))
check(e is not None and "MSG014" in str(e), "issend=False raises with errorcode", e)

# reduce → the row's own productid, even after the near month rolled past it
snapshot([{"root": "TMF", "productid": "TMFA0", "net": 2, "net_current": 2}])
api = use([ACK])
r = op.close_position_partial({}, "TMF", "long", 1, client_order_id="flat20260930120000123456")
check(api.sent[-1].productid == "TMFA0" and api.sent[-1].bs == "S" and r["exchange"] == "president",
      "close goes to the held row's productid, not the near month", vars(api.sent[-1]))
e = raises(op.DuplicateOrder, lambda: op.close_position_partial({}, "TMF", "long", 1,
                                                               client_order_id="flat20260930120000123456"))
check(e is not None and len(api.sent) == 1, "the same client id again today → refused locally")
check(len(api.sent[-1].note) <= 10, "note fits 10 chars", api.sent[-1].note)
snapshot([{"root": "TMF", "productid": "TMFA0", "net": 1, "net_current": 1},
          {"root": "TMF", "productid": "TMFB0", "net": 1, "net_current": 1}])
check(raises(op.PresidentError, lambda: op.close_position_partial({}, "TMF", "long", 1)) is not None,
      "a root open in two months is not closed by root")
check(raises(ValueError, lambda: op.place_futures_market_order({}, "TMFJ6", "buy", 1, "entry")) is not None,
      "an entry must name the root, not a month")

open("state/HALT", "w").write("{}")
api = use([ACK])
check(raises(guard.Halted, lambda: op.place_futures_market_order({}, "TMF", "buy", 1, "entry")) is not None
      and not api.sent, "HALT: entry refused before login")
snapshot([{"root": "TMF", "productid": "TMFA0", "net": 1, "net_current": 1}])
r = op.place_futures_market_order({}, "TMF", "sell", 1, "reduce", confirm_timeout=0.4)
check(len(api.sent) == 1, "HALT: reduce passes")
os.remove("state/HALT")
check(all(a.logged_out for a in apis), "every session logged out")
audits = [json.loads(line)["event"] for line in open("state/audit.jsonl")]
check({"order_sent", "order_error", "order_filled", "order_denied_halt"} <= set(audits), "audit trail", set(audits))

# ── 4. snapshot + worker parsing ─────────────────────────────────────────────
snapshot([{"root": "TXF", "productid": "TXFJ6", "net": 1, "net_current": 1},
          {"root": "TMF", "productid": "TMFJ6", "net": -2, "net_current": -2},
          {"root": "TMF", "productid": "TMFK6", "net": 1, "net_current": 1}])
check(account_president.get_positions({}) == {"TXF": {"side": "long", "size": 1.0, "productid": "TXFJ6"},
                                              "TMF": {"side": "short", "size": 1.0}},
      "positions: canonical keys, lots, months netted", account_president.get_positions({}))
snapshot([{"root": "TXF", "productid": "TXFJ6", "net": 1, "net_current": 0}])
check(raises(RuntimeError, lambda: account_president.get_positions({})) is not None,
      "ot_qty vs current_open disagreement fails the read")
snapshot([], account_fp="abc123")
check(account_president.get_account_id({}) == "president:abc123", "account id is the snapshot fingerprint")
snapshot([])
check(raises(RuntimeError, lambda: account_president.get_account_id({})) is not None,
      "no fingerprint → raises, never None")
snapshot([], equity=None, margin_error="查無資料!")
e = raises(RuntimeError, lambda: account_president.get_equity({}))
check(e is not None and "查無資料" in str(e), "no margin data → an error, never 0 equity", e)
snapshot([], ok=False, error="boom")
check(raises(RuntimeError, lambda: account_president.get_holdings({})) is not None, "worker error surfaces")

row = Resp(product="MXF", call_put="", productid="MXFJ6", month="202610", ot_qty_b=1, ot_qty_s=0,
           current_buy_open_position=1, current_sell_open_position=0, open_buy_position_average_cost=47986.0,
           open_sell_position_average_cost=0.0, floating_pnl=20700.0, product_base_number=50)
pr = president_worker.position_row(row)
check(pr["root"] == "MXF" and pr["net"] == 1 and pr["net_current"] == 1 and pr["point_value"] == 50,
      "worker parses the test host's preloaded MXF row", pr)
check(president_worker.position_row(Resp(product="TXO", call_put="C", productid="TXO23000J6")) is None,
      "option rows are not futures positions")
check(raises(RuntimeError, lambda: president_worker.position_row(
    Resp(product="TXF", call_put="", productid="TXF202610"))) is not None, "unreadable TXF code fails")
check(president_worker.maintenance(T(2026, 10, 1, 5, 40)) == "login"
      and president_worker.maintenance(T(2026, 10, 1, 7, 29)) == "account"
      and president_worker.maintenance(T(2026, 10, 1, 7, 30)) is None
      and president_worker.maintenance(T(2026, 10, 1, 5, 55)) is None,
      "maintenance windows 05:30–05:50 / 06:00–07:30 Taipei")

# ── 5. interface: every order.<name>( call site in lib/ manager/ is either
# implemented here or unreachable for a TW broker (named with the reason) ──
import glob, re  # noqa: E402
calls = set()
for path in glob.glob(os.path.join(ROOT, "lib", "*.py")) + glob.glob(os.path.join(ROOT, "manager", "*.py")):
    calls |= set(re.findall(r"order\.([a-z_]+)\(", open(path, encoding="utf-8").read()))
UNREACHED = {
    # lib/venue_wiring + lib/execute: the crypto auto-wire; president is auto_wire False
    "get_contract_rules": "auto-wire", "get_mark_price": "auto-wire", "place_market_order": "auto-wire",
    "place_limit_order": "auto-wire (absent = chase falls back to market)", "get_order": "auto-wire",
    "get_bbo": "auto-wire", "get_position_mode": "auto-wire", "_position_mode": "auto-wire",
    "_position_rows": "auto-wire", "get_open_orders": "auto-wire / close_symbol (perp only)",
    # spot inventory: a futures account has none
    "get_spot_balances": "spot", "get_spot_price": "spot", "place_spot_market_order": "spot",
    "place_spot_limit_order": "spot", "cancel_spot_order": "spot", "get_spot_order": "spot",
    "get_spot_bbo": "spot", "get_spot_fill_fees": "spot", "format_spot_qty": "spot",
    # manager/close_symbol.py refuses perp False venues before any of these
    "cancel_all_orders": "close_symbol", "cancel_algo_order": "close_symbol",
    "get_open_algo_orders": "close_symbol", "cancel_protective_orders": "close_symbol",
    # flatten: only rows with unit == "contracts" (account_president sets none)
    "place_contract_market_order": "flatten lots_row (paper)",
    # lib/runner.py record/replay of a strategy's own order module; dict .get
    "recording": "runner", "replaying": "runner", "get": "dict.get, not an order call",
}
missing = sorted(n for n in calls if not hasattr(op, n) and n not in UNREACHED)
check(not missing, "every order.<name>( call site is implemented or named unreachable", missing)
check(not [n for n in UNREACHED if hasattr(op, n) and n not in ("get",)],
      "nothing listed as unreachable is half-implemented here",
      [n for n in UNREACHED if hasattr(op, n)])
from lib import order_capital  # noqa: E402
import inspect  # noqa: E402
cap = {n for n, f in inspect.getmembers(order_capital, inspect.isfunction)
       if not n.startswith("_") and f.__module__ == "lib.order_capital"}
# securities are out of scope; reset_session drops capital's process-wide login — president has none
NOT_FUTURES = {"place_stock_order", "place_odd_lot_order", "place_after_hours_odd_lot_order", "reset_session"}
check(cap - NOT_FUTURES <= set(dir(op)), "order_president has order_capital's futures interface",
      sorted(cap - NOT_FUTURES - set(dir(op))))

print(f"\n{'FAILED: ' + str(fails) if fails else 'all passed'}")
sys.exit(1 if fails else 0)
