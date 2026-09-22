"""self_ledger books QUANTITY and cost, and closes what it bought — offline, on
the paper venue, one reconcile round at a time (no daemon, no network, no
exchange). The mark is whatever the strategy's fetch_data reads from
state/mark.txt, the same channel tests/check_local_daemon_chain.py uses.

What must hold (references/manager.md § self_ledger):
  - a held position never trades on a ±20% mark move;
  - a close sells exactly what was bought, above AND below the entry price —
    the three measured bugs (stranded remainder, phantom long re-sending a dead
    reduce leg, overselling into the user's own holding) are gone;
  - add / partial reduce / flip / short / TWAP / chase / spot size off the book;
  - a remainder that can never be sold is written off, audited, never re-sent;
  - a book from before the quantity book is adopted without trading on update;
  - "the account no longer holds it" zeroes a book only on a second,
    separate read — one wrong-but-successful read never orphans a position,
    and a flip does not open its new side on an unconfirmed close;
  - files reach a machine one at a time: the new wiring / execute beside the
    lib.portfolio of BASELINE trade exactly as BASELINE does;
  - self_ledger OFF places byte-for-byte the orders BASELINE places (same
    scripts run against a `git archive` export of the commit this batch was
    cut from — pinned, or the comparison is against itself once committed),
    and so does a lot-based book. Those OFF rounds run with the account-read
    drift band switched off (`no_band`): the band deliberately leaves a
    sub-5% rounding residual alone that BASELINE sold back, and it has its
    own gate (tests/check_drift_band.py) — this comparison is about the book.

Run:  cd blave-agent && .venv/bin/python tests/check_self_ledger_qty.py
      ... --root <dir>   run the ON assertions against another tree's lib/ +
                         manager/ (an export of BASELINE must FAIL the bug cases)
"""
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BASELINE = "012df4e"   # the last commit before the quantity book

STRATEGY = '''MODE = "live"
STRATEGY_NAME = "fixed_long"
SYMBOL = "BTCUSDT"
INTERVAL = "1m"
%s

def fetch_data(hdrs):
    import pandas as pd
    px = float(open("state/mark.txt").read())
    end = pd.Timestamp.now(tz="UTC").tz_localize(None).floor("min")
    idx = pd.date_range(end=end, periods=5, freq="min")
    return pd.DataFrame({"Open": px, "High": px, "Low": px, "Close": px, "Volume": 1.0}, index=idx)


def compute_signals(df):
    import pandas as pd
    return pd.Series(1.0, index=df.index)
'''


# ── child: runs inside one temp workspace ───────────────────────────────────

def child(case):
    import importlib.util
    import logging
    sys.path.insert(0, os.getcwd())
    spec = importlib.util.spec_from_file_location("reconciler", "manager/reconciler.py")
    rec = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(rec)
    logging.getLogger().setLevel(logging.ERROR)
    from lib import execute, order_paper, paper_data, portfolio, venue_wiring

    env = venue_wiring.read_env()

    def set_lot(lot):
        if lot:
            rules = {"step": str(lot), "min_qty": lot, "min_notional": 0.0,
                     "contract_value": 1.0, "price_tick": "0.1", "active": True}
            order_paper.get_contract_rules = lambda e, s: dict(rules)

    def set_mark(px):
        open("state/mark.txt", "w").write(str(px))
        paper_data._price_cache.clear()
        rec._min_order_gate.clear()

    set_lot(case.get("lot"))
    if case.get("no_band") and hasattr(portfolio, "drift_band"):
        portfolio.drift_band = lambda symbol: 0.0
    # two reads "at least one reconciler poll apart": the rounds here run back
    # to back, so the gap is 0 unless a case is about the gap itself
    if hasattr(portfolio, "_ACCOUNT_SHORT_MIN_S"):
        portfolio._ACCOUNT_SHORT_MIN_S = case.get("short_gap", 0)
    from lib import account_paper
    real_positions = account_paper.get_positions
    if case.get("fast_async"):
        # the async executors, run to completion inside the test's time budget
        _twap = execute.run_twap
        execute.run_twap = lambda sym, side, qty, dur, n, *a, **k: _twap(
            sym, side, qty, 0.0005 * n, n, *a, **k)
        execute._CHASE_TIMEOUT_S, execute._CHASE_POLL_S = 0.6, 0.1
        execute._venue_min_slice_usd = lambda symbol, floor=20.0: 200.0

    calls = []
    if case.get("wiring") == "fake_lots":
        held = {"lots": 0.0}

        def get_positions():
            n = held["lots"]
            return {"TXF": {"side": "long" if n > 0 else "short" if n < 0 else None,
                            "size": abs(n), "exchange": "capital"}} if n else {}

        def place_order(symbol, signed_diff, asset_spec=None, reduce_only=False,
                        exchange=None, contributors=None):
            import math
            lots = math.floor(abs(signed_diff) + 0.5)
            calls.append([symbol, signed_diff, reduce_only, exchange])
            if lots < 1:
                return False
            held["lots"] += lots if signed_diff > 0 else -lots
            return {"avg_price": 22000.0, "executed_qty": float(lots), "exchange": "capital"}
        threshold = 10
    else:
        get_positions, threshold = rec.get_positions, rec._symbol_threshold

        def place_order(symbol, signed_diff, asset_spec=None, reduce_only=False,
                        exchange=None, contributors=None):
            calls.append([symbol, round(signed_diff, 2), reduce_only])
            return rec.place_order(symbol, signed_diff, asset_spec=asset_spec,
                                   reduce_only=reduce_only, exchange=exchange,
                                   contributors=contributors)

    def paper():
        try:
            led = json.load(open("state/paper_ledger.json"))
        except OSError:
            led = {}
        pos = (led.get("positions") or {}).get("BTCUSDT") or {}
        return {"qty": pos.get("qty", 0.0), "spot": (led.get("spot") or {}).get("BTC", 0.0),
                "fills": [[f["side"], round(f["qty"], 8), f["price"]]
                          for f in led.get("fills") or []]}

    def log_lines():
        try:
            return [json.loads(l) for l in open("manager/orders.jsonl")]
        except OSError:
            return []

    def book():
        if not case["self_ledger"]:
            return None
        if hasattr(portfolio, "ledger_book"):
            return {k: {"qty": round(v["qty"], 10), "cost": round(v["cost"], 2),
                        "legacy": v["legacy"]} for k, v in portfolio.ledger_book().items()}
        return {k: {"usd": round(v["size"] * (1 if v["side"] == "long" else -1), 2)}
                for k, v in portfolio.ledger_positions().items()}

    if case["self_ledger"] and not case.get("pre_seed"):
        portfolio.seed_ledger(get_positions)

    out = []
    for step in case["steps"]:
        if "lot" in step:
            set_lot(step["lot"])
        if "mark" in step:
            set_mark(step["mark"])
        if "manual" in step:  # the user's own order: never through reconcile
            q = step["manual"]
            if case.get("spot"):
                order_paper.place_spot_market_order(
                    env, "BTCUSDT", "buy" if q > 0 else "sell",
                    quote_qty=q * step["mark"] if q > 0 else None,
                    base_qty=None if q > 0 else abs(q), client_order_id=f"m{len(out)}")
            else:
                order_paper.place_market_order(env, "BTCUSDT", "long", abs(q),
                                               client_order_id=f"m{len(out)}",
                                               reduce_only=q < 0)
        if "pos" in step:
            json.dump({"symbol": "TXF" if case.get("wiring") == "fake_lots" else "BTCUSDT",
                       "position": step["pos"]},
                      open("strategies/fixed_long/state.json", "w"))
        n_fills, n_log, n_calls = len(paper()["fills"]), len(log_lines()), len(calls)
        rounds, err = 0, None
        # a venue answering successfully and WRONG: every position row dropped
        account_paper.get_positions = ((lambda e: []) if step.get("misread")
                                       else real_positions)
        if "pos" in step or step.get("reconcile"):
            for rounds in range(1, step.get("max_rounds", 6) + 1):
                paper_data._price_cache.clear()
                rec._min_order_gate.clear()
                before = len(log_lines())
                try:
                    portfolio.reconcile(get_positions, place_order, threshold=threshold)
                except Exception as e:
                    err = f"{type(e).__name__}: {e}"
                    break
                deadline = time.time() + 20   # async executions log on completion
                while execute.list_inflight() and time.time() < deadline:
                    time.sleep(0.05)
                if len(log_lines()) == before:
                    break
        last_round_calls = len(calls)
        if step.get("idle_round"):   # one more round: anything still being re-sent?
            portfolio.reconcile(get_positions, place_order, threshold=threshold)
        account_paper.get_positions = real_positions
        p = paper()
        try:
            n_off = sum('"ledger_writeoff"' in l for l in open("state/audit.jsonl"))
        except OSError:
            n_off = 0
        out.append({
            "writeoffs": n_off,
            "fills": p["fills"][n_fills:], "paper_qty": round(p["qty"], 10),
            "spot": round(p["spot"], 10), "book": book(), "rounds": rounds, "error": err,
            "calls": calls[n_calls:last_round_calls],
            "idle_calls": calls[last_round_calls:],
            "log": [{k: v for k, v in e.items() if k != "ts"} for e in log_lines()[n_log:]],
        })
    audit = []
    try:
        audit = [json.loads(l) for l in open("state/audit.jsonl")]
    except OSError:
        pass
    json.dump({"steps": out,
               "writeoffs": [a for a in audit if a.get("event") == "ledger_writeoff"],
               "adoption": (json.load(open("manager/ledger_migration.json"))
                            if os.path.exists("manager/ledger_migration.json") else None)},
              sys.stdout)


# ── driver ──────────────────────────────────────────────────────────────────

TMP = tempfile.mkdtemp(prefix="self-ledger-qty-")
_n = [0]


def run(root, case):
    _n[0] += 1
    home = os.path.join(TMP, f"case{_n[0]}")
    ws = os.path.join(home, "workspace")
    for d in ("lib", "manager"):
        shutil.copytree(os.path.join(root, d), os.path.join(ws, d),
                        ignore=shutil.ignore_patterns("__pycache__", "*.json", "*.jsonl"))
    os.makedirs(os.path.join(ws, "strategies", "fixed_long"))
    os.makedirs(os.path.join(ws, "state"))
    open(os.path.join(ws, "state", "mark.txt"), "w").write("100000")
    open(os.path.join(ws, "strategies", "fixed_long", "strategy.py"), "w").write(
        STRATEGY % ('MARKET = "spot"' if case.get("spot") else ""))
    open(os.path.join(ws, ".env"), "w").write(
        f"PAPER_API_KEY=paper\nPAPER_SECRET_KEY=paper\nPAPER_BOUND_TS={int(time.time())}\n")
    json.dump({"ids": ["paper"]}, open(os.path.join(ws, "manager", "credentials.ui.json"), "w"))
    cfg = {"amounts": {"fixed_long": case.get("amount", 1000)},
           "exchanges": {"fixed_long": "paper"}, "self_ledger": case["self_ledger"]}
    if case.get("execution"):
        cfg["execution"] = {"fixed_long": case["execution"]}
    if case.get("wiring") == "fake_lots":
        cfg["exchanges"] = {"fixed_long": "capital"}
        cfg["asset_specs"] = {"fixed_long": {"type": "futures_contracts"}}
    json.dump(cfg, open(os.path.join(ws, "manager", "portfolio_config.json"), "w"))
    if case.get("pre_seed"):
        json.dump(case["pre_seed"], open(os.path.join(ws, "manager", "ledger_seed.json"), "w"))
    if case.get("pre_log"):
        with open(os.path.join(ws, "manager", "orders.jsonl"), "w") as f:
            for e in case["pre_log"]:
                f.write(json.dumps(e) + "\n")
    env = {k: v for k, v in os.environ.items() if not k.startswith("BLAVE_")}
    env.update(BLAVE_AGENT_BASE=home, BLAVE_AGENT_WORKSPACE=ws, BLAVE_AGENT_HOME=home,
               BLAVE_AGENT_LOCAL="1", PYTHONDONTWRITEBYTECODE="1")
    p = subprocess.run([sys.executable, os.path.abspath(__file__), "--child", json.dumps(case)],
                       cwd=ws, env=env, capture_output=True, text=True, timeout=300)
    if p.returncode != 0:
        raise RuntimeError(f"child failed for {case.get('name')}:\n{p.stderr[-3000:]}")
    return json.loads(p.stdout)


OKX_PROBE = """
import sys; sys.path.insert(0, '.')
from lib import account_okx as a
a._ct_val = lambda env, inst: 0.01
out = []
for mark in ({'markPx': '0'}, {}):
    a._request = lambda *k, **kw: [dict({'instId': 'ETH-USDT-SWAP', 'pos': '5',
                                         'posSide': 'net', 'notionalUsd': '100'}, **mark)]
    try:
        out.append('flat' if a.get_positions({}) == [] else 'listed')
    except Exception:
        out.append('raised')
print(*out)
"""

fails = []


def check(ok, label, detail=""):
    print(("  ok   " if ok else "  FAIL ") + label + (f"  — {detail}" if detail and not ok else ""))
    if not ok:
        fails.append(label)


def sold(res, side="sell"):
    return round(sum(f[1] for s in res["steps"] for f in s["fills"] if f[0] == side), 8)


HOLD = [{"mark": 100000, "pos": 1}, {"mark": 120000, "pos": 1}, {"mark": 80000, "pos": 1}]
T0 = "2026-01-01T00:00:00"
OLD_SEED = {"seeded_at": T0, "symbols": {}}


def old_leg(ts, usd, qty=None, price=None, reduce_only=False):
    leg = {"signed_diff": usd, "reduce_only": reduce_only, "exchange": "paper"}
    if qty is not None:
        leg.update(executed_qty=qty, fill_price=price)
    return {"ts": ts, "action": "BUY" if usd > 0 else "SELL", "symbol": "BTCUSDT",
            "signed_diff": usd, "exchange": "paper", "asset_spec": None,
            "contributors": [], "legs": [leg]}


def on_mode_checks(root):
    print(f"\n== self_ledger ON  ({root})")

    for lot in (0, 0.001):
        tag = f"lot={lot or 'native'}"
        r = run(root, {"name": "A", "self_ledger": True, "lot": lot,
                       "steps": HOLD + [{"mark": 80000, "pos": 0, "idle_round": True}]})
        s = r["steps"]
        check(s[0]["fills"] == [["buy", 0.01, 100000.0]], f"[{tag}] entry buys 0.01")
        check(not s[1]["fills"] and not s[2]["fills"] and not s[1]["calls"] and not s[2]["calls"],
              f"[{tag}] held through +20% and -20% without an order")
        check(s[3]["fills"] == [["sell", 0.01, 80000.0]] and s[3]["paper_qty"] == 0,
              f"[{tag}] BUG2 close at -20% sells exactly the 0.01 bought", str(s[3]["fills"]))
        check(s[3]["book"] == {} and not s[3]["idle_calls"],
              f"[{tag}] BUG2 no phantom long, no reduce leg re-sent next round",
              f"book={s[3]['book']} idle={s[3]['idle_calls']}")

        r = run(root, {"name": "B", "self_ledger": True, "lot": lot,
                       "steps": HOLD[:2] + [{"mark": 120000, "pos": 0, "idle_round": True}]})
        s = r["steps"]
        check(s[2]["fills"] == [["sell", 0.01, 120000.0]] and s[2]["paper_qty"] == 0
              and s[2]["book"] == {},
              f"[{tag}] BUG1 close at +20% sells 0.01, nothing stranded on the account",
              f"{s[2]['fills']} left={s[2]['paper_qty']} book={s[2]['book']}")

        for close_mark in (80000, 120000):
            r = run(root, {"name": "manual", "self_ledger": True, "lot": lot, "steps": [
                {"mark": 100000, "manual": 0.02}] + HOLD + [
                {"mark": close_mark, "pos": 0, "idle_round": True}]})
            s = r["steps"]
            check(s[-1]["paper_qty"] == 0.02 and s[-1]["book"] == {} and sold(r) == 0.01,
                  f"[{tag}] BUG3 close at {close_mark}: the user's 0.02 is untouched",
                  f"left={s[-1]['paper_qty']} sold={sold(r)} book={s[-1]['book']}")

    # add, then close — the close is the sum of what was bought
    r = run(root, {"self_ledger": True, "lot": 0.001, "steps": [
        {"mark": 100000, "pos": 1}, {"mark": 125000, "pos": 1.5}, {"mark": 80000, "pos": 0}]})
    s = r["steps"]
    check(s[1]["fills"] == [["buy", 0.004, 125000.0]]
          and s[1]["book"] == {"BTCUSDT": {"qty": 0.014, "cost": 1500.0, "legacy": False}},
          "add: qty and cost both accumulate from the fill", str(s[1]))
    check(s[2]["fills"] == [["sell", 0.014, 80000.0]] and s[2]["book"] == {},
          "add: close sells 0.014", str(s[2]["fills"]))

    # partial reduce = the same SHARE of the coins, not USD ÷ mark
    r = run(root, {"self_ledger": True, "lot": 0.001, "steps": [
        {"mark": 100000, "pos": 1}, {"mark": 120000, "pos": 0.5, "idle_round": True},
        {"mark": 80000, "pos": 0}]})
    s = r["steps"]
    check(s[1]["fills"] == [["sell", 0.005, 120000.0]]
          and s[1]["book"] == {"BTCUSDT": {"qty": 0.005, "cost": 500.0, "legacy": False}}
          and not s[1]["idle_calls"],
          "partial reduce: halving the target sells half the coins, converges in one order",
          str(s[1]))
    check(s[2]["fills"] == [["sell", 0.005, 80000.0]] and s[2]["paper_qty"] == 0,
          "partial reduce: the rest closes exactly")

    # flip long → short → flat
    # (81000, not 80000: there 0.0125 rounds to 0.013 and the 40 USD overshoot
    # EQUALS the half-lot reduce gate, which `<` lets through — a boundary of
    # round numbers, measured on OFF too, not what this case is about)
    r = run(root, {"self_ledger": True, "lot": 0.001, "steps": [
        {"mark": 100000, "pos": 1}, {"mark": 81000, "pos": -1}, {"mark": 100000, "pos": -1},
        {"mark": 125000, "pos": 0}]})
    s = r["steps"]
    check(s[1]["fills"] == [["sell", 0.01, 81000.0], ["sell", 0.012, 81000.0]],
          "flip: closes the 0.01 it owns, then opens the short", str(s[1]["fills"]))
    short = -s[1]["paper_qty"]
    check(not s[2]["fills"] and s[3]["fills"] == [["buy", round(short, 8), 125000.0]]
          and s[3]["paper_qty"] == 0 and s[3]["book"] == {},
          "short: held through +25%, then covered exactly", str(s[3]))

    # A whole-position close is gated flat, not at half a lot: the diff is the
    # book's COST, half a lot is priced at the MARK, so one lot that more than
    # doubled (cost 100 < 0.5 × 250) was never closed — no order, every round.
    for side, close in ((1, "sell"), (-1, "buy")):
        r = run(root, {"self_ledger": True, "lot": 0.001, "amount": 110, "steps": [
            {"mark": 100000, "pos": side}, {"mark": 250000, "pos": 0, "idle_round": True}]})
        s = r["steps"]
        check(s[1]["fills"] == [[close, 0.001, 250000.0]] and s[1]["paper_qty"] == 0
              and s[1]["book"] == {} and not s[1]["idle_calls"],
              f"one lot {'long' if side > 0 else 'short'}, mark x2.5, signal flat: "
              f"the close goes out and the book is empty", str(s[1]))
    r = run(root, {"self_ledger": True, "lot": 0.001, "amount": 110, "steps": [
        {"mark": 100000, "pos": 1}, {"mark": 250000, "pos": -1, "idle_round": True}]})
    s = r["steps"]
    check(s[1]["fills"] == [["sell", 0.001, 250000.0]] and s[1]["book"] == {}
          and not s[1]["idle_calls"],
          "one lot long, mark x2.5, flip: the close leg goes out; the 0.44-lot short "
          "stays under the entry gate and nothing is re-sent", str(s[1]))
    # ...and only the whole-position close: a partial reduce keeps half a lot
    # (the 2026-09-09 churn gate), and cost under the flat floor stays dust
    r = run(root, {"self_ledger": True, "lot": 0.001, "steps": [
        {"mark": 100000, "pos": 1}, {"mark": 100000, "pos": 0.96, "idle_round": True}]})
    s = r["steps"]
    check(not s[1]["calls"] and not s[1]["idle_calls"] and s[1]["paper_qty"] == 0.01,
          "partial reduce of 0.4 lot: still under the half-lot gate, no order", str(s[1]))
    dust = [old_leg("2026-02-01T00:00:00", 5.0, 0.00005, 100000.0)]
    r = run(root, {"self_ledger": True, "pre_seed": OLD_SEED, "pre_log": dust, "steps": [
        {"mark": 100000, "manual": 0.00005}, {"mark": 250000, "pos": 0, "idle_round": True}]})
    s = r["steps"]
    check(not s[1]["calls"] and not s[1]["idle_calls"] and s[1]["book"] != {},
          "a book costing less than the flat threshold is still left alone", str(s[1]))

    # a remainder under one lot: written off once, audited, never re-sent
    r = run(root, {"self_ledger": True, "steps": [
        {"mark": 97000, "pos": 1}, {"lot": 0.001, "mark": 97000, "pos": 0, "idle_round": True}]})
    s = r["steps"]
    check(s[1]["fills"] == [["sell", 0.01, 97000.0]] and s[1]["book"] == {}
          and not s[1]["idle_calls"] and len(r["writeoffs"]) == 1
          and "lot" in r["writeoffs"][0]["reason"],
          "rounding remainder: sub-lot dust is written off with an audit line",
          f"{s[1]['fills']} book={s[1]['book']} writeoffs={r['writeoffs']}")

    # the user closed the bot's position by hand; the signal then goes flat.
    # ONE read saying so is not believed; the second one is.
    gone = [{"mark": 100000, "pos": 1}, {"mark": 100000, "manual": -0.01}]
    r = run(root, {"self_ledger": True, "lot": 0.001, "steps": gone + [
        {"mark": 100000, "pos": 0, "max_rounds": 1},
        {"mark": 100000, "reconcile": True, "max_rounds": 1, "idle_round": True},
        {"mark": 100000, "pos": 1}]})
    s = r["steps"]
    check(s[2]["writeoffs"] == 0 and s[2]["book"] != {} and not s[2]["fills"],
          "account read empty ONCE: the book is kept", str(s[2]))
    check(s[3]["writeoffs"] == 1 and s[3]["book"] == {} and not s[3]["fills"]
          and not s[3]["idle_calls"]
          and r["writeoffs"][0]["reason"] == "account holds none of it"
          and "short_first" in r["writeoffs"][0],
          "account read empty TWICE: written off, audited with both reads, nothing re-sent",
          f"{s[3]} {r['writeoffs']}")
    check(s[4]["fills"] == [["buy", 0.01, 100000.0]],
          "account already flat: the next entry signal really enters")

    r = run(root, {"self_ledger": True, "lot": 0.001, "short_gap": 5, "steps": gone + [
        {"mark": 100000, "pos": 0, "max_rounds": 1},
        {"mark": 100000, "reconcile": True, "max_rounds": 1}]})
    check(r["steps"][3]["writeoffs"] == 0 and r["steps"][3]["book"] != {},
          "two empty reads inside one poll interval are still one read", str(r["steps"][3]))

    # the position IS there and the venue's read drops it (OKX markPx, a read a
    # beat behind a fill): the close must still go out — not a silent zero that
    # leaves 0.01 BTC on the account with nobody managing it
    r = run(root, {"self_ledger": True, "lot": 0.001, "steps": [
        {"mark": 100000, "pos": 1}, {"mark": 100000, "pos": 0, "misread": True}]})
    s = r["steps"]
    check(s[1]["fills"] == [["sell", 0.01, 100000.0]] and s[1]["paper_qty"] == 0
          and s[1]["writeoffs"] == 0 and s[1]["book"] == {},
          "position misread as empty: closed by an order, never written off", str(s[1]))

    # a wrong empty read that REPEATS after a real close must not count the
    # stale first read: the fill cleared it
    r = run(root, {"self_ledger": True, "lot": 0.001, "steps": [
        {"mark": 100000, "pos": 1}, {"mark": 100000, "pos": 0, "misread": True},
        {"mark": 100000, "pos": 1},
        {"mark": 100000, "pos": 0, "misread": True, "max_rounds": 1}]})
    s = r["steps"]
    check(s[3]["fills"] == [["sell", 0.01, 100000.0]] and s[3]["writeoffs"] == 0,
          "a misread on the NEXT position starts its own count", str(s[3]))

    # flip while the close leg has no verdict: the new side must wait
    r = run(root, {"self_ledger": True, "lot": 0.001, "steps": gone + [
        {"mark": 100000, "pos": -1, "max_rounds": 1},
        {"mark": 100000, "reconcile": True}]})
    s = r["steps"]
    check(not s[2]["fills"] and s[2]["writeoffs"] == 0,
          "flip, close leg unconfirmed: the entry leg is held back", str(s[2]))
    check(s[3]["fills"] == [["sell", 0.01, 100000.0]] and s[3]["paper_qty"] == -0.01
          and s[3]["book"] == {"BTCUSDT": {"qty": -0.01, "cost": -1000.0, "legacy": False}},
          "flip, confirmed next round: written off, then the short opens — book = account",
          str(s[3]))
    r = run(root, {"self_ledger": True, "lot": 0.001, "steps": [
        {"mark": 100000, "pos": 1}, {"mark": 100000, "pos": -1, "misread": True}]})
    s = r["steps"]
    check(s[1]["paper_qty"] == -0.01
          and s[1]["book"] == {"BTCUSDT": {"qty": -0.01, "cost": -1000.0, "legacy": False}},
          "flip with the long misread as empty: net position and book still agree",
          f"{s[1]['fills']} qty={s[1]['paper_qty']} book={s[1]['book']}")

    okx = subprocess.run([sys.executable, "-c", OKX_PROBE], cwd=root, capture_output=True,
                         text=True)
    check(okx.stdout.strip() == "raised raised",
          "OKX: a non-zero position with no markPx raises instead of reading as flat",
          okx.stdout + okx.stderr[-300:])

    # ── books from before the quantity book ────────────────────────────────
    held = [old_leg("2026-02-01T00:00:00", 1000.0, 0.01, 100000.0)]
    r = run(root, {"self_ledger": True, "lot": 0.001, "pre_seed": OLD_SEED, "pre_log": held,
                   "steps": [{"mark": 100000, "manual": 0.03},   # 0.01 of it is the bot's
                             {"mark": 120000, "pos": 1}, {"mark": 120000, "pos": 0}]})
    s = r["steps"]
    check(not s[1]["fills"] and not s[1]["calls"],
          "old book, position held: updating does not trade")
    check(s[2]["fills"] == [["sell", 0.01, 120000.0]] and s[2]["paper_qty"] == 0.02,
          "old book: quantity replayed from executed_qty, close is exact", str(s[2]))
    check(bool(r["adoption"]) and r["adoption"]["symbols"]["BTCUSDT"]["mode"] == "qty",
          "old book: adoption is reported once (manager/ledger_migration.json)")

    ghost = held + [old_leg("2026-02-02T00:00:00", -800.0, 0.01, 80000.0, True)]
    r = run(root, {"self_ledger": True, "pre_seed": OLD_SEED, "pre_log": ghost, "steps": [
        {"mark": 80000, "pos": 0, "idle_round": True}, {"mark": 80000, "pos": 1}]})
    s = r["steps"]
    check(s[0]["book"] == {} and not s[0]["calls"] and not s[0]["idle_calls"],
          "old book with a phantom long (qty 0): dropped, nothing re-sent", str(s[0]))
    check(s[1]["fills"] == [["buy", 0.0125, 80000.0]], "old phantom: next entry is whole")

    absorbed = {"seeded_at": T0, "symbols": {"BTCUSDT": {"size": 1000.0, "ts": T0}}}
    r = run(root, {"self_ledger": True, "lot": 0.001, "pre_seed": absorbed, "steps": [
        {"mark": 100000, "manual": 0.01}, {"mark": 120000, "pos": 1},
        {"mark": 80000, "pos": 0, "idle_round": True}, {"mark": 80000, "pos": 1}]})
    s = r["steps"]
    check(s[1]["book"] == {"BTCUSDT": {"qty": 0.0, "cost": 1000.0, "legacy": True}}
          and not s[1]["fills"], "absorbed USD-only seed: a LEGACY row, no quantity invented")
    check(s[2]["fills"] == [["sell", 0.01, 80000.0]] and s[2]["book"] == {}
          and not s[2]["idle_calls"],
          "legacy row: closes the old way, then is written off (no phantom)", str(s[2]))
    check(s[3]["book"] == {"BTCUSDT": {"qty": 0.012, "cost": 960.0, "legacy": False}}
          or s[3]["book"] == {"BTCUSDT": {"qty": 0.013, "cost": 1040.0, "legacy": False}},
          "legacy row: after its close the symbol is a quantity row", str(s[3]["book"]))

    no_qty = [old_leg("2026-02-01T00:00:00", 1000.0)]
    r = run(root, {"self_ledger": True, "pre_seed": OLD_SEED, "pre_log": no_qty,
                   "steps": [{"mark": 100000, "pos": 1}]})
    check(r["steps"][0]["book"]["BTCUSDT"]["legacy"] is True,
          "a fill with no executed_qty makes a legacy row, not a guessed quantity")

    # ── async executors and spot, closing 20% above entry beside a manual holding
    for style in ({"type": "twap", "duration_min": 4}, {"type": "chase"}):
        r = run(root, {"self_ledger": True, "lot": 0.001, "fast_async": True, "amount": 2000,
                       "execution": style, "steps": [
                           {"mark": 100000, "manual": 0.02}, {"mark": 100000, "pos": 1},
                           {"mark": 120000, "pos": 1}, {"mark": 120000, "pos": 0}]})
        s = r["steps"]
        check(s[1]["paper_qty"] == 0.04 and not s[2]["fills"] and s[3]["paper_qty"] == 0.02
              and s[3]["book"] == {} and sold(r) == 0.02,
              f"{style['type']}: async close sells the 0.02 bought, the user's 0.02 stays",
              f"qty={[x['paper_qty'] for x in s]} sold={sold(r)} book={s[3]['book']}")
        legs = [l for x in s for e in x["log"] for l in e["legs"]]
        check(all("signed_qty" in l for l in legs), f"{style['type']}: every leg books signed_qty")

    r = run(root, {"self_ledger": True, "spot": True, "steps": [
        {"mark": 100000, "manual": 0.02}, {"mark": 100000, "pos": 1},
        {"mark": 120000, "pos": 1}, {"mark": 120000, "pos": 0}]})
    s = r["steps"]
    check(not s[2]["fills"] and abs(s[3]["spot"] - s[0]["spot"]) < 1e-9 and s[3]["book"] == {},
          "spot: close sells the coins bought, the user's coins stay",
          f"spot={[x['spot'] for x in s]} book={s[3]['book']}")


def partial_update_checks(base):
    print(f"\n== partial update: new wiring/execute/flatten beside {BASELINE}'s lib/portfolio.py")
    mixed = os.path.join(TMP, "MIXED")
    for d in ("lib", "manager"):
        shutil.copytree(os.path.join(ROOT, d), os.path.join(mixed, d),
                        ignore=shutil.ignore_patterns("__pycache__", "*.json", "*.jsonl"))
    shutil.copy(os.path.join(base, "lib", "portfolio.py"),
                os.path.join(mixed, "lib", "portfolio.py"))
    steps = HOLD + [{"mark": 80000, "pos": 0}]
    for sl in (False, True):
        for style in (None, {"type": "twap", "duration_min": 4}, {"type": "chase"}):
            case = {"self_ledger": sl, "lot": 0.001, "steps": steps}
            if style:
                case.update(fast_async=True, amount=2000, execution=style)
            a, b = run(mixed, case), run(base, case)
            same = all(x["fills"] == y["fills"] and x["log"] == y["log"]
                       and x["error"] == y["error"] for x, y in zip(a["steps"], b["steps"]))
            check(same and sold(a) > 0 and not any(x["error"] for x in a["steps"]),
                  f"self_ledger={sl} {style['type'] if style else 'market'}: the close "
                  f"goes out and is logged exactly as {BASELINE} does",
                  str([(x["fills"], x["error"]) for x in a["steps"]]))

    # the other direction: today's lib/portfolio.py beside a lib/data.py from
    # before _kline_source (the drift band's σ lookup reaches for it) — the
    # AttributeError must land on the 5% floor, never in the reconcile round
    print("== partial update: new lib/portfolio.py beside a lib/data.py without _kline_source")
    old_data = os.path.join(TMP, "OLDDATA")
    for d in ("lib", "manager"):
        shutil.copytree(os.path.join(ROOT, d), os.path.join(old_data, d),
                        ignore=shutil.ignore_patterns("__pycache__", "*.json", "*.jsonl"))
    src = open(os.path.join(ROOT, "lib", "data.py")).read()
    assert "def _kline_source" in src
    open(os.path.join(old_data, "lib", "data.py"), "w").write(
        src.replace("def _kline_source", "def _kline_source_gone"))
    r = run(old_data, {"self_ledger": False, "lot": 0.001, "steps": [
        {"mark": 100000, "pos": 1}, {"mark": 103000, "pos": 1, "idle_round": True},
        {"mark": 106000, "pos": 1}]})
    s = r["steps"]
    check(not any(x["error"] for x in s) and not s[1]["calls"] and not s[1]["idle_calls"]
          and s[2]["calls"],
          "old data.py: σ lookup fails quietly, the 5% floor holds +3% and lets +6% through",
          str([(x["calls"], x["error"]) for x in s]))


def pending_expiry_check(root):
    """A short-read record nobody cleared must stop holding the entry back once
    it is older than the expiry (audit re-check, point c)."""
    ws = os.path.join(TMP, "pending")
    os.makedirs(os.path.join(ws, "state"))
    code = (
        "import json, sys, time; sys.path.insert(0, sys.argv[1])\n"
        "from lib import portfolio as p\n"
        "now = time.time(); old = now - p._ACCOUNT_SHORT_MAX_S - 60\n"
        "json.dump({'OLDUSDT': {'first': old, 'last': old}, 'NEWUSDT': {'first': now, 'last': now}},"
        " open(p._ACCOUNT_SHORT_PATH, 'w'))\n"
        "print(json.dumps([p.account_short_pending(s) for s in ('OLDUSDT', 'NEWUSDT', 'NONE')]))\n")
    out = subprocess.run([sys.executable, "-c", code, root], cwd=ws, capture_output=True, text=True)
    got = json.loads(out.stdout.strip().splitlines()[-1]) if out.returncode == 0 and out.stdout.strip() else out.stderr[-300:]
    check(got == [False, True, False], "stale short-read record stops blocking the entry; a fresh one still does", str(got))


def off_mode_checks(head):
    print(f"\n== self_ledger OFF and lot-based books: identical to {BASELINE}, order by order")
    scripts = {
        "A": HOLD + [{"mark": 80000, "pos": 0}],
        "B": HOLD[:2] + [{"mark": 120000, "pos": 0}],
        "manual": [{"mark": 100000, "manual": 0.02}] + HOLD + [{"mark": 80000, "pos": 0}],
        "flip": [{"mark": 100000, "pos": 1}, {"mark": 80000, "pos": -1},
                 {"mark": 125000, "pos": 0.5}, {"mark": 100000, "pos": 0}],
    }
    for name, steps in scripts.items():
        for lot in (0, 0.001):
            case = {"self_ledger": False, "lot": lot, "steps": steps, "no_band": True}
            a, b = run(ROOT, case), run(head, case)
            same = all(x["fills"] == y["fills"] and x["log"] == y["log"]
                       and x["calls"] == y["calls"] for x, y in zip(a["steps"], b["steps"]))
            n = sum(len(x["fills"]) for x in a["steps"])
            check(same and n > 0, f"OFF {name} lot={lot or 'native'}: {n} orders, fills + "
                                  f"orders.jsonl identical to {BASELINE}")
    # The flat gate on a whole-position close changes nothing here: an
    # account-read diff is at the mark, so one lot is already over half of one…
    for side in (1, -1):
        case = {"self_ledger": False, "lot": 0.001, "amount": 110, "no_band": True, "steps": [
            {"mark": 100000, "pos": side}, {"mark": 250000, "pos": 0}]}
        a, b = run(ROOT, case), run(head, case)
        same = all(x["fills"] == y["fills"] and x["log"] == y["log"]
                   and x["calls"] == y["calls"] for x, y in zip(a["steps"], b["steps"]))
        check(same and a["steps"][1]["paper_qty"] == 0 and len(a["steps"][1]["fills"]) == 1,
              f"OFF one lot {'long' if side > 0 else 'short'}, mark x2.5, signal flat: "
              f"closes, identical to {BASELINE}", str(a["steps"][1]))
    # …and dust under the flat threshold is still never sent to the venue
    for name, case in {
        "one 5-USD lot": {"lot": 0.001, "steps": [{"mark": 5000, "manual": 0.001},
                                                  {"mark": 5000, "pos": 0, "idle_round": True}]},
        "5 USD, no lot grid": {"steps": [{"mark": 100000, "manual": 0.00005},
                                         {"mark": 100000, "pos": 0, "idle_round": True}]},
        "5 USD of spot": {"spot": True, "steps": [{"mark": 100000, "manual": 0.00005},
                                                  {"mark": 100000, "pos": 0, "idle_round": True}]},
    }.items():
        case["self_ledger"], case["no_band"] = False, True
        a, b = run(ROOT, case), run(head, case)
        quiet = all(not x["calls"] and not x["idle_calls"] and not x["fills"] and not x["log"]
                    for x in a["steps"][1:])
        same = all(x["calls"] == y["calls"] and x["idle_calls"] == y["idle_calls"]
                   and x["paper_qty"] == y["paper_qty"] and x["spot"] == y["spot"]
                   for x, y in zip(a["steps"], b["steps"]))
        check(quiet and same, f"OFF dust ({name}), target flat: no place_order call, "
                              f"same as {BASELINE}", str(a["steps"][1]))

    for style in ({"type": "twap", "duration_min": 4}, {"type": "chase"}):
        case = {"self_ledger": False, "lot": 0.001, "fast_async": True, "amount": 2000,
                "execution": style, "steps": scripts["A"], "no_band": True}
        a, b = run(ROOT, case), run(head, case)
        same = all(x["fills"] == y["fills"] and x["log"] == y["log"]
                   for x, y in zip(a["steps"], b["steps"]))
        check(same and sold(a) > 0, f"OFF {style['type']}: identical to {BASELINE}")
    for sl in (False, True):
        case = {"self_ledger": sl, "wiring": "fake_lots", "amount": 4, "steps": [
            {"pos": 1}, {"pos": 0.5}, {"pos": 1.5}, {"pos": -1}, {"pos": 0}]}
        a, b = run(ROOT, case), run(head, case)
        same = [x["calls"] for x in a["steps"]] == [x["calls"] for x in b["steps"]]
        n = sum(len(x["calls"]) for x in a["steps"])
        check(same and n >= 6, f"lot-based (capital-shaped) book, self_ledger={sl}: "
                               f"{n} place_order calls identical to {BASELINE}")


if __name__ == "__main__":
    if len(sys.argv) > 2 and sys.argv[1] == "--child":
        child(json.loads(sys.argv[2]))
        sys.exit(0)
    try:
        if len(sys.argv) > 2 and sys.argv[1] == "--root":
            on_mode_checks(os.path.abspath(sys.argv[2]))
        else:
            head = os.path.join(TMP, "HEAD")
            os.makedirs(head)
            tar = subprocess.run(["git", "-C", ROOT, "archive", BASELINE, "lib", "manager"],
                                 capture_output=True, check=True)
            subprocess.run(["tar", "-x", "-C", head], input=tar.stdout, check=True)
            on_mode_checks(ROOT)
            pending_expiry_check(ROOT)
            partial_update_checks(head)
            off_mode_checks(head)
    finally:
        if fails:
            print(f"\n(workspaces kept: {TMP})")
        else:
            shutil.rmtree(TMP, ignore_errors=True)
    print("FAILED: " + "; ".join(fails) if fails else "all ok")
    sys.exit(1 if fails else 0)
