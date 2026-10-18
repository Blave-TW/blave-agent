"""Property test for the first-signal wait: it may only send less than the same round without it.

Thousands of random histories (seeded, reproducible) through the real aggregate_portfolio → reconcile
with a fake venue, each run twice — the feature on, and the feature off (_first_signal_holds → {},
which is f81ca0b's behaviour: `--dump` writes the off path's orders so another lib tree can be
diffed against it). A history: neighbours (single-symbol and a Type C portfolio), leavers, newcomers
(single-symbol and a UNIVERSE portfolio), account-read (marks move) or book mode, swap or spot; before
the save a HALT with a signal flip, a rejected order, a hand close, a signal gate; the save; inside
the window neighbour signals, newcomers computing, a neighbour's state vanishing and coming back,
HALT, signal gates, unrouting, rejected orders, hand closes, mark moves, a second save, time.

Each round, for every key: the position after the round stays inside [the book before it, the
target without the newcomers] — newcomer = a member that joined with no state and has never had a
share of the key, counted out while any newcomer on the key is still inside its window (one 1h bar).
That target is computed here from the history, not read from the lib. After the windows (gates and
HALT cleared, three rounds) both paths end on the same position (account-read mode: within the
drift band, which leaves path-dependent residue a hand close made).

Run: cd blave-agent && .venv/bin/python tests/check_first_signal_fuzz.py [N] [--seed S] [--dump F]
"""
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
os.chdir(BASE)
logging.disable(logging.CRITICAL)

from lib import portfolio  # noqa: E402

portfolio._daily_sigma = lambda symbol: None
CLOCK = [time.time()]
FEATURE = [True]
_holds = getattr(portfolio, "_first_signal_holds", None)
if _holds:
    portfolio._first_signal_holds = (lambda amounts, exchanges, now=None:
                                     _holds(amounts, exchanges, now=CLOCK[0]) if FEATURE[0] else {})

KEYS = ("BTCUSDT", "ETHUSDT")
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
    def __init__(self):
        self.qty, self.mark, self.reject, self.fills = {}, 1.0, False, []

    def positions(self):
        return {k: {"side": "long" if q > 0 else "short", "size": abs(q) * self.mark, "exchange": "binance"}
                for k, q in self.qty.items() if abs(q) > 1e-12}

    def place(self, symbol, signed_diff, asset_spec, reduce_only=False):
        if self.reject:
            raise RuntimeError("insufficient margin")
        self.fills.append((symbol, signed_diff))
        self.qty[symbol] = self.qty.get(symbol, 0.0) + signed_diff / self.mark
        return {"executed_qty": abs(signed_diff) / self.mark, "avg_price": self.mark}


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
        for d in ("manager", "strategies", "state"):
            shutil.rmtree(d, ignore_errors=True)
            os.makedirs(d)
        if _holds:
            portfolio._first_signal_unsaved = None
        portfolio._baseline_seen = None
        FEATURE[0] = feature
        CLOCK[0] = 1.8e9
        self.ops, self.v = ops, Venue()
        self.market = "spot" if ops["spot"] else "swap"
        self.sfx = "@spot" if ops["spot"] else ""
        self.amounts, self.routed, self.halt, self.gate = dict(ops["init"]), set(ops["init"]), False, {}
        self.states, self.newcomers, self.ever_state = {}, set(), set()
        self.since, self.cohort = {}, {k: set() for k in KEYS}
        for n in ("n1", "n2", "l1", "l2", "d1", "d2"):
            write_strategy(n, sym=ops["single"][n], market=self.market)
        write_strategy("pc", universe=list(KEYS), market=self.market)
        write_strategy("dp", universe=list(KEYS), market=self.market)
        for n, s in ops["states"].items():
            self.put_state(n, s.get("position"), s.get("weights"))
        self.write_config()
        self.rows = []

    def key(self, sym):
        return sym + self.sfx

    def put_state(self, n, position=None, weights=None):
        if weights is not None:
            s = {"weights": weights, "rebalance_at": CLOCK[0]}
        else:
            s = {"symbol": self.ops["single"][n], "position": position}
        self.states[n] = s
        self.ever_state.add(n)
        json.dump(s, open(f"strategies/{n}/state.json", "w"))

    def drop_state(self, n):
        self.states.pop(n, None)
        try:
            os.remove(f"strategies/{n}/state.json")
        except OSError:
            pass

    def write_config(self):
        json.dump({"self_ledger": self.ops["ledger"], "amounts": self.amounts,
                   "exchanges": {n: ("binance" if n in self.routed else "") for n in self.amounts},
                   "asset_specs": {}}, open("manager/portfolio_config.json", "w"))

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
            self.halt = ev[1]
            if ev[1]:
                json.dump({"reason": "user", "source": "desktop", "ts": CLOCK[0]}, open("state/HALT", "w"))
            elif os.path.exists("state/HALT"):
                os.remove("state/HALT")
        elif op == "gate":
            s = self.states.get(ev[1])
            if s and "position" in s:
                self.gate[ev[1]] = s["position"]
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
                self.v.qty[k] *= ev[2]
        elif op == "mark":
            self.v.mark = ev[1]
        elif op == "save":
            new = dict(ev[1])
            for n in new:
                if n not in self.amounts or not self.amounts.get(n):
                    self.routed.add(n)
                    if n in ("d1", "d2", "dp") and n not in self.ever_state:
                        self.newcomers.add(n)
            self.amounts = new
            self.write_config()

    # what this history says the target is without the newcomers
    def keys_of(self, n):
        return [self.key(self.ops["single"][n])] if n in self.ops["single"] else [self.key(k) for k in KEYS]

    def waiting(self, n):
        return bool(self.amounts.get(n)) and n in self.routed and n not in self.states

    def windows(self):
        """{key: active} as the lib's window would have it this round (the first round that sees a
        funded, routed member without a state starts its bar; a member that leaves forgets it)."""
        for n in list(self.since):
            if not self.waiting(n):
                del self.since[n]
        for n in self.amounts:
            if self.waiting(n) and n not in self.since:
                self.since[n] = CLOCK[0]
        active = {k: False for k in map(self.key, KEYS)}
        for n, t in self.since.items():
            if CLOCK[0] < t + WINDOW:
                for k in self.keys_of(n):
                    active[k] = True
        return active

    def base_target(self, k, active):
        if not active:
            self.cohort[k.split("@")[0]] = set()
        coh = self.cohort[k.split("@")[0]]
        if active:
            # a newcomer past its own window is just a member without a state yet
            coh |= {n for n in self.newcomers if self.amounts.get(n) and k in self.keys_of(n)
                    and n in self.since and CLOCK[0] < self.since[n] + WINDOW}
        s = 0.0
        for n, a in self.amounts.items():
            st = self.states.get(n)
            if not a or n not in self.routed or not st or n in coh:
                continue
            if "weights" in st:
                w = float(st["weights"].get(k.split("@")[0], 0) or 0)
                s += a * (max(w, 0.0) if self.ops["spot"] else w)
            elif self.key(st["symbol"]) == k:
                s += a * float(st["position"])
        return max(s, 0.0) if self.ops["spot"] else s

    def round(self, check):
        self.v.fills = []
        active = self.windows()
        tb = {k: self.base_target(k, active[k]) for k in active}
        portfolio.reconcile(self.v.positions, self.v.place)
        self.v.reject = False
        snap = json.load(open("manager/last_reconcile.json"))
        book = snap.get("ledger") if "ledger" in snap else snap.get("actual") or {}
        try:
            self.gate = json.load(open("state/signal_gate.json"))  # a gate lifts in the lib
        except OSError:
            self.gate = {}
        out = {}
        if FEATURE[0]:
            STATS["window"] += sum(1 for k in tb if active[k])
            STATS["held"] += sum(1 for r in snap["target"].values() if abs(float(r.get("frozen") or 0)) > EPS)
        for k in tb:
            row = book.get(k) or {}
            a0 = float(row.get("size") or 0) * (1 if row.get("side") == "long" else -1 if row.get("side") == "short" else 0)
            d = sum(x for s, x in self.v.fills if s == k)
            p1 = a0 + d
            lo, hi = min(a0, tb[k]), max(a0, tb[k])
            out[k] = (round(a0, 4), round(d, 4), round(tb[k], 4), active[k])
            if check and not (lo - EPS <= p1 <= hi + EPS):
                self.violations.append((k, a0, d, tb[k], active[k]))
        self.rows.append(sorted((s, round(x, 6)) for s, x in self.v.fills))
        return out

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
        self.routed |= set(self.amounts)
        self.write_config()
        self.round(check)  # a member routed again starts its own window here
        CLOCK[0] += 2 * WINDOW + 10
        for _ in range(3):
            self.round(check)
        return self.final()

    def final(self):
        snap = json.load(open("manager/last_reconcile.json"))
        book = snap.get("ledger") if "ledger" in snap else snap.get("actual") or {}
        out = {}
        for k in map(self.key, KEYS):
            row = book.get(k) or {}
            a0 = float(row.get("size") or 0) * (1 if row.get("side") == "long" else -1 if row.get("side") == "short" else 0)
            out[k] = a0 + sum(x for s, x in self.v.fills if s == k)
        tg = {k: (snap["target"].get(k) or {}) for k in out}
        return out, {k: float(r.get("size") or 0) * (1 if r.get("side") == "long" else -1 if r.get("side") == "short" else 0)
                     for k, r in tg.items()}


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
    for s in range(seed0, seed0 + n):
        ops = gen(s)
        w = World(ops, feature=True)
        pf, tf = w.run(True)
        rounds += len(w.rows)
        if w.violations:
            bad.append((s, w.violations[:3]))
        c = World(ops, feature=False)
        pc, tc = c.run(False)
        for k in pf:
            # account-read: the drift band leaves a same-side gap under 5% of the target where either
            # path happened to stop, so the two can differ by that much without anything held
            tol = EPS if ops["ledger"] else 2 * 0.05 * abs(tf[k]) + 2 * 10
            if abs(tf[k] - tc[k]) > EPS or abs(pf[k] - pc[k]) > tol:
                unconverged.append((s, k, round(pf[k], 4), round(pc[k], 4), tf[k], tc[k]))
    print(f"{n} histories, {rounds} rounds (seeds {seed0}..{seed0 + n - 1}); feature path: "
          f"{STATS['window']} key-rounds inside a window, {STATS['held']} with something held")
    for s, v in bad[:20]:
        print(f"FAIL seed {s}: position left [book, target without newcomers]: "
              f"{[(k, round(a, 4), round(d, 4), round(t, 4), act) for k, a, d, t, act in v]}")
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
