"""Type C (portfolio) strategies trade live (Wei 2026-09-23).

A Type C live tick writes {SYMBOL: weight} + the rebalance bar they began on
(lib/runner.typec_live_state); lib/portfolio.aggregate_portfolio turns each
asset into amount × weight on its own key, netting with every other strategy.
The order path is the real one (lib.venue_wiring + lib.order_binance's own
quantization); only the network is stubbed. Every number is made up.

  (1) three assets, two rebalances — targets move only at a rebalance, an asset
      that drops out closes only Blave's share, a manual position is untouched;
  (2) netting with a single-symbol strategy on the same coin;
  (3) spot: a negative weight is clamped to 0 per strategy;
  (4) an old Type C state (no weights) is "no live target yet";
  (5) at a rebalance bar the live weights equal the backtest's;
  (6) resume_wait: a portfolio waits for its next rebalance.
  (7) runtime: funding a portfolio is accepted only beside a lib that trades it;
  (8) the report forwards validated weights, and the desktop's targets read them.

Run: cd blave-agent && .venv/bin/python tests/check_typec_live.py
"""
import json
import os
import sys
import tempfile
import time

import numpy as np
import pandas as pd

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WS = tempfile.mkdtemp(prefix="typec-")
os.environ["BLAVE_AGENT_HOME"] = os.environ["BLAVECLAW_HOME"] = WS
os.environ["BLAVE_AGENT_BASE"] = WS
os.environ["BLAVE_AGENT_WORKSPACE"] = WS
os.environ.pop("BLAVE_AGENT_LOCAL", None)
for d in ("manager", "state", "strategies", "lib"):
    os.makedirs(os.path.join(WS, d), exist_ok=True)
sys.path.insert(0, ROOT)
sys.path.insert(0, os.path.join(ROOT, "runtime"))


def _no_real_env(event, args):
    if event == "open" and os.path.abspath(str(args[0])) == os.path.join(ROOT, ".env"):
        raise PermissionError("the repo .env must never be read by a test")


sys.addaudithook(_no_real_env)
os.chdir(WS)

from lib import portfolio, venue_wiring  # noqa: E402
from lib.runner import typec_live_state  # noqa: E402
import lib.order_binance as ob  # noqa: E402
import lib.account_binance as ab  # noqa: E402

portfolio._notify_best_effort = lambda msg: None
portfolio._record_order_error = lambda *a, **k: None

fails = 0


def check(cond, msg):
    global fails
    print(("ok   " if cond else "FAIL ") + msg)
    fails += 0 if cond else 1


MARK = {"BTCUSDT": 50000.0, "ETHUSDT": 2000.0, "SOLUSDT": 100.0}
STEP = {"BTCUSDT": "0.001", "ETHUSDT": "0.01", "SOLUSDT": "0.1"}
POS, SENT = [], []
venue_wiring.read_env = lambda path=".env": {"BINANCE_API_KEY": "k", "BINANCE_SECRET_KEY": "k"}
venue_wiring.detect_venue = lambda env: "binance"
ob.get_contract_rules = lambda env, sym: {"step": STEP[sym], "min_qty": float(STEP[sym]),
                                          "min_notional": 1.0, "contract_value": 1,
                                          "price_tick": "0.1", "active": True}
ob.get_mark_price = lambda env, sym: MARK[sym]


def _fill(sym, side, qty, reduce_only):
    SENT.append((sym, side, round(float(qty), 8), reduce_only))
    # the fill lands on the account, as a venue would
    held = {p["symbol"]: (1 if p["side"] == "long" else -1) * p["size"] for p in POS}
    sign = (-1 if side == "long" else 1) if reduce_only else (1 if side == "long" else -1)
    held[sym] = round(held.get(sym, 0.0) + sign * float(qty), 8)
    hold(**held)
    return {"executed_qty": float(qty), "avg_price": MARK[sym], "status": "filled"}


ob.place_market_order = lambda env, sym, direction, qty, client_order_id=None, reduce_only=False: \
    _fill(sym, direction, qty, reduce_only)
ab.get_positions = lambda env: [dict(r) for r in POS]


def hold(**rows):
    POS[:] = [{"symbol": s, "side": "long" if q > 0 else "short", "size": abs(q),
               "mark_price": MARK[s]} for s, q in rows.items() if q]


def held():
    return {p["symbol"]: (1 if p["side"] == "long" else -1) * p["size"] for p in POS}


CFG, SEED, ORDERS = "manager/portfolio_config.json", "manager/ledger_seed.json", "manager/orders.jsonl"


def strategy(name, market="swap", state=None):
    os.makedirs(f"strategies/{name}", exist_ok=True)
    open(f"strategies/{name}/strategy.py", "w").write(f'MARKET = "{market}"\n')
    if state is not None:
        json.dump(state, open(f"strategies/{name}/state.json", "w"))


def portfolio_state(weights, rebalance_at, market="swap"):
    return {"type": "portfolio", "market": market, "weights": weights,
            "rebalance_at": rebalance_at, "bar_at": rebalance_at, "updated_at": int(time.time())}


def fresh(config):
    for p in (SEED, ORDERS, "manager/last_reconcile.json", "state/signal_gate.json"):
        if os.path.exists(p):
            os.remove(p)
    json.dump(config, open(CFG, "w"))
    json.dump({"seeded_at": "2026-09-01T00:00:00", "own_only_basis": 1, "symbols": {}}, open(SEED, "w"))
    del SENT[:]


def rnd():
    def place(symbol, diff, spec=None, **kw):
        kw.pop("contributors", None)
        return venue_wiring.auto_place_order(symbol, diff, spec, **kw)
    portfolio.reconcile(get_positions_fn=venue_wiring.auto_get_positions, place_order_fn=place,
                        threshold=10)


# (1) ────────────────────────────────────────────────────────────────────────
print("== (1) three assets, two rebalances")
fresh({"amounts": {"basket": 1000}, "exchanges": {"basket": "binance"}})
strategy("basket", state=portfolio_state({"BTCUSDT": 0.5, "ETHUSDT": 0.3, "SOLUSDT": 0.2}, 1790000000))
hold(SOLUSDT=5.0)  # the user's own SOL
rnd()
check(sorted(SENT) == [("BTCUSDT", "long", 0.01, False), ("ETHUSDT", "long", 0.15, False),
                       ("SOLUSDT", "long", 2.0, False)],
      f"first rebalance: $500 / $300 / $200 bought, on top of the user's 5 SOL ({SENT})")
MARK.update(BTCUSDT=55000.0, SOLUSDT=90.0)
del SENT[:]
rnd()
check(SENT == [], f"prices move, weights don't (no rebalance): nothing traded ({SENT})")
strategy("basket", state=portfolio_state({"BTCUSDT": 0.6, "ETHUSDT": 0.4}, 1790604800))
del SENT[:]
rnd()
got = sorted(SENT)
check(("SOLUSDT", "long", 2.0, True) in got and not [s for s in got if s[0] == "SOLUSDT" and s[2] != 2.0],
      f"second rebalance, SOL drops out: only Blave's 2 SOL close, reduce-only ({got})")
check(abs(held().get("SOLUSDT", 0) - 5.0) < 1e-9,
      f"…the user's 5 SOL are still there ({held().get('SOLUSDT')})")
check([s[:2] for s in got if s[0] != "SOLUSDT"] == [("BTCUSDT", "long"), ("ETHUSDT", "long")],
      f"…BTC and ETH top up to their new weights ({got})")

# (2) ────────────────────────────────────────────────────────────────────────
print("== (2) netting with a single-symbol strategy")
fresh({"amounts": {"basket": 1000, "btc_short": 200}, "exchanges": {"basket": "binance", "btc_short": "binance"}})
strategy("btc_short", state={"symbol": "BTCUSDT", "position": -1.0, "market": "swap"})
t = portfolio.aggregate_portfolio()
check(t["BTCUSDT"]["side"] == "long" and abs(t["BTCUSDT"]["size"] - 400.0) < 1e-9
      and sorted(c["strategy"] for c in t["BTCUSDT"]["contributors"]) == ["basket", "btc_short"],
      f"BTC: basket 0.6 × 1000 = +600, btc_short −200 → one net target of +400 ({t['BTCUSDT']['size']})")
os.remove("strategies/btc_short/state.json")

# (3) ────────────────────────────────────────────────────────────────────────
print("== (3) spot: a negative weight is clamped per strategy")
fresh({"amounts": {"spot_basket": 1000, "btc_spot": 100},
       "exchanges": {"spot_basket": "binance", "btc_spot": "binance"}})
strategy("spot_basket", market="spot",
         state=portfolio_state({"BTCUSDT": -0.5, "ETHUSDT": 0.5}, 1790000000, market="spot"))
strategy("btc_spot", market="spot", state={"symbol": "BTCUSDT", "position": 1.0, "market": "spot"})
t = portfolio.aggregate_portfolio()
check(abs(t["BTCUSDT@spot"]["size"] - 100.0) < 1e-9 and t["BTCUSDT@spot"]["side"] == "long"
      and abs(t["ETHUSDT@spot"]["size"] - 500.0) < 1e-9,
      f"spot basket's −0.5 BTC is 0, not −500 cancelling btc_spot's +100 ({t['BTCUSDT@spot']['size']})")
for n in ("spot_basket", "btc_spot"):
    os.remove(f"strategies/{n}/state.json")

# (4) ────────────────────────────────────────────────────────────────────────
print("== (4) an old Type C state: no live target yet")
fresh({"amounts": {"basket": 1000}, "exchanges": {"basket": "binance"}})
strategy("basket", state={"updated_at": 1789000000})  # pre-live: no weights, no symbol
t = portfolio.aggregate_portfolio()
check(t == {} and portfolio._funded_states_unreadable(json.load(open(CFG))) == [],
      f"no target (not flat, not an error) and it doesn't hold a migration ({t})")

# (5) ────────────────────────────────────────────────────────────────────────
print("== (5) live weights == backtest weights at a rebalance bar")


def rebalance_mask(idx, freq="W"):
    s = pd.Series(idx.to_period(freq), index=idx)
    return (s != s.shift(1)).to_numpy()


def compute(close_df, lookback=5, top=2):
    """Top-2 momentum, equal weight, weekly — the TEMPLATE_C recipe."""
    sig = close_df.pct_change(lookback, fill_method=None)
    rank = sig.rank(axis=1, ascending=False, method="first", na_option="bottom")
    w = pd.DataFrame(np.where((rank <= top) & sig.notna(), 1 / top, 0.0),
                     index=close_df.index, columns=close_df.columns)
    w[sig.isna().all(axis=1)] = 0.0
    w[~rebalance_mask(close_df.index)] = np.nan
    w = w.ffill().fillna(0.0)
    price_df = pd.concat({"close": close_df, "open": close_df}, axis=1)
    return w.to_numpy(), price_df


rng = np.random.default_rng(7)
idx = pd.date_range("2026-01-01", periods=90, freq="D")
close = pd.DataFrame(100 * np.exp(np.cumsum(rng.normal(0, 0.02, (90, 3)), axis=0)),
                     index=idx, columns=["BTC-USDT", "ETH-USDT", "SOL-USDT"])
W_full, _ = compute(close)
mask = rebalance_mask(idx)
same, marker, checked = True, True, 0
for t_ in range(10, 90):
    W_t, pdf_t = compute(close.iloc[:t_ + 1])  # what a live tick at bar t_ sees
    live = typec_live_state(W_t, pdf_t, now=0)
    want = dict(zip(["BTCUSDT", "ETHUSDT", "SOLUSDT"], W_full[t_]))
    same &= all(abs(live["weights"][k] - want[k]) < 1e-12 for k in want)
    last_rb = max(i for i in range(t_ + 1) if mask[i])
    # the row began at the last rebalance bar — or earlier, when that rebalance kept the weights
    marker &= live["rebalance_at"] <= int(idx[last_rb].timestamp())
    checked += 1 if mask[t_] else 0
check(same and checked >= 10,
      f"every bar (incl. {checked} rebalance bars): the live tick's weights are the backtest's row")
check(marker, "…and rebalance_at never runs ahead of the last rebalance bar")
live = typec_live_state(W_full[:40], pd.concat({"close": close.iloc[:40]}, axis=1), now=0)
rb = [i for i in range(40) if mask[i]][-1]
check(live["rebalance_at"] <= int(idx[rb].timestamp()) and live["bar_at"] == int(idx[39].timestamp()),
      f"between rebalances: the marker stays on the rebalance bar, bar_at moves ({live['rebalance_at']})")

# (6) ────────────────────────────────────────────────────────────────────────
print("== (6) resume_wait: a portfolio waits for its next rebalance")
import command_listener as cl  # noqa: E402
fresh({"amounts": {"basket": 1000}, "exchanges": {"basket": "binance"}})
strategy("basket", state=portfolio_state({"BTCUSDT": 0.6, "ETHUSDT": 0.4}, 1790604800))
open("state/HALT", "w").write("{}")
cl._cmd_resume_wait({})
gate = json.load(open("state/signal_gate.json"))
check(gate == {"basket": 1790604800.0}, f"the start records the rebalance bar, not a position ({gate})")
t = portfolio.aggregate_portfolio()
check(all(v["gated"] for v in t.values()), "…same rebalance: every asset of the basket waits")
strategy("basket", state=portfolio_state({"BTCUSDT": 0.5, "ETHUSDT": 0.5}, 1791209600))
t = portfolio.aggregate_portfolio()
check(not any(v["gated"] for v in t.values()) and "basket" not in portfolio._load_signal_gate(),
      "…the next rebalance lifts it for good")

# (7) ────────────────────────────────────────────────────────────────────────
print("== (7) funding a portfolio waits for a lib that trades it")
import portfolio_reporter as pr  # noqa: E402
cl._sync_strategy_crons = lambda *a, **k: None
cl._strategy_has_interval = lambda n: True
cl._strategy_is_portfolio = lambda n: n == "basket"
for runner_src, agg_src, ok_ in (("# old runner\n", "# old portfolio\n", False),
                                 ("def typec_live_state(\n", "# Type C (lib/runner.typec_live_state)\n", True)):
    open(os.path.join(WS, "lib", "runner.py"), "w").write(runner_src)
    open(os.path.join(WS, "lib", "portfolio.py"), "w").write(agg_src)
    json.dump({"amounts": {}, "exchanges": {}}, open(CFG, "w"))
    err = None
    try:
        cl._cmd_amounts({"amounts": {"basket": 500}})
    except ValueError as e:
        err = str(e)
    if ok_:
        check(pr.can_trade_portfolio() and err is None
              and json.load(open(CFG))["amounts"].get("basket") == 500.0,
              f"a lib that trades portfolios: funding one is accepted, the report says so ({err})")
    else:
        check(not pr.can_trade_portfolio() and err and "更新 blave agent" in err,
              f"an older lib: funding a portfolio is refused, and says to update ({err})")
with open(os.path.join(ROOT, "lib", "runner.py"), encoding="utf-8") as f:
    r_src = f.read()
with open(os.path.join(ROOT, "lib", "portfolio.py"), encoding="utf-8") as f:
    p_src = f.read()
check("def typec_live_state(" in r_src and "Type C (lib/runner.typec_live_state)" in p_src,
      "the real lib carries both strings the runtime looks for")

# (8) ────────────────────────────────────────────────────────────────────────
print("== (8) the report carries the weights; the desktop's targets read them")
import subprocess  # noqa: E402
W, pdf = compute(close.iloc[:60])
strategy("basket", state=typec_live_state(W, pdf, market="swap"))
json.dump({"amounts": {"basket": 1000}, "exchanges": {"basket": "binance"}}, open(CFG, "w"))
st = pr.strategy_states()["basket"]
check(st.get("type") == "portfolio" and set(st.get("weights") or {}) <= {"BTCUSDT", "ETHUSDT", "SOLUSDT"}
      and isinstance(st.get("rebalance_at"), int) and st.get("market") == "swap",
      f"reporter: a Type C state is forwarded with type, weights, rebalance_at ({st})")
strategy("basket", state=portfolio_state({"BTC-USDT": 0.5, "ETHUSDT": 0.3, "SOLUSDT": 0.2, "BAD SYM": 0.1,
                                          "NANUSDT": float("nan"), "STRUSDT": "x", "ZEROUSDT": 0}, 1790000000))
st = pr.strategy_states()["basket"]
check(st["weights"] == {"BTCUSDT": 0.5, "ETHUSDT": 0.3, "SOLUSDT": 0.2},
      f"…validated: canonical keys, finite floats only, zero / malformed dropped ({st['weights']})")
many = {f"C{i:03d}USDT": 1 / 300 for i in range(300)}
many["BIGUSDT"] = 0.2
strategy("basket", state=portfolio_state(many, 1790000000))
big = pr.strategy_states()["basket"]["weights"]
check(len(big) == pr.PORTFOLIO_WEIGHTS_MAX and big.get("BIGUSDT") == 0.2,
      f"…capped at {pr.PORTFOLIO_WEIGHTS_MAX} symbols, largest weights kept ({len(big)})")
strategy("basket", state=portfolio_state({"BTCUSDT": 0.5, "ETHUSDT": 0.3, "SOLUSDT": 0.2}, 1790000000))
strategy("single", state={"symbol": "BTCUSDT", "position": 1.0})
report_states = json.loads(json.dumps(pr.strategy_states()))  # the wire
check("weights" not in report_states["single"] and "type" not in report_states["single"],
      "…a single-symbol state is forwarded as before")
js = r"""
const fs = require("fs"), src = fs.readFileSync(process.env.TRADE_JS, "utf8");
const a = src.indexOf("/* ── 純邏輯("), b = src.indexOf("/* ── 純邏輯到此");
eval(src.slice(a, b).replace(/^const /gm, "var "));
const states = JSON.parse(fs.readFileSync(0, "utf8"));
process.stdout.write(JSON.stringify(trClientTargets({ basket: 1000 }, states)));
"""
r = subprocess.run(["node", "-e", js], input=json.dumps(report_states), capture_output=True, text=True,
                   timeout=30, env={**os.environ, "TRADE_JS": os.path.join(ROOT, "shell", "renderer", "trade.js")})
tg = json.loads(r.stdout or "{}")
check(r.returncode == 0 and tg == {"BTCUSDT": 500, "ETHUSDT": 300, "SOLUSDT": 200},
      f"desktop trClientTargets on that report: three targets, 500 / 300 / 200 ({tg or r.stderr[-200:]})")

print("\n" + ("all ok" if not fails else f"{fails} FAILED"))
sys.exit(1 if fails else 0)
