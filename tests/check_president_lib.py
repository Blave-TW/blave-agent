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
check(op.near_month("TXF", LISTED, T(2026, 10, 20, 14, 59, 59)) == "TXFJ6", "the day before, 14:59:59 → J6")
check(op.near_month("TXF", LISTED, T(2026, 10, 20, 15, 0, 0)) == "TXFK6",
      "the day before, 15:00 (night session of the settlement trading day) → entries roll to K6")
check(op.near_month("TXF", LISTED, T(2026, 10, 21, 3, 0)) == "TXFK6", "settlement night 03:00 → K6")
check(op.near_month("TXF", LISTED, T(2026, 10, 21, 13, 29)) == "TXFK6", "settlement day 13:29 → K6")
check(op.near_month("TXF", LISTED, T(2026, 10, 21, 13, 31)) == "TXFK6", "after settlement → K6")
check(op.near_month("TXF", LISTED, T(2026, 10, 19, 23, 0)) == "TXFJ6", "two nights before → J6")
check(op.near_month("TXF", LISTED, T(2026, 9, 30, 10, 0)) == "TXFJ6", "a normal day → the month's own contract")
check(op.near_month("TMF", ["TMFL6", "TMFA7", "TMFB7"], T(2026, 12, 15, 15, 0)) == "TMFA7",
      "December settlement day → next year's A contract")
check(op.near_month("MXF", ["MXFL6", "MXFA7"], T(2026, 12, 15, 14, 59)) == "MXFL6", "the day before 14:59 → L6")
e = raises(op.PresidentError, lambda: op.near_month("TXF", ["TXFJ6", "TXFL6"], T(2026, 10, 21, 13, 31)))
check(e is not None and "TXFK6" in str(e), "computed contract missing from the broker list → refused", e)
check(raises(ValueError, lambda: op.near_month("TXF", LISTED, datetime(2026, 10, 1))) is not None,
      "naive time refused")

# ── 3. host gate + the one .env parser ───────────────────────────────────────
president_vault.ENV_PATH = os.path.join(TMP, ".env")
president_vault.BLOCK = os.path.join(TMP, "state", "president_login_block.json")
BASE = {"president_account": "A", "president_password": "P", "president_ca_path": "c.pfx",
        "president_ca_password": "", "president_test_url": "https://test167.testpfctrade.com"}


def envfile(d, bom=False):
    with open(president_vault.ENV_PATH, "w", encoding="utf-8-sig" if bom else "utf-8") as f:
        f.write("".join(f"{k}={v}\n" for k, v in d.items()))


envfile(BASE)
check(president_vault.resolve()["url"] == "https://test167.testpfctrade.com", "test host accepted")
check(president_vault.resolve({"PRESIDENT_LIVE": "true", "president_url": "https://x.example"})["live"] is False,
      "a caller-supplied mapping cannot turn PRESIDENT_LIVE on — only .env can")
for bad in ("https://test167.pfctrade.com", "https://www.pfctrade.com", "http://x.testpfctrade.com",
            "https://evil.com/.testpfctrade.com"):
    envfile(dict(BASE, president_test_url=bad))
    check(raises(ValueError, lambda: president_vault.resolve()) is not None, f"without PRESIDENT_LIVE {bad} refused")
for good in ("https://viploginm.pfctrade.com", "https://viploginb.pfctrade.com/"):
    envfile(dict(BASE, PRESIDENT_LIVE="true", president_url=good))
    check(president_vault.resolve()["url"] == good.rstrip("/") and president_vault.resolve()["live"],
          f"PRESIDENT_LIVE: {good} accepted")
for bad in ("https://test167.testpfctrade.com", "https://evil.example", "http://viploginm.pfctrade.com",
            "https://viploginm.pfctrade.com.evil.example"):
    envfile(dict(BASE, PRESIDENT_LIVE="true", president_url=bad))
    check(raises(ValueError, lambda: president_vault.resolve()) is not None, f"PRESIDENT_LIVE: {bad} refused")
envfile(dict(BASE, PRESIDENT_LIVE="true", president_url="https://viploginm.pfctrade.com"))
check(president_vault.resolve()["url"] == "https://viploginm.pfctrade.com" and president_vault.resolve()["live"],
      "PRESIDENT_LIVE=true in .env uses president_url")
envfile(dict(BASE, PRESIDENT_LIVE="true"))
check(raises(ValueError, lambda: president_vault.resolve()) is not None, "PRESIDENT_LIVE without president_url refused")
envfile(dict(BASE, president_password='"p=a\\ss${X}"'), bom=True)
check(president_vault.resolve()["password"] == "p=a\\ss${X}" and president_vault.resolve()["account"] == "A",
      "BOM tolerated, one quote pair stripped, nothing else interpreted")
envfile(BASE)

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
    fresh()
    return api


def fresh():
    """The worker read again after every send so far (positions unchanged) — an
    entry needs a caught-up snapshot to pick its month."""
    try:
        cur = json.load(open(account_president._SNAPSHOT))
    except (OSError, ValueError):
        cur = {"ok": True, "equity": 100000.0, "positions": []}
    now = __import__("time").time()
    cur.update(read_at=now, query_started_at=now + president_vault.ORDER_SETTLE_S)
    json.dump(cur, open(account_president._SNAPSHOT, "w"))


op._TAGS_PATH = os.path.join(TMP, "state", "tags.json")
op._REFRESH_FLAG = os.path.join(TMP, "state", "president_refresh")
op.SEND_LOCK_PATH = os.path.join(TMP, "state", "president_send.lock")
op.LAST_ORDER_PATH = os.path.join(TMP, "state", "president_last_order_at.json")
account_president._SNAPSHOT = os.path.join(TMP, "state", "president_account.json")


def snapshot(rows, **kw):
    """A fresh worker snapshot; its read started after every send so far has settled
    unless query_started_at says otherwise."""
    now = __import__("time").time()
    json.dump(dict({"ok": True, "read_at": now, "equity": 100000.0, "positions": rows,
                    "query_started_at": now + president_vault.ORDER_SETTLE_S}, **kw),
              open(account_president._SNAPSHOT, "w"))


ACK = ("reply", {"statuscode": "0000", "orderstatus": "委託成功", "orderno": "O1", "matchqty": 0, "nomatchqty": 1})

api = use([ACK])
r = op.place_futures_market_order({}, "TMF", "buy", 1, "entry", confirm_timeout=0.6)
o = api.sent[0]
check(r["status"] == "sent" and r["fill_qty"] == 0 and r["ack"] == "0000" and r["symbol"] == NOW_LIST[0],
      "0000 with no fill → 'sent', on the computed near month", r)
check((o.bs, o.ordertype, o.ordercondition, o.opencloseflag, o.orderqty, o.dtrade) == ("B", "M", "I", "", 1, "N"),
      "entry: market IOC, opencloseflag '', 1 lot", vars(o))
check(op.last_order_at(NOW_LIST[0]) > 0, "a send marks its contract's last-order time")
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

api = use([("reply", {"statuscode": "ERR5", "orderstatus": "已收盤,委託傳送失敗", "orderno": ""})])
check(raises(op.PresidentError, lambda: op.place_futures_market_order({}, "TMF", "buy", 1, "entry",
                                                                      confirm_timeout=2)) is not None,
      "ERRn reply raises")
api = use([("reply", {"statuscode": "9902", "orderstatus": "TTO0002:尚未開始接收委託或者不接受此種委託",
                      "orderno": ""})])
check(raises(op.PresidentError, lambda: op.place_futures_market_order({}, "TMF", "buy", 1, "entry",
                                                                      confirm_timeout=2)) is not None,
      "99xx server reply (official doc example 9902) raises")

# live 10-02: the first reply to a market IOC was already 0004 (完全成交), with its match row
api = use([("reply", {"statuscode": "0004", "orderstatus": "完全成交", "orderno": "O1", "matchqty": 1}),
           ("match", {"orderno": "O1", "matchseq": "M1", "matchqty": 1, "matchprice": 48716.0})])
r = op.place_futures_market_order({}, "TMF", "buy", 1, "entry", confirm_timeout=3)
check(r["status"] == "filled" and r["ack"] == "0004" and r["avg_fill_price"] == 48716.0 and len(api.sent) == 1,
      "a first reply of 0004 is success — filled, not an error, sent once", r)

api = use([("reply", {"statuscode": "0099", "orderstatus": "?", "orderno": "O1", "matchqty": 0})])
r = op.place_futures_market_order({}, "TMF", "buy", 1, "entry", confirm_timeout=1)
check(r["status"] == "unknown" and r["ack"] == "0099" and r["fill_qty"] == 0 and len(api.sent) == 1,
      "an undefined status code is neither success nor rejection: 'unknown', not resent", r)

api = use([ACK, ("reply", {"statuscode": "0001", "orderstatus": "減量成功", "orderno": "O1", "matchqty": 0})])
t0 = _t.time()
r = op.place_futures_market_order({}, "TMF", "buy", 1, "entry", confirm_timeout=1.5)
check(r["status"] == "sent" and _t.time() - t0 >= 1.4, "0001 (減量) is not terminal — waits out the timeout", r)

api = use([], issend=False)
e = raises(op.PresidentError, lambda: op.place_futures_market_order({}, "TMF", "buy", 1, "entry", client_tag="tg1"))
check(e is not None and "MSG014" in str(e), "issend=False raises with errorcode", e)
api = use([ACK])
op.place_futures_market_order({}, "TMF", "buy", 1, "entry", client_tag="tg1", confirm_timeout=0.3)
check(len(api.sent) == 1, "a tag whose send failed is not burned — the retry goes out")
check(raises(op.DuplicateOrder, lambda: op.place_futures_market_order({}, "TMF", "buy", 1, "entry",
                                                                      client_tag="tg1")) is not None,
      "a tag that was sent is refused the second time")

SIGN_LEAK = ":!! A123456789 {'subject': 'CN=TWA1234567891,OU=PSCNET,O=FINANCE', 'serial': '1f'}"
api = use([], issend=False)
api.issend = False
real_order = api._order
api.dtrade.order = lambda o: (api.sent.append(o), Resp(issend=False, errorcode="MSG016",
                                                      errormsg="orderSend -sign error 0 " + SIGN_LEAK, seq=""))[1]
e = raises(op.PresidentError, lambda: op.place_futures_market_order({}, "TMF", "buy", 1, "entry"))
audit_txt = open("state/audit.jsonl", encoding="utf-8").read()
check(e is not None and "A123456789" not in str(e) and "PSCNET" not in str(e)
      and "A123456789" not in audit_txt and "PSCNET" not in audit_txt,
      "an order signing error never carries the national id or certificate — exception or audit", str(e))

# reduce → the row's own productid, even after the near month rolled past it
snapshot([{"root": "TMF", "productid": "TMFA0", "net": 2, "net_current": 2}])
api = use([ACK])
r = op.close_position_partial({}, "TMF", "long", 1, client_order_id="flat20260930120000123456")
check(api.sent[-1].productid == "TMFA0" and api.sent[-1].bs == "S" and api.sent[-1].opencloseflag == "1"
      and r["exchange"] == "president",
      "close: the held row's productid, opencloseflag '1'", vars(api.sent[-1]))
check(r["ack"] == "0000" and r["statuscode"] == "0000" and r["seq"] == "S1" and r["orderno"] == "O1",
      "the close carries the broker's ack / statuscode / seq / orderno like an entry", r)
check(raises(op.PresidentError, lambda: op.close_position_partial({}, "TMF", "long", 1)) is not None
      and len(api.sent) == 1, "a snapshot older than that contract's last order → refused, not sent")
last = op.last_order_at("TMFA0")
snapshot([{"root": "TMF", "productid": "TMFA0", "net": 2, "net_current": 2}], query_started_at=last - 1,
         read_at=last + 30)
check(raises(op.PresidentError, lambda: op.close_position_partial({}, "TMF", "long", 1)) is not None
      and len(api.sent) == 1, "a read that STARTED before the send (written after it) → refused")
snapshot([{"root": "TMF", "productid": "TMFA0", "net": 2, "net_current": 2}],
         query_started_at=last + president_vault.ORDER_SETTLE_S - 1)
check(raises(op.PresidentError, lambda: op.close_position_partial({}, "TMF", "long", 1)) is not None
      and len(api.sent) == 1, "a read started inside the settle margin → refused")
snapshot([{"root": "TMF", "productid": "TMFA0", "net": 2, "net_current": 2}])
e = raises(op.DuplicateOrder, lambda: op.close_position_partial({}, "TMF", "long", 1,
                                                               client_order_id="flat20260930120000123456"))
check(e is not None and len(api.sent) == 1, "the same client id again today → refused locally")
e = raises(op.PresidentError, lambda: op.close_position_partial({}, "TMF", "short", 1))
check(e is not None and "add to it" in str(e) and len(api.sent) == 1, "closing the wrong side → refused", e)
e = raises(op.PresidentError, lambda: op.close_position_partial({}, "TMF", "long", 3))
check(e is not None and "only 2 held" in str(e) and len(api.sent) == 1, "closing more than held → refused", e)
snapshot([])
check(raises(op.PresidentError, lambda: op.place_futures_market_order({}, "TMF", "buy", 1, "reduce")) is not None
      and len(api.sent) == 1, "a reduce with nothing held → refused, not sent")
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
e = raises(RuntimeError, lambda: account_president.get_positions({}))
check(e is not None and "TMFJ6 -2" in str(e) and "TMFK6 +1" in str(e),
      "one root open in two months fails the read, naming both", e)
snapshot([{"root": "TXF", "productid": "TXFJ6", "net": 1, "net_current": 1},
          {"root": "TMF", "productid": "TMFK6", "net": -1, "net_current": -1},
          {"root": "MXF", "productid": "MXFJ6", "net": 0, "net_current": 0}])
check(account_president.get_positions({}) == {"TXF": {"side": "long", "size": 1.0, "productid": "TXFJ6"},
                                              "TMF": {"side": "short", "size": 1.0, "productid": "TMFK6"}},
      "positions: canonical keys, lots, productid", account_president.get_positions({}))
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
check(pr["root"] == "MXF" and pr["net"] == 1 and pr["point_value"] == 50,
      "worker parses the test host's preloaded MXF row", pr)
live_row = Resp(product="MXF", call_put="", productid="MXFJ6", month="202610", ot_qty_b=3, ot_qty_s=0,
                current_buy_open_position=2, current_sell_open_position=0,
                open_buy_position_average_cost=0.0, open_sell_position_average_cost=0.0,
                floating_pnl=0.0, product_base_number=50)
pr = president_worker.position_row(live_row)
check(pr["net"] == 2 and pr["debug_ot_net"] == 3,
      "live account shape (ot_qty_b=3, current_buy=2, app shows 2): net reads current_*", pr)


class FakeDaccount:
    def __init__(self, margin):
        self.margin, self.asked = margin, []

    def get_margin(self, actno, cur):
        self.asked.append(cur)
        return self.margin if cur == "NTT" else Resp(ok=False, error="查無資料!", data=None)

    def get_position(self, actno, g, t):
        return Resp(ok=True, error="", data=[live_row])


DM = dict(optequity=11454097.0, ordcexcess=9000000.0, iamt=105150.0, mamt=80700.0, dwamt=0.0,
          update_date="20261002", update_time="101500")
for shape, data in (("single object", Resp(**DM)), ("list", [Resp(**DM)])):
    fake = types.SimpleNamespace(daccount=FakeDaccount(Resp(ok=True, error="", data=data)))
    snap = president_worker.read_account(fake, "7000001")
    check(fake.daccount.asked == ["NTT"] and snap["equity"] == 11454097.0 and snap["available"] == 9000000.0
          and snap["initial_margin"] == 105150.0 and snap["maintenance_margin"] == 80700.0
          and snap["margin_error"] is None,
          f"get_margin(actno, 'NTT') with .data as a {shape}: optequity / ordcexcess / iamt / mamt", snap)
sparse = Resp(optequity=500000.0, ordcexcess=None, iamt=None, mamt=None, dwamt=None,
              update_date=None, update_time=None)
fake = types.SimpleNamespace(daccount=FakeDaccount(Resp(ok=True, error="", data=sparse)))
snap2 = president_worker.read_account(fake, "7000001")
check(snap2["equity"] == 500000.0 and snap2["available"] is None and snap2["day_flow"] is None
      and snap2["margin_updated"] is None and snap2["margin_error"] is None,
      "side margin fields missing → None, the round still writes a snapshot", snap2)
fake = types.SimpleNamespace(daccount=FakeDaccount(Resp(ok=True, error="", data=Resp(optequity=None))))
snap3 = president_worker.read_account(fake, "7000001")
check(snap3["equity"] is None and snap3["margin_error"] == "optequity missing",
      "optequity missing is the one margin failure (equity unknown, read error)", snap3)
snapshot([], **{k: snap[k] for k in ("equity", "available", "initial_margin", "maintenance_margin")})
eq = account_president.get_equity({})
check(eq["equity"] == 11454097.0 and eq["maintenance_margin"] == 80700.0 and eq["available"] == 9000000.0,
      "get_equity reports optequity, lists the margins", eq)
check(president_worker.position_row(Resp(product="TXO", call_put="C", productid="TXO23000J6")) is None,
      "option rows are not futures positions")
check(raises(RuntimeError, lambda: president_worker.position_row(
    Resp(product="TXF", call_put="", productid="TXF202610"))) is not None, "unreadable TXF code fails")
check(president_worker.maintenance(T(2026, 10, 1, 5, 40)) == "login"
      and president_worker.maintenance(T(2026, 10, 1, 7, 29)) == "account"
      and president_worker.maintenance(T(2026, 10, 1, 7, 30)) is None
      and president_worker.maintenance(T(2026, 10, 1, 5, 55)) is None,
      "maintenance windows 05:30–05:50 / 06:00–07:30 Taipei")

# ── 8. settlement-day entries stay in a held expiring month ─────────────────
ROWS_J = [{"root": "TXF", "productid": "TXFJ6", "net": 1, "net_current": 1}]
for when in (T(2026, 10, 20, 15, 0), T(2026, 10, 21, 2, 0), T(2026, 10, 21, 9, 0)):
    check(op.entry_contract("TXF", ROWS_J, when) == "TXFJ6",
          f"window {when:%m-%d %H:%M} holding J6 → the addition goes to J6 (never two months)")
check(op.entry_contract("TXF", [], T(2026, 10, 20, 15, 0)) == "TXFK6", "window start, flat → K6")
check(op.entry_contract("MXF", ROWS_J, T(2026, 10, 21, 9, 0)) == "MXFK6", "another root's J6 does not count")
check(op.entry_contract("TXF", ROWS_J, T(2026, 10, 22, 10, 0)) == "TXFJ6",
      "holiday-postponed settlement: J6 still held after the computed roll → still added to J6, "
      "not K6 beside it (the broker list decides whether it still trades)")
check(op.entry_contract("TXF", [{"root": "TXF", "productid": "TXFK6", "net": -1}], T(2026, 10, 1, 10, 0))
      == "TXFK6", "a held far month is added to, not the near month beside it")
check(raises(op.PresidentError, lambda: op.entry_contract(
    "TXF", ROWS_J + [{"root": "TXF", "productid": "TXFK6", "net": 1}], T(2026, 10, 21, 9, 0))) is not None,
      "two months already held → no entry")

# postponed settlement through the order path: listed → trades, delisted → refused
snapshot([{"root": "TMF", "productid": "TMFA0", "net": 1}])
api = use([ACK])
NOW_LIST.append("TMFA0")
op.place_futures_market_order({}, "TMF", "buy", 1, "entry", confirm_timeout=0.3)
check(api.sent[-1].productid == "TMFA0", "held month still in the broker's list → the addition goes there",
      vars(api.sent[-1]))
NOW_LIST.remove("TMFA0")
api = use([ACK])
e = raises(op.PresidentError, lambda: op.place_futures_market_order({}, "TMF", "buy", 1, "entry"))
check(e is not None and "TMFA0" in str(e) and not api.sent,
      "held month the broker no longer lists → refused, nothing sent", e)
snapshot([])

# a send marker that cannot be written stops the order
real_path = op.LAST_ORDER_PATH
op.LAST_ORDER_PATH = os.path.join(TMP, "no-such-dir-file", "x")
open(os.path.join(TMP, "no-such-dir-file"), "w").close()  # a file where the directory should be
api = use([ACK])
e = raises(op.PresidentError, lambda: op.place_futures_market_order({}, "TMF", "buy", 1, "entry"))
check(e is not None and "marker" in str(e) and not api.sent, "marker write fails → nothing sent", e)
op.LAST_ORDER_PATH = real_path

# ── 9. two processes closing at once: only one passes ────────────────────────
import subprocess  # noqa: E402
snapshot([{"root": "MXF", "productid": "MXFJ6", "net": 1, "net_current": 1}])
open(op.LAST_ORDER_PATH, "w").write("{}")
GO = os.path.join(TMP, "go")
child = f"""
import os, sys, time
sys.path.insert(0, {ROOT!r}); os.chdir({TMP!r})
from lib import account_president, order_president as op
account_president._SNAPSHOT = {account_president._SNAPSHOT!r}
op.LAST_ORDER_PATH, op.SEND_LOCK_PATH = {op.LAST_ORDER_PATH!r}, {op.SEND_LOCK_PATH!r}
op._REFRESH_FLAG = {op._REFRESH_FLAG!r}
while not os.path.exists({GO!r}):
    time.sleep(0.001)
try:
    real = op._checked_close
    def slow(*a):
        pid = real(*a)
        time.sleep(0.2)  # widen the check→mark window a lock-free version would lose in
        return pid
    op._checked_close = slow
    op._claim("MXF", "sell", 1, "reduce")
    print("PASS")
except op.PresidentError:
    print("REFUSED")
"""
procs = [subprocess.Popen([sys.executable, "-c", child], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                          text=True) for _ in range(2)]
_t.sleep(1.0)
open(GO, "w").close()
outs = sorted(p.communicate(timeout=60)[0].strip() for p in procs)
check(outs == ["PASS", "REFUSED"], "two processes closing the same position at once: exactly one passes", outs)

# ── 10. P1-C: a slow login does not eat the settle margin ─────────────────────
saved_settle = president_vault.ORDER_SETTLE_S
president_vault.ORDER_SETTLE_S = 1.0  # scaled: login 2 s against a 1 s margin = 25 s against 20 s
snapshot([])
open(op.LAST_ORDER_PATH, "w").write("{}")
slow = use([ACK])


class _Slow:
    def __enter__(self):
        _t.sleep(2.0)  # the login
        return slow

    def __exit__(self, *a):
        slow.logout()


op._session = lambda env: _Slow()
t_call = _t.time()
op.place_futures_market_order({}, "TMF", "buy", 1, "entry", confirm_timeout=0.3)
marker = op.last_order_at(NOW_LIST[0])
check(marker >= t_call + 2.0, "the marker is re-written at the send, after the slow login", marker - t_call)
snapshot([], query_started_at=t_call + 1.5)
ok, _q, _l = op.snapshot_caught_up()
check(not ok, "a read started before the send's margin is not 'caught up', however slow the login was")
president_vault.ORDER_SETTLE_S = saved_settle

holder = subprocess.Popen([sys.executable, "-c", f"""
import os, sys, time
sys.path.insert(0, {ROOT!r}); os.chdir({TMP!r})
from lib import order_president as op
op.SEND_LOCK_PATH = {op.SEND_LOCK_PATH!r}
with op._send_lock():
    print("HELD", flush=True)
    time.sleep(60)
"""], stdout=subprocess.PIPE, text=True)
check(holder.stdout.readline().strip() == "HELD", "child holds the send lock")
t0 = _t.time()
try:
    with op._os_lock(op.SEND_LOCK_PATH, 0.5, "send lock"):
        took_while_held = True
except op.PresidentError:
    took_while_held = False
check(not took_while_held, "while it is held, another process cannot take it")
holder.kill()
holder.wait()
with op._send_lock():
    took = _t.time() - t0
check(took < 5, "killed holder → the lock is free at once (no stale-file wait)", took)

# ── 6. login: no national id leaves, auth failures block every later login ──
import contextlib, io  # noqa: E402
president_vault.in_login_maintenance = lambda now=None: False
president_worker.maintenance = lambda now=None: None
LOGIN_SCRIPT = []


class FakeUnitrade:
    logins = 0

    def __init__(self):
        self.test_mode, self.out = True, False

    def login(self, url, user, pw, ca, ca_pw):
        FakeUnitrade.logins += 1
        return LOGIN_SCRIPT.pop(0)

    def logout(self):
        self.out = True

    def get_accounts(self):
        return ["7000001"]


_utu.Unitrade = FakeUnitrade
president_worker.PROBE_PATH = os.path.join(TMP, "state", "president_probe.json")
president_worker.SDK_LOG_DIR = os.path.join(TMP, "state", "president_logs")
envfile(BASE)
creds = president_vault.resolve()

LOGIN_SCRIPT[:] = [Resp(ok=False, error=SIGN_LEAK)]
out = io.StringIO()
with contextlib.redirect_stdout(out):
    rc = president_worker.run_once()
probe = open(president_worker.PROBE_PATH, encoding="utf-8").read()
check(rc == 2 and "CERT_MISMATCH" in probe, "certificate/account mismatch is classified", probe)
leaks = [where for where, txt in (("probe", probe), ("stdout", out.getvalue()))
         if "A123456789" in txt or "PSCNET" in txt or "subject" in txt]
check(not leaks, "the national id / certificate never reaches the probe file or stdout", leaks)
n = FakeUnitrade.logins
e = raises(president_vault.LoginError, lambda: president_vault.login(creds, president_worker.SDK_LOG_DIR))
check(e is not None and e.kind == "BLOCKED" and FakeUnitrade.logins == n,
      "after an auth failure every later login is refused without reaching the broker", e)
block = open(president_vault.BLOCK, encoding="utf-8").read()
check("P" not in json.loads(block).values() and "A123456789" not in block, "the block file holds no secret", block)
envfile(dict(BASE, president_password="P2"))
LOGIN_SCRIPT[:] = [Resp(ok=True, error="")]
api2 = president_vault.login(president_vault.resolve(), president_worker.SDK_LOG_DIR)
check(FakeUnitrade.logins == n + 1 and not os.path.exists(president_vault.BLOCK),
      "changed credentials in .env lift the block; a good login clears it")
api2.logout()
LOGIN_SCRIPT[:] = [Resp(ok=False, error="[APGW]something unexpected"),
                   Resp(ok=False, error="[APGW]something unexpected")]
creds2 = president_vault.resolve()
for _ in range(2):
    raises(president_vault.LoginError, lambda: president_vault.login(creds2, president_worker.SDK_LOG_DIR))
e = raises(president_vault.LoginError, lambda: president_vault.login(creds2, president_worker.SDK_LOG_DIR))
check(e is not None and e.kind == "BLOCKED" and FakeUnitrade.logins == n + 3,
      "two unclassifiable rejections block the third try (統一 locks at three)", e)
os.remove(president_vault.BLOCK)
LOGIN_SCRIPT[:] = [Resp(ok=False, error="密碼錯誤,請重新輸入!")]
check(raises(president_vault.LoginError, lambda: president_vault.login(creds2, president_worker.SDK_LOG_DIR)).kind
      == "PASSWORD", "a password answer is PASSWORD")
os.remove(president_vault.BLOCK)
for text, kind in (("Timeout", "TIMEOUT"), ("HTTPSConnectionPool(host='x'): Max retries exceeded", "HOST")):
    LOGIN_SCRIPT[:] = [Resp(ok=False, error=text)]
    got = raises(president_vault.LoginError, lambda: president_vault.login(creds2, president_worker.SDK_LOG_DIR))
    check(got.kind == kind and not os.path.exists(president_vault.BLOCK), f"{kind} does not count toward a block")
president_vault.in_login_maintenance = lambda now=None: True
LOGIN_SCRIPT[:] = []
got = raises(president_vault.LoginError, lambda: president_vault.login(creds2, president_worker.SDK_LOG_DIR))
check(got.kind == "MAINTENANCE", "no login is attempted in 05:30–05:50")
check(president_vault.sanitize("x A123456789 TWA1234567891 {'a': 1} y") == "x <id> <id> {…} y",
      "sanitize strips ids and blobs")
for pid in ("A123456789", "B287654321", "A800000014", "F912345678", "AB12345678", "TWA8000000141"):
    got = president_vault.sanitize(f"sign error {pid} tail")
    check(pid not in got and president_vault.classify(f":!! {pid}") == "CERT_MISMATCH",
          f"id shape {pid[:2]}… stripped and classified", got)

# unblock: one try, a failure re-blocks, a success clears
os.path.exists(president_vault.BLOCK) and os.remove(president_vault.BLOCK)
president_vault.in_login_maintenance = lambda now=None: False
LOGIN_SCRIPT[:] = [Resp(ok=False, error="密碼錯誤")]
raises(president_vault.LoginError, lambda: president_vault.login(creds2, president_worker.SDK_LOG_DIR))
check(president_vault.unblock() == "released", "--unblock releases the block")
n = FakeUnitrade.logins
LOGIN_SCRIPT[:] = [Resp(ok=False, error="密碼錯誤")]
got = raises(president_vault.LoginError, lambda: president_vault.login(creds2, president_worker.SDK_LOG_DIR))
got2 = raises(president_vault.LoginError, lambda: president_vault.login(creds2, president_worker.SDK_LOG_DIR))
check(got.kind == "PASSWORD" and got2.kind == "BLOCKED" and FakeUnitrade.logins == n + 1,
      "after --unblock exactly one login reaches the broker; its failure blocks again")
n = FakeUnitrade.logins
check(president_vault.unblock() == "used"
      and raises(president_vault.LoginError,
                 lambda: president_vault.login(creds2, president_worker.SDK_LOG_DIR)).kind == "BLOCKED"
      and FakeUnitrade.logins == n,
      "a second --unblock on the same block is refused; no login reaches the broker")
os.remove(president_vault.BLOCK)
LOGIN_SCRIPT[:] = [Resp(ok=False, error="密碼錯誤")]
raises(president_vault.LoginError, lambda: president_vault.login(creds2, president_worker.SDK_LOG_DIR))
president_vault.unblock()
LOGIN_SCRIPT[:] = [Resp(ok=False, error="HTTPSConnectionPool(host='x'): Max retries exceeded"),
                   Resp(ok=True, error="")]
got = raises(president_vault.LoginError, lambda: president_vault.login(creds2, president_worker.SDK_LOG_DIR))
check(got.kind == "HOST", "the released try hit a network error")
president_vault.login(creds2, president_worker.SDK_LOG_DIR).logout()
check(not os.path.exists(president_vault.BLOCK) and not os.path.exists(president_vault.BLOCK + ".claim"),
      "a network failure did not spend it: the next login went through and cleared the block")
LOGIN_SCRIPT[:] = [Resp(ok=False, error="密碼錯誤")]
raises(president_vault.LoginError, lambda: president_vault.login(creds2, president_worker.SDK_LOG_DIR))
president_vault.unblock()
LOGIN_SCRIPT[:] = [Resp(ok=False, error="密碼錯誤")]
raises(president_vault.LoginError, lambda: president_vault.login(creds2, president_worker.SDK_LOG_DIR))
check(president_vault.unblock() == "used", "spent")
creds3 = dict(creds2, password="P3")
LOGIN_SCRIPT[:] = [Resp(ok=False, error="密碼錯誤")]
raises(president_vault.LoginError, lambda: president_vault.login(creds3, president_worker.SDK_LOG_DIR))
check(president_vault.unblock() == "released", "new credentials failing → a new block with its own release")
LOGIN_SCRIPT[:] = [Resp(ok=True, error="")]
president_vault.login(creds3, president_worker.SDK_LOG_DIR).logout()

# a released try that times out is spent (the broker may have checked the password)
LOGIN_SCRIPT[:] = [Resp(ok=False, error="密碼錯誤")]
raises(president_vault.LoginError, lambda: president_vault.login(creds3, president_worker.SDK_LOG_DIR))
president_vault.unblock()
LOGIN_SCRIPT[:] = [Resp(ok=False, error="Timeout")]
got = raises(president_vault.LoginError, lambda: president_vault.login(creds3, president_worker.SDK_LOG_DIR))
n = FakeUnitrade.logins
got2 = raises(president_vault.LoginError, lambda: president_vault.login(creds3, president_worker.SDK_LOG_DIR))
check(got.kind == "TIMEOUT" and got2.kind == "BLOCKED" and FakeUnitrade.logins == n,
      "a TIMEOUT on the released try is not given back")
os.remove(president_vault.BLOCK)

# the certificate is fingerprinted by its bytes: equivalent path spellings are one certificate
pfx = os.path.join(TMP, "Cert.pfx")
open(pfx, "wb").write(b"pfx-bytes-1")
a1 = dict(creds3, ca_path=pfx)
for alias in (pfx.replace("Cert.pfx", "./Cert.pfx"), os.path.relpath(pfx), pfx + ""):
    check(president_vault.fingerprint(dict(a1, ca_path=alias)) == president_vault.fingerprint(a1),
          f"same certificate via {alias!r} → same fingerprint")
open(pfx, "wb").write(b"pfx-bytes-renewed")
fp_new = president_vault.fingerprint(a1)
open(pfx, "wb").write(b"pfx-bytes-1")
check(fp_new != president_vault.fingerprint(a1), "a renewed certificate (new bytes) is a new fingerprint")

# ── 7. reconciler block: split close / entry, never open behind an unconfirmed close ──
os.makedirs("manager", exist_ok=True)
json.dump({"exchanges": {"s1": "president"}}, open("manager/portfolio_config.json", "w"))
from manager import reconciler  # noqa: E402
sent_legs = []
FILL = {}


def fake_place(env, sym, action, lots, intent, **kw):
    sent_legs.append((sym, action, lots, intent))
    st = FILL.get(intent, "filled")
    return {"status": st, "fill_qty": float(lots if st == "filled" else 0), "avg_fill_price": 100.0,
            "symbol": sym + "J6"}


real_place = op.place_futures_market_order
op.place_futures_market_order = fake_place
try:
    open(op.LAST_ORDER_PATH, "w").write("{}")
    snapshot([{"root": "TMF", "productid": "TMFJ6", "net": 2, "net_current": 2}])
    check(reconciler.get_positions() == {"TMF": {"side": "long", "size": 2.0, "exchange": "president"}},
          "routed to president → the worker snapshot, in lots", reconciler.get_positions())
    sent_legs.clear()
    r = reconciler.place_order("TMF", -3.4, exchange="president")
    check(sent_legs == [("TMF", "sell", 2, "reduce"), ("TMF", "sell", 1, "entry")] and r["executed_qty"] == 3,
          "a flip: close the held 2, then open 1 short", sent_legs)
    sent_legs.clear()
    reconciler.place_order("TMF", -3, exchange="president", reduce_only=True)
    check(sent_legs == [("TMF", "sell", 2, "reduce")], "reduce_only: the close leg only", sent_legs)
    sent_legs.clear()
    FILL["reduce"] = "sent"
    r = reconciler.place_order("TMF", -3, exchange="president")
    check(sent_legs == [("TMF", "sell", 2, "reduce")] and r["status"] == "sent",
          "an unconfirmed close → no entry behind it", sent_legs)
    FILL.clear()
    sent_legs.clear()
    reconciler.place_order("TMF", 0.4, exchange="president")
    check(sent_legs == [], "under half a lot → nothing")
    open("state/HALT", "w").write("{}")
    sent_legs.clear()
    reconciler.place_order("TMF", -3, exchange="president")
    check(sent_legs == [("TMF", "sell", 2, "reduce")], "HALT: the close goes, the flip's entry does not", sent_legs)
    os.remove("state/HALT")

    def entry_fails(env, sym, action, lots, intent, **kw):
        if intent == "entry":
            raise op.PresidentError("contract TMFK6 is not in the broker's contract list")
        return fake_place(env, sym, action, lots, intent)
    op.place_futures_market_order = entry_fails
    r = reconciler.place_order("TMF", -3, exchange="president")
    errs = json.load(open("manager/order_errors.json", encoding="utf-8"))
    check(isinstance(r, dict) and r["executed_qty"] == 2 and "反向開倉失敗" in errs[-1]["error"],
          "close filled + entry failed: the close is returned for the book, the entry failure recorded", r)
    def entry_deferred(env, sym, action, lots, intent, **kw):
        if intent == "entry":
            raise op.EntryDeferred("settlement window: snapshot not caught up")
        return fake_place(env, sym, action, lots, intent)
    op.place_futures_market_order = entry_deferred
    n_err = len(json.load(open("manager/order_errors.json", encoding="utf-8")))
    r = reconciler.place_order("TMF", -3, exchange="president")
    errs = json.load(open("manager/order_errors.json", encoding="utf-8"))
    check(isinstance(r, dict) and r["executed_qty"] == 2 and r["entry_deferred"] == 1 and len(errs) == n_err,
          "settlement-window flip: the close is booked, the entry is 'deferred', no order_error", r)

    def unk(env, sym, action, lots, intent, **kw):
        r = fake_place(env, sym, action, lots, intent)
        if intent == "entry":
            r.update(status="unknown", fill_qty=0.0, ack="0099")
        return r
    op.place_futures_market_order = unk
    snapshot([])
    r = reconciler.place_order("TMF", 1, exchange="president")
    errs = json.load(open("manager/order_errors.json", encoding="utf-8"))
    check(r["status"] == "unknown" and not any(e.get("kind") == "order_status_unknown" for e in errs)
          and len(errs) == n_err,
          "an unknown status stays 'unknown' in the result but never reaches order_errors "
          "(every row there is a P1 order_error on the platform)", r)
    op.place_futures_market_order = fake_place
    json.dump({"TMFJ6": __import__("time").time()}, open(op.LAST_ORDER_PATH, "w"))
    snapshot([{"root": "TMF", "productid": "TMFJ6", "net": 2, "net_current": 2}],
             query_started_at=__import__("time").time() + 1)
    e = raises(reconciler.CapitalCacheLagError, reconciler.get_positions)
    check(isinstance(e, reconciler.PresidentCacheLagError), "a snapshot older than the last send → skip the round")
    check(reconciler._current_venue() == "president", "the venue for classification is president")
finally:
    op.place_futures_market_order = real_place

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
