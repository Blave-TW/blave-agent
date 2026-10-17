"""A funded member with no state.json yet (just joined, its old one moved away by the runtime's
_retire_prejoin_signals, or never computed) holds the keys it trades as they are — no close, no
entry — until it writes its first state, at most one bar of its INTERVAL and never longer than
FIRST_SIGNAL_WAIT_MAX_S. Swapping a strategy for a new version on the same coin used to close the
position one round and buy it back the next.

Through the real aggregate_portfolio → reconcile with a fake venue:
  single → single switch, single → portfolio (UNIVERSE), portfolio keys from the backtest preview,
  no keys at all → not held (audit), the window (bar / cap / re-save does not restart it / leaving
  amounts clears it), past the window the exit goes out and the wait never restarts, an unrelated
  key still trades, HALT still denies entries and lets the reduce through.

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


def backdate(name, seconds):
    book = json.load(open("state/first_signal_wait.json"))
    book[name]["since"] = time.time() - seconds
    json.dump(book, open("state/first_signal_wait.json", "w"))


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
check(row.get("gated") is True and set(row.get("awaiting") or {}) == {"db"}
      and "first_signal_wait" in snap.get("caps", []),
      f"the snapshot names who it waits for, and the running code says it holds ({row})")
a = audits("first_signal_wait")
check(len(a) == 1 and a[0]["strategy"] == "db" and a[0]["keys"] == ["BTCUSDT"], f"one audit line when the wait starts ({a})")
check(v.round() == [] and len(audits("first_signal_wait")) == 1, "a second round inside the window: still nothing, no second audit line")
json.dump({"symbol": "BTCUSDT", "position": 1}, open("strategies/db/state.json", "w"))
check(v.round() == [] and v.held == {"BTCUSDT": 500}, f"db's first signal is long: no order at all — no close and buy-back ({v.calls})")
check("db" not in json.load(open("state/first_signal_wait.json")), "the member leaves the wait record once it has a state")
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

# ── HALT: the hold never opens anything; past the window the reduce goes through, the entry does not
fresh()
strat("btc", "BTCUSDT", state={"symbol": "BTCUSDT", "position": 1})
strat("db", "BTCUSDT")
config({"btc": 0, "db": 500})
open(guard.HALT_PATH, "w").write("test")
v = Venue({"BTCUSDT": 500})
check(v.round() == [], f"halted, inside the window: nothing ({v.calls})")
backdate("db", 3601)
check(v.round() == [("BTCUSDT", -500)], f"halted, past the window: the close is a reduce and goes through ({v.calls})")
json.dump({"symbol": "BTCUSDT", "position": 1}, open("strategies/db/state.json", "w"))
check(v.round() == [] and v.held.get("BTCUSDT", 0) == 0, f"halted: db's first signal opens nothing ({v.calls})")
os.remove(guard.HALT_PATH)

print(f"\n{fails} FAILED" if fails else "\nall ok")
sys.exit(1 if fails else 0)
