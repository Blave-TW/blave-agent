"""The market gate (spec-0.1.12-venue-market-gate): a strategy's market must match the exchange
the machine is bound to before it may be picked, funded or started.

  - lib/runner._stats_market: stats.json `market` from the price fetcher fetch_data really called
  - tools/build_market_contracts.py on recorded public instrument lists (tests/fixtures/
    market_contracts, 2026-10-01): BTCUSDT on all five, TradFi XAUUSDT on none, a same ticker at
    a different price (Gate.io EDGE) dropped, 1000PEPEUSDT not on OKX (it lists PEPE-USDT-SWAP)
  - runtime/market_gate.reason over the spec's table: XAU (Binance) vs BingX GOLD refused,
    BTCUSDT across Binance / OKX / Bybit passes, TW stock on any crypto exchange refused, US
    everywhere refused, paper / 群益 / a hand-wired exchange, and the shipped table itself
  - command_listener._cmd_amounts: codes MARKET_*; no market = passes only when already routed to
    that venue (legacyMoved otherwise), a new pick or $0 → funded waits; every bound venue judged;
    a Type C judged on its live weights too; the gate off on a lib that records no market
  - command_listener resume (啟動下單 after a rebind): a funded strategy routed elsewhere that does
    not match is refused; one still routed to the venue is left to the execution-side hold
    (end to end, with the real _cmd_credentials and lib/portfolio: check_market_gate_rebind.py)
  - portfolio_reporter.market_gate_report: verdicts for every venue, absent without the lib flag;
    it equals tests/fixtures/market_gate_report.json, which the desktop app's tests render from

Run: cd blave-agent && .venv/bin/python tests/check_market_gate.py
"""
import json
import os
import shutil
import sys
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BASE = tempfile.mkdtemp(prefix="market-gate-")
WS = os.path.join(BASE, "workspace")
for d in ("manager", "state", "lib"):
    os.makedirs(os.path.join(WS, d))
os.environ["BLAVE_AGENT_BASE"] = BASE
os.environ["BLAVE_AGENT_WORKSPACE"] = WS
os.environ.pop("BLAVE_AGENT_LOCAL", None)
sys.path.insert(0, os.path.join(ROOT, "runtime"))
sys.path.insert(0, os.path.join(ROOT, "tools"))
sys.path.insert(0, ROOT)
os.chdir(WS)
import build_market_contracts as builder  # noqa: E402
import market_gate as G  # noqa: E402
import command_listener as cl  # noqa: E402
import portfolio_reporter as pr  # noqa: E402
from lib.runner import _carry_over, _stats_market  # noqa: E402

fails = 0


def check(cond, msg):
    global fails
    print(("ok   " if cond else "FAIL ") + msg)
    fails += 0 if cond else 1


# ── runner: market from the fetcher that returned SYMBOL ─────────────────────────────────────
M = lambda calls, **cfg: _stats_market(calls, cfg)
check(M([("fetch_kline", ("BTCUSDT", "1h"))], SYMBOL="BTCUSDT") == "crypto_perp:binance"
      and M([("fetch_kline", ("BTC/USDT", "1h"))], SYMBOL="BTCUSDT", MARKET="spot") == "crypto_spot:binance"
      and M([("fetch_bingx_kline", ("NCCOGOLD2USD-USDT", "1h"))], SYMBOL="NCCOGOLD2USD-USDT") == "crypto_perp:bingx",
      "runner: crypto perp / spot (MARKET) and the data venue from the fetcher")
check(M([("fetch_kline", ("BTCUSDT", "1d")), ("fetch_usstock_price", ("SPY", "2020-01-01"))], SYMBOL="BTCUSDT")
      == "crypto_perp:binance", "runner: the BTC strategy that also reads SPY is crypto (the fetcher that returned SYMBOL)")
check(M([("fetch_usstock_price", ("SPY", "2010-01-01"))], SYMBOL="SPY") == "us_stock"
      and M([("fetch_twstock_price_adj", ("2330", "2020-01-01"))], SYMBOL="2330") == "tw_stock"
      and M([("fetch_twfutures_ohlcv", ("TXF", "1m"))], SYMBOL="MXF") == "tw_futures"
      and M([("fetch_twfutures_ohlcv", ("TXFR1", "1d"))], SYMBOL="TXFR1") == "tw_futures"
      and M([("fetch_stock_futures_batch_daily", (["CDF"], "2024-01-01"))], SYMBOL="CDF") == "other"
      and M([("fetch_twfutures_ohlcv", ("CDF", "1d"))], SYMBOL="CDF") == "other"
      and M([("fetch_db_kline", ("GLBX.MDP3", "GC.c.0"))], SYMBOL="GC.c.0") == "other",
      "runner: US / TW stock / TXF (MXF traded on the TXF series) / stock futures (either fetcher) and CME = other")
check(M([("fetch_kline_batch", (["BTCUSDT", "ETHUSDT"], "1d"))]) == "crypto_perp:binance"
      and M([("fetch_kline_batch", (["BTCUSDT"], "1d")), ("fetch_twstock_price_batch", (["2330"], "x"))]) == "other"
      and M([("fetch_funding_rate", ("BTCUSDT", "1h"))], SYMBOL="BTCUSDT") is None and M([]) is None,
      "runner: Type C by the price fetchers' family; two markets = other; no price fetcher = nothing recorded")
check(M([("fetch_kline", ("ETHUSDT", "1h"))], SYMBOL="BTCUSDT") is None
      and M([("fetch_twfutures_ohlcv", ("TXF", "1m"))], SYMBOL="MXF") == "tw_futures",
      "runner: crypto bars for SYMBOL from an unrecorded fetch (only a filter's call seen) → nothing recorded, not that venue")
from lib.runner import _FetchRecorder  # noqa: E402
import lib.data as _D  # noqa: E402
_rec = _FetchRecorder({})
_orig = _D.fetch_kline
_D.fetch_kline = lambda *a, **k: None
try:
    with _rec.recording():
        _D.fetch_kline(symbol="BTCUSDT", interval="1h", start=0, end=1, headers={})
finally:
    _D.fetch_kline = _orig
check(_rec.calls == [("fetch_kline", ("BTCUSDT",))] and M(_rec.calls, SYMBOL="BTCUSDT") == "crypto_perp:binance",
      "runner: a symbol passed by keyword is recorded (fetch_kline(symbol=...))")

_cdir = tempfile.mkdtemp()
with open(os.path.join(_cdir, "stats.json"), "w") as f:
    json.dump({"market": "crypto_perp:binance", "market_symbols": ["BTCUSDT"], "Sharpe Ratio": 1}, f)
check(_carry_over(_cdir, "live") == {"market": "crypto_perp:binance", "market_symbols": ["BTCUSDT"]}
      and _carry_over(_cdir, "backtest") == {},
      "runner: a live tick carries market / market_symbols over; an explicit backtest records them afresh")
shutil.rmtree(_cdir)

# ── the contract table builder on recorded public answers ─────────────────────────────────────
FIX = os.path.join(ROOT, "tests", "fixtures", "market_contracts")
T = builder.build(builder.fetch(FIX))
venues = lambda s: set(T.get(s, "").split())
check(venues("BTCUSDT") == {"binance", "bingx", "bybit", "gateio", "okx"} and venues("ETHUSDT") == venues("BTCUSDT"),
      "builder: BTCUSDT / ETHUSDT are the same contract on all five exchanges")
check("XAUUSDT" not in T and venues("XAUTUSDT") == {"binance", "bingx", "bybit", "gateio"},
      "builder: TradFi XAUUSDT (gold) on none — tokenized-gold XAUT (a crypto token) where it trades")
check("gateio" not in venues("EDGEUSDT") and {"binance", "bybit", "okx"} <= venues("EDGEUSDT"),
      "builder: Gate.io EDGE_USDT at ~-79% of the others' price is a different coin — dropped")
check("okx" not in venues("1000PEPEUSDT") and venues("PEPEUSDT") == {"gateio", "okx"} and "TSLAUSDT" not in T,
      "builder: 1000PEPEUSDT not on OKX (OKX's spelling lands on nothing); stocks never cross")

def _with_all(underlying):
    """The fixture plus ALLUSDT: on Binance an index perp (live there today, underlyingType INDEX),
    on Bybit a same-priced coin of the same ticker — the look-alike the category filter is for."""
    import copy
    d = copy.deepcopy(builder.fetch(FIX))
    bn = copy.deepcopy(next(x for x in d["binance_perp.json"]["symbols"] if x["symbol"] == "BTCUSDT"))
    bn.update(symbol="ALLUSDT", pair="ALLUSDT", baseAsset="ALL", underlyingType=underlying)
    d["binance_perp.json"]["symbols"].append(bn)
    d["binance_ticker.json"].append({"symbol": "ALLUSDT", "price": "1500.0"})
    by = copy.deepcopy(next(x for x in d["bybit_linear.json"]["result"]["list"] if x["symbol"] == "BTCUSDT"))
    by.update(symbol="ALLUSDT", baseCoin="ALL")
    d["bybit_linear.json"]["result"]["list"].append(by)
    d["bybit_ticker.json"]["result"]["list"].append({"symbol": "ALLUSDT", "lastPrice": "1501.0"})
    return builder.build(d)


check(all("okx" not in venues(s) for s in ("ONUSDT", "QNTUSDT", "BBUSDT")) and "bybit" not in venues("ONUSDT")
      and venues("QNTUSDT") == {"binance", "bybit"},
      "builder: OKX ON / QNT / BB (instCategory 3, equities) and Bybit ON (stock) never cross Binance's coins")


def _eth_gate(mult, prev=None):
    import copy
    d = copy.deepcopy(builder.fetch(FIX))
    g = next(x for x in d["gate_usdt.json"] if x["name"] == "ETH_USDT")
    g["last_price"] = str(float(g["last_price"]) * mult)
    return set(builder.build(d, prev).get("ETHUSDT", "").split())


check("gateio" not in _eth_gate(1.06) and "gateio" in _eth_gate(1.06, T) and "gateio" not in _eth_gate(1.15, T),
      "builder hysteresis: a pair 6% off is not added, but one already in the table stays (≤10%); 15% off drops")
check("ALLUSDT" not in _with_all("INDEX") and _with_all("COIN").get("ALLUSDT") == "binance bybit",
      "builder: Binance's ALLUSDT index perp never crosses a same-named coin elsewhere (a COIN one would)")


# ── the judge ────────────────────────────────────────────────────────────────────────────────
R = lambda m, v, syms=(), us=False, label=None: G.reason(m, v, syms, us=us, table=T, label=label)
check(all(R("crypto_perp:binance", v, ["BTCUSDT"]) is None for v in ("binance", "okx", "bybit", "bingx", "gateio")),
      "judge: BTCUSDT backtested on Binance passes on Binance, OKX, Bybit, BingX and Gate.io")
check(R("crypto_perp:binance", "bingx", ["XAUUSDT"]) == "src" and R("crypto_perp:binance", "okx", ["XAUUSDT"]) == "src"
      and R("crypto_perp:bingx", "binance", ["NCCOGOLD2USD-USDT"]) == "src"
      and R("crypto_perp:bingx", "bingx", ["NCCOGOLD2USD-USDT"]) is None,
      "judge: XAU (Binance) on BingX (GOLD(XAU)-USDT) / OKX refused, BingX GOLD on Binance refused, on BingX itself passes")
check(R("crypto_perp:binance", "okx", ["1000PEPEUSDT"]) == "src" and R("crypto_perp:binance", "okx", ["BTCUSDT", "1000PEPEUSDT"]) == "src"
      and R("crypto_spot:binance", "okx", ["BTCUSDT"]) == "src" and R("crypto_spot:binance", "binance", ["BTCUSDT"]) is None,
      "judge: a Type C with one symbol off is off; spot across exchanges has no table (src), spot on its own exchange passes")
check(all(R("tw_stock", v) == "twStock" for v in G.REAL_VENUES + ("paper", "capital"))
      and all(R("tw_futures", v) == "twFut" for v in G.REAL_VENUES + ("paper",)) and R("tw_futures", "capital") is None,
      "judge: TW stocks refused everywhere; TXF only through 群益")
check(all(R("us_stock", v) == "us" for v in G.KNOWN_VENUES + ("myexch", None))
      and R("crypto_perp:binance", "binance", ["BTCUSDT"], us=True) == "us",
      "judge: US stocks refused on every exchange, a hand-wired one and with nothing bound; a SPY filter counts")
check(R("crypto_perp:binance", "paper", ["XAUUSDT"]) is None and R("crypto_perp:binance", "capital") == "cryptoOnBroker"
      and R("other", "binance") == "other" and R("other", "paper") == "other" and R("crypto_perp:binance", "myexch") is None
      and R("tw_stock", "myexch") is None and R("tw_stock", None) is None,
      "judge: paper takes any crypto; crypto on 群益 refused; other refused; a hand-wired exchange / nothing bound passes")
check(all(R(None, v, label=v) == "legacy" and R(None, v) == "legacyMoved" and R(None, v, label="paper") == "legacyMoved"
          for v in G.REAL_VENUES + ("capital",)) and R(None, "paper") is None,
      "judge: no recorded market = legacy where it is routed already, legacyMoved anywhere else (群益 too), never paper")
check(all(R(m, v, ["BTCUSDT"]) == "other" for m in ("crypto_perp:binance", "tw_futures", None)
          for v in G.OFFICIAL_UNJUDGED) and R("tw_stock", "myexch") is None,
      "judge: an official venue without a column (sinopac / president) refuses everything; only a user-wired id passes")
import glob  # noqa: E402
shipped = {os.path.basename(p)[6:-3] for p in glob.glob(os.path.join(ROOT, "lib", "order_*.py"))} - {"TEMPLATE"}
check(shipped and shipped <= set(G.KNOWN_VENUES) | set(G.OFFICIAL_UNJUDGED),
      f"every shipped lib/order_<id>.py is a venue the gate knows — a new one cannot pass as custom ({sorted(shipped)})")
real = G._contracts()
check(set(real.get("BTCUSDT", "").split()) == {"binance", "bingx", "bybit", "gateio", "okx"} and "XAUUSDT" not in real
      and G.reason("crypto_perp:binance", "okx", ["BTCUSDT"]) is None,
      "shipped runtime/market_contracts.py: BTCUSDT on all five, XAUUSDT on none")
check(G._contracts() is G._contracts() and G._TABLE["sig"] is not None,
      "the contract table is loaded once (by path, next to market_gate.py) and reused while the file is unchanged")
import market_contracts  # noqa: E402
age = __import__("datetime").datetime.now(__import__("datetime").timezone.utc) - \
    __import__("datetime").datetime.fromisoformat(market_contracts.GENERATED_AT.replace("Z", "+00:00"))
if age.days > 30:
    print(f"note runtime/market_contracts.py is {age.days} days old — rebuild before the runtime release")

# ── _cmd_amounts / resume on a workspace ─────────────────────────────────────────────────────
with open(os.path.join(WS, "lib", "runner.py"), "w") as f:
    f.write("def _stats_market(calls, config):\n    pass\n")
with open(os.path.join(WS, "lib", "data.py"), "w") as f:
    f.write("def fetch_kline(\ndef fetch_bingx_kline(\n")
os.makedirs(os.path.join(WS, "manager"), exist_ok=True)
open(os.path.join(WS, "manager", "wait_for_bar.py"), "w").write("# present\n")
crons = []
cl._sync_strategy_crons = lambda names: crons.append(sorted(names))


def strat(name, market=None, symbol="BTCUSDT", code=None, basket=None, weights=None):
    d = os.path.join(WS, "strategies", name)
    os.makedirs(d, exist_ok=True)
    open(os.path.join(d, "strategy.py"), "w").write(code or f"SYMBOL = {symbol!r}\nINTERVAL = '1h'\n")
    stats = {"symbol": symbol, "daily_returns": [0.0]}
    if market:
        stats["market"] = market
    if basket is not None:
        stats.pop("symbol")
        stats["market_symbols"] = basket
    json.dump(stats, open(os.path.join(d, "stats.json"), "w"))
    if weights is not None:
        json.dump({"type": "portfolio", "weights": weights}, open(os.path.join(d, "state.json"), "w"))


def bind(venue, manifest=True):
    lines = {"binance": "BINANCE_API_KEY=k\nBINANCE_SECRET_KEY=s\n", "okx": "OKX_API_KEY=k\nOKX_SECRET_KEY=s\nOKX_PASSPHRASE=p\n",
             "bingx": "BINGX_API_KEY=k\nBINGX_SECRET_KEY=s\n", "paper": "PAPER_API_KEY=p\nPAPER_SECRET_KEY=p\n",
             "capital": "CAPITAL_API_KEY=k\nCAPITAL_PASSWORD=p\n", "myexch": "MYEXCH_API_KEY=k\nMYEXCH_SECRET_KEY=s\n"}[venue]
    open(os.path.join(WS, ".env"), "w").write(lines)
    if manifest:
        json.dump({"ids": [venue], "saved_at": "t"}, open(os.path.join(WS, "manager", "credentials.ui.json"), "w"))


def config(amounts, exchanges=None):
    for p in ("portfolio_config.json", "amounts.ui.json"):
        json.dump({"amounts": amounts, "exchanges": exchanges or {}}, open(os.path.join(WS, "manager", p), "w"))


def resume_msg():
    try:
        cl._resume_gate()
        return None
    except ValueError as e:
        return str(e)


def save(amounts):
    try:
        cl._cmd_amounts({"amounts": amounts})
        return None
    except ValueError as e:
        return str(e)


strat("btc_bn", "crypto_perp:binance")
strat("xau_bn", "crypto_perp:binance", "XAUUSDT")
strat("tw2330", "tw_stock", "2330")
strat("txf", "tw_futures", "TXF")
strat("spy", "us_stock", "SPY")
strat("old_btc", None)
strat("btc_spy", "crypto_perp:binance", code="SYMBOL = 'BTCUSDT'\nINTERVAL = '1d'\nfrom lib.data import fetch_usstock_price\n")

bind("okx")
config({})
check(save({"btc_bn": 100}) is None, "save on OKX: BTCUSDT backtested on Binance (same contract) saves")
for name, code in (("xau_bn", "MARKET_SOURCE"), ("tw2330", "MARKET_TW_STOCK"), ("txf", "MARKET_TW_FUTURES"),
                   ("spy", "MARKET_US"), ("btc_spy", "MARKET_US")):
    config({})
    msg = save({name: 0})
    check(bool(msg) and msg.startswith(f"{code}: 「{name}」") and "取消勾選後再儲存" in msg,
          f"save on OKX: {name} picked at $0 → {code}: 「{name}」…(got {msg!r})")
config({})
msg = save({"xau_bn": 0})
check("Binance" in msg and "OKX" in msg, "MARKET_SOURCE names the data exchange and the bound one")

config({})
check((save({"old_btc": 0}) or "").startswith("MARKET_LEGACY: 「old_btc」"), "legacy, new pick on a real exchange → MARKET_LEGACY")
config({"old_btc": 0}, {"old_btc": "okx"})
check((save({"old_btc": 50}) or "").startswith("MARKET_LEGACY"), "legacy routed to OKX, $0 → funded → MARKET_LEGACY")
config({"old_btc": 0}, {"old_btc": "okx"})
check(save({"old_btc": 0}) is None, "legacy routed to OKX at $0 saves as it is")
config({"old_btc": 80}, {"old_btc": "okx"})
check(save({"old_btc": 120}) is None, "legacy routed to OKX and funded there saves, a new amount included")
for lab in ("", "paper", "binance"):
    config({"old_btc": 80}, {"old_btc": lab})
    check((save({"old_btc": 80}) or "").startswith("MARKET_LEGACY"),
          f"legacy funded but routed to {lab or 'nothing (a rebind blanked it)'} → MARKET_LEGACY on OKX (audit P0-1)")
config({"old_btc": 80}, {"old_btc": "okx"})
json.dump({"amounts": {"old_btc": 80}, "exchanges": {"old_btc": "binance"}},
          open(os.path.join(WS, "manager", "amounts.ui.json"), "w"))
check((save({"old_btc": 80}) or "").startswith("MARKET_LEGACY"),
      "the route that counts is the UI mirror's (the reconciler's), not portfolio_config.json's")
strat("basket", "crypto_perp:binance", basket=["BTCUSDT", "ETHUSDT"], weights={"BTCUSDT": 0.5, "XAUUSDT": 0.5})
config({})
check((save({"basket": 0}) or "").startswith("MARKET_SOURCE: 「basket」"),
      "Type C: judged on its live weights too — XAUUSDT held live but not in market_symbols → refused")
strat("basket", "crypto_perp:binance", basket=["BTCUSDT", "ETHUSDT"], weights={"BTCUSDT": 0.5, "XAUUSDT": 0})
check(save({"basket": 0}) is None, "Type C: a zero weight is not held — BTC / ETH pass on OKX")
strat("basket", "crypto_perp:binance", basket=[], weights={})
check((save({"basket": 0}) or "").startswith("MARKET_SOURCE"), "Type C with no symbols to judge → refused")
shutil.rmtree(os.path.join(WS, "strategies", "basket"))
bind("paper")
config({})
check(save({"old_btc": 50, "xau_bn": 10}) is None, "paper: legacy and any crypto source save")
check((save({"tw2330": 0}) or "").startswith("MARKET_TW_STOCK"), "paper: a TW stock is refused (recorded market)")
bind("capital")
config({})
check(save({"txf": 1}) is None and (save({"btc_bn": 1}) or "").startswith("MARKET_CRYPTO_ON_BROKER")
      and (save({"old_btc": 1}) or "").startswith("MARKET_LEGACY"),
      "群益: TXF saves, crypto refused, a new legacy pick needs a re-run backtest")
bind("myexch")
config({})
check(save({"tw2330": 1, "old_btc": 1}) is None and (save({"spy": 0}) or "").startswith("MARKET_US"),
      "a hand-wired exchange passes everything but US stocks")
open(os.path.join(WS, ".env"), "w").write("SINOPAC_API_KEY=k\nSINOPAC_SECRET_KEY=s\n")
json.dump({"ids": ["sinopac"], "saved_at": "t"}, open(os.path.join(WS, "manager", "credentials.ui.json"), "w"))
config({})
check((save({"btc_bn": 0}) or "").startswith("MARKET_OTHER"), "bound to sinopac (official, no column): refused")
check(pr.market_gate_report()["verdicts"]["btc_bn"]["reasons"].get("sinopac") == "other",
      "report: a bound venue outside the known seven gets its own cell (sinopac → other), so the pages never read null")

# Type B that places its own orders (no stats.json, no state.json, nothing that feeds the reconciler)
# — no market rule, as before 0.1.12
strat("grid_b", code="STRATEGY_NAME = 'grid_b'\nSYMBOL = 'XAUUSDT'\n")
os.remove(os.path.join(WS, "strategies", "grid_b", "stats.json"))
config({"grid_b": 40}, {"grid_b": "sinopac"})
check(save({"grid_b": 55}) is None, "Type B funded on sinopac: changing its amount saves (no MARKET_OTHER)")
rep_b = pr.market_gate_report()
check(rep_b["holds"] == {} and not os.path.exists(os.path.join(WS, "state", "events.jsonl"))
      and rep_b["verdicts"]["grid_b"]["judged"] is False
      and all(v is None for v in rep_b["verdicts"]["grid_b"]["reasons"].values())
      and rep_b["verdicts"]["btc_bn"]["judged"] is True,
      "Type B: never held (no false market_hold P1 — it does not trade through lib/portfolio); report says judged: false, every cell null")
for venue in ("binance", "capital", "okx"):
    bind(venue)
    config({})
    check(save({"grid_b": 10}) is None, f"Type B new pick on {venue}: saves (no MARKET_LEGACY — it has no backtest to re-run)")
    config({"grid_b": 10}, {"grid_b": ""})
    check(resume_msg() is None,
          f"Type B funded, route blanked by a rebind to {venue}: 啟動下單 not held by the gate (a Type A/C would be)")
strat("grid_b", code="STRATEGY_NAME = 'grid_b'\nimport os\nos.environ['BLAVE_AGENT_LOCAL'] = '1'\n")
os.remove(os.path.join(WS, "strategies", "grid_b", "stats.json"))
check((save({"grid_b": 0}) or "").startswith("MARKET_FLAG"),
      "Type B that sets the desktop flag in code is still refused (a tamper check, not a market rule)")
cases = {"a1": "INTERVAL = '1h'\n", "a2": "INTERVAL='15min'\n", "b1": "", "b2": "INTERVAL = 'hourly'\n",
         "b3": "INTERVAL = '1H'\n", "b4": "# INTERVAL = '1h'\nx = 1\n", "b5": "  INTERVAL = \"1d\"\n"}
for n, code in cases.items():
    strat("tb_" + n, code="STRATEGY_NAME = 'x'\n" + code)
check(all(G.type_b(WS, "tb_" + n) is (not cl._strategy_has_interval("tb_" + n)) for n in cases)
      and [n for n in cases if not G.type_b(WS, "tb_" + n)] == ["a1", "a2", "b5"],
      "market_gate.type_b agrees with command_listener._strategy_has_interval on every case")
wfb = os.path.join(WS, "manager", "wait_for_bar.py")
os.rename(wfb, wfb + ".off")
check(G.type_b(WS, "tb_a1") and not cl._strategy_has_interval("tb_a1"), "no wait_for_bar.py: everything is Type B on both sides")
os.rename(wfb + ".off", wfb)
for n in list(cases) + ["grid_b"]:
    shutil.rmtree(os.path.join(WS, "strategies", "tb_" + n if n in cases else n))

# order-time check (lib/portfolio calls it every reconcile round): cached until a file changes
_reads = []
_orig_read = G.read_stats
G.read_stats = lambda folder, cache=None: (_reads.append(folder), _orig_read(folder, cache))[1]
try:
    j1 = G.judge_symbol(WS, "xau_bn", "XAUUSDT", "okx")
    j2 = G.judge_symbol(WS, "xau_bn", "XAUUSDT", "okx")
    n_cached = len(_reads)
    _st = os.path.join(WS, "strategies", "xau_bn", "stats.json")
    os.utime(_st, ns=(os.stat(_st).st_atime_ns, os.stat(_st).st_mtime_ns + 10**9))
    j3 = G.judge_symbol(WS, "xau_bn", "XAUUSDT", "okx")
finally:
    G.read_stats = _orig_read
check(j1 == j2 == j3 == "src" and n_cached == 1 and len(_reads) == 2
      and G.judge_symbol(WS, "btc_bn", "BTCUSDT", "okx") is None and G.judge_symbol(WS, "old_btc", "BTCUSDT", "okx") == "legacy",
      "judge_symbol: XAU (Binance) on OKX = src, judged once and cached until stats.json changes; BTC passes; no market = legacy")

# ── the contract table changing / missing (audit round 5): a copy of the runtime in a temp dir ──
import importlib.util as _ilu  # noqa: E402
import contextlib as _cl  # noqa: E402
import io as _io  # noqa: E402
_RT = tempfile.mkdtemp(prefix="mg-rt-")
shutil.copy(os.path.join(ROOT, "runtime", "market_gate.py"), _RT)
_TBL = os.path.join(_RT, "market_contracts.py")


def _table(perp, bump=1):
    with open(_TBL, "w") as f:
        f.write('GENERATED_AT = "t"\nPERP = ' + json.dumps(perp) + "\n")
    st = os.stat(_TBL)
    os.utime(_TBL, ns=(st.st_atime_ns, st.st_mtime_ns + bump * 10**9))


_table({"BTCUSDT": "binance okx"})
_spec = _ilu.spec_from_file_location("mg_copy", os.path.join(_RT, "market_gate.py"))
MG = _ilu.module_from_spec(_spec)
_spec.loader.exec_module(MG)
check(MG.judge_symbol(WS, "xau_bn", "XAUUSDT", "okx") == "src" and MG.judge_symbol(WS, "btc_bn", "BTCUSDT", "okx") is None,
      "table copy: XAUUSDT (not in it) refused on OKX, BTCUSDT passes")
_table({"BTCUSDT": "binance okx", "XAUUSDT": "binance okx"}, bump=2)
check(MG.judge_symbol(WS, "xau_bn", "XAUUSDT", "okx") is None,
      "the table changed (rebuilt with XAUUSDT on both): the cached verdict is redone at once — not the old 'src'")
_err = _io.StringIO()
os.remove(_TBL)
with _cl.redirect_stderr(_err):
    j_missing = MG.judge_symbol(WS, "xau_bn", "XAUUSDT", "bingx")
    st_missing = MG.table_status()
check(j_missing is None and MG.symbols_reason(["ONUSDT"], "okx") is None and st_missing["ok"] is False
      and "missing" in (st_missing["why"] or "") and "contract table" in _err.getvalue(),
      "table missing (Wei): the table step is skipped — orders go through, not 'everything mismatches'; logged; table_status says so")
_table({"BTCUSDT": "binance okx"}, bump=3)
check(MG.judge_symbol(WS, "xau_bn", "XAUUSDT", "okx") == "src" and MG.table_status()["ok"] is True,
      "table back: retried on the next call, the check is on again")
_err = _io.StringIO()
with open(_TBL, "w") as f:
    f.write("PERP = {broken")
with _cl.redirect_stderr(_err):
    j_broken = MG.judge_symbol(WS, "xau_bn", "XAUUSDT", "okx")
check(j_broken is None and MG.table_status()["ok"] is False and "unreadable" in _err.getvalue(),
      "table unreadable (bad content): skipped, logged, reported")
_table({"BTCUSDT": "binance okx"}, bump=5)
check(MG.judge_symbol(WS, "xau_bn", "XAUUSDT", "okx") == "src", "…and fixed: back on")
shutil.rmtree(_RT)
# one parse of a strategy's stats.json per change, whatever the number of symbols judged
_reads = []
_orig_read = G.read_stats
G.read_stats = lambda folder, cache=None: (_reads.append(folder), _orig_read(folder, cache))[1]
G._FILE_CACHE.clear()
G._SYMBOL_CACHE.clear()
try:
    [G.judge_symbol(WS, "btc_bn", sym, "okx") for sym in ("BTCUSDT", "ETHUSDT", "SOLUSDT", "XAUUSDT", "ONUSDT")]
finally:
    G.read_stats = _orig_read
_parsed = [k for k in G._FILE_CACHE if str(k).endswith("stats.json")]
check(len(_reads) == 5 and len(_parsed) == 1,
      "judge_symbol over 5 symbols of one strategy: stats.json parsed once (shared cache), not once per symbol")

# Type B that feeds the reconciler (lib.execute.update_state → state.json): every symbol it writes
# must be one the contract table confirms on that exchange (audit round 3 R4, Wei)
FEED = "STRATEGY_NAME = '{n}'\nfrom lib.execute import update_state\nupdate_state('{n}', 1.0)\n"


def feeder(name, state=None):
    strat(name, code=FEED.format(n=name))
    os.remove(os.path.join(WS, "strategies", name, "stats.json"))
    if state is not None:
        json.dump(state, open(os.path.join(WS, "strategies", name, "state.json"), "w"))


feeder("b_on", {"symbol": "ONUSDT", "position": 1.0})
feeder("b_btc", {"symbol": "BTCUSDT", "position": 1.0})
feeder("b_new")                                         # never ran: no symbol yet
feeder("b_basket", {"type": "portfolio", "weights": {"BTCUSDT": 0.5, "ONUSDT": 0.5}})
bind("okx")
config({})
for n in ("b_on", "b_basket"):
    check(G.gate_mode(WS, n) == "symbols" and (save({n: 0}) or "").startswith(f"MARKET_UNCONFIRMED: 「{n}」"),
          f"Type B feeding the reconciler on OKX: {n} → MARKET_UNCONFIRMED (ONUSDT is an OKX equity)")
msg = save({"b_new": 0}) or ""
check(G.gate_mode(WS, "b_new") == "symbols" and msg.startswith("MARKET_NOT_RUN: 「b_new」") and "跑一次" in msg,
      f"Type B that names update_state but never ran: MARKET_NOT_RUN — says to run it once, not 'not the same contract' ({msg!r})")
# what counts as feeding the reconciler: the state.json content first, code only before the first run
strat("b_dump", code="STRATEGY_NAME = 'b_dump'\nimport json\njson.dump({'symbol': 'ONUSDT', 'position': 1}, open('state.json', 'w'))\n")
os.remove(os.path.join(WS, "strategies", "b_dump", "stats.json"))
json.dump({"symbol": "ONUSDT", "position": 1.0}, open(os.path.join(WS, "strategies", "b_dump", "state.json"), "w"))
check(G.gate_mode(WS, "b_dump") == "symbols" and (save({"b_dump": 0}) or "").startswith("MARKET_UNCONFIRMED"),
      "a Type B that writes state.json with its own json.dump (no update_state in code): judged by the state.json content")
strat("b_self", code="STRATEGY_NAME = 'b_self'\nfrom lib.execute import save_state\nrunner = 1\nsave_state('b_self', {'fills': 3})\n")
os.remove(os.path.join(WS, "strategies", "b_self", "stats.json"))
check(G.gate_mode(WS, "b_self") is None, "a self-ordering Type B that names save_state / a variable `runner`, before its first run: not judged")
json.dump({"fills": 3}, open(os.path.join(WS, "strategies", "b_self", "state.json"), "w"))
check(G.gate_mode(WS, "b_self") is None and save({"b_self": 50}) is None,
      "…and after it: its state.json has no symbol / weights → not judged, saves (no false market_hold)")
shutil.rmtree(os.path.join(WS, "strategies", "b_dump"))
shutil.rmtree(os.path.join(WS, "strategies", "b_self"))
check(save({"b_btc": 100}) is None, "Type B feeding the reconciler: BTCUSDT (confirmed on OKX) saves")
bind("capital")
config({})
check((save({"b_btc": 0}) or "").startswith("MARKET_UNCONFIRMED"), "群益: a crypto symbol from a Type B is refused")
feeder("b_txf", {"symbol": "TXF", "position": 1.0})
check(save({"b_txf": 1}) is None, "群益: a Type B writing TXF saves")
open(os.path.join(WS, ".env"), "w").write("SINOPAC_API_KEY=k\nSINOPAC_SECRET_KEY=s\n")
json.dump({"ids": ["sinopac"], "saved_at": "t"}, open(os.path.join(WS, "manager", "credentials.ui.json"), "w"))
config({})
check((save({"b_txf": 0}) or "").startswith("MARKET_OTHER"), "sinopac: a Type B feeding the reconciler → MARKET_OTHER (no column yet)")
bind("paper")
config({})
check(save({"b_on": 10}) is None, "paper: a Type B's symbols are not judged (paper prices any crypto)")
bind("okx")
config({"b_on": 100, "b_btc": 100}, {"b_on": "", "b_btc": ""})
check((resume_msg() or "").startswith("MARKET_UNCONFIRMED: 「b_on」"), "啟動下單 after a rebind: the ONUSDT Type B is refused")
config({"b_on": 100, "b_basket": 100, "b_btc": 100, "b_new": 100},
       {"b_on": "okx", "b_basket": "okx", "b_btc": "okx", "b_new": "okx"})
rep_f = pr.market_gate_report()
check("b_new" not in rep_f["holds"] and rep_f["verdicts"]["b_new"]["reasons"]["okx"] == "notRun",
      "a funded Type B that has not run yet is not held (nothing trades yet — no false P1); the report says notRun")
check(rep_f["holds"].get("b_on") == {"venue": "okx", "reason": "unconfirmed", "symbols": ["ONUSDT"]}
      and rep_f["holds"].get("b_basket") == {"venue": "okx", "reason": "unconfirmed", "symbols": ["ONUSDT"]}
      and "b_btc" not in rep_f["holds"]
      and rep_f["verdicts"]["b_on"]["judged"] is True and rep_f["verdicts"]["b_on"]["reasons"]["okx"] == "unconfirmed"
      and rep_f["verdicts"]["b_btc"]["reasons"]["okx"] is None,
      "execution side: a funded Type B routed to OKX writing ONUSDT is held (only ONUSDT in the basket); BTCUSDT is not")
os.remove(os.path.join(WS, "state", "market_hold.json"))
evp = os.path.join(WS, "state", "events.jsonl")
if os.path.exists(evp):
    os.remove(evp)
# a Type A whose INTERVAL the scheduler regex misses (a type annotation) runs lib.runner anyway — judged by its stats
strat("annot", "crypto_perp:binance", "XAUUSDT", code="STRATEGY_NAME = 'annot'\nINTERVAL: str = '1h'\n")
check(G.type_b(WS, "annot") and G.gate_mode(WS, "annot") == "market"
      and (save({"annot": 0}) or "").startswith("MARKET_SOURCE: 「annot」"),
      "INTERVAL: str = '1h' (read as Type B by the scheduler): still judged by its stats.json market → MARKET_SOURCE on OKX")
check(G.judge_symbol(WS, "annot", "ZZZUSDT", "binance") is None and G.judge_symbol(WS, "annot", "ZZZUSDT", "okx") == "src",
      "order-time check on the annotated Type A goes by its stats.json market (Binance data on Binance passes a symbol the table lacks)")
config({"annot": 100}, {"annot": "okx"})
check(pr.market_gate_report()["holds"].get("annot", {}).get("reason") == "src", "…and held on the execution side")
os.remove(os.path.join(WS, "state", "market_hold.json"))
if os.path.exists(evp):
    os.remove(evp)
for n in ("b_on", "b_btc", "b_new", "b_basket", "b_txf", "annot"):
    shutil.rmtree(os.path.join(WS, "strategies", n))
config({})
open(os.path.join(WS, ".env"), "w").write("OKX_API_KEY=k\nOKX_SECRET_KEY=s\nOKX_PASSPHRASE=p\n"
                                          "BINANCE_API_KEY=k\nBINANCE_SECRET_KEY=s\n")
json.dump({"ids": ["okx"], "saved_at": "t"}, open(os.path.join(WS, "manager", "credentials.ui.json"), "w"))
check((save({"tw2330": 0}) or "").startswith("MARKET_TW_STOCK"),
      "a key pair the UI never bound (not in the manifest) is not the venue: judged on the bound one")
json.dump({"ids": ["okx", "binance"], "saved_at": "t"}, open(os.path.join(WS, "manager", "credentials.ui.json"), "w"))
config({})
check((save({"tw2330": 0}) or "").startswith("MARKET_TW_STOCK") and save({"btc_bn": 0}) is None
      and (save({"xau_bn": 0}) or "").startswith("MARKET_SOURCE") and "OKX" in save({"xau_bn": 0}),
      "two bound venues: judged on each, any refusal refuses (XAU fine on Binance, not on OKX)")

bind("okx")
os.remove(os.path.join(WS, "lib", "runner.py"))
config({})
check(save({"tw2330": 0, "old_btc": 0, "xau_bn": 0}) is None and (save({"spy": 0}) or "").startswith("MARKET_US"),
      "lib that records no market: the gate is off (only US is refused)")
check(pr.market_gate_report() is None, "report: no market_gate without the lib flag")
with open(os.path.join(WS, "lib", "runner.py"), "w") as f:
    f.write("def _stats_market(calls, config):\n    pass\n")

# resume after a rebind
os.makedirs(os.path.join(WS, "state"), exist_ok=True)
config({"tw2330": 100, "btc_bn": 100})
try:
    cl._resume_gate()
    check(False, "resume: a funded TW stock on OKX is refused")
except ValueError as e:
    check(str(e).startswith("MARKET_TW_STOCK: 「tw2330」") and "啟動下單" in str(e),
          "resume (啟動下單) on OKX: funded TW stock → MARKET_TW_STOCK …再按「啟動下單」")
halt = os.path.join(WS, "state", "HALT")
for cmd in ("_cmd_resume", "_cmd_resume_wait"):
    open(halt, "w").write("x")
    try:
        getattr(cl, cmd)({})
        got = None
    except ValueError as e:
        got = str(e)
    check(bool(got) and got.startswith("MARKET_TW_STOCK: 「tw2330」") and os.path.exists(halt),
          f"{cmd} (啟動下單) runs the gate before anything else: refused, HALT stays")
os.remove(halt)
config({"tw2330": 0, "old_btc": 100, "btc_bn": 100}, {"old_btc": "okx", "btc_bn": "okx"})
check(resume_msg() is None, "resume: legacy funded where it is routed and a $0 mismatch do not hold the start")
config({"old_btc": 100}, {"old_btc": ""})
check((resume_msg() or "").startswith("MARKET_LEGACY: 「old_btc」"), "resume: legacy funded with its route blanked (rebind) → refused")
config({"tw2330": 100, "btc_bn": 100}, {"tw2330": "okx", "btc_bn": "okx"})
check(resume_msg() is None,
      "resume: a mismatch still routed to OKX (approved at save; the table moved since) is held, not the machine")
config({"tw2330": 0, "old_btc": 100, "btc_bn": 100}, {"old_btc": "okx", "btc_bn": "okx"})

# report
rep = pr.market_gate_report()
v = rep["verdicts"]
check(rep["data_venues"] == ["binance", "bingx"] and v["btc_bn"]["market"] == "crypto_perp:binance"
      and v["btc_bn"]["reasons"]["okx"] is None and v["xau_bn"]["reasons"]["bingx"] == "src"
      and v["tw2330"]["reasons"]["binance"] == "twStock" and v["spy"]["reasons"]["paper"] == "us"
      and v["old_btc"]["reasons"]["okx"] == "legacy" and v["old_btc"]["reasons"]["bybit"] == "legacyMoved"
      and v["old_btc"]["reasons"]["paper"] is None and rep["holds"] == {}
      and set(v["btc_bn"]["reasons"]) == set(G.KNOWN_VENUES),
      "report: market_gate verdicts per strategy for every known venue + data_venues")
check(pr.build_report().get("market_gate") == rep, "report: build_report carries market_gate")

# the report is the contract both pages read (they never re-judge): this workspace's report is the
# fixture tests/check_shell_trade.js renders from — regenerate with UPDATE_FIXTURES=1 after a rule change
FIXTURE = os.path.join(ROOT, "tests", "fixtures", "market_gate_report.json")
if os.environ.get("UPDATE_FIXTURES") == "1":
    with open(FIXTURE, "w") as f:
        json.dump(rep, f, indent=1, sort_keys=True)
with open(FIXTURE) as f:
    check(json.load(f) == json.loads(json.dumps(rep)),
          "report == tests/fixtures/market_gate_report.json (the fixture the desktop app's tests render)")

shutil.rmtree(BASE, ignore_errors=True)
print(f"\n{'ALL PASS' if not fails else f'{fails} FAIL'}")
sys.exit(1 if fails else 0)
