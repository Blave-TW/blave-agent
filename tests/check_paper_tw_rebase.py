"""Upgrade to the unadjusted TW close: a paper TW row booked while paper valued it at the
strategy's dividend-adjusted close is restated once (lib/order_paper._rebase_tw_rows), so
the switch neither drops equity by the adjustment factor (audit 0127-crossfix X3: −12.2%)
nor turns into a realized loss at the close. Offline: every price and rate is stubbed.

Run: cd blave-agent && .venv/bin/python tests/check_paper_tw_rebase.py
"""
import json, os, sys, tempfile, time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
os.chdir(tempfile.mkdtemp(prefix="papertw-rebase-"))
for d in ("state", "strategies/tw_a", "strategies/tw_c"):
    os.makedirs(d, exist_ok=True)
RAW = {"2330": 2420.0, "2454": 1255.0, "2317": 201.5, "6488": 700.0}
ADJ = 1.1388
open("strategies/tw_a/strategy.py", "w").write(f'''SYMBOL = "2330"
MARKET = "swap"
INTERVAL = "1d"


def fetch_data(hdrs):
    import os
    import pandas as pd
    if os.path.exists("state/owner_down"):
        raise RuntimeError("owner feed down")
    px = {RAW["2330"]} * {ADJ}
    return pd.DataFrame({{"Open": px, "Close": px}}, index=[pd.Timestamp.now().floor("D")])
''')
open("strategies/tw_c/strategy.py", "w").write('MARKET = "spot"\nSTART = "2020-01-01"\n\n'
                                               'def fetch_data(hdrs):\n    raise RuntimeError("never")\n')
json.dump({"type": "portfolio", "market": "spot", "weights": {"2454": 0.5, "2317": 0.5}},
          open("strategies/tw_c/state.json", "w"))

import pandas as pd  # noqa: E402
from lib import data, order_paper, paper_data  # noqa: E402

fails = 0


def check(cond, msg):
    global fails
    print(("ok   " if cond else "FAIL ") + msg)
    fails += 0 if cond else 1


def offline(*a, **k):
    raise OSError("no network in this test")


adj_starts = []


def daily(adjusted):
    def f(code, start, end, hdrs):
        if adjusted:
            adj_starts.append((code, start))
        px = RAW[code] * (ADJ if adjusted else 1.0)
        return pd.DataFrame({"Open": px, "Close": px}, index=[pd.Timestamp.now().floor("D")])
    return f


paper_data._fetch_fx = offline
data.fetch_twstock_price = daily(False)
data.fetch_twstock_price_adj = daily(True)
order_paper.tw_session_open = lambda env=None, now=None: True
R = 32.0
json.dump({"rates": {"TWD": R}, "ts": int(time.time())}, open("state/paper_fx.json", "w"))
ENV = {"PAPER_API_KEY": "paper", "PAPER_SECRET_KEY": "paper", "PAPER_BOUND_TS": "1",
       "PAPER_INITIAL_EQUITY": "200000"}
audits = []
order_paper.guard.audit = lambda ev, **f: audits.append((ev, f))


def led():
    return json.load(open(order_paper.LEDGER_PATH))


def put(l):
    json.dump(l, open(order_paper.LEDGER_PATH, "w"))
    paper_data._price_cache.clear()


def equity():
    paper_data._price_cache.clear()
    return float(order_paper.snapshot(ENV)["equity"])


def rebases():
    return [f for ev, f in audits if ev == "paper_tw_rebase"]


order_paper.snapshot(ENV)   # seed the ledger
L = led()
cash0 = L["cash"]
# as 0.1.26 booked them: a swap 2330 row entered at its adjusted close (marked 5% up since),
# and 2454 / 2317 shares bought at the adjusted close (the cost left the cash at that price)
entry = RAW["2330"] * ADJ / 1.05
L["positions"]["2330"] = {"qty": 400.0, "entry": entry, "quote_ccy": "TWD", "fx": R}
L["spot"].update({"2454": 398.0, "2317": 2481.0})
L["spot_fx"] = {"2454": R, "2317": R}
L["cash"] = cash0 - (398 * RAW["2454"] + 2481 * RAW["2317"]) * ADJ / R
# a Type B stop 5% under the adjusted mark and a resting buy 3% under it: on the raw scale
# both would fire at once unless restated with the row
L["protective"]["2330"] = {"sl": RAW["2330"] * ADJ * 0.95, "tp": None, "ts": 1}
L["orders"]["P99999999"] = {"order_id": "P99999999", "client_order_id": "", "symbol": "2330",
                            "market": "swap", "side": "buy", "direction": "long", "type": "limit",
                            "price": RAW["2330"] * ADJ * 0.97, "orig_qty": 5.0, "executed_qty": 0.0,
                            "avg_price": 0.0, "commission": 0.0, "status": "open",
                            "reduce_only": False, "post_only": False, "ts": 1}
put(L)
cash_old = L["cash"]
old_equity = (cash_old + (RAW["2330"] * ADJ - entry) * 400 / R
              + (398 * RAW["2454"] + 2481 * RAW["2317"]) * ADJ / R)
fills_before = len(L["fills"])

print("== the first read restates every unmarked TW row once")
e1 = equity()
L = led()
row = L["positions"]["2330"]
f = 1 / ADJ
upnl_old = (RAW["2330"] * ADJ - entry) * 400 / R
check(abs(row["entry"] - entry * f) < 1e-6 and row.get("px_basis") == "raw",
      f"swap 2330: entry × raw/adjusted ({entry:.2f} → {row['entry']:.2f}), marked raw")
check(abs(e1 - (old_equity + (f - 1) * upnl_old)) < 0.05,
      f"equity moves only by the open PnL's scale ({old_equity:.2f} → {e1:.2f}; "
      f"without the rebase {old_equity - (RAW['2330'] * ADJ - RAW['2330']) * 400 / R - (398 * RAW['2454'] + 2481 * RAW['2317']) * (ADJ - 1) / R:.2f})")
want_refund = (398 * RAW["2454"] + 2481 * RAW["2317"]) * (ADJ - 1) / R
check(abs(L["cash"] - (cash_old + want_refund)) < 1e-6,
      f"spot holdings: qty × (adjusted − raw) back in cash ({L['cash'] - cash_old:.2f} = {want_refund:.2f})")
check(L.get("spot_px_basis") == {"2454": "raw", "2317": "raw"}, f"spot holdings marked ({L.get('spot_px_basis')})")
check(L["spot"] == {"2454": 398.0, "2317": 2481.0} and row["qty"] == 400.0, "no quantity changed")
check(len(L["fills"]) == fills_before, "no fill written (no realized PnL)")
check(abs(L["protective"]["2330"]["sl"] - RAW["2330"] * 0.95) < 1e-6,
      f"the stop is restated with the row and does not fire ({L['protective'].get('2330')})")
check(L["orders"]["P99999999"]["status"] == "open" and abs(L["orders"]["P99999999"]["price"] - RAW["2330"] * 0.97) < 1e-6,
      f"the resting limit is restated and still rests ({L['orders']['P99999999']['price']:.2f})")
L["orders"]["P99999999"]["status"] = "canceled"
L["protective"].pop("2330")
put(L)
rb = rebases()
check(sorted((r["symbol"], r["market"]) for r in rb) == [("2317", "spot"), ("2330", "swap"), ("2454", "spot")],
      f"one paper_tw_rebase audit per row ({[(r['symbol'], r['factor']) for r in rb]})")
check(all(c[1] == "2020-01-01" for c in adj_starts) and {c[0] for c in adj_starts} == {"2454", "2317"},
      f"the Type C components at the adjusted close from the basket's START ({adj_starts})")

print("== a second read restates nothing")
audits.clear()
e2 = equity()
check(not rebases() and abs(e2 - e1) < 1e-6 and abs(led()["positions"]["2330"]["entry"] - entry * f) < 1e-6,
      f"idempotent ({e1:.2f} / {e2:.2f})")

print("== closing the restated swap row realizes the move since entry, not the factor")
r = order_paper.place_market_order(ENV, "2330", "long", 400.0, reduce_only=True)
fill = led()["fills"][-1]
check(bool(r) and abs(fill["realized"] - upnl_old * f) < 0.05 and fill["realized"] > 0,
      f"realized {fill['realized']:.2f} USD = the 5% gain at the raw scale ({upnl_old * f:.2f}), not a ~12% loss")

print("== a fill after the switch is marked and never restated")
audits.clear()
order_paper.place_spot_market_order(ENV, "6488", "buy", quote_qty=70000.0)
order_paper.place_market_order(ENV, "2330", "long", 10.0)
L = led()
check(L["spot_px_basis"].get("6488") == "raw" and L["positions"]["2330"].get("px_basis") == "raw",
      "new spot and swap TW rows carry the marker")
e3 = equity()
check(not rebases() and abs(L["positions"]["2330"]["entry"] - RAW["2330"]) < 1e-9, "not restated")
order_paper.place_spot_market_order(ENV, "6488", "sell", base_qty=100.0)
check("6488" not in led().get("spot_px_basis", {}), "selling a holding out drops its marker")

print("== an owner whose price cannot be read: the row waits, at most hourly, then is restated")
L = led()
L["positions"]["2330"].pop("px_basis")
put(L)
open("state/owner_down", "w").write("1")
audits.clear()
equity()
L = led()
check("px_basis" not in L["positions"]["2330"] and "2330" in L.get("tw_rebase_wait", {}) and not rebases(),
      f"not marked, waiting ({L.get('tw_rebase_wait')})")
os.remove("state/owner_down")
equity()
check("px_basis" not in led()["positions"]["2330"], "inside the hour: not retried")
L = led()
L["tw_rebase_wait"]["2330"] = int(time.time()) - order_paper.TW_REBASE_RETRY_S - 1
put(L)
equity()
L = led()
check(L["positions"]["2330"].get("px_basis") == "raw" and "tw_rebase_wait" not in L and len(rebases()) == 1,
      "after the hour: restated, the wait cleared")

print("== a TW row nobody owns: marked, nothing to restate")
L = led()
L["spot"]["9999"] = 10.0
put(L)
RAW["9999"] = 30.0
audits.clear()
cash = L["cash"]
equity()
L = led()
check(L["spot_px_basis"].get("9999") == "raw" and L["cash"] == cash and not rebases(), "no owner: marked only")

print("== a factor no adjustment can give (owner's Close is not the price): marked, not restated")
L = led()
L["positions"]["2330"].pop("px_basis")
e_before = L["positions"]["2330"]["entry"]
put(L)
open("strategies/tw_a/strategy.py", "a").write("\n\ndef fetch_data(hdrs):\n    import pandas as pd\n"
                                              "    return pd.DataFrame({'Close': [1.02]}, index=[pd.Timestamp.now().floor('D')])\n")
paper_data._mod_cache.clear()
audits.clear()
equity()
L = led()
skipped = [f for f in rebases() if f.get("skipped")]
check(L["positions"]["2330"].get("px_basis") == "raw" and L["positions"]["2330"]["entry"] == e_before and len(skipped) == 1,
      f"factor 2420/1.02 out of range: entry kept, marked, audited as skipped ({skipped})")

print("== crypto rows are untouched")
L = led()
L["positions"]["BTCUSDT"] = {"qty": 1.0, "entry": 50000.0}
put(L)
data.fetch_kline = lambda *a, **k: pd.DataFrame({"Close": [50000.0]}, index=[pd.Timestamp.now()])
equity()
check("px_basis" not in led()["positions"]["BTCUSDT"], "no marker on a crypto row")

print("ALL OK" if not fails else f"FAILED: {fails}")
sys.exit(1 if fails else 0)
