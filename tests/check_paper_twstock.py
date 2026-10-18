"""Paper trades TW stocks (0.1.27): the amount is TWD, so a TW stock's PnL, fee,
spot cost and proceeds are TWD and lib/order_paper books them ÷ the USD rate;
`2330@spot` is inventory of its own code; outside the TWSE session the
reconciler holds TW stock keys and a direct entry is refused; a Type C
stock — Type A, Type C component or nobody's — fills and marks at its
unadjusted daily close (the page's share price), never the strategy's own
adjusted fetch_data. Offline: every price and rate is stubbed.

Run: cd blave-agent && .venv/bin/python tests/check_paper_twstock.py
"""
import json, os, sys, tempfile, time
from datetime import datetime, timedelta, timezone

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
sys.path.insert(0, os.path.join(ROOT, "runtime"))
os.chdir(tempfile.mkdtemp(prefix="papertw-"))
os.makedirs("state", exist_ok=True)
os.makedirs("strategies/tsmc_a", exist_ok=True)
open("strategies/tsmc_a/strategy.py", "w").write('''STRATEGY_NAME = "tsmc_a"
SYMBOL = "2330"


def fetch_data(hdrs):
    import pandas as pd
    px = float(open("state/mark.txt").read()) * 1.1   # adjusted: paper must not fill at it
    idx = pd.date_range(end=pd.Timestamp.now().floor("D"), periods=2, freq="D")
    return pd.DataFrame({"Open": px, "Close": px}, index=idx)
''')
os.makedirs("strategies/tw_basket", exist_ok=True)
open("strategies/tw_basket/strategy.py", "w").write('''STRATEGY_NAME = "tw_basket"
MARKET = "spot"
START  = "2018-01-01"
UNIVERSE = ["2454", "2317"]


def fetch_data(hdrs):
    open("state/basket_fetch_called", "w").write("1")
    raise RuntimeError("a Type C fetch_data must not run for a paper price")
''')
json.dump({"type": "portfolio", "market": "spot", "weights": {"2454": 0.5, "2317": 0.5}},
          open("strategies/tw_basket/state.json", "w"))

import pandas as pd  # noqa: E402
from lib import data, order_paper, paper_data  # noqa: E402

fails = 0


def check(cond, msg):
    global fails
    print(("ok   " if cond else "FAIL ") + msg)
    fails += 0 if cond else 1


def offline(*a, **k):
    raise OSError("no network in this test")


paper_data._fetch_fx = offline
calls = []


def fake_daily(adjusted):
    def f(code, start, end, hdrs):
        calls.append((code, start, adjusted))
        px = float(open("state/mark.txt").read()) if code == "2330" else \
            {"2454": 1500.0, "2317": 200.0, "6488": 700.0}[code]
        if adjusted:
            px *= 1.1
        idx = pd.date_range(end=pd.Timestamp.now().floor("D"), periods=3, freq="D")
        return pd.DataFrame({"Open": px, "Close": px}, index=idx)
    return f


data.fetch_twstock_price_adj = fake_daily(True)
data.fetch_twstock_price = fake_daily(False)
data.fetch_kline = lambda sym, *a, **k: pd.DataFrame(
    {"Close": [50000.0]}, index=[pd.Timestamp.now().floor("min")])
ENV = {"PAPER_API_KEY": "paper", "PAPER_SECRET_KEY": "paper", "PAPER_BOUND_TS": "1",
       "PAPER_INITIAL_EQUITY": "100000"}
R = 32.0
SESSION = [True]
order_paper.tw_session_open = lambda env=None, now=None: SESSION[0]


def mark(px):
    open("state/mark.txt", "w").write(str(px))
    paper_data._price_cache.clear()


def rate(r):
    json.dump({"rates": {"TWD": r}, "ts": int(time.time())}, open("state/paper_fx.json", "w"))
    paper_data._fx_cache.clear()
    paper_data._fx_failed_at[0] = 0.0


def snap():
    return order_paper.snapshot(ENV)


def refused(fn, *a, **k):
    try:
        fn(*a, **k)
        return None
    except order_paper.PaperError as e:
        return str(e)


rate(R)
print("== swap: 100,000 TWD of 2330 at 1,000 is 100 shares; money ÷ 32")
mark(1000)
cash0 = snap()["cash"]
shares = 100000 / 1000
order_paper.place_market_order(ENV, "2330", "long", shares)
s = snap()
fee_in = 100000 * order_paper.TAKER_FEE / R
check(abs((cash0 - s["cash"]) - fee_in) < 1e-9, f"entry fee 50 TWD = {fee_in:.6f} USD ({cash0 - s['cash']:.6f})")
row = s["positions"][0]
check(row["quote_ccy"] == "TWD" and row["size"] == shares, "row is 100 shares, quoted TWD")
mark(1100)
s = snap()
check(abs(s["unrealized"] - 10000 / R) < 1e-9, f"+100 × 100 shares = 10,000 TWD = {10000 / R:.2f} USD open PnL ({s['unrealized']:.4f})")
check(abs(s["equity"] - (s["cash"] + 10000 / R)) < 1e-9, "equity folds it in USD — not +10,000 USD")
from lib import account_paper  # noqa: E402
p = account_paper.get_positions(ENV)[0]
check(abs(p["unrealized_pnl"] - 10000) < 1e-9, "get_positions keeps the row's open PnL in TWD, as a broker reports it")
cash1 = s["cash"]
order_paper.place_market_order(ENV, "2330", "long", shares, reduce_only=True)
s = snap()
fill = s["fills"][-1]
check(abs(fill["realized"] - 10000 / R) < 1e-9 and fill.get("ccy") == "TWD" and fill.get("fx") == R,
      f"realized booked ÷ rate with ccy/fx on the fill ({fill['realized']:.4f})")
check(abs((s["cash"] - cash1) - (10000 / R - 110000 * order_paper.TAKER_FEE / R)) < 1e-9 and s["positions"] == [],
      "close: cash moves by realized − fee, both USD; flat")
check(account_paper.get_equity(ENV)["currency"] == "USDT", "the account stays USD")

print("== crypto is untouched")
mark(1000)
before = snap()["cash"]
order_paper.place_market_order(ENV, "BTCUSDT", "long", 0.1)
s = snap()
check(abs((before - s["cash"]) - 5000 * order_paper.TAKER_FEE) < 1e-9 and "quote_ccy" not in
      json.load(open(order_paper.LEDGER_PATH))["positions"]["BTCUSDT"], "BTC fee in USD, row not stamped")
order_paper.place_market_order(ENV, "BTCUSDT", "long", 0.1, reduce_only=True)

print("== no rate: a TW entry is refused, a TW close still goes")
order_paper.place_market_order(ENV, "2330", "long", 10)
os.remove(paper_data.FX_PATH)
paper_data._fx_cache.clear()
paper_data._fx_failed_at[0] = 0.0
msg = refused(order_paper.place_market_order, ENV, "2330", "long", 10)
check(msg and "no USD rate for TWD" in msg, f"entry refused ({msg})")
check(order_paper.place_market_order(ENV, "2330", "long", 10, reduce_only=True)["executed_qty"] == 10.0,
      "reduce closes on the row's own fx")
rate(R)

print("== spot: 2330@spot is its own inventory; cost and proceeds ÷ 32")
from lib import venue_wiring  # noqa: E402
check(venue_wiring._spot_base("2330") == "2330" and venue_wiring._spot_base("BTCUSDT") == "BTC"
      and order_paper._spot_base("6488.TWO") == "6488.TWO", "wiring and paper take a TW code as its own base")
cash0 = snap()["cash"]
order_paper.place_spot_market_order(ENV, "2330", "buy", quote_qty=100000)
s = snap()
cost = 100000 / R * (1 + order_paper.SPOT_FEE)
check(abs((cash0 - s["cash"]) - cost) < 1e-9, f"buy 100,000 TWD costs {cost:.4f} USD ({cash0 - s['cash']:.4f})")
check(abs(order_paper.get_spot_balances(ENV)["2330"] - 100) < 1e-9, "100 shares held under '2330'")
mark(1100)
s = snap()
check(abs(s["spot_value"] - 110000 / R) < 1e-9 and abs(s["spot"]["2330"]["usd_value"] - 110000 / R) < 1e-9
      and s["spot"]["2330"]["price"] == 1100, "inventory valued 110,000 TWD ÷ 32 in equity; price stays TWD")
h = [x for x in account_paper.get_holdings(ENV) if x["asset"] == "2330"][0]
check(abs(h["usdt_value"] - 110000 / R) < 1e-9, "holdings usdt_value is USD")
cash1 = s["cash"]
order_paper.place_spot_market_order(ENV, "2330", "sell", base_qty=100)
s = snap()
check(abs((s["cash"] - cash1) - 110000 / R * (1 - order_paper.SPOT_FEE)) < 1e-9 and "2330" not in s["spot"],
      "sell proceeds ÷ 32, inventory gone")
msg = refused(order_paper._spot_base, "2330TWD")
check(msg and "TW stocks" in msg, f"other quotes still refused ({msg})")

print("== session: closed market refuses every TW order (Wei 10-17), never crypto")
SESSION[0] = False
mark(1000)
msg = refused(order_paper.place_market_order, ENV, "2330", "long", 5)
check(msg and "休市" in msg, f"swap entry refused ({msg})")
msg = refused(order_paper.place_spot_market_order, ENV, "2330", "buy", quote_qty=1000)
check(msg and "休市" in msg, "spot buy refused")
msg = refused(order_paper.place_limit_order, ENV, "2330", "long", 5, 990)
check(msg and "休市" in msg, "limit entry refused")
check(order_paper.place_market_order(ENV, "BTCUSDT", "long", 0.01) is not False, "crypto unaffected")
order_paper.place_market_order(ENV, "BTCUSDT", "long", 0.01, reduce_only=True)
SESSION[0] = True
order_paper.place_market_order(ENV, "2330", "long", 5)
rest = order_paper.place_limit_order(ENV, "2330", "long", 5, 900)
order_paper.place_protective_orders(ENV, "2330", "long", sl_price=850)
SESSION[0] = False
msg = refused(order_paper.place_market_order, ENV, "2330", "long", 5, reduce_only=True)
check(msg and "休市" in msg, f"a close is refused outside the session too ({msg})")
msg = refused(order_paper.place_spot_market_order, ENV, "2330", "sell", base_qty=1)
check(msg and "休市" in msg, "a spot sell too")
try:
    order_paper.place_market_order(ENV, "2330", "long", 5, reduce_only=True)
    kind = None
except order_paper.PaperError as e:
    kind = type(e).__name__
check(kind == "PaperMarketClosed", f"refusal is PaperMarketClosed — what flatten defers on ({kind})")
mark(800)
check(any(p["symbol"] == "2330" for p in snap()["positions"]),
      "a stop the mark crossed (800 < SL 850) does not trigger while the market is shut")
check(order_paper.get_order(ENV, "2330", rest["order_id"])["status"] == "open",
      "a resting TW limit the mark crossed waits while the market is shut")
SESSION[0] = True
check(order_paper.get_order(ENV, "2330", rest["order_id"])["status"] == "filled", "and fills once it opens")
fills = [f for f in snap()["fills"] if f["symbol"] == "2330"]
check(fills[-1]["kind"] == "sl" and not any(p["symbol"] == "2330" for p in snap()["positions"]),
      "the stop fires on the first read after the open, flattening the row")

print("== whole shares, floored; 0 shares sends nothing")
mark(1000)
f1 = order_paper.place_market_order(ENV, "2330", "long", 10.7)
check(f1["executed_qty"] == 10.0, f"10.7 shares → 10 ({f1['executed_qty']})")
check(order_paper.place_market_order(ENV, "2330", "long", 0.6) is False, "0.6 share → no order")
check(order_paper.place_market_order(ENV, "2330", "long", 3.9, reduce_only=True)["executed_qty"] == 3.0,
      "a partial close floors too")
check(order_paper.place_market_order(ENV, "2330", "long", 7, reduce_only=True)["executed_qty"] == 7.0
      and not any(p["symbol"] == "2330" for p in snap()["positions"]), "a full close of 7 flattens")
s0 = order_paper.get_spot_balances(ENV).get("2330", 0.0)
order_paper.place_spot_market_order(ENV, "2330", "buy", quote_qty=2500)
check(order_paper.get_spot_balances(ENV)["2330"] - s0 == 2.0, "spot 2,500 TWD at 1,000 buys 2 shares, not 2.5")
check(order_paper.place_spot_market_order(ENV, "2330", "buy", quote_qty=900) is False, "900 TWD buys nothing")
order_paper.place_spot_market_order(ENV, "2330", "sell", base_qty=2)
led = json.load(open(order_paper.LEDGER_PATH))
led["positions"]["2330"] = {"qty": 3.5, "entry": 1000.0, "quote_ccy": "TWD", "fx": R}
json.dump(led, open(order_paper.LEDGER_PATH, "w"))
check(order_paper.place_market_order(ENV, "2330", "long", 3.5, reduce_only=True)["executed_qty"] == 3.5,
      "a legacy 3.5-share row closes whole")

print("== no TW stock shorts")
msg = refused(order_paper.place_market_order, ENV, "2330", "short", 5)
check(msg and "放空" in msg, f"a short from flat is refused ({msg})")
msg = refused(order_paper.place_limit_order, ENV, "2330", "short", 5, 1100)
check(msg and "放空" in msg, "a resting short limit too")
order_paper.place_market_order(ENV, "2330", "long", 10)
f2 = order_paper.place_market_order(ENV, "2330", "short", 15)
check(f2["executed_qty"] == 10.0 and not any(p["symbol"] == "2330" for p in snap()["positions"]),
      "a sell of 15 against a 10 long only closes it")
check(order_paper.place_market_order(ENV, "BTCUSDT", "short", 0.01) is not False, "crypto can still short")
order_paper.place_market_order(ENV, "BTCUSDT", "short", 0.01, reduce_only=True)

print("== tw_session_open: 09:00–13:30 Taipei on a trading day")
TPE = timezone(timedelta(hours=8))
ts = lambda *a: datetime(*a, tzinfo=TPE).timestamp()  # noqa: E731
verdict = [True]
fetches = []


def fake_day(d, h, **kw):
    fetches.append((d, kw))
    if isinstance(verdict[0], Exception):
        raise verdict[0]
    return verdict[0]


def fresh(process_only=False):
    """A new process: empty memory cache; process_only=False also wipes the disk copy."""
    paper_data._tw_day_cache.clear()
    if not process_only and os.path.exists(paper_data.TW_DAY_PATH):
        os.remove(paper_data.TW_DAY_PATH)


data.is_tw_trading_day = fake_day
fresh()
op = paper_data.tw_session_open
check([op(ENV, ts(2026, 10, 19, 8, 59)), op(ENV, ts(2026, 10, 19, 9, 0)), op(ENV, ts(2026, 10, 19, 13, 29)),
       op(ENV, ts(2026, 10, 19, 13, 30)), op(ENV, ts(2026, 10, 18, 10, 0))] == [False, True, True, False, False],
      "Mon 08:59 shut, 09:00 open, 13:29 open, 13:30 shut, Sunday shut")
check(fetches and fetches[0][1] == {"timeout": 3, "max_retries": 1}, f"one short fetch, no retry ({fetches[:1]})")
verdict[0] = False
fresh()
check(op(ENV, ts(2026, 10, 19, 10, 0)) is False, "a holiday in the table is shut")
verdict[0] = None
fresh()
check(op(ENV, ts(2026, 10, 19, 10, 0)) is True, "table unknown (no API plan): the weekday decides")
verdict[0] = data.DataAccessError("no plan")
fresh()
check(op(ENV, ts(2026, 10, 19, 10, 0)) is True, "table refused: the weekday decides")

print("== B3: the day's verdict is on disk — a fresh process (the account reader) does not refetch")
verdict[0] = False
fresh()
fetches.clear()
op(ENV, ts(2026, 10, 19, 10, 0))
fresh(process_only=True)
check(op(ENV, ts(2026, 10, 19, 11, 0)) is False and len(fetches) == 1, f"known verdict reused across processes ({len(fetches)} fetch)")
verdict[0] = OSError("api down")
fresh()
fetches.clear()
check(op(ENV, ts(2026, 10, 20, 10, 0)) is True, "api down: the weekday rule")
fresh(process_only=True)
op(ENV, ts(2026, 10, 20, 10, 1))
check(len(fetches) == 1, f"a failed fetch is not retried by the next process inside {paper_data._TW_DAY_RETRY_S}s ({len(fetches)})")
d = json.load(open(paper_data.TW_DAY_PATH))
d["checked_at"] -= paper_data._TW_DAY_RETRY_S + 1
json.dump(d, open(paper_data.TW_DAY_PATH, "w"))
fresh(process_only=True)
op(ENV, ts(2026, 10, 20, 10, 15))
check(len(fetches) == 2, "…and is retried once that window passes")
verdict[0] = True
fresh(process_only=True)
fetches.clear()
op(ENV, ts(2026, 10, 21, 10, 0))
check(len(fetches) == 1 and json.load(open(paper_data.TW_DAY_PATH))["date"] == "2026-10-21", "a new day fetches again")
fresh()

print("== reconcile holds paper TW keys while shut")
from lib import portfolio  # noqa: E402
paper_data.tw_session_open = lambda env=None, now=None: False
portfolio.book_venue = lambda: "paper"
tgt = {"2330": {"exchange": "paper"}, "2454@spot": {"exchange": "paper"}, "BTCUSDT": {"exchange": "paper"},
       "TXF": {"exchange": "paper"}, "2317": {"exchange": "binance"}}
act = {"6488": {"side": "long", "size": 1}}
check(portfolio._paper_tw_closed_keys(tgt, act) == {"2330", "2454@spot", "6488"},
      "TW stock keys on paper held (incl. a close-on-removal row); crypto, TXF and another venue not")
paper_data.tw_session_open = lambda env=None, now=None: True
check(portfolio._paper_tw_closed_keys(tgt, act) == set(), "open session: nothing held")

print("== target: a TW short signal is flat on paper, never cancelling a long")
from lib import portfolio as pf  # noqa: E402
os.makedirs("manager", exist_ok=True)
os.makedirs("strategies/tsmc_b", exist_ok=True)
open("strategies/tsmc_b/strategy.py", "w").write('SYMBOL = "2330"\n')
os.makedirs("strategies/btc_s", exist_ok=True)
open("strategies/btc_s/strategy.py", "w").write('SYMBOL = "BTCUSDT"\n')
json.dump({"symbol": "2330", "position": -1}, open("strategies/tsmc_a/state.json", "w"))
json.dump({"symbol": "2330", "position": 1}, open("strategies/tsmc_b/state.json", "w"))
json.dump({"symbol": "BTCUSDT", "position": -1}, open("strategies/btc_s/state.json", "w"))
json.dump({"amounts": {"tsmc_a": 50000, "tsmc_b": 30000, "btc_s": 1000, "tw_basket": 0},
           "exchanges": {"tsmc_a": "paper", "tsmc_b": "paper", "btc_s": "paper"}},
          open("manager/portfolio_config.json", "w"))
tg = pf.aggregate_portfolio()
check("2330" not in tg and tg["2330@spot"]["market"] == "spot",
      "a TW Type A (MARKET swap) on paper is held as cash shares: key 2330@spot")
check(tg["2330@spot"]["side"] == "long" and tg["2330@spot"]["size"] == 30000,
      f"2330: −50,000 short is flat, +30,000 long stays ({tg['2330@spot']['side']} {tg['2330@spot']['size']})")
check(tg["BTCUSDT"]["side"] == "short" and tg["BTCUSDT"]["market"] == "swap", "BTC short untouched, still swap")
check("2330" in pf.spot_symbols() and "BTCUSDT" not in pf.spot_symbols(), "the spot scope reads the 2330 shares")
check(pf._strategy_key("tsmc_b") == "2330@spot", "a strategy's book key follows it")
json.dump({"amounts": {"tsmc_b": 30000}, "exchanges": {"tsmc_b": "binance"}}, open("manager/portfolio_config.json", "w"))
check("2330" in pf.aggregate_portfolio(), "another venue keeps the strategy's own MARKET")
json.dump({"amounts": {"tsmc_a": 50000}, "exchanges": {"tsmc_a": "paper"}}, open("manager/portfolio_config.json", "w"))
check(pf.aggregate_portfolio()["2330@spot"]["side"] is None, "a lone short signal is a flat target (close)")
print("== spot pays cash: a TW buy beyond the cash is refused (no leverage)")
SESSION[0] = True
mark(1000)
msg = refused(order_paper.place_spot_market_order, ENV, "2330", "buy", quote_qty=snap()["cash"] * R * 2)
check(msg and "insufficient paper cash" in msg, f"2× the cash in TWD is refused ({msg})")
print("== item 5: a 0-share skip is audited on every order path")
audits0 = []
real_audit = order_paper.guard.audit
order_paper.guard.audit = lambda ev, **f: audits0.append((ev, f.get("note")))
order_paper.place_market_order(ENV, "2330", "long", 0.4)
order_paper.place_limit_order(ENV, "2330", "long", 0.4, 990)
order_paper.place_spot_limit_order(ENV, "2330", "buy", 0.4, 990)
order_paper.guard.audit = real_audit
check(sum(1 for ev, n in audits0 if ev == "order_ok" and n == "under one share") == 3,
      f"market, limit and spot limit each write order_ok 'under one share' ({audits0})")
os.remove("strategies/tsmc_a/state.json")
os.remove("manager/portfolio_config.json")

print("== close-all outside the session is deferred to the first round after the open")
import ast  # noqa: E402
fsrc = open(os.path.join(ROOT, "manager", "flatten.py"), encoding="utf-8").read()
fn = next(n for n in ast.parse(fsrc).body if isinstance(n, ast.FunctionDef) and n.name == "_defer_tw_close")
recorded = []
ns = {"logging": __import__("logging"), "_record_order_error": lambda *a: recorded.append(a), "guard": order_paper.guard}
exec(compile(ast.Module([fn], []), "flatten._defer_tw_close", "exec"), ns)
check(ns["_defer_tw_close"]("paper", "2330", RuntimeError("boom")) is None and not os.path.exists(pf._PAPER_TW_CLOSE_PATH),
      "any other close error stays an error")
check(ns["_defer_tw_close"]("paper", "2330", order_paper.PaperMarketClosed("shut")) == "deferred"
      and json.load(open(pf._PAPER_TW_CLOSE_PATH))["keys"] == ["2330"]
      and recorded and recorded[-1][3] == {"kind": "market_closed_deferred"}, "a market-closed close is booked for later and said")
ns["_defer_tw_close"]("paper", "2454@spot", order_paper.PaperMarketClosed("shut"))
held = {"2330": {"side": "long", "size": 10000}, "2454@spot": {"side": "long", "size": 0}}
check(pf._paper_tw_deferred(held, True) == {"2330"} and json.load(open(pf._PAPER_TW_CLOSE_PATH))["keys"] == ["2330"],
      "halted: still-held keys are closed this round; the flat one drops off")
check(pf._paper_tw_deferred({}, True) == set() and not os.path.exists(pf._PAPER_TW_CLOSE_PATH),
      "once closed the file goes")
pf.defer_paper_tw_close(["2330"])
check(pf._paper_tw_deferred(held, False) == set() and not os.path.exists(pf._PAPER_TW_CLOSE_PATH),
      "resumed (no HALT) before the open: the deferral is dropped, the strategies rule")
errs = lambda: json.load(open("manager/order_errors.json")) if os.path.exists("manager/order_errors.json") else []  # noqa: E731
pf.defer_paper_tw_close(["2330"])
pf._paper_tw_deferred(held, False)
check(errs() and "開盤前已按啟動下單" in errs()[-1]["error"], f"the cancel is said: resumed before the open ({errs()[-1:]})")
pf.defer_paper_tw_close(["2330", "2454@spot"])
d = json.load(open(pf._PAPER_TW_CLOSE_PATH))
d["restart_at"] = 1700000000   # runtime command_listener._stop_after_restart
json.dump(d, open(pf._PAPER_TW_CLOSE_PATH, "w"))
pf._paper_tw_deferred({"2330": {"side": "long", "size": 10000}}, True)
d = json.load(open(pf._PAPER_TW_CLOSE_PATH))
check(d.get("keys") == ["2330"] and d.get("restart_at") == 1700000000,
      f"a halted round that trims the deferral (2454 already flat) keeps the restart stamp ({d})")
pf._paper_tw_deferred({"2330": {"side": "long", "size": 10000}}, False)
check("機器重開後按了啟動下單" in errs()[-1]["error"] and not os.path.exists(pf._PAPER_TW_CLOSE_PATH),
      f"restarted in between: the cancel says the start came after a restart, not an early resume ({errs()[-1:]})")
check("deferred = _paper_tw_deferred(diff_actual_full, halted_at_start)" in open(os.path.join(ROOT, "lib", "portfolio.py")).read(),
      "reconcile judges deferred keys on the unfiltered book")
order_paper.guard.restart_stopped = lambda: True
recorded.clear()
check(ns["_defer_tw_close"]("paper", "2330@spot", order_paper.PaperMarketClosed("shut")) == "refused"
      and not os.path.exists(pf._PAPER_TW_CLOSE_PATH) and "再按一次全部平倉" in recorded[-1][2],
      f"B2: stopped after a restart — not deferred, said as an error ({recorded[-1][2] if recorded else None})")
order_paper.guard.restart_stopped = lambda: False

print("== B1: 「等新訊號」start, signal unchanged, close-all after the close → closed at the open")
os.makedirs("state", exist_ok=True)
json.dump({"symbol": "2330", "position": 1}, open("strategies/tsmc_b/state.json", "w"))
json.dump({"amounts": {"tsmc_b": 30000}, "exchanges": {"tsmc_b": "paper"}, "self_ledger": False},
          open("manager/portfolio_config.json", "w"))
json.dump({"tsmc_b": 1.0}, open("state/signal_gate.json", "w"))
open("state/HALT", "w").write("close_all")
pf.defer_paper_tw_close(["2330@spot"])
paper_data.tw_session_open = lambda env=None, now=None: True
sent = []


def place(symbol, diff, spec, reduce_only=False, **k):
    sent.append((symbol, diff, reduce_only))
    return {"executed_qty": abs(diff) / 1000, "avg_price": 1000}


pf.reconcile(lambda: {"2330@spot": {"side": "long", "size": 30000.0}}, place)
check(sent and sent[0][0] == "2330@spot" and sent[0][1] < 0,
      f"the gated 2330 is closed in the first round after the open ({sent})")
pf.reconcile(lambda: {}, place)
check(not os.path.exists(pf._PAPER_TW_CLOSE_PATH), "and the deferral clears once flat")
os.remove("state/HALT")
for f in ("state/signal_gate.json", "manager/portfolio_config.json", "strategies/tsmc_b/state.json"):
    os.path.exists(f) and os.remove(f)

print("== B5: the reconcile gate for a paper TW stock is TWD-scaled and at least one share")
from lib import execute as ex  # noqa: E402
real_detect = venue_wiring.detect_venue
venue_wiring.detect_venue = lambda env: "paper"
rate(R)
mark(1000)
paper_data._price_cache["2330"] = (time.time(), 1000.0, "tsmc_a")
check(ex._venue_sizes_usd("2330@spot", 10) == (1050.0, 1000.0), f"2330 at 1,000: gate 1.05 shares = 1,050 TWD ({ex._venue_sizes_usd('2330@spot', 10)})")
paper_data._price_cache["2330"] = (time.time(), 8.0, "tsmc_a")
check(ex._venue_sizes_usd("2330@spot", 10) == (320.0, 8.0), "an 8 TWD stock: the 10 USD floor in TWD (320), not 10")
check(ex._venue_sizes_usd("BTCUSDT@spot", 10) == (10, 0.0), "crypto spot keeps the flat 10")
paper_data._price_cache["2330"] = (time.time(), 1000.0, "tsmc_a")
gate = lambda sym, reduce_only=False: ex._venue_sizes_usd(sym, 10)[0]  # noqa: E731
row = {"side": "long", "size": 30500.0, "exchange": "paper", "asset_spec": None, "market": "spot", "contributors": [], "gated": False}
held = {"2330@spot": {"side": "long", "size": 30000.0}}
check(pf.compute_diff({"2330@spot": row}, held, 10) and not pf.compute_diff({"2330@spot": row}, held, gate),
      "a 500 TWD gap (half a share): sent every round on the flat 10, held under the share gate")
row["size"] = 31200.0
check(pf.compute_diff({"2330@spot": row}, held, gate), "a 1,200 TWD gap (over one share) still trades")
from manager import reconciler as rc  # noqa: E402
rc._min_order_gate.clear()
check(rc._symbol_threshold("2330@spot", True) == 1050.0 and rc._symbol_threshold("2330@spot") == 1050.0,
      f"partial reduce gate = entry gate ≈ 1.05 shares ({rc._symbol_threshold('2330@spot', True)}), not half a share")
check(rc._close_gate("2330@spot") == rc.THRESHOLD, "a whole-position close keeps its own gate (untouched)")
check(rc._symbol_threshold("BTCUSDT@spot", True) == rc.THRESHOLD, "crypto spot reduce gate unchanged")
row["size"] = 29500.0
check(not pf.compute_diff({"2330@spot": row}, held, rc._symbol_threshold),
      "a 500 TWD shrink (half a share) is left alone — no floored-to-0 order and audit each round")
row["size"] = 0.0
check(pf.compute_diff({"2330@spot": dict(row, side=None)}, held, rc._symbol_threshold), "a full close still goes")
rc._min_order_gate.clear()
venue_wiring.detect_venue = real_detect

print("== every TW stock at its unadjusted close (Wei 10-18: page shares = paper shares)")
calls.clear()
paper_data._price_cache.clear()
px, owner = paper_data.current_price("2454", ENV)
check(px == 1500.0 and owner is None and len(calls) == 1 and calls[0][0] == "2454" and calls[0][2] is False,
      f"a Type C component: the unadjusted close, not adjusted at the basket's START ({px}, {calls})")
check(not os.path.exists("state/basket_fetch_called"), "the basket's fetch_data never ran")
calls.clear()
px, owner = paper_data.current_price("6488", ENV)
check(px == 700.0 and owner is None and calls and calls[0][2] is False,
      "a TW code nobody trades: the unadjusted close")
mark(1000)
calls.clear()
px, owner = paper_data.current_price("2330", ENV)
check(px == 1000.0 and owner is None and calls and calls[0][2] is False,
      f"a Type A's own symbol: the unadjusted close, not its fetch_data (1,100 adjusted) ({px})")
paper_data._price_cache.clear()
calls.clear()
paper_data.current_price("6488.TWO", ENV)
check(calls and calls[0][0] == "6488", f"an OTC code asks under the page's code, .TWO stripped ({calls})")
SESSION[0] = True
order_paper.place_spot_market_order(ENV, "2454", "buy", quote_qty=33000)
check(abs(order_paper.get_spot_balances(ENV)["2454"] - 22.0) < 1e-9, "a basket component fills: 33,000 TWD / 1,500 = 22 shares")

print("== a TW row booked before this is stamped once, audited")
led = json.load(open(order_paper.LEDGER_PATH))
led["positions"]["2317"] = {"qty": 10.0, "entry": 180.0}
json.dump(led, open(order_paper.LEDGER_PATH, "w"))
audits = []
order_paper.guard.audit = lambda ev, **f: audits.append((ev, f))
paper_data._price_cache.clear()
snap()
row = json.load(open(order_paper.LEDGER_PATH))["positions"]["2317"]
cut = [f for ev, f in audits if ev == "paper_fx_cutover"]
check(row.get("quote_ccy") == "TWD" and row.get("fx") == R and len(cut) == 1 and cut[0]["symbol"] == "2317",
      f"pre-FX TW row stamped TWD with a paper_fx_cutover audit ({row}, {cut})")

print("== runtime reports the capability off the disk")
import portfolio_reporter  # noqa: E402
portfolio_reporter.WORKSPACE_STATE = os.path.abspath("state")
check(portfolio_reporter.deferred_close() == [], "no deferral: deferred_close []")
json.dump({"keys": ["2454@spot", "2330", "BTCUSDT", 5, "6488.TWO@spot"], "ts": 1}, open("state/paper_tw_close.json", "w"))
check(portfolio_reporter.deferred_close() == ["2330", "2454@spot", "6488.TWO@spot"],
      f"deferred_close: TW stock keys only, sorted ({portfolio_reporter.deferred_close()})")
open("state/paper_tw_close.json", "w").write("{")
check(portfolio_reporter.deferred_close() == [], "unreadable: []")
os.remove("state/paper_tw_close.json")
check('"deferred_close": deferred_close(),' in open(portfolio_reporter.__file__, encoding="utf-8").read(),
      "the report carries deferred_close")
today = datetime.now(timezone(timedelta(hours=8))).strftime("%Y-%m-%d")
check(portfolio_reporter.tw_trading_day() is None, "no verdict file: tw_trading_day None")
json.dump({"date": today, "verdict": False, "checked_at": 1}, open("state/paper_tw_day.json", "w"))
check(portfolio_reporter.tw_trading_day() == {"date": today, "trading": False}, "today's holiday verdict is reported")
json.dump({"date": today, "verdict": None, "checked_at": 1}, open("state/paper_tw_day.json", "w"))
check(portfolio_reporter.tw_trading_day() is None, "an unknown verdict (no holiday table) is None")
json.dump({"date": "2000-01-01", "verdict": True, "checked_at": 1}, open("state/paper_tw_day.json", "w"))
check(portfolio_reporter.tw_trading_day() is None, "another day's verdict is None")
os.remove("state/paper_tw_day.json")
portfolio_reporter.WORKSPACE = ROOT
check(portfolio_reporter.can_paper_twstock() is True, "this workspace: can_paper_twstock true")
old = tempfile.mkdtemp(prefix="oldws-")
os.makedirs(os.path.join(old, "lib"))
open(os.path.join(old, "lib", "paper_data.py"), "w").write("def usd_rate(): pass\n")
open(os.path.join(old, "lib", "portfolio.py"), "w").write("\n")
portfolio_reporter.WORKSPACE = old
check(portfolio_reporter.can_paper_twstock() is False, "an older lib: false")

print(f"\n{'ALL OK' if not fails else f'{fails} FAILED'}")
sys.exit(1 if fails else 0)
