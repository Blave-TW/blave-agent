"""Minimal check: a Taiwan Type C (every column a TW stock / ETF code) is benchmarked against
0050 buy-and-hold on the adjusted close — stats['benchmark_bh'] — and draws no random
portfolios; a crypto-only Type C (every price fetcher in its strategy.py a crypto kline; funding
rate / OI beside them do not count) is benchmarked against BTCUSDT buy-and-hold on its own interval and kline source; a US-only one (every fetcher
fetch_usstock_price) against SPY buy-and-hold; a mixed universe keeps the random benchmark; a failed or late-starting benchmark leaves benchmark_bh null
without failing the backtest; every shape still reads as a portfolio to
strategy_reporter.is_portfolio_stats.

Run: cd blave-agent && MPLBACKEND=Agg .venv/bin/python tests/check_typec_tw_benchmark.py
"""
import contextlib
import io
import json
import math
import os
import sys
import tempfile
from pathlib import Path

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
sys.path.insert(0, os.path.join(ROOT, "runtime"))
os.environ.setdefault("MPLBACKEND", "Agg")

import numpy as np
import pandas as pd

import lib.data as D
import lib.runner as runner
from lib.analysis import compute_stats
import strategy_reporter as sr  # noqa: E402

runner.dotenv_values = lambda *a, **k: {}   # never read the workspace .env

fails = 0


def check(cond, msg):
    global fails
    print(("  PASS  " if cond else "  FAIL  ") + msg)
    fails += (not cond)


WS = Path(tempfile.mkdtemp(prefix="typec-tw-bench-", dir=os.environ.get("SCRATCHPAD") or None))
os.chdir(WS)
runner._REPO_ROOT = WS
os.environ["BLAVE_MODE"] = "backtest"

rng = np.random.default_rng(3)
IDX = pd.bdate_range("2024-01-02", periods=300)
TW = ["2330", "2317", "2454", "6488.TWO", "1301"]
CLOSE = pd.DataFrame(100 * np.exp(np.cumsum(rng.normal(0.0003, 0.012, (300, 5)), axis=0)),
                     index=IDX, columns=TW)
OPEN = CLOSE.shift(1).fillna(CLOSE.iloc[0])

# 0050 adjusted close: starts before the strategy, has a five-day trading halt mid-window
# (no rows — what the 2025 split looked like) and a known level on every traded day
B_IDX = pd.bdate_range("2023-12-15", "2025-03-01")
B_IDX = B_IDX[(B_IDX < "2024-06-11") | (B_IDX > "2024-06-17")]
B_CLOSE = pd.Series(50 * np.exp(np.cumsum(rng.normal(0.0004, 0.01, len(B_IDX)))), index=B_IDX)
calls = []
plots = {}
_plot = runner.plot_pnl_portfolio


def spy_plot(pf, close_df, title="", **kw):
    plots[title] = kw.get("bench_line")
    return _plot(pf, close_df, title=title, **kw)


runner.plot_pnl_portfolio = spy_plot


def fake_0050(stock_id, start, end, headers):
    calls.append((stock_id, start, end))
    b = B_CLOSE[start:end]
    return pd.DataFrame({"Open": b, "Close": b})


def compute(data):
    c, o = data
    mom = c.pct_change(20, fill_method=None)
    rank = mom.rank(axis=1, ascending=False, method="first", na_option="bottom")
    w = pd.DataFrame(np.where((rank <= 2) & mom.notna(), 0.5, 0.0), index=c.index, columns=c.columns)
    s = pd.Series(c.index.to_period("W"), index=c.index)
    w[~(s != s.shift(1)).to_numpy()] = np.nan
    return w.ffill().fillna(0.0).values, pd.concat({"close": c, "open": o}, axis=1)


def run(name, cols, fetch, src=None, close=None, interval="1d"):
    D.fetch_twstock_price_adj = fetch
    if src is not None:   # what the runner reads the price fetchers off
        (WS / "strategies" / name).mkdir(parents=True, exist_ok=True)
        (WS / "strategies" / name / "strategy.py").write_text(src)
    close = CLOSE if close is None else close
    c = close.set_axis(cols, axis=1)
    o = c.shift(1).fillna(c.iloc[0])
    with contextlib.redirect_stdout(io.StringIO()):
        runner.run({"STRATEGY_NAME": name, "INTERVAL": interval, "START": str(close.index[0].date()),
                    "FEE": 0.003, "WARMUP": 20}, lambda h: (c.copy(), o.copy()), compute)
    return json.loads((WS / "strategies" / name / "stats.json").read_text())


RANDOM_KEYS = ("benchmark_n", "benchmark_strategy_ret_pct", "benchmark_band")

# ── Taiwan universe → 0050 buy-and-hold ──
st = run("tw", TW, fake_0050)
bh = st.get("benchmark_bh") or {}
first, last = pd.Timestamp(st["start"]), pd.Timestamp(st["end"])
px = B_CLOSE.reindex(B_CLOSE.index.union(IDX)).ffill()
want = (px[last] / px[first] - 1) * 100
check(bh.get("kind") == "0050_bh" and bh.get("symbol") == "0050" and bh.get("fee_pct") == 0,
      f"Taiwan Type C writes benchmark_bh kind 0050_bh, no fees ({bh.get('kind')}, {bh.get('fee_pct')})")
check(abs(bh.get("ret_pct", math.nan) - want) <= 0.0051,
      f"ret_pct = 0050 close at the last bar / at the first bar − 1 ({bh.get('ret_pct')} vs {want:.2f})")
bars = IDX[IDX >= first]
b_ret = px.reindex(bars).pct_change().fillna(0).values
_, _, _, mdd, ann = compute_stats(b_ret, bars)
check(abs(bh.get("mdd_pct", math.nan) - mdd * 100) <= 0.0051
      and abs(bh.get("cagr_pct", math.nan) - ann * 100) <= 0.0051,
      f"mdd_pct / cagr_pct from compute_stats on the same bars ({bh.get('mdd_pct')}/{bh.get('cagr_pct')} "
      f"vs {mdd * 100:.2f}/{ann * 100:.2f})")
ser = bh.get("series") or []
check(len(ser) == len(st["daily_dates"]) and ser[0] == 1.0
      and abs((ser[-1] - 1) * 100 - bh["ret_pct"]) <= 0.01,
      f"series: one point per daily_dates ({len(ser)} vs {len(st['daily_dates'])}), 1.0 → 1 + ret")
halt = [ser[i] for i, d in enumerate(st["daily_dates"]) if "2024-06-10" <= d <= "2024-06-17" and i < len(ser)]
check(len(halt) == 8 and len(set(halt)) == 1, f"halt days carry the last traded close (flat: {halt})")
check(calls and calls[-1][0] == "0050" and calls[-1][1] <= st["start"] and calls[-1][2] >= st["end"],
      f"0050 fetched over the backtest's window ({calls[-1] if calls else None})")
check(not [k for k in RANDOM_KEYS if k in st], "Taiwan Type C draws no random portfolios")
check(sr.is_portfolio_stats(st), "is_portfolio_stats still reads Taiwan Type C as a portfolio")
line = plots.get("tw")
check(line is not None and abs((line.iloc[-1] - 1) * 100 - bh["ret_pct"]) <= 0.01,
      "pnl.png draws the 0050 buy-and-hold line")

# ── an over-budget live chunk drops benchmark_bh.series only; ret_pct still reaches the row ──
big = {"name": "tw", "backtest": dict(st, daily_returns=[0.0] * 2_000_000)}
small = {"name": "other", "backtest": {"benchmark_bh": None, "Total Return [%]": 1.0}}
ch = sr.live_chunk([big, small])["strategies"]
cb = ch[0]["backtest"]
check("daily_returns" not in cb and isinstance(cb.get("benchmark_bh"), dict)
      and "series" not in cb["benchmark_bh"] and cb["benchmark_bh"].get("ret_pct") == bh["ret_pct"]
      and ch[1]["backtest"]["benchmark_bh"] is None and "series" in big["backtest"]["benchmark_bh"],
      "live chunk tier 2: benchmark_bh keeps ret_pct, loses series; null stays null; input untouched")

# ── 0050 fetch fails → null, backtest still written ──
def boom(*a, **k):
    raise RuntimeError("network down")


st = run("tw_down", TW, boom)
check("benchmark_bh" in st and st["benchmark_bh"] is None and st.get("Total Return [%]") is not None,
      "0050 unavailable: benchmark_bh null, stats.json still written")
check(sr.is_portfolio_stats(st), "is_portfolio_stats reads it as a portfolio even then")

# ── 0050 has no price on or before the first bar → null, not a series from a later start ──
late = B_CLOSE[B_CLOSE.index > "2024-03-01"]
st = run("tw_late", TW, lambda *a, **k: pd.DataFrame({"Open": late, "Close": late}))
check("benchmark_bh" in st and st["benchmark_bh"] is None,
      "0050 starting after the first bar: benchmark_bh null")

# ── a whole-market universe holds preferred shares (2887Z1) and ETFs (00631L, 00679B) ──
calls.clear()
st = run("tw_pref", ["2330", "2887Z1", "00631L", "00679B", "6488.TWO"], fake_0050)
check(isinstance(st.get("benchmark_bh"), dict) and calls and calls[-1][0] == "0050"
      and not [k for k in RANDOM_KEYS if k in st],
      "2887Z1 / 00631L / 00679B in the universe: still 0050, no random portfolios")
check(not runner._is_tw_universe(["2330", "2887Z1", "BTCUSDT"])
      and not runner._is_tw_universe(["2330", "TXFR1"]) and not runner._is_tw_universe(["1000PEPEUSDT"])
      and not runner._is_tw_universe(["2330", "1234567"]) and not runner._is_tw_universe([]),
      "a crypto / futures / non-code column still means not a Taiwan universe")

# ── crypto-only Type C → BTCUSDT buy-and-hold on the strategy's interval and kline source ──
CRYPTO = ["BTCUSDT", "ETHUSDT", "SOLUSDT", "BNBUSDT", "XRPUSDT"]
BTC_SRC = "from lib.data import fetch_kline_batch, fetch_kline  # fetch_twstock_price_adj in a comment\n"
BTC_IDX = pd.date_range("2023-12-01", "2025-03-01", freq="1D")
BTC_CLOSE = pd.Series(40000 * np.exp(np.cumsum(rng.normal(0.0005, 0.02, len(BTC_IDX)))), index=BTC_IDX)
kcalls = []


H_IDX = pd.date_range("2024-03-01", periods=24 * 40, freq="1h")
H_CLOSE = pd.DataFrame(100 * np.exp(np.cumsum(rng.normal(0.0001, 0.004, (len(H_IDX), 5)), axis=0)),
                       index=H_IDX, columns=list("ABCDE"))
BTC_H = pd.Series(40000 * np.exp(np.cumsum(rng.normal(0.0001, 0.005, len(H_IDX) + 48))),
                  index=pd.date_range(H_IDX[0] - pd.Timedelta(hours=48), periods=len(H_IDX) + 48, freq="1h"))


def fake_kline(symbol, interval, start, end, headers, max_retries=6):
    kcalls.append(("binance", symbol, interval, start, end))
    b = BTC_H if interval == "1h" else BTC_CLOSE
    return pd.DataFrame({"Open": b, "Close": b})[start:end]


def fake_bingx(symbol, interval, start, end):
    kcalls.append(("bingx", symbol, interval, start, end))
    return pd.DataFrame({"Open": BTC_CLOSE, "Close": BTC_CLOSE})[start:end]


D.fetch_kline, D.fetch_bingx_kline = fake_kline, fake_bingx
calls.clear()
st = run("crypto", CRYPTO, fake_0050, BTC_SRC)
bh = st.get("benchmark_bh") or {}
first, last = pd.Timestamp(st["start"]), pd.Timestamp(st["end"])
want = (BTC_CLOSE[last] / BTC_CLOSE[first] - 1) * 100
check(bh.get("kind") == "BTC_bh" and bh.get("symbol") == "BTCUSDT" and bh.get("fee_pct") == 0
      and bh.get("adjusted") is False,
      f"crypto Type C writes benchmark_bh kind BTC_bh, symbol BTCUSDT ({bh.get('kind')}, {bh.get('symbol')})")
check(abs(bh.get("ret_pct", math.nan) - want) <= 0.0051,
      f"ret_pct = BTC close at the last bar / at the first bar − 1 ({bh.get('ret_pct')} vs {want:.2f})")
check(kcalls and kcalls[-1][:3] == ("binance", "BTCUSDT", "1d") and kcalls[-1][3] <= st["start"]
      and kcalls[-1][4] >= st["end"] and not calls,
      f"BTC fetched with fetch_kline on the strategy's interval over its window ({kcalls[-1] if kcalls else None})")
check(not [k for k in RANDOM_KEYS if k in st] and sr.is_portfolio_stats(st),
      "crypto Type C draws no random portfolios and still reads as a portfolio")
line = plots.get("crypto")
check(line is not None and abs((line.iloc[-1] - 1) * 100 - bh["ret_pct"]) <= 0.01,
      "pnl.png draws the BTC buy-and-hold line")

kcalls.clear()
st = run("crypto_bingx", CRYPTO, fake_0050, "from lib.data import fetch_bingx_kline\n")
bh = st.get("benchmark_bh") or {}
check(bh.get("kind") == "BTC_bh" and kcalls and kcalls[-1][:3] == ("bingx", "BTC-USDT", "1d"),
      f"a BingX-only Type C takes BTC from BingX ({kcalls[-1] if kcalls else None})")

late_btc = BTC_CLOSE[BTC_CLOSE.index > "2024-03-01"]
D.fetch_kline = lambda *a, **k: pd.DataFrame({"Open": late_btc, "Close": late_btc})
out = io.StringIO()
D.fetch_twstock_price_adj = fake_0050
with contextlib.redirect_stdout(out):
    (WS / "strategies" / "crypto_late").mkdir(parents=True, exist_ok=True)
    (WS / "strategies" / "crypto_late" / "strategy.py").write_text(BTC_SRC)
    runner.run({"STRATEGY_NAME": "crypto_late", "INTERVAL": "1d", "START": "2024-01-02", "FEE": 0.003,
                "WARMUP": 20}, lambda h: (CLOSE.set_axis(CRYPTO, axis=1), OPEN.set_axis(CRYPTO, axis=1)),
               compute)
st = json.loads((WS / "strategies" / "crypto_late" / "stats.json").read_text())
check("benchmark_bh" in st and st["benchmark_bh"] is None and "BTCUSDT buy-and-hold benchmark unavailable"
      in out.getvalue() and not [k for k in RANDOM_KEYS if k in st],
      "BTC starting after the first bar: benchmark_bh null, a warning, no random fallback")
D.fetch_kline = fake_kline

# ── crypto prices + crypto-derived feeds (funding rate, OI): still crypto-only → BTC ──
kcalls.clear()
st = run("crypto_funding", CRYPTO, fake_0050,
         "from lib.data import fetch_kline_batch, fetch_funding_rate, fetch_open_interest_history\n")
check((st.get("benchmark_bh") or {}).get("kind") == "BTC_bh" and kcalls and kcalls[-1][1] == "BTCUSDT"
      and not [k for k in RANDOM_KEYS if k in st],
      "crypto klines + funding rate / OI: BTC_bh, no random portfolios")

# ── names in a docstring / string do not count; the source is read off _REPO_ROOT, not the cwd ──
kcalls.clear()
here = os.getcwd()
os.chdir(tempfile.mkdtemp(dir=os.environ.get("SCRATCHPAD") or None))
try:
    st = run("crypto_doc", CRYPTO, fake_0050,
             '"""Uses fetch_twstock_price_adj? No."""\nX = "fetch_usstock_price"\nfrom lib.data import fetch_kline_batch\n')
finally:
    os.chdir(here)
check((st.get("benchmark_bh") or {}).get("kind") == "BTC_bh",
      "fetcher names in a docstring / string ignored; strategy.py found from another cwd")

# ── 1h crypto Type C: BTC on the strategy's own 1h bars ──
kcalls.clear()
st = run("crypto_1h", CRYPTO, fake_0050, BTC_SRC, close=H_CLOSE, interval="1h")
bh = st.get("benchmark_bh") or {}
bars_1h = plots["crypto_1h"].index   # the strategy's own bars after warmup
want = (BTC_H[bars_1h[-1]] / BTC_H[bars_1h[0]] - 1) * 100
check(bh.get("kind") == "BTC_bh" and kcalls and kcalls[-1][2] == "1h"
      and abs(bh.get("ret_pct", math.nan) - want) <= 0.0051
      and len(bh.get("series") or []) == len(st["daily_dates"]),
      f"1h crypto Type C: hourly BTC, ret_pct {bh.get('ret_pct')} vs {want:.2f}, one series point per day")

# ── a performance refresh whose BTC fetch fails keeps the last benchmark_bh ──
prev = json.loads((WS / "strategies" / "crypto" / "stats.json").read_text())["benchmark_bh"]
stale = dict(json.loads((WS / "strategies" / "crypto" / "stats.json").read_text()), **{"Trades": -1})
(WS / "strategies" / "crypto" / "stats.json").write_text(json.dumps(stale))   # proves the refresh rewrote it
D.fetch_kline = boom
os.environ["BLAVE_MODE"] = "live"
os.environ[runner.STATS_REFRESH_ENV] = "1"
try:
    st = run("crypto", CRYPTO, fake_0050, BTC_SRC)
finally:
    os.environ["BLAVE_MODE"] = "backtest"
    os.environ.pop(runner.STATS_REFRESH_ENV, None)
    D.fetch_kline = fake_kline
check(st.get("Trades") != -1 and isinstance(st.get("benchmark_bh"), dict) and st["benchmark_bh"].get("ret_pct") == prev["ret_pct"]
      and st["benchmark_bh"].get("kind") == "BTC_bh",
      "refresh with BTC unavailable: previous benchmark_bh kept, not nulled")

# ── US-only Type C → SPY buy-and-hold on fetch_usstock_price ──
ucalls = []


def fake_us(symbol, start, end, headers=None):
    ucalls.append((symbol, start, end))
    return pd.DataFrame({"Open": B_CLOSE, "Close": B_CLOSE})[start:end]


D.fetch_usstock_price = fake_us
US = ["AAPL", "MSFT", "NVDA", "BTC", "GOOG"]   # 'BTC' is a US ETF here: the fetcher decides
st = run("us", US, fake_0050, "from lib.data import fetch_usstock_price\n")
bh = st.get("benchmark_bh") or {}
first, last = pd.Timestamp(st["start"]), pd.Timestamp(st["end"])
want = (px[last] / px[first] - 1) * 100
check(bh.get("kind") == "SPY_bh" and bh.get("symbol") == "SPY" and abs(bh.get("ret_pct", math.nan) - want) <= 0.0051
      and ucalls and ucalls[-1][0] == "SPY" and not [k for k in RANDOM_KEYS if k in st],
      f"US Type C writes benchmark_bh SPY_bh from fetch_usstock_price ({bh.get('kind')}, {bh.get('ret_pct')} vs {want:.2f})")
st = run("us_signal", US, fake_0050, "from lib.data import fetch_usstock_price, fetch_fear_greed\n")
check((st.get("benchmark_bh") or {}).get("kind") == "SPY_bh", "US prices + a signal feed (fear & greed): SPY_bh")
D.fetch_usstock_price = boom
st = run("us_down", US, fake_0050, "from lib.data import fetch_usstock_price\n")
check("benchmark_bh" in st and st["benchmark_bh"] is None and not [k for k in RANDOM_KEYS if k in st],
      "SPY unavailable: benchmark_bh null, no random fallback")
D.fetch_usstock_price = fake_us
ucalls.clear()

# ── no strategy.py, a mixed universe, a crypto kline beside another dataset: random, unchanged ──
for name, cols, src in (("crypto_nosrc", CRYPTO, None),
                        ("mixed", ["2330", "2317", "2454", "6488.TWO", "BTCUSDT"],
                         "from lib.data import fetch_kline_batch, fetch_twstock_price_adj_batch\n"),
                        ("crypto_us", ["BTCUSDT", "ETHUSDT", "AAPL", "MSFT", "NVDA"],
                         "from lib.data import fetch_kline_batch, fetch_usstock_price\n"),
                        ("crypto_twprice", CRYPTO,
                         "from lib.data import fetch_kline_batch, fetch_twstock_price_adj_batch\n"),
                        ("crypto_txf_public", CRYPTO,
                         "from lib.data import fetch_kline_batch, fetch_txf_daily_public\n")):
    calls.clear()
    kcalls.clear()
    st = run(name, cols, fake_0050, src)
    check(all(k in st for k in RANDOM_KEYS) and "benchmark_bh" not in st and not calls and not kcalls
          and not ucalls, f"{name} Type C keeps the random benchmark, no 0050 / BTC / SPY fetch")
    check(plots.get(name, 0) is None, f"{name}: pnl.png draws no benchmark line")

print("all checks passed" if not fails else f"FAILED: {fails}")
sys.exit(1 if fails else 0)
