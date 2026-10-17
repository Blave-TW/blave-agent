"""A funded member with no state.json yet (just joined, its old one moved away by the runtime's
_retire_prejoin_signals, or never computed) leaves what it replaces on the book until it writes its
first state — at most one bar of its INTERVAL, never longer than FIRST_SIGNAL_WAIT_MAX_S. Each key it
trades is anchored at the first round that sees it waiting; inside the window the key's target is the
others' target now + that frozen part, so only the leaving member's close and the newcomer's entry
wait — a neighbour's own signal (a stop included) or amount still trades. Swapping a strategy for a
new version on the same coin used to close the position one round and buy it back the next.

Through the real aggregate_portfolio → reconcile with a fake venue:
  single → single switch, single → portfolio (UNIVERSE), portfolio keys from the backtest preview,
  no keys at all → not held (audit), the window (bar / cap / re-save does not restart it / leaving
  amounts clears it), past the window the exit goes out and the wait never restarts, an unrelated
  key still trades; a neighbour's stop and add go out once, a 5m neighbour beside a 1d newcomer, a
  member leaving mid-window waits too, a 150-stock UNIVERSE only freezes the difference; a
  non-UTF-8 strategy.py, a bug in the helper, a write that fails, a clock set back, NaN in the file;
  UNIVERSE comments (tests/fixtures/universe_comments.json, the shell reads the same); the gated
  contributor flag; HALT.

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


def strat(name, symbol=None, interval="1h", universe=None, state=None, preview=None):
    d = f"strategies/{name}"
    os.makedirs(d, exist_ok=True)
    src = (f'SYMBOL = "{symbol}"\n' if symbol else "") + f'INTERVAL = "{interval}"\n'
    if universe:
        src += "UNIVERSE = [" + ", ".join(f'"{u}"' for u in universe) + "]\n"
    open(f"{d}/strategy.py", "w").write(src)
    if state is not None:
        json.dump(state, open(f"{d}/state.json", "w"))
    if preview is not None:
        json.dump(preview, open(f"{d}/backtest_state.json", "w"))


def config(amounts):
    json.dump({"self_ledger": False, "amounts": amounts, "exchanges": {n: "binance" for n in amounts}, "asset_specs": {}},
              open("manager/portfolio_config.json", "w"))


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


# ── single → single: btc to 0, its new version db joins on BTC
fresh()
strat("btc", "BTCUSDT", state={"symbol": "BTCUSDT", "position": 1})
strat("db", "BTCUSDT")
config({"btc": 0, "db": 500})
v = Venue({"BTCUSDT": 500})
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
config({"btc": 500, "dc": 600})
v = Venue({"BTCUSDT": 500, "ETHUSDT": 300})
check(v.round() == [] and v.held["ETHUSDT"] == 300, f"switch to a portfolio: ETH is held through its UNIVERSE ({v.calls})")
json.dump({"symbol": None, "position": 0, "weights": {"ETHUSDT": 0.5, "SOLUSDT": 0.5}, "rebalance_at": 1},
          open("strategies/dc/state.json", "w"))
check(v.round() == [("SOLUSDT", 300)], f"its first weights: only the SOL leg is bought, ETH never left ({v.calls})")

# ── a portfolio without a literal UNIVERSE: its last backtest preview's assets
fresh()
strat("eth", "ETHUSDT", state={"symbol": "ETHUSDT", "position": 1})
strat("pc", preview={"type": "portfolio", "weights": {"ETHUSDT": 0.5, "SOLUSDT": 0.5}})
config({"pc": 600})
v = Venue({"ETHUSDT": 300})
check(v.round() == [] and audits("first_signal_wait")[-1]["keys"] == ["ETHUSDT", "SOLUSDT"],
      f"keys from the preview when the code has no literal UNIVERSE ({v.calls})")

# ── nothing tells its keys: nothing is held, said in the audit
fresh()
strat("eth", "ETHUSDT", state={"symbol": "ETHUSDT", "position": 1})
strat("pc")
config({"pc": 600})
v = Venue({"ETHUSDT": 300})
check(v.round() == [("ETHUSDT", -300)] and len(audits("first_signal_wait_no_keys")) == 1,
      f"no SYMBOL / UNIVERSE / preview: the removed member's ETH closes as before, one audit line ({v.calls})")
check(v.round() == [] and len(audits("first_signal_wait_no_keys")) == 1, "and the audit line is not repeated every round")

# ── the window: past one bar the exit goes out, and it never waits again
fresh()
strat("btc", "BTCUSDT", state={"symbol": "BTCUSDT", "position": 1})
strat("db", "BTCUSDT")
config({"btc": 0, "db": 500})
v = Venue({"BTCUSDT": 500})
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
    config({"btc": 0, "db": 500})
    v = Venue({"BTCUSDT": 500})
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
config({"btc": 0, "db": 500})
v = Venue({"BTCUSDT": 500, "ETHUSDT": 300})
check(v.round() == [("ETHUSDT", -300)], f"removing eth while db waits on BTC: ETH still closes ({v.calls})")

# ── direction 2: only the difference the save made is frozen
def neighbours(c1_pos=1, c1_interval="1h", db_interval="1h"):
    fresh()
    strat("btc", "BTCUSDT", state={"symbol": "BTCUSDT", "position": 1})
    strat("c1", "BTCUSDT", interval=c1_interval, state={"symbol": "BTCUSDT", "position": c1_pos})
    strat("db", "BTCUSDT", interval=db_interval)
    config({"btc": 0, "c1": 200, "db": 500})
    return Venue({"BTCUSDT": 700})


v = neighbours()
check(v.round() == [], f"anchored: btc's 500 and c1's 200 stay ({v.calls})")
json.dump({"symbol": "BTCUSDT", "position": 0}, open("strategies/c1/state.json", "w"))
got = [v.round() for _ in range(3)]
check(got == [[("BTCUSDT", -200)], [], []] and v.held["BTCUSDT"] == 500,
      f"c1 stops out while db waits: its 200 is sold once, three rounds, btc's 500 stays ({got})")
json.dump({"symbol": "BTCUSDT", "position": 1}, open("strategies/c1/state.json", "w"))
check(v.round() == [("BTCUSDT", 200)], f"c1 back in: bought back, the frozen 500 untouched ({v.calls})")
json.dump({"symbol": "BTCUSDT", "position": 1}, open("strategies/db/state.json", "w"))
check(v.round() == [] and v.held["BTCUSDT"] == 700, f"db's first signal takes btc's 500 over: no order ({v.calls})")

v = neighbours()
v.round()
json.dump({"symbol": "BTCUSDT", "position": 2}, open("strategies/c1/state.json", "w"))
check(v.round() == [("BTCUSDT", 200)] and v.round() == [], f"c1 scales up while db waits: one buy ({v.calls})")

v = neighbours()
config({"btc": 0, "c1": 400, "db": 500})
check(v.round() == [] and v.held["BTCUSDT"] == 700,
      f"c1 raised 200→400 in the same save as the swap: anchored after the save, so that raise waits too ({v.calls})")
json.dump({"symbol": "BTCUSDT", "position": 1}, open("strategies/db/state.json", "w"))
check(v.round() == [("BTCUSDT", 200)], f"db's first signal: c1's raise goes out then, btc's 500 nets into db's ({v.calls})")

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

# a TW portfolio with a large literal UNIVERSE: only the difference is frozen, neighbours trade
fresh()
codes = [str(1100 + i) for i in range(150)]
strat("old", "2454", state={"symbol": "2454", "position": 1})
strat("n1", "2330", state={"symbol": "2330", "position": 1})
strat("n2", "2317", state={"symbol": "2317", "position": 1})
strat("tw", universe=codes + ["2330", "2317", "2454"])
config({"old": 0, "n1": 100, "n2": 100, "tw": 3000})
v = Venue({"2454": 300, "2330": 100, "2317": 100})
check(v.round() == [], f"tw joins with 153 keys, old leaves 2454: nothing moves ({v.calls})")
json.dump({"symbol": "2330", "position": 0}, open("strategies/n1/state.json", "w"))
json.dump({"symbol": "2317", "position": 2}, open("strategies/n2/state.json", "w"))
got = sorted(v.round())
check(got == [("2317", 100), ("2330", -100)] and v.held["2454"] == 300,
      f"inside its window n1's exit and n2's add go out, old's 2454 waits ({got})")

# ── a non-UTF-8 strategy.py never takes the round down
fresh()
strat("eth", "ETHUSDT", state={"symbol": "ETHUSDT", "position": 1})
os.makedirs("strategies/bad", exist_ok=True)
open("strategies/bad/strategy.py", "wb").write('# 換成新版\nSYMBOL = "BTCUSDT"\nINTERVAL = "1h"\n'.encode("big5"))
config({"bad": 500})
v = Venue({"ETHUSDT": 300, "BTCUSDT": 500})
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
    config({"btc": 0, "db": 500})
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
    v, seen = Venue({"BTCUSDT": 500}), []
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
config({"btc": 0, "db": 500})
open(guard.HALT_PATH, "w").write("test")
v = Venue({"BTCUSDT": 500})
check(v.round() == [], f"halted, inside the window: nothing ({v.calls})")
backdate("db", 3601)
got = v.round()
if "halt_freeze" in portfolio.RECONCILE_CAPS:
    check(got == [], f"halted, past the window: still nothing — HALT freezes every order ({got})")
v.held["BTCUSDT"] = 0
json.dump({"symbol": "BTCUSDT", "position": 1}, open("strategies/db/state.json", "w"))
check(v.round() == [] and v.held.get("BTCUSDT", 0) == 0, f"halted: db's first signal opens nothing ({v.calls})")
os.remove(guard.HALT_PATH)

print(f"\n{fails} FAILED" if fails else "\nall ok")
sys.exit(1 if fails else 0)
