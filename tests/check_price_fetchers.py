"""Minimal check: every lib.data fetch_* is classified exactly once — a price fetcher (with its
market) in _PRICE_FETCHERS or a signal / metadata one in _NON_PRICE_FETCHERS. A new fetcher left
out would let lib.runner read a mixed Type C as single-market and pick the wrong benchmark.

Run: cd blave-agent && .venv/bin/python tests/check_price_fetchers.py
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import lib.data as D

names = {n for n, f in vars(D).items() if n.startswith("fetch_") and callable(f)}
price, other = set(D._PRICE_FETCHERS), set(D._NON_PRICE_FETCHERS)
fails = 0
for label, bad in (("unclassified", names - price - other), ("in both lists", price & other),
                   ("listed but not in lib.data", (price | other) - names),
                   ("unknown market", {n for n, m in D._PRICE_FETCHERS.items()
                                       if m not in ("crypto", "tw", "twfutures", "us", "cme")})):
    print(("  PASS  " if not bad else "  FAIL  ") + f"{label}: {sorted(bad)}")
    fails += bool(bad)
# runtime/strategy_reporter keeps its own table (runtime ships apart from lib and stays stdlib-only;
# manager/wait_for_bar mirrors runtime's, tests/check_tw_stock_bar_calendar.py). Shared names must
# mean the same market; the names lib has and runtime lacks are pinned so the gap cannot grow
# silently — closing it changes strategy_market (e.g. US + fetch_twmarket_index: us_stock → mixed).
sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "runtime"))
import strategy_reporter as SR  # noqa: E402
SAME = {"crypto": "crypto", "tw_stock": "tw", "tw_futures": "twfutures", "tw_stock_futures": "twfutures",
        "us_stock": "us", "global_futures": "cme"}
RUNTIME_GAP = {"fetch_binance_ticker_24h", "fetch_twmarket_index", "fetch_twmarket_index_public",
               "fetch_twse_day_all_public", "fetch_twstock_quote", "fetch_twstock_quote_all",
               "fetch_twstock_quote_batch"}
rt = SR._PRICE_FETCHERS
for label, bad in (("runtime names not in lib", set(rt) - price),
                   ("runtime / lib disagree on the market", {n for n in set(rt) & price
                                                             if SAME.get(rt[n]) != D._PRICE_FETCHERS[n]}),
                   ("lib-only names != the pinned runtime gap", (price - set(rt)) ^ RUNTIME_GAP),
                   # the telemetry-only market_hint covers exactly the gap (spec strategy-market-hint §3.3)
                   ("_HINT_FETCHERS keys != the pinned runtime gap", set(SR._HINT_FETCHERS) ^ RUNTIME_GAP),
                   ("_HINT_FETCHERS disagrees with lib on the market",
                    {n for n, m in SR._HINT_FETCHERS.items() if n in D._PRICE_FETCHERS
                     and m != SR._TW_INDEX_LEG and SAME.get(m) != D._PRICE_FETCHERS[n]})):
    print(("  PASS  " if not bad else "  FAIL  ") + f"{label}: {sorted(bad)}")
    fails += bool(bad)
print(f"{len(names)} fetchers: {len(price)} price, {len(other)} non-price")
sys.exit(1 if fails else 0)
