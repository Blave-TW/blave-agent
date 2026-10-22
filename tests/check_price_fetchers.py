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
print(f"{len(names)} fetchers: {len(price)} price, {len(other)} non-price")
sys.exit(1 if fails else 0)
