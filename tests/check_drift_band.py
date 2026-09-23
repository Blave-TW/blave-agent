"""Position drift, fix A′ — no network, no daemon.

What it protects (measured 2026-09-21 on uid 29026: a 20,000 paper position
with an unchanged signal, 34 fills in 4h44m with self_ledger off, 0 with it
on): in account-read mode target is a fixed notional and actual is size × mark,
so the mark alone opens a "gap" every heartbeat.

Asserts:
  (a) a config WITHOUT the self_ledger key (every pre-existing machine) still
      diffs against the account read — the mark still rebalances it past the
      band, no baseline is required, the snapshot carries no ledger; `false`
      behaves the same; only `true` is the book (and refuses without a seed);
  (b) a same-side drift inside max(5%, 2σ) of the target places nothing and is
      recorded with `band_usd`; past the band it trades; σ widens the band, is
      read once a day (failures included), and a spot key resolves its symbol;
  (c) target flat, strategy removed, or a flip: the whole-position close goes
      out regardless of how wide the band is;
  (d) futures_contracts and shares rows never see the currency gate or the
      band, ask for no σ, and the crypto auto-wire refuses to size them;
  (e) a machine's first portfolio_config.json is born with self_ledger on and
      its ledger_seed.json written first; an existing config without the key
      is left without it; a baseline already on disk is kept.
  (f) the paper venue books a futures_contracts row in whole lots (round
      half-up, half a lot places nothing, reduce legs cap at the held lots,
      PnL = lots × contract_value × Δprice, the account row reports lots with
      unit "contracts" so a removed strategy still closes in lots); a spec
      without contract_value is an order error, never a guessed value;
  (B2) with the book on, a same-side +3% signal change is an order (no band).

Run: cd blave-agent && .venv/bin/python tests/check_drift_band.py
"""
import json, os, re, sys, tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
WS = tempfile.mkdtemp(prefix="driftband-")
os.chdir(WS)
os.makedirs("manager", exist_ok=True)
open("manager/portfolio_config.json", "w").write("{}")   # (a): no self_ledger key at all

from lib import portfolio, venue_wiring  # noqa: E402
from manager import reconciler  # noqa: E402

fails = 0


def check(cond, msg):
    global fails
    print(("ok   " if cond else "FAIL ") + msg)
    fails += 0 if cond else 1


SYM, SPOT = "BTCUSDT", "BTCUSDT@spot"
MARK = 78312.0
TARGET = 20000.0


class _FakeOrder:
    rules = {"step": 0.001, "min_qty": 0.001, "min_notional": 5.0, "contract_value": 1}

    def get_contract_rules(self, env, sym):
        return self.rules

    def get_mark_price(self, env, sym):
        return MARK


sys.modules["lib.order_binance"] = _FakeOrder()
venue_wiring.read_env = lambda path=".env": {"BINANCE_API_KEY": "k"}
venue_wiring.detect_venue = lambda env: "binance"
portfolio._record_order_error = lambda s, x, e: None

sigma_calls = []
sigma_value = [None]


def fake_sigma(symbol):
    sigma_calls.append(symbol)
    if isinstance(sigma_value[0], Exception):
        raise sigma_value[0]
    return sigma_value[0]


real_daily_sigma = portfolio._daily_sigma
portfolio._daily_sigma = fake_sigma


def reset_sigma(value=None):
    sigma_value[0] = value
    del sigma_calls[:]
    try:
        os.remove(portfolio._DRIFT_BAND_PATH)
    except OSError:
        pass


def run(target_usd, held_usd, asset_spec=None, exchange=None, key=SYM, config=None):
    """One reconcile round against a stubbed target/position → (legs that
    reached place_order_fn, the snapshot's gates row, error string or None)."""
    reconciler._min_order_gate.clear()
    if config is not None:
        json.dump(config, open("manager/portfolio_config.json", "w"))
    target = {} if target_usd is None else {
        key: {"side": "long" if target_usd >= 0 else "short", "size": abs(target_usd),
              "exchange": exchange, "asset_spec": asset_spec, "contributors": []}}
    actual = {} if not held_usd else {
        key: {"side": "long" if held_usd >= 0 else "short", "size": abs(held_usd)}}
    if exchange == "capital" and held_usd:
        actual[key]["exchange"] = "capital"
    portfolio.aggregate_portfolio = lambda: target
    placed = []
    err = None
    try:
        portfolio.reconcile(get_positions_fn=lambda: actual,
                            place_order_fn=lambda s, d, spec, **kw: placed.append(round(d, 2)),
                            threshold=reconciler._symbol_threshold)
    except Exception as e:
        err = f"{type(e).__name__}: {e}"
    try:
        with open("manager/last_reconcile.json") as f:
            snap = json.load(f)
    except OSError:
        snap = {}
    return placed, (snap.get("gates") or {}).get(key), err, snap


# ── (a) an old config keeps today's mode ────────────────────────────────────
print("== (a) no self_ledger key → account-read mode, as today")
reset_sigma()
legs, gate, err, snap = run(TARGET, TARGET * 1.20)
check(legs == [-4000.0] and err is None,
      "no key: a +20% mark move is rebalanced to the fixed notional (account-read)")
check("ledger" not in snap, "no key: the snapshot carries no ledger — the book is not in play")
check(not os.path.exists("manager/ledger_seed.json"),
      "no key: no baseline was needed or written")
legs_f, _, err_f, snap_f = run(TARGET, TARGET * 1.20, config={"self_ledger": False})
check(legs_f == legs and err_f is None and "ledger" not in snap_f,
      "self_ledger: false behaves exactly like the missing key")
legs_t, _, err_t, _ = run(TARGET, TARGET * 1.20, config={"self_ledger": True})
check(legs_t == [] and err_t and "ledger_seed" in err_t,
      "self_ledger: true is the only switch — and refuses to trade without a baseline")
json.dump({}, open("manager/portfolio_config.json", "w"))

# ── (b) the band ─────────────────────────────────────────────────────────────
print("== (b) drift inside max(5%, 2σ) of the target is left alone")
reset_sigma()
legs, gate, err, _ = run(TARGET, TARGET * 1.03)
check(legs == [] and err is None, "+3% drift (σ unavailable → 5% floor): no order")
check(gate and abs(gate["band_usd"] - 1000.0) < 1e-6 and abs(gate["usd"] - 1000.0) < 1e-6
      and gate.get("side") == "reduce",
      f"...recorded: band_usd 1000 = 5% × target, usd carries it, side reduce ({gate})")
legs, gate, err, _ = run(TARGET, TARGET * 0.97)
check(legs == [] and "side" not in gate and abs(gate["band_usd"] - 1000.0) < 1e-6,
      "-3% drift: no order, recorded on the entry side with the same band")
legs, _, _, _ = run(TARGET, TARGET * 1.06)
check(legs == [-1200.0], "+6% drift: past the 5% band, the reduce goes out (today's behaviour)")
legs, _, _, _ = run(TARGET, TARGET * 0.94)
check(legs == [1200.0], "-6% drift: past the band, the top-up goes out")
legs, _, _, _ = run(-TARGET, -TARGET * 1.03)
check(legs == [], "a short drifting +3% against the trader is left alone too")

reset_sigma(0.04)
legs, gate, _, _ = run(TARGET, TARGET * 1.07)
check(legs == [] and abs(gate["band_usd"] - 1600.0) < 1e-6,
      "σ = 4%/day: the band is 2σ = 8%, a +7% drift is inside it")
legs, _, _, _ = run(TARGET, TARGET * 1.09)
check(legs == [-1800.0], "...and +9% is outside it")
check(sigma_calls == [SYM],
      f"σ was fetched once for two rounds (cached a day), not per round ({sigma_calls})")
reset_sigma(0.01)
legs, gate, _, _ = run(TARGET, TARGET * 1.04)
check(legs == [] and abs(gate["band_usd"] - 1000.0) < 1e-6, "σ = 1%: 2σ is under the 5% floor — the floor holds")
reset_sigma(0.50)
legs, gate, _, _ = run(TARGET, TARGET * 1.19)
legs2, _, _, _ = run(TARGET, TARGET * 1.21)
check(legs == [] and abs(gate["band_usd"] - 4000.0) < 1e-6 and legs2 == [-4200.0],
      "σ = 50%: 2σ is capped at 20% — +19% stays, +21% trades")
# σ itself: today's still-forming bar is not a daily return. dotenv_values()
# resolves .env from the lib's own directory, so the key is stubbed, not written.
import dotenv  # noqa: E402
import pandas as pd  # noqa: E402
from lib import data  # noqa: E402
dotenv.dotenv_values = lambda *a, **k: {"blave_api_key": "k"}
closes = [100.0] * 31 + [150.0]   # 30 flat daily returns, then a half-day +50% spike
data.fetch_kline = lambda *a, **k: pd.DataFrame({"Close": closes})
check(real_daily_sigma(SYM) == 0.0,
      "σ drops the last (forming) bar: 30 flat closes + today's spike → σ 0, not > 0")
data.fetch_kline = lambda *a, **k: pd.DataFrame({"Close": [100.0] * 10})
check(real_daily_sigma(SYM) is None, "too few bars → None (the floor)")
dotenv.dotenv_values = lambda *a, **k: {}
data.fetch_kline = lambda *a, **k: (_ for _ in ()).throw(AssertionError("network"))
check(real_daily_sigma(SYM) is None, "no Blave key in .env → None without touching the kline feed")
# F2: the lookup runs inside a reconcile round, so it may not sit through the
# default 6-retry backoff (~2 min > the 300s heartbeat the web reads as dead)
dotenv.dotenv_values = lambda *a, **k: {"blave_api_key": "k"}
seen = {}
data.fetch_kline = lambda *a, **k: seen.update(k) or pd.DataFrame({"Close": [100.0] * 40})
real_daily_sigma(SYM)
check(seen.get("max_retries") == 2, f"σ asks fetch_kline for 2 attempts, not the default 6 ({seen})")
import requests  # noqa: E402
from pathlib import Path  # noqa: E402
del sys.modules["lib.data"]; import lib.data as data  # noqa: E402,E702 — the unstubbed fetch_kline
data._CACHE_DIR = Path(WS) / "cache"  # never the repo's cache/
retries = []


def fake_retry_get(url, max_retries=6, **kw):
    retries.append(max_retries)
    resp = type("R", (), {"status_code": 503, "text": "busy"})()
    raise requests.HTTPError("503", response=resp)


data._retry_get = fake_retry_get
try:
    data.fetch_kline(SYM, "1d", "2026-08-01", "2026-09-01", {"api-key": "k"}, max_retries=2)
    raised = False
except RuntimeError:
    raised = True
check(raised and retries and set(retries) == {2},
      f"...and fetch_kline hands it down to _retry_get unchanged ({retries})")
reset_sigma(RuntimeError("no bars"))
legs, gate, err, _ = run(TARGET, TARGET * 1.04)
run(TARGET, TARGET * 1.04)
check(legs == [] and err is None and abs(gate["band_usd"] - 1000.0) < 1e-6 and len(sigma_calls) == 1,
      "σ lookup failing: the floor applies, no error, the failure is cached a day too")
reset_sigma()
legs, gate, _, _ = run(TARGET, TARGET * 1.03, key=SPOT)
check(legs == [] and gate and abs(gate["band_usd"] - 1000.0) < 1e-6 and sigma_calls == [SYM],
      "a spot key is banded too, and σ is asked for the plain symbol")
# a tiny position: the band is under the flat 10, so today's gates decide and
# nothing extra is recorded
reset_sigma()
legs, gate, _, _ = run(100, 103, key=SPOT)
check(legs == [] and gate is None, "band under the flat 10: nothing recorded, flat gate rules")

# ── (c) a whole-position close is never banded ───────────────────────────────
print("== (c) target flat / removed / flipped: the close goes out")
reset_sigma(5.0)   # 2σ = 1000% — a band no drift could ever leave
held = TARGET * 1.03
legs, _, _, _ = run(0, held)
check(legs == [-held], "target 0 closes the whole position")
legs, _, _, _ = run(None, held)
check(legs == [-held], "strategy removed (no target row) closes the whole position")
legs, _, _, _ = run(-TARGET, held)
check(legs == [-held, -TARGET], "a flip closes, then opens the other side — both legs")
legs, _, _, _ = run(TARGET, 0)
check(legs == [TARGET], "an entry from flat has nothing to drift from — it goes out")
legs, _, _, _ = run(TARGET * 1.04, TARGET)
check(legs == [], "...while a same-side +4% SIGNAL change is inside the band too (known, "
                  "documented cost of the notional path)")

# ── (d) native-unit rows: untouched, no σ asked ──────────────────────────────
print("== (d) futures_contracts / shares are not banded")
reset_sigma()
legs, gate, err, _ = run(10, 9.6, asset_spec={"type": "futures_contracts"}, exchange="capital",
                         key="TXF")
check(legs == [0.4] and gate is None and err is None,
      "a 0.4-lot diff on 10 lots (4%) still reaches place_order — no band, no gate")
legs, gate, err, _ = run(100, 97, asset_spec={"type": "shares"}, exchange="sinopac", key="2330")
check(legs == [3.0] and gate is None and err is None,
      "3 shares short of 100 (3%) still reaches place_order — shares diff in shares")
legs, _, _, _ = run(0, 100, asset_spec={"type": "shares"}, exchange="sinopac", key="2330")
check(legs == [-100.0], "shares: target 0 closes all 100")
check(sigma_calls == [], "no σ lookup was made for a native-unit row")
check(portfolio.asset_type(None) == "notional" and portfolio.asset_type({}) == "notional"
      and portfolio.native_units(None) is False and portfolio.native_units(None, "capital"),
      "a missing type is `notional`; capital rows are native by exchange label")
try:
    venue_wiring.auto_place_order("2330", 3.0, {"type": "shares"})
    refused = False
except RuntimeError as e:
    refused = "native units" in str(e)
check(refused, "the crypto auto-wire refuses to size a shares row")

# ── (f) paper + futures_contracts: lots, not notional ─────────────────────
print("== (f) paper venue books a futures_contracts row in whole lots")
import time  # noqa: E402
from lib import order_paper, paper_data  # noqa: E402
os.makedirs("strategies/txf_hold", exist_ok=True)
os.makedirs("state", exist_ok=True)
open("strategies/txf_hold/strategy.py", "w").write('''MODE = "live"
STRATEGY_NAME = "txf_hold"
SYMBOL = "TXF"
INTERVAL = "1m"


def fetch_data(hdrs):
    import pandas as pd
    px = float(open("state/mark.txt").read())
    end = pd.Timestamp.now(tz="UTC").tz_localize(None).floor("min")
    idx = pd.date_range(end=end, periods=5, freq="min")
    return pd.DataFrame({"Open": px, "High": px, "Low": px, "Close": px, "Volume": 1.0}, index=idx)


def compute_signals(df):
    import pandas as pd
    return pd.Series(1.0, index=df.index)
''')
PAPER_ENV = {"PAPER_API_KEY": "paper", "PAPER_SECRET_KEY": "paper",
             "PAPER_BOUND_TS": str(int(time.time())), "PAPER_INITIAL_EQUITY": "5000000"}
venue_wiring.read_env = lambda path=".env": dict(PAPER_ENV)
venue_wiring.detect_venue = lambda env: "paper"
TXF_SPEC = {"type": "futures_contracts", "contract_value": 200, "currency": "TWD", "lot_size": 1,
            "margin": 701000}
order_errors = []
portfolio._record_order_error = lambda s, x, e: order_errors.append(str(e))


def set_mark(px):
    open("state/mark.txt", "w").write(str(px))
    paper_data._price_cache.clear()


def paper_round(target_lots, spec=TXF_SPEC):
    """One real reconcile round on the paper venue (auto_get_positions →
    dispatch_order → order_paper) → (legs that reached place_order, snapshot
    position row or None, fills this round)."""
    reconciler._min_order_gate.clear()
    del order_errors[:]
    portfolio.aggregate_portfolio = lambda: {} if target_lots is None else {
        "TXF": {"side": "long" if target_lots > 0 else "short", "size": abs(target_lots),
                "exchange": "paper", "asset_spec": spec, "contributors": []}}
    before = len(order_paper.snapshot(PAPER_ENV)["fills"])
    legs = []

    def place(symbol, d, spec_, **kw):
        legs.append((round(d, 2), kw.get("reduce_only")))
        return reconciler.place_order(symbol, d, asset_spec=spec_, **kw)

    portfolio.reconcile(get_positions_fn=reconciler.get_positions, place_order_fn=place,
                        threshold=reconciler._symbol_threshold)
    snap = order_paper.snapshot(PAPER_ENV)
    pos = next((p for p in snap["positions"] if p["symbol"] == "TXF"), None)
    return legs, pos, [(f["side"], f["qty"], f["price"]) for f in snap["fills"][before:]]


set_mark(20000)
legs, pos, fills = paper_round(2)
check(legs == [(2.0, False)] and fills == [("buy", 2.0, 20000.0)]
      and pos and pos["size"] == 2.0 and pos.get("unit") == "contracts" and pos["contract_value"] == 200,
      f"target 2 lots, flat: buys 2 lots at the mark, position row is 2 CONTRACTS ({pos})")
cash_after_entry = order_paper.snapshot(PAPER_ENV)["cash"]
set_mark(22000)
legs, pos, fills = paper_round(2)
check(legs == [] and fills == [] and pos["size"] == 2.0,
      "mark +10%, target still 2 lots: nothing placed — lots do not drift with the index")
actual = reconciler.get_positions()
check(actual.get("TXF", {}).get("size") == 2.0 and actual["TXF"].get("unit") == "contracts",
      f"auto_get_positions reports 2 (lots), not 2 × mark ({actual.get('TXF')})")
legs, pos, fills = paper_round(2.4)
check(legs == [(0.4, False)] and fills == [] and pos["size"] == 2.0,
      "diff 0.4 lot reaches place_order (no currency gate) and rounds to nothing")
legs, pos, fills = paper_round(2.6)
check(legs == [(0.6, False)] and fills == [("buy", 1.0, 22000.0)] and pos["size"] == 3.0,
      "diff 0.6 lot rounds half-up to ONE lot")
legs, pos, fills = paper_round(-1)
check(legs == [(-3.0, True), (-1.0, False)] and [f[:2] for f in fills] == [("sell", 3.0), ("sell", 1.0)]
      and pos["side"] == "short" and pos["size"] == 1.0,
      f"flip: closes the 3 lots reduce-only, then opens 1 short ({legs} {fills})")
legs, pos, fills = paper_round(0)
check(legs == [(1.0, True)] and fills == [("buy", 1.0, 22000.0)] and pos is None,
      "target 0: the whole short is bought back, position gone")
cash = order_paper.snapshot(PAPER_ENV)["cash"]
# 2 lots bought at 20000, 3 sold at 22000 (2 × 2000 × 200 = 800,000 realized), rest flat
# 800,000 realized less taker fees (0.05% of lots × price × 200 on each leg ≈ 13k)
check(780000 < cash - cash_after_entry < 800000,
      f"PnL is lots × contract_value × Δprice: cash {cash_after_entry:.0f} → {cash:.0f}")
legs, pos, fills = paper_round(2, spec={"type": "futures_contracts"})
check(legs == [(2.0, False)] and fills == [] and pos is None and order_errors
      and "contract_value" in order_errors[0],
      f"spec without contract_value: refused as an order error, nothing booked ({order_errors})")
legs, pos, fills = paper_round(2)
check(fills == [("buy", 2.0, 22000.0)], "…with the value present it trades again")
legs, pos, fills = paper_round(None)
check(legs == [(-2.0, True)] and pos is None,
      "strategy removed (no target, no asset_spec): the account row's unit still closes it in lots")
# T1: the two mutations the first cut did not bite on
paper_round(3)
r = order_paper.place_contract_market_order(PAPER_ENV, "TXF", "long", 5, 200, reduce_only=True)
pos_after = next((p for p in order_paper.snapshot(PAPER_ENV)["positions"] if p["symbol"] == "TXF"), None)
check(r["executed_qty"] == 3.0 and pos_after is None,
      "3 lots held, reduce_only 5 lots: fills 3 and stops flat — never flips through zero")
paper_round(2)
legs, pos, fills = paper_round(2.5)
check(legs == [(0.5, False)] and [f[:2] for f in fills] == [("buy", 1.0)] and pos["size"] == 3.0,
      "diff exactly 0.5 lot rounds half-UP to one lot (floor(x + 0.5), not banker's round)")
paper_round(0)
# W1: leverage on contract lots is margin-based, judged apart from notional
no_margin = {k: v for k, v in TXF_SPEC.items() if k != "margin"}
legs, pos, fills = paper_round(2, spec=no_margin)
check(fills == [] and pos is None and order_errors and "margin" in order_errors[0],
      f"spec without margin: entry refused as an order error ({order_errors})")
POOR = dict(PAPER_ENV, PAPER_INITIAL_EQUITY="100000", PAPER_BOUND_TS=str(int(time.time()) + 5))
venue_wiring.read_env = lambda path=".env": dict(POOR)


def refused(*a, **k):
    try:
        order_paper.place_contract_market_order(*a, **k)
        return None
    except order_paper.PaperError as e:
        return str(e)


lev = refused(POOR, "TXF", "long", 1, 200, margin=701000)
check(lev and "contract margin 701000 exceeds paper equity" in lev,
      f"1×: one TX lot (701,000 margin) on 100,000 equity is refused on margin ({lev})")
# TMF-sized margin on the priced symbol: 2 × 35,050 fits, a third lot does not
check(order_paper.place_contract_market_order(POOR, "TXF", "long", 2, 200, margin=35050)["executed_qty"] == 2.0
      and order_paper.snapshot(POOR)["positions"][0]["margin"] == 35050.0,
      "…2 lots at 35,050 margin (70,100 ≤ 100,000) open, and the position carries its margin")
lev = refused(POOR, "TXF", "long", 1, 200, margin=35050)
check(lev and "contract margin 105150 exceeds paper equity" in lev,
      f"…a third lot (105,150 > 100,000) is refused — 1×, not 10× ({lev})")
order_paper.place_contract_market_order(POOR, "TXF", "long", 2, 200, reduce_only=True)
venue_wiring.read_env = lambda path=".env": dict(PAPER_ENV)
order_paper.reset_account(PAPER_ENV, cash=5000000)  # POOR's newer bind stamp would otherwise keep its ledger
# default cash: 100,000 for a ledger created from now on; an existing ledger keeps its own
check(order_paper.DEFAULT_CASH == 100000.0, "DEFAULT_CASH is 100,000")
OLD_ENV = {"PAPER_API_KEY": "paper", "PAPER_SECRET_KEY": "paper", "PAPER_BOUND_TS": "1"}
old_led = order_paper._new_ledger(OLD_ENV)
old_led.update(initial_cash=10000.0, cash=10450.0, created_ts=int(time.time()))
order_paper._save(old_led)
s_old = order_paper.snapshot(OLD_ENV)
check(s_old["initial_cash"] == 10000.0 and s_old["cash"] == 10450.0,
      "an existing 10,000 ledger keeps its initial_cash and cash — the return baseline is unchanged")
FRESH_ENV = dict(OLD_ENV, PAPER_BOUND_TS=str(int(time.time()) + 10))
s_new = order_paper.snapshot(FRESH_ENV)
check(s_new["initial_cash"] == 100000.0 and s_new["cash"] == 100000.0,
      "a ledger re-seeded by a newer bind starts at 100,000")
order_paper.reset_account(PAPER_ENV, cash=5000000)
# B2: a notional TXF position from before the spec existed self-heals on the first reduce
order_paper.place_market_order(PAPER_ENV, "TXF", "long", 0.0001)
legs, pos, fills = paper_round(0)
check(legs == [(-2.2, True)] and [f[:2] for f in fills] == [("sell", 0.0001)] and pos is None
      and not order_errors,
      f"pre-spec notional TXF position, target 0: closed whole by the notional path, no error ({legs} {fills})")
# B3: the runtime's account snapshot keeps lots as lots
sys.path.insert(0, os.path.join(ROOT, "runtime"))
import account_reader  # noqa: E402
rows = account_reader._norm_positions([
    {"symbol": "TXF", "side": "long", "size": 2.0, "mark_price": 22000.0, "unit": "contracts",
     "contract_value": 200.0},
    {"symbol": "BTCUSDT", "side": "long", "size": 0.5, "mark_price": 80000.0}])
check(rows["TXF"] == {"side": "long", "size": 2.0, "unit": "contracts", "contract_value": 200.0}
      and rows["BTCUSDT"] == {"side": "long", "size": 40000.0},
      f"account_reader: a contracts row stays 2 lots, a notional row is still size × mark ({rows})")
# B1: with the book on, a removed contract strategy still closes in lots
json.dump({"self_ledger": True}, open("manager/portfolio_config.json", "w"))
json.dump({"seeded_at": "2026-01-01T00:00:00", "symbols": {}}, open("manager/ledger_seed.json", "w"))
if os.path.exists("manager/orders.jsonl"):
    os.remove("manager/orders.jsonl")
legs, pos, fills = paper_round(2)
book = portfolio.ledger_book().get("TXF")
check([f[:2] for f in fills] == [("buy", 2.0)] and book and book["qty"] == 2.0 and book["cost"] == 2.0,
      f"book mode: 2 lots bought, the book holds 2 (qty == cost, like capital) ({book})")
legs, pos, fills = paper_round(None)
check(legs == [(-2.0, True)] and [f[:2] for f in fills] == [("sell", 2.0)] and pos is None
      and portfolio.ledger_book().get("TXF") is None,
      f"book mode, strategy removed: the book row inherits unit contracts and closes 2 lots ({legs})")
os.remove("manager/orders.jsonl")
os.remove("manager/ledger_seed.json")
json.dump({}, open("manager/portfolio_config.json", "w"))
venue_wiring.detect_venue = lambda env: "binance"
venue_wiring.read_env = lambda path=".env": {"BINANCE_API_KEY": "k"}
portfolio._record_order_error = lambda s, x, e: None

# ── (B2) the book has no band: a same-side signal change trades ───────────
print("== (B2) self_ledger on: a +3% same-side signal change is an order")
json.dump({"seeded_at": "2026-01-01T00:00:00", "symbols": {}}, open("manager/ledger_seed.json", "w"))
json.dump({"self_ledger": True}, open("manager/portfolio_config.json", "w"))
reset_sigma(5.0)
reconciler._min_order_gate.clear()


def fill(symbol, d, spec, **kw):
    return {"avg_price": MARK, "executed_qty": abs(d) / MARK, "exchange": "binance"}


for tgt in (TARGET, TARGET * 1.03):
    portfolio.aggregate_portfolio = lambda t=tgt: {
        SYM: {"side": "long", "size": t, "exchange": "binance", "asset_spec": None,
              "contributors": []}}
    book_legs = []
    portfolio.reconcile(get_positions_fn=lambda: {SYM: {"side": "long", "size": TARGET}},
                        place_order_fn=lambda s, d, spec, **kw: book_legs.append(round(d, 2)) or fill(s, d, spec),
                        threshold=reconciler._symbol_threshold,
                        )
    reconciler._min_order_gate.clear()
book = portfolio.ledger_book()[SYM]
check(book_legs == [600.0] and abs(book["cost"] - TARGET * 1.03) < 0.01 and sigma_calls == [],
      f"book mode: the 600 top-up goes out (no band, no σ asked), book cost {book['cost']:.0f}")
os.remove("manager/orders.jsonl")
json.dump({}, open("manager/portfolio_config.json", "w"))

# ── (e) a new machine's first config ─────────────────────────────────────────
print("== (e) first portfolio_config.json: self_ledger on, seed written first")
WS2 = tempfile.mkdtemp(prefix="driftband-rt-")
os.environ["BLAVE_AGENT_WORKSPACE"] = WS2
os.environ.pop("BLAVE_AGENT_LOCAL", None)
sys.path.insert(0, os.path.join(ROOT, "runtime"))
import command_listener as cl  # noqa: E402

cl._sync_strategy_crons = lambda names: None
cl._strategy_has_interval = lambda n: True
cl._strategy_is_portfolio = lambda n: False
cfg_path = os.path.join(WS2, "manager", "portfolio_config.json")
seed_path = os.path.join(WS2, "manager", "ledger_seed.json")

order = []
_real_replace = os.replace
os.replace = lambda a, b: order.append(os.path.basename(b)) or _real_replace(a, b)
try:
    cl._cmd_amounts({"amounts": {"s1": 100}})
finally:
    os.replace = _real_replace
cfg = json.load(open(cfg_path))
seed = json.load(open(seed_path))
check(cfg.get("self_ledger") is True and cfg["amounts"] == {"s1": 100.0},
      "fresh machine, first amounts save: self_ledger true alongside the amounts")
check(seed.get("seeded_at") and seed.get("symbols") == {},
      f"...with a fresh-start baseline (seeded_at={seed.get('seeded_at')}, no symbols)")
check(order.index("ledger_seed.json") < order.index("portfolio_config.json"),
      f"...seed written BEFORE the config ({order})")
check(re.fullmatch(r"\d{4}-\d{2}-\d{2}T[\d:.]+", seed["seeded_at"]) is not None,
      "seeded_at is the isoformat lib/portfolio compares orders.jsonl timestamps against")

# an existing config without the key: the update must not switch it
json.dump({"amounts": {"s1": 100}, "exchanges": {"s1": ""}}, open(cfg_path, "w"))
os.remove(seed_path)
cl._cmd_amounts({"amounts": {"s1": 200}})
cfg = json.load(open(cfg_path))
check("self_ledger" not in cfg and not os.path.exists(seed_path),
      "existing config without the key: re-saving adds neither the key nor a seed")
cl._cmd_execution({"execution": {}})
check("self_ledger" not in json.load(open(cfg_path)),
      "...and an execution save on it adds neither")

# the other first-writer, and a baseline someone already wrote is kept
os.remove(cfg_path)
json.dump({"seeded_at": "2026-01-01T00:00:00", "symbols": {}}, open(seed_path, "w"))
cl._cmd_execution({"execution": {}})
cfg = json.load(open(cfg_path))
check(cfg.get("self_ledger") is True and cfg["execution"] == {},
      "fresh machine whose first save is the execution style: self_ledger true too")
check(json.load(open(seed_path))["seeded_at"] == "2026-01-01T00:00:00",
      "a baseline already on disk (hand-run seed_ledger.py) is not overwritten")

# S1: a machine that has traded but has no config is not a new machine — and
# "traded" is orders.jsonl alone. last_reconcile.json is written by every
# reconcile round, including the never-configured read-only ones, which place
# nothing: counting it made the first save come out without self_ledger and the
# next round closed the user's own positions (audit 2026-09-23 B1).
for marker, fresh in (("orders.jsonl", False), ("last_reconcile.json", True)):
    os.remove(cfg_path)
    if os.path.exists(seed_path):
        os.remove(seed_path)
    mpath = os.path.join(WS2, "manager", marker)
    open(mpath, "w").write("")
    cl._cmd_amounts({"amounts": {"s1": 100}})
    cfg = json.load(open(cfg_path))
    check((cfg.get("self_ledger") is True) == fresh and os.path.exists(seed_path) == fresh
          and cfg["amounts"] == {"s1": 100.0},
          f"manager/{marker} on disk, no config: "
          + ("still a fresh machine — a snapshot is not a trade (self_ledger on, seed written)"
             if fresh else "starts in account-read mode, no seed written"))
    os.remove(mpath)

print("\n" + ("PASS" if not fails else f"{fails} FAILED"))
sys.exit(1 if fails else 0)
