"""A funded member with no state.json yet (just joined, its old one moved away by the runtime's
_retire_prejoin_signals, or never computed) leaves what it replaces on the book until it writes its
first state — at most one bar of its INTERVAL, never longer than FIRST_SIGNAL_WAIT_MAX_S. What it
replaces is fixed at its first trusted round: the previous round's snapshot shares of the members that
no longer contribute (left / 0 / waiting again), bounded by what the book holds beyond the others'
share (in account-read mode shrinking with the book); inside the window the key's target is the
others' target now + that, never outside [book now, the others' target now] nor [book now, the same
round's target without the wait] — a neighbour's reduction (a stop included, even one between the save and the
first round) trades at once, its add is netted against the hold until the window closes. Swapping a
strategy for a new version on the same coin used to close the position one round and buy it back the
next. The invariant itself is fuzzed in tests/check_first_signal_fuzz.py.

Through the real aggregate_portfolio → reconcile with a fake venue:
  single → single switch, single → portfolio (UNIVERSE), portfolio keys from the backtest preview,
  no keys at all → not held (audit), the window (bar / cap / re-save does not restart it / leaving
  amounts clears it), past the window the exit goes out and the wait never restarts, an unrelated
  key still trades; a neighbour's stop and add go out once, a 5m neighbour beside a 1d newcomer, a
  member leaving mid-window waits too, a 150-stock UNIVERSE only freezes the difference; a stop
  between the save and the first round, a neighbour amount changed in the same save, a mark move in
  account-read mode (same orders as no swap at all); two newcomers on one key swap together; a Type C
  neighbour dropping the key is its own exit; a member coming back; an untrusted book / a pending key
  (nothing anchored); another gate wins; spot never goes short; lots stay whole; a
  non-UTF-8 strategy.py, a bug in the helper, a write that fails, a clock set back, NaN in the file;
  UNIVERSE comments (tests/fixtures/universe_comments.json, the shell reads the same); the gated
  contributor flag; HALT; a leaver's target that never reached the book (HALT, rejected, closed by
  hand), a save right after an entry round, a signal-gated leaver, another gate in the first round
  after the save, a neighbour whose state vanishes and comes back, no snapshot, a newcomer computing
  past its window, the anchor lost with one newcomer computed; a neighbour's stop after a hand close /
  a mark drop (account-read), a newcomer on another exchange, HALT + a rollover + a newcomer on
  the old contract.

Run: cd blave-agent && .venv/bin/python tests/check_first_signal_wait.py
"""
import json
import os
import shutil
import sys
import tempfile
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
os.chdir(tempfile.mkdtemp(prefix="first-signal-"))

from lib import guard, portfolio  # noqa: E402

portfolio._daily_sigma = lambda symbol: None
fails = 0


def check(cond, msg):
    global fails
    print(("ok   " if cond else "FAIL ") + msg)
    fails += 0 if cond else 1


def strat(name, symbol=None, interval="1h", universe=None, state=None, preview=None, market=None):
    d = f"strategies/{name}"
    os.makedirs(d, exist_ok=True)
    src = (f'SYMBOL = "{symbol}"\n' if symbol else "") + f'INTERVAL = "{interval}"\n'
    src += f'MARKET = "{market}"\n' if market else ""
    if universe:
        src += "UNIVERSE = [" + ", ".join(f'"{u}"' for u in universe) + "]\n"
    open(f"{d}/strategy.py", "w").write(src)
    if state is not None:
        json.dump(state, open(f"{d}/state.json", "w"))
    if preview is not None:
        json.dump(preview, open(f"{d}/backtest_state.json", "w"))


def config(amounts, specs=None):
    json.dump({"self_ledger": False, "amounts": amounts, "exchanges": {n: "binance" for n in amounts},
               "asset_specs": specs or {}}, open("manager/portfolio_config.json", "w"))


def fresh():
    for d in ("manager", "strategies", "state"):
        shutil.rmtree(d, ignore_errors=True)
        os.makedirs(d)


def audits(event):
    try:
        return [json.loads(x) for x in open(guard.AUDIT_PATH) if json.loads(x)["event"] == event]
    except OSError:
        return []


def book():
    return json.load(open("state/first_signal_wait.json"))


def backdate(name, seconds):
    b = book()
    b["members"][name]["since"] = time.time() - seconds
    json.dump(b, open("state/first_signal_wait.json", "w"))


class Venue:
    def __init__(self, held):
        self.held, self.calls = dict(held), []

    def positions(self):
        return {k: {"side": "long" if v > 0 else "short", "size": abs(v), "exchange": "binance"}
                for k, v in self.held.items() if v}

    def place(self, symbol, signed_diff, asset_spec, reduce_only=False):
        self.calls.append((symbol, round(signed_diff, 4)))
        self.held[symbol] = self.held.get(symbol, 0) + signed_diff
        return {"executed_qty": abs(signed_diff), "avg_price": 1.0}

    def round(self):
        del self.calls[:]
        portfolio.reconcile(self.positions, self.place)
        return list(self.calls)


def swap(before, after, held, specs=None):
    """A round on the config before the save (its snapshot is what the first round after it anchors
    on), then the save."""
    config(before, specs)
    v = Venue(held)
    got = v.round()
    assert got == [], f"the round before the save already traded: {got}"
    config(after, specs)
    return v


def snap_row(key):
    return json.load(open("manager/last_reconcile.json"))["target"].get(key) or {}


# ── single → single: btc to 0, its new version db joins on BTC
fresh()
strat("btc", "BTCUSDT", state={"symbol": "BTCUSDT", "position": 1})
strat("db", "BTCUSDT")
v = swap({"btc": 500}, {"btc": 0, "db": 500}, {"BTCUSDT": 500})
check(v.round() == [] and v.held == {"BTCUSDT": 500}, f"switch: BTC is not closed while db has no first signal ({v.calls})")
snap = json.load(open("manager/last_reconcile.json"))
row = snap["target"].get("BTCUSDT") or {}
check(not row.get("gated") and set(row.get("awaiting") or {}) == {"db"} and row.get("frozen") == 500
      and row.get("side") == "long" and row.get("size") == 500 and "first_signal_wait" in snap.get("caps", []),
      f"the snapshot names who it waits for, the frozen part and the window target, and the running code says it holds ({row})")
a = audits("first_signal_wait")
check(len(a) == 1 and a[0]["strategy"] == "db" and a[0]["keys"] == ["BTCUSDT"], f"one audit line when the wait starts ({a})")
check(v.round() == [] and len(audits("first_signal_wait")) == 1, "a second round inside the window: still nothing, no second audit line")
json.dump({"symbol": "BTCUSDT", "position": 1}, open("strategies/db/state.json", "w"))
check(v.round() == [] and v.held == {"BTCUSDT": 500}, f"db's first signal is long: no order at all — no close and buy-back ({v.calls})")
check("db" not in book()["members"] and not book()["anchors"], "the member and its key's anchor leave the record once it has a state")
json.dump({"symbol": "BTCUSDT", "position": 0}, open("strategies/db/state.json", "w"))
check(v.round() == [("BTCUSDT", -500)], f"after that it trades its own signal as ever ({v.calls})")

# ── single → portfolio: eth removed, portfolio dc joins with ETH in its UNIVERSE
fresh()
strat("btc", "BTCUSDT", state={"symbol": "BTCUSDT", "position": 1})
strat("eth", "ETHUSDT", state={"symbol": "ETHUSDT", "position": 1})
strat("dc", universe=["ETHUSDT", "SOLUSDT"])
v = swap({"btc": 500, "eth": 300}, {"btc": 500, "dc": 600}, {"BTCUSDT": 500, "ETHUSDT": 300})
check(v.round() == [] and v.held["ETHUSDT"] == 300, f"switch to a portfolio: ETH is held through its UNIVERSE ({v.calls})")
json.dump({"symbol": None, "position": 0, "weights": {"ETHUSDT": 0.5, "SOLUSDT": 0.5}, "rebalance_at": 1},
          open("strategies/dc/state.json", "w"))
check(v.round() == [("SOLUSDT", 300)], f"its first weights: only the SOL leg is bought, ETH never left ({v.calls})")

# ── a portfolio without a literal UNIVERSE: its last backtest preview's assets
fresh()
strat("eth", "ETHUSDT", state={"symbol": "ETHUSDT", "position": 1})
strat("pc", preview={"type": "portfolio", "weights": {"ETHUSDT": 0.5, "SOLUSDT": 0.5}})
v = swap({"eth": 300}, {"pc": 600}, {"ETHUSDT": 300})
check(v.round() == [] and audits("first_signal_wait")[-1]["keys"] == ["ETHUSDT", "SOLUSDT"],
      f"keys from the preview when the code has no literal UNIVERSE ({v.calls})")

# ── nothing tells its keys: nothing is held, said in the audit
fresh()
strat("eth", "ETHUSDT", state={"symbol": "ETHUSDT", "position": 1})
strat("pc")
v = swap({"eth": 300}, {"pc": 600}, {"ETHUSDT": 300})
check(v.round() == [("ETHUSDT", -300)] and len(audits("first_signal_wait_no_keys")) == 1,
      f"no SYMBOL / UNIVERSE / preview: the removed member's ETH closes as before, one audit line ({v.calls})")
check(v.round() == [] and len(audits("first_signal_wait_no_keys")) == 1, "and the audit line is not repeated every round")

# ── the window: past one bar the exit goes out, and it never waits again
fresh()
strat("btc", "BTCUSDT", state={"symbol": "BTCUSDT", "position": 1})
strat("db", "BTCUSDT")
v = swap({"btc": 500}, {"btc": 0, "db": 500}, {"BTCUSDT": 500})
v.round()
backdate("db", 3601)
check(v.round() == [("BTCUSDT", -500)], f"db never computed: past one 1h bar BTC closes as before — an exit is never parked ({v.calls})")
e = audits("first_signal_wait_expired")
check(len(e) == 1 and e[0]["strategy"] == "db", f"one audit line for the timeout ({e})")
config({"btc": 0, "db": 700})
v.held["BTCUSDT"] = 500
check(v.round() == [("BTCUSDT", -500)], f"a re-save does not restart the window ({v.calls})")
config({"btc": 500})
v.round()
config({"btc": 0, "db": 500})
v.held["BTCUSDT"] = 500
check(v.round() == [], f"taken out of amounts and added back: a new join waits again ({v.calls})")

for interval, age, held in (("5m", 200, True), ("5m", 301, False), ("1d", 7000, True), ("1d", 7201, False)):
    fresh()
    strat("btc", "BTCUSDT", state={"symbol": "BTCUSDT", "position": 1})
    strat("db", "BTCUSDT", interval=interval)
    v = swap({"btc": 500}, {"btc": 0, "db": 500}, {"BTCUSDT": 500})
    v.round()
    backdate("db", age)
    got = v.round()
    check((got == []) == held, f"{interval} member, {age}s in: {'held' if held else 'reconciled'} "
          f"(one bar, at most {portfolio.FIRST_SIGNAL_WAIT_MAX_S}s) ({got})")

# ── a waiting member only holds its own keys
fresh()
strat("btc", "BTCUSDT", state={"symbol": "BTCUSDT", "position": 1})
strat("eth", "ETHUSDT", state={"symbol": "ETHUSDT", "position": 1})
strat("db", "BTCUSDT")
v = swap({"btc": 500, "eth": 300}, {"btc": 0, "db": 500}, {"BTCUSDT": 500, "ETHUSDT": 300})
check(v.round() == [("ETHUSDT", -300)], f"removing eth while db waits on BTC: ETH still closes ({v.calls})")

# ── direction 2: only the difference the save made is frozen
def neighbours(c1_pos=1, c1_interval="1h", db_interval="1h", c1_after=200):
    fresh()
    strat("btc", "BTCUSDT", state={"symbol": "BTCUSDT", "position": 1})
    strat("c1", "BTCUSDT", interval=c1_interval, state={"symbol": "BTCUSDT", "position": c1_pos})
    strat("db", "BTCUSDT", interval=db_interval)
    return swap({"btc": 500, "c1": 200}, {"btc": 0, "c1": c1_after, "db": 500}, {"BTCUSDT": 500 + 200 * c1_pos})


v = neighbours()
check(v.round() == [], f"anchored: btc's 500 and c1's 200 stay ({v.calls})")
json.dump({"symbol": "BTCUSDT", "position": 0}, open("strategies/c1/state.json", "w"))
got = [v.round() for _ in range(3)]
check(got == [[("BTCUSDT", -200)], [], []] and v.held["BTCUSDT"] == 500,
      f"c1 stops out while db waits: its 200 is sold once, three rounds, btc's 500 stays ({got})")
# a neighbour's add inside the window is netted against the hold (the wait never buys where the
# same round without it would sell): it goes out when the window closes
json.dump({"symbol": "BTCUSDT", "position": 1}, open("strategies/c1/state.json", "w"))
check(v.round() == [] and v.held["BTCUSDT"] == 500,
      f"c1 back in while db waits: netted against btc's 500 held, no order ({v.calls})")
json.dump({"symbol": "BTCUSDT", "position": 1}, open("strategies/db/state.json", "w"))
check(v.round() == [("BTCUSDT", 200)] and v.held["BTCUSDT"] == 700,
      f"db's first signal takes btc's 500 over, c1's 200 goes out now ({v.calls})")

v = neighbours()
v.round()
json.dump({"symbol": "BTCUSDT", "position": 2}, open("strategies/c1/state.json", "w"))
check(v.round() == [] and v.round() == [], f"c1 scales up while db waits: netted against the hold ({v.calls})")
json.dump({"symbol": "BTCUSDT", "position": 1}, open("strategies/db/state.json", "w"))
check(v.round() == [("BTCUSDT", 200)] and v.held["BTCUSDT"] == 900, f"…bought once db has computed ({v.calls})")

v = neighbours(c1_after=400)
check(v.round() == [] and v.round() == [],
      f"c1 raised 200→400 in the same save as the swap: netted against btc's 500 held ({v.calls})")
json.dump({"symbol": "BTCUSDT", "position": 1}, open("strategies/db/state.json", "w"))
check(v.round() == [("BTCUSDT", 200)] and v.held["BTCUSDT"] == 900,
      f"db's first signal takes btc's 500 over, c1's raise goes out once ({v.calls})")
v = neighbours(c1_after=50)
check(v.round() == [("BTCUSDT", -150)], f"c1 cut 200→50 in the same save: its 150 is sold now, btc's 500 waits ({v.calls})")

v = neighbours()
json.dump({"symbol": "BTCUSDT", "position": 0}, open("strategies/c1/state.json", "w"))
got = [v.round() for _ in range(3)]
check(got == [[("BTCUSDT", -200)], [], []] and v.held["BTCUSDT"] == 500,
      f"c1 stops out after the save, before the first round: sold at once, btc's 500 stays ({got})")

# account-read mode: the book is qty × mark, so a mark move must not be frozen with the swap
class MarkVenue(Venue):
    def __init__(self, qty, mark):
        super().__init__({})
        self.qty, self.mark = dict(qty), mark

    def positions(self):
        return {k: {"side": "long" if q > 0 else "short", "size": abs(q) * self.mark, "exchange": "binance"}
                for k, q in self.qty.items() if q}

    def place(self, symbol, signed_diff, asset_spec, reduce_only=False):
        self.calls.append((symbol, round(signed_diff, 4)))
        self.qty[symbol] = self.qty.get(symbol, 0) + signed_diff / self.mark
        return {"executed_qty": abs(signed_diff) / self.mark, "avg_price": self.mark}


def marked(do_swap):
    fresh()
    strat("btc", "BTCUSDT", state={"symbol": "BTCUSDT", "position": 1})
    strat("c1", "BTCUSDT", state={"symbol": "BTCUSDT", "position": 1})
    strat("db", "BTCUSDT")
    config({"btc": 500, "c1": 200})
    v = MarkVenue({"BTCUSDT": 700}, 1.0)
    out = [v.round()]
    if do_swap:
        config({"btc": 0, "c1": 200, "db": 500})
    for i, mark in enumerate((1.045, 0.97, 0.97, 1.045)):
        v.mark = mark
        if do_swap and i == 3:
            json.dump({"symbol": "BTCUSDT", "position": 1}, open("strategies/db/state.json", "w"))
        out.append(v.round())
    return out


base, swapped = marked(False), marked(True)
check(swapped == base, f"self_ledger off, the mark moves 1.045 → 0.97 → 1.045 across the window: the swap sends "
                       f"exactly what no swap sends — no unrealised PnL frozen ({swapped} vs {base})")

v = neighbours(c1_interval="5m", db_interval="1d")
v.round()
backdate("db", 1800)
json.dump({"symbol": "BTCUSDT", "position": 0}, open("strategies/c1/state.json", "w"))
check(v.round() == [("BTCUSDT", -200)] and "db" in (json.load(open("manager/last_reconcile.json"))["target"]["BTCUSDT"].get("awaiting") or {}),
      f"a 1d newcomer beside a 5m neighbour: 30 min in the neighbour's exit is not parked, db still waits ({v.calls})")

v = neighbours()
v.round()
config({"btc": 0, "c1": 0, "db": 500})
check(v.round() == [] and v.held["BTCUSDT"] == 700,
      f"c1 taken to 0 inside the window: its close waits with btc's (what the save dialog says) ({v.calls})")
backdate("db", 3601)
check(v.round() == [("BTCUSDT", -700)], f"past the window both close ({v.calls})")

# a member that leaves inside the window and comes back trades its own signal again
v = neighbours()
v.round()
config({"btc": 0, "c1": 0, "db": 500})
v.round()
json.dump({"symbol": "BTCUSDT", "position": 0}, open("strategies/c1/state.json", "w"))
config({"btc": 0, "c1": 200, "db": 500})
check(v.round() == [("BTCUSDT", -200)] and v.held["BTCUSDT"] == 500,
      f"c1 out and back inside the window: no longer counted as left, its own 0 sells its 200 ({v.calls})")

# two newcomers on one key: the first to compute waits for the other — no 2× exposure meanwhile
def pair():
    fresh()
    strat("btc", "BTCUSDT", state={"symbol": "BTCUSDT", "position": 1})
    strat("d1", "BTCUSDT")
    strat("d2", "BTCUSDT")
    return swap({"btc": 500}, {"btc": 0, "d1": 500, "d2": 500}, {"BTCUSDT": 500})


v = pair()
check(v.round() == [], f"btc → d1 + d2: nothing moves ({v.calls})")
json.dump({"symbol": "BTCUSDT", "position": 1}, open("strategies/d1/state.json", "w"))
got = v.round()
check(got == [] and v.held["BTCUSDT"] == 500 and snap_row("BTCUSDT").get("cohort") == ["d1"],
      f"d1 long first: not bought on top of the frozen 500 while d2 waits ({got}, {snap_row('BTCUSDT')})")
json.dump({"symbol": "BTCUSDT", "position": 0}, open("strategies/d2/state.json", "w"))
check(v.round() == [] and v.held["BTCUSDT"] == 500, f"d2 flat: d1's 500 takes btc's over, no order at all ({v.calls})")
v = pair()
v.round()
json.dump({"symbol": "BTCUSDT", "position": 1}, open("strategies/d1/state.json", "w"))
v.round()
json.dump({"symbol": "BTCUSDT", "position": 1}, open("strategies/d2/state.json", "w"))
check(v.round() == [("BTCUSDT", 500)], f"both long: the second 500 is bought once both have computed ({v.calls})")
v = pair()
v.round()
json.dump({"symbol": "BTCUSDT", "position": 1}, open("strategies/d1/state.json", "w"))
v.round()
backdate("d2", 3601)
check(v.round() == [] and v.held["BTCUSDT"] == 500, f"d2 never computes: past its window d1 alone holds the 500 ({v.calls})")
v = pair()
json.dump({"symbol": "BTCUSDT", "position": 1}, open("strategies/d1/state.json", "w"))
check(v.round() == [] and v.held["BTCUSDT"] == 500,
      f"d1 computed before the first round saw it wait: still swapped with d2, nothing bought ({v.calls})")

# a Type C neighbour whose weights drop the key: its own exit, not a departure to freeze
fresh()
strat("btc", "BTCUSDT", state={"symbol": "BTCUSDT", "position": 1})
strat("pc", universe=["BTCUSDT", "ETHUSDT"],
      state={"symbol": None, "position": 0, "weights": {"BTCUSDT": 0.2, "ETHUSDT": 0.3}, "rebalance_at": 1})
strat("db", "BTCUSDT")
v = swap({"btc": 500, "pc": 1000}, {"btc": 0, "pc": 1000, "db": 500}, {"BTCUSDT": 700, "ETHUSDT": 300})
check(v.round() == [], f"btc → db beside a portfolio holding 200 of BTC: nothing moves ({v.calls})")
json.dump({"symbol": None, "position": 0, "weights": {"ETHUSDT": 0.3}, "rebalance_at": 2}, open("strategies/pc/state.json", "w"))
check(v.round() == [("BTCUSDT", -200)] and v.held["BTCUSDT"] == 500,
      f"pc's weights drop BTC (key gone, not 0): its 200 is sold now, btc's 500 waits ({v.calls})")

fresh()
strat("btc", "BTCUSDT", state={"symbol": "BTCUSDT", "position": 1})
strat("pc", universe=["BTCUSDT", "ETHUSDT"],
      state={"symbol": None, "position": 0, "weights": {"BTCUSDT": 0.2, "ETHUSDT": 0.3}, "rebalance_at": 1})
strat("db", "BTCUSDT")
v = swap({"btc": 500, "pc": 1000}, {"btc": 0, "pc": 1000, "db": 500}, {"BTCUSDT": 700, "ETHUSDT": 300})
json.dump({"symbol": None, "position": 0, "weights": {"ETHUSDT": 0.3}, "rebalance_at": 2}, open("strategies/pc/state.json", "w"))
check(v.round() == [("BTCUSDT", -200)], f"…the same between the save and the first round: not frozen either ({v.calls})")

# taken out and added back before any round: the runtime moved its state away, so it waits again —
# its own last share is what is frozen
fresh()
strat("btc", "BTCUSDT", state={"symbol": "BTCUSDT", "position": 1})
v = swap({"btc": 500}, {"btc": 500}, {"BTCUSDT": 500})
os.rename("strategies/btc/state.json", "strategies/btc/state.json.prejoin")
check(v.round() == [] and v.held["BTCUSDT"] == 500, f"btc out and back in one go (state moved away): its 500 stays ({v.calls})")

# the anchor lost inside the window (record unreadable): re-anchored on the snapshot's window row
fresh()
strat("btc", "BTCUSDT", state={"symbol": "BTCUSDT", "position": 1})
strat("db", "BTCUSDT")
v = swap({"btc": 500}, {"btc": 0, "db": 500}, {"BTCUSDT": 500})
v.round()
b = book()
b["anchors"] = {}
json.dump(b, open("state/first_signal_wait.json", "w"))
check(v.round() == [] and v.held["BTCUSDT"] == 500, f"anchor gone mid-window: btc's 500 still frozen ({v.calls})")

# a member that was waiting for a new signal (resume_wait) held nothing of its own: nothing to freeze
fresh()
strat("btc", "BTCUSDT", state={"symbol": "BTCUSDT", "position": 1})
strat("db", "BTCUSDT")
json.dump({"btc": 1}, open("state/signal_gate.json", "w"))
v = swap({"btc": 500}, {"btc": 0, "db": 500}, {})
check(v.round() == [] and not v.held.get("BTCUSDT"), f"a gated btc swapped for db: nothing bought for the leaving one ({v.calls})")

# a member routed again in the same save (it held its key as is while unrouted) is no newcomer
fresh()
strat("btc", "BTCUSDT", state={"symbol": "BTCUSDT", "position": 1})
strat("x", "BTCUSDT", state={"symbol": "BTCUSDT", "position": 1})
strat("db", "BTCUSDT")
json.dump({"self_ledger": False, "amounts": {"btc": 500, "x": 200}, "exchanges": {"btc": "binance", "x": ""},
           "asset_specs": {}}, open("manager/portfolio_config.json", "w"))
v = Venue({"BTCUSDT": 700})
check(v.round() == [] and "x" in (snap_row("BTCUSDT").get("unrouted") or []), f"x unrouted: BTC held as is ({v.calls})")
config({"btc": 0, "x": 200, "db": 500})
check(v.round() == [] and v.held["BTCUSDT"] == 700, f"x routed again as btc → db: x's 200 is not sold as a newcomer's ({v.calls})")

# another gate on the key wins: a signal-gated neighbour holds the whole key as is
fresh()
strat("btc", "BTCUSDT", state={"symbol": "BTCUSDT", "position": 1})
strat("c1", "BTCUSDT", state={"symbol": "BTCUSDT", "position": 1})
strat("db", "BTCUSDT")
v = swap({"btc": 500, "c1": 200}, {"btc": 0, "c1": 200, "db": 500}, {"BTCUSDT": 700})
json.dump({"c1": 1}, open("state/signal_gate.json", "w"))
got, row = v.round(), snap_row("BTCUSDT")
check(got == [] and row.get("gated") is True and row.get("frozen") == 500 and set(row.get("awaiting") or {}) == {"db"},
      f"c1 waits for a new signal: the key stays gated, no window target over it — anchored all the same ({got}, {row})")

# spot never goes short: the others' short intent plus frozen is clamped at 0
fresh()
strat("sp", "BTCUSDT", market="spot", state={"symbol": "BTCUSDT", "position": 1})
strat("c1", "BTCUSDT", market="spot", state={"symbol": "BTCUSDT", "position": 0})
strat("db", "BTCUSDT", market="spot")
v = swap({"sp": 500, "c1": 600}, {"sp": 0, "c1": 600, "db": 500}, {"BTCUSDT@spot": 500})
json.dump({"symbol": "BTCUSDT", "position": -1}, open("strategies/c1/state.json", "w"))
got, row = v.round(), snap_row("BTCUSDT@spot")
check(row.get("side") is None and row.get("size") == 0 and got == [("BTCUSDT@spot", -500)],
      f"spot: c1 -600 + frozen 500 = -100 is a 0 target, only what is held is sold ({got}, {row})")

# lots stay whole: a half lot from a neighbour plus the frozen lots rounds half-up
fresh()
lot = {"type": "futures_contracts", "contract_value": 1, "currency": "USDT", "lot_size": 1, "margin": 1}
strat("btc", "BTCUSDT", state={"symbol": "BTCUSDT", "position": 1})
strat("c1", "BTCUSDT", state={"symbol": "BTCUSDT", "position": 1})
strat("db", "BTCUSDT")
v = swap({"btc": 2, "c1": 1}, {"btc": 0, "c1": 1, "db": 2}, {"BTCUSDT": 3},
         specs={"btc": lot, "c1": lot, "db": lot})
json.dump({"symbol": "BTCUSDT", "position": 0.5}, open("strategies/c1/state.json", "w"))
got, row = v.round(), snap_row("BTCUSDT")
check(row.get("size") == 3 and got == [], f"lots: 0.5 + frozen 2 = 2.5 → 3 lots, no half-lot order ({got}, {row})")

# an untrusted book or a pending key: held as is on both sides, nothing anchored
fresh()
json.dump({"target": {"BTCUSDT": {"side": "long", "size": 500, "contributors": [
    {"strategy": "btc", "position": 1, "amount": 500, "contribution": 500}]}}}, open("manager/last_reconcile.json", "w"))
waiting = lambda: {"BTCUSDT": {"side": None, "size": 0.0, "exchange": "binance", "asset_spec": None, "market": "swap",
                               "contributors": [], "gated": True, "first_signal_hold": True,
                               "awaiting": {"db": round(time.time()) + 3000}}}
for label, kw in (("the book cannot be trusted (baseline wait)", {"trusted": False}),
                  ("the key waits on a pending baseline", {"trusted": True, "skip": {"BTCUSDT"}})):
    out = portfolio._first_signal_targets(waiting(), funded={"db"}, **kw)["BTCUSDT"]
    check(out.get("gated") is True and "frozen" not in out and "first_signal_hold" not in out
          and not portfolio._first_signal_book()["anchors"],
          f"{label}: the key stays held as is, no anchor written ({out})")
out = portfolio._first_signal_targets(waiting(), trusted=True, funded={"db"},
                                     book={"BTCUSDT": {"side": "long", "size": 500}})["BTCUSDT"]
check(out.get("gated") is False and out.get("frozen") == 500 and portfolio._first_signal_book()["anchors"].get("BTCUSDT"),
      f"…and once it can be trusted, btc's 500 from the snapshot is the anchor ({out})")

# a TW portfolio with a large literal UNIVERSE: only the difference is frozen, neighbours trade
fresh()
codes = [str(1100 + i) for i in range(150)]
strat("old", "2454", state={"symbol": "2454", "position": 1})
strat("n1", "2330", state={"symbol": "2330", "position": 1})
strat("n2", "2317", state={"symbol": "2317", "position": 1})
strat("tw", universe=codes + ["2330", "2317", "2454"])
v = swap({"old": 300, "n1": 100, "n2": 100}, {"old": 0, "n1": 100, "n2": 100, "tw": 3000},
         {"2454": 300, "2330": 100, "2317": 100})
check(v.round() == [], f"tw joins with 153 keys, old leaves 2454: nothing moves ({v.calls})")
json.dump({"symbol": "2330", "position": 0}, open("strategies/n1/state.json", "w"))
json.dump({"symbol": "2317", "position": 2}, open("strategies/n2/state.json", "w"))
got = sorted(v.round())
check(got == [("2317", 100), ("2330", -100)] and v.held["2454"] == 300,
      f"inside its window n1's exit and n2's add go out, old's 2454 waits ({got})")

# ── a non-UTF-8 strategy.py never takes the round down
fresh()
strat("eth", "ETHUSDT", state={"symbol": "ETHUSDT", "position": 1})
strat("old", "BTCUSDT", state={"symbol": "BTCUSDT", "position": 1})
os.makedirs("strategies/bad", exist_ok=True)
open("strategies/bad/strategy.py", "wb").write('# 換成新版\nSYMBOL = "BTCUSDT"\nINTERVAL = "1h"\n'.encode("big5"))
v = swap({"eth": 300, "old": 500}, {"bad": 500}, {"ETHUSDT": 300, "BTCUSDT": 500})
check(v.round() == [("ETHUSDT", -300)] and v.held["BTCUSDT"] == 500,
      f"a Big5 strategy.py: its SYMBOL still read, BTC held, eth's removal closes ETH ({v.calls})")
open("strategies/bad/strategy.py", "wb").write('# -*- coding: big5 -*-\n# 現貨\nMARKET = "spot"\nSYMBOL = "BTCUSDT"\n'.encode("big5"))
check(portfolio.strategy_market("bad") == "spot", "a Big5 file with its coding line: MARKET read as Python reads it")

fresh()
strat("eth", "ETHUSDT", state={"symbol": "ETHUSDT", "position": 1})
strat("db", "BTCUSDT")
config({"db": 500})
real_keys = portfolio._first_signal_keys
portfolio._first_signal_keys = lambda name: (_ for _ in ()).throw(RuntimeError("boom"))
v = Venue({"ETHUSDT": 300, "BTCUSDT": 500})
got = sorted(v.round())
v.held.update({"ETHUSDT": 300, "BTCUSDT": 500})
v.round()
portfolio._first_signal_keys = real_keys
check(got == [("BTCUSDT", -500), ("ETHUSDT", -300)] and len(audits("first_signal_wait_error")) == 1,
      f"a bug in the wait helper: nothing held, the round trades, one audit line over two rounds ({got})")

fresh()
strat("btc", "BTCUSDT", state={"symbol": "BTCUSDT", "position": 1})
strat("db", "BTCUSDT")
config({"btc": 0, "db": 500})
real_targets = portfolio._first_signal_targets
portfolio._first_signal_targets = lambda *a, **k: (_ for _ in ()).throw(RuntimeError("boom"))
v = Venue({"BTCUSDT": 500})
got = v.round()
portfolio._first_signal_targets = real_targets
check(got == [("BTCUSDT", -500)], f"a bug in the window target: the key reconciles as if nobody waited ({got})")


# ── the window's start: a failed write, a clock set back, NaN — never longer than one window
class Clock:
    def __init__(self):
        self.t = time.time()

    def time(self):
        return self.t

    def __getattr__(self, name):
        return getattr(time, name)


def clocked(prep=None, fail_write=False):
    fresh()
    strat("btc", "BTCUSDT", state={"symbol": "BTCUSDT", "position": 1})
    strat("db", "BTCUSDT")
    v = swap({"btc": 500}, {"btc": 0, "db": 500}, {"BTCUSDT": 500})
    if prep:
        prep()
    clock, real_replace = Clock(), portfolio.atomic_replace
    portfolio.time = clock
    if fail_write:
        def boom(src, dst):
            if dst.endswith("first_signal_wait.json"):
                raise OSError(28, "No space left on device")
            return real_replace(src, dst)
        portfolio.atomic_replace = boom
    seen = []
    try:
        for step in (0, 1800, 1801, 3600):
            clock.t += step
            seen.append(v.round())
    finally:
        portfolio.time, portfolio.atomic_replace = time, real_replace
        portfolio._first_signal_unsaved = None
    return seen


got = clocked(fail_write=True)
check(got == [[], [], [("BTCUSDT", -500)], []] and len(audits("first_signal_wait")) == 1,
      f"the record cannot be written: the window still ends one bar after it started, once ({got})")
got = clocked(lambda: json.dump({"members": {"db": {"since": time.time() + 3 * 86400}}},
                                open("state/first_signal_wait.json", "w")))
check(got == [[], [], [("BTCUSDT", -500)], []], f"a start in the future (clock set back): counted from now ({got})")
got = clocked(lambda: open("state/first_signal_wait.json", "w").write(
    '{"members": {"db": {"since": NaN}}, "anchors": {"BTCUSDT": {"frozen": NaN, "seen": {}, "departed": {}}}}'))
check(got == [[], [], [("BTCUSDT", -500)], []], f"NaN in the file: no exception, counted from now ({got})")

# ── UNIVERSE: comments are not code (the shell's trUniverse reads the same fixture)
fix = json.load(open(os.path.join(ROOT, "tests", "fixtures", "universe_comments.json")))
fresh()
os.makedirs("strategies/dc", exist_ok=True)
open("strategies/dc/strategy.py", "w").write(fix["code"])
config({"dc": 600})
v = Venue({})
v.round()
check(audits("first_signal_wait")[-1]["keys"] == sorted(fix["universe"]),
      f"a symbol or a ] in a comment neither adds nor cuts ({audits('first_signal_wait')[-1]['keys']})")

# ── a signal-gated contributor is flagged in the snapshot (the save dialog reads it)
fresh()
strat("g", "BTCUSDT", state={"symbol": "BTCUSDT", "position": 1})
strat("h", "BTCUSDT", state={"symbol": "BTCUSDT", "position": 1})
config({"g": 300, "h": 200})
json.dump({"g": 1}, open("state/signal_gate.json", "w"))
v = Venue({})
v.round()
cs = {c["strategy"]: c for c in json.load(open("manager/last_reconcile.json"))["target"]["BTCUSDT"]["contributors"]}
check(cs["g"].get("gated") is True and "gated" not in cs["h"], f"the gated contributor carries gated: true, the other none ({cs})")

# ── HALT: the wait never opens anything
fresh()
strat("btc", "BTCUSDT", state={"symbol": "BTCUSDT", "position": 1})
strat("db", "BTCUSDT")
v = swap({"btc": 500}, {"btc": 0, "db": 500}, {"BTCUSDT": 500})
open(guard.HALT_PATH, "w").write("test")
check(v.round() == [], f"halted, inside the window: nothing ({v.calls})")
backdate("db", 3601)
got = v.round()
if "halt_freeze" in portfolio.RECONCILE_CAPS:
    check(got == [], f"halted, past the window: still nothing — HALT freezes every order ({got})")
v.held["BTCUSDT"] = 0
json.dump({"symbol": "BTCUSDT", "position": 1}, open("strategies/db/state.json", "w"))
check(v.round() == [] and v.held.get("BTCUSDT", 0) == 0, f"halted: db's first signal opens nothing ({v.calls})")
os.remove(guard.HALT_PATH)

# ── what is held is what the book has: a leaver's target that never reached it is nothing to keep
def three(btc_pos=0):
    fresh()
    strat("btc", "BTCUSDT", state={"symbol": "BTCUSDT", "position": btc_pos})
    strat("c1", "BTCUSDT", state={"symbol": "BTCUSDT", "position": 1})
    strat("db", "BTCUSDT")
    config({"btc": 500, "c1": 200})
    return Venue({"BTCUSDT": 200 + 500 * btc_pos})


v = three()
v.round()
open(guard.HALT_PATH, "w").write("test")
json.dump({"symbol": "BTCUSDT", "position": 1}, open("strategies/btc/state.json", "w"))
check(v.round() == [], f"E1 setup: btc turns long under HALT, the entry is denied ({v.calls})")
config({"btc": 0, "c1": 200, "db": 500})
v.round()
os.remove(guard.HALT_PATH)
got = [v.round(), v.round()]
row = snap_row("BTCUSDT")
check(got == [[], []] and v.held["BTCUSDT"] == 200 and row.get("frozen") == 0,
      f"E1 btc's long never reached the book, then btc → db: nothing bought for it, after HALT either ({got}, {row.get('frozen')})")
json.dump({"symbol": "BTCUSDT", "position": 0}, open("strategies/db/state.json", "w"))
check(v.round() == [] and v.held["BTCUSDT"] == 200, f"E1 db flat: c1's 200 stays, nothing to sell back ({v.calls})")


class Rejecting(Venue):
    reject = False

    def place(self, symbol, signed_diff, asset_spec, reduce_only=False):
        if self.reject:
            raise RuntimeError("insufficient margin")
        return Venue.place(self, symbol, signed_diff, asset_spec, reduce_only)


v = three()
v.__class__ = Rejecting
v.round()
json.dump({"symbol": "BTCUSDT", "position": 1}, open("strategies/btc/state.json", "w"))
v.reject = True
v.round()
v.reject = False
check(v.held["BTCUSDT"] == 200, f"E1 setup: btc's entry is rejected ({v.held})")
config({"btc": 0, "c1": 200, "db": 500})
check(v.round() == [] and snap_row("BTCUSDT").get("frozen") == 0,
      f"E1 btc's long was rejected, then btc → db: nothing bought for it ({v.calls})")

v = three(btc_pos=1)
v.round()
v.held["BTCUSDT"] = 200
config({"btc": 0, "c1": 200, "db": 500})
check(v.round() == [] and v.held["BTCUSDT"] == 200,
      f"E1 btc's 500 closed by hand before the save: nothing bought back for it ({v.calls})")

v = three(btc_pos=1)
v.round()
v.held["BTCUSDT"] = 450
config({"btc": 0, "c1": 200, "db": 500})
check(v.round() == [] and snap_row("BTCUSDT").get("frozen") == 250,
      f"E1 part of it closed by hand: only the 250 still there is held ({v.calls}, {snap_row('BTCUSDT').get('frozen')})")

# the snapshot's own read is from before that round's orders: a save right after an entry holds it
fresh()
strat("btc", "BTCUSDT", state={"symbol": "BTCUSDT", "position": 1})
strat("db", "BTCUSDT")
config({"btc": 500})
v = Venue({})
check(v.round() == [("BTCUSDT", 500)], f"btc enters ({v.calls})")
config({"btc": 0, "db": 500})
check(v.round() == [] and v.held["BTCUSDT"] == 500,
      f"saved right after the entry round: btc's 500 is held, not sold ({v.calls})")

# E2: a signal-gated leaver holds what the book has beyond the others' share
fresh()
strat("btc", "BTCUSDT", state={"symbol": "BTCUSDT", "position": 1})
strat("c1", "BTCUSDT", state={"symbol": "BTCUSDT", "position": 1})
strat("db", "BTCUSDT")
json.dump({"btc": 1}, open("state/signal_gate.json", "w"))
v = swap({"btc": 500, "c1": 200}, {"btc": 0, "c1": 200, "db": 500}, {"BTCUSDT": 700})
got = v.round()
check(got == [] and snap_row("BTCUSDT").get("frozen") == 500,
      f"E2 a signal-gated btc swapped for db: its 500 on the book is held, not sold ({got}, {snap_row('BTCUSDT').get('frozen')})")
json.dump({"symbol": "BTCUSDT", "position": 1}, open("strategies/db/state.json", "w"))
check(v.round() == [] and v.held["BTCUSDT"] == 700, f"E2 db long: no buy-back ({v.calls})")

# E3: another gate holds the key in the first round after the save — the anchor is taken all the same
for label, block, lift in (
        ("c1 signal-gated", lambda: json.dump({"c1": 1}, open("state/signal_gate.json", "w")),
         lambda: os.remove("state/signal_gate.json")),
        ("c1 unrouted", lambda: json.dump({"self_ledger": False, "amounts": {"btc": 0, "c1": 200, "db": 500},
                                           "exchanges": {"btc": "binance", "db": "binance"}, "asset_specs": {}},
                                          open("manager/portfolio_config.json", "w")),
         lambda: config({"btc": 0, "c1": 200, "db": 500}))):
    fresh()
    strat("btc", "BTCUSDT", state={"symbol": "BTCUSDT", "position": 1})
    strat("c1", "BTCUSDT", state={"symbol": "BTCUSDT", "position": 1})
    strat("db", "BTCUSDT")
    v = swap({"btc": 500, "c1": 200}, {"btc": 0, "c1": 200, "db": 500}, {"BTCUSDT": 700})
    block()
    got = [v.round(), v.round()]
    lift()
    got.append(v.round())
    check(got == [[], [], []] and snap_row("BTCUSDT").get("frozen") == 500,
          f"E3 {label} for two rounds after the save, then free: btc's 500 still held ({got})")
    json.dump({"symbol": "BTCUSDT", "position": 1}, open("strategies/db/state.json", "w"))
    check(v.round() == [] and v.held["BTCUSDT"] == 700, f"E3 {label}: db long, no buy-back ({v.calls})")

# Q5: a neighbour whose state vanishes inside the window is not a newcomer when it comes back
fresh()
strat("btc", "BTCUSDT", state={"symbol": "BTCUSDT", "position": 1})
strat("c1", "BTCUSDT", state={"symbol": "BTCUSDT", "position": 1})
strat("db", "BTCUSDT")
v = swap({"btc": 500, "c1": 200}, {"btc": 0, "c1": 200, "db": 500}, {"BTCUSDT": 700})
v.round()
os.remove("strategies/c1/state.json")
check(v.round() == [] and snap_row("BTCUSDT").get("frozen") == 700,
      f"Q5 c1's state vanishes: its 200 is held with btc's ({v.calls})")
json.dump({"symbol": "BTCUSDT", "position": 0}, open("strategies/c1/state.json", "w"))
row = snap_row("BTCUSDT")
check(v.round() == [("BTCUSDT", -200)] and "c1" not in (snap_row("BTCUSDT").get("cohort") or []),
      f"Q5 c1 back with a stop: sold that round, not parked with the newcomers ({v.calls})")

# no snapshot to anchor on: the leaver's part is not kept, a neighbour's is never sold as a newcomer's
fresh()
strat("btc", "BTCUSDT", state={"symbol": "BTCUSDT", "position": 1})
strat("c1", "BTCUSDT", state={"symbol": "BTCUSDT", "position": 1})
strat("db", "BTCUSDT")
config({"btc": 0, "c1": 200, "db": 500})
v = Venue({"BTCUSDT": 700})
check(v.round() == [("BTCUSDT", -500)] and v.held["BTCUSDT"] == 200,
      f"no snapshot: btc's 500 is sold as before, c1's 200 stays ({v.calls})")

# a newcomer past its window that computes later, inside another member's window, is a member
fresh()
strat("btc", "BTCUSDT", state={"symbol": "BTCUSDT", "position": 1})
strat("c1", "BTCUSDT", state={"symbol": "BTCUSDT", "position": 1})
strat("db", "BTCUSDT")
v = swap({"btc": 500, "c1": 200}, {"btc": 0, "c1": 200, "db": 500}, {"BTCUSDT": 700})
v.round()
backdate("db", 3601)
check(v.round() == [("BTCUSDT", -500)], f"db never computed: btc's 500 sold past its window ({v.calls})")
os.remove("strategies/c1/state.json")
v.round()
json.dump({"symbol": "BTCUSDT", "position": 1}, open("strategies/db/state.json", "w"))
check(v.round() == [("BTCUSDT", 300)] and "db" not in (snap_row("BTCUSDT").get("cohort") or []),
      f"db computes late while c1 waits: a member, its entry buys what the round without the wait would ({v.calls})")

# the anchor lost while one of two newcomers has computed: it stays out until the other has
fresh()
strat("btc", "BTCUSDT", state={"symbol": "BTCUSDT", "position": 1})
strat("d1", "BTCUSDT")
strat("d2", "BTCUSDT")
v = swap({"btc": 500}, {"btc": 0, "d1": 500, "d2": 500}, {"BTCUSDT": 500})
v.round()
json.dump({"symbol": "BTCUSDT", "position": -1}, open("strategies/d1/state.json", "w"))
v.round()
b = book()
b["anchors"] = {}
json.dump(b, open("state/first_signal_wait.json", "w"))
got = v.round()
check(got == [] and v.held["BTCUSDT"] == 500 and portfolio._first_signal_book()["anchors"]["BTCUSDT"]["cohort"] == ["d1", "d2"],
      f"anchor lost after d1 computed short: d1 stays in the cohort, btc's 500 held ({got})")

# a neighbour whose state is gone already in the first round after the save: no newcomer either
fresh()
strat("btc", "BTCUSDT", state={"symbol": "BTCUSDT", "position": 1})
strat("c1", "BTCUSDT", state={"symbol": "BTCUSDT", "position": 1})
strat("db", "BTCUSDT")
v = swap({"btc": 500, "c1": 200}, {"btc": 0, "c1": 200, "db": 500}, {"BTCUSDT": 700})
os.remove("strategies/c1/state.json")
check(v.round() == [] and snap_row("BTCUSDT").get("frozen") == 700, f"c1's state gone at the save: its 200 held with btc's ({v.calls})")
json.dump({"symbol": "BTCUSDT", "position": 0}, open("strategies/c1/state.json", "w"))
check(v.round() == [("BTCUSDT", -200)] and "c1" not in (snap_row("BTCUSDT").get("cohort") or []),
      f"…c1 back with a stop: sold that round ({v.calls})")

# a member leaving inside the window holds only what the book still has of it
fresh()
strat("btc", "BTCUSDT", state={"symbol": "BTCUSDT", "position": 1})
strat("c1", "BTCUSDT", state={"symbol": "BTCUSDT", "position": 1})
strat("n2", "BTCUSDT", state={"symbol": "BTCUSDT", "position": 1})
strat("db", "BTCUSDT")
v = swap({"btc": 500, "c1": 200, "n2": 300}, {"btc": 0, "c1": 200, "n2": 300, "db": 500}, {"BTCUSDT": 1000})
v.round()
v.held["BTCUSDT"] = 800  # c1's 200 closed by hand
config({"btc": 0, "n2": 300, "db": 500})
check(v.round() == [], f"c1 closed by hand, then taken out inside the window: nothing ({v.calls})")
json.dump({"symbol": "BTCUSDT", "position": 0}, open("strategies/n2/state.json", "w"))
check(v.round() == [("BTCUSDT", -300)] and v.held["BTCUSDT"] == 500,
      f"…n2 stops: its 300 is sold, nothing kept for c1's 200 that is no longer there ({v.calls})")

# G2 account-read mode: the hold shrinks with the book, so a neighbour's stop after a hand close /
# a mark drop sends what the same history without the wait sends (f81ca0b: -300 both times)
def g2(venue):
    fresh()
    strat("n1", "BTCUSDT", state={"symbol": "BTCUSDT", "position": 1})
    strat("l1", "BTCUSDT", state={"symbol": "BTCUSDT", "position": 1})
    strat("d1", "BTCUSDT")
    config({"n1": 300, "l1": 500})
    v = venue
    v.round()
    config({"n1": 300, "d1": 500})
    check(v.round() == [], f"G2 setup: l1 → d1, BTC 800 held ({v.calls})")
    return v


v = g2(Rejecting({"BTCUSDT": 800}))
v.held["BTCUSDT"] = 400
check(v.round() == [] and snap_row("BTCUSDT").get("frozen") == 100,
      f"G2 half closed by hand: the hold shrinks to the 100 left beyond n1's 300 ({v.calls}, {snap_row('BTCUSDT').get('frozen')})")
json.dump({"symbol": "BTCUSDT", "position": 0}, open("strategies/n1/state.json", "w"))
v.reject = True
v.round()
v.reject = False
got = [v.round(), v.round()]
check(got == [[("BTCUSDT", -300)], []] and v.held["BTCUSDT"] == 100,
      f"G2 …n1 stops (first order rejected): its 300 is sold the next round, once; the 100 stays ({got})")

v = g2(MarkVenue({"BTCUSDT": 800}, 1.0))
v.mark = 0.8
check(v.round() == [], f"G2 mark −20%: nothing ({v.calls})")
json.dump({"symbol": "BTCUSDT", "position": 0}, open("strategies/n1/state.json", "w"))
check(v.round() == [("BTCUSDT", -300)], f"G2 …n1 stops: its 300 is sold, not absorbed by the old 500 ({v.calls})")

# G3 a newcomer routed to another exchange holds nothing: the old position closes as f81ca0b does
class TwoVenues(Venue):
    def place(self, symbol, signed_diff, asset_spec, reduce_only=False, exchange=None):
        if exchange == "okx":
            self.calls.append((symbol, round(signed_diff, 4), "okx"))
            return False
        return Venue.place(self, symbol, signed_diff, asset_spec, reduce_only)


fresh()
strat("l1", "BTCUSDT", state={"symbol": "BTCUSDT", "position": 1})
strat("d1", "BTCUSDT")
config({"l1": 500})
v = TwoVenues({"BTCUSDT": 500})
v.round()
json.dump({"self_ledger": False, "amounts": {"d1": 500}, "exchanges": {"d1": "okx"}, "asset_specs": {}},
          open("manager/portfolio_config.json", "w"))
got = v.round()
row = snap_row("BTCUSDT")
check(got == [("BTCUSDT", -500)] and v.held["BTCUSDT"] == 0 and not row.get("awaiting"),
      f"G3 binance l1 → okx d1: the save round closes the binance 500, nothing held ({got}, {row})")

fresh()
strat("c1", "BTCUSDT", state={"symbol": "BTCUSDT", "position": 1})
strat("l1", "BTCUSDT", state={"symbol": "BTCUSDT", "position": 1})
strat("d1", "BTCUSDT")
config({"c1": 200, "l1": 500})
v = TwoVenues({"BTCUSDT": 700})
v.round()
json.dump({"self_ledger": False, "amounts": {"c1": 200, "d1": 500}, "exchanges": {"c1": "binance", "d1": "okx"},
           "asset_specs": {}}, open("manager/portfolio_config.json", "w"))
got = v.round()
check(got == [("BTCUSDT", -500)] and v.held["BTCUSDT"] == 200,
      f"G3 with a binance neighbour: l1's 500 closes, c1's 200 stays ({got})")


# G5 HALT + an open TXF → MXF rollover + a newcomer waiting on the old TXF key: not one lot sold
class Lots(Venue):
    def positions(self):
        return {k: {"side": "long" if q > 0 else "short", "size": abs(q), "unit": "contracts", "exchange": "paper"}
                for k, q in self.held.items() if q}


fresh()
TXF = {"type": "futures_contracts", "contract_value": 200, "currency": "TWD", "lot_size": 1}
MXF = {"type": "futures_contracts", "contract_value": 50, "currency": "TWD", "lot_size": 1}
strat("r", "TXF", state={"symbol": "TXF", "position": 1})
strat("l1", "TXF", state={"symbol": "TXF", "position": 1})
strat("d1", "TXF")
ex = {n: "paper" for n in ("r", "l1", "d1")}
json.dump({"self_ledger": False, "amounts": {"r": 1, "l1": 1}, "exchanges": ex, "asset_specs": {"r": TXF, "l1": TXF}},
          open("manager/portfolio_config.json", "w"))
v = Lots({})
got = [v.round(), v.round()]
check(got == [[("TXF", 2.0)], []], f"G5 setup: r and l1 hold 2 TXF ({got})")
open(guard.HALT_PATH, "w").write("test")
json.dump({"r": {"from": "TXF", "to": "MXF", "at": time.time()}}, open("state/contract_rollover.json", "w"))
json.dump({"self_ledger": False, "amounts": {"r": 4, "d1": 1}, "exchanges": ex, "contracts": {"r": "MXF"},
           "asset_specs": {"r": MXF, "d1": TXF}}, open("manager/portfolio_config.json", "w"))
got = [v.round(), v.round()]
check(got == [[], []] and v.held == {"TXF": 2.0},
      f"G5 halted, r rolling TXF → MXF, l1 → d1 waiting on TXF: not one lot sold ({got}, {v.held})")
os.remove(guard.HALT_PATH)

# paper-routed TW stocks are held as cash shares whatever MARKET says (_paper_tw_market): a
# newcomer known only by its UNIVERSE / preview waits on the same SYM@spot key the book holds
fresh()
strat("tw1", symbol="2330", market="swap", state={"symbol": "2330", "position": 1.0})
strat("pc", universe=["2330"], market="swap")
strat("pv", market="swap", preview={"symbol": "2317", "position": 1.0})
json.dump({"self_ledger": False, "amounts": {"pc": 100000, "pv": 100000},
           "exchanges": {"pc": "paper", "pv": "paper"}, "asset_specs": {}},
          open("manager/portfolio_config.json", "w"))
got = [portfolio._first_signal_keys("pc"), portfolio._first_signal_keys("pv")]
check(got == [["2330@spot"], ["2317@spot"]], f"paper TW newcomer keys are @spot, as aggregate_portfolio keys them ({got})")

print(f"\n{fails} FAILED" if fails else "\nall ok")
sys.exit(1 if fails else 0)
