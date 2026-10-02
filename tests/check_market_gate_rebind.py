"""Market gate across a rebind, end to end (audit 0.1.12 venue gate P0-1 / P1-1).

A backtest from before 0.1.12 (no `market`) funded on paper trading, then the machine is bound to
OKX through the real _cmd_credentials (paper evicted, routes blanked, HALT): saving it again and
pressing 啟動下單 must both refuse — Binance ONUSDT is a $0.10 coin, OKX ON-USDT-SWAP an equity
perpetual. Routed to the venue it traded on, it keeps saving. Then the execution side: a funded
strategy whose verdict turns after the save (its contract left the table) is held by
lib/portfolio.aggregate_portfolio — its symbol gets no orders — while the rest of the machine
starts.

Runtime + the real workspace lib, no network (account reads stubbed), no reconciler.

Run: cd blave-agent && .venv/bin/python tests/check_market_gate_rebind.py
"""
import json
import os
import shutil
import sys
import tempfile
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BASE = tempfile.mkdtemp(prefix="gate-rebind-")
os.environ["BLAVE_AGENT_HOME"] = os.environ["BLAVECLAW_HOME"] = BASE
WS = os.path.join(BASE, "workspace")
shutil.copytree(os.path.join(ROOT, "lib"), os.path.join(WS, "lib"), ignore=shutil.ignore_patterns("__pycache__"))
os.makedirs(os.path.join(WS, "state", "heartbeat"))
os.makedirs(os.path.join(WS, "manager"))
open(os.path.join(WS, "manager", "wait_for_bar.py"), "w").write("#\n")
os.environ["BLAVE_AGENT_BASE"] = BASE
os.symlink(os.path.join(ROOT, "runtime"), os.path.join(BASE, "current"))   # <BASE>/current = the runtime, as on a machine
os.environ["BLAVE_AGENT_WORKSPACE"] = WS
os.environ.pop("BLAVE_AGENT_LOCAL", None)
os.chdir(WS)
sys.path.insert(0, os.path.join(ROOT, "runtime"))
sys.path.insert(0, WS)

import command_listener as cl  # noqa: E402
import market_gate as G  # noqa: E402
import portfolio_reporter as pr  # noqa: E402
import lib.account_okx as _okx  # noqa: E402
from lib import portfolio  # noqa: E402

_okx.get_account_id = lambda env: (_ for _ in ()).throw(RuntimeError("no network in this test"))
_okx.withdraw_enabled = lambda env: False
cl._stop_reconciler = lambda: True
cl._restart_reconciler = lambda args: "reconciler restarted"
cl._stray_reconciler_pids = lambda: []
cl._reconciler_supervised = lambda: False
cl._sync_strategy_crons = lambda names: None

fails = 0


def check(cond, msg, detail=None):
    global fails
    print(("ok   " if cond else "FAIL ") + msg + ("" if cond or detail is None else f"  [{detail}]"))
    fails += 0 if cond else 1


def strat(name, symbol, market=None):
    d = os.path.join(WS, "strategies", name)
    os.makedirs(d, exist_ok=True)
    open(os.path.join(d, "strategy.py"), "w").write(f"SYMBOL = {symbol!r}\nINTERVAL = '1h'\n")
    s = {"symbol": symbol, "daily_returns": [0.0]}
    if market:
        s["market"] = market
    json.dump(s, open(os.path.join(d, "stats.json"), "w"))
    json.dump({"symbol": symbol, "position": 1.0, "market": "swap"}, open(os.path.join(d, "state.json"), "w"))


def run(fn, *a):
    try:
        fn(*a)
        return None
    except ValueError as e:
        return str(e)


def routing():
    return G.read_routing(WS)


PAPER = {"PAPER_API_KEY": "paper", "PAPER_SECRET_KEY": "paper", "PAPER_BOUND_TS": str(int(time.time()))}
OKX = {"OKX_API_KEY": "not-a-real-okx-key", "OKX_SECRET_KEY": "not-a-real-okx-secret",
       "OKX_PASSPHRASE": "not-a-real-okx-pass"}
HALT = os.path.join(WS, "state", "HALT")

check(G.lib_writes_market(WS), "the real workspace lib records `market` (gate on)")
strat("on_mom", "ONUSDT")                       # backtested before 0.1.12: no market
strat("on_new", "ONUSDT", "crypto_perp:binance")

cl._cmd_credentials({"env": PAPER})
check(run(cl._cmd_amounts, {"amounts": {"on_mom": 100}}) is None
      and routing() == ({"on_mom": 100.0}, {"on_mom": "paper"}),
      "paper: the no-market ONUSDT strategy saves at $100, routed to paper")

cl._cmd_credentials({"env": OKX})
amounts, labels = routing()
check(amounts.get("on_mom") == 100.0 and not labels.get("on_mom") and os.path.exists(HALT),
      "bind OKX (real _cmd_credentials): paper evicted, route blanked, amount kept, HALT")
msg = run(cl._cmd_amounts, {"amounts": {"on_mom": 100}})
check(bool(msg) and msg.startswith("MARKET_LEGACY: 「on_mom」"),
      f"P0: saving it again on OKX → MARKET_LEGACY (was: passes and routes ONUSDT to OKX) (got {msg!r})")
msg = run(cl._cmd_resume, {})
check(bool(msg) and msg.startswith("MARKET_LEGACY: 「on_mom」") and os.path.exists(HALT),
      f"P0: 啟動下單 on OKX → MARKET_LEGACY, HALT stays (got {msg!r})")
check(run(cl._cmd_amounts, {"amounts": {"on_new": 100}}).startswith("MARKET_SOURCE: 「on_new」"),
      "the same contract with a recorded market (Binance data) on OKX → MARKET_SOURCE (ONUSDT not in the table)")
check(run(cl._cmd_amounts, {"amounts": {}}) is None and run(cl._cmd_resume, {}) is None and not os.path.exists(HALT),
      "untick it, save, 啟動下單: starts")

# routed to the venue it traded on: a no-market strategy keeps saving there
strat("btc_old", "BTCUSDT")
for p in ("portfolio_config.json", "amounts.ui.json"):
    json.dump({"amounts": {"btc_old": 50}, "exchanges": {"btc_old": "okx"}}, open(os.path.join(WS, "manager", p), "w"))
check(run(cl._cmd_amounts, {"amounts": {"btc_old": 80}}) is None,
      "legacy routed to OKX and funded there: saves on OKX (it traded there)")
check(run(cl._cmd_amounts, {"amounts": {"btc_old": 80, "on_mom": 0}}).startswith("MARKET_LEGACY: 「on_mom」"),
      "a new legacy pick next to it, even at $0: refused (never routed here)")
json.dump({"amounts": {"btc_old": 50, "on_mom": 50}, "exchanges": {"btc_old": "okx", "on_mom": "okx"}},
          open(os.path.join(WS, "manager", "portfolio_config.json"), "w"))
check(run(cl._cmd_amounts, {"amounts": {"btc_old": 80, "on_mom": 50}}).startswith("MARKET_LEGACY: 「on_mom」"),
      "an agent-written funded legacy row in portfolio_config.json does not launder it: prev is the UI mirror")

# execution side: a funded strategy still routed to OKX whose verdict turned (its stats changed)
strat("btc_live", "BTCUSDT", "crypto_perp:binance")
for p in ("portfolio_config.json", "amounts.ui.json"):
    json.dump({"amounts": {"btc_old": 50, "btc_live": 100}, "exchanges": {"btc_old": "okx", "btc_live": "okx"}},
              open(os.path.join(WS, "manager", p), "w"))
pr.market_gate_report()
check(not os.path.exists(os.path.join(WS, G.HOLDS_PATH)) or json.load(open(os.path.join(WS, G.HOLDS_PATH))) == {},
      "nothing held while every funded strategy matches its venue")
strat("btc_live", "XAUUSDT", "crypto_perp:binance")          # its contract is not OKX's
ev_path = os.path.join(WS, "state", "events.jsonl")
rep = pr.market_gate_report()
held = json.load(open(os.path.join(WS, G.HOLDS_PATH)))
evs = [json.loads(x) for x in open(ev_path)] if os.path.exists(ev_path) else []
check(held == {"btc_live": {"venue": "okx", "reason": "src", "symbols": ["XAUUSDT"]}} and rep["holds"] == held
      and [(e["type"], e["payload"].get("strategy")) for e in evs] == [("market_hold", "btc_live")],
      "report: the turned strategy is held (state/market_hold.json + report holds) and one P1 market_hold event")
pr.market_gate_report()
evs = [json.loads(x) for x in open(ev_path)]
check(len(evs) == 1, "still held next round: no second event")
target = portfolio.aggregate_portfolio()
row = target.get("XAUUSDT") or target.get(portfolio.market_key("XAUUSDT", "swap")) or {}
check(row.get("gated") is True and row["contributors"][0].get("market_hold") is True,
      "lib/portfolio: the held strategy's symbol is gated (no entry, no close) and marked market_hold")
open(HALT, "w").write("x")
check(run(cl._cmd_resume, {}) is None and not os.path.exists(HALT),
      "啟動下單 is not blocked by it (still routed to OKX, approved at save): only that strategy is held")
strat("btc_live", "BTCUSDT", "crypto_perp:binance")
pr.market_gate_report()
check(json.load(open(os.path.join(WS, G.HOLDS_PATH))) == {} and not portfolio.aggregate_portfolio()
      .get(portfolio.market_key("BTCUSDT", "swap"), {}).get("gated"),
      "fixed (re-run backtest): the hold lifts on the next report")

# ── the freeze is that strategy's share only (Wei: the held strategy stops entirely — no entry,
# no exit — and nothing else does) ──────────────────────────────────────────────────────────────
SWAP = lambda sym: portfolio.market_key(sym, "swap")


PINS = os.path.join(WS, "state", "market_hold_pins.json")


def setup(amounts, states, hold, snapshot, positions=None, keep_pins=False, ledger=None):
    """positions = the symbol positions the last reconcile saw ({key: signed USD}); default =
    every snapshot target filled exactly."""
    if not keep_pins and os.path.exists(PINS):
        os.remove(PINS)
    for n in list(os.listdir(os.path.join(WS, "strategies"))):
        shutil.rmtree(os.path.join(WS, "strategies", n))
    for n, st in states.items():
        os.makedirs(os.path.join(WS, "strategies", n))
        json.dump(st, open(os.path.join(WS, "strategies", n, "state.json"), "w"))
    for p in ("portfolio_config.json", "amounts.ui.json"):
        json.dump({"amounts": amounts, "exchanges": {n: "okx" for n in amounts}},
                  open(os.path.join(WS, "manager", p), "w"))
    json.dump(hold, open(os.path.join(WS, G.HOLDS_PATH), "w"))
    snap = os.path.join(WS, "manager", "last_reconcile.json")
    if snapshot is None:
        if os.path.exists(snap):
            os.remove(snap)
    else:
        if positions is None:
            positions = {k: sum(cs.values()) for k, cs in snapshot.items()}
        json.dump({"target": {k: {"exchange": "okx", "market": "swap", "asset_spec": None,
                                  "contributors": [{"strategy": n, "contribution": c} for n, c in cs.items()]}
                              for k, cs in snapshot.items()},
                   "actual": {k: {"side": "long" if v > 0 else "short", "size": abs(v)} for k, v in positions.items() if v},
                   **({"ledger": {k: {"side": "long" if v > 0 else "short", "size": abs(v)} for k, v in ledger.items() if v}}
                      if ledger is not None else {})},
                  open(snap, "w"))
    return portfolio.aggregate_portfolio()


def contrib(row, name):
    return next((c for c in row["contributors"] if c["strategy"] == name), None)


A = lambda sym, pos: {"symbol": sym, "position": pos, "market": "swap"}
held_a = {"held_a": {"venue": "okx", "reason": "src", "symbols": ["BTCUSDT"]}}
t = setup({"held_a": 100, "free_a": 50}, {"held_a": A("BTCUSDT", -1.0), "free_a": A("BTCUSDT", 1.0)},
          held_a, {SWAP("BTCUSDT"): {"held_a": 100.0, "free_a": 0.0}})
row = t[SWAP("BTCUSDT")]
check(row["gated"] is False and row["side"] == "long" and abs(row["size"] - 150) < 1e-9
      and contrib(row, "held_a")["contribution"] == 100.0 and contrib(row, "held_a")["market_hold"] is True
      and contrib(row, "free_a")["contribution"] == 50.0,
      "same symbol: the held strategy's share stays at its last reconciled 100 (its signal flipped to -1: no exit, "
      "no flip); the other strategy's +50 entry goes through — the symbol is not frozen")
t = setup({"held_a": 100, "free_a": 50}, {"held_a": A("BTCUSDT", -1.0), "free_a": A("BTCUSDT", 1.0)}, held_a, None)
check(t[SWAP("BTCUSDT")]["gated"] is True,
      "same symbol, no reconcile snapshot to read the held share from: cannot be told apart → the symbol is held whole")
t = setup({"held_a": 100}, {"held_a": A("BTCUSDT", 0.0)}, held_a, {SWAP("BTCUSDT"): {"held_a": 100.0}})
check(t[SWAP("BTCUSDT")]["gated"] is True and t[SWAP("BTCUSDT")]["size"] == 100.0,
      "a symbol only the held strategy trades: nothing moves on it (gated), its signal going flat closes nothing")
C = lambda w: {"type": "portfolio", "weights": w, "market": "swap"}
held_c = {"basket": {"venue": "okx", "reason": "src", "symbols": ["ONUSDT"]}}
t = setup({"basket": 300}, {"basket": C({"BTCUSDT": 0.5, "ETHUSDT": 0.5, "ONUSDT": 0.0})}, held_c,
          {SWAP("BTCUSDT"): {"basket": 100.0}, SWAP("ETHUSDT"): {"basket": 100.0}, SWAP("ONUSDT"): {"basket": 100.0}})
check(t[SWAP("BTCUSDT")]["gated"] is False and t[SWAP("BTCUSDT")]["size"] == 150.0
      and t[SWAP("ETHUSDT")]["gated"] is False and t[SWAP("ETHUSDT")]["size"] == 150.0
      and not contrib(t[SWAP("BTCUSDT")], "basket").get("market_hold"),
      "Type C: the symbols that still match rebalance as usual (BTC / ETH 100 → 150)")
check(t[SWAP("ONUSDT")]["gated"] is True and t[SWAP("ONUSDT")]["size"] == 100.0
      and contrib(t[SWAP("ONUSDT")], "basket")["market_hold"] is True,
      "Type C: only the mismatched ONUSDT is frozen at its last share (weight 0 now: not closed)")
t = setup({"basket": 300}, {"basket": C({"BTCUSDT": 0.5, "ETHUSDT": 0.5})}, held_c,
          {SWAP("BTCUSDT"): {"basket": 100.0}, SWAP("ONUSDT"): {"basket": 100.0}})
check(SWAP("ONUSDT") in t and t[SWAP("ONUSDT")]["size"] == 100.0 and t[SWAP("ONUSDT")]["gated"] is True,
      "Type C: a held symbol that left the live weights keeps its frozen share (dropping it would close it)")
t = setup({"basket": 300, "free_a": 50}, {"basket": C({"BTCUSDT": 1.0}), "free_a": A("BTCUSDT", 1.0)},
          {"basket": {"venue": "okx", "reason": "us"}}, {SWAP("BTCUSDT"): {"basket": 20.0, "free_a": 0.0}})
check(t[SWAP("BTCUSDT")]["gated"] is False and t[SWAP("BTCUSDT")]["size"] == 70.0,
      "a whole-strategy hold (code turned to US data) freezes all its shares, the other strategy's entry still goes")

# ── the pin only moves toward 0 (audit round 3 R3): never re-enter a held strategy ──────────────
two = {"held_a": 100, "free_a": 50}
sts = {"held_a": A("BTCUSDT", 1.0), "free_a": A("BTCUSDT", 1.0)}
t = setup(two, sts, held_a, {SWAP("BTCUSDT"): {"held_a": 100.0, "free_a": 50.0}}, positions={SWAP("BTCUSDT"): 0.0})
check(contrib(t[SWAP("BTCUSDT")], "held_a")["contribution"] == 0.0 and t[SWAP("BTCUSDT")]["size"] == 50.0,
      "last round's target never filled (position 0): the held share is 0, not the unfilled 100 — only the other strategy's 50")
t = setup(two, sts, held_a, {SWAP("BTCUSDT"): {"held_a": 100.0, "free_a": 50.0}}, positions={SWAP("BTCUSDT"): 60.0})
check(contrib(t[SWAP("BTCUSDT")], "held_a")["contribution"] == 60.0,
      "partly filled (position 60): the held share is cut to 60 — never above the symbol's position")
t = setup(two, sts, held_a, {SWAP("BTCUSDT"): {"held_a": 100.0, "free_a": 50.0}}, positions={SWAP("BTCUSDT"): -30.0})
check(contrib(t[SWAP("BTCUSDT")], "held_a")["contribution"] == 0.0, "position on the other side: the held share is 0")
# 暫停並全部平倉 → 啟動下單: the snapshot may still show the old target and position (no round since)
t = setup(two, sts, held_a, {SWAP("BTCUSDT"): {"held_a": 100.0, "free_a": 50.0}})
check(contrib(t[SWAP("BTCUSDT")], "held_a")["contribution"] == 100.0, "before close-all: pinned at 100")
portfolio.zero_ledger_symbols([SWAP("BTCUSDT")])        # what manager/flatten.py calls for every key it closed
t = setup(two, sts, held_a, {SWAP("BTCUSDT"): {"held_a": 100.0, "free_a": 50.0}}, keep_pins=True)
check(contrib(t[SWAP("BTCUSDT")], "held_a")["contribution"] == 0.0 and t[SWAP("BTCUSDT")]["size"] == 50.0,
      "close-all then 啟動下單: the held share stays 0 even with a stale snapshot — not bought back")
t = setup(two, sts, held_a, {SWAP("BTCUSDT"): {"held_a": 100.0, "free_a": 50.0}}, positions={SWAP("BTCUSDT"): 500.0}, keep_pins=True)
check(contrib(t[SWAP("BTCUSDT")], "held_a")["contribution"] == 0.0, "a pin never grows back (position 500 later): still 0")
t = setup(two, sts, held_a, {SWAP("BTCUSDT"): {"held_a": 100.0, "free_a": 50.0}})
t = setup(two, sts, held_a, {SWAP("BTCUSDT"): {"held_a": 100.0, "free_a": 50.0}}, positions={SWAP("BTCUSDT"): 40.0}, keep_pins=True)
check(contrib(t[SWAP("BTCUSDT")], "held_a")["contribution"] == 40.0,
      "a stored pin keeps being cut on later rounds (100 stored, the symbol's position fell to 40 → 40)")
setup(two, sts, held_a, None)                            # held, no pin yet, no snapshot
portfolio.zero_ledger_symbols([SWAP("BTCUSDT")])
t = setup(two, sts, held_a, {SWAP("BTCUSDT"): {"held_a": 100.0, "free_a": 50.0}}, keep_pins=True)
check(contrib(t[SWAP("BTCUSDT")], "held_a")["contribution"] == 0.0,
      "close-all while held but before any pin was taken: the held share is 0 afterwards too")
t = setup(two, sts, held_a, {SWAP("BTCUSDT"): {"held_a": 100.0, "free_a": 50.0}}, ledger={SWAP("BTCUSDT"): 0.0})
check(contrib(t[SWAP("BTCUSDT")], "held_a")["contribution"] == 0.0,
      "self_ledger: cut to the bot's own book (0), not the account read (150, the user's own coins included)")
t = setup(two, sts, held_a, {SWAP("BTCUSDT"): {"free_a": 50.0}})
check(t[SWAP("BTCUSDT")]["gated"] is False and contrib(t[SWAP("BTCUSDT")], "held_a")["contribution"] == 0.0
      and t[SWAP("BTCUSDT")]["size"] == 50.0,
      "snapshot with no row for the held strategy on this symbol: its share is 0 (it had none) — the symbol is not gated")
os.remove(os.path.join(WS, G.HOLDS_PATH))
t = setup({"free_a": 50}, {"free_a": A("BTCUSDT", 1.0)}, {}, None)
json.dump({"held_a": {SWAP("BTCUSDT"): 10.0}}, open(PINS, "w"))
portfolio.aggregate_portfolio()
check(json.load(open(PINS)) == {}, "hold lifted: its pins are dropped")
os.remove(os.path.join(WS, G.HOLDS_PATH))

# ── a held strategy unticked and saved: its share is closed (spec §14.3 tr.hold.next "its position will be closed")
setup(two, sts, held_a, {SWAP("BTCUSDT"): {"held_a": 100.0, "free_a": 50.0}})        # held, pinned at 100
json.dump({"held_a": {SWAP("BTCUSDT"): 100.0}}, open(PINS, "w"))
for p in ("portfolio_config.json", "amounts.ui.json"):                                   # what _cmd_amounts writes without it
    json.dump({"amounts": {"free_a": 50}, "exchanges": {"free_a": "okx"}}, open(os.path.join(WS, "manager", p), "w"))
t = portfolio.aggregate_portfolio()                                                       # market_hold.json still lists it (report not yet run)
orders = portfolio.compute_diff(t, {SWAP("BTCUSDT"): {"side": "long", "size": 150.0}}, threshold=10)
check(t[SWAP("BTCUSDT")]["gated"] is False and t[SWAP("BTCUSDT")]["size"] == 50.0 and not contrib(t[SWAP("BTCUSDT")], "held_a")
      and [round(o["signed_diff"], 6) for o in orders] == [-100.0] and json.load(open(PINS)) == {},
      "unticked + saved while held: its share leaves the target and the reconciler sells its 100 (the other strategy's 50 stays)")
for p in ("portfolio_config.json", "amounts.ui.json"):
    json.dump({"amounts": {}, "exchanges": {}}, open(os.path.join(WS, "manager", p), "w"))
json.dump({"held_a": {SWAP("BTCUSDT"): 100.0}}, open(PINS, "w"))
t = portfolio.aggregate_portfolio()
orders = portfolio.compute_diff(t, {SWAP("BTCUSDT"): {"side": "long", "size": 100.0}}, threshold=10)
check(SWAP("BTCUSDT") not in t and [round(o["signed_diff"], 6) for o in orders] == [-100.0],
      "unticked + saved, the only strategy on the symbol: the symbol leaves the target and its position is closed")
os.remove(os.path.join(WS, G.HOLDS_PATH))

# ── order-time check (audit round 4 R6): a symbol nobody judged yet never gets its first order ──
EV = os.path.join(WS, "state", "events.jsonl")


def fresh(amounts, states, stats=None, code=None, snapshot=None):
    setup(amounts, states, {}, snapshot)
    for f in (G.HOLDS_PATH, "state/events.jsonl", "state/market_hold_pins.json", G.ALERTED_PATH):
        if os.path.exists(os.path.join(WS, f)):
            os.remove(os.path.join(WS, f))
    for n, st in (stats or {}).items():
        json.dump(st, open(os.path.join(WS, "strategies", n, "stats.json"), "w"))
    for n, c in (code or {}).items():
        open(os.path.join(WS, "strategies", n, "strategy.py"), "w").write(c)
    return portfolio.aggregate_portfolio()


J = lambda x: json.dumps(x, default=str)[:400]


def events():
    return [json.loads(x) for x in open(EV)] if os.path.exists(EV) else []


# B1: a Type B that writes its own state.json with json.dump (no update_state anywhere), funded on OKX
t = fresh({"b_dump": 100}, {"b_dump": A("ONUSDT", 1.0)},
          code={"b_dump": "STRATEGY_NAME = 'b_dump'\nimport json\njson.dump({'symbol': 'ONUSDT', 'position': 1}, open('s', 'w'))\n"})
row = t.get(SWAP("ONUSDT"), {})
hold = json.load(open(os.path.join(WS, G.HOLDS_PATH)))
check(row.get("gated") is True and contrib(row, "b_dump").get("market_hold") is True
      and hold.get("b_dump") == {"venue": "okx", "reason": "unconfirmed", "symbols": ["ONUSDT"]}
      and [(e["type"], e["payload"]["strategy"]) for e in events()] == [("market_hold", "b_dump")],
      "first round: the json.dump Type B's ONUSDT on OKX is held before its first order (no ONUSDT order), "
      "written to market_hold.json, one P1 event", J([(e["type"], e["payload"]) for e in events()]))
portfolio.aggregate_portfolio()
check(len(events()) == 1, "next round: already held — no second event")
pr.market_gate_report()
check(len(events()) == 1 and "b_dump" in json.load(open(os.path.join(WS, G.HOLDS_PATH))),
      "the report agrees (same verdict) and does not alert again")
# B2: a Type C rebalances ONUSDT in (BTC / ETH were the backtest's symbols)
t = fresh({"basket": 300}, {"basket": C({"BTCUSDT": 0.5, "ONUSDT": 0.5})},
          stats={"basket": {"market": "crypto_perp:binance", "market_symbols": ["BTCUSDT", "ETHUSDT"], "daily_returns": [0.0]}},
          code={"basket": "STRATEGY_NAME = 'basket'\nINTERVAL = '1d'\n"},
          snapshot={SWAP("BTCUSDT"): {"basket": 150.0}})
check(t[SWAP("BTCUSDT")]["gated"] is False and t[SWAP("BTCUSDT")]["size"] == 150.0
      and t[SWAP("ONUSDT")]["gated"] is True and contrib(t[SWAP("ONUSDT")], "basket")["contribution"] == 0.0
      and json.load(open(os.path.join(WS, G.HOLDS_PATH)))["basket"]["symbols"] == ["ONUSDT"],
      "first round: the Type C's new ONUSDT gets no order (held at 0), its BTC rebalances as usual")
json.dump({"type": "portfolio", "weights": {"BTCUSDT": 0.4, "ONUSDT": 0.3, "XAUUSDT": 0.3}, "market": "swap"},
          open(os.path.join(WS, "strategies", "basket", "state.json"), "w"))
t = portfolio.aggregate_portfolio()
check(t[SWAP("XAUUSDT")]["gated"] is True and json.load(open(os.path.join(WS, G.HOLDS_PATH)))["basket"]["symbols"] == ["ONUSDT", "XAUUSDT"]
      and len(events()) == 1,
      "a second new symbol (XAUUSDT) is held too and joins the same hold — no second P1 for the same strategy")
# a Type A whose SYMBOL an agent changed to one its Binance backtest does not cover on OKX
t = fresh({"a1": 100}, {"a1": A("XAUUSDT", 1.0)},
          stats={"a1": {"market": "crypto_perp:binance", "symbol": "BTCUSDT", "daily_returns": [0.0]}},
          code={"a1": "STRATEGY_NAME = 'a1'\nINTERVAL = '1h'\n"})
check(t[SWAP("XAUUSDT")]["gated"] is True, "a Type A whose SYMBOL was switched to XAUUSDT: held on its first round")
t = fresh({"a1": 100}, {"a1": A("BTCUSDT", 1.0)},
          stats={"a1": {"market": "crypto_perp:binance", "symbol": "BTCUSDT", "daily_returns": [0.0]}},
          code={"a1": "STRATEGY_NAME = 'a1'\nINTERVAL = '1h'\n"})
check(t[SWAP("BTCUSDT")]["gated"] is False and t[SWAP("BTCUSDT")]["size"] == 100.0 and not events()
      and not os.path.exists(os.path.join(WS, G.HOLDS_PATH)),
      "BTCUSDT (same contract on OKX): orders as usual, nothing held, no event")
# a Type C's zero weight orders nothing: not judged (the report skips it too), so no hold, no P1
t = fresh({"basket": 300}, {"basket": C({"BTCUSDT": 1.0, "ONUSDT": 0.0})},
          stats={"basket": {"market": "crypto_perp:binance", "market_symbols": ["BTCUSDT"], "daily_returns": [0.0]}},
          code={"basket": "STRATEGY_NAME = 'basket'\nINTERVAL = '1d'\n"})
check(not os.path.exists(os.path.join(WS, G.HOLDS_PATH)) and not events() and t[SWAP("BTCUSDT")]["size"] == 300.0,
      "a zero-weight ONUSDT in a Type C: not held, no P1")
# the report and the order-time check judge the same symbols: a Type A whose state.json trades XAUUSDT
# while its stats.json says BTCUSDT is held by both, and pages once — not once a round (audit round 5 P2)
t = fresh({"a1": 100}, {"a1": A("XAUUSDT", 1.0)},
          stats={"a1": {"market": "crypto_perp:binance", "symbol": "BTCUSDT", "daily_returns": [0.0]}},
          code={"a1": "STRATEGY_NAME = 'a1'\nINTERVAL = '1h'\n"})
for _ in range(3):
    pr.market_gate_report()
    portfolio.aggregate_portfolio()
check("a1" in pr.market_gate_report()["holds"] and "a1" in json.load(open(os.path.join(WS, G.HOLDS_PATH)))
      and len([e for e in events() if e["type"] == "market_hold"]) == 1,
      "state.json symbol ≠ stats.json symbol: report and order-time check agree, three rounds, one P1")
json.dump({}, open(os.path.join(WS, G.HOLDS_PATH), "w"))      # the report dropped it (a race): the next round re-adds it
portfolio.aggregate_portfolio()
check(len([e for e in events() if e["type"] == "market_hold"]) == 1, "re-added after a drop: still one P1 that day (should_alert)")
for f in (G.HOLDS_PATH, "state/events.jsonl", G.ALERTED_PATH):
    if os.path.exists(os.path.join(WS, f)):
        os.remove(os.path.join(WS, f))

# the order-time check off (no runtime module at <BASE>/current): logged, retried, reported, one P2
import logging  # noqa: E402
_logs = []
_h = logging.Handler()
_h.emit = lambda r: _logs.append(r.getMessage())
logging.getLogger().addHandler(_h)
_cur = os.path.join(BASE, "current")
os.remove(_cur)
portfolio._GATE_MOD.update(mod=None, tried_at=None, why=None)
portfolio.aggregate_portfolio()
chk = json.load(open(os.path.join(WS, "state", "market_check.json")))
oc1 = pr.market_gate_report()["order_check"]
oc2 = pr.market_gate_report()["order_check"]
p2 = [e for e in events() if e["type"] == "market_check_off"]
check(chk["on"] is False and chk["why"] == "runtime_missing" and any("market check OFF" in m for m in _logs)
      and oc1["on"] is False and oc1["why"] == "runtime_missing" and oc2 == oc1
      and len(p2) == 1 and p2[0]["payload"] == {"kind": "runtime_missing", "why": "runtime_missing"},
      "runtime module missing: logged, state/market_check.json + report order_check say off (runtime_missing), one P2 (not per report)")
portfolio.aggregate_portfolio()
check(sum("market check OFF" in m for m in _logs) == 1, "retry waits _GATE_RETRY_S (no reload every round)")
os.symlink(os.path.join(ROOT, "runtime"), _cur)
portfolio._GATE_RETRY_S = 0
portfolio.aggregate_portfolio()
chk = json.load(open(os.path.join(WS, "state", "market_check.json")))
check(chk["on"] is True and chk["table"] is True and pr.market_gate_report()["order_check"]["on"] is True,
      "the module back: the next retry loads it, the check is on, the report says so")
portfolio._GATE_RETRY_S = 60
logging.getLogger().removeHandler(_h)
# the reconciler says its contract table is unreadable: report table false, one P2 per cause per day
for txt in ("unreadable (SyntaxError: x)", "unreadable (ValueError: y)"):
    json.dump({"on": True, "table": False, "why": txt, "at": 1}, open(os.path.join(WS, "state", "market_check.json"), "w"))
    oc = pr.market_gate_report()["order_check"]
p2 = [e["payload"]["why"] for e in events() if e["type"] == "market_check_off"]
_kinds = [e["payload"]["kind"] for e in events() if e["type"] == "market_check_off"]
check(oc["on"] is True and oc["table"] is False and len(p2) == 2 and p2[1].startswith("table: unreadable") and _kinds[1] == "table",
      "table unreadable on the reconciler: order_check table false, one P2 for that cause (a new error text is not a new cause)")
os.remove(os.path.join(WS, "state", "market_check.json"))
for f in (G.HOLDS_PATH, "state/events.jsonl"):
    if os.path.exists(os.path.join(WS, f)):
        os.remove(os.path.join(WS, f))

shutil.rmtree(BASE, ignore_errors=True)
print(f"\n{'ALL PASS' if not fails else f'{fails} FAIL'}")
sys.exit(1 if fails else 0)
