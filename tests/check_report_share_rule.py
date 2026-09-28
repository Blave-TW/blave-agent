"""What the agent is told about making a report public (references/reports.md): all three types
can be shared, a performance report goes public with its account figures, the agent does not
talk the user out of it, and account numbers still make a report `performance` — the confirm
box's reminder is triggered by the type.
Run: cd blave-agent && .venv/bin/python tests/check_report_share_rule.py
"""
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ref = open(os.path.join(ROOT, "references", "reports.md"), encoding="utf-8").read()
flat = re.sub(r"\s+", " ", ref)
fails = 0


def check(name, ok):
    global fails
    print(("PASS" if ok else "FAIL") + "  " + name)
    fails += not ok


check("no sentence says a performance report cannot be shared",
      not re.search(r"`performance`( report)? (never can|cannot|can't|can not)", flat)
      and "never tell the user a research or morning report cannot be shared" not in flat)
check("all three types can be shared, and only by the user",
      "`research`, `morning` (a morning brief, a close recap, a weekly, …) and `performance` — can be shared publicly, and only by the user" in flat)
check("a performance report goes public with its account figures and positions",
      "goes public with its account figures and positions in it" in flat)
check("the agent does not dissuade or refuse, and may remind once",
      "do not talk them out of it and do not refuse: it is their decision" in flat and "You may say once, in one sentence" in flat)
check("the classification rule stays: account numbers make a report `performance`",
      "any report that carries the user's account assets, positions, orders or live strategy P&L is `performance`" in flat)
check("private blocks: dropped from research / morning, kept on performance",
      "of a `research` or `morning` report drops that block whole" in flat and "`performance` report keeps it" in flat)
check("the agent still cannot share for the user",
      "You cannot share, update or cancel a report for the user" in flat)
print("ALL PASS" if not fails else f"{fails} FAILED")
sys.exit(1 if fails else 0)
