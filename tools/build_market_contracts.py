#!/usr/bin/env python3
"""Build runtime/market_contracts.py — which exchanges list the SAME crypto perpetual under the
symbol a strategy writes. runtime/market_gate.py reads it to decide whether a strategy backtested
on one exchange's prices (stats.json `market`, e.g. crypto_perp:binance) may trade on another.

Run before every runtime release (the table ships with the runtime; a contract listed after the
last build is simply absent, so a strategy on it reads as "data from another exchange" until the
next build — never as the same contract):

    python3 tools/build_market_contracts.py            # fetch the five public endpoints, write
    python3 tools/build_market_contracts.py --raw DIR  # rebuild from saved answers (tests)

It prints every symbol / exchange the new table drops against the old one — read that list
before a release (a major coin there means something upstream changed).

Only PUBLIC instrument lists and tickers are read; no key, no account.

A canonical symbol (dashless, as strategies write it: BTCUSDT) is the same contract on two
exchanges when, on each of them:
  1. the order lib's OWN spelling of the symbol lands on a listed contract — Binance / Bybit send
     it verbatim, OKX `X-USDT-SWAP` (order_okx._swap_inst), Gate.io `X_USDT` (order_gateio.
     _contract), BingX `X-USDT` (order_bingx._bingx_symbol). 1000PEPEUSDT has no OKX contract
     (OKX lists PEPE-USDT-SWAP), so it is not "the same" there — the order would fail anyway;
  2. that contract is a live, linear (USDT / USDC-settled) perpetual;
  3. its underlying is a crypto asset. TradFi perpetuals (gold, stocks, FX, indices) never count
     as the same across exchanges — each exchange builds its own index and hours (XAUUSDT on
     Binance is not BingX's GOLD(XAU)-USDT). Per exchange: Binance underlyingType COIN; OKX
     instCategory 1; Bybit symbolType "" / "innovation"; BingX has no category field but lists
     TradFi under NC*-prefixed assets (NCSKTSLA2USD-USDT), names no other exchange spells, so
     none of them can cross; Gate.io has no category field at all — a Gate.io contract counts only when the same
     base is crypto on Binance, OKX or Bybit (HEURISTIC);
  4. its last price is within PRICE_TOL of the median over the exchanges listing the symbol —
     catches same ticker / different coin and multiplier mismatches field matching cannot. A pair
     already in the previous table stays while within PRICE_KEEP (hysteresis: a thin coin whose
     last trades scatter 3–7% would otherwise drop out on one build and come back on the next;
     same-ticker different assets measured 4× apart or more). Dropped symbols are printed.
Symbols listed on fewer than two exchanges after these filters are left out (a strategy on the
exchange its data came from needs no table)."""
import argparse
import datetime
import json
import os
import statistics
import sys
import time
import urllib.parse
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(os.path.dirname(HERE), "runtime", "market_contracts.py")
PRICE_TOL = 0.03
PRICE_KEEP = 0.10
QUOTES = ("USDT", "USDC")
URLS = {
    "binance_perp.json": "https://fapi.binance.com/fapi/v1/exchangeInfo",
    "binance_ticker.json": "https://fapi.binance.com/fapi/v1/ticker/price",
    "okx_swap.json": "https://www.okx.com/api/v5/public/instruments?instType=SWAP",
    "okx_ticker.json": "https://www.okx.com/api/v5/market/tickers?instType=SWAP",
    "bybit_linear.json": "https://api.bybit.com/v5/market/instruments-info?category=linear&limit=1000",
    "bybit_ticker.json": "https://api.bybit.com/v5/market/tickers?category=linear",
    "gate_usdt.json": "https://api.gateio.ws/api/v4/futures/usdt/contracts",
    "bingx_swap.json": "https://open-api.bingx.com/openApi/swap/v2/quote/contracts",
    "bingx_ticker.json": "https://open-api.bingx.com/openApi/swap/v2/quote/ticker",
}


def fetch(raw):
    out = {}
    for name, url in URLS.items():
        path = os.path.join(raw, name) if raw else None
        if path and os.path.exists(path):
            with open(path) as f:
                out[name] = json.load(f)
            continue
        if raw:
            sys.exit(f"missing {path}")
        out[name] = _get(url)
        if name == "bybit_linear.json":
            # paged: 1000 per page today ~900 rows — a silent cut would drop real contracts
            seen = set()
            while out[name]["result"].get("nextPageCursor"):
                cur = out[name]["result"]["nextPageCursor"]
                if cur in seen:
                    sys.exit("bybit instruments: cursor repeats")
                seen.add(cur)
                page = _get(url + "&cursor=" + urllib.parse.quote(cur))
                out[name]["result"]["list"] += page["result"]["list"]
                out[name]["result"]["nextPageCursor"] = page["result"].get("nextPageCursor")
    return out


def _get(url):
    req = urllib.request.Request(url, headers={"User-Agent": "blave-agent market_contracts builder"})
    with urllib.request.urlopen(req, timeout=30) as r:
        body = json.load(r)
    time.sleep(0.5)
    return body


def _quote(sym):
    for q in QUOTES:
        if sym.endswith(q) and len(sym) > len(q):
            return sym[:-len(q)], q
    return None, None


def listings(d):
    """{venue: {canonical symbol: (base, price or None, crypto: True/False/None)}}"""
    v = {}
    px = {t["symbol"]: float(t["price"]) for t in d["binance_ticker.json"]}
    v["binance"] = {s["symbol"]: (s["baseAsset"], px.get(s["symbol"]), s["underlyingType"] == "COIN")
                    for s in d["binance_perp.json"]["symbols"]
                    if s["contractType"] == "PERPETUAL" and s["status"] == "TRADING"
                    and s["quoteAsset"] in QUOTES and s["marginAsset"] == s["quoteAsset"]}
    px = {t["instId"]: float(t["last"]) for t in d["okx_ticker.json"]["data"] if t.get("last")}
    okx = {}
    for s in d["okx_swap.json"]["data"]:
        base, _, rest = s["instId"].partition("-")
        quote = rest.split("-")[0]
        if s["state"] == "live" and s["ctType"] == "linear" and quote in QUOTES and s["settleCcy"] == quote:
            okx[base + quote] = (s["ctValCcy"], px.get(s["instId"]), s.get("instCategory") == "1")
    v["okx"] = okx
    px = {t["symbol"]: float(t["lastPrice"]) for t in d["bybit_ticker.json"]["result"]["list"] if t.get("lastPrice")}
    v["bybit"] = {s["symbol"]: (s["baseCoin"], px.get(s["symbol"]), s.get("symbolType", "") in ("", "innovation"))
                  for s in d["bybit_linear.json"]["result"]["list"]
                  if s["contractType"] == "LinearPerpetual" and s["status"] == "Trading" and _quote(s["symbol"])[0]}
    v["gateio"] = {s["name"].replace("_", ""): (s["name"].split("_")[0], float(s["last_price"] or 0) or None, None)
                   for s in d["gate_usdt.json"]
                   if s["status"] == "trading" and not s.get("in_delisting") and s["name"].endswith("_USDT")}
    px = {t["symbol"]: float(t["lastPrice"]) for t in d["bingx_ticker.json"]["data"] if t.get("lastPrice")}
    v["bingx"] = {s["symbol"].replace("-", ""): (s["asset"], px.get(s["symbol"]), True)
                  for s in d["bingx_swap.json"]["data"]
                  if s["status"] == 1 and s["currency"] in QUOTES and s["symbol"] == f"{s['asset']}-{s['currency']}"}
    return v


def previous():
    """PERP of the table this build replaces ({} when there is none)."""
    try:
        with open(OUT, encoding="utf-8") as f:
            src = f.read()
    except OSError:
        return {}
    ns = {}
    exec(compile(src, OUT, "exec"), ns)  # our own generated file: two literals
    return ns.get("PERP", {})


def build(d, prev=None):
    prev = prev or {}
    v = listings(d)
    crypto_bases = {b for name in ("binance", "okx", "bybit") for (b, _, c) in v[name].values() if c}
    table = {}
    for sym in sorted(set().union(*[set(x) for x in v.values()])):
        base, quote = _quote(sym)
        if base is None:
            continue
        rows = {}
        for venue, lst in v.items():
            if sym not in lst:
                continue
            b, price, crypto = lst[sym]
            if crypto is None:          # Gate.io: crypto only when another exchange says so
                crypto = b in crypto_bases
            if crypto and price and price > 0:
                rows[venue] = price
        if len(rows) < 2:
            continue
        mid = statistics.median(rows.values())
        was = set(prev.get(sym, "").split())
        same = sorted(k for k, p in rows.items()
                      if abs(p / mid - 1) <= (PRICE_KEEP if k in was else PRICE_TOL))
        if len(same) >= 2:
            table[sym] = " ".join(same)
    return table


def write(table):
    stamp = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    lines = ['"""GENERATED by tools/build_market_contracts.py — do not edit by hand; rebuild before each',
             'runtime release. Canonical crypto perpetual symbol → the exchanges where the order lib\'s own',
             'spelling of it is the SAME live linear crypto contract (rules in that script\'s docstring).',
             'A symbol or exchange missing here is not "the same contract" (runtime/market_gate.py)."""',
             f'GENERATED_AT = "{stamp}"', "PERP = {"]
    lines += [f'    "{k}": "{val}",' for k, val in table.items()]
    lines.append("}")
    with open(OUT, "w") as f:
        f.write("\n".join(lines) + "\n")
    return stamp


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--raw", help="read saved answers from this directory instead of fetching")
    ap.add_argument("--save", help="also save the fetched answers into this directory")
    a = ap.parse_args()
    data = fetch(a.raw)
    if a.save:
        os.makedirs(a.save, exist_ok=True)
        for name, body in data.items():
            with open(os.path.join(a.save, name), "w") as f:
                json.dump(body, f)
    old = previous()
    t = build(data, old)
    for sym in sorted(set(old) | set(t)):
        gone = set(old.get(sym, "").split()) - set(t.get(sym, "").split())
        if gone:
            print(f"dropped: {sym} on {' '.join(sorted(gone))}")
    print(f"{len(t)} symbols on 2+ exchanges, written {write(t)} → {OUT}")
