"""Per-position details (entry price, unrealized PnL, margin, leverage) reach account.json — no network.

What it protects: the 自動下單 › 部位 table shows each position's 開倉均價 / 未實現損益 /
保證金 / 槓桿. Every crypto venue already returns them in the positions call the
reconciler makes; they used to be dropped in lib/account_*.get_positions and again
in runtime/account_reader._norm_positions. A missing value must stay missing (the
page draws "—"), never become 0, and reading one must never fail the row — the
reconciler reads the same rows.

Asserts: each venue's get_positions maps a positions reply shaped like its public
API doc example (values ours) onto entry_price / unrealized_pnl / margin / leverage,
in each margin mode the doc distinguishes; blank / missing fields come back None
and garbage does not raise; paper computes PnL with order_paper._equity's formula
and gives None for an unpriced leg; capital / president carry the worker's average
cost and None for the rest; _norm_positions keeps the five details on the list,
contracts and dict shapes, drops None / NaN, and never multiplies them by mark;
read_venue's entry serializes as strict JSON; every lib/account_*.py names all four
keys (a new venue is covered the day it lands).

Run: cd blave-agent && .venv/bin/python tests/check_position_detail.py
"""
import glob
import json
import math
import os
import sys
import tempfile
import types

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
sys.path.insert(0, os.path.join(ROOT, "runtime"))
os.chdir(tempfile.mkdtemp(prefix="pos-detail-"))  # guard's state/ lands here

from lib import (account_binance, account_bingx, account_bybit, account_capital,  # noqa: E402
                 account_gateio, account_okx, account_paper, account_president)
import account_reader  # noqa: E402

DETAILS = ("entry_price", "unrealized_pnl", "margin", "leverage")
fails = 0


def check(cond, msg):
    global fails
    print(("ok   " if cond else "FAIL ") + msg)
    fails += 0 if cond else 1


def close(a, b):
    return a is not None and b is not None and math.isclose(a, b, rel_tol=1e-9, abs_tol=1e-12)


def by_symbol(rows):
    return {r["symbol"]: r for r in rows}


# ── Binance  GET /fapi/v2/positionRisk (binance-connector-js PositionInformationV2ResponseInner)
BINANCE = [
    {"symbol": "BTCUSDT", "positionAmt": "0.010", "entryPrice": "60000.0", "breakEvenPrice": "60030.0",
     "markPrice": "61000.0", "unRealizedProfit": "10.00000000", "liquidationPrice": "0",
     "leverage": "10", "maxNotionalValue": "20000000", "marginType": "cross",
     "isolatedMargin": "0.00000000", "isAutoAddMargin": "false", "positionSide": "BOTH",
     "notional": "610.00000000", "isolatedWallet": "0", "updateTime": 1700000000000},
    {"symbol": "ETHUSDT", "positionAmt": "-0.500", "entryPrice": "3000.0", "breakEvenPrice": "2998.5",
     "markPrice": "2900.0", "unRealizedProfit": "50.00000000", "liquidationPrice": "3500",
     "leverage": "5", "maxNotionalValue": "5000000", "marginType": "isolated",
     "isolatedMargin": "350.00000000", "isAutoAddMargin": "false", "positionSide": "SHORT",
     "notional": "-1450.00000000", "isolatedWallet": "300.00000000", "updateTime": 1700000000000},
    {"symbol": "SOLUSDT", "positionAmt": "1", "markPrice": "150.0", "positionSide": "BOTH",
     "entryPrice": "", "unRealizedProfit": "abc", "leverage": None, "notional": "150"},
]
account_binance._signed = lambda method, base, path, env, params=None: BINANCE
b = by_symbol(account_binance.get_positions({}))
check(close(b["BTCUSDT"]["entry_price"], 60000) and close(b["BTCUSDT"]["unrealized_pnl"], 10)
      and close(b["BTCUSDT"]["leverage"], 10) and close(b["BTCUSDT"]["margin"], 61.0),
      f"binance cross: entryPrice / unRealizedProfit / leverage, margin = |notional| ÷ leverage ({b['BTCUSDT']})")
check(close(b["ETHUSDT"]["margin"], 300) and close(b["ETHUSDT"]["unrealized_pnl"], 50)
      and b["ETHUSDT"]["side"] == "short" and close(b["ETHUSDT"]["leverage"], 5),
      f"binance isolated: margin = isolatedWallet, not isolatedMargin ({b['ETHUSDT']})")
check(all(b["SOLUSDT"][k] is None for k in DETAILS) and b["SOLUSDT"]["size"] == 1.0,
      f"binance: blank / garbage / missing details are None, the row itself survives ({b['SOLUSDT']})")

# ── BingX  GET /openApi/swap/v2/user/positions (bingx-api/api-ai-skills swap-account example)
BINGX = [
    {"positionId": "1735*****52", "symbol": "BNB-USDT", "currency": "USDT", "positionAmt": "0.20",
     "availableAmt": "0.20", "positionSide": "SHORT", "isolated": True, "avgPrice": "246.43",
     "initialMargin": "9.7914", "leverage": 5, "unrealizedProfit": "-0.0653",
     "realisedProfit": "-0.0251", "liquidationPrice": 294.17, "markPrice": "246.75"},
    {"positionId": "2", "symbol": "BTC-USDT", "positionAmt": "0.001", "positionSide": "LONG",
     "markPrice": "60000", "avgPrice": "0", "initialMargin": "", "unrealizedProfit": None},
    {"positionId": "3", "symbol": "ETH-USDT", "positionAmt": "0.1", "positionSide": "LONG",
     "avgPrice": "3000", "leverage": 3},
]
account_bingx._signed_get = lambda path, env, params=None, bare=False: BINGX
account_bingx._public_get = lambda path, params=None: []
x = by_symbol(account_bingx.get_positions({}))
check(close(x["BNBUSDT"]["entry_price"], 246.43) and close(x["BNBUSDT"]["unrealized_pnl"], -0.0653)
      and close(x["BNBUSDT"]["margin"], 9.7914) and close(x["BNBUSDT"]["leverage"], 5),
      f"bingx: avgPrice / unrealizedProfit / initialMargin / leverage ({x['BNBUSDT']})")
check(all(x["BTCUSDT"][k] is None for k in DETAILS),
      f"bingx: avgPrice 0, blank margin, null PnL, no leverage → None, not 0 ({x['BTCUSDT']})")
check(x["ETHUSDT"]["mark_price"] == 3000.0 and x["ETHUSDT"]["mark_estimated"] is True
      and x["BNBUSDT"]["mark_estimated"] is False,
      f"bingx: no markPrice anywhere → avgPrice sizes the row, flagged as a stand-in ({x['ETHUSDT']})")

# ── Bybit  GET /v5/position/list (bybit-exchange.github.io/docs/v5/position example, linear)
BYBIT = {"list": [
    {"positionIdx": 0, "symbol": "BTCUSDT", "side": "Sell", "size": "0.3", "avgPrice": "27464.5",
     "positionValue": "8239.35", "tradeMode": 0, "leverage": "10", "markPrice": "28224.50",
     "positionIM": "823.935", "positionIMByMp": "823.935", "positionMM": "41.2",
     "unrealisedPnl": "-228.0", "curRealisedPnl": "0.13"},
    {"positionIdx": 0, "symbol": "ETHUSDT", "side": "Buy", "size": "1", "avgPrice": "3000",
     "leverage": "", "markPrice": "3100", "positionIM": "", "unrealisedPnl": "100"},
]}
account_bybit._request = lambda env, method, path, params=None, body=None, **k: BYBIT
y = by_symbol(account_bybit.get_positions({}))
check(close(y["BTCUSDT"]["entry_price"], 27464.5) and close(y["BTCUSDT"]["unrealized_pnl"], -228)
      and close(y["BTCUSDT"]["margin"], 823.935) and close(y["BTCUSDT"]["leverage"], 10),
      f"bybit: avgPrice / unrealisedPnl / positionIM / leverage ({y['BTCUSDT']})")
check(y["ETHUSDT"]["margin"] is None and y["ETHUSDT"]["leverage"] is None
      and close(y["ETHUSDT"]["unrealized_pnl"], 100),
      f"bybit portfolio margin: positionIM / leverage \"\" → None ({y['ETHUSDT']})")

# ── OKX  GET /api/v5/account/positions (okx.com/docs-v5 Get positions example, as SWAP)
OKX = [
    {"instId": "BTC-USDT-SWAP", "instType": "SWAP", "mgnMode": "cross", "posSide": "net",
     "pos": "2", "avgPx": "62961.4", "markPx": "62891.9", "lever": "5", "margin": "999",
     "imr": "251.57", "notionalUsd": "1257.8", "upl": "-1.39"},
    {"instId": "ETH-USDT-SWAP", "instType": "SWAP", "mgnMode": "isolated", "posSide": "short",
     "pos": "3", "avgPx": "3000", "markPx": "2950", "lever": "3", "margin": "295.0",
     "imr": "777", "notionalUsd": "88.5", "upl": "1.5"},
    {"instId": "SOL-USD-SWAP", "instType": "SWAP", "mgnMode": "cross", "posSide": "net",
     "pos": "1", "avgPx": "150", "markPx": "151", "lever": "10", "margin": "",
     "imr": "0.066", "notionalUsd": "10", "upl": "0.0004", "ccy": "SOL"},
]
account_okx._request = lambda env, method, path, body=None, **k: OKX
account_okx._ct_val = lambda env, inst_id: 0.01
o = by_symbol(account_okx.get_positions({}))
check(close(o["BTCUSDT"]["entry_price"], 62961.4) and close(o["BTCUSDT"]["unrealized_pnl"], -1.39)
      and close(o["BTCUSDT"]["margin"], 251.57) and close(o["BTCUSDT"]["leverage"], 5),
      f"okx cross: avgPx / upl / imr / lever — imr even when `margin` is filled ({o['BTCUSDT']})")
check(o["SOLUSD"]["unrealized_pnl"] is None and o["SOLUSD"]["margin"] is None
      and close(o["SOLUSD"]["entry_price"], 150) and close(o["SOLUSD"]["leverage"], 10),
      f"okx coin-margined swap: PnL / margin are in SOL, not USDT → None ({o['SOLUSD']})")
check(close(o["ETHUSDT"]["margin"], 295) and close(o["ETHUSDT"]["leverage"], 3),
      f"okx isolated: margin from `margin`, never imr ({o['ETHUSDT']})")

# ── Gate  GET /futures/usdt/positions (gateapi-python docs/Position.md fields)
GATE = [
    {"contract": "BTC_USDT", "size": 10, "mode": "single", "leverage": "0",
     "cross_leverage_limit": "20", "entry_price": "60000", "mark_price": "61000",
     "unrealised_pnl": "10", "margin": "30.5", "initial_margin": "30.5", "value": "610"},
    {"contract": "ETH_USDT", "size": -5, "mode": "dual_short", "leverage": "5",
     "cross_leverage_limit": "0", "entry_price": "3000", "mark_price": "2900",
     "unrealised_pnl": "5", "margin": "0", "initial_margin": "29", "value": "145"},
]
account_gateio._request = lambda env, method, path, query="", body=None, **k: GATE
account_gateio._multiplier = lambda env, contract: 0.0001 if contract == "BTC_USDT" else 0.01
g = by_symbol(account_gateio.get_positions({}))
check(close(g["BTCUSDT"]["leverage"], 20) and close(g["BTCUSDT"]["margin"], 30.5)
      and close(g["BTCUSDT"]["entry_price"], 60000) and close(g["BTCUSDT"]["unrealized_pnl"], 10),
      f"gate cross: leverage \"0\" → cross_leverage_limit ({g['BTCUSDT']})")
check(close(g["ETHUSDT"]["leverage"], 5) and close(g["ETHUSDT"]["margin"], 29),
      f"gate: margin 0 falls back to initial_margin ({g['ETHUSDT']})")

# ── Paper  (order_paper.snapshot rows)
account_paper._paper.snapshot = lambda env: {"positions": [
    {"symbol": "BTCUSDT", "side": "short", "size": 0.5, "entry_price": 60000.0,
     "mark_price": 58000.0, "priced": True},
    {"symbol": "TXF", "side": "long", "size": 2.0, "entry_price": 22000.0, "mark_price": 22100.0,
     "priced": True, "unit": "contracts", "contract_value": 200.0, "margin": 350000.0},
    {"symbol": "GONEUSDT", "side": "long", "size": 3.0, "entry_price": 10.0, "mark_price": 10.0,
     "priced": False},
    {"symbol": "BADUSDT", "side": "long", "size": 1.0, "entry_price": "x", "mark_price": 5.0,
     "priced": True},
]}
pp = by_symbol(account_paper.get_positions({}))
check(close(pp["BTCUSDT"]["unrealized_pnl"], 1000.0) and pp["BTCUSDT"]["margin"] is None
      and pp["BTCUSDT"]["leverage"] is None and close(pp["BTCUSDT"]["entry_price"], 60000),
      f"paper notional short: PnL (mark − entry) × qty, no margin, no leverage ({pp['BTCUSDT']})")
check(close(pp["TXF"]["unrealized_pnl"], 100 * 2 * 200) and close(pp["TXF"]["margin"], 700000)
      and pp["TXF"]["unit"] == "contracts" and pp["TXF"]["leverage"] is None,
      f"paper contracts: PnL × contract_value, margin = lots × per-lot margin ({pp['TXF']})")
check(pp["GONEUSDT"]["unrealized_pnl"] is None and pp["GONEUSDT"]["mark_estimated"] is True
      and pp["BTCUSDT"]["mark_estimated"] is False,
      f"paper: an unpriced leg (mark fell back to entry) has PnL None and a flagged mark ({pp['GONEUSDT']})")
check(pp["BADUSDT"]["entry_price"] is None and pp["BADUSDT"]["unrealized_pnl"] is None
      and pp["BADUSDT"]["size"] == 1.0,
      f"paper: a bad entry value leaves the details None, the row survives ({pp['BADUSDT']})")
src = open(os.path.join(ROOT, "lib", "order_paper.py"), encoding="utf-8").read()
check('"priced": priced' in src, "order_paper.snapshot rows say whether the mark was real")

# ── Capital  (capital_worker snapshot: one row per 買賣別)
CAP = {"positions": [
    {"symbol": "TM2608", "side": "buy", "lots": 1.0, "avg_cost": 22000.0},
    {"symbol": "TM2608", "side": "buy", "lots": 3.0, "avg_cost": 22400.0},
    {"symbol": "TM2608", "side": "sell", "lots": 0.0, "avg_cost": None},
    {"symbol": "TX2608", "side": "buy", "lots": 2.0, "avg_cost": 22000.0},
    {"symbol": "TX2608", "side": "sell", "lots": 1.0, "avg_cost": 22100.0},
    {"symbol": "MX2608", "side": "sell", "lots": 1.0, "avg_cost": None},
]}
account_capital._read_snapshot = lambda: CAP
c = account_capital.get_positions({})
check(close(c["TM2608"]["entry_price"], 22300.0) and c["TM2608"]["size"] == 4.0,
      f"capital: same-side rows → lot-weighted avg_cost, a 0-lot row ignored ({c['TM2608']})")
check(c["TX2608"]["entry_price"] is None and c["TX2608"]["size"] == 1.0,
      f"capital: buy and sell rows on one symbol → no entry price for the net ({c['TX2608']})")
check(c["MX2608"]["entry_price"] is None and c["MX2608"]["side"] == "short",
      f"capital: no avg_cost → None ({c['MX2608']})")
check(all(c[s][k] is None for s in c for k in ("unrealized_pnl", "margin", "leverage")),
      "capital: PnL / margin / leverage are None this version")

# ── President  (president_worker snapshot rows via bot_position_rows)
PRES = [
    {"root": "TXF", "productid": "TXFK6", "net": -2, "avg_cost_buy": 0.0,
     "avg_cost_sell": 22150.0, "floating_pnl": 1200.0, "point_value": 200},
    {"root": "MXF", "productid": "MXFK6", "net": 1, "avg_cost_buy": 0.0,
     "avg_cost_sell": 0.0, "floating_pnl": 0.0, "point_value": 50},
    {"root": "TMF", "productid": "TMFK6", "net": 1, "avg_cost_buy": 22100.0,
     "avg_cost_sell": 22000.0, "floating_pnl": 0.0, "point_value": 10},
]
account_president.bot_position_rows = lambda now=None, book_months=None: PRES
pr = account_president.get_positions({})
check(close(pr["TXF"]["entry_price"], 22150.0) and pr["TXF"]["productid"] == "TXFK6"
      and pr["TXF"]["unrealized_pnl"] is None,
      f"president short: avg_cost_sell; floating_pnl not shipped until matched with the app ({pr['TXF']})")
check(pr["MXF"]["entry_price"] is None, f"president: avg cost 0 → None ({pr['MXF']})")
check(pr["TMF"]["entry_price"] is None and pr["TMF"]["size"] == 1.0,
      f"president: both sides carry a cost → no entry price for the net, as capital ({pr['TMF']})")

# ── runtime/account_reader._norm_positions
rows = account_reader._norm_positions([
    {"symbol": "BTCUSDT", "side": "long", "size": 0.5, "mark_price": 80000.0,
     "entry_price": 78000.0, "unrealized_pnl": 1000.0, "margin": 4000.0, "leverage": 10.0},
    {"symbol": "ETHUSDT", "side": "short", "size": 1.0, "mark_price": 3000.0,
     "entry_price": None, "unrealized_pnl": float("nan"), "margin": float("inf")},
    {"symbol": "TXF", "side": "long", "size": 2.0, "mark_price": 22000.0, "unit": "contracts",
     "contract_value": 200.0, "entry_price": 21900.0, "unrealized_pnl": 40000.0,
     "margin": 700000.0, "leverage": None},
])
check(rows["BTCUSDT"] == {"side": "long", "size": 40000.0, "mark_price": 80000.0,
                          "entry_price": 78000.0, "unrealized_pnl": 1000.0, "margin": 4000.0,
                          "leverage": 10.0},
      f"list shape: details carried as-is, only size is × mark ({rows['BTCUSDT']})")
check(rows["ETHUSDT"] == {"side": "short", "size": 3000.0, "mark_price": 3000.0},
      f"list shape: None / NaN / inf details leave the key out ({rows['ETHUSDT']})")
fill = account_reader._norm_positions([
    {"symbol": "NOMARK", "side": "long", "size": 1.0, "mark_price": 0.0, "entry_price": 9.0},
    {"symbol": "STANDIN", "side": "long", "size": 2.0, "mark_price": 10.0, "mark_estimated": True,
     "entry_price": 10.0}])
check("mark_price" not in fill["NOMARK"] and "mark_price" not in fill["STANDIN"]
      and fill["STANDIN"]["size"] == 20.0 and "mark_estimated" not in fill["STANDIN"],
      f"a 0 or stand-in mark sizes the row but is not shown as the mark ({fill})")
check(rows["TXF"] == {"side": "long", "size": 2.0, "unit": "contracts", "contract_value": 200.0,
                      "mark_price": 22000.0, "entry_price": 21900.0, "unrealized_pnl": 40000.0,
                      "margin": 700000.0},
      f"contracts row: lots stay lots, details kept ({rows['TXF']})")
d = account_reader._norm_positions({"TXF": {"side": "short", "size": 2.0, "productid": "TXFK6",
                                            "entry_price": 22150.0, "unrealized_pnl": None,
                                            "margin": None, "leverage": None}})
check(d == {"TXF": {"side": "short", "size": 2.0, "entry_price": 22150.0}},
      f"dict shape: entry_price kept, None details absent ({d})")

# ── read_venue → account.json entry (what portfolio_reporter ships verbatim)
fake = types.ModuleType("lib.account_posdetailfake")
fake.get_equity = lambda env: {"equity": 1000.0, "currency": "USDT"}
fake.get_positions = lambda env: [{"symbol": "BTCUSDT", "side": "long", "size": 0.01,
                                   "mark_price": 61000.0, "entry_price": 60000.0,
                                   "unrealized_pnl": 10.0, "margin": float("nan"), "leverage": 10.0}]
sys.modules["lib.account_posdetailfake"] = fake
entry = account_reader.read_venue("posdetailfake", {})
pos = (entry.get("positions") or {}).get("BTCUSDT")
try:
    wire = json.loads(json.dumps(entry, allow_nan=False))
except ValueError as e:
    wire = None
    check(False, f"read_venue entry is strict JSON ({e})")
check(entry["ok"] is True and wire is not None
      and wire["positions"]["BTCUSDT"] == {"side": "long", "size": 610.0, "mark_price": 61000.0,
                                           "entry_price": 60000.0, "unrealized_pnl": 10.0,
                                           "leverage": 10.0},
      f"read_venue: positions keyed by symbol with the details, NaN margin dropped ({pos})")

# ── every account lib names all four details (exempt: none)
EXEMPT = set()
for path in sorted(glob.glob(os.path.join(ROOT, "lib", "account_*.py"))):
    name = os.path.basename(path)[:-3]
    if name == "account_TEMPLATE" or name in EXEMPT:
        continue
    text = open(path, encoding="utf-8").read()
    body = text[text.find("def get_positions("):]
    body = body[:body.find("\ndef ", 1)] if "\ndef " in body[1:] else body
    missing = [k for k in DETAILS if f'"{k}"' not in body and f"{k}=" not in body]
    check(not missing, f"{name}.get_positions names every detail (missing {missing})")

print()
print("PASS" if fails == 0 else f"FAIL ({fails})")
sys.exit(1 if fails else 0)
