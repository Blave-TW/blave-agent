"""Property test for orders whose outcome is unknown: no order reaches the exchange twice, and
nothing opens new exposure on a symbol while an order on it is still unknown.

Hundreds of random histories (seeded, reproducible) through the real path — lib.portfolio.reconcile
→ lib.venue_wiring.auto_place_order → lib.order_bybit.place_market_order, the park queried through
venue_wiring.query_parked_order → order_bybit.resolve_unknown_order — against a fake Bybit behind
requests.request that keeps its own orders and position. Stubbed as in
check_reconcile_unconfirmed_bybit.py: the transport, the mark, the rules, the account's position
read, the order lib's clock. Every number is made up.

A history, round by round: the target moves (long, short, flat, three sizes — flips included);
the order POST is answered, or times out / drops / 5xx / 10016 / answers without an orderId, each
with the order arrived or lost; it is refused (10002, 10006, connect timeout, then resent by the
lib; a margin rejection); the order fills, fills in part, or ends unfilled; its row shows up to
queries at once, some rounds later, or only its executions do; queries fail for a round; the same
round runs twice; the user stops and resumes trading; the park file cannot be written (full
disk); the user reads the venue and tells the agent what filled; the process restarts with
orders parked; the process dies mid-order (a BaseException out of the POST: nothing on the way
out of reconcile catches it or writes on unwind, so the disk is left as a kill leaves it).

Checked on what the exchange saw:
- once: an orderLinkId is sent at most once, unless the exchange refused it before taking it
  (connect timeout, 10002, 10006);
- held: no order that can open exposure (not reduce-only) is sent while an earlier order on the
  symbol is unknown — until a query returned its end, or the user said what filled;
- bounded: an order that arrives moves the account's position toward the round's target, never
  past it;
- due: a round that wants the position smaller sends the part of that cut no parked close may
  already have made — wanted cut minus parked closes, to the step: not more (the same cut twice),
  not less (a close of the whole position still sends book minus parked);
- silent: after a restart that finds an order died mid-flight, HALT is set and nothing is sent
  (the history ends there: the user squares the book by hand);
- settled: once every answer is in (rows visible, the user resolved what Bybit never lists,
  trading resumed), position and book both equal the target, nothing parked.

Scripted on the same fake (SCENARIOS): a partial cut whose outcome is unknown, then the target
stays, drops, goes flat, drops twice, comes back up, flips; the cut ends unfilled, or filled.

A failing history is shrunk (rounds, then events, dropped while it still fails) and printed with
its seed. Shared path + Bybit only: the other venues' transports are covered by their own
check_*_order_outcome_unknown.py, not here.

Run: cd blave-agent && .venv/bin/python tests/check_order_outcome_unknown_fuzz.py [N] [--seed S]
"""
import copy
import json
import logging
import os
import random
import shutil
import socket
import sys
import tempfile
import time
from urllib.parse import parse_qs, urlparse

ROOT = os.environ.get("FUZZ_LIB_ROOT") or os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WS = tempfile.mkdtemp(prefix="order-unknown-fuzz-")
os.environ["BLAVE_AGENT_HOME"] = os.environ["BLAVECLAW_HOME"] = WS
os.environ["BLAVE_AGENT_BASE"] = WS
os.environ["BLAVE_AGENT_WORKSPACE"] = WS
os.environ.pop("BLAVE_AGENT_LOCAL", None)
os.symlink(os.path.join(ROOT, "lib"), os.path.join(WS, "lib"))
sys.path.insert(0, ROOT)


def _no_real_env(event, args):
    if event == "open" and os.path.abspath(str(args[0])) == os.path.join(ROOT, ".env"):
        raise PermissionError("the repo .env must never be read by a test")


def _no_net(*a, **k):
    raise OSError("offline test")


sys.addaudithook(_no_real_env)
socket.socket.connect = _no_net
socket.create_connection = _no_net
os.chdir(WS)
logging.disable(logging.CRITICAL)

import requests  # noqa: E402
from lib import execute, guard, portfolio, unconfirmed, venue_wiring  # noqa: E402
import lib.order_bybit as bb  # noqa: E402
import lib.account_bybit as ab  # noqa: E402

SYM = "BTCUSDT"
MARK = 50_000.0
UNIT = 1000          # the fake counts in 0.001 BTC (the step)
SIZES = (500, 1000, 1500)
# POST answers that leave the outcome unknown; each comes with the order arrived or lost
AMBIGUOUS = ("timeout", "reset", "http502", "10016", "noid")
# refused before Bybit took the order: the lib sends it again, same orderLinkId
REFUSED_FIRST = ("connect_timeout", "10002", "10006")

venue_wiring.read_env = lambda path=".env": {"BYBIT_API_KEY": "k", "BYBIT_SECRET_KEY": "s"}
venue_wiring.detect_venue = lambda env: "bybit"
bb._sync_time = lambda env: None
bb.get_mark_price = lambda env, sym: MARK
bb._RULES_CACHE[("linear", SYM)] = {"step": "0.001", "min_qty": 0.001, "min_notional": 0,
                                    "contract_value": 1.0, "tick": "0.1", "equity": False}
_skew = {"s": 0.0}   # the confirm poll's sleeps advance its own clock, not the test's
bb.time = type("T", (), {"time": staticmethod(lambda: time.time() + _skew["s"]),
                         "sleep": staticmethod(lambda s: _skew.__setitem__("s", _skew["s"] + s))})


class Resp:
    def __init__(self, status, body=None, text=None):
        self.status_code, self._body = status, body
        self.text = text if text is not None else str(body)

    def json(self):
        if self._body is None:
            raise ValueError("not json")
        return self._body

    def raise_for_status(self):
        if self.status_code >= 400:
            raise requests.exceptions.HTTPError(f"HTTP {self.status_code}")


def bybit(result=None, code=0, msg="OK"):
    return Resp(200, {"retCode": code, "retMsg": msg, "result": result or {}})


class Killed(BaseException):
    """The process dies here."""


class Exchange:
    """A one-way Bybit linear account. Every order that arrives executes — it does not refuse a
    repeated orderLinkId, so a resend shows in the position as well as in the count."""

    def __init__(self):
        self.pos = 0            # signed, in steps
        self.orders = []        # arrived or lost, in send order
        self.sends = {}         # orderLinkId → sends the exchange did not refuse up front
        self.round = 0
        self.target = 0         # this round's target, in steps
        self.plan = []          # this round's POST answers, consumed in order
        self.query_down = False
        self.kill = None        # 'before' / 'after' the order reaches the exchange
        self.all_visible = False
        self.violations = []
        self.stats = {"posts": 0, "unknown": 0, "held_rounds": 0, "settled": 0}

    def unknown(self):
        return [o for o in self.orders if not o["known"]]

    def _visible(self, o, what):
        if not o["arrived"]:
            return False
        return self.all_visible or self.round >= o["at"] + o[what]

    def _row(self, o):
        return {"orderId": o["oid"], "orderLinkId": o["cid"], "orderStatus": o["status"],
                "qty": f"{o['qty'] / UNIT:.3f}", "cumExecQty": f"{o['cum'] / UNIT:.3f}",
                "avgPrice": str(MARK) if o["cum"] else "", "cumExecFee": "0.01"}

    def post(self, body):
        cid = body.get("orderLinkId")
        step = self.plan.pop(0) if self.plan else {"post": "ok"}
        kind = step["post"]
        if kind in REFUSED_FIRST and not step.get("spent"):
            self.plan.insert(0, dict(step, post="ok", spent=True))
            if kind == "connect_timeout":
                raise requests.exceptions.ConnectTimeout("connect timed out")
            return bybit(code=10002 if kind == "10002" else 10006, msg="refused before processing")
        self.stats["posts"] += 1
        if not cid:
            self.violations.append(f"round {self.round}: a market order without an orderLinkId ({body})")
        self.sends[cid] = self.sends.get(cid, 0) + 1
        if self.sends[cid] > 1:
            self.violations.append(f"round {self.round}: once — orderLinkId {cid} sent {self.sends[cid]} times")
        reduce = bool(body.get("reduceOnly"))
        if not reduce and self.unknown():
            self.violations.append(
                f"round {self.round}: held — {body.get('side')} {body.get('qty')} (not reduce-only) sent while "
                f"{[(o['side'], o['qty'] / UNIT, 'arrived' if o['arrived'] else 'lost') for o in self.unknown()]} "
                f"is still unknown")
        if self.kill == "before":
            self._die()
        qty = round(float(body["qty"]) * UNIT)
        sign = 1 if body.get("side") == "Buy" else -1
        o = {"cid": cid, "oid": f"o{len(self.orders) + 1}", "side": body.get("side"), "qty": qty,
             "reduce": reduce, "at": self.round, "row_lag": step.get("row_lag", 0),
             "exec_lag": step.get("exec_lag", step.get("row_lag", 0)), "known": False,
             "arrived": kind != "reject" and (kind == "ok" or step.get("arrived", True)),
             "status": "Cancelled", "cum": 0}
        self.orders.append(o)
        if o["arrived"]:
            fill = {"full": qty, "part": qty // 2, "none": 0}[step.get("fill", "full")]
            if reduce:
                fill = min(fill, max(0, -sign * self.pos))
            before = self.pos
            self.pos += sign * fill
            o["cum"] = fill
            o["status"] = "Filled" if fill == qty else "PartiallyFilledCanceled" if fill else "Cancelled"
            lo, hi = min(before, self.target), max(before, self.target)
            if not lo <= self.pos <= hi:
                self.violations.append(
                    f"round {self.round}: bounded — {o['side']} {qty / UNIT:g} took the position from "
                    f"{before / UNIT:g} to {self.pos / UNIT:g}, past the target {self.target / UNIT:g}")
        if self.kill == "after":
            self._die()
        if kind == "reject":
            o["known"] = True
            return bybit(code=110007, msg="ab not enough for new order")
        if kind == "ok":
            return bybit({"orderId": o["oid"], "orderLinkId": cid})
        self.stats["unknown"] += 1
        if kind == "timeout":
            raise requests.exceptions.ReadTimeout("read timed out")
        if kind == "reset":
            raise requests.exceptions.ConnectionError("RemoteDisconnected")
        if kind == "http502":
            return Resp(502, None, "Bad Gateway")
        if kind == "10016":
            return bybit(code=10016, msg="Server error")
        return bybit({"orderLinkId": cid})   # noid: taken, the id missing from the answer

    def get(self, path, q):
        if path == "/v5/position/list":
            side = "Buy" if self.pos > 0 else "Sell" if self.pos < 0 else ""
            return bybit({"list": [{"positionIdx": 0, "symbol": SYM, "side": side,
                                    "size": f"{abs(self.pos) / UNIT:.3f}", "markPrice": str(MARK)}]})
        if path not in ("/v5/order/realtime", "/v5/order/history", "/v5/execution/list"):
            return bybit({"list": []})
        if self.query_down:
            raise requests.exceptions.ReadTimeout("read timed out")
        mine = [o for o in self.orders
                if (q.get("orderId") and o["oid"] == q["orderId"])
                or (not q.get("orderId") and q.get("orderLinkId") and o["cid"] == q["orderLinkId"])]
        if path == "/v5/execution/list":
            rows = []
            for o in mine:
                if self._visible(o, "exec_lag") and o["cum"]:
                    o["known"] = True
                    rows.append({"orderId": o["oid"], "orderLinkId": o["cid"], "execType": "Trade",
                                 "execQty": f"{o['cum'] / UNIT:.3f}", "execPrice": str(MARK)})
            return bybit({"list": rows})
        rows = []
        for o in mine:
            if self._visible(o, "row_lag"):
                o["known"] = True   # every row here is terminal: a market order ends at once
                rows.append(self._row(o))
        return bybit({"list": rows})

    def _die(self):
        self.kill = None
        raise Killed()


EX = [Exchange()]
DISK_FULL = [False]
_park = unconfirmed.park


def _park_or_enospc(*a, **k):
    if DISK_FULL[0]:
        raise OSError(28, "No space left on device")
    return _park(*a, **k)


unconfirmed.park = _park_or_enospc


def _request(method, url, headers=None, data=None, timeout=None):
    ex = EX[0]
    if (headers or {}).get("referer") != "Ue001036":
        ex.violations.append(f"round {ex.round}: broker attribution missing on {method} {url}")
    if method == "POST":
        return ex.post(json.loads(data))
    u = urlparse(url)
    return ex.get(u.path, {k: v[0] for k, v in parse_qs(u.query).items()})


bb.requests.request = _request
ab.get_positions = lambda env: ([{"symbol": SYM, "side": "long" if EX[0].pos > 0 else "short",
                                  "size": abs(EX[0].pos) / UNIT, "mark_price": MARK}] if EX[0].pos else [])


# ── a process: what a restart forgets ───────────────────────────────────────
def _snapshot():
    """Every lib module's plain module-level state, as it is before any round. A lib module first
    imported inside a round is not in it: the ones holding order state are imported above."""
    snap = {}
    for name, mod in list(sys.modules.items()):
        if not (name == "lib" or name.startswith("lib.")) or mod is None:
            continue
        for attr, val in vars(mod).items():
            if attr.startswith("__") or not isinstance(val, (dict, list, set, bool, int, float, str, type(None))):
                continue
            try:
                snap[(name, attr)] = copy.deepcopy(val)
            except Exception:
                pass
    return snap


def restart(snap):
    for (name, attr), val in snap.items():
        mod = sys.modules[name]
        cur = getattr(mod, attr, None)
        if isinstance(val, (dict, set)) and type(cur) is type(val):
            cur.clear()
            cur.update(copy.deepcopy(val))
        elif isinstance(val, list) and type(cur) is list:
            cur[:] = copy.deepcopy(val)
        else:
            setattr(mod, attr, copy.deepcopy(val))


BOOT = [None]


# ── a history ───────────────────────────────────────────────────────────────
def gen(seed):
    r = random.Random(seed)
    rounds = []
    for _ in range(r.randint(4, 14)):
        ev = []
        if r.random() < 0.6:
            ev.append(["target", r.choice([-1, 0, 1, 1]) * r.choice(SIZES)])
        x = r.random()
        if x < 0.45:
            step = {"post": r.choice(AMBIGUOUS), "arrived": r.random() < 0.7}
        elif x < 0.6:
            step = {"post": r.choice(REFUSED_FIRST)}
        elif x < 0.68:
            step = {"post": "reject"}
        else:
            step = {"post": "ok"}
        if step["post"] != "reject":
            step["fill"] = r.choice(["full", "full", "full", "part", "none"])
            step["row_lag"] = r.choice([0, 0, 1, 2, 3, 99])
            step["exec_lag"] = r.choice([step["row_lag"], 0, 1])
        plan = [step]
        if r.random() < 0.3:   # a flip's second leg
            plan.append({"post": r.choice(AMBIGUOUS + ("ok", "ok")), "arrived": r.random() < 0.7,
                         "row_lag": r.choice([0, 1, 99])})
        ev.append(["plan", plan])
        for _ in range(r.randint(0, 2)):
            y = r.random()
            if y < 0.2:
                ev.append(["query_down"])
            elif y < 0.35:
                ev.append(["restart"])
            elif y < 0.47:
                ev.append(["resolve"])
            elif y < 0.57:
                ev.append(["halt", r.random() < 0.5])
            elif y < 0.6:
                ev.append(["disk_full"])
            elif y < 0.63:
                ev.append(["kill", r.choice(["before", "after"])])
            elif y < 0.8:
                ev.append(["again"])
        rounds.append(ev)
    return rounds


# ── running it ──────────────────────────────────────────────────────────────
def place(symbol, diff, spec=None, **kw):
    kw.pop("contributors", None)
    return venue_wiring.auto_place_order(symbol, diff, spec, **kw)


def _usd(steps):
    return steps * MARK / UNIT


def _book_usd():
    row = portfolio.ledger_positions().get(SYM) or {}
    c = round(float(row.get("size") or 0), 6)
    return -c if row.get("side") == "short" else c


_settle_parked = portfolio._settle_parked


def reconcile():
    """One round. due is read where the round reads them: parked orders settled, the book
    not yet moved by this round's orders. Not judged: a HALTed round, a round holding an order the
    disk refused to park (its symbol sends nothing), a round the process dies in."""
    ex, seen = EX[0], {}

    def settle(*a, **k):
        held = _settle_parked(*a, **k)
        if held is None or guard.halted() or any(v == float("inf") for v in held.values()):
            return held
        book, closes = _book_usd(), [e for e in unconfirmed.load().values() if e.get("reduce_only")]
        target = _usd(ex.target)
        cut = abs(book) if book * target <= 0 else max(0.0, abs(book) - abs(target))
        seen["book"], seen["cut"] = book, cut
        seen["parked"] = sum(abs(float(e.get("signed_diff") or 0)) for e in closes)
        return held

    portfolio._settle_parked = settle
    n = len(ex.orders)
    try:
        portfolio.reconcile(get_positions_fn=venue_wiring.auto_get_positions, place_order_fn=place,
                            threshold=10, send_telegram_fn=lambda *a, **k: None)
    finally:
        portfolio._settle_parked = _settle_parked
    if seen:
        due = round(max(0.0, seen["cut"] - seen["parked"]) / MARK * UNIT)
        got = sum(o["qty"] for o in ex.orders[n:] if o["reduce"])
        if got != due:
            ex.violations.append(
                f"round {ex.round}: due — book {seen['book']:+g}, target {_usd(ex.target):+g}, parked closes "
                f"{seen['parked']:g}: {_usd(due):g} of closing is due, {_usd(got):g} was sent")


def book_steps():
    row = portfolio.ledger_positions().get(SYM) or {}
    q = float(row.get("qty") or 0)
    return round((q if row.get("side") != "short" else -abs(q)) * UNIT)


def user_resolves(ex):
    """The user reads the venue and says what filled, oldest park first — the truth."""
    for pid, e in sorted(unconfirmed.load().items(), key=lambda kv: kv[1].get("parked_at") or 0):
        o = next((o for o in ex.orders if (e.get("order_id") and o["oid"] == e["order_id"])
                  or (not e.get("order_id") and o["cid"] == e.get("client_order_id"))), None)
        filled = (o["cum"] / UNIT) if o and o["arrived"] else 0.0
        unconfirmed.resolve(SYM, filled, MARK if filled else None, park_id=pid)
        if o:
            o["known"] = True
        return


class World:
    def __init__(self):
        os.chdir(WS)
        for d in ("manager", "state", "strategies"):
            shutil.rmtree(d, ignore_errors=True)
        for d in ("manager", "state", "strategies/btc_trend"):
            os.makedirs(d)
        if BOOT[0] is None:
            BOOT[0] = _snapshot()
        restart(BOOT[0])
        self.ex = EX[0] = Exchange()
        DISK_FULL[0] = False
        self.ended = None   # why the history stopped early
        json.dump({"seeded_at": "2026-09-01T00:00:00", "own_only_basis": 1, "symbols": {}},
                  open("manager/ledger_seed.json", "w"))
        open("strategies/btc_trend/strategy.py", "w").write('MARKET = "swap"\n')
        self.set_target(0)

    def set_target(self, usd):
        self.ex.target = round(usd / MARK * UNIT)
        json.dump({"symbol": SYM, "position": 0.0 if not usd else 1.0 if usd > 0 else -1.0,
                   "market": "swap", "updated_at": int(time.time())},
                  open("strategies/btc_trend/state.json", "w"))
        json.dump({"amounts": {"btc_trend": abs(usd) or 500}, "exchanges": {"btc_trend": "bybit"}},
                  open("manager/portfolio_config.json", "w"))

    def boot(self):
        """A new process: nothing in memory, then the reconciler's startup reap."""
        restart(BOOT[0])
        execute.reap_dead_inflight()

    def silent(self):
        """Dead markers found at startup: HALT, and nothing goes out."""
        if not guard.halted():
            self.ex.violations.append(f"round {self.ex.round}: silent — an order died mid-flight and the "
                                      f"restart did not HALT")
        n = self.ex.stats["posts"]
        for _ in range(2):
            self.ex.round += 1
            reconcile()
        if self.ex.stats["posts"] != n:
            self.ex.violations.append(f"round {self.ex.round}: silent — orders sent while HALTed after a "
                                      f"mid-flight death")
        self.ended = "dead in-flight marker"

    def round(self, events):
        ex = self.ex
        ex.round += 1
        ex.plan, ex.query_down = [], False
        ex.kill, again, DISK_FULL[0] = None, False, False
        for e in events:
            op = e[0]
            if op == "target":
                self.set_target(e[1])
            elif op == "plan":
                ex.plan = copy.deepcopy(e[1])
            elif op == "query_down":
                ex.query_down = True
            elif op == "restart":
                marked = bool(execute.list_inflight())
                self.boot()
                if marked:
                    return self.silent()
            elif op == "resolve":
                user_resolves(ex)
            elif op == "halt":
                guard.trip_halt("user stop", "user") if e[1] else guard.clear_halt("user")
            elif op == "disk_full":
                DISK_FULL[0] = True
            elif op == "kill":
                ex.kill = e[1]
            elif op == "again":
                again = True
        try:
            reconcile()
        except Killed:
            self.boot()
            return self.silent()
        finally:
            ex.kill, DISK_FULL[0] = None, False
        if again:
            reconcile()
        if self.ex.unknown():
            self.ex.stats["held_rounds"] += 1

    def settle(self):
        """Every answer comes in: rows visible, the user resolves what Bybit never lists, trading on."""
        ex = self.ex
        ex.plan, ex.query_down, ex.all_visible = [], False, True
        if execute.list_inflight():
            # a full disk kept the marker of an order it could not park; the next start HALTs on it
            self.boot()
            return self.silent()
        for _ in range(6):
            ex.round += 1
            ex.plan = []
            guard.clear_halt("user")
            reconcile()
            while unconfirmed.load():
                user_resolves(ex)
            if ex.pos == ex.target and book_steps() == ex.target and not ex.unknown():
                break
        ex.round += 1
        n = ex.stats["posts"]
        reconcile()
        if ex.stats["posts"] != n:
            ex.violations.append("settled — a round after the target was reached still sent an order")
        if ex.pos != ex.target or book_steps() != ex.target or unconfirmed.load():
            ex.violations.append(
                f"settled — position {ex.pos / UNIT:g}, book {book_steps() / UNIT:g}, target "
                f"{ex.target / UNIT:g}, parked {sorted(unconfirmed.load())}")
        ex.stats["settled"] += 1


def run(history):
    """→ (violations, stats). An exception inside a round is a violation too."""
    w = World()
    try:
        for events in history:
            w.round(events)
            if w.ended or w.ex.violations:
                break
        if not w.ended and not w.ex.violations:
            w.settle()
    except Exception as e:
        w.ex.violations.append(f"round {w.ex.round}: {type(e).__name__}: {str(e)[:200]}")
    return w.ex.violations, dict(w.ex.stats, ended=w.ended)


def shrink(history):
    """Drop rounds, then single events, while the history still fails."""
    cur = history
    changed = True
    while changed:
        changed = False
        for i in range(len(cur)):
            cand = cur[:i] + cur[i + 1:]
            if cand and run(cand)[0]:
                cur, changed = cand, True
                break
        if changed:
            continue
        for i, events in enumerate(cur):
            for j in range(len(events)):
                cand = cur[:i] + [events[:j] + events[j + 1:]] + cur[i + 1:]
                if run(cand)[0]:
                    cur, changed = cand, True
                    break
            if changed:
                break
    return cur


# a history each: the resend this exists to stop, in the shapes the scripted tests walk
FIXED = [
    ("timeout, the order filled, the row shows two rounds later",
     [[["target", 500], ["plan", [{"post": "timeout", "arrived": True, "row_lag": 2}]]], [], [], []]),
    ("10016, the order never arrived, the user says so",
     [[["target", 1000], ["plan", [{"post": "10016", "arrived": False}]]], [], [["resolve"]], []]),
    ("a restart with an entry parked",
     [[["target", 1500], ["plan", [{"post": "reset", "arrived": True, "row_lag": 99}]]], [["restart"]], []]),
    ("a flip whose close leg is unknown",
     [[["target", 500]], [["target", -500], ["plan", [{"post": "http502", "arrived": True, "row_lag": 1}]]], [], []]),
    ("killed after the order arrived",
     [[["target", 500], ["kill", "after"]], []]),
]


def _cut_parked(arrived=True, fill="full", row_lag=99):
    """Long 1500, then a cut to 1000 whose answer is lost: a 500 close parked. → (world, orders so far)"""
    w = World()
    SCRIPTED.append(w)
    w.round([["target", 1500]])
    w.round([["target", 1000], ["plan", [{"post": "timeout", "arrived": arrived, "fill": fill,
                                          "row_lag": row_lag}]]])
    return w, len(w.ex.orders)


SCRIPTED = []


def _sent(w, n):
    return [(o["side"], _usd(o["qty"]), o["reduce"]) for o in w.ex.orders[n:]]


def scenarios():
    """→ [(name, what went wrong)] for the scripted histories. Amounts in USD of book cost."""
    bad = []

    def expect(name, got, want):
        if got != want:
            bad.append((name, f"got {got}, expected {want}"))

    close = lambda usd: ("Sell", float(usd), True)   # noqa: E731

    w, n = _cut_parked()
    expect("setup: the cut is parked as a close of 500",
           [(e["reduce_only"], abs(e["signed_diff"])) for e in unconfirmed.load().values()], [(True, 500.0)])
    w.round([])
    expect("target unchanged: the cut is not sent again", _sent(w, n), [])

    w, n = _cut_parked()
    w.round([["target", 500]])
    expect("target lower: only what the parked close does not cover", _sent(w, n), [close(500)])

    w, n = _cut_parked()
    w.round([["target", 0]])
    expect("target flat (a stop): the book minus the parked close, as before", _sent(w, n), [close(1000)])

    w, n = _cut_parked()
    w.round([["target", 700], ["plan", [{"post": "timeout", "arrived": True, "row_lag": 99}]]])
    expect("a second cut on top: its own 300 goes out", _sent(w, n), [close(300)])
    n = len(w.ex.orders)
    w.round([["target", 500]])
    expect("two closes parked (500 + 300): their sum comes off the cut", _sent(w, n), [close(200)])

    w, n = _cut_parked()
    w.round([["target", 1200]])
    expect("target back up: no close, and no entry while the close is parked", _sent(w, n), [])

    w, n = _cut_parked(fill="none", row_lag=2)
    w.round([])
    expect("before the answer: nothing", _sent(w, n), [])
    w.round([])
    expect("the venue answers unfilled: released, the cut is sent that round", _sent(w, n), [close(500)])
    expect("…and nothing is left parked", sorted(unconfirmed.load()), [])

    w, n = _cut_parked(row_lag=2)
    w.round([])
    w.round([])
    w.round([])
    expect("the venue answers filled: booked, nothing sent", _sent(w, n), [])
    expect("…book and position at the target", (_book_usd(), _usd(w.ex.pos)), (1000.0, 1000.0))

    # parked closes are summed without their direction: in this script the entry hold keeps the
    # round from taking the book to the other side of one (an earlier parked entry that settles
    # as filled can still flip it — seed 611)
    w, n = _cut_parked()
    w.round([["target", -500]])
    expect("flip while a close is parked: the close leg only, no entry", _sent(w, n), [close(1000)])
    n = len(w.ex.orders)
    w.round([])
    expect("…the book keeps what the parked close may hold, long; the short stays held",
           (_sent(w, n), _book_usd()), ([], 500.0))
    expect("…the parked close sells, the book never went short",
           [e.get("sign") for e in unconfirmed.load().values() if e.get("reduce_only")], [-1])

    return bad + [("a property broke", w.ex.violations[0]) for w in SCRIPTED if w.ex.violations]


def main():
    args = sys.argv[1:]
    n = int(args[0]) if args and args[0].isdigit() else int(os.environ.get("FUZZ_N", "300"))
    seed0 = int(args[args.index("--seed") + 1]) if "--seed" in args else 1
    t0 = time.time()
    failed, total = [], {"posts": 0, "unknown": 0, "held_rounds": 0, "settled": 0, "killed": 0, "rounds": 0}
    for label, history in [(f"fixed: {name}", h) for name, h in FIXED] + \
                          [(f"seed {s}", gen(s)) for s in range(seed0, seed0 + n)]:
        bad, stats = run(history)
        for k in ("posts", "unknown", "held_rounds", "settled"):
            total[k] += stats[k]
        total["killed"] += stats["ended"] is not None
        total["rounds"] += len(history)
        if bad:
            failed.append((label, history, bad))
    print(f"{len(FIXED)} fixed histories + {n} random (seeds {seed0}..{seed0 + n - 1}): {total['rounds']} rounds, "
          f"{total['posts']} orders sent, {total['unknown']} answered unknown, {total['held_rounds']} rounds "
          f"ended with an order still unknown; {total['settled']} histories ran to the settle check, "
          f"{total['killed']} ended HALTed on an order that died mid-flight ({time.time() - t0:.1f}s)")
    if min(total["unknown"], total["held_rounds"], 2 * total["settled"]) < n // 2:
        print("FAIL the histories no longer reach the unknown-outcome path — the generator or the wiring drifted")
        failed.append(("coverage", [], ["too few unknown outcomes"]))
    scripted = scenarios()
    for name, why in scripted:
        print(f"FAIL scripted: {name} — {why}")
        failed.append((f"scripted: {name}", [], [why]))
    print(f"scripted histories: {'ok' if not scripted else f'{len(scripted)} failed'}")
    for label, history, bad in [f for f in failed if f[1]][:5]:
        print(f"FAIL {label}: {bad[0]}")
        if history:
            small = shrink(history)
            print(f"  shortest history that still fails ({len(small)} of {len(history)} rounds): {json.dumps(small)}")
            print(f"  there: {run(small)[0][:3]}")
            if label.startswith("seed "):
                print(f"  rerun: tests/check_order_outcome_unknown_fuzz.py 1 --seed {label.split()[1]}")
    shutil.rmtree(WS, ignore_errors=True)
    if failed:
        print(f"\n{len(failed)} FAILED")
        return 1
    print("\nall ok")
    return 0


if __name__ == "__main__":
    sys.exit(main())
