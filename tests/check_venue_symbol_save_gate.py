"""Saving the 下單設定 (command_listener._cmd_amounts): a strategy that goes from no amount to an
amount on a crypto exchange is refused when that exchange does not list a symbol it orders
(the lib's own [order_reject:symbol_unavailable]) — `VENUE_SYMBOL: 「name」…` naming the symbol
and the exchange, no other name suggested, nothing written. Desktop and cloud run this same save.

  - Type C: the latest state.json weight keys, every key (a 0 weight is a later entry);
    no state.json → backtest_state.json; neither → saves
  - Type A: SYMBOL (stats.json)
  - spot strategies (MARKET = 'spot') are checked against the spot list
  - fail-open: the list read fails, Binance unreadable on a renaming venue (Bybit), paper,
    no venue bound, the save's one lookup budget (shared by every newly funded strategy) runs
    out — the save returns within it
  - symbols are judged dashless, as the reconciler orders them (Bybit's lib keeps the dash)
  - only unfunded→funded: an already-funded member saves and is not re-read; picked at 0 then
    funded is checked
No network: lib.order_<venue>.get_contract_rules / get_spot_rules and stock_perps are stubbed.

Run: cd blave-agent && .venv/bin/python tests/check_venue_symbol_save_gate.py
"""
import json
import os
import sys
import tempfile
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BASE = tempfile.mkdtemp(prefix="venue-symbol-save-gate-")
WS = os.path.join(BASE, "workspace")
os.makedirs(os.path.join(WS, "manager"))
os.makedirs(os.path.join(WS, "state"))
os.environ["BLAVE_AGENT_BASE"] = BASE
os.environ["BLAVE_AGENT_WORKSPACE"] = WS
os.environ.pop("BLAVE_AGENT_LOCAL", None)
sys.path.insert(0, os.path.join(ROOT, "runtime"))
sys.path.insert(0, ROOT)
os.chdir(WS)
import command_listener as cl  # noqa: E402
import lib.order_bybit as oby  # noqa: E402
import lib.order_okx as okx  # noqa: E402
import lib.stock_perps as sp  # noqa: E402
import requests  # noqa: E402

fails = 0
CONFIG = os.path.join(WS, "manager", "portfolio_config.json")
MIRROR = os.path.join(WS, "manager", "amounts.ui.json")
LISTED = {"swap": {"BTCUSDT", "ETHUSDT", "AMZNUSDT", "SLOWUSDT"}, "spot": {"BTCUSDT"}}
SLOW_S = 8
CALLS = []
MODE = {"down": False}
BINANCE = {"rows": {"BTCUSDT": ("COIN", "BTC")}}
sp.binance_rows = lambda: BINANCE["rows"]


def _rules(market, unlisted):
    def rules(env, sym):
        CALLS.append((market, sym))
        if sym == "SLOWUSDT":
            time.sleep(SLOW_S)
            raise unlisted(sym)   # past the budget: whatever it says comes too late
        if MODE["down"]:
            raise requests.exceptions.ConnectionError("list unreadable")
        if sym not in LISTED[market]:
            raise unlisted(sym)
        return {"active": True}
    return rules


okx.get_contract_rules = _rules("swap", lambda s: okx.OKXError("51001", "Instrument ID doesn't exist.", "/api/v5/public/instruments"))
okx.get_spot_rules = _rules("spot", lambda s: okx.OKXError("51001", "Instrument ID doesn't exist.", "/api/v5/public/instruments"))
oby.get_contract_rules = _rules("swap", lambda s: oby.BybitError(f"bybit: unknown linear symbol {s}", kind="symbol_unavailable"))


def check(cond, msg):
    global fails
    print(("ok   " if cond else "FAIL ") + msg)
    fails += 0 if cond else 1


def strat(name, body, typ="A", stats=None, state=None, preview=None):
    d = os.path.join(WS, "strategies", name)
    os.makedirs(d, exist_ok=True)
    with open(os.path.join(d, "strategy.py"), "w") as f:
        f.write(f'# Type:     {typ}\nSTRATEGY_NAME = "{name}"\nINTERVAL = "1d"\n{body}')
    for fname, doc in (("stats.json", stats), ("state.json", state), ("backtest_state.json", preview)):
        if doc is not None:
            with open(os.path.join(d, fname), "w") as f:
                json.dump(doc, f)


KLINE = "from lib.data import fetch_kline\n"
PF_STATS = {"benchmark_return": 1.0}
strat("c_xaut", KLINE + "UNIVERSE = ['BTCUSDT', 'XAUTUSDT']\n", typ="C", stats=PF_STATS,
      state={"type": "portfolio", "market": "swap", "weights": {"BTCUSDT": 0.5, "XAUTUSDT": 0.0}})
strat("c_preview", KLINE + "UNIVERSE = ['ETHUSDT', 'AMZN']\n", typ="C", stats=PF_STATS,
      preview={"type": "portfolio", "market": "swap", "weights": {"ETHUSDT": 0.5, "AMZN": 0.5}})
strat("c_ok", KLINE + "UNIVERSE = ['BTCUSDT', 'ETHUSDT']\n", typ="C", stats=PF_STATS,
      state={"type": "portfolio", "market": "swap", "weights": {"BTCUSDT": 0.5, "ETHUSDT": 0.5}})
strat("c_nostate", KLINE + "UNIVERSE = ['AMZN']\n", typ="C", stats=PF_STATS)
strat("a_amzn", KLINE + "SYMBOL = 'AMZN'\n", stats={"symbol": "AMZN"})
strat("a_amznusdt", KLINE + "SYMBOL = 'AMZNUSDT'\n", stats={"symbol": "AMZNUSDT"})
strat("a_nosym", KLINE + "\n")
strat("a_spot_eth", KLINE + "SYMBOL = 'ETHUSDT'\nMARKET = 'spot'\n", stats={"symbol": "ETHUSDT"})
strat("a_spot_btc", KLINE + "SYMBOL = 'BTCUSDT'\nMARKET = 'spot'\n", stats={"symbol": "BTCUSDT"})
strat("a_dash", KLINE + "SYMBOL = 'BTC-USDT'\n", stats={"symbol": "BTC-USDT"})
strat("c_dash", KLINE + "UNIVERSE = ['BTC-USDT', 'ETH-USDT']\n", typ="C", stats=PF_STATS,
      state={"type": "portfolio", "market": "swap", "weights": {"BTC-USDT": 0.5, "ETH-USDT": 0.5}})
strat("a_slow1", KLINE + "SYMBOL = 'SLOWUSDT'\n", stats={"symbol": "SLOWUSDT"})
strat("a_slow2", KLINE + "SYMBOL = 'SLOWUSDT'\n", stats={"symbol": "SLOWUSDT"})
with open(os.path.join(WS, "manager", "wait_for_bar.py"), "w") as f:
    f.write("# present\n")
cl._sync_strategy_crons = lambda names: None
cl._portfolio_trading_supported = lambda: True

OKX = "OKX_API_KEY=a\nOKX_SECRET_KEY=b\nOKX_PASSPHRASE=c\n"
BYBIT = "BYBIT_API_KEY=a\nBYBIT_SECRET_KEY=b\n"
PAPER = "PAPER_API_KEY=paper\nPAPER_SECRET_KEY=paper\n"


def bind(lines):
    with open(os.path.join(WS, ".env"), "w") as f:
        f.write(lines)
    for p in (CONFIG, MIRROR):
        if os.path.exists(p):
            os.remove(p)


def save(amounts):
    try:
        cl._cmd_amounts({"amounts": amounts})
    except ValueError as e:
        return str(e)
    return None


def refused(name, amounts, *words):
    before = open(CONFIG).read() if os.path.exists(CONFIG) else None
    err = save(amounts)
    after = open(CONFIG).read() if os.path.exists(CONFIG) else None
    return (err is not None and err.startswith(f"VENUE_SYMBOL: 「{name}」") and all(w in err for w in words)
            and after == before), err


def saved(amounts):
    err = save(amounts)
    cfg = json.load(open(CONFIG)) if os.path.exists(CONFIG) else {}
    return err is None and cfg.get("amounts") == {k: float(v) for k, v in amounts.items()}, err


# ── refusals ────────────────────────────────────────────────────────────────
bind(OKX)
ok, err = refused("c_xaut", {"c_xaut": 500}, "XAUTUSDT", "OKX")
check(ok and "BTCUSDT" not in err and "XAUUSDT" not in err and "XAU-" not in err,
      f"Type C: a 0-weight state.json key OKX does not list is refused, named, nothing else suggested ({err})")
ok, err = refused("c_preview", {"c_preview": 500}, "AMZN", "OKX")
check(ok and "ETHUSDT" not in err, f"Type C, no state.json: backtest_state.json's keys are judged ({err})")
ok, err = refused("a_amzn", {"a_amzn": 100}, "AMZN", "OKX")
check(ok, f"Type A: a bare SYMBOL OKX does not list is refused ({err})")
ok, err = refused("a_spot_eth", {"a_spot_eth": 100}, "ETHUSDT", "OKX", "現貨")
check(ok and ("spot", "ETHUSDT") in CALLS, f"Type A spot: judged against the spot list ({err})")
bind(OKX)
check(saved({"a_amzn": 0})[0], "Type A picked at 0: saves (nothing trades)")
ok, err = refused("a_amzn", {"a_amzn": 100}, "AMZN")
check(ok, f"picked at 0, then funded: refused at the funding save ({err})")

# ── allowed ─────────────────────────────────────────────────────────────────
for name in ("c_ok", "a_amznusdt", "a_spot_btc", "c_nostate", "a_nosym"):
    bind(OKX)
    ok, err = saved({name: 100})
    check(ok, f"{name}: saves on OKX ({err})")

bind(OKX)
MODE["down"] = True
ok, err = saved({"c_xaut": 500, "a_amzn": 100})
MODE["down"] = False
check(ok, f"the exchange's list cannot be read: not judged, saves ({err})")

for lines, label in ((PAPER, "paper"), ("", "no venue bound")):
    bind(lines)
    CALLS.clear()
    ok, err = saved({"c_xaut": 500, "a_amzn": 100})
    check(ok and not CALLS, f"{label}: not judged, saves ({err})")

bind(OKX)
LISTED["swap"].add("XAUTUSDT")
check(saved({"c_xaut": 500})[0], "funded while XAUTUSDT was listed")
LISTED["swap"].discard("XAUTUSDT")
CALLS.clear()
ok, err = saved({"c_xaut": 800})
check(ok and not CALLS, f"already funded, delisted since: saves and is not re-read ({err})")
ok, err = refused("a_amzn", {"c_xaut": 800, "a_amzn": 100}, "AMZN")
check(ok, f"a newly funded member beside an already-funded one is still judged ({err})")

# Bybit renames Binance stock perps (lib/stock_perps): Binance unreadable → not judged
bind(BYBIT)
BINANCE["rows"] = None
CALLS.clear()
ok, err = saved({"a_amzn": 100})
check(ok and not CALLS, f"Bybit with Binance's list unreadable: not judged, saves ({err})")
BINANCE["rows"] = {"BTCUSDT": ("COIN", "BTC")}
bind(BYBIT)
ok, err = refused("a_amzn", {"a_amzn": 100}, "AMZN", "Bybit")
check(ok, f"Bybit with Binance readable: an unlisted SYMBOL is refused ({err})")

# Bybit's lib sends BTC-USDT as is (symbol invalid); the reconciler orders BTCUSDT
bind(BYBIT)
CALLS.clear()
ok, err = saved({"a_dash": 100, "c_dash": 100})
check(ok and CALLS and all("-" not in s for _, s in CALLS),
      f"Bybit: BTC-USDT (Type A SYMBOL, Type C key) is judged as BTCUSDT and saves ({err}, {CALLS})")

# one budget for the whole save: two strategies on a venue slower than it
bind(OKX)
t0 = time.monotonic()
ok, err = saved({"a_slow1": 100, "a_slow2": 100})
took = time.monotonic() - t0
check(ok and took < cl._VENUE_SYMBOL_BUDGET_S + 1.5 < SLOW_S,
      f"a lookup slower than the budget: the save returns in {took:.1f}s (budget {cl._VENUE_SYMBOL_BUDGET_S}s, "
      f"shared by both) and saves ({err})")

print("all checks passed" if not fails else f"FAILED: {fails}")
sys.exit(1 if fails else 0)
