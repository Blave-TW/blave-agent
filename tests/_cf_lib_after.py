"""What the machine trades after a 下單設定 save — the reference side of
tests/check_shell_a1_save.js § 存檔後的路由.

Reads one scenario (JSON on stdin), builds a throwaway workspace, runs the real
save (runtime command_listener._cmd_amounts) and the reconciler's own target
read (lib/portfolio.aggregate_portfolio), and prints
{"exchanges": {...}, "before": {key: signed money}, "targets": {...}} or {"error": "..."}
("before" = the same read on the config as it was, before the save).

Scenario: {"venues": ["paper"], "before": {"amounts": {...}, "exchanges": {...}},
           "send": {...}, "strategies": {name: {"symbol", "market", "position"}}}
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
        open(os.path.join(d, "strategy.py"), "w").write(
            f'SYMBOL = "{s["symbol"]}"\nMARKET = "{s["market"]}"\nINTERVAL = "1h"\n')
        json.dump({"symbol": s["symbol"]}, open(os.path.join(d, "stats.json"), "w"))
        json.dump({"symbol": s["symbol"], "position": s["position"]}, open(os.path.join(d, "state.json"), "w"))
    open(os.path.join(WS, "manager", "wait_for_bar.py"), "w").write("# present\n")
    env = "".join(f"{v.upper()}_API_KEY={v}\n{v.upper()}_SECRET_KEY={v}\n" for v in sc["venues"])
    open(os.path.join(WS, ".env"), "w").write(env)
    json.dump({"ids": sc["venues"]}, open(os.path.join(WS, "manager", "credentials.ui.json"), "w"))
    before = sc["before"]
    json.dump(before, open(os.path.join(WS, "manager", "portfolio_config.json"), "w"))
    json.dump(before, open(os.path.join(WS, "manager", "amounts.ui.json"), "w"))
    for f in ("portfolio.py", "paper_data.py"):
        shutil.copy(os.path.join(ROOT, "lib", f), os.path.join(WS, "lib", f))
    import command_listener as cl  # noqa: E402
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
    pre = targets()
    try:
        cl._cmd_amounts({"amounts": sc["send"]})
    except (ValueError, RuntimeError) as e:
        print(json.dumps({"error": str(e)}))
        sys.exit(0)
    cfg = json.load(open(os.path.join(WS, "manager", "portfolio_config.json")))
    print(json.dumps({"exchanges": cfg.get("exchanges"), "before": pre, "targets": targets()}))
finally:
    shutil.rmtree(BASE, ignore_errors=True)
