"""A broken route (a hand-edited list / dict in portfolio_config exchanges) never moves a
strategy to another venue, and never takes the report down (稽核 v029-028bugs r2 P2-1, r3 P1-1).

  1. plan(): such a value reads as "" instead of raising TypeError (unhashable).
  2. the report's save_routing for that config is produced; the broken entries route nowhere
     ("" — not the default: the save refuses that config, so nothing moves).
  3. build_report(): save_routing.report raising anyway → save_routing None, the rest of the
     report unchanged (the pages fall back to their own derivation, as on an older runtime).
  4. the save (R3-LIST1: Binance + paper bound, btc → binance, b2 hand-edited to ["paper"]):
     refused BAD_ROUTE naming b2, mirror and config untouched, the reconciler still routes b2
     to paper — never inherited onto Binance.

Run: cd blave-agent && .venv/bin/python tests/check_save_routing.py
"""
import json
import os
import shutil
import sys
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BASE = tempfile.mkdtemp(prefix="save-routing-")
WS = os.path.join(BASE, "workspace")
for d in ("manager", "state", "lib"):
    os.makedirs(os.path.join(WS, d))
os.environ["BLAVE_AGENT_BASE"] = BASE
os.environ["BLAVE_AGENT_WORKSPACE"] = WS
os.environ.pop("BLAVE_AGENT_LOCAL", None)
sys.path.insert(0, os.path.join(ROOT, "runtime"))
sys.path.insert(0, ROOT)
os.chdir(WS)
import command_listener as cl  # noqa: E402
import portfolio_reporter as pr  # noqa: E402
import save_routing  # noqa: E402
from lib import portfolio  # noqa: E402

fails = 0
CONFIG = os.path.join(WS, "manager", "portfolio_config.json")
MIRROR = os.path.join(WS, "manager", "amounts.ui.json")


def check(cond, msg):
    global fails
    print(("ok   " if cond else "FAIL ") + msg)
    fails += 0 if cond else 1


try:
    open(os.path.join(WS, ".env"), "w").write("PAPER_API_KEY=paper\nPAPER_SECRET_KEY=paper\n")
    json.dump({"ids": ["paper"]}, open(os.path.join(WS, "manager", "credentials.ui.json"), "w"))
    bad = {"amounts": {"a": 100, "b": 200, "c": 300}, "exchanges": {"a": ["paper"], "b": {"x": 1}, "c": "paper"}}

    try:
        kept, default = save_routing.plan(bad["exchanges"], {"paper"})
        ok1 = kept == {"a": "", "b": "", "c": "paper"} and default == "paper"
    except Exception as e:
        ok1, kept, default = False, repr(e), None
    check(ok1, f"1 plan(): list / dict routes read as \"\", no TypeError ({kept}, {default!r})")

    sr = save_routing.report(bad, WS)
    check(sr == {"bound": ["paper"], "default": "paper", "routes": {"a": "", "b": "", "c": "paper"}},
          f"2 report(): produced; the broken entries route nowhere, not to the default ({sr})")

    json.dump(bad, open(CONFIG, "w"))
    rep = pr.build_report()
    check(isinstance(rep.get("save_routing"), dict) and rep["save_routing"]["routes"]["a"] == ""
          and rep.get("config") == bad, "3 build_report() with that config: report and save_routing both produced")

    real = save_routing.report

    def _boom(cfg, ws):
        raise TypeError("boom")

    save_routing.report = _boom
    try:
        rep2 = pr.build_report()
    finally:
        save_routing.report = real
    check(rep2.get("save_routing", "absent") is None and rep2.get("config") == bad and "venues" in rep2,
          "3 save_routing.report raising → save_routing None, the rest of the report intact")

    # ── 4. R3-LIST1: the save refuses, nothing moves to Binance ──
    for n, sym in (("btc", "BTCUSDT"), ("b2", "ETHUSDT")):
        d = os.path.join(WS, "strategies", n)
        os.makedirs(d, exist_ok=True)
        open(os.path.join(d, "strategy.py"), "w").write(f'SYMBOL = "{sym}"\nINTERVAL = "1h"\n')
        json.dump({"symbol": sym}, open(os.path.join(d, "stats.json"), "w"))
        json.dump({"symbol": sym, "position": 1}, open(os.path.join(d, "state.json"), "w"))
    open(os.path.join(WS, "manager", "wait_for_bar.py"), "w").write("# present\n")
    open(os.path.join(WS, ".env"), "w").write(
        "BINANCE_API_KEY=b\nBINANCE_SECRET_KEY=b\nPAPER_API_KEY=paper\nPAPER_SECRET_KEY=paper\n")
    json.dump({"ids": ["binance", "paper"]}, open(os.path.join(WS, "manager", "credentials.ui.json"), "w"))
    for f in ("portfolio.py", "paper_data.py"):
        shutil.copy(os.path.join(ROOT, "lib", f), os.path.join(WS, "lib", f))
    cl._sync_strategy_crons = lambda names: None
    cl.reconciler_presence.unsupervised_reconciler_pids = lambda proc="/proc", all_=False, workspace=None: []
    cl._unsupervised_reconciler_pids = lambda proc="/proc", all_=False: []
    mirror = {"amounts": {"btc": 500, "b2": 300}, "exchanges": {"btc": "binance", "b2": "paper"}}
    json.dump(mirror, open(MIRROR, "w"))
    json.dump({"amounts": {"btc": 500, "b2": 300}, "exchanges": {"btc": "binance", "b2": ["paper"]}}, open(CONFIG, "w"))
    before = (open(CONFIG).read(), open(MIRROR).read())
    try:
        cl._cmd_amounts({"amounts": {"btc": 800, "b2": 300}})
        err = None
    except (ValueError, RuntimeError) as e:
        err = str(e)
    check(bool(err) and err.startswith("BAD_ROUTE:") and "「b2」" in err and "btc" not in err,
          f"4 the save refuses BAD_ROUTE naming b2 only ({err})")
    check((open(CONFIG).read(), open(MIRROR).read()) == before, "4 …config and mirror untouched")
    t = portfolio.aggregate_portfolio()
    check((t.get("ETHUSDT") or {}).get("exchange") == "paper" and (t.get("BTCUSDT") or {}).get("exchange") == "binance",
          f"4 …the reconciler still routes b2 to paper, btc to binance ({ {k: v.get('exchange') for k, v in t.items()} })")
    sr4 = save_routing.report(json.load(open(CONFIG)), WS)
    check(sr4["routes"] == {"btc": "binance", "b2": ""}, f"4 …the report previews b2 as no route ({sr4})")
finally:
    shutil.rmtree(BASE, ignore_errors=True)

print(f"\ncheck_save_routing: {fails} FAILED" if fails else "\ncheck_save_routing: all ok")
sys.exit(1 if fails else 0)
