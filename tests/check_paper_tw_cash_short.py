"""A paper TW stock basket sized past the paper cash (work order
paper-twstock-cash-short): the real reconciler round buys until the cash runs
out and every other stock fails with a row the readers can classify — token
[order_reject:insufficient_margin] in front, exchange "paper", the TW code
with @spot, "(cash < cost)" with cash below cost. The desktop / web / api /
App readers pick the paper-cash sentence off exactly these three fields
(tests/check_shell_paper_tw_cash_text.js feeds this row shape); a lib change
that drops any of them makes them fall back to the leverage sentence.
Control: an amount inside the cash fills every stock, no row.

Reuses the paper scenario harness (tests/check_paper_scenarios.py World) in a
child process: no network, no .env, crontab sync stubbed. Fake codes, fake
prices, fixed rate. Fill order follows set iteration (PYTHONHASHSEED), so
only invariants are asserted, never which symbols fill.

Run: cd blave-agent && .venv/bin/python tests/check_paper_tw_cash_short.py [--src DIR]
"""
import argparse, json, os, re, shutil, subprocess, sys, tempfile, time

HERE = os.path.dirname(os.path.abspath(__file__))
CODES = [str(9101 + i) for i in range(30)]
PX = [25.0, 48.0, 75.0, 120.0, 180.0, 260.0, 350.0, 520.0, 780.0, 1050.0]
PRICES = {c: PX[i % len(PX)] for i, c in enumerate(CODES)}
RATE = 32.0
# name: (ledger cash USD, strategy amount TWD)
CASES = {"old_10k": (10_000.0, 1_000_000), "old_10k_inside": (10_000.0, 300_000),
         "new_100k": (100_000.0, 5_000_000), "new_100k_inside": (100_000.0, 3_000_000)}
ROW_RE = re.compile(r"^\[order_reject:insufficient_margin\] insufficient paper cash for (\d{4,6}) buy "
                    r"\((\d+\.\d+) < (\d+\.\d+)\)$")
# A repeat inside the hour bumps count/last_at instead of a new row (lib/portfolio
# _record_order_error) — but the file keeps 5 rows, so with more than 5 failing
# symbols every row is evicted before its repeat and each round writes 5 new rows,
# each a P1 on the platform. Red today; the fix is an api-side P1 cooldown for
# order_error (agent_events), not the machine — flip to False once the machine
# stops writing a fresh row per round.
KNOWN_BUG_ROW_CHURN = True

STRAT = '''STRATEGY_NAME = "tw_eq30"
MARKET = "spot"
INTERVAL = "1d"
START = "2020-01-01"
UNIVERSE = {codes!r}
'''


def child(case, ws, src):
    sys.path.insert(0, os.path.join(src, "tests"))
    import check_paper_scenarios as cps
    w = cps.World(ws, src)
    import pandas as pd
    from lib import data, order_paper, paper_data

    def daily(code, start, end, hdrs):
        px = PRICES[code]
        idx = pd.date_range(end=pd.Timestamp.now().floor("D"), periods=3, freq="D")
        return pd.DataFrame({"Open": px, "High": px, "Low": px, "Close": px, "Volume": 1.0}, index=idx)
    data.fetch_twstock_price = data.fetch_twstock_price_adj = daily
    data.is_tw_trading_day = lambda *a, **k: True
    paper_data.tw_session_open = order_paper.tw_session_open = lambda env=None, now=None: True
    json.dump({"rates": {"TWD": RATE}, "ts": int(time.time())}, open("state/paper_fx.json", "w"))
    paper_data._fx_cache.clear()

    cash0, amount = CASES[case]
    os.makedirs("strategies/tw_eq30", exist_ok=True)
    open("strategies/tw_eq30/strategy.py", "w").write(STRAT.format(codes=CODES))
    json.dump({"benchmark_return": 0.0, "total_return": 0.0}, open("strategies/tw_eq30/stats.json", "w"))
    w.bind_paper()
    order_paper.snapshot(w.env())
    led = json.load(open(order_paper.LEDGER_PATH))
    led["initial_cash"] = led["cash"] = cash0   # a ledger opened before DEFAULT_CASH went to 100,000
    json.dump(led, open(order_paper.LEDGER_PATH, "w"))
    w.amounts(tw_eq30=amount)
    w.weights("tw_eq30", {c: 1 / 30 for c in CODES}, cps.T1)
    w.start()
    rounds = []
    for _ in range(3):
        out = w.round()
        led = json.load(open(order_paper.LEDGER_PATH))
        rounds.append({"out": out, "held": sorted(led.get("spot") or {}), "cash": led["cash"],
                       "rows": w.order_errors(), "tg": [str(x) for x in w.tg]})
    print("RESULT " + json.dumps(rounds, ensure_ascii=False))
    return 0


def run(case, src, base):
    sys.path.insert(0, os.path.join(src, "tests"))
    import check_paper_scenarios as cps
    ws = cps.make_ws(src, base)
    env = cps._child_env(base, src)
    env["BLAVE_AGENT_WORKSPACE"] = env["BLAVE_HOME"] = ws
    env["BLAVE_AGENT_HOME"] = env["BLAVECLAW_HOME"] = env["BLAVE_AGENT_BASE"] = ws
    p = subprocess.run([sys.executable, os.path.abspath(__file__), "--child", case, "--ws", ws, "--src", src],
                       cwd=ws, env=env, capture_output=True, text=True, timeout=300)
    line = next((l for l in p.stdout.splitlines() if l.startswith("RESULT ")), None)
    if not line:
        print(p.stdout[-2000:] + p.stderr[-2000:])
    return json.loads(line[7:]) if line else None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--child")
    ap.add_argument("--ws")
    ap.add_argument("--src", default=os.path.dirname(HERE))
    a = ap.parse_args()
    src = os.path.abspath(a.src)
    if a.child:
        sys.exit(child(a.child, a.ws, src))
    sys.path.insert(0, os.path.join(src, "tests"))
    import check_paper_scenarios as cps
    base = tempfile.mkdtemp(prefix="papertwcash-")
    open(os.path.join(base, "sitecustomize.py"), "w").write(cps.SITECUSTOMIZE)
    fails = 0

    def check(cond, msg):
        nonlocal fails
        print(("ok   " if cond else "FAIL ") + msg)
        fails += 0 if cond else 1
        return cond

    try:
        for case, (cash0, amount) in CASES.items():
            print(f"== {case}: ledger {cash0:,.0f} USD, strategy {amount:,} TWD ({amount / RATE:,.0f} USD)")
            r = run(case, src, base)
            if not check(r is not None and r[0]["out"] == "ok", f"the round ran ({r and r[0]['out']})"):
                continue
            r1 = r[0]
            n_fail = sum("Order failed" in t for t in r1["tg"])
            if amount / RATE * 1.005 <= cash0:
                check(len(r1["held"]) == 30 and not r1["rows"] and n_fail == 0,
                      f"inside the cash: all 30 filled, no row ({len(r1['held'])}, {len(r1['rows'])} rows)")
                continue
            check(0 < len(r1["held"]) < 30 and len(r1["held"]) + n_fail == 30,
                  f"bought until the cash ran out, every other stock failed ({len(r1['held'])} + {n_fail})")
            per = amount / 30 / RATE
            check(r1["cash"] < per * 1.005, f"what is left ({r1['cash']:.2f}) buys no further stock ({per:.2f})")
            check(r1["rows"] and len(r1["rows"]) <= 5, f"order_errors keeps the newest 5 ({len(r1['rows'])})")
            for e in r1["rows"]:
                m = ROW_RE.match(e.get("error", ""))
                good = (m and e.get("exchange") == "paper" and e.get("symbol") == f"{m.group(1)}@spot"
                        and float(m.group(2)) < float(m.group(3)) and abs(float(m.group(2)) - r1["cash"]) < 0.01)
                check(bool(good), f"row readers can classify: token in front, paper, TW @spot, cash < cost ({e})")
            new2 = {(e["ts"], e["symbol"]) for e in r[1]["rows"]} - {(e["ts"], e["symbol"]) for e in r1["rows"]}
            churn = len(new2) > 0
            if KNOWN_BUG_ROW_CHURN:
                print(f"xfail a repeat round writes {len(new2)} new rows (known bug: 5-row window evicts before the bump)"
                      if churn else "XPASS row churn gone — set KNOWN_BUG_ROW_CHURN = False")
                fails += 0 if churn else 1
            else:
                check(not churn, f"a repeat round inside the hour writes no new row ({len(new2)})")
            check(sum("Order failed" in t for t in r[2]["tg"]) == n_fail, "machine TG: no repeat notice inside the hour")
    finally:
        shutil.rmtree(base, ignore_errors=True)
    print(f"\n{'ALL OK' if not fails else f'{fails} FAILED'}")
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main())
