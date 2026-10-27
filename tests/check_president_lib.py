"""統一期貨 lib without a broker — near-month roll, confirmation, guards, snapshot.

1. near_month: entries roll at 15:00 Taipei the day before the third-Wednesday
   13:30 settlement (14:59:59 stays, 15:00:00 rolls; the backtest's TXFR1 keeps
   the expiring month through its 13:30 close and starts the next month with
   the 15:00 evening bar), December rolls into next year's A contract, a computed contract
   missing from the broker's list is refused, naive times are refused.
2. Orders (Unitrade faked): an entry goes to the computed near month, a
   reduce to the held row's own productid (even when the near month has
   rolled past it); issend=False and a 9999 reply raise; 0000 with no fill is
   'sent' (never resubmitted); an IOC cancel (0002) settles early; fills come
   from on_match via the orderno of OUR seq's reply; HALT blocks entries not
   closes; a client_tag is refused the second time today; the session is
   logged out on every path.
3. Host gate: production only from the vault's "live": true (the binding flow
   writes it); a PRESIDENT_LIVE line in .env is refused, a caller mapping
   ignored, an absent / unreadable / non-boolean vault means test hosts only.
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
from lib import president_contracts as pc  # noqa: E402

# the order and read paths take "now" from the wall clock — pin it: 10-20 16:00 is
# inside the October roll window (front month J6, entries to K6), so both are the
# bot's months and nothing here depends on the day the test runs
FIXED_NOW = datetime(2026, 10, 20, 16, 0, tzinfo=TAIPEI)
_real_now = pc._now
pc._now = lambda now: _real_now(now or FIXED_NOW)

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
president_vault.STOP = os.path.join(TMP, "state", "president_login_stop.json")
president_vault.VAULT = os.path.join(TMP, "credentials", "president_vault.json")
os.makedirs(os.path.dirname(president_vault.VAULT), exist_ok=True)
PFX = os.path.join(TMP, "c.pfx")
open(PFX, "wb").write(b"not-a-real-pfx")
BASE = {"president_account": "A", "president_password": "P", "president_ca_path": PFX,
        "president_ca_password": "", "president_test_url": "https://test167.testpfctrade.com"}


def envfile(d, bom=False):
    with open(president_vault.ENV_PATH, "w", encoding="utf-8-sig" if bom else "utf-8") as f:
        f.write("".join(f"{k}={v}\n" for k, v in d.items()))


def vault(content):
    if content is None:
        if os.path.exists(president_vault.VAULT):
            os.remove(president_vault.VAULT)
        return
    with open(president_vault.VAULT, "w", encoding="utf-8") as f:
        f.write(content if isinstance(content, str) else json.dumps(content))


LIVE_URL = "https://viploginm.pfctrade.com"
vault(None)
envfile(BASE)
check(president_vault.resolve()["url"] == "https://test167.testpfctrade.com", "test host accepted")
check(president_vault.resolve({"PRESIDENT_LIVE": "true", "president_url": "https://x.example"})["live"] is False,
      "a caller-supplied mapping cannot switch production on")
for bad in ("https://test167.pfctrade.com", "https://www.pfctrade.com", "http://x.testpfctrade.com",
            "https://evil.com/.testpfctrade.com"):
    envfile(dict(BASE, president_test_url=bad))
    check(raises(ValueError, lambda: president_vault.resolve()) is not None, f"production off: {bad} refused")
envfile(dict(BASE, PRESIDENT_LIVE="true", president_url=LIVE_URL))
e = raises(ValueError, lambda: president_vault.resolve())
check(e is not None and "PRESIDENT_LIVE" in str(e), "PRESIDENT_LIVE=true in .env alone → refused, not obeyed", e)
for label, content in (("JSON string \"true\"", {"live": "true"}), ("live: 1", {"live": 1}),
                       ("not JSON", "{live: true"), ("a list", [True]), ("no live key", {"president_password": "x"})):
    vault(content)
    envfile(dict(BASE, president_url=LIVE_URL))
    check(president_vault.live() is False and president_vault.resolve()["url"] == "https://test167.testpfctrade.com",
          f"vault {label} → production off, test host used")
vault(None)
os.makedirs(president_vault.VAULT)
check(president_vault.live() is False, "vault unreadable (a directory) → production off")
os.rmdir(president_vault.VAULT)
vault({"live": True})
for good in (LIVE_URL, "https://viploginb.pfctrade.com/"):
    envfile(dict(BASE, president_url=good))
    check(president_vault.resolve()["url"] == good.rstrip("/") and president_vault.resolve()["live"],
          f"vault live: {good} accepted")
for bad in ("https://test167.testpfctrade.com", "https://evil.example", "http://viploginm.pfctrade.com",
            "https://viploginm.pfctrade.com.evil.example"):
    envfile(dict(BASE, president_url=bad))
    check(raises(ValueError, lambda: president_vault.resolve()) is not None, f"vault live: {bad} refused")
envfile(dict(BASE, PRESIDENT_LIVE="true", president_url=LIVE_URL))
check(president_vault.resolve()["url"] == LIVE_URL and president_vault.resolve()["live"],
      "vault live + a leftover PRESIDENT_LIVE line → production, president_url")
envfile(BASE)
check(raises(ValueError, lambda: president_vault.resolve()) is not None, "vault live without president_url refused")
vault(None)
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
snapshot([{"root": "TMF", "productid": "TMFJ6", "net": 2, "net_current": 2}])
api = use([ACK])
r = op.close_position_partial({}, "TMF", "long", 1, client_order_id="flat20260930120000123456")
check(api.sent[-1].productid == "TMFJ6" and api.sent[-1].bs == "S" and api.sent[-1].opencloseflag == "1"
      and r["exchange"] == "president",
      "close: the held row's productid, opencloseflag '1'", vars(api.sent[-1]))
check(r["ack"] == "0000" and r["statuscode"] == "0000" and r["seq"] == "S1" and r["orderno"] == "O1",
      "the close carries the broker's ack / statuscode / seq / orderno like an entry", r)
check(raises(op.PresidentError, lambda: op.close_position_partial({}, "TMF", "long", 1)) is not None
      and len(api.sent) == 1, "a snapshot older than that contract's last order → refused, not sent")
last = op.last_order_at("TMFJ6")
snapshot([{"root": "TMF", "productid": "TMFJ6", "net": 2, "net_current": 2}], query_started_at=last - 1,
         read_at=last + 30)
check(raises(op.PresidentError, lambda: op.close_position_partial({}, "TMF", "long", 1)) is not None
      and len(api.sent) == 1, "a read that STARTED before the send (written after it) → refused")
snapshot([{"root": "TMF", "productid": "TMFJ6", "net": 2, "net_current": 2}],
         query_started_at=last + president_vault.ORDER_SETTLE_S - 1)
check(raises(op.PresidentError, lambda: op.close_position_partial({}, "TMF", "long", 1)) is not None
      and len(api.sent) == 1, "a read started inside the settle margin → refused")
snapshot([{"root": "TMF", "productid": "TMFJ6", "net": 2, "net_current": 2}])
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
snapshot([{"root": "TMF", "productid": "TMFJ6", "net": 1, "net_current": 1},
          {"root": "TMF", "productid": "TMFK6", "net": 1, "net_current": 1}])
check(raises(op.PresidentError, lambda: op.close_position_partial({}, "TMF", "long", 1)) is not None,
      "a root open in two months is not closed by root")
check(raises(ValueError, lambda: op.place_futures_market_order({}, "TMFJ6", "buy", 1, "entry")) is not None,
      "an entry must name the root, not a month")

open("state/HALT", "w").write("{}")
api = use([ACK])
check(raises(guard.Halted, lambda: op.place_futures_market_order({}, "TMF", "buy", 1, "entry")) is not None
      and not api.sent, "HALT: entry refused before login")
snapshot([{"root": "TMF", "productid": "TMFJ6", "net": 1, "net_current": 1}])
check(raises(guard.Halted, lambda: op.place_futures_market_order({}, "TMF", "sell", 1, "reduce",
                                                                 confirm_timeout=0.4)) is not None
      and not api.sent, "HALT: reduce refused too (full freeze)")
with guard.halt_close_pass("TMF", "test"):
    r = op.place_futures_market_order({}, "TMF", "sell", 1, "reduce", confirm_timeout=0.4)
check(len(api.sent) == 1, "HALT: the user's close (inside the close pass) is sent")
os.remove("state/HALT")
check(all(a.logged_out for a in apis), "every session logged out")
audits = [json.loads(line)["event"] for line in open("state/audit.jsonl")]
check({"order_sent", "order_error", "order_filled", "order_denied_halt", "order_allowed_halt_close"} <= set(audits), "audit trail", set(audits))

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
_NO_DETAIL = {"entry_price": None, "unrealized_pnl": None, "margin": None, "leverage": None}
check(account_president.get_positions({}) == {"TXF": {"side": "long", "size": 1.0, "productid": "TXFJ6",
                                                      **_NO_DETAIL},
                                              "TMF": {"side": "short", "size": 1.0, "productid": "TMFK6",
                                                      **_NO_DETAIL}},
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


# the margin stamp is kept within margin_epoch's 12 h clock guard: "now" in Taipei, to the second
NOW_TP = datetime.now(TAIPEI).replace(microsecond=0)
DM = dict(optequity=11454097.0, ordcexcess=9000000.0, iamt=105150.0, mamt=80700.0, dwamt=0.0,
          update_date=NOW_TP.strftime("%Y%m%d"), update_time=NOW_TP.strftime("%H%M%S"))
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
# assets page (spec president-assets): update_date/time → epoch seconds in the snapshot, through
# get_equity, through the runtime account reader into the entry; absent keys stay absent
UPD = int(NOW_TP.timestamp())
T0 = int(datetime(2026, 10, 2, 10, 15, 0, tzinfo=TAIPEI).timestamp())
me = president_worker.margin_epoch
check(snap["margin_updated_at"] == UPD and snap2["margin_updated_at"] is None
      and me("20261002", "1015", now=T0) == T0 and me("2026-10-02", "10:15:00", now=T0) is None,
      "margin_updated_at: update_date + update_time parsed as Taipei (HHMMSS or HHMM); unreadable → None", snap["margin_updated_at"])
check(me("20261002", "101500", now=T0 + 12 * 3600) == T0 and me("20261002", "101500", now=T0 - 12 * 3600) == T0
      and me("20261002", "101500", now=T0 + 12 * 3600 + 1) is None and me("20261002", "101500", now=T0 - 24 * 3600) is None,
      "B1 a stamp more than 12 h from the clock is dropped (night-session date semantics unverified)")
T9 = int(datetime(2026, 10, 2, 9, 30, 15, tzinfo=TAIPEI).timestamp())
check(me("20261002", 93015, now=T9) == T9 and me("20261002", "93015", now=T9) == T9 and me(20261002, 930, now=T9) == T9 - 15
      and me("20261002", "930", now=T9) == T9 - 15 and me("20261002", "0930", now=T9) == T9 - 15,
      "B2 a numeric / unpadded update_time is zero-filled before the strict check (93015 → 09:30:15, 930 → 09:30:00)")
import io, contextlib  # noqa: E402
president_worker._unparsed_logged = False
buf = io.StringIO()
with contextlib.redirect_stdout(buf):
    r1, r2 = me("20261002", "9:30", now=T9), me("20261002", "9:31", now=T9)
out = buf.getvalue()
check(r1 is None and r2 is None and out.count("unparsed update_date/update_time") == 1 and "9:30" not in out and "20261002" not in out,
      "B2 an unparsable stamp logs once (types / lengths only, never the value) and returns None", out)
snapshot([], **{k: snap[k] for k in ("equity", "available", "initial_margin", "maintenance_margin", "margin_updated_at")})
eq = account_president.get_equity({})
check(eq["equity"] == 11454097.0 and eq["maintenance_margin"] == 80700.0 and eq["available"] == 9000000.0
      and eq["margin_updated_at"] == UPD,
      "get_equity reports optequity, lists the margins and margin_updated_at", eq)
sys.path.insert(0, os.path.join(ROOT, "runtime"))
import account_reader  # noqa: E402
entry = account_reader.read_venue("president", {})
check(entry["ok"] and entry["available"] == 9000000.0 and entry["initial_margin"] == 105150.0
      and entry["maintenance_margin"] == 80700.0 and entry["margin_updated_at"] == UPD and entry["equity"] == 11454097.0,
      "account_reader.read_venue passes the four margin keys through", {k: entry.get(k) for k in ("ok", "error", "available", "margin_updated_at")})
snapshot([], equity=11454097.0, available=9000000.0)
entry = account_reader.read_venue("president", {})
check(entry["ok"] and entry["available"] == 9000000.0
      and all(k not in entry for k in ("initial_margin", "maintenance_margin", "margin_updated_at")),
      "…a key the lib did not return is absent from the entry (the page draws rows by key presence)", sorted(entry))
snapshot([], **{k: snap[k] for k in ("equity", "available", "initial_margin", "maintenance_margin", "margin_updated_at")})
check(president_worker.position_row(Resp(product="TXO", call_put="C", productid="TXO23000J6")) is None,
      "option rows are not futures positions")
check(raises(RuntimeError, lambda: president_worker.position_row(
    Resp(product="TXF", call_put="", productid="TXF202610"))) is not None, "unreadable TXF code fails")
_slept, _saved = [], (president_worker.time.sleep, president_worker.BACKOFF_PATH,
                      president_worker._write_snapshot)
president_worker.time.sleep = _slept.append
president_worker._write_snapshot = lambda snap: None
president_worker.BACKOFF_PATH = os.path.join(TMP, "president_worker_backoff_check.json")
try:
    for _n in (0, 1, 2, 3, 4, 20):
        with open(president_worker.BACKOFF_PATH, "w", encoding="utf-8") as _f:
            json.dump({"failures": _n}, _f)
        try:
            president_worker._backoff_and_exit("down")
        except SystemExit:
            pass
finally:
    president_worker.time.sleep, president_worker.BACKOFF_PATH, president_worker._write_snapshot = _saved
check(_slept == [30, 60, 120, 240, 300, 300],
      "worker backoff: 30s, 60s, … capped at 5 min (not a re-login every 30s, not a 30-min wait)", _slept)
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
# which held rows are the bot's
R = lambda pid, n=1: {"root": pid[:3], "productid": pid, "net": n}  # noqa: E731
check(pc.classify_row(R("TXFJ6"), None, T(2026, 10, 1, 10, 0)) == "bot"
      and pc.classify_row(R("TXFK6"), None, T(2026, 10, 1, 10, 0)) == "manual"
      and pc.classify_row(R("TXFK6"), None, T(2026, 10, 20, 16, 0)) == "bot",
      "bot months = front or computed entry month; a far month is manual")
check(pc.classify_row(R("TXFJ6"), ["TXFK6", "TXFL6"], T(2026, 10, 21, 14, 0)) == "settled"
      and pc.classify_row(R("TXFJ6"), ["TXFJ6", "TXFK6"], T(2026, 10, 21, 14, 0)) == "pending",
      "past settlement: settled when the read list lacks it, pending while the broker still lists it")
check(pc.classify_row(R("TXFJ6"), None, T(2026, 10, 21, 14, 0)) == "unknown"
      and pc.classify_row(R("TXFJ6"), [], T(2026, 10, 22, 9, 0)) == "unknown"
      and raises(pc.ListUnknown, lambda: pc.bot_rows([R("TXFJ6")], None, T(2026, 10, 22, 9, 0))) is not None,
      "past settlement with the list unread (or empty) → unknown, never guessed settled (a postponed J6 "
      "would get K6 opened beside it)")
check(pc.classify_row(R("TXFJ6"), ["TXFK6"], T(2026, 10, 15, 10, 0)) == "bot"
      and pc.classify_row(R("TXFJ6"), [], T(2026, 10, 15, 10, 0)) == "bot"
      and pc.classify_row(R("TXFL6"), ["TXFJ6"], T(2026, 10, 15, 10, 0)) == "manual",
      "before its settlement a held row is judged by its month alone — a short broker list never "
      "hides it (hidden, the reconciler would re-open it every round and flatten would skip it)")
keep, residue, manual = pc.bot_rows([R("TXFJ6"), R("TXFL6", -1), R("MXFL6")], None, T(2026, 10, 1, 10, 0))
check([r["productid"] for r in keep] == ["TXFJ6"] and not residue
      and [r["productid"] for r in manual] == ["TXFL6", "MXFL6"],
      "manual far months are set apart (never raised): the bot's J6 is still kept", (keep, manual))
# a flip's entry leg never goes out behind an unconfirmed close only because the close
# returns (confirm_timeout) before any snapshot can have started ORDER_SETTLE_S after it,
# so the entry always meets EntryDeferred and waits for a read that shows the close
import ast as _ast  # noqa: E402
import inspect as _inspect  # noqa: E402
_ct = _inspect.signature(op.place_futures_market_order).parameters["confirm_timeout"].default


def _call_kwargs(tree):
    return {k.arg for n in _ast.walk(tree) if isinstance(n, _ast.Call) for k in n.keywords}


_rec_fn = next(n for n in _ast.walk(_ast.parse(open(os.path.join(ROOT, "manager", "reconciler.py")).read()))
               if isinstance(n, _ast.FunctionDef) and n.name == "_president_place_order")
check(_ct < president_vault.ORDER_SETTLE_S and "confirm_timeout" not in _call_kwargs(_rec_fn)
      and "confirm_timeout" not in _call_kwargs(_ast.parse(_inspect.getsource(op.close_position_partial))),
      f"confirm_timeout ({_ct}s, the default every caller uses) < ORDER_SETTLE_S "
      f"({president_vault.ORDER_SETTLE_S}s): a flip's entry always defers behind its close")
from lib.portfolio import book_months_of  # noqa: E402
bm = book_months_of({"TXF": {"side": "long", "size": 2.0, "qty": 2.0},
                     "MXF": {"side": "long", "size": 1.0, "qty": 1.0, "months": {"2026-10": 1.0}}})
keep, residue, manual = pc.bot_rows([R("TXFJ6", 2), R("MXFJ6")], None, T(2026, 10, 1, 10, 0), book_months=bm)
check(bm == {"TXF": None, "MXF": {"2026-10"}} and not manual
      and [r["productid"] for r in keep] == ["TXFJ6", "MXFJ6"],
      "a book row with no months (replayed with no venue) leaves its root to the calendar — "
      "never 'the book holds none of it', which made the bot's own lots manual", (bm, manual))
check(raises(op.PresidentError, lambda: op.entry_contract(
    "TXF", ROWS_J + [{"root": "TXF", "productid": "TXFK6", "net": 1}], T(2026, 10, 21, 9, 0))) is not None,
      "two months already held → no entry")

# postponed settlement through the order path: listed → trades, delisted → refused
snapshot([{"root": "TMF", "productid": "TMFJ6", "net": 1}])
api = use([ACK])
NOW_LIST.append("TMFJ6")  # the broker still lists the expiring month
op.place_futures_market_order({}, "TMF", "buy", 1, "entry", confirm_timeout=0.3)
check(api.sent[-1].productid == "TMFJ6", "held month still in the broker's list → the addition goes there",
      vars(api.sent[-1]))
NOW_LIST.remove("TMFJ6")
api = use([ACK])
e = raises(op.PresidentError, lambda: op.place_futures_market_order({}, "TMF", "buy", 1, "entry"))
check(e is not None and "TMFJ6" in str(e) and not api.sent,
      "held month the broker no longer lists → refused, nothing sent", e)
snapshot([])

# a send marker that cannot be written stops the order
real_path = op.LAST_ORDER_PATH
op.LAST_ORDER_PATH = os.path.join(TMP, "no-such-dir-file", "x")
open(os.path.join(TMP, "no-such-dir-file"), "w").close()  # a file where the directory should be
api = use([ACK])
e = raises(op.PresidentError, lambda: op.place_futures_market_order({}, "TMF", "buy", 1, "entry"))
check(e is not None and not api.sent, "markers unreadable (a file where the directory should be) → nothing sent", e)
op.LAST_ORDER_PATH = real_path
real_replace = president_vault.replace_json


def _no_write(*a, **k):
    raise PermissionError(13, "denied")


president_vault.replace_json = _no_write
api = use([ACK])
e = raises(op.PresidentError, lambda: op.place_futures_market_order({}, "TMF", "buy", 1, "entry"))
president_vault.replace_json = real_replace
check(e is not None and "marker" in str(e) and not api.sent, "marker write fails → nothing sent", e)

# ── 9. two processes closing at once: only one passes ────────────────────────
import subprocess  # noqa: E402
# today's near month: a fixed month code goes past its settlement and the close is refused
# (ListUnknown, this snapshot has no broker list) before the lock is ever contested
MXF_NOW = op.near_month("MXF", [f"MXF{c}{d}" for c in op.MONTH_CODES for d in "0123456789"])
snapshot([{"root": "MXF", "productid": MXF_NOW, "net": 1, "net_current": 1}])
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
procs = [subprocess.Popen([sys.executable, "-c", child], stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                          text=True) for _ in range(2)]
_t.sleep(1.0)
open(GO, "w").close()
res = [p.communicate(timeout=60) for p in procs]
outs = sorted(o.strip() for o, _e in res)
check(outs == ["PASS", "REFUSED"], "two processes closing the same position at once: exactly one passes",
      [outs] + [e.strip().splitlines()[-1] for _o, e in res if e.strip()])

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

# ── 6. login: no national id leaves, any failed login stops every later one until the user confirms ──
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
        nxt = LOGIN_SCRIPT.pop(0)
        if isinstance(nxt, BaseException):
            raise nxt
        if callable(nxt):
            return nxt()
        return nxt

    def logout(self):
        self.out = True

    def get_accounts(self):
        return ["7000001"]


_utu.Unitrade = FakeUnitrade
check(president_vault.SDK_LOG_DIR == os.path.join(os.path.dirname(president_vault._WS), "credentials", "president_logs")
      and president_worker.SDK_LOG_DIR == op.SDK_LOG_DIR == president_vault.SDK_LOG_DIR,
      "the SDK's logs (login id = national id) go under credentials\\ next to the vault — worker and order lib alike",
      (president_vault.SDK_LOG_DIR, president_worker.SDK_LOG_DIR, op.SDK_LOG_DIR))
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
STOP = president_vault.STOP
n = FakeUnitrade.logins
e = raises(president_vault.LoginError, lambda: president_vault.login(creds, president_worker.SDK_LOG_DIR))
check(e is not None and e.kind == "STOPPED" and FakeUnitrade.logins == n,
      "after a failed login every later login is refused without reaching the broker (no automatic retry)", e)
stop = open(STOP, encoding="utf-8").read()
check(json.loads(stop).get("kind") == "CERT_MISMATCH" and "A123456789" not in stop and "P" not in json.loads(stop).values(),
      "the stop file holds the class only — no secret, no id", stop)
LOGIN_SCRIPT[:] = [Resp(ok=False, error="密碼錯誤,請重新輸入!")]
with contextlib.redirect_stdout(io.StringIO()):
    rc = president_worker.run_once()
check(rc == 2 and FakeUnitrade.logins == n + 1 and "PASSWORD" in open(president_worker.PROBE_PATH, encoding="utf-8").read(),
      "the user's 「確認登入」 (--once, explicit) reaches the broker even while stopped — once per press")
envfile(dict(BASE, president_password="P2"))
check(raises(president_vault.LoginError, lambda: president_vault.login(president_vault.resolve(), president_worker.SDK_LOG_DIR)).kind
      == "STOPPED", "new credentials in .env do not lift the stop by themselves (only a confirmed login does)")
LOGIN_SCRIPT[:] = [Resp(ok=True, error="")]
api2 = president_vault.login(president_vault.resolve(), president_worker.SDK_LOG_DIR, explicit=True)
check(FakeUnitrade.logins == n + 2 and not os.path.exists(STOP), "a confirmed login that passes clears the stop")
api2.logout()

# the daemon: a login that passes on an ID with no futures account backs off twice and stops on the
# third within an hour (counted across restarts in the backoff file; one empty list can be an SDK hiccup,
# a timer retry forever is a real login every few minutes); any login that finds the account resets it;
# a read that fails after a good login is an outage and backs off, climbing until a read succeeds
_wsaved = (president_worker.time.sleep, president_worker._write_snapshot, president_worker._quote_api,
           president_worker.read_account, president_worker.BACKOFF_PATH, FakeUnitrade.get_accounts,
           president_worker.HEARTBEAT_PATH, president_worker._sleep_until_refresh)
_wslept, _wsnaps = [], []
president_worker.HEARTBEAT_PATH = os.path.join(TMP, "state", "heartbeat", "president_worker")
president_worker.time.sleep = _wslept.append
president_worker._write_snapshot = _wsnaps.append
president_worker._quote_api = lambda api: None
president_worker.BACKOFF_PATH = os.path.join(TMP, "president_worker_backoff_main.json")


def _main_exit():
    try:
        president_worker.main()
    except SystemExit as e:
        return e.code


class _Ticked(Exception):
    pass


def _ticked():
    raise _Ticked  # the first good snapshot is written: stop the daemon loop there


def _main_run(accounts, read_fails=False, login_raises=None):
    def get_accounts(self):
        if login_raises:
            raise login_raises
        return list(accounts)
    FakeUnitrade.get_accounts = get_accounts
    president_worker.read_account = _read_fails if read_fails else (lambda api, actno: {"ok": True, "equity": 1.0,
                                                                                        "positions": []})
    LOGIN_SCRIPT[:] = [Resp(ok=True, error=""), Resp(ok=True, error="")]
    n, _wslept[:], _wsnaps[:] = FakeUnitrade.logins, [], []
    try:
        code = _main_exit()
    except _Ticked:
        code = "tick"
    try:
        stored = json.load(open(president_worker.BACKOFF_PATH, encoding="utf-8"))
    except OSError:
        stored = None
    return (code, FakeUnitrade.logins - n, list(_wslept), bool(_wsnaps and _wsnaps[-1].get("login_stopped")),
            stored and stored.get("no_account"))


def _read_fails(api, actno):
    raise RuntimeError("account query down")


def _backoff_file(**d):
    json.dump(d, open(president_worker.BACKOFF_PATH, "w", encoding="utf-8"))


president_worker._sleep_until_refresh = _ticked
try:
    os.path.exists(president_worker.BACKOFF_PATH) and os.remove(president_worker.BACKOFF_PATH)
    runs = [_main_run([]), _main_run([]), _main_run([])]
    check(runs == [(1, 1, [30], False, 1), (1, 1, [60], False, 2),
                   (president_worker.LOGIN_STOPPED_EXIT, 1, [], True, None)],
          "no futures account: 1st and 2nd back off (30s, 60s), the 3rd in a row stops (LOGIN_STOPPED_EXIT)", runs)
    runs = [_main_run([]), _main_run([]), _main_run(["7000001"], read_fails=True), _main_run([]),
            _main_run([])]
    check(runs == [(1, 1, [30], False, 1), (1, 1, [60], False, 2), (1, 2, [120], False, 0),
                   (1, 1, [240], False, 1), (1, 1, [300], False, 2)],
          "a login that finds the futures account resets the count (two more back off, no stop)", runs)
    check(_main_run([])[0] == president_worker.LOGIN_STOPPED_EXIT,
          "…and the third in a row after the reset stops")
    runs = [_main_run(["7000001"], read_fails=True) for _ in range(5)]
    check([r[:4] for r in runs] == [(1, 2, [30], False), (1, 2, [60], False), (1, 2, [120], False),
                                    (1, 2, [240], False), (1, 2, [300], False)],
          "login passes, account read keeps failing → the backoff climbs 30→60→…→300 (a good login does not reset it)",
          runs)
    check(_main_run(["7000001"]) == ("tick", 1, [], False, None),
          "the first account read that succeeds clears the backoff file")
    check(_main_run(["7000001"], read_fails=True)[2] == [30], "…so the next outage starts again at 30s")

    _old = _t.time() - president_worker.NO_ACCOUNT_WINDOW_S - 5
    _backoff_file(failures=2, no_account=2, first_at=_old)
    r = _main_run([])
    stored = json.load(open(president_worker.BACKOFF_PATH, encoding="utf-8"))
    check(r[:5] == (1, 1, [120], False, 1) and stored["first_at"] > _old + president_worker.NO_ACCOUNT_WINDOW_S,
          "two strikes over an hour old: the next empty list counts as the 1st again (fresh first_at), no stop",
          (r, stored))
    _backoff_file(failures=2, no_account=2, first_at=_t.time() - president_worker.NO_ACCOUNT_WINDOW_S + 60)
    check(_main_run([])[0] == president_worker.LOGIN_STOPPED_EXIT, "two strikes inside the hour + a third → stops")
    _backoff_file(failures=0, no_account=2, first_at=_old)
    r = _main_run([], login_raises=RuntimeError("network down"))
    check(r[0] == 1 and r[4] == 0, "a network error keeps strikes only inside the hour (an hour-old run is dropped)", r)
    _backoff_file(failures=0, no_account=2, first_at=_t.time() - 60)
    r = _main_run([], login_raises=RuntimeError("network down"))
    check(r[0] == 1 and r[4] == 2, "a network error inside the hour keeps the strikes", r)
    _backoff_file(failures=0, no_account=2, first_at=_old)
    _main_run([], login_raises=RuntimeError("network down"))
    check(_main_run([])[:5] == (1, 1, [60], False, 1),
          "…and the empty list after hour-old strikes kept through a network error is the 1st, not the 3rd")
finally:
    (president_worker.time.sleep, president_worker._write_snapshot, president_worker._quote_api,
     president_worker.read_account, president_worker.BACKOFF_PATH, FakeUnitrade.get_accounts,
     president_worker.HEARTBEAT_PATH, president_worker._sleep_until_refresh) = _wsaved
    LOGIN_SCRIPT[:] = []
creds2 = president_vault.resolve()
# every failure stops, whatever its class (display only)
for script, kind in (([Resp(ok=False, error="[APGW]something unexpected")], "UNKNOWN"),
                     ([ValueError("unexpected reply layout")], "UNKNOWN"),
                     ([ConnectionError("Failed to establish a new connection")], "TIMEOUT"),
                     ([Resp(ok=False, error="HTTPSConnectionPool(host='x'): Max retries exceeded (Caused by NameResolutionError())")], "TIMEOUT"),
                     ([Resp(ok=False, error="('Connection aborted.', RemoteDisconnected('Remote end closed connection'))")], "TIMEOUT"),
                     ([Resp(ok=False, error="HTTPSConnectionPool(host='x'): Read timed out. (read timeout=30)")], "TIMEOUT"),
                     ([Resp(ok=False, error="Timeout")], "TIMEOUT"),
                     ([Resp(ok=False, error="密碼錯誤,請重新輸入!")], "PASSWORD"),
                     ([Resp(ok=False, error="超過每分鐘限制!")], "UNKNOWN")):
    os.path.exists(STOP) and os.remove(STOP)
    LOGIN_SCRIPT[:] = list(script)
    n = FakeUnitrade.logins
    got = raises(president_vault.LoginError, lambda: president_vault.login(creds2, president_worker.SDK_LOG_DIR))
    got2 = raises(president_vault.LoginError, lambda: president_vault.login(creds2, president_worker.SDK_LOG_DIR))
    check(got.kind == kind and got2.kind == "STOPPED" and FakeUnitrade.logins == n + 1 and president_vault.stopped() == kind,
          f"{script[0]!r:.60} → {kind}, logins stop (the next one never reaches the broker)")
real_lt = president_vault.LOGIN_TIMEOUT_S
president_vault.LOGIN_TIMEOUT_S = 0.2
os.remove(STOP)
LOGIN_SCRIPT[:] = [lambda: _t.sleep(0.6) or Resp(ok=True, error="")]
g1 = raises(president_vault.LoginError, lambda: president_vault.login(creds2, president_worker.SDK_LOG_DIR))
check(g1.kind == "TIMEOUT" and president_vault.stopped() == "TIMEOUT", "a login thread that never answers → TIMEOUT, stopped")
president_vault.LOGIN_TIMEOUT_S = real_lt
check(not hasattr(president_vault, "unblock") and not hasattr(president_vault, "TIMEOUT_BLOCK_AT")
      and not hasattr(president_vault, "TRANSIENT_TEXTS"), "no release-once, no timeout counting, no TRANSIENT class any more")
check(president_vault.classify("密碼錯誤 系統維護") == "PASSWORD" and president_vault.classify("登入失敗!") == "UNKNOWN",
      "a credential word wins; the SDK's bare 登入失敗 is UNKNOWN")

# the stop file and the send marker never write through a symlink parked at a fixed temp name, and
# their temps are named the way runtime/atomic_file's start-up sweep recognizes
sys.path.insert(0, os.path.join(ROOT, "runtime"))
import atomic_file as _af  # noqa: E402
bait = os.path.join(TMP, "bait.txt")
open(bait, "w").write("untouched")
temps = []
_real_replace = os.replace
os.replace = lambda a, b: temps.append(os.path.basename(a)) or _real_replace(a, b)
try:
    for target, write in ((STOP, lambda: president_vault._stop("UNKNOWN")),
                          (op.LAST_ORDER_PATH, lambda: op._mark_order_sent("TMFJ6"))):
        os.path.lexists(target + ".tmp") and os.remove(target + ".tmp")
        os.symlink(bait, target + ".tmp")
        write()
        check(open(bait).read() == "untouched" and json.load(open(target)),
              f"{os.path.basename(target)}: a symlink at the fixed .tmp name is not written through")
        os.remove(target + ".tmp")
finally:
    os.replace = _real_replace
check(len(temps) == 2 and all(_af.is_own_temp(t) for t in temps),
      "both temps carry atomic_file's .<name>.<12 hex>.tmp shape (swept after a crash)", temps)
os.path.exists(STOP) and os.remove(STOP)
# an unreadable .pfx: refused and stopped before any broker contact (the SDK sends the password first)
n = FakeUnitrade.logins
LOGIN_SCRIPT[:] = []
got = raises(president_vault.LoginError, lambda: president_vault.login(dict(creds2, ca_path="/nope.pfx"), president_worker.SDK_LOG_DIR))
check(got.kind == "CERT" and president_vault.stopped() == "CERT" and FakeUnitrade.logins == n,
      "unreadable .pfx → CERT, stopped, the broker never contacted")
os.remove(STOP)
president_vault.in_login_maintenance = lambda now=None: True
got = raises(president_vault.LoginError, lambda: president_vault.login(creds2, president_worker.SDK_LOG_DIR, explicit=True))
check(got.kind == "MAINTENANCE" and not os.path.exists(STOP), "no login is attempted in 05:30–05:50, and that is no stop")
president_vault.in_login_maintenance = lambda now=None: False
check(president_vault.sanitize("x A123456789 TWA1234567891 {'a': 1} y") == "x <id> <id> {…} y",
      "sanitize strips ids and blobs")
for pid in ("A123456789", "B287654321", "A800000014", "F912345678", "AB12345678", "TWA8000000141"):
    got = president_vault.sanitize(f"sign error {pid} tail")
    check(pid not in got and president_vault.classify(f":!! {pid}") == "CERT_MISMATCH",
          f"id shape {pid[:2]}… stripped and classified", got)
creds3 = dict(creds2, password="P3")

# ── 7. reconciler block: split close / entry, never open behind an unconfirmed close ──
os.makedirs("manager", exist_ok=True)
json.dump({"exchanges": {"s1": "president"}}, open("manager/portfolio_config.json", "w"))
from manager import reconciler  # noqa: E402
from lib import venue_errors  # noqa: E402
sent_legs = []
FILL = {}


def fake_place(env, sym, action, lots, intent, **kw):
    sent_legs.append((sym, action, lots, intent))
    st = FILL.get(intent, "filled")
    fq = FILL.get("fill_qty", lots) if st == "filled" else 0   # fill_qty < lots = a partial fill
    return {"status": st, "fill_qty": float(fq), "avg_fill_price": 100.0, "symbol": sym + "J6"}


real_place = op.place_futures_market_order
op.place_futures_market_order = fake_place
try:
    open(op.LAST_ORDER_PATH, "w").write("{}")
    snapshot([{"root": "TMF", "productid": "TMFJ6", "net": 2, "net_current": 2}])
    check(reconciler.get_positions() == {"TMF": {"side": "long", "size": 2.0, "exchange": "president",
                                                 "months": {"2026-10": 2.0}}},
          "routed to president → the worker snapshot, in lots, with its contract month",
          reconciler.get_positions())
    # reconcile() splits a diff by the BOOK before it gets here: a reduce_only leg is a
    # close (already capped at the account), anything else an entry — the broker's net
    # never turns an entry into a close of lots the book does not own
    sent_legs.clear()
    r = reconciler.place_order("TMF", -3.4, exchange="president")
    check(sent_legs == [("TMF", "sell", 3, "entry")] and r["executed_qty"] == 3,
          "a leg that is not reduce_only is an entry, whatever the broker holds", sent_legs)
    sent_legs.clear()
    reconciler.place_order("TMF", -2, exchange="president", reduce_only=True)
    check(sent_legs == [("TMF", "sell", 2, "reduce")], "reduce_only: a close of that size", sent_legs)
    sent_legs.clear()
    FILL["reduce"] = "sent"
    r = reconciler.place_order("TMF", -2, exchange="president", reduce_only=True)
    check(sent_legs == [("TMF", "sell", 2, "reduce")] and r["status"] == "sent" and r["executed_qty"] == 0,
          "an unconfirmed close comes back 'sent' with nothing filled", r)

    # ── unfilled lots are parked: no entry for that root until a reconcile round's snapshot claims them ──
    def pending():
        return json.load(open(reconciler.PENDING_SENT_PATH, encoding="utf-8"))

    def audits(event):
        return [json.loads(l) for l in open(guard.AUDIT_PATH, encoding="utf-8") if f'"{event}"' in l]

    def errors():
        return (json.load(open("manager/order_errors.json", encoding="utf-8"))
                if os.path.exists("manager/order_errors.json") else [])

    def gp():  # a reconcile round's read (what _get_positions_guarded does around get_positions)
        reconciler._claim_parked = True
        try:
            return reconciler.get_positions()
        finally:
            reconciler._claim_parked = False

    def last_order():
        return json.loads(open("manager/orders.jsonl", encoding="utf-8").read().strip().splitlines()[-1])

    def second_read(rows):
        """Another caught-up snapshot, its read started later than the first: an unchanged
        account clears a park only on PENDING_UNCHANGED_READS of them (open interest lag)."""
        snapshot(rows, query_started_at=__import__("time").time() + president_vault.ORDER_SETTLE_S
                 + getattr(reconciler, "PENDING_UNCHANGED_MIN_S", 5) + 1)
        gp()

    from lib.portfolio import ledger_positions, _rebase_ledger_symbol
    p = pending()["TMFJ6"]
    check(p["lots"] == -2 and p["net_expected"] == 2 and p["root"] == "TMF" and p["legs"][0]["status"] == "sent"
          and audits("order_unfilled_parked")[-1]["lots"] == -2,
          "…and is parked: the unfilled lots with the account net the book now expects", p)
    FILL.clear()
    sent_legs.clear()
    n_err = len(errors())
    r = reconciler.place_order("TMF", 1, exchange="president")
    check(r is False and sent_legs == [] and len(errors()) == n_err,
          "an entry for that root waits while lots are parked — nothing sent, no order_error")
    snapshot([{"root": "TMF", "productid": "TMFJ6", "net": 2, "net_current": 2}])  # the close did not fill
    reconciler.get_positions()
    check("TMFJ6" in pending(), "a read without claim (seed_ledger's) leaves parked orders alone")
    gp()
    check("TMFJ6" in pending() and not audits("unfilled_order_cleared"),
          "ONE caught-up snapshot at the expected net does not clear it (the position may still be on its way)")
    second_read([{"root": "TMF", "productid": "TMFJ6", "net": 2, "net_current": 2}])
    check(pending() == {} and audits("unfilled_order_cleared")[-1]["contract"] == "TMFJ6",
          "a second, later caught-up snapshot at the expected net: the IOC was not taken, cleared")
    sent_legs.clear()
    reconciler.place_order("TMF", 1, exchange="president")
    check(sent_legs == [("TMF", "buy", 1, "entry")], "…and the entry goes out again")
    # late fill: the entry reports no fill, the next snapshot shows the lot → booked, never re-sent
    FILL["entry"] = "sent"
    snapshot([])
    sent_legs.clear()
    r = reconciler.place_order("TMF", 1, exchange="president")
    p = pending()["TMFJ6"]
    check(r["status"] == "sent" and p["lots"] == 1 and p["net_expected"] == 0, "entry 'sent' on a flat account: +1 parked", p)
    r = reconciler.place_order("TMF", 1, exchange="president")
    check(r is False and sent_legs == [("TMF", "buy", 1, "entry")], "the same entry is NOT re-sent next round")
    snapshot([{"root": "TMF", "productid": "TMFJ6", "net": 1, "net_current": 1}])
    pos = gp()
    book = ledger_positions("president").get("TMF") or {}
    lo = last_order()
    check(pending() == {} and (book.get("side"), book.get("qty"), book.get("months")) == ("long", 1.0, {"2026-10": 1.0})
          and audits("late_fill_adopted")[-1]["lots"] == 1 and pos["TMF"]["size"] == 1.0,
          "the fill arrived late: booked from the snapshot (late_fill_adopted), the book holds 1 lot in 2026-10",
          (book, pos))
    check(lo.get("late_fill") is True and lo["exchange"] == "president" and lo["action"] == "BUY"
          and lo["legs"] == [{"signed_diff": 1.0, "reduce_only": False, "signed_qty": 1.0, "executed_qty": 1.0,
                              "resolved_symbol": "TMFJ6"}],
          "…as one orders.jsonl line (late_fill, no fill price) — the replay is what books it", lo)
    FILL.clear()
    sent_legs.clear()
    reconciler.place_order("TMF", 1, exchange="president")
    check(sent_legs == [("TMF", "buy", 1, "entry")], "…entries for the root are open again")
    # the self_ledger known gap, pinned: a manual +1 in the SAME contract while a bot +1 is parked is
    # read as the bot's fill (the raw net cannot tell them apart) — change the basis and this test must change
    FILL["entry"] = "sent"
    snapshot([{"root": "TMF", "productid": "TMFJ6", "net": 1, "net_current": 1}])
    reconciler.place_order("TMF", 1, exchange="president")
    snapshot([{"root": "TMF", "productid": "TMFJ6", "net": 2, "net_current": 2}])  # the user's hand buy, not the bot's
    gp()
    check(pending() == {} and ledger_positions("president")["TMF"]["qty"] == 2.0,
          "KNOWN GAP (expected): a hand +1 in the same contract while +1 is parked is adopted as the bot's")
    # partial fills: what did not fill is parked against net_before + the part that did
    FILL.clear()
    FILL["fill_qty"] = 1
    sent_legs.clear()
    r = reconciler.place_order("TMF", 2, exchange="president")
    p = pending()["TMFJ6"]
    check(r["executed_qty"] == 1 and p["lots"] == 1 and p["net_expected"] == 3,
          "entry 2 filled 1: the missing lot is parked, expected net = before (2) + filled (1)", p)
    snapshot([{"root": "TMF", "productid": "TMFJ6", "net": 3, "net_current": 3}])
    gp()
    second_read([{"root": "TMF", "productid": "TMFJ6", "net": 3, "net_current": 3}])
    check(pending() == {}, "…account at expected (3) on two reads: the missing lot did not fill, cleared")
    r = reconciler.place_order("TMF", -2, exchange="president", reduce_only=True)
    p = pending()["TMFJ6"]
    check(r["executed_qty"] == 1 and p["lots"] == -1 and p["net_expected"] == 2,
          "close 2 filled 1: the missing lot is parked, expected net = before (3) − filled (1)", p)
    snapshot([{"root": "TMF", "productid": "TMFJ6", "net": 2, "net_current": 2}])
    gp()
    second_read([{"root": "TMF", "productid": "TMFJ6", "net": 2, "net_current": 2}])
    check(pending() == {}, "…cleared at the expected net (two reads)")
    FILL.clear()
    # a guess row (lots with no recorded month) stays a guess after a late fill
    _rebase_ledger_symbol("TMF", "president", None, qty=1.0)
    check(ledger_positions("president")["TMF"].get("months_guess") is True, "setup: a guessed-month book row")
    FILL["entry"] = "sent"
    snapshot([{"root": "TMF", "productid": "TMFJ6", "net": 1, "net_current": 1}])
    reconciler.place_order("TMF", 1, exchange="president")
    snapshot([{"root": "TMF", "productid": "TMFJ6", "net": 2, "net_current": 2}])
    gp()
    book = ledger_positions("president")["TMF"]
    check(book["qty"] == 2.0 and book.get("months_guess") is True and sum(book["months"].values()) == 2.0,
          "late fill onto a guess row: qty 2, the months still a guess (nothing asserted for the old lot)", book)
    FILL.clear()
    # closes while lots are parked: sent (and snapshot-checked by the lib); with nothing held, refused before the broker
    FILL["entry"] = "sent"
    snapshot([{"root": "TMF", "productid": "TMFJ6", "net": 2, "net_current": 2}])
    reconciler.place_order("TMF", 1, exchange="president")
    FILL.clear()
    sent_legs.clear()
    reconciler.place_order("TMF", -1, exchange="president", reduce_only=True)
    check(sent_legs == [("TMF", "sell", 1, "reduce")] and pending()["TMFJ6"]["lots"] == 1,
          "a close goes out while lots are parked; the parking is untouched")
    op.place_futures_market_order = real_place
    snapshot([])
    api = use([ACK])
    e = raises(op.PresidentError, lambda: reconciler.place_order("TMF", -1, exchange="president", reduce_only=True))
    check(e is not None and not api.sent, "…and with nothing held the lib refuses the close before the broker (no reverse entry)", e)
    op.place_futures_market_order = fake_place
    snapshot([{"root": "TMF", "productid": "TMFJ6", "net": 2, "net_current": 2}])
    gp()
    second_read([{"root": "TMF", "productid": "TMFJ6", "net": 2, "net_current": 2}])
    check(pending() == {}, "cleanup: cleared at the expected net")
    # the park file does not take the row after the broker accepted it: HALT + one order_errors
    # row, the row kept in this process (nothing re-sent), claimable once a write goes through
    FILL["entry"] = "sent"
    real_save = reconciler._save_pending_sent

    def locked(_p, path=None):
        raise PermissionError(13, "locked (fake)")
    reconciler._save_pending_sent = locked
    n_err = len(errors())
    try:
        r = reconciler.place_order("TMF", 1, exchange="president")
    finally:
        reconciler._save_pending_sent = real_save
    FILL.clear()
    e = errors()[-1] if len(errors()) > n_err else {}
    check(r["status"] == "sent" and guard.halted() and len(errors()) == n_err + 1 and "可能已成交" in e.get("error", "")
          and audits("order_unfilled_park_failed"), "park write fails after the send: HALT + one order_errors row", e)
    check(reconciler._pending_sent().get("TMFJ6", {}).get("lots") == 1 and pending() == {},
          "…the +1 is kept in this process (the file still has nothing)")
    sent_legs.clear()
    check(reconciler.place_order("TMF", 1, exchange="president") is False and sent_legs == [], "…and nothing is re-sent")
    snapshot([{"root": "TMF", "productid": "TMFJ6", "net": 3, "net_current": 3}])
    gp()
    check(reconciler._pending_sent() == {} and audits("late_fill_adopted")[-1]["contract"] == "TMFJ6"
          and ledger_positions("president")["TMF"]["qty"] == 3.0, "…a later caught-up read claims it from memory")
    guard.clear_halt("test")
    _rebase_ledger_symbol("TMF", "president", {"2026-10": 2.0})  # back to the book the cases below start from
    snapshot([{"root": "TMF", "productid": "TMFJ6", "net": 2, "net_current": 2}])
    # M1: net_before only from a snapshot that has caught up with the last send — else nothing is sent
    json.dump({"TMFJ6": __import__("time").time()}, open(op.LAST_ORDER_PATH, "w"))
    snapshot([{"root": "TMF", "productid": "TMFJ6", "net": 2, "net_current": 2}],
             query_started_at=__import__("time").time() + 1)
    sent_legs.clear()
    r1 = reconciler.place_order("TMF", 1, exchange="president")
    r2 = reconciler.place_order("TMF", -1, exchange="president", reduce_only=True)
    check(r1 is False and r2 is False and sent_legs == [] and pending() == {} and "TMF" in reconciler._closes_deferred,
          "snapshot not caught up with the last send: neither leg is sent nor parked this round (the lib's own check "
          "would read a newer snapshot than net_before did); the deferred close is noted for the round")
    open(op.LAST_ORDER_PATH, "w").write("{}")
    reconciler._next_round()   # the daemon's next round: the deferral is gone
    # a pending file that does not parse: unknown whether lots are parked → entries wait, closes go, one P1 row
    open(reconciler.PENDING_SENT_PATH, "w").write("{not json")
    n_err = len(errors())
    sent_legs.clear()
    r1 = reconciler.place_order("TMF", 1, exchange="president")
    r2 = reconciler.place_order("TMF", 1, exchange="president")
    check(r1 is False and r2 is False and sent_legs == [] and len(errors()) == n_err + 1
          and reconciler.PENDING_SENT_PATH in errors()[-1]["error"],
          "corrupt pending file: entries wait, one order_errors row per process", errors()[-1:])
    reconciler.place_order("TMF", -1, exchange="president", reduce_only=True)
    check(sent_legs == [("TMF", "sell", 1, "reduce")], "…closes still go")
    gp()
    check(open(reconciler.PENDING_SENT_PATH, encoding="utf-8").read() == "{not json" and len(errors()) == n_err + 1,
          "…a reconcile round's read neither raises nor writes over the file")
    os.remove(reconciler.PENDING_SENT_PATH)
    sent_legs.clear()
    reconciler.place_order("TMF", 1, exchange="president")
    check(sent_legs == [("TMF", "buy", 1, "entry")], "…file removed: entries resume")
    # the parking survives a process restart (it is only ever read from disk)
    FILL["entry"] = "sent"
    snapshot([{"root": "TMF", "productid": "TMFJ6", "net": 2, "net_current": 2}])
    reconciler.place_order("TMF", 1, exchange="president")
    FILL.clear()
    import importlib as _il
    _il.reload(reconciler)
    snapshot([{"root": "TMF", "productid": "TMFJ6", "net": 3, "net_current": 3}])
    gp()
    check(pending() == {} and ledger_positions("president")["TMF"]["qty"] == 3.0 and audits("late_fill_adopted")[-1]["lots"] == 1,
          "after a restart (module reloaded) the first round's read claims the parked lot")
    # neither explanation fits three snapshots running → P1 (order_errors row) + HALT; the row stays, marked halted

    def park_then_escalate():
        FILL["entry"] = "sent"
        snapshot([{"root": "TMF", "productid": "TMFJ6", "net": 3, "net_current": 3}])
        reconciler.place_order("TMF", 1, exchange="president")   # parked +1, expected 3
        FILL.clear()
        n_err, halts = len(errors()), len(audits("halt_tripped"))
        for i in range(1, 4):
            snapshot([{"root": "TMF", "productid": "TMFJ6", "net": 7, "net_current": 7}],
                     query_started_at=__import__("time").time() + president_vault.ORDER_SETTLE_S + i)
            gp()
            if i < 3:
                check(not guard.halted() and len(errors()) == n_err and len(pending()["TMFJ6"]["reads"]) == i,
                      f"unexplained read {i}/3: still waiting, no HALT, no order_error")
        gp()  # the same snapshot again does not count as another read
        return n_err, halts

    n_err, halts = park_then_escalate()
    e = errors()[-1] if len(errors()) > n_err else {}
    check(guard.halted() and len(errors()) == n_err + 1 and e.get("exchange") == "president" and "TMFJ6" in e.get("error", "")
          and "平掉" in e.get("error", "") and len(audits("halt_tripped")) == halts + 1
          and audits("halt_tripped")[-1]["source"] == "reconciler" and pending()["TMFJ6"].get("halted") is True,
          "the third distinct snapshot that fits neither: one order_errors row (P1, says to flatten in the app first), "
          "HALT by the reconciler, the row kept as halted", e)
    sent_legs.clear()
    reconciler.place_order("TMF", 1, exchange="president")
    check(sent_legs == [], "…and HALT holds the entry")
    snapshot([{"root": "TMF", "productid": "TMFJ6", "net": 3, "net_current": 3}])   # the user flattened the lot in the app
    gp()
    second_read([{"root": "TMF", "productid": "TMFJ6", "net": 3, "net_current": 3}])
    check(pending() == {} and audits("unfilled_order_cleared")[-1]["contract"] == "TMFJ6",
          "while halted, the account back at the expected net clears the row (the user flattened it in the app)")
    guard.clear_halt("test")
    n_err, halts = park_then_escalate()
    check(guard.halted() and pending()["TMFJ6"].get("halted") is True and len(errors()) == n_err + 1, "escalated again (setup)")
    guard.clear_halt("test")
    gp()
    check(pending() == {} and audits("parked_order_dropped")[-1]["contract"] == "TMFJ6"
          and ledger_positions("president")["TMF"]["qty"] == 3.0,
          "HALT cleared with the row still unexplained: dropped as the user's, the book unchanged")
    sent_legs.clear()
    reconciler.place_order("TMF", 1, exchange="president")
    check(sent_legs == [("TMF", "buy", 1, "entry")], "…entries resume")
    # R1: a flip whose close was deferred (snapshot not caught up) sends no entry for that root this round
    reconciler._next_round()
    json.dump({"TMFJ6": __import__("time").time()}, open(op.LAST_ORDER_PATH, "w"))
    snapshot([{"root": "TMF", "productid": "TMFJ6", "net": 3, "net_current": 3}],
             query_started_at=__import__("time").time() + 1)
    sent_legs.clear()
    rc = reconciler.place_order("TMF", -3, exchange="president", reduce_only=True)
    open(op.LAST_ORDER_PATH, "w").write("{}")   # the snapshot catches up between the two legs
    snapshot([{"root": "TMF", "productid": "TMFJ6", "net": 3, "net_current": 3}])
    re_ = reconciler.place_order("TMF", -1, exchange="president")
    check(rc is False and re_ is False and sent_legs == [] and "TMF" in reconciler._closes_deferred,
          "close deferred → the same round's entry for that root waits too, even on a caught-up snapshot")
    reconciler._next_round()
    reconciler.place_order("TMF", -1, exchange="president")
    check(sent_legs == [("TMF", "sell", 1, "entry")] and not reconciler._closes_deferred,
          "…next round the deferral is gone and the entry goes")
    # R2: a close that comes back unfilled on a halted row restarts the baseline from this snapshot
    n_err, halts = park_then_escalate()                     # parked +1 vs expected 3, account 7 → halted
    FILL["reduce"] = "sent"
    snapshot([{"root": "TMF", "productid": "TMFJ6", "net": 7, "net_current": 7}])
    reconciler.place_order("TMF", -1, exchange="president", reduce_only=True)
    FILL.clear()
    p = pending()["TMFJ6"]
    check(p["lots"] == -1 and p["net_expected"] == 7 and "halted" not in p and p["reads"] == [] and len(p["legs"]) == 2
          and audits("order_unfilled_parked")[-1]["rebased"] is True,
          "the unfilled close on a halted row: baseline reset to this snapshot's net (7), only the new lot tracked", p)
    snapshot([{"root": "TMF", "productid": "TMFJ6", "net": 6, "net_current": 6}])
    gp()
    check(pending() == {} and audits("late_fill_adopted")[-1]["lots"] == -1 and ledger_positions("president")["TMF"]["qty"] == 2.0,
          "…and the close's late fill is claimed against the new baseline (book 3 → 2)")
    guard.clear_halt("test")
    for f in ("manager/ledger_seed.json", "manager/orders.jsonl"):
        if os.path.exists(f):
            os.remove(f)
    snapshot([{"root": "TMF", "productid": "TMFJ6", "net": 2, "net_current": 2}])

    # ── a late-fill claim at every failure point: booked exactly once, never lost silently ──
    # (audits v035-capital-park P1-1, v035-pres-claim-fix P1-1/P2-1/P2-3). The claim books under
    # the row's park id, then drops the row; any failure keeps the row for the next round.
    import builtins
    import lib.portfolio as _pf

    def book_qty():
        return (ledger_positions("president").get("TMF") or {}).get("qty") or 0.0

    acct = [0]

    def park_one():
        FILL["entry"] = "sent"
        n = acct[0]
        snapshot([{"root": "TMF", "productid": "TMFJ6", "net": n, "net_current": n}] if n else [])
        reconciler.place_order("TMF", 1, exchange="president")
        FILL.clear()
        acct[0] = n + 1
        snapshot([{"root": "TMF", "productid": "TMFJ6", "net": n + 1, "net_current": n + 1}])
        return book_qty()

    def failing_round(exc):
        try:
            gp()
        except exc as e:
            return e
        except BaseException as e:  # noqa: B036 — a different failure is a test failure
            return ("unexpected", e)
        return None

    def adopted():
        return len(audits("late_fill_adopted"))

    real_save = reconciler._save_pending_sent

    # 1. the park file refuses the save after the line is booked
    q0, a0 = park_one(), adopted()

    def locked(_pending):
        raise PermissionError(13, "locked (fake)")

    reconciler._save_pending_sent = locked
    e = failing_round(PermissionError)
    reconciler._save_pending_sent = real_save
    check(e is None and book_qty() == q0 + 1 and "TMFJ6" in pending() and adopted() == a0 + 1,
          "save refused after booking: the round goes on (not a read failure), booked once, row still on disk",
          (e, book_qty(), pending()))
    gp()
    check(pending() == {} and book_qty() == q0 + 1 and audits("late_fill_already_booked"),
          "…next round: the park id is in the book, the row is dropped, not booked again", book_qty())

    # 2. killed between the booked line and the save
    q0 = park_one()
    state_ = {"n": 0}

    def killed_on_save(_pending):
        state_["n"] += 1
        if state_["n"] == 1:
            raise KeyboardInterrupt("killed after the book line (fake)")
        return real_save(_pending)

    reconciler._save_pending_sent = killed_on_save
    e = failing_round(KeyboardInterrupt)
    reconciler._save_pending_sent = real_save
    gp()
    check(isinstance(e, KeyboardInterrupt) and pending() == {} and book_qty() == q0 + 1 and not guard.halted(),
          "killed after booking, before the save: next round drops the row by its id, one lot booked", (e, book_qty()))

    # 3. killed before the line is written
    q0 = park_one()
    real_book = _pf.book_late_fill

    def killed_on_book(*a, **k):
        raise KeyboardInterrupt("killed before the book line (fake)")

    _pf.book_late_fill = killed_on_book
    e = failing_round(KeyboardInterrupt)
    _pf.book_late_fill = real_book
    check(isinstance(e, KeyboardInterrupt) and "TMFJ6" in pending() and book_qty() == q0,
          "killed before booking: the row stays, nothing booked", (e, book_qty(), pending()))
    gp()
    check(pending() == {} and book_qty() == q0 + 1, "…next round books it once", book_qty())

    # 4. the book cannot be read before the line is written (book_late_fill's ledger_book)
    q0, a4 = park_one(), adopted()
    n_err = len([x for x in errors() if "記不進帳本" in x.get("error", "")])
    real_lb = _pf.ledger_book

    def unreadable(*a, **k):
        raise PermissionError(13, "orders.jsonl locked (fake)")

    _pf.ledger_book = unreadable
    e = failing_round(PermissionError)
    _pf.ledger_book = real_lb
    check(isinstance(e, PermissionError) and guard.halted()
          and len([x for x in errors() if "記不進帳本" in x.get("error", "")]) == n_err + 1
          and "TMFJ6" in pending() and book_qty() == q0 and adopted() == a4,
          "book unreadable: HALT + one order_errors row, raised, row kept, no late_fill_adopted", (e, errors()[-1:]))
    guard.clear_halt("test")
    gp()
    check(pending() == {} and book_qty() == q0 + 1, "…after resume the next round books it once", book_qty())

    # 5. the append is refused (full disk)
    def disk_full(path, mode="r", *a, **k):
        if str(path).endswith("orders.jsonl") and "a" in mode:
            raise OSError(28, "No space left on device (fake)")
        return builtins.open(path, mode, *a, **k)

    q0, a5 = park_one(), adopted()
    _pf.open = disk_full
    try:
        e = failing_round(OSError)
    finally:
        del _pf.open
    check(isinstance(e, OSError) and guard.halted() and "TMFJ6" in pending() and book_qty() == q0 and adopted() == a5,
          "append refused: HALT, raised, row kept, nothing booked, no late_fill_adopted", (e, book_qty(), pending()))
    guard.clear_halt("test")
    gp()
    check(pending() == {} and book_qty() == q0 + 1, "…after resume booked once", book_qty())

    # 6. append refused AND the HALT file refused: only this process is halted; after a restart the
    #    row is still there, so the fill is booked then instead of being lost with the HALT
    q0 = park_one()
    real_halt_path = guard.HALT_PATH
    open("state/halt_blocker", "w").write("")
    guard.HALT_PATH = "state/halt_blocker/HALT"
    _pf.open = disk_full
    try:
        e = failing_round(OSError)
    finally:
        del _pf.open
        guard.HALT_PATH = real_halt_path
        os.remove("state/halt_blocker")
    check(isinstance(e, OSError) and guard._halt_flag and "TMFJ6" in pending() and book_qty() == q0,
          "append and HALT file both refused: halted in memory, row kept", (e, pending()))
    guard._halt_flag = False  # the restart
    gp()
    check(pending() == {} and book_qty() == q0 + 1, "…after a restart the row is booked once", book_qty())

    # 7. save refused after booking, then a close of the same contract comes back 'sent' in that
    #    round: it gets a row of its own, not merged into the booked one (which next round drops)
    q0 = park_one()
    reconciler._save_pending_sent = locked
    e = failing_round(PermissionError)
    reconciler._save_pending_sent = real_save
    n = acct[0]
    FILL["reduce"] = "sent"
    reconciler.place_order("TMF", -1, exchange="president", reduce_only=True)
    FILL.clear()
    row7 = pending().get("TMFJ6") or {}
    check(e is None and book_qty() == q0 + 1 and row7.get("lots") == -1 and len(row7.get("legs") or []) == 1,
          "a close parked after a booked-but-unsaved claim opens a new row (−1, one leg)", row7)
    acct[0] = n - 1  # the close filled late
    snapshot([{"root": "TMF", "productid": "TMFJ6", "net": n - 1, "net_current": n - 1}] if n - 1 else [])
    gp()
    check(pending() == {} and book_qty() == q0 and not guard.halted(),
          "…next round books the close's late fill: book back to where it was", (pending(), book_qty()))

    # 8. the park file refuses every claim save: one order_errors row on the third round, not before
    q0 = park_one()
    reconciler._save_pending_sent = locked
    seen = []
    for _ in range(reconciler.CLAIM_SAVE_FAILS_MAX):
        failing_round(PermissionError)
        seen.append(len([x for x in errors() if "連續" in x.get("error", "") and "存不進去" in x.get("error", "")]))
    reconciler._save_pending_sent = real_save
    check(seen == [0] * (reconciler.CLAIM_SAVE_FAILS_MAX - 1) + [1] and book_qty() == q0 + 1,
          "park file refused three rounds in a row: one order_errors row on the third, booked once", seen)
    gp()
    check(pending() == {} and book_qty() == q0 + 1, "…the file takes it again: row dropped by its id")
    # …and that successful save reset the count: three more refused rounds give one more row
    def save_fail_rows():
        return [x.get("ts") for x in errors() if "連續" in x.get("error", "") and "存不進去" in x.get("error", "")]

    q0 = park_one()
    before = save_fail_rows()
    reconciler._save_pending_sent = locked
    seen = []
    for _ in range(reconciler.CLAIM_SAVE_FAILS_MAX):
        failing_round(PermissionError)
        seen.append(len(set(save_fail_rows()) - set(before)))
    reconciler._save_pending_sent = real_save
    gp()
    check(seen == [0] * (reconciler.CLAIM_SAVE_FAILS_MAX - 1) + [1],
          "after a save that went through, the count starts over: one new row on the third refusal", seen)

    # 9. booked-but-unsaved row, then a close parks onto it while orders.jsonl is unreadable: whether
    #    the row was booked is unknown, so the merge is told and HALTed (not silent)
    q0 = park_one()
    reconciler._save_pending_sent = locked
    failing_round(PermissionError)
    reconciler._save_pending_sent = real_save
    n = acct[0]
    real_lfb = _pf.late_fill_booked

    def lfb_locked(_pid):
        raise PermissionError(13, "orders.jsonl locked (fake)")

    _pf.late_fill_booked = lfb_locked
    FILL["reduce"] = "sent"
    reconciler.place_order("TMF", -1, exchange="president", reduce_only=True)
    FILL.clear()
    _pf.late_fill_booked = real_lfb
    check(guard.halted() and any("確認不了" in x.get("error", "") for x in errors())
          and audits("order_unfilled_park_unverified"),
          "a leg parked onto a row whose booking can't be read: one order_errors row and HALT", errors()[-1:])
    guard.clear_halt("test")
    acct[0] = n - 1
    snapshot([{"root": "TMF", "productid": "TMFJ6", "net": n - 1, "net_current": n - 1}] if n - 1 else [])
    gp()
    guard.clear_halt("test")
    for f in ("manager/ledger_seed.json", "manager/orders.jsonl"):
        if os.path.exists(f):
            os.remove(f)
    snapshot([{"root": "TMF", "productid": "TMFJ6", "net": 2, "net_current": 2}])

    FILL.clear()
    sent_legs.clear()
    reconciler.place_order("TMF", 0.4, exchange="president")
    check(sent_legs == [], "under half a lot → nothing")
    open("state/HALT", "w").write("{}")
    sent_legs.clear()
    reconciler.place_order("TMF", -2, exchange="president", reduce_only=True)
    reconciler.place_order("TMF", -1, exchange="president")
    check(sent_legs == [("TMF", "sell", 2, "reduce")], "HALT: the close goes, the entry does not", sent_legs)
    os.remove("state/HALT")

    def entry_fails(env, sym, action, lots, intent, **kw):
        if intent == "entry":
            raise op.PresidentError("contract TMFK6 is not in the broker's contract list")
        return fake_place(env, sym, action, lots, intent)
    op.place_futures_market_order = entry_fails
    check(raises(op.PresidentError, lambda: reconciler.place_order("TMF", -1, exchange="president"))
          is not None, "a refused entry raises (reconcile records it as the order error)")

    def entry_deferred(env, sym, action, lots, intent, **kw):
        if intent == "entry":
            raise op.EntryDeferred("settlement window: snapshot not caught up")
        return fake_place(env, sym, action, lots, intent)
    op.place_futures_market_order = entry_deferred
    n_err = len(json.load(open("manager/order_errors.json", encoding="utf-8"))
                if os.path.exists("manager/order_errors.json") else [])
    r = reconciler.place_order("TMF", -1, exchange="president")
    errs = (json.load(open("manager/order_errors.json", encoding="utf-8"))
            if os.path.exists("manager/order_errors.json") else [])
    check(r is False and len(errs) == n_err,
          "an entry behind a snapshot that has not caught up: skipped this round, no order_error", r)

    def unk(env, sym, action, lots, intent, **kw):
        r = fake_place(env, sym, action, lots, intent)
        if intent == "entry":
            r.update(status="unknown", fill_qty=0.0, ack="0099")
        return r
    op.place_futures_market_order = unk
    snapshot([])
    r = reconciler.place_order("TMF", 1, exchange="president")
    errs = (json.load(open("manager/order_errors.json", encoding="utf-8"))
            if os.path.exists("manager/order_errors.json") else [])
    check(r["status"] == "unknown" and not any(e.get("kind") == "order_status_unknown" for e in errs)
          and len(errs) == n_err,
          "an unknown status stays 'unknown' in the result but never reaches order_errors "
          "(every row there is a P1 order_error on the platform)", r)
    check(pending()["TMFJ6"]["lots"] == 1 and pending()["TMFJ6"]["legs"][-1]["status"] == "unknown",
          "…its unfilled lot is parked like a 'sent' one")
    gp()  # the flat snapshot, twice: not filled → cleared
    second_read([])
    check(pending() == {}, "…and cleared by the next reconcile rounds' snapshots the same way")
    op.place_futures_market_order = fake_place
    json.dump({"TMFJ6": __import__("time").time()}, open(op.LAST_ORDER_PATH, "w"))
    snapshot([{"root": "TMF", "productid": "TMFJ6", "net": 2, "net_current": 2}],
             query_started_at=__import__("time").time() + 1)
    e = raises(reconciler.CapitalCacheLagError, reconciler.get_positions)
    check(isinstance(e, reconciler.PresidentCacheLagError), "a snapshot older than the last send → skip the round")
    check(reconciler._current_venue() == "president", "the venue for classification is president")
finally:
    op.place_futures_market_order = real_place

# ── 11. after settlement: a leftover expired row is not a position ───────────
pc._now = lambda now: _real_now(now or T(2026, 10, 21, 14, 0))  # 30 min after J6 settled
open(op.LAST_ORDER_PATH, "w").write("{}")
for listed in ({"TMF": ["TMFK6", "TMFL6"], "TXF": [], "MXF": []},):
    snapshot([{"root": "TMF", "productid": "TMFJ6", "net": 1}], listed=listed)
    n_err = len(json.load(open("manager/order_errors.json", encoding="utf-8"))
                if os.path.exists("manager/order_errors.json") else [])
    check(reconciler.get_positions() == {}, "residue J6 (list read, without J6) reads as no position")
    NOW_LIST[:] = ["TMFK6"]
    api = use([ACK])
    reconciler.place_order("TMF", 1, exchange="president")
    errs = (json.load(open("manager/order_errors.json", encoding="utf-8"))
            if os.path.exists("manager/order_errors.json") else [])
    check([o.productid for o in api.sent] == ["TMFK6"] and len(errs) == n_err,
          "the entry goes to K6, nothing is sent to J6, no order_errors row",
          ([vars(o) for o in api.sent], errs[n_err:]))
    open(op.LAST_ORDER_PATH, "w").write("{}")
snapshot([{"root": "TMF", "productid": "TMFJ6", "net": 1}], listed={"TMF": ["TMFJ6", "TMFK6"]})
check(reconciler.get_positions() == {"TMF": {"side": "long", "size": 1.0, "exchange": "president",
                                             "months": {"2026-10": 1.0}}},
      "past settlement but still listed (holiday-postponed) → still the bot's position")
for listed in (None, {"TMF": [], "TXF": [], "MXF": []}):
    snapshot([{"root": "TMF", "productid": "TMFJ6", "net": 1}], listed=listed)
    e = raises(pc.ListUnknown, reconciler.get_positions)
    check(e is not None and reconciler._classify("president", e) == venue_errors.TRANSIENT,
          f"past settlement, list {'unread' if listed is None else 'empty'} → the read fails as TRANSIENT "
          f"(round skipped, never halts, nothing guessed)", e)
    api = use([ACK])
    check(raises(pc.ListUnknown, lambda: op.close_position_partial({}, "TMF", "long", 1)) is not None
          and not api.sent, "…and no close is sent on it either")
    open(op.LAST_ORDER_PATH, "w").write("{}")
snapshot([{"root": "TMF", "productid": "TMFJ6", "net": 1}], listed={"TMF": ["TMFK6", "TMFL6"]})
api = use([ACK])
check(raises(op.PresidentError, lambda: op.close_position_partial({}, "TMF", "long", 1)) is not None
      and not api.sent, "a close of settled residue is refused, never sent")
snapshot([{"root": "TMF", "productid": "TMFL6", "net": -1}])
check(reconciler.get_positions() == {}, "a manual far month alone reads as no bot position (nothing summed)")
# the user's own months (opened in the app) are left out: the bot's rows of that root and of
# others are still read, and 全部平倉 — flatten's two calls per venue, get_positions then
# close_position_partial for each row — still closes them
open(op.LAST_ORDER_PATH, "w").write("{}")
MIXED = [{"root": "TMF", "productid": "TMFK6", "net": 2, "net_current": 2},
         {"root": "TMF", "productid": "TMFL6", "net": -1, "net_current": -1},
         {"root": "TXF", "productid": "TXFL6", "net": 1, "net_current": 1}]
MIXED_LISTED = {"TMF": ["TMFK6", "TMFL6"], "TXF": ["TXFK6", "TXFL6"], "MXF": ["MXFK6", "MXFL6"]}
snapshot(MIXED, listed=MIXED_LISTED)
check(reconciler.get_positions() == {"TMF": {"side": "long", "size": 2.0, "exchange": "president",
                                             "months": {"2026-11": 2.0}}},
      "reconciler with manual TMFL6 + TXFL6 held: the bot's TMFK6 is read, TXF is not blocked")
flat_pos = account_president.get_positions({})
check(list(flat_pos) == ["TMF"] and flat_pos["TMF"]["productid"] == "TMFK6",
      "flatten's read with manual months held: only the bot's row", flat_pos)
NOW_LIST[:] = ["TMFK6", "TMFL6"]
api = use([ACK])
flat_errs = []
for _i, (_sym, _p) in enumerate(flat_pos.items()):
    try:  # flatten records a failed close and goes on — so does this
        op.format_qty({}, _sym, _p["size"])
        op.close_position_partial({}, _sym, _p["side"], _p["size"], client_order_id=f"flat2026102114000000000{_i}")
    except Exception as _e:  # noqa: BLE001
        flat_errs.append(str(_e))
check(not flat_errs and [(o.productid, o.bs, o.opencloseflag) for o in api.sent] == [("TMFK6", "S", "1")],
      "全部平倉 with manual months held: the bot's TMFK6 is closed, nothing goes to TMFL6 / TXFL6",
      (flat_errs, [vars(o) for o in api.sent]))
open(op.LAST_ORDER_PATH, "w").write("{}")
snapshot(MIXED, listed=MIXED_LISTED)
api = use([ACK])
check(raises(op.PresidentError, lambda: op.close_position_partial({}, "TMFL6", "short", 1)) is not None
      and not api.sent, "the user's own month named by its code → refused, never sent")
open(op.LAST_ORDER_PATH, "w").write("{}")
pc._now = lambda now: _real_now(now or FIXED_NOW)
NOW_LIST[:] = [op.near_month("TMF", [f"TMF{c}{d}" for c in op.MONTH_CODES for d in "0123456789"])]

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
    "sweep_orphan_stops": "auto-wire (optional, hasattr — StockCoin's orphan STOP sweep)",
    "resolve_unknown_order": "venue_wiring.query_parked_order (optional, hasattr — falls back to get_order)",
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
# securities are out of scope; reset_session / restart_needed are about capital's process-wide
# SKCOM login (and its 9997 limit) — president has none
NOT_FUTURES = {"place_stock_order", "place_odd_lot_order", "place_after_hours_odd_lot_order", "reset_session",
               "restart_needed"}
check(cap - NOT_FUTURES <= set(dir(op)), "order_president has order_capital's futures interface",
      sorted(cap - NOT_FUTURES - set(dir(op))))

print(f"\n{'FAILED: ' + str(fails) if fails else 'all passed'}")
sys.exit(1 if fails else 0)
