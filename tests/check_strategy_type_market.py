"""The `type` / `market` attributes strategy_reporter reads from a strategy FILE for the
platform's funnel events (strategy_created / backtest_done / deployed). No network.

  type    the `# Type:` header (first 2000 chars, A/B/C — same rule as the desktop app's
          export.js); no header but a Type C backtest → C; otherwise absent
  market  which lib.data PRICE fetcher the source refers to — whole names only, comments and
          strings never count; two markets → mixed; none (own data) → absent;
          fetch_twfutures_ohlcv is the index for SYMBOL TXF/MXF/TMF, a stock future for any
          other literal SYMBOL, undecided without one

Run: cd blave-agent && .venv/bin/python tests/check_strategy_type_market.py
"""
import json
import os
import sys
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BASE = tempfile.mkdtemp(prefix="type-market-")
WS = os.path.join(BASE, "workspace")
os.makedirs(os.path.join(WS, "strategies"))
os.environ["BLAVE_AGENT_BASE"] = BASE
os.environ["BLAVE_AGENT_WORKSPACE"] = WS
sys.path.insert(0, os.path.join(ROOT, "runtime"))
import strategy_reporter as sr  # noqa: E402

fails = 0


def check(cond, msg):
    global fails
    print(("ok   " if cond else "FAIL ") + msg)
    fails += 0 if cond else 1


T = sr.strategy_type


def M(src, symbol=None):
    return sr.strategy_market(src if symbol is None else f"SYMBOL = {symbol!r}\n" + src)


check(T("# Strategy: x\n# Type:     A (single symbol)\n") == "A" and T("# Type: C\n") == "C"
      and T("# Strategy: g\n# Type:     B (grid)\n") == "B", "header A / B / C")
check(T("x = 1  # Type: B\n") is None and T("# Type: Breakout\n") is None and T("x = 1\n") is None
      and T("#" * 2000 + "\n# Type: A\n") is None, "not a header / not A-B-C / past 2000 chars → None")
check(T("# Type: C組合\n") == "C" and T("# Type:     B（網格）\n") == "B" and T("# Type: Cé\n") == "C",
      "a letter followed directly by non-ASCII text still matches (as JS, where \\b is ASCII-only)")

call = "from lib.data import {f}\ndf = {f}(SYMBOL)\n"
for f, want in (("fetch_kline", "crypto"), ("fetch_kline_batch", "crypto"), ("fetch_bingx_kline", "crypto"),
                ("fetch_twstock_price_adj", "tw_stock"), ("fetch_twstock_ohlcv", "tw_stock"),
                ("fetch_stock_futures_batch_daily", "tw_stock_futures"),
                ("fetch_usstock_price", "us_stock"), ("fetch_db_kline", "global_futures")):
    check(M(call.format(f=f)) == want, f"{f} → {want}")
check(M("import lib.data as D\ndf = D.fetch_kline('BTCUSDT')\n") == "crypto"
      and M("from lib.data import fetch_kline as fk\n") == "crypto", "attribute call and aliased import count")
check(M(call.format(f="fetch_db_kline")) != "crypto" and M(call.format(f="fetch_bingx_kline")) == "crypto"
      and M("fetch_kline_v2 = 1\nmy_fetch_kline = 2\n") is None, "names match whole: fetch_kline is not inside fetch_db_kline")
check(M("# df = fetch_kline(SYMBOL)\nNOTE = 'fetch_usstock_price'\nimport requests\n") is None,
      "a commented-out line, a string, own data → None")
check(M("# old: fetch_kline\nfrom lib.data import fetch_twstock_price\n") == "tw_stock", "the comment does not make it mixed")
check(M(call.format(f="fetch_kline") + call.format(f="fetch_usstock_price")) == "mixed", "two markets → mixed")
check(M(call.format(f="fetch_kline") + "from lib.data import fetch_funding_rate, fetch_twstock_institutional\n") == "crypto",
      "non-price fetchers are not a market")

fut = call.format(f="fetch_twfutures_ohlcv")
check(all(M(fut, s) == "tw_index_futures" for s in ("TXF", "mxf", "TMF", "TXFR1")), "TXF / MXF / TMF (R1 too) → tw_index_futures")
check(M(fut, "CDF") == "tw_stock_futures" and M(fut, "CDFR1") == "tw_stock_futures", "another literal SYMBOL → tw_stock_futures")
check(M(fut) is None and M(fut, "") is None and M("SYMBOL = pick()\n" + fut) is None
      and M("# SYMBOL = 'TXF'\n" + fut) is None, "no literal SYMBOL → None, not a guess")
check(M("def broken(:\nSYMBOL = 'MXF'\n" + fut) == "tw_index_futures", "unparseable file: SYMBOL by regex")
check(M(fut + call.format(f="fetch_kline")) == "mixed" and M(fut + call.format(f="fetch_kline"), "TXF") == "mixed",
      "futures next to another market → mixed, SYMBOL or not")
check(M("def broken(:\n# x = fetch_usstock_price()\ndf = fetch_kline(SYMBOL)\n") == "crypto",
      "a file that does not parse: regex fallback, comments stripped")


def write(name, text, stats=None):
    d = os.path.join(WS, "strategies", name)
    os.makedirs(d, exist_ok=True)
    with open(os.path.join(d, "strategy.py"), "w", encoding="utf-8") as fh:
        fh.write(text)
    if stats is not None:
        with open(os.path.join(d, "stats.json"), "w") as fh:
            json.dump(stats, fh)


write("txf_ma", '# Strategy: x\n# Type:     A (single)\nSTRATEGY_NAME = "txf_ma"\nSYMBOL = "TXF"\n' + fut)
write("rotation", 'STRATEGY_NAME = "rotation"\n' + call.format(f="fetch_twstock_price_adj_batch"),
      {"benchmark_n": 100, "daily_returns": [0.1]})
write("plain", 'STRATEGY_NAME = "plain"\nimport requests\n', {"symbol": "X", "daily_returns": [0.1]})
got = {s["name"]: s for s in sr.scan(include_newborn=True)}
check(got["txf_ma"].get("type") == "A" and got["txf_ma"].get("market") == "tw_index_futures",
      "scan(): header + SYMBOL constant reach the report")
check(got["rotation"].get("type") == "C" and got["rotation"].get("market") == "tw_stock",
      "scan(): no header but a Type C backtest → C")
check("type" not in got["plain"] and "market" not in got["plain"], "scan(): unknown is absent, not null")

# the report fingerprint ignores both: a runtime upgrade must not re-send the whole fleet
base = {"name": "txf_ma", "status": "draft", "code": "x = 1\n", "display_name": "d", "description": ""}
tagged = {**base, "type": "A", "market": "crypto"}
check(sr._content_marker(base) == sr._content_marker(tagged)
      and sr.strategy_marker(base) == sr.strategy_marker(tagged), "type / market are not in the marker")
check(sr.FIELDS == ("STRATEGY_NAME", "DISPLAY_NAME", "DESCRIPTION", "MODE"),
      "FIELDS untouched (mirrored in api/openclaw/agent_pure.py)")
check(all("type" not in s and "market" not in s for s in sr._scan_sources(include_newborn=True)),
      "_scan_sources (the signature() hot path) computes neither — no second parse per tool step")

# extraction blowing up: the strategy still reports, just without the two fields
real = sr.strategy_market
sr.strategy_market = lambda src: 1 / 0
try:
    got = {s["name"]: s for s in sr.scan(include_newborn=True)}
finally:
    sr.strategy_market = real
check(set(got) == {"txf_ma", "rotation", "plain"} and all("type" not in s and "market" not in s for s in got.values())
      and got["txf_ma"]["code"].startswith("# Strategy"), "extraction raising: every strategy still reported, no type / market")

print(f"\n{'ALL PASS' if not fails else f'{fails} FAIL'}")
sys.exit(1 if fails else 0)
