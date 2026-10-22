"""save_routing must never take the report down (稽核 v029-028bugs r2 P2-1).

  1. plan(): a hand-edited route that is a list / dict reads as no route (inherits the
     default) instead of raising TypeError (unhashable).
  2. the report's save_routing for such a config is produced, the bad entry routed to the default.
  3. build_report(): save_routing.report raising anyway → save_routing None, the rest of the
     report unchanged (the pages fall back to their own derivation, as on an older runtime).

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
import portfolio_reporter as pr  # noqa: E402
import save_routing  # noqa: E402

fails = 0


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
    check(ok1, f"1 plan(): list / dict routes read as no route, no TypeError ({kept}, {default!r})")

    sr = save_routing.report(bad, WS)
    check(sr == {"bound": ["paper"], "default": "paper", "routes": {"a": "paper", "b": "paper", "c": "paper"}},
          f"2 report(): produced, the bad entries inherit the default ({sr})")

    json.dump(bad, open(os.path.join(WS, "manager", "portfolio_config.json"), "w"))
    rep = pr.build_report()
    check(isinstance(rep.get("save_routing"), dict) and rep["save_routing"]["routes"]["a"] == "paper"
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
finally:
    shutil.rmtree(BASE, ignore_errors=True)

print(f"\ncheck_save_routing: {fails} FAILED" if fails else "\ncheck_save_routing: all ok")
sys.exit(1 if fails else 0)
