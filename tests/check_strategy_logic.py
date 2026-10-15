"""The `logic` field strategy_reporter reports for every strategy (the workspace's 策略邏輯).

  fixtures/strategy_logic.json  every case, also run by check_shell_strat_logic.js against
                                the desktop parser (shell/main.js stratLogic) — same answers
  _extract                      carries `logic` on every report; a file that does not parse
                                still reports (with or without logic), never raises

Run: cd blave-agent && .venv/bin/python tests/check_strategy_logic.py
"""
import json
import os
import sys
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BASE = tempfile.mkdtemp(prefix="strategy-logic-")
WS = os.path.join(BASE, "workspace")
os.makedirs(os.path.join(WS, "strategies"))
os.environ["BLAVE_AGENT_BASE"] = BASE
os.environ["BLAVE_AGENT_WORKSPACE"] = WS
sys.path.insert(0, os.path.join(ROOT, "runtime"))
import strategy_reporter as sr  # noqa: E402

fails = 0


def check(cond, msg, detail=""):
    global fails
    print(("ok   " if cond else "FAIL ") + msg + ("" if cond else f"  {detail}"))
    fails += 0 if cond else 1


with open(os.path.join(ROOT, "tests", "fixtures", "strategy_logic.json"), encoding="utf-8") as f:
    CASES = json.load(f)["cases"]

for c in CASES:
    src = c["src"]
    got = sr.strategy_logic(src, sr.strategy_consts(src).get("LOGIC"))
    check(got == c["expect"], c["case"], f"got {got!r}")

for i, c in enumerate(CASES):
    path = os.path.join(WS, "strategies", f"s{i}.py")
    with open(path, "w", encoding="utf-8", newline="") as f:
        f.write(c["src"])
    s = sr._extract(path, f"s{i}")
    check(s is not None and s.get("logic") == c["expect"], f"_extract carries logic: {c['case']}",
          f"got {s and s.get('logic')!r}")

sys.exit("check_strategy_logic: FAIL" if fails else print("all ok"))
