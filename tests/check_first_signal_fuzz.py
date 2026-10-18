"""Property test for the first-signal wait: no round sends more than, or the other way from, what
the same round sends without it.

Thousands of random histories (seeded, reproducible) through the real aggregate_portfolio → reconcile
with a fake venue. Every round the same workspace is reconciled twice: as shipped, and on a copy with
_first_signal_holds → {} (f81ca0b's behaviour, its orders discarded). A history: neighbours
(single-symbol and a Type C portfolio), leavers, newcomers (single-symbol and a UNIVERSE portfolio),
account-read (marks move) or book mode, swap or spot; before the save a HALT with a signal flip, a
rejected order, a hand close, a signal gate; the save; inside the window neighbour signals, newcomers
computing, a neighbour's state vanishing and coming back, HALT, signal gates, unrouting, rejected
orders, hand closes, mark moves, a second save, time. FIXED holds histories found by the audit's own
fuzz (lots on a book, a second exchange, a hand close) that broke an earlier bound; they run first.

Each round, for every key: the position after the round stays inside [the book before it, the
position the same round without the wait leaves]. After the windows (gates and HALT cleared, three
rounds) the two whole histories end on the same position (account-read mode: within the drift band,
which leaves path-dependent residue a hand close made).

Run: cd blave-agent && .venv/bin/python tests/check_first_signal_fuzz.py [N] [--seed S] [--dump F]
"""
import copy
import json
import logging
import os
import random
import shutil
import sys
import tempfile
import time

ROOT = os.environ.get("FUZZ_LIB_ROOT") or os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
BASE = tempfile.mkdtemp(prefix="first-signal-fuzz-")
W, C = os.path.join(BASE, "w"), os.path.join(BASE, "c")
os.makedirs(W)
os.chdir(W)
logging.disable(logging.CRITICAL)

from lib import guard, portfolio  # noqa: E402

portfolio._daily_sigma = lambda symbol: None
CLOCK = [time.time()]
FEATURE = [True]
_holds = getattr(portfolio, "_first_signal_holds", None)
if _holds:
    portfolio._first_signal_holds = (lambda amounts, exchanges, now=None:
                                     _holds(amounts, exchanges, now=CLOCK[0]) if FEATURE[0] else {})
# keys a fixed history marks as waiting on an unreadable state (op "pend": ledger mode, N rounds)
PEND = [set()]
_resolve = portfolio.resolve_pending
portfolio.resolve_pending = lambda target, actual, config: set(PEND[0]) | set(_resolve(target, actual, config) or ())
GLOBS = {"_baseline_seen": None, "_baseline_wait": None, "_pending_seen": {}, "_mismatch_noted": set(),
         "_unconfigured_logged": False, "_first_signal_unsaved": None, "_first_signal_errors": set()}

KEYS = ("BTCUSDT", "ETHUSDT")
LOT_KEYS = ("GDF", "UDF")
LOTSPEC = {"type": "futures_contracts", "contract_value": 50, "currency": "TWD", "lot_size": 1}
STATS = {"window": 0, "held": 0}
WINDOW = 3600
EPS = 1e-6


def write_strategy(name, sym=None, universe=None, market="swap"):
    d = f"strategies/{name}"
    os.makedirs(d, exist_ok=True)
    src = (f'SYMBOL = "{sym}"\n' if sym else "") + 'INTERVAL = "1h"\n'
    src += 'MARKET = "spot"\n' if market == "spot" else ""
    if universe:
        src += "UNIVERSE = [" + ", ".join(f'"{u}"' for u in universe) + "]\n"
    open(f"{d}/strategy.py", "w").write(src)


class Venue:
    """lots: sizes are contracts. label: the read says which exchange; refuse: a second bound
    venue whose orders this wiring cannot place."""

    def __init__(self, lots=False, label="binance", refuse=()):
        self.qty, self.mark, self.reject, self.fills = {}, 1.0, False, []
        self.lots, self.label, self.refuse = lots, label, set(refuse)

    def positions(self):
        out = {}
        for k, q in self.qty.items():
            if abs(q) > 1e-12:
                out[k] = {"side": "long" if q > 0 else "short", "size": abs(q) * (1 if self.lots else self.mark)}
                if self.lots:
                    out[k]["unit"] = "contracts"
                if self.label:
                    out[k]["exchange"] = self.label
        return out

    def place(self, symbol, signed_diff, asset_spec, reduce_only=False, exchange=None, **kw):
        if self.reject:
            raise RuntimeError("insufficient margin")
        if exchange in self.refuse:
            return False
        if self.lots:
            self.fills.append((symbol, float(signed_diff)))
            self.qty[symbol] = self.qty.get(symbol, 0.0) + signed_diff
            return {"executed_qty": abs(signed_diff), "avg_price": 20000.0}
        self.fills.append((symbol, signed_diff))
        self.qty[symbol] = self.qty.get(symbol, 0.0) + signed_diff / self.mark
        return {"executed_qty": abs(signed_diff) / self.mark, "avg_price": self.mark}


# the audit's fuzz (ae06e6a) seeds 2625 (two newcomers on one key, a neighbour on a second
# exchange: the pair bought 600 where the same round without the wait bought 500, then sold 100),
# 2342 (lots on a book: a newcomer past its own window kept in the cohort, 3 lots bought for 2) and
# 1624 (a hand close, then a buy where the round without the wait sold); the audit of 0b16add seeds
# 1357, 1550 and 8354 (lots on a paper book: a leaver's lots the account does not hold, a newcomer
# waiting on the key, nothing held — a window target of 0 closed what the round without it, which
# has no row there, leaves; 8354 ended MXF −1)
FIXED = [
    (2625, {"kind": "swap", "ledger": False, "labels": {"n1": "okx"}, "refuse": ["okx"],
            "single": {"n1": "BTCUSDT", "n2": "BTCUSDT", "l1": "ETHUSDT", "l2": "BTCUSDT", "d1": "BTCUSDT", "d2": "BTCUSDT"},
            "init": {"n2": 200.0, "pc": 200.0},
            "states": {"n2": {"position": 0.5}, "pc": {"weights": {"BTCUSDT": 0, "ETHUSDT": 0.3}}},
            "pre": [[], []],
            "win": [[["save", {"n2": 200.0, "pc": 200.0, "d1": 200.0}], ["tick", 71]],
                    [["tick", 600], ["reject", True], ["signal", "n2", -0.5], ["signal", "n2", 0]],
                    [["tick", 300]],
                    [["tick", 1500], ["gate", "n2"], ["save", {"n2": 300.0, "pc": 200.0, "d1": 200.0}]],
                    [["tick", 60], ["vanish", "n2"]],
                    [["tick", 900], ["halt", True], ["route", "pc", False], ["compute", "d1", -0.5]],
                    [["tick", 300]],
                    [["tick", 600], ["restore", "n2", 2], ["halt", False],
                     ["save", {"n2": 300.0, "pc": 200.0, "d1": 200.0, "d2": 500.0}]]]}),
    (2342, {"kind": "lots", "ledger": True,
            "single": {"n1": "GDF", "n2": "UDF", "l1": "GDF", "l2": "UDF", "d1": "GDF", "d2": "UDF"},
            "init": {"n1": 3.0, "n2": 2.0, "l1": 3.0, "l2": 1.0},
            "states": {"n1": {"position": 1}, "n2": {"position": 0.5}, "l1": {"position": -1}, "l2": {"position": 0}},
            "pre": [[], [], []],
            "win": [[["save", {"n1": 3.0, "n2": 2.0, "l1": 3.0, "l2": 0.0, "d1": 2.0}], ["tick", 138]],
                    [["tick", 600], ["compute", "d1", -0.5], ["vanish", "n1"]],
                    [["tick", 900], ["save", {"n1": 3.0, "n2": 2.0, "l1": 3.0, "d1": 2.0, "d2": 2.0}], ["signal", "l1", 1]],
                    [["tick", 900], ["signal", "n2", 0.5]]]}),
    (1624, {"kind": "swap", "ledger": False,
            "single": {"n1": "BTCUSDT", "n2": "ETHUSDT", "l1": "ETHUSDT", "l2": "BTCUSDT", "d1": "ETHUSDT", "d2": "BTCUSDT"},
            "init": {"n1": 800.0, "n2": 500.0, "l1": 200.0, "l2": 300.0},
            "states": {"n1": {"position": 0.5}, "n2": {"position": -1}, "l1": {"position": 0.5}, "l2": {"position": 0}},
            "pre": [[], [["reject", True], ["signal", "l2", 0]]],
            "win": [[["save", {"n1": 800.0, "n2": 500.0, "l1": 0.0, "l2": 300.0, "d1": 200.0}], ["tick", 185]],
                    [["tick", 900], ["vanish", "n1"], ["save", {"n1": 800.0, "n2": 500.0, "l2": 300.0, "d1": 200.0, "d2": 500.0}]],
                    [["tick", 1500], ["compute", "d2", -0.5], ["hand", "BTCUSDT", 0.5]],
                    [["tick", 1500], ["signal", "n2", 0]],
                    [["tick", 60], ["signal", "l2", 1]]]}),
    (1357, {"kind": "lots", "ledger": True, "single": {"n1": "GDF", "n2": "GDF", "l1": "UDF", "l2": "GDF", "d1": "GDF", "d2": "UDF"}, "init": {"n1": 2.0, "n2": 1.0, "l1": 3.0, "l2": 1.0}, "states": {"n1": {"position": 1}, "n2": {"position": 1}, "l1": {"position": -1}, "l2": {"position": 0}}, "pre": [[], [], [["hand", "UDF", 0.0]]], "win": [[["save", {"n1": 2.0, "n2": 1.0, "l2": 1.0, "d1": 2.0}], ["tick", 189]], [["tick", 300]], [["tick", 60], ["save", {"n1": 2.0, "n2": 1.0, "l2": 1.0, "d1": 2.0, "d2": 1.0}], ["hand", "UDF", 0.0], ["compute", "d1", 0]], [["tick", 900], ["compute", "d2", -1], ["route", "l2", True], ["save", {"n1": 2.0, "n2": 1.0, "l2": 1.0, "d1": 2.0, "d2": 1.0}]], [["tick", 300], ["save", {"n1": 1.0, "n2": 1.0, "l2": 1.0, "d1": 2.0, "d2": 1.0}]], [["tick", 300], ["halt", False]], [["tick", 900], ["restore", "n1", 0]]]}),
    (1550, {"kind": "lots", "ledger": True, "single": {"n1": "GDF", "n2": "UDF", "l1": "UDF", "l2": "UDF", "d1": "GDF", "d2": "UDF"}, "init": {"n1": 2.0, "n2": 2.0, "l1": 3.0}, "states": {"n1": {"position": -1}, "n2": {"position": 1}, "l1": {"position": 0.5}}, "pre": [[], [], [["hand", "GDF", 0.0]]], "win": [[["save", {"n1": 2.0, "n2": 2.0, "l1": 3.0}], ["tick", 59]], [["tick", 600], ["pend", "UDF", 3], ["save", {"n1": 2.0, "n2": 2.0, "l1": 3.0, "d2": 1.0}]], [["tick", 60], ["vanish", "n2"], ["route", "n1", True]], [["tick", 60], ["pend", "UDF", 3], ["save", {"n1": 2.0, "n2": 2.0, "l1": 3.0, "d2": 1.0}]], [["tick", 300]], [["tick", 1500]], [["tick", 300], ["signal", "n2", 0.5], ["signal", "n2", 1]], [["tick", 1500], ["pend", "GDF", 3]], [["tick", 300], ["save", {"n1": 2.0, "n2": 1.0, "l1": 3.0, "d2": 1.0}], ["signal", "n1", 0.5]], [["tick", 60], ["vanish", "n1"], ["save", {"n1": 2.0, "n2": 0.0, "l1": 3.0, "d2": 1.0}], ["save", {"n1": 2.0, "l1": 3.0, "d2": 3.0}]]]}),
    (8354, {"kind": "lots", "ledger": True, "keys": ["MXF", "TMF"], "single": {"n1": "MXF", "n2": "MXF", "l1": "MXF", "l2": "TMF", "d1": "MXF", "d2": "MXF"}, "init": {"l1": 1.0, "l2": 2.0}, "states": {"l1": {"position": 0.5}, "l2": {"position": -1}}, "pre": [[], [], [["hand", "MXF", 0.0]]], "win": [[["save", {"d1": 1.0}], ["tick", 136]], [["tick", 60], ["reject", True]], [["tick", 600]], [["tick", 60], ["hand", "MXF", 0.9], ["route", "d1", False]], [["tick", 900], ["route", "d1", True]], [["tick", 600]], [["tick", 300], ["reject", True], ["pend", "MXF", 2]], [["tick", 900]], [["tick", 600], ["save", {"d1": 1.0, "d2": 1.0}], ["route", "d1", False]], [["tick", 1500], ["halt", False]], [["tick", 60], ["halt", False]]]}),
]


# ── a history ───────────────────────────────────────────────────────────────
def gen(seed):
    r = random.Random(seed)
    spot = r.random() < 0.15
    ledger = r.random() < 0.35
    pos = (lambda: r.choice([0, 0.5, 1, 1, 2])) if spot else (lambda: r.choice([-1, -0.5, 0, 0.5, 1, 1, 2]))
    wts = lambda: {k: r.choice([0, 0.3, 0.5, 1]) if spot else r.choice([-0.5, 0, 0.3, 0.5, 1]) for k in KEYS}
    amt = lambda: float(r.choice([100, 200, 300, 500, 800]))
    single = {}
    for n in ("n1", "n2", "l1", "l2", "d1", "d2"):
        single[n] = r.choice(KEYS)
    with_pc, with_dp = r.random() < 0.4, r.random() < 0.3
    init = {n: amt() for n in ("n1", "n2", "l1", "l2") if r.random() < 0.8} or {"l1": amt()}
    if with_pc:
        init["pc"] = amt()
    states = {n: {"position": pos()} for n in init if n != "pc"}
    if with_pc:
        states["pc"] = {"weights": wts()}
    ops = {"spot": spot, "ledger": ledger, "single": single, "init": init, "states": states, "pre": [], "win": []}
    names = lambda: list(cur)
    cur = dict(init)
    # before the save: one round or two of ordinary trading, then maybe a round with trouble
    pre = [[] for _ in range(3 if ledger else 2)]
    last = pre[-1]
    roll = r.random()
    sig = [n for n in cur if n != "pc"]
    if roll < 0.15 and sig:
        last += [("halt", True), ("signal", r.choice(sig), pos())]
    elif roll < 0.3 and sig:
        last += [("reject", True), ("signal", r.choice(sig), pos())]
    elif roll < 0.45:
        last += [("hand", r.choice(KEYS), r.choice([0.0, 0.3, 0.7, 1.2]))]
    elif roll < 0.6 and sig:
        last += [("gate", r.choice(sig))]
    ops["pre"] = pre
    # the save: some leave, newcomers join, a neighbour's amount may change, a state may vanish
    after = dict(cur)
    for n in [n for n in cur if n.startswith("l")]:
        if r.random() < 0.8:
            after[n] = 0.0 if r.random() < 0.5 else None
    for n in [n for n in cur if n.startswith("n")]:
        if r.random() < 0.2:
            after[n] = amt()
    joiners = [n for n in ("d1", "d2") if r.random() < (0.9 if n == "d1" else 0.35)]
    if with_dp and r.random() < 0.7:
        joiners.append("dp")
    for n in joiners:
        after[n] = amt()
    save = [("save", {n: a for n, a in after.items() if a is not None})]
    if r.random() < 0.2 and [n for n in cur if n.startswith("n")]:
        save.append(("vanish", r.choice([n for n in cur if n.startswith("n")])))
    win = [save + [("tick", r.randint(30, 300))]]
    cur = {n: a for n, a in after.items() if a}
    for _ in range(r.randint(3, 12)):
        ev = [("tick", r.choice([60, 300, 600, 900, 1500]))]
        for _ in range(r.randint(0, 3)):
            x = r.random()
            live = [n for n in cur if n in single and not n.startswith("d")]
            if x < 0.2 and live:
                ev.append(("signal", r.choice(live), pos()))
            elif x < 0.32 and joiners:
                n = r.choice(joiners)
                ev.append(("compute", n, wts() if n == "dp" else pos()))
            elif x < 0.38 and "pc" in cur:
                ev.append(("weights", "pc", wts()))
            elif x < 0.44 and live:
                ev.append(("vanish", r.choice(live)))
            elif x < 0.5 and live:
                ev.append(("restore", r.choice(live), pos()))
            elif x < 0.56:
                ev.append(("halt", r.random() < 0.5))
            elif x < 0.62 and live:
                ev.append(("gate", r.choice(live)))
            elif x < 0.66:
                ev.append(("ungate",))
            elif x < 0.71 and names():
                ev.append(("route", r.choice(names()), r.random() < 0.5))
            elif x < 0.78:
                ev.append(("reject", True))
            elif x < 0.84:
                ev.append(("hand", r.choice(KEYS), r.choice([0.0, 0.5, 0.9, 1.1])))
            elif x < 0.9 and not ledger:
                ev.append(("mark", r.choice([0.9, 0.97, 1.03, 1.1])))
            elif x < 0.96:
                nxt = dict(cur)
                y = r.random()
                if y < 0.35 and nxt:
                    nxt[r.choice(list(nxt))] = 0.0
                elif y < 0.7 and "d2" not in nxt:
                    nxt["d2"] = amt()
                    joiners.append("d2")
                elif nxt:
                    nxt[r.choice(list(nxt))] = amt()
                ev.append(("save", nxt))
                cur = {n: a for n, a in nxt.items() if a}
        win.append(ev)
    ops["win"] = win
    return ops


# ── running it ──────────────────────────────────────────────────────────────
class World:
    def __init__(self, ops, feature):
        os.chdir(W)
        for d in ("manager", "strategies", "state"):
            shutil.rmtree(d, ignore_errors=True)
            os.makedirs(d)
        for g, v in GLOBS.items():
            if hasattr(portfolio, g):
                setattr(portfolio, g, copy.deepcopy(v))
        guard._halt_flag = False
        FEATURE[0] = feature
        CLOCK[0] = 1.8e9
        self.ops = ops
        self.kind = ops.get("kind") or ("spot" if ops.get("spot") else "swap")
        self.lots = self.kind == "lots"
        self.keys = tuple(ops.get("keys") or (LOT_KEYS if self.lots else KEYS))
        self.pend_left = {}
        self.ex = "paper" if self.lots else "binance"
        self.v = Venue(lots=self.lots, label=self.ex, refuse=ops.get("refuse") or ())
        self.market = "spot" if self.kind == "spot" else "swap"
        self.sfx = "@spot" if self.kind == "spot" else ""
        self.amounts, self.routed, self.gate = dict(ops["init"]), set(ops["init"]), {}
        self.states, self.ever_state = {}, set()
        for n in ("n1", "n2", "l1", "l2", "d1", "d2"):
            write_strategy(n, sym=ops["single"][n], market=self.market)
        if not self.lots:
            write_strategy("pc", universe=list(self.keys), market=self.market)
            write_strategy("dp", universe=list(self.keys), market=self.market)
        for n, st in ops["states"].items():
            self.put_state(n, st.get("position"), st.get("weights"))
        self.write_config()
        self.rows = []

    def key(self, sym):
        return sym + self.sfx

    def put_state(self, n, position=None, weights=None):
        if weights is not None:
            st = {"weights": weights, "rebalance_at": CLOCK[0]}
        else:
            st = {"symbol": self.ops["single"][n], "position": position}
        self.states[n] = st
        self.ever_state.add(n)
        json.dump(st, open(f"strategies/{n}/state.json", "w"))

    def drop_state(self, n):
        self.states.pop(n, None)
        try:
            os.remove(f"strategies/{n}/state.json")
        except OSError:
            pass

    def write_config(self):
        labels = self.ops.get("labels") or {}
        json.dump({"self_ledger": self.ops["ledger"], "amounts": self.amounts,
                   "exchanges": {n: ((labels.get(n) or self.ex) if n in self.routed else "") for n in self.amounts},
                   "asset_specs": {n: LOTSPEC for n in self.amounts} if self.lots else {}},
                  open("manager/portfolio_config.json", "w"))

    def write_gate(self):
        if self.gate:
            json.dump(self.gate, open("state/signal_gate.json", "w"))
        elif os.path.exists("state/signal_gate.json"):
            os.remove("state/signal_gate.json")

    def apply(self, ev):
        op = ev[0]
        if op == "tick":
            CLOCK[0] += ev[1]
        elif op in ("signal", "restore"):
            self.put_state(ev[1], position=ev[2])
        elif op == "compute":
            n = ev[1]
            self.put_state(n, weights=ev[2]) if n == "dp" else self.put_state(n, position=ev[2])
        elif op == "weights":
            self.put_state(ev[1], weights=ev[2])
        elif op == "vanish":
            self.drop_state(ev[1])
        elif op == "halt":
            if ev[1]:
                json.dump({"reason": "user", "source": "desktop", "ts": CLOCK[0]}, open("state/HALT", "w"))
            elif os.path.exists("state/HALT"):
                os.remove("state/HALT")
        elif op == "gate":
            st = self.states.get(ev[1])
            if st and "position" in st:
                self.gate[ev[1]] = st["position"]
                self.write_gate()
        elif op == "ungate":
            self.gate = {}
            self.write_gate()
        elif op == "route":
            (self.routed.add if ev[2] else self.routed.discard)(ev[1])
            self.write_config()
        elif op == "reject":
            self.v.reject = ev[1]
        elif op == "hand":
            k = self.key(ev[1])
            if k in self.v.qty:
                q = self.v.qty[k] * ev[2]
                self.v.qty[k] = float(round(q)) if self.lots else q
        elif op == "mark":
            self.v.mark = ev[1]
        elif op == "pend":
            if self.ops["ledger"]:
                self.pend_left[self.key(ev[1])] = ev[2]
        elif op == "save":
            new = dict(ev[1])
            for n in new:
                if new[n] and not self.amounts.get(n):
                    self.routed.add(n)
            self.amounts = new
            self.write_config()

    def book(self, snap):
        b = snap.get("ledger") if "ledger" in snap else snap.get("actual") or {}
        out = {}
        for k in map(self.key, self.keys):
            row = b.get(k) or {}
            out[k] = float(row.get("size") or 0) * (1 if row.get("side") == "long" else -1 if row.get("side") == "short" else 0)
        return out

    def off_round(self):
        """This round with the wait off, on a copy of the workspace: what it would have sent."""
        saved = {g: copy.deepcopy(getattr(portfolio, g)) for g in GLOBS if hasattr(portfolio, g)}
        halt_flag, venue = guard._halt_flag, copy.deepcopy(self.v)
        shutil.rmtree(C, ignore_errors=True)
        shutil.copytree(W, C)
        os.chdir(C)
        FEATURE[0], venue.fills = False, []
        try:
            portfolio.reconcile(venue.positions, venue.place)
        finally:
            FEATURE[0] = True
            os.chdir(W)
            for g, v in saved.items():
                setattr(portfolio, g, v)
            guard._halt_flag = halt_flag
        return {k: sum(x for s, x in venue.fills if s == k) for k in map(self.key, self.keys)}

    def round(self, check):
        PEND[0] = {k for k, left in self.pend_left.items() if left > 0}
        off = self.off_round() if check and FEATURE[0] else None
        self.v.fills = []
        portfolio.reconcile(self.v.positions, self.v.place)
        self.v.reject = False
        for k in self.pend_left:
            self.pend_left[k] -= 1
        snap = json.load(open("manager/last_reconcile.json"))
        try:
            self.gate = json.load(open("state/signal_gate.json"))  # a gate lifts in the lib
        except OSError:
            self.gate = {}
        if FEATURE[0]:
            STATS["window"] += sum(1 for r in snap["target"].values() if r.get("awaiting"))
            STATS["held"] += sum(1 for r in snap["target"].values() if abs(float(r.get("frozen") or 0)) > EPS)
        if off is not None:
            for k, a0 in self.book(snap).items():
                d = sum(x for s, x in self.v.fills if s == k)
                p1, p_off = a0 + d, a0 + off[k]
                tol = EPS if self.lots else max(EPS, 1e-6 * abs(a0))
                if not (min(a0, p_off) - tol <= p1 <= max(a0, p_off) + tol):
                    self.violations.append((len(self.rows), k, round(a0, 4), round(d, 4), round(off[k], 4)))
        self.rows.append(sorted((s, round(x, 6)) for s, x in self.v.fills))

    def run(self, check):
        self.violations = []
        for ev in self.ops["pre"]:
            for e in ev:
                self.apply(e)
            self.round(False)
        for ev in self.ops["win"]:
            for e in ev:
                self.apply(e)
            self.round(check)
        # after the windows: nothing left in the way, both paths settle on the same targets
        self.apply(("halt", False))
        self.apply(("ungate",))
        self.pend_left = {}
        self.routed |= set(self.amounts)
        self.write_config()
        self.round(check)  # a member routed again starts its own window here
        CLOCK[0] += 2 * WINDOW + 10
        for _ in range(3):
            self.round(check)
        return self.final()

    def final(self):
        snap = json.load(open("manager/last_reconcile.json"))
        b = self.book(snap)
        out = {k: b[k] + sum(x for s, x in self.v.fills if s == k) for k in b}
        tg = {k: (snap["target"].get(k) or {}) for k in out}
        return out, {k: float(r.get("size") or 0) * (1 if r.get("side") == "long" else -1 if r.get("side") == "short" else 0)
                     for k, r in tg.items()}


def one(seed, ops, bad, unconverged):
    w = World(ops, feature=True)
    pf, tf = w.run(True)
    if w.violations:
        bad.append((seed, w.violations[:3]))
    c = World(ops, feature=False)
    pc, tc = c.run(False)
    for k in pf:
        # account-read: the drift band leaves a same-side gap under 5% of the target where either
        # path happened to stop, so the two can differ by that much without anything held
        tol = EPS if ops["ledger"] else 2 * 0.05 * abs(tf[k]) + 2 * 10
        if abs(tf[k] - tc[k]) > EPS or abs(pf[k] - pc[k]) > tol:
            unconverged.append((seed, k, round(pf[k], 4), round(pc[k], 4), tf[k], tc[k]))
    return len(w.rows)


def main():
    args = sys.argv[1:]
    n = int(args[0]) if args and args[0].isdigit() else int(os.environ.get("FUZZ_N", "2000"))
    seed0 = int(args[args.index("--seed") + 1]) if "--seed" in args else 1
    dump = args[args.index("--dump") + 1] if "--dump" in args else None
    if dump:
        with open(dump, "w") as f:
            for s in range(seed0, seed0 + n):
                w = World(gen(s), feature=False)
                w.run(False)
                f.write(json.dumps([s, w.rows]) + "\n")
        print(f"dumped {n} control histories to {dump}")
        return 0
    bad, unconverged, rounds = [], [], 0
    fixed_bad, fixed_unc = [], []
    for s, ops in FIXED:
        one(f"audit-{s}", ops, fixed_bad, fixed_unc)
    for s in range(seed0, seed0 + n):
        rounds += one(s, gen(s), bad, unconverged)
    print(f"{len(FIXED)} fixed histories from the audit: {len(fixed_bad)} outside the bound, {len(fixed_unc)} unconverged")
    print(f"{n} histories, {rounds} rounds (seeds {seed0}..{seed0 + n - 1}); feature path: "
          f"{STATS['window']} key-rounds inside a window, {STATS['held']} with something held")
    bad, unconverged = fixed_bad + bad, fixed_unc + unconverged
    for s, v in bad[:20]:
        print(f"FAIL seed {s}: position left [book, the same round without the wait]: {v}")
    for row in unconverged[:20]:
        print(f"FAIL seed {row[0]}: after the windows {row[1]} feature {row[2]} vs without it {row[3]} "
              f"(targets {row[4]} / {row[5]})")
    print(f"interval violations: {len(bad)}, unconverged: {len(unconverged)}")
    if bad or unconverged:
        print(f"\n{len(bad) + len(unconverged)} FAILED")
        return 1
    print("\nall ok")
    return 0


if __name__ == "__main__":
    sys.exit(main())
