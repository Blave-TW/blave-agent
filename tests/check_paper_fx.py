"""Paper contract money is TWD, the paper account is USD: lib/order_paper books
TXF realized PnL, fee and margin ÷ lib/paper_data.usd_rate (1 USD = N TWD).

Run: cd blave-agent && .venv/bin/python tests/check_paper_fx.py
"""
import json, os, shutil, sys, tempfile, time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
os.chdir(tempfile.mkdtemp(prefix="paperfx-"))
os.makedirs("strategies/txf_px", exist_ok=True)
os.makedirs("state", exist_ok=True)
open("strategies/txf_px/strategy.py", "w").write('''STRATEGY_NAME = "txf_px"
SYMBOL = "TXF"


def fetch_data(hdrs):
    import pandas as pd
    px = float(open("state/mark.txt").read())
    idx = pd.date_range(end=pd.Timestamp.now().floor("min"), periods=2, freq="min")
    return pd.DataFrame({"Close": px}, index=idx)
''')

from lib import order_paper, paper_data  # noqa: E402

sys.path.insert(0, os.path.join(ROOT, "tests"))
import paper_market  # noqa: E402

paper_market.install()

fails = 0


def check(cond, msg):
    global fails
    print(("ok   " if cond else "FAIL ") + msg)
    fails += 0 if cond else 1


def offline():
    raise OSError("no network in this test")


paper_data._fetch_fx = lambda env: offline()
ENV = {"PAPER_API_KEY": "paper", "PAPER_SECRET_KEY": "paper", "PAPER_BOUND_TS": "1",
       "PAPER_INITIAL_EQUITY": "100000"}
CV, MARGIN, FEE = 200, 701000, order_paper.TAKER_FEE


def mark(px):
    open("state/mark.txt", "w").write(str(px))
    paper_data._price_cache.clear()


def rate(r):
    json.dump({"rates": {"TWD": r}, "ts": int(time.time())}, open("state/paper_fx.json", "w"))
    paper_data._fx_cache.clear()
    paper_data._fx_failed_at[0] = 0.0


def no_rate():
    if os.path.exists(paper_data.FX_PATH):
        os.remove(paper_data.FX_PATH)
    paper_data._fx_cache.clear()
    paper_data._fx_failed_at[0] = 0.0


def snap():
    return order_paper.snapshot(ENV)


print("== currency of contract money")
check([paper_data.quote_ccy(s) for s in ("TXF", "MXF", "TMFR1", "2330", "6488.TWO", "BTCUSDT")]
      == ["TWD"] * 5 + ["USD"], "TXF family and TW codes are TWD, crypto USD")
check(paper_data.quote_ccy("TXF", "twd") == "TWD" and paper_data.quote_ccy("X", "USDT") == "USD",
      "a spec's currency wins; USDT/USDC count as USD")

print("== one TXF lot, +100 points at 32.125")
R = 32.125
rate(R)
mark(20000)
cash0 = snap()["cash"]
order_paper.place_contract_market_order(ENV, "TXF", "long", 1, CV, margin=MARGIN, currency="TWD")
s = snap()
fee_in = 20000 * CV * FEE / R
check(abs((cash0 - s["cash"]) - fee_in) < 1e-9, f"entry fee is TWD ÷ rate ({cash0 - s['cash']:.6f} vs {fee_in:.6f})")
row = s["positions"][0]
check(row["quote_ccy"] == "TWD" and row["margin"] == MARGIN and row["entry_price"] == 20000,
      "row keeps TWD per-lot margin and index-point entry")
mark(20100)
s = snap()
check(abs(s["unrealized"] - 20000 / R) < 1e-9, f"open PnL 100 × 200 TWD = {20000 / R:.6f} USD ({s['unrealized']:.6f})")
check(abs(s["equity"] - (s["cash"] + 20000 / R)) < 1e-9, "equity folds the TWD open PnL into USD")
cash1 = s["cash"]
order_paper.place_contract_market_order(ENV, "TXF", "long", 1, CV, reduce_only=True)
s = snap()
fill = s["fills"][-1]
check(abs(fill["realized"] - 20000 / R) < 1e-9 and fill["ccy"] == "TWD" and fill["fx"] == R,
      f"realized 20,000 TWD = {20000 / R:.6f} USD within rate precision ({fill['realized']!r})")
fee_out = 20100 * CV * FEE / R
check(abs((s["cash"] - cash1) - (20000 / R - fee_out)) < 1e-9, "cash moves by realized − fee, both USD")
check(abs(s["cash"] - cash0 - (20000 / R - fee_in - fee_out)) < 1e-9 and s["positions"] == [],
      "round trip: flat, +20,000 TWD less fees in USD — not +20,000 USD")

print("== margin check is per-lot TWD ÷ rate against USD equity")
rate(32.0)
mark(20000)
try:
    order_paper.place_contract_market_order(ENV, "TXF", "long", 5, CV, margin=MARGIN)
    msg = None
except order_paper.PaperError as e:
    msg = str(e)
check(msg and "contract margin 109531 exceeds" in msg, f"5 lots = 109,531 USD > ~100,000 refused ({msg})")
check(order_paper.place_contract_market_order(ENV, "TXF", "long", 4, CV, margin=MARGIN)["executed_qty"] == 4.0,
      "4 lots = 87,625 USD fit")

print("== rate moves: realized at the closing rate; no rate: entry refused, close still goes")
mark(20050)
no_rate()
try:
    order_paper.place_contract_market_order(ENV, "TXF", "long", 1, CV, margin=MARGIN)
    msg = None
except order_paper.PaperError as e:
    msg = str(e)
check(msg and "no USD rate for TWD" in msg, f"an entry with no rate anywhere is refused ({msg})")
r = order_paper.place_contract_market_order(ENV, "TXF", "long", 4, CV, reduce_only=True)
fill = snap()["fills"][-1]
check(r and r["executed_qty"] == 4.0 and fill["fx"] == 32.0
      and abs(fill["realized"] - 50 * 4 * CV / 32.0) < 1e-9,
      f"a close with no rate uses the row's own last rate ({fill})")
rate(33.0)
mark(20000)
order_paper.place_contract_market_order(ENV, "TXF", "short", 1, CV, margin=MARGIN)
rate(34.0)
mark(19900)
order_paper.place_contract_market_order(ENV, "TXF", "short", 1, CV, reduce_only=True)
check(abs(snap()["fills"][-1]["realized"] - 100 * CV / 34.0) < 1e-9, "realized uses the rate at the close")

print("== a row opened before FX is stamped once, on the first read with a rate")
no_rate()
with order_paper._txn(ENV) as led:
    led["positions"]["TXF"] = {"qty": 2.0, "entry": 20000.0, "unit": "contracts",
                               "contract_value": 200.0, "margin": 701000.0}
mark(20100)
s = snap()
check(abs(s["unrealized"] - 40000) < 1e-9, "no rate ever: the pre-FX row stays unconverted (old behaviour)")
rate(32.0)
s = snap()
check(abs(s["unrealized"] - 40000 / 32.0) < 1e-9, f"with a rate: open PnL ÷ 32 ({s['unrealized']})")
led = json.load(open(order_paper.LEDGER_PATH))
check(led["positions"]["TXF"].get("quote_ccy") == "TWD" and led["positions"]["TXF"].get("fx") == 32.0,
      "row stamped quote_ccy / fx")
cut = [json.loads(ln) for ln in open("state/audit.jsonl") if '"paper_fx_cutover"' in ln]
check(len(cut) == 1 and cut[0]["upnl_native"] == 40000 and cut[0]["equity_change_usd"] == round(40000 / 32 - 40000, 2),
      f"one paper_fx_cutover audit line with the equity move ({cut})")

print("== a rate outside the TWD sanity band is not a rate")
json.dump({"rates": {"TWD": 0.031}, "ts": int(time.time())}, open("state/paper_fx.json", "w"))
paper_data._fx_cache.clear()
paper_data._fx_failed_at[0] = 0.0
try:
    paper_data.usd_rate("TWD", ENV)
    bad = False
except paper_data.PaperNoFx:
    bad = True
check(bad, "an inverted USDTWD (0.031) is refused")

print("== TAIFEX codes infer TWD; a mislabelled row still closes")
check([paper_data.quote_ccy(s) for s in ("CDF", "CDFR1", "E4F", "TEF", "ETHUSDT", "BTCF")]
      == ["TWD"] * 4 + ["USD", "USD"], "stock / sector futures codes are TWD")
rate(32.0)
mark(20000)
with order_paper._txn(ENV) as led:
    led["positions"]["TXF"] = {"qty": 1.0, "entry": 20000.0, "unit": "contracts", "contract_value": 200.0,
                               "margin": 701000.0, "quote_ccy": "USD", "fx": 1.0}
r = order_paper.place_contract_market_order(ENV, "TXF", "long", 1, CV, reduce_only=True, currency="TWD")
check(r and r["executed_qty"] == 1.0 and not snap()["positions"], "a USD-stamped TXF row closes under a TWD spec")

print("== flip with no rate: the held lots close, only the new leg is refused")
rate(32.0)
order_paper.place_contract_market_order(ENV, "TXF", "long", 2, CV, margin=MARGIN)
no_rate()
r = order_paper.place_contract_market_order(ENV, "TXF", "short", 5, CV, margin=MARGIN)
errs = [json.loads(ln) for ln in open("state/audit.jsonl") if '"order_error"' in ln and "refused: no USD rate" in ln]
check(r and r["executed_qty"] == 2.0 and not snap()["positions"] and errs,
      f"+2 → −3 with no rate: 2 lots closed at the row's fx, 3 refused ({r and r['executed_qty']})")

print("== paper_fx_cutover is written once, after the ledger is saved")
open("state/audit.jsonl", "w").close()
no_rate()
with order_paper._txn(ENV) as led:
    led["positions"]["TXF"] = {"qty": 1.0, "entry": 20000.0, "unit": "contracts",
                               "contract_value": 200.0, "margin": 701000.0}
rate(32.0)
try:
    order_paper.place_contract_market_order(ENV, "TXF", "long", 5, CV, margin=MARGIN)
except order_paper.PaperError:
    pass
snap()
snap()
cut = [ln for ln in open("state/audit.jsonl") if '"paper_fx_cutover"' in ln]
check(len(cut) == 1, f"refused first order, then two reads: one cutover line ({len(cut)})")

print("== half-updated workspace: either side old, crypto and TXF still trade")
import subprocess  # noqa: E402
OLD_REF = "872f591"  # the last commit before contract FX
CHILD = r'''
import json, os, sys, time
sys.path.insert(0, os.getcwd())
os.makedirs("state", exist_ok=True)
from lib import order_paper, paper_data, venue_wiring
sys.path.insert(0, sys.argv[1])
import paper_market
paper_market.install()
paper_data._price_cache.clear()
env = {"PAPER_API_KEY": "paper", "PAPER_SECRET_KEY": "paper", "PAPER_BOUND_TS": "1"}
open("state/mark.txt", "w").write("20000")
json.dump({"rates": {"TWD": 32.0}, "ts": int(time.time())}, open("state/paper_fx.json", "w"))
paper_data._fetch_fx = lambda e: {}
f = order_paper.place_market_order(env, "BTCUSDT", "long", 0.5)
assert f and f["executed_qty"] == 0.5, f
f = order_paper.place_market_order(env, "BTCUSDT", "long", 0.5, reduce_only=True)
assert f and f["executed_qty"] == 0.5 and order_paper.snapshot(env)["positions"] == [], f
spec = {"type": "futures_contracts", "contract_value": 200, "currency": "TWD", "margin": 35050}
r = venue_wiring._paper_contract_order(env, "TXFLOT", 1, spec, False)
assert r and r["executed_qty"] == 1.0, r
r = venue_wiring._paper_contract_order(env, "TXFLOT", -1, spec, True)
assert r and r["executed_qty"] == 1.0, r
print("CHILD OK")
'''
for old_mod in ("paper_data", "order_paper"):
    ws = tempfile.mkdtemp(prefix=f"paperfx-half-{old_mod}-")
    shutil.copytree(os.path.join(ROOT, "lib"), os.path.join(ws, "lib"))
    old = subprocess.run(["git", "-C", ROOT, "show", f"{OLD_REF}:lib/{old_mod}.py"],
                         capture_output=True, text=True)
    if old.returncode:
        check(False, f"git show {OLD_REF}:lib/{old_mod}.py: {old.stderr.strip()}")
        continue
    open(os.path.join(ws, "lib", f"{old_mod}.py"), "w").write(old.stdout)
    os.makedirs(os.path.join(ws, "strategies", "lot_px"))
    open(os.path.join(ws, "strategies", "lot_px", "strategy.py"), "w").write(
        open("strategies/txf_px/strategy.py").read().replace('"TXF"', '"TXFLOT"'))
    os.makedirs(os.path.join(ws, "strategies", "btc_px"))
    open(os.path.join(ws, "strategies", "btc_px", "strategy.py"), "w").write(
        open("strategies/txf_px/strategy.py").read().replace('"TXF"', '"BTCUSDT"'))
    p = subprocess.run([sys.executable, "-c", CHILD, os.path.join(ROOT, "tests")], cwd=ws, capture_output=True, text=True, timeout=120)
    check(p.returncode == 0 and "CHILD OK" in p.stdout,
          f"old lib/{old_mod}.py + the rest new: crypto and TXF lots orders go through "
          f"(exit {p.returncode}) {p.stderr.strip()[-300:]}")
    shutil.rmtree(ws, ignore_errors=True)

print()
print("FAIL" if fails else "PASS")
sys.exit(1 if fails else 0)
