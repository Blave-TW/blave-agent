"""What the machine trades after a 下單設定 save — the reference side of
tests/check_shell_a1_save.js § 存檔後的路由.

Reads one scenario (JSON on stdin), builds a throwaway workspace, and prints what
the page would be handed and what the machine then does:
  report  — the real reporter's venues(), strategy_states() and save_routing for
            that workspace (the shell reads exactly these)
  before / targets — lib/portfolio.aggregate_portfolio() on the config as it was,
            and after the real save (runtime command_listener._cmd_amounts)
  exchanges — the routing the save wrote
or {"error": "..."} when the save refuses.

Scenario:
  env       venues with a complete .env pair, e.g. ["paper", "binance"]
  manifest  ids in manager/credentials.ui.json; null = no manifest (an old machine)
  libs      {venue: ["order", "account"]} of lib files in the workspace; absent = both for every env venue
  before    {"amounts": {...}, "exchanges": {...}} — the saved config
  send      the amounts the save sends
  strategies {name: {"symbol" | "weights", "market" (null = no MARKET line), "position", "raw_closes"}}
"""
import json
import os
import shutil
import sys
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sc = json.load(sys.stdin)
BASE = tempfile.mkdtemp(prefix="cf-after-")
WS = os.path.join(BASE, "workspace")
for d in ("manager", "state", "lib"):
    os.makedirs(os.path.join(WS, d))
os.environ["BLAVE_AGENT_BASE"] = BASE
os.environ["BLAVE_AGENT_WORKSPACE"] = WS
os.environ.pop("BLAVE_AGENT_LOCAL", None)
sys.path.insert(0, os.path.join(ROOT, "runtime"))
sys.path.insert(0, ROOT)
os.chdir(WS)
try:
    for n, s in sc["strategies"].items():
        d = os.path.join(WS, "strategies", n)
        os.makedirs(d)
        sym = s.get("symbol")
        code = (f'SYMBOL = "{sym}"\n' if sym else "UNIVERSE = %s\n" % json.dumps(sorted(s["weights"])))
        code += f'MARKET = "{s["market"]}"\n' if s.get("market") else ""
        open(os.path.join(d, "strategy.py"), "w").write(code + 'INTERVAL = "1d"\n')
        json.dump({"symbol": sym} if sym else {}, open(os.path.join(d, "stats.json"), "w"))
        state = {"symbol": sym, "position": s["position"]} if sym else {"weights": s["weights"], "rebalance_at": 1}
        if s.get("raw_closes"):
            state["raw_closes"] = s["raw_closes"]
            state["raw_close_dates"] = {k: "2026-10-21" for k in s["raw_closes"]}
        json.dump(state, open(os.path.join(d, "state.json"), "w"))
    open(os.path.join(WS, "manager", "wait_for_bar.py"), "w").write("# present\n")
    open(os.path.join(WS, ".env"), "w").write(
        "".join(f"{v.upper()}_API_KEY={v}\n{v.upper()}_SECRET_KEY={v}\n" for v in sc["env"]))
    if sc.get("manifest") is not None:
        json.dump({"ids": sc["manifest"]}, open(os.path.join(WS, "manager", "credentials.ui.json"), "w"))
    libs = sc.get("libs") or {v: ["order", "account"] for v in sc["env"]}
    for v, kinds in libs.items():
        for k in kinds:
            open(os.path.join(WS, "lib", f"{k}_{v}.py"), "w").write("# present\n")
    before = sc["before"]
    json.dump(before, open(os.path.join(WS, "manager", "portfolio_config.json"), "w"))
    json.dump(before, open(os.path.join(WS, "manager", "amounts.ui.json"), "w"))
    for f in ("portfolio.py", "paper_data.py"):
        shutil.copy(os.path.join(ROOT, "lib", f), os.path.join(WS, "lib", f))
    import command_listener as cl  # noqa: E402
    import portfolio_reporter as pr  # noqa: E402
    import save_routing  # noqa: E402
    from lib import portfolio  # noqa: E402
    cl._sync_strategy_crons = lambda names: None
    cl.reconciler_presence.unsupervised_reconciler_pids = lambda proc="/proc", all_=False, workspace=None: []
    cl._unsupervised_reconciler_pids = lambda proc="/proc", all_=False: []

    def targets():
        out = {}
        for k, t in portfolio.aggregate_portfolio().items():
            size = float(t.get("size") or 0)
            out[k] = size if t.get("side") == "long" else -size if t.get("side") == "short" else 0.0
        return out

    report = {"venues": pr.venues(), "states": pr.strategy_states(),
              "save_routing": save_routing.report(json.load(open(os.path.join(WS, "manager", "portfolio_config.json"))), WS)}
    pre = targets()
    try:
        cl._cmd_amounts({"amounts": sc["send"]})
    except (ValueError, RuntimeError) as e:
        print(json.dumps({"error": str(e), "report": report}))
        sys.exit(0)
    cfg = json.load(open(os.path.join(WS, "manager", "portfolio_config.json")))
    print(json.dumps({"report": report, "exchanges": cfg.get("exchanges"), "before": pre, "targets": targets()}))
finally:
    shutil.rmtree(BASE, ignore_errors=True)
